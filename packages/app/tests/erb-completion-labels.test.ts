/**
 * EC-4 · `.erb` 的 `$标签` 补全（`erbLabelCompletionItems`）单测。
 *
 * 合成 model（无需语料、不引入 Monaco 运行时）：`getValue` 供全文扫标签、`getLineContent`
 * 供跳转上下文解析。覆盖：`GOTO ` → 本文件全量标签；`GOTO 招` → 前缀过滤；普通行 / 条件行 /
 * 无标签文件 / 空 model → `[]`（不抛）；`$` 已敲则保留（`insertText` 不重复补 `$`）；
 * 替换范围**只覆盖标签名那一段**；`kind` = Reference、排序前缀精确优先。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { erbLabelCompletionItems } from '../src/monaco/erb-completion-labels';

/** 合成 Monaco：本纯函数只用到 CompletionItemKind.Reference */
const monaco = { languages: { CompletionItemKind: { Reference: 21 } } } as unknown as typeof Monaco;

function modelOf(text: string): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  return {
    getValue: () => text,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
  } as unknown as Monaco.editor.ITextModel;
}

/** 用 `|` 标记光标（1 基列 = 标记前字符数 + 1）；无标记 = 全文末尾。`|` 可落在文件任意行。 */
function at(marked: string): Monaco.languages.CompletionItem[] {
  const marker = marked.indexOf('|');
  const hasCaret = marker >= 0;
  const text = hasCaret ? marked.replace('|', '') : marked;
  const caret = hasCaret ? marker : text.length;
  const before = text.slice(0, caret);
  const lineNumber = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n') + 1;
  const column = caret - lineStart + 1;
  return erbLabelCompletionItems(monaco, modelOf(text), { lineNumber, column } as Monaco.Position);
}

const labels = (items: readonly Monaco.languages.CompletionItem[]): string[] =>
  items.map((i) => i.label as string);

/** 三标签样本文件（定义保序：开始 → 招待 → 招架） */
const FILE = '@TEST\n$开始\n\tPRINTL 你好\n\tGOTO 招\n$招待\n\tPRINTL 招待\n$招架\n\tPRINTL 招架';

describe('EC-4 标签补全 · 跳转上下文产出', () => {
  it('`GOTO `（空前缀）→ 本文件全量标签，定义序保持', () => {
    expect(labels(at(FILE.replace('\tGOTO 招', '\tGOTO |')))).toEqual(['开始', '招待', '招架']);
  });

  it('`GOTO 招` → 只留以「招」起头的标签（前缀过滤）', () => {
    expect(labels(at(FILE.replace('\tGOTO 招', '\tGOTO 招|')))).toEqual(['招待', '招架']);
  });

  it('缩进行首 + 别名 `JUMP` 同样出货', () => {
    expect(labels(at(FILE.replace('\tGOTO 招', '\tJUMP 招|')))).toEqual(['招待', '招架']);
  });

  it('替换范围只覆盖标签名段：光标在名字中间 → 吃满整段名字', () => {
    const items = at('@TEST\n$招待\n$招架\nGOTO 招|待');
    expect(labels(items)).toEqual(['招待', '招架']);
    for (const item of items) {
      expect(item.range).toEqual({ startLineNumber: 4, endLineNumber: 4, startColumn: 6, endColumn: 8 });
    }
  });
});

describe('EC-4 标签补全 · 条目形态', () => {
  it('`kind` = Reference；`insertText` = 名字（不重复补 `$`）；`detail` = 标签（本文件）', () => {
    const [first] = at(FILE.replace('\tGOTO 招', '\tGOTO |'));
    expect(first?.kind).toBe(21);
    expect(first?.insertText).toBe('开始');
    expect(first?.detail).toBe('标签（本文件）');
  });

  it('排序受控：前缀精确匹配优先（同前缀下 `招待` 排 `招待券` 前）', () => {
    const items = at('@TEST\n$招待\n$招待券\nGOTO 招待');
    const byLabel = new Map(items.map((i) => [i.label as string, i]));
    expect(byLabel.get('招待')?.sortText).toBe('0_招待');
    expect(byLabel.get('招待券')?.sortText).toBe('1_招待券');
  });

  it('作者已敲 `$` → `$` 留在替换范围之外（并存不重复）', () => {
    const items = at('@TEST\n$招待\n$招架\nGOTO $招|待');
    expect(labels(items)).toEqual(['招待', '招架']);
    // `GOTO $招待`：`$` 在 0 基 5、名字在 [6,8)；范围只盖名字段（1 基 7→9），`$` 不动
    expect(items[0]?.range).toEqual({ startLineNumber: 4, endLineNumber: 4, startColumn: 7, endColumn: 9 });
    expect(items[0]?.insertText).toBe('招待');
  });
});

describe('EC-4 标签补全 · fail-visible 负例（绝不猜、绝不抛）', () => {
  it('非跳转上下文（普通行 / 条件行）→ []', () => {
    expect(at(FILE.replace('\tPRINTL 你好', '\tPRINTL 你好|'))).toEqual([]);
    expect(at('@TEST\n$开始\n\tIF CFLAG:TARGET:2 >= 500|')).toEqual([]);
    expect(at('@TEST\n$开始\n\tSIF A = 1 : PRINTL x|')).toEqual([]);
  });

  it('无 `$` 标签定义的文件 → []', () => {
    expect(at('@TEST\n\tGOTO |')).toEqual([]);
  });

  it('空 model 的跳转位置 → [] 且不抛', () => {
    expect(() => at('|')).not.toThrow();
    expect(at('|')).toEqual([]);
  });

  it('前缀无命中 → []', () => {
    expect(at(FILE.replace('\tGOTO 招', '\tGOTO 不存在的标签|'))).toEqual([]);
  });

  it('该位置不在跳转后（`GOTO` 后无空白）→ []', () => {
    expect(at('@TEST\n$开始\n\tGOTO|')).toEqual([]);
  });
});
