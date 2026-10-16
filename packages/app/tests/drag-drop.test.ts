import { describe, expect, it, vi } from 'vitest';
import {
  COPY_DIR_UNSUPPORTED_REASON,
  COPY_READONLY_REASON,
  DIRECTORY_REASON,
  DRAG_DROP_EVENT_NAME,
  NOT_READY_MESSAGE,
  ONE_DIRECTORY_REASON,
  OPENABLE_EXT,
  PROJECT_GATE_MESSAGE,
  UNREADABLE_REASON,
  UNKNOWN_FILE_REASON,
  classifyDrop,
  copyDroppedFiles,
  copyExistsReason,
  dragDropImportHintMessage,
  dropTargetDirFrom,
  formatRejections,
  importRequestedPayload,
  isProjectDetectionError,
  nextDropOverlay,
  notGameDirMessage,
  planDropAt,
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

  it('项目态有脏标签拖新目录 → 交给宿主 openProject（脏确认收口在换根守卫）', async () => {
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

  it('项目态拖当前目录 → 重载（keepView 语义），脏标签也不拦', async () => {
    const f = fakeIo({ dirs: ['D:\\旧项目'] });
    await routeDroppedPaths(
      routingOf(f, {
        paths: ['D:\\旧项目'],
        projectOpen: true,
        currentProjectDir: 'D:\\旧项目',
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

/* -------------------- B6：拖文件到树内目录 = 复制进项目 -------------------- */

describe('planDropAt：drop 点 → 计划', () => {
  it('命中目录行 = 复制进该目录', () => {
    expect(planDropAt('D:\\proj\\pkg')).toEqual({ kind: 'copy', targetDir: 'D:\\proj\\pkg' });
  });
  it('未命中（树外/文件行/欢迎页）= 维持 A1 打开语义', () => {
    expect(planDropAt(null)).toEqual({ kind: 'open' });
  });
});

describe('dropTargetDirFrom：向上找最近的目录落点（纯 closest 判定）', () => {
  /** node 环境没有 DOM：用最小替身模拟 elementFromPoint 命中链 */
  const fakeEl = (self: Record<string, unknown> | null, parent: Record<string, unknown> | null) => ({
    closest(selectors: string): unknown {
      if (self && selectors in self) return self;
      if (parent && selectors in parent) return parent;
      return null;
    },
  });

  it('命中的是行内 span，向上爬到挂了 data-drop-dir 的祖先', () => {
    const dirRow = { '[data-drop-dir]': true, dataset: { dropDir: 'D:\\proj\\pkg' } };
    const span = fakeEl({ className: 'tree-dir-name' }, dirRow);
    expect(dropTargetDirFrom(span)).toBe('D:\\proj\\pkg');
  });

  it('命中的就是目录行本体：直接返回', () => {
    const btn = fakeEl({ '[data-drop-dir]': true, dataset: { dropDir: 'C:\\game\\kou' } }, null);
    expect(dropTargetDirFrom(btn)).toBe('C:\\game\\kou');
  });

  it('文件行 / 树外空白：没有目录祖先 → null（落点交给打开语义）', () => {
    const fileRow = { dataset: {} };
    expect(dropTargetDirFrom(fakeEl({ className: 'tree-file' }, fileRow))).toBeNull();
    expect(dropTargetDirFrom(null)).toBeNull();
  });
});

/** 复制链路的假 io：stat（三态拆分）/ statFiles（查重）/ copyFile / isWritable 各司其职 */
function copyIo(opts: {
  dirs?: string[];
  missing?: string[];
  existingTargets?: string[];
  writable?: boolean;
  copyError?: string;
} = {}) {
  const dirs = new Set(opts.dirs ?? []);
  const missing = new Set(opts.missing ?? []);
  const existing = new Set(opts.existingTargets ?? []);
  const stat = vi.fn(async (p: string) => {
    if (missing.has(p)) return null;
    return { size: 1, mtimeMs: 0, isDirectory: dirs.has(p) };
  });
  const statFiles = vi.fn(async (ps: string[]) =>
    ps.map((p) => ({ path: p, exists: existing.has(p), mtimeMs: null, size: null })),
  );
  const copyFile = vi.fn(async (from: string, to: string) => {
    if (opts.copyError) throw new Error(opts.copyError);
    existing.add(to);
  });
  const isWritable = vi.fn(() => opts.writable ?? true);
  return { io: { stat, statFiles, copyFile, isWritable }, copyFile, statFiles, isWritable };
}

describe('copyDroppedFiles：拖文件到目录 = 复制进项目', () => {
  it('多文件复制成功：逐个 copyFile 到 joinPath 的落点，聚合一句「已复制 N 个」，onLanded 一次', async () => {
    const f = copyIo();
    const notes: string[] = [];
    let landed = 0;
    await copyDroppedFiles({
      io: f.io,
      paths: ['C:\\别处\\README.md', 'D:\\素材\\立绘.png'],
      targetDir: 'D:\\proj\\pkg',
      notify: (m) => notes.push(m),
      onLanded: () => {
        landed += 1;
      },
    });
    // README/图片这类非方言扩展名也照拷——复制不看白名单，打开才看
    expect(f.copyFile).toHaveBeenCalledTimes(2);
    expect(f.copyFile).toHaveBeenCalledWith('C:\\别处\\README.md', 'D:\\proj\\pkg/README.md');
    expect(f.copyFile).toHaveBeenCalledWith('D:\\素材\\立绘.png', 'D:\\proj\\pkg/立绘.png');
    expect(landed).toBe(1);
    expect(notes).toEqual(['已复制 2 个文件到「pkg」']);
  });

  it('目录拖进来不复制（递归复制是新功能）：人话拒绝，不静默也不当复制', async () => {
    const f = copyIo({ dirs: ['D:\\一个文件夹'] });
    const notes: string[] = [];
    await copyDroppedFiles({
      io: f.io,
      paths: ['D:\\一个文件夹'],
      targetDir: 'D:\\proj\\pkg',
      notify: (m) => notes.push(m),
      onLanded: () => {},
    });
    expect(f.copyFile).not.toHaveBeenCalled();
    expect(notes[0]).toContain(COPY_DIR_UNSUPPORTED_REASON);
    expect(notes[0]).toContain('一个文件夹');
  });

  it('只读区预检在先：isWritable 为假 → copyFile 一次都不碰，整批人话拒绝，零绕闸', async () => {
    const f = copyIo({ writable: false });
    const notes: string[] = [];
    let landed = 0;
    await copyDroppedFiles({
      io: f.io,
      paths: ['C:\\别处\\a.erm', 'C:\\别处\\b.md'],
      targetDir: 'D:\\proj\\pkg',
      notify: (m) => notes.push(m),
      onLanded: () => {
        landed += 1;
      },
    });
    expect(f.isWritable).toHaveBeenCalledWith('D:\\proj\\pkg');
    expect(f.copyFile).not.toHaveBeenCalled();
    expect(landed).toBe(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(COPY_READONLY_REASON);
    expect(notes[0]).toContain('a.erm');
    expect(notes[0]).toContain('b.md');
  });

  it('防覆盖：目标已有同名文件 → 拒绝且不覆盖，其余照拷（部分成功聚合反馈）', async () => {
    const f = copyIo({ existingTargets: ['D:\\proj\\pkg/README.md'] });
    const notes: string[] = [];
    let landed = 0;
    await copyDroppedFiles({
      io: f.io,
      paths: ['C:\\别处\\README.md', 'C:\\别处\\新事件.erm'],
      targetDir: 'D:\\proj\\pkg',
      notify: (m) => notes.push(m),
      onLanded: () => {
        landed += 1;
      },
    });
    expect(f.copyFile).toHaveBeenCalledTimes(1);
    expect(f.copyFile).toHaveBeenCalledWith('C:\\别处\\新事件.erm', 'D:\\proj\\pkg/新事件.erm');
    expect(landed).toBe(1);
    expect(notes).toHaveLength(2); // 成功一句 + 失败清单一条，各说各话
    expect(notes[0]).toBe('已复制 1 个文件到「pkg」');
    expect(notes[1]).toContain(copyExistsReason('README.md'));
  });

  it('失踪/无权限的拖入项不静默：进失败清单给 UNREADABLE 理由', async () => {
    const f = copyIo({ missing: ['gone.md'] });
    const notes: string[] = [];
    await copyDroppedFiles({
      io: f.io,
      paths: ['gone.md', 'ok.md'],
      targetDir: 'D:\\proj\\pkg',
      notify: (m) => notes.push(m),
      onLanded: () => {},
    });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toBe('已复制 1 个文件到「pkg」');
    expect(notes[1]).toContain(UNREADABLE_REASON);
  });

  it('copyFile 抛错（盘侧失败）：进失败清单带原因，绝不静默', async () => {
    const f = copyIo({ copyError: 'device unreachable' });
    const notes: string[] = [];
    await copyDroppedFiles({
      io: f.io,
      paths: ['C:\\别处\\a.md'],
      targetDir: 'D:\\proj\\pkg',
      notify: (m) => notes.push(m),
      onLanded: () => {},
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('复制失败');
    expect(notes[0]).toContain('device unreachable');
  });

  it('全军覆没（只有被拒项）：不报成功、onLanded 不触发', async () => {
    const f = copyIo({ dirs: ['D:\\文件夹'], missing: ['gone.md'] });
    const notes: string[] = [];
    let landed = 0;
    await copyDroppedFiles({
      io: f.io,
      paths: ['D:\\文件夹', 'gone.md'],
      targetDir: 'D:\\proj\\pkg',
      notify: (m) => notes.push(m),
      onLanded: () => {
        landed += 1;
      },
    });
    expect(f.copyFile).not.toHaveBeenCalled();
    expect(landed).toBe(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(COPY_DIR_UNSUPPORTED_REASON);
    expect(notes[0]).toContain(UNREADABLE_REASON);
  });

  it('文案纪律：只读拒绝是「批准」口径的人话，不出现白名单/域等内部词', () => {
    expect(COPY_READONLY_REASON).toContain('只读');
    expect(COPY_READONLY_REASON).not.toMatch(/白名单|writable|域|断言/);
    expect(copyExistsReason('x.md')).toContain('没有复制');
    expect(copyExistsReason('x.md')).not.toMatch(/stat|exists|白名单/);
  });
});

/* -------------- 检测失败的人话化 + 拖拽顺势引导去导入项目 -------------- */

describe('isProjectDetectionError：只认 name（跨 realm 稳），不做 message 匹配', () => {
  it('name === ProjectDetectionError 命中，即使 message 是英文原文', () => {
    const e = new Error('No registered game adapter recognized the directory: X (candidates: eratw)');
    e.name = 'ProjectDetectionError';
    expect(isProjectDetectionError(e)).toBe(true);
  });

  it('普通错误 / null / 字符串 / 恰好 message 含该词但 name 不对 → 一律 false', () => {
    expect(isProjectDetectionError(new Error('boom'))).toBe(false);
    expect(isProjectDetectionError(null)).toBe(false);
    expect(isProjectDetectionError(undefined)).toBe(false);
    expect(isProjectDetectionError('ProjectDetectionError')).toBe(false);
    const trap = new Error('ProjectDetectionError');
    expect(isProjectDetectionError(trap)).toBe(false);
  });
});

describe('检测失败文案：内部英文术语绝不上屏，取目录末段做人话', () => {
  const dir = 'C:\\Users\\123\\Desktop\\蛙蛙投稿';

  it('其它入口（对话框/recent）：只人话化报错，含末段名，无内部术语、不点名具体游戏（壳层零游戏名词）', () => {
    const msg = notGameDirMessage(dir);
    expect(msg).toContain('蛙蛙投稿');
    expect(msg).toContain('游戏目录');
    expect(msg).not.toMatch(/No registered game adapter|candidates|adapter|ProjectDetectionError/i);
    expect(msg).not.toMatch(/eratw|eraK|eraSQN|eraNAS/i);
  });

  it('拖拽路径：引导去「导入项目」向导的人话，含末段名，无内部术语', () => {
    const msg = dragDropImportHintMessage(dir);
    expect(msg).toContain('蛙蛙投稿');
    expect(msg).toContain('导入项目');
    expect(msg).not.toMatch(/No registered game adapter|candidates|adapter|ProjectDetectionError/);
  });
});

describe('importRequestedPayload：口径对齐 kojo.importKojoProject 命令', () => {
  it('普通目录：sourceDir 原样 + suggestedName 取末段 + source=drag-drop', () => {
    expect(importRequestedPayload('C:\\Users\\123\\Desktop\\蛙蛙投稿')).toEqual({
      sourceDir: 'C:\\Users\\123\\Desktop\\蛙蛙投稿',
      suggestedName: '蛙蛙投稿',
      source: 'drag-drop',
    });
  });

  it('根目录（无末段）：不带 suggestedName 键，绝不让空串混进载荷', () => {
    const payload = importRequestedPayload('C:\\');
    expect(payload).toEqual({ sourceDir: 'C:\\', source: 'drag-drop' });
    expect('suggestedName' in payload).toBe(false);
  });
});
