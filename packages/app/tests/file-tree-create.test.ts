import { describe, expect, it } from 'vitest';
import { createEntryIfAbsent, entryExistsMessage } from '../src/ui/file-tree-create';

/**
 * WS-01：文件树新建同名条目不得覆盖。
 *
 * 事故：`commitEdit` 的 create 模式原来直接 `writeBytes(target, 空)` / `ensureDir(target)`，
 * 盘上已有同名文件时把它**静默清空**。判据收在 `file-tree-create`（组件只管接线）：
 * - 存在 ⇒ 一次写/建都不调、原内容不变、给人话（文件 / 文件夹分别措辞）；
 * - 不存在 ⇒ 照旧建空文件 / 建目录（与既有新建链路一致）；
 * - IO 失败 ⇒ 原错误对象原样上抛（调用侧 `noteErr` 才有真实原因可说），exists 判不出来时
 *   也绝不"当成不存在"去盲写。
 *
 * 独立成文件（不塞进 `file-tree.test.ts`）的原因：后者在性能分池的排除表里
 * （`tools/perf-suite.mjs`），主池 `pnpm test` 根本不会跑它——判据放那儿等于没锁。
 */

interface FakeCreateIo {
  files: Map<string, string>;
  dirs: Set<string>;
  calls: { exists: number; writeBytes: number; ensureDir: number };
  io: {
    exists(path: string): Promise<boolean>;
    writeBytes(path: string, data: Uint8Array): Promise<void>;
    ensureDir(path: string): Promise<void>;
  };
}

function fakeCreateIo(
  init: { files?: Record<string, string>; dirs?: string[] } = {},
  fail: { exists?: Error; write?: Error; dir?: Error } = {},
): FakeCreateIo {
  const files = new Map(Object.entries(init.files ?? {}));
  const dirs = new Set(init.dirs ?? []);
  const calls = { exists: 0, writeBytes: 0, ensureDir: 0 };
  return {
    files,
    dirs,
    calls,
    io: {
      async exists(path) {
        calls.exists += 1;
        if (fail.exists) throw fail.exists;
        return files.has(path) || dirs.has(path);
      },
      async writeBytes(path, data) {
        calls.writeBytes += 1;
        if (fail.write) throw fail.write;
        files.set(path, new TextDecoder().decode(data));
      },
      async ensureDir(path) {
        calls.ensureDir += 1;
        if (fail.dir) throw fail.dir;
        dirs.add(path);
      },
    },
  };
}

describe('createEntryIfAbsent · 文件', () => {
  it('已存在 ⇒ 不写、原内容不变，给「已存在同名文件，未覆盖：xxx」', async () => {
    const f = fakeCreateIo({ files: { 'C:/p/kojo/001/a.ERB': '@FOO\nPRINTL 1\n' } });
    const out = await createEntryIfAbsent(f.io, {
      target: 'C:/p/kojo/001/a.ERB',
      kind: 'file',
      name: 'a.ERB',
    });
    expect(out).toEqual({ created: false, reason: 'exists', message: '已存在同名文件，未覆盖：a.ERB' });
    expect(f.calls.writeBytes).toBe(0);
    expect(f.calls.ensureDir).toBe(0);
    expect(f.calls.exists).toBe(1);
    expect(f.files.get('C:/p/kojo/001/a.ERB')).toBe('@FOO\nPRINTL 1\n'); // 原内容一字不丢
  });

  it('不存在 ⇒ 写一次空字节（新建空文件走既有写链路）', async () => {
    const f = fakeCreateIo();
    await expect(
      createEntryIfAbsent(f.io, { target: 'C:/p/kojo/001/new.ERB', kind: 'file', name: 'new.ERB' }),
    ).resolves.toEqual({ created: true });
    expect(f.calls.writeBytes).toBe(1);
    expect(f.calls.ensureDir).toBe(0);
    expect(f.files.get('C:/p/kojo/001/new.ERB')).toBe('');
  });
});

describe('createEntryIfAbsent · 文件夹', () => {
  it('已存在 ⇒ 不 ensureDir，给「已存在同名文件夹，未覆盖：xxx」', async () => {
    const f = fakeCreateIo({ dirs: ['C:/p/kojo/001/新包'] });
    const out = await createEntryIfAbsent(f.io, {
      target: 'C:/p/kojo/001/新包',
      kind: 'dir',
      name: '新包',
    });
    expect(out).toEqual({ created: false, reason: 'exists', message: '已存在同名文件夹，未覆盖：新包' });
    expect(f.calls.writeBytes).toBe(0);
    expect(f.calls.ensureDir).toBe(0);
  });

  it('不存在 ⇒ ensureDir 一次', async () => {
    const f = fakeCreateIo();
    await expect(
      createEntryIfAbsent(f.io, { target: 'C:/p/kojo/001/newdir', kind: 'dir', name: 'newdir' }),
    ).resolves.toEqual({ created: true });
    expect(f.calls.ensureDir).toBe(1);
    expect(f.calls.writeBytes).toBe(0);
    expect(f.dirs.has('C:/p/kojo/001/newdir')).toBe(true);
  });
});

describe('createEntryIfAbsent · 错误原因透传', () => {
  it('写失败 / 建失败 ⇒ reject 同一个错误对象（调用侧 noteErr 说得出真实原因）', async () => {
    const werr = new Error('disk full');
    const w = fakeCreateIo({}, { write: werr });
    await expect(
      createEntryIfAbsent(w.io, { target: 'C:/p/x.ERB', kind: 'file', name: 'x.ERB' }),
    ).rejects.toBe(werr);

    const derr = new Error('permission denied');
    const d = fakeCreateIo({}, { dir: derr });
    await expect(
      createEntryIfAbsent(d.io, { target: 'C:/p/d', kind: 'dir', name: 'd' }),
    ).rejects.toBe(derr);
  });

  it('exists 判不出来 ⇒ 同样 reject，且一次写/建都不调（不盲写）', async () => {
    const eerr = new Error('io unavailable');
    const e = fakeCreateIo({}, { exists: eerr });
    await expect(
      createEntryIfAbsent(e.io, { target: 'C:/p/y.ERB', kind: 'file', name: 'y.ERB' }),
    ).rejects.toBe(eerr);
    await expect(
      createEntryIfAbsent(e.io, { target: 'C:/p/y', kind: 'dir', name: 'y' }),
    ).rejects.toBe(eerr);
    expect(e.calls.writeBytes).toBe(0);
    expect(e.calls.ensureDir).toBe(0);
  });
});

describe('entryExistsMessage · 措辞只此一处', () => {
  it('文件 / 文件夹分别措辞，都带条目名与「未覆盖」', () => {
    expect(entryExistsMessage('file', 'a.ERB')).toBe('已存在同名文件，未覆盖：a.ERB');
    expect(entryExistsMessage('dir', '包')).toBe('已存在同名文件夹，未覆盖：包');
  });
});
