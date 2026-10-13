import { describe, expect, it } from 'vitest';
import type { UIPanelContribution } from '@kojo/plugin-api';
import { defaultLayout, organizePanels, reducer, type LayoutState } from '../src/ui/layout';

/**
 * 壳层布局动作表单测（2026-10-13 P4 补测批）。
 *
 * `reducer` 住在 `layout.ts`（上游 2026-10-13 设置页归一批把内联在 ShellLayout 里的它搬了过来）。
 * `layout.test.ts` 里那组测的是**设置页三个开关**，本文件测的是 **P4 的 move / resize / 容器动作**
 * ——同一张表的两副面孔，各自有尺子，不重叠也不留空白。
 *
 * P4 的拖拽停靠与全禅全靠这张动作表落地，此前零新增测试。盯的是三类会静默出错的判据：
 * ① 激活单位随容器换词汇（sidebar = 视图 key，aux/bottom = 面板 id）；
 * ② 尺寸必须钳制（拖出负值会让容器塌陷）；③ 全禅相关动作必须是**可预期的最小改动**
 * （`exitZen` 在非全禅时返回同一对象引用，避免每次 Esc 都触发一次持久化写入）。
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

function baseState(): LayoutState {
  return defaultLayout(organizePanels(PANELS, {}));
}

describe('move：拖拽停靠的唯一改动面', () => {
  it('移到 aux：override 记账 + 容器打开 + 激活该面板（aux 的激活单位是面板 id）', () => {
    const s = reducer(baseState(), { type: 'move', id: 'tree', to: 'aux', viewKey: 'group:explorer' });
    expect(s.panelLocations).toEqual({ tree: 'aux' });
    expect(s.aux).toMatchObject({ visible: true, active: 'tree' });
    // 侧栏的激活项不受牵连
    expect(s.sidebar.active).toBe('group:explorer');
  });

  it('移到 sidebar：激活单位换成视图 key，不是面板 id', () => {
    const s = reducer(baseState(), { type: 'move', id: 'report', to: 'sidebar', viewKey: 'panel:report' });
    expect(s.panelLocations).toEqual({ report: 'sidebar' });
    expect(s.sidebar).toMatchObject({ visible: true, active: 'panel:report' });
  });

  it('跨容器连拖三次（sidebar → aux → bottom）：override 始终指向最后一站', () => {
    let s = baseState();
    s = reducer(s, { type: 'move', id: 'files', to: 'aux', viewKey: 'panel:files' });
    s = reducer(s, { type: 'move', id: 'files', to: 'bottom', viewKey: 'panel:files' });
    expect(s.panelLocations).toEqual({ files: 'bottom' });
    expect(s.bottom).toMatchObject({ visible: true, active: 'files' });
    // 编排结果随之改变：files 已不在侧栏组员里
    const org = organizePanels(PANELS, s.panelLocations);
    expect(org.bottom.map((p) => p.id)).toContain('files');
    expect(org.views.find((v) => v.key === 'group:explorer')?.panels.map((p) => p.id)).toEqual(['tree']);
  });

  it('同容器换位（aux 内换激活面板）合法：override 落定，aux 仍可见', () => {
    const moved = reducer(baseState(), { type: 'move', id: 'tree', to: 'aux', viewKey: null });
    const again = reducer(moved, { type: 'move', id: 'inspect', to: 'aux', viewKey: null });
    expect(again.panelLocations).toEqual({ tree: 'aux', inspect: 'aux' });
    expect(again.aux).toMatchObject({ visible: true, active: 'inspect' });
  });

  it('move 不污染其它容器的显隐与尺寸', () => {
    const before = baseState();
    const s = reducer(before, { type: 'move', id: 'tree', to: 'bottom', viewKey: null });
    expect(s.sidebar.visible).toBe(before.sidebar.visible);
    expect(s.sidebar.size).toBe(before.sidebar.size);
    expect(s.aux.visible).toBe(before.aux.visible);
    expect(s.zen).toBe(false);
  });
});

describe('toggle / activate / resize', () => {
  it('toggle 只翻显隐，尺寸与激活项原样', () => {
    const s = reducer(baseState(), { type: 'toggle', container: 'aux' });
    expect(s.aux).toMatchObject({ visible: true });
    expect(s.aux.size).toBe(baseState().aux.size);
    expect(s.aux.active).toBe('inspect');
    // 再翻一次回到隐藏（幂等可逆）
    expect(reducer(s, { type: 'toggle', container: 'aux' }).aux.visible).toBe(false);
  });

  it('activate 强制带出容器（点标签即打开，不需要先 toggle）', () => {
    // 默认形态下 bottom 已是隐藏态，直接 activate 必须把它带出来
    expect(baseState().bottom.visible).toBe(false);
    expect(reducer(baseState(), { type: 'activate', container: 'bottom', key: 'report' }).bottom).toMatchObject({
      visible: true,
      active: 'report',
    });
  });

  it('resize 钳进 SIZE_LIMITS：侧栏拖过头 9999 收在 520，负向收在 160', () => {
    expect(reducer(baseState(), { type: 'resize', container: 'sidebar', size: 9999 }).sidebar.size).toBe(520);
    expect(reducer(baseState(), { type: 'resize', container: 'sidebar', size: -80 }).sidebar.size).toBe(160);
    expect(reducer(baseState(), { type: 'resize', container: 'sidebar', size: 300 }).sidebar.size).toBe(300);
  });

  it('resize 底部区按高度钳制（与侧栏不同一套上下限，不可共用常量）', () => {
    expect(reducer(baseState(), { type: 'resize', container: 'bottom', size: 4000 }).bottom.size).toBe(480);
    expect(reducer(baseState(), { type: 'resize', container: 'bottom', size: 10 }).bottom.size).toBe(120);
  });
});

describe('全禅（P4 §八）', () => {
  it('toggleZen 是反转，不是置位', () => {
    expect(reducer(baseState(), { type: 'toggleZen' }).zen).toBe(true);
    expect(reducer({ ...baseState(), zen: true }, { type: 'toggleZen' }).zen).toBe(false);
  });

  it('exitZen 只在全禅中才产生新状态（非全禅时同一对象引用 ⇒ 每次 Esc 不触发多余持久化）', () => {
    const normal = baseState();
    expect(reducer(normal, { type: 'exitZen' })).toBe(normal);
    const zen = { ...normal, zen: true };
    expect(reducer(zen, { type: 'exitZen' })).not.toBe(zen);
    expect(reducer(zen, { type: 'exitZen' }).zen).toBe(false);
  });

  it('限宽开关是显式赋值：false 能关掉，true 能开回', () => {
    expect(reducer(baseState(), { type: 'setZenLimitWidth', value: false }).zenLimitWidth).toBe(false);
    expect(reducer({ ...baseState(), zenLimitWidth: false }, { type: 'setZenLimitWidth', value: true }).zenLimitWidth).toBe(true);
  });

  it('全禅动作互不牵连：toggleZen 不动 panelLocations / 容器尺寸', () => {
    const moved = reducer(baseState(), { type: 'move', id: 'tree', to: 'aux', viewKey: null });
    const zen = reducer(moved, { type: 'toggleZen' });
    expect(zen.panelLocations).toEqual(moved.panelLocations);
    expect(zen.aux).toEqual(moved.aux);
  });

  it('reset 整体替换为传入状态（「重置布局」由调用方给默认值，reducer 不藏规则）', () => {
    const target = { ...baseState(), zen: true, zenLimitWidth: false };
    expect(reducer(baseState(), { type: 'reset', state: target })).toBe(target);
  });
});

/**
 * reconcile：封存总闸切换后面板集合增删的再清洗（2026-10-13 试用反馈批）。
 *
 * 封存 = 面板集合少两个（解封 = 加回来），持久化的 active / 位置 override 可能
 * 指向已不在集合里的面板——`reconcile` 动作把既有清洗器（`reconcileLayout`）接进
 * reducer 表，这里钉住"按新集合清洗"这一件事。
 */
describe('reconcile：封存总闸切换后面板集合增删的再清洗', () => {
  const beforeSeal = [
    panel('inspect', { location: 'aux', order: 1 }),
    panel('peek', { location: 'aux', order: 2 }),
    panel('report', { location: 'bottom', order: 1 }),
  ];

  it('aux.active 指向被拿掉的面板 → 回落新集合首个；指向它的 override 被清掉', () => {
    const persisted: LayoutState = {
      ...defaultLayout(organizePanels(beforeSeal, {})),
      aux: { visible: true, size: 300, active: 'inspect' },
      panelLocations: { inspect: 'aux' },
    };
    // 封存后 'inspect' 从面板集合中消失，org 按新集合重建
    const orgAfterSeal = organizePanels(
      beforeSeal.filter((p) => p.id !== 'inspect'),
      {},
    );
    const s = reducer(persisted, { type: 'reconcile', org: orgAfterSeal });
    expect(s.aux.active).toBe('peek');
    expect(s.panelLocations).toEqual({});
    expect(s.aux.visible).toBe(true); // 容器显隐是用户姿态，不因清洗被静默翻掉
  });
});

describe('float / dock / moveFloating / resizeFloating（2026-10-14 UI 浮动批）', () => {
  const geo = { x: 100, y: 80, w: 640, h: 480 };

  it('float 记账几何；重复 float 幂等（不覆盖既有几何）', () => {
    const s = reducer(baseState(), { type: 'float', id: 'inspect', geometry: geo });
    expect(s.floating.inspect).toEqual(geo);
    const again = reducer(s, { type: 'float', id: 'inspect', geometry: { x: 0, y: 0, w: 1, h: 1 } });
    expect(again.floating.inspect).toEqual(geo);
  });

  it('dock 移除记账；对未浮动面板是空操作（同一对象引用）', () => {
    const s = reducer(baseState(), { type: 'float', id: 'inspect', geometry: geo });
    expect('inspect' in reducer(s, { type: 'dock', id: 'inspect' }).floating).toBe(false);
    const base = baseState();
    expect(reducer(base, { type: 'dock', id: 'nope' })).toBe(base);
  });

  it('moveFloating 只改位置；resizeFloating 钳制最小尺寸', () => {
    const s = reducer(baseState(), { type: 'float', id: 'inspect', geometry: geo });
    const moved = reducer(s, { type: 'moveFloating', id: 'inspect', x: 300, y: 200 });
    expect(moved.floating.inspect).toEqual({ x: 300, y: 200, w: 640, h: 480 });
    const resized = reducer(moved, { type: 'resizeFloating', id: 'inspect', w: 10, h: 10 });
    expect(resized.floating.inspect).toMatchObject({ w: 320, h: 220 });
    expect(reducer(moved, { type: 'resizeFloating', id: 'inspect', w: 800, h: 600 }).floating.inspect).toMatchObject({ w: 800, h: 600 });
  });

  it('reconcile 清洗：浮动指向已消失的面板 → 记账被清掉', () => {
    const withFloat = reducer(baseState(), { type: 'float', id: 'inspect', geometry: geo });
    const orgAfterSeal = organizePanels(PANELS.filter((p) => p.id !== 'inspect'), {});
    expect(reducer(withFloat, { type: 'reconcile', org: orgAfterSeal }).floating).toEqual({});
  });
});
