import { describe, expect, it } from 'vitest';
import { kojo2AdapterForProject, registerKojo2Adapter } from '../src/bootstrap';
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
 * ③ `adapterId` 缺席 / 该游戏没有 2.0 面 ⇒ `null`（**不猜、不借表**——
 *    "回退到某一枚"正是错误事实的来源）；
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
    // eraAkumaMaid 今天没有 2.0 面 ⇒ 查不到 ⇒ null（而不是借 eraTW 的）
    expect(kojo2AdapterForProject({ adapterId: 'eraakumamaid' })).toBeNull();
    expect(kojo2AdapterForProject({ adapterId: 'erafl' })).toBeNull();
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
