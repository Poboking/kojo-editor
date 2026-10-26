/**
 * eratohoReverse `loadProject` 判据（P1 最小回路：角色索引 + 口上目录绑定 + 摘要 + 可写域）。
 *
 * 与 eraAV 那一枚的**唯一结构差别**钉在这里：本作的口上是「一角色一目录」
 * （`ERB/口上/{NNNN}_{名}/`，实测 25 个），所以 `CharaInfo.kojoDir` **必须**建起来
 * ——角色级检索范围（`search.scope`）与导航全靠它；反过来 eraAV 那盘一律不建。
 * 两枚用例并排放着，是为了让后人别把「别盘的口径」抄过来。
 */

import { existsSync } from 'node:fs';
import { join } from '@kojo/plugin-api';
import { describe, expect, it } from 'vitest';
import { GAME_ROOT, adapterOf, memIo, nodeIo } from './harness';

const hasCorpus = existsSync(GAME_ROOT);
const ROOT = 'D:/mem/eratohoReverse';

function synth(): ReturnType<typeof memIo> {
  return memIo(
    {
      [`${ROOT}/CSV/GameBase.csv`]: 'タイトル,eratohoЯeverse\n',
      [`${ROOT}/ERB/口上/EVENT_K.ERB`]: '@KOJO_CALL\n',
      [`${ROOT}/ERB/口上/KOJO_PROFILE.ERB`]: '@KOJO_PROFILE\n',
      [`${ROOT}/CSV/CHARA/Chara1_霊夢.csv`]: '番号,1\n名前,霊夢\n呼び名,霊夢\n',
      [`${ROOT}/CSV/CHARA/Chara0_あなた.csv`]: '番号,0\n名前,您\n呼び名,あなた\n',
      [`${ROOT}/CSV/CHARA/Chara79_神子.csv`]: '番号,79\n名前,神子\n',
      [`${ROOT}/ERB/口上/0001_霊夢/KOJO_ACT_K1/ACT_00_会話_K1.ERB`]: '@KOJO_ACT_K1_会話\n',
      [`${ROOT}/ERB/口上/0079_神子/KOJO_ACT_K79/ACT_00_会話_K79.ERB`]: '@KOJO_ACT_K79_会話\n',
      // 模板占位目录：不是角色，不许建条目
      [`${ROOT}/ERB/口上/キャラ番号_キャラ名/KOJO_ACT_KX2.ERB`]: '@KOJO_ACT_KX2\n',
      [`${ROOT}/CSV/Train.csv`]: '0,素股\n1,手コキ\n',
    },
    [
      `${ROOT}/CSV/CHARA`,
      `${ROOT}/ERB/口上/0001_霊夢`,
      `${ROOT}/ERB/口上/0079_神子`,
      `${ROOT}/ERB/口上/キャラ番号_キャラ名`,
    ],
  );
}

describe('loadProject —— 合成工程', () => {
  it('角色来自 CSV 建、口上目录绑定 kojoDir、占位目录不建条目', async () => {
    const adapter = adapterOf(synth());
    const project = await adapter.loadProject(ROOT);
    expect(project.adapterId).toBe('eratohoreverse');
    expect([...project.charaIndex.keys()].sort((a, b) => a - b)).toEqual([0, 1, 79]);
    // 有目录的角色必须带上目录路径（角色级检索与导航的落点判据）
    expect(project.charaIndex.get(1)?.kojoDir).toContain(join('ERB', '口上', '0001_霊夢'));
    expect(project.charaIndex.get(0)?.kojoDir, '没有 0000 目录 ⇒ 玩家角色本就无口上目录').toBeUndefined();
    // `キャラ番号_キャラ名` 既没建条目，也没被当成某角色的目录
    const dirs = [...project.charaIndex.values()].map((i) => i.kojoDir ?? '');
    expect(dirs.some((d) => d.includes('キャラ番号'))).toBe(false);
  });

  it('可写域只有 `ERB/口上`；索引吃整棵 ERB；无 savDir', async () => {
    const project = await adapterOf(synth()).loadProject(ROOT);
    expect(project.writablePaths).toEqual([join(ROOT, 'ERB', '口上')]);
    expect(project.kojoPaths).toEqual([join(ROOT, 'ERB')]);
    expect(project.savDir).toBeUndefined();
  });

  it('非 ERB 输入（Chara 正文 + 口上目录名 + 字典）折进 inputDigest', async () => {
    const project = await adapterOf(synth()).loadProject(ROOT);
    expect(typeof project.inputDigest).toBe('string');
    expect(project.inputDigest!.length).toBeGreaterThan(0);
  });
});

describe('loadProject —— 真盘（C:/game/eratohoReverse）', () => {
  it.skipIf(!hasCorpus)('108 份角色 CSV 全建上、25 个口上目录逐一绑定', async () => {
    const adapter = adapterOf(nodeIo());
    expect(await adapter.detect(GAME_ROOT)).toMatchObject({ matched: true });
    const project = await adapter.loadProject(GAME_ROOT);
    expect(project.charaIndex.size).toBe(108); // 实测 108 份，番号 0–107 连续且与文件名逐份一致
    const bound = [...project.charaIndex.values()].filter((i) => i.kojoDir).length;
    expect(bound, '口上目录绑定数（实测 25 个角色目录）').toBe(25);
    expect(project.charaIndex.get(1)?.name).toBe('霊夢');
    expect(project.charaIndex.get(0)?.name, '玩家条目在 CSV 里名前是「您」').toBe('您');
    expect(project.writablePaths).toEqual([join(GAME_ROOT, 'ERB', '口上')]);
    expect(typeof project.inputDigest).toBe('string');
  });

  it.skipIf(!hasCorpus)('字典带得上，`Global` 与 `Globals` 是两张表（不前缀合并）', async () => {
    const adapter = adapterOf(nodeIo());
    await adapter.loadProject(GAME_ROOT);
    const schema = adapter.variableSchema;
    expect(schema, '真盘变量字典缺席').toBeDefined();
    // 本作实测两张并存的表：族名归一后必须各自可查（前缀吞成一张 = 名字表串味）
    expect(schema!.lookup('GLOBAL')).toBeDefined();
    expect(schema!.lookup('GLOBALS')).toBeDefined();
    expect(adapter.kojoInstructionTable?.hasTable).toBe(true);
  });
});
