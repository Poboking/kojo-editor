/**
 * `@kojo/erb-lang` 的**纯库守卫**（LAU-4 第一步的 DoD 判据之一）。
 *
 * 这个包存在的全部理由就是"编辑器要知道的 ERB 判据能脱离宿主被复用"（供方是插件、
 * 将来是 SDK 作者的第三方语言包）。一旦有人在这里 `import type * as Monaco`（哪怕只是
 * type import，打包器擦掉、单测照样绿），它立刻退化成"只能被宿主用"，而**没有任何一处
 * 会红**。故判据写在这里，不看运行时，只看源码。
 *
 * 四条：
 * 1. **外部依赖只在白名单里**：只有 `@kojo/erb-vocab/control-flow`（ERB 控制流配对表的单一真源）。
 *    方向是"语言面库读引擎配对表"，与宿主 `monaco/erb-enter.ts` 读同一张表是同一条路；
 *    **不许**再指向插件 `@kojo/plugin-erb-parser`（库包引插件包＝分层倒置，2026-10-30 已清）。
 * 2. **零 Monaco / React / DOM / IO**（含 `type` 导入——理由同 kojo-lang 那条）；
 * 3. **零游戏名词**：包是语言面，不认识任何一部具体游戏；
 * 4. **文件数白名单**：加一枚源码文件必须显式改这里（防止"顺手多一个判据副本"）。
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

describe('@kojo/erb-lang 是纯库（零 Monaco / 零 React / 零 IO）', () => {
  const files = sources();

  it('扫到的文件数与预期一致（防止走空匹配）', () => {
    // constants（语言 id 叶子）/ completion-bits（位槽扫描件）/ completion-context（补全位置门九态）/
    // completion-variables（变量引用名字位）/ highlight（同符号高亮判据）/ selection-range（扩选判据）/ index
    expect(files).toHaveLength(7);
  });

  it('外部依赖只在白名单里（其余一律是本包内相对路径）', () => {
    /**
     * 白名单只有一枚：`@kojo/erb-vocab/control-flow`。
     *
     * 它提供 `ERB_CONTROL_STATEMENTS` / `classifyControlFlow`——ERB 控制流配对表的
     * **单一真源**（逐条对齐引擎 `FunctionIdentifier.cs` 的 `funcMatch`）。高亮与扩选都要
     * 问"这词是哪一档"，而在本包抄一份表就必然与它漂移（漂移的表现是"高亮指错的块"）。
     * 宿主读的是同一张表（`monaco/erb-enter.ts`，经插件 re-export），所以这是**并列读者**
     * 不是反向分层。
     *
     * 反向断言（2026-10-30 ERB-VOCAB 批）：`@kojo/plugin-erb-parser` 曾经是这张白名单的
     * 唯一成员——库包引插件包就是分层倒置。表上提到非插件库包后，插件那条 specifier 必须
     * **重新变成违规**，否则倒置会以"没人拦"的形态回来。
     */
    const allowed = new Set([
      // ERB 控制流配对表的单一真源（见上注）
      '@kojo/erb-vocab/control-flow',
      // 2026-10-30（LAU-4 续）：补全位置门搬进本包后，它读的三样东西都是**非插件库包**的叶子：
      // 空白类单源（与糖层 lexer 同口径）、ERB 名字字符集、引擎变量族白名单（降糖器认得的那张表）。
      // 三者都是"跨语言共享的语言事实"，与"库包引插件包"不是一回事——`@kojo/plugin-*` 仍在
      // 下面的 `forbidden` 里。
      '@kojo/kojo-lang/completion',
      '@kojo/kojo-lang/name-chars',
      '@kojo/kojo-vocab/engine',
    ]);
    const forbidden = new Set(['@kojo/plugin-erb-parser']);
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) continue;
        if (allowed.has(spec)) continue;
        offenders.push(`${path.basename(file)} → ${spec}`);
        if (forbidden.has(spec)) offenders.push(`${path.basename(file)} → 插件包倒置`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('零 monaco / 零 react / 零 DOM / 零 node IO', () => {
    const banned = /^(monaco-editor|react|react-dom|@tauri-apps\/.*|node:.*|fs|path|os|crypto)$/;
    const offenders: string[] = [];
    for (const file of files) {
      // 判据是**依赖**，不是正文：注释里出现 monaco 是应该的（每个文件都要解释
      // "为什么翻译层不在这里"）。而 `import type * as Monaco` 在运行时被擦除、
      // 单测永远绿，所以 SPEC_RE 必须连 `type` 一起匹配。
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (banned.test(spec)) offenders.push(`${path.basename(file)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('零游戏名词（同 audit:decoupling 的 A 项口径）', () => {
    const gameWords = /eratw|erafl|eraakumamaid|eratoho|キャラ|CFLAG|TFLAG/i;
    const offenders = files.filter((file) => gameWords.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => path.basename(f))).toEqual([]);
  });
});
