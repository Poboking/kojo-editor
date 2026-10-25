/**
 * `loadProject` 装载结果 + adapter 的语义位 / 展示位 / 检索范围。
 *
 * 真盘用例以 `D:/game/eratohoK` 存在为守卫（断言本机实测读数：174 份 Chara CSV /
 * 118 个口上目录 / CFLAG 2999 号「其他」/ Train 首条 0 号「愛撫」）。
 * 合成用例用内存盘钉合并策略——**CSV 名优先、只有目录的补条目、公共文件不当目录**。
 */

import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameProject } from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';
import { ERATOHOK_STATE_LINES } from '../src/state-lines';
import { createTohokFaceTable } from '../src/face-templates';
import { GAME_ROOT, activateAdapter, memIo, nodeIo } from './harness';

const hasCorpus = existsSync(GAME_ROOT);

describe('loadProject —— 合成工程（合并策略）', () => {
  const ROOT = 'D:/mem/eratohoK';
  const CSV = `${ROOT}/CSV`;
  const KOJO = `${ROOT}/ERB/口上`;
  let proj: GameProject;
  let activated: ReturnType<typeof activateAdapter>;

  beforeAll(async () => {
    const io = memIo(
      {
        [`${CSV}/Chara/Chara0 あなた.csv`]: '番号,0\r\n名前,あなた\r\n呼び名,你\r\n',
        [`${CSV}/Chara/Chara1 霊夢.csv`]: '番号,1\r\n名前,霊夢\r\n呼び名,霊夢\r\n',
        [`${CSV}/CFLAG.CSV`]: '2,好感度\r\n2999,其他\r\n',
        [`${CSV}/Talent.csv`]: '154,服従\r\n',
        [`${CSV}/Train.csv`]: '0,愛撫\r\n6,胸愛撫\r\n313,胸愛撫\r\n',
        [`${ROOT}/ERB/VARIABLE.ERH`]: '#DIM CONST 人物_咲夜 = 4\r\n',
        // 口上域根上的公共文件：不是目录，必须跳过
        [`${KOJO}/_KOJO_SYSTEM.ERB`]: '; 公共系统文件\r\n',
        [`${KOJO}/01 霊夢口上/KOJO_A_K1.ERB`]: '@KOJO_COM_A_K1\r\nRETURN 1\r\n',
        [`${KOJO}/1204 ランダムキャラ武官/KOJO_B_K1204.ERB`]: '@KOJO_COM_B_KXXX\r\n',
      },
      [`${ROOT}/ERB`, `${ROOT}/CSV`, `${CSV}/Chara`, KOJO, `${KOJO}/01 霊夢口上`, `${KOJO}/1204 ランダムキャラ武官`],
    );
    activated = activateAdapter(io);
    proj = await activated.adapter.loadProject(ROOT);
  });

  it('CSV 角色进索引；口上目录只补 kojoDir，不覆盖 CSV 名', () => {
    expect(proj.charaIndex.size).toBe(3);
    expect(proj.charaIndex.get(0)?.name).toBe('あなた');
    expect(proj.charaIndex.get(1)?.name).toBe('霊夢');
    expect(proj.charaIndex.get(1)?.kojoDir?.endsWith('01 霊夢口上')).toBe(true);
    expect(proj.charaIndex.get(0)?.kojoDir).toBeUndefined();
  });

  it('只有口上目录、没有 CSV 的编号补最小条目（1204 随机角色）', () => {
    expect(proj.charaIndex.get(1204)).toMatchObject({ no: 1204, name: 'ランダムキャラ武官' });
    expect(proj.charaIndex.get(1204)?.kojoDir?.endsWith('1204 ランダムキャラ武官')).toBe(true);
  });

  it('路径口径：索引吃整个 ERB、可写面只有口上域；inputDigest 为 14 位十六进制', () => {
    expect(proj.rootDir).toBe(ROOT);
    expect(proj.adapterId).toBe('eratohok');
    expect(proj.kojoPaths).toEqual([join(ROOT, 'ERB')]);
    expect(proj.writablePaths).toEqual([join(ROOT, 'ERB', '口上')]);
    expect(proj.inputDigest).toMatch(/^[0-9a-f]{14}$/);
  });

  it('变量字典与指令表都接上了（同名指令取首条）', () => {
    expect(activated.adapter.variableSchema?.lookup('CFLAG', 2)?.description).toBe('好感度');
    expect(activated.adapter.variableSchema?.lookup('CFLAG', '人物_咲夜')?.resolvedIndex).toBe(4);
    expect(activated.adapter.kojoInstructionTable?.lookupByName('胸愛撫')).toBe(6);
  });

  it('槽位：game.adapter + search.scope（只对本案生效）', () => {
    const slots = activated.slots.map((s) => s.slot);
    expect(slots).toContain('game.adapter');
    expect(slots).toContain('search.scope');
    const scope = activated.slots.find((s) => s.slot === 'search.scope')!.item as {
      provide: (p: GameProject | null) => readonly unknown[];
    };
    expect(scope.provide(proj).length).toBeGreaterThan(0);
    expect(scope.provide({ ...proj, adapterId: 'other' }).length).toBe(0);
    expect(scope.provide(null).length).toBe(0);
  });
});

describe('loadProject —— 真盘读数（守卫：D:/game/eratohoK 存在才跑）', () => {
  let proj: GameProject;
  let activated: ReturnType<typeof activateAdapter>;

  beforeAll(async () => {
    activated = activateAdapter(nodeIo());
    proj = await activated.adapter.loadProject(GAME_ROOT);
  });

  it.skipIf(!hasCorpus)('角色索引：174 份 Chara CSV ∪ 118 个口上目录', () => {
    expect(proj.charaIndex.size).toBeGreaterThanOrEqual(174);
    const withKojo = [...proj.charaIndex.values()].filter((c) => c.kojoDir !== undefined);
    expect(withKojo).toHaveLength(118);
    // 真盘原样：1 号是霊夢，1204 是没有 CSV 的随机角色目录
    expect(proj.charaIndex.get(1)?.name).toBe('霊夢');
    expect(proj.charaIndex.get(1204)?.kojoDir?.endsWith('1204 ランダムキャラ武官')).toBe(true);
  });

  it.skipIf(!hasCorpus)('变量字典：CFLAG 2999「其他」/ TALENT 154「服従」/ Train 0「愛撫」', () => {
    expect(activated.adapter.variableSchema?.lookup('CFLAG', 2999)?.description).toBe('其他');
    expect(activated.adapter.variableSchema?.lookup('TALENT', 154)?.description).toBe('服従');
    expect(activated.adapter.kojoInstructionTable?.lookupByName('愛撫')).toBe(0);
  });

  it.skipIf(!hasCorpus)('可写面只有 ERB/口上；索引吃整个 ERB', () => {
    expect(proj.writablePaths).toEqual([join(GAME_ROOT, 'ERB', '口上')]);
    expect(proj.kojoPaths).toEqual([join(GAME_ROOT, 'ERB')]);
  });
});

describe('adapter 语义位（纯数据，无 IO）', () => {
  it('时机分野模板：11 面，全部只带 {n}（本作一指令一函数不存在）', () => {
    const faces = createTohokFaceTable().faces;
    expect(Object.keys(faces)).toHaveLength(11);
    for (const spec of Object.values(faces)) {
      expect(spec.template).toContain('{n}');
      expect(spec.template).not.toContain('{i}');
    }
    expect(faces['指令']?.template).toBe('KOJO_COM_K{n}');
  });

  it('剧情线预设：9 条，id 唯一、键非空', () => {
    expect(ERATOHOK_STATE_LINES).toHaveLength(9);
    expect(new Set(ERATOHOK_STATE_LINES.map((l) => l.id)).size).toBe(9);
    for (const line of ERATOHOK_STATE_LINES) {
      expect(line.keys.length).toBeGreaterThan(0);
      expect(line.label.length).toBeGreaterThan(0);
    }
  });
});
