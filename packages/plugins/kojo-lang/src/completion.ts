/**
 * `completion` 供方：包里的候选组装（`@kojo/kojo-lang/completion`）→ 契约的 `EditorCompletionItem`。
 *
 * ## B3c：这一格从"宿主原生 provider"换成了"插件供方"
 *
 * 判据全部住在 `@kojo/kojo-lang`（`kojo2CompletionAt` / `kojo2SnippetCandidatesAt` /
 * `kojo2CompletionRangeAt` / `kojo2DeclarationIndexFor` / `kojo2DeclarationForCandidate` /
 * `kojo2CompletionOptionsFromAdapter`，行为与搬进包之前的宿主逐字相同），本文件只做**翻译**：
 * 语义类别 → 契约中性档、候选 → `EditorCompletionItem`、adapter → 补全注入面。
 * Monaco 侧的 `triggerCharacters`（`KOJO2_COMPLETION_TRIGGER_CHARS`）与 Monaco 枚举映射
 * 归宿主收口（契约档 → Monaco 图标是宿主那一层的最后一张表，见简报§四）。
 *
 * ## 三态（与 definition / inlay 同一条纪律）
 *
 * - **非 kojo2 请求 ⇒ `undefined`（弃权）**：让下一家供方接手，不是"这里没有候选"；
 * - **认这个位置但一个候选都没有 ⇒ `{ items: [] }`**（**不猜**：台词正文 / 原生围栏 /
 *   未注入的 adapter 事实位，都如实交回空数组，宿主不弹窗）；
 * - 有候选 ⇒ 全部条目（纯函数候选 + 行首追加的块级 snippets）。
 *
 * ## adapter：请求时现取 + **只认 id 对得上的那一枚**
 *
 * `adapter` 由 `plugin.ts` 经 `@kojo/kojo-lang/adapter-source` 登记表**在请求时**现取，
 * 且 `adapter.id === request.project?.adapterId` 才递进来（`inlay.ts` 同一条纪律）。
 * 对不上 ⇒ 按"没有 adapter 事实"作答：事件名 / 事件参数 / 颜绘参数 / 行尾提示名四路零候选，
 * 其余从源文能证明的路（锚点 / 声明词 / 域符号 / 声明名单 / 类型词 / 存储期 / 形参 / 插槽）
 * **照给**——少给的是那一部分，不拿 A 游戏的目录去解释 B 游戏的 `# 机`。
 *
 * ## 逐格的翻译口径（与今天宿主 `kojo2-providers.ts` 逐字对齐）
 *
 * - `range` = `kojo2CompletionRangeAt(line, 该行文本, column)`：**整枚名字段**而不是
 *   "到光标为止"（`# 变|量` 补成 `# 设` 时替换整枚名字，否则拼出 `变量量`）；名字段外
 *   ⇒ 零宽（插在光标处）。该行文本按 `/\r\n|\r|\n/` 切（与包内 `kojo2SnippetCandidatesAt`
 *   同一条切行口径，宿主今天也是这一条兜底路径）；
 * - `filterText` = `label`：2.0 名字区分大小写、没有拼音键，显示名就是匹配键；
 * - `insertText` / `detail` / `sortText` 原样透传——排名键（`0_` 锚点 … `9_snippet` 骨架）
 *   是纯模型带过来的事实，本层不改写；
 * - `documentation`：**只在本轮真有 `declaration` 类候选时**才建声明索引
 *   （`kojo2DeclarationIndexFor` 是第二趟解析，锚点 / 事件 / 域符号轮次不付这份成本——
 *   与今天宿主同一条性能纪律，不许改成每轮都建）；命中则给 `kojo2DeclarationMarkdown`
 *   并声明 `documentationFormat: 'markdown'`（正文措辞住在包 `hover.ts`，与悬停共用一份）；
 * - `kind`：`Kojo2CompletionKind` → 契约十二档，见 {@link completionItemKindOf}——
 *   **图标一旦降级，作者对候选集的视觉记忆就断了**（简报§四逐格照抄，不借邻居的色）。
 *
 * ## 块级 snippets
 *
 * `kojo2SnippetCandidatesAt` 自带行首位置门（光标之前只有空白才出货），本层把每条骨架
 * 翻成 `kind: 'snippet'` 的候选追加在纯函数候选之后（`sortText: '9_snippet_*'` 保证排位）。
 * 今天宿主"桩 Monaco 缺 Snippet / InsertTextRule 枚举就整段跳过 snippet"的守卫属于
 * **Monaco 翻译层**（车道 4），不在这里——契约层没有"枚举可能缺席"这回事。
 *
 * ## 抛错面
 *
 * 包内函数都是纯函数且对越界自行夹取，理论上不抛；真抛了也不冒到宿主——宿主会把 throw
 * 吞成"补全突然没了"，这里归成 `{ items: [] }`（"这一轮没有可证明的候选"，有语义的答复）。
 */
import type {
  EditorCompletionItem,
  EditorCompletionItemKind,
  EditorLanguageRange,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
// 只取**类型**：2.0 adapter 的形状住 core（与 plugin-api 的 v1 `GameAdapter` 不是一个类型），
// 运行时不 import `@kojo/kojo-core`（`inlay.ts` / `definition.ts` 同规）。
import type { GameAdapter } from '@kojo/kojo-core';
import {
  kojo2CompletionAt,
  kojo2CompletionOptionsFromAdapter,
  kojo2CompletionRangeAt,
  kojo2DeclarationForCandidate,
  kojo2DeclarationIndexFor,
  type Kojo2CompletionCandidate,
  type Kojo2CompletionOptions,
} from '@kojo/kojo-lang/completion';
import { kojo2SnippetCandidatesAt, type Kojo2CompletionSnippet } from '@kojo/kojo-lang/completion-snippets';
import { kojo2DeclarationMarkdown } from '@kojo/kojo-lang/hover';
import { isKojo2Request } from './request';

/** 可选注入面（缺省 = 只用源文能证明的路，adapter 事实四路零候选——不猜） */
export interface CompletionAdapterInjection {
  /** 当前项目的 2.0 adapter（`plugin.ts` 请求时现取并核过 id；对不上 ⇒ `null`） */
  readonly adapter?: GameAdapter | null;
}

/** 没有声明类候选的那一轮用的空索引（避免每轮都建一份——与今天宿主同一条纪律） */
const NO_DECLARATIONS: ReturnType<typeof kojo2DeclarationIndexFor> = new Map();

/**
 * 语义类别 → 契约中性档（**简报§四的表，逐格照抄**；宿主再映 Monaco 枚举，最终图标与今天逐格相同）。
 *
 * 分档理由与今天宿主 `kojo2CompletionKindOf` 一致：`# @ > ? !` 是语法标点 ⇒ `operator`
 * （`keyword` 是给语句词的，不混用）；声明词是保留词族 ⇒ `keyword`；事件目录落点是一处时机
 * ⇒ `event`（`function` 的落点是一次调用）；域符号是代词变量 ⇒ `variable`；声明名按种类细分。
 * 未知类别 ⇒ `text`（缺省方向永远是"少说"，不是"借一个像的色"）。
 */
export function completionItemKindOf(candidate: Kojo2CompletionCandidate): EditorCompletionItemKind {
  switch (candidate.kind) {
    case 'anchor':
      return 'operator';
    case 'declarationWord':
      return 'keyword';
    case 'event':
      return 'event';
    case 'domainSymbol':
      return 'variable';
    case 'declaration':
      return declarationItemKindOf(candidate.declarationKind);
    // K2-COMPLETE-ARGS-FACE 的加档（细分映射只在此处；纯函数层只给语义类别）
    case 'eventArgument':
      return 'value';
    case 'valueType':
    case 'storagePeriod':
      return 'keyword';
    case 'templateParam':
    case 'faceObject':
      return 'variable';
    case 'faceArgument':
      return 'value';
    case 'templateSlot':
    case 'hintName':
      return 'text';
    default:
      return 'text';
  }
}

/** `declaration` 类候选按声明种类细分（表→`struct`、池→`enum`、模→`snippet`、幕→`module`…）。 */
function declarationItemKindOf(
  kind: Kojo2CompletionCandidate['declarationKind'],
): EditorCompletionItemKind {
  switch (kind) {
    case 'variable':
      return 'variable';
    case 'constant':
      return 'constant';
    case 'table':
      return 'struct';
    case 'pool':
      return 'enum';
    case 'template':
      return 'snippet';
    case 'function':
      return 'function';
    case 'scene':
      return 'module';
    default:
      return 'text';
  }
}

/** 候选 → 契约条目（`documentation` 命中声明索引时才写这两格，缺省形态与加格之前逐字一致）。 */
function completionItemOf(
  candidate: Kojo2CompletionCandidate,
  range: EditorLanguageRange,
  declarations: ReturnType<typeof kojo2DeclarationIndexFor>,
): EditorCompletionItem {
  const declaration = kojo2DeclarationForCandidate(candidate, declarations);
  return {
    label: candidate.label,
    kind: completionItemKindOf(candidate),
    insertText: candidate.insertText,
    detail: candidate.detail,
    sortText: candidate.sortText,
    filterText: candidate.label,
    range,
    ...(declaration === undefined
      ? {}
      : { documentation: kojo2DeclarationMarkdown(declaration), documentationFormat: 'markdown' as const }),
  };
}

/**
 * 块级骨架 → 契约条目（**唯一**声明 `insertTextFormat: 'snippet'` 的那一路：占位符按模板
 * 落地）。对照 {@link completionItemOf}——`# 模` 的声明名也吃 `snippet` 图标，但**不吃**
 * snippet 插入（名字里没有占位符，按模板解释会把 `$` / `}` 当槽位），故那里保持缺省
 * `plainText`。今天宿主的形状正是如此（`InsertAsSnippet` 只随块级骨架下发）。
 */
function snippetItemOf(snippet: Kojo2CompletionSnippet, range: EditorLanguageRange): EditorCompletionItem {
  return {
    label: snippet.label,
    kind: 'snippet',
    insertText: snippet.insertText,
    insertTextFormat: 'snippet',
    detail: snippet.detail,
    sortText: snippet.sortText,
    filterText: snippet.label,
    range,
  };
}

/**
 * adapter → 补全注入面（今天宿主 `eventArgsOf` / `faceTemplatesOf` / `hintNamesOf` 三路投影
 * 就是包内 `kojo2CompletionOptionsFromAdapter` 一枚；`adapter` 本体另传给 `kojo2CompletionAt`
 * 派生事件名——`# 机` / `@织` 的名单唯一来源）。没有 adapter ⇒ `{}`：四路 adapter 事实零候选。
 */
function optionsOf(adapter: GameAdapter | null): Kojo2CompletionOptions {
  if (adapter === null) return {};
  const projections = kojo2CompletionOptionsFromAdapter(adapter);
  return { adapter, ...(projections ?? {}) };
}

/** 某一行原文（`/\r\n|\r|\n/` 切行，与包内 `kojo2SnippetCandidatesAt` 同一口径；越界 = 空串）。 */
function lineTextOf(text: string, line: number): string {
  return text.split(/\r\n|\r|\n/)[line - 1] ?? '';
}

/**
 * 交回 `{ kind: 'completion', items }`，或 `undefined`（弃权：不是 completion / 不是 kojo2）。
 *
 * `range` 整轮算一次、全部候选共用（与今天宿主同形——替换区间只由光标处词段决定，与候选无关）。
 */
export function provideCompletion(
  request: EditorLanguageServiceRequest,
  injection: CompletionAdapterInjection = {},
): { kind: 'completion'; items: EditorCompletionItem[] } | undefined {
  if (request.kind !== 'completion') return undefined;
  if (!isKojo2Request(request)) return undefined;
  try {
    const query: { source: string; line: number; column: number } = {
      source: request.text,
      line: request.line,
      column: request.column,
    };
    const candidates = kojo2CompletionAt(query, optionsOf(injection.adapter ?? null));
    const range = kojo2CompletionRangeAt(request.line, lineTextOf(request.text, request.line), request.column);
    // 声明索引只为 `documentation` 建，且**只在真有声明类候选的这一轮**（第二趟解析的成本）
    const declarations = candidates.some((candidate) => candidate.kind === 'declaration')
      ? kojo2DeclarationIndexFor(request.text)
      : NO_DECLARATIONS;
    const items = candidates.map((candidate) => completionItemOf(candidate, range, declarations));
    for (const snippet of kojo2SnippetCandidatesAt(query)) {
      items.push(snippetItemOf(snippet, range));
    }
    return { kind: 'completion', items };
  } catch {
    return { kind: 'completion', items: [] };
  }
}

// 形状与 legs 的 `completionRequestOf` 对齐（供车道 4 接线时核对）：本供方读的字段恰是
// `text` / `line` / `column`（+ 弃权判定用的 `languageId` / `path`）与 `project.adapterId`，
// 其余格（`version` / `lineCount` / `triggerCharacter`）零消费、零依赖。
