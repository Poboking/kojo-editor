/**
 * 整档扫描单测（零 React、零真实语料；合成 `FunctionReplay` + 注入时钟）。
 *
 * 覆盖：空角色表 / 空段落 / 正常汇总与排序 / 同分稳定 / perCharCap（含缺省 20）/
 * totalCap 顺序耗尽（含 0 与缺省 2000）/ 取消在中途 / 一开始就取消 / 抛错记 unknown
 * 继续 / 返回 null 不计入 total 但消耗预算 / 进度序列单调且末段必发 / 跨角色
 * charaNo / elapsedMs 注入时钟 / worst 上限 30 / 1000 段量级。
 */
import { describe, expect, it } from 'vitest';
import type { FunctionReplay } from '@kojo/plugin-api';
import {
  ARCHIVE_SCAN_DEFAULT_PER_CHAR_CAP,
  ARCHIVE_SCAN_DEFAULT_TOTAL_CAP,
  compareArchiveScanRows,
  runArchiveScan,
} from '../src/archive-scan';
import type { ArchiveScanRow } from '../src/archive-scan';
import type { BatchRow } from '../src/batch';

/** 合成一次回放结果（只填扫描要读的字段：stats / confidence + 契约必填骨架） */
function makeReplay(
  confidence: FunctionReplay['confidence'],
  stats: FunctionReplay['stats'],
  normalizedName = 'FN',
): FunctionReplay {
  return {
    normalizedName,
    filePath: 'Data/Script/Archive.ERB',
    startLine: 1,
    predicates: [],
    branches: [],
    stats,
    confidence,
  };
}

function exactReplay(total = 1): FunctionReplay {
  return makeReplay('exact', { total, hit: total, miss: 0, unknown: 0 });
}

function unknownReplay(total = 1): FunctionReplay {
  return makeReplay('unknown', { total, hit: 0, miss: 0, unknown: total });
}

/** 合成一行整档结果（只给排序测试用） */
function makeScanRow(charaNo: number, name: string, total: number, unknown: number): ArchiveScanRow {
  return { charaNo, name, total, exact: total - unknown, partial: 0, unknown, worst: [], functionCount: total };
}

/** 角色表 + 名字表的小工具 */
function chars(...specs: [number, string][]): { charaNo: number; name: string }[] {
  return specs.map(([charaNo, name]) => ({ charaNo, name }));
}

describe('runArchiveScan 空输入', () => {
  it('空角色表：零回放、零进度、elapsedMs 走注入时钟', async () => {
    let replayCalls = 0;
    const progress: unknown[] = [];
    const summary = await runArchiveScan({
      characters: [],
      namesFor: () => [],
      replayFor: async () => {
        replayCalls += 1;
        return exactReplay();
      },
      onProgress: (...args: unknown[]) => progress.push(args),
      now: () => 7,
    });

    expect(replayCalls).toBe(0);
    expect(progress).toEqual([]);
    expect(summary).toEqual({
      rows: [],
      scannedChars: 0,
      skippedChars: 0,
      replayedFunctions: 0,
      totalFunctions: 0,
      cap: 0,
      elapsedMs: 0,
      cancelled: false,
      timedOut: 0,
      stoppedReason: null,
    });
  });

  it('空段落：角色算「轮到」，给 0 行；不调 replayFor', async () => {
    let replayCalls = 0;
    const summary = await runArchiveScan({
      characters: chars([5, '空角色']),
      namesFor: () => [],
      replayFor: async () => {
        replayCalls += 1;
        return exactReplay();
      },
      now: () => 1,
    });

    expect(replayCalls).toBe(0);
    expect(summary.rows).toEqual([
      {
        charaNo: 5,
        name: '空角色',
        total: 0,
        exact: 0,
        partial: 0,
        unknown: 0,
        worst: [],
        functionCount: 0,
        missing: 0,
        timedOut: 0,
      },
    ]);
    expect(summary).toMatchObject({
      scannedChars: 1,
      skippedChars: 0,
      replayedFunctions: 0,
      totalFunctions: 0,
      cap: 0,
      cancelled: false,
      timedOut: 0,
      stoppedReason: null,
    });
  });
});

describe('runArchiveScan 汇总与排序', () => {
  it('逐角色计数 / worst / 按未知占比降序 / namesFor 每角色只调一次', async () => {
    const table: Record<number, string[]> = {
      10: ['A1', 'A2', 'A3'],
      20: ['B1', 'B2'],
      30: ['C1', 'C2'],
    };
    const replays: Record<string, FunctionReplay> = {
      A1: makeReplay('exact', { total: 4, hit: 4, miss: 0, unknown: 0 }),
      A2: makeReplay('partial', { total: 5, hit: 3, miss: 0, unknown: 2 }),
      A3: makeReplay('unknown', { total: 3, hit: 0, miss: 0, unknown: 3 }),
      B1: exactReplay(),
      B2: makeReplay('unknown', { total: 2, hit: 0, miss: 0, unknown: 2 }),
      C1: exactReplay(),
      C2: exactReplay(),
    };
    const namesCalls: number[] = [];
    const progress: [number, number, number][] = [];

    const summary = await runArchiveScan({
      characters: chars([10, '爱丽丝'], [20, '鲍勃'], [30, '卡罗尔']),
      namesFor: (charaNo) => {
        namesCalls.push(charaNo);
        return table[charaNo] ?? [];
      },
      replayFor: async (_charaNo, name) => replays[name] ?? null,
      onProgress: (done, total, charaNo) => progress.push([done, total, charaNo]),
      now: () => 42,
    });

    // 名字只取一次（不重复调 namesFor）
    expect(namesCalls).toEqual([10, 20, 30]);
    // 未知占比：鲍勃 1/2 > 爱丽丝 1/3 > 卡罗尔 0
    expect(summary.rows.map((r) => r.charaNo)).toEqual([20, 10, 30]);
    expect(summary.rows.map((r) => r.name)).toEqual(['鲍勃', '爱丽丝', '卡罗尔']);

    const [bob, alice, carol] = summary.rows as [ArchiveScanRow, ArchiveScanRow, ArchiveScanRow];
    expect(bob).toMatchObject({ total: 2, exact: 1, partial: 0, unknown: 1, functionCount: 2, missing: 0 });
    expect(bob.worst.map((r) => r.name)).toEqual(['B2', 'B1']);
    expect(bob.worst[0]!.unknownRatio).toBe(1);

    expect(alice).toMatchObject({ total: 3, exact: 1, partial: 1, unknown: 1, functionCount: 3 });
    // 段内排序：A3（1.0）> A2（0.4）> A1（0）
    expect(alice.worst.map((r) => r.name)).toEqual(['A3', 'A2', 'A1']);
    expect(alice.worst[1]!.unknownRatio).toBeCloseTo(2 / 5, 10);

    expect(carol).toMatchObject({ total: 2, exact: 2, partial: 0, unknown: 0, functionCount: 2 });
    expect(carol.worst.map((r) => r.name)).toEqual(['C1', 'C2']);

    expect(summary).toMatchObject({
      scannedChars: 3,
      skippedChars: 0,
      replayedFunctions: 7,
      totalFunctions: 7,
      cap: 7,
      elapsedMs: 0,
      cancelled: false,
      timedOut: 0,
      stoppedReason: null,
    });
    // 7 段 < 缺省 yieldEvery 25 ⇒ 只在末段发一次
    expect(progress).toEqual([[7, 7, 30]]);
  });

  it('排序稳定：同未知占比按 charaNo 升序；同 charaNo 再按名字升序；完全相同返回 0', () => {
    const a = makeScanRow(5, '五', 4, 2);
    const b = makeScanRow(3, 'b', 4, 2);
    const c = makeScanRow(3, 'a', 4, 2);
    expect([a, b, c].sort(compareArchiveScanRows).map((r) => r.name)).toEqual(['a', 'b', '五']);
    expect(compareArchiveScanRows(a, { ...a })).toBe(0);
    // 无段落（total = 0）占比按 0，排最后
    const empty = makeScanRow(1, '空', 0, 0);
    expect([empty, a].sort(compareArchiveScanRows).map((r) => r.name)).toEqual(['五', '空']);
  });
});

describe('runArchiveScan 预算', () => {
  it('perCharCap 生效：按名字顺序取前 N，functionCount 也截断', async () => {
    const names = Array.from({ length: 10 }, (_, i) => `N${i}`);
    const seen: string[] = [];
    const summary = await runArchiveScan({
      characters: chars([1, '甲']),
      namesFor: () => names,
      perCharCap: 3,
      replayFor: async (_charaNo, name) => {
        seen.push(name);
        return exactReplay();
      },
    });

    expect(seen).toEqual(['N0', 'N1', 'N2']);
    expect(summary.rows[0]).toMatchObject({ total: 3, functionCount: 3 });
    expect(summary).toMatchObject({
      replayedFunctions: 3,
      totalFunctions: 3,
      cap: 3,
      scannedChars: 1,
      skippedChars: 0,
    });
  });

  it(`perCharCap 缺省 ${ARCHIVE_SCAN_DEFAULT_PER_CHAR_CAP}：21 段只扫前 20`, async () => {
    const names = Array.from({ length: 21 }, (_, i) => `N${i}`);
    let calls = 0;
    const summary = await runArchiveScan({
      characters: chars([1, '甲']),
      namesFor: () => names,
      replayFor: async () => {
        calls += 1;
        return exactReplay();
      },
    });
    expect(calls).toBe(ARCHIVE_SCAN_DEFAULT_PER_CHAR_CAP);
    expect(summary.rows[0]).toMatchObject({ total: 20, functionCount: 20 });
    expect(summary).toMatchObject({ replayedFunctions: 20, totalFunctions: 20, cap: 20 });
  });

  it('perCharCap = 0：一段都不扫，有段落的角色全部没轮到（与 totalCap = 0 同义）', async () => {
    let calls = 0;
    const summary = await runArchiveScan({
      characters: chars([1, '甲'], [2, '乙']),
      namesFor: () => ['A', 'B', 'C'],
      perCharCap: 0,
      replayFor: async () => {
        calls += 1;
        return exactReplay();
      },
    });

    expect(calls).toBe(0);
    expect(summary).toEqual({
      rows: [],
      scannedChars: 0,
      skippedChars: 2,
      replayedFunctions: 0,
      totalFunctions: 0,
      cap: 0,
      elapsedMs: expect.any(Number),
      cancelled: false,
      timedOut: 0,
      stoppedReason: null,
    });
  });

  it('totalCap 顺序耗尽：前角色吃完预算，后面的角色整只跳过（skippedChars）', async () => {
    const seen: string[] = [];
    const summary = await runArchiveScan({
      characters: chars([1, '甲'], [2, '乙'], [3, '丙']),
      namesFor: (charaNo) => Array.from({ length: 5 }, (_, i) => `${charaNo}-${i}`),
      totalCap: 7,
      replayFor: async (_charaNo, name) => {
        seen.push(name);
        return exactReplay();
      },
    });

    expect(seen).toEqual(['1-0', '1-1', '1-2', '1-3', '1-4', '2-0', '2-1']);
    expect(summary.rows.map((r) => r.charaNo)).toEqual([1, 2]);
    expect(summary.rows[1]).toMatchObject({ total: 2, functionCount: 5 });
    expect(summary).toMatchObject({
      replayedFunctions: 7,
      totalFunctions: 15,
      cap: 7,
      scannedChars: 2,
      skippedChars: 1,
      cancelled: false,
      timedOut: 0,
      stoppedReason: null,
    });
  });

  it('totalCap = 0：一段都不扫，所有有段落的角色都算没轮到', async () => {
    let calls = 0;
    const progress: unknown[] = [];
    const summary = await runArchiveScan({
      characters: chars([1, '甲'], [2, '乙'], [3, '丙']),
      namesFor: () => ['A', 'B'],
      totalCap: 0,
      replayFor: async () => {
        calls += 1;
        return exactReplay();
      },
      onProgress: (...args: unknown[]) => progress.push(args),
    });

    expect(calls).toBe(0);
    expect(progress).toEqual([]);
    expect(summary).toEqual({
      rows: [],
      scannedChars: 0,
      skippedChars: 3,
      replayedFunctions: 0,
      totalFunctions: 6,
      cap: 0,
      elapsedMs: expect.any(Number),
      cancelled: false,
      timedOut: 0,
      stoppedReason: null,
    });
  });

  it(`totalCap 缺省 ${ARCHIVE_SCAN_DEFAULT_TOTAL_CAP}：超出部分不回放`, async () => {
    const names = Array.from({ length: ARCHIVE_SCAN_DEFAULT_TOTAL_CAP + 1 }, (_, i) => `F${i}`);
    let calls = 0;
    const summary = await runArchiveScan({
      characters: chars([1, '甲']),
      namesFor: () => names,
      perCharCap: names.length,
      // 不吃默认 yieldEvery 的 80 次 setTimeout：本用例只验预算
      yieldEvery: 100_000,
      replayFor: async () => {
        calls += 1;
        return exactReplay();
      },
    });
    expect(calls).toBe(ARCHIVE_SCAN_DEFAULT_TOTAL_CAP);
    expect(summary).toMatchObject({
      replayedFunctions: ARCHIVE_SCAN_DEFAULT_TOTAL_CAP,
      totalFunctions: ARCHIVE_SCAN_DEFAULT_TOTAL_CAP + 1,
      cap: ARCHIVE_SCAN_DEFAULT_TOTAL_CAP,
    });
    expect(summary.rows[0]!.functionCount).toBe(ARCHIVE_SCAN_DEFAULT_TOTAL_CAP + 1);
  });
});

describe('runArchiveScan 取消', () => {
  it('中途取消：保留已扫部分、未轮到角色进 skippedChars、补发末次进度', async () => {
    let calls = 0;
    const progress: [number, number, number][] = [];
    const summary = await runArchiveScan({
      characters: chars([1, '甲'], [2, '乙']),
      namesFor: (charaNo) => (charaNo === 1 ? ['A', 'B', 'C', 'D', 'E'] : ['X', 'Y']),
      replayFor: async () => {
        calls += 1;
        return exactReplay();
      },
      // 跑完 3 段后，在第 4 段开始前取消
      shouldCancel: () => calls >= 3,
      onProgress: (done, total, charaNo) => progress.push([done, total, charaNo]),
    });

    expect(calls).toBe(3);
    expect(summary.cancelled).toBe(true);
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]).toMatchObject({ charaNo: 1, total: 3, functionCount: 5 });
    expect(summary).toMatchObject({
      replayedFunctions: 3,
      totalFunctions: 7,
      cap: 7,
      scannedChars: 1,
      skippedChars: 1,
    });
    // 3 段不是 yieldEvery 的倍数，但取消收尾必发一次
    expect(progress).toEqual([[3, 7, 1]]);
  });

  it('一开始就取消：零回放、零行、全部角色没轮到', async () => {
    let calls = 0;
    const progress: unknown[] = [];
    const summary = await runArchiveScan({
      characters: chars([1, '甲'], [2, '乙']),
      namesFor: () => ['A', 'B'],
      replayFor: async () => {
        calls += 1;
        return exactReplay();
      },
      shouldCancel: () => true,
      onProgress: (...args: unknown[]) => progress.push(args),
    });

    expect(calls).toBe(0);
    expect(progress).toEqual([]);
    expect(summary).toMatchObject({
      rows: [],
      scannedChars: 0,
      skippedChars: 2,
      replayedFunctions: 0,
      cancelled: true,
      timedOut: 0,
      stoppedReason: 'cancelled',
    });
  });
});

describe('runArchiveScan 容错', () => {
  it('单段抛错记 unknown 并继续；不中断整档、不进 worst', async () => {
    const seen: string[] = [];
    const summary = await runArchiveScan({
      characters: chars([1, '甲']),
      namesFor: () => ['A', 'BOOM', 'B'],
      replayFor: async (_charaNo, name) => {
        seen.push(name);
        if (name === 'BOOM') throw new Error('boom');
        return exactReplay();
      },
    });

    expect(seen).toEqual(['A', 'BOOM', 'B']);
    expect(summary.cancelled).toBe(false);
    expect(summary.rows[0]).toMatchObject({
      total: 3,
      exact: 2,
      partial: 0,
      unknown: 1,
      missing: 0,
      functionCount: 3,
    });
    expect(summary.rows[0]!.worst.map((r) => r.name)).toEqual(['A', 'B']);
    expect(summary.rows[0]!.exact + summary.rows[0]!.partial + summary.rows[0]!.unknown).toBe(
      summary.rows[0]!.total,
    );
  });

  it('返回 null：不计入 total / worst，但照常消耗预算并推进进度', async () => {
    const seen: string[] = [];
    const progress: [number, number, number][] = [];
    const summary = await runArchiveScan({
      characters: chars([1, '甲']),
      namesFor: () => ['A', 'MISS', 'B'],
      totalCap: 2,
      replayFor: async (_charaNo, name) => {
        seen.push(name);
        return name === 'MISS' ? null : exactReplay();
      },
      onProgress: (done, total, charaNo) => progress.push([done, total, charaNo]),
    });

    // 预算被 MISS 吃掉：B 没轮到
    expect(seen).toEqual(['A', 'MISS']);
    expect(summary.rows[0]).toMatchObject({
      total: 1,
      exact: 1,
      unknown: 0,
      missing: 1,
      functionCount: 3,
    });
    expect(summary.rows[0]!.worst.map((r) => r.name)).toEqual(['A']);
    expect(summary).toMatchObject({ replayedFunctions: 2, cap: 2 });
    expect(progress).toEqual([[2, 2, 1]]);
  });
});

describe('runArchiveScan 进度', () => {
  it('每 yieldEvery 段回调一次且末段必发，done 单调不减', async () => {
    const progress: [number, number, number][] = [];
    const summary = await runArchiveScan({
      characters: chars([9, '甲']),
      namesFor: () => ['F0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6'],
      yieldEvery: 3,
      replayFor: async () => exactReplay(),
      onProgress: (done, total, charaNo) => progress.push([done, total, charaNo]),
    });

    expect(progress).toEqual([
      [3, 7, 9],
      [6, 7, 9],
      [7, 7, 9],
    ]);
    expect(progress.map(([done]) => done)).toEqual([3, 6, 7]);
    expect(summary.replayedFunctions).toBe(7);
  });

  it('跨角色时 charaNo 是刚处理那一段所属的角色', async () => {
    const progress: [number, number, number][] = [];
    await runArchiveScan({
      characters: chars([11, '甲'], [22, '乙']),
      namesFor: () => ['A', 'B'],
      yieldEvery: 2,
      replayFor: async () => exactReplay(),
      onProgress: (done, total, charaNo) => progress.push([done, total, charaNo]),
    });
    expect(progress).toEqual([
      [2, 4, 11],
      [4, 4, 22],
    ]);
  });

  it('确实让出了宏任务：预排的 setImmediate 在第二段回放前烧掉', async () => {
    const events: string[] = [];
    const immediate = new Promise<void>((resolve) => {
      setImmediate(() => {
        events.push('immediate');
        resolve();
      });
    });
    await runArchiveScan({
      characters: chars([1, '甲']),
      namesFor: () => ['A', 'B', 'C', 'D'],
      yieldEvery: 1,
      replayFor: async (_charaNo, name) => {
        events.push(`replay:${name}`);
        return exactReplay();
      },
    });
    await immediate;
    expect(events.indexOf('immediate')).toBeGreaterThan(-1);
    // 每段让出 ⇒ 测试先排的 setImmediate 在第二段回放前就烧掉了
    expect(events.indexOf('immediate')).toBeLessThan(events.indexOf('replay:B'));
  });
});

describe('runArchiveScan 时钟与规模', () => {
  it('elapsedMs 用注入时钟（起止各读一次）；时钟倒退则钳到 0', async () => {
    const times = [1000, 1234];
    const forward = await runArchiveScan({
      characters: [],
      namesFor: () => [],
      replayFor: async () => null,
      now: () => times.shift()!,
    });
    expect(forward.elapsedMs).toBe(234);

    const back = [5000, 4000];
    const backward = await runArchiveScan({
      characters: [],
      namesFor: () => [],
      replayFor: async () => null,
      now: () => back.shift()!,
    });
    expect(backward.elapsedMs).toBe(0);
  });

  it('worst 上限 30：40 段只列前 30，计数仍覆盖全部', async () => {
    const names = Array.from({ length: 40 }, (_, i) => `F${String(i).padStart(2, '0')}`);
    const summary = await runArchiveScan({
      characters: chars([1, '甲']),
      namesFor: () => names,
      perCharCap: names.length,
      replayFor: async (_charaNo, name) => {
        const i = Number(name.slice(1));
        return makeReplay('unknown', { total: 40, hit: 0, miss: 0, unknown: i + 1 });
      },
    });

    const row = summary.rows[0]!;
    expect(row.total).toBe(40);
    expect(row.unknown).toBe(40);
    expect(row.worst).toHaveLength(30);
    expect(row.worst[0]!.name).toBe('F39');
    expect(row.worst.at(-1)!.name).toBe('F10');
  });

  it('1000 段量级：计数 / 行数 / 预算都对，且只排每角色自己的行', async () => {
    const perChar = 100;
    const characterSpecs = Array.from({ length: 10 }, (_, i) => [i + 1, `角色${i}`] as [number, string]);
    let calls = 0;
    const summary = await runArchiveScan({
      characters: chars(...characterSpecs),
      namesFor: (charaNo) => Array.from({ length: perChar }, (_, i) => `${charaNo}-${i}`),
      perCharCap: perChar,
      replayFor: async (_charaNo, name) => {
        calls += 1;
        const i = Number(name.split('-')[1]);
        // 每 10 段里 1 段全未知，其余确定
        return i % 10 === 0 ? unknownReplay(3) : exactReplay(3);
      },
      yieldEvery: 1000,
    });

    expect(calls).toBe(1000);
    expect(summary).toMatchObject({
      scannedChars: 10,
      skippedChars: 0,
      replayedFunctions: 1000,
      totalFunctions: 1000,
      cap: 1000,
      cancelled: false,
      timedOut: 0,
      stoppedReason: null,
    });
    expect(summary.rows).toHaveLength(10);
    for (const row of summary.rows) {
      expect(row.total).toBe(100);
      expect(row.unknown).toBe(10);
      expect(row.exact).toBe(90);
      expect(row.worst).toHaveLength(30);
      // 10 段全未知排最前；unknown = 0 的行不剔除，只是排后（batch.ts 既有口径）
      expect(row.worst.filter((r: BatchRow) => r.confidence === 'unknown')).toHaveLength(10);
      expect(row.worst[0]!.confidence).toBe('unknown');
      expect(row.worst.at(-1)!.confidence).toBe('exact');
    }
  });
});

describe('runArchiveScan 病态段落防护（2026-11-05 边界批：单段超时 / 连续超时放弃 / 墙钟上限）', () => {
  const ch = (charaNo: number): { charaNo: number; name: string } => ({ charaNo, name: `K${charaNo}` });

  it('单段不 resolve → 记 unknown + timedOut，扫描继续（不卡死整档）', async () => {
    const calls: string[] = [];
    const summary = await runArchiveScan({
      characters: [ch(1)],
      namesFor: () => ['A', 'HANG', 'B'],
      replayFor: async (_no, name) => {
        calls.push(name);
        if (name === 'HANG') return new Promise<null>(() => {}); // 永不 resolve
        return exactReplay(1);
      },
      segmentTimeoutMs: 25,
      perCharCap: 3,
    });
    expect(calls).toEqual(['A', 'HANG', 'B']); // 超时后照常扫下一段
    expect(summary.rows[0]).toMatchObject({ total: 3, exact: 2, unknown: 1, timedOut: 1 });
    expect(summary.timedOut).toBe(1);
    expect(summary.stoppedReason).toBeNull();
  });

  it('同一角色连续超时 2 次 → 放弃该角色剩余段（后续角色照常扫）', async () => {
    const seen: number[] = [];
    const summary = await runArchiveScan({
      characters: [ch(1), ch(2)],
      namesFor: (no) => (no === 1 ? ['H1', 'H2', 'H3', 'H4', 'H5'] : ['OK']),
      replayFor: async (no, name) => {
        seen.push(no);
        if (no === 1) return new Promise<null>(() => {});
        return exactReplay(1);
      },
      segmentTimeoutMs: 15,
      perCharCap: 5,
    });
    // 角色 1 只尝试 2 段（连续超时即放弃），角色 2 正常
    expect(seen.filter((n) => n === 1)).toHaveLength(2);
    expect(seen).toContain(2);
    expect(summary.rows[0]).toMatchObject({ charaNo: 1, total: 2, unknown: 2, timedOut: 2 });
    expect(summary.rows[1]).toMatchObject({ charaNo: 2, total: 1, exact: 1 });
  });

  it('撞墙钟上限 → stoppedReason = deadline，已扫部分保留', async () => {
    let now = 0;
    const summary = await runArchiveScan({
      characters: [ch(1)],
      namesFor: () => ['A', 'B', 'C', 'D', 'E'],
      replayFor: async () => {
        now += 60; // 每段 60ms，deadline 100ms ⇒ 第 2 段前就超时
        return exactReplay(1);
      },
      perCharCap: 5,
      deadlineMs: 100,
      now: () => now,
    });
    expect(summary.stoppedReason).toBe('deadline');
    expect(summary.cancelled).toBe(false);
    expect(summary.replayedFunctions).toBeLessThan(5); // 没扫完
    expect(summary.rows[0]!.exact).toBeGreaterThan(0); // 已扫部分保留
  });
});
