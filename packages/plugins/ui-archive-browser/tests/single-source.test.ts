/**
 * 归档读取单源守门（W13 ARCHIVE-READ，结构自证；违例直接红）。
 *
 * 钉的是"只有一份"这件事本身——行为测试能证明这一份是对的，只有结构扫描能证明
 * **没有第二份**：
 *
 * 1. `formatBytes` 在归档读取链路（契约 + 解析插件 + 浏览器面板）里只许有一处**定义**，
 *    且住在契约 `packages/plugin-api/src/archive.ts`；
 * 2. 浏览器面板里不许再出现路径自拼接（`.split(/[` 形态 / 自写 `shortPath`）——路径只走
 *    `paths` 通道与契约的 `archiveEntryLabel` / `archiveEntryFileName`；
 * 3. 浏览器面板不许出现任何写盘原语（`writeBytes` / `ensureDir` / `exportFile` / `appDataDir`）：
 *    面板只发意图，落盘在单源；
 * 4. `ArchiveReaderService` 的实现全仓只许有一处（归档解析插件），服务键字面量只住契约；
 * 5. 取出落点目录名只住契约常量（`ARCHIVE_EXTRACT_DIR`），别处引用不许再写字面量；
 * 6. `ArchiveExtractRequest` 里不许出现任何"目标路径"字段（铁律 6：域外写只能经对话框）；
 * 7. 新契约零游戏名词（与 `pnpm audit:decoupling` A 项同一把尺，先在这里自查一遍）。
 *
 * 已知在本批边界外的两份同名实现（`ui-market/src/market-view.ts`、`app/src/ui/update-check.ts`）
 * 分别是市场占用与更新进度条口径，**不在归档读取链路内**（故第 1 项按链路范围判定），
 * 由后续批次一并收口到契约那份。先例：`kojo-market/tests/single-source.test.ts`。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join as nodeJoin, relative as nodeRel, resolve as nodeResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = nodeResolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const SELF = nodeJoin(ROOT, 'packages', 'plugins', 'ui-archive-browser', 'tests', 'single-source.test.ts');

const CONTRACT = 'packages/plugin-api/src/archive.ts';
const PARSER_SRC = 'packages/plugins/sav-parser/src';
const BROWSER_SRC = 'packages/plugins/ui-archive-browser/src';
const READER_IMPL = 'packages/plugins/sav-parser/src/archive-reader.ts';

/** 生产面扫描根（测试替身允许出现方法名，产品代码里出现第二处才是要防的事） */
const PROD_ROOTS = ['packages/plugin-api/src', 'packages/kernel/src', 'packages/app/src', 'packages/plugins'];

function walk(dirRel: string, out: string[] = []): string[] {
  const abs = nodeJoin(ROOT, dirRel);
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist' || name === 'target' || name === 'src-tauri') continue;
    const p = nodeJoin(abs, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(nodeRel(ROOT, p).replaceAll('\\', '/'), out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string): string => nodeRel(ROOT, p).replaceAll('\\', '/');
const text = (fileRel: string): string => readFileSync(nodeJoin(ROOT, fileRel), 'utf8');

/** 去掉注释行（与 audit A 同口径：注释里的元描述不算实现，也不算违规） */
function codeLines(src: string): string[] {
  return src
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^(\/\/|\/\/\/|\/\*|\*)/.test(l));
}

const countMatches = (haystack: string, re: RegExp): number => [...haystack.matchAll(re)].length;
const codeOf = (fileRel: string): string => codeLines(text(fileRel)).join('\n');

/** 归档读取链路的生产源码（契约 + 解析插件 + 浏览器面板） */
const chainFiles = [CONTRACT, ...walk(PARSER_SRC), ...walk(BROWSER_SRC)].map(rel);

describe('归档读取单源 · 结构自证', () => {
  it('链路内 `formatBytes` 只有一处定义，且住在契约里', () => {
    const defs = chainFiles.filter((f) => countMatches(text(f), /function\s+formatBytes\s*\(/g) > 0);
    expect(defs).toEqual([CONTRACT]);
  });

  it('浏览器面板不自带字节格式化，也不自带时间戳之外的第二份实现', () => {
    for (const f of chainFiles.filter((x) => x.startsWith(BROWSER_SRC))) {
      expect(codeOf(f), `${f} 不该自带 formatBytes`).not.toMatch(/(?:function|const)\s+formatBytes\b/);
    }
  });

  it('浏览器面板不留第二份路径拼接（分隔符口径只走 paths 通道 / 契约标签函数）', () => {
    for (const f of chainFiles.filter((x) => x.startsWith(BROWSER_SRC))) {
      const code = codeOf(f);
      expect(code, `${f} 不许自写分隔符拆分`).not.toMatch(/\.split\(\s*\//);
      expect(code, `${f} 不许自写 shortPath`).not.toMatch(/function\s+shortPath|const\s+shortPath\b/);
      expect(code, `${f} 不许自拼落点目录`).not.toMatch(/archive-extractions/);
    }
  });

  it('浏览器面板零写盘原语（落盘只在单源，面板只发意图）', () => {
    const banned = ['writeBytes', 'writeText', 'ensureDir', 'exportFile', 'appDataDir', 'copyFile', 'removeFile', 'rename'];
    for (const f of chainFiles.filter((x) => x.startsWith(BROWSER_SRC))) {
      const code = codeOf(f);
      for (const verb of banned) {
        expect(code, `${f} 出现写盘原语 ${verb}`).not.toMatch(new RegExp(`\\b${verb}\\s*\\(`));
      }
    }
  });

  it('浏览器面板不再消费 snapshot.source（读取入口只剩 archive.reader 一条）', () => {
    for (const f of chainFiles.filter((x) => x.startsWith(BROWSER_SRC))) {
      expect(codeOf(f), `${f} 不该再引 snapshot.source`).not.toMatch(/SnapshotSource\b|snapshot\.source/);
    }
  });

  it('ArchiveReaderService 的实现全仓一处；服务键字面量只住契约', () => {
    const implementers = PROD_ROOTS.flatMap((r) => walk(r))
      .map(rel)
      .filter((f) => !f.includes('/tests/') && f !== rel(SELF))
      .filter((f) => /implements\s+ArchiveReaderService\b/.test(text(f)));
    expect(implementers).toEqual([READER_IMPL]);

    const keyOwners = PROD_ROOTS.flatMap((r) => walk(r))
      .map(rel)
      .filter((f) => !f.includes('/tests/') && f !== rel(SELF))
      .filter((f) => codeOf(f).includes("'archive.reader'") || codeOf(f).includes('"archive.reader"'));
    expect(keyOwners).toEqual([CONTRACT]);
  });

  it('取出落点目录名只住契约常量', () => {
    const owners = PROD_ROOTS.flatMap((r) => walk(r))
      .map(rel)
      .filter((f) => !f.includes('/tests/') && f !== rel(SELF))
      .filter((f) => codeLines(text(f)).some((l) => l.includes("'archive-extractions'")));
    expect(owners).toEqual([CONTRACT]);
  });

  it('读取器实现不硬编码暂存目录、不碰 appData（落点拼接只在契约一处）', () => {
    const src = text(READER_IMPL);
    // 落点由契约的 `archiveWorkspaceLanding` 算出：实现里既没有目录常量也没有第二份 join
    expect(src).toContain('archiveWorkspaceLanding');
    expect(src).not.toMatch(/ARCHIVE_EXTRACT_DIR/);
    expect(src).not.toMatch(/['"](?:extractions|staging|tmp|temp)[^'"]*['"]/i);
    expect(src).not.toMatch(/appDataDir/);
    expect(src).not.toMatch(/removeDir|removeFile/);
    const contract = text(CONTRACT);
    expect(contract).toContain('ARCHIVE_EXTRACT_DIR');
    expect(countMatches(contract, /\bjoin\(/g), '契约里落点拼接只有一条（archiveWorkspaceLanding）').toBe(1);
  });

  it('契约的取出请求里没有目标路径字段（铁律 6：域外写只经对话框）', () => {
    const block = /export type ArchiveExtractRequest[\s\S]*?;(?=\r?\n)/.exec(text(CONTRACT));
    expect(block, 'ArchiveExtractRequest 定义必须存在').not.toBeNull();
    const body = block![0];
    expect(countMatches(body, /\b(?:target|dest|destination|outDir|dirPath|rootDir|landingPath|to)\s*:/gi)).toBe(0);
    expect(countMatches(body, /kind:\s*'workspace'/g), 'workspace 形态一处').toBe(1);
    expect(countMatches(body, /kind:\s*'dialog'/g), 'dialog 形态一处').toBe(1);
    expect(countMatches(body, /entryPath\s*:/g), '两种形态各带一个条目路径').toBe(2);
  });

  it('新契约零游戏名词（与 audit A 同尺，提前自查）', () => {
    const GAME_WORDS = /\b(eratw|eraK|eraSQN|eraNAS)\b|M_KOJO|個人口上|\bsav\b/i;
    for (const line of codeLines(text(CONTRACT))) {
      expect(line, '契约层不得出现游戏名词').not.toMatch(GAME_WORDS);
    }
  });

  it('契约不反向依赖插件（只依赖自身的纯工具模块）', () => {
    const imports = [...text(CONTRACT).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    expect(imports.filter((s) => s.startsWith('.')).every((s) => !s.includes('plugins'))).toBe(true);
    expect(imports).not.toContain('@kojo/kernel');
  });
});
