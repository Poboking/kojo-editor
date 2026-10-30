/**
 * Kojo 2.0 **行上注解**（K2-LSP-CODELENS → B3g 搬入本包）：`# 机` 事件挂点、
 * `@织` 监听层、`@函` 引用计数。
 *
 * ## 这一格回答的三个问题（同一篇文档，一次词法扫描）
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
 * ## 为什么判据住包里（B3g，2026-10-30）
 *
 * 本文件原住 `app/src/monaco/kojo2-codelens.ts`，那一份同时住着判据、跨文件计数与 Monaco
 * 注册。B3g 把**判据**整块搬到这里，作答的改为插件 `@kojo/plugin-kojo-lang` 在
 * `ui.editor.languageService` 槽里登记的 `kojo2-codeLens` 贡献；宿主那侧只剩
 * "model → 请求"与"契约 → Monaco"，注册走 `registerForLanguageServices(..., 'codeLens')`。
 * 搬动逐字进行：词形、列口径、大文件闸、失败面一个字符没改（唯一的变化是 import 面与
 * 计数腿，见下）。
 *
 * ## `@函` 的计数口径：**复用引用判据，不写第二把尺子**
 *
 * 计数就是 `kojo2ReferencesAt`（同文件）/ `kojo2ProjectReferencesAt`（带项目快照）的读数
 * 剔掉 `kind === 'decl'` 那一条——「注解上的 N」与「引用面里的 N」由构造同源。
 * 此前宿主那侧另有一份"自扫调用点"的实现（`! 名字` / `名字(`），B3g 连同它的单测口径一起
 * 删掉：两份扫描器对"什么算一处引用"迟早各说一套（注释里的 `名字(`、`@织` 的修饰词、
 * 表体行的端点……）。
 *
 * 范围仍写「本文件」：快照**缺席**时（宿主默认那条路）答案只覆盖这一篇，标题不许冒充
 * 「全项目没人用」；快照在场时标题改说「共 N 处用到」，被截断时如实加「（未看全）」。
 *
 * ## 项目快照（additive）
 *
 * `projectFiles` 与 `projectFilesComplete` 与引用面（`references.ts`）**同一形状、同一口径**：
 * - 缺席 ⇒ 只答本篇（与 B3g 之前逐字相同）；
 * - 在场 ⇒ 先把快照建成一张**临时索引**（`createKojo2ReferenceSnapshotIndex`，建一次、
 *   每个 `@函` 复用），再逐个函数走 `kojo2ProjectReferencesAt`；
 *   快照里**把自己放回第一位**（宿主的快照按约定排除请求文件，而本篇正是声明处——不放回去
 *   索引就"没有声明可归属"，跨文件侧永远是空的），再用 `path` 把本文件从跨文件侧排除；
 *   因此**`path` 是项目级计数的前提**：不知道本篇是谁 ⇒ 退回同文件口径（标题照实说「本文件」）；
 * - `projectFilesComplete === false` ⇒ 照样作答，但标题如实说「未看全」——绝不把不完整
 *   快照当完整项目下"没有别处用到"的结论。
 *
 * ## 大文件闸（只产前 N 条，与 v1 的「全有或全无」不同，理由要说清）
 *
 * v1 行上注解在 `LARGE_FILE_LINES` 之上**一条都不给**：它的缺席本身携带语义（供方口径是
 * 「证明不了就闭嘴」），让缺席同时表示「额度用完了」会把「没有」变成谎话。
 * 本批的三类注解**不靠缺席表达任何判断**（`# 机` 有几个参数、`@函` 被用到几次都是确定事实），
 * 所以超档时按源码序留**前 N 条**是安全的：读者看到的仍是真话，只是后面那些没画出来。
 * N 写死为 {@link KOJO2_CODE_LENS_LARGE_FILE_LIMIT}——它护的是**渲染预算**（每条注解都是
 * 一个 view zone），不是扫描成本（一次词法 + 每个 `@函` 一次引用查询都是线性的）。
 *
 * 行数界线 {@link KOJO2_CODE_LENS_LARGE_FILE_LINES} 与宿主 `ui/editor-options.ts` 的
 * `LARGE_FILE_LINES`（stickyScroll / 面包屑 / v1 注解同一条线）**同值**：包不 import 宿主，
 * 那两处的相等由宿主测试（`kojo2-codelens.test.ts`）钉住。判在**行数已知之后、产出之后**
 * （截断只裁渲染条数，不裁判定面）。
 *
 * ## 失败面
 *
 * `lex` 在坏输入上不抛（返回诊断），但**纯函数仍自带 try/catch 回 `[]`**：注解是只读呈现面，
 * 一条坏行不该让整篇注解消失。引用判据抛错同样只让那一条的计数退回 `0`（注解照常出）——
 * 与"一条腿坏了不许让注解整篇消失"同一条纪律。
 */
import {
  KOJO_DECL_WORDS,
  KOJO_DISPATCH_WORDS,
  KOJO_WEAVE_MODIFIERS,
  isIdentifier,
  lex,
  splitSpaces,
  type KojoLexLine,
  type LexResult,
} from '@kojo/kojo-core';
import {
  createKojo2ReferenceSnapshotIndex,
  kojo2ProjectReferencesAt,
  kojo2ReferencesAt,
  type Kojo2ProjectReferencesResult,
  type Kojo2ReferenceProjectFile,
  type Kojo2ReferenceSite,
} from './references';

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

/**
 * 大文件档的行数界线（**与宿主 `LARGE_FILE_LINES` 同值**，相等由宿主测试钉住）。
 *
 * 为什么这一格在包内另存一个数：包看不见宿主（零 IO、零 app 依赖），而插件是这里的调用方——
 * 它拿不到宿主的 editor-options。同值的证明落在 `packages/app/tests/kojo2-codelens.test.ts`：
 * 两边一旦漂开，作者会看到"同一篇文件在注解上算大文件、在折叠上不算"。
 */
export const KOJO2_CODE_LENS_LARGE_FILE_LINES = 5000;

/* ============================== 公共形状 ============================== */

/** 注解的三种语义（宿主按它决定点击去向；Monaco 的 CodeLens 没有 kind 字段） */
export type Kojo2CodeLensKind = 'events' | 'weave' | 'refs';

/**
 * 点击去向（**判别位**，调用方与落点一起递出去）：
 * - `reveal` = 落到注解所指的那一行（`# 机` / `@织` 的事件名）；
 * - `references` = 打开引用面（`@函` 的名字）。
 */
export type Kojo2CodeLensTargetMode = 'reveal' | 'references';

/**
 * 点击落点：1 基行列 + 名字段的列区间 + 去向判别位。
 *
 * **不含文件路径**：插件侧从请求的 `path` 补（宿主那侧才知道这份 model 是谁）；
 * 判据这一层只回答"落在这一行的哪几列"。
 */
export interface Kojo2CodeLensTarget {
  /** 落点行（1 基） */
  readonly line: number;
  /** 名字段首列（1 基） */
  readonly column: number;
  /** 名字段列区间（1 基、尾列不含；与 `EditorSymbolLocation.span` 同口径） */
  readonly span: { readonly columnStart: number; readonly columnEnd: number };
  readonly mode: Kojo2CodeLensTargetMode;
}

/** 一条行上注解（**纯事实**；Monaco 翻译在宿主） */
export interface Kojo2CodeLens {
  /**
   * 锚点行（1 基，**模型坐标**）。取的是词法层的 `line.number`：行尾空白、行尾 `续`
   * 都不影响它——注解属于那一行，不属于那一行的某个字符。
   */
  readonly line: number;
  /** 屏上那句话（宿主原样显示，不解释、不加工、不截断） */
  readonly title: string;
  readonly kind: Kojo2CodeLensKind;
  /** 点击落点（`arguments` 为空的那一档由调用方按"没有路径"判掉，见插件） */
  readonly target: Kojo2CodeLensTarget;
  /**
   * 计数被截断（快照不全 / 引用面上限命中；只有 `refs` 档会置）。
   * **`title` 已经把这件事写进去了**，这一格留给需要自行分流的调用方（如实、不静默）。
   */
  readonly truncated?: boolean;
}

/** 查询选项（全部 additive：缺席 = 只答本篇，与 B3g 之前逐字相同） */
export interface Kojo2CodeLensOptions {
  /**
   * 本文件路径（项目快照合并时用来**排除自己**；缺席 ⇒ 快照里若含本文件，
   * 本文件的出现点会在跨文件侧再出现一遍，计数偏大）。
   */
  readonly path?: string;
  /** 项目内其他文档的快照（与引用面同一形状；缺席 = 只答本篇） */
  readonly projectFiles?: readonly Kojo2ReferenceProjectFile[];
  /** 快照是否完整（`false` = 宿主少给了，标题如实标「未看全」） */
  readonly projectFilesComplete?: boolean;
  /** 大文件档的行数界线（缺省 {@link KOJO2_CODE_LENS_LARGE_FILE_LINES}；只为可单测） */
  readonly largeFileLines?: number;
}

/* ============================== 小工具 ============================== */

/** 空注解表（冻结、可共享） */
const NO_LENSES: readonly Kojo2CodeLens[] = Object.freeze([]);

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

/**
 * 一行上的「事件名 + 名字区间」：`# 机` / `@织` 共用（词表位序不同，判定分在调用侧）。
 *
 * 事件名的取法与 `event-sites.ts` **同一个 core 调用**（`splitSpaces(line.rest, line.restOffset)[0]`，
 * 与 core parser 取事件名的那一行逐字相同）；本函数额外要的两件事是注解自己的判据：
 * 名字必须是合法标识符（错误行不产注解），以及 `@织` 的行尾修饰词（层）。
 */
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

/** `@函` 的名字段：`(` 之前（没有 `(` 就整段）——与声明索引同一条算法 */
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

/* ============================== 计数（引用判据单源） ============================== */

/** 一个 `@函` 名字处的计数读数 */
interface RefCount {
  readonly count: number;
  readonly truncated: boolean;
}

/** 非声明位的出现点条数（`decl` 是这条符号自己的名字段，不算"被用到"） */
function countOfSites(sites: readonly Kojo2ReferenceSite[]): number {
  let count = 0;
  for (const site of sites) if (site.kind !== 'decl') count += 1;
  return count;
}

/** 项目合并结果的读数：同一条口径（`refs` 是"声明位在前"的合并视图，剔掉 `decl` 即被用到的次数） */
function countOfProjectResult(result: Kojo2ProjectReferencesResult): RefCount {
  let count = 0;
  for (const site of result.refs) if (site.kind !== 'decl') count += 1;
  return { count, truncated: result.truncated };
}

/**
 * 问一次引用判据：`index === null` 走同文件（`kojo2ReferencesAt`），否则走项目合并
 * （`kojo2ProjectReferencesAt`，索引是快照建的那张临时表）。
 *
 * 返回 `null` = 这个位置没有可归属符号（注解上写 0——"这一处没有可证调用"是事实）。
 * 两条腿的抛错都在调用侧吞掉（见模块头「失败面」）。
 */
function refCountAt(
  source: string,
  position: { readonly line: number; readonly column: number },
  index: ReturnType<typeof createKojo2ReferenceSnapshotIndex> | null,
  path: string | undefined,
): RefCount | null {
  if (index === null) {
    const result = kojo2ReferencesAt(source, position);
    if (result === null) return null;
    return { count: countOfSites(result.refs), truncated: result.truncated };
  }
  const result = kojo2ProjectReferencesAt(
    source,
    position,
    index,
    // `path` 缺席 ⇒ 不排除本文件（计数可能偏大，调用方负责给路径）；
    // 声明种类与名字的归属仍由同一条判据回答。
    path === undefined ? {} : { path },
  );
  if (result === null) return null;
  return countOfProjectResult(result);
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
    return NO_LENSES; // 坏输入：这一篇没有注解，绝不把异常送进调用方
  }

  const heads: ScannedHead[] = [];
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

  // 只有真的存在 `@函` 时才付这一趟：纯挂点 / 纯监听文件零额外成本。
  const hasRefs = heads.some((head) => head.kind === 'refs');
  const path = options.path;
  const pathOf = path !== undefined && path.length > 0 ? path : undefined;
  const projectFiles = options.projectFiles;
  /**
   * 项目级计数只在这两条同时成立时开：有快照、**且知道本篇是谁**。
   *
   * 为什么必须有路径：快照索引的 `refsOf` 只认"名字 + 种类**在快照里被声明过**"的符号
   * （没有声明就没有归属，见 `references.ts` 的 `declared` 门）。本文件正是那个声明处，
   * 而宿主的快照**按约定排除请求文件**——所以这里要把自己放回快照第一位（与
   * `@kojo/plugin-kojo-lang` 的引用供方同一条纪律），再用 `path` 把它从**跨文件侧**排除，
   * 免得本文件的出现点被数两遍。不知道路径就放不回去 ⇒ 退回同文件口径（标题照实说「本文件」）。
   */
  const projectMode = projectFiles !== undefined && projectFiles.length > 0 && pathOf !== undefined;
  /** 快照只建**一次**：每个 `@函` 复用同一张临时索引（判据同源，代价不随函数数翻倍） */
  let index: ReturnType<typeof createKojo2ReferenceSnapshotIndex> | null = null;
  if (hasRefs && projectMode) {
    try {
      index = createKojo2ReferenceSnapshotIndex([
        { path: pathOf, text: source },
        ...(projectFiles ?? []),
      ]);
    } catch {
      index = null; // 快照建不起来 ⇒ 退回同文件（与快照缺席同一档）
    }
  }
  const snapshotIncomplete = index !== null && options.projectFilesComplete === false;

  const lenses: Kojo2CodeLens[] = [];
  for (const head of heads) {
    let title = head.title;
    let mode: Kojo2CodeLensTargetMode = 'reveal';
    let truncated = false;
    if (head.kind === 'refs') {
      mode = 'references';
      let count = 0;
      let cut = false;
      try {
        const read = refCountAt(
          source,
          { line: head.line, column: head.nameStart },
          index,
          pathOf,
        );
        if (read !== null) {
          count = read.count;
          cut = read.truncated;
        }
      } catch {
        /* 引用判据抛错：这一条写 0（注解照常出，别让一条腿把整篇带走） */
      }
      truncated = cut || snapshotIncomplete;
      if (index === null) {
        // 快照缺席：范围只到本文件，标题不许冒充「全项目没人用」。
        title = `本文件 ${count} 处用到`;
      } else {
        title = truncated ? `共 ${count} 处用到（未看全）` : `共 ${count} 处用到`;
      }
    }
    lenses.push({
      line: head.line,
      title,
      kind: head.kind,
      target: {
        line: head.line,
        column: head.nameStart,
        span: { columnStart: head.nameStart, columnEnd: head.nameEnd },
        mode,
      },
      ...(truncated ? { truncated: true } : {}),
    });
  }

  // 大文件档：只产前 N 条（源码序 = heads 的产出序；理由见模块头「大文件闸」）
  const lineLimit = options.largeFileLines ?? KOJO2_CODE_LENS_LARGE_FILE_LINES;
  if (lexed.lines.length > lineLimit) {
    return lenses.slice(0, KOJO2_CODE_LENS_LARGE_FILE_LIMIT);
  }
  return lenses;
}
