import type * as Monaco from './entry';
import { errorText } from '@kojo/plugin-api';
import type {
  EditorCompletionItem,
  EditorCompletionRequest,
  EditorDocumentHighlightRequest,
  EditorDocumentHighlightResult,
  EditorFormattingLineRange,
  EditorFormattingRequest,
  EditorHoverRequest,
  EditorHoverResult,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  EditorProjectFile,
  EditorRangeEdit,
  EditorReferencesRequest,
  EditorReferencesResult,
  EditorRenameRequest,
  EditorRenameResult,
  EditorSelectionRangeRequest,
  EditorSelectionRangeResult,
  EditorSignature,
  EditorSignatureHelpRequest,
} from '@kojo/plugin-api';
import type { Kojo2ProjectIndex } from './kojo2-project-index';
import { pkey } from '../ui/file-tree-ops';

/**
 * LS-B0 的四条**取数腿**：`ui.editor.languageService` 在 LS-B0 批新扩的四个判别成员
 * （`completion` / `hover` / `formatting` / `signatureHelp`）的**合并与裁决**。
 *
 * ## 取数与裁决：四条腿已经全部上线（B3c / B3d）
 *
 * B0 只落"合并纪律"、B3c（补全 / 悬停）与 B3d（签名 / 格式化）把**安装器交回槽**：
 * 四个能力的唯一供方都是插件 `@kojo/plugin-kojo-lang`，宿主侧只剩"model → 请求"与
 * "契约 → Monaco"两段翻译（`kojo2-providers.ts` / `kojo2-signature.ts` / `kojo2-format.ts`）。
 *
 * 为什么必须等宿主原生实现删干净才能装 provider：同一格两份答案时，Monaco 对补全取并集
 * （候选翻倍）、对悬停取多家（两个浮层段落）、对格式化按"第一个非空"（谁先注册谁说了算，
 * 与本仓的注册顺序无关）。B0 的判据恰好是"既有贡献方零改动"，所以"删原生"与"装槽腿"
 * 是**同一步**——今天这四步都走完了。
 *
 * ## 请求构造器也住在这里（B3c 起）
 *
 * `completionRequestOf` / `hoverRequestOf` / `signatureRequestOf` / `formattingRequestOf`
 * 与身份三格（`editorRequestIdentityOf`）、取文（`modelTextOf`）同居：四条腿的
 * "缺省就不出现"口径与行数口径是**同一份事实**，手抄一份到 provider 里，抄漏 `version`
 * 的那条腿就废掉了供方的过期复核（这类失准只在"改完文件后的第一次应答"里出现）。
 *
 * ## 两种多源口径（与 `EditorLanguageServiceContribution` 头注逐字一致）
 *
 * B3f 又加两条单答腿：`documentHighlight` / `selectionRange`（判据住
 * `@kojo/kojo-lang/highlight` / `/selection-range`，供方是插件）。扩选那条一次多位置、
 * 整包作答——"某位点空链"（`null`）与"整条能力无人应答"（`undefined`）在
 * {@link collectSelectionRanges} 的注里分开写死。
 *
 * - **集合型**（`completion`）：各家取并集、按契约字段去重。一家抛错只让这家缺席。
 * - **单答型**（`hover` / `formatting` / `signatureHelp`）：**第一家作答的说了算**，
 *   后面的不再问。"给出空结果"也是作答（`contents === ''` / `edits === []` /
 *   `signatures === []`），**不等于弃权**——弃权只有 `undefined` 一种写法。
 *
 * 这条区分不是洁癖：把两份格式化结果并集起来会互相覆盖，把两段悬停拼起来是两句话说
 * 同一格，把两组签名并起来作者要在两个浮层之间挑。而"某家认这个文件但这一格没话说"
 * 必须能表达，否则它只能靠返回 `undefined` 装弃权——那下一家就会把**它本来要说的**
 * 说出来，浮层内容变成随供方数量漂移的产物。
 *
 * ## 抛错隔离
 *
 * 与 `collectInlayHints` / `collectCodeLenses` 同一条：**单枚贡献抛错不影响其余**
 * （能力出错要可见退化，不许整篇结果凭空消失）。`console.warn` 带上贡献 id，
 * 让"谁的实现炸了"在控制台里可定位——静默吞掉等于把一个坏插件伪装成好插件。
 */

/** 一条贡献的 `provide` 结果（含抛错归一）；抛错时 `result` 为 `undefined` 且已 warn */
function provideOf(
  contribution: EditorLanguageServiceContribution,
  request: EditorLanguageServiceRequest,
): ReturnType<EditorLanguageServiceContribution['provide']> {
  try {
    return contribution.provide(request);
  } catch (e: unknown) {
    console.warn(
      `[kojo-language-service-legs] '${contribution.id}' provide 抛错：${errorText(e)}`,
    );
    return undefined;
  }
}

/**
 * 合并全部贡献方的补全候选（**集合型**）。
 *
 * 去重键 = `label` + `insertText ?? label` + `kind`：两个供方在同一格给出**同一个候选**
 * 不该在列表里出现两遍；但 `label` 相同而 `insertText` 不同的**是两条**（"同名不同插法"
 * 是真实存在的情形，`label` 是人读名、`insertText` 才是落地文本），`kind` 不同则是
 * 图标与排序档不同（关键字与同名变量）。三者全同才是重复。
 *
 * 排序**不在这里做**：候选顺序由 Monaco 按 `sortText`（缺省按 `label`）排，
 * 宿主另排一遍只会与编辑器的行为打架。这里只保证"并集且无重复"。
 */
export function collectCompletionItems(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest,
): EditorCompletionItem[] {
  const out: EditorCompletionItem[] = [];
  const seen = new Set<string>();
  for (const contribution of contributions) {
    const result = provideOf(contribution, request);
    if (!result || result.kind !== 'completion') continue;
    for (const item of result.items) {
      const key = `${item.label}\u0000${item.insertText ?? item.label}\u0000${item.kind ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/**
 * 问出这一格的悬停响应（**单答型**，整块交回）。B3c 新增：`EditorHoverResult` 带上了
 * `format` / `range` 两格之后，只取 `contents` 的腿装不下供方的完整作答——这条腿把
 * **整个响应**交回宿主，宿主翻译层才有余地把 Markdown 与落点区间落地。
 *
 * 单答口径与 {@link collectHoverContents} **逐字一致**（后者现在就是坐在本函数上取
 * `contents`，签名与行为一字未动）：`undefined` = 弃权、继续问下一家；
 * `contents === ''` = 作答、不再问——两者混成同一个返回值，兜底就会在"这家明确说了
 * 没话说"的位置又冒出来（判据原文见本文件头注）。
 */
export function collectHoverResult(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest,
): EditorHoverResult | undefined {
  for (const contribution of contributions) {
    const result = provideOf(contribution, request);
    if (!result || result.kind !== 'hover') continue;
    return result;
  }
  return undefined;
}

/**
 * 问出这一格的悬停正文（**单答型**）。`undefined` = 无人应答；`''` = 有人认但无话可说。
 *
 * 这两种结果对调用方是**两种处置**：`undefined` 时宿主该保留自己的兜底（如原生
 * 词义悬浮），`''` 时浮层就该是空的——把两者混成同一个返回值，兜底就会在"这家
 * 明确说了没话说"的位置又冒出来，作者看到一段与现状矛盾的解释。
 */
export function collectHoverContents(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest,
): string | undefined {
  return collectHoverResult(contributions, request)?.contents;
}

/**
 * 问出这一篇的格式化编辑（**单答型**）。`undefined` = 无人应答（这篇不归任何语言包管）；
 * `[]` = 有人认这篇且不需要改。
 *
 * 返回值**按 `(startLine, startColumn)` 升序**交回：契约要求供方升序给出，但落地端是
 * **按降序应用**（避免坐标位移）。这里再排一次不是为了纠正谁，而是让"落地端只需
 * `reverse()`"这条契约成为**可验证的事实**而不是"所有供方都守规矩"的假设。
 *
 * 非法坐标（`NaN` / 非整数）**丢弃并 warn**：一个坐标错位的格式化会把整篇文件改成
 * 垃圾，而作者按 Ctrl+Z 只能撤一步——宁可少改一处（可见），不可错改一处（不可见）。
 */
export function collectFormattingEdits(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest,
): readonly EditorRangeEdit[] | undefined {
  for (const contribution of contributions) {
    const result = provideOf(contribution, request);
    if (!result || result.kind !== 'formatting') continue;
    const usable = usableRangeEdits(contribution, result.edits);
    return usable.sort(
      (a, b) => a.startLine - b.startLine || (a.startColumn ?? 1) - (b.startColumn ?? 1),
    );
  }
  return undefined;
}

/** 过滤掉坐标不可用的编辑（见 `collectFormattingEdits` 的注） */
function usableRangeEdits(
  contribution: EditorLanguageServiceContribution,
  edits: readonly EditorRangeEdit[],
): EditorRangeEdit[] {
  const out: EditorRangeEdit[] = [];
  for (const edit of edits) {
    if (!Number.isFinite(edit.startLine) || !Number.isFinite(edit.endLine)) {
      console.warn(
        `[kojo-language-service-legs] '${contribution.id}' 的格式化编辑行号非法（${edit.startLine}..${edit.endLine}），已丢弃`,
      );
      continue;
    }
    if (edit.startColumn !== undefined && !Number.isFinite(edit.startColumn)) {
      console.warn(
        `[kojo-language-service-legs] '${contribution.id}' 的格式化编辑列非法（${edit.startColumn}），已丢弃`,
      );
      continue;
    }
    if (edit.endColumn !== undefined && !Number.isFinite(edit.endColumn)) {
      console.warn(
        `[kojo-language-service-legs] '${contribution.id}' 的格式化编辑列非法（${edit.endColumn}），已丢弃`,
      );
      continue;
    }
    out.push(edit);
  }
  return out;
}

/**
 * 问出这一格的签名（**单答型**）。`undefined` = 无人应答；`[]` = 认这个位置但不在
 * 任何调用实参里（光标不在括号中）。
 *
 * 与 `hover` 同一处分歧理由：`undefined` 时宿主该退回自己的兜底签名面（
 * `kojo-signature.ts` 的 `describeErbSignature` 那条 additive 通道），`[]` 时
 * 就该什么都不弹——否则"光标明明不在实参里却弹出一个签名"。
 */
export function collectSignatureHelp(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest,
): readonly EditorSignature[] | undefined {
  for (const contribution of contributions) {
    const result = provideOf(contribution, request);
    if (!result || result.kind !== 'signatureHelp') continue;
    return result.signatures;
  }
  return undefined;
}

/**
 * 构造一个 `formatting` 请求（宿主接线用；四个 kind 的请求形状都是"文件 + 全文"，
 * 但字段名逐字不同，各写一条构造器比在调用处手搓对象字面量安全）。
 *
 * `lineCount` 是体量事实：供方可据此自行降级（契约既有口径），宿主**不替它判**。
 */
export function formattingRequestOf(
  identity: { readonly path: string; readonly languageId?: string; readonly version?: number },
  text: string,
  project: EditorFormattingRequest['project'],
  /**
   * 只格式化这一段（B3d additive）：**不给 = 整篇**，与加这一格之前逐字相同。
   * 给的形状与契约同名（1 基闭区间），宿主只做"Monaco range → 两枚行号"的搬运。
   */
  lineRange?: EditorFormattingLineRange,
): EditorFormattingRequest {
  const lineCount = text.length === 0 ? 1 : countLines(text);
  return {
    kind: 'formatting',
    path: identity.path,
    ...(identity.languageId !== undefined ? { languageId: identity.languageId } : {}),
    ...(identity.version !== undefined ? { version: identity.version } : {}),
    text,
    project,
    lineCount,
    ...(lineRange === undefined ? {} : { lineRange }),
  };
}

/**
 * 构造一个 `signatureHelp` 请求（B3d，宿主接线用；与 `hoverRequestOf` 同源形状）。
 *
 * `line` / `column` 是 1 基（Monaco 的 `Position` 同口径，直接递，不换算）。
 */
export function signatureRequestOf(
  identity: { readonly path: string; readonly languageId?: string; readonly version?: number },
  text: string,
  line: number,
  column: number,
  project: EditorSignatureHelpRequest['project'],
): EditorSignatureHelpRequest {
  return {
    kind: 'signatureHelp',
    path: identity.path,
    ...(identity.languageId !== undefined ? { languageId: identity.languageId } : {}),
    ...(identity.version !== undefined ? { version: identity.version } : {}),
    text,
    line,
    column,
    project,
    lineCount: text.length === 0 ? 1 : countLines(text),
  };
}

/**
 * 取整篇源文；模型已 dispose / 桩 model ⇒ `null`（调用方给空结果，绝不抛进击键路径）。
 *
 * B3d 起从 `kojo2-providers.ts` 提上来：补全 / 悬停 / 签名 / 格式化四条腿都要这同一刀，
 * 各抄一份就是"取文失败"有四种处置口径（其中一种迟早会抛）。
 */
export function modelTextOf(model: Monaco.editor.ITextModel): string | null {
  try {
    const text = model.getValue();
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/**
 * 这份 model 的**请求身份三格**（B3d 起四条腿共用）：`path` / `languageId` / `version`。
 *
 * 口径逐条是"能取到才出现"，取不到就不写那一格（供方据此少给要身份的那一部分）：
 * - 桩 model 没有 `uri` ⇒ `path: ''`（= 没有文件身份；不猜路径）；
 * - `getLanguageId` 缺 / 抛 / 空串 ⇒ `languageId` 键不出现（供方退回按路径认）；
 * - 版本号取不到 ⇒ 键不出现（不补一个假版本号——供方的过期复核会被它骗过）。
 */
export function editorRequestIdentityOf(model: Monaco.editor.ITextModel): {
  readonly path: string;
  readonly languageId?: string;
  readonly version?: number;
} {
  const fsPath = (model as unknown as { uri?: { fsPath?: unknown } }).uri?.fsPath;
  const path = typeof fsPath === 'string' ? fsPath : '';
  let languageId: string | undefined;
  try {
    const id = model.getLanguageId();
    if (typeof id === 'string' && id.length > 0) languageId = id;
  } catch {
    languageId = undefined;
  }
  let version: number | undefined;
  try {
    const id = model.getVersionId();
    if (Number.isFinite(id)) version = id;
  } catch {
    version = undefined;
  }
  return {
    path,
    ...(languageId !== undefined ? { languageId } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

/**
 * 构造一个 `completion` 请求（B3c，宿主接线用；与 {@link formattingRequestOf} 同源形状）。
 *
 * 为什么各腿共用这里的构造器而不是 provider 里手搓对象字面量：`languageId` / `version`
 * 的"缺省就不出现"口径、`lineCount` 的行数口径（见 `countLines` 注）都是收口腿的既有
 * 事实——手抄一份，抄漏 `version` 的那条腿就废掉了供方的过期复核，而这类失准只在
 * "改完文件后的第一次应答"里出现，事后极难归因。
 *
 * `triggerCharacter` 是 completion 独有的可选位：**不给 = 手动触发**（契约口径——
 * "这个字符算不算触发符"是语言知识，宿主只把键入的那一个字符原样递来）。
 */
export function completionRequestOf(
  identity: { readonly path: string; readonly languageId?: string; readonly version?: number },
  text: string,
  line: number,
  column: number,
  project: EditorCompletionRequest['project'],
  triggerCharacter?: string,
): EditorCompletionRequest {
  return {
    kind: 'completion',
    path: identity.path,
    ...(identity.languageId !== undefined ? { languageId: identity.languageId } : {}),
    ...(identity.version !== undefined ? { version: identity.version } : {}),
    text,
    line,
    column,
    project,
    lineCount: text.length === 0 ? 1 : countLines(text),
    ...(triggerCharacter !== undefined ? { triggerCharacter } : {}),
  };
}

/**
 * 构造一个 `hover` 请求（B3c，宿主接线用；同源形状，位置必填、无触发字符）。
 */
export function hoverRequestOf(
  identity: { readonly path: string; readonly languageId?: string; readonly version?: number },
  text: string,
  line: number,
  column: number,
  project: EditorHoverRequest['project'],
): EditorHoverRequest {
  return {
    kind: 'hover',
    path: identity.path,
    ...(identity.languageId !== undefined ? { languageId: identity.languageId } : {}),
    ...(identity.version !== undefined ? { version: identity.version } : {}),
    text,
    line,
    column,
    project,
    lineCount: text.length === 0 ? 1 : countLines(text),
  };
}

/** 行数（`\n` 计数 + 1；空串算 1 行——与 Monaco 的 `getLineCount()` 同口径） */
function countLines(text: string): number {
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

/* ============================== 引用 / 改名（B3e） ============================== */

/**
 * 项目文件快照的**文件数上限**（引用 / 改名两条腿共用）。
 *
 * 为什么有上限：快照是**显式动作**（Shift+F12 / F2）才付的，但代价是随项目规模线性涨的
 * （每份文本都要随请求过槽）。超限不静默：`projectFilesComplete` 置 `false`，供方据此
 * 降级（references 截断并置 `truncated`，rename 全或无拒绝）。
 */
export const KOJO2_PROJECT_FILES_MAX_FILES = 400;

/** 项目文件快照的**字节上限**（按 UTF-8 计；与文件数上限同时生效）。 */
export const KOJO2_PROJECT_FILES_MAX_BYTES = 8 * 1024 * 1024;

/** 一次快照的读数：文件列表（已排除请求文件）+ 是否完整 */
export interface Kojo2ProjectFilesSnapshot {
  readonly files: readonly EditorProjectFile[];
  readonly complete: boolean;
}

/**
 * 从项目索引现取一份**请求级快照**（宿主事实；两条显式动作各自的 provider 调它）。
 *
 * - 路径按归一键（`pkey`）排除**请求文件自己**——同文件结果由供方的同文件判据给，
 *   快照里再带一遍就是重复落点；
 * - 文件按索引的规范序（`index.files()` 已排序）原样保留；
 * - 落进上限的语义是**如实降级**：先到先得，截到上限即停并置 `complete = false`；
 *   取不到文本（`getFile` 失踪）同样置 `false`——"索引说有却读不到"不是"没有这份文件"。
 *
 * 索引缺席（`null` / `undefined`）= 没有快照可言（返回 `undefined`，请求里不出现
 * `projectFiles`，行为与加这一格之前逐字相同）。
 */
export function projectFilesSnapshotOf(
  index: Kojo2ProjectIndex | null | undefined,
  requestPath: string,
  limits: { readonly maxFiles?: number; readonly maxBytes?: number } = {},
): Kojo2ProjectFilesSnapshot | undefined {
  if (index === null || index === undefined) return undefined;
  const maxFiles = Math.max(0, Math.trunc(limits.maxFiles ?? KOJO2_PROJECT_FILES_MAX_FILES));
  const maxBytes = Math.max(0, Math.trunc(limits.maxBytes ?? KOJO2_PROJECT_FILES_MAX_BYTES));
  const excluded = requestPath.length > 0 ? pkey(requestPath) : null;
  const encoder = new TextEncoder();
  const files: EditorProjectFile[] = [];
  let bytes = 0;
  let complete = true;
  let paths: readonly string[];
  try {
    paths = index.files();
  } catch {
    return { files: [], complete: false };
  }
  for (const path of paths) {
    if (excluded !== null && pkey(path) === excluded) continue;
    if (files.length >= maxFiles) {
      complete = false;
      break;
    }
    let text: string | undefined;
    try {
      text = index.getFile(path)?.text;
    } catch {
      text = undefined;
    }
    if (typeof text !== 'string') {
      complete = false;
      continue;
    }
    const size = encoder.encode(text).length;
    if (bytes + size > maxBytes) {
      complete = false;
      break;
    }
    bytes += size;
    files.push({ path, text });
  }
  return { files, complete };
}

/**
 * 构造一个 `references` 请求（B3e，宿主接线用；同源形状）。
 *
 * `snapshot` 缺席 ⇒ 请求里**不出现** `projectFiles`（旧供方零改动）；给出就同时带
 * `projectFilesComplete`——供方据此知道"这是不是完整项目"。
 */
export function referencesRequestOf(
  identity: { readonly path: string; readonly languageId?: string; readonly version?: number },
  text: string,
  line: number,
  column: number,
  project: EditorReferencesRequest['project'],
  snapshot?: Kojo2ProjectFilesSnapshot,
): EditorReferencesRequest {
  return {
    kind: 'references',
    path: identity.path,
    ...(identity.languageId !== undefined ? { languageId: identity.languageId } : {}),
    ...(identity.version !== undefined ? { version: identity.version } : {}),
    text,
    line,
    column,
    project,
    lineCount: text.length === 0 ? 1 : countLines(text),
    ...(snapshot === undefined
      ? {}
      : { projectFiles: snapshot.files, projectFilesComplete: snapshot.complete }),
  };
}

/**
 * 构造一个 `rename` 请求（B3e，宿主接线用；同源形状，多带 `newName`）。
 *
 * 快照口径与 {@link referencesRequestOf} 逐字相同；区别只在供方那一侧的处理：
 * 改名是全或无，快照不完整时整次拒绝。
 */
export function renameRequestOf(
  identity: { readonly path: string; readonly languageId?: string; readonly version?: number },
  text: string,
  line: number,
  column: number,
  newName: string,
  project: EditorRenameRequest['project'],
  snapshot?: Kojo2ProjectFilesSnapshot,
): EditorRenameRequest {
  return {
    kind: 'rename',
    path: identity.path,
    ...(identity.languageId !== undefined ? { languageId: identity.languageId } : {}),
    ...(identity.version !== undefined ? { version: identity.version } : {}),
    text,
    line,
    column,
    newName,
    project,
    lineCount: text.length === 0 ? 1 : countLines(text),
    ...(snapshot === undefined
      ? {}
      : { projectFiles: snapshot.files, projectFilesComplete: snapshot.complete }),
  };
}

/**
 * 问出这一格的引用（**单答型**）。`undefined` = 无人应答；空 `locations` = 认这门语言
 * 但这处没有可证明的引用（**作答**）。
 *
 * 与 hover / signatureHelp 同一处分歧理由：`undefined` 时宿主交回空列表（不弹 Peek），
 * 但**不再问下一家**——再把空结果当弃权，兜底就会在"这家明确说了没有"的位置冒出来。
 */
export function collectReferences(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest,
): EditorReferencesResult | undefined {
  for (const contribution of contributions) {
    const result = provideOf(contribution, request);
    if (!result || result.kind !== 'references') continue;
    return result;
  }
  return undefined;
}

/**
 * 问出这一次改名（**单答型**）。`undefined` = 无人应答；`edits: []` = 认这门语言但
 * 拒绝 / 没有可改的（`rejectReason` 说原因，全或无）。
 *
 * 宿主落地前仍按 `resourcePath` 分派 URI——本函数只裁决"哪一家说了算"。
 */
export function collectRename(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest,
): EditorRenameResult | undefined {
  for (const contribution of contributions) {
    const result = provideOf(contribution, request);
    if (!result || result.kind !== 'rename') continue;
    return result;
  }
  return undefined;
}

/* ============================== 同符号高亮 / 扩选（B3f） ============================== */

/**
 * 构造一个 `documentHighlight` 请求（B3f，宿主接线用；同源形状）。
 */
export function documentHighlightRequestOf(
  identity: { readonly path: string; readonly languageId?: string; readonly version?: number },
  text: string,
  line: number,
  column: number,
  project: EditorDocumentHighlightRequest['project'],
): EditorDocumentHighlightRequest {
  return {
    kind: 'documentHighlight',
    path: identity.path,
    ...(identity.languageId !== undefined ? { languageId: identity.languageId } : {}),
    ...(identity.version !== undefined ? { version: identity.version } : {}),
    text,
    line,
    column,
    project,
    lineCount: text.length === 0 ? 1 : countLines(text),
  };
}

/**
 * 构造一个 `selectionRange` 请求（B3f，宿主接线用；同源形状，多带位置数组）。
 *
 * `positions` **原样递**（1 基，与 Monaco `Position` 同口径）：宿主不排序、不去重、
 * 不夹取——"哪几个位点要扩选"是编辑器给的事实，"越界位点怎么办"由供方按契约给空链。
 */
export function selectionRangeRequestOf(
  identity: { readonly path: string; readonly languageId?: string; readonly version?: number },
  text: string,
  positions: EditorSelectionRangeRequest['positions'],
  project: EditorSelectionRangeRequest['project'],
): EditorSelectionRangeRequest {
  return {
    kind: 'selectionRange',
    path: identity.path,
    ...(identity.languageId !== undefined ? { languageId: identity.languageId } : {}),
    ...(identity.version !== undefined ? { version: identity.version } : {}),
    text,
    project,
    lineCount: text.length === 0 ? 1 : countLines(text),
    positions,
  };
}

/**
 * 问出这一格的高亮（**单答型**）。`undefined` = 无人应答；空 `highlights` = 认这门语言
 * 但光标下没有可高亮的符号（**作答**）。
 *
 * 与 hover / references 同一处分歧理由：`undefined` 时宿主交回空列表（不亮），
 * 但**不再问下一家**——同符号高亮只有一套颜色，两家并集会让同一处记号一会儿写色一会儿读色。
 */
export function collectDocumentHighlights(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest,
): EditorDocumentHighlightResult | undefined {
  for (const contribution of contributions) {
    const result = provideOf(contribution, request);
    if (!result || result.kind !== 'documentHighlight') continue;
    return result;
  }
  return undefined;
}

/**
 * 问出这一次扩选（**单答型**，一次多位置、**整包作答**）。
 *
 * - `undefined` = **整条能力无人应答**（插件没装 / 弃权）：宿主交回空数组，Monaco 退回
 *   它自己的词语扩选；
 * - 作答时 `selections` 与请求的 `positions` **同序同长**，某一位点 `null` = **该位点
 *   空链**（空文件 / 越界 / 非法坐标）。这两件事不能混：把"某位点空链"当弃权去问下一家，
 *   扩选结果就会按供方数量漂移；把弃权写成"整排空链"，那门语言自己的 provider 永远轮不到。
 *
 * 对齐由供方保证（契约写死）；宿主安装层只按位点摊平成 Monaco 0.57 的形状。
 */
export function collectSelectionRanges(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest,
): EditorSelectionRangeResult | undefined {
  for (const contribution of contributions) {
    const result = provideOf(contribution, request);
    if (!result || result.kind !== 'selectionRange') continue;
    return result;
  }
  return undefined;
}
