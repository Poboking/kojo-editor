/**
 * 家族解析：主族 / 前缀式 / 通用兜底 / 私有函数 / 路由本体不归属。
 *
 * 真盘守卫用例钉本机实测：`ERB/EVENT_K` 111 份 / 1,366 个函数定义中 966 个可归属，
 * 五大主面各 89 个角色，`MESSAGE_COM` 与 `KOJO2` 同号。
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ERASQC_FACE_LABELS,
  createErasqcFamilyIndex,
  parseKojoFamily,
} from '../src/family-index';
import { GAME_ROOT, listFilesRecursive } from './harness';

const hasCorpus = existsSync(GAME_ROOT);

function expectMatch(
  raw: string,
  expected: { face: string; no: number | null; slot?: string; kind?: string; prefix?: string },
): void {
  const m = parseKojoFamily(raw);
  expect(m, raw).not.toBeNull();
  expect(m).toMatchObject({
    kind: expected.kind ?? 'ok',
    prefix: expected.prefix ?? '',
    family: '',
    face: expected.face,
    characterNo: expected.no,
    selector: 0,
    isMessageCheck: false,
    isPlaceholder: false,
  });
  if (expected.slot !== undefined) expect(m!.slot).toBe(expected.slot);
}

describe('家族解析 —— 主族（面_{no}_{模式} / 面_K{no}_{模式}）', () => {
  it('指令 / 指令前 / 指令后 / 参数变动 / 刻印 / 射精 / 射精与绝顶 / 口枷', () => {
    expectMatch('KOJO_MESSAGE_COM_1_1', { face: 'MESSAGE_COM', no: 1, slot: '1', prefix: 'KOJO' });
    expectMatch('KOJO_MESSAGE_BEFORE_COM_7_3', {
      face: 'MESSAGE_BEFORE_COM',
      no: 7,
      slot: '3',
      prefix: 'KOJO',
    });
    expectMatch('KOJO_MESSAGE_AFTER_COM_25_2', {
      face: 'MESSAGE_AFTER_COM',
      no: 25,
      slot: '2',
      prefix: 'KOJO',
    });
    expectMatch('KOJO_MESSAGE_PALAMCNG_12_2', {
      face: 'MESSAGE_PALAMCNG',
      no: 12,
      slot: '2',
      prefix: 'KOJO',
    });
    expectMatch('KOJO_MESSAGE_MARKCNG_44_331', {
      face: 'MESSAGE_MARKCNG',
      no: 44,
      slot: '331',
      prefix: 'KOJO',
    });
    expectMatch('KOJO_MESSAGE_SHOOT_17_1', { face: 'MESSAGE_SHOOT', no: 17, slot: '1', prefix: 'KOJO' });
    expectMatch('KOJO_MESSAGE_SAMEN_AND_EXTACY_48_2L', {
      face: 'MESSAGE_SAMEN_AND_EXTACY',
      no: 48,
      slot: '2L',
      prefix: 'KOJO',
    });
    expectMatch('KOJO_MESSAGE_GAG_5_1', { face: 'MESSAGE_GAG', no: 5, slot: '1', prefix: 'KOJO' });
  });

  it('独白 / 客人 / 计数器 / 单结局 / 单结局判定 / 日常', () => {
    expectMatch('SELF_KOJO_K4_1, ARGS', { face: 'SELF_KOJO', no: 4, slot: '1' });
    expectMatch('GUEST_KOJO_K8_1, ARGS, ARG', { face: 'GUEST_KOJO', no: 8, slot: '1' });
    expectMatch('COUNTER_KOJO_9_1, ARGS', { face: 'COUNTER_KOJO', no: 9, slot: '1' });
    expectMatch('SINGLE_ENDING_K24_2', { face: 'SINGLE_ENDING', no: 24, slot: '2' });
    expectMatch('IS_SINGLE_ENDING_K31_1', { face: 'IS_SINGLE_ENDING', no: 31, slot: '1' });
    expectMatch('DAILY_LIFE_MESSAGE_25_2', { face: 'DAILY_LIFE_MESSAGE', no: 25, slot: '2' });
    expectMatch('DAILY_LIFE_DAYEV_25_2', { face: 'DAILY_LIFE_DAYEV', no: 25, slot: '2' });
  });

  it('前缀式恋慕分支 K{n}_KOJO2_{模式}', () => {
    expectMatch('K1_KOJO2_1', { face: 'KOJO2', no: 1, slot: '1' });
    expectMatch('K48_KOJO2_2L', { face: 'KOJO2', no: 48, slot: '2L' });
  });

  it('角色私有函数 K{n}_{名} 归 `KN`（kind=kn）', () => {
    expectMatch('K39_KOJO_MAGIC_PRACTICE', { face: 'KN', no: 39, slot: 'KOJO_MAGIC_PRACTICE', kind: 'kn' });
    expectMatch('K5_HT', { face: 'KN', no: 5, slot: 'HT', kind: 'kn' });
  });
});

describe('家族解析 —— 通用兜底与不归属', () => {
  it('场景辅助口上 KOJO_{面}_{no}[_{尾段}]', () => {
    expectMatch('KOJO_AEGI_97_33_0', { face: 'AEGI', no: 97, slot: '33_0', prefix: 'KOJO' });
    expectMatch('KOJO_EVENT_EXSTART_16_1', { face: 'EVENT_EXSTART', no: 16, slot: '1', prefix: 'KOJO' });
    expectMatch('KOJO_RAND_7_3', { face: 'RAND', no: 7, slot: '3', prefix: 'KOJO' });
  });

  it('路由本体 / 无编号辅助函数 → null（绝不猜归属）', () => {
    for (const name of [
      'KOJO_MESSAGE_COM',
      'KOJO_MESSAGE_BEFORE_COM',
      'COUNTER_KOJO',
      'SELF_KOJO',
      'SELF_KOJO_L',
      'DAILY_LIFE_MESSAGE',
      'SINGLE_ENDING',
      'EVENTTRAIN',
      'EVENTEND',
      'CNAME',
      'CNAMET',
      'SUCCUBUS_LOOP',
      'KOJO_MESSAGE_COM_MULTI',
    ]) {
      expect(parseKojoFamily(name), name).toBeNull();
    }
  });

  it('面标签与指令承载面：尾号是口上模式，不是指令号', () => {
    const rule = createErasqcFamilyIndex();
    expect(rule.name).toBe('erasqc-family-index');
    expect(rule.instructionFaces).toEqual([]);
    expect(rule.faceLabels?.MESSAGE_COM).toBe('指令口上');
    expect(rule.faceLabels?.KOJO2).toBe('恋慕分支');
    expect(ERASQC_FACE_LABELS.KN).toBe('角色私有函数');
  });
});

describe('家族解析 —— 真盘全量（守卫：C:/game/eraSQC 存在才跑）', () => {
  it.skipIf(!hasCorpus)('1,366 个定义中 966 个可归属；五大主面各 89', () => {
    const files = listFilesRecursive(`${GAME_ROOT}/ERB/EVENT_K`, /\.ERB$/i);
    const counts = new Map<string, number>();
    let total = 0;
    let parsed = 0;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/^@([^\r\n]+)/gm)) {
        const name = (m[1] ?? '').split(/[\s,(;]/)[0]!.trim();
        if (name.length === 0) continue;
        total++;
        const match = parseKojoFamily(name, file);
        if (match === null) continue;
        parsed++;
        counts.set(match.face, (counts.get(match.face) ?? 0) + 1);
      }
    }
    expect(total).toBe(1366);
    expect(parsed).toBe(966);
    expect(counts.get('MESSAGE_COM')).toBe(89);
    expect(counts.get('KOJO2')).toBe(89);
    expect(counts.get('SELF_KOJO')).toBe(89);
    expect(counts.get('GUEST_KOJO')).toBe(81);
    expect(counts.get('MESSAGE_SHOOT')).toBe(21);
  });

  it.skipIf(!hasCorpus)('真盘所有可归属函数的角色号都与文件编号一致（0 处错位）', () => {
    const files = listFilesRecursive(`${GAME_ROOT}/ERB/EVENT_K`, /\.ERB$/i);
    const mismatches: string[] = [];
    for (const file of files) {
      const base = file.replace(/\\/g, '/').split('/').pop()!;
      const fileNo = /^D?EVENT_K(\d+)/i.exec(base)?.[1];
      if (!fileNo) continue;
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/^@([^\r\n]+)/gm)) {
        const name = (m[1] ?? '').split(/[\s,(;]/)[0]!.trim();
        const match = parseKojoFamily(name, file);
        if (match?.characterNo != null && match.characterNo !== Number(fileNo)) {
          mismatches.push(`${base}:${name}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
