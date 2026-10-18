/**
 * 填格模板的落盘链路（零 React）：追加文本 / 文件名消毒 / 两条写入口的前置判定。
 *
 * 假 IO 只实现被调用面（exists/isWritable/readText/writeText/walkDir），
 * `filter` 按内核口径在假 walkDir 里兑现——这层若漏筛，模板文件就会混进追加清单。
 */

import { describe, expect, it } from 'vitest';
import type { DirEntry, FileIO, TextFile, WorkspaceService } from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';
import type { FillPack } from '../src/matrix-fill';
import type { WorkspacePackRef } from '../src/matrix-scope';
import {
  appendFillText,
  appendLanguageConflict,
  fillExtension,
  isFillSourceName,
  listFillFiles,
  sanitizeFillFileName,
  suggestFillFileName,
  writeFill,
  type FillWriteResult,
} from '../src/fill-target';

/** 断言失败并取出人话原因（成功会让测试直接红，不用再手写窄化）。 */
function reasonOf(result: FillWriteResult): string {
  if (result.ok) throw new Error('预期写入失败，实际成功');
  return result.reason;
}

/* ------------------------------ 假件 ------------------------------ */

interface FakeIoOptions {
  existing?: readonly string[];
  writable?: readonly string[];
  files?: Record<string, string>;
  walked?: readonly DirEntry[];
  failWrite?: string;
}

function fakeIo(opts: FakeIoOptions = {}): {
  io: FileIO;
  writes: Array<{ path: string; text: string }>;
  files: Record<string, string>;
} {
  const existing = new Set(opts.existing ?? []);
  const writable = new Set(opts.writable ?? []);
  const files = { ...(opts.files ?? {}) };
  const writes: Array<{ path: string; text: string }> = [];

  const io = {
    async exists(path: string) {
      return existing.has(path) || path in files;
    },
    isWritable(path: string) {
      return writable.has(path);
    },
    async readText(path: string): Promise<TextFile> {
      const text = files[path];
      if (text === undefined) throw new Error(`文件不存在：${path}`);
      return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: null };
    },
    async writeText(path: string, text: string) {
      if (opts.failWrite === path) throw new Error('磁盘写入失败');
      writes.push({ path, text });
      files[path] = text;
    },
    async walkDir(_path: string, walkOpts?: { filter?: (e: DirEntry) => boolean }) {
      const all = [...(opts.walked ?? [])];
      return walkOpts?.filter ? all.filter(walkOpts.filter) : all;
    },
  } as unknown as FileIO;

  return { io, writes, files };
}

function fakeWorkspaces(opts: {
  rootPath: string;
  files?: Record<string, string>;
  failWrite?: boolean;
}): {
  workspaces: WorkspaceService;
  writes: Array<{ projectId: string; relPath: string; text: string }>;
} {
  const files = { ...(opts.files ?? {}) };
  const writes: Array<{ projectId: string; relPath: string; text: string }> = [];
  const workspaces = {
    async readText(_projectId: string, relPath: string): Promise<TextFile> {
      const text = files[relPath];
      if (text === undefined) throw new Error(`工作区内不存在：${relPath}`);
      return { path: relPath, text, encoding: 'utf-8', eol: 'lf', mtimeMs: null };
    },
    async writeText(projectId: string, relPath: string, text: string) {
      if (opts.failWrite) throw new Error('工作区写入失败');
      writes.push({ projectId, relPath, text });
      files[relPath] = text;
    },
  } as unknown as WorkspaceService;
  return { workspaces, writes };
}

function packOf(dirPath: string | null): FillPack {
  return { key: 'mine', dirName: 'K1包', label: 'K1包', dirPath, family: '' };
}

const ROOT = 'C:\\ws\\proj\\K1包';

function wsRef(): WorkspacePackRef {
  return {
    projectId: 'p1',
    projectName: '我的口上项目',
    artifactId: 'a1',
    artifactName: 'K1包',
    dirName: 'K1包',
    rootPath: ROOT,
  };
}

function entry(name: string, path: string, isDirectory = false): DirEntry {
  return { name, path, isDirectory };
}

/* ------------------------------ 纯函数 ------------------------------ */

describe('追加目标识别与文件名', () => {
  it('只认口上正文（.kojo 与 ERB body；声明/表格不算）', () => {
    expect(isFillSourceName('口上.kojo')).toBe(true);
    expect(isFillSourceName('口上.ERB')).toBe(true);
    expect(isFillSourceName('口上.erb')).toBe(true);
    expect(isFillSourceName('口上.ERH')).toBe(false);
    expect(isFillSourceName('口上.erm')).toBe(true);
    expect(isFillSourceName('口上.csv')).toBe(false);
  });

  it('扩展名随语言', () => {
    expect(fillExtension('kojo')).toBe('.kojo');
    expect(fillExtension('erb')).toBe('.ERB');
  });

  it('文件名消毒：去非法字符、按语言统一扩展名、空名兜底', () => {
    expect(sanitizeFillFileName('我的/口上:测试.erb', 'kojo')).toBe('我的口上测试.kojo');
    expect(sanitizeFillFileName('abc.ERB', 'kojo')).toBe('abc.kojo');
    expect(sanitizeFillFileName('abc.kojo', 'erb')).toBe('abc.ERB');
    expect(sanitizeFillFileName('   ', 'kojo')).toBe('条件矩阵填空.kojo');
    expect(sanitizeFillFileName('..', 'erb')).toBe('条件矩阵填空.ERB');
    expect(sanitizeFillFileName('无扩展名', 'erb')).toBe('无扩展名.ERB');
  });

  it('建议文件名带角色号与时机标签（标签内分隔符被压平）', () => {
    const name = suggestFillFileName(7, '夜晚/爱慕', 'kojo');
    expect(name).toContain('K7');
    expect(name).toContain('夜晚-爱慕');
    expect(name.endsWith('.kojo')).toBe(true);
    expect(name).not.toContain('/');
  });
});

describe('appendFillText', () => {
  it('空原文从第 1 行开始，末尾补换行', () => {
    expect(appendFillText('', 'CODE')).toEqual({ text: 'CODE\n', line: 1 });
  });

  it('无尾换行：补两行间隔，行号 = 原文行数 + 2', () => {
    expect(appendFillText('a\nb', 'CODE')).toEqual({ text: 'a\nb\n\nCODE\n', line: 4 });
  });

  it('有尾换行：只补一行间隔，行号 = 原文 split 行数 + 1', () => {
    expect(appendFillText('a\nb\n', 'CODE')).toEqual({ text: 'a\nb\n\nCODE\n', line: 4 });
  });
});

describe('appendLanguageConflict', () => {
  it('.kojo 接受两种语言', () => {
    expect(appendLanguageConflict('a.kojo', 'kojo')).toBeNull();
    expect(appendLanguageConflict('a.kojo', 'erb')).toBeNull();
  });

  it('.ERB/.erm 拒绝糖语法并给出人话原因', () => {
    expect(appendLanguageConflict('a.ERB', 'erb')).toBeNull();
    const reason = appendLanguageConflict('a.ERB', 'kojo');
    expect(reason).toContain('.erb');
    expect(reason).toContain('ERB');
    expect(appendLanguageConflict('a.erm', 'kojo')).toContain('.erm');
  });
});

describe('listFillFiles', () => {
  it('只列正文文件、相对路径用 POSIX 分隔、按路径排序', async () => {
    const { io } = fakeIo({
      walked: [
        entry('b.kojo', 'C:\\pkg\\sub\\b.kojo'),
        entry('a.ERB', 'C:\\pkg\\a.ERB'),
        entry('x.erh', 'C:\\pkg\\x.erh'),
      ],
    });
    const files = await listFillFiles(io, 'C:\\pkg');
    expect(files.map((f) => f.relPath)).toEqual(['a.ERB', 'sub/b.kojo']);
    expect(files[1]?.absPath).toBe('C:\\pkg\\sub\\b.kojo');
  });
});

/* ------------------------------ 写入链路 ------------------------------ */

describe('writeFill：工作区新文件', () => {
  it('前置判定：空内容 / 无服务 / 无匹配项目 / 同名', async () => {
    const { io } = fakeIo();
    const base = {
      io,
      place: 'workspace' as const,
      mode: 'new' as const,
      language: 'kojo' as const,
      code: 'CODE',
      pack: packOf(null),
      workspace: wsRef(),
      fileName: '填空',
    };

    expect((await writeFill({ ...base, code: '  ', workspaces: fakeWorkspaces({ rootPath: ROOT }).workspaces })).ok).toBe(false);
    expect(reasonOf(await writeFill(base))).toContain('工作区服务不可用');
    expect(
      reasonOf(
        await writeFill({
          ...base,
          workspaces: fakeWorkspaces({ rootPath: ROOT }).workspaces,
          workspace: undefined,
        }),
      ),
    ).toContain('没有匹配到工作区项目');

    const target = join(ROOT, '填空.kojo');
    const existsIo = fakeIo({ existing: [target] }).io;
    const result = await writeFill({ ...base, io: existsIo, workspaces: fakeWorkspaces({ rootPath: ROOT }).workspaces });
    expect(reasonOf(result)).toContain('同名文件已存在');
  });

  it('成功写入项目内相对路径，扩展名按语言统一，行号为 1', async () => {
    const { io } = fakeIo();
    const { workspaces, writes } = fakeWorkspaces({ rootPath: ROOT });
    const result = await writeFill({
      io,
      workspaces,
      place: 'workspace',
      mode: 'new',
      language: 'kojo',
      code: 'CODE',
      pack: packOf(null),
      workspace: wsRef(),
      fileName: '填空.erb',
    });
    expect(result).toEqual({ ok: true, path: join(ROOT, '填空.kojo'), line: 1 });
    expect(writes).toEqual([{ projectId: 'p1', relPath: 'K1包/填空.kojo', text: 'CODE\n' }]);
  });

  it('写入抛错转成人话原因', async () => {
    const { io } = fakeIo();
    const { workspaces } = fakeWorkspaces({ rootPath: ROOT, failWrite: true });
    const result = await writeFill({
      io,
      workspaces,
      place: 'workspace',
      mode: 'new',
      language: 'kojo',
      code: 'CODE',
      pack: packOf(null),
      workspace: wsRef(),
      fileName: '填空',
    });
    expect(result).toEqual({ ok: false, reason: '工作区写入失败' });
  });
});

describe('writeFill：工作区追加', () => {
  const file = { relPath: 'sub/口上.ERB', absPath: join(ROOT, 'sub', '口上.ERB') };

  it('缺文件项 / 语言冲突都提前拒绝', async () => {
    const { io } = fakeIo();
    const { workspaces, writes } = fakeWorkspaces({ rootPath: ROOT, files: { 'K1包/sub/口上.ERB': 'A\n' } });
    const base = {
      io,
      workspaces,
      place: 'workspace' as const,
      mode: 'append' as const,
      language: 'kojo' as const,
      code: 'CODE',
      pack: packOf(null),
      workspace: wsRef(),
      fileName: 'x',
    };
    expect(reasonOf(await writeFill(base))).toContain('请选择要追加的文件');
    expect(reasonOf(await writeFill({ ...base, file }))).toContain('只能追加原生 ERB');
    expect(writes).toEqual([]);
  });

  it('成功追加：原文保留，块前留一行空行，回执首行行号', async () => {
    const { io } = fakeIo();
    const { workspaces, writes } = fakeWorkspaces({
      rootPath: ROOT,
      files: { 'K1包/sub/口上.ERB': 'A\nB\n' },
    });
    const result = await writeFill({
      io,
      workspaces,
      place: 'workspace',
      mode: 'append',
      language: 'erb',
      code: 'CODE',
      pack: packOf(null),
      workspace: wsRef(),
      fileName: 'x',
      file,
    });
    expect(result).toEqual({ ok: true, path: file.absPath, line: 4 });
    expect(writes[0]?.text).toBe('A\nB\n\nCODE\n');
    expect(writes[0]?.relPath).toBe('K1包/sub/口上.ERB');
  });
});

describe('writeFill：游戏目录', () => {
  const dirPath = 'C:\\game\\K1\\我的包';
  const target = join(dirPath, '填空.kojo');

  it('索引外（无目录）直接拒绝', async () => {
    const { io } = fakeIo();
    const result = await writeFill({
      io,
      place: 'game',
      mode: 'new',
      language: 'kojo',
      code: 'CODE',
      pack: packOf(null),
      fileName: '填空',
    });
    expect(reasonOf(result)).toContain('没有可写的目录');
  });

  it('新文件：未授权 → 拒绝；已授权但同名 → 不覆盖；成功写入带换行', async () => {
    const locked = fakeIo({ existing: [] }).io;
    const denied = await writeFill({
      io: locked,
      place: 'game',
      mode: 'new',
      language: 'kojo',
      code: 'CODE',
      pack: packOf(dirPath),
      fileName: '填空',
    });
    expect(reasonOf(denied)).toContain('写允许域');

    const existsIo = fakeIo({ existing: [target], writable: [target] }).io;
    const exists = await writeFill({
      io: existsIo,
      place: 'game',
      mode: 'new',
      language: 'kojo',
      code: 'CODE',
      pack: packOf(dirPath),
      fileName: '填空',
    });
    expect(reasonOf(exists)).toContain('同名文件已存在');

    const { io, writes } = fakeIo({ writable: [target] });
    const ok = await writeFill({
      io,
      place: 'game',
      mode: 'new',
      language: 'kojo',
      code: 'CODE',
      pack: packOf(dirPath),
      fileName: '填空',
    });
    expect(ok).toEqual({ ok: true, path: target, line: 1 });
    expect(writes).toEqual([{ path: target, text: 'CODE\n' }]);
  });

  it('追加：未授权拒绝；成功时读原文再追加', async () => {
    const absPath = join(dirPath, '口上.kojo');
    const file = { relPath: '口上.kojo', absPath };

    const denied = await writeFill({
      io: fakeIo({ files: { [absPath]: 'A\n' } }).io,
      place: 'game',
      mode: 'append',
      language: 'kojo',
      code: 'CODE',
      pack: packOf(dirPath),
      fileName: 'x',
      file,
    });
    expect(reasonOf(denied)).toContain('写允许域');

    const { io, writes } = fakeIo({ writable: [absPath], files: { [absPath]: 'A\n' } });
    const ok = await writeFill({
      io,
      place: 'game',
      mode: 'append',
      language: 'kojo',
      code: 'CODE',
      pack: packOf(dirPath),
      fileName: 'x',
      file,
    });
    expect(ok).toEqual({ ok: true, path: absPath, line: 3 });
    expect(writes).toEqual([{ path: absPath, text: 'A\n\nCODE\n' }]);
  });
});
