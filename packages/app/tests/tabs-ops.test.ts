import { describe, expect, it } from 'vitest';
import {
  TAB_DRAG_MIME,
  applyPin,
  batchCloseEmptyReason,
  clampIndexToPinZone,
  decodeTabDragPayload,
  encodeTabDragPayload,
  moveToGroupTargetOf,
  planBatchClose,
  planReorder,
  planTabDrop,
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
  /** 最保守的一组事实（无资源管理器 / 无命令通道 / 无项目根 / 单组）：只看「恒在」的那几条 */
  const baseFacts = {
    pinned: false,
    hasSaved: true,
    canReveal: false,
    hasReopen: false,
    canSplit: false,
    hasRoot: false,
    otherGroups: [],
  };

  it('关闭类五项 + 固定 + 三档复制 + 移动到组 + 拆分两项恒在（缺省事实下）', () => {
    const items = tabMenuItemsFor(baseFacts);
    expect(items.map((i) => i.id)).toEqual([
      'close',
      'close-others',
      'close-right',
      'close-saved',
      'close-all',
      'toggle-pin',
      'copy-path',
      'copy-name',
      'move-to-group',
      'split-right',
      'split-down',
    ]);
  });

  it('固定态切换文案：固定 ⇄ 取消固定；分隔线在切换项之前', () => {
    expect(tabMenuItemsFor(baseFacts).find((i) => i.id === 'toggle-pin')?.label).toBe('固定标签');
    const pinned = tabMenuItemsFor({ ...baseFacts, pinned: true });
    expect(pinned.find((i) => i.id === 'toggle-pin')?.label).toBe('取消固定');
    expect(pinned.find((i) => i.id === 'toggle-pin')?.dividerBefore).toBe(true);
  });

  it('「移动到组」：没有其他组时灰着并说清原因（不画空壳子菜单）', () => {
    const item = tabMenuItemsFor(baseFacts).find((i) => i.id === 'move-to-group');
    expect(item?.disabled).toBe(true);
    expect(item?.disabledReason).toBe('没有其他编辑器组（先向右或向下拆分）');
    expect(item?.children).toBeUndefined();
    // 单组时它是分屏段的段首 ⇒ 自带分隔线（与「在新编辑器组打开」此消彼长）
    expect(item?.dividerBefore).toBe(true);
  });

  it('「移动到组」：有其他组时出子菜单，id 形如 move-to-group:<组 id>', () => {
    const items = tabMenuItemsFor({
      ...baseFacts,
      canSplit: true,
      otherGroups: [
        { id: 'eg-2', label: '第 2 组' },
        { id: 'eg-3', label: '第 3 组' },
      ],
    });
    const item = items.find((i) => i.id === 'move-to-group');
    expect(item?.disabled).toBeUndefined();
    expect(item?.children?.map((c) => c.id)).toEqual(['move-to-group:eg-2', 'move-to-group:eg-3']);
    expect(item?.children?.map((c) => c.label)).toEqual(['第 2 组', '第 3 组']);
    // 命令通道在时，段首分隔线归「在新编辑器组打开」，它不带
    expect(item?.dividerBefore).toBeUndefined();
    expect(moveToGroupTargetOf(item!.children![0]!.id)).toBe('eg-2');
    expect(moveToGroupTargetOf('move-to-group')).toBeNull();
    expect(moveToGroupTargetOf('move-to-group:')).toBeNull();
    expect(moveToGroupTargetOf('close')).toBeNull();
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

/* --------------------- 1027 跨组批：拖拽载荷与落点计划 --------------------- */

describe('拖拽载荷 · 编码 / 解码（损坏容忍）', () => {
  it('往返不丢信息（组 id + 路径）', () => {
    const encoded = encodeTabDragPayload('eg-2', 'C:/koa/a.ERB');
    expect(decodeTabDragPayload(encoded)).toEqual({ groupId: 'eg-2', path: 'C:/koa/a.ERB' });
  });

  it('源组未知（null）也照常往返', () => {
    expect(decodeTabDragPayload(encodeTabDragPayload(null, 'C:/koa/a.ERB'))).toEqual({
      groupId: null,
      path: 'C:/koa/a.ERB',
    });
  });

  it('旧版裸路径载荷：当路径收下，源组按未知处理', () => {
    expect(decodeTabDragPayload('C:/koa/a.ERB')).toEqual({ groupId: null, path: 'C:/koa/a.ERB' });
  });

  it('空串 = 不是一次标签拖拽（回 null）', () => {
    expect(decodeTabDragPayload('')).toBeNull();
  });

  it('形状不对的 JSON：原文整条当路径（不抛错、不吞掉拖拽）', () => {
    expect(decodeTabDragPayload('{"foo":1}')).toEqual({ groupId: null, path: '{"foo":1}' });
    const raw = '{"path":"C:/koa/a.ERB","groupId":42}';
    expect(decodeTabDragPayload(raw)).toEqual({ groupId: null, path: 'C:/koa/a.ERB' });
  });

  it('MIME 是跨模块共享的常量（不是某一组件内的私有串）', () => {
    expect(TAB_DRAG_MIME).toBe('application/x-kojo-tab-move');
  });
});

describe('planTabDrop · 落点计划（同组重排 / 跨组移动）', () => {
  const tabs = ['a', 'b', 'c'];

  it('跨组：命中标签左半 / 右半折算目标组插入下标（不做同组删除位移修正）', () => {
    const drag = { groupId: 'g1', path: 'z' };
    expect(
      planTabDrop(drag, { groupId: 'g2', tabs, targetPath: 'b', before: true }),
    ).toEqual({ kind: 'move', path: 'z', fromGroupId: 'g1', toGroupId: 'g2', toIndex: 1 });
    expect(
      planTabDrop(drag, { groupId: 'g2', tabs, targetPath: 'b', before: false }),
    ).toEqual({ kind: 'move', path: 'z', fromGroupId: 'g1', toGroupId: 'g2', toIndex: 2 });
  });

  it('跨组：拖到标签栏空白 = 追加到目标组末尾', () => {
    expect(
      planTabDrop({ groupId: 'g1', path: 'z' }, { groupId: 'g2', tabs, targetPath: null, before: false }),
    ).toEqual({ kind: 'move', path: 'z', fromGroupId: 'g1', toGroupId: 'g2', toIndex: 3 });
  });

  it('跨组：目标组已有同路径也照常报落点（去重由组态纯函数负责）', () => {
    const plan = planTabDrop(
      { groupId: 'g1', path: 'c' },
      { groupId: 'g2', tabs, targetPath: 'a', before: true },
    );
    expect(plan).toMatchObject({ kind: 'move', path: 'c', toIndex: 0 });
  });

  it('同组：删除后插入语义（旧口径），from === to 视为无操作', () => {
    const plan = planTabDrop(
      { groupId: 'g1', path: 'a' },
      { groupId: 'g1', tabs, targetPath: 'b', before: false },
    );
    expect(plan).toMatchObject({ kind: 'reorder', path: 'a', fromGroupId: 'g1', toGroupId: 'g1', toIndex: 1 });
    // 拖到自己身上 / 拖到"紧邻原位"的同一侧 ⇒ 无操作
    expect(
      planTabDrop({ groupId: 'g1', path: 'b' }, { groupId: 'g1', tabs, targetPath: 'b', before: true }).kind,
    ).toBe('none');
    expect(
      planTabDrop({ groupId: 'g1', path: 'b' }, { groupId: 'g1', tabs, targetPath: 'b', before: false }).kind,
    ).toBe('none');
  });

  it('同组：拖到空白 = 追加到末尾（已在末尾 ⇒ 无操作）', () => {
    expect(
      planTabDrop({ groupId: 'g1', path: 'a' }, { groupId: 'g1', tabs, targetPath: null, before: false }),
    ).toMatchObject({ kind: 'reorder', path: 'a', toIndex: 2 });
    expect(
      planTabDrop({ groupId: 'g1', path: 'c' }, { groupId: 'g1', tabs, targetPath: null, before: false }).kind,
    ).toBe('none');
  });

  it('旧版裸路径载荷：本组开着它按同组重排，没开则因源组未知而不猜', () => {
    expect(
      planTabDrop({ groupId: null, path: 'a' }, { groupId: 'g1', tabs, targetPath: null, before: false }),
    ).toMatchObject({ kind: 'reorder', path: 'a' });
    expect(
      planTabDrop({ groupId: null, path: 'z' }, { groupId: 'g2', tabs, targetPath: null, before: false }).kind,
    ).toBe('none');
  });

  it('落空 / 空载荷 ⇒ 无操作（不抛错）', () => {
    expect(planTabDrop(null, { groupId: 'g1', tabs, targetPath: 'a', before: true }).kind).toBe('none');
    expect(planTabDrop({ groupId: 'g2', path: 'z' }, { groupId: 'g1', tabs, targetPath: 'gone', before: true }).kind).toBe('none');
  });
});

describe('clampIndexToPinZone · 固定区 / 非固定区分界', () => {
  const pinned = new Set(['p1', 'p2']);
  const tabs = ['p1', 'p2', 'u'];

  it('非固定标签钳到分界之后（落在固定区里的一律退到分界）', () => {
    expect(clampIndexToPinZone(tabs, 0, false, pinned)).toBe(2);
    expect(clampIndexToPinZone(tabs, 3, false, pinned)).toBe(3);
  });

  it('固定标签钳到固定区之内', () => {
    expect(clampIndexToPinZone(tabs, 3, true, pinned)).toBe(2);
    expect(clampIndexToPinZone(tabs, 1, true, pinned)).toBe(1);
  });

  it('没有固定标签时两段合并成整段；非数值按段末处理', () => {
    expect(clampIndexToPinZone(['a', 'b'], 1, false, new Set())).toBe(1);
    expect(clampIndexToPinZone(['a', 'b'], Number.NaN, false, new Set())).toBe(2);
  });
});
