/**
 * Kojo 2.0 的**打字期结构增强层**（K2-FOLD-INDENT 批起，K2-INDENT-BRACKETS 批扩到括号）：
 * - `kojo2IndentAfterLine(text, line)` 回车缩进纯判据；
 * - `kojo2AutoCloseGuardEditsAt(model, position, trigger)` 围栏内自动闭合守卫；
 * - 一枚 on-type formatter 承接两条腿（触发字符 `\n` + 成对记号的开括号）；
 * - `installKojo2IndentConfigFromWorker(monaco, { getClient })`：把 worker 的 `indents` 回复
 *   经 `kojo2IndentConfigWith` 真正送进 `setLanguageConfiguration`（K2-INDENT-WIRE 批）。
 *
 * ## 与 `queries/v2/indents.scm` 的分工（K2-INDENT-BRACKETS 之后）
 *
 * 那份查询**已经有真捕获**（`@indent.increase` / `@indent.align`），worker 把它翻成宿主的
 * `KojoStructureIndentRules` 三条腿（`kojo2-worker.ts::indentRulesFromCaptures`），宿主侧
 * 由 `installKojo2IndentConfigFromWorker` 合并进语言配置（只加不撤）——那是
 * **静态规则**：Monaco 的 `onEnterRules` / `indentationRules` 只拿得到"当前行文本"，看不到
 * "这一行在不在 `@原生` 围栏里"，也拿不到"缩进是否在 4 空格栅格上"。回车这一面因此保留
 * **上下文判据**：判型只消费 core 的词法结果（`lex()` 的 `kind` / `word` / `indent`），
 * 本文件**不写第二套词法**、一个词形都不手抄。两层不冲突：静态规则管按键瞬间的近似手感，
 * 本层在 `formatOnType` 开启时校正到精确值（不一致才发一条 edit）。
 *
 * ## 判据（每一行只落一档；顺序即优先级）
 *
 * | 当前行 | 下一行缩进 |
 * |---|---|
 * | `@原生` 围栏**体内**（含围栏内空行） | `null`（原文保真：围栏内是 ERB，任何重排都会改坏原文） |
 * | 物理空行 / 整行 `//` 注释 | `null`（空行是块与链的结束符，注释不打断块） |
 * | 缩进不在 4 空格栅格上 / 含 Tab | `null`（2.0 结构缩进只用空格，§8.5；判不准就不动手） |
 * | `#` 块头 `# 表` / `# 池` / `# 模` | 本级 + 1（表行 / `?` 链 / 模板体） |
 * | `@` 块头 `@算` / `@着色` / `@随机` / `@组` / `@循` / `@复` / `@巡` / `@函` / `@织` / `@原生` | 本级 + 1 |
 * | `?` 条件行（含 `? 否`） | 本级 + 1（分支体） |
 * | `选项：`（`options` 行） | 本级 + 1 |
 * | `# 表` 的**两列行** | **本级**（行与行同层；值列不是更深的结构） |
 * | `@随机` 的候选行 / `@组` 的组体行 | **本级**（下一条候选、组的下一行都是兄弟） |
 * | 行尾全角 `：`（迁移期块头 / `选项` 的按钮标签） | 本级 + 1（与 `kojo2-enter.ts` **同一条正则**） |
 * | 其余（`>` 旁白 / `角色：` 台词 / `!` 触发 / `@颜绘` / `@标` `@跳` `@返` `@断` `@续` / `# 幕` `# 机` `# 视` / `# 变量` `# 常量` / 裸行） | `null`（不动手） |
 *
 * 三条口径值得单独说：
 * - **`>` / `!` 永不 +1**：旁白没有体；`! 模名(实参)` 的缩进块是**插槽**，而"这个模板有没有
 *   `[插槽]`"只有定义处知道（规范 §7.2 把"有没有缩进块"列为报错项，不是推断项）⇒ 判不准就不动。
 * - **`# 幕` / `# 机` / `# 视` / `# 变量` / `# 常量` 不 +1**：它们是单行声明，体是顶层叙事 /
 *   后续声明，不是"更深一层"。漏进体里的行由 core 的 offside 规则报错，编辑器不替它猜。
 * - **结果永远是 4 空格的整数倍**：层级取 `line.indent / KOJO2_INDENT_WIDTH`（core 的
 *   `indent` 里 Tab 记 4，但含 Tab 的行已被上面那道闸挡掉）⇒ 缩进漂移（2 / 6 空格）不进
 *   计算，直接 `null`；返回的是**绝对缩进串**（不是"再补一级"），`onEnterRules` 已经加过的
 *   那一级会被这里**校正**到精确值。
 *
 * ## 代价（写出来而不是藏着）
 *
 * 每次回车一次 core 词法（O(文档字符数)，与 `kojo2-declarations.ts` 的整篇扫描同量级；
 * 5,000 行 fixture 实测见 `tests/kojo2-folding-indent.test.ts` 的读数注）。为什么不用正则近似：
 * `@原生` 的围栏状态是**跨行**判据（§8.5 的"严格更深"与"空行不参与基准"），正则层只会
 * 在围栏里误判；而 core 的 `lex` 正是这条判据的唯一实现。窗口化（只词法光标附近）会引入
 * 第二套围栏状态，本批不做。
 *
 * ## 注册
 *
 * {@link installKojo2IndentProvider} 只给 `kojo2` 语言 id 注册 on-type formatter，
 * **flag 关时零注册**（调用点在 `ui/editor-global-providers.ts` 的 2.0 段里，本函数自身
 * 也再挡一次）。触发字符两族：`\n`（回车缩进，跟随 v1 `installEnterIndenter`）与
 * `KOJO2_PAIRS` 里的开括号（围栏内自动闭合守卫）。**必须同一枚 provider**：Monaco 只派发
 * 注册表里第一枚 provider 的触发字符（`format.js::getOnTypeFormattingEdits`），拆成两枚会让
 * 其中一族静默失效。
 *
 * Monaco 只在 `editor.formatOnType` 开启时派发——所以它是**增强层**，按键瞬间的手感仍由
 * `kojo2-enter.ts` 的 `onEnterRules` 与语言配置的 `autoClosingPairs` 兜；两条腿不冲突。
 * 围栏内自动闭合这条守卫因此也有上限：`formatOnType` 关掉的作者仍会在围栏里拿到自动闭合
 * （语言配置没有围栏上下文，`notIn` 只认 `string` / `comment` / `regex`）。
 *
 * {@link installKojo2IndentConfigFromWorker} 不注册 provider（Monaco 没有"缩进规则
 * provider"接口），只持有 `setLanguageConfiguration` 的账：挂点是 `kojo2-semantic.ts` 的
 * 安装器，语义着色**成功**拿到捕获之后惰性触发（见本文件「结构规则 → 语言配置」段）。
 *
 * 失败面：判不准 / 模型已释放 / 词法抛错 ⇒ `[]`（一个字符都不改），绝不抛进 Monaco。
 */
import type * as Monaco from './entry';
import { KOJO2_LANGUAGE_ID, KOJO2_PAIRS } from './kojo2-language';
import { isKojo2CutoverEnabled } from '../ui/kojo2-flag';
import { KOJO2_BLOCK_HEADER_COLON_RE, KOJO2_INDENT_UNIT, KOJO2_NATIVE_HEADER_RE, kojo2IndentationRules } from './kojo2-enter';
import { KOJO2_INDENT_WIDTH, KOJO2_NATIVE_FENCE_WORD } from './kojo2-lexicon';
import {
  mergeIndentConfig,
  type BaseIndentPatterns,
  type MergedIndentConfig,
} from './tree-sitter/indent';
import type {
  Kojo2IndentRules,
  Kojo2IndentsReply,
  Kojo2WorkerResult,
} from './tree-sitter/kojo2-worker-protocol';
import {
  KOJO_DECL_WORDS,
  KOJO_DISPATCH_WORDS,
  lex,
  type KojoLexLine,
} from '@kojo/kojo-core';

/* ============================== 词形（只取位序，不写字形） ============================== */

/**
 * core 词表的**语义位序**（`tokens.ts` §3.3 / §2.1）。这里不是新词表：所有值都是
 * `KOJO_DECL_WORDS` / `KOJO_DISPATCH_WORDS` 的元素；测试用真实 2.0 夹具逐格反证
 * （词序一变，夹具里那一行的判据当场红）。
 */
const [
  , // 幕 — 单行声明（体是顶层叙事，不是更深一层）
  , // 视 — 单行声明
  , // 机 — 单行声明
  , // 变量 — 单行声明
  , // 常量 — 单行声明
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

/** 「下一行仍是同级兄弟」的容器：`# 表` 的两列行、`@随机` 的候选、`@组` 的组体 */
const PEER_DECL_WORDS: ReadonlySet<string> = new Set([TABLE_WORD]);
const PEER_DISPATCH_WORDS: ReadonlySet<string> = new Set([RANDOM_WORD, GROUP_WORD]);

/** flag 关时交回的句柄（调用方照常 `dispose()`，什么也不会发生） */
const NOOP_DISPOSABLE: Monaco.IDisposable = { dispose: () => undefined };

/**
 * on-type 触发字符：只有换行。跟随 v1 `installEnterIndenter` 的同一条口径——
 * 触发面越窄，越不会与作者的手动缩进打架（打别的字不该触发缩进校正）。
 */
export const KOJO2_INDENT_TRIGGER_CHARS: readonly string[] = Object.freeze(['\n']);

/**
 * 自动闭合的**开括号**触发字符（与语言配置的 `autoClosingPairs` 同一张表 `KOJO2_PAIRS`）。
 *
 * 为什么要走 on-type：Monaco 的静态 `autoClosingPairs` 只有 `notIn: ['string'|'comment'|'regex']`
 * 三档，`@原生` 围栏是 tokenizer 状态、不在那三档里 ⇒ 语言配置挡不住围栏内的自动补。
 * 围栏上下文（`lex` 的 `kind === 'native'`）只有本模块的 on-type 层拿得到，所以由这里在
 * 同一枚 provider 里处理（Monaco 的 on-type 只派发**注册表里第一枚** provider 的触发字符，
 * 拆成第二枚 provider 会让回车缩进或本档之一静默失效——`format.js::getOnTypeFormattingEdits`）。
 */
export const KOJO2_AUTO_CLOSE_GUARD_TRIGGER_CHARS: readonly string[] = Object.freeze([
  ...new Set(KOJO2_PAIRS.map(([open]) => open)),
]);

/** 开括号 → 闭括号（`"` 两边同一枚）；表外 ⇒ `null` */
function closerOf(open: string): string | null {
  for (const [openChar, closeChar] of KOJO2_PAIRS) {
    if (openChar === open) return closeChar;
  }
  return null;
}

/* ============================== 结构判据（纯函数） ============================== */

/** 层级 → 缩进串（单位来自 `kojo2-enter.ts`，与 `KOJO2_INDENT_WIDTH` 同一个数） */
function indentOfLevel(level: number): string {
  return KOJO2_INDENT_UNIT.repeat(Math.max(0, Math.trunc(level)));
}

/**
 * 当前行的**直接结构父行**（缩进更浅的最近一行）。
 *
 * 只服务"同级容器"那一格，因此两条停止规则都照规范写死：
 * - **物理空行 ⇒ 没有父行**：空行结束 `?` 链（§5）、结束 `# 表`（§6.1）、`@随机` 内本来
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
  // ③ 行尾全角冒号：迁移期块头与 `选项` 的 `「标签」：`（与 kojo2-enter 同一条正则）
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

/* ============================== provider ============================== */

/** 取某一行原文（Monaco API 优先；桩 model 缺这一格时退回整篇切行） */
function lineContentOf(model: Monaco.editor.ITextModel, line: number): string {
  try {
    if (typeof model.getLineContent === 'function') {
      const text = model.getLineContent(line);
      if (typeof text === 'string') return text;
    }
  } catch {
    /* 越界 / 桩 model：走下面的整篇切行 */
  }
  try {
    return model.getValue().split(/\r\n|\r|\n/)[line - 1] ?? '';
  } catch {
    return '';
  }
}

/** 行首空白串（只认空格与 Tab；全角空格在 2.0 里不是缩进字符） */
function leadingWhitespaceOf(text: string): string {
  let i = 0;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  return text.slice(0, i);
}

/**
 * 一次 on-type 请求要落的编辑（导出仅为可单测：宿主只经 provider 调它）。
 *
 * 三条纪律，缺一条就会咬到作者：
 * - **只接新行的空行**：行中回车切出来的半截是原行的延续，不是新块体（与 v1 同款）；
 * - **只在"算得出且不一样"时发 edit**：`null` / 已对齐 ⇒ `[]`（幂等：同一位置问两次，
 *   答案一样；落过一次之后再问，已有缩进等于目标值 ⇒ 空结果，不会来回抖）；
 * - **只改行首空白**：区间到 `leading.length + 1` 为止，行内一个字符都不碰。
 */
export function kojo2IndentEditsAt(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): Monaco.languages.TextEdit[] {
  const line = position.lineNumber;
  if (!Number.isInteger(line) || line <= 1) return [];
  if (typeof model.getLanguageId === 'function' && model.getLanguageId() !== KOJO2_LANGUAGE_ID) {
    return [];
  }
  const current = lineContentOf(model, line);
  if (current.trim().length !== 0) return [];
  const desired = kojo2IndentAfterLine(model.getValue(), line - 1);
  if (desired === null) return [];
  const leading = leadingWhitespaceOf(current);
  if (leading === desired) return [];
  return [
    {
      range: {
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: leading.length + 1,
      },
      text: desired,
    },
  ];
}

/**
 * 自动闭合的**围栏守卫**（导出仅为可单测：宿主只经 provider 调它）。
 *
 * 判据三条，缺一条就会误删作者的东西：
 * - 触发的必须是成对记号表里的**开**括号，且光标左侧刚打进去的就是它、右侧紧贴的是它的闭括号
 *   （合起来就是 Monaco 自动闭合留下的指纹）；
 * - 光标所在行必须是 `lex` 判定的 `@原生` **体内**（`kind === 'native'`，含围栏内空行）；
 * - 围栏外 / 台词 / 注释一律 `[]`（自动闭合照旧，本守卫一个字都不碰）。
 *
 * 返回的编辑删掉那枚**自动补出来的**闭括号；不确定（模型取不到 / 行号越界 / 词法抛错）⇒ `[]`。
 *
 * 已知上限（写出来而不是藏着）：这是 on-type 层，Monaco 只在 `formatOnType` 开启时派发；
 * 关掉它的作者在围栏内仍会拿到自动闭合（语言配置那一格没有围栏上下文，`notIn` 也不认
 * tokenizer 状态）。`@原生` 原文保真优先：宁可少补，不许改写围栏里的字节。
 */
export function kojo2AutoCloseGuardEditsAt(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  trigger: string,
): Monaco.languages.TextEdit[] {
  if (typeof trigger !== 'string' || trigger.length !== 1) return [];
  const closer = closerOf(trigger);
  if (closer === null) return [];
  if (typeof model.getLanguageId === 'function' && model.getLanguageId() !== KOJO2_LANGUAGE_ID) {
    return [];
  }
  const line = position.lineNumber;
  const column = position.column;
  if (!Number.isInteger(line) || line < 1) return [];
  if (!Number.isInteger(column) || column < 2) return [];
  const current = lineContentOf(model, line);
  // 光标左一格 = 刚打进去的开括号；右一格 = 自动闭合补出来的闭括号
  if (current[column - 2] !== trigger) return [];
  if (current[column - 1] !== closer) return [];
  let text: string;
  try {
    text = model.getValue();
  } catch {
    return [];
  }
  if (typeof text !== 'string' || !text.includes(KOJO2_NATIVE_FENCE_WORD)) return [];
  let record: KojoLexLine | undefined;
  try {
    record = lex(text).lines[line - 1];
  } catch {
    return [];
  }
  if (record === undefined || record.kind !== 'native') return [];
  return [
    {
      range: {
        startLineNumber: line,
        startColumn: column,
        endLineNumber: line,
        endColumn: column + 1,
      },
      text: '',
    },
  ];
}

/**
 * 基底（`kojo2-enter.ts` 的语言配置判据）：`@原生` 栏头与行尾全角冒号两条回车规则。
 *
 * 与 `kojo2IndentationRules()` 同一份源码（`indentOnEnter` 就是那两格 `beforeText`，
 * `increaseIndentPattern` 是它们的并集）；结构层的规则是**加法**，这两条一条都不撤。
 */
const KOJO2_BASE_INDENT: BaseIndentPatterns = (() => {
  const rules = kojo2IndentationRules();
  return {
    indentOnEnter: [KOJO2_NATIVE_HEADER_RE, KOJO2_BLOCK_HEADER_COLON_RE],
    increaseIndentPattern: rules.increaseIndentPattern,
    decreaseIndentPattern: rules.decreaseIndentPattern,
  };
})();

/**
 * worker 的 `indents` 规则 → 宿主可直接 `setLanguageConfiguration` 的合并结果（additive 便捷口）。
 *
 * 这就是"宿主 `mergeIndentConfig` 消费"那一步：基底用 2.0 自己的回车判据（`@原生` 栏头 /
 * 行尾全角冒号），结构层规则只**加**在后面；`null` = worker 没给规则 / 全空 ⇒ 宿主不重发
 * 语言配置（与 v1 `syncIndentConfig` 同口径，空规则 = 一个字都不发）。
 *
 * 纯函数、零注册：接线在 {@link installKojo2IndentConfigFromWorker}（宿主挂点是
 * `kojo2-semantic.ts` 的安装器：语义着色成功拿到捕获之后惰性触发）。
 */
export function kojo2IndentConfigWith(
  rules: Kojo2IndentRules | null | undefined,
): MergedIndentConfig | null {
  return mergeIndentConfig(KOJO2_BASE_INDENT, rules);
}

/* ============================== 结构规则 → 语言配置（K2-INDENT-WIRE） ============================== */

/**
 * 三条腿各自的规则上限。
 *
 * 规则按**语言**累积（`setLanguageConfiguration` 是语言级的，不是文档级的）：一篇文档的
 * `# 表` 与另一篇的 `# 池` 都该进同一份配置，否则"打开 A 再打开 B"会把 A 的块头规则弄丢。
 * 但累积必须有界——词形家族只有十几枚，128 已比现实宽一个量级；病态文档（真词表外的一堆
 * 伪块头）不许把语言配置撑爆。
 */
export const KOJO2_INDENT_CONFIG_MAX_PATTERNS = 128;

/**
 * 缩进规则来源（worker 客户端的最小依赖面；真 `Kojo2WorkerClient` 与测试替身都满足）。
 *
 * `indents` 是**可选**的：只买语义面的替身 / 老客户端没有这一格 ⇒ 本层零改动
 * （不是"发一条空规则"，是一条都不发）。
 */
export interface Kojo2IndentRulesSource {
  indents?(
    text: string,
    version: number,
    oldTreeId?: string,
  ): Promise<Kojo2WorkerResult<Kojo2IndentsReply>>;
}

/** 依赖注入缝（测试用；生产全部走缺省） */
export interface Kojo2IndentConfigDeps {
  /**
   * 取 worker 客户端（缺省 = 动态 import `kojo2-worker-runtime` 的单例）。
   * 动态 import 让**主线程静态图里连薄客户端都不出现**：flag 关 / 没人要结构层时，
   * `?worker` 入口与协议模块一个字节都不装载。
   */
  readonly getClient?: () => Kojo2IndentRulesSource | null | Promise<Kojo2IndentRulesSource | null>;
  /** 一次性告警出口（缺省 `console.warn`；测试可收账） */
  readonly warn?: (message: string) => void;
}

/**
 * 结构规则 → 语言配置的**句柄**（不注册 provider：本层只持有 `setLanguageConfiguration`
 * 的那一枚 disposable）。
 */
export interface Kojo2IndentConfigHandle {
  /**
   * 惰性触发一轮（宿主在**语义着色 provider 成功拿到捕获之后**调它；同一 model 同一版本
   * 只发一次 worker 请求）。返回 Promise 只为可单测——宿主 `void` 掉即可。
   *
   * `oldTreeId` = 语义着色那一轮刚解出来的树号：worker 的查询请求带它就能直接查（文本逐字
   * 相同 ⇒ 不重解），不带也能跑（worker 会自己解一棵）。这是**省一次 parse** 的增量，
   * 不是正确性前提。
   */
  request(model: Monaco.editor.ITextModel, oldTreeId?: string): Promise<boolean>;
  /** `request` 的别名（同一条队列；导出只为可读的调用点） */
  applyFor(model: Monaco.editor.ITextModel, oldTreeId?: string): Promise<boolean>;
  /** 幂等：撤掉本层写过的语言配置，之后不再发请求 / 不再写配置 */
  dispose(): void;
}

/**
 * 缺省客户端：懒到第一次真请求才把 worker 模块拉进来（与 `kojo2-semantic.ts` 同一条惰性口径）。
 */
async function defaultIndentWorkerClient(): Promise<Kojo2IndentRulesSource | null> {
  const module = await import('./tree-sitter/kojo2-worker-runtime');
  return module.getKojo2WorkerClient();
}

/** 规则腿的运行时兜底：只留非空字符串（假客户端 / 版本错位都不许把配置写坏） */
function readRuleLeg(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const pattern of value) {
    if (typeof pattern === 'string' && pattern.length > 0) out.push(pattern);
  }
  return out;
}

/** 累积规则（三条腿各自去重 + 封顶；存量一条都不撤） */
function absorbPatterns(target: Set<string>, patterns: readonly string[], limit: number): void {
  for (const pattern of patterns) {
    if (target.size >= limit) return;
    target.add(pattern);
  }
}

/**
 * 造一枚"结构规则 → 语言配置"的同步器（**不注册任何 provider**）。
 *
 * ## 挂点为什么是"语义着色成功之后"
 *
 * Monaco 的 `setLanguageConfiguration` 是语言级的，但规则只能由 worker 在**某一篇文本**上
 * 跑 `indents` 查询得到；而宿主手里唯一"每篇都过一遍、且已经证明 worker 可用"的位置，就是
 * 语义着色 provider 的成功分支（`kojo2-semantic.ts`，它已经拿到 model + 版本号）。
 * 于是：worker 不回复 / 查询缺席 ⇒ 着色那条链先降级，本层连请求都不会发 ⇒ **零改动**。
 *
 * ## 纪律（每一条都有对应测试）
 *
 * - **只交两个属性**：`onEnterRules` + `indentationRules`（property 级合并；注释 / 括号 /
 *   `wordPattern` 一概不写 ⇒ 继续走 `kojo2LanguageConfiguration` 那一份）；
 * - **同 key 只发一次**：key = `mergeIndentConfig` 的规则指纹（含基底两格）；同一份规则
 *   第二次回复不再重写语言配置（每次重注册会让 Monaco 整批编辑器重算缩进）；
 * - **规则按语言累积**：后开的文档只**加**自己那批块头词形，从不撤前一篇的；
 * - **失败零改动**：worker 不可用 / 超时 / 查询缺席 / 回复坏形 / 取客户端抛错
 *   ⇒ 不写配置，**也不撤**已有配置（旧配置继续生效）；
 * - **同一 model 同一版本只问一次**（Monaco 停笔 / 滚动会反复重问 provider）；
 * - **不抛进 Monaco**：所有异常只让这一轮不写配置；
 * - {@link Kojo2IndentConfigHandle.dispose} 幂等：只撤一次自己写过的那枚配置。
 *
 * flag 关 ⇒ 交回的句柄什么都不做（零请求、零配置，见 {@link installKojo2IndentConfigFromWorker}）。
 */
export function createKojo2IndentConfigSync(
  monaco: typeof Monaco,
  deps: Kojo2IndentConfigDeps = {},
): Kojo2IndentConfigHandle {
  const getClient = deps.getClient ?? defaultIndentWorkerClient;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const warned = new Set<string>();
  /** 语言级累积（三条腿各自去重 + 封顶） */
  const increase = new Set<string>();
  const enter = new Set<string>();
  const decrease = new Set<string>();
  /** model → 已经问过的版本号（同版本不重发请求） */
  const requested = new WeakMap<Monaco.editor.ITextModel, number>();
  /** 已写进语言配置的规则指纹（`MergedIndentConfig.key`） */
  let appliedKey: string | null = null;
  /** 本层写过的那枚语言配置的 disposable（只撤自己写的那一份） */
  let registration: Monaco.IDisposable | null = null;
  /** 一条队列：两条回复并发时，"后写的那份"必须包含"先写的那份"（语言配置不能倒退） */
  let tail: Promise<void> = Promise.resolve();
  let disposed = false;

  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    try {
      warn(message);
    } catch {
      /* 告警出口自己炸了不该把本层带下水 */
    }
  };

  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const versionOf = (model: Monaco.editor.ITextModel): number => {
    try {
      const version = model.getVersionId();
      return typeof version === 'number' && Number.isFinite(version) ? Math.trunc(version) : 0;
    } catch {
      return 0;
    }
  };

  /** 只交 `onEnterRules` + `indentationRules`（两个属性，property 级合并） */
  const writeConfig = (merged: MergedIndentConfig): Monaco.IDisposable | null => {
    let result: Monaco.IDisposable | undefined;
    try {
      result = monaco.languages.setLanguageConfiguration(KOJO2_LANGUAGE_ID, {
        onEnterRules: merged.onEnterRules.map((rule) => ({
          beforeText: rule.beforeText,
          action: { indentAction: monaco.languages.IndentAction.Indent },
        })),
        indentationRules: {
          increaseIndentPattern: merged.increaseIndentPattern,
          decreaseIndentPattern: merged.decreaseIndentPattern,
          // 基底这两格是"整对象替换"里最容易被顺手撤掉的部分：原样带出（2.0 基底没有 ⇒ 不写）
          ...(merged.indentNextLinePattern === undefined
            ? {}
            : { indentNextLinePattern: merged.indentNextLinePattern }),
          ...(merged.unIndentedLinePattern === undefined
            ? {}
            : { unIndentedLinePattern: merged.unIndentedLinePattern }),
        },
      });
    } catch (error: unknown) {
      // 写不进去 = 这一轮零改动（旧配置还在：registration 只在写成功之后才换）
      warnOnce(
        `write:${error instanceof Error ? error.message : String(error)}`,
        `[kojo2-indent] 无法写语言配置（本轮保持原样，编辑器不受影响）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
    if (result !== null && typeof result === 'object' && typeof result.dispose === 'function') {
      return result;
    }
    // 桩 Monaco / 老版本可能不交 disposable：本层没有可撤的账，给一枚空句柄占位
    return { dispose: () => undefined };
  };

  const applyOnce = async (
    model: Monaco.editor.ITextModel,
    oldTreeId?: string,
  ): Promise<boolean> => {
    if (disposed) return false;
    if (typeof model.isDisposed === 'function' && model.isDisposed()) return false;
    // 只服务 2.0 语言：`setLanguageConfiguration` 会改**整门语言**的缩进手感，认错语言就是事故
    const languageId = typeof model.getLanguageId === 'function' ? model.getLanguageId() : KOJO2_LANGUAGE_ID;
    if (languageId !== KOJO2_LANGUAGE_ID) return false;
    let text: string;
    try {
      text = model.getValue();
    } catch {
      return false; // 模型已释放 / 桩 model 取不到文：一个字都不改
    }
    if (typeof text !== 'string' || text.trim().length === 0) return false;

    let client: Kojo2IndentRulesSource | null;
    try {
      client = await getClient();
    } catch (error: unknown) {
      warnOnce(
        `client:${error instanceof Error ? error.message : String(error)}`,
        `[kojo2-indent] 取不到结构 worker（本轮不写缩进配置，原有回车规则不变）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
    if (disposed) return false;
    if (client === null || client === undefined) return false;
    const indents = client.indents;
    // 只买语义面的客户端 / 老替身没有这一格 ⇒ 本层零改动（一条规则都不发）
    if (typeof indents !== 'function') return false;

    let reply: Kojo2WorkerResult<Kojo2IndentsReply>;
    try {
      // `oldTreeId` = 语义着色刚解出来的那棵树：worker 文本逐字相同 ⇒ 直接查，不重解
      reply = await indents.call(client, text, versionOf(model), oldTreeId);
    } catch (error: unknown) {
      warnOnce(
        `request:${error instanceof Error ? error.message : String(error)}`,
        `[kojo2-indent] indents 请求抛错（本轮不写缩进配置）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
    if (disposed) return false;
    if (reply === null || typeof reply !== 'object' || reply.ok !== true) {
      const reason = reply !== null && typeof reply === 'object' && 'reason' in reply ? String(reply.reason) : 'unknown';
      warnOnce(
        `worker:${reason}`,
        `[kojo2-indent] 结构层没有给出缩进规则（${reason}）⇒ 保持既有语言配置不变`,
      );
      return false;
    }
    if (reply.value.type !== 'indents') return false;

    const rules = reply.value.rules as Partial<Kojo2IndentRules> | null | undefined;
    absorbPatterns(increase, readRuleLeg(rules?.increasePatterns), KOJO2_INDENT_CONFIG_MAX_PATTERNS);
    absorbPatterns(enter, readRuleLeg(rules?.enterPatterns), KOJO2_INDENT_CONFIG_MAX_PATTERNS);
    absorbPatterns(decrease, readRuleLeg(rules?.decreasePatterns), KOJO2_INDENT_CONFIG_MAX_PATTERNS);

    const merged = kojo2IndentConfigWith({
      increasePatterns: [...increase].sort(),
      decreasePatterns: [...decrease].sort(),
      enterPatterns: [...enter].sort(),
    });
    // `null` = 这份文档没有开体行（基底一条都在，但基底已经由语言注册写过了）⇒ 不重发
    if (merged === null) return false;
    if (merged.rejected > 0) {
      warnOnce(
        `rejected:${merged.rejected}:${merged.key}`,
        `[kojo2-indent] 结构层给了 ${merged.rejected} 条非法正则 ⇒ 这几条丢掉，其余规则照常生效`,
      );
    }
    if (merged.key === appliedKey) return false;

    const next = writeConfig(merged);
    if (next === null) return false;
    const previous = registration;
    registration = next;
    appliedKey = merged.key;
    // 新配置已经生效，才撤旧的那一枚（property 级合并：撤旧不会把新配置带走）
    try {
      previous?.dispose();
    } catch {
      /* 旧注册自己炸了：新配置已经生效，不影响结论 */
    }
    return true;
  };

  const request = (model: Monaco.editor.ITextModel, oldTreeId?: string): Promise<boolean> => {
    if (disposed) return Promise.resolve(false);
    if (model === null || typeof model !== 'object') return Promise.resolve(false);
    const version = versionOf(model);
    if (requested.get(model) === version) return Promise.resolve(false);
    requested.set(model, version);
    return serialize(() => applyOnce(model, oldTreeId).catch(() => false));
  };

  return {
    request,
    applyFor: request,
    dispose() {
      if (disposed) return;
      disposed = true;
      const current = registration;
      registration = null;
      appliedKey = null;
      try {
        current?.dispose();
      } catch {
        /* 撤注册失败不改结论：编辑器正在关，配置随语言服务一起走 */
      }
    },
  };
}

/** flag 关时交回的句柄（调用方照常 `request` / `dispose`，什么也不会发生） */
function noopIndentConfigHandle(): Kojo2IndentConfigHandle {
  const never = (): Promise<boolean> => Promise.resolve(false);
  return { request: never, applyFor: never, dispose: () => undefined };
}

/**
 * 宿主挂点：把 worker `indents` 回复经 {@link kojo2IndentConfigWith} 送进
 * `setLanguageConfiguration('kojo2', { onEnterRules, indentationRules })`。
 *
 * **不注册 provider**（所以 flag 关时天然"零注册"）；宿主在语义着色 provider 成功拿到捕获
 * 之后调 `request(model)` 惰性触发（挂点在 `kojo2-semantic.ts` 的 `install` 里）。
 *
 * 为什么不做成 provider：Monaco 没有"缩进规则 provider"接口，规则只能写进语言配置；
 * 而语言配置是语言级的——本函数因此只持有那一枚 disposable 的账。
 */
export function installKojo2IndentConfigFromWorker(
  monaco: typeof Monaco,
  deps: Kojo2IndentConfigDeps = {},
): Kojo2IndentConfigHandle {
  if (!isKojo2CutoverEnabled()) return noopIndentConfigHandle();
  return createKojo2IndentConfigSync(monaco, deps);
}

/**
 * 为 `kojo2` 语言注册回车缩进 formatter（**flag 关 = 零注册**）。
 *
 * 返回的 disposable 幂等（注册只撤一次）；provider 体内任何异常都只让**这一轮**不改缩进。
 */
export function installKojo2IndentProvider(monaco: typeof Monaco): Monaco.IDisposable {
  if (!isKojo2CutoverEnabled()) return NOOP_DISPOSABLE;
  const provider: Monaco.languages.OnTypeFormattingEditProvider = {
    // 一枚 provider 两条腿：`\n` 走回车缩进，开括号走围栏内自动闭合守卫（见两个触发字符常量的注释）
    autoFormatTriggerCharacters: [
      ...KOJO2_INDENT_TRIGGER_CHARS,
      ...KOJO2_AUTO_CLOSE_GUARD_TRIGGER_CHARS,
    ],
    provideOnTypeFormattingEdits(model, position, ch) {
      try {
        return ch === '\n'
          ? kojo2IndentEditsAt(model, position)
          : kojo2AutoCloseGuardEditsAt(model, position, ch);
      } catch {
        // 判不准 / 模型已释放 / 桩 model：一个字符都不改（缩进与围栏守卫都是增强层，不是唯一通路）
        return [];
      }
    },
  };
  // 注册失败没有额外资源可收（provider 无自有账）⇒ 直接外抛，由宿主的"全有或全无"回滚
  const registration = monaco.languages.registerOnTypeFormattingEditProvider(
    KOJO2_LANGUAGE_ID,
    provider,
  );
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      registration.dispose();
    },
  };
}
