import { describe, expect, it } from 'vitest';
import { kojo2AdapterForProject, registerKojo2Adapter, registerKojo2SurfacesFromModules } from '../src/bootstrap';
import { projectAdapters } from '../src/adapter-manifest';
import { ERATW_GAME_ADAPTER } from '@kojo/plugin-eratw-adapter';
import type { GameAdapter as Kojo2GameAdapter } from '@kojo/kojo-core';

/**
 * 入口 A（2026-10-24）：2.0 adapter 登记簿的**语义**闸。
 *
 * 为什么是行为级而不是源码级：这张表的全部意义在运行期"查得到 / 查不到时给什么"，
 * 源码正则说不出"取不到时返回 null"——而那正是修掉的那个 bug 的核心
 * （此前写死 `ERATW_GAME_ADAPTER`：打开 eraFL 工程，2.0 面拿到 eraTW 的事实，
 * 不报错、只是错）。
 *
 * 钉住四件事：
 * ① eraTW 常驻（模块加载即进表，键 = v1 `gameId`，值 = 2.0 adapter）；
 * ② 没开项目 ⇒ `null`；
 * ③ `adapterId` 缺席 / 该游戏没有 2.0 面、或本文件**尚未登记** ⇒ `null`
 *    （**不猜、不借表**——"回退到某一枚"正是错误事实的来源）；
 * ④ 登记 / 现取 round-trip（eraFL 等后续 adapter 进表走同一机制；
 *    `loadProjectPlugins` 里那个存在性卫句只负责"亮灯"，机制在本文件）。
 */
describe('2.0 adapter 登记簿（入口 A · 按项目选 adapter）', () => {
  it('eraTW 常驻登记：键 = v1 gameId，值 = 2.0 adapter（同一枚实例）', () => {
    expect(kojo2AdapterForProject({ adapterId: 'eratw' })).toBe(ERATW_GAME_ADAPTER);
  });

  it('没开项目 ⇒ null', () => {
    expect(kojo2AdapterForProject(null)).toBeNull();
  });

  it('adapterId 缺席 / 未知游戏 ⇒ null（不猜、不借表）', () => {
    expect(kojo2AdapterForProject({})).toBeNull();
    // 清单外游戏 / 本测试文件未登记的游戏 ⇒ null（而不是借 eraTW 的）
    expect(kojo2AdapterForProject({ adapterId: 'no-such-game' })).toBeNull();
  });

  it('eraFL 的 2.0 面：按 v1 gameId 登记后解析到 ERAFL_GAME_ADAPTER（入口 B 的接线契约）', async () => {
    // 入口 B（erafl-adapter/src/kojo2/）交付后，bootstrap 的懒登记钩子在
    // `loadProjectPlugins` 里做这件事：键 = `ERAFL.gameId`（v1 的工程识别键，
    // §6.3：project.adapterId 存的是 v1 gameId，不是 2.0 的 id），值 = 2.0 adapter。
    // 本测试不触发钩子（不调 loadProjectPlugins），用真对象手工证明这条契约。
    const erafl = await import('@kojo/plugin-erafl-adapter');
    registerKojo2Adapter(erafl.ERAFL.gameId, erafl.ERAFL_GAME_ADAPTER);
    expect(kojo2AdapterForProject({ adapterId: 'erafl' })).toBe(erafl.ERAFL_GAME_ADAPTER);
    // 键必须是 v1 gameId：用 2.0 的 id 查不到（两个 id 今天恰好同值，但契约上
    // 查的是 v1 键——写错的表现是"打开项目后 2.0 面全部零候选"且不报错）。
    expect(kojo2AdapterForProject({ adapterId: erafl.ERAFL.gameId })).toBe(erafl.ERAFL_GAME_ADAPTER);
  });

  it('清单驱动的四家新 2.0 面：键 = entry.id（v1 gameId），值 = 包导出本体', async () => {
    // T5 之后六枚 project adapter 全部声明了 `kojo2AdapterExport`：清单驱动的泛化登记
    // （`registerKojo2SurfacesFromModules`）对四家新面做的是同一件事——键取 `entry.id`
    // （= v1 `gameId`）、值取包导出本体，不经过任何游戏分支。
    const entries = projectAdapters().filter((entry) => entry.kojo2AdapterExport !== undefined);
    const modules = await Promise.all(entries.map((entry) => entry.load!()));
    registerKojo2SurfacesFromModules(entries, modules);
    expect(entries.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['erasqc', 'eratohok', 'erakoumakan', 'eraakumamaid']),
    );
    for (const [index, entry] of entries.entries()) {
      const exported = (modules[index] as Record<string, unknown>)[entry.kojo2AdapterExport!];
      expect(exported).toBeDefined();
      const resolved = kojo2AdapterForProject({ adapterId: entry.id });
      expect(resolved).toBe(exported);
      expect(resolved).not.toBe(ERATW_GAME_ADAPTER);
    }
  });

  it('登记后现取 round-trip；重复登记以最后一次为准', () => {
    const first = { id: 'stub-game' } as unknown as Kojo2GameAdapter;
    const second = { id: 'stub-game' } as unknown as Kojo2GameAdapter;
    registerKojo2Adapter('stub-game', first);
    expect(kojo2AdapterForProject({ adapterId: 'stub-game' })).toBe(first);
    registerKojo2Adapter('stub-game', second);
    expect(kojo2AdapterForProject({ adapterId: 'stub-game' })).toBe(second);
  });
});
