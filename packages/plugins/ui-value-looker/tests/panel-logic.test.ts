/**
 * 数值看板纯逻辑单测（零 React 零 IO）。
 *
 * 覆盖：族行构建（有表才出现 / 显示名回退）、条目行与中文说明补全、
 * 搜索匹配（CJK / 数字编号前缀）、复制片段（角色系 / 具名 / 非法名不产出）、
 * 变量反查索引（按族分桶 / 同函数同键合并计数 / 精确键大小写归一）、
 * 符号与指令过滤、渲染窗口（与契约 windowSize 同尺）。
 */
import { describe, expect, it } from 'vitest';
import type { ConditionIndex, VariableSchema } from '@kojo/plugin-api';
import { VL_WINDOW, VL_USAGE_WINDOW } from '../src/panel-logic';
import {
  buildFamilyRows,
  buildInstrRows,
  buildVarUsageIndex,
  emptyVarUsageIndex,
  entryRowsForFamily,
  filterFamilies,
  filterInstr,
  filterSymbols,
  filterVarEntries,
  queryMatches,
  snippetsFor,
  sourceLabel,
  usagesOf,
  vlWindowSize,
  type SymbolRow,
} from '../src/panel-logic';

/* ------------------------------ 夹具 ------------------------------ */

/** 测试字典：两族三名字（全部中性词，无游戏知识） */
const TABLES: Record<string, Record<number, string>> = {
  CFLAG: { 2: '好感甲', 3: '亲密乙' },
  FLAG: { 5: '路线丙' },
};

function fakeSchema(): VariableSchema {
  return {
    version: 'test',
    lookup(name: string, index?: number | string) {
      const key = name.toUpperCase();
      if (index === undefined) {
        const label = key === 'CFLAG' ? '角色标志（测）' : undefined;
        return label ? { name: key, description: label } : { name: key };
      }
      const n = TABLES[key]?.[Number(index)];
      return n === undefined
        ? { name: key, index }
        : { name: key, index, description: n, resolvedIndex: Number(index), source: 'primary' };
    },
    names(family: string) {
      const t = TABLES[family.toUpperCase()];
      if (!t) return [];
      return Object.entries(t).map(([k, v]) => ({
        name: v,
        index: Number(k),
        resolvedIndex: Number(k),
        source: 'primary' as const,
      }));
    },
  } as VariableSchema;
}

/* ------------------------------ 族行 / 条目行 ------------------------------ */

describe('buildFamilyRows', () => {
  it('有名称表的族才出现；显示名走家族级 lookup；候选序保持', () => {
    const rows = buildFamilyRows(fakeSchema());
    expect(rows.map((r) => r.id)).toEqual(['CFLAG', 'FLAG']);
    expect(rows[0]!.label).toBe('角色标志（测）');
    // FLAG 没有家族级策展名 → 回退族头原样
    expect(rows[1]!.label).toBe('FLAG');
    expect(rows[0]!.charaScoped).toBe(true);
    expect(rows[1]!.charaScoped).toBe(false);
  });

  it('names 缺席（旧字典）→ 空清单，不抛', () => {
    const schema = { version: 'x', lookup: () => undefined } as unknown as VariableSchema;
    expect(buildFamilyRows(schema)).toEqual([]);
  });

  it('0 条的族不显示（不猜空壳族）', () => {
    const schema = fakeSchema();
    (schema as { names: (f: string) => unknown }).names = (f: string) =>
      f.toUpperCase() === 'TFLAG' ? [] : TABLES[f] ? Object.entries(TABLES[f]!).map(([k, v]) => ({ name: v, index: Number(k) })) : [];
    const rows = buildFamilyRows(schema);
    expect(rows.map((r) => r.id)).toEqual(['CFLAG', 'FLAG']);
  });
});

describe('entryRowsForFamily', () => {
  it('条目补 description（经 lookup）+ 族头大写归一', () => {
    const rows = entryRowsForFamily(fakeSchema(), 'cflag');
    expect(rows.map((r) => r.index)).toEqual([2, 3]);
    expect(rows[0]!.family).toBe('CFLAG');
    expect(rows[0]!.desc).toBe('好感甲');
    expect(rows[0]!.resolvedIndex).toBe(2);
  });

  it('无表族 → 空数组', () => {
    expect(entryRowsForFamily(fakeSchema(), 'NOPE')).toEqual([]);
  });
});

/* ------------------------------ 搜索 ------------------------------ */

describe('queryMatches / filterVarEntries', () => {
  const rows = entryRowsForFamily(fakeSchema(), 'CFLAG');

  it('空查询全收', () => {
    expect(filterVarEntries(rows, '  ')).toHaveLength(2);
  });

  it('中文名命中（description）', () => {
    expect(filterVarEntries(rows, '好感')).toHaveLength(1);
  });

  it('数字查询命中编号（含前缀）', () => {
    expect(filterVarEntries(rows, '3')).toHaveLength(1);
    expect(filterVarEntries(rows, '3')[0]!.index).toBe(3);
  });

  it('queryMatches：数字前缀匹配 number 字段；大小写折叠', () => {
    expect(queryMatches('2', [3, '别的'])).toBe(false);
    expect(queryMatches('3', [30])).toBe(true);
    expect(queryMatches('flag', ['FLAGX'])).toBe(true);
  });
});

describe('filterFamilies / filterSymbols / filterInstr', () => {
  const fams = buildFamilyRows(fakeSchema());
  it('族搜索命中 id 与显示名', () => {
    expect(filterFamilies(fams, 'cflag')).toHaveLength(1);
    expect(filterFamilies(fams, '标志')).toHaveLength(1);
    expect(filterFamilies(fams, '没有的')).toHaveLength(0);
  });

  const syms: SymbolRow[] = [
    { name: 'CheckFeel', kind: 'fn', filePath: 'D:/g/ERB/A.ERB', line: 3, params: 1, doc: ';判定好感', inLibrary: false },
    { name: 'ROUTINE_SET', kind: 'dim', directive: 'DIM', filePath: 'D:/g/ERH/DIM.ERH', line: 9, inLibrary: false },
  ];
  it('符号搜索命中名字 / 注释 / 路径', () => {
    expect(filterSymbols(syms, 'checkfeel')).toHaveLength(1);
    expect(filterSymbols(syms, '好感')).toHaveLength(1);
    expect(filterSymbols(syms, '.erh')).toHaveLength(1);
    expect(filterSymbols(syms, '没有')).toHaveLength(0);
  });

  it('buildInstrRows：查不到编号的跳过；编号命中即收', () => {
    const rows = buildInstrRows([' kiss ', 'unknown'], (n) => (n === ' kiss ' ? 7 : undefined));
    expect(rows).toEqual([{ no: 7, name: ' kiss ' }]);
    expect(filterInstr(rows, '7')).toHaveLength(1);
    expect(filterInstr(rows, 'kis')).toHaveLength(1);
  });
});

/* ------------------------------ 复制片段 ------------------------------ */

describe('snippetsFor', () => {
  it('角色系族：编号 / 具名 / TARGET / MASTER / TARGET 具名', () => {
    const rows = entryRowsForFamily(fakeSchema(), 'CFLAG');
    const s = snippetsFor('CFLAG', rows[0]!);
    expect(s.map((x) => x.text)).toEqual([
      'CFLAG:2',
      'CFLAG:好感甲',
      'CFLAG:TARGET:2',
      'CFLAG:MASTER:2',
      'CFLAG:TARGET:好感甲',
    ]);
  });

  it('全局族：没有角色维片段', () => {
    const rows = entryRowsForFamily(fakeSchema(), 'FLAG');
    const s = snippetsFor('FLAG', rows[0]!);
    expect(s.map((x) => x.text)).toEqual(['FLAG:5', 'FLAG:路线丙']);
  });

  it('含空白 / 冒号的名字不产具名片段（写进表达式会碎）', () => {
    const entry = { family: 'CFLAG', index: 2, name: 'bad name:here' };
    const s = snippetsFor('CFLAG', entry);
    expect(s.map((x) => x.text)).toEqual(['CFLAG:2', 'CFLAG:TARGET:2', 'CFLAG:MASTER:2']);
  });

  it('resolvedIndex 优先于字符串 index', () => {
    const entry = { family: 'FLAG', index: '路线丙', resolvedIndex: 5, name: '路线丙' };
    const s = snippetsFor('FLAG', entry);
    expect(s[0]!.text).toBe('FLAG:5');
  });
});

/* ------------------------------ 反查索引 ------------------------------ */

describe('buildVarUsageIndex / usagesOf', () => {
  function condIndex(deps: Record<string, { key: string; count?: number; line?: number }[]>): ConditionIndex {
    return {
      byFunction: new Map(
        Object.entries(deps).map(([fn, d]) => [
          fn,
          {
            name: fn,
            dependencies: d.map((x) => ({
              key: x.key,
              name: x.key.split(':')[0]!,
              indices: [x.key.split(':')[1] ?? ''],
              count: x.count ?? 1,
              ...(x.line !== undefined ? { firstLine: x.line } : {}),
              comparisons: [],
            })),
          },
        ]),
      ),
    } as unknown as ConditionIndex;
  }

  it('按族分桶；同函数同键合并计数；无依赖函数不计入', () => {
    const idx = buildVarUsageIndex(
      condIndex({
        FN_A: [{ key: 'CFLAG:2', count: 3, line: 10 }, { key: 'CFLAG:2', count: 2 }],
        FN_B: [{ key: 'FLAG:5', line: 4 }],
        FN_C: [],
      }),
    );
    expect(idx.functions).toBe(2);
    const cflag = idx.byFamily.get('CFLAG')!;
    expect(cflag).toHaveLength(1);
    expect(cflag[0]!.fn).toBe('FN_A');
    expect(cflag[0]!.count).toBe(5);
    expect(cflag[0]!.line).toBe(10);
    expect(idx.byFamily.get('FLAG')![0]!.fn).toBe('FN_B');
  });

  it('usagesOf：精确键大小写归一；族级总数兜底', () => {
    const idx = buildVarUsageIndex(
      condIndex({
        FN_A: [{ key: 'CFLAG:2', line: 10 }],
        FN_B: [{ key: 'CFLAG:路线', line: 20 }],
      }),
    );
    const exact = usagesOf(idx, 'cflag', 2);
    expect(exact.exact.map((u) => u.fn)).toEqual(['FN_A']);
    expect(exact.familyTotal).toBe(2);
    // 具名索引没有精确命中，但族级总数如实显示（不冒充精确）
    const named = usagesOf(idx, 'CFLAG', '路线');
    expect(named.exact.map((u) => u.fn)).toEqual(['FN_B']);
    expect(named.familyTotal).toBe(2);
    // 整族无使用
    expect(usagesOf(idx, 'ITEM', 1)).toEqual({ exact: [], familyTotal: 0 });
  });

  it('空索引 / 缺席索引 → 形状稳定的空结果', () => {
    const empty = emptyVarUsageIndex();
    expect(empty.byFamily.size).toBe(0);
    expect(usagesOf(empty, 'CFLAG', 2).exact).toEqual([]);
    expect(buildVarUsageIndex({ byFunction: new Map() } as unknown as ConditionIndex).functions).toBe(0);
  });
});

/* ------------------------------ 杂项 ------------------------------ */

describe('sourceLabel / 窗口', () => {
  it('来源层三态中文', () => {
    expect(sourceLabel('primary')).toBe('主表');
    expect(sourceLabel('append')).toBe('追加表');
    expect(sourceLabel('const')).toBe('常量');
    expect(sourceLabel(undefined)).toBe('主表');
  });

  it('vlWindowSize 与 VL_WINDOW 同尺：min(total, initial)', () => {
    expect(vlWindowSize(5, undefined)).toBe(5);
    expect(vlWindowSize(VL_WINDOW.initial + 500, undefined)).toBe(VL_WINDOW.initial);
    expect(vlWindowSize(VL_WINDOW.initial + 50, VL_WINDOW.initial + 50)).toBe(VL_WINDOW.initial + 50);
    expect(VL_WINDOW.step).toBe(VL_WINDOW.initial * 2);
    expect(VL_USAGE_WINDOW.step).toBe(VL_USAGE_WINDOW.initial * 2);
  });
});
