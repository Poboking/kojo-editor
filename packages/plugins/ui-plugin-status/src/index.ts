import { createElement, useEffect, useState } from 'react';
import type { Plugin, PluginRegistry, PluginStateRecord } from '@kojo/plugin-api';

/**
 * 插件状态面板（`ui.panel` 槽贡献）。
 *
 * 设计依据（架构文档 §4）：内核强制保证插件状态**永远可查**（数据源 `kernel.plugins`），
 * 面板本身作为普通插件实现——即使本插件被禁用，宿主仍有兜底展示（app 层职责）。
 * 组件用 `createElement` 而非 JSX 编写：插件包不引入 jsx 编译配置，保持最小依赖面。
 */

const STATUS_LABEL: Record<PluginStateRecord['status'], string> = {
  pending: '待接线',
  active: '运行中',
  inactive: '未激活',
  error: '错误',
  stopped: '已停止',
};

function statusColor(status: PluginStateRecord['status']): string {
  switch (status) {
    case 'active':
      return '#4fc08d';
    case 'error':
      return '#e06c75';
    case 'inactive':
      return '#d19a66';
    default:
      return '#888';
  }
}

export function createUiStatusPlugin(): Plugin {
  return {
    id: 'ui-plugin-status',
    version: '0.1.0',
    requires: ['kernel.plugins'],
    activate(ctx) {
      const registry = ctx.inject<PluginRegistry>('kernel.plugins');

      function StatusPanel(): unknown {
        const [rows, setRows] = useState<PluginStateRecord[]>(() => registry.list());

        useEffect(() => {
          const refresh = (): void => setRows(registry.list());
          refresh();
          const un = ctx.bus.on('plugin.statusChanged', refresh);
          return () => {
            un();
          };
        }, []);

        return createElement(
          'div',
          { className: 'panel-plugin-status' },
          createElement(
            'div',
            { className: 'panel-header' },
            `插件 (${rows.filter((r) => r.status === 'active').length}/${rows.length} 运行中)`,
          ),
          createElement(
            'ul',
            { className: 'plugin-list' },
            ...rows.map((r) =>
              createElement(
                'li',
                { key: r.id, className: `plugin-row plugin-${r.status}` },
                createElement('span', {
                  className: 'plugin-dot',
                  style: { backgroundColor: statusColor(r.status) },
                }),
                createElement('span', { className: 'plugin-id' }, r.id),
                createElement(
                  'span',
                  { className: 'plugin-status' },
                  STATUS_LABEL[r.status] + (r.status === 'inactive' && r.missing?.length ? `（缺 ${r.missing.join(', ')}）` : ''),
                ),
                r.status === 'error'
                  ? createElement('span', { className: 'plugin-error', title: r.error ?? '' }, r.error ?? '')
                  : null,
              ),
            ),
          ),
        );
      }

      ctx.slots.register('ui.panel', {
        id: 'plugin-status',
        title: '插件状态',
        icon: '◈',
        order: 100,
        component: StatusPanel,
      });
    },
  };
}
