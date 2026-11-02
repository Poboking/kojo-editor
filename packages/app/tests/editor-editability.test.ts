/**
 * 可写性判据单测（KW16 标签色轨批 · 第一步"搬家"的那把尺子，2026-11-02）。
 *
 * 钉两件事：
 *  ① **四态映射**：`author / unlocked / derived / read-only` 各由哪条轴成立、谁压过谁；
 *  ② **搬家前后行为逐字相同**：`canEdit` 就是改前那一句 `unlocked || (directMode && isWritable)`
 *     （ADR-0005 两轴合一的轴二读数），短路顺序与 `isWritable` 的调用次数一并钉住——
 *     次数一致才叫"没顺手加一次 IO / 没顺手少问一次"。
 *
 * 环境：node（纯函数 + 假 window 的 localStorage；`livePanes` 只被类型与数组读碰，不起 Monaco）。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  editabilityOf,
  editabilityNow,
  canEditNow,
  notifyEditabilityChange,
  editabilityRevision,
  subscribeEditability,
  RAIL_CLASS,
  type EditabilityAxes,
} from '../src/ui/editor-editability';

const WORKSPACE = 'D:/works/eraTW-口上';
const GAME_ROOT = 'C:/games/eratw';

/** 判据认的那枚内核切片（不手抄结构：从被测函数签名上取） */
type EditabilityKernel = Parameters<typeof canEditNow>[1]['kernel'];

/** 假 kernel：`workspaces.projectDirs()` 给常驻可写根，`io.isWritable` 记调用次数 */
function fakeKernel(opts: { readonly roots?: readonly string[]; readonly writable?: ReadonlySet<string> } = {}) {
  const state = {
    roots: [...(opts.roots ?? [WORKSPACE])],
    writable: new Set(opts.writable ?? []),
    writableCalls: 0,
  };
  const kernel = {
    workspaces: { projectDirs: (): string[] => [...state.roots] },
    io: {
      isWritable: (p: string): boolean => {
        state.writableCalls++;
        return state.writable.has(p);
      },
    },
  };
  return {
    kernel: kernel as unknown as EditabilityKernel,
    /** 会话中途长出作品目录（判据必须现取，不许缓存） */
    addRoot: (root: string): void => void state.roots.push(root),
    writableCalls: (): number => state.writableCalls,
  };
}

/** 假 localStorage（`direct-mode.ts` 在无 window 时回默认关；这里要能手动开门） */
function withDirectMode(on: boolean, run: () => void): void {
  const bag = new Map<string, string>([['kojo.ui.directMode.v1', on ? '1' : '0']]);
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => bag.get(k) ?? null,
      setItem: (k: string, v: string) => void bag.set(k, v),
      removeItem: (k: string) => void bag.delete(k),
    },
  };
  try {
    run();
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
}

const axes = (over: Partial<EditabilityAxes> = {}): EditabilityAxes => ({
  path: `${GAME_ROOT}/script/a.ERB`,
  unlockedPaths: new Set<string>(),
  workspaceRoots: [WORKSPACE],
  directMode: false,
  writable: () => false,
  ...over,
});

describe('editabilityOf · 四态映射（色轨的输入）', () => {
  it('① 作者作品区文件 = `author`（轴一恒可写；未解锁、直连关也照样是这一档）', () => {
    const r = editabilityOf(axes({ path: `${WORKSPACE}/新作.ERB` }));
    expect(r.inWorkspace).toBe(true);
    expect(r.grade).toBe('author');
  });

  it('② 游戏目录 + 本会话已解锁 = `unlocked`（轴二破例，警示档）', () => {
    const path = `${GAME_ROOT}/script/a.ERB`;
    const r = editabilityOf(axes({ path, unlockedPaths: new Set([path]) }));
    expect(r.canEdit).toBe(true);
    expect(r.grade).toBe('unlocked');
  });

  it('②′ 直连开门 + 该路径已获写权限 = 同一档 `unlocked`（轴二的旁路，不是新档位）', () => {
    const path = `${GAME_ROOT}/script/a.ERB`;
    const r = editabilityOf(axes({ path, directMode: true, writable: (p) => p === path }));
    expect(r.canEdit).toBe(true);
    expect(r.grade).toBe('unlocked');
  });

  it('②″ 直连开门但写允许域不放行 = 仍是 `read-only`（直连不扩权，档位不许替内核说谎）', () => {
    const r = editabilityOf(axes({ directMode: true, writable: () => false }));
    expect(r.canEdit).toBe(false);
    expect(r.grade).toBe('read-only');
  });

  it('③ 游戏目录 + 未解锁 = `read-only`（这一档**不给语义色**，见 RAIL_CLASS 没有它）', () => {
    const r = editabilityOf(axes());
    expect(r.canEdit).toBe(false);
    expect(r.inWorkspace).toBe(false);
    expect(r.grade).toBe('read-only');
    expect(RAIL_CLASS).not.toHaveProperty('read-only');
  });

  it('④ 派生只读面（.kojo 预览挂的 model）= `derived`，且排在其余三档之前', () => {
    const game = editabilityOf(axes({ derivedView: true }));
    expect(game.grade).toBe('derived');
    // 预览面本身此刻也可解锁 / 也可在工作区：屏上是派生物这件事优先——色轨说的是"这不是文件本身"
    const unlocked = editabilityOf(
      axes({ path: `${GAME_ROOT}/script/a.ERB`, unlockedPaths: new Set([`${GAME_ROOT}/script/a.ERB`]), derivedView: true }),
    );
    expect(unlocked.grade).toBe('derived');
    const inWorkspace = editabilityOf(axes({ path: `${WORKSPACE}/新作.ERB`, derivedView: true }));
    expect(inWorkspace.grade).toBe('derived');
  });

  it('`derivedView` 只改档位，不改 `canEdit`（搬家口径的锚：判据那一腿一字不动）', () => {
    const withFlag = editabilityOf(axes({ derivedView: true }));
    const withoutFlag = editabilityOf(axes());
    expect(withFlag.canEdit).toBe(withoutFlag.canEdit);
    expect(withFlag.inWorkspace).toBe(withoutFlag.inWorkspace);
    expect(withFlag.grade).toBe('derived');
    expect(withoutFlag.grade).toBe('read-only');
  });

  it('作者区优先于轴二：工作区文件即使被登记进解锁集合也不给警示色（ADR-0005「轴二只管游戏目录那一份」）', () => {
    const path = `${WORKSPACE}/新作.ERB`;
    const r = editabilityOf(axes({ path, unlockedPaths: new Set([path]) }));
    expect(r.grade).toBe('author');
  });
});

describe('editabilityOf · 边界（sav / 预览面 / 不在册路径 / 路径写法）', () => {
  it('存档目录（落在游戏根之内、但不是作者根）= `read-only`，不给色', () => {
    const r = editabilityOf(axes({ path: `${GAME_ROOT}/sav/slot01.dat` }));
    expect(r.inWorkspace).toBe(false);
    expect(r.grade).toBe('read-only');
  });

  it('不在任何根里的路径 = `read-only`（判据不许替未在册的路径作保）', () => {
    const r = editabilityOf(axes({ path: 'Z:/somewhere/else.ERB' }));
    expect(r.grade).toBe('read-only');
  });

  it('空路径 = `read-only`（空态不替任何文件作保，口径同 file-area.ts）', () => {
    expect(editabilityOf(axes({ path: '' })).grade).toBe('read-only');
  });

  it('同前缀邻居不算命中：作者根的 `<根>-备份` 不是工作区（isPathUnder 的分隔符边界）', () => {
    expect(editabilityOf(axes({ path: `${WORKSPACE}-备份/x.ERB` })).grade).toBe('read-only');
  });

  it('根与路径的分隔符写法不同也算同一个根（判等走 pathKey，与状态栏胶囊同源）', () => {
    const r = editabilityOf(
      axes({ workspaceRoots: ['D:\\works\\eraTW-口上'], path: 'D:/works/eraTW-口上/新作.ERB' }),
    );
    expect(r.grade).toBe('author');
  });

  it('作者根嵌在游戏根里时，落在作者根内的文件仍是 `author`（最深根优先，不误判成借阅件）', () => {
    const r = editabilityOf(
      axes({ workspaceRoots: [`${GAME_ROOT}/我的口上`], path: `${GAME_ROOT}/我的口上/a.ERB` }),
    );
    expect(r.grade).toBe('author');
  });
});

describe('canEditNow / editabilityNow = 改前那一句（搬家不改变行为）', () => {
  it('与 `unlocked || (directMode && isWritable)` 逐格同值（四态输入全组合）', () => {
    const path = `${GAME_ROOT}/script/a.ERB`;
    const unlockedCombos = [false, true];
    const directCombos = [false, true];
    const writableCombos = [false, true];
    for (const un of unlockedCombos) {
      for (const dm of directCombos) {
        for (const wr of writableCombos) {
          const expected = un || (dm && wr);
          withDirectMode(dm, () => {
            const { kernel } = fakeKernel({ writable: wr ? new Set([path]) : new Set() });
            const env = { kernel, unlockedPaths: new Set(un ? [path] : []) };
            expect(canEditNow(path, env), `unlocked=${un} direct=${dm} writable=${wr}`).toBe(expected);
            expect(editabilityNow(path, env).canEdit, `同上的档位读数`).toBe(expected);
          });
        }
      }
    }
  });

  it('短路顺序与调用次数逐字相同：命中解锁集合就不问写允许域；直连关着也不问', () => {
    const path = `${GAME_ROOT}/script/a.ERB`;
    withDirectMode(true, () => {
      const hit = fakeKernel({ writable: new Set([path]) });
      expect(canEditNow(path, { kernel: hit.kernel, unlockedPaths: new Set([path]) })).toBe(true);
      expect(hit.writableCalls(), '解锁命中 ⇒ 不该再碰一次 isWritable').toBe(0);
    });
    withDirectMode(false, () => {
      const miss = fakeKernel({ writable: new Set([path]) });
      expect(canEditNow(path, { kernel: miss.kernel, unlockedPaths: new Set() })).toBe(false);
      expect(miss.writableCalls(), '直连关着 ⇒ 也不该碰 isWritable').toBe(0);
    });
    withDirectMode(true, () => {
      const ask = fakeKernel({ writable: new Set() });
      expect(canEditNow(path, { kernel: ask.kernel, unlockedPaths: new Set() })).toBe(false);
      expect(ask.writableCalls(), '直连开着 ⇒ 恰好问一次').toBe(1);
    });
  });

  it('轴一现取不缓存：本会话刚新建的作品目录当场就算作者区（同 workspace-roots.ts 的口径）', () => {
    const fresh = `${WORKSPACE}/新开的作品`;
    const path = `${fresh}/a.ERB`;
    const probe = fakeKernel({ roots: [] });
    // 第一次问：根表还是空的 ⇒ 借阅件
    expect(editabilityNow(path, { kernel: probe.kernel, unlockedPaths: new Set() }).grade).toBe('read-only');
    // 根长出来了（同一个 kernel 引用）⇒ 下一次判定必须立刻认
    probe.addRoot(fresh);
    expect(editabilityNow(path, { kernel: probe.kernel, unlockedPaths: new Set() }).grade).toBe('author');
  });

  it('无 window（node / 测试环境）时直连回默认关，判定不抛（脏数据方向是"少露"）', () => {
    const path = `${GAME_ROOT}/script/a.ERB`;
    const probe = fakeKernel({ writable: new Set([path]) });
    expect((globalThis as { window?: unknown }).window).toBeUndefined();
    expect(canEditNow(path, { kernel: probe.kernel, unlockedPaths: new Set() })).toBe(false);
  });
});

describe('变更门铃（只发"再问一次"，不存判定结果）', () => {
  it('抬一次计数、通知一次订阅者；退订后不再收到', () => {
    const before = editabilityRevision();
    let hits = 0;
    const off = subscribeEditability(() => hits++);
    notifyEditabilityChange();
    expect(hits).toBe(1);
    expect(editabilityRevision()).toBe(before + 1);
    off();
    notifyEditabilityChange();
    expect(hits, '已退订的订阅方不该再被叫醒').toBe(1);
  });
});

/* ---------------- 判据只有一处（结构守门，形态照 readonly-pill.test.ts 的静态尺子） ---------------- */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  walk(SRC);
  return out.sort();
}

const allFiles = sourceFiles();
const relOf = (abs: string): string => path.relative(SRC, abs).replaceAll('\\', '/');
/** 剥掉注释再查：注释里"改前长什么样"的记述不算第二份代码（口径同 `readonly-pill.test.ts`） */
const codeOf = (abs: string): string =>
  readFileSync(abs, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('可写性判据：单一真源（不许冒出抄本）', () => {
  it('两轴合一那句（`解锁集合.has(path) || 直连可编辑`）全 src 只在判据模块里出现一次', () => {
    const hits = allFiles
      .filter((f) => /unlockedPaths\.has\(|\|\|\s*directEditable\(/.test(codeOf(f)))
      .map(relOf);
    expect(hits, '抄本回潮 = 第二真源（标签侧要读的就是这一处）').toEqual(['ui/editor-editability.ts']);
  });

  it('`directEditable` 那枚组件局部闭包已从 src 彻底消失（不是"改名还在"）', () => {
    const hits = allFiles.filter((f) => codeOf(f).includes('directEditable')).map(relOf);
    expect(hits).toEqual([]);
  });

  it('`EditorPane` 只留转调：搬家后组件里问的是 `canEditNow`，不再自己拼表达式', () => {
    const editor = codeOf(path.join(SRC, 'ui/EditorPane.tsx'));
    expect(editor).toContain('canEditAt(');
    // 搬家留下的唯一痕迹 = 转调（`canEditNow` 来自判据模块），不是就地重算
    expect(editor).toContain('canEditNow(p, { kernel, unlockedPaths: unlockedPathsRef.current })');
  });

  it('标签侧不自己判可写性：tab-row / tabs-bar 只吃算好的档位（值 props）', () => {
    for (const file of ['ui/tab-row.tsx', 'ui/tabs-bar.tsx']) {
      const body = codeOf(path.join(SRC, file));
      expect(body, `${file} 不许自己判可写性`).not.toMatch(/isWritable|directEditable|unlockedPaths/);
      expect(body).not.toMatch(/isInWorkspaceFile|fileWritableArea/);
    }
  });

  it('解锁集合的真源仍是一只 ref（登记簿交出去的是同一只壳，没有第二份账）', () => {
    const owners = allFiles
      .filter((f) => /unlockedPathsRef\s*[:=][^\n]*useRef\(/.test(codeOf(f)))
      .map(relOf);
    expect(owners).toEqual(['ui/EditorPane.tsx']);
  });
});
