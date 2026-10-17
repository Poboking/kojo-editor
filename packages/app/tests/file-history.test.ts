import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackupVersion, FileIO, OpEntryView, OpJournal, OpRecord, TrashEntry } from '@kojo/plugin-api';
import {
  formatVersionSize,
  formatVersionTime,
  getFileHistoryTarget,
  setFileHistoryTarget,
  subscribeFileHistory,
  FILE_HISTORY_OVERLAY_ID,
  SHOW_FILE_HISTORY_COMMAND_ID,
  buildFileTimeline,
  buildGlobalTimeline,
  collectFileTimeline,
  collectGlobalTimeline,
  heldTrashIds,
  isTimelineStale,
  keepText,
  releaseTrashHold,
  scanOpsForPath,
  mergeTimeline,
  TRASH_HOLD_FILE_OWNER,
  TRASH_HOLD_OPS_OWNER,
  type FileTimelineInput,
  type OpFileSnapshot,
  type SnapshotEntry,
  type TimelineItem,
} from '../src/ui/file-history';
import { clearRecoveredContents, setRecoveredContents } from '../src/ui/recovery-store';

/**
 * 本地时间线（F2）宿主纯逻辑。
 * 版本数据源与恢复写链路在 kernel/tests/io-backups.test.ts 钉死；
 * 这里钉展示口径（时间优先取文件名时刻）与状态单源（命令 → overlay 的接力棒）。
 */

describe('formatVersionTime', () => {
  it('文件名时刻优先（mtime 会被复制/同步改写，文件名不会说谎）', () => {
    const text = formatVersionTime({ takenAtMs: new Date(2026, 9, 15, 9, 30, 1).getTime(), mtimeMs: 0 });
    expect(text).toBe('2026-10-15 09:30:01');
  });

  it('takenAtMs 为 null 回落 mtime（如实降级，不猜）', () => {
    const ms = new Date(2026, 0, 2, 3, 4, 5).getTime();
    expect(formatVersionTime({ takenAtMs: null, mtimeMs: ms })).toBe('2026-01-02 03:04:05');
  });
});

describe('formatVersionSize', () => {
  it('三档单位各钉一条边界', () => {
    expect(formatVersionSize(512)).toBe('512 B');
    expect(formatVersionSize(1024)).toBe('1.0 KB');
    expect(formatVersionSize(1536)).toBe('1.5 KB');
    expect(formatVersionSize(2.35 * 1024 * 1024)).toBe('2.35 MB');
  });
});

describe('历史目标状态单源', () => {
  afterEach(() => setFileHistoryTarget(null));

  it('命令写入活动文件 → 订阅者感知；关窗清空（下次开窗读不到旧文件）', () => {
    const cb = vi.fn();
    const un = subscribeFileHistory(cb);
    setFileHistoryTarget('C:/ws/包/事件.kojo');
    expect(getFileHistoryTarget()).toBe('C:/ws/包/事件.kojo');
    expect(cb).toHaveBeenCalledTimes(1);
    setFileHistoryTarget(null);
    expect(getFileHistoryTarget()).toBeNull();
    un();
    setFileHistoryTarget('C:/x');
    expect(cb).toHaveBeenCalledTimes(2);
    setFileHistoryTarget(null);
  });

  it('overlay/命令 id 是宿主接线的两处字面量之单一真源', () => {
    expect(FILE_HISTORY_OVERLAY_ID).toBe('kojo.fileHistory');
    expect(SHOW_FILE_HISTORY_COMMAND_ID).toBe('kojo.showFileHistory');
  });
});

/* ==================== W11：四本账并一条时间线 ==================== */

const T = new Date(2026, 9, 20, 10, 0, 0).getTime(); // 同一毫秒：四本账最容易撞车的形
const FILE = 'C:/ws/包/事件.kojo';

const bak = (id: string, atMs: number | null): BackupVersion => ({
  id,
  path: `C:/appdata/backup/桶/${id}`,
  takenAtMs: atMs,
  size: 10,
  mtimeMs: atMs ?? 0,
});

const trashItem = (
  id: string,
  originalPath: string,
  kind: 'dir' | 'file',
  deletedAtMs: number,
  expiresAtMs = deletedAtMs + 30 * 86_400_000,
): TrashEntry => ({
  id,
  originalPath,
  kind,
  deletedAtMs,
  expiresAtMs,
  bytes: 12,
  payloadPath: `C:/appdata/trash/${id}/payload`,
});

const opRow = (opId: string, startedAt: number, over: Partial<OpFileSnapshot> = {}): OpFileSnapshot => ({
  opId,
  kind: 'scaffold',
  label: '新建制品',
  startedAt,
  status: 'committed',
  fileCount: 1,
  hasBefore: true,
  ...over,
});

const snapRow = (
  account: 'autosave' | 'recovery',
  atMs: number | null,
  over: Partial<SnapshotEntry> = {},
): SnapshotEntry => ({
  account,
  path: FILE,
  atMs,
  filePath: account === 'autosave' ? `C:/appdata/autosave/snap-x.txt` : null,
  size: 3,
  ...over,
});

const baseInput = (over: Partial<FileTimelineInput> = {}): FileTimelineInput => ({
  path: FILE,
  existsOnDisk: true,
  writable: true,
  backups: [],
  trash: [],
  ops: [],
  snapshots: [],
  nowMs: T,
  ...over,
});

const keys = (items: readonly TimelineItem[]): string[] => items.map((i) => i.key);

describe('四本账合并 · 排序与去重', () => {
  it('同一路径同一时刻被四本账各记一次 ⇒ 一屏四行，序为 恢复件 > 回收站 > 批操作 > 写前备份', () => {
    const { items } = buildFileTimeline(
      baseInput({
        backups: [bak('20261020-100000-000.bak', T)],
        trash: [trashItem('20261020-100000-000-abcd1234', FILE, 'file', T)],
        ops: [opRow('op-1', T)],
        snapshots: [snapRow('autosave', T), snapRow('recovery', T)],
      }),
    );
    // autosave 与 recovery 是同一路径同一时刻的同一份东西（盘上那份是进程内那份的副本）⇒ 只留活的那份
    expect(keys(items)).toEqual(['recovery:C:/ws/包/事件.kojo', 'trash:20261020-100000-000-abcd1234', 'ops:op-1', 'backup:20261020-100000-000.bak']);
  });

  it('同账同 id 的重复条目只留一条（同一份 .bak 从两个写法不同的备份桶各冒一次头）', () => {
    const items = mergeTimeline([
      { ...mkItem('backup', 'a.bak', T), key: 'backup:a.bak' },
      { ...mkItem('backup', 'a.bak', T), key: 'backup:a.bak' },
      { ...mkItem('backup', 'b.bak', T), key: 'backup:b.bak' },
    ]);
    expect(keys(items)).toEqual(['backup:a.bak', 'backup:b.bak']);
  });

  it('同 key 但第一条时刻说不清 ⇒ 让位给给得出时刻的那条（降级项不占位，也不猜）', () => {
    const items = mergeTimeline([
      mkItem('backup', 'a.bak', null),
      mkItem('backup', 'a.bak', T),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.atMs).toBe(T);
  });

  it('时刻不明的行沉底；乱序入参得到同一份全序（合并是幂等的）', () => {
    const a = mkItem('backup', 'old.bak', T - 1000);
    const b = mkItem('trash', 'z', T + 1000);
    const c = mkItem('ops', 'op-9', null);
    const one = keys(mergeTimeline([a, b, c]));
    const two = keys(mergeTimeline([c, a, b]));
    expect(one).toEqual(two);
    expect(one[one.length - 1]).toBe('ops:op-9');
    expect(mergeTimeline(mergeTimeline([a, b, c]))).toEqual(mergeTimeline([a, b, c]));
  });
});

describe('四本账合并 · 跨账互斥说人话', () => {
  it('整目录被删 ⇒ 顶部说明 + 其他三本账的每一行都带上同一句"先放目录"', () => {
    const dir = trashItem('20261020-090000-000-aaaa1111', 'C:/ws/包', 'dir', T - 3600_000);
    const tl = buildFileTimeline(
      baseInput({
        existsOnDisk: false,
        trash: [dir],
        backups: [bak('x.bak', T - 7200_000)],
        ops: [opRow('op-1', T - 7200_000)],
        snapshots: [snapRow('autosave', T - 7200_000)],
      }),
    );
    expect(tl.notes.join('\n')).toMatch(/不在原位/);
    const others = tl.items.filter((i) => i.account !== 'trash');
    expect(others).toHaveLength(3);
    for (const item of others) expect(item.warnings.join('\n')).toMatch(/先把那个目录放回原位/);
  });

  it('编辑器里还有更新的未保存快照 ⇒ 写前备份那行必须提醒"保存会盖掉恢复结果"', () => {
    const { items } = buildFileTimeline(
      baseInput({ backups: [bak('x.bak', T - 5000)], snapshots: [snapRow('autosave', T)] }),
    );
    const backupRow = items.find((i) => i.account === 'backup')!;
    expect(backupRow.warnings.join('\n')).toMatch(/一次保存会把恢复结果盖掉/);
  });

  it('这一版之后还有批操作 ⇒ 提醒"用备份恢复不会撤销那一批的其他文件"，并给出批名', () => {
    const { items } = buildFileTimeline(
      baseInput({
        backups: [bak('x.bak', T - 5000)],
        ops: [opRow('op-1', T, { label: '注入存档变量', fileCount: 7 })],
      }),
    );
    const w = items.find((i) => i.account === 'backup')!.warnings.join('\n');
    expect(w).toMatch(/不会撤销那一批留下的其他文件/);
    expect(w).toMatch(/注入存档变量/);
    expect(items.find((i) => i.account === 'ops')!.warnings.join('\n')).toMatch(/共涉及 7 个文件/);
  });

  it('写允许域已收回 ⇒ 四本账一律只能看（action 全空）+ 顶部一句话说明', () => {
    const tl = buildFileTimeline(
      baseInput({
        writable: false,
        backups: [bak('x.bak', T)],
        trash: [trashItem('20261020-100000-000-abcd1234', FILE, 'file', T)],
        ops: [opRow('op-1', T)],
        snapshots: [snapRow('autosave', T)],
      }),
    );
    expect(tl.items).toHaveLength(4);
    for (const item of tl.items) expect(item.action).toBeNull();
    expect(tl.notes.join('\n')).toMatch(/不在写允许域内/);
  });

  it('批操作行自己也要说清"原位不在写允许域"是哪一条路径（逐条给落点）', () => {
    const { items } = buildFileTimeline(
      baseInput({ writable: false, trash: [trashItem('20261020-100000-000-abcd1234', 'C:/other/一处.kojo', 'file', T)] }),
    );
    expect(items[0]!.warnings.join('\n')).toMatch(/C:\/other\/一处\.kojo 此刻不在写允许域内/);
  });
});

describe('回收站条目在时间线里的呈现', () => {
  it('剩余保留天数按取数那一刻算（锚 = nowMs），过期条目如实标过期待清理', () => {
    const keep = buildFileTimeline(baseInput({ trash: [trashItem('20261020-100000-000-abcd1234', FILE, 'file', T)] }));
    expect(keep.items[0]!.keepDaysLeft).toBe(30);
    expect(keepText(keep.items[0]!)).toBe('剩 30 天');
    const expired = buildFileTimeline(
      baseInput({ trash: [trashItem('20261020-100000-000-abcd1234', FILE, 'file', T, T - 1000)] }),
    );
    expect(expired.items[0]!.keepDaysLeft).toBeLessThan(0);
    expect(keepText(expired.items[0]!)).toBe('已过保留期');
    expect(expired.items[0]!.warnings.join('\n')).toMatch(/下一次删除动作就可能顺手把它收走/);
  });

  it('锚过期判定：一天内不动、满一天就重取（不许在渲染里拿墙钟倒推改口径）', () => {
    expect(isTimelineStale(T, T + 86_400_000 - 1)).toBe(false);
    expect(isTimelineStale(T, T + 86_400_000)).toBe(true);
  });

  it('同一路径被删过两次 ⇒ 两条都在，且各自写明共几份、最新一份的时刻', () => {
    const { items } = buildFileTimeline(
      baseInput({
        trash: [
          trashItem('20261020-100000-000-abcd1234', FILE, 'file', T),
          trashItem('20261019-100000-000-abcd1234', 'C:\\ws\\包\\事件.kojo', 'file', T - 86_400_000),
        ],
      }),
    );
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.warnings.join('\n')).toMatch(/同一路径在回收站里有 2 份条目/);
  });

  it('整目录条目：说清"放回的是整棵子树，且不做覆盖"', () => {
    const { items } = buildFileTimeline(
      baseInput({ trash: [trashItem('20261020-100000-000-abcd1234', 'C:/ws/包', 'dir', T)] }),
    );
    expect(items[0]!.warnings.join('\n')).toMatch(/整棵子树/);
    expect(items[0]!.meaning).toMatch(/回收站不覆盖任何东西/);
  });
});

describe('批操作账的按文件挑取', () => {
  const rec = (id: string, startedAt: number, over: Partial<OpRecord> = {}): OpRecord => ({
    id,
    kind: 'scaffold',
    label: '新建制品',
    startedAt,
    finishedAt: startedAt,
    status: 'committed',
    fileCount: 1,
    ...over,
  });

  function fakeOps(records: OpRecord[], entries: Record<string, OpEntryView[]>): OpJournal {
    return {
      list: async () => records,
      entriesOf: async (id: string) => entries[id] ?? [],
    } as unknown as OpJournal;
  }

  it('路径按折叠尺匹配（大小写与分隔符写法都算同一份文件），并只留与本文件有关的那一批', async () => {
    const scan = await scanOpsForPath(
      fakeOps(
        [rec('op-1', T), rec('op-2', T - 1000)],
        {
          'op-1': [{ path: 'c:\\WS\\包\\事件.KOJO', hasBefore: true, encoding: 'utf-8-bom', eol: 'crlf' }],
          'op-2': [{ path: 'C:/ws/别的.kojo', hasBefore: false, encoding: 'utf-8', eol: 'lf' }],
        },
      ),
      FILE,
    );
    expect(scan.snapshots).toHaveLength(1);
    expect(scan.snapshots[0]!.opId).toBe('op-1');
    expect(scan.totalRecords).toBe(2);
  });

  it('只核对最近 N 批时如实报扫描范围（不装作扫全了）', async () => {
    const many = Array.from({ length: 5 }, (_, i) => rec(`op-${i}`, T - i * 1000));
    const scan = await scanOpsForPath(fakeOps(many, {}), FILE, 2);
    expect(scan.scanned).toBe(2);
    expect(scan.totalRecords).toBe(5);
  });

  it('某批清单读不动 ⇒ 该批跳过而不炸整条线', async () => {
    const ops = {
      list: async () => [rec('op-1', T), rec('op-2', T - 1)],
      entriesOf: async (id: string) => (id === 'op-1' ? Promise.reject(new Error('盘上没了')) : Promise.resolve([])),
    } as unknown as OpJournal;
    const scan = await scanOpsForPath(ops, FILE);
    expect(scan.snapshots).toEqual([]);
  });
});

describe('全局那一屏（批操作 + 回收站）', () => {
  it('两本账并一条线；整目录条目照样写明"动的是整棵子树"', () => {
    const records: OpRecord[] = [
      { id: 'op-1', kind: 'scaffold', label: '新建制品', startedAt: T - 1000, finishedAt: T - 1000, status: 'committed', fileCount: 1 },
    ];
    const trash = [trashItem('20261020-100000-000-abcd1234', 'C:/ws/包', 'dir', T)];
    const tl = buildGlobalTimeline(records, trash, { writableOf: () => true, nowMs: T });
    expect(keys(tl.items)).toEqual(['trash:20261020-100000-000-abcd1234', 'ops:op-1']);
    expect(tl.items[0]!.warnings.join('\n')).toMatch(/整棵子树/);
    expect(tl.notes.join('\n')).toMatch(/不会自己回来/);
  });

  it('落点不在写允许域的那条回收站条目：按钮不亮，理由逐条给到具体路径', () => {
    const tl = buildGlobalTimeline([], [trashItem('20261020-100000-000-abcd1234', 'C:/game/旧包', 'dir', T)], {
      writableOf: (p) => !p.startsWith('C:/game'),
      nowMs: T,
    });
    expect(tl.items[0]!.action).toBeNull();
    expect(tl.items[0]!.warnings.join('\n')).toMatch(/C:\/game\/旧包 此刻不在写允许域内/);
  });
});

describe('collectFileTimeline（假 io 直喂四本账）', () => {
  afterEach(() => clearRecoveredContents());

  function fakeIo(over: Partial<FileIO> = {}): FileIO {
    return {
      listBackups: async () => [],
      listTrash: async () => [],
      exists: async () => true,
      appDataDir: async () => 'C:/appdata',
      readText: async (p: string) => ({ path: p, text: '', encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: null }),
      stat: async () => null,
      isWritable: () => true,
      holdTrash: () => {},
      ...over,
    } as unknown as FileIO;
  }

  it('本屏引用的回收站条目 id 会登记给 holdTrash（正看着的不能被顺手清掉）', async () => {
    const hold = vi.fn();
    const io = fakeIo({
      listTrash: async () => [trashItem('20261020-100000-000-abcd1234', FILE, 'file', T)],
      holdTrash: hold,
    });
    const bundle = await collectFileTimeline(io, null, FILE, T);
    expect(hold).toHaveBeenCalledWith(['20261020-100000-000-abcd1234']);
    expect(bundle.trashIds).toEqual(['20261020-100000-000-abcd1234']);
  });

  it('批操作句柄不在位 ⇒ 出声（notes 里写明少了一本账），不静默', async () => {
    const bundle = await collectFileTimeline(fakeIo(), null, FILE, T);
    expect(bundle.opsAvailable).toBe(false);
    expect(bundle.notes.join('\n')).toMatch(/批操作账未接入/);
  });

  it('autosave 账 + 进程内恢复件同刻同路径 ⇒ 一屏只留活的那份（不摆两个"恢复"）', async () => {
    const manifest = {
      v: 1 as const,
      root: 'C:/ws',
      savedAt: T,
      entries: { [FILE]: { file: 'snap-x.txt', encoding: 'utf-8-bom', eol: 'crlf', savedAt: T } },
    };
    const io = fakeIo({
      readText: async (p: string) =>
        p.endsWith('manifest.json')
          ? { path: p, text: JSON.stringify(manifest), encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: null }
          : { path: p, text: '', encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: null },
    });
    const bundle = await collectFileTimeline(io, null, FILE, T);
    expect(keys(bundle.items)).toEqual(['autosave:C:/ws/包/事件.kojo']);

    setRecoveredContents([{ path: FILE, text: '脏的', encoding: 'utf-8-bom', eol: 'crlf', savedAt: T }]);
    const withRecovery = await collectFileTimeline(io, null, FILE, T);
    expect(keys(withRecovery.items)).toEqual(['recovery:C:/ws/包/事件.kojo']);
  });

  it('单本账读不动只降级那一本并出声（整屏不变成一条错误）', async () => {
    const io = fakeIo({
      listBackups: async () => {
        throw new Error('备份桶读不动');
      },
    });
    const bundle = await collectFileTimeline(io, null, FILE, T);
    expect(bundle.notes.join('\n')).toMatch(/写前备份读不到：备份桶读不动/);
  });
});

/* ==================== W11 接力：两屏同开时的引用保护 + 时刻不猜 ==================== */

describe('回收站引用登记 · 两把时间线同开不许互挤', () => {
  afterEach(() => {
    // 归属表是模块级单例：每条用例结束必须回到空表，否则上一条的残留会伪装成下一条的通过
    releaseTrashHold(null, TRASH_HOLD_FILE_OWNER);
    releaseTrashHold(null, TRASH_HOLD_OPS_OWNER);
    expect(heldTrashIds()).toEqual([]);
  });

  const FILE_ID = '20261020-100000-000-abcd1234'; // 文件那一屏引用的条目
  const ELSE_ID = '20261018-090000-000-ffff9999'; // 操作历史那一屏（全量账）独有的条目
  const sorted = [ELSE_ID, FILE_ID].sort();

  /** 两屏共用同一个内核 io 实例（App.tsx 就是把同一只 kernel.io 注册进中转站的） */
  function sharedIo(hold: (ids: readonly string[]) => void): FileIO {
    return {
      listBackups: async () => [],
      listTrash: async (opts?: { forPath?: string }) =>
        opts?.forPath === undefined
          ? [trashItem(ELSE_ID, 'C:/ws/别的包', 'dir', T), trashItem(FILE_ID, FILE, 'file', T)]
          : opts.forPath === FILE
            ? [trashItem(FILE_ID, FILE, 'file', T)]
            : [],
      exists: async () => true,
      appDataDir: async () => 'C:/appdata',
      readText: async (p: string) => ({ path: p, text: '', encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: null }),
      stat: async () => null,
      isWritable: () => true,
      holdTrash: hold,
    } as unknown as FileIO;
  }

  it('文件屏先取数、操作屏后取数 ⇒ 下发给内核的是两屏引用的**并集**（先那一屏的不能被挤掉）', async () => {
    const hold = vi.fn();
    const io = sharedIo(hold);
    const file = await collectFileTimeline(io, null, FILE, T);
    expect(file.trashIds).toEqual([FILE_ID]);
    expect(hold).toHaveBeenLastCalledWith([FILE_ID]);

    const global = await collectGlobalTimeline(io, null, T);
    expect(global.trashIds).toEqual(sorted);
    // 回归点：内核 holdTrash 是整替语义，各屏直接整替会让 FILE_ID 在文件屏仍开着时失去保护
    expect(hold).toHaveBeenLastCalledWith(sorted);
    expect(heldTrashIds()).toEqual(sorted);
  });

  it('操作屏先取数、文件屏后取数（它只引用一条）⇒ 仍是并集：文件屏的整替不许把 ELSE_ID 抹掉', async () => {
    const hold = vi.fn();
    const io = sharedIo(hold);
    await collectGlobalTimeline(io, null, T);
    expect(hold).toHaveBeenLastCalledWith(sorted);
    // 用户在这一屏点了「刷新」：文件屏只认得本文件那一条，旧写法会把另一屏的引用整替没了
    await collectFileTimeline(io, null, FILE, T);
    expect(hold).toHaveBeenLastCalledWith(sorted);
    expect(heldTrashIds()).toEqual(sorted);
  });

  it('某一屏退场只撤**自己那一份**：另一屏正看着的条目继续挡清扫；两屏都退才下发空清单', async () => {
    const hold = vi.fn();
    const io = sharedIo(hold);
    await collectFileTimeline(io, null, FILE, T);
    await collectGlobalTimeline(io, null, T);
    expect(hold).toHaveBeenLastCalledWith(sorted);

    // 全局那一屏的清单是超集，它退场后本文件那一条仍受保护——文件屏还开着呢
    releaseTrashHold(io, TRASH_HOLD_OPS_OWNER);
    expect(hold).toHaveBeenLastCalledWith([FILE_ID]);
    expect(heldTrashIds()).toEqual([FILE_ID]);

    releaseTrashHold(io, TRASH_HOLD_FILE_OWNER);
    expect(hold).toHaveBeenLastCalledWith([]); // 不许留成"永久豁免"
    expect(heldTrashIds()).toEqual([]);
  });

  it('文件屏换到一个没有回收站条目的文件 ⇒ 自己那份变空，但不许把另一屏的引用一并挤掉', async () => {
    const hold = vi.fn();
    const io = sharedIo(hold);
    await collectGlobalTimeline(io, null, T);
    await collectFileTimeline(io, null, 'C:/ws/无回收站条目的文件.kojo', T);
    expect(hold).toHaveBeenLastCalledWith(sorted);
    expect(heldTrashIds()).toEqual(sorted);
  });
});

describe('时刻说不清就不摆假时刻（判据不猜）', () => {
  afterEach(() => clearRecoveredContents());

  function ioWithAutosaveDir(): FileIO {
    return {
      listBackups: async () => [],
      listTrash: async () => [],
      exists: async () => true,
      appDataDir: async () => 'C:/appdata',
      readText: async (p: string) => ({ path: p, text: '', encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: null }),
      stat: async () => null,
      isWritable: () => true,
      holdTrash: () => {},
    } as unknown as FileIO;
  }

  it('崩溃恢复件没带时刻 ⇒ 该行 atMs 为 null（不显示 1970），也不去抢"谁更新"的判定', async () => {
    setRecoveredContents([{ path: FILE, text: '脏的', encoding: 'utf-8-bom', eol: 'crlf' }]);
    const bundle = await collectFileTimeline(ioWithAutosaveDir(), null, FILE, T);
    const recovery = bundle.items.find((i) => i.account === 'recovery')!;
    expect(recovery.atMs).toBeNull();

    // 这一屏只有恢复通道那一条（盘上 autosave 账是空的），且它带着"时刻不明"而不是 1970
    expect(keys(bundle.items)).toEqual(['recovery:C:/ws/包/事件.kojo']);
  });

  it('无时刻的恢复件与写前备份并存 ⇒ 备份行不带"保存会盖掉恢复结果"（拿不出时刻就证不出谁新）', () => {
    const { items } = buildFileTimeline(
      baseInput({
        backups: [bak('x.bak', T - 5000)],
        snapshots: [snapRow('recovery', null, { filePath: null })],
      }),
    );
    const backupRow = items.find((i) => i.account === 'backup')!;
    expect(backupRow.warnings.join('\n')).not.toMatch(/一次保存会把恢复结果盖掉/);
    expect(items.find((i) => i.account === 'recovery')!.atMs).toBeNull();
    // 无时刻那行沉底（排序口径与"null 沉底"同源）
    expect(items[items.length - 1]!.account).toBe('recovery');
  });
});

/* ---------------- 造行小工具（跨账测试只要形状对，不必走 builder 的文案） ---------------- */

function mkItem(account: TimelineItem['account'], id: string, atMs: number | null): TimelineItem {
  return {
    key: `${account}:${id}`,
    account,
    id,
    atMs,
    title: id,
    meaning: '',
    size: null,
    diffPath: null,
    action: null,
    warnings: [],
    keepDaysLeft: null,
    savedAtMs: T,
  };
}
