/**
 * Kojo 2.0 的**缩进 / 回车判据**（B3i：整块从宿主 `monaco/kojo2-indent.ts` 搬进来）。
 *
 * 这一层回答三件事，全部是**纯函数**（零 Monaco / 零 React / 零 DOM / 零 IO）：
 *
 * 1. **回车后下一行该多深**（{@link kojo2IndentAfterLine}）：块头 / `?` 分支 / 表体 /
 *    同级容器 / `@原生` 围栏——判型只消费 core 的 `lex()`（`kind` / `word` / `indent`），
 *    本文件**不写第二套词法**、一个词形都不手抄；
 * 2. **on-type 要落的"行首空白替换"是哪一段**（{@link kojo2IndentReplacementAt}）：
 *    只接新行的空行、只改行首空白、算得出且不一样才给答案；
 * 3. **围栏内自动闭合该不该撤**（{@link kojo2AutoCloseTargetAt}）：Monaco 自动补出来的
 *    那枚闭括号在 `@原生` 体内删掉，围栏外一个字都不碰。
 *
 * ## 为什么判据必须住包（B3i 的由来）
 *
 * 判据留在宿主，就只服务宿主；而"回车该多深"是**语言事实**，与谁把编辑落到屏上无关。
 * B3c–B3f 的六批同形：供方是插件、插件看不见宿主 ⇒ 判据留在宿主就必然长出第二份。
 * 缩进这一面今天只有宿主消费方（on-type formatter 是 Monaco 引擎面，不是语言服务槽），
 * 但判据本身仍然只有一份——宿主 `monaco/kojo2-indent.ts` 只剩 **Monaco 装配与翻译**：
 * `OnTypeFormattingEditProvider` 的注册、`TextEdit` / `IRange` 的构造、worker 规则 →
 * `setLanguageConfiguration` 的接线。
 *
 * ## 静态规则与上下文判据的分工（B4 之后）
 *
 * `@kojo/kojo-lang/language-config` 交的是**静态规则数据**（`onEnterRules` /
 * `indentationRules`，经槽 `ui.monaco.language` 由供方交给宿主落进 Monaco），它只拿得到
 * "当前行文本"。本文件交的是**上下文判据**：`@原生` 围栏状态是跨行事实、缩进是否在 4 空格
 * 栅格上也只有整篇词法知道。两层不冲突：静态规则管按键瞬间的近似手感，本文件在
 * `formatOnType` 开启时校正到精确值（不一致才发一条 edit）。
 *
 * ## 判据（每一行只落一档；顺序即优先级）
 *
 * | 当前行 | 下一行缩进 |
 * |---|---|
 * | `@原生` 围栏**体内**（含围栏内空行） | `null`（原文保真：围栏内是 ERB，任何重排都会改坏原文） |
 * | 物理空行 / 整行 `//` 注释 | `null`（空行是块与链的结束符，注释不打断块） |
 * | 缩进不在 4 空格栅格上 / 含 Tab | `null`（2.0 结构缩进只用空格，§8.5；判不准就不动手） |
 * | `#` 块头 `# 对照表` / `# 池` / `# 模` | 本级 + 1（表行 / `?` 链 / 模板体） |
 * | `@` 块头 `@算` / `@着色` / `@随机` / `@组` / `@循` / `@复` / `@巡` / `@函` / `@织` / `@原生` | 本级 + 1 |
 * | `?` 条件行（含 `? 否`） | 本级 + 1（分支体） |
 * | `选项：`（`options` 行） | 本级 + 1 |
 * | `# 对照表` 的**两列行** | **本级**（行与行同层；值列不是更深的结构） |
 * | `@随机` 的候选行 / `@组` 的组体行 | **本级**（下一条候选、组的下一行都是兄弟） |
 * | 行尾全角 `：`（迁移期块头 / `选项` 的按钮标签） | 本级 + 1（与 `language-config` 的块头正则**同一条**） |
 * | 其余（`>` 旁白 / `角色：` 台词 / `!` 触发 / `@颜绘` / `@标` `@跳` `@返` `@断` `@续` / `# 幕` `# 机` `# 视角` / `# 设` `# 设` / 裸行） | `null`（不动手） |
 *
 * 三条口径值得单独说：
 * - **`>` / `!` 永不 +1**：旁白没有体；`! 模名(实参)` 的缩进块是**插槽**，而"这个模板有没有
 *   `[插槽]`"只有定义处知道（规范 §7.2 把"有没有缩进块"列为报错项，不是推断项）⇒ 判不准就不动。
 * - **`# 幕` / `# 机` / `# 视角` / `# 设` / `# 设` 不 +1**：它们是单行声明，体是顶层叙事 /
 *   后续声明，不是"更深一层"。漏进体里的行由 core 的 offside 规则报错，编辑器不替它猜。
 * - **结果永远是 4 空格的整数倍**：层级取 `line.indent / KOJO2_INDENT_WIDTH`（core 的
 *   `indent` 里 Tab 记 4，但含 Tab 的行已被上面那道闸挡掉）⇒ 缩进漂移（2 / 6 空格）不进
 *   计算，直接 `null`；返回的是**绝对缩进串**（不是"再补一级"），静态 `onEnterRules` 已经
 *   加过的那一级会被这里**校正**到精确值。
 *
 * ## 代价（写出来而不是藏着）
 *
 * 每次回车一次 core 词法（O(文档字符数)，与整篇声明扫描同量级；真夹具逐行扫描的读数见
 * `packages/kojo-lang/tests/indent.test.ts`）。为什么不用
 * 正则近似：`@原生` 的围栏状态是**跨行**判据（§8.5 的"严格更深"与"空行不参与基准"），
 * 正则层只会在围栏里误判；而 core 的 `lex` 正是这条判据的唯一实现。窗口化（只词法光标附近）
 * 会引入第二套围栏状态，本批不做。
 *
 * ## 失败面
 *
 * 判不准 / 非字符串 / 行号越界 / 词法抛错 ⇒ `null`（调用方一个字符都不改），绝不抛。
 */
import { KOJO_DECL_WORDS, KOJO_DISPATCH_WORDS, lex, type KojoLexLine } from '@kojo/kojo-core';
import {
  KOJO2_BLOCK_HEADER_COLON_RE,
  KOJO2_INDENT_UNIT,
  KOJO2_INDENTATION_RULES,
  KOJO2_NATIVE_HEADER_RE,
  KOJO2_PAIRS,
} from './language-config';
import { KOJO2_INDENT_WIDTH, KOJO2_NATIVE_FENCE_WORD } from './lexicon';

/* ============================== 词形（只取位序，不写字形） ============================== */

/**
 * core 词表的**语义位序**（`tokens.ts` §3.3 / §2.1）。这里不是新词表：所有值都是
 * `KOJO_DECL_WORDS` / `KOJO_DISPATCH_WORDS` 的元素；测试用真实 2.0 夹具逐格反证
 * （词序一变，夹具里那一行的判据当场红）。
 */
const [
  , // 幕 — 单行声明（体是顶层叙事，不是更深一层）
  , // 视角 — 单行声明
  , // 机 — 单行声明
  , // 设（变量）— 单行声明
  , // 设（常量）— 单行声明
  TABLE_WORD,
  POOL_WORD,
  TEMPLATE_WORD,
] = KOJO_DECL_WORDS;

const [
  CALC_WORD, // `@算`
  COLOR_WORD, // `@着色`
  , // 颜绘 — 单行（对象 / 表情 / 服装 / 差分 / 特效），不开体
  RANDOM_WORD, // `@随机`
  GROUP_WORD, // `@组`
  WHILE_WORD, // `@循`
  REPEAT_WORD, // `@复`
  FOREACH_WORD, // `@巡`
  FUNCTION_WORD, // `@函`
  WEAVE_WORD, // `@织`
  , // 标 — 单行语句
  , // 跳 — 单行语句
  , // 返 — 单行语句
  , // 断 — 单行语句
  , // 续 — 单行语句
  NATIVE_WORD, // `@原生`
] = KOJO_DISPATCH_WORDS;

/** `#` 系**开体**的块头（表行 / `?` 链 / 模板体） */
const BODY_DECL_WORDS: ReadonlySet<string> = new Set([TABLE_WORD, POOL_WORD, TEMPLATE_WORD]);

/** `@` 系**开体**的块头（调度区 / 演出块 / 循环 / 函数 / 织入 / 围栏） */
const BODY_DISPATCH_WORDS: ReadonlySet<string> = new Set([
  CALC_WORD,
  COLOR_WORD,
  RANDOM_WORD,
  GROUP_WORD,
  WHILE_WORD,
  REPEAT_WORD,
  FOREACH_WORD,
  FUNCTION_WORD,
  WEAVE_WORD,
  NATIVE_WORD,
]);

/** 「下一行仍是同级兄弟」的容器：`# 对照表` 的两列行、`@随机` 的候选、`@组` 的组体 */
const PEER_DECL_WORDS: ReadonlySet<string> = new Set([TABLE_WORD]);
const PEER_DISPATCH_WORDS: ReadonlySet<string> = new Set([RANDOM_WORD, GROUP_WORD]);

/* ============================== 行首空白的小工具（判据自用） ============================== */

/** 行首空白串（只认空格与 Tab；全角空格在 2.0 里不是缩进字符） */
function leadingWhitespaceOf(text: string): string {
  let i = 0;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  return text.slice(0, i);
}

/** 整篇切行（与 Monaco 的行号同一口径；`\r\n` / `\r` / `\n` 三种行尾都认） */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** 层级 → 缩进串（单位来自 `language-config`，与 core 的 `KOJO2_INDENT_WIDTH` 同一个数） */
function indentOfLevel(level: number): string {
  return KOJO2_INDENT_UNIT.repeat(Math.max(0, Math.trunc(level)));
}

/* ============================== 回车层级（纯函数） ============================== */

/**
 * 当前行的**直接结构父行**（缩进更浅的最近一行）。
 *
 * 只服务"同级容器"那一格，因此两条停止规则都照规范写死：
 * - **物理空行 ⇒ 没有父行**：空行结束 `?` 链（§5）、结束 `# 对照表`（§6.1）、`@随机` 内本来
 *   就不许空行（§8.4）；
 * - **注释跳过**：注释不打断链 / 表（§5 / §6.1）。
 *
 * 围栏内的行不算任何 2.0 结构的体（`native` 早退）：围栏体是原文，不是层级。
 */
function enclosingHeaderOf(lines: readonly KojoLexLine[], index: number): KojoLexLine | null {
  const current = lines[index];
  if (current === undefined) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.kind === 'blank') return null;
    if (line.kind === 'comment') continue;
    if (line.kind === 'native') return null;
    if (line.indent < current.indent) return line;
  }
  return null;
}

/** 这一行是不是"下一行仍是同级兄弟"的容器（见 {@link PEER_DECL_WORDS} / {@link PEER_DISPATCH_WORDS}） */
function isPeerContainer(line: KojoLexLine): boolean {
  if (line.kind === 'decl') return line.known && PEER_DECL_WORDS.has(line.word);
  if (line.kind === 'dispatch') return line.known && PEER_DISPATCH_WORDS.has(line.word);
  return false;
}

/**
 * **回车层级判据**（纯函数）：第 `line` 行（1 基）敲回车后，第 `line + 1` 行应有的行首空白。
 *
 * 返回 `null` = 不动手（非块头 / 判不准 / 非法缩进 / 围栏内 / 行号越界）。返回值恒为
 * `KOJO2_INDENT_WIDTH` 的整数倍个空格——它是**绝对缩进**，不是"再补一级"。
 *
 * `text` 是**整篇**文档（围栏状态是跨行判据，见模块头「代价」）；判型只消费 core 的 `lex`。
 */
export function kojo2IndentAfterLine(text: string, line: number): string | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  if (!Number.isInteger(line) || line < 1) return null;
  let lines: readonly KojoLexLine[];
  try {
    lines = lex(text).lines;
  } catch {
    return null; // 词法自己炸了 = 判不准 ⇒ 不动
  }
  const index = line - 1;
  const current = lines[index];
  if (current === undefined) return null; // 行号越界（回复与模型不同步 / 调用方算错）
  if (current.kind === 'blank' || current.kind === 'comment') return null;
  // `@原生` 围栏体内（含围栏内空行）：原文保真，一律不动
  if (current.kind === 'native') return null;
  // 2.0 结构缩进只用空格；含 Tab 或不在 4 空格栅格上的行 ⇒ 判不准
  if (current.tabs > 0) return null;
  if (current.indent % KOJO2_INDENT_WIDTH !== 0) return null;
  const level = current.indent / KOJO2_INDENT_WIDTH;

  // ① 开体：`@` 调度块头 → `?` 分支 → `选项：` → `#` 块头
  if (current.kind === 'dispatch' && current.known && BODY_DISPATCH_WORDS.has(current.word)) {
    return indentOfLevel(level + 1);
  }
  if (current.kind === 'condition') return indentOfLevel(level + 1);
  if (current.kind === 'options') return indentOfLevel(level + 1);
  if (current.kind === 'decl' && current.known && BODY_DECL_WORDS.has(current.word)) {
    return indentOfLevel(level + 1);
  }
  // ② 同级容器：表的两列行 / 随机候选 / 组体行——下一行仍是这一层的兄弟
  const parent = enclosingHeaderOf(lines, index);
  if (parent !== null && isPeerContainer(parent)) return indentOfLevel(level);
  // ③ 行尾全角冒号：迁移期块头与 `选项` 的 `「标签」：`（与包内块头正则同一条）
  //    旁白 / 行首转义行的行尾冒号是正文（`> 请选择你的行动：`），不在这里开体。
  if (
    current.kind !== 'narration' &&
    current.kind !== 'escaped' &&
    KOJO2_BLOCK_HEADER_COLON_RE.test(current.text)
  ) {
    return indentOfLevel(level + 1);
  }
  return null;
}

/* ============================== on-type：行首空白替换（纯判据） ============================== */

/**
 * on-type 回车要落的**行首空白替换**（1 基列区间 + 目标缩进串）。
 *
 * 三条纪律，缺一条就会咬到作者：
 * - **只接新行的空行**：行中回车切出来的半截是原行的延续，不是新块体（与 v1 同款）；
 * - **只在"算得出且不一样"时作答**：`null` / 已对齐 ⇒ `null`（幂等：同一位置问两次，答案
 *   一样；落过一次之后再问，已有缩进等于目标值 ⇒ 空答案，不会来回抖）；
 * - **只改行首空白**：区间到 `leading.length + 1` 为止，行内一个字符都不碰。
 *
 * `text` 是整篇文档、`line` 是**新行**的 1 基行号（第 1 行没有上一行 ⇒ 永远 `null`）。
 */
export interface Kojo2IndentReplacement {
  readonly line: number;
  /** 替换区间起点（1 基，恒为 1：行首空白从左边界开始） */
  readonly startColumn: number;
  /** 替换区间终点（1 基、开区间；`leading.length + 1`） */
  readonly endColumn: number;
  /** 目标缩进串（恒为 4 空格整数倍） */
  readonly text: string;
}

export function kojo2IndentReplacementAt(text: string, line: number): Kojo2IndentReplacement | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  if (!Number.isInteger(line) || line <= 1) return null;
  const current = splitLines(text)[line - 1];
  if (current === undefined) return null;
  if (current.trim().length !== 0) return null; // 行中回车切出来的半截：不是新块体
  const desired = kojo2IndentAfterLine(text, line - 1);
  if (desired === null) return null;
  const leading = leadingWhitespaceOf(current);
  if (leading === desired) return null; // 已对齐：不发编辑（幂等）
  return { line, startColumn: 1, endColumn: leading.length + 1, text: desired };
}

/* ============================== on-type：`@原生` 围栏自动闭合守卫（纯判据） ============================== */

/** 开括号 → 闭括号（`"` 两边同一枚）；表外 ⇒ `null` */
function closerOf(open: string): string | null {
  for (const [openChar, closeChar] of KOJO2_PAIRS) {
    if (openChar === open) return closeChar;
  }
  return null;
}

/**
 * 围栏内自动闭合的**删除目标**（1 基列区间；调用方据此删掉那枚自动补出来的闭括号）。
 *
 * 判据三条，缺一条就会误删作者的东西：
 * - 触发的必须是成对记号表里的**开**括号，且光标左侧刚打进去的就是它、右侧紧贴的是它的闭括号
 *   （合起来就是 Monaco 自动闭合留下的指纹）；
 * - 光标所在行必须是 `lex` 判定的 `@原生` **体内**（`kind === 'native'`，含围栏内空行）；
 * - 围栏外 / 台词 / 注释一律 `null`（自动闭合照旧，本守卫一个字都不碰）。
 *
 * 不确定（非字符串 / 行号列号越界 / 词法抛错）⇒ `null`。
 *
 * 已知上限（写出来而不是藏着）：这是 on-type 层，Monaco 只在 `formatOnType` 开启时派发；
 * 关掉它的作者在围栏内仍会拿到自动闭合（语言配置那一格没有围栏上下文，`notIn` 也不认
 * tokenizer 状态）。`@原生` 原文保真优先：宁可少补，不许改写围栏里的字节。
 */
export interface Kojo2AutoCloseTarget {
  readonly line: number;
  /** 要删的闭括号起点（1 基，= 光标列） */
  readonly startColumn: number;
  /** 要删的闭括号终点（1 基、开区间；`startColumn + 1`） */
  readonly endColumn: number;
}

export function kojo2AutoCloseTargetAt(
  text: string,
  line: number,
  column: number,
  trigger: string,
): Kojo2AutoCloseTarget | null {
  if (typeof text !== 'string' || !text.includes(KOJO2_NATIVE_FENCE_WORD)) return null;
  if (typeof trigger !== 'string' || trigger.length !== 1) return null;
  const closer = closerOf(trigger);
  if (closer === null) return null;
  if (!Number.isInteger(line) || line < 1) return null;
  if (!Number.isInteger(column) || column < 2) return null;
  const current = splitLines(text)[line - 1];
  if (current === undefined) return null;
  // 光标左一格 = 刚打进去的开括号；右一格 = 自动闭合补出来的闭括号
  if (current[column - 2] !== trigger) return null;
  if (current[column - 1] !== closer) return null;
  let record: KojoLexLine | undefined;
  try {
    record = lex(text).lines[line - 1];
  } catch {
    return null;
  }
  if (record === undefined || record.kind !== 'native') return null;
  return { line, startColumn: column, endColumn: column + 1 };
}

/* ============================== 基底规则（静态数据，宿主只拿去合并） ============================== */

/**
 * 2.0 的**基底缩进规则**（`@原生` 栏头与行尾全角冒号两条回车规则）。
 *
 * 与 `KOJO2_INDENTATION_RULES` 同一份源码（`indentOnEnter` 就是那两格 `beforeText`，
 * `increaseIndentPattern` 是它们的并集）；结构层的规则是**加法**，这两条一条都不撤。
 *
 * 形状与宿主的 `BaseIndentPatterns` 结构性同形（`indentOnEnter` / `increaseIndentPattern` /
 * `decreaseIndentPattern`），但本文件不 import 宿主的类型——装配层直接把它交给
 * `mergeIndentConfig`，判据侧不出现任何宿主名词。
 */
export const KOJO2_BASE_INDENT_RULES = Object.freeze({
  indentOnEnter: Object.freeze([KOJO2_NATIVE_HEADER_RE, KOJO2_BLOCK_HEADER_COLON_RE]),
  increaseIndentPattern: KOJO2_INDENTATION_RULES.increaseIndentPattern,
  decreaseIndentPattern: KOJO2_INDENTATION_RULES.decreaseIndentPattern,
});
