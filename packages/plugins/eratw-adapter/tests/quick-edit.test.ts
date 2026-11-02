/**
 * eraTW「常用状态」策展表的**台账闸**（quick-edit.ts）：
 *
 * 策展表是"教零基础作者改哪个格子"的唯一真源——一条错的（族不存在 / 编号越界 /
 * id 撞名 / 空标签）就是教人写错存档。本文件把「错一条就红」的判据钉死：
 * - 族全在 `ENGINE_FAMILIES`（引擎族全集；variable-schema 同包导出，无跨插件 import）；
 * - id 唯一、非空；label / description 非空；index 非负整数；
 * - scope 只认 'chara' | 'global'（缺省 = 'chara'）；
 * - 布尔型素质（恋慕 / 恋人）必须把「0=没有 1=有」写进说明——新手不知道 0/1 是开关；
 * - 全局项（MONEY）必须标 scope: 'global'，角色项必须 'chara'（面板按它路由作用域）。
 */

import { describe, expect, it } from 'vitest';
import { ERATW_QUICK_EDIT_FIELDS } from '../src/quick-edit';
import { ENGINE_FAMILIES } from '../src/variable-schema';

describe('ERATW_QUICK_EDIT_FIELDS：策展台账闸', () => {
  it('每一条的族都在引擎族全集里（写错族头 = 面板永远找不到变量）', () => {
    const families = new Set(ENGINE_FAMILIES);
    for (const f of ERATW_QUICK_EDIT_FIELDS) {
      expect(families.has(f.family), `${f.id}: 族 ${f.family} 不在 ENGINE_FAMILIES`).toBe(true);
    }
  });

  it('id 唯一且非空；label / description 非空；index 是非负整数', () => {
    const ids = new Set<string>();
    for (const f of ERATW_QUICK_EDIT_FIELDS) {
      expect(f.id.length, 'id 非空').toBeGreaterThan(0);
      expect(ids.has(f.id), `${f.id}: id 撞名`).toBe(false);
      ids.add(f.id);
      expect(f.label.length, `${f.id}: label 非空`).toBeGreaterThan(0);
      expect((f.description ?? '').length, `${f.id}: description 非空（新手靠它理解这格是什么）`).toBeGreaterThan(0);
      expect(Number.isInteger(f.index), `${f.id}: index 是整数`).toBe(true);
      expect(f.index, `${f.id}: index 非负`).toBeGreaterThanOrEqual(0);
    }
  });

  it('scope 只认两态；布尔型素质必须写明 0/1 语义', () => {
    for (const f of ERATW_QUICK_EDIT_FIELDS) {
      expect(['chara', 'global', undefined]).toContain(f.scope);
      if (f.family === 'TALENT') {
        expect(f.description, `${f.id}: 素质说明必须写明 0=没有 1=有`).toMatch(/0=没有\s*1=有/);
      }
    }
    const money = ERATW_QUICK_EDIT_FIELDS.find((f) => f.family === 'MONEY');
    expect(money?.scope, '全局项必须标 global（面板按它路由到主变量区）').toBe('global');
    const cflag = ERATW_QUICK_EDIT_FIELDS.find((f) => f.family === 'CFLAG');
    expect(cflag?.scope, '角色项必须 chara').toBe('chara');
  });

  it('好感度 / 信頼度 的编号与 docs/STATE.md 的 CFLAG.csv 实证一致（2 / 4）', () => {
    const byId = new Map(ERATW_QUICK_EDIT_FIELDS.map((f) => [f.id, f]));
    expect(byId.get('cflag-affection')).toMatchObject({ family: 'CFLAG', index: 2 });
    expect(byId.get('cflag-trust')).toMatchObject({ family: 'CFLAG', index: 4 });
  });
});
