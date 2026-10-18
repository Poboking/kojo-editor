/**
 * 抽取侧两处量的对照读数（2026-10-18 性能批）。
 *
 * 只跑在**串行静默池**（`--config vitest.perf.config.ts`，PITFALLS §88）；
 * 判据口径（`f425b19` 修正后）：同窗交替 + 中位数取样；**闸钉的是结构不变量
 * （依赖条数 / 字典条数等价）+ 绝对噪声下界**（只挡量级回退，不承诺提速），
 * 比值只打进读数行不当尺子——~20–80ms 尺度上小样本比值随进程负载随机翻线（PITFALLS §72 同族）。
 * ⇒ 提交信息里的任何"提速百分比"都不由本文件的两条墙钟用例定责；
 *   热路径"严格优于"仅在 `KOJO_PERF_HEAVY=1`（真实语料量级）档成立。
 * 默认档刻意轻（PITFALLS §72 的"新 perf 用例默认档只放轻量档"），
 * 真实语料量级（164,910 条依赖 / 2,325 棵正文）走 `KOJO_PERF_HEAVY=1`。
 *
 * 两条"改前"腿都不需要旧代码：
 * - 编码腿：判等旧口径（`JSON.stringify` 四字段 + 逐条 `dependencyKey` 复验）**在测试里现搭一份**，
 *   与生产新口径（内容拼接键 + 身份快道 + 还原件免复验）同窗交替比；
 * - 常驻腿：`detailCacheCaps` 传 `Infinity` 就是改前的无上限形态，与默认上限比常驻字符数。
 */
import { describe, expect, it } from 'vitest';
import type { ComputePool, ControlFlowStatement, ErbFile, ErbIndex, GameProject, Logger, StateDependency } from '@kojo/plugin-api';
import { dependencyKey } from '@kojo/plugin-api';
import { ConditionEngine } from '../src/engine';
import { decodeBuckets, encodeBuckets, extractExpect, type ExtractExpect, type FileBucket } from '../src/snapshot';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const HEAVY = process.env.KOJO_PERF_HEAVY === '1';
/** 依赖总数（真实语料 164,910；默认档 40,000 条 = 同形状、1/4 规模） */
const DEP_TOTAL = HEAVY ? 164_910 : 40_000;
const COND_COUNT = HEAVY ? 31_630 : 8_000;
/** 常驻量例：真实语料 2,325 棵 / 平均 ~62KB 正文；默认档 240 棵 */
const FILE_COUNT = HEAVY ? 2_325 : 240;
const FILE_CHARS = 62_000;
const ROUNDS = 3;

const project = { rootDir: 'D:/game', adapterId: 'eratw', inputDigest: 'perf-1' } as unknown as GameProject;
const EXPECT: ExtractExpect = extractExpect({ project })!;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/* ============================ ① 落盘编码：新旧判等口径 ============================ */

/** 造一批依赖：名字在 1,176 种里轮转（与真实语料同名域规模），一半带索引、一半带 schema。
 *  schema 的两种来源都造：**共享对象**（＝复用桶还原件，新口径的身份快道命中）与
 *  **逐条现造对象**（＝新抽取件，两条口径都要建键）——真实落盘一轮就是这两类的混合。 */
function makeBuckets(): Map<string, FileBucket> {
  const schemaPool = Array.from({ length: 300 }, (_, k) => ({
    name: `VAR${k}`,
    index: k % 100,
    description: `描述${k}`,
  }));
  const buckets = new Map<string, FileBucket>();
  const perCond = Math.max(1, Math.round(DEP_TOTAL / COND_COUNT));
  let made = 0;
  let file = 0;
  while (made < DEP_TOTAL) {
    const conds = [];
    for (let c = 0; c < 4 && made < DEP_TOTAL; c++) {
      const deps: StateDependency[] = [];
      for (let k = 0; k < perCond && made < DEP_TOTAL; k++) {
        const name = `VAR${made % 1176}`;
        const indexed = made % 2 === 0;
        const dep: StateDependency = {
          key: dependencyKey({ name, indices: indexed ? [String(made % 100)] : [] }),
          name,
          indices: indexed ? [String(made % 100)] : [],
          count: 1,
          comparisons: [{ op: '>=', value: 500, text: 'CFLAG:2 >= 500' }],
          firstLine: 2,
        };
        if (made % 2 === 1) {
          dep.schema =
            made % 4 === 1
              ? { ...schemaPool[made % 300]! } // 新抽取件：逐条现造对象
              : schemaPool[made % 300]!; // 复用桶还原件：同一个对象
        }
        deps.push(dep);
        made++;
      }
      conds.push({
        normalizedName: `FN_${file}_${c}`,
        filePath: `/f/k${file}.ERB`,
        startLine: 1,
        predicateCount: deps.length,
        unparsedCount: 0,
        dependencies: deps,
      });
    }
    buckets.set(`/f/k${file}.ERB`, {
      mtimeMs: 1000 + file,
      size: 62_000,
      stats: { functions: conds.length, functionsWithDeps: conds.length, predicates: 0, unparsed: 0, dependencies: perCond * conds.length },
      conds,
    });
    file++;
  }
  return buckets;
}

/** **旧口径**的编码（测试内自搭，逐字复刻改前那两处：stringify 判等 + 逐条复验派生键） */
function encodeOldShape(buckets: ReadonlyMap<string, FileBucket>): unknown {
  const schemas: unknown[] = [];
  const schemaIdx = new Map<string, number>();
  const names: string[] = [];
  const nameSlot = new Map<string, number>();
  const indexOfSchema = (s: NonNullable<StateDependency['schema']>): number => {
    const id = JSON.stringify([s.name, s.index ?? null, s.resolvedIndex ?? null, s.description ?? null]);
    let i = schemaIdx.get(id);
    if (i === undefined) {
      i = schemas.length;
      schemas.push(s);
      schemaIdx.set(id, i);
    }
    return i;
  };
  const out: Record<string, unknown> = {};
  for (const [path, b] of buckets) {
    const conds = b.conds.map((c) => [
      c.normalizedName,
      c.startLine,
      c.predicateCount,
      c.unparsedCount,
      c.dependencies.map((d) => {
        if (d.key !== dependencyKey({ name: d.name, indices: d.indices })) throw new Error('派生前提破了');
        let ni = nameSlot.get(d.name);
        if (ni === undefined) {
          ni = names.length;
          names.push(d.name);
          nameSlot.set(d.name, ni);
        }
        return [ni, d.indices, d.count, d.firstLine, d.comparisons.map((x) => [x.op, x.value, x.text]), d.schema === undefined ? -1 : indexOfSchema(d.schema)];
      }),
    ]);
    out[path] = [b.mtimeMs, b.size, [b.stats.functions, b.stats.functionsWithDeps, b.stats.predicates, b.stats.unparsed, b.stats.dependencies], conds];
  }
  return { format: 5, projectRoot: EXPECT.projectRoot, adapterId: EXPECT.adapterId, inputDigest: EXPECT.inputDigest, savedAt: 0, schemas, names, buckets: out };
}

describe('抽取快照落盘编码：新旧判等口径同窗交替', () => {
  it('依赖条数一致、字典条数一致；墙钟只钉"不落后旧口径超过绝对噪声下界"（不承诺提速）', () => {
    const buckets = makeBuckets();
    let deps = 0;
    for (const b of buckets.values()) for (const c of b.conds) deps += c.dependencies.length;
    expect(deps).toBe(DEP_TOTAL);

    // 预热两条腿（首次有 JIT 噪声，不计入读数）
    const a0 = encodeBuckets({ buckets, expect: EXPECT }) as unknown as { schemas: unknown[]; names: unknown[] };
    const b0 = encodeOldShape(buckets) as { schemas: unknown[]; names: unknown[] };
    // 判据①（产出等价）：字典条目数与依赖总数在两条腿上一个字不差
    expect(a0.schemas.length).toBe(b0.schemas.length);
    expect(a0.names.length).toBe(b0.names.length);

    const newMs: number[] = [];
    const oldMs: number[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const legs: Array<() => unknown> = round % 2 === 0 ? [() => encodeBuckets({ buckets, expect: EXPECT }), () => encodeOldShape(buckets)] : [() => encodeOldShape(buckets), () => encodeBuckets({ buckets, expect: EXPECT })];
      for (const leg of legs) {
        const t0 = performance.now();
        leg();
        (leg === legs[0] ? newMs : oldMs).push(performance.now() - t0);
      }
    }
    const nm = median(newMs);
    const om = median(oldMs);
    console.log(
      `[encode·新抽取桶] ${HEAVY ? '真实语料量级' : '默认轻量档'} ${DEP_TOTAL.toLocaleString()} 条依赖 / ${a0.schemas.length.toLocaleString()} 条字典：` +
        `旧口径（stringify + 逐条复验）中位 ${om.toFixed(1)}ms → 新口径（拼接键 + 身份快道）${nm.toFixed(1)}ms` +
        `（比值 ${((nm / om) * 100).toFixed(1)}%）`,
    );
    // 判据②（墙钟）：**只挡量级回退，不承诺提速**。两档实测都不是速度赢：
    // 轻量档 `nm ≤ om + 20` 允许新口径在同一噪声窗内慢至 ~2×（om≈20ms 时上界 40ms），
    // HEAVY 档（真语料 164,910 条依赖）旧口径 ~77ms 时同理——换键形态的收益在分配与
    // 可复用性，不在这一趟的墙钟；小样本比值会随进程噪声随机翻线，故两档统一绝对噪声下界。
    // 本用例定责的是判据①（字典产出等价）；提速百分比不由这条墙钟闸背书（提交信息为准）。
    expect(nm).toBeLessThanOrEqual(om + 20);
  }, 120_000);

  it('复用桶（热路径：改 3 棵 / 全树回写）：还原件免复验——HEAVY 档钉"严格优于"，默认档只钉绝对下界', () => {
    const fresh = encodeBuckets({ buckets: makeBuckets(), expect: EXPECT });
    const decoded = decodeBuckets(fresh, EXPECT);
    expect(decoded).not.toBeNull();
    // 生产形态：本轮的桶＝"上次快照还原出来的桶"（作者只改几个文件时占绝大多数）
    const reused = new Map(Object.entries(decoded!.buckets));
    let deps = 0;
    for (const b of reused.values()) for (const c of b.conds) deps += c.dependencies.length;
    expect(deps).toBe(DEP_TOTAL);

    const a0 = encodeBuckets({ buckets: reused, expect: EXPECT }) as unknown as { schemas: unknown[] };
    const b0 = encodeOldShape(reused) as unknown as { schemas: unknown[] };
    expect(a0.schemas.length).toBe(b0.schemas.length); // 两条口径的字典产出等价

    const newMs: number[] = [];
    const oldMs: number[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const legs: Array<() => unknown> =
        round % 2 === 0
          ? [() => encodeBuckets({ buckets: reused, expect: EXPECT }), () => encodeOldShape(reused)]
          : [() => encodeOldShape(reused), () => encodeBuckets({ buckets: reused, expect: EXPECT })];
      for (const leg of legs) {
        const t0 = performance.now();
        leg();
        (leg === legs[0] ? newMs : oldMs).push(performance.now() - t0);
      }
    }
    const nm = median(newMs);
    const om = median(oldMs);
    console.log(
      `[encode·复用桶] ${DEP_TOTAL.toLocaleString()} 条依赖（全部经还原）：旧口径中位 ${om.toFixed(1)}ms` +
        ` → 新口径 ${nm.toFixed(1)}ms（比值 ${((nm / om) * 100).toFixed(1)}%）`,
    );
    // 判据（按尺度分口径）：HEAVY 档＝真语料量级，"严格优于"只在这一档定责
    // （f425b19 复跑 73.8→69.7ms，约 5.5%——台阶存在但不是"砍下来"量级）；
    // 轻量档两腿都落在 ~18ms，0.7% 的差就是进程噪声（实测 18.29 对 18.17 翻红），
    // 只留绝对下界 `nm ≤ om + 10` 挡量级回退。比值逐轮打进读数行，不靠它定胜负。
    // e60c133 那句「复用桶腿 86.7ms → 42.0ms（48.4%）」没有任何档位钉住——收口口径以
    // 本文件逐轮打印的中位数读数为准。
    if (HEAVY) {
      expect(nm).toBeLessThan(om);
    } else {
      expect(nm).toBeLessThanOrEqual(om + 10);
    }
  }, 120_000);
});

/* ============================ ② 按需明细的正文常驻 ============================ */

function makeComputeStub(): ComputePool {
  return {
    async runSliced<T, R>(items: readonly T[], _o: unknown, fn: (t: T, i: number) => R | Promise<R>): Promise<R[]> {
      const out: R[] = [];
      for (let i = 0; i < items.length; i++) out.push(await fn(items[i]!, i));
      return out;
    },
    stats: () => ({ tasks: [], yields: 0, interactiveActive: false, offload: { parallel: false, dispatched: 0, fellBack: 0, inline: 0 } }),
  } as unknown as ComputePool;
}

/** 一引擎 + FILE_COUNT 棵正文（每棵一个函数；文本 FILE_CHARS 字符） */
function makeWalkEngine(caps?: { maxDetails?: number; maxFiles?: number; maxChars?: number }) {
  const files = new Map<string, ErbFile>();
  const byName = new Map<string, unknown[]>();
  const texts = new Map<string, string>();
  const body = `${';'.padEnd(FILE_CHARS - 30, 'x')}\nIF CFLAG:2 >= 500\nENDIF\n`;
  for (let i = 0; i < FILE_COUNT; i++) {
    const path = `/f/k${i}.ERB`;
    const name = `FN_${i}`;
    const fn = { name, normalizedName: name, params: [], startLine: 1, endLine: 3, filePath: path, isExpressionFunction: false };
    files.set(path, { path, functions: [fn], dims: [], hasFunctionDirective: false, lineCount: 4 } as ErbFile);
    byName.set(name, [fn]);
    // 每棵一份**独立**正文（后缀带序号）：否则 2,325 条缓存指向同一个字符串，
    // heapUsed 就量不出常驻差异（字符数账仍然真）
    texts.set(path, `${body}${i}\n`);
  }
  const index = { files, byName } as unknown as ErbIndex;
  let reads = 0;
  const engine = new ConditionEngine({
    log: silentLog,
    getProject: () => project,
    getIndex: () => index,
    readFile: async (path) => {
      reads++;
      const t = texts.get(path);
      if (t === undefined) throw new Error(`not found: ${path}`);
      return t;
    },
    scanControlFlow: async (text: string): Promise<ControlFlowStatement[]> => {
      const out: ControlFlowStatement[] = [];
      let line = 0;
      for (const l of text.split('\n')) {
        line++;
        const m = /^IF\s+(.*)$/.exec(l);
        if (m) out.push({ kind: 'IF', expression: m[1]!, depth: 0, line });
      }
      return out;
    },
    getSchemaLookup: () => undefined,
    compute: makeComputeStub(),
    ...(caps ? { detailCacheCaps: caps } : {}),
  });
  return { engine, reads: () => reads };
}

function residentMb(chars: number): string {
  // latin1 正文在 V8 里 1 字节/字符（ASCII 合成盘）；换算 MB 只作人读
  return `${(chars / 1024 / 1024).toFixed(1)}MB`;
}

describe('按需明细的正文常驻：无上限（改前）与有上限（改后）', () => {
  it(`走完 ${FILE_COUNT.toLocaleString()} 棵：常驻从"整树"收成"上限内"`, async () => {
    const open = makeWalkEngine({ maxDetails: Infinity, maxFiles: Infinity, maxChars: Infinity });
    for (let i = 0; i < FILE_COUNT; i++) await open.engine.functionPredicates(`FN_${i}`);
    const openStats = open.engine.cacheStats();

    const capped = makeWalkEngine();
    for (let i = 0; i < FILE_COUNT; i++) await capped.engine.functionPredicates(`FN_${i}`);
    const capStats = capped.engine.cacheStats();

    expect(openStats.textFiles).toBe(FILE_COUNT); // 改前：整树正文全留
    expect(capStats.textFiles).toBeLessThanOrEqual(capStats.maxTextFiles);
    expect(capStats.textChars).toBeLessThanOrEqual(capStats.maxTextChars);
    // 真实语料规模（2,325 棵 × ~62KB）的换算：上限与棵数无关，放大只放大"无上限"那一条。
    // ⚠ 只报**缓存记账**（常驻字符数），不报 heapUsed——node 侧不 gc 时 heapUsed 是噪声，
    //   量常驻用尺子必须是缓存自己数出来的那把（PITFALLS §72 的"别拿机器负载当回归"同族）。
    const scale = 2_325 / FILE_COUNT;
    const projOpen = Math.round(openStats.textChars * scale);
    console.log(
      `[resident] ${FILE_COUNT.toLocaleString()} 棵 × ${(FILE_CHARS / 1024).toFixed(0)}KB/棵 走完一遍后的正文常驻：` +
        `无上限 ${openStats.textFiles} 棵 / ${residentMb(openStats.textChars)} → 有上限 ${capStats.textFiles} 棵 / ${residentMb(capStats.textChars)}` +
        `（上限 ${capStats.maxTextFiles} 棵 / ${residentMb(capStats.maxTextChars)}）；明细条数 ${openStats.details} → ${capStats.details}（上限 ${capStats.maxDetails}）\n` +
        `[resident] 同一均长放大到真实语料 2,325 棵：无上限 ≈ ${residentMb(projOpen)} → 有上限 ≈ ${residentMb(capStats.maxTextChars)}（上限与棵数无关）`,
    );
    expect(capStats.textChars).toBeLessThan(openStats.textChars);
  }, 300_000);
});
