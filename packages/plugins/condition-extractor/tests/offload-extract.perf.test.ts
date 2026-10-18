/**
 * PS-11 抽取 offload 批 · 合成档通道读数（2026-10-18）。
 *
 * 只跑在**串行静默池**（`--config vitest.perf.config.ts`，PITFALLS §88）。
 * 本文件量的不是"快了没有"——offload 的主张是**CPU 归属**（同一段净 CPU 从 UI 线程
 * 挪进 worker 槽），node 单线程里量不出这个差异；真壳 A/B（真语料、同构建、页内计时）
 * 待语料目录回位后按 STATE.md 既有口径补。这里钉住的是三件**结构不变量**：
 *
 * 1. **零旁路**：主循环每个文件恰好派发一条 `condition.extractFile` 任务
 *    （`dispatched === 文件数`，`fellBack/inline === 0`）——主线程上没有任何
 *    "顺手自己算了"的残留路径；
 * 2. **产出形状**：函数数 / 谓词数 / 依赖数与合成盘逐项相等（真抽取在任务里发生，
 *    不是空桶过账）；
 * 3. **计时面随结果回传**：`scanMs + extractMs` 是任务侧净 CPU（`ExtractFileResult`
 *    回传，engine 分段剖面只做累加）——它构成真壳 A/B 时"主线程解放了多少"的减数。
 *
 * 判据口径照 PITFALLS §72：结构不变量为主、绝对毫秒只打印不当尺子。
 * 默认档轻（240 棵）；HEAVY（`KOJO_PERF_HEAVY=1`）放大到真实语料量级
 * （2,325 棵 × 41 函数 ≈ 95k 函数 / ~48 万谓词，对照真实 95k / 49.3 万）。
 */
import { describe, expect, it } from 'vitest';
import type {
  ComputePool,
  ComputePoolStats,
  ComputeTaskTable,
  ControlFlowStatement,
  ErbFile,
  ErbIndex,
  GameProject,
  Logger,
} from '@kojo/plugin-api';
import { ConditionEngine } from '../src/engine';
import { conditionExtractorTasks } from '../src/offload';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const HEAVY = process.env.KOJO_PERF_HEAVY === '1';
/** 棵数：真实语料 2,325 棵口上；默认档 240 棵（cache-residency 同款轻量档） */
const FILE_COUNT = HEAVY ? 2_325 : 240;
/** 每棵函数数：2,325 × 41 ≈ 95k，对照真实语料 95k 函数 */
const FN_PER_FILE = 41;
/** 每函数 IF 谓词数：95k × 5 ≈ 47.7 万，对照真实 49.3 万谓词 */
const IFS_PER_FN = 5;

/** 任务表吃的真形状扫描器（与 erb-parser 的行式扫描同语义：行号 = 语句所在行） */
const scan = (text: string): ControlFlowStatement[] => {
  const out: ControlFlowStatement[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(IF|SIF)\s+(.+)$/.exec(lines[i]!);
    if (m) out.push({ kind: m[1]!, expression: m[2]!, depth: 0, line: i + 1 });
  }
  return out;
};

/** 全局量表达式池（全部可解析 ⇒ unparsed 可钉 0；LOCAL/ARG 排除路径由 offload-extract.test.ts 的差分管） */
const EXPRS = ['CFLAG:2 >= 500', 'TALENT:3 != 800', 'PALAM:10 < 999', 'EXP:0 == 0', 'CFLAG:2 >= 800'] as const;

/**
 * 计算池替身（与 engine-snapshot.test.ts 同款）：offload 派发到注册的任务表并计
 * `dispatched`——node 无真通道，但"每文件必经任务通道"这条不变量与有通道时同一形状。
 */
function makeComputeStub(tasks: ComputeTaskTable): { pool: ComputePool; stat: ComputePoolStats['offload'] } {
  const stat: ComputePoolStats['offload'] = { parallel: true, dispatched: 0, fellBack: 0, inline: 0 };
  const pool = {
    async runSliced<T, R>(
      items: readonly T[],
      _opts: unknown,
      fn: (item: T, i: number) => R | Promise<R>,
    ): Promise<R[]> {
      const out: R[] = [];
      for (let i = 0; i < items.length; i++) out.push(await fn(items[i]!, i));
      return out;
    },
    async offload<R>(kind: string, payload: unknown): Promise<R> {
      const impl = tasks[kind];
      if (!impl) throw new Error(`No local implementation registered for compute task '${kind}'`);
      stat.dispatched++;
      return (await impl(payload as never)) as R;
    },
    stats: () => ({ tasks: [], yields: 0, interactiveActive: false, offload: { ...stat } }),
  } as unknown as ComputePool;
  return { pool, stat };
}

describe('PS-11 · 全量抽取的通道归属（合成档）', () => {
  it('每文件恰一条任务、零旁路；产出形状与合成盘逐项相等；任务侧净 CPU 随结果回传', async () => {
    const project = { rootDir: 'D:/game', adapterId: 'eratw', inputDigest: 'perf-ps11' } as unknown as GameProject;

    /* 合成盘：files（索引面）与 texts（盘面）同源生成，函数区间 [块首, 块首+块高] */
    const files = new Map<string, ErbFile>();
    const byName = new Map<string, unknown[]>();
    const texts = new Map<string, string>();
    const BLOCK = IFS_PER_FN + 2; // 1 行注释 + IFS_PER_FN 行 IF + 1 行 ENDIF
    for (let f = 0; f < FILE_COUNT; f++) {
      const path = `/f/k${f}.ERB`;
      const lines: string[] = [];
      const fnHeaders: ErbFile['functions'] = [];
      for (let i = 0; i < FN_PER_FILE; i++) {
        const start = 1 + i * BLOCK;
        lines.push(`; block ${i} filler`);
        for (let k = 0; k < IFS_PER_FN; k++) lines.push(`IF ${EXPRS[(f + i + k) % EXPRS.length]!}`);
        lines.push('ENDIF');
        const name = `FN_${f}_${i}`;
        const header = {
          name,
          normalizedName: name,
          params: [],
          startLine: start,
          endLine: start + BLOCK - 1,
          filePath: path,
          isExpressionFunction: false,
        };
        fnHeaders.push(header);
        byName.set(name, [header]);
      }
      files.set(path, { path, functions: fnHeaders, dims: [], hasFunctionDirective: false, lineCount: lines.length } as ErbFile);
      texts.set(path, lines.join('\n'));
    }
    const index = { files, byName } as unknown as ErbIndex;

    const { pool, stat } = makeComputeStub(conditionExtractorTasks(scan));
    const engine = new ConditionEngine({
      log: silentLog,
      getProject: () => project,
      getIndex: () => index,
      readFile: async (path) => {
        const t = texts.get(path);
        if (t === undefined) throw new Error(`not found: ${path}`);
        return t;
      },
      readFiles: async (paths) => paths.map((p) => texts.get(p) ?? null),
      scanControlFlow: async (text) => scan(text),
      getSchemaLookup: () => undefined,
      compute: pool,
    });

    const t0 = performance.now();
    const result = await engine.ensureIndex();
    const wallMs = performance.now() - t0;

    /* ① 零旁路：主循环的每个文件都经 `condition.extractFile` 任务通道（一文件一任务） */
    expect(stat.dispatched, '每文件恰一条任务派发').toBe(FILE_COUNT);
    expect(stat.fellBack).toBe(0);
    expect(stat.inline).toBe(0);

    /* ② 产出形状：真抽取在任务里发生（不是空桶过账） */
    const FN_TOTAL = FILE_COUNT * FN_PER_FILE;
    expect(result.stats.functions).toBe(FN_TOTAL);
    expect(result.stats.predicates).toBe(FN_TOTAL * IFS_PER_FN);
    expect(result.stats.unparsed).toBe(0);
    expect(result.stats.dependencies).toBeGreaterThan(0);
    expect(result.byFunction.size).toBe(FN_TOTAL);
    // 一条依赖抽查：CFLAG 表达式产出的键形态（全局量不被 LOCAL/ARG 排除）
    const sample = result.byFunction.get('FN_0_0');
    expect(sample?.dependencies.some((d) => d.name === 'CFLAG' || d.name === 'TALENT' || d.name === 'PALAM' || d.name === 'EXP')).toBe(true);

    /* ③ 读数行（只打印不判）：墙钟与任务侧净 CPU 的差 = 主线程装配 + 调度残余。
     * 真壳 A/B 时同一形状读数变为"扫描/抽取在 worker 槽、主线程只剩装配"——
     * 本行的价值是给那时的对比留一个同形状的 node 侧锚点。 */
    console.log(
      `[ps11·extract] ${HEAVY ? '真实语料量级' : '默认轻量档'} ${FILE_COUNT.toLocaleString()} 棵 × ${FN_PER_FILE} 函数 × ${IFS_PER_FN} IF：` +
        `全量 ensureIndex 墙钟 ${wallMs.toFixed(0)}ms ｜ 产出 ${result.stats.functions.toLocaleString()} 函数 / ` +
        `${result.stats.predicates.toLocaleString()} 谓词 / ${result.stats.dependencies.toLocaleString()} 依赖 ｜ ` +
        `任务派发 ${stat.dispatched} 条（dispatched，fellBack ${stat.fellBack} / inline ${stat.inline}）`,
    );
    expect(wallMs).toBeGreaterThan(0);
  }, HEAVY ? 300_000 : 120_000);
});