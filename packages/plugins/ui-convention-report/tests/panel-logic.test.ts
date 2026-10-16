/**
 * 约定校验面板 · 渲染窗口纯逻辑单测（零 React）。
 *
 * 钉住「触底增窗」的三个口径：初窗 ≤ INITIAL / 每步 +STEP 且单调 / 终值钉在 total
 * （窗口版相对旧「硬截 300 + 一键全部」的语义差异：全量可达且单步增量有界）。
 */
import { describe, expect, it } from 'vitest';
import {
  ISSUE_WINDOW_INITIAL,
  ISSUE_WINDOW_STEP,
  issueWindowSize,
  nextIssueWindow,
} from '../src/panel-logic';

describe('单组条目渲染窗口（触底增窗）', () => {
  it('初窗 ≤ INITIAL；小列表整体可见', () => {
    expect(issueWindowSize(10_000, undefined)).toBe(ISSUE_WINDOW_INITIAL);
    expect(issueWindowSize(30, undefined)).toBe(30);
  });

  it('每步 +STEP、单调不减、终值钉在 total（全量可达）', () => {
    expect(nextIssueWindow(undefined, 10_000)).toBe(ISSUE_WINDOW_INITIAL + ISSUE_WINDOW_STEP);
    let cur: number | undefined = undefined;
    let prev: number | undefined = undefined;
    for (let i = 0; i < 500 && cur !== 10_000; i++) {
      cur = nextIssueWindow(cur, 10_000);
      // 步长上界只从第二个窗口起算（首窗 = INITIAL + STEP，上方已单独钉住）
      if (prev !== undefined) {
        expect(cur).toBeGreaterThanOrEqual(prev);
        expect(cur - prev).toBeLessThanOrEqual(ISSUE_WINDOW_STEP);
      }
      prev = cur;
    }
    expect(cur).toBe(10_000);
    expect(nextIssueWindow(cur, 10_000)).toBe(10_000); // 到顶后不再增长
  });

  it('已有窗口（limit）优先于 INITIAL，但被 total 钉住', () => {
    expect(issueWindowSize(10_000, 240)).toBe(240);
    expect(issueWindowSize(100, 240)).toBe(100);
  });
});
