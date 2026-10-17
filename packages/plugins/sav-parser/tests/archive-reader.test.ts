/**
 * 归档读取单源（`archive.reader`）判据批（W13 ARCHIVE-READ）。
 *
 * 钉死四件事：
 * 1. **同一条目只有一份字节**：列档 / 深解析 / 取字节 / 落盘全部经同一个引擎，
 *    读到的字节与写出的字节逐字节相同（两处判据迟早漂的地方就在这）；
 * 2. **落点不在允许域时如实拒绝**，理由可读，而且**一个字节都不写、一个目录都不造**；
 * 3. 面板侧的落盘形态只有两种（`workspace` / `dialog`），**没有目标路径参数位**；
 * 4. 空归档 / 畸形条目名（zip-slip 形态：上跳、多层、绝对名）不越界写。
 */

import { describe, expect, it } from 'vitest';
import type {
  ArchiveReaderIo,
  ArchiveReaderService,
  DirEntry,
  FileStat,
  GameProject,
  Logger,
  PluginContext,
  SnapshotScanResult,
  WorkspaceService,
} from '@kojo/plugin-api';
import {
  ARCHIVE_EXTRACT_DIR,
  ArchiveExtractError,
  ArchiveServices,
  assertArchiveEntryName,
  archiveEntryFileName,
  archiveEntryLabel,
  archiveExtractFileName,
  archiveWorkspaceLanding,
  basename,
  isPathUnder,
  join,
  KernelServices,
  WellKnownServices,
  WriteNotAllowedError,
} from '@kojo/plugin-api';
import { ArchiveReaderEngine } from '../src/archive-reader';
import { SnapshotSourceEngine } from '../src/engine';
import { parseArchive } from '../src/parse';
import { createSavParserPlugin } from '../src/index';
import { makeArchiveFile, simpleCharBlock, type ArchiveSpec } from './helpers/synth';

const ROOT = 'C:/Users/author/AppData/kojo/workspaces';
const SAV = 'D:/Game/sav';
const ENTRY = `${SAV}/save01.sav`;

const noop = (): void => {};
const log: Logger = { debug: noop, info: noop, warn: noop, error: noop };

/* ---------------- 假 io：只实现读取器用到的那几个原语，并**照内核口径**判闸 ---------------- */

interface FakeOptions {
  /** 写允许域（内核 io 的 writableRoots + 常驻可写根的替身） */
  writableRoots: string[];
  /** 对话框返回的落点（null = 用户取消） */
  exportPicks?: string | null;
  /** 让 writeBytes 无视 isWritable 直接拒（模拟"过闸后竞态"：宿主第二道闸的那一手） */
  writeAlwaysRefuses?: boolean;
}

function makeFake(files: Record<string, Uint8Array>, opts: FakeOptions) {
  const reads: string[] = [];
  const writes: Array<{ path: string; bytes: Uint8Array }> = [];
  const dirs: string[] = [];
  const exports: Array<{ name: string; bytes: Uint8Array; landing: string | null }> = [];
  const allowed = (p: string): boolean => opts.writableRoots.some((r) => isPathUnder(r, p));
  const io: ArchiveReaderIo = {
    async readBytes(path): Promise<Uint8Array> {
      reads.push(path);
      const b = files[path];
      if (!b) throw new Error(`not found: ${path}`);
      return b;
    },
    async writeBytes(path, data): Promise<void> {
      if (opts.writeAlwaysRefuses || !allowed(path)) throw new WriteNotAllowedError(path, opts.writableRoots);
      writes.push({ path, bytes: data });
    },
    async ensureDir(path): Promise<void> {
      if (!allowed(path)) throw new WriteNotAllowedError(path, opts.writableRoots);
      dirs.push(path);
    },
    isWritable: (path) => allowed(path),
    async exportFile(name, bytes): Promise<string | null> {
      const landing = opts.exportPicks === undefined ? null : opts.exportPicks;
      exports.push({ name, bytes, landing });
      return landing;
    },
  };
  return { io, reads, writes, dirs, exports };
}

/* ---------------- 引擎替身（同一个实例既做解析又被读取器包裹） ---------------- */

function makeEngine(files: Record<string, Uint8Array>, project: GameProject): SnapshotSourceEngine {
  return new SnapshotSourceEngine({
    log,
    getProject: () => project,
    readBytes: async (p) => {
      const b = files[p];
      if (!b) throw new Error(`not found: ${p}`);
      return b;
    },
    listDir: async (dir): Promise<DirEntry[]> => {
      const prefix = `${dir}/`;
      return Object.keys(files)
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map((p) => ({ name: basename(p), path: p, isDirectory: false }));
    },
    stat: async (p): Promise<FileStat | null> =>
      files[p] ? { size: files[p]!.length, mtimeMs: 1_700_000_000_000, isDirectory: false } : null,
    writeBytes: async () => {
      throw new Error('本测试的读侧不该写盘');
    },
    backup: async () => null,
  });
}

function project(): GameProject {
  return {
    rootDir: 'D:/Game',
    adapterId: 'test',
    kojoPaths: [],
    savDir: SAV,
    writablePaths: [],
    charaIndex: new Map(),
  };
}

function spec(): ArchiveSpec {
  return { fileType: 0, saveMes: '第 12 日(夏之月2日)', charCount: 1, charBlock: simpleCharBlock };
}

/** 期望落点（独立写死，不引用被测函数——否则测试只是在自我确认） */
const EXPECT_WORKSPACE_LANDING = join(ROOT, ARCHIVE_EXTRACT_DIR, 'save01.sav');

function makeReader(
  files: Record<string, Uint8Array>,
  opts: FakeOptions,
  over: { workspaceRoot?: () => string } = {},
): { reader: ArchiveReaderService; engine: SnapshotSourceEngine } & ReturnType<typeof makeFake> {
  const fake = makeFake(files, opts);
  const engine = makeEngine(files, project());
  const reader = new ArchiveReaderEngine({
    log,
    source: engine,
    io: fake.io,
    workspaceRoot: over.workspaceRoot ?? (() => ROOT),
  });
  return { ...fake, reader, engine };
}

/* ---------------- 1. 同一条目一份字节 ---------------- */

describe('archive.reader · 一条链一份字节', () => {
  it('scan / current 委托同一个引擎（列档判据不另起一份）', async () => {
    const bytes = makeArchiveFile(spec());
    const h = makeReader({ [ENTRY]: bytes }, { writableRoots: [ROOT] });
    const a = await h.reader.scan();
    expect(h.reader.current()).toBe(a);
    expect(h.reader.current()).toBe(h.engine.current());
    expect(a.entries.map((e) => e.path)).toEqual([ENTRY]);
  });

  it('取字节 / 解析 / 落盘用的是同一份字节（逐字节相同）', async () => {
    const bytes = makeArchiveFile(spec());
    const h = makeReader({ [ENTRY]: bytes }, { writableRoots: [ROOT] });

    const raw = await h.reader.readEntry(ENTRY);
    const parsed = await h.reader.parseEntry(ENTRY, { keepArrayCells: false });
    const direct = await parseArchive(bytes, ENTRY, { keepArrayCells: false });
    expect(parsed.uniqueCode).toBe(direct.uniqueCode);
    expect(parsed.saveMes).toBe(direct.saveMes);

    const out = await h.reader.extractEntry({ kind: 'workspace', entryPath: ENTRY });
    expect(out.bytes).toBe(raw.length);
    expect(h.writes).toHaveLength(1);
    expect([...h.writes[0]!.bytes]).toEqual([...raw]);
    // 落点名 = 条目名，落点目录 = 契约常量（不在别处再拼一份）
    expect(h.writes[0]!.path).toBe(EXPECT_WORKSPACE_LANDING);
    expect(out.landing).toBe(h.writes[0]!.path);
  });

  it('dialog 形态把同一份字节交给法定通道，落点由对话框决定', async () => {
    const bytes = makeArchiveFile(spec());
    const h = makeReader({ [ENTRY]: bytes }, { writableRoots: [ROOT], exportPicks: 'D:/Desktop/out.dat' });
    const out = await h.reader.extractEntry({ kind: 'dialog', entryPath: ENTRY });
    expect(out).toMatchObject({ kind: 'dialog', landing: 'D:/Desktop/out.dat', bytes: bytes.length, cancelled: false });
    expect([...h.exports[0]!.bytes]).toEqual([...(await h.reader.readEntry(ENTRY))]);
    expect(h.writes).toEqual([]); // dialog 侧一条写都不经内核 io（绑在平台命令内）
    expect(h.exports[0]!.name).toBe(basename(ENTRY));
  });

  it('对话框取消 = 如实的 cancelled，不是错误也不写盘', async () => {
    const bytes = makeArchiveFile(spec());
    const h = makeReader({ [ENTRY]: bytes }, { writableRoots: [ROOT], exportPicks: null });
    const out = await h.reader.extractEntry({ kind: 'dialog', entryPath: ENTRY });
    expect(out).toMatchObject({ cancelled: true, landing: '', bytes: bytes.length });
    expect(h.writes).toEqual([]);
  });
});

/* ---------------- 2. 域外落点如实拒绝 ---------------- */

describe('archive.reader · 落点越界如实拒绝', () => {
  it('常驻可写根不在写允许域内 → landing-domain，且零写零建目录', async () => {
    const bytes = makeArchiveFile(spec());
    // 写允许域里**没有**工作区根（例如项目关闭时收回了授权）
    const h = makeReader({ [ENTRY]: bytes }, { writableRoots: ['D:/elsewhere'] });
    const err = await h.reader
      .extractEntry({ kind: 'workspace', entryPath: ENTRY })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchiveExtractError);
    const ae = err as ArchiveExtractError;
    expect(ae.code).toBe('landing-domain');
    expect(ae.message).toContain('写允许域');
    expect(ae.message).toContain(join(ROOT, ARCHIVE_EXTRACT_DIR, basename(ENTRY)));
    expect(h.writes).toEqual([]);
    expect(h.dirs).toEqual([]);
  });

  it('工作区根不可用 → workspace-unavailable（绝不退回到"写别处"）', async () => {
    const bytes = makeArchiveFile(spec());
    const h = makeReader({ [ENTRY]: bytes }, { writableRoots: [ROOT] }, {
      workspaceRoot: () => {
        throw new Error('kernel.workspaces 服务不可用');
      },
    });
    const err = (await h.reader
      .extractEntry({ kind: 'workspace', entryPath: ENTRY })
      .catch((e: unknown) => e)) as ArchiveExtractError;
    expect(err).toBeInstanceOf(ArchiveExtractError);
    expect(err.code).toBe('workspace-unavailable');
    expect(err.message).toContain('kernel.workspaces');
    expect(h.writes).toEqual([]);
  });

  it('判定过了但内核 io 仍拒（第二道闸那一手）→ WriteNotAllowedError 原样上抛，不吞', async () => {
    const bytes = makeArchiveFile(spec());
    const h = makeReader({ [ENTRY]: bytes }, { writableRoots: [ROOT], writeAlwaysRefuses: true });
    const err = await h.reader.extractEntry({ kind: 'workspace', entryPath: ENTRY }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteNotAllowedError);
    expect(h.writes).toEqual([]);
  });

  it('条目读不出来 → entry-unreadable，未写任何字节', async () => {
    const h = makeReader({}, { writableRoots: [ROOT] });
    const err = (await h.reader
      .extractEntry({ kind: 'workspace', entryPath: ENTRY })
      .catch((e: unknown) => e)) as ArchiveExtractError;
    expect(err).toBeInstanceOf(ArchiveExtractError);
    expect(err.code).toBe('entry-unreadable');
    expect(err.message).toContain('未写任何字节');
    expect(h.writes).toEqual([]);
  });
});

/* ---------------- 3-4. 畸形条目名 / 空归档：不越界写 ---------------- */

describe('archive.reader · 条目名闸（zip-slip 形态）', () => {
  it('契约层的条目名校验：上跳 / 多层 / 绝对 / 盘符 / 空段 / 空名一律拒', () => {
    const bad = ['../evil.dat', 'sub/evil.dat', 'C:/Windows/evil.dat', '/etc/passwd', '..', '', '.', 'a\\..\\b.dat'];
    for (const name of bad) {
      let caught: unknown = null;
      try {
        assertArchiveEntryName(name);
      } catch (err) {
        caught = err;
      }
      expect(caught, `条目名 ${JSON.stringify(name)} 应当被拒`).toBeInstanceOf(ArchiveExtractError);
      expect((caught as ArchiveExtractError).code, `条目名 ${JSON.stringify(name)}`).toBe('entry-name');
    }
    expect(assertArchiveEntryName('save01.sav')).toBe('save01.sav');
    // 单层校验之外不改名（大小写 / 点号都原样留着，落盘名由条目自己决定）
    expect(assertArchiveEntryName('A B (2).sav')).toBe('A B (2).sav');
  });

  it('条目路径先经 paths 通道收成单层名，再过闸（无第二份拼接）', () => {
    expect(archiveExtractFileName(`${SAV}/save01.sav`)).toBe('save01.sav');
    expect(archiveEntryFileName(`${SAV}/save01.sav`)).toBe('save01.sav');
    expect(archiveEntryLabel('D:/Game/sav/save01.sav')).toBe('sav/save01.sav');
    expect(() => archiveExtractFileName('..')).toThrow(ArchiveExtractError);
    expect(() => archiveExtractFileName('C:/Game/sav/../..')).toThrow(ArchiveExtractError);
    expect(archiveWorkspaceLanding(ROOT, 'save01.sav')).toBe(join(ROOT, ARCHIVE_EXTRACT_DIR, 'save01.sav'));
  });

  it('名字闸先于任何 IO：畸形条目名连一次读都不发', async () => {
    const h = makeReader({ [ENTRY]: makeArchiveFile(spec()) }, { writableRoots: [ROOT] });
    for (const bad of ['..', '.', 'C:/Game/sav/../..']) {
      const err = (await h.reader
        .extractEntry({ kind: 'workspace', entryPath: bad })
        .catch((e: unknown) => e)) as ArchiveExtractError;
      expect(err, `条目路径 ${JSON.stringify(bad)}`).toBeInstanceOf(ArchiveExtractError);
      expect(err.code, `条目路径 ${JSON.stringify(bad)}`).toBe('entry-name');
    }
    expect(h.reads).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.dirs).toEqual([]);
  });

  it('源路径里带上跳也只落在工作区内（名字收口后落点逃不出根）', async () => {
    const bytes = makeArchiveFile(spec());
    const tricky = `${SAV}/../../Windows/system.dat`;
    const h = makeReader({ [tricky]: bytes }, { writableRoots: [ROOT] });
    const out = await h.reader.extractEntry({ kind: 'workspace', entryPath: tricky });
    expect(isPathUnder(ROOT, out.landing)).toBe(true);
    expect(isPathUnder('C:/Windows', out.landing)).toBe(false);
    expect(out.landing).toBe(join(ROOT, ARCHIVE_EXTRACT_DIR, 'system.dat'));
  });

  it('空归档（零字节条目）落在根内且如实报 0 字节', async () => {
    const h = makeReader({ [ENTRY]: new Uint8Array(0) }, { writableRoots: [ROOT] });
    const out = await h.reader.extractEntry({ kind: 'workspace', entryPath: ENTRY });
    expect(out.bytes).toBe(0);
    expect(out.cancelled).toBe(false);
    expect(isPathUnder(ROOT, out.landing)).toBe(true);
    expect(h.writes[0]!.bytes).toHaveLength(0);
  });

  it('空归档目录：scan 得空表且不报错（不静默由消费方呈现）', async () => {
    const empty: SnapshotScanResult = { dir: SAV, entries: [], scannedAt: 0, durationMs: 0 };
    const reader = new ArchiveReaderEngine({
      log,
      source: { scan: async () => empty, current: () => empty, parse: async () => { throw new Error('无条目'); } },
      io: makeFake({}, { writableRoots: [ROOT] }).io,
      workspaceRoot: () => ROOT,
    });
    expect((await reader.scan()).entries).toEqual([]);
    expect(reader.current()).toBe(empty);
  });
});

/* ---------------- 5. 插件装配：archive.reader 由本插件提供并接上工作区根 ---------------- */

describe('sav-parser 插件装配 · archive.reader', () => {
  function activate(files: Record<string, Uint8Array>, workspace: WorkspaceService | undefined) {
    const services = new Map<string, unknown>();
    const fake = makeFake(files, { writableRoots: [ROOT] });
    /** 插件装配要的是完整 io 面（引擎那一侧只用 listDir/stat/backup；写侧仍由 fake 判闸） */
    const pluginIo = {
      ...fake.io,
      listDir: async (): Promise<DirEntry[]> => [],
      stat: async (): Promise<FileStat | null> => null,
      backup: async (): Promise<string | null> => null,
    };
    const projService = { current: () => project() };
    const ctx = {
      pluginId: 'sav-parser',
      log,
      bus: { on: () => noop, once: () => noop, emit: noop },
      storage: {},
      slots: { register: noop, query: () => [] },
      onDispose: noop,
      provide: (key: string, value: unknown) => {
        services.set(key, value);
      },
      inject: <T,>(key: string): T => {
        if (key === KernelServices.IO) return pluginIo as unknown as T;
        if (key === KernelServices.Project) return projService as unknown as T;
        throw new Error(`unexpected inject: ${key}`);
      },
      tryInject: <T,>(key: string): T | undefined => {
        if (key === KernelServices.Workspaces) return workspace as unknown as T;
        return undefined;
      },
    } as unknown as PluginContext;
    createSavParserPlugin().activate(ctx);
    return { services, fake };
  }

  it('provides 声明 archive.reader；激活后注册可用实例', async () => {
    const bytes = makeArchiveFile(spec());
    const plugin = createSavParserPlugin();
    expect(plugin.provides).toContain(ArchiveServices.Reader);
    const { services } = activate({ [ENTRY]: bytes }, undefined);
    const reader = services.get(ArchiveServices.Reader) as ArchiveReaderService;
    expect(reader).toBeTruthy();
    expect(await reader.readEntry(ENTRY)).toBe(bytes);
  });

  it('workspace 落点取的是 kernel.workspaces 的常驻可写根（不是硬编码目录）', async () => {
    const bytes = makeArchiveFile(spec());
    const workspace = { rootDir: () => ROOT } as unknown as WorkspaceService;
    const { services, fake } = activate({ [ENTRY]: bytes }, workspace);
    const reader = services.get(ArchiveServices.Reader) as ArchiveReaderService;
    const out = await reader.extractEntry({ kind: 'workspace', entryPath: ENTRY });
    expect(out.landing).toBe(EXPECT_WORKSPACE_LANDING);
    expect(fake.writes).toHaveLength(1);
  });

  it('工作区服务缺席 → 读侧照常可用，取出如实拒绝', async () => {
    const bytes = makeArchiveFile(spec());
    const { services } = activate({ [ENTRY]: bytes }, undefined);
    const reader = services.get(ArchiveServices.Reader) as ArchiveReaderService;
    expect(await reader.readEntry(ENTRY)).toBe(bytes);
    const err = (await reader
      .extractEntry({ kind: 'workspace', entryPath: ENTRY })
      .catch((e: unknown) => e)) as ArchiveExtractError;
    expect(err.code).toBe('workspace-unavailable');
  });

  it('snapshot.source 仍在（零改动旧消费方）；两条键指向同一个引擎的读侧', async () => {
    const bytes = makeArchiveFile(spec());
    const { services } = activate({ [ENTRY]: bytes }, undefined);
    expect(services.get(WellKnownServices.SnapshotSource)).toBe(services.get(WellKnownServices.SnapshotWriter));
    const src = services.get(WellKnownServices.SnapshotSource) as SnapshotSourceEngine;
    await src.scan();
    const reader = services.get(ArchiveServices.Reader) as ArchiveReaderEngine;
    expect(reader.current()).toBe(src.current());
  });
});
