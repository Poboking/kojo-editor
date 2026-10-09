import type { ComponentType, ReactElement } from 'react';
import type { UIPanelContribution, UIPanelProps } from '@kojo/plugin-api';

/**
 * 槽位渲染宿主：把 `ui.panel` 贡献挂到 React 树。
 *
 * plugin-api 刻意不依赖 React（UIPanelComponent 是结构化函数类型），
 * app 壳在这里做类型转换——渲染绑定只属于宿主。
 */
export function PanelHost({ contribution }: { contribution: UIPanelContribution }): ReactElement {
  const Comp = contribution.component as ComponentType<UIPanelProps>;
  return (
    <section className={`panel panel-${contribution.id}`}>
      <h3>{contribution.title}</h3>
      <Comp />
    </section>
  );
}
