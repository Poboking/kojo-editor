/**
 * 条件矩阵纯逻辑单测（matrix-logic，零 React）。
 *
 * 覆盖：角色聚合与未归属计数、面排序、跨面单元格聚合与计数、空白 vs 填色、
 * 标签回退、行序。
 *
 * 注意解耦铁律：这里用**测试专用**的合成索引与 mini 家族规则，不 import 任何真适配器。
 */

import { describe, expect, it } from 'vitest';
import type {
  ConditionComparison,
  ErbFile,
  ErbFunction,
  ErbIndex,
  FamilyIndexRule,
  FamilyMatch,
  FamilyParseKind,
  StateDependency,
} from '@kojo/plugin-api';
import { FACE_ORDER, buildCharacterIndex, buildMatrix, faceLabel } from '../src/matrix-logic';

/* ------------------------------ 测试基建 ------------------------------ */

function mk(kind: FamilyParseKind, face: string, no: number | null): FamilyMatch {
  return {
    kind,
    prefix: 'FAM',
    family: '',
    characterNo: no,
    selector: 0,
    face,
    sub: '',
    isMessageCheck: false,
    slot: '',
    isPlaceholder: kind === 'placeholder',
  };
}

/** mini 家族规则：`FAM_<FACE>_K<n>` 为常规口上、`FAM_K<n>` 为家族声明、`ORPHAN*` 为占位残留 */
const fakeFamilyIndex: FamilyIndexRule = {
  name: 'fake',
  match(fnName: string): FamilyMatch | null {
    let m = /^FAM_K(\d+)$/.exec(fnName);
    if (m) return mk('declare', 'declare', Number(m[1]!));
    m = /^FAM_(.+)_K(\d+)$/.exec(fnName);
    if (m) return mk('ok', m[1]!, Number(m[2]!));
    if (/^ORPHAN(_|$)/.test(fnName)) return mk('placeholder', 'MESSAGE_COM', null);
    return null;
  },
};

function makeIndex(files: Record<string, string[]>): ErbIndex {
  const map = new Map<string, ErbFile>();
  for (const [path, names] of Object.entries(files)) {
    const functions: ErbFunction[] = names.map((name, i) => ({
      name,
      normalizedName: name.toUpperCase(),
      params: [],
      startLine: i * 10 + 2,
      endLine: i * 10 + 9,
      filePath: path,
    }));
    map.set(path, { path, functions, dims: [], hasFunctionDirective: false, lineCount: names.length * 10 + 5 });
  }
  return { files: map, byName: new Map() };
}

function dep(key: string, name: string, indices: string[], comparisons: ConditionComparison[]): StateDependency {
  return { key, name, indices, count: comparisons.length, comparisons, firstLine: 1 };
}
function cmp(op: string, value: number | string): ConditionComparison {
  return { op, value, text: String(value) };
}

/* ------------------------------ buildCharacterIndex ------------------------------ */

describe('buildCharacterIndex', () => {
  it('按角色聚合、面去重排序、未归属只计数', () => {
    const index = makeIndex({
      '/p/a.ERB': ['FAM_MESSAGE_COM_K1', 'FAM_EVENT_K1', 'FAM_MESSAGE_COUNTER_K1', 'ORPHAN_X', 'RANDOM_UTIL'],
    });
    const ci = buildCharacterIndex(index, fakeFamilyIndex);
    expect(ci.hasFamilyIndex).toBe(true);
    expect(ci.totalFunctions).toBe(5);
    expect(ci.orphanCount).toBe(2);
    expect([...ci.entries.keys()]).toEqual([1]);

    const e = ci.entries.get(1)!;
    expect(e.no).toBe(1);
    expect(e.faces).toEqual(['EVENT', 'MESSAGE_COM', 'MESSAGE_COUNTER']);
    // 函数按扫描序保留，各带自己的归属面
    expect(e.functions.map((f) => f.face)).toEqual(['MESSAGE_COM', 'EVENT', 'MESSAGE_COUNTER']);
  });

  it('declare 形态单独成面且排最后', () => {
    const index = makeIndex({ '/p/a.ERB': ['FAM_K1', 'FAM_MESSAGE_COM_K1'] });
    const ci = buildCharacterIndex(index, fakeFamilyIndex);
    const e = ci.entries.get(1)!;
    expect(e.faces).toEqual(['MESSAGE_COM', 'declare']);
    expect(FACE_ORDER[FACE_ORDER.length - 1]).toBe('declare');
  });

  it('跨文件同角色归并（面去重）', () => {
    const index = makeIndex({
      '/p/a.ERB': ['FAM_EVENT_K1'],
      '/p/b.ERB': ['FAM_EVENT_K1', 'FAM_COM_K1'],
    });
    const ci = buildCharacterIndex(index, fakeFamilyIndex);
    const e = ci.entries.get(1)!;
    expect(e.faces).toEqual(['EVENT', 'COM']);
    expect(e.functions).toHaveLength(3);
  });

  it('未知面排在已知面之后、按字母序', () => {
    const index = makeIndex({ '/p/a.ERB': ['FAM_ZZZ_K1', 'FAM_AAA_K1', 'FAM_MESSAGE_COM_K1'] });
    const ci = buildCharacterIndex(index, fakeFamilyIndex);
    expect(ci.entries.get(1)!.faces).toEqual(['MESSAGE_COM', 'AAA', 'ZZZ']);
  });

  it('无家族规则：全部计为未归属、返回空索引', () => {
    const index = makeIndex({ '/p/a.ERB': ['FAM_MESSAGE_COM_K1', 'ORPHAN_X'] });
    const ci = buildCharacterIndex(index, null);
    expect(ci.hasFamilyIndex).toBe(false);
    expect(ci.entries.size).toBe(0);
    expect(ci.orphanCount).toBe(2);
    expect(ci.totalFunctions).toBe(2);
  });
});

/* ------------------------------ buildMatrix ------------------------------ */

describe('buildMatrix', () => {
  const index = makeIndex({
    '/p/a.ERB': ['FAM_MESSAGE_COM_K1', 'FAM_EVENT_K1', 'FAM_MESSAGE_COUNTER_K1'],
  });
  const entry = buildCharacterIndex(index, fakeFamilyIndex).entries.get(1)!;

  const depsByFn: Record<string, StateDependency[]> = {
    FAM_MESSAGE_COM_K1: [
      dep('CFLAG:318', 'CFLAG', ['318'], [cmp('>=', 500)]),
      dep('TALENT:恋慕', 'TALENT', ['恋慕'], [cmp('==', 1)]),
    ],
    FAM_EVENT_K1: [dep('CFLAG:318', 'CFLAG', ['318'], [cmp('!=', 0)])],
  };
  const depsOf = (n: string): StateDependency[] => depsByFn[n] ?? [];
  const labels: Record<string, string> = { 'CFLAG:318': '生气中' };
  const labelOf = (k: string): string | null => labels[k] ?? null;

  it('列 = 角色面清单（含标签）+ 分母口径', () => {
    const m = buildMatrix(entry, depsOf, labelOf);
    expect(m.charaNo).toBe(1);
    expect(m.columns.map((c) => c.face)).toEqual(['EVENT', 'MESSAGE_COM', 'MESSAGE_COUNTER']);
    expect(m.columns.map((c) => c.label)).toEqual(['EVENT', 'MESSAGE_COM', 'MESSAGE_COUNTER']);
    expect(m.totalFunctions).toBe(3);
    expect(m.depsFunctions).toBe(2); // MESSAGE_COM + EVENT 有依赖；MESSAGE_COUNTER 无
  });

  it('注入 faceLabels → 列标签中文化；未收录的面原样 token', () => {
    const m = buildMatrix(entry, depsOf, labelOf, { MESSAGE_COM: '指令口上', EVENT: '事件' });
    expect(m.columns.map((c) => c.label)).toEqual(['事件', '指令口上', 'MESSAGE_COUNTER']);
  });

  it('多面聚合：同一状态键跨面各自计数', () => {
    const m = buildMatrix(entry, depsOf, labelOf);
    const row = m.rows.find((r) => r.key === 'CFLAG:318')!;
    expect(row.name).toBe('CFLAG');
    expect(row.indices).toEqual(['318']);
    expect(row.totalCount).toBe(2);
    expect(row.cells['MESSAGE_COM']).toMatchObject({ present: true, count: 1 });
    expect(row.cells['EVENT']).toMatchObject({ present: true, count: 1 });
  });

  it('空白 vs 填色：未命中的面在 cells 记录中缺席', () => {
    const m = buildMatrix(entry, depsOf, labelOf);
    const row = m.rows.find((r) => r.key === 'CFLAG:318')!;
    expect(row.cells['MESSAGE_COUNTER']).toBeUndefined();
    const talent = m.rows.find((r) => r.key === 'TALENT:恋慕')!;
    expect(talent.cells['MESSAGE_COM']).toBeDefined();
    expect(talent.cells['EVENT']).toBeUndefined();
  });

  it('标签：有字典项给标签，否则 null', () => {
    const m = buildMatrix(entry, depsOf, labelOf);
    expect(m.rows.find((r) => r.key === 'CFLAG:318')!.label).toBe('生气中');
    expect(m.rows.find((r) => r.key === 'TALENT:恋慕')!.label).toBeNull();
  });

  it('比较集合：跨面合并去重、首见序；单元格比较与来源同序', () => {
    const m = buildMatrix(entry, depsOf, labelOf);
    const row = m.rows.find((r) => r.key === 'CFLAG:318')!;
    expect(row.comparisons).toEqual(['>= 500', '!= 0']);
    expect(row.cells['MESSAGE_COM']!.functions[0]!.comparisons).toEqual(['>= 500']);
    expect(row.cells['EVENT']!.functions[0]!.comparisons).toEqual(['!= 0']);
    // 单元格贡献条目携带函数定位
    expect(row.cells['EVENT']!.functions[0]!.filePath).toBe('/p/a.ERB');
    expect(row.cells['EVENT']!.functions[0]!.startLine).toBe(12);
  });

  it('行序：totalCount 降序', () => {
    const m = buildMatrix(entry, depsOf, labelOf);
    expect(m.rows.map((r) => r.key)).toEqual(['CFLAG:318', 'TALENT:恋慕']);
  });

  it('行序并列：同 totalCount 按 key 升序', () => {
    const idx2 = makeIndex({ '/p/a.ERB': ['FAM_COM_K1'] });
    const e2 = buildCharacterIndex(idx2, fakeFamilyIndex).entries.get(1)!;
    const d2 = (n: string): StateDependency[] =>
      n === 'FAM_COM_K1' ? [dep('BBB', 'BBB', ['1'], []), dep('AAA', 'AAA', ['2'], [])] : [];
    const m2 = buildMatrix(e2, d2, () => null);
    expect(m2.rows.map((r) => r.key)).toEqual(['AAA', 'BBB']);
  });

  it('空依赖：矩阵无行、depsFunctions 为 0', () => {
    const m = buildMatrix(entry, () => [], () => null);
    expect(m.rows).toHaveLength(0);
    expect(m.depsFunctions).toBe(0);
    expect(m.totalFunctions).toBe(3);
  });
});

/* ------------------------------ faceLabel ------------------------------ */

describe('faceLabel', () => {
  it("'' → 其它；'declare' → 家族声明；否则原样", () => {
    expect(faceLabel('')).toBe('其它');
    expect(faceLabel('declare')).toBe('家族声明');
    expect(faceLabel('MESSAGE_COM')).toBe('MESSAGE_COM');
  });

  it('注入 labels → 命中给中文，未收录/通用面仍走兜底', () => {
    const labels = { MESSAGE_COM: '指令口上', SUCCESS_COM: '指令成否' } as const;
    expect(faceLabel('MESSAGE_COM', labels)).toBe('指令口上');
    expect(faceLabel('SUCCESS_COM', labels)).toBe('指令成否');
    expect(faceLabel('MESSAGE', labels)).toBe('MESSAGE'); // 未收录 → 原样
    expect(faceLabel('', labels)).toBe('其它'); // 通用兜底不受 labels 影响
  });
});
