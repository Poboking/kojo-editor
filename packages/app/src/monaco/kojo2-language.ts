/**
 * Kojo 2.0 的**语言认领**（U6 / LAU-3b-FLIP）——**SDK B4 起这里没有语言面正文**。
 *
 * ## 这一层只剩两件事
 *
 * 1. **认领语言**：`monaco.languages.register({ id, extensions, aliases })`——扩展名与 id 是
 *    宿主的 descriptor 事实（`.kojo` / `.kojo2` 归 2.0 是 LAU-3b-FLIP 的产品决定，不是词法）；
 * 2. **把供方交出的语言面落进 Monaco**：调 {@link applyMonacoLanguageSurface}，数据来自槽
 *    `ui.monaco.language`（供方 = `@kojo/plugin-kojo-lang`，本体在 `@kojo/kojo-lang`）。
 *
 * 词法状态机、成对记号、回车层级、三套主题规则**都不在本文件**：
 *
 * | 想知道什么 | 去哪儿 |
 * | --- | --- |
 * | 2.0 词表（声明词 / 调度词 / 保留词 / 运算符 / `@原生` 围栏词） | `@kojo/kojo-lang/lexicon` |
 * | Monarch 状态机与 token 分档 | `@kojo/kojo-lang/monarch` |
 * | 成对记号 / 注释符 / 回车与缩进阶梯 | `@kojo/kojo-lang/language-config` |
 * | 三套 `kojo2-*` 主题的身份与角色规则 | `@kojo/kojo-lang/monaco-theme` |
 * | 语义角色表与三侧角色调色板 | `@kojo/kojo-lang/semantic-roles`、`.../theme-rules` |
 * | 数据怎么变成 `setMonarchTokensProvider` 的入参 | 宿主 `monaco-language-surface.ts` |
 *
 * ## 为什么还留着这些 re-export
 *
 * 既有 import 点（`kojo2-indent.ts` / `kojo2-semantic.ts` / `languages.ts` / 十来份测试）读的是
 * **同一枚对象**，指针不是第二份判据——判据只有一份，这几行只是把它接到老地址。
 * B5 把消费方逐处指到包路径之后，本文件只剩认领那一段。
 *
 * ## 插件没激活会怎样（契约头注写死的那一种，不是"宿主兜一份"）
 *
 * 语言仍被认领：文件能打开、语言 id 正确、状态栏与命令面板照旧；但没有语法着色、没有成对
 * 记号、没有缩进规则，且 `console.warn` 一条说清楚（{@link applyMonacoLanguageSurface}）。
 * 宿主**不**留一份内置 Monarch 当兜底——留了就等于回到"判据有两份"，而那正是 B4 要消掉的东西。
 *
 * ## `@原生` 注入声明为什么还住这儿
 *
 * {@link KOJO2_INJECTIONS} 是**结构层**（tree-sitter 子树叠层）的接线，不是词法面：它要的是
 * 宿主节点名与 `language-registry` 里那枚 ERB descriptor，两者都不属于"一门语言的颜色与形状"。
 * 语言面契约（B4）与结构面契约（B3 余项）是两条线，别把它们并成一张表。
 */

import type * as Monaco from './entry';
import { KOJO2_LANGUAGE_ID, KOJO2_SOURCE_EXTENSION } from '@kojo/kojo-lang/constants';
import { KOJO_SOURCE_EXTENSION, kojoMonacoExtensions } from '@kojo/plugin-api';
import { applyMonacoLanguageSurface } from './monaco-language-surface';
import type { InjectionSpec } from './tree-sitter/structure-runtime';

/**
 * 语言 id 与源扩展名：定义在零 import 叶子 `@kojo/kojo-lang/constants`（K2-CUTOVER-THEME）。
 *
 * 路由层（`ui/kojo2-cutover.ts`）与 model 重挂层只需要这两枚字符串，不该被本文件的任何
 * 依赖拖住；这里按**同一枚对象**转交，不复制第二份。
 */
export { KOJO2_LANGUAGE_ID, KOJO2_SOURCE_EXTENSION };

/* ============================== 语言面正文的现住址（指针，不是副本） ============================== */

export { KOJO2_MONARCH, KOJO2_TOKEN, KOJO2_TOKEN_TIERS } from '@kojo/kojo-lang/monarch';
export type { Kojo2TokenName, Kojo2TokenTier } from '@kojo/kojo-lang/monarch';
export { KOJO2_PAIRS } from '@kojo/kojo-lang/language-config';
export { KOJO2_BLOCK_HEADER_COLON_RE, KOJO2_INDENT_UNIT } from '@kojo/kojo-lang/language-config';

/* ============================== 注入声明（LAU-6） ============================== */

/**
 * Kojo 2.0 的 `@原生` 注入声明（LAU-6 / 设计稿 §4.6 D14）——**宿主节点名只出现在这一处**
 * （下面那一行数据；宿主代码与其它模块零命中，由 `kojo2-injection.test.ts` 的 grep 闸钉住）。
 *
 * - `hostNode`：`grammar.v2.js` 里 `@原生` **体**的真实节点名（栏头与体内逐行是另外两枚节点，
 *   别拿它们当宿主：整块不透明的是"体"）；
 * - `languageId: 'erb'`：`@原生` 体是底层 ERB（spec §8.5），子 parse 发给 ERB 的结构 worker
 *   （`language-registry` 里那枚 descriptor 的 `structure`），带 `includedRanges`；
 * - 置空这一格 = 回到"整块不透明"（本批的回滚点）。
 *
 * 为什么住在这里而不是 `LanguageDescriptor`：本车道边界不动 `language-registry.ts` /
 * `languages.ts`（两条都在别的批次手上）。这里只属"结构面"，与词法面无关：
 * Monarch / 配置 / 主题规则的判据全在 `@kojo/kojo-lang`。
 */
export const KOJO2_INJECTIONS: readonly InjectionSpec[] = Object.freeze([
  { hostNode: 'native_body', languageId: 'erb' },
]);

/* ============================== 认领 ============================== */

/**
 * 认领 `kojo2` 语言并把它的语言面落进 Monaco。
 *
 * **2026-10-27（LAU-3b-FLIP）起 `.kojo` 也归这一门**（用户口径：`.kojo` 当场让给 2.0），
 * 与 `.kojo2`（旧名兼容）并列登记；v1 只剩 `.kojo1`，两边不重叠。
 *
 * 幂等：同一 Monaco 实例重复调用只登记一次（与 v1 `registerKojoLanguage` 同形）；语言面那一半
 * 另有 (实例, 语言, 副) 台账，晚激活的供方由组合根的 `applyAllMonacoLanguageSurfaces` 补。
 */
export function registerKojo2Language(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((language) => language.id === KOJO2_LANGUAGE_ID)) {
    return;
  }
  monaco.languages.register({
    id: KOJO2_LANGUAGE_ID,
    extensions: kojoMonacoExtensions([KOJO_SOURCE_EXTENSION, KOJO2_SOURCE_EXTENSION]),
    aliases: ['kojo2'],
  });
  // 认领即声明"这门语言要有语言面"：供方没到就按契约的退化办事（warn 一条，不兜一份判据）。
  applyMonacoLanguageSurface(monaco, KOJO2_LANGUAGE_ID, { absentIsVisible: true });
}
