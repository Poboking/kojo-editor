/**
 * .kojo 转译检查面板的右键菜单（1023 批 · 右键覆盖面 WP5.2）。
 *
 * 三个层级，动作全是**已有**的（跳转 `editor.revealLocation` / 重算 `setNonce` / 复制）：
 * - **逐行映射行**：跳到源行 · 复制源行文本 · 复制产物行标签；
 * - **诊断行**：跳到位置（文件级诊断没有行号 ⇒ 禁用 + 原因）· 复制诊断；
 * - **面板空白处**：刷新预览（非 .kojo 文件时禁用 + 原因）· 复制文件路径。
 *
 * 任务书里的「切回源码」**没有做**：本面板是只读对照视图，自己不持有"显示糖 / 显示源码"
 * 这个开关（那是编辑器糖视图的能力，不归这里）；菜单里给一个按不动的入口没有意义。
 */
import {
  copyTextToClipboard,
  requestPluginMenu,
  type PluginContextMenuItem,
  type UIPanelProps,
} from '@kojo/plugin-api';

export const PREVIEW_ROW_MENU_ARIA = '逐行映射菜单';
export const PREVIEW_DIAG_MENU_ARIA = '诊断菜单';
export const PREVIEW_PANEL_MENU_ARIA = '.kojo 转译检查菜单';

/** 逐行映射行上下文 */
export interface PreviewRowMenuTarget {
  readonly sourceLine: number;
  readonly sourceText: string;
  /** 产物侧标签（`r.generatedLabel`） */
  readonly generatedLabel: string;
  /** 空行（源文本为空） */
  readonly blank: boolean;
}

/** 诊断行上下文 */
export interface PreviewDiagMenuTarget {
  readonly severity: 'error' | 'warning' | 'info';
  /** 行号；null = 文件级诊断 */
  readonly line: number | null;
  readonly column?: number | null;
  readonly message: string;
}

/** 面板空白处上下文 */
export interface PreviewPanelMenuTarget {
  readonly filePath: string | null;
  /** 当前文件是不是 `.kojo`（不是的话"刷新"没有对象） */
  readonly canRefresh: boolean;
}

/** 菜单动作的落点（面板注入） */
export interface PreviewMenuHost {
  reveal(line: number): void;
  refresh(): void;
  copy(text: string): void;
}

/** 严重度中文名（与诊断区徽章同词） */
const SEVERITY_TEXT: Record<PreviewDiagMenuTarget['severity'], string> = {
  error: '错误',
  warning: '警告',
  info: '提示',
};

/** 「复制诊断」的文本（严重度 + 位置 + 正文） */
export function diagCopyText(target: PreviewDiagMenuTarget): string {
  const loc = target.line === null ? '' : ` L${target.line}:${target.column ?? 1}`;
  return `[${SEVERITY_TEXT[target.severity]}]${loc} ${target.message}`;
}

/** 逐行映射行菜单（判据层，纯函数） */
export function buildPreviewRowMenu(target: PreviewRowMenuTarget): PluginContextMenuItem[] {
  return [
    { id: 'pv.row.reveal', label: '跳到源行', icon: 'target', group: '逐行映射' },
    target.blank
      ? {
          id: 'pv.row.copySource',
          label: '复制源行文本',
          disabled: true,
          disabledReason: '这一行是空行，没有文本可复制',
        }
      : { id: 'pv.row.copySource', label: '复制源行文本' },
    { id: 'pv.row.copyGenerated', label: '复制产物行标签' },
  ];
}

/** 诊断行菜单（判据层，纯函数） */
export function buildPreviewDiagMenu(target: PreviewDiagMenuTarget): PluginContextMenuItem[] {
  return [
    target.line === null
      ? {
          id: 'pv.diag.reveal',
          label: '跳到位置',
          disabled: true,
          disabledReason: '这是文件级诊断，没有行号可跳',
          group: '诊断',
        }
      : { id: 'pv.diag.reveal', label: '跳到位置', icon: 'target', group: '诊断' },
    { id: 'pv.diag.copy', label: '复制诊断' },
  ];
}

/** 面板空白处菜单（判据层，纯函数） */
export function buildPreviewPanelMenu(target: PreviewPanelMenuTarget): PluginContextMenuItem[] {
  return [
    target.canRefresh
      ? { id: 'pv.panel.refresh', label: '刷新预览', icon: 'refresh', group: '预览' }
      : {
          id: 'pv.panel.refresh',
          label: '刷新预览',
          icon: 'refresh',
          disabled: true,
          disabledReason: '当前文件不是 .kojo，没有可预览的转译结果',
          group: '预览',
        },
    target.filePath === null
      ? {
          id: 'pv.panel.copyPath',
          label: '复制文件路径',
          disabled: true,
          disabledReason: '还没打开任何文件',
        }
      : { id: 'pv.panel.copyPath', label: '复制文件路径' },
  ];
}

/** 分发一条逐行映射 id */
export function runPreviewRowAction(
  id: string,
  target: PreviewRowMenuTarget,
  host: PreviewMenuHost,
): boolean {
  switch (id) {
    case 'pv.row.reveal':
      host.reveal(target.sourceLine);
      return true;
    case 'pv.row.copySource':
      if (target.blank) return false;
      host.copy(target.sourceText);
      return true;
    case 'pv.row.copyGenerated':
      host.copy(target.generatedLabel);
      return true;
    default:
      return false;
  }
}

/** 分发一条诊断 id */
export function runPreviewDiagAction(
  id: string,
  target: PreviewDiagMenuTarget,
  host: PreviewMenuHost,
): boolean {
  switch (id) {
    case 'pv.diag.reveal':
      if (target.line === null) return false;
      host.reveal(target.line);
      return true;
    case 'pv.diag.copy':
      host.copy(diagCopyText(target));
      return true;
    default:
      return false;
  }
}

/** 分发一条面板 id */
export function runPreviewPanelAction(
  id: string,
  target: PreviewPanelMenuTarget,
  host: PreviewMenuHost,
): boolean {
  switch (id) {
    case 'pv.panel.refresh':
      if (!target.canRefresh) return false;
      host.refresh();
      return true;
    case 'pv.panel.copyPath':
      if (target.filePath === null) return false;
      host.copy(target.filePath);
      return true;
    default:
      return false;
  }
}

/** 接线层：逐行映射行 */
export function openPreviewRowMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  target: PreviewRowMenuTarget,
  host: PreviewMenuHost,
): boolean {
  return requestPluginMenu(props, anchor, buildPreviewRowMenu(target), PREVIEW_ROW_MENU_ARIA, (id) => {
    runPreviewRowAction(id, target, host);
  });
}

/** 接线层：诊断行 */
export function openPreviewDiagMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  target: PreviewDiagMenuTarget,
  host: PreviewMenuHost,
): boolean {
  return requestPluginMenu(props, anchor, buildPreviewDiagMenu(target), PREVIEW_DIAG_MENU_ARIA, (id) => {
    runPreviewDiagAction(id, target, host);
  });
}

/** 接线层：面板空白处 */
export function openPreviewPanelMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: { readonly clientX: number; readonly clientY: number; preventDefault?(): void },
  target: PreviewPanelMenuTarget,
  host: PreviewMenuHost,
): boolean {
  return requestPluginMenu(props, anchor, buildPreviewPanelMenu(target), PREVIEW_PANEL_MENU_ARIA, (id) => {
    runPreviewPanelAction(id, target, host);
  });
}

/** 复制动作的落点 */
export function copyPreviewText(text: string): Promise<boolean> {
  return copyTextToClipboard(text);
}
