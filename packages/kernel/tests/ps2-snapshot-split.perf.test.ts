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
 *    node 桥没有 IPC 排队——**真壳那 1,406ms−19.6ms 的差在本池量不到**，
 *    这里量的是"趟数 ×（编解码 + 解析）之外可分离的排队税"的下界：趟数 2→1 由计数断言
 *    钉死，墙钟断言只要求"零回退"（≤ 旧 +15%）。真壳复跑：`node tools/boot-watermarks.mjs`。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
  it('一趟 readFilesRaw 顶替 exists+readFileBytes：装载零回退、形状 2→1', async () => {
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
      const oldShape = async (): Promise<unknown> => {
        if (!(await bridge.exists(keyFile))) return undefined;
        const bytes = await bridge.readFileBytes(keyFile);
        return JSON.parse(decodeWithProbe(bytes).text);
      };

      const REPS = 5;
      const oldMs: number[] = [];
      const newMs: number[] = [];
      let existsTrips = 0;
      let singleReadTrips = 0;
      let batchTrips = 0;
      const counting = Object.assign(Object.create(NodeBridge.prototype) as NodeBridge, {
        appDataDir: () => Promise.resolve(dir),
        exists: (p: string) => {
          existsTrips++;
          return NodeBridge.prototype.exists.call(counting, p);
        },
        readFileBytes: (p: string) => {
          singleReadTrips++;
          return NodeBridge.prototype.readFileBytes.call(counting, p);
        },
        readFilesRaw: (ps: readonly string[]) => {
          batchTrips += ps.length; // 记"单键读"的条数而非批趟数
          return NodeBridge.prototype.readFilesRaw.call(counting, ps);
        },
      });
      const cStorage = new StorageServiceImpl(new FileStorageBackend(counting));

      for (let r = 0; r < REPS; r++) {
        let t = performance.now();
        const a = await oldShape();
        oldMs.push(performance.now() - t);
        expect(a).toBeTruthy();
        t = performance.now();
        const b = await storage.scope('erb-parser').get('snapshot');
        newMs.push(performance.now() - t);
        expect(b).toBeTruthy();
      }
      // 形状钉：新 get 每键只走 1 条批量读、0 趟 exists、0 趟单文件读
      existsTrips = 0;
      singleReadTrips = 0;
      batchTrips = 0;
      expect(await cStorage.scope('erb-parser').get('snapshot')).toBeTruthy();
      expect(existsTrips).toBe(0);
      expect(singleReadTrips).toBe(0);
      expect(batchTrips).toBe(1);

      // 级联口径：一轮 ~7 次快照读（索引键/候选×5/抽取键/校验 4 键）
      // 旧 = 7×2=14 趟，新 = 7×1=7 趟（IPC 排队税直接减半——真壳 1,406ms 读数里的大头）。
      const t7 = performance.now();
      batchTrips = 0; // 形状钉那次 get 不算进级联窗口
      for (let k = 0; k < 7; k++) await cStorage.scope('erb-parser').get('snapshot');
      // eslint-disable-next-line no-console
      console.log(
        `[PS-2 load] payload=${(JSON.stringify(payload).length / 1e6).toFixed(2)}MB: ` +
          `old-shape(exists+read)=${median(oldMs).toFixed(1)}ms new-shape(1 trip)=${median(newMs).toFixed(1)}ms; ` +
          `7-get cascade trips: now=${batchTrips} (was 14) in ${(performance.now() - t7).toFixed(1)}ms`,
      );
      expect(median(newMs)).toBeLessThanOrEqual(median(oldMs) * 1.15); // 同进程只允许持平或更好
      expect(batchTrips).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
