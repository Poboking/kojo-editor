import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CJK_TYPING_BASELINE,
  FIND_BASELINE,
  HUGE_FILE_LINES,
  LARGE_FILE_LINES,
  editorOptionsForLineCount,
  editorProfileTierForLineCount,
} from '../src/ui/editor-options';
// —— P2-16 追加用例的依赖（一律新行；上面的既有 import 一行未动）——
import { afterEach, vi } from 'vitest';
import { layoutPrefPatch } from '../src/ui/editor-options';
import { LAYOUT_PREF_DEFAULT, type LayoutPref } from '../src/ui/layout-pref';
// —— C-1b 追加用例的依赖（缩略图偏好层与档位表的分层；同样只加行）——
import {
  applySizeTier,
  sizeTierKeys,
  sizeTierKeysMissingFromSmall,
  type EditorOptionPatch,
} from '../src/ui/editor-options';
import { editorDisplayOptionPatch } from '../src/ui/editor-display-prefs';

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

  it('large 档：全文级开销关、光标动画停、失焦不铺行高亮（导航面不在这一刀里）', () => {
    const o = editorOptionsForLineCount(12_000);
    expect(o.occurrencesHighlight).toBe('off');
    expect(o.matchBrackets).toBe('near');
    expect(o.bracketPairColorization).toEqual({ enabled: false });
    expect(o.renderLineHighlight).toBe('line');
    expect(o.renderLineHighlightOnlyWhenFocus).toBe(true);
    // 1020 编辑器体感批：large 保留缩略图与吸顶——small 那份缩略图本来就是廉价模式
    // （不逐字符渲染、限 72 列），吸顶按可见区间算，两者都不是"随全文增长"的开销
    expect(o.minimap).toEqual({ enabled: true, renderCharacters: false, maxColumn: 72 });
    expect(o.stickyScroll).toEqual({ enabled: true, maxLineCount: 3 });
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
    // 导航面到 huge 才真的关（99 万行级盘上缩略图逐行算色块、吸顶每次滚动重排可见区）
    expect(o.stickyScroll).toEqual({ enabled: false });
    // huge 继承 large 的全部降级（不是"回到默认"）
    expect(o.occurrencesHighlight).toBe('off');
    expect(o.smoothScrolling).toBe(false);
    expect(o.detectIndentation).toBe(false);
  });

  it('档位边界含等号（LARGE_FILE_LINES 即降级 occurrencesHighlight）', () => {
    expect(editorOptionsForLineCount(LARGE_FILE_LINES - 1).occurrencesHighlight).toBe('singleFile');
    expect(editorOptionsForLineCount(LARGE_FILE_LINES).occurrencesHighlight).toBe('off');
  });

  it('全档共同：Monaco 内建词建议恒关（文档词走受门 source）+ 缩进按语料实况钉死', () => {
    for (const n of ALL_TIERS_SAMPLES) {
      const o = editorOptionsForLineCount(n);
      expect(o.wordBasedSuggestions, repr(n)).toBe('off');
      expect(o.tabSize, repr(n)).toBe(4);
      // 关探测的大档必须有 insertSpaces:false 兜底，否则 Tab 落空格 = 对 tab 语料的回归
      expect(o.insertSpaces, repr(n)).toBe(false);
    }
  });

  it('切回小文件可恢复（同一个函数既给降级也给还原，切标签不会"降级卡死"）', () => {
    // 缩略图：large 仍是廉价模式，只有 huge 才关；吸顶同样只在 huge 关
    expect(editorOptionsForLineCount(LARGE_FILE_LINES).minimap).toEqual({
      enabled: true,
      renderCharacters: false,
      maxColumn: 72,
    });
    expect(editorOptionsForLineCount(HUGE_FILE_LINES).minimap).toEqual({ enabled: false });
    expect(editorOptionsForLineCount(HUGE_FILE_LINES).stickyScroll).toEqual({ enabled: false });
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
      expect(o.quickSuggestions, repr(n)).toEqual({ other: true, comments: false, strings: false });
      expect(o.wordSeparators, repr(n)).toBe(CJK_TYPING_BASELINE.wordSeparators);
      expect(o.unicodeHighlight, repr(n)).toEqual(CJK_TYPING_BASELINE.unicodeHighlight);
    }
    expect(CJK_TYPING_BASELINE.quickSuggestions).toEqual({ other: true, comments: false, strings: false });
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

/**
 * find 体验基线（A7，2026-10-20）。
 *
 * 断言钉三件事：① 只用 vendor **实测存在**的字段（`loopAtEnd` / `seedSearchStringFromGlobalClipboard`
 * 在 monaco 0.57 都**不存在**——循环查找真名 `loop`；剪贴板播种是 findController 内部态、无公开配置）；
 * ② 大小文件两条 `editorOptionsForLineCount` 路径都不吞 find；③ create 路径 spread 同一常量
 * （静态取证：读源码查 spread 在场——两条写选项的路径少一条就是档位漂移）。
 */
describe('find 体验基线（A7）', () => {
  it('字段集合 = 0.57 实测在册：seedSearchStringFromSelection + loop，没有编造的字段', () => {
    expect(FIND_BASELINE.find).toEqual({ seedSearchStringFromSelection: 'always', loop: true });
  });

  it('切文件路径（editorOptionsForLineCount）两档都带 find，档位降级不关循环/播种', () => {
    for (const n of [10, LARGE_FILE_LINES, 100_000]) {
      expect(editorOptionsForLineCount(n).find).toEqual(FIND_BASELINE.find);
    }
  });

  it('create 路径 spread 同一份基线（use-monaco-instance.ts 静态取证）', () => {
    // REF-FRONT-PERF：create 选项从 EditorPane 搬进实例 hook，判据跟着搬家
    const src = readFileSync(
      fileURLToPath(new URL('../src/ui/editor-pane/use-monaco-instance.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('...FIND_BASELINE,');
    expect(src).toContain('...CJK_TYPING_BASELINE,');
  });

  it('vendor 实测（取证）：「选中即搜 + 循环」是 monaco 0.57 的内建缺省——loopAtEnd 这名字根本不存在', () => {
    const vendor = readFileSync(
      fileURLToPath(new URL('../node_modules/monaco-editor/esm/vs/editor/common/config/editorOptions.js', import.meta.url)),
      'utf8',
    );
    // EditorFind 的 defaults 段：seed 缺省 'always'（Ctrl+F 带选区预填=内建），loop 缺省 true
    expect(vendor).toContain("seedSearchStringFromSelection: 'always'");
    expect(/class EditorFind[\s\S]*?loop: true,/.test(vendor)).toBe(true);
    // 不存在的名字若哪天混进 vendor（升级漂移），本测试先响——FIND_BASELINE 就得不重写
    expect(vendor).not.toContain('loopAtEnd');
  });
});

/**
 * 排版偏好叠层（P2-16）：折行三选一 + 多光标修饰键 + 列选择。
 *
 * 钉三件事：① 缺省偏好下与今天**逐字一致**（wordWrap on/on/off；两个新键的缺省值
 * 就是 Monaco 的注册缺省行为——ctrlCmd / false）；② 偏好作为 override **叠在档位表
 * 之后**：「跟随体量档」= 档位表自己的值（等价于不传 override），「强制开 / 强制关」
 * = 盖在表上，huge 档也拦不住用户明说的选择；③ `editorOptionsForLineCount` **现读**
 * localStorage——同源不是硬编码：存过「强制关」后，小文件也 off。
 *
 * node 环境无 window ⇒ 假 localStorage 驱动；afterEach 拆掉，不污染本文件既有用例。
 */
const fakeStorage = (initial: Record<string, string> = {}): Storage => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
};

const stubWindow = (storage: Storage | undefined): void => {
  vi.stubGlobal('window', storage === undefined ? {} : { localStorage: storage });
};

afterEach(() => vi.unstubAllGlobals());

describe('排版偏好叠层（P2-16）', () => {
  it('layoutPrefPatch：跟随档 = 档位表自己的值（small/large 开、huge 关）', () => {
    const tier: LayoutPref = { wordWrap: 'tier', multiCursorModifier: 'ctrlCmd', columnSelection: false };
    expect(layoutPrefPatch(500, tier).wordWrap).toBe('on');
    expect(layoutPrefPatch(LARGE_FILE_LINES, tier).wordWrap).toBe('on');
    expect(layoutPrefPatch(HUGE_FILE_LINES, tier).wordWrap).toBe('off');
    expect(layoutPrefPatch(990_000, tier).wordWrap).toBe('off');
  });

  it('layoutPrefPatch：强制开 / 强制关盖在档位表之后（huge 也拦不住明说的选择）', () => {
    const base = { multiCursorModifier: 'ctrlCmd', columnSelection: false } as const;
    expect(layoutPrefPatch(HUGE_FILE_LINES, { ...base, wordWrap: 'on' }).wordWrap).toBe('on');
    expect(layoutPrefPatch(100, { ...base, wordWrap: 'off' }).wordWrap).toBe('off');
    // 对照：同一行数、跟随档时是 'on'——差的就是这一层 override
    expect(layoutPrefPatch(100, { ...base, wordWrap: 'tier' }).wordWrap).toBe('on');
  });

  it('layoutPrefPatch：修饰键与列选择恒取偏好值，与体量无关', () => {
    const p = layoutPrefPatch(990_000, { wordWrap: 'tier', multiCursorModifier: 'alt', columnSelection: true });
    expect(p.multiCursorModifier).toBe('alt');
    expect(p.columnSelection).toBe(true);
  });

  it('缺省偏好下 editorOptionsForLineCount 与今天逐字一致：wordWrap on/on/off，新键 = Monaco 缺省行为', () => {
    // node 环境无 window ⇒ loadLayoutPref() 恒回缺省（LAYOUT_PREF_DEFAULT）
    expect(editorOptionsForLineCount(500).wordWrap).toBe('on');
    expect(editorOptionsForLineCount(LARGE_FILE_LINES).wordWrap).toBe('on');
    expect(editorOptionsForLineCount(HUGE_FILE_LINES).wordWrap).toBe('off');
    for (const n of [1, 4_999, LARGE_FILE_LINES, HUGE_FILE_LINES, 990_000]) {
      const o = editorOptionsForLineCount(n);
      expect(o.multiCursorModifier, String(n)).toBe(LAYOUT_PREF_DEFAULT.multiCursorModifier);
      expect(o.columnSelection, String(n)).toBe(LAYOUT_PREF_DEFAULT.columnSelection);
    }
  });

  it('editorOptionsForLineCount 现读偏好：存过「强制关」后小文件也 off（同源不是硬编码）', () => {
    stubWindow(fakeStorage({ 'kojo.ui.layout.wordWrap.v1': 'off' }));
    expect(editorOptionsForLineCount(100).wordWrap).toBe('off');
    expect(editorOptionsForLineCount(HUGE_FILE_LINES).wordWrap).toBe('off');
    stubWindow(fakeStorage({ 'kojo.ui.layout.wordWrap.v1': 'on' }));
    expect(editorOptionsForLineCount(HUGE_FILE_LINES).wordWrap).toBe('on');
    // 存坏的值不猜：回落缺省（跟随档 ⇒ huge 仍 off）
    stubWindow(fakeStorage({ 'kojo.ui.layout.wordWrap.v1': 'garbage' }));
    expect(editorOptionsForLineCount(HUGE_FILE_LINES).wordWrap).toBe('off');
    expect(editorOptionsForLineCount(100).wordWrap).toBe('on');
  });
});

/**
 * C-1b 缩略图偏好的**分层**口径（体量轴 vs 内容轴）。
 *
 * 这一段的落点在 `editor-options.ts` 而不是偏好模块：偏好层必须**只能**盖在档位表之后，
 * 档位表自己既不许读偏好、也不许知道"屏幕上是不是预览"。否则三档矩阵就成了按调用点
 * 变化的第二份真源，`sizeTierKeys` / `sizeTierKeysMissingFromSmall` 那两条不变式也没法再谈。
 */
describe('缩略图：档位表与偏好层的分层（C-1b）', () => {
  it('体量表是上下文无关的纯函数：同一行数永远同一读数，与预览 / 正文档无关', () => {
    // editorOptionsForLineCount 的形参只有一个行数——它拿不到"此刻屏幕上挂的是哪份文档"，
    // 因此**结构上**不可能把缩略图的内容判据算进档位表（这一条就是分层本身）
    expect(editorOptionsForLineCount.length, '档位函数不许长出第二个形参').toBe(1);
    for (const n of ALL_TIERS_SAMPLES) {
      const o = editorOptionsForLineCount(n);
      const again = editorOptionsForLineCount(n);
      expect(o.minimap, repr(n)).toEqual(again.minimap);
    }
    // 三档读数逐字照旧（large 仍写开——那一格是表的事实，偏好层关不关由 `editorDisplayOptionPatch` 说）
    expect(editorOptionsForLineCount(LARGE_FILE_LINES).minimap?.enabled).toBe(true);
    expect(editorOptionsForLineCount(HUGE_FILE_LINES).minimap?.enabled).toBe(false);
  });

  it('applySizeTier 只有一条出口：偏好层的关值盖得住，档位表不被改写', () => {
    const seen: EditorOptionPatch[] = [];
    const target = { updateOptions: (o: EditorOptionPatch) => void seen.push(o) };
    // 撤下预览后按原文行数落档，overrides 带 `.kojo` 正文的关值 ⇒ 终值必须是关
    applySizeTier(target, 800, editorDisplayOptionPatch(800, undefined, { kojoText: true }));
    expect(seen[0]?.minimap).toEqual({ enabled: false, renderCharacters: false, maxColumn: 72 });
    // 同一函数换个行数与上下文：档位表那一份仍然原样（表没被上次调用污染）
    applySizeTier(target, 800);
    expect(seen[1]?.minimap).toEqual({ enabled: true, renderCharacters: false, maxColumn: 72 });
    expect(editorOptionsForLineCount(800).minimap?.enabled).toBe(true);
  });

  it('档位表关掉的键 small 都写回（缩略图这条新增判据不许破那条不变式）', () => {
    expect(sizeTierKeysMissingFromSmall()).toEqual([]);
    expect(sizeTierKeys()).toContain('minimap');
  });
});
