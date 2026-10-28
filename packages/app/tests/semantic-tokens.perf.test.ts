/**
 * 结构化着色 · **宿主编码层**代价读数（B6 交付的另一半；口径同两条供方腿的 perf 测试）。
 *
 * 结论先行：一次击键的开销几乎全在**供方**（整篇 `parseErbText` + `scanFileRefs` / 整棵糖 AST），
 * 宿主这三步（合并 → 按模型夹取 → delta 编码）只与 **span 条数**挂钩，而 span 条数被降级闸
 * 间接压住了（5,000 行档实测产出 ~10² 条）。这里把这条"宿主不是瓶颈"钉成数字，
 * 顺便钉死**闸本身**在真实最大单文件上是关的（>5,000 行 ⇒ 一次 provider 调用都不发生）。
 *
 * ## 两档运行（同两条供方腿的纪律，理由在那两个文件头里写着）
 *
 * 常跑档 = 500 条 span（闸内量级）+ 降级判据本身；`KOJO_PERF_HEAVY=1` 才跑 10,000 条
 * 的病态放大档。默认并行池里跑重档会把**同池别人的计时用例**饿死（实测挂过三条既有断言）。
 *
 * 读数（本机 2026-10-16 多次实测，量级为准）：500 条 median 0.4–1.6 ms；
 * 10,000 条 median 12–26 ms ⇒ 宿主层比供方整腿低**一个数量级以上**，不是瓶颈。
 */

import { describe, expect, it } from 'vitest';
import type { EditorSemanticTokenSpan } from '@kojo/plugin-api';
import { EDITOR_SEMANTIC_TOKEN_TYPES } from '@kojo/plugin-api';
import {
  SEMANTIC_TOKEN_MAX_LINES,
  collectSemanticTokenSpans,
  encodeSemanticTokens,
  normalizeSemanticSpans,
  shouldComputeSemanticTokens,
} from '../src/monaco/kojo-semantic-tokens';
import { HUGE_FILE_LINES } from '../src/ui/editor-options';

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

const fmt = (l: Latency): string => `median ${l.median.toFixed(3)} ms / p95 ${l.p95.toFixed(3)} ms（n=${l.runs}）`;

/** 造 `count` 条 span：每行一条、列在 1..80 内滚动（保证不重叠，走的是正常路径） */
function spansOf(count: number): EditorSemanticTokenSpan[] {
  const out: EditorSemanticTokenSpan[] = [];
  for (let i = 0; i < count; i++) {
    const line = (i % 4000) + 1;
    const startColumn = (i % 60) + 1;
    out.push({
      line,
      startColumn,
      endColumn: startColumn + 8,
      tokenType: EDITOR_SEMANTIC_TOKEN_TYPES[i % EDITOR_SEMANTIC_TOKEN_TYPES.length]!,
      ...(i % 3 === 0 ? { modifiers: ['declaration' as const] } : {}),
    });
  }
  return out;
}

const geometry = { lineCount: 5_000, maxColumn: () => 200 };

/** 重档开关（默认关；理由见文件头「两档运行」） */
const HEAVY = process.env.KOJO_PERF_HEAVY === '1';

describe('B6 着色代价 · 宿主合并/夹取/编码（合成 span，无 IO）', () => {
  const cases = [
    // 闸内真实量级：ERB 腿 5,000 行档实测产出 ~10² 条，这里取 500 放宽一档（**常跑**）
    { count: 500, runs: 200, heavy: false },
    // 病态放大：比闸内可能出现的条数多两个数量级，仍必须便宜（**重档**）
    { count: 10_000, runs: 40, heavy: true },
  ] as const;

  const readings = new Map<number, { cold: number; steady: Latency }>();

  for (const { count, runs, heavy } of cases) {
    it.skipIf(heavy && !HEAVY)(`${count} 条 span 走完宿主三步（合并 → 夹取 → delta 编码）`, () => {
      const spans = spansOf(count);
      const contribution = {
        id: 'stub',
        provide: () => ({ kind: 'semanticToken' as const, spans }),
      };
      const request = { kind: 'semanticToken' as const, path: 'C:\\p\\a.ERB', text: '', project: null };
      const run = (): void => {
        const merged = collectSemanticTokenSpans([contribution], request);
        encodeSemanticTokens(normalizeSemanticSpans(merged, geometry).spans);
      };
      const t0 = performance.now();
      run();
      const cold = performance.now() - t0;
      const steady = measure(runs, run);
      readings.set(count, { cold, steady });
      console.log(`[B6 host] ${count} 条 span：首算 ${cold.toFixed(3)} ms；稳态 ${fmt(steady)}`);
      // 实测：500 条 median ~0.4–1.6 ms；10,000 条（病态放大，闸内不可能出现）~12–26 ms。
      // 只给极松绝对护栏——同两条供方腿的纪律：并行负载能把它抬 2–4 倍，钉死即第一天就红。
      expect(steady.median).toBeLessThan(count <= 1_000 ? 200 : 2_000);
    });
  }

  it('降级闸按 `HUGE_FILE_LINES` 同档生效：large 档整档照算，huge 档让位', () => {
    // 2026-10-28：5,000（`LARGE_FILE_LINES`）→ 50,000（`HUGE_FILE_LINES`）。
    // 旧线是照 Monaco 内部全文特性抄的，而本供方是一趟线性扫描（24,197 行实测 43.9 ms）；
    // 169,247 行那份 435 ms + 16.8 万 span，仍留在闸外。依据见常量注。
    expect(SEMANTIC_TOKEN_MAX_LINES).toBe(HUGE_FILE_LINES); // 单一真源：档位只有一个数
    expect(shouldComputeSemanticTokens(20_000)).toBe(true); // large 档不再让位
    // 52,602 是语料里最大的那一篇：50,000 档**容不下它**（旧线 5,000 时同样容不下，
    // 所以这不是回归）。2026-10-28 之前这条断言写的 `true`，与它上一行的
    // `SEMANTIC_TOKEN_MAX_LINES === HUGE_FILE_LINES`（= 50,000）自相矛盾——两条不可能同时成立。
    expect(shouldComputeSemanticTokens(52_602)).toBe(false);
    expect(shouldComputeSemanticTokens(HUGE_FILE_LINES)).toBe(true); // "≥ 即降"只在越界才降
    expect(shouldComputeSemanticTokens(HUGE_FILE_LINES + 1)).toBe(false);
    expect(shouldComputeSemanticTokens(169_247)).toBe(false);
  });
});
