/**
 * PS-12 读数用例（**只在串行计时池跑**：`pnpm test:perf`，或
 * `node --expose-gc node_modules/vitest/vitest.mjs run --config vitest.perf.config.ts packages/app/tests/ps12-model-lru.perf.test.ts`
 * ——不带 perf 配置跑会得到 "No test files found"，不是用例没了）。
 *
 * 「开 N 个大文件 → 关 → 重开」的 A/B（同盘同数据同进程交替取样）：
 * - A = 改前口径（三探针不注入 ⇒ 冷档禁用，release 归零即 dispose）；
 * - B = PS-12 冷档（干净件关标签进有界冷档，重开复活）。
 *
 * 判的是**结构不变量**（重开读盘趟数 N→0、model 实例同一性、内存驻留差），
 * 墙钟只留读数 + 一条数量级差的安全闸（重开延迟差 3 个数量级，非 ~25ms 尺度的
 * 比值闸，不会随负载翻线——PITFALLS 88 的纪律）。真壳里冷档还免去 Monarch
 * tokenization 全篇首扫（node 侧 mock 无 Monarch，量不到、不吹数）。
 *
 * 内存面：计时池（forks）的 worker **不继承**主进程的 `--expose-gc`，而 node 24 已
 * 移除 `v8.gc` 导出（PS-2 那套「`globalThis.gc` 在场才钉」的门在本池实跑 `n/a(no gc)`，
 * 从未生效）。所以本文件的内存判据不押在 heapUsed 上，而是钉**账面上界**——
 * 「开 40 个大文件全关 ⇒ 冷档存活面 ≤ 数量/预算双上限」（这是比水位读数更强、
 * 且不受 V8 回收时机影响的不变量）；heapUsed 只作读数（gc 在场时更干净）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Kernel } from '@kojo/kernel';
import type * as Monaco from '../src/monaco/entry';
import type { PoolDeps } from '../src/ui/editor-model-pool';
import { COLD_CACHE_BUDGET_UNITS, COLD_CACHE_MAX_MODELS, createEditorModelPool } from '../src/ui/editor-model-pool';

type ITextModel = Monaco.editor.ITextModel;

/** 计时池 worker 里拿不到；直跑主进程（node --expose-gc）时在场。水位读数只在它
 * 在场时可信——**关后水位**在计时池里恒不可信（forks worker 无 gc，死串收不掉），
 * 所以内存判据全部钉在账面上界（见文件头），heapUsed 只报「活动峰值」这类
 * 由活动引用担保的增量读数。 */
const gcMaybe = (globalThis as { gc?: () => void }).gc;

/** 中位数取样（压掉 JIT 冷启动的毛刺；本池串行静默，无互相饿死） */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/**
 * 合成大文件：200,000 码元（Latin1 单字节 ⇒ 每份 ~200 KB 磁盘/堆），行形态照真实
 * 语料（`@M_KOJO_K*_C*` 函数头 + CJK 台词行）。6 份 = 1.2 M 码元，全部在冷档
 * 预算（4 M）与数量上限（8 份）之内 ⇒ B 场景全额驻留。
 */
function synthFile(units: number): string {
  const parts: string[] = [];
  let used = 0;
  for (let i = 1; used < units; i++) {
    const line = i % 20 === 0 ? `@M_KOJO_K${i % 90}_C${i % 40}` : ` PRINTL 第${i}行台词，写满一行到两三百字码元的量级。`;
    parts.push(line, '\r\n');
    used += line.length + 2;
  }
  return parts.join('');
}

const FILES = 6;
const UNITS = 200_000;

interface Rig {
  pool: ReturnType<typeof createEditorModelPool>;
  kernel: Kernel;
  readCalls: () => number;
  models: { model: { getValue(): string }; disposed: () => boolean }[];
}

/** 真读盘 harness：readText = node fs 原生读（改前/改后同一条读路径，别造假延迟） */
function rig(dir: string, cold: boolean): Rig {
  const models: Rig['models'] = [];
  let reads = 0;
  const bus = {
    on: (_name: string, _cb: (ev: unknown) => void) => () => {},
  };
  const kernel = (cold ? { bus } : {}) as unknown as Kernel;
  const deps: PoolDeps = {
    readText: async (_k: Kernel, path: string) => {
      reads += 1;
      return { text: readFileSync(path, 'utf8'), encoding: 'utf-8', eol: 'CRLF' };
    },
    createModel: (path: string, text: string) => {
      const mock = {
        text,
        isDisposedFlag: false,
        getValue: () => text,
        getValueLength: () => text.length,
        getAlternativeVersionId: () => 1,
        onDidChangeContent: () => ({ dispose: () => {} }),
        dispose: () => {
          mock.isDisposedFlag = true;
        },
      };
      void path;
      models.push({ model: mock, disposed: () => mock.isDisposedFlag });
      return mock as unknown as ITextModel;
    },
  };
  if (cold) {
    // 冷档开启态：三探针齐（干净判据恒真——mock 版本号 1 与保存点 1 对齐）
    deps.modelUnits = (m) => m.getValueLength();
    deps.modelVersion = (m) => m.getAlternativeVersionId();
    deps.writeText = async () => {};
  }
  return { pool: createEditorModelPool(deps), kernel, readCalls: () => reads, models };
}

describe('PS-12：开 N 个大文件 → 关 → 重开（A/B 同盘同数据）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps12-pool-'));
  const files: string[] = [];
  for (let i = 0; i < FILES; i++) {
    const p = join(dir, `big${i}.erb`);
    writeFileSync(p, synthFile(UNITS), 'utf8');
    files.push(p);
  }

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function openAll(r: Rig): Promise<void> {
    for (const p of files) {
      const entry = await r.pool.acquire(r.kernel, p);
      r.pool.setBaseline(p, entry.model.getAlternativeVersionId());
    }
  }

  function closeAll(r: Rig): void {
    for (const p of files) r.pool.release(p);
  }

  async function reopen(r: Rig): Promise<number[]> {
    // 重开段墙钟：逐文件 acquire（A = 读盘+建档；B = 冷档复活）
    const times: number[] = [];
    for (const p of files) {
      const t0 = performance.now();
      await r.pool.acquire(r.kernel, p);
      times.push(performance.now() - t0);
    }
    for (const p of files) r.pool.release(p);
    return times;
  }

  it('结构不变量：重开读盘趟数 N→0、model 同一性、冷档账面', async () => {
    const a = rig(dir, false);
    await openAll(a);
    closeAll(a);
    expect(a.models.every((m) => m.disposed())).toBe(true); // 改前：归零即死
    await reopen(a);
    expect(a.readCalls()).toBe(FILES * 2); // 首开 + 重开各一趟读盘

    const b = rig(dir, true);
    const first = await Promise.all(files.map((p) => b.pool.acquire(b.kernel, p)));
    for (const [i, p] of files.entries()) b.pool.setBaseline(p, first[i]!.model.getAlternativeVersionId());
    closeAll(b);
    expect(b.models.every((m) => !m.disposed())).toBe(true); // 冷档驻留
    expect(b.pool.stats()).toMatchObject({ coldModels: FILES, activeModels: 0 });
    const again = await Promise.all(files.map((p) => b.pool.acquire(b.kernel, p)));
    expect(again.every((e, i) => e === first[i])).toBe(true); // 同一份 model
    expect(b.readCalls()).toBe(FILES); // 重开零读盘
    for (const p of files) b.pool.release(p);
  });

  it('重开延迟（读数 + 数量级差安全闸）', async () => {
    const a = rig(dir, false);
    await openAll(a);
    closeAll(a);
    await reopen(a); // 预热（fs 缓存公平）
    closeAll(a);
    const aTimes: number[] = [];
    for (let i = 0; i < 5; i++) aTimes.push(...(await reopen(a)));

    const b = rig(dir, true);
    await openAll(b);
    closeAll(b);
    await reopen(b);
    const bTimes: number[] = [];
    for (let i = 0; i < 5; i++) bTimes.push(...(await reopen(b)));

    const aMed = median(aTimes);
    const bMed = median(bTimes);
    // 数量级差闸（ms 级读盘 vs µs 级复活）：5× 是数量级差的保守下界，不是精调的比值闸
    expect(bMed).toBeLessThan(aMed / 5);
    expect(bMed).toBeLessThan(0.5); // 绝对上界：复活是一次 Map 查 + 计数
    console.log(`[PS-12 重开延迟] 改前（读盘+建档）中位数 ${aMed.toFixed(3)}ms → 冷档复活 ${bMed.toFixed(4)}ms（${(aMed / Math.max(bMed, 1e-6)).toFixed(0)}×）`);
    console.log(`[PS-12 重开延迟] 改前 p95 ${[...aTimes].sort((x, y) => x - y)[Math.floor(aTimes.length * 0.95)]!.toFixed(3)}ms / 冷档 p95 ${[...bTimes].sort((x, y) => x - y)[Math.floor(bTimes.length * 0.95)]!.toFixed(4)}ms`);
  });

  it('内存上界判据：开 40 个大文件全关 ⇒ 冷档钳在预算内（驻留不随开过的文件数单调涨）', async () => {
    // 独立负载：40 份 × 1.3 M 码元（单份在 1.5 M 上限内；合计 52 M ≫ 4 M 全档预算）
    const dir2 = mkdtempSync(join(tmpdir(), 'ps12-heap-'));
    const bigFiles: string[] = [];
    for (let i = 0; i < 40; i++) {
      const p = join(dir2, `huge${i}.erb`);
      writeFileSync(p, synthFile(1_300_000), 'utf8');
      bigFiles.push(p);
    }
    const heap = (): number => {
      gcMaybe?.();
      gcMaybe?.();
      return process.memoryUsage().heapUsed;
    };

    try {
      // B（冷档）：同负载开关一轮——冷档恒被预算钳住
      const b = rig(dir2, true);
      const bHeap0 = heap();
      for (const p of bigFiles) {
        const e = await b.pool.acquire(b.kernel, p);
        b.pool.setBaseline(p, e.model.getAlternativeVersionId());
      }
      const openRetained = heap() - bHeap0; // 开着 40 份的峰值：活动引用担保的真实增量
      for (const p of bigFiles) b.pool.release(p);
      const st = b.pool.stats();

      // 改前口径对照组：同负载下全 dispose（存活面必须为 0）
      const a = rig(dir2, false);
      for (const p of bigFiles) {
        const e = await a.pool.acquire(a.kernel, p);
        a.pool.setBaseline(p, e.model.getAlternativeVersionId());
      }
      for (const p of bigFiles) a.pool.release(p);
      expect(a.models.filter((m) => !m.disposed())).toHaveLength(0);

      // 本体判据（比 heapUsed 更强更稳，不受 V8 回收时机影响）：关掉的 40 份里
      // 存活面被钳在数量/预算双上限内——「开 N 个大文件 → 关」在关掉侧不再单调涨。
      expect(st.coldModels).toBeLessThanOrEqual(COLD_CACHE_MAX_MODELS);
      expect(st.coldUnits).toBeLessThanOrEqual(COLD_CACHE_BUDGET_UNITS);
      expect(b.models.filter((m) => !m.disposed())).toHaveLength(st.coldModels); // 存活面 = 冷档面，别无他物
      expect(st.coldUnits).toBeGreaterThan(0); // 预算内仍在缓存（不是全禁用）
      // 冷档驻留上界由此钉死：≤ COLD_CACHE_BUDGET_UNITS 码元（V8 ≤2 B/码元 ⇒ ≤8 MB）
      console.log(`[PS-12 内存] 40×1.3M 码元全关：冷档钳制 ${st.coldModels} 份 / ${st.coldUnits} 码元（上限 ${COLD_CACHE_MAX_MODELS} 份 / ${COLD_CACHE_BUDGET_UNITS} 码元 ⇒ 关掉侧驻留上界 ≤8 MB，与开过多少文件无关）；对照：改前口径同负载存活面 0；开着 40 份时活动正文增量 ~${(openRetained / 1048576).toFixed(1)} MB（活动面归作者，stats()/超阈 warn 可见）`);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});