import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CODE_FONT_BASELINE,
  CODE_FONT_CSS_LINE,
  CODE_FONT_CSS_TOKEN,
  CODE_FONT_FULLWIDTH_CELL,
  CODE_FONT_LETTER_SPACING,
  CODE_FONT_LIGATURES,
  CODE_FONT_STACK,
  assertCodeFontStack,
  isUsableCodeFontStack,
} from '../src/ui/code-font';
import { HUGE_FILE_LINES, LARGE_FILE_LINES, editorOptionsForLineCount } from '../src/ui/editor-options';

/**
 * 编程字体单一真源。字体这种"看着无所谓"的东西最容易三处各写一份（Monaco 走平台默认栈、
 * `--font-mono` 一份、散装 `Consolas, ...` 八份），所以这里一半断言在做**逐字镜像核对**：
 * 读源码比对，不依赖 DOM（本池 environment 是 node）。vendor 取证口径照 `editor-options.test.ts`。
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const css = () => read('../src/styles.css');
const FONT_KEYS = Object.keys(CODE_FONT_BASELINE).sort();

describe('单一真源 · CSS 与 TS 逐字镜像', () => {
  it('styles.css 的 :root 必须原样带着 CODE_FONT_CSS_LINE 这一行', () => {
    expect(css()).toContain(CODE_FONT_CSS_LINE);
    expect(CODE_FONT_CSS_LINE.startsWith(`${CODE_FONT_CSS_TOKEN}: `)).toBe(true);
  });

  it('散装字面量清零：CSS 里不许再有 `font-family: Consolas…` 这种自带栈的声明', () => {
    expect(css().match(/font-family:\s*Consolas/g), '散装 font-family 声明').toBeNull();
  });

  it('--font-mono 的值不动（约 30 处既有消费方零改动，它只是"没分档年代的默认档"）', () => {
    expect(css()).toContain("--font-mono: Consolas, 'Cascadia Mono', 'JetBrains Mono', monospace;");
  });
});

describe('CODE_FONT_STACK 的形状（回落路径必须成立）', () => {
  const members = CODE_FONT_STACK.split(',').map((m) => m.trim());

  it('成员无空位、末位是泛型 monospace（空家族 = 整条声明失效）', () => {
    for (const m of members) expect(m).not.toBe('');
    expect(members.at(-1)).toBe('monospace');
    expect(isUsableCodeFontStack(CODE_FONT_STACK)).toBe(true);
    expect(() => assertCodeFontStack(CODE_FONT_STACK)).not.toThrow();
  });

  it('空串 / 纯空白 / 尾逗号一律判不可用（Monaco 只挡非字符串，空串会污染平台默认追加）', () => {
    for (const bad of ['', '   ', " 'Cascadia Code',"]) {
      expect(isUsableCodeFontStack(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(() => assertCodeFontStack('')).toThrow();
  });

  it('含 Windows 一定有的等宽底线，且拉丁头排在它前面', () => {
    expect(members).toContain('Consolas');
    expect(members.indexOf("'Cascadia Code'")).toBeLessThan(members.indexOf('Consolas'));
  });

  it('中文字面一律排在拉丁面之后（反了拉丁会被中文面自带的半比例拉丁接管，等宽就废）', () => {
    const cjkFirst = members.findIndex((m) => m === "'Era Mono SC'" || m === "'Microsoft YaHei'");
    expect(cjkFirst).toBeGreaterThan(members.indexOf('Consolas'));
    expect(cjkFirst).toBeGreaterThan(members.indexOf("'Cascadia Code'"));
  });

  it('含空格 / 非 ASCII 的家族名一律带引号（CSS 语法）', () => {
    for (const m of members) {
      if (/ /.test(m) || !/^[\x00-\x7f]*$/.test(m)) expect(m, m).toMatch(/^'.*'$/);
    }
  });
});

describe('CODE_FONT_BASELINE 的边界（不碰 A1、不进降级集）', () => {
  it('键集合精确 = 字体五键；fontSize / lineHeight / zoomLevel 一个都不进', () => {
    expect(CODE_FONT_BASELINE).toEqual({
      fontFamily: CODE_FONT_STACK,
      fontLigatures: CODE_FONT_LIGATURES,
      fontVariations: false,
      letterSpacing: CODE_FONT_LETTER_SPACING,
      fullwidthCharacterWidth: CODE_FONT_FULLWIDTH_CELL,
    });
    expect(FONT_KEYS).toEqual([
      'fontFamily',
      'fontLigatures',
      'fontVariations',
      'fullwidthCharacterWidth',
      'letterSpacing',
    ]);
  });

  it('全档降级集都不含任何字体键（字体与体量两轴正交）', () => {
    for (const n of [1, 4_999, LARGE_FILE_LINES, HUGE_FILE_LINES, 990_000]) {
      const keys = Object.keys(editorOptionsForLineCount(n));
      for (const k of FONT_KEYS) expect(keys, `${k}@${n}`).not.toContain(k);
      expect(keys).not.toContain('fontSize');
      expect(keys).not.toContain('zoomLevel');
    }
  });

  it('两条实例创建路径都 spread 同一份基线（少一条就是"那面没设计过"）', () => {
    expect(read('../src/ui/EditorPane.tsx')).toContain('...CODE_FONT_BASELINE,');
    expect(read('../src/ui/DiffViewOverlay.tsx')).toContain('...CODE_FONT_BASELINE,');
  });
});

/** vendor 取证：选项名与合法值一律以 monaco-editor@0.57.0 在册文本为准，不许凭记忆写 */
describe('vendor 实测（0.57）', () => {
  const dts = read('../node_modules/monaco-editor/monaco.d.ts');
  const editorOptions = read('../node_modules/monaco-editor/esm/vs/editor/common/config/editorOptions.js');
  const fontMeasurements = read('../node_modules/monaco-editor/esm/vs/editor/browser/config/fontMeasurements.js');
  const fontInfo = read('../node_modules/monaco-editor/esm/vs/editor/common/config/fontInfo.js');

  it('字体五键全在 IEditorOptions 面上；fontInformation 这名字根本不存在（无可钉入口）', () => {
    expect(dts).toContain("fullwidthCharacterWidth?: 'font' | 'twoCells'");
    expect(dts).toContain('fontLigatures?: boolean | string');
    expect(dts).toContain('fontVariations?: boolean | string');
    expect(dts).toContain('letterSpacing?: number');
    expect(dts).not.toContain('fontInformation');
  });

  it('连字关掉是 twoCells 生效的前提：OFF 串正是 isMonospace 的判据', () => {
    expect(editorOptions).toContain('\'"liga" off, "calt" off\'');
    expect(fontMeasurements).toContain('bareFontInfo.fontFeatureSettings === EditorFontLigatures.OFF');
  });

  it('缺字体的兜底是 monaco 自己追加平台默认栈（不是我们的选项，只需别喂空串）', () => {
    expect(fontInfo).toContain('getMassagedFontFamily');
    expect(fontInfo).toContain('DEFAULT_WINDOWS_FONT_FAMILY');
  });
});
