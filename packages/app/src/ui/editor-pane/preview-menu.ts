/**
 * 编辑区的两个右键面（1023 覆盖面批 · WP1.2 / 1.5）：
 *
 * 1. `editor`——**编辑器外框**（工具条这一条），给「复制文件路径 / 命令面板 / 打开设置」三项；
 * 2. `sugar-preview`——**`.kojo 预览` 横幅**（预览开关 + 读数 + 语法标记开关那一簇），
 *    只给只读动作 + 切回源码。
 *
 * ## 这一路只补外框，不抢 Monaco 的里子
 *
 * 行号槽 / 折叠槽 / 小地图 / 概览标尺 / 滚动条 / 编辑区空白 / 内联提示 / 悬浮卡**全在
 * `.monaco-editor` 里**，根路由（`App.tsx` 的 `onContextMenu`）对它们整片放行——Monaco
 * 自带的 zh-cn 菜单（剪切 / 复制 / 转到定义 / 命令面板…）比任何自造项都全，抢过来就是
 * 把现成功能做没了。所以本文件**不给**这些热区加菜单，也不 `preventDefault`；只在
 * 「右键落在了编辑器外框上」时表态（`editor-hotzones.test.ts` 把这三条钉住）。
 *
 * ## 为什么构建函数是纯的、上下文是"取的时候现读"
 *
 * `declareContextSurface` 在模块顶层登记，`build` 拿不到组件闭包；而「有没有选区 / 光标
 * 这一行映射不映射得到原文」这些是**每一次右键那一刻**的事实。所以面的 `build` 通过
 * `runtimeFor(...)` 取到当前组（分屏：`data-editor-group` 就近判定）的运行期句柄，
 * 句柄里的 `context()` 每次现读。菜单项集合由纯函数 `buildPreviewMenu` /
 * `buildEditorFrameMenu` 算——单测直接打它们，不必渲染。
 */
import { menuItemFromCommand, type ContextMenuItem } from '../context-menu-model';
import { declareContextSurface } from '../context-surfaces';

/** 编辑器外框菜单的动作 id（都在本文件自己分发，不冒充命令） */
export const EDITOR_FRAME_MENU_IDS = {
  /** 复制当前活动文件的完整路径 */
  copyPath: 'editor-frame.copyPath',
} as const;

/** 预览菜单自己的动作 id（命令项直接沿用命令 id，见 `buildPreviewMenu` 注释） */
export const PREVIEW_MENU_IDS = {
  /** 复制预览全文 */
  copyAll: 'preview.copyAll',
  /** 复制选区 */
  copySelection: 'preview.copySelection',
  /** 切回源码（键位/标题取自 `workbench.toggleSugarView`） */
  backToSource: 'preview.backToSource',
  /** 折叠全部 */
  foldAll: 'preview.foldAll',
  /** 展开全部 */
  unfoldAll: 'preview.unfoldAll',
  /** 在原文里定位当前预览行对应的那一行 */
  jumpToSource: 'preview.jumpToSource',
} as const;

/**
 * 「切回源码」用的命令 id：`workbench.toggleSugarView`（键位 Ctrl+Alt+T，已登记在
 * `KEYBINDING_SPECS` 与编辑器区的命令表里）。
 *
 * 为什么用一条**切换**命令做「切回」：这个面只在预览**正在屏上**时才存在（见
 * `buildPreviewMenu` 的 `previewing` 门），方向因此是确定的；好处是标题旁的键位来自
 * 键位表真源，作者按 Ctrl+Alt+T 也是同一条路。
 */
export const PREVIEW_TOGGLE_COMMAND_ID = 'workbench.toggleSugarView';

/** 「打开设置」命令 id（预览的开关就住在设置页「编辑器」一节） */
const OPEN_SETTINGS_COMMAND_ID = 'layout.openSettings';

/** 命令不可用时的统一人话（灰着不说话是铁律 4 的违例） */
const COMMAND_UNAVAILABLE_REASON = '命令当前不可用（可能还没打开项目）';

/** 编辑器外框菜单的构建上下文（全部是"此刻事实"，纯值） */
export interface EditorFrameMenuContext {
  /** 当前活动文件路径；`null` = 空态（没有路径可复制 ⇒ 整项不显示） */
  readonly filePath: string | null;
  /** 命令通道是否可执行（通道未注册 / 命令不在注册表 ⇒ 禁用 + 原因） */
  readonly canRunCommand: (id: string) => boolean;
}

/**
 * 编辑器外框菜单：`复制文件路径 | 命令面板 / 打开设置`。
 *
 * 外框上没有"文件内容"可言（内容在 Monaco 里，归它自己的原生菜单），所以这里只放
 * 壳层级的三项——多塞一项就会与编辑区里那份菜单打架。
 */
export function buildEditorFrameMenu(ctx: EditorFrameMenuContext): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (ctx.filePath !== null && ctx.filePath !== '') {
    items.push({
      id: EDITOR_FRAME_MENU_IDS.copyPath,
      label: '复制文件路径',
      icon: 'files',
      group: '本文件',
    });
  }
  const commandItems: readonly (ContextMenuItem | null)[] = [
    menuItemFromCommand('workbench.commandPalette', { icon: 'search', group: '工作台' }),
    menuItemFromCommand(OPEN_SETTINGS_COMMAND_ID, { icon: 'settings', group: '工作台' }),
  ];
  for (const item of commandItems) {
    if (item === null) continue; // 命令没登记 ⇒ 整项不显示（不冒充能力）
    items.push(withCommandAvailability(item, ctx.canRunCommand));
  }
  return items;
}

/** 预览菜单的构建上下文（全部是"此刻事实"，纯值） */
export interface PreviewMenuContext {
  /** 预览是否正挂在屏上（只读派生 model）；否则这个面根本不该存在 */
  readonly previewing: boolean;
  /** 预览文本非空（可整份复制） */
  readonly hasPreviewText: boolean;
  /** 预览里有选区（可只复制选中的那段） */
  readonly hasSelection: boolean;
  /** 光标所在预览行在原文里找得到位置（跳得到才给"定位"，找不到给禁用原因） */
  readonly canJumpToSource: boolean;
  /** 折叠能力在册（Monaco 折叠动作可用） */
  readonly canToggleFold: boolean;
  /** 命令通道能跑「打开设置」 */
  readonly canOpenSettings: boolean;
}

/**
 * 预览横幅菜单：**只读动作 + 切回源码**，刻意不含保存 / 格式化 / 重命名这类写动作
 * ——预览挂的是派生只读 model，那些项在它上面一定做不到，摆出来就是冷板凳。
 *
 * 顺序与分组：剪贴板 → 显示（切回源码 / 折叠 / 展开）→ 导航 → 设置。
 * 「没这个能力」与「这一拍不可用」分开处理：能力不存在整项不显示（复制选区 /
 * 折叠），上下文暂不可用则禁用并写原因（跳到原文那一项）。
 */
export function buildPreviewMenu(ctx: PreviewMenuContext): ContextMenuItem[] {
  if (!ctx.previewing) return [];
  const items: ContextMenuItem[] = [];
  if (ctx.hasPreviewText) {
    items.push({
      id: PREVIEW_MENU_IDS.copyAll,
      label: '复制预览全文',
      icon: 'files',
      group: '剪贴板',
    });
  }
  if (ctx.hasSelection) {
    items.push({
      id: PREVIEW_MENU_IDS.copySelection,
      label: '复制所选内容',
      icon: 'files',
      group: '剪贴板',
    });
  }
  // 切回源码：标题/键位取自 `workbench.toggleSugarView`，动作走本文件的分发。
  // 键位表里那条命令若被摘掉（`menuItemFromCommand` 返回 null）也**不能丢掉这一项**
  // ——切回源码靠的是宿主那条 `editor.sugarView.set` 通道，与键位表是否登记无关；
  // 这时只少一个快捷键提示，不少一个动作（少了就是静默失去能力）。
  const back = menuItemFromCommand(PREVIEW_TOGGLE_COMMAND_ID, {
    id: PREVIEW_MENU_IDS.backToSource,
    label: '切回源码',
    icon: 'code',
    group: '显示',
  });
  items.push(
    back ?? { id: PREVIEW_MENU_IDS.backToSource, label: '切回源码', icon: 'code', group: '显示' },
  );
  if (ctx.canToggleFold) {
    items.push(
      { id: PREVIEW_MENU_IDS.foldAll, label: '折叠全部', icon: 'chevron-right', group: '显示' },
      { id: PREVIEW_MENU_IDS.unfoldAll, label: '展开全部', icon: 'chevron-down', group: '显示' },
    );
  }
  items.push(
    ctx.canJumpToSource
      ? {
          id: PREVIEW_MENU_IDS.jumpToSource,
          label: '在源码中定位当前行',
          icon: 'target',
          group: '导航',
        }
      : {
          id: PREVIEW_MENU_IDS.jumpToSource,
          label: '在源码中定位当前行',
          icon: 'target',
          group: '导航',
          disabled: true,
          disabledReason: '当前这一行是预览独有的（原文里没有对应位置）',
        },
  );
  const settings = menuItemFromCommand(OPEN_SETTINGS_COMMAND_ID, {
    icon: 'settings',
    group: '设置',
  });
  if (settings !== null) {
    items.push(ctx.canOpenSettings ? settings : disabledCommandItem(settings));
  }
  return items;
}

/** 命令项按「此刻能不能跑」补禁用原因（不静默、不假装能按） */
function withCommandAvailability(
  item: ContextMenuItem,
  canRun: (id: string) => boolean,
): ContextMenuItem {
  return canRun(item.id) ? item : disabledCommandItem(item);
}

function disabledCommandItem(item: ContextMenuItem): ContextMenuItem {
  return { ...item, disabled: true, disabledReason: COMMAND_UNAVAILABLE_REASON };
}

/* --------------------------- 运行期句柄（按编辑器组） --------------------------- */

/** 外框菜单的运行期句柄：`context()` 每次右键现读，`run()` 落到组件里的既有能力 */
export interface EditorFrameMenuRuntime {
  readonly context: () => EditorFrameMenuContext;
  readonly run: (id: string) => void;
}

/** 预览菜单的运行期句柄（同上） */
export interface PreviewMenuRuntime {
  readonly context: () => PreviewMenuContext;
  readonly run: (id: string) => void;
}

/**
 * 按**编辑器组**分槽（SPLIT-1 分屏）：两个 `EditorPane` 同时挂着时，谁被右击就该用谁的
 * 上下文——单槽会被后挂载的那个覆盖，菜单就会对着 A 组说 B 组的话。
 */
const frameRuntimes = new Map<string, EditorFrameMenuRuntime>();
const previewRuntimes = new Map<string, PreviewMenuRuntime>();

/** 登记/注销某组的外框句柄（`null` = 注销；组件卸载必须调，句柄里握着 ref） */
export function setEditorFrameMenuRuntime(
  groupId: string,
  runtime: EditorFrameMenuRuntime | null,
): void {
  if (runtime === null) frameRuntimes.delete(groupId);
  else frameRuntimes.set(groupId, runtime);
}

/** 登记/注销某组的预览句柄 */
export function setPreviewMenuRuntime(groupId: string, runtime: PreviewMenuRuntime | null): void {
  if (runtime === null) previewRuntimes.delete(groupId);
  else previewRuntimes.set(groupId, runtime);
}

/** 右键命中的元素属于哪个编辑器组（面根元素上的 `data-editor-group`，就近判定） */
function groupIdOf(target: HTMLElement): string | null {
  const owner = target.closest<HTMLElement>('[data-editor-group]');
  if (owner === null) return null;
  const id = owner.getAttribute('data-editor-group');
  return id === null || id === '' ? null : id;
}

/** 命中元素所属组的外框句柄（没有组 / 该组没登记 ⇒ null = 这一级不表态） */
function frameRuntimeFor(target: HTMLElement): EditorFrameMenuRuntime | null {
  const groupId = groupIdOf(target);
  return groupId === null ? null : (frameRuntimes.get(groupId) ?? null);
}

/** 命中元素所属组的预览句柄 */
function previewRuntimeFor(target: HTMLElement): PreviewMenuRuntime | null {
  const groupId = groupIdOf(target);
  return groupId === null ? null : (previewRuntimes.get(groupId) ?? null);
}

/* ------------------------------- 面声明 ------------------------------- */

/**
 * 编辑器外框（`data-context-surface="editor"` 挂在外框根节点上）。
 *
 * VIS-15（1026 编辑器体感批 E2）之后那一条是**上下文带** `.editor-crumb-band`
 * （改前是 `.editor-toolbar`，与它下面那根 20px 的面包屑条叠成两条窄带）；
 * 面属性跟着同一个根节点搬了过去 ⇒ 右键接管范围一字没缩。
 */
declareContextSurface({
  id: 'editor',
  ariaLabel: '编辑器菜单',
  area: 'editor',
  build: (ctx) => {
    const runtime = frameRuntimeFor(ctx.target);
    if (runtime === null) return null; // 没登记 = 这一级不表态，交给兜底
    const items = buildEditorFrameMenu(runtime.context());
    if (items.length === 0) return null;
    return { items, onSelect: (id) => runtime.run(id) };
  },
});

/** `.kojo 预览` 横幅（只在预览在屏时挂 `data-context-surface="sugar-preview"`） */
declareContextSurface({
  id: 'sugar-preview',
  ariaLabel: '预览菜单',
  area: 'editor',
  build: (ctx) => {
    const runtime = previewRuntimeFor(ctx.target);
    if (runtime === null) return null;
    const items = buildPreviewMenu(runtime.context());
    if (items.length === 0) return null;
    return { items, onSelect: (id) => runtime.run(id) };
  },
});
