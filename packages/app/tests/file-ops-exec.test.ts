import { beforeEach, describe, expect, it } from 'vitest';
import { buildFileOpsPlan, type FileOpEntry, type FileOpsPlan } from '../src/ui/file-ops-plan';
import { runFileOps, type FileOpsIo } from '../src/ui/file-ops-exec';

/**
 * WS-13 2a 车 · 文件操作**执行层**判据（计划层 + 一块假盘）。
 *
 * 假盘照 `file-tree-create.test.ts` 的先例做成**最小端口**：`createFileExclusive` /
 * `createDirExclusive` 的返回值就是 OS 独占创建的语义（同名 ⇒ false、一个字节都不动），
 * `rename` 撞上已存在的目标照 Windows 那样失败 ⇒「覆盖得先腾位置」这条纪律是被假盘
 * 逼出来的，不是注释里说说的。
 *
 * 每组都留一份"盘上现在到底是什么"的读数 ⇒ 摘掉任何一条纪律都会红在磁盘状态上，
 * 而不是红在一句被顺手改掉的断言上。
 */

const norm = (p: string): string => p.replace(/[\\/]+/g, '/').toLowerCase();
const parentOf = (p: string): string => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));
const lastSeg = (p: string): string => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);

class FakeFs {
  /** 文件：归一路径 → 内容 */
  readonly files = new Map<string, string>();
  /** 目录：归一路径 */
  readonly dirs = new Set<string>();
  /** 归一路径 → 原样写法（walkDir 上屏要的是原样，不是小写） */
  readonly display = new Map<string, string>();
  /** 回收站（removeFile 的去向） */
  readonly trash = new Map<string, string>();
  /** 本地历史（backup 的去向） */
  readonly history = new Map<string, string>();
  /** 调用流水（断言"一次都没碰盘"用） */
  readonly calls: string[] = [];
  /** 这些名字的独占创建一律失败（TOCTOU 模拟用） */
  readonly claimBlocked = new Set<string>();
  /** 下一次 copyFile 抛错（半成品清理判据用） */
  failCopyOnce = false;
  /** 下一次 walkDir 抛错 */
  failWalkOnce = false;

  seedFile(path: string, content: string): void {
    this.files.set(norm(path), content);
    this.display.set(norm(path), path);
  }

  seedDir(path: string): void {
    this.dirs.add(norm(path));
    this.display.set(norm(path), path);
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

  io(withBackup = true): FileOpsIo {
    const fs = this;
    const remember = (p: string): void => {
      if (!fs.display.has(norm(p))) fs.display.set(norm(p), p);
    };
    const io: FileOpsIo = {
      async createFileExclusive(path) {
        fs.calls.push(`createFileExclusive:${norm(path)}`);
        if (fs.claimBlocked.has(norm(path))) return false;
        if (fs.files.has(norm(path)) || fs.dirs.has(norm(path))) return false;
        fs.files.set(norm(path), '');
        remember(path);
        return true;
      },
      async createDirExclusive(path) {
        fs.calls.push(`createDirExclusive:${norm(path)}`);
        if (fs.dirs.has(norm(path)) || fs.files.has(norm(path))) return false;
        fs.dirs.add(norm(path));
        remember(path);
        return true;
      },
      async copyFile(from, to) {
        fs.calls.push(`copyFile:${norm(from)}→${norm(to)}`);
        if (fs.failCopyOnce) {
          fs.failCopyOnce = false;
          throw new Error('盘上写不下');
        }
        const src = fs.files.get(norm(from));
        if (src === undefined) throw new Error(`源不在了 ${from}`);
        // 与 Rust copy_file 同口径：顺手把父目录建出来
        fs.dirs.add(norm(parentOf(to)));
        fs.files.set(norm(to), src);
        remember(to);
      },
      async rename(from, to) {
        fs.calls.push(`rename:${norm(from)}→${norm(to)}`);
        if (fs.files.has(norm(to)) || fs.dirs.has(norm(to))) throw new Error('目标已存在（Windows 的 rename 不覆盖）');
        const f = norm(from);
        const t = norm(to);
        if (fs.files.has(f)) {
          const content = fs.files.get(f)!;
          fs.files.delete(f);
          fs.files.set(t, content);
          fs.display.set(t, to);
          return;
        }
        if (fs.dirs.has(f)) {
          fs.dirs.delete(f);
          fs.dirs.add(t);
          fs.display.set(t, to);
          const movedFiles: Array<[string, string]> = [];
          for (const [k, v] of fs.files) {
            if (k.startsWith(`${f}/`)) movedFiles.push([k, v]);
          }
          for (const [k, v] of movedFiles) {
            const nk = `${t}/${k.slice(f.length + 1)}`;
            fs.files.delete(k);
            fs.files.set(nk, v);
            const dk = fs.display.get(k) ?? k;
            fs.display.set(nk, `${to}${dk.slice(f.length).replace(/[\\/]/, '/')}`);
          }
          const movedDirs = [...fs.dirs].filter((x) => x.startsWith(`${f}/`));
          for (const k of movedDirs) {
            fs.dirs.delete(k);
            const nk = `${t}/${k.slice(f.length + 1)}`;
            fs.dirs.add(nk);
            const dk = fs.display.get(k) ?? k;
            fs.display.set(nk, `${to}${dk.slice(f.length).replace(/[\\/]/, '/')}`);
          }
          return;
        }
        throw new Error(`没有这个东西 ${from}`);
      },
      async removeFile(path) {
        fs.calls.push(`removeFile:${norm(path)}`);
        const content = fs.files.get(norm(path));
        if (content === undefined) throw new Error(`文件不在 ${path}`);
        fs.files.delete(norm(path));
        fs.trash.set(norm(path), content);
      },
      async walkDir(path) {
        fs.calls.push(`walkDir:${norm(path)}`);
        if (fs.failWalkOnce) {
          fs.failWalkOnce = false;
          throw new Error('读不了这个文件夹');
        }
        const root = norm(path);
        const out: Array<{ name: string; path: string; isDirectory: boolean }> = [];
        for (const k of fs.files.keys()) {
          if (k.startsWith(`${root}/`)) {
            const shown = fs.display.get(k) ?? k;
            out.push({ name: lastSeg(shown), path: shown, isDirectory: false });
          }
        }
        for (const dirKey of fs.dirs) {
          if (dirKey.startsWith(`${root}/`)) {
            const shown = fs.display.get(dirKey) ?? dirKey;
            out.push({ name: lastSeg(shown), path: shown, isDirectory: true });
          }
        }
        return out;
      },
    };
    if (withBackup) {
      io.backup = async (path: string): Promise<string | null> => {
        fs.calls.push(`backup:${norm(path)}`);
        const content = fs.files.get(norm(path));
        if (content === undefined) return null;
        fs.history.set(norm(path), content);
        return `H:${norm(path)}`;
      };
    }
    return io;
  }
}

const W = 'C:/work';
const SRC = `${W}/s`;
const DST = `${W}/t`;

const f = (path: string): FileOpEntry => ({ path, isDir: false });
const d = (path: string): FileOpEntry => ({ path, isDir: true });

function planOf(args: {
  sources: readonly FileOpEntry[];
  targetEntries: readonly FileOpEntry[];
  mode?: 'copy' | 'move';
  intent?: 'paste' | 'duplicate';
  targetDir?: string;
}): FileOpsPlan {
  return buildFileOpsPlan({
    sources: args.sources,
    targetDir: args.targetDir ?? DST,
    targetEntries: args.targetEntries,
    mode: args.mode ?? 'copy',
    ...(args.intent === undefined ? {} : { intent: args.intent }),
    roots: [W],
  });
}

let fs: FakeFs;

beforeEach(() => {
  fs = new FakeFs();
  fs.seedDir(SRC);
  fs.seedDir(DST);
});

/* ------------------------------ 复制 ------------------------------ */

describe('执行层 · 复制', () => {
  it('无撞名的复制：字节落到目标目录、源一个字节都没动', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [] }),
      decision: 'keepBoth',
      targetWritable: true,
    });
    expect(r.done).toBe(1);
    expect(r.created).toEqual([`${DST}/a.ERB`]);
    expect(fs.read(`${DST}/a.ERB`)).toBe('A');
    expect(fs.read(`${SRC}/a.ERB`)).toBe('A');
    expect(r.resultText).toContain('已把 1 项复制到「t」');
  });

  it('两份一起复制 = done 2，回执说数量而不是逐条铺满', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    fs.seedFile(`${SRC}/b.ERB`, 'B');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`), f(`${SRC}/b.ERB`)], targetEntries: [] }),
      decision: 'skip',
      targetWritable: true,
    });
    expect(r.done).toBe(2);
    expect(fs.read(`${DST}/b.ERB`)).toBe('B');
  });

  it('撞名 + 决定=跳过 ⇒ 一份都不落，skipped 点名', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    fs.seedFile(`${DST}/a.ERB`, '旧');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [f(`${DST}/a.ERB`)] }),
      decision: 'skip',
      targetWritable: true,
    });
    expect(r.done).toBe(0);
    expect(r.skipped).toEqual(['a.ERB']);
    expect(fs.read(`${DST}/a.ERB`)).toBe('旧');
  });

  it('撞名 + 决定=保留两者 ⇒ 落成新名字，旧的与源都在', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    fs.seedFile(`${DST}/a.ERB`, '旧');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [f(`${DST}/a.ERB`)] }),
      decision: 'keepBoth',
      targetWritable: true,
    });
    expect(r.done).toBe(1);
    expect(fs.read(`${DST}/a 2.ERB`)).toBe('A');
    expect(fs.read(`${DST}/a.ERB`)).toBe('旧');
    expect(fs.read(`${SRC}/a.ERB`)).toBe('A');
  });

  it('撞名 + 决定=覆盖 ⇒ 先写进本地历史再盖（原内容找得回，回执要说清退路）', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    fs.seedFile(`${DST}/a.ERB`, '旧');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [f(`${DST}/a.ERB`)] }),
      decision: 'overwrite',
      targetWritable: true,
    });
    expect(r.done).toBe(1);
    expect(fs.history.get(norm(`${DST}/a.ERB`))).toBe('旧');
    expect(fs.read(`${DST}/a.ERB`)).toBe('A');
    expect(r.overwritten).toEqual([`${DST}/a.ERB`]);
    expect(r.resultText).toContain('文件历史');
  });

  it('没有 backup 这条腿 ⇒ 覆盖如实失败，**不动原文件**（不静默吃掉现状）', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    fs.seedFile(`${DST}/a.ERB`, '旧');
    const r = await runFileOps({
      io: fs.io(false),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [f(`${DST}/a.ERB`)] }),
      decision: 'overwrite',
      targetWritable: true,
    });
    expect(r.done).toBe(0);
    expect(r.failed[0]?.reason).toContain('本地历史');
    expect(fs.read(`${DST}/a.ERB`)).toBe('旧');
    expect(fs.calls.some((c) => c.startsWith('copyFile:'))).toBe(false);
  });

  it('竞态（计划说 ready、落地时名字已被占）⇒ 顺着改名序列找空位，绝不覆盖', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    fs.seedFile(`${DST}/a.ERB`, '别人刚放的');
    const r = await runFileOps({
      io: fs.io(),
      // targetEntries 故意给空：计划层判 ready，独占创建才发现名字已被占
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [] }),
      decision: 'skip',
      targetWritable: true,
    });
    expect(r.done).toBe(1);
    expect(fs.read(`${DST}/a.ERB`)).toBe('别人刚放的');
    expect(fs.read(`${DST}/a 2.ERB`)).toBe('A');
  });

  it('改名序列也占满 ⇒ 点名失败，不落任何半成品', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    fs.claimBlocked.add(norm(`${DST}/a.ERB`));
    for (let n = 2; n <= 99; n++) fs.claimBlocked.add(norm(`${DST}/a ${n}.ERB`));
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [] }),
      decision: 'keepBoth',
      targetWritable: true,
    });
    expect(r.done).toBe(0);
    expect(r.failed[0]?.reason).toContain('都占着');
    expect(fs.hasFile(`${DST}/a 2.ERB`)).toBe(false);
  });

  it('抢到名字但灌字节失败 ⇒ 清掉那格空文件（不留假副本），失败点名带原因', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    fs.failCopyOnce = true;
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [] }),
      decision: 'keepBoth',
      targetWritable: true,
    });
    expect(r.done).toBe(0);
    expect(r.failed[0]?.reason).toContain('盘上写不下');
    expect(fs.hasFile(`${DST}/a.ERB`)).toBe(false);
    expect(fs.calls.filter((c) => c.startsWith('removeFile:'))).toEqual([`removeFile:${norm(`${DST}/a.ERB`)}`]);
  });
});

/* ------------------------------ 复制文件夹 ------------------------------ */

describe('执行层 · 复制文件夹', () => {
  it('整棵子树按同一条算式落到目标目录（嵌套目录与文件都在）', async () => {
    fs.seedDir(`${SRC}/sub/deep`);
    fs.seedFile(`${SRC}/sub/a.ERB`, 'A');
    fs.seedFile(`${SRC}/sub/deep/b.ERB`, 'B');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [d(`${SRC}/sub`)], targetEntries: [] }),
      decision: 'keepBoth',
      targetWritable: true,
    });
    expect(r.done).toBe(1); // 目录算一项，与作者眼里"搬了一个东西"对齐
    expect(fs.read(`${DST}/sub/a.ERB`)).toBe('A');
    expect(fs.read(`${DST}/sub/deep/b.ERB`)).toBe('B');
    expect(fs.hasDir(`${DST}/sub/deep`)).toBe(true);
    expect(fs.read(`${SRC}/sub/a.ERB`)).toBe('A'); // 复制 ⇒ 源留在原地
    expect(r.resultText).toContain('已把 1 项复制到「t」');
  });

  it('撞名 + 决定=保留两者 ⇒ 整棵树落到改名后的根里', async () => {
    fs.seedFile(`${SRC}/sub/a.ERB`, 'A');
    fs.seedDir(`${DST}/sub`);
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [d(`${SRC}/sub`)], targetEntries: [d(`${DST}/sub`)] }),
      decision: 'keepBoth',
      targetWritable: true,
    });
    expect(r.done).toBe(1);
    expect(fs.read(`${DST}/sub 2/a.ERB`)).toBe('A');
  });

  it('撞名 + 决定=覆盖 ⇒ 目录不给覆盖：进 refused 并点名，一个字节都不动', async () => {
    fs.seedFile(`${SRC}/sub/a.ERB`, 'A');
    fs.seedDir(`${DST}/sub`);
    fs.seedFile(`${DST}/sub/别人的.ERB`, '别人的');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [d(`${SRC}/sub`)], targetEntries: [d(`${DST}/sub`)] }),
      decision: 'overwrite',
      targetWritable: true,
    });
    expect(r.done).toBe(0);
    expect(r.failed[0]?.reason).toContain('文件夹不做整目录覆盖');
    expect(fs.read(`${DST}/sub/别人的.ERB`)).toBe('别人的');
    expect(fs.hasFile(`${DST}/sub 2/a.ERB`)).toBe(false);
    expect(fs.calls.filter((c) => c.startsWith('copyFile:'))).toEqual([]);
  });

  it('读不出子树 ⇒ 根建出来也要如实报"读不出内容"，不报成功', async () => {
    fs.seedFile(`${SRC}/sub/a.ERB`, 'A');
    fs.failWalkOnce = true;
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [d(`${SRC}/sub`)], targetEntries: [] }),
      decision: 'keepBoth',
      targetWritable: true,
    });
    expect(r.done).toBe(0);
    expect(r.failed[0]?.reason).toContain('读不出这个文件夹的内容');
  });

  it('子树里某一份没写成 ⇒ 整项报失败并点名那份文件（铁律 4：部分成功也要说）', async () => {
    fs.seedFile(`${SRC}/sub/a.ERB`, 'A');
    fs.seedFile(`${SRC}/sub/b.ERB`, 'B');
    fs.failCopyOnce = true; // walkDir 顺序里的第一份 copyFile 抛
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [d(`${SRC}/sub`)], targetEntries: [] }),
      decision: 'keepBoth',
      targetWritable: true,
    });
    expect(r.done).toBe(0);
    expect(r.failed[0]?.reason).toContain('项没成');
  });
});

/* ------------------------------ 剪切（移动） ------------------------------ */

describe('执行层 · 剪切 = 一次原子搬运', () => {
  it('无撞名：走 rename，源消失、落点在、moved 成对报告', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [], mode: 'move' }),
      decision: 'keepBoth',
      targetWritable: true,
    });
    expect(r.done).toBe(1);
    expect(r.moved).toEqual([{ from: `${SRC}/a.ERB`, to: `${DST}/a.ERB` }]);
    expect(fs.hasFile(`${SRC}/a.ERB`)).toBe(false);
    expect(fs.read(`${DST}/a.ERB`)).toBe('A');
    expect(r.resultText).toContain('已把 1 项移到「t」');
  });

  it('撞名 + 覆盖 ⇒ 先把被盖的那份送进回收站再 rename（Windows 的 rename 不覆盖）', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    fs.seedFile(`${DST}/a.ERB`, '旧');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [f(`${DST}/a.ERB`)], mode: 'move' }),
      decision: 'overwrite',
      targetWritable: true,
    });
    expect(r.done).toBe(1);
    expect(fs.trash.get(norm(`${DST}/a.ERB`))).toBe('旧');
    expect(fs.read(`${DST}/a.ERB`)).toBe('A');
    expect(fs.hasFile(`${SRC}/a.ERB`)).toBe(false);
  });

  it('被盖的那份进不了回收站 ⇒ 停止这一项，源与落点都原样', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    // 盘上没有 ${DST}/a.ERB（计划层按传入清单以为有）⇒ removeFile 必抛
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [f(`${DST}/a.ERB`)], mode: 'move' }),
      decision: 'overwrite',
      targetWritable: true,
    });
    expect(r.done).toBe(0);
    expect(r.failed[0]?.reason).toContain('没能移进回收站');
    expect(fs.hasFile(`${SRC}/a.ERB`)).toBe(true);
    expect(fs.calls.filter((c) => c.startsWith('rename:'))).toEqual([]);
  });

  it('文件夹整体搬走 = 一次 rename（子树跟着走，不逐条复制再删）', async () => {
    fs.seedDir(`${SRC}/sub`);
    fs.seedDir(`${SRC}/sub/deep`);
    fs.seedFile(`${SRC}/sub/a.ERB`, 'A');
    fs.seedFile(`${SRC}/sub/deep/b.ERB`, 'B');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [d(`${SRC}/sub`)], targetEntries: [], mode: 'move' }),
      decision: 'keepBoth',
      targetWritable: true,
    });
    expect(r.done).toBe(1);
    expect(fs.read(`${DST}/sub/a.ERB`)).toBe('A');
    expect(fs.read(`${DST}/sub/deep/b.ERB`)).toBe('B');
    expect(fs.hasDir(`${SRC}/sub`)).toBe(false);
    expect(fs.calls.filter((c) => c.startsWith('copyFile:'))).toEqual([]);
  });

  it('rename 自己失败 ⇒ 点名失败（不把"搬不动"折叠成"已跳过"）', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    fs.seedFile(`${DST}/a.ERB`, '旧');
    fs.seedFile(`${DST}/a 2.ERB`, '占了');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [f(`${DST}/a.ERB`)], mode: 'move' }),
      decision: 'keepBoth',
      targetWritable: true,
    });
    expect(r.done).toBe(0);
    expect(fs.hasFile(`${SRC}/a.ERB`)).toBe(true);
    expect(r.failed[0]?.name).toBe('a 2.ERB');
  });
});

/* ------------------------------ 三道闸 ------------------------------ */

describe('执行层 · 三道闸', () => {
  it('落点不可写 ⇒ **一次 IO 都不发**，逐条点名给同一句人话', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    fs.seedFile(`${SRC}/b.ERB`, 'B');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`), f(`${SRC}/b.ERB`)], targetEntries: [] }),
      decision: 'keepBoth',
      targetWritable: false,
    });
    expect(fs.calls).toEqual([]);
    expect(r.done).toBe(0);
    expect(r.failed.map((x) => x.name)).toEqual(['a.ERB', 'b.ERB']);
    expect(r.failed[0]?.reason).toContain('只读范围内');
  });

  it('决定=全部取消 ⇒ aborted 且零 IO', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    fs.seedFile(`${DST}/a.ERB`, '旧');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [f(`${DST}/a.ERB`)] }),
      decision: 'cancel',
      targetWritable: true,
    });
    expect(r.aborted).toBe(true);
    expect(fs.calls).toEqual([]);
    expect(r.resultText).toContain('已全部取消');
  });

  it('脏闸（剪切源有未保存改动）⇒ 问一次；答"不"就整批作废、零 IO', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    const asked: Array<{ kind: string; names: readonly string[] }> = [];
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [], mode: 'move' }),
      decision: 'keepBoth',
      targetWritable: true,
      dirty: {
        dirtyOf: (paths) => paths.filter((p) => p === `${SRC}/a.ERB`).map(() => 'a.ERB'),
        askDirty: (kind, names) => {
          asked.push({ kind, names });
          return false;
        },
      },
    });
    expect(asked).toEqual([{ kind: 'move', names: ['a.ERB'] }]);
    expect(r.aborted).toBe(true);
    expect(fs.calls).toEqual([]);
    expect(r.resultText).toContain('未保存的修改');
  });

  it('脏闸答"继续" ⇒ 照常落地（是用户选的，不是我们替他选的）', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [], mode: 'move' }),
      decision: 'keepBoth',
      targetWritable: true,
      dirty: { dirtyOf: () => ['a.ERB'], askDirty: () => true },
    });
    expect(r.done).toBe(1);
    expect(fs.read(`${DST}/a.ERB`)).toBe('A');
  });

  it('脏闸问的是**落点**：覆盖一份编辑器里没存的目标 ⇒ kind=overwrite、问的是目标路径', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    fs.seedFile(`${DST}/a.ERB`, '旧');
    const asked: string[] = [];
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [f(`${DST}/a.ERB`)] }),
      decision: 'overwrite',
      targetWritable: true,
      dirty: {
        dirtyOf: (paths) => {
          asked.push(...paths);
          return paths.includes(`${DST}/a.ERB`) ? ['a.ERB'] : [];
        },
        askDirty: (kind) => kind === 'overwrite',
      },
    });
    expect(asked).toContain(`${DST}/a.ERB`);
    expect(r.done).toBe(1);
  });

  it('没有脏闸回调（旧消费方）⇒ 照旧落地，本层不自造"脏"的定义', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [] }),
      decision: 'keepBoth',
      targetWritable: true,
    });
    expect(r.done).toBe(1);
  });

  it('failedSources：全成了 ⇒ 空；部分没成 ⇒ 只列仍在原地的那些（宿主据此决定剪贴板留不留）', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`), f(`${SRC}/没了.ERB`)], targetEntries: [], mode: 'move' }),
      decision: 'keepBoth',
      targetWritable: true,
    });
    expect(r.done).toBe(1);
    expect(r.failedSources).toEqual([`${SRC}/没了.ERB`]);
    expect(fs.hasFile(`${SRC}/a.ERB`)).toBe(false);
    expect(fs.hasFile(`${DST}/a.ERB`)).toBe(true);
  });

  it('脏闸答"不"时 failedSources = 全部源（一项都没落地，剪贴板该整份留着）', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [], mode: 'move' }),
      decision: 'keepBoth',
      targetWritable: true,
      dirty: { dirtyOf: () => ['a.ERB'], askDirty: () => false },
    });
    expect(r.failedSources).toEqual([`${SRC}/a.ERB`]);
  });

  it('askDirty 允许回 Promise（宿主拿真对话框异步问；落盘等这一答，答"不"一个字节不动）', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    let asked = 0;
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [], mode: 'move' }),
      decision: 'keepBoth',
      targetWritable: true,
      dirty: {
        dirtyOf: () => ['a.ERB'],
        askDirty: async (kind) => {
          asked += 1;
          expect(kind).toBe('move');
          await Promise.resolve(); // 模拟"等作者点按钮"的那一拍
          return false;
        },
      },
    });
    expect(asked).toBe(1);
    expect(r.aborted).toBe(true);
    expect(fs.hasFile(`${SRC}/a.ERB`)).toBe(true);
    expect(fs.hasFile(`${DST}/a.ERB`)).toBe(false);
  });

  it('askDirty 的 Promise 答"继续" ⇒ 照常落地（布尔旧写法与新写法共用同一条 await 腿）', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [f(`${SRC}/a.ERB`)], targetEntries: [], mode: 'move' }),
      decision: 'keepBoth',
      targetWritable: true,
      dirty: { dirtyOf: () => ['a.ERB'], askDirty: async () => true },
    });
    expect(r.done).toBe(1);
    expect(fs.hasFile(`${DST}/a.ERB`)).toBe(true);
  });

  it('计划层的非法源 ⇒ 任何决定下都在回执里点名（选了"跳过"也不许它消失）', async () => {
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [d(SRC)], targetEntries: [], targetDir: `${SRC}/sub` }),
      decision: 'skip',
      targetWritable: true,
    });
    expect(r.aborted).toBe(false);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]?.reason).toContain('它自己的子目录');
  });
});

/* ------------------------------ 回执 ------------------------------ */

describe('执行层 · 回执把每种下场都说清', () => {
  it('一次粘贴三种下场：成功计数 + 跳过点名 + 失败点名（含非法源）', async () => {
    fs.seedDir(`${SRC}/sub`);
    fs.seedFile(`${SRC}/a.ERB`, 'A');
    fs.seedFile(`${SRC}/b.ERB`, 'B');
    // c.ERB 故意不种进假盘：计划里它是源，落地那一刻读不到字节（"源没了"的现场）
    fs.seedFile(`${SRC}/sub/b.ERB`, '旧的');
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({
        sources: [f(`${SRC}/a.ERB`), f(`${SRC}/b.ERB`), f(`${SRC}/c.ERB`), d(SRC)],
        targetEntries: [f(`${SRC}/sub/b.ERB`)],
        targetDir: `${SRC}/sub`,
      }),
      decision: 'skip',
      targetWritable: true,
    });
    expect(r.done).toBe(1);
    expect(fs.read(`${SRC}/sub/a.ERB`)).toBe('A');
    expect(r.skipped).toEqual(['b.ERB']);
    expect(r.failed.map((x) => x.name)).toEqual(['s', 'c.ERB']);
    expect(r.failed[1]?.reason).toContain('源不在了'); // 落地那一刻读不到源（假盘里没这一格的字节可搬）
    expect(r.resultText).toContain('已把 1 项复制到「sub」');
    expect(r.resultText).toContain('跳过 1 项（b.ERB）');
  });

  it('源集合为空 ⇒ 一句"0 项"，不发任何 IO', async () => {
    const r = await runFileOps({
      io: fs.io(),
      plan: planOf({ sources: [], targetEntries: [] }),
      decision: 'skip',
      targetWritable: true,
    });
    expect(r.done).toBe(0);
    expect(fs.calls).toEqual([]);
    expect(r.resultText).toContain('已把 0 项复制到「t」');
  });
});
