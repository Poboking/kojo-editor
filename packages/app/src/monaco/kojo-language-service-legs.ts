import { errorText } from '@kojo/plugin-api';
import type {
  EditorCompletionItem,
  EditorCompletionRequest,
  EditorFormattingRequest,
  EditorHoverRequest,
  EditorHoverResult,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  EditorRangeEdit,
  EditorSignature,
} from '@kojo/plugin-api';

/**
 * LS-B0 的四条**取数腿**：`ui.editor.languageService` 在 LS-B0 批新扩的四个判别成员
 * （`completion` / `hover` / `formatting` / `signatureHelp`）的**合并与裁决**。
 *
 * ## 为什么只有"取数"，没有"装 provider"
 *
 * 这一批的边界是**契约**，不是**上线**：四个能力今天都已经有宿主实现在跑
 * （`kojo2-completion.ts` / `kojo2-hover.ts` / `kojo2-format.ts` / `kojo2-signature.ts`，
 * 各自 `monaco.languages.register*Provider` 在 `kojo2` 语言 id 上）。此刻再把槽里的
 * 产出也装一枚 provider，同一格会有**两份答案**：
 * Monaco 对补全取并集（候选翻倍）、对悬停取多家（两个浮层段落）、对格式化按
 * "第一个非空"（谁先注册谁说了算，与本仓的注册顺序无关）。这不是"新增能力"，
 * 是**改既有行为**——B0 的判据恰好是"既有贡献方零改动"。
 *
 * 所以本批只把**合并纪律**落成可单测的纯函数；真正 `install*Provider` 与
 * `kojo2-*.ts` 的删除是**同一步**（B2/B3），届时宿主那一路消失，槽里这一路接手。
 *
 * ## 两种多源口径（与 `EditorLanguageServiceContribution` 头注逐字一致）
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
