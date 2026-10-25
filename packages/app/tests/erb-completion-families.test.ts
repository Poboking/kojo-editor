/**
 * ERB-FAMILY · `.erb` 族头补全（`erbFamilyCompletionItems`）与共享"裸标识符名位"判据
 * （`erbDeclaredNameSlot`）单测。
 *
 * 覆盖：`PRINTFORML CF|` 命中 CFLAG、小写 `cf|` 同样命中（大小写不敏感）、行首 `CF|` 出货、
 * 零前缀 = 全表；`族:` 段分隔 / `@` `#` `$` `%` 引号 sigil / 空行纯空白 ⇒ 零候选；
 * 条目形态（label/insertText/filterText = 族名不插冒号、kind、detail、sortText 档）；
 * 替换范围只覆盖名字段；判据本身的区间 / CJK / 全角 / 非法列 / 桩 model 缺件。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { ENGINE_VARIABLE_FAMILIES } from '@kojo/plugin-kojo-sugar';
import { erbDeclaredNameSlot, erbFamilyCompletionItems } from '../src/monaco/erb-completion-families';

/** 合成 Monaco：本纯函数只用到 CompletionItemKind.Variable（真值 4） */
const monaco = {
  languages: { CompletionItemKind: { Variable: 4 } },
} as unknown as typeof Monaco;

const modelOf = (line: string) => ({ getLineContent: () => line }) as unknown as Monaco.editor.ITextModel;

/** 用 `|` 标记光标（1 基列 = 标记前字符数 + 1）；无标记 = 光标在行尾 */
function at(marked: string): Monaco.languages.CompletionItem[] {
  const marker = marked.indexOf('|');
  const line = marked.replace('|', '');
  const column = (marker >= 0 ? marker : line.length) + 1;
  return erbFamilyCompletionItems(monaco, modelOf(line), { lineNumber: 1, column } as Monaco.Position);
}

const labels = (items: readonly Monaco.languages.CompletionItem[]): string[] =>
  items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));

describe('ERB-FAMILY 族头补全 · 出货面', () => {
  it('`PRINTFORML CF|` ⇒ CFLAG（行中名字位出货）', () => {
    expect(labels(at('PRINTFORML CF|'))).toEqual(['CFLAG']);
  });

  it('小写 `cf|` 前缀同样命中（ERB 大小写不敏感），展示保留原名', () => {
    const items = at('cf|');
    expect(labels(items)).toEqual(['CFLAG']);
    expect(items[0]?.insertText).toBe('CFLAG');
  });

  it('行首 `CF|` ⇒ 出货（行首与 `.kojo` 侧不同：族头不要求行首）', () => {
    expect(labels(at('CF|'))).toEqual(['CFLAG']);
  });

  it('`PRINTFORML CA|` ⇒ CALLNAME（前缀过滤走大小写不敏感）', () => {
    expect(labels(at('PRINTFORML ca|'))).toEqual(['CALLNAME']);
  });

  it('零前缀（名字段内空段：`|CF`）⇒ 全表 ENGINE_VARIABLE_FAMILIES', () => {
    expect(labels(at('|CF'))).toEqual([...ENGINE_VARIABLE_FAMILIES]);
  });

  it('前缀无任何族命中 ⇒ []（不猜）', () => {
    expect(at('PRINTFORML ZZZ|')).toEqual([]);
  });

  // K6 批（2026-10-25）：`MASTERNAME` 进 `ENGINE_VARIABLE_FAMILIES` 后的出货位——
  // 取证与取舍见 `erb-language.ts` 的 `ERB_VARIABLE_FAMILY_HEADS` 头注；
  // 名单 ⇄ 本表的双向对拍闸在 `tests/erb-family-single-source.test.ts`。
  it('K6：`MASTER|` ⇒ MASTERNAME（引擎内建"主人名"族头，此前有颜色无补全的反向漂移）', () => {
    expect(labels(at('PRINTFORML MASTER|'))).toEqual(['MASTERNAME']);
    expect(labels(at('PRINTFORML master|'))).toEqual(['MASTERNAME']);
  });

  it('K6：`PLAYER|` / `CHILDNAME|` ⇒ []（前者是执行上下文标量不是族头，后者是作品 #DIMS 自造名）', () => {
    expect(at('PRINTFORML PLAYER|')).toEqual([]);
    expect(at('PRINTFORML CHILDNAME|')).toEqual([]);
  });
});

describe('ERB-FAMILY 族头补全 · 条目形态', () => {
  it('label / insertText / filterText = 族名（不插冒号）；kind = Variable；detail = 引擎族头', () => {
    const [item] = at('CF|');
    expect(item?.label).toBe('CFLAG');
    expect(item?.insertText).toBe('CFLAG');
    expect(item?.filterText).toBe('CFLAG');
    expect(item?.kind).toBe(4);
    expect(item?.detail).toBe('引擎族头');
  });

  it('sortText：大小写不敏感前缀精确优先（`cflag|` ⇒ 0 档，命中档 1 档）', () => {
    expect(at('cflag|')[0]?.sortText).toBe('0_CFLAG');
    const byLabel = new Map(at('c|').map((i) => [i.label as string, i]));
    expect(byLabel.get('CFLAG')?.sortText).toBe('1_CFLAG');
    expect(byLabel.get('CALLNAME')?.sortText).toBe('1_CALLNAME');
  });

  it('替换范围只覆盖光标所在名字段（`PRINTFORML CF|LAG` ⇒ 列 12..17）', () => {
    const items = at('PRINTFORML CF|LAG');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 12, endColumn: 17 });
    }
  });
});

describe('ERB-FAMILY 族头补全 · fail-visible 负例（绝不猜、绝不抛）', () => {
  it('`CFLAG:TARGET:性|` / `CFLAG:性|` ⇒ []（token 前是 `:`——末段名字位归 EC-2）', () => {
    expect(at('CFLAG:TARGET:性|')).toEqual([]);
    expect(at('CFLAG:性|')).toEqual([]);
    expect(at('CFLAG：性|')).toEqual([]); // 全角冒号同排除
  });

  it('`@CF|` / `#CF|` / `$CF|` ⇒ []（sigil 排除）', () => {
    expect(at('@CF|')).toEqual([]);
    expect(at('#CF|')).toEqual([]);
    expect(at('$CF|')).toEqual([]);
  });

  it('`%CF|` / `"CF|` / `\'CF|` ⇒ []（表单串 / 字符串字面量首位）', () => {
    expect(at('%CF|')).toEqual([]);
    expect(at('"CF|')).toEqual([]);
    expect(at("'CF|")).toEqual([]);
  });

  it('空行 / 纯空白行 ⇒ 零候选', () => {
    expect(at('|')).toEqual([]);
    expect(at('|   ')).toEqual([]);
    expect(at('   |')).toEqual([]);
    expect(at('   |   ')).toEqual([]);
  });

  it('桩 model 缺 `getLineContent` ⇒ [] 且不抛', () => {
    const bare = {} as unknown as Monaco.editor.ITextModel;
    expect(
      erbFamilyCompletionItems(monaco, bare, { lineNumber: 1, column: 1 } as Monaco.Position),
    ).toEqual([]);
  });
});

describe('ERB-FAMILY 共享判据 erbDeclaredNameSlot', () => {
  it('区间与前缀（0 基左含右不含）：`PRINTFORML CFLAG` 列 14 ⇒ {11, 16, CF}', () => {
    expect(erbDeclaredNameSlot('PRINTFORML CFLAG', 14)).toEqual({ start: 11, end: 16, prefix: 'CF' });
  });

  it('光标夹在词中（`CF` 列 2）⇒ 段仍是整词', () => {
    expect(erbDeclaredNameSlot('CF', 2)).toEqual({ start: 0, end: 2, prefix: 'C' });
  });

  it('CJK / 假名 / 全角算名字字符', () => {
    expect(erbDeclaredNameSlot('DIM 好感度', 7)).toEqual({ start: 4, end: 7, prefix: '好感' });
    expect(erbDeclaredNameSlot('ＤＩＭ', 4)).toEqual({ start: 0, end: 3, prefix: 'ＤＩＭ' });
  });

  it('行尾 / 空白空插入点 ⇒ null（左右至少一侧是名字字符才算）', () => {
    expect(erbDeclaredNameSlot('PRINTFORML ', 12)).toBeNull();
    expect(erbDeclaredNameSlot('', 1)).toBeNull();
    expect(erbDeclaredNameSlot('CF ', 4)).toBeNull();
  });

  it('token 起点前一枚字符 ∈ sigil 集 ⇒ null', () => {
    for (const line of ['@CF', '#CF', '$CF', '%CF', '"CF', "'CF", 'CFLAG:性', 'CFLAG：性', '[CF']) {
      expect(erbDeclaredNameSlot(line, line.length + 1)).toBeNull();
    }
  });

  it('列越界夹进线内；非法列 ⇒ null（判据落空不抛）', () => {
    expect(erbDeclaredNameSlot('CF', 999)).toEqual({ start: 0, end: 2, prefix: 'CF' });
    expect(erbDeclaredNameSlot('CF', 0)).toBeNull();
    expect(erbDeclaredNameSlot('CF', Number.NaN)).toBeNull();
  });
});