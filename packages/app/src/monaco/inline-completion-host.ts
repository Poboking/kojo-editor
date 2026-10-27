import type * as Monaco from './entry';
import type {
  GameProject,
  InlineCompletionCandidate,
  InlineCompletionOutcome,
  InlineCompletionRequest,
  InlineCompletionSourceContribution,
} from '@kojo/plugin-api';
import { registerForLanguageServices } from './register-dialects';
import {
  codeViewAt,
  cursorReasonBreaksTypingLeg,
  sharedSuggestGates,
  singleInsertedChar,
} from './suggest-context-trigger';
import { lineAt } from './kojo-completion-position';

/**
 * 内联补全（幽灵文本）的**宿主接线层**（IC 批 A 车道，2026-10-27）。
 *
 * 一句话：把 Monaco 的 `languages.registerInlineCompletionsProvider` 那条通道接到槽
 * `completion.source` 上。契约（`plugin-api/inline-completion.ts`）只定义"供方说什么"，
 * 本模块定义"宿主怎么问、怎么落地、什么时候干脆不问"。
 *
 * ## 为什么注册走 `registerForLanguageServices`（且**不传** `kind`）
 *
 * 「宿主侧能力对一等语言拉平」是契约，那 11 枚 provider 都从那一处收口。这一枚同理：
 * 只有 `languageServices: true` 的语言（ERB / `.kojo`）拿到幽灵文本——正是组长的裁决
 * 「默认 on，但只对声明了 `languageServices` 的一等语言生效」。
 * **刻意不传 `kind`**：`SlotServiceKind` 里没有 `inlineCompletion` 这一档，而 `kojo2` 的
 * descriptor 只点名了 `documentSymbol` / `inlayHint` / `definition` 三条腿。要挂它得先改
 * 语言注册表的枚举 + descriptor 声明（那是"谁为 2.0 供候选"的前置事实，目前无人供），
 * 不是在这里顺手铺满——那 11 枚的教训就写在 `register-dialects.ts` 的头注里。
 *
 * ## 为什么宿主侧**不**用名字位探针（闸门 ⑩ 的对面是契约的弃权）
 *
 * 弹窗那条腿是**宿主替作者按键**，弹了没货就是骚扰，所以它必须问候选源自己认的名字位。
 * 幽灵文本这一条腿不一样：Monaco 自己决定何时问，而"这家不认这一位"在契约里有**专门的一态**
 * （`provideInline` 回 `undefined` = 弃权，宿主继续问下一家）。把名字位探针再铺一层，等于用
 * 弹窗的落点假设去限制幽灵文本的候选面——"整句 / 下一行"那一类候选会在这里被掐死，而掐它的
 * 判据根本不是供方的判据。所以本模块共用的是 ⑫①–⑤（{@link sharedSuggestGates}）与语言的
 * 代码位门（{@link codeViewAt}：`.kojo` 的台词 / 旁白 / 注释、ERB 的串 / 注释），⑩ 那一副留给
 * 弹窗自己（单一真源在 `suggest-context-trigger.ts`，"同一判据只许定义一次"由
 * `tests/inline-completion-single-source.test.ts` 按源码文本钉住）。
 *
 * ## 三态与"第一家说了算"
 *
 * 按 `order` 逐家问：`undefined`（弃权）/ `no-completion`（看过并确认没有）/ `failed`（这一家
 * 缺席）都**继续问下一家**，只有 `candidates` 停下。多家轮流 = 天然的降级阶梯。
 * 空数组的 `candidates` 是**契约违规**：出声并丢弃，不当作 `no-completion` 悄悄咽下（铁律 4）。
 *
 * ## 过期只有一条判据
 *
 * 请求带 `version`（`model.getVersionId()`）。落地前比对两件事：
 * ① 供方回带的 `version` 不等于请求的 ⇒ 它拿旧文本算了结果 ⇒ **出声**（带 sourceId）+ 丢弃；
 * ② model 现版本不等于请求的 ⇒ 结果没观众了 ⇒ 整批丢弃，**就地重问一次**
 *   （{@link INLINE_STALE_REASK_LIMIT}）；再陈旧就交回空批次（Monaco 下一次触发自然会重问，
 *   宿主不做无限重问）。
 *
 * ## Tab / Esc / IME：本模块不碰键位
 *
 * Monaco 侧 Tab 今天被三家抢（suggest 接受 / `editor.action.inlineSuggest.commit` / 缩进与
 * 片段占位符）。本模块**不注册键位、不 addAction、不 stopPropagation**，靠两条既有事实：
 * - 弹窗可见时（`context.selectedSuggestionInfo` 有值）整条沉默 ⇒ `inlineSuggestionVisible`
 *   不成立 ⇒ Tab 仍归弹窗（vendor `suggestController.js` 的 `acceptSelectedSuggestion`）；
 * - 合成期护栏住在 `suggest-context-trigger.ts` 那一副（`isImeOwnedSuggestKey` + 容器 capture
 *   的 `stopPropagation`），它挡的是 Monaco 命令面的**整拍派发**，`inlineSuggest.commit` 与
 *   `acceptSelectedSuggestion` 同被挡住 ⇒ 中文输入法不会"上字变接受"。
 * 无候选时交回空批次 ⇒ Monaco 的两个上下文键都不成立 ⇒ Tab / Esc 行为与接线前**逐字一致**。
 *
 * ## 数字住宿主
 *
 * 候选上限、时间预算、上下文窗宽都是这里的常量（可被 pref / deps 覆写）。契约刻意一个数字
 * 都没有——那份文件里出现数字，就意味着有第二个地方在读它。
 */

/* ============================== 宿主策略常量（"只有一个截断点"的那一处） ============================== */

/**
 * 一次调用的时间预算缺省（毫秒）。
 * 本地查表用不到它；外部模型源把它当"过了这个点就没观众了"的信号。
 * **超时由宿主判、由宿主丢弃**（契约 `timeoutMs` 的注），所以这一格是宿主的截断值。
 */
export const INLINE_REQUEST_TIMEOUT_MS = 1500;

/** 预算硬夹取上限（防 deps 交出离谱值；下限 = 1ms，0 会立刻判超时） */
export const INLINE_REQUEST_TIMEOUT_MAX_MS = 8000;

/** 上下文窗：光标前后各取多少**行**（供方不得假设窗宽，见契约"零 IO 与零切词"） */
export const INLINE_CONTEXT_WINDOW_LINES = 24;

/** 上下文窗：前后各不超过多少**字符**（行数决定形状，字符数决定代价上限——超长单行的语料真实存在） */
export const INLINE_CONTEXT_WINDOW_CHARS = 2400;

/** 模型版本过期后**就地重问**的次数上限（超过就交回空批次） */
export const INLINE_STALE_REASK_LIMIT = 1;

/** `maxCandidates` 缺省（deps 没给偏好读取器时的兜底；与 pref 模块的默认同值，改动先看测试） */
export const INLINE_MAX_CANDIDATES_FALLBACK = 5;

/* ============================== 接线面 ============================== */

/** 屏幕上这份 model 的宿主事实（由装配层给出；本模块不认识任何标签 / 面板内部） */
export interface InlineCompletionFacts {
  /** 真路径；`null` = 这份 model 不挂在任何活动标签上（空编辑器 / 无名投影） */
  readonly path: string | null;
  /** 派生视图（糖预览 / 投影 model）：幽灵文本会**写**进 model，投影上一律不弹 */
  readonly derivedView: boolean;
  /** 编辑器只读（插入会被吞 ⇒ 弹了纯骚扰） */
  readonly readOnly: boolean;
  /** 编辑器有文本焦点（焦点在别的分屏 / 面板 ⇒ 不抢） */
  readonly focused: boolean;
  /** 多光标（一次接受只能落一个光标 ⇒ 一律不弹） */
  readonly multiCursor: boolean;
  /** 有选区（作者正在选，不是正在写） */
  readonly selectionActive: boolean;
  /** 当前项目（`null` = 没开项目：供方按"无事实"降级） */
  readonly project: GameProject | null;
}

/** 宿主侧偏好读取器（真源在 `ui/inline-completion-pref.ts`，由装配层注入；每次现取） */
export interface InlineCompletionPrefReader {
  /** 总开关：`false` ⇒ 一次都不问（Monaco 那一半由 `inlineSuggest.enabled` 选项挡住，这是第二道） */
  enabled(): boolean;
  /** 最多几条候选（截尾巴，不重排） */
  maxCandidates(): number;
}

/** 一次调用的三态记账（可观测出口的形状） */
export interface InlineCompletionReport {
  /** 落点路径（`''` = 没路径） */
  readonly path: string;
  /** 请求所依据的模型版本 */
  readonly version: number;
  /** 一共问了几家 */
  readonly asked: number;
  /** 弃权（`undefined`）的家数 */
  readonly abstained: number;
  /** 看过并确认没有（`no-completion`）的家数——作者面"这一格为什么没字"的口径来自这里 */
  readonly noCompletion: number;
  /** 失败（`failed` 或抛错）的家数 */
  readonly failed: number;
  /** 给出候选的那一家的 id（没人作答 = `null`） */
  readonly answeredBy: string | null;
  /** 实际上屏的候选条数（截断后） */
  readonly shown: number;
  /** 被丢弃的陈旧批次数（供方回带版本不符 / model 版本已前进） */
  readonly staleDrops: number;
  /** 契约违规数（空 `candidates`；回带版本不符也计在这一格并另出声） */
  readonly violations: number;
  /** 挡下这次请求的闸门名（`null` = 闸门都过了、真去问了供方） */
  readonly gateSkipped: string | null;
  /**
   * 要说出去的话（供方的失败 `note` 原文 + 宿主的违规 / 超时说明）。
   * 缺省 = 无话；宿主**只搬运不复述**（同 `SearchScopeOption.label` 纪律）。
   */
  readonly notes?: readonly string[];
}

/** 累计读数（状态面板 / 调试面 / 测试的观测入口；`console` 那条结构化行取同一份数据） */
export interface InlineCompletionTally {
  readonly requests: number;
  readonly asked: number;
  readonly abstained: number;
  readonly noCompletion: number;
  readonly failed: number;
  readonly answered: number;
  readonly shown: number;
  readonly staleDrops: number;
  readonly violations: number;
  readonly gateSkips: Readonly<Record<string, number>>;
}

export interface InlineCompletionHostDeps {
  /** 槽查询（**每次现问**：项目开闭 / 插件退场都会换掉整张注册表） */
  sources(): readonly InlineCompletionSourceContribution[];
  /** 屏幕 model → 宿主事实（`null` = 这份 model 宿主不认，整条沉默） */
  facts(model: Monaco.editor.ITextModel): InlineCompletionFacts | null;
  /** 偏好读取器（每次现取，不在安装时定死） */
  pref: InlineCompletionPrefReader;
  /** 时间预算覆写（测试与后续外部源用；缺省 {@link INLINE_REQUEST_TIMEOUT_MS}） */
  timeoutMs?: number;
  /** 观测出口：给了就**只**走它，不给则走 `console` + 本模块的累计读数 */
  observe?(report: InlineCompletionReport): void;
}

/** 一次问槽的结果（`outcome` 为 `null` = 没有任何一家给出 candidates） */
interface AskResult {
  readonly outcome: Extract<InlineCompletionOutcome, { state: 'candidates' }> | null;
  readonly abstained: number;
  readonly noCompletion: number;
  readonly failed: number;
  readonly violations: number;
  readonly asked: number;
  /** 要说出去的话（失败 note / 违规 / 超时），由 {@link provideForModel} 那一次统一上报 */
  readonly notes: readonly string[];
}

/** 空批次：模块级唯一实例（"没有幽灵文本"就是今天的行为，不另造第三套表示） */
const EMPTY_RESULT: Monaco.languages.InlineCompletions = { items: [] };

/* ============================== 累计读数（观测面） ============================== */

/** 累计表的**可写**形状（`InlineCompletionTally` 是它的只读投影；同一批字段名，不许两套词汇） */
interface MutableTally {
  requests: number;
  asked: number;
  abstained: number;
  noCompletion: number;
  failed: number;
  answered: number;
  shown: number;
  staleDrops: number;
  violations: number;
  gateSkips: Record<string, number>;
}

const tally: MutableTally = {
  requests: 0,
  asked: 0,
  abstained: 0,
  noCompletion: 0,
  failed: 0,
  answered: 0,
  shown: 0,
  staleDrops: 0,
  violations: 0,
  gateSkips: {},
};

/** 当前累计读数（快照；状态面板 / 调试面读这一枚，别去解析 console 文本） */
export function getInlineCompletionTally(): InlineCompletionTally {
  return { ...tally, gateSkips: { ...tally.gateSkips } };
}

/** 清账（测试之间不串读数；生产接线不调） */
export function resetInlineCompletionTally(): void {
  tally.requests = 0;
  tally.asked = 0;
  tally.abstained = 0;
  tally.noCompletion = 0;
  tally.failed = 0;
  tally.answered = 0;
  tally.shown = 0;
  tally.staleDrops = 0;
  tally.violations = 0;
  tally.gateSkips = {};
}

/** 同一来源同一句只报第一次（刷屏会把真话埋掉，口径同 `editor-global-providers` 的 `warnSeamDegradedOnce`） */
const warnedOnce = new Set<string>();

/** 清掉"只报一次"的台账（测试之间要独立取证；生产接线不调） */
export function resetInlineCompletionWarningsForTests(): void {
  warnedOnce.clear();
}

function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(`[inline-completion] ${message}`);
}

/**
 * 结构化的一条观测行（**已有**的 console 观测面；只在"有货"或"有话说"时上，逐键静默）。
 *
 * 不新造上报机制：这里既没有事件总线载荷也没有面板——`tally` 是本模块唯一的一份数，
 * `console` 那一条行读的就是它。铁律 4 要求"看过并确认没有 / 失败"不许静默，
 * 落点就是 {@link observeOnConsole} 的第二支。
 */
function observeOnConsole(report: InlineCompletionReport): void {
  if (report.gateSkipped !== null) return; // 闸门挡下 = 一次都没问，不值得逐键刷屏
  if (report.answeredBy !== null) {
    console.info(
      `[inline-completion] ${report.path} v${report.version} 由「${report.answeredBy}」给出 ${report.shown} 条候选（问了 ${report.asked} 家）`,
    );
    return;
  }
  if (
    report.failed === 0 &&
    report.noCompletion === 0 &&
    report.staleDrops === 0 &&
    report.violations === 0
  ) {
    return; // 全弃权 = 没有可说的（"没看过"不记账，见契约）
  }
  console.info(
    `[inline-completion] ${report.path} v${report.version} 无候选：弃权 ${report.abstained} / 看过没有 ${report.noCompletion} / 失败 ${report.failed} / 丢弃 ${report.staleDrops} / 违规 ${report.violations}`,
  );
}

/* ============================== 打字腿（⑦ 的对面 + `triggerCharacter` 的唯一来源） ============================== */

/**
 * 每个 model 一份"刚敲下的那一枚字符"。
 *
 * Monaco 的 `InlineCompletionContext` **不给触发字符**（只给 Automatic / Explicit），而契约的
 * `triggerCharacter` 要求"宿主原样递来、不判定"。于是宿主自己留一条腿：与弹窗观察者**同一副**
 * 判据（{@link singleInsertedChar} + {@link cursorReasonBreaksTypingLeg}），只记事实、不排程、
 * 不弹任何东西（弹出时机仍由 Monaco 管）。
 *
 * 记的是 `versionId`：供方异步回来时文本可能已经前进，按"字符本身"配对会配到旧的一拍。
 */
const typedLegs = new WeakMap<Monaco.editor.ITextModel, { readonly char: string; readonly versionId: number }>();

/**
 * 每个 model 一份"输入法正在合成"的会话态（闸门 ⑫ 的事实源）。
 *
 * 与弹窗观察者同用 Monaco 公开的那对事件（`onDidCompositionStart` / `onDidCompositionEnd`），
 * 只是这里用它挡**幽灵文本**这一条腿。Enter / Tab / Esc 的按键护栏**不在这里**：那一副住在
 * `suggest-context-trigger.ts`（容器 capture 的 `stopPropagation`），它挡的是命令面的整拍派发，
 * `editor.action.inlineSuggest.commit` 与 `acceptSelectedSuggestion` 一起被挡 ⇒ 不重复装第二副。
 */
const composingLegs = new WeakMap<Monaco.editor.ITextModel, boolean>();

/** 这份 model 的编辑器此刻是否在合成期（没有会话记录 = 不在） */
function isComposing(model: Monaco.editor.ITextModel): boolean {
  return composingLegs.get(model) === true;
}

/** 这一版文本是不是"刚敲下一枚字符"那一版（闸门 ⑦ 对面判据 + 触发字符来源） */
export function typedCharAt(model: Monaco.editor.ITextModel, versionId: number): string | null {
  const leg = typedLegs.get(model);
  return leg !== undefined && leg.versionId === versionId ? leg.char : null;
}

/* ============================== 请求组装（宿主算全部事实，零切词） ============================== */

/** 时间预算：deps 覆写 → 夹到 1–{@link INLINE_REQUEST_TIMEOUT_MAX_MS}（脏值不抛，回落缺省） */
export function clampRequestTimeout(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return INLINE_REQUEST_TIMEOUT_MS;
  return Math.min(INLINE_REQUEST_TIMEOUT_MAX_MS, Math.max(1, Math.round(ms)));
}

/**
 * 上下文窗：以光标为界，向前 / 向后各最多 `lines` 行、`chars` 字符。
 *
 * 行数和字符数**都要夹**：行数决定形状（跨几行），字符数决定代价上限（一个 50 万列的行
 * 就能把一次请求撑爆，语料里真有这种行）。夹取从**靠光标的那一头**开始留，裁掉远离光标的尾巴。
 */
export function contextWindowOf(
  model: Monaco.editor.ITextModel,
  line: number,
  column: number,
  maxLines: number,
  maxChars: number,
): { readonly before: string; readonly after: string } {
  const lineCount = Math.max(1, model.getLineCount());
  const safeLine = Math.min(Math.max(Math.trunc(line) || 1, 1), lineCount);
  const currentLine = lineAt(model, safeLine);
  const safeColumn = Math.min(Math.max(Math.trunc(column) || 1, 1), currentLine.length + 1);

  const beforeLines: string[] = [currentLine.slice(0, safeColumn - 1)];
  let used = currentLine.length;
  for (let l = safeLine - 1; l >= 1 && beforeLines.length < maxLines; l--) {
    const text = lineAt(model, l);
    if (used + text.length > maxChars) break;
    beforeLines.unshift(text);
    used += text.length;
  }
  const afterLines: string[] = [currentLine.slice(safeColumn - 1)];
  used = currentLine.length;
  for (let l = safeLine + 1; l <= lineCount && afterLines.length < maxLines; l++) {
    const text = lineAt(model, l);
    if (used + text.length > maxChars) break;
    afterLines.push(text);
    used += text.length;
  }
  const before = beforeLines.join('\n');
  const after = afterLines.join('\n');
  return {
    before: before.length > maxChars ? before.slice(before.length - maxChars) : before,
    after: after.length > maxChars ? after.slice(0, maxChars) : after,
  };
}

/* ============================== 候选 → Monaco（夹取 / 去重 / 截断，**不重排**） ============================== */

/**
 * 把契约的 1 基半开区间夹进 model 的真实坐标。
 *
 * Monaco 的两条硬约束（`monaco.d.ts` 的 `InlineCompletion.range` 注）：
 * - **区间必须起止同行**；
 * - 跨行的 `insertText` 只允许在"区间终点是行尾"时出现。
 * 宿主不解释供方的意图，只做这两道夹取：`insertText` 里没有换行 ⇒ 终点折回起点那一行；
 * 有换行 ⇒ 终点夹到末行的行尾。越界行 / 列一律夹到边界，不猜、不抛。
 */
export function clampCandidateRange(
  candidate: InlineCompletionCandidate,
  model: Monaco.editor.ITextModel,
): Monaco.IRange {
  const lineCount = Math.max(1, model.getLineCount());
  const startLine = Math.min(Math.max(Math.trunc(candidate.range.startLine) || 1, 1), lineCount);
  let endLine = Math.min(Math.max(Math.trunc(candidate.range.endLine) || startLine, 1), lineCount);
  if (endLine < startLine) endLine = startLine;
  const startMax = model.getLineMaxColumn(startLine);
  const startColumn = Math.min(Math.max(Math.trunc(candidate.range.startColumn) || 1, 1), startMax);
  const multiline = candidate.insertText.includes('\n') || candidate.insertText.includes('\r');
  if (multiline) {
    // 终点必须落在某一行的行尾，否则 Monaco 会拒绝这次改写
    return {
      startLineNumber: startLine,
      startColumn,
      endLineNumber: endLine,
      endColumn: model.getLineMaxColumn(endLine),
    };
  }
  if (endLine !== startLine) endLine = startLine;
  const endMax = model.getLineMaxColumn(endLine);
  const endColumn = Math.min(
    Math.max(Math.trunc(candidate.range.endColumn) || startColumn, startColumn),
    endMax,
  );
  return { startLineNumber: startLine, startColumn, endLineNumber: endLine, endColumn };
}

/** 去重键：同区间 + 同字面 = 同一个候选（两家给出一模一样的东西时只留靠前那一家的那一条） */
function candidateKey(range: Monaco.IRange, candidate: InlineCompletionCandidate): string {
  return `${range.startLineNumber}:${range.startColumn}:${range.endLineNumber}:${range.endColumn}|${candidate.insertText}`;
}

/**
 * 夹取 + 去重 + 截断（上限来自宿主 pref）。**不排序、不重排**：契约写明"第 0 条就是按接受键
 * 拿到的那一条"，重排的判据会漂。
 */
export function toMonacoInlineCompletions(
  candidates: readonly InlineCompletionCandidate[],
  model: Monaco.editor.ITextModel,
  maxCandidates: number,
  hintStyle: number,
): { readonly items: readonly Monaco.languages.InlineCompletion[]; readonly shown: number } {
  const limit = Number.isFinite(maxCandidates)
    ? Math.min(Math.max(Math.trunc(maxCandidates), 1), 200)
    : INLINE_MAX_CANDIDATES_FALLBACK;
  const seen = new Set<string>();
  const items: Monaco.languages.InlineCompletion[] = [];
  for (const candidate of candidates) {
    if (items.length >= limit) break;
    if (typeof candidate.insertText !== 'string' || candidate.insertText === '') continue;
    const range = clampCandidateRange(candidate, model);
    const key = candidateKey(range, candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    const item: Monaco.languages.InlineCompletion =
      typeof candidate.note === 'string' && candidate.note !== ''
        ? {
            insertText: candidate.insertText,
            range,
            // `note` 原文跟在幽灵文本后头（契约：宿主原文显示、不解析、不改写）。
            // `displayText` 目前**没有**宿主侧的表面——Monaco 的 `InlineCompletion` 只有
            // `insertText` 这一份字面，另造显示文本就是第二份真相。
            // TODO(C 车道)：观感面（ghost text 的字色 / 提示语）接 token 时一并决定这一格怎么画。
            hint: {
              range: {
                startLineNumber: range.endLineNumber,
                startColumn: range.endColumn,
                endLineNumber: range.endLineNumber,
                endColumn: range.endColumn,
              },
              style: hintStyle,
              content: candidate.note,
            },
          }
        : { insertText: candidate.insertText, range };
    items.push(item);
  }
  return { items, shown: items.length };
}

/* ============================== 问槽 ============================== */

/** 一家供方的这一次回答落到哪一档（`timeout` = 宿主判的预算用尽，不是供方说的失败） */
type SourceAnswer =
  | { readonly kind: 'outcome'; readonly outcome: InlineCompletionOutcome | undefined }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'throw'; readonly error: unknown };

/**
 * 一次调用 + 宿主的**时间预算**。
 *
 * 契约把 `timeoutMs` 定为"过了这个点结果就没观众了"的**信号**，硬闸归宿主：
 * 预算用尽时宿主把这一次当**未作答**处理（计失败、继续问下一家），并置位 `signal`
 * 让供方有机会停手。刻意**不**抛——被叫停的一次调用本来也没有观众。
 */
function askOneSource(
  source: InlineCompletionSourceContribution,
  request: InlineCompletionRequest,
): Promise<SourceAnswer> {
  return new Promise<SourceAnswer>((resolve) => {
    let settled = false;
    const finish = (answer: SourceAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const timer = setTimeout(() => {
      // 宿主判超时、宿主丢弃（契约的 `timeoutMs` 只是给供方的信号，硬闸在这两侧之外没有第二处）：
      // 这一次当**未作答**处理，继续问下一家；供方那份 Promise 稍后落地也会被这里丢掉
      finish({ kind: 'timeout' });
    }, request.timeoutMs);
    let call: Promise<InlineCompletionOutcome | undefined>;
    try {
      call = Promise.resolve(source.provideInline(request));
    } catch (error: unknown) {
      finish({ kind: 'throw', error });
      return;
    }
    call.then(
      (outcome) => finish({ kind: 'outcome', outcome }),
      (error: unknown) => finish({ kind: 'throw', error }),
    );
  });
}

/**
 * 按 `order` 逐家问，第一家给 `candidates` 的就是答案。
 *
 * 三态口径全在契约里，这里只落实两件事：**继续问下一家的条件**（`undefined` /
 * `no-completion` / `failed` / 超时 / 抛错）与**出声**（空数组、抛错、失败 note）。
 * `no-completion` 与 `failed` 都**记账**（铁律 4：不许静默），弃权不记账。
 */
export async function askSources(
  sources: readonly InlineCompletionSourceContribution[],
  request: InlineCompletionRequest,
): Promise<AskResult> {
  let abstained = 0;
  let noCompletion = 0;
  let failed = 0;
  let violations = 0;
  let asked = 0;
  const notes: string[] = [];
  for (const source of sources) {
    if (request.signal?.aborted === true) break;
    asked += 1;
    const answer = await askOneSource(source, request);
    if (answer.kind === 'throw') {
      // 契约：`provideInline` 只在**输入本身不合法**时抛错 ⇒ 这是供方违约，不是"这次没结果"
      failed += 1;
      notes.push(`${source.id} 抛错（契约规定只有输入不合法才许抛）：${errorText(answer.error)}`);
      continue;
    }
    if (answer.kind === 'timeout') {
      failed += 1;
      notes.push(`${source.id} 超出 ${request.timeoutMs}ms 预算`);
      continue;
    }
    const outcome = answer.outcome;
    if (outcome === undefined) {
      abstained += 1; // 弃权：没看过就没资格被显示成"检查过"
      continue;
    }
    if (outcome.state === 'no-completion') {
      // 看过并确认没有：记账，但**不停下**——"没有"是未作答而不是答案
      noCompletion += 1;
      continue;
    }
    if (outcome.state === 'failed') {
      failed += 1;
      // `note` 由供方生成、宿主只显示不复述（契约）；`detail` 给机器
      notes.push(`${source.id} 在 ${outcome.stage} 段失败：${outcome.note}`);
      continue;
    }
    if (outcome.candidates.length === 0) {
      // 空数组 = 契约违规：出声并丢弃，**不**当作 `no-completion` 悄悄咽下
      violations += 1;
      notes.push(`${source.id} 给出空的 candidates 数组（"没有"只有 no-completion 一种写法）`);
      continue;
    }
    return { outcome, abstained, noCompletion, failed, violations, asked, notes };
  }
  return { outcome: null, abstained, noCompletion, failed, violations, asked, notes };
}

/**
 * 违规 / 失败要说出去，但**不许逐键刷屏**：同一来源同一句只报第一次
 *（口径同 `editor-global-providers.ts` 的 `warnSeamDegradedOnce`）。
 */
/** 抛错对象的稳妥取词（不许把 `undefined` / 对象拼进日志再抛进 Monaco 的供给路径） */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/* ============================== 装配 ============================== */

/**
 * 把内联补全（幽灵文本）接到槽 `completion.source` 上。
 *
 * 返回句柄 = provider 注册 + 打字腿监听一起回收（`registerForLanguageServices` 的口径：
 * 交回的是一次性把全部注册一起收掉的 IDisposable）。
 * **不注册任何键位**（见文件头「Tab / Esc / IME」）。
 */
export function installInlineCompletion(
  monaco: typeof Monaco,
  deps: InlineCompletionHostDeps,
): Monaco.IDisposable {
  const hintStyle =
    typeof monaco.languages.InlineCompletionHintStyle?.Label === 'number'
      ? monaco.languages.InlineCompletionHintStyle.Label
      : 2; // `InlineCompletionHintStyle.Label`（vendor 枚举值；桩面上没有时按同一档兜）
  const explicitKind = monaco.languages.InlineCompletionTriggerKind?.Explicit ?? 1;

  const provider: Monaco.languages.InlineCompletionsProvider = {
    // vendor 遥测 / 结构化日志里的名字（`InlineCompletionsProvider.displayName`）
    displayName: 'kojo-inline-completion-host',
    provideInlineCompletions: (model, position, context, token) =>
      provideForModel(deps, hintStyle, explicitKind, model, position, context, token),
    // `InlineCompletionsProvider.disposeInlineCompletions` 是必填面：本模块的候选是纯数据，
    // 没有租约 / 定时器要还，但这一枚不许缺（Monaco 会按它回收批次）
    disposeInlineCompletions() {
      /* 无资源 */
    },
  };

  const subs: Monaco.IDisposable[] = [];
  subs.push(
    registerForLanguageServices(monaco, (m, languageId) =>
      m.languages.registerInlineCompletionsProvider(languageId, provider),
    ),
  );
  subs.push(installTypingLegs(monaco));

  return {
    dispose: () => {
      for (const s of subs) s.dispose();
      subs.length = 0;
    },
  };
}

/**
 * 打字腿：为**每一枚编辑器实例**（含装好之前就已存在的）挂上内容 / 光标 / 合成三条**既有**腿。
 *
 * 判据一律复用 `suggest-context-trigger.ts` 那两枚（{@link singleInsertedChar} +
 * {@link cursorReasonBreaksTypingLeg}），这里**只记事实**：不排程、不弹任何东西、不碰键位
 * （弹出时机归 Monaco，合成期按键护栏归弹窗观察者那一副）。
 */
function installTypingLegs(monaco: typeof Monaco): Monaco.IDisposable {
  const handles: Monaco.IDisposable[] = [];
  const hook = (editor: Monaco.editor.ICodeEditor): void => {
    const contentSub = editor.onDidChangeModelContent((event) => {
      const model = editor.getModel();
      if (!model) return;
      if (isComposing(model)) {
        // 合成期 model 也会随 `compositionupdate` 变化（拼音逐字）——那不是"作者敲下的一枚字符"
        typedLegs.delete(model);
        return;
      }
      const inserted = singleInsertedChar(event);
      if (inserted === null) {
        typedLegs.delete(model); // 删除 / 粘贴 / 撤销 / setValue ⇒ 这一拍不算"刚敲下"
        return;
      }
      typedLegs.set(model, { char: inserted, versionId: model.getVersionId() });
    });
    const cursorSub = editor.onDidChangeCursorPosition((event) => {
      const model = editor.getModel();
      if (!model) return;
      const reason = typeof event.reason === 'number' ? event.reason : 0;
      if (cursorReasonBreaksTypingLeg(reason)) typedLegs.delete(model);
    });
    const modelSub = editor.onDidChangeModel(() => {
      // 换 model = 换文档：上一份文件的"刚敲下的字符"对新文件没有意义
      const model = editor.getModel();
      if (model) typedLegs.delete(model);
    });
    handles.push(contentSub, cursorSub, modelSub);
    // 合成会话（⑫ 的事实源）：走 Monaco 公开的那对事件（形状 = `IEvent<void>`），
    // 与弹窗观察者同一判据方向；按键护栏**不在这里**（见文件头「Tab / Esc / IME」）
    type CompositionEvent = (listener: () => void) => Monaco.IDisposable;
    const startOf = (editor as { onDidCompositionStart?: CompositionEvent }).onDidCompositionStart;
    const endOf = (editor as { onDidCompositionEnd?: CompositionEvent }).onDidCompositionEnd;
    const startSub =
      typeof startOf === 'function'
        ? startOf.call(editor, () => {
            const model = editor.getModel();
            if (model) {
              composingLegs.set(model, true);
              typedLegs.delete(model);
            }
          })
        : null;
    const endSub =
      typeof endOf === 'function'
        ? endOf.call(editor, () => {
            const model = editor.getModel();
            if (model) composingLegs.set(model, false);
          })
        : null;
    if (startSub) handles.push(startSub);
    if (endSub) handles.push(endSub);
  };
  for (const editor of monaco.editor.getEditors()) hook(editor);
  handles.push(monaco.editor.onDidCreateEditor((editor) => hook(editor)));
  return {
    dispose: () => {
      for (const h of handles) h.dispose();
      handles.length = 0;
    },
  };
}

/* ============================== provider 主体 ============================== */

/**
 * 闸门 → 组装请求 → 问槽 → 过期复核 → 夹取上屏。
 *
 * 三条**逐字一致的沉默**：总开关关 / 闸门挡下 / 没有一家给出候选 ⇒ 交回空批次，Monaco 的
 * `inlineSuggestionVisible` 不成立 ⇒ 键位面与接线前完全相同（这就是"无候选时不改任何行为"）。
 */
async function provideForModel(
  deps: InlineCompletionHostDeps,
  hintStyle: number,
  explicitKind: number,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  context: Monaco.languages.InlineCompletionContext,
  token: { readonly isCancellationRequested: boolean; onCancellationRequested?: (fn: () => void) => unknown },
): Promise<Monaco.languages.InlineCompletions> {
  const version = model.getVersionId();
  const facts = deps.facts(model);
  const path = facts?.path ?? '';

  /** 唯一出口：一次调用只发一份读数（累计表 + `observe` / console 同一份数据） */
  const finish = (
    part: Partial<InlineCompletionReport> & { gateSkipped: string | null },
    result: Monaco.languages.InlineCompletions,
  ): Monaco.languages.InlineCompletions => {
    const report: InlineCompletionReport = {
      path,
      version,
      asked: 0,
      abstained: 0,
      noCompletion: 0,
      failed: 0,
      answeredBy: null,
      shown: 0,
      staleDrops: 0,
      violations: 0,
      ...part,
    };
    tally.requests += 1;
    tally.asked += report.asked;
    tally.abstained += report.abstained;
    tally.noCompletion += report.noCompletion;
    tally.failed += report.failed;
    tally.staleDrops += report.staleDrops;
    tally.violations += report.violations;
    tally.shown += report.shown;
    if (report.answeredBy !== null) tally.answered += 1;
    if (report.gateSkipped !== null) {
      tally.gateSkips[report.gateSkipped] = (tally.gateSkips[report.gateSkipped] ?? 0) + 1;
    }
    for (const note of part.notes ?? []) {
      warnOnce(`${report.path}|${note}`, note);
    }
    if (deps.observe) deps.observe(report);
    else observeOnConsole(report);
    return result;
  };
  const skip = (gate: string): Monaco.languages.InlineCompletions =>
    finish({ gateSkipped: gate }, EMPTY_RESULT);

  // ① 总开关（第二道；第一道是 Monaco 的 `editor.inlineSuggest.enabled` 选项，见 pane-helpers）
  let enabled = true;
  try {
    enabled = deps.pref.enabled() !== false;
  } catch {
    enabled = true; // 脏偏好读取不许把整条链抛进 Monaco 的供给路径
  }
  if (!enabled) return skip('pref-disabled');
  // Monaco 这一拍只要"内联改写"（isInlineEdit 那一类）⇒ 本契约没有这种候选形态，不白问
  if (context?.includeInlineCompletions === false) return skip('not-completions-requested');
  if (token?.isCancellationRequested === true) return skip('already-cancelled');
  if (!facts) return skip('unknown-model');

  const languageId = model.getLanguageId();
  const line = position.lineNumber;
  const column = position.column;
  const lineText = lineAt(model, line);

  // ⑫①②③④⑤：与弹窗**同一份**判据（`sharedSuggestGates`，抄本 = 0）
  if (
    !sharedSuggestGates({
      hasPath: path !== '',
      readOnly: facts.readOnly,
      derivedView: facts.derivedView,
      focused: facts.focused,
      multiCursor: facts.multiCursor,
      selectionActive: facts.selectionActive,
      composing: isComposing(model),
    })
  ) {
    return skip('shared-gates');
  }
  // ⑥ 的对面：弹窗可见（`selectedSuggestionInfo` 有值）⇒ Tab 归弹窗，这一条腿整条沉默
  if (context?.selectedSuggestionInfo !== undefined && context.selectedSuggestionInfo !== null) {
    return skip('suggest-widget-visible');
  }
  // ⑦ 的对面：这一版文本必须是"刚敲下一枚字符"那一版；显式触发（命令面板 / 快捷键）例外
  const typed = typedCharAt(model, version);
  const explicit = context?.triggerKind === explicitKind;
  if (!explicit && typed === null) return skip('not-just-typed');
  // ⑧⑨ 的语言侧代码位门：只读 / 预览已由上面挡掉，这里挡台词 / 旁白 / 注释 / 字符串
  if (!codeViewAt(languageId, lineText, column)) return skip('non-code-position');

  const controller = new AbortController();
  if (typeof token?.onCancellationRequested === 'function') {
    token.onCancellationRequested(() => controller.abort());
  }
  /**
   * 组装一次请求。
   *
   * **每次现取文本**：重问那一拍 model 已经前进了，把第一次算出的旧字面配上新 `version`
   * 等于让供方按旧文本算结果却自证了个真版本——契约的 `version` 就不是信息而是谎言。
   * 行 / 列**沿用触发那一拍**（Monaco 只在位点变化时另起一次请求，那里会给我们新坐标）。
   */
  const buildRequest = (atVersion: number): InlineCompletionRequest => {
    const atLineText = lineAt(model, line);
    const window = contextWindowOf(
      model,
      line,
      column,
      INLINE_CONTEXT_WINDOW_LINES,
      INLINE_CONTEXT_WINDOW_CHARS,
    );
    return {
      path,
      languageId,
      version: atVersion,
      line,
      column,
      lineText: atLineText,
      // 宿主**不切词**：光标把当前行切成两段原始字面（按语言判词边界是供方的知识）
      prefix: atLineText.slice(0, Math.max(0, column - 1)),
      suffix: atLineText.slice(Math.max(0, column - 1)),
      contextBefore: window.before,
      contextAfter: window.after,
      project: facts.project,
      lineCount: model.getLineCount(),
      triggerKind: explicit ? 'explicit' : 'auto',
      ...(typed !== null ? { triggerCharacter: typed } : {}),
      timeoutMs: clampRequestTimeout(deps.timeoutMs),
      signal: controller.signal,
    };
  };

  /**
   * 这一拍还有没有观众（宿主取消 or Monaco 的 cancellation token）。
   * 走函数而不写 `x === false`：TypeScript 的属性收窄会把后面那两次比较判成"恒真 / 恒假"，
   * 而这里要的正是**每次现问**（异步供方回来时状态可能已经变了）。
   */
  const cancelled = (): boolean =>
    controller.signal.aborted === true || token?.isCancellationRequested === true;

  let request = buildRequest(version);
  let answer = await askSources(deps.sources(), request);
  let staleDrops = 0;
  let reasks = 0;
  const notes: string[] = [...answer.notes];
  let violations = answer.violations;
  /**
   * 过期复核（唯一判据 = `version`）：
   * ① 供方回带的 version 与请求不符 ⇒ 它拿旧文本算的结果 ⇒ **出声**（带 sourceId）+ 丢弃；
   * ② model 现版本已前进 ⇒ 这批没观众了 ⇒ 丢弃并**就地重问**（上限 {@link INLINE_STALE_REASK_LIMIT}）。
   */
  for (;;) {
    const outcome = answer.outcome;
    if (outcome === null) break;
    if (outcome.version !== request.version) {
      violations += 1;
      staleDrops += 1;
      notes.push(
        `候选源「${outcome.candidates[0]?.sourceId ?? '?'}」回带 version=${outcome.version}，请求是 version=${request.version}（${path}）——按契约违规丢弃`,
      );
      break;
    }
    const current = model.getVersionId();
    if (current === request.version) break;
    staleDrops += 1;
    if (reasks >= INLINE_STALE_REASK_LIMIT || cancelled()) break;
    reasks += 1;
    // 重问带的是**当下**的 version：过期判据只有这一枚货币（契约"版本与取消"一节）
    request = buildRequest(current);
    answer = await askSources(deps.sources(), request);
    notes.push(...answer.notes);
    violations += answer.violations;
  }

  const outcome = answer.outcome;
  const wasCancelled = cancelled();
  const fresh =
    outcome !== null &&
    !wasCancelled &&
    outcome.version === request.version &&
    model.getVersionId() === request.version;

  if (outcome === null || !fresh) {
    return finish(
      {
        gateSkipped: wasCancelled ? 'cancelled' : null,
        asked: answer.asked,
        abstained: answer.abstained,
        noCompletion: answer.noCompletion,
        failed: answer.failed,
        staleDrops,
        violations,
        notes: wasCancelled ? [] : notes,
      },
      EMPTY_RESULT,
    );
  }

  let maxCandidates = INLINE_MAX_CANDIDATES_FALLBACK;
  try {
    maxCandidates = deps.pref.maxCandidates();
  } catch {
    maxCandidates = INLINE_MAX_CANDIDATES_FALLBACK;
  }
  const candidates = outcome!.candidates;
  const mapped = toMonacoInlineCompletions(candidates, model, maxCandidates, hintStyle);
  if (mapped.shown < candidates.length) {
    // 截断要说得出（铁律 4）：上限来自宿主 pref，不是"供方给了却不见了"
    notes.push(
      `候选 ${candidates.length} 条按上限 ${maxCandidates} 截断（${path}）`,
    );
  }
  return finish(
    {
      gateSkipped: null,
      asked: answer.asked,
      abstained: answer.abstained,
      noCompletion: answer.noCompletion,
      failed: answer.failed,
      answeredBy: candidates[0]?.sourceId ?? 'unknown',
      shown: mapped.shown,
      staleDrops,
      violations,
      notes,
    },
    mapped.items.length === 0 ? EMPTY_RESULT : { items: mapped.items },
  );
}
