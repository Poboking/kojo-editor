/**
 * ERB 区间格式化 · **选区前整行前缀**接线（ERB-RANGE-WIRE）单测。
 *
 * 钉四件事：
 * ① IF 体内的选区：前缀推进块状态机，层级按整篇腿算（旧窗口腿看不见开词 ⇒ 会漏掉缩进修正）；
 * ② 顶层选区（从第 1 行起）：不取前缀，行为与"只算选区"逐字相同；
 * ③ CRLF 文档：前缀末行按文档 EOL（`getEOL()`）补行尾，不与选区首行粘连；
 * ④ 选区外的字节一个都不许变（区间格式化绝不能改选区外字节）。
 *
 * 全部 node 可跑（桩 monaco，同 `kojo-format-range.test.ts` 口径）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { applyFormatEdits, computeFormatEdits, type FormatEdit } from '@kojo/plugin-kojo-sugar';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { installRangeFormatter } from '../src/monaco/kojo-format-range';

const formatOpts = {} as Monaco.languages.FormattingOptions;
const token = {} as Monaco.CancellationToken;

/** IF 体内两行：第 2 行缩进正确、第 3 行少一半（只有前缀能判出它该改成 4 空格） */
const IF_BODY = ['IF X', '    PRINTFORMW 甲', '  PRINTFORMW 乙', 'ENDIF'];

interface Recorded {
  start: number;
  end: number;
}

/** 假 model：`getValueInRange` 按行切片（与宿主 `formatRequestWindowFor` 同形状），并记每次取文区间 */
function fakeDoc(lines: readonly string[], eol: '\n' | '\r\n' = '\n') {
  const asks: Recorded[] = [];
  const eolCalls = { count: 0 };
  const model = {
    getLanguageId: () => ERB_LANGUAGE_ID,
    getEOL: () => {
      eolCalls.count++;
      return eol;
    },
    getLineCount: () => lines.length,
    getLineMaxColumn: (l: number) => (lines[l - 1] ?? '').length + 1,
    getLineContent: (l: number) => lines[l - 1] ?? '',
    getValue: () => lines.join(eol),
    getValueInRange: (r: Monaco.IRange) => {
      asks.push({ start: r.startLineNumber, end: r.endLineNumber });
      // 与 Monaco 同口径：区间止于最后一列 ⇒ 不含末行行尾
      return lines.slice(r.startLineNumber - 1, r.endLineNumber).join(eol);
    },
    getAlternativeVersionId: () => 1,
  } as unknown as Monaco.editor.ITextModel;
  return { model, asks, eolCalls };
}

/** 两条腿都装好：`resolve` = 整篇，`resolveRange` = 窗口（与生产接线同款） */
function installBoth(lines: readonly string[], eol: '\n' | '\r\n' = '\n') {
  const reg: { kind: 'range' | 'onType'; provider: Monaco.languages.DocumentRangeFormattingEditProvider & Partial<Monaco.languages.OnTypeFormattingEditProvider> }[] = [];
  const monaco = {
    languages: {
      registerDocumentRangeFormattingEditProvider: (_id: string, p: unknown) => {
        reg.push({ kind: 'range', provider: p as (typeof reg)[number]['provider'] });
        return { dispose: () => undefined };
      },
      registerOnTypeFormattingEditProvider: (_id: string, p: unknown) => {
        reg.push({ kind: 'onType', provider: p as (typeof reg)[number]['provider'] });
        return { dispose: () => undefined };
      },
    },
  } as unknown as typeof Monaco;
  const doc = fakeDoc(lines, eol);
  installRangeFormatter(monaco, {
    resolve: (m) => ({ text: m.getValue(), dialect: 'erb' as const }),
    resolveRange: (m, start, end) => ({
      text: m.getValueInRange({ startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: m.getLineMaxColumn(end) }),
      dialect: 'erb' as const,
    }),
  });
  return {
    doc,
    range: reg.find((r) => r.kind === 'range')!.provider,
    onType: reg.find((r) => r.kind === 'onType')!.provider,
  };
}

const asKeys = (out: readonly Monaco.languages.TextEdit[]): string[] =>
  out.map((e) => `${e.range.startLineNumber}:${e.range.startColumn}:${e.range.endColumn}:${e.text}`);

/** 整篇腿上该区间的编辑（判据对照） */
const wholeKeys = (lines: readonly string[], startLine: number, endLine: number, eol = '\n'): string[] =>
  computeFormatEdits(lines.join(eol), 'erb')
    .filter((e) => e.line >= startLine && e.line <= endLine)
    .map((e) => `${e.line}:${e.startColumn}:${e.endColumn}:${e.text}`);

const formatRange = (
  provider: Monaco.languages.DocumentRangeFormattingEditProvider,
  model: Monaco.editor.ITextModel,
  startLine: number,
  endLine: number,
): Monaco.languages.TextEdit[] =>
  provider.provideDocumentRangeFormattingEdits(
    model,
    { startLineNumber: startLine, endLineNumber: endLine } as unknown as Monaco.Range,
    formatOpts,
    token,
  ) as Monaco.languages.TextEdit[];

describe('ERB-RANGE-WIRE · 选区前整行前缀', () => {
  it('夹具自证：不带前缀时这段选区判零编辑（前缀确实是这条用例的唯一来路）', () => {
    const sliced = computeFormatEdits(IF_BODY.slice(1, 3).join('\n'), 'erb');
    expect(sliced).toEqual([]);
  });

  it('① IF 体内的选区：前缀推进块状态机，少缩进的那行按层级修正', () => {
    const { doc, range } = installBoth(IF_BODY);
    const out = asKeys(formatRange(range, doc.model, 2, 3));
    expect(out).toEqual(['3:1:15:    PRINTFORMW 乙']);
    // 与整篇腿裁到该区间的结果逐字节相同
    expect(out).toEqual(wholeKeys(IF_BODY, 2, 3));
    // 前缀按整行取（末行带行尾由 provider 补）⇒ 问过 [1, 1]
    expect(doc.asks).toContainEqual({ start: 1, end: 1 });
  });

  it('② 顶层选区从第 1 行起：不取前缀，行为与只算选区逐字相同', () => {
    const TOP = ['    PRINTFORMW 顶层缩进保留', 'PRINTFORMW 第二行'];
    const { doc, range } = installBoth(TOP);
    expect(asKeys(formatRange(range, doc.model, 1, 2))).toEqual([]);
    // 顶层保留原缩进 ⇒ 零编辑；且从篇首起没有前缀可取
    expect(doc.asks).toEqual([{ start: 1, end: 2 }]);
  });

  it('②-b 顶层选区（起点 > 1）：带了前缀也保留原缩进，一个字节不改', () => {
    const TOP = ['PRINTFORMW 第一行', '    PRINTFORMW 顶层缩进保留'];
    const { doc, range } = installBoth(TOP);
    expect(asKeys(formatRange(range, doc.model, 2, 2))).toEqual([]);
    // 单行零编辑走免检通道 ⇒ 连前缀都不问（PS-4 的单价前提）
    expect(doc.asks).toEqual([{ start: 2, end: 2 }]);
  });

  it('③ CRLF 文档：前缀末行按文档 EOL 补行尾，不与选区首行粘连', () => {
    const { doc, range } = installBoth(IF_BODY, '\r\n');
    const out = asKeys(formatRange(range, doc.model, 2, 3));
    expect(out).toEqual(['3:1:15:    PRINTFORMW 乙']);
    expect(out).toEqual(wholeKeys(IF_BODY, 2, 3, '\r\n'));
    // 行尾口径按文档来（`getEOL()`）⇒ provider 必须问过它
    expect(doc.eolCalls.count).toBeGreaterThan(0);
  });

  it('④ 选区外的字节不变：编辑只覆盖选区行，落回文本后其余行逐字相同', () => {
    const { doc, range } = installBoth(IF_BODY);
    const edits = formatRange(range, doc.model, 2, 3);
    for (const e of edits) {
      expect(e.range.startLineNumber).toBeGreaterThanOrEqual(2);
      expect(e.range.endLineNumber).toBeLessThanOrEqual(3);
    }
    const asFormatEdits: FormatEdit[] = edits.map((e) => ({
      line: e.range.startLineNumber,
      startColumn: e.range.startColumn,
      endColumn: e.range.endColumn,
      text: e.text,
    }));
    const applied = applyFormatEdits(IF_BODY.join('\n'), asFormatEdits).split('\n');
    expect(applied[0]).toBe(IF_BODY[0]);
    expect(applied[1]).toBe(IF_BODY[1]);
    expect(applied[3]).toBe(IF_BODY[3]);
    expect(applied[2]).toBe('    PRINTFORMW 乙');
  });

  it('`.kojo` 方言不传前缀：窗口腿被方言闸挡下，交回整篇那条腿', () => {
    const reg: Monaco.languages.DocumentRangeFormattingEditProvider[] = [];
    const monaco = {
      languages: {
        registerDocumentRangeFormattingEditProvider: (_id: string, p: unknown) => {
          reg.push(p as Monaco.languages.DocumentRangeFormattingEditProvider);
          return { dispose: () => undefined };
        },
        registerOnTypeFormattingEditProvider: () => ({ dispose: () => undefined }),
      },
    } as unknown as typeof Monaco;
    const doc = fakeDoc(IF_BODY);
    installRangeFormatter(monaco, {
      resolve: (m) => ({ text: m.getValue(), dialect: 'kojo' as const }),
      resolveRange: (m, start, end) => ({
        text: m.getValueInRange({ startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: m.getLineMaxColumn(end) }),
        dialect: 'kojo' as const,
      }),
    });
    const out = asKeys(formatRange(reg[0]!, doc.model, 2, 3));
    expect(out).toEqual(
      computeFormatEdits(IF_BODY.join('\n'), 'kojo')
        .filter((e) => e.line >= 2 && e.line <= 3)
        .map((e) => `${e.line}:${e.startColumn}:${e.endColumn}:${e.text}`),
    );
    // 只问了一次窗口（方言闸之后不再问前缀）
    expect(doc.asks).toEqual([{ start: 2, end: 3 }]);
  });
});
