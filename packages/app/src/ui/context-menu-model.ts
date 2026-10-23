/**
 * 右键菜单的**数据面**（零 React、可在 node 侧直测）。
 *
 * 分工：
 * - 这里只描述「菜单长什么样」以及「这条从哪来」——文档模型、键位适配、中文化守卫、
 *   三级兜底策略；
 * - 渲染与键盘（WAI-ARIA menu）留在 `context-menu.tsx`；宿主状态机留在 `context-menu-host.tsx`；
 * - 各界面面的注册表留在 `context-surfaces.ts`。
 *
 * 为什么把模型单独拆出来：13 个面要并行补菜单，模型若和组件绑在一起，任何一面想加
 * 「禁用原因 / 分组 / 子菜单」都要改组件文件 ⇒ 冲突必然。拆开后各面只 import 这里的类型
 * 与 `menuItemFromCommand`，组件文件（`context-menu.tsx`）对本批只改一次。
 *
 * ## 三条硬口径
 *
 * 1. **文案全中文**：`isChineseMenuLabel` + `filterChineseMenuItems` 是宿主渲染前的最后一道闸，
 *    插件 / 语言服务贡献的英文项一律整项丢弃（丢一次说一次话，不静默）。
 * 2. **禁用必须说话**（铁律 4）：`disabled: true` 必须配 `disabledReason`，渲染侧把原因
 *    同时写进 `title` 与 `aria-description`——灰着不说话的项等于「按了没反应」。
 * 3. **菜单不另造第二份文案**：凡「已有命令」的动作一律走 `menuItemFromCommand`，标题与键位
 *    从 `KEYBINDING_SPECS` 取——菜单与命令面板双真源是必然漂移的那种事故。
 */
import { formatKeybinding } from './commands';
import { effectiveKeybindingOf, keybindingSpecOf } from './keybindings';

/** 一条菜单项（数据面：动作由 onSelect 统一接线，组件不认识业务 id） */
export interface ContextMenuItem {
  readonly id: string;
  readonly label: string;
  /** icons.tsx 的内置图标名；不命中注册表时按字形渲染（与 Icon 组件同口径） */
  readonly icon?: string;
  /** 右侧快捷键提示（纯展示；真正的键位由各命令的注册处负责） */
  readonly shortcut?: string;
  /** 破坏性动作：危险色 + 勾选列的 `!` 提示（不只靠颜色） */
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** 在这一项**之前**画一条分隔线（首项的分隔线由渲染侧吞掉） */
  readonly dividerBefore?: boolean;
  /** 选中态（勾选列打勾）；按钮同时带 aria-checked 上屏 */
  readonly checked?: boolean;
  /**
   * 禁用原因（必填于 `disabled: true` 的项）：渲染侧写进 `title` 与 `aria-description`。
   * 铁律 4 的菜单侧同款——不可用必须让人看见为什么不可用，不许灰着不说话。
   */
  readonly disabledReason?: string;
  /**
   * 分组标题：**连续**同 `group` 的项归一段，段前画一条不可聚焦的小节头。
   * 与 `dividerBefore` 的区别是语义：分组有名字，分隔线只是断行。
   */
  readonly group?: string;
  /** 子菜单（角色 `menuitem` + `aria-haspopup="menu"`；→ 打开、← 收起、Esc 逐级关闭） */
  readonly children?: readonly ContextMenuItem[];
}

export interface MenuPoint {
  readonly left: number;
  readonly top: number;
}

export interface MenuExtent {
  readonly width: number;
  readonly height: number;
}

export interface ViewportExtent {
  readonly width: number;
  readonly height: number;
}

/** 菜单与视口边缘的最小呼吸（= styles.css 的 `--space-1`） */
export const MENU_VIEWPORT_MARGIN = 4;

/** 兜底菜单的无障碍名称（三级策略的最后一级） */
export const FALLBACK_MENU_ARIA_LABEL = '通用菜单';

/** 视口夹取（纯函数）：两个方向都夹；菜单比视口还大时贴住左上边距，绝不出现负坐标 */
export function clampMenuPosition(
  x: number,
  y: number,
  size: MenuExtent,
  viewport: ViewportExtent,
  margin: number = MENU_VIEWPORT_MARGIN,
): MenuPoint {
  const maxLeft = viewport.width - size.width - margin;
  const maxTop = viewport.height - size.height - margin;
  return {
    left: Math.max(margin, Math.min(x, maxLeft)),
    top: Math.max(margin, Math.min(y, maxTop)),
  };
}

export type MenuNavigationKey = 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

/**
 * 键盘落点（纯函数）：返回下一个**可用**项下标；没有可用项 → -1。
 *
 * - ↑/↓ 跳过 disabled，到边界即停（不循环）；
 * - current 不在任何项上（-1，刚打开）时：↓ 落首个可用项，↑ 落末个可用项；
 * - Home/End 直接到首/尾可用项。
 *
 * 下标口径是**整个 items 数组**（含 disabled 项与子菜单父项）——渲染侧每一项都对应
 * 恰好一个 button，故可用「第几个按钮」直接对齐。分组头 / 分隔线不是按钮，不参与。
 */
export function nextMenuIndex(
  items: readonly ContextMenuItem[],
  current: number,
  key: MenuNavigationKey,
): number {
  const enabled: number[] = [];
  for (let i = 0; i < items.length; i++) if (!items[i]!.disabled) enabled.push(i);
  if (enabled.length === 0) return -1;
  switch (key) {
    case 'Home':
      return enabled[0]!;
    case 'End':
      return enabled[enabled.length - 1]!;
    case 'ArrowDown': {
      for (const i of enabled) if (i > current) return i;
      return enabled[enabled.length - 1]!;
    }
    case 'ArrowUp': {
      if (current < 0) return enabled[enabled.length - 1]!;
      for (let k = enabled.length - 1; k >= 0; k--) if (enabled[k]! < current) return enabled[k]!;
      return enabled[0]!;
    }
  }
}

/* ------------------------------ 首字母跳转 ------------------------------ */

/**
 * type-ahead 的累积窗口（毫秒）。500ms 是 WAI-ARIA menu 与桌面菜单的通行档：
 * 更短会把「新」「建」两下拆成两次首字母跳；更长会让用户停手后敲的字母被拼进上一条查询。
 */
export const TYPE_AHEAD_RESET_MS = 500;

/** 一次按键里与 type-ahead 判据相关的部分（React 合成事件 / 原生事件都能喂） */
export interface TypeAheadKeyEvent {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  /** 输入法组合期间（拼音候选未提交）不拦截——否则中文用户一按字母就被抢走 */
  readonly isComposing?: boolean;
}

/**
 * 按键 → 可参与 type-ahead 的字符；不该参与时返回 null。
 *
 * 判据（三条都要过）：单字符、不是空格、不带 Ctrl/Meta/Alt（组合键是命令，不是找项）、
 * 不处于输入法组合期。大小写归一化成小写——菜单项 `label` 多为中文，但快捷键混排的
 * 英文项仍要能用小写敲到大写开头。
 */
export function typeAheadCharOf(event: TypeAheadKeyEvent): string | null {
  if (event.isComposing === true) return null;
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return null;
  const key = event.key;
  if (key.length !== 1 || key === ' ') return null;
  return key.toLowerCase();
}

/**
 * 把新字符并进当前查询串（纯函数，窗口由调用侧判）：
 * - 距上次按键超过 `TYPE_AHEAD_RESET_MS` ⇒ 从头开始；
 * - 连续敲**同一个**字符（「打」「打」）⇒ 查询串回到单字符，用来在同类项之间循环
 *   （Windows / VSCode 菜单同口径；否则「打打」永远不命中，第二次按键等于没反应）。
 */
export function nextTypeAheadQuery(previous: string, char: string, elapsedMs: number): string {
  if (previous === '' || elapsedMs > TYPE_AHEAD_RESET_MS) return char;
  if (previous === char.repeat(previous.length)) return char;
  return previous + char;
}

/**
 * 首字母落点（纯函数）：从 `current` 的**下一项**开始找 label 以 `query` 开头的可用项，
 * 绕一圈回到 `current` 为止（循环）；没有命中 ⇒ -1（调用侧据此不 preventDefault）。
 *
 * 匹配口径：`query` 与 label 都转小写后比前缀；disabled 项跳过（与方向键同一档）。
 * `current` 为 -1（刚打开 / 焦点不在项上）时从第 0 项找起。
 */
export function typeAheadIndex(
  items: readonly ContextMenuItem[],
  current: number,
  query: string,
): number {
  const needle = query.toLowerCase();
  if (needle === '' || items.length === 0) return -1;
  const start = current < 0 ? 0 : current + 1;
  for (let step = 0; step < items.length; step++) {
    const index = (start + step) % items.length;
    const item = items[index]!;
    if (item.disabled) continue;
    if (item.label.toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

/* ------------------------------ 中文化守卫 ------------------------------ */

/** 菜单文案是否含中日韩统一表意文字（含则视为中文文案；空串 / 纯符号视为不合格） */
export function isChineseMenuLabel(label: string): boolean {
  return /[\u4e00-\u9fff]/.test(label);
}

/** 丢弃非中文项的告警只发一次（同一批里重复刷屏反而没人看） */
let chineseGuardWarned = false;

/**
 * 中文化守卫（宿主渲染前的最后一道闸）：label 不含 CJK 的项**整项丢弃**；
 * 子菜单里的项全被丢光时，父项也一并丢（点开是空壳的入口不如没有）。
 *
 * 丢弃不静默：本模块生命周期内第一次丢弃时 `console.warn` 一次，带上首个被丢的 label
 * ——插件 / 语言服务贡献了英文菜单时，作者能在控制台看见是谁混进来了。
 */
export function filterChineseMenuItems(items: readonly ContextMenuItem[]): ContextMenuItem[] {
  const dropped: string[] = [];
  const kept = filterInto(items, dropped);
  if (dropped.length > 0 && !chineseGuardWarned) {
    chineseGuardWarned = true;
    console.warn(
      `[右键菜单] 已丢弃 ${dropped.length} 个非中文菜单项（首个：${dropped[0] ?? ''}）——用户可见文案必须全中文`,
    );
  }
  return kept;
}

function filterInto(
  items: readonly ContextMenuItem[],
  dropped: string[],
): ContextMenuItem[] {
  const kept: ContextMenuItem[] = [];
  for (const item of items) {
    if (!isChineseMenuLabel(item.label)) {
      dropped.push(item.label);
      continue;
    }
    if (item.children === undefined) {
      kept.push(item);
      continue;
    }
    const children = filterInto(item.children, dropped);
    if (children.length === 0) {
      // 子菜单整段被丢 ⇒ 父项留下只会点出一个空菜单
      dropped.push(item.label);
      continue;
    }
    kept.push({ ...item, children });
  }
  return kept;
}

/* ------------------------------ 命令项适配 ------------------------------ */

/**
 * 命令 → 菜单项（菜单侧唯一合法文案来源）。
 *
 * 标题取 `KEYBINDING_SPECS` 的中文 title，快捷键取**生效键位**（含作者改键）后经
 * `formatKeybinding` 展示——菜单里显示的键必须与真按下去的那条一致。
 * id 未在键位注册表登记 ⇒ 返回 null（调用方整项不显示，铁律 4）。
 */
export function menuItemFromCommand(
  id: string,
  overrides?: Partial<ContextMenuItem>,
): ContextMenuItem | null {
  const spec = keybindingSpecOf(id);
  if (spec === undefined) return null;
  const keys = effectiveKeybindingOf(id);
  const shortcut = keys === undefined || keys === '' ? undefined : formatKeybinding(keys);
  return {
    id,
    label: spec.title,
    ...(shortcut === undefined ? {} : { shortcut }),
    ...overrides,
  };
}

/* --------------------------- 命令执行通道（宿主注入） --------------------------- */

/** 命令通道（壳层 `WorkbenchApi` 的子集；由 ShellLayout 在挂载时注入） */
export interface ContextMenuCommandRunner {
  /** 命令是否存在于当前注册表 */
  hasCommand(id: string): boolean;
  /** 执行命令（when 不满足 / 不存在 → false） */
  runCommand(id: string): boolean;
}

let commandRunner: ContextMenuCommandRunner | null = null;

/**
 * 注册命令通道（`null` = 卸载）。根路由挂在 App 壳层，而命令注册表在 ShellLayout 里
 * ——这一层是两者之间唯一的一根线，菜单不自己实现任何业务动作。
 */
export function registerContextMenuCommandRunner(
  runner: ContextMenuCommandRunner | null,
): void {
  commandRunner = runner;
}

/** 命令是否可执行（通道未注册 = false：没有通道就按不了，不能假装能按） */
export function canRunContextMenuCommand(id: string): boolean {
  return commandRunner !== null && commandRunner.hasCommand(id);
}

/** 执行命令（通道未注册 / 命令不存在 / 执行抛错 → false） */
export function runContextMenuCommand(id: string): boolean {
  return commandRunner === null ? false : commandRunner.runCommand(id);
}

/* ------------------------------- 三级兜底菜单 ------------------------------- */

/** 剪贴板类动作 id（兜底菜单自己的 id，不是命令——无对应命令，不冒充命令） */
export const FALLBACK_CLIPBOARD_ACTION_IDS = [
  'clipboard.undo',
  'clipboard.redo',
  'clipboard.cut',
  'clipboard.copy',
  'clipboard.paste',
  'selection.selectAll',
] as const;

/** 这条 id 是不是兜底菜单自己的剪贴板类动作（不是命令 id） */
export function isFallbackClipboardAction(id: string): boolean {
  return (FALLBACK_CLIPBOARD_ACTION_IDS as readonly string[]).includes(id);
}

/** `execCommand` 命令名对应表 */
const EXEC_COMMANDS: Readonly<Record<string, string>> = {
  'clipboard.undo': 'undo',
  'clipboard.redo': 'redo',
  'clipboard.cut': 'cut',
  'clipboard.copy': 'copy',
  'clipboard.paste': 'paste',
  'selection.selectAll': 'selectAll',
};

/** 兜底菜单里的命令项（顺序即展示顺序；命令未登记 ⇒ 整项不显示） */
const FALLBACK_COMMAND_IDS = [
  'workbench.commandPalette',
  'layout.openSettings',
  'workbench.checkUpdates',
] as const;

/** 文本输入类元素（input/textarea/contenteditable）；非文本类 input（勾选框等）不算 */
function editableOf(target: HTMLElement): HTMLElement | null {
  const found = target.closest<HTMLElement>(
    'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
  );
  if (found === null) return null;
  if (found.tagName === 'INPUT') {
    const type = (found as HTMLInputElement).type;
    const textLike = ['text', 'search', 'url', 'tel', 'password', 'email', 'number', ''];
    if (!textLike.includes(type)) return null;
  }
  return found;
}

/** 目标是否文本输入类（兜底菜单据此分「输入类」与「通用」两套项） */
export function isTextInputTarget(target: HTMLElement | null): boolean {
  return target !== null && editableOf(target) !== null;
}

/**
 * 这次按下是不是**主键**（左键）。**全仓唯一判据**，不要在各处手写 `button === 0`。
 *
 * 遮罩层的「点外面关掉浮层」只该认左键：右键是**开菜单**的手势，拿它在遮罩上按一下，
 * 浮层先被关掉、紧接着弹出一个压在空页面上的菜单——用户读到的是「右键把这一页关了」。
 * 而更糟的是连锁：浮层没了，右键落点上的面也就没了。右键语义归根路由
 * （`context-surfaces.ts`），关窗语义归遮罩自己。
 *
 * 形态收成 `{ button: number }` 而不是 `MouseEvent`：这样 React 合成事件、原生事件、
 * 以及纯函数的单测入参都能直接喂进来。
 */
export function isPrimaryButton(event: { readonly button: number }): boolean {
  return event.button === 0;
}

/** 目标内是否有选区（复制 / 剪切的可用性判据） */
function hasSelectionIn(target: HTMLElement): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    return start !== null && end !== null && start !== end;
  }
  const selection = typeof window === 'undefined' ? null : window.getSelection();
  return selection !== null && selection.toString().length > 0;
}

/** 输入类元素是否只读（只读时剪切不可用，复制仍可用） */
function isReadOnly(target: HTMLElement): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return target.readOnly;
  return target.getAttribute('contenteditable') === 'false';
}

/**
 * `document.queryCommandEnabled` 的兜底封装。
 *
 * 该 API 已废弃但在 WebView2 里仍可用；取不到 / 抛错时按 `fallback` 走——
 * 宁可让动作「按下去没反应」（平台本来就不动），也不要谎报不可用。
 */
function execCommandEnabled(command: string, fallback: boolean): boolean {
  if (typeof document === 'undefined' || typeof document.queryCommandEnabled !== 'function') {
    return fallback;
  }
  try {
    return document.queryCommandEnabled(command);
  } catch {
    return fallback;
  }
}

/** 输入类目标：撤销 / 重做 | 剪切 / 复制 / 粘贴 | 全选 */
function buildInputFallback(target: HTMLElement): ContextMenuItem[] {
  const selected = hasSelectionIn(target);
  const readOnly = isReadOnly(target);
  const pasteEnabled = execCommandEnabled('paste', false);
  return [
    { id: 'clipboard.undo', label: '撤销', shortcut: 'Ctrl+Z' },
    { id: 'clipboard.redo', label: '重做', shortcut: 'Ctrl+Y' },
    {
      id: 'clipboard.cut',
      label: '剪切',
      shortcut: 'Ctrl+X',
      dividerBefore: true,
      ...(readOnly
        ? { disabled: true, disabledReason: '当前输入框只读，不能剪切' }
        : selected
          ? {}
          : { disabled: true, disabledReason: '没有选中内容' }),
    },
    selected
      ? { id: 'clipboard.copy', label: '复制', shortcut: 'Ctrl+C' }
      : {
          id: 'clipboard.copy',
          label: '复制',
          shortcut: 'Ctrl+C',
          disabled: true,
          disabledReason: '没有选中内容',
        },
    {
      id: 'clipboard.paste',
      label: '粘贴',
      shortcut: 'Ctrl+V',
      ...(pasteEnabled
        ? {}
        : { disabled: true, disabledReason: '当前环境未开放菜单粘贴，请用 Ctrl+V' }),
    },
    { id: 'selection.selectAll', label: '全选', shortcut: 'Ctrl+A', dividerBefore: true },
  ];
}

/** 通用目标：复制 / 全选 | 命令面板 / 设置 / 检查更新 */
function buildGeneralFallback(target: HTMLElement): ContextMenuItem[] {
  const selected = hasSelectionIn(target);
  const items: ContextMenuItem[] = [
    selected
      ? { id: 'clipboard.copy', label: '复制', shortcut: 'Ctrl+C' }
      : {
          id: 'clipboard.copy',
          label: '复制',
          shortcut: 'Ctrl+C',
          disabled: true,
          disabledReason: '没有选中内容',
        },
    { id: 'selection.selectAll', label: '全选', shortcut: 'Ctrl+A' },
  ];
  let first = true;
  for (const id of FALLBACK_COMMAND_IDS) {
    const item = menuItemFromCommand(id, first ? { dividerBefore: true } : undefined);
    if (item === null) continue; // 命令不存在 ⇒ 整项不显示
    items.push(commandItemForFallback(item));
    first = false;
  }
  return items;
}

/** 兜底菜单里的命令项按「当前有没有命令通道」补禁用原因（不静默、不假装能按） */
function commandItemForFallback(item: ContextMenuItem): ContextMenuItem {
  if (canRunContextMenuCommand(item.id)) return item;
  return {
    ...item,
    disabled: true,
    disabledReason: '未打开项目或命令未就绪',
  };
}

/**
 * 三级菜单策略的最后一级：兜底菜单。
 *
 * - **输入类**（input / textarea / contenteditable）：撤销 / 重做 | 剪切 / 复制 / 粘贴 | 全选；
 * - **通用**：复制（有选区才可用） / 全选 | 命令面板 / 设置 / 检查更新。
 *
 * 兜底只放**通用**动作：业务动作归各界面面的专属菜单，塞进兜底等于把业务知识散到根路由。
 * 不可用的项一律「禁用 + 原因」，不整项删除（除非命令根本不存在）。
 */
export function buildFallbackMenu(target: HTMLElement): readonly ContextMenuItem[] {
  const editable = editableOf(target);
  return editable === null ? buildGeneralFallback(target) : buildInputFallback(editable);
}

/**
 * 执行兜底菜单的一项（根路由把它直接接到 `onSelect`）。
 *
 * 剪贴板类走 `document.execCommand`（WebView2 仍支持；调用前先聚焦目标，否则命令落在
 * 上一次焦点所在的输入框里）。其余 id 一律当命令，交给宿主注入的命令通道执行。
 */
export function runFallbackMenuAction(id: string, target: HTMLElement | null): boolean {
  const command = EXEC_COMMANDS[id];
  if (command !== undefined) return execEditCommand(command, target);
  return runContextMenuCommand(id);
}

function execEditCommand(command: string, target: HTMLElement | null): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  if (target !== null) {
    try {
      target.focus({ preventScroll: true });
    } catch {
      // 目标不可聚焦（已被卸载等）：命令照发，落点交平台决定
    }
  }
  try {
    return document.execCommand(command);
  } catch {
    return false;
  }
}
