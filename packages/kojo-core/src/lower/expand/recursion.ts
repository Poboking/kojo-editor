/**
 * `@函` 递归 / 返回路径 / 控制转移清理的**只读静态分析**
 * （K2-PROGRAM-RECURSION；设计稿 §9.5 / §9.7 / §16.4 P5.6–P5.7）。
 *
 * 定位：只产事实与诊断，**不改 AST、不发字节、不读盘、零游戏名词**；一次调用一份结果，
 * 同输入 ⇒ 输出逐字节相同（确定性）。
 *
 * 口径（保守；写死）：
 * 1. **返回种类**：同一函数 `@返` 与 `@返 表达式` 混用 → `core/func/return-mixed` error（§9.5）。
 * 2. **非 void 路径**：函数体至少有一条带值 `@返` 时，只有"直线 + `?` 链且每条分支（含 `否`）
 *    都以 `@返` 收尾"才置 `allPathsReturn: true`；其余形状（循环 / 跳转 / 原生 / 缺 `否` /
 *    部分分支返回）**一律不报错**，只把 `unprovenReturns: true` 交给 UI——证不出 ≠ 有错
 *    （避免误伤合法的循环/跳转/原生函数）。
 * 3. **互递归**：函数调用图做强连通分量（自环 / 多节点环）→ `RecursionCycleFact` 事实。
 *    递归是合法程序层能力，**不报 error**；只有能力闸（`ctx.featureGate`：adapter 声明 ×
 *    backend 落点）判定 `recursion` 关闭时才报既有 error（fail-closed，不静默降级）。
 *    调用名没在本文件声明 `@函` ⇒ 不是函数图节点（`CallSiteFact.resolved === false`），
 *    不参与环判定，也不由本模块报"未声明"——那是表达式/名字层的诊断。
 * 4. **深度**：`maxDepthHint` = 静态调用栈上界（`@函` 帧数）。自身在递归环里、或可达环
 *    ⇒ `null`（没有尾调用优化，递归深度由运行期实参决定，不猜一个假数）；其余 = 最长
 *    无环调用链（叶子 = 1）。
 * 5. **控制转移清理**：`@断`/`@续` 在循环外的 error 已由 lowering 报，本模块**不重复报**；
 *    只登记"循环跳转离开 `@着色` 块"的事实 `colorLeaks`（§9.7：离开着色必须 RESETCOLOR）。
 *    `@返`/`@跳` 的颜色收口由 lowering 负责，本批不建事实（只覆盖循环跳转）。
 */
import type {
  KojoDispatchCondition,
  KojoDispatchNode,
  KojoExprText,
  KojoFile,
  KojoFunctionDecl,
  KojoNarrativeNode,
  KojoSpan,
  KojoTextPart,
} from '../../ast.js';
import type { CoreDiagnosticCode, KojoDiagnostic } from '../../diagnostics.js';
import { severityOf } from '../../diagnostics.js';
import { comparePositions } from '../../positions.js';
import { checkFeature } from '../feature-gate.js';
import type { ExpandContext } from './context.js';

/* ============================== 1. 事实类型 ============================== */

/** 一次 `@返` 的静态事实 */
export interface ReturnPointFact {
  readonly span: KojoSpan;
  /** true = `@返 表达式`；false = 无值 `@返` */
  readonly hasValue: boolean;
}

/**
 * 一处调用事实。
 *
 * - `span` 是**调用所在语句/表达式**的源区间（表达式里多次调用同一名字共享该区间，
 *   因为本层不解析表达式语法、不编造列号）；
 * - `resolved: false` = 本文件没有同名 `@函`（adapter 基础函数 / 未知名 / 池/模板调用），
 *   只作事实展示，**不进函数图**。
 */
export interface CallSiteFact {
  readonly callee: string;
  readonly span: KojoSpan;
  readonly resolved: boolean;
}

/** 返回种类：`void`（全无值）/ `value`（全带值）/ `mixed`（混用，error） */
export type FunctionReturnKind = 'void' | 'value' | 'mixed';

/** 递归种类：`none` / 自递归 / 互递归（同一 SCC 的成员一律按互递归算） */
export type FunctionRecursionKind = 'none' | 'self' | 'mutual';

/** 一个 `@函` 的分析事实（名字 → 参数 / 返回点 / 调用点 / 返回路径 / 递归深度） */
export interface FunctionFact {
  readonly name: string;
  readonly span: KojoSpan;
  /** 形参名（声明序；默认值不在这里，参数默认值只允许字面量，§9.5） */
  readonly params: readonly string[];
  /** 全部 `@返`（源序） */
  readonly returnPoints: readonly ReturnPointFact[];
  readonly returnKind: FunctionReturnKind;
  readonly hasValueReturn: boolean;
  readonly hasBareReturn: boolean;
  /**
   * 保守证明："每个可达出口都以 `@返` 收尾"。
   * 只在"直线 + `?` 链全返（含 `否`）"时 true；有循环/跳转/原生/缺省分支 ⇒ false。
   */
  readonly allPathsReturn: boolean;
  /**
   * 给 UI 的"未证明"：函数是**非 void**（有带值 `@返` 且无无值 `@返`）但 `allPathsReturn`
   * 为 false。**不是 error**——证不出就只提示，不阻断编译。
   */
  readonly unprovenReturns: boolean;
  /** 调用点（源序；含未解析的调用事实） */
  readonly callSites: readonly CallSiteFact[];
  readonly recursionKind: FunctionRecursionKind;
  /** 静态调用栈上界（以 `@函` 帧计）；在递归环里或可达环 = `null` */
  readonly maxDepthHint: number | null;
}

/**
 * 一个递归环事实（每个强连通分量一条）。
 *
 * `cycle` 按**跳转顺序**列成员，最后一项回到第一项；单元素 = 自递归。
 * `members` 是该 SCC 的全部函数名（码元序），便于 UI 显示"这一组互相递归"。
 */
export interface RecursionCycleFact {
  readonly cycle: readonly string[];
  readonly kind: 'self' | 'mutual';
  readonly members: readonly string[];
  /** 环上第一条调用边的源区间（自递归 = 自调用点） */
  readonly span: KojoSpan;
}

/** 一个"循环跳转离开 `@着色` 块"的事实（§9.7：必须自动补 RESETCOLOR） */
export interface ColorLeakFact {
  /** 所属单元：`@函` / 场景体 / `@织` 监听体 */
  readonly unitKind: 'function' | 'scene' | 'weave';
  /** `@函` 名 / `# 幕` 标题（隐式场景 = null）/ `@织` 事件名 */
  readonly unitName: string | null;
  /** 跳转种类 */
  readonly transfer: 'break' | 'continue';
  /** `@断` / `@续` 的源区间 */
  readonly span: KojoSpan;
  /** 被离开的 `@着色` 块头区间（最近一层；着色不许嵌套，防御性取栈顶） */
  readonly colorSpan: KojoSpan;
  /** 跳转目标的最近一层循环块头区间 */
  readonly loopSpan: KojoSpan;
  /** 着色块之外套着的循环层数（≥ 1；`@断` 一次只跳最近一层） */
  readonly loopsOutsideColor: number;
}

/** 分析结果（`functions` 与 `diagnostics` 是主面，其余是 UI 事实） */
export interface RecursionAnalysis {
  /** 本文件全部 `@函`（声明序） */
  readonly functions: readonly FunctionFact[];
  /** 递归环事实（按源区间排序） */
  readonly cycles: readonly RecursionCycleFact[];
  /** 循环跳转离开着色块的事实（按源区间排序；不重复报 error） */
  readonly colorLeaks: readonly ColorLeakFact[];
  /** 本模块产生的诊断（按源区间排序；可并入调用方的 sink） */
  readonly diagnostics: readonly KojoDiagnostic[];
  /** 本次分析看到的能力闸结论（`checkFeature(ctx.featureGate, 'recursion').enabled`；false = 未开启/冲突折叠） */
  readonly recursionEnabled: boolean;
}

/* ============================== 2. 诊断码 ============================== */

/** 返回混用：码表既有 error（§11.3） */
const RETURN_MIXED_CODE: CoreDiagnosticCode = 'core/func/return-mixed';

/*
 * 递归能力闸**不在这里定码**：统一走 `lower/feature-gate.ts` 的 `checkFeature`
 * （K2-FEATURE-GATE-UNIFY 的单源：adapter 声明 × backend 落点，冲突只由编译入口报一次）。
 * 因此本模块报出的码 = `PROGRAM_FEATURE_CODES.recursion` = 既有 `core/func/recursion-unsupported`；
 * 本批任务书写的 `core/control/unsupported` 是 `@循`/`@复`/`@巡` 那几格的同族码，
 * 不另建第二套判定（否则又回到"两个真源"）。
 */

/* ============================== 3. 扫描状态 ============================== */

type UnitKind = ColorLeakFact['unitKind'];

interface UnitScope {
  readonly kind: UnitKind;
  readonly name: string | null;
}

/** 一层循环：进入时已打开的着色块层数（判定"跳转是否离开着色块"） */
interface LoopFrame {
  readonly span: KojoSpan;
  readonly colorDepth: number;
}

/** 一层 `@着色`（着色不许嵌套；仍用栈，防御坏 AST） */
interface ColorFrame {
  readonly span: KojoSpan;
}

interface ScanState {
  readonly declared: ReadonlySet<string>;
  readonly scope: UnitScope;
  readonly loopStack: LoopFrame[];
  readonly colorStack: ColorFrame[];
  /** `@随机` 候选嵌套层数：候选里的控制转移由 parser 报 `core/random/bare-control`，不建事实 */
  isolated: number;
  readonly returns: ReturnPointFact[];
  readonly calls: CallSiteFact[];
  readonly leaks: ColorLeakFact[];
}

function createScanState(declared: ReadonlySet<string>, scope: UnitScope): ScanState {
  return {
    declared,
    scope,
    loopStack: [],
    colorStack: [],
    isolated: 0,
    returns: [],
    calls: [],
    leaks: [],
  };
}

/* ============================== 4. 表达式里的调用扫描 ============================== */

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_]/u;

/**
 * 扫出表达式文本里的**调用名**（`名字 (` 形态，允许名字与 `(` 之间有空格）。
 *
 * 词法口径与 `./expr.ts` 的 `scanIdentifiers` 一致：跳过 `"…"` 字符串本体，`\` 转义；
 * 字符串插值 `{…}` 里的表达式**继续扫**（`"共{阶乘(n)}次"` 也是一次真实调用）。
 * 属性位 `名.` 之后的调用不算（`a.b(` 是属性访问，不是文件函数）。
 * 本层不解析表达式语法：认不出的形态宁可不记，也不猜。
 */
function scanCallNames(text: string): readonly string[] {
  const out: string[] = [];
  scanCallText(text, out);
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
    let j = i;
    while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
    if (text[j] === '(' && (prev < 0 || text[prev] !== '.')) out.push(name);
  }
}

/** 跳过字符串本体（从开引号之后开始），插值里的表达式递归扫描；返回闭引号之后的下标 */
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

function scanExpr(state: ScanState, expr: KojoExprText): void {
  for (const callee of scanCallNames(expr.text)) {
    state.calls.push({ callee, span: expr.span, resolved: state.declared.has(callee) });
  }
}

function scanParts(state: ScanState, parts: readonly KojoTextPart[]): void {
  for (const part of parts) {
    if (part.kind === 'text') continue;
    scanExpr(state, part.expr);
    if (part.cond !== undefined) {
      scanExpr(state, part.cond.cond);
      scanExpr(state, part.cond.then);
      scanExpr(state, part.cond.else);
    }
  }
}

/* ============================== 5. 体走法（返回点 / 调用点 / 泄漏事实） ============================== */

function walkDispatch(state: ScanState, nodes: readonly KojoDispatchNode[]): void {
  for (const node of nodes) walkDispatchNode(state, node);
}

function walkDispatchNode(state: ScanState, node: KojoDispatchNode): void {
  switch (node.kind) {
    case 'assign':
      scanExpr(state, node.value);
      return;
    case 'call':
      state.calls.push({ callee: node.name, span: node.span, resolved: state.declared.has(node.name) });
      for (const arg of node.args) scanExpr(state, arg);
      if (node.body !== undefined) walkNarrative(state, node.body);
      return;
    case 'exprCall':
      // 整段裸表达式：调用名由扫描器给，源区间取整句
      scanExpr(state, node.call);
      return;
    case 'loopJump':
      recordLoopJump(state, node);
      return;
    case 'return':
      state.returns.push({ span: node.span, hasValue: node.value !== undefined });
      if (node.value !== undefined) scanExpr(state, node.value);
      return;
    case 'label':
    case 'jump':
      // `@标`/`@跳` 的颜色收口由 lowering 负责；本批不建事实
      return;
    case 'dispatchCondition':
      for (const branch of node.branches) {
        if (branch.test !== null) scanExpr(state, branch.test);
        walkDispatch(state, branch.body);
      }
      return;
    case 'whileLoop':
      scanExpr(state, node.test);
      pushLoop(state, node.span);
      walkDispatch(state, node.body);
      popLoop(state);
      return;
    case 'repeatLoop':
      scanExpr(state, node.count);
      pushLoop(state, node.span);
      walkDispatch(state, node.body);
      popLoop(state);
      return;
    case 'forEachLoop':
      scanExpr(state, node.collection);
      pushLoop(state, node.span);
      walkNarrative(state, node.body);
      popLoop(state);
      return;
    case 'sandboxBlock':
      walkDispatch(state, node.body);
      return;
    case 'nativeBlock':
      // `@原生` 是不透明文本：不解析、不假设（控制转移由作者负责，§9.7）
      return;
    case 'textLine':
      scanParts(state, node.parts);
      return;
    case 'blankLine':
      return;
    case 'faceLine':
      for (const arg of node.args) scanExpr(state, arg);
      return;
  }
}

function walkNarrative(state: ScanState, nodes: readonly KojoNarrativeNode[]): void {
  for (const node of nodes) walkNarrativeNode(state, node);
}

function walkNarrativeNode(state: ScanState, node: KojoNarrativeNode): void {
  switch (node.kind) {
    case 'textLine':
      scanParts(state, node.parts);
      return;
    case 'blankLine':
      return;
    case 'conditionChain':
      for (const branch of node.branches) {
        if (branch.test !== null) scanExpr(state, branch.test);
        walkNarrative(state, branch.body);
      }
      return;
    case 'colorBlock':
      scanExpr(state, node.color);
      state.colorStack.push({ span: node.span });
      walkNarrative(state, node.body);
      state.colorStack.pop();
      return;
    case 'randomBlock':
      // 候选里的控制转移由 parser 报 `core/random/bare-control`：这里只走调用点，不建泄漏事实
      state.isolated++;
      try {
        for (const candidate of node.candidates) {
          if (candidate.kind === 'randomGroup') walkNarrative(state, candidate.body);
          else walkNarrative(state, [candidate.line]);
        }
      } finally {
        state.isolated--;
      }
      return;
    case 'nativeBlock':
      return;
    case 'sandboxBlock':
      walkDispatch(state, node.body);
      return;
    case 'faceLine':
      for (const arg of node.args) scanExpr(state, arg);
      return;
    case 'optionsBlock':
      for (const item of node.items) walkNarrative(state, item.body);
      return;
    case 'call':
      state.calls.push({ callee: node.name, span: node.span, resolved: state.declared.has(node.name) });
      for (const arg of node.args) scanExpr(state, arg);
      if (node.body !== undefined) walkNarrative(state, node.body);
      return;
    case 'whileLoop':
      scanExpr(state, node.test);
      pushLoop(state, node.span);
      walkDispatch(state, node.body);
      popLoop(state);
      return;
    case 'repeatLoop':
      scanExpr(state, node.count);
      pushLoop(state, node.span);
      walkDispatch(state, node.body);
      popLoop(state);
      return;
    case 'forEachLoop':
      scanExpr(state, node.collection);
      pushLoop(state, node.span);
      walkNarrative(state, node.body);
      popLoop(state);
      return;
    case 'loopJump':
      recordLoopJump(state, node);
      return;
    case 'label':
    case 'jump':
      return;
  }
}

function pushLoop(state: ScanState, span: KojoSpan): void {
  state.loopStack.push({ span, colorDepth: state.colorStack.length });
}

function popLoop(state: ScanState): void {
  state.loopStack.pop();
}

/**
 * `@断`/`@续` 的清理事实：只有"跳转目标循环在着色块之外"才算离开着色块。
 *
 * - 循环外的跳转（`loopStack` 空）是 lowering 的既有 error，这里**不重复报**、也不建事实；
 * - 循环在着色块内（`loop.colorDepth === colorStack.length`）⇒ 跳转不离开着色，不建事实；
 * - `@随机` 候选里的控制转移是 parser 的 error，不建事实。
 */
function recordLoopJump(state: ScanState, node: { readonly kind: 'loopJump'; readonly mode: 'break' | 'continue'; readonly span: KojoSpan }): void {
  if (state.isolated > 0) return;
  const loop = state.loopStack[state.loopStack.length - 1];
  if (loop === undefined) return;
  const color = state.colorStack[state.colorStack.length - 1];
  if (color === undefined || state.colorStack.length <= loop.colorDepth) return;
  let loopsOutsideColor = 0;
  for (const frame of state.loopStack) {
    if (frame.colorDepth < state.colorStack.length) loopsOutsideColor++;
  }
  state.leaks.push({
    unitKind: state.scope.kind,
    unitName: state.scope.name,
    transfer: node.mode,
    span: node.span,
    colorSpan: color.span,
    loopSpan: loop.span,
    loopsOutsideColor,
  });
}

/* ============================== 6. 返回路径（保守证明） ============================== */

/**
 * "每个可达出口都以 `@返` 收尾"的保守证明。
 *
 * 只认**直线 + `?` 链**：遇到循环 / `@跳` / `@标` / `@断` / `@续` / `@原生` 立刻判**不可证**
 * （false）——这些形状里"跳出去"的路径无法在不开控制流图的前提下证明。`@算` 只是视觉分组，
 * 递归进去；`?` 链必须**带 `否`**且每条分支都全返才算覆盖全部出口。
 */
function bodyAlwaysReturns(nodes: readonly KojoDispatchNode[]): boolean {
  for (const node of nodes) {
    switch (node.kind) {
      case 'return':
        return true;
      case 'dispatchCondition':
        if (conditionAlwaysReturns(node)) return true;
        continue;
      case 'sandboxBlock':
        if (bodyAlwaysReturns(node.body)) return true;
        continue;
      case 'jump':
      case 'label':
      case 'loopJump':
      case 'nativeBlock':
      case 'whileLoop':
      case 'repeatLoop':
      case 'forEachLoop':
        return false;
      case 'assign':
      case 'call':
      case 'exprCall':
      case 'textLine':
      case 'blankLine':
      case 'faceLine':
        continue;
    }
  }
  return false;
}

function conditionAlwaysReturns(node: KojoDispatchCondition): boolean {
  let hasDefault = false;
  for (const branch of node.branches) {
    if (branch.test === null) hasDefault = true;
    if (!bodyAlwaysReturns(branch.body)) return false;
  }
  return hasDefault;
}

/* ============================== 7. 函数图：SCC / 环 / 深度 ============================== */

interface GraphNodeFact {
  readonly recursionKind: FunctionRecursionKind;
  readonly maxDepthHint: number | null;
}

interface GraphResult {
  readonly byName: ReadonlyMap<string, GraphNodeFact>;
  readonly cycles: readonly RecursionCycleFact[];
}

interface EdgeSpanIndex {
  readonly get: (caller: string, callee: string) => KojoSpan | null;
  readonly set: (caller: string, callee: string, span: KojoSpan) => void;
}

function createEdgeSpanIndex(): EdgeSpanIndex {
  const byCaller = new Map<string, Map<string, KojoSpan>>();
  return {
    get(caller, callee) {
      return byCaller.get(caller)?.get(callee) ?? null;
    },
    set(caller, callee, span) {
      let edges = byCaller.get(caller);
      if (edges === undefined) {
        edges = new Map();
        byCaller.set(caller, edges);
      }
      if (!edges.has(callee)) edges.set(callee, span);
    },
  };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareSpans(a: KojoSpan, b: KojoSpan): number {
  return comparePositions(a.start, b.start) || comparePositions(a.end, b.end);
}

/**
 * 建函数图并算 SCC / 环 / 深度上界。
 *
 * 只收"本文件声明了同名 `@函`"的边（声明提升：调用可以出现在声明之前）。
 * 同名重复声明（parser 已报重名）共用同一个图节点（边合并，不重复建节点）。
 */
function buildGraph(declarations: readonly KojoFunctionDecl[], scans: readonly ScanState[]): GraphResult {
  const names: string[] = [];
  const seen = new Set<string>();
  const adjacency = new Map<string, string[]>();
  const edgeSpans = createEdgeSpanIndex();
  const declSpans = new Map<string, KojoSpan>();

  for (let i = 0; i < declarations.length; i++) {
    const decl = declarations[i]!;
    if (seen.has(decl.name)) continue;
    seen.add(decl.name);
    names.push(decl.name);
    adjacency.set(decl.name, []);
    declSpans.set(decl.name, decl.span);
  }
  for (let i = 0; i < declarations.length; i++) {
    const decl = declarations[i]!;
    const callees = adjacency.get(decl.name);
    if (callees === undefined) continue;
    for (const site of scans[i]!.calls) {
      if (!site.resolved) continue;
      if (!adjacency.has(site.callee)) continue;
      edgeSpans.set(decl.name, site.callee, site.span);
      if (!callees.includes(site.callee)) callees.push(site.callee);
    }
  }
  for (const callees of adjacency.values()) callees.sort(compareText);

  const sortedNames = [...names].sort(compareText);
  const scc = stronglyConnectedComponents(sortedNames, adjacency);
  const cyclic = new Set<string>();
  const cycles: RecursionCycleFact[] = [];
  for (const group of scc.groups) {
    if (!isCyclicGroup(group, adjacency)) continue;
    for (const member of group) cyclic.add(member);
    const canonical = canonicalCycle(group, adjacency, edgeSpans, declSpans);
    cycles.push(canonical);
  }
  cycles.sort((a, b) => compareSpans(a.span, b.span) || compareText(a.cycle.join('\u0000'), b.cycle.join('\u0000')));

  const depths = computeDepthHints(sortedNames, adjacency, cyclic);
  const byName = new Map<string, GraphNodeFact>();
  for (const name of sortedNames) {
    const groupId = scc.groupOf.get(name);
    const group = groupId === undefined ? [name] : scc.groups[groupId]!;
    const kind: FunctionRecursionKind = !cyclic.has(name) ? 'none' : group.length > 1 ? 'mutual' : 'self';
    byName.set(name, { recursionKind: kind, maxDepthHint: depths.get(name) ?? null });
  }
  return { byName, cycles };
}

interface SccResult {
  readonly groupOf: ReadonlyMap<string, number>;
  readonly groups: readonly (readonly string[])[];
}

/** 迭代版 Tarjan（避免大文件下递归爆栈；相邻名字已按码元序排好 ⇒ 结果确定） */
function stronglyConnectedComponents(names: readonly string[], adjacency: ReadonlyMap<string, readonly string[]>): SccResult {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groupOf = new Map<string, number>();
  const groups: string[][] = [];
  let nextIndex = 0;

  for (const root of names) {
    if (index.has(root)) continue;
    index.set(root, nextIndex);
    low.set(root, nextIndex);
    nextIndex++;
    stack.push(root);
    onStack.add(root);

    const frames: { readonly name: string; next: number }[] = [{ name: root, next: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const callees = adjacency.get(frame.name) ?? [];
      if (frame.next < callees.length) {
        const callee = callees[frame.next]!;
        frame.next++;
        if (!index.has(callee)) {
          index.set(callee, nextIndex);
          low.set(callee, nextIndex);
          nextIndex++;
          stack.push(callee);
          onStack.add(callee);
          frames.push({ name: callee, next: 0 });
        } else if (onStack.has(callee)) {
          const candidate = index.get(callee)!;
          if (candidate < low.get(frame.name)!) low.set(frame.name, candidate);
        }
        continue;
      }
      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1]!.name;
        const candidate = low.get(frame.name)!;
        if (candidate < low.get(parent)!) low.set(parent, candidate);
      }
      if (low.get(frame.name) === index.get(frame.name)) {
        const group: string[] = [];
        while (stack.length > 0) {
          const popped = stack.pop()!;
          onStack.delete(popped);
          group.push(popped);
          if (popped === frame.name) break;
        }
        const groupId = groups.length;
        groups.push(group);
        for (const member of group) groupOf.set(member, groupId);
      }
    }
  }
  return { groupOf, groups };
}

function isCyclicGroup(group: readonly string[], adjacency: ReadonlyMap<string, readonly string[]>): boolean {
  if (group.length > 1) return true;
  const only = group[0]!;
  return (adjacency.get(only) ?? []).includes(only);
}

/**
 * 每个 SCC 取一条**确定的**简单环：多节点 SCC 从码元序最小的成员出发，BFS 找最近一条
 * 回到起点的边（`p → start`），环 = 起点到 `p` 的最短路径（边按码元序展开）。
 * 单节点 SCC 只可能是自环。
 */
function canonicalCycle(
  group: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  edgeSpans: EdgeSpanIndex,
  declSpans: ReadonlyMap<string, KojoSpan>,
): RecursionCycleFact {
  const members = [...group].sort(compareText);
  const start = members[0]!;
  const declSpan = declSpans.get(start) ?? { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };
  if (members.length === 1) {
    const span = edgeSpans.get(start, start);
    return { cycle: [start], kind: 'self', members, span: span ?? declSpan };
  }

  const inGroup = new Set(members);
  const parents = new Map<string, string>();
  parents.set(start, start);
  const queue: string[] = [start];
  let head = 0;
  let predecessor: string | null = null;
  while (head < queue.length && predecessor === null) {
    const node = queue[head]!;
    head++;
    for (const callee of adjacency.get(node) ?? []) {
      if (!inGroup.has(callee)) continue;
      if (callee === start) {
        if (node !== start) {
          predecessor = node;
          break;
        }
        continue;
      }
      if (parents.has(callee)) continue;
      parents.set(callee, node);
      queue.push(callee);
    }
  }

  const path: string[] = [];
  if (predecessor === null) {
    // 理论不可达（多节点 SCC 必有回到起点的路径）；保守回退：按码元序给出成员集合
    for (const member of members) path.push(member);
  } else {
    let cursor: string = predecessor;
    for (;;) {
      path.push(cursor);
      if (cursor === start) break;
      const parent = parents.get(cursor);
      if (parent === undefined) break;
      cursor = parent;
    }
    path.reverse();
  }
  const firstEdge = path.length > 1 ? edgeSpans.get(path[0]!, path[1]!) : null;
  const fallback = path.length > 0 ? edgeSpans.get(path[0]!, path[0]!) : null;
  return {
    cycle: path,
    kind: 'mutual',
    members,
    span: firstEdge ?? fallback ?? declSpan,
  };
}

/**
 * 静态调用栈上界（`@函` 帧数）：非环节点上 = 1 + 最长被调链；自身在环里或可达环 = null。
 *
 * 迭代 DFS（后序求值），不递归——万级函数也不爆栈。环只在 SCC 内部（已标 `cyclic`），
 * 遇到 `visiting` 只是防御性兜底（不静默给数）。
 */
function computeDepthHints(
  names: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  cyclic: ReadonlySet<string>,
): ReadonlyMap<string, number | null> {
  const depth = new Map<string, number | null>();
  const status = new Map<string, 'visiting' | 'done'>();
  const empty: readonly string[] = [];

  for (const root of names) {
    if (status.get(root) === 'done') continue;
    status.set(root, 'visiting');
    const frames: { readonly name: string; next: number }[] = [{ name: root, next: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const callees = adjacency.get(frame.name) ?? empty;
      if (frame.next < callees.length) {
        const callee = callees[frame.next]!;
        frame.next++;
        const calleeStatus = status.get(callee);
        if (calleeStatus === 'done') continue;
        if (calleeStatus === 'visiting') {
          depth.set(callee, null);
          continue;
        }
        status.set(callee, 'visiting');
        frames.push({ name: callee, next: 0 });
        continue;
      }
      frames.pop();
      status.set(frame.name, 'done');
      let value = 1;
      let unbounded = cyclic.has(frame.name);
      for (const callee of callees) {
        const calleeDepth = depth.get(callee);
        if (calleeDepth === undefined || calleeDepth === null) {
          unbounded = true;
          break;
        }
        if (calleeDepth + 1 > value) value = calleeDepth + 1;
      }
      depth.set(frame.name, unbounded ? null : value);
    }
  }
  return depth;
}

/* ============================== 8. 主入口 ============================== */

/**
 * 单文件全部 `@函` 的递归 / 返回 / 清理分析（纯函数；不改 AST、不写 sink）。
 *
 * 契约：
 * - `file` 是 `parseSource` 的产物（声明提升：函数体里可以调用后面才声明的 `@函`）；
 * - `ctx` 只用于**能力闸**（`ctx.featureGate`）与事实来源；本模块不读 `ctx.functions`，
 *   所以调用方不必先 `indexDeclarations`（少一个接线顺序陷阱）；
 * - 诊断只**返回**、不自己写 `ctx.sink`——调用方决定并入哪个 sink（与 `analyzeProject`
 *   同一纪律：先收事实，再统一排序/去重）。
 */
export function analyzeFunctions(file: KojoFile, ctx: ExpandContext): RecursionAnalysis {
  const declarations = file.decls.filter((decl): decl is KojoFunctionDecl => decl.kind === 'function');
  const declared = new Set<string>();
  for (const decl of declarations) declared.add(decl.name);

  // 1) 每个 `@函` 体：返回点 / 调用点 / 着色泄漏事实
  const scans: ScanState[] = [];
  for (const decl of declarations) {
    const state = createScanState(declared, { kind: 'function', name: decl.name });
    walkDispatch(state, decl.body);
    scans.push(state);
  }

  // 2) 场景体 / `@织` 监听体：只收着色泄漏事实（场景里的 `@返` 由 parser 报 return-outside）
  const colorLeaks: ColorLeakFact[] = [];
  for (const scan of scans) colorLeaks.push(...scan.leaks);
  for (const scene of file.scenes) {
    const state = createScanState(declared, { kind: 'scene', name: scene.title });
    walkNarrative(state, scene.items);
    colorLeaks.push(...state.leaks);
  }
  for (const decl of file.decls) {
    if (decl.kind !== 'weave') continue;
    const state = createScanState(declared, { kind: 'weave', name: decl.event });
    walkNarrative(state, decl.body);
    colorLeaks.push(...state.leaks);
  }
  colorLeaks.sort((a, b) => compareSpans(a.span, b.span) || compareText(a.unitKind, b.unitKind));

  // 3) 函数图：SCC（自递归/互递归）与深度上界
  const graph = buildGraph(declarations, scans);

  // 4) 事实：函数
  const functions: FunctionFact[] = declarations.map((decl, index) => {
    const scan = scans[index]!;
    const firstValue = scan.returns.find((point) => point.hasValue);
    const firstBare = scan.returns.find((point) => !point.hasValue);
    const hasValueReturn = firstValue !== undefined;
    const hasBareReturn = firstBare !== undefined;
    const returnKind: FunctionReturnKind =
      hasValueReturn && hasBareReturn ? 'mixed' : hasValueReturn ? 'value' : 'void';
    const allPathsReturn = bodyAlwaysReturns(decl.body);
    const unprovenReturns = hasValueReturn && !hasBareReturn && !allPathsReturn;
    const node = graph.byName.get(decl.name);
    return {
      name: decl.name,
      span: decl.span,
      params: decl.params.map((param) => param.name),
      returnPoints: scan.returns,
      returnKind,
      hasValueReturn,
      hasBareReturn,
      allPathsReturn,
      unprovenReturns,
      callSites: scan.calls,
      recursionKind: node?.recursionKind ?? 'none',
      maxDepthHint: node?.maxDepthHint ?? null,
    };
  });

  // 5) 诊断：返回混用（error）+ 递归能力闸（feature 关闭才报；冲突由编译入口报一次）
  //
  // 闸值也**只经统一入口**取（与 `walk.ts::programFeatureEnabled` 同一条纪律）：不再自己
  // 读 `featureGate.features.recursion`——`enabled` 决定发不发事实/报不报，`diagnostic`
  // 决定报哪条；冲突键的 `diagnostic` 恒为 null ⇒ 本模块不重复喊"未开启"。
  const recursionEnabled = checkFeature(ctx.featureGate, 'recursion').enabled;
  const diagnostics: KojoDiagnostic[] = [];
  for (let index = 0; index < declarations.length; index++) {
    const decl = declarations[index]!;
    const scan = scans[index]!;
    const firstValue = scan.returns.find((point) => point.hasValue);
    const firstBare = scan.returns.find((point) => !point.hasValue);
    if (firstValue === undefined || firstBare === undefined) continue;
    const later =
      comparePositions(firstValue.span.start, firstBare.span.start) <= 0 ? firstBare : firstValue;
    diagnostics.push({
      code: RETURN_MIXED_CODE,
      severity: severityOf(RETURN_MIXED_CODE),
      message:
        `函数「${decl.name}」的 \`@返\` 混用：第 ${firstValue.span.start.line} 行是带值 \`@返 表达式\`，` +
        `第 ${firstBare.span.start.line} 行是无值 \`@返\`——同一函数必须全部有值或全部无值（§9.5）。`,
      span: later.span,
    });
  }
  if (!recursionEnabled) {
    for (const cycle of graph.cycles) {
      // 冲突键的 diagnostic 恒为 null（编译入口已报），这里不重复喊"未开启"
      const gate = checkFeature(ctx.featureGate, 'recursion', cycle.span);
      if (!gate.enabled && gate.diagnostic !== null) diagnostics.push(gate.diagnostic);
    }
  }
  diagnostics.sort(
    (a, b) =>
      compareNullableSpan(a.span, b.span) ||
      compareText(String(a.code), String(b.code)) ||
      compareText(a.message, b.message),
  );

  return {
    functions,
    cycles: graph.cycles,
    colorLeaks,
    diagnostics,
    recursionEnabled,
  };
}

function compareNullableSpan(a: KojoSpan | null, b: KojoSpan | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareSpans(a, b);
}
