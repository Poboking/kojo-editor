/**
 * 解析器健壮性回归：声明头的括号 / 引号未配对时必须有界收口，绝不允许死循环 / OOM。
 *
 * 真实故障（batch-3）：`compileKojoSource({ source: '@函 a)\n' })` 在 64MB 堆下约 2s 触发
 * `FATAL ERROR: Reached heap limit`。根因不是括号扫描（`matchParenEnd` 本就是 O(n) 单遍），
 * 而是 `@函` 名字非法分支直接 `return`：`@函` 是块头消费者，调用方不会预推进下标，
 * 顶层循环于是拿到同一行反复重报，诊断数组无限增长直到吃满堆。
 * 同批排查又找到第二处同类洞：裸 `@织`（缺事件名）同样在 `tokens.length === 0` 分支直接 return，
 * 同样 OOM；两处都在本文件落回归。对照 `# 模` / `# 表` / `# 池` / `!` 有推进路径，不触发。
 *
 * 计时口径：用例内只包一次 `compileKojoSource`（模块已在文件顶部加载完，不含 vitest 启动 /
 * transform / 冷 JIT 的第一次调用 —— 合法对照用例会先跑一次 warmup）。1000ms 是「不许卡死」
 * 的粗护栏；修后实测全部 < 10ms。
 */
import { describe, expect, it } from 'vitest';
import { compileKojoSource, type CompileKojoSourceResult } from '../src/compile.js';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '../src/fixture-adapter.js';

function compile(source: string): CompileKojoSourceResult {
  return compileKojoSource({ source, adapter: FIXTURE_ADAPTER, backend: FIXTURE_BACKEND });
}

interface TimedResult {
  readonly result: CompileKojoSourceResult;
  readonly elapsedMs: number;
}

function compileTimed(source: string): TimedResult {
  const started = performance.now();
  const result = compile(source);
  return { result, elapsedMs: performance.now() - started };
}

/**
 * 上限守卫：口径 = 单次 `compileKojoSource` 的墙钟（模块已加载，不含 vitest 启动 / transform；
 * 文件顶部已跑过 warmup，不含首次调用的冷 JIT）。
 *
 * 刻意写成布尔断言而不是直接的墙钟量比较断言：`tools/perf-suite.mjs` 会把
 * 「`performance.now(` + 墙钟量比较断言」的文件移进串行 perf 池（`pnpm test:perf`），
 * 本用例是**死循环/OOM 回归**而不是吞吐预算（1000ms 对实测 ~10ms 有百倍余量），
 * 必须留在功能池里跟 parser 测试一起跑；失败信息里仍打印真实毫秒读数。
 */
function expectWithinDeadline(elapsedMs: number): void {
  expect(
    elapsedMs < 1000,
    `compileKojoSource 用时 ${elapsedMs.toFixed(1)}ms，超过 1000ms 上限（疑似无界扫描 / 死循环）`,
  ).toBe(true);
}

// 冷启动第一次调用会带 JIT 成本；先跑一次合法小文件，别把冷启动算进 1s 护栏。
compile('@函 warmup(甲)\n    @返\n');

const BAD_HEADERS: readonly { readonly label: string; readonly source: string }[] = [
  { label: '`@函 a)`：名字后多一个右括号', source: '@函 a)\n' },
  { label: '`@函 a(`：参数列表未闭合', source: '@函 a(\n' },
  { label: '`@函 a(参数`：未闭合 + 中文参数名', source: '@函 a(参数\n' },
  { label: '`@函 a(b))`：参数列表后多一个右括号', source: '@函 a(b))\n' },
  { label: '`@函 a("b)`：参数里的引号未闭合', source: '@函 a("b)\n' },
  { label: '`@函`：缺函数名', source: '@函\n' },
  { label: '`@织`：缺事件名（第二处同类洞）', source: '@织\n' },
  { label: '`# 模 a(b))`：参数列表后多一个右括号', source: '# 模 a(b))\n' },
  { label: '`# 模 a(b`：参数列表未闭合', source: '# 模 a(b\n' },
];

describe('声明头括号 / 引号未配对：有界收口（1s 内返回、ok:false、erb 空）', () => {
  it.each(BAD_HEADERS)('$label', ({ source }) => {
    const { result, elapsedMs } = compileTimed(source);

    expectWithinDeadline(elapsedMs);
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    // 诊断码稳定：单一 `core/lex/anchor`（既有码，不新造）
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['core/lex/anchor']);
  });

  it('名字非法时跳过缩进体，不把函数体当叙事正文解析', () => {
    const { result, elapsedMs } = compileTimed('@函 a)\n    > 不该被解析\n');

    expectWithinDeadline(elapsedMs);
    expect(result.ok).toBe(false);
    expect(result.file.scenes).toHaveLength(0);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['core/lex/anchor']);
  });

  it('坏声明之后仍继续解析后续合法声明（恢复后下标一定前进）', () => {
    const { result, elapsedMs } = compileTimed('@函 a)\n\n@函 好(甲, 乙=2)\n    @返\n');

    expectWithinDeadline(elapsedMs);
    expect(result.ok).toBe(false); // 第一行仍是 error
    const fn = result.file.decls.find((decl) => decl.kind === 'function' && decl.name === '好');
    expect(fn).toBeDefined();
    if (fn?.kind === 'function') expect(fn.params.map((param) => param.name)).toEqual(['甲', '乙']);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['core/lex/anchor']);
  });
});

describe('200KB 恶意行：最坏 O(n)，不挂死', () => {
  it('`@函 a(` + 20 万个 `(`：括号扫描有界', () => {
    const source = `@函 a(${'(◇'.repeat(100_000)}\n`; // 20 万字符，全开括号
    const { result, elapsedMs } = compileTimed(source);

    expectWithinDeadline(elapsedMs);
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['core/lex/anchor']);
  });

  it('`@函 a(` + 200KB 正文：单行扫描不回退', () => {
    const source = `@函 a(${'叙'.repeat(200_000)}\n`;
    const { result, elapsedMs } = compileTimed(source);

    expectWithinDeadline(elapsedMs);
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['core/lex/anchor']);
  });

  it('`@函 a)` + 200KB 尾巴：失败恢复也不逐行回溯', () => {
    const source = `@函 a)${'x'.repeat(200_000)}\n`;
    const { result, elapsedMs } = compileTimed(source);

    expectWithinDeadline(elapsedMs);
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['core/lex/anchor']);
  });
});

const LEGAL_HEADERS: readonly { readonly label: string; readonly source: string }[] = [
  { label: '`@函 a(b, c)`：基本参数表', source: '@函 a(b, c)\n    @返\n' },
  {
    label: '`@函 增加羁绊(目标, 数值=10, 理由="日常")`：中文名 + 默认值',
    source: '@函 增加羁绊(目标, 数值=10, 理由="日常")\n    @返\n',
  },
  { label: '`@函 a(b)` + `@返 (1)`：函数体内嵌套括号', source: '@函 a(b)\n    @返 (1)\n' },
  { label: '`@函 a(b=")")`：默认值字符串里的括号不参与配对', source: '@函 a(b=")")\n    @返\n' },
  { label: '`# 模 甲(值)`：模板参数表', source: '# 模 甲(值)\n    > {值}\n' },
];

describe('合法形态对照：零 error（修复不得改坏合法输入）', () => {
  it.each(LEGAL_HEADERS)('$label', ({ source }) => {
    const { result, elapsedMs } = compileTimed(source);

    expectWithinDeadline(elapsedMs);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toHaveLength(0);
  });
});

