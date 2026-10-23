import { describe, expect, it } from 'vitest';
import {
  HUGE_FILE_LINES,
  LARGE_FILE_LINES,
  editorOptionsForLineCount,
  editorProfileTierForLineCount,
} from '../src/ui/editor-options';
import {
  claimLargeFileNotice,
  largeFileDegradations,
  largeFileNoticeCopy,
  largeFileNoticeKey,
  reportLargeFileTier,
  resetLargeFileNoticeLedger,
  subscribeLargeFileNotices,
  type LargeFileNoticeFacts,
} from '../src/ui/large-file-notice';
import type { NoticeInput } from '../src/ui/NotificationCenter';

/**
 * 批次十 S6 · 大文件降级显式化。
 *
 * 钉四件事：
 * ① 阈值边界（4,999 / 5,000 / 49,999 / 50,000）与提示的档位一一对应；
 * ② 提示文案只说**真关掉的那几条**（huge 折叠加回降级清单；吸顶 / 折行重估后不再列入）；
 * ③ 台账去重：同文件同档一次、换档 / 换文件才再说，预览与原文互不吞提示；
 * ④ 通知链路：订阅 → 上屏一次；退订之后不再上屏。
 */

const facts = (path: string, lineCount: number, rest: Partial<LargeFileNoticeFacts> = {}): LargeFileNoticeFacts => ({
  path,
  lineCount,
  ...rest,
});

describe('大文件阈值的档位边界（4999 / 5000 / 49999 / 50000）', () => {
  it('含等号：4,999 小、5,000 大、49,999 大、50,000 超大', () => {
    expect(editorProfileTierForLineCount(4999)).toBe('small');
    expect(editorProfileTierForLineCount(5000)).toBe('large');
    expect(editorProfileTierForLineCount(49999)).toBe('large');
    expect(editorProfileTierForLineCount(50000)).toBe('huge');
    // 阈值常量本身也只有一份（本模块只是转出，不另抄数字）
    expect(LARGE_FILE_LINES).toBe(5000);
    expect(HUGE_FILE_LINES).toBe(50_000);
  });

  it('小文件不出声；到线即有一条，且档位与边长一致', () => {
    expect(largeFileNoticeCopy(facts('a.ERB', 4999))).toBeUndefined();
    expect(largeFileNoticeCopy(facts('a.ERB', 5000))?.tier).toBe('large');
    expect(largeFileNoticeCopy(facts('a.ERB', 49999))?.tier).toBe('large');
    expect(largeFileNoticeCopy(facts('a.ERB', 50000))?.tier).toBe('huge');
  });
});

describe('提示文案：只说真关掉的那几条', () => {
  it('large 档列出全文级降级，不提前说 huge 才关的缩略图', () => {
    const copy = largeFileNoticeCopy(facts('/w/长口上.ERB', 12_000));
    expect(copy).toBeDefined();
    expect(copy!.text).toContain('已为大文件关闭');
    expect(copy!.text).toContain('同词高亮');
    expect(copy!.text).toContain('链接与颜色装饰');
    expect(copy!.text).not.toContain('缩略图');
    expect(copy!.text).not.toContain('括号配对高亮');
    expect(copy!.detail).toContain('/w/长口上.ERB');
    expect(copy!.detail).toContain('档=large');
  });

  it('huge 档把缩略图与括号配对高亮一并列出', () => {
    const copy = largeFileNoticeCopy(facts('/w/巨篇.ERB', 52_601));
    expect(copy!.tier).toBe('huge');
    expect(copy!.text).toContain('缩略图');
    expect(copy!.text).toContain('括号配对高亮');
    expect(copy!.detail).toContain('档=huge');
  });

  it('ERB 不列"打字时自动整理"（那条让路只对 .kojo 生效）', () => {
    const erb = largeFileNoticeCopy(facts('a.ERB', 12_000, { isErb: true }));
    const kojo = largeFileNoticeCopy(facts('a.kojo', 12_000, { isErb: false }));
    expect(erb!.text).not.toContain('打字时自动整理');
    expect(kojo!.text).toContain('打字时自动整理');
  });

  it('huge 折叠在降级清单里；吸顶 / 折行重估后不在（清单与档位表同源）', () => {
    const keys = largeFileDegradations().flatMap((d) => d.keys);
    expect(keys).toContain('folding');
    expect(keys).not.toContain('stickyScroll');
    expect(keys).not.toContain('wordWrap');
    // 清单里的键在档位表上必须都存在（改键名忘改清单 ⇒ 这里先红）
    const hugeKeys = new Set(Object.keys(editorOptionsForLineCount(50_000)));
    for (const key of keys) expect(hugeKeys).toContain(key);
  });

  it('huge 档折叠仍关（PS-4 实测多一次整篇 copy）、吸顶保留、折行按偏好', () => {
    const huge = editorOptionsForLineCount(50_000);
    expect(huge.folding).toBe(false);
    expect((huge.stickyScroll as { enabled?: boolean }).enabled).toBe(true);
    // 缺省偏好 = 跟随档 ⇒ 与 large 同值（开）
    expect(huge.wordWrap).toBe('on');
  });
});

describe('一次性台账：同文件同档不重复骚扰', () => {
  it('纯函数内核：同身份第二次返回 false；换档 / 换文件 / 预览才再说', () => {
    const seen = new Set<string>();
    const same = facts('/w/a.ERB', 5000);
    expect(claimLargeFileNotice(same, seen).said).toBe(true);
    expect(claimLargeFileNotice(same, seen).said).toBe(false);
    // 切到另一档：这一档又多关了东西，值得再说一次
    expect(claimLargeFileNotice(facts('/w/a.ERB', 50_000), seen).said).toBe(true);
    // 另一份文件同一档：另一位作者的另一份稿子，不该被上一份的沉默连坐
    expect(claimLargeFileNotice(facts('/w/b.ERB', 5000), seen).said).toBe(true);
    // 预览与原文身份分开：投影不替原文吞掉提示
    expect(claimLargeFileNotice(facts('/w/a.ERB', 5000, { preview: true }), seen).said).toBe(true);
    // 小文件永远不出声，也不往台账里登记
    expect(claimLargeFileNotice(facts('/w/c.ERB', 4999), seen).said).toBe(false);
    expect(seen.has(largeFileNoticeKey(facts('/w/c.ERB', 4999)))).toBe(false);
  });

  it('通知链路：订阅后同一身份只上屏一次；退订后不再上屏', () => {
    resetLargeFileNoticeLedger();
    const got: NoticeInput[] = [];
    const off = subscribeLargeFileNotices((n) => got.push(n));
    expect(reportLargeFileTier(facts('/w/x.ERB', 5000))).toBe(true);
    expect(reportLargeFileTier(facts('/w/x.ERB', 5000))).toBe(false);
    expect(got).toHaveLength(1);
    expect(got[0]!.kind).toBe('info');
    expect(got[0]!.message).toContain('已为大文件关闭');
    // 同一文件升到 huge：再说一次（列出的项目更多）
    expect(reportLargeFileTier(facts('/w/x.ERB', 50_000))).toBe(true);
    expect(got).toHaveLength(2);
    expect(got[1]!.message).toContain('缩略图');
    off();
    // 台账复位后即便再报，也不会有订阅者收到
    resetLargeFileNoticeLedger();
    expect(reportLargeFileTier(facts('/w/y.ERB', 5000))).toBe(true);
    expect(got).toHaveLength(2);
  });
});
