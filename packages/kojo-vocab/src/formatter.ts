/**
 * 文档格式化（`Shift+Alt+F`）核心 —— **纯函数**：文本进、行级 edits 出。
 * 零 IO、零 Monaco、零内核依赖；宿主侧（`packages/app/src/monaco/kojo-format.ts`）
 * 只做 Monaco 协议翻译，E2「保存时格式化」也复用这同一份规则（不许有第二真源）。
 *
 * ## 为什么住 `kojo-sugar` 而不是 kernel / 契约层
 *
 * 缩进对 `.kojo` 是语法的一部分，而层级的唯一算法是这里的 `indentLevel`
 * （TAB = 1 级、`U+3000` = 2 空格、空格 = `ceil(n/4)`）与行分类的 `classifyLine`
 * /`inlineCommentIndex`。格式化若不在同一层实现，就必然要抄一份判据——抄的那刻起
 * "改缩进不改语义"这个保证就没了。ERB 形与 `.kojo` 共用同一份规则面，只是缩进来源
 * 不同：`.kojo` 的层级是语法（词法器算），ERB 的层级按**现有配对**排（S11）——
 * 所以两种方言放同一个模块，而不是拆到 `erb-parser` 去各写一遍。
 *
 * ## 三条规则与它们的边界（取舍都写在这，改动前先读）
 *
 * 1. **全角空格 `U+3000` → 半角**：只动两处**空白身份明确**的位置——
 *    行首缩进（折成 **2 个**半角空格，因为 `indentLevel` 把 `U+3000` 记作 2 空格，
 *    折 1 个就是把层级改小 = 改语义）与**注释区**（折成 1 个半角空格，与既有
 *    「替换为半角并保存」那条处置逐字同口径）。
 *    **正文/台词/字符串里的 `U+3000` 一律不动**：eraTW 4.980 全量实测 55,565 行含
 *    `U+3000` 者**全部是行中用途**（注释分隔与 `PRINTFORMW 　「…」` 的台词缩进），
 *    那是作者要的排版、且会原样打印给玩家——一刀切替换就是把内容改了。
 * 2. **缩进**（`.kojo` 只动糖行，`.erb` 按现有配对排块层级）：`.kojo` 把行首空白重排成
 *    `<单位> × indentLevel(原行首空白)` —— 层级由转译器算出、再按同一函数折回，
 *    **可证不变**（`indentLevel(新缩进) === indentLevel(旧缩进)`），所以它只统一
 *    写法、不动结构。单位在文件内探测（TAB 或 4 空格，取占多数的一方）；
 *    探测不出（无缩进行 / 平局 / 全是 2 空格这类"层级本就判不准"的写法）就**整条规则关掉**。
 *    **ERB 形（S11）**：按**现有配对**排块层级——开块行 d / 块体 d+1 / 分支行 d+1 /
 *    分支体 d+2 / 闭合行 d（与 `app/src/monaco/erb-enter.ts` 的回车档位同一份读数）。
 *    词表镜像 `erb-parser/scanner.ts`（插件间禁交叉 import）；顶层行与 `@`/`#`/`$`
 *    指令行、注释行、`@"…"` 续行保留原缩进，块体/死区整行不碰，单位与判准门槛同上。
 *    `.kojo` 里的原生直通行（`rawLine`）不参与归一：那一段要整理请直接走 ERB 形。
 *    `.kojo` 里的 `@` 原生块（`rawBlockStart` 起，延续到下一个 `@` 行或文件尾）
 *    **整块一个字符都不动** —— 那里的每一行逐字节进产物，"改了也不进产物"这条放行前提
 *    在块内不成立。
 * 3. **行尾**：编辑**永不跨物理行**（每条 edit 落在同一行内），换行符原样保留，
 *    混合行尾也原样保留 —— 既不会把 LF 变成 CRLF，也不会把 CRLF 变成 LF。
 *
 * 一句话放行判据：**只动"空白身份明确"的位置**——行首缩进、纯空白行、注释区，
 * 且**不在块体内**：ERB 形的数据表块体与停用死区由 `erbBodyLineMask` 整行划出放行面外
 * （那里的行是正文/死区而非代码，动了就是改内容）。
 * 台词正文与引号内的值是打印给玩家的字符 ⇒ 一个都不动；`@` 原生块逐行进产物 ⇒ 整块不动。
 * 唯一被允许的产物空白差 = 糖区**注释文本**里的全角空格折算（注释行会原样落进产物注释），
 * 产物里可打印的字符一个不许变 —— 由 `tests/formatter.invariants.test.ts` 的
 * "逐行折叠空白后相等 + 无全角样例逐字节相等"两条一起钉住。
 *
 * ## 规则可逐条关（P2-14「格式化规则零可配置」）
 *
 * `computeFormatEdits` / `formatText` 收一个 **additive** 选项参 `FormatRuleOptions`：
 * 两条规则各有一个布尔开关，**缺省全开 ⇒ 与加选项之前逐字等价**（既有调用方与既有
 * 测试零改动）。设置页的两个开关（`packages/app/src/ui/format-pref.ts`）经宿主
 * （`packages/app/src/monaco/kojo-format.ts`）传到这里；E2「保存时格式化」同样
 * 落盘前现读同一份开关（`applyFormatOnSave` 的 `rules` 参）——缺省全开 ⇒ 老用户
 * 零感知，显式关掉某条的作者在手动与保存两条路上拿到**同一个**口径。
 *
 * 关 `fullWidthSpace` 的语义是"**U+3000 原样保留**"（不是"少折一处"）：
 * 行首缩进与注释区的 U+3000 都不折；仅含 U+3000 的空白行也不再清空（半角空白行
 * 照旧清空——那不是全角问题）；含 U+3000 的缩进同时排除出「缩进归一」的重排
 * （否则归一会把 U+3000 按层级抹掉，"保留"就成了空话）。
 * 关 `indent` 的语义是"**行首空白写法不动**"：`.kojo` 糖行的单位×层级重排与
 * `.erb` 的块层级重排都归这条管；关了 ⇒ 只剩全角折算。
 *
 * ## 明确不做（与结构修复 `erb-structure-fix` 划界）
 *
 * 不补 `ENDIF`、不修结构（ERB 缩进只照**现有**配对排，不改配对结果）、不动行尾空白
 * （台词行尾的 `U+3000` 是要打印的字）、
 * 不碰折行（`\` 续接）涉及的任何物理行、不改编码。判不准的一律不动：
 * 格式化产出 0 条 edit 是**正常结果**，不是失败。
 */

import { FULLWIDTH_SPACE } from '@kojo/plugin-api';
import {
  classifyLine,
  inlineCommentIndex,
  splitLogicalLines,
  type LineClass,
  type LogicalLine,
} from './lexer';
// 行首缩进 / 纯空白行的字符集唯一真源（CHARSET-SS 批）：此前这里是 `isIndentChar` 的第三份
// 手写字符比较；现在与 lexer / sugar-ident 同一张表，同一行在三处必然同判。
import { isAllBlank, leadingBlank } from './blank-charset';

/** 方言：`kojo` = 表层 DSL（缩进是语法）；`erb` = 原生脚本（缩进只是排版） */
export type FormatDialect = 'erb' | 'kojo';

/**
 * 一条行内替换（1 基行号；列按 UTF-16 码元，`endColumn` 不含端点 —— 与 Monaco
 * `Range` 的列语义逐字一致，宿主据此直翻成 `DocumentFormattingEdit`）。
 */
export interface FormatEdit {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  /** 替换进来的文本（不含行尾） */
  readonly text: string;
}

/** 一个缩进层级 = 4 个半角空格（`indentLevel` 的折算基：`ceil(空格数 / 4)`；`enter.ts` 的回车追加单位与它同源） */
export const SPACE_UNIT = '    ';
/** 一个缩进层级 = 1 个 TAB（同上） */
export const TAB_UNIT = '\t';

/**
 * 规则开关（P2-14，additive）：两条规则各一个布尔，`undefined` / `true` = 开。
 *
 * 形状是**结构相容**的最小面：宿主侧（`packages/app/src/ui/format-pref.ts` 的
 * `FormatRules`）按同一字段名传参，不需要反向 import 本类型——插件公共面
 * （`src/index.ts` 的 exports 清单）本批冻结，不新增导出。
 */
export interface FormatRuleOptions {
  /**
   * 全角空格折算：行首缩进的 `U+3000` → 2 个半角空格、注释区的 `U+3000` → 1 个半角
   * 空格；连带「仅含 U+3000 的空白行清空」也归这条管。关 ⇒ U+3000 原样保留。
   */
  readonly fullWidthSpace?: boolean;
  /**
   * 缩进：`.kojo` 糖行按探测单位 × 层级重排；`.erb` 按现有配对排块层级。
   * 关 ⇒ 行首空白写法一个字符都不动（只剩全角折算）。
   */
  readonly indent?: boolean;
}

/** 解析后的规则（两个布尔都落地，缺省 = 全开） */
interface ResolvedRules {
  readonly fullWidthSpace: boolean;
  readonly indent: boolean;
}

/** `!== false` ⇒ 开：显式传 `true` 与不传同义（additive 的口径） */
function resolveRules(options: FormatRuleOptions | undefined): ResolvedRules {
  return {
    fullWidthSpace: options?.fullWidthSpace !== false,
    indent: options?.indent !== false,
  };
}

/**
 * 不做行内注释剥离、也不进缩进探测的行类。
 * 判据逐字来自 `classifyLine`：`text` / `heartText` 是台词与心形行（`;` 是要打印的字符）、
 * `rawLine` 是 ERB 原文（inline `;` 的语义在那边另有一套，判不准就不动）、
 * `comment` 整行都是注释、`blank` 无内容、`rawBlockStart` 走原生块通路，
 * `skipStart` / `skipEnd` 是停用区的成对标记——块体逐字节进产物，标记行自身也在区内。
 */
const NO_INLINE_COMMENT = new Set<LineClass['kind']>([
  'blank',
  'comment',
  'rawLine',
  'rawBlockStart',
  'skipStart',
  'skipEnd',
  'text',
  'heartText',
]);

/** 物理行：内容与**它自己的行尾**（`eol` 为空 = 文件最后一行） */
interface PhysicalLine {
  content: string;
  readonly eol: string;
}

function splitPhysical(text: string): PhysicalLine[] {
  const out: PhysicalLine[] = [];
  const re = /\r\n|\r|\n/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ content: text.slice(last, m.index), eol: m[0] });
    last = m.index + m[0].length;
  }
  out.push({ content: text.slice(last), eol: '' });
  return out;
}

/** 整行都是空白（含全角）——`U+3000` 独占行与 `' '` 独占行同判；字符集见 `blank-charset.ts` */
function isAllIndent(content: string): boolean {
  return isAllBlank(content);
}

/** 注释 / 文本区：全角空格 → 一个半角空格（与 `EditorPane` 既有的「替换为半角并保存」同口径） */
function halfwidthInText(s: string): string {
  return s.includes(FULLWIDTH_SPACE) ? s.split(FULLWIDTH_SPACE).join(' ') : s;
}

/** 行首缩进：全角空格 → **两个**半角空格（`indentLevel` 记 U+3000 为 2 空格 ⇒ 层级不变、宽度不变） */
function halfwidthInIndent(s: string): string {
  return s.includes(FULLWIDTH_SPACE) ? s.split(FULLWIDTH_SPACE).join('  ') : s;
}

/* ========================= ERB 块上下文（正文不是代码的两类区） =========================
 *
 * 形态清单取**引擎记号事实**（本包 `sugar-ident.ts` `CONTROL_SHAPES` 里 `open:'data'` 一族：
 * `PRINTDATA` 九变体 + `STRDATA`，收束同为 `ENDDATA`；停用区 `SKIPSTART`/`SKIPEND` 按
 * `erb-parser/scanner.ts` 同口径的 trimmed **严格等值**，大小写/带尾别名一概不认）——不自造。
 * 开词/收束允许带尾（实据：`PRINTDATAL LOCAL`、`STRDATA 台词`、尾注释；只认裸词会漏护整块块体）。
 *
 * 判据保守：**拿不准是不是正文区就不动这一行**。开词后到配对收束前的一切行都算块体
 * （含空行/注释/分组记号）；到文件尾仍未收束 ⇒ 其后全按块体（宁可少格式化，不多改字节）。
 * 开词行与收束行本身是结构行（逐字节比对与语料实测都确认其空白是排版），不在块体内。
 * 停用区优先于数据表（与 scanner.ts 检查序一致）：区内的一切行都只找 `[SKIPEND]`。
 *
 * 语料实测（基线盘 ERB 索引根 3,818 份 / 4,115,008 行，2026-10-19 用**内核解码路径**
 * `decodeWithProbe` + 本模块的 `erbBodyLineMask` 复算，探针跑完即删）：保护区段 6,060 段
 * （数据表 3,874 / 停用区 2,186）/ 受保护行 119,074；逐行规则今天会改 19,975 行，其中
 * **1,290 行落在块体/死区**＝停用区 1,264 · 数据表体 26，按形状分：纯空白清空 1,036 ·
 * 注释折算 151 · 全角缩进折半 103 · 其它 0。本状态机把这 1,290 行全部退回"一个字节不动"。
 * （全根 4,385 份的同口径读数是 1,473 = 停用区 1,447 · 数据表 26；两份差在文件集，不差判据。）
 *
 * **导出面**：`erbBodyLineMask` 供不变量闸复用；`erbBodyRegionAtLineEnd` 供宿主的窗口取文腿
 * 复用（那条腿只拿到切片文本，必须问"切片起点之上有没有还没收束的区"才谈得上同判据）。
 * 两者是 `scanErbBody` **同一趟扫描**的两个投影——这里不允许第二份块状态。
 */

/** 被保护区间属于哪一族：`data` = 数据表块体，`skip` = 停用死区 */
export type ErbBodyRegionKind = 'data' | 'skip';

/**
 * 一段连续被保护的行（**极大区段**）。`start`/`end` 是 0 基、含端点的**被保护行**下标；
 * `open` 是**区首标记行**（开词 / `[SKIPSTART]`）自己的下标——它本身不挨保护（结构行），
 * 但窗口腿要从它起喂才谈得上"进入状态机时状态为区外"，嵌套时这里给的是**最外层**那个标记行。
 */
export interface ErbBodyRegion {
  readonly kind: ErbBodyRegionKind;
  readonly open: number;
  readonly start: number;
  readonly end: number;
}

/** 数据表开词（`PRINTDATA` 九变体与 `STRDATA`；可带参数或尾注释） */
const ERB_DATA_OPEN_RE = /^(?:PRINTDATA[A-Z]*|STRDATA)(?:[ \t;]|$)/;
/** 数据表收束（同为 `ENDDATA`；可带尾注释） */
const ERB_DATA_CLOSE_RE = /^ENDDATA(?:[ \t;]|$)/;

/**
 * 块状态机的状态（**只有这三个字段**：一族在区里、另一族的深度、以及当前区的区首行）。
 * 导出给预筛与窗口探针共用；`open` = 当前所在保护区**最外层标记行**的 0 基下标，区外 = -1。
 */
interface ErbBodyScanState {
  dataDepth: number;
  inSkip: boolean;
  open: number;
}

/**
 * "这一行**有可能**是块标记"的预筛（不是第二份判据——它只可能放过，不可能认错）。
 *
 * 三族标记去缩进后必然以 `P`（`PRINTDATA*`）、`S`（`STRDATA`）、`E`（`ENDDATA`）、`[`
 * （`[SKIPSTART]`/`[SKIPEND]`）起头，而 `String.prototype.trim()` 剥掉的正是下面这个集合
 * （ECMA-262 `WhiteSpace` + `LineTerminator`，逐条列出：ASCII 空白、NBSP、OGHAM、EN QUAD…EM SP、
 * NARROW NBSP、MEDIUM SP、IDEOGRAPHIC SP、ZWNBSP、全角空格）。所以"行首（跳过这段空白之后）不是
 * 这四个字符之一"⇒ 该行 `trim()` 后也不可能是标记 ⇒ 状态机可以整行跳过。
 * 认不全的空白字符只会让预筛**更宽**（多跑一次 `trim`），不会漏判 ⇒ 判据仍然只住在 `erbBodyStep`。
 */
const ERB_CANDIDATE_HEAD_RE = /^[ \t\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*[PSE[]/;

/**
 * 唯一一处块状态机：消费一行，返回"这一行是不是正文区行"与新状态。
 *
 * `state.open` 恒等于**当前所在保护区最外层标记行**的下标（区外 = -1）：窗口腿从它起喂文本时，
 * 状态机进入的那一格必然与整篇一致。入参 `t` 必须是该行 `trim()` 后的文本，`index` 是它的 0 基行号。
 *
 * 判序（与 `erb-parser/scanner.ts` 一致）：停用区优先 ⇒ 区内只认 `[SKIPEND]`；
 * 再看数据表深度 ⇒ 体内只认开/收；两者都在区外才允许开区。
 */
function erbBodyStep(state: ErbBodyScanState, t: string, index: number): boolean {
  if (state.inSkip) {
    // 区内一切行都是死区正文；`[SKIPEND]` 标记行本身是结构行，不在其中
    if (t === '[SKIPEND]') {
      state.inSkip = false;
      state.open = -1;
      return false;
    }
    return true;
  }
  if (state.dataDepth > 0) {
    if (ERB_DATA_OPEN_RE.test(t)) {
      state.dataDepth++;
      return true;
    }
    if (ERB_DATA_CLOSE_RE.test(t)) {
      // 收束行本身是结构行（**含嵌套层的收束**：深度 2→1 时这一行也照旧不掩）
      state.dataDepth--;
      if (state.dataDepth === 0) state.open = -1;
      return false;
    }
    return true;
  }
  if (t === '[SKIPSTART]') {
    state.inSkip = true;
    state.open = index;
  } else if (ERB_DATA_OPEN_RE.test(t)) {
    state.dataDepth = 1;
    state.open = index;
  }
  return false;
}

/** 一趟扫描的三份产物（同一台状态机，禁止第二份实现） */
interface ErbBodyScan {
  /** 每行是否"正文区行"（块体或死区）；与入参等长 */
  readonly mask: boolean[];
  /** 连续保护区的极大区段（含区首标记行下标与族别） */
  readonly regions: ErbBodyRegion[];
  /** 走完全部入参行之后**留在哪儿**：`open` = 最外层区首行下标（区外 = -1） */
  readonly state: ErbBodyScanState;
}

function scanErbBody(lines: readonly string[]): ErbBodyScan {
  const mask = new Array<boolean>(lines.length).fill(false);
  const regions: ErbBodyRegion[] = [];
  const state: ErbBodyScanState = { dataDepth: 0, inSkip: false, open: -1 };
  /** 正在积累的保护区段（-1 = 段外）；`runKind` 由段内第一行决定（两族不可能混在一段里） */
  let runStart = -1;
  let runKind: ErbBodyRegionKind = 'data';
  let runOpen = -1;
  const closeRun = (endExclusive: number): void => {
    if (runStart >= 0) regions.push({ kind: runKind, open: runOpen, start: runStart, end: endExclusive - 1 });
    runStart = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    // 区外 + 这一行不可能是任何标记 ⇒ 状态不动、掩码恒假（预筛只可能放过，不可能认错）
    if (state.open < 0 && !ERB_CANDIDATE_HEAD_RE.test(raw)) continue;
    const body = erbBodyStep(state, raw.trim(), i);
    mask[i] = body;
    if (body) {
      if (runStart < 0) {
        runStart = i;
        runKind = state.inSkip ? 'skip' : 'data';
        runOpen = state.open;
      }
    } else {
      closeRun(i);
    }
  }
  closeRun(lines.length); // 未收束到 EOF ⇒ 其后全按块体（保守）
  return { mask, regions, state };
}

/** 每行是否"正文区行"（块体或死区）；与入参等长。导出面仅测试与包内复用，不进插件公共清单 */
export function erbBodyLineMask(lines: readonly string[]): boolean[] {
  return scanErbBody(lines).mask;
}

/** 连续保护区段清单（同一趟扫描的另一种投影；导出面同上） */
export function erbBodyRegions(lines: readonly string[]): ErbBodyRegion[] {
  return scanErbBody(lines).regions;
}

/**
 * "喂进 `prefixText` 之后状态机停在哪"——窗口取文腿唯一的补判据（宿主 `monaco/kojo-format-range.ts`）。
 *
 * 为什么必须有它：切片文本从窗口第一行进状态机，**起点落在块体/死区中间时切片里看不见开词**，
 * 于是判成区外、把整篇腿明确保护的字节改了。宿主拿窗口之前的那段原文来问，才拿到与整篇同一份末态。
 *
 * 返回的 `openLine` 是**最外层**区首标记行（1 基，落在 `prefixText` 自己的行号坐标里）：
 * 从它开始喂，进入状态机的状态才是"区外"，区段轨迹才与整篇逐字重合。
 * `null` = 前缀喂完停在区外 ⇒ 切片判据与整篇腿**可证等价**，不必再取文。
 *
 * 行号坐标系：入参必须是**从整篇第 1 行起**的前缀（宿主那条 `resolveRange(model, 1, startLine - 1)`），
 * 否则 `openLine` 没有意义——这一点由调用方守住，本函数不认识"整篇"这个概念。
 *
 * 这条腿每击键都要跑，所以它**不物化行数组**：按 `splitPhysical` 同一条行尾正则逐行走，
 * 每行先过 {@link ERB_CANDIDATE_HEAD_RE} 预筛。预筛的收益是算得出的：基线盘 ERB 索引根
 * 3,818 份 / 4,115,008 行里区段共 6,060 段 ⇒ 标记行最多 2×6,060 = 12,120 行（0.29%），
 * 其余 99.7% 的行连 `trim()` 都不必做。判据本身仍只在 {@link erbBodyStep} 一处。
 */
export function erbBodyRegionAtLineEnd(prefixText: string): { kind: ErbBodyRegionKind; openLine: number } | null {
  const state: ErbBodyScanState = { dataDepth: 0, inSkip: false, open: -1 };
  const re = /\r\n|\r|\n/g;
  let last = 0;
  let index = 0;
  let matched: RegExpExecArray | null;
  const feed = (raw: string): void => {
    if (state.open < 0 && !ERB_CANDIDATE_HEAD_RE.test(raw)) return;
    erbBodyStep(state, raw.trim(), index);
  };
  while ((matched = re.exec(prefixText)) !== null) {
    feed(prefixText.slice(last, matched.index));
    last = matched.index + matched[0].length;
    index++;
  }
  feed(prefixText.slice(last));
  if (state.open < 0) return null;
  return { kind: state.inSkip ? 'skip' : 'data', openLine: state.open + 1 };
}

/* ============================== ERB 块层级缩进（S11） ==============================
 *
 * `.kojo` 的层级是语法、由词法器算；ERB 的缩进没有语法作用，这里按**现有配对**排出
 * 可读层级（不补、不拆、不报错——结构修复是 `erb-structure-fix` 的活）。
 *
 * 词表取 `erb-parser/scanner.ts` 配对表的**镜像**：插件之间不许交叉 import（audit C），
 * 只能在本包再写一张；增删词必须两边对拍。数据表族（`PRINTDATA*` / `STRDATA` /
 * `DATALIST` / `ENDDATA` / `ENDLIST`）**不进这张表**：它们的块体由 `erbBodyLineMask`
 * 整行保护、不参与缩进，记号行按普通行排在当前块体层；若让开词压栈，被掩掉的嵌套
 * 开词会让闭合行错配。
 *
 * 排版口径量自真实语料（与 `app/src/monaco/erb-enter.ts` 的回车档位同一份读数）：
 *   开块行 d · 块体 d+1 · 分支行 d+1 · 分支体 d+2 · 闭合行 d
 * 顶层行（d = 0）保持原缩进：真语料的函数体是顶格的，强行抬一级会把每份文件都改写
 * 一遍；注释、`#` / `$` 指令、`@` 函数头与 `@"…"` 续行同样只保留原缩进。
 * 单位继续"探测不出就不动"——没有 TAB / 4 空格缩进行 ⇒ 整条规则关掉（与 `.kojo`
 * 同一门槛，也是宿主"窗口腿 = 整篇腿"在切片起点处的既有前提）。
 */

/** 开块 → 配对类别（`erb-parser/scanner.ts` 开块表的镜像；TRY 两档同口径） */
const ERB_INDENT_OPEN: Readonly<Record<string, string>> = {
  IF: 'if',
  SELECTCASE: 'select',
  FOR: 'for',
  WHILE: 'while',
  REPEAT: 'repeat',
  DO: 'do',
  NOSKIP: 'noskip',
  TRYCGOTO: 'try',
  TRYCJUMP: 'try',
  TRYCCALL: 'try',
  TRYCGOTOFORM: 'try',
  TRYCJUMPFORM: 'try',
  TRYCCALLFORM: 'try',
  TRYCALLLIST: 'funclist',
  TRYGOTOLIST: 'funclist',
  TRYJUMPLIST: 'funclist',
};

/** 分支 → 它所在块的类别（分支自己不开块，兄弟分支同层） */
const ERB_INDENT_BRANCH: Readonly<Record<string, string>> = {
  ELSEIF: 'if',
  ELSE: 'if',
  CASE: 'select',
  CASEELSE: 'select',
  CATCH: 'try',
};

/** 闭合 → 它所闭合的类别（与开块表成对；孤儿闭合按普通行排） */
const ERB_INDENT_CLOSE: Readonly<Record<string, string>> = {
  ENDIF: 'if',
  ENDSELECT: 'select',
  NEXT: 'for',
  WEND: 'while',
  REND: 'repeat',
  LOOP: 'do',
  ENDNOSKIP: 'noskip',
  ENDCATCH: 'try',
  ENDFUNC: 'funclist',
};

/** `@` 函数定义行（`@"…"` 是跨行 CALL 的续行，不是边界——与 `structure.ts` 的判据一致） */
const ERB_FUNCTION_HEADER_RE = /^@(?![ \t\u3000]*")/;

/** 一个已开块：开块行**自己的**缩进（绝对串）与"是否已出现过分支行" */
interface ErbIndentFrame {
  readonly pair: string;
  readonly indent: string;
  branch: boolean;
}

/** 栈顶向下找最近一个同类块；-1 = 没有（与 scanner 的配对序一致） */
function findErbFrame(stack: readonly ErbIndentFrame[], pair: string): number {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.pair === pair) return i;
  return -1;
}

/**
 * 探测 ERB 的缩进单位：只在**非保护行、有缩进**的行里数 TAB / 4 空格。
 * 平局或一方都没有 ⇒ `null` = 判不准 ⇒ 整条规则关掉（同 `.kojo`）。
 */
function detectErbIndentUnit(lines: readonly string[], body: readonly boolean[]): string | null {
  let tabs = 0;
  let spaces = 0;
  for (let i = 0; i < lines.length; i++) {
    if (body[i]) continue;
    const content = lines[i]!;
    const indent = leadingBlank(content);
    // 纯空白行不是"单位证据"：它的空白身份归空白规则管
    if (indent.length === 0 || content.length === indent.length) continue;
    if (/^\t+$/.test(indent)) tabs++;
    else if (/^ +$/.test(indent) && indent.length % SPACE_UNIT.length === 0) spaces++;
  }
  if (tabs === spaces) return null;
  return tabs > spaces ? TAB_UNIT : SPACE_UNIT;
}

/**
 * 每行的**块层级缩进**（`null` = 保留原缩进：顶层 / 指令 / 注释 / 续行 / 孤儿闭合）。
 *
 * 入参与 `erbBodyLineMask` 等长；被保护行整行跳过（不参与层级、也不改字节）。
 * 所有判断只看去行首空白后的 `rest`，缩进本身只用于"顶层保留原样"这个锚点
 * ⇒ 对同一份文本再运行必然给出同一串目标缩进（幂等由测试钉住）。
 */
function erbIndentPlan(
  lines: readonly string[],
  body: readonly boolean[],
  unit: string,
  rules: ResolvedRules,
): (string | null)[] {
  const plan = lines.map(() => null as string | null);
  const stack: ErbIndentFrame[] = [];
  /** 当前块体层（栈顶块的体缩进；分支体内再深一级） */
  const bodyIndent = (): string | null => {
    const top = stack[stack.length - 1];
    return top === undefined ? null : top.indent + unit + (top.branch ? unit : '');
  };
  for (let i = 0; i < lines.length; i++) {
    if (body[i]) continue;
    const content = lines[i]!;
    const rawIndent = leadingBlank(content);
    const rest = content.slice(rawIndent.length);
    if (rest.length === 0) continue; // 纯空白行：不参与层级、由空白规则管
    if (rest.startsWith('@')) {
      // 函数定义行把层级归零（上一函数欠的闭合不许把下一函数整段缩进）；`@"…"` 续行原样
      if (ERB_FUNCTION_HEADER_RE.test(rest)) stack.length = 0;
      continue;
    }
    // 注释 / `#` 指令 / `$` 标签：不改缩进、也不改层级
    if (rest.startsWith(';') || rest.startsWith('#') || rest.startsWith('$')) continue;
    const word = /^[A-Za-z_]+/.exec(rest)?.[0]?.toUpperCase();
    if (word === undefined) {
      // 非词首形态（`@"…"` 续行、`[SKIPSTART]` 等）：按当前块体排
      const indent = bodyIndent();
      if (indent !== null) plan[i] = indent;
      continue;
    }
    const openPair = ERB_INDENT_OPEN[word];
    if (openPair !== undefined) {
      const indent = bodyIndent();
      if (indent !== null) plan[i] = indent;
      // 顶层开块行保留原缩进，块体从它起算（真语料里顶层行也可能本来就带缩进）
      const anchor = indent ?? (rules.fullWidthSpace ? halfwidthInIndent(rawIndent) : rawIndent);
      stack.push({ pair: openPair, indent: anchor, branch: false });
      continue;
    }
    const branchPair = ERB_INDENT_BRANCH[word];
    if (branchPair !== undefined) {
      const at = findErbFrame(stack, branchPair);
      if (at >= 0) {
        const frame = stack[at]!;
        plan[i] = frame.indent + unit;
        frame.branch = true;
      } else {
        const indent = bodyIndent();
        if (indent !== null) plan[i] = indent;
      }
      continue;
    }
    const closePair = ERB_INDENT_CLOSE[word];
    if (closePair !== undefined) {
      const at = findErbFrame(stack, closePair);
      if (at >= 0) {
        plan[i] = stack[at]!.indent;
        stack.length = at;
      } else {
        const indent = bodyIndent();
        if (indent !== null) plan[i] = indent;
      }
      continue;
    }
    // `SIF` 与其余普通语句：按当前块体排；`SIF` 不抬下一行（那是回车规则的活，这里不猜）
    const indent = bodyIndent();
    if (indent !== null) plan[i] = indent;
  }
  return plan;
}

/**
 * ERB 一行的新内容（`null` = 不用改）。
 *
 * 注释判据刻意只认**整行注释**（去缩进后以 `;` 开头）：ERB 的行中 `;` 既可能是注释、
 * 也可能就在打印文本里（`PRINTFORMW` 的参数不是带引号的串），这一层分不开 ⇒ 不动。
 * 同一个"分不开就不动"做到块这一层：调用方先用 `erbBodyLineMask` 把正文区
 * （数据表块体 / 停用死区）整行剔除，本函数只见结构行——它自己仍是逐行纯函数：
 * 块缩进目标由调用方按 `erbIndentPlan` 传入（`null` = 保留原缩进）。
 */
function erbNewContent(content: string, rules: ResolvedRules, blockIndent: string | null): string | null {
  if (content.length === 0) return null;
  if (isAllIndent(content)) {
    // 纯空白行 → 真空行（空白身份无歧义）；但行内有 U+3000 且折算规则关着时不动
    if (!rules.fullWidthSpace && content.includes(FULLWIDTH_SPACE)) return null;
    return '';
  }
  const indent = leadingBlank(content);
  const rest = content.slice(indent.length);
  // 块层级给的缩进优先；折算关且原缩进含 U+3000 ⇒ 原样（"保留"不能变成改写）
  const keepRawIndent = !rules.fullWidthSpace && indent.includes(FULLWIDTH_SPACE);
  const newIndent =
    blockIndent !== null && !keepRawIndent
      ? blockIndent
      : rules.fullWidthSpace
        ? halfwidthInIndent(indent)
        : indent;
  const newRest = rules.fullWidthSpace && rest.startsWith(';') ? halfwidthInText(rest) : rest;
  const next = newIndent + newRest;
  return next === content ? null : next;
}

/** 糖行的注释区起点（`rest` 内下标）；-1 = 这一行没有可动的注释区 */
function sugarCommentStart(cls: LineClass, rest: string): number {
  if (cls.kind === 'comment') return 0;
  if (NO_INLINE_COMMENT.has(cls.kind)) return -1;
  return inlineCommentIndex(rest);
}

/** 一条逻辑行的处理结果（只作用在它的**首个物理行**上） */
interface SugarEntry {
  readonly logical: LogicalLine;
  readonly cls: LineClass | null;
  /** 是否落在 `@` 原生块里（判据同 `readRawFunctionBlock`：一旦开始就延续到下一个 `@` 行或文件尾） */
  readonly raw: boolean;
}

/**
 * 缩进单位探测：只在**糖行**、**有缩进**、**未折行**、**分类成功**的行里数。
 *
 * 只认 TAB 与 4 空格两种单位——它们是仅有的两种"重排后层级必然不变"的单位
 * （2 空格单位会把 level 2 折回 level 1：`indentLevel('    ') === 1`）。
 * 谁多取谁；平局或一方都没有 ⇒ `null` = 判不准 ⇒ 缩进规则整体关掉。
 */
function detectIndentUnit(entries: readonly SugarEntry[]): string | null {
  let tabs = 0;
  let spaces = 0;
  for (const e of entries) {
    if (e.raw || e.cls === null) continue;
    if (e.cls.kind === 'blank' || e.cls.kind === 'rawLine') continue;
    if (e.logical.endLine !== e.logical.line) continue;
    if (e.logical.indent <= 0) continue;
    const raw = e.logical.rawIndent;
    if (raw.length === 0) continue;
    if (/^\t+$/.test(raw)) tabs++;
    else if (/^ +$/.test(raw) && raw.length % SPACE_UNIT.length === 0) spaces++;
  }
  if (tabs === spaces) return null;
  return tabs > spaces ? TAB_UNIT : SPACE_UNIT;
}

/**
 * ERB 形的整条规则面：掩码 / 单位探测 / 块层级 / 逐行改写，**一趟进、等长出**。
 *
 * 整篇腿与区间腿都从这里过（`newContents` 与 `computeRangeFormatEdits`），
 * 判据只有这一份——区间腿唯一的差别是 `contents` 前面多接了选区之前的行。
 */
function erbNewContents(contents: readonly string[], rules: ResolvedRules): (string | null)[] {
  // 块上下文只在这里进 ERB 形（唯一一处；整篇/区间/on-type 三条腿都从本函数过，判据不分叉）
  const body = erbBodyLineMask(contents);
  // 单位探测不出 ⇒ 整条块缩进关掉（同 `.kojo` 的保守门槛），只剩全角折算与空白规则
  const unit = rules.indent ? detectErbIndentUnit(contents, body) : null;
  const plan = unit === null ? null : erbIndentPlan(contents, body, unit, rules);
  const out: (string | null)[] = contents.map(() => null);
  for (let i = 0; i < contents.length; i++) {
    out[i] = body[i] ? null : erbNewContent(contents[i]!, rules, plan?.[i] ?? null);
  }
  return out;
}

/** 按方言算出每条物理行的新内容（`null` = 不改） */
function newContents(text: string, dialect: FormatDialect, rules: ResolvedRules): (string | null)[] {
  const lines = splitPhysical(text);

  if (dialect === 'erb') return erbNewContents(lines.map((l) => l.content), rules);

  const out: (string | null)[] = lines.map(() => null);

  // ---- `.kojo`：先按词法器切逻辑行（折行合并、层级、行类全同一条口径）----
  let logicals: LogicalLine[] = [];
  try {
    logicals = splitLogicalLines(text);
  } catch {
    // 词法都切不动的文本没有"可信层级"可言：缩进与注释一律不动，只保留空白身份最明确的两类
    for (let i = 0; i < lines.length; i++) {
      const c = lines[i]!.content;
      if (c.length > 0 && isAllIndent(c)) out[i] = '';
    }
    return out;
  }

  const entries: SugarEntry[] = [];
  let inRawBlock = false;
  for (const logical of logicals) {
    let cls: LineClass | null = null;
    try {
      cls = classifyLine(logical);
    } catch {
      cls = null; // 分类抛错 = 判不准 ⇒ 这一行整条不动
    }
    if (cls?.kind === 'rawBlockStart') inRawBlock = true;
    if (cls?.kind === 'skipStart') inRawBlock = true; // 停用区起点：区内一行都不折
    entries.push({ logical, cls, raw: inRawBlock });
    // 与 `@` 原生块不同，停用区有成对的尾记号：落完 `skipEnd` 必须把区关掉，否则区会一路骑到
    // 文件尾，把配对标记**之后**的正常糖行也不再排版（未配对时照 ERB 语义吃到 EOF，由 parser 报 warning）。
    if (cls?.kind === 'skipEnd') inRawBlock = false;
  }

  const unit = detectIndentUnit(entries);

  for (const e of entries) {
    const index = e.logical.line - 1;
    const line = lines[index];
    if (!line) continue;
    // 折行（`\` 续接）涉及的逻辑行整条不动：改首行会改续接、改续行会改内容
    if (e.logical.endLine !== e.logical.line) continue;

    // 原生块（`@` 起，判据同 `readRawFunctionBlock`）：**一个字符都不动**。
    // 那里的每一行都逐字节进产物（连行首空白与注释原文一起），"改了也不进产物"这条
    // 放行前提在块内不成立 ⇒ 整块跳过（要整理那段 ERB，请直接对它做 ERB 形格式化）。
    if (e.raw) continue;
    if (e.cls === null) continue;

    if (e.cls.kind === 'blank') {
      if (line.content.length === 0) {
        out[index] = null;
        continue;
      }
      // 与 ERB 形同口径：仅含 U+3000 的空白行在折算规则关着时原样保留
      if (!rules.fullWidthSpace && line.content.includes(FULLWIDTH_SPACE)) continue;
      out[index] = '';
      continue;
    }

    const rawIndent = e.logical.rawIndent;
    const rest = line.content.slice(rawIndent.length);
    // 归一：糖行 + 探到单位 + 规则开；折算关时含 U+3000 的缩进排除出重排
    // （否则 unit.repeat 会把 U+3000 按层级抹掉，"U+3000 保留"就成了空话）
    const canNormalize = rules.indent && unit !== null && e.cls.kind !== 'rawLine';
    const keepRawIndent = !rules.fullWidthSpace && rawIndent.includes(FULLWIDTH_SPACE);
    const newIndent =
      canNormalize && !keepRawIndent
        ? unit.repeat(e.logical.indent)
        : rules.fullWidthSpace
          ? halfwidthInIndent(rawIndent)
          : rawIndent;
    // 注释区折算归 fullWidthSpace 管：关 ⇒ 一个字符都不碰
    const commentStart = rules.fullWidthSpace ? sugarCommentStart(e.cls, rest) : -1;
    const newRest =
      commentStart >= 0 ? rest.slice(0, commentStart) + halfwidthInText(rest.slice(commentStart)) : rest;
    const next = newIndent + newRest;
    out[index] = next === line.content ? null : next;
  }
  return out;
}

/**
 * 文本进、edits 出（无变化 ⇒ 空数组）。
 *
 * `options` 为 P2-14 的规则开关（缺省全开 ⇒ 与加选项之前逐字等价）；保存链路
 * （E2）刻意不传，落盘口径永远是全开。
 */
export function computeFormatEdits(
  text: string,
  dialect: FormatDialect,
  options: FormatRuleOptions = {},
): FormatEdit[] {
  const lines = splitPhysical(text);
  const next = newContents(text, dialect, resolveRules(options));
  const edits: FormatEdit[] = [];
  for (let i = 0; i < next.length; i++) {
    const content = next[i];
    const original = lines[i];
    if (typeof content !== 'string' || !original || content === original.content) continue;
    edits.push({ line: i + 1, startColumn: 1, endColumn: original.content.length + 1, text: content });
  }
  return edits;
}

/**
 * 区间格式化要补的那段上下文（additive）：**选区起始行之前**的原文。
 *
 * 为什么必须有它：区间腿手里只有选区那几行，块层级状态机从选区首行起喂就是「无外层块」，
 * 于是 IF 体内的语句会被压平成 0 级（层级判不准就关规则只能救一部分，救不了"该缩进"）。
 * 把前缀（整篇第 1 行到选区之前那几行）接在选区文本前面一起喂进**同一台**块状态机，
 * 栈就与整篇腿逐字一致——前缀只参与推层级/探单位，一个字节都不回写。
 *
 * 契约：`prefix` 必须是**整行**前缀（每行带行尾；选区从第 1 行起时传空串）；
 * 前缀不完整（末行没有行尾）会把选区首行与它粘成一行——这属于调用方违约，本层不猜。
 */
export interface RangeFormatContext {
  readonly prefix?: string;
}

/** 整行前缀 → 物理行；`splitPhysical` 给行尾收束的文本补的"空尾巴"不是文档里的一行 */
function splitPrefixLines(prefixText: string): PhysicalLine[] {
  const lines = splitPhysical(prefixText);
  const last = lines[lines.length - 1]!;
  if (last.content.length === 0 && last.eol === '') lines.pop();
  return lines;
}

/**
 * 区间格式化（Monaco `document range formatting` 的窗口腿）：`text` 是**选区文本**，
 * `context.prefix` 是选区之前的整行前缀，edits 的行号是**选区局部坐标**（第 1 行 = 选区首行）。
 *
 * - 判据与整篇腿只有一份：前缀与选区接起来喂 `erbNewContents`，块层级/单位探测/保护区掩码
 *   都走同一套；只把落在选区内的结果做成 edits ⇒ **前缀与选区外一个字节都不动**。
 * - 无前缀 ⇒ 与 `computeFormatEdits(text, dialect, options)` 逐字等价（既有行为零改动）；
 *   顶层选区因此仍然「保留原缩进」。
 * - `.kojo` 不吃前缀：它的层级由词法器算，词法面是文档级判据，只接半篇文本会把逻辑行
 *   （`\` 续接）切错——宿主对该方言本就走整篇腿。传了前缀也只按 `text` 自身算。
 */
export function computeRangeFormatEdits(
  text: string,
  dialect: FormatDialect,
  context: RangeFormatContext = {},
  options: FormatRuleOptions = {},
): FormatEdit[] {
  const prefixText = context.prefix ?? '';
  if (dialect !== 'erb' || prefixText.length === 0) return computeFormatEdits(text, dialect, options);

  const prefixLines = splitPrefixLines(prefixText);
  const rangeLines = splitPhysical(text);
  const contents = [...prefixLines.map((l) => l.content), ...rangeLines.map((l) => l.content)];
  const next = erbNewContents(contents, resolveRules(options));
  const edits: FormatEdit[] = [];
  for (let i = 0; i < rangeLines.length; i++) {
    const content = next[prefixLines.length + i];
    const original = rangeLines[i]!;
    if (typeof content !== 'string' || content === original.content) continue;
    // 行号回落成选区局部坐标：前缀的行号绝不进 edits（那是"不许动"的字节）
    edits.push({ line: i + 1, startColumn: 1, endColumn: original.content.length + 1, text: content });
  }
  return edits;
}

/**
 * 单行窗口的块上下文（additive，宿主 on-type 腿用）：**前缀行数组 + 目标行** → 目标行的新内容
 * （`null` = 不改）。
 *
 * 为什么单行也要前缀：`computeRangeFormatEdits` 那条腿把"前缀文本"整段喂进 `erbNewContents`，
 * 单行 on-type 每次击键都要跑，一趟 `splitPhysical` 的 5 万行切片太贵（PS-4 实测 37.7 ms）。
 * 这里改喂**行数组**（宿主 `getLineContent` 逐行取，省掉拼大字符串那一趟），并且**只算目标行**
 * 的产物——判据仍只走 `erbBodyLineMask` / `detectErbIndentUnit` / `erbIndentPlan` / `erbNewContent`
 * 这一套（**没有第二份块状态**），差别只在"前缀行的新内容不必算"。
 *
 * 前缀必须是**整篇第 1 行到目标行之前**的行（0 基行号就是入参下标），否则块层级/保护区判据
 * 与整篇腿对不上；目标行是入参 `content`（不含行尾）。
 *
 * 与 `computeRangeFormatEdits(…{prefix})` 的关系：两者对"前缀非空且单位探测得到"的同一份输入
 * 给出同一行结果（`tests/formatter-erb.test.ts` 的"单行窗口：前缀行数组"一节钉住）；后者仍是
 * 多行选区的唯一入口。
 */
export function erbNewContentWithPrefix(
  prefixLines: readonly string[],
  content: string,
  options: FormatRuleOptions = {},
): string | null {
  const rules = resolveRules(options);
  const contents: string[] = [...prefixLines, content];
  const body = erbBodyLineMask(contents);
  const target = contents.length - 1;
  // 目标行落在块体/死区 ⇒ 整行不动（与整篇腿同一条掩码）
  if (body[target]) return null;
  // 单位探测 / 块层级与整篇腿同两个函数；前缀行只参与判据，产物不算（它们本来也不回写）
  const unit = rules.indent ? detectErbIndentUnit(contents, body) : null;
  const plan = unit === null ? null : erbIndentPlan(contents, body, unit, rules);
  return erbNewContent(content, rules, plan === null ? null : (plan[target] ?? null));
}

/**
 * 把 edits 落回文本，**行尾原样保留**（每条 edit 都被夹在同一行内，绝不跨行）。
 * 越界坐标按夹取处理：陈旧行号/列号不该让保存链路抛错。
 */
export function applyFormatEdits(text: string, edits: readonly FormatEdit[]): string {
  if (edits.length === 0) return text;
  const lines = splitPhysical(text);
  for (const e of edits) {
    const line = lines[e.line - 1];
    if (!line) continue;
    const from = Math.min(Math.max(0, e.startColumn - 1), line.content.length);
    const to = Math.min(Math.max(from, e.endColumn - 1), line.content.length);
    line.content = line.content.slice(0, from) + e.text + line.content.slice(to);
  }
  return lines.map((l) => l.content + l.eol).join('');
}

/** 一步到位（E2 用）：格式化后的文本 + 本次实际改动数（`options` 同 `computeFormatEdits`） */
export function formatText(
  text: string,
  dialect: FormatDialect,
  options: FormatRuleOptions = {},
): { text: string; edits: FormatEdit[] } {
  const edits = computeFormatEdits(text, dialect, options);
  return { text: applyFormatEdits(text, edits), edits };
}
