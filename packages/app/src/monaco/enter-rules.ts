import type * as Monaco from './entry';
import type { EnterRulePatterns } from '@kojo/plugin-kojo-sugar';

/**
 * 回车层级的**宿主唯一翻译层**（ERB-ENTER-RULES，2026-10-21）。
 *
 * 派生规则（`EnterRulePatterns`）住在词表那一侧：`.kojo` 由 `kojo-sugar` 的
 * `sugarEnterRulePatterns()` 从糖词表出，`.erb` 由 `erb-enter.ts` 从**引擎配对表**
 * （`erb-parser/scanner.ts` 的 `classifyControlFlow`）出的词表喂进同一个
 * `enterRulePatternsFromRoles()`。两侧产物同形，到这里只过一次 Monaco 协议翻译 ⇒
 * "两门一等语言的回车面长什么样"这件事只有这一处实现，新增一门语言不必再抄一遍
 * `onEnterRules` / `indentationRules` 的装配写法。
 *
 * 纪律：
 * - **可选格缺省即不写**（`indentNextLinePattern` / `unIndentedLinePattern`）——
 *   糖侧今天没有这两格，凭空写进去等于改掉 `.kojo` 既有的手感（本批判据：语义服务与
 *   既有读数零变化）；
 * - `indentOnEnter` 每条只翻成 `Indent` 动作：收束靠 `decreaseIndentPattern`
 *   （与 `.kojo` 同一条口径，`tests/kojo-language-config.test.ts` 钉着"Enter 上不许有
 *   Outdent"）；
 * - `indentationRules.increaseIndentPattern` 恒为并集形 ⇒ `onEnterRules` 每条
 *   `beforeText` 的 source 都含于它（两格不许分叉，同一条守卫测试）。
 */
export function toMonacoEnterConfig(
  monaco: typeof Monaco,
  patterns: EnterRulePatterns,
): Pick<Monaco.languages.LanguageConfiguration, 'onEnterRules' | 'indentationRules'> {
  const indentationRules: Monaco.languages.IndentationRule = {
    increaseIndentPattern: patterns.increaseIndentPattern,
    decreaseIndentPattern: patterns.decreaseIndentPattern,
    ...(patterns.indentNextLinePattern ? { indentNextLinePattern: patterns.indentNextLinePattern } : {}),
    ...(patterns.unIndentedLinePattern ? { unIndentedLinePattern: patterns.unIndentedLinePattern } : {}),
  };
  return {
    onEnterRules: patterns.indentOnEnter.map((beforeText) => ({
      beforeText,
      action: { indentAction: monaco.languages.IndentAction.Indent },
    })),
    indentationRules,
  };
}
