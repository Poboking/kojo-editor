/**
 * 糖判定面板的右键菜单（1023 批 · 右键覆盖面 WP5.2）。
 *
 * 三个层级，动作全是**已有**的通道：
 * - **诊断行**：跳到源行（`editor.revealLocation`）· 复制诊断（严重度 + 位置 + 中文短名 + 正文）；
 * - **面板空白处**：刷新判定（本就有重算）· 切回源码 / 按语法糖显示
 *   （`editor.sugarView.set`，宿主落地、只影响显示）· 复制文件路径。
 *
 * 任务书里的「全选」「格式化」**没有做**：本插件没有"选中范围"这回事（面板是只读判定），
 * 也没有独立的格式化通道（格式化只发生在保存那一条链上）——为凑菜单新造就是假按钮。
 */
import {
  copyTextToClipboard,
  requestPluginMenu,
  type PluginContextMenuItem,
  type UIPanelProps,
} from '@kojo/plugin-api';

export const VERDICT_DIAG_MENU_ARIA = '转译诊断菜单';
export const VERDICT_PANEL_MENU_ARIA = '糖校验菜单';

/** 诊断行上下文（只取菜单用到的字段；中文短名由调用方查既有映射） */
export interface VerdictDiagMenuTarget {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: string;
  /** 诊断码的中文短名（`diagnosticDisplay().name`，不改这里再抄一份表） */
  readonly codeName: string;
  readonly line: number | null;
  readonly column: number | null;
  readonly message: string;
}

/** 面板空白处上下文 */
export interface VerdictPanelMenuTarget {
  readonly filePath: string | null;
  /** 当前文件是不是 `.kojo`（不是就没什么可判定） */
  readonly canRefresh: boolean;
}

/** 菜单动作的落点（面板注入） */
export interface VerdictMenuHost {
  reveal(line: number): void;
  refresh(): void;
  /** 请求宿主把显示切成糖 / 源码（只影响显示，零写盘） */
  setSugarView(on: boolean): void;
  copy(text: string): void;
}

/** 严重度中文名（与面板徽章同词） */
const SEVERITY_TEXT: Record<VerdictDiagMenuTarget['severity'], string> = {
  error: '错误',
  warning: '警告',
  info: '提示',
};

/** 「复制诊断」的文本 */
export function verdictDiagCopyText(target: VerdictDiagMenuTarget): string {
  const loc = target.line === null ? '' : ` L${target.line}:${target.column ?? 1}`;
  return `[${SEVERITY_TEXT[target.severity]}]${loc} ${target.codeName}（${target.code}） ${target.message}`;
}

/** 诊断行菜单（判据层，纯函数） */
export function buildVerdictDiagMenu(target: VerdictDiagMenuTarget): PluginContextMenuItem[] {
  return [
    target.line === null
      ? {
          id: 'sv.diag.reveal',
          label: '跳到源行',
          disabled: true,
          disabledReason: '这是文件级诊断，没有行号可跳',
          group: '诊断',
        }
      : { id: 'sv.diag.reveal', label: '跳到源行', icon: 'target', group: '诊断' },
    { id: 'sv.diag.copy', label: '复制诊断' },
  ];
}

/** 面板空白处菜单（判据层，纯函数） */
export function buildVerdictPanelMenu(target: VerdictPanelMenuTarget): PluginContextMenuItem[] {
  const noFile = target.filePath === null;
  const refreshItem: PluginContextMenuItem = target.canRefresh
    ? { id: 'sv.panel.refresh', label: '刷新判定', icon: 'refresh', group: '判定' }
    : {
        id: 'sv.panel.refresh',
        label: '刷新判定',
        icon: 'refresh',
        disabled: true,
        disabledReason: noFile ? '还没打开任何文件' : '当前文件不是 .kojo，没有可判定的转译结果',
        group: '判定',
      };
  const viewItem = (on: boolean, label: string): PluginContextMenuItem =>
    noFile
      ? {
          id: on ? 'sv.panel.showSugar' : 'sv.panel.showSource',
          label,
          disabled: true,
          disabledReason: '还没打开任何文件',
        }
      : { id: on ? 'sv.panel.showSugar' : 'sv.panel.showSource', label };
  return [
    refreshItem,
    viewItem(false, '切回源码'),
    viewItem(true, '按语法糖显示'),
    target.filePath === null
      ? {
          id: 'sv.panel.copyPath',
          label: '复制文件路径',
          dividerBefore: true,
          disabled: true,
          disabledReason: '还没打开任何文件',
        }
      : { id: 'sv.panel.copyPath', label: '复制文件路径', dividerBefore: true },
  ];
}

/** 分发一条诊断 id；返回是否被本面消费 */
export function runVerdictDiagAction(
  id: string,
  target: VerdictDiagMenuTarget,
  host: VerdictMenuHost,
): boolean {
  switch (id) {
    case 'sv.diag.reveal':
      if (target.line === null) return false;
      host.reveal(target.line);
      return true;
    case 'sv.diag.copy':
      host.copy(verdictDiagCopyText(target));
      return true;
    default:
      return false;
  }
}

/** 分发一条面板 id */
export function runVerdictPanelAction(
  id: string,
  target: VerdictPanelMenuTarget,
  host: VerdictMenuHost,
): boolean {
  switch (id) {
    case 'sv.panel.refresh':
      if (!target.canRefresh) return false;
      host.refresh();
      return true;
    case 'sv.panel.showSource':
      if (target.filePath === null) return false;
      host.setSugarView(false);
      return true;
    case 'sv.panel.showSugar':
      if (target.filePath === null) return false;
      host.setSugarView(true);
      return true;
    case 'sv.panel.copyPath':
      if (target.filePath === null) return false;
      host.copy(target.filePath);
      return true;
    default:
      return false;
  }
}

/** 接线层：诊断行 */
export function openVerdictDiagMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  target: VerdictDiagMenuTarget,
  host: VerdictMenuHost,
): boolean {
  return requestPluginMenu(props, anchor, buildVerdictDiagMenu(target), VERDICT_DIAG_MENU_ARIA, (id) => {
    runVerdictDiagAction(id, target, host);
  });
}

/** 接线层：面板空白处 */
export function openVerdictPanelMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  target: VerdictPanelMenuTarget,
  host: VerdictMenuHost,
): boolean {
  return requestPluginMenu(props, anchor, buildVerdictPanelMenu(target), VERDICT_PANEL_MENU_ARIA, (id) => {
    runVerdictPanelAction(id, target, host);
  });
}

/** 复制动作的落点 */
export function copyVerdictText(text: string): Promise<boolean> {
  return copyTextToClipboard(text);
}
