import { nextRovingIndex } from './shell-keys';

/**
 * 结果类面板的**行导航**（1020 编辑器体感批，用户反馈项 9）。
 *
 * 检索面板与问题面板此前只给了"鼠标可达"：结果行是 `<button>`（Tab 得到、Enter 按得动），
 * 但 ↑↓ 不能在一屏几十行里跳着看，F4 / F8 更是完全没有——作者只能靠手点。
 * 本模块把两只面板的键盘口径收成一份，免得两条通道各写一套、迟早分叉：
 *
 * - **↑↓ = 只在可见行之间移动焦点**，不打开任何东西：焦点不在行上时，↓ 从第一行走、
 *   ↑ 从最后一行走（同一条回绕尺子，不留特例）；
 * - **F4 / F8 = 移动焦点并当场打开**（Shift 反向）：等价于"按 ↑↓ 走到那一行再敲 Enter"，
 *   所以打开动作走的还是那一行按钮自己的 `onClick`，面板里不留第二条跳转路径；
 * - **`<select>` / `<textarea>` 里的方向键一律让位**：下拉框的方向键是改选项、
 *   多行框的方向键是移光标，把它们吃掉就成了"排序框按不动"那种新 bug。
 *   单行检索框不放这条：那里 ↑↓ 本来什么都不做，让给行导航正是作者要的手感。
 *
 * 边界回绕、空集合返回 `null` 这些判据**不在本文件重写**：直接复用
 * `shell-keys.nextRovingIndex`（文件树与 tablist 用的同一条漫游尺子）。
 */

/** 结果行的 DOM 标记：容器里带这个属性的按钮才参与行导航（折叠组里没画出来的行自然不在名单上） */
export const PANEL_ROW_ATTR = 'data-panel-row';

/** 一次导航的落点：第几行（容器内可见行的下标），要不要顺手打开 */
export interface RowNavDecision {
  readonly index: number;
  readonly open: boolean;
}

export interface RowNavInput {
  readonly key: string;
  readonly shiftKey: boolean;
  /** 当前聚焦行的下标；焦点不在结果行上 = `-1` */
  readonly current: number;
  /** 可见结果行数（0 = 没有可导航的行） */
  readonly count: number;
  /** 按键落在下拉框 / 多行框里（方向键要让位，功能键不用） */
  readonly inField: boolean;
}

/**
 * 一次按键该怎么走（纯函数；`null` = 不消费，原样让位，绝不吞别人的键）。
 *
 * F4 与 F8 走同一条腿是有意的：VS Code 里 F4 属于"检索结果"、F8 属于"问题"，
 * 但在**面板里**它们问的是同一件事——"下一个 / 上一个"。一把尺子两处用，
 * 作者从哪个面板学到的手感都到得了另一个。
 */
export function rowNavDecision(input: RowNavInput): RowNavDecision | null {
  const { key, shiftKey, current, count, inField } = input;
  let dir: 1 | -1;
  let open: boolean;
  if (key === 'ArrowDown') {
    dir = 1;
    open = false;
  } else if (key === 'ArrowUp') {
    dir = -1;
    open = false;
  } else if (key === 'F4' || key === 'F8') {
    dir = shiftKey ? -1 : 1;
    open = true;
  } else {
    return null;
  }
  if (open === false && inField) return null; // 下拉框 / 多行框里的方向键归那个控件
  if (count <= 0) return null;
  // 焦点还没进列表（在检索框里）：↓ 进**第一行**、↑ 进**最后一行**——这一步不走回绕，
  // 因为 `nextRovingIndex` 把 `-1` 先夹到 `0` 再加一，从输入框按 ↓ 会跳到第二行（少一行）。
  if (current < 0) return { index: dir === 1 ? 0 : count - 1, open };
  const index = nextRovingIndex(current, count, dir === 1 ? 'ArrowDown' : 'ArrowUp');
  return index === null ? null : { index, open };
}

/** 一个可导航的结果行（DOM 元素满足这个形状；测试里给桩即可，不必起 jsdom） */
export interface PanelRowElement {
  focus(): void;
  click(): void;
  closest?(selector: string): unknown;
}

/** 行导航要找的那一段容器（只含结果区，工具条与过滤框不参与 ⇒ 不在同一棵子树里） */
export interface PanelRowNavHost {
  querySelectorAll(selector: string): ArrayLike<PanelRowElement>;
}

/** 方向键让位的那几种控件（单行检索框不在内，理由见模块头） */
const FIELD_SELECTOR = 'select, textarea';

/** 行名单的选择器（与行标记 `PANEL_ROW_ATTR` 同一个真源，两处不许各写一遍字符串） */
export const PANEL_ROW_SELECTOR = `[${PANEL_ROW_ATTR}]`;

/**
 * 把一次按键落到容器里的行按钮上。返回 `true` = 已消费。
 *
 * 行名单每次现取（不缓存）：结果随流式检索一行行长出来、过滤与折叠也会改名单，
 * 缓存下标一定会指错行。取的是 **DOM 序**，与面板画行的序同一条 ⇒ 所见即所跳。
 */
export function applyPanelRowNav(host: PanelRowNavHost | null, e: RowNavDomEvent): boolean {
  if (host === null) return false;
  const target = e.target as { closest?(selector: string): unknown } | null;
  // `closest` 只在这一处判一次存在性（TS  narrowing 穿不过布尔变量，写成 canClimb 就得再断言一次）
  if (typeof target?.closest !== 'function') {
    return applyRowNav(host, e, null, false);
  }
  const climb = target.closest.bind(target);
  return applyRowNav(host, e, climb(PANEL_ROW_SELECTOR) as PanelRowElement | null, climb(FIELD_SELECTOR) !== null);
}

function applyRowNav(
  host: PanelRowNavHost,
  e: RowNavDomEvent,
  owner: PanelRowElement | null,
  inField: boolean,
): boolean {
  const rows = Array.from(host.querySelectorAll(PANEL_ROW_SELECTOR));
  const decision = rowNavDecision({
    key: e.key,
    shiftKey: e.shiftKey,
    current: owner === null ? -1 : rows.indexOf(owner),
    count: rows.length,
    inField,
  });
  if (decision === null) return false;
  const next = rows[decision.index];
  if (next === undefined) return false;
  e.preventDefault();
  next.focus();
  // 打开就敲这一枚按钮本身：跳转判据仍然只住在行的 onClick 那一处
  if (decision.open) next.click();
  return true;
}

/** 键盘事件里本模块要看的那几样（React 合成事件与原生事件都满足 ⇒ 接线处零适配） */
export interface RowNavDomEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly target: unknown;
  preventDefault(): void;
}
