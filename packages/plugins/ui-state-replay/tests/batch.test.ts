/**
 * 批量体检单测（零 React 渲染框架；合成 `FunctionReplay`，不依赖真引擎）。
 *
 * 覆盖：`runBatchReplay` 的正常汇总 / 回放抛错不中断 / 取消提前收尾 / cap 截断 /
 * 进度回调序列 / 让出事件循环的频率 / 空列表 / 全部 null；`summarizeBatch` 的
 * 计数口径、最该看排序与 30 条截断、`summaryOf` 全量计数覆盖。
 */
import { describe, expect, it } from 'vitest';
import type { FunctionReplay } from '@kojo/plugin-api';
import {
  BATCH_DEFAULT_CAP,
  BATCH_WORST_LIMIT,
  compareBatchRows,
  rowFromReplay,
  runBatchReplay,
  summarizeBatch,
} from '../src/batch';
import type { BatchRow } from '../src/batch';

/** 合成一次回放结果（只填体检要读的字段：stats / confidence + 契约必填骨架） */
function makeReplay(
  confidence: FunctionReplay['confidence'],
  stats: FunctionReplay['stats'],
  normalizedName = 'FN',
): FunctionReplay {
  return {
    normalizedName,
    filePath: 'Data/Script/Batch.ERB',
    startLine: 10,
    predicates: [],
    branches: [],
    stats,
    confidence,
  };
}

/** 合成一行体检结果（测试排序 / 计数时直接给行，不必走 replay） */
function makeRow(
  name: string,
  confidence: BatchRow['confidence'],
  total: number,
  unknown: number,
): BatchRow {
  return {
    name,
    confidence,
    total,
    hit: total - unknown,
    miss: 0,
    unknown,
    unknownRatio: total > 0 ? unknown / total : 0,
  };
}

/** 一个永远成功的最小回放 */
function okReplay(): Promise<FunctionReplay> {
  return Promise.resolve(makeReplay('exact', { total: 1, hit: 1, miss: 0, unknown: 0 }));
}

describe('runBatchReplay 正常汇总', () => {
  it('逐条串行回放；counts / 求和 / 最该看排序 / 进度序列', async () => {
    const table: Record<string, FunctionReplay | null> = {
      ALPHA: makeReplay('exact', { total: 4, hit: 4, miss: 0, unknown: 0 }),
      BETA: makeReplay('partial', { total: 5, hit: 3, miss: 0, unknown: 2 }),
      GAMMA: makeReplay('unknown', { total: 3, hit: 0, miss: 0, unknown: 3 }),
      MISSING: null,
    };
    const calls: string[] = [];
    const progress: [number, number][] = [];
    const summary = await runBatchReplay({
      names: ['ALPHA', 'BETA', 'GAMMA', 'MISSING'],
      replay: async (name) => {
        calls.push(name);
        return table[name] ?? null;
      },
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(calls).toEqual(['ALPHA', 'BETA', 'GAMMA', 'MISSING']);
    expect(progress).toEqual([
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ]);
    expect(summary).toMatchObject({
      requested: 4,
      scanned: 3,
      missing: 1,
      exact: 1,
      partial: 1,
      unknown: 1,
      totalPredicates: 12,
      unknownPredicates: 5,
      cancelled: false,
      remaining: 0,
    });
    // 全未知排最前；同无并列时按判不出占比降序
    expect(summary.rows.map((r) => r.name)).toEqual(['GAMMA', 'BETA', 'ALPHA']);
    expect(summary.rows[0]).toEqual({
      name: 'GAMMA',
      confidence: 'unknown',
      total: 3,
      hit: 0,
      miss: 0,
      unknown: 3,
      unknownRatio: 1,
    });
    expect(summary.rows[1]!.unknownRatio).toBeCloseTo(2 / 5, 10);
  });

  it('行上的名字用请求名（不回填 normalizedName）', async () => {
    const summary = await runBatchReplay({
      names: ['lower_name'],
      replay: async () => makeReplay('exact', { total: 1, hit: 1, miss: 0, unknown: 0 }, 'LOWER_NAME'),
    });
    expect(summary.rows[0]!.name).toBe('lower_name');
  });
});

describe('runBatchReplay 容错', () => {
  it('单函数抛错不中断整批：记 missing，进度照走，其余照常汇总', async () => {
    const seen: string[] = [];
    const progress: number[] = [];
    const summary = await runBatchReplay({
      names: ['A', 'BOOM', 'B'],
      replay: async (name) => {
        seen.push(name);
        if (name === 'BOOM') throw new Error('boom');
        return makeReplay('exact', { total: 2, hit: 2, miss: 0, unknown: 0 });
      },
      onProgress: (done) => progress.push(done),
    });

    expect(seen).toEqual(['A', 'BOOM', 'B']);
    expect(progress).toEqual([1, 2, 3]);
    expect(summary).toMatchObject({ requested: 3, scanned: 2, missing: 1, cancelled: false });
    expect(summary.rows.map((r) => r.name)).toEqual(['A', 'B']);
  });

  it('全部 null：不抛错，scanned = 0、missing = 全部', async () => {
    const summary = await runBatchReplay({
      names: ['A', 'B'],
      replay: async () => null,
    });
    expect(summary).toMatchObject({
      requested: 2,
      scanned: 0,
      missing: 2,
      exact: 0,
      partial: 0,
      unknown: 0,
      totalPredicates: 0,
      unknownPredicates: 0,
      rows: [],
      cancelled: false,
      remaining: 0,
    });
  });

  it('空名字列表：明确空结果，不调 replay / onProgress', async () => {
    let calls = 0;
    const progress: unknown[] = [];
    const summary = await runBatchReplay({
      names: [],
      replay: async () => {
        calls += 1;
        return okReplay();
      },
      onProgress: (...args: unknown[]) => progress.push(args),
    });
    expect(calls).toBe(0);
    expect(progress).toEqual([]);
    expect(summary).toEqual({
      requested: 0,
      scanned: 0,
      missing: 0,
      exact: 0,
      partial: 0,
      unknown: 0,
      totalPredicates: 0,
      unknownPredicates: 0,
      rows: [],
      cancelled: false,
      remaining: 0,
    });
  });
});

describe('runBatchReplay 取消', () => {
  it('isCancelled 为真后不再发起新回放：已扫描部分保留并置 cancelled', async () => {
    let calls = 0;
    const summary = await runBatchReplay({
      names: ['A', 'B', 'C', 'D'],
      replay: async () => {
        calls += 1;
        return makeReplay('exact', { total: 1, hit: 1, miss: 0, unknown: 0 });
      },
      // 跑完两个后取消（第三个开始前检查到）
      isCancelled: () => calls >= 2,
    });

    expect(calls).toBe(2);
    expect(summary.cancelled).toBe(true);
    expect(summary.requested).toBe(4);
    expect(summary.scanned).toBe(2);
    expect(summary.missing).toBe(0);
    expect(summary.rows.map((r) => r.name)).toEqual(['A', 'B']);
  });

  it('一开始就取消：零回放、零错误', async () => {
    let calls = 0;
    const summary = await runBatchReplay({
      names: ['A', 'B'],
      replay: async () => {
        calls += 1;
        return okReplay();
      },
      isCancelled: () => true,
    });
    expect(calls).toBe(0);
    expect(summary).toMatchObject({ requested: 2, scanned: 0, missing: 0, cancelled: true, rows: [] });
  });
});

describe('runBatchReplay 上限', () => {
  it('cap 截断：只回放前 N 个，remaining / requested 各自记清', async () => {
    const seen: string[] = [];
    const progress: [number, number][] = [];
    const summary = await runBatchReplay({
      names: ['A', 'B', 'C', 'D', 'E'],
      cap: 2,
      replay: async (name) => {
        seen.push(name);
        return makeReplay('exact', { total: 1, hit: 1, miss: 0, unknown: 0 });
      },
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(seen).toEqual(['A', 'B']);
    // 进度 total 是本次实际会回放的上限数（不会停在 x/5 的假进度）
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(summary).toMatchObject({ requested: 5, scanned: 2, remaining: 3, cancelled: false });
  });

  it('cap = 0：一个都不回放，剩余全部计入 remaining', async () => {
    let calls = 0;
    const summary = await runBatchReplay({
      names: ['A', 'B'],
      cap: 0,
      replay: async () => {
        calls += 1;
        return okReplay();
      },
    });
    expect(calls).toBe(0);
    expect(summary).toMatchObject({ requested: 2, scanned: 0, missing: 0, remaining: 2, cancelled: false });
  });

  it('缺省 cap 截断（超出只回放前 BATCH_DEFAULT_CAP 个）', async () => {
    const names = Array.from({ length: BATCH_DEFAULT_CAP + 3 }, (_, i) => `F${i}`);
    let calls = 0;
    const summary = await runBatchReplay({
      names,
      replay: async () => {
        calls += 1;
        return null;
      },
    });
    expect(calls).toBe(BATCH_DEFAULT_CAP);
    expect(summary.requested).toBe(BATCH_DEFAULT_CAP + 3);
    expect(summary.missing).toBe(BATCH_DEFAULT_CAP);
    expect(summary.remaining).toBe(3);
  });
});

describe('runBatchReplay 让出事件循环', () => {
  it('yieldEvery 控制让出频率（每 N 个让出一次，不是每个都让）', async () => {
    /** 记录“回放 → 定时器 → 下一个回放”的先后，证明让出是宏任务而非纯微任务 */
    const events: string[] = [];
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        events.push('timer');
        resolve();
      }, 0);
    });
    await runBatchReplay({
      names: ['A', 'B', 'C', 'D'],
      replay: async (name) => {
        events.push(`replay:${name}`);
        return makeReplay('exact', { total: 0, hit: 0, miss: 0, unknown: 0 });
      },
      yieldEvery: 1,
    });
    await timer;
    // 每跑完一个就让出 ⇒ 测试先排的 timer 在第二个回放前就烧掉了
    expect(events.indexOf('timer')).toBeGreaterThan(-1);
    expect(events.indexOf('timer')).toBeLessThan(events.indexOf('replay:B'));
  });

  it('缺省 yieldEvery = 25：小批量一次都不让出（timer 要等整批跑完）', async () => {
    const events: string[] = [];
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        events.push('timer');
        resolve();
      }, 0);
    });
    await runBatchReplay({
      names: ['A', 'B', 'C', 'D'],
      replay: async (name) => {
        events.push(`replay:${name}`);
        return makeReplay('exact', { total: 0, hit: 0, miss: 0, unknown: 0 });
      },
    });
    await timer;
    expect(events.indexOf('timer')).toBeGreaterThan(events.indexOf('replay:D'));
  });
});

describe('rowFromReplay', () => {
  it('投影 stats + 计算 unknownRatio；total = 0 → 0', () => {
    const row = rowFromReplay(
      'X',
      makeReplay('partial', { total: 8, hit: 5, miss: 1, unknown: 2 }),
    );
    expect(row).toEqual({
      name: 'X',
      confidence: 'partial',
      total: 8,
      hit: 5,
      miss: 1,
      unknown: 2,
      unknownRatio: 0.25,
    });
    const empty = rowFromReplay('EMPTY', makeReplay('exact', { total: 0, hit: 0, miss: 0, unknown: 0 }));
    expect(empty.unknownRatio).toBe(0);
  });
});

describe('summarizeBatch 排序与口径', () => {
  it('排序键：unknownRatio 降序 → unknown 降序 → 名字升序（unknown=0 的行不剔除）', () => {
    const rows: BatchRow[] = [
      makeRow('zz', 'partial', 6, 3),
      makeRow('lo', 'partial', 4, 1),
      makeRow('hi', 'unknown', 2, 2),
      makeRow('aa', 'partial', 6, 3),
      makeRow('mm', 'partial', 4, 2),
      makeRow('clean', 'exact', 5, 0),
    ];
    const summary = summarizeBatch(rows, { requested: 6, missing: 0, cancelled: false });
    expect(summary.rows.map((r) => r.name)).toEqual(['hi', 'aa', 'zz', 'mm', 'lo', 'clean']);
    // unknown = 0 的行保留（“这些段可判”本身是信息），只是排最后
    expect(summary.rows.at(-1)!.name).toBe('clean');
  });

  it('计数从全部行现算；rows 只截断前 30 条', () => {
    const rows: BatchRow[] = [];
    for (let i = 0; i < 40; i += 1) {
      const confidence: BatchRow['confidence'] = i < 15 ? 'exact' : i < 30 ? 'partial' : 'unknown';
      rows.push(makeRow(`F${String(i).padStart(2, '0')}`, confidence, 40, i));
    }
    const summary = summarizeBatch(rows, { requested: 40, missing: 0, cancelled: false });

    expect(summary.scanned).toBe(40);
    expect(summary.exact).toBe(15);
    expect(summary.partial).toBe(15);
    expect(summary.unknown).toBe(10);
    expect(summary.totalPredicates).toBe(40 * 40);
    expect(summary.unknownPredicates).toBe((39 * 40) / 2);
    expect(summary.rows).toHaveLength(BATCH_WORST_LIMIT);
    expect(summary.rows[0]!.name).toBe('F39');
    expect(summary.rows.at(-1)!.name).toBe('F10');
    // 计数不因截断而丢：unknownPredicates 覆盖全部 40 行
    expect(summary.unknownPredicates).toBeGreaterThan(
      summary.rows.reduce((sum, r) => sum + r.unknown, 0),
    );
  });

  it('summaryOf 可覆盖全量计数（调用方只把最该看的子集给渲染时用）', () => {
    const summary = summarizeBatch([makeRow('only', 'exact', 2, 0)], {
      requested: 10,
      missing: 2,
      cancelled: false,
      remaining: 5,
      summaryOf: { scanned: 9, exact: 7, partial: 1, unknown: 1, totalPredicates: 100, unknownPredicates: 40 },
    });
    expect(summary).toMatchObject({
      requested: 10,
      scanned: 9,
      missing: 2,
      exact: 7,
      partial: 1,
      unknown: 1,
      totalPredicates: 100,
      unknownPredicates: 40,
      cancelled: false,
      remaining: 5,
    });
    expect(summary.rows.map((r) => r.name)).toEqual(['only']);
  });

  it('compareBatchRows 是全序：完全相同的行返回 0（稳定排序）', () => {
    const a = makeRow('same', 'partial', 4, 2);
    const b = makeRow('same', 'partial', 4, 2);
    expect(compareBatchRows(a, b)).toBe(0);
  });

  it('remaining / cancelled 原样透传；缺省 remaining = 0', () => {
    const base = { requested: 3, missing: 0, cancelled: true };
    expect(summarizeBatch([], base)).toMatchObject({ remaining: 0, cancelled: true, scanned: 0 });
    expect(summarizeBatch([], { ...base, remaining: 4 })).toMatchObject({ remaining: 4 });
  });
});
