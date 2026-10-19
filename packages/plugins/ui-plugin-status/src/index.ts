import { createElement, useEffect, useState, type ReactElement } from 'react';
import type { OpJournal, Plugin, PluginRegistry, PluginStateRecord } from '@kojo/plugin-api';
import { KernelServices } from '@kojo/plugin-api';
import {
  opsMaintenanceText,
  opsMaintenanceTone,
  readOpsMaintenance,
  type OpsMaintenanceRead,
  type OpsMaintenanceTone,
} from './maintenance';

/**
 * 插件状态面板（`ui.panel` 槽贡献）。
 *
 * 设计依据（架构文档 §4）：内核强制保证插件状态**永远可查**（数据源 `kernel.plugins`），
 * 面板本身作为普通插件实现——即使本插件被禁用，宿主仍有兜底展示（app 层职责）。
 * 组件用 `createElement` 而非 JSX 编写：插件包不引入 jsx 编译配置，保持最小依赖面。
 *
 * 第二路读数（additive）：批操作维护记录——`ops/` 目录里的崩溃 / 回滚失败残留
 * 不进操作历史、不响应 undo，只有这个数能让它被看见（铁律 4；读数口径见 `./maintenance.ts`）。
 * 面向作者呈现时**只说中文人话**（「维护记录：N 条」），五项明细收进默认折叠的"详情"里，
 * 不再把内部术语摆到面板表面。
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

/** ops journal 读数三态的色（与 `plugin-dot` 同一调色板；`unknown` 用错误色——读不出不等于干净） */
const TONE_COLOR: Record<OpsMaintenanceTone, string> = {
  residue: '#d19a66',
  clean: '#888',
  unknown: '#e06c75',
};

/**
 * ops 维护记录读数 → 一行 DOM（纯呈现、无 hooks；读数口径见 `./maintenance.ts`）。
 * 崩溃 / 回滚失败留在 `ops/` 里的东西**不进历史、不响应 undo**，只有这个数字会说话
 * （铁律 4）：读不出就写「未知 + 原因」，永远不许把整行省掉冒充干净。
 * 表面一行中文人话（`opsMaintenanceText`），五项明细收进默认折叠的详情体——
 * 内部术语不再喧宾，但"未知"态依然整行醒目（unknown 用错误色）。
 */
export function opsMaintenanceRow(read: OpsMaintenanceRead | null): ReactElement {
  const tone = opsMaintenanceTone(read);
  const detail = read?.detail ?? '巡检尚未完成，稍后自动刷新';
  return createElement(
    'details',
    {
      className: `panel-ops-maintenance panel-ops-maintenance-${tone}`,
      title: detail,
      style: { color: TONE_COLOR[tone], fontSize: '12px' },
    },
    createElement('summary', { style: { cursor: 'pointer' } }, opsMaintenanceText(read)),
    createElement(
      'div',
      {
        className: 'panel-ops-maintenance-detail',
        style: { marginTop: '2px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
      },
      detail,
    ),
  );
}

/**
 * 错误行的完整错误文本（纯函数，单测钉死）：恒有全文可取——
 * 截断的省略号行 hover 靠 `title` 复原，展开的详情体保证无 JS 提示的触屏也能读。
 */
export function pluginErrorText(error: string | undefined): string {
  return error && error.length > 0 ? error : '（内核未给出错误详情）';
}

/** 错误行 DOM：单行省略号 + title 复原 + 点击展开全文（details/summary，默认收起）。 */
export function pluginErrorNode(error: string | undefined): ReactElement {
  const full = pluginErrorText(error);
  return createElement(
    'details',
    { className: 'plugin-error-details', style: { flexBasis: '100%' } },
    createElement(
      'summary',
      {
        className: 'plugin-error',
        title: full,
        style: {
          cursor: 'pointer',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
      },
      full,
    ),
    createElement(
      'div',
      {
        className: 'plugin-error-full',
        style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#e06c75', fontSize: '12px' },
      },
      full,
    ),
  );
}

export function createUiStatusPlugin(): Plugin {
  return {
    id: 'ui-plugin-status',
    version: '0.1.0',
    requires: ['kernel.plugins'],
    activate(ctx) {
      const registry = ctx.inject<PluginRegistry>('kernel.plugins');
      // 批操作 journal（additive 可选）：内核恒注册 `kernel.ops`，但测试壳 / 旧内核可能没有
      // ——缺席时这一行整条不渲染（没有 journal 就没有残留可言），绝不假装"0 条干净"。
      // 不写 optionalRequires：内核 runtime 不消费它（软依赖的生效通道就是 tryInject）。
      const ops = ctx.tryInject<OpJournal>(KernelServices.Ops);

      function StatusPanel(): unknown {
        const [rows, setRows] = useState<PluginStateRecord[]>(() => registry.list());
        const [maintenance, setMaintenance] = useState<OpsMaintenanceRead | null>(null);

        useEffect(() => {
          const refresh = (): void => setRows(registry.list());
          refresh();
          const un = ctx.bus.on('plugin.statusChanged', refresh);
          return () => {
            un();
          };
        }, []);

        // 计数只在 `list()` 巡检时刷新 ⇒ 面板自己巡检一次（挂载 + 插件状态变化时），
        // 不靠"别人恰好打开过操作历史"（那种读数会把残留藏成 0）。
        useEffect(() => {
          if (!ops) return;
          let alive = true;
          const refresh = (): void => {
            void readOpsMaintenance(ops).then((r) => {
              if (alive) setMaintenance(r);
            });
          };
          refresh();
          const un = ctx.bus.on('plugin.statusChanged', refresh);
          return () => {
            alive = false;
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
          ops ? opsMaintenanceRow(maintenance) : null,
          createElement(
            'ul',
            { className: 'plugin-list' },
            ...rows.map((r) =>
              createElement(
                'li',
                { key: r.id, className: `plugin-row plugin-${r.status}` },
                createElement('span', { className: 'plugin-dot', style: { backgroundColor: statusColor(r.status) } }),
                createElement('span', { className: 'plugin-id', title: r.id }, r.id),
                createElement(
                  'span',
                  {
                    className: 'plugin-status',
                    title:
                      r.status === 'inactive' && r.missing?.length
                        ? `未激活：缺少依赖 ${r.missing.join('、')}`
                        : STATUS_LABEL[r.status],
                  },
                  STATUS_LABEL[r.status] + (r.status === 'inactive' && r.missing?.length ? `（缺 ${r.missing.join(', ')}）` : ''),
                ),
                r.status === 'error' ? pluginErrorNode(r.error) : null,
              ),
            ),
          ),
        );
      }

      ctx.slots.register('ui.panel', {
        id: 'plugin-status',
        title: '插件状态',
        icon: 'module',
        order: 100,
        // UI 重设计批 P1：开发者面板 → 活动栏底部齿轮位，默认不激活（定稿 §四）
        defaultActive: false,
        component: StatusPanel,
      });
    },
  };
}
