import type * as Monaco from './entry';
import type { ErbFileFactsProvider } from './completion-core';
import { erbDeclaredNameSlot } from './erb-completion-families';
import { dimNamesOfBuffer } from '@kojo/plugin-erb-parser';
import { lineAt } from './kojo-completion-position';

/**
 * EC-DECL · **`#DIM` 声明名补全**（`#DIM 好感度` 声明过之后，正文里写这个名字时弹候选）。
 *
 * ## 数据来源（两态，顺序严格；与 `erb-completion-labels.ts` 同一口径）
 *
 * 1. `CompletionTables.erbFileFacts` 的 `dimsOf(path)` —— 当前文件的 `#DIM*` 声明名
 *    （内核索引语法事实；宿主把解析器索引通道注入补全表）。**数组（含 `[]`）= 索引有意见**
 *    ⇒ 直接用它，**不与缓冲区合并**（两份事实拼一张名单，冲突时没人说得出谁赢）；
 * 2. `undefined`（未索引 / 路径不在索引里 / 通道抛错）或**通道缺席** ⇒ 回退
 *    {@link dimNamesOfBuffer} 扫**当前缓冲区**。回退不是"猜"：索引此刻对这个文件没有任何
 *    意见，而缓冲区就是作者眼前那份原文（比索引更近）；`erb-completion-labels.ts` 对
 *    `labelsAt` 的未索引态早就是这么处理的，两条名位源照同一份纪律走。**旧口径"未索引 ⇒
 *    零候选不回退"是这条腿一直是空的那一半原因**：`.kojo` 从来不在 ERB 解析器索引里
 *    ⇒ `dimsOf` 恒 `undefined` ⇒ 糖面（`kojo-completion.ts` 的本文件声明名一路）与原生区
 *    （`route` 进 ERB 册的那一路）同时拿零候选。
 *
 * 两条路都**不写第二份 `#DIM` 正则**：逐行判据一律经 `@kojo/plugin-erb-parser` 的
 * {@link dimDeclarationOf}（其名字 / 指令切分取解析器 `parseDimDeclaration`；
 * `[SKIPSTART]…[SKIPEND]` 区间整段跳过与导航腿同一份屏蔽面）。
 *
 * ## 位置判据（单源共享）
 *
 * {@link erbDeclaredNameSlot}（自 `erb-completion-families.ts`，与变量族头源同一份裸标识符
 * 名位扫描——两个"名字位"源不各持一套）。替换范围**只覆盖名字段**；前缀按**大小写不敏感**
 * 比较（ERB 方言与 `#DIM` 引用同走引擎语义，大小写不敏感），展示保留声明原形。
 *
 * 名槽收口不在本模块：由装配层按**候选源 sourceId 白名单**执行（`.erb` =
 * `erb-completion-context.ts` 的 `ERB_GATE_SOURCE_WHITELIST`；`.kojo` = `kojo-completion.ts`
 * 的 `locate().keep`）——同为 `Variable` kind 的族头 / 属性名 / 声明名按 kind 收不干净。
 *
 * ## 路径口径
 *
 * {@link erbFactsPathOf} —— model.uri 的 `fsPath` 回落 `path` 回落 `''`（与
 * `kojo-completion-declarations.ts` 的 `filePathOf` 同形，含桩 model 防御）；路径归一
 * （大小写 / 分隔符 / 相对化）责任在宿主注入侧，本层零路径知识、不做规整。
 *
 * ## 纪律
 *
 * 纯函数 + 薄 Monaco 翻译（位置不符 ⇒ `[]`；索引与缓冲区**都给不出**名字 ⇒ `[]`）。
 * 通道求值抛错在本层吞成"未索引"（走回退），**不编候选顶替**。
 */

/** model 的文件路径（桩 model 没有 `uri` ⇒ 空串；与 `kojo-completion-declarations.ts` 的 `filePathOf` 同形） */
export function erbFactsPathOf(model: Monaco.editor.ITextModel): string {
  const uri = (model as { uri?: { fsPath?: unknown; path?: unknown } }).uri;
  if (uri === null || typeof uri !== 'object') return '';
  if (typeof uri.fsPath === 'string' && uri.fsPath.length > 0) return uri.fsPath;
  return typeof uri.path === 'string' ? uri.path : '';
}

/**
 * 缓冲区全文（桩 model / 旧运行时可能没有 `getValue` ⇒ 空串：回退路自然落空，不抛）。
 * 与 `kojo-completion-declarations.ts` 的 `textOf` 同形（防御口径只此一份写法可抄，因为它
 * 们的**记忆化对象**同形——见 {@link DIM_CACHE}）。
 */
function textOf(model: Monaco.editor.ITextModel): string {
  const getValue = (model as { getValue?: () => string }).getValue;
  return typeof getValue === 'function' ? getValue.call(model) ?? '' : '';
}

/**
 * 扫一份文本里的 `#DIM*` 声明名——**实现已搬进插件**（`@kojo/plugin-erb-parser` 的
 * `completion.ts`，2026-10-31 收口）。
 *
 * 搬补全判据时这段扫描在宿主与插件各存了一份（同一段遍历 + 同一套 `[SKIPSTART]…[SKIPEND]`
 * 屏蔽面）；现在宿主回退路径直接读插件那枚 `dimNamesOfBuffer`，判据 / 遍历都回到一格。
 * 逐行判据仍是 `dimDeclarationOf`（解析器 `parseDimDeclaration` 的单源包装），本文件只留
 * 「什么时候回退到缓冲区」这一层判断。
 */
export { dimNamesOfBuffer };

/**
 * 按 model 记忆化的缓冲区声明名（与 `kojoDeclarationsOf` / `cachedLabels` 同一纪律）。
 *
 * 全文扫描是每击键 `O(文件大小)`；同一版本（未编辑）下声明**必不变** ⇒ 复用上次数组（同一引用）。
 * 版本号缺席（桩 model）⇒ 退化为按**文本身份**记忆化；两者都拿不到 ⇒ 每次重扫（正确，仅失去缓存）。
 * `WeakMap` 按 model 身份：编辑器关闭即回收，不产生无界增长。
 */
const DIM_CACHE = new WeakMap<
  Monaco.editor.ITextModel,
  { readonly versionId: number | undefined; readonly text: string; readonly names: readonly string[] }
>();

function bufferedDimNames(model: Monaco.editor.ITextModel): readonly string[] {
  const text = textOf(model);
  if (text.length === 0) return [];
  const getVersionId = (model as { getVersionId?: () => number }).getVersionId;
  const versionId = typeof getVersionId === 'function' ? getVersionId.call(model) : undefined;
  const cached = DIM_CACHE.get(model);
  if (cached !== undefined) {
    const fresh = typeof versionId === 'number' ? cached.versionId === versionId : cached.text === text;
    if (fresh) return cached.names;
  }
  const names = dimNamesOfBuffer(text);
  DIM_CACHE.set(model, { versionId, text, names });
  return names;
}

/**
 * 当前文件的 `#DIM` 声明名（**两态取数，两门语言共用这一份**）。
 *
 * 索引有意见（数组，含 `[]`）⇒ 用它；未索引 / 路径不在索引里 / 通道抛错 / 通道缺席 ⇒ 缓冲区
 * （见模块头注的口径变更理由）。`.kojo` 侧的本文件声明名（`kojo-completion.ts` 的
 * {@link declarationItems} 一路）经同一枚函数取数 ⇒ 糖面与原生区两条路拿到**同一份事实**。
 */
export function erbDimNamesOf(
  model: Monaco.editor.ITextModel,
  facts: ErbFileFactsProvider | undefined,
): readonly string[] {
  if (facts !== undefined) {
    let dims: readonly string[] | undefined;
    try {
      dims = facts.dimsOf(erbFactsPathOf(model));
    } catch {
      dims = undefined; // 通道抛错 = 取不到 ⇒ 与未索引同语义（回退缓冲区），绝不抛进补全链
    }
    if (dims !== undefined) return dims;
  }
  return bufferedDimNames(model);
}

/**
 * 产出 `#DIM` 声明名候选（**纯函数**，供补全基座调用）。
 *
 * 行为：仅当光标落在裸标识符名位（{@link erbDeclaredNameSlot}）时产出候选；名单经
 * {@link erbDimNamesOf} 两态取数（索引 → 缓冲区回退）。按**大小写不敏感前缀**过滤声明名，
 * `kind` = Variable、`insertText` / `filterText` = 名字、`detail` = `#DIM 声明（本文件）`、
 * 替换范围**只覆盖名字段**。排序受控（**前缀精确优先**，同别源打法；档位 `4_` / `5_` 与既有
 * 各源的 `0_` / `1_` / `2_` / `0000_` 档不撞）。名字去重按大小写不敏感。
 */
export function erbDeclaredCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  facts: ErbFileFactsProvider | undefined,
): Monaco.languages.CompletionItem[] {
  const slot = erbDeclaredNameSlot(lineAt(model, position.lineNumber), position.column);
  if (slot === null) return [];
  const dims = erbDimNamesOf(model, facts);
  if (dims.length === 0) return [];

  const needle = slot.prefix.toUpperCase();
  const range: Monaco.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: slot.start + 1,
    endColumn: slot.end + 1,
  };
  const items: Monaco.languages.CompletionItem[] = [];
  const seen = new Set<string>();
  for (const name of dims) {
    if (name.length === 0) continue;
    const upper = name.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    if (needle.length > 0 && !upper.startsWith(needle)) continue;
    const exact = needle.length > 0 && upper === needle;
    items.push({
      label: name,
      kind: monaco.languages.CompletionItemKind.Variable,
      insertText: name,
      filterText: name,
      detail: '#DIM 声明（本文件）',
      range,
      sortText: `${exact ? '4' : '5'}_${name}`,
    });
  }
  return items;
}