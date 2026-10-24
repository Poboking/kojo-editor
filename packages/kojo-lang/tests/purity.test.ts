/**
 * `@kojo/kojo-lang` 的**纯库守卫**（B1 的 DoD 判据之一：包内零 monaco / 零 react）。
 *
 * 为什么这条测试比代码本身重要：这个包存在的全部理由就是"编辑器要知道的判据"能脱离宿主
 * 被复用。一旦有人在这里 `import type * as Monaco`（哪怕只是 type import，打包器擦掉、
 * 单测照样绿），它立刻退化成"只能被宿主用"，而**没有任何一处会红**——直到真的要把它
 * 交给插件的那天。故判据写在这里，不看运行时，只看源码。
 *
 * 三条：
 * 1. **零运行时依赖**，只许 `@kojo/kojo-core`；
 * 2. **零 Monaco / React / DOM / IO**（含 `type` 导入——契约层的理由同此）；
 * 3. **零游戏名词**：包是语言面，不认识 era / kojo 之外的任何一部游戏。
 *    这一条与 `audit:decoupling` 的 A 项同口径，但那边不扫 `packages/kojo-lang`（它只扫
 *    内核 / 契约 / 宿主），所以这里自己钉。
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

describe('@kojo/kojo-lang 是纯库（零 Monaco / 零 React / 零 IO）', () => {
  const files = sources();

  it('扫到的文件数与预期一致（防止走空匹配）', () => {
    // constants / name-chars / interpolation / declarations / sourcemap / expand-view /
    // symbols / definition / inlay / adapter-source / expand-compile / index
    //（B2 加 interpolation + definition，B2c 加 inlay + adapter-source，B3a 加 expand-compile）
    expect(files).toHaveLength(12);
  });

  it('只依赖 @kojo/kojo-core，其余一律是本包内相对路径', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) continue;
        if (spec === '@kojo/kojo-core') continue;
        offenders.push(`${path.basename(file)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('零 monaco / 零 react / 零 DOM / 零 node IO', () => {
    const banned = /^(monaco-editor|react|react-dom|@tauri-apps\/.*|node:.*|fs|path|os|crypto)$/;
    const offenders: string[] = [];
    for (const file of files) {
      // 判据是**依赖**，不是正文：注释里出现 monaco 是应该的（本包几乎每个文件都要解释
      // "为什么翻译层不在这里"）。而 `import type * as Monaco from 'monaco-editor'` 这种
      // type import 在运行时被擦除、单测永远绿，所以 SPEC_RE 必须连 `type` 一起匹配。
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (banned.test(spec)) offenders.push(`${path.basename(file)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('零游戏名词（同 audit:decoupling 的 A 项口径）', () => {
    const gameWords = /eratw|erafl|eraTW|eraFL|eraTW|eraakumamaid|eratoho|口上|キャラ|CFLAG|TFLAG/i;
    const offenders = files.filter((file) => gameWords.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => path.basename(f))).toEqual([]);
  });
});
