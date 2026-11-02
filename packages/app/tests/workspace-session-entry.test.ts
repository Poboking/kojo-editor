// @vitest-environment happy-dom
/**
 * KW4C 段③（入口）判据：让「只有口上作品」的会话**真的点得进去**。
 *
 * 这一格钉的是行为，不是形状——三段各管一层：
 * ① 渲染闸 `editorSurfaceOpen`（`project-error-notice.tsx`，phase 查表一族）：
 *    作品会话（project=null、sessionRoot=作品目录）与游戏会话过**同一道闸**进编辑器面；
 *    段③ 之前这里写死 `project`，`openWorkspaceSession` 设了会话仍落回欢迎页——
 *    点一枚口上作品等于没反应（S 级缺陷的入口半边，本批要消灭的那一格）。
 * ② 欢迎页一键重开 `planRecentWorkspaceOpen`（`recent-workspace-projects.ts`）：
 *    点作品 = 直接进作品会话，`gameRoot` 不再参与判据；作品没了 ⇒ 一句人话，绝不静默。
 * ③ 「继续上次会话」回路：落盘记录的 `lastKind`（段① 立的键）决定回哪条路——
 *    作品目录与游戏目录长得一样，**不许拿路径猜**。
 * 另有 happy-dom 真挂载真派发（照 `welcome-recents.test.ts` 的先例）：欢迎页那一行
 * 按下必须把**整条记录**派发出去，且无游戏现场的记录不再被劝退、不再 disabled。
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FileStat, RecentProject } from '@kojo/plugin-api';
import { editorSurfaceOpen } from '../src/ui/project-error-notice';
import { planRecentWorkspaceOpen, type RecentWorkspaceProject } from '../src/ui/recent-workspace-projects';
import {
  emptySessionRecord,
  sanitizeSessionRecord,
  sessionLastKindOf,
  upsertSessionProject,
} from '../src/ui/session-store';
import { WelcomeView, recentStatKey } from '../src/ui/WelcomeView';
import type { AppPhase } from '../src/ui/App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ---------------- ① 渲染闸：两态都进得了编辑器面 ---------------- */

describe('editorSurfaceOpen：会话两态过同一道闸（KW4C 段③ 拆掉写死 project 的那格）', () => {
  it('游戏会话：phase=project + 游戏根 ⇒ 开', () => {
    expect(editorSurfaceOpen('project', 'C:/Game/eraTW')).toBe(true);
  });

  it('作品会话：phase=project + 作品目录（project 半边是 null）⇒ **同样开**——本车的用户可见成果', () => {
    // sessionRoot 由 `project?.rootDir ?? workspaceSession?.dir` 折成；
    // 这一段若回退成旧闸（认 project），点作品就还是欢迎页
    expect(editorSurfaceOpen('project', 'C:/Users/me/AppData/roaming/kojo/workspaces/w-1')).toBe(true);
  });

  it('欢迎页（不在任何会话）⇒ 关：没有现场根就没有编辑器面，不许画半截壳', () => {
    expect(editorSurfaceOpen('project', null)).toBe(false);
  });

  it('boot / welcome / opening 一律关：phase 未到项目态，壳层还没装配完', () => {
    const roots: AppPhase[] = ['boot', 'welcome', 'opening'];
    for (const phase of roots) expect(editorSurfaceOpen(phase, 'C:/Game/eraTW')).toBe(false);
  });
});

/* ---------------- ② 一键重开：直接进作品会话，gameRoot 不参与 ---------------- */

const wsRec = (over: Partial<RecentWorkspaceProject> = {}): RecentWorkspaceProject => ({
  projectId: 'w-1',
  name: '示例作品',
  dir: 'C:/userData/workspaces/w-1',
  openedAt: 1000,
  ...over,
});

describe('planRecentWorkspaceOpen：点一枚最近作品 → 进哪（判据单源、绝不静默）', () => {
  it('还在工作区清单 ⇒ enter；会话的 dir/name 一律取内核**现读**，不抄记录里的旧照片', () => {
    const plan = planRecentWorkspaceOpen(
      { projectId: 'w-1', name: '旧名字' },
      [{ id: 'w-1', name: '新名字' }],
      (id) => `C:/moved/${id}`,
    );
    expect(plan).toEqual({ kind: 'enter', session: { projectId: 'w-1', name: '新名字', dir: 'C:/moved/w-1' } });
  });

  it('不在清单（被删/被移动）⇒ notify 一句人话——点了必须有响（铁律 4），绝不静默 null', () => {
    const plan = planRecentWorkspaceOpen({ projectId: 'w-9', name: '没了的作品' }, [], () => 'C:/x');
    expect(plan.kind).toBe('notify');
    if (plan.kind === 'notify') expect(plan.message).toContain('已不在工作区列表里');
  });

  it('没留 gameRoot 的记录照样进（劝退话已撤）：旧闸要求先有游戏现场，那正是本批消灭的口径', () => {
    const rec = wsRec(); // 无 gameRoot 键
    const plan = planRecentWorkspaceOpen(rec, [{ id: 'w-1', name: rec.name }], () => rec.dir);
    expect(plan.kind).toBe('enter');
  });

  it('留了 gameRoot 的旧记录同样进**作品会话**：重开不再绕游戏项目，gameRoot 只剩历史键', () => {
    const rec = wsRec({ gameRoot: 'C:/Game/eraTW' });
    const plan = planRecentWorkspaceOpen(rec, [{ id: 'w-1', name: rec.name }], () => rec.dir);
    expect(plan).toEqual({ kind: 'enter', session: { projectId: 'w-1', name: rec.name, dir: rec.dir } });
  });
});

/* ---------------- ③ 「继续上次会话」回路：lastKind 决定回哪条路 ---------------- */

describe('lastKind 回路：退出作品会话后「继续上次会话」回到作品会话，不回到游戏项目', () => {
  it('作品会话落盘（kind=workspace）⇒ 读回现场类型是 workspace', () => {
    const rec = upsertSessionProject(emptySessionRecord(), 'C:/userData/workspaces/w-1', {
      tabs: ['C:/userData/workspaces/w-1/a.kojo'],
      active: 'C:/userData/workspaces/w-1/a.kojo',
      pinned: [],
      kind: 'workspace',
    });
    expect(sessionLastKindOf(rec)).toBe('workspace');
    // 回路两半同源：目标根与类型出自**同一份记录**（App 的 resumeSession 据此分流）
    expect(rec.lastRoot).toBe('C:/userData/workspaces/w-1');
  });

  it('游戏会话落盘 ⇒ workspace 那格被显式覆盖回 game（上一枚是作品也不串门）', () => {
    let rec = upsertSessionProject(emptySessionRecord(), 'C:/w/w-1', {
      tabs: ['C:/w/a.kojo'],
      active: null,
      pinned: [],
      kind: 'workspace',
    });
    rec = upsertSessionProject(rec, 'C:/Game/eraTW', { tabs: ['C:/Game/x.ERB'], active: null, pinned: [] });
    expect(sessionLastKindOf(rec)).toBe('game');
  });

  it('老记录没有 lastKind 键 ⇒ 按 game 读，且不补键（逐字零影响）', () => {
    const rec = sanitizeSessionRecord({
      v: 1,
      lastRoot: 'C:/Game/eraTW',
      projects: { 'c:/game/eratw': { tabs: ['C:/Game/x.ERB'], active: null, pinned: [] } },
    });
    expect(sessionLastKindOf(rec)).toBe('game');
    expect('lastKind' in rec).toBe(false);
  });
});

/* ---------------- ④ 欢迎页真挂载真派发（happy-dom，照 welcome-recents 先例） ---------------- */

const wsFile = (path: string, rootDir: string, openedAt = 1000): RecentWorkspaceProject => ({
  projectId: 'w-1',
  name: '示例作品',
  dir: rootDir,
  openedAt,
});

const baseProps = {
  phase: 'welcome' as AppPhase,
  error: null,
  recent: [] as RecentProject[],
  tauri: false,
  kernelReady: true,
  onOpenDirectory: () => {},
  onOpenRecent: () => {},
  onRemoveRecent: () => {},
  onClearRecent: () => {},
  recentFiles: [],
  onOpenRecentFile: () => {},
  recentWorkspaces: [] as readonly RecentWorkspaceProject[],
  onOpenWorkspaceProject: undefined as ((rec: RecentWorkspaceProject) => void) | undefined,
  onRemoveWorkspaceProject: undefined as ((projectId: string) => void) | undefined,
  statPath: (): Promise<FileStat | null> => Promise.resolve({} as FileStat),
  resumeRoot: null,
  onResumeSession: () => {},
  crashRecovery: null,
  onRecoverCrash: () => {},
  onDiscardCrash: () => {},
  closed: false,
  onClose: () => {},
  onOpenTutorial: () => {},
};

describe('WelcomeView · 口上作品行（段③ 上屏口径）', () => {
  let container: HTMLElement;
  let root: Root | null = null;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
    root = null;
  });

  async function mount(props: Partial<typeof baseProps> = {}): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(h(WelcomeView, { ...baseProps, ...props }));
    });
    // 探测是 Promise 落定：再空转一拍让 wsStatCache 写回
    await act(async () => {});
  }

  it('无 gameRoot 的记录：行**不 disabled**、按下把整条记录派发出去（点一枚作品 = 真进会话）', async () => {
    const onOpenWorkspaceProject = vi.fn();
    const rec = wsFile('C:/w/a.kojo', 'C:/userData/workspaces/w-1');
    await mount({ recentWorkspaces: [rec], onOpenWorkspaceProject });
    const open = container.querySelector('.welcome-workspace .welcome-recent-open') as HTMLButtonElement;
    expect(open).toBeTruthy();
    expect(open.disabled).toBe(false);
    // 那一句劝退话不许在这条腿上复活：行的 tooltip 说的是"进作品会话"
    expect(open.getAttribute('title')).toContain('进入「示例作品」');
    await act(async () => {
      open.click();
    });
    expect(onOpenWorkspaceProject).toHaveBeenCalledTimes(1);
    expect(onOpenWorkspaceProject).toHaveBeenCalledWith(rec);
  });

  it('目录已不在（stat 双 null）⇒ 行显式禁用并写明原因，不是点了没反应的静默', async () => {
    await mount({
      statPath: () => Promise.resolve(null),
      recentWorkspaces: [wsFile('x', 'C:/userData/workspaces/gone')],
      onOpenWorkspaceProject: () => {},
    });
    const row = container.querySelector('.welcome-workspace .welcome-recent-row');
    expect(row?.classList.contains('is-missing')).toBe(true);
    const open = row!.querySelector('.welcome-recent-open') as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(open.getAttribute('title')).toContain('已无法重开');
  });

  it('recentStatKey 口径不动（探测缓存键与游戏列表同一族判据，段③ 只是不再拿它当回路条件）', () => {
    expect(recentStatKey({ rootDir: 'C:\\Game', lastOpenedAt: 1 } as RecentProject)).toBe(
      recentStatKey({ rootDir: 'c:/game', lastOpenedAt: 1 } as RecentProject),
    );
  });
});
