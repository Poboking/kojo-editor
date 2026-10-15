/**
 * ZH-F2 · 悬停**中文名**解析（`resolveHoverName`）纯逻辑单测。
 *
 * Monaco 绑定（`installHover`）刻意薄——本文件只测"光标位置 + 三张表 → 中文名"的解析，
 * 不引入 Monaco（注册只做协议翻译，逻辑全在纯函数里）。
 *
 * 覆盖：数值变量索引（`CFLAG:TARGET:1088` → 好感度）、英文函数名（系统表反向 + adapter
 * 基础库表反查）、指令编号（只在糖的 `时机 <分野> <编号>：` 块头里认）；以及三组
 * **fail-visible 负例**（表缺席 / 查不到 / 上下文不可证明一律不显示——**绝不猜**）。
 */

import { describe, expect, it } from 'vitest';
import type { KojoInstructionTable, KojoLibraryTable } from '@kojo/plugin-api';
import type { DictionaryLookup } from '@kojo/plugin-kojo-sugar';
import { type HoverTables, resolveHoverName } from '../src/monaco/kojo-hover';

/** 桩变量字典：CFLAG 1088 = 好感度（另含一条具名索引，用于钉住"中文名不进反查面"） */
const dict: DictionaryLookup = {
  resolveFamily: () => undefined,
  resolve: () => undefined,
  nameAt: (family, index) => {
    if (family === 'CFLAG' && index === '1088') return '好感度';
    if (family === 'TALENT' && index === '结婚') return '结婚';
    return undefined;
  },
};

/** 桩基础库表（形状与 adapter 的 `KojoLibraryTable` 同构） */
const lib: KojoLibraryTable = {
  hasTable: true,
  lookupByName: (name) => (name === '心形' ? 'HPH_PRINT' : undefined),
  lookupByFunction: (fn) => (fn === 'HPH_PRINT' ? '心形' : undefined),
};

/** 桩指令表 */
const instr: KojoInstructionTable = {
  hasTable: true,
  lookupByName: (name) => (name === '亲吻' ? 310 : undefined),
  lookupByNo: (no) => (no === 310 ? '亲吻' : undefined),
};

const tables: HoverTables = { dictionary: dict, libraryTable: lib, instructionTable: instr };

/** 用 `|` 标记光标处（1 基列 = 标记前的字符数 + 1），返回解析结果 */
const at = (marked: string, t: HoverTables = tables) =>
  resolveHoverName(marked.replace('|', ''), marked.indexOf('|') + 1, t);

describe('悬停中文名 · 数值变量索引', () => {
  it('`CFLAG:TARGET:1088` 的光标落在索引上 → 好感度', () => {
    const hit = at('IF CFLAG:TARGET:|1088 >= 500');
    expect(hit?.name).toBe('好感度');
    expect(hit?.kind).toContain('变量');
  });

  it('光标落在索引**中间**同样命中（命中区间覆盖整串引用）', () => {
    const hit = at('IF CFLAG:TARGET:1|088 >= 500');
    expect(hit?.name).toBe('好感度');
    expect(hit?.startColumn).toBe('IF '.length + 1);
    expect(hit?.endColumn).toBe('IF CFLAG:TARGET:1088'.length + 1);
  });
});

describe('悬停中文名 · 英文函数名', () => {
  it('系统函数表反向：`GETBIT` → 获取标记（值不动、只换名字）', () => {
    const hit = at('SIF |GETBIT(A,0)');
    expect(hit?.name).toBe('获取标记');
    expect(hit?.kind).toContain('GETBIT');
  });

  it('adapter 基础库表反查：`HPH_PRINT` → 心形', () => {
    expect(at('CALL |HPH_PRINT,@"文本","W"')?.name).toBe('心形');
  });
});

describe('悬停中文名 · 指令编号（只在可证明的块头里认）', () => {
  it('糖的 `时机 指令 310：` 块头 → 亲吻', () => {
    const hit = at('时机 指令 |310：');
    expect(hit?.name).toBe('亲吻');
    expect(hit?.kind).toContain('指令');
  });

  it('负例：同一个数字出现在别处（无 `时机 <分野> ` 前缀）→ 不显示', () => {
    expect(at('A = |310')).toBeUndefined();
    expect(at('IF FLAG:|310 == 0')).toBeUndefined();
  });
});

describe('悬停中文名 · fail-visible 负例（绝不猜）', () => {
  it('未收录的函数名 / 查不到的索引 → 不显示', () => {
    expect(at('SIF |MY_FUNC(1)')).toBeUndefined();
    expect(at('IF CFLAG:TARGET:|9999 >= 1')).toBeUndefined();
  });

  it('具名索引（中文名）不进反查面：分词只吃 ASCII 与 `:`（数字索引才是本线证得的形状）', () => {
    expect(at('IF TALENT:TARGET:|结婚')).toBeUndefined();
  });

  it('adapter 表全缺席（无项目 / 适配器未激活）→ 语言级系统表照常，adapter 侧一律不显示', () => {
    expect(at('IF CFLAG:TARGET:|1088 >= 500', {})).toBeUndefined(); // 变量字典缺席
    expect(at('SIF |GETBIT(A,0)', {})?.name).toBe('获取标记'); // 系统表是语言层，与项目无关
    expect(at('CALL |HPH_PRINT,@"文本","W"', {})).toBeUndefined(); // 基础库表缺席
    expect(at('时机 指令 |310：', {})).toBeUndefined(); // 指令表缺席
  });

  it('光标落在空格 / 空白处 → 不显示', () => {
    expect(at('IF |  A')).toBeUndefined();
    expect(at('|')).toBeUndefined();
  });
});
