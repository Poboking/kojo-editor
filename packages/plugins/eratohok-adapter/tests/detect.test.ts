/**
 * 工程识别（`detect`）判据。
 *
 * 真盘用例以 `D:/game/eratohoK` 存在为守卫；合成用例钉的是「三者缺一即不认」
 * 的否定面——识别宽松会把同样有 `ERB/口上` 的 eraFL / era紅魔館 误认成本作。
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERATOHOK } from '../src/constants';
import { GAME_ROOT, adapterOf, memIo, nodeIo } from './harness';

const hasCorpus = existsSync(GAME_ROOT);

const ROOT = 'D:/mem/eratohoK';
const GAMEBASE = `${ROOT}/CSV/GameBase.csv`;
const CFLAG = `${ROOT}/CSV/CFLAG.CSV`;
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
    expect(await adapterOf(project('eratohoK')).detect(ROOT)).toBe(true);
  });

  it('标题对不上（eraFL / era紅魔館 也有 ERB/口上）→ 不命中', async () => {
    expect(await adapterOf(project('eraFL')).detect(ROOT)).toBe(false);
    expect(await adapterOf(project('era紅魔館protoNTR')).detect(ROOT)).toBe(false);
    // eraNAS（eraThe World AnonTW）是 eraTW 魔改，标题里没有 eratohoK
    expect(await adapterOf(project('eraThe World AnonTW')).detect(ROOT)).toBe(false);
  });

  it('缺 CSV/CFLAG.CSV（只有标题与口上目录的空壳）→ 不命中', async () => {
    expect(await adapterOf(project('eratohoK', { cflag: false })).detect(ROOT)).toBe(false);
  });

  it('CFLAG 大小写不敏感：`Cflag.csv` 也认', async () => {
    const io = memIo(
      { [GAMEBASE]: 'タイトル,eratohoK\n', [`${ROOT}/CSV/Cflag.csv`]: '2,好感度\n' },
      [`${ROOT}/CSV`, `${ROOT}/ERB`, KOJO_DIR],
    );
    expect(await adapterOf(io).detect(ROOT)).toBe(true);
  });

  it('ERB/口上 是文件而不是目录 → 不命中', async () => {
    expect(await adapterOf(project('eratohoK', { kojoAsFile: true })).detect(ROOT)).toBe(false);
  });

  it('GameBase 读不出来 → 不命中（不抛）', async () => {
    const io = memIo({ [CFLAG]: '2,好感度\n' }, [`${ROOT}/CSV`, `${ROOT}/ERB`, KOJO_DIR]);
    expect(await adapterOf(io).detect(ROOT)).toBe(false);
  });
});

describe('detect —— 真盘实测（守卫：D:/game/eratohoK 存在才跑）', () => {
  it.skipIf(!hasCorpus)('真盘命中：GameBase 标题 + ERB/口上 目录 + CSV/CFLAG.CSV', async () => {
    expect(await adapterOf(nodeIo()).detect(GAME_ROOT)).toBe(true);
  });

  it.skipIf(!hasCorpus)('子目录 D:/game/eratohoK/ERB 不命中：根上缺 GameBase', async () => {
    expect(await adapterOf(nodeIo()).detect(`${GAME_ROOT}/ERB`)).toBe(false);
  });

  it('识别常量与真盘一致（标题正则 / 路径）', () => {
    expect(ERATOHOK.gameId).toBe('eratohok');
    expect(ERATOHOK.detect.titlePattern.test('タイトル,eratohoK')).toBe(true);
    expect(ERATOHOK.detect.titlePattern.test('ウィンドウタイトル,eratohoK')).toBe(true);
    expect(ERATOHOK.detect.titlePattern.test('タイトル,eraFL')).toBe(false);
    expect(ERATOHOK.detect.titlePattern.test('タイトル,era紅魔館protoNTR')).toBe(false);
  });
});
