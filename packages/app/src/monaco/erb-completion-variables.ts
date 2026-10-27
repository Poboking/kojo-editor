import type * as Monaco from './entry';
import type { VariableSchema } from '@kojo/plugin-api';
import { ENGINE_VARIABLE_FAMILIES } from '@kojo/kojo-vocab/engine';

/**
 * EC-2 · `.erb` 正文里的**变量族 + 具名索引补全**。
 *
 * ERB 变量引用形如 `族:名`（`CFLAG:好感度`）或 `族:作用域:名`
 * （`CFLAG:TARGET:好感度`），段间以 ASCII 冒号分隔、**末段才是索引 / 名字位**。
 * 写 `CFLAG:` 弹该族名字表；写 `CFLAG:TARGET:` 弹名字——两种段式都覆盖。
 *
 * 名字来源 = `VariableSchema.names(family)`（KC-1 交付的**可选**枚举能力）；族头白名单
 * = `kojo-sugar` 的 `ENGINE_VARIABLE_FAMILIES`（与降糖器 `resolveFamily` 同一张表），
 * 只补降糖器认得的族——否则会产出随后就报 `unknown-identifier` 的候选、或替引擎全局名
 * 乱猜。位置不符 / 族头不在白名单 / 字典缺省 / 无 `names` ⇒ `[]`，**绝不猜、绝不抛**
 * （与 `kojo-completion-variables.ts` 同纪律；但 ERB 是英文 / 数字语境，段式语法不同）。
 */

/**
 * 引用片段字符（负向口径，与 `erb-language.ts` Monarch 的变量引用词法同集：排除空白、
 * 逗号、括号、引号与运算符）。另排除 `:`（段分隔符，单独处理）与 `;`（行首注释起头）。
 */
const SEGMENT_CHAR_RE = /[^\s,()[\]{}'"+\-*/%<>=!&|^~?:;]/;

/** 一次补全的"名字段"位置（0 基区间 + 光标前已输入前缀 + 族头 + 段式）；探针导出（T6 位置门变量位消费） */
export interface ErbVariableSlot {
  /** 名字段起点（0 基，含）——替换范围左界 */
  readonly start: number;
  /** 名字段终点（0 基，不含）——替换范围右界 */
  readonly end: number;
  /** 光标前已输入的名字前缀（用于过滤 / 排序） */
  readonly prefix: string;
  /** 族头原文（调用方核对白名单） */
  readonly family: string;
  /** 三段式（`族:作用域:名`）= true；二段式（`族:名`）= false */
  readonly scoped: boolean;
}

/**
 * 解析光标处的"名字补全位置"（**纯函数**；`column` = Monaco 的 1 基列）。
 *
 * 返回 `null` = 该处不是可补全的名字位置（**不猜**：族头内 / 无冒号 / 段数超两种段式 /
 * 空作用域段 / 数字开头一律不认）。
 */
function parseVariableContext(lineText: string, column: number): ErbVariableSlot | null {
  if (!Number.isFinite(column) || column < 1) return null;
  const col0 = Math.min(column - 1, lineText.length);

  // 1) 向左扫出整个引用 token 的起点（片段字符 + 段分隔符连续段）。
  let tokStart = col0;
  while (tokStart > 0) {
    const ch = lineText[tokStart - 1]!;
    if (ch === ':' || SEGMENT_CHAR_RE.test(ch)) tokStart--;
    else break;
  }
  // 2) 向右扫出光标所在片段的终点（遇 `:` / 界符 / 行尾即止）。
  let end = col0;
  while (end < lineText.length && SEGMENT_CHAR_RE.test(lineText[end]!)) end++;

  const before = lineText.slice(tokStart, col0);
  const lastColon = before.lastIndexOf(':');
  if (lastColon < 0) return null; // 光标在族头里（`CFLAG|`）→ 不是名字位
  const parts = before.split(':');
  const family = parts[0]!;
  if (family.length === 0) return null;
  // 只认两种段式：`族:名`（1 冒号）/ `族:作用域:名`（2 冒号）；更深 → 不认（不猜）。
  if (parts.length > 3 || parts.length < 2) return null;
  if (parts.length === 3 && parts[1]!.length === 0) return null; // `族::名` 非法
  const prefix = parts[parts.length - 1]!;
  // 末段以数字开头 = 编号，不是名字位置。
  if (/^[0-9]/.test(prefix)) return null;

  return { start: tokStart + lastColon + 1, end, prefix, family, scoped: parts.length === 3 };
}

/**
 * 光标处的**变量引用末段**探针（T6 位置门 `'variable-slot'` 消费；**纯函数**，可单测）：
 * `parseVariableContext` 非空且族头 ∈ `ENGINE_VARIABLE_FAMILIES`（与补全候选同一份白名单）⇒
 * 返回槽描述；否则 `null`（不猜）。门与候选源**共用这一份判据**，不各持一套。
 */
export function erbVariableSlotAt(lineText: string, column: number): ErbVariableSlot | null {
  const context = parseVariableContext(lineText, column);
  if (context === null) return null;
  return ENGINE_VARIABLE_FAMILIES.includes(context.family) ? context : null;
}

/**
 * 结构层的**变量引用末段**探针（`erb-completion-members.ts` 的「字段位」消费；**纯函数**）。
 *
 * 与 {@link erbVariableSlotAt} 的**唯一差别**：不核对族头白名单——`CSTR:` / `EX:` 这类
 * 引擎族不在降糖白名单里，但结构上仍是 `族:名` 引用，成员源要能认出"这里是动态名字段 ⇒
 * 没静态数据就不猜"，而不是把它们当成普通行文。候选侧仍然只补白名单族
 * （{@link erbVariableCompletionItems}）；判据复用**同一个** `parseVariableContext`，
 * 不另写一份段解析（两份必然漂移）。
 */
export function erbVariableReferenceSlotAt(lineText: string, column: number): ErbVariableSlot | null {
  return parseVariableContext(lineText, column);
}

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
  const context = parseVariableContext(model.getLineContent(position.lineNumber), position.column);
  if (context === null) return [];
  if (!ENGINE_VARIABLE_FAMILIES.includes(context.family)) return [];

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
