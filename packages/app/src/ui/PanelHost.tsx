import type { ComponentType, ReactElement } from 'react';
import type { UIPanelContribution, UIPanelProps } from '@kojo/plugin-api';

/**
 * 槽位渲染宿主：把 `ui.panel` 贡献挂到 React 树。
 *
 * plugin-api 刻意不依赖 React（UIPanelComponent 是结构化函数类型），
 * app 壳在这里做类型转换——渲染绑定只属于宿主。
 *
 * UI 重设计批 P1 起：面板 chrome（标题/折叠/选项卡）由容器（ShellLayout）
 * 统一渲染，本组件只渲染面板体。保留 `panel panel-<id>` 类名——既有插件
 * 样式（如 `.panel-convention-report`）以此为锚。
 */
export function PanelBody({
  contribution,
}: {
  contribution: Pick<UIPanelContribution, 'id' | 'component'>;
}): ReactElement {
  const Comp = contribution.component as ComponentType<UIPanelProps>;
  return (
    <div className={`panel panel-${contribution.id}`}>
      <Comp />
    </div>
  );
}

/** 状态栏小型件宿主：不带面板容器类名（状态栏项是行内小件，非面板） */
export function StatusbarItem({
  contribution,
}: {
  contribution: Pick<UIPanelContribution, 'id' | 'component'>;
}): ReactElement {
  const Comp = contribution.component as ComponentType<UIPanelProps>;
  return (
    <span className={`sb-slot sb-slot-${contribution.id}`}>
      <Comp />
    </span>
  );
}
