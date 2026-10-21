/**
 * Kojo 2.0 编辑器表面的**词表单一真源**（U6 / Monaco 语言面）。
 *
 * 为什么单开一层：`kojo2-language.ts`（Monarch 词法）与 `kojo2-enter.ts`（回车层级）
 * 都要用同一批词（声明词 / 调度词 / 保留词 / 域符号 / 运算符 / `@原生` 围栏词），
 * 若各取各的出口，两份清单迟早分叉。本文件把它们**集中一处**并从真源派生：
 *
 * - 2.0 词表 → `@kojo/kojo-core` 的 `tokens.ts`（core 的唯一词表真源，lexer/parser 同表）；
 * - 中文运算符表 → `@kojo/plugin-kojo-sugar` 的聚合词表（2.0 规范 §5.1「沿用现有中文表」；
 *   core 的表达式层尚未自持该表 ⇒ CUTOVER 时随 core 表达式词表一起迁，届时只改这一处 import）。
 *
 * 本文件**不新增任何词形**：所有数组都是真源的转发（`readonly`）。唯一的字面常量是
 * {@link KOJO2_NATIVE_FENCE_WORD}，理由见该常量的注释（core 没给围栏词单独命名导出）。
 */

import {
  KOJO_BLANK_LINE,
  KOJO_BLANK_WAIT,
  KOJO_DECL_WORDS,
  KOJO_DISPATCH_WORDS,
  KOJO_DOMAIN_SYMBOL_NAMES,
  KOJO_INDENT_WIDTH,
  KOJO_STORAGE_WORDS,
  KOJO_TABLE_DEFAULT,
  KOJO_TABLE_SUBJECT,
  KOJO_TEMPLATE_SLOT,
  KOJO_TYPE_WORDS,
  KOJO_WAIT_CONTINUE,
  KOJO_WEAVE_MODIFIERS,
} from '@kojo/kojo-core';
import { sugarEditorLexicon } from '@kojo/plugin-kojo-sugar';

/** 2.0 一级缩进（空格数）；栏头缩进阶梯与 `@原生` 体判定都按它算（core 同一常量）。 */
export const KOJO2_INDENT_WIDTH = KOJO_INDENT_WIDTH;

/** `#` 声明词（幕 / 视 / 机 / 变量 / 常量 / 表 / 池 / 模）。 */
export const KOJO2_DECL_WORDS: readonly string[] = KOJO_DECL_WORDS;

/** `@` 调度词（算 / 着色 / 颜绘 / … / 原生 / 织）。 */
export const KOJO2_DISPATCH_WORDS: readonly string[] = KOJO_DISPATCH_WORDS;

/**
 * 保留词（不是"声明词/调度词"的那些语言固定词）：表分隔词 `由`、默认分支 `否`、
 * 行尾不等待 `续`、空行语句三态词 `空行` / `等待`、类型词（整数 / 字符串）、
 * 存储期词（场景 / 存档 / 会话）、`@织` 修饰词（之前 / 之后 / 接管）。
 *
 * 逐项从 core 常量拼出，**本文件不写字形**；`kojo2-language-lexicon.test.ts` 用同一批
 * core 常量逐项反查（多一项少一项都红）。
 */
export const KOJO2_RESERVED_WORDS: readonly string[] = [
  KOJO_TABLE_SUBJECT,
  KOJO_TABLE_DEFAULT,
  KOJO_WAIT_CONTINUE,
  KOJO_BLANK_LINE,
  KOJO_BLANK_WAIT,
  ...KOJO_TYPE_WORDS,
  ...KOJO_STORAGE_WORDS,
  ...KOJO_WEAVE_MODIFIERS,
];

/**
 * 域符号（`我` / `你` / `她`）：2.0 里既是 adapter 提供的值，也是一等"说话人/代词"脸，
 * 单独一档（`kojo2.speaker` 同色），不做普通名字处理。
 */
export const KOJO2_DOMAIN_SYMBOLS: readonly string[] = KOJO_DOMAIN_SYMBOL_NAMES;

/** 表默认分支词（`否`）——`# 表` 两列行里第一列的这个词自己一档（关键字，不是范围）。 */
export const KOJO2_TABLE_DEFAULT_WORD = KOJO_TABLE_DEFAULT;

/** 行尾不等待标记（`续`）——行尾判据的正则从它派生（本文件之外不写这个字形）。 */
export const KOJO2_WAIT_CONTINUE = KOJO_WAIT_CONTINUE;

/** `# 模` 的插槽字面量 `[插槽]`（整格一个词，不是标识符）。 */
export const KOJO2_TEMPLATE_SLOT = KOJO_TEMPLATE_SLOT;

/**
 * 中文运算符词形（`等于` / `不等于` / `且` / `或` / `非` / `不在` …）。
 * 2.0 规范 §5.1 明写「沿用现有中文表」⇒ 取聚合词表的运算符与 `不在` 两支（单一真源）。
 */
export const KOJO2_OPERATOR_WORDS: readonly string[] = [
  ...sugarEditorLexicon().operators,
  ...sugarEditorLexicon().notin,
];

/**
 * `@原生` 围栏词。
 *
 * core 把 16 枚调度词登记成数组（{@link KOJO2_DISPATCH_WORDS}），但**没有**把"围栏词"
 * 单独命名导出；本常量因此是宿主层唯一一处手写。它不是新词：`kojo2-language-lexicon.test.ts`
 * 用 core 词法器对 `@<每个调度词>` 逐词实测，求出**真能开围栏**的那一枚并与本常量逐字相等
 * （core 换词/改语义 ⇒ 测试红，不静默漂移）。
 */
export const KOJO2_NATIVE_FENCE_WORD = '原生';

/** 正则元字符转义（词形 → Monarch 正则；不假定词形只含字词字符）。 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
