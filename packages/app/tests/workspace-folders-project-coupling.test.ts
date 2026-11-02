/**
 * 工作区根模型的**两态判据**（KW4A 立改前照片 · KW4C 解闸同日翻新，2026-11-02）。
 *
 * ① 那一组已在 KW4C 解闸批翻成**正面照**（没有游戏项目也交根，判据只有一份，分支收在
 *    会话侧）；②③④ 里仍留着**尚未搬走的闸**——每一格都写清是哪一批改的、下一批动哪一行，
 *    不许静默删。
 *
 * 五组判据：
 * ① **会话两态**（有游戏现场 / 只有口上作品）：模型层与 React 接线在两态各交什么、
 *    监视腿的闸现在认的是**会话**（`sessionRoot`）而不是 `project`；
 * ② **纯判据层的真实形态**：`buildWorkspaceFolders` 对"没有游戏根"本来就答得出来
 *    （缺省 = 交空串，逐字相同）——KW4A 只把类型从必填放宽为可选，判据没动；
 * ③ **五条消费者逐条取根快照**（监视 / 树 / Ctrl+P / 检索 / 整项目诊断）＋各腿自己那道
 *    `project` 闸（静态读源，口径照 `update-wiring.test.ts`）；
 * ④ **面板归属与欢迎页回路**：「我的口上项目」由各 adapter 各注册一枚，壳层内建视图
 *    住在 `ProjectView`；欢迎页一键重开**不再**绕游戏现场（KW4C 段③：点作品直接进
 *    作品会话，`gameRoot` 只剩历史键）。
 *
 * ⚠️ 解闸批读到本文件的静态闸时**不要静默删**：那些 `toContain` 钉的就是你要拆的闸门，
 *    拆掉一处就把那一格改成"新的形状"并写清是哪一批改的（同 `update-wiring.test.ts` 的纪律）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Kernel } from '@kojo/kernel';
import type { GameProject } from '@kojo/plugin-api';
import {
  browsableRootsOf,
  buildWorkspaceFolders,
  gameRootOf,
  kojoDomainGapNotice,
  quickOpenRootsOf,
  scanRootsOf,
  searchRootsOf,
  sessionDisplayRootOf,
  sessionWorkspaceRootOf,
  topLevelRootFolders,
  watchRootsOf,
  workspaceFoldersOf,
  workspaceGapNotice,
  workspaceGapsOf,
  type WorkspaceFolder,
} from '../src/ui/workspace-folders';
import { filterGameScopedPanels, gameScopeByPlugin } from '../src/ui/layout';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');
/** 跨包取证：面板注册在 adapter 那侧，闸门必须看得见是谁装的 */
const readPlugin = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../plugins/${rel}`, import.meta.url)), 'utf8');

const GAME_ROOT = 'C:/Game';
const KOJO = 'C:/Game/ERB';
const SAV = 'C:/Game/sav';
const WORK_ROOT = 'C:/Users/dev/AppData/Roaming/dev.kojo.editor/workspaces';
const EXTRA = 'D:/参考口上';

/** 今日形状：五条根齐全的项目会话输入（与 `workspace-folders.test.ts` 同一组常数口径） */
const withProject = {
  projectRoot: GAME_ROOT,
  kojoPaths: [KOJO],
  savDir: SAV,
  authorDirs: [WORK_ROOT],
  extraRoots: [EXTRA],
};

/** 无游戏项目时唯一还剩的两类根（作者作品目录 + 会话附加根） */
const authorOnly = { authorDirs: [WORK_ROOT], extraRoots: [EXTRA] };

const kernelWith = (projectDirs: () => string[]): Pick<Kernel, 'workspaces'> =>
  ({ workspaces: { projectDirs } as unknown as Kernel['workspaces'] });

const project = {
  rootDir: GAME_ROOT,
  adapterId: 'eratw',
  kojoPaths: [KOJO],
  savDir: SAV,
  charaIndex: new Map(),
} as unknown as GameProject;

/** 快照口径：`role:label@path` 一行一格，改没改根表一眼看得出 */
const shot = (folders: readonly WorkspaceFolder[]): string[] =>
  folders.map((f) => `${f.role}:${f.label}@${f.path}`);

describe('① 会话两态：有没有游戏现场，根表都按同一条判据交根', () => {
  it('有游戏现场（态 A）：五类根齐全，游戏侧三格 + 作者侧两格一张表', () => {
    const folders = workspaceFoldersOf(kernelWith(() => [WORK_ROOT]), project, [EXTRA]);
    expect(shot(folders)).toEqual([
      'game:项目根@C:/Game',
      'game:口上域@C:/Game/ERB',
      `author:workspaces@${WORK_ROOT}`,
      `extra:参考口上@${EXTRA}`,
    ]);
    // 项目根那一格自带身份 ⇒ 消费方要"游戏现场在哪"时问表，不抄 project.rootDir
    expect(folders.filter((f) => f.isProjectRoot).map((f) => f.path)).toEqual([GAME_ROOT]);
    expect(gameRootOf(folders)).toBe(GAME_ROOT);
  });

  it('只有作品（态 B）：作品目录 + 附加根照进表 —— 解闸前这一格是 toEqual([])', () => {
    const folders = workspaceFoldersOf(kernelWith(() => [WORK_ROOT]), null, [EXTRA]);
    expect(shot(folders)).toEqual([`author:workspaces@${WORK_ROOT}`, `extra:参考口上@${EXTRA}`]);
    // 两态**同一判据**：态 B 只是少了游戏侧那三格输入，不是走了另一条分支
    expect(folders.every((f) => f.browsable && f.quickOpen && f.search && f.watch)).toBe(true);
    expect(folders.map((f) => f.writable)).toEqual([true, false]);
    expect(gameRootOf(folders)).toBeNull();
    // 单根显示位仍在表里找得出来（会话根 = 那一枚作品所在的根），不另拼一份根
    expect(sessionDisplayRootOf(folders)).toBe(WORK_ROOT);
  });

  it('两态都不发生第二份根：五条腿在两态各取各的，全部出自同一张表', () => {
    const both = workspaceFoldersOf(kernelWith(() => [WORK_ROOT]), project, [EXTRA]);
    const authorOnly = workspaceFoldersOf(kernelWith(() => [WORK_ROOT]), null, [EXTRA]);
    for (const folders of [both, authorOnly]) {
      for (const roots of [
        watchRootsOf(folders),
        browsableRootsOf(folders),
        quickOpenRootsOf(folders),
        searchRootsOf(folders),
        scanRootsOf(folders),
      ]) {
        // 每一条腿交出的每一枚根，都必须能在表里找到同一写法（没有哪条腿自己补一个根）
        expect(roots.every((r) => folders.some((f) => f.path === r))).toBe(true);
      }
    }
    // 态 B 的取根快照（"静默为空"那两条腿自此有根可走）
    expect(quickOpenRootsOf(authorOnly)).toEqual([WORK_ROOT, EXTRA]);
    expect(searchRootsOf(authorOnly)).toEqual([WORK_ROOT, EXTRA]);
  });

  it('闸门已从 workspace-folders.ts / use-workspace-folders.ts 撤走（正面照，2026-11-02 KW4C）', () => {
    const model = read('ui/workspace-folders.ts');
    expect(model).not.toContain('if (project === null) return [];');
    const hook = read('ui/use-workspace-folders.ts');
    expect(hook).not.toContain('project === null');
    // 接线层吃的是 `project?.rootDir` —— 两态同一行代码，没有 if/else 两份拼根
    expect(hook).toContain('projectRoot: project?.rootDir,');
    expect(hook).toContain('kernel.bus.on(\'workspace.projectCreated\', read)');
  });

  it('监视腿的闸改认「会话」：作品会话也挂 watcher，欢迎页仍然一个也不挂', () => {
    const session = read('ui/use-project-session.ts');
    // KW-4E 段②（2026-11-03）翻新：这条调用**多交一枚会话作品**（第 4 参 `workspaceSession`），
    // 根表才答得出"作品会话的根 = 这一枚作品的目录"。改前三参的旧形状不得以另一种写法回来
    // （那条三参调用正是段② 之前屏上 `workspaces 可写 0` 的成因：表里只有常驻落点根）。
    expect(session).toContain('useWorkspaceFolders(kernel, project, extraRoots, workspaceSession);');
    expect(session).not.toContain('useWorkspaceFolders(kernel, project, extraRoots);');
    expect(session).toContain('if (!kernel || sessionRoot === null) return;');
    expect(session).toContain('void kernel.fileWatch.start(watchRootsOf(workspaceFolders));');
    // 落盘键同源：会话记录按 `sessionRoot` 记，不再各自问 `project`
    expect(session).toContain('root: sessionRoot,');
  });
});

describe('② 纯判据层：没有游戏根也答得出根（KW4A 放宽的只是类型）', () => {
  it('缺省 projectRoot 与交空串逐字相同（push 的空根丢弃早已容下缺省）', () => {
    expect(buildWorkspaceFolders(authorOnly)).toEqual(
      buildWorkspaceFolders({ projectRoot: '', ...authorOnly }),
    );
  });

  it('缺省 projectRoot ⇒ 只交作者作品根 + 附加根，能力一格不缺', () => {
    const folders = buildWorkspaceFolders(authorOnly);
    expect(shot(folders)).toEqual([
      `author:workspaces@${WORK_ROOT}`,
      `extra:参考口上@${EXTRA}`,
    ]);
    expect(folders.every((f) => f.browsable && f.quickOpen && f.search && f.watch)).toBe(true);
    expect(folders.map((f) => f.writable)).toEqual([true, false]);
  });

  it('游戏侧三类根全缺（kojoPaths / savDir 也不交）时模型不抛，只剩作者那一支', () => {
    expect(buildWorkspaceFolders({ projectRoot: undefined, kojoPaths: undefined, savDir: null })).toEqual([]);
    expect(buildWorkspaceFolders({ authorDirs: [WORK_ROOT] })).toHaveLength(1);
  });

  it('有项目那一态与放宽前逐字相同（改前照片：五格快照钉死）', () => {
    expect(shot(buildWorkspaceFolders(withProject))).toEqual([
      'game:项目根@C:/Game',
      'game:口上域@C:/Game/ERB',
      'author:workspaces@C:/Users/dev/AppData/Roaming/dev.kojo.editor/workspaces',
      'extra:参考口上@D:/参考口上',
    ]);
  });
});

describe('③ 五条消费者逐条取根（快照式）', () => {
  const folders = buildWorkspaceFolders(withProject);
  const noModel: WorkspaceFolder[] = []; // 今日"无项目"时五条腿实际拿到的东西

  it('监视腿：有项目交三根；无模型 ⇒ 空数组（腿本身容得下，缺的是会话）', () => {
    expect(watchRootsOf(folders)).toEqual([GAME_ROOT, WORK_ROOT, EXTRA]);
    expect(watchRootsOf(noModel)).toEqual([]);
  });

  it('文件树腿（KW4C 段② 解闸）：只认这张表的 browsable 根，不再自己回落 project.rootDir', () => {
    expect(browsableRootsOf(folders)).toEqual([GAME_ROOT, WORK_ROOT, EXTRA]);
    expect(browsableRootsOf(noModel)).toEqual([]);
    const tree = read('ui/FileTree.tsx');
    // 段② 撤掉了"模型缺席就退回游戏根"那两行——一条腿不许自己补一个根
    expect(tree).not.toContain('return [project.rootDir, ...(extraRoots ?? [])]');
    expect(tree).not.toContain('return browsable.length > 0 ? browsable : [project.rootDir];');
    // 根清单恒出自这张表（游戏会话有游戏根、作品会话有作品根，两态同一行）
    expect(tree).toContain('const fsRoots = useMemo<string[]>(() => browsableRootsOf(folders), [folders]);');
    // 组件入参在类型层放宽成 `| null` ⇒ 无游戏现场也挂得上，口上域那一组改走"显式不可用"
    expect(read('ui/file-tree-types.ts')).toContain('project: GameProject | null;');
  });

  it('Ctrl+P 腿：有项目交口上域 ∪ 作品目录 ∪ 附加根；无模型 ⇒ 候选全空（静默为空）', () => {
    expect(quickOpenRootsOf(folders)).toEqual([KOJO, WORK_ROOT, EXTRA]);
    expect(quickOpenRootsOf(noModel)).toEqual([]);
    const pv = read('ui/ProjectView.tsx');
    expect(pv).toContain('const sourceRoots = useMemo(() => quickOpenRootsOf(workspaceFolders), [workspaceFolders]);');
    // KW4C 段③ 翻新：面板区不再单认游戏项目——`project` 在类型层放宽成 `| null`，
    // 作品会话（无游戏现场）也挂得上这一面；候选根恒出自这张表（与树同一口径）。
    expect(pv).toContain('project: GameProject | null;');
    expect(pv).not.toContain('project: GameProject;\n');
  });

  it('检索腿：有项目交三根；无模型 ⇒ 空根，且既有话术直接写死"请先打开项目"', () => {
    expect(searchRootsOf(folders)).toEqual([GAME_ROOT, WORK_ROOT, EXTRA]);
    expect(searchRootsOf(noModel)).toEqual([]);
    // 非静默的形态已经在了（铁律 4），只是那句话对"只有工作区"的作者不再成立
    expect(read('ui/search-store.ts')).toContain("'没有可检索的根目录（请先打开项目）'");
    expect(read('ui/ProjectView.tsx')).toContain('const searchRoots = useMemo(() => searchRootsOf(workspaceFolders), [workspaceFolders]);');
  });

  it('整项目诊断 / 索引腿：扫描根与 Ctrl+P 同集；无项目时排程器自己 return []', () => {
    expect(scanRootsOf(folders)).toEqual(quickOpenRootsOf(folders));
    expect(scanRootsOf(noModel)).toEqual([]);
    const scan = read('ui/project-scan-schedule.ts');
    expect(scan).toContain('if (!p) return [];');
    expect(scan).toContain('return scanRootsOf(workspaceFoldersOf(kernel, p, opts.extraRoots?.() ?? []));');
    // 糖源枚举（F2 改名 / 改名台账）同一道闸：无项目 ⇒ 交空清单
    expect(read('ui/kojo-source-scan.ts')).toContain('if (!project) return [];');
    expect(read('ui/kojo-source-scan.ts')).toContain('const roots = searchRootsOf(workspaceFoldersOf(kernel, project));');
  });

  it('根表为空（= 不在任何会话里）⇒ 五条腿一律空；有会话就有根（两态见 ①）', () => {
    expect([
      watchRootsOf(noModel),
      browsableRootsOf(noModel),
      quickOpenRootsOf(noModel),
      searchRootsOf(noModel),
      scanRootsOf(noModel),
    ].every((r) => r.length === 0)).toBe(true);
  });
});

describe('④ 面板归属与欢迎页回路（同一道闸的屏上形态）', () => {
  it('「我的口上项目」由各 adapter 各注册一枚，宿主侧一枚都没有', () => {
    const eratw = readPlugin('eratw-adapter/src/plugin.ts');
    const am = readPlugin('eraakumamaid-adapter/src/plugin.ts');
    expect(eratw).toContain("id: 'kojo-projects'");
    expect(am).toContain("id: 'eraakumamaid-kojo-projects'");
    expect(eratw).toContain("title: '我的口上项目'");
    expect(am).toContain("title: '我的口上项目'");
    // 壳层内建视图也在项目态里（ProjectView 的 useMemo），不是无项目可达的面板源
    expect(read('ui/ProjectView.tsx')).toContain('const builtinViews = useMemo<UIPanelContribution[]>');
    expect(read('ui/ShellLayout.tsx')).toContain('[...builtinViews, ...kernel.slots.query(\'ui.panel\')]');
  });

  it('游戏域面板闸在无项目（activeAdapterId=null）时不过闸 ⇒ 面板闸不是这道卡住的', () => {
    const twins = [{ id: 'kojo-projects', pluginId: 'eratw-adapter' }, { id: 'eraakumamaid-kojo-projects', pluginId: 'eraakumamaid-adapter' }];
    const games = gameScopeByPlugin([
      { pluginId: 'eratw-adapter', adapter: { gameId: 'eratw' } },
      { pluginId: 'eraakumamaid-adapter', adapter: { gameId: 'eraakumamaid' } },
    ]);
    expect(filterGameScopedPanels(twins, games, null).map((p) => p.id)).toEqual([
      'kojo-projects',
      'eraakumamaid-kojo-projects',
    ]);
  });

  it('编辑器区两态会话都渲染（游戏 / 作品），欢迎页只在**不在会话**时出现（KW4C 段③ 翻新正面照）', () => {
    // 改前照片钉的是 `phase === 'project' && kernel && project`——那道闸让作品会话
    // 设了 `workspaceSession` 仍落回欢迎页（点一枚作品等于没反应）。段③ 拆闸，
    // 按本文件头纪律翻成正面照：闸认**会话根**，且旧形状不得以另一种写法回来。
    const app = read('ui/App.tsx');
    expect(app).toContain('kernel && editorSurfaceOpen(phase, sessionRoot)');
    expect(app).not.toContain("phase === 'project' && kernel && project");
    // 闸本体（phase 查表一族，与 `visibleProjectError` 同住）：判据 = 会话根
    expect(read('ui/project-error-notice.tsx')).toContain("phase === 'project' && sessionRoot !== null");
  });

  it('欢迎页一键重开**直接进作品会话**，不再依赖记录里的 gameRoot（KW4C 段③）', () => {
    // 改前照片：没有 `gameRoot` 就只能劝作者"先打开游戏目录"——作者碰自己的作品
    // 却要先有一个游戏现场，这正是本系列要消灭的 S 级口径。段③ 撤劝退话：
    const app = read('ui/App.tsx');
    expect(app).not.toContain('这条记录没有留下游戏项目位置');
    expect(app).toContain('openWorkspaceSession(plan.session');
    // 会话归属判据单源在纯函数（点了没清单里 = 一句人话，绝不静默）
    const rwp = read('ui/recent-workspace-projects.ts');
    expect(rwp).toContain('export function planRecentWorkspaceOpen');
    // `gameRoot` 仍是可选历史键（老记录清洗零影响），但只是"当时的照片"，不再是回路条件
    expect(rwp).toContain('gameRoot?: string;');
  });
});

/* ============ ⑤ KW-4E 段②/段③：作品会话的根 = **这一枚作品**（不是常驻落点根） ============ */

/** 常驻落点根下面那一枚作品目录（KW-4E 开工时屏上画的是上面那一格） */
const SESSION_DIR = `${WORK_ROOT}/pmvzgrrm7-bo4du6`;
const SESSION_NAME = '组长验收作品';

describe('⑤ 作品会话的根（KW-4E 段②，2026-11-03）：判据只住这张表', () => {
  it('给了会话作品 ⇒ 作者那一支**只交这一枚作品的目录**，标题用作品名、不是 id', () => {
    const folders = buildWorkspaceFolders({
      authorDirs: [WORK_ROOT],
      extraRoots: [EXTRA],
      sessionWorkspace: { dir: SESSION_DIR, name: SESSION_NAME },
    });
    expect(shot(folders)).toEqual([
      `author:${SESSION_NAME}@${SESSION_DIR}`,
      `extra:参考口上@${EXTRA}`,
    ]);
    // 常驻落点根（盖住会话目录那一格）**不在表里**：它带着"所有作品"的可见性，
    // 而按能力覆盖的外层去嵌套规则本来会把会话目录当场折掉——那正是段③ 屏上 0 的成因
    expect(folders.some((f) => f.path === WORK_ROOT)).toBe(false);
    expect(folders.filter((f) => f.isSessionWorkspaceRoot).map((f) => f.path)).toEqual([SESSION_DIR]);
    expect(sessionWorkspaceRootOf(folders)?.label).toBe(SESSION_NAME);
  });

  it('五条腿在作品会话里都取到那枚作品目录：监视 / 树 / Ctrl+P / 检索 / 整项目诊断同尺', () => {
    const folders = workspaceFoldersOf(
      kernelWith(() => [WORK_ROOT]),
      null,
      [EXTRA],
      { dir: SESSION_DIR, name: SESSION_NAME },
    );
    expect(watchRootsOf(folders)).toEqual([SESSION_DIR, EXTRA]);
    expect(browsableRootsOf(folders)).toEqual([SESSION_DIR, EXTRA]);
    expect(quickOpenRootsOf(folders)).toEqual([SESSION_DIR, EXTRA]);
    expect(searchRootsOf(folders)).toEqual([SESSION_DIR, EXTRA]);
    expect(scanRootsOf(folders)).toEqual([SESSION_DIR, EXTRA]);
    // 单根显示位 / 窗口标题的原点：作品会话 = 这一枚作品（不是 workspaces/、也不是 id）
    expect(sessionDisplayRootOf(folders)).toBe(SESSION_DIR);
    expect(gameRootOf(folders)).toBeNull();
  });

  it('没给会话作品（游戏会话 / 欢迎页）⇒ 作者那一支逐字旧行为，一枚不多一枚不少', () => {
    const folders = workspaceFoldersOf(kernelWith(() => [WORK_ROOT]), project, [EXTRA]);
    expect(shot(folders)).toEqual([
      'game:项目根@C:/Game',
      'game:口上域@C:/Game/ERB',
      `author:workspaces@${WORK_ROOT}`,
      `extra:参考口上@${EXTRA}`,
    ]);
    expect(folders.some((f) => f.isSessionWorkspaceRoot)).toBe(false);
    // 会话/空串两种"没给"逐字同形（与 ② 那格缺省口径一致，不留第二条分支）
    expect(buildWorkspaceFolders({ ...withProject, sessionWorkspace: null })).toEqual(
      buildWorkspaceFolders(withProject),
    );
    expect(buildWorkspaceFolders({ ...withProject, sessionWorkspace: { dir: '   ' } })).toEqual(
      buildWorkspaceFolders(withProject),
    );
  });

  it('作品名缺席 ⇒ 如实回落目录末段（不编一个名字出来）；尾分隔符照样取得出末段', () => {
    expect(shot(buildWorkspaceFolders({ sessionWorkspace: { dir: SESSION_DIR } }))).toEqual([
      `author:pmvzgrrm7-bo4du6@${SESSION_DIR}`,
    ]);
    expect(shot(buildWorkspaceFolders({ sessionWorkspace: { dir: 'D:/作品/', name: '  ' } }))).toEqual([
      'author:作品@D:/作品/',
    ]);
  });

  it('段③ 那句人话与顶层分组**同一把尺子**：有分组才承诺，没分组就照实说没有', () => {
    const withSession = buildWorkspaceFolders({
      authorDirs: [WORK_ROOT],
      sessionWorkspace: { dir: SESSION_DIR, name: SESSION_NAME },
    });
    // 表里真有顶层分组 ⇒ 承诺那半句（与段② 原文逐字相同，文案只有一处）
    expect(topLevelRootFolders(withSession).map((f) => f.path)).toEqual([SESSION_DIR]);
    expect(kojoDomainGapNotice(withSession)).toBe(workspaceGapNotice('kojoDomain'));
    expect(kojoDomainGapNotice(withSession)).toContain('作品文件都在下面的分组里');
    // 表里一枚顶层分组都没有 ⇒ 换成一句真话，且**不得**再出现那句承诺（屏上不许同时挂谎话）
    const nothing = kojoDomainGapNotice([]);
    expect(nothing).not.toContain('作品文件都在下面的分组里');
    expect(nothing).toContain('没有');
    // 那条"逐条显式不可用"的清单也走同一把尺子（不许另一侧抄静态句子）
    const gaps = workspaceGapsOf(buildWorkspaceFolders({}));
    expect(gaps.find((g) => g.id === 'kojoDomain')?.notice).toBe(nothing);
    // 消费方不另拼判据：FileTree 顶层分组与这句人话都问这张表
    expect(read('ui/FileTree.tsx')).toContain('const rootFolders = useMemo(() => folders.filter((f) => f.role !== \'game\'), [folders]);');
    expect(read('ui/FileTree.tsx')).toContain('kojoDomainGapNotice(folders)');
  });
});
