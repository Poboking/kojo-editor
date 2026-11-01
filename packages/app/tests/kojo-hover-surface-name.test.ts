/**
 * 表层↔原生表的**反查一格**（LAU-SURFACE-WIRE 批）判据。
 *
 * 这一格只回答一件事：盘上这个原生写法，作者面管它叫什么。四条口径各配正反例——
 * ① 不抢已有事实（调用方 `withSurfaceNameHint` 的早退，源形状另钉）；② 恒等落点不算信息；
 * ③ 表缺席 / 读表面缺席 / 查不到 ⇒ `null`，不猜；④ 落点由**表**认（带 `%` `:` 的整串），
 * 只加一条通用词边界，所以 `EVENTFIRSTX` 里的 `EVENTFIRST` 不算命中。
 *
 * 用真的 eraTW 表（包 exports 的懒叶）跑一遍：判据不喂假表，表与四事实面的对账归
 * `kojo-conformance` 的 `surface-map.test.ts`，这里只管**反查这一格**的取舍。唯一一处合成小表
 * 用来钉"同一格内多段盖住光标 ⇒ 取最长那段"这条纯结构规则（真表里没有能区分的两段）。
 */
import { describe, expect, it } from 'vitest';
import { ERATW_SURFACE_MAP } from '@kojo/plugin-eratw-adapter/kojo2-surface-map';
import { surfaceMappingsOf, surfacesOfNative } from '@kojo/kojo-core/surface-map';
import { surfaceNameHintOf, type SurfaceReadApi } from '../src/monaco/kojo-surface-name';

const api: SurfaceReadApi = { surfacesOfNative, surfaceMappingsOf };

describe('悬停 · 表层↔原生表反查（surfaceNameHintOf）', () => {
  it('事件常量 → 作者名：`EVENTFIRST` 交回「初见」，区间盖住整个记号', () => {
    const line = 'IF EVENTFIRST';
    const hint = surfaceNameHintOf(line, 5, ERATW_SURFACE_MAP, api);
    expect(hint).toEqual({ name: '初见', kind: '引擎事件', startColumn: 4, endColumn: 14 });
  });

  it('引用模板 → 作者名：`%CALLNAME:MASTER%` 交回「你」，区间含两端的 `%`', () => {
    const line = '\tPRINTFORMW %CALLNAME:MASTER%';
    const hint = surfaceNameHintOf(line, 14, ERATW_SURFACE_MAP, api);
    expect(hint).toEqual({ name: '你', kind: '原生记号', startColumn: 13, endColumn: 30 });
  });

  it('演出提示 → 作者名：`HPH_PRINT` 交回「心形」', () => {
    expect(surfaceNameHintOf('CALL HPH_PRINT', 7, ERATW_SURFACE_MAP, api)).toMatchObject({
      name: '心形',
      kind: '演出提示',
    });
  });

  it('多名一落点按**声明序**取首条：`%CALLNAME:TARGET%` 上先挂着「我」', () => {
    // 表里 `我`（第 64 行）在 `她`（第 66 行）之前；宿主不另立规则、不拼成一句
    expect(surfaceNameHintOf('IF %CALLNAME:TARGET%', 5, ERATW_SURFACE_MAP, api)?.name).toBe('我');
  });

  it('别名只是入口：反向回到**本名**，不回别名', () => {
    // 表里 `恋慕` 有别名 `爱慕`；反查 `TALENT:3` 只该交回本名
    expect(surfaceNameHintOf('IF TALENT:3', 5, ERATW_SURFACE_MAP, api)?.name).toBe('恋慕');
  });

  it('恒等落点不算信息：`TIME` → `TIME` 这种不接管（表里确有这几条）', () => {
    expect(surfaceNameHintOf('IF TIME', 4, ERATW_SURFACE_MAP, api)).toBeNull();
    // `RESULT` / `RESULTS` 都是恒等，且 `RESULT` 是 `RESULTS` 的前缀 ⇒ 两段都不算信息
    expect(surfaceNameHintOf('IF RESULT', 5, ERATW_SURFACE_MAP, api)).toBeNull();
    expect(surfaceNameHintOf('IF RESULTS', 5, ERATW_SURFACE_MAP, api)).toBeNull();
  });

  it('storage 那一格刻意不收：`LOCAL` 悬停不冒「scene」（否则与槽头 / #DIM 悬停抢答）', () => {
    expect(surfaceNameHintOf('LOCAL = 1', 2, ERATW_SURFACE_MAP, api)).toBeNull();
  });

  it('独立成词：`EVENTFIRSTX` 里的 `EVENTFIRST`、裸 `CALLNAME` 都不算命中', () => {
    expect(surfaceNameHintOf('IF EVENTFIRSTX', 5, ERATW_SURFACE_MAP, api)).toBeNull();
    expect(surfaceNameHintOf('IF CALLNAME', 5, ERATW_SURFACE_MAP, api)).toBeNull();
  });

  it('不猜：没表 / 没读表面 / 表里没有 / 光标不在落点上 ⇒ 一律 null', () => {
    expect(surfaceNameHintOf('IF EVENTFIRST', 5, null, api)).toBeNull();
    expect(surfaceNameHintOf('IF EVENTFIRST', 5, ERATW_SURFACE_MAP, null)).toBeNull();
    expect(surfaceNameHintOf('IF SOMETHING_ELSE', 5, ERATW_SURFACE_MAP, api)).toBeNull();
    expect(surfaceNameHintOf('   ', 2, ERATW_SURFACE_MAP, api)).toBeNull();
  });

  it('同一格内多段盖住光标 ⇒ 取**最长**那段（`X:12` 压过 `X:1`）', () => {
    const synthetic = [
      { kind: 'symbol', surface: '短', native: 'X:1' },
      { kind: 'symbol', surface: '长', native: 'X:12' },
    ];
    expect(surfaceNameHintOf('PRINT X:12', 8, synthetic, api)).toEqual({
      name: '长',
      kind: '原生记号',
      startColumn: 7,
      endColumn: 11,
    });
  });

  it('读表面抛错只丢那一格，不影响后面的 kind（表是第三方数据）', () => {
    const throwing: SurfaceReadApi = {
      surfacesOfNative,
      surfaceMappingsOf: (table, kind) => {
        if (kind === 'event') throw new Error('boom');
        return surfaceMappingsOf(table, kind);
      },
    };
    // event 那格抛了，symbol 那格照常答
    expect(surfaceNameHintOf('IF %CALLNAME:MASTER%', 5, ERATW_SURFACE_MAP, throwing)?.name).toBe('你');
  });
});
