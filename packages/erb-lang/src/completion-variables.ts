/**
 * ERB 变量引用**名字位**的判据（`@kojo/erb-lang/completion-variables`）。
 *
 * ## 这一格回答什么
 *
 * 光标是不是停在一条变量引用的**末段**（索引 / 名字位）上：`族:` / `族:好` /
 * `族:作用域:` / `族:作用域:好` 四种形态。答"是"时交回名字段区间与已输入前缀，
 * 由消费方决定弹什么（候选装配仍在宿主，表来自 adapter）。
 *
 * ## 为什么它在语言面库
 *
 * "`族:作用域:名` 有几段、哪一段才算名字、数字开头算不算名字"是 **ERB 的引用语法**，
 * 与哪一部游戏无关；位置门（`variable-slot` 态）与候选源必须吃同一份判据——此前这两处
 * 共用一个私有函数，本叶子把它显式化成对外面。
 *
 * ## 两种面（口径差一枚：族头白名单）
 *
 * - {@link erbVariableSlotAt}：**候选侧**的面——族头还须 ∈ `ENGINE_VARIABLE_FAMILIES`
 *   （降糖器认得的族；否则会产出随即报 `unknown-identifier` 的候选）；
 * - {@link erbVariableReferenceSlotAt}：**结构侧**的面——不核白名单。`CSTR:` / `EX:` 这类
 *   引擎族不在降糖白名单里，但结构上仍是 `族:名` 引用（成员源要能认出"这里是动态名字段"，
 *   而不是当普通行文）。
 *
 * 两枚共用**同一个**段解析，不另写第二份（两份必然漂移）。
 */
import { ENGINE_VARIABLE_FAMILIES } from '@kojo/kojo-vocab/engine';

/**
 * 引用片段字符（负向口径，与宿主 Monarch 的变量引用词法同集：排除空白、逗号、括号、
 * 引号与运算符）。另排除 `:`（段分隔符，单独处理）与 `;`（行首注释起头）。
 */
const SEGMENT_CHAR_RE = /[^\s,()[\]{}'"+\-*/%<>=!&|^~?:;]/;

/** 一次补全的"名字段"位置（0 基区间 + 光标前已输入前缀 + 族头 + 段式） */
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
export function erbVariableContextAt(lineText: string, column: number): ErbVariableSlot | null {
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
  if (lastColon < 0) return null; // 光标在族头里（`族|`）→ 不是名字位
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
 * 光标处的**变量引用末段**（候选侧的面；`column` = Monaco 的 1 基列）：
 * 段解析非空且族头 ∈ `ENGINE_VARIABLE_FAMILIES` ⇒ 返回槽描述；否则 `null`（不猜）。
 * 位置门（`variable-slot`）与候选源**共用这一份判据**，不各持一套。
 */
export function erbVariableSlotAt(lineText: string, column: number): ErbVariableSlot | null {
  const context = erbVariableContextAt(lineText, column);
  if (context === null) return null;
  return ENGINE_VARIABLE_FAMILIES.includes(context.family) ? context : null;
}

/**
 * 结构层的**变量引用末段**（结构侧的面；`column` = Monaco 的 1 基列）：
 * 与 {@link erbVariableSlotAt} 的唯一差别是不核族头白名单（见模块头注）。
 */
export function erbVariableReferenceSlotAt(lineText: string, column: number): ErbVariableSlot | null {
  return erbVariableContextAt(lineText, column);
}