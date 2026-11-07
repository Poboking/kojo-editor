/**
 * B2 批（LaneT，2026-11-06）· 结构化批读面 `fs.readMany` 单测。
 *
 * 钉住的事（每条都能红，不凑绿）：
 * 1. **逐条对应**：items 与 relPaths 1:1（含重复路径）；内核失败位 null ⇒ 显式
 *    `{path, ok:false, error:{code,message}}`，绝不折成空串、绝不跳过该条（铁律 4）；
 * 2. **路径闸与单文件读同源**：任一项越界（绝对路径 / 盘符 / `..`）⇒ 整批 INVALID_ARGS，
 *    批量读原语与壳层 invoke **绝不触达**；
 * 3. **硬上限**：>64 条显式报错并给分批指引，**没有静默截断**；
 * 4. **分页口径不另造**：逐条窗口走 paginateText（默认/上限闸一字未动），逐条 nextCursor
 *    可直接喂 `fs.readFile` 续读同一文件；批次游标非法形状显式报错；
 * 5. **只读自证**：全程不碰任何写原语 / 写命令，不触发索引重建；
 * 6. **性能自证（真数）**：同一批 N 个文件，`fs.readMany` 一次 tools/call、
 *    批量原语调用 **1 次**、壳层 IPC **≤2 次**（1 批读 + 仅在有失败位时的 1 次 stat 分诊）；
 *    N 次 `fs.readFile` 则是 N 次 `read_file_bytes` IPC。墙钟不在假件上冒充实测
 *    ——见回执「真壳未取到」。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MCP_TOOL_GAP_MAP,
  McpFailure,
  SUPPLEMENTAL_TOOL_SPECS,
  decodePageCursor,
  type McpSessionScope,
} from '@kojo/mcp-host';
import { createRunSupplemental, type McpIoDeps, type McpKernelLike } from '../src/mcp/real-sources-io';
import { MCP_BATCH_READ_MAX_PATHS, type BatchTextFile } from '../src/mcp/batch-read-leg';
import { createFsFreshnessTracker, type FsFreshnessKernelLike } from '../src/mcp/fs-freshness';

const scope: McpSessionScope = {
  sessionId: 's1',
  clientId: 'c1',
  tier: 'read',
  approvedRoots: ['D:/proj'],
  approvedTools: [],
};

const ROOT = 'D:\\proj';

interface FakeFs {
  readonly kernel: McpKernelLike;
  readonly invoke: ReturnType<typeof vi.fn>;
  readonly readTexts: ReturnType<typeof vi.fn>;
  readonly files: Map<string, BatchTextFile>;
  readonly missing: Set<string>;
  readonly writeCalls: string[];
}

/**
 * 可控假桥：`files` = 盘上真读数；`missing` = 内核批量读返回 null 的路径
 * （与 readText 抛错的失败条件同尺）。写原语逐个装台账位，被调用即记名 ⇒「只读」可证伪。
 */
function fakeFs(opts: {
  files?: Record<string, string>;
  missing?: string[];
  existsButUnreadable?: string[];
  /** 批量原语返回条数与入参不等时的兜底形状（判据 6 的 accountMismatch 用例） */
  shortResult?: boolean;
  withReadTexts?: boolean;
  statFails?: boolean;
}): FakeFs {
  const files = new Map<string, BatchTextFile>();
  for (const [rel, text] of Object.entries(opts.files ?? {})) {
    files.set(rel, { path: `${ROOT}\\${rel}`, text, encoding: 'utf-8', eol: 'lf', mtimeMs: 1_700_000_000_000 });
  }
  const missing = new Set(opts.missing ?? []);
  const unreadable = new Set(opts.existsButUnreadable ?? []);
  const writeCalls: string[] = [];
  const readTexts = vi.fn(async (paths: readonly string[]) => {
    const out: Array<BatchTextFile | null> = paths.map((p) => {
      const rel = p.startsWith('D:/proj/') ? p.slice('D:/proj/'.length) : p;
      if (missing.has(rel) || unreadable.has(rel)) return null;
      return files.get(rel) ?? null;
    });
    return opts.shortResult === true ? out.slice(0, Math.max(0, out.length - 1)) : out;
  });
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'stat_files') {
      if (opts.statFails === true) throw new Error('假桥：stat_files 不可用');
      const paths = (args?.['paths'] as string[] | undefined) ?? [];
      return paths.map((p) => {
        const rel = p.startsWith('D:/proj/') ? p.slice('D:/proj/'.length) : p;
        const exists = files.has(rel) || unreadable.has(rel);
        return { path: p, exists, size: exists ? 12 : null, mtimeMs: exists ? 1 : null };
      });
    }
    if (cmd === 'read_file_bytes') {
      const p = String(args?.['path'] ?? '');
      const rel = p.startsWith('D:/proj/') ? p.slice('D:/proj/'.length) : p;
      const f = files.get(rel);
      return f ? f.text : null;
    }
    return null;
  });
  const track = (name: string) => async (..._a: unknown[]): Promise<void> => {
    writeCalls.push(name);
  };
  const kernel: McpKernelLike = {
    project: { current: () => ({ rootDir: ROOT, adapterId: 'adapter-a', kojoPaths: [] }) },
    io: {
      walkDir: async () => [],
      ...(opts.withReadTexts === false ? {} : { readTexts }),
      writeText: track('writeText') as never,
      removeFile: track('removeFile') as never,
      rename: track('rename') as never,
    },
    plugins: { list: () => [] },
    services: { tryGet: () => undefined },
    bus: { on: () => () => {}, emit: () => {} },
    slots: { query: () => [] },
  };
  return { kernel, invoke, readTexts, files, missing, writeCalls };
}

function depsOf(fs: FakeFs): McpIoDeps {
  return {
    getKernel: () => fs.kernel,
    getCommands: () => [],
    invoke: fs.invoke as unknown as McpIoDeps['invoke'],
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

const call = (fs: FakeFs, args: Record<string, unknown>, s: McpSessionScope = scope): Promise<unknown> =>
  createRunSupplemental(depsOf(fs))('fs.readMany', args, s);

const itemsOf = (out: Record<string, unknown>): Record<string, unknown>[] => out['items'] as Record<string, unknown>[];

describe('fs.readMany · 逐条对应与不静默', () => {
  it('三文件一次调用：items 与入参 1:1，成功位带正文 / 编码 / EOL / mtime 与分页账', async () => {
    const fs = fakeFs({ files: { 'a.erb': 'alpha\n', 'b.erb': 'beta', 'c.erb': 'gamma' } });
    const out = (await call(fs, { relPaths: ['a.erb', 'b.erb', 'c.erb'] })) as Record<string, unknown>;
    const items = itemsOf(out);
    expect(items.map((i) => i['path'])).toEqual(['a.erb', 'b.erb', 'c.erb']);
    expect(items.map((i) => i['ok'])).toEqual([true, true, true]);
    expect(items.map((i) => i['text'])).toEqual(['alpha\n', 'beta', 'gamma']);
    expect(items[0]).toMatchObject({ textLength: 6, truncated: false, hasMore: false, encoding: 'utf-8', eol: 'lf' });
    expect(out).toMatchObject({ requested: 3, succeeded: 3, failed: 0, truncated: false, hasMore: false, overLimit: false });
    expect(out['charsReturned']).toBe(15);
    expect(typeof out['fingerprint']).toBe('string');
    expect(String(out['via'])).toContain('io.readTexts');
    expect(fs.writeCalls).toEqual([]);
  });

  it('重复路径逐条各答一次（契约：返回数组与入参一一对应，含重复）', async () => {
    const fs = fakeFs({ files: { 'a.erb': 'alpha' } });
    const out = (await call(fs, { relPaths: ['a.erb', 'a.erb'] })) as Record<string, unknown>;
    expect(itemsOf(out).map((i) => i['path'])).toEqual(['a.erb', 'a.erb']);
    expect(out).toMatchObject({ requested: 2, succeeded: 2, failed: 0 });
    expect(fs.readTexts).toHaveBeenCalledTimes(1);
  });

  it('失败位是显式 {ok:false,error:{code,message}}：NOT_FOUND 经一次批量 stat 分诊，绝不折成空串', async () => {
    const fs = fakeFs({ files: { 'a.erb': 'alpha' }, missing: ['gone.erb'] });
    const out = (await call(fs, { relPaths: ['a.erb', 'gone.erb'] })) as Record<string, unknown>;
    const items = itemsOf(out);
    expect(items[1]!['ok']).toBe(false);
    expect(items[1]!['text']).toBeUndefined();
    expect(items[1]!['error']).toMatchObject({ code: 'NOT_FOUND' });
    expect(String((items[1]!['error'] as Record<string, unknown>)['message'])).toContain('gone.erb');
    expect(out).toMatchObject({ succeeded: 1, failed: 1 });
    // 分诊只付**一趟**批量 stat，且只在有失败位时付
    const statCalls = fs.invoke.mock.calls.filter(([c]) => c === 'stat_files');
    expect(statCalls).toHaveLength(1);
    expect(statCalls[0]![1]).toMatchObject({ paths: [`D:/proj/gone.erb`] });
  });

  it('存在但读不回 ⇒ READ_FAILED（不冒充 NOT_FOUND）；stat 分诊本身失败 ⇒ 仍显式 READ_FAILED 并说明无从判定', async () => {
    const fs = fakeFs({ files: { 'a.erb': 'x' }, existsButUnreadable: ['dir.erb'] });
    const out = (await call(fs, { relPaths: ['dir.erb'] })) as Record<string, unknown>;
    const err = itemsOf(out)[0]!['error'] as Record<string, unknown>;
    expect(err['code']).toBe('READ_FAILED');
    expect(String(err['message'])).toContain('路径存在');

    const blind = fakeFs({ files: { 'a.erb': 'x' }, missing: ['gone.erb'], statFails: true });
    const out2 = (await call(blind, { relPaths: ['gone.erb'] })) as Record<string, unknown>;
    const err2 = itemsOf(out2)[0]!['error'] as Record<string, unknown>;
    expect(err2['code']).toBe('READ_FAILED');
    expect(String(err2['message'])).toContain('无从判定');
  });

  it('内核返回条数与入参不等 ⇒ accountMismatch 显式出声，缺的位按失败位记账', async () => {
    const fs = fakeFs({ files: { 'a.erb': 'alpha', 'b.erb': 'beta' }, shortResult: true });
    const out = (await call(fs, { relPaths: ['a.erb', 'b.erb'] })) as Record<string, unknown>;
    expect(out['accountMismatch']).toMatchObject({ requested: 2, returned: 1 });
    expect(itemsOf(out)).toHaveLength(2);
    expect(out).toMatchObject({ succeeded: 1, failed: 1 });
  });

  it('逐条附 fsFreshness（成功位与失败位都带，与 fs.statFiles 同族口径）', async () => {
    const fs = fakeFs({ files: { 'a.erb': 'alpha' }, missing: ['gone.erb'] });
    const out = (await call(fs, { relPaths: ['a.erb', 'gone.erb'] })) as Record<string, unknown>;
    for (const item of itemsOf(out)) {
      const fresh = item['fsFreshness'] as Record<string, unknown>;
      expect(fresh).toBeTruthy();
      expect(fresh).toHaveProperty('available');
      expect(fresh).toHaveProperty('stale');
    }
  });
});

describe('fs.readMany · 路径闸与硬上限（整批拒绝，不静默）', () => {
  it.each([
    ['绝对路径', '/etc/passwd'],
    ['盘符', 'C:/x.erb'],
    ['上跳', '../x.erb'],
    ['空串', ''],
    ['非字符串项', 42],
  ])('relPaths 含 %s ⇒ 整批 INVALID_ARGS，批量读原语与 invoke 绝不触达', async (_label, bad) => {
    const fs = fakeFs({ files: { 'ok.erb': 'alpha' } });
    await expect(call(fs, { relPaths: ['ok.erb', bad as string] })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(fs.readTexts).not.toHaveBeenCalled();
    expect(fs.invoke).not.toHaveBeenCalled();
  });

  it('超过 64 条 ⇒ 显式 INVALID_ARGS + 分批指引；64 条整批可读', async () => {
    const limit = MCP_BATCH_READ_MAX_PATHS;
    expect(limit).toBe(64);
    const many = Array.from({ length: limit + 1 }, (_, i) => `f${i}.erb`);
    const fs = fakeFs({ files: Object.fromEntries(many.map((p) => [p, 'x'])) });
    await expect(call(fs, { relPaths: many })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(call(fs, { relPaths: many })).rejects.toThrow(/绝不静默截断/);
    expect(fs.readTexts).not.toHaveBeenCalled();
    const okPaths = many.slice(0, limit);
    const out = (await call(fs, { relPaths: okPaths })) as Record<string, unknown>;
    expect(out).toMatchObject({ requested: limit, succeeded: limit, failed: 0, maxPathsPerCall: limit, overLimit: false });
    expect(itemsOf(out)).toHaveLength(limit);
    expect(fs.readTexts).toHaveBeenCalledTimes(1);
  });

  it('relPaths 非数组 / 空数组 ⇒ INVALID_ARGS（不空表冒充「没有文件」）', async () => {
    const fs = fakeFs({ files: { 'a.erb': 'x' } });
    await expect(call(fs, { relPaths: [] })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(call(fs, {})).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(call(fs, { relPaths: 'a.erb' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('项目未开 / 内核缺席 / 批量原语缺席 ⇒ 各自显式失败（不降级成逐文件读）', async () => {
    const noProject = fakeFs({ files: {} });
    (noProject.kernel.project as { current: () => unknown }).current = () => null;
    await expect(call(noProject, { relPaths: ['a.erb'] })).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });

    const noKernel: FakeFs = { ...fakeFs({ files: {} }), kernel: null as unknown as McpKernelLike };
    await expect(call(noKernel, { relPaths: ['a.erb'] })).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });

    const slim = fakeFs({ files: { 'a.erb': 'x' }, withReadTexts: false });
    await expect(call(slim, { relPaths: ['a.erb'] })).rejects.toMatchObject({ code: 'NOT_WIRED' });
    expect(slim.invoke).not.toHaveBeenCalled();
  });
});

describe('fs.readMany · 分页口径复用 B1（不新增第二套游标格式）', () => {
  const big = (n: number): string => '字'.repeat(n);

  it('单页闸沿用 fs.readFile：默认 24000、limit 超限夹到 65000（闸值一字未动）', async () => {
    const fs = fakeFs({ files: { 'a.erb': big(90_000), 'b.erb': big(10) } });
    const out = (await call(fs, { relPaths: ['a.erb', 'b.erb'] })) as Record<string, unknown>;
    expect(out['limit']).toBe(24_000);
    expect(itemsOf(out)[0]).toMatchObject({ textLength: 90_000, truncated: true, hasMore: true });
    expect(String(itemsOf(out)[0]!['text'])).toHaveLength(24_000);
    expect(itemsOf(out)[1]).toMatchObject({ text: big(10), truncated: false, hasMore: false });

    const clamped = (await call(fs, { relPaths: ['a.erb'], limit: 5_000_000 })) as Record<string, unknown>;
    expect(clamped['limit']).toBe(65_000);
    expect(String(itemsOf(clamped)[0]!['text'])).toHaveLength(65_000);
  });

  it('逐条 nextCursor 可直接喂 fs.readFile 续读同一文件（拼接 == 全文，无第二套游标）', async () => {
    const text = big(30_000);
    const fs = fakeFs({ files: { 'a.erb': text, 'b.erb': 'short' } });
    const sup = createRunSupplemental(depsOf(fs));
    const first = (await sup('fs.readMany', { relPaths: ['a.erb'], limit: 12_000 }, scope)) as Record<string, unknown>;
    const item = itemsOf(first)[0]!;
    expect(item['hasMore']).toBe(true);
    const cursor = String(item['nextCursor']);
    expect(decodePageCursor(cursor)).not.toBeNull();
    const rest = (await sup('fs.readFile', { relPath: 'a.erb', cursor }, scope)) as Record<string, unknown>;
    expect(`${String(item['text'])}${String(rest['text'])}`).toBe(text);
    expect(rest['textLength']).toBe(30_000);
  });

  it('批次游标续读同一批；清单换了 ⇒ changedDuringPaging 并从 0 重来', async () => {
    const fs = fakeFs({ files: { 'a.erb': big(15_000), 'b.erb': big(15_000) } });
    const first = (await call(fs, { relPaths: ['a.erb', 'b.erb'], limit: 5_000 })) as Record<string, unknown>;
    expect(first['hasMore']).toBe(true);
    const next = (await call(fs, {
      relPaths: ['a.erb', 'b.erb'],
      limit: 5_000,
      cursor: String(first['nextCursor']),
    })) as Record<string, unknown>;
    expect(next['offset']).toBe(5_000);
    expect(next['changedDuringPaging']).toBeUndefined();
    expect(String(itemsOf(next)[0]!['text'])).toBe('字'.repeat(5_000));
    expect(next['charsReturned']).toBe(10_000);
    // 逐页拼接自证：前两页拼起来正好是这两文件的第 0..10000 字符（后面还剩一页）
    for (const i of [0, 1]) {
      const a = String(itemsOf(first)[i]!['text']);
      const b = String(itemsOf(next)[i]!['text']);
      expect(a + b).toBe('字'.repeat(10_000));
      expect(itemsOf(next)[i]!['hasMore']).toBe(true);
      expect(itemsOf(next)[i]!['textLength']).toBe(15_000);
    }

    // 逐页拼接 == 全文：第三页取完后每文件的「各页并集」与一次性读到的正文逐字符相等
    const tail = (await call(fs, {
      relPaths: ['a.erb', 'b.erb'],
      limit: 5_000,
      cursor: String(next['nextCursor']),
    })) as Record<string, unknown>;
    expect(tail['offset']).toBe(10_000);
    expect(tail['hasMore']).toBe(false);
    expect(tail['nextCursor']).toBeNull();
    for (const i of [0, 1]) {
      const joined =
        String(itemsOf(first)[i]!['text']) +
        String(itemsOf(next)[i]!['text']) +
        String(itemsOf(tail)[i]!['text']);
      expect(joined).toBe('字'.repeat(15_000));
      expect(itemsOf(tail)[i]!['hasMore']).toBe(false);
      expect(itemsOf(tail)[i]!['textLength']).toBe(15_000);
    }

    const moved = (await call(fs, {
      relPaths: ['b.erb', 'a.erb'],
      limit: 5_000,
      cursor: String(first['nextCursor']),
    })) as Record<string, unknown>;
    expect(moved['changedDuringPaging']).toBe(true);
    expect(moved['offset']).toBe(0);
    expect(String(moved['note'])).toContain('不可与旧页拼接');
  });

  it('游标形状非法 ⇒ INVALID_ARGS（绝不静默退回第一页冒充连续）', async () => {
    const fs = fakeFs({ files: { 'a.erb': big(20_000) } });
    await expect(call(fs, { relPaths: ['a.erb'], cursor: 'zzzzzzzz:1' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(call(fs, { relPaths: ['a.erb'], cursor: 'nope' })).rejects.toThrow(/cursor 形状不合法/);
  });

  it('裸 offset 越界 ⇒ 空窗口但账目出声（offset 回显 + truncated，不假装读到了）', async () => {
    const fs = fakeFs({ files: { 'a.erb': big(100) } });
    const out = (await call(fs, { relPaths: ['a.erb'], offset: 500 })) as Record<string, unknown>;
    const item = itemsOf(out)[0]!;
    expect(item['ok']).toBe(true);
    expect(String(item['text'])).toBe('');
    expect(item['offset']).toBe(100);
    expect(item['truncated']).toBe(true);
    expect(item['hasMore']).toBe(false);
  });
});

describe('fs.readMany · 性能自证（假桥计 IPC 次数＝真数；墙钟见回执）', () => {
  const table: readonly number[] = [1, 8, 20, 64];

  it.each(table)('N=%i：一次 tools/call、批量原语 1 次、无失败位时壳层 IPC 0 次', async (n) => {
    const paths = Array.from({ length: n }, (_, i) => `f${i}.erb`);
    const fs = fakeFs({ files: Object.fromEntries(paths.map((p) => [p, 'body'])) });
    const out = (await call(fs, { relPaths: paths })) as Record<string, unknown>;
    expect(out).toMatchObject({ requested: n, succeeded: n, failed: 0 });
    expect(fs.readTexts).toHaveBeenCalledTimes(1);
    expect(fs.readTexts.mock.calls[0]![0]).toHaveLength(n);
    // 全成功 ⇒ 一次壳层 IPC 也不付（分诊只在有失败位时发生）
    expect(fs.invoke).not.toHaveBeenCalled();
  });

  it('N=20 对照：fs.readMany 1 次批量 IPC vs fs.readFile 20 次单文件 IPC', async () => {
    const paths = Array.from({ length: 20 }, (_, i) => `f${i}.erb`);
    const batchFs = fakeFs({ files: Object.fromEntries(paths.map((p) => [p, 'body'])) });
    const singleFs = fakeFs({ files: Object.fromEntries(paths.map((p) => [p, 'body'])) });
    const sup = createRunSupplemental(depsOf(singleFs));

    await call(batchFs, { relPaths: paths });
    const batchIpc = batchFs.invoke.mock.calls.length + batchFs.readTexts.mock.calls.length;
    for (const p of paths) await sup('fs.readFile', { relPath: p }, scope);
    const singleIpc = singleFs.invoke.mock.calls.length;

    expect(batchIpc).toBe(1);
    expect(singleIpc).toBe(20);
    expect(singleFs.invoke.mock.calls.every(([c]) => c === 'read_file_bytes')).toBe(true);
  });

  it('只读自证：批读全程零写命令、零写原语（invoke 只出现在 stat_files）', async () => {
    const fs = fakeFs({ files: { 'a.erb': 'alpha' }, missing: ['gone.erb'] });
    await call(fs, { relPaths: ['a.erb', 'gone.erb'] });
    expect(fs.invoke.mock.calls.map(([c]) => c)).toEqual(['stat_files']);
    expect(fs.writeCalls).toEqual([]);
  });
});

describe('fs.readMany · 三件齐落（ToolSpec / GAP_MAP / 真源腿表）', () => {
  const spec = SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === 'fs.readMany');

  it('ToolSpec：tier=read + readOnlyHint + 严格入参（additionalProperties:false、maxItems=硬上限）', () => {
    expect(spec).toBeDefined();
    expect(spec!.tier).toBe('read');
    expect(spec!.annotations?.readOnlyHint).toBe(true);
    expect(spec!.description.length).toBeGreaterThanOrEqual(60);
    // Rust sanitize_tool_descriptor 按 MAX_DESCRIPTION_CHARS=2048 再切一刀：超了就是账面必假
    expect(spec!.description.length).toBeLessThanOrEqual(2048);
    const schema = spec!.inputSchema as Record<string, unknown>;
    expect(schema['additionalProperties']).toBe(false);
    expect(schema['required']).toEqual(['relPaths']);
    const props = schema['properties'] as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['cursor', 'limit', 'offset', 'relPaths']);
    const relPaths = props['relPaths'] as Record<string, unknown>;
    expect(relPaths['maxItems']).toBe(MCP_BATCH_READ_MAX_PATHS);
    expect(relPaths['minItems']).toBe(1);
    // 与 fs.readFile 的 relPath 同一张相对路径闸（pattern 逐字相同 ⇒ 不放宽、不自造）
    const readSchema = SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === 'fs.readFile')!
      .inputSchema as Record<string, unknown>;
    const readRelPath = (readSchema['properties'] as Record<string, unknown>)['relPath'] as Record<string, unknown>;
    expect(relPaths['items']).toEqual(readRelPath);
  });

  it('GAP_MAP：fs.readMany → read_files_raw（rust）在册；B25 起 read_file_bytes_raw 已登记给 fs.readFileBytes（项目根内相对路径子集）', () => {
    expect(MCP_TOOL_GAP_MAP).toContainEqual({ tool: 'fs.readMany', gap: 'read_files_raw', source: 'rust' });
    // B25 兑现：单文件二进制帧只拆「项目根内相对路径」那一子集为具名 edit 面 fs.readFileBytes；
    // 任意绝对路径那一半仍留在 deferred 台账（理由在 MCP_DEFERRED_GAP_NOTES，不造空串假实现）。
    expect(MCP_TOOL_GAP_MAP).toContainEqual({ tool: 'fs.readFileBytes', gap: 'read_file_bytes_raw', source: 'rust' });
    expect(MCP_TOOL_GAP_MAP.some((m) => m.tool === 'read_file_bytes_raw')).toBe(false);
  });

  it('路径闸与 fs.readFile 同一判据：同一批越界输入两侧都整批 INVALID_ARGS', async () => {
    const fs = fakeFs({ files: { 'a.erb': 'x' } });
    const sup = createRunSupplemental(depsOf(fs));
    await expect(sup('fs.readMany', { relPaths: ['../outside.erb'] }, scope)).rejects.toBeInstanceOf(McpFailure);
    await expect(sup('fs.readFile', { relPath: '../outside.erb' }, scope)).rejects.toBeInstanceOf(McpFailure);
  });
});

/* ================================================================== *
 * B13（LaneY，2026-11-06）：逐条 fsFreshness 标注的批量复核**只付一趟**
 * 判据 2 的「一趟证明」：64 条全命中自写回声窗 ⇒ 判定器侧 statFiles 恰 1 次、stat 0 次；
 * 失败位与成功位并进同一趟；窗外/无回声 ⇒ 一枚探针 syscall 都不发。
 * ================================================================== */

describe('fs.readMany · B13 逐条标注一趟批量复核（计数断言）', () => {
  interface Trackerized {
    readonly tracker: ReturnType<typeof createFsFreshnessTracker>;
    readonly stat: ReturnType<typeof vi.fn>;
    readonly statFiles: ReturnType<typeof vi.fn>;
    readonly deps: McpIoDeps;
  }
  /** 给假桥补上监视自述 + stat/statFiles 探针，并把判定器注入腿的 deps。 */
  function withTracker(fs: FakeFs): Trackerized {
    const k = fs.kernel as unknown as { fileWatch?: unknown; io: Record<string, unknown> };
    k.fileWatch = { state: () => ({ status: 'watching', roots: [ROOT], failures: [] }) };
    const stat = vi.fn(async () => ({ exists: true, mtimeMs: Date.now() - 5_000, size: 4 }));
    const statFiles = vi.fn(async (paths: readonly string[]) =>
      paths.map(() => ({ exists: true, mtimeMs: Date.now() - 5_000, size: 4 })),
    );
    k.io['stat'] = stat;
    k.io['statFiles'] = statFiles;
    const tracker = createFsFreshnessTracker(k as unknown as FsFreshnessKernelLike);
    return { tracker, stat, statFiles, deps: { ...depsOf(fs), fsFreshness: () => tracker } };
  }

  it('64 条全命中窗内 ⇒ statFiles 恰 1 次（64 目标并趟）、stat 0 次，逐条定档 stale:false + mtime-recheck', async () => {
    const paths = Array.from({ length: MCP_BATCH_READ_MAX_PATHS }, (_, i) => `f${i}.erb`);
    expect(paths).toHaveLength(64);
    const fs = fakeFs({ files: Object.fromEntries(paths.map((p) => [p, 'body'])) });
    const t = withTracker(fs);
    const sup = createRunSupplemental(t.deps);
    // 基线趟：没有窗内自写回声 ⇒ 复核一枚探针都不发（成本判据起点）。
    await sup('fs.readMany', { relPaths: paths }, scope);
    expect(t.stat).toHaveBeenCalledTimes(0);
    expect(t.statFiles).toHaveBeenCalledTimes(0);
    for (const p of paths) t.tracker.noteSelfWrite({ abs: `D:/proj/${p}`, kind: 'change', scope });
    t.stat.mockClear();
    t.statFiles.mockClear();
    const out = (await sup('fs.readMany', { relPaths: paths }, scope)) as Record<string, unknown>;
    const items = itemsOf(out);
    expect(items).toHaveLength(64);
    // **一趟证明**：64 条命中并成同一趟批量 statFiles；单路径 stat 一枚不发（逐条 await 单条复核 = 64 趟，本批要消灭的形态）。
    expect(t.statFiles).toHaveBeenCalledTimes(1);
    expect(t.statFiles.mock.calls[0]![0]).toHaveLength(64);
    expect(t.stat).toHaveBeenCalledTimes(0);
    for (const it of items) {
      const ff = it['fsFreshness'] as Record<string, unknown>;
      expect(ff['stale']).toBe(false); // 复核证明没变 ⇒ 本次读数即定档（不是「在途」null）
      expect((ff['recheck'] as Record<string, unknown>)['basis']).toBe('mtime-recheck');
    }
    t.tracker.dispose();
  });

  it('批含失败位：成功位与失败位都带标注且并进同一趟（2 目标 ⇒ statFiles 1 次、stat 0 次）', async () => {
    const fs = fakeFs({ files: { 'a.erb': 'alpha' }, missing: ['gone.erb'] });
    const t = withTracker(fs);
    const sup = createRunSupplemental(t.deps);
    await sup('fs.readMany', { relPaths: ['a.erb', 'gone.erb'] }, scope); // 基线
    for (const p of ['a.erb', 'gone.erb']) t.tracker.noteSelfWrite({ abs: `D:/proj/${p}`, kind: 'change', scope });
    t.stat.mockClear();
    t.statFiles.mockClear();
    const out = (await sup('fs.readMany', { relPaths: ['a.erb', 'gone.erb'] }, scope)) as Record<string, unknown>;
    const items = itemsOf(out);
    expect(items[0]!['ok']).toBe(true);
    expect(items[1]!['ok']).toBe(false); // 失败位照样占标注位（不静默跳过）
    expect(t.statFiles).toHaveBeenCalledTimes(1);
    expect(t.statFiles.mock.calls[0]![0]).toHaveLength(2);
    expect(t.stat).toHaveBeenCalledTimes(0);
    for (const it of items) {
      expect((it['fsFreshness'] as Record<string, unknown>)['available']).toBe(true);
    }
    t.tracker.dispose();
  });
});
