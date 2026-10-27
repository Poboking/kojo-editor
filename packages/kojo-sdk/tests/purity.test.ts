/**
 * `@kojo/kojo-sdk` 的**作者面守卫**（B5a 的 DoD 判据之一）。
 *
 * 这个包存在的全部理由是"第三方语言包作者能不碰宿主就写出一门方言"。它一旦
 * `import monaco-editor`（哪怕 `import type`）、一旦依赖某个实现包、一旦认识某部游戏，
 * 那条路就断了——而且**没有任何一处会红**，直到真有人来写第三个包。故判据写在这里：
 * 不看运行时，只看源码。
 *
 * 四条：
 * 1. **零 Monaco / 零 React / 零 DOM / 零 IO**（含 `type` 导入）；
 * 2. **零游戏名词**（同 `audit:decoupling` 的 A 项口径）；
 * 3. **只依赖两枚**：`@kojo/kojo-core`（游戏侧契约）与 `@kojo/plugin-api`（编辑器侧契约）；
 * 4. **文件数钉死**（防走空匹配）。
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

/** 一条 import/export-from 语句里的模块 specifier（含 `import type` / 裸 import / re-export） */
const SPEC_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const BARE_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

function specifiersOf(src: string): string[] {
  return [
    ...[...src.matchAll(SPEC_RE)].map((m) => m[1] as string),
    ...[...src.matchAll(BARE_RE)].map((m) => m[1] as string),
  ];
}

describe('@kojo/kojo-sdk 是作者面契约（零 Monaco / 零 React / 零 IO / 零游戏名词）', () => {
  const files = sources();

  it('扫到的文件数与预期一致（防止走空匹配）', () => {
    // index（桶）· contracts（形状）· structure-protocol（协议 v4）· semantic-roles（角色表）
    expect(files).toHaveLength(4);
  });

  it('外部依赖只在两枚白名单里（core + plugin-api）', () => {
    /**
     * 为什么恰好这两枚：
     * - `@kojo/kojo-core`：游戏侧契约与语言事实（`GameAdapter` / 诊断 / 发射面 / 结构协议）的
     *   唯一真源；
     * - `@kojo/plugin-api`：编辑器侧契约（`ui.monaco.language` / `ui.editor.languageService`）
     *   的唯一真源。语言包作者写的**是插件**，所以这一枚必须是作者面的一部分。
     *
     * 排除项同样重要：`@kojo/kojo-lang` 是**实现库**，方向是 `kojo-lang → kojo-sdk`
     * （角色表住 SDK、实现读它）；SDK 反向依赖它就是把方向倒过来。
     */
    const allowed = new Set(['@kojo/kojo-core', '@kojo/plugin-api']);
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) continue;
        if (allowed.has(spec)) continue;
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
    const gameWords = /eratw|erafl|eraakumamaid|eratoho|口上|キャラ|CFLAG|TFLAG/i;
    const offenders = files.filter((file) => gameWords.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => path.basename(f))).toEqual([]);
  });
});
