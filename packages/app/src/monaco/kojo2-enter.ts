/**
 * Kojo 2.0 的**回车层级出口**（SDK B4：判据本体搬进 `@kojo/kojo-lang/language-config`）。
 *
 * ## 本文件为什么还在，以及它为什么没有判据
 *
 * 判据（哪些形状 +1 级、`@原生` 栏头怎么认、成对记号表、`onEnterRules` 数据）**全在包里**，
 * 这里只做两件事：
 * 1. **原样转出**纯判据（`kojo2EnterIndent` 与三条正则常量）——既有 import 点一字未改；
 * 2. **落一次 Monaco**：`kojo2-indent.ts` 的打字合并层要的是枚举形状的两格（`onEnterRules` /
 *    `indentationRules`），而枚举值只有握着 Monaco 实例的人拿得到。翻译表住在
 *    {@link toMonacoOnEnterRules}（宿主唯一的语言面落点），本文件不另写一份档位表。
 *
 * 也就是说：**这里没有第二条判据，只有第二次搬运**。删掉本文件的条件是
 * `kojo2-indent.ts` 直接引落点——那是 B5 的活，不是今天的。
 */

import type * as Monaco from './entry';
import {
  KOJO2_ON_ENTER_RULES,
  KOJO2_INDENTATION_RULES,
} from '@kojo/kojo-lang/language-config';
import { toMonacoOnEnterRules } from './monaco-language-surface';

export {
  KOJO2_BLOCK_HEADER_COLON_RE,
  KOJO2_INDENT_UNIT,
  KOJO2_NATIVE_HEADER_RE,
  KOJO2_ON_ENTER_RULES,
  KOJO2_INDENTATION_RULES,
  kojo2EnterIndent,
  kojo2IsNativeFenceHeader,
} from '@kojo/kojo-lang/language-config';
export type { Kojo2EnterContext } from '@kojo/kojo-lang/language-config';

/**
 * Monaco `onEnterRules`：把单源的两格数据落成枚举形状（每一格都只可能是 `Indent`，
 * 绝不 Outdent——收束由作者回缩决定，见包内 `language-config.ts` 的口径）。
 */
export function kojo2OnEnterRules(
  monaco: typeof Monaco,
): NonNullable<Monaco.languages.LanguageConfiguration['onEnterRules']> {
  return toMonacoOnEnterRules(monaco, KOJO2_ON_ENTER_RULES, 'kojo2') ?? [];
}

/**
 * 回车层级的两格（`onEnterRules` 与 `indentationRules.increaseIndentPattern` 必须同源）：
 * 单源已经把这格铺成数据（`KOJO2_INDENTATION_RULES` 的两枚正则就是从
 * `KOJO2_ON_ENTER_RULES` 的 `beforeText.source` 并集出来的），这里只交出去。
 */
export function kojo2IndentationRules(): Monaco.languages.IndentationRule {
  return KOJO2_INDENTATION_RULES;
}
