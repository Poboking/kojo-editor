/**
 * 整项目诊断采集器（工包「未打开文件永不上账」的采集腿）单测。
 *
 * 这一批**只测纯逻辑**：采集器不接后台调度、不接 React、不碰磁盘——`readFile` /
 * `publish` / `onCoverage` 全是注入的假腿，所以"迟到不许覆盖新账""单文件抛错只跳该文件"
 * "越界一个字节都不读"这三条判据都能在这里被确定性地在毫秒级钉死。
 *
 * 接线（谁在什么时机叫 `run()`）不在本批，判据与取值口径写在批次回报里。
 */

import { describe, expect, it } from 'vitest';
import type { GameProject, LineDecoration } from '@kojo/plugin-api';
import {
  SCAN_BULK_CHUNK,
  SCAN_BULK_CHUNK_MIN,
  SCAN_BULK_INFLIGHT,
  bulkChunkSize,
  createProjectScanner,
  decorateScanFile,
  filterInsideRoots,
  planScanBatches,
  toEditorProblem,
  type ScanContributor,
  type ProjectScannerDeps,
} from '../src/ui/project-diagnostics';
import type { EditorProblem, ProjectScanCoverage } from '../src/ui/problem-store';
import { computeTasks, hasWorkerTask } from '../src/compute-tasks';
import { SEMANTIC_DIAGNOSTICS_TASK, semanticDiagnosticsBulk } from '@kojo/plugin-erb-parser';

const ROOT = 'C:/game/ERB';
const A = `${ROOT}/001/M_KOJO_K1_1.ERB`;
const B = `${ROOT}/001/M_KOJO_K1_2.ERB`;
const C = `${ROOT}/002/M_KOJO_K2_1.ERB`;
const OUTSIDE = 'C:/Windows/notepad.ERB';

const deco = (over: Partial<LineDecoration> & Pick<LineDecoration, 'line'>): LineDecoration => ({
  severity: 'error',
  message: '结构不闭合',
  ...over,
});

const contrib = (
  id: string,
  fn: (file: { path: string; text: string; project: GameProject | null }) => LineDecoration[],
): ScanContributor => ({ id, decorate: fn });

/* ------------------------------- 映射与逐路隔离 ------------------------------- */

describe('toEditorProblem · 与编辑器那一簇同一份映射', () => {
  it('列区间 / code / source 都接住；没有 startColumn 就不造 span（退化判据只有一处）', () => {
    expect(toEditorProblem(A, deco({ line: 4, startColumn: 3, endColumn: 11, code: 'erb.x', source: 'erb-parser' }))).toEqual({
      path: A,
      line: 4,
      span: { columnStart: 3, columnEnd: 11 },
      severity: 'error',
      message: '结构不闭合',
      code: 'erb.x',
      source: 'erb-parser',
    });
    expect(toEditorProblem(A, deco({ line: 2 })).span).toBeUndefined();
    // endColumn 缺席时退化成起点那一列（与 EditorPane.publish 逐字同款）
    expect(toEditorProblem(A, deco({ line: 2, startColumn: 7 })).span).toEqual({ columnStart: 7, columnEnd: 7 });
  });
});

describe('decorateScanFile · 一路炸不许带走整份文件', () => {
  it('其余路照常上账，炸的那一路 id 被点名（少一路诊断会改变计数，不许静默）', () => {
    const out = decorateScanFile(
      [
        contrib('a', () => [deco({ line: 1 })]),
        contrib('boom', () => {
          throw new Error('插件内部炸了');
        }),
        contrib('c', ({ text }) => (text.includes('x') ? [deco({ line: 9, severity: 'warning', message: 'x' })] : [])),
      ],
      { path: A, text: 'has x here', project: null },
    );
    expect(out.problems.map((p) => `${p.line}/${p.severity}`)).toEqual(['1/error', '9/warning']);
    expect(out.failedContributors).toEqual(['boom']);
  });

  it('每一路都收到 `bulk: true`（R4a：整项目扫描的产物只进问题列表，不给人眼）', () => {
    const seen: (boolean | undefined)[] = [];
    decorateScanFile(
      [
        { id: 'a', decorate: (file) => { seen.push((file as { bulk?: boolean }).bulk); return []; } },
        { id: 'b', decorate: (file) => { seen.push((file as { bulk?: boolean }).bulk); return []; } },
      ],
      { path: A, text: 'x', project: null },
    );
    // 两路都 True：判据是"这一轮是扫描"，不是"某一路特例"
    expect(seen).toEqual([true, true]);
  });

  it('全部路都炸 ⇒ 空结果 + 全部点名（这一格等于"今天没问题"是假的，必须看得见）', () => {
    const out = decorateScanFile(
      [
        contrib('x', () => {
          throw new Error('1');
        }),
        contrib('y', () => {
          throw new Error('2');
        }),
      ],
      { path: A, text: '', project: null },
    );
    expect(out.problems).toEqual([]);
    expect(out.failedContributors).toEqual(['x', 'y']);
  });
});

describe('批量 kind 真的在计算池任务表里', () => {
  it('`hasWorkerTask` 覆盖它，且表里那一格跑出来的结果就是插件导出的那份（kind 写错会静默退化成逐文件）', () => {
    // 这条不是形式主义：`compute-tasks.ts` 的头注写着"kind 写错会静默退化为 unknown task"，
    // 而退化的表现只是变慢、不报错——所以"表里有、且接的是那根线"必须由判据钉住。
    expect(hasWorkerTask(SEMANTIC_DIAGNOSTICS_TASK)).toBe(true);
    const payload = { ctx: null, files: [{ path: 'C:/game/ERB/A.ERB', text: '@F()\n    IF UNDECLARED_X == 1\n    ENDIF' }] };
    const viaTable = (computeTasks[SEMANTIC_DIAGNOSTICS_TASK] as (p: unknown) => { perFile: unknown })(payload);
    // 表里那格是 `((payload) => semanticDiagnosticsBulk(payload)) as never`（包了一层），
    // 所以比**产出**不比身份：产出逐字段相同 = 接的就是那一根线
    expect(viaTable).toEqual(semanticDiagnosticsBulk(payload));
    expect(JSON.stringify(viaTable)).toContain('ERB_UNDEFINED_NAME');
  });
});

/* --------------------------- 批量通道（R4b，2026-10-29） --------------------------- */

/** 带批量面的贡献：`decorate` 是回退路径（批量成了就**不该**被走到） */
const bulkContrib = (
  id: string,
  fn: (file: { path: string; text: string; project: GameProject | null }) => LineDecoration[],
  opts: { kind?: string; context?: () => unknown } = {},
): ScanContributor => ({
  id,
  decorate: fn,
  bulk: { kind: opts.kind ?? `k.${id}`, context: opts.context ?? (() => ({ tag: id })) },
});

describe('批量通道 · 一块只派一次，逐文件上账照旧', () => {
  it('凑不满一块 ⇒ 攒到收尾派一次；载荷带齐路径与上下文，产物按文件摊开、贡献顺序不变', async () => {
    const calls: { kind: string; files: string[]; ctx: unknown }[] = [];
    const h = harness({
      files: { [A]: 'bad', [B]: 'clean', [C]: 'bad' },
      contributors: [
        bulkContrib('bulk-a', () => {
          throw new Error('批量成功了就不该走就地');
        }),
        contrib('plain', ({ text }) => (text.includes('bad') ? [deco({ line: 3 })] : [])),
      ],
      offload: async (kind, payload) => {
        const p = payload as { ctx: unknown; files: { path: string; text: string }[] };
        calls.push({ kind, files: p.files.map((f) => f.path), ctx: p.ctx });
        return { perFile: p.files.map((f) => (f.text.includes('bad') ? [deco({ line: 7 })] : [])) };
      },
    });
    const out = await h.scanner.run();
    // 分批键 = 父目录（/001 的 A,B 一批、/002 的 C 一批）是**上账**粒度；
    // 派发粒度是 `SCAN_BULK_CHUNK`（128）⇒ 三份文件凑不满一块，攒到收尾派**一次**
    expect(calls.map((c) => c.files)).toEqual([[A, B, C]]);
    expect(calls.map((c) => c.kind)).toEqual(['k.bulk-a']);
    expect(calls[0]!.ctx).toEqual({ tag: 'bulk-a' });
    expect(out).toMatchObject({ status: 'complete', scanned: 3, published: 3, degraded: 0 });
    // 同一份文件里：bulk-a 的（第 7 行）在前、plain 的（第 3 行）在后
    // ——顺序 = 贡献声明顺序，**不按行号重排**（去重是"留先到的"）
    expect(h.published.get(A)!.map((p) => p.line)).toEqual([7, 3]);
    expect(h.published.get(B)).toEqual([]);
    expect(h.published.get(C)!.map((p) => p.line)).toEqual([7, 3]);
  });

  it('凑够一块就派：129 份按「计划数 / 在飞宽度」切成 33×3 + 30，顺序不颠倒', async () => {
    const files: Record<string, string> = {};
    const order: string[] = [];
    for (let i = 0; i < 129; i++) {
      const p = `${ROOT}/001/F${String(i).padStart(3, '0')}.ERB`;
      files[p] = 'bad';
      order.push(p);
    }
    const sizes: number[] = [];
    const h = harness({
      files,
      contributors: [bulkContrib('bulk-a', () => [])],
      offload: async (_kind, payload) => {
        const sent = (payload as { files: { path: string }[] }).files;
        sizes.push(sent.length);
        // 每份文件带一条自己的行号，用来验"按文件摊开"没串位
        return { perFile: sent.map((f) => [deco({ line: Number(f.path.slice(-7, -4)) + 1 })]) };
      },
    });
    const out = await h.scanner.run();
    // 129 / 4（缺省在飞宽度）= 33 ⇒ 33/33/33/30。**不是** 128 + 1：尾巴块只装 1 份时，
    // 另外三块各背 128 份，并行墙钟就由最慢那块决定（真语料实测差 3.05× vs 3.74×）
    expect(sizes).toEqual([33, 33, 33, 30]);
    expect(out).toMatchObject({ status: 'complete', scanned: 129, published: 129 });
    expect(h.published.get(order[0]!)!.map((p) => p.line)).toEqual([1]);
    expect(h.published.get(order[128]!)!.map((p) => p.line)).toEqual([129]);
  });

  it('在飞宽度钉成 1 ⇒ 回到 R4b 的 128 + 1 口径，**结果一字不差**', async () => {
    // 这条钉的是"并行只是调度，不是语义"：同一份输入、同一份通道，块怎么切都不许
    // 改变任何一份文件的产出。切块方式一变就改判据面的实现，在这里会被当场抓住。
    const files: Record<string, string> = {};
    const order: string[] = [];
    for (let i = 0; i < 129; i++) {
      const p = `${ROOT}/001/G${String(i).padStart(3, '0')}.ERB`;
      files[p] = 'bad';
      order.push(p);
    }
    const sizes: number[] = [];
    const h = harness({
      files,
      bulkInflight: 1,
      contributors: [bulkContrib('bulk-a', () => [])],
      offload: async (_kind, payload) => {
        const sent = (payload as { files: { path: string }[] }).files;
        sizes.push(sent.length);
        return { perFile: sent.map((f) => [deco({ line: Number(f.path.slice(-7, -4)) + 1 })]) };
      },
    });
    const out = await h.scanner.run();
    expect(sizes, '129 / 1 ⇒ 一块 128（上界）+ 余数 1').toEqual([128, 1]);
    expect(out).toMatchObject({ status: 'complete', scanned: 129, published: 129 });
    expect(h.published.get(order[0]!)!.map((p) => p.line)).toEqual([1]);
    expect(h.published.get(order[128]!)!.map((p) => p.line)).toEqual([129]);
  });

  it('通道炸一次 ⇒ 这一路整轮回退就地（产出与就地逐条相同，不再白试第二批）', async () => {
    let calls = 0;
    const h = harness({
      files: { [A]: 'bad', [C]: 'bad' },
      perBatch: 1,
      contributors: [bulkContrib('bulk-a', ({ text }) => (text.includes('bad') ? [deco({ line: 5, code: 'c.1' })] : []))],
      offload: async () => {
        calls++;
        throw new Error('channel down');
      },
    });
    const out = await h.scanner.run();
    expect(calls).toBe(1);
    expect(out).toMatchObject({ status: 'complete', scanned: 2, published: 2, degraded: 0 });
    expect(h.published.get(A)!.map((p) => p.code)).toEqual(['c.1']);
    expect(h.published.get(C)!.map((p) => p.code)).toEqual(['c.1']);
  });

  it('形状不符（perFile 长度对不上）⇒ 回退就地，绝不按错位的结果上账', async () => {
    const h = harness({
      files: { [A]: 'bad' },
      contributors: [bulkContrib('bulk-a', ({ text }) => (text.includes('bad') ? [deco({ line: 5 })] : []))],
      offload: async () => ({ perFile: [] }),
    });
    const out = await h.scanner.run();
    expect(out.published).toBe(1);
    expect(h.published.get(A)!.map((p) => p.line)).toEqual([5]);
  });

  it('没有批量通道 ⇒ 一次都不派（与 R4b 之前逐字相同）', async () => {
    let decorated = 0;
    const h = harness({
      files: { [A]: 'bad' },
      contributors: [
        bulkContrib('bulk-a', ({ text }) => {
          decorated++;
          return text.includes('bad') ? [deco({ line: 5 })] : [];
        }),
      ],
    });
    await h.scanner.run();
    expect(decorated).toBe(1);
  });

  it('上下文每轮只构造一次（批次再多也只付一次固定税）', async () => {
    let built = 0;
    const h = harness({
      files: { [A]: 'bad', [C]: 'bad' },
      perBatch: 1,
      contributors: [
        bulkContrib('bulk-a', () => [], {
          context: () => {
            built++;
            return null;
          },
        }),
      ],
      offload: async (_kind, payload) => ({
        perFile: (payload as { files: unknown[] }).files.map(() => []),
      }),
    });
    await h.scanner.run();
    expect(built).toBe(1);
  });

  it('上下文构造不出来 ⇒ 这一路整轮就地（整轮不失败、也不白派）', async () => {
    let calls = 0;
    const h = harness({
      files: { [A]: 'bad' },
      contributors: [
        bulkContrib('bulk-a', ({ text }) => (text.includes('bad') ? [deco({ line: 2 })] : []), {
          context: () => {
            throw new Error('no index');
          },
        }),
      ],
      offload: async () => {
        calls++;
        return { perFile: [] };
      },
    });
    const out = await h.scanner.run();
    expect(calls).toBe(0);
    expect(out).toMatchObject({ status: 'complete', published: 1 });
    expect(h.published.get(A)!.map((p) => p.line)).toEqual([2]);
  });

  it('读失败的文件不进批量载荷（它已经记了 skipped，不该再冒充"算过"）', async () => {
    const sent: string[][] = [];
    const h = harness({
      files: { [A]: 'bad', [C]: 'bad' }, // B 不存在 ⇒ readFile 抛
      listFiles: () => [A, B, C],
      contributors: [bulkContrib('bulk-a', () => [])],
      offload: async (_kind, payload) => {
        const files = (payload as { files: { path: string }[] }).files;
        sent.push(files.map((f) => f.path));
        return { perFile: files.map(() => []) };
      },
    });
    const out = await h.scanner.run();
    expect(out).toMatchObject({ status: 'complete', scanned: 3, skipped: 1, published: 2 });
    expect(sent).toEqual([[A, C]]);
  });
});



describe('planScanBatches · 上限、分批、确定性', () => {
  it('按父目录成组（组间码点序、组内路径码点序），perBatch 只切组内不跨组', () => {
    const batches = planScanBatches([C, B, A], { perBatch: 1 });
    expect(batches.map((b) => `${b.label}|${b.paths.length}`)).toEqual([
      `${ROOT}/001|1`,
      `${ROOT}/001|1`,
      `${ROOT}/002|1`,
    ]);
    expect(batches.map((b) => b.paths[0])).toEqual([A, B, C]);
  });

  it('同一文件的两种 Windows 写法只办一次（读两遍算两遍就是造假账）', () => {
    const alt = `${ROOT}\\001\\M_KOJO_K1_1.erb`;
    expect(planScanBatches([A, alt, B], { perBatch: 8 }).reduce((n, b) => n + b.paths.length, 0)).toBe(2);
  });

  it('maxFiles 截断发生在排好序之后 ⇒ 每轮截到的是同一段，不是随机的一把', () => {
    const many = Array.from({ length: 20 }, (_, i) => `${ROOT}/001/F${String(i).padStart(2, '0')}.ERB`);
    const first = planScanBatches(many, { perBatch: 4, maxFiles: 6 });
    const again = planScanBatches([...many].reverse(), { perBatch: 4, maxFiles: 6 });
    expect(first.reduce((n, b) => n + b.paths.length, 0)).toBe(6);
    expect(again.flatMap((b) => b.paths)).toEqual(first.flatMap((b) => b.paths));
  });

  it('keyOf 可换成角色键（宿主按角色分批时，同一角色的文件必须挨着出）', () => {
    const batches = planScanBatches([A, B, C], { keyOf: (p) => (p.includes('/002/') ? '#2' : '#1'), perBatch: 8 });
    expect(batches.map((b) => `${b.label}:${b.paths.length}`)).toEqual(['#1:2', '#2:1']);
  });
});

describe('filterInsideRoots · 允许域闸（没声明根就没资格读任何东西）', () => {
  it('根外一律拒', () => {
    const r = filterInsideRoots([A, OUTSIDE], [ROOT]);
    expect(r.allowed).toEqual([A]);
    expect(r.rejected).toEqual([OUTSIDE]);
  });
  it('roots 为空 ⇒ 全拒（不是"全允许"）', () => {
    expect(filterInsideRoots([A, B], []).allowed).toEqual([]);
  });
});

/* --------------------------------- 采集器 --------------------------------- */

interface Harness {
  readonly scanner: ReturnType<typeof createProjectScanner>;
  readonly published: Map<string, readonly EditorProblem[]>;
  readonly reads: string[];
  readonly coverages: ProjectScanCoverage[];
}

function harness(
  opts: {
    files: Record<string, string>;
    roots?: readonly string[];
    contributors?: readonly ScanContributor[];
    perBatch?: number;
    maxFiles?: number;
    extraPaths?: () => readonly string[];
    pendingRescanCount?: () => number;
    readFile?: (path: string) => Promise<string>;
    listFiles?: () => readonly string[];
    yieldBetween?: () => Promise<void>;
    offload?: (kind: string, payload: unknown) => Promise<unknown>;
    bulkInflight?: number;
  },
): Harness {
  const published = new Map<string, readonly EditorProblem[]>();
  const reads: string[] = [];
  const coverages: ProjectScanCoverage[] = [];
  const contributors =
    opts.contributors ?? [contrib('structure', ({ text }) => (text.includes('bad') ? [deco({ line: 1 })] : []))];
  const deps: ProjectScannerDeps = {
    listFiles: opts.listFiles ?? (() => Object.keys(opts.files)),
    roots: () => opts.roots ?? [ROOT],
    project: () => null,
    contributors: () => contributors,
    readFile: opts.readFile ?? (async (path) => {
      reads.push(path);
      const text = opts.files[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    }),
    publish: (path, problems) => {
      published.set(path, problems);
    },
    onCoverage: (c) => {
      coverages.push({ ...c });
    },
    extraPaths: opts.extraPaths,
    pendingRescanCount: opts.pendingRescanCount,
    yieldBetween: opts.yieldBetween,
    ...(opts.offload === undefined ? {} : { offload: opts.offload }),
    ...(opts.bulkInflight === undefined ? {} : { bulkInflight: opts.bulkInflight }),
    perBatch: opts.perBatch ?? 8,
    maxFiles: opts.maxFiles ?? 0,
  };
  return { scanner: createProjectScanner(deps), published, reads, coverages };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('createProjectScanner · 正常一轮', () => {
  it('每个文件整档上账一次，覆盖读数从头到尾都在说"跑到哪了"', async () => {
    const h = harness({ files: { [A]: 'bad', [B]: 'clean', [C]: 'bad' } });
    const out = await h.scanner.run();
    expect(out).toMatchObject({ status: 'complete', scanned: 3, total: 3, published: 3, skipped: 0, capped: false });
    expect(h.published.get(A)?.map((p) => `${p.path}:${p.line}`)).toEqual([`${A}:1`]);
    expect(h.published.get(B)).toEqual([]); // 干净文件也要过一次手（空结果由 store 决定留不留）
    expect(h.coverages.at(-1)).toMatchObject({ status: 'complete', scanned: 3, total: 3, roots: [ROOT] });
    expect(h.scanner.isRunning()).toBe(false);
  });

  it('让路粒度 = 单个文件：6 个文件 / 每批 2 ⇒ 6 次（批不再是对外的让路单位）', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`${ROOT}/001/F${i}.ERB`] = 'bad';
    let yields = 0;
    const h = harness({
      files,
      perBatch: 2,
      yieldBetween: () => {
        yields++;
        return Promise.resolve();
      },
    });
    await h.scanner.run();
    // P0-2 批 4：旧口径「一批一次」= 3 次，但一批 16 个文件在真壳实测是一条 580ms 长任务，
    // 所以让路点下沉到**每一项**——总数跟着文件数走（不是批数）
    expect(yields).toBe(6);
  });
});

describe('createProjectScanner · 三条不可让步的纪律', () => {
  it('越界路径一个字节都不读，并且把拒读数量说出来', async () => {
    const h = harness({ files: { [A]: 'bad', [OUTSIDE]: 'bad' } });
    const out = await h.scanner.run();
    expect(h.reads).toEqual([A]); // 域外那份连 readFile 都没进过
    expect(out).toMatchObject({ outOfRoots: 1, scanned: 1, published: 1, status: 'complete' });
    expect(h.coverages.at(-1)).toMatchObject({ outOfRoots: 1 });
  });

  it('单文件读盘炸只跳该文件，其余照常上账（可见降级，不整轮崩）', async () => {
    const h = harness({
      files: { [A]: 'bad', [B]: 'bad' },
      readFile: async (path) => {
        if (path === A) throw new Error('EBUSY');
        return 'bad';
      },
    });
    const out = await h.scanner.run();
    expect(out).toMatchObject({ status: 'complete', scanned: 2, skipped: 1, published: 1 });
    expect(out.errors.map((e) => e.path)).toEqual([A]);
    expect(out.errors[0]!.reason).toContain('EBUSY');
  });

  it('某一路诊断方抛错 ⇒ 该格计入 degraded，其余路的结果照样上账', async () => {
    const h = harness({
      files: { [A]: 'bad' },
      contributors: [
        contrib('structure', () => [deco({ line: 1 })]),
        contrib('expr', () => {
          throw new Error('表达式层炸了');
        }),
      ],
    });
    const out = await h.scanner.run();
    expect(out).toMatchObject({ status: 'complete', degraded: 1, skipped: 0, published: 1 });
    expect(h.published.get(A)).toHaveLength(1);
    expect(out.errors[0]!.reason).toContain('expr');
  });

  it('取消：在途那份结果作废、账不再动，覆盖读数落在 cancelled（已上账的部分知道自己不完整）', async () => {
    const gates = new Map<string, (text: string) => void>();
    const h = harness({
      files: { [A]: 'bad', [B]: 'bad', [C]: 'bad' },
      readFile: (path) =>
        new Promise<string>((resolve) => {
          gates.set(path, resolve);
        }),
    });
    const p = h.scanner.run({ perBatch: 1 });
    await tick();
    expect(h.scanner.isRunning()).toBe(true);
    gates.get(A)!("bad"); // 第一份落地上账
    await tick();
    h.scanner.cancel();
    expect(h.scanner.isRunning()).toBe(false);
    gates.get(B)!("bad"); // 迟到的第二份：新账已开，这一份必须被丢
    const out = await p;
    expect(out.status).toBe('cancelled');
    expect(out.discarded).toBe(1);
    expect([...h.published.keys()]).toEqual([A]);
    expect(h.coverages.at(-1)!.status).toBe('cancelled');
    // 取消时保留当时的进度（"扫到第几个"停了要说得出来，不是抹成零）
    expect(h.coverages.at(-1)).toMatchObject({ scanned: 1, total: 3 });
  });

  it('新一轮取代旧轮 ⇒ 迟到的旧结果不许盖掉新轮刚写的账', async () => {
    const gates: Array<{ path: string; resolve: (t: string) => void }> = [];
    let round = 0;
    const h = harness({
      files: { [A]: 'x' },
      readFile: (path) => {
        const mine = round++;
        return new Promise<string>((resolve) => {
          gates.push({ path, resolve });
        }).then((t) => `${t}#${mine}`);
      },
      contributors: [
        contrib('structure', ({ text }) => [deco({ line: text.endsWith('#1') ? 7 : 3 })]),
      ],
    });
    const pA = h.scanner.run({ perBatch: 4 });
    await tick();
    const pB = h.scanner.run({ perBatch: 4 }); // 取代 A
    await tick();
    expect(gates).toHaveLength(2);
    gates[1]!.resolve('x'); // 新轮的先回来
    const outB = await pB;
    await tick();
    gates[0]!.resolve('x'); // 旧轮的迟到
    const outA = await pA;
    expect(outB.status).toBe('complete');
    expect(outA.discarded).toBeGreaterThanOrEqual(1);
    expect(h.published.get(A)?.[0]?.line).toBe(7); // 屏幕上仍是新轮那份
    // 旧轮退场时**也不刷读数**：拿一堆 0 去覆盖新轮刚写的进度，是同一个 bug 的另一半
    expect(h.scanner.coverage()).toMatchObject({ status: 'complete', scanned: 1, total: 1 });
    expect(h.coverages.at(-1)).toMatchObject({ status: 'complete', scanned: 1 });
    expect(h.scanner.isRunning()).toBe(false);
  });

  it('批量上限：撞顶那轮说得出自己没跑完（capped ⇒ 标签不肯说"已扫描"）', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`${ROOT}/001/F${i}.ERB`] = 'bad';
    const h = harness({ files, maxFiles: 4 });
    const out = await h.scanner.run();
    expect(out).toMatchObject({ status: 'complete', scanned: 4, total: 10, capped: true });
    expect(h.coverages.at(-1)!.capped).toBe(true);
  });

  it('复核轮：只办队列里的路径，不重新列举文件', async () => {
    let listed = 0;
    const h = harness({
      files: { [A]: 'bad', [B]: 'bad' },
      extraPaths: () => [B],
      listFiles: () => {
        listed++;
        return [A];
      },
    });
    const out = await h.scanner.run({ rescanOnly: true });
    expect(out).toMatchObject({ status: 'complete', total: 1, published: 1 });
    expect(h.reads).toEqual([B]);
    expect(listed).toBe(0);
  });

  it('整轮一个都不许读（根没声明）⇒ failed，而不是"扫完了、没问题"', async () => {
    const h = harness({ files: { [A]: 'bad' }, roots: [] });
    const out = await h.scanner.run();
    expect(out.status).toBe('failed');
    expect(h.reads).toEqual([]);
  });

  it('覆盖读数只在真变了时写：pendingRescan 由宿主那侧报数，采集器不自己编', async () => {
    const h = harness({ files: { [A]: 'bad' }, pendingRescanCount: () => 3 });
    await h.scanner.run();
    expect(h.coverages.at(-1)).toMatchObject({ status: 'complete', pendingRescan: 3 });
  });
});

/* --------------------- 多块在飞（C 批遗留，2026-10-29） --------------------- */

describe('bulkChunkSize · 块大小由「计划数 / 在飞宽度」算，不是定值', () => {
  it('铺满池子：块数 ≈ 在飞宽度（真语料 400 份 ⇒ 4 块各 100）', () => {
    expect(bulkChunkSize(400, 4)).toBe(100);
    expect(bulkChunkSize(129, 4)).toBe(33);
    expect(bulkChunkSize(1000, 4)).toBe(128); // 上界：再大就过不了"取消要能有限步生效"
  });

  it('上下界都在：小盘子不被切碎（≥16），大盘子不被切成超大块（≤128）', () => {
    expect(bulkChunkSize(16, 4)).toBe(SCAN_BULK_CHUNK_MIN); // 4 份一块会白交 4 次克隆税
    expect(bulkChunkSize(1, 4)).toBe(SCAN_BULK_CHUNK_MIN);
    expect(bulkChunkSize(4000, 4)).toBe(SCAN_BULK_CHUNK);
    expect(bulkChunkSize(400, 1)).toBe(SCAN_BULK_CHUNK); // 单槽 ⇒ 一块到底（R4b 口径）
  });

  it('宽度非法也不炸：0 / 负数 / 小数都按 1 算', () => {
    expect(bulkChunkSize(400, 0)).toBe(SCAN_BULK_CHUNK);
    expect(bulkChunkSize(400, -3)).toBe(SCAN_BULK_CHUNK);
    expect(bulkChunkSize(400, 2.7)).toBe(128);
  });
});

/** 手动闸：让 offload 悬在"已派出、未回话"那个状态上（并行度只能这样测） */
function gate(): { p: Promise<unknown>; resolve: (v: unknown) => void } {
  let resolve!: (v: unknown) => void;
  const p = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { p, resolve };
}

/** 造 n 份文件（同一目录，父目录批键相同） */
function manyFiles(prefix: string, n: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) out[`${ROOT}/001/${prefix}${String(i).padStart(3, '0')}.ERB`] = 'bad';
  return out;
}

describe('并行派发 · 多块同时在飞，上账仍按文件序', () => {
  it('80 份 / 宽度 4 ⇒ 四块各 20 份**同时**在飞（不是派一块等一块）', async () => {
    let live = 0;
    let maxLive = 0;
    const gates: ReturnType<typeof gate>[] = [];
    const sizes: number[] = [];
    const h = harness({
      files: manyFiles('H', 80),
      perBatch: 80,
      contributors: [bulkContrib('bulk-a', () => [])],
      offload: (_kind, payload) => {
        sizes.push((payload as { files: unknown[] }).files.length);
        live++;
        maxLive = Math.max(maxLive, live);
        const g = gate();
        gates.push(g);
        return g.p.then(
          (v) => {
            live--;
            return v;
          },
          (e: unknown) => {
            live--;
            throw e;
          },
        );
      },
    });
    const p = h.scanner.run();
    await tick();
    await tick();
    // 四块都派出去了，而且一块都还没回 —— 串行派发在这里只会看到 1
    expect(sizes, '80 / 4 = 20 份一块，四块').toEqual([20, 20, 20, 20]);
    expect(maxLive, '同时在飞 = 池的宽度（R4b 的缺口正是这里只有 1）').toBe(SCAN_BULK_INFLIGHT);
    expect(h.published.size, '一个都没回话，一份都不许上账').toBe(0);
    for (const g of gates) g.resolve({ perFile: Array.from({ length: 20 }, () => []) });
    const out = await p;
    expect(out).toMatchObject({ status: 'complete', scanned: 80, published: 80, degraded: 0 });
  });

  it('后块先回也不许插队：队首没回来，后面算完的都等着（上账顺序 = 文件序）', async () => {
    const files = manyFiles('O', 80);
    const want = Object.keys(files).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const gates: ReturnType<typeof gate>[] = [];
    const h = harness({
      files,
      perBatch: 80,
      contributors: [bulkContrib('bulk-a', () => [])],
      offload: () => {
        const g = gate();
        gates.push(g);
        return g.p;
      },
    });
    const p = h.scanner.run();
    await tick();
    await tick();
    expect(gates).toHaveLength(4); // 80 / 4 = 20 份一块 ⇒ 四块
    // 第 2/3/4 块先回，第 1 块还悬着
    for (const i of [1, 2, 3]) gates[i]!.resolve({ perFile: Array.from({ length: 20 }, () => []) });
    await tick();
    await tick();
    expect(h.published.size, '队首没回来 ⇒ 后面的一律排队，一份都不许先上账').toBe(0);
    gates[0]!.resolve({ perFile: Array.from({ length: 20 }, () => []) });
    const out = await p;
    expect(out.status).toBe('complete');
    // Map 的插入序就是上账序：必须与文件的计划序逐位相同
    expect([...h.published.keys()]).toEqual(want);
  });

  it('窗口 = 1 ⇒ 同一时刻只有一块在飞（回压真的生效，不是"想派就派"）', async () => {
    let live = 0;
    let maxLive = 0;
    const gates: ReturnType<typeof gate>[] = [];
    const h = harness({
      files: manyFiles('B', 200),
      perBatch: 16,
      bulkInflight: 1,
      contributors: [bulkContrib('bulk-a', () => [])],
      offload: () => {
        live++;
        maxLive = Math.max(maxLive, live);
        const g = gate();
        gates.push(g);
        return g.p.then((v) => {
          live--;
          return v;
        });
      },
    });
    const p = h.scanner.run();
    await tick();
    await tick();
    // 200 / 1 ⇒ 一块 128（上界）。**读盘都被这一块堵住了**：窗口是硬背压，不是"派了再等"
    expect(gates, '第一块没回来之前，第二块一次都不许派').toHaveLength(1);
    expect(maxLive).toBe(1);
    gates[0]!.resolve({ perFile: Array.from({ length: 128 }, () => []) });
    await tick();
    await tick();
    expect(gates, '第一块上完账，才派余数那 72 份').toHaveLength(2);
    expect(maxLive).toBe(1);
    gates[1]!.resolve({ perFile: Array.from({ length: 72 }, () => []) });
    const out = await p;
    expect(out).toMatchObject({ status: 'complete', scanned: 200, published: 200 });
  });

  it('一块炸 ⇒ 只退这一块；同一波里已经派出去的其余块照旧批量', async () => {
    const files = manyFiles('E', 80);
    const paths = Object.keys(files).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let call = 0;
    const h = harness({
      files,
      perBatch: 80,
      contributors: [
        // 就地那一路（回退时走它）
        contrib('seen-inline', () => [deco({ line: 5, code: 'inline' })]),
        bulkContrib('bulk-a', () => [deco({ line: 5, code: 'inline' })]),
      ],
      offload: async () => {
        call++;
        if (call === 1) throw new Error('这一块炸了');
        return { perFile: Array.from({ length: 20 }, () => [deco({ line: 7, code: 'bulk' })]) };
      },
    });
    const out = await h.scanner.run();
    // 同一波四块都派出去了才回话 ⇒ 四块各试一次；第一块炸了之后**不再派新块**
    expect(call).toBe(4);
    expect(out).toMatchObject({ status: 'complete', scanned: 80, published: 80, degraded: 0 });
    // 前 20 份：块炸了 ⇒ 逐文件回退 ⇒ **两路各出一条**（就地那路 + 回退的 decorate）
    for (const p of paths.slice(0, 20)) expect(h.published.get(p)!.map((x) => x.code)).toEqual(['inline', 'inline']);
    // 后 60 份：同一波的另外三块算成了 ⇒ 就地那路 + 批量那份（批量那条不会被回退顶掉）
    for (const p of paths.slice(20)) expect(h.published.get(p)!.map((x) => x.code)).toEqual(['inline', 'bulk']);
  });

  it('取消 ⇒ 已派出去的块一份都不上账，且不再派新块', async () => {
    const gates: ReturnType<typeof gate>[] = [];
    let calls = 0;
    const h = harness({
      files: manyFiles('C', 200),
      perBatch: 16,
      bulkInflight: 1,
      contributors: [bulkContrib('bulk-a', () => [])],
      offload: () => {
        calls++;
        const g = gate();
        gates.push(g);
        return g.p;
      },
    });
    const p = h.scanner.run();
    await tick();
    await tick();
    expect(calls).toBe(1);
    h.scanner.cancel();
    const before = calls;
    // 迟到的批量结论：算完了也一个字都不许上账
    gates[0]!.resolve({ perFile: Array.from({ length: 128 }, () => []) });
    const out = await p;
    expect(out.status).toBe('cancelled');
    expect(calls, '取消之后不许再派').toBe(before);
    expect(h.published.size, '已派出去的块：取消后一份都不写').toBe(0);
  });
});
