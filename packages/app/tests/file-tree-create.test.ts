import { describe, expect, it } from 'vitest';
import { createEntryIfAbsent, entryExistsMessage } from '../src/ui/file-tree-create';

/**
 * WS-01：文件树新建同名条目不得覆盖（2026-10-27 独占创建批之后）。
 *
 * 事故：`commitEdit` 的 create 模式原来直接 `writeBytes(target, 空)` / `ensureDir(target)`，
 * 盘上已有同名文件时把它**静默清空**。修法不是"先 exists 再写"（那只是把窗口缩小），
 * 而是把判存在与建条目交给 OS 级独占创建原语（Rust `CREATE_NEW` / `mkdir`）。
 *
 * 本文件钉住 app 侧接线：
 * - 原语返回 false ⇒ 既有「已存在同名…，未覆盖」文案，编辑行留着（`created:false`）；
 * - 原语返回 true ⇒ 真建了（`created:true`）；
 * - 原语抛错（越权 / 权限 / 父目录没了）⇒ 同一个错误对象原样上抛，绝不折叠成"已存在"；
 * - **端口里根本没有 exists / writeBytes**：假 IO 只实现两条独占原语，"先查后写"在
 *   类型上就无处落脚（下面用 `Object.keys` 把端口的形状也钉一下）。
 *
 * 独立成文件（不塞进 `file-tree.test.ts`）的原因：后者在性能分池的排除表里
 * （`tools/perf-suite.mjs`），主池 `pnpm test` 根本不会跑它——判据放那儿等于没锁。
 */

interface FakeCreateIo {
  /** 盘上"真实存在"的条目（判据只剩这一份事实，没有第二套 exists 替身） */
  entries: Set<string>;
  calls: { createFileExclusive: number; createDirExclusive: number };
  io: {
    createFileExclusive(path: string): Promise<boolean>;
    createDirExclusive(path: string): Promise<boolean>;
  };
}

function fakeCreateIo(
  init: { files?: string[]; dirs?: string[] } = {},
  fail: { file?: Error; dir?: Error } = {},
): FakeCreateIo {
  const entries = new Set([...(init.files ?? []), ...(init.dirs ?? [])]);
  const calls = { createFileExclusive: 0, createDirExclusive: 0 };
  return {
    entries,
    calls,
    io: {
      // 独占原语的语义替身：已在册 ⇒ false（一个字节都不动）；不在册 ⇒ true
      async createFileExclusive(path) {
        calls.createFileExclusive += 1;
        if (fail.file) throw fail.file;
        if (entries.has(path)) return false;
        entries.add(path);
        return true;
      },
      async createDirExclusive(path) {
        calls.createDirExclusive += 1;
        if (fail.dir) throw fail.dir;
        if (entries.has(path)) return false;
        entries.add(path);
        return true;
      },
    },
  };
}

describe('createEntryIfAbsent · 文件', () => {
  it('已存在 ⇒ 原语回 false，给「已存在同名文件，未覆盖：xxx」且不新建', async () => {
    const f = fakeCreateIo({ files: ['C:/p/kojo/001/a.ERB'] });
    const out = await createEntryIfAbsent(f.io, {
      target: 'C:/p/kojo/001/a.ERB',
      kind: 'file',
      name: 'a.ERB',
    });
    expect(out).toEqual({ created: false, reason: 'exists', message: '已存在同名文件，未覆盖：a.ERB' });
    expect(f.calls.createFileExclusive).toBe(1);
    expect(f.calls.createDirExclusive).toBe(0);
    expect(f.entries.has('C:/p/kojo/001/a.ERB')).toBe(true);
  });

  it('不存在 ⇒ 独占原语建一次空文件，created:true', async () => {
    const f = fakeCreateIo();
    await expect(
      createEntryIfAbsent(f.io, { target: 'C:/p/kojo/001/new.ERB', kind: 'file', name: 'new.ERB' }),
    ).resolves.toEqual({ created: true });
    expect(f.calls.createFileExclusive).toBe(1);
    expect(f.calls.createDirExclusive).toBe(0);
    expect(f.entries.has('C:/p/kojo/001/new.ERB')).toBe(true);
  });
});

describe('createEntryIfAbsent · 文件夹', () => {
  it('已存在 ⇒ 原语回 false，给「已存在同名文件夹，未覆盖：xxx」', async () => {
    const f = fakeCreateIo({ dirs: ['C:/p/kojo/001/新包'] });
    const out = await createEntryIfAbsent(f.io, {
      target: 'C:/p/kojo/001/新包',
      kind: 'dir',
      name: '新包',
    });
    expect(out).toEqual({ created: false, reason: 'exists', message: '已存在同名文件夹，未覆盖：新包' });
    expect(f.calls.createFileExclusive).toBe(0);
    expect(f.calls.createDirExclusive).toBe(1);
  });

  it('不存在 ⇒ 独占原语建一次目录，created:true', async () => {
    const f = fakeCreateIo();
    await expect(
      createEntryIfAbsent(f.io, { target: 'C:/p/kojo/001/newdir', kind: 'dir', name: 'newdir' }),
    ).resolves.toEqual({ created: true });
    expect(f.calls.createDirExclusive).toBe(1);
    expect(f.calls.createFileExclusive).toBe(0);
    expect(f.entries.has('C:/p/kojo/001/newdir')).toBe(true);
  });
});

describe('createEntryIfAbsent · 错误原因透传', () => {
  it('原语失败（越权 / 权限 / 父目录没了）⇒ reject 同一个错误对象，不折叠成「已存在」', async () => {
    const ferr = new Error('disk full');
    const f = fakeCreateIo({}, { file: ferr });
    await expect(
      createEntryIfAbsent(f.io, { target: 'C:/p/x.ERB', kind: 'file', name: 'x.ERB' }),
    ).rejects.toBe(ferr);

    const derr = new Error('permission denied');
    const d = fakeCreateIo({}, { dir: derr });
    await expect(
      createEntryIfAbsent(d.io, { target: 'C:/p/d', kind: 'dir', name: 'd' }),
    ).rejects.toBe(derr);
  });
});

describe('CreateEntryIo · 端口形状（先查后写在类型上无处落脚）', () => {
  it('只有两条独占原语：没有 exists / writeBytes / ensureDir', () => {
    const f = fakeCreateIo();
    expect(Object.keys(f.io).sort()).toEqual(['createDirExclusive', 'createFileExclusive']);
    // 反面钉：本模块用到的 IO 面就是 FileIO 的子集，且不含那三个历史方法名
    const port = f.io as unknown as Record<string, unknown>;
    expect(port.exists).toBeUndefined();
    expect(port.writeBytes).toBeUndefined();
    expect(port.ensureDir).toBeUndefined();
  });
});

describe('entryExistsMessage · 措辞只此一处', () => {
  it('文件 / 文件夹分别措辞，都带条目名与「未覆盖」', () => {
    expect(entryExistsMessage('file', 'a.ERB')).toBe('已存在同名文件，未覆盖：a.ERB');
    expect(entryExistsMessage('dir', '包')).toBe('已存在同名文件夹，未覆盖：包');
  });
});
