import { describe, expect, it } from 'vitest';
import {
  applyPin,
  batchCloseEmptyReason,
  planBatchClose,
  planReorder,
  tabClassName,
  tabMenuItemsFor,
} from '../src/ui/tabs-ops';

/**
 * 标签栏能力（C1 右键菜单 / C2 固定标签）的纯逻辑锁。
 *
 * 这里钉的三条设计决策：
 * 1. **pinned 永远不在批量清扫范围**——「其他/全部」明文豁免，「右侧」区间里的
 *    固定标签同样不扫：pin 只能被用户显式取消（右键或拖出固定区），批量动作绝不动它；
 * 2. **拖拽跨固定区分界 = 自动改固定态**——落点指示画哪标签落哪（所见即所得）；
 *    固定区内部的相对顺序照常可调，不触发改态；
 * 3. **顺序只有一份真源**——openTabs 本身维持「固定区在前」，applyPin / planReorder
 *   负责维持这条不变量，渲染层不再排序。
 */

describe('planBatchClose · 批量关闭计划（哪些关哪些留）', () => {
  const tabs = ['a.ERB', 'b.ERB', 'c.ERB', 'd.ERB'];

  it('关闭其他：锚点留下，其余全关（无固定时）', () => {
    const plan = planBatchClose('others', tabs, 'c.ERB', new Set());
    expect(plan.toClose).toEqual(['a.ERB', 'b.ERB', 'd.ERB']);
    expect(plan.kept).toEqual(['c.ERB']);
  });

  it('关闭其他：固定标签豁免清扫（锚点自身固定也留）', () => {
    const plan = planBatchClose('others', tabs, 'c.ERB', new Set(['b.ERB', 'c.ERB']));
    expect(plan.toClose).toEqual(['a.ERB', 'd.ERB']);
    expect(plan.kept).toEqual(['b.ERB', 'c.ERB']);
  });

  it('关闭右侧：以右键的标签为界（与 pin 无关），右侧固定标签同样不扫', () => {
    // 固定区在前的常态：p 在前，锚点是非固定标签——右侧没有固定标签
    const plan = planBatchClose('right', tabs, 'b.ERB', new Set(['a.ERB']));
    expect(plan.toClose).toEqual(['c.ERB', 'd.ERB']);
    expect(plan.kept).toEqual(['a.ERB', 'b.ERB']);
    // 锚点自己就是固定标签（固定区内右键）：右侧的其他固定标签不扫
    const inPin = planBatchClose('right', ['p1', 'p2', 'u'], 'p1', new Set(['p1', 'p2']));
    expect(inPin.toClose).toEqual(['u']);
    expect(inPin.kept).toEqual(['p1', 'p2']);
  });

  it('关闭全部：只留固定标签', () => {
    const plan = planBatchClose('all', tabs, 'a.ERB', new Set(['b.ERB']));
    expect(plan.toClose).toEqual(['a.ERB', 'c.ERB', 'd.ERB']);
    expect(plan.kept).toEqual(['b.ERB']);
  });

  it('待关清单保持 openTabs 原序（逐个确认链的顺序稳定）', () => {
    const plan = planBatchClose('all', ['d', 'c', 'b', 'a'], 'd', new Set());
    expect(plan.toClose).toEqual(['d', 'c', 'b', 'a']);
  });

  it('锚点不在打开列表里（极端时序）：空计划不误关任何标签', () => {
    const plan = planBatchClose('others', tabs, 'gone.ERB', new Set());
    expect(plan.toClose).toEqual([]);
    expect(plan.kept).toEqual(tabs);
  });

  it('全部固定时「关闭全部」无可作为（toClose 空，交给 batchCloseEmptyReason 说人话）', () => {
    const plan = planBatchClose('all', tabs, 'a.ERB', new Set(tabs));
    expect(plan.toClose).toEqual([]);
  });

  it('不修改入参数组', () => {
    const input = [...tabs];
    planBatchClose('all', input, 'a.ERB', new Set(['b.ERB']));
    expect(input).toEqual(tabs);
  });
});

describe('batchCloseEmptyReason · 无可作为时的一句人话（铁律 4）', () => {
  it('关闭其他：只有锚点自己 → 「没有其他标签」；其余全固定 → 另一句', () => {
    expect(batchCloseEmptyReason('others', ['a'], 'a', new Set())).toBe('没有其他标签');
    expect(batchCloseEmptyReason('others', ['a', 'p'], 'a', new Set(['p']))).toBe(
      '其他标签都已固定，没有可关闭的',
    );
  });

  it('关闭右侧：右边没标签 / 右边只剩固定的，同一句话', () => {
    expect(batchCloseEmptyReason('right', ['a', 'b'], 'b', new Set())).toBe('右侧没有可关闭的标签');
    expect(batchCloseEmptyReason('right', ['p', 'b'], 'b', new Set(['p']))).toBe(
      '右侧没有可关闭的标签',
    );
  });

  it('关闭全部：全固定 → 点名固定标签不扫', () => {
    expect(batchCloseEmptyReason('all', ['p', 'q'], 'p', new Set(['p', 'q']))).toBe(
      '固定标签不会被关闭，没有可关闭的标签',
    );
  });
});

describe('applyPin · 固定/取消固定的顺序重排（维持固定区在前）', () => {
  it('pin：挪到固定区末尾', () => {
    expect(applyPin(['a', 'b', 'c'], 'b', true, new Set(['a']))).toEqual(['a', 'b', 'c']);
    expect(applyPin(['a', 'b', 'c'], 'c', true, new Set(['a']))).toEqual(['a', 'c', 'b']);
  });

  it('pin：固定区为空时挪到最前', () => {
    expect(applyPin(['a', 'b', 'c'], 'c', true, new Set())).toEqual(['c', 'a', 'b']);
  });

  it('unpin：挪到非固定区开头（紧贴分界，不跳到队尾）', () => {
    expect(applyPin(['p1', 'p2', 'u'], 'p1', false, new Set(['p1', 'p2']))).toEqual([
      'p2',
      'p1',
      'u',
    ]);
    expect(applyPin(['p1', 'p2', 'u1', 'u2'], 'p2', false, new Set(['p1', 'p2']))).toEqual([
      'p1',
      'p2',
      'u1',
      'u2',
    ]);
  });

  it('path 不在列表里：原样返回（不动）', () => {
    expect(applyPin(['a', 'b'], 'gone', true, new Set())).toEqual(['a', 'b']);
  });

  it('不修改入参数组', () => {
    const input = ['a', 'b', 'c'];
    applyPin(input, 'a', false, new Set(['a']));
    expect(input).toEqual(['a', 'b', 'c']);
  });
});

describe('planReorder · 拖拽重排与固定区分界', () => {
  it('区内移动：不触发改固定态（固定区内/非固定区内都一样）', () => {
    const r1 = planReorder(['a', 'b', 'c'], 'a', 2, new Set());
    expect(r1).toEqual({ order: ['b', 'c', 'a'], pinChange: null });
    const r2 = planReorder(['p1', 'p2', 'u'], 'p1', 1, new Set(['p1', 'p2']));
    expect(r2).toEqual({ order: ['p2', 'p1', 'u'], pinChange: null });
  });

  it('非固定标签拖进固定区 ⇒ 自动固定（落点指示画哪就落在哪）', () => {
    const r = planReorder(['p1', 'p2', 'u1', 'u2'], 'u1', 0, new Set(['p1', 'p2']));
    expect(r.order).toEqual(['u1', 'p1', 'p2', 'u2']);
    expect(r.pinChange).toEqual({ path: 'u1', pin: true });
  });

  it('固定标签拖出固定区 ⇒ 自动取消固定', () => {
    const r = planReorder(['p1', 'p2', 'u'], 'p1', 2, new Set(['p1', 'p2']));
    expect(r.order).toEqual(['p2', 'u', 'p1']);
    expect(r.pinChange).toEqual({ path: 'p1', pin: false });
  });

  it('toIndex 越界钳制到两端（旧 reorderTab 的口径延续）', () => {
    const r = planReorder(['a', 'b', 'c'], 'a', 99, new Set());
    expect(r.order).toEqual(['b', 'c', 'a']);
    expect(planReorder(['a', 'b', 'c'], 'c', -5, new Set()).order).toEqual(['c', 'a', 'b']);
  });

  it('path 不在列表里：原样返回不触发改态', () => {
    expect(planReorder(['a', 'b'], 'gone', 0, new Set())).toEqual({
      order: ['a', 'b'],
      pinChange: null,
    });
  });
});

describe('tabMenuItemsFor · 标签右键菜单', () => {
  it('六项恒在，不灰不缺（无可作为时由宿主回一句人话）', () => {
    const items = tabMenuItemsFor(false);
    expect(items.map((i) => i.id)).toEqual([
      'close',
      'close-others',
      'close-right',
      'close-all',
      'toggle-pin',
      'copy-path',
    ]);
  });

  it('固定态切换文案：固定 ⇄ 取消固定；分隔线在切换项之前', () => {
    expect(tabMenuItemsFor(false).find((i) => i.id === 'toggle-pin')?.label).toBe('固定标签');
    const pinned = tabMenuItemsFor(true);
    expect(pinned.find((i) => i.id === 'toggle-pin')?.label).toBe('取消固定');
    expect(pinned.find((i) => i.id === 'toggle-pin')?.dividerBefore).toBe(true);
  });
});

describe('tabClassName · 活动/固定/落点指示三态叠加', () => {
  it('裸标签 = editor-tab 单类', () => {
    expect(tabClassName('a', false, false, null)).toBe('editor-tab');
  });
  it('活动 + 固定可叠加', () => {
    expect(tabClassName('a', true, true, null)).toBe('editor-tab active pinned');
  });
  it('落点指示按命中标签分左右（左半 = drop-before，右半 = drop-after）', () => {
    expect(tabClassName('a', false, false, { path: 'a', before: true })).toBe(
      'editor-tab drop-before',
    );
    expect(tabClassName('a', false, false, { path: 'a', before: false })).toBe(
      'editor-tab drop-after',
    );
    expect(tabClassName('a', false, false, { path: 'b', before: true })).toBe('editor-tab');
  });
  it('活动标签上的落点指示与顶部指示共存（both 类都在）', () => {
    expect(tabClassName('a', true, false, { path: 'a', before: false })).toBe(
      'editor-tab active drop-after',
    );
  });
});
