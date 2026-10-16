/**
 * 编译落盘链路单测（v0.3 批 S3）：`compileToFile` 的编码 / 双闸 / 备份 / 回读。
 *
 * 分两层：
 * - **替身层**（内存 FileIO）：精确驱动各成功/失败路径（越权、回读不一致、
 *   error 诊断拒绝、备份触发），断言**顺序安全语义**（守卫先于一切副作用）；
 * - **真实链路层**（NodeBridge + 临时目录）：端到端写盘 → 回读逐字节一致，
 *   并断言落盘字节确实是 BOM + LF + 末尾换行。
 *
 * 全部写临时目录（appData 副本），绝不触真实游戏目录。
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DirEntry, FileStat, FileIO, TextFile, WriteTextOptions } from '@kojo/plugin-api';
import { WriteNotAllowedError } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { compileToFile, encodeErbBytes } from '../src/compile';
import { createSugarTranspileService } from '../src/service';
import { stubFaceTable } from './support';

/* ============================== 合成源 ============================== */

/** 最小合法糖源（§6.1 精简版：单时机 + 台词 + 旁白 + 行内条件） */
const GOOD_SOURCE = [
  '; 测试口上',
  '角色: 12',
  '',
  '时机 指令 310：',
  '    「呀……！」',
  '    她缩了一下。 续',
  '',
].join('\n');

/** 带 error 诊断的源：表达式 `当` 缺 `否则`（规范 §3.5 → 编译错误） */
const BAD_SOURCE = [
  '; 缺否则',
  '角色: 12',
  '',
  '时机 指令 311：',
  '    变量 = 当 TFLAG:193：',
  '        是 1 -> 10',
  '',
].join('\n');

/* ============================== 替身 FileIO ============================== */

interface HarnessOptions {
  files?: Record<string, Uint8Array>;
  /** 可写判定（默认可写） */
  writable?: (p: string) => boolean;
  /** 'tamper' = 写盘后篡改落盘内容（触发回读不一致） */
  writeMode?: 'normal' | 'tamper';
  /** 回读抛错（触发回读失败路径） */
  failReread?: boolean;
}

/**
 * 内存 FileIO 替身：只实现 compileToFile 触达的方法，语义对齐内核双闸。
 * 越权抛 `WriteNotAllowedError`（真实类型，非名字近似——保证原样传播断言可靠）。
 */
function makeFs(io: HarnessOptions = {}) {
  const files: Record<string, Uint8Array> = { ...(io.files ?? {}) };
  const backups: string[] = [];
  const written: string[] = [];
  const createdDirs: string[] = [];
  const isWritable = io.writable ?? (() => true);

  const guard = (p: string): void => {
    if (!isWritable(p)) throw new WriteNotAllowedError(p, ['<none>']);
  };

  const api: FileIO = {
    readText: async (p: string): Promise<TextFile> => {
      const b = files[p];
      if (!b) throw new Error(`not found: ${p}`);
      return { path: p, text: new TextDecoder().decode(b), encoding: 'utf-8-bom', eol: 'lf', mtimeMs: 1 };
    },
    readTexts: async (paths: readonly string[]): Promise<Array<TextFile | null>> =>
      Promise.all(paths.map(async (p) => api.readText(p).catch(() => null))),
    readBytes: async (p: string): Promise<Uint8Array> => {
      if (io.failReread && written.includes(p)) throw new Error('readback exploded');
      const b = files[p];
      if (!b) throw new Error(`not found: ${p}`);
      return b;
    },
    // 契约 additive（2026-10-16 市场与导入 IO 批）：批量读 = 逐条读 + 失败位 null
    readBytesMany: async (paths: readonly string[]): Promise<Array<Uint8Array | null>> =>
      Promise.all(paths.map(async (p) => api.readBytes(p).catch(() => null))),
    writeText: async (p: string, text: string, _opts?: WriteTextOptions): Promise<void> => {
      guard(p);
      files[p] = new TextEncoder().encode(text);
    },
    writeBytes: async (p: string, data: Uint8Array): Promise<void> => {
      guard(p);
      written.push(p);
      if (io.writeMode === 'tamper') {
        const mutated = new Uint8Array(data.length + 1);
        mutated.set(data, 0);
        mutated[data.length] = 0x00; // 多一个字节 → 回读长度不一致
        files[p] = mutated;
      } else {
        files[p] = data;
      }
    },
    ensureDir: async (p: string): Promise<void> => {
      guard(p);
      createdDirs.push(p);
    },
    listDir: async (p: string): Promise<DirEntry[]> => {
      const prefix = `${p}/`;
      return Object.keys(files)
        .filter((f) => f.startsWith(prefix))
        .map((f) => ({ name: f.slice(prefix.length), path: f, isDirectory: false }));
    },
    walkDir: async (): Promise<DirEntry[]> => [],
    exists: async (p: string): Promise<boolean> => p in files,
    stat: async (p: string): Promise<FileStat | null> =>
      p in files ? { size: files[p]!.length, mtimeMs: 1, isDirectory: false } : null,
    setWritableRoots: () => {},
    setAppWritableRoots: () => {},
    addAppWritableRoot: () => {},
    appDataDir: async () => '/appdata',
    rename: async () => { throw new Error('rename is not wired in this fake'); },
    // 契约 additive（2026-10-16 市场与导入 IO 批）：本夹具不提供服务端复制 ⇒ 走到即红
    copyFile: async () => { throw new Error('copyFile is not wired in this fake'); },
    removeDir: async () => { throw new Error('removeDir is not wired in this fake'); },
    chooseWorkspaceRoot: async () => {
      throw new Error('chooseWorkspaceRoot is not supported by this fake');
    },
    isWritable,
    backup: async (p: string): Promise<string | null> => {
      if (!(p in files)) return null;
      const target = `backup:///${p.replace(/[/\\:]/g, '_')}.bak`;
      backups.push(target);
      return target;
    },
    listBackups: async () => [],
    restoreBackup: async () => {
      throw new Error('restoreBackup is not supported by this fake');
    },
    exportFile: async () => {
      throw new Error('exportFile is not supported by this fake');
    },
  };

  return { io: api, files, backups, written, createdDirs };
}

/** 真实转译服务（无 adapter 字典——合成源只用原生变量族；分野表来自 eraTW adapter） */
function makeService(io: FileIO) {
  return createSugarTranspileService({ io, faceTable: stubFaceTable() });
}

/* ============================== 编码组装（纯函数） ============================== */

describe('encodeErbBytes · 编码口径', () => {
  it('BOM + LF + 末尾换行（默认口径）：首 3 字节 EF BB BF，无 CR，尾 \n', () => {
    const bytes = encodeErbBytes('A\nB', { bom: true, eol: 'lf', trailingNewline: true });
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes).not.toContain(0x0d);
    expect(bytes[bytes.length - 1]).toBe(0x0a);
    expect(new TextDecoder().decode(bytes).replace('\uFEFF', '')).toBe('A\nB\n');
  });

  it('不给末尾换行时精确去除（不叠加、不吞中间空行）', () => {
    const withTrail = encodeErbBytes('A\nB\n', { bom: false, eol: 'lf', trailingNewline: false });
    expect(new TextDecoder().decode(withTrail)).toBe('A\nB');
    const multi = encodeErbBytes('A\n\n\n', { bom: false, eol: 'lf', trailingNewline: false });
    expect(new TextDecoder().decode(multi)).toBe('A\n\n'); // 只剥一个尾换行
  });

  it('CRLF 显式口径：全部换行展开为 CR LF（规范 §8 字面）', () => {
    const bytes = encodeErbBytes('A\nB', { bom: false, eol: 'crlf', trailingNewline: true });
    expect(new TextDecoder().decode(bytes)).toBe('A\r\nB\r\n');
  });

  it('已含 CRLF 的输入不会二次展开为 \\r\\r\\n', () => {
    const bytes = encodeErbBytes('A\r\nB', { bom: false, eol: 'crlf', trailingNewline: true });
    expect(new TextDecoder().decode(bytes)).toBe('A\r\nB\r\n');
  });

  it('空产物 + 末尾换行：不产出孤立换行（零行不伪造内容）', () => {
    const bytes = encodeErbBytes('', { bom: true, eol: 'lf', trailingNewline: true });
    expect(new TextDecoder().decode(bytes).replace('\uFEFF', '')).toBe('');
  });
});

/* ============================== 替身层：路径与顺序 ============================== */

describe('compileToFile · 守卫（先于一切副作用）', () => {
  it('error 诊断 → 拒绝写盘，且零副作用（不建目录、不备份、不写）', async () => {
    const h = makeFs();
    const svc = makeService(h.io);
    await expect(svc.compileToFile(BAD_SOURCE, '/game/個人口上/x.ERB')).rejects.toThrow(/编译被拒绝/);
    expect(h.written).toEqual([]);
    expect(h.backups).toEqual([]);
    expect(h.createdDirs).toEqual([]);
  });

  it('拒绝错误携带目标路径与诊断上下文（fail-closed 可定位）', async () => {
    const h = makeFs();
    const svc = makeService(h.io);
    try {
      await svc.compileToFile(BAD_SOURCE, '/game/個人口上/x.ERB', { fileName: 'x.kojo' });
      expect.unreachable('应当抛错');
    } catch (err) {
      const e = err as { name?: string; targetPath?: string; diagnostics?: unknown[] };
      expect(e.name).toBe('SugarCompileError');
      expect(e.targetPath).toContain('x.ERB');
      expect((e.diagnostics ?? []).length).toBeGreaterThan(0);
    }
  });

  it('未注入内核 io 的实例：显式报错（不静默假装成功）', async () => {
    const svc = createSugarTranspileService();
    await expect(svc.compileToFile(GOOD_SOURCE, '/t/x.ERB')).rejects.toThrow(/未注入内核文件 IO/);
  });
});

describe('compileToFile · 双闸与备份', () => {
  it('域内端到端：写盘成功、字节数 = 产物字节、无备份（目标原不存在）', async () => {
    const h = makeFs();
    const svc = makeService(h.io);
    const res = await svc.compileToFile(GOOD_SOURCE, '/game/個人口上/x.ERB');
    expect(res.erbPath).toContain('x.ERB');
    expect(res.byteSize).toBe(h.files['/game/個人口上/x.ERB']!.length);
    expect(res.backupPath).toBeNull();
    expect(h.written).toEqual(['/game/個人口上/x.ERB']);
  });

  it('目标已存在 → 先备份再覆盖（备份路径进结果）', async () => {
    const target = '/game/個人口上/x.ERB';
    const h = makeFs({ files: { [target]: new TextEncoder().encode('OLD') } });
    const svc = makeService(h.io);
    const res = await svc.compileToFile(GOOD_SOURCE, target);
    expect(res.backupPath).toBeTruthy();
    expect(h.backups).toHaveLength(1);
    // 覆盖后是新内容，不再是 OLD
    expect(new TextDecoder().decode(h.files[target]!)).not.toBe('OLD');
  });

  it('越权目标（父目录不存在）：在目录创建即拒绝，零写盘', async () => {
    const target = '/game/個人口上/x.ERB';
    const h = makeFs({
      files: { [target]: new TextEncoder().encode('OLD') },
      writable: (p) => p.startsWith('/approved/'),
    });
    const svc = makeService(h.io);
    await expect(svc.compileToFile(GOOD_SOURCE, target)).rejects.toThrow(WriteNotAllowedError);
    // 目录创建在备份之前 → 越权在最早副作用点被拒：无目录、无备份、无写盘、原文件未覆盖
    expect(h.createdDirs).toEqual([]);
    expect(h.backups).toEqual([]);
    expect(h.written).toEqual([]);
    expect(new TextDecoder().decode(h.files[target]!)).toBe('OLD');
  });

  it('越权目标（父目录已存在）：备份已做、未写盘（备份先于写盘的安全语义）', async () => {
    const dir = '/game/個人口上';
    const target = `${dir}/x.ERB`;
    const h = makeFs({
      files: { [dir]: new Uint8Array([1]), [target]: new TextEncoder().encode('OLD') },
      writable: (p) => p.startsWith('/approved/'),
    });
    const svc = makeService(h.io);
    await expect(svc.compileToFile(GOOD_SOURCE, target)).rejects.toThrow(WriteNotAllowedError);
    expect(h.createdDirs).toEqual([]); // 父目录已在 → 不进 ensureDir
    expect(h.backups).toHaveLength(1); // 备份先于写盘 → 已做
    expect(h.written).toEqual([]); // 写盘被拒 → 未发生
    expect(new TextDecoder().decode(h.files[target]!)).toBe('OLD'); // 原文件未覆盖
  });

  it('目标父目录不存在 → 先 ensureDir（域内）', async () => {
    const h = makeFs();
    const svc = makeService(h.io);
    await svc.compileToFile(GOOD_SOURCE, '/approved/K12/M_KOJO_K12_指令.ERB');
    expect(h.createdDirs).toEqual(['/approved/K12']);
  });

  it('父目录已在（目录项显式存在）→ 不再 ensureDir（幂等，避免多余 IO）', async () => {
    const dir = '/approved/K12';
    // 目录以「目录项」形式存在（模拟真实 stat.isDirectory），而非文件占位
    const h = makeFs({ files: {} });
    h.io.exists = async (p: string) => p === dir || p in h.files;
    const svc = makeService(h.io);
    await svc.compileToFile(GOOD_SOURCE, `${dir}/a.ERB`);
    expect(h.createdDirs).toEqual([]);
  });

  it('越权目录创建：拒绝（不先造出域外目录）', async () => {
    const h = makeFs({ writable: (p) => p.startsWith('/approved/') });
    const svc = makeService(h.io);
    await expect(svc.compileToFile(GOOD_SOURCE, '/game/out/x.ERB')).rejects.toThrow(WriteNotAllowedError);
    expect(h.createdDirs).toEqual([]);
    expect(h.written).toEqual([]);
  });
});

describe('compileToFile · 回读验证', () => {
  it('落盘字节与产物不一致 → 显式报错并携带备份路径', async () => {
    const target = '/game/個人口上/x.ERB';
    const h = makeFs({ files: { [target]: new TextEncoder().encode('OLD') }, writeMode: 'tamper' });
    const svc = makeService(h.io);
    await expect(svc.compileToFile(GOOD_SOURCE, target)).rejects.toThrow(/回读验证失败.*备份/);
  });

  it('回读抛错 → 显式报错（不静默吞掉 IO 异常）', async () => {
    const h = makeFs({ failReread: true });
    const svc = makeService(h.io);
    await expect(svc.compileToFile(GOOD_SOURCE, '/game/個人口上/x.ERB')).rejects.toThrow(/回读验证失败/);
  });

  it('成功路径：回读字节与落盘一致（BOM 就位、末尾换行保留）', async () => {
    const h = makeFs();
    const svc = makeService(h.io);
    const target = '/game/個人口上/x.ERB';
    await svc.compileToFile(GOOD_SOURCE, target);
    const bytes = h.files[target]!;
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes[bytes.length - 1]).toBe(0x0a);
    expect(bytes).not.toContain(0x0d);
  });
});

describe('compileToFile · 源映射旁挂', () => {
  it('writeSourceMap: true → 产 .map.json 旁挂且内容可解析', async () => {
    const h = makeFs();
    const svc = makeService(h.io);
    const res = await svc.compileToFile(GOOD_SOURCE, '/approved/x.ERB', { writeSourceMap: true });
    expect(res.sourceMapPath).toBe('/approved/x.ERB.map.json');
    const map = JSON.parse(new TextDecoder().decode(h.files[res.sourceMapPath!]!)) as unknown[];
    expect(Array.isArray(map)).toBe(true);
    expect(map.length).toBeGreaterThan(0);
  });

  it('缺省不写旁挂文件（S3 只产 ERB 本体）', async () => {
    const h = makeFs();
    const svc = makeService(h.io);
    const res = await svc.compileToFile(GOOD_SOURCE, '/approved/x.ERB');
    expect(res.sourceMapPath).toBeUndefined();
    expect(Object.keys(h.files).some((k) => k.endsWith('.map.json'))).toBe(false);
  });
});

/* ============================== 真实链路层（磁盘） ============================== */

describe('compileToFile · 真实磁盘端到端（appData 副本，绝不写游戏目录）', () => {
  let tmp: string;
  let appData: string;
  let io: FileIOServiceImpl;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-sugar-'));
    appData = path.join(tmp, 'appdata');
    io = new FileIOServiceImpl(new NodeBridge(appData), {
      debug() {},
      info() {},
      warn() {},
      error() {},
    });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('端到端：写盘 → 真实回读逐字节一致 + 目录自动创建 + 备份已建', async () => {
    const target = path.join(tmp, '個人口上', 'K12', 'M_KOJO_K12_指令.ERB');
    io.setWritableRoots([tmp]);
    const svc = createSugarTranspileService({ io, faceTable: stubFaceTable() });

    const first = await svc.compileToFile(GOOD_SOURCE, target);
    expect(first.backupPath).toBeNull(); // 首次：目标不存在
    const onDisk = await fs.readFile(target);
    expect(Array.from(onDisk.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]); // BOM
    expect(onDisk[onDisk.length - 1]).toBe(0x0a); // 末尾换行
    expect(onDisk.includes(0x0d)).toBe(false); // LF（无 CR）
    expect(onDisk.length).toBe(first.byteSize);

    // 二次编译同一目标 → 触发备份
    const second = await svc.compileToFile(GOOD_SOURCE, target);
    expect(second.backupPath).toBeTruthy();
    expect(await fs.readFile(second.backupPath!)).toBeInstanceOf(Buffer);
  });

  it('越权目标（tmp 外层）被内核第一道闸拒绝，且不写盘', async () => {
    const outside = path.join(os.tmpdir(), `kojo-outside-${Date.now()}`, 'x.ERB');
    io.setWritableRoots([tmp]);
    const svc = createSugarTranspileService({ io, faceTable: stubFaceTable() });
    await expect(svc.compileToFile(GOOD_SOURCE, outside)).rejects.toThrow(WriteNotAllowedError);
    await expect(fs.stat(outside)).rejects.toThrow();
  });

  it('产物过 ERB 骨架：BOM 剥离后首行为函数定义（可被引擎加载的形态）', async () => {
    const target = path.join(tmp, 'K12', 'a.ERB');
    io.setWritableRoots([tmp]);
    const svc = createSugarTranspileService({ io, faceTable: stubFaceTable() });
    await svc.compileToFile(GOOD_SOURCE, target);
    const text = (await io.readText(target)).text;
    // 头部注释会保留在最前（第 3 条），故断言`首个非注释行`是函数定义
    const firstCode = text.split('\n').find((l) => l.trim().length > 0 && !l.trimStart().startsWith(';'));
    expect(firstCode?.startsWith('@')).toBe(true);
    expect(text).toContain('@M_KOJO_MESSAGE_COM_K12_310');
  });
});
