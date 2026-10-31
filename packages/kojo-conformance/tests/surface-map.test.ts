/**
 * **三列表层↔原生映射表**（LAU-D4 车② 的方言扩展一致性：同一份判据跑三门方言）。
 *
 * 与车① `tests/carriers.test.ts` 同一把尺：一份读表面（`@kojo/kojo-core/surface-map`）、
 * 三列方言（eraTW / eraFL / demo）、同一批断言——这就是"新增一门方言 = 新增一个包 +
 * 清单一行，宿主与内核零改动"在**名字映射轴**上的可执行版本。
 *
 * 1. **声明的两列各自过闸零诊断**：eraTW 28 条、demo 10 条，两列的落点各按自己盘上事实
 *    （`初见` 在 eraTW 落 `EVENTFIRST`、在 demo 落本列自己的 `DEMO_FIRST`——同一个函数、
 *    两份数据、两个答案，判定里没有一个方言分支）；
 * 2. **未声明的一列一概不判**：eraFL 今天不交这张表 ⇒ `declared = false` + 零诊断
 *    （与 `carriers` 的"没问就不判"同口径；旧适配器零改动）；
 * 3. **错配对每一列都同等地红**：把任一声明列的表改坏（落点写错 / 少一条 / 两条同名争用），
 *    该列必红且码与原因可点名——红不红由数据决定，不由方言是谁决定。
 */
import { describe, expect, it } from 'vitest';
import type { GameAdapter } from '@kojo/kojo-core';
import type { SurfaceMapping } from '@kojo/kojo-core/surface-map';
import { checkSurfaceMap, nativeOfSurface, readSurfaceMap } from '@kojo/kojo-core/surface-map';
import { ERATW_GAME_ADAPTER } from '@kojo/plugin-eratw-adapter';
import { ERATW_SURFACE_MAP } from '@kojo/plugin-eratw-adapter/kojo2-surface-map';
import { ERAFL_GAME_ADAPTER } from '@kojo/plugin-erafl-adapter/kojo2';
import { DEMO_GAME_ADAPTER, DEMO_SURFACE_MAP } from './fixtures/dialect-demo/index.js';

interface Column {
  readonly id: string;
  readonly facts: GameAdapter;
  readonly table: readonly SurfaceMapping[] | undefined;
}

/** 三列注册表（列从数据来；判定零方言分支） */
const COLUMNS: readonly Column[] = [
  { id: 'eratw', facts: ERATW_GAME_ADAPTER, table: ERATW_SURFACE_MAP },
  { id: 'erafl', facts: ERAFL_GAME_ADAPTER, table: undefined },
  { id: 'demo', facts: DEMO_GAME_ADAPTER, table: DEMO_SURFACE_MAP },
];

const DECLARED = COLUMNS.filter((column) => column.table !== undefined);

describe('① 声明的列各自过闸：表与事实面逐条对上', () => {
  it('每一列 `checkSurfaceMap` 零诊断，且表非空（判据不是空匹配）', () => {
    for (const column of DECLARED) {
      expect(checkSurfaceMap(column.facts, column.table), column.id).toEqual([]);
      expect(column.table!.length, column.id).toBeGreaterThan(0);
    }
    expect(ERATW_SURFACE_MAP.length).toBe(28);
    expect(DEMO_SURFACE_MAP.length).toBe(10);
  });

  it('两列的表都是深冻结（第三门方言带的也是只读数据）', () => {
    for (const table of [ERATW_SURFACE_MAP, DEMO_SURFACE_MAP]) {
      expect(Object.isFrozen(table)).toBe(true);
      expect(table.every((row) => Object.isFrozen(row))).toBe(true);
    }
  });
});

describe('② 同一张读表面、两份数据、两个答案', () => {
  it('同一个作者名 `初见`：eraTW 落引擎常量、demo 落本列自己的 token', () => {
    expect(nativeOfSurface(ERATW_SURFACE_MAP, 'event', '初见')).toBe('EVENTFIRST');
    expect(nativeOfSurface(DEMO_SURFACE_MAP, 'event', '初见')).toBe('DEMO_FIRST');
  });

  it('eraFL 没交表 ⇒ 读表面判它"未声明"，正向查交回 undefined（不猜、不借别门方言的落点）', () => {
    const erafl = COLUMNS.find((column) => column.id === 'erafl')!;
    expect(readSurfaceMap(erafl.table).declared).toBe(false);
    expect(nativeOfSurface(erafl.table, 'event', '初见')).toBeUndefined();
    expect(checkSurfaceMap(erafl.facts, erafl.table)).toEqual([]);
  });
});

describe('③ 错配必红：同一套判据对每一列同等生效', () => {
  it('把落点写错 ⇒ 该列必红 dangling，并点名两侧', () => {
    for (const column of DECLARED) {
      const first = column.table![0]!;
      const broken = column.table!.map((row) => (row === first ? { ...row, native: `${row.native}_错一枚` } : row));
      const hits = checkSurfaceMap(column.facts, broken).filter((d) => d.code === 'core/surface/dangling');
      expect(hits, column.id).toHaveLength(1);
      expect(hits[0]!.message, column.id).toContain(first.surface);
      expect(hits[0]!.message, column.id).toContain(`${first.native}_错一枚`);
      expect(hits[0]!.severity, column.id).toBe('error');
    }
  });

  it('少写一条 ⇒ 该列必红 unmapped（表"少写"与"写错"同样是错配）', () => {
    for (const column of DECLARED) {
      const missing = column.table!.slice(1);
      const hits = checkSurfaceMap(column.facts, missing).filter((d) => d.code === 'core/surface/unmapped');
      expect(hits, column.id).toHaveLength(1);
      expect(hits[0]!.message, column.id).toContain(column.table![0]!.surface);
    }
  });

  it('两条作者名抢同一落点 ⇒ 该列必红 contested（代词的合法重合不被误伤）', () => {
    for (const column of DECLARED) {
      const first = column.table![0]!;
      const cloner: SurfaceMapping = { ...first, surface: `${first.surface}分身` };
      const hits = checkSurfaceMap(column.facts, [...column.table!, cloner]).filter(
        (d) => d.code === 'core/surface/contested',
      );
      expect(hits, column.id).toHaveLength(1);
      expect(hits[0]!.message, column.id).toContain(first.native);
      expect(hits[0]!.message, column.id).toContain(cloner.surface);
    }
  });
});
