/**
 * eraTW 的**表层↔原生双向映射表**（LAU-D4 车② 的方言列）。
 *
 * 与车① `tests/carriers.test.ts` 同一族判据：本包交的是**只读数据**，判定全在
 * `@kojo/kojo-core/surface-map` 那份读表函数里；这里只钉三件事——
 * ① 表与四个事实面逐条对得上（`checkSurfaceMap` 零诊断，错配必红的那道闸），
 * ② 形态纪律（深冻结、零函数、条数与四类事实面的名字总数一致），
 * ③ 双向投影真的能查（正/反各一枚，含别名与代词的合法重合）。
 */
import { describe, expect, it } from 'vitest';
import { checkSurfaceMap, factSurfacePairs, nativeOfSurface, surfacesOfNative } from '@kojo/kojo-core/surface-map';
import { ERATW_GAME_ADAPTER } from '@kojo/plugin-eratw-adapter';
import { ERATW_SURFACE_MAP } from '@kojo/plugin-eratw-adapter/kojo2-surface-map';

describe('表 ↔ 事实面：逐条对账零诊断（错配必红的那道闸先自证是绿的）', () => {
  it('`checkSurfaceMap(eraTW 事实, eraTW 表)` 交回空数组', () => {
    expect(checkSurfaceMap(ERATW_GAME_ADAPTER, ERATW_SURFACE_MAP)).toEqual([]);
  });

  it('条数 = 四个事实面的名字总数（少一条就是 unmapped，多一条就是 dangling）', () => {
    const facts = ERATW_GAME_ADAPTER;
    expect(ERATW_SURFACE_MAP.length).toBe(
      factSurfacePairs(facts, 'event').length +
        factSurfacePairs(facts, 'symbol').length +
        factSurfacePairs(facts, 'presentation').length +
        factSurfacePairs(facts, 'storage').length,
    );
    expect(ERATW_SURFACE_MAP.length).toBe(28);
  });

  it('每一面各几条（读数写死在这里：改动会被这两条点名，而不是只让总数漂）', () => {
    const count = (kind: 'event' | 'symbol' | 'presentation' | 'storage'): number =>
      ERATW_SURFACE_MAP.filter((row) => row.kind === kind).length;
    expect(count('event')).toBe(9);
    expect(count('symbol')).toBe(15);
    expect(count('storage')).toBe(3);
    expect(count('presentation')).toBe(1);
  });
});

describe('形态纪律（与 `ERATW_CARRIERS` 同尺）', () => {
  it('整张表与每一条、每一条的别名数组都深冻结', () => {
    expect(Object.isFrozen(ERATW_SURFACE_MAP)).toBe(true);
    for (const row of ERATW_SURFACE_MAP) {
      expect(Object.isFrozen(row), row.surface).toBe(true);
      if (row.aliases !== undefined) expect(Object.isFrozen(row.aliases), row.surface).toBe(true);
    }
  });

  it('纯数据：每条只有字符串与字符串数组，零函数、零 undefined 落点', () => {
    for (const row of ERATW_SURFACE_MAP) {
      expect(typeof row.kind).toBe('string');
      expect(row.surface.trim().length, JSON.stringify(row)).toBeGreaterThan(0);
      expect(row.native.trim().length, JSON.stringify(row)).toBeGreaterThan(0);
      for (const value of Object.values(row)) {
        expect(typeof value === 'function', JSON.stringify(row)).toBe(false);
      }
    }
  });

  it('本包没有把表挂进 `GameAdapter`（PS-10 预算顶格 ⇒ 走懒边，总装零改动）', () => {
    expect('surfaceMap' in ERATW_GAME_ADAPTER).toBe(false);
    expect(Object.keys(ERATW_GAME_ADAPTER)).toContain('eventCatalog');
  });
});

describe('双向投影真的查得动（作者面 ↔ 盘上写法各一枚）', () => {
  it('正向：事件名、属性 `族:编号`、演出提示都落得下去', () => {
    expect(nativeOfSurface(ERATW_SURFACE_MAP, 'event', '初见')).toBe('EVENTFIRST');
    expect(nativeOfSurface(ERATW_SURFACE_MAP, 'symbol', '好感度')).toBe('CFLAG:2');
    expect(nativeOfSurface(ERATW_SURFACE_MAP, 'presentation', '心形')).toBe('HPH_PRINT');
    expect(nativeOfSurface(ERATW_SURFACE_MAP, 'storage', 'save')).toBe('SAVEDATA');
  });

  it('正向：别名走同一个入口（`爱慕` → 恋慕的落点，不改事实）', () => {
    expect(nativeOfSurface(ERATW_SURFACE_MAP, 'symbol', '爱慕')).toBe('TALENT:3');
    expect(nativeOfSurface(ERATW_SURFACE_MAP, 'symbol', '愛欲')).toBe('TALENT:184');
    expect(surfacesOfNative(ERATW_SURFACE_MAP, 'symbol', 'TALENT:3')).toEqual(['恋慕']);
  });

  it('反向：盘上写法回作者名；`{我}` 与 `{她}` 同指 TARGET 是事实面建模过的重合', () => {
    expect(surfacesOfNative(ERATW_SURFACE_MAP, 'event', 'EVENTCOM')).toEqual(['指令']);
    expect(surfacesOfNative(ERATW_SURFACE_MAP, 'storage', 'TCVAR')).toEqual(['session']);
    expect(surfacesOfNative(ERATW_SURFACE_MAP, 'symbol', '%CALLNAME:TARGET%')).toEqual(['我', '她']);
  });

  it('查不到就是查不到（不猜、不借别门方言的表）', () => {
    expect(nativeOfSurface(ERATW_SURFACE_MAP, 'event', '没有这个事件')).toBeUndefined();
    expect(surfacesOfNative(ERATW_SURFACE_MAP, 'event', 'EVENTFIRST_UNUSED')).toEqual([]);
  });
});
