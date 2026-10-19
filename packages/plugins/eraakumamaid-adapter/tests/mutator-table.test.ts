/**
 * eraAkumaMaid 增减族表（`KojoMutatorTable`）——直写形态回归（2026-10-19 P5 批）。
 *
 * 本表的存在理由只有一条：**本游戏没有增减封装函数**。eraTW 的 `CHANGE_CFLAG` /
 * `BUFF_BASE` 在这里全语料 0 处，增减一律直写 `族:对象:槽 += n`。所以五项规格
 * 全部是 `form: 'assign'`，任何一项漏成 `'call'` 都会降出一条调不存在函数的 `CALL`。
 *
 * 断言分两层：
 * - **形态**：`form` / `template` / `slotMode` 三样逐字钉死（模板漂了 = 产物左值漂了）；
 * - **边界**：一维数组族（`JUEL` / `SOURCE`）与位标志族（`TALENT`）**必须查不到**——
 *   它们有加减写法但拼不出三段左值，收进来只会让作者写出编不过的行。
 */

import { describe, expect, it } from 'vitest';
import { AM_MUTATOR_FAMILIES, createErakumamaidMutatorTable } from '../src/mutator-table';

const table = createErakumamaidMutatorTable(AM_MUTATOR_FAMILIES);

describe('AM 增减族表 · 形态', () => {
  it('收录 5 族，`hasTable` 为真', () => {
    expect(AM_MUTATOR_FAMILIES.size).toBe(5);
    expect(table.hasTable).toBe(true);
  });

  it('全部是 `assign` 形态（本游戏没有增减封装函数，一条 `call` 都不该有）', () => {
    for (const [family, spec] of AM_MUTATOR_FAMILIES) {
      expect(spec.form, `族「${family}」`).toBe('assign');
      // 类型层面 assign 形态根本没有 engine / argOrder；运行期也不该有
      expect((spec as unknown as Record<string, unknown>).engine, `族「${family}」`).toBeUndefined();
      expect((spec as unknown as Record<string, unknown>).argOrder, `族「${family}」`).toBeUndefined();
    }
  });

  it('模板逐字钉死（左值 = 原生族头 + 对象 + 槽，与语料 `CFLAG:MASTER:勉強時間 +=` 同形）', () => {
    const expected: Record<string, string> = {
      CFLAG: 'CFLAG:{object}:{slot}',
      BASE: 'BASE:{object}:{slot}',
      EXP: 'EXP:{object}:{slot}',
      PALAM: 'PALAM:{object}:{slot}',
      ABL: 'ABL:{object}:{slot}',
    };
    expect(Object.keys(expected).sort()).toEqual([...AM_MUTATOR_FAMILIES.keys()].sort());
    for (const [family, tpl] of Object.entries(expected)) {
      const spec = table.lookupByFamily(family);
      expect(spec, `族「${family}」`).toBeDefined();
      if (spec?.form !== 'assign') throw new Error(`族「${family}」不是 assign 形态，模板无从比较`);
      expect(spec.template, `族「${family}」的模板`).toBe(tpl);
      // 占位只允许 {family} / {object} / {slot} 三种，且本项目不用 {family}
      expect(spec.template.match(/\{[a-z]+\}/g)).toEqual(['{object}', '{slot}']);
    }
  });

  it('槽形态一律 `name-or-number`（语料里五个族写的都是名字：体力 / 魂 / 好感度 / 反感）', () => {
    for (const [family, spec] of AM_MUTATOR_FAMILIES) {
      expect(spec.slotMode, `族「${family}」`).toBe('name-or-number');
    }
  });
});

describe('AM 增减族表 · 边界（有加减写法但拼不出三段左值的族不收）', () => {
  it('一维数组族 `JUEL` / `SOURCE` 查不到（没有「对象」段）', () => {
    for (const family of ['JUEL', 'SOURCE']) {
      expect(table.lookupByFamily(family), family).toBeUndefined();
    }
  });

  it('位标志族 `TALENT` 查不到（改法是置位 / 清位，不是加减）', () => {
    expect(table.lookupByFamily('TALENT')).toBeUndefined();
  });

  it('未登记族一律 undefined（绝不猜）', () => {
    expect(table.lookupByFamily('CFLAGS')).toBeUndefined();
    expect(table.lookupByFamily('')).toBeUndefined();
  });

  it('空表实例：`hasTable=false`，查啥都 undefined', () => {
    const empty = createErakumamaidMutatorTable(new Map());
    expect(empty.hasTable).toBe(false);
    expect(empty.lookupByFamily('CFLAG')).toBeUndefined();
  });
});
