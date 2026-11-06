/**
 * MCP 真源腿单测（A3）—— 路径闸 / kernelIo 3 腿 / runSupplemental 只读腿 /
 * resource 数据源 / 事件环形缓冲 / promptSlots / 语义 8 腿投影。
 *
 * 全程假注入（fake kernel / invoke / search / monaco / model / 判据腿 / provider），
 * 不起 GUI、不起 Tauri、不起 HTTP。断言语义而非凑绿：
 * - 路径逃逸逐类拒绝（绝对路径 / 盘符 / UNC / `..` / URL 编码含双重编码 / 设备名 / 尾点尾空格）；
 * - 截断必须显式 truncated，接不到真源必须 NOT_WIRED / RESOURCE_UNAVAILABLE
 *   （铁律 4：不静默、不伪造读数、不空串冒充成功）；
 * - codeActionsAt 只投影「有哪些动作」（含宿主签发 actionId），本腿绝不 apply；
 *   执行走 problems.quickFix 受控通道（端到端见 mcp-quickfix-apply.test.ts）；
 * - 四枚 fileTree 写腿（create/update/remove/rename）接真实写执行，双闸逐条可红；
 *   其余写类与危险动作保持 NOT_WIRED，不擅自开放执行（见 mcp-write-legs.test.ts）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpFailure, createMcpCapabilityRegistry, MCP_TOOL_GAP_MAP, SUPPLEMENTAL_TOOL_SPECS, type McpSessionScope } from '@kojo/mcp-host';
import type { CommandEntry } from '../src/ui/commands';
import {
  assertMcpWriteDomain,
  createIoResourceData,
  createKernelIo,
  createRunSupplemental,
  isWithinApprovedRoots,
  isWithinRoot,
  KOJO_RESOURCE_URIS,
  normalizeRoot,
  resolveWithinRoot,
  sanitizeEcho,
  toRelativePath,
  validateRelativePath,
  type McpInvokeLike,
  type McpIoDeps,
  type McpKernelLike,
  type McpSearchRequestLike,
  type McpSearchResultLike,
} from '../src/mcp/real-sources-io';
import {
  bindEventRing,
  buildRealMcpSources,
  buildSemanticReaders,
  buildUiSupplemental,
  installRealMcpSources,
  toRelativeLocationPath,
  type McpLanguageFeaturesLike,
  type McpMarkerLike,
  type McpRealSourceHost,
  type McpSemanticDeps,
  type McpSemanticLegsLike,
  type McpSemanticModel,
  type McpSemanticMonaco,
  type McpSemanticWorkspace,
} from '../src/mcp/real-sources';
import { registerMcpWiringSources } from '../src/mcp/wiring';

const scope: McpSessionScope = {
  sessionId: 's1',
  clientId: 'c1',
  tier: 'privileged',
  approvedRoots: ['D:/proj'],
  approvedTools: [],
};

/** 写腿专用会话：第四张表 approvedRoots 是**项目根内相对路径**（Rust build_scope 同尺）。 */
const writeScope: McpSessionScope = {
  sessionId: 's1',
  clientId: 'c1',
  tier: 'edit',
  approvedRoots: ['docs'],
  approvedTools: [],
};

/* ------------------------------- 假件 ------------------------------- */

function fakeModel(text = 'alpha\nbeta\n'): McpSemanticModel {
  const lines = text.split('\n');
  return {
    uri: { toString: () => 'file:///D:/proj/a.kojo' },
    getLineCount: () => lines.length,
    getLineMaxColumn: (line: number) => (lines[line - 1]?.length ?? 0) + 1,
    getLineContent: (line: number) => lines[line - 1] ?? '',
    getLanguageId: () => 'kojo',
    getEOL: () => '\n',
    getValue: () => text,
  };
}

function fakeMonaco(markers: McpMarkerLike[] = [], tokenized: { type: string; offset: number }[][] = []): McpSemanticMonaco {
  return {
    Position: class {
      constructor(
        readonly line: number,
        readonly column: number,
      ) {}
    },
    Range: class {
      constructor(
        readonly startLine: number,
        readonly startColumn: number,
        readonly endLine: number,
        readonly endColumn: number,
      ) {}
    },
    CancellationTokenSource: class {
      readonly token = { cancelled: false };
      dispose(): void {}
    },
    editor: {
      tokenize: () => tokenized,
      getModelMarkers: (filter: Record<string, unknown>) =>
        filter['resource'] === undefined ? markers : markers.filter((m) => m.resource === filter['resource']),
    },
  } as unknown as McpSemanticMonaco;
}

function fakeWorkspace(opts: Partial<McpSemanticWorkspace> = {}): McpSemanticWorkspace {
  const model = fakeModel();
  return {
    model,
    monaco: fakeMonaco(),
    cursor: { line: 2, column: 1 },
    rootDir: 'D:/proj',
    ...opts,
  };
}

function fakeLegs(over: Partial<McpSemanticLegsLike> = {}): McpSemanticLegsLike {
  return {
    definition: () => [{ filePath: 'D:/proj/b.kojo', line: 3, column: 2 }],
    references: () => ({
      path: 'b.kojo',
      locations: [
        { filePath: 'D:/proj/b.kojo', line: 3, kind: 'definition' },
        { filePath: 'D:/proj/c.kojo', line: 9, kind: 'call' },
      ],
    }),
    ...over,
  };
}

function registryWith(entries: Record<string, unknown[]>): McpLanguageFeaturesLike {

  const out: Record<string, unknown> = {};
  for (const [key, list] of Object.entries(entries)) out[key] = { ordered: () => list };
  return out as unknown as McpLanguageFeaturesLike;
}

function fakeDeps(over: Partial<McpSemanticDeps> = {}): McpSemanticDeps {
  const ws = fakeWorkspace();
  return {
    getMonaco: () => ws.monaco,
    getWorkspace: () => ws,
    getLegs: () => fakeLegs(),
    getFeaturesService: () => null,
    getRootDir: () => 'D:/proj',
    ...over,
  };
}

interface FakeKernelOverrides {
  readonly current?: unknown;
  readonly walkDir?: (path: string, opts?: Record<string, unknown>) => Promise<unknown[]>;
  readonly exists?: (path: string) => Promise<boolean>;
  readonly createFileExclusive?: (path: string) => Promise<boolean>;
  readonly createDirExclusive?: (path: string) => Promise<boolean>;
  readonly writeText?: (path: string, text: string, opts?: Record<string, unknown>) => Promise<void>;
  readonly busEmit?: (name: string, payload: unknown) => void;
  readonly plugins?: unknown[];
  readonly linter?: { report?: () => unknown } | null;
  readonly slots?: readonly unknown[];
}

function fakeKernel(over: FakeKernelOverrides = {}): { kernel: McpKernelLike; busNames: string[] } {
  const busNames: string[] = [];
  const kernel: McpKernelLike = {
    project: {
      current: () =>
        'current' in over
          ? over.current
          : {
              rootDir: 'D:\\proj',
              adapterId: 'adapter-a',
              kojoPaths: ['D:\\proj\\k'],
              charaIndex: new Map([[1, { no: 1, name: 'a' }]]),
            },
    },
    io: {
      walkDir: over.walkDir ?? (async () => [{ name: 'a.kojo', path: 'D:\\proj\\a.kojo', isDirectory: false }]),
      ...(over.exists ? { exists: over.exists } : {}),
      ...(over.createFileExclusive ? { createFileExclusive: over.createFileExclusive } : {}),
      ...(over.createDirExclusive ? { createDirExclusive: over.createDirExclusive } : {}),
      ...(over.writeText ? { writeText: over.writeText } : {}),
    },
    plugins: { list: () => over.plugins ?? [{ id: 'p1', version: '1', status: 'active' }, { id: 'p2', version: '1', status: 'inactive', missing: ['k.x'] }] },
    services: { tryGet: <T = unknown>(_key: string) => (over.linter ?? undefined) as T | undefined },
    bus: {
      on: (name: string, _cb: (payload: unknown) => void) => {
        busNames.push(name);
        return () => {};
      },
      ...(over.busEmit ? { emit: over.busEmit } : {}),
    },
    slots: { query: () => over.slots ?? [] },
  };
  return { kernel, busNames };
}

function fakeIoDeps(kernel: McpKernelLike | null, over: Partial<McpIoDeps> = {}): McpIoDeps {
  const commands: CommandEntry[] = [
    { id: 'a.open', title: 'A', run: () => undefined },
    { id: 'b.save', title: 'B', description: '存', tier: 'edit', run: () => undefined },
  ];
  return {
    getKernel: () => kernel,
    getCommands: () => commands,
    invoke: async () => null,
    searchInFiles: async () => ({
      files: [{ path: 'D:\\proj\\x.kojo', matches: [{ line: 2, preview: 'hit' }, { line: 4, preview: 'hit2' }] }],
      totalMatches: 2,
      truncated: false,
      filesScanned: 1,
      elapsedMs: 3,
      skipped: {},
    }),
    ...over,
  };
}

/* ------------------------------- 路径闸 ------------------------------- */

describe('路径闸（与 Rust validate_relative_path 同尺，fail-closed）', () => {
  const ESCAPES: readonly [string, string][] = [
    ['绝对路径', '/etc/passwd'],
    ['盘符', 'C:/x.txt'],
    ['ADS 冒号', 'a.txt:hidden'],
    ['UNC 反斜杠', '\\\\server\\share\\x'],
    ['上跳', 'a/../../b.txt'],
    ['单点段', './a.txt'],
    ['URL 编码', '%2e%2e/a.txt'],
    ['URL 编码斜杠', 'a%2fb.txt'],
    ['双重编码', '%252e%252e/a.txt'],
    ['反斜杠', 'a\\b.txt'],
    ['尾点', 'a.txt.'],
    ['尾空格', 'a.txt '],
    ['设备名', 'CON'],
    ['设备名带扩展', 'com1.txt'],
    ['家目录', '~/a.txt'],
    ['NUL', 'a\u0000.txt'],
    ['双斜杠空组件', 'a//b.txt'],
    ['空路径', ''],
  ];
  it.each(ESCAPES)('拒绝：%s（%j）', (_label, raw) => {
    expect(() => validateRelativePath(raw)).toThrow(McpFailure);
    expect(() => validateRelativePath(raw)).toThrow(/路径越界/);
    expect(() => resolveWithinRoot('D:/proj', raw)).toThrow(McpFailure);
  });

  it('合法相对路径解析到根内；域复核 fail-closed', () => {
    expect(resolveWithinRoot('D:/proj', 'a/b.txt')).toBe('D:/proj/a/b.txt');
    expect(resolveWithinRoot('D:\\proj', 'a/b.txt')).toBe('D:/proj/a/b.txt');
    expect(isWithinRoot('D:/proj', 'D:/proj/a/b.txt')).toBe(true);
    expect(isWithinRoot('D:/proj', 'D:/proj2/a.txt')).toBe(false);
    expect(isWithinRoot('D:/proj', 'C:/other/a.txt')).toBe(false);
  });

  it('无根可复核 ⇒ RESOURCE_UNAVAILABLE（不静默放行）', () => {
    expect(() => resolveWithinRoot('', 'a.txt')).toThrow(/没有可复核的域基准根/);
    expect(() => resolveWithinRoot('', 'a.txt')).toThrow(McpFailure);
  });

  it('回显净化：控制字符不原样回显', () => {
    expect(sanitizeEcho('a\u0000b')).not.toContain('\u0000');
  });
});

describe('toRelativeLocationPath：URI → 项目内相对路径', () => {
  it('file:// 盘符 / 纯绝对 / 反斜杠都归一成相对路径', () => {
    expect(toRelativeLocationPath('file:///D:/proj/a.kojo', 'D:/proj')).toBe('a.kojo');
    expect(toRelativeLocationPath('D:/proj/a.kojo', 'D:/proj')).toBe('a.kojo');
    expect(toRelativeLocationPath('D:\\proj\\a.kojo', 'D:\\proj')).toBe('a.kojo');
    expect(toRelativeLocationPath('file:///D:/proj/%E5%8F%A3/x.kojo', 'D:/proj')).toBe('口/x.kojo');
  });
  it('根外 / 跨盘符 / 无根：归一后原样返回（不编造相对路径）', () => {
    expect(toRelativeLocationPath('C:/other/a.kojo', 'D:/proj')).toBe('C:/other/a.kojo');
    expect(toRelativeLocationPath('D:/proj2/a.kojo', 'D:/proj')).toBe('D:/proj2/a.kojo');
    expect(toRelativeLocationPath('inmemory://model/3', null)).toBe('inmemory://model/3');
  });
  it('前缀必须落在分隔符上（/proj 不吃 /proj2）', () => {
    expect(toRelativeLocationPath('D:/projx/a.kojo', 'D:/proj')).toBe('D:/projx/a.kojo');
  });
});

/* ------------------------------- kernelIo 3 腿 ------------------------------- */

describe('kernelIo：projectInfo / fileTree / searchAll', () => {
  it('projectInfo：只取通用契约字段摘要（不伪造）', async () => {
    const { kernel } = fakeKernel();
    const io = createKernelIo(fakeIoDeps(kernel));
    const info = (await io.projectInfo({}, scope)) as Record<string, unknown>;
    expect(info).toMatchObject({ rootDir: 'D:\\proj', adapterId: 'adapter-a', charaCount: 1 });
    expect(info['kojoPaths']).toEqual(['D:\\proj\\k']);
  });

  it('fileTree：绝对路径投影成相对路径；条数截断显式 truncated', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      name: `f${i}.kojo`,
      path: `D:\\proj\\f${i}.kojo`,
      isDirectory: false,
    }));
    const { kernel } = fakeKernel({ walkDir: async (_p, opts) => (opts ? many : []) });
    const io = createKernelIo(fakeIoDeps(kernel));
    const tree = (await io.fileTree({ maxDepth: 4, maxEntries: 3 }, scope)) as Record<string, unknown>;
    expect(tree['maxDepth']).toBe(4);
    expect(tree['total']).toBe(7);
    expect(tree['truncated']).toBe(true);
    expect((tree['entries'] as Record<string, unknown>[]).map((e) => e['path'])).toEqual([
      'f0.kojo', 'f1.kojo', 'f2.kojo',
    ]);
  });

  it('searchAll：query 空显式 INVALID_ARGS；hits 摊平 + 相对路径 + 显式 truncated', async () => {
    const { kernel } = fakeKernel();
    const io = createKernelIo(fakeIoDeps(kernel));
    await expect(io.searchAll({ query: '' }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    const out = (await io.searchAll({ query: 'hit', maxResults: 1 }, scope)) as Record<string, unknown>;
    expect(out['total']).toBe(2);
    expect(out['truncated']).toBe(true);
    expect((out['hits'] as Record<string, unknown>[])[0]).toEqual({ path: 'x.kojo', line: 2, preview: 'hit' });
  });

  it('项目未打开 ⇒ RESOURCE_UNAVAILABLE（不空串冒充成功）', async () => {
    const { kernel } = fakeKernel({ current: null });
    const io = createKernelIo(fakeIoDeps(kernel));
    await expect(io.projectInfo({}, scope)).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    await expect(io.fileTree({}, scope)).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    await expect(io.searchAll({ query: 'x' }, scope)).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });
});

/* ------------------------------- runSupplemental ------------------------------- */

describe('runSupplemental：只读 IO 腿', () => {
  it('commands.list：投影 id/title/description/tier + 截断', async () => {
    const { kernel } = fakeKernel();
    const sup = createRunSupplemental(fakeIoDeps(kernel));
    const out = (await sup('commands.list', { maxResults: 1 }, scope)) as Record<string, unknown>;
    expect(out['total']).toBe(2);
    expect(out['truncated']).toBe(true);
    expect(out['commands']).toEqual([{ id: 'a.open', title: 'A' }]);
  });

  it('fs.readFile：相对路径域内解析 + maxChars 截断 + 显式 truncated', async () => {
    const { kernel } = fakeKernel();
    const invoke: McpInvokeLike = vi.fn(async (cmd: string) => (cmd === 'read_file_bytes' ? 'x'.repeat(100) : null));
    const sup = createRunSupplemental(fakeIoDeps(kernel, { invoke }));
    const out = (await sup('fs.readFile', { relPath: 'a.txt', maxChars: 10 }, scope)) as Record<string, unknown>;
    expect(out['path']).toBe('a.txt');
    expect(out['truncated']).toBe(true);
    expect(out['textLength']).toBe(100);
    expect((out['text'] as string).length).toBe(10);
    expect(invoke).toHaveBeenCalledWith('read_file_bytes', { path: 'D:/proj/a.txt' });
  });

  it('fs.stat：不存在 ⇒ {exists:false} 是真读数（不编造 size=0）', async () => {
    const { kernel } = fakeKernel();
    const sup = createRunSupplemental(fakeIoDeps(kernel, {
      invoke: async () => null,
    }));
    const absent = (await sup('fs.stat', { relPath: 'nope.txt' }, scope)) as Record<string, unknown>;
    expect(absent).toEqual({ path: 'nope.txt', exists: false });
  });

  it('fs.stat：存在时投影 size/mtimeMs/isDirectory', async () => {
    const { kernel } = fakeKernel();
    const sup = createRunSupplemental(fakeIoDeps(kernel, {
      invoke: async () => ({ size: 42, mtimeMs: 7, isDirectory: false }),
    }));
    const out = (await sup('fs.stat', { relPath: 'a.txt' }, scope)) as Record<string, unknown>;
    expect(out).toMatchObject({ path: 'a.txt', exists: true, size: 42, mtimeMs: 7 });
  });

  it('io.listDir：relPath 缺省 = 项目根；条目相对化 + 截断', async () => {
    const { kernel } = fakeKernel();
    const sup = createRunSupplemental(fakeIoDeps(kernel, {
      invoke: async () => [
        { name: 'a', path: 'D:\\proj\\a', isDirectory: true },
        { name: 'b', path: 'D:\\proj\\b', isDirectory: false },
      ],
    }));
    const out = (await sup('io.listDir', {}, scope)) as Record<string, unknown>;
    expect(out['path']).toBe('.');
    expect(out['total']).toBe(2);
    expect(out['truncated']).toBe(false);
    expect(out['entries']).toEqual([
      { name: 'a', path: 'a', isDirectory: true },
      { name: 'b', path: 'b', isDirectory: false },
    ]);
  });

  it('io.workspaceRoots：透传 Rust 原语读数 + 截断', async () => {
    const { kernel } = fakeKernel();
    const sup = createRunSupplemental(fakeIoDeps(kernel, {
      invoke: async (cmd: string) => (cmd === 'workspace_roots' ? ['D:/proj', 'E:/lib', 'F:/x'] : null),
    }));
    const out = (await sup('io.workspaceRoots', { maxResults: 2 }, scope)) as Record<string, unknown>;
    expect(out).toMatchObject({ total: 3, truncated: true });
    expect(out['roots']).toEqual(['D:/proj', 'E:/lib']);
  });

  it('workspace.searchAll：scope=sources 用契约字段目录做根（不硬编码领域）', async () => {
    const { kernel } = fakeKernel();
    const calls: McpSearchRequestLike[] = [];
    const sup = createRunSupplemental(fakeIoDeps(kernel, {
      searchInFiles: async (request: McpSearchRequestLike) => {
        calls.push(request);
        return { files: [], totalMatches: 0, truncated: false, filesScanned: 0, elapsedMs: 0, skipped: {} } satisfies McpSearchResultLike;
      },
    }));
    await sup('workspace.searchAll', { query: 'q', scope: 'sources' }, scope);
    expect(calls[0]?.roots).toEqual(['D:\\proj\\k']);
    await sup('workspace.searchAll', { query: 'q' }, scope);
    expect(calls[1]?.roots).toEqual(['D:\\proj']);
  });

  it('路径逃逸（fs.readFile 收 `..`）⇒ INVALID_ARGS，invoke 绝不触达', async () => {
    const { kernel } = fakeKernel();
    const invoke = vi.fn(async () => 'leak');
    const sup = createRunSupplemental(fakeIoDeps(kernel, { invoke }));
    await expect(sup('fs.readFile', { relPath: '../secret.txt' }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(sup('fs.readFile', { relPath: 'C:/boot.ini' }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('runSupplemental：仍 NOT_WIRED 的写类与危险动作', () => {
  const { kernel } = fakeKernel();
  const sup = createRunSupplemental(fakeIoDeps(kernel));
  // fileTree.create / update / remove / rename 四枚写腿已接真实写执行（第四波，见「写腿」
  // 与 mcp-write-legs.test.ts）；problems.quickFix 已接线（Wave4 余项①：actionId 台账 +
  // 模型内受控 apply，见 mcp-quickfix-apply.test.ts）；其余危险动作仍缺宿主授权面 ⇒ 显式 NOT_WIRED。
  // 已接线的名字不许留在缺席清单里。
  const NOT_WIRED_NAMES = [
    'diff.compare', 'state.replay', 'preview.document',
    'remove_path', 'launcher_start', 'market_install', '完全未知',
  ];
  it.each(NOT_WIRED_NAMES)('%s ⇒ 显式 NOT_WIRED（写明缺什么，不造假实现）', async (name) => {
    await expect(sup(name, {}, scope)).rejects.toMatchObject({ code: 'NOT_WIRED' });
  });

  it('problems.quickFix 已接线：不在台账的 actionId ⇒ 显式 [E_QUICKFIX_UNLISTED]（不再 NOT_WIRED、不假成功）', async () => {
    const { kernel: k } = fakeKernel();
    const s = createRunSupplemental(fakeIoDeps(k));
    await expect(s('problems.quickFix', { actionId: 'x', line: 1, column: 1 }, scope)).rejects.toMatchObject({
      code: 'TOOL_EXECUTION_FAILED',
      message: expect.stringContaining('[E_QUICKFIX_UNLISTED]'),
    });
  });
});

/* ---------------- 写腿（fileTree.create / update / remove / rename 四枚） ---------------- */

describe('第四张表 approvedRoots 复核（写闸一，MCP 侧）', () => {
  it('前缀必须落在分隔符边界（/docs 不吃 /docs2）；大小写不敏感；等于根本身算域内', () => {
    expect(isWithinApprovedRoots(['docs'], 'docs/a.txt')).toBe(true);
    expect(isWithinApprovedRoots(['docs'], 'docs')).toBe(true);
    expect(isWithinApprovedRoots(['docs'], 'docs2/a.txt')).toBe(false);
    expect(isWithinApprovedRoots(['docs'], 'docsy.txt')).toBe(false);
    expect(isWithinApprovedRoots(['Docs/Sub'], 'docs/sub/x.txt')).toBe(true);
    expect(isWithinApprovedRoots(['a/b'], 'a/bc.txt')).toBe(false);
    expect(isWithinApprovedRoots([], 'docs/a.txt')).toBe(false);
  });

  it('形态不合法的根防御性跳过（只收窄不减宽，fail-closed）', () => {
    expect(isWithinApprovedRoots(['../evil'], 'evil/x.txt')).toBe(false);
    expect(isWithinApprovedRoots(['C:/abs'], 'abs/x.txt')).toBe(false);
    expect(isWithinApprovedRoots(['../evil', 'docs'], 'docs/x.txt')).toBe(true);
  });

  it('域外目标 ⇒ assertMcpWriteDomain 抛 WRITE_DISABLED；空表文案写明「没有任何已批准写根」', () => {
    expect(() => assertMcpWriteDomain(['docs'], 'secret.txt')).toThrow(McpFailure);
    expect(() => assertMcpWriteDomain(['docs'], 'secret.txt')).toThrow(/approvedRoots/);
    expect(() => assertMcpWriteDomain([], 'docs/a.txt')).toThrow(/没有任何已批准写根/);
    expect(() => assertMcpWriteDomain(['docs'], 'docs/a.txt')).not.toThrow();
  });
});

describe('写腿：fileTree.create / fileTree.update（双闸叠加，走内核 io 既有写通道）', () => {
  it('create file 带内容：独占创建 + writeText（既有保存语义）+ file.changed(add) 广播', async () => {
    const createSpy = vi.fn(async () => true);
    const writeSpy = vi.fn(async () => undefined);
    const emitSpy = vi.fn();
    const { kernel } = fakeKernel({ createFileExclusive: createSpy, writeText: writeSpy, busEmit: emitSpy });
    const sup = createRunSupplemental(fakeIoDeps(kernel));
    const out = (await sup('fileTree.create', { relPath: 'docs/new.kojo', kind: 'file', content: 'hello' }, writeScope)) as Record<string, unknown>;
    expect(out).toEqual({ path: 'docs/new.kojo', kind: 'file', created: true, contentChars: 5, refreshed: true });
    expect(createSpy).toHaveBeenCalledWith('D:/proj/docs/new.kojo');
    expect(writeSpy).toHaveBeenCalledWith('D:/proj/docs/new.kojo', 'hello');
    expect(emitSpy).toHaveBeenCalledWith('file.changed', { kind: 'add', path: 'D:/proj/docs/new.kojo' });
  });

  it('create file 空内容：独占创建后不再走 writeText（内容就是创建原语的空文件）', async () => {
    const createSpy = vi.fn(async () => true);
    const writeSpy = vi.fn(async () => undefined);
    const { kernel } = fakeKernel({ createFileExclusive: createSpy, writeText: writeSpy });
    const sup = createRunSupplemental(fakeIoDeps(kernel));
    const out = (await sup('fileTree.create', { relPath: 'docs/empty.txt', kind: 'file', content: '' }, writeScope)) as Record<string, unknown>;
    expect(out).toMatchObject({ created: true, contentChars: 0 });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('create directory：独占建目录；content 入参显式拒绝（不静默吞掉）', async () => {
    const createDirSpy = vi.fn(async () => true);
    const emitSpy = vi.fn();
    const { kernel } = fakeKernel({ createDirExclusive: createDirSpy, busEmit: emitSpy });
    const sup = createRunSupplemental(fakeIoDeps(kernel));
    const out = (await sup('fileTree.create', { relPath: 'docs/sub', kind: 'directory' }, writeScope)) as Record<string, unknown>;
    expect(out).toEqual({ path: 'docs/sub', kind: 'directory', created: true, refreshed: true });
    expect(createDirSpy).toHaveBeenCalledWith('D:/proj/docs/sub');
    expect(emitSpy).toHaveBeenCalledWith('file.changed', { kind: 'add', path: 'D:/proj/docs/sub' });
    await expect(
      sup('fileTree.create', { relPath: 'docs/sub', kind: 'directory', content: 'x' }, writeScope),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(createDirSpy).toHaveBeenCalledTimes(1);
  });

  it('create 幂等冲突语义：目标已存在 ⇒ TOOL_EXECUTION_FAILED，绝不覆盖（写原语零额外调用）', async () => {
    const createSpy = vi.fn(async () => false);
    const writeSpy = vi.fn(async () => undefined);
    const emitSpy = vi.fn();
    const { kernel } = fakeKernel({ createFileExclusive: createSpy, writeText: writeSpy, busEmit: emitSpy });
    const sup = createRunSupplemental(fakeIoDeps(kernel));
    await expect(
      sup('fileTree.create', { relPath: 'docs/exists.txt', kind: 'file', content: 'x' }, writeScope),
    ).rejects.toMatchObject({ code: 'TOOL_EXECUTION_FAILED', message: expect.stringContaining('已存在') });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('create kind 非法 ⇒ INVALID_ARGS（写原语不触达）', async () => {
    const createSpy = vi.fn(async () => true);
    const { kernel } = fakeKernel({ createFileExclusive: createSpy });
    const sup = createRunSupplemental(fakeIoDeps(kernel));
    await expect(sup('fileTree.create', { relPath: 'docs/x', kind: 'symlink' }, writeScope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(sup('fileTree.create', { relPath: 'docs/x' }, writeScope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('update 成功：先 exists 判存在（true）⇒ writeText 全文替换 + file.changed(change) 广播', async () => {
    const existsSpy = vi.fn(async () => true);
    const writeSpy = vi.fn(async () => undefined);
    const emitSpy = vi.fn();
    const { kernel } = fakeKernel({ exists: existsSpy, writeText: writeSpy, busEmit: emitSpy });
    const sup = createRunSupplemental(fakeIoDeps(kernel));
    const out = (await sup('fileTree.update', { relPath: 'docs/a.kojo', content: 'body\n' }, writeScope)) as Record<string, unknown>;
    expect(out).toEqual({ path: 'docs/a.kojo', updated: true, textLength: 5, refreshed: true });
    expect(existsSpy).toHaveBeenCalledWith('D:/proj/docs/a.kojo');
    expect(writeSpy).toHaveBeenCalledWith('D:/proj/docs/a.kojo', 'body\n');
    expect(emitSpy).toHaveBeenCalledWith('file.changed', { kind: 'change', path: 'D:/proj/docs/a.kojo' });
  });

  it('update 幂等：同内容重写两次都成功（writeText 两次调用，零改动快道是内核自己的语义）', async () => {
    const writeSpy = vi.fn(async () => undefined);
    const { kernel } = fakeKernel({ exists: async () => true, writeText: writeSpy });
    const sup = createRunSupplemental(fakeIoDeps(kernel));
    for (let i = 0; i < 2; i += 1) {
      const out = (await sup('fileTree.update', { relPath: 'docs/a.txt', content: 'same' }, writeScope)) as Record<string, unknown>;
      expect(out).toMatchObject({ updated: true });
    }
    expect(writeSpy).toHaveBeenCalledTimes(2);
  });

  it('update 不存在 ⇒ TOOL_EXECUTION_FAILED（绝不静默改成 create 语义），writeText 零调用', async () => {
    const writeSpy = vi.fn(async () => undefined);
    const { kernel } = fakeKernel({ exists: async () => false, writeText: writeSpy });
    const sup = createRunSupplemental(fakeIoDeps(kernel));
    await expect(
      sup('fileTree.update', { relPath: 'docs/ghost.txt', content: 'x' }, writeScope),
    ).rejects.toMatchObject({ code: 'TOOL_EXECUTION_FAILED', message: expect.stringContaining('不存在') });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('approvedRoots 外 ⇒ WRITE_DISABLED（写闸一先拦），写原语零触达；空表同样', async () => {
    const createSpy = vi.fn(async () => true);
    const writeSpy = vi.fn(async () => undefined);
    const { kernel } = fakeKernel({ createFileExclusive: createSpy, exists: async () => true, writeText: writeSpy });
    const sup = createRunSupplemental(fakeIoDeps(kernel));
    const outside: McpSessionScope = { ...writeScope, approvedRoots: ['other'] };
    await expect(
      sup('fileTree.create', { relPath: 'docs/x.txt', kind: 'file' }, outside),
    ).rejects.toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining('写闸一') });
    await expect(
      sup('fileTree.update', { relPath: 'docs/a.txt', content: 'x' }, outside),
    ).rejects.toMatchObject({ code: 'WRITE_DISABLED' });
    const none: McpSessionScope = { ...writeScope, approvedRoots: [] };
    await expect(
      sup('fileTree.update', { relPath: 'docs/a.txt', content: 'x' }, none),
    ).rejects.toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining('没有任何已批准写根') });
    expect(createSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('路径逃逸 ⇒ INVALID_ARGS（写闸之前），写原语零触达', async () => {
    const createSpy = vi.fn(async () => true);
    const writeSpy = vi.fn(async () => undefined);
    const { kernel } = fakeKernel({ createFileExclusive: createSpy, exists: async () => true, writeText: writeSpy });
    const sup = createRunSupplemental(fakeIoDeps(kernel));
    await expect(
      sup('fileTree.create', { relPath: '../escape.txt', kind: 'file' }, writeScope),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(
      sup('fileTree.update', { relPath: 'C:/boot.ini', content: 'x' }, writeScope),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(
      sup('fileTree.update', { relPath: 'a//b.txt', content: 'x' }, writeScope),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(createSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('内核写域拒绝（WriteNotAllowedError）⇒ WRITE_DISABLED 透传（写闸二，正确行为不是缺陷）', async () => {
    const notAllowed = (): Promise<boolean> => {
      const err = new Error("这个位置在只读范围内，不能写入：D:/proj/docs/x.txt（要写就先在「只读」徽章处批准该目录）。");
      err.name = 'WriteNotAllowedError';
      return Promise.reject(err);
    };
    const writeNotAllowed = (): Promise<void> => {
      const err = new Error("这个位置在只读范围内，不能写入：D:/proj/docs/a.txt（要写就先在「只读」徽章处批准该目录）。");
      err.name = 'WriteNotAllowedError';
      return Promise.reject(err);
    };
    const writeSpy = vi.fn(writeNotAllowed);
    const { kernel } = fakeKernel({ createFileExclusive: notAllowed, exists: async () => true, writeText: writeSpy });
    const sup = createRunSupplemental(fakeIoDeps(kernel));
    await expect(
      sup('fileTree.create', { relPath: 'docs/x.txt', kind: 'file' }, writeScope),
    ).rejects.toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining('写闸二') });
    await expect(
      sup('fileTree.update', { relPath: 'docs/a.txt', content: 'x' }, writeScope),
    ).rejects.toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining('内核写允许域') });
  });

  it('写原语其它失败原样上抛（registry 兜底包 TOOL_EXECUTION_FAILED，不洗码、不编造）', async () => {
    const { kernel } = fakeKernel({
      exists: async () => true,
      writeText: async () => {
        throw new Error('EIO: disk full');
      },
    });
    const sup = createRunSupplemental(fakeIoDeps(kernel));
    await expect(sup('fileTree.update', { relPath: 'docs/a.txt', content: 'x' }, writeScope)).rejects.toThrow('EIO: disk full');
  });

  it('缺写原语（测试假件 / 精简桥）⇒ NOT_WIRED，路径与域闸之后才报', async () => {
    const sup = createRunSupplemental(fakeIoDeps(fakeKernel().kernel));
    await expect(
      sup('fileTree.create', { relPath: 'docs/x.txt', kind: 'file' }, writeScope),
    ).rejects.toMatchObject({ code: 'NOT_WIRED', message: expect.stringContaining('createFileExclusive') });
    await expect(
      sup('fileTree.create', { relPath: 'docs/sub', kind: 'directory' }, writeScope),
    ).rejects.toMatchObject({ code: 'NOT_WIRED', message: expect.stringContaining('createDirExclusive') });
    await expect(
      sup('fileTree.update', { relPath: 'docs/a.txt', content: 'x' }, writeScope),
    ).rejects.toMatchObject({ code: 'NOT_WIRED' });
    // 域外仍在 NOT_WIRED 之前拦下（闸序：路径 → 域 → 原语）。
    const outside: McpSessionScope = { ...writeScope, approvedRoots: [] };
    await expect(
      sup('fileTree.create', { relPath: 'docs/x.txt', kind: 'file' }, outside),
    ).rejects.toMatchObject({ code: 'WRITE_DISABLED' });
  });

  it('bus.emit 缺席 ⇒ 写照常成功、refreshed:false 如实标注（尽力刷新，不造第二套通道）', async () => {
    const { kernel } = fakeKernel({ createFileExclusive: async () => true, writeText: async () => undefined });
    const sup = createRunSupplemental(fakeIoDeps(kernel));
    const out = (await sup('fileTree.create', { relPath: 'docs/x.txt', kind: 'file', content: 'a' }, writeScope)) as Record<string, unknown>;
    expect(out).toMatchObject({ created: true, refreshed: false });
  });

  it('项目未打开 / 内核缺席 ⇒ RESOURCE_UNAVAILABLE（不静默）', async () => {
    const closed = createRunSupplemental(fakeIoDeps(fakeKernel({ current: null }).kernel));
    await expect(
      closed('fileTree.update', { relPath: 'docs/a.txt', content: 'x' }, writeScope),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    const noKernel = createRunSupplemental(fakeIoDeps(null));
    await expect(
      noKernel('fileTree.create', { relPath: 'docs/a.txt', kind: 'file' }, writeScope),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });
});

/* ------------------------------- UI 补腿 ------------------------------- */

describe('runSupplemental UI 腿（document.active / editor.info / selfCheck / problems / lang.*）', () => {
  it('document.active：正文按 maxChars 截断 + 显式 truncated + 光标真实值', async () => {
    const ws = fakeWorkspace({ model: fakeModel('y'.repeat(50)), cursor: { line: 3, column: 2 } });
    const ui = buildUiSupplemental(fakeDeps({ getWorkspace: () => ws }), null);
    const out = (await ui.get('document.active')!({ maxChars: 10 }, scope)) as Record<string, unknown>;
    expect(out).toMatchObject({
      path: 'a.kojo',
      language: 'kojo',
      cursor: { line: 3, column: 2 },
      textLength: 50,
      truncated: true,
    });
    expect((out['text'] as string).length).toBe(10);
  });

  it('editor.info：section 过滤（editor / document / all），不编造字段', async () => {
    const ui = buildUiSupplemental(fakeDeps(), null);
    const all = (await ui.get('editor.info')!({}, scope)) as Record<string, unknown>;
    expect(all['editor']).toMatchObject({ languageId: 'kojo', eol: 'lf' });
    expect(all['document']).toMatchObject({ path: 'a.kojo' });
    const doc = (await ui.get('editor.info')!({ section: 'document' }, scope)) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(['document']);
  });

  it('editor.selfCheck：convention.linter 缺席 ⇒ NOT_WIRED；报告缺席 ⇒ 显式 note（非「零失败」）', async () => {
    const { kernel: noLinter } = fakeKernel();
    const ui1 = buildUiSupplemental(fakeDeps(), noLinter);
    await expect(ui1.get('editor.selfCheck')!({}, scope)).rejects.toMatchObject({ code: 'NOT_WIRED' });

    const { kernel: idle } = fakeKernel({ linter: { report: () => null } });
    const ui2 = buildUiSupplemental(fakeDeps(), idle);
    const idleOut = (await ui2.get('editor.selfCheck')!({}, scope)) as Record<string, unknown>;
    expect(idleOut['note']).toContain('校验尚未运行');

    const { kernel: ran } = fakeKernel({ linter: { report: () => ({ failedRules: [{ ruleId: 'r1', error: 'boom' }] }) } });
    const ui3 = buildUiSupplemental(fakeDeps(), ran);
    const out = (await ui3.get('editor.selfCheck')!({}, scope)) as Record<string, unknown>;
    expect(out).toMatchObject({ total: 1, truncated: false });
    expect(out['items']).toEqual([{ rule: 'r1', message: 'boom', severity: 'error' }]);
  });

  it('problems.diagnostics：全量 marker 投影 severity 名字映射 + 截断', async () => {
    const monaco = fakeMonaco([
      { resource: {}, severity: 8, message: 'e', startLineNumber: 1 },
      { resource: {}, severity: 4, message: 'w', startLineNumber: 2 },
    ]);
    const ui = buildUiSupplemental(fakeDeps({ getMonaco: () => monaco }), null);
    const out = (await ui.get('problems.diagnostics')!({}, scope)) as Record<string, unknown>;
    expect(out['total']).toBe(2);
    expect((out['items'] as Record<string, unknown>[]).map((i) => i['severity'])).toEqual(['error', 'warning']);
  });

  it('lang.foldingRanges / lang.highlightsAt / lang.signatureAt：provider 直调投影', async () => {
    const service = registryWith({
      foldingRangeProvider: [{ provideFoldingRanges: () => [{ start: 1, end: 5, kind: 'region' }] }],
      documentHighlightProvider: [{ provideDocumentHighlights: () => [{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 }, kind: 1 }] }],
      signatureHelpProvider: [{ provideSignatureHelp: () => ({ signatures: [{ label: 'fn(a, b)', parameters: ['a', 'b'] }], activeSignature: 0, activeParameter: 1 }) }],
    });
    const ui = buildUiSupplemental(fakeDeps({ getFeaturesService: () => service }), null);
    const folding = (await ui.get('lang.foldingRanges')!({}, scope)) as Record<string, unknown>;
    expect(folding['items']).toEqual([{ startLine: 1, endLine: 5, kind: 'region' }]);
    expect(folding['providers']).toBe(1);
    const hl = (await ui.get('lang.highlightsAt')!({ line: 2, column: 1 }, scope)) as Record<string, unknown>;
    expect(hl['items']).toEqual([{ line: 2, column: 1, endLine: 2, endColumn: 4, kind: 1 }]);
    const sig = (await ui.get('lang.signatureAt')!({ line: 1, column: 4 }, scope)) as Record<string, unknown>;
    expect(sig).toMatchObject({ label: 'fn(a, b)', activeParameter: 1, parameters: ['a', 'b'] });
  });

  it('lang.markers：当前文档作用域（带 resource 过滤）', async () => {
    const model = fakeModel();
    const monaco = fakeMonaco([
      { resource: model.uri, severity: 8, message: 'doc', startLineNumber: 1 },
      { resource: {}, severity: 8, message: 'other', startLineNumber: 1 },
    ]);
    const ui = buildUiSupplemental(fakeDeps({ getWorkspace: () => fakeWorkspace({ model, monaco }) }), null);
    const out = (await ui.get('lang.markers')!({}, scope)) as Record<string, unknown>;
    expect(out['total']).toBe(1);
    expect((out['items'] as Record<string, unknown>[])[0]?.['message']).toBe('doc');
  });

  it('无活动编辑器 ⇒ document.active / editor.info 显式 NOT_WIRED（不静默）', async () => {
    const ui = buildUiSupplemental(fakeDeps({ getWorkspace: () => null }), null);
    await expect(ui.get('document.active')!({}, scope)).rejects.toMatchObject({ code: 'NOT_WIRED' });
    await expect(ui.get('editor.info')!({}, scope)).rejects.toMatchObject({ code: 'NOT_WIRED' });
  });
});

/* ------------------------------- 语义 8 腿 ------------------------------- */

describe('语义 8 腿（判据腿优先 + provider 纯读直调）', () => {
  it('恰 8 键、全函数', () => {
    const readers = buildSemanticReaders(fakeDeps());
    expect(Object.keys(readers).sort()).toEqual([
      'codeActionsAt', 'definitionAt', 'diagnostics', 'documentSymbols',
      'hoverAt', 'referencesAt', 'suggestAt', 'tokens',
    ]);
  });

  it('definitionAt：走判据腿投影相对路径（provider 通道绝不触达）', async () => {
    const providerTouched = vi.fn();
    const deps = fakeDeps({
      getFeaturesService: () => registryWith({ definitionProvider: [{ provideDefinition: providerTouched }] }),
    });
    const readers = buildSemanticReaders(deps);
    const out = (await readers.definitionAt!({ line: 1, column: 1 }, scope)) as Record<string, unknown>;
    expect(out['items']).toEqual([{ path: 'b.kojo', line: 3, column: 2 }]);
    expect(out['total']).toBe(1);
    expect(providerTouched).not.toHaveBeenCalled();
  });

  it('判据腿缺席 ⇒ NOT_WIRED（MCP 只读面不退到有导航副作用的 provider 通道）', async () => {
    const readers = buildSemanticReaders(fakeDeps({ getLegs: () => null }));
    await expect(readers.definitionAt!({ line: 1, column: 1 }, scope)).rejects.toMatchObject({ code: 'NOT_WIRED' });
    await expect(readers.referencesAt!({ line: 1, column: 1 }, scope)).rejects.toMatchObject({ code: 'NOT_WIRED' });
  });

  it('referencesAt：includeDeclaration=false 过滤 definition 种类；total 如实', async () => {
    const readers = buildSemanticReaders(fakeDeps());
    const out = (await readers.referencesAt!({ line: 1, column: 1 }, scope)) as Record<string, unknown>;
    expect((out['items'] as unknown[]).length).toBe(2);
    const filtered = (await readers.referencesAt!({ line: 1, column: 1, includeDeclaration: false }, scope)) as Record<string, unknown>;
    expect((filtered['items'] as Record<string, unknown>[]).map((i) => i['path'])).toEqual(['c.kojo']);
  });

  it('hoverAt / suggestAt：provider 直调投影 + 三态账（providers/answered）', async () => {
    const service = registryWith({
      hoverProvider: [{ provideHover: () => ({ contents: [{ value: 'the doc' }] }) }],
      completionProvider: [{ provideCompletionItems: () => ({ suggestions: [{ label: 'foo', detail: 'd', kind: 5 }] }) }],
    });
    const readers = buildSemanticReaders(fakeDeps({ getFeaturesService: () => service }));
    const hover = (await readers.hoverAt!({ line: 1, column: 1 }, scope)) as Record<string, unknown>;
    expect(hover).toMatchObject({ text: 'the doc', providers: 1, answered: 1, line: 1, column: 1 });
    const suggest = (await readers.suggestAt!({ line: 1, column: 1 }, scope)) as Record<string, unknown>;
    expect(suggest['items']).toEqual([{ label: 'foo', detail: 'd', kind: 5 }]);
    expect(suggest['count']).toBe(1);
  });

  it('无人应答（providers=0）如实入账：空结果不冒充「有内容」', async () => {
    const readers = buildSemanticReaders(fakeDeps({ getFeaturesService: () => registryWith({ hoverProvider: [] }) }));
    const hover = (await readers.hoverAt!({ line: 1, column: 1 }, scope)) as Record<string, unknown>;
    expect(hover['providers']).toBe(0);
    expect(hover['answered']).toBe(0);
    expect(hover['text']).toBe('');
  });

  it('documentSymbols：父子压平成 depth', async () => {
    const service = registryWith({
      documentSymbolProvider: [{ provideDocumentSymbols: () => [{ name: 'F', kind: 1, children: [{ name: 'C', kind: 2 }] }] }],
    });
    const readers = buildSemanticReaders(fakeDeps({ getFeaturesService: () => service }));
    const out = (await readers.documentSymbols!({}, scope)) as Record<string, unknown>;
    expect(out['items']).toEqual([
      { name: 'F', kind: 1, depth: 0 },
      { name: 'C', kind: 2, depth: 1 },
    ]);
  });

  it('tokens：逐行窗口 + 窗口上限显式 truncated', async () => {
    const model = fakeModel('a\nb\nc');
    const monaco = fakeMonaco([], [[{ type: 'kw.kojo', offset: 0 }]]);
    const readers = buildSemanticReaders(fakeDeps({ getWorkspace: () => fakeWorkspace({ model, monaco }) }));
    const out = (await readers.tokens!({ lineFrom: 1, lineTo: 2 }, scope)) as Record<string, unknown>;
    expect((out['items'] as Record<string, unknown>[]).map((i) => i['line'])).toEqual([1, 2]);
    expect(out['truncated']).toBe(false);
    const over = (await readers.tokens!({ lineFrom: 1, lineTo: 999 }, scope)) as Record<string, unknown>;
    expect(over['truncated']).toBe(true);
  });

  it('codeActionsAt：只读投影 hasEdit/isPreferred + 宿主签发 actionId；本腿绝不 apply', async () => {
    const provider = {
      provideCodeActions: () => ({
        actions: [
          {
            title: 'fix it',
            kind: 'quickfix',
            isPreferred: true,
            edit: { edits: [{}] },
            // 宿主 provideCodeActionsFor 的真实回包形态：command.arguments[0] = 反查 id
            command: { id: 'kojo.codeAction.run', title: 'fix it', arguments: ['pane-1:sugar-quickfix#7'] },
          },
          { title: 'refactor', kind: 'refactor.extract' },
        ],
      }),
    };
    const readers = buildSemanticReaders(fakeDeps({ getFeaturesService: () => registryWith({ codeActionProvider: [provider] }) }));
    const out = (await readers.codeActionsAt!({ line: 1, column: 1 }, scope)) as Record<string, unknown>;
    expect(out['items']).toEqual([
      { title: 'fix it', kind: 'quickfix', isPreferred: true, hasEdit: true, actionId: 'pane-1:sugar-quickfix#7' },
      { title: 'refactor', kind: 'refactor.extract', isPreferred: false, hasEdit: false },
    ]);
  });

  it('diagnostics：当前文档 marker → 可读投影', async () => {
    const model = fakeModel();
    const monaco = fakeMonaco([{ resource: model.uri, severity: 8, message: 'boom', startLineNumber: 2, startColumn: 3 }]);
    const readers = buildSemanticReaders(fakeDeps({ getWorkspace: () => fakeWorkspace({ model, monaco }) }));
    const out = (await readers.diagnostics!({}, scope)) as Record<string, unknown>;
    expect(out['items']).toEqual([{ message: 'boom', line: 2, column: 3, severity: 'error' }]);
  });

  it('provider 挂死 ⇒ 超时归 null，answered=0（读数器不被拖死）', async () => {
    const service = registryWith({
      hoverProvider: [{ provideHover: () => new Promise(() => undefined) }],
    });
    const readers = buildSemanticReaders(fakeDeps({ getFeaturesService: () => service }));
    const out = (await readers.hoverAt!({ line: 1, column: 1 }, scope)) as Record<string, unknown>;
    expect(out['answered']).toBe(0);
    expect(out['text']).toBe('');
  }, 10_000);

  it('位置脏值 ⇒ INVALID_ARGS（schema 只保证 integer，负数在这里显式拒绝）', async () => {
    const readers = buildSemanticReaders(fakeDeps());
    await expect(readers.definitionAt!({ line: 'x', column: 1 }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('无活动编辑器 ⇒ 全部位置腿 NOT_WIRED', async () => {
    const readers = buildSemanticReaders(fakeDeps({ getWorkspace: () => null }));
    for (const leg of ['definitionAt', 'referencesAt', 'hoverAt', 'suggestAt', 'codeActionsAt'] as const) {
      await expect(readers[leg]!({ line: 1, column: 1 }, scope)).rejects.toMatchObject({ code: 'NOT_WIRED' });
    }
    await expect(readers.diagnostics!({}, scope)).rejects.toMatchObject({ code: 'NOT_WIRED' });
    await expect(readers.documentSymbols!({}, scope)).rejects.toMatchObject({ code: 'NOT_WIRED' });
  });
});

/* ----------------------- 任务 A：截断账目（SlimPage） ----------------------- */
/**
 * 铁律 4：total 是截断前真实条目数，绝不是被 cap 洗过的 items.length；
 * 脏条目整条丢弃 / 封顶都靠 truncated 显式解释；旧字段 items/total/count/providers/answered additive 全留。
 * cap 口径（real-sources.ts）：SYMBOL_LIMIT=200 / REFERENCE_LIMIT=50 / DEFINITION_LIMIT=20 /
 * SUGGEST_LIMIT=50 / CODE_ACTION_LIMIT=30。
 */
describe('任务 A：截断账目（total 真实 / truncated 可见 / additive 兼容）', () => {
  const manySymbolNodes = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `S${i}`, kind: 1 }));
  const manyLegLocations = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ filePath: 'D:/proj/c.kojo', line: i + 1 }));

  it('documentSymbols：超过 SYMBOL_LIMIT → total 是截断前真实总数、truncated:true、items 恰为 cap', async () => {
    const service = registryWith({
      documentSymbolProvider: [{ provideDocumentSymbols: () => manySymbolNodes(201) }],
    });
    const readers = buildSemanticReaders(fakeDeps({ getFeaturesService: () => service }));
    const out = (await readers.documentSymbols!({}, scope)) as Record<string, unknown>;
    expect(out['total']).toBe(201); // 真实总数，不是被 cap 洗过的 200
    expect((out['items'] as unknown[]).length).toBe(200); // SYMBOL_LIMIT 封顶
    expect(out['truncated']).toBe(true);
  });

  it('documentSymbols：未超 cap（父子树 2 个）→ total===items.length、truncated:false', async () => {
    const service = registryWith({
      documentSymbolProvider: [{ provideDocumentSymbols: () => [{ name: 'F', kind: 1, children: [{ name: 'C', kind: 2 }] }] }],
    });
    const readers = buildSemanticReaders(fakeDeps({ getFeaturesService: () => service }));
    const out = (await readers.documentSymbols!({}, scope)) as Record<string, unknown>;
    expect(out['total']).toBe(2);
    expect((out['items'] as unknown[]).length).toBe(2);
    expect(out['truncated']).toBe(false);
  });

  it('documentSymbols：脏符号（无 name / 空名 / name 非字符串 / 非对象）不污染 total，旧字段仍在', async () => {
    const dirty: unknown[] = [
      { name: 'good', kind: 1 },
      {}, // 缺 name
      { name: '' }, // 空名
      { name: 5 }, // name 非字符串
      null,
      42,
      'str',
      { name: 'alsoGood', kind: 2 },
    ];
    const service = registryWith({
      documentSymbolProvider: [{ provideDocumentSymbols: () => dirty }],
    });
    const readers = buildSemanticReaders(fakeDeps({ getFeaturesService: () => service }));
    const out = (await readers.documentSymbols!({}, scope)) as Record<string, unknown>;
    expect(out['total']).toBe(2); // 只有 good / alsoGood 算符号
    expect((out['items'] as Record<string, unknown>[]).map((i) => i['name'])).toEqual(['good', 'alsoGood']);
    expect(out['truncated']).toBe(false);
    // additive：旧消费方依赖的字段一个不少
    expect(out).toHaveProperty('items');
    expect(out).toHaveProperty('total');
    expect(out).toHaveProperty('providers');
    expect(out).toHaveProperty('answered');
  });

  it('referencesAt：超过 REFERENCE_LIMIT → total=kept 真实数、truncated:true、items 恰为 cap', async () => {
    const readers = buildSemanticReaders(fakeDeps({
      getLegs: () => fakeLegs({ references: () => ({ path: 'c.kojo', locations: manyLegLocations(51) }) }),
    }));
    const out = (await readers.referencesAt!({ line: 1, column: 1 }, scope)) as Record<string, unknown>;
    expect(out['total']).toBe(51);
    expect((out['items'] as unknown[]).length).toBe(50);
    expect(out['truncated']).toBe(true);
  });

  it('referencesAt：未超 cap（默认 fakeLegs 2 个）→ total===items.length、truncated:false', async () => {
    const readers = buildSemanticReaders(fakeDeps());
    const out = (await readers.referencesAt!({ line: 1, column: 1 }, scope)) as Record<string, unknown>;
    expect(out['total']).toBe(2);
    expect((out['items'] as unknown[]).length).toBe(2);
    expect(out['truncated']).toBe(false);
  });

  it('referencesAt：脏落点被 slim 整条丢弃也算「没全」→ total 是 kept 真实数、truncated:true、不伪造计数', async () => {
    // 脏落点放前面：空路径 / 非正行 → slimLegLocations 整条丢弃；后 50 个合法恰好填满 cap。
    const dirty = [
      { filePath: '', line: 1 },
      { filePath: 'D:/proj/c.kojo', line: 0 },
      ...manyLegLocations(50),
    ];
    const readers = buildSemanticReaders(fakeDeps({
      getLegs: () => fakeLegs({ references: () => ({ path: 'c.kojo', locations: dirty }) }),
    }));
    const out = (await readers.referencesAt!({ line: 1, column: 1 }, scope)) as Record<string, unknown>;
    expect(out['total']).toBe(52); // kept 的真实数量（含 2 个脏落点），不是 items.length=50
    expect((out['items'] as unknown[]).length).toBe(50);
    expect(out['truncated']).toBe(true); // 丢弃 + 封顶统一由 truncated 解释
  });

  it('definitionAt：超过 DEFINITION_LIMIT → total 真实、truncated:true（顺带核查的同形缺口）', async () => {
    const locs = Array.from({ length: 21 }, (_, i) => ({ filePath: 'D:/proj/b.kojo', line: i + 1, column: 1 }));
    const readers = buildSemanticReaders(fakeDeps({
      getLegs: () => fakeLegs({ definition: () => locs }),
    }));
    const out = (await readers.definitionAt!({ line: 1, column: 1 }, scope)) as Record<string, unknown>;
    expect(out['total']).toBe(21);
    expect((out['items'] as unknown[]).length).toBe(20);
    expect(out['truncated']).toBe(true);
  });

  it('suggestAt：超过 SUGGEST_LIMIT → total 真实、count 为 cap、truncated:true、旧字段仍在（顺带核查）', async () => {
    const service = registryWith({
      completionProvider: [{ provideCompletionItems: () => ({
        suggestions: Array.from({ length: 51 }, (_, i) => ({ label: `s${i}`, kind: 5 })),
      }) }],
    });
    const readers = buildSemanticReaders(fakeDeps({ getFeaturesService: () => service }));
    const out = (await readers.suggestAt!({ line: 1, column: 1 }, scope)) as Record<string, unknown>;
    expect(out['total']).toBe(51);
    expect(out['count']).toBe(50);
    expect((out['items'] as unknown[]).length).toBe(50);
    expect(out['truncated']).toBe(true);
    expect(out).toHaveProperty('items');
    expect(out).toHaveProperty('providers');
    expect(out).toHaveProperty('answered');
  });

  it('codeActionsAt：超过 CODE_ACTION_LIMIT → total 真实、truncated:true（顺带核查的同形缺口）', async () => {
    const provider = {
      provideCodeActions: () => ({ actions: Array.from({ length: 31 }, (_, i) => ({ title: `a${i}`, kind: 'quickfix' })) }),
    };
    const readers = buildSemanticReaders(fakeDeps({ getFeaturesService: () => registryWith({ codeActionProvider: [provider] }) }));
    const out = (await readers.codeActionsAt!({ line: 1, column: 1 }, scope)) as Record<string, unknown>;
    expect(out['total']).toBe(31);
    expect((out['items'] as unknown[]).length).toBe(30);
    expect(out['truncated']).toBe(true);
  });

  it('未超 cap 的其余腿 truncated:false（definitionAt / suggestAt / codeActionsAt 基线）', async () => {
    const service = registryWith({
      completionProvider: [{ provideCompletionItems: () => ({ suggestions: [{ label: 'foo' }] }) }],
      codeActionProvider: [{ provideCodeActions: () => ({ actions: [{ title: 'fix' }] }) }],
    });
    const readers = buildSemanticReaders(fakeDeps({ getFeaturesService: () => service }));
    const def = (await readers.definitionAt!({ line: 1, column: 1 }, scope)) as Record<string, unknown>;
    const sug = (await readers.suggestAt!({ line: 1, column: 1 }, scope)) as Record<string, unknown>;
    const act = (await readers.codeActionsAt!({ line: 1, column: 1 }, scope)) as Record<string, unknown>;
    expect(def['truncated']).toBe(false);
    expect(sug['truncated']).toBe(false);
    expect(act['truncated']).toBe(false);
  });
});

/* ----------------------- 任务 B：第四波 6 枚只读具名工具 ----------------------- */
/**
 * 三件齐落的对拍：ToolSpec(tier:read+readOnlyHint) / MCP_TOOL_GAP_MAP / 真源执行腿（IO + UI）。
 * 逐条钉：真读数形状、截断账目、路径逃逸拒绝（域内解析 + invoke 不触达）、三态账，
 * 以及刻意不登记的 5 条经 runSupplemental 显式 NOT_WIRED（绝不挂空实现）。
 */
describe('任务 B：第四波 6 枚只读具名工具（真读数 / 截断 / 路径闸 / NOT_WIRED）', () => {
  const NEW_TOOLS = [
    'app.dataDir', 'codec.encodeString', 'fs.pathExists', 'fs.statFiles', 'lang.lensesAt', 'lang.selectionRangesAt',
  ] as const;

  it('三件齐落之一：6 枚工具均 tier:read + readOnlyHint，且 GAP_MAP 逐条字面量映射', () => {
    for (const n of NEW_TOOLS) {
      const spec = SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === n);
      expect(spec).toBeDefined();
      expect(spec!.tier).toBe('read');
      expect(spec!.annotations?.readOnlyHint).toBe(true);
    }
    const mapped = new Set(MCP_TOOL_GAP_MAP.map((m) => m.tool));
    for (const n of NEW_TOOLS) expect(mapped.has(n)).toBe(true);
  });

  it('app.dataDir：透传 Rust app_data_dir 路径字符串（只读、无入参）', async () => {
    const { kernel } = fakeKernel();
    const invoke: McpInvokeLike = vi.fn(async (cmd: string) => (cmd === 'app_data_dir' ? 'C:/Users/x/AppData/Roaming/kojo' : null));
    const sup = createRunSupplemental(fakeIoDeps(kernel, { invoke }));
    const out = (await sup('app.dataDir', {}, scope)) as Record<string, unknown>;
    expect(out).toEqual({ path: 'C:/Users/x/AppData/Roaming/kojo' });
    expect(invoke).toHaveBeenCalledWith('app_data_dir');
  });

  it('app.dataDir：真源缺席（空返回）⇒ TOOL_EXECUTION_FAILED，不编造路径', async () => {
    const { kernel } = fakeKernel();
    const sup = createRunSupplemental(fakeIoDeps(kernel, { invoke: async () => null }));
    await expect(sup('app.dataDir', {}, scope)).rejects.toMatchObject({ code: 'TOOL_EXECUTION_FAILED' });
  });

  it('codec.encodeString：白名单内透传 base64 + charLength，参数原样交给 Rust', async () => {
    const { kernel } = fakeKernel();
    const invoke: McpInvokeLike = vi.fn(async (cmd: string) => (cmd === 'encode_string' ? 'YWFh' : null));
    const sup = createRunSupplemental(fakeIoDeps(kernel, { invoke }));
    const out = (await sup('codec.encodeString', { text: 'aa', encoding: 'utf-8' }, scope)) as Record<string, unknown>;
    expect(out).toEqual({ encoding: 'utf-8', charLength: 2, base64: 'YWFh' });
    expect(invoke).toHaveBeenCalledWith('encode_string', { text: 'aa', encoding: 'utf-8' });
  });

  it('codec.encodeString：白名单外 ⇒ INVALID_ARGS，invoke 绝不触达', async () => {
    const { kernel } = fakeKernel();
    const invoke = vi.fn(async () => 'x');
    const sup = createRunSupplemental(fakeIoDeps(kernel, { invoke }));
    await expect(sup('codec.encodeString', { text: 'x', encoding: 'rot13' }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fs.pathExists：域内解析 + 真布尔读数（不伪造）', async () => {
    const { kernel } = fakeKernel();
    const invoke: McpInvokeLike = vi.fn(async (cmd: string) => (cmd === 'path_exists' ? true : null));
    const sup = createRunSupplemental(fakeIoDeps(kernel, { invoke }));
    const out = (await sup('fs.pathExists', { relPath: 'a.txt' }, scope)) as Record<string, unknown>;
    expect(out).toEqual({ path: 'a.txt', exists: true });
    expect(invoke).toHaveBeenCalledWith('path_exists', { path: 'D:/proj/a.txt' });
  });

  it('fs.pathExists：路径逃逸（.. / 盘符）⇒ INVALID_ARGS，invoke 绝不触达', async () => {
    const { kernel } = fakeKernel();
    const invoke = vi.fn(async () => true);
    const sup = createRunSupplemental(fakeIoDeps(kernel, { invoke }));
    await expect(sup('fs.pathExists', { relPath: '../secret.txt' }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(sup('fs.pathExists', { relPath: 'C:/boot.ini' }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fs.statFiles：批量真读数（不存在 ⇒ exists:false + null，不编造 0）+ 逐项域内解析', async () => {
    const { kernel } = fakeKernel();
    const invoke: McpInvokeLike = vi.fn(async (cmd: string) => (cmd === 'stat_files'
      ? [
          { path: 'D:/proj/a.txt', exists: true, size: 42, mtimeMs: 7 },
          { path: 'D:/proj/nope.txt', exists: false, size: null, mtimeMs: null },
        ]
      : null));
    const sup = createRunSupplemental(fakeIoDeps(kernel, { invoke }));
    const out = (await sup('fs.statFiles', { relPaths: ['a.txt', 'nope.txt'] }, scope)) as Record<string, unknown>;
    expect(out['total']).toBe(2);
    expect(out['truncated']).toBe(false);
    expect(out['items']).toEqual([
      { path: 'a.txt', exists: true, size: 42, mtimeMs: 7 },
      { path: 'nope.txt', exists: false, size: null, mtimeMs: null },
    ]);
    expect(invoke).toHaveBeenCalledWith('stat_files', { paths: ['D:/proj/a.txt', 'D:/proj/nope.txt'] });
  });

  it('fs.statFiles：超过 maxResults ⇒ total 是真实入参数、truncated:true、只把前 cap 项送去 Rust', async () => {
    const { kernel } = fakeKernel();
    const invoke: McpInvokeLike = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd !== 'stat_files') return null;
      const paths = (args?.['paths'] as string[]) ?? [];
      return paths.map((p, i) => ({ path: p, exists: true, size: i, mtimeMs: null }));
    });
    const sup = createRunSupplemental(fakeIoDeps(kernel, { invoke }));
    const out = (await sup('fs.statFiles', { relPaths: ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'], maxResults: 2 }, scope)) as Record<string, unknown>;
    expect(out['total']).toBe(5);
    expect(out['truncated']).toBe(true);
    expect((out['items'] as unknown[]).length).toBe(2);
    expect(invoke).toHaveBeenCalledWith('stat_files', { paths: ['D:/proj/a.txt', 'D:/proj/b.txt'] });
  });

  it('fs.statFiles：数组内任一路径逃逸 ⇒ 整批 INVALID_ARGS，invoke 绝不触达', async () => {
    const { kernel } = fakeKernel();
    const invoke = vi.fn(async () => []);
    const sup = createRunSupplemental(fakeIoDeps(kernel, { invoke }));
    await expect(sup('fs.statFiles', { relPaths: ['ok.txt', '../escape.txt'] }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fs.statFiles：relPaths 非数组 / 空 ⇒ INVALID_ARGS（不静默）', async () => {
    const { kernel } = fakeKernel();
    const sup = createRunSupplemental(fakeIoDeps(kernel));
    await expect(sup('fs.statFiles', { relPaths: [] }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(sup('fs.statFiles', {}, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('lang.lensesAt：CodeLensList / 裸 CodeLens 摊平投影 + 未解析标注 + 三态账', async () => {
    const service = registryWith({
      codeLensProvider: [
        { provideCodeLenses: () => ({
          lenses: [
            { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 5 }, command: { title: 'Run', id: 'run' } },
            { range: { startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 3 } },
          ],
        }) },
      ],
    });
    const ui = buildUiSupplemental(fakeDeps({ getFeaturesService: () => service }), null);
    const out = (await ui.get('lang.lensesAt')!({}, scope)) as Record<string, unknown>;
    expect(out['providers']).toBe(1);
    expect(out['answered']).toBe(1);
    expect(out['total']).toBe(2);
    expect(out['truncated']).toBe(false);
    expect(out['items']).toEqual([
      { line: 2, column: 1, endLine: 2, endColumn: 5, title: 'Run', commandId: 'run', resolved: true },
      { line: 5, column: 1, endLine: 5, endColumn: 3, title: '', commandId: '', resolved: false },
    ]);
  });

  it('lang.lensesAt：line 过滤 + maxResults 截断账目（total 是过滤后真实数）', async () => {
    const mk = (ln: number) => ({ range: { startLineNumber: ln, startColumn: 1, endLineNumber: ln, endColumn: 2 } });
    const service = registryWith({
      codeLensProvider: [{ provideCodeLenses: () => ({ lenses: [mk(1), mk(2), mk(2), mk(3)] }) }],
    });
    const ui = buildUiSupplemental(fakeDeps({ getFeaturesService: () => service }), null);
    const out = (await ui.get('lang.lensesAt')!({ line: 2, maxResults: 1 }, scope)) as Record<string, unknown>;
    expect(out['total']).toBe(2); // line=2 命中 2 条（过滤后真实数）
    expect(out['truncated']).toBe(true); // maxResults=1 封顶
    expect((out['items'] as unknown[]).length).toBe(1);
  });

  it('lang.selectionRangesAt：链按供方原序（近→远）投影 + 三态账 + 截断字段', async () => {
    const service = registryWith({
      selectionRangeProvider: [{ provideSelectionRanges: () => [[
        { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 } },
        { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 10 } },
      ]] }],
    });
    const ui = buildUiSupplemental(fakeDeps({ getFeaturesService: () => service }), null);
    const out = (await ui.get('lang.selectionRangesAt')!({ line: 1, column: 1 }, scope)) as Record<string, unknown>;
    expect(out['providers']).toBe(1);
    expect(out['answered']).toBe(1);
    expect(out['total']).toBe(1);
    expect(out['truncated']).toBe(false);
    expect(out['items']).toEqual([{ ranges: [
      { line: 1, column: 1, endLine: 1, endColumn: 5 },
      { line: 1, column: 1, endLine: 1, endColumn: 10 },
    ] }]);
  });

  it('lang.selectionRangesAt：无 provider ⇒ 三态诚实（providers:null / answered:0 / items 空），不冒充结果', async () => {
    const ui = buildUiSupplemental(fakeDeps({ getFeaturesService: () => registryWith({}) }), null);
    const out = (await ui.get('lang.selectionRangesAt')!({ line: 1, column: 1 }, scope)) as Record<string, unknown>;
    expect(out['providers']).toBeNull();
    expect(out['answered']).toBe(0);
    expect(out['items']).toEqual([]);
    expect(out['total']).toBe(0);
    expect(out['truncated']).toBe(false);
  });

  it.each(['read_file_bytes_raw', 'read_files_raw', 'updater_relaunch', 'debug.type', 'debug.actions'])(
    '刻意不登记：%s 经 runSupplemental ⇒ 显式 NOT_WIRED（不擅自开放二进制帧 / 动作通道）',
    async (name) => {
      const { kernel } = fakeKernel();
      const sup = createRunSupplemental(fakeIoDeps(kernel));
      await expect(sup(name, {}, scope)).rejects.toMatchObject({ code: 'NOT_WIRED' });
    },
  );
});

/* ------------------------------- resource 数据源 ------------------------------- */

describe('resource 数据源：8 URI 与 RESOURCE_UNAVAILABLE', () => {
  function buildReader(kernel: McpKernelLike | null, over: Partial<McpIoDeps> = {}) {
    const seen: unknown[] = [];
    return createIoResourceData(fakeIoDeps(kernel, over), (max) => seen.slice(0, max), () => seen.length);
  }

  it('snapshot：项目摘要 + counts.eventsBuffered 来自真实缓冲计数（不硬编码 0）', async () => {
    const reader = buildReader(fakeKernel().kernel);
    const out = (await reader(KOJO_RESOURCE_URIS.snapshot, scope)) as Record<string, unknown>;
    expect((out['project'] as Record<string, unknown>)['adapterId']).toBe('adapter-a');
    expect((out['counts'] as Record<string, unknown>)['commands']).toBe(2);
    expect((out['counts'] as Record<string, unknown>)['eventsBuffered']).toBe(0);
  });

  it('file-tree / commands / plugins：真读数形状', async () => {
    const { kernel } = fakeKernel();
    const reader = buildReader(kernel);
    const tree = (await reader(KOJO_RESOURCE_URIS.fileTree, scope)) as Record<string, unknown>;
    expect(tree['total']).toBe(1);
    const commands = (await reader(KOJO_RESOURCE_URIS.commands, scope)) as Record<string, unknown>;
    expect((commands['commands'] as unknown[]).length).toBe(2);
    const plugins = (await reader(KOJO_RESOURCE_URIS.plugins, scope)) as Record<string, unknown>;
    expect((plugins['active'] as unknown[]).length).toBe(1);
    const inactive = plugins['inactive'] as Record<string, unknown>[];
    expect(inactive[0]).toMatchObject({ id: 'p2', missing: ['k.x'] });
    expect((plugins['missing'] as unknown[]).length).toBe(1);
  });

  it('validation-failures：报告缺席 ⇒ RESOURCE_UNAVAILABLE；有报告 ⇒ {failedRules}', async () => {
    const idle = fakeKernel({ linter: { report: () => null } }).kernel;
    const idleReader = buildReader(idle);
    await expect(idleReader(KOJO_RESOURCE_URIS.validationFailures, scope)).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });

    const ran = fakeKernel({ linter: { report: () => ({ failedRules: [{ ruleId: 'r', error: 'e' }] }) } }).kernel;
    const ranReader = buildReader(ran);
    const out = (await ranReader(KOJO_RESOURCE_URIS.validationFailures, scope)) as Record<string, unknown>;
    expect(out['failedRules']).toEqual([{ ruleId: 'r', error: 'e' }]);
  });

  it('events：内核缺席 ⇒ RESOURCE_UNAVAILABLE（不静默）', async () => {
    await expect(buildReader(null)(KOJO_RESOURCE_URIS.events, scope)).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });

  it('项目未打开 ⇒ snapshot / file-tree 显式 RESOURCE_UNAVAILABLE（不空数组冒充）', async () => {
    const { kernel } = fakeKernel({ current: null });
    const reader = buildReader(kernel);
    await expect(reader(KOJO_RESOURCE_URIS.snapshot, scope)).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    await expect(reader(KOJO_RESOURCE_URIS.fileTree, scope)).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });

  it('未登记 URI ⇒ RESOURCE_UNAVAILABLE（不静默）', async () => {
    const { kernel } = fakeKernel();
    const reader = buildReader(kernel);
    await expect(reader('kojo://project/nope', scope)).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });
});

/* ------------------------------- 组装器与事件缓冲 ------------------------------- */

/** 文件级宿主假件（真形状 `McpRealSourceHost`，测试无需断言桥）。 */
function realHost(kernel: McpKernelLike | null): McpRealSourceHost {
  return {
    getCommands: () => [{ id: 'demo.x', title: 'X', run: () => undefined }],
    getCommandContext: () => ({ project: null }),
    getKernel: () => kernel,
  };
}

const NO_SEARCH = async (): Promise<McpSearchResultLike> => ({
  files: [],
  totalMatches: 0,
  truncated: false,
  filesScanned: 0,
  elapsedMs: 0,
  skipped: {},
});

describe('事件环形缓冲（bindEventRing）', () => {
  afterEach(() => bindEventRing(null));

  it('emit 进缓冲 → resource 通道读数：空缓冲是真读数；环形序还原 + 载荷裁剪', async () => {
    const handlers = new Map<string, (p: unknown) => void>();
    const kernel: McpKernelLike = {
      ...fakeKernel().kernel,
      bus: { on: (name: string, cb: (p: unknown) => void) => { handlers.set(name, cb); return () => {}; } },
    };
    bindEventRing(kernel);
    expect(handlers.size).toBeGreaterThan(0);
    const sources = await buildRealMcpSources(realHost(kernel), { invoke: async () => null, searchInFiles: NO_SEARCH });
    const before = (await sources.readResourceData!(KOJO_RESOURCE_URIS.events, scope)) as unknown[];
    expect(before).toEqual([]);
    const first = [...handlers.keys()][0]!;
    handlers.get(first)!('hello');
    handlers.get(first)!('x'.repeat(500));
    const after = (await sources.readResourceData!(KOJO_RESOURCE_URIS.events, scope)) as { name: string; payload: unknown }[];
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ name: first, payload: 'hello' });
    expect(String(after[1]!.payload)).toContain('…');
  });

  it('重复绑定同一内核幂等（不重复订阅）；换内核先退订旧的', () => {
    let subs = 0;
    let unsubs = 0;
    const makeKernel = (): McpKernelLike => ({
      ...fakeKernel().kernel,
      bus: { on: () => { subs += 1; return () => { unsubs += 1; }; } },
    });
    const k1 = makeKernel();
    bindEventRing(k1);
    const afterFirst = subs;
    bindEventRing(k1);
    expect(subs).toBe(afterFirst);
    bindEventRing(makeKernel());
    expect(unsubs).toBe(afterFirst);
    expect(subs).toBe(afterFirst * 2);
    bindEventRing(null);
    expect(unsubs).toBe(subs);
  });
});

describe('buildRealMcpSources / installRealMcpSources（组装 → wiring 登记）', () => {
  afterEach(() => {
    registerMcpWiringSources(null);
    bindEventRing(null);
  });

  it('组装：8 字段全到场；semantic 恰 8 键；promptSlots 显式空数组（不编造领域知识）', async () => {
    const { kernel } = fakeKernel();
    const sources = await buildRealMcpSources(realHost(kernel), {
      invoke: async () => null,
      searchInFiles: NO_SEARCH,
      getMonaco: () => fakeMonaco(),
      getWorkspace: () => fakeWorkspace(),
      getLegs: () => fakeLegs(),
      getFeaturesService: () => null,
    });
    expect(sources.commands?.length).toBe(1);
    expect(sources.commandContext).toBeDefined();
    expect(Object.keys(sources.semantic ?? {}).length).toBe(8);
    expect(Object.keys(sources.kernelIo ?? {}).length).toBe(3);
    expect(typeof sources.readResourceData).toBe('function');
    expect(typeof sources.runSupplemental).toBe('function');
    expect(sources.promptSlots).toEqual([]);
  });

  it('promptSlots：从 mcp.prompt 槽收集 adapter 贡献（只搬运，不编造）', async () => {
    const { kernel } = fakeKernel({
      slots: [
        {
          name: 'domain_context',
          description: 'd',
          render: () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'adapter knows best' } }] }),
        },
      ],
    });
    const sources = await buildRealMcpSources(realHost(kernel), {
      invoke: async () => null,
      searchInFiles: NO_SEARCH,
    });
    expect(sources.promptSlots).toEqual([{ name: 'domain_context', text: 'adapter knows best', source: 'domain_context' }]);
  });

  it('端到端：登记 → createMcpHostDeps → registry.callTool 走到假 invoke（fs.readFile 全链路）', async () => {
    const { kernel } = fakeKernel();
    const invoke = vi.fn(async (cmd: string) => (cmd === 'read_file_bytes' ? 'hello' : null));
    await installRealMcpSources(realHost(kernel), {
      invoke,
      searchInFiles: NO_SEARCH,
      getMonaco: () => fakeMonaco(),
      getWorkspace: () => fakeWorkspace(),
      getLegs: () => fakeLegs(),
      getFeaturesService: () => null,
    });
    const wiring = await import('../src/mcp/wiring');
    const deps = wiring.createMcpHostDeps();
    expect(deps.commands).toBeDefined();
    expect(deps.semantic).toBeDefined();
    expect(deps.kernelIo).toBeDefined();
    expect(deps.readResourceData).toBeDefined();
    expect(deps.runSupplemental).toBeDefined();
    const reg = createMcpCapabilityRegistry(deps);
    const out = await reg.callTool('fs.readFile', { relPath: 'a.txt' }, scope);
    expect(out).toMatchObject({ path: 'a.txt', text: 'hello', truncated: false });
    expect(invoke).toHaveBeenCalledWith('read_file_bytes', { path: 'D:/proj/a.txt' });
    // 写类经 registry 双闸：tier gate 先拦（privileged 未批准 ⇒ PERMISSION_DENIED）；
    // 宿主显式批准工具后，写腿已接线 ⇒ 继续撞写闸一（第四张表 approvedRoots 为空 ⇒
    // WRITE_DISABLED），绝不静默写盘、也绝不退回「NOT_WIRED」冒充未接线。
    await expect(reg.callTool('fileTree.remove', { relPath: 'a.txt' }, scope)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    const approvedScope: McpSessionScope = { ...scope, approvedTools: ['fileTree.remove'] };
    await expect(reg.callTool('fileTree.remove', { relPath: 'a.txt' }, approvedScope)).rejects.toMatchObject({
      code: 'WRITE_DISABLED',
      message: expect.stringContaining('approvedRoots'),
    });
  });

  it('端到端：写腿 fileTree.update 经 registry 全链路（tier 闸 → schema → 写闸 → 假写原语）', async () => {
    const writeSpy = vi.fn(async () => undefined);
    const existsSpy = vi.fn(async (p: string) => p === 'D:/proj/docs/a.txt');
    const { kernel } = fakeKernel({ exists: existsSpy, writeText: writeSpy, busEmit: vi.fn() });
    await installRealMcpSources(realHost(kernel), {
      invoke: async () => null,
      searchInFiles: NO_SEARCH,
      getMonaco: () => fakeMonaco(),
      getWorkspace: () => fakeWorkspace(),
      getLegs: () => fakeLegs(),
      getFeaturesService: () => null,
    });
    const wiring = await import('../src/mcp/wiring');
    const reg = createMcpCapabilityRegistry(wiring.createMcpHostDeps());
    // 只读会话 ⇒ registry tier 闸先拦（写腿根本不可见执行机会）。
    await expect(
      reg.callTool('fileTree.update', { relPath: 'docs/a.txt', content: 'body' }, { ...writeScope, tier: 'read' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    // edit 会话 + 域内目标 ⇒ 全链路写到假写原语。
    const out = (await reg.callTool('fileTree.update', { relPath: 'docs/a.txt', content: 'body' }, writeScope)) as Record<string, unknown>;
    expect(out).toMatchObject({ path: 'docs/a.txt', updated: true, textLength: 4 });
    expect(writeSpy).toHaveBeenCalledWith('D:/proj/docs/a.txt', 'body');
    // edit 会话 + 域外目标 ⇒ WRITE_DISABLED（第四张表复核，结构性错误透传到 registry 面）。
    await expect(
      reg.callTool('fileTree.update', { relPath: 'secret.txt', content: 'x' }, writeScope),
    ).rejects.toMatchObject({ code: 'WRITE_DISABLED' });
  });

  it('resource 全链路：registry.readResource(active-document) 拿真投影', async () => {
    const { kernel } = fakeKernel();
    await installRealMcpSources(realHost(kernel), {
      invoke: async () => null,
      searchInFiles: NO_SEARCH,
      getMonaco: () => fakeMonaco(),
      getWorkspace: () => fakeWorkspace({ model: fakeModel('body') }),
      getLegs: () => fakeLegs(),
      getFeaturesService: () => null,
    });
    const wiring = await import('../src/mcp/wiring');
    const reg = createMcpCapabilityRegistry(wiring.createMcpHostDeps());
    const out = (await reg.readResource(KOJO_RESOURCE_URIS.activeDocument, scope)) as { contents: { text: string }[] };
    const data = JSON.parse(out.contents[0]!.text) as Record<string, unknown>;
    expect(data).toMatchObject({ path: 'a.kojo', text: 'body', truncated: false, cursor: { line: 2, column: 1 } });
  });
});

describe('normalizeRoot：归一口径', () => {
  it('反斜杠 / 多斜杠 / 尾斜杠归一；空根 ⇒ null', () => {
    expect(normalizeRoot('D:\\a\\b\\')).toBe('D:/a/b');
    expect(normalizeRoot('D://a//b')).toBe('D:/a/b');
    expect(normalizeRoot('')).toBe(null);
  });
});