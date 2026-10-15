import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 分层守卫（C3 领域限定检索批）：全文检索这一层**逐行**不许出现游戏判据——
 * **连注释也算**（比 `pnpm audit:decoupling` 的 A 项更严：A 项跳过注释行，
 * 而"宿主注释里写着 `M_KOJO_K(\d+)` 的匹配思路"正是这批最容易走歪的那一步：
 * 注释是抄判据进宿主的第一站，代码往往跟着来）。
 *
 * 为什么要有这条而不是只靠审计：审计 A 项覆盖 `app/src/ui` 全目录但**只看代码行**，
 * 注释里的领域知识不会被拦；而本批的风险恰恰是"图省事在宿主里正则匹配文件名"。
 * 这个文件守的是**边界本身**，不是某一行实现——所以它比单元测试更该长存。
 *
 * 反向对照同样钉住：判据不是"哪里都没有"，而是**只准住在提供方**
 * （`packages/plugins/eratw-adapter/src/search-scope.ts` 必须认得 `kojoDir`）。
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** 宿主检索层（含桥）：这些文件必须对"角色/家族"一无所知 */
const HOST_FILES = [
  'packages/app/src/ui/search-scope.ts',
  'packages/app/src/ui/search-store.ts',
  'packages/app/src/ui/SearchPanel.tsx',
  'packages/app/src/ui/search-query.ts',
  'packages/app/src/bridge/search.ts',
];

/**
 * 领域词：具体游戏名 / 口上函数前缀 / 日文目录名 / 引擎存档扩展名（裸 `sav`），
 * 以及**契约字段名**——宿主拿到 `GameProject` 后去读 `charaIndex`/`kojoDir`
 * 就是在宿主里做归属判定（正确做法是把整份 project 交回提供方 `provide(project)`）。
 */
const DOMAIN_TOKENS = [
  /\beratw\b/i,
  /\beraK\b/i,
  /\beraSQN\b/i,
  /\beraNAS\b/i,
  /M_KOJO/,
  /個人口上/,
  /\bsav\b/i,
  /charaIndex/,
  /kojoDir/,
];

/** 提供方侧必须出现的判据（少一个就是判据被搬走或整条腿没接上） */
const PROVIDER_FILE = 'packages/plugins/eratw-adapter/src/search-scope.ts';
const PROVIDER_TOKENS = ['kojoDir', 'charaIndex'];

describe('检索范围的分层边界', () => {
  it.each(HOST_FILES)('宿主检索层零领域词（注释也查）：%s', (relPath) => {
    const lines = readFileSync(path.join(ROOT, relPath), 'utf8').split(/\r?\n/);
    const hits: string[] = [];
    lines.forEach((line, i) => {
      for (const re of DOMAIN_TOKENS) {
        if (re.test(line)) hits.push(`${relPath}:${i + 1} ${line.trim().slice(0, 80)}`);
      }
    });
    expect(hits).toEqual([]);
  });

  it('判据确实住在提供方，而不是"哪儿都不许有"', () => {
    const text = readFileSync(path.join(ROOT, PROVIDER_FILE), 'utf8');
    for (const token of PROVIDER_TOKENS) expect(text).toContain(token);
  });

  it('宿主拿到的是泛型事实（label/roots），契约里没有"角色"这个字', () => {
    const slot = readFileSync(path.join(ROOT, 'packages/plugin-api/src/slots.ts'), 'utf8');
    const block = slot.slice(slot.indexOf('export interface SearchScopeOption'));
    expect(block).not.toMatch(/chara|角色|家族/i);
  });
});
