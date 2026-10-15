/**
 * KC-4 · 中文库函数名正向补全（`libraryCompletionItems`）纯逻辑单测。
 *
 * 合成 `KojoLibraryTable`（无游戏名词进源码；函数名只住测试桩），无需语料。
 * 覆盖：标识符位置的判定 / 前缀过滤 / 替换范围 / detail 文案（原生名回 `lookupByName`）/
 * 调用形 insertText / CJK-primary，以及字符串 / 注释 / 插值内与缺表 / 无枚举能力一律 `[]`
 * （不猜、不抛）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { KojoLibraryTable } from '@kojo/plugin-api';
import { libraryCompletionItems } from '../src/monaco/kojo-completion-library';

/** 桩 Monaco：只需 `CompletionItemKind.Function`（其余走类型断言） */
const monaco = {
  languages: { CompletionItemKind: { Function: 4, EnumMember: 22 } },
} as unknown as typeof Monaco;

const NATIVES: Record<string, string> = { 心形: 'HPH_PRINT', 角色文本: 'CHARA_TEXT', 显示表情: 'PRINT_FACE' };

function tableOf(names: readonly string[]): KojoLibraryTable {
  return {
    hasTable: names.length > 0,
    lookupByName: (name) => NATIVES[name],
    names: () => names,
  };
}

const TABLE = tableOf(['心形', '角色文本', '显示表情']);

/** 用 `|` 标记光标（1 基列 = 标记前的字符数 + 1）；模型只提供单行内容（纯函数只看当前行） */
function callWith(table: KojoLibraryTable | undefined) {
  return (marked: string) => {
    const line = marked.replace('|', '');
    const column = marked.indexOf('|') + 1;
    const model = { getLineContent: () => line } as unknown as Monaco.editor.ITextModel;
    return libraryCompletionItems(monaco, model, { lineNumber: 1, column } as Monaco.Position, table);
  };
}

const at = callWith(TABLE);
const labels = (items: readonly Monaco.languages.CompletionItem[]): string[] =>
  items.map((i) => i.label as string);

describe('KC-4 库函数名补全 · 标识符位置出货', () => {
  it('`心|形(` → 前缀过滤命中；kind = Function，insertText = 调用形', () => {
    const items = at('心|形(');
    expect(labels(items)).toEqual(['心形']);
    expect(items[0]!.kind).toBe(4);
    expect(items[0]!.insertText).toBe('心形(');
    expect(items[0]!.filterText).toBe('心形');
  });

  it('`detail` = 「库函数 → 原生名」（原生名回 `lookupByName` 取，只用表）', () => {
    const byLabel = Object.fromEntries(at('|心形(').map((i) => [i.label, i]));
    expect(byLabel['心形']!.detail).toBe('库函数 → HPH_PRINT');
    expect(byLabel['角色文本']!.detail).toBe('库函数 → CHARA_TEXT');
  });

  it('空前缀（光标贴在标识符起点）→ 全量（声明序）', () => {
    expect(labels(at('|心形('))).toEqual(['心形', '角色文本', '显示表情']);
  });

  it('替换范围只覆盖光标所在的那个标识符段', () => {
    const [item] = at('  角|色文本(她)');
    expect(item!.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 3, endColumn: 7 });
  });

  it('行首语句形（`心形 她`）同样在标识符位出货', () => {
    expect(labels(at('心|形 她'))).toEqual(['心形']);
  });
});

describe('KC-4 库函数名补全 · 不给的位置（字符串 / 注释 / 插值 / 非标识符）', () => {
  it('字符串内 → []', () => {
    expect(at('"心|形"')).toEqual([]);
  });

  it('注释内（含行首 `;` 与行内 `;` 之后）→ []', () => {
    expect(at('; 心|形')).toEqual([]);
    expect(at('心形(她) ; 心|形')).toEqual([]);
  });

  it('`{ … }` 插值内 → []（那一处归 kojo-variable）', () => {
    expect(at('{她的|好感}')).toEqual([]);
    expect(at('心形({角|色文本})')).toEqual([]);
  });

  it('非标识符位（标点 / 运算符 / 行尾空白）→ []', () => {
    expect(at('心形 +| 1')).toEqual([]);
    expect(at('   |')).toEqual([]);
  });
});

describe('KC-4 库函数名补全 · fail-closed（绝不猜、绝不抛）', () => {
  it('表缺省 / 空表 / 无枚举能力 / 表自相矛盾 → [] 且不抛', () => {
    const noNames = callWith({ hasTable: true, lookupByName: () => 'X' });
    expect(noNames('心|形')).toEqual([]);
    expect(callWith(tableOf([]))('心|形')).toEqual([]);
    expect(callWith(undefined)('心|形')).toEqual([]);
    expect(callWith({ ...TABLE, hasTable: false })('心|形')).toEqual([]);
    // 枚举有名字、正查却没有原生名 = 表自相矛盾 ⇒ 该名跳过（不猜）
    expect(callWith({ ...TABLE, lookupByName: () => undefined })('|心形(')).toEqual([]);
    expect(() => at('心|形')).not.toThrow();
  });
});

describe('KC-4 库函数名补全 · CJK-primary（规范 §4.1，同 kojo-face 的 valueSetOf 口径）', () => {
  it('表里有中文名 ⇒ 纯 ASCII 名不进面板', () => {
    expect(labels(callWith(tableOf(['心形', 'TEXTR']))('|心形('))).toEqual(['心形']);
  });

  it('表里全是 ASCII 名 ⇒ 原样全出（无中文名可作主形）', () => {
    const ascii: KojoLibraryTable = {
      hasTable: true,
      lookupByName: (n) => (n === 'TEXTR' ? 'TEXTR' : undefined),
      names: () => ['TEXTR'],
    };
    expect(labels(callWith(ascii)('|心形('))).toEqual(['TEXTR']);
  });
});
