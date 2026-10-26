/**
 * eraAV 工程识别（`detect`）判据。
 *
 * 真盘用例以 `C:/game/eraAV` 在位为守卫；合成用例钉的是「三件套缺一即不认」的否定面。
 * 最要紧的一条否定面是**同主路由名的别盘**：eraAkumaMaid 的路由文件也叫
 * `EVENT_K.ERB`，只是住在 `ERB/EVENT_K/`——只比文件名就会两个游戏互相串认
 * （内核多命中直接抛 `AdapterConflictError`，工程打不开）。
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GAME_ROOT, adapterOf, memIo, nodeIo } from './harness';

const hasCorpus = existsSync(GAME_ROOT);
const ROOT = 'D:/mem/eraAV';
const GAMEBASE = `${ROOT}/CSV/GameBase.csv`;
const LINES_DIR = `${ROOT}/ERB/Lines`;
const ROUTER = `${ROOT}/ERB/EVENT/EVENT_K.ERB`;

/**
 * 造一个内存盘：`title` 是自述表标题，`linesAsFile` 模拟「口上域只剩同名散文件」，
 * `routerAt` 模拟路由住在别处（`'ERB/EVENT_K'` ＝ eraAkumaMaid 形态）。
 */
function project(
  title: string,
  opts: { linesAsFile?: boolean; routerAt?: string; withLines?: boolean; withRouter?: boolean } = {},
): ReturnType<typeof memIo> {
  const withLines = opts.withLines ?? true;
  const withRouter = opts.withRouter ?? true;
  const files: Record<string, string> = { [GAMEBASE]: `タイトル,${title}\r\n` };
  const dirs = [`${ROOT}/CSV`, `${ROOT}/ERB`, `${ROOT}/ERB/EVENT`];
  if (opts.linesAsFile) files[LINES_DIR] = '; 半截工程：口上域应当是目录\r\n';
  else if (withLines) dirs.push(LINES_DIR);
  if (withRouter) files[opts.routerAt ? `${opts.routerAt}/EVENT_K.ERB` : ROUTER] = '@EVENTTRAIN\r\n';
  return memIo(files, dirs);
}

describe('detect —— 合成工程（三件套缺一即不认）', () => {
  it('Lines 目录 + 主路由 + 标题齐备 → 命中', async () => {
    expect(await adapterOf(project('Erav优化整合版')).detect(ROOT)).toMatchObject({ matched: true });
    // README 的另一拼写（`eraAV`）也要认：真盘两种写法都在
    expect(await adapterOf(project('eraAV')).detect(ROOT)).toMatchObject({ matched: true });
  });

  it('口上域不是目录（只剩同名散文件）→ 不命中', async () => {
    expect(await adapterOf(project('Erav优化整合版', { linesAsFile: true })).detect(ROOT)).toMatchObject({ matched: false });
  });

  it('主路由住在 `ERB/EVENT_K/`（eraAkumaMaid 形态）→ 不命中，不串认', async () => {
    expect(await adapterOf(project('Erav优化整合版', { routerAt: 'ERB/EVENT_K' })).detect(ROOT)).toMatchObject({ matched: false });
  });

  it('缺主路由文件（空壳 Lines）→ 不命中', async () => {
    expect(await adapterOf(project('Erav优化整合版', { withRouter: false })).detect(ROOT)).toMatchObject({ matched: false });
  });

  it('标题对不上（别的 era 作品）→ 不命中', async () => {
    // `erav` 这种「少一个 a」的拼写不在本作任何自述里；真盘是 `Erav` 或 `eraAV`
    expect(await adapterOf(project('era紅魔館protoNTR')).detect(ROOT)).toMatchObject({ matched: false });
    expect(await adapterOf(project('eratohoK')).detect(ROOT)).toMatchObject({ matched: false });
    expect(await adapterOf(project('Succubus Quest Characters')).detect(ROOT)).toMatchObject({ matched: false });
  });

  it('缺 `CSV/GameBase.csv` → 不命中', async () => {
    const io = memIo({ [ROUTER]: '@EVENTTRAIN\r\n' }, [LINES_DIR, `${ROOT}/ERB`]);
    expect(await adapterOf(io).detect(ROOT)).toMatchObject({ matched: false });
  });
});

describe('detect —— 真盘（C:/game/eraAV）', () => {
  it.skipIf(!hasCorpus)('真盘命中，且三件套路径逐一在位', async () => {
    const io = nodeIo();
    expect(await adapterOf(io).detect(GAME_ROOT)).toMatchObject({ matched: true });
    expect(await io.stat(`${GAME_ROOT}/ERB/Lines`)).toMatchObject({ isDirectory: true });
    expect(await io.exists(`${GAME_ROOT}/ERB/EVENT/EVENT_K.ERB`)).toBe(true);
    expect(await io.exists(`${GAME_ROOT}/CSV/GameBase.csv`)).toBe(true);
    // 盘上没有 `ERB/EVENT_K/`（akuma 形态）——这条是「不串认」的真盘证据
    expect(await io.exists(`${GAME_ROOT}/ERB/EVENT_K`)).toBe(false);
  });
});
