/**
 * ERB **打字规范化**（on-type）· **触发行之前的整行前缀**接线单测（ERB-RANGE-WIRE 的活面）。
 *
 * > **ERB-PARITY G2（2026-10-31）**：本文件原先钉的是**多行选区**那条前缀腿（`resolveRange(1, n-1)`
 * > 拼整段前缀、`erbBodyRegionAtLineEnd` 探末态、落区里再前推到区首）。那一整条随 v1 的 ERB
 * > 区间注册一起删了——选区格式化现在由插件供方（`@kojo/plugin-erb-lang` 的 `erb-formatting`）
 * > 按"整篇 text + 行区间"作答，判据仍是同一份 `computeFormatEdits`，保护区照样一个字节都不动。
 * > **on-type 的前缀腿保留**（它是每次击键唯一需要块上下文的那条路），本文件改钉它。
 *
 * 钉四件事：
 * ① IF 体内的击键（该行有切片编辑）：前缀推进块状态机，层级按整篇腿算（不吃前缀 ⇒ 这一行会漏掉缩进修正）；
 * ①-b 免检通道的让路口径（模块头注写明的那一格）：**零切片编辑却在块里**的行，on-type 不为它
 *    付 O(前缀) 扫描 ⇒ 判零编辑；整篇腿在那一行仍有一条编辑，反证"不是规则修不动"；
 * ② 顶层击键：不带前缀（或前缀推不出层级）⇒ 与"只算这一行"逐字相同，原缩进不动；
 * ③ 保护区里的击键：数据表块体 / 死区一行都不改（前缀把末态掩码带进来了）；
 * ④ 编辑绝不越界：返回的编辑只落在触发行，行号/列/文本与整篇腿裁到该行逐字节相同。
 *
 * 全部 node 可跑（桩 monaco，同 `kojo-format-range.test.ts` 口径）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { computeFormatEdits } from '@kojo/plugin-kojo-sugar';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { installErbOnTypeFormatter } from '../src/monaco/kojo-format-range';

const formatOpts = {} as Monaco.languages.FormattingOptions;
const token = {} as Monaco.CancellationToken;

/**
 * IF 体内第 3 行行首是**全角空格**：切片判据先折它（免检通道不触发 ⇒ 前缀腿真的跑），
 * 块体层级（4 空格 = 第 2 行的缩进单位）只有前缀推得出来。
 */
const IF_BODY = ['IF X', '    PRINTFORMW 甲', '　PRINTFORMW 乙', 'ENDIF'];

/** 免检通道夹具：第 3 行半角 2 空格——切片视角"已经规范"（零切片编辑），块内该是 4 空格 */
const IF_BODY_CLEAN_SLICE = ['IF X', '    PRINTFORMW 甲', '  PRINTFORMW 乙', 'ENDIF'];

/** 假 model：`getLineContent` 给前缀行（on-type 的前缀腿逐行直读，不再向宿主取窗口） */
function fakeDoc(lines: readonly string[]) {
  const asks: { start: number; end: number }[] = [];
  const model = {
    getLanguageId: () => ERB_LANGUAGE_ID,
    getLineCount: () => lines.length,
    getLineMaxColumn: (l: number) => (lines[l - 1] ?? '').length + 1,
    getLineContent: (l: number) => lines[l - 1] ?? '',
    getValue: () => lines.join('\n'),
    getValueInRange: (r: Monaco.IRange) => {
      asks.push({ start: r.startLineNumber, end: r.endLineNumber });
      return lines.slice(r.startLineNumber - 1, r.endLineNumber).join('\n');
    },
    getAlternativeVersionId: () => 1,
  } as unknown as Monaco.editor.ITextModel;
  return { model, asks };
}

/** 装好 on-type 一枚：`resolve` = 整篇，`resolveRange` = 触发行那一行（与生产接线同款） */
function installOnType(lines: readonly string[]) {
  let provider: Monaco.languages.OnTypeFormattingEditProvider | null = null;
  const monaco = {
    languages: {
      registerOnTypeFormattingEditProvider: (_id: string, p: unknown) => {
        provider = p as Monaco.languages.OnTypeFormattingEditProvider;
        return { dispose: () => undefined };
      },
    },
  } as unknown as typeof Monaco;
  const doc = fakeDoc(lines);
  installErbOnTypeFormatter(monaco, {
    resolve: (m) => ({ text: m.getValue(), dialect: 'erb' as const }),
    resolveRange: (m, start, end) => ({
      text: m.getValueInRange({
        startLineNumber: start,
        startColumn: 1,
        endLineNumber: end,
        endColumn: m.getLineMaxColumn(end),
      }),
      dialect: 'erb' as const,
    }),
  });
  if (provider === null) throw new Error('on-type 供方没注册上');
  return { doc, onType: provider };
}

const asKeys = (out: readonly Monaco.languages.TextEdit[]): string[] =>
  out.map((e) => `${e.range.startLineNumber}:${e.range.startColumn}:${e.range.endColumn}:${e.text}`);

/** 整篇腿上该行的编辑（判据对照） */
const wholeKeys = (lines: readonly string[], line: number): string[] =>
  computeFormatEdits(lines.join('\n'), 'erb')
    .filter((e) => e.line === line)
    .map((e) => `${e.line}:${e.startColumn}:${e.endColumn}:${e.text}`);

const press = (
  onType: Monaco.languages.OnTypeFormattingEditProvider,
  model: Monaco.editor.ITextModel,
  lineNumber: number,
): Monaco.languages.TextEdit[] =>
  (onType.provideOnTypeFormattingEdits?.(
    model,
    { lineNumber, column: 2 } as Monaco.Position,
    ';',
    formatOpts,
    token,
  ) ?? []) as Monaco.languages.TextEdit[];

describe('ERB-ON-TYPE-WIRE · 触发行之前的整行前缀', () => {
  it('夹具自证：第 3 行的"改成 4 空格"只可能来自前缀（切片视角先折全角、判不出层级）', () => {
    // 免检通道夹具：半角 2 空格行在切片视角零编辑，整篇腿却有一条（块内该 4 空格）
    expect(computeFormatEdits(IF_BODY_CLEAN_SLICE[2]!, 'erb')).toEqual([]);
    expect(wholeKeys(IF_BODY_CLEAN_SLICE, 3)).toHaveLength(1);
    // 本批夹具：全角缩进行切片判据**有**编辑 ⇒ 前缀腿真的会跑
    expect(computeFormatEdits(IF_BODY[2]!, 'erb')).not.toEqual([]);
    expect(wholeKeys(IF_BODY, 3)).toHaveLength(1);
  });

  it('① IF 体内的击键（该行有切片编辑）：前缀推进块状态机，层级按整篇腿算', () => {
    const { doc, onType } = installOnType(IF_BODY);
    expect(asKeys(press(onType, doc.model, 3))).toEqual(['3:1:14:    PRINTFORMW 乙']);
    expect(asKeys(press(onType, doc.model, 3))).toEqual(wholeKeys(IF_BODY, 3));
    // 窗口取文**只碰触发行那一行**（两次击键各一次）：前缀行直读 model（`getLineContent`），
    // 不再向宿主另要一次 `(1, n-1)` 的整段窗口——那正是被删掉的 v1 多行前缀腿的白付。
    expect(doc.asks).toEqual([
      { start: 3, end: 3 },
      { start: 3, end: 3 },
    ]);
  });

  it('①-b 免检通道（模块头注写明的让路口径）：零切片编辑却在块里 ⇒ 判零，且只取触发行一行', () => {
    // 这不是缺陷复发，是 PS-4 单价前提的**那条线**：on-type 不为"切片已规范"的行付
    // O(前缀) 扫描；整篇腿（Shift+Alt+F）仍会把这一行修成 4 空格（上一条自证钉着）。
    const { doc, onType } = installOnType(IF_BODY_CLEAN_SLICE);
    expect(asKeys(press(onType, doc.model, 3))).toEqual([]);
    expect(wholeKeys(IF_BODY_CLEAN_SLICE, 3)).toHaveLength(1);
    // 免检 ≠ 免取文：触发行那一行仍取一次（`(1,2)` 那种前缀整段窗口一次都不许出现）
    expect(doc.asks).toEqual([{ start: 3, end: 3 }]);
  });

  it('② 顶层击键（第 1 行）：没有前缀，行为与"只算这一行"逐字相同', () => {
    const lines = ['  顶层二空格', 'X'];
    const { doc, onType } = installOnType(lines);
    // 顶层行保留原缩进（层级无从判起）⇒ 零编辑
    expect(asKeys(press(onType, doc.model, 1))).toEqual([]);
    expect(wholeKeys(lines, 1)).toEqual([]);
  });

  it('②-b 顶层击键（起点 > 1）：带了前缀也保留原缩进，一个字节不改', () => {
    const lines = [';　注释', '  顶层二空格'];
    const { doc, onType } = installOnType(lines);
    expect(asKeys(press(onType, doc.model, 2))).toEqual([]);
    expect(wholeKeys(lines, 2)).toEqual([]);
  });

  it('③ 保护区里的击键：数据表块体一行都不改（前缀把末态掩码带进来）', () => {
    const lines = ['PRINTDATA', '\u3000\u3000DATA \u3000表体', 'ENDDATA'];
    const { doc, onType } = installOnType(lines);
    // 裸看第 2 行是要折的（逐行规则看不见块体）——这条自证避免用例空转
    expect(computeFormatEdits(lines[1]!, 'erb')).not.toEqual([]);
    expect(asKeys(press(onType, doc.model, 2))).toEqual([]);
    expect(wholeKeys(lines, 2)).toEqual([]);
  });

  it('④ 编辑绝不越界（嵌套 IF）：行号 / 列 / 文本与整篇腿裁到该行逐字节相同', () => {
    const lines = ['IF X', '  IF Y', '  \u3000PRINTFORMW 乙', '  ENDIF', 'ENDIF'];
    const { doc, onType } = installOnType(lines);
    const out = asKeys(press(onType, doc.model, 3));
    expect(out).toEqual(wholeKeys(lines, 3));
    expect(out.length).toBeGreaterThan(0);
    for (const key of out) expect(Number(key.split(':')[0])).toBe(3);
  });
});