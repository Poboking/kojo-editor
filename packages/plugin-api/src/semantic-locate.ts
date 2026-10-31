/**
 * 结构化着色的**落点三件套**（B6，2026-10-16；跨插件共享的极小纯函数）。
 *
 * 为什么住契约层（与 `symbol-token.ts` 同一条理由）：ERB 线与语法糖线都要回答
 * "这个名字确实出现在那一行那一列吗"，两处各写一份 ⇒ 边界规则分叉 ⇒ 同一条名字
 * 一边有色一边没色，而这种漂移**只能靠肉眼发现**。插件之间不许交叉 import
 * （解耦审计 C 项），共享极小件的唯一合法落点就是契约层。
 *
 * 与 `symbolTokenAt` 的**有意分歧**（不是疏漏）：那张表服务"**原生**名字查表"，字符集刻意
 * 收窄到 `[A-Za-z0-9_]`（反查表的键就是 ASCII 原生名）；这里服务"作者自己起的名字"，
 * 字符集取 Unicode 字母数字下划线，因为 `.kojo` 与 eraTW 的名字大量是中文（`函数 次数` /
 * `M_KOJO_無個性`），ASCII 集会把它判成"边界合法"而错画半根。两个字符集对应两个错误代价，
 * 所以是两张表。F12-TOKEN（2026-10-19）起，**光标查表**的转到定义 / 查找引用两条腿也并入
 * 本表这一把（`erb-parser/references.ts::functionNameTokenAt` = 本表尺 + 成员冒号退让），
 * 与改名 / 引用面板 / 着色 / 悬停函数路对齐；那张 ASCII 表只剩宿主反查路还在用。
 *
 * Unicode 这一张**只在本文件写字面量**：`erb-parser/references.ts` 的反向索引记号集
 * 直接由 `MODEL_TOKEN_CLASS` 组装（"什么字符算一个记号"是一个事实，两处各写一遍
 * 就是第二判据；表现是索引认的名字着色不认，反之亦然）。
 *
 * 本文件后半部（W7 NAV-SCOPE 批追加）另持两条**跨插件共享**的判据：
 * 「行 → 归属哪一层结构」与「文件 → 是否落在只看范围内 + 候选排序桶」。放这里而不是
 * 放解析器或宿主，理由与上面同一句：消费者跨插件边界，而插件之间不许交叉 import。
 */

import { isPathUnder } from './paths';
import { splitEolLines } from './eol';

/** 记号字符集（Unicode 字母 / 数字 / 下划线）的**字面源**：单字符判定与整体分词都从它组装 */
export const MODEL_TOKEN_CLASS = String.raw`[\p{L}\p{N}_]`;

/** 标识符字符谓词（由 `MODEL_TOKEN_CLASS` 组装，别在本文件另写字符集） */
const IDENT_CHAR = new RegExp(MODEL_TOKEN_CLASS, 'u');

/**
 * 在 `text` 里从 `fromIndex`（0 基）起找 `needle`，**且要求它是一次独立的记号**
 * （左右不是标识符字符）。命中返回 1 基列；找不到返回 `-1` = 调用方**不画**。
 *
 * 为什么要独立记号校验：在 `@F(ARG, ARGS)` 里找 `ARG` 会命中 `ARGS` 的前缀，
 * 那根下划线就画在错的位置上——宁可少一条颜色，不许画错一个字符。
 */
export function locateIdentifier(text: string, needle: string, fromIndex: number): number {
  if (needle.length === 0) return -1;
  let at = text.indexOf(needle, Math.max(0, fromIndex));
  while (at >= 0) {
    const before = at === 0 ? '' : text[at - 1]!;
    const after = text[at + needle.length];
    if (!IDENT_CHAR.test(before) && (after === undefined || !IDENT_CHAR.test(after))) return at + 1;
    at = text.indexOf(needle, at + 1);
  }
  return -1;
}

/**
 * 光标列 → 所在词的 1 基半开区间（**Unicode 记号集**；`column` = Monaco 1 基列）。
 *
 * 与 `symbolTokenAt` 的分工（那张表的有意分歧见文件头）：rename / references 一族
 * 的"光标处是哪个名字"必须认中文（`函数 问候` 的 `问候` 是 ASCII 集判不出边界），
 * 故走本文件同一张 `MODEL_TOKEN_CLASS`。词判定向两侧看一格（贴着词都算在词上），
 * 与 Monaco `getWordAtPosition` 的行为一致；两侧都不是标识字符 ⇒ `null`。
 */
export function unicodeTokenAt(lineText: string, column: number): { startColumn: number; endColumn: number; text: string } | null {
  const col0 = Math.min(Math.max(0, column - 1), lineText.length);
  let start = -1;
  let end = -1;
  if (col0 < lineText.length && IDENT_CHAR.test(lineText[col0]!)) {
    start = col0;
  } else if (col0 > 0 && IDENT_CHAR.test(lineText[col0 - 1]!)) {
    start = col0 - 1;
  }
  if (start < 0) return null;
  end = start + 1;
  while (start > 0 && IDENT_CHAR.test(lineText[start - 1]!)) start--;
  while (end < lineText.length && IDENT_CHAR.test(lineText[end]!)) end++;
  return { startColumn: start + 1, endColumn: end + 1, text: lineText.slice(start, end) };
}

/** 换行归一并切成行数组（`\r\n` 与裸 `\r` 都算一行）——**实现收口在 {@link ./eol}**（R7B）：
 *  这条规则此前在仓里写着 6 份，`parseErbText` / `scanFileRefs` / 条件抽取 / 约定校验
 *  各抄一遍 ⇒ 同一条判决有六个可能的漂移点。本函数只剩"叫那个名字"这一件事。 */
export function splitModelLines(text: string): string[] {
  return splitEolLines(text);
}

/** 取 1 基行号的原文（`modelLineAt`：与 `structure-fix.ts` 那个会夹取的 `lineAt` 区分——这里越界**必须**给 undefined）；越界 → `undefined`（调用方据此**不画**，不夹取——夹取会把颜色画到别的行上） */
export function modelLineAt(lines: readonly string[], line: number): string | undefined {
  return line >= 1 && line <= lines.length ? lines[line - 1] : undefined;
}

/* ============================================================================
 * W7 NAV-SCOPE · 「行 → 归属」的**唯一**判据
 * ============================================================================ */

/**
 * 四份判据收成一处（此前：大纲取 `startLine` 最大者、调用层级取**第一个**区间包含者、
 * 跳状态取全树最紧者、面包屑每层取最小区间再下钻——同一行四个答案，没有裁决者）。
 *
 * 为什么住在契约层而不是解析器：这一条尺子的**消费者跨插件**（erb-parser 的索引、
 * 宿主的 Monaco 语言层、宿主的自绘面包屑、navigator 的树），而插件之间不许交叉
 * import（解耦审计 C 项）——与 `locateIdentifier` / `unicodeTokenAt` 完全同款的落点理由。
 *
 * 口径（逐条有测试）：
 * - **不夹取**：`line` 非有限 / `< 1` ⇒ 空结果。把过期行号静默夹到附近，等于把
 *   "位置失效"伪装成"命中旁边那个函数"，比不给答案更危险（`erb-parser/symbols.ts` 原话）；
 * - **畸形区间跳过**：端点非有限、或 `startLine > endLine`（索引缝 / 假数据）⇒ 该条**不参与**
 *   判定（当作"这一段不存在"，既不抛也不反过来当有效区间）——归属结论 = 无，不猜；
 * - **链 = 全树所有包围该行的节点**，外→内排序：区间大者在前，同宽时靠前定义在前，
 *   再同（同区间双胞胎）保持文档序第一枚。"全树"而不是"逐层下钻"是刻意的：方言侧的
 *   大纲树是**平铺**的（函数与单行声明同层并列），逐层淘汰会把外层函数判没 ⇒
 *   假答案"这一行不在任何函数里"（跳状态那批的实证）；
 * - **模式参数**而不是四份实现：面包屑/吸顶要**最内层**（`innermost`）、
 *   跳转与调用层级要**权威那一层**（同为 `innermost`），而"这一行落在哪个外层块"这类
 *   消费者要 `outermost`。差异显式写在调用点上，不各抄各的。
 */

/** 最小行区间事实（`ErbFunction` / `EditorDocumentSymbol` / 任何结构天然满足） */
export interface LineSpan {
  readonly startLine: number;
  readonly endLine: number;
}

/** 归属模式：`innermost` = 最紧的一层（默认）；`outermost` = 最外层的包围块 */
export type EnclosingMode = 'innermost' | 'outermost';

/** 可夹带子层的行区间（`EditorDocumentSymbol` 天然满足；平铺结构没有该字段） */
type SpanNode = LineSpan & { readonly children?: readonly unknown[] };

/** 行号归一（非法 ⇒ `undefined`；**不夹取**） */
function normalizeLine(line: number): number | undefined {
  if (typeof line !== 'number' || !Number.isFinite(line)) return undefined;
  const n = Math.trunc(line);
  return n < 1 ? undefined : n;
}

/** 区间是否合法并包围 `line`（畸形区间一律不包围——跳过而不是抛，也不反过来当有效区间） */
function spanCovers(span: LineSpan, line: number): boolean {
  const a = span.startLine;
  const b = span.endLine;
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a > b) return false;
  return a <= line && line <= b;
}

/** 区间宽度（闭区间端点差；同宽 = 双胞胎候选） */
function spanWidth(span: LineSpan): number {
  return span.endLine - span.startLine;
}

function collectChain(nodes: readonly unknown[], line: number, out: SpanNode[]): void {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const span = node as SpanNode;
    const covers = spanCovers(span, line);
    if (covers) out.push(span);
    // 无论父层是否包围都继续下行：索引缝里"子在外层之前"的畸形树也该给出它自己的真相，
    // 而全树下行正是跳状态那一批实测出来的**唯一不漏外层函数**的走法
    const children = span.children;
    if (Array.isArray(children)) collectChain(children, line, out);
  }
}

/**
 * 光标行 → **归属链**（外→内，1 基闭区间；无包围 ⇒ 空数组）。
 * 平铺结构与嵌套树走同一条判据（平铺结构没有 `children`，下行自然不发生）。
 */
export function enclosingChainAt<T extends LineSpan>(
  spans: readonly T[] | null | undefined,
  line: number,
): T[] {
  if (!Array.isArray(spans)) return [];
  const n = normalizeLine(line);
  if (n === undefined) return [];
  const collected: SpanNode[] = [];
  collectChain(spans, n, collected);
  const decorated = collected.map((span, i) => ({ span, i }));
  decorated.sort((a, b) => {
    const w = spanWidth(b.span) - spanWidth(a.span);
    if (w !== 0) return w;
    const s = a.span.startLine - b.span.startLine;
    if (s !== 0) return s;
    return a.i - b.i;
  });
  const chain: T[] = [];
  let prevKey = '';
  for (const item of decorated) {
    // 同区间双胞胎只留文档序第一枚（确定性；与旧面包屑口径一致）
    const key = `${item.span.startLine}\u0000${item.span.endLine}`;
    if (key === prevKey && chain.length > 0) continue;
    prevKey = key;
    chain.push(item.span as T);
  }
  return chain;
}

/**
 * 从归属链取**一层**（`innermost` = 链尾，`outermost` = 链首）。
 * 空链 / 非法输入 ⇒ `undefined`。
 */
export function pickEnclosing<T extends LineSpan>(
  chain: readonly T[] | null | undefined,
  mode: EnclosingMode = 'innermost',
): T | undefined {
  if (!Array.isArray(chain) || chain.length === 0) return undefined;
  return mode === 'outermost' ? chain[0] : chain[chain.length - 1];
}

/** 光标行 → 归属的那一层（链上按 `mode` 取一枚；默认最内层） */
export function enclosingAt<T extends LineSpan>(
  spans: readonly T[] | null | undefined,
  line: number,
  mode: EnclosingMode = 'innermost',
): T | undefined {
  return pickEnclosing(enclosingChainAt(spans, line), mode);
}

/* ============================================================================
 * W7 NAV-SCOPE · 「文件 → 范围」的**唯一**判据 + 候选排序的**唯一**口径
 * ============================================================================ */

/**
 * 路径是否落在"只看"范围内（`roots` 为空 ⇒ **全量**，见 `ErbIndex.scope` 的理由）。
 * 目录归属判据只有这一处：提供方给 `roots`（`search.scope` 槽），消费方一律经本函数判定，
 * 谁再写一份"按文件名正则猜归属"谁就是第四份判据。
 */
export function pathInScope(filePath: string, roots: readonly string[] | null | undefined): boolean {
  if (!Array.isArray(roots) || roots.length === 0) return true;
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  for (const root of roots) {
    if (typeof root !== 'string' || root.length === 0) continue;
    if (isPathUnder(root, filePath)) return true;
  }
  return false;
}

/** 按范围过滤任意候选（`pathOf` = 该候选取路径的方式；范围外的一条不剩地滤掉） */
export function filterByScope<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
  roots: readonly string[] | null | undefined,
): T[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (!Array.isArray(roots) || roots.length === 0) return [...items];
  const out: T[] = [];
  for (const item of items) {
    if (pathInScope(pathOf(item), roots)) out.push(item);
  }
  return out;
}

/**
 * 候选排序桶（小者靠前）：**名字精确 → 名字前缀 → 名字含子串 → 只有路径含子串 → 认不出**。
 *
 * 四通道（全文检索候选 / 函数树搜索 / `Ctrl+T` / `Ctrl+P`）此前各写一套比较器，
 * 同一个查询在四个面板里给出四种顺序——而"认不出的排最后不删"这条只在宿主侧有，
 * 提供方那侧靠桶序。收成一份后，两侧**同桶同序**，宿主不再重排提供方的结果。
 *
 * 大小写不敏感（两侧比较前都 `toLowerCase()`；中文名不受影响，与原生大写名同一条路）。
 * 入参一律容错（非字符串 / 空查询 ⇒ `unmatched`：空查询的排序不该把任何一条判定成命中）。
 */
export function candidateRank(name: string, filePath: string, query: string): number {
  if (typeof name !== 'string' || typeof filePath !== 'string' || typeof query !== 'string') return 4;
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 4;
  const n = name.toLowerCase();
  const p = filePath.toLowerCase();
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.includes(q)) return 2;
  if (p.includes(q)) return 3;
  return 4;
}
