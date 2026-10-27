import { beforeEach, describe, expect, it } from 'vitest';
import {
  initialEditorGroups,
  openInActiveGroup,
  restoreGroups,
  serializeGroups,
  setGroupsOrientation,
  splitActiveDown,
} from '../src/ui/editor-groups';
import {
  SESSION_EXTRA_ROOTS_LIMIT,
  SESSION_FLUSH_DEBOUNCE_MS,
  SESSION_KEY,
  createSessionFlushScheduler,
  emptySessionRecord,
  loadSessionRecord,
  sanitizeSessionRecord,
  saveSessionRecord,
  sessionProjectKey,
  sessionProjectOf,
  upsertSessionProject,
  type SessionFlushPayload,
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

/* ------------ groups 快照（MM-9 编辑器组布局持久化 · additive 扩展） ------------ */

/** 一份合法的 groups 快照（两组 + column，形状 = serializeGroups 产物） */
const groupsSnapshot = (): unknown => {
  let s = initialEditorGroups();
  s = openInActiveGroup(s, 'C:/a.ERB');
  s = openInActiveGroup(s, 'C:/b.ERB');
  s = setGroupsOrientation(s, 'column');
  s = splitActiveDown(s);
  return serializeGroups(s);
};

describe('sanitizeSessionRecord · groups（MM-9 additive）', () => {
  it('旧形态记录 sanitize 逐字不受影响（老记录没有 groups 字段：键都不补）', () => {
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
    expect('groups' in rec.projects.keep!).toBe(false); // additive：老记录不补 key
    expect(rec.lastRoot).toBe('C:/proj');
  });

  it('带 groups 的记录 sanitize 后快照原样还在，且判得过合法', () => {
    const snap = groupsSnapshot();
    const rec = sanitizeSessionRecord({
      v: 1,
      lastRoot: 'C:/proj',
      projects: { p: { tabs: ['C:/a.ERB', 'C:/b.ERB'], active: 'C:/b.ERB', pinned: ['C:/a.ERB'], groups: snap } },
    });
    expect(rec.projects.p?.groups).toEqual(snap);
    expect(restoreGroups(rec.projects.p?.groups)).not.toBeNull();
    // 快照真的描出了两组 + column
    const back = restoreGroups(rec.projects.p?.groups)!;
    expect(back.groups).toHaveLength(2);
    expect(back.orientation).toBe('column');
  });

  it('groups 坏形态（乱值）被当作无 groups 且不炸', () => {
    for (const bad of [null, 'x', 42, [], {}, { orientation: 'row' }, { orientation: 'diag', groups: [] }, { orientation: 'row', activeGroupId: 'eg-1', groups: [] }]) {
      const rec = sanitizeSessionRecord({
        v: 1,
        projects: { p: { tabs: ['C:/a.ERB'], active: 'C:/a.ERB', pinned: [], groups: bad } },
      });
      expect(rec.projects.p).toEqual({ tabs: ['C:/a.ERB'], active: 'C:/a.ERB', pinned: [] });
      expect('groups' in rec.projects.p!).toBe(false);
    }
  });
});

describe('upsertSessionProject · groups（MM-9 additive）', () => {
  it('合法 groups 传入即存（save → load 往返不丢）', async () => {
    const snap = groupsSnapshot();
    let rec = upsertSessionProject(emptySessionRecord(), 'C:/proj', recOf(['C:/a.ERB', 'C:/b.ERB'], 'C:/b.ERB', ['C:/a.ERB']));
    rec = upsertSessionProject(rec, 'C:/proj', { ...recOf(['C:/a.ERB', 'C:/b.ERB'], 'C:/b.ERB', ['C:/a.ERB']), groups: snap });
    expect(rec.projects[sessionProjectKey('C:/proj')]?.groups).toEqual(snap);
    await saveSessionRecord(kv, rec);
    const loaded = await loadSessionRecord(kv);
    expect(sessionProjectOf(loaded, 'C:/proj')?.groups).toEqual(snap);
  });

  it('乱值 groups 不存（预校验挡在 upsert 一侧）', () => {
    const rec = upsertSessionProject(emptySessionRecord(), 'C:/p', { ...recOf(['C:/a.ERB'], null, []), groups: { orientation: 'nope' } });
    expect('groups' in rec.projects[sessionProjectKey('C:/p')]!).toBe(false);
  });

  it('空 tabs 项目记录照旧不入库（groups 跟着一起不入库）', () => {
    let rec = upsertSessionProject(emptySessionRecord(), 'C:/p', { ...recOf(['C:/a.ERB'], null, []), groups: groupsSnapshot() });
    rec = upsertSessionProject(rec, 'C:/p', { ...recOf([], null, []), groups: groupsSnapshot() });
    expect(sessionProjectOf(rec, 'C:/p')).toBeNull();
  });
});

/* ------------ createSessionFlushScheduler（S2 #4：关项目强刷不丢最后一拍） ------------ */

/** 假钟：注入调度器，手动"到点"，时序钉死不靠真实定时器 */
function fakeClock() {
  let seq = 0;
  const queued = new Map<number, () => void>();
  return {
    setTimer(cb: () => void): number {
      const id = ++seq;
      queued.set(id, cb);
      return id;
    },
    clearTimer(timer: unknown): void {
      queued.delete(timer as number);
    },
    /** 当前仍在排的定时器个数（验证 debounce 合并 / 旧计时器被清） */
    pending(): number {
      return queued.size;
    },
    /** 让所有在排计时器"到点"（先摘再跑：跑的就是 flushNow 本体，不重复触发） */
    fireAll(): void {
      const due = [...queued.values()];
      queued.clear();
      for (const cb of due) cb();
    },
  };
}

const payloadOf = (root: string, tabs: string[], active: string | null, pinned: string[]): SessionFlushPayload => ({
  root,
  kv: memoryKv(),
  tabs,
  active,
  pinned,
});

describe('createSessionFlushScheduler（S2 #4 关项目强刷）', () => {
  it('schedule 后防抖窗口内立即关项目（flushNow）→ 最新一份同步落盘，且只写这一次', () => {
    const clock = fakeClock();
    const writes: SessionFlushPayload[] = [];
    const s = createSessionFlushScheduler({
      write: (p) => writes.push(p),
      setTimer: (cb) => clock.setTimer(cb),
      clearTimer: (t) => clock.clearTimer(t),
    });
    s.schedule(payloadOf('C:/p', ['C:/a.ERB'], 'C:/a.ERB', []));
    s.schedule(payloadOf('C:/p', ['C:/a.ERB', 'C:/b.ERB'], 'C:/b.ERB', ['C:/a.ERB'])); // 窗口内的后续变更
    s.flushNow(); // 关项目 / 卸载收尾：不等 600ms，同步强制落盘
    expect(writes).toHaveLength(1);
    expect(writes[0]?.tabs).toEqual(['C:/a.ERB', 'C:/b.ERB']); // 最新集，不是"旧一拍"
    s.flushNow(); // 幂等：已无待写，再进一次不重复写
    expect(writes).toHaveLength(1);
  });

  it('flushNow 落的那一份真的进得了盘：save → load 可恢复该项目标签集', async () => {
    const clock = fakeClock();
    const kvDisk = memoryKv();
    let rec = emptySessionRecord();
    const s = createSessionFlushScheduler({
      // 与 App 写面同款：upsert 内存权威 + saveSessionRecord
      write: (p) => {
        rec = upsertSessionProject(rec, p.root, p);
        void saveSessionRecord(p.kv, rec);
      },
      setTimer: (cb) => clock.setTimer(cb),
      clearTimer: (t) => clock.clearTimer(t),
    });
    s.schedule(payloadOf('C:/proj', ['C:/a.ERB'], 'C:/a.ERB', []));
    s.schedule({ ...payloadOf('C:/proj', ['C:/a.ERB', 'C:/b.ERB'], 'C:/b.ERB', ['C:/a.ERB']), kv: kvDisk });
    s.flushNow();
    const loaded = await loadSessionRecord(kvDisk);
    expect(sessionProjectOf(loaded, 'C:/proj')).toEqual({
      tabs: ['C:/a.ERB', 'C:/b.ERB'],
      active: 'C:/b.ERB',
      pinned: ['C:/a.ERB'],
    });
    expect(loaded.lastRoot).toBe('C:/proj'); // 首开会话：记录与 lastRoot 都在（不再"整条缺失"）
  });

  it('稳态保持 debounce：窗口内多次 schedule 不写盘；计时器到点只写最新一份', () => {
    const clock = fakeClock();
    const writes: SessionFlushPayload[] = [];
    const s = createSessionFlushScheduler({
      write: (p) => writes.push(p),
      debounceMs: 600,
      setTimer: (cb) => clock.setTimer(cb),
      clearTimer: (t) => clock.clearTimer(t),
    });
    s.schedule(payloadOf('C:/p', ['C:/a.ERB'], 'C:/a.ERB', []));
    s.schedule(payloadOf('C:/p', ['C:/a.ERB', 'C:/b.ERB'], 'C:/b.ERB', []));
    s.schedule(payloadOf('C:/p', ['C:/a.ERB', 'C:/b.ERB', 'C:/c.ERB'], 'C:/c.ERB', []));
    expect(writes).toHaveLength(0); // 还没到点：一次都不写
    expect(clock.pending()).toBe(1); // 旧计时器被重置，不叠加
    clock.fireAll();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.tabs).toEqual(['C:/a.ERB', 'C:/b.ERB', 'C:/c.ERB']);
    clock.fireAll(); // 到点后又"到点"一次：无待写，不双写
    expect(writes).toHaveLength(1);
  });

  it('默认 debounce = SESSION_FLUSH_DEBOUNCE_MS；空标签集快照也照样落（= 删该项目记录）', () => {
    const clock = fakeClock();
    const writes: SessionFlushPayload[] = [];
    const s = createSessionFlushScheduler({
      write: (p) => writes.push(p),
      setTimer: (cb) => clock.setTimer(cb),
      clearTimer: (t) => clock.clearTimer(t),
    });
    s.schedule(payloadOf('C:/p', [], null, []));
    s.flushNow();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.tabs).toEqual([]); // "标签全关再关项目 = 空标签集"口径穿过调度器不丢
    expect(SESSION_FLUSH_DEBOUNCE_MS).toBe(600);
  });
});

/* ------------ splitSizes（WS-06 分屏比例 · additive 扩展） ------------ */

/** 两组快照（splitSizes 长度 = 组数 - 1 = 1） */
const twoGroupSnapshot = (): unknown => serializeGroups(splitActiveDown(openInActiveGroup(initialEditorGroups(), 'C:/a.ERB')));

describe('sanitizeSessionRecord · splitSizes（WS-06 additive）', () => {
  it('合法比例随 groups 一起留下，且经归一后仍是同一份值', () => {
    const rec = sanitizeSessionRecord({
      v: 1,
      projects: {
        p: { tabs: ['C:/a.ERB'], active: 'C:/a.ERB', pinned: [], groups: twoGroupSnapshot(), splitSizes: [0.35] },
      },
    });
    expect(rec.projects.p?.splitSizes).toEqual([0.35]);
  });

  it('长度不符 / 乱值 / 没有 groups ⇒ 比例整份丢弃（不炸、不猜）', () => {
    for (const bad of [[0.5, 0.5], [], 'x', 42, [Number.NaN], [0], [{ v: 1 }]]) {
      const rec = sanitizeSessionRecord({
        v: 1,
        projects: { p: { tabs: ['C:/a.ERB'], active: 'C:/a.ERB', pinned: [], groups: twoGroupSnapshot(), splitSizes: bad } },
      });
      expect('splitSizes' in rec.projects.p!).toBe(false);
    }
    // 没有 groups 就无从知道组数 ⇒ 比例没意义，丢弃
    const rec = sanitizeSessionRecord({
      v: 1,
      projects: { p: { tabs: ['C:/a.ERB'], active: 'C:/a.ERB', pinned: [], splitSizes: [0.4] } },
    });
    expect('splitSizes' in rec.projects.p!).toBe(false);
  });

  it('过小/过大的比例被夹取（0.999 → 1 - 下限），绝不写出把某组挤没的值', () => {
    const rec = sanitizeSessionRecord({
      v: 1,
      projects: { p: { tabs: ['C:/a.ERB'], active: 'C:/a.ERB', pinned: [], groups: twoGroupSnapshot(), splitSizes: [0.999] } },
    });
    expect(rec.projects.p?.splitSizes?.[0]).toBeCloseTo(0.9);
  });
});

describe('upsertSessionProject · splitSizes（WS-06 additive）', () => {
  it('save → load 往返不丢（比例与组态一起回来）', async () => {
    const groups = twoGroupSnapshot();
    let rec = upsertSessionProject(emptySessionRecord(), 'C:/proj', {
      ...recOf(['C:/a.ERB'], 'C:/a.ERB', []),
      groups,
      splitSizes: [0.7],
    });
    await saveSessionRecord(kv, rec);
    const loaded = await loadSessionRecord(kv);
    expect(sessionProjectOf(loaded, 'C:/proj')?.splitSizes).toEqual([0.7]);
    expect(sessionProjectOf(loaded, 'C:/proj')?.groups).toEqual(groups);
  });

  it('长度与组态不符 ⇒ 只丢比例、组态照存（缩成均分而不是整份记录报废）', () => {
    const rec = upsertSessionProject(emptySessionRecord(), 'C:/p', {
      ...recOf(['C:/a.ERB'], 'C:/a.ERB', []),
      groups: twoGroupSnapshot(),
      splitSizes: [0.3, 0.3, 0.4],
    });
    const entry = sessionProjectOf(rec, 'C:/p');
    expect(entry?.groups).toBeDefined();
    expect(entry !== null && 'splitSizes' in entry).toBe(false);
  });
});

/* ------------ extraRoots（WS-08 会话级附加根 · additive 扩展） ------------ */

describe('sanitizeSessionRecord · extraRoots（WS-08 additive）', () => {
  it('绝对路径去重保留；相对路径 / 项目根自身 / 非字符串剔除', () => {
    const rec = sanitizeSessionRecord({
      v: 1,
      projects: {
        // 真实记录键 = pathKey(项目根)；"项目根自身"的剔除就靠这个键
        [sessionProjectKey('C:/proj')]: {
          tabs: ['C:/a.ERB'],
          active: 'C:/a.ERB',
          pinned: [],
          extraRoots: ['D:/一', 'D:/一/', 'E:/二', 'relative/dir', 'C:/proj', 42, ''],
        },
      },
    });
    expect(rec.projects[sessionProjectKey('C:/proj')]?.extraRoots).toEqual(['D:/一', 'E:/二']);
  });

  it('标签全空但附加根非空 ⇒ 记录保留（别被"空标签集不入库"吞掉）', () => {
    const rec = sanitizeSessionRecord({
      v: 1,
      projects: { p: { tabs: [], active: null, pinned: [], extraRoots: ['D:/借阅'] } },
    });
    expect(rec.projects.p).toEqual({ tabs: [], active: null, pinned: [], extraRoots: ['D:/借阅'] });
  });

  it('上限截断（32 条），损坏形态整体回空记录不抛', () => {
    const many = Array.from({ length: 40 }, (_, i) => `D:/r${i}`);
    const rec = sanitizeSessionRecord({ v: 1, projects: { p: { tabs: ['C:/a.ERB'], extraRoots: many } } });
    expect(rec.projects.p?.extraRoots).toHaveLength(SESSION_EXTRA_ROOTS_LIMIT);
    expect(sanitizeSessionRecord({ v: 1, projects: { p: { tabs: ['C:/a.ERB'], extraRoots: 'x' } } }).projects.p?.extraRoots)
      .toBeUndefined();
  });
});

describe('upsertSessionProject · extraRoots（WS-08 additive）', () => {
  it('save → load 往返；空标签集但有附加根 ⇒ 记录不删', async () => {
    let rec = upsertSessionProject(emptySessionRecord(), 'C:/p', {
      ...recOf([], null, []),
      extraRoots: ['D:/借阅'],
    });
    await saveSessionRecord(kv, rec);
    const loaded = await loadSessionRecord(kv);
    expect(sessionProjectOf(loaded, 'C:/p')).toEqual({
      tabs: [],
      active: null,
      pinned: [],
      extraRoots: ['D:/借阅'],
    });
  });

  it('附加根全删 + 标签也空 ⇒ 记录删除（重开不造标签也不造根）', () => {
    let rec = upsertSessionProject(emptySessionRecord(), 'C:/p', {
      ...recOf(['C:/a.ERB'], null, []),
      extraRoots: ['D:/借阅'],
    });
    expect(sessionProjectOf(rec, 'C:/p')?.extraRoots).toEqual(['D:/借阅']);
    rec = upsertSessionProject(rec, 'C:/p', { ...recOf([], null, []), extraRoots: [] });
    expect(sessionProjectOf(rec, 'C:/p')).toBeNull();
  });

  it('项目根自身不当附加根存（自我指涉剔除）', () => {
    const rec = upsertSessionProject(emptySessionRecord(), 'C:/proj', {
      ...recOf(['C:/a.ERB'], null, []),
      extraRoots: ['C:/proj', 'D:/借阅'],
    });
    expect(sessionProjectOf(rec, 'C:/proj')?.extraRoots).toEqual(['D:/借阅']);
  });

  it('换项目不继承上一个项目的根：各项目记录互不干扰', () => {
    let rec = upsertSessionProject(emptySessionRecord(), 'C:/a', {
      ...recOf(['C:/a/x.ERB'], null, []),
      extraRoots: ['D:/a-借阅'],
    });
    rec = upsertSessionProject(rec, 'C:/b', { ...recOf(['C:/b/y.ERB'], null, []), extraRoots: [] });
    expect(sessionProjectOf(rec, 'C:/a')?.extraRoots).toEqual(['D:/a-借阅']);
    // B 自己没有根（新项目读自己的记录 → 空，绝不把 A 的根带过来）
    expect(sessionProjectOf(rec, 'C:/b')?.extraRoots).toBeUndefined();
  });
});

/* ------------ 调度器 payload（WS-06/08：比例与附加根随快照走） ------------ */

describe('createSessionFlushScheduler · 布局/附加根随 payload 落盘', () => {
  it('payload 里的 splitSizes / extraRoots 穿过调度器不丢，且与 groups 一起进盘', async () => {
    const clock = fakeClock();
    const kvDisk = memoryKv();
    let rec = emptySessionRecord();
    const s = createSessionFlushScheduler({
      // 与 App 写面同款：payload + 当时的组态快照一起 upsert
      write: (p) => {
        rec = upsertSessionProject(rec, p.root, { ...p, groups: twoGroupSnapshot() });
        void saveSessionRecord(p.kv, rec);
      },
      setTimer: (cb) => clock.setTimer(cb),
      clearTimer: (t) => clock.clearTimer(t),
    });
    s.schedule({
      ...payloadOf('C:/proj', ['C:/a.ERB'], 'C:/a.ERB', []),
      splitSizes: [0.65],
      extraRoots: ['D:/借阅'],
      kv: kvDisk,
    });
    s.flushNow();
    const loaded = await loadSessionRecord(kvDisk);
    expect(sessionProjectOf(loaded, 'C:/proj')?.splitSizes).toEqual([0.65]);
    expect(sessionProjectOf(loaded, 'C:/proj')?.extraRoots).toEqual(['D:/借阅']);
  });
});
