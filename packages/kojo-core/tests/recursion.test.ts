/**
 * `@函` 递归 / 返回路径 / 控制转移清理静态分析的单测（K2-PROGRAM-RECURSION）。
 *
 * 断言面全是**契约事实**（不是产物字节）：
 * - 返回种类一致性：混用恰一条 `core/func/return-mixed`；
 * - 非 void 路径：只在"直线 + `?` 链全返"时证明；证不出 = `unprovenReturns`（**不报错**）；
 * - 互递归：SCC → `RecursionCycleFact`（自环 / 多节点环），合法不报错；
 * - 能力闸：`programFeatures.recursion` 关闭 → 既有 error（统一闸 `checkFeature`），环事实仍保留；
 * - 深度：非递归可证（最长无环链），递归/可达环 = null（不猜假数）；
 * - 控制转移：`@断`/`@续` 循环外的 error 由 lowering/parser 报，本模块**不重复报**；
 *   只产"循环跳转离开 `@着色` 块"的事实 `colorLeaks`；
 * - 确定性：两次分析逐字节相同。
 */
import { describe, expect, it } from 'vitest';

import { createDiagnosticSink } from '../src/diagnostics.js';
import type { GameAdapter, ProgramFeatures } from '../src/adapter.js';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '../src/fixture-adapter.js';
import type { KojoEmitBackend } from '../src/lower/backend.js';
import { createExpandContext } from '../src/lower/expand/context.js';
import type { FunctionFact, RecursionAnalysis } from '../src/lower/expand/recursion.js';
import { analyzeFunctions } from '../src/lower/expand/recursion.js';
import { parseSource } from '../src/parser.js';

/* ============================== 夹具 ============================== */

const ALL_PROGRAM_FEATURES: ProgramFeatures = {
  arrays: true,
  while: true,
  goto: true,
  recursion: true,
  foreach: true,
  repeat: true,
};

function adapterWith(recursion: boolean): GameAdapter {
  return {
    ...FIXTURE_ADAPTER,
    profile: { ...FIXTURE_ADAPTER.profile, features: ['program'] },
    programFeatures: { ...ALL_PROGRAM_FEATURES, recursion },
  };
}

function backendWith(recursion: boolean): KojoEmitBackend {
  return {
    ...FIXTURE_BACKEND,
    profile: { ...FIXTURE_BACKEND.profile, programFeatures: { ...ALL_PROGRAM_FEATURES, recursion } },
  };
}

/** 源码 → 分析结果（fixture adapter/backend；能力闸两侧一致，不制造冲突） */
function analyze(source: string, options: { readonly recursion?: boolean } = {}): RecursionAnalysis {
  const recursion = options.recursion ?? true;
  const file = parseSource(source);
  const ctx = createExpandContext({
    adapter: adapterWith(recursion),
    backend: backendWith(recursion),
    sourceText: source,
    sink: createDiagnosticSink(),
    view: null,
  });
  return analyzeFunctions(file, ctx);
}

function functionNamed(result: RecursionAnalysis, name: string): FunctionFact {
  const fact = result.functions.find((item) => item.name === name);
  if (fact === undefined) throw new Error(`分析结果里没有函数「${name}」`);
  return fact;
}

/** 源码里第 N 次包含 needle 的行号（1 基；找不到 = -1） */
function lineOf(source: string, needle: string, occurrence = 1): number {
  const lines = source.split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes(needle)) continue;
    seen++;
    if (seen === occurrence) return i + 1;
  }
  return -1;
}

const join = (...lines: string[]): string => lines.join('\n');

/* ============================== 返回种类 / 路径 ============================== */

describe('返回种类与保守的路径证明', () => {
  it('直线函数以带值 @返 收尾：value、路径可证、无诊断', () => {
    const src = join('@函 加一(n)', '    @返 n + 1');
    const result = analyze(src);
    const fn = functionNamed(result, '加一');
    expect(result.diagnostics).toEqual([]);
    expect(fn.params).toEqual(['n']);
    expect(fn.returnKind).toBe('value');
    expect(fn.hasValueReturn).toBe(true);
    expect(fn.hasBareReturn).toBe(false);
    expect(fn.allPathsReturn).toBe(true);
    expect(fn.unprovenReturns).toBe(false);
    expect(fn.returnPoints).toHaveLength(1);
    expect(fn.returnPoints[0]?.hasValue).toBe(true);
  });

  it('无值 @返：void、不算未证明', () => {
    const src = join('@函 播报(n)', '    > 第 n 次', '    @返');
    const result = analyze(src);
    const fn = functionNamed(result, '播报');
    expect(result.diagnostics).toEqual([]);
    expect(fn.returnKind).toBe('void');
    expect(fn.hasBareReturn).toBe(true);
    expect(fn.hasValueReturn).toBe(false);
    expect(fn.unprovenReturns).toBe(false);
  });

  it('空函数体：void、路径证不出、无诊断', () => {
    const result = analyze('@函 空()');
    const fn = functionNamed(result, '空');
    expect(fn.returnKind).toBe('void');
    expect(fn.returnPoints).toEqual([]);
    expect(fn.allPathsReturn).toBe(false);
    expect(fn.unprovenReturns).toBe(false);
    expect(result.diagnostics).toEqual([]);
  });

  it('同一函数 @返 与 @返 表达式 混用：恰一条 return-mixed，落在后出现的那条', () => {
    const src = join('@函 取值(n)', '    ? n > 0', '        @返 n', '    ? 否', '        @返');
    const result = analyze(src);
    expect(result.diagnostics).toHaveLength(1);
    const diagnostic = result.diagnostics[0]!;
    expect(diagnostic.code).toBe('core/func/return-mixed');
    expect(diagnostic.severity).toBe('error');
    expect(diagnostic.span?.start.line).toBe(lineOf(src, '@返', 2));
    const fn = functionNamed(result, '取值');
    expect(fn.returnKind).toBe('mixed');
    // 混用已经报错，不再叠一条"未证明"
    expect(fn.unprovenReturns).toBe(false);
  });

  it('? 链带 否 且每条分支都 @返：路径可证', () => {
    const src = join('@函 取值(n)', '    ? n > 0', '        @返 n', '    ? 否', '        @返 0');
    const result = analyze(src);
    const fn = functionNamed(result, '取值');
    expect(result.diagnostics).toEqual([]);
    expect(fn.allPathsReturn).toBe(true);
    expect(fn.unprovenReturns).toBe(false);
  });

  it('? 链缺 否（分支里只有部分返回）：unproven、不报错', () => {
    const src = join('@函 取值(n)', '    ? n > 0', '        @返 n');
    const result = analyze(src);
    const fn = functionNamed(result, '取值');
    expect(result.diagnostics).toEqual([]);
    expect(fn.returnKind).toBe('value');
    expect(fn.allPathsReturn).toBe(false);
    expect(fn.unprovenReturns).toBe(true);
  });

  it('? 链每条分支都返回但缺 否：仍判未证明（保守，不猜覆盖性）', () => {
    const src = join('@函 取值(n)', '    ? n > 0', '        @返 1', '    ? n < 0', '        @返 -1');
    const result = analyze(src);
    const fn = functionNamed(result, '取值');
    expect(result.diagnostics).toEqual([]);
    expect(fn.allPathsReturn).toBe(false);
    expect(fn.unprovenReturns).toBe(true);
  });

  it('分支部分返回 + 链后统一 @返：所有出口可证', () => {
    const src = join('@函 取值(n)', '    ? n > 0', '        @返 n', '    @返 0');
    const result = analyze(src);
    const fn = functionNamed(result, '取值');
    expect(fn.allPathsReturn).toBe(true);
    expect(fn.unprovenReturns).toBe(false);
  });

  it('循环里的 @返 记为返回点，但含循环 = 路径不可证（不报错）', () => {
    const src = join('@函 找(n)', '    @循 n > 0', '        @返 n');
    const result = analyze(src);
    const fn = functionNamed(result, '找');
    expect(result.diagnostics).toEqual([]);
    expect(fn.hasValueReturn).toBe(true);
    expect(fn.allPathsReturn).toBe(false);
    expect(fn.unprovenReturns).toBe(true);
  });

  it('含 @断 的函数不因"未证明"报错（控制转移屏障）', () => {
    const src = join('@函 提前(n)', '    ? n > 0', '        @返 n', '    @断');
    const result = analyze(src);
    const fn = functionNamed(result, '提前');
    expect(result.diagnostics).toEqual([]);
    expect(fn.allPathsReturn).toBe(false);
    expect(fn.unprovenReturns).toBe(true);
  });
});

/* ============================== 递归环 ============================== */

describe('自递归 / 互递归环', () => {
  it('自递归：一条 self 环事实，span 指向递归调用，无 error', () => {
    const src = join('@函 阶乘(n)', '    ? n <= 1', '        @返 1', '    ? 否', '        @返 n * 阶乘(n - 1)');
    const result = analyze(src);
    expect(result.diagnostics).toEqual([]);
    const fn = functionNamed(result, '阶乘');
    expect(fn.recursionKind).toBe('self');
    expect(fn.maxDepthHint).toBeNull();
    expect(result.cycles).toHaveLength(1);
    const cycle = result.cycles[0]!;
    expect(cycle.kind).toBe('self');
    expect([...cycle.cycle]).toEqual(['阶乘']);
    expect([...cycle.members]).toEqual(['阶乘']);
    expect(cycle.span.start.line).toBe(lineOf(src, '@返 n * 阶乘(n - 1)'));
  });

  it('互递归：一个 mutual 环事实，成员按码元序，两个函数都标 mutual', () => {
    const src = join(
      '@函 甲(n)',
      '    ? n <= 0',
      '        @返 0',
      '    ? 否',
      '        @返 乙(n - 1)',
      '@函 乙(n)',
      '    ? n <= 0',
      '        @返 1',
      '    ? 否',
      '        @返 甲(n - 1)',
    );
    const result = analyze(src);
    expect(result.diagnostics).toEqual([]);
    expect(result.cycles).toHaveLength(1);
    const cycle = result.cycles[0]!;
    expect(cycle.kind).toBe('mutual');
    expect([...cycle.members]).toEqual(['乙', '甲']);
    expect([...cycle.cycle]).toEqual(['乙', '甲']);
    expect(cycle.span.start.line).toBe(lineOf(src, '@返 甲(n - 1)'));
    expect(functionNamed(result, '甲').recursionKind).toBe('mutual');
    expect(functionNamed(result, '乙').recursionKind).toBe('mutual');
    expect(functionNamed(result, '甲').maxDepthHint).toBeNull();
  });

  it('三节点环：环路径按跳转顺序，深度不可证', () => {
    const src = join('@函 a(n)', '    @返 b(n)', '@函 b(n)', '    @返 c(n)', '@函 c(n)', '    @返 a(n)');
    const result = analyze(src);
    expect(result.cycles).toHaveLength(1);
    const cycle = result.cycles[0]!;
    expect(cycle.kind).toBe('mutual');
    expect([...cycle.cycle]).toEqual(['a', 'b', 'c']);
    expect([...cycle.members]).toEqual(['a', 'b', 'c']);
    for (const name of ['a', 'b', 'c']) {
      expect(functionNamed(result, name).maxDepthHint).toBeNull();
    }
  });

  it('递归调用写在 ! f(...) 语句里也能识别自递归', () => {
    const src = join('@函 f(n)', '    ? n <= 0', '        @返 0', '    ? 否', '        ! f(n - 1)', '        @返 0');
    const result = analyze(src);
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]?.kind).toBe('self');
    expect(result.cycles[0]?.cycle).toEqual(['f']);
    expect(functionNamed(result, 'f').recursionKind).toBe('self');
  });

  it('字符串字面量里的 名字( 不算调用（防误报环）', () => {
    const src = join('@函 叶子()', '    @返 1', '@函 引用()', '    @返 "叶子(1)"');
    const result = analyze(src);
    expect(result.cycles).toEqual([]);
    const fn = functionNamed(result, '引用');
    expect(fn.callSites).toEqual([]);
    expect(fn.maxDepthHint).toBe(1);
  });

  it('字符串插值里的调用算真实调用（进入函数图）', () => {
    const src = join('@函 叶子()', '    @返 1', '@函 引用()', '    @返 "共{叶子(1)}次"');
    const result = analyze(src);
    const fn = functionNamed(result, '引用');
    expect(fn.callSites.map((site) => site.callee)).toEqual(['叶子']);
    expect(fn.callSites[0]?.resolved).toBe(true);
    expect(fn.maxDepthHint).toBe(2);
  });
});

/* ============================== 深度上界 ============================== */

describe('maxDepthHint（静态调用栈上界）', () => {
  it('无环调用链：叶子 1 / 中间 2 / 顶层 3', () => {
    const src = join('@函 底()', '    @返 1', '@函 中()', '    @返 底() + 1', '@函 顶()', '    @返 中() + 1');
    const result = analyze(src);
    expect(result.cycles).toEqual([]);
    expect(functionNamed(result, '底').maxDepthHint).toBe(1);
    expect(functionNamed(result, '中').maxDepthHint).toBe(2);
    expect(functionNamed(result, '顶').maxDepthHint).toBe(3);
    expect(functionNamed(result, '顶').recursionKind).toBe('none');
  });

  it('调用进入递归环的（非环内）函数同样不可证上界', () => {
    const src = join('@函 环(n)', '    @返 环(n - 1)', '@函 入口(n)', '    @返 环(n)');
    const result = analyze(src);
    expect(result.cycles).toHaveLength(1);
    expect(functionNamed(result, '入口').recursionKind).toBe('none');
    expect(functionNamed(result, '入口').maxDepthHint).toBeNull();
  });
});

/* ============================== 能力闸 ============================== */

describe('recursion 能力闸（统一闸 checkFeature）', () => {
  it('feature 关闭 + 自递归：既有 error，环事实仍保留', () => {
    const src = join('@函 阶乘(n)', '    @返 阶乘(n - 1)');
    const result = analyze(src, { recursion: false });
    expect(result.recursionEnabled).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    const diagnostic = result.diagnostics[0]!;
    expect(diagnostic.severity).toBe('error');
    // 统一闸（feature-gate.ts）对 recursion 的既有码：core/func/recursion-unsupported（§11.3）
    expect(String(diagnostic.code)).toBe('core/func/recursion-unsupported');
    expect(diagnostic.span?.start.line).toBe(lineOf(src, '阶乘(n - 1)'));
    // 事实不因闸关闭而消失（UI 仍要显示环）
    expect(result.cycles).toHaveLength(1);
    expect(functionNamed(result, '阶乘').recursionKind).toBe('self');
  });

  it('feature 关闭但没有递归：不报错（能力未被使用）', () => {
    const result = analyze('@函 加一(n)\n    @返 n + 1', { recursion: false });
    expect(result.recursionEnabled).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(result.cycles).toEqual([]);
  });

  it('双源冲突（adapter 开 / backend 关）：闸值关闭、环事实保留，本模块不重复报', () => {
    const src = join('@函 阶乘(n)', '    @返 阶乘(n - 1)');
    const file = parseSource(src);
    const ctx = createExpandContext({
      adapter: adapterWith(true),
      backend: backendWith(false),
      sourceText: src,
      sink: createDiagnosticSink(),
      view: null,
    });
    const result = analyzeFunctions(file, ctx);
    expect(result.recursionEnabled).toBe(false);
    expect(result.cycles).toHaveLength(1);
    // 冲突诊断由编译入口报一次（checkFeature 对冲突键返回 diagnostic: null）
    expect(result.diagnostics).toEqual([]);
  });
});

/* ============================== 控制转移清理事实 ============================== */

describe('colorLeaks：循环跳转离开 @着色 块的事实', () => {
  it('循环外的 @断：本模块不重复报（既有 lowering/parser 的 error 不在这里）', () => {
    const src = join('@函 提前(n)', '    @断', '    @返 n');
    const file = parseSource(src);
    expect(file.diagnostics.some((diagnostic) => diagnostic.code === 'core/control/break-outside')).toBe(true);
    const result = analyze(src);
    expect(result.diagnostics).toEqual([]);
    expect(result.colorLeaks).toEqual([]);
  });

  it('着色块在循环内 + 块内 @断：一条 break 泄漏事实（循环在着色块外）', () => {
    const src = join('@函 处理()', '    @巡 队伍', '        @着色 0xFF8080', '            > 文本', '            @断');
    const result = analyze(src);
    expect(result.diagnostics).toEqual([]);
    expect(result.colorLeaks).toHaveLength(1);
    const leak = result.colorLeaks[0]!;
    expect(leak.unitKind).toBe('function');
    expect(leak.unitName).toBe('处理');
    expect(leak.transfer).toBe('break');
    expect(leak.span.start.line).toBe(lineOf(src, '@断'));
    expect(leak.colorSpan.start.line).toBe(lineOf(src, '@着色'));
    expect(leak.loopSpan.start.line).toBe(lineOf(src, '@巡'));
    expect(leak.loopsOutsideColor).toBe(1);
  });

  it('循环在着色块内 + 循环里 @断：不离开着色块，不建事实', () => {
    const src = join('@函 处理()', '    @着色 0xFF8080', '        > 文本', '        @复 2', '            @断');
    const result = analyze(src);
    expect(result.colorLeaks).toEqual([]);
  });

  it('场景体里的 着色 + @续：unitKind = scene，隐式场景标题为 null', () => {
    const src = join('# 机 开场', '@巡 队伍', '    @着色 0xFF8080', '        > 文本', '        @续');
    const result = analyze(src);
    expect(result.colorLeaks).toHaveLength(1);
    const leak = result.colorLeaks[0]!;
    expect(leak.unitKind).toBe('scene');
    expect(leak.unitName).toBeNull();
    expect(leak.transfer).toBe('continue');
    expect(leak.loopsOutsideColor).toBe(1);
  });

  it('@织 监听体里的 着色 + @断：unitKind = weave、unitName = 事件名', () => {
    const src = join('# 机 开场', '@织 开场', '    @巡 队伍', '        @着色 0xFF8080', '            > 文本', '            @断');
    const result = analyze(src);
    expect(result.colorLeaks).toHaveLength(1);
    const leak = result.colorLeaks[0]!;
    expect(leak.unitKind).toBe('weave');
    expect(leak.unitName).toBe('开场');
    expect(leak.transfer).toBe('break');
  });

  it('多条泄漏按源区间排序（break 在前，continue 在后）', () => {
    const src = join(
      '@函 双跳()',
      '    @巡 队伍',
      '        @着色 0xFF8080',
      '            > 一',
      '            @断',
      '    @巡 队伍',
      '        @着色 0x00FF00',
      '            > 二',
      '            @续',
    );
    const result = analyze(src);
    expect(result.colorLeaks.map((leak) => leak.transfer)).toEqual(['break', 'continue']);
    expect(result.colorLeaks[0]!.span.start.line).toBeLessThan(result.colorLeaks[1]!.span.start.line);
  });
});

/* ============================== 调用点 / 参数 / 确定性 ============================== */

describe('调用点与参数事实', () => {
  it('调用点区分已声明 @函 与未解析名字', () => {
    const src = join('@函 底()', '    @返 1', '@函 主()', '    ! 底()', '    ! 外部函数()', '    @返 0');
    const result = analyze(src);
    const fn = functionNamed(result, '主');
    expect(fn.callSites.map((site) => [site.callee, site.resolved])).toEqual([
      ['底', true],
      ['外部函数', false],
    ]);
    expect(result.cycles).toEqual([]);
    expect(fn.maxDepthHint).toBe(2);
  });

  it('参数按声明序（默认值不影响名字顺序）', () => {
    const result = analyze('@函 组合(a, b = 1)\n    @返 a + b');
    expect(functionNamed(result, '组合').params).toEqual(['a', 'b']);
  });

  it('确定性：同一份源码两次分析逐字节相等', () => {
    const src = join(
      '@函 甲(n)',
      '    ? n <= 0',
      '        @返 0',
      '    ? 否',
      '        @返 乙(n - 1)',
      '@函 乙(n)',
      '    ? n <= 0',
      '        @返',
      '    ? 否',
      '        @返 甲(n - 1)',
      '@函 处理()',
      '    @巡 队伍',
      '        @着色 0xFF8080',
      '            > 文本',
      '            @断',
    );
    const first = analyze(src, { recursion: false });
    const second = analyze(src, { recursion: false });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.diagnostics.length).toBeGreaterThan(0);
    expect(first.colorLeaks).toHaveLength(1);
  });
});
