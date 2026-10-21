/**
 * 项目级分析的**性能上界**（契约：万级函数 / 千级监听 ≤ 50ms）。
 *
 * 这不是跑分，是**闸**：项目层在每次保存/诊断刷新时都要跑一遍，超线性实现（O(n²)
 * 分组、全量 `find`、localeCompare 排序）会直接把编辑器主线程拖死。本用例：
 * 1) 断言（中位数）≤ 50ms —— 取中位数而不是单次，避开 GC/调度毛刺；
 * 2) **打印**全部读数（min/median/max），供 CI 日志与后续回归比对（"改快了还是改慢了"）。
 */
import { describe, expect, it } from 'vitest';

import {
  analyzeProject,
  type EventCatalogFacts,
  type ProjectFunctionFact,
  type ProjectWeaveFact,
} from '../src/project/analysis';

const FUNCTION_COUNT = 10_000;
const WEAVE_COUNT = 1_000;
const EVENT_COUNT = 50;
const UPPER_BOUND_MS = 50;

const sp = (line: number) => ({ start: { line, column: 1 }, end: { line, column: 2 } });

function buildFunctions(): ProjectFunctionFact[] {
  const functions: ProjectFunctionFact[] = [];
  // 8,000 个唯一名（每名一条定义）+ 1,000 个重名对（每名两条）= 10,000 条定义
  for (let i = 0; i < 8_000; i++) {
    functions.push({ name: `唯一函数_${i}`, filePath: `files/f${i % 200}.kojo`, span: sp(i + 1) });
  }
  for (let i = 0; i < 1_000; i++) {
    functions.push({ name: `重名函数_${i}`, filePath: `files/f${i % 200}.kojo`, span: sp(i + 1) });
    functions.push({ name: `重名函数_${i}`, filePath: `files/g${i % 200}.kojo`, span: sp(i + 1) });
  }
  return functions;
}

function buildWeaves(): ProjectWeaveFact[] {
  const events: EventCatalogFacts = { names: [], priorityModel: 'emuera-buckets' };
  const weaves: ProjectWeaveFact[] = [];
  const eventNames: string[] = [];
  for (let i = 0; i < EVENT_COUNT; i++) eventNames.push(`事件_${i}`);
  for (let i = 0; i < WEAVE_COUNT; i++) {
    const event = eventNames[i % EVENT_COUNT]!;
    // 每 10 条一个接管、其余普通监听（同层）：既走接管组，也走被压 warning 路径
    const modifiers = i % 10 === 0 ? (['only'] as const) : ([] as const);
    weaves.push({
      event,
      modifiers: [...modifiers],
      filePath: `files/w${i % 100}.kojo`,
      span: sp(i + 1),
    });
  }
  return weaves;
}

const EVENTS: EventCatalogFacts = {
  names: Array.from({ length: EVENT_COUNT }, (_, i) => `事件_${i}`),
  priorityModel: 'emuera-buckets',
};

function measureOnce(input: ReturnType<typeof buildInput>): { ms: number; diagnostics: number } {
  const start = performance.now();
  const result = analyzeProject(input);
  const ms = performance.now() - start;
  return { ms, diagnostics: result.diagnostics.length };
}

function buildInput(): Parameters<typeof analyzeProject>[0] {
  return { functions: buildFunctions(), weaves: buildWeaves(), events: EVENTS };
}

describe('project.analysis 性能', () => {
  it(`万级函数 + 千级监听：分析中位数 ≤ ${UPPER_BOUND_MS}ms（并打印读数）`, () => {
    const input = buildInput();
    // 预热（JIT / 首次 Map 分配），不计入读数
    analyzeProject(input);
    analyzeProject(input);

    const samples: number[] = [];
    let diagnosticCount = 0;
    for (let i = 0; i < 5; i++) {
      const readout = measureOnce(input);
      samples.push(readout.ms);
      diagnosticCount = readout.diagnostics;
    }
    samples.sort((a, b) => a - b);
    const min = samples[0]!;
    const median = samples[2]!;
    const max = samples[samples.length - 1]!;
    // 读数进 stdout（vitest 默认打印 console.log）；契约要求"bench 记录"
    console.log(
      `[bench] analyzeProject ${FUNCTION_COUNT} funcs + ${WEAVE_COUNT} weaves / ${EVENT_COUNT} events：` +
        `min ${min.toFixed(2)}ms · median ${median.toFixed(2)}ms · max ${max.toFixed(2)}ms（上界 ${UPPER_BOUND_MS}ms，诊断 ${diagnosticCount} 条）`,
    );

    expect(diagnosticCount).toBeGreaterThan(0); // 数据里确有重名/接管，路径真被走到
    expect(median).toBeLessThanOrEqual(UPPER_BOUND_MS);
  });
});
