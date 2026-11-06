/**
 * MCP-PERF-S7 · 整项目扫描的诊断增量缓存（判据文件）。
 *
 * 真源落点（recon 结论，见 diag-cache.ts 头注）：MCP `semantic.diagnostics` /
 * `problems.diagnostics` 是 Monaco marker 的只读投影（零重算）；「每改一行跑全项目」的
 * 重算点在整项目扫描链 `project-scan-schedule` → `createProjectScanner` → `decorateScanFile`
 * ——每轮把计划内全部文件**重新读盘 + 重新问全部装饰贡献**（R4a 批量诊断 400 文件那条）。
 * 本批给它加 (mtime,size) 输入指纹缓存 + 脏集增量：未变文件回缓存条目、变过的文件重跑。
 *
 * 判据分两层：
 * ① 缓存本体（createDiagScanCache）：指纹命中 / 脏即重算 / 无 stamp 保守不缓存 /
 *    有界 2,000 最旧先出 / 换代即整体失效（声明面变了 / 贡献方名单变了）/ 计数可见；
 * ② 扫描器收口（createProjectScanner × diagCache）：首轮全重算、二轮同 stamp 全命中且
 *    **不再读盘**、单文件保存后恰该文件重算、回执账 cached/recomputed 可见、
 *    缺件（无 stamp / 无 gen）整轮保守回退逐字旧行为。
 */

import { describe, expect, it } from 'vitest';
import {
  createDiagScanCache,
  declarationSurfaceFingerprint,
  DIAG_CACHE_MAX_ENTRIES,
  type DiagCacheEntry,
  type DiagGen,
  type DiagStamp,
} from '../src/ui/diag-cache';
import { createProjectScanner, type ProjectScannerDeps } from '../src/ui/project-diagnostics';
import type { EditorProblem } from '../src/ui/problem-store';

const ROOT = 'D:/proj/game';
const A = `${ROOT}/erb/A.ERB`;
const B = `${ROOT}/erb/B.ERB`;
const C = `${ROOT}/erb/C.ERB`;
const K = `${ROOT}/erb/K.kojo2`;

const stamp = (mtimeMs: number, size: number): DiagStamp => ({ mtimeMs, size });

const prob = (line: number, code: string): EditorProblem => ({
  path: 'X',
  line,
  severity: 'error',
  message: `m${line}`,
  code,
});

const entry = (lines: number[], failed: string[] = []): DiagCacheEntry => ({
  problems: lines.map((l) => prob(l, 't.1')),
  failedContributors: failed,
});

/* ========================= ① 缓存本体 ========================= */

describe('createDiagScanCache · 指纹命中与保守回退', () => {
  it('未变 (mtime,size) 命中：回缓存条目，含完整诊断与完整性标记（failedContributors）', () => {
    const c = createDiagScanCache();
    c.beginRound({ indexVersion: 1, declSurface: 'S1' });
    c.put(A, stamp(100, 10), entry([1, 5], ['boom']));
    const hit = c.get(A, stamp(100, 10));
    expect(hit).not.toBeNull();
    expect(hit!.problems.map((p) => p.line)).toEqual([1, 5]);
    expect(hit!.failedContributors).toEqual(['boom']);
    const s = c.stats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(0);
  });

  it('stamp 变了（保存过的文件）⇒ 永远不命中：脏文件重算', () => {
    const c = createDiagScanCache();
    c.beginRound({ indexVersion: 1, declSurface: 'S1' });
    c.put(A, stamp(100, 10), entry([1]));
    expect(c.get(A, stamp(101, 10))).toBeNull(); // mtime 变
    expect(c.get(A, stamp(100, 11))).toBeNull(); // 只有 size 变（保时间戳的改写）也躲不过
    expect(c.stats().misses).toBe(2);
  });

  it('stamp 取不到 ⇒ 不命中且不入缓存（保守：缓存只对盘上事实成立）', () => {
    const c = createDiagScanCache();
    c.beginRound({ indexVersion: 1, declSurface: 'S1' });
    expect(c.get(A, null)).toBeNull();
    expect(c.get(A, undefined)).toBeNull();
    c.put(A, null, entry([1]));
    c.put(A, undefined, entry([2]));
    expect(c.stats().size).toBe(0); // 一条都没进
  });

  it(`有界 ${DIAG_CACHE_MAX_ENTRIES} 条：溢出按最旧先出（FIFO）`, () => {
    const c = createDiagScanCache();
    c.beginRound({ indexVersion: 1, declSurface: 'S1' });
    for (let i = 0; i < DIAG_CACHE_MAX_ENTRIES + 1; i++) {
      c.put(`P${i}`, stamp(i, i), entry([i]));
    }
    expect(c.stats().size).toBe(DIAG_CACHE_MAX_ENTRIES);
    expect(c.get('P0', stamp(0, 0))).toBeNull(); // 最旧的被逐出
    expect(c.get(`P${DIAG_CACHE_MAX_ENTRIES}`, stamp(DIAG_CACHE_MAX_ENTRIES, DIAG_CACHE_MAX_ENTRIES))).not.toBeNull();
  });

  it('换代即失效：声明面变了 ⇒ 整份清空', () => {
    const c = createDiagScanCache();
    c.beginRound({ indexVersion: 1, declSurface: 'S1' });
    c.put(A, stamp(1, 1), entry([1]));
    c.beginRound({ indexVersion: 2, declSurface: 'S2' }); // 新文件带来新函数名 ⇒ 声明面变
    expect(c.get(A, stamp(1, 1))).toBeNull();
    expect(c.stats().flushedGenerations).toBe(1);
  });

  it('索引换代但声明面未变（纯函数体编辑的增量轮）⇒ 条目存活', () => {
    const c = createDiagScanCache();
    c.beginRound({ indexVersion: 1, declSurface: 'S1' });
    c.put(A, stamp(1, 1), entry([1]));
    c.put(B, stamp(2, 2), entry([2]));
    c.beginRound({ indexVersion: 2, declSurface: 'S1' }); // 保存触发增量重索引，声明没动
    expect(c.get(A, stamp(1, 1))).not.toBeNull();
    expect(c.get(B, stamp(2, 2))).not.toBeNull();
    expect(c.stats().flushedGenerations).toBe(0);
  });

  it('换代事实取不到（declSurface 掉成 null）⇒ 保守全清', () => {
    const c = createDiagScanCache();
    c.beginRound({ indexVersion: 1, declSurface: 'S1' });
    c.put(A, stamp(1, 1), entry([1]));
    c.beginRound({ indexVersion: 2, declSurface: null });
    expect(c.get(A, stamp(1, 1))).toBeNull();
  });

  it('贡献方名单变了（适配器 / 插件换装）⇒ 整份清空', () => {
    const c = createDiagScanCache();
    c.beginRound({ indexVersion: 1, declSurface: 'S1', contributorIds: ['a', 'b'] });
    c.put(A, stamp(1, 1), entry([1]));
    c.beginRound({ indexVersion: 1, declSurface: 'S1', contributorIds: ['a', 'b', 'c'] });
    expect(c.get(A, stamp(1, 1))).toBeNull();
    // 同一名单重复宣告不失效
    c.put(A, stamp(1, 1), entry([1]));
    c.beginRound({ indexVersion: 1, declSurface: 'S1', contributorIds: ['a', 'b', 'c'] });
    expect(c.get(A, stamp(1, 1))).not.toBeNull();
  });

  it('换代事实缺席（beginRound(null)）⇒ 该轮 get/put 全部 no-op（不缓存、不命中）', () => {
    const c = createDiagScanCache();
    c.beginRound({ indexVersion: 1, declSurface: 'S1' });
    c.put(A, stamp(1, 1), entry([1]));
    c.beginRound(null); // 索引未就绪的一轮
    expect(c.get(A, stamp(1, 1))).toBeNull();
    c.put(B, stamp(2, 2), entry([2]));
    expect(c.stats().size).toBe(1); // B 没进来
    // 恢复正常换代后旧条目还在（null 轮只是跳过，不是清空）
    c.beginRound({ indexVersion: 1, declSurface: 'S1' });
    expect(c.get(A, stamp(1, 1))).not.toBeNull();
  });
});

describe('declarationSurfaceFingerprint · 跨文件声明面指纹', () => {
  const idxOf = (defs: ReadonlyArray<readonly [string, string, number]>): unknown => {
    const files = new Map<string, { functions: { normalizedName: string; params: unknown[] }[] }>();
    for (const [path, name, arity] of defs) {
      files.set(path, { functions: [{ normalizedName: name, params: new Array(arity).fill(0) }] });
    }
    return files;
  };

  it('同一声明布局 ⇒ 同一指纹；空 / 非 Map ⇒ null（取不到 = 保守失效）', () => {
    const a = idxOf([
      [A, 'FOO', 2],
      [B, 'BAR', 0],
    ]);
    const b = idxOf([
      [B, 'BAR', 0],
      [A, 'FOO', 2], // 列举顺序不同也同面
    ]);
    expect(declarationSurfaceFingerprint(a)).toBe(declarationSurfaceFingerprint(b));
    expect(declarationSurfaceFingerprint(new Map())).toBeNull();
    expect(declarationSurfaceFingerprint(null)).toBeNull();
    expect(declarationSurfaceFingerprint(undefined)).toBeNull();
    expect(declarationSurfaceFingerprint({} as unknown)).toBeNull();
  });

  it('函数增删 / 挪文件 / 改参数个数 ⇒ 指纹变（跨文件诊断的事实面）', () => {
    const base = idxOf([
      [A, 'FOO', 2],
      [B, 'BAR', 0],
    ]);
    const added = idxOf([
      [A, 'FOO', 2],
      [B, 'BAR', 0],
      [C, 'BAZ', 1], // 新声明
    ]);
    const moved = idxOf([
      [C, 'FOO', 2], // 同名同参换文件（重复对子的配对信息会变）
      [B, 'BAR', 0],
    ]);
    const reArity = idxOf([
      [A, 'FOO', 3], // 实参个数诊断的事实
      [B, 'BAR', 0],
    ]);
    const fp = declarationSurfaceFingerprint(base);
    expect(fp).not.toBeNull();
    expect(declarationSurfaceFingerprint(added)).not.toBe(fp);
    expect(declarationSurfaceFingerprint(moved)).not.toBe(fp);
    expect(declarationSurfaceFingerprint(reArity)).not.toBe(fp);
  });
});

/* ========================= ② 扫描器收口 ========================= */

/** 扫描器夹具：内存文件 + 可变 stamp 表 + 可变换代事实 + 一路确定性装饰贡献 */
function harness(opts: {
  files: Record<string, string>;
  stamps?: Map<string, DiagStamp | null>;
  gen?: DiagGen | null;
  failStamps?: boolean;
}) {
  const published = new Map<string, EditorProblem[]>();
  const reads: string[] = [];
  const decorateCalls: string[] = [];
  const stamps = opts.stamps ?? new Map<string, DiagStamp | null>();
  const cache = createDiagScanCache();
  const deps: ProjectScannerDeps = {
    listFiles: () => Object.keys(opts.files),
    roots: () => [ROOT],
    project: () => null,
    contributors: () => [
      {
        id: 't1',
        decorate: (file) => {
          decorateCalls.push(file.path);
          return file.text === 'bad' ? [{ line: 1, severity: 'error' as const, message: 'bad!' }] : [];
        },
      },
    ],
    readFile: async (p) => {
      reads.push(p);
      if (!(p in opts.files)) throw new Error(`no file: ${p}`);
      return opts.files[p]!;
    },
    publish: (path, problems) => {
      published.set(path, [...problems]);
    },
    diagCache: () => cache,
    diagGen: () => opts.gen ?? null,
    readStamps: opts.failStamps
      ? async (): Promise<ReadonlyMap<string, DiagStamp | null>> => {
          throw new Error('stat 桥炸了');
        }
      : async (paths) => {
          const out = new Map<string, DiagStamp | null>();
          for (const p of paths) out.set(p, stamps.get(p) ?? null);
          return out;
        },
    perBatch: 8,
    maxFiles: 0,
  };
  return { scanner: createProjectScanner(deps), published, reads, decorateCalls, stamps, cache };
}

describe('createProjectScanner × diagCache · 脏集增量', () => {
  it('首轮全重算（cached 0 / recomputed N）；二轮同 stamp 全命中且零读盘、判据面逐条相同', async () => {
    const files = { [A]: 'bad', [B]: 'clean', [C]: 'bad' };
    const stamps = new Map<string, DiagStamp | null>([
      [A, stamp(1, 3)],
      [B, stamp(2, 5)],
      [C, stamp(3, 3)],
    ]);
    const h = harness({ files, stamps, gen: { indexVersion: 1, declSurface: 'S1' } });

    const r1 = await h.scanner.run();
    expect(r1.status).toBe('complete');
    expect(r1.cached).toBe(0);
    expect(r1.recomputed).toBe(3);
    expect(h.reads).toEqual([A, B, C]);
    const firstA = h.published.get(A)!.map((p) => `${p.line}/${p.severity}`);

    h.reads.length = 0;
    h.decorateCalls.length = 0;
    const r2 = await h.scanner.run();
    expect(r2.status).toBe('complete');
    expect(r2.cached).toBe(3);
    expect(r2.recomputed).toBe(0);
    expect(h.reads).toEqual([]); // 未变文件不再读盘 ——「每改一行跑全项目」的浪费就此断根
    expect(h.decorateCalls).toEqual([]); // 也不重算
    expect(h.published.get(A)!.map((p) => `${p.line}/${p.severity}`)).toEqual(firstA); // 判据面逐条相同
  });

  it('单文件保存（stamp 变 + 内容变）⇒ 恰该文件重算、新账上屏，其余文件命中', async () => {
    const files: Record<string, string> = { [A]: 'bad', [B]: 'clean', [C]: 'bad' };
    const stamps = new Map<string, DiagStamp | null>([
      [A, stamp(1, 3)],
      [B, stamp(2, 5)],
      [C, stamp(3, 3)],
    ]);
    const h = harness({ files, stamps, gen: { indexVersion: 1, declSurface: 'S1' } });
    await h.scanner.run();

    files[A] = 'worse';
    stamps.set(A, stamp(9, 6));
    h.reads.length = 0;
    h.decorateCalls.length = 0;
    const r2 = await h.scanner.run();
    expect(r2.cached).toBe(2);
    expect(r2.recomputed).toBe(1);
    expect(h.reads).toEqual([A]);
    expect(h.decorateCalls).toEqual([A]);
    expect(h.published.get(A)!.map((p) => p.line)).toEqual([1]); // 重算的新账
    expect(h.published.get(B)).toEqual([]); // 未变文件账不变
  });

  it('.kojo2 文件永不走缓存（项目级分析要收本轮全部原文）', async () => {
    const files: Record<string, string> = { [A]: 'clean', [K]: 'export @foo' };
    const stamps = new Map<string, DiagStamp | null>([
      [A, stamp(1, 5)],
      [K, stamp(2, 11)],
    ]);
    const h = harness({ files, stamps, gen: { indexVersion: 1, declSurface: 'S1' } });
    await h.scanner.run();
    h.reads.length = 0;
    const r2 = await h.scanner.run();
    expect(r2.cached).toBe(1); // 只有 ERB 命中
    expect(r2.recomputed).toBe(1); // .kojo2 每轮照读照算
    expect(h.reads).toEqual([K]);
  });

  it('stamp 桥炸了 ⇒ 整轮保守重算（读数诚实，不静默假装命中）', async () => {
    const files = { [A]: 'bad', [B]: 'bad' };
    const h = harness({ files, gen: { indexVersion: 1, declSurface: 'S1' }, failStamps: true });
    const r1 = await h.scanner.run();
    expect(r1.status).toBe('complete');
    expect(r1.cached).toBe(0);
    expect(r1.recomputed).toBe(2);
    expect(h.published.get(A)!.map((p) => p.line)).toEqual([1]);
  });

  it('换代事实缺席（索引未就绪）⇒ 整轮不缓存，行为与不接缓存逐字同', async () => {
    const files = { [A]: 'bad' };
    const h = harness({ files, gen: null });
    const r1 = await h.scanner.run();
    expect(r1.recomputed).toBe(1);
    expect(r1.cached).toBe(0);
    // 二轮依旧全算（没有换代事实就没有缓存资格）
    h.reads.length = 0;
    const r2 = await h.scanner.run();
    expect(r2.recomputed).toBe(1);
    expect(r2.cached).toBe(0);
    expect(h.reads).toEqual([A]);
  });

  it('声明面变了（新函数上项目）⇒ 整份清空重算，即便 stamp 全未变', async () => {
    const files = { [A]: 'bad', [B]: 'bad' };
    const stamps = new Map<string, DiagStamp | null>([
      [A, stamp(1, 3)],
      [B, stamp(2, 3)],
    ]);
    const gen: DiagGen = { indexVersion: 1, declSurface: 'S1' };
    const h = harness({ files, stamps, gen });
    await h.scanner.run();
    gen.declSurface = 'S2'; // 索引换代且声明面变了（新文件/新函数）
    gen.indexVersion = 2;
    h.reads.length = 0;
    const r2 = await h.scanner.run();
    expect(r2.cached).toBe(0);
    expect(r2.recomputed).toBe(2);
    expect(h.reads).toEqual([A, B]);
  });

  it('复核轮（rescanOnly）同样吃缓存', async () => {
    const files = { [A]: 'bad', [B]: 'bad' };
    const stamps = new Map<string, DiagStamp | null>([
      [A, stamp(1, 3)],
      [B, stamp(2, 3)],
    ]);
    let extra: string[] = [];
    const cache = createDiagScanCache();
    const published = new Map<string, EditorProblem[]>();
    const reads: string[] = [];
    const deps: ProjectScannerDeps = {
      listFiles: () => Object.keys(files),
      roots: () => [ROOT],
      project: () => null,
      contributors: () => [
        {
          id: 't1',
          decorate: (file) => (file.text === 'bad' ? [{ line: 1, severity: 'error' as const, message: 'x' }] : []),
        },
      ],
      readFile: async (p) => {
        reads.push(p);
        return files[p]!;
      },
      publish: (path, problems) => published.set(path, [...problems]),
      extraPaths: () => extra,
      diagCache: () => cache,
      diagGen: () => ({ indexVersion: 1, declSurface: 'S1' }),
      readStamps: async (paths) => {
        const out = new Map<string, DiagStamp | null>();
        for (const p of paths) out.set(p, stamps.get(p) ?? null);
        return out;
      },
      perBatch: 8,
      maxFiles: 0,
    };
    const scanner = createProjectScanner(deps);
    await scanner.run(); // 首轮建账
    reads.length = 0;
    extra = [A];
    const r = await scanner.run({ rescanOnly: true });
    expect(r.scanned).toBe(1);
    expect(r.cached).toBe(1);
    expect(r.recomputed).toBe(0);
    expect(reads).toEqual([]); // 盘上没变，复核也不必重读
  });
});
