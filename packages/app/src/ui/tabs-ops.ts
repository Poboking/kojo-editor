/**
 * 标签栏能力（C1 右键菜单 / C2 固定标签 / 批量关闭）的纯逻辑。
 * 零 React、零 IO——组件只接线，判据放这里才可单测（file-tree-ops 同款先例）。
 *
 * 设计口径：
 * - **顺序只有一份真源**：`openTabs` 本身维持「固定区在前、非固定区在后」的不变量
 *   （pin/unpin 与拖拽重排都经本模块的函数落地）——渲染层照单全收，不再另排一次；
 * - **pinned 是会话态**：标签列表本身不持久化，pin 不必走得更远——与 openTabs
 *   同生命周期，关项目 / 切项目随 resetProjectUiState 一起清；
 * - **pin 只能被用户显式取消**：批量关闭（其他/右侧/全部）绝不清扫固定标签；
 *   拖拽跨分界是显式手势，才允许自动改固定态（见 planReorder）。
 */

/** 批量关闭模式：关闭其他 / 关闭右侧 / 关闭全部（锚点 = 右键的那个标签） */
export type BatchCloseMode = 'others' | 'right' | 'all';

export interface BatchClosePlan {
  /** 待关闭标签（按 openTabs 原序；逐个走既有单标签确认链，脏的弹一次确认） */
  readonly toClose: readonly string[];
  /** 计划执行后留下的标签（含固定标签与锚点） */
  readonly kept: readonly string[];
}

/**
 * 批量关闭计划（纯函数；只算不动手）。
 *
 * - 「其他」：留下锚点 + 全部固定标签，其余关；
 * - 「右侧」：分界 = 右键的那个标签（与 pin 无关），其右侧除固定标签外全关；
 * - 「全部」：只留固定标签。
 *
 * 取消即中止剩余的批量关闭、已关的不回滚（VSCode 同款）——中止语义在 App 的
 * 推进器里兑现，本函数只负责「哪些关哪些留」。
 */
export function planBatchClose(
  mode: BatchCloseMode,
  openTabs: readonly string[],
  anchor: string,
  pinned: ReadonlySet<string>,
): BatchClosePlan {
  const idx = openTabs.indexOf(anchor);
  if (idx < 0) return { toClose: [], kept: [...openTabs] };
  let scope: readonly string[];
  let keep: ReadonlySet<string>;
  switch (mode) {
    case 'others':
      scope = openTabs;
      keep = new Set([anchor, ...pinned]);
      break;
    case 'right':
      scope = openTabs.slice(idx + 1);
      keep = pinned;
      break;
    case 'all':
      scope = openTabs;
      keep = pinned;
      break;
  }
  const toClose = scope.filter((p) => !keep.has(p));
  const closeSet = new Set(toClose);
  return { toClose, kept: openTabs.filter((p) => !closeSet.has(p)) };
}

/**
 * 批量关闭无可作为时的一句人话（铁律 4：按下去必须有响）。
 * 「右侧」的两种空（右边没标签 / 右边只剩固定的）同一句话就能说清，不造两份文案。
 */
export function batchCloseEmptyReason(
  mode: BatchCloseMode,
  openTabs: readonly string[],
  anchor: string,
  pinned: ReadonlySet<string>,
): string {
  switch (mode) {
    case 'others': {
      const others = openTabs.filter((p) => p !== anchor);
      return others.length === 0 ? '没有其他标签' : '其他标签都已固定，没有可关闭的';
    }
    case 'right':
      return '右侧没有可关闭的标签';
    case 'all':
      return openTabs.every((p) => pinned.has(p))
        ? '固定标签不会被关闭，没有可关闭的标签'
        : '没有打开的标签';
  }
}

/* ------------------------------ 固定标签（C2） ------------------------------ */

/**
 * 固定 / 取消固定后的标签顺序（纯函数）：维持「固定区在前」的不变量——
 * pin = 挪到固定区末尾；unpin = 挪到非固定区开头（紧贴分界）。
 * 两种落点恰好都是"移除该标签后固定区的数量"这个下标，一个 splice 都不多写。
 * path 不在列表里时原样返回（不动）；不修改入参数组。
 */
export function applyPin(
  openTabs: readonly string[],
  path: string,
  pin: boolean,
  pinned: ReadonlySet<string>,
): string[] {
  const from = openTabs.indexOf(path);
  if (from < 0) return [...openTabs];
  const rest = openTabs.filter((p) => p !== path);
  const pinnedCount = rest.reduce((n, p) => n + (pinned.has(p) ? 1 : 0), 0);
  const next = [...rest];
  next.splice(pinnedCount, 0, path);
  return next;
}

/* ------------------------------ 拖拽重排与分界（C2） ------------------------------ */

export interface ReorderPlan {
  readonly order: readonly string[];
  /** 跨分界拖放 ⇒ 自动改固定态（非固定拖进固定区 = pin；固定拖出 = unpin）；null = 不变 */
  readonly pinChange: { readonly path: string; readonly pin: boolean } | null;
}

/**
 * 拖拽重排计划（纯函数；删除后插入语义，toIndex 以移除 path 之后的数组为基准）。
 *
 * 分界规则的取舍是「自动改固定态」而不是「禁止越过」：落点指示（drop-before /
 * drop-after）画在哪、标签就落在哪——若禁止，指示器会指向一个标签实际到不了的位置，
 * 所见与所得分裂。自动改态下，指示器与固定标记同时可见，所见即所得（VSCode 同款）。
 * 固定区内部的相对顺序照常可调，不触发改态。
 */
export function planReorder(
  openTabs: readonly string[],
  path: string,
  toIndex: number,
  pinned: ReadonlySet<string>,
): ReorderPlan {
  const from = openTabs.indexOf(path);
  if (from < 0) return { order: [...openTabs], pinChange: null };
  const wasPinned = pinned.has(path);
  const rest = openTabs.filter((p) => p !== path);
  const pinnedCount = rest.reduce((n, p) => n + (pinned.has(p) ? 1 : 0), 0);
  const at = Math.max(0, Math.min(toIndex, rest.length));
  const order = [...rest];
  order.splice(at, 0, path);
  let pinChange: ReorderPlan['pinChange'] = null;
  if (!wasPinned && at < pinnedCount) pinChange = { path, pin: true };
  // at === pinnedCount = 固定区末尾（仍是固定区）；越过了才算拖出
  else if (wasPinned && at > pinnedCount) pinChange = { path, pin: false };
  return { order, pinChange };
}

/* ------------------------------ 右键菜单（C1） ------------------------------ */

export type TabMenuItemId =
  | 'close'
  | 'close-others'
  | 'close-right'
  | 'close-all'
  | 'toggle-pin'
  | 'copy-path';

export interface TabMenuItemSpec {
  readonly id: TabMenuItemId;
  readonly label: string;
  /** 右侧快捷键提示（纯展示；Ctrl+W 这一条由壳层命令表真实注册，其余动作没有缺省键位） */
  readonly shortcut?: string;
  /** 在这一项**之前**画一条分隔线（首项的分隔线由渲染侧吞掉，照 file-tree-ops 口径） */
  readonly dividerBefore?: boolean;
}

/**
 * 标签右键菜单项（纯函数）。全部项恒在（铁律 4：无可作为时按下去由
 * batchCloseEmptyReason 给一句人话，不灰掉不消失）。
 * 固定标签的关闭钮虽已隐藏（防误关），但「关闭」仍可从这里显式发起——与 VSCode 同口径。
 */
export function tabMenuItemsFor(pinned: boolean): TabMenuItemSpec[] {
  return [
    { id: 'close', label: '关闭', shortcut: 'Ctrl+W' },
    { id: 'close-others', label: '关闭其他标签' },
    { id: 'close-right', label: '关闭右侧标签' },
    { id: 'close-all', label: '关闭全部标签' },
    { id: 'toggle-pin', label: pinned ? '取消固定' : '固定标签', dividerBefore: true },
    { id: 'copy-path', label: '复制路径' },
  ];
}

/* ------------------------------ 渲染辅助 ------------------------------ */

/** 标签的落点指示（拖拽重排时） */
export interface TabDropHint {
  readonly path: string;
  readonly before: boolean;
}

/** 标签 className（纯函数）：活动 / 固定 / 落点指示三态可叠加（活动+落点 = 双指示） */
export function tabClassName(
  p: string,
  active: boolean,
  pinned: boolean,
  dropAt: TabDropHint | null,
): string {
  return [
    'editor-tab',
    active ? 'active' : '',
    pinned ? 'pinned' : '',
    dropAt?.path === p ? (dropAt.before ? 'drop-before' : 'drop-after') : '',
  ]
    .filter(Boolean)
    .join(' ');
}
