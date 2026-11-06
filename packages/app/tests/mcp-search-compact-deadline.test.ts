/**
 * MCP-PERF-S8（LaneR，2026-11-07）· 检索 token 账与软时限上 MCP 面（三腿全 additive）
 *
 * BOARD 卡三腿（判据先红 → 落地转绿，两个 commit 照 B22/S4/S6 先例）：
 *
 *  腿1 `deadlineMs`（`search.all` / `workspace.searchAll`）：S1 批的 Rust DTO（`lib.rs`
 *      `deadline_ms`）+ bridge 类型（`bridge/search.ts` `SearchOptions.deadlineMs`）已在，
 *      但 MCP 面 schema 没暴露 ⇒ agent 用不上。本批接面：schema + CONSUMED + 腿真取用；
 *      到点回 `partial:true` + `partialReason:"deadline"`（S1 已有语义，透传不重造）。
 *
 *  腿2 `preview:"full"|"none"`（同两枚面）：缺省 full＝逐字零行为变化；none ⇒ MCP 腿在
 *      **投影层**剥掉每条 match 的 preview 字段（Rust 零改动），命中账
 *      （total/offset/limit/hasMore/nextCursor/fingerprint/knownTotal）与 full 模式逐位一致
 *      ⇒ 游标跨模式互认（剥字段发生在记账之后）。
 *
 *  腿3 `semantic.projectSymbols` `query`（可选 string）：**次序无关子串**过滤——多 token
 *      空白切分、每个 token 都得是名字（归一化名，天然大小写不敏感）的子串、token 之间
 *      次序无关（"face draw" ≡ "draw face"）。为什么选子串而不选编辑距离 ≤2（照 B11 的
 *      Damerau-Levenshtein 0.34 形态二选一）：ERB 函数名碎片普遍只有 3..8 字符，绝对
 *      距离 ≤2 在这个长度段近乎「任意匹配」（4 字符名的距离 2 邻域是上千个串），会把
 *      无关符号灌满每一页；B11 的 0.34 是**归一化**阈值，调教目标是长 camelCase 键名的
 *      手误纠正（maxRetuns→maxResults），搬来过滤短符号名等于子串加噪声。子串过滤
 *      零分配（预折大写的 needle 对归一化名 `includes`）、结果 ⊆ 全量且序稳定
 *      （byName 迭代序原样保留）、判性一目了然。走 byName 键过滤**不重扫**；
 *      分页/游标照旧（作用于过滤后集合，不同 query 的页靠指纹互斥不串接）；
 *      空 / 缺席 = 全量零行为变化。
 *
 * 红线：tools 计数零变化（payload 闸 81/13/18 等读数不动）；四张授权表零改动；
 * ps10 零进图（real-sources-io.ts 本就只在 MCP 装载链拉起）；S1/S4 已落地语义零回退
 * （腿2/腿3 的「缺省逐字一致」用例就是回退锚）。全程假注入（fake kernel / walkDir /
 * searchInFiles / erb.parser 索引），零 GUI / 零 Tauri / 零 HTTP。
 */
import { describe, expect, it } from 'vitest';
import { KERNEL_IO_TOOL_SPECS, SUPPLEMENTAL_TOOL_SPECS, type McpSessionScope } from '@kojo/mcp-host';
import {
  createKernelIo,
  createRunSupplemental,
  type McpIoDeps,
  type McpKernelLike,
  type McpSearchRequestLike,
  type McpSearchResultLike,
} from '../src/mcp/real-sources-io';
import { McpFailure } from '@kojo/mcp-host';
import type { CommandEntry } from '../src/ui/commands';

/* ------------------------------- 现场取面 ------------------------------- */

const ROOT = 'D:\\proj';

const scope: McpSessionScope = {
  sessionId: 's8',
  clientId: 's8c',
  tier: 'read',
  approvedRoots: [ROOT],
  approvedTools: [],
};

const specByName = new Map([...KERNEL_IO_TOOL_SPECS, ...SUPPLEMENTAL_TOOL_SPECS].map((s) => [s.name, s]));

function propsOf(name: string): Record<string, unknown> {
  const spec = specByName.get(name);
  expect(spec, `${name} 必须在册`).toBeDefined();
  return (spec!.inputSchema as Record<string, unknown>)['properties'] as Record<string, unknown>;
}

const CODE = (err: unknown): string =>
  err instanceof McpFailure ? err.code : String((err as { code?: unknown })?.code ?? '?');

/* ------------------------------- 检索假件 ------------------------------- */

/** 引擎应答假件（2 文件 3 命中；over 可注入 partial/partialReason）。 */
function engineResult(over: Partial<McpSearchResultLike> = {}): McpSearchResultLike {
  return {
    files: [
      {
        path: `${ROOT}\\a.kojo`,
        matches: [
          { line: 2, preview: 'alpha hit one' },
          { line: 5, preview: 'alpha hit two' },
        ],
      },
      { path: `${ROOT}\\sub\\b.kojo`, matches: [{ line: 3, preview: 'beta hit three' }] },
    ],
    totalMatches: 3,
    truncated: false,
    filesScanned: 2,
    elapsedMs: 11,
    skipped: { binary: 0, tooLarge: 0, unreadable: 0, filtered: 0 },
    ...over,
  };
}

function searchHarness(
  result: McpSearchResultLike = engineResult(),
  over: Partial<McpIoDeps> = {},
): { readonly deps: McpIoDeps; readonly requests: McpSearchRequestLike[] } {
  const requests: McpSearchRequestLike[] = [];
  const kernel = {
    project: { current: () => ({ rootDir: ROOT, adapterId: 'a' }) },
    io: {},
    plugins: { list: () => [] },
    services: { tryGet: () => undefined },
    bus: { on: () => () => {} },
    slots: { query: () => [] },
  } as unknown as McpKernelLike;
  const deps: McpIoDeps = {
    getKernel: () => kernel,
    getCommands: () => [] as CommandEntry[],
    invoke: async () => null,
    searchInFiles: async (request) => {
      requests.push(request);
      return result;
    },
    ...over,
  };
  return { deps, requests };
}

/** `search.all`（kernelIo 腿）与 `workspace.searchAll`（supplemental 腿）的统一入口。 */
function searchFace(
  deps: McpIoDeps,
  face: 'search.all' | 'workspace.searchAll',
): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  if (face === 'search.all') {
    const leg = createKernelIo(deps).searchAll;
    return async (args) => (await leg(args, scope)) as Record<string, unknown>;
  }
  const sup = createRunSupplemental(deps);
  return async (args) => (await sup('workspace.searchAll', args, scope)) as Record<string, unknown>;
}

const BOTH_FACES = ['search.all', 'workspace.searchAll'] as const;

/* ------------------------------- 分片路假件（腿2 用） ------------------------------- */

/**
 * 一棵两文件小树（`D:\proj\k\{a,b}.kojo`）+ 引擎假件：`resumeBySlice:true` 的建划是
 * 深度 1 目录 `k`（2 文件 ≤ 64）⇒ 恰一片。照 `mcp-search-slice-resume.test.ts` 的
 * 假件口径（窗口收口 / 单文件夹取），但只保留本文件需要的最小形状。
 */
function sliceHarness(): { readonly deps: McpIoDeps; readonly requests: McpSearchRequestLike[] } {
  const requests: McpSearchRequestLike[] = [];
  const files = new Map<string, number>([
    [`${ROOT}\\k\\a.kojo`, 2],
    [`${ROOT}\\k\\b.kojo`, 1],
  ]);
  const within = (p: string, dir: string): boolean =>
    p.toLowerCase().startsWith(`${dir.toLowerCase()}\\`);
  const walkDir = async (path: string, opts?: Record<string, unknown>): Promise<unknown[]> => {
    const maxDepth = typeof opts?.['maxDepth'] === 'number' ? (opts['maxDepth'] as number) : 16;
    const depth = (p: string): number =>
      p.slice(path.length).replace(/^[\\/]+/, '').split(/[\\/]+/).filter((s) => s !== '').length;
    const out: unknown[] = [];
    if (ROOT.toLowerCase() === path.toLowerCase() && maxDepth >= 1) {
      out.push({ name: 'k', path: `${ROOT}\\k`, isDirectory: true });
    }
    for (const f of files.keys()) {
      if (within(f, `${ROOT}\\k`) && depth(f) <= maxDepth) {
        out.push({ name: f.split('\\').pop()!, path: f, isDirectory: false });
      }
    }
    return out;
  };
  const fakeSearch = async (req: McpSearchRequestLike): Promise<McpSearchResultLike> => {
    requests.push(req);
    const window = Math.min(5000, Math.max(1, req.options.maxResults ?? 2000));
    const candidates = [...files.keys()].filter((f) => req.roots.some((r) => within(f, r) || f.toLowerCase() === r.toLowerCase()));
    const out: { path: string; matches: { line: number; preview: string }[] }[] = [];
    let got = 0;
    for (const path of candidates) {
      const hits = files.get(path) ?? 0;
      const taken = Math.min(hits, window - got);
      out.push({
        path,
        matches: Array.from({ length: taken }, (_, i) => ({ line: i + 1, preview: `hit ${path}-l${i}` })),
      });
      got += taken;
    }
    return {
      files: out,
      totalMatches: got,
      truncated: false,
      filesScanned: candidates.length,
      elapsedMs: 2,
      skipped: { binary: 0, tooLarge: 0, unreadable: 0, filtered: 0, excluded: 0 },
    };
  };
  const kernel = {
    project: { current: () => ({ rootDir: ROOT, adapterId: 'a' }) },
    io: { walkDir: (p: string, o?: Record<string, unknown>) => walkDir(p, o) },
    plugins: { list: () => [] },
    services: { tryGet: () => undefined },
    bus: { on: () => () => {} },
    slots: { query: () => [] },
  } as unknown as McpKernelLike;
  const deps: McpIoDeps = {
    getKernel: () => kernel,
    getCommands: () => [] as CommandEntry[],
    invoke: async () => null,
    searchInFiles: fakeSearch,
  };
  return { deps, requests };
}

/* ------------------------------- projectSymbols 假件（腿3 用） ------------------------------- */

/** byName 假件口径照 `mcp-range-outline.test.ts`（forEachDef 逐定义回调）。 */
function fakeLookup(defs: readonly Record<string, unknown>[]): {
  forEachDef: (cb: (ref: Record<string, unknown>, name: string) => void) => void;
} {
  return {
    forEachDef: (cb) => {
      for (const [i, def] of defs.entries()) cb(def, String(def['normalizedName'] ?? def['name'] ?? `#${i}`));
    },
  };
}

const DEFS: readonly Record<string, unknown>[] = [
  { name: 'DRAW_FACE', normalizedName: 'DRAW_FACE', filePath: `${ROOT}\\a.erb`, startLine: 10, endLine: 20 },
  { name: 'drawFaceSmall', normalizedName: 'DRAWFACESMALL', filePath: `${ROOT}\\b.erb`, startLine: 30, endLine: 45, nameColumn: 3 },
  { name: 'FACE_WASH', normalizedName: 'FACE_WASH', filePath: `${ROOT}\\c.erb`, startLine: 50, endLine: 60 },
  { name: 'OTHER_FN', normalizedName: 'OTHER_FN', filePath: `${ROOT}\\d.erb`, startLine: 70, endLine: 90 },
];

function symbolHarness(): { readonly deps: McpIoDeps } {
  const parser = { currentIndex: () => ({ byName: fakeLookup(DEFS) }), indexState: () => ({ phase: 'ready' }) };
  const kernel = {
    project: { current: () => ({ rootDir: ROOT, adapterId: 'a' }) },
    io: {},
    plugins: { list: () => [] },
    services: { tryGet: (key: string) => (key === 'erb.parser' ? parser : undefined) },
    bus: { on: () => () => {} },
    slots: { query: () => [] },
  } as unknown as McpKernelLike;
  const deps: McpIoDeps = {
    getKernel: () => kernel,
    getCommands: () => [] as CommandEntry[],
    invoke: async () => null,
    searchInFiles: async () => engineResult(),
  };
  return { deps };
}

const symCall =
  (deps: McpIoDeps) =>
  (args: Record<string, unknown>): Promise<Record<string, unknown>> =>
    createRunSupplemental(deps)('semantic.projectSymbols', args, scope) as Promise<Record<string, unknown>>;

/* ================================ 腿1 · deadlineMs ================================ */

describe('MCP-PERF-S8 腿1 · deadlineMs 上 MCP 面（起手红：schema 未暴露 ⇒ agent 用不上）', () => {
  it('① 两枚检索面 inputSchema 声明 deadlineMs（integer 1..120000，非必填）', () => {
    for (const name of BOTH_FACES) {
      const p = propsOf(name)['deadlineMs'] as Record<string, unknown> | undefined;
      expect(p, `${name} 缺 deadlineMs（S1 软时限只到 Rust DTO/bridge，MCP 面没暴露）`).toBeDefined();
      expect(p!['type']).toBe('integer');
      expect(p!['minimum']).toBe(1);
      expect(p!['maximum']).toBe(120000);
      const required = (specByName.get(name)!.inputSchema as Record<string, unknown>)['required'] as
        | readonly string[]
        | undefined;
      expect(required ?? [], `${name} 的 deadlineMs 不许设为必填`).not.toContain('deadlineMs');
    }
  });

  it('② search.all 一次性腿把 deadlineMs 真带进 search_text 请求（CONSUMED「腿真取用」）', async () => {
    const { deps, requests } = searchHarness();
    await searchFace(deps, 'search.all')({ query: 'hit', deadlineMs: 5000 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.options['deadlineMs']).toBe(5000);
  });

  it('③ workspace.searchAll 同腿同账', async () => {
    const { deps, requests } = searchHarness();
    await searchFace(deps, 'workspace.searchAll')({ query: 'hit', deadlineMs: 120000 });
    expect(requests[0]!.options['deadlineMs']).toBe(120000);
  });

  it('④ 缺省不带 deadlineMs 键：请求体与旧面逐字同形（S1 缺省 None 同义，零行为变化锚）', async () => {
    for (const face of BOTH_FACES) {
      const { deps, requests } = searchHarness();
      await searchFace(deps, face)({ query: 'hit' });
      expect(requests).toHaveLength(1);
      expect('deadlineMs' in requests[0]!.options, `${face} 缺省请求体长了 deadlineMs 键`).toBe(false);
    }
  });

  it('⑤ 脏值显式拒收（0 / 负 / 非整数 / 超上限 / 非数字）：越界不夹取、不静默回落「无时限」', async () => {
    for (const face of BOTH_FACES) {
      for (const bad of [0, -1, 0.5, 120001, '5000', null]) {
        const { deps } = searchHarness();
        const err = await searchFace(deps, face)({ query: 'hit', deadlineMs: bad }).catch((e: unknown) => e);
        expect(CODE(err), `${face} 的 deadlineMs=${String(bad)} 应显式拒收`).toBe('INVALID_ARGS');
      }
    }
  });

  it('⑥ 引擎 partial:true + partialReason:"deadline" ⇒ MCP 应答透传（S1 语义不重造）；两枚面同账', async () => {
    for (const face of BOTH_FACES) {
      const { deps } = searchHarness(engineResult({ partial: true, partialReason: 'deadline' }));
      const out = await searchFace(deps, face)({ query: 'hit', deadlineMs: 1 });
      expect(out['partial'], `${face} 应带 partial:true`).toBe(true);
      expect(out['partialReason'], `${face} 应带 partialReason:"deadline"`).toBe('deadline');
    }
  });

  it('⑦ 引擎未报 partial ⇒ 应答不带 partial 键（旧宿主应答零漂移）', async () => {
    for (const face of BOTH_FACES) {
      const { deps } = searchHarness(engineResult());
      const out = await searchFace(deps, face)({ query: 'hit', deadlineMs: 1 });
      expect('partial' in out).toBe(false);
      expect('partialReason' in out).toBe(false);
    }
  });

  it('⑧ deadlineMs 与 resumeBySlice:true 不同收：显式 INVALID_ARGS（分片路每片是独立引擎调用，绝不静默丢时限）', async () => {
    for (const face of BOTH_FACES) {
      const { deps } = searchHarness();
      const err = await searchFace(deps, face)({ query: 'hit', deadlineMs: 5000, resumeBySlice: true }).catch(
        (e: unknown) => e,
      );
      expect(CODE(err), `${face} 的 deadlineMs × resumeBySlice 组合应显式拒收`).toBe('INVALID_ARGS');
    }
  });
});

/* ================================ 腿2 · preview compact ================================ */

describe('MCP-PERF-S8 腿2 · preview:"none" 投影层剥字段（起手红：无 preview 入参）', () => {
  it('① 两枚检索面声明 preview enum ["full","none"]（非必填，缺省语义 = full）', () => {
    for (const name of BOTH_FACES) {
      const p = propsOf(name)['preview'] as Record<string, unknown> | undefined;
      expect(p, `${name} 缺 preview 入参`).toBeDefined();
      expect(p!['type']).toBe('string');
      expect(p!['enum']).toEqual(['full', 'none']);
    }
  });

  it('② 缺省与 "full" 逐字一致（toEqual 全应答），每条命中带 preview 字符串——零行为变化锚', async () => {
    for (const face of BOTH_FACES) {
      const { deps } = searchHarness();
      const legacy = await searchFace(deps, face)({ query: 'hit' });
      const { deps: deps2 } = searchHarness();
      const full = await searchFace(deps2, face)({ query: 'hit', preview: 'full' });
      expect(full).toEqual(legacy);
      for (const hit of (legacy['hits'] as Record<string, unknown>[]) ?? []) {
        expect(typeof hit['preview']).toBe('string');
      }
    }
  });

  it('③ "none"：每条命中剥掉 preview 键（键都不在，不是空串），path/line 序与 full 逐位一致', async () => {
    for (const face of BOTH_FACES) {
      const { deps } = searchHarness();
      const out = await searchFace(deps, face)({ query: 'hit', preview: 'none' });
      const hits = out['hits'] as Record<string, unknown>[];
      expect(hits).toHaveLength(3);
      for (const hit of hits) {
        expect('preview' in hit, `${face} none 模式命中仍带 preview 键`).toBe(false);
        expect(typeof hit['path']).toBe('string');
        expect(typeof hit['line']).toBe('number');
      }
      expect(hits.map((h) => [h['path'], h['line']])).toEqual([
        [expect.any(String), 2],
        [expect.any(String), 5],
        [expect.any(String), 3],
      ]);
    }
  });

  it('④ 命中账与 full 逐位一致：除 hits 外整个应答 JSON 相等（total/offset/limit/hasMore/knownTotal/指纹）', async () => {
    for (const face of BOTH_FACES) {
      const { deps } = searchHarness();
      const full = await searchFace(deps, face)({ query: 'hit', limit: 2 });
      const { deps: deps2 } = searchHarness();
      const none = await searchFace(deps2, face)({ query: 'hit', limit: 2, preview: 'none' });
      const { hits: _fullHits, ...fullAccount } = full;
      const { hits: _noneHits, ...noneAccount } = none;
      expect(noneAccount).toEqual(fullAccount);
    }
  });

  it('⑤ 游标跨模式互认：full 第一页的 nextCursor 给 none 续页（反之亦然）⇒ 无 changedDuringPaging', async () => {
    for (const face of BOTH_FACES) {
      const { deps } = searchHarness();
      const p1 = await searchFace(deps, face)({ query: 'hit', limit: 2 });
      expect(p1['hasMore']).toBe(true);
      const p2None = await searchFace(deps, face)({ query: 'hit', limit: 2, preview: 'none', cursor: p1['nextCursor'] });
      expect(p2None['changedDuringPaging']).toBeUndefined();
      expect((p2None['hits'] as Record<string, unknown>[]).every((h) => !('preview' in h))).toBe(true);
      expect(p2None['hits']).toHaveLength(1);
      const { deps: deps2 } = searchHarness();
      const np1 = await searchFace(deps2, face)({ query: 'hit', limit: 2, preview: 'none' });
      const p2Full = await searchFace(deps2, face)({ query: 'hit', limit: 2, cursor: np1['nextCursor'] });
      expect(p2Full['changedDuringPaging']).toBeUndefined();
      expect((p2Full['hits'] as Record<string, unknown>[]).every((h) => typeof h['preview'] === 'string')).toBe(true);
    }
  });

  it('⑥ 脏值显式拒收（1 / "compact" / "NONE" / null）⇒ INVALID_ARGS', async () => {
    for (const face of BOTH_FACES) {
      for (const bad of [1, 'compact', 'NONE', null]) {
        const { deps } = searchHarness();
        const err = await searchFace(deps, face)({ query: 'hit', preview: bad }).catch((e: unknown) => e);
        expect(CODE(err), `${face} 的 preview=${String(bad)} 应显式拒收`).toBe('INVALID_ARGS');
      }
    }
  });

  it('⑦ 分片路（resumeBySlice:true）none：hits 剥字段，其余账与 full 分片逐位一致', async () => {
    for (const face of BOTH_FACES) {
      const { deps } = sliceHarness();
      const full = await searchFace(deps, face)({ query: 'hit', limit: 50, resumeBySlice: true });
      const fullHits = full['hits'] as Record<string, unknown>[];
      expect(fullHits.length).toBe(3);
      expect(fullHits.every((h) => typeof h['preview'] === 'string')).toBe(true);
      const { deps: deps2 } = sliceHarness();
      const none = await searchFace(deps2, face)({ query: 'hit', limit: 50, resumeBySlice: true, preview: 'none' });
      const noneHits = none['hits'] as Record<string, unknown>[];
      expect(noneHits.every((h) => !('preview' in h))).toBe(true);
      expect(noneHits.map((h) => [h['path'], h['line']])).toEqual(fullHits.map((h) => [h['path'], h['line']]));
      const { hits: _f, ...fullAccount } = full;
      const { hits: _n, ...noneAccount } = none;
      expect(noneAccount).toEqual(fullAccount);
    }
  });
});

/* ================================ 腿3 · projectSymbols query ================================ */

describe('MCP-PERF-S8 腿3 · semantic.projectSymbols 的 query 过滤（起手红：无 query 入参）', () => {
  it('① schema 声明 query（string，非必填，maxLength 512 与检索族同尺）', () => {
    const p = propsOf('semantic.projectSymbols')['query'] as Record<string, unknown> | undefined;
    expect(p, 'semantic.projectSymbols 缺 query 入参').toBeDefined();
    expect(p!['type']).toBe('string');
    expect(p!['maxLength']).toBe(512);
    const required = (specByName.get('semantic.projectSymbols')!.inputSchema as Record<string, unknown>)['required'] as
      | readonly string[]
      | undefined;
    expect(required ?? [], 'query 不许设为必填（零参调用 = 第一页 = 全量）').not.toContain('query');
  });

  it('② 空 / 缺席 = 全量零行为变化：应答与零参调用逐字一致', async () => {
    const { deps } = symbolHarness();
    const zero = await symCall(deps)({});
    const { deps: deps2 } = symbolHarness();
    const empty = await symCall(deps2)({ query: '' });
    const { deps: deps3 } = symbolHarness();
    const blanks = await symCall(deps3)({ query: '   ' });
    expect(empty).toEqual(zero);
    expect(blanks).toEqual(zero);
    expect(zero['total']).toBe(DEFS.length);
  });

  it('③ 单 token 大小写不敏感子串：结果 ⊆ 全量且序稳定（byName 迭代序原样保留）', async () => {
    const { deps } = symbolHarness();
    const full = await symCall(deps)({});
    const { deps: deps2 } = symbolHarness();
    const out = await symCall(deps2)({ query: 'draw' });
    const items = out['items'] as Record<string, unknown>[];
    expect(items.map((i) => i['name'])).toEqual(['DRAW_FACE', 'drawFaceSmall']);
    expect(out['total']).toBe(2);
    // 子集 + 序稳定：过滤结果在原全量序列里的相对次序不变
    const fullItems = full['items'] as Record<string, unknown>[];
    const idxInFull = items.map((i) => fullItems.findIndex((f) => f['name'] === i['name']));
    expect([...idxInFull].sort((a, b) => a - b)).toEqual(idxInFull);
  });

  it('④ 次序无关：多 token 任意排列给出同一集合（"face draw" ≡ "draw face"）', async () => {
    const { deps } = symbolHarness();
    const a = await symCall(deps)({ query: 'face draw' });
    const { deps: deps2 } = symbolHarness();
    const b = await symCall(deps2)({ query: 'draw face' });
    expect((a['items'] as Record<string, unknown>[]).map((i) => i['name'])).toEqual(['DRAW_FACE', 'drawFaceSmall']);
    expect(b).toEqual(a);
  });

  it('⑤ 零命中如实出声：items [] / total 0 / truncated false / hasMore false（不伪造「空 = 全量」）', async () => {
    const { deps } = symbolHarness();
    const out = await symCall(deps)({ query: 'zzz-nothing' });
    expect(out['items']).toEqual([]);
    expect(out['total']).toBe(0);
    expect(out['truncated']).toBe(false);
    expect(out['hasMore']).toBe(false);
  });

  it('⑥ 过滤集上的分页照旧：total=过滤数，cursor 在过滤集内续页、不漏不重', async () => {
    const { deps } = symbolHarness();
    const p1 = await symCall(deps)({ query: 'draw', limit: 1 });
    expect(p1['total']).toBe(2);
    expect(p1['hasMore']).toBe(true);
    expect((p1['items'] as Record<string, unknown>[]).map((i) => i['name'])).toEqual(['DRAW_FACE']);
    const p2 = await symCall(deps)({ query: 'draw', limit: 1, cursor: p1['nextCursor'] });
    expect(p2['changedDuringPaging']).toBeUndefined();
    expect((p2['items'] as Record<string, unknown>[]).map((i) => i['name'])).toEqual(['drawFaceSmall']);
    expect(p2['hasMore']).toBe(false);
  });

  it('⑦ 脏值显式拒收（query 非字符串 ⇒ INVALID_ARGS）', async () => {
    for (const bad of [123, true, null, ['draw']]) {
      const { deps } = symbolHarness();
      const err = await symCall(deps)({ query: bad }).catch((e: unknown) => e);
      expect(CODE(err), `query=${JSON.stringify(bad)} 应显式拒收`).toBe('INVALID_ARGS');
    }
  });
});
