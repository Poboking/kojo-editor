/**
 * 表层↔原生双向映射表的**读表面 + 错配必红**（LAU-D4 车②）。
 *
 * 判据面（三组，全在纯函数上，零 IO）：
 * 1. **读表**：未声明 / 空表 / 坏条目三态分开，坏数据不抛（宿主装载从不跑 `validateGameAdapter`）；
 * 2. **双向投影**：正向（含别名、声明序优先）与反向读的是**同一批行**——这里用"两向对拍"
 *    钉住"表不许有两份"；
 * 3. **错配必红**：`dangling` / `contested` / `unmapped` 三族各给正反例，且每条诊断都是
 *    error + 带原因的人话（铁律 4）。代词那一子面的合法重合单独钉（不许把它当争用刷红，
 *    也不许把别的子面跟着放行）。
 */
import { describe, expect, it } from 'vitest';
import type { GameAdapter } from '../src/adapter.js';
import { FIXTURE_ADAPTER } from '../src/fixture-adapter.js';
import {
  checkSurfaceMap,
  factSurfacePairs,
  nativeOfSurface,
  readSurfaceMap,
  surfaceMappingsOf,
  surfacesOfNative,
  type SurfaceMapping,
} from '../src/surface-map.js';

/** 与事实面逐条对齐的一张合格表（就从 fixture 自己投出来，判据不吃方言包数据） */
function tableOf(facts: GameAdapter, kind: 'event' | 'symbol' | 'presentation' | 'storage'): SurfaceMapping[] {
  return factSurfacePairs(facts, kind).map((pair) => Object.freeze({ kind, surface: pair.surface, native: pair.native }));
}

/** 全四面的完整表（fixture 的 presentation 是空的 ⇒ 零条） */
function fullTable(facts: GameAdapter): SurfaceMapping[] {
  return [...tableOf(facts, 'event'), ...tableOf(facts, 'symbol'), ...tableOf(facts, 'presentation'), ...tableOf(facts, 'storage')];
}

describe('① 读表：三态分开、坏数据不抛', () => {
  it('未声明（undefined）与空表是两件事', () => {
    expect(readSurfaceMap(undefined)).toEqual({ declared: false, usable: [], skipped: 0 });
    const reading = readSurfaceMap([]);
    expect(reading.declared).toBe(true);
    expect(reading.usable).toEqual([]);
    expect(reading.skipped).toBe(0);
  });

  it('整张表不是数组 ⇒ 声明了但零条可用 + 一条坏（不抛）', () => {
    expect(readSurfaceMap('初见' as unknown)).toEqual({ declared: true, usable: [], skipped: 1 });
    expect(readSurfaceMap(null)).toEqual({ declared: true, usable: [], skipped: 1 });
  });

  it('坏条目逐条跳过并计数，好条目保持声明序', () => {
    const reading = readSurfaceMap([
      { kind: 'event', surface: '开场', native: 'OPEN' },
      null,
      '初见',
      { kind: 'nope', surface: '外部计数', native: '外部计数' },
      { kind: 'event', surface: '  ', native: 'CLOSE' },
      { kind: 'event', surface: '收场', native: '' },
      { kind: 'symbol', surface: '名字', native: 'NAME_OF', aliases: ['名字', 1 as unknown] },
    ]);
    expect(reading.usable.map((row) => row.surface)).toEqual(['开场']);
    expect(reading.skipped).toBe(6);
  });

  it('未声明的表参与对账时一概不判（没问就不判，与 carriers 同口径）', () => {
    expect(checkSurfaceMap(FIXTURE_ADAPTER, undefined)).toEqual([]);
  });
});

describe('② 事实面投影与双向投影同一批行', () => {
  it('fixture 四面读数：事件两条 / 符号八条 / 演出零条 / 存储一条', () => {
    expect(factSurfacePairs(FIXTURE_ADAPTER, 'event')).toEqual([
      { surface: '开场', native: 'OPEN', group: 'event' },
      { surface: '收场', native: 'CLOSE', group: 'event' },
    ]);
    expect(factSurfacePairs(FIXTURE_ADAPTER, 'symbol').map((pair) => `${pair.group}:${pair.surface}→${pair.native}`)).toEqual([
      'pronoun:我→VIEW',
      'pronoun:你→PLAYER',
      'attribute:数值→VAR:0',
      'nameFunction:名字→NAME_OF',
      'variable:外部计数→外部计数',
      'variable:外部文本→外部文本',
      'variable:外部上限→外部上限',
      'variable:外部角色→外部角色',
    ]);
    expect(factSurfacePairs(FIXTURE_ADAPTER, 'presentation')).toEqual([]);
    expect(factSurfacePairs(FIXTURE_ADAPTER, 'storage')).toEqual([
      { surface: 'scene', native: 'LOCAL', group: 'storage' },
    ]);
  });

  it('完整表过闸零诊断（判据先自证不空转）', () => {
    expect(checkSurfaceMap(FIXTURE_ADAPTER, fullTable(FIXTURE_ADAPTER))).toEqual([]);
  });

  it('正向按名字与别名都查得到；查不到交回 undefined（不猜、不借别门方言）', () => {
    const table: SurfaceMapping[] = [
      { kind: 'symbol', surface: '恋慕', native: 'VAR:3', aliases: ['爱慕'] },
      { kind: 'event', surface: '开场', native: 'OPEN' },
    ];
    expect(nativeOfSurface(table, 'symbol', '恋慕')).toBe('VAR:3');
    expect(nativeOfSurface(table, 'symbol', '爱慕')).toBe('VAR:3');
    expect(nativeOfSurface(table, 'symbol', '  爱慕  ')).toBe('VAR:3');
    expect(nativeOfSurface(table, 'event', '恋慕')).toBeUndefined();
    expect(nativeOfSurface(table, 'symbol', '没有这个名字')).toBeUndefined();
    expect(nativeOfSurface(table, 'symbol', '')).toBeUndefined();
    expect(nativeOfSurface(undefined, 'symbol', '恋慕')).toBeUndefined();
  });

  it('反向交出指着同一落点的那些名字；两向对拍同一批行', () => {
    const table = fullTable(FIXTURE_ADAPTER);
    expect(surfacesOfNative(table, 'event', 'OPEN')).toEqual(['开场']);
    expect(surfacesOfNative(table, 'symbol', '外部文本')).toEqual(['外部文本']);
    expect(surfacesOfNative(table, 'event', '不存在')).toEqual([]);
    for (const row of table) {
      expect(nativeOfSurface(table, row.kind, row.surface), row.surface).toBe(row.native);
      expect(surfacesOfNative(table, row.kind, row.native), row.native).toContain(row.surface);
    }
  });

  it('某一面的投影按声明序给全量（补全/清单类消费只读这一格）', () => {
    const table = fullTable(FIXTURE_ADAPTER);
    expect(surfaceMappingsOf(table, 'storage').map((row) => row.surface)).toEqual(['scene']);
    expect(surfaceMappingsOf(table, 'presentation')).toEqual([]);
    expect(surfaceMappingsOf('nope' as unknown, 'event')).toEqual([]);
  });
});

describe('③ 错配必红：三族各给正反例', () => {
  const codes = (facts: GameAdapter, table: unknown): string[] =>
    checkSurfaceMap(facts, table).map((diagnostic) => diagnostic.code);

  it('表层名指向不存在的原生写法 ⇒ dangling', () => {
    const table = [...fullTable(FIXTURE_ADAPTER), { kind: 'event' as const, surface: '没这个事件', native: 'NOPE' }];
    const hits = checkSurfaceMap(FIXTURE_ADAPTER, table).filter((d) => d.code === 'core/surface/dangling');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain('没这个事件');
    expect(hits[0]!.message).toContain('NOPE');
  });

  it('名字有、落点与事实面不同 ⇒ dangling 并点名两侧', () => {
    const table = fullTable(FIXTURE_ADAPTER).map((row) => (row.surface === '开场' ? { ...row, native: 'OTHER' } : row));
    const hits = checkSurfaceMap(FIXTURE_ADAPTER, table).filter((d) => d.code === 'core/surface/dangling');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain('OTHER');
    expect(hits[0]!.message).toContain('OPEN');
  });

  it('同一落点被两条表层名争用 ⇒ contested（事件面没有"合法重合"可躲）', () => {
    const table: SurfaceMapping[] = [
      { kind: 'event', surface: '开场', native: 'OPEN' },
      { kind: 'event', surface: '收场', native: 'OPEN' },
      ...tableOf(FIXTURE_ADAPTER, 'symbol'),
      ...tableOf(FIXTURE_ADAPTER, 'storage'),
    ];
    const hits = checkSurfaceMap(FIXTURE_ADAPTER, table).filter((d) => d.code === 'core/surface/contested');
    expect(hits.map((d) => d.message).join('\n')).toContain('开场');
    expect(hits.map((d) => d.message).join('\n')).toContain('收场');
  });

  it('一个作者名两个落点 ⇒ contested 且点名"取首条"就是静默裁决', () => {
    const table: SurfaceMapping[] = [
      { kind: 'event', surface: '开场', native: 'OPEN' },
      { kind: 'event', surface: '开场', native: 'CLOSE' },
    ];
    const hits = checkSurfaceMap(FIXTURE_ADAPTER, table).filter((d) => d.code === 'core/surface/contested');
    expect(hits.some((d) => d.message.includes('同时指向'))).toBe(true);
    expect(nativeOfSurface(table, 'event', '开场'), '正向只取声明序第一条').toBe('OPEN');
  });

  it('同一条名字写两遍 ⇒ contested（反向投影不许出重影）', () => {
    const row: SurfaceMapping = { kind: 'storage', surface: 'scene', native: 'LOCAL' };
    const hits = checkSurfaceMap(FIXTURE_ADAPTER, [row, row]).filter((d) => d.code === 'core/surface/contested');
    expect(hits.some((d) => d.message.includes('写了两遍'))).toBe(true);
  });

  it('别名压到别条的名字 ⇒ contested（入口只能有一个主人）', () => {
    const table: SurfaceMapping[] = [
      { kind: 'symbol', surface: '我', native: 'VIEW' },
      { kind: 'symbol', surface: '你', native: 'PLAYER', aliases: ['我'] },
    ];
    const hits = checkSurfaceMap(FIXTURE_ADAPTER, table).filter((d) => d.code === 'core/surface/contested');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain('我');
  });

  it('事实面有名字、表里缺 ⇒ unmapped；空表 ⇒ 每一条都 unmapped', () => {
    const partial = fullTable(FIXTURE_ADAPTER).filter((row) => row.surface !== '收场');
    expect(codes(FIXTURE_ADAPTER, partial)).toEqual(['core/surface/unmapped']);
    expect(checkSurfaceMap(FIXTURE_ADAPTER, []).map((d) => d.code)).toEqual([
      ...Array.from({ length: fullTable(FIXTURE_ADAPTER).length }, () => 'core/surface/unmapped'),
    ]);
  });

  it('代词那一子面的合法重合不刷红（事实面自己就有两条同落点）', () => {
    const pronounFacts: GameAdapter = {
      ...FIXTURE_ADAPTER,
      domainSymbols: {
        ...FIXTURE_ADAPTER.domainSymbols,
        pronouns: [
          { role: 'me', pronoun: '我', engineRef: '%NAME:TARGET%', requiresView: true, viewBound: true, family: 'NAME' },
          { role: 'her', pronoun: '她', engineRef: '%NAME:TARGET%', requiresView: true, viewBound: false, family: 'NAME' },
        ],
      },
    };
    const table = [...tableOf(pronounFacts, 'symbol'), ...tableOf(pronounFacts, 'event'), ...tableOf(pronounFacts, 'storage')];
    expect(checkSurfaceMap(pronounFacts, table)).toEqual([]);
    expect(surfacesOfNative(table, 'symbol', '%NAME:TARGET%')).toEqual(['我', '她']);
    expect(nativeOfSurface(table, 'symbol', '她')).toBe('%NAME:TARGET%');
  });

  it('坏条目也进诊断（同一枚 dangling 承载"表自己不合格"，与 core/carrier/unowned 同先例）', () => {
    const hits = checkSurfaceMap(FIXTURE_ADAPTER, [
      { kind: 'event', surface: '开场', native: 'OPEN' },
      { kind: 'event', surface: '', native: 'CLOSE' },
    ]).filter((d) => d.code === 'core/surface/dangling');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain('形状坏了');
  });

  it('报出来的每一枚都是 error（错配不许降级）', () => {
    for (const diagnostic of checkSurfaceMap(FIXTURE_ADAPTER, [{ kind: 'event', surface: '没有', native: 'X' }])) {
      expect(diagnostic.severity).toBe('error');
      expect(diagnostic.span).toBeNull();
    }
  });
});

describe('④ 契约零改动自证（additive）', () => {
  it('fixture 事实面没有被本批改写：四面读数仍来自原字段', () => {
    const facts = FIXTURE_ADAPTER;
    expect(facts.eventCatalog.events.map((e) => e.engine)).toEqual(['OPEN', 'CLOSE']);
    expect(facts.storageClasses.classes.map((c) => c.engine)).toEqual(['LOCAL']);
    expect(facts.domainSymbols.nameFunctions.map((f) => f.engine)).toEqual(['NAME_OF']);
    expect(facts.presentation.heart).toBeNull();
  });

  it('表里没有一条来自事实面之外的落点（正向读到的每个 native 都在反查名单里）', () => {
    const table = fullTable(FIXTURE_ADAPTER);
    for (const kind of ['event', 'symbol', 'storage'] as const) {
      for (const pair of factSurfacePairs(FIXTURE_ADAPTER, kind)) {
        expect(surfacesOfNative(table, kind, pair.native), pair.native).toContain(pair.surface);
      }
    }
  });
});
