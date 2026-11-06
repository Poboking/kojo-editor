/**
 * MCP 特权写腿端到端回归（LaneG · Wave4 #2）：`fileTree.remove` / `fileTree.rename`。
 *
 * 全程假注入（fake kernel / fake invoke / fake bus），不启 GUI / Tauri / HTTP / 真运行时。
 * 两条腿绑内核 `kernel.io` 既有写原语（`removeFile` / `removeDir` / `rename`），
 * 双闸叠加：**写闸一** 第四张表 `assertMcpWriteDomain(approvedRoots, …)`、
 * **写闸二** 内核写原语自身 `assertWritable`（`WriteNotAllowedError` ⇒ 显式 `WRITE_DISABLED`）。
 * `deps.invoke` 在 remove 里**只**用于只读 `stat_file` 判类型，绝不直调 `remove_file` /
 * `remove_dir` / `rename_path` 绕开内核第一道写允许域——用断言钉死。
 *
 * 覆盖：
 *  ① 真成功路径（文件 / 目录删除、改名）+ `file.changed` 广播（unlink / add）；
 *  ② 双闸各自拒绝：写闸一（approvedRoots 空 / 域外 / rename 双端任一越界）、
 *     写闸二（内核 WriteNotAllowedError）、路径逃逸闸（INVALID_ARGS）；
 *  ③ 缺写原语 ⇒ NOT_WIRED（闸序：路径 → 域 → 原语）；
 *  ④ 真 `createMcpCapabilityRegistry`：privileged 默认不进 tools/list、未批准
 *     PERMISSION_DENIED、按工具名精确批准后写腿真跑通、批准后仍受双闸约束；
 *  ⑤ 「不新建旁路」安全钉：invoke 调用里不出现任何 Rust 写命令名。
 *
 * 变异自证（在交付回执里记录实测读数）：临时去掉写闸一 / 写闸二后，② 对应用例必须转红，
 * 恢复后转绿——以此证明双闸不是摆设。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createMcpCapabilityRegistry,
  type McpSessionScope,
} from '@kojo/mcp-host';
import {
  createRunSupplemental,
  type McpIoDeps,
  type McpKernelLike,
  type McpSearchResultLike,
} from '../src/mcp/real-sources-io';

/* ------------------------------- 会话 ------------------------------- */

/** 写腿专用：第四张表 approvedRoots 是项目根内相对路径（与写闸一同尺），工具默认未批准。 */
const scope: McpSessionScope = {
  sessionId: 's1',
  clientId: 'c1',
  tier: 'privileged',
  approvedRoots: ['docs'],
  approvedTools: [],
};

const NO_SEARCH: McpSearchResultLike = {
  files: [],
  totalMatches: 0,
  truncated: false,
  filesScanned: 0,
  elapsedMs: 0,
  skipped: {},
};

/* ------------------------------- 假件 ------------------------------- */

interface InvokeCall {
  readonly cmd: string;
  readonly args?: Record<string, unknown>;
}

interface Overrides {
  /** remove 文件原语（内核 `io.removeFile` 投影）。 */
  readonly removeFile?: (path: string) => Promise<void>;
  /** 删目录原语（内核 `io.removeDir` 投影）。 */
  readonly removeDir?: (path: string) => Promise<void>;
  /** 改名原语（内核 `io.rename` 投影）。 */
  readonly rename?: (from: string, to: string) => Promise<void>;
  /** file.changed 广播接收器。 */
  readonly busEmit?: (name: string, payload: unknown) => void;
  /** deps.invoke('stat_file') 的返回（默认：存在一个普通文件）。 */
  readonly statFile?: unknown;
}

const FILE_STAT = { size: 3, mtimeMs: 1, isDirectory: false };
const DIR_STAT = { size: 0, mtimeMs: 1, isDirectory: true };

function fakeIoDeps(over: Overrides = {}): {
  deps: McpIoDeps;
  kernel: McpKernelLike;
  invokes: InvokeCall[];
} {
  const invokes: InvokeCall[] = [];
  const kernel: McpKernelLike = {
    project: { current: () => ({ rootDir: 'D:\\proj', adapterId: 'a', kojoPaths: [] }) },
    io: {
      walkDir: async () => [],
      ...(over.removeFile ? { removeFile: over.removeFile } : {}),
      ...(over.removeDir ? { removeDir: over.removeDir } : {}),
      ...(over.rename ? { rename: over.rename } : {}),
    },
    plugins: { list: () => [] },
    services: { tryGet: <T = unknown>(_key: string) => undefined as T | undefined },
    bus: {
      on: () => () => {},
      ...(over.busEmit ? { emit: over.busEmit } : {}),
    },
    slots: { query: () => [] },
  };
  const deps: McpIoDeps = {
    getKernel: () => kernel,
    getCommands: () => [],
    invoke: async (cmd, args) => {
      invokes.push({ cmd, args });
      if (cmd === 'stat_file') return 'statFile' in over ? over.statFile : FILE_STAT;
      return null;
    },
    searchInFiles: async () => NO_SEARCH,
  };
  return { deps, kernel, invokes };
}

/** 底层写腿分派（直接验执行腿）。 */
function makeSup(over: Overrides = {}) {
  const { deps, kernel, invokes } = fakeIoDeps(over);
  return { sup: createRunSupplemental(deps), kernel, invokes };
}

/** 真 registry（runSupplemental 注入，端到端验 tier 闸 / tools/list / callTool）。 */
function makeRegistry(over: Overrides = {}) {
  const { deps, kernel, invokes } = fakeIoDeps(over);
  const reg = createMcpCapabilityRegistry({ runSupplemental: createRunSupplemental(deps) });
  return { reg, kernel, invokes };
}

/** 内核写允许域拒绝（与真 `WriteNotAllowedError` 同名的结构化错误）。 */
function writeNotAllowed(path: string): Promise<never> {
  const err = new Error(`这个位置在只读范围内，不能写入：${path}`);
  err.name = 'WriteNotAllowedError';
  return Promise.reject(err);
}

const FILE_ABS = 'D:/proj/docs/a.txt';
const DIR_ABS = 'D:/proj/docs/sub';
const FROM_ABS = 'D:/proj/docs/a.txt';
const TO_ABS = 'D:/proj/docs/b.txt';

/* ================================================================== *
 * ① 真成功路径 + file.changed 广播 + 「不新建旁路」安全钉
 * ================================================================== */

describe('① fileTree.remove / fileTree.rename 真成功路径（双闸通过，绑内核 io 原语）', () => {
  it('remove 文件：stat_file 只读判类型 → io.removeFile(abs) → file.changed(unlink)；写命令零 invoke', async () => {
    const removeFile = vi.fn(async () => undefined);
    const removeDir = vi.fn(async () => undefined);
    const busEmit = vi.fn();
    const { sup, invokes } = makeSup({ removeFile, removeDir, busEmit });
    const out = (await sup('fileTree.remove', { relPath: 'docs/a.txt' }, scope)) as Record<string, unknown>;
    expect(out).toEqual({ path: 'docs/a.txt', removed: true, removedKind: 'file', refreshed: true });
    expect(removeFile).toHaveBeenCalledWith(FILE_ABS);
    expect(removeDir).not.toHaveBeenCalled();
    expect(busEmit).toHaveBeenCalledWith('file.changed', { kind: 'unlink', path: FILE_ABS });
    // 只读判类型走 deps.invoke('stat_file')；绝不出现任何 Rust 写命令（不绕内核写允许域）。
    expect(invokes.map((c) => c.cmd)).toContain('stat_file');
    expect(invokes.find((c) => c.cmd === 'stat_file')?.args).toEqual({ path: FILE_ABS });
    expect(invokes.map((c) => c.cmd)).not.toEqual(
      expect.arrayContaining(['remove_file', 'remove_dir', 'rename_path']),
    );
  });

  it('remove 目录（recursive:true）：stat 判目录 → io.removeDir(abs) → unlink 广播；removeFile 零调用', async () => {
    const removeFile = vi.fn(async () => undefined);
    const removeDir = vi.fn(async () => undefined);
    const busEmit = vi.fn();
    const { sup } = makeSup({ statFile: DIR_STAT, removeFile, removeDir, busEmit });
    const out = (await sup('fileTree.remove', { relPath: 'docs/sub', recursive: true }, scope)) as Record<string, unknown>;
    expect(out).toEqual({ path: 'docs/sub', removed: true, removedKind: 'directory', refreshed: true });
    expect(removeDir).toHaveBeenCalledWith(DIR_ABS);
    expect(removeFile).not.toHaveBeenCalled();
    expect(busEmit).toHaveBeenCalledWith('file.changed', { kind: 'unlink', path: DIR_ABS });
  });

  it('rename：from/to 都解析 → io.rename(fromAbs,toAbs) → unlink(源)+add(落点) 广播；不调 stat、不走写 invoke', async () => {
    const rename = vi.fn(async () => undefined);
    const busEmit = vi.fn();
    const { sup, invokes } = makeSup({ rename, busEmit });
    const out = (await sup('fileTree.rename', { from: 'docs/a.txt', to: 'docs/b.txt' }, scope)) as Record<string, unknown>;
    expect(out).toEqual({ from: 'docs/a.txt', to: 'docs/b.txt', renamed: true, refreshed: true });
    expect(rename).toHaveBeenCalledWith(FROM_ABS, TO_ABS);
    expect(busEmit).toHaveBeenCalledWith('file.changed', { kind: 'unlink', path: FROM_ABS });
    expect(busEmit).toHaveBeenCalledWith('file.changed', { kind: 'add', path: TO_ABS });
    // rename 不判类型，也不经 invoke 写命令。
    expect(invokes.map((c) => c.cmd)).not.toContain('stat_file');
    expect(invokes.map((c) => c.cmd)).not.toEqual(
      expect.arrayContaining(['remove_file', 'remove_dir', 'rename_path']),
    );
  });

  it('bus.emit 缺席 ⇒ refreshed:false 如实标注（不假装广播成功），原语照常执行', async () => {
    const removeFile = vi.fn(async () => undefined);
    const { sup } = makeSup({ removeFile });
    const out = (await sup('fileTree.remove', { relPath: 'docs/a.txt' }, scope)) as Record<string, unknown>;
    expect(out.refreshed).toBe(false);
    expect(removeFile).toHaveBeenCalledWith(FILE_ABS);
  });
});

/* ================================================================== *
 * ② 双闸各自拒绝（变异自证的目标：去掉任一闸，本组必须转红）
 * ================================================================== */

describe('② 写闸一：assertMcpWriteDomain（第四张表 approvedRoots）', () => {
  it('approvedRoots 空 / 域外 ⇒ WRITE_DISABLED，remove 与 rename 写原语零触达、stat 零触达', async () => {
    const removeFile = vi.fn(async () => undefined);
    const rename = vi.fn(async () => undefined);
    const busEmit = vi.fn();
    const { sup, invokes } = makeSup({ removeFile, rename, busEmit });
    const empty: McpSessionScope = { ...scope, approvedRoots: [] };
    const outside: McpSessionScope = { ...scope, approvedRoots: ['other'] };

    await expect(sup('fileTree.remove', { relPath: 'docs/a.txt' }, empty)).rejects.toMatchObject({
      code: 'WRITE_DISABLED', message: expect.stringContaining('写闸一'),
    });
    await expect(sup('fileTree.remove', { relPath: 'docs/a.txt' }, outside)).rejects.toMatchObject({
      code: 'WRITE_DISABLED',
    });
    await expect(sup('fileTree.rename', { from: 'docs/a.txt', to: 'docs/b.txt' }, empty)).rejects.toMatchObject({
      code: 'WRITE_DISABLED', message: expect.stringContaining('写闸一'),
    });
    expect(removeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(invokes).toHaveLength(0); // 写闸一在只读 stat 之前就整批拒绝
    expect(busEmit).not.toHaveBeenCalled();
  });

  it('rename 双端：to 越界 / from 越界 ⇒ 任一 WRITE_DISABLED 整批拒绝，rename 原语零触达', async () => {
    const rename = vi.fn(async () => undefined);
    const { sup } = makeSup({ rename });
    // to 落在 approvedRoots=['docs'] 之外
    await expect(
      sup('fileTree.rename', { from: 'docs/a.txt', to: 'secret/b.txt' }, scope),
    ).rejects.toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining('写闸一') });
    // from 落在域外（即便 to 在域内）
    await expect(
      sup('fileTree.rename', { from: 'secret/a.txt', to: 'docs/b.txt' }, scope),
    ).rejects.toMatchObject({ code: 'WRITE_DISABLED' });
    expect(rename).not.toHaveBeenCalled();
  });
});

describe('② 写闸二：内核 assertWritable（WriteNotAllowedError ⇒ 显式 WRITE_DISABLED）', () => {
  it('removeFile 抛 WriteNotAllowedError ⇒ WRITE_DISABLED（写闸二），原语确实被触达', async () => {
    const removeFile = vi.fn((p: string) => writeNotAllowed(p));
    const busEmit = vi.fn();
    const { sup } = makeSup({ removeFile, busEmit });
    await expect(sup('fileTree.remove', { relPath: 'docs/a.txt' }, scope)).rejects.toMatchObject({
      code: 'WRITE_DISABLED', message: expect.stringContaining('写闸二'),
    });
    expect(removeFile).toHaveBeenCalledWith(FILE_ABS);
    expect(busEmit).not.toHaveBeenCalled(); // 失败不广播
  });

  it('removeDir 抛 WriteNotAllowedError ⇒ WRITE_DISABLED（写闸二），删目录同样不绕闸', async () => {
    const removeDir = vi.fn((p: string) => writeNotAllowed(p));
    const { sup } = makeSup({ statFile: DIR_STAT, removeDir });
    await expect(
      sup('fileTree.remove', { relPath: 'docs/sub', recursive: true }, scope),
    ).rejects.toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining('内核写允许域') });
    expect(removeDir).toHaveBeenCalledWith(DIR_ABS);
  });

  it('rename 抛 WriteNotAllowedError ⇒ WRITE_DISABLED（写闸二，内核对两端复核）', async () => {
    const rename = vi.fn((from: string) => writeNotAllowed(from));
    const busEmit = vi.fn();
    const { sup } = makeSup({ rename, busEmit });
    await expect(
      sup('fileTree.rename', { from: 'docs/a.txt', to: 'docs/b.txt' }, scope),
    ).rejects.toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining('写闸二') });
    expect(rename).toHaveBeenCalledWith(FROM_ABS, TO_ABS);
    expect(busEmit).not.toHaveBeenCalled();
  });

  it('写原语其它失败原样上抛（不洗码、不吞错，registry 兜底 TOOL_EXECUTION_FAILED）', async () => {
    const removeFile = vi.fn(async () => { throw new Error('EIO: disk full'); });
    const { sup } = makeSup({ removeFile });
    await expect(sup('fileTree.remove', { relPath: 'docs/a.txt' }, scope)).rejects.toThrow('EIO: disk full');
  });
});

describe('② 路径逃逸闸 + 语义约束（INVALID_ARGS，写原语零触达）', () => {
  it('remove 相对路径逃逸 / 绝对路径 ⇒ INVALID_ARGS；目录不给 recursive ⇒ INVALID_ARGS；目标不存在 ⇒ TOOL_EXECUTION_FAILED', async () => {
    const removeFile = vi.fn(async () => undefined);
    const removeDir = vi.fn(async () => undefined);
    const { sup } = makeSup({ removeFile, removeDir });
    await expect(sup('fileTree.remove', { relPath: '../escape.txt' }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(sup('fileTree.remove', { relPath: 'C:/boot.ini' }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    // 目录须显式 recursive:true（destructive 保守，写原语零触达）
    const dirSup = makeSup({ statFile: DIR_STAT, removeFile, removeDir }).sup;
    await expect(dirSup('fileTree.remove', { relPath: 'docs/sub' }, scope)).rejects.toMatchObject({
      code: 'INVALID_ARGS', message: expect.stringContaining('recursive'),
    });
    // 目标不存在不静默成功
    const ghostSup = makeSup({ statFile: null, removeFile }).sup;
    await expect(ghostSup('fileTree.remove', { relPath: 'docs/ghost.txt' }, scope)).rejects.toMatchObject({
      code: 'TOOL_EXECUTION_FAILED', message: expect.stringContaining('不存在'),
    });
    expect(removeFile).not.toHaveBeenCalled();
    expect(removeDir).not.toHaveBeenCalled();
  });

  it('rename 的 from/to 路径逃逸 ⇒ INVALID_ARGS（写闸之前，整批拒绝）', async () => {
    const rename = vi.fn(async () => undefined);
    const { sup } = makeSup({ rename });
    await expect(sup('fileTree.rename', { from: '../a.txt', to: 'docs/b.txt' }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(sup('fileTree.rename', { from: 'docs/a.txt', to: '/etc/b.txt' }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(rename).not.toHaveBeenCalled();
  });
});

/* ================================================================== *
 * ③ 缺写原语 ⇒ NOT_WIRED（精简桥 / 测试假件形状零改动）
 * ================================================================== */

describe('③ 缺写原语 ⇒ NOT_WIRED（闸序：路径 → 域 → 原语）', () => {
  it('精简 kernel（无 removeFile/removeDir/rename）⇒ NOT_WIRED 写明缺哪条原语；域外仍在 NOT_WIRED 之前拒绝', async () => {
    const { sup } = makeSup();
    await expect(sup('fileTree.remove', { relPath: 'docs/a.txt' }, scope)).rejects.toMatchObject({
      code: 'NOT_WIRED', message: expect.stringContaining('removeFile'),
    });
    const dirSup = makeSup({ statFile: DIR_STAT }).sup;
    await expect(dirSup('fileTree.remove', { relPath: 'docs/sub', recursive: true }, scope)).rejects.toMatchObject({
      code: 'NOT_WIRED', message: expect.stringContaining('removeDir'),
    });
    await expect(sup('fileTree.rename', { from: 'docs/a.txt', to: 'docs/b.txt' }, scope)).rejects.toMatchObject({
      code: 'NOT_WIRED', message: expect.stringContaining('rename'),
    });
    const outside: McpSessionScope = { ...scope, approvedRoots: [] };
    await expect(sup('fileTree.rename', { from: 'docs/a.txt', to: 'docs/b.txt' }, outside)).rejects.toMatchObject({
      code: 'WRITE_DISABLED',
    });
  });
});

/* ================================================================== *
 * ④ 真 registry：privileged 默认不可见 / 未批准拒绝 / 批准后真落
 * ================================================================== */

describe('④ 真 createMcpCapabilityRegistry：特权工具批准契约端到端', () => {
  it('privileged 默认不进 tools/list；按工具名精确批准后逐项可见（edit 腿照常可见）', () => {
    const { reg } = makeRegistry();
    const listed = reg.listTools(scope).map((t) => t.name);
    expect(listed).not.toContain('fileTree.remove');
    expect(listed).not.toContain('fileTree.rename');
    expect(listed).toContain('fileTree.create');
    expect(listed).toContain('fileTree.update');

    const one: McpSessionScope = { ...scope, approvedTools: ['fileTree.remove'] };
    const listedOne = reg.listTools(one).map((t) => t.name);
    expect(listedOne).toContain('fileTree.remove');
    expect(listedOne).not.toContain('fileTree.rename'); // 精确批准：只批一枚不放宽另一枚

    const both: McpSessionScope = { ...scope, approvedTools: ['fileTree.remove', 'fileTree.rename'] };
    const listedBoth = reg.listTools(both).map((t) => t.name);
    expect(listedBoth).toContain('fileTree.remove');
    expect(listedBoth).toContain('fileTree.rename');
  });

  it('未批准调用两枚工具 ⇒ 显式 PERMISSION_DENIED（denied），写原语零触达', async () => {
    const removeFile = vi.fn(async () => undefined);
    const rename = vi.fn(async () => undefined);
    const { reg, invokes } = makeRegistry({ removeFile, rename });
    await expect(reg.callTool('fileTree.remove', { relPath: 'docs/a.txt' }, scope)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(reg.callTool('fileTree.rename', { from: 'docs/a.txt', to: 'docs/b.txt' }, scope)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(removeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(invokes).toHaveLength(0); // tier 闸先于一切执行腿
  });

  it('按工具名精确批准后 ⇒ callTool 真跑通写腿（双闸 + 假写原语 + 广播）', async () => {
    const removeFile = vi.fn(async () => undefined);
    const rename = vi.fn(async () => undefined);
    const busEmit = vi.fn();
    const approved: McpSessionScope = { ...scope, approvedTools: ['fileTree.remove', 'fileTree.rename'] };
    const { reg } = makeRegistry({ removeFile, rename, busEmit });
    const rm = (await reg.callTool('fileTree.remove', { relPath: 'docs/a.txt' }, approved)) as Record<string, unknown>;
    expect(rm).toMatchObject({ path: 'docs/a.txt', removed: true });
    expect(removeFile).toHaveBeenCalledWith(FILE_ABS);
    const rn = (await reg.callTool('fileTree.rename', { from: 'docs/a.txt', to: 'docs/b.txt' }, approved)) as Record<string, unknown>;
    expect(rn).toMatchObject({ renamed: true });
    expect(rename).toHaveBeenCalledWith(FROM_ABS, TO_ABS);
    expect(busEmit).toHaveBeenCalledWith('file.changed', { kind: 'unlink', path: FROM_ABS });
  });

  it('批准后仍受写闸一/写闸二约束（PERMISSION_DENIED 之后的第二/三道闸，不因批准放宽）', async () => {
    const approved: McpSessionScope = { ...scope, approvedTools: ['fileTree.remove', 'fileTree.rename'] };
    const { reg: regA } = makeRegistry({ removeFile: vi.fn(async () => undefined) });
    const noRoots: McpSessionScope = { ...approved, approvedRoots: [] };
    await expect(regA.callTool('fileTree.remove', { relPath: 'docs/a.txt' }, noRoots)).rejects.toMatchObject({
      code: 'WRITE_DISABLED', message: expect.stringContaining('写闸一'),
    });
    const { reg: regB } = makeRegistry({ removeFile: (p: string) => writeNotAllowed(p) });
    await expect(regB.callTool('fileTree.remove', { relPath: 'docs/a.txt' }, approved)).rejects.toMatchObject({
      code: 'WRITE_DISABLED', message: expect.stringContaining('写闸二'),
    });
  });

  it('schema 闸：绝对路径 / 越界形态在 registry 层即 INVALID_ARGS（不开放任意目标路径参数）', async () => {
    const approved: McpSessionScope = { ...scope, approvedTools: ['fileTree.remove', 'fileTree.rename'] };
    const removeFile = vi.fn(async () => undefined);
    const { reg } = makeRegistry({ removeFile });
    await expect(reg.callTool('fileTree.remove', { relPath: '/etc/passwd' }, approved)).rejects.toMatchObject({
      code: 'INVALID_ARGS',
    });
    await expect(reg.callTool('fileTree.remove', { relPath: 'C:/x' }, approved)).rejects.toMatchObject({
      code: 'INVALID_ARGS',
    });
    expect(removeFile).not.toHaveBeenCalled();
  });
});
