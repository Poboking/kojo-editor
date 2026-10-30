/**
 * ERB 实参个数诊断（`arity.ts`）单测——**纯函数**：文本 + 函数目录进、>= 波浪线数据出。
 *
 * 钉死六类形状（任务要求的最小/最大/可变/未知/零参，另加省略形与安全边界）：
 * (a) 不足（缺必填）→ error；只缺可选 → warning；
 * (b) 超出 → error；
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
  collectArityDiagnostics({ path, text, catalog: catalogOf(table) });

describe('collectArityDiagnostics · 个数判定', () => {
  it('缺必填 → error，range 落在实参区（第 1 个实参）', () => {
    const out = run('CALL FOO, 1\n', { FOO: [p('ARG'), p('ARG:1')] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      line: 1,
      severity: 'error',
      code: ARITY_MISMATCH_CODE,
      startColumn: 11,
      endColumn: 12,
    });
    expect(out[0]!.message).toContain('期望 2 个，实际 1 个');
  });

  it('多给 → error，range 覆盖首末实参', () => {
    const out = run('CALL FOO, 1, 2, 3\n', { FOO: [p('ARG'), p('ARG:1')] });
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('error');
    expect(out[0]!.message).toContain('期望 2 个，实际 3 个');
    expect([out[0]!.startColumn, out[0]!.endColumn]).toEqual([11, 18]);
  });

  it('只缺可选（有默认值）→ warning，仍是同一个诊断码', () => {
    const out = run('CALL FOO, 1\n', { FOO: [p('ARG'), p('OPT', true)] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: 'warning', code: ARITY_MISMATCH_CODE });
    expect(out[0]!.message).toContain('期望 2 个，实际 1 个');
  });

  it('全可选且零实参 → warning，range 落函数名', () => {
    const out = run('CALL FOO\n', { FOO: [p('OPT', true)] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: 'warning', startColumn: 6, endColumn: 9 });
    expect(out[0]!.message).toContain('期望 1 个，实际 0 个');
  });

  it('TRYCALL 与 CALL 同一条判据', () => {
    const out = run('\tTRYCALL FOO, 1, 2\n', { FOO: [p('A')] });
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('error');
    expect(out[0]!.message).toContain('期望 1 个，实际 2 个');
  });
});

describe('collectArityDiagnostics · 省略形与零参', () => {
  it('零参函数：无实参不报；带实参报「期望 0 个」', () => {
    expect(run('CALL ZERO\n', { ZERO: [] })).toEqual([]);
    const out = run('CALL ZERO, 1\n', { ZERO: [] });
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toContain('期望 0 个，实际 1 个');
    expect(out[0]!.startColumn).toBe(12);
  });

  it('`CALL FOO` 与尾逗号都算 0 个实参（末位空槽不是第 N 参）', () => {
    const table = { FOO: [p('A'), p('B')] };
    expect(run('CALL FOO\n', table)[0]!.message).toContain('期望 2 个，实际 0 个');
    expect(run('CALL FOO,\n', table)[0]!.message).toContain('期望 2 个，实际 0 个');
    // 中间空槽照样占位：`, , "x"` = 2 个（这里三参签名 ⇒ 实际 2 个，缺第 3 个）
    const middle = run('CALL FOO, , "x"\n', { FOO: [p('A'), p('B'), p('C')] });
    expect(middle[0]!.message).toContain('期望 3 个，实际 2 个');
  });

  it('括号形里的字符串逗号不分隔', () => {
    expect(run('CALL FOO("a,b", 2)\n', { FOO: [p('A'), p('B')] })).toEqual([]);
    const out = run('CALL FOO("a,b", 2)\n', { FOO: [p('A')] });
    expect(out[0]!.message).toContain('期望 1 个，实际 2 个');
    expect([out[0]!.startColumn, out[0]!.endColumn]).toEqual([10, 18]);
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
    expect(run('TRYCALLLIST FOO\n', { FOO: [p('A'), p('B')] })).toEqual([]);
    expect(run('TRYCCALLLIST FOO, BAR\n', { FOO: [p('A')] })).toEqual([]);
  });

  it('成员访问占槽不算函数名（CALL 与表达式两条腿）', () => {
    expect(run('CALL FLAG:MEMBER, 1\n', { MEMBER: [p('A'), p('B')] })).toEqual([]);
    expect(run('X = VAR:MEMBER(1)\n', { MEMBER: [p('A'), p('B')] })).toEqual([]);
    // 变量名本身撞上目录名也不算：整行是成员访问形态
    expect(run('CALL VAR:MEMBER, 1\n', { VAR: [p('A'), p('B')] })).toEqual([]);
  });

  it('非 ERB 方言路径与空文本 ⇒ 空数组', () => {
    expect(run('CALL FOO, 1\n', { FOO: [p('A'), p('B')] }, 'A.kojo')).toEqual([]);
    expect(run('', { FOO: [p('A')] })).toEqual([]);
  });
});

describe('collectArityDiagnostics · 表达式调用', () => {
  it('表达式调用按实参区报错', () => {
    const out = run('X = FOO(1, 2)\n', { FOO: [p('A')] });
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toContain('期望 1 个，实际 2 个');
    expect([out[0]!.startColumn, out[0]!.endColumn]).toEqual([9, 13]);
  });

  it('零实参表达式调用：range 落函数名', () => {
    const out = run('IF FOO()\n', { FOO: [p('A')] });
    expect(out).toHaveLength(1);
    expect([out[0]!.startColumn, out[0]!.endColumn]).toEqual([4, 7]);
  });

  it('CALL 括号形只报一条（表达式腿不重复报名字槽）', () => {
    const out = run('CALL FOO(1, 2)\n', { FOO: [p('A')] });
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toContain('期望 1 个，实际 2 个');
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
          { file: 'b.ERB', line: 9, params: [p('A'), p('B')] },
        ]),
        'FOO',
      ),
    ).toBeNull();
    expect(arityParamsOf(makeIndex([{ file: 'a.ERB', line: 5, params: [p('A')] }]), 'MISSING')).toBeNull();
  });
});
