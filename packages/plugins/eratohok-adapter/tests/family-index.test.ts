/**
 * 家族识别（`parseKojoFamily`）判据。
 *
 * 每条用例的形态都来自真盘实测（见 `src/family-index.ts` 文件头的清单）；
 * `_KXXX` / `KOJO_HAIR_NAME` 这类**不归属角色**的形态单独钉，防止把公共函数
 * 错算成某个角色的口上。
 */

import { describe, expect, it } from 'vitest';
import { createTohokFamilyIndex, parseKojoFamily } from '../src/family-index';

describe('parseKojoFamily —— 主族', () => {
  it('`KOJO_TRAIN_START_K1` → 面 TRAIN_START / 角色 1 / 无状态段', () => {
    const m = parseKojoFamily('KOJO_TRAIN_START_K1');
    expect(m).toMatchObject({ face: 'TRAIN_START', characterNo: 1, sub: '', slot: '' });
  });

  it('状态段进 sub：`KOJO_TRAIN_START_A1_K1` / `KOJO_COM_B_K1`', () => {
    expect(parseKojoFamily('KOJO_TRAIN_START_A1_K1')).toMatchObject({
      face: 'TRAIN_START',
      sub: 'A1',
      characterNo: 1,
    });
    expect(parseKojoFamily('KOJO_COM_B_K1')).toMatchObject({ face: 'COM', sub: 'B' });
  });

  it('多段面名不被状态段规则吃掉：`KOJO_COM_THIRD_BEFORE_TARGET_B_K1`', () => {
    expect(parseKojoFamily('KOJO_COM_THIRD_BEFORE_TARGET_B_K1')).toMatchObject({
      face: 'COM_THIRD_BEFORE_TARGET',
      sub: 'B',
      characterNo: 1,
    });
  });

  it('实参被裁掉：`KOJO_EVENT_K30(ARG)` → 面 EVENT / 角色 30', () => {
    expect(parseKojoFamily('KOJO_EVENT_K30(ARG)')).toMatchObject({
      face: 'EVENT',
      characterNo: 30,
      slot: '',
    });
  });

  it('口上号尾段进 slot：`KOJO_TRAIN_START_A1_K1_3`', () => {
    expect(parseKojoFamily('KOJO_TRAIN_START_A1_K1_3')).toMatchObject({
      face: 'TRAIN_START',
      sub: 'A1',
      characterNo: 1,
      slot: '3',
    });
  });
});

describe('parseKojoFamily —— 每日事件族', () => {
  it('正文 + 四件套尾段', () => {
    expect(parseKojoFamily('KOJO_DAILY_K1_NAUGHTY_MAIDEN')).toMatchObject({
      face: 'DAILY',
      characterNo: 1,
      slot: 'NAUGHTY_MAIDEN',
      sub: '',
    });
    expect(parseKojoFamily('KOJO_DAILY_K1_NAUGHTY_MAIDEN_RATE')).toMatchObject({
      face: 'DAILY',
      slot: 'NAUGHTY_MAIDEN',
      sub: 'RATE',
    });
    expect(parseKojoFamily('KOJO_DAILY_K1_NAUGHTY_MAIDEN_ALLOW_WHEN_WANDERING')).toMatchObject({
      face: 'DAILY',
      sub: 'ALLOW_WHEN_WANDERING',
    });
  });

  it('事件名大小写混排原样保留：`KOJO_DAILY_K111_Industrialization_RATE`', () => {
    expect(parseKojoFamily('KOJO_DAILY_K111_Industrialization_RATE')).toMatchObject({
      face: 'DAILY',
      characterNo: 111,
      slot: 'Industrialization',
      sub: 'RATE',
    });
  });

  it('引擎钩子：`EVENTTRAIN_KOJO_DAILY_K7_DRAIN_SPERM`', () => {
    expect(parseKojoFamily('EVENTTRAIN_KOJO_DAILY_K7_DRAIN_SPERM')).toMatchObject({
      face: 'DAILY_HOOK',
      characterNo: 7,
      slot: 'DRAIN_SPERM',
    });
    expect(parseKojoFamily('EVENTEND_KOJO_DAILY_K8_GATHER_SPERM')).toMatchObject({
      face: 'DAILY_HOOK',
      characterNo: 8,
    });
  });
});

describe('parseKojoFamily —— 并列族（非 KOJO_ 前缀）', () => {
  it('`DATE_EVENT_K134_mizuumi` → 面 DATE_EVENT / 角色 134 / 场所进 slot', () => {
    expect(parseKojoFamily('DATE_EVENT_K134_mizuumi')).toMatchObject({
      prefix: 'DATE',
      face: 'DATE_EVENT',
      characterNo: 134,
      slot: 'mizuumi',
    });
    expect(parseKojoFamily('DATE_EVENT_K134')).toMatchObject({ face: 'DATE_EVENT', slot: '' });
  });

  it('`SEXVOICE_TARGET_K141` → 面 SEXVOICE / TARGET 进 sub', () => {
    expect(parseKojoFamily('SEXVOICE_TARGET_K141')).toMatchObject({
      prefix: 'SEXVOICE',
      face: 'SEXVOICE',
      characterNo: 141,
      sub: 'TARGET',
    });
  });
});

describe('parseKojoFamily —— 占位与不归属', () => {
  it('`_KXXX` 模板占位：标 isPlaceholder、不归属角色', () => {
    expect(parseKojoFamily('KOJO_TRAIN_START_B_KXXX')).toMatchObject({
      face: 'TRAIN_START',
      sub: 'B',
      characterNo: null,
      isPlaceholder: true,
    });
  });

  it('`_K{対象NO}` 分派器占位同样是占位', () => {
    expect(parseKojoFamily('KOJO_DAILY_K{対象NO}_X_RATE')).toMatchObject({
      characterNo: null,
      isPlaceholder: true,
    });
  });

  it('无号公共函数返回 null（不硬塞角色）', () => {
    expect(parseKojoFamily('KOJO_HAIR_NAME')).toBeNull();
    expect(parseKojoFamily('KOJO_ASK_RESET')).toBeNull();
    expect(parseKojoFamily('CREATE_KOJO_DAILY_MAP_K1')).toBeNull();
    expect(parseKojoFamily('EVENTTRAIN')).toBeNull();
    expect(parseKojoFamily('')).toBeNull();
  });
});

describe('createTohokFamilyIndex —— 契约位', () => {
  it('面标签覆盖主族；不声明 instructionFaces（本作一指令一函数不存在）', () => {
    const rule = createTohokFamilyIndex();
    expect(rule.name).toBe('eratohok-family-index');
    expect(rule.faceLabels?.TRAIN_START).toBe('训练开始');
    expect(rule.faceLabels?.COM).toBe('指令');
    expect(rule.instructionFaces).toBeUndefined();
    expect(rule.match('KOJO_COM_K1')?.face).toBe('COM');
  });
});
