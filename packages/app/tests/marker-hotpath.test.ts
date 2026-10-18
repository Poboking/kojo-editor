/**
 * 装饰热路径**读数**（PERF-4）：真装饰器 + 合成大文件，量三件事——
 *
 * 1. `refreshMarkers` 的**同步轮**主线程成本：改动前"三路本地同步" vs 改动后
 *    声明 `offloadKind` 派发（假运输层把执行推到下一个宏任务，时序形状与真 worker 一致）；
 * 2. **缓存命中**：切回未改动标签 → 装饰计算 0 次（连整份文本都不取）；
 * 3. **语义不回退**：offload 回来的装饰与就地算的**逐字段相等**（两条走法共用同一个纯函数）。
 *
 * 合成口径：6,000 行 / 约 150 KB，成对控制流 + 一处未闭合 + 一处残句表达式
 * （够让两路装饰器各自吃满 CPU，但**不代表真实语料密度**——语料不在本机，见提交回执）。
 */
import { describe, expect, it } from 'vitest';
import { createComputePool } from '@kojo/kernel';
import type { ComputeTransport, GameProject, LineDecoration } from '@kojo/plugin-api';
import { erbStructureDecorations, scanControlFlow } from '@kojo/plugin-erb-parser';
import { conditionExtractorTasks, exprSyntaxDecorations } from '@kojo/plugin-condition-extractor';
import { createSugarTranspileService } from '@kojo/plugin-kojo-sugar';
import { createMarkerRunner, type MarkerContributor } from '../src/ui/marker-pool';
import { computeTasks, hasWorkerTask } from '../src/compute-tasks';

/** 合成一份大 ERB 正文 */
function bigErb(lines: number): string {
  const rows: string[] = ['#FUNCTION 大量口上', '#DIM CFLAG:4000'];
  let n = 0;
  while (rows.length < lines) {
    n++;
    rows.push(`@口上函数${n}`);
    rows.push(`IF CFLAG:100+${n} = 1`);
    rows.push('  PRINTVAR 2, 22, 1');
    rows.push(`  IF CFLAG:200+${n} = 2`);
    rows.push('  PRINTDATA 1, "文本"');
    rows.push('  ENDIF');
    rows.push(`ELSEIF CFLAG:300+${n} &&`); // 残句：表达式语法波浪线
    rows.push('  PRINTVAR 1, 1, 2');
    rows.push('ENDIF');
  }
  rows.push('IF 1 = 1'); // 故意不闭合：结构波浪线
  return rows.join('\n');
}

const TEXT = bigErb(6000);

/** 合成一份大 `.kojo` 糖源（给"第三路只能异步就地"那条读数用） */
function bigKojo(blocks: number): string {
  const rows: string[] = ['角色: 1'];
  for (let i = 0; i < blocks; i++) {
    rows.push(`时机 日常：`);
    rows.push(`    「第${i}次见面。」`);
    rows.push('    她笑了。 续');
    rows.push(`    「再说一句。」`);
  }
  return rows.join('\n');
}

function project(): GameProject {
  return {
    adapterId: 'x',
    rootDir: '/game',
    kojoPaths: ['/game/ERB'],
    writablePaths: [],
    charaIndex: new Map(),
    inputDigest: 'digest-1',
  } as unknown as GameProject;
}

interface Setup {
  runner: ReturnType<typeof createMarkerRunner>;
  published: LineDecoration[][];
  invokeCount: () => number;
  settle: () => Promise<void>;
}

/**
 * @param offload  两条重装饰是否按新契约声明 `offloadKind`（false = 改动前形态）
 * @param inTable  worker 侧是否收录这两个 kind（false = 只能异步就地）
 */
function setup(offload: boolean, inTable: boolean): Setup {
  const pool = createComputePool();
  let invokes = 0;
  if (inTable) {
    const transport: ComputeTransport = {
      available: true,
      invoke: async (kind, payload) => {
        invokes++;
        await new Promise((r) => setTimeout(r, 0)); // 换线程 = 换宏任务
        const impl = computeTasks[kind as keyof typeof computeTasks] as (p: unknown) => LineDecoration[];
        return impl(payload);
      },
    };
    pool.attachTransport(transport);
  }
  // 宿主侧本地实现表（与 bootstrap 同一动作）：异步就地那档、通道挂掉时的回退都走它
  for (const [kind, impl] of Object.entries(computeTasks)) pool.registerTask(kind, impl as never);

  const light: MarkerContributor = {
    id: 'host-light',
    decorate: () => [{ line: 1, severity: 'info', message: '宿主侧轻装饰' }],
  };
  const structure: MarkerContributor = {
    id: 'erb-structure',
    ...(offload ? { offloadKind: 'erb.structureDecorations' } : {}),
    decorate: ({ path, text }) => erbStructureDecorations({ path, text }),
  };
  const expr: MarkerContributor = {
    id: 'erb-expr-syntax',
    ...(offload ? { offloadKind: 'erb.exprSyntaxDecorations' } : {}),
    decorate: ({ path, text }) => exprSyntaxDecorations({ path, text }, scanControlFlow),
  };
  const published: LineDecoration[][] = [];
  const runner = createMarkerRunner({
    compute: pool,
    workerHasTask: (kind) => inTable && hasWorkerTask(kind),
    contributors: () => [light, structure, expr],
    project: () => project(),
    versionOf: () => 1,
    publish: (_path, decorations) => published.push(decorations),
  });
  return {
    runner,
    published,
    invokeCount: () => invokes,
    settle: async () => {
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    },
  };
}

/** 同步轮耗时：只测 `refresh()` 这一次同步调用本身 */
function syncCost(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

/**
 * **同窗对照分母**：同一份文本、同一个 setup 形态走「改动前三路本地同步」（重活在同步轮里跑完）
 * 的那一次 `refresh()` 成本。
 *
 * 为什么要有它：`expect(ms).toBeLessThan(2)` 这种**单样本绝对预算**在 CI 上是抛硬币——
 * 安静时 0.15–0.6 ms、并行池里被别的 worker 饿到 2.5 ms（2026-10 六次红全这么来的）。
 * 同窗量一个"重活就地跑完"的成本当分母，负载对分子分母同时抬，判据（装配 ≪ 全部 CPU）才稳。
 */
function heavySyncCost(): number {
  return syncCost(() => setup(false, true).runner.refresh('/a.erb', () => TEXT));
}

describe('装饰热路径读数（真装饰器 + 6000 行合成文件）', () => {
  it('改动前：重装饰在同步轮里跑完（本轮耗时 = 全部 CPU）', () => {
    const s = setup(false, true);
    const ms = syncCost(() => s.runner.refresh('/a.erb', () => TEXT));
    expect(ms).toBeGreaterThan(1);
    expect(s.published).toHaveLength(1);
    expect(s.published[0]!.length).toBeGreaterThan(1);
    expect(s.invokeCount()).toBe(0);
  });

  it('改动后：同步轮只装配——重装饰一次都不在本轮跑，发布分两拍', async () => {
    const s = setup(true, true);
    const ms = syncCost(() => s.runner.refresh('/a.erb', () => TEXT));
    const heavyMs = heavySyncCost(); // 同一轮、同一份文本的"重活就地跑完"对照
    expect(s.invokeCount()).toBe(0); // 同步轮里一次通道调用都没发出（只排进 runLatest）
    expect(s.published).toHaveLength(1);
    expect(s.published[0]!.length).toBe(1); // 此刻屏上只有轻的那一档
    await s.settle();
    expect(s.invokeCount()).toBe(2); // 两条重装饰都在"线程"上跑过
    expect(s.published.at(-1)!.length).toBeGreaterThan(1); // 重装饰回来，整档替换
    console.info(
      `[PERF-4] 同步轮只装配 ${ms.toFixed(2)} ms ｜ 同窗重活就地 ${heavyMs.toFixed(2)} ms` +
        ` ｜ 比值 ${(ms / heavyMs).toFixed(4)}（判据 <0.2）`,
    );
    expect(ms).toBeLessThan(heavyMs * 0.2);
    expect(ms).toBeLessThan(200); // 塌方级绝对护栏（只拦"整档重算搬回同步轮"这种量级事故）
  });

  it('两条走法结果逐字段相等（offload 不改语义）＋ 同步轮读数', async () => {
    // 先热身一轮（JIT）；随后每次测量都用**全新 runner**——同版本会命中缓存，读数就假了
    const warm = setup(false, true);
    warm.runner.refresh('/a.erb', () => TEXT);
    await warm.settle();
    const msBefore = syncCost(() => setup(false, true).runner.refresh('/a.erb', () => TEXT));
    const msAfter = syncCost(() => setup(true, true).runner.refresh('/a.erb', () => TEXT));
    const before = setup(false, true);
    const after = setup(true, true);
    before.runner.refresh('/a.erb', () => TEXT);
    after.runner.refresh('/a.erb', () => TEXT);
    await after.settle();
    expect(after.published.at(-1)).toEqual(before.published.at(-1));
    expect(after.published.at(-1)!.length).toBeGreaterThan(1); // 真有装饰，不是"两边都空"
    expect(msAfter).toBeLessThan(msBefore);
    console.info(
      `[PERF-4] refreshMarkers 同步轮主线程成本（6000 行合成 ERB）：本地三路 ${msBefore.toFixed(2)} ms` +
        ` → offload 派发 ${msAfter.toFixed(2)} ms`,
    );
  });

  it('缓存命中：切回未改动标签 = 装饰计算 0 次（连文本都不取）', async () => {
    const s = setup(true, true);
    s.runner.refresh('/a.erb', () => TEXT);
    await s.settle();
    const invokes = s.invokeCount();
    const publishes = s.published.length;
    let read = 0;
    const ms = syncCost(() =>
      s.runner.refresh('/a.erb', () => {
        read++;
        return TEXT;
      }),
    );
    await s.settle();
    expect(read).toBe(0);
    expect(s.invokeCount()).toBe(invokes); // 一次通道调用都没多
    expect(s.published.length).toBe(publishes + 1);
    expect(s.published.at(-1)).toEqual(s.published.at(-2));
    console.info(`[PERF-4] 同版本重触发（缓存命中）同步轮 ${ms.toFixed(3)} ms`);
  });

  it('worker 不在表时：异步就地执行（同步轮不跑重活，CPU 留在本线程）', async () => {
    const s = setup(true, false);
    const ms = syncCost(() => s.runner.refresh('/a.erb', () => TEXT));
    const heavyMs = heavySyncCost(); // 同一轮、同一份文本的"重活就地跑完"对照
    expect(s.published).toHaveLength(1); // 只有没声明 offloadKind 的轻装饰
    expect(s.published[0]!.length).toBe(1);
    await s.settle();
    expect(s.published.at(-1)!.length).toBeGreaterThan(1);
    console.info(
      `[PERF-4] worker 不在表（异步就地）同步轮 ${ms.toFixed(2)} ms ｜ 同窗重活就地 ${heavyMs.toFixed(2)} ms` +
        ` ｜ 比值 ${(ms / heavyMs).toFixed(4)}（判据 <0.2）`,
    );
    expect(ms).toBeLessThan(heavyMs * 0.2);
    expect(ms).toBeLessThan(200); // 塌方级绝对护栏
    expect(s.invokeCount()).toBe(0); // 一条都没进通道
    expect(s.runner.stats().inline).toBe(2);
    expect(s.runner.stats().worker).toBe(0);
  });

  it('三路齐全（两条 ERB + 一条糖）：同步轮只装配的读数', async () => {
    const KOJO = bigKojo(500);
    const ERB_PATH = '/game/ERB/a.erb';
    const KOJO_PATH = '/kojo/a.kojo';
    const sugar = createSugarTranspileService();

    /** @param declare 三路是否都声明 offloadKind（false = 改动前的"三路本地同步"） */
    function runThree(declare: boolean): {
      syncMs: number;
      sugarRuns: () => number;
      published: () => LineDecoration[][];
      settle: () => Promise<void>;
    } {
      const pool = createComputePool();
      for (const [kind, impl] of Object.entries(computeTasks)) pool.registerTask(kind, impl as never);
      pool.attachTransport({
        available: true,
        invoke: async (kind, payload) => {
          await new Promise((r) => setTimeout(r, 0));
          return (computeTasks[kind as keyof typeof computeTasks] as (p: unknown) => LineDecoration[])(payload);
        },
      });
      let sugarRuns = 0;
      const decorated: LineDecoration[][] = [];
      const structure: MarkerContributor = {
        id: 'erb-structure',
        ...(declare ? { offloadKind: 'erb.structureDecorations' } : {}),
        decorate: ({ path, text }) => erbStructureDecorations({ path, text }),
      };
      const expr: MarkerContributor = {
        id: 'erb-expr-syntax',
        ...(declare ? { offloadKind: 'erb.exprSyntaxDecorations' } : {}),
        decorate: ({ path, text }) => exprSyntaxDecorations({ path, text }, scanControlFlow),
      };
      // 糖线：转译器在宿主侧吃服务实例（ worker 复现不了）⇒ 声明 kind 也只能"异步就地"
      const sugarDecor: MarkerContributor = {
        id: 'sugar-diagnostics',
        ...(declare ? { offloadKind: 'sugar.diagnostics' } : {}),
        decorate: ({ path, text }) => {
          if (!/\.kojo$/i.test(path)) return [];
          sugarRuns++;
          return sugar
            .transpile(text, { filePath: path })
            .diagnostics.filter((d) => d.loc !== null)
            .map((d) => ({ line: d.loc!.line, severity: d.severity, message: d.message, code: d.code }));
        },
      };
      const versions = new Map([
        [ERB_PATH, 1],
        [KOJO_PATH, 1],
      ]);
      const runner = createMarkerRunner({
        compute: pool,
        workerHasTask: hasWorkerTask,
        contributors: () => [sugarDecor, structure, expr],
        project: () => project(),
        versionOf: (p) => versions.get(p),
        publish: (_p, decorations) => decorated.push(decorations),
      });
      const syncMs =
        syncCost(() => runner.refresh(ERB_PATH, () => TEXT)) +
        syncCost(() => runner.refresh(KOJO_PATH, () => KOJO));
      return {
        syncMs,
        sugarRuns: () => sugarRuns,
        published: () => decorated,
        settle: async () => {
          for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
        },
      };
    }

    const warm = runThree(false);
    await warm.settle();
    const before = runThree(false);
    await before.settle();
    const after = runThree(true);
    expect(after.sugarRuns()).toBe(0); // 同步轮里糖一次都没转译
    await after.settle();
    expect(after.sugarRuns()).toBe(1); // 异步就地那一轮才跑
    expect(after.syncMs).toBeLessThan(before.syncMs);
    // 语义不回退：两拍之后落在屏上的整档与同步跑出来的逐字段一致
    expect(after.published().at(-1)).toEqual(before.published().at(-1));
    console.info(
      `[PERF-4] 三路齐全（6000 行 ERB + 2000 行 .kojo）同步轮合计：本地同步 ${before.syncMs.toFixed(2)} ms` +
        ` → 派发后 ${after.syncMs.toFixed(2)} ms`,
    );
  });

  it('装配表判据：两条 ERB 装饰 + 条件抽取整链在 worker 表里、糖那条不在（不静默、可核对）', () => {
    expect(hasWorkerTask('erb.structureDecorations')).toBe(true);
    expect(hasWorkerTask('erb.exprSyntaxDecorations')).toBe(true);
    expect(hasWorkerTask('sugar.diagnostics')).toBe(false);
    // PS-11 起 `condition.extractFile`（单文件抽取整链）也经同一张装配表出货
    expect(Object.keys(computeTasks).sort()).toEqual([
      'condition.extractFile',
      'erb.exprSyntaxDecorations',
      'erb.parseFile',
      'erb.scanControlFlow',
      'erb.structureDecorations',
    ]);
    // 合成表确实由 erb-parser 的纯扫描器填的（不是空壳），且与插件导出的纯函数同结果
    const viaTable = conditionExtractorTasks(scanControlFlow)['erb.exprSyntaxDecorations'] as unknown as (p: {
      path: string;
      text: string;
    }) => LineDecoration[];
    expect(viaTable({ path: '/a.erb', text: TEXT })).toEqual(
      exprSyntaxDecorations({ path: '/a.erb', text: TEXT }, scanControlFlow),
    );
  });
});
