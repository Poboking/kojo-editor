/**
 * EC-5 · `.erb` 系统函数名补全（`erbSystemFunctionCompletionItems`）单测。
 *
 * 不需要语料：词表真源 `SYSTEM_FUNCTION_REVERSE`（`kojo-sugar` 派生）在测试里真实生效。
 * 覆盖：表达式位 `GET` → 命中 `GETBIT`（`insertText` = `GETBIT(`、`kind` = Function、
 * `documentation` = `**英文名** ↔ 中文名`、替换范围 = 已输入词）；同表覆盖（`MATCH` /
 * `GETNUM` / `STRCOUNT` / `RAND` / `SETBIT` 在列）；前缀精确优先；注释行 / 指令行首（含
 * U+3000 全角空白缩进）/ 字符串内 / 词紧前 `$` → `[]`；空 model / 非法位置不抛。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { erbSystemFunctionCompletionItems } from '../src/monaco/erb-completion-system-functions';

/** 桩 Monaco：本纯函数只用到 CompletionItemKind.Function */
const monaco = { languages: { CompletionItemKind: { Function: 3 } } } as unknown as typeof Monaco;

const WORD_CHAR_RE = /[A-Za-z0-9_]/;

/** 复刻 Monaco `getWordUntilPosition`：光标处标识符段（含 `_`） */
function wordAt(line: string, col0: number): { word: string; startColumn: number; endColumn: number } {
  let s = col0;
  while (s > 0 && WORD_CHAR_RE.test(line[s - 1]!)) s--;
  let e = col0;
  while (e < line.length && WORD_CHAR_RE.test(line[e]!)) e++;
  return { word: line.slice(s, e), startColumn: s + 1, endColumn: e + 1 };
}

function modelOf(line: string): Monaco.editor.ITextModel {
  return {
    getLineContent: (lineNumber: number) => (lineNumber === 1 ? line : ''),
    getWordUntilPosition: (position: Monaco.Position) => wordAt(line, Math.min(position.column - 1, line.length)),
  } as unknown as Monaco.editor.ITextModel;
}

/** 用 `|` 标记光标（1 基列 = 标记前字符数 + 1）；无标记 = 光标在行尾 */
function at(marked: string): Monaco.languages.CompletionItem[] {
  const marker = marked.indexOf('|');
  const line = marked.replace('|', '');
  const column = (marker >= 0 ? marker : line.length) + 1;
  return erbSystemFunctionCompletionItems(monaco, modelOf(line), { lineNumber: 1, column } as Monaco.Position);
}

const labelsOf = (items: readonly Monaco.languages.CompletionItem[]): string[] => items.map((i) => i.label as string);
const itemOf = (items: readonly Monaco.languages.CompletionItem[], label: string): Monaco.languages.CompletionItem | undefined =>
  items.find((i) => i.label === label);

describe('EC-5 · 表达式位命中', () => {
  it('`PRINTFORML GET` → `GETBIT` 在列，`insertText` = `GETBIT(`', () => {
    const items = at('PRINTFORML GET|');
    const hit = itemOf(items, 'GETBIT');
    expect(hit).toBeDefined();
    expect(hit!.insertText).toBe('GETBIT(');
    expect(hit!.kind).toBe(monaco.languages.CompletionItemKind.Function);
  });

  it('`documentation` = `**英文名** ↔ 中文名`（带同源中文对照）', () => {
    expect(itemOf(at('PRINTFORML GET|'), 'GETBIT')!.documentation).toBe('**GETBIT** ↔ 获取标记');
    expect(itemOf(at('PRINTFORML STR|'), 'STRCOUNT')!.documentation).toBe('**STRCOUNT** ↔ 出现次数');
  });

  it('大小写不敏感：`get` → 命中 `GETBIT`（ERB 命令大小写不敏感）', () => {
    expect(labelsOf(at('PRINTFORML get|'))).toContain('GETBIT');
  });

  it('替换范围 = `getWordUntilPosition`（只覆盖已输入词）', () => {
    const [item] = at('PRINTFORML GET|');
    expect(item!.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 12, endColumn: 15 });
  });
});

describe('EC-5 · 同表覆盖（单一真源派生）', () => {
  it('空前缀（实参位）→ 全量候选含任务点名的系统函数', () => {
    const labels = labelsOf(at('PRINTFORML |'));
    for (const name of ['GETBIT', 'SETBIT', 'RAND', 'MATCH', 'GETNUM', 'STRCOUNT']) {
      expect(labels).toContain(name);
    }
  });

  it('排序受控：前缀精确命中 `0_` > 前缀命中 `1_` > 其它 `2_`', () => {
    const exact = itemOf(at('PRINTFORML GETBIT|'), 'GETBIT')!;
    expect(exact.sortText).toBe('0_GETBIT');
    const hits = at('PRINTFORML GET|');
    expect(itemOf(hits, 'GETBIT')!.sortText).toBe('1_GETBIT');
    expect(itemOf(hits, 'RAND')!.sortText).toBe('2_RAND');
  });
});

describe('EC-5 · 位置判据不满足 → []', () => {
  it('注释行（行首 `;`）→ []', () => {
    expect(at('; GET|')).toEqual([]);
    expect(at('  ; CALL GET|')).toEqual([]);
  });

  it('指令行首（词前全空白 = 行首指令位）→ []', () => {
    expect(at('PRINTFORM|')).toEqual([]);
    expect(at('GET|')).toEqual([]);
    expect(at('  GET|')).toEqual([]);
  });

  it('全角空格（U+3000）缩进的行首 → []（空白单源 isAllBlank，与 lexer 同集）', () => {
    expect(at('\u3000\u3000GET|')).toEqual([]);
    expect(at('\u3000PRINTFORM|')).toEqual([]);
    expect(at('\u3000\u3000; GET|')).toEqual([]);
  });

  it('词紧前一枚字符是 `$` → []（`$标签` 名字位）', () => {
    expect(at('$GET|')).toEqual([]);
    expect(at('\u3000\u3000$GET|')).toEqual([]);
    expect(at('$|')).toEqual([]);
  });

  it('行中 `$` 紧前同为本源防守（上层装配门另有收口，此处不产出亦无害）', () => {
    expect(at('PRINTFORML $GET|')).toEqual([]);
    expect(at('PRINTFORML $|')).toEqual([]);
  });

  it('`$` 不在紧前（已隔空白 / 词内）→ 不受影响', () => {
    expect(labelsOf(at('PRINTFORML $ GET|'))).toContain('GETBIT');
  });

  it('字符串字面量内（光标前 `"` 奇数）→ []', () => {
    expect(at('PRINTFORML "GET|')).toEqual([]);
  });

  it('非法位置（lineNumber < 1）→ [] 且不抛', () => {
    expect(erbSystemFunctionCompletionItems(monaco, modelOf('PRINTFORML GET'), { lineNumber: 0, column: 1 } as Monaco.Position)).toEqual([]);
    expect(erbSystemFunctionCompletionItems(monaco, modelOf('PRINTFORML GET'), { lineNumber: 1, column: 0 } as Monaco.Position)).toEqual([]);
  });

  it('空 model → [] 且不抛', () => {
    const empty = {
      getLineContent: () => '',
      getWordUntilPosition: () => ({ word: '', startColumn: 1, endColumn: 1 }),
    } as unknown as Monaco.editor.ITextModel;
    const pos = { lineNumber: 1, column: 1 } as Monaco.Position;
    expect(() => erbSystemFunctionCompletionItems(monaco, empty, pos)).not.toThrow();
    expect(erbSystemFunctionCompletionItems(monaco, empty, pos)).toEqual([]);
  });
});
