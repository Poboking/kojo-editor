/**
 * 槽 `completion.source` 的 **Kojo 2.0 供方**（LAU-KOJO2-INLINE，2026-10-31）：
 * 幽灵文本（行内续写）在 2.0 语法下的候选源。
 *
 * ## 它是什么
 *
 * 一句话：**把 2.0 补全那把尺子按"几乎唯一才给"再读一遍**。位置判定、名录、前缀裁剪
 * 全部住在 `@kojo/kojo-lang/completion`（`kojo2CompletionAt` 那一枚，弹窗补全用的是同一枚），
 * 本文件不写第二条语法判据，只做三件事：
 *
 * 1. **语言门**：不是 `kojo2` 的请求一律 `undefined`（**弃权**）。ERB 那家（`local-name-slot`）
 * 与这一家互不相认，谁都不会替对方把"没有"答成事实。
 * 2. **窗口对账**：契约递给供方的是**以光标为心的行窗口**（`contextBefore` / `contextAfter`），
 * 而 `kojo2CompletionAt` 吃的是「源文 + 1 基行列」。这里把窗口折回一份自洽的
 * `{ source, line, column }`（行号平移），并诚实标出**这份源文是不是整篇**
 * （{@link kojo2InlineQueryOf}）。不是整篇时，包内那一层会把**只由源文证明**的那两档候选
 * （`declaration` / `templateParam`）按"不能证明唯一"处理——窗外还有两条同名声明时，
 * 窗内数出来的"只剩一条"是假唯一（错报比漏报贵）。
 * 3. **唯一性**：`kojo2InlineCompletionAt` 交回 `unique` 才上屏；`ambiguous` / `none` 都答
 *   `no-completion`（看过，这一格没有可证明的唯一答案）。**块级骨架不参与**——一次击键糊进
 *   五行模板不是"下一格的字"，那是弹窗与片段的活。
 *
 * ## 抑制面（用户钉的缺省行为，与 ERB 那家同一条口径）
 *
 * 只读 / 派生视图 / 无焦点 / 多光标 / 有选区 / 合成期由**宿主闸门**挡（`sharedSuggestGates`）；
 * **台词 / 旁白 / 转义正文 / 注释 / 旧写法行 / 串与注释内 / `@原生` 围栏（含栏头）** 由
 * `kojo2CompletionAt` 的位置门挡——它们一律返回空候选 ⇒ 本家答 `no-completion`。
 * 宿主那侧对声明了行内续写（descriptor `inlineCompletion: true`）的语言**不再另问一枚
 * 语言代码位门**：2.0 的代码位判据在语言包里，宿主再抄一份就是第二把尺子（见
 * `packages/app/src/monaco/inline-completion-host.ts` 的闸门 ⑧⑨ 注）。
 *
 * ## adapter：请求时现取 + 只认 id 对得上的那一枚
 *
 * 与 `src/completion.ts` / `src/inlay.ts` 同一条纪律：事件名 / 事件参数 / 颜绘参数 / 行尾提示名
 * 四路方言事实只在**当前项目**里存在；`adapter.id !== request.project.adapterId` ⇒ 按"没有
 * adapter 事实"作答（那四路零候选），从源文能证明的路照给。零游戏名词、零 IO。
 */
import type {
  InlineCompletionCandidate,
  InlineCompletionOutcome,
  InlineCompletionRequest,
  InlineCompletionSourceContribution,
} from '@kojo/plugin-api';
// 只取**类型**：2.0 adapter 的形状住 core（与 plugin-api 的 v1 `GameAdapter` 不是同一个类型）
import type { GameAdapter } from '@kojo/kojo-core';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';
import {
  kojo2CompletionOptionsFromAdapter,
  kojo2InlineCompletionAt,
  type Kojo2CompletionOptions,
  type Kojo2InlineResult,
} from '@kojo/kojo-lang/completion';
import { completionItemKindOf } from './completion';

/** 本家的 id（进 `InlineCompletionCandidate.sourceId` 与槽台账；与 ERB 那家不同名 ⇒ 不冲突） */
export const KOJO2_INLINE_SOURCE_ID = 'kojo2-near-unique';
/** 作者面显示名（设置页与"这一格的字来自谁"读它；宿主原文显示） */
export const KOJO2_INLINE_TITLE = 'Kojo 2.0 语法（几乎唯一才给）';
/**
 * 本地源都排在外部模型源（`order` 从 20 起步，见 `@kojo/plugin-inline-completion-local`
 * 的「第二家怎么进来」）之前：本地命中 ⇒ 一次出网都不发生。11 = ERB 那家（10）之后的
 * 第二枚本地源；两家语言门互斥，`order` 在这里只决定问的先后，不表达"我更准"。
 */
export const KOJO2_INLINE_ORDER = 11;

/** 注入面（缺省全部走真源；测试按同一形状喂替身） */
export interface Kojo2InlineDeps {
  /** 当前项目的 2.0 adapter（请求时现取并核过 id；对不上 ⇒ `null`，不猜） */
  adapterFor(adapterId: string | undefined): GameAdapter | null;
}

/** 这份幽灵文本请求是不是 2.0 的活（`languageId` 由宿主从 model 原样递来，是唯一事实） */
export function isKojo2InlineRequest(request: { readonly languageId: string }): boolean {
  return request.languageId === KOJO2_LANGUAGE_ID;
}

/** 窗口折回的一份自洽源文（行号已平移到窗口坐标） */
export interface Kojo2InlineQuery {
  readonly source: string;
  readonly line: number;
  readonly column: number;
  /** 窗口 = 整篇（决定"源文证明的那两档"能不能用，见包内 `kojo2InlineCompletionAt`） */
  readonly wholeDocument: boolean;
}

/**
 * 把契约的行窗口折回 `{ source, line, column }`（**唯一一处**做这件事，测试直接对它断言）。
 *
 * 窗口的形状是宿主定的：`contextBefore` = 光标前若干**整行** + 当前行的前半，
 * `contextAfter` = 当前行的后半 + 之后若干整行（各按行数与字符数双向夹取，夹在远离光标的那一头）。
 * 于是 `before + after` 正好把当前行的两半重新接上，而窗口首行的**绝对行号** =
 * `line - (contextBefore 的行数 - 1)`。
 *
 * 返回 `null` 的情况只有一个：窗口里的行数比光标行号还多（坐标映不回去）。真宿主不会给
 * 这种窗口（桩宿主与旧宿主可能），这里不猜、交回 `null` 让调用方说 `failed`——幽灵文本
 * 落错行比不落更贵。
 *
 * `wholeDocument` 的判据是**等式**而不是"看起来像整篇"：窗口从第一行起、且窗口行数
 * 恰等于 model 的总行数。尾裁（超长行）因此也会落成 `false`——宁可少给候选。
 */
export function kojo2InlineQueryOf(
  request: InlineCompletionRequest,
): Kojo2InlineQuery | null {
  const before = request.contextBefore;
  const after = request.contextAfter;
  const beforeLines = before.split('\n').length;
  const windowStartLine = request.line - (beforeLines - 1);
  if (windowStartLine < 1) return null;
  const source = before + after;
  const windowLines = source.split('\n').length;
  return {
    source,
    line: request.line - windowStartLine + 1,
    column: request.column,
    wholeDocument:
      windowStartLine === 1 &&
      request.lineCount !== undefined &&
      windowLines >= request.lineCount,
  };
}

/** adapter → 补全注入面（与 `src/completion.ts` 的 `optionsOf` 同一份投影，逐字同口径）。 */
function optionsOf(adapter: GameAdapter | null): Kojo2CompletionOptions {
  if (adapter === null) return {};
  const projections = kojo2CompletionOptionsFromAdapter(adapter);
  return { adapter, ...(projections ?? {}) };
}

/** 唯一候选 → 契约的一条幽灵文本（区间用**绝对行号** + 包内那枚列区间）。 */
function candidateOf(
  request: InlineCompletionRequest,
  result: Extract<Kojo2InlineResult, { state: 'unique' }>,
): InlineCompletionCandidate {
  const { candidate, startColumn, endColumn } = result;
  return {
    sourceId: KOJO2_INLINE_SOURCE_ID,
    range: {
      startLine: request.line,
      startColumn,
      endLine: request.line,
      endColumn,
    },
    insertText: candidate.insertText,
    kind: completionItemKindOf(candidate),
    // `note` = 候选自带的来源说明（"锚点 / 声明词 / 类型词…"）；宿主原文显示、不复述
    ...(candidate.detail === '' ? {} : { note: candidate.detail }),
  };
}

/**
 * 一次应答（**三态口径与契约逐字对齐**）：
 * 非 2.0 ⇒ `undefined`（弃权）；坐标映不回 ⇒ `failed`（`locate` 段，最容易静默错位的一档）；
 * 不唯一 / 这个位置不补 ⇒ `no-completion`；唯一 ⇒ `candidates` 一条，`version` 逐字回带。
 *
 * 包内判据都是纯函数且对越界自行夹取，理论不抛；真抛了归成 `failed`（`fetch` 段）——
 * 抛错在契约里只留给"输入本身不合法"，而那一条不成立。
 */
export function kojo2InlineCompletion(
  request: InlineCompletionRequest,
  deps: Kojo2InlineDeps,
): InlineCompletionOutcome | undefined {
  if (!isKojo2InlineRequest(request)) return undefined;
  const query = kojo2InlineQueryOf(request);
  if (query === null) {
    return {
      state: 'failed',
      stage: 'locate',
      reason: 'window-lines-exceed-cursor-line',
      note: '上下文窗的行数对不上光标行号 ⇒ 这一格没看成（不是"这里没有候选"）；重敲一次即可',
    };
  }
  let result: ReturnType<typeof kojo2InlineCompletionAt>;
  try {
    result = kojo2InlineCompletionAt(
      { source: query.source, line: query.line, column: query.column },
      optionsOf(deps.adapterFor(request.project?.adapterId)),
      { wholeDocument: query.wholeDocument },
    );
  } catch (error: unknown) {
    return {
      state: 'failed',
      stage: 'fetch',
      reason: 'kojo2-inline-threw',
      note: `2.0 语法判据这一次没跑完：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (result.state !== 'unique') return { state: 'no-completion' };
  return {
    state: 'candidates',
    version: request.version,
    candidates: [candidateOf(request, result)],
  };
}

/** 注册用的一枚贡献（`plugin.ts` 只做 `ctx.slots.register('completion.source', …)`） */
export function createKojo2InlineContribution(deps: Kojo2InlineDeps): InlineCompletionSourceContribution {
  return {
    id: KOJO2_INLINE_SOURCE_ID,
    order: KOJO2_INLINE_ORDER,
    title: KOJO2_INLINE_TITLE,
    provideInline: async (request: InlineCompletionRequest) =>
      kojo2InlineCompletion(request, deps),
  };
}
