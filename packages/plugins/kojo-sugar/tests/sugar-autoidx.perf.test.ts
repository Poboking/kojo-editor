/**
 * PERF-11 判据用例：`.kojo` 转译里**无条件的时机编号占号全文扫**到底值不值。
 *
 * 被量对象（`src/codegen.ts`）：`codegen` 入口第 348 行 **无条件**调 `buildAutoIndexPools`
 * ——它对每张 `autoIndex` 面（eraTW 只有 `事件`）把整个 `topLevel` 走一遍，
 * `rawFunctionBlock` 的**每一行**都做 `line.trim()` + `headerRe.exec(…)`，
 * 而 `headerRe` 由 `faceHeaderRegex` **每次转译现推**（含 `.*`）。
 * 第二遍同形全文扫 `collectOccupiedCustomIndices` 已被 `if (customs.length > 0)` 兜住
 * （本夹具不含自定指令块 ⇒ 那条扫一次都不跑，不在本判据范围内）。
 *
 * **三档输入**（同一份体量、只差「省略编号的时机头」有没有）：
 * - ① `omitted`：文件里**有**省略编号的 `时机 事件：` ⇒ 占号扫**确有其用**；
 * - ② `explicit`：同体量、头写成显式编号 ⇒ 池**没人消费**，但今天照样全文扫（白扫的那条路）；
 * - ③ `noAutoFace`：与 ② **逐字节同一份输入**，只把面表里的 `autoIndex` 声明摘掉 ⇒ 一条都不扫。
 *
 * 于是 **② − ③ = 纯白扫成本**（两份输入的 parse/emit 工作量完全相同；
 * 这条口径由 `expect(erb②).toBe(erb③)` 的**逐字节相等**断言钉住——见下），
 * ②/① ≈ 1 则证实「扫与不扫与本文件是否需要编号」无关＝无条件。
 *
 * **计时纪律**（PITFALLS 72③）：三档在**同一窗口内交替**采样、逐轮反转顺序、取**中位数**；
 * 不用跨窗比值、不用 min。计时断言只给**极松护栏**，真正的判据读数是打印出来的三档中位数与比值。
 * **档位纪律**（PITFALLS 72①）：默认档只跑 1,000 行（轻量）；5,000 / 20,000 行走
 * `KOJO_PERF_HEAVY=1`——重档进默认并行池会把同池别人的计时断言饿死。
 *
 * **与负载无关的回归网**（本批留下的主要资产）：`execCount` 计数腿把「这趟扫真正动过多少行」
 * 变成**确定性整数**（临时包 `RegExp.prototype.exec`，用完立刻还原）：
 * 今天 ②−③ 的 exec 次数 == 原生区行数（1,000 / 5,000 / 20,000 行档实测 991 / 4,991 / 19,991），
 * 判据钉的是**上界** `≤ 2× 行数`＝「每行最多被每张 autoIndex 面扫一次」。
 * 将来谁把池建进时机循环（Δ 变成 块数×行数）或把扫扩大到非原生块行，这条不碰墙钟的整数断言就翻红。
 *
 * 复跑：
 *   node node_modules/vitest/vitest.mjs run packages/plugins/kojo-sugar/tests/sugar-autoidx.perf.test.ts
 *   KOJO_PERF_HEAVY=1 node node_modules/vitest/vitest.mjs run packages/plugins/kojo-sugar/tests/sugar-autoidx.perf.test.ts
 *
 * ## 结论（本机 2026-10-16，同窗交替中位数；绝对毫秒换机换负载会漂，比值不会）
 *
 * | 档 | ①有省略 | ②无省略(白扫) | ③不扫 | ②/① | ②/③ | 纯扫本体 | 纯扫/千行 | 纯扫占② |
 * |---|---|---|---|---|---|---|---|---|
 * | 1,000 行 | 2.32 | 2.47 | 2.45 ms | 1.06 | 1.01 | 0.08 ms | 0.08 ms | **3.2%** |
 * | 5,000 行 | 65.63 | 69.62 | 68.24 ms | 1.06 | 1.02 | 0.30 ms | 0.06 ms | **0.4%** |
 * | 20,000 行 | 237.54 | 247.51 | 242.36 ms | 1.04 | 1.02 | 1.14 ms | 0.06 ms | **0.5%** |
 *
 * 1. **无条件**这一条**成立**：②/① ≈ 1.0（白扫与「本文件要不要编号」无关，BOARD 的描述没错）；
 * 2. 但**成本可忽略**：纯扫 = 每千行 **0.06–0.08 ms**、随行数**线性**（5,000→20,000 每千行比值 0.95），
 *    占整次转译 **0.4–0.5%**；②−③ 的墙钟差落在噪声里（多次复跑给到 −5.6 … +5.9 ms，正负不定）；
 * 3. `faceHeaderRegex` 每次现推这条也**不是热点**：一条正则 0.01 ms（20,000 行档占转译 0.00%）；
 * 4. ⇒ **本批不改码**（判据 §一「②≈③≈0 ⇒ 只写结论」这一支）。与生产对齐的档位口径：宿主的
 *    降级闸 = `app/src/ui/editor-options.ts:25 LARGE_FILE_LINES = 5000` ⇒ 编辑器交给这条路径的
 *    天花板就是 5,000 行档，那里白扫 **0.30 ms / 占转译 0.4%**，而转译本身 ~68 ms。
 *    钱真正花在转译自己的词法/语法/发射上（每千行 ~13 ms，是这趟扫的 ~200 倍）——要再压
 *    `.kojo` 的停手成本，该动的是「一次击键只 parse 一遍、三腿共用一棵树」那条既有欠账
 *    （`semantic-tokens.perf.test.ts` 文件头第 2 条读数），不是这趟 0.1 ms/千行的扫。
 *
 * **本文件因此是回归网**：`②−③ ≤ 2× 行数` 的 exec 计数判据把「每行最多被 autoFace 扫一次」
 * 钉成与负载无关的整数断言——把池建进时机循环（Δ 会变成 块数×行数）或扩大到非原生块行，都会翻红。
 */
import { describe, expect, it } from 'vitest';
import type { KojoFaceTable } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import type { TopNode } from '../src/parser';
import { stubDict, stubFaceTable } from './support';

/* ============================== 夹具 ============================== */

/** 每个 `事件` 时机块占 3 行（头 + 台词 + 续行） */
const TIMING_BLOCKS = 12;
/** 原生区里每这么多行换一枚函数头（真实口上的函数粒度） */
const RAW_LINES_PER_FUNCTION = 200;

/**
 * 造 `totalLines` 行的 `.kojo`：文件头 + `TIMING_BLOCKS` 个「事件」时机 + 一大片原生 `erb` 正文。
 *
 * @param head 时机头写法：
 *  - `omit`     → `时机 事件：`（省略编号，池**有用**）
 *  - 其它数字   → `时机 事件 <head+i>：`（显式编号；② 用 9001 起、等价性判据用 13 起）
 *
 * **固定占号区**：紧跟时机之后写 `TIMING_BLOCKS` 枚本族事件函数头（`_1.._12`，各带一行正文）
 * ——真实语料形态（作者按文件内序号维护、缺号=空位）。它按块数而非按体量给，
 * 所以**任何行数档**下省略编号都恰好从 `12+1` 起补 ⇒ ①/④ 等价性判据与档位无关。
 */
function kojoFixture(totalLines: number, head: 'omit' | number): string {
  const rows: string[] = ['角色: 12'];
  for (let i = 0; i < TIMING_BLOCKS; i++) {
    rows.push(head === 'omit' ? '时机 事件：' : `时机 事件 ${head + i}：`);
    rows.push(`    「第${i}段台词，用来把正文行撑到目标档位。」`);
    rows.push('    她笑了。 续');
  }
  for (let i = 1; i <= TIMING_BLOCKS; i++) {
    rows.push(`@M_KOJO_EVENT_K12_${i}(ARGS)`);
    rows.push(`\tPRINTFORM 既有事件第${i}号`);
  }
  let f = 100;
  while (rows.length < totalLines) {
    f++;
    // 每 RAW_LINES_PER_FUNCTION 行换一枚原生函数头（都不是本族事件头 ⇒ 不再占号）
    rows.push(f % 7 === 0 ? `@M_KOJO_MESSAGE_COM_K12_${f}` : `@USER_FUNC_${f}`);
    const end = Math.min(totalLines, rows.length + RAW_LINES_PER_FUNCTION - 1);
    for (; rows.length < end; ) {
      const i = rows.length;
      rows.push(
        i % 9 === 0
          ? `\tIF CFLAG:100+${i} = 1`
          : i % 9 === 4
            ? '\tENDIF'
            : `\tPRINTFORM 口上正文第${i}行，含 CJK 与制表符缩进。`,
      );
    }
  }
  return rows.join('\n');
}

/** 与 eraTW 真表**只差一个声明**的对照表：把 `事件` 的 `autoIndex` 摘掉（其余 47 张面原样） */
function tableWithoutAutoIndex(): KojoFaceTable {
  const table = stubFaceTable();
  return {
    ...table,
    faces: { ...table.faces, 事件: { template: 'M_KOJO{t}_EVENT_K{n}_{i}' } },
  };
}

/**
 * 服务实例只建一次（真实装配里它在插件激活时就存在）。
 * 缓存关掉到 1 条 ⇒ 每次 `transpile` 都是**真转译**（同版本缓存是生产的东西，不是被测对象）。
 */
const NO_CACHE = { maxBuckets: 1, maxEntriesPerBucket: 1, maxSourceChars: 1 } as const;
const svcOmit = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable(), cache: NO_CACHE });
const svcExplicit = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable(), cache: NO_CACHE });
const svcNoAuto = createSugarTranspileService({
  dictionary: stubDict,
  faceTable: tableWithoutAutoIndex(),
  cache: NO_CACHE,
});

/** 每次调用换 filePath ⇒ 绝不命中缓存（缓存键 = (source, filePath)） */
let pathTick = 0;
const transpile = (svc: typeof svcOmit, text: string) =>
  svc.transpile(text, { filePath: `C:\\perf\\a${(pathTick++).toString(36)}.kojo` });

/* ============================== 计时口径 ============================== */

interface Latency {
  readonly median: number;
  readonly p95: number;
  readonly runs: number;
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i]!;
}

/** **同窗交替**采样：一轮把各腿按序跑一遍，逐轮反转顺序，逐腿取中位数（PITFALLS 72③） */
function measureAlternate(runs: number, legs: readonly (readonly [string, () => void])[]): Record<string, Latency> {
  const samples = new Map<string, number[]>(legs.map(([name], i) => [name, []]));
  for (let r = 0; r < runs; r++) {
    const order = r % 2 === 0 ? legs : [...legs].reverse();
    for (const [name, fn] of order) {
      const t0 = performance.now();
      fn();
      samples.get(name)!.push(performance.now() - t0);
    }
  }
  const out: Record<string, Latency> = {};
  for (const [name] of legs) {
    const ds = samples.get(name)!.slice().sort((a, b) => a - b);
    out[name] = { median: quantile(ds, 0.5), p95: quantile(ds, 0.95), runs };
  }
  return out;
}

const ms = (v: number): string => v.toFixed(2);
/** 产物里 `事件` 族的函数头行（第 1 列 `@名字`，整行相等比较防 `_1` 撞 `_1_1` 子串） */
const eventHeads = (erb: string): string[] =>
  erb.split('\n').filter((line) => line.startsWith('@') && line.includes('_EVENT_K12_'));

/* ============================== 确定性计数（与负载无关的回归网） ============================== */

/**
 * 数一次转译里 `RegExp.prototype.exec` 被调了几回——**临时**包内置原型、`finally` 立刻还原。
 *
 * 三条腿跑的是**同一份工作量的输入**，所以 ②−③ 的差值就是「白扫吃掉的 exec 次数」，
 * 是个整数读数，不受机器负载影响：白扫还在 ⇒ 差 ≈ 正文行数；白扫没了 ⇒ 差与行数无关。
 */
function execCount(fn: () => void): number {
  const proto = RegExp.prototype as unknown as { exec: (s: string) => RegExpExecArray | null };
  const original = proto.exec;
  let n = 0;
  proto.exec = function patched(this: RegExp, s: string): RegExpExecArray | null {
    n++;
    return original.call(this, s);
  } as (s: string) => RegExpExecArray | null;
  try {
    fn();
  } finally {
    proto.exec = original;
  }
  return n;
}

/**
 * **单独**把占号扫的内循环拎出来计时（`codegen.ts` 里 `buildAutoIndexPools` 的逐字形状，
 * 含 `line.trim()` 分配）。为什么要有这一条：② 与 ③ 各自都是几十毫秒量级，
 * 相减被 GC/负载吃掉（实测 5,000 行档给出**负**差值），「这趟扫到底多少钱」只能用
 * **纯扫的绝对读数**回答 ⇒ 这一条才是判据本体。
 *
 * `headerRe` 就是 `faceHeaderRegex('M_KOJO{t}_EVENT_K{n}_{i}', '12')` 产出的那一条。
 */
function measureScanAlone(text: string, runs: number): { median: number; hits: number; lines: number } {
  const doc = svcExplicit.parse(text, { filePath: 'C:\\perf\\scan.kojo' });
  // 公开契约把 `topLevel` 收窄成「别名 + 时机」，而 `buildDoc` 实际装的是全量 `TopNode`
  // （原生直通块也在里面）——被量对象读的就是这份全量数组，故按内部类型走。
  const topLevel = doc.topLevel as unknown as readonly TopNode[];
  const headerRe = new RegExp('^@M_KOJO.*EVENT_K12_([0-9]+)(?:\\([^()]*\\))?$');
  let hits = 0;
  let seen = 0;
  const ds: number[] = [];
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    let h = 0;
    let n = 0;
    for (const node of topLevel) {
      if (node.kind === 'rawFunctionBlock') {
        for (const line of node.lines) {
          n++;
          if (headerRe.exec(line.trim())) h++;
        }
      } else if (
        node.kind === 'timingBlock' &&
        node.face.trim() === '事件' &&
        node.index !== undefined &&
        /^[0-9]+$/.test(node.index)
      ) {
        h++;
      }
    }
    ds.push(performance.now() - t0);
    hits = h;
    seen = n;
  }
  ds.sort((a, b) => a - b);
  return { median: quantile(ds, 0.5), hits, lines: seen };
}

/** 单独量「每次转译**现推**那条正则」的钱（`faceHeaderRegex`：逐字符拼 pattern + `new RegExp`） */
function measureRegexBuildAlone(runs: number): number {
  const template = 'M_KOJO{t}_EVENT_K{n}_{i}';
  const ds: number[] = [];
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    let pat = '';
    for (let i = 0; i < template.length; ) {
      if (template.startsWith('{t}', i)) {
        pat += '.*';
        i += 3;
      } else if (template.startsWith('{n}', i)) {
        pat += '12';
        i += 3;
      } else if (template.startsWith('{i}', i)) {
        pat += '([0-9]+)';
        i += 3;
      } else {
        pat += template[i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        i += 1;
      }
    }
    void new RegExp(`^@${pat}(?:\\([^()]*\\))?$`);
    ds.push(performance.now() - t0);
  }
  ds.sort((a, b) => a - b);
  return quantile(ds, 0.5);
}

/* ============================== 用例 ============================== */

const HEAVY = process.env.KOJO_PERF_HEAVY === '1';

/** 三档 + 纯扫读数：打印，返回给调用侧做极松护栏与单调性判据 */
function readTier(totalLines: number, runs: number): { legs: Record<string, Latency>; scan: { median: number; lines: number } } {
  const omitText = kojoFixture(totalLines, 'omit');
  const explicitText = kojoFixture(totalLines, 9001);
  const noAutoText = explicitText; // 与 ② 同一份文本，只差面表声明

  // 逐字节等价前提：② 与 ③ 是同一份输入、同一套工作量 ⇒ 两者墙钟差就是白扫差
  const r2 = transpile(svcExplicit, explicitText);
  const r3 = transpile(svcNoAuto, noAutoText);
  expect(r2.erb).toBe(r3.erb);
  expect(r2.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r3.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

  // 热身一轮（JIT），随后同窗交替取中位数
  measureAlternate(2, [
    ['①', () => transpile(svcOmit, omitText)],
    ['②', () => transpile(svcExplicit, explicitText)],
    ['③', () => transpile(svcNoAuto, noAutoText)],
  ]);
  const legs = measureAlternate(runs, [
    ['①', () => transpile(svcOmit, omitText)],
    ['②', () => transpile(svcExplicit, explicitText)],
    ['③', () => transpile(svcNoAuto, noAutoText)],
  ]);

  // 确定性读数：三条腿各数一次 exec 次数（同体量、只差扫不扫）
  const execs = {
    one: execCount(() => transpile(svcOmit, omitText)),
    two: execCount(() => transpile(svcExplicit, explicitText)),
    three: execCount(() => transpile(svcNoAuto, noAutoText)),
  };

  const rawLines = omitText.split('\n').length;
  // 判据本体：**纯扫**的绝对读数（相减被噪声吃掉时只有这一条能回答「值不值」）
  const scan = measureScanAlone(explicitText, Math.max(5, Math.min(runs * 3, 60)));
  const rebuild = measureRegexBuildAlone(2_000);
  console.info(
    `[PERF-11] ${totalLines} 行档（正文实际 ${rawLines} 行）同窗交替中位数：` +
      `①有省略编号 ${ms(legs['①']!.median)} / ②无省略编号(白扫) ${ms(legs['②']!.median)} / ` +
      `③无 autoIndex 面(不扫) ${ms(legs['③']!.median)} ms ⇒ ` +
      `②/①=${(legs['②']!.median / legs['①']!.median).toFixed(2)} ` +
      `②/③=${(legs['②']!.median / legs['③']!.median).toFixed(2)} ` +
      `白扫净成本 ②−③=${ms(legs['②']!.median - legs['③']!.median)} ms ` +
      `(${(((legs['②']!.median - legs['③']!.median) / legs['②']!.median) * 100).toFixed(1)}% of ②)；` +
      `exec 次数 ①=${execs.one} ②=${execs.two} ③=${execs.three} ②−③=${execs.two - execs.three}`,
  );
  console.info(
    `[PERF-11]   └ 纯扫本体（扫 ${scan.lines} 行、命中 ${scan.hits} 枚头）中位 ${ms(scan.median)} ms` +
      ` = 每千行 ${ms((scan.median / scan.lines) * 1000)} ms = ② 的 ${((scan.median / legs['②']!.median) * 100).toFixed(1)}%；` +
      `现推正则（每次转译 1 条）中位 ${ms(rebuild)} ms = ② 的 ${((rebuild / legs['②']!.median) * 100).toFixed(2)}%`,
  );
  // 三条腿都得真干活（否则比值是 0÷0 的假绿）；绝对毫秒不钉，只给塌方护栏
  expect(legs['①']!.median).toBeGreaterThan(0);
  expect(legs['③']!.median).toBeGreaterThan(0);
  expect(legs['②']!.median).toBeLessThan(30_000);
  expect(scan.hits).toBeGreaterThan(0);
  return { legs, scan };
}

describe('PERF-11 时机编号占号全文扫 · 判据读数（默认轻量档）', () => {
  it('② 与 ③ 产物逐字节相等 ⇒ ②−③ 只可能是那趟扫（语义前提钉死）', () => {
    const text = kojoFixture(400, 9001);
    const a = transpile(svcExplicit, text);
    const b = transpile(svcNoAuto, text);
    expect(a.erb).toBe(b.erb);
    expect(a.sourceMap).toEqual(b.sourceMap);
  });

  it('① 省略编号的产物 == 把实际分配到的号手写出来的产物（修的等价性判据）', () => {
    const text = kojoFixture(400, 'omit');
    const auto = transpile(svcOmit, text);
    expect(auto.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // 原生区占住 1..12 ⇒ 12 个省略块从 13 起补
    const written = kojoFixture(400, 13);
    expect(transpile(svcExplicit, written).erb).toBe(auto.erb);
    expect(eventHeads(auto.erb).length).toBeGreaterThan(TIMING_BLOCKS);
  });

  it('1,000 行档：三档中位数与比值打印（计时只给极松护栏）', () => {
    readTier(1_000, 15);
  });

  it('白扫的行数正比性（确定性回归网）：②−③ 的 exec 次数 ≤ 2× 行数', () => {
    const small = kojoFixture(300, 9001);
    const big = kojoFixture(1_200, 9001);
    const dSmall =
      execCount(() => transpile(svcExplicit, small)) - execCount(() => transpile(svcNoAuto, small));
    const dBig = execCount(() => transpile(svcExplicit, big)) - execCount(() => transpile(svcNoAuto, big));
    console.info(
      `[PERF-11] exec 次数差（= 白扫真正动过的行数）：300 行 ${dSmall} → 1,200 行 ${dBig}；` +
        `上限 2× 行数 = ${big.split('\n').length * 2}`,
    );
    expect(dBig).toBeGreaterThan(dSmall); // 确实在扫（否则这条网是空的）
    // 每行**至多**被 autoFace 扫一次（eraTW 目前只有 `事件` 一张 autoIndex 面）。
    // ⇒ 「把池建到时机循环里」（Δ 会变成 块数×行数 = 12×）或「连非原生块的行也扫」都会在这里翻红，
    // 且这条判据与机器负载无关。
    expect(dBig).toBeLessThanOrEqual(big.split('\n').length * 2);
  });
});

describe.skipIf(!HEAVY)('PERF-11 · 重档（默认不跑，理由见文件头 PITFALLS 72①）', () => {
  const scans = new Map<number, { median: number; lines: number }>();

  for (const lines of [5_000, 20_000]) {
    it(`${lines.toLocaleString('en-US')} 行档读数`, () => {
      const r = readTier(lines, lines === 5_000 ? 9 : 4);
      scans.set(lines, r.scan);
    });
  }

  it('纯扫随体量**线性**（每千行成本不得随体量上涨——超线性才值得修）', () => {
    const a = scans.get(5_000)!;
    const b = scans.get(20_000)!;
    const perK = (x: { median: number; lines: number }): number => (x.median / x.lines) * 1000;
    console.info(
      `[PERF-11] 纯扫每千行：5,000 行档 ${ms(perK(a))} ms → 20,000 行档 ${ms(perK(b))} ms` +
        `（比值 ${ms(perK(b) / perK(a))}）`,
    );
    expect(perK(b)).toBeLessThan(perK(a) * 4 + 0.5);
  });
});
