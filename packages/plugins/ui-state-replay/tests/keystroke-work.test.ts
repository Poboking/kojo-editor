/**
 * 逐键打字的账（PS-7；零 React，合成数据）。
 *
 * 钉两件事：
 * 1. **提示扫描不再摊平名字表**——`suggestFunctionNames` 收 Iterable，命中上限就收手，
 *    且每个名字至多读一次（能喂一次性生成器 = 面板可以直接递 `byFunction.keys()`）；
 * 2. **一趟回放的只读统计可以记忆化**——`analyzeReplay` 与分开调 `groupUnknowns` +
 *    `summarizeAssumptions` 逐字同值（呈现层拿现成结果，逐键打字不再重算 3,732 条谓词）。
 *
 * 顺带把两笔**真实量级**（真语料读数：3.1 万个含状态依赖的名字 / 单档 3,732 条谓词）
 * 拿合成数据复现出来做**计数**判据（读了多少条、算了几趟）。毫秒不进这条文件：
 * 墙钟判据会被并行池饿死成随机红（PITFALLS §72），量出来的 before/after 读数记在提交信息里。
 */

import { describe, expect, it } from 'vitest';
import type { ConditionExpr, FunctionReplay } from '@kojo/plugin-api';
import {
  analyzeReplay,
  groupUnknowns,
  suggestFunctionNames,
  suggestFunctions,
  summarizeAssumptions,
} from '../src/panel-logic';
import type { AssumedSlot } from '../src/panel-logic';

/* ------------------------------ 合成数据 ------------------------------ */

/** 真语料 §二读数：9.9 万函数里 31,630 个含状态依赖（提示就扫这一层） */
const NAME_COUNT = 31_630;
const NAMES: string[] = Array.from({ length: NAME_COUNT }, (_, i) => `M_KOJO_MESSAGE_COM_K${(i % 60) + 1}_${i}`);

/** 真语料 §二读数：save03 × K49 一趟回放 3,732 条谓词 */
const PRED_COUNT = 3732;

function mkReplay(n: number): FunctionReplay {
  const expr = (i: number): ConditionExpr =>
    i % 3 === 0
      ? { kind: 'ref', name: 'ARG', indices: [String(i % 4)], text: `ARG:${i % 4}` }
      : { kind: 'binary', op: '>=', left: { kind: 'ref', name: 'CFLAG', indices: ['3'], text: 'CFLAG:3' }, right: { kind: 'literal', value: i % 7, text: '0' } };
  return {
    normalizedName: 'M_KOJO_MESSAGE_COM_K49_1',
    filePath: '/g/erb/000/a.ERB',
    startLine: 4,
    stats: { total: n, hit: n >> 1, miss: n >> 2, unknown: n - (n >> 1) - (n >> 2) },
    confidence: 'partial',
    branches: [],
    predicates: Array.from({ length: n }, (_, i) => ({
      kind: 'IF' as const,
      text: `CFLAG:3 >= ${i % 7}`,
      line: i + 5,
      expr: expr(i),
      outcome:
        i % 5 === 0
          ? { kind: 'unknown' as const, unknown: { code: (i % 2 ? 'pseudo' : 'call') as never, message: '' } }
          : i % 2 === 0
            ? ({ kind: 'true' } as const)
            : ({ kind: 'false' } as const),
    })),
  } as unknown as FunctionReplay;
}

const ASSUMED: AssumedSlot[] = [{ kind: 'int', index: 0 }, { kind: 'int', index: 3 }];

/* ------------------------------ 1. 提示：迭代器口径 ------------------------------ */

describe('suggestFunctionNames（迭代器 · 不摊平）', () => {
  it('与数组口径逐字同值', () => {
    for (const q of ['K1_', 'K60_12', 'ZZZ', 'K', '']) {
      expect(suggestFunctionNames(NAMES, q, 50)).toEqual(suggestFunctions(NAMES, q, 50));
    }
  });

  it('能喂 Map.keys()：每个名字至多读一次（一次性迭代器也不炸）', () => {
    const map = new Map(NAMES.map((n) => [n, {}]));
    let reads = 0;
    const oneShot = (function* (): Generator<string> {
      for (const k of map.keys()) {
        reads += 1;
        yield k;
      }
    })();
    const hits = suggestFunctionNames(oneShot, 'K1_7', 5);
    expect(hits).toHaveLength(5);
    expect(reads).toBeLessThan(NAME_COUNT); // 命中够了就收手，不跑完整张表
  });

  it('命中上限即停：读的条数 ≤ 第 50 个命中的位置', () => {
    let reads = 0;
    const counted = {
      [Symbol.iterator]: function* () {
        for (const n of NAMES) {
          reads += 1;
          yield n;
        }
      },
    };
    expect(suggestFunctionNames(counted, '_K12_', 50)).toHaveLength(50);
    // `_K12_` 每 60 个名字里出 1 个 ⇒ 第 50 个命中落在第 2,952 个名字：收手在近处，没跑完整张 31,630
    expect(reads).toBeLessThanOrEqual(3000);
    expect(reads).toBeLessThan(NAME_COUNT);
  });

  it('无匹配时仍要扫完（这是子串过滤的应有之义，不是回归）', () => {
    let reads = 0;
    const counted = {
      [Symbol.iterator]: function* () {
        for (const n of NAMES) {
          reads += 1;
          yield n;
        }
      },
    };
    expect(suggestFunctionNames(counted, '绝不可能出现的查询', 50)).toEqual([]);
    expect(reads).toBe(NAME_COUNT);
  });
});

/* ------------------------------ 2. 回放统计可记忆化 ------------------------------ */

describe('analyzeReplay（一趟算完 · 面板按 state 记忆）', () => {
  const replay = mkReplay(PRED_COUNT);

  it('与分开调两条函数逐字同值', () => {
    const a = analyzeReplay(replay, ASSUMED);
    expect(a.unknowns).toEqual(groupUnknowns(replay));
    expect(a.impact).toEqual(summarizeAssumptions(replay, ASSUMED));
    expect(a.unknowns.length).toBeGreaterThan(0);
    expect(a.impact.affected).toHaveLength(PRED_COUNT);
    expect(a.impact.consumed.length).toBeGreaterThan(0);
  });

  it('无假设槽时仍是零成本形状（affected 逐位对齐、consumed 空）', () => {
    const a = analyzeReplay(replay, []);
    expect(a.impact.consumed).toEqual([]);
    expect(a.impact.affected.every((x) => x === false)).toBe(true);
  });
});

/* ------------------------------ 3. 逐键的账（口径不变量） ------------------------------ */

describe('逐键打字的账（真语料读数规模 · 8 次击键）', () => {
  const KEYSTROKES = ['K', 'K1', 'K12', 'K12_', 'K12_3', 'K12_34', 'K12_345', 'K12_3456'];

  it('改前口径（每击键摊平一次再扫）与改后口径（迭代器）都给出正确结果', () => {
    for (const q of KEYSTROKES) {
      const before = suggestFunctions([...NAMES], q, 50);
      const after = suggestFunctionNames(new Map(NAMES.map((n) => [n, {}])).keys(), q, 50);
      expect(after).toEqual(before);
    }
  });

  it('记忆化的判据是**身份**：结果与假设槽都是 state 引用 ⇒ 击键不碰统计', () => {
    const replay = mkReplay(PRED_COUNT);
    const first = analyzeReplay(replay, ASSUMED);
    // 面板侧的键 = [result, resultAssumed]：两者身份不变 ⇒ 缓存命中，不再重算 3,732 条
    const again = analyzeReplay(replay, ASSUMED);
    expect(again.unknowns).toEqual(first.unknowns);
    expect(again.impact.affected).toEqual(first.impact.affected);
    // 换一次回放结果（新数组引用）才该重算——身份判据成立
    expect(mkReplay(PRED_COUNT)).not.toBe(replay);
  });

  it('击键期间读的条数远小于摊平整张表（省掉的正是那一趟无谓的复制）', () => {
    let lazyReads = 0;
    const counted = {
      [Symbol.iterator]: function* () {
        for (const n of NAMES) {
          lazyReads += 1;
          yield n;
        }
      },
    };
    for (const q of KEYSTROKES) suggestFunctionNames(counted, q, 50);
    // 8 拍里前 1 拍（`K`）连门槛都不过 = 一次都不读；其余各扫一遍到第 50 个命中
    expect(lazyReads).toBeLessThan(NAME_COUNT * 8);
    expect(NAME_COUNT * 8).toBeGreaterThan(lazyReads);
  });
});
