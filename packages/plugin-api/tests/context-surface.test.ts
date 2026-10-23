/**
 * 插件面登记（1023 批 · 覆盖面 WP5.4：market）。
 *
 * 判据：登记幂等（同 id 覆盖 + 告警一次）、取用 / 列举、`reset` 清空；
 * 以及「登记的类型形状足够宿主直接消费」——id / 无障碍名 / 分区 / build 四件齐备。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  declarePluginContextSurface,
  getPluginContextSurface,
  listPluginContextSurfaces,
  resetPluginContextSurfaces,
  type PluginContextSurfaceSpec,
} from '../src/context-surface';

const spec = (overrides: Partial<PluginContextSurfaceSpec> = {}): PluginContextSurfaceSpec => ({
  id: 'market',
  ariaLabel: '市场菜单',
  area: 'chrome',
  build: () => ({ items: [{ id: 'market.pull', label: '拉取列表' }], onSelect: () => undefined }),
  ...overrides,
});

describe('declarePluginContextSurface · 登记语义', () => {
  it('声明即登记：按 id 取回，四件（id / 无障碍名 / 分区 / build）原样保留', () => {
    resetPluginContextSurfaces();
    declarePluginContextSurface(spec());
    const got = getPluginContextSurface('market');
    expect(got?.ariaLabel).toBe('市场菜单');
    expect(got?.area).toBe('chrome');
    expect(typeof got?.build).toBe('function');
    expect(listPluginContextSurfaces().map((s) => s.id)).toEqual(['market']);
  });

  it('幂等：同 id 反复声明只占一个位置，并告警一次（后者覆盖前者）', () => {
    resetPluginContextSurfaces();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    declarePluginContextSurface(spec());
    declarePluginContextSurface(spec({ ariaLabel: '市场菜单（新）' }));
    expect(listPluginContextSurfaces()).toHaveLength(1);
    expect(getPluginContextSurface('market')?.ariaLabel).toBe('市场菜单（新）');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('可以是「只声明元数据」的面（没有 build）：宿主据此走兜底而不是崩', () => {
    resetPluginContextSurfaces();
    declarePluginContextSurface({ id: 'market', ariaLabel: '市场菜单', area: 'chrome' });
    expect(getPluginContextSurface('market')?.build).toBeUndefined();
  });

  it('未声明的 id ⇒ undefined；reset 后全清（模块级状态不跨用例泄漏）', () => {
    resetPluginContextSurfaces();
    declarePluginContextSurface(spec());
    resetPluginContextSurfaces();
    expect(getPluginContextSurface('market')).toBeUndefined();
    expect(listPluginContextSurfaces()).toEqual([]);
  });

  it('build 收到面 id 与命中的元素（结构类型：宿主传真实元素，插件只声明用到的方法）', () => {
    resetPluginContextSurfaces();
    const seen: string[] = [];
    declarePluginContextSurface(
      spec({
        build: (ctx) => {
          seen.push(`${ctx.id}:${ctx.target.getAttribute?.('data-market-key') ?? ''}`);
          return null;
        },
      }),
    );
    getPluginContextSurface('market')?.build?.({
      id: 'market',
      target: { getAttribute: (name) => (name === 'data-market-key' ? 'k1' : null) },
    });
    expect(seen).toEqual(['market:k1']);
  });
});
