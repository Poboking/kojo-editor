/**
 * `@kojo/plugin-kojo-lang` 的**纯插件守卫**（B2 的 DoD 判据）。
 *
 * 这个包与 `@kojo/kojo-lang` 的分工是"判据 / 供方"，但两者的**硬边界完全相同**：
 * 零 Monaco、零 React、零 IO、零游戏名词。理由不是洁癖，是这一条链的**可替换性**：
 *
 * - 插件一旦 `import 'monaco-editor'`，它就只能在宿主进程里跑，`@kojo/kojo-sdk`（B5）
 *   那条"第三方作者写的语言包也能装进编辑器"的路直接断掉；
 * - 插件一旦读盘 / 读 `project`，它就得跟着 adapter 演进改，而它本来只认识语言。
 *
 * 判据只看**依赖**（不看正文）：这些文件的注释里必然出现 Monaco / 契约名，那是解释，
 * 不是耦合。而 `import type` 在运行时被擦除、单测永远绿 —— 所以 specifier 扫描必须
 * 连 `type` 一起匹配。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(name)) out.push(abs);
    }
  };
  walk(SRC);
  return out.sort();
}

const SPEC_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const BARE_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

function specifiersOf(src: string): string[] {
  return [
    ...[...src.matchAll(SPEC_RE)].map((m) => m[1] as string),
    ...[...src.matchAll(BARE_RE)].map((m) => m[1] as string),
  ];
}

/** 允许的外部依赖（白名单，不写黑名单：新增一个包必须先想清楚它属不属于这一层） */
const ALLOWED_PACKAGES = new Set([
  '@kojo/plugin-api',
  '@kojo/kojo-lang',
  '@kojo/kojo-lang/constants',
  '@kojo/kojo-lang/definition',
  '@kojo/kojo-lang/symbols',
  '@kojo/kojo-lang/inlay',
  '@kojo/kojo-lang/adapter-source',
  // 只取**类型** `GameAdapter`（2.0 adapter 的形状住 core，与 plugin-api 的 v1 形状不同）。
  '@kojo/kojo-core',
]);

describe('@kojo/plugin-kojo-lang 是纯插件（零 Monaco / 零 React / 零 IO / 零游戏知识）', () => {
  const files = sources();

  it('扫到的文件数与预期一致（防止走空匹配）', () => {
    // request / definition / symbols / inlay / plugin / index
    expect(files).toHaveLength(6);
  });

  it('外部依赖只在白名单里（其余一律是本包内相对路径）', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) continue;
        if (ALLOWED_PACKAGES.has(spec)) continue;
        offenders.push(`${path.basename(file)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('零 monaco / 零 react / 零 DOM / 零 node IO', () => {
    const banned = /^(monaco-editor|react|react-dom|@tauri-apps\/.*|node:.*|fs|path|os|crypto)$/;
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (banned.test(spec)) offenders.push(`${path.basename(file)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('零游戏名词（同 audit:decoupling 的 A 项口径）', () => {
    // `口上` 除外：它是 kojo2 语言面自己的词（`.kojo2` 就是口上文件），不是某部游戏的名字。
    const gameWords = /eratw|erafl|eraakumamaid|eratoho|キャラ|CFLAG|TFLAG/i;
    const offenders = files.filter((file) => gameWords.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => path.basename(f))).toEqual([]);
  });
});
