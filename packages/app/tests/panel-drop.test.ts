import { describe, expect, it } from 'vitest';
import type { UIPanelContribution } from '@kojo/plugin-api';
import { defaultLayout, organizePanels } from '../src/ui/layout';
import { layoutReducer } from '../src/ui/layout-reducer';
import {
  PANEL_DRAG_MIME,
  acceptsPanelDrop,
  decodeDroppedPanelIds,
  nextDropTarget,
  planPanelMoves,
  type DropTargetEvent,
} from '../src/ui/panel-drop';

/**
 * 三容器拖拽停靠的接线路径单测（2026-10-12 P4 补测批）。
 *
 * 组件里只剩「事件 → 意图 → dispatch」的搬运，能判定的四件事都在这份测试里钉住：
 * ① 只有自家 MIME 的拖拽才落；② 载荷里的幽灵面板 id 不搬；③ 激活单位随目标容器换词汇；
 * ④ 高亮只在**真正离开**容器时清（子元素间移动与别的容器发来的 leave 都不该闪断）。
 * 最后一条端到端串起来：拖拽事件序列 → 状态机 → 编排结果，证明接线之后确实会动。
 */

function panel(id: string, extra: Partial<UIPanelContribution> = {}): UIPanelContribution {
  return { id, title: id, component: () => null, ...extra };
}

const PANELS = [
  panel('tree', { group: 'explorer', order: 10 }),
  panel('files', { group: 'explorer', order: 20 }),
  panel('report', { location: 'bottom', order: 1 }),
  panel('inspect', { location: 'aux', order: 1 }),
];

/** 活动栏图标拖拽带出的整组载荷（与组件里 `startPanelDrag(e, v.panels.map(p => p.id))` 同形） */
const groupPayload = (ids: readonly string[]): string => JSON.stringify(ids);

describe('落点接受判定', () => {
  it('只认自家 MIME：外部拖入 / 纯文本 / 空类型集合一律不接', () => {
    expect(acceptsPanelDrop([PANEL_DRAG_MIME])).toBe(true);
    expect(acceptsPanelDrop(['text/plain', PANEL_DRAG_MIME])).toBe(true);
    expect(acceptsPanelDrop(['text/plain'])).toBe(false);
    expect(acceptsPanelDrop([])).toBe(false);
  });

  it('MIME 串本身是契约的一部分（改名即断链，必须显式改这里）', () => {
    expect(PANEL_DRAG_MIME).toBe('application/x-kojo-panel-move');
  });
});

describe('载荷解码', () => {
  it('正常数组 → id 列表（顺序保留，落点逐条派发）', () => {
    expect(decodeDroppedPanelIds(groupPayload(['tree', 'files']))).toEqual(['tree', 'files']);
  });

  it('坏 JSON / 非数组 / 空串 / null 一律退化成空列表，绝不抛错', () => {
    expect(decodeDroppedPanelIds('{不是 JSON')).toEqual([]);
    expect(decodeDroppedPanelIds('{"id":"tree"}')).toEqual([]);
    expect(decodeDroppedPanelIds('"tree"')).toEqual([]);
    expect(decodeDroppedPanelIds('42')).toEqual([]);
    expect(decodeDroppedPanelIds('')).toEqual([]);
    expect(decodeDroppedPanelIds(null)).toEqual([]);
    expect(decodeDroppedPanelIds(undefined)).toEqual([]);
  });

  it('数组里的非字符串元素剔除（不把对象/数字搬成面板 id）', () => {
    expect(decodeDroppedPanelIds('[\"tree\", 42, null, {\"id\":\"files\"}, \"report\"]')).toEqual(['tree', 'report']);
  });
});

describe('落点意图', () => {
  it('独占面板拖到 aux：viewKey 用 panel:<id>，to 即落点容器', () => {
    expect(planPanelMoves(['report'], PANELS, 'aux')).toEqual([{ id: 'report', to: 'aux', viewKey: 'panel:report' }]);
  });

  it('组员拖走时 viewKey 仍是它所属视图的 key（活动栏图标承载的是整组）', () => {
    expect(planPanelMoves(['tree'], PANELS, 'aux')).toEqual([{ id: 'tree', to: 'aux', viewKey: 'group:explorer' }]);
  });

  it('整组拖到底部区：逐面板各一条，viewKey 同为 group:<名>（活动栏图标 = 视图单位）', () => {
    expect(planPanelMoves(['tree', 'files'], PANELS, 'bottom')).toEqual([
      { id: 'tree', to: 'bottom', viewKey: 'group:explorer' },
      { id: 'files', to: 'bottom', viewKey: 'group:explorer' },
    ]);
  });

  it('载荷里的未知 id 被跳过，其余照常搬（幽灵面板不产生空容器）', () => {
    const moves = planPanelMoves(['已卸载的面板', 'report'], PANELS, 'sidebar');
    expect(moves).toEqual([{ id: 'report', to: 'sidebar', viewKey: 'panel:report' }]);
  });

  it('同容器换位仍产出意图（落点合法，语义是「搬过来并激活」）', () => {
    expect(planPanelMoves(['inspect'], PANELS, 'aux')).toEqual([{ id: 'inspect', to: 'aux', viewKey: 'panel:inspect' }]);
  });

  it('空列表 → 空意图（drop 到空白处不产生任何状态改动）', () => {
    expect(planPanelMoves([], PANELS, 'aux')).toEqual([]);
  });
});

describe('落点高亮', () => {
  const over = (container: 'sidebar' | 'aux' | 'bottom'): DropTargetEvent => ({ type: 'dragover', container });

  it('dragover 置位为当前容器', () => {
    expect(nextDropTarget(null, over('aux'))).toBe('aux');
  });

  it('容器内子元素间移动（stillInside）不清高亮——否则拖一次闪十几次', () => {
    expect(nextDropTarget('aux', { type: 'dragleave', container: 'aux', stillInside: true })).toBe('aux');
  });

  it('真离开当前容器才清除', () => {
    expect(nextDropTarget('aux', { type: 'dragleave', container: 'aux', stillInside: false })).toBeNull();
  });

  it('别的容器发来的 leave 不误清当前高亮（拖拽跨越两个容器时先后各发一次）', () => {
    expect(nextDropTarget('aux', { type: 'dragleave', container: 'bottom', stillInside: false })).toBe('aux');
    expect(nextDropTarget(null, { type: 'dragleave', container: 'sidebar', stillInside: false })).toBeNull();
  });

  it('drop 与 dragend 都清位（落定或放弃都不留悬空高亮）', () => {
    expect(nextDropTarget('aux', { type: 'dropped' })).toBeNull();
    expect(nextDropTarget('aux', { type: 'dragend' })).toBeNull();
  });
});

describe('端到端：事件序列 → 状态机 → 编排结果', () => {
  it('把 explorer 整组拖到副侧栏后，侧栏视图消失、aux 出现这两个面板', () => {
    let state = defaultLayout(organizePanels(PANELS, {}));
    let target = nextDropTarget(null, { type: 'dragover', container: 'aux' });
    // 组内挪动一次（不清高亮），再落定
    target = nextDropTarget(target, { type: 'dragleave', container: 'aux', stillInside: true });
    expect(target).toBe('aux');

    const ids = decodeDroppedPanelIds(groupPayload(['tree', 'files']));
    for (const intent of planPanelMoves(ids, PANELS, 'aux')) {
      state = layoutReducer(state, { type: 'move', id: intent.id, to: intent.to, viewKey: intent.viewKey });
    }
    target = nextDropTarget(target, { type: 'dropped' });
    expect(target).toBeNull();

    const org = organizePanels(PANELS, state.panelLocations);
    expect(org.views).toHaveLength(0); // 整组搬空，侧栏不再有其视图
    expect(org.aux.map((p) => p.id)).toEqual(['inspect', 'tree', 'files']); // aux 按 order 升序（inspect=1）
    expect(state.aux).toMatchObject({ visible: true, active: 'files' });
  });

  it('拖到底部区再拖回侧栏：override 收敛到最后一次落点，不留陈旧记账', () => {
    let state = defaultLayout(organizePanels(PANELS, {}));
    for (const to of ['bottom', 'sidebar'] as const) {
      for (const intent of planPanelMoves(['report'], PANELS, to)) {
        state = layoutReducer(state, { type: 'move', id: intent.id, to: intent.to, viewKey: intent.viewKey });
      }
    }
    expect(state.panelLocations).toEqual({ report: 'sidebar' });
    const org = organizePanels(PANELS, state.panelLocations);
    expect(org.bottom.map((p) => p.id)).toEqual([]);
    expect(org.views.map((v) => v.key)).toContain('panel:report');
    expect(state.sidebar.active).toBe('panel:report');
  });

  it('不接受的拖拽（外部文本）走完整链路也不会改动布局', () => {
    const state = defaultLayout(organizePanels(PANELS, {}));
    expect(acceptsPanelDrop(['text/plain'])).toBe(false);
    // 即便载荷侥幸到达（浏览器差异），空/坏载荷也只能得到零意图
    expect(planPanelMoves(decodeDroppedPanelIds(null), PANELS, 'aux')).toEqual([]);
    expect(state.panelLocations).toEqual({});
  });
});
