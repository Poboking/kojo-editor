import { createElement, useEffect, useState, type ReactElement } from 'react';
import type {
  OpJournal,
  Plugin,
  PluginContextMenuAnchor,
  PluginRegistry,
  PluginStateRecord,
  UIPanelProps,
} from '@kojo/plugin-api';
import { KernelServices } from '@kojo/plugin-api';
import {
  copyPluginId,
  openPluginPanelMenu,
  openPluginRowMenu,
  type PluginStatusMenuHost,
} from './context-menu';
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

/**
 * 状态点／状态行的色（视觉批十二 · BOARD `VIS-CONTRAST`）：只点 CSS 变量的名。
 *
 * 原先这里与下面 `TONE_COLOR` 各写一份裸 hex（`#4fc08d/#e06c75/#d19a66/#888`），内联进 DOM
 * 就绕过了主题——浅色档实测 `#888` 压 `#eaeef2` 只有 **3.04:1**（正文需 4.5），而 `--fg-dim`
 * 在浅色档是 `#59636e`（5.24:1）。三档色值真源只在 `tokens.css` + `themes/*.css`。
 */
function statusColor(status: PluginStateRecord['status']): string {
  switch (status) {
    case 'active':
      return 'var(--success)';
    case 'error':
      return 'var(--danger-text)';
    case 'inactive':
      return 'var(--warning)';
    default:
      return 'var(--fg-dim)';
  }
}

/**
 * 一行的悬停文本（视觉批十一 R5 · 状态文字不再逐行重复上屏）。
 *
 * 绿点已经承载了「运行中」这一档（20 行面板里逐行写同一三个汉字是噪音），异常态
 * 照旧把词写在行末——那些是必须看见的东西。收起来的字一条不丢：整行悬停查得到，
 * DOM 里的状态词也只做**视觉隐藏**（读屏逐行仍念，见 `shell-notices.css` 的
 * `.plugin-status-quiet`）。未激活的缺依赖明细原来就写在词后面，现在同样进悬停。
 */
export function pluginRowTooltip(r: PluginStateRecord): string {
  const missing = r.status === 'inactive' && r.missing?.length ? `：缺少依赖 ${r.missing.join('、')}` : '';
  return `${r.id} · ${STATUS_LABEL[r.status]}${missing}`;
}

/** 静息档（只有 `active`）：状态文字退成悬停/读屏里的信息，屏上只留点与名字。 */
export function isQuietStatus(status: PluginStateRecord['status']): boolean {
  return status === 'active';
}

/** ops journal 读数三态的色（与 `plugin-dot` 同一调色板；`unknown` 用错误色——读不出不等于干净） */
const TONE_COLOR: Record<OpsMaintenanceTone, string> = {
  residue: 'var(--warning)',
  clean: 'var(--fg-dim)',
  unknown: 'var(--danger-text)',
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
        style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--danger-text)', fontSize: '12px' },
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

      function StatusPanel(props: UIPanelProps): unknown {
        const [rows, setRows] = useState<PluginStateRecord[]>(() => registry.list());
        const [maintenance, setMaintenance] = useState<OpsMaintenanceRead | null>(null);
        /** 右键菜单动作的回执（复制成功/失败一句话；空串 = 没有话要说） */
        const [note, setNote] = useState('');

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

        /**
         * 右键菜单的动作落点（1023 批）：能力全在 `PluginRegistry` 上，面板只转发。
         * 失败一律写进 `note`（一行人话）——「按了没反应」在这块面板上最不可接受：
         * 作者来这里就是为了查"到底哪里不对"。
         */
        const menuHost: PluginStatusMenuHost = {
          copy: (text) => {
            void copyPluginId(text).then((ok) => {
              if (ok) {
                setNote(`已复制「${text}」`);
                return;
              }
              setNote('复制失败：当前环境不允许写剪贴板');
              ctx.log.warn('复制插件 ID 失败：剪贴板不可用');
            });
          },
          retry: (id) => {
            setNote(`正在重试「${id}」…`);
            void registry.retry(id).then(
              () => setNote(''),
              (err: unknown) => {
                const text = err instanceof Error ? err.message : String(err);
                setNote(`重试「${id}」没有成功：${text}`);
                ctx.log.warn(`重试插件 ${id} 失败：${text}`);
              },
            );
          },
          stop: (id) => {
            setNote(`正在停用「${id}」…`);
            void registry.stop(id).then(
              () => setNote(''),
              (err: unknown) => {
                const text = err instanceof Error ? err.message : String(err);
                setNote(`停用「${id}」没有成功：${text}`);
                ctx.log.warn(`停用插件 ${id} 失败：${text}`);
              },
            );
          },
          refresh: () => setRows(registry.list()),
        };

        return createElement(
          'div',
          {
            className: 'panel-plugin-status',
            // 空白处右键（1023 批）：面板级菜单只有一条真能力——重读插件清单
            onContextMenu: (e: PluginContextMenuAnchor) => openPluginPanelMenu(props, e, menuHost),
          },
          createElement(
            'div',
            { className: 'panel-header' },
            `插件 (${rows.filter((r) => r.status === 'active').length}/${rows.length} 运行中)`,
          ),
          ops ? opsMaintenanceRow(maintenance) : null,
          note === '' ? null : createElement('div', { className: 'panel-note dim small' }, note),
          createElement(
            'ul',
            { className: 'plugin-list' },
            ...rows.map((r) =>
              createElement(
                'li',
                {
                  key: r.id,
                  className: `plugin-row plugin-${r.status}`,
                  // 整行悬停 = 「这一行是什么状态」的唯一去处（静息档的状态词不再上屏）
                  title: pluginRowTooltip(r),
                  // 行级右键：复制 ID / 重试激活 / 停用 / 刷新（按状态决定哪些项存在）
                  onContextMenu: (e: PluginContextMenuAnchor) =>
                    openPluginRowMenu(props, e, { id: r.id, status: r.status }, menuHost),
                },
                createElement('span', { className: 'plugin-dot', style: { backgroundColor: statusColor(r.status) } }),
                // 形态不许拆（`machine-identifier-copy` 的③合法露面台账按这一整行钉 id 上屏的豁免）：
                // 悬停名字 = 唯一定位符本体；悬停行的其它处 = `pluginRowTooltip` 那句「id · 状态」。
                createElement('span', { className: 'plugin-id', title: r.id }, r.id),
                createElement(
                  'span',
                  {
                    // 静息档只把词留给读屏与悬停（类名 → `shell-notices.css` 的 clip 配方）
                    className: isQuietStatus(r.status) ? 'plugin-status plugin-status-quiet' : 'plugin-status',
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
