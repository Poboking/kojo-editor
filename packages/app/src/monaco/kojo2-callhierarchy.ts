/**
 * Kojo 2.0 **调用层级**（K2-LSP-CALLHIER）：同文件里 `@函` / `# 模` 的"谁调用谁"。
 *
 * ## 这一层回答什么
 *
 * - {@link kojo2PrepareCallHierarchy}：光标处是不是一个**可调用声明**？——`@函` 声明头 /
 *   名字段、`# 模` 声明头 / 名字段，以及它们的**调用位**（`! 名(…)` 调用行、表达式里的
 *   `名(…)`）都交回同一枚 item（落点是**声明**，不是调用行——调用层级树要的是被调者）；
 * - {@link kojo2IncomingCalls}：本文件里**谁调用了它**（`from` = 调用者声明，`fromRanges` =
 *   调用者体内的调用点）；
 * - {@link kojo2OutgoingCalls}：它**调用了谁**（`to` = 被调者声明，`fromRanges` = 它体内的
 *   调用点）。
 *
 * ## 事实来源（零第二份语法判据）
 *
 * - **声明 / 名字段**：`kojo2-declarations.ts` 的同一份索引（`kojo2DocumentOf`）——与悬停 /
 *   转定义 / 补全共用一把尺子，名字列不在这里重算；
 * - **块区间 / 调用语句 / 表达式**：core 的 `parseSource` AST。`range` = 声明的真 span
 *   （`# 模` / `@函` 到块体末行），`! 名(…)` 调用点的精确名字区间由**词法行**的
 *   `KojoTriggerRecord.nameOffset` 给出（AST 的 call span 是整行，本层不拿整行猜列）；
 * - **位置门**：`kojo2DefinitionAt` 是"这一格是不是引用 / 声明"的既有单一判据（`@原生` 体内、
 *   台词正文、注释都不认；`{…}` 插值内照常解析）。本层只在它之上加一道**字符串字面量**闸
 *   （`insideStringOrComment`，插值除外）：`@返 "阶乘(1)"` 里的 `阶乘` 是文本，不是调用。
 *
 * ## 调用边（`call` 的定义口径）
 *
 * 一条边 = `! 名(…)` 调用语句，或表达式里"名字紧接 `(`"的调用（允许名字与 `(` 之间有空格；
 * `名.` 属性位不算；字符串本体的文本不算，字符串**插值** `{…}` 里的表达式算）。表达式里多次
 * 调用同一名字共享**表达式 span** 作为 `fromRanges`——core 的递归分析（`scanCallNames`）同样
 * 不解析表达式语法、不编造列号，本层沿用这条口径（快照区间，不是精确名字区间）。
 *
 * `!` 行既是调用语句也可能带 `[插槽]` 体（模板调用）：体里的调用归属**调用者**（模板体是
 * 编译期展开点，不是新函数帧），本层按 AST 的原样嵌套走，不另造归属规则。
 *
 * ## 边界与不覆盖（显式）
 *
 * - **只覆盖同文件**：`@函` / `# 模` 的声明与调用都在本篇源文里。**跨文件调用**留给项目索引批：
 *   调用位认得出、但本文件没有同名声明 ⇒ `kojo2PrepareCallHierarchy` 交回 `[]`（**不是**
 *   `null`——"这是一次调用，只是本地没有落点"），这是给 wiring 的请求形状。
 * - **场景 / `@织` 体里的调用没有可调用的调用者**：Monaco 的入边要求 `from` 是一枚 item，
 *   而场景不是 `@函` / `# 模`，本层不伪造一枚"场景函数"。这类调用不进入边（与 v1
 *   `erb-call-hierarchy.ts` 的"引用点不在任何函数体内 ⇒ 跳过"同一口径）。
 * - **`# 池` 不是可调用声明**（它是台词池，不是函数）：调用池的 `! 池名` 不产生调用层级节点；
 *   本层只把 `@函` / `# 模` 当节点。
 * - **`@织` / `# 机` 的事件绑定不是调用**：不产生边。
 *
 * ## 递归 / 互递归安全
 *
 * 调用层级按 Monaco / LSP 的契约**每次只展开一层**：入边 / 出边各扫一遍本文件，不沿图继续
 * 递归（递归展开由客户端对每枚 item 再调一次，本层天然不会自己套自己）。文件内的遍历本身
 * 带三重护栏：
 * - `visited` 集（AST 节点对象身份）：同一节点最多走一次（坏 AST / 共享节点不会重复计边）；
 * - 深度上限 {@link KOJO2_CALL_HIERARCHY_DEPTH}：嵌套块再深也只走到第 64 层；
 * - 数量上限 {@link KOJO2_CALL_HIERARCHY_LIMIT}：每组调用点、返回的组数都封顶 200。
 * 自递归（`@函 阶乘` 里调自己）与互递归（甲 ↔ 乙）因此各只有一条边，不会爆栈、不会成环。
 *
 * ## 失败面
 *
 * 纯模型永不抛：空 / 坏源文 ⇒ `[]`；参数不可用（非字符串、坏行列）⇒ `null`；
 * 入边 / 出边的 `item` 认不出（没有 `data` / 本文件找不到对应声明）⇒ `null`——**`null` 是
 * "这一格不是可调用声明"，`[]` 是"是，但没有边"**，两者不混。
 *
 * ## Monaco 面（0.57 没有 CallHierarchy API）
 *
 * Monaco standalone（含 0.57.0）从未暴露 `registerCallHierarchyProvider`（取证见
 * `docs/PITFALLS.md` §83）⇒ {@link installKojo2CallHierarchyProvider} **结构性探测**该注册位：
 * 在位就按正规 provider 注册；不在位就**零注册**并交回幂等句柄。{@link createKojo2CallHierarchyProvider}
 * 单独导出，宿主自建面板（overlay / devtools）可直接复用同一份实现，不必等上游 API。
 * provider 内任何异常回空（prepare ⇒ `null`，入边 / 出边 ⇒ `[]`）：Monaco 会把 throw 吞成
 * "这个功能突然没了"，空结果才是它能读出的唯一形状。
 *
 * ## 可复现
 *
 * 同输入必同输出：声明按**源码序**（`kojo2DocumentOf` 已排序），组内调用点按（行、列）排序，
 * 同名字符串比较用码元序（不用 `localeCompare`：顺序不该随运行环境漂）。
 */
import type * as Monaco from './entry';
import {
  parseSource,
  type KojoConditionBranch,
  type KojoDecl,
  type KojoDispatchNode,
  type KojoExprText,
  type KojoFile,
  type KojoNarrativeNode,
  type KojoSpan,
  type KojoTextPart,
} from '@kojo/kojo-core';
import {
  KOJO2_DECL_WORD_BY_KIND,
  kojo2DocumentOf,
  kojo2IsCodeSurface,
  kojo2IsTextSurface,
  kojo2TokenSpanAt,
  type Kojo2Document,
} from './kojo2-declarations';
import { kojo2DefinitionAt, type Kojo2DefinitionTarget } from './kojo2-definition';
import { insideInterpolation, insideStringOrComment } from './kojo-completion-position';
import { KOJO2_LANGUAGE_ID } from './kojo2-constants';
import { isKojo2CutoverEnabled } from '../ui/kojo2-flag';

/* ============================== 公共形状 ============================== */

/** 光标位点（1 基行列；与 Monaco / core / plugin-api 同口径）。 */
export interface Kojo2CallHierarchyPosition {
  readonly line: number;
  readonly column: number;
}

/** 1 基半开区间（`endColumn` = 尾后一列；与 Monaco `IRange` 同口径）。 */
export interface Kojo2CallHierarchyRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** 本批唯一产节点的两类声明（`# 模` 也交 `kind: 'function'`，真种类在 `data` 里）。 */
export type Kojo2CallableDeclarationKind = 'function' | 'template';

/**
 * item 的 `data`（Monaco / LSP 的 item 会把它原样回传给入边 / 出边查询）。
 *
 * 全部是**可序列化的坐标事实**：本层不缓存声明对象（模型会改、源文会漂），
 * 回传时按 `(行, 名字, 真种类)` 在本篇源文里重新解析一次，认不出就 `null`。
 */
export interface Kojo2CallHierarchyData {
  readonly name: string;
  readonly declarationKind: Kojo2CallableDeclarationKind;
  /** 声明头行（1 基） */
  readonly line: number;
  /** 名字段首列（1 基） */
  readonly nameStart: number;
  /** 名字段尾后一列（1 基、半开） */
  readonly nameEnd: number;
}

/**
 * 一枚可调用声明的 item。
 *
 * `kind` 恒为 `'function'`（任务契约的形状；Monaco 的 `SymbolKind` 翻译留给 wiring 那一层）：
 * `@函` 与 `# 模` 都是"按名字调用 / 展开"的可调用体，图标差异用 `data.declarationKind` 表达，
 * 不在这里借邻居的符号种类。
 */
export interface Kojo2CallHierarchyItem {
  readonly name: string;
  readonly kind: 'function';
  /** 声明整段真 span（声明头到块体末行） */
  readonly range: Kojo2CallHierarchyRange;
  /** 名字段（客户端跳过来时选中的那一段） */
  readonly selectionRange: Kojo2CallHierarchyRange;
  readonly data: Kojo2CallHierarchyData;
}

/** 一条入边：`from` = 调用者声明，`fromRanges` = 调用者体内的调用点。 */
export interface Kojo2IncomingCall {
  readonly from: Kojo2CallHierarchyItem;
  readonly fromRanges: readonly Kojo2CallHierarchyRange[];
}

/** 一条出边：`to` = 被调者声明，`fromRanges` = **本 item** 体内的调用点（LSP 同名字段）。 */
export interface Kojo2OutgoingCall {
  readonly to: Kojo2CallHierarchyItem;
  readonly fromRanges: readonly Kojo2CallHierarchyRange[];
}

/**
 * 数量上限（每个调用者的调用点、返回的组数都封顶这一值）。
 *
 * 200 是"一屏树看得完"与"病态文件不许把主线程拖住"的折中；超出的边**静默丢弃**而不是
 * 抛错——调用层级是只读呈现面，少几条边比让功能整个哑掉好。
 */
export const KOJO2_CALL_HIERARCHY_LIMIT = 200;

/** 块嵌套深度上限（防病态 AST 把递归走法压爆栈；正常文件远达不到）。 */
export const KOJO2_CALL_HIERARCHY_DEPTH = 64;

/** 调用层级 provider 的形状（Monaco 0.57 没有对应接口；见模块头「Monaco 面」）。 */
export interface Kojo2CallHierarchyProvider {
  readonly displayName: string;
  prepareCallHierarchy(
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
  ): Kojo2CallHierarchyItem[] | null;
  provideCallHierarchyIncomingCalls(
    model: Monaco.editor.ITextModel,
    item: Kojo2CallHierarchyItem,
  ): Kojo2IncomingCall[] | null;
  provideCallHierarchyOutgoingCalls(
    model: Monaco.editor.ITextModel,
    item: Kojo2CallHierarchyItem,
  ): Kojo2OutgoingCall[] | null;
}

/* ============================== 内部形状 ============================== */

/** 一个调用点：被调名 + 源文区间。 */
interface CallSiteFact {
  readonly name: string;
  readonly range: Kojo2CallHierarchyRange;
}

/** 一个可调用声明 + 它体内的调用点（声明序）。 */
interface CallableFact {
  readonly name: string;
  readonly declarationKind: Kojo2CallableDeclarationKind;
  readonly line: number;
  readonly nameStart: number;
  readonly nameEnd: number;
  readonly span: Kojo2CallHierarchyRange;
  readonly callSites: readonly CallSiteFact[];
}

/** AST 走法状态（`seen` 是对象身份集：同一节点最多走一次）。 */
interface WalkState {
  readonly document: Kojo2Document;
  readonly sites: CallSiteFact[];
  readonly seen: Set<object>;
}

/** 表达式里"名字紧接 `(`"的保守调用判据（跳过 `"…"` 本体；字符串插值继续扫）。 */
const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_]/u;

/** flag 关 / 无注册位时交回的句柄（调用方照常 `dispose()`，什么也不会发生） */
const NOOP_DISPOSABLE: Monaco.IDisposable = { dispose: () => undefined };

/* ============================== 小工具 ============================== */

/** 1 基区间比较（行优先、列次之；码元序，不用 locale） */
function compareRanges(a: Kojo2CallHierarchyRange, b: Kojo2CallHierarchyRange): number {
  return (
    a.startLine - b.startLine ||
    a.startColumn - b.startColumn ||
    a.endLine - b.endLine ||
    a.endColumn - b.endColumn
  );
}

/** 区间键（去重用；坐标拼串不参与排序） */
function rangeKey(range: Kojo2CallHierarchyRange): string {
  return `${range.startLine}:${range.startColumn}:${range.endLine}:${range.endColumn}`;
}

/** core AST span → 1 基半开区间（恒等搬运：AST 与 Monaco 同坐标系） */
function rangeOfSpan(span: KojoSpan): Kojo2CallHierarchyRange {
  return {
    startLine: span.start.line,
    startColumn: span.start.column,
    endLine: span.end.line,
    endColumn: span.end.column,
  };
}

/** 行原文（越界 ⇒ `null`；不猜空行） */
function physicalLineOf(source: string, line: number): string | null {
  const lines = source.split(/\r\n|\r|\n/);
  return lines[line - 1] ?? null;
}

/** 位点是否可用于查询（正整数行列；NaN / 0 / 负数一律落空） */
function isUsablePosition(position: Kojo2CallHierarchyPosition | null | undefined): boolean {
  if (position === null || position === undefined) return false;
  return (
    Number.isInteger(position.line) &&
    Number.isInteger(position.column) &&
    position.line >= 1 &&
    position.column >= 1
  );
}

/* ============================== 表达式调用扫描 ============================== */
/*
 * core 的同一判据住在 `lower/expand/recursion.ts` 的 `scanCallNames`（私有），公共入口没有
 * 导出它；本文件按同一口径自持一份（跳 `"…"`、名字后可带空格接 `(`、`名.` 属性位不算、
 * 字符串插值里的表达式继续扫）。与 `kojo2-declarations.ts` 自持 `isNameChar` 同构：
 * 两处都只做"这算不算一次调用"的保守判定，不做表达式语法解析。
 */

/**
 * 扫出表达式文本里的调用名（源序、**不去重**）。
 *
 * 不返回列：表达式里多次调用同一名字共享表达式 span（core 递归分析同口径，不编造列号）。
 */
function callNamesOf(expr: KojoExprText): readonly string[] {
  const out: string[] = [];
  scanCallText(expr.text, out);
  return out;
}

function scanCallText(text: string, out: string[]): void {
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      i = scanStringBody(text, i + 1, out);
      continue;
    }
    if (!IDENT_START.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    i++;
    while (i < text.length && IDENT_PART.test(text[i]!)) i++;
    const name = text.slice(start, i);
    let prev = start - 1;
    while (prev >= 0 && (text[prev] === ' ' || text[prev] === '\t')) prev--;
    let next = i;
    while (next < text.length && (text[next] === ' ' || text[next] === '\t')) next++;
    if (text[next] === '(' && (prev < 0 || text[prev] !== '.')) out.push(name);
  }
}

/** 跳过字符串本体（从开引号之后起），`{…}` 插值里的表达式递归扫；返回闭引号之后的下标 */
function scanStringBody(text: string, from: number, out: string[]): number {
  let i = from;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        const inner = text[j]!;
        if (inner === '\\') {
          j += 2;
          continue;
        }
        if (inner === '{') depth++;
        else if (inner === '}') depth--;
        j++;
      }
      if (depth === 0) scanCallText(text.slice(i + 1, j - 1), out);
      i = j;
      continue;
    }
    i++;
  }
  return i;
}

/* ============================== 走法：把调用点收进 state ============================== */

/** 记一个调用点（数量封顶 + 同名字同区间去重）。 */
function addSite(state: WalkState, name: string, range: Kojo2CallHierarchyRange): void {
  if (name.length === 0) return;
  if (state.sites.length >= KOJO2_CALL_HIERARCHY_LIMIT) return;
  for (const site of state.sites) {
    if (site.name === name && rangeKey(site.range) === rangeKey(range)) return;
  }
  state.sites.push({ name, range });
}

/** 表达式里的调用点：区间取表达式 span（不编列号，见 `callNamesOf` 的注）。 */
function walkExpr(state: WalkState, expr: KojoExprText | null | undefined): void {
  if (expr === null || expr === undefined) return;
  for (const name of callNamesOf(expr)) addSite(state, name, rangeOfSpan(expr.span));
}

/** `! 名(…)` 调用点：名字区间优先取词法 `trigger` 行的精确偏移，缺了才退回 AST 整行 span。 */
function walkCallStatement(
  state: WalkState,
  name: string,
  span: KojoSpan,
): void {
  addSite(state, name, triggerRangeOf(state.document, name, span));
}

function triggerRangeOf(
  document: Kojo2Document,
  name: string,
  span: KojoSpan,
): Kojo2CallHierarchyRange {
  const record = document.lines[span.start.line - 1];
  if (record !== undefined && record.kind === 'trigger' && record.name === name) {
    const startColumn = record.nameOffset - record.lineOffset + 1;
    return {
      startLine: record.number,
      startColumn,
      endLine: record.number,
      endColumn: startColumn + name.length,
    };
  }
  return rangeOfSpan(span);
}

/** 文本行里的 `{…}` 插值表达式（台词 / 旁白都可能是调用点）。 */
function walkParts(state: WalkState, parts: readonly KojoTextPart[], depth: number): void {
  if (depth > KOJO2_CALL_HIERARCHY_DEPTH) return;
  for (const part of parts) {
    if (part.kind !== 'interp') continue;
    walkExpr(state, part.expr);
    if (part.cond !== undefined) {
      walkExpr(state, part.cond.cond);
      walkExpr(state, part.cond.then);
      walkExpr(state, part.cond.else);
    }
  }
}

/** 条件分支：测试表达式 + 分支体（叙事体） */
function walkBranch(state: WalkState, branch: KojoConditionBranch, depth: number): void {
  if (depth > KOJO2_CALL_HIERARCHY_DEPTH) return;
  walkExpr(state, branch.test);
  walkNarrative(state, branch.body, depth + 1);
}

/** 叙事体走法（`# 模` 体 / 场景 / 池分支 / 循环体共用）。 */
function walkNarrative(
  state: WalkState,
  nodes: readonly KojoNarrativeNode[],
  depth: number,
): void {
  if (depth > KOJO2_CALL_HIERARCHY_DEPTH) return;
  for (const node of nodes) {
    if (state.seen.has(node)) continue;
    state.seen.add(node);
    switch (node.kind) {
      case 'textLine':
        walkParts(state, node.parts, depth + 1);
        break;
      case 'blankLine':
      case 'nativeBlock':
        break;
      case 'conditionChain':
        for (const branch of node.branches) walkBranch(state, branch, depth + 1);
        break;
      case 'colorBlock':
        walkExpr(state, node.color);
        walkNarrative(state, node.body, depth + 1);
        break;
      case 'randomBlock':
        for (const candidate of node.candidates) {
          if (candidate.kind === 'randomLine') {
            if (candidate.line.kind === 'textLine') walkParts(state, candidate.line.parts, depth + 1);
          } else {
            walkNarrative(state, candidate.body, depth + 1);
          }
        }
        break;
      case 'faceLine':
        for (const arg of node.args) walkExpr(state, arg);
        break;
      case 'optionsBlock':
        for (const item of node.items) walkNarrative(state, item.body, depth + 1);
        break;
      case 'call':
        walkCallStatement(state, node.name, node.span);
        for (const arg of node.args) walkExpr(state, arg);
        if (node.body !== undefined) walkNarrative(state, node.body, depth + 1);
        break;
      case 'whileLoop':
        walkExpr(state, node.test);
        walkDispatch(state, node.body, depth + 1);
        break;
      case 'repeatLoop':
        walkExpr(state, node.count);
        walkDispatch(state, node.body, depth + 1);
        break;
      case 'forEachLoop':
        walkExpr(state, node.collection);
        walkNarrative(state, node.body, depth + 1);
        break;
      case 'sandboxBlock':
        walkDispatch(state, node.body, depth + 1);
        break;
      case 'loopJump':
      case 'label':
      case 'jump':
        break;
    }
  }
}

/** 调度体走法（`@函` 体 / `@算` 块 / 循环体共用）。 */
function walkDispatch(
  state: WalkState,
  nodes: readonly KojoDispatchNode[],
  depth: number,
): void {
  if (depth > KOJO2_CALL_HIERARCHY_DEPTH) return;
  for (const node of nodes) {
    if (state.seen.has(node)) continue;
    state.seen.add(node);
    switch (node.kind) {
      case 'assign':
        walkExpr(state, node.value);
        break;
      case 'call':
        walkCallStatement(state, node.name, node.span);
        for (const arg of node.args) walkExpr(state, arg);
        if (node.body !== undefined) walkNarrative(state, node.body, depth + 1);
        break;
      case 'exprCall':
        walkExpr(state, node.call);
        break;
      case 'return':
        walkExpr(state, node.value);
        break;
      case 'dispatchCondition':
        for (const branch of node.branches) {
          walkExpr(state, branch.test);
          walkDispatch(state, branch.body, depth + 1);
        }
        break;
      case 'whileLoop':
        walkExpr(state, node.test);
        walkDispatch(state, node.body, depth + 1);
        break;
      case 'repeatLoop':
        walkExpr(state, node.count);
        walkDispatch(state, node.body, depth + 1);
        break;
      case 'forEachLoop':
        walkExpr(state, node.collection);
        walkNarrative(state, node.body, depth + 1);
        break;
      case 'sandboxBlock':
        walkDispatch(state, node.body, depth + 1);
        break;
      case 'nativeBlock':
        break;
      case 'textLine':
        walkParts(state, node.parts, depth + 1);
        break;
      case 'blankLine':
        break;
      case 'faceLine':
        for (const arg of node.args) walkExpr(state, arg);
        break;
      case 'loopJump':
      case 'label':
      case 'jump':
        break;
    }
  }
}

/* ============================== 分析：声明 + 调用点 ============================== */

/** AST 声明 → 本层的可调用种类（其余声明一律不是节点）。 */
function callableKindOf(decl: KojoDecl): Kojo2CallableDeclarationKind | undefined {
  if (decl.kind === 'function') return 'function';
  if (decl.kind === 'template') return 'template';
  return undefined;
}

/**
 * 一篇源文 → 可调用声明（源码序）+ 各自体内的调用点。
 *
 * **纯函数**：一次 `kojo2DocumentOf`（名字段）+ 一次 `parseSource`（真 span / 调用语句 /
 * 表达式）。两次解析各取所需——名字区间不在这里重算（`kojo2-document` 是唯一尺子），
 * 块边界不按缩进猜（AST 是唯一真源）。空 / 坏输入 ⇒ `[]`，不抛。
 */
function analyzeCallables(source: string): readonly CallableFact[] {
  if (typeof source !== 'string' || source.length === 0) return [];
  let document: Kojo2Document;
  let file: KojoFile;
  try {
    document = kojo2DocumentOf(source);
    file = parseSource(source);
  } catch {
    return [];
  }
  const decls = new Map<string, KojoDecl>();
  for (const decl of file.decls) {
    if (decl.kind !== 'function' && decl.kind !== 'template') continue;
    const key = `${decl.span.start.line}\u0000${decl.name}`;
    if (!decls.has(key)) decls.set(key, decl);
  }

  const callables: CallableFact[] = [];
  const seen = new Set<string>();
  for (const declaration of document.declarations) {
    if (declaration.kind !== 'function' && declaration.kind !== 'template') continue;
    const key = `${declaration.line}\u0000${declaration.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const decl = decls.get(key);
    if (decl === undefined) continue;
    const declarationKind = callableKindOf(decl);
    if (declarationKind === undefined) continue;
    if (declarationKind !== declaration.kind) continue;
    const state: WalkState = { document, sites: [], seen: new Set() };
    if (decl.kind === 'function') walkDispatch(state, decl.body, 0);
    else if (decl.kind === 'template') walkNarrative(state, decl.body, 0);
    callables.push({
      name: declaration.name,
      declarationKind,
      line: declaration.line,
      nameStart: declaration.nameStart,
      nameEnd: declaration.nameEnd,
      span: rangeOfSpan(decl.span),
      callSites: state.sites,
    });
  }
  return callables;
}

/** 可调用事实 → item（唯一翻译点）。 */
function itemOf(fact: CallableFact): Kojo2CallHierarchyItem {
  return {
    name: fact.name,
    kind: 'function',
    range: fact.span,
    selectionRange: {
      startLine: fact.line,
      startColumn: fact.nameStart,
      endLine: fact.line,
      endColumn: fact.nameEnd,
    },
    data: {
      name: fact.name,
      declarationKind: fact.declarationKind,
      line: fact.line,
      nameStart: fact.nameStart,
      nameEnd: fact.nameEnd,
    },
  };
}

/* ============================== 纯逻辑：prepare ============================== */

/**
 * 名字段 → item（声明索引 / 定义落点两条入口共用）。
 *
 * 正常情况下 AST 声明一定在场（真 span）；只有"索引与解析错位"的病态源文才会走到兜底：
 * 那时 `range` 退成名字段本身（**不猜块边界**）。
 */
function itemForDeclaration(
  source: string,
  declarationKind: Kojo2CallableDeclarationKind,
  target: Kojo2DefinitionTarget,
): Kojo2CallHierarchyItem {
  const callables = analyzeCallables(source);
  const found = callables.find(
    (callable) =>
      callable.declarationKind === declarationKind &&
      callable.line === target.line &&
      callable.name === target.name,
  );
  if (found !== undefined) return itemOf(found);
  const selectionRange: Kojo2CallHierarchyRange = {
    startLine: target.line,
    startColumn: target.column,
    endLine: target.line,
    endColumn: target.endColumn,
  };
  return {
    name: target.name,
    kind: 'function',
    range: selectionRange,
    selectionRange,
    data: {
      name: target.name,
      declarationKind,
      line: target.line,
      nameStart: target.column,
      nameEnd: target.endColumn,
    },
  };
}

/**
 * 光标处是不是一次"调用语法"（只用于把"本地无落点"与"根本不是调用"分开）。
 *
 * 判据：`!` 触发行的被调名，或代码面 / 插值里"名字之后（可隔空白）是 `(`"。
 * 不解析调用目标——目标解析归 `kojo2DefinitionAt`（单一真源）。
 */
function isCallSyntaxAt(
  source: string,
  line: number,
  col0: number,
  lineText: string,
): boolean {
  let document: Kojo2Document;
  try {
    document = kojo2DocumentOf(source);
  } catch {
    return false;
  }
  const record = document.lines[line - 1];
  if (record === undefined) return false;
  const interpolated = insideInterpolation(lineText, col0);
  if (!kojo2IsCodeSurface(record) && !(kojo2IsTextSurface(record) && interpolated)) {
    return false;
  }
  const span = kojo2TokenSpanAt(lineText, col0);
  if (span === null) return false;
  if (record.kind === 'trigger') return span.text === record.name;
  return /^[ \t]*\(/.test(lineText.slice(span.end));
}

/**
 * 光标处的可调用声明（**纯函数**）。
 *
 * 返回：
 * - `[item]` = 声明头 / 名字段，或一次能落到**本文件** `@函` / `# 模` 的调用位；
 * - `[]` = 这是一次调用，但本文件没有同名声明（跨文件 / adapter 基础库 ⇒ 交给项目索引批）；
 * - `null` = 这一格不是 `@函` / `# 模`（变量 / 表 / 池 / 台词 / 字符串 / `@原生` / 注释），
 *   或输入不可用。
 */
export function kojo2PrepareCallHierarchy(
  source: string,
  position: Kojo2CallHierarchyPosition,
): Kojo2CallHierarchyItem[] | null {
  if (typeof source !== 'string' || !isUsablePosition(position) || source.length === 0) {
    return null;
  }
  const lineText = physicalLineOf(source, position.line);
  if (lineText === null) return null;
  const col0 = Math.min(Math.max(position.column - 1, 0), lineText.length);
  // 字符串字面量里的名字是文本，不是调用；`{…}` 插值里是表达式，照常解析。
  if (insideStringOrComment(lineText, col0) && !insideInterpolation(lineText, col0)) return null;

  const target = kojo2DefinitionAt({ source, line: position.line, column: position.column });
  if (target !== undefined) {
    if (target.kind === KOJO2_DECL_WORD_BY_KIND.function) {
      return [itemForDeclaration(source, 'function', target)];
    }
    if (target.kind === KOJO2_DECL_WORD_BY_KIND.template) {
      return [itemForDeclaration(source, 'template', target)];
    }
    return null;
  }
  return isCallSyntaxAt(source, position.line, col0, lineText) ? [] : null;
}

/* ============================== 纯逻辑：入边 / 出边 ============================== */

/**
 * item 的 `data` 校验（Monaco 会把 item 原样传回来；它可能来自旧版本 / 别的文件 / 手工构造）。
 * 认不出 ⇒ `null`（调用方回 `null`，不拿名字瞎猜）。
 */
function dataOf(item: Kojo2CallHierarchyItem | null | undefined): Kojo2CallHierarchyData | null {
  if (item === null || item === undefined || typeof item !== 'object') return null;
  const raw: unknown = (item as { data?: unknown }).data;
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const name = data.name;
  const declarationKind = data.declarationKind;
  const line = data.line;
  const nameStart = data.nameStart;
  const nameEnd = data.nameEnd;
  if (typeof name !== 'string' || name.length === 0) return null;
  if (declarationKind !== 'function' && declarationKind !== 'template') return null;
  if (!Number.isInteger(line) || (line as number) < 1) return null;
  if (!Number.isInteger(nameStart) || (nameStart as number) < 1) return null;
  if (!Number.isInteger(nameEnd) || (nameEnd as number) < (nameStart as number)) return null;
  return {
    name,
    declarationKind,
    line: line as number,
    nameStart: nameStart as number,
    nameEnd: nameEnd as number,
  };
}

/** 本篇源文里按 item 的坐标事实找回声明（**不按名字猜**：行 / 名字 / 真种类三者都要对上）。 */
interface ResolvedCallable {
  readonly callables: readonly CallableFact[];
  readonly target: CallableFact;
}

function resolveCallable(
  source: string,
  item: Kojo2CallHierarchyItem | null | undefined,
): ResolvedCallable | null {
  if (typeof source !== 'string') return null;
  const data = dataOf(item);
  if (data === null) return null;
  const callables = analyzeCallables(source);
  const target = callables.find(
    (callable) =>
      callable.declarationKind === data.declarationKind &&
      callable.line === data.line &&
      callable.name === data.name,
  );
  return target === undefined ? null : { callables, target };
}

/** 某个调用者体内对 `name` 的调用点（去重 + 源码序 + 封顶）。 */
function callRangesOf(caller: CallableFact, name: string): Kojo2CallHierarchyRange[] {
  const ranges: Kojo2CallHierarchyRange[] = [];
  const seen = new Set<string>();
  for (const site of caller.callSites) {
    if (site.name !== name) continue;
    const key = rangeKey(site.range);
    if (seen.has(key)) continue;
    seen.add(key);
    ranges.push(site.range);
    if (ranges.length >= KOJO2_CALL_HIERARCHY_LIMIT) break;
  }
  ranges.sort(compareRanges);
  return ranges;
}

/**
 * 入边：本文件里谁调用了 `item`（**含自递归**——函数调自己时 `from` 就是它本人）。
 *
 * 只认落在 `@函` / `# 模` 体内的调用（场景 / `@织` 体没有可调用的调用者，见模块头「边界」）。
 * `null` = item 认不出；`[]` = 认得出，但本文件没有入边。
 */
export function kojo2IncomingCalls(
  source: string,
  item: Kojo2CallHierarchyItem,
): Kojo2IncomingCall[] | null {
  const resolved = resolveCallable(source, item);
  if (resolved === null) return null;
  const groups: Kojo2IncomingCall[] = [];
  for (const caller of resolved.callables) {
    if (groups.length >= KOJO2_CALL_HIERARCHY_LIMIT) break;
    const fromRanges = callRangesOf(caller, resolved.target.name);
    if (fromRanges.length === 0) continue;
    groups.push({ from: itemOf(caller), fromRanges });
  }
  groups.sort(
    (a, b) =>
      a.from.selectionRange.startLine - b.from.selectionRange.startLine ||
      a.from.selectionRange.startColumn - b.from.selectionRange.startColumn,
  );
  return groups;
}

/**
 * 出边：`item` 调用了本文件里的谁。
 *
 * 只收**本文件声明的** `@函` / `# 模`：调用位指向 adapter 基础库 / 跨文件函数 / `# 池` 时
 * 一律跳过（跨文件由项目索引批补）。`null` = item 认不出；`[]` = 认得出，但没有落地的出边。
 */
export function kojo2OutgoingCalls(
  source: string,
  item: Kojo2CallHierarchyItem,
): Kojo2OutgoingCall[] | null {
  const resolved = resolveCallable(source, item);
  if (resolved === null) return null;
  const byName = new Map<string, CallableFact>();
  for (const callable of resolved.callables) {
    if (!byName.has(callable.name)) byName.set(callable.name, callable);
  }
  const groups: Kojo2OutgoingCall[] = [];
  const indexByKey = new Map<string, number>();
  for (const site of resolved.target.callSites) {
    const callee = byName.get(site.name);
    if (callee === undefined) continue;
    const key = `${callee.line}\u0000${callee.name}`;
    const existing = indexByKey.get(key);
    if (existing !== undefined) continue;
    const fromRanges = callRangesOf(resolved.target, callee.name);
    if (fromRanges.length === 0) continue;
    indexByKey.set(key, groups.length);
    groups.push({ to: itemOf(callee), fromRanges });
    if (groups.length >= KOJO2_CALL_HIERARCHY_LIMIT) break;
  }
  groups.sort(
    (a, b) =>
      a.to.selectionRange.startLine - b.to.selectionRange.startLine ||
      a.to.selectionRange.startColumn - b.to.selectionRange.startColumn,
  );
  return groups;
}

/* ============================== Monaco 面 ============================== */

/** 取整篇源文；取不到（模型已释放 / 桩 model）⇒ `null`（provider 给空结果） */
function sourceOf(model: Monaco.editor.ITextModel): string | null {
  try {
    if (typeof model.isDisposed === 'function' && model.isDisposed()) return null;
    const text = model.getValue();
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/**
 * 调用层级 provider（导出给宿主自建面板 / 未来上游 API 共用；**不依赖 Monaco 运行时**）。
 *
 * 三条腿都自带 try/catch：任何一条抛错只让**那一轮**回空（prepare ⇒ `null`，
 * 入边 / 出边 ⇒ `[]`），不把异常送进 Monaco 的吞异常通道。
 */
export function createKojo2CallHierarchyProvider(): Kojo2CallHierarchyProvider {
  return {
    displayName: 'kojo2',
    prepareCallHierarchy(model, position) {
      const source = sourceOf(model);
      if (source === null) return null;
      try {
        return kojo2PrepareCallHierarchy(source, {
          line: position.lineNumber,
          column: position.column,
        });
      } catch {
        return null;
      }
    },
    provideCallHierarchyIncomingCalls(model, item) {
      const source = sourceOf(model);
      if (source === null) return [];
      try {
        return kojo2IncomingCalls(source, item);
      } catch {
        return [];
      }
    },
    provideCallHierarchyOutgoingCalls(model, item) {
      const source = sourceOf(model);
      if (source === null) return [];
      try {
        return kojo2OutgoingCalls(source, item);
      } catch {
        return [];
      }
    },
  };
}

/**
 * `monaco.languages` 上的 CallHierarchy 注册位（**结构性探测**）：
 * 0.57 没有它（PITFALLS §83），上游将来加上就自动接上，本文件不写死版本判断。
 */
interface CallHierarchyRegistrar {
  readonly registerCallHierarchyProvider: (
    selector: string,
    provider: Kojo2CallHierarchyProvider,
  ) => Monaco.IDisposable;
}

function callHierarchyRegistrarOf(monaco: typeof Monaco): CallHierarchyRegistrar | null {
  const languages: unknown = (monaco as unknown as { languages?: unknown }).languages;
  if (languages === null || languages === undefined || typeof languages !== 'object') return null;
  const register = (languages as { registerCallHierarchyProvider?: unknown })
    .registerCallHierarchyProvider;
  if (typeof register !== 'function') return null;
  const callable = register as (
    this: unknown,
    selector: string,
    provider: Kojo2CallHierarchyProvider,
  ) => Monaco.IDisposable;
  return {
    registerCallHierarchyProvider: (selector, provider) =>
      callable.call(languages, selector, provider),
  };
}

/**
 * 为 `kojo2` 语言注册调用层级 provider，返回**幂等** disposable。
 *
 * - flag 关 ⇒ 空操作（**零注册**；本函数自身再挡一次，调用点在 CUTOVER 收口）；
 * - Monaco 0.57 没有 `registerCallHierarchyProvider`（PITFALLS §83）⇒ **零注册**并交回
 *   幂等句柄：宿主用 {@link createKojo2CallHierarchyProvider} 走自建面板，两者同一份实现；
 * - 只挂 `KOJO2_LANGUAGE_ID`（v1 `.kojo` / `.erb` 各挂各的，不重不漏）；
 * - 注册抛错原样外抛（只有一枚注册，没有半成品要回滚；宿主那侧的"全有或全无"才有东西可撤）。
 */
export function installKojo2CallHierarchyProvider(
  monaco: typeof Monaco,
): Monaco.IDisposable {
  if (!isKojo2CutoverEnabled()) return NOOP_DISPOSABLE;
  const registrar = callHierarchyRegistrarOf(monaco);
  if (registrar === null) return NOOP_DISPOSABLE;

  const registration = registrar.registerCallHierarchyProvider(
    KOJO2_LANGUAGE_ID,
    createKojo2CallHierarchyProvider(),
  );
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        registration.dispose();
      } catch {
        /* 幂等 + 不抛：一枚撤不掉不许把卸载链带崩（错误也没有第二个消费者） */
      }
    },
  };
}
