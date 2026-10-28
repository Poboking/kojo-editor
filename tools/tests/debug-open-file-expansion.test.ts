/**
 * `debug-cli open-file` 的树展开判据守卫（1028 会话恢复批）。
 *
 * 事由：会话恢复后树里只有"被恢复那一份"的文件行；旧实现 `cmdOpenFile` 借用
 * `expandTreeUntilFile`，而后者**只要树里有任何一行文件**就收工 ⇒ 另一组里的文件一律
 * 报「文件树里没有路径含…的行」。工具输出看着像"树是空的"，实测是"没展开到那一组"
 * （真壳与 web 宿同样复现，产品侧无缺陷）。
 *
 * 钉三条不许回退的口径：
 * ① `cmdOpenFile` 必须走**按目标片段**展开的 `expandCollapsedUntilMatch`，且不再调用
 *    `expandTreeUntilFile`——后者是给"先让树里有文件"的冒烟用的，换个调用方就是假阴性源。
 * ② `expandCollapsedUntilMatch` 的命中判据是 `frag`（`includes(${needle})`），并且只点
 *    **折叠**行（三个选择子都带 `aria-expanded="false"`）——把已展开的点回收起会让树抖动，
 *    还会让下一次展开从同一格重来。
 * ③ `expandTreeUntilFile` 的旧语义**原样保留**（有文件行即 `'file'`）：`debug-web-smoke`
 *    依赖它，别在修 open-file 时顺手把冒烟那边的判据也改了。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'tools', 'debug-cli.mjs');
const LIB = path.join(ROOT, 'tools', 'debug-lib.mjs');

const cliSrc = readFileSync(CLI, 'utf8');
const libSrc = readFileSync(LIB, 'utf8');

/** 抽出 `export async function <name>(...) { ... }` 的函数体（按缩进 0 的空行/收尾括号切） */
function bodyOf(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  expect(start, `${name} 应当存在于 ${path.basename(name === 'expandTreeUntilFile' ? LIB : CLI)}`).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const end = rest.indexOf('\n}\n');
  expect(end, `${name} 的函数体应当有收尾`).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

/** 抽出 `async function <name>(...)` 的 open-file 主体 */
function cmdOpenFileBody(): string {
  const start = cliSrc.indexOf('async function cmdOpenFile(');
  expect(start).toBeGreaterThan(-1);
  const rest = cliSrc.slice(start);
  const end = rest.indexOf('\n}\n');
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

describe('调试 CLI open-file 的树展开判据', () => {
  it('① cmdOpenFile 走按片段展开，不再借用"有文件行就收工"的 expandTreeUntilFile', () => {
    const body = cmdOpenFileBody();
    expect(body).toContain('expandCollapsedUntilMatch(cdp, frag)');
    expect(body).not.toContain('expandTreeUntilFile');
  });

  it('② expandCollapsedUntilMatch 的命中判据是 frag，且只点折叠行', () => {
    const body = bodyOf(libSrc, 'expandCollapsedUntilMatch');
    // 命中判据按传入片段拼（不是"树里有没有任何文件行"）
    expect(body).toContain('includes(${needle})');
    expect(body).toContain('const needle = JSON.stringify(String(frag))');
    // 三个可折叠行都只看 aria-expanded="false"
    for (const sel of ['.tree-group-btn', '.tree-dir', '.tree-package']) {
      expect(body).toContain(`${sel}[aria-expanded="false"]`);
    }
    // 不许再出现"见 .tree-file 就收工"的早退
    expect(body).not.toMatch(/querySelector\(['"]\.tree-file['"]\)\s*\)\s*return 'file'/);
  });

  it('③ expandTreeUntilFile 的旧语义保留（冒烟消费方不受影响）', () => {
    const body = bodyOf(libSrc, 'expandTreeUntilFile');
    expect(body).toContain('querySelector(".tree-file")');
    expect(body).toContain("return 'file'");
  });

  it('④ open-file 失败文案点名"虚拟化/未挂载"而不暗示树是空的', () => {
    const body = cmdOpenFileBody();
    expect(body).toContain('折叠行已点到头仍未命中');
  });
});
