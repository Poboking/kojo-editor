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
  // B3a：展开体落点要"那一次编译的成品"，登记表已搬进语言面库。
  '@kojo/kojo-lang/expand-compile',
  '@kojo/kojo-lang/expand-view',
  // B3 收口最后一格：文档级诊断的判据叶子与"一次编译两处消费"的成品交接。
  '@kojo/kojo-lang/diagnostics',
  '@kojo/kojo-lang/diagnostic-result',
  // B3c：补全 / 悬停供方——候选组装 / 块级 snippets / 悬停正文与 Markdown 措辞都在包里
  // （`event-sites` 那枚判据由 `hover.ts` 包内自用，插件这一侧不直接 import）。
  '@kojo/kojo-lang/completion',
  '@kojo/kojo-lang/completion-snippets',
  '@kojo/kojo-lang/hover',
  // B3d：签名帮助 / 格式化的判据叶子（供方在 `src/signature.ts` / `src/format.ts`）。
  '@kojo/kojo-lang/signature',
  '@kojo/kojo-lang/format',
  // B3e：引用 / 改名的判据叶子（供方在 `src/references.ts` / `src/rename.ts`）。
  '@kojo/kojo-lang/references',
  '@kojo/kojo-lang/rename',
  // B3f：同符号高亮 / 结构化扩选的判据叶子（供方在 `src/highlight.ts` /
  // `src/selection-range.ts`）。
  '@kojo/kojo-lang/highlight',
  '@kojo/kojo-lang/selection-range',
  // B3g：行上注解的判据叶子（供方在 `src/codelens.ts`；计数复用包内 references）。
  '@kojo/kojo-lang/codelens',
  // B3h：折叠区间的判据叶子（供方在 `src/folding.ts`；宿主预取的快照在请求里）。
  '@kojo/kojo-lang/folding',
  // B3j：一键迁移 code action 的判据叶子（供方在 `src/code-actions.ts`）。
  '@kojo/kojo-lang/code-actions',
  // B3 语义收口：结构捕获 → 语义 token 区间的判据叶子（供方在 `src/semantic.ts`；
  // 捕获快照由宿主预取后随请求递进来，供方不碰 wasm、不碰 Monaco）。
  '@kojo/kojo-lang/semantic',
  // B4：语言面供方交数据（词法 / 语言配置 / 主题声明）。三枚都是**纯数据叶子**，
  // 引它们不会把 Monaco 带进插件——契约类型才是这一层的形状来源。
  '@kojo/kojo-lang/monarch',
  '@kojo/kojo-lang/language-config',
  '@kojo/kojo-lang/monaco-theme',
  // 只取**类型** `GameAdapter`（2.0 adapter 的形状住 core，与 plugin-api 的 v1 形状不同），
  // 以及 `KojoSpan`（展开落点的区间形状，同样是 core 的形状，不在这里另立一份）。
  '@kojo/kojo-core',
]);

describe('@kojo/plugin-kojo-lang 是纯插件（零 Monaco / 零 React / 零 IO / 零游戏知识）', () => {
  const files = sources();

  it('扫到的文件数与预期一致（防止走空匹配）', () => {
    // request / completion / definition / hover / symbols / inlay / monaco-language / plugin / index
    // + B3d：signature（签名帮助供方）/ format（整篇 + 区间格式化供方）
    // + B3e：references（引用供方）/ rename（改名供方）
    // + B3f：highlight（同符号高亮供方）/ selection-range（结构化扩选供方）
    // + B3g：codelens（行上注解供方）
    // + B3h：folding（折叠区间供方——结构快照 → 契约区间）
    // + B3j：code-actions（一键迁移供方，槽 `ui.editor.codeAction`）
    // + B3 语义收口：semantic（语义着色供方，槽 `ui.editor.languageService` 的
    //   `semanticToken`——捕获快照随请求递进来，这里只做裁与答）
    // + B3 收口最后一格：diagnostics（文档级诊断供方，槽 `ui.editor.decorator`）
    // + G4：workspace-symbols（`Ctrl+T` 供方——项目文件快照随请求递进来，本层只筛与答）
    expect(files).toHaveLength(21);
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
