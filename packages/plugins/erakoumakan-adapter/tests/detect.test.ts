import { normalizeAdapterDetection } from '@kojo/plugin-api';
/**
 * 工程识别（`detect`）判据。
 *
 * 真盘用例以 `D:/Game/eraKoumakan` 存在为守卫；合成用例钉的是「三者缺一即不认」
 * 的否定面——识别宽松会把 eraFL（同样有 `ERB/口上`）或普通 Emuera 工程误认成本作。
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERAKOUMAKAN } from '../src/constants';
import { GAME_ROOT, adapterOf, memIo, nodeIo } from './harness';

const hasCorpus = existsSync(GAME_ROOT);

const ROOT = 'D:/mem/eraKoumakan';
const GAMEBASE = `${ROOT}/CSV/GameBase.csv`;
const CFLAG = `${ROOT}/CSV/CFLAG.csv`;
const KOJO_DIR = `${ROOT}/ERB/口上`;

function project(title: string, opts: { cflag?: boolean; kojoAsFile?: boolean } = {}) {
  const files: Record<string, string> = { [GAMEBASE]: `タイトル,${title}\n` };
  if (opts.cflag !== false) files[CFLAG] = '2,好感度\n';
  const dirs = [`${ROOT}/CSV`, `${ROOT}/ERB`];
  if (opts.kojoAsFile === true) {
    files[KOJO_DIR] = '; 半截工程：口上域应当是目录\n';
  } else {
    dirs.push(KOJO_DIR);
  }
  return memIo(files, dirs);
}

describe('detect —— 合成工程（三者缺一即不认）', () => {
  it('标题 + 口上目录 + CFLAG 齐备 → 命中', async () => {
    expect(normalizeAdapterDetection(await adapterOf(project('era紅魔館protoNTR')).detect(ROOT)).matched).toBe(true);
  });

  it('标题对不上（eraFL 也有 ERB/口上）→ 不命中', async () => {
    expect(normalizeAdapterDetection(await adapterOf(project('eraFL')).detect(ROOT)).matched).toBe(false);
  });

  it('缺 CSV/CFLAG.csv（只有标题与口上目录的空壳）→ 不命中', async () => {
    expect(normalizeAdapterDetection(await adapterOf(project('era紅魔館protoNTR', { cflag: false })).detect(ROOT)).matched).toBe(false);
  });

  it('ERB/口上 是文件而不是目录 → 不命中', async () => {
    expect(normalizeAdapterDetection(await adapterOf(project('era紅魔館protoNTR', { kojoAsFile: true })).detect(ROOT)).matched).toBe(false);
  });

  it('标题匹配宽容日文旧字 / 英文目录名', async () => {
    expect(normalizeAdapterDetection(await adapterOf(project('era红魔館protoNTR')).detect(ROOT)).matched).toBe(true);
    expect(normalizeAdapterDetection(await adapterOf(project('eraKoumakan')).detect(ROOT)).matched).toBe(true);
  });

  it('GameBase 读不出来 → 不命中（不抛）', async () => {
    // 只给目录，不给 GameBase 文件：exists 为 false
    const io = memIo({ [CFLAG]: '2,好感度\n' }, [`${ROOT}/CSV`, `${ROOT}/ERB`, KOJO_DIR]);
    expect(normalizeAdapterDetection(await adapterOf(io).detect(ROOT)).matched).toBe(false);
  });
});

describe('detect —— 真盘实测（守卫：D:/Game/eraKoumakan 存在才跑）', () => {
  it.skipIf(!hasCorpus)('真盘命中：GameBase 标题 + ERB/口上 目录 + CSV/CFLAG.csv', async () => {
    expect(normalizeAdapterDetection(await adapterOf(nodeIo()).detect(GAME_ROOT)).matched).toBe(true);
  });

  it.skipIf(!hasCorpus)('子目录 D:/Game/eraKoumakan/ERB 不命中：根上缺 GameBase', async () => {
    expect(normalizeAdapterDetection(await adapterOf(nodeIo()).detect(`${GAME_ROOT}/ERB`)).matched).toBe(false);
  });

  it.skipIf(!hasCorpus)('识别常量与真盘一致（标题正则 / 路径）', () => {
    expect(ERAKOUMAKAN.gameId).toBe('erakoumakan');
    expect(ERAKOUMAKAN.detect.titlePattern.test('タイトル,era紅魔館protoNTR')).toBe(true);
    expect(ERAKOUMAKAN.detect.titlePattern.test('タイトル,eraKoumakan')).toBe(true);
    expect(ERAKOUMAKAN.detect.titlePattern.test('タイトル,eraFL')).toBe(false);
  });
});
