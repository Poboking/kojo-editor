/**
 * KC-2 · 时机分野补全（`faceCompletionItems`）纯逻辑单测。
 *
 * 合成 `KojoFaceTable`（无游戏名词进源码；分野名只住测试桩），无需语料。
 * 覆盖：行首 `时机 ` → 全量分野；`时机 初` → 前缀过滤；行中 / 非 `时机` 行首 / 光标越过分野段
 * → `[]`；已含块头 `：` → `[]`；表缺省 → `[]`；range 只替换分野名那一段。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { KojoFaceTable } from '@kojo/plugin-api';
import { faceCompletionItems } from '../src/monaco/kojo-completion-faces';

/** 桩 Monaco：只需 `CompletionItemKind.EnumMember`（其余走类型断言） */
const monaco = {
  languages: { CompletionItemKind: { EnumMember: 22, Constant: 21 } },
} as unknown as typeof Monaco;

const faceTable: KojoFaceTable = {
  faces: {
    初见: { template: 'M_KOJO{t}_ENCOUNTER_K{n}' },
    事件: { template: 'M_KOJO{t}_EVENT_K{n}_{i}' },
    指令: {
      template: 'M_KOJO{t}_MESSAGE_${com}_K{n}_{i}',
      success: { template: 'M_KOJO{t}_SUCCESS_${com}_K{n}_{i}' },
      segments: { com: { COM: 'COM', SCOM: 'SCOM' } },
      messageCheck: { template: 'M_KOJO{t}_MESSAGE_MESSAGECHECK_${com}_K{n}_{i}' },
    },
    绝顶恶作剧: { template: 'M_KOJO{t}_MESSAGE_PALAMCNG_B2_K{n}' },
  },
};

/** 用 `|` 标记光标（1 基列 = 标记前的字符数 + 1）；模型只提供单行内容（provider 只看当前行） */
function callWith(table: KojoFaceTable | undefined) {
  return (marked: string) => {
    const line = marked.replace('|', '');
    const column = marked.indexOf('|') + 1;
    const model = { getLineContent: () => line } as unknown as Monaco.editor.ITextModel;
    return faceCompletionItems(monaco, model, { lineNumber: 1, column } as Monaco.Position, table);
  };
}
const callAt = callWith(faceTable);

const texts = (items: Monaco.languages.CompletionItem[]) => items.map((i) => i.insertText);

describe('时机分野补全 · 行首 `时机 ` → 全量分野', () => {
  it('候选 = 表键全量，顺序即声明序，kind = EnumMember', () => {
    const items = callAt('时机 |');
    expect(texts(items)).toEqual(['初见', '事件', '指令', '绝顶恶作剧']);
    expect(items.every((i) => i.kind === monaco.languages.CompletionItemKind.EnumMember)).toBe(true);
  });

  it('前缀为空 → 替换范围为空区间（落在分野名起点）', () => {
    const [first] = callAt('时机 |');
    expect(first!.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 4, endColumn: 4 });
  });

  it('detail / documentation 取模板可读字段', () => {
    const byKind = Object.fromEntries(callAt('时机 |').map((i) => [i.insertText, i]));
    expect(byKind['初见']!.detail).toBe('M_KOJO{t}_ENCOUNTER_K{n}');
    expect(byKind['指令']!.detail).toBe('M_KOJO{t}_MESSAGE_${com}_K{n}_{i}');
    const doc = byKind['指令']!.documentation as { value: string };
    expect(doc.value).toContain('SUCCESS');
    expect(doc.value).toContain('MESSAGECHECK');
  });

  it('行首容许多个空白 / 半角空格', () => {
    expect(texts(callAt('时机   初|'))).toEqual(['初见']);
  });
});

describe('时机分野补全 · 已输入前缀 → 前缀过滤', () => {
  it('`时机 初` → 仅 `初` 开头的分野', () => {
    expect(texts(callAt('时机 初|'))).toEqual(['初见']);
  });

  it('前缀 `事` → 事件', () => {
    expect(texts(callAt('时机 事|'))).toEqual(['事件']);
  });

  it('替换范围只覆盖已输入的分野名那一段', () => {
    const [item] = callAt('时机 初|');
    expect(item!.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 4, endColumn: 5 });
  });
});

describe('时机分野补全 · 位置不符 / 表缺省 → []', () => {
  it('非 `时机` 行首（普通正文行 / 行中）→ []', () => {
    expect(callAt('IF |CFLAG:TARGET:1')).toEqual([]);
    expect(callAt('她点了|点头。')).toEqual([]);
    expect(callAt('口上: 时机 |')).toEqual([]);
  });

  it('`时机` 与之后无空白（未成块头）→ []', () => {
    expect(callAt('时机|')).toEqual([]);
  });

  it('光标落在 `时机 ` 之内（早于分野名）→ []', () => {
    expect(callAt('时|机 初')).toEqual([]);
  });

  it('光标越过分野名（落在编号 / 命名参数上）→ []', () => {
    expect(callAt('时机 指令 310|')).toEqual([]);
  });

  it('分野表缺省 → []', () => {
    expect(callWith(undefined)('时机 |')).toEqual([]);
  });
});

describe('时机分野补全 · 块头已收尾（含 `：`）→ []', () => {
  it('`时机 初|见：` → []（该名之后已有全角冒号）', () => {
    expect(callAt('时机 初|见：')).toEqual([]);
  });

  it('带命名参数的完整块头，光标在分野名上 → []', () => {
    expect(callAt('时机 指|令 310 成否: 游戏判定：')).toEqual([]);
  });
});

describe('时机分野补全 · 替换范围只覆盖分野名段（不含编号）', () => {
  it('`时机 指|令 310` → range 覆盖 `指令`，不含 `310`', () => {
    const items = callAt('时机 指|令 310');
    expect(texts(items)).toEqual(['指令']);
    expect(items[0]!.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 4, endColumn: 6 });
  });
});

/* ==================== 新增：空白口径与转译器对齐（全角空格 U+3000 也是空白） ==================== */

const FW = '　'; // 全角空格 U+3000——转译器 lexer 一律接受，补全面此前手抄 `[ \t]` 漏掉它

describe('时机分野补全 · 全角空格形态（能编译 ⇒ 必须出候选）', () => {
  it('`时机` 后全角空格分隔 → 前缀过滤照旧（`时机　初|` → 初见）', () => {
    expect(texts(callAt(`时机${FW}初|`))).toEqual(['初见']);
  });

  it('全角缩进 + 半角分隔（`　时机 初|`）→ 初见', () => {
    expect(texts(callAt(`${FW}时机 初|`))).toEqual(['初见']);
  });

  it('Tab 缩进 + 全角分隔（`\t时机　初|`）→ range 起点随全角空格后移一位', () => {
    const items = callAt(`\t时机${FW}初|`);
    expect(texts(items)).toEqual(['初见']);
    expect(items[0]!.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 5, endColumn: 6 });
  });

  it('全角空格后尚未写分野名（`时机　|`）→ 全量分野', () => {
    expect(texts(callAt(`时机${FW}|`))).toEqual(['初见', '事件', '指令', '绝顶恶作剧']);
  });

  it('全角空格 + 块头已收尾（`时机　初|见：`）→ []（与半角同判）', () => {
    expect(callAt(`时机${FW}初|见：`)).toEqual([]);
  });

  it('回归不变：同一行的半角 / 全角写法候选逐项相等（半角零回退）', () => {
    expect(texts(callAt(`时机${FW}指|令 310`))).toEqual(texts(callAt('时机 指|令 310')));
    expect(callAt('时机指令|')).toEqual([]); // `时机` 后无空白 ⇒ 两种写法都不认
    expect(callAt(`时机${FW}指令 310|`)).toEqual([]); // 光标越过分野段 ⇒ 交回编号槽那一路
  });
});
