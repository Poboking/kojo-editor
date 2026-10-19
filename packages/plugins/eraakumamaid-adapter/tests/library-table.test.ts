/**
 * eraAkumaMaid 基础库函数名表（`KojoLibraryTable`）——收录回归（2026-10-19 P5 批）。
 *
 * 断言口径分两层：
 * - **形态**：原生名合法（`^[A-Z][A-Z0-9_]*$`）、无重名、中文名不含冒号 / 空白
 *   （中文名会被作者写进 `族:…` 那样的引用位，冒号是分隔符，含冒号即不可用）；
 * - **边界**：引擎内建与作者私有**必须查不到**——这是"游戏知识只住 adapter、跨游戏语言层
 *   住 kojo-sugar"这条分层的可执行凭证。少了这几条，"表里混进了 GETBIT" 这种事没人会发现。
 *
 * 映射逐条证据（调用点次数 / 定义文件）见 `src/library-table.ts` 各条目行尾注释。
 */

import { describe, expect, it } from 'vitest';
import { AM_LIBRARY_FUNCTIONS, createErakumamaidLibraryTable } from '../src/library-table';

const table = createErakumamaidLibraryTable(AM_LIBRARY_FUNCTIONS);

describe('AM 基础库函数名表 · 形态', () => {
  it('收录 45 条，`hasTable` 为真（空表才是 false）', () => {
    expect(AM_LIBRARY_FUNCTIONS.size).toBe(45);
    expect(table.hasTable).toBe(true);
  });

  it('原生名形态合法且无重复（重复会让反查"取首条"变成掷骰子）', () => {
    const seen = new Set<string>();
    for (const [cn, erb] of AM_LIBRARY_FUNCTIONS) {
      expect(erb, `中文名「${cn}」的原生名形态`).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(seen.has(erb), `原生名「${erb}」被两条中文名指向`).toBe(false);
      seen.add(erb);
    }
    expect(seen.size).toBe(AM_LIBRARY_FUNCTIONS.size);
  });

  it('中文名不含冒号 / 空白（中文名会落进引用位，冒号是族与槽的分隔符）', () => {
    for (const cn of AM_LIBRARY_FUNCTIONS.keys()) {
      expect(cn, `中文名「${cn}」`).not.toMatch(/[:：\s]/);
    }
  });

  it('`names()` 按声明序返回全部键（正向补全的唯一名字源，不另排序）', () => {
    expect(table.names?.()).toEqual([...AM_LIBRARY_FUNCTIONS.keys()]);
    expect(table.names?.()).toHaveLength(45);
    // 声明序首条 = 「条件判定」（`src` 里条件/判定族排在最前）
    expect(table.names?.()[0]).toBe('条件判定');
  });
});

describe('AM 基础库函数名表 · 映射（抽查：每条都对着语料里的定义行）', () => {
  it('文本 / 条件 / 事件记录 / 服装 / 编号各族都通', () => {
    const cases: Array<[string, string]> = [
      ['随机文本', 'TEXTR'], // FUNCTION.ERB（9920 处调用）
      ['条件判定', 'COND'], // FUNCTION.ERB（10376）
      ['首次指令', 'FIRSTCOM'], // FUNCTION_COM.ERB（6066）
      ['事件记录', 'CEVENT'], // FUNCTION_COM.ERB（4550）
      ['日常事件记录', 'DEVENT'], // FUNCTION_DAILY.ERB（1643）
      ['穿着判定', 'CHECK_CLO'], // CLOTHES.ERB（1394）
      ['角色号', 'CNUM'], // FUNCTION.ERB（211）
      ['搭档编号', 'PARTNER'], // FUNCTION.ERB：`RETURNF TARGET:9`
      ['颜色值', 'DEF_COLOR'], // FUNCTION.ERB（130）
    ];
    for (const [cn, erb] of cases) {
      expect(table.lookupByName(cn), `中文名「${cn}」`).toBe(erb);
    }
  });

  it('反查（原生名 → 中文名）取首条；未登记一律 undefined（不猜）', () => {
    expect(table.lookupByFunction?.('TEXTR')).toBe('随机文本');
    expect(table.lookupByFunction?.('NOT_A_REAL_FUNCTION')).toBeUndefined();
    expect(table.lookupByName('这个中文名不存在')).toBeUndefined();
  });
});

describe('AM 基础库函数名表 · 边界（不属于本表的两类必须查不到）', () => {
  it('引擎内建系统函数**不**收录（它们住 kojo-sugar 的 `SYSTEM_FUNCTION_ALIASES`）', () => {
    for (const builtin of ['GETBIT', 'SETBIT', 'GETNUM', 'STRCOUNT', 'FINDCHARA', 'MAX', 'MIN']) {
      expect(table.lookupByName(builtin), builtin).toBeUndefined();
      expect(table.lookupByFunction?.(builtin), builtin).toBeUndefined();
    }
  });

  it('作者私有 `@函数` **不**收录（`KOJO_*` / `K{n}_*` 属投影读侧通道）', () => {
    for (const priv of ['KOJO_MESSAGE_COM_K1', 'K1_KOJO2', 'KOJO_DAILY_K1']) {
      expect(table.lookupByFunction?.(priv), priv).toBeUndefined();
      expect(table.lookupByName(priv), priv).toBeUndefined();
    }
  });

  it('空表实例：`hasTable=false`，三个查询面都吐空（未声明适配器时的缺省行为）', () => {
    const empty = createErakumamaidLibraryTable(new Map());
    expect(empty.hasTable).toBe(false);
    expect(empty.lookupByName('随机文本')).toBeUndefined();
    expect(empty.lookupByFunction?.('TEXTR')).toBeUndefined();
    expect(empty.names?.()).toEqual([]);
  });
});
