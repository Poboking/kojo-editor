import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ERAKOUMAKAN_FACE_LABELS,
  createKoumakanFamilyIndex,
  parseKojoFamily,
} from '../src/family-index';
import { GAME_ROOT, listFilesRecursive, relOf } from './harness';

const hasCorpus = existsSync(GAME_ROOT);

/** 断言一条解析结果的几个关键字段 */
function expectMatch(
  raw: string,
  expected: {
    family?: string;
    prefix?: string;
    face: string;
    no: number | null;
    sub?: string;
    slot?: string;
  },
): void {
  const m = parseKojoFamily(raw);
  expect(m, raw).not.toBeNull();
  expect(m).toMatchObject({
    kind: 'ok',
    family: expected.family ?? '',
    prefix: expected.prefix ?? '',
    face: expected.face,
    characterNo: expected.no,
    selector: 0,
    isMessageCheck: false,
    isPlaceholder: false,
  });
  if (expected.sub !== undefined) expect(m!.sub).toBe(expected.sub);
  if (expected.slot !== undefined) expect(m!.slot).toBe(expected.slot);
}

describe('家族解析 —— 基础 KOJO 族', () => {
  it('入口 / 事件 / 杂项 / 指令 / 射精 / 计数器 / 参数变动 / 刻印 / 结局', () => {
    expectMatch('KOJO_K4(ARG)', { face: 'KOJO', prefix: 'KOJO', no: 4, slot: '' });
    expectMatch('KOJO_EVENT_K4_0', { face: 'EVENT', prefix: 'KOJO', no: 4, slot: '0' });
    expectMatch('KOJO_MESSAGE_K4_SeeYou_900_0', {
      face: 'MESSAGE',
      prefix: 'KOJO',
      no: 4,
      slot: 'SeeYou_900_0',
    });
    expectMatch('KOJO_MESSAGE_COM_K4_300', { face: 'MESSAGE_COM', prefix: 'KOJO', no: 4, slot: '300' });
    expectMatch('KOJO_MESSAGE_COM_K4_300_10_01', {
      face: 'MESSAGE_COM',
      prefix: 'KOJO',
      no: 4,
      slot: '300_10_01',
    });
    expectMatch('KOJO_MESSAGE_SCOM_K4_350', { face: 'MESSAGE_SCOM', prefix: 'KOJO', no: 4, slot: '350' });
    expectMatch('KOJO_MESSAGE_COUNTER_K4_10_1', {
      face: 'MESSAGE_COUNTER',
      prefix: 'KOJO',
      no: 4,
      slot: '10_1',
    });
    expectMatch('KOJO_MESSAGE_PALAMCNG_A_K4_0', {
      face: 'MESSAGE_PALAMCNG',
      prefix: 'KOJO',
      no: 4,
      sub: 'A',
      slot: '0',
    });
    expectMatch('KOJO_MESSAGE_MARKCNG_K4(奴隷)', { face: 'MESSAGE_MARKCNG', prefix: 'KOJO', no: 4 });
    expectMatch('KOJO_MESSAGE_ENDING_K4', { face: 'MESSAGE_ENDING', prefix: 'KOJO', no: 4 });
  });

  it('泛用口上 KU 与见せつけ KW：角色号规则', () => {
    expectMatch('KOJO_MESSAGE_COM_KU_300', { prefix: 'KOJO', face: 'MESSAGE_COM', no: null, slot: '300' });
    expectMatch('KOJO_EVENT_KU_0', { prefix: 'KOJO', face: 'EVENT', no: null, slot: '0' });
    expectMatch('KOJO_EVENT_KW5_8_0_0', { prefix: 'KOJO', face: 'EVENT', no: 5, slot: '8_0_0' });
  });

  it('WC 族：分类段进 sub、角色号仍在末尾', () => {
    expectMatch('KOJO_WC_COUNTER10_K4', { face: 'WC_COUNTER', no: 4, sub: '10' });
    expectMatch('KOJO_WC_COUNTER25_1_VirginReservation_GET_K4', {
      face: 'WC_COUNTER',
      no: 4,
      sub: '25_1_VirginReservation_GET',
    });
    expectMatch('WC_DescriptiveStyle_K4', { face: 'WC_DESCRIPTIVE_STYLE', no: 4 });
  });

  it('SexHara / 称呼', () => {
    expectMatch('SexHara休息中_Easy_K4_0', { face: 'SEXHARA_EASY', no: 4, slot: '0' });
    expectMatch('CALLNAME_K4', { face: 'CALLNAME', no: 4 });
  });
});

describe('家族解析 —— NTR 前缀', () => {
  it('NTR 家族 + 同一套面', () => {
    expectMatch('NTR_KOJO_K4_1', { family: 'NTR', prefix: 'NTR', face: 'KOJO', no: 4, slot: '1' });
    expectMatch('NTR_KOJO_KW5_8_0_0', {
      family: 'NTR',
      prefix: 'NTR',
      face: 'KOJO',
      no: 5,
      slot: '8_0_0',
    });
    expectMatch('NTR_KOJO_PRE_KW5_8_0_0', {
      family: 'NTR',
      prefix: 'NTR',
      face: 'KOJO_PRE',
      no: 5,
      slot: '8_0_0',
    });
    expectMatch('NTR_KOJO_MESSAGE_COM_K4_350_1', {
      family: 'NTR',
      prefix: 'NTR',
      face: 'MESSAGE_COM',
      no: 4,
      slot: '350_1',
    });
    expectMatch('NTR_MESSAGE_COM_K1_350_0_3', {
      family: 'NTR',
      prefix: 'NTR',
      face: 'MESSAGE_COM',
      no: 1,
      slot: '350_0_3',
    });
  });

  it('K 后没有数字（模板/无编号形）：characterNo = null，尾段原样保留', () => {
    expectMatch('NTR_MESSAGE_COM_K_350_0', {
      family: 'NTR',
      prefix: 'NTR',
      face: 'MESSAGE_COM',
      no: null,
      slot: '350_0',
    });
    expectMatch('NTR_KOJO_KU_FAKE_ORGASM', {
      family: 'NTR',
      prefix: 'NTR',
      face: 'KOJO',
      no: null,
      slot: 'FAKE_ORGASM',
    });
  });
});

describe('家族解析 —— 不猜', () => {
  it('辅助函数 / 路由函数 / 催眠系统函数不返回匹配', () => {
    for (const raw of [
      'MSG_NTR_SEX_10',
      'MSG_LOVER',
      'KOJO_MESSAGE_COM',
      'EVENTTRAIN',
      '催眠_KOJO_口上',
      '',
    ]) {
      expect(parseKojoFamily(raw), raw).toBeNull();
    }
  });

  it('入参声明 / 行内注释不进入函数名', () => {
    expect(parseKojoFamily('KOJO_MESSAGE_MARKCNG_K4, ARGS')?.characterNo).toBe(4);
    expect(parseKojoFamily('KOJO_MESSAGE_COM_K4_300 ; 注释')?.slot).toBe('300');
  });
});

describe('FamilyIndexRule 对象', () => {
  it('面标签覆盖全部面 token；指令承载面只列 COM / SCOM', () => {
    const rule = createKoumakanFamilyIndex();
    expect(rule.instructionFaces).toEqual(['MESSAGE_COM', 'MESSAGE_SCOM']);
    expect(ERAKOUMAKAN_FACE_LABELS.MESSAGE_COM).toBe('指令口上');
    expect(ERAKOUMAKAN_FACE_LABELS.SEXHARA_LUNATIC).toBe('休息受扰（Lunatic）');
    expect(rule.faceLabels).toBe(ERAKOUMAKAN_FACE_LABELS);
  });
});

describe('真盘实测（守卫：D:/Game/eraKoumakan 存在才跑）', () => {
  it.skipIf(!hasCorpus)('4,450 个口上函数里 4,410 个可归属；40 个辅助函数不猜', () => {
    const dir = `${GAME_ROOT}/ERB/口上`;
    const files = listFilesRecursive(dir, /\.erb$/i);
    let total = 0;
    let parsed = 0;
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      for (const m of text.matchAll(/^\s*@([^\s,;(]+)/gm)) {
        total++;
        if (parseKojoFamily(m[1]!, path) !== null) parsed++;
      }
    }
    expect(total).toBe(4450);
    expect(parsed).toBe(4410);
    expect(total - parsed).toBe(40);
  });

  it.skipIf(!hasCorpus)('真盘那处 K7/K6 错位被原样解析出来（约定规则的判据）', () => {
    const path = `${GAME_ROOT}/ERB/口上/6_フラン/対あなた口上.ERB`;
    const text = readFileSync(path, 'utf8');
    const m = /@(KOJO_MESSAGE_COM_K7_463_1)/.exec(text);
    expect(m).not.toBeNull();
    const parsed = parseKojoFamily(m![1]!, path);
    expect(parsed?.characterNo).toBe(7);
    expect(parsed?.face).toBe('MESSAGE_COM');
    expect(relOf(GAME_ROOT, path)).toBe('ERB/口上/6_フラン/対あなた口上.ERB');
  });
});
