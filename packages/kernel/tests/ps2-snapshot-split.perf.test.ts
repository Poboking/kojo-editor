/**
 * PS-2 读数用例（**只在串行计时池跑**：`pnpm test:perf`，或
 * `node --expose-gc node_modules/vitest/vitest.mjs run --config vitest.perf.config.ts packages/kernel/tests/ps2-snapshot-split.perf.test.ts`
 * ——不带 perf 配置跑会得到"PITFALLS 88"的 No test files found，不是用例没了）。
 *
 * 两组 before/after，全部**同盘同数据同进程交替**取样（比值可复现，绝对值只作读数）：
 * 1. `splitPreserveEol`（PS-2③）：430,272 字符 / 12,441 行的语料等效文件上，
 *    旧逐字符 `cur += c` 实现（本文件内联参考实现）vs 新分段一次切。
 *    留存 MB 只在 `--expose-gc` 在场时钉（无 gc 则只报读数、不假断言）。
 * 2. 快照装载（PERF-14 / PS-2①）：~19MB 主快照等效体量的一次完整 `storage.get`，
 *    旧形状（`exists` + `readFileBytes` 两趟）vs 新形状（一趟 `readFilesRaw`）。
 *    本池**判的是结构不变量**（趟数 2→1、解码逐字节同果、三态互不混淆）——墙钟只留读数，
 *    外加一条带绝对噪声下限的回归闸：node 桥没有 IPC 队列，PERF-14 真正省下的"两趟排队税"
 *    在这里**量不到**（真壳同一次装载：node 侧 read+parse 19.6ms vs 壳侧 await 1,406ms），
 *    而 ~25ms 尺度上的 ±15% 比值落在进程噪声里会随负载翻红（实测 29.2 vs 22.1）。
 *    ⇒ 真壳读数不在这里钉，由 `node tools/boot-watermarks.mjs` 复跑、账记 `docs/BOARD.md` §S 的
 *    PERF-14 行。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EolMap } from '../src/encoding';
import { decodeWithProbe, joinPreserveEol, splitPreserveEol } from '../src/encoding';
import { FileStorageBackend, StorageServiceImpl } from '../src/storage';
import { NodeBridge } from './helpers/node-bridge';

const gc = (globalThis as { gc?: () => void }).gc;

/** 中位数取样（3 冷轮之外再取 5 轮，压掉 JIT 冷启动的毛刺） */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** 合成语料：与实测的 430,272 字符 / 12,441 行同尺（CRLF 多数派 + ~10% LF + 零星 CR） */
function synthCorpusFile(): string {
  const lines = 12441;
  const parts: string[] = [];
  for (let i = 0; i < lines; i++) {
    const body = `@M_KOJO_K${i % 90}_C${i % 40} 第${i}行 ` + 'x'.repeat(20 + (i % 13));
    parts.push(body);
    parts.push(i % 10 === 3 ? '\n' : i % 97 === 5 ? '\r' : '\r\n');
  }
  return parts.join('');
}

/** 旧实现（改动前的 `splitPreserveEol` 体，逐字符累加）——before 参照，只在本文件存在 */
function referenceSplitPreserveEol(raw: string): EolMap {
  const parts: string[] = [];
  const terms: string[] = [];
  let cur = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\r') {
      if (raw[i + 1] === '\n') {
        terms.push('\r\n');
        i++;
      } else {
        terms.push('\r');
      }
      parts.push(cur);
      cur = '';
    } else if (c === '\n') {
      terms.push('\n');
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return { parts, terms };
}

/** 留存 MB：保留 COPIES 份映射，尽量 gc 后读 heapUsed（无 gc 返回 null，只报不钉） */
function retainedMB(make: () => EolMap, copies: number): number | null {
  if (!gc) return null;
  gc();
  const before = process.memoryUsage().heapUsed;
  const keep: EolMap[] = [];
  for (let i = 0; i < copies; i++) keep.push(make());
  gc();
  const after = process.memoryUsage().heapUsed;
  void keep.length;
  return (after - before) / (1024 * 1024) / copies;
}

describe('PS-2 读数 · splitPreserveEol（before/after 同场交替）', () => {
  const raw = synthCorpusFile();
  it('新实现逐字等价于旧实现，且墙钟显著更低（430k 字符 / 12.4k 行）', () => {
    expect(raw.length).toBeGreaterThanOrEqual(300_000);
    const ref = referenceSplitPreserveEol(raw);
    const now = splitPreserveEol(raw);
    expect(now).toEqual(ref); // 先证保真，再谈速度
    expect(joinPreserveEol(now)).toBe(raw); // 不变式：逐字节还原

    const REPS = 5;
    const oldMs: number[] = [];
    const newMs: number[] = [];
    for (let r = 0; r < REPS; r++) {
      let t = performance.now();
      referenceSplitPreserveEol(raw);
      oldMs.push(performance.now() - t);
      t = performance.now();
      splitPreserveEol(raw);
      newMs.push(performance.now() - t);
    }
    const o = median(oldMs);
    const n = median(newMs);
    // eslint-disable-next-line no-console
    console.log(
      `[PS-2 split] ${raw.length.toLocaleString()} chars / ${(ref.terms.length + 1).toLocaleString()} lines: ` +
        `old=${o.toFixed(2)}ms new=${n.toFixed(2)}ms speedup=${(o / n).toFixed(1)}× | retained/copy: ` +
        `old=${retainedMB(() => referenceSplitPreserveEol(raw), 24)?.toFixed(2) ?? 'n/a(no gc)'}MB ` +
        `new=${retainedMB(() => splitPreserveEol(raw), 24)?.toFixed(2) ?? 'n/a(no gc)'}MB`,
    );
    expect(n).toBeLessThan(o); // 实测余量 ~7×，15% 的抖动不可能翻线
    const rOld = retainedMB(() => referenceSplitPreserveEol(raw), 24);
    const rNew = retainedMB(() => splitPreserveEol(raw), 24);
    if (rOld !== null && rNew !== null) expect(rNew).toBeLessThan(rOld);
  });
});

describe('PERF-14 读数 · 快照装载（两趟合一趟；~19MB 等效）', () => {
  /** 取样轮数；样本数不足时中位数不作数（下面有 MIN_SAMPLES 拦住"拿一两轮当判据"） */
  const REPS = 5;
  const MIN_SAMPLES = 5;
  /**
   * 墙钟回归闸的**绝对噪声下限**（不是性能目标）：本尺度（一次 ~18MB 装载 ≈ 25ms）上
   * 同进程交替取样的新旧中位数差实测 5–9ms、随机器负载漂 ⇒ 比值闸（≤ 旧 ×1.15）会随机翻线。
   * 留这条只挡"量级回退"（例如把一趟读改成同步整目录重扫），不承诺任何提速——提速由趟数钉。
   */
  const NOISE_FLOOR_MS = 25;

  /** 桥调用计数：判据钉的是**趟数**（与负载无关），不是墙钟 */
  interface TripCount {
    exists: number;
    single: number;
    batch: number;
  }
  const zeroTrips = (): TripCount => ({ exists: 0, single: 0, batch: 0 });
  const resetTrips = (t: TripCount): void => {
    t.exists = 0;
    t.single = 0;
    t.batch = 0;
  };
  /** 一次"读一个键"总共打出去几趟桥调用 */
  const totalTrips = (t: TripCount): number => t.exists + t.single + t.batch;
  /** 只记形状、行为逐字委托 NodeBridge 的计数桥（批量读按**条数**计，与单键等价） */
  function countingBridge(dir: string, trips: TripCount): NodeBridge {
    const counting: NodeBridge = Object.assign(Object.create(NodeBridge.prototype) as NodeBridge, {
      appDataDir: () => Promise.resolve(dir),
      exists: (p: string) => {
        trips.exists++;
        return NodeBridge.prototype.exists.call(counting, p);
      },
      readFileBytes: (p: string) => {
        trips.single++;
        return NodeBridge.prototype.readFileBytes.call(counting, p);
      },
      readFilesRaw: (ps: readonly string[]) => {
        trips.batch += ps.length;
        return NodeBridge.prototype.readFilesRaw.call(counting, ps);
      },
    });
    return counting;
  }

  it('一趟 readFilesRaw 顶替 exists+readFileBytes：每键 2→1、级联 14→7、解码逐字节同果', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kojo-ps2-snap-'));
    try {
      const bridge = new NodeBridge(dir);
      const storage = new StorageServiceImpl(new FileStorageBackend(bridge));
      // 体量对齐真主快照（19,481,357B）：路径表 + 逐条目长文本，JSON.stringify 后 ~19MB
      const entries: Array<{ p: string; t: string }> = [];
      for (let i = 0; i < 2400; i++) {
        entries.push({ p: `C:/game/root/ERB/FILE_${i}.ERB`, t: `@F${i} ` + 'y'.repeat(7600) });
      }
      const payload = { version: 7, rootDir: 'C:/game/root', entries };
      expect(JSON.stringify(payload).length).toBeGreaterThan(18_000_000);
      await storage.scope('erb-parser').set('snapshot', payload);

      const keyFile = join(dir, 'store', 'erb-parser', 'snapshot.json');
      const trips = zeroTrips();
      const counting = countingBridge(dir, trips);
      const cStorage = new StorageServiceImpl(new FileStorageBackend(counting));

      // 旧形状（改动前 storage.read 的体，before 参照，只在本文件存在）：exists 一趟 + readFileBytes 一趟
      // ——刻意走**同一只计数桥**，"2→1"才是同一把尺上的两侧。
      const oldShape = async (): Promise<unknown> => {
        if (!(await counting.exists(keyFile))) return undefined;
        const bytes = await counting.readFileBytes(keyFile);
        return JSON.parse(decodeWithProbe(bytes).text);
      };
      const oldShapeText = async (): Promise<string> => {
        if (!(await counting.exists(keyFile))) throw new Error('old-shape: missing');
        const bytes = await counting.readFileBytes(keyFile);
        return decodeWithProbe(bytes).text;
      };

      const oldMs: number[] = [];
      const newMs: number[] = [];
      let decodedOld = '';
      let decodedNew = '';
      let newReadKind = '';
      for (let r = 0; r < REPS; r++) {
        let t = performance.now();
        const a = await oldShape();
        oldMs.push(performance.now() - t);
        t = performance.now();
        const b = await cStorage.scope('erb-parser').get('snapshot');
        newMs.push(performance.now() - t);
        expect(a).toBeTruthy();
        expect(b).toBeTruthy();
        if (r === 0) {
          // 保真先于速度：两趟形状与一趟形状必须从同一份盘上真相解出**逐字相同**的原文，
          // 并且投影出同一个值（合一趟只许换形状，不许换内容）。
          decodedOld = await oldShapeText();
          const raw = await new FileStorageBackend(counting).read('erb-parser', 'snapshot');
          newReadKind = raw.kind;
          decodedNew = raw.kind === 'ok' ? raw.data : `<${raw.kind}>`;
          expect(JSON.stringify(b)).toBe(JSON.stringify(a));
        }
      }
      expect(newReadKind).toBe('ok');
      expect(decodedNew).toBe(decodedOld); // 解码逐字节同果（含 BOM/判序口径同源）
      expect(decodedNew.length).toBeGreaterThan(18_000_000);

      // —— 结构不变量（本次改动真正交付的东西，与机器负载无关）——
      // ① 旧形状每键确实 2 趟（参照物还立着，否则"2→1"是自说自话）
      resetTrips(trips);
      expect(await oldShape()).toBeTruthy();
      const oldPerKey = totalTrips(trips);
      expect(oldPerKey).toBe(2);

      // ② 新形状每键只 1 条批量读、0 趟 exists、0 趟单文件读
      resetTrips(trips);
      expect(await cStorage.scope('erb-parser').get('snapshot')).toBeTruthy();
      expect(trips.exists).toBe(0);
      expect(trips.single).toBe(0);
      expect(trips.batch).toBe(1);
      expect(totalTrips(trips)).toBe(1);

      // ③ 级联口径：一轮 ~7 次快照读（索引键/候选×5/抽取键/校验 4 键）
      //    旧 = 7×2=14 趟，新 = 7×1=7 趟（IPC 排队税直接减半——真壳 1,406ms 读数里的大头）。
      resetTrips(trips);
      const t7 = performance.now();
      for (let k = 0; k < 7; k++) await cStorage.scope('erb-parser').get('snapshot');
      const cascadeMs = performance.now() - t7;
      expect(trips.exists).toBe(0);
      expect(trips.single).toBe(0);
      expect(trips.batch).toBe(7);
      expect(totalTrips(trips)).toBe(7);
      expect(totalTrips(trips)).toBeLessThan(oldPerKey * 7);

      const oldMedian = median(oldMs);
      const newMedian = median(newMs);
      // eslint-disable-next-line no-console
      console.log(
        `[PS-2 load] payload=${(JSON.stringify(payload).length / 1e6).toFixed(2)}MB: ` +
          `old-shape(exists+read)=${oldMedian.toFixed(1)}ms new-shape(1 trip)=${newMedian.toFixed(1)}ms ` +
          `(Δ=${(newMedian - oldMedian).toFixed(1)}ms, ratio=${(newMedian / oldMedian).toFixed(2)}×, 只作读数不作判据) | ` +
          `每键趟数 ${oldPerKey}→1；7-get cascade trips: now=${totalTrips(trips)} (was ${oldPerKey * 7}) in ${cascadeMs.toFixed(1)}ms`,
      );

      // 墙钟只留**读数** + 一条量级回退闸（绝对下限 `old + 25ms`，噪声翻不了线）：
      // 本池是 node 桥、没有 IPC 队列，PERF-14 真正省下的"两趟 IPC 排队税"在这里量不到
      // ——真壳同一次装载 node 侧 read+parse 19.6ms / 壳侧 await 1,406ms（docs/STATE.md §S 的
      // PERF-14 归因）。~25ms 尺度上的 ±15% 比值落在进程噪声里 ⇒ 会随机假红，不再当判据。
      // ⇒ 625e3b3 那句「两趟 133.5ms → 一趟 85.4ms」**不由本文件任何档位定责**：同池串行
      //   复跑读到过 old 61.9 / new 69.2ms（新腿慢 11.8%，闸仍绿）——本用例定责的是趟数
      //   2→1、级联 14→7、解码逐字节同果这三条结构不变量；提速账归真壳读数（下）。
      // 真壳读数复跑：`node tools/boot-watermarks.mjs`（账记 docs/BOARD.md §S PERF-14 行）。
      expect(oldMs.length).toBeGreaterThanOrEqual(MIN_SAMPLES);
      expect(newMs.length).toBeGreaterThanOrEqual(MIN_SAMPLES);
      expect(newMedian).toBeLessThanOrEqual(oldMedian + NOISE_FLOOR_MS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 合一趟读把三态压成"一个返回值"是本次改动唯一的语义风险（PERF-14 判据②）：
   * missing（首启，绝不许据此删东西）≠ unreadable（读不动，必须上抛）≠ corrupt
   * （盘上有内容但 JSON 坏了，咽成 undefined 会静默解除下游 fail-closed 判死跟删）。
   */
  it('合一趟读不许糊掉失败语义：missing ≠ unreadable ≠ corrupt 两两可区分', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kojo-ps2-tri-'));
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => {
      warns.push(String(m));
    });
    try {
      const trips = zeroTrips();
      const storage = new StorageServiceImpl(new FileStorageBackend(countingBridge(dir, trips)));
      const s = storage.scope('erb-parser');
      const storeFile = (name: string) => join(dir, 'store', 'erb-parser', name);

      // ① missing：从没写过——状态明确、投影 undefined、且**不出声**（首启不该有读失败的动静）
      resetTrips(trips);
      const w0 = warns.length;
      const missing = await s.entry('absent');
      expect(missing).toEqual({ state: 'missing' });
      expect(await s.get('absent')).toBeUndefined();
      expect(warns.slice(w0)).toEqual([]);
      expect(trips.exists).toBe(0); // 缺失也走同一趟批量读，不回头补 exists
      expect(trips.batch).toBe(2);

      // ② corrupt：盘上站着一份但 JSON 坏了——与 missing **必须分态**
      //    （missing 不许删、corrupt 许删：两态互混就是 PS-2 修的那个真 bug）
      await s.set('snap', { v: 1 });
      writeFileSync(storeFile('snap.json'), '{ "v": 1,,, }', 'utf8');
      resetTrips(trips);
      const corrupt = await s.entry('snap');
      expect(corrupt.state).toBe('corrupt');
      if (corrupt.state === 'corrupt') expect(corrupt.detail.length).toBeGreaterThan(0);
      expect(corrupt).not.toEqual(missing);
      expect(corrupt).not.toEqual({ state: 'missing' });
      // 旧契约投影照旧 undefined（消费者零改动），但状态面已经分开；且必须出声
      expect(await s.get('snap')).toBeUndefined();
      expect(warns.some((w) => w.includes('corrupted JSON'))).toBe(true);

      // ③ unreadable：文件站着但读不动（目录占了键名 ⇒ read-error，不是 ENOENT）——
      //    必须上抛，绝不许冒充"没有"（那会让调用方把读失败当成首启、什么都不重建）
      mkdirSync(storeFile('boom.json'));
      resetTrips(trips);
      await expect(s.entry('boom')).rejects.toThrow(/unreadable/);
      await expect(s.get('boom')).rejects.toThrow(/unreadable/);
      expect(warns.some((w) => w.includes('unreadable'))).toBe(true);
      expect(trips.exists).toBe(0);
      expect(trips.batch).toBe(2); // entry + get 各一趟

      // 三态两两不相等（同一份盘上真相必须给出三种可判的答复）
      const answers = [JSON.stringify(missing), JSON.stringify(corrupt), 'throws'];
      expect(new Set(answers).size).toBe(3);
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
