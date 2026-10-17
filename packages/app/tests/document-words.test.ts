/**
 * QSUG-2 · 文档词补全（`wordBasedSuggestions` 语义）单测。
 *
 * 判据三层：
 * ① **取词面**：`.kojo` 台词 / 旁白 / 心形正文 / 注释不进索引；`.erb` 的 `;` 注释与
 *    双引号字符串内容不进索引；前缀 / 空词 / 精确同名 / 上限 / 大文件各有护栏；
 * ② **位置门**：`.kojo` 的变量插值、`调用`/`函数` 名槽、时机块头、`是 <值>` 不出词；
 * ③ **装配面**：开关关闭 ⇒ 零候选；开关打开 ⇒ 台词行整轮零候选、代码表达式位出货；
 *    词源与上下文候选同名时只留一条（先注册者胜）。`.erb` 专用名槽由 keep 白名单整路滤掉。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import {
  MAX_DOCUMENT_WORD_SUGGESTIONS,
  WORD_SUGGESTIONS_MAX_LINES,
  documentWordItems,
} from '../src/monaco/document-words';
import { kojoWordCandidateAt, kojoWordCompletionItems } from '../src/monaco/kojo-completion-words';
import { installKojoCompletion } from '../src/monaco/kojo-completion';
import { installErbCompletion } from '../src/monaco/erb-completion';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';

/* ============================== 桩 ============================== */

interface Registered {
  readonly languageId: string;
  readonly provider: Monaco.languages.CompletionItemProvider;
}

let registered: Registered[] = [];

const MONACO = {
  languages: {
    CompletionItemKind: {
      Text: 18,
      Variable: 1,
      Keyword: 2,
      Operator: 3,
      Function: 4,
      Field: 5,
      Reference: 21,
      EnumMember: 7,
      Property: 8,
      Snippet: 9,
    },
    registerCompletionItemProvider: (
      languageId: string,
      provider: Monaco.languages.CompletionItemProvider,
    ): Monaco.IDisposable => {
      registered.push({ languageId, provider });
      return { dispose: () => undefined };
    },
  },
} as unknown as typeof Monaco;

/** 桩 model：行数 / 行文本 / 版本号 / 语言 / 词法（含 CJK，口径与真实 `wordPattern` 同向） */
function modelOf(
  text: string,
  opts: { languageId?: string; version?: number } = {},
): Monaco.editor.ITextModel & { bump: () => void; push: (line: string) => void } {
  const lines = text.split('\n');
  let version = opts.version ?? 1;
  const model = {
    getValue: () => text,
    getLineCount: () => lines.length,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
    getVersionId: () => version,
    getLanguageId: () => opts.languageId ?? KOJO_LANGUAGE_ID,
    getWordUntilPosition: (pos: Monaco.Position) => {
      const line = lines[pos.lineNumber - 1] ?? '';
      const before = line.slice(0, Math.max(0, pos.column - 1));
      const m = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff21-\uff3a\uff41-\uff5a0-9A-Za-z_$]*$/.exec(
        before,
      );
      const word = m?.[0] ?? '';
      return { word, startColumn: pos.column - word.length, endColumn: pos.column };
    },
    bump: () => {
      version++;
    },
    push: (line: string) => {
      lines.push(line);
    },
  };
  return model as unknown as Monaco.editor.ITextModel & { bump: () => void; push: (line: string) => void };
}

function rangeOf(model: Monaco.editor.ITextModel, position: Monaco.Position): Monaco.IRange {
  const word = model.getWordUntilPosition(position);
  return {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn,
  };
}

function labelsOf(items: readonly Monaco.languages.CompletionItem[]): string[] {
  return items.map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
}

function pos(lineNumber: number, column: number): Monaco.Position {
  return { lineNumber, column } as Monaco.Position;
}

/* ============================== ① 取词面 ============================== */

describe('document-words · 取词面（代码行才进索引）', () => {
  it('.kojo：台词 / 心形正文 / 注释里的词不进索引，代码行的词进', () => {
    const text = [
      '别名 Foo = 角色 3',
      '「Foo 台词」',
      '心形 台词',
      '; 台词 注释',
      '别名 Fo = 角色 3',
    ].join('\n');
    const model = modelOf(text);
    const position = pos(5, '别名 Fo'.length + 1);
    const items = documentWordItems(MONACO, model, position, rangeOf(model, position), 'kojo');
    expect(labelsOf(items)).toContain('Foo');

    // 台词 / 心形 / 注释里的「台词」不得进面板
    const tailModel = modelOf(['台词 Foo', '别名 台 = 角色 3'].join('\n'));
    const tailPos = pos(2, '别名 台'.length + 1);
    const tail = documentWordItems(MONACO, tailModel, tailPos, rangeOf(tailModel, tailPos), 'kojo');
    expect(labelsOf(tail)).not.toContain('台词');
  });

  it('.erb：`;` 注释与双引号字符串内容不取词', () => {
    const text = ['Alpha', '; AlphaComment', 'PRINTFORML "AlphaString"', 'PRINTFORML Al'].join('\n');
    const model = modelOf(text, { languageId: ERB_LANGUAGE_ID });
    const position = pos(4, 'PRINTFORML Al'.length + 1);
    const items = documentWordItems(MONACO, model, position, rangeOf(model, position), 'erb');
    expect(labelsOf(items)).toContain('Alpha');
    expect(labelsOf(items)).not.toContain('AlphaComment');
    expect(labelsOf(items)).not.toContain('AlphaString');
  });

  it('空前缀不出词；与已输入词完全同名的不出', () => {
    const text = ['别名 FooBar = 1', '别名 Foo = 2'].join('\n');
    const model = modelOf(text);
    expect(documentWordItems(MONACO, model, pos(2, 1), rangeOf(model, pos(2, 1)), 'kojo')).toEqual([]);
    const position = pos(2, '别名 Foo'.length + 1);
    const items = documentWordItems(MONACO, model, position, rangeOf(model, position), 'kojo');
    expect(labelsOf(items)).toContain('FooBar');
    expect(labelsOf(items)).not.toContain('Foo');
  });

  it(`上限 ${MAX_DOCUMENT_WORD_SUGGESTIONS} 条 / 超 ${WORD_SUGGESTIONS_MAX_LINES} 行不建索引`, () => {
    const many = Array.from({ length: 250 }, (_, i) => `别名 Word${String(i).padStart(3, '0')} = 1`);
    many.push('别名 Word = 1');
    const model = modelOf(many.join('\n'));
    const position = pos(many.length, '别名 Word'.length + 1);
    const items = documentWordItems(MONACO, model, position, rangeOf(model, position), 'kojo');
    expect(items).toHaveLength(MAX_DOCUMENT_WORD_SUGGESTIONS);

    const huge = Array.from({ length: WORD_SUGGESTIONS_MAX_LINES + 1 }, (_, i) => `别名 W${i} = 1`);
    const hugeModel = modelOf(huge.join('\n'));
    const hugePos = pos(1, '别名 W'.length + 1);
    expect(documentWordItems(MONACO, hugeModel, hugePos, rangeOf(hugeModel, hugePos), 'kojo')).toEqual([]);
  });

  it('索引按 model 版本号记忆化：版本变化后才看到新词', () => {
    const model = modelOf(['别名 Foo = 1', '别名 Fo = 1'].join('\n'));
    const position = pos(2, '别名 Fo'.length + 1);
    const first = documentWordItems(MONACO, model, position, rangeOf(model, position), 'kojo');
    expect(labelsOf(first)).not.toContain('Foobar');

    model.push('别名 Foobar = 1');
    // 版本未变 ⇒ 复用旧索引（新行还看不见）
    expect(labelsOf(documentWordItems(MONACO, model, position, rangeOf(model, position), 'kojo'))).not.toContain(
      'Foobar',
    );
    model.bump();
    expect(labelsOf(documentWordItems(MONACO, model, position, rangeOf(model, position), 'kojo'))).toContain(
      'Foobar',
    );
  });
});

/* ============================== ② 位置门 ============================== */

describe('kojoWordCandidateAt · 专有名字槽不出文档词', () => {
  it('变量插值 / 调用名槽 / 时机块头 / 是值位 ⇒ false；表达式位 ⇒ true', () => {
    expect(kojoWordCandidateAt('{她的', 4)).toBe(false);
    expect(kojoWordCandidateAt('调用 口上', 6)).toBe(false);
    expect(kojoWordCandidateAt('函数 口上', 6)).toBe(false);
    expect(kojoWordCandidateAt('时机 指', 5)).toBe(false);
    expect(kojoWordCandidateAt('时机 指令 310：', 9)).toBe(false);
    expect(kojoWordCandidateAt('时机 指令 310 成否: 游', 14)).toBe(false);
    expect(kojoWordCandidateAt('是 摸', 4)).toBe(false);
    expect(kojoWordCandidateAt('如果 她的', 6)).toBe(true);
    expect(kojoWordCandidateAt('好感度 = 1', 7)).toBe(true);
  });
});

/* ============================== ③ 装配面 ============================== */

async function provideKojo(
  text: string,
  position: Monaco.Position,
  wordBasedSuggestions: boolean,
): Promise<Monaco.languages.CompletionItem[]> {
  registered = [];
  const tables = {
    wordBasedSuggestions: () => wordBasedSuggestions,
    erbFunctionNames: () => [],
  };
  installKojoCompletion(MONACO, () => tables);
  const provider = registered[0]!.provider;
  const model = modelOf(text);
  const result = await provider.provideCompletionItems(
    model,
    position,
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  );
  return result?.suggestions ?? [];
}

async function provideErb(
  text: string,
  position: Monaco.Position,
  wordBasedSuggestions: boolean,
): Promise<Monaco.languages.CompletionItem[]> {
  registered = [];
  const tables = {
    wordBasedSuggestions: () => wordBasedSuggestions,
    erbFunctionNames: () => ['Beta'],
  };
  installErbCompletion(MONACO, () => tables);
  const provider = registered[0]!.provider;
  const model = modelOf(text, { languageId: ERB_LANGUAGE_ID });
  const result = await provider.provideCompletionItems(
    model,
    position,
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  );
  return result?.suggestions ?? [];
}

describe('文档词源 · 装配面', () => {
  it('.kojo 开关关 ⇒ 零词源候选；开 ⇒ 代码表达式位出现文档词', async () => {
    // 「她的好感度」不是声明名 / 词表词，唯一的来源就是文档词索引
    const text = ['她的好感度 = 1', '如果 她的'].join('\n');
    const position = pos(2, '如果 她的'.length + 1);
    const off = await provideKojo(text, position, false);
    expect(labelsOf(off)).not.toContain('她的好感度');

    const on = await provideKojo(text, position, true);
    expect(labelsOf(on)).toContain('她的好感度');
  });

  it('.kojo 台词行整轮零候选（词源也过不了位置门）', async () => {
    const text = '「Foo 台词」';
    const items = await provideKojo(text, pos(1, text.length + 1), true);
    expect(items).toEqual([]);
  });

  it('词源与上下文候选同名 ⇒ 只留一条（先注册者胜）', async () => {
    const text = ['如果 好感度 至少 1：', '如果 如'].join('\n');
    const items = await provideKojo(text, pos(2, '如果 如'.length + 1), true);
    expect(labelsOf(items).filter((l) => l === '如果')).toHaveLength(1);
  });

  it('.erb 专用名槽（CALL 目标）不给文档词；默认表达式位给', async () => {
    const slots = await provideErb(['CALL Alpha', '\tCALL Al'].join('\n'), pos(2, '\tCALL Al'.length + 1), true);
    expect(labelsOf(slots)).not.toContain('Alpha');

    const expr = await provideErb(
      ['PRINTFORML Alpha', '\tPRINTFORML Al'].join('\n'),
      pos(2, '\tPRINTFORML Al'.length + 1),
      true,
    );
    expect(labelsOf(expr)).toContain('Alpha');
  });

  it('.erb 注释 / 字符串里零候选；开关关 ⇒ 表达式位也不出词', async () => {
    const comment = '; AlphaComment';
    expect(await provideErb(comment, pos(1, comment.length + 1), true)).toEqual([]);

    const stringLine = 'PRINTFORML "AlphaString"';
    expect(await provideErb(stringLine, pos(1, 13), true)).toEqual([]);

    const expr = await provideErb(
      ['PRINTFORML Alpha', '\tPRINTFORML Al'].join('\n'),
      pos(2, '\tPRINTFORML Al'.length + 1),
      false,
    );
    expect(labelsOf(expr)).not.toContain('Alpha');
  });
});
