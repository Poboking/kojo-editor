/**
 * 代码字体三处同串（视觉批十一 · 收尾路 R2 · 债三）。
 *
 * 改前实况（L20 交付时点名的欠账）：主编辑器 create 时铺 `CODE_FONT_BASELINE` 之后再叠
 * `editorDisplayFontPatch`（= `resolveCodeFontStack` 的档位结果），而**比对窗与快修预览窗
 * 只铺那条缺省基线**。于是作者把代码档换成「更纱黑体等宽」，编辑器里换了字、
 * 那两屏仍是老栈——同一段代码在屏幕上以两种字面并排，读起来像字体坏了。
 *
 * 本闸的口径：**一条断言读三个出口**，比的是最终落进 Monaco 选项的那一串，
 * 不是"两边都 import 了同一个函数"这种间接话：
 *   ① 编辑器 = `{ ...CODE_FONT_BASELINE, ...editorDisplayFontPatch(prefs) }.fontFamily`
 *      （`editor-pane/use-monaco-instance.ts` 的 create 现场就是这两行的这个顺序，静态闸钉住）；
 *   ② 比对窗 = `{ ...CODE_FONT_BASELINE, ...overlayCodeFontPatch(prefs) }.fontFamily`
 *      （`DiffViewOverlay.tsx` 的 `createDiffEditor` 选项现场，静态闸钉住）；
 *   ③ 快修预览窗 = 同上现场（`QuickFixPreviewOverlay.tsx`）。
 * 三者逐字相等，且等于 `resolveCodeFontStack(prefs).stack`（生效链的唯一解析结果）。
 *
 * 静态那头另钉三件：
 *   - 两个浮层都**只在基线之后**叠这一枚补丁，别处不许再写 `fontFamily`（写了就是第四串）；
 *   - 装载走 `await import('./editor-display-prefs')` 的**动态边**——`QuickFixPreviewOverlay`
 *     静态挂在开机图里，静态 import 会把 editor-display-prefs 连同 editor-options 拽回首屏
 *     （PS-10 体积闸口径：只跟静态的有值依赖）；
 *   - 外观档 `overlayEditorAppearance` 的类型面**不含** `fontFamily`（它若含，叠在其后的顺序
 *     就会把字体盖掉——这条是"为什么叠在 appearance 之前也安全"的根）。
 *
 * 本文件待在默认 node 环境：只做纯函数与源码扫读，不起壳、不挂 React（真壳里的字形是否
 * 真的换了，归组长 `smoke-tauri-ipc` / 手工复验，不在本池自证）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CODE_FONT_BASELINE, CODE_FONT_STACK } from '../src/ui/code-font';
import { CODE_FONT_PRESETS, resolveCodeFontStack } from '../src/ui/font-presets';
import {
  EDITOR_DISPLAY_PREF_DEFAULT,
  editorDisplayFontPatch,
  overlayCodeFontPatch,
  type EditorDisplayPrefs,
} from '../src/ui/editor-display-prefs';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function prefs(over: Partial<EditorDisplayPrefs>): EditorDisplayPrefs {
  return { ...EDITOR_DISPLAY_PREF_DEFAULT, ...over };
}

/** 三个出口各自"算到最后一步"的读数（现场形态：基线垫底 + 档位补丁叠上） */
function threeOutlets(p: EditorDisplayPrefs): { editor: string; diff: string; quickFix: string } {
  const editor = { ...CODE_FONT_BASELINE, ...editorDisplayFontPatch(p) }.fontFamily ?? '';
  const diff = { ...CODE_FONT_BASELINE, ...overlayCodeFontPatch(p) }.fontFamily ?? '';
  const quickFix = { ...CODE_FONT_BASELINE, ...overlayCodeFontPatch(p) }.fontFamily ?? '';
  return { editor, diff, quickFix };
}

const OVERLAY_FILES = ['DiffViewOverlay.tsx', 'QuickFixPreviewOverlay.tsx'] as const;

describe('三处同串（一条断言读三个出口）', () => {
  it('每一档代码字体：编辑器 / 比对窗 / 快修预览读到的是同一串，且等于解析链的结果', () => {
    for (const preset of CODE_FONT_PRESETS) {
      if (preset.stack === '') continue; // custom 档没有表内栈，单独在下面按老文本验
      const p = prefs({ codeFontPreset: preset.id });
      const r = threeOutlets(p);
      expect(r.editor, preset.id).toBe(resolveCodeFontStack(p).stack);
      expect(r.diff, `${preset.id}：比对窗与编辑器不同串`).toBe(r.editor);
      expect(r.quickFix, `${preset.id}：快修预览与编辑器不同串`).toBe(r.editor);
    }
  });

  it('缺省档零漂移：三处都还是 CODE_FONT_STACK（没动字体项的作者逐字不变）', () => {
    const r = threeOutlets(prefs({}));
    expect(r).toEqual({ editor: CODE_FONT_STACK, diff: CODE_FONT_STACK, quickFix: CODE_FONT_STACK });
    expect(CODE_FONT_BASELINE.fontFamily).toBe(CODE_FONT_STACK);
  });

  it('老自由文本（兼容红线）也是同串：三处都吃那条文本，而不是各自的缺省栈', () => {
    const p = prefs({ fontFamily: 'Consolas, monospace', codeFontPreset: 'sarasa' });
    const r = threeOutlets(p);
    expect(r).toEqual({ editor: 'Consolas, monospace', diff: 'Consolas, monospace', quickFix: 'Consolas, monospace' });
  });

  it('坏栈不喂：浮层退回缺省基线，绝不发半坏值（护栏与主编辑器同一条）', () => {
    expect(overlayCodeFontPatch(prefs({ fontFamily: " 'Cascadia Code'," })).fontFamily).toBe(CODE_FONT_STACK);
    expect(overlayCodeFontPatch(prefs({ codeFontPreset: 'nope-id' })).fontFamily).toBe(CODE_FONT_STACK);
  });
});

describe('静态：两个浮层真的吃到这一枚（不是只在导出里躺着一个新函数）', () => {
  for (const file of OVERLAY_FILES) {
    it(`${file}：基线之后叠档位补丁，全文件再无第二处 fontFamily`, () => {
      const src = read(`../src/ui/${file}`);
      expect(src).toContain('...CODE_FONT_BASELINE,');
      expect(src).toMatch(/overlayCodeFontPatch/);
      // 现场形状：`...CODE_FONT_BASELINE,` 之后紧跟 `...codeFont,`
      const i = src.indexOf('...CODE_FONT_BASELINE,');
      expect(src.slice(i, i + 240)).toMatch(/\.\.\.CODE_FONT_BASELINE,\s*(\/\/[^\n]*\n\s*)?\.\.\.codeFont,/);
      // 这两个文件里**一个 fontFamily 都不许出现**：字族只来自基线 + 档位补丁，
      // 谁再手写第三串（哪怕只是"临时对齐一下"），这里当场红。
      expect(src.match(/fontFamily/g) ?? [], `${file} 里又手写了字族`).toHaveLength(0);
    });

    it(`${file}：装载走动态边（静态引 editor-display-prefs = 把 21.7 KB 拽回开机图）`, () => {
      const src = read(`../src/ui/${file}`);
      expect(src).toMatch(/await import\('\.\/editor-display-prefs'\)/);
      expect(src).not.toMatch(/\nimport\s[^\n]*from '\.\/editor-display-prefs'/);
    });
  }

  it('主编辑器那条 create 现场仍是"基线 + editorDisplayFontPatch"（①号出口的对证）', () => {
    const src = read('../src/ui/editor-pane/use-monaco-instance.ts');
    const i = src.indexOf('...CODE_FONT_BASELINE,');
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 700)).toMatch(/\.\.\.editorDisplayFontPatch\(\),/);
  });

  it('外观档类型面不含 fontFamily —— 叠在其前的字体补丁不会被它盖掉', () => {
    const src = read('../src/ui/overlay-editor-appearance.ts');
    expect(src).not.toMatch(/'fontFamily'/);
    expect(src).toMatch(/export type OverlayEditorAppearance = Pick<\s*EditorOptionPatch,\s*'padding' \| 'minimap' \| 'stickyScroll' \| 'renderLineHighlight' \| 'renderLineHighlightOnlyWhenFocus'/);
  });
});
