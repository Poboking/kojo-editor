/**
 * 资源管理器键盘语义的**判据层**（WS-11；零 React、零 DOM，可单测）。
 *
 * 形态与本仓一致：键位"该落到哪一行、该做什么"全在这里算，组件只负责把结果接出去
 * （移动焦点 / 展开收起 / 打开 / 重命名 / 删除 / 全选）。判据住纯模块的好处很具体：
 * 组件里 `preventDefault` 与 Monaco 抢键的那类事故，测出来靠的是这里的一条条断言，
 * 而不是把浏览器开起来按一遍。
 *
 * ## 键位表（与用户读感对齐，全部只在焦点落在树内时生效）
 *
 * | 键 | 动作 |
 * | --- | --- |
 * | ↑ / ↓ | 上/下一个**树项**（跨分组、跨包；说明行不站脚）；按住 Shift = 连选 |
 * | → | 折叠着就展开；已展开就进第一个子层 |
 * | ← | 展开着就收起；已收起/叶子就回父层 |
 * | Home / End | 第一个 / 最后一个树项 |
 * | Enter / Space | 文件行 = 打开；结构行 = 展开收起 |
 * | F2 | 重命名（走既有行内编辑链路） |
 * | Delete | 删除（走既有守门 + 回收站链路） |
 * | Ctrl / Cmd + A | 全选当前可见的树项 |
 *
 * **没列出来的键一律不接管**（返回 `noop` ⇒ 组件既不 preventDefault 也不 stopPropagation），
 * 这是"不抢 Monaco / 标签栏按键"那条纪律的实现方式：白名单，而不是黑名单。
 */
import type { FlatRow, FlatTree } from './file-tree-flat';
import { isNavigable } from './file-tree-flat';

/** 一次按键的现场（只取判据需要的几枚修饰位） */
export interface TreeKeyEvent {
  readonly key: string;
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
}

/** 从原生事件取判据现场（组件侧唯一需要读 `KeyboardEvent` 的地方） */
export function treeKeyEventOf(e: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): TreeKeyEvent {
  return { key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey };
}

export type TreeKeyCommand =
  /** 焦点移到第 `index` 行；`extend` = Shift 连选（锚点 = 当前焦点行） */
  | { type: 'focus'; index: number; extend: boolean }
  | { type: 'expand'; index: number }
  | { type: 'collapse'; index: number }
  | { type: 'toggle'; index: number }
  | { type: 'open'; index: number }
  | { type: 'rename'; index: number }
  | { type: 'delete'; index: number }
  | { type: 'selectAll' }
  /** 不接管这一键（组件既不 preventDefault 也不 stopPropagation） */
  | { type: 'noop' };

/** 结构行里允许重命名 / 删除的那些（角色组目录不给这两个动作——口径与右键菜单一致） */
function isEntryRow(row: FlatRow): boolean {
  return row.kind === 'file' || row.kind === 'extra' || row.kind === 'dir' || row.kind === 'package';
}

function isDirRow(row: FlatRow): boolean {
  return row.kind === 'dir' || row.kind === 'package';
}

/**
 * 从 `from` 起按 `step` 找**下一个可聚焦的树项**（说明行不是项，跨过它）。
 * 越界返回 null——调用侧据此什么都不做（不做"绕回开头"那种读起来像 bug 的动作）。
 */
export function nextNavigable(tree: FlatTree, from: number, step: 1 | -1): number | null {
  for (let i = from + step; i >= 0 && i < tree.rows.length; i += step) {
    const row = tree.rows[i] as FlatRow;
    if (isNavigable(row)) return i;
  }
  return null;
}

/** 第一个 / 最后一个可聚焦树项（没有 = null） */
export function edgeNavigable(tree: FlatTree, edge: 'first' | 'last'): number | null {
  const step = edge === 'first' ? 1 : -1;
  const start = edge === 'first' ? 0 : tree.rows.length - 1;
  const self = tree.rows[start];
  if (self !== undefined && isNavigable(self)) return start;
  return nextNavigable(tree, start - step, step);
}

/**
 * 焦点行进入子层时的落点：第一个子行，且**它自己得是可聚焦的树项**。
 *
 * 为什么不往后找：行模型只记 `childIdx`（第一个子行），不记子树末尾——"跨过说明行继续找"
 * 会一路找到**兄弟节点**里去（组头 → 说明行 → 下一个组头），那读起来就是"按了 → 跳到别人家"。
 * 子层第一格是说明行 ⇒ 这一层眼下没有可站脚的东西，返回 null（noop）比乱跳诚实。
 */
export function firstNavigableChild(tree: FlatTree, index: number): number | null {
  const parent = tree.rows[index];
  if (parent === undefined || parent.childIdx < 0) return null;
  const child = tree.rows[parent.childIdx] as FlatRow;
  return isNavigable(child) ? parent.childIdx : null;
}

/**
 * 键位判据（纯函数）。
 *
 * `focusIndex < 0` = 树上还没有焦点行 ⇒ 方向键等价于 Home（第一次按 ↓ 就该看见第一项），
 * 其余需要"当前行"的动作（F2 / Delete / Enter）一律不接管——没有当前行就没有宾语。
 */
export function planTreeKey(ev: TreeKeyEvent, tree: FlatTree, focusIndex: number): TreeKeyCommand {
  if (ev.alt) return { type: 'noop' };
  const row = focusIndex >= 0 ? tree.rows[focusIndex] : undefined;
  const key = ev.key;

  if ((ev.ctrl || ev.meta) && !ev.shift && (key === 'a' || key === 'A')) return { type: 'selectAll' };
  if (ev.ctrl || ev.meta) return { type: 'noop' }; // 组合键交回宿主（Ctrl+C / Ctrl+Shift+… 都不归树管）

  switch (key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      const step = key === 'ArrowDown' ? 1 : -1;
      if (focusIndex < 0) {
        const first = edgeNavigable(tree, 'first');
        return first === null ? { type: 'noop' } : { type: 'focus', index: first, extend: false };
      }
      const next = nextNavigable(tree, focusIndex, step);
      if (next === null) return { type: 'noop' };
      // Shift + ↑↓ = 连选（锚点 = 当前焦点行，判据住 `rangePaths`）
      return { type: 'focus', index: next, extend: ev.shift };
    }
    case 'Home': {
      const first = edgeNavigable(tree, 'first');
      return first === null ? { type: 'noop' } : { type: 'focus', index: first, extend: ev.shift };
    }
    case 'End': {
      const last = edgeNavigable(tree, 'last');
      return last === null ? { type: 'noop' } : { type: 'focus', index: last, extend: ev.shift };
    }
    case 'ArrowRight': {
      if (row === undefined) return { type: 'noop' };
      if (row.expandable && !row.open) return { type: 'expand', index: focusIndex };
      if (row.expandable && row.open) {
        const child = firstNavigableChild(tree, focusIndex);
        return child === null ? { type: 'noop' } : { type: 'focus', index: child, extend: false };
      }
      return { type: 'noop' };
    }
    case 'ArrowLeft': {
      if (row === undefined) return { type: 'noop' };
      if (row.expandable && row.open) return { type: 'collapse', index: focusIndex };
      if (row.parentIdx >= 0) return { type: 'focus', index: row.parentIdx, extend: false };
      return { type: 'noop' };
    }
    case 'Enter':
    case ' ':
    case 'Spacebar': {
      if (row === undefined) return { type: 'noop' };
      if (row.kind === 'file') return { type: 'open', index: focusIndex };
      if (row.expandable) return { type: 'toggle', index: focusIndex };
      return { type: 'noop' };
    }
    case 'F2': {
      if (row === undefined || !isEntryRow(row)) return { type: 'noop' };
      return { type: 'rename', index: focusIndex };
    }
    case 'Delete':
    case 'Backspace': {
      if (row === undefined || !isEntryRow(row)) return { type: 'noop' };
      return { type: 'delete', index: focusIndex };
    }
    default:
      return { type: 'noop' };
  }
}

/** 这一行是不是目录形态（决定删除确认文案与 `io.removeDir` 走哪条腿） */
export function rowIsDir(tree: FlatTree, index: number): boolean {
  const row = tree.rows[index];
  return row !== undefined && isDirRow(row);
}

/**
 * 点行时的焦点语义（WS-11 的鼠标侧；组件在容器冒泡侧用）。
 *
 * - Shift + 单击 = 从锚点连选到点击那一行（**不打开**）；
 * - Ctrl / Cmd + 单击 = 勾选切换（行组件自己已经做了，这里只负责把焦点带过去）；
 * - 纯单击 = 焦点落到这一行。
 */
export type ClickPlan = { type: 'range'; index: number } | { type: 'focus'; index: number } | { type: 'none' };

export function planRowClick(ev: { shift: boolean; ctrl: boolean; meta: boolean }, index: number): ClickPlan {
  if (ev.shift) return { type: 'range', index };
  if (ev.ctrl || ev.meta) return { type: 'focus', index };
  return { type: 'focus', index };
}
