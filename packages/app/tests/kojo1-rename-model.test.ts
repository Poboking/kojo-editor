/**
 * `.kojo` → `.kojo1` 改名模型（LAU-3b）的钉子。
 *
 * 覆盖三组判据：
 * ① **只挑 v1 写法**：内容指纹判 `kojo2` / `ambiguous` / `empty` 的一律不进候选（不替作者赌）；
 * ② **写盘纪律**：两端写权限、落点冲突、备份失败、改名失败逐条结算，一个失败不拖垮其余；
 * ③ **只改名不改内容**：整个模型没有写文本入口（假 io 的 `writeText` 一次都不许被调用）。
 */
import { describe, expect, it } from 'vitest';
import {
  applyKojo1Renames,
  isKojo1RenameSource,
  kojo1RenameTargetOf,
  planKojo1Renames,
  type Kojo1RenameIoPort,
} from '../src/ui/kojo1-rename-model';

const V1_SOURCE = '角色: 灵梦\n时机 指令 310：\n「你好。」\n';
const KOJO2_SOURCE = '# 机 指令 310\n灵梦：「你好。」\n';
const AMBIGUOUS_SOURCE = '灵梦：「你好。」\n';

interface FakeFiles {
  [path: string]: string;
}

function fakeIo(
  files: FakeFiles,
  opts: { readonlyPaths?: readonly string[]; failBackup?: readonly string[]; failRename?: readonly string[] } = {},
): {
  io: Kojo1RenameIoPort & { readonly calls: string[] };
  readonly: Set<string>;
  files: FakeFiles;
} {
  const readonly = new Set(opts.readonlyPaths ?? []);
  const calls: string[] = [];
  const io = {
    calls,
    async readText(path: string): Promise<{ text: string }> {
      calls.push(`read:${path}`);
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return { text };
    },
    isWritable(path: string): boolean {
      return ![...readonly].some((root) => path.toLowerCase().startsWith(root.toLowerCase()));
    },
    async exists(path: string): Promise<boolean> {
      return files[path] !== undefined;
    },
    async backup(path: string): Promise<string | null> {
      calls.push(`backup:${path}`);
      if ((opts.failBackup ?? []).includes(path)) throw new Error('备份盘满');
      return `C:/backup/${path}`;
    },
    async rename(from: string, to: string): Promise<void> {
      calls.push(`rename:${from}->${to}`);
      if ((opts.failRename ?? []).includes(from)) throw new Error('拒绝访问');
      const text = files[from];
      delete files[from];
      files[to] = text ?? '';
    },
  };
  return { io, readonly, files };
}

describe('① 目标路径：只认 `.kojo`，换尾不换名', () => {
  it('`.kojo` → `.kojo1`；大小写与分隔符逐字保留', () => {
    expect(isKojo1RenameSource('C:\\作品\\事件.kojo')).toBe(true);
    expect(isKojo1RenameSource('C:/作品/事件.KOJO')).toBe(true);
    expect(kojo1RenameTargetOf('C:\\作品\\事件.kojo')).toBe('C:\\作品\\事件.kojo1');
    expect(kojo1RenameTargetOf('C:/作品/事件.KOJO')).toBe('C:/作品/事件.kojo1');
  });

  it('`.kojo1` / `.kojo2` / `.erb` / 无扩展名 ⇒ 不进候选', () => {
    expect(isKojo1RenameSource('a.kojo1')).toBe(false);
    expect(isKojo1RenameSource('a.kojo2')).toBe(false);
    expect(isKojo1RenameSource('a.erb')).toBe(false);
    expect(isKojo1RenameSource('kojo')).toBe(false);
    expect(isKojo1RenameSource('')).toBe(false);
    expect(kojo1RenameTargetOf('a.kojo1')).toBeNull();
  });
});

describe('② 计划：内容指纹分流，一票否决的逐条可见', () => {
  it('v1 写法进候选；kojo2 / ambiguous / empty / 读失败各有原因', async () => {
    const { io } = fakeIo({
      'C:/p/a.kojo': V1_SOURCE,
      'C:/p/b.kojo': KOJO2_SOURCE,
      'C:/p/c.kojo': AMBIGUOUS_SOURCE,
      'C:/p/d.kojo': '',
    });
    const plan = await planKojo1Renames(
      ['C:/p/a.kojo', 'C:/p/b.kojo', 'C:/p/c.kojo', 'C:/p/d.kojo', 'C:/p/missing.kojo', 'C:/p/x.erb'],
      io,
    );
    expect(plan.candidates.map((c) => c.from)).toEqual(['C:/p/a.kojo']);
    expect(plan.candidates[0]!.to).toBe('C:/p/a.kojo1');
    expect(plan.candidates[0]!.lineCount).toBe(3);
    expect(plan.skipped.map((s) => [s.path, s.reason])).toEqual([
      ['C:/p/b.kojo', 'kojo2'],
      ['C:/p/c.kojo', 'ambiguous'],
      ['C:/p/d.kojo', 'empty'],
      ['C:/p/missing.kojo', 'read-failed'],
    ]);
    expect(plan.scanned).toBe(4);
  });

  it('只读域 / 落点已存在：计划阶段就排除（清单先让作者看见）', async () => {
    const { io } = fakeIo(
      {
        'C:/p/a.kojo': V1_SOURCE,
        'C:/p/b.kojo': V1_SOURCE,
        'C:/p/b.kojo1': 'already here',
      },
      { readonlyPaths: ['C:/p/a.kojo'] },
    );
    const plan = await planKojo1Renames(['C:/p/a.kojo', 'C:/p/b.kojo'], io);
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped.map((s) => [s.path, s.reason])).toEqual([
      ['C:/p/a.kojo', 'not-writable'],
      ['C:/p/b.kojo', 'destination-exists'],
    ]);
  });

  it('同一文件（大小写 / 分隔符不同）只算一次', async () => {
    const { io } = fakeIo({ 'C:/p/a.kojo': V1_SOURCE });
    const plan = await planKojo1Renames(['C:/p/a.kojo', 'c:/p/A.KOJO'], io);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.scanned).toBe(1);
  });
});

describe('③ 落地：逐文件结算，只改名不写内容', () => {
  it('成功路径 = 备份后改名；一次文本写入都不发生', async () => {
    const { io, files } = fakeIo({ 'C:/p/a.kojo': V1_SOURCE });
    const report = await applyKojo1Renames([{ from: 'C:/p/a.kojo', to: 'C:/p/a.kojo1', lineCount: 3 }], io);
    expect(report.results).toEqual([
      { from: 'C:/p/a.kojo', to: 'C:/p/a.kojo1', kind: 'renamed', message: null },
    ]);
    expect(report.renamed).toEqual([{ from: 'C:/p/a.kojo', to: 'C:/p/a.kojo1' }]);
    expect(io.calls).toEqual([
      'read:C:/p/a.kojo',
      'backup:C:/p/a.kojo',
      'rename:C:/p/a.kojo->C:/p/a.kojo1',
    ]);
    expect(files['C:/p/a.kojo1']).toBe(V1_SOURCE);
    expect(files['C:/p/a.kojo']).toBeUndefined();
  });

  it('只读 / 冲突 / 备份失败 / 改名失败：各记一条，其余照常落地', async () => {
    const { io } = fakeIo(
      {
        'C:/p/ok.kojo': V1_SOURCE,
        'C:/p/ro.kojo': V1_SOURCE,
        'C:/p/conflict.kojo': V1_SOURCE,
        'C:/p/conflict.kojo1': 'existing',
        'C:/p/nobackup.kojo': V1_SOURCE,
        'C:/p/renamefail.kojo': V1_SOURCE,
      },
      {
        readonlyPaths: ['C:/p/ro.kojo'],
        failBackup: ['C:/p/nobackup.kojo'],
        failRename: ['C:/p/renamefail.kojo'],
      },
    );
    const report = await applyKojo1Renames(
      [
        { from: 'C:/p/ok.kojo', to: 'C:/p/ok.kojo1', lineCount: 1 },
        { from: 'C:/p/ro.kojo', to: 'C:/p/ro.kojo1', lineCount: 1 },
        { from: 'C:/p/conflict.kojo', to: 'C:/p/conflict.kojo1', lineCount: 1 },
        { from: 'C:/p/nobackup.kojo', to: 'C:/p/nobackup.kojo1', lineCount: 1 },
        { from: 'C:/p/renamefail.kojo', to: 'C:/p/renamefail.kojo1', lineCount: 1 },
      ],
      io,
    );
    expect(report.results.map((r) => [r.from, r.kind])).toEqual([
      ['C:/p/ok.kojo', 'renamed'],
      ['C:/p/ro.kojo', 'not-writable'],
      ['C:/p/conflict.kojo', 'destination-exists'],
      ['C:/p/nobackup.kojo', 'backup-failed'],
      ['C:/p/renamefail.kojo', 'rename-failed'],
    ]);
    expect(report.renamed).toEqual([{ from: 'C:/p/ok.kojo', to: 'C:/p/ok.kojo1' }]);
  });

  it('清单之后正文被改成 2.0 写法 ⇒ 写前再判一次，不改名', async () => {
    const { io } = fakeIo({ 'C:/p/a.kojo': KOJO2_SOURCE });
    const report = await applyKojo1Renames(
      [{ from: 'C:/p/a.kojo', to: 'C:/p/a.kojo1', lineCount: 1 }],
      io,
    );
    expect(report.results[0]).toMatchObject({ kind: 'content-changed' });
    expect(report.results[0]!.message).toContain('kojo2');
    expect(report.renamed).toEqual([]);
    expect(io.calls).toEqual(['read:C:/p/a.kojo']);
  });

  it('备份失败 ⇒ 这一份不调用 rename（不留无法回滚的盘面）', async () => {
    const { io } = fakeIo({ 'C:/p/a.kojo': V1_SOURCE }, { failBackup: ['C:/p/a.kojo'] });
    await applyKojo1Renames([{ from: 'C:/p/a.kojo', to: 'C:/p/a.kojo1', lineCount: 1 }], io);
    expect(io.calls).toEqual(['read:C:/p/a.kojo', 'backup:C:/p/a.kojo']);
  });
});
