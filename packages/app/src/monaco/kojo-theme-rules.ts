import type * as Monaco from './entry';

/**
 * Monarch token → 主题规则数组的**叶子单一真源**（PS-10 断链批）。
 *
 * 为什么值得单开一层：`theme.ts` 在开机静态图里（`shell-overlays → diff-view →
 * erb-language → theme` 与 QuickFixPreviewOverlay → theme 两条链都经它），而两张规则
 * 数组的**老家**各自拖着一条重链——
 * - `kojo-language.ts` 静态 import `@kojo/plugin-kojo-sugar`（词表单一真源，~900 KB）；
 * - `kojo-semantic-tokens.ts` → `register-dialects` → `kojo-language.ts`。
 *
 * 两张数组本身却是**零依赖的纯字面数据**（糖/语义 token 的前景色，写死不动）。
 * 把它们下沉到本叶子后，`theme.ts` 的静态足迹只剩这一个零 import 模块——
 * `@kojo/plugin-kojo-sugar` 于是整包离开开机静态图（改由 shell-overlays 的
 * 动态 import 在装载 diff view 时进入）。
 *
 * ## 身份不变量（测试钉住，别破坏）
 * 本文件是**唯一定义处**；`kojo-language.ts` / `kojo-semantic-tokens.ts` 各自
 * `export ... from './kojo-theme-rules'` 原样 re-export（不复制、不接受第二份）
 * ——既有 import 点（`monaco-theme.test.ts` / `kojo-token-tiers.test.ts` 的
 * 同对象引用断言、theme.ts 的暗色原样并入）读到的仍是**同一个数组本体**。
 *
 * 取色口径与档位判据不变（见两个 re-export 点的头注与
 * `kojo-token-tiers.test.ts`）；本文件只搬家，不改一个色值。
 */

/**
 * `kojo-dark` 里糖专属 token 的着色规则（由 `erb-language.ts` 合并进主题定义）。
 *
 * 取色口径（**深底可读 + 一档一色**，判据复跑见 `kojo-token-tiers.test.ts`）：
 * - 已中文化的糖层走冷色族（紫=关键字、青=运算符、蓝=函数、绿=台词、玫=代词）；
 * - 还没中文化的原生层走"外来族"（粉=引擎指令、蓝紫=族头、灰=整行原生直通），
 *   名字层（CJK 非词表 = 槽位原名 / 作者自定名）走薄荷绿；
 * - 亮度全部 ≥ 4.46:1（既有档位里最弱的一档），不为了分层引入刺眼的高饱和。
 */
export const KOJO_SUGAR_THEME_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: 'sugar.keyword', foreground: 'c678dd' },
  { token: 'sugar.keyword.alias', foreground: '8b7bb8' },
  { token: 'sugar.system-function', foreground: '61afce' },
  { token: 'sugar.operator', foreground: '56b6c2' },
  { token: 'sugar.cont', foreground: 'e5c07b', fontStyle: 'bold' },
  { token: 'sugar.pronoun', foreground: 'e06c75' },
  { token: 'sugar.speech', foreground: '98c379' },
  { token: 'sugar.speech.delimiter', foreground: '7f9cc0' },
  { token: 'sugar.interp', foreground: 'd19a66' },
  { token: 'sugar.interp.delimiter', foreground: 'd19a66', fontStyle: 'bold' },
  { token: 'sugar.colon', foreground: '7f9cc0' },
  { token: 'sugar.slot', foreground: '5cc9a8' },
  { token: 'keyword.raw', foreground: '9aa0a6' },
  { token: 'keyword.erb', foreground: 'ff7ab2' },
  { token: 'keyword.erb.family', foreground: '9d7bea' },
];

/**
 * `kojo-dark` 里语义类别的主题规则。
 *
 * token 名就是 `type.modifier…` 那条点分串（standalone 主题服务原文这么匹配），
 * 所以 `function.declaration` 比 `function` 更具体 = 定义点与调用点两种色。
 * 取色一律**复用既有词法色**（蓝 = 函数、黄 = 声明、橙 = 数/参数位），不引入新配色：
 * 作者看到的应当是"同一类东西同一个色"，而不是"新机制带来第七种蓝"。
 */
export const KOJO_SEMANTIC_THEME_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: 'function', foreground: '61afef' },
  { token: 'function.declaration', foreground: '61afef', fontStyle: 'bold' },
  { token: 'parameter', foreground: 'd19a66' },
  { token: 'variable.declaration', foreground: 'e5c07b' },
  { token: 'variable.declaration.readonly', foreground: 'e5c07b', fontStyle: 'italic' },
];
