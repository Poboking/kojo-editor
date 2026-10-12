/**
 * 内核计算池单测（2026-10-12「内核优化」批）。
 *
 * 这组钉死的是**调度语义**（与"跑在哪"无关）：
 * 时间片让路 / 交互档优先让路 / 单飞 + 尾缘合并 / 统计 / 错误传播 / 保序。
 */
import { describe, expect, it } from 'vitest';
import { createComputePool } from '../src/compute';

/** 宏任务边界：把挂起的微任务全部排空（比 await Promise.resolve() 稳） */
const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

describe('yieldToMain', () => {
  it('可等待，且并发等待者都能被唤醒（不丢唤醒、不死锁）', async () => {
    const pool = createComputePool();
    await pool.yieldToMain();
    await Promise.all([pool.yieldToMain(), pool.yieldToMain(), pool.yieldToMain()]);
  });

  it('让路是**异步**的：await 之后的代码不会同步跑（真的交还了控制权）', async () => {
    const pool = createComputePool();
    const order: string[] = [];
    void (async () => {
      await pool.yieldToMain();
      order.push('after-yield');
    })();
    order.push('sync');
    expect(order).toEqual(['sync']); // 同步阶段还没轮到 after-yield
    // 再让一次路：等待者按 FIFO 唤醒，前一个的续体必然先跑完
    await pool.yieldToMain();
    expect(order).toEqual(['sync', 'after-yield']);
  });

  it('分片期间其他异步工作能夹在中间推进 —— 这就是"即点即现"的机制', async () => {
    // 注：这里不测「定时器插队」——Node 的 MessagePort 调度与 Chromium 的任务源调度
    // 不同（前者会压过 timers）。可验证且真正要紧的性质是：**让路确实把控制权交了出去**，
    // 别的异步工作能在背景任务的过程中推进，而不是等它跑完。
    const pool = createComputePool();
    const order: string[] = [];
    const other = (async () => {
      for (let i = 0; i < 3; i++) {
        await Promise.resolve();
        order.push(`other${i}`);
      }
    })();
    const bg = pool.runSliced(
      [1, 2, 3, 4, 5],
      { sliceMs: 0, label: 'bg' },
      (n) => {
        order.push(`item${n}`);
        return n;
      },
    );
    await Promise.all([other, bg]);
    const between = order.slice(order.indexOf('item1'), order.indexOf('item5'));
    expect(between.some((x) => x.startsWith('other'))).toBe(true);
  });
});

describe('runSliced（保序分片）', () => {
  it('保序且返回值与入参一一对应（同步 / 异步 fn 都支持）', async () => {
    const pool = createComputePool();
    const sync = await pool.runSliced([3, 1, 2], { sliceMs: 1000 }, (n) => n * 2);
    expect(sync).toEqual([6, 2, 4]);
    const asyncOut = await pool.runSliced([1, 2], { sliceMs: 1000 }, async (n) => `v${n}`);
    expect(asyncOut).toEqual(['v1', 'v2']);
  });

  it('空输入 → 空结果，零让路', async () => {
    const pool = createComputePool();
    expect(await pool.runSliced([], { sliceMs: 0 }, (n) => n)).toEqual([]);
    expect(pool.stats().yields).toBe(0);
  });

  it('sliceMs=0 → 每项之间都让路（末项不空让）', async () => {
    const pool = createComputePool();
    await pool.runSliced([1, 2, 3, 4, 5], { sliceMs: 0, label: 'sliced' }, (n) => n);
    const st = pool.stats().tasks.find((t) => t.label === 'sliced')!;
    expect(st.items).toBe(5);
    expect(st.slices).toBe(4);
    expect(st.yields).toBe(4);
  });

  it('预算充裕 → 一次跑完、不让路', async () => {
    const pool = createComputePool();
    await pool.runSliced([1, 2, 3, 4, 5], { sliceMs: 100_000, label: 'big' }, (n) => n);
    const st = pool.stats().tasks.find((t) => t.label === 'big')!;
    expect(st.yields).toBe(0);
    expect(st.runs).toBe(1);
  });

  it('fn 抛错 → 整体 reject，且统计仍记账（不静默）', async () => {
    const pool = createComputePool();
    await expect(
      pool.runSliced([1, 2, 3], { sliceMs: 0, label: 'boom' }, (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
    const st = pool.stats().tasks.find((t) => t.label === 'boom')!;
    expect(st.items).toBe(1); // 处理到出错那项为止
  });

  it('concurrency>1：窗口内并发、保序、窗口间让路', async () => {
    const pool = createComputePool();
    let inFlight = 0;
    let maxInFlight = 0;
    const out = await pool.runSliced(
      [1, 2, 3, 4, 5, 6, 7],
      { sliceMs: 0, concurrency: 3, label: 'win' },
      async (n) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight--;
        return n * 10;
      },
    );
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]); // 保序（与入参一一对应）
    expect(maxInFlight).toBe(3); // 窗口内并发
    const st = pool.stats().tasks.find((t) => t.label === 'win')!;
    expect(st.items).toBe(7);
    expect(st.yields).toBe(2); // 3 个窗口之间有 2 次让路
  });

  it('concurrency 超出项数时退化为单窗（不空转）', async () => {
    const pool = createComputePool();
    const out = await pool.runSliced([1, 2], { sliceMs: 0, concurrency: 16, label: 'one' }, (n) => n);
    expect(out).toEqual([1, 2]);
    expect(pool.stats().tasks.find((t) => t.label === 'one')!.yields).toBe(0);
  });
});

describe('优先级（交互档优先让路）', () => {
  it('busyInteractive 反映交互档运行态', async () => {
    const pool = createComputePool();
    let release: (() => void) | null = null;
    const p = pool.runSliced([0], { priority: 'interactive' }, async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return 0;
    });
    await tick();
    expect(pool.busyInteractive()).toBe(true);
    release!();
    await p;
    expect(pool.busyInteractive()).toBe(false);
  });

  it('预算远未耗尽，但只要交互档在跑，背景档也必须让路', async () => {
    const pool = createComputePool();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inter = pool.runSliced([0], { priority: 'interactive', sliceMs: 100_000 }, async () => {
      await gate;
      return 0;
    });
    await tick();
    const bg = pool.runSliced([1, 2, 3], { priority: 'background', sliceMs: 100_000, label: 'bg' }, (n) => n);
    release!();
    await Promise.all([inter, bg]);
    const bgStat = pool.stats().tasks.find((t) => t.label === 'bg')!;
    expect(bgStat.yields).toBeGreaterThan(0);
  });

  it('交互档在预算内不让路（它本来就是最急的）', async () => {
    const pool = createComputePool();
    await pool.runSliced([1, 2, 3], { priority: 'interactive', sliceMs: 100_000, label: 'i' }, (n) => n);
    expect(pool.stats().tasks.find((t) => t.label === 'i')!.yields).toBe(0);
  });
});

describe('runLatest（单飞 + 尾缘合并）', () => {
  it('在跑期间的中间请求被跳过，但所有等待者都拿到最新那次的结果', async () => {
    const pool = createComputePool();
    const calls: string[] = [];
    let release: (() => void) | null = null;
    let concurrent = 0;
    let maxConcurrent = 0;

    const mk = (tag: string) =>
      pool.runLatest('k', { sliceMs: 100_000, label: 'latest' }, async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        calls.push(tag);
        if (tag === 'first') {
          await new Promise<void>((r) => {
            release = r;
          });
        }
        concurrent--;
        return tag;
      });

    const p1 = mk('first');
    const p2 = mk('second');
    const p3 = mk('third');
    await tick();
    expect(release).not.toBeNull();
    release!();

    await expect(p1).resolves.toBe('first');
    await expect(p2).resolves.toBe('third'); // 中间版本 'second' 被尾缘合并跳过
    await expect(p3).resolves.toBe('third');

    expect(calls).toEqual(['first', 'third']);
    expect(maxConcurrent).toBe(1); // 单飞
  });

  it('不同 key 互不阻塞', async () => {
    const pool = createComputePool();
    const out = await Promise.all([
      pool.runLatest('a', { sliceMs: 100_000 }, async () => 'A'),
      pool.runLatest('b', { sliceMs: 100_000 }, async () => 'B'),
    ]);
    expect(out).toEqual(['A', 'B']);
  });

  it('fn 抛错 → 当次所有等待者都 reject', async () => {
    const pool = createComputePool();
    const p1 = pool.runLatest('e', { sliceMs: 100_000 }, () => {
      throw new Error('nope');
    });
    const p2 = pool.runLatest('e', { sliceMs: 100_000 }, () => {
      throw new Error('nope');
    });
    await expect(p1).rejects.toThrow('nope');
    await expect(p2).rejects.toThrow('nope');
  });

  it('完成后可再次使用同一 key（槽位不泄漏）', async () => {
    const pool = createComputePool();
    await pool.runLatest('k2', { sliceMs: 100_000 }, async () => 1);
    await expect(pool.runLatest('k2', { sliceMs: 100_000 }, async () => 2)).resolves.toBe(2);
  });
});

describe('stats', () => {
  it('按 label 聚合，可重置', async () => {
    const pool = createComputePool();
    await pool.runSliced([1, 2], { sliceMs: 0, label: 'x' }, (n) => n);
    await pool.runSliced([1, 2], { sliceMs: 0, label: 'x' }, (n) => n);
    const st = pool.stats().tasks.find((t) => t.label === 'x')!;
    expect(st.runs).toBe(2);
    expect(st.items).toBe(4);
    expect(pool.stats().yields).toBe(2);
    pool.resetStats();
    expect(pool.stats().tasks).toEqual([]);
    expect(pool.stats().yields).toBe(0);
  });

  it('缺省 label = anonymous', async () => {
    const pool = createComputePool();
    await pool.runSliced([1], {}, (n) => n);
    expect(pool.stats().tasks[0]!.label).toBe('anonymous');
    expect(pool.stats().tasks[0]!.priority).toBe('background');
  });
});
