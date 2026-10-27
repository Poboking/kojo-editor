import type * as Monaco from './entry';
import {
  ROLE,
  nameLayerRules,
  rulesFromRolePalette,
  type SemanticRole,
} from './semantic-roles';

/**
 * 主题规则的**叶子单一真源**（PS-10 断链批；LAU-2 起改成"角色调色板"）。
 *
 * ## 这一层现在只有一件事：给角色发色
 *
 * LAU-2 之前，本文件存的是三张按 token 名铺的规则表（v1 糖 / v1 语义类别 / 2.0 三套），
 * 于是"颜色"这件事在六个文件里各有一份（三份捕获表 + 三套 Monarch + 六份调色板）。
 * 现在收敛成：
 *
 * ```
 * 捕获/词法 → 角色（semantic-roles.ts） → 三张角色调色板（本文件）+ 三张新主题调色板（theme.ts）
 * ```
 *
 * 本文件持**三套主题（暗 / 亮 / 墨绿）的角色调色板**：每套 34 档角色各一枚色，外加名字层
 * 五条（`KOJO_SEMANTIC_*_THEME_RULES`，D6：名字层与语法角色正交，不进角色表）。
 * `theme.ts` 与 `kojo2-theme.ts` 都从这里取同一批对象本体，不各配一套色。
 *
 * ## 为什么仍住叶子（零依赖）
 *
 * `theme.ts` 在开机静态图里（`shell-overlays → diff-view → erb-language → theme`、
 * `QuickFixPreviewOverlay → theme` 两条链都经它），而旧的规则老家
 * （`kojo-language.ts` / `kojo-semantic-tokens.ts` / `kojo2-language.ts`）各自静态拖着
 * `@kojo/plugin-kojo-sugar` 那 ~900 KB 词表。本文件只引纯数据叶子 `semantic-roles.ts`
 * （零依赖、字形与角色名），于是糖包照旧整包留在开机静态图外。
 *
 * **身份不变量**（测试钉住）：本文件是这三张调色板与六张规则表的**唯一定义处**；
 * `kojo-language.ts` / `kojo-semantic-tokens.ts` / `kojo2-language.ts` 各自
 * `export ... from './kojo-theme-rules'` 原样 re-export（不复制、不接受第二份）。
 *
 * ## 取色口径（本批**一个色值都不许改**）
 *
 * 全部色值逐字取自 LAU-2 之前的实现（六套主题 × 48 条规则的快照见
 * `tests/fixtures/legacy-token-colors.json`），只是把"按 token 名"换成"按角色"。
 * 每套的语义族与逐档判据注释留在原处（`theme.ts` 各调色板表头 / 本文件的角色注）。
 * §4.2 的 18 档**定稿色卡**要人工评审，不在本批——那时的合并点就是
 * `semantic-roles.ts` 头注写的四对 `*.alt` 与同色档。
 */

/* ============================== 角色调色板（三套主题） ============================== */

/**
 * 暗色（`kojo-dark` / `kojo2-dark`）：深底可读 + 一族一色相。
 *
 * 语义族（与 LAU-2 之前逐字相同）：紫=关键字、青=运算符、蓝=函数/定义、绿=台词与字面、
 * 玫=代词、橙=数字/插值、黄=预处理与声明、粉=引擎指令、薄荷=名字层、暖灰=原生直通、
 * 橄榄=类型；2.0 侧的青/淡紫/黄/粉四档是它自己的色相（见 `semantic-roles.ts` 的 `.alt` 注）。
 */
export const SEMANTIC_ROLE_PALETTE_DARK: Readonly<Record<SemanticRole, string>> = Object.freeze({
  [ROLE.text]: 'abb2bf',
  [ROLE.comment]: '879098',
  [ROLE.keyword]: 'c678dd',
  [ROLE.keywordAlias]: '9687be',
  [ROLE.keywordAlt]: '8be9fd',
  [ROLE.directive]: 'e5c07b',
  [ROLE.engine]: 'ff7ab2',
  [ROLE.engineFamily]: '9d7bea',
  [ROLE.operator]: '7f9cc0',
  [ROLE.operatorWord]: '56b6c2',
  [ROLE.operatorAlt]: '56b6c2',
  [ROLE.number]: 'd19a66',
  [ROLE.numberAlt]: 'd6acff',
  [ROLE.string]: '98c379',
  [ROLE.escape]: 'd19a66',
  [ROLE.interp]: 'd19a66',
  [ROLE.interpDelimiter]: 'd19a66',
  [ROLE.interpAlt]: 'f9e2af',
  [ROLE.punctuation]: '7f9cc0',
  [ROLE.speech]: '98c379',
  [ROLE.speaker]: 'ffb86c',
  [ROLE.narration]: '5fa0f5',
  [ROLE.hint]: 'f38ba8',
  [ROLE.cont]: 'e5c07b',
  [ROLE.slot]: '5cc9a8',
  [ROLE.pronoun]: 'e06c75',
  [ROLE.variable]: 'e06c75',
  [ROLE.label]: '56b6c2',
  [ROLE.decl]: '61afef',
  [ROLE.declaration]: 'a582d7',
  [ROLE.call]: '61afce',
  [ROLE.type]: 'b3bd47',
  [ROLE.raw]: 'a8a290',
  [ROLE.anchor]: 'ff41b9',
});

/**
 * 亮色（`kojo-light`）：VS Code Light+ 气质，深蓝/橄榄绿/赭石/紫四族压浅底。
 *
 * 浅底可读区间窄（正文级 ≥ 4.5 把全部前景压进 L* 25–55），所以两门语言的同义档在这里
 * 已经自然并到同一枚色（`{@link SEMANTIC_ROLE_PALETTE_DARK}` 的六对分家在亮色档大多重合）。
 */
export const SEMANTIC_ROLE_PALETTE_LIGHT: Readonly<Record<SemanticRole, string>> = Object.freeze({
  [ROLE.text]: '24292f',
  [ROLE.comment]: '57606a',
  [ROLE.keyword]: '8250df',
  [ROLE.keywordAlias]: '6e6a86',
  [ROLE.keywordAlt]: '8250df',
  [ROLE.directive]: '953800',
  [ROLE.engine]: 'bf3989',
  [ROLE.engineFamily]: '8e44ad',
  [ROLE.operator]: '35526f',
  [ROLE.operatorWord]: '0a6b73',
  [ROLE.operatorAlt]: '35526f',
  [ROLE.number]: '953800',
  [ROLE.numberAlt]: '953800',
  [ROLE.string]: '116329',
  [ROLE.escape]: 'b35900',
  [ROLE.interp]: 'b35900',
  [ROLE.interpDelimiter]: 'b35900',
  [ROLE.interpAlt]: 'b35900',
  [ROLE.punctuation]: '335f96',
  [ROLE.speech]: '116329',
  [ROLE.speaker]: '8b4513',
  [ROLE.narration]: '0550ae',
  [ROLE.hint]: 'b4232e',
  [ROLE.cont]: '953800',
  [ROLE.slot]: '0e6b5c',
  [ROLE.pronoun]: 'b4232e',
  [ROLE.variable]: 'b4232e',
  [ROLE.label]: '0a6b73',
  [ROLE.decl]: '0550ae',
  [ROLE.declaration]: '512da8',
  [ROLE.call]: '0550ae',
  [ROLE.type]: '5f6b2a',
  [ROLE.raw]: '57606a',
  [ROLE.anchor]: 'bf3989',
});

/**
 * 墨绿（`kojo-mint-dark`）：与 `themes/mint-dark.css` 的 `#0f1713` 协调的冷薄荷族。
 *
 * 墨绿盘只有十余枚独立色，两两 ≥12 已到极限 ⇒ 两门语言的同义档在这里大面积重合
 * （同一类东西同色），不再"一档一色"。
 */
export const SEMANTIC_ROLE_PALETTE_MINT: Readonly<Record<SemanticRole, string>> = Object.freeze({
  [ROLE.text]: 'd9e9df',
  [ROLE.comment]: '8aa99a',
  [ROLE.keyword]: 'c9a7f5',
  [ROLE.keywordAlias]: '9a8fb8',
  [ROLE.keywordAlt]: 'c9a7f5',
  [ROLE.directive]: 'dca023',
  [ROLE.engine]: 'ff9ccf',
  [ROLE.engineFamily]: 'af8cff',
  [ROLE.operator]: '8fb3c9',
  [ROLE.operatorWord]: '74d6d0',
  [ROLE.operatorAlt]: '74d6d0',
  [ROLE.number]: 'f0b98a',
  [ROLE.numberAlt]: 'f0b98a',
  [ROLE.string]: '9ccf9a',
  [ROLE.escape]: 'f0b98a',
  [ROLE.interp]: 'f0b98a',
  [ROLE.interpDelimiter]: 'f0b98a',
  [ROLE.interpAlt]: 'f0b98a',
  [ROLE.punctuation]: '8fb3c9',
  [ROLE.speech]: '9ccf9a',
  [ROLE.speaker]: 'ff9ba3',
  [ROLE.narration]: 'd9e9df',
  [ROLE.hint]: '67dcc0',
  [ROLE.cont]: 'dca023',
  [ROLE.slot]: '67dcc0',
  [ROLE.pronoun]: 'ff9ba3',
  [ROLE.variable]: 'ff9ba3',
  [ROLE.label]: '74d6d0',
  [ROLE.decl]: '7cc7ff',
  [ROLE.declaration]: '7cc7ff',
  [ROLE.call]: '7cc7ff',
  [ROLE.type]: '96b458',
  [ROLE.raw]: 'ada18a',
  [ROLE.anchor]: 'ff9ccf',
});

/* ============================== 名字层（D6：不进角色表） ============================== */

/**
 * 名字层的三套调色板：`function` / `function.declaration` / `parameter` /
 * `variable.declaration` / `variable.declaration.readonly`。
 *
 * 取色一律**复用同族角色色**（蓝 = 函数、黄 = 声明、橙 = 参数位）——作者看到的应当是
 * "同一类东西同一个色"，而不是"新机制带来的第七种蓝"。与角色表的边界见
 * `semantic-roles.ts` 头注 D6 那一段。
 */
export const NAME_LAYER_PALETTE_DARK: Readonly<Record<string, string>> = Object.freeze({
  function: '61afef',
  'function.declaration': '61afef',
  parameter: 'd19a66',
  'variable.declaration': 'e5c07b',
  'variable.declaration.readonly': 'e5c07b',
});

export const NAME_LAYER_PALETTE_LIGHT: Readonly<Record<string, string>> = Object.freeze({
  function: '0550ae',
  'function.declaration': '0550ae',
  parameter: 'b35900',
  'variable.declaration': '953800',
  'variable.declaration.readonly': '953800',
});

export const NAME_LAYER_PALETTE_MINT: Readonly<Record<string, string>> = Object.freeze({
  function: '7cc7ff',
  'function.declaration': '7cc7ff',
  parameter: 'f0b98a',
  'variable.declaration': 'dca023',
  'variable.declaration.readonly': 'dca023',
});

/* ============================== 规则表（三套 × 两族） ============================== */

/** 暗色 34 条角色规则（`kojo-dark` / `kojo2-dark` 的 `rules` 主体） */
export const ROLE_THEME_RULES: readonly Monaco.editor.ITokenThemeRule[] = Object.freeze(
  rulesFromRolePalette(SEMANTIC_ROLE_PALETTE_DARK),
);

/** 亮色 34 条角色规则（`kojo-light` / `kojo2-light`） */
export const ROLE_LIGHT_THEME_RULES: readonly Monaco.editor.ITokenThemeRule[] = Object.freeze(
  rulesFromRolePalette(SEMANTIC_ROLE_PALETTE_LIGHT),
);

/** 墨绿 34 条角色规则（`kojo-mint-dark` / `kojo2-mint-dark`） */
export const ROLE_MINT_THEME_RULES: readonly Monaco.editor.ITokenThemeRule[] = Object.freeze(
  rulesFromRolePalette(SEMANTIC_ROLE_PALETTE_MINT),
);

/** 名字层五条（`kojo-dark` 的尾部；由 `kojo-semantic-tokens.ts` 按同对象 re-export） */
export const KOJO_SEMANTIC_THEME_RULES: readonly Monaco.editor.ITokenThemeRule[] = Object.freeze(
  nameLayerRules(NAME_LAYER_PALETTE_DARK),
);

/** 名字层五条（亮色侧） */
export const KOJO_SEMANTIC_LIGHT_THEME_RULES: readonly Monaco.editor.ITokenThemeRule[] = Object.freeze(
  nameLayerRules(NAME_LAYER_PALETTE_LIGHT),
);

/** 名字层五条（墨绿侧） */
export const KOJO_SEMANTIC_MINT_THEME_RULES: readonly Monaco.editor.ITokenThemeRule[] = Object.freeze(
  nameLayerRules(NAME_LAYER_PALETTE_MINT),
);
