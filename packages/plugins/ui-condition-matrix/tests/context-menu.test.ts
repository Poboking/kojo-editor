/**
 * 条件矩阵面板右键菜单（1023 覆盖面批 · WP5.2）。
 *
 * 判据：格子（有响应 / 空缺）的项集合与禁用原因、复制文本格式、面板层的三态
 * （有矩阵 / 无矩阵 / 只看空缺中）、分发与降级。
 */
import { describe, expect, it } from 'vitest';
import { hasCjkLabel, type PluginContextMenuRequest } from '@kojo/plugin-api';
import {
  MATRIX_CELL_MENU_ARIA,
  MATRIX_PANEL_MENU_ARIA,
  buildMatrixCellMenu,
  buildMatrixPanelMenu,
  cellFunctionsText,
  cellKeyText,
  cellValueText,
  openMatrixCellMenu,
  openMatrixPanelMenu,
  panelSummaryText,
  runMatrixCellAction,
  runMatrixPanelAction,
  type MatrixCellMenuTarget,
  type MatrixMenuHost,
  type MatrixPanelMenuTarget,
} from '../src/context-menu';

const ids = (items: readonly { id: string }[]): string[] => items.map((i) => i.id);

function cell(overrides: Partial<MatrixCellMenuTarget> = {}): MatrixCellMenuTarget {
  return {
    rowKey: 'CFLAG:318',
    rowLabel: '好感度',
    columnKey: 'SP_TALK',
    columnLabel: '闲聊',
    present: true,
    count: 3,
    functions: [
      {
        name: 'M_KOJO_SP_TALK_1',
        filePath: 'kojo/口上.erb',
        startLine: 42,
        comparisons: ['>= 30', '<= 80'],
      },
    ],
    ...overrides,
  };
}

function panel(overrides: Partial<MatrixPanelMenuTarget> = {}): MatrixPanelMenuTarget {
  return {
    charaLabel: 'K12 铃',
    rowCount: 26,
    columnCount: 218,
    gapCells: 1200,
    totalCells: 5668,
    gapOnly: false,
    ...overrides,
  };
}

function hostSpy(): MatrixMenuHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    reveal: (filePath, line, source) => void calls.push(`reveal:${filePath}:${line}:${source}`),
    refresh: () => void calls.push('refresh'),
    setGapOnly: (on) => void calls.push(`gapOnly:${on}`),
    copy: (text) => void calls.push(`copy:${text}`),
  };
}

describe('格子菜单', () => {
  it('有响应且有函数：跳到定义 + 三个复制项；id 唯一、全中文', () => {
    const items = buildMatrixCellMenu(cell());
    expect(ids(items)).toEqual([
      'cm.cell.reveal',
      'cm.cell.copyValue',
      'cm.cell.copyKey',
      'cm.cell.copyFunctions',
      'cm.cell.copyComparisons',
    ]);
    expect(new Set(ids(items)).size).toBe(items.length);
    expect(items.every((i) => hasCjkLabel(i.label))).toBe(true);
  });

  it('空缺格：跳到定义禁用并说明；不提供贡献函数 / 条件比较两项', () => {
    const items = buildMatrixCellMenu(cell({ present: false, count: 0, functions: [] }));
    expect(ids(items)).toEqual(['cm.cell.reveal', 'cm.cell.copyValue', 'cm.cell.copyKey']);
    expect(items[0]?.disabled).toBe(true);
    expect(items[0]?.disabledReason).toContain('空缺');
  });

  it('有响应但一格里有函数列表却无可定位项：跳到定义禁用（原因换一句）', () => {
    const noFunction = buildMatrixCellMenu(cell({ functions: [] }));
    expect(noFunction[0]?.disabled).toBe(true);
    expect(noFunction[0]?.disabledReason).toContain('源文件');
    expect(ids(noFunction)).not.toContain('cm.cell.copyFunctions');
  });

  it('无比较：不出现「复制条件比较」', () => {
    const items = buildMatrixCellMenu(
      cell({
        functions: [{ name: 'A', filePath: 'a.erb', startLine: 1, comparisons: [] }],
      }),
    );
    expect(ids(items)).not.toContain('cm.cell.copyComparisons');
  });

  it('复制文本：数值 / 状态与时机 / 贡献函数', () => {
    expect(cellValueText(cell())).toBe('3');
    expect(cellValueText(cell({ present: false, count: 0 }))).toBe('空缺');
    expect(cellKeyText(cell())).toBe('好感度（CFLAG:318） × 闲聊（SP_TALK）');
    expect(cellKeyText(cell({ rowLabel: null }))).toBe('CFLAG:318 × 闲聊（SP_TALK）');
    expect(cellFunctionsText(cell())).toBe('M_KOJO_SP_TALK_1 · kojo/口上.erb:42 >= 30、<= 80');
  });
});

describe('面板菜单', () => {
  it('有矩阵：只看有缺口 + 刷新 + 复制摘要；全中文', () => {
    const items = buildMatrixPanelMenu(panel());
    expect(ids(items)).toEqual(['cm.panel.gapOnly', 'cm.panel.refresh', 'cm.panel.copySummary']);
    expect(items.every((i) => hasCjkLabel(i.label))).toBe(true);
    expect(items[0]?.checked).toBe(false);
  });

  it('已处于只看空缺：文案换成「显示全部状态行」且勾选', () => {
    const item = buildMatrixPanelMenu(panel({ gapOnly: true }))[0];
    expect(item?.label).toBe('显示全部状态行');
    expect(item?.checked).toBe(true);
  });

  it('无矩阵：筛行与复制摘要禁用并说明；刷新仍可用', () => {
    const items = buildMatrixPanelMenu(panel({ charaLabel: null, rowCount: 0, gapCells: 0, totalCells: 0 }));
    expect(items[0]?.disabled).toBe(true);
    expect(items[0]?.disabledReason).toContain('还没有矩阵');
    expect(items[1]?.disabled).toBeUndefined();
    expect(items[2]?.disabled).toBe(true);
  });

  it('摘要文本：角色 · 行列 · 已填 / 总数（缺口）', () => {
    expect(panelSummaryText(panel())).toBe(
      '条件矩阵 · K12 铃 · 26 行 × 218 列 · 已填 4468/5668 格（缺口 1200）',
    );
  });
});

describe('分发', () => {
  it('跳到定义用第一个（行号最小）函数', () => {
    const host = hostSpy();
    expect(runMatrixCellAction('cm.cell.reveal', cell(), host)).toBe(true);
    expect(host.calls).toEqual(['reveal:kojo/口上.erb:42:M_KOJO_SP_TALK_1']);
  });

  it('空缺格点跳转：不分发', () => {
    const host = hostSpy();
    expect(runMatrixCellAction('cm.cell.reveal', cell({ present: false, functions: [] }), host)).toBe(
      false,
    );
    expect(host.calls).toEqual([]);
  });

  it('复制条件比较：跨函数去重', () => {
    const host = hostSpy();
    runMatrixCellAction(
      'cm.cell.copyComparisons',
      cell({
        functions: [
          { name: 'A', filePath: 'a.erb', startLine: 1, comparisons: ['>= 30'] },
          { name: 'B', filePath: 'b.erb', startLine: 9, comparisons: ['>= 30', '< 5'] },
        ],
      }),
      host,
    );
    expect(host.calls).toEqual(['copy:>= 30、< 5']);
  });

  it('面板开关取反；无矩阵时不分发', () => {
    const host = hostSpy();
    expect(runMatrixPanelAction('cm.panel.gapOnly', panel(), host)).toBe(true);
    expect(runMatrixPanelAction('cm.panel.gapOnly', panel({ charaLabel: null }), host)).toBe(false);
    expect(runMatrixPanelAction('cm.panel.refresh', panel(), host)).toBe(true);
    expect(host.calls).toEqual(['gapOnly:true', 'refresh']);
  });

  it('未知 id 一律 false（不吞别的面的动作）', () => {
    expect(runMatrixCellAction('nope', cell(), hostSpy())).toBe(false);
    expect(runMatrixPanelAction('nope', panel(), hostSpy())).toBe(false);
  });
});

describe('接线（宿主能力注入）', () => {
  it('宿主在：透传坐标 / 菜单项 / 中文 aria 与 onSelect 回插件', () => {
    const seen: PluginContextMenuRequest[] = [];
    const host = { openContextMenu: (r: PluginContextMenuRequest) => void seen.push(r) };
    let prevented = 0;
    let stopped = 0;
    const ok = openMatrixCellMenu(
      host,
      { clientX: 120, clientY: 240, preventDefault: () => void prevented++, stopPropagation: () => void stopped++ },
      cell(),
      hostSpy(),
    );
    expect(ok).toBe(true);
    expect(prevented).toBe(1);
    expect(stopped).toBe(1);
    expect(seen[0]?.x).toBe(120);
    expect(seen[0]?.y).toBe(240);
    expect(seen[0]?.ariaLabel).toBe(MATRIX_CELL_MENU_ARIA);
    seen[0]?.onSelect('cm.cell.copyValue');
  });

  it('宿主缺席：返回 false，不自造浮层也不拦默认菜单', () => {
    let prevented = 0;
    const ok = openMatrixPanelMenu(
      {},
      { clientX: 1, clientY: 2, preventDefault: () => void prevented++ },
      panel(),
      hostSpy(),
    );
    expect(ok).toBe(false);
    expect(prevented).toBe(0);
  });

  it('面板菜单的回调真的落到宿主', () => {
    const seen: PluginContextMenuRequest[] = [];
    openMatrixPanelMenu(
      { openContextMenu: (r) => void seen.push(r) },
      { clientX: 0, clientY: 0 },
      panel({ gapOnly: true }),
      hostSpy(),
    );
    expect(seen[0]?.ariaLabel).toBe(MATRIX_PANEL_MENU_ARIA);
    expect(seen[0]?.items).toHaveLength(3);
  });
});
