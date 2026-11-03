/**
 * KW-36 P1 的第二半：`cmdOpenFile` **源形状**钉子（node 池，读源码不建 DOM）。
 *
 * 与 `debug-open-file-search-surface.test.ts` 分两份的理由：那份要 happy-dom（树/面板的 DOM 夹具），
 * 而 DOM 环境里 `import.meta.url` 不是 `file:` 协议，读不到仓库源码；本份读源码不需要 DOM。
 * 两份合起来才是「改前红、改后绿」：夹具那份证明树那条腿**结构上够不到**、新那条腿点得到，
 * 本份证明 CLI 真把两腿接起来了，而且**没有**新造第二条打开通道。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const cliSrc = readFileSync(path.join(ROOT, 'tools', 'debug-cli.mjs'), 'utf8');
const libSrc = readFileSync(path.join(ROOT, 'tools', 'debug-lib.mjs'), 'utf8');

/** 抠出 `async function cmdOpenFile(` 到它自己的收尾（下一个 0 缩进 `}`） */
function cmdOpenFileBody(): string {
  const start = cliSrc.indexOf('async function cmdOpenFile(');
  expect(start).toBeGreaterThan(-1);
  const rest = cliSrc.slice(start);
  const end = rest.indexOf('\n}\n');
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

function quickOpenSurfaceBody(): string {
  const start = cliSrc.indexOf('function quickOpenSurface(cdp) {');
  expect(start, 'quickOpenSurface 应当在 debug-cli 里（四枚动作都从那一条腿走）').toBeGreaterThan(-1);
  const rest = cliSrc.slice(start);
  const end = rest.indexOf('\n}\n');
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

describe('P1 · cmdOpenFile 的源形状（换入口不换通道）', () => {
  it('① 树那条腿失败后**确实**走「快速打开」，收尾仍是既有的路径对拍', () => {
    const b = cmdOpenFileBody();
    expect(b).toContain('expandCollapsedUntilMatch(cdp, frag)');
    expect(b).toContain('openFileViaSearchSurface(surface, frag)');
    expect(b).toContain('quickOpenSurface(cdp)');
    // 结束条件一个字没动：editor.info().path 归一化后必须含片段（点了没切过去照样红）
    expect(b).toContain('normPath(actual).includes(want)');
  });

  it('② 那条腿不碰宿主 IO、不自决定落点（只开面板 / 打词 / 读行 / 真实点击那一行）', () => {
    const b = cmdOpenFileBody();
    expect(b).not.toContain('__kojoDebug.invoke(');
    expect(b).not.toContain('read_file_bytes');
    const surface = quickOpenSurfaceBody();
    // 开面板＝命令面板那条路（与真人 Ctrl+P 同一个入口），点行＝真实点击
    expect(surface).toContain(`__kojoDebug.commands.run('workbench.quickOpen')`);
    expect(surface).toContain('data-idx');
    expect(surface).toContain('cdpClick(cdp, ');
    expect(surface).toContain("Input.insertText");
    expect(surface).not.toContain('invoke(');
    expect(surface).not.toContain('write_file');
  });

  it('③ 两条入口都不命中时报错带**两腿各自的读数**（不暗示树是空的）', () => {
    const b = cmdOpenFileBody();
    expect(b).toContain('折叠行已点到头仍未命中');
    expect(b).toContain('no-palette');
    expect(b).toContain('候选 ${via.rows} 行里没有路径含');
    expect(b).toContain('文件树未挂载这一组');
  });

  it('④ 失败收尾要关面板（不给下一次调用留半截面）', () => {
    const b = cmdOpenFileBody();
    expect(b).toContain('await surface.close()');
    expect(quickOpenSurfaceBody()).toContain('.picker-backdrop');
  });
});

describe('P1 · debug-lib 交出的三个面（导出口径钉子）', () => {
  it('① 三枚都 export，且判据是纯函数（不碰 CDP）', () => {
    expect(libSrc).toContain('export function quickOpenTermFor(frag)');
    expect(libSrc).toContain('export function pickQuickOpenRow(rows, frag)');
    expect(libSrc).toContain('export async function openFileViaSearchSurface(surface, frag');
    const pick = libSrc.slice(libSrc.indexOf('export function pickQuickOpenRow'), libSrc.indexOf('export async function openFileViaSearchSurface'));
    expect(pick).not.toContain('cdp');
  });

  it('② 驱动只认注入的四枚动作，页面选择器只出现一次（不散落到 CLI 之外）', () => {
    const driver = libSrc.slice(libSrc.indexOf('export async function openFileViaSearchSurface'));
    for (const m of ['surface.openPalette()', 'surface.setQuery(term)', 'surface.readRows()', 'surface.pickRow(hit.idx)']) {
      expect(driver, `驱动应当调用 ${m}`).toContain(m);
    }
    expect(driver).toContain('quickOpenTermFor(frag)');
    expect(driver).toContain('pickQuickOpenRow(rows, frag)');
  });

  it('③ 既有的两条展开腿语义不许被顺手改掉（冒烟还靠 expandTreeUntilFile）', () => {
    const untilFile = libSrc.slice(libSrc.indexOf('export async function expandTreeUntilFile'));
    expect(untilFile).toContain('querySelector(".tree-file")');
    expect(untilFile).toContain("return 'file'");
  });
});
