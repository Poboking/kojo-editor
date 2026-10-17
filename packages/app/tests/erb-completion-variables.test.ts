/**
 * EC-2 · `.erb` 变量族 + 具名索引补全（`erbVariableCompletionItems`）单测。
 *
 * 合成字典（无需语料）：合成 `VariableSchema` 只实现 KC-1 交付的 `names` 可选能力；
 * 覆盖 `CFLAG:`（二段式 / 全量）、`CFLAG:好`（前缀过滤）、`CFLAG:TARGET:`（三段式 / 全量）、
 * `CFLAG:TARGET:好`（三段式 / 前缀过滤）、非白名单族 / 更深段式 / schema 缺省 / 无 `names`
 * 一律 `[]`（不抛），以及替换范围**只覆盖末段**、排序前缀精确优先、kind 二段/三段之分。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { VariableInfo, VariableSchema } from '@kojo/plugin-api';
import { erbVariableCompletionItems, erbVariableSlotAt } from '../src/monaco/erb-completion-variables';

/** 合成族 → 索引名表（CFLAG 主表 4 名；TALENT 一表用于核对族隔离） */
const NAMES: Record<string, VariableInfo[]> = {
  CFLAG: [
    { name: '好感度', index: 2, resolvedIndex: 2, source: 'primary' },
    { name: '好色', index: 30, resolvedIndex: 30, source: 'primary' },
    { name: '好色程度', index: 31, resolvedIndex: 31, source: 'primary' },
    { name: '恋慕', index: 3, resolvedIndex: 3, source: 'primary', description: '恋慕（爱情）' },
  ],
  TALENT: [{ name: '恋慕', index: 3, resolvedIndex: 3, source: 'primary' }],
};

const schema: VariableSchema = {
  version: '1',
  lookup: () => undefined,
  names: (family) => NAMES[family] ?? [],
};

/** 合成 Monaco：本纯函数只用到 CompletionItemKind.{Variable, Field}（真值 4 / 3） */
const monaco = {
  languages: { CompletionItemKind: { Variable: 4, Field: 3 } },
} as unknown as typeof Monaco;

const modelOf = (line: string) => ({ getLineContent: () => line }) as unknown as Monaco.editor.ITextModel;

/** 用 `|` 标记光标（1 基列 = 标记前字符数 + 1）；无标记 = 光标在行尾。`null` = schema 缺省 */
function at(marked: string, s?: VariableSchema | null): Monaco.languages.CompletionItem[] {
  const marker = marked.indexOf('|');
  const line = marked.replace('|', '');
  const column = (marker >= 0 ? marker : line.length) + 1;
  const resolved = s === null ? undefined : (s ?? schema);
  return erbVariableCompletionItems(monaco, modelOf(line), { lineNumber: 1, column } as Monaco.Position, resolved);
}

const labels = (items: readonly Monaco.languages.CompletionItem[]): string[] => items.map((i) => i.label as string);

describe('EC-2 ERB 变量补全 · 二段式（族:名）', () => {
  it('`CFLAG:` → 该族名字全量', () => {
    expect(labels(at('CFLAG:'))).toEqual(['好感度', '好色', '好色程度', '恋慕']);
    expect(labels(at('CFLAG:|'))).toEqual(['好感度', '好色', '好色程度', '恋慕']);
  });

  it('`CFLAG:好` → 只留以「好」起头的名字', () => {
    expect(labels(at('CFLAG:好'))).toEqual(['好感度', '好色', '好色程度']);
  });

  it('族隔离：`TALENT:恋` 只出 TALENT 的名字', () => {
    expect(labels(at('TALENT:恋'))).toEqual(['恋慕']);
  });

  it('`kind` = Variable（二段式）；`insertText` = 名字', () => {
    const [first] = at('CFLAG:好');
    expect(first?.kind).toBe(4);
    expect(first?.insertText).toBe(first?.label);
  });
});

describe('EC-2 ERB 变量补全 · 三段式（族:作用域:名）', () => {
  it('`CFLAG:TARGET:` → 名字全量（三段式，钉住支持）', () => {
    expect(labels(at('CFLAG:TARGET:'))).toEqual(['好感度', '好色', '好色程度', '恋慕']);
  });

  it('`CFLAG:TARGET:好` → 前缀过滤', () => {
    expect(labels(at('CFLAG:TARGET:好'))).toEqual(['好感度', '好色', '好色程度']);
  });

  it('`kind` = Field（三段式）', () => {
    const [first] = at('CFLAG:TARGET:好');
    expect(first?.kind).toBe(3);
  });

  it('更深段式（`CFLAG:TARGET:ABL:`）→ []（只覆盖二段 / 三段两种段式）', () => {
    expect(at('CFLAG:TARGET:ABL:')).toEqual([]);
  });
});

describe('EC-2 ERB 变量补全 · 条目形态', () => {
  it('`detail` = 族:编号；`description` 有则进 documentation', () => {
    const byLabel = new Map(at('CFLAG:').map((i) => [i.label as string, i]));
    expect(byLabel.get('好感度')?.detail).toBe('CFLAG:2');
    expect(byLabel.get('恋慕')?.detail).toBe('CFLAG:3');
    expect(byLabel.get('恋慕')?.documentation).toBe('恋慕（爱情）');
    expect(byLabel.get('好感度')?.documentation).toBeUndefined();
  });

  it('排序受控：前缀精确匹配优先（`好色` 排在 `好色程度` 前）', () => {
    const byLabel = new Map(at('CFLAG:好色').map((i) => [i.label as string, i]));
    expect(byLabel.get('好色')?.sortText).toBe('0_好色');
    expect(byLabel.get('好色程度')?.sortText).toBe('1_好色程度');
  });
});

describe('EC-2 ERB 变量补全 · 替换范围只覆盖末段', () => {
  it('二段式：光标在名字中间（`CFLAG:好|感度`）→ 替换整段名字', () => {
    const items = at('CFLAG:好|感度');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 7, endColumn: 10 });
    }
  });

  it('三段式：行中引用（`IF CFLAG:好|感度 > 1`）→ 只覆盖末段名字', () => {
    const items = at('IF CFLAG:好|感度 > 1');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 10, endColumn: 13 });
    }
  });

  it('光标在名字末尾（`CFLAG:TARGET:好|`）→ 替换已输入段', () => {
    const items = at('CFLAG:TARGET:好|');
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 14, endColumn: 15 });
  });
});

describe('EC-2 ERB 变量补全 · fail-visible 负例（绝不猜、绝不抛）', () => {
  it('非白名单族（`FOO:`）→ []', () => {
    expect(at('FOO:')).toEqual([]);
  });

  it('族头内 / 无冒号（`CFLAG`）→ []', () => {
    expect(at('CFLAG')).toEqual([]);
    expect(at('CFL|AG:好')).toEqual([]); // 光标在族头里
  });

  it('空作用域段（`CFLAG::好`）→ []', () => {
    expect(at('CFLAG::好')).toEqual([]);
  });

  it('末段数字开头（`CFLAG:12`）→ []（编号，不是名字）', () => {
    expect(at('CFLAG:12')).toEqual([]);
  });

  it('schema 缺省 / 实现未提供 `names` → [] 且不抛', () => {
    expect(at('CFLAG:好', null)).toEqual([]);
    expect(at('CFLAG:TARGET:好', null)).toEqual([]);
    const noNames: VariableSchema = { version: '1', lookup: () => undefined };
    expect(at('CFLAG:好', noNames)).toEqual([]);
  });
});

/* ============================== 探针导出（T6 位置门 `variable-slot` 消费；与候选同一份判据） ============================== */

describe('EC-2 探针导出 · erbVariableSlotAt（门与候选源共用一份判据）', () => {
  it('白名单族 + 名字位 → 槽描述（二段 / 三段）', () => {
    expect(erbVariableSlotAt('CFLAG:好', 8)).toMatchObject({
      start: 6,
      end: 7,
      prefix: '好',
      family: 'CFLAG',
      scoped: false,
    });
    expect(erbVariableSlotAt('CFLAG:TARGET:好', 15)).toMatchObject({
      start: 13,
      end: 14,
      prefix: '好',
      family: 'CFLAG',
      scoped: true,
    });
    expect(erbVariableSlotAt('CFLAG:', 7)).toMatchObject({ start: 6, end: 6, prefix: '', family: 'CFLAG' });
  });

  it('非白名单族 / 非名字位 → null（与候选的负例同口径）', () => {
    expect(erbVariableSlotAt('FOO:好', 6)).toBeNull();
    expect(erbVariableSlotAt('CFLAG', 6)).toBeNull();
    expect(erbVariableSlotAt('CFL|AG:好', 4)).toBeNull();
  });
});
