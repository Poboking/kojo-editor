import { memo, type ComponentType, type ReactElement } from 'react';
import type { UIPanelContribution, UIPanelProps } from '@kojo/plugin-api';
import { Icon } from './icons';

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
 */

/** 图标桥的唯一实现：贡献方拿到图标名，宿主决定怎么画（模块级常量 ⇒ 引用恒稳定） */
const renderIcon = (name: string, size?: number): ReactElement => <Icon name={name} size={size} />;

export interface PanelBodyProps {
  contribution: Pick<UIPanelContribution, 'id' | 'component'>;
  /** 浮窗态（2026-10-14 UI 浮动批）：面板正渲染在可移动浮窗里时转发给贡献方，供其调整自身 chrome */
  floating?: boolean;
  /**
   * 宿主下传的 UI 偏好投影（2026-10-14 面板偏好批）：转发给贡献方（`UIPanelProps.uiPrefs`）。
   *
   * **可选**：缺省时不注入字段——贡献方按契约把「缺省」当最保守值（如 `panelVirtualize`
   * 缺省即 `false` = 全量渲染 = 改动前行为）。宿主不必在此兜默认；语义由契约钉死。
   */
  uiPrefs?: UiPrefs;
}

/**
 * `React.memo` 比较器（导出仅为单测；语义 = 浅比较）。
 *
 * 三条 props 的引用契约（ShellLayout 侧已满足，改动时先对照这里）：
 * - `contribution`：逐面板对象恒稳定（`slots.query` 的贡献对象 / builtinViews 的 useMemo
 *   同引用穿过 organizePanels——只排序不过滤拷贝）；
 * - `uiPrefs`：壳层 `useMemo(() => ({ panelVirtualize }), [panelVirtualize])`——
 *   开关不动则同引用（**不可写成每次渲染现建的对象字面量**，那样 memo 必失效）；
 * - `floating`：布尔 / undefined 原始值；`renderIcon` 不在 props 里（本组件内部注入模块常量）。
 */
export function panelBodyPropsEqual(a: PanelBodyProps, b: PanelBodyProps): boolean {
  return a.contribution === b.contribution && a.floating === b.floating && a.uiPrefs === b.uiPrefs;
}

function PanelBodyView({ contribution, floating, uiPrefs }: PanelBodyProps): ReactElement {
  const Comp = contribution.component as ComponentType<UIPanelProps>;
  return (
    <div className={`panel panel-${contribution.id}`}>
      <Comp renderIcon={renderIcon} {...(floating ? { floating: true } : {})} {...(uiPrefs ? { uiPrefs } : {})} />
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
