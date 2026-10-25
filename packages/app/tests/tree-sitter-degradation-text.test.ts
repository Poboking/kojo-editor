import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  degradationNoticeText,
  onStructureDegradation,
  reportStructureDegradation,
  resetStructureDegradationLedger,
} from '../src/monaco/tree-sitter/fallback';

/**
 * 回落台账的两条口径（`fallback.ts`）：
 * - **文案**：只丢几段 ≠ 整面退回（`partial`），两种话不许混用——说成"这一面退回了原来的
 *   做法"会让作者去查一个不存在的故障；
 * - **去重**：键里的数字归一成 `#` ⇒ 同一种错不会因为"丢了几段 / 第几版"不同而重说。
 *
 * 2026-10-25 的成因：ERB 每份文档的空区间条数各不相同，按原文去重 ⇒ 每开一个文件多一条
 * "结构着色这次没顶上"，而屏上一段没少。
 */
describe('结构回落 · 文案与去重', () => {
  afterEach(() => {
    resetStructureDegradationLedger();
    vi.restoreAllMocks();
  });

  it('文案：partial 说"几段没涂上"，整面才说"这一面退回了原来的做法"', () => {
    expect(
      degradationNoticeText({ capability: 'semantic', stage: 'parse', partial: true, message: '丢掉 3 段' }),
    ).toBe('结构着色有几段没涂上（其余照常着色）：丢掉 3 段');
    expect(degradationNoticeText({ capability: 'semantic', stage: 'parse', message: '取数失败' })).toBe(
      '结构着色这次没顶上（这一面已退回原来的做法）：取数失败',
    );
    expect(degradationNoticeText({ capability: 'all', stage: 'worker', message: '线程崩了' })).toBe(
      '结构解析这次没顶上（已退回原来的配色与折叠）：线程崩了',
    );
  });

  it('去重：报数变了仍是同一条（每份文档的条数不同不再各说一次）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen: string[] = [];
    const un = onStructureDegradation((d) => seen.push(d.message));
    expect(reportStructureDegradation({ capability: 'semantic', stage: 'parse', partial: true, message: '丢掉 2 段' })).toBe(
      true,
    );
    expect(reportStructureDegradation({ capability: 'semantic', stage: 'parse', partial: true, message: '丢掉 7 段' })).toBe(
      false,
    );
    un();
    expect(seen).toEqual(['丢掉 2 段']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('去重：换一面 / 换一步仍各说一次（归一数字不等于合并一切）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(reportStructureDegradation({ capability: 'semantic', stage: 'parse', message: '丢掉 2 段' })).toBe(true);
    expect(reportStructureDegradation({ capability: 'folds', stage: 'parse', message: '丢掉 2 段' })).toBe(true);
    expect(reportStructureDegradation({ capability: 'semantic', stage: 'query', message: '丢掉 2 段' })).toBe(true);
    expect(reportStructureDegradation({ capability: 'semantic', stage: 'parse', message: '丢掉 2 段' })).toBe(false);
  });
});
