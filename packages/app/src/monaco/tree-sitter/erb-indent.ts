import { erbEnterRulePatterns } from '../erb-enter';
import { mergeIndentConfig, type BaseIndentPatterns, type MergedIndentConfig } from './indent';
import type { KojoStructureIndentRules } from './types';

/**
 * ERB 结构缩进的**基底与合并点**（`StructureLanguageRuntime.baseIndentPatterns` 的来源）。
 *
 * ## 基底不另造：直接接 `erb-enter.ts` 的既有层级
 *
 * ERB 的回车层级（ERB-ENTER-RULES）已经有一条**零手抄**的派生链：
 * `scanner.ts` 的配对表 → `classifyControlFlow()` 角色 → `enterRulePatternsFromRoles()` →
 * `onEnterRules` / `indentationRules`。结构层这一批只做加法，所以基底**逐条引用**那条链的
 * 产物（`erbEnterRulePatterns()`），一条都不重写：
 *
 * - `indentOnEnter` / `increaseIndentPattern` / `decreaseIndentPattern` —— 与
 *   `registerErbLanguage()` 注册进 Monaco 的那三格原文相同（同一条派生，不是第二份）；
 * - `indentNextLinePattern`（`SIF` 只抬下一行）/ `unIndentedLinePattern`（注释行不参与继承）
 *   —— 这两格是可选的 additive 两格（见 `indent.ts`）。Monaco 的 `indentationRules` 是
 *   **整对象替换**：结构层合并时必须原样带出，否则一开结构缩进就把 `SIF` 与注释的既有手感
 *   撤掉了（那是"加法"的反面）。
 *
 * ## 结构层补什么
 *
 * worker 的 `queries/indents.scm` 按块角色给 `@indent.begin/end/enter`；引擎把它们翻成
 * 关键字行首锚（`erb-indent-patterns.ts`），这里再与基底**合并**（`mergeIndentConfig`）：
 * 基底规则一条不少，结构规则加在后面；逐字相同的规则不重复添，空规则 ⇒ 返回 null
 * （"结构层没话说"与"这条线没接"是同一份行为）。
 *
 * 判据只在这里出现一次：宿主装配点（`providers.ts::syncIndentConfig`）拿
 * `runtime.baseIndentPatterns()` 与本文件同源的合并函数，不另写一份 ERB 专属分支。
 */

/**
 * ERB 的缩进基底（三格必有 + 两格按需）。
 *
 * **每次调用新建**（`erbEnterRulePatterns()` 也每次新建）：基底对象会被 `mergeIndentConfig`
 * 读取，调用方若把它缓存成可变单例，两门语言/两次装配之间会互相串。
 */
export function erbBaseIndentPatterns(): BaseIndentPatterns {
  const patterns = erbEnterRulePatterns();
  return {
    indentOnEnter: patterns.indentOnEnter,
    increaseIndentPattern: patterns.increaseIndentPattern,
    decreaseIndentPattern: patterns.decreaseIndentPattern,
    ...(patterns.indentNextLinePattern ? { indentNextLinePattern: patterns.indentNextLinePattern } : {}),
    ...(patterns.unIndentedLinePattern ? { unIndentedLinePattern: patterns.unIndentedLinePattern } : {}),
  };
}

/**
 * 基底 + 结构规则 → Monaco 语言配置的两格（纯逻辑，零 Monaco）。
 *
 * 返回值与 `mergeIndentConfig` 同形（含 optional 两格）；`null` = 结构层这次没补任何规则，
 * 装配点一个字都不发。
 */
export function erbMergedIndentConfig(
  rules: KojoStructureIndentRules | null | undefined,
): MergedIndentConfig | null {
  return mergeIndentConfig(erbBaseIndentPatterns(), rules);
}

/** 本批结构缩进查询认的捕获名（测试与文档对账用；引擎另认同义 increase/decrease） */
export const ERB_INDENT_CAPTURES: readonly string[] = ['indent.begin', 'indent.end', 'indent.enter'];
