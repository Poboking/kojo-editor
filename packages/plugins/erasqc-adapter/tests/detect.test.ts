import { normalizeAdapterDetection } from '@kojo/plugin-api';
/**
 * 工程识别（`detect`）判据。
 *
 * 真盘用例以 `C:/game/eraSQC` 存在为守卫；合成用例钉「三者缺一即不认」的否定面——
 * 识别宽松会把 eraAkumaMaid（同样有 `ERB/EVENT_K`）或普通 Emuera 工程误认成本作。
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERASQC } from '../src/constants';
import { GAME_ROOT, adapterOf, memIo, nodeIo } from './harness';

const hasCorpus = existsSync(GAME_ROOT);

const ROOT = 'C:/mem/eraSQC';
const GAMEBASE = `${ROOT}/CSV/GameBase.csv`;
const CFLAG = `${ROOT}/CSV/Cflag.csv`;
const ROUTE = `${ROOT}/ERB/EVENT_K/EVENT_K.ERB`;

function project(
  title: string,
  opts: { cflag?: boolean; route?: boolean } = {},
) {
  const files: Record<string, string> = { [GAMEBASE]: `タイトル,${title}\n` };
  if (opts.cflag !== false) files[CFLAG] = '995,是乳牛\n';
  if (opts.route !== false) files[ROUTE] = '@KOJO_MESSAGE_COM\nRETURN 0\n';
  const dirs = [`${ROOT}/CSV`, `${ROOT}/ERB`, `${ROOT}/ERB/EVENT_K`];
  return memIo(files, dirs);
}

describe('detect —— 合成工程（三者缺一即不认）', () => {
  it('标题 + 口上路由 + Cflag 齐备 → 命中', async () => {
    expect(normalizeAdapterDetection(await adapterOf(project('erasqn汉化魔改版_返')).detect(ROOT)).matched).toBe(true);
  });

  it('标题对不上（eraAkumaMaid 也有 ERB/EVENT_K）→ 不命中', async () => {
    expect(normalizeAdapterDetection(await adapterOf(project('eraAkumaMaid')).detect(ROOT)).matched).toBe(false);
  });

  it('缺 CSV/Cflag.csv（只有标题与口上的空壳）→ 不命中', async () => {
    expect(normalizeAdapterDetection(await adapterOf(project('erasqn汉化魔改版_返', { cflag: false })).detect(ROOT)).matched).toBe(false);
  });

  it('缺 ERB/EVENT_K/EVENT_K.ERB → 不命中', async () => {
    expect(normalizeAdapterDetection(await adapterOf(project('erasqn汉化魔改版_返', { route: false })).detect(ROOT)).matched).toBe(false);
  });

  it('标题匹配宽容 eraSQC / eraSQN / 大小写与空格', async () => {
    for (const title of ['eraSQC', 'eraSQN', 'era sqc', 'ERASQC']) {
      expect(normalizeAdapterDetection(await adapterOf(project(title)).detect(ROOT)).matched, title).toBe(true);
    }
  });

  it('GameBase 读不出来 → 不命中（不抛）', async () => {
    const io = memIo({ [CFLAG]: '995,是乳牛\n', [ROUTE]: '@KOJO_MESSAGE_COM\n' }, [
      `${ROOT}/CSV`,
      `${ROOT}/ERB`,
      `${ROOT}/ERB/EVENT_K`,
    ]);
    expect(normalizeAdapterDetection(await adapterOf(io).detect(ROOT)).matched).toBe(false);
  });

  it('Cflag 文件名大小写不敏感（魔改版可能写 CFLAG.CSV）', async () => {
    const io = memIo(
      { [GAMEBASE]: 'タイトル,eraSQC\n', [`${ROOT}/CSV/CFLAG.CSV`]: '995,是乳牛\n', [ROUTE]: '@KOJO_MESSAGE_COM\n' },
      [`${ROOT}/CSV`, `${ROOT}/ERB`, `${ROOT}/ERB/EVENT_K`],
    );
    expect(normalizeAdapterDetection(await adapterOf(io).detect(ROOT)).matched).toBe(true);
  });
});

describe('detect —— 真盘实测（守卫：C:/game/eraSQC 存在才跑）', () => {
  it.skipIf(!hasCorpus)('真盘命中：GameBase 标题 + EVENT_K.ERB + Cflag.csv', async () => {
    expect(normalizeAdapterDetection(await adapterOf(nodeIo()).detect(GAME_ROOT)).matched).toBe(true);
  });

  it.skipIf(!hasCorpus)('子目录 C:/game/eraSQC/ERB 不命中：根上缺 GameBase', async () => {
    expect(normalizeAdapterDetection(await adapterOf(nodeIo()).detect(`${GAME_ROOT}/ERB`)).matched).toBe(false);
  });

  it.skipIf(!hasCorpus)('识别常量与真盘一致（标题正则 / 路径）', () => {
    expect(ERASQC.gameId).toBe('erasqc');
    expect(ERASQC.detect.titlePattern.test('タイトル,erasqn汉化魔改版_返')).toBe(true);
    expect(ERASQC.detect.titlePattern.test('タイトル,eraSQC')).toBe(true);
    expect(ERASQC.detect.titlePattern.test('タイトル,eraAkumaMaid')).toBe(false);
  });
});
