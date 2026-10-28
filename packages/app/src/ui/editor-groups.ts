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

/**
 * 真另存为的**组态随迁**（1028 批；纯函数）：每组里指向 `from` 的标签/激活/预览逐条换成 `to`
 * （**精确换**，不走前缀）。与改名的 `mapRenamedPath` 刻意不同：另存为是"buffer 转档、
 * 原盘文件不动"，账目 = 当前标签跟到新路径继续编辑，**不是**两格合一。未命中返回同一引用。
 */
export function migrateGroupPathsAfterSaveAs(
  state: EditorGroupsState,
  from: string,
  to: string,
): EditorGroupsState {
  if (from === to) return state;
  let touched = false;
  const groups = state.groups.map((g) => {
    if (!g.tabs.includes(from) && g.active !== from && g.preview !== from) return g;
    touched = true;
    return {
      ...g,
      tabs: g.tabs.map((t) => (t === from ? to : t)),
      active: g.active === from ? to : g.active,
      preview: g.preview === from ? to : g.preview ?? null,
    };
  });
  return touched ? { ...state, groups } : state;
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

/* ---------------- WS-14：按排列序聚焦组 / 组间切换 ----------------
 *
 * 键位对标 VS Code 的 `Ctrl+1/2/3`（聚焦第 n 个编辑器组）。**序号 = 排列序**（数组下标，
 * 0 基）而不是 id：id 是创建序，拆分/关组后两者会分叉，而作者看到的"左边那格"永远是排列序。
 */

/** 焦点组在排列序里的下标（防御式：`activeGroupId` 对不上任何组 ⇒ 0，与 `activeGroupOf` 同兜底） */
export function activeGroupOrdinal(state: EditorGroupsState): number {
  const i = state.groups.findIndex((g) => g.id === state.activeGroupId);
  return i < 0 ? 0 : i;
}

/**
 * 按排列序聚焦某一组（`Ctrl+1/2/3…`）。
 *
 * 没有这一组 ⇒ 返回**同一个引用**：按到不存在的组就是没按——不该把焦点从当前组身上挪走，
 * 也不该造一个新对象让会话落盘白拍一帧（`groupsLayoutSignature` 靠身份之外的签名，
 * 但状态更新本身仍是每帧的活）。
 */
export function focusGroupAtOrdinal(state: EditorGroupsState, ordinal: number): EditorGroupsState {
  const target = state.groups[ordinal];
  if (target === undefined) return state;
  return setActiveGroup(state, target.id);
}

/**
 * 组间焦点切换（环形）：`delta = +1` 下一组 / `-1` 上一组。
 *
 * 单组 ⇒ 同一引用（没有"隔壁"可去）。命令侧在此之前已经判过组数并给人话提示，
 * 这里的不动状态只是把"按了也没用"落到数据面上。
 */
export function cycleActiveGroup(state: EditorGroupsState, delta: number): EditorGroupsState {
  const count = state.groups.length;
  if (count < 2 || !Number.isFinite(delta) || delta === 0) return state;
  const cur = activeGroupOrdinal(state);
  const step = Math.trunc(delta) % count;
  const next = (cur + step + count) % count;
  return focusGroupAtOrdinal(state, next);
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
 * 组态的**布局签名**（WS-06：会话落盘的依赖判据）。
 *
 * 覆盖 `serializeGroups` 的全部持久化字段（方向 / 焦点组 / 每组 id、激活、标签序），
 * 而不用对象身份做依赖：`setEditorGroups` 每次都给新对象，拿它当 effect 依赖等于
 * "每帧都算变了"——签名相等才是真的没变（焦点、方向、组结构单独变化时才落盘）。
 *
 * 分隔符用控制字符：路径里不会出现，标签拼接不会造出假命中。
 */
export function groupsLayoutSignature(state: EditorGroupsState): string {
  return [
    state.orientation,
    state.activeGroupId,
    state.groups
      .map((g) => `${g.id}\u0001${g.active ?? ''}\u0001${g.tabs.join('\u0002')}`)
      .join('\u0003'),
  ].join('\u0004');
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


/* ================= 分屏比例（WS-06：会话恢复完整批） =================
 *
 * 为什么住在这里而不是单开模块：分屏比例就是**组态的一部分**（组数 - 1 条分隔条），
 * 而且三个消费方（session-store 持久化 / App 状态 / ProjectView 渲染）都要这同一把尺子。
 * 单开会多一枚文件进开机静态图（`ps10-eager-graph` 的文件闸顶格零余量），
 * 规则本身也没有独立存在的必要。
 *
 * 编码口径（每条都有单测钉着）：
 * - 数组长度 = 组数 - 1：`sizes[i]` 是**第 i 组**占的份额，**最后一组吃剩余**
 *   （`1 - Σ sizes`）——与「n 组有 n-1 条分隔条」一一对应，单组 = 空数组；
 * - 每个份额夹在 `[SPLIT_MIN_RATIO, 1 - SPLIT_MIN_RATIO]` 且总和 ≤ `1 - SPLIT_MIN_RATIO`
 *   （保证最后一组至少剩一成；CSS 里还有 200px / 120px 的最小尺寸兜底，这里是数据面同款闸）；
 * - **损坏容忍**：形状不对（非数组 / 长度不符 / 有非有限数或非正数）一律回 `null`，
 *   由调用方退回均分——会话数据丢了可以重开，绝不能炸启动（与 `sanitizeSessionRecord` 同门风）。
 */

/** 单条份额的下限（两组各至少留一成，避免拖出"看不见的组"） */
export const SPLIT_MIN_RATIO = 0.1;

/** 单组（没有分隔条）的恒等空数组（引用恒定，别每帧造新数组） */
export const EMPTY_SPLIT_SIZES: readonly number[] = [];

/** 均分份额（组数 ≤ 1 ⇒ 空数组） */
export function equalSplitSizes(groupCount: number): readonly number[] {
  if (!Number.isFinite(groupCount) || groupCount < 2) return EMPTY_SPLIT_SIZES;
  const size = 1 / groupCount;
  return Array.from({ length: groupCount - 1 }, () => size);
}

const EPS = 1e-6;

/** 一条份额数组是否已经是合法归一形态（长度对、逐条在区间内、剩余够最后一组） */
function isNormalizedSizes(raw: unknown, count: number): raw is readonly number[] {
  if (!Array.isArray(raw) || raw.length !== count) return false;
  let sum = 0;
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    if (v < SPLIT_MIN_RATIO - EPS || v > 1 - SPLIT_MIN_RATIO + EPS) return false;
    sum += v;
  }
  return sum > 0 && sum <= 1 - SPLIT_MIN_RATIO + EPS;
}

/**
 * 校验并归一化一条份额数组（**损坏容忍**）。
 *
 * @param raw        盘上 / 外部给的原值
 * @param groupCount 当前的组数（份额长度必须恰为 `groupCount - 1`）
 * @returns 归一化后的新数组；组数 ≤ 1、长度不符、含非法条目 ⇒ null
 */
export function sanitizeSplitSizes(raw: unknown, groupCount: number): number[] | null {
  if (!Number.isFinite(groupCount) || groupCount < 2) return null;
  if (!Array.isArray(raw) || raw.length !== groupCount - 1) return null;
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
    out.push(Math.max(SPLIT_MIN_RATIO, Math.min(1 - SPLIT_MIN_RATIO, v)));
  }
  const sum = out.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  // 总和超过「最后一组的下限预算」⇒ 等比缩回（末组恰好留 SPLIT_MIN_RATIO）
  const budget = 1 - SPLIT_MIN_RATIO;
  if (sum > budget) {
    const k = budget / sum;
    for (let i = 0; i < out.length; i++) out[i] = out[i]! * k;
  }
  return out;
}

/**
 * 组数变化时的长度对齐（App / ProjectView 共用）。
 *
 * 策略（刻意简单、可预期）：
 * - 组数 ≤ 1 ⇒ 空数组；
 * - 旧份额合法且长度正好对上 ⇒ 原样沿用（**引用也沿用**，避免无谓的 setState 抖动）；
 * - **长度对不上（拆分 / 关组 / 恢复到别的组数）⇒ 整份退回均分**——不把旧比例
 *   硬套到新组上：我们并不知道作者是从哪一组拆出来的，"猜一半留一半"只会让某组
 *   无端变窄；均分是唯一不撒谎的缺省。
 */
export function alignSplitSizes(
  prev: readonly number[] | null | undefined,
  groupCount: number,
): readonly number[] {
  if (!Number.isFinite(groupCount) || groupCount < 2) return EMPTY_SPLIT_SIZES;
  if (prev !== null && prev !== undefined && isNormalizedSizes(prev, groupCount - 1)) return prev;
  return sanitizeSplitSizes(prev, groupCount) ?? equalSplitSizes(groupCount);
}

/** 第 `index` 组占的份额（末组吃剩余）；组数/下标越界 ⇒ 均分兜底值 */
export function groupShareOf(
  sizes: readonly number[] | null | undefined,
  groupCount: number,
  index: number,
): number {
  const list = alignSplitSizes(sizes, groupCount);
  if (index >= 0 && index < list.length) return list[index]!;
  const last = 1 - list.reduce((a, b) => a + b, 0);
  return last > 0 ? last : 1 / Math.max(1, groupCount);
}

/** 渲染侧的 flex 简写（`1 1 <pct>%`：可涨可缩，基准 = 归一份额） */
export function splitFlexOf(ratio: number): string {
  const pct = Number.isFinite(ratio) && ratio > 0 ? ratio * 100 : 0;
  return `1 1 ${pct.toFixed(4)}%`;
}

/**
 * 拖拽落定时的**像素 → 份额**换算：按各组实际宽度（column 下是高度）占比归一。
 * 最后一段总是"剩余"，故只取前 n-1 组的占比；分隔条自身的 4px 不计入（只量组）。
 * 全部量不出来（元素都卸了）⇒ 空数组（调用方保持现状）。
 */
export function splitSizesFromWidths(widths: readonly number[]): readonly number[] {
  const usable = widths.map((w) => (typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 0));
  if (usable.length < 2) return EMPTY_SPLIT_SIZES;
  const total = usable.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return EMPTY_SPLIT_SIZES;
  const raw = usable.slice(0, usable.length - 1).map((w) => w / total);
  return sanitizeSplitSizes(raw, usable.length) ?? equalSplitSizes(usable.length);
}

/**
 * 全组坐标的份额 → **会被恢复的那些组**的坐标（WS-06 落盘前的换算）。
 *
 * 为什么需要这一步：`restoreGroups` 会把空组过滤掉（渲染层不需要空组占位），
 * 而"拆一个新的空组"恰恰是最常见的分屏形态。若把全组份额直接入库，恢复时组数
 * 对不上（3 组里有 1 组空 ⇒ 恢复出 2 组）⇒ 校验失败、比例整份丢掉；
 * 用户拖过的比例就这么在一次重启后消失。
 *
 * 这里按"哪几组有标签"（空组会被 restoreGroups 剔掉）把份额投影到存活组，
 * 再归一到「存活组的末组吃剩余」口径——入库的份额与恢复出的组数始终一一对应。
 *
 * @param sizes     全组坐标的份额（长度 = 组数 - 1；末组吃剩余）
 * @param groupTabs 各组标签表（只用来判"这一组是不是空的"；判据与 restoreGroups 同向）
 * @returns 存活组坐标的份额；存活组 < 2 或无有效份额 ⇒ null（没有可恢复的比例）
 */
export function splitSizesForKeptGroups(
  sizes: readonly number[] | null | undefined,
  groupTabs: readonly (readonly string[])[],
): number[] | null {
  const rawCount = groupTabs.length;
  if (rawCount < 2) return null;
  // 份额必须是**全组坐标**那份（长度 = 全组数 - 1）：缺省 / 长度不符都说明调用方
  // 给的不是这一拍的布局，投影出去只会造一份假比例 ⇒ 宁可 null（恢复时均分）。
  if (sizes === null || sizes === undefined || sizes.length !== rawCount - 1) return null;
  const kept: number[] = [];
  groupTabs.forEach((tabs, i) => {
    if (tabs.some((t) => typeof t === 'string' && t !== '')) kept.push(i);
  });
  if (kept.length < 2) return null;
  const shares = kept.map((i) => groupShareOf(sizes, rawCount, i));
  const total = shares.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  // 前 n-1 条入库（末组在恢复时吃剩余），与 `sanitizeSplitSizes` 的长度口径一致
  const normalized = shares.map((s) => s / total);
  return sanitizeSplitSizes(normalized.slice(0, kept.length - 1), kept.length);
}

/** 两条份额是否等价（长度 + 逐条容差）；用于"值没变就不 setState" */
export function splitSizesEqual(
  a: readonly number[] | null | undefined,
  b: readonly number[] | null | undefined,
): boolean {
  const x = a ?? EMPTY_SPLIT_SIZES;
  const y = b ?? EMPTY_SPLIT_SIZES;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]! - y[i]!) > EPS) return false;
  return true;
}

/**
 * 键盘调分隔条的一步（份额的 4%）。
 *
 * 为什么是这个数：一次鼠标拖拽通常跨 10–30%，键盘一下走 4% ⇒ 从均分到"明显偏一边"
 * 约 5–8 下，与主流编辑器键盘调整同量级。再小是按半天看不出动静，再大是一步过头收不回来。
 */
export const SPLIT_KEYBOARD_STEP = 0.04;

/**
 * 键盘调整某一组的份额（WS-14：分隔条只有鼠标能拖的那半欠账）。
 *
 * 坐标系与 `splitSizes` 逐字一致：长度 = 组数 - 1，`sizes[i]` 是第 i 组份额，
 * **最后一组吃剩余**。所以"改一组的大小"= 与它的邻居**交换**份额：
 * - 焦点组不是最后一组 ⇒ 动它**右边**那条分隔条（与下一组换）；是最后一组 ⇒ 动左边那条。
 *   单侧而不是两侧同推：两侧推一下的位移是预期的两倍，作者按一下就"跳过头"。
 * - 末组不在数组里（吃剩余），所以只写数组内那一侧，另一侧自动跟着变。
 *
 * 钳制与数据面同款闸：供给方不许跌破 `SPLIT_MIN_RATIO`（一成），合法兜底再由
 * `isNormalizedSizes` 复验一次——**非法一律回 null**，不把坏数组交给渲染层。
 *
 * @returns 新的份额数组；没有可挪的份额（贴到下限 / 单组 / 参数非法）⇒ null
 *          （调用方据此说人话，并避免一次白 setState 与一轮会话落盘）
 */
export function resizeGroupShare(
  sizes: readonly number[] | null | undefined,
  groupCount: number,
  ordinal: number,
  delta: number,
  step: number = SPLIT_KEYBOARD_STEP,
): number[] | null {
  if (!Number.isFinite(groupCount) || groupCount < 2) return null;
  if (!Number.isFinite(delta) || delta === 0) return null;
  if (!Number.isFinite(step) || step <= 0) return null;
  const n = Math.trunc(groupCount);
  const base = [...alignSplitSizes(sizes, n)] as number[];
  const i = Math.max(0, Math.min(n - 1, Math.trunc(ordinal)));
  const partner = i < n - 1 ? i + 1 : i - 1;
  const grow = delta > 0 ? i : partner;
  const shrink = delta > 0 ? partner : i;
  const room = groupShareOf(base, n, shrink) - SPLIT_MIN_RATIO;
  const amount = Math.min(step, Math.max(0, room));
  if (!(amount > EPS)) return null;
  const out = [...base];
  if (grow <= n - 2) out[grow] = out[grow]! + amount;
  if (shrink <= n - 2) out[shrink] = out[shrink]! - amount;
  return isNormalizedSizes(out, n - 1) ? out : null;
}
