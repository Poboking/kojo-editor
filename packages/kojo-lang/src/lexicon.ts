import {
  KOJO_ACTION_WORD_ALIAS,
  KOJO_BLANK_LINE,
  KOJO_BLANK_WAIT,
  KOJO_CANONICAL_CALL_WORD,
  KOJO_CANONICAL_ELSE_IF_WORD,
  KOJO_CANONICAL_ELSE_WORD,
  KOJO_CANONICAL_IF_WORD,
  KOJO_COMMENT_MARK,
  KOJO_DECL_WORDS,
  KOJO_DISPATCH_WORDS,
  KOJO_DOMAIN_SYMBOL_NAMES,
  KOJO_HEADER_CLOSE,
  KOJO_HEADER_DECL_ALIAS,
  KOJO_HEADER_DISPATCH_WORDS,
  KOJO_HEADER_OPEN,
  KOJO_INDENT_WIDTH,
  KOJO_STORAGE_WORDS,
  KOJO_TABLE_DEFAULT,
  KOJO_TABLE_SUBJECT,
  KOJO_TEMPLATE_SLOT,
  KOJO_TYPE_WORD_ALIAS,
  KOJO_TYPE_WORDS,
  KOJO_WAIT_CONTINUE,
  KOJO_WEAVE_MODIFIERS,
} from '@kojo/kojo-core';
import { sugarEditorLexicon } from '@kojo/kojo-vocab/keywords';

/**
 * Kojo 2.0 编辑器表面的**词表单一真源**（U6 / Monaco 语言面；**SDK B4 起住在 `@kojo/kojo-lang`**）。
 *
 * 为什么单开一层：`monarch.ts`（词法状态机）与 `language-config.ts`（回车层级）
 * 都要用同一批词（声明词 / 调度词 / 保留词 / 域符号 / 运算符 / `@原生` 围栏词），
 * 若各取各的出口，两份清单迟早分叉。本文件把它们**集中一处**并从真源派生：
 *
 * - 2.0 词表 → `@kojo/kojo-core` 的 `tokens.ts`（core 的唯一词表真源，lexer/parser 同表）；
 * - 中文运算符表 → `@kojo/kojo-vocab/keywords` 的聚合词表（2.0 规范 §5.1「沿用现有中文表」；
 *   core 的表达式层尚未自持该表 ⇒ 正解是让它自持，届时只改这一处 import——
 *   PLAN §4「B1 刻意没搬的三块」记的就是这条欠账，本包 purity 闸的白名单也是）。
 *
 * 本文件**不新增任何词形**：所有数组都是真源的转发（`readonly`）。唯一的字面常量是
 * {@link KOJO2_NATIVE_FENCE_WORD}，理由见该常量的注释（core 没给围栏词单独命名导出）。
 *
 * ## 住址为什么跟着 Monarch 走
 *
 * B4 之前它住在宿主的 `monaco` 目录（壳清理批之后连那枚一行 re-export 壳也删了）。词法面搬进
 * 本包之后它必须同批搬：供方拿不到宿主模块，而"宿主留一份、包里再抄一份"正是这一串批次一直
 * 在消掉的东西。消费方（`app/tests/kojo2-language-lexicon.test.ts` 等）直读本模块——
 * **一个判据只有一个落点**，单源闸扫的也是真身所在（见该测试的 `KOJO2_SOURCES`）。
 */

/** 2.0 一级缩进（空格数）；栏头缩进阶梯与 `@原生` 体判定都按它算（core 同一常量）。 */
export const KOJO2_INDENT_WIDTH = KOJO_INDENT_WIDTH;

/**
 * `#` 声明词（幕 / 视角 / 机 / 设（变量/常量两位同字）/ 表 / 池 / 模 / 方言）。
 *
 * 末位 `方言`（LAU §5.3）＝ 方言**断言**词位，真源在 core `tokens.ts`，本文件只转发 ⇒
 * Monarch 的 `@declWords` 分支（`monarch.ts` 的 `DECL_LINE`）自动把它接进
 * `KOJO2_TOKEN.declaration`，**不新造 token 名**（角色表是 LAU-2 的事）。
 *
 * ⚠ 位序是公开契约：`kojo2-format.ts` 按下标取词（`slice(0, 5)` 与
 * `[, , , , , TABLE, POOL, TEMPLATE]`）⇒ core 侧只能在**尾部追加**。
 */
export const KOJO2_DECL_WORDS: readonly string[] = KOJO_DECL_WORDS;

/** `@` 调度词（算 / 着色 / 颜绘 / … / 原生 / 织）。 */
export const KOJO2_DISPATCH_WORDS: readonly string[] = KOJO_DISPATCH_WORDS;

/**
 * 类型词（`整数` / `字符串`）——core `KOJO_TYPE_WORDS` 的**原样转发**，本文件不写字形。
 *
 * 2026-10-27 第三色批：这批词此前只在 {@link KOJO2_RESERVED_WORDS} 里以"保留词"的身份出现，
 * 于是 `# 设 人数 整数` 的 `整数` 与 `依据` / `否` 同色——而它改的是**这一列存什么**，
 * 与"这一行是不是声明"是两个问题。着色与补全都从这一枚导出取，不留第二份名单。
 */
export const KOJO2_TYPE_WORDS: readonly string[] = KOJO_TYPE_WORDS;

/**
 * 保留词（不是"声明词/调度词"的那些语言固定词）：表来源词 `依据`、默认分支 `否`、
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
 * 单独一档（说话人角色，与 v1 的代词档同色），不做普通名字处理。
 */
export const KOJO2_DOMAIN_SYMBOLS: readonly string[] = KOJO_DOMAIN_SYMBOL_NAMES;

/** 表默认分支词（`否`）——`# 对照表` 分档行里第一列的这个词自己一档（关键字，不是范围）。 */
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
 * 单独命名导出；本常量因此是语言面库里唯一一处手写。它不是新词：
 * `kojo2-language-lexicon.test.ts` 用 core 词法器对 `@<每个调度词>` 逐词实测，求出**真能开围栏**
 * 的那一枚并与本常量逐字相等（core 换词/改语义 ⇒ 测试红，不静默漂移）。
 */
export const KOJO2_NATIVE_FENCE_WORD = '原生';

/* ============================== 新正典表面（W1/W2） ============================== */

/**
 * 新正典表面词形：**全部从 core `tokens.ts` 转发**（W1/W2 词表已上提为公开常量），
 * 本文件不新增任何中文字形。改动点见 `docs/KOJO-2.0-LANGUAGE-REDESIGN.md` §2。
 *
 * - {@link KOJO2_HEADER_OPEN} / {@link KOJO2_HEADER_CLOSE}：方寸声明 `【…】` 的收口；
 * - {@link KOJO2_HEADER_DECL_ALIAS}：方寸声明里的**别名词**（`挂`→`机`、`定`→`设`）；
 * - {@link KOJO2_HEADER_DISPATCH_WORDS}：在既有词法层是 dispatch 词的方寸词（`函` / `织`）；
 * - {@link KOJO2_ACTION_WORD_ALIAS}：冒号动作词 → 既有调度词（表面别名表）；
 * - {@link KOJO2_CANONICAL_IF_WORD} / `..._ELSE_IF_WORD` / `..._ELSE_WORD`：条件族；
 * - {@link KOJO2_CANONICAL_CALL_WORD}：`演：` 调用族；
 * - {@link KOJO2_COMMENT_MARK}：整行 `※` 注释记号；
 * - {@link KOJO2_TYPE_WORD_ALIAS}：类型词正典 `数` / `文字` → 既有 `整数` / `字符串`。
 */
export const KOJO2_HEADER_OPEN: string = KOJO_HEADER_OPEN;
export const KOJO2_HEADER_CLOSE: string = KOJO_HEADER_CLOSE;
export const KOJO2_HEADER_DECL_ALIAS: ReadonlyMap<string, string> = KOJO_HEADER_DECL_ALIAS;
export const KOJO2_HEADER_DISPATCH_WORDS: ReadonlySet<string> = KOJO_HEADER_DISPATCH_WORDS;
export const KOJO2_ACTION_WORD_ALIAS: ReadonlyMap<string, string> = KOJO_ACTION_WORD_ALIAS;
export const KOJO2_CANONICAL_IF_WORD: string = KOJO_CANONICAL_IF_WORD;
export const KOJO2_CANONICAL_ELSE_IF_WORD: string = KOJO_CANONICAL_ELSE_IF_WORD;
export const KOJO2_CANONICAL_ELSE_WORD: string = KOJO_CANONICAL_ELSE_WORD;
export const KOJO2_CANONICAL_CALL_WORD: string = KOJO_CANONICAL_CALL_WORD;
export const KOJO2_COMMENT_MARK: string = KOJO_COMMENT_MARK;
export const KOJO2_TYPE_WORD_ALIAS: ReadonlyMap<string, string> = KOJO_TYPE_WORD_ALIAS;

/**
 * 方寸声明可用的**全部词形**（声明词 ∪ 别名词 ∪ dispatch 词）：`【` 之后第一枚词按它判档。
 * 派生而非手抄——core 加声明词 / 加别名 ⇒ 高亮 / 补全自动跟上。
 */
export const KOJO2_HEADER_WORDS: readonly string[] = Object.freeze(
  Array.from(
    new Set<string>([
      ...KOJO2_DECL_WORDS,
      ...KOJO2_HEADER_DECL_ALIAS.keys(),
      ...KOJO2_HEADER_DISPATCH_WORDS,
    ]),
  ),
);

/**
 * 类型词**表面全家**：正典 `数` / `文字` 在前，兼容 `整数` / `字符串` 在后。
 *
 * 排序即作者面口径（补全面板先新后旧）；`@kojo/kojo-core` 的 `KOJO_TYPE_WORDS` 仍是
 * AST 值类型 ↔ 词形的唯一真源，本常量只是"作者可能写的字面"的投影。
 */
export const KOJO2_TYPE_SURFACE_WORDS: readonly string[] = Object.freeze([
  ...KOJO2_TYPE_WORD_ALIAS.keys(),
  ...KOJO2_TYPE_WORDS,
]);

/**
 * W2 循环控制**正典**词形（`下一轮` / `跳出循环`；`断` / `续` 继续兼容）。
 *
 * core 词法层目前用字面量比较（尚未把这枚词形单独命名导出）⇒ 这里按任务书允许的方式
 * 自持一次"表面别名"，并注明出处；core 补导出后本行改为转发（词形同源，不改语义）。
 */
export const KOJO2_CANONICAL_NEXT_ROUND_WORD = '下一轮';
export const KOJO2_CANONICAL_BREAK_LOOP_WORD = '跳出循环';
export const KOJO2_LOOP_CONTROL_CANONICAL_WORDS: readonly string[] = Object.freeze([
  KOJO2_CANONICAL_NEXT_ROUND_WORD,
  KOJO2_CANONICAL_BREAK_LOOP_WORD,
]);

/** 冒号动作族的表面词（`算` / `色` / …；从别名表派生，正典顺序 = core 表序）。 */
export const KOJO2_ACTION_SURFACE_WORDS: readonly string[] = Object.freeze([
  ...KOJO2_ACTION_WORD_ALIAS.keys(),
]);

/** 方寸声明词 → 旧写法词（`挂`→`机`、`定`→`设`；其余原样）：hover / 补全讲"旧写法（兼容）"用。 */
export function kojo2HeaderCompatWord(word: string): string {
  return KOJO2_HEADER_DECL_ALIAS.get(word) ?? word;
}

/** 旧声明词 → 方寸正典词（`机`→`挂`、`设`→`定`；反查不到回原词）：补全模板用。 */
export function kojo2CanonicalHeaderWord(word: string): string {
  for (const [surface, mapped] of KOJO2_HEADER_DECL_ALIAS) {
    if (mapped === word) return surface;
  }
  return word;
}

/** 冒号动作词 → 旧 `@` 调度词（`算`→`算`、`色`→`着色`…）：hover 讲兼容形用。 */
export function kojo2ActionCompatWord(word: string): string | undefined {
  return KOJO2_ACTION_WORD_ALIAS.get(word);
}

/** 正则元字符转义（词形 → Monarch 正则；不假定词形只含字词字符）。 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
