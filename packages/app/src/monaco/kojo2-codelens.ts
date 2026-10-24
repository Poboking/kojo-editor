/**
 * Kojo 2.0 **行上注解**（K2-LSP-CODELENS，批次八）：`# 机` 事件挂点、`@织` 监听层、
 * `@函` 同文件引用计数。
 *
 * ## 这一层回答的三个问题（同一篇文档，一次词法扫描）
 *
 * | 行 | 注解 | 点击 |
 * |---|---|---|
 * | `# 机 <事件> [参数…]` | `事件 <名> · 参数 N` | 落到事件名（`mode: 'reveal'`） |
 * | `@织 <事件> [之前/之后/接管]` | `监听 <名> · <层>` | 落到事件名（`mode: 'reveal'`） |
 * | `@函 <名>(…)` | `本文件 N 处用到` | 进引用面（`mode: 'references'`） |
 *
 * 三句都是**源码自身的结构事实**，与既有呈现面不重叠：悬停讲记号的中文名、转到定义讲
 * 正向边（这个名字定义在哪）、大纲 / 面包屑讲结构、问题面板讲对错；「这个文件挂在哪个事件上」
 * 「这个监听在哪一层」「这个名字在这份文件里被用了几次」此前没有一处给出。
 *
 * ## 复用既有通道，不自造第二套跳转（纪律同 `kojo-code-lens.ts`）
 *
 * 注解的 `command.id` 就是 v1 行上注解那枚**已注册**的 `CODE_LENS_COMMAND`
 * （`kojo.codeLens.execute`，由 `installCodeLensProvider` 常驻注册）。参数是
 * {@link Kojo2CodeLensTarget}：`EditorSymbolLocation` 加一枚 additive 的 `mode` 判别位。
 * 于是**今天零接线也不假**：v1 命令处理端只认 `filePath` / `line`，会把三种点击都落到
 * 既有 `editor.revealLocation`（与转到定义同一条腿）；宿主随后按 `mode === 'references'`
 * 分到引用面即可（wiring 请求见批次回执，本模块不碰宿主文件）。
 *
 * ## 分层：纯逻辑与 Monaco 协议翻译分开
 *
 * - {@link kojo2CodeLenses}：源码文本 → 注解事实（**纯函数**，零 IO、零 Monaco、零缓存）；
 * - {@link toMonacoCodeLenses}：事实 → `monaco.languages.CodeLens`（唯一翻译点）；
 * - {@link installKojo2CodeLensProvider}：只挂 `kojo2` 语言 id；flag 关 = 零注册。
 *
 * ## `@函` 的计数口径（为什么是「本文件」+「调用点」）
 *
 * 1. **范围只到本文件**：2.0 的引用面当下是文件局部的（跨文件可见性由装载决定，编辑器不持有
 *    那份表）⇒ 标题写「本文件 N 处用到」，不把「本文件 0 处」冒充成「全项目没人用」。
 *    缺席不再有第二种含义：0 处也照常出（这是源码事实，不是「无话可说」）。
 * 2. **只数可证明的调用点**：`! 名字`（触发）与 `名字(`（表达式调用，允许中间隔空白，与
 *    core 的调用判据同一形状）。`?` 条件 / `@算` / 赋值右值里的调用都在词法行的 code 面上，
 *    因此一并数到；台词 / 旁白 / 裸引号 / 注释 / `@原生` 体**不在** code 面上
 *    （`kojo2IsCodeSurface` 单源），名字在正文里出现不算引用。
 * 3. **计数可注入**：K2-REFS 批的 `kojo2-references` 落地后，宿主经
 *    {@link Kojo2CodeLensOptions.countReferences} 把「函数名 + 声明位 + 源文」接进
 *    `kojo2ReferencesAt(source, { line, column })`，剔掉 `kind === 'decl'` 那一条就是同一份
 *    「被用到几处」——「注解上的 N」与「引用面里的 N」由构造同源（接线一行，见回执）。
 *    本模块**不 import** 那份实现（它可能与本批并行落地 / 改签名），缺席时自扫，
 *    注入回调抛错时也退回自扫（注解是只读呈现面，不许被一条腿带崩）。
 *
 * ## 大文件闸（只产前 N 条，与 v1 的「全有或全无」不同，理由要说清）
 *
 * v1 行上注解在 `LARGE_FILE_LINES` 之上**一条都不给**：它的缺席本身携带语义（供方口径是
 * 「证明不了就闭嘴」），让缺席同时表示「额度用完了」会把「没有」变成谎话。
 * 本批的三类注解**不靠缺席表达任何判断**（`# 机` 有几个参数、`@函` 被用到几次都是确定事实），
 * 所以超档时按源码序留**前 N 条**是安全的：读者看到的仍是真话，只是后面那些没画出来。
 * N 写死为 {@link KOJO2_CODE_LENS_LARGE_FILE_LIMIT}——它护的是**渲染预算**（每条注解都是
 * 一个 view zone），不是扫描成本（一次词法 + 一次 token 扫描都是线性的，比 v1 的「parse +
 * 每个定义一次索引查询」便宜一个量级）。界线与 stickyScroll / 面包屑 / v1 注解同一条
 * `LARGE_FILE_LINES`，判在**行数已知之后、产出之后**（截断只裁渲染条数，不裁判定面）。
 *
 * ## 失败面
 *
 * `lex` 在坏输入上不抛（返回诊断），但**纯函数仍自带 try/catch 回 `[]`**：注解是只读呈现面，
 * 一条坏行不该让整篇注解消失，更不该把 editor 的输入链带崩（与 `kojo2-symbols.ts` 同一条
 * 纪律）。provider 另有一层：取文抛错 / 模型已释放 / 翻译层抛错 ⇒ 空列表。
 */
import type * as Monaco from './entry';
import {
  KOJO_DECL_WORDS,
  KOJO_DISPATCH_WORDS,
  KOJO_WEAVE_MODIFIERS,
  isIdentifier,
  isSpaceCode,
  lex,
  splitSpaces,
  type KojoLexLine,
  type LexResult,
} from '@kojo/kojo-core';
import type { EditorSymbolLocation } from '@kojo/plugin-api';
import { LARGE_FILE_LINES } from '../ui/editor-options';
import { isKojo2CutoverEnabled } from '../ui/kojo2-flag';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';
import { kojo2IsCodeSurface } from '@kojo/kojo-lang';

/* ============================== 词形（core 单源） ============================== */

/**
 * 三枚块头的位序（core `tokens.ts` §2.1 / §3.3）。**不是新词表**：每一格都是 core 词表的元素；
 * 本文件不写任何声明词 / 调度词字形。
 */
const MACHINE_WORD = KOJO_DECL_WORDS[2]; // `# 机`
const FUNCTION_WORD = KOJO_DISPATCH_WORDS[8]; // `@函`
const WEAVE_WORD = KOJO_DISPATCH_WORDS[9]; // `@织`

/** `@织` 修饰词集合（core 词表同一份；`includes` 的参数类型不收普通 `string`，故收成 Set） */
const WEAVE_MODIFIER_SET: ReadonlySet<string> = new Set<string>(KOJO_WEAVE_MODIFIERS);

/**
 * 行上注解的点击命令 id：**与 v1 `kojo-code-lens.ts` 的 `CODE_LENS_COMMAND` 同一枚字符串**。
 *
 * 为什么这里不 import 那份常量：那个模块的求值会经 `register-dialects` 拉上 `./languages`
 * （语言表装配面），而本模块是纯逻辑层——一条注解的产出不该取决于语言注册面此刻是否健康
 * （离线工具与单测也会被整张语言表拖住）。同一性由 `tests/kojo2-codelens.test.ts` 的
 * **源码断言**钉住：两处字面量必须逐字相等（不靠 import 把两边绑在一起）。
 */
export const KOJO2_CODE_LENS_COMMAND = 'kojo.codeLens.execute';

/**
 * `@织` 不带修饰词时的层名（源码里没有这个词，故不是 core 词表的一员）。
 * 规范 §8.6 的表格把这一档叫「普通监听 / 普通桶」，注解上取最短的那两个字。
 */
export const KOJO2_CODE_LENS_DEFAULT_WEAVE_LAYER = '普通';

/**
 * 大文件档的产出上限（**只产前 N 条**；见模块头「大文件闸」）。
 *
 * 取 10 而不是 v1 的 200：这一档是「超长文件里省着来的功能」，10 条足够覆盖作者一屏能读到的
 * 那几个挂点 / 函数头；真实语料里 5,000 行以上的 2.0 文件极少，这条线是给未来巨型合并文件
 * 兜底的护栏，不是用来裁剪现成语料的。
 */
export const KOJO2_CODE_LENS_LARGE_FILE_LIMIT = 10;

/* ============================== 公共形状 ============================== */

/** 注解的三种语义（宿主按它决定点击去向；Monaco 的 CodeLens 没有 kind 字段） */
export type Kojo2CodeLensKind = 'events' | 'weave' | 'refs';

/**
 * 点击去向（**additive 判别位**，与 `EditorSymbolLocation` 同一次传出）：
 * - `reveal` = 落到注解所指的那一行（`# 机` / `@织` 的事件名）；
 * - `references` = 打开引用面（`@函` 的名字；宿主可按既有 `editor.action.request`
 *   `{ action: 'references' }` 或 Monaco 的 `editor.action.goToReferences` 落地）。
 */
export type Kojo2CodeLensTargetMode = 'reveal' | 'references';

/** 点击参数：与 v1 行上注解同一条 `editor.revealLocation` 载荷形状 + 一枚 `mode` */
export interface Kojo2CodeLensTarget extends EditorSymbolLocation {
  readonly mode: Kojo2CodeLensTargetMode;
}

/** 注解的命令（Monaco 只渲染带 command 的 CodeLens；`title` 就是屏上那句话） */
export interface Kojo2CodeLensCommand {
  readonly id: string;
  readonly title: string;
  /** 空数组 = 这一条没有可证明的落点（命令处理端判掉，**不给 Monaco 一个假按钮**） */
  readonly arguments: readonly unknown[];
}

/** 1 基半开区间（与 Monaco `IRange` / `kojo2-symbols.ts` 的区间同口径） */
export interface Kojo2CodeLensRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** 一条行上注解（**纯事实**；Monaco 翻译在 {@link toMonacoCodeLenses}） */
export interface Kojo2CodeLens {
  /** 钉在**行尾**的零宽区间（见 {@link rangeAtLineEnd}） */
  readonly range: Kojo2CodeLensRange;
  readonly command: Kojo2CodeLensCommand;
  readonly kind: Kojo2CodeLensKind;
}

/**
 * 引用计数注入位的入参：**函数名 + 它的声明位 + 这一篇源文**。
 *
 * 为什么给位置而不只给名字：同文件引用面的查法是「给一个位置，交回那个符号的全部出现」
 * （`kojo2-references.ts` 的 `kojo2ReferencesAt(source, { line, column })`），宿主拿到
 * `line` / `column` 就能直接问那一份实现，把 `refs` 里 `kind === 'decl'` 的那一条剔掉就是
 * 同一份「被用到几处」——注解的 N 与引用面里的 N 由构造同源，不是两次各自数一遍。
 * 只给名字的话，宿主还得自己再扫一遍文件去猜声明位。
 */
export interface Kojo2CodeLensCountQuery {
  readonly name: string;
  /** 声明行（1 基） */
  readonly line: number;
  /** 名字段首列（1 基；`kojo2ReferencesAt` 要的就是这个位置） */
  readonly column: number;
  /** 这一篇源文（与注解同一份缓冲区快照，不是磁盘内容） */
  readonly source: string;
}

/** 查询选项 */
export interface Kojo2CodeLensOptions {
  /**
   * 这份源文在宿主里的路径（落点要用）。缺席 ⇒ `command.arguments` 为空数组：
   * 点击原地不动，但**也不给 Monaco 一个它不认识的命令**（同 v1 的无落点注解口径）。
   */
  readonly filePath?: string;
  /**
   * 引用计数注入位：`kojo2-references`（K2-REFS）落地后由宿主注入「引用面那一次计算的读数」
   * （见 {@link Kojo2CodeLensCountQuery}，一行就能接上）。
   * 缺席 ⇒ 本模块自扫同文件调用点；抛错 / 回非有限值 ⇒ 退回自扫（一条腿坏了不许让注解整篇消失）。
   */
  readonly countReferences?: (query: Kojo2CodeLensCountQuery) => number;
}

/* ============================== 小工具 ============================== */

/** 空注解表（冻结、可共享） */
const NO_LENSES: readonly Kojo2CodeLens[] = Object.freeze([]);

/** 空计数字典 */
const NO_COUNTS: ReadonlyMap<string, number> = new Map<string, number>();

/**
 * 一段连续名字（与 core `isIdentifier` **同一 Unicode 口径**：先按码位切段，再交给 core 判整段）。
 * 切段只是给 `isIdentifier` 准备候选，不构成第二份「什么算名字」的判据。
 */
const NAME_RUN_RE = /[\p{L}\p{N}_]+/gu;

/** 名字段（`text` + 0 基绝对区间） */
interface NameSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** `# 机` / `@织` 的事件头：事件名 + 事件名之后的词 + 行尾修饰词 */
interface EventHead {
  readonly event: NameSpan;
  readonly args: readonly string[];
  /** `@织` 的修饰词（源码原样、源码序；`# 机` 恒为空） */
  readonly layers: readonly string[];
}

/** 注解事实的中间形态（计数与落点就位前的「头」） */
interface ScannedHead {
  readonly line: number;
  readonly kind: Kojo2CodeLensKind;
  /** `@函` 留空，计数就位后再拼（见 `kojo2CodeLenses` 的产出段） */
  readonly title: string;
  readonly name: string;
  /** 名字段 1 基列（半开尾列） */
  readonly nameStart: number;
  readonly nameEnd: number;
}

/** 一行上的「事件名 + 名字区间」：`# 机` / `@织` 共用（词表位序不同，判定分在调用侧） */
function eventHeadOf(line: KojoLexLine): EventHead | null {
  if (line.kind !== 'decl' && line.kind !== 'dispatch') return null;
  const tokens = splitSpaces(line.rest, line.restOffset);
  const first = tokens[0];
  if (first === undefined || first.text.length === 0) return null;
  // 事件名必须是合法名字：注解只画在能解释的名字上（错误行不产注解，与「坏行不建 AST 节点」
  // 同一条纪律）。`# 机` / `@织` 的核心解析不逐字校验名字，这里补的是一道呈现面闸。
  if (!isIdentifier(first.text)) return null;
  if (line.kind === 'dispatch') {
    // `@织` 的修饰词是**行尾**的连续保留词；它们不能当事件名（§8.6 保留词），
    // 首词就是修饰词 ⇒ 这一行没有可解释的事件头。
    if (WEAVE_MODIFIER_SET.has(first.text)) return null;
    let end = tokens.length;
    const layers: string[] = [];
    while (end > 1) {
      const last = tokens[end - 1]!;
      if (!WEAVE_MODIFIER_SET.has(last.text)) break;
      layers.unshift(last.text);
      end--;
    }
    return {
      event: { text: first.text, start: first.offset, end: first.offset + first.text.length },
      args: tokens.slice(1, end).map((token) => token.text),
      layers,
    };
  }
  return {
    event: { text: first.text, start: first.offset, end: first.offset + first.text.length },
    args: tokens.slice(1).map((token) => token.text),
    layers: [],
  };
}

/** `@函` 的名字段：`(` 之前（没有 `(` 就整段）——与 `kojo2-symbols.ts` / 声明索引同一条算法 */
function functionNameOf(line: KojoLexLine): NameSpan | null {
  if (line.kind !== 'dispatch') return null;
  const rest = line.rest;
  const open = rest.indexOf('(');
  const rawHead = open >= 0 ? rest.slice(0, open) : rest;
  const head = rawHead.trim();
  if (head.length === 0) return null;
  if (!isIdentifier(head)) return null;
  const start = line.restOffset + rawHead.indexOf(head);
  return { text: head, start, end: start + head.length };
}

/** 绝对偏移 → 该行的 1 基列（行首列 = 1；与 Monaco / core 同口径） */
function columnOf(line: KojoLexLine, offset: number): number {
  return offset - line.lineOffset + 1;
}

/**
 * 注解钉在**行尾**的零宽区间。
 *
 * 为什么用行尾而不是 v1 的行首：Monaco 把一条 CodeLens 画在它 `range` 起始行的**行尾**
 * （`codelensWidget.js` 的 `getStartLineNumber`），区间宽度不参与绘制；取行尾让「这条注解
 * 属于这一行」在数据上就成立。列取 `contentEnd`（词法层已去行尾空白与行尾 `续`）：
 * 行尾空白变多不会把注解推走。
 */
function rangeAtLineEnd(line: KojoLexLine): Kojo2CodeLensRange {
  const column = columnOf(line, line.contentEnd);
  return {
    startLine: line.number,
    startColumn: column,
    endLine: line.number,
    endColumn: column,
  };
}

/**
 * token 之后（可隔空白）是否紧跟 `(`——core 的调用判据是「`text.indexOf('(') > 0` 且
 * 括号前是标识符」，允许中间有空白，这里跟着放宽。
 */
function followedByCall(text: string, from: number): boolean {
  let i = from;
  while (i < text.length && isSpaceCode(text.charCodeAt(i))) i++;
  return text.charCodeAt(i) === 0x28; // '('
}

/**
 * 同文件调用点计数（**一次 token 扫描**，不做全文正则）。
 *
 * 计入：`! 名字`（触发行，逐行一次）与 `名字(`（表达式调用）。
 * 不计：注释 / 台词 / 旁白 / 裸引号 / 转义行 / `@原生` 体（`kojo2IsCodeSurface` 单源，
 * 与悬停 / 转定义同一枚判据），以及每条 `@函` 声明**自己的名字段**（`ownNames`）。
 */
function referenceCountsOf(lexed: LexResult, ownNames: ReadonlySet<number>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lexed.lines) {
    if (!kojo2IsCodeSurface(line)) continue;
    const text = line.text;
    for (const match of text.matchAll(NAME_RUN_RE)) {
      const token = match[0];
      if (!isIdentifier(token)) continue; // `310` 这类数字段不是名字
      const start = match.index;
      const absolute = line.contentOffset + start;
      if (ownNames.has(absolute)) continue; // 声明头自己不是「被用到」
      const triggerName = line.kind === 'trigger' && absolute === line.nameOffset;
      if (!triggerName && !followedByCall(text, start + token.length)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return counts;
}

/* ============================== 纯逻辑：注解事实 ============================== */

/**
 * 一篇 2.0 源文 → 行上注解（源码序；**纯函数**，同输入必同输出）。
 *
 * 覆盖三条行型（声明只能在文件顶层 ⇒ 只认 `indent === 0` 的行；块内错写的声明不产注解）：
 * `# 机`、`@织`、`@函`。`@原生` 围栏内的行在词法层就是 `native`，天然不产；
 * 注释 / 叙事 / 表体 / 池体一律不产。
 */
export function kojo2CodeLenses(
  source: string,
  options: Kojo2CodeLensOptions = {},
): readonly Kojo2CodeLens[] {
  if (typeof source !== 'string' || source.length === 0) return NO_LENSES;
  let lexed: LexResult;
  try {
    lexed = lex(source);
  } catch {
    return NO_LENSES; // 坏输入：这一篇没有注解，绝不把异常送进 Monaco
  }

  const heads: ScannedHead[] = [];
  /** `@函` 声明自身名字的绝对偏移（引用扫描要把它排除，免得把声明头算成一次调用） */
  const ownNames = new Set<number>();
  for (const line of lexed.lines) {
    if (line.indent !== 0 || line.invalid) continue;
    if (line.kind === 'decl' && line.known && line.word === MACHINE_WORD) {
      const head = eventHeadOf(line);
      if (head === null) continue;
      heads.push({
        line: line.number,
        kind: 'events',
        title: `事件 ${head.event.text} · 参数 ${head.args.length}`,
        name: head.event.text,
        nameStart: columnOf(line, head.event.start),
        nameEnd: columnOf(line, head.event.end),
      });
      continue;
    }
    if (line.kind === 'dispatch' && line.known && line.word === WEAVE_WORD) {
      const head = eventHeadOf(line);
      if (head === null) continue;
      const layer =
        head.layers.length > 0 ? head.layers.join(' ') : KOJO2_CODE_LENS_DEFAULT_WEAVE_LAYER;
      heads.push({
        line: line.number,
        kind: 'weave',
        title: `监听 ${head.event.text} · ${layer}`,
        name: head.event.text,
        nameStart: columnOf(line, head.event.start),
        nameEnd: columnOf(line, head.event.end),
      });
      continue;
    }
    if (line.kind === 'dispatch' && line.known && line.word === FUNCTION_WORD) {
      const name = functionNameOf(line);
      if (name === null) continue;
      ownNames.add(name.start);
      heads.push({
        line: line.number,
        kind: 'refs',
        title: '', // 计数就位后再拼（见下）
        name: name.text,
        nameStart: columnOf(line, name.start),
        nameEnd: columnOf(line, name.end),
      });
    }
  }

  if (heads.length === 0) return NO_LENSES;
  // 只有真的存在 `@函` 时才付这一趟 token 扫描：纯挂点 / 纯监听文件零额外成本。
  let selfCounts: ReadonlyMap<string, number> = NO_COUNTS;
  if (heads.some((head) => head.kind === 'refs')) {
    try {
      selfCounts = referenceCountsOf(lexed, ownNames);
    } catch {
      selfCounts = NO_COUNTS;
    }
  }

  const filePath = options.filePath;
  const hasFilePath = filePath !== undefined && filePath.length > 0;
  const countReferences = options.countReferences;
  const lenses: Kojo2CodeLens[] = [];
  for (const head of heads) {
    let title = head.title;
    let mode: Kojo2CodeLensTargetMode = 'reveal';
    if (head.kind === 'refs') {
      mode = 'references';
      let count = selfCounts.get(head.name) ?? 0;
      if (countReferences !== undefined) {
        try {
          const injected = countReferences({
            name: head.name,
            line: head.line,
            column: head.nameStart,
            source,
          });
          if (Number.isFinite(injected) && injected >= 0) count = Math.trunc(injected);
        } catch {
          /* 注入腿坏了：退回自扫读数（注解照常出） */
        }
      }
      title = `本文件 ${count} 处用到`;
    }
    lenses.push({
      range: rangeAtLineEnd(lexed.lines[head.line - 1]!),
      command: {
        id: KOJO2_CODE_LENS_COMMAND,
        title,
        // 没有文件身份 ⇒ 空参数（点击原地不动；命令处理端第一行就判掉，不是假按钮）
        arguments: hasFilePath
          ? [
              {
                filePath,
                line: head.line,
                column: head.nameStart,
                span: { columnStart: head.nameStart, columnEnd: head.nameEnd },
                mode,
              } satisfies Kojo2CodeLensTarget,
            ]
          : [],
      },
      kind: head.kind,
    });
  }

  // 大文件档：只产前 N 条（源码序 = heads 的产出序；理由见模块头「大文件闸」）
  if (lexed.lines.length > LARGE_FILE_LINES) {
    return lenses.slice(0, KOJO2_CODE_LENS_LARGE_FILE_LIMIT);
  }
  return lenses;
}

/**
 * 同文件引用计数（**导出仅为可单测**；`@函` 注解用的就是这一趟扫描）。
 *
 * 键 = 名字，值 = 可证明的调用点个数（口径见 {@link referenceCountsOf}）。
 * 与注解**逐字同源**：同样先把每条 `@函` 声明自身的名字段排除掉（否则声明头 `名字(`
 * 会被当成一次调用，注解与引用面就对不上账），因此这里不是「正文里所有 `名字(` 的字典」。
 * 没有 `@函` 的文件照常可用（此时没有要排除的声明头）。
 */
export function kojo2ReferenceCounts(source: string): ReadonlyMap<string, number> {
  if (typeof source !== 'string' || source.length === 0) return NO_COUNTS;
  try {
    const lexed = lex(source);
    const ownNames = new Set<number>();
    for (const line of lexed.lines) {
      if (line.indent !== 0 || line.invalid) continue;
      if (line.kind !== 'dispatch' || !line.known || line.word !== FUNCTION_WORD) continue;
      const name = functionNameOf(line);
      if (name !== null) ownNames.add(name.start);
    }
    return referenceCountsOf(lexed, ownNames);
  } catch {
    return NO_COUNTS;
  }
}

/* ============================== Monaco 翻译层 ============================== */

/**
 * 注解事实 → `monaco.languages.CodeLens`（**唯一**翻译点）。
 *
 * - `id` 逐条唯一（Monaco 的 code lens 缓存按 id 认符号；同一行只可能有一条本模块的注解，
 *   仍带序号：将来同一行多一条时不会互相顶掉）；
 * - `range` 直接换字段名（1 基，数值不动）；
 * - `command.title` 就是屏上那句话；没有落点（`arguments` 为空）也挂同一条命令——
 *   Monaco 只渲染带 command 的注解，给一个不认识的 id 会变成点了弹错通知的假按钮。
 */
export function toMonacoCodeLenses(
  lenses: readonly Kojo2CodeLens[],
): Monaco.languages.CodeLens[] {
  const out: Monaco.languages.CodeLens[] = [];
  for (let i = 0; i < lenses.length; i++) {
    const lens = lenses[i]!;
    out.push({
      id: `k2:${lens.range.startLine}:${i}`,
      range: {
        startLineNumber: lens.range.startLine,
        startColumn: lens.range.startColumn,
        endLineNumber: lens.range.endLine,
        endColumn: lens.range.endColumn,
      },
      command: {
        id: lens.command.id,
        title: lens.command.title,
        arguments: [...lens.command.arguments],
      },
    });
  }
  return out;
}

/* ============================== 安装 ============================== */

/** provider 的注入面（生产走缺省：文件身份取 `model.uri.fsPath`） */
export interface Kojo2CodeLensProviderOptions {
  /** 「这份 model 背后是哪个文件」的注入位；回 `null` / 抛错 ⇒ 退回 `model.uri.fsPath` */
  readonly getFilePath?: (model: Monaco.editor.ITextModel) => string | null;
  /** 引用计数注入位（K2-REFS 落地后由宿主接上；见 {@link Kojo2CodeLensOptions.countReferences}） */
  readonly countReferences?: (query: Kojo2CodeLensCountQuery) => number;
}

/**
 * 安装器交回的句柄：`dispose()` **幂等**；`refresh()` 触发 `onDidChange`（= Monaco 的
 * `onDidChangeCodeLenses` 供给面）。
 *
 * 谁在什么时候调 `refresh()`：Monaco 的 code lens 控制器在**内容变化**时本来就会重问
 * （`codelensController.js` 的 `onDidChangeModelContent → scheduler.schedule()`），所以
 * 宿主**不必**为每一次击键代劳；但「项目 adapter 换了 / 引用面缓存换代了 / 开关热切了」
 * 这些**不改变文本**的时刻它不会问，宿主在这些时刻调一次 `refresh()` 即可。若宿主出于统一
 * 节流策略要在内容变化时显式触发，调它同样是安全的：本模块不挂任何文档监听，也不在这里
 * 缓存任何结果（`refresh()` 只是把「该重取了」这件事通知给 Monaco，取数永远走
 * `provideCodeLenses` 现算）。
 */
export interface Kojo2CodeLensHandle extends Monaco.IDisposable {
  /** 通知 Monaco 重新取注解（内容没变也应重取时由宿主调用；dispose 之后为空操作） */
  refresh(): void;
}

/** flag 关时交回的句柄（调用方照常 `refresh()` / `dispose()`，什么也不会发生） */
const NOOP_HANDLE: Kojo2CodeLensHandle = {
  refresh: () => undefined,
  dispose: () => undefined,
};

/** `provideCodeLenses` 的空结果（每轮新建一个，Monaco 只读） */
function emptyList(): { lenses: Monaco.languages.CodeLens[]; dispose: () => void } {
  return { lenses: [], dispose: () => undefined };
}

/** 文件身份：注入位优先，其次 `model.uri.fsPath`（桩 model 没有 uri ⇒ `undefined`） */
function filePathOfModel(
  model: Monaco.editor.ITextModel,
  getFilePath: Kojo2CodeLensProviderOptions['getFilePath'],
): string | undefined {
  if (getFilePath !== undefined) {
    try {
      const path = getFilePath(model);
      if (typeof path === 'string' && path.length > 0) return path;
    } catch {
      /* 身份取不到：退回 model.uri（下面） */
    }
  }
  const uri = (model as unknown as { uri?: { fsPath?: unknown } }).uri;
  if (
    uri !== null &&
    typeof uri === 'object' &&
    typeof uri.fsPath === 'string' &&
    uri.fsPath.length > 0
  ) {
    return uri.fsPath;
  }
  return undefined;
}

/**
 * 为 `kojo2` 语言注册行上注解 provider，返回**幂等**的句柄。
 *
 * - flag 关 ⇒ 空操作（**零注册**；调用点在宿主 2.0 段，本函数自己也再挡一次，因为它是导出的）；
 * - 只挂 `KOJO2_LANGUAGE_ID`：v1 的 `.kojo` / `.erb` 面由 `kojo-code-lens.ts` 的
 *   `registerForLanguageServices` 挂，两边不重叠；
 * - provider 内任何异常（取文抛错 / 模型已释放 / 纯函数抛错 / 翻译抛错）一律回空列表：
 *   Monaco 把 provider 的 throw 吞成「注解突然没了」，空列表才是它能读出的唯一形状；
 * - 注册失败原样外抛（只有一枚注册，没有半成品要回滚；宿主那侧的「全有或全无」收口
 *   才有机会把同批其余 provider 撤掉）。
 */
export function installKojo2CodeLensProvider(
  monaco: typeof Monaco,
  options: Kojo2CodeLensProviderOptions = {},
): Kojo2CodeLensHandle {
  if (!isKojo2CutoverEnabled()) return NOOP_HANDLE;

  const listeners = new Set<(provider: Monaco.languages.CodeLensProvider) => unknown>();

  const provider: Monaco.languages.CodeLensProvider = {
    // Monaco 的 code lens 控制器订阅这一格（`codelensController.js` 的
    // `provider.onDidChange?.(...)`）；事件载荷按 monaco.d.ts 的 `IEvent<this>` 是 provider 自身。
    onDidChange: (listener) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    provideCodeLenses(model) {
      try {
        if (typeof model.isDisposed === 'function' && model.isDisposed()) return emptyList();
        const source = model.getValue();
        if (typeof source !== 'string') return emptyList();
        const filePath = filePathOfModel(model, options.getFilePath);
        const lenses = kojo2CodeLenses(source, {
          ...(filePath === undefined ? {} : { filePath }),
          ...(options.countReferences === undefined
            ? {}
            : { countReferences: options.countReferences }),
        });
        return { lenses: toMonacoCodeLenses(lenses), dispose: () => undefined };
      } catch {
        // 注解是只读呈现面：出错就「这一篇没有注解」，绝不把编辑器的输入链带崩
        return emptyList();
      }
    },
  };

  const registration = monaco.languages.registerCodeLensProvider(KOJO2_LANGUAGE_ID, provider);

  let disposed = false;
  return {
    refresh() {
      if (disposed) return;
      for (const listener of [...listeners]) {
        try {
          listener(provider);
        } catch {
          /* 宿主监听器抛错不带走别家（同一句注解的重取失败不该影响别的监听） */
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      try {
        registration.dispose();
      } catch {
        /* 幂等 + 不抛：一枚撤不掉不许把卸载链带崩（错误也没有第二个消费者） */
      }
    },
  };
}
