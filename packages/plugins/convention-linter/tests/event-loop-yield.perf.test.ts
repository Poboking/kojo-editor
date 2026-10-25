/**
 * 主线程让路闸（ZH-F4）：一轮全项目校验期间，事件循环必须仍能处理输入。
 *
 * 判据形态 = **macrotask 探针**（自递推 `setImmediate`，只有主线程空出来才跑得动）。
 * `mapLimit` 里每个 `await` 拿到的多是**已 resolve** 的 promise（本轮正文已被批量预取），
 * 而微任务链永不交还事件循环 ⇒ 改造前实测：整轮校验**探针一次都没跑**，最长一次连续
 * 占用 = 整轮时长（作者那边就是「界面冻住、按键全排队」）。
 *
 * 这里钉的是**最长单次占用**（= 作者的最坏输入延迟），不是吞吐；判定与产出顺序一字未动
 * （对拍闸在 `sugar-transpiler-dedup.test.ts` / `partition.test.ts`）。
 * 墙钟断言 ⇒ 文件名 `.perf.test.ts`，按 `tools/perf-suite.mjs` 的谓词进串行静默池。
 */
import { describe, expect, it } from 'vitest';
import type {
  ComputePool,
  ErbFile,
  ErbIndex,
  GameProject,
  Logger,
  SugarTranspileService,
} from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { createSugarTranspileService } from '@kojo/plugin-kojo-sugar';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import { createComputePool } from '../../../kernel/src/compute';
import { ConventionEngine } from '../src/engine';
import { setSugarTranspileProvider } from '../src/rules/sugar-conventions';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * 600 → **1200**（2026-10-20 CI 实测后抬）：`totalMs > 200` 是「体感尺成立」的**规模前置**
 * （整轮才 200 ms 时，`blockMs < total×0.6` 与 `< 300` 两条没有意义），不是性能指标。
 * 600 在最快的 CI runner 上整轮落在 **199.82 ms**（run 39367625820；上一跑 198.62 ms），
 * 恰好压在线上、偶发跑红 ⇒ 抬规模让最快 runner 也有 ≈2× 余量；**下限 200 一字不动**。
 */
const KOJO_COUNT = 1200;

/** 一棵中等分量的 `.kojo`（多个时机块 + 会出诊断的写法 ⇒ 转译器真在算，不是空跑循环） */
function kojoSource(index: number): string {
  const lines: string[] = ['角色: 12', ''];
  for (let t = 0; t < 4; t++) {
    lines.push(
      `时机 指令 ${300 + t}：`,
      `    「第 ${index} 棵 第 ${t} 个时机」 续`,
      '    她的心情 = 如果 她的好感度 >= 500：',
      '        "热情"',
    );
    for (let k = 0; k < 10; k++) lines.push(`    她的表情${k} = ${k}`);
    lines.push('');
  }
  return lines.join('\n');
}

function project(): GameProject {
  return { rootDir: '/p', adapterId: 'test', kojoPaths: ['/p/kojo'], writablePaths: [], charaIndex: new Map() };
}

function harness(compute?: ComputePool): ConventionEngine {
  const texts: Record<string, string> = {};
  const files = new Map<string, ErbFile>();
  const mtimes = new Map<string, number | null>();
  for (let i = 0; i < KOJO_COUNT; i++) {
    const path = `/p/kojo/M_KOJO_K12_指令_${i}.kojo`;
    texts[path] = kojoSource(i);
    files.set(path, parseErbText('', path));
    mtimes.set(path, 1_700_000_000_000 + i);
  }
  const index: ErbIndex = { files, byName: new Map(), fileMtimes: mtimes };
  const service: SugarTranspileService = createSugarTranspileService({ faceTable: createEratwFaceTable() });
  setSugarTranspileProvider(() => service);
  return new ConventionEngine({
    log: silentLog,
    ...(compute ? { compute } : {}),
    getProject: () => project(),
    getIndex: () => index,
    readFile: async (path: string) => {
      const t = texts[path];
      if (t === undefined) throw new Error(`not found: ${path}`);
      return t;
    },
    readFiles: async (paths: readonly string[]) => paths.map((p) => texts[p] ?? null),
    getAdapterRules: () => [],
    getAdapterPolicy: () => undefined,
    snapshot: {
      expectFor: () => ({ projectRoot: '/p', adapterId: 'test', fingerprint: 'fp-yield' }),
      load: async () => null,
      save: () => undefined,
    },
  });
}

/**
 * 探针用 `setImmediate` 而不是 `setTimeout(0)`：后者受 Node 定时器对齐噪声的影响
 * （探针老是「差 1 ms 没到期」而被整轮跳过），量的就成了排程运气而不是让路。
 * `setImmediate` 与浏览器里的输入事件同属「任务队列中的一项」。
 */
function startProbe(): { stop(): number[] } {
  const ticks: number[] = [];
  let go = true;
  const step = (): void => {
    if (!go) return;
    ticks.push(performance.now());
    setImmediate(step);
  };
  setImmediate(step);
  return {
    stop() {
      go = false;
      return ticks;
    },
  };
}

/** 相邻探针之间的最长空隙（= 主线程被连续占住的最长时间 = 最坏输入延迟） */
function longestBlock(ticks: readonly number[], from: number, to: number): number {
  const marks = [from, ...ticks.filter((t) => t > from && t < to), to];
  let max = 0;
  for (let i = 1; i < marks.length; i++) max = Math.max(max, marks[i]! - marks[i - 1]!);
  return max;
}

/** 跑一轮并量出「问题数 / 整轮 / 最长单次占用 / 探针次数」 */
interface RunReadout {
  issues: number;
  totalMs: number;
  blockMs: number;
  ticks: number;
}

async function measure(engine: ConventionEngine): Promise<RunReadout> {
  const probe = startProbe();
  const started = performance.now();
  const rep = await engine.run({ force: true });
  const ended = performance.now();
  const ticks = probe.stop();
  return {
    issues: rep.issues.length,
    totalMs: ended - started,
    blockMs: longestBlock(ticks, started, ended),
    ticks: ticks.length,
  };
}

describe('全项目校验期间的让路', () => {
  /**
   * 装池那条（生产装配）以**池子自己的记账**为闸：`yieldToMain` 走 MessageChannel，
   * 在 Node 里 setImmediate 探针观察不到它的回合（浏览器里那正是"输入事件能插进来"的通道），
   * 而池子把片数 / 让路次数 / 项数都统计在册 —— 用真源读数，不拿观察器的偏当作判据。
   */
  it('装内核计算池：逐文件循环整程进池，片间真的让了路', async () => {
    const compute = createComputePool({ log: silentLog });
    const got = await measure(harness(compute));
    const stat = compute.stats().tasks.find((t) => t.label === 'convention.lint');
    console.log(`[yield] 装池 · 整轮 ${Math.round(got.totalMs)}ms · 池记账 ${JSON.stringify(stat)}`);
    expect(got.issues).toBeGreaterThan(0);
    expect(stat?.items).toBe(KOJO_COUNT); // 全部文件都过了池子，没有绕开分片通道
    expect(stat!.yields).toBeGreaterThan(0); // 改造前：一次都没有（空闲复跑这一档实测 29 次）
    expect(stat!.slices).toBe(stat!.yields);
  });

  /** 不装池（纯单测 / 无内核装配）的本地兜底：只能用探针量，`setTimeout` 让路观察得到 */
  it('没装池：本地兜底同样按预算让路（macrotask 探针）', async () => {
    const got = await measure(harness());
    console.log(
      `[yield] 兜底 · 整轮 ${Math.round(got.totalMs)}ms · 最长单次占用 ${Math.round(got.blockMs)}ms · 探针 ${got.ticks} 次`,
    );
    expect(got.issues).toBeGreaterThan(0);
    // 反恒真：让路真的发生了（改造前这一档是 0 次 —— 微任务链把整轮锁死；空闲复跑实测 99 次）。
    // 下限只钉「不为 0」：探针次数随机器负载漂（满载轮曾读到 5 次），拿它当尺子会把负载当回归。
    // 粒度由下面两条体感尺守（blockMs 既明显低于整轮、又不越过几百毫秒）。
    expect(got.ticks).toBeGreaterThan(0);
    expect(got.totalMs).toBeGreaterThan(200);
    // 改造前的形状是 blockMs === totalMs（整轮就是一次连续占用）；这里必须明显低于整轮
    expect(got.blockMs).toBeLessThan(got.totalMs * 0.6);
    // 体感口径：一次连续占用不许越过几百毫秒
    expect(got.blockMs).toBeLessThan(300);
  });
});
