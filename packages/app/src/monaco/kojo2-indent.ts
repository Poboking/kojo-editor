/**
 * Kojo 2.0 的**回车缩进**（K2-FOLD-INDENT 批）：`kojo2IndentAfterLine(text, line)` 纯判据 +
 * 一枚 on-type formatter（触发字符 `\n`）。
 *
 * ## 为什么这一批不编 `queries/v2/indents.scm` 的规则
 *
 * 那份查询**刻意零捕获**（头注写明两条理由）：2.0 的缩进配对已经由外部记号
 * （`src/scanner.v2.c` 的 `indent` / `dedent`）做完，"捕获 → 回车规则"没有第二份真源可加；
 * 而 `(block) @indent.increase` 取的是块头**整行文本**，转成锚定正则要么撞上非法正则，
 * 要么退化成逐字匹配那一行。worker 因此如实回 `query-unavailable`（本批不动它）。
 * 回车这一面改用**结构判据**：判型只消费 core 的词法结果（`lex()` 的 `kind` / `word` /
 * `indent`），本文件**不写第二套词法**、一个词形都不手抄。
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
 * 也再挡一次）。触发字符跟随 v1 的 `installEnterIndenter`（`'\n'`）：Monaco 只在
 * `editor.formatOnType` 开启时派发——所以它是**增强层**，按键瞬间的手感仍由
 * `kojo2-enter.ts` 的 `onEnterRules` 兜；两层不冲突：正则层先给一个近似缩进，本层在
 * 生效时校正到精确值（不一致才发一条 edit）。
 *
 * 失败面：判不准 / 模型已释放 / 词法抛错 ⇒ `[]`（一个字符都不改），绝不抛进 Monaco。
 */
import type * as Monaco from './entry';
import { KOJO2_LANGUAGE_ID } from './kojo2-language';
import { isKojo2CutoverEnabled } from '../ui/kojo2-flag';
import { KOJO2_BLOCK_HEADER_COLON_RE, KOJO2_INDENT_UNIT } from './kojo2-enter';
import { KOJO2_INDENT_WIDTH } from './kojo2-lexicon';
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
 * 为 `kojo2` 语言注册回车缩进 formatter（**flag 关 = 零注册**）。
 *
 * 返回的 disposable 幂等（注册只撤一次）；provider 体内任何异常都只让**这一轮**不改缩进。
 */
export function installKojo2IndentProvider(monaco: typeof Monaco): Monaco.IDisposable {
  if (!isKojo2CutoverEnabled()) return NOOP_DISPOSABLE;
  const provider: Monaco.languages.OnTypeFormattingEditProvider = {
    autoFormatTriggerCharacters: [...KOJO2_INDENT_TRIGGER_CHARS],
    provideOnTypeFormattingEdits(model, position) {
      try {
        return kojo2IndentEditsAt(model, position);
      } catch {
        // 判不准 / 模型已释放 / 桩 model：一个字符都不改（缩进是增强层，不是唯一通路）
        return [];
      }
    },
  };
  // 注册失败没有额外资源可收（provider 无自有账）⇒ 直接外抛，由宿主的"全有或全无"回滚
  const registration = monaco.languages.registerOnTypeFormattingEditProvider(
    KOJO2_LANGUAGE_ID,
    provider,
  );  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      registration.dispose();
    },
  };
}
