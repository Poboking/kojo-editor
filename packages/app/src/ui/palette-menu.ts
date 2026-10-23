/**
 * 快速打开 / 命令面板 / 工作区符号三类列表项的右键菜单（1023 批 · WP2.6 / WP4.9 / WP3.3）。
 *
 * ## 为什么单独一个文件
 *
 * 三个面板共用同一个 `Picker`（见 `Palette.tsx`），而它们的右键菜单只在「这一行是什么」
 * 上分叉：文件行认路径、命令行认命令 id、符号行认 `文件:行`。把这份判据抽成**纯函数**
 * （输入一行的事实 + 当前能力，输出菜单项），才能在 node 里把「哪个 mode 有哪些项 /
 * 什么能力下不显示 / 文案是不是全中文」钉住，不去依赖整块渲染。
 *
 * ## 三条口径
 *
 * 1. **文案全中文**：`label` 一律自带中文，交给根宿主的中文守卫也过得去；
 * 2. **能力不存在 ⇒ 整项不显示**（铁律 4 的前半）：剪贴板不可写就没有复制类，
 *    桌面壳不在场就没有「在资源管理器中显示」——不摆一个按下去没反应的项；
 * 3. **上下文暂不可用 ⇒ 禁用 + 人话原因**（铁律 4 的后半）：命令通道还没就绪时
 *    「打开键盘快捷键」灰着并说明原因，而不是悄悄消失。
 *
 * ## 没做的项（都因为宿主没这条通道，不是忘了）
 *
 * - 「从最近移除」：`recent-files.removeRecentFiles` 存在，但快速打开拿到的 `recent`
 *   只是 `string[]`，没有回写通道（`Palette` 也没有该 prop）；
 * - 「在新组打开」：`QuickOpen` 只有 `onOpenFile(path)` 一种开法，没有新组变体；
 * - 符号的「查找引用 / 重命名」：面板没有把「某个符号位置」交给语言服务的通道
 *   （`editor.action.rename` / `editor.action.references` 是编辑器内命令，需要先落位）。
 */
import { menuItemFromCommand, type ContextMenuItem } from './context-menu-model';

/** 这一行是什么（三个面板的行共用一种形状，只有这里分叉） */
export type PaletteRowKind = 'file' | 'command' | 'symbol';

/** 一行候选的**事实**（右键菜单全部判据的输入；空串 / 0 = 该字段不适用） */
export interface PaletteRowTarget {
  readonly kind: PaletteRowKind;
  /** 行主文本（文件名 / 命令标题 / 符号名）——「复制标题」用的就是它 */
  readonly label: string;
  /** 文件或符号所在的完整路径；命令行与 `:` 行号行为空串 */
  readonly path: string;
  /** 符号起始行（1 基）；非符号行为 0 */
  readonly line: number;
  /** 符号名；非符号行为空串 */
  readonly symbolName: string;
  /** 命令 id；非命令行为空串 */
  readonly commandId: string;
}

/** 文件行（快速打开的文件模式与「最近打开」那一节同形：`key` 就是路径） */
export function fileRowTarget(path: string, label: string): PaletteRowTarget {
  return { kind: 'file', label, path, line: 0, symbolName: '', commandId: '' };
}

/** 命令行（F1 命令面板与 `Ctrl+P` 的 `>` 模式同形：`key` 就是命令 id） */
export function commandRowTarget(commandId: string, label: string): PaletteRowTarget {
  return { kind: 'command', label, path: '', line: 0, symbolName: '', commandId };
}

/** 符号行（`@` 与 `Ctrl+T` 同形：名字 + `文件:行`） */
export function symbolRowTarget(
  path: string,
  line: number,
  symbolName: string,
  label: string,
): PaletteRowTarget {
  return { kind: 'symbol', label, path, line, symbolName, commandId: '' };
}

/**
 * 菜单项的动作 id（面自己的动作，不是命令——不冒充命令 id）。
 *
 * 「打开键盘快捷键」不在这里：它本身就是命令，直接沿用命令 id，选中时走命令通道。
 */
export const PALETTE_ROW_ACTION = {
  copyPath: 'palette.row.copyPath',
  copyName: 'palette.row.copyName',
  copyCommandId: 'palette.row.copyCommandId',
  copyCommandTitle: 'palette.row.copyCommandTitle',
  revealInExplorer: 'palette.row.revealInExplorer',
  jump: 'palette.row.jump',
} as const;

export type PaletteRowActionId = (typeof PALETTE_ROW_ACTION)[keyof typeof PALETTE_ROW_ACTION];

/**
 * 打开菜单时**现算**的能力（不缓存：Tauri 与命令通道都可能晚于首帧就绪）。
 * 传入而不是在这里探针，是为了让 `buildPaletteRowMenu` 在 node 里可直测。
 */
export interface PaletteMenuCapabilities {
  /** 剪贴板可写（`navigator.clipboard.writeText`）——不可写则复制类整项不显示 */
  readonly copyText: boolean;
  /** 桌面壳的 `show_in_folder` 可用——不可用则「在资源管理器中显示」整项不显示 */
  readonly revealInExplorer: boolean;
  /** 命令通道能执行「打开键盘快捷键」——不能则该项禁用并说明原因 */
  readonly keybindingsCommand: boolean;
}

/** 「打开键盘快捷键」的命令 id（键位设置页的唯一入口） */
export const KEYBINDINGS_COMMAND_ID = 'workbench.keybindings';

/** 命令通道未就绪时的禁用原因（上屏 `title` / `aria-description`） */
export const KEYBINDINGS_UNAVAILABLE_REASON = '命令面板尚未就绪，暂时打不开键盘快捷键';

function fileMenu(target: PaletteRowTarget, caps: PaletteMenuCapabilities): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (caps.copyText) items.push({ id: PALETTE_ROW_ACTION.copyPath, label: '复制路径' });
  if (caps.revealInExplorer && target.path !== '') {
    items.push({
      id: PALETTE_ROW_ACTION.revealInExplorer,
      label: '在资源管理器中显示',
      dividerBefore: items.length > 0,
    });
  }
  return items;
}

function commandMenu(target: PaletteRowTarget, caps: PaletteMenuCapabilities): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (caps.copyText) {
    items.push({ id: PALETTE_ROW_ACTION.copyCommandId, label: '复制命令 ID' });
    items.push({ id: PALETTE_ROW_ACTION.copyCommandTitle, label: '复制命令标题' });
  }
  // 标题与键位一律来自命令表（菜单不另造第二份文案）；命令不存在 ⇒ 整项不显示
  const keybindings = menuItemFromCommand(KEYBINDINGS_COMMAND_ID, { dividerBefore: items.length > 0 });
  if (keybindings !== null) {
    items.push(
      caps.keybindingsCommand
        ? keybindings
        : { ...keybindings, disabled: true, disabledReason: KEYBINDINGS_UNAVAILABLE_REASON },
    );
  }
  return items;
}

function symbolMenu(target: PaletteRowTarget, caps: PaletteMenuCapabilities): ContextMenuItem[] {
  const items: ContextMenuItem[] = [{ id: PALETTE_ROW_ACTION.jump, label: '跳转' }];
  if (!caps.copyText) return items;
  items.push({ id: PALETTE_ROW_ACTION.copyName, label: '复制名字', dividerBefore: true });
  if (target.path !== '') items.push({ id: PALETTE_ROW_ACTION.copyPath, label: '复制路径' });
  return items;
}

/**
 * 一行 → 菜单项（纯函数；空数组 = 这一行没有可做的事，调用方回 `null` 让路由走下一级）。
 *
 * 顺序即展示顺序：文件 = 复制路径 | 显示；命令 = 复制 id、复制标题 | 打开键盘快捷键；
 * 符号 = 跳转 | 复制名字、复制路径。
 */
export function buildPaletteRowMenu(
  target: PaletteRowTarget,
  caps: PaletteMenuCapabilities,
): ContextMenuItem[] {
  switch (target.kind) {
    case 'file':
      return fileMenu(target, caps);
    case 'command':
      return commandMenu(target, caps);
    case 'symbol':
      return symbolMenu(target, caps);
  }
}

/**
 * 面的无障碍名（按行种类换措辞：符号面板与文件列表共用 `quick-open` 这一个面 id，
 * 读屏里该听到的是「工作区符号菜单」而不是「快速打开菜单」）。
 */
export function paletteRowMenuAriaLabel(kind: PaletteRowKind): string {
  switch (kind) {
    case 'file':
      return '快速打开菜单';
    case 'command':
      return '命令面板菜单';
    case 'symbol':
      return '工作区符号菜单';
  }
}

/* --------------------------- 行 → DOM 属性（多实例安全） --------------------------- */

/**
 * 行元素上的属性名：右键那一刻从 `target` 读，不靠组件闭包
 * （三个面板可能同时挂着，闭包互相覆盖是这类菜单最常见的事故）。
 */
export const PALETTE_ROW_ATTR = 'data-palette-row';

/** 一行的 DOM 属性（`Picker` 直接摊到行元素上） */
export interface PaletteRowAttributes {
  readonly [PALETTE_ROW_ATTR]: PaletteRowKind;
  'data-palette-label': string;
  'data-palette-path': string;
  'data-palette-line': string;
  'data-palette-symbol': string;
  'data-palette-command': string;
}

/** 一行 → DOM 属性（`line` 用字符串：DOM 属性没有数字） */
export function paletteRowAttributes(target: PaletteRowTarget): PaletteRowAttributes {
  return {
    [PALETTE_ROW_ATTR]: target.kind,
    'data-palette-label': target.label,
    'data-palette-path': target.path,
    'data-palette-line': target.line > 0 ? String(target.line) : '',
    'data-palette-symbol': target.symbolName,
    'data-palette-command': target.commandId,
  };
}

/** 右键命中的元素 → 行的事实（不在行上 / 行没有种类 ⇒ `null`，这一级不表态） */
export function paletteRowTargetOf(element: Element): PaletteRowTarget | null {
  const row = element.closest(`[${PALETTE_ROW_ATTR}]`);
  if (row === null) return null;
  const kind = row.getAttribute(PALETTE_ROW_ATTR);
  if (kind !== 'file' && kind !== 'command' && kind !== 'symbol') return null;
  const line = Number(row.getAttribute('data-palette-line') ?? '');
  return {
    kind,
    label: row.getAttribute('data-palette-label') ?? '',
    path: row.getAttribute('data-palette-path') ?? '',
    line: Number.isSafeInteger(line) && line > 0 ? line : 0,
    symbolName: row.getAttribute('data-palette-symbol') ?? '',
    commandId: row.getAttribute('data-palette-command') ?? '',
  };
}
