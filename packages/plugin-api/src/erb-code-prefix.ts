/**
 * 行首「代码前缀」——`;!;` 与 `;#;` **不是注释**（2026-10-25 ERB 语法缺口批 P2-1）。
 *
 * ## 语言事实
 *
 * Emuera 认两种以 `;` 起头的**有效代码**前缀（来源：Era Wiki `Emuera/exetc`）：
 * - `;!;` —— "这行是 Emuera 专用语句"：eramaker 会当注释跳过，Emuera 照常执行。
 *   作者用它写"老引擎跑不动、但我不想让它变成注释"的行；
 * - `;#;` —— "这行只在调试模式执行"（等价于把这一行包进 `[IF_DEBUG]`）。
 *
 * 两种前缀之后的整段都是**正常 ERB 代码**：`;!;PRINTL あ` 会真的输出，
 * `;!;[SKIPSTART]` 会真的开停用区。把它们当整行注释吞掉，后果不止"少着一点色"——
 * `;!;[SKIPSTART]` 与后面对称的 `[SKIPEND]` 会**失配**，之后整篇文件的行可见性全错
 * （索引、波浪线、条件矩阵一起歪）。
 *
 * ## 为什么住在 `plugin-api`
 *
 * 这条判据要落到七个地方：骨架扫描（`parseErbText`）、控制流遍历
 * （`forEachControlFlowLine`）、预处理块体检（`checkPreprocStructure`）、
 * 可见行遍历（`visibleCodeLines`）、语法着色（`erb-highlight` / Monarch）、
 * 条件抽取（`condition-extractor`）。七处各写一遍 `startsWith(';!;')` 就是七份判据，
 * 迟早漂一次 ⇒ 与 `[SKIPSTART]` 的严格等值判据同一条纪律：**判据只有一个出口**。
 * 出口必须落在 `plugin-api`：`condition-extractor` 与 `erb-parser` 是**两个插件**，
 * 插件之间禁止互相 import（解耦审计 C 项），而两边都要这条判据 ⇒ 只有契约层能同时被两边引用
 * （与 `isErbDialectPath` / `MODEL_TOKEN_CLASS` 住在同一层的理由相同）。
 *
 * ## 口径细节
 *
 * - 前缀**必须顶格**（`trimmed` 之后判断）：缩进允许，因为 `trimmed` 已去掉行首空白；
 *   但 `;!;` 与代码之间**不要求**空白（`;!;PRINTL` 合法，语料里就是这么写的）。
 * - 大小写不敏感（`;#;` 与 `;!;` 都不含字母，但判据仍按不敏感写，避免将来加前缀时口径分叉）。
 * - `;!;` / `;#;` 之后的 `;` **仍是注释**（`;!;PRINTL x ;说明` 的尾巴由 `codeViewOf` 刷白）。
 * - 前缀本身**不产生列偏移修正**：本模块只回答"去掉前缀后的正文是什么"，
 *   `prefixLength` 单独给，让算列坐标的调用方自己加（`nameColumn` / `keywordEnd` 两处）。
 */

/** 行首代码前缀（顺序即匹配优先级；都是 3 个字符，故长度按 `PREFIX_LENGTH` 常量） */
export const ERB_CODE_PREFIXES: readonly string[] = [';!;', ';#;'];

/** 三种前缀的长度（`;!;` / `;#;` 同为 3；留常量是为了调用方不必再算） */
export const ERB_CODE_PREFIX_LENGTH = 3;

/**
 * 行首代码前缀的**长度**（0 = 没有前缀）。
 *
 * 只认 `trimmed` 起头的前缀；`; !;` / `;! ;` 这类中间带空白的形态**不认**——
 * 引擎是按字面前缀匹配的，宽容会让 `;!;` 与 `; !;` 两种写法走出不同语义。
 */
export function erbCodePrefixLength(trimmed: string): number {
  if (trimmed.length < ERB_CODE_PREFIX_LENGTH) return 0;
  const head = trimmed.slice(0, ERB_CODE_PREFIX_LENGTH);
  for (const prefix of ERB_CODE_PREFIXES) {
    if (head === prefix) return ERB_CODE_PREFIX_LENGTH;
  }
  return 0;
}

/**
 * 去掉行首代码前缀后的**代码正文**（无前缀 ⇒ 原样返回，零分配）。
 *
 * 注意返回的是 `trimmed` 的子串，**列坐标按调用方原串算**：正文比原串短
 * `erbCodePrefixLength()` 个字符。
 */
export function erbCodeBodyOf(trimmed: string): string {
  const len = erbCodePrefixLength(trimmed);
  return len === 0 ? trimmed : trimmed.slice(len);
}

/**
 * 是否**真注释行**（`;` 起头，且不是 `;!;` / `;#;` 代码前缀）。
 *
 * 所有"整行注释"的判定都该走这里——直接写 `startsWith(';')` 会把 `;!;` 的代码行也吞掉。
 */
export function isErbCommentLine(trimmed: string): boolean {
  return trimmed.startsWith(';') && erbCodePrefixLength(trimmed) === 0;
}
