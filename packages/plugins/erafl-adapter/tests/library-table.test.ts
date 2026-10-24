/**
 * eraFL 基础库函数中文化表（`KojoLibraryTable`）—— **入口 C 的权威回归**。
 *
 * 断言口径：表是**游戏知识，只住 adapter**；糖层只查不解释。此文件是「表内容漂移 /
 * 反查口径漂移 / 与系统表撞名」的可执行凭证——表若被改坏，此处先红。
 *
 * 真盘覆盖率闸另立（`library-coverage.corpus.test.ts`）：那份钉"表对语料的覆盖"，
 * 这份钉"表自身的形状与接线"。两者分开的理由：形状是**不变量**（无盘也成立），
 * 覆盖率**换盘就变**（只能以真盘为守卫）。
 */

import { describe, expect, it } from 'vitest';
import { SYSTEM_FUNCTION_ALIASES } from '../../kojo-sugar/src/system-functions';
import {
  EMPTY_LIBRARY_TABLE,
  ERAFL_LIBRARY_CONFLICTS,
  ERAFL_LIBRARY_FUNCTIONS,
  createEraflLibraryTable,
} from '../src/library-table';
import { activateAdapter, nodeIo } from './harness';

describe('ERAFL_LIBRARY_FUNCTIONS · 中文名 → 原生 ERB 名', () => {
  it('表非空且在册（170 = 口上域调用 ≥2 次的全部基础库函数）', () => {
    // 下限防"表被 pruning 掉一半"，上限防"把整个游戏 @ 函数库塞进表"
    expect(ERAFL_LIBRARY_FUNCTIONS.size).toBeGreaterThanOrEqual(160);
    expect(ERAFL_LIBRARY_FUNCTIONS.size).toBeLessThanOrEqual(220);
  });

  it('头部高频助手逐条落地（2026-10-25 真盘读数；改表必须同时改这里）', () => {
    const expectTop: Record<string, string> = {
      角色名: 'ANAME', // 2,569 处
      口上色打印: 'KJ_PRINT', // 904
      分栏打印: 'PRINT_DIAG', // 884
      名转角色号: 'NAME_TO_CHARA', // 578
      有主导权: 'IS_INITIATIVE', // 496
      显示立绘: 'DRAW_PORTRAIT', // 487
      注册口上XML: 'KOJO_XML_REGISTER', // 290
    };
    for (const [cn, erb] of Object.entries(expectTop)) {
      expect(ERAFL_LIBRARY_FUNCTIONS.get(cn), `中文名「${cn}」`).toBe(erb);
    }
  });

  it('中文名键唯一；原生名一律是合法 ERB 标识符', () => {
    const names = [...ERAFL_LIBRARY_FUNCTIONS.keys()];
    expect(new Set(names).size).toBe(names.length);
    for (const [cn, erb] of ERAFL_LIBRARY_FUNCTIONS) {
      expect(cn.length, `中文名为空：${erb}`).toBeGreaterThan(0);
      expect(erb, `原生名「${erb}」`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });

  it('不与系统函数表撞名（系统表优先 ⇒ 撞名条目是死条目）', () => {
    const collisions = [...ERAFL_LIBRARY_FUNCTIONS.keys()].filter((cn) =>
      SYSTEM_FUNCTION_ALIASES.has(cn),
    );
    expect(collisions, `与 SYSTEM_FUNCTION_ALIASES 重名：${collisions.join('、')}`).toEqual([]);
  });

  it('被系统表占掉的同名条目记在 ERAFL_LIBRARY_CONFLICTS 里（不是悄悄删掉）', () => {
    // 冲突名必须真的撞上系统表，否则这条账就是过期的（说明局势变了、注释要重写）
    const names = [...ERAFL_LIBRARY_CONFLICTS.keys()];
    expect(names.length).toBeGreaterThan(0);
    for (const cn of names) {
      expect(SYSTEM_FUNCTION_ALIASES.has(cn), `「${cn}」已不撞系统表`).toBe(true);
      // 且**不在**表里：两边都收会让读者以为中文名指 eraFL 的那条
      expect(ERAFL_LIBRARY_FUNCTIONS.has(cn), `「${cn}」不该同时进表`).toBe(false);
      expect(ERAFL_LIBRARY_CONFLICTS.get(cn)?.reason.length ?? 0).toBeGreaterThan(0);
    }
    // 已知那一条：内建 GETPALAMLV vs eraFL 的 GET_PALAMLV（差一个下划线）
    expect(ERAFL_LIBRARY_CONFLICTS.get('取参数等级')?.erb).toBe('GET_PALAMLV');
  });

  it('引擎内建一律不进本表（跨游戏语言层归 kojo-sugar）', () => {
    for (const cn of ['获取标记', '首次', '取子串', '转字符串']) {
      expect(ERAFL_LIBRARY_FUNCTIONS.has(cn), `系统名「${cn}」不该在 adapter 表里`).toBe(false);
    }
    // 反向：表里不许出现引擎内建的原生名（GETBIT/FIRSTTIME 等）
    const erbNames = new Set([...ERAFL_LIBRARY_FUNCTIONS.values()]);
    for (const builtin of ['GETBIT', 'SETBIT', 'FIRSTTIME', 'SUBSTRING', 'TOSTR']) {
      expect(erbNames.has(builtin), `引擎内建「${builtin}」不该在 adapter 表里`).toBe(false);
    }
  });
});

describe('createEraflLibraryTable · 查询与反查（纯数据，无 IO）', () => {
  it('builder 由映射建表：`hasTable` 非空即 true，正查/反查各取首条', () => {
    const table = createEraflLibraryTable(
      new Map([
        ['甲名', 'FUNC_A'],
        ['乙名', 'FUNC_B'],
      ]),
    );
    expect(table.hasTable).toBe(true);
    expect(table.lookupByName('甲名')).toBe('FUNC_A');
    expect(table.lookupByName('不存在')).toBeUndefined();
    expect(table.lookupByFunction?.('FUNC_A')).toBe('甲名');
    expect(table.lookupByFunction?.('NOPE')).toBeUndefined();
    expect(table.names?.()).toEqual(['甲名', '乙名']);
  });

  it('同原生名多条中文名：反查取**声明序首条**（与 eraTW 同口径）', () => {
    const table = createEraflLibraryTable(
      new Map([
        ['甲名', 'SAME'],
        ['乙名', 'SAME'],
      ]),
    );
    expect(table.lookupByFunction?.('SAME')).toBe('甲名');
  });

  it('空表：hasTable=false、查啥都 undefined、枚举空数组', () => {
    expect(EMPTY_LIBRARY_TABLE.hasTable).toBe(false);
    expect(EMPTY_LIBRARY_TABLE.lookupByName('角色名')).toBeUndefined();
    expect(EMPTY_LIBRARY_TABLE.lookupByFunction?.('ANAME')).toBeUndefined();
    expect(EMPTY_LIBRARY_TABLE.names?.()).toEqual([]);
  });

  it('真实表的反查：每个原生名都能反查到某个中文名（一一对应）', () => {
    const table = createEraflLibraryTable(ERAFL_LIBRARY_FUNCTIONS);
    for (const [cn, erb] of ERAFL_LIBRARY_FUNCTIONS) {
      expect(table.lookupByFunction?.(erb), `反查失败：${erb}`).toBeDefined();
      expect(table.lookupByName(cn)).toBe(erb);
    }
    expect(table.names?.().length).toBe(ERAFL_LIBRARY_FUNCTIONS.size);
  });
});

describe('接线：v1 adapter 暴露 kojoLibraryTable', () => {
  it('`game.adapter` 槽位拿到的 adapter 带表（非空、可查）', () => {
    const adapter = activateAdapter(nodeIo());
    const table = adapter.kojoLibraryTable;
    expect(table, 'adapter 没有 kojoLibraryTable（入口 C 未接线）').toBeDefined();
    expect(table?.hasTable).toBe(true);
    expect(table?.lookupByName('角色名')).toBe('ANAME');
    expect(table?.lookupByFunction?.('ANAME')).toBe('角色名');
  });
});
