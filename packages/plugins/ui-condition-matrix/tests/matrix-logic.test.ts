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
import {
  DETAIL_MIN_H,
  rowHasVisibleGap,
  FACE_ORDER,
  GRID_MIN_RESERVE,
  MATRIX_OVERSCAN,
  MATRIX_ROW_H,
  ROWHEAD_MAX_W,
  ROWHEAD_MIN_W,
  autoFoldFaces,
  buildCharacterIndex,
  buildCharaOptions,
  buildMatrix,
  cellKeysOfFunction,
  clampDetailHeight,
  clampRowheadWidth,
  computeViewportWindow,
  createMatrixMemo,
  faceLabel,
  functionRangeAt,
  instructionNoOfSlot,
  planMatrixWindow,
  sameMatrixWindow,
} from '../src/matrix-logic';
import type {
  CharacterEntry,
  ColumnDesc,
  ConditionMatrix,
  FaceFunction,
  MatrixCell,
  MatrixRow,
} from '../src/matrix-logic';

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

  it('空作用域包 + 全角色 universe：行列照常、填色为零（新建空包可直接填格）', () => {
    const empty: CharacterEntry = { no: 1, faces: [], functions: [] };
    const m = buildMatrix(empty, depsOf, labelOf, undefined, undefined, {
      columnsFrom: entry,
      rowsFrom: entry,
    });

    expect(m.columns.map((c) => c.face)).toEqual(['EVENT', 'MESSAGE_COM', 'MESSAGE_COUNTER']);
    expect(m.rows.map((r) => r.key).sort()).toEqual(['CFLAG:318', 'TALENT:恋慕']);
    expect(m.totalFunctions).toBe(0);
    expect(m.filledCells).toBe(0);
    expect(m.gapCells).toBe(m.rows.length * m.columns.length);
    expect(m.columns.every((c) => c.functions.length === 0)).toBe(true);
  });

  it('作用域函数带来 universe 没有的列：列保留、缺口按真实列数算', () => {
    const scopedIndex = makeIndex({ '/p/ws.ERB': ['FAM_COLOR_K1'] });
    const scopedEntry = buildCharacterIndex(scopedIndex, fakeFamilyIndex).entries.get(1)!;
    const scopedDeps = (n: string): StateDependency[] =>
      n === 'FAM_COLOR_K1' ? [dep('CFLAG:318', 'CFLAG', ['318'], [cmp('>=', 1)])] : depsOf(n);
    const m = buildMatrix(scopedEntry, scopedDeps, labelOf, undefined, undefined, {
      columnsFrom: entry,
      rowsFrom: entry,
    });

    expect(m.columns.map((c) => c.face)).toEqual(['EVENT', 'MESSAGE_COM', 'MESSAGE_COUNTER', 'COLOR']);
    const row = m.rows.find((r) => r.key === 'CFLAG:318')!;
    expect(row.cells['COLOR']).toMatchObject({ present: true, count: 1 });
    expect(row.gapCount).toBe(3); // 4 列里只有 COLOR 由作用域包填了
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

/* ------------------------------ 指令细分列（columnOf） ------------------------------ */

describe('instructionNoOfSlot', () => {
  it('取 slot 首位数字；无前导数字 → null', () => {
    expect(instructionNoOfSlot('88_1')).toBe(88);
    expect(instructionNoOfSlot('310')).toBe(310);
    expect(instructionNoOfSlot('X')).toBeNull();
    expect(instructionNoOfSlot('')).toBeNull();
  });
});

describe('buildMatrix · columnOf 细分指令列', () => {
  const withSlot = (face: string, slot: string): FamilyMatch => ({ ...mk('ok', face, 1), slot });
  const fn = (name: string, face: string, slot: string, startLine: number): FaceFunction => ({
    name,
    normalizedName: name,
    filePath: '/p/a.ERB',
    startLine,
    face,
    match: withSlot(face, slot),
  });

  const entry: CharacterEntry = {
    no: 1,
    faces: ['EVENT', 'SUCCESS_COM', 'MESSAGE_COM'],
    functions: [
      fn('F_MSG_88_1', 'MESSAGE_COM', '88_1', 2),
      fn('F_MSG_88_2', 'MESSAGE_COM', '88_2', 12), // 同编号 → 合并进同一列
      fn('F_MSG_310', 'MESSAGE_COM', '310', 22),
      fn('F_MSG_X', 'MESSAGE_COM', 'X', 32), // 非数字 slot → 回退整面列
      fn('F_SUCCESS_12', 'SUCCESS_COM', '12', 42),
      fn('F_EVENT', 'EVENT', '', 52),
    ],
  };
  const depsByFn: Record<string, StateDependency[]> = {
    F_MSG_88_1: [dep('CFLAG:318', 'CFLAG', ['318'], [cmp('>=', 500)])],
    F_MSG_310: [dep('CFLAG:318', 'CFLAG', ['318'], [cmp('==', 1)])],
  };
  const depsOf = (n: string): StateDependency[] => depsByFn[n] ?? [];
  const instructionFaces = new Set(['MESSAGE_COM', 'SUCCESS_COM']);
  const columnOf = (f: FaceFunction): ColumnDesc => {
    if (!instructionFaces.has(f.face)) return { key: f.face, instructionNo: null };
    const no = instructionNoOfSlot(f.match.slot);
    if (no === null) return { key: f.face, instructionNo: null };
    return { key: `${f.face}#${no}`, instructionNo: no, label: `名${no}` };
  };

  it('列细分：每指令一列、非指令整面成列、面序沿用 FACE_ORDER、组内指令号升序', () => {
    const m = buildMatrix(entry, depsOf, () => null, undefined, columnOf);
    expect(m.columns.map((c) => c.key)).toEqual([
      'EVENT', // 非指令面：整面一列
      'SUCCESS_COM#12',
      'MESSAGE_COM#88',
      'MESSAGE_COM#310',
      'MESSAGE_COM', // 非数字 slot 回退整面列（无编号 → 排最后）
    ]);
    expect(m.columns.map((c) => c.label)).toEqual(['EVENT', '名12', '名88', '名310', 'MESSAGE_COM']);
    expect(m.columns.map((c) => c.instructionNo)).toEqual([null, 12, 88, 310, null]);
  });

  it('groups 按面聚合、组内子列有序、扁平 columns = groups 展平序', () => {
    const m = buildMatrix(entry, depsOf, () => null, undefined, columnOf);
    expect(m.groups.map((g) => g.face)).toEqual(['EVENT', 'SUCCESS_COM', 'MESSAGE_COM']);
    expect(m.groups.find((g) => g.face === 'MESSAGE_COM')!.columns.map((c) => c.key)).toEqual([
      'MESSAGE_COM#88',
      'MESSAGE_COM#310',
      'MESSAGE_COM',
    ]);
    expect(m.groups.find((g) => g.face === 'SUCCESS_COM')!.columns.map((c) => c.key)).toEqual(['SUCCESS_COM#12']);
    expect(m.columns.map((c) => c.key)).toEqual(m.groups.flatMap((g) => g.columns.map((c) => c.key)));
  });

  it('单元格按列键聚合：MESSAGE_COM#88 / #310 各自命中', () => {
    const m = buildMatrix(entry, depsOf, () => null, undefined, columnOf);
    const row = m.rows.find((r) => r.key === 'CFLAG:318')!;
    expect(row.cells['MESSAGE_COM#88']).toMatchObject({ present: true, count: 1 });
    expect(row.cells['MESSAGE_COM#310']).toMatchObject({ present: true, count: 1 });
    expect(row.cells['MESSAGE_COM']).toBeUndefined(); // 非数字 slot 无依赖 → 无响应
    expect(row.cells['EVENT']).toBeUndefined();
    expect(row.totalCount).toBe(2);
    expect(m.depsFunctions).toBe(2);
  });

  it('columnOf 每个函数只解析一次（第一轮缓存列键、第二轮取用，不重复解析）', () => {
    let calls = 0;
    const counting = (f: FaceFunction): ColumnDesc => {
      calls++;
      return columnOf(f);
    };
    buildMatrix(entry, depsOf, () => null, undefined, counting);
    expect(calls).toBe(entry.functions.length);
  });
});

/* ------------------------------ createMatrixMemo ------------------------------ */

describe('createMatrixMemo', () => {
  const blank = (): ConditionMatrix => ({
    charaNo: 1,
    columns: [],
    groups: [],
    rows: [],
    totalFunctions: 0,
    depsFunctions: 0,
    filledCells: 0,
    totalCells: 0,
    gapCells: 0,
  });

  it('同 key 命中缓存：build 只跑一次，返回同一实例', () => {
    const memo = createMatrixMemo();
    let calls = 0;
    const build = (): ConditionMatrix => {
      calls++;
      return blank();
    };
    const a = memo.resolve('K1|0|ad', build);
    const b = memo.resolve('K1|0|ad', build);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it('换 key（依赖版本变化）→ 重建；clear 后再用也重建', () => {
    const memo = createMatrixMemo();
    let calls = 0;
    const build = (): ConditionMatrix => {
      calls++;
      return blank();
    };
    memo.resolve('K1|0|ad', build);
    expect(calls).toBe(1);
    const second = memo.resolve('K1|1|ad', build); // epoch 变 → 新 key
    expect(calls).toBe(2);
    memo.resolve('K1|1|ad', build); // 再命中
    expect(calls).toBe(2);
    expect(memo.resolve('K1|1|ad', build)).toBe(second);
    memo.clear();
    memo.resolve('K1|1|ad', build);
    expect(calls).toBe(3);
  });

  it('容量上限：超限淘汰最旧条目（重访最旧 key 会重建）', () => {
    const memo = createMatrixMemo(2);
    let calls = 0;
    const build = (): ConditionMatrix => {
      calls++;
      return blank();
    };
    memo.resolve('A', build);
    memo.resolve('B', build);
    memo.resolve('C', build); // 淘汰 A
    expect(calls).toBe(3);
    memo.resolve('B', build); // B、C 仍在
    memo.resolve('C', build);
    expect(calls).toBe(3);
    memo.resolve('A', build); // A 已被淘汰 → 重建
    expect(calls).toBe(4);
  });
});

/* ------------------------------ clampDetailHeight（分隔线钳制） ------------------------------ */

describe('clampDetailHeight', () => {
  it('面板高度未知（≤0 / NaN）→ 钳到下限', () => {
    expect(clampDetailHeight(300, 0)).toBe(DETAIL_MIN_H);
    expect(clampDetailHeight(300, -10)).toBe(DETAIL_MIN_H);
    expect(clampDetailHeight(300, Number.NaN)).toBe(DETAIL_MIN_H);
    expect(clampDetailHeight(0, 0)).toBe(DETAIL_MIN_H);
  });

  it('常规面板：落在 [下限, 面板高 - 网格保留] 内', () => {
    const panel = 680; // 悬浮大窗
    const max = panel - GRID_MIN_RESERVE;
    expect(clampDetailHeight(300, panel)).toBe(300);
    expect(clampDetailHeight(10, panel)).toBe(DETAIL_MIN_H); // 拖太小 → 兜底
    expect(clampDetailHeight(9999, panel)).toBe(max); // 拖太大 → 上限
  });

  it('面板过矮（上限被下限兜住）→ 两区都不被拖没，一律回落下限', () => {
    const panel = 120; // < DETAIL_MIN_H + GRID_MIN_RESERVE
    expect(clampDetailHeight(200, panel)).toBe(DETAIL_MIN_H);
    expect(clampDetailHeight(0, panel)).toBe(DETAIL_MIN_H);
  });
});

/* ------------------------------ clampRowheadWidth（首列列宽钳制） ------------------------------ */

describe('clampRowheadWidth', () => {
  it('非有限值（度量失败）→ 一律回落下限', () => {
    expect(clampRowheadWidth(Number.NaN)).toBe(ROWHEAD_MIN_W);
    expect(clampRowheadWidth(Number.POSITIVE_INFINITY)).toBe(ROWHEAD_MIN_W);
    expect(clampRowheadWidth(Number.NEGATIVE_INFINITY)).toBe(ROWHEAD_MIN_W);
  });

  it('落在 [下限, 上限] 内取整；越界钳到边界', () => {
    expect(clampRowheadWidth(200)).toBe(200);
    expect(clampRowheadWidth(200.6)).toBe(201);
    expect(clampRowheadWidth(10)).toBe(ROWHEAD_MIN_W); // 拖太小 → 兜底
    expect(clampRowheadWidth(9999)).toBe(ROWHEAD_MAX_W); // 拖太大 → 上限
  });
});

/* ------------------------------ computeViewportWindow（视口窗口数学） ------------------------------ */

describe('computeViewportWindow', () => {
  const RH = 20; // 便于手算：行高 20、可视 100 = 5 行

  it('滚到顶：start 归零、topPad 0、视口恰好罩住头部若干行', () => {
    const w = computeViewportWindow(0, 100, RH, 1000, 2);
    expect(w.start).toBe(0); // overscan 不把 start 拉到负数
    expect(w.end).toBe(7); // 5 可视 + 2 overscan
    expect(w.topPad).toBe(0);
    expect(w.bottomPad).toBe((1000 - 7) * RH); // 19860
  });

  it('滚动中途：窗口随 scrollTop 平移、上下占位高之和 = 未渲染行 × 行高', () => {
    const w = computeViewportWindow(200, 100, RH, 1000, 2);
    expect(w.start).toBe(8); // floor(200/20)=10 → -2
    expect(w.end).toBe(17); // 10 + 5 + 2
    expect(w.topPad).toBe(8 * RH);
    expect(w.bottomPad).toBe((1000 - 17) * RH);
    // 占位 + 渲染行 = 全量高度
    expect(w.topPad + (w.end - w.start) * RH + w.bottomPad).toBe(1000 * RH);
  });

  it('滚到底：end 钳到总行数、bottomPad 0（不渲染出界）', () => {
    const scroll = (1000 - 5) * RH; // 恰好让最后 5 行进视口
    const w = computeViewportWindow(scroll, 100, RH, 1000, 2);
    expect(w.end).toBe(1000);
    expect(w.bottomPad).toBe(0);
    expect(w.start).toBe(993);
    expect(w.start + (w.end - w.start)).toBe(w.end);
  });

  it('滚过头（scrollTop 远大于内容高）：两端都钳在 totalRows，不越界也不炸', () => {
    const w = computeViewportWindow(9_999_999, 100, RH, 1000, 2);
    expect(w.start).toBe(1000);
    expect(w.end).toBe(1000);
    expect(w.topPad).toBe(1000 * RH);
    expect(w.bottomPad).toBe(0);
  });

  it('totalRows = 0：空窗口、全 0（不炸）', () => {
    expect(computeViewportWindow(0, 100, RH, 0, 2)).toEqual({ start: 0, end: 0, topPad: 0, bottomPad: 0 });
  });

  it('行高非法（≤0 / NaN）→ 空窗口（防除零）', () => {
    expect(computeViewportWindow(0, 100, 0, 100, 2)).toEqual({ start: 0, end: 0, topPad: 0, bottomPad: 0 });
    expect(computeViewportWindow(0, 100, Number.NaN, 100, 2)).toEqual({
      start: 0,
      end: 0,
      topPad: 0,
      bottomPad: 0,
    });
  });

  it('overscan 大于总数：不重复、end 钳到总数、占位清空', () => {
    const w = computeViewportWindow(0, 100, RH, 3, 10);
    expect(w.start).toBe(0);
    expect(w.end).toBe(3);
    expect(w.topPad).toBe(0);
    expect(w.bottomPad).toBe(0);
    // 中途同样：start 被拉回 0，end 钳到 3
    const w2 = computeViewportWindow(40, 100, RH, 3, 10);
    expect(w2.start).toBe(0);
    expect(w2.end).toBe(3);
  });

  it('scrollTop 为负 → 视作 0（start 不越界）', () => {
    const w = computeViewportWindow(-50, 100, RH, 100, 2);
    expect(w.start).toBe(0);
    expect(w.topPad).toBe(0);
  });

  it('可视高未知（0）→ 仍有 overscan 行可聚焦（窗口非空）', () => {
    const w = computeViewportWindow(200, 0, RH, 1000, 8);
    // floor(200/20)=10、可视 0 → [2, 18]
    expect(w.start).toBe(2);
    expect(w.end).toBe(18);
  });

  it('不变式：任意输入下 0 ≤ start ≤ end ≤ totalRows、占位非负、总高守恒', () => {
    const scrolls = [-10, 0, 137, 199, 4400, 99000];
    const views = [0, 1, 100, 517];
    const totals = [0, 1, 7, 1000];
    const overs = [0, 1, 2, 8, 500];
    for (const s of scrolls)
      for (const v of views)
        for (const t of totals)
          for (const o of overs) {
            const w = computeViewportWindow(s, v, RH, t, o);
            expect(w.start).toBeGreaterThanOrEqual(0);
            expect(w.end).toBeGreaterThanOrEqual(w.start);
            expect(w.end).toBeLessThanOrEqual(t);
            expect(w.topPad).toBeGreaterThanOrEqual(0);
            expect(w.bottomPad).toBeGreaterThanOrEqual(0);
            expect(w.topPad + (w.end - w.start) * RH + w.bottomPad).toBe(t * RH);
          }
  });

  it('常量自洽：overscan 落在 6~10 行内（缓冲够兜住表头位移），行高为正', () => {
    expect(MATRIX_OVERSCAN).toBeGreaterThanOrEqual(6);
    expect(MATRIX_OVERSCAN).toBeLessThanOrEqual(10);
    expect(MATRIX_ROW_H).toBeGreaterThan(0);
  });
});

/* ------------------------------ 反向光标联动（C1） ------------------------------ */

describe('functionRangeAt — 光标行 → 函数祖先（区间包含，最紧一层）', () => {
  const fns = [
    { filePath: '/p/a.ERB', startLine: 2, endLine: 9 },
    { filePath: '/p/a.ERB', startLine: 12, endLine: 19 },
    { filePath: '/p/b.ERB', startLine: 2, endLine: 30 },
  ];

  it('区间包含即命中；行落在边界上也算', () => {
    expect(functionRangeAt(fns, { filePath: '/p/a.ERB', line: 5, derivedView: false })).toBe(fns[0]);
    expect(functionRangeAt(fns, { filePath: '/p/a.ERB', line: 12, derivedView: false })).toBe(fns[1]);
    expect(functionRangeAt(fns, { filePath: '/p/a.ERB', line: 9, derivedView: false })).toBe(fns[0]);
  });

  it('三态一律 null：无位点 / 无文件 / 派生视图（行号不属于真文件）', () => {
    expect(functionRangeAt(fns, null)).toBeNull();
    expect(functionRangeAt(fns, { filePath: null, line: 5, derivedView: false })).toBeNull();
    expect(functionRangeAt(fns, { filePath: '/p/a.ERB', line: 5, derivedView: true })).toBeNull();
  });

  it('行不在任何区间（函数之间的空隙 / 文件头）→ null，不乱高亮', () => {
    expect(functionRangeAt(fns, { filePath: '/p/a.ERB', line: 1, derivedView: false })).toBeNull();
    expect(functionRangeAt(fns, { filePath: '/p/a.ERB', line: 11, derivedView: false })).toBeNull();
    expect(functionRangeAt(fns, { filePath: '/p/a.ERB', line: 99, derivedView: false })).toBeNull();
  });

  it('文件判等走 pathKey：Windows 盘符路径折叠大小写与分隔符；POSIX 不折叠大小写', () => {
    expect(
      functionRangeAt([{ filePath: 'C:\\Users\\me\\a.ERB', startLine: 2, endLine: 9 }], {
        filePath: 'c:/users/me/a.erb',
        line: 5,
        derivedView: false,
      }),
    ).not.toBeNull();
    // pathKey 的口径是"Windows 折叠"——POSIX 形态大小写敏感，不夸大
    expect(functionRangeAt(fns, { filePath: '/p/A.ERB', line: 5, derivedView: false })).toBeNull();
    expect(functionRangeAt(fns, { filePath: '/p/c.ERB', line: 5, derivedView: false })).toBeNull();
  });

  it('区间嵌套（同名内层）：最紧一层胜；同宽取靠后定义（确定性）', () => {
    const outer = { filePath: '/p/a.ERB', startLine: 1, endLine: 40 };
    const inner = { filePath: '/p/a.ERB', startLine: 10, endLine: 20 };
    expect(functionRangeAt([outer, inner], { filePath: '/p/a.ERB', line: 15, derivedView: false })).toBe(inner);
    // 同宽同文件的两段都包住此行（病态输入）→ 取靠后定义，结果确定
    const late = { filePath: '/p/a.ERB', startLine: 14, endLine: 22 };
    expect(functionRangeAt([inner, late], { filePath: '/p/a.ERB', line: 15, derivedView: false })).toBe(late);
  });
});

describe('cellKeysOfFunction — 命中函数 → 矩阵高亮格集合', () => {
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
  const matrix = buildMatrix(entry, (n) => depsByFn[n] ?? [], () => null);

  it('函数贡献的每一格都列出（一个函数只贡献一条列上的一格：行键 → 列键）', () => {
    // FAM_MESSAGE_COM_K1 在 /p/a.ERB 第 2 行：贡献 CFLAG:318 / TALENT:恋慕 两个 MESSAGE_COM 格
    const cells = cellKeysOfFunction(matrix, { filePath: '/p/a.ERB', startLine: 2 });
    expect(cells.get('CFLAG:318')).toBe('MESSAGE_COM');
    expect(cells.get('TALENT:恋慕')).toBe('MESSAGE_COM');
    expect(cells.size).toBe(2);
  });

  it('路径判等走 pathKey（分隔符折叠）；startLine 不同即不命中', () => {
    expect(cellKeysOfFunction(matrix, { filePath: '/p\\a.ERB', startLine: 2 }).size).toBe(2);
    expect(cellKeysOfFunction(matrix, { filePath: '/p/a.ERB', startLine: 3 }).size).toBe(0);
  });

  it('Windows 盘符路径：大小写 / 分隔符折叠后仍命中', () => {
    const wIdx = makeIndex({ 'C:\\p\\a.ERB': ['FAM_MESSAGE_COM_K1'] });
    const wEntry = buildCharacterIndex(wIdx, fakeFamilyIndex).entries.get(1)!;
    const wMatrix = buildMatrix(wEntry, (n) => depsByFn[n] ?? [], () => null);
    expect(cellKeysOfFunction(wMatrix, { filePath: 'c:/p/A.erb', startLine: 2 }).size).toBe(2);
  });

  it('函数不在当前矩阵（选了别的角色 / 未归属）→ 空集合 = 静默不高亮', () => {
    expect(cellKeysOfFunction(matrix, { filePath: '/p/z.ERB', startLine: 2 }).size).toBe(0);
  });

  it('无依赖函数（矩阵里没有它的格）→ 空集合', () => {
    // FAM_MESSAGE_COUNTER_K1 在 /p/a.ERB 第 22 行，但 depsOf 恒空 → 无格可高亮
    expect(cellKeysOfFunction(matrix, { filePath: '/p/a.ERB', startLine: 22 }).size).toBe(0);
  });
});

/* ------------------------------ 滚动帧窗口判据 ------------------------------ */

describe('autoFoldFaces（大矩阵默认折叠指令时机）', () => {
  const col = (face: string, i: number, instruction: boolean) => ({
    key: `${face}#${i}`,
    face,
    label: `#${i}`,
    instructionNo: instruction ? i : null,
    functions: [],
    universeFunctions: [],
    fillCount: 0,
    gapCount: 0,
  });
  const group = (face: string, n: number, instruction: boolean) => ({
    face,
    label: face,
    columns: Array.from({ length: n }, (_, i) => col(face, i, instruction)),
  });

  it('总列数不超过阈值 → 不折叠任何组', () => {
    expect(autoFoldFaces([group('A', 3, true), group('B', 10, false)]).size).toBe(0);
  });

  it('超过阈值 → 只折叠多列指令面，非指令面/小分组保留', () => {
    const folded = autoFoldFaces([
      group('A', 10, true),
      group('B', 3, true),
      group('C', 50, false),
      group('D', 20, true),
    ]);
    expect([...folded].sort()).toEqual(['A', 'D']);
  });

  it('全是非指令面 → 无可折叠（列数通常就等于面数）', () => {
    expect(autoFoldFaces([group('A', 30, false), group('B', 40, false)]).size).toBe(0);
  });
});

describe('rowHasVisibleGap（只看空缺判据）', () => {
  const present = (): MatrixCell => ({ present: true, count: 1, functions: [] });
  const row = (cells: Record<string, MatrixCell>): MatrixRow => ({
    key: 'CFLAG:318',
    name: 'CFLAG',
    indices: ['318'],
    label: '好感',
    totalCount: 0,
    comparisons: [],
    universeComparisons: [],
    cells,
    gapCount: 0,
  });

  it('可见列里有一列没响应 → 行是空缺', () => {
    expect(rowHasVisibleGap(row({ A: present() }), ['A', 'B'])).toBe(true);
  });

  it('可见列全都有响应 → 不是空缺（不可见列缺不算）', () => {
    expect(rowHasVisibleGap(row({ A: present(), B: present() }), ['A', 'B'])).toBe(false);
  });

  it('没有可见列 → 不留下任何行（否则只会得到一张空表）', () => {
    expect(rowHasVisibleGap(row({ A: present() }), [])).toBe(false);
  });
});

describe('sameMatrixWindow（窗口不变 ⇒ 滚动帧不重渲）', () => {
  const ROW = 26;
  it('在同一行内滚动：start/end 不变 ⇒ 视为同一窗口', () => {
    const layout = planMatrixWindow(ROW * 40, 400, 500, ROW);
    const next = planMatrixWindow(ROW * 40 + 21, 400, 500, ROW);
    expect(next.win.start).toBe(layout.win.start);
    expect(sameMatrixWindow(layout.win, next.win)).toBe(true);
  });

  it('跨过一行：窗口平移 ⇒ 需要换 tbody 内容', () => {
    const layout = planMatrixWindow(ROW * 40, 400, 500, ROW);
    const next = planMatrixWindow(ROW * 41, 400, 500, ROW);
    expect(sameMatrixWindow(layout.win, next.win)).toBe(false);
  });

  it('顶边界：同一窗口内的微小滚动仍按区间判等', () => {
    const top = planMatrixWindow(0, 400, 500, ROW);
    expect(sameMatrixWindow(top.win, planMatrixWindow(0, 400, 500, ROW).win)).toBe(true);
    expect(sameMatrixWindow(top.win, planMatrixWindow(5, 400, 500, ROW).win)).toBe(true);
  });
});

/* ------------------------------ 全部角色清单 ------------------------------ */

describe('buildCharaOptions（游戏角色表 ∪ 函数索引）', () => {
  it('0 函数的游戏角色也在清单里（count 0），不再只列有口上的角色', () => {
    const choices = buildCharaOptions(
      [
        { no: 1, name: '甲' },
        { no: 2, name: '乙' },
        { no: 5, name: '戊' },
      ],
      [{ no: 1, count: 9 }],
    );
    expect(choices).toEqual([
      { no: 1, name: '甲', count: 9 },
      { no: 2, name: '乙', count: 0 },
      { no: 5, name: '戊', count: 0 },
    ]);
  });

  it('索引里多出来的编号也保留（CSV 没登记但确有函数）', () => {
    const choices = buildCharaOptions([{ no: 1, name: '甲' }], [
      { no: 1, count: 2 },
      { no: 7, count: 4 },
    ]);
    expect(choices.map((c) => [c.no, c.name, c.count])).toEqual([
      [1, '甲', 2],
      [7, '', 4],
    ]);
  });

  it('按编号升序（不依赖输入顺序）', () => {
    const choices = buildCharaOptions(
      [
        { no: 9, name: '九' },
        { no: 2, name: '二' },
      ],
      [{ no: 5, count: 1 }],
    );
    expect(choices.map((c) => c.no)).toEqual([2, 5, 9]);
  });
});
