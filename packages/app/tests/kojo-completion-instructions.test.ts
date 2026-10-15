/**
 * KC-3 · 中文指令名正向补全（`instructionCompletionItems`）纯逻辑单测。
 *
 * 合成 `KojoInstructionTable`（无游戏名词进源码；指令名只住测试桩），无需语料。
 * 覆盖：`时机 <分野> <编号位>` 与 `是 <值位>` 两落点的位置判定 / 前缀过滤 / 替换范围 /
 * detail 文案（编号回 `lookupByName`）/ CJK-primary，以及缺表 / 空表 / 无枚举能力 / 表自相
 * 矛盾一律 `[]`（不猜、不抛）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { KojoInstructionTable } from '@kojo/plugin-api';
import { instructionCompletionItems } from '../src/monaco/kojo-completion-instructions';

/** 桩 Monaco：只需 `CompletionItemKind.EnumMember`（其余走类型断言） */
const monaco = {
  languages: { CompletionItemKind: { EnumMember: 22, Function: 4 } },
} as unknown as typeof Monaco;

/** 桩指令表：`摸屁股` / `告白` / `会話` 三条（声明序 = 候选序） */
const NOS: Record<string, number> = { 摸屁股: 310, 告白: 705, 会話: 0 };

function tableOf(names: readonly string[]): KojoInstructionTable {
  return {
    hasTable: names.length > 0,
    lookupByName: (name) => NOS[name],
    lookupByNo: () => undefined,
    names: () => names,
  };
}

const TABLE = tableOf(['摸屁股', '告白', '会話']);

/** 用 `|` 标记光标（1 基列 = 标记前的字符数 + 1）；模型只提供单行内容（纯函数只看当前行） */
function callWith(table: KojoInstructionTable | undefined) {
  return (marked: string) => {
    const line = marked.replace('|', '');
    const column = marked.indexOf('|') + 1;
    const model = { getLineContent: () => line } as unknown as Monaco.editor.ITextModel;
    return instructionCompletionItems(monaco, model, { lineNumber: 1, column } as Monaco.Position, table);
  };
}

const at = callWith(TABLE);
const labels = (items: readonly Monaco.languages.CompletionItem[]): string[] =>
  items.map((i) => i.label as string);

describe('KC-3 指令名补全 · 落点 1：`时机 <分野> <编号位>：`', () => {
  it('`时机 指令 摸|屁股：` → 只留该前缀的指令名，kind = EnumMember', () => {
    const items = at('时机 指令 摸|屁股：');
    expect(labels(items)).toEqual(['摸屁股']);
    expect(items[0]!.kind).toBe(22);
  });

  it('替换范围只覆盖编号令牌（不含块头终结冒号）', () => {
    const items = at('时机 指令 摸|屁股：');
    expect(items[0]!.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 7, endColumn: 10 });
  });

  it('`时机 指令 |` → 全量（声明序），空插入点落在编号位起点', () => {
    const items = at('时机 指令 |');
    expect(labels(items)).toEqual(['摸屁股', '告白', '会話']);
    expect(items[0]!.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 7, endColumn: 7 });
  });

  it('还没写块头冒号也认（`时机 指令 告|`）', () => {
    expect(labels(at('时机 指令 告|'))).toEqual(['告白']);
  });

  it('`detail` = 「指令名 → 编号 N」（编号回 `lookupByName` 取，只用表）', () => {
    const byLabel = Object.fromEntries(at('时机 指令 |').map((i) => [i.label, i]));
    expect(byLabel['摸屁股']!.detail).toBe('指令名 → 编号 310');
    expect(byLabel['会話']!.detail).toBe('指令名 → 编号 0');
  });

  it('编号已写 / 命名参数键位 ⇒ 零候选（那些位置不是编号槽）', () => {
    expect(at('时机 指令 310 |')).toEqual([]);
    expect(at('时机 指令 成否: |')).toEqual([]);
    expect(at('时机 指令 |成否: 游戏判定：')).toEqual([]);
    expect(at('时机 指令 摸屁股 |成否: 游戏判定：')).toEqual([]);
  });

  it('光标仍在分野令牌内 / 无空白间隔 ⇒ 零候选（那一处归 `kojo-face`）', () => {
    expect(at('时机 指|令')).toEqual([]);
    expect(at('时机 指令|')).toEqual([]);
  });
});

describe('KC-3 指令名补全 · 落点 2：`是 <值位>：`（CASE 值）', () => {
  it('`是 摸|屁股：` → 命中；`是 |` → 全量', () => {
    expect(labels(at('是 摸|屁股：'))).toEqual(['摸屁股']);
    expect(labels(at('是 |：'))).toEqual(['摸屁股', '告白', '会話']);
  });

  it('多值（逗号分隔）只补光标所在的那一段', () => {
    expect(labels(at('是 1, 摸|'))).toEqual(['摸屁股']);
    expect(labels(at('是 1, |'))).toEqual(['摸屁股', '告白', '会話']);
  });

  it('`is` 英文别名分支头同样认', () => {
    expect(labels(at('is 告|白：'))).toEqual(['告白']);
  });

  it('前缀过滤：`是 会|` → 会話（编号 0 也照出）', () => {
    expect(labels(at('是 会|'))).toEqual(['会話']);
  });

  it('逗号段内的替换范围只覆盖那个词（多值位）', () => {
    const [item] = at('是 1, 告|白：');
    expect(item!.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 6, endColumn: 8 });
  });
});

describe('KC-3 指令名补全 · fail-closed（绝不猜、绝不抛）', () => {
  it('非落点行：`如果` / `当 x：` / 裸 `是` 半成品 → []', () => {
    expect(at('如果')).toEqual([]);
    expect(at('当 x：')).toEqual([]);
    expect(at('是')).toEqual([]);
    expect(at('是：')).toEqual([]);
  });

  it('字符串内 / 注释内 → []', () => {
    expect(at('是 "1|"：')).toEqual([]);
    expect(at('时机 指令 摸屁股 ; 注|释')).toEqual([]);
    expect(at('; 是 摸|屁股：')).toEqual([]);
  });

  it('表缺省 / 空表 / 无枚举能力 / 表自相矛盾 → [] 且不抛', () => {
    const noNames = callWith({
      hasTable: true,
      lookupByName: () => 1,
      lookupByNo: () => undefined,
    });
    expect(noNames('时机 指令 |')).toEqual([]);
    expect(callWith(tableOf([]))('时机 指令 |')).toEqual([]);
    expect(callWith({ ...TABLE, hasTable: false })('时机 指令 |')).toEqual([]);
    // 枚举有名字、正查却没有编号 = 表自相矛盾 ⇒ 该名跳过（不猜）
    expect(callWith({ ...TABLE, lookupByName: () => undefined })('是 |')).toEqual([]);
    expect(() => at('时机 指令 |')).not.toThrow();
  });
});

describe('KC-3 指令名补全 · CJK-primary（规范 §4.1，同 kojo-face 的 valueSetOf 口径）', () => {
  it('表里有中文名 ⇒ 纯 ASCII 名不进面板', () => {
    expect(labels(callWith(tableOf(['摸屁股', 'ACK']))('时机 指令 |'))).toEqual(['摸屁股']);
  });

  it('表里全是 ASCII 名 ⇒ 原样全出（无中文名可作主形）', () => {
    const ascii: KojoInstructionTable = {
      hasTable: true,
      lookupByName: (n) => (n === 'ACK' ? 1 : n === 'NAK' ? 2 : undefined),
      lookupByNo: () => undefined,
      names: () => ['ACK', 'NAK'],
    };
    expect(labels(callWith(ascii)('时机 指令 |'))).toEqual(['ACK', 'NAK']);
  });
});
