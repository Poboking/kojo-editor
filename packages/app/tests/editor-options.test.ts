import { describe, expect, it } from 'vitest';
import {
  CJK_TYPING_BASELINE,
  HUGE_FILE_LINES,
  LARGE_FILE_LINES,
  editorOptionsForLineCount,
  editorProfileTierForLineCount,
} from '../src/ui/editor-options';

/**
 * 大文件 Monaco 选项降级（三档表驱动）。
 *
 * 钉死三件事：① small 档**保留**便利特性（降级只针对体量，不做无差别阉割）；
 * ② large / huge 档把"全文级"与"装饰性"开销逐层关掉；
 * ③ 两条不变式逐档成立——`CJK_TYPING_BASELINE` 每档同在、降级集永不含 `fontSize` / `zoomLevel`。
 */

const repr = (n: number) => JSON.stringify(n);
const ALL_TIERS_SAMPLES = [10, LARGE_FILE_LINES, HUGE_FILE_LINES, 990_000];

describe('editorProfileTierForLineCount（档位判定）', () => {
  it('阈值含等号：≥5,000 入 large，≥50,000 入 huge', () => {
    expect(editorProfileTierForLineCount(0)).toBe('small');
    expect(editorProfileTierForLineCount(LARGE_FILE_LINES - 1)).toBe('small');
    expect(editorProfileTierForLineCount(LARGE_FILE_LINES)).toBe('large');
    expect(editorProfileTierForLineCount(HUGE_FILE_LINES - 1)).toBe('large');
    expect(editorProfileTierForLineCount(HUGE_FILE_LINES)).toBe('huge');
    expect(editorProfileTierForLineCount(990_000)).toBe('huge');
  });
});

describe('editorOptionsForLineCount（三档开关矩阵）', () => {
  it('small 档：保留便利特性（引导线全开、光标动画全速）', () => {
    const o = editorOptionsForLineCount(500);
    expect(o.occurrencesHighlight).toBe('singleFile');
    expect(o.matchBrackets).toBe('always');
    expect(o.bracketPairColorization).toEqual({ enabled: true });
    expect(o.guides).toEqual({
      bracketPairs: true,
      bracketPairsHorizontal: 'active',
      highlightActiveBracketPair: true,
      indentation: true,
      highlightActiveIndentation: true,
    });
    expect(o.renderLineHighlight).toBe('all');
    expect(o.renderLineHighlightOnlyWhenFocus).toBe(false);
    expect(o.minimap).toEqual({ enabled: true, renderCharacters: false, maxColumn: 72 });
    // B3：小文件开吸顶（贴顶行 = 当前大纲项）
    expect(o.stickyScroll).toEqual({ enabled: true, maxLineCount: 4 });
    expect(o.smoothScrolling).toBe(true);
    expect(o.cursorBlinking).toBe('blink');
    expect(o.cursorSmoothCaretAnimation).toBe('on');
    expect(o.detectIndentation).toBe(true);
  });

  it('large 档：全文级开销关、光标动画停、失焦不铺行高亮', () => {
    const o = editorOptionsForLineCount(12_000);
    expect(o.occurrencesHighlight).toBe('off');
    expect(o.matchBrackets).toBe('near');
    expect(o.bracketPairColorization).toEqual({ enabled: false });
    expect(o.renderLineHighlight).toBe('line');
    expect(o.renderLineHighlightOnlyWhenFocus).toBe(true);
    expect(o.minimap).toEqual({ enabled: false });
    expect(o.stickyScroll).toEqual({ enabled: false });
    expect(o.smoothScrolling).toBe(false);
    expect(o.cursorBlinking).toBe('solid');
    expect(o.cursorSmoothCaretAnimation).toBe('off');
    expect(o.detectIndentation).toBe(false);
  });

  it('large 档：引导线缩到"活动括号对"（indentation 关、括号对留视口级）', () => {
    const o = editorOptionsForLineCount(LARGE_FILE_LINES);
    expect(o.guides).toEqual({
      bracketPairs: 'active',
      bracketPairsHorizontal: 'active',
      highlightActiveBracketPair: false,
      indentation: false,
      highlightActiveIndentation: false,
    });
  });

  it('huge 档：装饰性全关（引导线整表归零、括号配对不办）', () => {
    const o = editorOptionsForLineCount(HUGE_FILE_LINES);
    expect(o.matchBrackets).toBe('never');
    expect(o.guides).toEqual({
      bracketPairs: false,
      bracketPairsHorizontal: false,
      highlightActiveBracketPair: false,
      indentation: false,
      highlightActiveIndentation: false,
    });
    expect(o.minimap).toEqual({ enabled: false });
    // huge 继承 large 的全部降级（不是"回到默认"）
    expect(o.occurrencesHighlight).toBe('off');
    expect(o.smoothScrolling).toBe(false);
    expect(o.detectIndentation).toBe(false);
  });

  it('档位边界含等号（LARGE_FILE_LINES 即降级 occurrencesHighlight）', () => {
    expect(editorOptionsForLineCount(LARGE_FILE_LINES - 1).occurrencesHighlight).toBe('singleFile');
    expect(editorOptionsForLineCount(LARGE_FILE_LINES).occurrencesHighlight).toBe('off');
  });

  it('全档共同：关词建议 + 缩进按语料实况钉死（fixtures 清点 tab 488 行 vs 空格 2 行）', () => {
    for (const n of ALL_TIERS_SAMPLES) {
      const o = editorOptionsForLineCount(n);
      expect(o.wordBasedSuggestions, repr(n)).toBe('off');
      expect(o.tabSize, repr(n)).toBe(4);
      // 关探测的大档必须有 insertSpaces:false 兜底，否则 Tab 落空格 = 对 tab 语料的回归
      expect(o.insertSpaces, repr(n)).toBe(false);
    }
  });

  it('切回小文件可恢复（同一个函数既给降级也给还原，切标签不会"降级卡死"）', () => {
    for (const n of [LARGE_FILE_LINES, HUGE_FILE_LINES]) {
      expect(editorOptionsForLineCount(n).minimap).toEqual({ enabled: false });
    }
    expect(editorOptionsForLineCount(100).minimap).toEqual({
      enabled: true,
      renderCharacters: false,
      maxColumn: 72,
    });
    // 吸顶、光标动画与引导线同样逐档往返（不许卡在关）
    expect(editorOptionsForLineCount(100).stickyScroll).toEqual({ enabled: true, maxLineCount: 4 });
    expect(editorOptionsForLineCount(100).smoothScrolling).toBe(true);
    expect(editorOptionsForLineCount(100).cursorBlinking).toBe('blink');
    expect(editorOptionsForLineCount(100).cursorSmoothCaretAnimation).toBe('on');
    expect(editorOptionsForLineCount(100).guides).toMatchObject({ bracketPairs: true, indentation: true });
  });

  it('不变式①：中文基线（A2+A3）与体量无关——每档都带同一份 CJK_TYPING_BASELINE', () => {
    for (const n of ALL_TIERS_SAMPLES) {
      const o = editorOptionsForLineCount(n);
      expect(o, repr(n)).toMatchObject(CJK_TYPING_BASELINE);
      expect(o.quickSuggestions, repr(n)).toBe(false);
      expect(o.wordSeparators, repr(n)).toBe(CJK_TYPING_BASELINE.wordSeparators);
      expect(o.unicodeHighlight, repr(n)).toEqual(CJK_TYPING_BASELINE.unicodeHighlight);
    }
    expect(CJK_TYPING_BASELINE.quickSuggestions).toBe(false);
    expect(CJK_TYPING_BASELINE.wordSeparators).toContain('，');
    expect(CJK_TYPING_BASELINE.wordSeparators).toContain('：');
    expect(CJK_TYPING_BASELINE.unicodeHighlight?.allowedCharacters?.['，']).toBe(true);
    expect(CJK_TYPING_BASELINE.unicodeHighlight?.ambiguousCharacters).toBe(true);
  });

  it('不变式②：降级集与字号/缩放正交（A1）——任何档位补丁都不含 fontSize / zoomLevel 键', () => {
    for (const n of [1, 4_999, LARGE_FILE_LINES, HUGE_FILE_LINES, 990_000]) {
      const keys = Object.keys(editorOptionsForLineCount(n));
      expect(keys, repr(n)).not.toContain('fontSize');
      expect(keys, repr(n)).not.toContain('zoomLevel');
    }
  });
});
