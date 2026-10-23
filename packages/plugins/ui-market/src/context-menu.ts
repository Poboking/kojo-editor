/**
 * 口上市场面板的右键菜单（1023 批 · 右键覆盖面 WP5.2）。
 *
 * 只挂面板**已有**的动作（安装 / 更新 / 卸载 / 导入 / 打开来源 / 展开详情 / 拉取 / 发布）：
 * 菜单不新造业务，只把同一件事换个入口——按钮与菜单指向同一个函数，才不会有"按钮能装、
 * 菜单装不了"的分叉。
 *
 * 发起口不在这里：市场的右键走**宿主面路由**（`data-context-surface="market"`，面子在
 * `market-panel.ts` 顶层登记，行身份住 `data-market-row` / `data-market-key`）。
 * 本模块因此只剩判据（build*）与分发（run*）两张纯函数表，node 侧可直测。
 *
 * 文案取既有常量（`ACTION_LABEL` / `IMPORT_LABEL`）：市场里"装/更新/导入"这几个词
 * 只许有一份写法，菜单不许自己再编一套。
 */
import { copyTextToClipboard, type PluginContextMenuItem } from '@kojo/plugin-api';
import { ACTION_LABEL, IMPORT_LABEL, type PackRowAction } from './market-view';

/** 索引行（可安装 / 可更新 / 本机已是最新） */
export interface MarketIndexRowTarget {
  readonly kind: 'index';
  /** `indexRowKey(entry)`（面板据此回查行） */
  readonly key: string;
  /** 包 id（机器名；复制项用它） */
  readonly packId: string;
  /** 显示名（菜单标题里不用它，只给"详情"这类需要人话的地方） */
  readonly label: string;
  readonly action: PackRowAction;
  readonly sourceUrl?: string;
  readonly expanded: boolean;
}

/** 已装行 */
export interface MarketInstalledRowTarget {
  readonly kind: 'installed';
  readonly key: string;
  readonly packId: string;
  readonly label: string;
  readonly expanded: boolean;
}

export type MarketRowTarget = MarketIndexRowTarget | MarketInstalledRowTarget;

/** 菜单动作的落点（面板注入） */
export interface MarketMenuHost {
  install(target: MarketIndexRowTarget): void;
  requestUninstall(key: string): void;
  importInstalled(key: string): void;
  toggleDetail(key: string): void;
  openSource(url: string): void;
  pull(): void;
  publish(): void;
  copy(text: string): void;
}

/** 「查看详情 / 收起详情」同一 id 换文案（展开态是事实，不是两种能力） */
function detailItem(expanded: boolean): PluginContextMenuItem {
  return {
    id: 'market.detail',
    label: expanded ? '收起详情' : '查看详情',
    icon: expanded ? 'chevron-down' : 'chevron-right',
    group: '条目',
  };
}

/** 没有来源网址时：整项禁用并说明（不是"没有这条能力"——是这一条没登记） */
function noSourceReason(): Pick<PluginContextMenuItem, 'disabled' | 'disabledReason'> {
  return { disabled: true, disabledReason: '这个包没有登记来源网址' };
}

/** 索引行菜单（判据层，纯函数） */
export function buildMarketIndexRowMenu(target: MarketIndexRowTarget): PluginContextMenuItem[] {
  const items: PluginContextMenuItem[] = [];
  // 三种动作态由契约的 `packUpdateCheck` 判定；`none` 行本来就没有可点的安装动作
  // ⇒ 菜单里也整项不出现（能力不存在 ≠ 暂时按不了）。
  if (target.action !== 'none') {
    items.push({
      id: `market.${target.action}`,
      label: `${ACTION_LABEL[target.action]}此包`,
      group: '安装',
    });
  }
  items.push(
    { id: 'market.copyId', label: '复制插件 ID', dividerBefore: true, group: '条目' },
    { id: 'market.copyName', label: '复制插件名' },
    detailItem(target.expanded),
  );
  const hasSource = target.sourceUrl !== undefined && target.sourceUrl !== '';
  items.push(
    hasSource
      ? { id: 'market.copyUrl', label: '复制链接', dividerBefore: true, group: '来源' }
      : { id: 'market.copyUrl', label: '复制链接', dividerBefore: true, group: '来源', ...noSourceReason() },
    hasSource
      ? { id: 'market.openSource', label: '打开来源', icon: 'popout' }
      : { id: 'market.openSource', label: '打开来源', ...noSourceReason() },
  );
  return items;
}

/** 已装行菜单（判据层，纯函数） */
export function buildMarketInstalledRowMenu(target: MarketInstalledRowTarget): PluginContextMenuItem[] {
  return [
    { id: 'market.import', label: IMPORT_LABEL, icon: 'files', group: '已装' },
    { id: 'market.copyId', label: '复制插件 ID', dividerBefore: true, group: '条目' },
    { id: 'market.copyName', label: '复制插件名' },
    detailItem(target.expanded),
    { id: 'market.uninstall', label: '卸载…', icon: 'trash', danger: true, dividerBefore: true, group: '危险' },
  ];
}

/** 面板空白处菜单（判据层，纯函数） */
export function buildMarketPanelMenu(): PluginContextMenuItem[] {
  return [
    { id: 'market.pull', label: '拉取列表', icon: 'refresh', group: '面板' },
    { id: 'market.publish', label: '发布口上…' },
  ];
}

/** 行菜单的入口（不分种类，接线层只调这一个） */
export function buildMarketRowMenu(target: MarketRowTarget): PluginContextMenuItem[] {
  return target.kind === 'index'
    ? buildMarketIndexRowMenu(target)
    : buildMarketInstalledRowMenu(target);
}

/** 分发一条行 id；返回是否被本面消费 */
export function runMarketRowAction(
  id: string,
  target: MarketRowTarget,
  host: MarketMenuHost,
): boolean {
  switch (id) {
    case 'market.install':
    case 'market.update':
      if (target.kind !== 'index' || target.action === 'none') return false;
      if (id !== `market.${target.action}`) return false;
      host.install(target);
      return true;
    case 'market.copyId':
      host.copy(target.packId);
      return true;
    case 'market.copyName':
      host.copy(target.label);
      return true;
    case 'market.detail':
      host.toggleDetail(target.key);
      return true;
    case 'market.copyUrl':
    case 'market.openSource': {
      if (target.kind !== 'index') return false;
      const url = target.sourceUrl;
      if (url === undefined || url === '') return false;
      if (id === 'market.copyUrl') host.copy(url);
      else host.openSource(url);
      return true;
    }
    case 'market.import':
      if (target.kind !== 'installed') return false;
      host.importInstalled(target.key);
      return true;
    case 'market.uninstall':
      if (target.kind !== 'installed') return false;
      host.requestUninstall(target.key);
      return true;
    default:
      return false;
  }
}

/** 分发一条面板 id */
export function runMarketPanelAction(id: string, host: MarketMenuHost): boolean {
  switch (id) {
    case 'market.pull':
      host.pull();
      return true;
    case 'market.publish':
      host.publish();
      return true;
    default:
      return false;
  }
}

/** 复制动作的落点（面板注入的 `copy` 走这一条：剪贴板不可用时如实返回 false） */
export function copyMarketText(text: string): Promise<boolean> {
  return copyTextToClipboard(text);
}
