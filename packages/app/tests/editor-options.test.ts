import { describe, expect, it } from 'vitest';
import { LARGE_FILE_LINES, editorOptionsForLineCount } from '../src/ui/editor-options';

/**
 * 大文件 Monaco 选项（2026-10-12「内核优化」批）。
 *
 * 这组断言钉死两件事：① 小文件档**保留**便利特性（降级只针对大文件，不做无差别阉割）；
 * ② 大文件档把三项"全文级"开销全关（`occurrencesHighlight` / 括号配对 / 括号对着色）。
 */
describe('editorOptionsForLineCount（Monaco 大文件降级）', () => {
  it('小文件档：保留便利特性', () => {
    const o = editorOptionsForLineCount(500);
    expect(o.occurrencesHighlight).toBe('singleFile');
    expect(o.matchBrackets).toBe('always');
    expect(o.bracketPairColorization).toEqual({ enabled: true });
    expect(o.renderLineHighlight).toBe('all');
    expect(o.minimap).toEqual({ enabled: true, renderCharacters: false, maxColumn: 72 });
  });

  it('大文件档：关掉全部"全文级"开销', () => {
    const o = editorOptionsForLineCount(52602); // 真实语料最大单文件
    expect(o.occurrencesHighlight).toBe('off');
    expect(o.matchBrackets).toBe('near');
    expect(o.bracketPairColorization).toEqual({ enabled: false });
    expect(o.renderLineHighlight).toBe('line');
    expect(o.minimap).toEqual({ enabled: false });
  });

  it('阈值边界含等号（LARGE_FILE_LINES 即降级）', () => {
    expect(editorOptionsForLineCount(LARGE_FILE_LINES - 1).occurrencesHighlight).toBe('singleFile');
    expect(editorOptionsForLineCount(LARGE_FILE_LINES).occurrencesHighlight).toBe('off');
  });

  it('两档都关词建议与粘性滚动（对 ERB / 中文口上无语义价值）', () => {
    for (const n of [10, 100_000]) {
      expect(editorOptionsForLineCount(n).wordBasedSuggestions).toBe('off');
      expect(editorOptionsForLineCount(n).stickyScroll).toEqual({ enabled: false });
    }
  });

  it('切回小文件可恢复（同一个函数既给降级也给还原，切标签不会"降级卡死"）', () => {
    expect(editorOptionsForLineCount(52602).minimap).toEqual({ enabled: false });
    expect(editorOptionsForLineCount(100).minimap).toEqual({
      enabled: true,
      renderCharacters: false,
      maxColumn: 72,
    });
  });
});
