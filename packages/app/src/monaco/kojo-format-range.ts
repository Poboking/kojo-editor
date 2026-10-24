import type * as Monaco from './entry';
import {
  computeFormatEdits,
  computeRangeFormatEdits,
  erbBodyRegionAtLineEnd,
  erbNewContentWithPrefix,
  type ErbBodyRegionKind,
  type FormatEdit,
} from '@kojo/plugin-kojo-sugar';
import { errorText, FULLWIDTH_SPACE } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from './erb-language';
import {
  toTextEdits,
  type FormatHandlers,
  type FormatRequest,
} from './kojo-format';

/**
 * 选区格式化 + 打字规范化（T13）——**只做"区间裁剪/编辑裁剪"这一层**。
 *
 * 规则与 edits 的唯一真源仍是插件侧的 `computeFormatEdits`（`kojo-format.ts` 头注
 * 同一款分工：宿主不认识缩进、不认识全角空格）。本模块**不抄一份规则**，只回答两个问题：
 *
 * 1. **区间请求该产哪些编辑**：整篇算一遍，再按行裁剪；宿主给了 {@link RangeFormatHandlers.resolveRange}
 *    时**只取要算的那几行**（PS-4，on-type 一次击键不再 copy 整篇）。
 *    为什么不把选区切出来单独算——ERB 形的规则是**逐行纯函数**（每行的新内容只依赖
 *    该行自身，见插件 `formatter.ts` 的 `erbNewContent`），"整篇算 + 按行裁剪"与
 *    "区间单独算"逐字节等价（钉在 `kojo-format-range.test.ts` 的等价性用例）；
 *    而整篇算还保住了跨行上下文（缩进单位探测、`@` 原生块状态），哪天规则长出
 *    跨行语义也不会从这条缝里漏出去。
 *    **这条论证对 `.kojo` 从来就不成立**（缩进单位探测与 `@` 块状态是文档级判据 ⇒ 宿主
 *    侧 `formatRequestWindowFor` 对 `.kojo` 一律交回 `null`），**对 ERB 也不再完全成立**：
 *    `559a878` 给 ERB 形长出了跨行的块状态（数据表块体 / 停用死区，见插件 `erbBodyLineMask`），
 *    切片视角看不见窗口起点之上的开词 ⇒ 会把整篇腿明确保护的字节改掉。于是窗口这条腿
 *    多了下面第 3 项那道**前推锚点**的闸（不是放宽判据，是补上切片缺的那一段上下文）。
 *    成本口径：老路 O(行数)×(一次整篇文本拷贝)，新路 O(请求行数) + **一趟** O(前缀行数) 的
 *    状态机扫描（只在"切片这一腿真的想改字节"时才付；零编辑的单行窗口连扫描都不用跑）。
 * 2. **编辑绝不越界**：`FormatEdit` 本身永不跨物理行（插件规则第 3 条），所以裁剪
 *    就是行号过滤，天然精确；裁剪后每条编辑都落在 `[startLine, endLine]` 内。
 *    块级对齐超出选区的问题在 ERB 形不存在（ERB 规则本就不跨行对齐）；
 *    若未来出现，答案也是"降级为行内规范化"，不是放宽裁剪。
 * 3. **切片必须与整篇同判据**（本批补的口子）：
 *    - **单行**（on-type 每次击键 / 单行选区）：{@link singleLineWindowEdits} 把前缀**按行数组**
 *      喂进插件 `erbNewContentWithPrefix`，一趟同时拿到末态掩码（块体 / 死区）与块层级——与整篇
 *      腿的 `erbBodyLineMask` / `erbIndentPlan` 是**同一台**状态机（没有第二份判据），只算目标行。
 *      前缀行直接读 `model.getLineContent`（**不拼 5 万行大字符串**，也不再为探前缀多取一次窗口），
 *      于是这一击键的窗口取文就是**触发行那 1 次**。改前这条腿不吃前缀 ⇒ IF/块体里的 on-type
 *      拿不到层级，缩进规则在该行静默失效（只折全角空白）。
 *    - **多行**：{@link prefixContext} 拿"整篇第 1 行到窗口之前"那段整行前缀问同一台状态机的
 *      `erbBodyRegionAtLineEnd` 投影——末态在区里就把取文起点**前推到最外层区首标记行**，从那里
 *      喂进去时状态机必然处于"区外"，区段轨迹与整篇逐字重合；末态在区外则把同一段前缀交给插件
 *      `computeRangeFormatEdits` 推块层级，前缀只参与判据、一个字节都不进 edits。
 *    问不到（宿主没给前缀腿 / 抛错 / 方言不是 ERB）就**交回整篇那条腿**，绝不"当作区外"放行。
 *    唯一的免检通道：`startLine === endLine` 且切片判零编辑——逐行规则一个字节都不会改，于是
 *    连前缀都不问（PS-4 的单价前提）。**边界**：这种行若落在 IF 块体里且"逐行视角已经规范"，
 *    整篇腿仍会改成块体缩进，这一小类主动让掉——on-type 的触发字符（`;` / 全角空格）触发时该行
 *    通常已有切片编辑，会走上面那条带块上下文的腿。
 *
 * on-type 触发字符只有两个，宁缺毋滥：
 * - `;`：ERB 整行注释的成形点（去缩进后以 `;` 开头才算注释，成形即折注释区全角）；
 * - `　`（U+3000）：行首缩进 / 注释区里"刚打出全角空格"的那一刻（折半角）。
 * 打字中不会乱跳的依据：行中 `;`（打印文本/代码里）不构成整行注释 ⇒ 零编辑；
 * 台词正文里的 U+3000 不在缩进/注释区 ⇒ 零编辑。拿不准的字符一律不注册。
 */

/** on-type 触发字符（注册进 Monaco 的 `autoFormatTriggerCharacters`） */
export const ON_TYPE_TRIGGER_CHARACTERS = [';', FULLWIDTH_SPACE];

/**
 * 行区间裁剪：只留落在 `[startLine, endLine]` 内的编辑。
 * 区间倒置（start > end）⇒ 空（没有任何"合法区间"，宁可不做也不猜方向）。
 */
export function clipFormatEditsToLines(
  edits: readonly FormatEdit[],
  startLine: number,
  endLine: number,
): FormatEdit[] {
  if (startLine > endLine) return [];
  return edits.filter((e) => e.line >= startLine && e.line <= endLine);
}

/**
 * 区间版格式化：同一核心算整篇，按行裁剪（单一真源，见模块头注）。
 *
 * 规则开关随请求走（`request.rules` 直传插件第三参；`undefined` = 全开，与改前逐字节等价）
 * ——整篇腿（`kojo-format.ts` 的 `installDocumentFormatter`）早就这么传，本腿此前漏了，
 * 于是偏好关掉的规则在区间格式化里静默失效。
 */
export function formatRangeEdits(
  request: FormatRequest,
  startLine: number,
  endLine: number,
): FormatEdit[] {
  return clipFormatEditsToLines(
    computeFormatEdits(request.text, request.dialect, request.rules),
    startLine,
    endLine,
  );
}

/**
 * edits 的行号平移（窗口坐标 → 全文坐标）。
 *
 * `request.text` 只装 `[startLine, endLine]` 那几行时，规则层数出来的第 1 行就是全文的
 * 第 `startLine` 行 ⇒ 交回前必须平移，否则编辑会落到隔壁行上去（`toTextEdits` 只会夹取
 * 到模型现实，夹不出"正确的行"）。零偏移原样交回，不多拷一次数组。
 */
export function offsetFormatEdits(edits: readonly FormatEdit[], lineOffset: number): FormatEdit[] {
  if (lineOffset === 0) return [...edits];
  return edits.map((edit) => ({ ...edit, line: edit.line + lineOffset }));
}

/**
 * **窗口通道**（PS-4，additive）：宿主可选提供的"只给要算的那几行"取文腿。
 *
 * 为什么可以只给几行（ERB 形专属）：`kojo-sugar/formatter.ts` 的 `newContents` 在
 * `dialect === 'erb'` 分支里逐行调 `erbNewContent`——**每行的新内容只依赖该行自身**，
 * 所以"整篇算 + 按行裁剪"与"只把这几行喂进去算 + 平移行号"逐字节等价。这条等价性仓库早就钉在
 * `tests/kojo-format-range.test.ts`（区间切片 ≡ 整篇裁剪），PS-4 把同一个判据用到"取文也只取
 * 那几行"上，并在 `tests/ps4-provider-seams.test.ts` 里对**窗口路径**再钉一遍（全区间扫描逐字节
 * 对照，含 CRLF 与最后一行两个易错点），单价差在 `tests/ps4-provider-seams.perf.test.ts`
 * （PS-4 那一批的读数：52,601 行一次击键 72–86 ms → 0.007 ms；本批落完之后同一枚闸的读数是
 * 25.2 ms → 4.2 ms——那一击正落在"要改字节"的分支上，见下面的单价表）。
 *
 * **`559a878` 之后这条等价性多了一个前提**：ERB 形长出了跨行的块状态（数据表块体 / 停用死区），
 * 切片看不见起点之上的开词就会把保护区当成区外。于是本模块加上 {@link windowAnchor}：
 * 切片真想改字节时先问一次前缀末态，落在区里就把取文起点前推到最外层区首——**问不到就交回
 * 整篇那条腿**，绝不"当作区外"放行。
 *
 * 单价（真语料五档、同窗交替各 9 轮取中位；触发点一律取"文档 60% 之后第一条会被逐行规则改写"的行；
 * 三列 = 免检通道 / 本批这条腿真落笔那一击 / 退回整篇那条腿＝落法①）：
 * 500 行 0.003 / 0.044 / 0.291 ms · 2,500 行 0.004 / 0.271 / 1.458 ms ·
 * 10,006 行（p99 档）0.010 / 1.658 / 6.696 ms · 30,499 行 0.030 / 3.441 / 21.513 ms ·
 * 52,602 行（语料之最）0.021 / 8.102 / 38.886 ms。
 * 读法：**零编辑的击键仍然只付一行的代价**，真要落笔的那一击付 O(起点之前) 的状态机扫描 ⇒
 * 比落法①便宜 4.0–6.6 倍、比改前那条有分叉的腿贵 15–386 倍。这条线确实变贵了，
 * 变贵多少写在上面这张表里，不是悄悄变贵（合成档的闸读数在 `ps4-provider-seams.perf.test.ts`）。
 *
 * 为什么 `.kojo` 不走这条（宿主侧交回 `null` = 请走整篇那条腿）：那边的缩进单位探测与
 * `@` 原生块状态是**文档级**判据（判据本体见 `kojo-format.ts` 的区间格式化头注），
 * 片段视角会数错多数派、会把块内行当糖行重排。
 *
 * **不提供本腿的宿主 = 行为与本批前逐字一致**（`resolve` + 整篇裁剪），既有调用方零改动。
 */
export interface RangeFormatHandlers extends FormatHandlers {
  resolveRange?(model: Monaco.editor.ITextModel, startLine: number, endLine: number): FormatRequest | null;
  /**
   * "这次没格式化"的作者面出口（additive；形状与接线口径照 `monaco/completion-core.ts` 的
   * `onDegrade`——**可选注入 + 双通道**，旧调用方零改动）。
   *
   * 本模块**只负责把话说出来**（四个降级点 + 前推锚点问不到，共五处），递到屏幕上哪一格由
   * 宿主决定：现网宿主接的是 `ui/format-notice-ledger.ts` 那枚**一次性台账**（去重键 = `where` +
   * 行区间 ⇒ 同一处让路一次会话只上一条；上屏走壳层既有的通知中心，不新开显示面），
   * **十句人话全部住在那一枚表里**——本模块一个上屏句子都不写，出口仍是且仅是
   * `console.warn` + 这一枚回调（静态闸见 `tests/format-notice-ledger.test.ts` 的分层守卫）。
   * 没接它的宿主 = 只走 `console.warn`，与改前逐字一致。
   */
  onDegraded?(notice: FormatDegradationNotice): void;
}

/** 一次"这次没格式化"的说明（`where` = 哪一个降级点，`reason` = 已 `errorText` 过的原文） */
export interface FormatDegradationNotice {
  readonly where: 'resolve' | 'compute' | 'resolveRange' | 'windowCompute' | 'anchor';
  readonly stage: 'range' | 'onType';
  readonly startLine: number;
  readonly endLine: number;
  readonly reason: string;
}

/** 打字规范化 / 选区格式化这两条入口（写进 `notice`，作者面才说得出是哪一次请求） */
type FormatStage = FormatDegradationNotice['stage'];

/**
 * 五处降级都不许静默：`console.warn`（开发者面，机器可对齐的前缀）+ `onDegraded`（可断言、
 * 宿主可上屏）。回调自己抛错不许把格式化请求打断——它只是呈现面。
 */
function degrade(handlers: RangeFormatHandlers, stage: FormatStage, notice: Omit<FormatDegradationNotice, 'stage'>): void {
  const full: FormatDegradationNotice = { ...notice, stage };
  console.warn(
    `[kojo-format-range] ${full.where} 在 ${full.stage} 请求里让了路（第 ${full.startLine}–${full.endLine} 行）：${full.reason}`,
  );
  try {
    handlers.onDegraded?.(full);
  } catch {
    /* 呈现面抛错不许打断编辑 */
  }
}

/** 复用整篇格式化的宿主判断 + 规则层，出错就"这次不做"（不许掀编辑器的桌子） */
function resolveSafely(
  handlers: RangeFormatHandlers,
  model: Monaco.editor.ITextModel,
  stage: FormatStage,
): FormatRequest | null {
  try {
    return handlers.resolve(model);
  } catch (e: unknown) {
    degrade(handlers, stage, {
      where: 'resolve',
      startLine: 1,
      endLine: model.getLineCount(),
      reason: errorText(e),
    });
    return null;
  }
}

function computeSafely(
  handlers: RangeFormatHandlers,
  request: FormatRequest,
  startLine: number,
  endLine: number,
  stage: FormatStage,
): FormatEdit[] {
  try {
    return formatRangeEdits(request, startLine, endLine);
  } catch (e: unknown) {
    degrade(handlers, stage, { where: 'compute', startLine, endLine, reason: errorText(e) });
    return [];
  }
}

/** 窗口文本 → 全文坐标的编辑表（`offset` = 窗口第一行在整篇里的 1 基行号 - 1） */
function windowEdits(
  request: FormatRequest,
  lineOffset: number,
  startLine: number,
  endLine: number,
  prefix?: string,
): FormatEdit[] {
  // 平移回全文坐标后再裁一次：窗口文本本来就只盖这几行，这道裁剪是"绝不越界"那条
  // 不变式的显式钉子（规则哪天长出跨行状态时，它先红在这里而不是改到隔壁行）。
  // `prefix` = 选区之前的整行前缀（缺省 ⇒ 插件层与 `computeFormatEdits` 逐字等价）。
  // 规则开关同样随请求走（第四参；`undefined` = 全开 ⇒ 与改前逐字节等价）。
  const context = prefix === undefined ? {} : { prefix };
  return clipFormatEditsToLines(
    offsetFormatEdits(
      computeRangeFormatEdits(request.text, request.dialect, context, request.rules),
      lineOffset,
    ),
    startLine,
    endLine,
  );
}

/** 宿主窗口通道的调用签名（`RangeFormatHandlers.resolveRange` 去掉可选，便于当参数传） */
type WindowResolveRange = NonNullable<RangeFormatHandlers['resolveRange']>;

/** 选区之前的整行前缀：`text` 喂给插件层补块层级，`region` 是喂完后块状态机的末态 */
interface PrefixContext {
  readonly text: string;
  readonly region: { kind: ErbBodyRegionKind; openLine: number } | null;
}

/**
 * 取 `[1, startLine-1]` 这段**整行前缀**（块层级与块末态都从这一段来）。
 *
 * - `startLine <= 1` ⇒ 空串（选区从篇首起，插件层据此与整篇腿逐字等价）。
 * - 契约要求前缀末行带行尾，而 `getValueInRange` 止于最后一列 ⇒ 按文档 EOL（`getEOL()`）补一个，
 *   否则选区首行会被粘到前缀末行上（插件层不猜，见 `RangeFormatContext` 的契约）。
 * - 块末态在区外 ⇒ 切片判据与整篇腿**可证等价**；在区里 ⇒ `region.openLine` 就是最外层区首，
 *   调用方从那里起喂才让切片起点的状态与整篇对齐。
 * - `null` = **问不到**（宿主没给前缀这段 / 交回的不是 ERB）⇒ 调用方交回整篇那条腿；
 *   这里绝不把"问不到"当成"区外"——那正是本批要关的口子。
 *
 * 这条腿只服务**多行选区**：单行（on-type）走 {@link singleLineWindowEdits}——那边按行数组
 * 喂块状态机，一趟就拿到末态掩码与层级，不再需要这里的 `region` 探针。
 */
function prefixContext(
  resolveRange: WindowResolveRange,
  model: Monaco.editor.ITextModel,
  startLine: number,
): PrefixContext | null {
  if (startLine <= 1) return { text: '', region: null };
  const prefix = resolveRange(model, 1, startLine - 1);
  if (!prefix || prefix.dialect !== 'erb') return null;
  const region = erbBodyRegionAtLineEnd(prefix.text);
  const eol = model.getEOL?.() === '\r\n' ? '\r\n' : '\n';
  return { text: `${prefix.text}${eol}`, region };
}

/**
 * 单行窗口（on-type 的每一击键 / 单行选区）：**块层级与保护区判据与整篇腿同一套**。
 *
 * 改前这条腿不吃前缀：IF/块体里的 on-type 拿不到层级，缩进规则在该行静默失效
 * （只折全角空白）。现在把前缀按行喂给插件 `erbNewContentWithPrefix`——它内部仍是
 * `erbBodyLineMask` / `detectErbIndentUnit` / `erbIndentPlan` / `erbNewContent` 一台状态机
 * （**没有第二份判据**），只算目标行的产物。
 *
 * 成本口径：一次 O(前缀行数) 的行数组扫描，**一趟顶两趟**——它同时给出末态掩码与层级；
 * 前缀行**直接读 model**（`getLineContent`），既不拼 5 万行大字符串，也**不向宿主再要一次
 * 前缀窗口**（改前那趟 `resolveRange(1, startLine-1)` 拼出的 2.35 MB 串随后被丢弃，纯白付）。
 * 于是这次击键的窗口取文只有触发行那 **1 次**（见 `ps4-provider-seams.test.ts` 的观测断言）。
 *
 * 模型没有逐行取文这条腿（老 model）⇒ 不为了前缀去拼大串，直接交回整篇那条腿（结果等价，
 * 只是这一次贵一点）；读行 / 计算抛错同样交回，绝不当成"区外"放行。
 *
 * `slice` = 不带前缀的单行切片（调用方已算好）：目标行是第 1 行（没有前缀）时它与带前缀
 * 逐字等价，直接交回，省掉一次空扫描。
 */
function singleLineWindowEdits(
  handlers: RangeFormatHandlers,
  model: Monaco.editor.ITextModel,
  request: FormatRequest,
  lineNumber: number,
  slice: readonly FormatEdit[],
  stage: FormatStage,
): FormatEdit[] | null {
  if (lineNumber <= 1) return [...slice];
  if (typeof model.getLineContent !== 'function') {
    degrade(handlers, stage, {
      where: 'anchor',
      startLine: lineNumber,
      endLine: lineNumber,
      reason: '模型没有逐行取文这条腿（前缀只能整段拼串）⇒ 交回整篇那条腿',
    });
    return null;
  }
  try {
    const prefixLines: string[] = new Array<string>(lineNumber - 1);
    for (let i = 0; i < lineNumber - 1; i++) prefixLines[i] = model.getLineContent(i + 1);
    // 窗口文本只该是这一行：行尾（若宿主带了）不属于行内容
    const content = request.text.replace(/\r\n$|\r$|\n$/, '');
    const next = erbNewContentWithPrefix(prefixLines, content, request.rules);
    if (next === null) return [];
    return [{ line: lineNumber, startColumn: 1, endColumn: content.length + 1, text: next }];
  } catch (e: unknown) {
    degrade(handlers, stage, { where: 'anchor', startLine: lineNumber, endLine: lineNumber, reason: errorText(e) });
    return null;
  }
}

/**
 * 窗口那条腿（PS-4）：宿主给了 `resolveRange` 就只算要算的那几行。
 *
 * 返回 `null` = **这条腿这次不适用**（宿主没给窗口通道 / 窗口不应答 / 取文抛错 / 锚点问不到），
 * 调用方据此退回整篇那条腿——"不适用"与"算过了、没有编辑"（返回 `[]`）是两件事，
 * 混成一件会让"该零编辑"看起来像"没算"。
 */
function computeWindowSafely(
  handlers: RangeFormatHandlers,
  model: Monaco.editor.ITextModel,
  startLine: number,
  endLine: number,
  stage: FormatStage,
): FormatEdit[] | null {
  const resolveRange = handlers.resolveRange;
  if (!resolveRange) return null;
  let request: FormatRequest | null;
  try {
    request = resolveRange(model, startLine, endLine);
  } catch (e: unknown) {
    degrade(handlers, stage, {
      where: 'resolveRange',
      startLine,
      endLine,
      reason: errorText(e),
    });
    return null;
  }
  if (!request) return null;
  // 窗口这条腿的等价性只对 ERB 论证过（`.kojo` 的文档级判据切片会数错）；宿主本来也只在
  // ERB 上应答，这里再钉一枚闸：方言不是 ERB ⇒ 交回整篇那条腿，不走窗口。
  if (request.dialect !== 'erb') return null;
  try {
    const slice = windowEdits(request, startLine - 1, startLine, endLine);
    // 免检通道（保留，PS-4 的单价前提）：单行窗口的切片判零编辑 ⇒ 逐行规则一个字节都不会改。
    // 边界（诚实写在案）：块层级**能**在这条通道之外再加一刀——一行"逐行视角已经规范"（例如
    // 半角 2 空格缩进、无全角空白）的语句若落在 IF 块体里，整篇腿会把它改成块体缩进。这种行
    // 只有真的付一趟 O(前缀) 扫描才判得出；而 on-type 的触发字符是 `;` / 全角空格，触发时该行
    // 通常已有切片编辑（折全角 / 折注释）⇒ 走下面那条带块上下文的腿。主动让掉的是"零切片编辑
    // 却在块里"这一小类，代价是击键常态（`;` 注释行、台词里的全角空格）一次扫描都不跑。
    if (slice.length === 0 && startLine === endLine) return [];
    if (startLine === endLine) {
      // 单行：块层级 / 保护区要一趟 O(前缀) 扫描，前缀按行直读 model（见 `singleLineWindowEdits`）
      return singleLineWindowEdits(handlers, model, request, startLine, slice, stage);
    }
    // 选区之前的整行前缀：插件的块状态机（层级 / 保护区）与整篇腿同判据的唯一来路。
    // 问不到 ⇒ 交回整篇那条腿（绝不"当作区外"放行）。
    const prefix = prefixContext(resolveRange, model, startLine);
    if (prefix === null) {
      degrade(handlers, stage, {
        where: 'anchor',
        startLine,
        endLine,
        reason: '前缀末态问不到（窗口腿没有前缀这段）⇒ 交回整篇那条腿',
      });
      return null;
    }
    // 带上前缀重算：IF/块层级由前缀推出来，选区外的字节仍一个都不进 edits（插件层只回选区行）。
    const anchored = prefix.text.length === 0 ? slice : windowEdits(request, startLine - 1, startLine, endLine, prefix.text);
    const anchorLine = prefix.region === null ? startLine : prefix.region.openLine;
    if (anchorLine === startLine) return anchored;
    // 窗口起点落在块体/死区里 ⇒ 取文起点前推到最外层区首，再从那里算（保护区一个字节都不许动）
    const ctx = resolveRange(model, anchorLine, endLine);
    if (!ctx || ctx.dialect !== 'erb') return null;
    const ctxPrefix = prefixContext(resolveRange, model, anchorLine);
    if (ctxPrefix === null) return null;
    return windowEdits(ctx, anchorLine - 1, startLine, endLine, ctxPrefix.text);
  } catch (e: unknown) {
    degrade(handlers, stage, { where: 'windowCompute', startLine, endLine, reason: errorText(e) });
    return [];
  }
}

/** 行号夹进 1..lineCount（provider 与用户编辑间没有锁，陈旧区间夹取不抛错） */
function clampLine(line: number, lineCount: number): number {
  return Math.min(Math.max(1, Math.trunc(line) || 1), lineCount);
}

/**
 * 为 ERB 语言注册两个 provider：
 * - `Ctrl+K Ctrl+F`（Monaco 内建 `editor.action.formatSelection`）→ 区间格式化；
 * - 触发字符（`;` / 全角空格）打字后 → 该行的行内规范化。
 *
 * 只注册 `ERB_LANGUAGE_ID`：整篇格式化已覆盖两个语言（`installDocumentFormatter`），
 * 这两个新入口的语义保守面是按 ERB 形（逐行纯）论证的，`.kojo` 不搭这班车。
 * `.kojo` 的区间格式化走 `kojo-format.ts::installRangeFormatter`（一门语言一枚 provider，
 * 两侧不得同时注册 ERB——否则选区结果由注册表顺序决定，本模块的宿主判据会被绕过）。
 */
export function installRangeFormatter(
  monaco: typeof Monaco,
  handlers: RangeFormatHandlers,
): Monaco.IDisposable {
  const rangeProvider: Monaco.languages.DocumentRangeFormattingEditProvider = {
    provideDocumentRangeFormattingEdits(model, range) {
      const lineCount = model.getLineCount();
      const startLine = clampLine(range.startLineNumber, lineCount);
      const endLine = clampLine(range.endLineNumber, lineCount);
      const windowed = computeWindowSafely(handlers, model, startLine, endLine, 'range');
      if (windowed !== null) return toTextEdits(model, windowed);
      const request = resolveSafely(handlers, model, 'range');
      if (!request) return [];
      return toTextEdits(model, computeSafely(handlers, request, startLine, endLine, 'range'));
    },
  };

  const onTypeProvider: Monaco.languages.OnTypeFormattingEditProvider = {
    autoFormatTriggerCharacters: [...ON_TYPE_TRIGGER_CHARACTERS],
    provideOnTypeFormattingEdits(model, position) {
      // 一次打字只该算**触发行那一行**（PS-4）：走 `resolveRange` 时整篇文本一次都不 copy；
      // 老路（整篇算 + 裁一行）留着兜底，判据与结果与改前逐字相同。
      const line = clampLine(position.lineNumber, model.getLineCount());
      const windowed = computeWindowSafely(handlers, model, line, line, 'onType');
      if (windowed !== null) return toTextEdits(model, windowed);
      const request = resolveSafely(handlers, model, 'onType');
      if (!request) return [];
      return toTextEdits(model, computeSafely(handlers, request, line, line, 'onType'));
    },
  };

  const subs = [
    monaco.languages.registerDocumentRangeFormattingEditProvider(ERB_LANGUAGE_ID, rangeProvider),
    monaco.languages.registerOnTypeFormattingEditProvider(ERB_LANGUAGE_ID, onTypeProvider),
  ];
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
