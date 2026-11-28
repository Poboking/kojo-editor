/**
 * 内建式中函数签名表与实参诊断（`builtins.ts`）单测——**纯函数**：文本进、波浪线数据出。
 *
 * 钉死四组形状：
 * (a) 表完整性：名字集 = 签名表键集、全大写无重复、规模钉在 eratw 注册表口径；
 * (b) 个数：**双向**——多给 = error（`TooManyFuncArgs` / `ArgsNotNeeded`），
 *     少给 = error（`NotEnoughArgs`，内建函数引擎不补默认值），成对变参组违例 =
 *     `ArgsNotFitExpr`；可变实参族不设上限。文案主体逐字取引擎原话；
 * (c) 类型：只判可证形态（字面量 / FORM / `{…}` / 已知内建返回值），判不出一律不报；
 * (d) 安全边界：非方言路径 / 定义行 / 注释 / 字符串 / `[SKIPSTART]` 区不判；
 *     同名用户函数（影子）整体让位。
 */

import { describe, expect, it } from 'vitest';
import { formatEngineErrorText } from '@kojo/plugin-api';
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

  it('规模钉在 eratw 运行时注册表口径（331 条，全部真实现）', () => {
    // 表体由 tools/gen-erb-builtin-signatures.mjs 从 eratw `Builtins.registry` 的
    // 反射 dump 生成（tools/data/builtin-signatures.tsv）。331 = dump 行数 - 表头。
    expect(BUILTIN_FUNCTION_NAMES.length).toBe(331);
    // 常用面必须在列（补全与诊断的同一张表）
    for (const name of ['STRLENS', 'SUBSTRING', 'ABS', 'MAX', 'RAND', 'GETBIT', 'TOSTR', 'CSVCFLAG', 'GCREATE']) {
      expect(BUILTIN_FUNCTION_NAMES).toContain(name);
    }
    // fork 扩展整族进来（旧手抄表缺的 177 条的代表）
    for (const name of ['DT_CELL_GET', 'MAP_CREATE', 'XML_SET', 'SQL_CONNECT', 'ENTITY_CREATE']) {
      expect(BUILTIN_FUNCTION_NAMES).toContain(name);
    }
    // 旧表的 16 个假内建名必须不在列（两棵反编译树零命中，实为 eraTW 的 @FUNC）
    for (const name of ['SETBIT', 'CLEARBIT', 'INVERTBIT', 'FIRSTTIME', 'CHK_HININ_LOVE', 'SET_KOJOCOLOR']) {
      expect(BUILTIN_FUNCTION_NAMES).not.toContain(name);
    }
  });

  it('签名抽查：必填/可选/可变/成对变参四形各就各位', () => {
    expect(builtinSignatureOf('STRLENS')).toEqual({ ret: 'int', params: [{ type: 'str', optional: false }], variadic: false });
    expect(builtinSignatureOf('SUBSTRING')?.params?.map((p) => p.optional)).toEqual([false, true, true]);
    // MAX 真值 = 1 个固定参数 + 尾部可变（`MAX(5)` 合法；旧表误标 2 个必需）
    expect(builtinSignatureOf('MAX')).toEqual({
      ret: 'int',
      params: [{ type: 'int', optional: false }],
      variadic: true,
    });
    // INRANGEARRAY 真值 = 3 必需 + 2 可选（Wiki 没载明，eratw 有实现）
    expect(builtinSignatureOf('INRANGEARRAY')?.params?.map((p) => p.optional)).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
    // 成对变参组（eratw VariadicGroup）
    expect(builtinSignatureOf('DT_ROW_ADD')?.variadicGroup).toEqual({
      fixedPrefix: 1,
      groupSize: 2,
      exactFormArgs: 4,
      minGroupArgs: 1,
    });
    // 大小写不敏感
    expect(builtinSignatureOf('strlens')).toEqual(builtinSignatureOf('STRLENS'));
    expect(builtinSignatureOf('NOT_A_FUNCTION')).toBeNull();
  });

  it('签名文案：可选 `?` / 可变 `…` / 成对变参给组式', () => {
    expect(builtinSignatureLabel('STRLENS')).toBe('STRLENS(str) → int');
    expect(builtinSignatureLabel('SUBSTRING')).toBe('SUBSTRING(str, int?, int?) → str');
    expect(builtinSignatureLabel('MAX')).toBe('MAX(int, …) → int');
    expect(builtinSignatureLabel('GETTIMES')).toBe('GETTIMES() → str');
    expect(builtinSignatureLabel('DT_ROW_ADD')).toBe('DT_ROW_ADD(any, …) → int');
    expect(builtinSignatureLabel('NOT_A_FUNCTION')).toBeNull();
  });
});

describe('collectBuiltinArgDiagnostics · 个数', () => {
  it('多给 → error，range 覆盖实参区', () => {
    const out = run('A = STRLENS("a", "b")\n');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ line: 1, severity: 'error', code: BUILTIN_ARGS_CODE });
    expect(out[0]!.message).toContain('参数过多——最多 1 个，实际给了 2 个');
    // 实参区 = 首个非空实参起点 .. 末个非空实参终点（`"a", "b"`）
    expect([out[0]!.startColumn, out[0]!.endColumn]).toEqual([13, 21]);
  });

  it('少给 → error（内建函数引擎不补默认值，4.981 报 NotEnoughArgs）', () => {
    // STRLENS(str)：0 参 = 真少给 ⇒ `FunctionMethod.cs:283` 的 NotEnoughArgs
    const zero = run('A = STRLENS()\n');
    expect(zero).toHaveLength(1);
    expect(zero[0]!.message).toContain('至少需要1个参数');
    expect(zero[0]!.code).toBe(BUILTIN_ARGS_CODE);
    // 裸名字（无括号）在 ERB 里是**变量引用**，不是调用 ⇒ 不判
    expect(run('A = STRLENS\n')).toEqual([]);
    // 可选位省着写 = 合法（SUBSTRING 后两位可选）
    expect(run('A = SUBSTRING("abc")\n')).toEqual([]);
  });

  it('零参函数多给一个也报（ArgsNotNeeded 是独立一枚键）', () => {
    const out = run('A = GETTIME(1)\n');
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toContain('不需要参数——实际给了 1 个');
  });

  it('可变实参族（MAX/GROUPMATCH）不设上限；CONVERT 只 2 参不是可变', () => {
    expect(run('A = MAX(1, 2, 3, 4)\n')).toEqual([]);
    expect(run('A = MAX(5)\n')).toEqual([]);
    expect(run('A = GROUPMATCH(1, 2, 3)\n')).toEqual([]);
    // CONVERT(value, radix)：真值 2 参，第 3 个是真多给
    expect(run('A = CONVERT(10, 16)\n')).toEqual([]);
    expect(run('A = CONVERT(10, "x", "y")\n')).toHaveLength(1);
  });

  it('成对变参组：DT_ROW_ADD 按 1+2n 判，exact 形单独放行', () => {
    // 合法：1 参（下界）、3 参、4 参（exact 形）
    expect(run('A = DT_ROW_ADD(0)\n')).toEqual([]);
    expect(run('A = DT_ROW_ADD(0, 1, 2)\n')).toEqual([]);
    expect(run('A = DT_ROW_ADD(0, 1, "a", 2)\n')).toEqual([]);
    // 违例：2 参（(2-1)%2 = 1）
    const bad = run('A = DT_ROW_ADD(0, 1)\n');
    expect(bad).toHaveLength(1);
    expect(bad[0]!.message).toContain('不满足1+2n');
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

  /**
   * 四支文案的**主体**必须逐字等于 `specs/error-texts.yaml` 的原话（经
   * `ERB_ENGINE_ERROR_TEXTS` 按序号替换后），编辑器只许在后面**追加**定位说明。
   *
   * 为什么值得单钉：作者按引擎原话去搜社区/提问才能对上号；kojo 一旦把「参数过多」
   * 改写成「参数个数超了」这类同义词，这条价值就静默消失，而波浪线看起来毫无变化。
   */
  it('文案主体逐字取引擎原话，追加说明在原文之后', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['A = STRLENS("a", "b")\n', formatEngineErrorText('TooManyFuncArgs', ['STRLENS'])!],
      ['A = STRLENS()\n', formatEngineErrorText('NotEnoughArgs', ['STRLENS', 1])!],
      ['A = GETTIME(1)\n', formatEngineErrorText('ArgsNotNeeded', ['GETTIME'])!],
      ['A = DT_ROW_ADD(0, 1)\n', formatEngineErrorText('ArgsNotFitExpr', ['DT_ROW_ADD', 2, 1, 2])!],
    ];
    for (const [src, head] of cases) {
      const out = run(src);
      expect(out, `${src} 应报一条`).toHaveLength(1);
      expect(out[0]!.message.startsWith(head), `文案没以引擎原话开头：${out[0]!.message}`).toBe(true);
      // 追加说明确实跟在原文后面（不是把原文顶掉了）
      expect(out[0]!.message.length).toBeGreaterThan(head.length);
    }
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

  it('表里没有的名字不判（未注册 = 轮不到这一层）', () => {
    // NOT_A_FUNCTION 不在 331 条注册表里 ⇒ 内建腿一条不报（用户函数腿另判）
    expect(run('A = NOT_A_FUNCTION(1, 2, 3)\n')).toEqual([]);
    // 旧表的假内建名已剔出：SETBIT 现在走用户函数腿，内建腿不认它
    expect(builtinSignatureOf('SETBIT')).toBeNull();
    expect(run('A = SETBIT(1, 2, 3, 4, 5)\n')).toEqual([]);
  });
});
