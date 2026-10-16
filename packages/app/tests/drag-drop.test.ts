import { describe, expect, it, vi } from 'vitest';
import {
  DIRECTORY_REASON,
  DRAG_DROP_EVENT_NAME,
  DIRTY_SWITCH_REASON,
  NOT_READY_MESSAGE,
  ONE_DIRECTORY_REASON,
  OPENABLE_EXT,
  PROJECT_GATE_MESSAGE,
  UNREADABLE_REASON,
  UNKNOWN_FILE_REASON,
  classifyDrop,
  formatRejections,
  nextDropOverlay,
  processDroppedFiles,
  routeDroppedPaths,
  splitByStat,
  subscribeDragDrop,
  type DropOverlayEvent,
  type DropOverlayState,
  type DropRouting,
} from '../src/ui/drag-drop';

/**
 * 外部拖拽打开文件/文件夹（drag-drop 批）：
 * ① 扩展名分类的人话拒绝与顺序保持；② 覆盖提示状态机在 over 刷屏下幂等；
 * ③ stat 三态拆分（失踪/目录/文件）与总路由 `routeDroppedPaths`——
 *    文件夹即项目入口（欢迎页与项目态同权），脏标签拒切、同目录重载、拒绝聚成一条通知；
 * ④ 落地链路零写盘自证（假 io 记录调用序列，writeText/readText/exportFile 一个都不许出现）。
 */

describe('classifyDrop：扩展名这一层', () => {
  it('白名单契约：ERB 方言那一段来自契约层单一真源，非方言两类由本行自己决定', () => {
    // 顺序即覆盖提示的显示顺序；`.erh` 是 FT-2 才进面的（拖得开 ⇔ 索引收得到，同一份清单）
    expect(OPENABLE_EXT).toEqual(['.kojo', '.erb', '.erm', '.erh', '.md', '.txt']);
  });

  it('事件名与 Rust 侧 DRAG_DROP_EVENT 成对', () => {
    expect(DRAG_DROP_EVENT_NAME).toBe('kojo:drag-drop');
  });

  it('大写扩展名 / CJK 名 / 带空格路径 / 无目录段都放行', () => {
    const paths = [
      'C:\\game\\sub-modding\\M_KOJO_K4.ERB',
      'D:\\作者工作区\\我的作品\\事件.kojo',
      'C:\\a b erm 文件.erm',
      'readme.md',
      'notes.txt',
    ];
    expect(classifyDrop(paths).files).toEqual(paths);
    expect(classifyDrop(paths).rejected).toEqual([]);
  });

  it('大小写不敏感', () => {
    expect(classifyDrop(['README.MD', 'a.TxT', 'b.Kojo']).files).toEqual(['README.MD', 'a.TxT', 'b.Kojo']);
  });

  it('打不开的三类：存档文件 / 无扩展名 / 未知类型 / 伪装扩展名，reason 是人话', () => {
    const { files, rejected } = classifyDrop(['save.sav', '无扩展名', 'x.exe', 'x.~kojo']);
    expect(files).toEqual([]);
    expect(rejected.map((r) => r.path)).toEqual(['save.sav', '无扩展名', 'x.exe', 'x.~kojo']);
    for (const r of rejected) {
      expect(r.reason).toBe(UNKNOWN_FILE_REASON);
      expect(r.reason).not.toMatch(/白名单|MIME|扩展名/);
    }
  });

  it('混合输入：files 与 rejected 各自保持拖入顺序', () => {
    const { files, rejected } = classifyDrop([
      'D:\\x\\a.erm',
      'shooter.exe',
      'C:\\y\\事件.kojo',
      'readme.md',
      'noext',
      'b.txt',
    ]);
    expect(files).toEqual(['D:\\x\\a.erm', 'C:\\y\\事件.kojo', 'readme.md', 'b.txt']);
    expect(rejected.map((r) => r.path)).toEqual(['shooter.exe', 'noext']);
  });

  it('整名以点开头视为无扩展名（.kojo 这种点文件不是口上文件）', () => {
    expect(classifyDrop(['.kojo']).rejected[0]?.reason).toBe(UNKNOWN_FILE_REASON);
  });
});

describe('nextDropOverlay：覆盖提示状态机', () => {
  const ev = (type: DropOverlayEvent['type']): DropOverlayEvent => ({ type });

  it('enter/over 显示，leave/drop 隐藏', () => {
    expect(nextDropOverlay('hidden', ev('enter'))).toBe('shown');
    expect(nextDropOverlay('hidden', ev('over'))).toBe('shown');
    expect(nextDropOverlay('shown', ev('leave'))).toBe('hidden');
    expect(nextDropOverlay('shown', ev('drop'))).toBe('hidden');
  });

  it('over 连发幂等：已 shown 时值不变（setState 同值即不重渲染，拖一次不该闪几十屏）', () => {
    let s: DropOverlayState = nextDropOverlay('hidden', ev('enter'));
    for (let i = 0; i < 50; i++) {
      const next = nextDropOverlay(s, ev('over'));
      expect(next).toBe(s);
      s = next;
    }
    expect(s).toBe('shown');
  });

  it('leave 后 over 能重新显示；drop 收敛到 hidden', () => {
    let s = nextDropOverlay('shown', ev('leave'));
    expect(s).toBe('hidden');
    s = nextDropOverlay(s, ev('over'));
    expect(s).toBe('shown');
    s = nextDropOverlay(s, ev('drop'));
    expect(s).toBe('hidden');
    // 隐藏态再收 leave 也不翻花（两向都幂等）
    expect(nextDropOverlay(s, ev('leave'))).toBe('hidden');
  });
});

/** 假 io：记录每一次调用序列；writeText/readText/exportFile 若被碰过就是红线 */
function fakeIo(opts: { dirs?: string[]; missing?: string[] } = {}) {
  const calls: string[] = [];
  const dirs = new Set(opts.dirs ?? []);
  const missing = new Set(opts.missing ?? []);
  const stat = vi.fn(async (p: string) => {
    calls.push(`stat:${p}`);
    if (missing.has(p)) return null;
    return { size: 1, mtimeMs: 0, isDirectory: dirs.has(p) };
  });
  const writeText = vi.fn(async (p: string) => {
    calls.push(`writeText:${p}`);
  });
  const readText = vi.fn();
  const exportFile = vi.fn();
  return { io: { stat, writeText, readText, exportFile }, calls };
}

describe('splitByStat：stat 三态拆分', () => {
  it('失踪 / 目录 / 文件三态各归各位，且保持拖入顺序', async () => {
    const f = fakeIo({ dirs: ['D:\\b'], missing: ['C:\\c'] });
    const split = await splitByStat(['A:\\a.kojo', 'D:\\b', 'C:\\c', 'D:\\d.erm'], f.io);
    expect(split.directories).toEqual(['D:\\b']);
    expect(split.files).toEqual(['A:\\a.kojo', 'D:\\d.erm']);
    expect(split.unreadable).toEqual(['C:\\c']);
  });

  it('空输入 → 三组全空（不抛）', async () => {
    const f = fakeIo();
    expect(await splitByStat([], f.io)).toEqual({ directories: [], files: [], unreadable: [] });
    expect(f.io.writeText).not.toHaveBeenCalled();
  });
});

describe('routeDroppedPaths：文件夹即项目入口', () => {
  /** 宿主路由的替身：所有动作都记进 f.calls，断言顺序即断言行为 */
  function routingOf(f: ReturnType<typeof fakeIo>, over: Partial<DropRouting> = {}): DropRouting {
    return {
      io: f.io,
      paths: [],
      projectOpen: false,
      hasUnsavedChanges: false,
      currentProjectDir: null,
      openFile: (p) => f.calls.push(`open:${p}`),
      openProject: (d) => f.calls.push(`openProject:${d}`),
      reloadProject: () => f.calls.push('reload'),
      notify: (m) => f.calls.push(`notify:${m}`),
      ...over,
    };
  }

  const noticesOf = (calls: readonly string[]): string[] => calls.filter((c) => c.startsWith('notify:'));

  it('欢迎页拖一个文件夹 = 直接开项目，零打扰', async () => {
    const f = fakeIo({ dirs: ['D:\\我的游戏'] });
    await routeDroppedPaths(routingOf(f, { paths: ['D:\\我的游戏'] }));
    expect(f.calls).toEqual(['stat:D:\\我的游戏', 'openProject:D:\\我的游戏']);
  });

  it('欢迎页拖文件：不开项目，逐文件给 gate 理由聚一条通知', async () => {
    const f = fakeIo();
    await routeDroppedPaths(routingOf(f, { paths: ['a.kojo', 'x.exe'] }));
    expect(f.calls.some((c) => c.startsWith('openProject:'))).toBe(false);
    const notices = noticesOf(f.calls);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('a.kojo');
    expect(notices[0]).toContain('x.exe');
    expect(notices[0]).toContain(PROJECT_GATE_MESSAGE);
  });

  it('欢迎页多目录 + 文件：第一个生效，其余目录与文件聚成一条通知', async () => {
    const f = fakeIo({ dirs: ['D:\\A', 'D:\\B'] });
    await routeDroppedPaths(routingOf(f, { paths: ['D:\\A', 'D:\\B', 'x.exe'] }));
    expect(f.calls).toContain('openProject:D:\\A');
    expect(f.calls).not.toContain('openProject:D:\\B');
    const notices = noticesOf(f.calls);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(ONE_DIRECTORY_REASON);
    expect(notices[0]).toContain('x.exe');
    expect(notices[0]).toContain(PROJECT_GATE_MESSAGE);
  });

  it('项目态拖不同目录、无脏 → 切项目（不是重载）', async () => {
    const f = fakeIo({ dirs: ['D:\\新项目'] });
    await routeDroppedPaths(
      routingOf(f, {
        paths: ['D:\\新项目'],
        projectOpen: true,
        currentProjectDir: 'D:\\旧项目',
      }),
    );
    expect(f.calls).toEqual(['stat:D:\\新项目', 'openProject:D:\\新项目']);
  });

  it('项目态有脏标签拖新目录 → 拒切并给一句人话，不静默也不弹确认', async () => {
    const f = fakeIo({ dirs: ['D:\\新项目'] });
    await routeDroppedPaths(
      routingOf(f, {
        paths: ['D:\\新项目'],
        projectOpen: true,
        currentProjectDir: 'D:\\旧项目',
        hasUnsavedChanges: true,
      }),
    );
    expect(f.calls.some((c) => c.startsWith('openProject:') || c === 'reload')).toBe(false);
    const notices = noticesOf(f.calls);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(DIRTY_SWITCH_REASON);
  });

  it('项目态拖当前目录 → 重载（keepView 语义），脏标签也不拦', async () => {
    const f = fakeIo({ dirs: ['D:\\旧项目'] });
    await routeDroppedPaths(
      routingOf(f, {
        paths: ['D:\\旧项目'],
        projectOpen: true,
        currentProjectDir: 'D:\\旧项目',
        hasUnsavedChanges: true,
      }),
    );
    expect(f.calls).toEqual(['stat:D:\\旧项目', 'reload']);
  });

  it('项目态多目录：第一个生效，其余进聚合通知', async () => {
    const f = fakeIo({ dirs: ['D:\\A', 'D:\\B'] });
    await routeDroppedPaths(
      routingOf(f, {
        paths: ['D:\\A', 'D:\\B'],
        projectOpen: true,
        currentProjectDir: 'D:\\现项目',
      }),
    );
    expect(f.calls).toContain('openProject:D:\\A');
    expect(f.calls).not.toContain('openProject:D:\\B');
    const notices = noticesOf(f.calls);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(ONE_DIRECTORY_REASON);
  });

  it('项目态文件混合照旧：可开的按序开标签，坏扩展名聚合一条', async () => {
    const f = fakeIo();
    await routeDroppedPaths(
      routingOf(f, {
        paths: ['a.erm', 'x.exe', 'b.md'],
        projectOpen: true,
        currentProjectDir: 'D:\\p',
      }),
    );
    expect(f.calls.filter((c) => c.startsWith('open:'))).toEqual(['open:a.erm', 'open:b.md']);
    const notices = noticesOf(f.calls);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('x.exe');
    expect(notices[0]).toContain(UNKNOWN_FILE_REASON);
  });

  it('项目态失踪文件不静默：聚合通知给 UNREADABLE 理由', async () => {
    const f = fakeIo({ missing: ['gone.md'] });
    await routeDroppedPaths(routingOf(f, { paths: ['gone.md'], projectOpen: true, currentProjectDir: 'D:\\p' }));
    const notices = noticesOf(f.calls);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(UNREADABLE_REASON);
  });

  it('零写盘自证：路由全程只 stat + 既有打开入口，写方法从未被触碰', async () => {
    const f = fakeIo({ dirs: ['D:\\dir.kojo'], missing: ['gone.md'] });
    await routeDroppedPaths(
      routingOf(f, {
        paths: ['D:\\dir.kojo', 'ok.erb', 'gone.md'],
        projectOpen: true,
        currentProjectDir: 'D:\\p',
      }),
    );
    expect(f.io.writeText).not.toHaveBeenCalled();
    expect(f.io.readText).not.toHaveBeenCalled();
    expect(f.io.exportFile).not.toHaveBeenCalled();
  });

  it('未就绪文案：说人话、不出现内部词', () => {
    expect(NOT_READY_MESSAGE).not.toMatch(/phase|宿主|内核|boot|opening/);
  });
});

describe('processDroppedFiles：文件落地面只读链路', () => {
  it('多文件一次拖＝按拖入顺序逐个开标签；全可开时不打扰（零通知）', async () => {
    const f = fakeIo();
    const opened: string[] = [];
    const notify = vi.fn();
    await processDroppedFiles({
      io: f.io,
      paths: ['D:\\a\\事件.kojo', 'C:\\b\\M_KOJO_K4.ERB', 'readme.md'],
      openFile: (p) => opened.push(p),
      notifyRejections: notify,
    });
    expect(opened).toEqual(['D:\\a\\事件.kojo', 'C:\\b\\M_KOJO_K4.ERB', 'readme.md']);
    expect(notify).not.toHaveBeenCalled();
  });

  it('目录被 stat 剔下：不开标签，聚合通知里给出人话理由', async () => {
    const f = fakeIo({ dirs: ['D:\\我的作品.kojo'] });
    const opened: string[] = [];
    const notices: string[] = [];
    await processDroppedFiles({
      io: f.io,
      paths: ['D:\\我的作品.kojo', 'note.txt'],
      openFile: (p) => opened.push(p),
      notifyRejections: (m) => notices.push(m),
    });
    expect(opened).toEqual(['note.txt']);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('我的作品.kojo');
    expect(notices[0]).toContain(DIRECTORY_REASON);
  });

  it('stat 拿不到（失踪/无权限）归入打不开，不静默丢弃', async () => {
    const f = fakeIo({ missing: ['gone.md'] });
    const opened: string[] = [];
    const notices: string[] = [];
    await processDroppedFiles({
      io: f.io,
      paths: ['gone.md', 'still.md'],
      openFile: (p) => opened.push(p),
      notifyRejections: (m) => notices.push(m),
    });
    expect(opened).toEqual(['still.md']);
    expect(notices[0]).toContain(UNREADABLE_REASON);
  });

  it('零写盘自证：调用序列只有 stat 与 open，writeText/readText/exportFile 从未被触碰', async () => {
    const f = fakeIo({ dirs: ['D:\\dir.erm'], missing: ['gone.txt'] });
    const opened: string[] = [];
    await processDroppedFiles({
      io: f.io,
      paths: ['D:\\dir.erm', 'x.exe', 'ok.erb', 'gone.txt'],
      openFile: (p) => {
        f.calls.push(`open:${p}`);
        opened.push(p);
      },
      notifyRejections: () => {},
    });
    // stat 先行全量三态拆分，再开文件
    expect(f.calls).toEqual([
      'stat:D:\\dir.erm',
      'stat:x.exe',
      'stat:ok.erb',
      'stat:gone.txt',
      'open:ok.erb',
    ]);
    expect(opened).toEqual(['ok.erb']);
    expect(f.io.writeText).not.toHaveBeenCalled();
    expect(f.io.readText).not.toHaveBeenCalled();
    expect(f.io.exportFile).not.toHaveBeenCalled();
  });

  it('聚合通知：一条消息带全部被拒路径名与理由（含文件夹，不再只说"文件"）', () => {
    const msg = formatRejections([
      { path: 'C:\\a\\x.exe', reason: UNKNOWN_FILE_REASON },
      { path: 'D:\\别处', reason: ONE_DIRECTORY_REASON },
    ]);
    expect(msg).toBe(
      `这些没能打开：x.exe（${UNKNOWN_FILE_REASON}）；别处（${ONE_DIRECTORY_REASON}）`,
    );
  });

  it('未打开项目时拖文件的 gate 理由：说人话、不出现内部词', () => {
    expect(PROJECT_GATE_MESSAGE).toContain('游戏目录');
    expect(PROJECT_GATE_MESSAGE).not.toMatch(/phase|宿主|白名单/);
  });
});

describe('subscribeDragDrop 的浏览器降级', () => {
  it('非 Tauri 环境（node/浏览器壳）返回空取消函数，绝不抛', async () => {
    const un = await subscribeDragDrop({
      onEnter: () => {},
      onOver: () => {},
      onLeave: () => {},
      onDrop: () => {},
    });
    expect(typeof un).toBe('function');
    un();
  });
});
