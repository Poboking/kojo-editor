/**
 * 结构化着色 · ERB 腿**代价读数**（B6 交付的另一半；口径照 `packages/app/tests/completion-perf.test.ts`）。
 *
 * 为什么必须有数字：语义 token **没有增量通道**——Monaco 每次内容变化都重新问一遍
 * provider，本腿因此是「整篇重算」（`parseErbText` 一遍 + `scanFileRefs` 一遍 +
 * 每记号一次 Map 查）。这条延迟压在**主线程输入路径**上，所以降级档位（5,000 行）
 * 是拿数字定的，不是拿感觉定的。
 *
 * ## 两档运行（这条纪律是本文件自己实测出来的，不是装饰）
 *
 * - **常跑档**（`pnpm test` 默认含）：只跑 5,000 行 = 降级闸上限那一档，n=40，全程几秒。
 * - **重档**（`KOJO_PERF_HEAVY=1` 才跑）：20,000 / 52,602 行合成 + 真语料最大单文件。
 *   为什么不常跑——**实测**：把重档放进默认并行池，本文件单档就要 100+ s，
 *   并且会把**同池其它计时用例饿死**：一次全量跑里连 `app/tests/file-tree`（微基准）、
 *   `app/tests/marker-hotpath`、`app/tests/workspace-symbols` 三条既有计时断言都跟着挂。
 *   计时测试抢 CPU = 毁掉别人的读数，这比"少一条常跑用例"严重得多。
 *   跑法（隔离、带语料）：
 *   `KOJO_CORPUS_DIR="$(node tools/corpus.mjs --print)" KOJO_PERF_HEAVY=1 node node_modules/vitest/vitest.mjs run packages/plugins/erb-parser/tests/semantic-tokens.perf.test.ts`
 *
 * 断言纪律：只钉**比值 / 单调 / 极松绝对护栏**，绝不钉死绝对毫秒——
 * 同一份代码在同机不同负载下 median 实测能差 2–4 倍（下面记录的读数就是多次实测的区间）。
 *
 * ## 读数结论（本机 2026-10-16 多次实测，量级为准）
 *
 * - 5,000 行（降级档上限）median 21–120 ms / 首算 36–137 ms，产出 104 条 span；
 * - 20,000 行 median 85–191 ms（403 条）；52,602 行 median 225–437 ms（1,054 条）；
 * - **真语料最大单文件**（52,602 行 / 2.24 MiB，130 个定义 / 141 条 CALL）median 112–221 ms，
 *   产出 132 条 span ⇒ 合成体与真语料同阶（密度对得上）；线性成立（10.5× 行数 ≈ 4–10× 时间，
 *   区间宽度全部来自同机负载，不是代码）。
 * - **贵在哪一条腿**（同档逐段计时）：`scanFileRefs`（引用腿）~38–95 ms ≫ `parseErbText`
 *   （声明腿）~1–2 ms；对照：常开的折叠腿只有 ~3.5–10 ms ⇒ 着色整腿是折叠腿的**十余倍**，
 *   多出来的几乎全在引用腿。
 *
 * 由此两条判据级结论：① 5,000 行这一档已经是"一次击键付几十毫秒"，档位不能再松；
 * ② 要提速只有一条正路——改 `scanFileRefs`（查找引用 / 重命名同一条腿一起受益），
 * 不在着色层加缓存（那才是第二真相源）。默认关因此不只是审美保守，是账单决定的。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ErbFunction, ErbIndex } from '@kojo/plugin-api';
import { erbSemanticTokens } from '../src/semantic-tokens';
import { erbFoldingRanges } from '../src/folding';
import { parseErbText } from '../src/scanner';
import { scanFileRefs } from '../src/references';

/* ============================== 读数工具（同 completion-perf 口径） ============================== */

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

function measure(runs: number, fn: () => void): Latency {
  const ds: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ds.push(performance.now() - t0);
  }
  ds.sort((a, b) => a - b);
  return { median: quantile(ds, 0.5), p95: quantile(ds, 0.95), runs };
}

const fmt = (l: Latency): string => `median ${l.median.toFixed(2)} ms / p95 ${l.p95.toFixed(2)} ms（n=${l.runs}）`;

/** 重档开关（默认关，理由见文件头「两档运行」） */
const HEAVY = process.env.KOJO_PERF_HEAVY === '1';
const CORPUS = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;

/* ============================== 语料形态的合成数据 ============================== */

/** 全库函数量级（`byName` 键数）——查表这段的规模必须是真的，否则 Map 全落在 cache 里 */
const INDEX_NAMES = 110_194;

/** 降级档上限（与 `editor-options.ts` 的 `LARGE_FILE_LINES` 同数；本包不跨包 import，档位由宿主单测钉住） */
const GATE_LINES = 5_000;

/**
 * 造 `lineCount` 行、密度对齐真语料最大单文件的 `.ERB` 文本
 * （实测那个文件：52,602 行里 130 个 `@` 定义 / 141 条 `CALL` / 8 个 `#DIM` / 1,676 行注释）。
 * **引用腿与声明腿都得真干活**——只造空行等于没测。
 */
function erbText(lineCount: number): string {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    if (i % 405 === 4) lines.push(`@M_KOJO_K58_${String(i).padStart(6, '0')}(ARGS, ARG:1 = 3)`);
    else if (i % 373 === 7) lines.push(`\tCALL M_KOJO_K58_${String(i - 7).padStart(6, '0')}(1)`);
    else if (i % 31 === 0) lines.push(`; 注释行 ${i}：这一段是作者留下的说明，着色不该在这里付命中成本`);
    else if (i % 97 === 5) lines.push('#DIM FLAG_' + String(i));
    else lines.push(`\tPRINTFORMW 美鈴は「这是用来逼近真实体量的口上台词行 ${i}，长度足够、含 CJK 与半角标点。」`);
  }
  return lines.join('\n');
}

/** 只填着色用得上的字段的最小索引替身（`byName` 全大写键，与真实聚合口径一致） */
function indexWith(names: number): ErbIndex {
  const byName = new Map<string, ErbFunction[]>();
  for (let i = 0; i < names; i++) {
    byName.set(`M_KOJO_K58_${String(i).padStart(6, '0')}`, []);
  }
  return { files: new Map(), byName, fingerprint: null } as unknown as ErbIndex;
}

const INDEX = indexWith(INDEX_NAMES);
const HAS_NAME = (upper: string): boolean => INDEX.byName.has(upper);

/* ============================== 常跑档：降级闸上限那一档 ============================== */

describe('B6 着色代价 · ERB 腿 · 5,000 行（降级档上限，常跑）', () => {
  const text = erbText(GATE_LINES);
  let cold = 0;
  let steady: Latency = { median: 0, p95: 0, runs: 0 };

  it('整篇重算：首算 + 稳态延迟与 span 产出量', () => {
    // 首算 = 本进程第一次走这条码（JIT 冷 + 正则首次编译）；稳态 = 其后 n 次
    const t0 = performance.now();
    const first = erbSemanticTokens(text, INDEX);
    cold = performance.now() - t0;
    steady = measure(40, () => erbSemanticTokens(text, INDEX));
    console.log(
      `[B6 erb] ${GATE_LINES} 行（${(text.length / 1048576).toFixed(2)} MiB UTF-16 单元）：` +
        `首算 ${cold.toFixed(2)} ms；稳态 ${fmt(steady)}；产出 ${first.length} 条 span`,
    );
    // 两条腿都在干活（引用腿要命中索引、声明腿要截定义名），否则这一档等于没测
    expect(first.some((s) => s.tokenType === 'function' && s.modifiers?.includes('declaration'))).toBe(true);
    expect(first.some((s) => s.tokenType === 'function' && !s.modifiers)).toBe(true);
    // 极松绝对护栏：只有塌方（二次化、把索引当字符串搜）才碰得到，正常负载浮动碰不到
    expect(steady.median).toBeLessThan(2_000);
  });

  it('开销归因：贵在**引用腿**，不在着色层（比值判据，负载中立）', () => {
    const onlyParse = measure(40, () => parseErbText(text));
    const onlyRefs = measure(40, () => scanFileRefs(text, HAS_NAME));
    const onlyFold = measure(40, () => erbFoldingRanges(text));
    console.log(
      `[B6 erb·归因] ${GATE_LINES} 行单次：parseErbText ${fmt(onlyParse)}｜scanFileRefs ${fmt(onlyRefs)}｜` +
        `erbFoldingRanges（常开对照）${fmt(onlyFold)}｜着色整腿 ${fmt(steady)}`,
    );
    // 三条结论都要能被断言钉住，否则下一个人只会重新猜一遍：
    // 1) 引用腿是主项（`codeViewOf` 逐字符刷白 + 每记号一次 Map 查，比声明腿贵一个数量级）；
    // 2) 整腿 ≥ 引用腿（着色层不可能比它所包含的那段便宜，反之说明漏测）；
    // 3) 整腿 < 引用腿 ×2 + 声明腿 ⇒ 着色自己没长出第二次全文扫描（长了就该并表）。
    //    ⇒ 将来要提速只改 `scanFileRefs`，查找引用 / 重命名一起受益；不在着色层加缓存。
    expect(onlyRefs.median).toBeGreaterThan(onlyParse.median * 5);
    expect(steady.median).toBeGreaterThanOrEqual(onlyRefs.median);
    expect(steady.median).toBeLessThan(onlyRefs.median * 2 + onlyParse.median);
  });
});

/* ============================== 重档：20,000 / 52,602（KOJO_PERF_HEAVY=1） ============================== */

describe.skipIf(!HEAVY)('B6 着色代价 · ERB 腿 · 重档（默认不跑，理由见文件头）', () => {
  const cases = [
    { lines: 20_000, runs: 30 },
    { lines: 52_602, runs: 10 },
  ] as const;

  const readings = new Map<number, { cold: number; steady: Latency; spans: number }>();

  for (const { lines, runs } of cases) {
    it(`${lines.toLocaleString('en-US')} 行整篇重算：首算 + 稳态`, () => {
      const big = erbText(lines);
      const t0 = performance.now();
      const first = erbSemanticTokens(big, INDEX);
      const cold = performance.now() - t0;
      const steady = measure(runs, () => erbSemanticTokens(big, INDEX));
      readings.set(lines, { cold, steady, spans: first.length });
      console.log(
        `[B6 erb·重] ${lines} 行（${(big.length / 1048576).toFixed(2)} MiB）：首算 ${cold.toFixed(2)} ms；` +
          `稳态 ${fmt(steady)}；产出 ${first.length} 条 span`,
      );
      expect(first.length).toBeGreaterThan(0);
    });
  }

  it('开销随体量单调上升且**线性**（整篇重算没有隐藏的二次项）', () => {
    const a = readings.get(20_000)!.steady.median;
    const b = readings.get(52_602)!.steady.median;
    expect(b).toBeGreaterThan(a);
    // 线性外推护栏：不超过「按 20,000 行线性放大」的 3 倍（真二次化会远超这条）
    expect(b).toBeLessThan(a * (52_602 / 20_000) * 3);
  });

  it('span 产出量也随体量线性（1,054 ÷ 403 ≈ 52,602 ÷ 20,000）', () => {
    const a = readings.get(20_000)!.spans;
    const b = readings.get(52_602)!.spans;
    expect(b / a).toBeGreaterThan(2);
    expect(b / a).toBeLessThan(4);
  });
});

/* ============================== 真语料最大单文件（语料 + HEAVY 双闸） ============================== */

describe.skipIf(!HEAVY || !CORPUS)('B6 着色代价 · 真语料最大单文件（合成体自证）', () => {
  it('扫盘上最大的那个 `.ERB`：首算 + 稳态与合成 52,602 行同阶', () => {
    const root = join(CORPUS!, 'ERB');
    let best = { path: '', size: -1 };
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.erb$/i.test(entry.name)) {
          const size = statSync(p).size;
          if (size > best.size) best = { path: p, size };
        }
      }
    };
    walk(root);
    expect(best.path).not.toBe('');

    const text = readFileSync(best.path, 'utf8');
    const lineCount = text.split('\n').length;
    const t0 = performance.now();
    const first = erbSemanticTokens(text, INDEX);
    const cold = performance.now() - t0;
    const steady = measure(10, () => erbSemanticTokens(text, INDEX));
    console.log(
      `[B6 erb·真语料] ${best.path}：${lineCount.toLocaleString('en-US')} 行 / ${(best.size / 1048576).toFixed(2)} MiB；` +
        `首算 ${cold.toFixed(2)} ms；稳态 ${fmt(steady)}；产出 ${first.length} 条 span` +
        `（>5,000 行 ⇒ 实际不进入：由宿主降级闸挡住）`,
    );
    expect(lineCount).toBeGreaterThan(GATE_LINES); // 这一档存在的理由：它确实超闸
    expect(first.length).toBeGreaterThan(0); // 判据在真语料上真产出（不是只对合成成立）
    // 同阶判据：真语料最大单文件与合成 52,602 行同阶就是这条用例的价值（合成体没跑偏）
    expect(steady.median).toBeLessThan(20_000);
  });
});
