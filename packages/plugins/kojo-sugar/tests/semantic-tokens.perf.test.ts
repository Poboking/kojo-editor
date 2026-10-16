/**
 * 结构化着色 · `.kojo` 腿**代价读数**（B6 交付的另一半；与 `erb-parser/tests/semantic-tokens.perf.test.ts` 同一口径）。
 *
 * 这条腿每次击键付的是**整棵糖 AST**：贡献方 `provide` 里 `service.parse(text)` 全量重解析
 * 再走一遍 `eachNode` 遍历（没有增量通道，也没有 memoize——文本每次都可能不同）。
 * 所以档位（宿主那道 5,000 行闸）对它同样生效，读数同样要摆出来。
 *
 * 体量取**合成**数据（口径照 `packages/app/tests/completion-perf.test.ts`：median/p95、
 * 断言只钉比值与极松护栏、绝不钉死绝对毫秒）。密度按真实口上糖文件：绝大多数是台词行，
 * 每 ~300 行一枚 `函数` / `调用`，每 ~1,700 行一枚 `别名`——遍历面与定位面都得真干活。
 *
 * **分两档跑**（同 ERB 腿那条纪律）：常跑档 = 500 行（日常量级）+ 2,000 行对照；
 * `KOJO_PERF_HEAVY=1` 才跑 5,000 / 10,000 行——重档进默认并行池会把同池其它计时用例饿死
 * （实测连 `file-tree` / `marker-hotpath` / `workspace-symbols` 三条既有断言都跟着挂）。
 *
 * **两条读数结论**（本机 2026-10-16，写在实现旁边免得重量；绝对值同机不同负载能差 2–3 倍）：
 * 1. 糖腿比 ERB 腿在同档贵 **2–3 倍**（5,000 行：糖 median 73–113 ms vs ERB 21–44 ms），
 *    贵就贵在**整棵 AST** 的构造上（词法 + 语法 + 节点对象），不是贵在着色遍历上——
 *    着色本身只是又一次 `eachNode`；日常量级（500 行）median ~6 ms，才是这条腿真正服务的档；
 * 2. 同一次击键里，大纲（`kojo-symbols`）与折叠（`kojo-folding`）**各自又做一遍同样的全量 parse**
 *    （见 `src/index.ts` 里那三条贡献的 `provide`），三条腿互不共享解析结果。
 *    ⇒ 真正的修复是"一次击键只 parse 一遍、三腿共用一棵树"（按 `versionId` 记忆化），
 *    那是跨三条线的架构改动，**不在本批范围**，记为欠账。
 *    本批因此不改档位（档位由 `editor-options.ts` 单一真源给），只把数字钉在这里。
 */

import { describe, expect, it } from 'vitest';
import type { KojoFaceTable } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { kojoSemanticTokens } from '../src/semantic-tokens';
import { stubFaceTable } from './support';

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

/** 造 `lineCount` 行的 `.kojo` 文本（密度见文件头；末行不留悬空块，保证整篇可解析） */
function kojoText(lineCount: number): string {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    if (i % 300 === 3) lines.push(`函数 计算伤害_${String(i).padStart(6, '0')}(次数, 倍率 = 2)：`);
    else if (i % 300 === 9) lines.push(`  调用 摸摸头_${String(i).padStart(6, '0')}(次数)`);
    else if (i % 1700 === 11) lines.push(`别名 她${String(i).padStart(5, '0')} = 角色${String(i).padStart(5, '0')}`);
    else lines.push(`    「这是用来逼近真实体量的口上台词行 ${i}，长度足够、含 CJK 与全角标点。」`);
  }
  return lines.join('\n');
}

/** 服务实例**只建一次**（真实装配里它在插件激活时就存在；每次测量新建服务会把装配开销混进击键开销） */
const service = createSugarTranspileService({ faceTable: stubFaceTable() as KojoFaceTable });

/** 贡献方每次击键走的**完整一条腿**：全量重解析 + 遍历定位（不是只量遍历） */
const compute = (text: string): ReturnType<typeof kojoSemanticTokens> =>
  kojoSemanticTokens(service.parse(text, { filePath: 'C:\\p\\a.kojo' }), text);

/** 重档开关（默认关；理由同 `erb-parser/tests/semantic-tokens.perf.test.ts` 文件头——
 * 计时用例进默认并行池会把同池别人的读数饿坏。跑法：`KOJO_PERF_HEAVY=1 node node_modules/vitest/vitest.mjs run <本文件>`） */
const HEAVY = process.env.KOJO_PERF_HEAVY === '1';

/** 日常量级 + 降级档上限两档常跑，其余进重档 */
describe('B6 着色代价 · `.kojo` 腿 · 日常量级（常跑）', () => {
  const text = kojoText(500);
  let cold = 0;
  let steady: Latency = { median: 0, p95: 0, runs: 0 };

  it('500 行整篇重算：首算 + 稳态延迟与 span 产出量', () => {
    const t0 = performance.now();
    const first = compute(text);
    cold = performance.now() - t0;
    steady = measure(60, () => compute(text));
    console.log(
      `[B6 kojo] 500 行（${(text.length / 1048576).toFixed(2)} MiB UTF-16 单元）：` +
        `首算 ${cold.toFixed(2)} ms；稳态 ${fmt(steady)}；产出 ${first.length} 条 span`,
    );
    // 声明腿与调用腿都得有产出，否则这一档只是解析器的开销、没测到着色本身
    expect(first.some((s) => s.tokenType === 'function' && s.modifiers?.includes('declaration'))).toBe(true);
    expect(first.some((s) => s.tokenType === 'parameter')).toBe(true);
    expect(steady.median).toBeLessThan(1_000); // 极松护栏：只有塌方才碰得到
  });

  it('体量翻 4 倍（500 → 2,000 行）开销跟着单调上升（线性，无隐藏二次项）', () => {
    const bigger = measure(20, () => compute(kojoText(2_000)));
    console.log(`[B6 kojo] 2,000 行对照：稳态 ${fmt(bigger)}`);
    expect(bigger.median).toBeGreaterThan(steady.median);
    expect(bigger.median).toBeLessThan(steady.median * 12); // 4× 行数给 12× 余量（负载中立）
  });
});

describe.skipIf(!HEAVY)('B6 着色代价 · `.kojo` 腿 · 重档（默认不跑，理由见文件头）', () => {
  const cases = [
    // 降级档上限（与 ERB 腿同档；对糖腿是"余量"而不是"日常"——盘上不存在 5,000 行的 `.kojo`）
    { lines: 5_000, runs: 30 },
    { lines: 10_000, runs: 12 },
  ] as const;

  const readings = new Map<number, { cold: number; steady: Latency; spans: number }>();

  for (const { lines, runs } of cases) {
    it(`${lines.toLocaleString('en-US')} 行整篇重算：首算 + 稳态延迟与 span 产出量`, () => {
      const text = kojoText(lines);
      const t0 = performance.now();
      const first = compute(text);
      const cold = performance.now() - t0;
      const steady = measure(runs, () => compute(text));
      readings.set(lines, { cold, steady, spans: first.length });
      console.log(
        `[B6 kojo·重] ${lines} 行（${(text.length / 1048576).toFixed(2)} MiB）：` +
          `首算 ${cold.toFixed(2)} ms；稳态 ${fmt(steady)}；产出 ${first.length} 条 span`,
      );
      expect(first.length).toBeGreaterThan(0);
    });
  }

  it('5,000 行 → 10,000 行单调上升且线性', () => {
    const a = readings.get(5_000)!.steady.median;
    const b = readings.get(10_000)!.steady.median;
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(a * 2 * 3); // 2× 行数给 3× 余量
  });
});
