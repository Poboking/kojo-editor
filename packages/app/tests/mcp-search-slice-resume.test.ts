/**
 * B16 · 检索墙（5,000 条命中）的分片续取面 `resumeBySlice`
 *
 * 上游判性**不在这里**——这里只测实现。判性（分片拼接能否等价于一次全量扫）由 Rust 侧
 * 真引擎实测，用例见 `packages/app/src-tauri/src/search_tests.rs` 的 `wall_*` 九条 +
 * 一枚探针；本文件的假 `searchInFiles` 是把**实测到的引擎语义**逐条搬进 JS：
 * - `max_results` 夹在 5,000（`SEARCH_HARD_CAP`，闸一字未动）；
 * - 单文件命中上限 500（`SEARCH_PER_FILE_CAP`），超了 ⇒ `truncated:true` 并当场收口；
 * - 文件按路径升序输出（`out_files.sort_by(path)`），串行取窗 ⇒ 等价于实测的
 *   「单线程精确档」（八线程的过冲与不稳定由 Rust 用例承担，不在这儿复现）；
 * - 遍历跳过点开头的条目（`is_hidden_name`），但**文件根不经这一跳**（实测多出命中的来源）；
 * - 一次调用内重叠根按绝对路径小写键去重；**跨调用不去重**（⇒ 分片计划必须不相交）。
 *
 * 主判据：超过 5,000 条命中的项目**可以被完整枚举**，且拼接可自证无重无漏。
 * 全程假注入（fake kernel / walkDir / searchInFiles），不起 GUI、不起 Tauri、不起 HTTP。
 */
import { describe, expect, it } from 'vitest';
import { McpFailure, type McpSessionScope } from '@kojo/mcp-host';
import {
  createKernelIo,
  createRunSupplemental,
  toRelativePath,
  type McpIoDeps,
  type McpKernelLike,
  type McpSearchRequestLike,
  type McpSearchResultLike,
} from '../src/mcp/real-sources-io';
import {
  MCP_SEARCH_SLICE_CURSOR_STRIDE,
  MCP_SEARCH_SLICE_MAX_CHILD_ENTRIES,
  MCP_SEARCH_SLICE_MAX_GROUP_FILES,
  MCP_SEARCH_SLICE_MAX_SLICES,
  buildSlicePlan,
  dropNestedRoots,
  isHiddenEntryName,
  isWithinDir,
} from '../src/mcp/search-slice-leg';

/* ------------------------------- 虚拟树（确定性夹具） ------------------------------- */

const ROOT = 'D:\\proj';
/** 10 目录 × 8 文件 × 75 命中 = 6,000 条 > 引擎墙 5,000；单目录 600 条 < 单片窗。 */
const TREE = { dirs: 10, files: 8, hits: 75 };
const TOTAL_HITS = TREE.dirs * TREE.files * TREE.hits;

interface FakeTree {
  /** 目录绝对路径集合（含 ROOT） */
  readonly dirs: Set<string>;
  /** 文件绝对路径 → 命中行数 */
  readonly files: Map<string, number>;
}

function filePath(d: number, f: number): string {
  return `${ROOT}\\d${d}\\f${f}.erb`;
}

function makeTree(over: Partial<typeof TREE> = {}): FakeTree {
  const t = { ...TREE, ...over };
  const dirs = new Set<string>([ROOT]);
  const files = new Map<string, number>();
  for (let d = 0; d < t.dirs; d += 1) {
    dirs.add(`${ROOT}\\d${d}`);
    for (let f = 0; f < t.files; f += 1) files.set(`${ROOT}\\d${d}\\f${f}.erb`, t.hits);
  }
  return { dirs, files };
}

/**
 * 解析式真值：`path|line|preview`（与 `pageSearchHits` / 本腿 keyOf 同尺）。
 * - `path` 半边必须走**同一条投影腿** `toRelativePath`（旧面 `search.all` / `workspace.searchAll`
 *   的 hits.path 口径就是它，反斜杠在投影时归一为正斜杠；本腿 `projectHits` 逐字复用同一枚），
 *   否则这条判据比的是「夹具里的分隔符写法」而不是「命中集本身」——两边都会变成 6,000 但成员全错位；
 * - `preview` 半边是**引擎回的行内容**（夹具用绝对路径原样切的 rel），不参与投影，逐字保持反斜杠，
 *   与假引擎 `fakeSearch` 那一侧同尺。
 */
function expectedKeys(tree: FakeTree): Set<string> {
  const out = new Set<string>();
  for (const [path, hits] of tree.files) {
    if (isHiddenEntryName(path)) continue;
    const rel = path.slice(ROOT.length + 1);
    const projected = toRelativePath(path, ROOT);
    for (let k = 0; k < Math.min(hits, PER_FILE_CAP); k += 1) out.add(`${projected}|${k + 1}|hit ${rel}-l${k}`);
  }
  return out;
}

/** 与 Rust 同尺的两个闸（本批一个没放宽；测试把它当尺子钉住）。 */
const ENGINE_CAP = 5000;
const PER_FILE_CAP = 500;

interface Harness {
  readonly tree: FakeTree;
  readonly requests: { readonly roots: readonly string[]; readonly maxResults: number }[];
  readonly deps: McpIoDeps;
  readonly call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly callKernelIo: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function harness(
  tree: FakeTree,
  project: Record<string, unknown> = { rootDir: ROOT, adapterId: 'a', kojoPaths: [] },
): Harness {
  const requests: { roots: readonly string[]; maxResults: number }[] = [];

  /** roots → 候选文件（目录根递归且跳过隐藏；文件根逐条直收，与引擎同口径）。 */
  function expand(roots: readonly string[]): string[] {
    const out: string[] = [];
    const push = (p: string) => out.push(p);
    for (const root of roots) {
      const key = root.toLowerCase();
      if (tree.files.has(root) || [...tree.files.keys()].some((f) => f.toLowerCase() === key)) {
        push(root); // 文件根：不经 is_hidden_name（实测结论八）
        continue;
      }
      if (!tree.dirs.has(root) && ![...tree.dirs].some((d) => d.toLowerCase() === key)) continue;
      for (const f of tree.files.keys()) {
        if (isHiddenEntryName(f)) continue; // 遍历跳过隐藏条目（实测结论八的另一半）
        if (isWithinDir(f, root) || parentOf(f).toLowerCase() === key) push(f);
      }
    }
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const p of out) {
      const k = p.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(p);
    }
    return deduped.sort((a, b) => a.localeCompare(b));
  }

  const fakeSearch = async (req: McpSearchRequestLike): Promise<McpSearchResultLike> => {
    const maxResults = Math.min(ENGINE_CAP, Math.max(1, req.options.maxResults ?? 2000));
    requests.push({ roots: [...req.roots], maxResults });
    const candidates = expand(req.roots);
    const files: { path: string; matches: { line: number; preview: string }[] }[] = [];
    let got = 0;
    let truncated = false;
    let scanned = 0;
    for (const path of candidates) {
      if (got >= maxResults) {
        truncated = true; // 窗口用尽而还有文件没扫 ⇒ 引擎会置 overflow（remaining==0 分支）
        break;
      }
      scanned += 1;
      const hits = tree.files.get(path) ?? 0;
      const cap = Math.min(PER_FILE_CAP, maxResults - got);
      const taken = Math.min(hits, cap);
      const rel = path.slice(ROOT.length + 1);
      files.push({
        path,
        matches: Array.from({ length: taken }, (_, i) => ({ line: i + 1, preview: `hit ${rel}-l${i}` })),
      });
      got += taken;
      // Rust 的 clipped 判据是「这个文件想给的比 cap 多」⇒ 单文件上限 500 也会置 overflow，
      // 不是只有 max_results 才置。照抄，否则本文件会把 stalled 那一档测丢。
      if (taken < hits) {
        truncated = true;
        break;
      }
    }
    return {
      files,
      totalMatches: got,
      truncated,
      filesScanned: scanned,
      elapsedMs: 1,
      skipped: { binary: 0, tooLarge: 0, unreadable: 0, filtered: 0, excluded: 0 },
    };
  };

  /** 递归枚举（真桥的 walkDir 就是递归的；假件照做，并按 maxDepth 限深）。 */
  const walkDir = async (path: string, opts?: Record<string, unknown>): Promise<unknown[]> => {
    const maxDepth = typeof opts?.['maxDepth'] === 'number' ? (opts['maxDepth'] as number) : 16;
    const depthOf = (p: string): number =>
      p.slice(path.length).replace(/^[\\/]+/, '').split(/[\\/]+/).filter((s) => s !== '').length;
    const out: unknown[] = [];
    for (const d of tree.dirs) {
      if (d !== path && isWithinDir(d, path) && depthOf(d) <= maxDepth) {
        out.push({ name: leaf(d), path: d, isDirectory: true });
      }
    }
    for (const f of tree.files.keys()) {
      if (isWithinDir(f, path) && depthOf(f) <= maxDepth) {
        out.push({ name: leaf(f), path: f, isDirectory: false });
      }
    }
    return out;
  };

  const kernel = {
    project: { current: () => project },
    io: { walkDir: (p: string, o?: Record<string, unknown>) => walkDir(p, o) as Promise<unknown[]> },
    plugins: { list: () => [] },
    services: { tryGet: <T = unknown>(_k: string): T | undefined => undefined },
    bus: { on: (_n: string, _c: (p: unknown) => void) => () => {} },
    slots: { query: () => [] },
  } as unknown as McpKernelLike;

  const deps: McpIoDeps = {
    getKernel: () => kernel,
    getCommands: () => [],
    invoke: async () => null,
    searchInFiles: fakeSearch,
  };
  const scope: McpSessionScope = {
    sessionId: 'b16',
    clientId: 'c',
    tier: 'read',
    approvedRoots: [ROOT],
    approvedTools: [],
  };
  const run = createRunSupplemental(deps);
  const io = createKernelIo(deps);
  return {
    tree,
    requests,
    deps,
    call: (name, args) => run(name, args, scope) as Promise<Record<string, unknown>>,
    callKernelIo: (args) => io.searchAll(args, scope) as Promise<Record<string, unknown>>,
  };
}

function parentOf(abs: string): string {
  const i = Math.max(abs.lastIndexOf('\\'), abs.lastIndexOf('/'));
  return i <= 0 ? '' : abs.slice(0, i);
}
function leaf(abs: string): string {
  const i = Math.max(abs.lastIndexOf('\\'), abs.lastIndexOf('/'));
  return i < 0 ? abs : abs.slice(i + 1);
}

/* ------------------------------- 翻页器（把整趟走完） ------------------------------- */

interface WalkOutcome {
  readonly keys: string[];
  readonly pages: Record<string, unknown>[];
  readonly last: Record<string, unknown>;
}

async function walkAll(
  call: Harness['call'],
  maxPages = 400,
): Promise<WalkOutcome> {
  const keys: string[] = [];
  const pages: Record<string, unknown>[] = [];
  let args: Record<string, unknown> = { query: 'hit', resumeBySlice: true, limit: 200 };
  let last: Record<string, unknown> = {};
  for (let i = 0; i < maxPages; i += 1) {
    last = await call('workspace.searchAll', args);
    pages.push(last);
    for (const h of (last['hits'] as Record<string, unknown>[]) ?? []) {
      keys.push(`${String(h['path'])}|${String(h['line'])}|${String(h['preview'])}`);
    }
    if (last['hasMore'] !== true) break;
    args = { query: 'hit', resumeBySlice: true, limit: 200, cursor: String(last['nextCursor']) };
  }
  return { keys, pages, last };
}

/* ------------------------------- 主判据：可完整枚举 ------------------------------- */

describe('B16 判据 2 · 分片续取把 5,000 条以上的命中集完整枚举出来', () => {
  it('6,000 条命中的项目：逐页拼接无重无漏，等于解析式真值', async () => {
    const h = harness(makeTree());
    const { keys, last } = await walkAll(h.call);
    const truth = expectedKeys(h.tree);

    expect(TOTAL_HITS).toBeGreaterThan(ENGINE_CAP); // 夹具必须真的比墙大，否则这条判据是空的
    expect(new Set(keys).size).toBe(keys.length); // 无重
    expect(keys.length).toBe(truth.size); // 无漏（也不许多）
    expect(new Set(keys)).toEqual(truth);
    expect(last['walkComplete']).toBe(true);
    expect(last['engineWallReached']).toBeUndefined(); // 每片都没触墙 ⇒ 不许出现墙字段
    expect(last['note']).toContain('走完');
  });

  it('缺省（不给 resumeBySlice）旧面逐字不变：仍是触墙三件套，且没有分片账', async () => {
    const h = harness(makeTree());
    const one = await h.call('workspace.searchAll', { query: 'hit', limit: 200 });
    expect(one['planSlices']).toBeUndefined();
    expect(one['slicesRun']).toBeUndefined();
    expect(one['engineWallReached']).toBe(true); // 旧行为：5,000 条处见底
    expect(one['knownTotal']).toBe(false);
    expect((one['hits'] as unknown[]).length).toBe(200);
    // 旧面的 note 那三句话不能被本批悄悄改掉
    expect(String(one['note'])).toContain('5000');
    expect(String(one['note'])).toContain('fs.readFile');
  });

  it('闸一个没放宽：每次引擎调用的 maxResults 都 ≤ 5,000，roots 条数 ≤ 单片硬上限', async () => {
    const h = harness(makeTree());
    await walkAll(h.call);
    expect(h.requests.length).toBeGreaterThan(1); // 确实分了片（不是单次全量冒充）
    for (const r of h.requests) {
      expect(r.maxResults).toBeLessThanOrEqual(ENGINE_CAP);
      expect(r.roots.length).toBeLessThanOrEqual(MCP_SEARCH_SLICE_MAX_GROUP_FILES);
    }
  });

  it('游标仍是 B1 那一套格式；下标能拆成「片序号 × 进制 + 片内偏移」', async () => {
    const h = harness(makeTree());
    const first = await h.call('workspace.searchAll', { query: 'hit', resumeBySlice: true, limit: 200 });
    const cursor = String(first['nextCursor']);
    expect(cursor).toMatch(/^[0-9a-f]{8}:\d{1,10}$/);
    const index = Number(cursor.split(':')[1]);
    expect(Math.floor(index / MCP_SEARCH_SLICE_CURSOR_STRIDE)).toBe(first['sliceIndex']);
    expect(index % MCP_SEARCH_SLICE_CURSOR_STRIDE).toBe(first['sliceOffset']);
    expect(MCP_SEARCH_SLICE_CURSOR_STRIDE).toBeGreaterThan(ENGINE_CAP); // 进制必须大于单片上限，否则进位串片
  });

  it('账目字段逐页可见：slicesRun / perSliceTruncated / prefixReverified / knownTotal+理由', async () => {
    const h = harness(makeTree());
    const { pages, last } = await walkAll(h.call);
    for (const p of pages) {
      expect(typeof p['slicesRun']).toBe('number');
      expect(p['perSliceTruncated']).toBeInstanceOf(Array);
      expect(p['prefixReverified']).toBe('inventory+current-slice');
      expect(p['maxSlicesPerWalk']).toBe(MCP_SEARCH_SLICE_MAX_SLICES);
      expect(p['engineCapPerSlice']).toBe(ENGINE_CAP);
    }
    expect(last['knownTotal']).toBe(false); // 跨片总量本腿判不了 ⇒ 必须继续 false
    expect(String(last['knownTotalReason'])).toContain('累加器');
    // 但每片的总量必须逐页给出来（客户端相加即真总量）
    const sum = pages.reduce((acc, p) => acc + Number(p['sliceTotal']), 0);
    expect(sum).toBeGreaterThan(0);
  });

  it('knownTotal 只在**单片计划**转 true；多片走完仍 false + 理由点名累加器（别片 total 相加不是本腿能说的话）', async () => {
    // 单片：一个深度 1 目录、不触墙 ⇒ 全项目总量真的已知
    const one = harness(makeTree({ dirs: 1, files: 2, hits: 10 }));
    const first = await one.call('workspace.searchAll', { query: 'hit', resumeBySlice: true, limit: 200 });
    expect(first['planSlices']).toBe(1);
    expect(first['walkComplete']).toBe(true);
    expect(first['knownTotal']).toBe(true);
    expect(first['totalScope']).toBe('project');
    expect(first['knownTotalReason']).toBeUndefined();

    // 多片：同一个尺子换成 2 个目录 ⇒ 走完只交代「无重无漏」，不交代总量
    const h = harness(makeTree({ dirs: 2, files: 2, hits: 10 }));
    const { pages, last } = await walkAll(h.call);
    expect(last['planSlices']).toBe(2);
    expect(last['walkComplete']).toBe(true);
    expect(last['knownTotal']).toBe(false);
    expect(last['totalScope']).toBe('slice');
    expect(String(last['knownTotalReason'])).toContain('累加器');
    // 真总量交给客户端：逐页 sliceTotal 相加即真值（40＝2 目录 × 2 文件 × 10 条）
    const sum = pages.reduce((acc, p) => acc + Number(p['sliceTotal']), 0);
    expect(sum).toBe(40);
    expect(new Set(pages.map((p) => p['sliceIndex'])).size).toBe(2);
  });

  it('search.all（kernelIo 那枚具名工具）同样能分片续取', async () => {
    const h = harness(makeTree());
    let args: Record<string, unknown> = { query: 'hit', resumeBySlice: true, limit: 200 };
    const keys: string[] = [];
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 400; i += 1) {
      last = await h.callKernelIo(args);
      for (const hh of (last['hits'] as Record<string, unknown>[]) ?? []) {
        keys.push(`${String(hh['path'])}|${String(hh['line'])}|${String(hh['preview'])}`);
      }
      if (last['hasMore'] !== true) break;
      args = { query: 'hit', resumeBySlice: true, limit: 200, cursor: String(last['nextCursor']) };
    }
    expect(last['walkComplete']).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(TOTAL_HITS);
  });
});

/* ------------------------------- 判据 2：页间变化不许盲切 ------------------------------- */

describe('B16 判据 2 · 盘态变化 ⇒ 显式 changedDuringPaging 并从头部重来', () => {
  it('翻页途中新增文件 ⇒ 游标指纹失配：从第 0 片第 0 条重发，绝不与旧页拼接', async () => {
    const h = harness(makeTree());
    const a = await h.call('workspace.searchAll', { query: 'hit', resumeBySlice: true, limit: 200 });
    const b = await h.call('workspace.searchAll', {
      query: 'hit',
      resumeBySlice: true,
      limit: 200,
      cursor: String(a['nextCursor']),
    });
    expect(b['changedDuringPaging']).toBeUndefined(); // 同盘回传 ⇒ 干净续取

    // 在 d4 里加一个文件（清单变了 ⇒ 分片计划指纹必须抓到）
    h.tree.files.set(`${ROOT}\\d4\\f9.erb`, 20);
    const c = await h.call('workspace.searchAll', {
      query: 'hit',
      resumeBySlice: true,
      limit: 200,
      cursor: String(b['nextCursor']),
    });
    expect(c['changedDuringPaging']).toBe(true);
    expect(c['sliceIndex']).toBe(0);
    expect(c['offset']).toBe(200); // 从头重发：这一页是第 0 片的前 200 条
    expect(String(c['note'])).toContain('不可与旧页拼接');
    expect(c['nextCursor']).not.toBe(b['nextCursor']);
  });

  it('翻页途中改正文（不改清单）⇒ 本片前缀抓得到，别片前缀如实标注重扫范围', async () => {
    const h = harness(makeTree());
    const p0 = await h.call('workspace.searchAll', { query: 'hit', resumeBySlice: true, limit: 200 });
    // 改的是**后面那片**的一个文件正文里的条数（把 d6 清空）⇒ 清单没变、计划 key 没变
    h.tree.files.set(`${ROOT}\\d6\\f0.erb`, 0);
    const p1 = await h.call('workspace.searchAll', {
      query: 'hit',
      resumeBySlice: true,
      limit: 200,
      cursor: String(p0['nextCursor']),
    });
    // 第 1 页还在 d0，后面的片变了本腿不重扫 ⇒ 不许假装抓到，也不许报错：如实标注重扫口径
    expect(p1['changedDuringPaging']).toBeUndefined();
    expect(p1['prefixReverified']).toBe('inventory+current-slice');
    // 但整趟走完时那条片就是少了 75 条 —— 拼接结果必须如实（不静默补回来）
    const truth = expectedKeys(h.tree);
    expect(truth.size).toBe(TOTAL_HITS - 75);
  });
});

/* ------------------------------- 判据 4：判不了 / 超上限都出声 ------------------------------- */

describe('B16 判据 3-4 · 切不动的那堵墙与超限：显式错误码，绝不静默', () => {
  it('单片超墙（一个目录 60 文件 × 200 条）⇒ engineWallReached + blockedSlice + hasMore:false', async () => {
    const h = harness(makeTree({ dirs: 1, files: 60, hits: 200 }));
    const { last } = await walkAll(h.call);
    expect(last['engineWallReached']).toBe(true);
    expect(last['hasMore']).toBe(false);
    expect(last['nextCursor']).toBeNull();
    expect(last['walkComplete']).toBe(false);
    const blocked = last['blockedSlice'] as Record<string, unknown>;
    expect(blocked['reason']).toBe('slice-over-engine-cap');
    expect(String(last['note'])).toContain('fs.readFile');
    // 触墙那页仍必须交数据（不是把整趟作废）
    expect(((last['hits'] as unknown[]) ?? []).length).toBeGreaterThan(0);
  });

  it('单文件上限先生效的稠密片（12 文件 × 600 条）⇒ 走 stalled 那档，绝不空页续翻', async () => {
    const h = harness(makeTree({ dirs: 2, files: 12, hits: 600 }));
    const { pages, last } = await walkAll(h.call);
    expect(last['engineWallReached']).toBe(true);
    expect(last['hasMore']).toBe(false);
    const blocked = last['blockedSlice'] as Record<string, unknown>;
    expect(blocked['reason']).toBe('no-forward-progress');
    expect(String(last['note'])).toContain('一条新命中也拿不出来');
    expect(pages.some((p) => ((p['hits'] as unknown[]) ?? []).length === 0 && p['hasMore'] === true)).toBe(false);
  });

  it('一片只剩一个文件根仍触墙 ⇒ 话术点名 SEARCH_PER_FILE_CAP（不可再分）', async () => {
    const tree = makeTree({ dirs: 0, files: 0, hits: 0 });
    tree.files.set(`${ROOT}\\huge.erb`, 1200); // 根上散文件 ⇒ 一条文件根片，roots.length===1
    const h = harness(tree);
    const { last } = await walkAll(h.call);
    expect(last['engineWallReached']).toBe(true);
    expect((last['sliceRoots'] as string[]).length).toBe(1);
    expect(String(last['note'])).toContain('SEARCH_PER_FILE_CAP');
    expect(String(last['note'])).toContain('huge.erb');
  });

  it('分片数超硬上限（65 个顶层目录）⇒ INVALID_ARGS + 分批指引，绝不静默少一片', async () => {
    const tree = makeTree({ dirs: MCP_SEARCH_SLICE_MAX_SLICES + 1, files: 1, hits: 1 });
    const h = harness(tree);
    await expect(h.call('workspace.searchAll', { query: 'hit', resumeBySlice: true })).rejects.toMatchObject({
      code: 'INVALID_ARGS',
    });
    let msg = '';
    try {
      await h.call('workspace.searchAll', { query: 'hit', resumeBySlice: true });
    } catch (e) {
      msg = (e as McpFailure).message;
    }
    expect(msg).toContain(String(MCP_SEARCH_SLICE_MAX_SLICES));
    expect(msg).toContain('分批');
    expect(msg).toContain('绝不静默少扫');
  });

  it('一层子项超 5,000（枚举面硬上限）⇒ RESOURCE_UNAVAILABLE，与 fs.tree 同尺不放宽', async () => {
    const tree = makeTree({ dirs: 0, files: 0, hits: 0 });
    for (let i = 0; i < MCP_SEARCH_SLICE_MAX_CHILD_ENTRIES + 1; i += 1) {
      tree.files.set(`${ROOT}\\x${i}.erb`, 1);
    }
    const h = harness(tree);
    await expect(h.call('workspace.searchAll', { query: 'hit', resumeBySlice: true })).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
    });
  });

  it('根集合为空（sourcesOnly 但 kojoPaths 不合法）⇒ 分片面显式拒绝；一次性旧面照发（零回退）', async () => {
    const h = harness(makeTree(), {
      rootDir: ROOT,
      adapterId: 'a',
      kojoPaths: [123, '', null] as unknown as string[],
    });
    await expect(
      h.call('workspace.searchAll', { query: 'hit', resumeBySlice: true, scope: 'sources' }),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    // 同一入参不给 resumeBySlice ⇒ 旧面必须照常返回（既有语义「可能空根也照发」不动）
    const old = await h.call('workspace.searchAll', { query: 'hit', scope: 'sources' });
    expect(Array.isArray(old['hits'])).toBe(true);
  });

  it('超过单片窗也绝不出现「空页 + hasMore:true」（任何空页必须当场按墙出声）', async () => {
    for (const shape of [
      { dirs: 2, files: 12, hits: 600 },
      { dirs: 1, files: 60, hits: 200 },
      { dirs: 3, files: 4, hits: 1300 },
    ]) {
      const h = harness(makeTree(shape));
      const { pages } = await walkAll(h.call, 600);
      for (const p of pages) {
        if (((p['hits'] as unknown[]) ?? []).length === 0) {
          expect(p['hasMore']).toBe(false);
          expect(p['engineWallReached']).toBe(true);
        }
      }
    }
  });
});

/* ------------------------------- 建划单元（实测结论落成的约束） ------------------------------- */

describe('B16 建划 · 无重无漏的四条实测约束', () => {
  it('隐藏条目不进计划（实测：文件根不经 is_hidden_name，点名的话会多出命中）', () => {
    expect(isHiddenEntryName(`${ROOT}\\.gitignore`)).toBe(true);
    expect(isHiddenEntryName(`${ROOT}\\a.erb`)).toBe(false);
    const tree = makeTree({ dirs: 1, files: 1, hits: 1 });
    tree.files.set(`${ROOT}\\.gitignore`, 3);
    tree.files.set(`${ROOT}\\.hidden.erb`, 3);
    const kernel = harness(tree).deps.getKernel() as McpKernelLike;
    return buildSlicePlan(kernel, [ROOT]).then(({ slices }) => {
      const all = slices.flatMap((s) => s.roots);
      expect(all.some((p) => isHiddenEntryName(p))).toBe(false);
      expect(slices.some((s) => s.label.includes('.git'))).toBe(false);
    });
  });

  it('嵌套根逐条排除（跨调用无去重 ⇒ 相交就是重复）', () => {
    const r = dropNestedRoots([`${ROOT}\\d0`, ROOT, `${ROOT}\\d1`]);
    expect(r.kept).toEqual([ROOT]);
    expect(r.dropped).toEqual([`${ROOT}\\d0`, `${ROOT}\\d1`]);
    expect(isWithinDir(`${ROOT}\\d0\\f.erb`, ROOT)).toBe(true);
    expect(isWithinDir(ROOT, ROOT)).toBe(false);
  });

  it('计划两两不相交且按 label 自定序（walkDir 返回序不保证）', async () => {
    const tree = makeTree({ dirs: 3, files: 2, hits: 5 });
    tree.files.set(`${ROOT}\\loose.erb`, 5);
    const kernel = harness(tree).deps.getKernel() as McpKernelLike;
    const { slices } = await buildSlicePlan(kernel, [ROOT]);
    const flat = slices.flatMap((s) => s.roots);
    expect(new Set(flat.map((p) => p.toLowerCase())).size).toBe(flat.length); // 无交集
    const labels = slices.map((s) => s.label.toLowerCase());
    expect(labels).toEqual([...labels].sort());
    expect(slices.length).toBe(4); // 3 个子目录片 + 1 条散文件片
  });

  it('散文件多于单片上限 ⇒ 按硬上限切成多条文件根片（不静默并片）', async () => {
    const tree = makeTree({ dirs: 0, files: 0, hits: 0 });
    for (let i = 0; i < MCP_SEARCH_SLICE_MAX_GROUP_FILES + 5; i += 1) tree.files.set(`${ROOT}\\g${i}.erb`, 1);
    const kernel = harness(tree).deps.getKernel() as McpKernelLike;
    const { slices } = await buildSlicePlan(kernel, [ROOT]);
    expect(slices.length).toBe(2);
    expect((slices[0] as { roots: readonly string[] }).roots.length).toBe(MCP_SEARCH_SLICE_MAX_GROUP_FILES);
    expect((slices[1] as { roots: readonly string[] }).roots.length).toBe(5);
  });

  it('深树的分组键是**深度 1 目录本身**（不是文件自己）⇒ 分片数＝顶层子目录数，绝不暴涨', async () => {
    // 3 个深度 1 目录 × 各自一层子目录 × 4 文件 + 根上 1 枚散文件：
    // 分组键若错成文件自己 ⇒ 12 条单文件片 + 1 散文件片（本批第一轮就是挂在这儿的形状）。
    const tree = makeTree({ dirs: 0, files: 0, hits: 0 });
    for (let d = 0; d < 3; d += 1) {
      tree.dirs.add(`${ROOT}\\d${d}`);
      tree.dirs.add(`${ROOT}\\d${d}\\sub`);
      for (let f = 0; f < 4; f += 1) tree.files.set(`${ROOT}\\d${d}\\sub\\f${f}.erb`, 1);
    }
    tree.files.set(`${ROOT}\\loose.erb`, 1);
    const kernel = harness(tree).deps.getKernel() as McpKernelLike;
    const { slices, inventory } = await buildSlicePlan(kernel, [ROOT]);
    expect(inventory.length).toBe(13);
    expect(slices.length).toBe(4); // 3 条深度 1 目录片 + 1 条散文件片
    const dirRoots = slices.filter((s) => s.kind === 'dir').map((s) => s.roots[0]);
    expect([...dirRoots].sort()).toEqual([`${ROOT}\\d0`, `${ROOT}\\d1`, `${ROOT}\\d2`]);
    // 每个可见文件恰好落在一条片里（分片覆盖 = 清单，不重不漏）
    const covered = (p: string): number =>
      slices.reduce(
        (acc, s) => acc + (s.kind === 'files' ? (s.roots.includes(p) ? 1 : 0) : isWithinDir(p, s.roots[0] as string) ? 1 : 0),
        0,
      );
    for (const f of inventory) expect(covered(f)).toBe(1);
    // 深树端到端同样拼得完整（13 条命中：目录片是递归扫的）
    const h = harness(tree);
    const { keys, last } = await walkAll(h.call);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(13);
    expect(last['walkComplete']).toBe(true);
  });

  it('建划走的是整棵树一趟枚举（清单进游标指纹）⇒ 硬上限常量本批一个没动（当尺子钉住）', () => {
    expect(MCP_SEARCH_SLICE_MAX_CHILD_ENTRIES).toBe(5000); // 与 fs.tree / io.listDir 单页同尺
    expect(MCP_SEARCH_SLICE_MAX_SLICES).toBe(64); // 与 fs.readMany 单次 64 条同尺
    expect(MCP_SEARCH_SLICE_MAX_GROUP_FILES).toBe(64);
    expect(MCP_SEARCH_SLICE_CURSOR_STRIDE).toBe(8192);
  });
});
