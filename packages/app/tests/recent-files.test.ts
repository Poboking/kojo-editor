import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionKv } from '../src/ui/session-store';
import {
  RECENT_FILES_KEY,
  RECENT_FILES_LIMIT,
  loadRecentFiles,
  removeRecentFiles,
  renameRecentFiles,
  sameRecentFiles,
  sanitizeRecentFiles,
  saveRecentFiles,
  upsertRecentFile,
  type RecentFileRecord,
} from '../src/ui/recent-files';

/**
 * 最近文件列表持久层的判据（MM-7 编辑器肌肉记忆批）。
 *
 * KV 替身模拟真实 FileStorageBackend 的 JSON 序列化往返（set 时 stringify），
 * 去重提前 / 上限淘汰 / 归一键命中 / 损坏容忍全部钉死在纯函数上。
 */

/** 内存 KV：set 走 JSON 往返（真实后端就是 JSON 文件，别让引用共享假通过） */
function memoryKv(): SessionKv & { raw(): string | undefined } {
  const m = new Map<string, string>();
  return {
    async get(key) {
      const s = m.get(key);
      return s === undefined ? undefined : JSON.parse(s);
    },
    async set(key, value) {
      m.set(key, JSON.stringify(value));
    },
    raw: () => m.get(RECENT_FILES_KEY),
  };
}

let kv: ReturnType<typeof memoryKv>;

beforeEach(() => {
  kv = memoryKv();
});

const rec = (path: string, rootDir: string, openedAt: number): RecentFileRecord => ({ path, rootDir, openedAt });

describe('sanitizeRecentFiles（损坏容忍）', () => {
  it('任何不合法形态回空列表，绝不抛', () => {
    for (const raw of [undefined, null, 'x', 42, true, {}]) {
      expect(sanitizeRecentFiles(raw)).toEqual([]);
    }
  });

  it('条目缺字段/字段类型不对 ⇒ 整条滤掉（好条目照收）', () => {
    const list = sanitizeRecentFiles([
      null,
      'nope',
      42,
      {},
      { path: '', rootDir: 'C:/p', openedAt: 1 }, // 空 path
      { path: 'C:/a.ERB', rootDir: '', openedAt: 1 }, // 空 rootDir
      { path: 'C:/a.ERB', rootDir: 'C:/p' }, // 缺 openedAt
      { path: 'C:/a.ERB', rootDir: 'C:/p', openedAt: 'x' }, // openedAt 非数字
      { path: 'C:/b.ERB', rootDir: 'C:/p', openedAt: 5 },
    ]);
    expect(list).toEqual([rec('C:/b.ERB', 'C:/p', 5)]);
  });

  it('按 openedAt 降序排（队首 = 最新）；同 openedAt 保输入次序', () => {
    const list = sanitizeRecentFiles([
      rec('C:/old.ERB', 'C:/p', 1),
      rec('C:/new.ERB', 'C:/p', 9),
      rec('C:/mid.ERB', 'C:/p', 5),
    ]);
    expect(list.map((r) => r.path)).toEqual(['C:/new.ERB', 'C:/mid.ERB', 'C:/old.ERB']);
    const tied = sanitizeRecentFiles([
      rec('C:/a.ERB', 'C:/p', 7),
      rec('C:/b.ERB', 'C:/p', 7),
      rec('C:/c.ERB', 'C:/p', 7),
    ]);
    expect(tied.map((r) => r.path)).toEqual(['C:/a.ERB', 'C:/b.ERB', 'C:/c.ERB']);
  });

  it('超限截断到 RECENT_FILES_LIMIT（留新的，砍旧的）', () => {
    const many: RecentFileRecord[] = [];
    for (let i = 0; i < RECENT_FILES_LIMIT + 5; i++) many.push(rec(`C:/f${i}.ERB`, 'C:/p', i));
    const list = sanitizeRecentFiles(many);
    expect(list).toHaveLength(RECENT_FILES_LIMIT);
    expect(list[0]?.openedAt).toBe(RECENT_FILES_LIMIT + 4); // 最新在队首
    expect(list[list.length - 1]?.openedAt).toBe(5); // 最旧的五条（0..4）被砍
  });

  it('重复 path（pathKey 归一）去重：只留排序后的第一条', () => {
    const list = sanitizeRecentFiles([
      rec('C:/a.ERB', 'C:/old', 1),
      rec('c:/a.erb', 'C:/new', 9),
    ]);
    expect(list).toEqual([rec('c:/a.erb', 'C:/new', 9)]);
  });
});

describe('upsertRecentFile（去重提前 + 上限淘汰）', () => {
  it('新文件插入队首；不改入参（返回新数组）', () => {
    const base = [rec('C:/a.ERB', 'C:/p', 1)];
    const next = upsertRecentFile(base, { path: 'C:/b.ERB', rootDir: 'C:/p', now: 2 });
    expect(next.map((r) => r.path)).toEqual(['C:/b.ERB', 'C:/a.ERB']);
    expect(base.map((r) => r.path)).toEqual(['C:/a.ERB']); // 入参未被改
  });

  it('同 path 已存在 ⇒ 提前到队首并刷新 openedAt/rootDir（不产生重复行）', () => {
    const base = [rec('C:/a.ERB', 'C:/p', 1), rec('C:/b.ERB', 'C:/p', 2)];
    const next = upsertRecentFile(base, { path: 'C:/a.ERB', rootDir: 'C:/p2', now: 9 });
    expect(next).toEqual([rec('C:/a.ERB', 'C:/p2', 9), rec('C:/b.ERB', 'C:/p', 2)]);
  });

  it('pathKey 归一：大小写 / 分隔符不同的同一路径命中同一条记录', () => {
    const base = [rec('C:\\Game\\eraTW\\a.ERB', 'C:/p', 1)];
    const next = upsertRecentFile(base, { path: 'c:/game/eratw/a.erb', rootDir: 'C:/p', now: 5 });
    expect(next).toEqual([rec('c:/game/eratw/a.erb', 'C:/p', 5)]);
  });

  it('超过上限 ⇒ 淘汰队尾（最旧）', () => {
    let list: RecentFileRecord[] = [];
    for (let i = 0; i < RECENT_FILES_LIMIT; i++) {
      list = upsertRecentFile(list, { path: `C:/f${i}.ERB`, rootDir: 'C:/p', now: i });
    }
    expect(list).toHaveLength(RECENT_FILES_LIMIT);
    list = upsertRecentFile(list, { path: 'C:/fresh.ERB', rootDir: 'C:/p', now: 999 });
    expect(list).toHaveLength(RECENT_FILES_LIMIT);
    expect(list[0]?.path).toBe('C:/fresh.ERB');
    expect(list[list.length - 1]?.path).toBe('C:/f1.ERB'); // 最旧的 f0 被挤出去
    expect(list.some((r) => r.path === 'C:/f0.ERB')).toBe(false);
  });
});

describe('removeRecentFiles（按 pathKey 摘除）', () => {
  it('大小写 / 分隔符不同的写法不漏删', () => {
    const list = [rec('C:\\Game\\eraTW\\a.ERB', 'C:/p', 3), rec('C:\\Game\\eraTW\\b.ERB', 'C:/p', 2)];
    expect(removeRecentFiles(list, ['c:/game/eratw/a.erb'])).toEqual([rec('C:\\Game\\eraTW\\b.ERB', 'C:/p', 2)]);
  });

  it('批量摘除（删目录 / 成批改名）一次到位，其余保序', () => {
    const list = [
      rec('C:/a.ERB', 'C:/p', 4),
      rec('C:/b.ERB', 'C:/p', 3),
      rec('C:/c.ERB', 'C:/p', 2),
      rec('C:/d.ERB', 'C:/p', 1),
    ];
    expect(removeRecentFiles(list, ['C:/a.ERB', 'C:/c.ERB']).map((r) => r.path)).toEqual(['C:/b.ERB', 'C:/d.ERB']);
  });

  it('未命中 / 空 paths = 原样新数组（不改入参）', () => {
    const list = [rec('C:/a.ERB', 'C:/p', 1)];
    expect(removeRecentFiles(list, ['C:/gone.ERB'])).toEqual(list);
    expect(removeRecentFiles(list, [])).toEqual(list);
    expect(removeRecentFiles(list, [])).not.toBe(list);
  });
});

describe('renameRecentFiles（改名迁移，WS-02）', () => {
  const DIR_RENAME = [{ from: 'C:\\Game\\eraTW\\kojo\\001', to: 'C:\\Game\\eraTW\\kojo\\001-新' }];

  it('旧路径（含改名目录之下的子路径）换新路径，openedAt / rootDir 原样保留', () => {
    const list = [
      rec('C:\\Game\\eraTW\\kojo\\001\\a.ERB', 'C:\\Game\\eraTW', 30),
      rec('C:\\Game\\eraTW\\kojo\\001\\pkg\\deep\\b.ERB', 'C:\\Game\\eraTW', 20),
      rec('C:\\Game\\eraTW\\kojo\\002\\keep.ERB', 'C:\\Game\\eraTW', 10),
    ];
    expect(renameRecentFiles(list, DIR_RENAME)).toEqual([
      rec('C:\\Game\\eraTW\\kojo\\001-新\\a.ERB', 'C:\\Game\\eraTW', 30),
      rec('C:\\Game\\eraTW\\kojo\\001-新\\pkg\\deep\\b.ERB', 'C:\\Game\\eraTW', 20),
      rec('C:\\Game\\eraTW\\kojo\\002\\keep.ERB', 'C:\\Game\\eraTW', 10),
    ]);
  });

  it('同名前缀邻居不误伤；未命中 = 原样新数组（不改入参）', () => {
    const list = [rec('C:\\Game\\eraTW\\kojo\\001-备份\\x.ERB', 'C:\\Game\\eraTW', 5)];
    expect(renameRecentFiles(list, DIR_RENAME)).toEqual(list);
    expect(renameRecentFiles(list, DIR_RENAME)).not.toBe(list);
    expect(renameRecentFiles(list, [])).toEqual(list);
  });

  it('同 pathKey 只留一条：优先保留改名后的那条，并保持它原来的排序位置', () => {
    // 盘上已有一条指向新路径的更旧记录（同名重开过）：改名后的那条让它在队列里的位置胜出
    const list = [
      rec('C:\\Game\\eraTW\\kojo\\001\\a.ERB', 'C:\\Game\\eraTW', 30), // 会被改名
      rec('C:\\Game\\eraTW\\kojo\\002\\keep.ERB', 'C:\\Game\\eraTW', 20),
      rec('C:\\Game\\eraTW\\kojo\\001-新\\a.ERB', 'C:\\Game\\eraTW', 10), // 已在新路径
    ];
    const out = renameRecentFiles(list, DIR_RENAME);
    expect(out).toEqual([
      rec('C:\\Game\\eraTW\\kojo\\001-新\\a.ERB', 'C:\\Game\\eraTW', 30),
      rec('C:\\Game\\eraTW\\kojo\\002\\keep.ERB', 'C:\\Game\\eraTW', 20),
    ]);
  });

  it('改名 + 摘除的组合（App 的收尾口径）：改名先迁、被删的再按精确路径摘', () => {
    const list = [
      rec('C:\\Game\\eraTW\\kojo\\001\\a.ERB', 'C:\\Game\\eraTW', 30),
      rec('C:\\Game\\eraTW\\other\\gone.ERB', 'C:\\Game\\eraTW', 20),
    ];
    const out = removeRecentFiles(renameRecentFiles(list, DIR_RENAME), ['C:\\Game\\eraTW\\other\\gone.ERB']);
    expect(out).toEqual([rec('C:\\Game\\eraTW\\kojo\\001-新\\a.ERB', 'C:\\Game\\eraTW', 30)]);
  });
});

describe('sameRecentFiles（有变化才落盘）', () => {
  it('逐条等值才算没变化；路径 / 时间戳 / 归属任一不同都算变化', () => {
    const a = [rec('C:/a.ERB', 'C:/p', 2), rec('C:/b.ERB', 'C:/p', 1)];
    expect(sameRecentFiles(a, [rec('C:/a.ERB', 'C:/p', 2), rec('C:/b.ERB', 'C:/p', 1)])).toBe(true);
    expect(sameRecentFiles(a, [rec('C:/x.ERB', 'C:/p', 2), rec('C:/b.ERB', 'C:/p', 1)])).toBe(false);
    expect(sameRecentFiles(a, [rec('C:/a.ERB', 'C:/q', 2), rec('C:/b.ERB', 'C:/p', 1)])).toBe(false);
    expect(sameRecentFiles(a, [rec('C:/a.ERB', 'C:/p', 9), rec('C:/b.ERB', 'C:/p', 1)])).toBe(false);
    expect(sameRecentFiles(a, [rec('C:/a.ERB', 'C:/p', 2)])).toBe(false);
  });
});

describe('loadRecentFiles / saveRecentFiles（JSON 往返）', () => {
  it('save → load 等值（真实后端是 JSON 文件，序列化不可丢信息）', async () => {
    let list: RecentFileRecord[] = [];
    list = upsertRecentFile(list, { path: 'C:/a.ERB', rootDir: 'C:/p', now: 1 });
    list = upsertRecentFile(list, { path: 'C:/b.ERB', rootDir: 'C:/p', now: 2 });
    await saveRecentFiles(kv, list);
    expect(await loadRecentFiles(kv)).toEqual(list);
    expect(kv.raw()).toContain('"rootDir":"C:/p"'); // 内容落盘（键名 = RECENT_FILES_KEY）
  });

  it('盘上损坏（非 JSON 形态的值）→ load 回空列表不抛', async () => {
    await kv.set(RECENT_FILES_KEY, 'totally not a list' as unknown as RecentFileRecord[]);
    expect(await loadRecentFiles(kv)).toEqual([]);
  });

  it('首次运行（键不存在）→ 空列表', async () => {
    expect(await loadRecentFiles(kv)).toEqual([]);
  });
});
