import { beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_KEY,
  emptySessionRecord,
  loadSessionRecord,
  sanitizeSessionRecord,
  saveSessionRecord,
  sessionProjectKey,
  sessionProjectOf,
  upsertSessionProject,
  type SessionKv,
  type SessionRecord,
} from '../src/ui/session-store';

/**
 * 会话标签集持久层的判据（退出/崩溃守护批）。
 *
 * KV 替身模拟真实 FileStorageBackend 的 JSON 序列化往返（set 时深拷贝），
 * 形状校验/损坏容忍/归一键命中全部钉死在纯函数上。
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
    raw: () => m.get(SESSION_KEY),
  };
}

let kv: ReturnType<typeof memoryKv>;

beforeEach(() => {
  kv = memoryKv();
});

const recOf = (tabs: string[], active: string | null, pinned: string[]): { tabs: string[]; active: string | null; pinned: string[] } => ({
  tabs,
  active,
  pinned,
});

describe('sanitizeSessionRecord（损坏容忍）', () => {
  it('任何不合法形态回空记录，绝不抛', () => {
    for (const raw of [undefined, null, 'x', 42, [], { v: 2 }, { v: 1, projects: 'no' }]) {
      expect(sanitizeSessionRecord(raw)).toEqual(emptySessionRecord());
    }
  });

  it('空标签集的项目剔除；active 不在 tabs → 落 tabs[0]；pinned 与 tabs 取交集；列表去重', () => {
    const rec = sanitizeSessionRecord({
      v: 1,
      lastRoot: 'C:/proj',
      projects: {
        keep: { tabs: ['C:/a.ERB', 'C:/a.ERB', 'C:/b.ERB'], active: 'C:/missing.ERB', pinned: ['C:/b.ERB', 'C:/gone.ERB'] },
        empty: { tabs: [], active: null, pinned: [] },
        bad: 'not-an-object',
      },
    });
    expect(Object.keys(rec.projects).sort()).toEqual(['keep']);
    expect(rec.projects.keep).toEqual({
      tabs: ['C:/a.ERB', 'C:/b.ERB'],
      active: 'C:/a.ERB',
      pinned: ['C:/b.ERB'],
    });
    expect(rec.lastRoot).toBe('C:/proj');
  });

  it('lastRoot 非字符串/空串 → null', () => {
    expect(sanitizeSessionRecord({ v: 1, lastRoot: '', projects: {} }).lastRoot).toBeNull();
    expect(sanitizeSessionRecord({ v: 1, lastRoot: 42, projects: {} }).lastRoot).toBeNull();
  });
});

describe('upsertSessionProject / sessionProjectOf（归一键）', () => {
  it('pathKey 归一：两种写法命中同一条记录', () => {
    let rec = upsertSessionProject(emptySessionRecord(), 'C:\\Proj\\游戏', recOf(['C:/a.ERB'], 'C:/a.ERB', []));
    rec = upsertSessionProject(rec, 'c:/proj/游戏', recOf(['C:/b.ERB'], null, []));
    expect(sessionProjectOf(rec, 'C:/PROJ/游戏')).toEqual({ tabs: ['C:/b.ERB'], active: 'C:/b.ERB', pinned: [] });
    expect(sessionProjectKey('C:\\Proj\\游戏')).toBe(sessionProjectKey('c:/proj/游戏'));
  });

  it('upsert 顺手把 lastRoot 指向当前项目；不改入参（返回新对象）', () => {
    const base = emptySessionRecord();
    const next = upsertSessionProject(base, 'C:/p2', recOf(['C:/x.ERB'], null, []));
    expect(next.lastRoot).toBe('C:/p2');
    expect(base.lastRoot).toBeNull(); // 入参未被改
    expect(base.projects).toEqual({});
  });

  it('空标签集 upsert = 删除该项目记录（重开不凭空造标签）', () => {
    let rec = upsertSessionProject(emptySessionRecord(), 'C:/p', recOf(['C:/a.ERB'], null, []));
    rec = upsertSessionProject(rec, 'C:/p', recOf([], null, []));
    expect(sessionProjectOf(rec, 'C:/p')).toBeNull();
  });

  it('active/pinned 非法值回退：active 不在 tabs 落 tabs[0]，pinned 过滤成 tabs 子集', () => {
    const rec = upsertSessionProject(emptySessionRecord(), 'C:/p', recOf(['C:/a.ERB', 'C:/b.ERB'], 'C:/zz.ERB', ['C:/b.ERB', 'C:/zz.ERB']));
    expect(rec.projects[sessionProjectKey('C:/p')]).toEqual({
      tabs: ['C:/a.ERB', 'C:/b.ERB'],
      active: 'C:/a.ERB',
      pinned: ['C:/b.ERB'],
    });
  });
});

describe('loadSessionRecord / saveSessionRecord（JSON 往返）', () => {
  it('save → load 等值（真实后端是 JSON 文件，序列化不可丢信息）', async () => {
    let rec: SessionRecord = emptySessionRecord();
    rec = upsertSessionProject(rec, 'C:/proj', recOf(['C:/a.ERB', 'C:/b.ERB'], 'C:/b.ERB', ['C:/a.ERB']));
    await saveSessionRecord(kv, rec);
    expect(await loadSessionRecord(kv)).toEqual(rec);
    expect(kv.raw()).toContain('"lastRoot":"C:/proj"');
  });

  it('盘上损坏（非 JSON 形态的对象）→ load 回空记录不抛', async () => {
    await kv.set(SESSION_KEY, 'totally not a session' as unknown as SessionRecord);
    expect(await loadSessionRecord(kv)).toEqual(emptySessionRecord());
  });

  it('首次运行（键不存在）→ 空记录', async () => {
    expect(await loadSessionRecord(kv)).toEqual(emptySessionRecord());
  });
});
