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
  createProjectScanner,
  decorateScanFile,
  filterInsideRoots,
  planScanBatches,
  toEditorProblem,
  type ScanContributor,
  type ProjectScannerDeps,
} from '../src/ui/project-diagnostics';
import type { EditorProblem, ProjectScanCoverage } from '../src/ui/problem-store';

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

/* ---------------------------------- 分批 ---------------------------------- */

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

  it('分批之间让路：一批一次，几批几次（6 个文件 / 每批 2 ⇒ 3 次）', async () => {
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
    expect(yields).toBe(3);
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
