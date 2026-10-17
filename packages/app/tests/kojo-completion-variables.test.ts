/**
 * KC-1 · `.kojo` 插值变量 / 属性补全（`variableCompletionItems`）单测。
 *
 * 合成字典（无需语料）：合成 `VariableSchema` 只实现 KC-1 新增的 `names` 可选能力；
 * 覆盖 `{她的<前缀>}` 前缀过滤、`{角色N的}` 全量、插值外 / schema 缺省 / 无 names
 * 一律 `[]`（不抛），以及替换范围**只覆盖名字那一段**、排序前缀精确优先。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { VariableInfo, VariableSchema } from '@kojo/plugin-api';
import { variableCompletionItems } from '../src/monaco/kojo-completion-variables';

/** 合成族 → 索引名表（CFLAG/TALENT 主表 + TCVAR 追加名表；含同名跨族用于去重） */
const NAMES: Record<string, VariableInfo[]> = {
  CFLAG: [
    { name: '好感度', index: 2, resolvedIndex: 2, source: 'primary' },
    { name: '好色', index: 30, resolvedIndex: 30, source: 'primary' },
    { name: '好色程度', index: 31, resolvedIndex: 31, source: 'primary' },
  ],
  TALENT: [
    { name: '恋慕', index: 3, resolvedIndex: 3, source: 'primary', description: '恋慕（爱情）' },
    { name: '好感度', index: 999, resolvedIndex: 999, source: 'append' }, // 跨族同名 → 主表优先去重
  ],
  TCVAR: [{ name: '泥酔', index: 145, resolvedIndex: 145, source: 'append' }],
};

const schema: VariableSchema = {
  version: '1',
  lookup: () => undefined,
  names: (family) => NAMES[family] ?? [],
};

/** 合成 Monaco：本纯函数只用到 CompletionItemKind.Variable */
const monaco = { languages: { CompletionItemKind: { Variable: 4 } } } as unknown as typeof Monaco;

const modelOf = (line: string) => ({ getLineContent: () => line }) as unknown as Monaco.editor.ITextModel;

/** 用 `|` 标记光标（1 基列 = 标记前字符数 + 1）；无标记 = 光标在行尾。`null` = schema 缺省 */
function at(marked: string, s?: VariableSchema | null): Monaco.languages.CompletionItem[] {
  const marker = marked.indexOf('|');
  const line = marked.replace('|', '');
  const column = (marker >= 0 ? marker : line.length) + 1;
  const resolved = s === null ? undefined : (s ?? schema);
  return variableCompletionItems(monaco, modelOf(line), { lineNumber: 1, column } as Monaco.Position, resolved);
}

const labels = (items: readonly Monaco.languages.CompletionItem[]): string[] => items.map((i) => i.label as string);

describe('KC-1 插值变量补全 · 名字候选', () => {
  it('`{她的好` → 只留以「好」起头的名字（跨族并集）', () => {
    expect(labels(at('{她的好'))).toEqual(['好感度', '好色', '好色程度']);
  });

  it('`{角色12的` → 空前缀 = 全量；跨族同名去重（主表优先）', () => {
    expect(labels(at('{角色12的'))).toEqual(['好感度', '好色', '好色程度', '恋慕', '泥酔']);
  });

  it('`{你的泥` → 追加名表（append 层）的名字照样补', () => {
    expect(labels(at('{你的泥'))).toEqual(['泥酔']);
  });
});

describe('KC-1 插值变量补全 · 条目形态', () => {
  it('`detail` = 族:编号；`description` 有则进 documentation', () => {
    const full = at('{角色12的');
    const byLabel = new Map(full.map((i) => [i.label as string, i]));
    expect(byLabel.get('好感度')?.detail).toBe('CFLAG:2');
    expect(byLabel.get('泥酔')?.detail).toBe('TCVAR:145');
    expect(byLabel.get('恋慕')?.detail).toBe('TALENT:3');
    expect(byLabel.get('恋慕')?.documentation).toBe('恋慕（爱情）');
    expect(byLabel.get('好感度')?.documentation).toBeUndefined();
  });

  it('`kind` 用 Variable；`insertText` = 名字', () => {
    const [first] = at('{她的好');
    expect(first?.kind).toBe(4);
    expect(first?.insertText).toBe(first?.label);
  });

  it('排序受控：前缀精确匹配优先（`好色` 排在 `好色程度` 前）', () => {
    const items = at('{她的好色');
    const byLabel = new Map(items.map((i) => [i.label as string, i]));
    expect(byLabel.get('好色')?.sortText).toBe('0_好色');
    expect(byLabel.get('好色程度')?.sortText).toBe('1_好色程度');
  });
});

describe('KC-1 插值变量补全 · 替换范围只覆盖名字段', () => {
  it('光标在名字中间（`{她的好|感度}`）→ 替换整段名字', () => {
    const items = at('{她的好|感度}');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 4, endColumn: 7 });
    }
  });

  it('光标在名字末尾（`{她的好|`）→ 替换已输入的名字段', () => {
    const items = at('{她的好|');
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 4, endColumn: 5 });
  });
});

describe('KC-1 插值变量补全 · fail-visible 负例（绝不猜、绝不抛）', () => {
  it('插值外（`她的好`）→ []', () => {
    expect(at('她的好')).toEqual([]);
    expect(at('{A} 她的|好')).toEqual([]); // 光标在已闭合插值之后
  });

  it('不在插值内的其它位置 / 前缀半成品 / 数字开头 → []', () => {
    expect(at('{她')).toEqual([]); // 保留代词半成品
    expect(at('{角色')).toEqual([]); // 角色引用半成品
    expect(at('{12')).toEqual([]); // 数字开头 = 编号，不是名字
  });

  it('schema 缺省 / 实现未提供 `names` → [] 且不抛', () => {
    expect(at('{她的好', null)).toEqual([]);
    const noNames: VariableSchema = { version: '1', lookup: () => undefined };
    expect(at('{她的好', noNames)).toEqual([]);
  });
});

/* ============================== 空白口径（全角缩进）+ filterText ============================== */

describe('KC-1 插值变量补全 · 行首空白口径（全角缩进能编译 ⇒ 必须补得出）', () => {
  it('全角空格缩进行的插值照旧出候选', () => {
    expect(labels(at('　　{她的好'))).toEqual(['好感度', '好色', '好色程度']);
  });

  it('制表 / 半角缩进行为原样不动', () => {
    expect(labels(at('\t{她的泥'))).toEqual(['泥酔']);
    expect(labels(at('    {你的泥'))).toEqual(['泥酔']);
  });

  it('全角 / 半角空格都不是名字字符 ⇒ 前缀里混进空白即不认（不放宽判定语义）', () => {
    expect(at('{她的　好')).toEqual([]);
    expect(at('{她的 好')).toEqual([]);
  });
});

describe('KC-1 插值变量补全 · filterText（真实 Monaco 按 `filterText ?? label` 过滤）', () => {
  it('每条候选都显式带 `filterText` = 名字原文（与 label / insertText 同字）', () => {
    const items = at('{角色12的');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.filterText).toBeDefined();
      expect(item.filterText).toBe(item.label);
      expect(item.filterText).toBe(item.insertText);
    }
  });

  it('钉值：中文名字段的 `filterText` 就是字典里的名字（不留给 label 兜底）', () => {
    const byLabel = new Map(at('{她的好').map((i) => [i.label as string, i]));
    expect(byLabel.get('好色程度')?.filterText).toBe('好色程度');
  });
});
