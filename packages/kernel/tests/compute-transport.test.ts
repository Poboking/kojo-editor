/**
 * 并行运输层测试（2026-10-12「内核优化」批）。
 *
 * 用 `node:worker_threads` 的**真线程**（eval 模式）当 worker 侧，验证的是：
 * 协议往返 / id 不错配 / 错误传播 / 未知 kind / 池侧分发与**回退**语义。
 * 生产侧的差异只剩"用 DOM Worker 构造"这一行（由 app 装配）。
 */
import { describe, expect, it } from 'vitest';
import { Worker as NodeWorker } from 'node:worker_threads';
import {
  createWorkerTransport,
  handleComputeRequest,
  type ComputeTaskTable,
  type ComputeWorkerLike,
} from '@kojo/plugin-api';
import { createComputePool } from '../src/compute';

/**
 * worker 侧代码（node eval 模式）：与 `handleComputeRequest` 逐行等价，
 * 正是 app 的 worker 入口要写的那几行（收到 `{id,kind,payload}` → 回 `{id,result|error}`）。
 */
const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const tasks = {
  echo: (p) => p,
  double: (p) => p * 2,
  slow: async (p) => { await new Promise((r) => setTimeout(r, p)); return 'slow-done'; },
  throws: () => { throw new Error('task boom'); },
  which: () => (workerData && workerData.idx) || 0,
};
parentPort.on('message', async (data) => {
  if (!data || typeof data.kind !== 'string') return;
  const impl = tasks[data.kind];
  if (!impl) { parentPort.postMessage({ id: data.id, error: 'unknown compute task kind: ' + data.kind }); return; }
  try {
    parentPort.postMessage({ id: data.id, result: await impl(data.payload) });
  } catch (err) {
    parentPort.postMessage({ id: data.id, error: String(err && err.message ? err.message : err) });
  }
});
`;

/** 把 node 线程包装成本模块约定的最小 Worker 面（真线程，不是 mock） */
function nodeWorkerLike(w: NodeWorker): ComputeWorkerLike {
  const addEventListener = ((type: string, handler: (ev: unknown) => void) => {
    if (type === 'message') w.on('message', (data: unknown) => handler({ data }));
    else w.on('error', (err: unknown) => handler(err));
  }) as ComputeWorkerLike['addEventListener'];
  return {
    postMessage: (data) => w.postMessage(data),
    addEventListener,
    terminate: () => {
      void w.terminate();
    },
  };
}

/** 每次工厂调用造一个新线程，并带上槽号（供"多槽轮转"断言） */
const mkSpawn = (): (() => ComputeWorkerLike) => {
  let idx = 0;
  return () => nodeWorkerLike(new NodeWorker(WORKER_CODE, { eval: true, workerData: { idx: idx++ } }));
};

const spawn = (): ComputeWorkerLike => mkSpawn()();

describe('handleComputeRequest（worker 侧协议，纯函数）', () => {
  const tasks: ComputeTaskTable = {
    double: (p) => (p as number) * 2,
    throws: () => {
      throw new Error('nope');
    },
  };

  it('正常：{id, result}', async () => {
    expect(await handleComputeRequest(tasks, { id: 7, kind: 'double', payload: 21 })).toEqual({
      id: 7,
      result: 42,
    });
  });

  it('未知 kind：{id, error}（不抛）', async () => {
    const r = await handleComputeRequest(tasks, { id: 1, kind: 'nope', payload: null });
    expect(r).toEqual({ id: 1, error: expect.stringContaining('unknown compute task kind') });
  });

  it('任务抛错：{id, error}（不炸 worker）', async () => {
    const r = await handleComputeRequest(tasks, { id: 2, kind: 'throws', payload: null });
    expect(r).toEqual({ id: 2, error: 'nope' });
  });

  it('畸形请求：回 id=-1 的 error（宿主侧会丢弃）', async () => {
    expect(await handleComputeRequest(tasks, null)).toEqual({ id: -1, error: 'malformed compute request' });
    expect(await handleComputeRequest(tasks, { kind: 'double' })).toEqual({
      id: -1,
      error: 'malformed compute request',
    });
  });
});

describe('createWorkerTransport（真线程往返）', () => {
  it('单任务真跨线程往返', async () => {
    const t = createWorkerTransport(spawn);
    try {
      expect(t.available).toBe(true);
      await expect(t.invoke('double', 21)).resolves.toBe(42);
      await expect(t.invoke('echo', { a: [1, 2, 3] })).resolves.toEqual({ a: [1, 2, 3] });
    } finally {
      t.dispose();
    }
  });

  it('并发多任务：id 单调递增，结果不错配', async () => {
    const t = createWorkerTransport(spawn);
    try {
      const out = await Promise.all([
        t.invoke('echo', 'A'),
        t.invoke('slow', 5),
        t.invoke('echo', 'B'),
        t.invoke('double', 3),
      ]);
      expect(out).toEqual(['A', 'slow-done', 'B', 6]);
    } finally {
      t.dispose();
    }
  });

  it('任务抛错 → reject 且携带原消息（不静默）', async () => {
    const t = createWorkerTransport(spawn);
    try {
      await expect(t.invoke('throws', null)).rejects.toThrow('task boom');
      await expect(t.invoke('unknown-kind', null)).rejects.toThrow(/unknown compute task kind/);
    } finally {
      t.dispose();
    }
  });

  it('dispose 后判定不可用', async () => {
    const t = createWorkerTransport(spawn);
    t.dispose();
    expect(t.available).toBe(true); // 未崩溃前仍"可用"，但下一次调用会自行重建/失败
    await expect(t.invoke('double', 1)).resolves.toBe(2); // 重建 worker 后照常工作
    t.dispose();
  });

  it('多槽轮转：size=2 → 请求轮流落到两个真线程（这才是"真并行提速"的来源）', async () => {
    const t = createWorkerTransport(mkSpawn(), { size: 2 });
    try {
      const out = await Promise.all([
        t.invoke('which', null),
        t.invoke('which', null),
        t.invoke('which', null),
        t.invoke('which', null),
      ]);
      expect(out).toEqual([0, 1, 0, 1]);
    } finally {
      t.dispose();
    }
  });

  it('size 缺省 = 1（单槽；语义等同"换个线程跑，不减少总 CPU"）', async () => {
    const t = createWorkerTransport(mkSpawn());
    try {
      const out = await Promise.all([t.invoke('which', null), t.invoke('which', null)]);
      expect(out).toEqual([0, 0]);
    } finally {
      t.dispose();
    }
  });

  it('dispose 会 reject 在途请求（不挂起调用方）——审修补丁回归', async () => {
    const t = createWorkerTransport(spawn);
    const p = t.invoke('slow', 60); // 60ms 才完成的慢任务
    await new Promise((r) => setTimeout(r, 5)); // 确保请求已到达 worker
    t.dispose();
    await expect(p).rejects.toThrow(/disposed/);
  });
});

describe('ComputePool.offload（分发 + 回退）', () => {
  it('无运输层 → 本地实现（inline 计数）', async () => {
    const pool = createComputePool();
    pool.registerTask('t', ((p: number) => p + 1) as never);
    expect(pool.parallel()).toBe(false);
    await expect(pool.offload<number>('t', 1)).resolves.toBe(2);
    expect(pool.stats().offload).toMatchObject({ dispatched: 0, inline: 1, fellBack: 0 });
  });

  it('未注册 kind 且无运输层 → 显式抛错（不静默返回 undefined）', async () => {
    const pool = createComputePool();
    await expect(pool.offload('missing', null)).rejects.toThrow(/No local implementation/);
  });

  it('接上运输层 → 走通道；本地实现仍在（回退用）', async () => {
    const pool = createComputePool();
    const transport = createWorkerTransport(spawn);
    pool.registerTask('echo', ((p: unknown) => `local:${String(p)}`) as never);
    pool.attachTransport(transport);
    try {
      expect(pool.parallel()).toBe(true);
      await expect(pool.offload('echo', 'X')).resolves.toBe('X'); // 来自 worker，不是 local:
      expect(pool.stats().offload).toMatchObject({ parallel: true, dispatched: 1, fellBack: 0 });
    } finally {
      transport.dispose();
    }
  });

  it('通道连续失败 → 回退本地实现，达上限后停用通道（宁可慢，不可错）', async () => {
    const pool = createComputePool();
    // 故意指向一个不存在的 worker 文件：invoke 必失败
    const bad = createWorkerTransport(() => {
      throw new Error('spawn failed');
    });
    pool.registerTask('echo', ((p: unknown) => `local:${String(p)}`) as never);
    pool.attachTransport(bad);

    await expect(pool.offload('echo', 1)).resolves.toBe('local:1');
    await expect(pool.offload('echo', 2)).resolves.toBe('local:2');
    await expect(pool.offload('echo', 3)).resolves.toBe('local:3');
    const st = pool.stats().offload;
    expect(st.fellBack).toBe(3);
    expect(st.inline).toBe(3);
    expect(st.parallel).toBe(false); // 连续失败 3 次后停发
    // 停发后不再有回退计数（直接内联）
    await expect(pool.offload('echo', 4)).resolves.toBe('local:4');
    expect(pool.stats().offload.fellBack).toBe(3);
  });

  it('批量分窗并发 + offload 组合：保住 IPC 并行度又真并行算', async () => {
    const pool = createComputePool();
    const transport = createWorkerTransport(spawn);
    pool.registerTask('double', ((p: number) => p * 2) as never);
    pool.attachTransport(transport);
    try {
      const out = await pool.runSliced(
        [1, 2, 3, 4, 5],
        { concurrency: 3, sliceMs: 0, label: 'offload.batch' },
        (n) => pool.offload<number>('double', n),
      );
      expect(out).toEqual([2, 4, 6, 8, 10]);
      expect(pool.stats().offload.dispatched).toBe(5);
    } finally {
      transport.dispose();
    }
  });

  it('换通道时在途任务 reject 并回退本地实现（attachTransport 安全）——审修补丁回归', async () => {
    const pool = createComputePool();
    pool.registerTask('slow', ((ms: number) => `local-after-${ms}`) as never);
    const first = createWorkerTransport(spawn);
    pool.attachTransport(first);
    const p = pool.offload<string>('slow', 80); // 已派往 first 的慢任务
    await new Promise((r) => setTimeout(r, 5));
    const second = createWorkerTransport(spawn);
    pool.attachTransport(second); // 换通道 → dispose first → 在途任务被 reject
    await expect(p).resolves.toBe('local-after-80'); // 池回退本地实现，调用方拿到结果
    expect(pool.stats().offload.fellBack).toBe(1);
    second.dispose();
  });
});
