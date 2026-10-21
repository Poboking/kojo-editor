/**
 * 编译落盘链路单测（v0.3 批 S3）：`compileToFile` 的编码 / 双闸 / 备份 / 回读。
 *
 * 分两层：
 * - **替身层**（内存 FileIO）：精确驱动各成功/失败路径（越权、回读不一致、
 *   error 诊断拒绝、备份触发），断言**顺序安全语义**（守卫先于一切副作用）；
 *   K2-PRE-REUSE ③ 起追加「回读失败即回滚」面（坏/半产物不许留盘）；
 * - **真实链路层**（NodeBridge + 临时目录）：端到端写盘 → 回读逐字节一致，
 *   并断言落盘字节确实是 BOM + LF + 末尾换行；另含真 io 的回滚对拍。
 *
 * 全部写临时目录（appData 副本），绝不触真实游戏目录。
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DirEntry, FileStat, FileIO, TextFile, TrashEntry, WriteTextOptions } from '@kojo/plugin-api';
import { SugarCompileError, WriteNotAllowedError } from '@kojo/plugin-api';
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
  /**
   * 一次性介质故障：这些路径的**第一次** `writeBytes` 静默多出一个字节
   * （模拟「写调用成功、盘上字节坏了」→ 回读不一致）。只坏第一次——回滚的
   * 恢复写必须能干净落地，否则测不出回滚正确性（真实 io 的原子写不会次次坏）。
   */
  tamperPaths?: readonly string[];
  /** 回读抛错（触发回读失败路径） */
  failReread?: boolean;
  /** 回滚注定失败（备份读不回 / 删除抛错）——用于验证失败路径的诊断不静默 */
  failRollback?: boolean;
}

/**
 * 内存 FileIO 替身：只实现 compileToFile 触达的方法，语义对齐内核双闸。
 * 越权抛 `WriteNotAllowedError`（真实类型，非名字近似——保证原样传播断言可靠）。
 */
function makeFs(io: HarnessOptions = {}) {
  const files: Record<string, Uint8Array> = { ...(io.files ?? {}) };
  /** 备份桶（照内核 `backup()`：把写前字节复制进 `{appData}/backup/{hash}/`） */
  const backupFiles: Record<string, Uint8Array> = {};
  const backups: string[] = [];
  const written: string[] = [];
  const removed: string[] = [];
  const createdDirs: string[] = [];
  const tampered = new Set<string>();
  const isWritable = io.writable ?? (() => true);

  const guard = (p: string): void => {
    if (!isWritable(p)) throw new WriteNotAllowedError(p, ['<none>']);
  };

  // W11 回收站**如实可用**假桩（内存条目表；口径照 io.ts :293/:310/:324/:330 原文）：
  // listTrash 返回空清单/筛选清单；restore/purge 对未知或形态不合的 id **按契约文本拒绝**
  // （"能听见的结果"）；holdTrash 是会话内软保护（整替语义、纯内存、不落盘）。
  const trashStore = new Map<string, TrashEntry>();
  const trashPayload = new Map<string, Uint8Array>();
  const heldTrash = new Set<string>();
  const requireTrash = (id: string): TrashEntry => {
    if (!/^\d+-[0-9a-f]{8}$/.test(id)) throw new Error(`回收站条目 id 形态不合（应 <ts>-<hash8>）：${id}`);
    const e = trashStore.get(id);
    if (!e) throw new Error(`回收站条目不存在或已被清理：${id}`);
    return e;
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
      if (io.failRollback && p.startsWith('backup://')) throw new Error('backup unreadable');
      const b = files[p] ?? backupFiles[p];
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
      // 一次性介质故障（见 HarnessOptions.tamperPaths）：每个路径只坏第一次写入
      if (io.tamperPaths?.includes(p) && !tampered.has(p)) {
        tampered.add(p);
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
    // 契约 additive（2026-10-16 PERF-10b 批量 stat）：本夹具不核落点 ⇒ 走到即红
    statFiles: async () => { throw new Error('statFiles is not wired in this fake'); },
    setWritableRoots: () => {},
    setAppWritableRoots: () => {},
    addAppWritableRoot: () => {},
    appDataDir: async () => '/appdata',
    rename: async () => { throw new Error('rename is not wired in this fake'); },
    // 契约 additive（2026-10-16 市场与导入 IO 批）：本夹具不提供服务端复制 ⇒ 走到即红
    copyFile: async () => { throw new Error('copyFile is not wired in this fake'); },
    removeDir: async () => { throw new Error('removeDir is not wired in this fake'); },
    // 契约 additive（2026-10-16 文件树编辑批）：如实实现（过同一道闸；不存在按契约拒绝）
    removeFile: async (p: string): Promise<void> => {
      guard(p);
      if (io.failRollback) throw new Error('removeFile exploded');
      if (!(p in files)) throw new Error(`not found: ${p}`);
      delete files[p];
      removed.push(p);
    },
    chooseWorkspaceRoot: async () => {
      throw new Error('chooseWorkspaceRoot is not supported by this fake');
    },
    isWritable,
    backup: async (p: string): Promise<string | null> => {
      if (!(p in files)) return null;
      const target = `backup:///${p.replace(/[/\\:]/g, '_')}.bak`;
      backupFiles[target] = new Uint8Array(files[p]!); // 写前字节进桶（回滚的恢复源）
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
    // 契约 additive（W11 回收站可见批）：如实可用内存桩（判据注释见方法体）
    listTrash: async (opts?: { forPath?: string }): Promise<TrashEntry[]> =>
      [...trashStore.values()]
        .filter((e) => {
          const fp = opts?.forPath;
          // 相关性简化为前缀判（真实 pathKey 判据住内核）：原路径就是它，或它住在被删目录里
          return fp === undefined || e.originalPath === fp || fp.startsWith(`${e.originalPath}/`);
        })
        .sort((a, b) => b.deletedAtMs - a.deletedAtMs),
    restoreFromTrash: async (id: string): Promise<string> => {
      const e = requireTrash(id);
      guard(e.originalPath); // 恢复是一次写盘 ⇒ 第一道闸一条不少（io.ts :310 口径）
      if (e.kind === 'dir') throw new Error(`回收站条目 ${id} 是整目录：本夹具不建模子树载荷，拒绝恢复`);
      const bytes = trashPayload.get(id);
      if (!bytes) throw new Error(`回收站条目 ${id} 在本夹具无载荷字节，拒绝恢复`);
      files[e.originalPath] = bytes;
      trashStore.delete(id);
      trashPayload.delete(id); // 条目用掉即消失——回收站不是第二份历史账
      return e.originalPath;
    },
    purgeTrash: async (ids?: readonly string[]): Promise<number> => {
      if (ids === undefined) {
        // 自动清理口径：只动已超保留期的条目，且跳过本会话被 holdTrash 引用的那些
        let n = 0;
        const now = Date.now();
        for (const [id, e] of [...trashStore]) {
          if (e.expiresAtMs <= now && !heldTrash.has(id)) {
            trashStore.delete(id);
            trashPayload.delete(id);
            n++;
          }
        }
        return n;
      }
      // 显式「彻底删除」：命中即删、不看保留期也不看 hold；任一 id 不合形态/不在 ⇒ 抛，不静默跳过
      for (const id of ids) requireTrash(id);
      for (const id of ids) {
        trashStore.delete(id);
        trashPayload.delete(id);
      }
      return ids.length;
    },
    holdTrash: (ids: readonly string[]): void => {
      heldTrash.clear(); // 整替（照 setWritableRoots 的替换口径）
      for (const id of ids) heldTrash.add(id);
    },
  };

  return { io: api, files, backupFiles, backups, written, removed, createdDirs };
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
    const h = makeFs({ files: { [target]: new TextEncoder().encode('OLD') }, tamperPaths: [target] });
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

/* K2-PRE-REUSE ③：写后回读失败必须回滚到写前状态——坏/半产物不许留盘。
 * 注入形态 = 「写成功、回读失败」：tamperPaths（写调用成功但盘上字节坏了）
 * 或 failReread（回读直接抛）。源文件（写前内容）必须毫发无损地回来。 */
describe('compileToFile · 回读失败回滚（K2-PRE-REUSE ③）', () => {
  it('回读不一致（目标写前存在）→ 抛错前先回滚：写前字节逐字恢复，坏产物不留盘', async () => {
    const target = '/game/個人口上/x.ERB';
    const original = new TextEncoder().encode('OLD');
    const h = makeFs({ files: { [target]: original }, tamperPaths: [target] });
    const svc = makeService(h.io);
    let caught: SugarCompileError | undefined;
    try {
      await svc.compileToFile(GOOD_SOURCE, target);
      expect.unreachable('应当抛错');
    } catch (err) {
      caught = err as SugarCompileError;
    }
    expect(caught?.name).toBe('SugarCompileError');
    expect(caught?.message).toMatch(/回读验证失败.*已回滚到写前状态/);
    // 写前状态逐字节恢复（不是"差不多恢复"——字节级相等）
    expect(Array.from(h.files[target]!)).toEqual(Array.from(original));
    // 备份未被回滚动过（仍是写前那份，手动恢复的兜底），错误携带备份路径
    expect(caught?.backupPath).toBe(h.backups[0]);
    expect(Array.from(h.backupFiles[h.backups[0]!]!)).toEqual(Array.from(original));
  });

  it('回读抛错（目标写前存在）→ 回滚：原文件恢复', async () => {
    const target = '/game/個人口上/x.ERB';
    const original = new TextEncoder().encode('OLD');
    const h = makeFs({ files: { [target]: original }, failReread: true });
    const svc = makeService(h.io);
    await expect(svc.compileToFile(GOOD_SOURCE, target)).rejects.toThrow(/回读验证失败.*已回滚到写前状态/);
    expect(Array.from(h.files[target]!)).toEqual(Array.from(original));
  });

  it('回读抛错（目标写前不存在）→ 回滚：半成品移除，无备份可依', async () => {
    const target = '/game/個人口上/x.ERB';
    const h = makeFs({ failReread: true });
    const svc = makeService(h.io);
    await expect(svc.compileToFile(GOOD_SOURCE, target)).rejects.toThrow(/回读验证失败.*半成品已移除/);
    expect(h.files[target]).toBeUndefined(); // 坏产物不在盘上
    expect(h.removed).toEqual([target]); // 确实走了删除，不是碰运气不存在
  });

  it('回滚自身失败（有备份）→ 诊断如实报告、不静默（备份位置仍在消息里）', async () => {
    const target = '/game/個人口上/x.ERB';
    const original = new TextEncoder().encode('OLD');
    const h = makeFs({ files: { [target]: original }, failReread: true, failRollback: true });
    const svc = makeService(h.io);
    // 盘上留着未回滚的产物——但错误文本必须指名回滚失败与备份兜底（绝不静默）
    await expect(svc.compileToFile(GOOD_SOURCE, target)).rejects.toThrow(/回滚失败.*请手动恢复/s);
  });

  it('回滚自身失败（无备份）→ 诊断明说可能残留半成品（不静默）', async () => {
    const target = '/game/個人口上/x.ERB';
    const h = makeFs({ failReread: true, failRollback: true });
    const svc = makeService(h.io);
    await expect(svc.compileToFile(GOOD_SOURCE, target)).rejects.toThrow(/回滚失败.*可能残留半成品/s);
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

  it('旁挂回读不一致（旁挂写前不存在）→ 只回滚旁挂；主产物已验证通过、保持不动', async () => {
    const target = '/approved/x.ERB';
    const h = makeFs({ tamperPaths: [`${target}.map.json`] });
    const svc = makeService(h.io);
    await expect(svc.compileToFile(GOOD_SOURCE, target, { writeSourceMap: true })).rejects.toThrow(
      /源映射旁挂.*已回滚到写前状态/s,
    );
    // 旁挂回到写前状态（写前不存在 ⇒ 移除），不留坏旁挂
    expect(h.files[`${target}.map.json`]).toBeUndefined();
    expect(h.removed).toEqual([`${target}.map.json`]);
    // 主产物在位且未被牵连：与一次干净编译的产物逐字节相同（可再次编译只补旁挂）
    const clean = makeFs();
    await makeService(clean.io).compileToFile(GOOD_SOURCE, target, { writeSourceMap: true });
    expect(Array.from(h.files[target]!)).toEqual(Array.from(clean.files[target]!));
  });

  it('旁挂回读不一致（旁挂写前已存在）→ 旁挂恢复旧内容；主产物保持', async () => {
    const target = '/approved/x.ERB';
    const sidecar = `${target}.map.json`;
    const oldMap = new TextEncoder().encode('{"old":true}');
    const h = makeFs({ files: { [sidecar]: oldMap }, tamperPaths: [sidecar] });
    const svc = makeService(h.io);
    await expect(svc.compileToFile(GOOD_SOURCE, target, { writeSourceMap: true })).rejects.toThrow(
      /源映射旁挂.*已回滚到写前状态/s,
    );
    expect(Array.from(h.files[sidecar]!)).toEqual(Array.from(oldMap));
    expect(h.files[target]).toBeDefined();
  });
});

/* ============================== 真实链路层（磁盘） ============================== */

/**
 * 一次性写篡改装饰器：包住真 `FileIO`，只把 `target` 的**第一次** `writeBytes`
 * 写成多一字节的坏内容（模拟「写成功、回读失败」）。其余方法经原型链原样
 * 委派（`Object.create` 不复制类方法，查找自然落到真实例上）。
 */
function tamperFirstWrite(real: FileIO, target: string): FileIO {
  let tampered = false;
  const wrapped = Object.create(real) as FileIO;
  wrapped.writeBytes = async (p: string, data: Uint8Array): Promise<void> => {
    if (!tampered && p === target) {
      tampered = true;
      const bad = new Uint8Array(data.length + 1);
      bad.set(data, 0);
      bad[data.length] = 0x00;
      await real.writeBytes(p, bad);
      return;
    }
    await real.writeBytes(p, data);
  };
  return wrapped;
}

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

  it('回读不一致（真 io，目标写前存在）→ 回滚：写前字节逐字恢复，备份兜底仍在盘上', async () => {
    const target = path.join(tmp, '個人口上', 'K12', 'M_KOJO_K12_指令.ERB');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const original = Buffer.from('; 写前的旧产物\n@OLD_K12_310\n', 'utf8');
    await fs.writeFile(target, original);
    io.setWritableRoots([tmp]);
    const svc = createSugarTranspileService({ io: tamperFirstWrite(io, target), faceTable: stubFaceTable() });

    let backupPath: string | null = null;
    try {
      await svc.compileToFile(GOOD_SOURCE, target);
      expect.unreachable('应当抛错');
    } catch (err) {
      const e = err as SugarCompileError;
      expect(e.name).toBe('SugarCompileError');
      expect(e.message).toMatch(/回读验证失败.*已回滚到写前状态/);
      backupPath = e.backupPath;
    }
    // 写前内容逐字节恢复（fs 层对拍，不经过被测代码的读路径）
    expect(await fs.readFile(target)).toEqual(original);
    // 备份兜底仍在盘上、内容就是写前那份（手动恢复可依赖）
    expect(backupPath).toBeTruthy();
    expect(await fs.readFile(backupPath!)).toEqual(original);
  });

  it('回读不一致（真 io，目标写前不存在）→ 回滚：半成品移除，盘上无残留', async () => {
    const target = path.join(tmp, '個人口上', 'K12', 'M_KOJO_K12_310.ERB');
    io.setWritableRoots([tmp]);
    const svc = createSugarTranspileService({ io: tamperFirstWrite(io, target), faceTable: stubFaceTable() });
    await expect(svc.compileToFile(GOOD_SOURCE, target)).rejects.toThrow(/回读验证失败.*半成品已移除/);
    await expect(fs.stat(target)).rejects.toThrow(); // 无半成品残留
  });
});
