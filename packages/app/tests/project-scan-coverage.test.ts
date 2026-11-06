// @vitest-environment happy-dom
/**
 * ERBDIAG-F（D10）：项目级诊断的**覆盖轮转 + 覆盖诚实**对拍。
 *
 * 缺陷事实（组长 2026-11 实测）：`planScanBatches` 排好序之后**截断到前 400**，
 * 于是真实语料 4,258 份方言文件里每轮都是同一段前 400，约 91% 的文件的项目级诊断
 * **永远不上账**，而面板与状态栏拿这份残缺结论当项目真相。
 *
 * 本文件钉的四件事（顺序＝判据顺序，不是实现顺序）：
 * ① **预算一格不许抬**（红线）——`400 / 16 / 128 / 1 / 60s` 五个字面值钉死；
 *    把"扫得完"冒充成"扫得快"的那条路（抬 `SCAN_MAX_FILES_PER_RUN`）必须在这里红。
 * ② **游标轮转到全覆盖**——4,258 规模、每轮 ≤400、相邻两轮互不相交、
 *    `ceil(total/400)` 轮到 100% 无重无漏；采集器侧同样要一轮比一轮多覆盖。
 * ③ **覆盖读数说得出四件事**——本轮几份 / 项目共几份 / 累计到第几 / 是否扫完；
 *    扫完之前"项目没有更多问题"那类口径一律不许成立（`未发现问题` / `已扫描` 都不行）。
 * ④ **游标不许留陈旧账**——换项目（装配世代变化）作废、文件增删/索引重建按当前清单重算；
 *    已取消的轮次只给真上过账的那部分记账；让路与取消的既有语义一字不退。
 *
 * 判据只吃纯逻辑与假腿：不挂定时器、不碰磁盘、不依赖语料目录。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SCAN_BATCH_SIZE,
  SCAN_BULK_CHUNK,
  SCAN_BULK_CHUNK_MIN,
  SCAN_MAX_FILES_PER_RUN,
  SCAN_YIELD_EVERY_FILES,
  createProjectScanner,
  planScanBatches,
  type ProjectScannerDeps,
  type ScanContributor,
} from '../src/ui/project-diagnostics';
import { SCAN_FULL_ROUND_MIN_MS } from '../src/ui/project-scan-schedule';
import { ProblemPanel } from '../src/ui/ProblemPanel';
import { pkey } from '../src/ui/file-tree-ops';
import {
  clearAllProblems,
  clearProjectScan,
  IDLE_SCAN_COVERAGE,
  PROBLEM_SCOPE,
  setProjectScanCoverage,
  setProjectScanProblems,
  type EditorProblem,
  type ProjectScanCoverage,
} from '../src/ui/problem-store';

/* ------------------------------- 判据①：预算红线 ------------------------------- */

describe('ERBDIAG-F ① · 每轮预算一格不许抬（轮转不是抬预算的借口）', () => {
  it('五个字面值钉死：400 / 16 / 128（+下界 16）/ 让路 1 / 整轮间隔 60s', () => {
    // 这里刻意写**字面值**而不是引用常量互比：把 `SCAN_MAX_FILES_PER_RUN` 抬到 9999
    // 冒充"扫得完"必须在这一条上红，而不是跟着常量一起漂。
    expect(SCAN_MAX_FILES_PER_RUN).toBe(400);
    expect(SCAN_BATCH_SIZE).toBe(16);
    expect(SCAN_BULK_CHUNK).toBe(128);
    expect(SCAN_BULK_CHUNK_MIN).toBe(16);
    expect(SCAN_YIELD_EVERY_FILES).toBe(1);
    expect(SCAN_FULL_ROUND_MIN_MS).toBe(60_000);
  });

  it('轮转之后每轮仍然最多办 400 份（游标只换"办哪 400 份"，不放宽"办几份"）', () => {
    const paths = corpus(SCAN_MAX_FILES_PER_RUN * 11 + 58);
    const covered = new Set<string>();
    for (let round = 0; round < 12; round++) {
      const picked = planScanBatches(paths, { maxFiles: SCAN_MAX_FILES_PER_RUN, exclude: covered }).flatMap(
        (b) => b.paths,
      );
      expect(picked.length).toBeLessThanOrEqual(SCAN_MAX_FILES_PER_RUN);
      for (const p of picked) covered.add(pkey(p));
      if (covered.size >= paths.length) break;
    }
  });
});

/* ----------------------------- 判据②：轮转到全覆盖 ----------------------------- */

/** 语料规模的合成清单（真语料 4,258 = 正文 4,072 + 声明 186；确定性、码点序稳定） */
function corpus(n: number, root = 'C:/game/eraTW/ERB'): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const dir = `K${String(Math.floor(i / 40) % 120).padStart(3, '0')}`;
    out.push(`${root}/${dir}/M_KOJO_${String(i).padStart(5, '0')}.ERB`);
  }
  return out;
}

const CORPUS_TOTAL = 4258;
/** 真语料规模下扫完一轮需要几趟（每轮预算不变 ⇒ 只由 400 算出来） */
const EXPECTED_ROUNDS = Math.ceil(CORPUS_TOTAL / SCAN_MAX_FILES_PER_RUN);

describe('ERBDIAG-F ② · 游标轮转（纯函数对拍，4,258 规模）', () => {
  it('连续多轮：相邻两轮互不相交，且 11 轮到 100% 无重无漏', () => {
    const paths = corpus(CORPUS_TOTAL);
    expect(paths).toHaveLength(CORPUS_TOTAL);
    const covered = new Set<string>();
    let previous: readonly string[] = [];
    let rounds = 0;
    let overlapWithPrevious = 0;
    let duplicated = 0;
    for (;;) {
      const picked = planScanBatches(paths, { maxFiles: SCAN_MAX_FILES_PER_RUN, exclude: covered }).flatMap(
        (b) => b.paths,
      );
      const prevKeys = new Set(previous.map((p) => pkey(p)));
      overlapWithPrevious = picked.filter((p) => prevKeys.has(pkey(p))).length;
      for (const p of picked) {
        if (covered.has(pkey(p))) duplicated++;
        covered.add(pkey(p));
      }
      previous = picked;
      rounds++;
      if (covered.size >= paths.length || rounds > EXPECTED_ROUNDS + 3) break;
    }
    // 改前的样子：每轮都是同一段前 400 ⇒ overlap 恒等于 400、轮数爆表、覆盖率卡在 400
    expect(overlapWithPrevious).toBe(0);
    expect(duplicated).toBe(0);
    expect(rounds).toBe(EXPECTED_ROUNDS);
    expect(covered.size).toBe(CORPUS_TOTAL);
    expect(covered.size / paths.length).toBe(1);
  });

  it('同一份清单反复问 ⇒ 段序稳定（轮转不是洗牌：第 1 段永远先于第 2 段）', () => {
    const paths = [...corpus(1_000)].reverse();
    const first = planScanBatches(paths, { maxFiles: 400 }).flatMap((b) => b.paths);
    const again = planScanBatches(paths, { maxFiles: 400 }).flatMap((b) => b.paths);
    expect(again).toEqual(first);
    const covered = new Set(first.map((p) => pkey(p)));
    const second = planScanBatches([...paths].sort(), { maxFiles: 400, exclude: covered }).flatMap((b) => b.paths);
    expect(second).toHaveLength(400);
    expect(second.some((p) => covered.has(pkey(p)))).toBe(false);
  });

  it('清单里已消失的路径不占预算（游标只数当前还在的那些）', () => {
    const paths = corpus(50);
    const gone = paths.slice(0, 10);
    const rest = paths.slice(10);
    const covered = new Set(gone.map((p) => pkey(p)));
    const picked = planScanBatches(rest, { maxFiles: 40, exclude: covered }).flatMap((b) => b.paths);
    expect(picked).toHaveLength(40);
  });
});

/* --------------------------- 判据②③：采集器的多轮账 --------------------------- */

interface Harness {
  readonly scanner: ReturnType<typeof createProjectScanner>;
  readonly reads: string[];
  readonly published: string[];
  readonly coverages: ProjectScanCoverage[];
  setFiles(files: string[]): void;
  setEpoch(v: string): void;
}

function harness(
  paths: string[],
  opts: { maxFiles?: number; perBatch?: number; epoch?: () => string; onRead?: (path: string) => void } = {},
): Harness {
  const reads: string[] = [];
  const published: string[] = [];
  const coverages: ProjectScanCoverage[] = [];
  let files = paths;
  let epoch = opts.epoch?.() ?? 'project-A';
  const contributor: ScanContributor = {
    id: 'fake',
    decorate: () => [{ line: 1, severity: 'error', message: '假问题' }],
  };
  const deps: ProjectScannerDeps = {
    listFiles: () => files,
    roots: () => ['C:/game'],
    project: () => null,
    contributors: () => [contributor],
    readFile: async (path) => {
      reads.push(path);
      opts.onRead?.(path);
      return 'x';
    },
    publish: (path) => {
      published.push(path);
    },
    onCoverage: (c) => coverages.push({ ...c }),
    coverageEpoch: () => epoch,
    perBatch: opts.perBatch ?? 16,
    maxFiles: opts.maxFiles ?? SCAN_MAX_FILES_PER_RUN,
  };
  const scanner = createProjectScanner(deps);
  return {
    scanner,
    reads,
    published,
    coverages,
    setFiles: (next) => {
      files = next;
    },
    setEpoch: (v) => {
      epoch = v;
    },
  };
}

describe('ERBDIAG-F ②③ · 采集器一轮比一轮多覆盖，读数说得出四件事', () => {
  it('10 份 / 每轮 4：三轮跑到 10/10，每份只读一次，扫完那轮才允许 capped=false', async () => {
    const files = corpus(10, 'C:/game/ERB/001');
    const h = harness(files, { maxFiles: 4 });
    const r1 = await h.scanner.run();
    expect(r1).toMatchObject({ status: 'complete', scanned: 4, total: 10, covered: 4, remaining: 6, capped: true });
    const r2 = await h.scanner.run();
    expect(r2).toMatchObject({ status: 'complete', scanned: 4, covered: 8, remaining: 2, capped: true });
    const r3 = await h.scanner.run();
    expect(r3).toMatchObject({ status: 'complete', scanned: 2, covered: 10, remaining: 0, capped: false });
    expect(h.reads.slice().sort()).toEqual([...files].sort());
    expect(new Set(h.reads).size).toBe(10);
    // 再问第四轮：预算一格不花（全查过了 ⇒ 本轮 0 份，但仍然不是"项目还有多少没扫"）
    const r4 = await h.scanner.run();
    expect(r4).toMatchObject({ scanned: 0, covered: 10, remaining: 0, capped: false, status: 'complete' });
    expect(h.reads).toHaveLength(10);
    expect(h.scanner.coverage()).toMatchObject({ status: 'complete', covered: 10, remaining: 0 });
  });

  it('中途取消 ⇒ 只给真上过账的那部分记账，下一轮只补剩下的缺口（迟到的那份不领账）', async () => {
    const files = corpus(9, 'C:/game/ERB/001');
    let firstRound = true;
    const h = harness(files, {
      maxFiles: 9,
      perBatch: 2,
      onRead: () => {
        // 读到第 3 份时叫 cancel()：那一份的结论迟到 ⇒ 整份丢掉，只留真上过账的两份
        if (firstRound && h.reads.length === 3) {
          firstRound = false;
          h.scanner.cancel();
        }
      },
    });
    const cancelled = await h.scanner.run();
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled).toMatchObject({ published: 2, covered: 2, remaining: 7, discarded: 1 });
    expect(h.scanner.coverage()).toMatchObject({ status: 'cancelled', covered: 2, remaining: 7, capped: false });
    const done = await h.scanner.run();
    expect(done).toMatchObject({ status: 'complete', scanned: 7, covered: 9, remaining: 0 });
    // 9 份各至少读一次；被丢掉的那一份读了两遍（迟到丢弃的代价），但一份都没被漏掉或重复记账
    expect(new Set(h.reads).size).toBe(9);
    expect(h.reads).toHaveLength(10);
    expect(new Set(h.published).size).toBe(9);
  });

  it('读数逐批都在说话：running 那几格里 covered 单调不减、remaining 单调不增', async () => {
    const h = harness(corpus(12, 'C:/game/ERB/001'), { maxFiles: 12 });
    await h.scanner.run();
    const marks = h.coverages.map((c) => [c.covered, c.remaining] as const);
    expect(marks.length).toBeGreaterThan(2);
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i]![0]! >= marks[i - 1]![0]!).toBe(true);
      expect(marks[i]![1]! <= marks[i - 1]![1]!).toBe(true);
    }
    expect(marks.at(-1)).toEqual([12, 0]);
  });
});

/* ----------------------------- 判据④：游标不留陈旧账 ----------------------------- */

describe('ERBDIAG-F ④ · 项目换掉 / 文件增删 / 索引重建 ⇒ 游标作废或重算', () => {
  it('装配世代变了（换项目 / 重开）⇒ 旧游标整份作废，新项目一份都不算"已查过"', async () => {
    const a = corpus(8, 'C:/game/A/ERB');
    const h = harness(a, { maxFiles: 8, epoch: () => 'A' });
    await h.scanner.run();
    expect(h.scanner.coverage()).toMatchObject({ covered: 8, remaining: 0 });
    // 换项目：清单换个名字，但装配世代也变了 ⇒ 必须从头再查，不许说"已扫描 8/8"就完事
    const b = corpus(8, 'C:/game/B/ERB');
    h.setFiles(b);
    h.setEpoch('B');
    const out = await h.scanner.run();
    expect(out).toMatchObject({ scanned: 8, total: 8, covered: 8, remaining: 0, capped: false });
    expect(new Set(h.reads.filter((p) => p.startsWith('C:/game/B/'))).size).toBe(8);
    // 反证：如果游标不作废（仍留着 A 那 8 条账），这一轮会一份都不读
    expect(h.reads.filter((p) => p.startsWith('C:/game/A/'))).toHaveLength(8);
  });

  it('同一份清单反复换写法（大小写 / 反斜杠）⇒ 归一键认人，不读第二遍也不冒充两份', async () => {
    const files = corpus(6, 'C:/game/ERB/001');
    const h = harness(files, { maxFiles: 6 });
    await h.scanner.run();
    const alt = files.map((p) => p.replace(/\//g, '\\').toUpperCase());
    h.setFiles(alt);
    const out = await h.scanner.run();
    expect(out).toMatchObject({ scanned: 0, covered: 6, remaining: 0 });
    expect(h.reads).toHaveLength(6);
  });

  it('清单里新增了文件 ⇒ 覆盖立刻回到"还差 1 个"，新文件进下一轮预算', async () => {
    const files = corpus(5, 'C:/game/ERB/001');
    const h = harness(files, { maxFiles: 5 });
    await h.scanner.run();
    expect(h.scanner.coverage()).toMatchObject({ remaining: 0, covered: 5 });
    const added = `${'C:/game/ERB/001'}/M_KOJO_NEW.ERB`;
    h.setFiles([...files, added]);
    const out = await h.scanner.run();
    expect(out).toMatchObject({ scanned: 1, total: 6, covered: 6, remaining: 0 });
    expect(h.reads.at(-1)).toBe(added);
  });

  it('文件从清单上消失 ⇒ 它的"已查过"账随之作废（remaining 只按还在的那些算）', async () => {
    const files = corpus(6, 'C:/game/ERB/001');
    const h = harness(files, { maxFiles: 3 });
    await h.scanner.run();
    expect(h.scanner.coverage()).toMatchObject({ covered: 3, remaining: 3 });
    h.setFiles(files.slice(3));
    const out = await h.scanner.run();
    expect(out).toMatchObject({ total: 3, covered: 3, remaining: 0, capped: false });
  });

  it('盘上内容变了（file.changed 那条腿）⇒ 点名销账，下一轮重新办那一份', async () => {
    const files = corpus(4, 'C:/game/ERB/001');
    const h = harness(files, { maxFiles: 4 });
    await h.scanner.run();
    expect(h.scanner.coverage()).toMatchObject({ remaining: 0 });
    h.scanner.invalidateCoverage(files[1]!.replace(/\//g, '\\').toUpperCase()); // 换写法也必须销到账
    const out = await h.scanner.run();
    expect(out).toMatchObject({ scanned: 1, covered: 4, remaining: 0 });
    expect(h.reads.at(-1)).toBe(files[1]);
  });
});

/* ------------------------------ 判据③：屏幕口径 ------------------------------ */

const coverageOf = (over: Partial<ProjectScanCoverage>): ProjectScanCoverage => ({
  ...IDLE_SCAN_COVERAGE,
  status: 'complete',
  roots: ['C:/game/eraTW/ERB'],
  total: CORPUS_TOTAL,
  covered: 0,
  remaining: CORPUS_TOTAL,
  ...over,
});

const SCAN_PROBLEM_PATH = 'C:/game/eraTW/ERB/001/B.ERB';
/** 扫描那一簇得先在账上，范围标签才会离开「已打开」那一路（store 的可见性判据，不是本批的口径） */
const showScan = (): void => setProjectScanProblems(SCAN_PROBLEM_PATH, [mk(SCAN_PROBLEM_PATH)]);

const mk = (path: string): EditorProblem => ({ path, line: 1, severity: 'error', message: '假问题' });

afterEach(() => {
  setProjectScanCoverage(IDLE_SCAN_COVERAGE);
  clearProjectScan();
  clearAllProblems();
});

describe('ERBDIAG-F ③ · 扫完之前"项目没有更多问题"那类口径一律不许成立', () => {
  it('覆盖了 1,200 / 4,258 ⇒ 标签只能说"部分扫描"，句子说得出还差多少', () => {
    setProjectScanProblems('C:/game/eraTW/ERB/001/A.ERB', [mk('C:/game/eraTW/ERB/001/A.ERB')]);
    setProjectScanCoverage(coverageOf({ scanned: 400, covered: 1_200, remaining: CORPUS_TOTAL - 1_200 }));
    expect(PROBLEM_SCOPE.label).toBe('部分扫描');
    expect(PROBLEM_SCOPE.title).toContain('累计已检查 1,200');
    expect(PROBLEM_SCOPE.title).toContain('还差 3,058 个文件没检查');
    // 去黑话：屏幕上那句不许出现实现词
    for (const jargon of ['capped', 'cursor', '游标', '批量上限']) {
      expect(PROBLEM_SCOPE.title).not.toContain(jargon);
    }
  });

  it('查完那一下才允许说"已扫描"，并且说得出"全部 4,258 份都查过了"', () => {
    showScan();
    setProjectScanCoverage(coverageOf({ scanned: 58, covered: CORPUS_TOTAL, remaining: 0 }));
    expect(PROBLEM_SCOPE.label).toBe('已扫描');
    expect(PROBLEM_SCOPE.title).toContain('累计已检查 4,258');
    expect(PROBLEM_SCOPE.title).not.toContain('还差');
  });

  it('remaining>0 时哪怕本轮没撞上限（刚被取消）也不许说"已扫描"', () => {
    showScan();
    setProjectScanCoverage(coverageOf({ status: 'complete', capped: false, scanned: 0, covered: 200, remaining: 4_058 }));
    expect(PROBLEM_SCOPE.label).toBe('部分扫描');
  });

  it('面板空态：没扫完 ⇒ 不许出现"未发现问题"那一句，改口说还差多少', () => {
    setProjectScanCoverage(coverageOf({ scanned: 400, covered: 400, remaining: CORPUS_TOTAL - 400 }));
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    expect(markup).not.toContain('未发现问题');
    expect(markup).toContain('还差 3,858 个文件没检查');
    setProjectScanCoverage(coverageOf({ scanned: CORPUS_TOTAL, covered: CORPUS_TOTAL, remaining: 0 }));
    expect(renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }))).toContain('未发现问题');
  });

  it('读数写回 store 后立刻读得到 covered/remaining（覆盖读数不另造第二份）', () => {
    showScan();
    setProjectScanCoverage(coverageOf({ scanned: 400, covered: 800, remaining: 3_458 }));
    expect(PROBLEM_SCOPE.title).toContain('累计已检查 800');
  });
});
