import type * as Monaco from './entry';
import type { ErbFileFactsProvider } from './completion-core';
import { erbLabelSlot } from './erb-completion-context';
import { erbFactsPathOf } from './erb-completion-declared';

/**
 * EC-4 · `.erb` 的 `$标签` 补全 —— 写跳转族（`JUMP` / `GOTO` / `TRYJUMP` / `TRYGOTO`）之后，
 * 弹**本文件内**已定义的标签名。
 *
 * 口上没有模块系统：跳转只在同一文件内成立。候选来源两态（`ErbFileFactsProvider.labelsAt`
 * 语义严格分家，见 `completion-core.ts` 契约）：
 * - 数组 ⇒ **解析器权威事实**（光标行所属函数局部；`[SKIPSTART]` 区已由解析器排除）⇒ 直接用；
 * - `undefined`（未索引 / 提供者抛错）⇒ 回退全文扫描 `definedLabels`（**仅未索引时用**）；
 * - `[]`（已索引确无该项）⇒ 零候选，**不回退**。
 *
 * 检测判据 = `erb-completion-context.ts` 的 {@link erbLabelSlot} **单源**（四个跳转词、全角
 * 空白分隔、可选 `$`）；本文件不再手抄 `JUMP_CONTEXT_RE` / `JUMP_KEYWORDS` / `isLabelChar`。
 * 前缀过滤大小写不敏感（Emuera 标签名不区分大小写，解析器 `ErbLabel` 注释有实据）：
 * 比较统一 `toUpperCase`，展示保留解析器原文。
 *
 * 纯逻辑 + 薄翻译（与 `kojo-completion-variables.ts` 同纪律）：本模块**只**导出可单测的
 * 纯函数，不注册 provider（装配点由 ERB 补全基座负责，宿主层零改动）。
 * 位置不符 / 无标签定义 ⇒ 返回 `[]`，**不猜、不抛**。
 */

/** 标签定义扫描：行首（可含前导空白）`$名字`，名字止于空白 / `;`（与 `erb-language` 词法一致）。 */
const LABEL_DEF_RE = /^\s*\$([^\s;]+)/gm;

/** 全文扫描标签定义名（去重、保序）——**仅未索引时的回退路径**（`labelsAt` 缺席 / 返回 `undefined`）。 */
function definedLabels(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(LABEL_DEF_RE)) {
    const name = m[1];
    if (name !== undefined && name.length > 0 && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * 按 model 版本记忆化的标签表（**回退路径专用**）。全文正则扫描是每击键 `O(文件大小)`；同一版本
 * （未编辑）下标签定义**必不变** ⇒ 复用上次数组（同一引用）。版本号缺席（桩 model / 旧运行时）
 * ⇒ 退化为每次重扫（行为正确，仅失去缓存），**不假定字段存在**。
 *
 * `WeakMap` 按 model 身份：编辑器关闭后自动回收，不产生无界增长。
 */
const LABEL_CACHE = new WeakMap<Monaco.editor.ITextModel, { readonly versionId: number; readonly labels: readonly string[] }>();

function cachedLabels(model: Monaco.editor.ITextModel): readonly string[] {
  const getVersionId = (model as { getVersionId?: () => number }).getVersionId;
  const versionId = typeof getVersionId === 'function' ? getVersionId.call(model) : undefined;
  if (typeof versionId !== 'number') return definedLabels(model.getValue());

  const cached = LABEL_CACHE.get(model);
  if (cached !== undefined && cached.versionId === versionId) return cached.labels;

  const labels = definedLabels(model.getValue());
  LABEL_CACHE.set(model, { versionId, labels });
  return labels;
}

/**
 * 产出跳转族（`JUMP` / `GOTO` / `TRYJUMP` / `TRYGOTO`）后**本文件内** `$标签` 名的补全候选
 * （**纯函数**）。
 *
 * 行为：仅当光标经 {@link erbLabelSlot} 判定在标签目标位时产出候选；候选来源按 `facts` 两态
 * （见模块头注）：索引在手 ⇒ 解析器事实（作用域已收窄到光标行所属函数，`[SKIPSTART]` 已排除）；
 * 未索引 ⇒ 回退全文扫描。`kind` = Reference，`insertText` = 名字（**不重复补 `$`**——作者已敲
 * `$` 则与 `$` 并存），`detail` = `标签（本文件）`；排序受控（前缀精确匹配优先，大小写归一
 * 比较），替换范围**只覆盖标签名那一段**（含前导 `$` 时 `$` 留在范围外）。位置不符 / 无标签 /
 * 前缀无命中 ⇒ 返回 `[]`，不抛。
 *
 * `facts`（可选第 4 参，additive——旧 3 参调用零改动）：装配层传 `tables.erbFileFacts`。
 * `labelsAt` 抛错 = 取不到 ⇒ 同一回退语义（不崩、不猜）。
 */
export function erbLabelCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  facts?: ErbFileFactsProvider,
): Monaco.languages.CompletionItem[] {
  const line = model.getLineContent(position.lineNumber);

  // 跳转上下文（四关键字 / 全角空白 / 可选 `$`）一律经 context 单源判据；其余位置一问即走，绝不猜。
  const slot = erbLabelSlot(line, position.column);
  if (slot === null) return [];

  // 作用域收窄：索引在手以解析器事实为准（函数局部 + `[SKIPSTART]` 已排除）；未索引才回退全文。
  let labels: readonly string[] | undefined;
  if (facts !== undefined) {
    try {
      labels = facts.labelsAt(erbFactsPathOf(model), position.lineNumber);
    } catch {
      labels = undefined; // 提供者抛错 = 取不到 ⇒ 回退（与未索引同语义）
    }
  }
  if (labels === undefined) labels = cachedLabels(model); // 仅未索引时用
  if (labels.length === 0) return [];

  // 前缀过滤大小写不敏感（Emuera 标签名不区分大小写）：比较用大写、展示保留原文。
  const prefix = slot.prefix.toUpperCase();
  const matched = prefix.length === 0 ? labels : labels.filter((name) => name.toUpperCase().startsWith(prefix));
  if (matched.length === 0) return [];

  const range: Monaco.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: slot.start + 1,
    endColumn: slot.end + 1,
  };

  return matched.map((name) => ({
    label: name,
    kind: monaco.languages.CompletionItemKind.Reference,
    insertText: name,
    detail: '标签（本文件）',
    range,
    sortText: `${prefix.length > 0 && name.toUpperCase() === prefix ? '0' : '1'}_${name}`,
  }));
}