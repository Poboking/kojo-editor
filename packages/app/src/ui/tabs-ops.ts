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
 *
 * 1023 覆盖面批：右键菜单的**项与可用性**也住这里（`tabMenuItemsFor` /
 * `groupMenuItemsFor`）——标题与键位一律从键位注册表取（`menuItemFromCommand`），
 * 组件只负责把选中项接到既有动作上，不再自己写文案。
 */
import { menuItemFromCommand, type ContextMenuItem } from './context-menu-model';

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

/* ------------------------------ 关闭已保存（1023 覆盖面批） ------------------------------ */

/** 「关闭已保存」没有可关的标签时的那句人话（禁用原因与执行后提示共用一份文案） */
export const CLOSE_SAVED_EMPTY_REASON = '没有已保存的标签';

/**
 * 「关闭已保存」的关闭清单（纯函数；只算不动手）。
 *
 * **判定不另起一套**：范围与固定标签豁免直接取 `planBatchClose('all')` 的产物，
 * 这里只在其上再剔一道「有未保存修改的」（本动作的全部语义）——批量关闭的口径
 * （固定标签绝不被批量清扫）与别处保持同一条。
 *
 * 空清单由调用方按 `CLOSE_SAVED_EMPTY_REASON` 说话（铁律 4：按下去必须有响）。
 */
export function planCloseSaved(
  openTabs: readonly string[],
  anchor: string,
  pinned: ReadonlySet<string>,
  dirty: ReadonlySet<string>,
): readonly string[] {
  return planBatchClose('all', openTabs, anchor, pinned).toClose.filter((p) => !dirty.has(p));
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

/* ------------------------------ 预览标签（1020 编辑器体感批） ------------------------------ */

/** 打开文件这一动作的**方式**（不是新地址，只是"这次算浏览还是算常驻"） */
export interface OpenFileOptions {
  /**
   * `true` = 预览态打开（VS Code 单击文件树那一份）：斜体标签、**不占新位**——
   * 本组已有预览标签时被就地替换。缺省 false = 永久打开（跳转、搜索、最近文件都是这种）。
   */
  readonly preview?: boolean;
}

export interface PreviewOpenPlan {
  /** 新的标签序列（与入参同一引用 = 无需改动，调用方可据此跳过一次 setState） */
  readonly tabs: readonly string[];
  /** 这一组此刻的预览标签（`null` = 没有预览态） */
  readonly preview: string | null;
  /** 这次点击是否把目标**固定**下来了（预览再点一次 = 固定；给了作者一句可见的变化） */
  readonly pinned: boolean;
}

/**
 * 预览态打开一张标签的计划（纯函数，只算不动手）。
 *
 * 四条规则，逐条对着 VS Code 的行为定：
 * 1. 目标**已开着**：如果它就是当前预览 ⇒ 固定（清掉预览态，位置不变）；否则只是激活，不动预览；
 * 2. 本组**已有预览且它不在编辑状态** ⇒ 就地替换那张预览（保持原位置、不涨标签数）；
 * 3. 本组已有预览但**那张是脏的** ⇒ 不替换（作者改过的东西绝不因为"多点了一下文件树"而消失）：
 *    旧预览就地转正，新文件作为普通标签追加；
 * 4. 没有预览 ⇒ 追加并记为预览。
 *
 * 脏判定由调用方以回调给（`previewIsDirty`），本模块不认识编辑器——与 `planBatchClose`
 * 同一口径：判据在这里，写盘/关 model 的动作留在宿主。
 */
export function planPreviewOpen(
  openTabs: readonly string[],
  preview: string | null,
  nextPath: string,
  previewIsDirty: (path: string) => boolean = () => false,
): PreviewOpenPlan {
  if (openTabs.includes(nextPath)) {
    if (preview === nextPath) return { tabs: openTabs, preview: null, pinned: true };
    return { tabs: openTabs, preview, pinned: false };
  }
  if (preview !== null && openTabs.includes(preview)) {
    if (previewIsDirty(preview)) {
      return { tabs: [...openTabs, nextPath], preview: null, pinned: false };
    }
    const tabs = openTabs.map((p) => (p === preview ? nextPath : p));
    return { tabs, preview: nextPath, pinned: false };
  }
  return { tabs: [...openTabs, nextPath], preview: nextPath, pinned: false };
}

/**
 * 固定一张预览标签（点标签本身 / 在树里再点一次同一文件都走这里）。
 * 不在预览态时返回同一引用，调用方可据此跳过 setState（少一次无谓重渲）。
 */
export function pinPreview(preview: string | null, path: string): string | null {
  return preview === path ? null : preview;
}

/* ------------------------------ 拖拽重排与分界（C2） ------------------------------ */

/**
 * 标签拖拽的自定义 MIME（1027 跨组批：从 `tabs-bar.tsx` 组件内提到这里）。
 *
 * 两个理由：跨组的落点（标签行 / 标签栏空白 / 空组正文）分居三个模块，MIME 必须
 * 有一份共享真源；而判别载荷形状（组 id + 路径）是纯逻辑，应当可单测。
 */
export const TAB_DRAG_MIME = 'application/x-kojo-tab-move';

/**
 * 一次标签拖拽的载荷：**源组 id + 路径**。
 * 只有路径不够用——同一个文件可以同时开在两个组里，跨组移动要知道"从哪一组拿走的"。
 */
export interface TabDragPayload {
  readonly groupId: string | null;
  readonly path: string;
}

/** 拖拽载荷编码（dragstart 时写进 dataTransfer） */
export function encodeTabDragPayload(groupId: string | null, path: string): string {
  return JSON.stringify({ groupId, path });
}

/**
 * 拖拽载荷解码：**损坏容忍**——非 JSON（旧版载荷就是一条裸路径）或形状不对时，
 * 把原文整条当路径收下（`groupId: null` = 源组未知）；只有空串回 `null`
 * （空串代表"这不是一次标签拖拽"，不是"路径为空"）。
 */
export function decodeTabDragPayload(raw: string): TabDragPayload | null {
  if (raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const rec = parsed as Record<string, unknown>;
      if (typeof rec.path === 'string' && rec.path !== '') {
        const gid = rec.groupId;
        return { groupId: typeof gid === 'string' && gid !== '' ? gid : null, path: rec.path };
      }
    }
  } catch {
    // 非 JSON：落到下面的裸路径分支
  }
  return { groupId: null, path: raw };
}

/**
 * 一次拖放的落点事实：目标组 + 该组标签 + 命中的标签（`null` = 空白处 ⇒ 追加到末尾）
 * + 命中标签的左半/右半。
 */
export interface TabDropTarget {
  readonly groupId: string;
  readonly tabs: readonly string[];
  readonly targetPath: string | null;
  readonly before: boolean;
}

/** 落点计划的三态：无操作 / 组内重排 / 跨组移动 */
export type TabDropKind = 'none' | 'reorder' | 'move';

export interface TabDropPlan {
  readonly kind: TabDropKind;
  readonly path: string;
  /** 源组（拖拽载荷给的；`null` = 未知，跨组时调用方据此决定不做） */
  readonly fromGroupId: string | null;
  readonly toGroupId: string | null;
  /**
   * 两种语义各归各：
   * - `reorder`：**删除后插入**下标（移除 path 之后的数组为基准，旧口径）；
   * - `move`：目标组的**插入下标**（源组那边删掉一个位置不参与修正——跨组不是同一个数组）。
   */
  readonly toIndex: number;
}

const NO_TAB_DROP: TabDropPlan = {
  kind: 'none',
  path: '',
  fromGroupId: null,
  toGroupId: null,
  toIndex: 0,
};

/**
 * 拖放落点计划（纯函数；只算不动手）。
 *
 * - **同组**：落点折算成删除后插入下标，与 `planReorder` 的既有语义逐字一致
 *   （`from === to` 视为无操作，调用方不必再去重）；
 * - **跨组**：插入下标 = 命中标签的下标（左半）/ 下标 + 1（右半），**不做**同组那种
 *   删除位移修正；空白处 = 追加到目标组末尾。源组未知（旧版裸路径载荷且本组没开它）
 *   ⇒ 无操作：不猜它是从哪一组来的。
 * - **落空**（命中标签不在目标组 / 载荷为空）⇒ 无操作。
 */
export function planTabDrop(drag: TabDragPayload | null, target: TabDropTarget): TabDropPlan {
  if (drag === null) return NO_TAB_DROP;
  let insert: number;
  if (target.targetPath === null) {
    insert = target.tabs.length;
  } else {
    const hit = target.tabs.indexOf(target.targetPath);
    if (hit < 0) return NO_TAB_DROP;
    insert = hit + (target.before ? 0 : 1);
  }
  // 同组判定：载荷带组 id 就比 id；旧版裸路径载荷（groupId null）看本组开没开它
  const sameGroup =
    drag.groupId !== null ? drag.groupId === target.groupId : target.tabs.includes(drag.path);
  if (!sameGroup) {
    if (drag.groupId === null) return NO_TAB_DROP;
    return {
      kind: 'move',
      path: drag.path,
      fromGroupId: drag.groupId,
      toGroupId: target.groupId,
      toIndex: insert,
    };
  }
  const from = target.tabs.indexOf(drag.path);
  if (from < 0) return NO_TAB_DROP;
  const to = from < insert ? insert - 1 : insert;
  if (to === from) return NO_TAB_DROP;
  return {
    kind: 'reorder',
    path: drag.path,
    fromGroupId: target.groupId,
    toGroupId: target.groupId,
    toIndex: to,
  };
}

/**
 * 把插入下标钳进**固定区 / 非固定区**（跨组移动复用「固定区在前」的不变量）。
 *
 * 目标组里固定标签的条数就是分界：被移动标签自己是固定标签 ⇒ 只能落在
 * `[0, pinnedCount]`；否则只能落在 `[pinnedCount, len]`。与 `applyPin` /
 * `planReorder` 是同一份顺序口径（分界由 pinned 集合现算，不另存一份）。
 */
export function clampIndexToPinZone(
  tabs: readonly string[],
  toIndex: number,
  pinnedTarget: boolean,
  pinned: ReadonlySet<string>,
): number {
  let pinnedCount = 0;
  for (const p of tabs) if (pinned.has(p)) pinnedCount++;
  const lo = pinnedTarget ? 0 : pinnedCount;
  const hi = pinnedTarget ? pinnedCount : tabs.length;
  // 非数值（宿主没给落点）按"落在该段末尾"处理，不把 NaN 传进 splice
  if (!Number.isFinite(toIndex)) return hi;
  return Math.max(lo, Math.min(toIndex, hi));
}

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

/* ------------------------------ 右键菜单（C1；1023 覆盖面批补齐） ------------------------------ */

/**
 * 标签菜单的动作 id。**语义不许改**：C1 那六条（close / close-others / close-right /
 * close-all / toggle-pin / copy-path）原样保留，本批只往后追加。
 */
export type TabMenuItemId =
  | 'close'
  | 'close-others'
  | 'close-right'
  | 'close-saved'
  | 'close-all'
  | 'toggle-pin'
  | 'reopen'
  | 'copy-path'
  | 'copy-relative'
  | 'copy-name'
  | 'reveal'
  | 'open-in-new-group'
  | 'move-to-group'
  /** 「移动到组」的子项：`move-to-group:<目标组 id>`（组 id 由宿主分配，这里不猜） */
  | `move-to-group:${string}`
  | 'split-right'
  | 'split-down';

/**
 * 一次标签右键能看到的**事实**（组件从本组状态现算；纯函数只照它出项）。
 *
 * 为什么用事实而不是布尔堆参数：菜单项的可见性与禁用原因都要问同一批问题
 * （有没有可关的已保存标签 / 有没有资源管理器 / 命令通道在不在），
 * 参数一多，调用点与测试都读不出「这一段在判断什么」。
 */
export interface TabMenuFacts {
  /** 这一枚标签当前是否固定 */
  readonly pinned: boolean;
  /** 本组有「已保存且非固定」的标签可关（关闭已保存的可用性判据，见 planCloseSaved） */
  readonly hasSaved: boolean;
  /** 「在资源管理器中显示」有落脚点（Tauri 壳；浏览器壳没有这个能力 ⇒ 整项不显示） */
  readonly canReveal: boolean;
  /** 「恢复关闭的标签」通道可执行（命令通道不在 ⇒ 整项不显示） */
  readonly hasReopen: boolean;
  /** 拆分命令可执行（不可执行 ⇒ 显示但禁用 + 原因） */
  readonly canSplit: boolean;
  /** 有项目根 ⇒ 「复制相对路径」才有基准（没有 ⇒ 整项不显示，免得拷出误导的半截路径） */
  readonly hasRoot: boolean;
  /**
   * **其他**编辑器组（1027 跨组批）：「移动到组」子菜单的来源。
   * 空数组 = 只有一个组 ⇒ 该项灰着并说明原因（铁律 4：不可用必须让人看见为什么）。
   */
  readonly otherGroups: readonly TabMenuGroupRef[];
}

/** 菜单里显示的另一组：id 给动作，label 由调用方给（如「第 2 组」），本模块不编号 */
export interface TabMenuGroupRef {
  readonly id: string;
  readonly label: string;
}

/**
 * 标签右键菜单项（纯函数，按三组排：关闭 | 复制与显示 | 分屏与分组）。
 *
 * 口径：
 * - **关闭类恒在**（铁律 4 的旧口径）：无可作为时按下去由 `batchCloseEmptyReason`
 *   给一句人话；唯一的例外是「关闭已保存」——它按 `hasSaved` 灰着并明说原因
 *   （「没有已保存的标签」），因为这个动作「按下去什么都不会发生」是**可预判**的；
 * - **能力类缺失就整项不显示**：资源管理器（浏览器壳）、恢复关闭的标签（无命令通道）、
 *   复制相对路径（无项目根）都是「这台机器上没有这个能力」，不给幽灵入口；
 * - **文案不另造**：凡有命令的动作（关闭当前标签 / 恢复关闭的标签 / 向右 / 向下拆分）
 *   一律经 `menuItemFromCommand` 取中文标题与**生效键位**，菜单与命令面板同一份；
 * - 「在新编辑器组打开」没有独立命令，由「激活该标签 + 向右拆分」两个既有动作合成
 *   （拆分本身就把焦点组的激活标签带进新组），不新造业务逻辑。
 */
export function tabMenuItemsFor(facts: TabMenuFacts): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];

  // ---- 关闭类 ----
  const close = menuItemFromCommand('workbench.closeActiveTab', { id: 'close', label: '关闭' });
  if (close !== null) items.push(close);
  items.push(
    { id: 'close-others', label: '关闭其他标签' },
    { id: 'close-right', label: '关闭右侧标签' },
    facts.hasSaved
      ? { id: 'close-saved', label: '关闭已保存' }
      : {
          id: 'close-saved',
          label: '关闭已保存',
          disabled: true,
          disabledReason: CLOSE_SAVED_EMPTY_REASON,
        },
    { id: 'close-all', label: '关闭全部标签' },
  );
  if (facts.hasReopen) {
    // 标题即命令表里的「恢复关闭的标签」（不与命令面板造第二份文案）
    const reopen = menuItemFromCommand('workbench.reopenClosedTab', { id: 'reopen' });
    if (reopen !== null) items.push(reopen);
  }

  // ---- 固定 ----
  items.push({ id: 'toggle-pin', label: facts.pinned ? '取消固定' : '固定标签', dividerBefore: true });

  // ---- 复制 / 显示类 ----
  items.push({ id: 'copy-path', label: '复制路径', dividerBefore: true });
  if (facts.hasRoot) items.push({ id: 'copy-relative', label: '复制相对路径' });
  items.push({ id: 'copy-name', label: '复制文件名' });
  if (facts.canReveal) {
    items.push({ id: 'reveal', label: '在资源管理器中显示', icon: 'popout' });
  }

  // ---- 分屏 / 分组类 ----
  // 这一段的**段首分隔线**：「在新编辑器组打开」要命令通道，「移动到组」不要——
  // 两条此消彼长，所以由「谁先出现谁带」（下面那条 `canSplit` 判断）。
  if (facts.canSplit) {
    items.push({ id: 'open-in-new-group', label: '在新编辑器组打开', dividerBefore: true });
  }
  // 「移动到组」：动作来自宿主（App 的 moveTabBetweenGroups + editor-groups 纯函数），
  // 与命令通道无关；单组时灰着并说清原因，不给"按了没反应"的幽灵入口。
  items.push(moveToGroupMenuItem(facts, facts.canSplit ? {} : { dividerBefore: true }));
  const splitRight = runnableCommandItem('workbench.splitEditor', { id: 'split-right' }, facts.canSplit);
  if (splitRight !== null) items.push(splitRight);
  const splitDown = runnableCommandItem(
    'workbench.splitEditorDown',
    { id: 'split-down' },
    facts.canSplit,
  );
  if (splitDown !== null) items.push(splitDown);

  return items;
}

/**
 * 「移动到组」子菜单（1027 跨组批）。
 *
 * 子项 id 形如 `move-to-group:<目标组 id>`——目标组身份是宿主分配的 id，菜单不复制
 * 「第几组」的编号规则（label 由调用方按数组序给），也不把路径塞进 id（带盘符冒号）。
 */
function moveToGroupMenuItem(facts: TabMenuFacts, overrides: Partial<ContextMenuItem>): ContextMenuItem {
  const base: ContextMenuItem = { id: 'move-to-group', label: '移动到组', ...overrides };
  if (facts.otherGroups.length === 0) {
    return {
      ...base,
      disabled: true,
      disabledReason: '没有其他编辑器组（先向右或向下拆分）',
    };
  }
  return {
    ...base,
    children: facts.otherGroups.map((g) => ({ id: `move-to-group:${g.id}`, label: g.label })),
  };
}

/** 「移动到组」子项 id → 目标组 id（`null` = 不是该子菜单的子项 / 父项本身） */
export function moveToGroupTargetOf(id: string): string | null {
  const prefix = 'move-to-group:';
  if (!id.startsWith(prefix)) return null;
  const target = id.slice(prefix.length);
  return target === '' ? null : target;
}

/* --------------------- 右键菜单：标签栏空白区 / 编辑器组头（1023） --------------------- */

/** 标签栏空白区与编辑器组头共用的动作 id（两处问的是同一组问题，只是触发面不同） */
export type GroupMenuItemId =
  | 'split-right'
  | 'split-down'
  | 'close-group'
  | 'save-all'
  | 'close-group-tabs'
  | 'tab-list';

/** 标签列表子菜单里最多列几条（再多就不是菜单而是清单了，剩余条数如实说明） */
export const TAB_LIST_LIMIT = 20;

/** 标签列表子菜单项的固定前缀（含 CJK：中文化守卫不会把它整段丢掉） */
const TAB_LIST_PREFIX = '切换到 ';

/** 一次组级右键能看到的**事实** */
export interface GroupMenuFacts {
  /** 组总数（「关闭编辑器组」只在分屏时有意义） */
  readonly groupCount: number;
  /** 本组标签（按标签栏顺序；标签列表子菜单照它出项） */
  readonly tabs: readonly string[];
  /** 本组激活标签（打勾 + 批量关闭的锚点） */
  readonly active: string | null;
  readonly pinned: ReadonlySet<string>;
  /** 「关闭编辑器组」有落脚点（宿主回调和分屏同时在） */
  readonly canCloseGroup: boolean;
  /** 拆分命令可执行（不可执行 ⇒ 显示但禁用 + 原因） */
  readonly canSplit: boolean;
}

/**
 * 标签栏空白区 / 编辑器组头的菜单项（纯函数）。
 *
 * 顺序照批内约定：拆分（右/下）| 关闭组（仅分屏）| 全部保存 + 按组关闭 | 标签列表。
 * 「按组关闭」不自己算范围：可用性与禁用原因都由 `planBatchClose('all')` /
 * `batchCloseEmptyReason('all')` 给——固定标签不被批量清扫这条口径只此一份。
 */
export function groupMenuItemsFor(facts: GroupMenuFacts): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];

  const splitRight = runnableCommandItem(
    'workbench.splitEditor',
    { id: 'split-right' },
    facts.canSplit,
  );
  if (splitRight !== null) items.push(splitRight);
  const splitDown = runnableCommandItem(
    'workbench.splitEditorDown',
    { id: 'split-down' },
    facts.canSplit,
  );
  if (splitDown !== null) items.push(splitDown);

  // 单组不可关（关了就什么都没有了）⇒ 整项不显示；分屏中才给入口
  if (facts.canCloseGroup && facts.groupCount > 1) {
    const closeGroupItem = menuItemFromCommand('workbench.closeEditorGroup', {
      id: 'close-group',
      dividerBefore: true,
    });
    if (closeGroupItem !== null) items.push(closeGroupItem);
  }

  const saveAll = menuItemFromCommand('workbench.saveAll', { id: 'save-all', dividerBefore: true });
  if (saveAll !== null) items.push(saveAll);

  const anchor = facts.active ?? facts.tabs[0] ?? null;
  if (anchor !== null) {
    const closable = planBatchClose('all', facts.tabs, anchor, facts.pinned).toClose.length > 0;
    items.push(
      closable
        ? { id: 'close-group-tabs', label: '关闭本组全部标签' }
        : {
            id: 'close-group-tabs',
            label: '关闭本组全部标签',
            disabled: true,
            disabledReason: batchCloseEmptyReason('all', facts.tabs, anchor, facts.pinned),
          },
    );
  }

  items.push(tabListMenuItem(facts));
  return items;
}

/**
 * 「标签列表」子菜单（本组标签，点选即切换）。
 *
 * 子项 id 用**下标**（`tab-list:0`）而不是路径：路径里带盘符冒号，做 id 既难读又
 * 容易与 `tab-list:` 前缀的解析撞车；下标在同一次右键会话里恒对应同一枚标签。
 */
function tabListMenuItem(facts: GroupMenuFacts): ContextMenuItem {
  const base = { id: 'tab-list', label: '标签列表', dividerBefore: true } as const;
  if (facts.tabs.length === 0) {
    return { ...base, disabled: true, disabledReason: '本组还没有打开的标签' };
  }
  const shown = facts.tabs.slice(0, TAB_LIST_LIMIT);
  const children: ContextMenuItem[] = shown.map((p, i) => ({
    id: `tab-list:${i}`,
    label: `${TAB_LIST_PREFIX}${tabName(p)}`,
    ...(p === facts.active ? { checked: true } : {}),
  }));
  const rest = facts.tabs.length - shown.length;
  if (rest > 0) {
    children.push({ id: 'tab-list:rest', label: `还有 ${rest} 个标签未列出`, disabled: true, disabledReason: '子菜单只列前 20 个标签' });
  }
  return { ...base, children };
}

/** 标签列表子项 id → 下标（`null` = 不是可点的列表项） */
export function tabListIndexOf(id: string): number | null {
  if (!id.startsWith('tab-list:')) return null;
  const raw = id.slice('tab-list:'.length);
  if (!/^\d+$/.test(raw)) return null;
  const index = Number(raw);
  return Number.isSafeInteger(index) ? index : null;
}

/**
 * 命令 → 菜单项，命令不可执行时补禁用原因（命令根本不存在 ⇒ 返回 null，调用方整项不显示）。
 * 与兜底菜单 `commandItemForFallback` 同一口径：不假装能按，也不静默消失。
 */
function runnableCommandItem(
  commandId: string,
  overrides: Partial<ContextMenuItem>,
  runnable: boolean,
): ContextMenuItem | null {
  const item = menuItemFromCommand(commandId, overrides);
  if (item === null) return null;
  return runnable ? item : { ...item, disabled: true, disabledReason: '未打开项目或命令未就绪' };
}

/* ------------------------------ 渲染辅助 ------------------------------ */

/** 标签显示名：路径末段（完整路径留 title 悬浮提示；菜单的标签列表子菜单也用它） */
export function tabName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** 标签的落点指示（拖拽重排时） */
export interface TabDropHint {
  readonly path: string;
  readonly before: boolean;
}

/** 标签 className（纯函数）：活动 / 固定 / 预览 / 落点指示四态可叠加（活动+落点 = 双指示） */
export function tabClassName(
  p: string,
  active: boolean,
  pinned: boolean,
  dropAt: TabDropHint | null,
  preview = false,
): string {
  return [
    'editor-tab',
    active ? 'active' : '',
    pinned ? 'pinned' : '',
    // 预览态（VS Code 同款斜体）：它与 pinned 是两回事——pinned 是"钉住不随批量关"，
    // preview 是"这次只是浏览"，两者可以同时为真（作者中途改过它 ⇒ 转正但仍是预览位）
    preview ? 'preview' : '',
    dropAt?.path === p ? (dropAt.before ? 'drop-before' : 'drop-after') : '',
  ]
    .filter(Boolean)
    .join(' ');
}
