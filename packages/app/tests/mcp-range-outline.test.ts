/**
 * MCP-PERF-S4（LaneK，2026-11-07）· 范围读与结构读两枚 read 面
 *
 * TRAE 性能分析 P1 原文落地：「范围读/结构读：read_range（行区间）＋outline（函数列表）
 * 必须先有，否则 agent 只能整文件读 5 万行」。两枚新面：
 *
 *  1. `fs.readRange` —— 行区间读（1 基行号，与 Monaco position 同口径）。
 *     入参 relPath + startLine + endLine（单批 ≤2000 行）+ 可选 rootId；
 *     relPath 与 fs.readFile 同一条 resolveWithinRoot 闸（根内相对路径），可选 rootId 与
 *     写腿同一条 resolveWriteRoot 三道拦截（缺席 ⇒ 项目根零额外 IPC；给了 ⇒ 形状闸 +
 *     第四张表精确列名 + workspace_roots 反查，默认拒绝一字不变）。行号→内容走
 *     fs.readFile 同一条 read_file_bytes 通道；越界与 start>end 的账照 paginateText
 *     既有语义：越界夹取 + truncated 可见、start>end INVALID_ARGS 点名——不发明新账。
 *
 *  2. `semantic.projectSymbols` —— 全项目函数清单，走 erb-parser 既有 byName 索引
 *     （99,975 函数单扫 3.88ms 的那份），paginateByCursor 分页（游标形态
 *     `^[0-9a-f]{8}:\d{1,10}$`），**无编辑器依赖**。
 *
 * 侦察结论（落点依据，2026-11-07 现取）：`semantic.documentSymbols` 的腿
 * （real-sources.ts buildSemanticReaders.documentSymbols）走 `requireWorkspace(deps)` +
 * documentSymbolProvider 注册表 —— 依赖**打开的编辑器 / Monaco**，抬不成 project 范围
 * ⇒ 新面直连索引服务：`kernel.services.tryGet('erb.parser')` 的 `currentIndex() /
 * ensureIndex()`（与 ui/editor-global-providers.ts:335 的宿主软取同一条键），零插件
 * import（结构类型投影，ps10 开机静态图零新增边）。
 *
 * 判据先红：两枚面未进 SUPPLEMENTAL_TOOL_SPECS ⇒ 注册表查不到、runSupplemental 落
 * NOT_WIRED 兜底；落地后本文件转绿。全程假注入，零 GUI / 零 Tauri / 零 HTTP。
 */
import { describe, expect, it } from 'vitest';
import {
  McpFailure,
  SUPPLEMENTAL_TOOL_SPECS,
  createMcpCapabilityRegistry,
  type McpSessionScope,
} from '@kojo/mcp-host';
import {
  createRunSupplemental,
  type McpIoDeps,
  type McpInvokeLike,
  type McpKernelLike,
} from '../src/mcp/real-sources-io';
import type { CommandEntry } from '../src/ui/commands';

/* ------------------------------- 现场取面 ------------------------------- */

const scope: McpSessionScope = {
  sessionId: 'laneK-s',
  clientId: 'laneK-c',
  tier: 'read',
  approvedRoots: ['D:\\proj'],
  approvedTools: [],
};

const specByName = new Map(SUPPLEMENTAL_TOOL_SPECS.map((s) => [s.name, s]));

/* ------------------------------- 假件 ------------------------------- */

interface FakeParserService {
  readonly currentIndex?: () => unknown;
  readonly ensureIndex?: () => Promise<unknown>;
  readonly indexState?: () => unknown;
}

function fakeKernel(opts: {
  readonly rootDir?: string;
  readonly invoke?: McpInvokeLike;
  readonly parser?: FakeParserService;
}): McpKernelLike {
  return {
    project: {
      current: () =>
        opts.rootDir === null ? null : { rootDir: opts.rootDir ?? 'D:\\proj', adapterId: 'a' },
    },
    io: {},
    plugins: { list: () => [] },
    services: {
      tryGet: <T = unknown>(key: string) =>
        (key === 'erb.parser' ? (opts.parser as T | undefined) : undefined) as T | undefined,
    },
    bus: { on: () => () => {} },
  } as unknown as McpKernelLike;
}

function fakeIoDeps(kernel: McpKernelLike | null, invoke: McpInvokeLike = async () => null): McpIoDeps {
  const commands: CommandEntry[] = [];
  return {
    getKernel: () => kernel,
    getCommands: () => commands,
    invoke,
    searchInFiles: async () => ({
      files: [],
      totalMatches: 0,
      truncated: false,
      filesScanned: 0,
      elapsedMs: 0,
      skipped: {},
    }),
  };
}

const CODE = (err: unknown): string => (err instanceof McpFailure ? err.code : String((err as { code?: unknown })?.code ?? ''));

/** byName 索引假件（ErbFunctionLookup.forEachDef 的最小投影）。 */
function fakeLookup(defs: readonly Record<string, unknown>[]): { forEachDef: (cb: (ref: Record<string, unknown>, name: string) => void) => void } {
  return {
    forEachDef: (cb) => {
      for (const [i, def] of defs.entries()) cb(def, String(def['normalizedName'] ?? def['name'] ?? `#${i}`));
    },
  };
}

/* ------------------------------- ① 注册表可见性 ------------------------------- */

describe('MCP-PERF-S4 ① 两枚新面进注册表（起手红：面不在册）', () => {
  it('fs.readRange / semantic.projectSymbols 在 SUPPLEMENTAL_TOOL_SPECS 在册，均为 read 档 + 只读提示', () => {
    for (const name of ['fs.readRange', 'semantic.projectSymbols']) {
      const spec = specByName.get(name);
      expect(spec, `${name} 必须进 SUPPLEMENTAL_TOOL_SPECS（TRAE P1：范围读/结构读必须先有）`).toBeDefined();
      expect(spec!.tier, `${name} 是纯读面`).toBe('read');
      expect(spec!.annotations?.readOnlyHint, `${name} 必须带 readOnlyHint`).toBe(true);
    }
  });

  it('registry.listTools 对 read 会话可见（零批准、默认可见面即含两枚）', () => {
    const reg = createMcpCapabilityRegistry({});
    const names = reg.listTools(scope).map((t) => t.name);
    expect(names).toContain('fs.readRange');
    expect(names).toContain('semantic.projectSymbols');
  });

  it('两枚面 inputSchema 严格（additionalProperties:false）且必填项点名', () => {
    const rangeSchema = specByName.get('fs.readRange')!.inputSchema as Record<string, unknown>;
    expect(rangeSchema['additionalProperties']).toBe(false);
    expect(rangeSchema['required']).toEqual(['relPath', 'startLine', 'endLine']);
    const props = rangeSchema['properties'] as Record<string, unknown>;
    for (const key of ['relPath', 'startLine', 'endLine', 'rootId']) {
      expect(props, `fs.readRange 缺入参 ${key}`).toHaveProperty(key);
    }
    const symSchema = specByName.get('semantic.projectSymbols')!.inputSchema as Record<string, unknown>;
    expect(symSchema['additionalProperties']).toBe(false);
    expect(symSchema['required'], 'projectSymbols 零参调用＝第一页，不设必填').toBeUndefined();
  });
});

/* ------------------------------- ② fs.readRange 腿 ------------------------------- */

describe('MCP-PERF-S4 ② fs.readRange 腿（1 基行区间；越界夹取 + truncated 可见）', () => {
  const run = async (args: Record<string, unknown>, over: Partial<McpIoDeps> = {}): Promise<unknown> => {
    const kernel = fakeKernel({
      invoke: (over.invoke as McpInvokeLike | undefined) ?? (async () => 'alpha\nbeta\ngamma'),
    });
    return createRunSupplemental({ ...fakeIoDeps(kernel), ...over })(name(args), args, scope);
    function name(_a: Record<string, unknown>): string {
      return 'fs.readRange';
    }
  };

  it('happy path：2..3 行 → 恰两行 {line,text}，totalLines=3，truncated:false，走 read_file_bytes 同一条通道', async () => {
    const calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];
    const out = (await run(
      { relPath: 'a.erb', startLine: 2, endLine: 3 },
      {
        invoke: async (cmd, a) => {
          calls.push({ cmd, args: a });
          return 'alpha\nbeta\ngamma';
        },
      },
    )) as Record<string, unknown>;
    expect(calls).toEqual([{ cmd: 'read_file_bytes', args: { path: 'D:\\proj\\a.erb' } }]);
    expect(out['lines']).toEqual([
      { line: 2, text: 'beta' },
      { line: 3, text: 'gamma' },
    ]);
    expect(out['startLine']).toBe(2);
    expect(out['endLine']).toBe(3);
    expect(out['totalLines']).toBe(3);
    expect(out['truncated']).toBe(false);
    expect(out['hasMore']).toBe(false);
    expect(out['path']).toBe('a.erb');
  });

  it('CRLF 同口径：\\r\\n 不留尾 \\r，与 Monaco 行号一致', async () => {
    const out = (await run({
      relPath: 'a.erb',
      startLine: 1,
      endLine: 2,
    })) as Record<string, unknown>;
    void out;
    const out2 = (await run(
      { relPath: 'a.erb', startLine: 1, endLine: 2 },
      { invoke: async () => 'one\r\ntwo\r\nthree' },
    )) as Record<string, unknown>;
    expect(out2['lines']).toEqual([
      { line: 1, text: 'one' },
      { line: 2, text: 'two' },
    ]);
    expect(out2['totalLines']).toBe(3);
  });

  it('endLine 越界（读到 EOF）⇒ 夹到文件尾，truncated:true 可见（照 paginateText 裸窗口夹取语义）', async () => {
    const out = (await run(
      { relPath: 'a.erb', startLine: 2, endLine: 99 },
      { invoke: async () => 'alpha\nbeta\ngamma' },
    )) as Record<string, unknown>;
    expect(out['lines']).toEqual([{ line: 2, text: 'beta' }, { line: 3, text: 'gamma' }]);
    expect(out['endLine']).toBe(3);
    expect(out['truncated']).toBe(true);
    expect(out['hasMore']).toBe(false);
    expect(out['requested']).toEqual({ startLine: 2, endLine: 99 });
  });

  it('单批上限 2000 行：超限夹取 endLine，truncated + hasMore:true，续取起点可见', async () => {
    const big = Array.from({ length: 3000 }, (_v, i) => `L${i + 1}`).join('\n');
    const out = (await run(
      { relPath: 'big.erb', startLine: 1, endLine: 3000 },
      { invoke: async () => big },
    )) as Record<string, unknown>;
    expect(out['lineCount']).toBe(2000);
    expect(out['endLine']).toBe(2000);
    expect(out['truncated']).toBe(true);
    expect(out['hasMore']).toBe(true);
    expect((out['lines'] as unknown[]).length).toBe(2000);
  });

  it('start > end ⇒ INVALID_ARGS 点名（照 paginateText 游标越界的出声口径，不静默换向）', async () => {
    const err = await run({ relPath: 'a.erb', startLine: 3, endLine: 2 }).catch((e) => e);
    expect(CODE(err)).toBe('INVALID_ARGS');
    expect((err as Error).message).toContain('startLine');
    expect((err as Error).message).toContain('endLine');
  });

  it('非正整数行号 ⇒ INVALID_ARGS（0 基被拒＝1 基钉死）', async () => {
    for (const bad of [0, -1, 1.5, '2']) {
      const err = await run({ relPath: 'a.erb', startLine: bad, endLine: 2 }).catch((e) => e);
      expect(CODE(err), `startLine=${String(bad)}`).toBe('INVALID_ARGS');
    }
  });

  it('路径逃逸（.. / 盘符 / 绝对路径）⇒ INVALID_ARGS，invoke 绝不触达（与 fs.readFile 同一条闸）', async () => {
    const calls: unknown[] = [];
    for (const rel of ['../x.erb', 'C:/x.erb', '/x.erb']) {
      const err = await run(
        { relPath: rel, startLine: 1, endLine: 2 },
        { invoke: (async (cmd: string, a: unknown) => { calls.push([cmd, a]); return 'x'; }) as McpInvokeLike },
      ).catch((e) => e);
      expect(CODE(err), rel).toBe('INVALID_ARGS');
    }
    expect(calls).toEqual([]);
  });

  it('可选 rootId：缺席 ⇒ 项目根零额外行为；未获第四张表批准 ⇒ PERMISSION_DENIED（默认拒绝一字不变）', async () => {
    const ok = await run({ relPath: 'a.erb', startLine: 1, endLine: 1 });
    expect((ok as Record<string, unknown>)['rootId']).toBeUndefined();

    const err = await run({ relPath: 'a.erb', startLine: 1, endLine: 1, rootId: 'ws:1a2b3c4d' }).catch((e) => e);
    expect(CODE(err)).toBe('PERMISSION_DENIED');
    expect((err as Error).message).toContain('approvedRootIds');
  });

  it('项目未打开 ⇒ RESOURCE_UNAVAILABLE（不静默、不空串冒充）', async () => {
    const kernel = fakeKernel({ rootDir: '', invoke: async () => 'x' });
    const err = createRunSupplemental(fakeIoDeps(kernel))('fs.readRange', { relPath: 'a.erb', startLine: 1, endLine: 1 }, scope).catch((e) => e);
    void err;
    const out = await createRunSupplemental(fakeIoDeps(fakeKernel({ rootDir: null })))(
      'fs.readRange',
      { relPath: 'a.erb', startLine: 1, endLine: 1 },
      scope,
    ).catch((e) => e);
    expect(CODE(out)).toBe('RESOURCE_UNAVAILABLE');
  });
});

/* ------------------------------- ③ semantic.projectSymbols 腿 ------------------------------- */

describe('MCP-PERF-S4 ③ semantic.projectSymbols 腿（直连 erb.parser 索引；无编辑器依赖）', () => {
  const DEFS = [
    { name: 'FOO', normalizedName: 'FOO', filePath: 'D:\\proj\\foo.erb', startLine: 10, endLine: 20 },
    { name: 'BAR', normalizedName: 'BAR', filePath: 'D:\\proj\\sub\\bar.erb', startLine: 1, endLine: 5 },
    { name: 'BAZ', normalizedName: 'BAZ', filePath: 'D:\\proj\\baz.erb', startLine: 100, endLine: 200, nameColumn: 3 },
  ];

  const runSym = async (
    args: Record<string, unknown>,
    opts: { readonly parser?: FakeParserService; readonly scope?: McpSessionScope } = {},
  ): Promise<unknown> => {
    const kernel = fakeKernel({ parser: opts.parser });
    return createRunSupplemental(fakeIoDeps(kernel))(
      'semantic.projectSymbols',
      args,
      opts.scope ?? scope,
    );
  };

  const readyParser = (defs: readonly Record<string, unknown>[] = DEFS): FakeParserService => ({
    currentIndex: () => ({ byName: fakeLookup(defs) }),
    indexState: () => ({ phase: 'ready', coverage: 'full', filesScanned: 3, functions: defs.length }),
  });

  it('happy path：索引摊平成 {name,path,startLine,endLine}，路径相对化，nameColumn 缺席不带假 1', async () => {
    const out = (await runSym({}, { parser: readyParser() })) as Record<string, unknown>;
    expect(out['items']).toEqual([
      { name: 'FOO', path: 'foo.erb', startLine: 10, endLine: 20 },
      { name: 'BAR', path: 'sub/bar.erb', startLine: 1, endLine: 5 },
      { name: 'BAZ', path: 'baz.erb', startLine: 100, endLine: 200, nameColumn: 3 },
    ]);
    expect(out['total']).toBe(3);
    expect(out['truncated']).toBe(false);
    expect(out['index']).toEqual({ phase: 'ready', coverage: 'full', filesScanned: 3, functions: 3 });
  });

  it('分页：limit+cursor 走 paginateByCursor（游标形态 ^[0-9a-f]{8}:\\d{1,10}$），翻页可完整枚举', async () => {
    const first = (await runSym({ limit: 2 }, { parser: readyParser() })) as Record<string, unknown>;
    expect((first['items'] as unknown[]).length).toBe(2);
    expect(first['hasMore']).toBe(true);
    expect(first['nextCursor']).toMatch(/^[0-9a-f]{8}:\d{1,10}$/);
    const second = (await runSym(
      { limit: 2, cursor: first['nextCursor'] },
      { parser: readyParser() },
    )) as Record<string, unknown>;
    expect((second['items'] as unknown[]).length).toBe(1);
    expect(second['hasMore']).toBe(false);
    expect(second['nextCursor']).toBeNull();
  });

  it('索引换代 ⇒ changedDuringPaging:true + 新快照第 0 页（绝不盲切旧下标）', async () => {
    const first = (await runSym({ limit: 2 }, { parser: readyParser() })) as Record<string, unknown>;
    const changedParser = readyParser([...DEFS, { name: 'NEW', normalizedName: 'NEW', filePath: 'D:\\proj\\n.erb', startLine: 1, endLine: 2 }]);
    const second = (await runSym(
      { limit: 2, cursor: first['nextCursor'] },
      { parser: changedParser },
    )) as Record<string, unknown>;
    expect(second['changedDuringPaging']).toBe(true);
    expect(second['offset']).toBe(0);
  });

  it('erb.parser 服务缺席 ⇒ NOT_WIRED 点名（插件未装配可见，不静默、不伪造空清单）', async () => {
    const err = await runSym({}).catch((e) => e);
    expect(CODE(err)).toBe('NOT_WIRED');
    expect((err as Error).message).toContain('erb.parser');
  });

  it('服务在而索引未就绪（无项目 / 构建未产出）⇒ RESOURCE_UNAVAILABLE，不冒充空清单', async () => {
    const err = await runSym({}, { parser: { currentIndex: () => null } }).catch((e) => e);
    expect(CODE(err)).toBe('RESOURCE_UNAVAILABLE');
  });

  it('cursor 形状非法 ⇒ INVALID_ARGS（绝不静默当第一页）', async () => {
    const err = await runSym({ cursor: 'not-a-cursor' }, { parser: readyParser() }).catch((e) => e);
    expect(CODE(err)).toBe('INVALID_ARGS');
  });
});
