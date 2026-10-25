/**
 * `loadProject` 装载结果 + adapter 的语义位 / 展示位。
 *
 * 真盘用例以 `C:/game/eraSQC` 存在为守卫（断言本机实测读数：63 个角色 /
 * CFLAG 62 / TALENT 224 / Train 196）；合成用例钉「CSV 为主、口上文件补条目、
 * 不伪造 kojoDir」。
 */

import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameProject } from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';
import { ERASQC } from '../src/constants';
import { ERASQC_STATE_LINES } from '../src/state-lines';
import { GAME_ROOT, activateAdapter, memIo, nodeIo } from './harness';

const hasCorpus = existsSync(GAME_ROOT);

describe('loadProject —— 合成工程', () => {
  const ROOT = 'C:/mem/eraSQC';
  const CSV = `${ROOT}/CSV`;
  const KOJO = `${ROOT}/ERB/EVENT_K`;
  let proj: GameProject;
  let activated: ReturnType<typeof activateAdapter>;

  beforeAll(async () => {
    const io = memIo(
      {
        [`${CSV}/Chara1.csv`]: '\uFEFF番号,1,\n名前,魅魔,\n呼び名,魅魔,\n',
        // 缺 `番号` 行：编号由文件名回退
        [`${CSV}/Chara7.csv`]: '名前,狼女,\n呼び名,狼女,\n',
        [`${CSV}/Cflag.csv`]: '2,好感度\n',
        [`${CSV}/Talent.csv`]: '85,恋慕\n',
        [`${CSV}/Train.csv`]: '6,接吻\n282,自慰\n3,自慰\n',
        [`${KOJO}/EVENT_K.ERB`]: '@KOJO_MESSAGE_COM\nRETURN 0\n',
        [`${KOJO}/EVENT_K01.ERB`]: '@KOJO_MESSAGE_COM_1_1\n',
        [`${KOJO}/EVENT_K07_2.ERB`]: '@KOJO_MESSAGE_COM_7_2\n',
        // CSV 里没有 9 号：口上文件补最小条目
        [`${KOJO}/EVENT_K09.ERB`]: '@KOJO_MESSAGE_COM_9_1\n',
      },
      [`${ROOT}/ERB`, CSV, KOJO],
    );
    activated = activateAdapter(io);
    proj = await activated.adapter.loadProject(ROOT);
  });

  it('角色索引 = CSV 两份 + 口上文件补的 9 号（3 条）', () => {
    expect([...proj.charaIndex.keys()].sort((a, b) => a - b)).toEqual([1, 7, 9]);
    expect(proj.charaIndex.get(1)?.name).toBe('魅魔');
    expect(proj.charaIndex.get(1)?.callName).toBe('魅魔');
    expect(proj.charaIndex.get(7)?.name).toBe('狼女');
    expect(proj.charaIndex.get(9)?.name).toBe('Chara9');
  });

  it('不伪造 kojoDir（本作没有每角色目录）', () => {
    for (const info of proj.charaIndex.values()) expect(info.kojoDir).toBeUndefined();
  });

  it('路径口径：索引吃整个 ERB、可写面只有口上域；inputDigest 为 14 位十六进制', () => {
    expect(proj.rootDir).toBe(ROOT);
    expect(proj.adapterId).toBe('erasqc');
    expect(proj.kojoPaths).toEqual([join(ROOT, 'ERB')]);
    expect(proj.writablePaths).toEqual([join(ROOT, 'ERB', 'EVENT_K')]);
    expect(proj.inputDigest).toMatch(/^[0-9a-f]{14}$/);
  });

  it('变量字典与指令表都接上了（合成 CSV；同名指令取首条）', () => {
    expect(activated.adapter.variableSchema?.lookup('CFLAG', '好感度')?.resolvedIndex).toBe(2);
    expect(activated.adapter.kojoInstructionTable?.lookupByName('自慰')).toBe(282);
    // 合成盘按 CSV 原序插入：282 先出现，故首条是 282；真盘 3 在前（见真盘用例）
    expect(activated.adapter.kojoInstructionTable?.lookupByNo(3)).toBe('自慰');
  });

  it('只注册 game.adapter 槽位（没有 search.scope）', () => {
    expect(activated.slots.map((s) => s.slot)).toEqual(['game.adapter']);
    expect((activated.slots[0]!.item as { id: string }).id).toBe('erasqc-adapter');
  });
});

describe('loadProject —— 真盘实测（守卫：C:/game/eraSQC 存在才跑）', () => {
  let adapter: ReturnType<typeof activateAdapter>['adapter'];
  let proj: GameProject;

  beforeAll(async () => {
    if (!hasCorpus) return;
    adapter = activateAdapter(nodeIo()).adapter;
    proj = await adapter.loadProject(GAME_ROOT);
  });

  it.skipIf(!hasCorpus)('63 个角色（Chara CSV 全集）', () => {
    expect(proj.charaIndex.size).toBe(63);
    expect(proj.charaIndex.get(0)?.name).toBe('您');
    expect(proj.charaIndex.get(1)?.name).toBe('魅魔');
    expect(proj.charaIndex.get(7)?.name).toBe('狼女');
    expect(proj.charaIndex.get(16)?.name).toBe('葛叶');
  });

  it.skipIf(!hasCorpus)('57 号：黑萨菲 / 呼び名萨菲；KOJO 文件里的 58 个编号都在 CSV 内', () => {
    expect(proj.charaIndex.get(57)?.name).toBe('黑萨菲');
    expect(proj.charaIndex.get(57)?.callName).toBe('萨菲');
    // 口上文件编号并集 ⊆ CSV 编号：索引里不应出现 `Chara{n}` 回退名
    const fallback = [...proj.charaIndex.values()].filter((c) => /^Chara\d+$/.test(c.name));
    expect(fallback).toEqual([]);
  });

  it.skipIf(!hasCorpus)('路径口径 + inputDigest 连读两次一致', async () => {
    expect(proj.kojoPaths).toEqual([join(GAME_ROOT, 'ERB')]);
    expect(proj.writablePaths).toEqual([join(GAME_ROOT, 'ERB', 'EVENT_K')]);
    const again = await activateAdapter(nodeIo()).adapter.loadProject(GAME_ROOT);
    expect(again.inputDigest).toBe(proj.inputDigest);
  });

  it.skipIf(!hasCorpus)('变量字典：CFLAG 62 / TALENT 224；恋慕 = 85', () => {
    const schema = adapter.variableSchema;
    expect(schema?.names!('CFLAG')).toHaveLength(62);
    expect(schema?.names!('TALENT')).toHaveLength(224);
    expect(schema?.lookup('CFLAG', 995)?.description).toBe('是乳牛');
    expect(schema?.lookup('TALENT', '恋慕')?.resolvedIndex).toBe(85);
  });

  it.skipIf(!hasCorpus)('指令名表：同名取首条（自慰 = 3，不是 282）', () => {
    const table = adapter.kojoInstructionTable;
    expect(table?.hasTable).toBe(true);
    expect(table?.lookupByName('自慰')).toBe(3);
    expect(table?.lookupByNo(282)).toBe('自慰');
    expect(table?.names!()).toHaveLength(152);
  });
});

describe('adapter 的语义位与展示位（不依赖工程）', () => {
  it('一条约定规则挂在 adapter 上（id 与 conventions.ts 一致）', () => {
    const { adapter } = activateAdapter(nodeIo());
    expect(adapter.conventions?.map((rule) => rule.id)).toEqual(['erasqc.kojo.chara-mismatch']);
    expect(adapter.conventions?.every((rule) => rule.scope === 'file')).toBe(true);
  });

  it('家族索引 / 面标签 / 指令承载面为空', () => {
    const { adapter } = activateAdapter(nodeIo());
    expect(adapter.functionFamilyIndex?.name).toBe('erasqc-family-index');
    expect(adapter.functionFamilyIndex?.instructionFaces).toEqual([]);
    expect(adapter.functionFamilyIndex?.faceLabels?.MESSAGE_COM).toBe('指令口上');
  });

  it('stateLinePresets / kojoFaceTemplates 都是静态表', () => {
    const { adapter } = activateAdapter(nodeIo());
    expect(adapter.stateLinePresets).toBe(ERASQC_STATE_LINES);
    expect(adapter.kojoFaceTemplates?.faces['指令']?.template).toBe('KOJO_MESSAGE_COM_{n}_{i}');
    expect(adapter.kojoFaceTemplates?.faces['指令']?.indexKind).toBe('literal');
    expect(adapter.gameId).toBe(ERASQC.gameId);
    expect(adapter.displayName).toBe(ERASQC.displayName);
  });
});
