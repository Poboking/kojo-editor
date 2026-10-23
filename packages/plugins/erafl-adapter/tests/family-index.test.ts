/**
 * 家族索引（后缀式 `{家族}_K{n}`）。
 *
 * 钉两件事：① 五族各自归属正确、`KOJO_DEFINE` 不会截胡更长的兄弟族；
 * ② 与口上无关的函数一律 null（"不猜"是导航不串角色的前提）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERAFL_FACE_LABELS, ERAFL_FAMILIES, createEraflFamilyIndex, parseKojoFamily } from '../src/family-index';

const GAME_ROOT = 'D:/Game/erafl';
const hasCorpus = existsSync(GAME_ROOT);

describe('parseKojoFamily —— 五族归属', () => {
  it('KOJO_DEFINE_K1099 → 家族 KOJO_DEFINE、角色 1099', () => {
    expect(parseKojoFamily('KOJO_DEFINE_K1099')).toMatchObject({
      kind: 'ok',
      prefix: 'KOJO',
      family: 'KOJO_DEFINE',
      characterNo: 1099,
      slot: '',
    });
  });

  it('KOJO_DEFINE_NAME_K1099 → 家族 KOJO_DEFINE_NAME（不被 KOJO_DEFINE 截胡）', () => {
    expect(parseKojoFamily('KOJO_DEFINE_NAME_K1099')).toMatchObject({
      family: 'KOJO_DEFINE_NAME',
      characterNo: 1099,
    });
  });

  it('KOJO_DEFINE_KOJO_INFO_K5192 → 家族 KOJO_DEFINE_KOJO_INFO、主角编号 5192', () => {
    expect(parseKojoFamily('KOJO_DEFINE_KOJO_INFO_K5192')).toMatchObject({
      family: 'KOJO_DEFINE_KOJO_INFO',
      characterNo: 5192,
    });
  });

  it('KOJO_FOR_MALE_K1101 / KOJO_FOR_FEMALE_K1099 → 两个性别适配族', () => {
    expect(parseKojoFamily('KOJO_FOR_MALE_K1101')).toMatchObject({
      family: 'KOJO_FOR_MALE',
      characterNo: 1101,
    });
    expect(parseKojoFamily('KOJO_FOR_FEMALE_K1099')).toMatchObject({
      family: 'KOJO_FOR_FEMALE',
      characterNo: 1099,
    });
  });
});

describe('parseKojoFamily —— 名字噪声容错', () => {
  it('入参声明 `(CHARA_ID)` 与 `, ARGS` 不影响编号', () => {
    expect(parseKojoFamily('KOJO_DEFINE_KOJO_INFO_K1099(CHARA_ID)')?.characterNo).toBe(1099);
    expect(parseKojoFamily('KOJO_DEFINE_K1099, ARGS')?.characterNo).toBe(1099);
  });

  it('小写写法归一成大写家族名（引擎标识符大小写不敏感）', () => {
    expect(parseKojoFamily('kojo_define_k1')).toMatchObject({
      family: 'KOJO_DEFINE',
      characterNo: 1,
    });
  });

  it('尾段进 slot，家族判定不受影响（魔改私货后缀）', () => {
    expect(parseKojoFamily('KOJO_DEFINE_K1099_EXTRA')).toMatchObject({
      family: 'KOJO_DEFINE',
      characterNo: 1099,
      slot: 'EXTRA',
    });
  });
});

describe('parseKojoFamily —— 不猜', () => {
  it('非五族 / 无编号的函数一律 null', () => {
    expect(parseKojoFamily('KOJO_DAILY')).toBeNull();
    expect(parseKojoFamily('FL_INIT_LOADER')).toBeNull();
    expect(parseKojoFamily('KOJO_XML_REGISTER')).toBeNull();
    expect(parseKojoFamily('KOJO_DEFINE')).toBeNull();
    expect(parseKojoFamily('')).toBeNull();
  });
});

describe('createEraflFamilyIndex —— 规则对象', () => {
  it('name / 五个中文面标签 / 显式空 instructionFaces', () => {
    const rule = createEraflFamilyIndex();
    expect(rule.name).toBe('erafl-family-index');
    expect(rule.instructionFaces).toEqual([]);
    expect(Object.keys(ERAFL_FACE_LABELS)).toHaveLength(5);
    expect(ERAFL_FACE_LABELS.KOJO_DEFINE).toBe('口上注册');
    expect(rule.match('KOJO_FOR_MALE_K26')?.family).toBe('KOJO_FOR_MALE');
    expect(rule.match('KOJO_DAILY')).toBeNull();
  });

  it('家族表恰好 5 项（多收一族就会把私货函数算成口上）', () => {
    expect(ERAFL_FAMILIES).toHaveLength(5);
  });
});

describe('真实语料读数（守卫：D:/Game/erafl 存在才跑）', () => {
  it.skipIf(!hasCorpus)('读 1099 的 define 壳文件：注册与信息两个函数都归到 1099', () => {
    const text = readFileSync(`${GAME_ROOT}/ERB/口上/1099_うふふお姉さん/KOJO_DEFINE_K1099.ERB`, 'utf8');
    const names = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('@'))
      .map((line) => line.slice(1));
    expect(parseKojoFamily(names[0]!)?.characterNo).toBe(1099);
    const info = names.find((n) => n.startsWith('KOJO_DEFINE_KOJO_INFO_'));
    expect(parseKojoFamily(info!)?.family).toBe('KOJO_DEFINE_KOJO_INFO');
    expect(parseKojoFamily(info!)?.characterNo).toBe(1099);
  });
});
