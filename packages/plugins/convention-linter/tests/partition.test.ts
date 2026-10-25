/**
 * 分区复用（PERF-12b）的引擎机械用例：
 * 判据门（全局 expect / partition.key / mtime）、失败口径（整规则无结论、坏单元不留存）、
 * `undefined` 跳过口径、落盘/热缓存还原、force 绕开——全部用假规则钉死。
 */
import { describe, expect, it } from 'vitest';
import type {
  CacheExpect,
  ConventionIssue,
  ConventionProjectUnitEntry,
  ConventionRule,
  ErbFile,
  ErbFunctionRef,
  ErbIndex,
  GameProject,
  Logger,
} from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { ConventionEngine } from '../src/engine';
import type { LintCache, LintUnitEntry } from '../src/snapshot';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const A = '/p/kojo/a.ERB';
const B = '/p/kojo/b.ERB';
const files: Record<string, string> = { [A]: '@M_KOJO_K1_A\nA\nEND\n', [B]: '@M_KOJO_K1_B\nB\nEND\n' };

function makeIndex(overrides: Partial<ErbIndex> = {}): ErbIndex {
  const map = new Map<string, ErbFile>();
  const byName = new Map<string, ErbFunctionRef[]>();
  for (const [path, text] of Object.entries(files)) {
    const f = parseErbText(text, path);
    map.set(path, f);
    for (const fn of f.functions) {
      const refs = byName.get(fn.normalizedName) ?? [];
      refs.push({ name: fn.name, normalizedName: fn.normalizedName, filePath: fn.filePath, startLine: fn.startLine, endLine: fn.endLine });
      byName.set(fn.normalizedName, refs);
    }
  }
  return { files: map, byName, fingerprint: 'erbfp-1', fileMtimes: new Map([[A, 100], [B, 200]]), ...overrides };
}

function fakeProject(): GameProject {
  return { rootDir: '/p', adapterId: 'test', kojoPaths: ['/p/kojo'], writablePaths: [], charaIndex: new Map() };
}

const EXPECT: CacheExpect = { projectRoot: '/p', adapterId: 'test', fingerprint: 'global-1' };

interface Harness2 {
  engine: ConventionEngine;
  saves: LintCache[];
  loads: number;
  /** 模拟"重启内核"：换新引擎但共用这份已保存的缓存（盘上层的替身） */
  diskLoad: () => LintCache | null;
}

/** 分区贡献独立键的替身盘（PERF-12c）：每条规则一条 blob + 三类调用记账 */
interface UnitsDisk {
  blobs: Record<string, { key: string; units: Record<string, LintUnitEntry> }>;
  loads: string[];
  saves: string[];
  prunes: string[][];
}

function unitsDisk(): UnitsDisk {
  return { blobs: {}, loads: [], saves: [], prunes: [] };
}

function harness2(args: {
  index: ErbIndex | null;
  adapterRules: ConventionRule[];
  loadImpl?: () => Promise<LintCache | null>;
  readFiles?: (paths: readonly string[]) => Promise<Array<string | null>>;
  /** 提供时引擎走"贡献独立键 + 懒取"路径；不提供 ⇒ v3 同键形态（老装配零改动） */
  units?: UnitsDisk;
}): Harness2 {
  const saves: LintCache[] = [];
  let loads = 0;
  const engine = new ConventionEngine({
    log: silentLog,
    getProject: () => fakeProject(),
    getIndex: () => args.index,
    readFile: async (path: string) => {
      const t = files[path];
      if (t === undefined) throw new Error(`not found: ${path}`);
      return t;
    },
    ...(args.readFiles ? { readFiles: args.readFiles } : {}),
    getAdapterRules: () => args.adapterRules,
    getAdapterPolicy: () => undefined,
    snapshot: {
      expectFor: () => EXPECT,
      load: async () => {
        loads++;
        return args.loadImpl ? args.loadImpl() : null;
      },
      save: (cache) => {
        saves.push(cache);
      },
      ...(args.units
        ? {
            units: {
              load: async (ruleId: string) => {
                args.units!.loads.push(ruleId);
                return args.units!.blobs[ruleId] ?? null;
              },
              save: (
                ruleId: string,
                state: { key: string; units: Record<string, LintUnitEntry> },
              ) => {
                args.units!.saves.push(ruleId);
                args.units!.blobs[ruleId] = { key: state.key, units: state.units };
              },
              prune: (keepRuleIds: readonly string[]) => {
                args.units!.prunes.push([...keepRuleIds]);
              },
            },
          }
        : {}),
    },
  });
  return { engine, saves, get loads() { return loads; }, diskLoad: () => (saves.length ? saves[saves.length - 1]! : null) };
}

/**
 * 假分区规则：单元 = 每个函数名的首字母（纯结构），合并 = 逐文件按贡献计数产出 issue。
 * `units` / `combines` 记录调用，用来证明"改一棵只算那一棵"。
 */
function makePartitionRule(opts: {
  id?: string;
  key?: () => string;
  failUnit?: (path: string) => boolean;
  skipUnit?: (path: string) => boolean; // 返回 undefined 的"无结论跳过"口径
} = {}): { rule: ConventionRule; units: string[]; combines: number[] } {
  const units: string[] = [];
  const combines: number[] = [];
  const id = opts.id ?? 'g.part';
  const rule: ConventionRule = {
    id,
    description: 'partitioned demo',
    severity: 'info',
    check(ctx): ConventionIssue[] {
      // 全量基准：直接逐文件现算
      const out: ConventionIssue[] = [];
      for (const f of ctx.index.files.values()) {
        for (const fn of f.functions) out.push({ ruleId: id, severity: 'info', message: `${f.path}:${fn.name}`, filePath: f.path, line: fn.startLine, key: `${id}|${f.path}|${fn.name}` });
      }
      return out;
    },
    partition: {
      ...(opts.key ? { key: () => opts.key!() } : {}),
      fileUnit(_ctx, file) {
        units.push(file.path);
        if (opts.failUnit?.(file.path)) throw new Error(`unit boom on ${file.path}`);
        if (opts.skipUnit?.(file.path)) return undefined;
        return file.functions.map((fn) => fn.name);
      },
      combine(_ctx, entries: readonly ConventionProjectUnitEntry[]) {
        combines.push(entries.length);
        const out: ConventionIssue[] = [];
        for (const e of entries) {
          for (const name of e.unit as string[]) {
            out.push({
              ruleId: id,
              severity: 'info',
              message: `${e.file.path}:${name}`,
              filePath: e.file.path,
              line: 1,
              key: `${id}|${e.file.path}|${name}`,
            });
          }
        }
        return out;
      },
      isUnit(v): boolean {
        return Array.isArray(v) && v.every((x) => typeof x === 'string');
      },
    },
  };
  return { rule, units, combines };
}

describe('分区复用引擎机械（PERF-12b）', () => {
  it('首轮全量建单元 ⇒ 次轮（mtime 变一棵）只重算那一棵，合并看到全部贡献', async () => {
    const idx = makeIndex();
    const r1 = makePartitionRule();
    const h1 = harness2({ index: idx, adapterRules: [r1.rule] });
    const rep1 = await h1.engine.run();
    expect(r1.units.sort()).toEqual([A, B].sort()); // 冷轮：两个文件都算
    expect(r1.combines).toEqual([2]);

    const saved = h1.saves[0]!;
    expect(Object.keys(saved.projectUnits!['g.part']!)).toHaveLength(2);
    expect(saved.partitionKeys!['g.part']).toBe('');

    // 同一引擎（同内核）改一棵：mtime B→201、指纹变 ⇒ 分区路径复用 A 的单元
    const r2 = makePartitionRule();
    const h2 = harness2({
      index: makeIndex({ fingerprint: 'erbfp-2', fileMtimes: new Map([[A, 100], [B, 201]]) }),
      adapterRules: [r2.rule],
      loadImpl: async () => saved,
    });
    const rep2 = await h2.engine.run();
    expect(r2.units).toEqual([B]); // 只重算变过的那一棵
    expect(r2.combines).toEqual([2]); // 合并仍看到两棵的贡献
    // 产出的 key 集合与全量轮一致（本假规则 line 恒 1，排序可能不同 ⇒ 比 key 集合）
    expect([...rep2.issues.map((i) => i.key)].sort()).toEqual([...rep1.issues.map((i) => i.key)].sort());
  });

  it('热缓存：同判据的连续运行不再走装载；判据变了必走', async () => {
    const r = makePartitionRule();
    const h = harness2({ index: makeIndex(), adapterRules: [r.rule] });
    await h.engine.run();
    expect(h.loads).toBe(1); // 首轮冷装载一次
    const h2loadsBefore = h.loads;
    await h.engine.run({ force: true }); // force：绕开热缓存也绕开装载（stored=null）
    expect(h.loads).toBe(h2loadsBefore); // force 不读缓存（旧行为）
    const rep = await h.engine.run(); // 同判据热命中 ⇒ 不装载
    expect(h.loads).toBe(h2loadsBefore);
    expect(rep.issues.length).toBeGreaterThan(0);
    expect(rep.failedRules).toEqual([]);
  });

  it('partition.key 变了 ⇒ 全部单元作废重算（外部输入失效，fail-closed）', async () => {
    let protocol = 'p1';
    const r1 = makePartitionRule({ key: () => protocol });
    const h1 = harness2({ index: makeIndex(), adapterRules: [r1.rule] });
    await h1.engine.run();
    const saved = h1.saves[0]!;

    protocol = 'p2';
    const r2 = makePartitionRule({ key: () => protocol });
    const h2 = harness2({ index: makeIndex({ fingerprint: 'erbfp-2' }), adapterRules: [r2.rule], loadImpl: async () => saved });
    const rep = await h2.engine.run();
    expect(r2.units.sort()).toEqual([A, B].sort()); // key 不符 ⇒ 两棵全重算
    expect(rep.failedRules).toEqual([]);
    expect(h2.saves[0]!.partitionKeys!['g.part']).toBe('p2');
  });

  it('isUnit 结构不符 ⇒ 弃该规则全部单元重算（绝不"修"分区）', async () => {
    const r1 = makePartitionRule();
    const h1 = harness2({ index: makeIndex(), adapterRules: [r1.rule] });
    await h1.engine.run();
    const saved = JSON.parse(JSON.stringify(h1.saves[0]));
    saved.projectUnits['g.part'][A].unit = { corrupted: 'not an array' };
    const tampered: LintCache = saved;

    const r2 = makePartitionRule();
    const h2 = harness2({
      index: makeIndex({ fingerprint: 'erbfp-2' }), // 指纹变 ⇒ 进分区路径（A 也按 key 不符弃掉重算）
      adapterRules: [r2.rule],
      loadImpl: async () => tampered,
    });
    await h2.engine.run();
    // A 的单元坏了 ⇒ 整规则弃用重算；B 也一起重算（保守，不挑着信）
    expect(r2.units.sort()).toEqual([A, B].sort());
  });

  it('单元计算抛错 ⇒ 整条规则本次无结论（failedRules），好文件的单元仍留存供下轮', async () => {
    const r1 = makePartitionRule({ failUnit: (p) => p === B });
    const h1 = harness2({ index: makeIndex(), adapterRules: [r1.rule] });
    const rep1 = await h1.engine.run();
    expect(rep1.failedRules.map((f) => f.ruleId)).toEqual(['g.part']);
    expect(rep1.issues.filter((i) => i.ruleId === 'g.part')).toHaveLength(0); // 不带洞拼造
    // 落盘只存 A 的单元（B 抛错不留存）
    const savedUnits = h1.saves[0]!.projectUnits!['g.part']!;
    expect(Object.keys(savedUnits)).toEqual([A]);

    const r2 = makePartitionRule();
    const h2 = harness2({ index: makeIndex(), adapterRules: [r2.rule], loadImpl: async () => h1.saves[0]! });
    const rep2 = await h2.engine.run();
    expect(r2.units).toEqual([B]); // 只补算坏掉的那棵
    expect(rep2.failedRules).toEqual([]);
    expect(rep2.issues.filter((i) => i.ruleId === 'g.part')).toHaveLength(2);
  });

  it('fileUnit 返回 undefined = "本文件无结论"：不入合并、不缓存、不算失败（读盘瞬态口径）', async () => {
    const r1 = makePartitionRule({ skipUnit: (p) => p === B });
    const h1 = harness2({ index: makeIndex(), adapterRules: [r1.rule] });
    const rep1 = await h1.engine.run();
    expect(rep1.failedRules).toEqual([]);
    expect(rep1.issues.filter((i) => i.ruleId === 'g.part')).toHaveLength(1); // 只有 A
    expect(Object.keys(h1.saves[0]!.projectUnits!['g.part']!)).toEqual([A]); // B 没被缓存成"空结论"

    const r2 = makePartitionRule();
    const h2 = harness2({
      index: makeIndex({ fingerprint: 'erbfp-2' }), // 指纹变 ⇒ 进分区路径（A 单元按 mtime 命中，B 补算）
      adapterRules: [r2.rule],
      loadImpl: async () => h1.saves[0]!,
    });
    const rep2 = await h2.engine.run();
    expect(r2.units).toEqual([B]); // 下轮必重算 B（跳过≠结论）
    expect(rep2.issues.filter((i) => i.ruleId === 'g.part')).toHaveLength(2);
  });

  it('combine 抛错 ⇒ 记 failedRules、不写 projectResults；单元照常留存', async () => {
    let combineCalls = 0;
    const rule: ConventionRule = {
      id: 'g.badcombine',
      description: 'combine throws',
      severity: 'info',
      check: () => [],
      partition: {
        fileUnit: () => ['X'],
        combine() {
          combineCalls++;
          throw new Error('merge exploded');
        },
      },
    };
    const h = harness2({ index: makeIndex(), adapterRules: [rule] });
    const rep = await h.engine.run();
    expect(rep.failedRules.map((f) => f.ruleId)).toContain('g.badcombine');
    expect(h.saves[0]!.projectResults['g.badcombine']).toBeUndefined();
    expect(Object.keys(h.saves[0]!.projectUnits!['g.badcombine']!)).toHaveLength(2);
  });

  it('force ⇒ 单元全部重算（显式意图不被分区糊住），算完回填缓存', async () => {
    const r1 = makePartitionRule();
    const h1 = harness2({ index: makeIndex(), adapterRules: [r1.rule] });
    await h1.engine.run();
    const r2 = makePartitionRule();
    const h2 = harness2({ index: makeIndex(), adapterRules: [r2.rule], loadImpl: async () => h1.saves[0]! });
    await h2.engine.run({ force: true });
    expect(r2.units.sort()).toEqual([A, B].sort()); // 两棵都真算
  });

  it('整项目指纹没变 ⇒ 走整包复用（快路径），分区路径根本不进', async () => {
    const r1 = makePartitionRule();
    const h1 = harness2({ index: makeIndex(), adapterRules: [r1.rule] });
    await h1.engine.run();
    const r2 = makePartitionRule();
    const h2 = harness2({ index: makeIndex(), adapterRules: [r2.rule], loadImpl: async () => h1.saves[0]! });
    await h2.engine.run();
    expect(r2.units).toEqual([]);
    expect(r2.combines).toEqual([]);
  });

  it('磁盘还原路径：新引擎（无热缓存）从 save 的 LintCache 只补算 stale 文件', async () => {
    const r1 = makePartitionRule();
    const h1 = harness2({ index: makeIndex(), adapterRules: [r1.rule] });
    await h1.engine.run();
    const saved = h1.saves[0]!;
    const r2 = makePartitionRule();
    // 全新引擎 + 同一份盘上缓存；mtime B 变了
    const h2 = harness2({
      index: makeIndex({ fingerprint: 'erbfp-2', fileMtimes: new Map([[A, 100], [B, 201]]) }),
      adapterRules: [r2.rule],
      loadImpl: async () => JSON.parse(JSON.stringify(saved)),
    });
    await h2.engine.run();
    expect(r2.units).toEqual([B]);
  });
});

/**
 * 贡献拆键 + 懒取（PERF-12c）。
 * 真语料读数：贡献占主快照 4.0 MB / 5.1 MB ⇒ "整条复用 7/7"的那一轮也要整份读盘 + parse
 * 才换来零计算（装载 1.4–2.0 s）。拆开后：主快照只剩桶与结论，贡献只在**真有分区规则
 * 要重算**时按 ruleId 懒取那一条；整包复用轮完全不碰它。
 */
describe('分区贡献独立存储键的懒取与生命周期（PERF-12c）', () => {
  /** 引擎内置规则里带 partition 的那条（装配后与 adapter 规则一起各占一条键） */
  const SUGAR = 'sugar.static-conventions';

  it('装了端口 ⇒ 主快照不再携带贡献；贡献按规则落在自己那条键上', async () => {
    const disk = unitsDisk();
    const r1 = makePartitionRule();
    const h1 = harness2({ index: makeIndex(), adapterRules: [r1.rule], units: disk });
    await h1.engine.run();
    const main = h1.saves[0]!;
    expect(main.projectUnits).toBeUndefined(); // 主快照瘦身：不再背 4 MB
    expect(main.partitionKeys).toBeUndefined();
    expect(disk.saves).toContain('g.part');
    expect(Object.keys(disk.blobs['g.part']!.units).sort()).toEqual([A, B].sort());
    expect(disk.prunes[disk.prunes.length - 1]!.sort()).toEqual(['g.part', SUGAR].sort());
  });

  it('整包复用轮（新引擎 + 指纹未变）⇒ 贡献一次都不懒取', async () => {
    const disk = unitsDisk();
    const r1 = makePartitionRule();
    const h1 = harness2({ index: makeIndex(), adapterRules: [r1.rule], units: disk });
    await h1.engine.run();
    const main = JSON.parse(JSON.stringify(h1.saves[0]!)) as LintCache;
    const loadsAfterCold = disk.loads.length; // 冷轮必然懒取过（键还空着）

    const r2 = makePartitionRule();
    // 新引擎 = 真壳"页面重新载入后的一轮"：无热缓存、无 lastRun，盘上主快照 + 贡献俱在
    const h2 = harness2({ index: makeIndex(), adapterRules: [r2.rule], loadImpl: async () => main, units: disk });
    const rep = await h2.engine.run();
    expect(disk.loads).toHaveLength(loadsAfterCold); // **本轮一次都没懒取**
    expect(r2.units).toEqual([]); // 一条贡献都没重算
    expect(rep.failedRules).toEqual([]);
    expect(rep.issues.filter((i) => i.ruleId === 'g.part')).toHaveLength(2);
  });

  it('改一棵 ⇒ 只懒取要重算的那条规则、只补算变过的那一棵，合并仍看到全部贡献', async () => {
    const disk = unitsDisk();
    const r1 = makePartitionRule();
    const h1 = harness2({ index: makeIndex(), adapterRules: [r1.rule], units: disk });
    await h1.engine.run();
    const main = JSON.parse(JSON.stringify(h1.saves[0]!)) as LintCache;

    const r2 = makePartitionRule();
    const h2 = harness2({
      index: makeIndex({ fingerprint: 'erbfp-2', fileMtimes: new Map([[A, 100], [B, 201]]) }),
      adapterRules: [r2.rule],
      loadImpl: async () => main,
      units: disk,
    });
    const rep = await h2.engine.run();
    expect(disk.loads).toContain('g.part'); // 这条规则本轮要重算 ⇒ 懒取自己那一条
    expect(r2.units).toEqual([B]); // A 的贡献从独立键里按 mtime 命中
    expect(r2.combines).toEqual([2]);
    expect(rep.issues.filter((i) => i.ruleId === 'g.part')).toHaveLength(2);
    expect(Object.keys(disk.blobs['g.part']!.units).sort()).toEqual([A, B].sort()); // 写回也是整份
  });

  it('外部输入摘要（key）变了 ⇒ 该规则整条分区作废重算（fail-closed，不拿旧贡献凑）', async () => {
    const disk = unitsDisk();
    let protocol = 'p1';
    const r1 = makePartitionRule({ key: () => protocol });
    const h1 = harness2({ index: makeIndex(), adapterRules: [r1.rule], units: disk });
    await h1.engine.run();
    expect(disk.blobs['g.part']!.key).toBe('p1');
    const main = JSON.parse(JSON.stringify(h1.saves[0]!)) as LintCache;

    protocol = 'p2';
    const r2 = makePartitionRule({ key: () => protocol });
    const h2 = harness2({
      index: makeIndex({ fingerprint: 'erbfp-2' }),
      adapterRules: [r2.rule],
      loadImpl: async () => main,
      units: disk,
    });
    await h2.engine.run();
    expect(r2.units.sort()).toEqual([A, B].sort()); // 两棵全重算
    expect(disk.blobs['g.part']!.key).toBe('p2'); // 坏判据的键被本轮真结果覆盖
  });

  it('键上读不出东西（新键 / 被判死删掉）⇒ 全量重算，结论照常产出', async () => {
    const disk = unitsDisk();
    const r1 = makePartitionRule();
    const main = JSON.parse(
      JSON.stringify({
        erbFingerprint: 'erbfp-2',
        projectResults: {},
        buckets: {},
      } as LintCache),
    ) as LintCache;
    const h = harness2({
      index: makeIndex({ fingerprint: 'erbfp-2' }),
      adapterRules: [r1.rule],
      loadImpl: async () => main,
      units: disk,
    });
    const rep = await h.engine.run();
    expect(r1.units.sort()).toEqual([A, B].sort());
    expect(disk.loads).toContain('g.part');
    expect(rep.failedRules).toEqual([]);
    expect(rep.issues.filter((i) => i.ruleId === 'g.part')).toHaveLength(2);
  });

  it('prune 的保留集 = 当前规则集里所有声明 partition 的规则（含本轮没建计划的那条）', async () => {
    const disk = unitsDisk();
    const ok = makePartitionRule({ id: 'g.ok' });
    const broken: ConventionRule = {
      id: 'g.badkey',
      description: 'key throws',
      severity: 'info',
      check: () => [],
      partition: {
        key() {
          throw new Error('route table gone');
        },
        fileUnit: () => [],
        combine: () => [],
      },
    };
    const h = harness2({ index: makeIndex(), adapterRules: [ok.rule, broken], units: disk });
    const rep = await h.engine.run();
    expect(rep.failedRules.map((f) => f.ruleId)).toContain('g.badkey');
    expect(disk.saves).toContain('g.ok');
    expect(disk.saves).not.toContain('g.badkey'); // 坏判据那条不写盘
    expect(disk.prunes[disk.prunes.length - 1]!.sort()).toEqual(['g.badkey', 'g.ok', SUGAR].sort());
  });

  it('没装端口 ⇒ 仍走 v3 同键形态（老装配零改动，贡献随主快照读写）', async () => {
    const r1 = makePartitionRule();
    const h1 = harness2({ index: makeIndex(), adapterRules: [r1.rule] });
    await h1.engine.run();
    expect(Object.keys(h1.saves[0]!.projectUnits!['g.part']!)).toHaveLength(2);
    const r2 = makePartitionRule();
    const h2 = harness2({
      index: makeIndex({ fingerprint: 'erbfp-2', fileMtimes: new Map([[A, 100], [B, 201]]) }),
      adapterRules: [r2.rule],
      loadImpl: async () => h1.saves[0]!,
    });
    await h2.engine.run();
    expect(r2.units).toEqual([B]);
  });

  it('旧形态主快照（贡献还塞在里面）⇒ 零重算轮也立刻改写一次瘦版，下轮不再背 4 MB', async () => {
    const disk = unitsDisk();
    // 12b 写在盘上的那份带 projectUnits；装配侧装了端口 ⇒ 装载只解桶与结论、
    // 贡献整块跳过并留 `droppedUnits` 标记（snapshot.decodeCache 的 includeUnits:false）
    const leanFromLegacy: LintCache = {
      erbFingerprint: 'erbfp-1',
      projectResults: {
        'g.part': [
          { ruleId: 'g.part', severity: 'info', message: 'A', filePath: A, line: 1, key: 'g.part|A' },
          { ruleId: 'g.part', severity: 'info', message: 'B', filePath: B, line: 1, key: 'g.part|B' },
        ],
      },
      buckets: {},
      droppedUnits: true,
    };
    const r2 = makePartitionRule();
    const h = harness2({ index: makeIndex(), adapterRules: [r2.rule], loadImpl: async () => leanFromLegacy, units: disk });
    const rep = await h.engine.run();
    expect(rep.failedRules).toEqual([]);
    expect(rep.issues.filter((i) => i.ruleId === 'g.part')).toHaveLength(2); // 结论仍来自复用
    expect(r2.units).toEqual([]); // 旧贡献被丢掉，但绝不拿它凑、也没重算任何东西
    expect(disk.loads).toEqual([SUGAR]); // 只有真建了计划的那条去懒取；`g.part` 一次都没碰
    // 本轮一件都没重算 ⇒ 只因 droppedUnits 而改写：主快照从此不带贡献
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]!.projectUnits).toBeUndefined();
    expect(h.saves[0]!.partitionKeys).toBeUndefined();
    // 唯一建了计划的是内置那条（它的结论本来就不在这份旧快照里）；
    // 本轮走复用的 `g.part` 一条贡献都没写 ⇒ 拆键的意义就在于此
    expect(disk.saves).toEqual([SUGAR]);
    expect(h.saves[0]!.projectResults['g.part']).toHaveLength(2); // 结论照常带走
  });
});

