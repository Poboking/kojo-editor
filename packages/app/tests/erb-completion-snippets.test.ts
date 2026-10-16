/**
 * R4 · `.erb` snippet 块骨架单测：行首门、成对闭合骨架、与 `erb-directives`
 * 纯文本项的去重（行首只留骨架、行中纯文本照旧）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { ERB_COMPLETION_SOURCES, installErbCompletion } from '../src/monaco/erb-completion';

interface Registered {
  languageId: string;
  provider: Monaco.languages.CompletionItemProvider;
}

function stubMonaco(): { monaco: typeof Monaco; registered: Registered[] } {
  const registered: Registered[] = [];
  const monaco = {
    languages: {
      CompletionItemKind: { Keyword: 2, Function: 4, EnumMember: 5, Snippet: 15 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: (
        languageId: string,
        provider: Monaco.languages.CompletionItemProvider,
      ): Monaco.IDisposable => {
        registered.push({ languageId, provider });
        return { dispose: () => undefined };
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, registered };
}

function modelOf(text: string, word = '', startColumn = 1): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  return {
    getValue: () => text,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
    getWordUntilPosition: () => ({ word, startColumn, endColumn: startColumn + word.length }),
  } as unknown as Monaco.editor.ITextModel;
}

function labelText(label: Monaco.languages.CompletionItem['label']): string {
  return typeof label === 'string' ? label : label.label;
}

function provide(
  provider: Monaco.languages.CompletionItemProvider,
  text: string,
  word = '',
  column = 1,
  startColumn = 1,
): Monaco.languages.CompletionItem[] {
  const out = provider.provideCompletionItems(
    modelOf(text, word, startColumn),
    { lineNumber: 1, column } as Monaco.Position,
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  ) as unknown as Monaco.languages.CompletionList;
  return out.suggestions;
}

const asm = stubMonaco();
installErbCompletion(asm.monaco, () => ({}));
const provider = asm.registered[0]!.provider;

describe('erb-snippet source · 控制流块骨架', () => {
  it('注册在扩展点最前；只在 ERB 语言装配', () => {
    expect(ERB_COMPLETION_SOURCES[0]!.id).toBe('erb-snippet');
    expect(asm.registered).toHaveLength(1);
    expect(asm.registered[0]!.languageId).toBe(ERB_LANGUAGE_ID);
  });

  it('行首弹 IF 骨架：成对闭合（IF/ENDIF）+ InsertAsSnippet + 条件占位', () => {
    const items = provide(provider, 'IF', 'IF', 1);
    const hit = items.find((i) => labelText(i.label) === 'IF');
    expect(hit).toBeDefined();
    expect(hit!.insertTextRules).toBe(4);
    expect(hit!.insertText).toBe('IF ${1:条件}\n$2\nENDIF$0');
  });

  it('IF-ELSE 完整骨架在列（label 不同不互斥，前缀 IF 双命中）', () => {
    const items = provide(provider, 'IF', 'IF', 1);
    const alt = items.find((i) => labelText(i.label) === 'IF-ELSE');
    expect(alt).toBeDefined();
    expect(alt!.insertText).toContain('\nELSE\n');
  });

  it('SELECTCASE / FOR / WHILE 骨架成对闭合', () => {
    const items = provide(provider, '', '', 1);
    const sel = items.find((i) => labelText(i.label) === 'SELECTCASE');
    expect(sel!.insertText).toContain('ENDSELECT$0');
    expect(sel!.insertText).toContain('CASE ${2:值}');
    const loop = items.find((i) => labelText(i.label) === 'WHILE');
    expect(loop!.insertText).toContain('WEND$0');
    const forLoop = items.find((i) => labelText(i.label) === 'FOR');
    expect(forLoop!.insertText).toContain('\nNEXT$0');
    expect(forLoop!.insertText).toContain('${1:变量}, ${2:起始}, ${3:结束}, ${4:步进}');
  });

  it('骨架不带缩进（ERB 原文语料口径不缩进）', () => {
    for (const s of provide(provider, '', '', 1).filter((i) => i.insertTextRules === 4)) {
      expect(s.insertText).not.toMatch(/\n[ \t]/);
    }
  });

  it('去重：行首 `IF` 只有一条且是骨架（纯文本指令项被顶掉）', () => {
    const items = provide(provider, 'IF', 'IF', 1).filter((i) => labelText(i.label) === 'IF');
    expect(items).toHaveLength(1);
    expect(items[0]!.insertTextRules).toBe(4);
  });

  it('行中门：行中位置的 `IF` 是纯文本关键字（骨架不出）——桩词位对齐真实 Monaco', () => {
    // `X = IF`：`IF` 在列 5..6（1 基），光标停词尾（列 7）
    const items = provide(provider, 'X = IF', 'IF', 7, 5);
    const hit = items.find((i) => labelText(i.label) === 'IF');
    expect(hit).toBeDefined();
    expect(hit!.insertTextRules).toBeUndefined();
    expect(hit!.insertText).toBe('IF');
  });
});
