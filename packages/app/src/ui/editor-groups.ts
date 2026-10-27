/**
 * 编辑器组态（SPLIT-1 分屏批 + MM-9 布局持久化批）：VSCode 式编辑器组的**纯逻辑**。
 *
 * 零 React、零 Monaco、零内核——组态的全部规则住在这里并单测钉死：
 * - 拆分（向右 / 向下）：新组携带当前组的激活标签（VSCode 同款），焦点跟到新组；
 * - 关标签：激活落右侧邻居（末尾则左侧）；组空且不是唯一组 ⇒ 整组回收（组空即收）；
 * - 关组：唯一组不许关（UI 不出这个入口）；关掉的是焦点组 ⇒ 焦点落邻居组；
 * - 排列方向（MM-9）：row = 左右并排（缺省），column = 上下堆叠（长口上下对照）；
 * - 持久化往返（MM-9）：serialize / restore 纯数据可 JSON 化，损坏容忍。
 *
 * App 是唯一的状态所有者（`groups` + `activeGroupId` + `orientation` 三块 state），
 * 这里只提供「给一份旧态 + 一个意图 ⇒ 返回一份新态」的纯函数——与
 * `editor-groups.test.ts` 的闭环口径一一对应。
 */
import { clampIndexToPinZone, planPreviewOpen } from './tabs-ops';

/** 一个编辑器组：自己的标签栈 + 组内激活标签 */
export interface EditorGroupState {
  readonly id: string;
  /** 本组打开的标签（顺序即标签栏顺序） */
  readonly tabs: readonly string[];
  /** 本组激活的标签（null = 空组） */
  readonly active: string | null;
  /**
   * 本组的**预览标签**（1020 编辑器体感批；VS Code 的"单击浏览"那一份语义）。
   *
   * 每组至多一枚，且必须是 `tabs` 里的一条（否则一律按"没有预览"处理，不猜）。
   * 它是**会话态**、比 pin 更 ephemeral：不进 `serializeGroups` 的快照，
   * 恢复会话时所有标签都按普通标签回来——"上次只是瞄一眼"这个事实不值得跨会话保留。
   */
  readonly preview?: string | null;
}

/** 排列方向（MM-9）：row = 左右并排（VSCode 默认），column = 上下堆叠 */
export type GroupsOrientation = 'row' | 'column';

/** 全部组 + 焦点组 id（恒指向 groups 里存在的那一组）+ 排列方向 */
export interface EditorGroupsState {
  readonly groups: readonly EditorGroupState[];
  readonly activeGroupId: string;
  /**
   * 排列方向（MM-9）。**数组序即排列序**：groups 的下标序就是渲染排列序——
   * row 从左到右、column 从上到下；两个拆分函数在数组上的插入动作完全一样
   * （都插在焦点组之后），排成横排还是竖列只由这个字段决定。
   */
  readonly orientation: GroupsOrientation;
}

let groupSeq = 0;
const nextGroupId = (): string => `eg-${++groupSeq}`;

/** 初始态：单组空栈（开项目 / 重置时用）；排列方向缺省 row（现状左右并排） */
export function initialEditorGroups(): EditorGroupsState {
  const id = nextGroupId();
  return { groups: [{ id, tabs: [], active: null }], activeGroupId: id, orientation: 'row' };
}

/** 焦点组（activeGroupId 恒有效；防御式兜底取第一组） */
export function activeGroupOf(state: EditorGroupsState): EditorGroupState {
  return state.groups.find((g) => g.id === state.activeGroupId) ?? state.groups[0]!;
}

/** 组内激活邻居：右侧优先、末尾回落左侧（与既有 closeManySync 的落点口径一致） */
function neighborOf(tabs: readonly string[], removed: ReadonlySet<string>, cur: string | null): string | null {
  if (cur === null || !removed.has(cur)) return cur;
  const i = tabs.indexOf(cur);
  const remaining = tabs.filter((p) => !removed.has(p));
  if (remaining.length === 0) return null;
  const removedBefore = tabs.slice(0, i).filter((p) => removed.has(p)).length;
  const j = Math.min(i - removedBefore, remaining.length - 1);
  return remaining[j] ?? null;
}

/** 焦点组的邻居组 id：右侧优先、末尾回落左侧 */
function neighborGroupId(state: EditorGroupsState, groupId: string): string {
  const i = state.groups.findIndex((g) => g.id === groupId);
  const remaining = state.groups.filter((g) => g.id !== groupId);
  if (remaining.length === 0) return groupId; // 唯一组：调用方保证不会走到
  const j = Math.min(i, remaining.length - 1);
  return remaining[j < 0 ? 0 : j]!.id;
}

/**
 * 在**焦点组**打开文件：无则追加到标签栈尾，并激活。
 *
 * 永久打开这一条路上顺手清预览态：如果这文件正以预览态开着（作者从别处跳进同一份），
 * 它就该转正——预览是"只是瞄一眼"，被显式打开第二次就不再是瞄一眼（与 VS Code 同口径）。
 */
export function openInActiveGroup(state: EditorGroupsState, path: string): EditorGroupsState {
  return {
    ...state,
    groups: state.groups.map((g) =>
      g.id === state.activeGroupId
        ? {
            ...g,
            tabs: g.tabs.includes(path) ? g.tabs : [...g.tabs, path],
            active: path,
            preview: g.preview === path ? null : g.preview ?? null,
          }
        : g,
    ),
  };
}

/**
 * 在**焦点组**以预览态打开文件（`previewIsDirty` 由宿主给：脏的预览标签绝不替换，
 * 作者改过的东西不能因为"又点了一下文件树"就没了）。规则本体在 `tabs-ops.planPreviewOpen`，
 * 这里只把它落到组态上——两处各写一份替换规则必漂。
 */
export function openPreviewInActiveGroup(
  state: EditorGroupsState,
  path: string,
  previewIsDirty: (path: string) => boolean,
): EditorGroupsState {
  const g = activeGroupOf(state);
  const plan = planPreviewOpen(g.tabs, g.preview ?? null, path, previewIsDirty);
  return {
    ...state,
    groups: state.groups.map((x) =>
      x.id !== g.id
        ? x
        : { ...x, tabs: plan.tabs, active: path, preview: plan.preview },
    ),
  };
}

/** 把某组的预览标签转正（点标签本身 = 显式要用它，此后它不再被预览替换掉） */
export function pinPreviewInGroup(state: EditorGroupsState, groupId: string, path: string): EditorGroupsState {
  const g = state.groups.find((x) => x.id === groupId);
  if (!g || g.preview !== path) return state;
  return { ...state, groups: state.groups.map((x) => (x.id === groupId ? { ...x, preview: null } : x)) };
}

/** 激活某组里的某标签（标签必须已在栈内；否则原样返回——不凭空造标签） */
export function activateTab(state: EditorGroupsState, groupId: string, path: string): EditorGroupsState {
  const target = state.groups.find((g) => g.id === groupId);
  if (!target || !target.tabs.includes(path)) return state;
  // 点标签本身 = 显式要用它（与 VS Code 同口径）：预览态在这一拍转正
  const preview = target.preview === path ? null : target.preview ?? null;
  return {
    ...state,
    activeGroupId: groupId,
    groups: state.groups.map((g) => (g.id === groupId ? { ...g, active: path, preview } : g)),
  };
}

/**
 * 在某组内一次关掉若干标签（批量关闭的地基，语义与旧 `closeManySync` 一致）：
 * - 过滤掉栈内的目标标签；
 * - 组内激活落在被关活动标签的右邻居（末尾则左）；
 * - 组空且不是唯一组 ⇒ 整组回收；回收的是焦点组 ⇒ 焦点落邻居组。
 * 调用方（App）负责 dirtyPaths / pinned 的连带清理。
 */
export function closeTabsInGroup(
  state: EditorGroupsState,
  groupId: string,
  paths: readonly string[],
): EditorGroupsState {
  const gone = new Set(paths);
  const target = state.groups.find((g) => g.id === groupId);
  if (!target || !target.tabs.some((p) => gone.has(p))) return state;

  const remainingTabs = target.tabs.filter((p) => !gone.has(p));
  const nextActive = neighborOf(target.tabs, gone, target.active);
  const groupEmpty = remainingTabs.length === 0;
  const dropGroup = groupEmpty && state.groups.length > 1;

  let groups = state.groups.map((g): EditorGroupState => {
    if (g.id !== groupId) return g;
    // 预览标签被关掉了 ⇒ 预览态一起销账（留着一条不在栈里的预览 = 下一次点开替换不到东西）
    if (dropGroup) return g;
    const preview = g.preview != null && gone.has(g.preview) ? null : g.preview ?? null;
    return { ...g, tabs: remainingTabs, active: nextActive, preview };
  });
  if (dropGroup) groups = groups.filter((g) => g.id !== groupId);

  let activeGroupId = state.activeGroupId;
  if (dropGroup && state.activeGroupId === groupId) activeGroupId = neighborGroupId({ ...state, groups }, groupId);
  return { groups, activeGroupId, orientation: state.orientation };
}

/**
 * 向右拆分（VSCode 同款）：新组插在焦点组右侧，携带焦点组当前激活标签；
 * 焦点跟到新组（用户拆分就是为了立刻用第二栏）。
 *
 * 列序 = 排列序（MM-9）：数组下标序就是渲染排列序（row 从左到右、column 从上到下），
 * 所以本函数与 splitActiveDown 在数组上的插入动作完全一样（都插在焦点组之后），
 * 视觉上左右还是上下只由 orientation 决定——两函数共用同一段插位逻辑。
 */
export function splitActiveRight(state: EditorGroupsState): EditorGroupsState {
  const cur = activeGroupOf(state);
  const carried = cur.active;
  const id = nextGroupId();
  const i = state.groups.findIndex((g) => g.id === cur.id);
  const fresh: EditorGroupState = { id, tabs: carried ? [carried] : [], active: carried };
  const groups = [...state.groups.slice(0, i + 1), fresh, ...state.groups.slice(i + 1)];
  return { groups, activeGroupId: id, orientation: state.orientation };
}

/**
 * 向下拆分（MM-9）：与 splitActiveRight 同款语义（新组携带焦点组当前激活标签、
 * 焦点跟到新组），插在焦点组**下方**——长文件上下对照场景的解。
 * 方向渲染由 orientation 决定；这里只保证「数组序 = 排列序」这一条不变量
 * （row 从左到右、column 从上到下，见 EditorGroupsState.orientation 注释）。
 */
export function splitActiveDown(state: EditorGroupsState): EditorGroupsState {
  const cur = activeGroupOf(state);
  const carried = cur.active;
  const id = nextGroupId();
  const i = state.groups.findIndex((g) => g.id === cur.id);
  const fresh: EditorGroupState = { id, tabs: carried ? [carried] : [], active: carried };
  const groups = [...state.groups.slice(0, i + 1), fresh, ...state.groups.slice(i + 1)];
  return { groups, activeGroupId: id, orientation: state.orientation };
}

/**
 * 翻排列方向（MM-9）：只翻方向，组与激活原样不动（同值原样返回同一引用，
 * 不给 React 制造无谓重渲染）。单组时翻了也看不出来——由调用方（命令侧）拒。
 */
export function setGroupsOrientation(
  state: EditorGroupsState,
  orientation: GroupsOrientation,
): EditorGroupsState {
  if (state.orientation === orientation) return state;
  return { ...state, orientation };
}

/** 关组：唯一组不关（原样返回）；关焦点组 ⇒ 焦点落邻居组 */
export function closeGroup(state: EditorGroupsState, groupId: string): EditorGroupsState {
  if (state.groups.length <= 1) return state;
  const target = state.groups.find((g) => g.id === groupId);
  if (!target) return state;
  const groups = state.groups.filter((g) => g.id !== groupId);
  const activeGroupId = state.activeGroupId === groupId ? neighborGroupId(state, groupId) : state.activeGroupId;
  return { groups, activeGroupId, orientation: state.orientation };
}

/**
 * 把一枚标签从一组**搬到**另一组（1027 跨组批：拖拽标签到别组 / 右键「移动到组」）。
 *
 * 规则（每条都有单测钉着）：
 * - 两组合法、from ≠ to、path 在源组；任一不成立 ⇒ 原样返回同一引用（调用方可跳过 setState）；
 * - 目标组**已有**同路径：不重复造标签——源组移除，目标组把它激活（一份文件两条标签是假象）；
 * - 保持「固定区在前」：插入下标经 `clampIndexToPinZone` 钳进被移动标签所属的那一段
 *   （固定 ⇄ 固定区、非固定 ⇄ 非固定区；**显式移动不改固定态**，改态只发生在组内拖拽跨分界）；
 * - 源组激活标签被搬走 ⇒ 落右邻居 / 末尾左邻（复用 `neighborOf`）；
 * - 源组变空**不回收**：移动不是关闭，作者还要能拖回来（关空的回收只属于 closeTabsInGroup）；
 * - 移动即显式使用：源组的预览态清空，目标组不把它设成预览（拖/右键 = 转正）；
 * - 焦点跟到目标组，目标组激活 = 被移动标签。
 */
export function moveTabBetweenGroups(
  state: EditorGroupsState,
  path: string,
  fromGroupId: string,
  toGroupId: string,
  toIndex: number,
  pinned: ReadonlySet<string>,
): EditorGroupsState {
  if (fromGroupId === toGroupId) return state;
  const from = state.groups.find((g) => g.id === fromGroupId);
  const to = state.groups.find((g) => g.id === toGroupId);
  if (!from || !to || !from.tabs.includes(path)) return state;

  const remaining = from.tabs.filter((p) => p !== path);
  const gone = new Set([path]);
  const fromActive = neighborOf(from.tabs, gone, from.active);
  // 预览是"只是瞄一眼"：被显式搬走 = 转正（源组不再留预览，目标组也不接这一态）
  const fromPreview = from.preview === path ? null : from.preview ?? null;

  let toTabs: readonly string[];
  if (to.tabs.includes(path)) {
    toTabs = to.tabs;
  } else {
    const at = clampIndexToPinZone(to.tabs, toIndex, pinned.has(path), pinned);
    const next = [...to.tabs];
    next.splice(at, 0, path);
    toTabs = next;
  }

  const groups = state.groups.map((g): EditorGroupState => {
    if (g.id === fromGroupId) return { ...g, tabs: remaining, active: fromActive, preview: fromPreview };
    if (g.id === toGroupId) {
      return { ...g, tabs: toTabs, active: path, preview: g.preview === path ? null : g.preview ?? null };
    }
    return g;
  });
  return { groups, activeGroupId: toGroupId, orientation: state.orientation };
}

/** 焦点切换（点击某组任意处 / 命令聚焦） */
export function setActiveGroup(state: EditorGroupsState, groupId: string): EditorGroupsState {
  if (!state.groups.some((g) => g.id === groupId) || state.activeGroupId === groupId) return state;
  return { ...state, activeGroupId: groupId };
}

/* ------------ 持久化往返（MM-9 编辑器组布局落盘） ------------ */

/** 序列化产物里的一组（纯数据、可 JSON 化；id 一并存下，见 restoreGroups 的重新分配说明） */
export interface GroupsSnapshotGroup {
  id: string;
  tabs: string[];
  active: string | null;
}

/** 序列化产物（session-store 的 `groups` 字段形状）：纯数据，JSON 往返不丢信息 */
export interface GroupsSnapshot {
  orientation: GroupsOrientation;
  activeGroupId: string;
  groups: GroupsSnapshotGroup[];
}

/** 组态 ⇒ 快照（纯拷贝；调用方负责 JSON 化落盘） */
export function serializeGroups(state: EditorGroupsState): GroupsSnapshot {
  return {
    orientation: state.orientation,
    activeGroupId: state.activeGroupId,
    groups: state.groups.map((g) => ({ id: g.id, tabs: [...g.tabs], active: g.active })),
  };
}

/**
 * 快照 ⇒ 组态（MM-9）：**损坏容忍**——任何不合法形态回 null，由调用方维持现状
 * （会话数据丢了可以重开，绝不能炸启动——与 sanitizeSessionRecord 同一门风）。
 * 规则：
 * - orientation 必须是 'row' | 'column'，groups 必须是数组，否则回 null；
 * - 过滤空 tabs 的组，但保证至少剩一组；全空 ⇒ 回 null；
 * - activeGroupId 指**盘上的旧 id**：按旧 id 找下标，无效（缺字段/类型错/对不上）
 *   ⇒ 落第一组；
 * - tabs 去重保序、剔掉非字符串空串条目；active 必须在 tabs 内，否则回落 tabs[0]；
 * - **重新分配 id**（`eg-N` 继续递增，绝不复用盘上的旧 id）：盘上的 id 只当
 *   「排序 + 谁是焦点」的信息用，不当身份用——若照搬旧 id，与本次会话后续
 *   split 新产的 id 撞号会让 setActiveGroup / groupRefs 表张冠李戴；重新分配
 *   后恢复态与后续新建的组天然异号，混用安全。
 */
export function restoreGroups(raw: unknown): EditorGroupsState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const orientation: unknown = r.orientation;
  if (orientation !== 'row' && orientation !== 'column') return null;
  if (!Array.isArray(r.groups)) return null;
  const drafts: Array<{ oldId: unknown; tabs: string[]; active: string }> = [];
  for (const item of r.groups) {
    if (typeof item !== 'object' || item === null) continue;
    const g = item as Record<string, unknown>;
    if (!Array.isArray(g.tabs)) continue;
    const tabs: string[] = [];
    for (const t of g.tabs) {
      if (typeof t !== 'string' || t === '') continue;
      if (tabs.includes(t)) continue;
      tabs.push(t);
    }
    if (tabs.length === 0) continue; // 空组过滤（渲染层不需要空组占位）
    const active = typeof g.active === 'string' && tabs.includes(g.active) ? g.active : tabs[0]!;
    drafts.push({ oldId: g.id, tabs, active });
  }
  if (drafts.length === 0) return null; // 全空 ⇒ 回 null，调用方维持现状
  // 重新分配 id：eg-N 继续递增，绝不复用盘上的旧 id（防与后续 split 撞号，见上面注释）
  const groups: EditorGroupState[] = drafts.map((d) => ({ id: nextGroupId(), tabs: d.tabs, active: d.active }));
  const focusIdx = drafts.findIndex((d) => typeof d.oldId === 'string' && d.oldId === r.activeGroupId);
  const activeGroupId = groups[focusIdx >= 0 ? focusIdx : 0]!.id;
  return { groups, activeGroupId, orientation };
}
