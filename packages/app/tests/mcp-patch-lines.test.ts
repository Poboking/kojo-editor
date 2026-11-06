/**
 * fileTree.patchLines patch 级写单测（MCP-PERF-S6，2026-11-07）。
 *
 * TRAE P1 原文：「patch 级写：保留编码/EOL＋原子写＋统一备份＋diff 摘要，替代整文件覆盖」
 * ——agent 改 5 万行文件不必上传全文。钉四件事：
 *  1. 单文件多 hunk（≤32，行区间/锚点二选一）→ 一次写 + 一份备份 + 一次 file.changed，
 *     逐条 applied/refused 可见（refused 不抛整个批次）；
 *  2. 批次级缺陷（超 32、双形混用 / 半形、行界非 1 基整数、start>end、行区间重叠、
 *     oldText 空串、rootId 未批准、形状坏）在任何写发生之前整批拒；
 *  3. 语义级缺陷（行区间越界、锚多命中/零命中）逐条 refused 批次继续；全部 refused ⇒ 零副作用；
 *  4. 链路与 S3 applyChangeset 同尺：read 全文 → 内存应用 → io.backup → writeText{backup:false}
 *     → read_file_bytes 回读验证；行坐标一律指原始文件（自上而下单趟合并，永不漂移）。
 *
 * 量化判据（20-hunk 批次端到端 <300ms，真实 Node fs 桥）在 `mcp-patch-lines.perf.test.ts`。
 * 全程假注入（fake kernel / invoke），不起 GUI、不起 Tauri、不起 HTTP。
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
  sessionId: 'pl-s',
  clientId: 'pl-c',
  tier: 'edit',
  approvedRoots: ['docs'],
  approvedTools: [],
};

type LineHunk = { startLine: number; endLine: number; replacement: string };
type AnchorHunk = { oldText: string; newText: string };
type Hunk = LineHunk | AnchorHunk;

interface Overrides {
  readonly exists?: (path: string) => Promise<boolean>;
  readonly backup?: (path: string) => Promise<string | null>;
  readonly writeText?: (path: string, text: string, opts?: Record<string, unknown>) => Promise<void>;
  readonly noWritePrimitives?: boolean;
}

/**
 * 假内核 + 假 invoke：虚拟文件 `text` 是单一真源——writeText 假件落进虚拟文件，
 * read_file_bytes / stat_files 读的也是它 ⇒ 回读验证链路真实走通（不是假绿）。
 */
function fakeHarness(seed: string, over: Overrides = {}) {
  let text = seed;
  const events: { kind: string; path: string }[] = [];
  const writeSpy = vi.fn(async (_p: string, t: string, _opts?: Record<string, unknown>) => {
    text = t;
  });
  const backupSpy = vi.fn(async (p: string) => `${p}.bak`);
  const io: Record<string, unknown> = {
    walkDir: async () => [],
    exists: over.exists ?? (async () => true),
    ...(over.noWritePrimitives ? {} : { backup: over.backup ?? backupSpy }),
    ...(over.noWritePrimitives ? {} : { writeText: over.writeText ?? writeSpy }),
  };
  const kernel: McpKernelLike = {
    project: { current: () => ({ rootDir: 'D:/proj', adapterId: 'adapter-a', kojoPaths: [], charaIndex: new Map() }) },
    io: io as McpKernelLike['io'],
    plugins: { list: () => [] },
    services: { tryGet: () => undefined },
    bus: {
      on: () => () => {},
      emit: (name, payload) => {
        const p = payload as { kind: string; path: string };
        events.push({ kind: p.kind, path: p.path });
      },
    },
    slots: { query: () => [] },
  };
  let reads = 0;
  const invoke: McpInvokeLike = (async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'read_file_bytes' && args && typeof args['path'] === 'string') {
      reads += 1;
      return text;
    }
    if (cmd === 'stat_files' && args && Array.isArray(args['paths'])) {
      return (args['paths'] as string[]).map((p) => ({ path: p, exists: true, size: Buffer.byteLength(text), mtimeMs: null }));
    }
    return null;
  }) as McpInvokeLike;
  const deps: McpIoDeps = { getKernel: () => kernel, getCommands: () => [], invoke } as unknown as McpIoDeps;
  const run = createRunSupplemental(deps);
  return { run, events, writeSpy, backupSpy, invoke, getReads: () => reads, getText: () => text };
}

const line = (startLine: number, endLine: number, replacement: string): LineHunk => ({ startLine, endLine, replacement });
const anchor = (oldText: string, newText: string): AnchorHunk => ({ oldText, newText });

/* --------------------- ① 一批 hunk → 一次写 / 逐条回执 / diff 摘要 --------------------- */

describe('fileTree.patchLines：一批 hunk → 一次写 + 一份备份 + 逐条 applied', () => {
  it('行区间替换+展开：坐标指原始文件，writeText 收拼接全文（{backup:false}），diff 摘要逐格诚实', async () => {
    const h = fakeHarness('l1\nl2\nl3\nl4\nl5\n');
    const out = (await h.run('fileTree.patchLines', { relPath: 'docs/a.txt', hunks: [line(2, 3, 'X\nY')] }, writeScope)) as Record<string, unknown>;

    expect(h.writeSpy).toHaveBeenCalledTimes(1); // 一次 MCP 往返 = 一次写
    expect(h.writeSpy.mock.calls[0]![0]).toBe('D:/proj/docs/a.txt');
    expect(h.writeSpy.mock.calls[0]![1]).toBe('l1\nX\nY\nl4\nl5\n');
    expect(h.writeSpy.mock.calls[0]![2]).toEqual({ backup: false }); // 备份已手动落账，防二次备份
    expect(h.backupSpy).toHaveBeenCalledTimes(1);
    expect(h.backupSpy.mock.calls[0]![0]).toBe('D:/proj/docs/a.txt');
    expect(h.getReads()).toBe(2); // 初读 + 回读验证
    expect(h.events).toEqual([{ kind: 'change', path: 'D:/proj/docs/a.txt' }]); // 一次 file.changed

    expect(out['path']).toBe('docs/a.txt');
    const applied = out['applied'] as Record<string, unknown>[];
    expect(applied).toEqual([
      { index: 0, kind: 'lines', startLine: 2, endLine: 3, linesRemoved: 2, linesAdded: 2, charsBefore: 5, charsAfter: 3 },
    ]);
    expect(out['refused']).toEqual([]);
    expect(out['totals']).toEqual({ hunks: 1, applied: 1, refused: 0 });
    expect(out['diff']).toEqual({ linesBefore: 6, linesAfter: 6, lineDelta: 0, charsBefore: 15, charsAfter: 13, charDelta: -2 });
    expect(out['backupPath']).toBe('D:/proj/docs/a.txt.bak');
    expect(out['bytes']).toBe(13); // 落盘后 stat 真读数（虚拟文件已更新）
    expect(out['written']).toBe(true);
    expect(out['refreshed']).toBe(true);
  });

  it('多 hunk 自上而下单趟合并：后续 hunk 坐标仍指原始文件（永不漂移），删除 + 展开混批', async () => {
    const h = fakeHarness('1\n2\n3\n4\n5\n6\n7\n8\n');
    const out = (await h.run('fileTree.patchLines', {
      relPath: 'docs/a.txt',
      hunks: [line(2, 2, 'two'), line(5, 6, ''), line(8, 8, 'eight\n8b')],
    }, writeScope)) as Record<string, unknown>;

    // hunk2 删了 2 行也不影响 hunk3 的原始行号 8（合并按原始坐标一次走完）
    expect(h.writeSpy.mock.calls[0]![1]).toBe('1\ntwo\n3\n4\n7\neight\n8b\n');
    const applied = out['applied'] as Record<string, unknown>[];
    expect(applied).toHaveLength(3);
    expect(applied[1]).toMatchObject({ index: 1, kind: 'lines', linesRemoved: 2, linesAdded: 0, charsBefore: 3, charsAfter: 0 });
    expect(applied[2]).toMatchObject({ index: 2, kind: 'lines', linesRemoved: 1, linesAdded: 2, charsBefore: 1, charsAfter: 8 });
    expect(out['diff']).toEqual({ linesBefore: 9, linesAfter: 8, lineDelta: -1, charsBefore: 16, charsAfter: 21, charDelta: 5 });
    expect(out['totals']).toEqual({ hunks: 3, applied: 3, refused: 0 });
  });

  it('整行删除语义：replacement 空串删整段（统一 diff 口径），无尾换行文件原样保住', async () => {
    const h = fakeHarness('a\nb\nc'); // 无尾换行 ⇒ 3 行
    const out = (await h.run('fileTree.patchLines', { relPath: 'docs/a.txt', hunks: [line(2, 3, '')] }, writeScope)) as Record<string, unknown>;
    expect(h.writeSpy.mock.calls[0]![1]).toBe('a'); // 尾换行仍不存在（不无中生有）
    expect(out['diff']).toEqual({ linesBefore: 3, linesAfter: 1, lineDelta: -2, charsBefore: 5, charsAfter: 1, charDelta: -4 });
    const applied = out['applied'] as Record<string, unknown>[];
    expect(applied[0]).toMatchObject({ linesRemoved: 2, linesAdded: 0 });
  });

  it('CRLF 文件行号同口径：切分沿用 fs.readRange，落给内核的是 \\n 拼接全文（preserve 交给内核）', async () => {
    const h = fakeHarness('a\r\nb\r\nc');
    await h.run('fileTree.patchLines', { relPath: 'docs/a.txt', hunks: [line(2, 2, 'B')] }, writeScope);
    expect(h.writeSpy.mock.calls[0]![1]).toBe('a\nB\nc'); // 行内容对位正确；EOL 重建是内核 preserve 的既定语义
  });

  it('锚点替换：唯一命中改写，matchOffset 如实回报', async () => {
    const h = fakeHarness('alpha\nbeta\ngamma\n');
    const out = (await h.run('fileTree.patchLines', { relPath: 'docs/a.txt', hunks: [anchor('beta', 'BETA')] }, writeScope)) as Record<string, unknown>;
    expect(h.writeSpy.mock.calls[0]![1]).toBe('alpha\nBETA\ngamma\n');
    expect(out['applied']).toEqual([{ index: 0, kind: 'anchor', charsBefore: 4, charsAfter: 4, matchOffset: 6 }]);
  });

  it('应用序钉死：行区间先（自上而下）→ 锚点后（按提交序）。锚 oldText 落在被替换段内 ⇒ 零命中 refused，不整批炸', async () => {
    const h = fakeHarness('head\nTARGET\ntail\n');
    const out = (await h.run('fileTree.patchLines', {
      relPath: 'docs/a.txt',
      hunks: [anchor('TARGET', 'REPLACED'), line(2, 2, 'NEW')],
    }, writeScope)) as Record<string, unknown>;
    expect(h.writeSpy.mock.calls[0]![1]).toBe('head\nNEW\ntail\n');
    expect(out['applied']).toEqual([{ index: 1, kind: 'lines', startLine: 2, endLine: 2, linesRemoved: 1, linesAdded: 1, charsBefore: 6, charsAfter: 3 }]);
    expect(out['refused']).toEqual([expect.objectContaining({ index: 0, kind: 'anchor', code: 'INVALID_ARGS', message: expect.stringContaining('零命中') })]);
    expect(out['totals']).toEqual({ hunks: 2, applied: 1, refused: 1 });
  });

  it('32 hunk（上限内）一批：一次写 + 一份备份 + 一次事件（一次 MCP 往返，不是 32 次）', async () => {
    const seed = Array.from({ length: 32 }, (_, i) => `line-${i + 1}`).join('\n') + '\n';
    const h = fakeHarness(seed);
    const hunks = Array.from({ length: 32 }, (_, i) => line(i + 1, i + 1, `patched-${i + 1}`));
    const out = (await h.run('fileTree.patchLines', { relPath: 'docs/a.txt', hunks }, writeScope)) as Record<string, unknown>;
    expect(out['totals']).toEqual({ hunks: 32, applied: 32, refused: 0 });
    expect(h.writeSpy).toHaveBeenCalledTimes(1);
    expect(h.backupSpy).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveLength(1);
    const applied = out['applied'] as Record<string, unknown>[];
    expect(applied[31]).toMatchObject({ index: 31, startLine: 32, endLine: 32, charsBefore: 7, charsAfter: 10 }); // line-32=6+1、patched-32=10
  });
});

/* --------------------- ② 语义级缺陷：逐条 refused，批次继续 --------------------- */

describe('fileTree.patchLines：逐条 refused（多命中/零命中/越界），其余照常 applied', () => {
  it('锚点零命中 / 多命中逐条 refused（带 code/message），唯一命中的照常改', async () => {
    const h = fakeHarness('dup\ndup\nunique\n');
    const out = (await h.run('fileTree.patchLines', {
      relPath: 'docs/a.txt',
      hunks: [anchor('nope', 'x'), anchor('dup', 'y'), anchor('unique', 'U')],
    }, writeScope)) as Record<string, unknown>;
    const refused = out['refused'] as Record<string, unknown>[];
    expect(refused).toHaveLength(2);
    expect(refused[0]).toMatchObject({ index: 0, kind: 'anchor', code: 'INVALID_ARGS' });
    expect(String(refused[0]!['message'])).toContain('零命中');
    expect(refused[1]).toMatchObject({ index: 1, kind: 'anchor', code: 'INVALID_ARGS' });
    expect(String(refused[1]!['message'])).toContain('命中 2');
    expect(out['applied']).toEqual([{ index: 2, kind: 'anchor', charsBefore: 6, charsAfter: 1, matchOffset: 8 }]);
    expect(h.writeSpy).toHaveBeenCalledTimes(1); // 有 applied ⇒ 照常一次写
    expect(h.writeSpy.mock.calls[0]![1]).toBe('dup\ndup\nU\n');
  });

  it('行区间越界（endLine > 总行数）逐条 refused：写面绝不夹取（readRange 的读窗口语义不适用于写）', async () => {
    const h = fakeHarness('a\nb\nc\n');
    const out = (await h.run('fileTree.patchLines', {
      relPath: 'docs/a.txt',
      hunks: [line(3, 99, 'X'), line(1, 1, 'A')],
    }, writeScope)) as Record<string, unknown>;
    expect(out['refused']).toEqual([
      expect.objectContaining({ index: 0, kind: 'lines', code: 'INVALID_ARGS', message: expect.stringContaining('越界') }),
    ]);
    expect(out['applied']).toEqual([{ index: 1, kind: 'lines', startLine: 1, endLine: 1, linesRemoved: 1, linesAdded: 1, charsBefore: 1, charsAfter: 1 }]);
    expect(h.writeSpy.mock.calls[0]![1]).toBe('A\nb\nc\n');
  });

  it('全部 hunk refused ⇒ 零副作用：不备份、不写、不发事件、回执无 backupPath/bytes（written:false）', async () => {
    const h = fakeHarness('a\na\n');
    const out = (await h.run('fileTree.patchLines', {
      relPath: 'docs/a.txt',
      hunks: [anchor('ghost', 'x'), line(9, 9, 'y')],
    }, writeScope)) as Record<string, unknown>;
    expect(h.writeSpy).not.toHaveBeenCalled();
    expect(h.backupSpy).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(0);
    expect(h.getReads()).toBe(1); // 只初读（无写 ⇒ 无回读、无 stat）
    expect(out['applied']).toEqual([]);
    expect(out['totals']).toEqual({ hunks: 2, applied: 0, refused: 2 });
    expect(out['written']).toBe(false);
    expect(out).not.toHaveProperty('backupPath');
    expect(out).not.toHaveProperty('bytes');
  });
});

/* --------------------- ③ 批次级缺陷：任何写发生前整批拒 --------------------- */

describe('fileTree.patchLines：批次级缺陷整批 INVALID_ARGS（盘上零改动）', () => {
  const writeProbe = async (): Promise<never> => {
    throw new McpFailure('TOOL_EXECUTION_FAILED', '写原语被触达 = 批次级闸失守');
  };

  it('hunks 空数组 / 非数组 / 缺席 / 33 项 ⇒ INVALID_ARGS，写原语零触达', async () => {
    const h = fakeHarness('a\n', { writeText: writeProbe, backup: writeProbe });
    for (const hunks of [[], 'nope', undefined, Array.from({ length: 33 }, (_, i) => line(i + 1, i + 1, 'x'))]) {
      const arg = hunks === undefined ? { relPath: 'docs/a.txt' } : { relPath: 'docs/a.txt', hunks };
      await expect(h.run('fileTree.patchLines', arg, writeScope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    }
  });

  it.each([
    ['hunk 非对象', ['nope']],
    ['双形混用', [{ startLine: 1, endLine: 1, replacement: 'x', oldText: 'a', newText: 'b' }]],
    ['行区间半形（缺 replacement）', [{ startLine: 1, endLine: 1 }]],
    ['锚点半形（缺 newText）', [{ oldText: 'a' }]],
    ['0 基行号被拒', [{ startLine: 0, endLine: 1, replacement: 'x' }]],
    ['非整数行号', [{ startLine: 1.5, endLine: 2, replacement: 'x' }]],
    ['startLine > endLine', [{ startLine: 2, endLine: 1, replacement: 'x' }]],
    ['oldText 空串', [{ oldText: '', newText: 'b' }]],
    ['replacement 非串', [{ startLine: 1, endLine: 1, replacement: 42 }]],
    ['newText 非串', [{ oldText: 'a', newText: 7 }]],
  ])('%s ⇒ INVALID_ARGS，写原语零触达（半批不落盘）', async (_label, hunks) => {
    const h = fakeHarness('a\nb\n', { writeText: writeProbe, backup: writeProbe });
    await expect(
      h.run('fileTree.patchLines', { relPath: 'docs/a.txt', hunks }, writeScope),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('行区间重叠 ⇒ INVALID_ARGS（执行序语义歧义不猜），相邻区间放行', async () => {
    const h = fakeHarness('1\n2\n3\n4\n5\n', { writeText: writeProbe, backup: writeProbe });
    await expect(
      h.run('fileTree.patchLines', { relPath: 'docs/a.txt', hunks: [line(1, 3, 'x'), line(2, 2, 'y')] }, writeScope),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('重叠') });
    await expect(
      h.run('fileTree.patchLines', { relPath: 'docs/a.txt', hunks: [line(5, 9, 'x'), line(9, 10, 'y')] }, writeScope),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('重叠') });
    // 相邻（[1,2] 与 [3,4]）不重叠：走到读文件阶段才可能因写探针失败（TOOL_EXECUTION_FAILED），而不是 INVALID_ARGS
    await expect(
      h.run('fileTree.patchLines', { relPath: 'docs/a.txt', hunks: [line(1, 2, 'x'), line(3, 4, 'y')] }, writeScope),
    ).rejects.toMatchObject({ code: 'TOOL_EXECUTION_FAILED' });
  });

  it('relPath 逃逸 / 缺席 ⇒ INVALID_ARGS；目标不存在 ⇒ TOOL_EXECUTION_FAILED（不静默改 create）', async () => {
    const h = fakeHarness('a\n');
    await expect(h.run('fileTree.patchLines', { relPath: '../escape.txt', hunks: [line(1, 1, 'x')] }, writeScope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(h.run('fileTree.patchLines', { hunks: [line(1, 1, 'x')] }, writeScope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    const missing = fakeHarness('a\n', { exists: async () => false });
    await expect(missing.run('fileTree.patchLines', { relPath: 'docs/a.txt', hunks: [line(1, 1, 'x')] }, writeScope)).rejects.toMatchObject({
      code: 'TOOL_EXECUTION_FAILED',
      message: expect.stringContaining('不存在'),
    });
  });

  it('rootId 未批准 ⇒ PERMISSION_DENIED 整批拒（第四张表默认拒绝，写原语零触达）', async () => {
    const h = fakeHarness('a\n', { writeText: writeProbe });
    await expect(
      h.run('fileTree.patchLines', { relPath: 'docs/a.txt', hunks: [line(1, 1, 'x')], rootId: 'ws:1a2b3c4d' }, writeScope),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('缺写原语 ⇒ NOT_WIRED（不静默、不造假实现）；写闸一域外路径 ⇒ WRITE_DISABLED', async () => {
    const h = fakeHarness('a\n', { noWritePrimitives: true });
    await expect(
      h.run('fileTree.patchLines', { relPath: 'docs/a.txt', hunks: [line(1, 1, 'x')] }, writeScope),
    ).rejects.toMatchObject({ code: 'NOT_WIRED', message: expect.stringContaining('backup') });
    const h2 = fakeHarness('a\n');
    await expect(
      h2.run('fileTree.patchLines', { relPath: 'outside/x.txt', hunks: [line(1, 1, 'x')] }, writeScope),
    ).rejects.toMatchObject({ code: 'WRITE_DISABLED' });
  });
});

/* --------------------- ④ 链路账：回读验证 / rootId / 域闸 --------------------- */

describe('fileTree.patchLines：链路账（回读验证 / rootId 三道拦截）', () => {
  it('回读验证：写后 read_file_bytes 与预期不符 ⇒ TOOL_EXECUTION_FAILED（写已发生也要大声报，不静默）', async () => {
    let calls = 0;
    const tampered = (async (cmd: string) => {
      if (cmd === 'read_file_bytes') {
        calls += 1;
        return calls === 1 ? 'a\nb\n' : 'TAMPERED\n'; // 初读给原文，回读给被篡改的盘态
      }
      return null;
    }) as McpInvokeLike;
    const h = fakeHarnessWithInvoke('a\nb\n', tampered);
    await expect(
      h.run('fileTree.patchLines', { relPath: 'docs/a.txt', hunks: [line(1, 1, 'A')] }, writeScope),
    ).rejects.toMatchObject({ code: 'TOOL_EXECUTION_FAILED', message: expect.stringContaining('回读') });
    expect(h.writeSpy).toHaveBeenCalledTimes(1); // 写已发生，验证失败必须出声
  });

  it('rootId 整批一个域基准：批准后落点解析到常驻根（一次反查 IPC），out.rootId 如实回带', async () => {
    const WS_ROOT = 'D:/author-workspace';
    const WS_ID = rootIdOf(WS_ROOT);
    const h = fakeHarnessWithInvokeRoot('a\nb\n', WS_ROOT);
    const scope2: McpSessionScope = { ...writeScope, approvedRootIds: [WS_ID] };
    const out = (await h.run('fileTree.patchLines', {
      relPath: 'docs/a.txt',
      hunks: [line(1, 1, 'A'), line(2, 2, 'B')],
      rootId: WS_ID,
    }, scope2)) as Record<string, unknown>;
    expect(out['rootId']).toBe(WS_ID);
    expect(h.writePath.startsWith('D:/author-workspace/')).toBe(true);
    expect(h.writePath.startsWith('D:/proj/')).toBe(false);
  });
});

/** 可注入 invoke 的 harness（回读验证 / rootId 用例）：io 假件同 fakeHarness，invoke 由用例给定。 */
function fakeHarnessWithInvoke(seed: string, invoke: McpInvokeLike) {
  let text = seed;
  const events: { kind: string; path: string }[] = [];
  const writeSpy = vi.fn(async (_p: string, t: string) => {
    text = t;
  });
  const kernel: McpKernelLike = {
    project: { current: () => ({ rootDir: 'D:/proj', adapterId: 'adapter-a', kojoPaths: [], charaIndex: new Map() }) },
    io: { walkDir: async () => [], exists: async () => true, backup: async (p: string) => `${p}.bak`, writeText: writeSpy } as unknown as McpKernelLike['io'],
    plugins: { list: () => [] },
    services: { tryGet: () => undefined },
    bus: { on: () => () => {}, emit: (name, payload) => events.push((payload as { kind: string; path: string })) },
    slots: { query: () => [] },
  };
  const run = createRunSupplemental({ getKernel: () => kernel, getCommands: () => [], invoke } as unknown as McpIoDeps);
  return { run, writeSpy, events };
}

/** rootId 用例：invoke 真源回 workspace_roots + 虚拟文件；记录 writeText 落点（容器引用，防按值快照）。 */
function fakeHarnessWithInvokeRoot(seed: string, wsRoot: string) {
  let text = seed;
  const state = { writePath: '' };
  const writeSpy = vi.fn(async (p: string, t: string) => {
    state.writePath = p;
    text = t;
  });
  const kernel: McpKernelLike = {
    project: { current: () => ({ rootDir: 'D:/proj', adapterId: 'adapter-a', kojoPaths: [], charaIndex: new Map() }) },
    io: { walkDir: async () => [], exists: async () => true, backup: async (p: string) => `${p}.bak`, writeText: writeSpy } as unknown as McpKernelLike['io'],
    plugins: { list: () => [] },
    services: { tryGet: () => undefined },
    bus: { on: () => () => {}, emit: () => {} },
    slots: { query: () => [] },
  };
  const invoke: McpInvokeLike = (async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'workspace_roots') return [wsRoot];
    if (cmd === 'read_file_bytes') return text;
    if (cmd === 'stat_files' && args && Array.isArray(args['paths'])) {
      return (args['paths'] as string[]).map((p) => ({ path: p, exists: true, size: Buffer.byteLength(text), mtimeMs: null }));
    }
    return null;
  }) as McpInvokeLike;
  const run = createRunSupplemental({ getKernel: () => kernel, getCommands: () => [], invoke } as unknown as McpIoDeps);
  return { run, writeSpy, get writePath() { return state.writePath; } };
}
