/**
 * 约定校验面板的右键菜单（1023 批 · 右键覆盖面 WP5.2）。
 *
 * 三类菜单，全部接在**已有**能力上（零新业务）：
 * - 条目行：跳到位置（本就有 `editor.revealLocation` 通道）· 复制问题（契约层剪贴板）；
 * - 分组头：展开/收起（本就有）· 复制分组名 · 重新校验；
 * - 面板空白处：三个分组视角（本就有 `setMode`）· 重新校验 · 叫停（在跑时）。
 *
 * 任务书里的「按规则过滤」**没有做**：这个面板没有"过滤"这一档状态（只有分组视角），
 * 造一个过滤态就是给菜单配一个只为菜单存在的功能——不改。
 */
import {
  copyTextToClipboard,
  requestPluginMenu,
  type PluginContextMenuItem,
  type UIPanelProps,
} from '@kojo/plugin-api';

/** 条目行菜单的无障碍名 */
export const CONVENTION_ISSUE_MENU_ARIA = '校验问题菜单';

/** 分组头菜单的无障碍名 */
export const CONVENTION_GROUP_MENU_ARIA = '校验分组菜单';

/** 面板空白处菜单的无障碍名 */
export const CONVENTION_PANEL_MENU_ARIA = '约定校验菜单';

/** 分组视角（与 `view.ts` 的 `GroupMode` 同集，但这里不 import 它：菜单层只认字符串） */
export type ConventionMenuMode = 'rule' | 'character' | 'family';

/** 视角的中文名（菜单标签；与工具条上的三枚按钮同一套词） */
export const CONVENTION_MODE_LABEL: Record<ConventionMenuMode, string> = {
  rule: '按规则看',
  character: '按角色看',
  family: '按家族看',
};

const MODE_ORDER: readonly ConventionMenuMode[] = ['rule', 'character', 'family'];

/** 一条问题在菜单里需要的全部上下文（不传整个 ConventionIssue：菜单不认它的全部字段） */
export interface IssueMenuTarget {
  readonly message: string;
  /** 文件路径；`null` / undefined = 这条问题没有定位（整项目结论） */
  readonly filePath?: string | null;
  readonly line?: number;
  readonly ruleId: string;
  /** 严重度的中文名（由调用方从既有映射取，不在菜单层抄第二份） */
  readonly severityLabel: string;
}

/** 分组头上下文 */
export interface GroupMenuTarget {
  readonly title: string;
  readonly expanded: boolean;
  readonly count: number;
}

/** 菜单动作的落点（面板注入） */
export interface ConventionMenuHost {
  openIssue(target: IssueMenuTarget): void;
  copy(text: string): void;
  rerun(): void;
  stop(): void;
  setMode(mode: ConventionMenuMode): void;
}

/** 「复制问题」的文本（纯函数：位置 + 规则 + 严重度 + 正文，一行放得下的顺序） */
export function issueCopyText(target: IssueMenuTarget): string {
  const loc =
    target.filePath === null || target.filePath === undefined
      ? ''
      : `${target.filePath}${target.line === undefined ? '' : `:${target.line}`} `;
  return `${loc}[${target.severityLabel}] ${target.ruleId} — ${target.message}`;
}

/** 这条问题能不能跳（没有文件定位就跳不了——这是能力缺失，不是"暂时按不了"） */
function canOpen(target: IssueMenuTarget): boolean {
  return target.filePath !== null && target.filePath !== undefined && target.filePath !== '';
}

/** 条目行菜单（判据层，纯函数） */
export function buildIssueMenu(target: IssueMenuTarget): PluginContextMenuItem[] {
  return [
    canOpen(target)
      ? { id: 'issue.open', label: '跳到位置', icon: 'target', group: '问题' }
      : {
          id: 'issue.open',
          label: '跳到位置',
          disabled: true,
          disabledReason: '这条问题没有文件定位（整项目结论，跳不过去）',
          group: '问题',
        },
    { id: 'issue.copy', label: '复制问题' },
  ];
}

/** 分组头菜单（判据层，纯函数） */
export function buildGroupMenu(target: GroupMenuTarget): PluginContextMenuItem[] {
  return [
    {
      id: 'group.toggle',
      label: target.expanded ? '收起本组' : '展开本组',
      icon: target.expanded ? 'chevron-down' : 'chevron-right',
      group: '分组',
    },
    { id: 'group.copyTitle', label: '复制分组名' },
    { id: 'panel.rerun', label: '重新校验', icon: 'refresh', dividerBefore: true },
  ];
}

/** 面板空白处菜单（判据层，纯函数；`running` 时才给「叫停」——没有可叫停的对象时不摆空按钮） */
export function buildConventionPanelMenu(
  mode: ConventionMenuMode,
  running: boolean,
): PluginContextMenuItem[] {
  const items: PluginContextMenuItem[] = MODE_ORDER.map((m) => ({
    id: `mode.${m}`,
    label: CONVENTION_MODE_LABEL[m],
    checked: m === mode,
    ...(m === 'rule' ? { group: '分组视角' } : {}),
  }));
  if (running) {
    items.push({ id: 'panel.stop', label: '叫停这一轮', dividerBefore: true, group: '校验' });
  }
  items.push({
    id: 'panel.rerun',
    label: '重新校验',
    icon: 'refresh',
    dividerBefore: !running,
    ...(running ? {} : { group: '校验' }),
  });
  return items;
}

/** 分发一条条目行 id；返回是否被本面消费 */
export function runIssueAction(
  id: string,
  target: IssueMenuTarget,
  host: ConventionMenuHost,
): boolean {
  switch (id) {
    case 'issue.open':
      if (!canOpen(target)) return false;
      host.openIssue(target);
      return true;
    case 'issue.copy':
      host.copy(issueCopyText(target));
      return true;
    default:
      return false;
  }
}

/** 分发一条分组头 id（`group.toggle` 不在这里：它改的是面板自己的展开集合，见 `openGroupMenu`） */
export function runGroupAction(id: string, target: GroupMenuTarget, host: ConventionMenuHost): boolean {
  switch (id) {
    case 'group.copyTitle':
      host.copy(target.title);
      return true;
    case 'panel.rerun':
      host.rerun();
      return true;
    default:
      return false;
  }
}

/** 分发一条面板 id */
export function runPanelAction(id: string, host: ConventionMenuHost): boolean {
  switch (id) {
    case 'mode.rule':
    case 'mode.character':
    case 'mode.family':
      host.setMode(id.slice('mode.'.length) as ConventionMenuMode);
      return true;
    case 'panel.rerun':
      host.rerun();
      return true;
    case 'panel.stop':
      host.stop();
      return true;
    default:
      return false;
  }
}

/** 接线层：条目行 */
export function openIssueMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  target: IssueMenuTarget,
  host: ConventionMenuHost,
): boolean {
  return requestPluginMenu(props, anchor, buildIssueMenu(target), CONVENTION_ISSUE_MENU_ARIA, (id) => {
    runIssueAction(id, target, host);
  });
}

/** 接线层：分组头（展开/收起由 `onToggle` 直接落地——那个状态住面板里，不经 host） */
export function openGroupMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  target: GroupMenuTarget,
  host: ConventionMenuHost,
  onToggle: () => void,
): boolean {
  return requestPluginMenu(props, anchor, buildGroupMenu(target), CONVENTION_GROUP_MENU_ARIA, (id) => {
    if (id === 'group.toggle') {
      onToggle();
      return;
    }
    runGroupAction(id, target, host);
  });
}

/** 接线层：面板空白处 */
export function openConventionPanelMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  mode: ConventionMenuMode,
  running: boolean,
  host: ConventionMenuHost,
): boolean {
  return requestPluginMenu(
    props,
    anchor,
    buildConventionPanelMenu(mode, running),
    CONVENTION_PANEL_MENU_ARIA,
    (id) => {
      runPanelAction(id, host);
    },
  );
}

/** 复制动作的落点 */
export function copyConventionText(text: string): Promise<boolean> {
  return copyTextToClipboard(text);
}
