/**
 * 「口上工作区是二等公民」的**改前照片**（KW4A 取证批，2026-11-02）。
 *
 * 本文件不钉愿望，只钉今日形状：作者要碰自己的作品，必须先打开一个游戏目录。
 * 这张耦合此前只散在读得到的代码里，没有任何一枚测试把它写成事实——所以解闸批
 * 一旦动到根模型，谁都不知道哪些腿会跟着变。这里逐条留影，供后续重构对照。
 *
 * 四组判据：
 * ① **模型层的硬闸**：`workspaceFoldersOf(kernel, null)` / `useWorkspaceFolders` 在
 *    `project === null` 时直接交空表，哪怕内核里明明有作品目录、会话里有附加根；
 * ② **纯判据层的真实形态**：`buildWorkspaceFolders` 对"没有游戏根"本来就答得出来
 *    （缺省 = 交空串，逐字相同）——KW4A 只把类型从必填放宽为可选，判据没动；
 * ③ **五条消费者逐条取根快照**（监视 / 树 / Ctrl+P / 检索 / 整项目诊断）＋各腿自己那道
 *    `project` 闸（静态读源，口径照 `update-wiring.test.ts`）；
 * ④ **面板归属与欢迎页回路**：「我的口上项目」由各 adapter 各注册一枚，壳层内建视图
 *    住在 `ProjectView`（也在项目态里），欢迎页一键重开靠记录里的 `gameRoot`。
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
  quickOpenRootsOf,
  scanRootsOf,
  searchRootsOf,
  watchRootsOf,
  workspaceFoldersOf,
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

describe('① 模型层的硬闸：没有游戏项目 ⇒ 根集合一张也不交', () => {
  it('workspaceFoldersOf：project=null 时先于任何判据返回空表（作品目录 / 附加根都拿不到）', () => {
    // 这一格是"二等公民"的第一现场：内核明明交得出作品目录，模型却答"没有根"
    expect(workspaceFoldersOf(kernelWith(() => [WORK_ROOT]), null, [EXTRA])).toEqual([]);
    // 对照：同一份输入加上游戏项目，作者根与附加根立刻进表 ⇒ 少的不是判据，是会话
    const withP = workspaceFoldersOf(kernelWith(() => [WORK_ROOT]), project, [EXTRA]);
    expect(withP.some((f) => f.role === 'author')).toBe(true);
    expect(withP.some((f) => f.role === 'extra')).toBe(true);
  });

  it('接线闸门的位置就在 workspace-folders.ts 自己身上（解闸批的第一处要动的行）', () => {
    expect(read('ui/workspace-folders.ts')).toContain('if (project === null) return [];');
    // React 侧同一道闸（消费方是树 / Ctrl+P / 检索 / 诊断，见 ProjectView）
    const hook = read('ui/use-workspace-folders.ts');
    expect(hook).toContain('project === null');
    expect(hook).toContain('projectRoot: project.rootDir,');
  });

  it('根模型挂在项目会话上：use-project-session 是唯一给监视腿喂根的地方', () => {
    const session = read('ui/use-project-session.ts');
    expect(session).toContain('const workspaceFolders = useWorkspaceFolders(kernel, project, extraRoots);');
    expect(session).toContain('if (!kernel || !project) return;');
    expect(session).toContain('void kernel.fileWatch.start(watchRootsOf(workspaceFolders));');
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

  it('文件树腿：有项目交三根；无模型 ⇒ 空数组，但 FileTree 自己回落 project.rootDir', () => {
    expect(browsableRootsOf(folders)).toEqual([GAME_ROOT, WORK_ROOT, EXTRA]);
    expect(browsableRootsOf(noModel)).toEqual([]);
    const tree = read('ui/FileTree.tsx');
    // 这一格是"树这条腿今天炸"的实证：模型缺席就退回游戏根，而不是退回作品根
    expect(tree).toContain('if (folders.length === 0) return [project.rootDir, ...(extraRoots ?? [])];');
    expect(tree).toContain('return browsable.length > 0 ? browsable : [project.rootDir];');
    // 组件入参在类型层就要一枚 GameProject（不是 `| null`）⇒ 无项目连挂都挂不上
    expect(read('ui/file-tree-types.ts')).toContain('project: GameProject;');
  });

  it('Ctrl+P 腿：有项目交口上域 ∪ 作品目录 ∪ 附加根；无模型 ⇒ 候选全空（静默为空）', () => {
    expect(quickOpenRootsOf(folders)).toEqual([KOJO, WORK_ROOT, EXTRA]);
    expect(quickOpenRootsOf(noModel)).toEqual([]);
    const pv = read('ui/ProjectView.tsx');
    expect(pv).toContain('const sourceRoots = useMemo(() => quickOpenRootsOf(workspaceFolders), [workspaceFolders]);');
    expect(pv).toContain('project: GameProject;'); // 宿主面板区本身也在项目态里
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

  it('无模型时五条腿交出的根一律为空 ⇒ "没有游戏项目 = 没有工作区根"是今日事实', () => {
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

  it('编辑器区（含侧栏面板）只在项目态渲染：欢迎页拿不到面板', () => {
    expect(read('ui/App.tsx')).toContain("phase === 'project' && kernel && project");
  });

  it('欢迎页一键重开依赖记录里的 gameRoot，缺了就只说一句"先去打开游戏目录"', () => {
    expect(read('ui/recent-workspace-projects.ts')).toContain('gameRoot?: string;');
    const app = read('ui/App.tsx');
    expect(app).toContain('gameRoot: rootDirRef.current ?? undefined');
    expect(app).toContain('这条记录没有留下游戏项目位置');
  });
});
