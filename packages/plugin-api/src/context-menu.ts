/**
 * 插件面板的**右键菜单契约**（1023 批 · 右键覆盖面 WP5.1；additive，旧插件零改动）。
 *
 * ## 为什么类型在这里再写一遍
 *
 * 宿主侧的菜单项模型住 `packages/app/src/ui/context-menu-model.ts`，但插件**禁止** import
 * app（解耦审计 B/C：插件只能 import `@kojo/plugin-api`）。所以本文件把那份模型里
 * 与「长什么样」有关的部分**同形**搬过来：字段名、语义、可选性逐字一致，
 * 由宿主桥接层（`packages/app/src/ui/plugin-context-menu-bridge.ts`）做零拷贝透传。
 *
 * 两条纪律（与宿主模型同款，不是新规矩）：
 * 1. **文案全中文**：label 必须含中日韩统一表意文字（`hasCjkLabel` 可自查）。宿主桥接层
 *    会把非中文项整项丢弃并告警——插件自己先保证，别把丢弃留给最后一站；
 * 2. **不可用要说话**：`disabled: true` 必须给 `disabledReason`（人话），宿主会把它写进
 *    `title` 与 `aria-description`。灰着不说话的项等于「按了没反应」。
 *
 * ## 能力是可选的
 *
 * 宿主经 `UIPanelProps.openContextMenu` 注入能力（旧宿主不提供 ⇒ `undefined`）。
 * 插件必须写成 `props.openContextMenu?.(...)`：缺席即降级为「没有右键菜单」，
 * **不许**抛错、也不许自己造一套浮层。
 */

/**
 * 一条插件菜单项（与宿主 `ContextMenuItem` 同形）。
 *
 * 动作不分发在项上，而是由 {@link PluginContextMenuRequest.onSelect} 统一接线
 * ——菜单项只描述「叫什么 / 长什么样 / 能不能按」，这样一条菜单可以被静态渲染判据。
 */
export interface PluginContextMenuItem {
  /** 菜单内唯一 id（选中时回传给 `onSelect`；同一份菜单里必须唯一） */
  readonly id: string;
  /** 用户可见文案（**必须中文**） */
  readonly label: string;
  /** 宿主内置图标名（`icons.tsx` 注册名）；不命中时按字形渲染 */
  readonly icon?: string;
  /** 右侧快捷键提示（纯展示；没有真实键位就不要写） */
  readonly shortcut?: string;
  /** 破坏性动作（危险色 + 勾选列的 `!` 提示） */
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** `disabled: true` 时必填的禁用原因（人话，上屏为 title / aria-description） */
  readonly disabledReason?: string;
  /** 选中态（勾选列打勾） */
  readonly checked?: boolean;
  /** 在这一项之前画分隔线（首项的分隔线由渲染侧吞掉） */
  readonly dividerBefore?: boolean;
  /** 分组标题：连续同 `group` 的项归一段 */
  readonly group?: string;
  /** 子菜单 */
  readonly children?: readonly PluginContextMenuItem[];
}

/**
 * 一次右键菜单请求（插件 → 宿主）。
 *
 * 坐标是**视口坐标**（`MouseEvent.clientX/clientY`）；宿主负责夹取到视口内。
 * `onSelect` 只会收到本请求 `items`（含子菜单）里出现过的 id。
 */
export interface PluginContextMenuRequest {
  readonly x: number;
  readonly y: number;
  readonly items: readonly PluginContextMenuItem[];
  /** 菜单的无障碍名称（中文，例如「市场菜单」） */
  readonly ariaLabel: string;
  readonly onSelect: (id: string) => void;
}

/**
 * 面板拿到的右键菜单能力（宿主注入；`UIPanelProps.openContextMenu` 的类型）。
 *
 * 独立成接口是为了让「非面板」的装配点（如 editor 槽贡献）也能按同一形状注入，
 * 不必再引一份结构相同的函数类型。
 */
export interface PluginContextMenuCapability {
  openContextMenu(request: PluginContextMenuRequest): void;
}

/**
 * label 是否含中日韩统一表意文字（中文文案的判据；空串 / 纯符号 / 纯英文 = false）。
 *
 * 与宿主 `isChineseMenuLabel` 同一口径——插件自查、桥接层过滤、渲染前闸门三处
 * 必须是同一条判据，否则会出现「插件以为合格、宿主却丢了」的静默失踪。
 */
export function hasCjkLabel(label: string): boolean {
  return /[\u4e00-\u9fff]/.test(label);
}

/**
 * 触发点（右键事件里插件需要的全部信息；结构类型，插件 tsconfig 无 DOM lib 也能用）。
 */
export interface PluginContextMenuAnchor {
  readonly clientX: number;
  readonly clientY: number;
  preventDefault?(): void;
  /**
   * 阻断冒泡（可选）。面板根与行/格各自挂了菜单时**必须**停在这里：否则同一发右键
   * 会依次触发行菜单与面板菜单，后者把前者顶掉（宿主只有一个菜单实例）。
   */
  stopPropagation?(): void;
}

/**
 * 「把这份菜单交给宿主」的**唯一**发起口（面板里的 onContextMenu 就调这一条）。
 *
 * 三件事一次做对，免得 11 个面板各写一份：
 * 1. 宿主没注入能力（旧宿主 / 纯渲染环境）⇒ 直接返回 false，**不抛错、不自造浮层**；
 * 2. 空菜单 ⇒ 不弹（这一级「没话说」等于没按到，空壳菜单比没有更糟）；
 * 3. 真发起时先 `preventDefault()` + `stopPropagation()`——阻断 WebView2 默认菜单与「开不开我们的菜单」是两件事；
 *    停冒泡是为了让**最近的一级**（格子 / 行）赢：面板根上也挂了菜单时，冒泡过去就会把它顶掉。
 */
export function requestPluginMenu(
  host: { readonly openContextMenu?: (request: PluginContextMenuRequest) => void },
  anchor: PluginContextMenuAnchor,
  items: readonly PluginContextMenuItem[],
  ariaLabel: string,
  onSelect: (id: string) => void,
): boolean {
  if (host.openContextMenu === undefined || items.length === 0) return false;
  anchor.preventDefault?.();
  anchor.stopPropagation?.();
  host.openContextMenu({
    x: anchor.clientX,
    y: anchor.clientY,
    items,
    ariaLabel,
    onSelect,
  });
  return true;
}

/** 剪贴板写入的最小形状（结构类型：插件 tsconfig 无 DOM lib，也不该为复制引一份 lib） */
interface ClipboardLike {
  writeText?(text: string): Promise<void>;
}

/**
 * 复制文本到剪贴板（「复制…」类菜单项的唯一落点）。
 *
 * 返回是否**真的**写成功：环境没有 `navigator.clipboard`（旧 WebView / 无 DOM 的测试）
 * 或被权限拒绝 ⇒ `false`。调用方据此给一句人话（铁律 4：按了没反应必须说清为什么）。
 *
 * 为什么放在契约层：11 个面板都要「复制路径 / 复制 ID / 复制值」，各写一份
 * `globalThis.navigator as ...` 的强转必然各自漂（与 `attachGrowSentinel` 同一理由）。
 */
export function copyTextToClipboard(text: string): Promise<boolean> {
  const nav = (globalThis as { navigator?: { clipboard?: ClipboardLike } }).navigator;
  const clipboard = nav?.clipboard;
  const write = clipboard?.writeText;
  if (clipboard === undefined || typeof write !== 'function') return Promise.resolve(false);
  try {
    return Promise.resolve(write.call(clipboard, text)).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}
