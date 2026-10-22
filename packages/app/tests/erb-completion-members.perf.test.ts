/**
 * ERB-MEMBER · 10 万名录**热调用**墙钟读数（计时预算用例；串行静默池自动收纳）。
 *
 * 为什么单独一个文件：本仓的墙钟断言由 `tools/perf-suite.mjs` 的源码谓词**自动分池**——
 * 含 `performance.now(` + 对墙钟量的比较断言的文件进串行静默池（`pnpm test:perf`），
 * 主并行池（`pnpm test`）把它排除。同批的 `erb-completion-members.test.ts` 只钉
 * **与总量无关的算法性质**（族键查找 / 索引记忆化 / 上限护栏），墙钟读数落在这里。
 *
 * 口径（写清，别照着抄数字）：
 * - **名录**：10 万条合成名，200 个族 × 每族 500 条（`FAM000_M000` 形态；族 = 首个 `_` 之前 + `_`），
 *   总量与 `completion-perf.test.ts` 的 99k 档同一量级；
 * - **冷启动**：首次调用要建族索引（O(名录大小)）——**不计入**断言（与 `completion-perf`
 *   的「冷 / 热」分栏同款，冷读数只打印）；
 * - **热调用**：同一声明录**数组引用**上（生产侧 = `memoizedErbFunctionNames` 按指纹返回同一
 *   数组）的单次 `erbMemberCompletion`；位置 = `FAM007.M1|`（族内 500 条、片段 `M1`）。
 *   判绿线 = **median < 1 ms**（n = 200）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { CompletionTables } from '../src/monaco/completion-core';
import { erbMemberCompletion } from '../src/monaco/erb-completion-members';

const MONACO = {
  languages: { CompletionItemKind: { Variable: 4, Function: 1 } },
} as unknown as typeof Monaco;

const modelOf = (line: string) => ({ getLineContent: () => line }) as unknown as Monaco.editor.ITextModel;

const FAMILIES = 200;
const PER_FAMILY = 500;
const NAMES: readonly string[] = Array.from({ length: FAMILIES * PER_FAMILY }, (_, i) => {
  const family = Math.floor(i / PER_FAMILY);
  const member = i % PER_FAMILY;
  return `FAM${String(family).padStart(3, '0')}_M${String(member).padStart(3, '0')}`;
});

const TABLES: CompletionTables = { erbFunctionNames: () => NAMES };

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i]!;
}

function measure(runs: number, fn: () => void): { median: number; p95: number } {
  const ds: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ds.push(performance.now() - t0);
  }
  ds.sort((a, b) => a - b);
  return { median: quantile(ds, 0.5), p95: quantile(ds, 0.95) };
}

describe('ERB-MEMBER · 性能（10 万名录热调用 < 1ms）', () => {
  it('热调用 median < 1ms（冷启动建族索引被排除在读数外）', () => {
    expect(NAMES).toHaveLength(100_000);
    const model = modelOf('FAM007.M1');
    const position = { lineNumber: 1, column: 11 } as Monaco.Position;

    // 冷启动（建族索引 + 首次排名）——单独计时，只打印不进断言
    const coldStart = performance.now();
    const first = erbMemberCompletion(MONACO, model, position, TABLES);
    const coldMs = performance.now() - coldStart;

    const warm = measure(200, () => {
      erbMemberCompletion(MONACO, model, position, TABLES);
    });
    // eslint-disable-next-line no-console
    console.log(
      `[ERB-MEMBER] 10 万名录（200 族 × 500 条）：冷启动 ${coldMs.toFixed(1)} ms；` +
        `热调用 median ${warm.median.toFixed(3)} ms / p95 ${warm.p95.toFixed(3)} ms（n=200）；` +
        `候选 ${String(first.items.length)} 条`,
    );

    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThanOrEqual(1000); // 单源护栏（与 erb-functions 同一口径）
    expect(first.items.every((i) => i.confidence === 'heuristic')).toBe(true);
    // 热路径 = 族键 O(1) 取 500 条成员 + 片段过滤 + 少量排名：与名录总量无关
    expect(warm.median).toBeLessThan(1);
  });
});
