/**
 * `@kojo/kojo-lang` 的**纯库守卫**（B1 的 DoD 判据之一：包内零 monaco / 零 react）。
 *
 * 为什么这条测试比代码本身重要：这个包存在的全部理由就是"编辑器要知道的判据"能脱离宿主
 * 被复用。一旦有人在这里 `import type * as Monaco`（哪怕只是 type import，打包器擦掉、
 * 单测照样绿），它立刻退化成"只能被宿主用"，而**没有任何一处会红**——直到真的要把它
 * 交给插件的那天。故判据写在这里，不看运行时，只看源码。
 *
 * 三条：
 * 1. **零运行时依赖**：外部只许 `@kojo/kojo-core`（词表真源）与
 *    `@kojo/kojo-vocab/keywords`（中文运算符表，B4 随 Monarch 进来，理由见下面那条用例）；
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
    // + B4 的 2.0 语言面本体：词表 / Monarch 状态机 / 语言配置 / 三套主题装配
    // − B5a：语义角色表**搬去 `@kojo/kojo-sdk/semantic-roles`**（架构 §7「角色表住 SDK」），
    //   本包不再持有那一枚；角色调色板（theme-rules）留在这里——它是**装配数据**不是契约。
    // + B3c 车道 2（2026-10-28）：2.0 **补全 / 悬停的判据**整块从宿主 `monaco/kojo2-*.ts` 搬进来
    //   四枚——`completion`（含 v1 侧也共用的空白族）/ `completion-snippets` / `hover`（含两段
    //   Markdown 措辞）/ `event-sites`。理由与 `definition` 那条一模一样：B3c 起这两条腿的**供方
    //   是插件** `@kojo/plugin-kojo-lang`，插件看不见 `packages/app/src/**`，判据留在宿主就等于
    //   逼插件（以及引用面 / 方言 lint 这两枚非 Monaco 消费者）各抄一份。搬进来没带来任何新的
    //   外部依赖：四枚只值引 `@kojo/kojo-core`（下面白名单那格当场验），其余全走同包相对路径。
    // + B3d（2026-10-28）：同样理由再进两枚——`signature`（调用位 / 声明头 / `@巡` 集合签名）与
    //   `format`（整篇 + 区间格式化规则）。这两条腿的原生 provider 在 B3d 批删干净，供方同样是
    //   插件；包内只引 `@kojo/kojo-core` + 同包相对路径（`format` 的全角冒号正则从同包
    //   `language-config` 取，**不再**经宿主那枚 `kojo2-enter` 指针壳转一手——那枚壳同批删了）。
    // + B3e（2026-10-29）：引用 / 改名的判据再进两枚——`references`（同文件 + 跨文件合并 /
    //   500 引用上限 / 项目文件快照口）与 `rename`（prepare / 三道闸 / 64 文件·2000 编辑上限 /
    //   快照 resolver）。同样只引 `@kojo/kojo-core` + 同包相对路径（`isNameChar` 走同包
    //   `name-chars`，错误文案自持一行，不引 `@kojo/plugin-api`）。
    expect(files).toHaveLength(25);
  });

  it('外部依赖只在白名单里（其余一律是本包内相对路径）', () => {
    const offenders: string[] = [];
    /**
     * 依赖白名单（B4 从"只有 core"扩到两枚，理由逐条写在册，不是放宽判据）：
     * - `@kojo/kojo-core`：2.0 词表与缩进宽度的唯一真源（B1 起就是这条）；
     * - `@kojo/kojo-vocab/keywords`：**中文运算符表**（`等于` / `不在` …）。2.0 规范 §5.1
     *   明写"沿用现有中文表"，那张表的法定真源就在 vocab（LAU-3b 解耦批把它从
     *   `@kojo/plugin-kojo-sugar` 搬进非插件包）。B4 把 Monarch 搬进本包 ⇒ 词表出口必须
     *   跟着进来；PLAN §4「B1 刻意没搬的三块」记的正是这条——**正解是让 core 自持该表**，
     *   那是单独一批（搬完就把这一行删掉）。vocab 是**库不是插件**，所以这条边不是反向分层。
     * - `@kojo/kojo-sdk/semantic-roles`（B5a）：语义角色表搬去 SDK 之后，本包（theme-rules /
     *   monarch / monaco-theme / 桶）读的是**同一枚对象**。方向是 `kojo-lang → kojo-sdk`，
     *   SDK 只依赖 core + plugin-api ⇒ 无环（由本测试的「白名单」与 SDK 的 purity 两处合钉）。
     */
    const allowed = new Set([
      '@kojo/kojo-core',
      '@kojo/kojo-vocab/keywords',
      '@kojo/kojo-sdk/semantic-roles',
    ]);
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
