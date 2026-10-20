/**
 * 导航历史（MM-6 前进/后退 + MM-10 恢复关闭的标签）：编辑器「肌肉记忆」的**纯逻辑**。
 *
 * 零 React、零 Monaco、零内核——与 `editor-groups.ts` 同族：给一份旧态 + 一个意图
 * ⇒ 返回一份新态。App（`ui/App.tsx`）是唯一的状态所有者（持 `navRef`，回调经纯函数
 * 读写），本模块的每条规则由 `navigation-history.test.ts` 钉死。
 *
 * 两块栈，一条产品语义：
 * - **导航栈**（MM-6）：`{ path, line, column?, endColumn? }` 条目的时间线 + `cursor`
 *   光标。back = 光标前移，forward = 光标后移，push = 截断「前进」分支后压栈（VSCode
 *   语义：跳到新位置后，前进历史作废）。同 path 同 line 不重复入栈（已在时间线里的
 *   位置 = 把光标挪回去，栈不涨；**列不参与判重**——同一条行上的不同列算同一个位置，
 *   首次到访记下的列就是该位置的列，见 pushNav）。
 * - **列/区间**（NAV-1）：入栈时把 reveal 的 `column` 与区间终点 `endColumn` 一并记下，
 *   回跳才回得到原列而不是行首（区间只在真给了宽度时记，零宽等价于只有列）。
 * - **恢复栈**（MM-10）：被关标签的 LIFO（`closed[0]` = 最近关闭），上限
 *   `CLOSED_TABS_LIMIT`，超限丢最旧的。
 * - **不跨项目**：`rootDir` 与传入值不同 ⇒ 两块栈连同 rootDir 整体作废再入栈
 *   （A 项目的导航/恢复栈对 B 项目没有意义，产品语义）。
 */

/**
 * 导航栈条目：一个位置（路径 + 行；行 1 基，与 `revealTargetOf` 的 line 同口径）。
 *
 * 列（NAV-1，additive）：`column` = reveal 的起点列（1 基、UTF-16 码元），`endColumn`
 * = 区间终点（1 基、**不含**端点）。两者缺席都等于"发起方没给列/区间"（回跳落行首，
 * 与入栈前的退化口径逐字一致）。**列不参与去重**：判重只看 path + line（见 pushNav），
 * 因为"同一条行上的不同列"在作者心里是同一个落脚点。
 */
export interface NavEntry {
  readonly path: string;
  readonly line: number;
  /** 1 基起点列；缺席 = 没给列（回跳落行首） */
  readonly column?: number;
  /** 1 基、不含端点的区间终点；缺席 = 零宽（只有列）或没给列 */
  readonly endColumn?: number;
}

/** 条目里记下的列区间（与 `revealLocationOf` 的 span 同形，纯数字、不借 Monaco 类型） */
export interface NavSpan {
  readonly columnStart: number;
  readonly columnEnd: number;
}

/** 导航历史全态（不可变：每个纯函数返回新对象，命中边界时原样返回同一引用） */
export interface NavState {
  /** 导航栈（时间正序：下标越大越近；同一位置至多出现一次——再次到访只挪光标，见 pushNav） */
  readonly stack: readonly NavEntry[];
  /**
   * 光标指针：指向「当前所在」条目的下标；`-1` = 空栈（两种实现自定，本模块取
   * **光标 index**：back 前移 / forward 后移 / push 截断光标之后——比双栈 split
   * 少一份常驻数组，且「前进分支」天然就是 `stack.slice(cursor + 1)`）。
   */
  readonly cursor: number;
  /** 恢复栈（LIFO；`closed[0]` = 最近关闭的那个，`popClosed` 取栈顶） */
  readonly closed: readonly string[];
  /** 所属项目根目录；`null` = 尚未打开项目（App 启动初期 rootDir 还是 null 时也要记导航） */
  readonly rootDir: string | null;
}

/** 恢复栈上限（MM-10：超过即从栈尾丢最旧的——丢最近关闭的比丢远古的更伤） */
export const CLOSED_TABS_LIMIT = 20;

/** 纯函数返回信封：新 state + 目标（边界情形 = 原 state + null，调用方据此发人话反馈） */
export interface NavMove {
  readonly state: NavState;
  readonly entry: NavEntry | null;
}

/** `popClosed` 的返回信封（同款边界口径：空栈 = 原 state + null） */
export interface ClosedPop {
  readonly state: NavState;
  readonly path: string | null;
}

/** 初始态：两块空栈、无项目（App 挂载时 `useRef(createNavState())`） */
export function createNavState(rootDir: string | null = null): NavState {
  return { stack: [], cursor: -1, closed: [], rootDir };
}

/**
 * 跨项目门：传入 rootDir 与 state 记录的不同 ⇒ 两块栈连同 rootDir 整体作废。
 * 相同（含双方都是 null——项目还没开）⇒ 原样返回，不制造无谓的新对象。
 */
function forRoot(state: NavState, rootDir: string | null): NavState {
  if (state.rootDir === rootDir) return state;
  return { stack: [], cursor: -1, closed: [], rootDir };
}

/**
 * 入栈一个导航条目（MM-6 的唯一写入口；App 的 `commitOpenFile` 同拍调用）。
 *
 * - 同 path 同 line ⇒ **不重复入栈**：目标已在时间线里（含恰是当前光标处）时只把
 *   光标挪过去，栈原样长不大——back/forward 落地、重复点击同一定位，都不会污染历史。
 *   **判重不看列**（既有语义，NAV-1 明确保留）：同一条行上的第二次到访即使列不同，
 *   也只挪光标、不改写首条条目的列——该位置的列以首次到访记下的为准；
 * - 否则 ⇒ 截断光标之后的「前进」分支，压栈，光标移到栈尾（VSCode 语义：跳到新
 *   位置后，前进历史作废）；
 * - 传入 rootDir 与 state 不同 ⇒ 先跨项目清空再入栈（项目语义，见文件头）。
 */
export function pushNav(state: NavState, entry: NavEntry, rootDir: string | null): NavState {
  const base = forRoot(state, rootDir);
  const at = base.stack.findIndex((e) => e.path === entry.path && e.line === entry.line);
  if (at >= 0) return at === base.cursor ? base : { ...base, cursor: at };
  const kept = base.stack.slice(0, base.cursor + 1); // 光标之后（含光标处旧条目）整段作废
  return { ...base, stack: [...kept, entry], cursor: kept.length };
}

/**
 * 条目里的列区间 → 打开路径的 `span`（NAV-1：回跳时把区间一并交回 `commitOpenFile`）。
 *
 * 只有**真给了宽度**（`endColumn > column`）才升级成区间，否则 `undefined`——与两条
 * editor opener（`kojo-definition` / `find-references`）的升级判据逐字相同：零宽/没给列
 * 仍是一条 `column`，由 `reveal-position` 统一退化，不在这里二次实现。
 */
export function navEntrySpan(entry: NavEntry): NavSpan | undefined {
  if (entry.column === undefined || entry.endColumn === undefined) return undefined;
  if (entry.endColumn <= entry.column) return undefined;
  return { columnStart: entry.column, columnEnd: entry.endColumn };
}

/** 后退（Alt+←）：光标前移一格。已在最早（或空栈）⇒ 原 state + null（调用方发人话拒绝） */
export function navBack(state: NavState): NavMove {
  if (state.cursor <= 0) return { state, entry: null };
  const cursor = state.cursor - 1;
  return { state: { ...state, cursor }, entry: state.stack[cursor]! };
}

/** 前进（Alt+→）：光标后移一格。已在最新（或空栈）⇒ 原 state + null（调用方发人话拒绝） */
export function navForward(state: NavState): NavMove {
  if (state.cursor < 0 || state.cursor >= state.stack.length - 1) return { state, entry: null };
  const cursor = state.cursor + 1;
  return { state: { ...state, cursor }, entry: state.stack[cursor]! };
}

/** 整份导航态作废（两块栈 + 光标；rootDir 不动——「从哪里开始记」的锚不变） */
export function clearNav(state: NavState): NavState {
  if (state.stack.length === 0 && state.closed.length === 0) return state;
  return { ...state, stack: [], cursor: -1, closed: [] };
}

/**
 * 批量压入恢复栈（MM-10；App 的 `closeManySync` / `closeTabInGroup` 真正关闭处调用）。
 *
 * 按给定顺序整体压入（LIFO：批次里后关的在栈顶，`popClosed` 先恢复它——与单张
 * 连续关闭的先后语义一致）；超过 `CLOSED_TABS_LIMIT` 从栈尾丢最旧的。
 * 空批次 ⇒ 原样返回；rootDir 不同 ⇒ 先跨项目清空再压入。
 */
export function pushClosed(state: NavState, paths: readonly string[], rootDir: string | null): NavState {
  const base = forRoot(state, rootDir);
  if (paths.length === 0) return base;
  const merged = [...paths].reverse().concat(base.closed); // 批次倒序压到栈顶：末位最亮
  const closed = merged.length > CLOSED_TABS_LIMIT ? merged.slice(0, CLOSED_TABS_LIMIT) : merged;
  return { ...base, closed };
}

/** 弹出恢复栈栈顶（最近关闭的那个）。空栈 ⇒ 原 state + null（调用方发人话拒绝） */
export function popClosed(state: NavState): ClosedPop {
  if (state.closed.length === 0) return { state, path: null };
  return { state: { ...state, closed: state.closed.slice(1) }, path: state.closed[0]! };
}
