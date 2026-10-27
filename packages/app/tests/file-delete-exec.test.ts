import { beforeEach, describe, expect, it } from 'vitest';
import type { TrashEntry } from '@kojo/plugin-api';
import type { DeleteEntry } from '../src/ui/file-delete-plan';
import {
  READONLY_BLOCK_REASON,
  clearDeleteBatchLedger,
  getLastDeleteBatch,
  runBatchDelete,
  undoDeleteBatch,
  type FileDeleteIo,
} from '../src/ui/file-delete-exec';

/**
 * WS-13 2c 车 · **批量删除执行层**（一块假盘 + 一个照内核规矩办的回收站）。
 *
 * 假盘刻意复刻内核 `TrashManager` 的四条行为，因为撤销的成败全押在它们上面：
 * ① `removeFile` / `removeDir` 是**移入**回收站（新条目排在后面，`listTrash` 新在前）；
 * ② `listTrash({forPath})` 的筛子会同时放过**祖先与后代** ⇒ 执行层必须自己再收一次"就是这一条"；
 * ③ 同一路径可能被删过不止一次 ⇒ 撤销只认最近那一份；
 * ④ 恢复时原位站着**文件**（条目也是文件）⇒ 现状先落写前备份账再让位；站着的是**目录** ⇒ 拒绝，
 *    原话上抛——这一条就是"原路径已被占用时如实报，不许静默丢"的落点。
 *
 * 每组都留一份"盘上现在到底是什么"的读数 ⇒ 摘掉任何一条纪律都会红在磁盘状态上。
 */

const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
const parentOf = (p: string): string => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));

interface Entry {
  id: string;
  originalPath: string;
  kind: 'dir' | 'file';
  /** 条目内容：文件 = 本体那一份；目录 = 该目录下的全部文件 */
  files: Map<string, string>;
  dirs: string[];
}

/** 条目 → 契约形态（`bytes` 给 null：执行层不需要大小，只认 id / 原路径 / 种类） */
const view = (e: Entry): TrashEntry => ({
  id: e.id,
  originalPath: e.originalPath,
  kind: e.kind,
  deletedAtMs: Number(e.id.slice(1)) * 1000,
  expiresAtMs: Number(e.id.slice(1)) * 1000,
  bytes: null,
  payloadPath: `${e.originalPath} 的 payload`,
});

class FakeDisk {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  readonly trash: Entry[] = [];
  readonly calls: string[] = [];
  readonly backups: string[] = [];
  /** 这些路径的删除动作直接抛错（占用类失败判据用） */
  readonly failRemove = new Set<string>();
  /** 这些回收站 id 的恢复按指定形态抛错 */
  readonly failRestore = new Map<string, 'occupied' | 'not-writable'>();
  /** 整条"列回收站"的腿都不存在（宿主没有这一格 ⇒ 撤销不许承诺） */
  noTrashRead = false;
  /** 腿在、但读盘失败（回收站目录被打断）⇒ 逐条按"对不上号"处理 */
  listTrashThrows = false;
  /** 关掉"放回原位"这条腿 */
  noRestore = false;
  /** 只回"相关但不是这一条"的条目（祖先条目）：逼执行层自己再收一次 */
  decoyAncestor = false;
  private seq = 0;

  seedFile(path: string, content: string): void {
    this.files.set(norm(path), content);
    let p = parentOf(path);
    while (p !== '' && !this.dirs.has(norm(p))) {
      this.dirs.add(norm(p)); // 盘上的目录一律按归一形态记账（与 removeDir 的判据同一把尺）
      p = parentOf(p);
    }
  }

  seedDir(path: string): void {
    this.dirs.add(norm(path));
  }

  read(path: string): string | undefined {
    return this.files.get(norm(path));
  }

  hasFile(path: string): boolean {
    return this.files.has(norm(path));
  }

  hasDir(path: string): boolean {
    return this.dirs.has(norm(path));
  }

  /** 回收站里指向这条路径的 id（旧在前 ⇒ `at(-1)` 是最近那一份） */
  trashIdsFor(path: string): string[] {
    return this.trash.filter((e) => norm(e.originalPath) === norm(path)).map((e) => e.id);
  }

  io(): FileDeleteIo {
    const disk = this;
    const io: FileDeleteIo = {
      async removeFile(path) {
        disk.calls.push(`removeFile:${norm(path)}`);
        if (disk.failRemove.has(norm(path))) throw new Error(`正被另一个程序占用：${path}`);
        const key = norm(path);
        const content = disk.files.get(key);
        if (content === undefined) throw new Error(`没有这个东西：${path}`); // 内核 removeFile 不做幂等兜底
        disk.files.delete(key);
        disk.trash.push({ id: `T${++disk.seq}`, originalPath: path, kind: 'file', files: new Map([[key, content]]), dirs: [] });
      },
      async removeDir(path) {
        disk.calls.push(`removeDir:${norm(path)}`);
        if (disk.failRemove.has(norm(path))) throw new Error(`正被另一个程序占用：${path}`);
        const key = norm(path);
        if (!disk.dirs.has(key)) return; // 内核 removeDir：不存在时幂等成功
        const innerFiles = new Map<string, string>();
        for (const [p, c] of disk.files) if (p.startsWith(`${key}/`)) innerFiles.set(p, c);
        const innerDirs = [...disk.dirs].filter((x) => x !== key && x.startsWith(`${key}/`));
        for (const p of [...innerFiles.keys()]) disk.files.delete(p);
        for (const p of [...disk.dirs].filter((x) => x === key || x.startsWith(`${key}/`))) disk.dirs.delete(p);
        disk.trash.push({ id: `T${++disk.seq}`, originalPath: path, kind: 'dir', files: innerFiles, dirs: innerDirs });
      },
      async listTrash(opts) {
        if (disk.listTrashThrows) throw new Error('回收站目录读不动');
        const want = opts?.forPath === undefined ? null : norm(opts.forPath);
        const related = (e: Entry): boolean => {
          if (want === null) return true;
          const at = norm(e.originalPath);
          return at === want || at.startsWith(`${want}/`) || want.startsWith(`${at}/`);
        };
        const out = disk.trash.filter(related);
        if (disk.decoyAncestor && want !== null) {
          const decoys = out.filter((e) => norm(e.originalPath) !== want);
          if (decoys.length > 0) return decoys.map((e) => view(e));
        }
        return out.reverse().map((e) => view(e)); // 新在前（与内核 list 的 id 降序同向）
      },
      async restoreFromTrash(id) {
        const idx = disk.trash.findIndex((e) => e.id === id);
        if (idx < 0) throw new Error(`回收站条目不存在或已失效：${id}`);
        const entry = disk.trash[idx]!;
        if (disk.failRestore.get(id) === 'not-writable') {
          const err = new Error('这个位置在只读范围内，不能写入');
          err.name = 'WriteNotAllowedError';
          throw err;
        }
        const target = norm(entry.originalPath);
        const occupantIsDir = disk.dirs.has(target);
        const occupantIsFile = disk.files.has(target);
        // 目录形条目撞上任何东西 ⇒ 拒绝（整棵子树没有一份现状可以备份）；
        // 文件形条目撞上目录 ⇒ 同样拒绝；撞上文件 ⇒ 现状先落备份账再让位
        if ((occupantIsDir || occupantIsFile) && (entry.kind === 'dir' || occupantIsDir || disk.failRestore.get(id) === 'occupied')) {
          throw new Error(`原位置已存在，不能恢复（回收站不覆盖）：${entry.originalPath}`);
        }
        if (entry.kind === 'file') {
          if (occupantIsFile) disk.backups.push(target);
          disk.files.set(target, [...entry.files.values()][0] ?? '');
        } else {
          disk.dirs.add(target);
          for (const dd of entry.dirs) disk.dirs.add(dd);
          for (const [p, c] of entry.files) disk.files.set(p, c);
        }
        disk.trash.splice(idx, 1);
        return entry.originalPath;
      },
    };
    if (this.noRestore) delete (io as { restoreFromTrash?: unknown }).restoreFromTrash;
    if (this.noTrashRead) delete (io as { listTrash?: unknown }).listTrash;
    return io;
  }
}

const PKG = 'C:/koa/001/包A';
const A = `${PKG}/a.ERB`;
const B = `${PKG}/b.ERB`;
const C = 'C:/koa/002/c.csv';
const f = (path: string): DeleteEntry => ({ path, isDir: false });
const d = (path: string): DeleteEntry => ({ path, isDir: true });

let disk: FakeDisk;

beforeEach(() => {
  disk = new FakeDisk();
  disk.seedFile(A, 'AAA');
  disk.seedFile(B, 'BBB');
  disk.seedFile(C, 'CCC');
  clearDeleteBatchLedger();
});

describe('批量删除 · 落盘与回收站对号', () => {
  it('两份文件删成 ⇒ 盘上没了、回收站两份、台账两条、回执点名并给出退路', async () => {
    const out = await runBatchDelete({ io: disk.io(), entries: [f(A), f(C)] });
    expect(out.aborted).toBe(false);
    expect(disk.hasFile(A)).toBe(false);
    expect(disk.hasFile(C)).toBe(false);
    expect(out.deleted.map((r) => r.name)).toEqual(['a.ERB', 'c.csv']);
    expect(out.resultText).toContain('已删除 2 项（2 个文件）');
    expect(out.resultText).toContain('回收站');
    expect(out.resultText).toContain('撤销这次删除');
    expect(getLastDeleteBatch()?.records).toHaveLength(2);
  });

  it('父子同批 ⇒ 只发一条目录删除（对已被带走的子路径再发一次只会得到假失败）', async () => {
    const out = await runBatchDelete({ io: disk.io(), entries: [d(PKG), f(A), f(B)] });
    expect(disk.calls).toEqual([`removeDir:${norm(PKG)}`]);
    expect(out.plan.carried.map((c) => c.name)).toEqual(['a.ERB', 'b.ERB']);
    expect(out.deleted).toHaveLength(1);
    expect(out.resultText).toContain('另有 2 项本来就在被删的文件夹里');
    expect(disk.hasFile(B)).toBe(false);
  });

  it('答"取消" ⇒ 一个字节都不动，台账也不被这次清空', async () => {
    const first = await runBatchDelete({ io: disk.io(), entries: [f(C)] });
    expect(first.deleted).toHaveLength(1);
    const out = await runBatchDelete({ io: disk.io(), entries: [f(A)], confirm: () => false });
    expect(out.aborted).toBe(true);
    expect(out.resultText).toBe('已取消——一个字节都没动。');
    expect(disk.hasFile(A)).toBe(true);
    expect(disk.calls).toEqual([`removeFile:${norm(C)}`]); // 只有第一次那一条
    expect(getLastDeleteBatch()?.records.map((r) => r.name)).toEqual(['c.csv']);
  });

  it('确认框拿到的是逐条点名的文案（判据层备好的那份，一字不改）', async () => {
    let seenText = '';
    await runBatchDelete({
      io: disk.io(),
      entries: [d(PKG)],
      sizeOf: () => ({ files: 2, dirs: 0 }),
      confirm: (_plan, text) => {
        seenText = text;
        return false;
      },
    });
    expect(seenText).toContain('确定删除这 1 项吗？（1 个文件夹）');
    expect(seenText).toContain('这条会带走整个文件夹，里面有 2 个文件');
    expect(seenText).toContain('回收站');
    expect(disk.calls).toEqual([]);
  });

  it('只读那一档：被挡下的点名、不发 IO，其余照删（不许悄悄截成一小批）', async () => {
    const out = await runBatchDelete({
      io: disk.io(),
      entries: [f(A), f(C)],
      blockedOf: (p) => (p === A ? READONLY_BLOCK_REASON : null),
    });
    expect(disk.calls).toEqual([`removeFile:${norm(C)}`]);
    expect(disk.hasFile(A)).toBe(true);
    expect(out.failed.map((x) => x.name)).toEqual(['a.ERB']);
    expect(out.resultText).toContain('只读范围内');
    expect(out.resultText).toContain('a.ERB');
  });

  it('删除本身失败的那条 ⇒ 逐条点名带原话，且不进撤销台账', async () => {
    disk.failRemove.add(norm(C));
    const out = await runBatchDelete({ io: disk.io(), entries: [f(A), f(C)] });
    expect(out.deleted.map((r) => r.name)).toEqual(['a.ERB']);
    expect(out.failed).toEqual([{ name: 'c.csv', reason: expect.stringContaining('正被另一个程序占用') }]);
    expect(out.resultText).toContain('没删成的 1 项：c.csv');
    expect(getLastDeleteBatch()?.records).toHaveLength(1);
  });

  it('一条都发不出去 ⇒ 不发 IO、台账为空、回执说"没有删成任何条目"', async () => {
    const out = await runBatchDelete({ io: disk.io(), entries: [f(A)], blockedOf: () => READONLY_BLOCK_REASON });
    expect(disk.calls).toEqual([]);
    expect(out.batch).toBeNull();
    expect(getLastDeleteBatch()).toBeNull();
    expect(out.resultText).toContain('没有删成任何条目');
  });
});

describe('脏闸 · 复用同一份"哪几份是脏的"投影，只问一次', () => {
  it('命中未保存修改 ⇒ 确认之后问一次（kind=delete，整批名字一次问完）；答"不"整批作废', async () => {
    const asked: string[][] = [];
    const kinds: string[] = [];
    const named: string[][] = [];
    const out = await runBatchDelete({
      io: disk.io(),
      entries: [f(A), f(C)],
      dirty: {
        dirtyOf: (paths) => {
          asked.push([...paths]);
          return ['a.ERB', 'c.csv'];
        },
        askDirty: (kind, names) => {
          kinds.push(kind);
          named.push([...names]);
          return false;
        },
      },
    });
    expect(out.aborted).toBe(true);
    expect(kinds).toEqual(['delete']);
    expect(disk.calls).toEqual([]);
    expect(out.resultText).toContain('未保存的修改');
    // 问的是整批路径（目录命中时点名的是它底下那份脏文件——判据住 dirtyNamesIn）
    expect(asked).toEqual([[A, C]]);
    // 一次问完整批名字，不是逐条对话框（简报那句"问一次"就是问一次）
    expect(named).toEqual([['a.ERB', 'c.csv']]);
  });

  it('答"继续" ⇒ 照删，且第二次不再问（一次批删只烦作者一遍）', async () => {
    let questions = 0;
    const out = await runBatchDelete({
      io: disk.io(),
      entries: [f(A), f(C)],
      dirty: { dirtyOf: () => ['a.ERB'], askDirty: () => (questions += 1, true) },
    });
    expect(questions).toBe(1);
    expect(out.deleted).toHaveLength(2);
    expect(disk.hasFile(A)).toBe(false);
  });

  it('不干净 ⇒ 一句都不问', async () => {
    let asked = 0;
    await runBatchDelete({ io: disk.io(), entries: [f(A)], dirty: { dirtyOf: () => [], askDirty: () => (asked += 1, true) } });
    expect(asked).toBe(0);
    expect(disk.hasFile(A)).toBe(false);
  });
});

describe('回收站对不上号的那些 · 不许给假承诺', () => {
  it('宿主没有列回收站这条腿 ⇒ 全进 untracked、台账为空、回执改口', async () => {
    disk.noTrashRead = true;
    const out = await runBatchDelete({ io: disk.io(), entries: [f(A)] });
    expect(disk.hasFile(A)).toBe(false);
    expect(out.untracked.map((u) => u.name)).toEqual(['a.ERB']);
    expect(out.batch).toBeNull();
    expect(getLastDeleteBatch()).toBeNull();
    expect(out.resultText).toContain('这个环境没有读回收站的通道');
    expect(out.resultText).not.toContain('撤销这次删除');
  });

  it('回收站读得动但这一条没在里面 ⇒ 按"对不上号"处理（删除本身照算成功）', async () => {
    disk.listTrashThrows = true;
    const out = await runBatchDelete({ io: disk.io(), entries: [f(A)] });
    expect(disk.hasFile(A)).toBe(false);
    expect(out.untracked.map((u) => u.name)).toEqual(['a.ERB']);
    expect(out.resultText).toContain('撤销不包括它们');
    expect(out.resultText).not.toContain('这个环境没有读回收站的通道');
  });

  it('只有"相关的祖先条目"⇒ 不算对上号（执行层自己再收一次"就是这一条"）', async () => {
    await runBatchDelete({ io: disk.io(), entries: [d(PKG)] }); // 回收站里躺着一份祖先条目
    disk.seedFile(A, 'AAA'); // 原位又冒出同名的新内容
    disk.decoyAncestor = true;
    const out = await runBatchDelete({ io: disk.io(), entries: [f(A)] });
    expect(out.untracked.map((u) => u.name)).toEqual(['a.ERB']);
    expect(out.deleted).toHaveLength(0);
    expect(out.resultText).toContain('没能在回收站里对上号');
  });

  it('同种但不同路径的条目（被删目录里那枚子目录的旧条目）⇒ 不许当成这一条的凭据', async () => {
    // 回收站里先躺着「包A/子层」这份**目录**条目（种类与要删的目录相同，只是路径不对）
    disk.seedFile(`${PKG}/子层/s.ERB`, 'S');
    await runBatchDelete({ io: disk.io(), entries: [d(`${PKG}/子层`)] });
    const decoyId = disk.trashIdsFor(`${PKG}/子层`)[0]!;
    disk.decoyAncestor = true; // 只让"相关但不是这一条"的那份回得来
    const out = await runBatchDelete({ io: disk.io(), entries: [d(PKG)] });
    expect(out.untracked.map((u) => u.name)).toEqual(['包A']);
    expect(out.deleted).toHaveLength(0);
    // 拿子层条目当包A 的凭据 = 撤销会把子层放回、却谎称整目录回来了：这条判据必须在场
    expect(getLastDeleteBatch()).toBeNull();
    expect(out.deleted.map((r) => r.trashId)).not.toContain(decoyId);
  });

  it('种类不符（条目是目录、这次删的是文件）⇒ 不算对上号', async () => {
    disk.seedFile('C:/koa/003', 'X');
    const base = disk.io();
    const out = await runBatchDelete({
      io: {
        ...base,
        async listTrash(): Promise<readonly TrashEntry[]> {
          return [{ id: 'T9', originalPath: 'C:/koa/003', kind: 'dir', deletedAtMs: 0, expiresAtMs: 0, bytes: null, payloadPath: 'p' }];
        },
      },
      entries: [f('C:/koa/003')],
    });
    expect(out.untracked.map((u) => u.name)).toEqual(['003']);
    expect(out.deleted).toHaveLength(0);
  });

  it('同一路径删过两次 ⇒ 撤销认最近那一份（新在前）', async () => {
    await runBatchDelete({ io: disk.io(), entries: [f(A)] });
    const older = disk.trashIdsFor(A)[0]!;
    disk.seedFile(A, '又写了一份');
    const out = await runBatchDelete({ io: disk.io(), entries: [f(A)] });
    expect(out.deleted[0]!.trashId).not.toBe(older);
    expect(out.deleted[0]!.trashId).toBe(disk.trashIdsFor(A).at(-1));
  });
});

describe('撤销 · 回收站回到原路径', () => {
  it('删完再撤销 ⇒ 盘上回来且内容逐字一致，台账清空、回收站空掉', async () => {
    await runBatchDelete({ io: disk.io(), entries: [f(A), f(C)] });
    expect(disk.hasFile(A)).toBe(false);
    const out = await undoDeleteBatch({ io: disk.io(), batch: getLastDeleteBatch()! });
    expect(out.restored.map((r) => r.name)).toEqual(['a.ERB', 'c.csv']);
    expect(disk.read(A)).toBe('AAA');
    expect(disk.read(C)).toBe('CCC');
    expect(out.resultText).toContain('已放回 2 项');
    expect(getLastDeleteBatch()).toBeNull();
    expect(disk.trash).toHaveLength(0);
  });

  it('撤销一个目录 ⇒ 整棵子树回来（连"随它一起走"的那些）', async () => {
    await runBatchDelete({ io: disk.io(), entries: [d(PKG)] });
    expect(disk.hasFile(B)).toBe(false);
    const out = await undoDeleteBatch({ io: disk.io(), batch: getLastDeleteBatch()! });
    expect(out.restored.map((r) => r.name)).toEqual(['包A']);
    expect(disk.read(A)).toBe('AAA');
    expect(disk.read(B)).toBe('BBB');
    expect(disk.hasDir(PKG)).toBe(true);
  });

  it('原位被占住的那条 ⇒ 如实点名、留在台账里可以再试，其余照放回', async () => {
    await runBatchDelete({ io: disk.io(), entries: [f(A), f(C)] });
    disk.seedDir(C); // 有人在那个位置建了个同名文件夹：目录形占位 ⇒ 内核拒绝覆盖
    const out = await undoDeleteBatch({ io: disk.io(), batch: getLastDeleteBatch()! });
    expect(out.restored.map((r) => r.name)).toEqual(['a.ERB']);
    expect(out.failed.map((x) => x.name)).toEqual(['c.csv']);
    expect(out.failed[0]!.reason).toContain('原位置已存在');
    expect(out.remaining.map((r) => r.name)).toEqual(['c.csv']);
    expect(getLastDeleteBatch()?.records.map((r) => r.name)).toEqual(['c.csv']); // 没成的不许从台账里消失
    expect(out.resultText).toContain('还在回收站里');
    expect(disk.hasFile(C)).toBe(false);
    expect(disk.read(A)).toBe('AAA');
  });

  it('写允许域已收回（项目关了那一档）⇒ 说的是去哪批准，不是内部错误名', async () => {
    await runBatchDelete({ io: disk.io(), entries: [f(A)] });
    const batch = getLastDeleteBatch()!;
    disk.failRestore.set(batch.records[0]!.trashId, 'not-writable');
    const out = await undoDeleteBatch({ io: disk.io(), batch });
    expect(out.failed[0]!.reason).toContain('只读范围内');
    expect(out.failed[0]!.reason).not.toContain('WriteNotAllowedError');
    expect(out.restored).toHaveLength(0);
  });

  it('宿主没有"放回原位"这条腿 ⇒ 一条都不假装成功，回执说清缺的是哪条腿', async () => {
    await runBatchDelete({ io: disk.io(), entries: [f(A)] });
    disk.noRestore = true;
    const out = await undoDeleteBatch({ io: disk.io(), batch: getLastDeleteBatch()! });
    expect(out.restored).toHaveLength(0);
    expect(out.failed[0]!.reason).toContain('没有"从回收站放回原位"的通道');
    expect(disk.hasFile(A)).toBe(false);
  });

  it('原位站着的是一个文件 ⇒ 现状先进写前备份账再让位（不吃掉别人刚写的东西）', async () => {
    await runBatchDelete({ io: disk.io(), entries: [f(A)] });
    disk.seedFile(A, '别人新写的');
    const out = await undoDeleteBatch({ io: disk.io(), batch: getLastDeleteBatch()! });
    expect(disk.read(A)).toBe('AAA');
    expect(out.restored).toHaveLength(1);
    expect(disk.backups).toEqual([norm(A)]);
  });
});
