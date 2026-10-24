/**
 * `loadProject` 装载结果 + adapter 对象的语义位 / 展示位 / 检索范围。
 *
 * 真盘用例以 `D:/Game/eraKoumakan` 存在为守卫（断言本机实测读数：16 个角色编号 /
 * 10 个口上目录 / CFLAG 329 条 / Talent 112 条）。合成用例用内存盘钉合并策略——
 * **CSV 名优先、只有目录的补条目、U_汎用 不建角色**，换工程版本也不会变。
 */

import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameProject } from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';
import { ERAKOUMAKAN } from '../src/constants';
import { ERAKOUMAKAN_NAME_GLOSSARY } from '../src/name-glossary';
import { ERAKOUMAKAN_STATE_LINES } from '../src/state-lines';
import { GAME_ROOT, activateAdapter, memIo, nodeIo } from './harness';

const hasCorpus = existsSync(GAME_ROOT);

describe('loadProject —— 合成工程（合并策略）', () => {
  const ROOT = 'D:/mem/eraKoumakan';
  const CSV = `${ROOT}/CSV`;
  const KOJO = `${ROOT}/ERB/口上`;
  let proj: GameProject;
  let activated: ReturnType<typeof activateAdapter>;

  beforeAll(async () => {
    const io = memIo(
      {
        [`${CSV}/Chara0.csv`]: '番号,0,\n名前,你,\n呼び名,你,\n',
        [`${CSV}/Chara1.csv`]: '番号,1,\n名前,红美铃,\n呼び名,美铃,\n',
        [`${CSV}/CFLAG.csv`]: '2,好感度\n',
        [`${CSV}/Train.csv`]: '20,接吻\n312,接吻\n',
        // 口上域根上的公共文件：不是目录，必须跳过
        [`${KOJO}/_KOJO_SYSTEM.ERB`]: '; 公共系统文件\n',
        [`${KOJO}/1_美鈴/KOJO_K1.ERB`]: '@KOJO_K1(ARG)\nRETURN 1\n',
        [`${KOJO}/U_汎用/NTR口上.ERB`]: '@NTR_KOJO_KU_FAKE_ORGASM\n',
      },
      [`${ROOT}/ERB`, CSV, KOJO, `${KOJO}/1_美鈴`, `${KOJO}/U_汎用`],
    );
    activated = activateAdapter(io);
    proj = await activated.adapter.loadProject(ROOT);
  });

  it('CSV 角色进索引；口上目录只补 kojoDir，不覆盖 CSV 名（2 条）', () => {
    expect(proj.charaIndex.size).toBe(2);
    expect(proj.charaIndex.get(0)?.name).toBe('你');
    expect(proj.charaIndex.get(1)?.name).toBe('红美铃');
    expect(proj.charaIndex.get(1)?.callName).toBe('美铃');
    expect(proj.charaIndex.get(1)?.kojoDir?.endsWith('1_美鈴')).toBe(true);
    expect(proj.charaIndex.get(0)?.kojoDir).toBeUndefined();
  });

  it('`U_汎用` 不建角色条目（没有编号，不猜）', () => {
    expect([...proj.charaIndex.keys()].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it('路径口径：索引吃整个 ERB、可写面只有口上域；inputDigest 为 14 位十六进制', () => {
    expect(proj.rootDir).toBe(ROOT);
    expect(proj.adapterId).toBe('erakoumakan');
    expect(proj.kojoPaths).toEqual([join(ROOT, 'ERB')]);
    expect(proj.writablePaths).toEqual([join(ROOT, 'ERB', '口上')]);
    expect(proj.inputDigest).toMatch(/^[0-9a-f]{14}$/);
  });

  it('变量字典与指令表都接上了（合成 CSV；同名指令取首条）', () => {
    expect(activated.adapter.variableSchema?.lookup('CFLAG', '好感度')?.resolvedIndex).toBe(2);
    expect(activated.adapter.kojoInstructionTable?.lookupByName('接吻')).toBe(20);
  });
});

describe('loadProject —— 真盘实测（守卫：D:/Game/eraKoumakan 存在才跑）', () => {
  let adapter: ReturnType<typeof activateAdapter>['adapter'];
  let proj: GameProject;

  beforeAll(async () => {
    if (!hasCorpus) return;
    adapter = activateAdapter(nodeIo()).adapter;
    proj = await adapter.loadProject(GAME_ROOT);
  });

  it.skipIf(!hasCorpus)('18 个角色编号（Chara0/1–13/28/29/148/149）', () => {
    expect(proj.charaIndex.size).toBe(18);
    expect(proj.charaIndex.get(28)?.name).toBe('铃仙·优昙华院·因幡');
    expect(proj.charaIndex.get(29)?.callName).toBe('永琳');
  });

  it.skipIf(!hasCorpus)('CSV 名 / 呼び名：1 号是「红美铃 / 美铃」，0 号是主角「你」', () => {
    const info = proj.charaIndex.get(1);
    expect(info?.name).toBe('红美铃');
    expect(info?.callName).toBe('美铃');
    expect(proj.charaIndex.get(0)?.name).toBe('你');
    expect(proj.charaIndex.get(148)?.name).toBe('息子');
  });

  it.skipIf(!hasCorpus)('10 个口上目录（1–10）都绑上了 kojoDir；148/149 没有', () => {
    const withKojo = [...proj.charaIndex.values()].filter((c) => c.kojoDir !== undefined);
    expect(withKojo).toHaveLength(10);
    expect(proj.charaIndex.get(4)?.kojoDir?.endsWith('4_咲夜')).toBe(true);
    expect(proj.charaIndex.get(10)?.kojoDir?.endsWith('10_魔理沙')).toBe(true);
    expect(proj.charaIndex.get(148)?.kojoDir).toBeUndefined();
  });

  it.skipIf(!hasCorpus)('路径口径 + inputDigest 连读两次一致', async () => {
    expect(proj.kojoPaths).toEqual([join(GAME_ROOT, 'ERB')]);
    expect(proj.writablePaths).toEqual([join(GAME_ROOT, 'ERB', '口上')]);
    const again = await activateAdapter(nodeIo()).adapter.loadProject(GAME_ROOT);
    expect(again.inputDigest).toBe(proj.inputDigest);
  });

  it.skipIf(!hasCorpus)('变量字典：CFLAG 329 条 / Talent 112 条，好感度与恋慕双向可查', () => {
    const schema = adapter.variableSchema;
    expect(schema?.names!('CFLAG')).toHaveLength(329);
    expect(schema?.names!('TALENT')).toHaveLength(112);
    expect(schema?.lookup('CFLAG', 2)?.description).toBe('好感度');
    expect(schema?.lookup('CFLAG', '好感度')?.resolvedIndex).toBe(2);
    expect(schema?.lookup('TALENT', '恋慕')?.resolvedIndex).toBe(3);
    expect(schema?.lookup('TALENT', 148)?.description).toBe('亲爱');
  });

  it.skipIf(!hasCorpus)('Chara*.csv 没被当成变量名表（不会出现 CHARA1 族）', () => {
    expect(adapter.variableSchema?.lookup('CHARA1')).toBeUndefined();
    expect(adapter.variableSchema?.lookup('CHARA148')).toBeUndefined();
  });

  it.skipIf(!hasCorpus)('·ERH 作者自定名表：人物_咲夜 = 4（source=const）', () => {
    const info = adapter.variableSchema?.lookup('CFLAG', '人物_咲夜');
    expect(info?.source).toBe('const');
    expect(info?.resolvedIndex).toBe(4);
  });

  it.skipIf(!hasCorpus)('指令名表：同名取首条（接吻 = 20，不是 312）；编号 312 仍可反查', () => {
    const table = adapter.kojoInstructionTable;
    expect(table?.hasTable).toBe(true);
    expect(table?.lookupByName('接吻')).toBe(20);
    expect(table?.lookupByName('胸爱抚')).toBe(6);
    expect(table?.lookupByNo(312)).toBe('接吻');
    expect(table?.names!()).toHaveLength(127);
  });
});

/* ------------------------------ 语义位 / 展示位 / 检索范围 ------------------------------ */

describe('adapter 的语义位与展示位（不依赖工程）', () => {
  it('两条约定规则挂在 adapter 上，id 与 conventions.ts 一致', () => {
    const { adapter } = activateAdapter(nodeIo());
    expect(adapter.conventions?.map((rule) => rule.id)).toEqual([
      'erakoumakan.kojo.chara-mismatch',
      'erakoumakan.kojo.orphan-file',
    ]);
    expect(adapter.conventions?.every((rule) => rule.scope === 'file')).toBe(true);
  });

  it('家族索引 / 面标签 / 指令承载面', () => {
    const { adapter } = activateAdapter(nodeIo());
    expect(adapter.functionFamilyIndex?.name).toBe('erakoumakan-family-index');
    expect(adapter.functionFamilyIndex?.instructionFaces).toEqual(['MESSAGE_COM', 'MESSAGE_SCOM']);
    expect(adapter.functionFamilyIndex?.faceLabels?.KOJO).toBe('口上入口');
  });

  it('nameGlossary / stateLinePresets / kojoFaceTemplates 都是同一份静态表', () => {
    const { adapter } = activateAdapter(nodeIo());
    expect(adapter.nameGlossary).toBe(ERAKOUMAKAN_NAME_GLOSSARY);
    expect(adapter.stateLinePresets).toBe(ERAKOUMAKAN_STATE_LINES);
    expect(adapter.kojoFaceTemplates?.faces['指令']?.template).toBe('KOJO_MESSAGE_COM_K{n}_{i}');
  });

  it('检索范围槽位：只对本项目产出角色目录候选（10 条）', () => {
    const { slots } = activateAdapter(nodeIo());
    const scope = slots.find((s) => s.slot === 'search.scope');
    expect(scope).toBeDefined();
    const item = scope!.item as {
      id: string;
      provide: (p: { adapterId?: string; charaIndex: Map<number, { no: number; name: string; kojoDir?: string }> } | null) => Array<{ id: string; roots: string[] }>;
    };
    expect(item.id).toBe('erakoumakan-chara-scope');
    expect(item.provide(null)).toEqual([]);
    expect(item.provide({ adapterId: 'eratw', charaIndex: new Map() })).toEqual([]);
    const options = item.provide({
      adapterId: ERAKOUMAKAN.gameId,
      charaIndex: new Map([
        [1, { no: 1, name: '红美铃', kojoDir: 'D:/Game/eraKoumakan/ERB/口上/1_美鈴' }],
        [148, { no: 148, name: '息子' }],
      ]),
    });
    expect(options).toHaveLength(1);
    expect(options[0]?.id).toBe('chara:1');
    expect(options[0]?.roots).toHaveLength(1);
  });
});
