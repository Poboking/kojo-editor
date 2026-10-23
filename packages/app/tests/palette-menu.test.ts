// @vitest-environment happy-dom
/**
 * 快速打开 / 命令面板 / 工作区符号的行右键菜单（1023 覆盖面批 · WP2.6 / WP4.9 / WP3.3）。
 *
 * 判据全部打在**纯函数**上（`buildPaletteRowMenu` / `paletteRowAttributes` / `paletteRowTargetOf`）：
 * - 三类行各自的项集合与顺序；
 * - 能力矩阵：剪贴板不可写 ⇒ 复制类整项不显示；桌面壳不在场 ⇒ 显示项不显示；
 *   命令通道未就绪 ⇒ 命令项禁用 + 人话原因（铁律 4 的两半）；
 * - label 全中文；`disabled` 必带 `disabledReason`；
 * - 命令项的标题 / 键位与 `KEYBINDING_SPECS` 一致（菜单不另造第二份文案）；
 * - 行 DOM 属性与行事实一一对应（多实例安全：菜单只认 DOM，不认组件闭包）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { EditorCommandContext } from '@kojo/plugin-api';
import { CommandPalette } from '../src/ui/Palette';
import { closeContextMenu, ContextMenuHost, getContextMenuState } from '../src/ui/context-menu-host';
import {
  KEYBINDINGS_COMMAND_ID,
  KEYBINDINGS_UNAVAILABLE_REASON,
  PALETTE_ROW_ACTION,
  PALETTE_ROW_ATTR,
  buildPaletteRowMenu,
  commandRowTarget,
  fileRowTarget,
  paletteRowAttributes,
  paletteRowMenuAriaLabel,
  paletteRowTargetOf,
  symbolRowTarget,
  type PaletteMenuCapabilities,
  type PaletteRowTarget,
} from '../src/ui/palette-menu';
import { isChineseMenuLabel, type ContextMenuItem } from '../src/ui/context-menu-model';
import { KEYBINDING_SPECS, effectiveKeybindingOf, keybindingSpecOf } from '../src/ui/keybindings';
import { formatKeybinding } from '../src/ui/commands';

const FULL: PaletteMenuCapabilities = { copyText: true, revealInExplorer: true, keybindingsCommand: true };
const NO_CAPS: PaletteMenuCapabilities = { copyText: false, revealInExplorer: false, keybindingsCommand: false };

const labels = (items: readonly ContextMenuItem[]): string[] => items.map((item) => item.label);
const ids = (items: readonly ContextMenuItem[]): string[] => items.map((item) => item.id);

/** 一张全矩阵的菜单集合（后面几条通用闸门逐项扫它） */
const MATRIX: readonly { readonly target: PaletteRowTarget; readonly caps: PaletteMenuCapabilities }[] = [
  { target: fileRowTarget('C:/proj/a.erb', 'a.erb'), caps: FULL },
  { target: fileRowTarget('C:/proj/a.erb', 'a.erb'), caps: NO_CAPS },
  { target: fileRowTarget('C:/proj/a.erb', 'a.erb'), caps: { copyText: false, revealInExplorer: true, keybindingsCommand: true } },
  { target: commandRowTarget('workbench.saveAll', '全部保存'), caps: FULL },
  { target: commandRowTarget('workbench.saveAll', '全部保存'), caps: NO_CAPS },
  { target: commandRowTarget('workbench.saveAll', '全部保存'), caps: { copyText: true, revealInExplorer: true, keybindingsCommand: false } },
  { target: symbolRowTarget('C:/proj/a.erb', 42, 'EVENTFIRST', 'EVENTFIRST'), caps: FULL },
  { target: symbolRowTarget('C:/proj/a.erb', 42, 'EVENTFIRST', 'EVENTFIRST'), caps: NO_CAPS },
];

describe('文件行（快速打开 / 最近打开）', () => {
  it('复制路径 + 在资源管理器中显示，顺序与分组线固定', () => {
    const items = buildPaletteRowMenu(fileRowTarget('C:/proj/a.erb', 'a.erb'), FULL);
    expect(labels(items)).toEqual(['复制路径', '在资源管理器中显示']);
    expect(ids(items)).toEqual([PALETTE_ROW_ACTION.copyPath, PALETTE_ROW_ACTION.revealInExplorer]);
    expect(items[0]!.dividerBefore).toBeUndefined();
    expect(items[1]!.dividerBefore).toBe(true);
  });

  it('剪贴板不可写 ⇒ 复制路径整项不显示（能力不存在不摆空壳）', () => {
    const items = buildPaletteRowMenu(fileRowTarget('C:/proj/a.erb', 'a.erb'), {
      copyText: false,
      revealInExplorer: true,
      keybindingsCommand: false,
    });
    expect(labels(items)).toEqual(['在资源管理器中显示']);
    // 首项的分隔线由渲染侧吞掉，这里同步不给（不给渲染侧添一条多余的线）
    expect(items[0]!.dividerBefore).toBe(false);
  });

  it('浏览器壳（没有 show_in_folder）⇒ 显示项不显示', () => {
    const items = buildPaletteRowMenu(fileRowTarget('C:/proj/a.erb', 'a.erb'), {
      copyText: true,
      revealInExplorer: false,
      keybindingsCommand: false,
    });
    expect(labels(items)).toEqual(['复制路径']);
  });

  it('两项都不可用 ⇒ 空菜单（这一级不表态，交给路由走兜底）', () => {
    expect(buildPaletteRowMenu(fileRowTarget('C:/proj/a.erb', 'a.erb'), NO_CAPS)).toEqual([]);
  });
});

describe('命令行（F1 命令面板 / Ctrl+P 的 > 模式）', () => {
  it('复制命令 ID、复制命令标题 | 打开键盘快捷键', () => {
    const items = buildPaletteRowMenu(commandRowTarget('workbench.saveAll', '全部保存'), FULL);
    expect(labels(items)).toEqual(['复制命令 ID', '复制命令标题', '打开键盘快捷键']);
    expect(ids(items)).toEqual([
      PALETTE_ROW_ACTION.copyCommandId,
      PALETTE_ROW_ACTION.copyCommandTitle,
      KEYBINDINGS_COMMAND_ID,
    ]);
    expect(items[2]!.dividerBefore).toBe(true);
  });

  it('命令通道未就绪 ⇒ 键盘快捷键项禁用并说明原因（不静默灰掉）', () => {
    const items = buildPaletteRowMenu(commandRowTarget('workbench.saveAll', '全部保存'), {
      copyText: true,
      revealInExplorer: true,
      keybindingsCommand: false,
    });
    const item = items.find((i) => i.id === KEYBINDINGS_COMMAND_ID);
    expect(item?.disabled).toBe(true);
    expect(item?.disabledReason).toBe(KEYBINDINGS_UNAVAILABLE_REASON);
    expect(isChineseMenuLabel(item?.disabledReason ?? '')).toBe(true);
  });

  it('没有剪贴板时只剩键盘快捷键项，且不冒充「首项」（分隔线跟着让位）', () => {
    const items = buildPaletteRowMenu(commandRowTarget('workbench.saveAll', '全部保存'), {
      copyText: false,
      revealInExplorer: true,
      keybindingsCommand: true,
    });
    expect(labels(items)).toEqual(['打开键盘快捷键']);
    expect(items[0]!.dividerBefore).toBe(false);
  });
});

describe('符号行（工作区符号 / @ 当前文件符号）', () => {
  it('跳转 | 复制名字、复制路径（没有通道的「查找引用 / 重命名」不出现）', () => {
    const items = buildPaletteRowMenu(symbolRowTarget('C:/proj/a.erb', 42, 'EVENTFIRST', 'EVENTFIRST'), FULL);
    expect(labels(items)).toEqual(['跳转', '复制名字', '复制路径']);
    expect(ids(items)).toEqual([
      PALETTE_ROW_ACTION.jump,
      PALETTE_ROW_ACTION.copyName,
      PALETTE_ROW_ACTION.copyPath,
    ]);
    expect(items.some((i) => i.label === '查找引用' || i.label === '重命名')).toBe(false);
  });

  it('剪贴板不可写 ⇒ 只剩跳转（跳转不依赖剪贴板）', () => {
    const items = buildPaletteRowMenu(symbolRowTarget('C:/proj/a.erb', 42, 'EVENTFIRST', 'EVENTFIRST'), NO_CAPS);
    expect(labels(items)).toEqual(['跳转']);
  });
});

describe('全矩阵闸门', () => {
  it('所有 label 都是中文（英文在宿主会被整项丢弃）', () => {
    for (const { target, caps } of MATRIX) {
      for (const item of buildPaletteRowMenu(target, caps)) {
        expect(isChineseMenuLabel(item.label), `${target.kind}/${item.id}`).toBe(true);
      }
    }
  });

  it('禁用项必带人话原因（灰着不说话的项等于按了没反应）', () => {
    for (const { target, caps } of MATRIX) {
      for (const item of buildPaletteRowMenu(target, caps)) {
        if (item.disabled === true) {
          expect(item.disabledReason ?? '', `${target.kind}/${item.id}`).not.toBe('');
          expect(isChineseMenuLabel(item.disabledReason ?? '')).toBe(true);
        }
      }
    }
  });

  it('菜单项 id 只有两个来源：面自己的动作、或登记过的命令（不冒充命令）', () => {
    const ownActions = new Set<string>(Object.values(PALETTE_ROW_ACTION));
    for (const { target, caps } of MATRIX) {
      for (const item of buildPaletteRowMenu(target, caps)) {
        expect(ownActions.has(item.id) || keybindingSpecOf(item.id) !== undefined, item.id).toBe(true);
      }
    }
  });

  it('命令项与 KEYBINDING_SPECS 一致：标题同词，键位 = 生效键位格式化', () => {
    for (const { target, caps } of MATRIX) {
      for (const item of buildPaletteRowMenu(target, caps)) {
        const spec = KEYBINDING_SPECS.find((s) => s.id === item.id);
        if (spec === undefined) continue;
        expect(item.label).toBe(spec.title);
        const keys = effectiveKeybindingOf(item.id);
        expect(item.shortcut).toBe(keys === undefined || keys === '' ? undefined : formatKeybinding(keys));
      }
    }
  });

  it('面的无障碍名按行种类换措辞，且全中文', () => {
    expect(paletteRowMenuAriaLabel('file')).toBe('快速打开菜单');
    expect(paletteRowMenuAriaLabel('command')).toBe('命令面板菜单');
    expect(paletteRowMenuAriaLabel('symbol')).toBe('工作区符号菜单');
    for (const kind of ['file', 'command', 'symbol'] as const) {
      expect(isChineseMenuLabel(paletteRowMenuAriaLabel(kind))).toBe(true);
    }
  });
});

describe('行 DOM 属性 ⇄ 行事实（多实例安全）', () => {
  const roundTrip = (target: PaletteRowTarget): PaletteRowTarget | null => {
    const row = document.createElement('button');
    const attrs = paletteRowAttributes(target);
    row.setAttribute(PALETTE_ROW_ATTR, attrs[PALETTE_ROW_ATTR]);
    row.setAttribute('data-palette-label', attrs['data-palette-label']);
    row.setAttribute('data-palette-path', attrs['data-palette-path']);
    row.setAttribute('data-palette-line', attrs['data-palette-line']);
    row.setAttribute('data-palette-symbol', attrs['data-palette-symbol']);
    row.setAttribute('data-palette-command', attrs['data-palette-command']);
    const inner = document.createElement('span');
    inner.textContent = target.label;
    row.appendChild(inner);
    document.body.appendChild(row);
    return paletteRowTargetOf(inner);
  };

  it('符号行往返不丢 文件 / 行 / 名字', () => {
    expect(roundTrip(symbolRowTarget('C:/proj/a.erb', 42, 'EVENTFIRST', 'EVENTFIRST'))).toEqual(
      symbolRowTarget('C:/proj/a.erb', 42, 'EVENTFIRST', 'EVENTFIRST'),
    );
  });

  it('命令行往返不丢命令 id', () => {
    expect(roundTrip(commandRowTarget('workbench.saveAll', '全部保存'))).toEqual(
      commandRowTarget('workbench.saveAll', '全部保存'),
    );
  });

  it('不在行上（列表空白区）⇒ null，交给路由下一级', () => {
    const blank = document.createElement('div');
    document.body.appendChild(blank);
    expect(paletteRowTargetOf(blank)).toBeNull();
  });

  it('行没有合法种类 ⇒ null（不把未知行当文件处理）', () => {
    const row = document.createElement('button');
    row.setAttribute(PALETTE_ROW_ATTR, 'mystery');
    document.body.appendChild(row);
    expect(paletteRowTargetOf(row)).toBeNull();
  });

  it('行号属性只认正整数（空串 / 脏值回 0，不编一个假行号）', () => {
    const row = document.createElement('button');
    row.setAttribute(PALETTE_ROW_ATTR, 'symbol');
    row.setAttribute('data-palette-line', '12k');
    document.body.appendChild(row);
    expect(paletteRowTargetOf(row)?.line).toBe(0);
  });
});

describe('挂载后可用的完整链路（行 → 面 → 根宿主）', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const writeText = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const commandCtx = {} as unknown as EditorCommandContext;
  let container: HTMLDivElement;
  let root: Root;

  const rightClickRow = async (): Promise<HTMLElement> => {
    const row = container.querySelector<HTMLElement>('button.picker-item');
    expect(row).not.toBeNull();
    await act(async () => {
      row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 24, clientY: 48 }));
    });
    return row!;
  };

  beforeEach(async () => {
    // happy-dom 的剪贴板不是每个版本都带；这里给一个确定的替身（能力探针只看 writeText 在不在）
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    writeText.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          'div',
          null,
          createElement(CommandPalette, {
            commands: [{ id: 'workbench.saveAll', title: '全部保存', run: () => undefined }],
            commandCtx,
            onClose: () => undefined,
          }),
          createElement(ContextMenuHost, null),
        ),
      );
    });
  });

  afterEach(async () => {
    await act(async () => {
      closeContextMenu();
    });
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('右键命令行 ⇒ 打开「命令面板菜单」，项全中文', async () => {
    const row = await rightClickRow();
    expect(row.getAttribute(PALETTE_ROW_ATTR)).toBe('command');
    const request = getContextMenuState().request;
    expect(request).not.toBeNull();
    expect(request?.ariaLabel).toBe('命令面板菜单');
    expect(request?.source).toBe('palette');
    for (const item of request?.items ?? []) expect(isChineseMenuLabel(item.label)).toBe(true);
    expect(request?.items.map((i) => i.label)).toContain('打开键盘快捷键');
  });

  it('选中「复制命令 ID」⇒ 真的写进剪贴板（不是只展示）', async () => {
    await rightClickRow();
    await act(async () => {
      getContextMenuState().request?.onSelect(PALETTE_ROW_ACTION.copyCommandId);
    });
    expect(writeText).toHaveBeenCalledWith('workbench.saveAll');
  });

  it('「打开键盘快捷键」沿用命令 id（面不另造同义动作）', async () => {
    await rightClickRow();
    const request = getContextMenuState().request;
    expect(request?.items.some((i) => i.id === KEYBINDINGS_COMMAND_ID)).toBe(true);
  });
});
