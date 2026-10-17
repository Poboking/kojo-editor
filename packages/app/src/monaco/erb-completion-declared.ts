import type * as Monaco from './entry';
import type { ErbFileFactsProvider } from './completion-core';
import { erbDeclaredNameSlot } from './erb-completion-families';
import { lineAt } from './kojo-completion-position';

/**
 * EC-DECL · `.erb` **`#DIM` 声明名补全**（`#DIM 好感度` 声明过之后，正文里写这个名字时弹候选）。
 *
 * ## 数据来源（只此一条，宿主 / 解析器通道）
 *
 * `CompletionTables.erbFileFacts` 的 `dimsOf(path)` —— 当前 `ErbFile` 的 `#DIM*` 声明名
 * （内核索引语法事实；宿主把解析器索引通道注入补全表）。本模块**不扫全文、不写第二份 `#DIM`
 * 正则**：`undefined`（未索引 / 取不到）⇒ **零候选、不回退**——回退全文口径只会拿出与索引
 * 不一致的假事实；`[]`（已索引但确无声明）同样零候选。通道缺席（`facts === undefined`）⇒
 * 零候选。**不猜、不编**。
 *
 * ## 位置判据（单源共享）
 *
 * {@link erbDeclaredNameSlot}（自 `erb-completion-families.ts`，与变量族头源同一份裸标识符
 * 名位扫描——两个"名字位"源不各持一套）。替换范围**只覆盖名字段**；前缀按**大小写不敏感**
 * 比较（ERB 方言与 `#DIM` 引用同走引擎语义，大小写不敏感），展示保留声明原形。
 *
 * ## 路径口径
 *
 * {@link erbFactsPathOf} —— model.uri 的 `fsPath` 回落 `path` 回落 `''`（与
 * `kojo-completion-declarations.ts` 的 `filePathOf` 同形，含桩 model 防御）；路径归一
 * （大小写 / 分隔符 / 相对化）责任在宿主注入侧，本层零路径知识、不做规整。
 *
 * ## 纪律
 *
 * 纯函数 + 薄 Monaco 翻译（位置不符 / 通道缺席 / 未索引 ⇒ `[]`）。通道求值抛错**不在此吞**：
 * 装配层对 source 抛错有逐源兜底（跳过 + 一行可见 warn），本函数不编候选顶替。
 */

/** model 的文件路径（桩 model 没有 `uri` ⇒ 空串；与 `kojo-completion-declarations.ts` 的 `filePathOf` 同形） */
export function erbFactsPathOf(model: Monaco.editor.ITextModel): string {
  const uri = (model as { uri?: { fsPath?: unknown; path?: unknown } }).uri;
  if (uri === null || typeof uri !== 'object') return '';
  if (typeof uri.fsPath === 'string' && uri.fsPath.length > 0) return uri.fsPath;
  return typeof uri.path === 'string' ? uri.path : '';
}

/**
 * 产出 `#DIM` 声明名候选（**纯函数**，供补全基座调用）。
 *
 * 行为：仅当光标落在裸标识符名位（{@link erbDeclaredNameSlot}）时产出候选；`facts` 缺席 /
 * `dimsOf` 返回 `undefined`（未索引）⇒ `[]`（**零候选、不回退**）；否则按**大小写不敏感
 * 前缀**过滤声明名，`kind` = Variable、`insertText` / `filterText` = 名字、`detail` =
 * `#DIM 声明（本文件）`、替换范围**只覆盖名字段**。排序受控（**前缀精确优先**，同别源打法；
 * 档位 `4_` / `5_` 与既有各源的 `0_` / `1_` / `2_` / `0000_` 档不撞）。名字去重按大小写不敏感。
 */
export function erbDeclaredCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  facts: ErbFileFactsProvider | undefined,
): Monaco.languages.CompletionItem[] {
  if (facts === undefined) return [];
  const slot = erbDeclaredNameSlot(lineAt(model, position.lineNumber), position.column);
  if (slot === null) return [];
  const dims = facts.dimsOf(erbFactsPathOf(model));
  if (dims === undefined) return []; // 未索引 ⇒ 零候选（不回退，不猜）

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