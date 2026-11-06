/**
 * MCP 长任务面回归（Wave4 余项⑤「长任务 progress」· ADR-0013 P5「Tasks over MCP」）。
 *
 * 全程假注入（假 search 腿 / 假 linter / 假时钟 / 假内核），不启 GUI / Tauri / HTTP / 真运行时。
 * 真源边界与生产一致：`real-sources-tasks.ts` 持表与投影，`real-sources-io.ts` 只做分派与
 * 缺席兜底（铁律 4：真源缺席 ⇒ 显式 `NOT_WIRED` / `RESOURCE_UNAVAILABLE`，绝不空装任务）。
 *
 * 覆盖：
 *  ① 进度口径不夸大 —— 首帧之前 done/total = **null** + `phase:'waiting-first-frame'`（不是 0%）；
 *     帧按 `searchId` 认领（迟到/他人帧不许改写本行）；帧间读数带 `lastFrameAgeMs`；
 *     校验类没有实时进度源 ⇒ `known:false` + 逐条 reason，只有终态 `incomplete` 的事后读数。
 *  ② 取消是**请求语义** —— `tasks.cancel` 触达 `cancelSearch(searchId)`，终态才给 `cancelApplied`
 *     真值（叫停成功 true / 抢先跑完 false / 与界面合流 false）；取消腿缺席 ⇒ NOT_WIRED；终态取消幂等。
 *  ③ 可查询 + 有界性 —— 每会话在途上限、表行上限与淘汰、TTL 回收后显式 RESOURCE_UNAVAILABLE、
 *     会话隔离（不存在 / 已回收 / 他人任务三者同形）、结果有界投影带 `truncated` 账。
 *  ④ `kojo://tasks` 轮询面 —— scope 必须转发（按会话过滤）、`notIncluded[]` 逐族写明缺席原因。
 *  ⑤ 真 `createMcpCapabilityRegistry` 的 tier 闸 —— 只读会话只见/只用 `tasks.status`，
 *     `tasks.start` / `tasks.cancel` 在 read 会话显式 PERMISSION_DENIED。
 *
 * 表是模块作用域状态 ⇒ 每个用例前 `resetMcpTaskTableForTest()`（与仓库 `reset*ForTest` 家族同口径）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpCapabilityRegistry,
  type McpSessionScope,
} from '@kojo/mcp-host';
import {
  createIoResourceData,
  createRunSupplemental,
  KOJO_RESOURCE_URIS,
  type McpIoDeps,
  type McpKernelLike,
  type McpSearchRequestLike,
  type McpSearchResultLike,
} from '../src/mcp/real-sources-io';
import {
  createMcpTaskLegs,
  resetMcpTaskTableForTest,
  TASK_FAILED_RULE_SAMPLE,
  TASK_MAX_RUNNING_PER_SESSION,
  TASK_RESULT_HIT_CAP,
  TASK_RETENTION_MS,
  TASK_TABLE_MAX_ROWS,
  type McpTaskSearchProgress,
  type McpTaskSearchRunner,
} from '../src/mcp/real-sources-tasks';

/* ------------------------------- 会话 ------------------------------- */

const ROOT = 'D:/proj';
const SOURCE_DIR = 'D:/proj/src';

const scope: McpSessionScope = {
  sessionId: 's1',
  clientId: 'c1',
  tier: 'edit',
  approvedRoots: [],
  approvedTools: [],
};
const otherScope: McpSessionScope = { ...scope, sessionId: 's2', clientId: 'c2' };
const readScope: McpSessionScope = { ...scope, tier: 'read' };

const EMPTY_RESULT: McpSearchResultLike = {
  files: [],
  totalMatches: 0,
  truncated: false,
  filesScanned: 0,
  elapsedMs: 12,
  skipped: {},
};

function searchResult(matches: number, over: Partial<McpSearchResultLike> = {}): McpSearchResultLike {
  return {
    files: [{ path: `${ROOT}/a.txt`, matches: Array.from({ length: matches }, (_, i) => ({ line: i + 1, preview: `hit ${i}  ${'x'.repeat(400)}` })) }],
    totalMatches: matches,
    truncated: false,
    filesScanned: 7,
    elapsedMs: 30,
    skipped: { binary: 1 },
    ...over,
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/* ------------------------------- 假件装配 ------------------------------- */

interface SearchSlot {
  readonly request: McpSearchRequestLike;
  emit: (p: McpTaskSearchProgress) => void;
  resolve: (r: McpSearchResultLike) => void;
  reject: (e: unknown) => void;
}

interface LinterStub {
  run?: (opts?: { force?: boolean; signal?: AbortSignal }) => Promise<unknown>;
  report?: () => unknown;
}

interface HarnessOptions {
  /** 给定 ⇒ 检索腿立即 fulfill 成该结果（批量用例用）；缺席 ⇒ 挂在途、由 slot 手动收口。 */
  readonly eagerResult?: McpSearchResultLike;
  readonly cancelSearch?: (searchId: number) => Promise<void>;
  readonly linter?: LinterStub | null;
  /** false ⇒ 内核缺席；null-project ⇒ 项目未开。 */
  readonly kernel?: McpKernelLike | null;
}

function fakeKernel(linter: LinterStub | null | undefined): McpKernelLike {
  return {
    project: { current: () => ({ rootDir: ROOT, adapterId: 'a', kojoPaths: [SOURCE_DIR] }) },
    io: { walkDir: async () => [] },
    plugins: { list: () => [] },
    services: { tryGet: <T,>(key: string): T | undefined => (key === 'convention.linter' ? (linter as unknown as T | undefined) : undefined) },
    bus: { on: () => () => {} },
    slots: { query: () => [] },
  };
}

function makeHarness(over: HarnessOptions = {}) {
  const clock = { t: 1_700_000_000_000 };
  const now = (): number => clock.t;
  const slots: SearchSlot[] = [];
  const calls: McpSearchRequestLike[] = [];
  const search: McpTaskSearchRunner = over.eagerResult
    ? async (request) => {
        calls.push(request);
        return over.eagerResult as McpSearchResultLike;
      }
    : (request, onProgress) =>
        new Promise<McpSearchResultLike>((resolve, reject) => {
          calls.push(request);
          slots.push({ request, emit: onProgress, resolve, reject });
        });
  const kernel = 'kernel' in over ? over.kernel : fakeKernel(over.linter ?? null);
  const legs = createMcpTaskLegs({
    getKernel: () => kernel ?? null,
    search,
    cancelSearch: over.cancelSearch,
    now,
  });
  const deps: McpIoDeps = {
    getKernel: () => kernel ?? null,
    getCommands: () => [],
    invoke: async () => null,
    searchInFiles: async () => EMPTY_RESULT,
    tasks: legs,
  };
  const resources = createIoResourceData(deps, () => [], () => 0);
  return {
    legs,
    deps,
    resources,
    sup: createRunSupplemental(deps),
    clock,
    now,
    calls,
    slots,
    /** 手动收口一条在途检索并让 `.then` 跑完。 */
    async settle(index: number, result: McpSearchResultLike): Promise<void> {
      slots[index]?.resolve(result);
      await tick();
    },
    async fail(index: number, err: unknown): Promise<void> {
      slots[index]?.reject(err);
      await tick();
    },
  };
}

type Harness = ReturnType<typeof makeHarness>;

async function startSearch(h: Harness, args: Record<string, unknown> = {}, sc: McpSessionScope = scope): Promise<Record<string, unknown>> {
  return (await h.legs.start({ query: 'hit', ...args }, sc)) as Record<string, unknown>;
}

async function statusOf(h: Harness, taskId: string, sc: McpSessionScope = scope): Promise<Record<string, unknown>> {
  return (await h.legs.status({ taskId }, sc)) as Record<string, unknown>;
}

function progressOf(view: Record<string, unknown>): Record<string, unknown> {
  return view['progress'] as Record<string, unknown>;
}

beforeEach(() => {
  resetMcpTaskTableForTest();
});

/* ================================================================== *
 * ① 进度口径：轮询读、首帧前 null、帧按 searchId 认领、帧间带年龄
 * ================================================================== */

describe('① 检索任务进度账（首帧前 null 不是 0%；帧按 searchId 认领）', () => {
  it('在途首帧之前：frames:0 + phase:waiting-first-frame + done/total/percent 全 null', async () => {
    const h = makeHarness();
    const view = await startSearch(h);
    expect(view['status']).toBe('running');
    expect(view['endedAt']).toBeNull();
    expect(view['durationMs']).toBeNull();
    expect(view['resultSummary']).toBeNull();
    expect(typeof view['searchId']).toBe('number');
    const progress = progressOf(view);
    expect(progress['known']).toBe(true);
    expect(progress['frames']).toBe(0);
    expect(progress['phase']).toBe('waiting-first-frame');
    expect(progress['done']).toBeNull();
    expect(progress['total']).toBeNull();
    expect(progress['percent']).toBeNull();
    expect(progress['lastFrameAt']).toBeNull();
    expect(progress['lastFrameAgeMs']).toBeNull();
    expect(progress['unit']).toBe('files');
    // 节流窗口内没有读数就是没有读数：绝不用 0 / 0% 冒充
    expect(JSON.stringify(progress)).not.toContain('"done":0');
    expect(h.slots).toHaveLength(1);
    expect(h.slots[0]!.request.roots).toEqual([ROOT]);
    expect(h.slots[0]!.request.query).toBe('hit');
  });

  it('帧按 searchId 认领：他人/迟到帧不动本行读数；本行帧推进 done/total/percent 并进入 reporting', async () => {
    const h = makeHarness();
    const view = await startSearch(h);
    const taskId = view['taskId'] as string;
    const searchId = view['searchId'] as number;

    h.slots[0]!.emit({ searchId: searchId + 999, filesScanned: 99, totalFiles: 99, matchCount: 99 });
    h.slots[0]!.emit({ searchId, filesScanned: 3, totalFiles: 10, matchCount: 2 });
    let st = await statusOf(h, taskId);
    let progress = progressOf(st);
    expect(progress['frames']).toBe(1);
    expect(progress['done']).toBe(3);
    expect(progress['total']).toBe(10);
    expect(progress['percent']).toBe(30);
    expect(progress['matchCount']).toBe(2);
    expect(progress['phase']).toBe('reporting');

    // 帧与帧之间：读数保持上一帧值，年龄如实给出（不是 0%）
    h.clock.t += 2500;
    st = await statusOf(h, taskId);
    progress = progressOf(st);
    expect(progress['done']).toBe(3);
    expect(progress['lastFrameAgeMs']).toBe(2500);
    expect(progress['note']).toContain('不是 0%');
  });

  it('终态进度以 search_text 返回值收口：filesScanned 覆盖帧读数 + phase:final-frame', async () => {
    const h = makeHarness();
    const view = await startSearch(h);
    const taskId = view['taskId'] as string;
    h.slots[0]!.emit({ searchId: view['searchId'] as number, filesScanned: 1, totalFiles: 50, matchCount: 0 });
    await h.settle(0, searchResult(3, { filesScanned: 50 }));
    const st = await statusOf(h, taskId);
    expect(st['status']).toBe('succeeded');
    expect(progressOf(st)['done']).toBe(50);
    expect(progressOf(st)['phase']).toBe('final-frame');
    const result = st['result'] as Record<string, unknown>;
    expect(result['hits']).toHaveLength(3);
    expect((result['hits'] as Record<string, unknown>[])[0]!['path']).toBe('a.txt');
    expect(result['total']).toBe(3);
    expect(result['truncated']).toBe(false);
    expect(result['cancelled']).toBe(false);
    expect(result['filesScanned']).toBe(50);
  });

  it('有界投影：命中条目上限 TASK_RESULT_HIT_CAP，超出显式 truncated 且 hitsKept 有账（总数不失真）', async () => {
    const h = makeHarness();
    const view = await startSearch(h);
    const total = TASK_RESULT_HIT_CAP + 5;
    await h.settle(0, searchResult(total));
    const result = (await statusOf(h, view['taskId'] as string))['result'] as Record<string, unknown>;
    expect(result['hits']).toHaveLength(TASK_RESULT_HIT_CAP);
    expect(result['hitsKept']).toBe(TASK_RESULT_HIT_CAP);
    expect(result['total']).toBe(total);
    expect(result['truncated']).toBe(true);
  });

  it('壳层自报 truncated 也并进同一笔截断账（不靠本面自己判）', async () => {
    const h = makeHarness();
    const view = await startSearch(h);
    await h.settle(0, searchResult(2, { truncated: true, totalMatches: 9999 }));
    const result = (await statusOf(h, view['taskId'] as string))['result'] as Record<string, unknown>;
    expect(result['truncated']).toBe(true);
    expect(result['hits']).toHaveLength(2);
  });
});

/* ================================================================== *
 * ② 取消：请求语义 + 终态事实 + 缺席兜底
 * ================================================================== */

describe('② tasks.cancel 的请求-事实两截口径', () => {
  it('取消按 searchId 触达壳层腿，返回里 cancelApplied:null（终态才是事实）', async () => {
    const cancelSearch = vi.fn(async (_id: number) => undefined);
    const h = makeHarness({ cancelSearch });
    const view = await startSearch(h);
    const out = (await h.legs.cancel({ taskId: view['taskId'] }, scope)) as Record<string, unknown>;
    expect(cancelSearch).toHaveBeenCalledTimes(1);
    expect(cancelSearch).toHaveBeenCalledWith(view['searchId']);
    expect(out['cancelRequested']).toBe(true);
    expect(out['cancelApplied']).toBeNull();
    expect(out['status']).toBe('running');
    expect(out['note']).toContain('请求语义');
    expect(out['elapsedSinceStartMs']).toBeGreaterThanOrEqual(0);

    await h.settle(0, searchResult(1, { cancelled: true }));
    const st = await statusOf(h, view['taskId'] as string);
    expect(st['status']).toBe('cancelled');
    expect(st['cancelApplied']).toBe(true);
  });

  it('抢先跑完（终态 cancelled:false）⇒ cancelApplied:false，不谎称叫停成功', async () => {
    const h = makeHarness({ cancelSearch: async () => undefined });
    const view = await startSearch(h);
    await h.legs.cancel({ taskId: view['taskId'] }, scope);
    await h.settle(0, searchResult(2));
    const st = await statusOf(h, view['taskId'] as string);
    expect(st['status']).toBe('succeeded');
    expect(st['cancelRequested']).toBe(true);
    expect(st['cancelApplied']).toBe(false);
  });

  it('取消腿未接线 ⇒ NOT_WIRED（不假装已取消），且终态如实落到 cancelApplied:false', async () => {
    const h = makeHarness();
    const view = await startSearch(h);
    await expect(h.legs.cancel({ taskId: view['taskId'] }, scope)).rejects.toMatchObject({
      code: 'NOT_WIRED',
      message: expect.stringContaining('cancelSearch'),
    });
    await h.settle(0, searchResult(1));
    const st = await statusOf(h, view['taskId'] as string);
    expect(st['cancelRequested']).toBe(true);
    expect(st['cancelApplied']).toBe(false);
    expect(st['status']).toBe('succeeded');
  });

  it('终态取消幂等：alreadyFinished:true + 既有终态原样给出，壳层腿零触达', async () => {
    const cancelSearch = vi.fn(async () => undefined);
    const h = makeHarness({ cancelSearch });
    const view = await startSearch(h);
    await h.settle(0, searchResult(1));
    const out = (await h.legs.cancel({ taskId: view['taskId'] }, scope)) as Record<string, unknown>;
    expect(out['alreadyFinished']).toBe(true);
    expect(out['status']).toBe('succeeded');
    expect(out['cancelRequested']).toBe(false);
    expect(out['cancelApplied']).toBeNull();
    expect(cancelSearch).not.toHaveBeenCalled();
  });

  it('取消请求未送达（腿抛错）⇒ TOOL_EXECUTION_FAILED，任务照旧在跑', async () => {
    const h = makeHarness({ cancelSearch: async () => { throw new Error('bridge down'); } });
    const view = await startSearch(h);
    await expect(h.legs.cancel({ taskId: view['taskId'] }, scope)).rejects.toMatchObject({
      code: 'TOOL_EXECUTION_FAILED',
      message: expect.stringContaining('bridge down'),
    });
    expect((await statusOf(h, view['taskId'] as string))['status']).toBe('running');
  });
});

/* ================================================================== *
 * ③ 入参闸 / 幽灵任务 / 失败终态
 * ================================================================== */

describe('③ 入参闸与「不建幽灵任务」', () => {
  it('kind / query / scope / taskId 形态不合 ⇒ INVALID_ARGS，表里一行都不多', async () => {
    const h = makeHarness();
    await expect(h.legs.start({ kind: 'export', query: 'x' }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(h.legs.start({}, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(h.legs.start({ query: 'x'.repeat(513) }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(h.legs.start({ query: 'x', scope: 'game' }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(h.legs.status({ taskId: '  ' }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(h.legs.status({}, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    const list = (await h.legs.list(scope)) as Record<string, unknown>;
    expect(list['total']).toBe(0);
    expect(h.slots).toHaveLength(0);
  });

  it('scope:"sources" 且契约无合法作品域 ⇒ RESOURCE_UNAVAILABLE（不建注定扫 0 文件的在途任务）', async () => {
    const noPaths: McpKernelLike = {
      ...fakeKernel(null),
      project: { current: () => ({ rootDir: ROOT, adapterId: 'a', kojoPaths: [] }) },
    };
    const h = makeHarness({ kernel: noPaths });
    await expect(h.legs.start({ query: 'x', scope: 'sources' }, scope)).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
      message: expect.stringContaining('kojoPaths'),
    });
    expect(((await h.legs.list(scope)) as Record<string, unknown>)['total']).toBe(0);
  });

  it('scope:"sources" 用契约字段做根（本模块不认领域名词），maxResults 夹到壳层上限', async () => {
    const h = makeHarness();
    const view = await startSearch(h, { scope: 'sources', maxResults: 9999 });
    expect(h.slots[0]!.request.roots).toEqual([SOURCE_DIR]);
    expect(h.slots[0]!.request.options.maxResults).toBe(500);
    expect(view['request']).toMatchObject({ scope: 'sources', rootCount: 1, maxResults: 500 });
  });

  it('项目未开 / 内核缺席 ⇒ RESOURCE_UNAVAILABLE（不空串冒充）', async () => {
    const noProject: McpKernelLike = { ...fakeKernel(null), project: { current: () => null } };
    await expect(makeHarness({ kernel: noProject }).legs.start({ query: 'x' }, scope)).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
    });
    await expect(makeHarness({ kernel: null }).legs.start({ query: 'x' }, scope)).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
    });
  });

  it('检索腿抛错 ⇒ 行落到 failed + 错误码原样搬运（不吞错、不静默成功）', async () => {
    const h = makeHarness();
    const view = await startSearch(h);
    await h.fail(0, new Error('EIO: walk failed'));
    const st = await statusOf(h, view['taskId'] as string);
    expect(st['status']).toBe('failed');
    expect(st['error']).toMatchObject({ code: 'TOOL_EXECUTION_FAILED', message: 'EIO: walk failed' });
  });

  it('腿同步抛错（壳层直接拒）⇒ 同样落 failed，不留永久 running', async () => {
    const h = makeHarness();
    const throwing = createMcpTaskLegs({
      getKernel: () => fakeKernel(null),
      search: () => { throw new Error('no such thread'); },
      now: h.now,
    });
    const view = (await throwing.start({ query: 'x' }, scope)) as Record<string, unknown>;
    expect(view['status']).toBe('failed');
    expect(view['error']).toMatchObject({ message: 'no such thread' });
  });

  it('查询词回显有界（长串只留前缀 + 省略号，绝不整串常驻表里）', async () => {
    const h = makeHarness();
    const view = await startSearch(h, { query: 'q'.repeat(300) });
    const request = view['request'] as Record<string, unknown>;
    expect(String(request['query']).length).toBeLessThanOrEqual(121);
    expect(String(request['query'])).toContain('…');
    expect(h.slots[0]!.request.query).toHaveLength(300); // 送进壳层的仍是完整查询
  });
});

/* ================================================================== *
 * ④ 生命周期与有界性
 * ================================================================== */

describe('④ 在途上限 / 表行上限 / TTL 回收 / 会话隔离', () => {
  it('每会话在途上限：第 ' + (TASK_MAX_RUNNING_PER_SESSION + 1) + ' 条显式拒绝（不排队、不假装接受）', async () => {
    const h = makeHarness();
    for (let i = 0; i < TASK_MAX_RUNNING_PER_SESSION; i += 1) await startSearch(h, { query: `q${i}` });
    expect(h.slots).toHaveLength(TASK_MAX_RUNNING_PER_SESSION);
    await expect(h.legs.start({ query: 'too-many' }, scope)).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
      message: expect.stringContaining(String(TASK_MAX_RUNNING_PER_SESSION)),
    });
    // 收掉一条在途 ⇒ 立刻可以再登记（上限是在途数，不是累计数）
    await h.settle(0, searchResult(1));
    await expect(h.legs.start({ query: 'ok-again' }, scope)).resolves.toMatchObject({ status: 'running' });
  });

  it('已结束行过保留期 ⇒ 惰性回收，再查显式 RESOURCE_UNAVAILABLE（不空回帧）', async () => {
    const h = makeHarness();
    const view = await startSearch(h);
    await h.settle(0, searchResult(1));
    h.clock.t += TASK_RETENTION_MS + 1;
    await expect(h.legs.status({ taskId: view['taskId'] }, scope)).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
      message: expect.stringContaining('回收'),
    });
    const list = (await h.legs.list(scope)) as Record<string, unknown>;
    expect(list['total']).toBe(0);
  });

  it('表行数有界：只收已结束行 ⇒ 任一次入口读到的行数不超过 TASK_TABLE_MAX_ROWS', async () => {
    const h = makeHarness({ eagerResult: searchResult(1) });
    for (let i = 0; i < TASK_TABLE_MAX_ROWS + 4; i += 1) {
      await h.legs.start({ query: `q${i}` }, scope);
      await tick(); // 立即收口，行落到已结束（不占在途额度）
    }
    const list = (await h.legs.list(scope)) as Record<string, unknown>;
    expect((list['tasks'] as unknown[]).length).toBeLessThanOrEqual(TASK_TABLE_MAX_ROWS);
    expect(list['total']).toBeLessThanOrEqual(TASK_TABLE_MAX_ROWS);
    expect(h.calls.length).toBe(TASK_TABLE_MAX_ROWS + 4); // 真跑过壳层，不是没建成
    expect(((await h.legs.list(otherScope)) as Record<string, unknown>)['total']).toBe(0);
  });

  it('表满且全是不可回收的在途行 ⇒ 显式拒绝新任务（不挤掉在途、不排队）', async () => {
    const h = makeHarness();
    let accepted = 0;
    let overflow: Record<string, unknown> | null = null;
    for (let session = 0; session < 20 && overflow === null; session += 1) {
      const sc: McpSessionScope = { ...scope, sessionId: `cap-${session}` };
      for (let i = 0; i < TASK_MAX_RUNNING_PER_SESSION; i += 1) {
        try {
          await h.legs.start({ query: `q${session}-${i}` }, sc);
          accepted += 1;
        } catch (err) {
          overflow = err as Record<string, unknown>;
          break;
        }
      }
    }
    expect(accepted).toBeGreaterThanOrEqual(TASK_TABLE_MAX_ROWS);
    expect(overflow).not.toBeNull();
    expect(overflow?.['code']).toBe('RESOURCE_UNAVAILABLE');
    expect(String(overflow?.['message'])).toContain('满');
  });

  it('会话隔离：他人任务与不存在同形（RESOURCE_UNAVAILABLE），列表/资源都只见本会话', async () => {
    const h = makeHarness();
    const view = await startSearch(h);
    const taskId = view['taskId'] as string;
    await expect(h.legs.status({ taskId }, otherScope)).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    await expect(h.legs.cancel({ taskId }, otherScope)).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    await expect(h.legs.status({ taskId: 'tsk-nope-1' }, scope)).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    const mine = (await h.legs.list(scope)) as Record<string, unknown>;
    const theirs = (await h.legs.list(otherScope)) as Record<string, unknown>;
    expect(mine['total']).toBe(1);
    expect(theirs['total']).toBe(0);
    expect((mine['tasks'] as Record<string, unknown>[])[0]!['taskId']).toBe(taskId);
  });
});

/* ================================================================== *
 * ⑤ 校验类任务（进度不可知 + AbortSignal 取消 + 合流如实陈述）
 * ================================================================== */

describe('⑤ 校验任务：没有实时进度源就写「不可知」，取消以终态 incomplete 为事实', () => {
  interface RunSlot {
    resolve: (r: unknown) => void;
    reject: (e: unknown) => void;
    opts: { force?: boolean; signal?: AbortSignal } | undefined;
  }
  function linterHarness() {
    const runs: RunSlot[] = [];
    const linter: LinterStub = {
      run: (opts) => new Promise((resolve, reject) => runs.push({ resolve, reject, opts })),
      report: () => null,
    };
    const h = makeHarness({ linter });
    return { ...h, runs, linter };
  }

  it('在途读数：progress.known:false + done/total null + reason 逐条写明缺哪样（绝不 0%）', async () => {
    const h = linterHarness();
    const view = (await h.legs.start({ kind: 'validation' }, scope)) as Record<string, unknown>;
    expect(view['kind']).toBe('validation');
    expect(view['searchId']).toBeNull();
    const progress = progressOf(view);
    expect(progress['known']).toBe(false);
    expect(progress['phase']).toBe('not-reported');
    expect(progress['done']).toBeNull();
    expect(progress['total']).toBeNull();
    expect(progress['percent']).toBeNull();
    expect(progress['unit']).toBe('file-units');
    expect(String(progress['reason'])).toContain('incomplete');
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.opts?.force).toBe(false);
    expect(h.runs[0]!.opts?.signal).toBeInstanceOf(AbortSignal);
    expect(h.runs[0]!.opts?.signal?.aborted).toBe(false);
  });

  it('scope:"sources" 之类检索专用参数不污染校验任务的入参摘要', async () => {
    const h = linterHarness();
    const view = (await h.legs.start({ kind: 'validation', force: true }, scope)) as Record<string, unknown>;
    expect(view['request']).toEqual({ force: true });
    expect(h.runs[0]!.opts?.force).toBe(true);
  });

  it('cancel 置本任务 AbortSignal；终态带 incomplete ⇒ cancelled + cancelApplied:true + 事后读数', async () => {
    const h = linterHarness();
    const view = (await h.legs.start({ kind: 'validation' }, scope)) as Record<string, unknown>;
    const taskId = view['taskId'] as string;
    const out = (await h.legs.cancel({ taskId }, scope)) as Record<string, unknown>;
    expect(out['cancelApplied']).toBeNull();
    expect(out['note']).toContain('合流');
    expect(h.runs[0]!.opts?.signal?.aborted).toBe(true);

    h.runs[0]!.resolve({ issues: [1, 2], counts: { error: 1 }, ruleCount: 4, durationMs: 11, failedRules: [], incomplete: { unitsDone: 3, unitsTotal: 12 } });
    await tick();
    const st = await statusOf(h, taskId);
    expect(st['status']).toBe('cancelled');
    expect(st['cancelApplied']).toBe(true);
    expect(progressOf(st)['done']).toBe(3);
    expect(progressOf(st)['total']).toBe(12);
    const result = st['result'] as Record<string, unknown>;
    expect(result['incomplete']).toEqual({ unitsDone: 3, unitsTotal: 12 });
    expect(result['issuesTotal']).toBe(2);
    expect(String(result['note'])).toContain('没问题');
  });

  it('与界面在途轮合流（终态无 incomplete）⇒ succeeded + cancelApplied:false，不回「已取消」', async () => {
    const h = linterHarness();
    const view = (await h.legs.start({ kind: 'validation' }, scope)) as Record<string, unknown>;
    await h.legs.cancel({ taskId: view['taskId'] }, scope);
    h.runs[0]!.resolve({ issues: [], counts: {}, ruleCount: 4, durationMs: 9, failedRules: [] });
    await tick();
    const st = await statusOf(h, view['taskId'] as string);
    expect(st['status']).toBe('succeeded');
    expect(st['cancelRequested']).toBe(true);
    expect(st['cancelApplied']).toBe(false);
    expect(st['result']).toMatchObject({ issuesTotal: 0, truncated: false });
  });

  it('failedRules 样本有界：只留 TASK_FAILED_RULE_SAMPLE 条，条数另给且 truncated 有账', async () => {
    const h = linterHarness();
    const view = (await h.legs.start({ kind: 'validation' }, scope)) as Record<string, unknown>;
    h.runs[0]!.resolve({
      issues: [],
      failedRules: Array.from({ length: TASK_FAILED_RULE_SAMPLE + 7 }, (_, i) => ({ ruleId: `rule-${i}`, error: 'boom' })),
    });
    await tick();
    const result = (await statusOf(h, view['taskId'] as string))['result'] as Record<string, unknown>;
    expect(result['failedRules']).toHaveLength(TASK_FAILED_RULE_SAMPLE);
    expect(result['failedRulesTotal']).toBe(TASK_FAILED_RULE_SAMPLE + 7);
    expect(result['truncated']).toBe(true);
    expect((result['failedRules'] as Record<string, unknown>[])[0]).toEqual({ rule: 'rule-0', message: 'boom' });
  });

  it('run 抛错 ⇒ failed 且错误码原样搬运；linter 缺席 ⇒ start 即 NOT_WIRED（不建排队）', async () => {
    const h = linterHarness();
    const view = (await h.legs.start({ kind: 'validation' }, scope)) as Record<string, unknown>;
    h.runs[0]!.reject(new Error('rule crashed'));
    await tick();
    expect(await statusOf(h, view['taskId'] as string)).toMatchObject({ status: 'failed' });

    const bare = makeHarness({ linter: null });
    const bareScope: McpSessionScope = { ...scope, sessionId: 'bare', clientId: 'b' };
    await expect(bare.legs.start({ kind: 'validation' }, bareScope)).rejects.toMatchObject({
      code: 'NOT_WIRED',
      message: expect.stringContaining('convention.linter'),
    });
    expect(((await bare.legs.list(bareScope)) as Record<string, unknown>)['total']).toBe(0);

    const noRun = makeHarness({ linter: { report: () => ({ failedRules: [] }) } });
    await expect(noRun.legs.start({ kind: 'validation' }, scope)).rejects.toMatchObject({ code: 'NOT_WIRED' });

    await expect(h.legs.start({ kind: 'validation', force: 'yes' }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });
});

/* ================================================================== *
 * ⑥ kojo://tasks 轮询面 + io 分派 + 缺席兜底
 * ================================================================== */

describe('⑥ kojo://tasks 资源与 tasks.* 工具分派', () => {
  it('资源读回任务表：本会话行 + 有界账 + notIncluded[] 逐族写明缺席原因', async () => {
    const h = makeHarness();
    const view = await startSearch(h);
    const data = (await h.resources(KOJO_RESOURCE_URIS.tasks, scope)) as Record<string, unknown>;
    const tasks = data['tasks'] as Record<string, unknown>[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!['taskId']).toBe(view['taskId']);
    expect(tasks[0]!['kind']).toBe('search');
    expect(progressOf(tasks[0]!)['frames']).toBe(0);
    expect(data['scopeNote']).toContain('页面重载');
    expect(data['table']).toMatchObject({
      maxRunningPerSession: TASK_MAX_RUNNING_PER_SESSION,
      maxRows: TASK_TABLE_MAX_ROWS,
      retentionMs: TASK_RETENTION_MS,
      resultHitCap: TASK_RESULT_HIT_CAP,
    });
    const families = (data['notIncluded'] as Record<string, unknown>[]).map((n) => n['family']);
    expect(families).toEqual(expect.arrayContaining(['launcherTaskTable', 'indexBuild', 'export', 'inlineSearch']));
    for (const item of data['notIncluded'] as Record<string, unknown>[]) {
      expect(String(item['reason']).length).toBeGreaterThan(20); // 缺席必须说清缺什么（铁律 4）
      expect(['NOT_MERGED', 'NOT_WIRED', 'NOT_TRACKED']).toContain(item['status']);
    }
  });

  it('资源按会话隔离：scope 必须转发（他人读不到本会话的行）', async () => {
    const h = makeHarness();
    await startSearch(h);
    const theirs = (await h.resources(KOJO_RESOURCE_URIS.tasks, otherScope)) as Record<string, unknown>;
    expect(theirs['tasks']).toEqual([]);
    expect(theirs['truncated']).toBe(false);
  });

  it('列表态只带摘要不带整坨结果（有界性），status 才带 result 全量投影', async () => {
    const h = makeHarness();
    const view = await startSearch(h);
    await h.settle(0, searchResult(4));
    const listed = ((await h.resources(KOJO_RESOURCE_URIS.tasks, scope)) as Record<string, unknown>)['tasks'] as Record<string, unknown>[];
    expect(listed[0]!['result']).toBeUndefined();
    expect(listed[0]!['resultSummary']).toMatchObject({ total: 4, truncated: false, filesScanned: 7 });
    const full = await statusOf(h, view['taskId'] as string);
    expect((full['result'] as Record<string, unknown>)['hits']).toHaveLength(4);
  });

  it('宿主未注入长任务面 ⇒ 工具 NOT_WIRED、resource RESOURCE_UNAVAILABLE（不空表冒充）', async () => {
    const kernel = fakeKernel(null);
    const bare: McpIoDeps = {
      getKernel: () => kernel,
      getCommands: () => [],
      invoke: async () => null,
      searchInFiles: async () => EMPTY_RESULT,
    };
    const sup = createRunSupplemental(bare);
    for (const name of ['tasks.start', 'tasks.status', 'tasks.cancel']) {
      await expect(sup(name, { taskId: 'tsk-1', query: 'x' }, scope)).rejects.toMatchObject({
        code: 'NOT_WIRED',
        message: expect.stringContaining(name),
      });
    }
    await expect(createIoResourceData(bare, () => [], () => 0)(KOJO_RESOURCE_URIS.tasks, scope)).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
      message: expect.stringContaining('kojo://tasks'),
    });
  });

  it('经 createRunSupplemental 的 tasks.* 与直调腿同一条路径（同一张表）', async () => {
    const h = makeHarness();
    const started = (await h.sup('tasks.start', { query: 'hit' }, scope)) as Record<string, unknown>;
    expect(started['status']).toBe('running');
    const st = (await h.sup('tasks.status', { taskId: started['taskId'] }, scope)) as Record<string, unknown>;
    expect(st['taskId']).toBe(started['taskId']);
    expect(h.slots).toHaveLength(1);
    // 未登记进表面的名字（tasks.list 不是工具，列表只走 resource）仍走逐条兜底
    await expect(h.sup('tasks.list', {}, scope)).rejects.toMatchObject({ code: 'NOT_WIRED' });
  });
});

/* ================================================================== *
 * ⑦ 真 registry 的 tier 闸（契约面：start/cancel = edit，status = read）
 * ================================================================== */

describe('⑦ 真 createMcpCapabilityRegistry：tasks 面 tier 归类端到端', () => {
  it('只读会话：tools/list 只有 tasks.status；start/cancel 显式 PERMISSION_DENIED 且零执行', async () => {
    const h = makeHarness();
    const reg = createMcpCapabilityRegistry({ runSupplemental: h.sup });
    const listed = reg.listTools(readScope).map((t) => t.name);
    expect(listed).toContain('tasks.status');
    expect(listed).not.toContain('tasks.start');
    expect(listed).not.toContain('tasks.cancel');

    await expect(reg.callTool('tasks.start', { query: 'hit' }, readScope)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: expect.stringContaining('只读会话'),
    });
    await expect(reg.callTool('tasks.cancel', { taskId: 'tsk-x' }, readScope)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(h.slots).toHaveLength(0); // 闸先于一切执行腿
  });

  it('edit 会话：三枚都可见可调，read 会话随后仍能轮询同一张表（status 判 read 是对的）', async () => {
    const h = makeHarness({ cancelSearch: vi.fn(async () => undefined) });
    const reg = createMcpCapabilityRegistry({ runSupplemental: h.sup });
    const editListed = reg.listTools(scope).map((t) => t.name);
    expect(editListed).toEqual(expect.arrayContaining(['tasks.start', 'tasks.status', 'tasks.cancel']));

    const started = (await reg.callTool('tasks.start', { query: 'hit' }, scope)) as Record<string, unknown>;
    expect(started['status']).toBe('running');
    const poll = (await reg.callTool('tasks.status', { taskId: started['taskId'] }, readScope)) as Record<string, unknown>;
    expect(poll['taskId']).toBe(started['taskId']);
    expect(progressOf(poll)['phase']).toBe('waiting-first-frame');

    const cancelled = (await reg.callTool('tasks.cancel', { taskId: started['taskId'] }, scope)) as Record<string, unknown>;
    expect(cancelled['cancelRequested']).toBe(true);
    expect(cancelled['cancelApplied']).toBeNull(); // 请求已掷出，事实待终态
    await h.settle(0, searchResult(1, { cancelled: true }));
    expect(await reg.callTool('tasks.status', { taskId: started['taskId'] }, readScope)).toMatchObject({
      status: 'cancelled',
      cancelApplied: true,
    });
  });

  it('schema 闸：tasks.status 缺 taskId / kind 越枚举 ⇒ INVALID_ARGS（不落执行腿）', async () => {
    const h = makeHarness();
    const reg = createMcpCapabilityRegistry({ runSupplemental: h.sup });
    await expect(reg.callTool('tasks.status', {}, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(reg.callTool('tasks.start', { kind: 'export' }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(h.slots).toHaveLength(0);
  });
});
