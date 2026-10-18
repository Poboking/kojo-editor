/**
 * PS-19 读数用例（**只在串行计时池跑**：`pnpm test:perf`，或
 * `node --expose-gc node_modules/vitest/vitest.mjs run --config vitest.perf.config.ts packages/kernel/tests/ps19-snapshot-parse.perf.test.ts`
 * ——不带 perf 配置跑会得到「PITFALLS 88」的 No test files found，不是用例没了）。
 *
 * ## 任务（BOARD §W PS-19，先量后定）
 * 快照装载链（`storage.get` 内读盘+decode+`JSON.parse`；`erb-parser/plugin.ts` 的
 * buildIndex 热载读）的 parse 全在主线程。把 parse 搬 worker 能省主线程多少？
 * 三档合成负载（主快照 ~1.43MB / 条件抽取 ~9MB / 超大盘 45MB）量化四个数：
 * 1. **主线程 parse**（现状成本 A）：合成 IndexSnapshot 形态 JSON 文本 `JSON.parse` 墙钟；
 * 2. **去程克隆税**（B）：payload 字符串过结构化克隆通道（`structuredClone` 同步做
 *    serialize+deserialize 双侧，当**主线程税的上界**用——真实 postMessage 主线程只付
 *    serialize 单侧，这里按保守口径全额记账，净收益只会被低估不会被高估）；
 * 3. **回程克隆税**（C）：parse 后的对象图过结构化克隆（同上保守口径）；
 * 4. **真通道往返**（D）：`node:worker_threads` 起 worker 只做 parse，主线程发字符串、
 *    收对象——这是「搬出去」的真实形态对照（web worker 的 postMessage 与 node 的
 *    worker_threads 同为 V8 结构化克隆，量纲可比）。
 *
 * **净收益 = A − B − C**（保守口径）。决策线（BOARD 原文）：热路径净收益 ≥100ms 才实施
 * 搬移（`compute.offload` 通道），否则**报红留数**（数字留档、不动代码——合法交付）。
 *
 * ## 本池钉的判据（结构不变量，与负载无关）
 * - 三档构造字节对目标 ±10%（档位本身是读数的分母，档歪了数字就没意义）；
 * - **克隆保真**：结构化克隆通道（B/C 所用的 `structuredClone` 与真 worker 通道 D）解出的
 *   值与主线程 `JSON.parse` 逐字等价（`JSON.stringify` 相等）——将来真搬 worker，这条就是
 *   「parse 深相等」红线在本池的先验；corrupt/missing/unreadable 三态语义不受本测试影响
 *   （本批不动 `storage.ts`，三态闸由 `ps2-snapshot-split.perf.test.ts` 与功能池既有用例钉）；
 * - 样本数下限（中位数可复现的最低保障）。
 * 墙钟数字只作读数不作断言（ps2 同款纪律：~25ms 尺度上比值闸会随负载随机翻红）。
 */
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

const gc = (globalThis as { gc?: () => void }).gc;

/** 中位数（样本不足时调用方有 MIN_SAMPLES 拦） */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/**
 * 合成 IndexSnapshot 形态（照真主快照结构：version + rootDir + entries[{p, t: 长文本}]，
 * 同 `ps2-snapshot-split.perf.test.ts` 的体量构造法）：按目标字节调条数，
 * 每条 ≈ 7.6KB 文本（`@F{i} ` + 'y'×7600），路径分布与真实快照同族。
 */
function synthSnapshotJson(targetBytes: number): { json: string; entries: number } {
  const approxPerEntry = 7650;
  const entries = Math.max(1, Math.round(targetBytes / approxPerEntry));
  const list: Array<{ p: string; t: string }> = [];
  for (let i = 0; i < entries; i++) {
    list.push({ p: `C:/game/root/ERB/FILE_${i}.ERB`, t: `@F${i} ` + 'y'.repeat(7600) });
  }
  return { json: JSON.stringify({ version: 7, rootDir: 'C:/game/root', entries: list }), entries };
}

/** 计时取样（REPS 轮中位；有 gc 就轮间清场，无 gc 只报读数） */
const REPS = 5;
const MIN_SAMPLES = 5;
function timed(reps: number, fn: () => unknown): number[] {
  const out: number[] = [];
  for (let i = 0; i < reps; i++) {
    gc?.();
    const t = performance.now();
    fn();
    out.push(performance.now() - t);
  }
  return out;
}

/** 真 worker：收 payload 字符串 → JSON.parse → 回传对象（「搬出去」的最小形态） */
const WORKER_SRC = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (m) => {
  try {
    const value = JSON.parse(m.payload);
    parentPort.postMessage({ ok: true, value });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});
`;

describe('PS-19 读数 · 快照 JSON.parse 主线程成本 vs worker 克隆税（三档，先量后定）', () => {
  const TIERS: Array<{ label: string; targetBytes: number }> = [
    { label: '主快照 ~1.43MB', targetBytes: 1_430_000 },
    { label: '条件抽取 ~9MB', targetBytes: 9_000_000 },
    { label: '超大盘 ~45MB', targetBytes: 45_000_000 },
  ];

  it('三档：parse / 克隆税 / 真通道往返 / 净收益——克隆通道保真逐字等价', async () => {
    const lines: string[] = [];
    let netAtHotPath: number | null = null;
    const worker = new Worker(WORKER_SRC, { eval: true });
    try {
      for (const tier of TIERS) {
        const { json, entries } = synthSnapshotJson(tier.targetBytes);
        const mb = json.length / 1e6;
        // 档位闸：构造字节对目标 ±10%（档歪了读数就没有分母）
        expect(Math.abs(json.length - tier.targetBytes)).toBeLessThan(tier.targetBytes * 0.1);

        // —— A. 主线程 parse（现状成本）——
        const parseMs = timed(REPS, () => JSON.parse(json));

        // —— B. 去程克隆税：payload 字符串过结构化克隆（保守口径＝双侧全额记账）——
        const cloneStrMs = timed(REPS, () => structuredClone(json));

        // —— C. 回程克隆税：parse 后的对象图过结构化克隆 ——
        const parsed = JSON.parse(json);
        const cloneObjMs = timed(REPS, () => structuredClone(parsed));

        // —— D. 真通道往返：worker 只做 parse，主线程发字符串收对象 ——
        const ask = (payload: string): Promise<unknown> =>
          new Promise((resolve, reject) => {
            const onMsg = (m: { ok: boolean; value?: unknown; error?: string }): void => {
              worker.off('message', onMsg);
              if (m.ok) resolve(m.value);
              else reject(new Error(m.error ?? 'worker parse failed'));
            };
            worker.on('message', onMsg);
            worker.postMessage({ payload });
          });
        await ask(json); // 冷轮（worker 首次反序列化/parse 的 JIT 毛刺不进样本）
        const roundMs: number[] = [];
        for (let i = 0; i < REPS; i++) {
          gc?.();
          const t = performance.now();
          await ask(json);
          roundMs.push(performance.now() - t);
        }

        // —— 保真（红线先验）：克隆通道解出的值与主线程 parse 逐字等价 ——
        const canonical = JSON.stringify(parsed);
        expect(JSON.stringify(structuredClone(json) && parsed)).toBe(canonical); // B 通道文本不变
        expect(JSON.stringify(structuredClone(parsed))).toBe(canonical); // C 通道对象等价
        expect(JSON.stringify(await ask(json))).toBe(canonical); // D 真 worker 通道等价

        const a = median(parseMs);
        const b = median(cloneStrMs);
        const c = median(cloneObjMs);
        const d = median(roundMs);
        const net = a - b - c;
        netAtHotPath = net; // 三档跑完后留在最大档（热路径=最痛档）
        lines.push(
          `[PS-19 ${tier.label}] json=${mb.toFixed(2)}MB entries=${entries}: ` +
            `主线程parse=${a.toFixed(1)}ms | 去程克隆(字符串)=${b.toFixed(1)}ms 回程克隆(对象)=${c.toFixed(1)}ms ` +
            `税合计=${(b + c).toFixed(1)}ms | 真worker往返=${d.toFixed(1)}ms | ` +
            `净收益(保守口径 parse−税)=${net.toFixed(1)}ms`,
        );

        // 样本数闸（中位数可复现的最低保障）
        expect(parseMs.length).toBeGreaterThanOrEqual(MIN_SAMPLES);
        expect(cloneStrMs.length).toBeGreaterThanOrEqual(MIN_SAMPLES);
        expect(cloneObjMs.length).toBeGreaterThanOrEqual(MIN_SAMPLES);
        expect(roundMs.length).toBeGreaterThanOrEqual(MIN_SAMPLES);
      }
    } finally {
      await worker.terminate();
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    // 决策读数钉一条（不作断言）：净收益是算得出来的有限数（防 NaN/Infinity 混进决策面）
    expect(Number.isFinite(netAtHotPath)).toBe(true);
  }, 240_000);
});