/**
 * eraTW 基础库 / 常用函数名表（`KojoLibraryTable`）——把「中文函数名 ↔ 原生 ERB 名」
 * 从糖层搬进 adapter 后的权威回归（ZH-F1）。
 *
 * 断言口径：表是**游戏知识，只住 adapter**；糖层只查不解释。此文件是"表内容漂移 /
 * 反查口径漂移"的可执行凭证——表若被改坏，此处先红。
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_LIBRARY_TABLE,
  ERATW_LIBRARY_FUNCTIONS,
  createEratwLibraryTable,
} from '../src/library-table';

describe('ERATW_LIBRARY_FUNCTIONS · 中文名 → 原生 ERB 名（种子表）', () => {
  it('表非空、覆盖基础库助手全集（种子 55 + ZH-2① + ADICT-1 全覆盖批）', () => {
    expect(ERATW_LIBRARY_FUNCTIONS.size).toBeGreaterThanOrEqual(400);
    // 上限防"把整库函数塞进表"的失控（ADICT-1 后 = 语料基础库档的全部调用名 + 历史条目）
    expect(ERATW_LIBRARY_FUNCTIONS.size).toBeLessThanOrEqual(600);
  });

  it('规范 §3.9 唯一钦定名逐字落地：`心形` → `HPH_PRINT`', () => {
    expect(ERATW_LIBRARY_FUNCTIONS.get('心形')).toBe('HPH_PRINT');
  });

  it('普查 top 基础库助手全部登记（按语料频次手工命名）', () => {
    const expectTop: Record<string, string> = {
      角色文本: 'CHARA_TEXT',
      着色消息: 'COLORMESSAGE',
      随机文本: 'TEXTR',
      询问是非: 'ASK_YN',
      设定口上色: 'SET_KOJO_COLOR',
      调教消息: 'TRAIN_MESSAGE',
      他她: 'HE_SHE_CN',
    };
    for (const [cn, erb] of Object.entries(expectTop)) {
      expect(ERATW_LIBRARY_FUNCTIONS.get(cn), `中文名「${cn}」`).toBe(erb);
    }
  });

  it('中文名键唯一；原生名一律非空（不含引擎内建系统函数名）', () => {
    const names = [...ERATW_LIBRARY_FUNCTIONS.keys()];
    expect(new Set(names).size).toBe(names.length);
    for (const [, erb] of ERATW_LIBRARY_FUNCTIONS) {
      expect(erb.length).toBeGreaterThan(0);
    }
    // 系统函数（跨游戏语言层）不进本表——`获取标记`（GETBIT）住 kojo-sugar 的系统表
    expect(ERATW_LIBRARY_FUNCTIONS.has('获取标记')).toBe(false);
  });
});

describe('createEratwLibraryTable · 查询与反查（纯数据，无 IO）', () => {
  it('builder 由映射建表：`hasTable` 非空即 true，正查/反查各取首条', () => {
    const table = createEratwLibraryTable(
      new Map([
        ['甲名', 'FUNC_A'],
        ['乙名', 'FUNC_B'],
      ]),
    );
    expect(table.hasTable).toBe(true);
    expect(table.lookupByName('甲名')).toBe('FUNC_A');
    expect(table.lookupByName('查无')).toBeUndefined();
    expect(table.lookupByFunction?.('FUNC_B')).toBe('乙名');
    expect(table.lookupByFunction?.('NOPE')).toBeUndefined();
  });

  it('同值多中文名时反查取**首条**（与正查取首条同口径）', () => {
    const table = createEratwLibraryTable(
      new Map([
        ['首名', 'SAME'],
        ['次名', 'SAME'],
      ]),
    );
    expect(table.lookupByFunction?.('SAME')).toBe('首名');
  });

  it('空映射 → `hasTable=false`，查啥都 undefined（绝不猜）', () => {
    const table = createEratwLibraryTable(new Map());
    expect(table.hasTable).toBe(false);
    expect(table.lookupByName('心形')).toBeUndefined();
    expect(table.lookupByFunction?.('HPH_PRINT')).toBeUndefined();
  });

  it('`EMPTY_LIBRARY_TABLE` 即空表实例（未声明适配器时的缺省形态）', () => {
    expect(EMPTY_LIBRARY_TABLE.hasTable).toBe(false);
    expect(EMPTY_LIBRARY_TABLE.lookupByName('角色文本')).toBeUndefined();
  });

  it('正向枚举 names()：按声明序返回（KC-4 正向补全面）', () => {
    const table = createEratwLibraryTable(
      new Map([
        ['甲名', 'FUNC_A'],
        ['乙名', 'FUNC_B'],
      ]),
    );
    expect(table.names?.()).toEqual(['甲名', '乙名']);
  });

  it('空映射 / `EMPTY_LIBRARY_TABLE` 的 names() = []（不猜）', () => {
    expect(createEratwLibraryTable(new Map()).names?.()).toEqual([]);
    expect(EMPTY_LIBRARY_TABLE.names?.()).toEqual([]);
  });
});

/**
 * F12-TOKEN（2026-10-19）③ 的**数据依据**：宿主 `kojo-hover.ts::echoYieldsToIndex` 那条
 * 优先序判据（库表只是回显时让位给项目函数索引）为什么必须按"恒等 / 真翻译"切，而不是
 * 按"中文 / ASCII"切，也不是"索引一律优先"——答案全在这张表自身的形状里。
 *
 * 语料侧的两半（13 条中文原生名**全部**在函数索引里有 `@` 定义；ASCII 同现的 458 条
 * **全部**带真翻译）钉在 `erb-parser/tests/f12-cjk.corpus.test.ts`，本文件只钉盘上表本身。
 */
describe('ERATW_LIBRARY_FUNCTIONS · 恒等条目与真翻译条目的切分（优先序判据的数据面）', () => {
  const entries = [...ERATW_LIBRARY_FUNCTIONS.entries()];
  const nonAscii = entries.filter(([, native]) => /[^\x20-\x7e]/.test(native));
  const identity = entries.filter(([cn, native]) => cn === native);

  it('原生名含非 ASCII 的条目就是那批"库本来就用中文/日文命名"的恒等条目（13 条，一条不多）', () => {
    expect(nonAscii.length).toBe(13);
    expect(nonAscii.every(([cn, native]) => cn === native)).toBe(true);
    expect(new Set(identity.map(([, native]) => native)).size).toBeGreaterThanOrEqual(13);
  });

  it('恒等条目 ≡ 非 ASCII 原生名条目 ⇒ "回显"与"中文原生名"在本表里是同一批（13 条）', () => {
    expect(identity.length).toBe(nonAscii.length);
    expect(identity.map(([cn]) => cn).sort()).toEqual(nonAscii.map(([, native]) => native).sort());
  });

  it('恒等条目反查只是回显（`充填率` → `充填率`）：让位给函数索引不丢任何信息', () => {
    const table = createEratwLibraryTable(ERATW_LIBRARY_FUNCTIONS);
    for (const [, native] of nonAscii) {
      expect(table.lookupByFunction?.(native)).toBe(native);
      expect(table.lookupByName?.(native)).toBe(native);
    }
  });

  it('真翻译条目（中文名 ≠ 原生名）占其余全部 ⇒ "函数索引一律优先"会打沉它们', () => {
    const translated = entries.filter(([cn, native]) => cn !== native);
    expect(translated.length).toBe(entries.length - 13);
    expect(translated.length / entries.length).toBeGreaterThan(0.95);
    // 抽样两条基线库助手：中文名与原生名两样都必须在反查里给得出
    const table = createEratwLibraryTable(ERATW_LIBRARY_FUNCTIONS);
    expect(table.lookupByName?.('加特殊宝珠')).toBe('JUEL_UP_SPECIAL');
    expect(table.lookupByFunction?.('JUEL_UP_SPECIAL')).toBe('加特殊宝珠');
  });
});
