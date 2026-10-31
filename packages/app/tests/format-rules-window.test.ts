/**
 * 格式化规则开关 · **区间腿 / on-type 腿**的透传单测（P2-14 的漏接补齐）。
 *
 * 三条入口共用插件 `computeFormatEdits` / `computeRangeFormatEdits` 的规则核心，规则开关必须
 * **同一份口径**：
 * ① 区间腿（`formatRangeEdits`，纯函数）：`request.rules` → 插件第三参，结果 ≡ 插件算整篇后裁行；
 * ② on-type 腿（`installErbOnTypeFormatter` + `resolveRange`）：`request.rules` → 插件第三/四参，
 *    含单行击键与"块层级由前缀推出来"那一路；
 * ③ `rules` 缺省 ⇒ 与传 `{}`、与不传 options 三者逐字节相同（零回退钉子）。
 *
 * > **ERB-PARITY G2（2026-10-31）**：ERB 的**选区**格式化已移出宿主（插件供方作答，
 * > 判据同一份 `computeFormatEdits`，规则开关经请求的 `options` 递进去——那条链在
 * > `packages/plugins/erb-lang/tests/formatting.test.ts` 里钉）。本文件因此只钉宿主留下的
 * > 两条入口；多行选区与"前推锚点"那几组用例随 v1 区间注册一起删了。
 *
 * 契约层的东西一律在插件侧，本文件只钉"宿主有没有把请求里的开关交下去"。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { computeFormatEdits, computeRangeFormatEdits, type FormatEdit } from '@kojo/plugin-kojo-sugar';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import type { FormatRuleSwitches } from '../src/monaco/kojo-format';
import { formatRangeEdits, installErbOnTypeFormatter } from '../src/monaco/kojo-format-range';

const FW = '\u3000';

/**
 * 夹具自证过（见下面的 `夹具自证` 用例）：
 * - 第 2 行的 4 空格缩进是缩进单位的证据（否则 ERB 形整条缩进规则关掉）；
 * - 第 3–7 行是 IF 块：两条规则开关**各自**都能在这一段里改变结果；
 * - 第 6 行是带全角空格的整行注释（单行 on-type 只用得上全角折算这一条）；
 * - 第 8 行是只含全角空格的末行（空白清空归全角规则管）。
 */
const DOC_LINES = [
  'PRINTFORMW 顶',
  '    PRINTFORMW 参照',
  `${FW}IF X`,
  'PRINTFORMW 甲',
  `${FW}${FW}PRINTFORMW 乙`,
  `${FW};注释${FW}文`,
  'ENDIF',
  `${FW}${FW}`,
];
const DOC = DOC_LINES.join('\n');

const key = (edits: readonly FormatEdit[]): string[] =>
  edits.map((e) => `${e.line}:${e.startColumn}:${e.endColumn}:${e.text}`);

/** 插件口径的"整篇算 + 按行裁剪"（对照的唯一真源） */
const wholeClipped = (
  text: string,
  startLine: number,
  endLine: number,
  rules?: FormatRuleSwitches,
): string[] =>
  key(computeFormatEdits(text, 'erb', rules).filter((e) => e.line >= startLine && e.line <= endLine));

const asEdits = (out: readonly Monaco.languages.TextEdit[]): FormatEdit[] =>
  out.map((e) => ({
    line: e.range.startLineNumber,
    startColumn: e.range.startColumn,
    endColumn: e.range.endColumn,
    text: e.text,
  }));

/** 假 model：`getValueInRange` 按行切片（与宿主 `formatRequestWindowFor` 同形状） */
function fakeDoc(lines: readonly string[]) {
  return {
    getLanguageId: () => ERB_LANGUAGE_ID,
    getEOL: () => '\n' as const,
    getLineCount: () => lines.length,
    getLineMaxColumn: (l: number) => (lines[l - 1] ?? '').length + 1,
    getLineContent: (l: number) => lines[l - 1] ?? '',
    getValue: () => lines.join('\n'),
    getValueInRange: (r: Monaco.IRange) => lines.slice(r.startLineNumber - 1, r.endLineNumber).join('\n'),
    getAlternativeVersionId: () => 1,
  } as unknown as Monaco.editor.ITextModel;
}

interface Registered {
  kind: 'onType';
  provider: Monaco.languages.OnTypeFormattingEditProvider;
}

/** 与生产接线同款：`resolve` = 整篇，`resolveRange` = 窗口，两者带同一份 rules */
function installBoth(lines: readonly string[], rules?: FormatRuleSwitches) {
  const registered: Registered[] = [];
  const monaco = {
    languages: {
      registerOnTypeFormattingEditProvider: (_id: string, p: unknown) => {
        registered.push({ kind: 'onType', provider: p as Registered['provider'] });
        return { dispose: () => undefined };
      },
    },
  } as unknown as typeof Monaco;
  const model = fakeDoc(lines);
  installErbOnTypeFormatter(monaco, {
    resolve: (m) => ({ text: m.getValue(), dialect: 'erb' as const, rules }),
    resolveRange: (m, start, end) => ({
      text: m.getValueInRange({
        startLineNumber: start,
        startColumn: 1,
        endLineNumber: end,
        endColumn: m.getLineMaxColumn(end),
      }),
      dialect: 'erb' as const,
      rules,
    }),
  });
  return {
    model,
    onType: registered.find((r) => r.kind === 'onType')!.provider,
  };
}

const formatOnType = (
  provider: Registered['provider'],
  model: Monaco.editor.ITextModel,
  line: number,
  ch: string,
): Monaco.languages.TextEdit[] =>
  provider.provideOnTypeFormattingEdits!(
    model,
    { lineNumber: line, column: 2 } as Monaco.Position,
    ch,
    {} as Monaco.languages.FormattingOptions,
    {} as Monaco.CancellationToken,
  ) as Monaco.languages.TextEdit[];

describe('格式化规则开关 · 夹具自证', () => {
  it('两条规则各自都能在第 3–7 行这一段里改变结果（否则下面的断言不成立）', () => {
    const full = wholeClipped(DOC, 3, 7);
    expect(full.length).toBeGreaterThan(0);
    expect(wholeClipped(DOC, 3, 7, { fullWidthSpace: false })).not.toEqual(full);
    expect(wholeClipped(DOC, 3, 7, { indent: false })).not.toEqual(full);
  });
});

describe('① 区间腿（formatRangeEdits）· rules 透传', () => {
  it('关全角折算：区间 edits ≡ 插件算整篇后裁行，且与全开不同', () => {
    const off = key(formatRangeEdits({ text: DOC, dialect: 'erb', rules: { fullWidthSpace: false } }, 3, 7));
    expect(off).toEqual(wholeClipped(DOC, 3, 7, { fullWidthSpace: false }));
    expect(off).not.toEqual(wholeClipped(DOC, 3, 7));
  });

  it('关缩进：区间 edits ≡ 插件算整篇后裁行，且与全开不同', () => {
    const off = key(formatRangeEdits({ text: DOC, dialect: 'erb', rules: { indent: false } }, 3, 7));
    expect(off).toEqual(wholeClipped(DOC, 3, 7, { indent: false }));
    expect(off).not.toEqual(wholeClipped(DOC, 3, 7));
  });
});

describe('② on-type 腿（resolveRange）· rules 透传', () => {
  it('单行 on-type（第 6 行）：关全角折算 ⇒ 零编辑；全开 ⇒ 折算那一条', () => {
    const off = installBoth(DOC_LINES, { fullWidthSpace: false });
    expect(asEdits(formatOnType(off.onType, off.model, 6, FW))).toEqual([]);
    const on = installBoth(DOC_LINES);
    const onEdits = asEdits(formatOnType(on.onType, on.model, 6, FW));
    expect(onEdits).toHaveLength(1);
    expect(key(onEdits)).toEqual(wholeClipped(DOC, 6, 6));
  });

  it('单行 on-type 在 IF 块体内（第 5 行）：块层级由前缀推出来 ⇒ ≡ 整篇腿裁该行', () => {
    // 改前这条腿不吃前缀：切片判据看不见第 3 行开出来的 IF ⇒ 只折全角（2 空格），
    // 与整篇腿的块体缩进对不上。这条用例就是那个缺陷的红→绿钉子。
    const sliceOnly = key(
      computeRangeFormatEdits(DOC_LINES[4]!, 'erb').map((e) => ({
        ...e,
        line: 5,
      })),
    );
    const whole = wholeClipped(DOC, 5, 5);
    expect(whole).not.toEqual(sliceOnly);
    const { model, onType } = installBoth(DOC_LINES);
    expect(key(asEdits(formatOnType(onType, model, 5, FW)))).toEqual(whole);
  });

  it('单行 on-type 在块外（第 8 行空白 / 第 6 行注释）：结果与改前逐字相同', () => {
    for (const line of [6, 8]) {
      const before = key(
        computeRangeFormatEdits(DOC_LINES[line - 1]!, 'erb').map((e) => ({ ...e, line })),
      );
      const { model, onType } = installBoth(DOC_LINES);
      const after = key(asEdits(formatOnType(onType, model, line, FW)));
      expect(after).toEqual(before);
      expect(after).toEqual(wholeClipped(DOC, line, line));
    }
  });
});

describe('③ rules 缺省 · 零回退钉子（逐字节等价）', () => {
  it('区间腿：不传 rules ≡ 传 {} ≡ 传全开 ≡ 插件不传 options', () => {
    const noKey = key(formatRangeEdits({ text: DOC, dialect: 'erb' }, 3, 7));
    const empty = key(formatRangeEdits({ text: DOC, dialect: 'erb', rules: {} }, 3, 7));
    const full = key(
      formatRangeEdits({ text: DOC, dialect: 'erb', rules: { fullWidthSpace: true, indent: true } }, 3, 7),
    );
    const plugin = wholeClipped(DOC, 3, 7);
    expect(noKey).toEqual(empty);
    expect(noKey).toEqual(full);
    expect(noKey).toEqual(plugin);
  });

  it('on-type 腿：rules 缺省 / {} / 全开三种接线，击键结果逐字节相同', () => {
    const press = (rules?: FormatRuleSwitches) => {
      const { model, onType } = installBoth(DOC_LINES, rules);
      return key(asEdits(formatOnType(onType, model, 6, FW)));
    };
    const baseline = press();
    expect(press({})).toEqual(baseline);
    expect(press({ fullWidthSpace: true, indent: true })).toEqual(baseline);
  });
});