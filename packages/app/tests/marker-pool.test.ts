/**
 * 装饰热路径（PERF-4）单测：分层派发 / (path, versionId) 缓存 / 陈旧丢弃。
 *
 * 用**真的计算池**（`createComputePool`）+ 一个"像 worker"的假运输层：
 * 假通道把执行推到**下一个宏任务**（`setTimeout(0)`），这正是真 worker 的时序形状——
 * 于是"同步装饰轮里到底跑了没有"这件事可以被断言，而不是被相信。
 */
import { describe, expect, it, vi } from 'vitest';
import { createComputePool } from '@kojo/kernel';
import type { ComputePayload, ComputeTransport, GameProject, LineDecoration } from '@kojo/plugin-api';
import { createMarkerRunner, type MarkerContributor } from '../src/ui/marker-pool';

/** 一条贡献的测试替身：数出它被"就地"调了几次 */
function contributor(
  id: string,
  opts: { offloadKind?: string; make?: (n: number) => LineDecoration[]; throws?: boolean } = {},
): MarkerContributor & { calls: number } {
  const self = {
    id,
    ...(opts.offloadKind === undefined ? {} : { offloadKind: opts.offloadKind }),
    calls: 0,
    decorate: () => {
      self.calls++;
      if (opts.throws) throw new Error(`${id} 炸了`);
      return opts.make?.(self.calls) ?? [];
    },
  };
  return self as unknown as MarkerContributor & { calls: number };
}

/** 只带三个语义的假项目（缓存判据只看 adapterId / rootDir / inputDigest） */
function project(inputDigest?: string): GameProject {
  return {
    adapterId: 'generic',
    rootDir: '/game',
    kojoPaths: ['/game/ERB'],
    writablePaths: [],
    charaIndex: new Map(),
    ...(inputDigest === undefined ? {} : { inputDigest }),
  } as unknown as GameProject;
}

interface Harness {
  pool: ReturnType<typeof createComputePool>;
  versions: Map<string, number>;
  published: { path: string; decorations: LineDecoration[] }[];
  records: { name: string; ms: number; note?: string }[];
  runner: ReturnType<typeof createMarkerRunner>;
  /** 让出宏任务直到条件成立（假通道的执行点就在下一个宏任务里） */
  settle: () => Promise<void>;
}

function harness(opts: {
  contributors: readonly MarkerContributor[];
  workerKinds?: readonly string[];
  /** kind → 任务实现（模拟 worker 侧那张表；不注册就地会走本地实现） */
  tasks?: Record<string, (payload: ComputePayload) => LineDecoration[]>;
  project?: GameProject | null;
  cacheSize?: number;
} = { contributors: [] }): Harness {
  const pool = createComputePool();
  const workerKinds = new Set(opts.workerKinds ?? Object.keys(opts.tasks ?? {}));
  const versions = new Map<string, number>([['/a.erb', 7]]);
  const published: Harness['published'] = [];
  const records: Harness['records'] = [];
  for (const [kind, impl] of Object.entries(opts.tasks ?? {})) pool.registerTask(kind, impl as never);
  const transport: ComputeTransport = {
    available: true,
    invoke: async (kind, payload) => {
      await new Promise((r) => setTimeout(r, 0)); // 换线程 = 换宏任务
      const impl = (opts.tasks ?? {})[kind];
      if (!impl) throw new Error(`unknown compute task kind: ${kind}`);
      return impl(payload);
    },
  };
  pool.attachTransport(transport);
  const runner = createMarkerRunner({
    compute: pool,
    workerHasTask: (kind) => workerKinds.has(kind),
    contributors: () => opts.contributors,
    project: () => (opts.project === undefined ? project('digest-1') : opts.project),
    versionOf: (path) => versions.get(path),
    publish: (path, decorations) => published.push({ path, decorations }),
    record: (name, ms, note) => records.push({ name, ms, ...(note === undefined ? {} : { note }) }),
    ...(opts.cacheSize === undefined ? {} : { cacheSize: opts.cacheSize }),
  });
  return { pool, versions, published, records, runner, settle: async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); } };
}

const TEXT = 'IF 1 = 1\nENDIF\n';

describe('marker-pool · 分层派发', () => {
  it('未声明 offloadKind 的贡献：同步轮内就地跑完并发布（与改动前逐字一致）', () => {
    const light = contributor('light', { make: () => [{ line: 2, severity: 'warning', message: 'm' }] });
    const h = harness({ contributors: [light] });
    h.runner.refresh('/a.erb', () => TEXT);
    expect(light.calls).toBe(1); // 本轮就完成
    expect(h.published).toHaveLength(1); // 本轮就发布
    expect(h.published[0]!.decorations).toEqual([{ line: 2, severity: 'warning', message: 'm' }]);
    expect(h.records.some((r) => r.name === 'markers.total')).toBe(true);
  });

  it('声明 offloadKind 且 worker 在表：同步轮**一次都不跑**重计算，只装配轻的那一路', () => {
    const light = contributor('light', { make: () => [{ line: 1, severity: 'info', message: 'light' }] });
    const heavy = contributor('heavy', { offloadKind: 'x.heavy', make: () => [{ line: 9, severity: 'error', message: 'heavy' }] });
    let offloadedCalls = 0;
    const h = harness({
      contributors: [light, heavy],
      workerKinds: ['x.heavy'],
      tasks: {
        'x.heavy': () => {
          offloadedCalls++;
          return [{ line: 9, severity: 'error', message: 'heavy' }];
        },
      },
    });
    h.runner.refresh('/a.erb', () => TEXT);
    // 同步轮的观测面：重的一路没被调用、worker 还没收到任务、屏上只有轻的那一档
    expect(heavy.calls).toBe(0);
    expect(offloadedCalls).toBe(0);
    expect(h.published).toHaveLength(1);
    expect(h.published[0]!.decorations).toEqual([{ line: 1, severity: 'info', message: 'light' }]);
    expect(h.runner.stats().dispatched).toBe(1);
  });

  it('worker 回来后按槽位顺序整档替换发布（面板行序不变）', async () => {
    const light = contributor('light', { make: () => [{ line: 1, severity: 'info', message: 'light' }] });
    const heavy = contributor('heavy', { offloadKind: 'x.heavy' });
    const h = harness({
      contributors: [light, heavy],
      workerKinds: ['x.heavy'],
      tasks: { 'x.heavy': () => [{ line: 9, severity: 'error', message: 'heavy' }] },
    });
    h.runner.refresh('/a.erb', () => TEXT);
    await h.settle();
    expect(h.published).toHaveLength(2);
    expect(h.published[1]!.decorations).toEqual([
      { line: 1, severity: 'info', message: 'light' },
      { line: 9, severity: 'error', message: 'heavy' },
    ]);
    expect(h.runner.stats().worker).toBe(1);
  });

  it('载荷只有 {path, text}（不传函数、不传项目）', async () => {
    const heavy = contributor('heavy', { offloadKind: 'x.heavy' });
    let seen: unknown;
    const h = harness({
      contributors: [heavy],
      workerKinds: ['x.heavy'],
      tasks: {
        'x.heavy': (payload) => {
          seen = payload;
          return [];
        },
      },
    });
    h.runner.refresh('/a.erb', () => TEXT);
    await h.settle();
    expect(Object.keys(seen as object).sort()).toEqual(['path', 'text']);
    expect(seen).toEqual({ path: '/a.erb', text: TEXT });
  });

  it('声明了 kind 但 worker 不在表：异步**就地**执行 decorate（仍脱离同步轮）', async () => {
    const heavy = contributor('heavy', { offloadKind: 'sugar.diagnostics', make: () => [{ line: 3, severity: 'error', message: 'inline' }] });
    const h = harness({ contributors: [heavy], workerKinds: [], tasks: {} });
    h.runner.refresh('/a.erb', () => TEXT);
    expect(heavy.calls).toBe(0); // 同步轮里没跑
    expect(h.published).toHaveLength(0); // 也没有可发的半档
    await h.settle();
    expect(heavy.calls).toBe(1);
    expect(h.published).toHaveLength(1);
    const st = h.runner.stats();
    expect(st.inline).toBe(1);
    expect(st.worker).toBe(0);
  });

  it('通道抛错 → 这一路空装饰，其余照常发布（退化可见，不打断编辑）', async () => {
    const light = contributor('light', { make: () => [{ line: 1, severity: 'info', message: 'light' }] });
    const heavy = contributor('heavy', { offloadKind: 'x.heavy' });
    const h = harness({ contributors: [light, heavy], workerKinds: ['x.heavy'], tasks: {} }); // 表里没有 → invoke 抛
    h.runner.refresh('/a.erb', () => TEXT);
    await h.settle();
    expect(h.published).toHaveLength(2);
    expect(h.published[1]!.decorations).toEqual([{ line: 1, severity: 'info', message: 'light' }]);
  });

  it('就地装饰器抛错 → 不影响其余贡献', () => {
    const boom = contributor('boom', { throws: true });
    const ok = contributor('ok', { make: () => [{ line: 4, severity: 'warning', message: 'ok' }] });
    const h = harness({ contributors: [boom, ok] });
    h.runner.refresh('/a.erb', () => TEXT);
    expect(h.published[0]!.decorations).toEqual([{ line: 4, severity: 'warning', message: 'ok' }]);
  });
});

describe('marker-pool · (path, versionId) 缓存', () => {
  it('同版本第二次触发：装饰计算 0 次、文本读取 0 次、照样发布同一整档', async () => {
    const light = contributor('light', { make: () => [{ line: 1, severity: 'info', message: 'light' }] });
    const heavy = contributor('heavy', { offloadKind: 'x.heavy' });
    const h = harness({
      contributors: [light, heavy],
      workerKinds: ['x.heavy'],
      tasks: { 'x.heavy': () => [{ line: 9, severity: 'error', message: 'heavy' }] },
    });
    const readText = vi.fn(() => TEXT);
    h.runner.refresh('/a.erb', readText);
    await h.settle();
    const computedAfterFirst = light.calls + h.runner.stats().worker;
    readText.mockClear();
    h.published.length = 0;

    h.runner.refresh('/a.erb', readText); // 切回未改动的标签
    expect(readText).not.toHaveBeenCalled(); // 连整份文本的取值都没发生
    expect(light.calls + h.runner.stats().worker).toBe(computedAfterFirst); // 装饰计算次数增量 = 0
    expect(h.published).toHaveLength(1);
    expect(h.published[0]!.decorations).toHaveLength(2);
    expect(h.runner.stats().hits).toBe(1);
  });

  it('版本变了 → 不命中缓存（要重算）', async () => {
    const light = contributor('light', { make: () => [{ line: 1, severity: 'info', message: 'x' }] });
    const h = harness({ contributors: [light] });
    h.runner.refresh('/a.erb', () => TEXT);
    expect(h.runner.stats().misses).toBe(1);
    h.runner.refresh('/a.erb', () => TEXT);
    expect(h.runner.stats().hits).toBe(1);
    h.versions.set('/a.erb', 8);
    h.runner.refresh('/a.erb', () => TEXT);
    expect(h.runner.stats().hits).toBe(1);
    expect(h.runner.stats().misses).toBe(2);
  });

  it('贡献签名变了（多了一条 / kind 改了）→ 不许命中旧缓存', async () => {
    const a = contributor('a', { make: () => [{ line: 1, severity: 'info', message: 'a' }] });
    const versions = new Map([['/a.erb', 7]]);
    const list: MarkerContributor[] = [a];
    const h = harness({ contributors: list });
    h.runner.refresh('/a.erb', () => TEXT);
    expect(h.runner.stats().misses).toBe(1);
    // 同一 runner 的贡献表在两次触发之间发生变化（插件晚激活）
    list.push(contributor('b', { make: () => [] }));
    void versions;
    h.runner.refresh('/a.erb', () => TEXT);
    expect(h.runner.stats().hits).toBe(0);
    expect(h.runner.stats().misses).toBe(2);
  });

  it('判据不全（缺 inputDigest / 无项目）→ 一律不缓存', () => {
    const light = contributor('light');
    const noDigest = harness({ contributors: [light], project: project() });
    noDigest.runner.refresh('/a.erb', () => TEXT);
    noDigest.runner.refresh('/a.erb', () => TEXT);
    expect(noDigest.runner.stats().hits).toBe(0);
    expect(noDigest.runner.stats().cached).toBe(0);

    const noProject = harness({ contributors: [light], project: null });
    noProject.runner.refresh('/a.erb', () => TEXT);
    noProject.runner.refresh('/a.erb', () => TEXT);
    expect(noProject.runner.stats().hits).toBe(0);
  });

  it('缓存是半档不许写：异步那几路回来后才算完整条目', async () => {
    const light = contributor('light', { make: () => [{ line: 1, severity: 'info', message: 'light' }] });
    const heavy = contributor('heavy', { offloadKind: 'x.heavy' });
    const h = harness({
      contributors: [light, heavy],
      workerKinds: ['x.heavy'],
      tasks: { 'x.heavy': () => [{ line: 9, severity: 'error', message: 'heavy' }] },
    });
    h.runner.refresh('/a.erb', () => TEXT);
    expect(h.runner.stats().cached).toBe(0); // 半档没进缓存
    h.published.length = 0;
    h.runner.refresh('/a.erb', () => TEXT); // 在途期间再触发 → 仍按未命中处理
    expect(h.runner.stats().hits).toBe(0);
    await h.settle();
    expect(h.runner.stats().cached).toBeGreaterThan(0);
  });

  it('LRU 到容量即淘汰最旧（不无限长）', () => {
    const light = contributor('light', { make: () => [{ line: 1, severity: 'info', message: 'x' }] });
    const h = harness({ contributors: [light], cacheSize: 2 });
    for (const p of ['/1.erb', '/2.erb', '/3.erb']) {
      h.versions.set(p, 1);
      h.runner.refresh(p, () => TEXT);
    }
    expect(h.runner.stats().cached).toBe(2);
    h.published.length = 0;
    h.runner.refresh('/1.erb', () => TEXT); // 已被淘汰 → 重算
    expect(h.runner.stats().hits).toBe(0);
    expect(h.runner.stats().misses).toBe(4);
  });

  it('dropPath 只丢这一条路径的条目（标签关闭）', () => {
    const light = contributor('light', { make: () => [{ line: 1, severity: 'info', message: 'x' }] });
    const h = harness({ contributors: [light] });
    h.versions.set('/b.erb', 1);
    h.runner.refresh('/a.erb', () => TEXT);
    h.runner.refresh('/b.erb', () => TEXT);
    expect(h.runner.stats().cached).toBe(2);
    h.runner.dropPath('/a.erb');
    expect(h.runner.stats().cached).toBe(1);
    h.published.length = 0;
    h.runner.refresh('/b.erb', () => TEXT);
    expect(h.runner.stats().hits).toBe(1);
  });
});

describe('marker-pool · 陈旧丢弃', () => {
  it('异步结果回来时版本已变 → 不进 markers（发布次数不变，问题面板不受污染）', async () => {
    const heavy = contributor('heavy', { offloadKind: 'x.heavy' });
    const h = harness({
      contributors: [heavy],
      workerKinds: ['x.heavy'],
      tasks: { 'x.heavy': () => [{ line: 9, severity: 'error', message: 'stale' }] },
    });
    h.runner.refresh('/a.erb', () => TEXT);
    h.versions.set('/a.erb', 8); // 用户又打了一个字
    await h.settle();
    expect(h.published).toHaveLength(0);
    expect(h.records.some((r) => r.name === 'markers.stale')).toBe(true);
    expect(h.runner.stats().discarded).toBe(1);
    expect(h.runner.stats().cached).toBe(0); // 陈旧结果也不许进缓存
  });

  it('标签关闭（版本取不到）→ 结果一律作废', async () => {
    const heavy = contributor('heavy', { offloadKind: 'x.heavy' });
    const h = harness({
      contributors: [heavy],
      workerKinds: ['x.heavy'],
      tasks: { 'x.heavy': () => [{ line: 9, severity: 'error', message: 'gone' }] },
    });
    h.runner.refresh('/a.erb', () => TEXT);
    h.versions.delete('/a.erb');
    await h.settle();
    expect(h.published).toHaveLength(0);
    expect(h.runner.stats().discarded).toBe(1);
  });

  it('连发多次：在途那一次跑完后只补最新那一次，过期等待者各按自己的版本作废', async () => {
    const heavy = contributor('heavy', { offloadKind: 'x.heavy' });
    let runs = 0;
    const h = harness({
      contributors: [heavy],
      workerKinds: ['x.heavy'],
      tasks: {
        'x.heavy': (payload) => {
          runs++;
          const text = (payload as { text: string }).text;
          return [{ line: text.length, severity: 'error', message: 'heavy' }];
        },
      },
    });
    h.runner.refresh('/a.erb', () => 'v7'); // 这一次已经进在途（runLatest 一旦开跑就不会被跳过）
    h.versions.set('/a.erb', 8);
    h.runner.refresh('/a.erb', () => 'v8-mid'); // 排队期间到达的中间版本
    h.versions.set('/a.erb', 9);
    h.runner.refresh('/a.erb', () => 'v9-latest'); // 只保留最新那一个（尾缘合并）
    await h.settle();
    expect(runs).toBe(2); // 中间版本被合并掉：三次触发只落到"在途 + 最新"两次执行
    expect(h.published).toHaveLength(1);
    expect(h.published[0]!.decorations[0]!.line).toBe('v9-latest'.length);
    expect(h.runner.stats().discarded).toBe(2); // v7 与 v8 的结果都不许上屏
  });

  it('刷新时取不到 model（未打开 / 已 dispose）→ 什么都不做', () => {
    const light = contributor('light');
    const h = harness({ contributors: [light] });
    h.runner.refresh('/not-open.erb', () => TEXT);
    expect(light.calls).toBe(0);
    expect(h.published).toHaveLength(0);
  });
});
