import { memo, type ComponentType, type ReactElement } from 'react';
import type { UIPanelContribution, UIPanelProps } from '@kojo/plugin-api';
import { Icon } from './icons';
import { createPluginContextMenuBridge } from './plugin-context-menu-bridge';
// 三个属性名与面板面本身都来自这个模块：**import 它就是登记 `plugin-panel` 面**
// （`declareContextSurface` 在模块顶层，加载即登记）。PanelHost 必然被加载，故登记不会漏。
import {
  PLUGIN_PANEL_ID_ATTR,
  PLUGIN_PANEL_PLUGIN_ATTR,
  PLUGIN_PANEL_TITLE_ATTR,
} from './plugin-panel-menu';

/** 宿主下传的 UI 偏好投影类型（从契约字段派生——`UiPrefs` 未从 plugin-api 桶导出） */
type UiPrefs = NonNullable<UIPanelProps['uiPrefs']>;

/**
 * 槽位渲染宿主：把 `ui.panel` 贡献挂到 React 树。
 *
 * plugin-api 刻意不依赖 React（UIPanelComponent 是结构化函数类型），
 * app 壳在这里做类型转换——渲染绑定只属于宿主。
 *
 * UI 重设计批 P1 起：面板 chrome（标题/折叠/选项卡）由容器（ShellLayout）
 * 统一渲染，本组件只渲染面板体。保留 `panel panel-<id>` 类名——既有插件
 * 样式（如 `.panel-convention-report`）以此为锚。
 *
 * 教程批（2026-10-13）起：组件额外收到 `renderIcon`——把内置图标注册表
 * （`icons.tsx`）桥给贡献方。贡献方只拿到「名字 + 尺寸」这层契约，
 * 不认识宿主用的是什么图标库；缺省不注入时它须回退纯文本字形。
 *
 * 性能批（2026-10-16）：`PanelBody` / `StatusbarItem` 套 `React.memo`（显式比较器
 * `panelBodyPropsEqual`，可单测）。壳层因 index/dirty/editorStatus 等无关状态重渲时，
 * 挂载中的面板体不再跟着重渲——props 三件套的引用稳定性是前提，见比较器注释。
 *
 * PS-6（2026-10-20）把那条前提补全：宿主用可变 ref 桥 props 的面板（内建视图）三件套
 * 恒稳定 ⇒ memo 变成"永久跳过"，新值送不进去。比较器因此多认一格 `hostVersion`
 * ——由宿主在桥接内容变化时抬号。memo 依旧挡住无关重渲，但不再挡住真相。
 */

/** 图标桥的唯一实现：贡献方拿到图标名，宿主决定怎么画（模块级常量 ⇒ 引用恒稳定） */
const renderIcon = (name: string, size?: number): ReactElement => <Icon name={name} size={size} />;

/** 宿主版本闸的记账：`{ 当前计数, 上一次比过的依赖快照 }` */
export interface HostVersionState {
  readonly version: number;
  readonly deps: readonly unknown[];
}

/**
 * 版本闸的**判等步**（纯函数，可单测；PS-6 正确性修复的机制本体）。
 *
 * 依赖逐项 `Object.is` 比：任一项换了 ⇒ 计数 +1 并换掉快照；全同 ⇒ 原样返回同一格
 * （⇒ 宿主每渲一次但桥里没换东西时，memo 仍然照旧 bail，不白重渲面板）。
 *
 * 为什么要这么一格数字：内建视图把真状态桥在**可变 ref** 上（组件身份必须恒定，
 * 否则整棵树每帧重挂、展开态全丢），于是 `contribution` / `uiPrefs` / `floating`
 * 三条对它永远相等 ⇒ `PanelBody` 的 memo 永久跳过 ⇒ 桥后面的新值一次也送不进去。
 * 见 `panelBodyPropsEqual` 的 `hostVersion` 那条。
 */
export function hostVersionStep(prev: HostVersionState, deps: readonly unknown[]): HostVersionState {
  if (prev.deps.length === deps.length) {
    let same = true;
    for (let i = 0; i < deps.length; i++) {
      if (!Object.is(prev.deps[i], deps[i])) {
        same = false;
        break;
      }
    }
    if (same) return prev;
  }
  return { version: prev.version + 1, deps };
}

export interface PanelBodyProps {
  /**
   * `title` / `pluginId` 是 1023 覆盖面批扩的（additive，两个字段都只是读）：
   * - `title`：插件面板的宿主级右键要能"复制面板名"；
   * - `pluginId`：**区分插件面板与内建视图的唯一判据**（注册时由内核注入；内建视图没有）。
   *   只有插件面板才挂 `plugin-panel` 面——内建视图（搜索结果 / 问题 / 预览…）各有各的面，
   *   在这里统一挂一个父面会按 `closest` 的「最近祖先」规则**遮蔽**掉它们自己。
   */
  contribution: Pick<UIPanelContribution, 'id' | 'component'> & {
    /** 面板名（插件面板一定有；`OverlayContribution` 这类宿主内建贡献可以没有） */
    readonly title?: string;
    /** 内核注册时注入的插件 id。**有没有它是「插件面板 / 内建视图」的唯一判据** */
    readonly pluginId?: string;
  };
  /** 浮窗态（2026-10-14 UI 浮动批）：面板正渲染在可移动浮窗里时转发给贡献方，供其调整自身 chrome */
  floating?: boolean;
  /**
   * 宿主下传的 UI 偏好投影（2026-10-14 面板偏好批）：转发给贡献方（`UIPanelProps.uiPrefs`）。
   *
   * **可选**：缺省时不注入字段——贡献方按契约把「缺省」当最保守值（如 `panelVirtualize`
   * 缺省即 `false` = 全量渲染 = 改动前行为）。宿主不必在此兜默认；语义由契约钉死。
   */
  uiPrefs?: UiPrefs;
  /**
   * **宿主版本计数**（PS-6 正确性修复，2026-10-20）：面板把真状态桥接在可变 ref 上时
   * （内建视图就是这种形态：`component` 身份必须恒定，否则整棵树每次重挂），
   * 三条既有 props 永远同引用 ⇒ memo 永久 bail ⇒ 桥后面的新值根本送不进去。
   * 宿主每次改动桥接内容就**抬一次这个数字**，memo 才有地方看见变化。
   *
   * 缺省 `0` = 本面板没有桥接态（插件面板的常态：自己订阅内核），行为与改动前逐字一致。
   * 计数只要求"变化时不同"，不要求连续，也不进贡献方契约（面板本体读不到它）。
   */
  hostVersion?: number;
}

/**
 * `React.memo` 比较器（导出仅为单测；语义 = 浅比较）。
 *
 * 四条 props 的引用契约（ShellLayout / ProjectView 侧已满足，改动时先对照这里）：
 * - `contribution`：逐面板对象恒稳定（`slots.query` 的贡献对象 / builtinViews 的 useMemo
 *   同引用穿过 organizePanels——只排序不过滤拷贝）；
 * - `uiPrefs`：壳层 `useMemo(() => ({ panelVirtualize }), [panelVirtualize])`——
 *   开关不动则同引用（**不可写成每次渲染现建的对象字面量**，那样 memo 必失效）；
 * - `floating`：布尔 / undefined 原始值；`renderIcon` 不在 props 里（本组件内部注入模块常量）；
 * - `hostVersion`：宿主侧的变化闸（见上面的注释）——**桥接 ref 的面板必须由宿主抬这一格**，
 *   否则 memo 永久 bail，定位到树（B4）/ 外部改动后重列（HK-5）/ 冷开快照转索引三件事
 *   全都失灵，直到某次偶然的组件重挂把它们"顺带"修好。
 */
export function panelBodyPropsEqual(a: PanelBodyProps, b: PanelBodyProps): boolean {
  return (
    a.contribution === b.contribution &&
    a.floating === b.floating &&
    a.uiPrefs === b.uiPrefs &&
    (a.hostVersion ?? 0) === (b.hostVersion ?? 0)
  );
}

function PanelBodyView({ contribution, floating, uiPrefs }: PanelBodyProps): ReactElement {
  const Comp = contribution.component as ComponentType<UIPanelProps>;
  // 右键菜单通道（1023 批）：按面板 id 取一个**引用稳定**的桥（`createPluginContextMenuBridge`
  // 内部复用），面板塞进 effect 依赖数组时不会反复重订阅。
  const openContextMenu = createPluginContextMenuBridge(contribution.id);
  // 插件面板才有宿主级兜底面（见 `PanelBodyProps.contribution` 的说明）：空白处右键给的是
  // 宿主能力（复制面板名 / 面板 ID / 插件 ID），行内业务动作仍归面板自己经 `openContextMenu`。
  const pluginPanelAttrs =
    contribution.pluginId === undefined
      ? {}
      : {
          'data-context-surface': 'plugin-panel',
          [PLUGIN_PANEL_ID_ATTR]: contribution.id,
          [PLUGIN_PANEL_TITLE_ATTR]: contribution.title ?? contribution.id,
          [PLUGIN_PANEL_PLUGIN_ATTR]: contribution.pluginId,
        };
  return (
    <div className={`panel panel-${contribution.id}`} {...pluginPanelAttrs}>
      <Comp
        renderIcon={renderIcon}
        openContextMenu={openContextMenu}
        {...(floating ? { floating: true } : {})}
        {...(uiPrefs ? { uiPrefs } : {})}
      />
    </div>
  );
}

export const PanelBody = memo(PanelBodyView, panelBodyPropsEqual);

/** 状态栏小型件宿主：不带面板容器类名（状态栏项是行内小件，非面板） */
export const StatusbarItem = memo(function StatusbarItem({
  contribution,
}: {
  contribution: Pick<UIPanelContribution, 'id' | 'component'>;
}): ReactElement {
  const Comp = contribution.component as ComponentType<UIPanelProps>;
  return (
    <span className={`sb-slot sb-slot-${contribution.id}`}>
      <Comp renderIcon={renderIcon} />
    </span>
  );
});
