/**
 * 条件矩阵面板的右键菜单（1023 批 · 右键覆盖面 WP5.2）。
 *
 * 两个层级，动作全是**已有**的通道：
 * - **格子**：跳到定义（`editor.revealLocation`，与左键点格同一条）· 复制单元格数值
 *   · 复制状态与时机 · 复制贡献函数（名称 + 位置 + 条件比较）· 复制条件比较；
 * - **面板空白处**：只看有缺口的行（工具条「只看空缺」同一开关）· 刷新矩阵
 *   （`store.refresh()`，与失败态那颗「重试」同一入口）· 复制矩阵摘要。
 *
 * 任务书里的「只看此角色」**没有做**：本矩阵本来就是**单角色**表（行 = 该角色的状态，
 * 列 = 时机），"再按角色筛一次"没有落点；换角色是工具条的角色选择器，不在菜单里造第二套。
 */
import {
  copyTextToClipboard,
  requestPluginMenu,
  type PluginContextMenuItem,
  type PluginContextMenuAnchor,
  type UIPanelProps,
} from '@kojo/plugin-api';

export const MATRIX_CELL_MENU_ARIA = '格子菜单';
export const MATRIX_PANEL_MENU_ARIA = '条件矩阵菜单';

/** 一格贡献函数（只取菜单要展示的字段） */
export interface MatrixMenuFunction {
  readonly name: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly comparisons: readonly string[];
}

/** 格子上下文 */
export interface MatrixCellMenuTarget {
  /** 状态键（如 `CFLAG:318`） */
  readonly rowKey: string;
  /** 状态语义标签（变量字典给的；无则 null） */
  readonly rowLabel: string | null;
  /** 列键（面，或 `面#指令号`） */
  readonly columnKey: string;
  /** 列显示名（时机中文名） */
  readonly columnLabel: string;
  /** 该格是否有响应 */
  readonly present: boolean;
  /** 响应次数（`present` 时有效） */
  readonly count: number;
  /** 贡献函数（已按行号升序） */
  readonly functions: readonly MatrixMenuFunction[];
}

/** 面板空白处上下文 */
export interface MatrixPanelMenuTarget {
  /** 当前角色（`K12 名字`；未选角色 = null） */
  readonly charaLabel: string | null;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly gapCells: number;
  readonly totalCells: number;
  /** 当前是否「只看有缺口的行」 */
  readonly gapOnly: boolean;
}

/** 菜单动作的落点（面板注入） */
export interface MatrixMenuHost {
  reveal(filePath: string, line: number, source: string): void;
  refresh(): void;
  setGapOnly(on: boolean): void;
  copy(text: string): void;
}

/** 「复制单元格数值」的文本：有响应给次数，空白格给「空缺」 */
export function cellValueText(target: MatrixCellMenuTarget): string {
  return target.present ? String(target.count) : '空缺';
}

/** 「复制状态与时机」的文本 */
export function cellKeyText(target: MatrixCellMenuTarget): string {
  const row = target.rowLabel === null ? target.rowKey : `${target.rowLabel}（${target.rowKey}）`;
  return `${row} × ${target.columnLabel}（${target.columnKey}）`;
}

/** 「复制贡献函数」的文本：每行 `名称 · 路径:行号`，有条件比较再缀一段 */
export function cellFunctionsText(target: MatrixCellMenuTarget): string {
  return target.functions
    .map((fn) => {
      const cmp = fn.comparisons.length > 0 ? ` ${fn.comparisons.join('、')}` : '';
      return `${fn.name} · ${fn.filePath}:${fn.startLine}${cmp}`;
    })
    .join('\n');
}

/** 「复制矩阵摘要」的文本 */
export function panelSummaryText(target: MatrixPanelMenuTarget): string {
  const filled = Math.max(0, target.totalCells - target.gapCells);
  const who = target.charaLabel ?? '未选角色';
  return `条件矩阵 · ${who} · ${target.rowCount} 行 × ${target.columnCount} 列 · 已填 ${filled}/${target.totalCells} 格（缺口 ${target.gapCells}）`;
}

/** 格子菜单（判据层，纯函数） */
export function buildMatrixCellMenu(target: MatrixCellMenuTarget): PluginContextMenuItem[] {
  const noFunction = target.functions.length === 0;
  const revealItem: PluginContextMenuItem = !target.present
    ? {
        id: 'cm.cell.reveal',
        label: '跳到定义',
        icon: 'target',
        disabled: true,
        disabledReason: '这一格还是空缺，没有可跳转的函数',
        group: '定位',
      }
    : noFunction
      ? {
          id: 'cm.cell.reveal',
          label: '跳到定义',
          icon: 'target',
          disabled: true,
          disabledReason: '这一格的函数没有可定位的源文件',
          group: '定位',
        }
      : { id: 'cm.cell.reveal', label: '跳到定义', icon: 'target', group: '定位' };

  const items: PluginContextMenuItem[] = [revealItem];
  items.push(
    { id: 'cm.cell.copyValue', label: '复制单元格数值' },
    { id: 'cm.cell.copyKey', label: '复制状态与时机' },
  );
  if (!noFunction) {
    items.push({ id: 'cm.cell.copyFunctions', label: '复制贡献函数' });
  }
  if (target.functions.some((fn) => fn.comparisons.length > 0)) {
    items.push({ id: 'cm.cell.copyComparisons', label: '复制条件比较' });
  }
  return items;
}

/** 面板空白处菜单（判据层，纯函数） */
export function buildMatrixPanelMenu(target: MatrixPanelMenuTarget): PluginContextMenuItem[] {
  const hasMatrix = target.charaLabel !== null && target.rowCount > 0;
  return [
    {
      id: 'cm.panel.gapOnly',
      label: target.gapOnly ? '显示全部状态行' : '只看有缺口的行',
      checked: target.gapOnly,
      ...(hasMatrix
        ? {}
        : { disabled: true, disabledReason: '还没有矩阵，没有状态行可筛' }),
      group: '视图',
    },
    { id: 'cm.panel.refresh', label: '刷新矩阵', icon: 'refresh', group: '维护' },
    {
      id: 'cm.panel.copySummary',
      label: '复制矩阵摘要',
      dividerBefore: true,
      ...(hasMatrix
        ? {}
        : { disabled: true, disabledReason: '还没有矩阵，没有可复制的摘要' }),
    },
  ];
}

/** 分发一条格子 id；返回是否被本面消费 */
export function runMatrixCellAction(
  id: string,
  target: MatrixCellMenuTarget,
  host: MatrixMenuHost,
): boolean {
  switch (id) {
    case 'cm.cell.reveal': {
      const first = target.functions[0];
      if (!target.present || !first) return false;
      host.reveal(first.filePath, first.startLine, first.name);
      return true;
    }
    case 'cm.cell.copyValue':
      host.copy(cellValueText(target));
      return true;
    case 'cm.cell.copyKey':
      host.copy(cellKeyText(target));
      return true;
    case 'cm.cell.copyFunctions':
      if (target.functions.length === 0) return false;
      host.copy(cellFunctionsText(target));
      return true;
    case 'cm.cell.copyComparisons': {
      const seen = new Set<string>();
      for (const fn of target.functions) for (const c of fn.comparisons) seen.add(c);
      if (seen.size === 0) return false;
      host.copy([...seen].join('、'));
      return true;
    }
    default:
      return false;
  }
}

/** 分发一条面板 id；返回是否被本面消费 */
export function runMatrixPanelAction(
  id: string,
  target: MatrixPanelMenuTarget,
  host: MatrixMenuHost,
): boolean {
  const hasMatrix = target.charaLabel !== null && target.rowCount > 0;
  switch (id) {
    case 'cm.panel.gapOnly':
      if (!hasMatrix) return false;
      host.setGapOnly(!target.gapOnly);
      return true;
    case 'cm.panel.refresh':
      host.refresh();
      return true;
    case 'cm.panel.copySummary':
      if (!hasMatrix) return false;
      host.copy(panelSummaryText(target));
      return true;
    default:
      return false;
  }
}

/** 接线层：格子 */
export function openMatrixCellMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: PluginContextMenuAnchor,
  target: MatrixCellMenuTarget,
  host: MatrixMenuHost,
): boolean {
  return requestPluginMenu(props, anchor, buildMatrixCellMenu(target), MATRIX_CELL_MENU_ARIA, (id) => {
    runMatrixCellAction(id, target, host);
  });
}

/** 接线层：面板空白处 */
export function openMatrixPanelMenu(
  props: Pick<UIPanelProps, 'openContextMenu'>,
  anchor: PluginContextMenuAnchor,
  target: MatrixPanelMenuTarget,
  host: MatrixMenuHost,
): boolean {
  return requestPluginMenu(props, anchor, buildMatrixPanelMenu(target), MATRIX_PANEL_MENU_ARIA, (id) => {
    runMatrixPanelAction(id, target, host);
  });
}

/** 复制动作的落点 */
export function copyMatrixText(text: string): Promise<boolean> {
  return copyTextToClipboard(text);
}
