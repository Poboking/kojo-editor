/**
 * 选区格式化 + 打字规范化（T13）单测。
 *
 * 全部 node 可跑（桩 monaco，同 `kojo-format.test.ts` 口径），钉四件事：
 * (a) 裁剪层：区间外一条编辑都不许出现（含倒置区间、边界行、单行）；
 * (b) 等价性：ERB 形下"整篇算 + 按行裁剪" ≡ "把选区切出来单独算"逐字节相同
 *     （策略 b 的合法性钉子——规则长歪成跨行语义时这条先红）；
 * (c) 行内规范化正反例：缩进/注释区折半角、纯空白行归空；台词正文的 U+3000 不动；
 * (d) on-type：编辑只落触发字符所在那一行；行中 `;`（非整行注释）零编辑。
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { computeFormatEdits, type FormatEdit } from '@kojo/plugin-kojo-sugar';
import { FULLWIDTH_SPACE } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import {
  clipFormatEditsToLines,
  installRangeFormatter,
  ON_TYPE_TRIGGER_CHARACTERS,
  formatRangeEdits,
} from '../src/monaco/kojo-format-range';

const FW = FULLWIDTH_SPACE;

/** ERB 夹具：1 缩进全角、2 台词（行中全角＝要打印的字）、3 注释区全角、4 纯空白、5 无需改 */
const DOC_LINES = [`${FW}IF X`, `PRINTFORMW 　「呀」`, `;　注释　文`, `${FW}${FW}`, `ENDIF`];
const DOC = `${DOC_LINES.join('\n')}\n`;
const erbRequest = (text: string) => ({ text, dialect: 'erb' as const });

/** 行号区间内每行的旧内容（等价性用例的切片底料） */
function sliceText(lines: readonly string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join('\n');
}

describe('clipFormatEditsToLines · 区间裁剪', () => {
  const edits: FormatEdit[] = [
    { line: 1, startColumn: 1, endColumn: 2, text: 'a' },
    { line: 3, startColumn: 1, endColumn: 2, text: 'b' },
    { line: 5, startColumn: 1, endColumn: 2, text: 'c' },
  ];

  it('区间内的保留、区间外的滤掉（边界行含端点）', () => {
    expect(clipFormatEditsToLines(edits, 2, 3)).toEqual([{ line: 3, startColumn: 1, endColumn: 2, text: 'b' }]);
    expect(clipFormatEditsToLines(edits, 1, 5)).toEqual(edits);
  });

  it('倒置区间 ⇒ 空（宁可不做也不猜方向）', () => {
    expect(clipFormatEditsToLines(edits, 4, 2)).toEqual([]);
  });

  it('单行区间只留该行', () => {
    expect(clipFormatEditsToLines(edits, 5, 5)).toEqual([{ line: 5, startColumn: 1, endColumn: 2, text: 'c' }]);
  });
});

describe('formatRangeEdits · 等价性与不越界', () => {
  it('等价性：整篇算+裁剪 ≡ 区间切片单独算（逐行偏移后逐字节相同）——全区间扫描', () => {
    const lineCount = DOC_LINES.length;
    for (let start = 1; start <= lineCount; start++) {
      for (let end = start; end <= lineCount; end++) {
        const clipped = formatRangeEdits(erbRequest(DOC), start, end);
        const sliced = computeFormatEdits(sliceText(DOC_LINES, start, end), 'erb').map((e) => ({
          ...e,
          line: e.line + start - 1,
        }));
        expect(clipped).toEqual(sliced);
      }
    }
  });

  it('整篇有 3 行要改，选区只盖第 1 行 ⇒ 只有第 1 行的编辑（绝不越界）', () => {
    const out = formatRangeEdits(erbRequest(DOC), 1, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.line).toBe(1);
    expect(out[0]!.text).toBe('  IF X');
  });

  it('选区盖住的行全都无需改 ⇒ 空数组（无变化就是无变化）', () => {
    expect(formatRangeEdits(erbRequest(DOC), 5, 5)).toEqual([]);
  });

  it('行内规范化正例：缩进全角折 2 半角、注释区全角折 1 半角、纯空白行归空', () => {
    const out = formatRangeEdits(erbRequest(DOC), 3, 4);
    expect(out).toEqual([
      { line: 3, startColumn: 1, endColumn: DOC_LINES[2]!.length + 1, text: `; 注释 文` },
      { line: 4, startColumn: 1, endColumn: DOC_LINES[3]!.length + 1, text: '' },
    ]);
  });

  it('行内规范化反例：台词行中段的 U+3000 是要打印的字，选区盖住它也不动', () => {
    expect(formatRangeEdits(erbRequest(DOC), 2, 2)).toEqual([]);
  });

  it('CRLF 文本同样成立（换行符不属于规则层关心的事）', () => {
    const crlfLines = [`${FW}甲`, `乙`];
    const doc = crlfLines.join('\r\n');
    expect(formatRangeEdits(erbRequest(doc), 1, 1)).toEqual([
      { line: 1, startColumn: 1, endColumn: 3, text: '  甲' },
    ]);
  });
});

describe('installRangeFormatter · 装配与隔离', () => {
  interface Registered {
    kind: 'range' | 'onType';
    languageId: string;
    provider: Monaco.languages.DocumentRangeFormattingEditProvider &
      Partial<Monaco.languages.OnTypeFormattingEditProvider>;
  }

  function stubMonaco() {
    const registered: Registered[] = [];
    const disposed: string[] = [];
    const monaco = {
      languages: {
        registerDocumentRangeFormattingEditProvider(languageId: string, provider: unknown) {
          registered.push({ kind: 'range', languageId, provider: provider as Registered['provider'] });
          return { dispose: () => void disposed.push(languageId) };
        },
        registerOnTypeFormattingEditProvider(languageId: string, provider: unknown) {
          registered.push({ kind: 'onType', languageId, provider: provider as Registered['provider'] });
          return { dispose: () => void disposed.push(languageId) };
        },
      },
    } as unknown as typeof Monaco;
    return { monaco, registered, disposed };
  }

  function stubModel(text: string) {
    const lines = text.split(/\r\n|\r|\n/);
    return {
      getValue: () => text,
      getLineCount: () => lines.length,
      getLineMaxColumn: (lineNumber: number) => (lines[lineNumber - 1] ?? '').length + 1,
    } as unknown as Monaco.editor.ITextModel;
  }

  const formatOpts = {} as Monaco.languages.FormattingOptions;
  const token = {} as Monaco.CancellationToken;
  const range = (start: number, end: number) =>
    ({ startLineNumber: start, endLineNumber: end }) as unknown as Monaco.Range;
  const pos = (lineNumber: number, column = 1) => ({ lineNumber, column }) as Monaco.Position;

  it('只对 ERB 语言各注册一枚（区间 + onType）；dispose 全回收；触发字符就两个', () => {
    const { monaco, registered, disposed } = stubMonaco();
    const handle = installRangeFormatter(monaco, { resolve: () => null });
    expect(registered.map((r) => [r.kind, r.languageId])).toEqual([
      ['range', ERB_LANGUAGE_ID],
      ['onType', ERB_LANGUAGE_ID],
    ]);
    const onType = registered.find((r) => r.kind === 'onType')!;
    expect(onType.provider.autoFormatTriggerCharacters).toEqual(ON_TYPE_TRIGGER_CHARACTERS);
    expect(ON_TYPE_TRIGGER_CHARACTERS).toEqual([';', FW]);
    handle.dispose();
    expect(disposed).toEqual([ERB_LANGUAGE_ID, ERB_LANGUAGE_ID]);
  });

  it('区间 provider：宿主应答 ⇒ 返回该区间内的编辑；不带 eol 字段', () => {
    const { monaco, registered } = stubMonaco();
    installRangeFormatter(monaco, { resolve: (m) => erbRequest(m.getValue()) });
    const out = registered[0]!.provider.provideDocumentRangeFormattingEdits(
      stubModel(DOC),
      range(3, 4),
      formatOpts,
      token,
    ) as Monaco.languages.TextEdit[];
    expect(out.map((e) => e.range.startLineNumber)).toEqual([3, 4]);
    for (const e of out) expect(e.eol).toBeUndefined();
  });

  it('区间 provider：陈旧区间（行号超出文档）夹取，不抛错', () => {
    const { monaco, registered } = stubMonaco();
    installRangeFormatter(monaco, { resolve: (m) => erbRequest(m.getValue()) });
    const out = registered[0]!.provider.provideDocumentRangeFormattingEdits(
      stubModel(DOC),
      range(4, 99),
      formatOpts,
      token,
    ) as Monaco.languages.TextEdit[];
    // 第 4 行（纯空白）要归空；第 5 行 `ENDIF` 无需改 ⇒ 不产出"看起来有编辑"的空转
    expect(out.map((e) => e.range.startLineNumber)).toEqual([4]);
  });

  it('onType provider：整篇有三行可改，触发行只有一行 ⇒ 编辑只落那一行', () => {
    const { monaco, registered } = stubMonaco();
    installRangeFormatter(monaco, { resolve: (m) => erbRequest(m.getValue()) });
    const onType = registered.find((r) => r.kind === 'onType')!.provider;
    const out = onType.provideOnTypeFormattingEdits!(
      stubModel(DOC),
      pos(2, DOC_LINES[1]!.length + 2),
      FW,
      formatOpts,
      token,
    ) as Monaco.languages.TextEdit[];
    // 第 2 行是台词行：行中全角不动 ⇒ 这一触发零编辑（第 1/3 行的可改处不越界过来）
    expect(out).toEqual([]);
    const comment = onType.provideOnTypeFormattingEdits!(
      stubModel(DOC),
      pos(3, 2),
      FW,
      formatOpts,
      token,
    ) as Monaco.languages.TextEdit[];
    expect(comment).toHaveLength(1);
    expect(comment[0]!.range.startLineNumber).toBe(3);
    expect(comment[0]!.range.endLineNumber).toBe(3);
  });

  it('onType 反例：行中 `;` 不构成整行注释 ⇒ 零编辑（打字不乱跳）', () => {
    const { monaco, registered } = stubMonaco();
    installRangeFormatter(monaco, { resolve: (m) => erbRequest(m.getValue()) });
    const onType = registered.find((r) => r.kind === 'onType')!.provider;
    const out = onType.provideOnTypeFormattingEdits!(
      stubModel(`IF X; 备注`),
      pos(1, 6),
      ';',
      formatOpts,
      token,
    ) as Monaco.languages.TextEdit[];
    expect(out).toEqual([]);
  });

  it('onType 正例：`;` 成形整行注释 / 行首 U+3000 折 2 半角', () => {
    const { monaco, registered } = stubMonaco();
    installRangeFormatter(monaco, { resolve: (m) => erbRequest(m.getValue()) });
    const onType = registered.find((r) => r.kind === 'onType')!.provider;
    const semi = onType.provideOnTypeFormattingEdits!(
      stubModel(`;${FW}注`),
      pos(1, 2),
      ';',
      formatOpts,
      token,
    ) as Monaco.languages.TextEdit[];
    expect(semi).toHaveLength(1);
    expect(semi[0]!.text).toBe('; 注');
    const indent = onType.provideOnTypeFormattingEdits!(
      stubModel(`${FW}甲`),
      pos(1, 2),
      FW,
      formatOpts,
      token,
    ) as Monaco.languages.TextEdit[];
    expect(indent).toHaveLength(1);
    expect(indent[0]!.text).toBe('  甲');
  });

  it('宿主不应答（糖视图派生 model / 语言认不出）⇒ 两个 provider 都零编辑', () => {
    const { monaco, registered } = stubMonaco();
    installRangeFormatter(monaco, { resolve: () => null });
    const rangeOut = registered[0]!.provider.provideDocumentRangeFormattingEdits(
      stubModel(DOC),
      range(1, 5),
      formatOpts,
      token,
    );
    const onType = registered.find((r) => r.kind === 'onType')!.provider;
    const onTypeOut = onType.provideOnTypeFormattingEdits!(stubModel(DOC), pos(1, 1), ';', formatOpts, token);
    expect(rangeOut).toEqual([]);
    expect(onTypeOut).toEqual([]);
  });

  it('resolve 抛错 ⇒ 返回空、只 warn（不许掀编辑器的桌子）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco, registered } = stubMonaco();
    installRangeFormatter(monaco, {
      resolve: () => {
        throw new Error('boom');
      },
    });
    expect(
      registered[0]!.provider.provideDocumentRangeFormattingEdits(stubModel(DOC), range(1, 5), formatOpts, token),
    ).toEqual([]);
    const onType = registered.find((r) => r.kind === 'onType')!.provider;
    expect(onType.provideOnTypeFormattingEdits!(stubModel(DOC), pos(1, 1), ';', formatOpts, token)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
