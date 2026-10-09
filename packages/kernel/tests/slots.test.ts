import { describe, expect, it } from 'vitest';
import { SlotRegistryImpl } from '../src/slots';

describe('SlotRegistryImpl', () => {
  const panel = (id: string, order?: number) => ({
    id,
    order,
    title: `panel-${id}`,
    component: () => null,
  });

  it('同槽多注册；query 按 order 升序稳定排序', () => {
    const slots = new SlotRegistryImpl();
    slots.register('ui.panel', panel('c', 5), 'p1');
    slots.register('ui.panel', panel('a', -1), 'p1');
    slots.register('ui.panel', panel('b'), 'p2');
    slots.register('ui.panel', panel('d', 5), 'p3');
    const ids = slots.query('ui.panel').map((x) => x.id);
    expect(ids).toEqual(['a', 'b', 'c', 'd']); // 同 order 按注册序（c 先于 d）
  });

  it('同槽同 id 冲突 → 抛错（不静默覆盖）', () => {
    const slots = new SlotRegistryImpl();
    slots.register('ui.panel', panel('dup'), 'p1');
    expect(() => slots.register('ui.panel', panel('dup'), 'p2')).toThrow(/already has a contribution/);
  });

  it('注册项自动注入 pluginId；unregister 精确移除', () => {
    const slots = new SlotRegistryImpl();
    const un = slots.register('game.adapter', { id: 'a1', adapter: {} as never }, 'adapter-plugin');
    expect(slots.query('game.adapter')[0]?.pluginId).toBe('adapter-plugin');
    un();
    expect(slots.query('game.adapter')).toHaveLength(0);
  });

  it('removeAllFor 撤销某插件全部注册（停用清理）', () => {
    const slots = new SlotRegistryImpl();
    slots.register('ui.panel', panel('x'), 'p1');
    slots.register('editor.command', { id: 'x', title: 'c', run: () => {} }, 'p1');
    slots.register('ui.panel', panel('y'), 'p2');
    slots.removeAllFor('p1');
    expect(slots.query('ui.panel').map((x) => x.id)).toEqual(['y']);
    expect(slots.query('editor.command')).toHaveLength(0);
  });
});
