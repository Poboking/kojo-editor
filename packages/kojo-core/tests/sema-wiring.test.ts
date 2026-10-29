/**
 * K2-SEMA-WIRING 验收：语义层（`checkKojoFile`）接进编译主链 + `missing-return` 归属 + 外部变量数组面。
 *
 * 判据（与任务书一一对应）：
 * 1. **主链接线**：`parse` 之后、`lower` 之前跑语义检查，诊断并入同一次编译结果；sema 的 error
 *    与主链 error 同权（`ok:false` + 0 字节 + 空 source map + 空 slots）；
 * 2. **去重口径**：同 `(code, span)` 只留一条（键 = `featureDiagnosticKey`），**主链胜出**——
 *    主链那条的文案带两侧信息/更精确落点；sema 独有的事实全部照报（不静默）；
 * 3. **归属**：`missing-return` 归语义层（只在可证落空时报）；`return-mixed` 在编译链归主链
 *    （落在具体 `@返` 行）；项目层吃到带 `returnFlow` 的事实时只留事实、不双报；
 * 4. **外部变量数组面**：`domainSymbols.variables` 的 `arraySize` / `elementKind`（additive）——
 *    省略 = 标量（旧 adapter 逐字节不变）；`null` = 长度不可静态求值；正整数 = 越界可证；
 * 5. **能力闸不重复**：编译链里落点能力由主链单源（adapter ∧ backend）判，sema 用
 *    `reporting: 'with-lowering'` 让出该类；查询面（standalone）仍按 adapter 声明报。
 *
 * 输入一律是**真 2.0 源码**（`compileKojoSource` / `parseSource`），不手搓 AST。
 */
import { describe, expect, it } from 'vitest';

import type { GameAdapter } from '../src/adapter.js';
import { validateGameAdapter } from '../src/adapter.js';
import { compileKojoSource } from '../src/compile.js';
import type { CompileKojoSourceResult } from '../src/compile.js';
import { createDiagnosticSink } from '../src/diagnostics.js';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '../src/fixture-adapter.js';
import { parseSource } from '../src/parser.js';
import { analyzeProject } from '../src/project/analysis.js';
import type { FunctionReturnFact } from '../src/project/analysis.js';
import { checkKojoFile } from '../src/sema/index.js';

/* ============================== 夹具 ============================== */

/** 程序层能力全开（且 backend 落点同步开，避免双源冲突诊断） */
const ALL_ON = Object.freeze({
  arrays: true,
  while: true,
  goto: true,
  recursion: true,
  foreach: true,
  repeat: true,
});

const CAPABLE_ADAPTER: GameAdapter = { ...FIXTURE_ADAPTER, programFeatures: ALL_ON };
const CAPABLE_BACKEND = {
  ...FIXTURE_BACKEND,
  profile: { ...FIXTURE_BACKEND.profile, programFeatures: ALL_ON },
};

/**
 * 外部变量面（additive 数组面）：在 fixture 的四条标量之外补四条数组，
 * 覆盖「定长 / 长度不可求 / 只读 / elementKind 覆盖」四格。
 */
const ARRAY_ADAPTER: GameAdapter = {
  ...FIXTURE_ADAPTER,
  domainSymbols: {
    ...FIXTURE_ADAPTER.domainSymbols,
    variables: [
      ...(FIXTURE_ADAPTER.domainSymbols.variables ?? []),
      { name: '外部表', valueKind: 'int' as const, arraySize: 3 },
      { name: '外部动态', valueKind: 'int' as const, arraySize: null },
      { name: '外部只读表', valueKind: 'int' as const, arraySize: 2, readonly: true },
      { name: '外部角色表', valueKind: 'int' as const, arraySize: 2, elementKind: 'character' as const },
    ],
  },
};

/** 旧 adapter：`domainSymbols` 里**没有** `variables` 键（不是空数组） */
const LEGACY_ADAPTER: GameAdapter = {
  ...FIXTURE_ADAPTER,
  domainSymbols: {
    pronouns: FIXTURE_ADAPTER.domainSymbols.pronouns,
    attributes: FIXTURE_ADAPTER.domainSymbols.attributes,
    nameFunctions: FIXTURE_ADAPTER.domainSymbols.nameFunctions,
    speakers: FIXTURE_ADAPTER.domainSymbols.speakers,
    unknown: FIXTURE_ADAPTER.domainSymbols.unknown,
  },
};

const HEAD = '# 机 开场';

const source = (lines: readonly string[]): string => lines.join('\n');

const compile = (
  lines: readonly string[] | string,
  adapter: GameAdapter = FIXTURE_ADAPTER,
  backend: typeof FIXTURE_BACKEND = FIXTURE_BACKEND,
): CompileKojoSourceResult =>
  compileKojoSource({
    source: typeof lines === 'string' ? lines : source(lines),
    adapter,
    backend,
  });

const codesOf = (result: CompileKojoSourceResult): string[] =>
  result.diagnostics.map((diagnostic) => String(diagnostic.code));

const countOf = (result: CompileKojoSourceResult, code: string): number =>
  codesOf(result).filter((item) => item === code).length;

/** 查询面（`reporting` 缺省 = standalone）的诊断码 */
const standaloneCodes = (lines: readonly string[], adapter: GameAdapter = FIXTURE_ADAPTER): string[] =>
  checkKojoFile(parseSource(source(lines)), { adapter }).diagnostics.map((diagnostic) => String(diagnostic.code));

describe('接线 · sema 与主链在同一次编译里（不双报、不静默）', () => {
  it('sema 独有的事实进编译结果：未声明名字的赋值（lowering 不报这条）', () => {
    const result = compile([HEAD, '@算', '    未声明 = 1']);

    expect(codesOf(result)).toContain('core/expr/unknown-symbol');
    // lowering 面没有 unknown-symbol 的判定（赋值走原样产物）⇒ 这条只可能来自 sema
    expect(result.diagnostics.filter((item) => item.code === 'core/expr/unknown-symbol')).toHaveLength(1);
  });

  it('sema 的 error 与主链同权：ok=false、0 字节、空 source map、空 slots', () => {
    const result = compile([HEAD, '@算', '    未声明 = 1']);

    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.sourceMap.lineCount).toBe(0);
    expect(result.slots).toEqual([]);
  });

  it('lowering 独有的诊断仍在（表区间重叠：sema 不接这一格）', () => {
    const result = compile([HEAD, '# 对照表 甲 依据 数值', '    0..5 -> "一"', '    3..8 -> "二"', '    否 -> "三"']);

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toEqual(['core/table/overlap']);
  });

  it('同码同 span 只留一条：池空分支（sema 与 lowering 都判同一处）', () => {
    const result = compile([HEAD, '# 池 招呼', '    ? 数值 > 5', '    ? 否', '        > 有']);

    expect(result.ok).toBe(false);
    expect(countOf(result, 'core/pool/empty-branch')).toBe(1);
  });

  it('去重时主链文案胜出（sema 的重复项被抑制，不是删掉主链那条）', () => {
    const result = compile([HEAD, '# 池 招呼', '    ? 数值 > 5', '    ? 否', '        > 有']);
    const kept = result.diagnostics.find((item) => item.code === 'core/pool/empty-branch');

    // 主链（lowering）文案：「有一个空分支（不可打印）」；sema 的文案是「归约不出任何可打印内容」
    expect(kept?.message).toContain('空分支');
    expect(kept?.message).not.toContain('归约不出');
  });

  it('确定性：同一输入两次编译的诊断逐字节相同', () => {
    const lines = [HEAD, '# 池 招呼', '    ? 数值 > 5', '    ? 否', '        > 有', '@算', '    未声明 = 1'];
    expect(JSON.stringify(compile(lines).diagnostics)).toBe(JSON.stringify(compile(lines).diagnostics));
  });

  it('共享 sink：sema 补差项写回 sink，`sink.all` 与返回的诊断同口径（多文件收集器不丢条目）', () => {
    const sink = createDiagnosticSink();
    const text = source([HEAD, '@算', '    未声明 = 1']);
    const result = compileKojoSource({ source: text, adapter: FIXTURE_ADAPTER, backend: FIXTURE_BACKEND, sink });

    expect(result.diagnostics.map((item) => String(item.code))).toEqual(['core/expr/unknown-symbol']);
    expect(sink.all.map((item) => String(item.code))).toEqual(['core/expr/unknown-symbol']);
  });
});

describe('归属 · return-mixed 归主链、missing-return 归 sema', () => {
  const MIXED = [HEAD, '@函 取值()', '    ? 数值 > 5', '        @返 1', '    ? 否', '        @返'];
  const MISSING = [HEAD, '@函 取值()', '    ? 数值 > 5', '        @返 1'];

  it('`@返` 混用在编译链里只报一次', () => {
    const result = compile(MIXED);
    expect(countOf(result, 'core/func/return-mixed')).toBe(1);
  });

  it('混用诊断落在主链更精确的 `@返` 行（不是函数声明行）', () => {
    const result = compile(MIXED);
    const mixed = result.diagnostics.find((item) => item.code === 'core/func/return-mixed');
    // 第 6 行是后出现的那条无值 `@返`（sema 的落点是第 2 行的函数声明）
    expect(mixed?.span?.start.line).toBe(6);
  });

  it('查询面仍报 `@返` 混用（standalone 口径不因接线而退化）', () => {
    expect(standaloneCodes(MIXED)).toContain('core/func/return-mixed');
  });

  it('missing-return 只在编译期报一次（主链不报这条）', () => {
    const result = compile(MISSING);
    expect(countOf(result, 'core/func/missing-return')).toBe(1);
    expect(result.ok).toBe(false);
  });

  it('所有可达路径都以 `@返` 结束 ⇒ 不报 missing-return', () => {
    const result = compile([HEAD, '@函 取值()', '    ? 数值 > 5', '        @返 1', '    ? 否', '        @返 2']);
    expect(codesOf(result)).not.toContain('core/func/missing-return');
  });

  it('路径证不出（循环）⇒ 不报 missing-return（宁可漏报不误伤）', () => {
    const result = compile([HEAD, '@函 取值()', '    @循 数值 > 0', '        @返 1'], CAPABLE_ADAPTER, CAPABLE_BACKEND);
    expect(codesOf(result)).not.toContain('core/func/missing-return');
  });
});

describe('能力闸 · 编译链单源，sema 不重复喊', () => {
  const WHILE = [HEAD, '@循 数值 < 3', '    > 一行'];

  it('adapter 关 / backend 开：只报主链那一条声明面冲突（没有 use-site 的重复条目）', () => {
    const adapter: GameAdapter = { ...FIXTURE_ADAPTER, programFeatures: { ...ALL_ON, while: false } };
    const result = compile(WHILE, adapter, CAPABLE_BACKEND);

    expect(countOf(result, 'core/control/unsupported')).toBe(1);
    const only = result.diagnostics.find((item) => item.code === 'core/control/unsupported');
    expect(only?.span).toBeNull();
    expect(only?.message).toContain('后端能落但 adapter 未声明');
  });

  it('两侧一致（都关）：主链照常报"未开启"，sema 不额外加一条', () => {
    const result = compile(WHILE);
    expect(countOf(result, 'core/control/unsupported')).toBe(1);
  });

  it('查询面（standalone）仍按 adapter 声明报，落点是 use-site', () => {
    const diagnostics = checkKojoFile(parseSource(source(WHILE)), { adapter: FIXTURE_ADAPTER }).diagnostics;
    const gate = diagnostics.find((item) => item.code === 'core/control/unsupported');

    expect(gate).toBeDefined();
    expect(gate?.span).not.toBeNull();
  });
});

describe('外部变量数组面（additive）', () => {
  const elem = (text: string): string[] => [HEAD, '@算', `    ${text}`];

  it('常量下标越界（写）⇒ core/expr/index-out-of-range，零字节', () => {
    const result = compile(elem('外部表[3] = 1'), ARRAY_ADAPTER);

    expect(codesOf(result)).toEqual(['core/expr/index-out-of-range']);
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
  });

  it('表达式里的常量下标越界（读）也认外部数组', () => {
    const result = compile([HEAD, '> 读到 {外部表[5]} 了。'], ARRAY_ADAPTER);

    expect(codesOf(result)).toEqual(['core/expr/index-out-of-range']);
  });

  it('负下标 ⇒ index-out-of-range', () => {
    expect(codesOf(compile(elem('外部表[-1] = 1'), ARRAY_ADAPTER))).toEqual(['core/expr/index-out-of-range']);
  });

  it('界内常量下标不报（不误伤）', () => {
    const result = compile(elem('外部表[2] = 1'), ARRAY_ADAPTER);

    expect(codesOf(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('动态下标不判越界（§9.2：不做自动边界检查）', () => {
    const result = compile([HEAD, '# 设 计数 整数', '@算', '    外部表[计数] = 1'], ARRAY_ADAPTER);

    expect(codesOf(result)).not.toContain('core/expr/index-out-of-range');
    expect(result.ok).toBe(true);
  });

  it('`arraySize: null` = 是数组但长度不可静态求值 ⇒ 认下标、不判越界', () => {
    const result = compile(elem('外部动态[9] = 1'), ARRAY_ADAPTER);

    expect(codesOf(result)).toEqual([]);
  });

  it('外部数组的 `.长度` 只读 ⇒ core/expr/readonly-target', () => {
    expect(codesOf(compile(elem('外部表.长度 = 1'), ARRAY_ADAPTER))).toEqual(['core/expr/readonly-target']);
  });

  it('只读外部数组写元素 ⇒ core/expr/readonly-target', () => {
    expect(codesOf(compile(elem('外部只读表[0] = 1'), ARRAY_ADAPTER))).toEqual(['core/expr/readonly-target']);
  });

  it('elementKind 覆盖 valueKind（int 落到 character 元素 ⇒ 不做隐式转换）', () => {
    const result = compile(elem('外部角色表[0] = 1'), ARRAY_ADAPTER);

    expect(codesOf(result)).toEqual(['core/expr/type-mismatch']);
    expect(result.diagnostics[0]!.message).toContain('角色号');
  });

  it('外部数组整名赋值不收（形状问题，任何值都不行）', () => {
    const result = compile(elem('外部表 = 1'), ARRAY_ADAPTER);

    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.diagnostics.map((item) => item.severity)).toEqual(['error']);
  });

  it('外部变量是标量（省略 arraySize）⇒ 下标报 bad-index（不是"未声明的数组"）', () => {
    expect(codesOf(compile(elem('外部计数[0] = 1')))).toEqual(['core/expr/bad-index']);
  });

  it('旧 adapter（没有 variables 面）⇒ 下标仍按未声明报（逐字节不变）', () => {
    expect(codesOf(compile(elem('某表[0] = 1'), LEGACY_ADAPTER))).toEqual(['core/expr/unknown-symbol']);
  });
});

describe('外部变量数组面 · adapter 自检', () => {
  const withVariables = (variables: readonly unknown[]): GameAdapter => ({
    ...LEGACY_ADAPTER,
    domainSymbols: { ...LEGACY_ADAPTER.domainSymbols, variables: variables as never },
  });

  it('arraySize 必须是正整数或 null（0 / 负数 / 小数都拒）', () => {
    for (const bad of [0, -1, 1.5]) {
      const codes = validateGameAdapter(withVariables([{ name: '外部表', valueKind: 'int', arraySize: bad }])).map(
        (item) => String(item.code),
      );
      expect([bad, codes.includes('unit/adapter-incomplete')]).toEqual([bad, true]);
    }
  });

  it('标量给了 elementKind = 契约矛盾（unit/adapter-inconsistent）', () => {
    const codes = validateGameAdapter(
      withVariables([{ name: '外部表', valueKind: 'int', elementKind: 'string' }]),
    ).map((item) => String(item.code));

    expect(codes).toContain('unit/adapter-inconsistent');
  });

  it('合法的数组面（定长 / null / elementKind）零诊断', () => {
    const adapter = withVariables([
      { name: '外部表', valueKind: 'int', arraySize: 3 },
      { name: '外部动态', valueKind: 'int', arraySize: null },
      { name: '外部角色表', valueKind: 'int', arraySize: 2, elementKind: 'character' },
    ]);

    expect(validateGameAdapter(adapter)).toEqual([]);
  });
});

describe('归属 · 项目层与编译链不双报', () => {
  const MISSING = [HEAD, '@函 取值()', '    ? 数值 > 5', '        @返 1'];
  const MIXED = [HEAD, '@函 取值()', '    ? 数值 > 5', '        @返 1', '    ? 否', '        @返'];

  /** 语义层符号事实 → 项目层事实（装配层该做的映射；`allPathsReturn` = flow === 'returns'） */
  const factOf = (lines: readonly string[], name: string): FunctionReturnFact => {
    const symbols = checkKojoFile(parseSource(source(lines)), { adapter: FIXTURE_ADAPTER }).symbols;
    const fn = symbols.functions.find((item) => item.name === name);
    if (fn === undefined) throw new Error(`符号事实里没有函数 ${name}`);
    return {
      name: fn.name,
      filePath: 'fixture.kojo2',
      span: fn.span,
      hasValueReturn: fn.hasValueReturn,
      hasBareReturn: fn.hasBareReturn,
      allPathsReturn: fn.returnFlow === 'returns',
      returnFlow: fn.returnFlow,
    };
  };

  it('可证落空：项目层只留事实（missingReturn=true），不再报第二条 missing-return', () => {
    const project = analyzeProject({ returns: [factOf(MISSING, '取值')] });

    expect(project.diagnostics.filter((item) => item.code === 'core/func/missing-return')).toEqual([]);
    expect(project.functionReturns[0]?.missingReturn).toBe(true);
  });

  it('混用：项目层同样不重复（编译链已报过）', () => {
    const project = analyzeProject({ returns: [factOf(MIXED, '取值')] });

    expect(project.diagnostics.filter((item) => item.code === 'core/func/return-mixed')).toEqual([]);
    expect(project.functionReturns[0]?.mixed).toBe(true);
  });

  it('旧事实（没有 returnFlow）仍按 allPathsReturn 报 missing-return（向后兼容）', () => {
    const legacy: FunctionReturnFact = {
      name: '取值',
      filePath: 'fixture.kojo2',
      span: { start: { line: 2, column: 1 }, end: { line: 4, column: 13 } },
      hasValueReturn: true,
      hasBareReturn: false,
      allPathsReturn: false,
    };
    const project = analyzeProject({ returns: [legacy] });

    expect(project.diagnostics.map((item) => String(item.code))).toEqual(['core/func/missing-return']);
    expect(project.functionReturns[0]?.missingReturn).toBe(true);
  });

  it('证不出（unproven）的语义事实在项目层也不再"宁可多报"', () => {
    const fact = factOf([HEAD, '@函 取值()', '    @循 数值 > 0', '        @返 1'], '取值');
    // 该事实的 returnFlow 是 unproven（循环让路径证不出）
    expect(fact.returnFlow).toBe('unproven');
    // 循环需要能力开启才不产生额外能力闸诊断（这里只关心返回路径）
    const project = analyzeProject({ returns: [fact] });
    expect(project.diagnostics.filter((item) => item.code === 'core/func/missing-return')).toEqual([]);
    expect(project.functionReturns[0]?.missingReturn).toBe(false);
  });
});
