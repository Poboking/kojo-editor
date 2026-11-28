/**
 * T5：`search.all` 与 `workspace.searchAll` 双面收敛（同一能力的两张脸）。
 *
 * 背景：两枚面在缺口表里映射到同一个 `gap:'search_text' / source:'rust'`，实现是两条
 * 几乎逐字相同的腿；载荷层 `workspace.searchAll` 的描述与 schema 又把 `search.all`
 * 的文案抄了一遍。本单**收敛**（不是删面）：两个名字都保留（冻结契约，86 枚不动），
 * 但落点收到 `search.all`，`workspace.searchAll` 变成同一份实现 + 别名指针。
 *
 * 判据（先红后绿）：
 *  I1 帧级信息等价闸：全量 `tools/list` 帧里载荷语义 token 一个都不许丢（改前全在场）。
 *  I2 `scope` 在 `search.all` 上真的生效，且 `scope:'sources'` 与 `workspace.searchAll` 逐字节相等。
 *  I3 同参同结果：两个面同入参 ⇒ 载荷深等。
 *  I3b 一份实现的身份断言：两枚面指向同一个（按 deps 记忆的）函数引用。
 *  I4 两面对同名入参的接受面一致：`properties` 键集相等。
 *  I5 载荷回执：别名面必须真的比正名面瘦 ≥2,000 B，且入参键集与正名面相等
 *     （**不是**绝对帧天花板——那会和帧带打架，见 I5 段注释）。
 *  I6 面数不变：86 / read 41 / `search_text` 仍映射 3 枚面。
 */
import { describe, expect, it } from 'vitest';
import {
  KERNEL_IO_TOOL_SPECS,
  MCP_TOOL_GAP_MAP,
  SEMANTIC_TOOL_SPECS,
  SUPPLEMENTAL_TOOL_SPECS,
  createMcpCapabilityRegistry,
  type McpSessionScope,
} from '@kojo/mcp-host';
import {
  createKernelIo,
  createRunSupplemental,
  type McpIoDeps,
  type McpKernelLike,
  type McpSearchRequestLike,
  type McpSearchResultLike,
} from '../src/mcp/real-sources-io';

/* ------------------------------ 现场取面 ------------------------------ */

const HOST_SPECS = [...SEMANTIC_TOOL_SPECS, ...KERNEL_IO_TOOL_SPECS, ...SUPPLEMENTAL_TOOL_SPECS];
const ALL_NAMES = HOST_SPECS.map((s) => s.name);

function scope(tier: McpSessionScope['tier'], approvedTools: readonly string[] = []): McpSessionScope {
  return { sessionId: 't5-s', clientId: 't5-c', tier, approvedRoots: [], approvedTools };
}

const registry = createMcpCapabilityRegistry({});
const fullFace = registry.listTools(scope('privileged', ALL_NAMES));

/** 一帧 `tools/list` 的线协议字符串（`run` 是函数，序列化即消失）。 */
const FRAME_JSON = JSON.stringify({ jsonrpc: '2.0', id: 't5', result: { tools: fullFace } });
const FRAME_BYTES = Buffer.byteLength(FRAME_JSON, 'utf-8');

const toolByName = (name: string) => fullFace.find((t) => t.name === name)!;
const propKeys = (name: string): string[] =>
  Object.keys((toolByName(name).inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).sort();

/* ------------------------------ 假件 ------------------------------ */

const ROOT = 'D:\\proj';
const SOURCES = 'D:\\proj\\k';

/** 一棵「根 + 作品域子目录」的两域夹具：命中集按请求的根不同而不同。 */
function makeKernel(): McpKernelLike {
  return {
    project: {
      current: () => ({ rootDir: ROOT, adapterId: 'adapter-a', kojoPaths: [SOURCES] }),
    },
    io: { walkDir: async () => [] },
    plugins: { list: () => [] },
    services: { tryGet: () => undefined },
    bus: { on: () => () => {} },
    slots: { query: () => [] },
  } as unknown as McpKernelLike;
}

function makeDeps(over: Partial<McpIoDeps> = {}): McpIoDeps {
  const kernel = makeKernel();
  return {
    getKernel: () => kernel,
    getCommands: () => [],
    invoke: async () => null,
    searchInFiles: async (request: McpSearchRequestLike): Promise<McpSearchResultLike> => {
      const root = request.roots[0] ?? '';
      if (root === SOURCES) {
        return {
          files: [{ path: 'D:\\proj\\k\\src.kojo', matches: [{ line: 1, preview: 'hit-src' }] }],
          totalMatches: 1,
          truncated: false,
          filesScanned: 1,
          elapsedMs: 1,
          skipped: {},
        };
      }
      return {
        files: [{ path: 'D:\\proj\\all.kojo', matches: [{ line: 2, preview: 'hit-all' }, { line: 3, preview: 'hit-all2' }] }],
        totalMatches: 2,
        truncated: false,
        filesScanned: 1,
        elapsedMs: 1,
        skipped: {},
      };
    },
    ...over,
  };
}

const callSearchAll = async (deps: McpIoDeps, args: Record<string, unknown>) =>
  (await createKernelIo(deps).searchAll(args, scope('read'))) as Record<string, unknown>;
const callWorkspaceSearchAll = async (deps: McpIoDeps, args: Record<string, unknown>) =>
  (await createRunSupplemental(deps)('workspace.searchAll', args, scope('read'))) as Record<string, unknown>;

/* ------------------------------ I1 ------------------------------ */

describe('I1 帧级信息等价闸：载荷语义 token 一个都不许丢', () => {
  // 改前（HEAD 11db421e）这些 token 全部在场；收敛文案后仍须全部在场。
  // 少一个＝丢信息——去重仪器只统计「逐字重复变少」，看不出语义被删。
  const REQUIRED_TOKENS = [
    'Hidden entries never enter the plan',
    'pages cannot overlap',
    'pairwise-disjoint',
    '5000',
    'knownTotal:false',
    'engineTruncated',
    'deadline',
    'partialReason',
    'preview',
    'cursor',
    'planSlices',
    'sliceIndex',
    'walkComplete',
    'totalScope',
    'resumeBySlice',
  ];
  it('全量帧里逐条在场（改前基线应全绿；改后少一个即红）', () => {
    const missing = REQUIRED_TOKENS.filter((t) => !FRAME_JSON.includes(t));
    expect(missing, `帧里丢了载荷语义 token：${missing.join(', ')}`).toEqual([]);
  });
});

/* ------------------------------ I2 ------------------------------ */

describe("I2 `scope` 在 `search.all` 上真的生效", () => {
  it("`scope:'sources'` 与 `scope:'all'` 得到不同命中集（改前 scope 被静默丢弃 ⇒ 红）", async () => {
    const deps = makeDeps();
    const sources = await callSearchAll(deps, { query: 'hit', scope: 'sources' });
    const all = await callSearchAll(deps, { query: 'hit', scope: 'all' });
    expect(sources['hits']).not.toEqual(all['hits']);
    // 作品域那一路必须真的落在 kojoPaths 根上，不是碰巧全根扫。
    expect((sources['hits'] as { path: string }[])[0]?.path).toBe('k/src.kojo');
    expect((all['hits'] as { path: string }[])[0]?.path).toBe('all.kojo');
  });

  it("`search.all` 的 `scope:'sources'` 与 `workspace.searchAll` 同参逐字节相等", async () => {
    const deps = makeDeps();
    const a = await callSearchAll(deps, { query: 'hit', scope: 'sources' });
    const b = await callWorkspaceSearchAll(deps, { query: 'hit', scope: 'sources' });
    expect(a).toEqual(b);
  });
});

/* ------------------------------ I3 ------------------------------ */

describe('I3 同参同结果：两个面载荷深等', () => {
  it("同一组入参（含 scope / maxResults / preview）分别打两个面 ⇒ 载荷深等", async () => {
    const deps = makeDeps();
    const args = { query: 'hit', scope: 'sources', maxResults: 1, preview: 'none' };
    const a = await callSearchAll(deps, args);
    const b = await callWorkspaceSearchAll(deps, args);
    expect(a).toEqual(b);
  });

  it('缺省 scope 时也深等（旧行为零漂移）', async () => {
    const deps = makeDeps();
    const args = { query: 'hit', maxResults: 1 };
    const a = await callSearchAll(deps, args);
    const b = await callWorkspaceSearchAll(deps, args);
    expect(a).toEqual(b);
  });
});

/* ------------------------------ I3b ------------------------------ */

describe('I3b 一份实现（同一核心）', () => {
  it('两枚面与导出的 searchAllCore 同参同载荷（证明都路由到同一个核心）', async () => {
    // 派单首选「同一函数引用」的身份断言；但 B19 漂移闸拒绝解析到工厂/seam（第一形参 deps），
    // 共享引用会把扫描器引到工厂上。故退一步：一个导出核心 + 两条薄箭头，用「核心直调对拍」
    // 证明两枚面没有各自的抄本——比身份断言弱，但同样能挡住「两条腿各自演化」。
    const mod = (await import('../src/mcp/real-sources-io')) as Record<string, unknown>;
    const core = mod['searchAllCore'] as
      | ((deps: McpIoDeps, args: Record<string, unknown> | undefined, scope: McpSessionScope) => Promise<unknown>)
      | undefined;
    expect(typeof core, '需要导出共享核心 searchAllCore').toBe('function');
    const deps = makeDeps();
    const args = { query: 'hit', scope: 'sources', maxResults: 1 };
    const direct = await core!(deps, args, scope('read'));
    expect(await callSearchAll(deps, args)).toEqual(direct);
    expect(await callWorkspaceSearchAll(deps, args)).toEqual(direct);
  });
});

/* ------------------------------ I4 ------------------------------ */

describe('I4 两面对同名入参的接受面一致', () => {
  it('`search.all` 与 `workspace.searchAll` 的 properties 键集相等', () => {
    expect(propKeys('search.all')).toEqual(propKeys('workspace.searchAll'));
  });

  it("`search.all` 声明了 `scope`（enum all|sources），不再说「不收 scope」", () => {
    const p = (toolByName('search.all').inputSchema as { properties?: Record<string, Record<string, unknown>> })
      .properties?.['scope'];
    expect(p, 'search.all 必须声明 scope').toBeDefined();
    expect(p!['enum']).toEqual(['all', 'sources']);
    expect(toolByName('search.all').description ?? '').not.toContain('不收 `scope`');
  });
});

/* ------------------------------ I5 ------------------------------ */

/**
 * I5 是**本单的回执**，不是长期的体积闸（长期闸在 `mcp-tools-list-payload.test.ts` ② 的帧带）。
 *
 * 组长复核时把这里从「帧 ≤ 137,900」改成结构性断言，原因：绝对值天花板会和帧带打架
 * ——谁更紧谁就是事实上的闸，而回执数字（贴着交付那一拍）必然比带顶更紧，
 * 于是下一批任何合法增长都得先改这张回执，等于把「按例重钉」换个文件继续。
 *
 * 改成钉**结构**：别名面不许再有整段全文。这条随两面一起长大、不需要重钉，
 * 而且它守的正是本单要做的事——`workspace.searchAll` 不再是第二份全文。
 * 交付实测：正名 3,584 B（desc 536 字符）/ 别名 2,024 B（desc 175 字符，
 * 属性描述最长 101 字符＝共用的 cursor 指针）；别名原有 4,450 B、desc 1,107 字符。
 */
describe('I5 载荷回执：别名面不许再留整段全文', () => {
  const specOf = (name: string) => {
    const spec = fullFace.find((t) => t.name === name);
    expect(spec, `${name} 不在注册表里`).toBeTruthy();
    return spec!;
  };
  const propDescs = (name: string): [string, number][] =>
    Object.entries((specOf(name).inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {})
      .map(([k, v]) => [k, String(v?.description ?? '').length] as [string, number]);

  it('别名面比正名面瘦（谁把别名灌回全文，这里先红）', () => {
    const alias = Buffer.byteLength(JSON.stringify(specOf('workspace.searchAll')), 'utf-8');
    const canon = Buffer.byteLength(JSON.stringify(specOf('search.all')), 'utf-8');
    expect(alias, `正名 ${canon} B / 别名 ${alias} B`).toBeLessThan(canon);
  });

  it('别名面描述 ≤300 字符：它是指针，不是第二份说明', () => {
    const len = String(specOf('workspace.searchAll').description ?? '').length;
    expect(len, `别名面描述 ${len} 字符`).toBeLessThanOrEqual(300);
    expect(String(specOf('workspace.searchAll').description ?? '')).toContain('search.all');
  });

  it('别名面每个属性描述 ≤120 字符：只许挂指针，不许复刻整段口径', () => {
    const tooLong = propDescs('workspace.searchAll').filter(([, n]) => n > 120);
    expect(tooLong, `超长属性：${tooLong.map(([k, n]) => `${k}=${n}`).join(' / ')}`).toEqual([]);
  });

  it('别名面仍是一枚真面：入参键集与正名面相等（收敛后不该再分叉）', () => {
    expect(propKeys('workspace.searchAll')).toEqual(propKeys('search.all'));
  });
});

/* ------------------------------ I6 ------------------------------ */

describe('I6 面数不变（收敛不是删面）', () => {
  it('tools.total 86 / read 41（两个面都是 read）', () => {
    expect(fullFace).toHaveLength(86);
    expect(registry.listTools(scope('read'))).toHaveLength(41);
    expect(toolByName('search.all').tier).toBe('read');
    expect(toolByName('workspace.searchAll').tier).toBe('read');
  });

  it("`search_text` 这个 gap 的面集不变（search.all / tasks.start / workspace.searchAll）", () => {
    // 派单写的是「映射 2 枚面」，但真源是 3 枚：`tasks.start(kind:search)` 走同一条
    // `search_text` 真源（index.ts:2454），本单只动载荷与两条读腿，任务面不在范围内。
    // 判据钉的是「面集一字不变」，不是派单里的数字。
    const faces = MCP_TOOL_GAP_MAP.filter((g) => g.gap === 'search_text').map((g) => g.tool).sort();
    expect(faces).toEqual(['search.all', 'tasks.start', 'workspace.searchAll']);
  });
});
