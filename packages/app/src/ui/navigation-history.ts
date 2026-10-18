/**
 * 导航历史（MM-6 前进/后退 + MM-10 恢复关闭的标签）：编辑器「肌肉记忆」的**纯逻辑**。
 *
 * 零 React、零 Monaco、零内核——与 `editor-groups.ts` 同族：给一份旧态 + 一个意图
 * ⇒ 返回一份新态。App（`ui/App.tsx`）是唯一的状态所有者（持 `navRef`，回调经纯函数
 * 读写），本模块的每条规则由 `navigation-history.test.ts` 钉死。
 *
 * 两块栈，一条产品语义：
 * - **导航栈**（MM-6）：`{ path, line }` 条目的时间线 + `cursor` 光标。back = 光标
 *   前移，forward = 光标后移，push = 截断「前进」分支后压栈（VSCode 语义：跳到新
 *   位置后，前进历史作废）。同 path 同 line 不重复入栈（已在时间线里的位置 = 把
 *   光标挪回去，栈不涨）。
 * - **恢复栈**（MM-10）：被关标签的 LIFO（`closed[0]` = 最近关闭），上限
 *   `CLOSED_TABS_LIMIT`，超限丢最旧的。
 * - **不跨项目**：`rootDir` 与传入值不同 ⇒ 两块栈连同 rootDir 整体作废再入栈
 *   （A 项目的导航/恢复栈对 B 项目没有意义，产品语义）。
 */

/** 导航栈条目：一个位置（路径 + 行；行 1 基，与 `revealTargetOf` 的 line 同口径） */
export interface NavEntry {
  readonly path: string;
  readonly line: number;
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
 *   光标挪过去，栈原样长不大——back/forward 落地、重复点击同一定位，都不会污染历史；
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
