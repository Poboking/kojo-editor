/**
 * ERB 实参个数诊断（`arity.ts`）单测——**纯函数**：文本 + 函数目录进、>= 波浪线数据出。
 *
 * 钉死六类形状（D02 翻转 + 定罪开关之后的口径）：
 * (a) 少给**必需**（带下标、基础名非 ARG/ARGS/ARGF 家族）→ 开关打开才 error；默认关；
 * (b) 多给 / 省略可选 / 裸名槽的少给 ⇒ **一律不产**（引擎全容忍）；
 * (c) 可变下标形参（`ARG:X`）⇒ 不判；
 * (d) 目录不认识 ⇒ 不报；
 * (e) 零参函数 / 省略形（`CALL FOO`、尾逗号）按 0 个实参算；
 * (f) range：有实参落实参区，无实参落函数名；CALL 括号形不会被表达式腿重复报。
 */

import { functionLookupOf } from '@kojo/plugin-api';
import { describe, expect, it } from 'vitest';
import type { ErbFunctionRef, ErbIndex, ErbParam } from '@kojo/plugin-api';
import { ARITY_MISMATCH_CODE, arityParamsOf, collectArityDiagnostics } from '../src/arity';

const p = (name: string, hasDefault = false): ErbParam => ({ name, hasDefault });

/** 目录桩：Map 缺席 = null（未收录，不报） */
const catalogOf = (table: Record<string, readonly ErbParam[]>) => (name: string) => table[name] ?? null;

const run = (text: string, table: Record<string, readonly ErbParam[]>, path = 'A.ERB') =>
  collectArityDiagnostics({ path, text, catalog: catalogOf(table), diagnoseMissingRequired: true });

describe('collectArityDiagnostics · 定罪开关（D02 默认关）', () => {
  const table = { FOO: [p('G_ARR:1'), p('G_ARR:2')] };

  it('默认开关下"少给必需"一条不上屏（要的是第三格事实：形参基础名的声明位置）', () => {
    expect(
      collectArityDiagnostics({ path: 'A.ERB', text: 'CALL FOO, 1\n', catalog: catalogOf(table) }),
    ).toEqual([]);
    // 开关打开 ⇒ 同一条调用必报（判据活着，不是走不到的支）
    expect(run('CALL FOO, 1\n', table)).toHaveLength(1);
  });

  it('开关关着也照样不放过"补齐实参"的反证：多给 / 省略形永远不产', () => {
    const input = { path: 'A.ERB', text: 'CALL FOO, 1, 2, 3\n', catalog: catalogOf(table) };
    expect(collectArityDiagnostics(input)).toEqual([]);
    expect(collectArityDiagnostics({ ...input, diagnoseMissingRequired: true })).toEqual([]);
  });
});

describe('collectArityDiagnostics · 个数判定', () => {
  it('缺必填（下标形参、非 ARG 家族、无默认值）→ error，range 落在实参区', () => {
    const out = run('CALL FOO, 1\n', { FOO: [p('ARG'), p('G_ARR:1')] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      line: 1,
      severity: 'error',
      code: ARITY_MISMATCH_CODE,
      startColumn: 11,
      endColumn: 12,
    });
    expect(out[0]!.message).toContain('期望 2 个，实际 1 个');
    expect(out[0]!.message).toContain('「G_ARR:1」没有默认值');
  });

  it('少给（引擎补默认值的槽）⇒ 不产：ARG 家族下标形 / 裸名私有变量 / 带初值形参', () => {
    // `ErbLoader`：`canDef = ARG 家族 || IsPrivate`，槽没写 `= 值` 也合成默认值（0 / 0.0 / ""）
    expect(run('CALL FOO, 1\n', { FOO: [p('ARG'), p('ARG:1')] })).toEqual([]);
    expect(run('CALL FOO\n', { FOO: [p('ARG'), p('ARGS:1'), p('ARGF:2')] })).toEqual([]);
    // 裸名（作者自定义）形参：引擎那两道硬门保证它必是私有变量 ⇒ 同样可省
    expect(run('CALL FOO, 1\n', { FOO: [p('身体部位'), p('精液量')] })).toEqual([]);
    expect(run('CALL COLORMESSAGE, 1\n', { COLORMESSAGE: [p('L_STR'), p('L_COLOR'), p('L_STYLE')] })).toEqual([]);
    // 显式默认值
    expect(run('CALL FOO, 1\n', { FOO: [p('ARG'), p('ARG:1', true)] })).toEqual([]);
  });

  it('少给必需：CALL / TRYCALL / 表达式三条调用面同判据', () => {
    const table = { FOO: [p('G_ARR:1'), p('G_ARR:2')] };
    for (const text of ['CALL FOO, 1\n', 'TRYCALL FOO, 1\n', 'X = FOO(1)\n']) {
      const out = run(text, table);
      expect(out, text).toHaveLength(1);
      expect(out[0]!.severity).toBe('error');
      expect(out[0]!.message).toContain('期望 2 个，实际 1 个');
    }
  });

  it('补齐必需实参 ⇒ 不再报（反证一）', () => {
    expect(run('CALL FOO, 1, 2\n', { FOO: [p('G_ARR:1'), p('G_ARR:2')] })).toEqual([]);
  });
});

describe('collectArityDiagnostics · 省略形与零参', () => {
  it('零参函数：给多少个实参都不产（多给 = 引擎静默丢弃）', () => {
    expect(run('CALL ZERO\n', { ZERO: [] })).toEqual([]);
    expect(run('CALL ZERO, 1\n', { ZERO: [] })).toEqual([]);
    expect(run('CALL ZERO, 1, 2, 3\n', { ZERO: [] })).toEqual([]);
  });

  it('`CALL FOO` 与尾逗号都算 0 个实参（末位空槽不是第 N 参）', () => {
    const table = { FOO: [p('G_ARR:1'), p('G_ARR:2')] };
    expect(run('CALL FOO\n', table)[0]!.message).toContain('期望 2 个，实际 0 个');
    expect(run('CALL FOO,\n', table)[0]!.message).toContain('期望 2 个，实际 0 个');
    // 中间空槽照样占位：`, , "x"` = 2 个（这里三参全必需 ⇒ 实际 2 个，缺第 3 个）
    const middle = run('CALL FOO, , "x"\n', { FOO: [p('G_ARR:1'), p('G_ARR:2'), p('G_ARR:3')] });
    expect(middle[0]!.message).toContain('期望 3 个，实际 2 个');
  });

  it('括号形里的字符串逗号不分隔（数错就会把少给判成多给）', () => {
    expect(run('CALL FOO("a,b", 2)\n', { FOO: [p('G_ARR:1'), p('G_ARR:2')] })).toEqual([]);
    const out = run('CALL FOO("a,b")\n', { FOO: [p('G_ARR:1'), p('G_ARR:2')] });
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toContain('期望 2 个，实际 1 个');
    expect([out[0]!.startColumn, out[0]!.endColumn]).toEqual([10, 15]);
  });
});

describe('collectArityDiagnostics · 不猜的边界', () => {
  it('可变下标形参（ARG:X / ARG:(ARG:0)）⇒ 整个函数不判', () => {
    expect(run('CALL VARF, 1, 2, 3, 4\n', { VARF: [p('ARG'), p('ARG:X')] })).toEqual([]);
    expect(run('CALL VARF\n', { VARF: [p('ARG:(ARG:0)')] })).toEqual([]);
  });

  it('未知函数（目录给 null）⇒ 不报', () => {
    expect(run('CALL NOPE, 1, 2, 3\n', {})).toEqual([]);
    expect(run('X = NOPE(1)\n', {})).toEqual([]);
  });

  it('LIST 族后跟函数名清单，不是实参表', () => {
    expect(run('TRYCALLLIST FOO\n', { FOO: [p('G_ARR:1'), p('G_ARR:2')] })).toEqual([]);
    expect(run('TRYCCALLLIST FOO, BAR\n', { FOO: [p('A')] })).toEqual([]);
  });

  it('成员访问占槽不算函数名（CALL 与表达式两条腿）', () => {
    expect(run('CALL FLAG:MEMBER, 1\n', { MEMBER: [p('G_ARR:1'), p('G_ARR:2')] })).toEqual([]);
    expect(run('X = VAR:MEMBER(1)\n', { MEMBER: [p('G_ARR:1'), p('G_ARR:2')] })).toEqual([]);
    // 变量名本身撞上目录名也不算：整行是成员访问形态
    expect(run('CALL VAR:MEMBER, 1\n', { VAR: [p('G_ARR:1'), p('G_ARR:2')] })).toEqual([]);
  });

  it('非 ERB 方言路径与空文本 ⇒ 空数组', () => {
    expect(run('CALL FOO, 1\n', { FOO: [p('G_ARR:1'), p('G_ARR:2')] }, 'A.kojo')).toEqual([]);
    expect(run('', { FOO: [p('A')] })).toEqual([]);
  });
});

describe('collectArityDiagnostics · 表达式调用', () => {
  it('表达式调用按实参区报错', () => {
    const out = run('X = FOO(1)\n', { FOO: [p('G_ARR:1'), p('G_ARR:2')] });
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toContain('期望 2 个，实际 1 个');
    expect([out[0]!.startColumn, out[0]!.endColumn]).toEqual([9, 10]);
  });

  it('零实参表达式调用：range 落函数名', () => {
    const out = run('IF FOO()\n', { FOO: [p('G_ARR:1')] });
    expect(out).toHaveLength(1);
    expect([out[0]!.startColumn, out[0]!.endColumn]).toEqual([4, 7]);
  });

  it('CALL 括号形只报一条（表达式腿不重复报名字槽）', () => {
    const out = run('CALL FOO(1)\n', { FOO: [p('G_ARR:1'), p('G_ARR:2')] });
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toContain('期望 2 个，实际 1 个');
  });

  it('定义行 @FOO(ARG) 不是调用点', () => {
    expect(run('@FOO(ARG)\nCALL FOO, 1\n', { FOO: [p('ARG')] })).toEqual([]);
  });
});

describe('arityParamsOf · 多处定义一致性', () => {
  const makeIndex = (defs: { file: string; line: number; params: ErbParam[] }[]): ErbIndex => {
    const files = new Map<string, { functions: { startLine: number; params: ErbParam[] }[] }>();
    const byName = new Map<string, ErbFunctionRef[]>();
    for (const def of defs) {
      const entry = files.get(def.file) ?? { functions: [] };
      entry.functions.push({ startLine: def.line, params: def.params });
      files.set(def.file, entry);
      const list = byName.get('FOO') ?? [];
      list.push({ name: 'FOO', normalizedName: 'FOO', filePath: def.file, startLine: def.line, endLine: def.line });
      byName.set('FOO', list);
    }
    return { files, byName: functionLookupOf(byName) } as unknown as ErbIndex;
  };

  it('同名多处定义一致 ⇒ 给形参表', () => {
    const params = [p('A'), p('B', true)];
    const index = makeIndex([
      { file: 'a.ERB', line: 1, params },
      { file: 'b.ERB', line: 9, params: [p('a'), p('b', true)] },
    ]);
    expect(arityParamsOf(index, 'FOO')).toEqual(params);
  });

  it('默认值有无分歧 / 形参个数分歧 / 定义体缺席 ⇒ null（不猜）', () => {
    expect(
      arityParamsOf(
        makeIndex([
          { file: 'a.ERB', line: 1, params: [p('A')] },
          { file: 'b.ERB', line: 9, params: [p('A', true)] },
        ]),
        'FOO',
      ),
    ).toBeNull();
    expect(
      arityParamsOf(
        makeIndex([
          { file: 'a.ERB', line: 1, params: [p('A')] },
          { file: 'b.ERB', line: 9, params: [p('G_ARR:1'), p('G_ARR:2')] },
        ]),
        'FOO',
      ),
    ).toBeNull();
    expect(arityParamsOf(makeIndex([{ file: 'a.ERB', line: 5, params: [p('A')] }]), 'MISSING')).toBeNull();
  });
});
