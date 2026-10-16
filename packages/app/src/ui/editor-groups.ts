/**
 * 编辑器组态（SPLIT-1 分屏批）：VSCode 式编辑器组的**纯逻辑**。
 *
 * 零 React、零 Monaco、零内核——组态的全部规则住在这里并单测钉死：
 * - 拆分（向右）：新组携带当前组的激活标签（VSCode 同款），焦点跟到新组；
 * - 关标签：激活落右侧邻居（末尾则左侧）；组空且不是唯一组 ⇒ 整组回收（组空即收）；
 * - 关组：唯一组不许关（UI 不出这个入口）；关掉的是焦点组 ⇒ 焦点落邻居组。
 *
 * App 是唯一的状态所有者（`groups` + `activeGroupId` 两块 state），这里只提供
 * 「给一份旧态 + 一个意图 ⇒ 返回一份新态」的纯函数——与 `editor-groups.test.ts`
 * 的闭环口径一一对应。
 */

/** 一个编辑器组：自己的标签栈 + 组内激活标签 */
export interface EditorGroupState {
  readonly id: string;
  /** 本组打开的标签（顺序即标签栏顺序） */
  readonly tabs: readonly string[];
  /** 本组激活的标签（null = 空组） */
  readonly active: string | null;
}

/** 全部组 + 焦点组 id（恒指向 groups 里存在的那一组） */
export interface EditorGroupsState {
  readonly groups: readonly EditorGroupState[];
  readonly activeGroupId: string;
}

let groupSeq = 0;
const nextGroupId = (): string => `eg-${++groupSeq}`;

/** 初始态：单组空栈（开项目 / 重置时用） */
export function initialEditorGroups(): EditorGroupsState {
  const id = nextGroupId();
  return { groups: [{ id, tabs: [], active: null }], activeGroupId: id };
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

/** 在**焦点组**打开文件：无则追加到标签栈尾，并激活 */
export function openInActiveGroup(state: EditorGroupsState, path: string): EditorGroupsState {
  return {
    ...state,
    groups: state.groups.map((g) =>
      g.id === state.activeGroupId
        ? { ...g, tabs: g.tabs.includes(path) ? g.tabs : [...g.tabs, path], active: path }
        : g,
    ),
  };
}

/** 激活某组里的某标签（标签必须已在栈内；否则原样返回——不凭空造标签） */
export function activateTab(state: EditorGroupsState, groupId: string, path: string): EditorGroupsState {
  const target = state.groups.find((g) => g.id === groupId);
  if (!target || !target.tabs.includes(path)) return state;
  return {
    ...state,
    activeGroupId: groupId,
    groups: state.groups.map((g) => (g.id === groupId ? { ...g, active: path } : g)),
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
    return dropGroup ? g : { ...g, tabs: remainingTabs, active: nextActive };
  });
  if (dropGroup) groups = groups.filter((g) => g.id !== groupId);

  let activeGroupId = state.activeGroupId;
  if (dropGroup && state.activeGroupId === groupId) activeGroupId = neighborGroupId({ ...state, groups }, groupId);
  return { groups, activeGroupId };
}

/**
 * 向右拆分（VSCode 同款）：新组插在焦点组右侧，携带焦点组当前激活标签；
 * 焦点跟到新组（用户拆分就是为了立刻用第二栏）。
 */
export function splitActiveRight(state: EditorGroupsState): EditorGroupsState {
  const cur = activeGroupOf(state);
  const carried = cur.active;
  const id = nextGroupId();
  const i = state.groups.findIndex((g) => g.id === cur.id);
  const fresh: EditorGroupState = { id, tabs: carried ? [carried] : [], active: carried };
  const groups = [...state.groups.slice(0, i + 1), fresh, ...state.groups.slice(i + 1)];
  return { groups, activeGroupId: id };
}

/** 关组：唯一组不关（原样返回）；关焦点组 ⇒ 焦点落邻居组 */
export function closeGroup(state: EditorGroupsState, groupId: string): EditorGroupsState {
  if (state.groups.length <= 1) return state;
  const target = state.groups.find((g) => g.id === groupId);
  if (!target) return state;
  const groups = state.groups.filter((g) => g.id !== groupId);
  const activeGroupId = state.activeGroupId === groupId ? neighborGroupId(state, groupId) : state.activeGroupId;
  return { groups, activeGroupId };
}

/** 焦点切换（点击某组任意处 / 命令聚焦） */
export function setActiveGroup(state: EditorGroupsState, groupId: string): EditorGroupsState {
  if (!state.groups.some((g) => g.id === groupId) || state.activeGroupId === groupId) return state;
  return { ...state, activeGroupId: groupId };
}
