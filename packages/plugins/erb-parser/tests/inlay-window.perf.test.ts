/**
 * R1（2026-10-28）· 行内提示**按窗口取数**的读数。
 *
 * 尺子 = 真实语料之最那篇 **52,601 行 / 2.35 MB（666 k 字符）** 的 ERB（`docs/STATE.md` §二）
 * 的合成复刻（行形态混合：控制流传对、台词含全角空格、注释行、`CALL 名, 实参, 实参`）。
 * 量的是"判读了多少行"，与行内容长度弱相关。
 *
 * 钉三档（前两档是宿主真实路径，第三档是退路）：
 * - **整篇**（改前那一刀）= `splitErbLines` + 逐行判读，52,601 行 30 ms 量级；
 * - **窗口 + 起点偏移**（宿主路径）= Monaco 的可视区 ±30 行那一档（这里取 400 行留余量），
 *   前缀靠 `fromOffset` 直接跳过去，只剩一趟 `[SKIP` 搜索；
 * - **窗口无偏移**（老调用方 / 没有行首表的宿主）= 供方自己数换行走过去，42 ns/行。
 *
 * 断言口径（`docs/PITFALLS.md` §72）：**比值 + 宽松系数 + 绝对上界**。
 * 前两档钉绝对上界 1 ms——那就是 R1 的方案判据（"滚动一次 `provideInlayHints` < 1 ms"），
 * 实测 0.44–0.54 ms，留一倍余量。第三档钉 5 ms（实测 1.5–2.5 ms）：它是"数换行"的价，
 * 不是缺陷，但若有人把偏移那条路删了，这一档会顶到方案判据之上——所以同时钉比值，
 * 让"窗口化被改回整篇"在任何一档都立刻红。
 */

import { describe, expect, it } from 'vitest';
import { callArgumentHints } from '../src/inlay-hints';

const LINES = 52_601;
/** Monaco 实际给的是可视区 ±30 行；这里取 400 行（一屏两三百行的档），比真实窗口更严 */
const WINDOW_SIZE = 400;

function erbLineAt(i: number): string {
  const m = i % 9;
  if (m === 0) return 'IF C[10] > 0';
  if (m === 1) return 'PRINTFORMW 　台词「呀」 C[10]';
  if (m === 2) return 'ENDIF';
  if (m === 3) return ';　注释行：这一段不参与着色与折叠';
  if (m === 4) return 'CALL F, 1, 2';
  if (m === 5) return ' 　　';
  if (m === 6) return 'IF C[20] == 0';
  if (m === 7) return '  PRINTFORMW 分支';
  return 'ENDIF';
}

const text = `${Array.from({ length: LINES }, (_, i) => erbLineAt(i)).join('\n')}\n`;

/** 行首偏移表（等价于宿主 Monaco model 的行首表；这里用 `indexOf` 造一遍，只给量具用） */
const lineStarts: readonly number[] = (() => {
  const out: number[] = [0];
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) out.push(at + 1);
  return out;
})();
const offsetOf = (line: number): number => lineStarts[line - 1]!;

/** 槽名全命中（偏重口径：每个 CALL 都产两条提示，判读成本最高那一档） */
const slotsOf = (): readonly string[] => ['甲', '乙'];

function medianMs(runs: number, fn: () => unknown): number {
  const ds: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ds.push(performance.now() - t0);
  }
  ds.sort((a, b) => a - b);
  return ds[Math.floor(ds.length / 2)]!;
}

const ms = (v: number): string => `${v.toFixed(2)} ms`;

/** 宽松系数：整篇 vs 窗口实测差距在 60 倍以上，取 20 仍留足余量（PITFALLS §72） */
const SAFETY = 20;
/** 窗口那一刀的绝对上界 = 方案判据本身（实测 0.44–0.54 ms） */
const WINDOW_CEILING_MS = 1;
/** 没有起点偏移时（数换行）的绝对上界（实测 1.5–2.5 ms） */
const WALK_CEILING_MS = 5;

describe('R1 读数 · 行内提示按窗口取数（52,601 行）', () => {
  it('宿主路径：带起点偏移的 400 行窗口 vs 整篇', () => {
    const full = medianMs(9, () => callArgumentHints(text, slotsOf));
    const mid = Math.floor(LINES / 2);
    const windowed = medianMs(41, () =>
      callArgumentHints(text, slotsOf, { from: mid, to: mid + WINDOW_SIZE, fromOffset: offsetOf(mid) }),
    );
    // 窗口那一刀真的产出了东西（否则"快"是空转）
    expect(
      callArgumentHints(text, slotsOf, { from: mid, to: mid + WINDOW_SIZE, fromOffset: offsetOf(mid) }).length,
    ).toBeGreaterThan(0);
    console.info(
      `[R1 行内提示] ${LINES} 行：整篇 ${ms(full)} → 窗口 ${WINDOW_SIZE} 行 ${ms(windowed)}（${(full / windowed).toFixed(0)}×）`,
    );
    expect(windowed).toBeLessThan(WINDOW_CEILING_MS);
    expect(full).toBeGreaterThan(windowed * SAFETY);
  });

  it('文末窗口：前缀有 52,000 行也不劣化（这就是偏移要解决的那件事）', () => {
    const full = medianMs(9, () => callArgumentHints(text, slotsOf));
    const from = LINES - WINDOW_SIZE;
    const tail = medianMs(41, () => callArgumentHints(text, slotsOf, { from, to: LINES, fromOffset: offsetOf(from) }));
    console.info(`[R1 行内提示] 文末窗口 ${ms(tail)}（整篇 ${ms(full)}）`);
    expect(tail).toBeLessThan(WINDOW_CEILING_MS);
    expect(full).toBeGreaterThan(tail * SAFETY);
  });

  it('退路：没有起点偏移时只多一趟数换行（不是无界劣化）', () => {
    const full = medianMs(9, () => callArgumentHints(text, slotsOf));
    const from = LINES - WINDOW_SIZE;
    const walked = medianMs(21, () => callArgumentHints(text, slotsOf, { from, to: LINES }));
    console.info(`[R1 行内提示] 无偏移（数换行到第 ${from} 行）${ms(walked)}（整篇 ${ms(full)}）`);
    expect(walked).toBeLessThan(WALK_CEILING_MS);
    expect(full).toBeGreaterThan(walked * 5);
  });
});
