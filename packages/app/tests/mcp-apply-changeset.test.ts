/**
 * fileTree.applyChangeset 批量变更事务单测（MCP-PERF-S3，2026-11-06）。
 *
 * 钉三件事：
 *  1. 一批写 → 一份备份清单 / 逐条 applied/refused 可见（refused 不抛整个批次）；
 *  2. 批次级缺陷（超 32 项、批内重复路径、rootId 未批准、形状坏）在任何写发生之前整批拒；
 *  3. 每项语义与 fileTree.update 逐字同尺（update 语义 / preserve 缺省 / 双闸不绕）。
 *
 * 量化判据（20 文件批次端到端 <300ms，真实 Node fs 桥）在
 * `mcp-apply-changeset.perf.test.ts`（计时用例按仓库机制进串行静默池）。
 * 全程假注入（fake kernel / invoke / Node fs 桥），不起 GUI、不起 Tauri、不起 HTTP。
 */
import { describe, expect, it, vi } from 'vitest';
import { McpFailure, type McpSessionScope } from '@kojo/mcp-host';
import {
  createRunSupplemental,
  type McpInvokeLike,
  type McpIoDeps,
  type McpKernelLike,
} from '../src/mcp/real-sources-io';
import { rootIdOf } from '../src/mcp/workspace-root-id';

const writeScope: McpSessionScope = {
  sessionId: 'cs-s',
  clientId: 'cs-c',
  tier: 'edit',
  approvedRoots: ['docs'],
  approvedTools: [],
};

interface Overrides {
  readonly exists?: (path: string) => Promise<boolean>;
  readonly backup?: (path: string) => Promise<string | null>;
  readonly writeText?: (path: string, text: string, opts?: Record<string, unknown>) => Promise<void>;
  readonly busEmit?: (name: string, payload: unknown) => void;
}

function fakeKernel(over: Overrides = {}): { kernel: McpKernelLike; events: { kind: string; path: string }[] } {
  const events: { kind: string; path: string }[] = [];
  const kernel: McpKernelLike = {
    project: { current: () => ({ rootDir: 'D:/proj', adapterId: 'adapter-a', kojoPaths: [], charaIndex: new Map() }) },
    io: {
      walkDir: async () => [],
      exists: over.exists ?? (async () => true),
      // 缺省给一条可用的 backup 假件（writeText 同在 ⇒ 批量腿可跑）；NOT_WIRED 用例
      // 靠「不给 writeText」触发，message 仍含 backup。要验 null 竞态就显式覆写。
      backup: over.backup ?? (async (p: string) => `${p}.bak`),
      ...(over.writeText ? { writeText: over.writeText } : {}),
    },
    plugins: { list: () => [] },
    services: { tryGet: () => undefined },
    bus: {
      on: () => () => {},
      emit: (name, payload) => {
        const p = payload as { kind: string; path: string };
        events.push({ kind: p.kind, path: p.path });
        if (over.busEmit) over.busEmit(name, payload);
      },
    },
    slots: { query: () => [] },
  };
  return { kernel, events };
}

/** stat_files 假读数：按入参顺序逐项回 size（与 fs.statFiles 腿同口径的索引对应）。 */
function statFilesInvoke(sizes: Map<string, number>): McpInvokeLike {
  return (async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'stat_files' && args && Array.isArray(args['paths'])) {
      return (args['paths'] as string[]).map((p) => ({
        path: p,
        exists: sizes.has(p),
        size: sizes.get(p) ?? null,
        mtimeMs: null,
      }));
    }
    return null;
  }) as McpInvokeLike;
}

function fakeIoDeps(kernel: McpKernelLike | null, over: Partial<McpIoDeps> = {}): McpIoDeps {
  return {
    getKernel: () => kernel,
    getCommands: () => [],
    invoke: (async () => null) as McpInvokeLike,
    ...over,
  } as McpIoDeps;
}

const sup = (kernel: McpKernelLike, over: Partial<McpIoDeps> = {}) => createRunSupplemental(fakeIoDeps(kernel, over));

const change = (path: string, content: string) => ({ path, content });

/* ------------------------------- ① 一批写 → 逐条回执 ------------------------------- */

describe('fileTree.applyChangeset：一批写 → 一份清单 / 逐条 applied/refused', () => {
  it('20 文件全 applied：逐条回执（path/backupPath/bytes/contentChars/refreshed）+ 一份 manifest + totals', async () => {
    const backupSpy = vi.fn(async (p: string) => `${p}.bak`);
    const writeSpy = vi.fn(async (_p: string, _text: string, _opts?: Record<string, unknown>) => undefined);
    const { kernel, events } = fakeKernel({ backup: backupSpy, writeText: writeSpy });
    const sizes = new Map<string, number>([
      ['D:/proj/docs/f0.txt', 30],
      ['D:/proj/docs/f19.txt', 39],
    ]);
    const s = sup(kernel, { invoke: statFilesInvoke(sizes) });
    const changes = Array.from({ length: 20 }, (_, i) => change(`docs/f${i}.txt`, `body-${i}\n`));
    const out = (await s('fileTree.applyChangeset', { changes }, writeScope)) as Record<string, unknown>;

    expect(out['refused']).toEqual([]);
    const applied = out['applied'] as Record<string, unknown>[];
    expect(applied).toHaveLength(20);
    for (let i = 0; i < 20; i += 1) {
      expect(applied[i]).toMatchObject({
        path: `docs/f${i}.txt`,
        backupPath: `D:/proj/docs/f${i}.txt.bak`,
        refreshed: true,
        contentChars: `body-${i}\n`.length,
      });
    }
    expect(applied[0]!['bytes']).toBe(30); // 真实批量 stat 读数（不按 contentChars 编造）
    expect(applied[19]!['bytes']).toBe(39);
    expect(writeSpy).toHaveBeenCalledTimes(20);
    expect(writeSpy.mock.calls.every((c) => (c[2] as Record<string, unknown>)['backup'] === false)).toBe(true);
    const manifest = out['manifest'] as Record<string, unknown>;
    expect(manifest['backups']).toHaveLength(20); // 一次批次一份清单
    expect(typeof manifest['takenAtMs']).toBe('number');
    expect(out['totals']).toEqual({ total: 20, applied: 20, refused: 0, backups: 20 });
    expect(events).toHaveLength(20); // 逐文件 file.changed（宿主防抖合并成一轮失效/诊断）
    expect(events.every((e) => e.kind === 'change')).toBe(true);
    expect(backupSpy).toHaveBeenCalledTimes(20);
  });

  it('部分失败逐条可见：2 个不存在文件 refused（带 code/message），其余 applied 照常', async () => {
    const writeSpy = vi.fn(async () => undefined);
    const exists = async (p: string) => !p.includes('ghost');
    const { kernel } = fakeKernel({ exists, writeText: writeSpy });
    const s = sup(kernel, { invoke: statFilesInvoke(new Map()) });
    const out = (await s('fileTree.applyChangeset', {
      changes: [change('docs/a.txt', 'a'), change('docs/ghost1.txt', 'x'), change('docs/b.txt', 'b'), change('docs/ghost2.txt', 'y')],
    }, writeScope)) as Record<string, unknown>;

    expect((out['applied'] as unknown[]).map((a) => (a as Record<string, unknown>)['path'])).toEqual(['docs/a.txt', 'docs/b.txt']);
    const refused = out['refused'] as Record<string, unknown>[];
    expect(refused.map((r) => r['path'])).toEqual(['docs/ghost1.txt', 'docs/ghost2.txt']);
    for (const r of refused) {
      expect(r['code']).toBe('TOOL_EXECUTION_FAILED');
      expect(String(r['message'])).toContain('不存在');
    }
    expect(out['totals']).toEqual({ total: 4, applied: 2, refused: 2, backups: 2 });
    expect(writeSpy).toHaveBeenCalledTimes(2); // refused 条目零写触达
  });

  it('写闸一逐条拒：域外路径 refused（WRITE_DISABLED），域内条目照常 applied', async () => {
    const writeSpy = vi.fn(async () => undefined);
    const { kernel } = fakeKernel({ writeText: writeSpy });
    const s = sup(kernel);
    const out = (await s('fileTree.applyChangeset', {
      changes: [change('docs/in.txt', 'a'), change('outside/out.txt', 'b')],
    }, writeScope)) as Record<string, unknown>;
    expect((out['applied'] as unknown[]).map((a) => (a as Record<string, unknown>)['path'])).toEqual(['docs/in.txt']);
    expect(out['refused']).toEqual([
      expect.objectContaining({ path: 'outside/out.txt', code: 'WRITE_DISABLED', message: expect.stringContaining('approvedRoots') }),
    ]);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('写闸二逐条拒：WriteNotAllowedError ⇒ WRITE_DISABLED refused，批次继续不中断', async () => {
    const frozen = new Set(['D:/proj/docs/frozen.txt']);
    const writeText = async (p: string): Promise<void> => {
      if (frozen.has(p)) {
        const err = new Error('这个位置在只读范围内，不能写入（要写就先批准该目录）。');
        err.name = 'WriteNotAllowedError';
        throw err;
      }
    };
    const { kernel } = fakeKernel({ writeText });
    const s = sup(kernel);
    const out = (await s('fileTree.applyChangeset', {
      changes: [change('docs/frozen.txt', 'a'), change('docs/ok.txt', 'b')],
    }, writeScope)) as Record<string, unknown>;
    expect((out['applied'] as unknown[]).map((a) => (a as Record<string, unknown>)['path'])).toEqual(['docs/ok.txt']);
    expect(out['refused']).toEqual([expect.objectContaining({ path: 'docs/frozen.txt', code: 'WRITE_DISABLED' })]);
  });

  it('缺省语义与单写一致：writeText 只收 {backup:false}（preserve 交给内核探测），显式 encoding/eol 逐项透传', async () => {
    const writeSpy = vi.fn(async (_p: string, _text: string, _opts?: Record<string, unknown>) => undefined);
    const { kernel } = fakeKernel({ writeText: writeSpy });
    const s = sup(kernel);
    await s('fileTree.applyChangeset', {
      changes: [change('docs/a.txt', 'a'), { path: 'docs/b.txt', content: 'b', encoding: 'shift_jis', eol: 'crlf' }],
    }, writeScope);
    expect(writeSpy.mock.calls[0]![2]).toEqual({ backup: false });
    expect(writeSpy.mock.calls[1]![2]).toEqual({ backup: false, encoding: 'shift_jis', eol: 'crlf' });
  });

  it('backup 返回 null（备份时盘上已无此文件的竞态）⇒ manifest 如实 backupPath:null，applied 不编造路径', async () => {
    const { kernel } = fakeKernel({ backup: async () => null, writeText: async () => undefined });
    const s = sup(kernel, { invoke: statFilesInvoke(new Map()) });
    const out = (await s('fileTree.applyChangeset', { changes: [change('docs/a.txt', 'a')] }, writeScope)) as Record<string, unknown>;
    const manifest = out['manifest'] as Record<string, unknown>;
    expect(manifest['backups']).toEqual([{ path: 'docs/a.txt', backupPath: null }]);
    expect((out['applied'] as Record<string, unknown>[])[0]).not.toHaveProperty('backupPath');
    expect((out['applied'] as Record<string, unknown>[])[0]!['bytes']).toBeNull(); // stat 假件缺席 ⇒ 如实 null
  });

  it('stat_files 批量读失败 ⇒ bytes 全体 null（不冒充 0，不阻塞回执）', async () => {
    const { kernel } = fakeKernel({ backup: async (p) => `${p}.bak`, writeText: async () => undefined });
    const s = sup(kernel, { invoke: (async () => { throw new Error('ipc down'); }) as McpInvokeLike });
    const out = (await s('fileTree.applyChangeset', { changes: [change('docs/a.txt', 'a')] }, writeScope)) as Record<string, unknown>;
    expect((out['applied'] as Record<string, unknown>[])[0]!['bytes']).toBeNull();
    expect(out['totals']).toMatchObject({ applied: 1 });
  });

  it('rootId 整批一个域基准：批准后全部落点解析到常驻根（一次反查 IPC）', async () => {
    // 与既有 multiroot 测试同口径：workspace_roots 真源回**路径串数组**，rootId 用 rootIdOf 现算。
    const WS_ROOT = 'D:/author-workspace';
    const WS_ID = rootIdOf(WS_ROOT);
    const writeSpy = vi.fn(async (_p: string, _text: string, _opts?: Record<string, unknown>) => undefined);
    const { kernel } = fakeKernel({ writeText: writeSpy });
    const invoke: McpInvokeLike = (async (cmd: string) =>
      cmd === 'workspace_roots' ? [WS_ROOT] : null) as McpInvokeLike;
    const s = sup(kernel, { invoke });
    const scope2: McpSessionScope = { ...writeScope, approvedRootIds: [WS_ID] };
    const out = (await s('fileTree.applyChangeset', {
      changes: [change('docs/a.txt', 'a'), change('docs/b.txt', 'b')],
      rootId: WS_ID,
    }, scope2)) as Record<string, unknown>;
    expect(out['rootId']).toBe(WS_ID);
    const calls = writeSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.every((p) => p.startsWith('D:/author-workspace/'))).toBe(true);
    expect(calls.some((p) => p.startsWith('D:/proj/'))).toBe(false);
  });
});

/* ------------------------------- ② 批次级错误：写之前整批拒 ------------------------------- */

describe('fileTree.applyChangeset：批次级缺陷整批 INVALID_ARGS（盘上零改动）', () => {
  const writeProbe = async (): Promise<never> => {
    throw new McpFailure('TOOL_EXECUTION_FAILED', '写原语被触达 = 批次级闸失守');
  };

  it('空数组 / 非数组 / 33 项 ⇒ INVALID_ARGS，写原语零触达', async () => {
    const { kernel } = fakeKernel({ writeText: writeProbe, backup: writeProbe });
    const s = sup(kernel);
    for (const changes of [[], 'nope', undefined, Array.from({ length: 33 }, (_, i) => change(`docs/f${i}.txt`, 'x'))]) {
      const arg = changes === undefined ? {} : { changes };
      await expect(s('fileTree.applyChangeset', arg, writeScope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    }
  });

  it('批内重复路径 ⇒ INVALID_ARGS（执行序语义歧义，不猜），写原语零触达', async () => {
    const { kernel } = fakeKernel({ writeText: writeProbe, backup: writeProbe });
    const s = sup(kernel);
    await expect(
      s('fileTree.applyChangeset', { changes: [change('docs/a.txt', '1'), change('docs/b.txt', '2'), change('docs/a.txt', '3')] }, writeScope),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('重复') });
  });

  it.each([
    ['path 逃逸', { changes: [change('docs/ok.txt', 'a'), change('../escape.txt', 'b')] }],
    ['content 缺失', { changes: [{ path: 'docs/a.txt' }] }],
    ['content 非串', { changes: [{ path: 'docs/a.txt', content: 42 }] }],
    ['encoding 非法', { changes: [{ path: 'docs/a.txt', content: 'a', encoding: 'utf-7' }] }],
    ['eol 非法', { changes: [{ path: 'docs/a.txt', content: 'a', eol: '\n' }] }],
    ['项非对象', { changes: ['docs/a.txt'] }],
  ])('%s ⇒ INVALID_ARGS，写原语零触达（半批不落盘）', async (_label, args) => {
    const { kernel } = fakeKernel({ writeText: writeProbe, backup: writeProbe });
    const s = sup(kernel);
    await expect(s('fileTree.applyChangeset', args as Record<string, unknown>, writeScope)).rejects.toMatchObject({
      code: 'INVALID_ARGS',
    });
  });

  it('rootId 未批准 ⇒ PERMISSION_DENIED 整批拒（第四张表默认拒绝，写原语零触达）', async () => {
    const { kernel } = fakeKernel({ writeText: writeProbe });
    const s = sup(kernel);
    await expect(
      s('fileTree.applyChangeset', { changes: [change('docs/a.txt', 'a')], rootId: 'ws:1a2b3c4d' }, writeScope),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('缺写原语 ⇒ NOT_WIRED（不静默、不造假实现）', async () => {
    const { kernel } = fakeKernel({}); // 无 backup / writeText
    const s = sup(kernel);
    await expect(
      s('fileTree.applyChangeset', { changes: [change('docs/a.txt', 'a')] }, writeScope),
    ).rejects.toMatchObject({ code: 'NOT_WIRED', message: expect.stringContaining('backup') });
  });
});