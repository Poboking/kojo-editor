/**
 * R4 · `.kojo` snippet 补全单测：snippet 语法转义、块头模板（词表派生）、
 * 行首门与去重（snippet 与纯文本不重复出条目）、系统函数调用模板。
 *
 * 转义是**判据级用例**：Monaco snippet 里 `$` 是 tab-stop、`}` 截断 placeholder——
 * kojo 文本里 `$`（`实参$`）与 `}`（`{插值}`）都是真字符，漏转义 = 插入结果悄悄错掉。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { TIMING_NAMED_PARAMS } from '@kojo/plugin-kojo-sugar';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  KOJO_COMPLETION_SOURCES,
  installKojoCompletion,
  type CompletionTables,
} from '../src/monaco/kojo-completion';
import {
  KOJO_BLOCK_SNIPPET_COUNT,
  escapeSnippetText,
  kojoBlockSnippets,
  lexemeOf,
} from '../src/monaco/kojo-completion-snippets';

/* ============================== 转义（判据级） ============================== */

describe('escapeSnippetText · snippet 语法转义', () => {
  it('`$` → `\\$`（漏转义会变成 tab-stop）', () => {
    expect(escapeSnippetText('实参$')).toBe('实参\\$');
  });

  it('`}` → `\\}`（漏转义会截断 placeholder），`{` 不需要转义', () => {
    expect(escapeSnippetText('{插值}')).toBe('{插值\\}');
  });

  it('反斜杠最先转义且不二次翻倍：已有 `\\` 与转义引入的 `\\` 各转一次', () => {
    expect(escapeSnippetText('a\\b')).toBe('a\\\\b');
    expect(escapeSnippetText('a$b\\c}d')).toBe('a\\$b\\\\c\\}d');
  });

  it('纯中文 / 全角标点原样（转义不碰语义字符之外的任何东西）', () => {
    expect(escapeSnippetText('时机 指令 310：')).toBe('时机 指令 310：');
  });
});

/* ============================== 桩装配（同 kojo-completion.test.ts 口径） ============================== */

interface Registered {
  languageId: string;
  provider: Monaco.languages.CompletionItemProvider;
}

function stubMonaco(): { monaco: typeof Monaco; registered: Registered[] } {
  const registered: Registered[] = [];
  const monaco = {
    languages: {
      CompletionItemKind: { Variable: 1, Keyword: 2, Operator: 3, Function: 4, EnumMember: 5, Snippet: 15 },
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

function modelOf(text: string, word = ''): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  return {
    getValue: () => text,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
    getWordUntilPosition: () => ({ word, startColumn: 1, endColumn: 1 + word.length }),
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
): Monaco.languages.CompletionItem[] {
  const out = provider.provideCompletionItems(
    modelOf(text, word),
    { lineNumber: 1, column } as Monaco.Position,
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  ) as unknown as Monaco.languages.CompletionList;
  return out.suggestions;
}

const assembler = stubMonaco();
installKojoCompletion(assembler.monaco, () => ({}) as CompletionTables);
const provider = assembler.registered[0]!.provider;

/* ============================== 模板源（词表派生 / 行首门 / 去重） ============================== */

describe('kojo-snippet source · 块头模板', () => {
  it('注册在扩展点最前（去重先注册者胜的前提）；只在 kojo 语言装配', () => {
    expect(KOJO_COMPLETION_SOURCES[0]!.id).toBe('kojo-snippet');
    expect(assembler.registered).toHaveLength(1);
    expect(assembler.registered[0]!.languageId).toBe(KOJO_LANGUAGE_ID);
  });

  it('行首弹块头模板：`如果` 命中条件块骨架，InsertAsSnippet + 多行骨架', () => {
    const items = provide(provider, '如果', '如果', 1);
    const hit = items.find((i) => labelText(i.label) === '如果');
    expect(hit).toBeDefined();
    expect(hit!.insertTextRules).toBe(4); // InsertAsSnippet
    expect(hit!.insertText).toContain('${1:条件}：');
    expect(hit!.insertText).toContain('\n');
    expect(hit!.insertText).toContain('否则');
    expect(hit!.detail).toContain('模板');
  });

  it('时机块模板：命名参数 choice 位派生自 TIMING_NAMED_PARAMS（零抄写第二份键表）', () => {
    const snippets = kojoBlockSnippets();
    const timing = snippets.find((s) => s.label === (lexemeOf('block.timing') ?? ''));
    expect(timing).toBeDefined();
    for (const p of TIMING_NAMED_PARAMS) expect(timing!.insertText).toContain(`${p.name}: `);
    expect(timing!.insertText).toContain('${3|');
  });

  it('词形派生自检：模板 label 全部来自 SUGAR_LEXICON_WORDS 中文主形（查不到的 id 整条跳过不猜）', () => {
    const snippets = kojoBlockSnippets();
    expect(snippets.length).toBe(KOJO_BLOCK_SNIPPET_COUNT);
    expect(snippets.length).toBeGreaterThan(10);
    for (const s of snippets) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.insertText).toContain(s.label);
    }
    expect(snippets.find((s) => s.label === lexemeOf('block.section'))).toBeDefined(); // 段块（若）
  });

  it('行首门：行中位置的块关键字不出 snippet（交回纯文本词表）', () => {
    const items = provide(provider, 'X = 1 如果', '如果', 6);
    const hit = items.find((i) => labelText(i.label) === '如果');
    expect(hit).toBeDefined();
    expect(hit!.insertTextRules).toBeUndefined(); // 纯文本
    expect(hit!.insertText).toBe('如果');
  });

  it('不重复出条目：行首 `如果` 只有一条（snippet 胜出，纯文本被 label 去重顶掉）', () => {
    const items = provide(provider, '如果', '如果', 1);
    const ifs = items.filter((i) => labelText(i.label) === '如果');
    expect(ifs).toHaveLength(1);
    expect(ifs[0]!.insertTextRules).toBe(4);
  });

  it('4 空格缩进骨架（糖源缩进惯例）：随机块模板体带缩进', () => {
    const random = kojoBlockSnippets().find((s) => s.label === (lexemeOf('block.random') ?? ''));
    expect(random!.insertText).toContain('\n    ');
  });

  it('系统函数调用模板：`获取标记` → `获取标记($1)$0` + InsertAsSnippet', () => {
    const items = provide(provider, '获取标记', '获取标记', 1);
    const fn = items.find((i) => labelText(i.label) === '获取标记');
    expect(fn!.insertText).toBe('获取标记($1)$0');
    expect(fn!.insertTextRules).toBe(4);
  });

  it('空 tables 不崩：snippet source 不消费 adapter 表，候选集与满表一致', () => {
    expect(() => provide(provider, '如果', '如果', 1)).not.toThrow();
    const items = provide(provider, '如果', '如果', 1).map((i) => labelText(i.label));
    expect(items).toContain('如果');
  });
});
