/**
 * PS-5 · 对比视图的体量闸（DiffViewOverlay.tsx）。
 *
 * 改前只靠 vendor 两道刹车（`maxComputationTime` 5,000ms / `maxFileSize` 50 MB），
 * 而 standalone 的 monaco **没有** diff worker 通道（`externalLinesDiffComputer` 那条
 * 走 VS Code 的 DiffEditorController，产物里取不到）⇒ 两遍全文的行级差异在主线程算，
 * 语料最大那对文件（2 × 2.35 MB）按下去就是几秒白屏。
 *
 * 钉三件：判据本身 / 收得比 vendor 紧的那两道（源码形状）/ **拦下来要看得见**
 * （渲染里必须有原话与一条「仍然对比」的去路，静默降级是铁律 4 禁止的）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DIFF_COLLAPSE_MIN_LINES,
  DIFF_GATE_MAX_LINES,
  DIFF_GATE_MAX_UNITS,
  countLines,
  diffGatePaused,
  formatCharCount,
} from '../src/ui/DiffViewOverlay';

const SOURCE = readFileSync(
  fileURLToPath(new URL('../src/ui/DiffViewOverlay.tsx', import.meta.url)),
  'utf8',
);

describe('diffGatePaused（纯判据）', () => {
  it('码元数与行数各自独立越界即拦；阈值以下放行', () => {
    expect(diffGatePaused(0, 0)).toBe(false);
    expect(diffGatePaused(DIFF_GATE_MAX_UNITS, DIFF_GATE_MAX_LINES)).toBe(false);
    expect(diffGatePaused(DIFF_GATE_MAX_UNITS + 1, 1)).toBe(true);
    expect(diffGatePaused(1, DIFF_GATE_MAX_LINES + 1)).toBe(true);
  });

  it('真实语料最大那一对（同文件两版，52,601 行 / 各约 1.3 M 码元）**照常对比**，不加一次点击', () => {
    expect(diffGatePaused(1_300_000 * 2, 52_601 * 2)).toBe(false);
  });

  it('比它再大一截才拦（越界形态：两份 4 MB 级 / 百万行级）', () => {
    expect(diffGatePaused(9_000_000, 200_000)).toBe(true);
  });
});

describe('countLines / formatCharCount', () => {
  it('行数按换行符计（1 基；空文本算一行），且不分配数组', () => {
    expect(countLines('')).toBe(1);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\nb\n')).toBe(3); // 尾随换行 = 最后一行为空，仍然占一行
    expect(countLines('字\n'.repeat(1000))).toBe(1001);
  });

  it('量级说人话：中文读"多少字"，不出现 byte / UTF-16 这类内部口径', () => {
    expect(formatCharCount(999)).toBe('999');
    expect(formatCharCount(9_000)).toBe('9000');
    expect(formatCharCount(3_100_000)).toBe('310 万');
    expect(formatCharCount(3_140_000)).toContain('万');
  });
});

describe('拦下来必须看得见（渲染形状）', () => {
  it('越界且不放行 ⇒ 容器不挂、原话与「仍然对比」都在', () => {
    expect(SOURCE).toContain('bothOk && !identical && !gated ? h');
    expect(SOURCE).toContain('gated');
    expect(SOURCE).toContain('仍然对比');
    // 放行是**逐格**记的（不是全局一次放行顶所有格子）
    expect(SOURCE).toContain('forcedKeys[activeKey]');
  });

  it('两道 vendor 刹车收到与体量闸同一量级（源码形状；改前一个字都没设）', () => {
    expect(SOURCE).toContain('maxComputationTime: 3000');
    expect(SOURCE).toContain('maxFileSize: 20');
    expect(SOURCE).toContain('hideUnchangedRegions: { enabled: gateLines >= DIFF_COLLAPSE_MIN_LINES }');
  });

  it('折叠只在门槛以上开——小对比的观感与改前逐字一致', () => {
    expect(DIFF_COLLAPSE_MIN_LINES).toBeGreaterThan(0);
    expect(DIFF_COLLAPSE_MIN_LINES).toBeLessThan(DIFF_GATE_MAX_LINES);
  });
});
