/**
 * 工程识别（`detect`）判据。
 *
 * 真盘用例以 `D:/Game/erafl` 存在为守卫（别的机器整组跳过，不会全红）；
 * 合成用例钉的是"三者缺一即不认"的**否定面**——识别宽松会把普通 Emuera 工程
 * 误认成 eraFL，后续所有口上索引都会指错地方。
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FileIO } from '@kojo/plugin-api';
import { activateAdapter, nodeIo } from './harness';

const GAME_ROOT = 'D:/Game/erafl';
const hasCorpus = existsSync(GAME_ROOT);

/** 合成工程：只实现 detect 用到的 exists / stat 两条 */
function fakeIo(files: readonly string[], dirs: readonly string[]): FileIO {
  const fileSet = new Set(files);
  const dirSet = new Set(dirs);
  // `join()` 在 win32 盘符下产出 `\` 分隔符，而用例表是按 `/` 写的 ⇒ 两侧统一到 `/`
  // 再比。不统一会得到"看着对、永远不命中"的假红（PITFALLS 里那条形态）。
  const norm = (p: string) => p.replace(/\\/g, '/');
  return {
    exists: async (path: string) => fileSet.has(norm(path)) || dirSet.has(norm(path)),
    stat: async (path: string) =>
      dirSet.has(norm(path))
        ? { size: 0, mtimeMs: 0, isDirectory: true }
        : fileSet.has(norm(path))
          ? { size: 1, mtimeMs: 0, isDirectory: false }
          : null,
  } as unknown as FileIO;
}

const ROOT = 'D:/fake/erafl';
const CONFIG = `${ROOT}/FLconfig.xml`;
const CFLAG = `${ROOT}/CSV/CFLAG.CSV`;
const KOJO_DIR = `${ROOT}/ERB/口上`;

describe('detect —— 真盘实测（守卫：D:/Game/erafl 存在才跑）', () => {
  it.skipIf(!hasCorpus)('真盘命中：FLconfig.xml + ERB/口上 目录 + CSV/CFLAG.CSV 三者齐备', async () => {
    expect(await activateAdapter(nodeIo()).detect(GAME_ROOT)).toBe(true);
  });

  it.skipIf(!hasCorpus)('子目录 D:/Game/erafl/ERB 不命中：根上缺 FLconfig.xml', async () => {
    expect(await activateAdapter(nodeIo()).detect(`${GAME_ROOT}/ERB`)).toBe(false);
  });
});

describe('detect —— 合成工程（三者缺一即不认）', () => {
  it('三者齐备 → 命中', async () => {
    const adapter = activateAdapter(fakeIo([CONFIG, CFLAG], [KOJO_DIR]));
    expect(await adapter.detect(ROOT)).toBe(true);
  });

  it('缺 FLconfig.xml → 不命中（普通 Emuera 工程不该被认成 eraFL）', async () => {
    const adapter = activateAdapter(fakeIo([CFLAG], [KOJO_DIR]));
    expect(await adapter.detect(ROOT)).toBe(false);
  });

  it('缺 CSV/CFLAG.CSV → 不命中（只有配置与口上目录的空壳工程）', async () => {
    const adapter = activateAdapter(fakeIo([CONFIG], [KOJO_DIR]));
    expect(await adapter.detect(ROOT)).toBe(false);
  });

  it('ERB/口上 是文件而不是目录 → 不命中', async () => {
    const adapter = activateAdapter(fakeIo([CONFIG, CFLAG, KOJO_DIR], []));
    expect(await adapter.detect(ROOT)).toBe(false);
  });
});
