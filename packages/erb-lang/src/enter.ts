/**
 * `.erb` 回车层级（ERB-ENTER-RULES，2026-10-21；2026-10-31 从宿主 `monaco/erb-enter.ts` 整块搬进本包）——
 * **词表零抄本**的一张派生表。
 *
 * ## 为什么住包不住宿主（与 kojo2 缩进判据 B3i 同族）
 *
 * 这三枚都是**纯判据**（零 Monaco / 零 React / 零 DOM / 零 IO / 零 model 取文）：只把引擎配对表
 * 投影成回车档位。判据留在宿主就只服务宿主；而"回车该多深"是语言事实，与谁把编辑落到屏上无关。
 * 宿主的 Monaco 装配与翻译（`toMonacoEnterConfig` / `mergeIndentConfig` / on-type 接线）仍然留在宿主，
 * 本文件只交词表派生与正则族装配的入参。
 *
 * ## 词形从哪来
 *
 * 只从引擎配对表来：`@kojo/erb-vocab/control-flow` 的 `ERB_CONTROL_STATEMENTS`（由开块 / 分支 /
 * 闭合 / 单行四张表 + TRY 三档 + PRINTDATA 系**派生**的并集）逐个过
 * `classifyControlFlow()` 取回**角色**，按角色分桶。配对表增删一词，本表自动跟随——
 * 与 `.erb` 高亮补集（`erb-highlight-words.ts` 吃同一份派生）同一条纪律。
 * 角色分桶之后交给 `@kojo/kojo-vocab/enter` 的 `enterRulePatternsFromRoles()`，与 `.kojo` 的
 * `sugarEnterRulePatterns()` **共用同一套正则装配**（ERB-PARITY 口径：能力不进语言名分支）。
 *
 * ## 分档判据（量自真实语料的排版习惯，不是照 JS 抄）
 *
 * 基线盘 `ERB/COMMON.ERB` 105-117 / 1059-1064 逐行读数：
 *
 * ```text
 * SELECTCASE RESULT        ← d 层
 *   CASE 0                 ← d+1（开块抬一级）
 *   CASE 1                 ← d+1（兄弟分支回到同层，不叠加）
 *     IF MONEY < ARG       ← d+2（分支抬一级）
 *       PRINTFORMW …       ← d+3
 *     ENDIF                ← d+2（闭合退回开块那一层）
 *   MONEY -= ARG           ← d+2（闭合之后与块体平级 ⇒ 回车不再退）
 * ENDSELECT               ← d 层
 * ```
 *
 * ⇒ 开块与分支都抬下一行；闭合与分支都收束回父层（分支两头都进，正是"兄弟同层、正文更深"
 * 这一形状的唯一表达）。回车落在闭合行之后**不**再退一级——屏上 `ENDIF` 下一行的正文
 * 与 `ENDIF` 同层，退一级会把正文拖到块外。
 *
 * ## 注释行
 *
 * 行注释 = `;`（本文件 `ERB_LINE_COMMENT` 是全仓**唯一一份**：宿主 `monaco/erb-language.ts` 的
 * `comments` 格与 `monaco/languages.ts` 的 descriptor `lineComment` 声明位都取它，两处不许各写各的）。
 * 派生成 `unIndentedLinePattern`：**注释行不参与缩进继承**——作者把分隔注释顶到列 0
 * （真语料常见写法，`COMMON.ERB` 1066 那种 `;-----` 画框）时，后面一行的回车仍回到
 * 最近一条**代码行**的层级，而不是被那枚列 0 的注释拖到列 0。块头行尾带的行内 `;` 说明
 * 也照常抬一级（判据锚在行首关键字，看不见注释反而是对的）。
 *
 * ## `@` 续行 / `@` 函数行
 *
 * `@NAME(…)` 定义行与语料里那种跨行 CALL 续行（`        @"…",ITEM:45,`）都不进任何档：
 * 前者是**函数边界**（`erb-parser/structure.ts` 的 `isFunctionBoundary`，块状态在这里归零、
 * 函数体顶格书写），后者是上一条语句的延续（`controlFlowToken` 取的是行首 `[A-Za-z_]+`
 * 一段，`@` 开头一段都取不到）。两形都保持"新行沿用本行行首空白"——续行的兄弟行本来就
 * 该与它对齐，这条**恰好**是 `@` 续行的正确行为，故只钉它不被派生的三档误伤。
 *
 * ## 已知不做（判据拿不到就不猜，与配对表的精度纪律同调）
 *
 * - `[SKIPSTART] … [SKIPEND]` 里的死代码：`indentationRules` 是无状态的正则，看不见屏蔽区，
 *   块内以 `IF` 开头的行照常抬一级（高亮层有 `skip` 态、缩进层没有对应配置格）；
 * - 跨行 CALL 的参数续行不自动抬一级：`indentNextLinePattern` 语义是"只抬下一行"，
 *   连续参数行会逐行叠加 ⇒ 兄弟参数行错位，宁可不抬（现状 keep 与语料同形）；
 * - ERB 的 `SIF` 单行条件抬下一行（配对表的 leaf 档 ⇒ `indentNextLinePattern`），
 *   但**不**认关键字缩写（`I` / `SIF` 之外的 `IF` 简写），配对表头注早已声明
 *   该已知边界，缩进层不越权补齐。
 */
import { classifyControlFlow, ERB_CONTROL_STATEMENTS } from '@kojo/erb-vocab/control-flow';
import { enterRulePatternsFromRoles, type EnterRoleVocabulary, type EnterRulePatterns } from '@kojo/kojo-vocab/enter';

/**
 * ERB 的行注释记号（**唯一一份**：宿主 `comments` 格、descriptor 的 `lineComment` 声明位与这里的
 * `unIndentedLinePattern` 都取它，各处不许各写各的）。
 */
export const ERB_LINE_COMMENT = ';';

/**
 * 配对表 → 角色词表（纯派生：一词一档，档位由 `classifyControlFlow` 说）。
 * 词形顺序取 `ERB_CONTROL_STATEMENTS` 自身的确定性排序（码元序），装配层再按长度降序排。
 */
export function erbEnterVocabulary(): EnterRoleVocabulary {
  const open: string[] = [];
  const branch: string[] = [];
  const close: string[] = [];
  const indentNextLine: string[] = [];
  for (const word of ERB_CONTROL_STATEMENTS) {
    switch (classifyControlFlow(word)?.role) {
      case 'open':
        open.push(word);
        break;
      case 'branch':
        branch.push(word);
        break;
      case 'close':
        close.push(word);
        break;
      case 'leaf':
        indentNextLine.push(word);
        break;
      default:
        break; // 配对表加了一档而这里没接：由 tests/erb-enter.test.ts 的"逐词有档"断言当场拦下
    }
  }
  return {
    open,
    branch,
    close,
    indentNextLine,
    lineComment: ERB_LINE_COMMENT,
    // Emuera 关键字大小写不敏感（与 Monarch 的 `ignoreCase: true` 同一条引擎事实）
    caseInsensitive: true,
  };
}

/** `.erb` 的回车规则族（与 `.kojo` 的 `sugarEnterRulePatterns()` 同形、同装配） */
export function erbEnterRulePatterns(): EnterRulePatterns {
  return enterRulePatternsFromRoles(erbEnterVocabulary());
}
