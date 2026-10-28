/**
 * 空白 / 缩进字符集的**唯一真源**（CHARSET-SS 批，2026-10-20）。
 *
 * ## 为什么要有这个文件
 *
 * 同一件事「这一行算不算空白 / 缩进多深 / 行尾从哪切」此前在 `kojo-sugar` 里有**三处**
 * 各自手写的集合，彼此不完全一致：
 *
 * 1. `lexer.ts`：`splitLogicalLines` 的 `rawIndent` 正则 `[ \t\u3000]`、`indentLevel` 的
 *    折算、`contentOf` 的**行尾** `\s+`（`\s` 是 JS 的宽集：含 NBSP `U+00A0`、`\v`、
 *    `\f`、`U+2003`…）；
 * 2. `sugar-ident.ts`：`contentOf` / `trimTrailingSpace` 的 `[ \t\u3000]`（行尾只用窄集）、
 *    `indentLevelOf` 的折算（与 lexer 同算法、第二份实现）；
 * 3. `formatter.ts`：`isIndentChar` / `leadingIndent` / `isAllIndent` 的字符比较。
 *
 * 差异的后果是**同一行在不同判定里得出不同结论**：仅含 NBSP 的行被 `classifyLine` 判
 * `blank`（`contentOf` 的 `\s+` 把它剥空），格式化器的 `.kojo` 腿因而把它**清空**，
 * 而 `.erb` 腿（`isAllIndent` 用窄集）与 `sugar-ident`（回显 / 写回口径）都当它是有内容的行。
 *
 * ## 口径：以 `[ \t\u3000]` 为唯一集合，NBSP 一类**不是**空白
 *
 * 不选 JS `\s` 的宽集，理由取既有单源结论（不是本批新立的口径）：
 *
 * - `packages/kojo-lang/src/completion.ts`（B3c 起空白单源住这里；原宿主落点 `monaco/kojo-completion-position.ts`
 *   已是它的 re-export）：`BLANK_CLASS_STR = '\\t \\u3000'`
 *   并注明「NBSP 一类**故意不收**：lexer 不认，补全也不能认（否则补得上、编译炸）」；
 * - `packages/app/tests/completion-blank-class.test.ts` 钉住 `isBlank('\u00a0') === false`；
 * - `packages/app/src/monaco/erb-completion.ts` 已把第四套 `/^\s*$/` 收敛到同一单源；
 * - 词法层处处接受 `[ \t\u3000]+` 作分隔/缩进（`时机　本番：` 这类全角写法能编译），
 *   而 NBSP 从来不是「能编译的那一套」的一部分。
 *
 * 真实语料侧：`.ERB` 全量 3,818 份零命中 NBSP（见 `erb-completion.ts` 注释），所以收窄
 * 行尾集合不改变任何真实文件的判定，只把**合成样例**上的分叉消掉。
 *
 * ## 消费方（三处都 import 这里，不许再抄）
 *
 * - `lexer.ts`：`leadingBlank` / `indentLevelOf` / `trimTrailingBlank`；
 * - `sugar-ident.ts`：同上（`contentOf` / `indentLevelOf` 保持原导出名，内部转调）；
 * - `formatter.ts`：`isBlankChar` / `leadingBlank` / `isAllBlank`。
 *
 * **有意保留的差异**（不是漏收口，见各调用点注释）：
 * - `formatter.ts` 的 `ERB_CANDIDATE_HEAD_RE` 用 ECMA-262 `trim()` 的**宽集**：它是块标记
 *   预筛，宽集只可能多放过、不可能认错，判据仍只在 `erbBodyStep`；
 * - 格式化器**从不改行尾空白**（台词行尾的全角空格是要打印的字），所以"行尾"这一列
 *   formatter 一律"不动"——与前三处的"读"判据不冲突。
 *
 * 本模块是**零依赖叶子**（不 import 任何模块）——`lexer` / `sugar-ident` 都能安心引它，
 * 不会造出环；更硬的一条约束在**构建期**：`sugar-ident.ts` 会被
 * `kojo-syntax-tree/tools/gen-word-forms.mjs` 用裸 Node（类型擦除档）直接 `import()`，
 * 而 `@kojo/plugin-api` 的入口会连带加载 `io.ts`（参数属性不在擦除档内）⇒ 一旦这里
 * 运行期 import 契约层，词表投影生成器直接起不来（`word-forms-single-source` 的字节闸红）。
 */

/**
 * 全角空格（`U+3000`）。
 *
 * 字符值**不**在运行期从契约层的 `FULLWIDTH_SPACE` 取（原因见文件头：构建期裸 Node 链路）；
 * 由 `blank-charset-single-source.test.ts` 与契约层导出值逐字相等钉住，漂移即红。
 */
const FULLWIDTH_SPACE = '\u3000';

/**
 * 缩进 / 空白字符：半角空格、TAB、全角空格（`U+3000`）。
 *
 * NBSP（`U+00A0`）、`\v`、`\f`、`U+2003` 一类**不在表内**——它们既不是缩进、也不算空白行
 * （口径见文件头）。要扩集合只能改这一处，三个消费方自动同判。
 */
export const BLANK_CHARS: readonly string[] = [' ', '\t', FULLWIDTH_SPACE];

/**
 * 正则字符类内容（由 {@link BLANK_CHARS} 派生，保证正则与 `isBlankChar` 同一份表）。
 *
 * 词法里的**分隔词**正则（`调用 X` / `如果 X 则 Y` / 语句函数…）也都写 `[ \t\u3000]`——
 * 与这里是同一集合、无分叉；它们留在正则字面量里（`new RegExp` 插值会把热路径正则从
 * 编译期挪到运行期），本批不为省几个字符去动它们。需要新拼正则时请用本常量。
 */
export const BLANK_CHAR_CLASS = BLANK_CHARS.map((c) =>
  c === '\t' ? '\\t' : `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`,
).join('');

const LEADING_BLANK_RE = new RegExp(`^[${BLANK_CHAR_CLASS}]*`);
const TRAILING_BLANK_RE = new RegExp(`[${BLANK_CHAR_CLASS}]+$`);
const ALL_BLANK_RE = new RegExp(`^[${BLANK_CHAR_CLASS}]*$`);

/** 单个字符是否空白（缩进字符）。`''` / 多字符 → `false` */
export function isBlankChar(ch: string): boolean {
  return ch.length === 1 && BLANK_CHARS.includes(ch);
}

/** 行首空白串（空串 = 没有缩进） */
export function leadingBlank(line: string): string {
  const m = LEADING_BLANK_RE.exec(line);
  return m === null ? '' : m[0];
}

/**
 * 缩进层级（0 基）：TAB = 1 级；全角空格 = 2 宽；半角空格 = 1 宽；空格宽每 4 个 1 级
 * （余数按 1 级算，避免半级丢失）。入参可以是整行（自己取行首空白），也可以是纯前缀。
 */
export function indentLevelOf(lineOrPrefix: string): number {
  const prefix = leadingBlank(lineOrPrefix);
  let tabs = 0;
  let spaces = 0;
  for (const ch of prefix) {
    if (ch === '\t') tabs++;
    else if (ch === FULLWIDTH_SPACE) spaces += 2;
    else if (ch === ' ') spaces += 1;
  }
  return tabs + (spaces > 0 ? Math.ceil(spaces / 4) : 0);
}

/** 去掉行尾空白（窄集：空格 / TAB / 全角空格；NBSP 一类保留——它们是内容，不是排版） */
export function trimTrailingBlank(text: string): string {
  return text.replace(TRAILING_BLANK_RE, '');
}

/** 整串都是空白（含空串）——`U+3000` 独占行与 `' '` 独占行同判 */
export function isAllBlank(text: string): boolean {
  return ALL_BLANK_RE.test(text);
}
