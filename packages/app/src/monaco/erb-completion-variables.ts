import type * as Monaco from './entry';
import type { VariableSchema } from '@kojo/plugin-api';
import { erbVariableSlotAt } from '@kojo/erb-lang/completion-variables';

/**
 * ERB 变量引用**名字位判据**已搬进 `@kojo/erb-lang/completion-variables`（LAU-4 续，2026-10-30）：
 * 段式解析 / 名字段边界 / 族头白名单都是**语言事实**，位置门与候选源必须吃同一份判据，
 * 而插件的供方读不到宿主。本文件因此只剩"候选长什么样"（形状翻译）：
 * 名字来自 adapter 的表、`kind` / `sortText` / 替换区间由这一层落成 Monaco 条目。
 *
 * 两枚旧导出的名字与签名一字未改（既有 import 点与测试零改动），实现整块来自包里：
 * - `erbVariableSlotAt` —— 候选侧的面（族头 ∈ `ENGINE_VARIABLE_FAMILIES`）；
 * - `erbVariableReferenceSlotAt` —— 结构侧的面（不核白名单，成员源消费）。
 */
export { erbVariableReferenceSlotAt, erbVariableSlotAt } from '@kojo/erb-lang/completion-variables';
export type { ErbVariableSlot } from '@kojo/erb-lang/completion-variables';

/**
 * EC-2 · `.erb` 正文里的**变量族 + 具名索引补全**（只剩形状翻译）。
 *
 * 名字来源 = `VariableSchema.names(family)`；段式与名字位的判据在
 * `@kojo/erb-lang/completion-variables`（见上方搬走说明）。位置不符 / 族头不在白名单 /
 * 字典缺省 / 无 `names` ⇒ `[]`，**绝不猜、绝不抛**。
 */

/**
 * 产出 ERB 变量引用末段（索引 / 名字位）的补全候选（**纯函数**，供补全基座调用）。
 *
 * 行为：仅当光标处在形如 `族:` 或 `族:段:` 的变量引用、且**末段是索引 / 名字位置**时
 * 产出候选；族头不属 `ENGINE_VARIABLE_FAMILIES` → `[]`（不猜）。名字来自
 * `schema.names(family)`，`kind` = Variable（二段式）/ Field（三段式），`insertText` = 名字，
 * `detail` = `族:编号`，`description` 有则进 `documentation`；排序受控（**前缀精确优先**），
 * 替换范围**只覆盖最后一段**。`schema` 缺省 / 无 `names` ⇒ `[]` 且不抛。
 */
export function erbVariableCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  schema: VariableSchema | undefined,
): Monaco.languages.CompletionItem[] {
  const names = schema?.names;
  if (names === undefined) return [];
  // 名字位判据整块来自包里（与位置门 `variable-slot` 同一份；不在这里另写段解析）
  const context = erbVariableSlotAt(model.getLineContent(position.lineNumber), position.column);
  if (context === null) return [];

  const range: Monaco.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: context.start + 1,
    endColumn: context.end + 1,
  };
  // 三段式的末段是"作用域记录里的一项" ⇒ Field；二段式是族自身的索引 ⇒ Variable。
  const kind = context.scoped
    ? monaco.languages.CompletionItemKind.Field
    : monaco.languages.CompletionItemKind.Variable;

  const items: Monaco.languages.CompletionItem[] = [];
  const seen = new Set<string>();
  for (const info of names(context.family) ?? []) {
    const name = info.name;
    if (name.length === 0 || seen.has(name)) continue;
    if (context.prefix.length > 0 && !name.startsWith(context.prefix)) continue;
    seen.add(name);
    const index: number | string | undefined = info.index ?? info.resolvedIndex;
    const exact = context.prefix.length > 0 && name === context.prefix;
    items.push({
      label: name,
      kind,
      insertText: name,
      detail: index === undefined ? context.family : `${context.family}:${index}`,
      range,
      sortText: `${exact ? '0' : '1'}_${name}`,
      ...(info.description !== undefined && info.description.length > 0
        ? { documentation: info.description }
        : {}),
    });
  }
  return items;
}
