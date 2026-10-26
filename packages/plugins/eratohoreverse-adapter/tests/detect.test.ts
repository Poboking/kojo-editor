/**
 * eratohoReverse 工程识别（`detect`）判据。
 *
 * 真盘用例以 `C:/game/eratohoReverse` 在位为守卫；合成用例钉的是「三件套缺一即不认」的否定面。
 * 两处非显然的否定面都来自真盘事实：
 * ① 标题里的 **Я 是西里尔字母**（`CSV/GameBase.csv:10-11`）——任何按拉丁 `eratoho…K`
 *    写的判据（eratohoK 就是）对本作不成立，反过来本作也不该把 eratohoK 的盘认下来；
 * ② `ERB/口上` 这个目录名 eraFL / era紅魔館 / eratohoK **都有**，只比目录会把四个游戏认混；
 *    而 `EVENT_K.ERB` 这个文件名 eraAV（住 `ERB/EVENT/`）与 eraAkumaMaid（住 `ERB/EVENT_K/`）
 *    也有——必须连父目录 `ERB/口上/` 一起钉。
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GAME_ROOT, adapterOf, memIo, nodeIo } from './harness';

const hasCorpus = existsSync(GAME_ROOT);
const ROOT = 'D:/mem/eratohoReverse';
const GAMEBASE = `${ROOT}/CSV/GameBase.csv`;
const KOJO_DIR = `${ROOT}/ERB/口上`;
const ROUTER = `${ROOT}/ERB/口上/EVENT_K.ERB`;

function project(
  title: string,
  opts: { kojoAsFile?: boolean; routerAt?: string; withRouter?: boolean } = {},
): ReturnType<typeof memIo> {
  const files: Record<string, string> = { [GAMEBASE]: `タイトル,${title}\n` };
  const dirs = [`${ROOT}/CSV`, `${ROOT}/ERB`];
  if (opts.kojoAsFile) {
    // 只留一个同名散文件：注意**不能**再往 `ERB/口上/` 下面挂路由，
    // 否则内存盘会由文件路径反推出父目录，把「不是目录」这一判据自己洗掉
    files[KOJO_DIR] = '; 半截工程：口上域应当是目录\n';
    return memIo(files, dirs);
  }
  dirs.push(KOJO_DIR);
  if (opts.withRouter !== false) {
    files[opts.routerAt ? `${opts.routerAt}/EVENT_K.ERB` : ROUTER] = '@KOJO_CALL\n';
  }
  return memIo(files, dirs);
}

describe('detect —— 合成工程（三件套缺一即不认）', () => {
  it('标题（西里尔 Я 原样）+ 口上目录 + 根层路由齐备 → 命中', async () => {
    expect(await adapterOf(project('eratohoЯeverse')).detect(ROOT)).toMatchObject({ matched: true });
    // 汉化/转载盘把 Я 打成拉丁 R 的形态也要认（判据只看 `eratoho…everse`）
    expect(await adapterOf(project('eratohoReverse')).detect(ROOT)).toMatchObject({ matched: true });
  });

  it('标题是 eratohoK / era紅魔館 / eraFL → 不命中（三家同样有 `ERB/口上`）', async () => {
    expect(await adapterOf(project('eratohoK')).detect(ROOT)).toMatchObject({ matched: false });
    expect(await adapterOf(project('era紅魔館protoNTR')).detect(ROOT)).toMatchObject({ matched: false });
    expect(await adapterOf(project('eraFL')).detect(ROOT)).toMatchObject({ matched: false });
  });

  it('口上域不是目录（只剩同名散文件）→ 不命中', async () => {
    expect(await adapterOf(project('eratohoЯeverse', { kojoAsFile: true })).detect(ROOT)).toMatchObject({ matched: false });
  });

  it('主路由住在 `ERB/EVENT/`（eraAV 形态）或 `ERB/EVENT_K/`（akuma 形态）→ 不命中', async () => {
    expect(await adapterOf(project('eratohoЯeverse', { routerAt: 'ERB/EVENT' })).detect(ROOT)).toMatchObject({ matched: false });
    expect(await adapterOf(project('eratohoЯeverse', { routerAt: 'ERB/EVENT_K' })).detect(ROOT)).toMatchObject({ matched: false });
  });

  it('缺根层路由文件 → 不命中', async () => {
    expect(await adapterOf(project('eratohoЯeverse', { withRouter: false })).detect(ROOT)).toMatchObject({ matched: false });
  });

  it('缺 `CSV/GameBase.csv` → 不命中', async () => {
    const io = memIo({ [ROUTER]: '@KOJO_CALL\n' }, [KOJO_DIR, `${ROOT}/ERB`]);
    expect(await adapterOf(io).detect(ROOT)).toMatchObject({ matched: false });
  });
});

describe('detect —— 真盘（C:/game/eratohoReverse）', () => {
  it.skipIf(!hasCorpus)('真盘命中，且标题里的 Я 确是西里尔字母（不是拉丁 R）', async () => {
    const io = nodeIo();
    expect(await adapterOf(io).detect(GAME_ROOT)).toMatchObject({ matched: true });
    const gameBase = await io.readText(`${GAME_ROOT}/CSV/GameBase.csv`);
    // U+042F 是西里尔 Я；若哪天盘上换成拉丁 R，判据仍成立，但这条读数要现形而不是静默变味
    expect(gameBase.text).toMatch(/eratoho[^\r\n]*everse/i);
    expect(await io.stat(`${GAME_ROOT}/ERB/口上`)).toMatchObject({ isDirectory: true });
    expect(await io.exists(`${GAME_ROOT}/ERB/口上/EVENT_K.ERB`)).toBe(true);
    // 本作没有 `ERB/EVENT/`，也没有 akuma 的 `ERB/EVENT_K/` ⇒ 与另两盘的父目录判据互斥
    expect(await io.exists(`${GAME_ROOT}/ERB/EVENT`)).toBe(false);
    expect(await io.exists(`${GAME_ROOT}/ERB/EVENT_K`)).toBe(false);
  });
});
