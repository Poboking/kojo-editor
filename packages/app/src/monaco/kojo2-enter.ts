/**
 * Kojo 2.0 的回车层级（U6 / Monaco 语言面）。
 *
 * 这一层只回答一件事：**在光标处按 Enter 时，下一行要不要多一级缩进**。判据与词法面同源
 * （{@link KOJO2_INDENT_WIDTH} 来自 core），本文件不认任何中文字形，只认"行尾是否全角冒号"
 * 与"这一行是否 `@原生` 围栏头"两种形状。
 *
 * ## 口径
 * - **块头 `：` → 下一行 +1 级**：2.0 正典块头不写冒号（`# 表 心情 由 恋慕` / `? 恋慕 >= 500`），
 *   但迁移期与 `选项：` 一类 UI 块头仍以全角冒号收尾；作者在冒号后回车时必须直接落进体里。
 * - **`@原生` 围栏头 → 下一行 +1 级**：仓体内必须比栏头深（规范 §8.5），否则块体为空。
 * - **`@原生` 体内不动**：围栏内是 ERB 原文，任何"按形状猜层级"的动作都会改坏原文。
 *   Monaco 的 `onEnterRules` 只能看**当前行**（拿不到"我在围栏内"这个上下文）⇒ 静态配置
 *   只能做形状近似；真正的上下文判据是 {@link kojo2EnterIndent}（纯函数，`inNativeFence`
 *   为真时一律 0）。CUTOVER 若接编辑器级 enter handler，必须调这一个函数，不要另写一份。
 * - **Enter 上不许有 Outdent**：收束永远由作者回缩决定（2.0 没有全局收束词），自动回缩会把
 *   作者刚写的体弹出去；这条与 `.kojo` v1 的回车纪律一致。
 */

import type * as Monaco from './entry';
import {
  KOJO2_INDENT_WIDTH,
  KOJO2_NATIVE_FENCE_WORD,
  escapeRegExp,
} from './kojo2-lexicon';

/** 一级缩进 = 4 空格（core `KOJO_INDENT_WIDTH`，本文件不写魔数）。 */
export const KOJO2_INDENT_UNIT = ' '.repeat(KOJO2_INDENT_WIDTH);

/** 块头判据：行尾全角冒号（含尾部空白）。 */
export const KOJO2_BLOCK_HEADER_COLON_RE = /^\s*\S.*：\s*$/;

/** `@原生` 围栏头判据（整行只有它；缩进不限——块内也允许出现围栏）。 */
export const KOJO2_NATIVE_HEADER_RE = new RegExp(
  `^\\s*@${escapeRegExp(KOJO2_NATIVE_FENCE_WORD)}\\s*$`,
);

/** 回车时该行是否 `@原生` 围栏头（上下文判据的一枚原子，测试与 enter handler 共用）。 */
export function kojo2IsNativeFenceHeader(lineText: string): boolean {
  return KOJO2_NATIVE_HEADER_RE.test(lineText);
}

export interface Kojo2EnterContext {
  /**
   * 光标所在行是否处于 `@原生` 围栏体内。**围栏内一律不自动缩进**（原文保真优先）；
   * Monaco 语言配置拿不到这个上下文，故由 CUTOVER 的 enter handler 传进来。
   */
  readonly inNativeFence?: boolean;
}

/**
 * 回车层级判据（纯函数）：返回下一行应当追加的缩进级数（0 = 保持原样，1 = 多一级）。
 *
 * 顺序即优先级：围栏内不动 → `@原生` 栏头 +1 → 块头冒号 +1 → 其余不动。
 */
export function kojo2EnterIndent(lineText: string, context: Kojo2EnterContext = {}): number {
  if (context.inNativeFence === true) return 0;
  if (kojo2IsNativeFenceHeader(lineText)) return 1;
  if (KOJO2_BLOCK_HEADER_COLON_RE.test(lineText)) return 1;
  return 0;
}

/**
 * Monaco `onEnterRules`：每一格都只可能是 `Indent`（绝不 Outdent）。
 *
 * 两格顺序即优先级：`@原生` 栏头先于通用冒号判据（栏头不写冒号，顺序其实不相交；
 * 写死顺序是给以后加规则的人看"更专有的形状先判"）。
 */
export function kojo2OnEnterRules(
  monaco: typeof Monaco,
): NonNullable<Monaco.languages.LanguageConfiguration['onEnterRules']> {
  const indent = { indentAction: monaco.languages.IndentAction.Indent };
  return [
    { beforeText: KOJO2_NATIVE_HEADER_RE, action: indent },
    { beforeText: KOJO2_BLOCK_HEADER_COLON_RE, action: indent },
  ];
}

/**
 * 回车层级的两格（`onEnterRules` 与 `indentationRules.increaseIndentPattern` 必须同源）：
 * 后者是前两格 `beforeText.source` 的并集形，`kojo2-language.test.ts` 钉住"每一格都含于它"。
 */
export function kojo2IndentationRules(): Monaco.languages.IndentationRule {
  const union = `(?:${KOJO2_NATIVE_HEADER_RE.source})|(?:${KOJO2_BLOCK_HEADER_COLON_RE.source})`;
  return {
    increaseIndentPattern: new RegExp(union),
    // 2.0 的收束靠作者回缩（没有全局收束词）⇒ 永不自动 Outdent。
    decreaseIndentPattern: /(?!)/,
  };
}
