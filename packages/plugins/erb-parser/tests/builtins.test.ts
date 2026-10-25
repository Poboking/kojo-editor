/**
 * 内建式中函数签名表与实参诊断（`builtins.ts`）单测——**纯函数**：文本进、波浪线数据出。
 *
 * 钉死四组形状：
 * (a) 表完整性：名字集 = 签名表键集、全大写无重复、wiki 未载明签名的只认名字；
 * (b) 个数：多给 = error；少给 = **静默**（引擎合法省略）；可变实参族不设上限；
 * (c) 类型：只判可证形态（字面量 / FORM / `{…}` / 已知内建返回值），判不出一律不报；
 * (d) 安全边界：非方言路径 / 定义行 / 注释 / 字符串 / `[SKIPSTART]` 区不判；
 *     同名用户函数（影子）整体让位。
 */

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ARGS_CODE,
  BUILTIN_ARG_TYPE_CODE,
  BUILTIN_FUNCTION_NAMES,
  BUILTIN_SIGNATURES,
  builtinSignatureLabel,
  builtinSignatureOf,
  collectBuiltinArgDiagnostics,
} from '../src/builtins';

const run = (text: string, path = 'A.ERB', isUserFunction?: (name: string) => boolean) =>
  collectBuiltinArgDiagnostics({ path, text, ...(isUserFunction ? { isUserFunction } : {}) });

describe('BUILTIN_SIGNATURES · 表完整性', () => {
  it('名字集 = 签名表键集，全大写、无重复、升序', () => {
    expect(BUILTIN_FUNCTION_NAMES.length).toBe(BUILTIN_SIGNATURES.size);
    expect(new Set(BUILTIN_FUNCTION_NAMES).size).toBe(BUILTIN_FUNCTION_NAMES.length);
    for (const name of BUILTIN_FUNCTION_NAMES) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    const sorted = [...BUILTIN_FUNCTION_NAMES].sort();
    expect(BUILTIN_FUNCTION_NAMES).toEqual(sorted);
  });

  it('规模钉在 exmeth 口径（177 条目合重载后 ≥ 150 个不同名）', () => {
    expect(BUILTIN_FUNCTION_NAMES.length).toBeGreaterThanOrEqual(150);
    // 常用面必须在列（补全与诊断的同一张表）
    for (const name of ['STRLENS', 'SUBSTRING', 'ABS', 'MAX', 'RAND', 'GETBIT', 'TOSTR', 'CSVCFLAG', 'GCREATE']) {
      expect(BUILTIN_FUNCTION_NAMES).toContain(name);
    }
  });

  it('签名抽查：必填/可选/可变/未载明四形各就各位', () => {
    expect(builtinSignatureOf('STRLENS')).toEqual({ ret: 'int', params: [{ type: 'str', optional: false }], variadic: false });
    expect(builtinSignatureOf('SUBSTRING')?.params?.map((p) => p.optional)).toEqual([false, true, true]);
    expect(builtinSignatureOf('MAX')).toEqual({
      ret: 'int',
      params: [
        { type: 'int', optional: false },
        { type: 'int', optional: false },
      ],
      variadic: true,
    });
    // wiki 未载明签名 ⇒ 只认名字，params/ret 双 null
    expect(builtinSignatureOf('INRANGEARRAY')).toEqual({ ret: null, params: null, variadic: false });
    // RAND 两形皆可选（wiki 凡例 RAND(100) 单参合法）
    expect(builtinSignatureOf('RAND')?.params?.every((p) => p.optional)).toBe(true);
    // 大小写不敏感
    expect(builtinSignatureOf('strlens')).toEqual(builtinSignatureOf('STRLENS'));
    expect(builtinSignatureOf('NOT_A_FUNCTION')).toBeNull();
  });

  it('签名文案：可选 `?` / 可变 `…` / 未载明只给名', () => {
    expect(builtinSignatureLabel('STRLENS')).toBe('STRLENS(str) → int');
    expect(builtinSignatureLabel('SUBSTRING')).toBe('SUBSTRING(str, int?, int?) → str');
    expect(builtinSignatureLabel('MAX')).toBe('MAX(int, int, …) → int');
    expect(builtinSignatureLabel('GETTIMES')).toBe('GETTIMES() → str');
    expect(builtinSignatureLabel('INRANGEARRAY')).toBe('INRANGEARRAY');
    expect(builtinSignatureLabel('NOT_A_FUNCTION')).toBeNull();
  });
});

describe('collectBuiltinArgDiagnostics · 个数', () => {
  it('多给 → error，range 覆盖实参区', () => {
    const out = run('A = STRLENS("a", "b")\n');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ line: 1, severity: 'error', code: BUILTIN_ARGS_CODE });
    expect(out[0]!.message).toContain('最多 1 个，实际 2 个');
    // 实参区 = 首个非空实参起点 .. 末个非空实参终点（`"a", "b"`）
    expect([out[0]!.startColumn, out[0]!.endColumn]).toEqual([13, 21]);
  });

  it('少给 / 零参调用 → 静默（引擎按 0 / 空串兜底）', () => {
    expect(run('A = STRLENS()\n')).toEqual([]);
    expect(run('A = STRLENS\n')).toEqual([]);
    expect(run('A = SUBSTRING("abc")\n')).toEqual([]);
  });

  it('零参函数多给一个也报', () => {
    const out = run('A = GETTIME(1)\n');
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toContain('最多 0 个，实际 1 个');
  });

  it('可变实参族（MAX/GROUPMATCH/CONVERT）不设上限', () => {
    expect(run('A = MAX(1, 2, 3, 4)\n')).toEqual([]);
    expect(run('A = GROUPMATCH(1, 2, 3)\n')).toEqual([]);
    expect(run('A = CONVERT(10, "x", "y")\n')).toEqual([]);
  });

  it('CALL 直系族同样判（括号形与逗号形）', () => {
    expect(run('CALL STRLENS, "a", "b"\n')).toHaveLength(1);
    expect(run('TRYCALL STRLENS("a", "b")\n')).toHaveLength(1);
  });

  it('尾逗号是书写尾巴不是第 N 参（`STRLENS("a",)` = 1 个，不报）', () => {
    expect(run('A = STRLENS("a",)\n')).toEqual([]);
    // 对照：真多给一个就报
    expect(run('A = STRLENS("a", "b")\n')).toHaveLength(1);
  });
});

describe('collectBuiltinArgDiagnostics · 类型', () => {
  it('数式形参收文字列 → error，range 落在该实参', () => {
    const out = run('A = ABS("x")\n');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ line: 1, severity: 'error', code: BUILTIN_ARG_TYPE_CODE });
    expect(out[0]!.message).toContain('第 1 个实参应是数式，实际写的是文字列');
    expect([out[0]!.startColumn, out[0]!.endColumn]).toEqual([9, 12]);
  });

  it('文字列形参收数式 → error', () => {
    const out = run('A = SUBSTRING(123, 0)\n');
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toContain('第 1 个实参应是文字列，实际写的是数式');
  });

  it('已知内建调用的返回值类型可证（嵌套）', () => {
    expect(run('A = ABS(TOSTR(1))\n')).toHaveLength(1); // TOSTR → str 进 int 形参
    expect(run('A = STRLENS(TOUPPER("x"))\n')).toEqual([]); // str → str 正常
    expect(run('A = SUBSTRING(STRLENS("ab"), 0)\n')).toHaveLength(1); // STRLENS → int 进 str 形参
  });

  it('判不出的一律不报：变量 / 成员访问 / 复合表达式', () => {
    expect(run('A = ABS(FLAG:0)\n')).toEqual([]);
    expect(run('A = ABS(A + 1)\n')).toEqual([]);
    expect(run('A = ABS(CFLAG:TARGET:好感度)\n')).toEqual([]);
    expect(run('A = STRLENS(STR:0 + "x")\n')).toEqual([]);
    expect(run('A = ABS((1))\n')).toEqual([]); // 括号分组不猜
  });

  it('可证形态逐个认：串 / @"…" / %…% / {…} / 负号 / TRUE', () => {
    expect(run('A = ABS(%X%)\n')).toHaveLength(1); // FORM 串 ⇒ str
    expect(run('A = STRLENS(@"x")\n')).toEqual([]);
    expect(run('A = ABS({X})\n')).toEqual([]); // 数值插值 ⇒ int
    expect(run('A = ABS(-1)\n')).toEqual([]);
    expect(run('A = ABS(TRUE)\n')).toEqual([]);
    expect(run('A = STRLENS("a" + "b")\n')).toEqual([]); // 串拼接 ⇒ str
  });

  it('var / any 形参不判类型（GETNUM 的族头实参、GROUPMATCH 的任意值）', () => {
    expect(run('A = GETNUM(TALENT, "恋慕")\n')).toEqual([]);
    expect(run('A = GROUPMATCH(1, "x", 2)\n')).toEqual([]);
    expect(run('A = SUMARRAY(FLAG, 0, 100)\n')).toEqual([]);
  });

  it('同一行多个问题各成一条，按列升序', () => {
    const out = run('A = ABS("x") + ABS("y")\n');
    expect(out).toHaveLength(2);
    expect(out[0]!.startColumn!).toBeLessThan(out[1]!.startColumn!);
  });
});

describe('collectBuiltinArgDiagnostics · 安全边界', () => {
  it('非 ERB 方言路径 / 空文本 → []', () => {
    expect(run('A = ABS("x")\n', 'a.kojo')).toEqual([]);
    expect(run('', 'A.ERB')).toEqual([]);
  });

  it('定义行 / 注释 / 字符串 / [SKIPSTART] 区不判', () => {
    expect(run('@FOO\nA = STRLENS("a", "b")\n')[0]!.line).toBe(2);
    expect(run('; STRLENS("a", "b")\n')).toEqual([]);
    expect(run('PRINTL "STRLENS(1,2)"\n')).toEqual([]); // codeView 刷白串体
    expect(run('[SKIPSTART]\nA = STRLENS("a", "b")\n[SKIPEND]\n')).toEqual([]);
  });

  it('同名用户函数（影子）整体让位', () => {
    const isUserFunction = (name: string) => name === 'STRLENS';
    expect(run('A = STRLENS("a", "b")\n', 'A.ERB', isUserFunction)).toEqual([]);
    // 别的名字照常判
    expect(run('A = ABS("x")\n', 'A.ERB', isUserFunction)).toHaveLength(1);
  });

  it('未载明签名的名字（INRANGEARRAY）只认名、不判', () => {
    expect(run('A = INRANGEARRAY(FLAG, 0, 100, 1, 2, 3)\n')).toEqual([]);
  });
});
