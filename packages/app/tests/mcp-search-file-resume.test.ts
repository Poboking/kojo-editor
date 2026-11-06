/**
 * B18 · 单文件上限（`SEARCH_PER_FILE_CAP` = 500）的**逐段续取**面
 *
 * B16 把「一次检索 5,000 条」那堵墙用互不相交的分片翻过去了，但明确留下一堵它自己修不掉的墙：
 * **一片只剩一个文件、而该文件命中 > 500 条**（Rust 侧 `wall_per_file_cap_is_not_fixable_by_slicing`）。
 * 本批给检索原语加了续取凭据（`search_text.options.resumeAfterMatches` + 返回侧回显
 * `resumeAppliedMatches`，判性用例在 `packages/app/src-tauri/src/search_tests.rs` 的 `resume_*` 七条），
 * 本文件测**腿**怎么用这一位：游标仍是 B1 那一套（片序号 × 进制 + 片内偏移，**一格没加**），
 * 片内偏移追过 500 时改用「按段续取」，直到该文件穷尽。
 *
 * 假引擎是把 Rust 实测到的语义搬进 JS（含续取凭据与回显）：
 * - `max_results` 夹 5,000、每文件**返回**上限 500（两把闸一个没放宽）；
 * - `resumeAfterMatches` = 每个文件先丢 N 条再按原闸收口；回显 = 实际丢弃条数之和；
 * - `supportsResume:false` 那台假引擎 = **旧宿主**：认不出这个键，也不回显 ⇒
 *   腿必须当场判出「没续上」并退回 B16 那堵墙的原话术，绝不把同一批前 500 条反复端上桌。
 * 全程假注入，不起 GUI / Tauri / HTTP。
 */
import { describe, expect, it } from 'vitest';
import type { McpSessionScope } from '@kojo/mcp-host';
import {
  createKernelIo,
  createRunSupplemental,
  toRelativePath,
  type McpIoDeps,
  type McpKernelLike,
  type McpSearchRequestLike,
  type McpSearchResultLike,
} from '../src/mcp/real-sources-io';
import { isHiddenEntryName, isWithinDir } from '../src/mcp/search-slice-leg';
import {
  MCP_SEARCH_FILE_RESUME_MAX_SEGMENTS,
  MCP_SEARCH_SLICE_CURSOR_STRIDE,
  MCP_SEARCH_SLICE_MAX_CHILD_ENTRIES,
  MCP_SEARCH_SLICE_MAX_GROUP_FILES,
  MCP_SEARCH_SLICE_MAX_SLICES,
} from '../src/mcp/search-slice-leg';

const ROOT = 'D:\\proj';
const ENGINE_CAP = 5000;
const PER_FILE_CAP = 500;

interface FakeTree {
  readonly dirs: Set<string>;
  readonly files: Map<string, number>;
}

function makeTree(): FakeTree {
  return { dirs: new Set<string>([ROOT]), files: new Map<string, number>() };
}

interface Req {
  readonly roots: readonly string[];
  readonly maxResults: number;
  readonly resumeAfterMatches: number | undefined;
}

interface Harness {
  readonly tree: FakeTree;
  readonly requests: Req[];
  readonly call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function harness(tree: FakeTree, opts: { readonly supportsResume?: boolean } = {}): Harness {
  const supportsResume = opts.supportsResume !== false;
  const requests: Req[] = [];

  function expand(roots: readonly string[]): string[] {
    const out: string[] = [];
    for (const root of roots) {
      const key = root.toLowerCase();
      if (tree.files.has(root) || [...tree.files.keys()].some((f) => f.toLowerCase() === key)) {
        out.push(root); // 文件根不经 is_hidden_name（B16 实测结论八）
        continue;
      }
      if (!tree.dirs.has(root) && ![...tree.dirs].some((d) => d.toLowerCase() === key)) continue;
      for (const f of tree.files.keys()) {
        if (isHiddenEntryName(f)) continue;
        if (isWithinDir(f, root) || parentOf(f).toLowerCase() === key) out.push(f);
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
    const asked = (req.options as { readonly resumeAfterMatches?: number }).resumeAfterMatches;
    requests.push({
      roots: [...req.roots],
      maxResults: Math.min(ENGINE_CAP, Math.max(1, req.options.maxResults ?? 2000)),
      resumeAfterMatches: asked,
    });
    const maxResults = Math.min(ENGINE_CAP, Math.max(1, req.options.maxResults ?? 2000));
    // 旧宿主：认不出这个键 ⇒ 等效「从第 0 条起」（这正是腿必须判出来的形状）
    const skip = supportsResume ? Math.max(0, Math.floor(asked ?? 0)) : 0;
    const files: { path: string; matches: { line: number; preview: string }[] }[] = [];
    let got = 0;
    let applied = 0;
    let truncated = false;
    let scanned = 0;
    for (const path of expand(req.roots)) {
      if (got >= maxResults) {
        truncated = true;
        break;
      }
      scanned += 1;
      const hits = tree.files.get(path) ?? 0;
      const start = Math.min(skip, hits);
      applied += start;
      const room = Math.min(PER_FILE_CAP, maxResults - got);
      const take = Math.min(hits - start, room);
      const rel = path.slice(ROOT.length + 1);
      files.push({
        path,
        matches: Array.from({ length: take }, (_, i) => ({
          line: start + i + 1,
          preview: `hit ${rel}-l${start + i}`,
        })),
      });
      got += take;
      if (start + take < hits) {
        truncated = true; // 单文件上限先生效（Rust 的 clipped ⇒ overflow）
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
      resumeAppliedMatches: supportsResume ? applied : undefined,
    };
  };

  const walkDir = async (path: string, o?: Record<string, unknown>): Promise<unknown[]> => {
    const maxDepth = typeof o?.['maxDepth'] === 'number' ? (o['maxDepth'] as number) : 16;
    const depthOf = (p: string): number =>
      p.slice(path.length).replace(/^[\\/]+/, '').split(/[\\/]+/).filter((s) => s !== '').length;
    const out: unknown[] = [];
    for (const d of tree.dirs) {
      if (d !== path && isWithinDir(d, path) && depthOf(d) <= maxDepth) out.push({ name: leaf(d), path: d, isDirectory: true });
    }
    for (const f of tree.files.keys()) {
      if (isWithinDir(f, path) && depthOf(f) <= maxDepth) out.push({ name: leaf(f), path: f, isDirectory: false });
    }
    return out;
  };

  const kernel = {
    project: { current: () => ({ rootDir: ROOT, adapterId: 'a', kojoPaths: [] }) },
    io: { walkDir: (p: string, o?: Record<string, unknown>) => walkDir(p, o) as Promise<unknown[]> },
    plugins: { list: () => [] },
    services: { tryGet: <T = unknown>(_k: string): T | undefined => undefined },
    bus: { on: (_n: string, _c: (p: unknown) => void) => () => {} },
    slots: { query: () => [] },
  } as unknown as McpKernelLike;

  const deps: McpIoDeps = { getKernel: () => kernel, getCommands: () => [], invoke: async () => null, searchInFiles: fakeSearch };
  const scope: McpSessionScope = { sessionId: 'b18', clientId: 'c', tier: 'read', approvedRoots: [ROOT], approvedTools: [] };
  const run = createRunSupplemental(deps);
  return { tree, requests, call: (name, args) => run(name, args, scope) as Promise<Record<string, unknown>> };
}

function parentOf(abs: string): string {
  const i = Math.max(abs.lastIndexOf('\\'), abs.lastIndexOf('/'));
  return i <= 0 ? '' : abs.slice(0, i);
}
function leaf(abs: string): string {
  const i = Math.max(abs.lastIndexOf('\\'), abs.lastIndexOf('/'));
  return i < 0 ? abs : abs.slice(i + 1);
}

/* ------------------------------- 真值与翻页器 ------------------------------- */

/**
 * 解析式真值：**没有单文件上限的假想一次性全量**。
 * path 半边必须走 `toRelativePath`（与腿的投影腿同一条），preview 半边保持夹具写法——
 * B16 刚踩过「两边各 6000 但分隔符写法不同 ⇒ 全员错位」，这里一个字都不许自抄。
 */
function truthKeys(tree: FakeTree): Set<string> {
  const out = new Set<string>();
  for (const [path, hits] of tree.files) {
    if (isHiddenEntryName(path)) continue;
    const projected = toRelativePath(path, ROOT);
    const rel = path.slice(ROOT.length + 1);
    for (let k = 0; k < hits; k += 1) out.add(`${projected}|${k + 1}|hit ${rel}-l${k}`);
  }
  return out;
}

interface WalkOutcome {
  readonly keys: string[];
  readonly pages: Record<string, unknown>[];
  readonly last: Record<string, unknown>;
}

async function walkAll(call: Harness['call'], maxPages = 200): Promise<WalkOutcome> {
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

/* ------------------------------- 主判据：那堵墙现在翻得过去了 ------------------------------- */

describe('B18 判据 · 单文件 500 条上限被逐段续取翻过去', () => {
  it('根上一枚 2,600 条命中的文件 ⇒ 逐页拼接等于「假想无上限」的真值，无重无漏', async () => {
    const tree = makeTree();
    tree.files.set(`${ROOT}\\huge.erb`, 2600);
    const h = harness(tree);
    const { keys, last } = await walkAll(h.call);
    const truth = truthKeys(tree);

    expect(truth.size).toBe(2600); // 夹具必须真的超过单文件上限 5 倍，否则这条判据是空的
    expect(new Set(keys).size).toBe(keys.length); // 无重
    expect(keys.length).toBe(truth.size); // 无漏（也不许多）
    expect(new Set(keys)).toEqual(truth);
    expect(last['walkComplete']).toBe(true);
    expect(last['engineWallReached']).toBeUndefined(); // 续上了就不是墙——两态不许混淆
    // 腿必须真的用了凭据（不是把同一批前 500 条反复端上桌）
    expect(h.requests.some((r) => r.resumeAfterMatches === 500)).toBe(true);
    expect(h.requests.some((r) => r.resumeAfterMatches === 2500)).toBe(true);
  });

  it('每页都看得见逐段账：段号 / 该文件消费到哪儿 / 每段条数 / 段数上限', async () => {
    const tree = makeTree();
    tree.files.set(`${ROOT}\\huge.erb`, 1200);
    const h = harness(tree);
    const { pages } = await walkAll(h.call);
    const segments = pages.map((p) => p['fileResumeSegment']);
    expect(segments.some((s) => typeof s === 'number' && s > 0)).toBe(true);
    for (const p of pages) {
      expect(typeof p['fileResumeSegment']).toBe('number');
      expect(typeof p['fileResumeConsumedMatches']).toBe('number');
      expect(typeof p['fileResumeSegmentMatches']).toBe('number');
      expect(typeof p['fileResumeSegmentLimit']).toBe('number');
    }
    // 消费位单调推进，且最后恰是文件穷尽处
    const consumed = pages.map((p) => Number(p['fileResumeConsumedMatches']));
    expect(consumed).toEqual([...consumed].sort((a, b) => a - b));
    expect(consumed[consumed.length - 1]).toBe(1200);
  });

  it('混合计划（两条目录片 + 一条稠密单文件片）拼接仍等于真值；目录片不因为本批多打一次引擎', async () => {
    const tree = makeTree();
    tree.dirs.add(`${ROOT}\\d0`);
    tree.dirs.add(`${ROOT}\\d1`);
    for (const d of ['d0', 'd1']) for (let f = 0; f < 3; f += 1) tree.files.set(`${ROOT}\\${d}\\f${f}.erb`, 100);
    tree.files.set(`${ROOT}\\huge.erb`, 1100);
    const h = harness(tree);
    const { keys, last } = await walkAll(h.call);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(truthKeys(tree));
    expect(last['walkComplete']).toBe(true);
  });

  it('闸一格没放宽：每次引擎调用 maxResults ≤ 5,000、凭据 ≤ 段数上限×500、每页每文件返回 ≤ 500', async () => {
    const tree = makeTree();
    tree.files.set(`${ROOT}\\huge.erb`, 2600);
    const h = harness(tree);
    const { pages } = await walkAll(h.call);
    for (const r of h.requests) {
      expect(r.maxResults).toBeLessThanOrEqual(ENGINE_CAP);
      if (typeof r.resumeAfterMatches === 'number') {
        expect(r.resumeAfterMatches % PER_FILE_CAP).toBe(0);
        expect(r.resumeAfterMatches).toBeLessThanOrEqual(16 * PER_FILE_CAP);
      }
    }
    for (const p of pages) {
      const perFile = new Map<string, number>();
      for (const hh of (p['hits'] as Record<string, unknown>[]) ?? []) {
        perFile.set(String(hh['path']), (perFile.get(String(hh['path'])) ?? 0) + 1);
      }
      for (const n of perFile.values()) expect(n).toBeLessThanOrEqual(PER_FILE_CAP);
    }
  });

  it('段数上限是有界的：9,000 条的文件到 8,000 条当场按墙出声，绝不无限续', async () => {
    const tree = makeTree();
    tree.files.set(`${ROOT}\\very-huge.erb`, 9000);
    const h = harness(tree);
    const { keys, pages, last } = await walkAll(h.call, 120);
    expect(last['engineWallReached']).toBe(true);
    expect(last['hasMore']).toBe(false);
    expect(last['nextCursor']).toBeNull();
    const blocked = last['blockedSlice'] as Record<string, unknown>;
    expect(blocked['reason']).toBe('file-resume-segments-exhausted');
    expect(Number(last['fileResumeConsumedMatches'])).toBe(8000);
    expect(Number(last['fileResumeSegmentLimit'])).toBe(16);
    expect(new Set(keys).size).toBe(keys.length); // 到墙为止仍然无重
    expect(String(last['note'])).toContain('段数上限');
    // 空页必须当场按墙出声（B16 那条硬规矩在续取面同样成立）
    expect(pages.some((p) => ((p['hits'] as unknown[]) ?? []).length === 0 && p['hasMore'] === true)).toBe(false);
  });

  it('旧宿主（不回显凭据）⇒ 判得出「没续上」，退回 B16 那堵墙的原话术，绝不重复端同一批', async () => {
    const tree = makeTree();
    tree.files.set(`${ROOT}\\huge.erb`, 2600);
    const h = harness(tree, { supportsResume: false });
    const { keys, pages, last } = await walkAll(h.call);
    expect(last['engineWallReached']).toBe(true);
    expect(last['hasMore']).toBe(false);
    expect(String(last['note'])).toContain('SEARCH_PER_FILE_CAP'); // B16 冻结的那句话不许被本批改掉
    expect(String(last['note'])).toContain('未回显'); // 本批新增的一句：为什么仍判旧宿主
    const resume = last['fileResume'] as Record<string, unknown>;
    expect(resume['honored']).toBe(false);
    expect(new Set(keys).size).toBe(keys.length); // 前 500 条只出现一次
    expect(keys.length).toBe(500);
    expect(pages.some((p) => ((p['hits'] as unknown[]) ?? []).length === 0 && p['hasMore'] === true)).toBe(false);
  });

  it('续取段的每一页 knownTotal 一律 false + 理由点名累加器；只有「单片且一段到底」才转 true', async () => {
    const dense = makeTree();
    dense.files.set(`${ROOT}\\huge.erb`, 1200);
    const h = harness(dense);
    const { pages, last } = await walkAll(h.call);
    for (const p of pages) {
      expect(p['knownTotal']).toBe(false);
      expect(String(p['knownTotalReason'])).toContain('累加器');
      expect(p['totalScope']).toBe('slice');
    }
    expect(last['walkComplete']).toBe(true);

    // 反面对照：单片且不触墙（一次到底）⇒ 总量真的已知，本批没把它改坏
    const small = makeTree();
    small.files.set(`${ROOT}\\a.erb`, 10);
    const s = harness(small);
    const one = await s.call('workspace.searchAll', { query: 'hit', resumeBySlice: true, limit: 200 });
    expect(one['knownTotal']).toBe(true);
    expect(one['totalScope']).toBe('project');
    expect(Number(one['total'])).toBe(10);
  });

  it('游标仍是 B1 那一套（不新增任何入参位）；偏移最大不超过段数上限×500，绝不进位串片', async () => {
    const tree = makeTree();
    tree.files.set(`${ROOT}\\huge.erb`, 2600);
    const h = harness(tree);
    let args: Record<string, unknown> = { query: 'hit', resumeBySlice: true, limit: 200 };
    let cursor: string | null = null;
    for (let i = 0; i < 40; i += 1) {
      const page = await h.call('workspace.searchAll', args);
      if (page['hasMore'] !== true) break;
      cursor = String(page['nextCursor']);
      expect(cursor).toMatch(/^[0-9a-f]{8}:\d{1,10}$/);
      const index = Number(cursor.split(':')[1]);
      expect(index).toBeLessThan(8192); // 单片计划：偏移必须留在自己的进制格子里
      args = { query: 'hit', resumeBySlice: true, limit: 200, cursor };
    }
    expect(cursor).not.toBeNull();
  });

  it('续取途中改前段正文 ⇒ 游标指纹抓到，从第 0 片第 0 条重发，绝不与旧页拼接', async () => {
    const tree = makeTree();
    tree.files.set(`${ROOT}\\huge.erb`, 2600);
    const h = harness(tree);
    // 先走到第 2 段里（偏移 ≥ 600 ⇒ 这一页的账是「段起点 500 + 段内 100」）
    let args: Record<string, unknown> = { query: 'hit', resumeBySlice: true, limit: 200 };
    let page: Record<string, unknown> = {};
    for (let i = 0; i < 12; i += 1) {
      page = await h.call('workspace.searchAll', args);
      args = { query: 'hit', resumeBySlice: true, limit: 200, cursor: String(page['nextCursor']) };
      if (Number(page['sliceOffset']) >= 600) break;
    }
    expect(Number(page['sliceOffset'])).toBeGreaterThanOrEqual(600);
    expect(Number(page['fileResumeSegment'])).toBeGreaterThan(0);
    // 段 1 里「已消费的那一截」的正文变了（2,600 → 520 条）⇒ 前缀读回来对不上
    tree.files.set(`${ROOT}\\huge.erb`, 520);
    const next = await h.call('workspace.searchAll', args);
    expect(next['changedDuringPaging']).toBe(true);
    expect(next['sliceIndex']).toBe(0);
    expect(Number(next['offset'])).toBe(200); // 从第 0 片第 0 条重发，不盲切旧偏移
    expect(String(next['note'])).toContain('不可与旧页拼接');
  });

  it('缺省（不给 resumeBySlice）旧面逐字不变：不发送凭据、账目里没有逐段字段', async () => {
    const tree = makeTree();
    tree.files.set(`${ROOT}\\huge.erb`, 1200);
    const h = harness(tree);
    const one = await h.call('workspace.searchAll', { query: 'hit', limit: 200 });
    expect(one['fileResumeSegment']).toBeUndefined();
    expect(one['fileResume']).toBeUndefined();
    expect(one['engineWallReached']).toBe(true);
    expect(h.requests.every((r) => r.resumeAfterMatches === undefined)).toBe(true);
    expect(String(one['note'])).toContain('5000');
  });
});

/* ------------------------------- 常量尺子（进制不串片） ------------------------------- */

describe('B18 常量尺子 · 段数上限的存在理由', () => {
  it('MAX_SEGMENTS × 单文件上限 < 游标进制；B16 那三枚硬上限一字没动', () => {
    expect(MCP_SEARCH_FILE_RESUME_MAX_SEGMENTS).toBe(16);
    // 16 × 500 = 8,000 < 8,192 ⇒ 「片内偏移」永远不可能进位到下一片那一格
    expect(MCP_SEARCH_FILE_RESUME_MAX_SEGMENTS * PER_FILE_CAP).toBeLessThan(MCP_SEARCH_SLICE_CURSOR_STRIDE);
    expect(MCP_SEARCH_SLICE_CURSOR_STRIDE).toBe(8192);
    expect(MCP_SEARCH_SLICE_MAX_SLICES).toBe(64);
    expect(MCP_SEARCH_SLICE_MAX_GROUP_FILES).toBe(64);
    expect(MCP_SEARCH_SLICE_MAX_CHILD_ENTRIES).toBe(5000);
  });

  it('引擎回显对不上请求值 ⇒ 判「没续上」，凭据绝不进入下一页的账（重复页比墙更坏）', async () => {
    const tree = makeTree();
    tree.files.set(`${ROOT}\\huge.erb`, 1200);
    const h = harness(tree, { supportsResume: false });
    await walkAll(h.call);
    // 旧宿主这一趟**不该**出现任何带凭据的成功续取：请求过就必须当场判废并退回旧面调用
    const withCred = h.requests.filter((r) => typeof r.resumeAfterMatches === 'number' && r.resumeAfterMatches > 0);
    expect(withCred.length).toBeGreaterThan(0); // 确实试过凭据（不是假装能续）
    const last = await h.call('workspace.searchAll', { query: 'hit', resumeBySlice: true, limit: 200, offset: 900 });
    expect(last['engineWallReached']).toBe(true);
    expect((last['fileResume'] as Record<string, unknown>)['credentialUsedInThisCall']).toBe(false);
  });
});
