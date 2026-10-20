/**
 * 结构解析的**引擎本体**（CST 与三份查询只在这里活；`kojo-ts.worker.ts` 只是它外面的消息环）。
 *
 * ## 为什么把引擎从 worker 里拆出来
 *
 * 增量解对不对、贵不贵，只有拿**真语法 + 真 wasm**量了才算数；而 worker 文件本身在
 * Node 测试池里起不来（`?worker` 是 Vite 后缀，vitest 的 node 环境没有 Worker 构造）。
 * 拆开后两侧打的是同一份代码：worker 只做"收消息 → 调引擎 → 把回话 postMessage 出去"，
 * 测试直接 `new StructureEngine({ assets, emit })` 驱动同一条 `tree.edit()` +
 * `parse(stringer, oldTree)` 路——**不许**在测试里另抄一份"看起来一样的"调用形状。
 *
 * 资源（两枚 wasm 与三份查询）由构造参数注入而不是 import `./assets`：`assets.ts` 走
 * Vite 的 `?url` / `?raw`，node 池解析不了；注入也顺带把"worker 不许硬编码路径"这条
 * 纪律写成了类型（引擎根本拿不到 URL 之外的资源）。
 *
 * ## 增量口径（实测，非推测；读数见 `tests/tree-sitter-parse.perf.test.ts`）
 *
 * `change` 做三件事：① 用宿主算好的那一条保守编辑把旧树推到位（`tree.edit`）——但**报上去的起点
 * 可以比真实编辑更早**：落在顶层边界上的改动，其前面那一段空白连同第一枚非空白顶层节点必须一起
 * 重解，否则"块头把改动区间吞进自己身体"这一决定会被当成已经收束的成品复用掉（实测 53/1,800 步
 * 因此漂，形状清一色 `增量 timing_head@X / 整篇 block@X..Y`；口径见 {@link reparseStart}）；
 * ② 拿**有界取字符回调**（stringer）在新文本上重解；③ **只重查改动窗口**（下一节），
 * 窗口外的结果拿缓存复用。
 *
 * web-tree-sitter 0.27 的 `Parser.parse(input, oldTree)` 两种输入都支持，但传整串时内部是
 * `(index) => text.slice(index)` —— **每次取字都复制一遍文档尾巴**（源码见
 * `web-tree-sitter.js` 的 `parse()`：`C.currentParseCallback = (index) => callback.slice(index)`），
 * 5,000 行档实测整篇解的 p95 因此被抬到 30ms 级（GC 抖动），而 stringer 是 12ms 级；
 * 增量路径每击键只取 1 段（改动行附近），取字量与文档规模解耦。
 * 段长上限 4,096 码元是照 wasm 侧的输入缓冲定的（`_tree_sitter_parse_callback` 只把
 * `10 * 1024` 字节 = 5,120 码元写进缓冲），超过会白取。
 *
 * ## 查询只跑改动窗口（TSIT2-G；旧口径"每击键把整篇重查一遍"已作废）
 *
 * 分腿实测（5,000 行合成档）：`parse` 本身 ≈ 4 ms，而三面查询 + 全树残缺扫描 ≈ 35 ms
 * —— 贵的从来不是解，是**每击键把整篇再查一遍、再扫一遍**。于是：
 *
 * 1. 每面缓存**已经折好的 plain 结果**（着色段 / 折叠区间 / 残缺事实），每槽带上"我依据的
 *    那枚节点占哪一段码元"。缓存里不存任何 wasm 句柄（不留树、不留 Node ⇒ 不会把原生内存
 *    钉在手上）。**作废轴一律取码元而不是行号**：同一行上能并排站着好几枚顶层节点，按行判
 *    会把窗口外的条目也算进作废范围 ⇒ 重复计数（实测踩到：删一行之后顶层节点从 3,915 涨到
 *    3,921，行号与顶层节点不再一一对应）。折叠那一面的槽段还要**算上被吞掉的尾随空行**
 *    （止行口径见 {@link extendFoldOverTrailingBlanks}）：那些空行现在是止行的依据，
 *    改动落在其上必须重查这一槽，否则平移回来的是一份过期止行。
 * 2. 重解之后问一次旧树 `oldTree.getChangedRanges(next)`（0.27 的口径：**以旧树为调用者**，
 *    回的是旧文本坐标的段；反过来问恒空，实测踩过），并上本次编辑自己那一段 ⇒ 脏跨度。
 *    并上编辑是保守多算：实测本语法有"删掉一行而旧树报零段"的形状（缩进记号把前后行读成
 *    同一枚节点），只信改动段就会漏重查。
 * 3. 脏跨度贴到**整枚顶层节点**上（`descendantForIndex` + 上溯到只剩一层，实测 0.01–0.18 ms；
 *    **不**走"枚举根的全部孩子"那条路，3,915 枚孩子的档上实测 4–6 ms，比要省下来的查询还贵），
 *    右端再带一枚 = 这一击键的重查窗口。顶层节点互不重叠并铺满文档，而三份查询里没有任何模式
 *    能匹配根节点（`source`）⇒ 任何一条命中要么整枚在窗口里、要么整枚在窗口外 ⇒ 拼接出来的
 *    序列与整篇重查**逐字相等**（perf 池：单击键三面与整篇重算逐字 `toEqual` + 40 击键混合流
 *    逐击对账钉这一条）。
 * 4. 窗口外的缓存条目按本次编辑平移：码元跨度抬 `newEnd.offset - oldEnd.offset`，行号抬
 *    `newEnd.row - oldEnd.row`，列一律不动（被平移的条目**整段都在改动窗口之后**，那些行的
 *    文本一个字符都没变）。
 *
 * **什么时候老实整篇重查**（`StructureParseStat.queryScope` 如实说 `'full'`，`queryFullReason`
 * 带上理由；perf 池把这些数打出来，不当"悄悄退回"）：
 * · 窗口盖住半篇（粘贴 / 整档重写：拼缓存与整篇重查同价，少一条会出错的路）；
 * · 顶层节点定位落进根节点的空白（extras）里、或缓存里出现**横跨窗口边界**的条目；
 * · 零宽结果（MISSING）正好压在窗口边界上 ⇒ 归属判不出来；
 * · 缓存本身是被上限截出来的前缀（残缺过多 ⇒ 补不出正确前缀，老实整篇）；
 * · 缩进那一面今天**恒整篇**（`indentRulesFrom`）：它的产物是"节点首行文本 → 锚定正则"的
 *   去重 + 排序**集合**，集合语义下少一条就是错；而本语法 `indents.scm` 没有 `@indent.*`
 *   捕获 ⇒ 装配阶段就回落 ⇒ 这一面实测不耗时（读数见 perf 池的回话台账）。
 *
 * 退回整篇**不是**故障：结果仍然与整篇重算逐字相等，只是贵。所以这里**不回 `error` 回话**
 * （`error` 在宿主那一侧的意思是"这一面没顶上"，会真把 provider 拆掉），而是把决定写进
 * `lastStat` 让量数自己说话 —— 该被看见的是"没人读读数"，不是"引擎知道却不说"。
 *
 * ## 三条纪律（与拆分之前的 worker 一致）
 *
 * 1. 依赖面只有 `web-tree-sitter` + `./types`（不 import Monaco、不 import 宿主 UI、不 import `./assets`）；
 * 2. 增量失败分两种：**没有旧树**（首次 / 上次已停用）⇒ 整篇重解对齐；**解本身抛错** ⇒
 *    回一条 `all` 级错误并且**不再继续答**（wasm 抛过之后树与解析器都可疑，硬撑着继续解就是
 *    拿可疑的树着色；`client.ts` 收到 `all` 会拆掉全部 provider，作者回到只有词法层）。
 *    缓存/窗口这一层自己抛错只让**那一面那一次**改走整篇重算（结果照样对，并写进读数），
 *    不许把还能顶的 provider 拆掉。
 * 3. 任何一条回话都是新建的 plain array —— Node 对象绝不跨线程。
 */
import { Edit, Language, Parser, Query, type Node, type Tree } from 'web-tree-sitter';
import {
  KOJO_STRUCTURE_MAX_SYNTAX_FAULTS,
  KOJO_STRUCTURE_MAX_TOKENS,
  tierForCapture,
  type KojoStructureCapability,
  type KojoStructureDocSeq,
  type KojoStructureErrorStage,
  type KojoStructureFold,
  type KojoStructureIndentRules,
  type KojoStructureReply,
  type KojoStructureRequest,
  type KojoStructureSyntaxFault,
  type KojoStructureSyntaxKind,
  type KojoStructureToken,
} from './types';

/** 引擎要的资源：两枚 wasm（浏览器给 URL、node 测试给字节）+ 三份查询源码 */
export interface StructureEngineAssets {
  readonly runtimeWasm: string;
  readonly kojoWasm: string | Uint8Array;
  readonly highlightsQuery: string;
  readonly foldsQuery: string;
  readonly indentsQuery: string;
}

/**
 * 一次解（整篇或增量）的**局部性读数**——增量大小的唯一可证伪证据。
 *
 * `reads` = 这一趟向文本取了几段；`readStart/readEnd` = 取到的窗口（新文本的 UTF-16 码元偏移）；
 * `incremental` = 这一次有没有用上旧树。真增量应当是"窗口贴着编辑点、段数与文档规模无关"。
 * `queryScope` 那一组是**查询侧**的第二条证据链：解局部了不等于查也局部了。
 */
export interface StructureParseStat {
  readonly incremental: boolean;
  readonly reads: number;
  readonly readStart: number;
  readonly readEnd: number;
  readonly editStart: number;
  readonly editEnd: number;
  readonly documentLength: number;
  /** 'window' = 该走窗口的三面全走了窗口；'full' = 至少有一面老实整篇重查；'none' = 这一趟没解成 */
  readonly queryScope: 'window' | 'full' | 'none';
  /** 窗口里重查了几枚顶层节点（整篇重算 / 还没解过 = 0） */
  readonly windowNodes: number;
  /** 旧树报回来的改动段数（没问 = -1） */
  readonly changedRanges: number;
  /**
   * 这一趟**报给 `tree.edit` 的起点**（旧文本码元偏移；没增量解过 = -1）。
   * additive 读数：它与 `editStart` 的差就是 {@link StructureEngine.reparseStart} 往前推了多少——
   * "块头必须跟着后面改动一起重解"这条代价是唯一可证伪的证据（perf 池打印它）。
   */
  readonly reparseFrom: number;
  /** 为什么没走窗口（走窗口时为空串；同一句话一次解里只留一条） */
  readonly queryFullReason: string;
}

/** 引擎自己拆出来的耗时腿（只有挂了 `trace` 才付时间戳的代价；生产里不传 ⇒ 零开销） */
export type StructureEngineLeg =
  | 'parse'
  | 'changedRanges'
  | 'semanticQuery'
  | 'foldsQuery'
  | 'indentQuery'
  | 'syntaxScan';

export interface StructureEngineOptions {
  readonly assets: StructureEngineAssets;
  /** 唯一的输出通道（worker 里就是 `postMessage`；测试里就是收消息的数组） */
  readonly emit: (reply: KojoStructureReply) => void;
  /**
   * 可选的分腿读数出口（perf 池用它把"解 / 问脏段 / 查 / 扫"摊开对着看）。
   * 判据不许依赖它：不传 ⇒ 引擎一个时间戳都不取。
   */
  readonly trace?: ((leg: StructureEngineLeg, ms: number) => void) | null;
}

/** stringer 每次交给 wasm 输入缓冲的最大码元数（见文件头：wasm 侧缓冲 10 KiB = 5,120 码元） */
export const STRUCTURE_READ_CHUNK = 4096;

/**
 * 窗口最多容多少枚顶层节点：超过就直接整篇重查。
 * 拼缓存那一趟要把窗口外的条目全拷一遍，重查那一趟要按节点造包装 —— 两条路在几百枚顶层节点
 * 的量级上打平，再多就是名义上还在走窗口、实际已经把整篇干了一遍，不如老实走整篇那条路
 * （少一层平移与闭合判据，也少一处能出错的地方）。
 */
export const STRUCTURE_MAX_WINDOW_NODES = 256;

/** 抛错原因（本地一份，不为一条日志把 `@kojo/plugin-api` 拖进 worker 依赖图） */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 行内空白（半角/全角空格、制表、换页、CR；与词法层"空白一律不算内容"的口径一致） */
function isBlankChar(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\u3000' || ch === '\f' || ch === '\r';
}

/**
 * `[from, to)` 这一段码元是不是**全空白**（不认领任何内容的兄弟：空行记号 / 缩进）。
 * 换行算空白——本语法每条换行都由 `blank_line` 记号单独认领，它不是正文。
 */
function isBlankRange(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const ch = text[i]!;
    if (ch === '\n') continue;
    if (!isBlankChar(ch)) return false;
  }
  return true;
}

/**
 * 尾随空行的**可达末行**（0 基）；`<= endRow` 即"这枚不许伸"。两道界：
 *
 * 1. **只有根的直接孩子（最外层块）才吞**。真源里会吞尾随空行的正是"由外层循环收尾"的那几族：
 *    它们的 `loc.end` 取**游标消费到的最后一行**，而块体循环见空行就消费、只在更浅的**非空行**前停；
 *    写在块体内部的嵌套块，止行停在**正文末行**——A/B 实测把它们也吞进来是过伸（6 条）。
 *    结构层零语法词 ⇒ 能用的对应判据只有树形：**父节点就是根**。
 * 2. 同父之后第一枚**认领了内容**的兄弟：不许越过它的起点行；后面没有带内容的兄弟
 *    （自己就是父节点的最后一段正文）时，最多伸到父节点的末行。
 */
function foldBlankBoundRow(text: string, node: Node, endRow: number): number {
  const parent = node.parent;
  if (parent === null) return endRow; // 没有父 = 这枚就是根 ⇒ 不伸（根不产折叠，走到这里说明形状变了）
  if (parent.parent !== null) return endRow; // 嵌套块：真源的止行停在正文末行 ⇒ 不伸
  let sibling: Node | null = node.nextSibling;
  while (sibling !== null) {
    if (!isBlankRange(text, sibling.startIndex, sibling.endIndex)) {
      return Math.max(endRow, sibling.startPosition.row - 1);
    }
    sibling = sibling.nextSibling;
  }
  return Math.max(endRow, parent.endPosition.row);
}

/** 吞尾随空行后的折叠终点 + 这枚折叠（含吞掉的空行）覆盖到的码元右端（不含） */
export interface FoldTrailingBlankExtension {
  readonly endRow: number;
  /** 缓存槽的作废轴：吞掉的每一行空行都算这枚折叠的**依据**，改动落在其上就必须重查这一面 */
  readonly endIndex: number;
}

/**
 * 折叠终点**吞掉尾随空行**（向真源 `kojoFoldingRanges` 的止行口径靠）。
 *
 * 为什么需要这一步：本语法每条换行都由 `blank_line` 记号单独认领（见 `folds.scm` 头注），
 * 块节点因此**不吃**自己后面的空行；而真源的块 `loc.end` 是"游标消费到的最后一行"，
 * 块体解析把尾随空行也消费掉了 ⇒ 两侧同一起点的止行差 1 行（A/B 实测 86/87 条失配全是这个形状）。
 * 吞尾随空行是用户已经在用的既有行为，所以对齐方向只有一个：结构层伸过去。
 *
 * 收缩纪律（一条不满足就不伸，宁少不多）：
 * 1. **只在最外层块、同一父节点内**越过（可达末行见 {@link foldBlankBoundRow}，不许越过下一个
 *    带内容兄弟的起点行）；
 * 2. **整行空白才算尾随**：候选行里出现任何非空白字符就停，夹着正文的行绝不吞；
 * 3. **不越过文件末行**：候选行必须真实存在。文末换行之后那一行 Monaco 里确实是一行（空的），
 *    所以允许吞到它，并且**只**能吞到它（`"x\n"` 的末行 = 空行；再往后没有行）。
 *
 * 另外保守一条：节点末位到**本行行尾**必须只剩空白，否则整枚不伸（那一行还有别人认领的东西）。
 * 纯函数（只读 `text` 与树形），A/B 对账测试直接调它，判据与 worker 同一份，不抄第二遍。
 */
export function extendFoldOverTrailingBlanks(
  text: string,
  node: Node,
  endRow: number,
): FoldTrailingBlankExtension {
  const untouched: FoldTrailingBlankExtension = { endRow, endIndex: node.endIndex };
  const bound = foldBlankBoundRow(text, node, endRow);
  if (bound <= endRow) return untouched;
  let i = node.endIndex;
  while (i < text.length && text[i] !== '\n') {
    if (!isBlankChar(text[i]!)) return untouched;
    i++;
  }
  if (i >= text.length) return untouched; // 节点结束于文末，后面没有行
  i++; // 越过换行 ⇒ i 是 `endRow + 1` 行的行首
  let row = endRow;
  let endIndex = i; // 已吞到的位置 = 下一候选行的行首
  while (row < bound) {
    if (i === text.length) {
      // 行首正好落在文末 = 最后一个换行之后的那一行（Monaco 里真实存在的空末行），吞掉它并且到此为止
      row++;
      endIndex = text.length;
      break;
    }
    let j = i;
    let blank = true;
    while (j < text.length && text[j] !== '\n') {
      if (!isBlankChar(text[j]!)) {
        blank = false;
        break;
      }
      j++;
    }
    if (!blank) break;
    row++;
    endIndex = j >= text.length ? text.length : j + 1;
    i = endIndex;
  }
  return { endRow: row, endIndex };
}

/**
 * 折叠槽的**依赖右端**（作废轴上比 `end` 更远的一段）：从吞完尾随空行后的止点起，
 * 跳过仍然全空白的行，再把**第一枚正文行整行**算进依赖范围——那一行一旦被子弹删成空行，
 * 止行就要继续往后伸；后面没有正文行了（到文末全是空白）则到文末。
 *
 * 只给"根的直接孩子"算（与 {@link foldBlankBoundRow} 的收缩纪律同一条判据）：嵌套块的止行
 * 停在正文末行、本来就不伸，它后面写了什么与它无关。
 */
function foldDependencyEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const newline = text.indexOf('\n', i);
    const stop = newline < 0 ? text.length : newline + 1;
    if (!isBlankRange(text, i, stop)) return stop;
    i = stop;
  }
  return text.length;
}

/** 一次编辑之后"值得重查"的窗口（`nodes` = 新树坐标系；`from/to` = 折回旧文本坐标的作废跨度） */
interface StructureWindow {
  readonly nodes: readonly Node[];
  readonly from: number;
  readonly to: number;
}

/**
 * 缓存的一槽：结果 + 它依据的那枚节点占哪一段码元（码元轴的理由见文件头第 1 条）。
 *
 * `guard`（additive，只有折叠那一面会带）= 这一槽的**依赖右端**：折叠的止行由"节点之后那一段
 * 全空白行 + 其后第一枚正文行"决定（见 {@link extendFoldOverTrailingBlanks}），那些行**不在**
 * 槽段 `[start..end]` 里，却被这次改动改了的话，止行就会变——按 `[start..end]` 判"整枚在窗口
 * 之前 ⇒ 原样复用"就会把过期止行留在屏上（等价闸实测：删掉一行行尾的几个码元让下一行变空，
 * 增量一直回 `94-95` 而整篇回 `94-96`）。所以折叠槽作废判据看 `guard`，不是只看 `end`。
 */
interface StructureCacheSlot<T> {
  readonly start: number;
  readonly end: number;
  readonly guard?: number;
  readonly value: T;
}

interface StructureFacetCache<T> {
  readonly slots: readonly StructureCacheSlot<T>[];
  /** 这份缓存是不是整篇枚举出来的**完整**结果（被上限截出来的前缀不是） */
  readonly complete: boolean;
}

/** 本次编辑的两套坐标换算（落在被替换区间内部的坐标一律往外夹 ⇒ 只会多算不会少算） */
interface StructureShift {
  readonly deltaRows: number;
  readonly deltaOffsets: number;
  offsetToOldLeft(offset: number): number;
  offsetToOldRight(offset: number): number;
  offsetToNewLeft(offset: number): number;
  offsetToNewRight(offset: number): number;
}

/**
 * 报给 `tree.edit` 的编辑起点（**只许比真实编辑更早，不许更晚**）。
 * `index` = 旧文本的码元偏移；`row/column` 取自旧树里那一枚节点的起点（免线性扫全文）。
 */
interface StructureReparseStart {
  readonly index: number;
  readonly row: number;
  readonly column: number;
}

const NO_CACHE: StructureFacetCache<never> = { slots: [], complete: false };

export class StructureEngine {
  private readonly assets: StructureEngineAssets;
  private readonly emit: (reply: KojoStructureReply) => void;
  private readonly trace: ((leg: StructureEngineLeg, ms: number) => void) | null;
  private parser: Parser | null = null;
  private tree: Tree | null = null;
  /** 引擎自己那一版文本（与主线程的缝合口径逐字相同 ⇒ 两侧永远对齐，无需每击键回传全文） */
  private documentText = '';
  private ready = false;
  private highlightsQuery: Query | null = null;
  private foldsQuery: Query | null = null;
  private indentsQuery: Query | null = null;
  /** 已经报过的捕获名（同一名字只说一次，别每解一次刷屏） */
  private readonly reportedCaptures = new Set<string>();
  private stat: StructureParseStat | null = null;
  /** 三面缓存（解完一篇换一次；空表 = 没有可用缓存 ⇒ 下一趟整篇） */
  private tokenCache: StructureFacetCache<KojoStructureToken> = NO_CACHE;
  private foldCache: StructureFacetCache<KojoStructureFold> = NO_CACHE;
  private faultCache: StructureFacetCache<KojoStructureSyntaxFault> = NO_CACHE;
  /** 本次解"哪一面没走窗口、为什么"（同一句话只留一条） */
  private facetNotes: string[] = [];
  /** 这一趟查询走了什么：窗口 / 整篇 / 这一趟没解成 */
  private passScope: 'window' | 'full' | 'none' = 'none';
  private lastWindowNodes = 0;
  private lastRangeCount = -1;
  /** 最近一趟报给 `tree.edit` 的起点（往前推过就不等于 `editStart`；没增量解过 = -1） */
  private lastReparseFrom = -1;

  constructor(options: StructureEngineOptions) {
    this.assets = options.assets;
    this.emit = options.emit;
    this.trace = options.trace ?? null;
  }

  get initialized(): boolean {
    return this.ready;
  }

  /** 当前文本快照（只给诊断/测试用；provider 一侧不许拿它当数据源） */
  get text(): string {
    return this.documentText;
  }

  /** 最近一次解的局部性读数；还没解过 = null */
  get lastStat(): StructureParseStat | null {
    return this.stat;
  }

  /** 最近一次解里"哪一面走了整篇、为什么"（perf 池原样打出来；没解过 = 空表） */
  get lastFacetNotes(): readonly string[] {
    return this.facetNotes;
  }

  /**
   * 引擎**实际在跑**的面（装配决定的事实，不是声明）。
   *
   * 存在的理由：`folds.scm` 从 TSIT2-E 起真有 `@fold` 捕获 ⇒ 折叠这一面不再走回落那条路，
   * 于是"结构层供哪几面"这个问题只能问引擎，抄在别处的清单（包括回落台账的措辞）迟早漂。
   * `syntax` 恒在 —— 那一面不吃查询，是直接从 CST 扫出来的（`compileQueries` 管不着它）。
   * 判据：一条解的回话台账必须**等于**这张表（`tests/tree-sitter-parse.perf.test.ts` 钉）。
   */
  get capabilities(): readonly KojoStructureCapability[] {
    const live: KojoStructureCapability[] = [];
    if (this.highlightsQuery !== null) live.push('semantic');
    if (this.foldsQuery !== null) live.push('folds');
    if (this.indentsQuery !== null) live.push('indent');
    live.push('syntax');
    return live;
  }

  /* -------------------------------- 查询执行 -------------------------------- */

  private fail(
    version: number,
    stage: KojoStructureErrorStage,
    capability: KojoStructureCapability,
    message: string,
  ): void {
    this.emit({ type: 'error', version, stage, capability, message });
  }

  /** 只在挂了 `trace` 时取时间戳（生产路径零开销） */
  private stamp(): number {
    return this.trace === null ? 0 : performance.now();
  }

  private elapsed(leg: StructureEngineLeg, started: number): void {
    if (this.trace !== null) this.trace(leg, performance.now() - started);
  }

  /**
   * 记一条"这一面为什么走整篇"，并把这一趟的读数降级成 `full`。
   * 缩进那一面恒整篇 ⇒ 它的话**不**降级读数（否则窗口永远读不出来）。
   */
  private noteFacet(facet: 'semantic' | 'folds' | 'indent' | 'syntax', why: string): void {
    const line = `${facet}：${why}`;
    if (!this.facetNotes.includes(line)) this.facetNotes.push(line);
    if (facet !== 'indent' && this.passScope === 'window') this.passScope = 'full';
  }

  /** 一次解的开头：把"这一趟走了什么"归零 */
  private beginPass(scope: 'window' | 'full' | 'none'): void {
    this.facetNotes = [];
    this.passScope = scope;
  }

  /**
   * `@name` 之类捕获 → 档位。表里没有就**说一次**并且不着色（绝不挑个"最像的"凑数）。
   *
   * 走窗口时这一趟只看得到窗口里的捕获 ⇒ 表外的名字仍然只说一次（`reportedCaptures` 是引擎级
   * 的），而整篇解那一趟一定看得到全文 ⇒ 不会因为走了窗口就少说一条。
   */
  private tokenValue(capture: { name: string; node: Node }): KojoStructureToken | null {
    const tier = tierForCapture(capture.name, capture.node.type);
    if (tier === null) {
      if (!this.reportedCaptures.has(capture.name)) {
        this.reportedCaptures.add(capture.name);
        this.fail(
          0,
          'query',
          'semantic',
          `highlights 查询里的捕获 @${capture.name} 没有档位映射 ⇒ 该类节点不着色（宿主侧在 types.ts 的 KOJO_STRUCTURE_CAPTURE_TIERS 里登记，或从查询里删掉）`,
        );
      }
      return null;
    }
    const node = capture.node;
    return {
      startRow: node.startPosition.row,
      startCol: node.startPosition.column,
      endRow: node.endPosition.row,
      endCol: node.endPosition.column,
      tier,
    };
  }

  /**
   * 折叠捕获 → 一槽折叠结果 + 它**实际依据**的码元段。
   * （`@fold` 之外的捕获不产折叠；单行跨度没有可折的东西 ⇒ 丢掉 —— 这条口径不动，
   *  空体块头仍然不产折叠，吞尾随空行只发生在**已经成块**的区间末尾。）
   *
   * 段取吞尾随空行之后的覆盖范围（不是节点自己的 `endIndex`）：那些空行现在也是这枚折叠的依据，
   * 改动落在其上就必须把这一槽拉进重查窗口，否则增量拼装会给出**过期止行**（与整篇重算不再逐字相等）。
   * 最外层的块还要再带一段 `guard`（依赖右端，见 {@link StructureCacheSlot}）：止行能不能再伸
   * 取决于"块后面还有没有空行、以及第一枚正文行还是不是正文"，那些行不在节点里。
   */
  private foldSlot(
    capture: { name: string; node: Node },
    foldPreferred: boolean,
  ): StructureCacheSlot<KojoStructureFold> | null {
    if (foldPreferred && capture.name !== 'fold') return null;
    const node = capture.node;
    const startRow = node.startPosition.row;
    const endRow = node.endPosition.row;
    if (endRow <= startRow) return null;
    const extended = extendFoldOverTrailingBlanks(this.documentText, node, endRow);
    const parent = node.parent;
    const guard = parent !== null && parent.parent === null ? foldDependencyEnd(this.documentText, extended.endIndex) : undefined;
    return {
      start: node.startIndex,
      end: extended.endIndex,
      ...(guard === undefined ? {} : { guard }),
      value: { startRow, endRow: extended.endRow },
    };
  }

  /** 平移一槽结果（`deltaRows === 0 && deltaOffsets === 0` 时调用方根本不会走到这里） */
  private shiftSlot<T>(slot: StructureCacheSlot<T>, shift: StructureShift, shiftValue: (value: T, deltaRows: number) => T): StructureCacheSlot<T> {
    const value = shiftValue(slot.value, shift.deltaRows);
    return {
      start: slot.start + shift.deltaOffsets,
      end: slot.end + shift.deltaOffsets,
      ...(slot.guard === undefined ? {} : { guard: slot.guard + shift.deltaOffsets }),
      value,
    };
  }

  private shiftToken(token: KojoStructureToken, delta: number): KojoStructureToken {
    return { ...token, startRow: token.startRow + delta, endRow: token.endRow + delta };
  }

  private shiftFold(fold: KojoStructureFold, delta: number): KojoStructureFold {
    return { ...fold, startRow: fold.startRow + delta, endRow: fold.endRow + delta };
  }

  /**
   * 残缺事实的平移：三个行号（落点行 / 末行 / 残缺点行）加上可省的块头行；列一律不动
   * —— 被平移的都是**整段落在改动窗口之后**的条目，那些行的文本一个字符都没变。
   */
  private shiftFault(fault: KojoStructureSyntaxFault, delta: number): KojoStructureSyntaxFault {
    return {
      ...fault,
      row: fault.row + delta,
      endRow: fault.endRow + delta,
      faultRow: fault.faultRow + delta,
      // 键的存在性照原样留着（整篇重算那条路也是"块头行等于落点行就不带这个键"）
      ...(fault.blockHeadRow === undefined ? {} : { blockHeadRow: fault.blockHeadRow + delta }),
    };
  }

  /**
   * 缓存 + 窗口 → 这一面的新序列（顺序 = 文档序 = 整篇重查的顺序；三段拼：窗口前 / 窗口 / 窗口后）。
   *
   * 边界五条（`start/end` = 槽依据的那枚节点占的码元段，`guard` = 折叠那一面多出来的依赖右端，
   * `from/to` = 窗口折回旧坐标的段）：
   * · `end <= from` **并且** `guard` 也不越过 `from` ⇒ 整枚在窗口之前 ⇒ 原样复用（顶层节点铺满
   *   文档 ⇒ 相接的边界归窗口外那一枚，窗口重查拿不到它，正好不重不漏）；
   * · `start >= to` ⇒ 整枚在窗口之后 ⇒ 平移后复用；
   * · 其余 ⇒ 落在窗口里 ⇒ 作废，由窗口重查那一段顶上；
   * · 折叠槽的 `guard` 越过了窗口起点而这一槽本身在窗口之前 ⇒ 它的**止行依据**被改写了却没进窗口
   *   （`widenDirtyBand` 正常会把它拉进窗口；这里是它外扩到 8 轮封顶仍没拉住的兜底）⇒ 判不出来，整篇重算；
   * · 零宽槽正好压在边界上 ⇒ **判不出来**（它既可能属于窗口里那枚节点、也可能属于边界外那枚）
   *   ⇒ 回 null 走整篇。只有 MISSING 会零宽，正常击键碰不到这条线（残缺档的流对账量过）。
   *
   * 返回 `null` = 这一面这次别信缓存（缓存不闭合 / 横跨边界 / 归属判不出 / 拼装抛错）
   * ⇒ 调用方整篇重查并重建缓存。
   */
  private mergeFacet<T>(input: {
    readonly facet: 'semantic' | 'folds' | 'syntax';
    readonly cache: StructureFacetCache<T>;
    readonly window: StructureWindow;
    readonly shift: StructureShift;
    readonly produce: (node: Node, sink: StructureCacheSlot<T>[]) => void;
    readonly shiftValue: (value: T, deltaRows: number) => T;
    readonly maxValues: number;
  }): { values: T[]; cache: StructureFacetCache<T> } | null {
    if (!input.cache.complete) {
      this.noteFacet(input.facet, '缓存是被上限截出来的前缀 ⇒ 整篇重算');
      return null;
    }
    const { from, to } = input.window;
    try {
      const head: StructureCacheSlot<T>[] = [];
      const tail: StructureCacheSlot<T>[] = [];
      for (const slot of input.cache.slots) {
        if (slot.start === slot.end && (slot.end === from || slot.start === to)) {
          this.noteFacet(input.facet, '有零宽结果正好压在窗口边界 ⇒ 归属判不出，整篇重算');
          return null;
        }
        if (slot.end <= from) {
          if (slot.guard !== undefined && slot.guard > from) {
            this.noteFacet(
              input.facet,
              `窗口之前的折叠结果把止行依据伸进了改动窗口（槽 [${slot.start}..${slot.end}] 的依赖右端 ${slot.guard} > 窗口起点 ${from}）⇒ 整篇重算`,
            );
            return null;
          }
          head.push(slot);
        } else if (slot.start >= to) tail.push(slot);
        else if (slot.start < from || slot.end > to) {
          this.noteFacet(
            input.facet,
            `有结果横跨改动窗口边界（槽 [${slot.start}..${slot.end}] 出界于窗口 [${from}..${to}]，窗口 ${input.window.nodes.length} 枚节点）⇒ 整篇重算`,
          );
          return null;
        }
      }
      const fresh: StructureCacheSlot<T>[] = [];
      for (const node of input.window.nodes) input.produce(node, fresh);
      const shifted: StructureCacheSlot<T>[] =
        input.shift.deltaRows === 0 && input.shift.deltaOffsets === 0
          ? tail
          : tail.map((slot) => this.shiftSlot(slot, input.shift, input.shiftValue));
      const slots = head.length + shifted.length === 0 ? fresh : [...head, ...fresh, ...shifted];
      if (slots.length > input.maxValues) {
        this.noteFacet(input.facet, `拼完已经超过单文档上限 ${input.maxValues} ⇒ 整篇重算`);
        return null;
      }
      return { values: slots.map((slot) => slot.value), cache: { slots, complete: true } };
    } catch (error: unknown) {
      this.noteFacet(input.facet, `增量拼装抛错 ⇒ 这一面改走整篇：${reason(error)}`);
      return null;
    }
  }

  /**
   * 缩进规则：约定捕获名 `@indent.increase` / `@indent.decrease` / `@indent.enter`，
   * 每条取其节点**首行文本**并转成"整行精确匹配"的锚定正则源码交给宿主。
   * 查询里没有任何 `@indent.*` 捕获 ⇒ 三条腿都为空，宿主连配置都不重发。
   *
   * **这一面恒整篇**（文件头已写明）：产物是去重 + 排序的**集合**，窗口拼装少一条就是错；
   * 本语法的 `indents.scm` 没有捕获 ⇒ 装配阶段就回落 ⇒ 实测不耗时。
   */
  private indentRulesFrom(query: Query, root: Node): KojoStructureIndentRules {
    const increase = new Set<string>();
    const decrease = new Set<string>();
    const enter = new Set<string>();
    for (const capture of query.captures(root)) {
      const line = this.firstLineText(capture.node);
      if (line === null) continue;
      const pattern = anchoredPattern(line);
      if (capture.name === 'indent.increase') increase.add(pattern);
      else if (capture.name === 'indent.decrease') decrease.add(pattern);
      else if (capture.name === 'indent.enter') enter.add(pattern);
    }
    return {
      increasePatterns: [...increase].sort(),
      decreasePatterns: [...decrease].sort(),
      enterPatterns: [...enter].sort(),
    };
  }

  /** 节点覆盖范围里的首行文本（多行节点只取第一行——缩进判据本来就按行给） */
  private firstLineText(node: Node): string | null {
    const start = node.startIndex;
    const end = node.endIndex;
    if (end <= start || start < 0 || end > this.documentText.length) return null;
    const slice = this.documentText.slice(start, end);
    const newline = slice.indexOf('\n');
    const line = (newline >= 0 ? slice.slice(0, newline) : slice).trim();
    return line === '' ? null : line;
  }

  /**
   * 解完后把四面都发一遍（着色 / 折叠 / 缩进 / 结构残缺，四面各自独立可用、独立可回落）。
   *
   * `window = null` ⇒ 三面全部整篇重查并重建缓存；带窗口 ⇒ 只重查窗口里那几枚顶层节点，
   * 其余拿缓存拼（两条路的结果必须逐字相等，判据在 `tests/tree-sitter-parse.perf.test.ts`）。
   *
   * `doc` 是**原样回显**：引擎不判断它、不复用它，只是把请求里那枚跨文档隔离号带回四条回复
   * （对不上号是主线程 `client.ts` 的丢弃口径）——引擎里没有"当前文档"这个概念。
   */
  private emitAll(doc: KojoStructureDocSeq, version: number, window: StructureWindow | null, shift: StructureShift | null): void {
    if (this.tree === null) return;
    const root = this.tree.rootNode;
    const scoped = window !== null && shift !== null ? { window, shift } : null;

    if (this.highlightsQuery) {
      const started = this.stamp();
      const query = this.highlightsQuery;
      const tokens = this.tokensFace(query, root, scoped);
      this.elapsed('semanticQuery', started);
      if (tokens === null) {
        this.fail(version, 'parse', 'all', `单文档结构段数超过 ${KOJO_STRUCTURE_MAX_TOKENS} ⇒ 结构解析整档停用（这通常意味着语法层的错误恢复在长文件上跑飞了）`);
        return;
      }
      this.emit({ type: 'semantic', doc, version, tokens });
    }
    if (this.foldsQuery) {
      const started = this.stamp();
      const query = this.foldsQuery;
      const folds = this.foldsFace(query, root, scoped);
      this.elapsed('foldsQuery', started);
      this.emit({ type: 'folds', doc, version, folds });
    }
    if (this.indentsQuery) {
      const started = this.stamp();
      if (scoped !== null) this.noteFacet('indent', '缩进那一面的产物是集合 ⇒ 恒整篇重算（本语法该面无捕获，装配即回落，实测不耗时）');
      this.emit({ type: 'indent', doc, version, rules: this.indentRulesFrom(this.indentsQuery, root) });
      this.elapsed('indentQuery', started);
    }
    // 结构残缺（TSIT2-D）：这一面**自己包 try/catch**，且放在最后——遍历树是纯读，
    // 但它一旦抛错只该让"这一面没波浪线"，不该把已经发出去的三面一起带走（也不该抛进编辑器）。
    const started = this.stamp();
    try {
      const face = this.faultsFace(root, scoped);
      this.elapsed('syntaxScan', started);
      this.emit({ type: 'syntax', doc, version, faults: face.faults, truncated: face.truncated });
    } catch (error: unknown) {
      this.elapsed('syntaxScan', started);
      this.fail(
        version,
        'parse',
        'syntax',
        `结构残缺扫描失败 ⇒ 这一面这次不画波浪线（着色与折叠不受影响）：${reason(error)}`,
      );
    }
  }

  /** 着色这一面：窗口拼装 → 判据不过就整篇。返回 `null` = 撞到 `KOJO_STRUCTURE_MAX_TOKENS`（调用方据此整档停用） */
  private tokensFace(
    query: Query,
    root: Node,
    scoped: { window: StructureWindow; shift: StructureShift } | null,
  ): readonly KojoStructureToken[] | null {
    if (scoped !== null) {
      const merged = this.mergeFacet<KojoStructureToken>({
        facet: 'semantic',
        cache: this.tokenCache,
        window: scoped.window,
        shift: scoped.shift,
        produce: (node, sink) => {
          for (const capture of query.captures(node)) {
            const value = this.tokenValue(capture);
            if (value === null) continue;
            sink.push({ start: capture.node.startIndex, end: capture.node.endIndex, value });
          }
        },
        shiftValue: (value, delta) => this.shiftToken(value, delta),
        maxValues: KOJO_STRUCTURE_MAX_TOKENS,
      });
      if (merged !== null) {
        this.tokenCache = merged.cache;
        return merged.values;
      }
    }
    const slots: StructureCacheSlot<KojoStructureToken>[] = [];
    for (const capture of query.captures(root)) {
      const value = this.tokenValue(capture);
      if (value === null) continue;
      slots.push({ start: capture.node.startIndex, end: capture.node.endIndex, value });
      if (slots.length > KOJO_STRUCTURE_MAX_TOKENS) {
        this.tokenCache = NO_CACHE;
        return null;
      }
    }
    this.tokenCache = { slots, complete: true };
    return slots.map((slot) => slot.value);
  }

  /** 折叠这一面（约定 `@fold`，没有 `@fold` 时退化为"该模式的第一个捕获"） */
  private foldsFace(
    query: Query,
    root: Node,
    scoped: { window: StructureWindow; shift: StructureShift } | null,
  ): readonly KojoStructureFold[] {
    const preferred = query.captureNames.includes('fold');
    if (scoped !== null) {
      const merged = this.mergeFacet<KojoStructureFold>({
        facet: 'folds',
        cache: this.foldCache,
        window: scoped.window,
        shift: scoped.shift,
        produce: (node, sink) => {
          for (const capture of query.captures(node)) {
            const slot = this.foldSlot(capture, preferred);
            if (slot !== null) sink.push(slot);
          }
        },
        shiftValue: (value, delta) => this.shiftFold(value, delta),
        maxValues: KOJO_STRUCTURE_MAX_TOKENS,
      });
      if (merged !== null) {
        this.foldCache = merged.cache;
        return merged.values;
      }
    }
    const slots: StructureCacheSlot<KojoStructureFold>[] = [];
    for (const capture of query.captures(root)) {
      const slot = this.foldSlot(capture, preferred);
      if (slot === null) continue;
      slots.push(slot);
      if (slots.length > KOJO_STRUCTURE_MAX_TOKENS) break;
    }
    this.foldCache = slots.length > KOJO_STRUCTURE_MAX_TOKENS ? NO_CACHE : { slots, complete: true };
    return slots.map((slot) => slot.value);
  }

  /**
   * 结构残缺这一面（TSIT2-D）：窗口只走改动的那几枚顶层节点，其余拿缓存平移。
   *
   * 两种形状回整棵扫：根节点自己就是 ERROR/MISSING（整篇就是一处残缺，窗口装不住）、
   * 缓存不闭合（上一次被 64 处上限截断 ⇒ 补不出正确前缀，每击键老实扫全树）。
   */
  private faultsFace(
    root: Node,
    scoped: { window: StructureWindow; shift: StructureShift } | null,
  ): { faults: readonly KojoStructureSyntaxFault[]; truncated: boolean } {
    if (scoped !== null && !root.isError && !root.isMissing) {
      const merged = this.mergeFacet<KojoStructureSyntaxFault>({
        facet: 'syntax',
        cache: this.faultCache,
        window: scoped.window,
        shift: scoped.shift,
        produce: (node, sink) => this.collectFaults(node, sink),
        shiftValue: (value, delta) => this.shiftFault(value, delta),
        maxValues: KOJO_STRUCTURE_MAX_SYNTAX_FAULTS,
      });
      if (merged !== null) {
        this.faultCache = merged.cache;
        return { faults: merged.values, truncated: merged.values.length >= KOJO_STRUCTURE_MAX_SYNTAX_FAULTS };
      }
    } else if (scoped !== null) {
      this.noteFacet('syntax', '整棵树就是一处残缺 ⇒ 窗口装不住，整棵扫');
    }
    const slots = this.collectFaults(root, []);
    const truncated = slots.length >= KOJO_STRUCTURE_MAX_SYNTAX_FAULTS;
    this.faultCache = truncated ? NO_CACHE : { slots, complete: true };
    return { faults: slots.map((slot) => slot.value), truncated };
  }

  /**
   * 从一枚节点起收集残缺事实（TSIT2-D 的三条口径，一条都没改）：
   * 1. **不深入 ERROR 子树**：错误恢复把一整段读不通的内容挂成一枚 ERROR，里面可能还套着
   *    别的节点——那都是同一个错，逐个子节点再报就是给一个错画三条波浪线；
   * 2. **MISSING 认领到块头**：没收束词的块在回缩点 / 文末插一枚 MISSING 收束记号，
   *    那一点作者看不见（零宽），看得懂的是"哪一行开的那个块还开着" ⇒ 落点给块头行，
   *    残缺点另带给文案（"开到第几行"）；嵌套时各自父块就是最内层那一枚，天然报最里侧；
   * 3. **有界**：超过 {@link KOJO_STRUCTURE_MAX_SYNTAX_FAULTS} 处就截断并如实带上 `truncated`
   *    （宿主据此说一次），绝不把编辑器变成装饰刷。
   *
   * 增量口径：每槽记的是**出错节点自己**的码元跨度（不是展示行——MISSING 的展示行是块头行，
   * 但它真正跟着走的是插进去那一点）。逐层走的序 = 整棵扫的那个序 ⇒ 三段拼起来逐字一致。
   */
  private collectFaults(node: Node, sink: StructureCacheSlot<KojoStructureSyntaxFault>[]): StructureCacheSlot<KojoStructureSyntaxFault>[] {
    const walk = (current: Node): void => {
      if (sink.length >= KOJO_STRUCTURE_MAX_SYNTAX_FAULTS) return;
      if (current.isMissing) {
        const fault = this.missingFault(current);
        if (fault) sink.push({ start: current.startIndex, end: current.endIndex, value: fault });
        return;
      }
      if (current.isError) {
        sink.push({ start: current.startIndex, end: current.endIndex, value: this.errorFault(current) });
        return;
      }
      for (const child of current.children) walk(child);
    };
    walk(node);
    return sink;
  }

  /** MISSING 记号 ⇒ 一枚"块没有收盘"事实：落点 = 所在块的块头行 */
  private missingFault(node: Node): KojoStructureSyntaxFault | null {
    const parent = node.parent;
    const head = parent ? parent.childForFieldName('open') : null;
    const faultRow = node.startPosition.row;
    if (!head) {
      // 认不出块头（语法换了形状）：仍然报"这里有东西没等到"，但不编块头文案。
      // 类别沿用 {@link kindOfErrorLine} 那条**行面记号**判据（与 `errorFault` 同一个口径，
      // 不是新造判据）：本波之后没合上的台词引号 / 没闭合的插值由 ERROR 改产 MISSING
      // （`speech_close` 一类），这一支要是写死 `unexpected-token`，作者看到的就只剩"这行读不通"。
      // 输入取 parent 的首行文本——parent 为空或该行既无 `「` 也无 `{` 时它自然回
      // `unexpected-token`，零行为变化。**不许**改成读子节点类型判类别（理由见该函数头注）。
      // 落点口径一个都不动：仍是残缺点自己那一行，只是类别说得更准。
      return {
        row: faultRow,
        endRow: faultRow,
        column: node.startPosition.column,
        endColumn: node.startPosition.column + 1,
        kind: kindOfErrorLine(firstLine(parent ? parent.text : '')),
        faultRow,
        expectedToken: node.type,
      };
    }
    const headRow = head.startPosition.row;
    const headText = firstLine(head.text).trim();
    return {
      row: headRow,
      endRow: headRow,
      column: head.startPosition.column + leadingSpaces(head.text),
      endColumn: head.endPosition.column,
      kind: 'unclosed-block',
      faultRow,
      blockHeadText: headText,
      blockHeadRow: headRow,
      expectedToken: node.type,
    };
  }

  /** ERROR 节点 ⇒ 一枚按行文本分类的残缺事实 */
  private errorFault(node: Node): KojoStructureSyntaxFault {
    const text = node.text;
    const line = firstLine(text);
    const row = node.startPosition.row;
    return {
      row,
      endRow: node.endPosition.row,
      column: node.startPosition.column + leadingSpaces(text),
      endColumn: node.endPosition.column,
      kind: kindOfErrorLine(line),
      faultRow: node.endPosition.row,
    };
  }

  /* --------------------------------- 装配 --------------------------------- */

  /** 三份查询各编各的：一份编译失败只让那一面回落，不许连累另外两面 */
  private compileQueries(language: Language): void {
    const attempts: Array<{ source: string; name: 'highlights' | 'folds' | 'indents'; set: (q: Query) => void }> = [
      { source: this.assets.highlightsQuery, name: 'highlights', set: (q) => (this.highlightsQuery = q) },
      { source: this.assets.foldsQuery, name: 'folds', set: (q) => (this.foldsQuery = q) },
      { source: this.assets.indentsQuery, name: 'indents', set: (q) => (this.indentsQuery = q) },
    ];
    for (const attempt of attempts) {
      try {
        attempt.set(new Query(language, attempt.source));
      } catch (error: unknown) {
        this.fail(
          0,
          'query',
          attempt.name === 'highlights' ? 'semantic' : attempt.name === 'folds' ? 'folds' : 'indent',
          `${attempt.name} 查询编译失败：${reason(error)}（这一面由原有供给器继续负责）`,
        );
      }
    }
    if (this.foldsQuery && this.foldsQuery.captureNames.length === 0) {
      this.foldsQuery.delete();
      this.foldsQuery = null;
      this.fail(0, 'query', 'folds', 'folds 查询里没有带捕获的模式（约定用 @fold）⇒ 折叠这一面不由结构层供，继续走原有折叠');
    }
    if (this.indentsQuery && !this.indentsQuery.captureNames.some((n) => n.startsWith('indent.'))) {
      this.indentsQuery.delete();
      this.indentsQuery = null;
      this.fail(0, 'query', 'indent', 'indents 查询里没有 @indent.increase / @indent.decrease / @indent.enter 捕获 ⇒ 缩进这一面不由结构层供，继续走原有回车规则');
    }
  }

  /** 装载两枚 wasm 并编好三份查询；任何一步不成都回一条 `all`，返回 false（调用方不再投递解析） */
  async init(): Promise<boolean> {
    if (this.ready) return true;
    try {
      await Parser.init({ locateFile: () => this.assets.runtimeWasm });
    } catch (error: unknown) {
      this.fail(0, 'wasm', 'all', `结构解析运行时载入失败：${reason(error)}`);
      return false;
    }
    let language: Language;
    try {
      language = await Language.load(this.assets.kojoWasm);
    } catch (error: unknown) {
      this.fail(0, 'wasm', 'all', `.kojo 语法载入失败：${reason(error)}`);
      return false;
    }
    try {
      this.parser = new Parser();
      this.parser.setLanguage(language);
      this.compileQueries(language);
    } catch (error: unknown) {
      this.fail(0, 'wasm', 'all', `语法装配失败：${reason(error)}`);
      return false;
    }
    this.ready = true;
    this.emit({ type: 'ready', version: 0 });
    return true;
  }

  /* --------------------------------- 解析 --------------------------------- */

  /**
   * 报给 `tree.edit` 的编辑起点：真实起点，或在"编辑落在顶层边界上"时**往前推**到最近一枚
   * 还可能被这次改动接长的顶层节点。
   *
   * ## 为什么必须推（这是实测出来的解析器性质，不是保守起见）
   *
   * 落在改动区间**之前**的那些顶层节点，`tree.edit` 一说不改就被当成已经收束的成品复用掉，
   * 而"块头要不要把后面的内容吞进自己身体里"恰恰是由它**后面**的文本决定的 ⇒
   * 只报真实区间时，一枚本来该长成块的块头会永远停在"孤立块头"的形状上，
   * 这个错还会顺着旧树一路带下去（后续每一击都以它为依据）。
   * 等价闸实测（`tests/tree-sitter-incremental-fuzz.test.ts` 同一批编辑序列，只比 CST）：
   * 不推 = **53/1,800 步漂**，漂的形状清一色 `增量 timing_head@X / 整篇 block@X..Y`；
   * 按下述口径推 = **0/1,800 漂**。
   *
   * ## 推到哪儿（口径与代价）
   *
   * 只有"改动区间**之前**的那一枚节点"才有资格长成块（块头只能往前伸，不能往回缩），
   * 而块头与它即将吞下的正文之间只隔着一串空白行——本语法每条换行都由 `blank_line` 单独认领，
   * 空行拦不住块头。于是取：**从紧邻的那枚顶层节点起，往回吞掉连续的全空白顶层节点，
   * 再带上第一枚非空白顶层节点**。编辑落在顶层节点**内部**时不推（那一枚本来就要重解，
   * 它的块头判定会跟着一起重算）；推不出顶层节点（落进根节点的空白里）也不推，
   * 由 `buildWindow` 那条判据照常退回整篇。
   *
   * 代价 = 多解"一段空白 + 一枚顶层节点"，与文档规模无关（实测读数见 perf 池的 `reparseFrom`）。
   * 这正是文件头纪律"只会多算不会少算"的那一条：多算只贵，少算才错。
   */
  private reparseStart(
    oldRoot: Node,
    oldText: string,
    request: Extract<KojoStructureRequest, { type: 'change' }>,
  ): StructureReparseStart {
    const exact: StructureReparseStart = {
      index: request.start.offset,
      row: request.start.row,
      column: request.start.column,
    };
    if (request.start.offset <= 0) return exact;
    const node = this.topLevelAncestor(oldRoot, request.start.offset - 1);
    // 编辑落在顶层节点内部（或定位落空）⇒ 不推：那一枚节点自己会被重解，块头判定跟着重算
    if (node === null || node.endIndex > request.start.offset) return exact;
    let current = node;
    for (;;) {
      if (!isBlankRange(oldText, current.startIndex, current.endIndex)) break;
      const previous = current.previousSibling;
      if (previous === null) break; // 一路到文首都是空白
      current = previous;
    }
    return {
      index: current.startIndex,
      row: current.startPosition.row,
      column: current.startPosition.column,
    };
  }

  /**
   * 有界取字符回调：只给 `STRUCTURE_READ_CHUNK` 码元，**不**把文档尾巴整段复制给 wasm。
   * 顺带记下取字窗口（`reads` / `readStart` / `readEnd`），这是"增量到底局部不局部"的唯一现场证据。
   */
  private reader(text: string, stat: { reads: number; readStart: number; readEnd: number }) {
    return (index: number): string => {
      const chunk = text.slice(index, index + STRUCTURE_READ_CHUNK);
      stat.reads += 1;
      stat.readStart = Math.min(stat.readStart, index);
      stat.readEnd = Math.max(stat.readEnd, index + chunk.length);
      return chunk;
    };
  }

  /** 整篇重解（首份文档 / 切文档 / 上一次没有可用旧树时的重新对齐）；三面缓存跟着重建；`doc` = 跨文档隔离号，原样回显 */
  parse(doc: KojoStructureDocSeq, version: number, text: string): void {
    if (this.parser === null) return;
    this.tree?.delete();
    this.tree = null;
    this.documentText = text;
    this.forgetCaches();
    this.beginPass('none');
    const counters = { reads: 0, readStart: Number.POSITIVE_INFINITY, readEnd: 0 };
    const started = this.stamp();
    try {
      const next = this.parser.parse(this.reader(text, counters), null);
      this.elapsed('parse', started);
      if (next === null) {
        this.fail(version, 'parse', 'all', '解析器没有产出语法树（多半是语言未装配成功）⇒ 结构解析整档停用');
        return;
      }
      this.tree = next;
    } catch (error: unknown) {
      this.elapsed('parse', started);
      this.stat = this.statOf({
        incremental: false, reads: counters.reads, readStart: 0, readEnd: 0,
        editStart: 0, editEnd: text.length, documentLength: text.length,
      });
      this.fail(version, 'parse', 'all', `整篇解析抛错：${reason(error)}`);
      return;
    }
    this.beginPass('full');
    this.emitAll(doc, version, null, null);
    this.stat = this.statOf({
      incremental: false,
      reads: counters.reads,
      readStart: Number.isFinite(counters.readStart) ? counters.readStart : 0,
      readEnd: counters.readEnd,
      editStart: 0,
      editEnd: text.length,
      documentLength: text.length,
    });
  }

  /**
   * 增量重解：先按编辑把旧树推到位（`tree.edit`），再拿旧树解新文本，
   * 最后**只重查改动窗口**（窗口判据不过的那一面自己回整篇，读数里说得清）。
   *
   * 两种退化要分开看：**没有旧树**（首份 / 刚换文档）⇒ 整篇重解对齐一次，这不算失败；
   * **edit 或 parse 抛错** ⇒ 回一条 `all` 并且就此住口（见文件头纪律 2）。
   */
  change(request: Extract<KojoStructureRequest, { type: 'change' }>): void {
    if (this.parser === null) return;
    const nextText =
      this.documentText.slice(0, request.start.offset) + request.newText + this.documentText.slice(request.oldEnd.offset);
    if (this.tree === null) {
      this.parse(request.doc, request.version, nextText);
      return;
    }
    const counters = { reads: 0, readStart: Number.POSITIVE_INFINITY, readEnd: 0 };
    const oldTree = this.tree;
    let next: Tree | null = null;
    this.beginPass('none');
    const started = this.stamp();
    // 报给 tree.edit 的起点可以比真实编辑更早（理由见 {@link reparseStart}）；真实编辑区间
    // 仍然只用于缝合文本与坐标换算，两者不许混用。
    const reparse = this.reparseStart(oldTree.rootNode, this.documentText, request);
    this.lastReparseFrom = reparse.index;
    try {
      oldTree.edit(
        new Edit({
          startIndex: reparse.index,
          oldEndIndex: request.oldEnd.offset,
          newEndIndex: request.newEnd.offset,
          startPosition: { row: reparse.row, column: reparse.column },
          oldEndPosition: { row: request.oldEnd.row, column: request.oldEnd.column },
          newEndPosition: { row: request.newEnd.row, column: request.newEnd.column },
        }),
      );
      next = this.parser.parse(this.reader(nextText, counters), oldTree);
    } catch (error: unknown) {
      this.elapsed('parse', started);
      this.stat = this.statOf({
        incremental: true, reads: counters.reads, readStart: 0, readEnd: 0,
        editStart: request.start.offset, editEnd: request.newEnd.offset, documentLength: nextText.length,
      });
      oldTree.delete();
      this.tree = null;
      this.documentText = nextText;
      this.forgetCaches();
      this.fail(request.version, 'parse', 'all', `增量解析抛错 ⇒ 结构解析整档停用（不拿可疑的树继续着色）：${reason(error)}`);
      return;
    }
    this.elapsed('parse', started);
    if (next === null) {
      oldTree.delete();
      this.tree = null;
      this.documentText = nextText;
      this.parse(request.doc, request.version, nextText);
      return;
    }
    const rangesStarted = this.stamp();
    const shift = rowShift(request);
    this.beginPass('window');
    // 编辑碰了台词引号 ⇒ 这一趟**整篇**重查（`window = null` 就是既有那条"退回整篇"通道）。
    // 理由（2026-10-20 等价闸实测 7 步漂，全在行分类面）：`string` 现在是带子节点的规则，
    // 删掉一枚 `「` 会把两枚台词串**并成一枚**——合并后的跨度起点落在改动窗口**之外**，
    // 缓存里那条旧槽会被"整枚在窗口之后"平移复用 ⇒ 增量比整篇多出一条且永不自愈。
    // 引号编辑是低频动作，整篇代价只在这一次击键上付；换来的是"增量 == 整篇"这条硬等价。
    const quoteTouched =
      /[「」]/.test(request.newText) ||
      /[「」]/.test(this.documentText.slice(request.start.offset, request.oldEnd.offset));
    const window = quoteTouched
      ? null
      : this.buildWindow(oldTree, next, request, shift, nextText.length, reparse.index);
    this.elapsed('changedRanges', rangesStarted);
    oldTree.delete();
    this.tree = next;
    this.documentText = nextText;
    if (window === null) this.passScope = 'full';
    this.emitAll(request.doc, request.version, window, window === null ? null : shift);
    this.stat = this.statOf({
      incremental: true,
      reads: counters.reads,
      readStart: Number.isFinite(counters.readStart) ? counters.readStart : request.start.offset,
      readEnd: counters.readEnd,
      editStart: request.start.offset,
      editEnd: request.newEnd.offset,
      documentLength: nextText.length,
    });
  }

  /** 把"局部性 + 查询范围"两段凑成一份读数（两条路径共用一个形状，别各写各的） */
  private statOf(base: {
    incremental: boolean;
    reads: number;
    readStart: number;
    readEnd: number;
    editStart: number;
    editEnd: number;
    documentLength: number;
  }): StructureParseStat {
    return {
      ...base,
      queryScope: this.passScope,
      windowNodes: this.lastWindowNodes,
      changedRanges: this.lastRangeCount,
      reparseFrom: this.lastReparseFrom,
      queryFullReason: this.facetNotes.join(' / '),
    };
  }

  /** 三面缓存一起作废（整篇解之前与停用之后都要；作废不等于出错，下一次解会重新填） */
  private forgetCaches(): void {
    this.tokenCache = NO_CACHE;
    this.foldCache = NO_CACHE;
    this.faultCache = NO_CACHE;
    this.lastWindowNodes = 0;
    this.lastRangeCount = -1;
    this.lastReparseFrom = -1;
  }

  /**
   * 一次编辑之后"哪些顶层节点值得重查"。
   *
   * 返回 `null` = 这一趟别用缓存（问不出改动段、定位落进根节点的空白、窗口盖住半篇、
   * 或途中抛错）—— 调用方整篇重查，结果照样对，只是贵，并且理由写进读数。
   */
  private buildWindow(
    oldTree: Tree,
    next: Tree,
    request: Extract<KojoStructureRequest, { type: 'change' }>,
    shift: StructureShift,
    nextLength: number,
    reparseFrom: number,
  ): StructureWindow | null {
    this.lastRangeCount = -1;
    this.lastWindowNodes = 0;
    let ranges: ReturnType<Tree['getChangedRanges']>;
    try {
      // 口径：以**旧树**为调用者（0.27 里 `getChangedRanges(other)` 报的是"这棵树相对另一棵树
      // 变了哪些段"，拿新树去问旧树恒空，实测踩过）。旧树此刻已经 `edit` 过 ⇒ 正是它要求的状态。
      ranges = oldTree.getChangedRanges(next);
    } catch (error: unknown) {
      this.noteWindowFallback(`问旧树要改动段就抛错：${reason(error)}`);
      return null;
    }
    this.lastRangeCount = ranges.length;
    try {
      // 脏跨度（旧文本坐标系）= 旧树报的改动段 **并上** 本次编辑自己那一段（保守多算，理由见文件头）
      // 再并上"报给 tree.edit 的那一段"（{@link reparseStart} 往前推的起点）：那一段确实被重解过，
      // 落在其中的缓存条目若继续沿用，拼出来的就是新旧两版树的混血。
      let dirtyStart = Math.min(request.start.offset, reparseFrom);
      let dirtyEnd = request.oldEnd.offset;
      for (const range of ranges) {
        dirtyStart = Math.min(dirtyStart, range.startIndex);
        dirtyEnd = Math.max(dirtyEnd, range.endIndex);
      }
      // 再按缓存外扩一轮：与脏跨度相碰的每一条已缓存结果都必须**整枚**落进重查窗口
      [dirtyStart, dirtyEnd] = this.widenDirtyBand(dirtyStart, dirtyEnd);
      const limit = Math.max(0, nextLength - 1);
      const seedStart = clamp(shift.offsetToNewLeft(dirtyStart), 0, limit);
      const seedEnd = clamp(shift.offsetToNewRight(dirtyEnd), 0, limit);
      const nodes = this.topLevelNodesFor(next.rootNode, seedStart, seedEnd);
      if (nodes === null || nodes.length === 0) {
        this.noteWindowFallback('顶层节点定位落空（改动落在根节点的空白里）');
        return null;
      }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const documentRows = next.rootNode.endPosition.row + 1;
      const spanRows = last.endPosition.row - first.startPosition.row + 1;
      if (documentRows > 0 && spanRows * 2 > documentRows) {
        this.noteWindowFallback(`改动窗口盖住 ${Math.round((spanRows / documentRows) * 100)}% 的行 ⇒ 拼缓存不比整篇查便宜`);
        return null;
      }
      if (first.startIndex >= last.endIndex) {
        this.noteWindowFallback('窗口是零宽的一段 ⇒ 归属判不出');
        return null;
      }
      this.lastWindowNodes = nodes.length;
      return {
        nodes,
        from: clamp(shift.offsetToOldLeft(first.startIndex), 0, this.documentText.length),
        // 作废跨度的右端**不能只取窗口最后一枚节点的终点**：改动一直伸到文末时（删掉文末若干行），
        // `seedEnd` 被 `nextLength - 1` 夹住 ⇒ 窗口只能盖到新版文档的最后一个节点，而旧文本里
        // 落在"被删掉那一段"中的结果会满足 `start >= to` ⇒ 被当成窗口之后的条目**平移复用**，
        // 于是删掉的着色段凭空留在屏上（等价闸实测：增量比整篇多 1–2 条并且一路挂到序列末尾）。
        // 脏跨度的右端本来就 ≥ 本次编辑的旧区间末，取两者之大者即把那段删掉的区间盖住。
        to: Math.max(clamp(shift.offsetToOldRight(last.endIndex), 0, this.documentText.length), dirtyEnd),
      };
    } catch (error: unknown) {
      this.noteWindowFallback(`窗口判据抛错：${reason(error)}`);
      return null;
    }
  }

  /**
   * 脏跨度按缓存**外扩到不动点**（最多 8 轮）：与之相碰的每一条已缓存结果都必须整枚落进窗口。
   *
   * 为什么必须有这一步：本语法的块节点横跨几十行，一次行内改动会让**块本身**换形状，
   * 而旧树报的改动段只覆盖到改动附近 ⇒ 直接按报来的段开窗，会有一枚已经缓存好的块正好
   * 压在窗口边界上（实测 12 击里 4 击如此，那几击只能整篇重算）。外扩之后要么整枚进窗口
   * （由窗口重查顶上，结果照样与整篇逐字相等），要么真的盖不住（边界判据照样回整篇）——
   * 前者才是常态，也是这一条腿的意义所在。
   *
   * 折叠那一面另外带一条 `guard`（止行的依赖右端）参与判碰：见下面那段"只往左拉"的注释。
   */
  private widenDirtyBand(fromIn: number, toIn: number): readonly [number, number] {
    let from = fromIn;
    let to = toIn;
    for (let pass = 0; pass < 8; pass++) {
      let nextFrom = from;
      let nextTo = to;
      for (const slots of [this.tokenCache.slots, this.foldCache.slots, this.faultCache.slots]) {
        for (const slot of slots) {
          if (slot.end >= from && slot.start <= to) {
            if (slot.start < nextFrom) nextFrom = slot.start;
            if (slot.end > nextTo) nextTo = slot.end;
          }
        }
      }
      // 折叠槽的依赖右端（guard）只把窗口往**左**拉，把那一枚折叠拉进窗口重查（只有这样才算得出
      // 新止行）。有意**不**往右拉：右端一路是"这一枚的正文行正是下一枚的第一行"，会级联到整篇。
      for (const slot of this.foldCache.slots) {
        if (slot.guard === undefined || slot.guard < from || slot.start > to) continue;
        if (slot.start < nextFrom) nextFrom = slot.start;
      }
      if (nextFrom === from && nextTo === to) break;
      from = nextFrom;
      to = nextTo;
    }
    return [from, to];
  }

  /** 窗口走不下去时三面一起说（读数里同一句话只留一条，别刷三遍） */
  private noteWindowFallback(why: string): void {
    this.lastWindowNodes = 0;
    this.noteFacet('semantic', `${why} ⇒ 整篇重查`);
    this.noteFacet('folds', `${why} ⇒ 整篇重查`);
    this.noteFacet('syntax', `${why} ⇒ 整棵扫`);
  }

  /**
   * 新树里覆盖 `[startOffset, endOffset]` 的那几枚**顶层节点**，右端再带一枚（纯保险：
   * 让"正好压在边界上"的条目尽量落进窗口内部，而不是变成判不出归属的边界）。
   *
   * 定位走 `descendantForIndex` + 上溯到只剩一层（实测 0.01–0.18 ms），**不**走"枚举根的全部
   * 孩子"那条路（3,915 枚孩子的档上实测 4–6 ms，比要省下来的查询还贵）。
   * 落进根节点的空白（extras）⇒ 返回 null，调用方整篇重算。
   */
  private topLevelNodesFor(root: Node, startOffset: number, endOffset: number): readonly Node[] | null {
    const first = this.topLevelAncestor(root, startOffset);
    if (first === null) return null;
    const stopOffset = Math.max(startOffset, endOffset);
    const nodes: Node[] = [];
    let current: Node = first;
    for (let guard = 0; guard <= STRUCTURE_MAX_WINDOW_NODES; guard++) {
      nodes.push(current);
      if (current.endIndex >= stopOffset) {
        const extra = current.nextSibling;
        if (extra !== null) nodes.push(extra);
        return nodes;
      }
      const sibling: Node | null = current.nextSibling;
      if (sibling === null) return nodes;
      current = sibling;
    }
    this.noteWindowFallback(`窗口里超过 ${STRUCTURE_MAX_WINDOW_NODES} 枚顶层节点`);
    return null;
  }

  /** 包含这个码元偏移的**根的孩子**（上溯到只剩一层）；偏移落在根的空白里 ⇒ null */
  private topLevelAncestor(root: Node, index: number): Node | null {
    const node = root.descendantForIndex(index);
    if (node === null) return null;
    let current = node;
    for (;;) {
      const parent = current.parent;
      if (parent === null) return null; // 这一枚就是根 ⇒ 改动落在根自己的范围里，窗口装不住
      const grand = parent.parent;
      if (grand === null) return current; // 父就是根 ⇒ 这一枚是顶层孩子
      current = parent;
    }
  }

  dispose(): void {
    this.tree?.delete();
    this.tree = null;
    this.highlightsQuery?.delete();
    this.foldsQuery?.delete();
    this.indentsQuery?.delete();
    this.highlightsQuery = null;
    this.foldsQuery = null;
    this.indentsQuery = null;
    this.parser?.delete();
    this.parser = null;
    this.documentText = '';
    this.ready = false;
    this.stat = null;
    this.facetNotes = [];
    this.passScope = 'none';
    this.forgetCaches();
    this.reportedCaptures.clear();
  }
}

/**
 * 本次编辑的两套坐标换算。
 *
 * 口径与 `types.ts` 头注一致：行 = 0 基行号，偏移 = 0 基 UTF-16 码元（web-tree-sitter 的
 * `Edit.startIndex` 与 `Node.startIndex` 在 JS 绑定里就是字符串下标，代理对那条判据已钉）。
 * 落在被替换区间**内部**的坐标按左右端分别外夹 ⇒ 只会多算不会少算（少算才会错，多算只是贵）。
 */
function rowShift(request: Extract<KojoStructureRequest, { type: 'change' }>): StructureShift {
  const deltaRows = request.newEnd.row - request.oldEnd.row;
  const deltaOffsets = request.newEnd.offset - request.oldEnd.offset;
  const toOld = (offset: number, interior: number): number =>
    offset <= request.start.offset ? offset : offset >= request.newEnd.offset ? offset - deltaOffsets : interior;
  const toNew = (offset: number, interior: number): number =>
    offset <= request.start.offset ? offset : offset >= request.oldEnd.offset ? offset + deltaOffsets : interior;
  return {
    deltaRows,
    deltaOffsets,
    offsetToOldLeft: (offset) => toOld(offset, request.start.offset),
    offsetToOldRight: (offset) => toOld(offset, request.oldEnd.offset),
    offsetToNewLeft: (offset) => toNew(offset, request.start.offset),
    offsetToNewRight: (offset) => toNew(offset, request.newEnd.offset),
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 行文本 → 锚定正则源码（正则元字符逐个转义，不假定节点文本只用 `\w`） */
function anchoredPattern(line: string): string {
  const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^\\s*${escaped}$`;
}

/** 节点文本的首行（多行节点只看第一行——残缺落点本来就按行给） */
function firstLine(text: string): string {
  const newline = text.indexOf('\n');
  return newline >= 0 ? text.slice(0, newline) : text;
}

/** 行首空白宽度（波浪线从第一个非空白字符起画，不把缩进也算进"错的那一段"） */
function leadingSpaces(text: string): number {
  const matched = /^[ \t]*/.exec(text);
  return matched ? matched[0].length : 0;
}

/**
 * ERROR 节点首行文本 → 残缺类别（**只按行面文本判，不猜语法内部**）。
 *
 * 判据就是作者自己看得见的那两个记号：`「` 在 `{` 之前出现（或只有 `「`）⇒ 台词引号没合上；
 * 只有 `{` ⇒ 插值没闭合；两者都没有 ⇒ 说不清，老实报"这一行读不通"。
 * 为什么不在这里读子节点类型：语法包正在被另一条线改（子节点形状会变），
 * 而行面记号判据与 `.kojo` 的写形同寿——它漂了也只是归类变保守，不会报错到别的行上。
 */
function kindOfErrorLine(line: string): KojoStructureSyntaxKind {
  const quote = line.indexOf('「');
  const brace = line.indexOf('{');
  if (quote >= 0 && (brace < 0 || quote < brace)) return 'unterminated-string';
  if (brace >= 0) return 'unterminated-interp';
  return 'unexpected-token';
}
