/**
 * B25 · 文件族缺口过 MCP（复制 / 建目录 / 字节读）——判据先红批
 *
 * 靶子＝`node tools/mcp-inventory.mjs --json` 里 `wired===false` 且 P1/P2 的既有缺口，逐枚判定后
 * 登记成具名工具（或留账，留账理由见本文件最后一组）。每一枚都照**既有形态**抄，不另起炉灶：
 *
 *  | 缺口 | 登记名 | 档 | 真源 |
 *  |---|---|---|---|
 *  | `rust copy_file` (P2) | `fs.copyFile` | edit | `kernel.io.copyFile`（Tauri `copy_file`，只对 `to` 断言）|
 *  | `rust ensure_dir` (P2) | `fs.ensureDir` | edit | `kernel.io.ensureDir`（Tauri `ensure_dir`，递归 + 幂等）|
 *  | `rust create_dir_exclusive` (P2) | **不立新名**＝`fileTree.create` 的 `kind:'directory'` 支路 | edit | `kernel.io.createDirExclusive` |
 *  | `rust read_file_bytes_raw` (P1) | `fs.readFileBytes`（**只拆相对路径那一子集**） | read | `read_file_bytes`（与 raw 逐字节相同的 base64 孪生；MCP 的 JSON-RPC 帧装不了 `ipc::Response` 裸字节）|
 *  | `rust append_frontend_log` (P2) | **继续 deferred**（逐条理由在本文件末组） | — | — |
 *
 * 全程假注入（fake kernel io / fake invoke / fake bus / fake 脏缓冲反查），不起 GUI、不起 Tauri、
 * 不起 HTTP、不碰真盘。`docs/**` 与配置零改动。
 *
 * 判据组：
 *  ① 档位真源同批登记（池级红线）：三张契约表 tier ↔ Rust `EDIT_TOOLS_EXACT` /
 *     `MULTIROOT_WRITE_TOOLS` / `host_required_tiers` ↔ 端点参数名表，逐条现场对拍（不 cargo）。
 *  ② `fs.copyFile` 行为：双闸 / 路径闸 / 防覆盖默认拒 / 目录拒 / 同路径拒 / 回读凭据 / 广播。
 *  ③ `fs.ensureDir` 行为：幂等快路零写调用 / 首建 segmentsCreated / 同名文件拒 / 双闸。
 *  ④ `fs.readFileBytes` 行为：48 000 B 硬闸（base64 压在宿主 65 536 字符净化闸下）/
 *     超限整趟零读原语 / 载荷-尺寸对账 / `fsFreshness` 必带 / 路径闸。
 *  ⑤ 脏缓冲红线：覆盖目标正开在编辑器里且有未保存改动 ⇒ 显式拒绝且写原语零触达（`saved` 口径）。
 *  ⑥ 入参出厂即严格 + 漂移闸要求的双向对账（未知键点名并摊开合法清单）。
 *  ⑦ 台账：`MCP_TOOL_GAP_MAP` 四行在册；`append_frontend_log` 留账理由逐条对得上代码。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MCP_DEFERRED_GAP_NOTES,
  MCP_TOOL_GAP_MAP,
  McpFailure,
  SUPPLEMENTAL_TOOL_SPECS,
  createMcpCapabilityRegistry,
  isMcpFailure,
  type McpHostDeps,
  type McpSessionScope,
} from '@kojo/mcp-host';
import {
  createRunSupplemental,
  type McpIoDeps,
  type McpKernelLike,
  type McpSearchResultLike,
} from '../src/mcp/real-sources-io';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const rustSrc = (rel: string) => readFileSync(resolve(REPO_ROOT, 'packages/app/src-tauri', rel), 'utf8');

/* ------------------------------- 会话与假件 ------------------------------- */

const NO_SEARCH: McpSearchResultLike = {
  files: [], totalMatches: 0, truncated: false, filesScanned: 0, elapsedMs: 0, skipped: {},
};

/** 写腿会话：tier=edit + approvedRoots 覆盖 `docs`（项目根内相对前缀，与写闸一同尺）。 */
function writeScope(over: Partial<McpSessionScope> = {}): McpSessionScope {
  return {
    sessionId: 'b25-s', clientId: 'b25-c', tier: 'edit',
    approvedRoots: ['docs'], approvedTools: [], ...over,
  };
}
const readScope: McpSessionScope = {
  sessionId: 'b25-r', clientId: 'b25-c', tier: 'read', approvedRoots: [], approvedTools: [],
};

interface Overrides {
  readonly copyFile?: (from: string, to: string) => Promise<void>;
  readonly ensureDir?: (path: string) => Promise<void>;
  readonly createDirExclusive?: (path: string) => Promise<boolean>;
  readonly busEmit?: (name: string, payload: unknown) => void;
  /** `stat_files`（批量预检）返回；默认 src 存在（3 B）、dest 不存在。 */
  readonly statFiles?: unknown;
  /** `stat_files` 的带态版本（每次调用现算，用于「建完再查」这类幂等序列）。 */
  readonly statFilesFn?: (paths: string[]) => unknown;
  /** `stat_file`（回读）返回；默认普通文件 3 B。 */
  readonly statFile?: unknown;
  /** `stat_file` 的带态版本。 */
  readonly statFileFn?: (path: string) => unknown;
  /** `read_file_bytes` 返回（base64 字符串）。 */
  readonly readBytes?: unknown;
  /**
   * 脏缓冲反查 seam 的读数表（注入成 `deps.getBufferDirty`）：abs → 'dirty' / 'clean' /
   * 'unprovable'（开着但判不出）；表里没有这一格 ⇒ 'not-open'（登记簿里没这个落点的 pane）。
   * **整枚 seam 不给**（`dirty` 未定义）⇒ 腿走生产反查（node 测试里动态 import 失败 ⇒ 'unknown'）。
   */
  readonly dirty?: Record<string, 'dirty' | 'clean' | 'not-open' | 'unprovable'>;
  /** 观察通道整体不可用（生产动态 import 失败的同形读数）⇒ 腿必须标 'unknown' 并放行，不静默当干净。 */
  readonly dirtyUnknown?: boolean;
}

interface Harness {
  readonly sup: (name: string, args: Record<string, unknown>, scope: McpSessionScope) => Promise<unknown>;
  readonly invokes: Array<{ cmd: string; args?: Record<string, unknown> }>;
  readonly emits: Array<{ name: string; payload: unknown }>;
  readonly deps: McpIoDeps;
}

function makeHarness(over: Overrides = {}): Harness {
  const invokes: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const emits: Array<{ name: string; payload: unknown }> = [];
  const dirtyProbes: string[] = [];
  const kernel: McpKernelLike = {
    project: { current: () => ({ rootDir: 'D:\\proj', adapterId: 'a', kojoPaths: [] }) },
    io: {
      walkDir: async () => [],
      ...(over.copyFile ? { copyFile: over.copyFile } : {}),
      ...(over.ensureDir ? { ensureDir: over.ensureDir } : {}),
      ...(over.createDirExclusive ? { createDirExclusive: over.createDirExclusive } : {}),
    },
    plugins: { list: () => [] },
    services: { tryGet: <T = unknown>(_key: string) => undefined as T | undefined },
    bus: {
      on: () => () => {},
      emit: over.busEmit
        ? ((name: string, payload: unknown) => { over.busEmit?.(name, payload); }) as never
        : ((name: string, payload: unknown) => { emits.push({ name, payload }); }) as never,
    },
    slots: { query: () => [] },
  };
  const deps: McpIoDeps = {
    getKernel: () => kernel,
    getCommands: () => [],
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      invokes.push({ cmd, args });
      if (cmd === 'stat_files') {
        if (over.statFilesFn) return over.statFilesFn(((args?.['paths'] as string[]) ?? []).map(String));
        return 'statFiles' in over ? over.statFiles : [
          { path: String(args?.['paths']?.[0] ?? ''), exists: true, size: 3, mtimeMs: 11 },
          { path: String(args?.['paths']?.[1] ?? ''), exists: false, size: null, mtimeMs: null },
        ];
      }
      if (cmd === 'stat_file') {
        if (over.statFileFn) return over.statFileFn(String(args?.['path'] ?? ''));
        return 'statFile' in over ? over.statFile : { exists: true, size: 3, mtimeMs: 21, isDirectory: false };
      }
      if (cmd === 'read_file_bytes') return 'readBytes' in over ? over.readBytes : Buffer.from('abc').toString('base64');
      return null;
    },
    searchInFiles: async () => NO_SEARCH,
    ...(over.dirty === undefined
      ? {}
      : {
          getBufferDirty: (abs: string) =>
            abs in over.dirty ? (over.dirty[abs] as 'dirty' | 'clean') : ('not-open' as const),
        }),
  };
  return { sup: createRunSupplemental(deps), invokes, emits, deps };
}

function makeRegistry(over: Overrides = {}) {
  const h = makeHarness(over);
  return { reg: createMcpCapabilityRegistry({ runSupplemental: h.sup } as unknown as McpHostDeps), ...h };
}

function writeNotAllowed(path: string): Promise<never> {
  const err = new Error(`这个位置在只读范围内，不能写入：${path}`);
  err.name = 'WriteNotAllowedError';
  return Promise.reject(err);
}

const SRC_ABS = 'D:/proj/docs/a.erb';
const DEST_ABS = 'D:/proj/docs/b.erb';

/** Rust 源码里抓一枚 `pub const NAME: &[&str] = &[...]` 的字符串项（现场对拍，不抄清单）。 */
function rustList(name: string, file: string): string[] {
  const src = rustSrc(file);
  const at = src.indexOf(`pub const ${name}`);
  expect(at, `Rust ${name} 锚不存在（${file}）`).toBeGreaterThanOrEqual(0);
  const open = src.indexOf('&[', at);
  const close = src.indexOf('];', open);
  return [...src.slice(open + 2, close).matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
}

/** 与 Rust `key_tokens` + `is_forbidden_target_key` / `path_param_tier` 同尺的现场判据。 */
function keyTokens(key: string): string[] {
  return key.split(/[^A-Za-z0-9]+/).filter((s) => s !== '');
}

/* ================================================================== *
 * ① 档位真源同批登记（红线：不同批＝造后门）
 * ================================================================== */

describe('① 新名同批进档位真源表（契约 tier ↔ Rust 三张表）', () => {
  const B25_WRITE = ['fs.copyFile', 'fs.ensureDir'];
  const B25_READ = ['fs.readFileBytes'];

  it('三张契约表里在册，tier 逐枚＝edit / edit / read 且出厂即 additionalProperties:false', () => {
    for (const name of [...B25_WRITE, ...B25_READ]) {
      const spec = SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === name);
      expect(spec, `${name} 必须登记进 SUPPLEMENTAL_TOOL_SPECS`).toBeDefined();
      const schema = spec!.inputSchema as Record<string, unknown>;
      expect(schema['additionalProperties'], `${name} 出厂即严格`).toBe(false);
    }
    expect(SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === 'fs.copyFile')!.tier).toBe('edit');
    expect(SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === 'fs.ensureDir')!.tier).toBe('edit');
    expect(SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === 'fs.readFileBytes')!.tier).toBe('read');
    // 写侧不收 content / 落点键一类的第二形状
    expect(Object.keys((SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === 'fs.copyFile')!.inputSchema as Record<string, unknown>)['properties'] as Record<string, unknown>).sort())
      .toEqual(['overwrite', 'relPath', 'rootId', 'srcRelPath']);
  });

  it('Rust `EDIT_TOOLS_EXACT` 同批点名两枚写侧新名（点号形态不命中下划线前缀表）', () => {
    const exact = rustList('EDIT_TOOLS_EXACT', 'src/mcp/protocol.rs');
    for (const name of B25_WRITE) {
      expect(exact, `${name} 未进 Rust EDIT_TOOLS_EXACT ⇒ read 会话后门`).toContain(name);
    }
    // 只读那枚**不许**进 Edit 表（进了就是把读面抬档，也会让 read 会话拿不到它）
    for (const name of B25_READ) expect(exact, `${name} 是只读面，不进 Edit 表`).not.toContain(name);
  });

  it('宿主 `host_required_tiers` 的具名写面表同批点名（宿主一路也认这两枚是写）', () => {
    const hostExact = rustList('host_required_tiers', 'src/mcp/process.rs');
    for (const name of B25_WRITE) {
      expect(hostExact, `${name} 未进宿主 host_required_tiers 具名表`).toContain(name);
    }
  });

  it('收 rootId 的新写腿同批进 `MULTIROOT_WRITE_TOOLS`（端点第四张表逐根复验才生效）', () => {
    const multi = rustList('MULTIROOT_WRITE_TOOLS', 'src/mcp/protocol.rs');
    expect(multi).toEqual(expect.arrayContaining(['fs.copyFile', 'fs.ensureDir']));
    // 只读字节面不收 rootId ⇒ 不许混进多根名单
    expect(multi).not.toContain('fs.readFileBytes');
  });

  it('端点参数级 tier 表逐枚点名新入参名（relPath 在 Edit 档 ⇒ read 会话连参数都过不去）', () => {
    const params = rustList('PARAM_TIER_EXACT', 'src/mcp/tools.rs');
    const hit = new Set(params);
    for (const pair of [
      'fs.copyFile.srcRelPath', 'fs.copyFile.relPath', 'fs.copyFile.rootId',
      'fs.ensureDir.relPath', 'fs.ensureDir.rootId', 'fs.readFileBytes.relPath',
    ]) {
      expect(hit, `${pair} 未进端点参数名表`).toContain(pair);
    }
  });

  it('新路径参数名不撞落点键黑名单（dest*/target* 复合名会被端点当场拒收）', () => {
    const landing = ['dest', 'destination', 'output', 'save', 'write', 'export', 'target', 'landing', 'drop', 'dst', 'artifact', 'download', 'new', 'move', 'copy'];
    const where = ['path', 'dir', 'file', 'folder', 'to', 'as', 'name', 'location', 'into'];
    for (const key of ['srcRelPath', 'relPath', 'rootId', 'overwrite', 'maxBytes', 'bytesReturned', 'truncated']) {
      const tokens = keyTokens(key);
      const forbidden = tokens.some((t) => landing.includes(t)) && tokens.some((t) => where.includes(t));
      expect(forbidden, `${key} 撞了落点键黑名单，端点会 E_PATH_TARGET_FORBIDDEN`).toBe(false);
    }
    // 反向自证：被点名禁掉的那两枚确实会撞（说明上面那条判据不是空跑）
    for (const key of ['destRelPath', 'targetRelPath']) {
      const tokens = keyTokens(key);
      expect(
        tokens.some((t) => landing.includes(t)) && tokens.some((t) => where.includes(t)),
        `${key} 应当撞黑名单`,
      ).toBe(true);
    }
  });

  it('read 会话经真 registry 调两枚写侧新面 ⇒ PERMISSION_DENIED 且写原语零触达', async () => {
    const copyFile = vi.fn(async () => undefined);
    const ensureDir = vi.fn(async () => undefined);
    const { reg } = makeRegistry({ copyFile, ensureDir });
    await expect(reg.callTool('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'docs/b.erb' }, readScope))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(reg.callTool('fs.ensureDir', { relPath: 'docs/sub' }, readScope))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(copyFile).not.toHaveBeenCalled();
    expect(ensureDir).not.toHaveBeenCalled();
  });

  it('tools/list 分档：read 会话看不到两枚写面，edit 会话看得到；只读字节面恒可见', () => {
    const { reg } = makeRegistry();
    const readNames = reg.listTools(readScope).map((t) => t.name);
    const editNames = reg.listTools(writeScope()).map((t) => t.name);
    expect(readNames).not.toContain('fs.copyFile');
    expect(readNames).not.toContain('fs.ensureDir');
    expect(readNames).toContain('fs.readFileBytes');
    expect(editNames).toContain('fs.copyFile');
    expect(editNames).toContain('fs.ensureDir');
  });
});

/* ================================================================== *
 * ② fs.copyFile：双闸 + 防覆盖 + 回读凭据
 * ================================================================== */

describe('② fs.copyFile 真成功路径与失败交代', () => {
  it('落域内 ⇒ 一趟批量预检 + io.copyFile(srcAbs,destAbs) + 落点回读凭据 + add 广播', async () => {
    const copyFile = vi.fn(async () => undefined);
    const { sup, invokes, emits } = makeHarness({ copyFile });
    const out = (await sup('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'docs/b.erb' }, writeScope())) as Record<string, unknown>;
    expect(copyFile).toHaveBeenCalledTimes(1);
    expect(copyFile).toHaveBeenCalledWith(SRC_ABS, DEST_ABS);
    expect(out['copied']).toBe(true);
    expect(out['overwritten']).toBe(false);
    expect(out['path']).toBe('docs/b.erb');
    expect(out['srcPath']).toBe('docs/a.erb');
    // 回读凭据：落点事实（exists/size/mtime/isDirectory）+ 与源的尺寸对账，绝不只回 ok:true
    expect(out['dest']).toEqual({ exists: true, size: 3, mtimeMs: 21, isDirectory: false });
    expect(out['srcSize']).toBe(3);
    expect(out['sizeMatched']).toBe(true);
    expect(out['via']).toBe('kernel.io.copyFile');
    expect(out['refreshed']).toBe(true);
    expect(out['idempotency']).toEqual(expect.objectContaining({ secondCallSameArgs: 'refuses' }));
    // 预检＝恰一趟批量 stat（B13 成本口径：0 次单文件 stat 参与预检）
    expect(invokes.filter((c) => c.cmd === 'stat_files')).toHaveLength(1);
    expect(invokes.find((c) => c.cmd === 'stat_files')!.args!['paths']).toEqual([SRC_ABS, DEST_ABS]);
    expect(emits.map((e) => e.payload)).toContainEqual({ kind: 'add', path: DEST_ABS });
  });

  it('绝不直调 Rust 写命令绕内核第一道写允许域：invoke 里不出现 copy_file', async () => {
    const copyFile = vi.fn(async () => undefined);
    const { sup, invokes } = makeHarness({ copyFile });
    await sup('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'docs/b.erb' }, writeScope());
    expect(invokes.map((c) => c.cmd)).not.toContain('copy_file');
    expect(copyFile).toHaveBeenCalledTimes(1);
  });

  it('目标已存在且未显式 overwrite ⇒ 显式失败并点名 overwrite，写原语零触达', async () => {
    const copyFile = vi.fn(async () => undefined);
    const { sup, emits } = makeHarness({
      copyFile,
      statFiles: [
        { path: SRC_ABS, exists: true, size: 3, mtimeMs: 11 },
        { path: DEST_ABS, exists: true, size: 9, mtimeMs: 12 },
      ],
    });
    const err = await sup('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'docs/b.erb' }, writeScope()).catch((e: unknown) => e);
    expect(isMcpFailure(err), '目标已存在必须显式失败').toBe(true);
    expect((err as McpFailure).code).toBe('TOOL_EXECUTION_FAILED');
    expect((err as McpFailure).message).toContain('overwrite');
    expect(copyFile).not.toHaveBeenCalled();
    expect(emits).toHaveLength(0);
  });

  it('overwrite:true ⇒ 放行并如实标 overwritten + change 广播 + 回读落点新尺寸', async () => {
    const copyFile = vi.fn(async () => undefined);
    const { sup, emits } = makeHarness({
      copyFile,
      statFiles: [
        { path: SRC_ABS, exists: true, size: 3, mtimeMs: 11 },
        { path: DEST_ABS, exists: true, size: 9, mtimeMs: 12 },
      ],
      statFile: { exists: true, size: 3, mtimeMs: 33, isDirectory: false },
    });
    const out = (await sup('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'docs/b.erb', overwrite: true }, writeScope())) as Record<string, unknown>;
    expect(out['overwritten']).toBe(true);
    expect(out['dest']).toEqual({ exists: true, size: 3, mtimeMs: 33, isDirectory: false });
    expect(emits.map((e) => e.payload)).toContainEqual({ kind: 'change', path: DEST_ABS });
  });

  it('源不存在 ⇒ 显式失败（TOOL_EXECUTION_FAILED）且写原语零触达；源是目录 ⇒ 人话拒绝（copy_file 只能搬文件）', async () => {
    const copyFile = vi.fn(async () => undefined);
    const missing = makeHarness({
      copyFile,
      statFiles: [{ path: SRC_ABS, exists: false, size: null, mtimeMs: null }, { path: DEST_ABS, exists: false, size: null, mtimeMs: null }],
    });
    await expect(missing.sup('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'docs/b.erb' }, writeScope()))
      .rejects.toMatchObject({ code: 'TOOL_EXECUTION_FAILED' });
    expect(copyFile).not.toHaveBeenCalled();

    const dirSrc = makeHarness({
      copyFile,
      statFiles: [{ path: SRC_ABS, exists: true, size: 0, mtimeMs: 1, isDirectory: true }, { path: DEST_ABS, exists: false, size: null, mtimeMs: null }],
    });
    await expect(dirSrc.sup('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'docs/b.erb' }, writeScope()))
      .rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('目录') });
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('源与落点是同一格 ⇒ INVALID_ARGS（copy_file 到自身会把文件抹成零字节）', async () => {
    const copyFile = vi.fn(async () => undefined);
    const { sup } = makeHarness({ copyFile });
    await expect(sup('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'docs/a.erb' }, writeScope()))
      .rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('同一') });
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('落点在 approvedRoots 之外 ⇒ WRITE_DISABLED（写闸一），预检 stat 都不许多付', async () => {
    const copyFile = vi.fn(async () => undefined);
    const { sup, invokes } = makeHarness({ copyFile });
    await expect(sup('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'secret/b.erb' }, writeScope()))
      .rejects.toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining('写闸一') });
    expect(copyFile).not.toHaveBeenCalled();
    expect(invokes).toHaveLength(0);
  });

  it('内核写允许域拒绝 ⇒ WRITE_DISABLED（写闸二），消息带内核原话', async () => {
    const { sup } = makeHarness({ copyFile: writeNotAllowed });
    await expect(sup('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'docs/b.erb' }, writeScope()))
      .rejects.toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining('写闸二') });
  });

  it('精简桥缺 copyFile 原语 ⇒ NOT_WIRED（不静默降级成 read+write 拼出来的第二条写通道）', async () => {
    const { sup } = makeHarness({});
    await expect(sup('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'docs/b.erb' }, writeScope()))
      .rejects.toMatchObject({ code: 'NOT_WIRED', message: expect.stringContaining('copyFile') });
  });

  it('路径闸与 fs.readFile 同一把尺：绝对 / 盘符 / .. 当场 INVALID_ARGS，写原语零触达', async () => {
    const copyFile = vi.fn(async () => undefined);
    const { sup } = makeHarness({ copyFile });
    for (const bad of ['D:/proj/docs/a.erb', '/etc/passwd', '../outside.erb', 'docs/../../x.erb', 'C:/Windows/x']) {
      await expect(sup('fs.copyFile', { srcRelPath: bad, relPath: 'docs/b.erb' }, writeScope()))
        .rejects.toBeInstanceOf(McpFailure);
      await expect(sup('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: bad }, writeScope()))
        .rejects.toBeInstanceOf(McpFailure);
    }
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('rootId：未批准 ⇒ PERMISSION_DENIED 且不退回项目根；形状非法 ⇒ INVALID_ARGS', async () => {
    const copyFile = vi.fn(async () => undefined);
    const { sup } = makeHarness({ copyFile });
    await expect(sup('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'docs/b.erb', rootId: 'ws:1a2b3c4d' }, writeScope()))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(sup('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'docs/b.erb', rootId: 'D:/other' }, writeScope()))
      .rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(copyFile).not.toHaveBeenCalled();
  });
});

/* ================================================================== *
 * ③ fs.ensureDir：递归 + 幂等（与 fileTree.create 的独占非递归是真差异）
 * ================================================================== */

describe('③ fs.ensureDir 幂等与凭据', () => {
  it('目录已在 ⇒ 幂等快路：alreadyExisted:true、写原语零调用、回读 isDirectory 凭据', async () => {
    const ensureDir = vi.fn(async () => undefined);
    const { sup, invokes } = makeHarness({
      ensureDir,
      statFile: { exists: true, size: 0, mtimeMs: 7, isDirectory: true },
    });
    const out = (await sup('fs.ensureDir', { relPath: 'docs/sub' }, writeScope())) as Record<string, unknown>;
    expect(out['alreadyExisted']).toBe(true);
    expect(out['created']).toBe(false);
    expect(out['segmentsCreated']).toEqual([]);
    expect(out['dir']).toEqual({ exists: true, size: 0, mtimeMs: 7, isDirectory: true });
    expect(ensureDir).not.toHaveBeenCalled();
    // 幂等快路也不许多付批量预检之外的一次单文件 stat
    expect(invokes.filter((c) => c.cmd === 'stat_files')).toHaveLength(1);
  });

  it('首建 ⇒ io.ensureDir(abs) 一次 + segmentsCreated 逐段点名缺失层 + add 广播 + 回读凭据', async () => {
    const ensureDir = vi.fn(async () => undefined);
    const { sup, invokes, emits } = makeHarness({
      ensureDir,
      statFiles: [
        { path: 'D:/proj/docs', exists: true, size: 0, mtimeMs: 1 },
        { path: 'D:/proj/docs/sub', exists: false, size: null, mtimeMs: null },
        { path: 'D:/proj/docs/sub/deep', exists: false, size: null, mtimeMs: null },
      ],
      statFile: { exists: true, size: 0, mtimeMs: 44, isDirectory: true },
    });
    const out = (await sup('fs.ensureDir', { relPath: 'docs/sub/deep' }, writeScope())) as Record<string, unknown>;
    expect(ensureDir).toHaveBeenCalledTimes(1);
    expect(ensureDir).toHaveBeenCalledWith('D:/proj/docs/sub/deep');
    expect(out['created']).toBe(true);
    expect(out['alreadyExisted']).toBe(false);
    expect(out['segmentsCreated']).toEqual(['docs/sub', 'docs/sub/deep']);
    expect(out['dir']).toEqual({ exists: true, size: 0, mtimeMs: 44, isDirectory: true });
    expect(out['via']).toBe('kernel.io.ensureDir');
    // 祖先存在性只付**恰一趟**批量 stat
    expect(invokes.filter((c) => c.cmd === 'stat_files')).toHaveLength(1);
    expect(emits.map((e) => e.payload)).toContainEqual({ kind: 'add', path: 'D:/proj/docs/sub/deep' });
  });

  it('同一路径连续两次 ⇒ 第一次建、第二次幂等成功且写原语零调用（与 fileTree.create 的真差异）', async () => {
    // 带态的小假盘：ensureDir 落一次 ⇒ 后续预检读到「已在」；这钉的就是幂等这一格。
    let dirExists = false;
    const ensureDir = vi.fn(async () => {
      dirExists = true;
    });
    const { sup } = makeHarness({
      ensureDir,
      statFilesFn: (paths) =>
        paths.map((p) =>
          p === 'D:/proj/docs'
            ? { path: p, exists: true, size: 0, mtimeMs: 1 }
            : { path: p, exists: dirExists, size: dirExists ? 0 : null, mtimeMs: dirExists ? 2 : null },
        ),
      statFileFn: () => ({ exists: true, size: 0, mtimeMs: 9, isDirectory: true }),
    });
    const first = (await sup('fs.ensureDir', { relPath: 'docs/sub' }, writeScope())) as Record<string, unknown>;
    expect(first['created']).toBe(true);
    expect(first['segmentsCreated']).toEqual(['docs/sub']);
    const second = (await sup('fs.ensureDir', { relPath: 'docs/sub' }, writeScope())) as Record<string, unknown>;
    expect(second['alreadyExisted']).toBe(true);
    expect(second['created']).toBe(false);
    expect(second['segmentsCreated']).toEqual([]);
    expect(ensureDir).toHaveBeenCalledTimes(1);
  });

  it('同名是文件 ⇒ 显式拒绝且 ensureDir 零调用（绝不删东西来建目录）', async () => {
    const ensureDir = vi.fn(async () => undefined);
    const { sup } = makeHarness({
      ensureDir,
      statFiles: [{ path: 'D:/proj/docs', exists: true, size: 0, mtimeMs: 1 }, { path: 'D:/proj/docs/sub', exists: true, size: 5, mtimeMs: 2, isDirectory: false }],
    });
    await expect(sup('fs.ensureDir', { relPath: 'docs/sub' }, writeScope()))
      .rejects.toMatchObject({ code: 'TOOL_EXECUTION_FAILED', message: expect.stringContaining('文件') });
    expect(ensureDir).not.toHaveBeenCalled();
  });

  it(' approvedRoots 未覆盖 ⇒ WRITE_DISABLED 零调用；缺 ensureDir 原语 ⇒ NOT_WIRED', async () => {
    const ensureDir = vi.fn(async () => undefined);
    const gated = makeHarness({ ensureDir });
    await expect(gated.sup('fs.ensureDir', { relPath: 'secret/sub' }, writeScope()))
      .rejects.toMatchObject({ code: 'WRITE_DISABLED' });
    expect(ensureDir).not.toHaveBeenCalled();

    const noPrimitive = makeHarness({});
    await expect(noPrimitive.sup('fs.ensureDir', { relPath: 'docs/sub' }, writeScope()))
      .rejects.toMatchObject({ code: 'NOT_WIRED', message: expect.stringContaining('ensureDir') });
  });

  it('内核写允许域拒绝 ⇒ WRITE_DISABLED（写闸二原话透出不折叠）', async () => {
    const { sup } = makeHarness({ ensureDir: writeNotAllowed });
    await expect(sup('fs.ensureDir', { relPath: 'docs/sub' }, writeScope()))
      .rejects.toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining('写闸二') });
  });

  it('fileTree.create 的 directory 支路照旧是独占非递归（create_dir_exclusive 的缺口只缺登记，不缺能力）', async () => {
    const createDirExclusive = vi.fn(async () => false); // 已存在 ⇒ false ⇒ create 显式报错
    const { sup } = makeHarness({ createDirExclusive });
    await expect(sup('fileTree.create', { relPath: 'docs/sub', kind: 'directory' }, writeScope()))
      .rejects.toMatchObject({ code: 'TOOL_EXECUTION_FAILED' });
    expect(createDirExclusive).toHaveBeenCalledWith('D:/proj/docs/sub');
  });
});

/* ================================================================== *
 * ④ fs.readFileBytes：P1 只拆「根内相对路径」子集
 * ================================================================== */

describe('④ fs.readFileBytes 体积闸与凭据', () => {
  it('小文件 ⇒ base64 与真字节逐字相同 + bytesReturned==sizeBytes + truncated:false + fsFreshness 在场', async () => {
    const bytes = Buffer.from('abc');
    const { sup, invokes } = makeHarness({
      readBytes: bytes.toString('base64'),
      statFile: { exists: true, size: 3, mtimeMs: 5, isDirectory: false },
    });
    const out = (await sup('fs.readFileBytes', { relPath: 'docs/a.erb' }, readScope)) as Record<string, unknown>;
    expect(out['base64']).toBe('YWJj');
    expect(Buffer.from(String(out['base64']), 'base64').equals(bytes)).toBe(true);
    expect(out['bytesReturned']).toBe(3);
    expect(out['bytesTotal']).toBe(3);
    expect(out['truncated']).toBe(false);
    expect(out['maxBytes']).toBe(48_000);
    expect(out['encoding']).toBe('base64');
    expect(out['path']).toBe('docs/a.erb');
    expect(out['fsFreshness']).toBeDefined();
    expect(out['via']).toBe('read_file_bytes');
    // 预检＝**恰一次**单文件 stat；批量 stat 一枚都不许多付
    expect(invokes.filter((c) => c.cmd === 'stat_file')).toHaveLength(1);
    expect(invokes.filter((c) => c.cmd === 'stat_files')).toHaveLength(0);
  });

  it('超过 48 000 B ⇒ 整趟零读原语 + INVALID_ARGS 带分批指引（不静默截断尾部）', async () => {
    const { sup, invokes } = makeHarness({
      statFile: { exists: true, size: 48_001, mtimeMs: 5, isDirectory: false },
    });
    const err = await sup('fs.readFileBytes', { relPath: 'big.bin' }, readScope).catch((e: unknown) => e);
    expect(isMcpFailure(err)).toBe(true);
    expect((err as McpFailure).code).toBe('INVALID_ARGS');
    expect((err as McpFailure).message).toContain('48000');
    expect(invokes.filter((c) => c.cmd === 'read_file_bytes')).toHaveLength(0);
  });

  it('base64 载荷字符数压在宿主不可信串净化闸 65 536 之内（超限会被净化器静默砍尾）', () => {
    const cap = 48_000;
    const b64Chars = Math.ceil(cap / 3) * 4;
    expect(b64Chars).toBeLessThan(65_536);
    expect(b64Chars).toBe(64_000);
  });

  it('载荷长度与 stat 尺寸判不出同一份 ⇒ 显式失败，不拿 stat 的数字冒充读到的字节', async () => {
    const { sup } = makeHarness({
      readBytes: '!!not-base64!!',
      statFile: { exists: true, size: 3, mtimeMs: 5, isDirectory: false },
    });
    await expect(sup('fs.readFileBytes', { relPath: 'docs/a.erb' }, readScope))
      .rejects.toMatchObject({ code: 'TOOL_EXECUTION_FAILED' });
  });

  it('不存在 ⇒ 显式失败且零读原语；目录 ⇒ 人话拒绝', async () => {
    const gone = makeHarness({ statFile: null });
    const { sup: supGone, invokes } = gone;
    await expect(supGone('fs.readFileBytes', { relPath: 'docs/none.erb' }, readScope))
      .rejects.toMatchObject({ code: 'TOOL_EXECUTION_FAILED' });
    expect(invokes.filter((c) => c.cmd === 'read_file_bytes')).toHaveLength(0);

    const dir = makeHarness({ statFile: { exists: true, size: 0, mtimeMs: 1, isDirectory: true } });
    await expect(dir.sup('fs.readFileBytes', { relPath: 'docs' }, readScope))
      .rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('目录') });
  });

  it('绝对路径 / 盘符 / .. 与 fs.readFile 同一把尺当场拒；不收 rootId', async () => {
    const { sup, invokes } = makeHarness({});
    for (const bad of ['D:/proj/docs/a.erb', '/etc/passwd', '../x.erb', 'C:/Windows/x']) {
      await expect(sup('fs.readFileBytes', { relPath: bad }, readScope)).rejects.toBeInstanceOf(McpFailure);
    }
    expect(invokes.filter((c) => c.cmd === 'read_file_bytes')).toHaveLength(0);
    await expect(sup('fs.readFileBytes', { relPath: 'docs/a.erb', rootId: 'ws:1a2b3c4d' }, readScope))
      .rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('本面刻意不分页：入参只有 relPath 一枚（没有 limit / cursor / offset）', () => {
    const spec = SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === 'fs.readFileBytes')!;
    const props = (spec.inputSchema as Record<string, unknown>)['properties'] as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(['relPath']);
  });
});

/* ================================================================== *
 * ⑤ 脏缓冲红线：不许把作者没保存的东西静默顶掉
 * ================================================================== */

describe('⑤ 覆盖/删除目标正开在编辑器里且有未保存改动 ⇒ 显式拒绝', () => {
  it('fs.copyFile overwrite:true 但落点 dirty ⇒ 拒绝 + copyFile 零调用 + 人话说明', async () => {
    const copyFile = vi.fn(async () => undefined);
    const { sup } = makeHarness({
      copyFile,
      dirty: { [DEST_ABS]: true },
      statFiles: [
        { path: SRC_ABS, exists: true, size: 3, mtimeMs: 11 },
        { path: DEST_ABS, exists: true, size: 9, mtimeMs: 12 },
      ],
    });
    await expect(sup('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'docs/b.erb', overwrite: true }, writeScope()))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('落点 dirty 判不出（null）⇒ 不拿「判不出」当「没脏」，照旧拒绝并交代判据', async () => {
    const copyFile = vi.fn(async () => undefined);
    const { sup } = makeHarness({
      copyFile,
      dirty: { [DEST_ABS]: null },
      statFiles: [
        { path: SRC_ABS, exists: true, size: 3, mtimeMs: 11 },
        { path: DEST_ABS, exists: true, size: 9, mtimeMs: 12 },
      ],
    });
    const err = await sup('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'docs/b.erb', overwrite: true }, writeScope()).catch((e: unknown) => e);
    expect(isMcpFailure(err)).toBe(true);
    expect((err as McpFailure).message).toMatch(/判不出|null/);
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('落点没开在编辑器里（反查给 null＝没有这一格）⇒ 放行，但回执带 bufferState 读数', async () => {
    const copyFile = vi.fn(async () => undefined);
    const { sup } = makeHarness({
      copyFile,
      dirty: {},
      statFiles: [
        { path: SRC_ABS, exists: true, size: 3, mtimeMs: 11 },
        { path: DEST_ABS, exists: true, size: 9, mtimeMs: 12 },
      ],
    });
    const out = (await sup('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'docs/b.erb', overwrite: true }, writeScope())) as Record<string, unknown>;
    expect(out['bufferState']).toBe('not-open');
    expect(copyFile).toHaveBeenCalledTimes(1);
  });

  it('seam 缺席（生产动态 import 拿不到登记簿）⇒ 如实标 bufferState:"unknown" 并放行（不静默假装干净，也不误拒）', async () => {
    const copyFile = vi.fn(async () => undefined);
    const { sup } = makeHarness({
      copyFile,
      statFiles: [
        { path: SRC_ABS, exists: true, size: 3, mtimeMs: 11 },
        { path: DEST_ABS, exists: true, size: 9, mtimeMs: 12 },
      ],
    });
    const out = (await sup('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'docs/b.erb', overwrite: true }, writeScope())) as Record<string, unknown>;
    expect(out['bufferState']).toBe('unknown');
  });

  it('新建路径（overwrite:false 那一路）不吃脏闸：不反查、不拒绝', async () => {
    const copyFile = vi.fn(async () => undefined);
    const { sup } = makeHarness({ copyFile, dirty: { [DEST_ABS]: true } });
    const out = (await sup('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'docs/b.erb' }, writeScope())) as Record<string, unknown>;
    expect(out['bufferState']).toBe('not-applicable');
    expect(copyFile).toHaveBeenCalledTimes(1);
  });
});

/* ================================================================== *
 * ⑥ 入参出厂即严格 + 漂移闸双向对账所需形状
 * ================================================================== */

describe('⑥ 入参严格化与漂移闸形状', () => {
  it('未知键 ⇒ INVALID_ARGS 点名未知键并摊开本面合法清单', async () => {
    const { reg } = makeRegistry();
    const err = await reg.callTool('fs.copyFile', { srcRelPath: 'docs/a.erb', relPath: 'docs/b.erb', destRelPath: 'docs/c.erb' }, writeScope()).catch((e: unknown) => e);
    expect(isMcpFailure(err)).toBe(true);
    expect((err as McpFailure).code).toBe('INVALID_ARGS');
    expect((err as McpFailure).message).toContain('destRelPath');
    expect((err as McpFailure).message).toContain('srcRelPath');
  });

  it('fs.copyFile / fs.ensureDir 的 required 与形状逐枚钉住（漂移闸的声明侧基准）', () => {
    const copy = SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === 'fs.copyFile')!;
    const copySchema = copy.inputSchema as Record<string, unknown>;
    expect(copySchema['required']).toEqual(['srcRelPath', 'relPath']);
    const props = copySchema['properties'] as Record<string, unknown>;
    // 两枚路径都是同一张 RELATIVE_PATH_SCHEMA（pattern 逐字相同 ⇒ 不另造一把尺）
    const readSpec = SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === 'fs.readFile')!;
    const readRel = ((readSpec.inputSchema as Record<string, unknown>)['properties'] as Record<string, unknown>)['relPath'] as Record<string, unknown>;
    expect(props['srcRelPath']).toEqual(readRel);
    expect(props['relPath']).toEqual(readRel);
    expect(props['rootId']).toBeDefined();
    expect(props['overwrite']).toEqual(expect.objectContaining({ type: 'boolean' }));

    const ensure = SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === 'fs.ensureDir')!;
    const ensureSchema = ensure.inputSchema as Record<string, unknown>;
    expect(ensureSchema['required']).toEqual(['relPath']);
    expect(Object.keys(ensureSchema['properties'] as Record<string, unknown>).sort()).toEqual(['relPath', 'rootId']);
  });
});

/* ================================================================== *
 * ⑦ 台账：逐枚 deferred→wired 的落账 + 留账理由
 * ================================================================== */

describe('⑦ 缺口台账前后变化与留账', () => {
  it('四行登记逐条在册（create_dir_exclusive 是「改台账」不是造重复工具）', () => {
    expect(MCP_TOOL_GAP_MAP).toContainEqual({ tool: 'fs.copyFile', gap: 'copy_file', source: 'rust' });
    expect(MCP_TOOL_GAP_MAP).toContainEqual({ tool: 'fs.ensureDir', gap: 'ensure_dir', source: 'rust' });
    expect(MCP_TOOL_GAP_MAP).toContainEqual({ tool: 'fs.readFileBytes', gap: 'read_file_bytes_raw', source: 'rust' });
    expect(MCP_TOOL_GAP_MAP).toContainEqual({ tool: 'fileTree.create', gap: 'create_dir_exclusive', source: 'rust' });
  });

  it('append_frontend_log 继续 deferred，且理由逐条对得上 diagnostics.rs 的代码', () => {
    const note = MCP_DEFERRED_GAP_NOTES.find((n) => n.scope.includes('append_frontend_log'));
    expect(note, '留账必须逐条写进 MCP_DEFERRED_GAP_NOTES').toBeDefined();
    const reason = note!.reason;
    expect(reason).toContain('appData');
    expect(reason).toContain('writablePaths');
    expect(reason).toContain('审计');
    // 对着代码读：这条命令确实不收路径参数、落点写死在 appData 日志目录
    const diag = rustSrc('src/diagnostics.rs');
    expect(diag).toContain('pub async fn append_frontend_log');
    expect(diag).toMatch(/app_data_dir/);
    expect(diag).toContain('frontend-{}.log');
    expect(diag).toMatch(/enforce_size_cap/);
  });

  it('read_file_bytes_raw 的「绝对路径那一半」理由原样保留在册', () => {
    const note = MCP_DEFERRED_GAP_NOTES.find((n) => n.scope.includes('read_file_bytes_raw'));
    expect(note, '绝对路径半格必须仍然留账').toBeDefined();
    expect(note!.reason).toContain('任意绝对路径');
    expect(note!.reason).toContain('ipc::Response');
  });

  it('Rust 侧 rootId 名单文案不再写死「四枚」（六枚写腿同名登记后口径跟着改）', () => {
    const src = rustSrc('src/mcp/protocol.rs');
    expect(src).not.toMatch(/rootId 只允许出现在四枚写腿上/);
  });
});
