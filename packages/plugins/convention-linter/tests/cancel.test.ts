/**
 * 可中断的一轮全项目校验（ZH-F4b）。
 *
 * 判据都钉在**调用计数与落盘次数**上（形状照 `sugar-transpiler-dedup.test.ts` 的
 * "正文未变既不读盘也不转译"），不钉墙钟、不钉"没抛错"：
 * ① 取消 ⇒ `run` **照常返回**（不抛）带 `incomplete` 的半轮，读数写明不完整；
 * ② 取消 ⇒ 主快照与分区贡献键**一个字节都不写**（残影不许当下次的真相）；
 * ③ 取消后再跑一轮 ⇒ 与"直接跑一轮"逐字对拍（同序同数），且已算完的那 12 棵**零重算**；
 * ④ 没跑到的那 8 棵在叫停那一轮**没有任何条目**（≠"没问题"）；
 * ⑤ 池子那条路与本地兜底那条路**收摊形状逐字相同**（两条路都过同一颗哨兵）；
 * ⑥ 旧调用（不传取消位）零改动：`incomplete` 缺席、照旧落盘、照旧广播。
 */
import { describe, expect, it } from 'vitest';
import type {
  CacheExpect,
  ComputePool,
  ConventionIssue,
  ConventionRule,
  ErbFile,
  ErbFunctionRef,
  ErbIndex,
  GameProject,
  Logger,
} from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { createComputePool } from '../../../kernel/src/compute';
import { ConventionEngine } from '../src/engine';
import type { LintCache } from '../src/snapshot';

// audit-allow: 测试夹具与内核计算池同仓取用（`tests/` 允许直连 kernel 实现，见 PITFALLS/审计 C 项豁免）
const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const COUNT = 20;
/** 并发度（引擎内 `LINT_FILE_CONCURRENCY`）：一次同时起 12 棵 ⇒ 叫停点前后的分界 */
const IN_FLIGHT = 12;
const pathOf = (i: number): string => `/p/kojo/f${String(i).padStart(2, '0')}.ERB`;
const ALL_PATHS = Array.from({ length: COUNT }, (_, i) => pathOf(i));
/** 夹具正文：函数名互不相同 ⇒ 内置那条"重名"规则零条目，读数只归本轮这条逐文件规则 */
const TEXTS = new Map<string, string>(ALL_PATHS.map((p, i) => [p, `@F_UNIQ_${i}\nPRINTL ${i}\nEND\n`]));

function project(): GameProject {
  return { rootDir: '/p', adapterId: 'test', kojoPaths: ['/p/kojo'], writablePaths: [], charaIndex: new Map() };
}

const EXPECT: CacheExpect = { projectRoot: '/p', adapterId: 'test', fingerprint: 'fp-cancel' };

function makeIndex(): ErbIndex {
  const files = new Map<string, ErbFile>();
  const byName = new Map<string, ErbFunctionRef[]>();
  for (let i = 0; i < COUNT; i++) {
    const path = pathOf(i);
    const f = parseErbText(TEXTS.get(path)!, path);
    files.set(path, f);
    for (const fn of f.functions) {
      const refs = byName.get(fn.normalizedName) ?? [];
      refs.push({
        name: fn.name,
        normalizedName: fn.normalizedName,
        filePath: fn.filePath,
        startLine: fn.startLine,
        endLine: fn.endLine,
      });
      byName.set(fn.normalizedName, refs);
    }
  }
  return { files, byName, fingerprint: 'erbfp-1', fileMtimes: new Map(ALL_PATHS.map((p, i) => [p, 1_000 + i])) };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

interface Harness {
  engine: ConventionEngine;
  /** 规则体**真开工**的文件（闸在它之前 ⇒ 这一列就是"新起的文件单元"） */
  started: string[];
  /** 算完并交出结论的文件 */
  finished: string[];
  mainSaves: LintCache[];
  mainLoads: number;
  unitSaves: string[];
  unitLoads: string[];
  unitPrunes: string[][];
  holds: Map<string, Deferred>;
  controller: AbortController;
}

/**
 * 一棵 `.ERB` 的逐文件规则 + 判据齐备的快照端口（主快照 + 贡献独立键都记账）。
 * `holds` 里挂了闸的文件在规则体里等释放——用它把"叫停点"钉成确定的那一瞬。
 */
function harness(args: { compute?: ComputePool; manual: boolean }): Harness {
  const started: string[] = [];
  const finished: string[] = [];
  /** 只有要钉"叫停点"的那几台引擎才上闸；规则本身两边都装 ⇒ 对拍才有共同基准 */
  const holds = new Map<string, Deferred>();
  if (args.manual) {
    for (const p of ALL_PATHS) {
      let resolve = (): void => {};
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      holds.set(p, { promise, resolve });
    }
  }
  const rule: ConventionRule = {
    id: 'g.cancel',
    description: 'per-file rule with an optional barrier',
    severity: 'warning',
    scope: 'file',
    async checkFile(ctx, file) {
      started.push(file.path);
      await (holds.get(file.path)?.promise ?? Promise.resolve());
      finished.push(file.path);
      const text = await ctx.readFile(file.path);
      return [
        {
          ruleId: 'g.cancel',
          severity: 'warning' as const,
          message: `${file.path} len=${text.length}`,
          filePath: file.path,
          line: 1,
          key: `g.cancel|${file.path}`,
        },
      ];
    },
  };
  const mainSaves: LintCache[] = [];
  const unitSaves: string[] = [];
  const unitLoads: string[] = [];
  const unitPrunes: string[][] = [];
  let mainLoads = 0;
  const index = makeIndex();
  const controller = new AbortController();
  const engine = new ConventionEngine({
    log: silentLog,
    ...(args.compute ? { compute: args.compute } : {}),
    getProject: () => project(),
    getIndex: () => index,
    readFile: async (path: string) => {
      const text = TEXTS.get(path);
      if (text === undefined) throw new Error(`not found: ${path}`);
      return text;
    },
    getAdapterRules: () => [rule],
    getAdapterPolicy: () => undefined,
    snapshot: {
      expectFor: () => EXPECT,
      load: async () => {
        mainLoads++;
        return null; // 每一轮都是"新页面"：内存态由引擎自己的 hotCache 承担（这正是被叫停那一轮唯一该留东西的地方）
      },
      save: (cache) => {
        mainSaves.push(cache);
      },
      units: {
        load: async (ruleId: string) => {
          unitLoads.push(ruleId);
          return null;
        },
        save: (ruleId: string) => {
          unitSaves.push(ruleId);
        },
        prune: (keep) => {
          unitPrunes.push([...keep]);
        },
      },
    },
  });
  return {
    engine,
    started,
    finished,
    mainSaves,
    get mainLoads() {
      return mainLoads;
    },
    unitSaves,
    unitLoads,
    unitPrunes,
    holds,
    controller,
  };
}

/** 放掉前 `n` 棵的闸，并叫停在跑的这一轮；随后把剩下的闸全放掉（正在算的那几棵要算完才算收摊） */
async function releaseThenAbort(h: Harness, n: number): Promise<void> {
  for (let i = 0; i < n; i++) h.holds.get(pathOf(i))?.resolve();
  h.controller.abort();
  for (const d of h.holds.values()) d.resolve();
  await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
}

const keysOf = (rep: { issues: readonly ConventionIssue[] }): string[] => rep.issues.map((i) => i.key ?? '');
/** 只取本轮那条逐文件规则的条目（内置那条分区规则在纯 `.ERB` 夹具里恒零条目，留着做反恒真） */
const mine = (rep: { issues: readonly ConventionIssue[] }): string[] =>
  rep.issues.filter((i) => i.ruleId === 'g.cancel').map((i) => i.filePath ?? '');

/** 两条调度路（装池 = 生产装配；缺池 = 单测/无内核装配的本地兜底）——今天单测走的是后者 */
const ROUTES: Array<[string, () => ComputePool | undefined]> = [
  ['缺池（本地兜底）', () => undefined],
  ['内核计算池', () => createComputePool({ log: silentLog })],
];

describe.each(ROUTES)('叫停一轮校验 · %s', (_name, makeCompute) => {
  it('取消 ⇒ `run` 照常返回带 `incomplete` 的半轮；未起一棵新单元、未算的那棵零条目', async () => {
    const h = harness({ compute: makeCompute(), manual: true });
    const reported: unknown[] = [];
    h.engine.subscribe((r) => reported.push(r));

    const running = h.engine.run({ force: true, signal: h.controller.signal });
    await new Promise<void>((r) => setImmediate(r));
    // 闸一放就叫停：这 12 棵是**已经在手里**的那一批，之后一棵都不许起
    await releaseThenAbort(h, 4);
    const rep = await running;

    expect(h.started).toHaveLength(IN_FLIGHT);
    expect([...h.started].sort()).toEqual(ALL_PATHS.slice(0, IN_FLIGHT).sort());
    // 收摊前把**手里那一棵**算完（不许半截结论）：起了 12 棵就交出 12 份
    expect(h.finished).toHaveLength(IN_FLIGHT);
    expect([...h.finished].sort()).toEqual([...h.started].sort());
    expect(rep.incomplete, '被叫停的一轮必须自称不完整').toEqual({
      unitsDone: IN_FLIGHT + COUNT, // 本条规则 12 棵 + 内置分区规则那 20 棵不适用贡献
      unitsTotal: COUNT * 2,
    });
    expect([...mine(rep)].sort()).toEqual(ALL_PATHS.slice(0, IN_FLIGHT).sort());
    expect(rep.ruleCount).toBe(2); // 内置两条整项目规则有完整结论；本轮那条逐文件规则一条都没有
    expect(rep.failedRules).toEqual([]);
    // 订阅面不被半轮覆盖：叫停这一轮只把真相交给叫停它的那一手（`run` 的返回值）
    expect(reported).toEqual([null]);
    expect(h.engine.report()).toBeNull();
  });

  it('取消 ⇒ 主快照与分区贡献键都不写盘（残影不许当成下次的真相）', async () => {
    const h = harness({ compute: makeCompute(), manual: true });
    const running = h.engine.run({ force: true, signal: h.controller.signal });
    await new Promise<void>((r) => setImmediate(r));
    await releaseThenAbort(h, 2);
    await running;
    expect(h.mainSaves).toEqual([]);
    expect(h.unitSaves).toEqual([]);
    expect(h.unitPrunes).toEqual([]);
  });

  it('取消后再跑一轮 ⇒ 已算完的那 12 棵零重算、缺的那 8 棵必补，且与"直接跑一轮"逐字等价', async () => {
    const h = harness({ compute: makeCompute(), manual: true });
    const running = h.engine.run({ force: true, signal: h.controller.signal });
    await new Promise<void>((r) => setImmediate(r));
    await releaseThenAbort(h, 3);
    const half = await running;
    expect(half.incomplete).toBeDefined();

    // 补的那一轮：没有任何一道闸（全部立刻放行），也不带取消位
    h.holds.clear();
    const before = h.started.length;
    const full = await h.engine.run();

    expect(h.started).toHaveLength(before + (COUNT - IN_FLIGHT)); // 只补算缺的那些棵
    expect([...h.started.slice(before)].sort()).toEqual(ALL_PATHS.slice(IN_FLIGHT).sort());
    expect(full.incomplete, '补完的这一轮是完整的一轮').toBeUndefined();
    expect(full.failedRules).toEqual([]);
    // 已算完的 12 棵从内存态直接命中：一轮里每棵最多被开工一次
    expect(new Set(h.started).size).toBe(COUNT);
    expect(h.started.length).toBe(COUNT);
    // 这一轮才落盘，且桶里 20 棵齐（叫停那一轮一棵都没写进去）
    expect(h.mainSaves).toHaveLength(1);
    expect(Object.keys(h.mainSaves[0]!.buckets['g.cancel']!)).toHaveLength(COUNT);
    // 补的那一轮走整包复用：没建计划 ⇒ 那条贡献键**本轮一次都不碰盘**（不重取、不重写，PERF-12c）
    expect(h.unitSaves).toEqual([]);
    expect(h.unitLoads).toEqual([]);
    expect(h.mainLoads, '半份缓存在内存里 ⇒ 补的那轮不必再装载').toBe(0);

    // 对拍：与"另起一台引擎一轮跑完"逐字相同（同序同数，不许只断言"不抛错"）
    const ref = harness({ compute: makeCompute(), manual: false });
    const reference = await ref.engine.run();
    expect(keysOf(full)).toEqual(keysOf(reference));
    expect(mine(full)).toEqual(mine(reference));
    expect(full.counts).toEqual(reference.counts);
    expect(full.ruleCount).toBe(reference.ruleCount);
    expect(full.failedRules).toEqual(reference.failedRules);
  });

  it('开跑前就已经叫停 ⇒ 一棵都不起、一条结论都没有（不是"跑完了没问题"）', async () => {
    const h = harness({ compute: makeCompute(), manual: true });
    h.controller.abort();
    const rep = await h.engine.run({ force: true, signal: h.controller.signal });
    expect(h.started).toEqual([]);
    expect(rep.incomplete).toEqual({ unitsDone: 0, unitsTotal: COUNT * 2 });
    expect(mine(rep)).toEqual([]);
    expect(rep.ruleCount).toBe(0);
    expect(h.mainSaves).toEqual([]);
    expect(h.engine.report()).toBeNull();
  });
});

describe('旧调用零改动（不传取消位）', () => {
  it('`run()` / `run({force:true})` ⇒ `incomplete` 缺席、照旧落盘、照旧广播', async () => {
    const h = harness({ manual: false });
    const reported: unknown[] = [];
    h.engine.subscribe((r) => reported.push(r));
    const rep = await h.engine.run({ force: true });
    expect(rep.incomplete).toBeUndefined();
    expect(mine(rep)).toHaveLength(COUNT);
    expect(reported).toHaveLength(2); // 初值 null + 这一轮的完整报告
    expect(h.engine.report()).toBe(rep);
    expect(h.mainSaves).toHaveLength(1);
    // 取消位缺席时，那颗哨兵压根不会被掷出：再跑一轮走复用，形状与改造前一致
    h.controller.abort();
    const second = await h.engine.run();
    expect(second.incomplete).toBeUndefined();
    expect(second.failedRules).toEqual([]);
    expect(mine(second)).toHaveLength(COUNT);
  });

  it('同一轮里两条调度路（装池 / 缺池）产出的完整报告逐字相同（取消位不参与判定）', async () => {
    const a = await harness({ compute: createComputePool({ log: silentLog }), manual: false }).engine.run();
    const b = await harness({ manual: false }).engine.run();
    expect(keysOf(a)).toEqual(keysOf(b));
    expect(a.counts).toEqual(b.counts);
    expect(a.ruleCount).toBe(b.ruleCount);
  });
});
