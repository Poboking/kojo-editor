import { describe, expect, it } from 'vitest';
import type { Kernel } from '@kojo/kernel';
import type { GameProject } from '@kojo/plugin-api';
import {
  browsableRootsOf,
  buildWorkspaceFolders,
  folderOfPath,
  quickOpenRootsOf,
  scanRootsOf,
  searchRootsOf,
  watchRootsOf,
  workspaceFoldersOf,
  type WorkspaceFolder,
} from '../src/ui/workspace-folders';

/**
 * 工作区根模型的判据（WS-04，2026-10-27）。
 *
 * 钉的是"五条消费者共用同一份根表"这件事的**口径**：谁可写、谁进 Ctrl+P、谁进检索、
 * 去重与去嵌套怎么算。这些判据此前散在监视 / 检索 / Ctrl+P / 树 / 整项目诊断五处，
 * 拼法各不相同——作者工作区里的文件「搜得到、树里没有」就是那份差异的直接账单。
 */

const GAME_ROOT = 'C:/Game';
const KOJO = 'C:/Game/ERB';
const SAV = 'C:/Game/sav';
const WORK_ROOT = 'C:/Users/dev/AppData/Roaming/dev.kojo.editor/workspaces';
const WORK_DIR = `${WORK_ROOT}/p1`;
const EXTRA = 'D:/参考口上';

const baseInput = {
  projectRoot: GAME_ROOT,
  kojoPaths: [KOJO],
  savDir: SAV,
  // 作品目录只给落点根：其下的具体作品（`p1`）被祖先覆盖（见"作品目录互相嵌套"那条用例）
  authorDirs: [WORK_ROOT],
  extraRoots: [EXTRA],
};

const byPath = (folders: readonly WorkspaceFolder[], path: string): WorkspaceFolder | undefined =>
  folders.find((f) => f.path === path);

describe('buildWorkspaceFolders · 角色与能力', () => {
  it('五类根各就各位：项目根 / 口上域 / 存档 / 作品目录 / 附加根', () => {
    const folders = buildWorkspaceFolders(baseInput);
    expect(folders.map((f) => `${f.role}:${f.label}`)).toEqual([
      'game:项目根',
      'game:口上域',
      'author:workspaces',
      'extra:参考口上',
    ]);
  });

  it('作品目录可写、附加根只读；游戏侧一律只读', () => {
    const folders = buildWorkspaceFolders(baseInput);
    expect(byPath(folders, WORK_ROOT)!.writable).toBe(true);
    expect(byPath(folders, EXTRA)!.writable).toBe(false);
    expect(byPath(folders, GAME_ROOT)!.writable).toBe(false);
    expect(byPath(folders, KOJO)!.writable).toBe(false);
    // 存档在游戏根里（折掉）；根外的存档同样只读
    expect(buildWorkspaceFolders({ projectRoot: GAME_ROOT, savDir: 'D:/存档' })[1]!.writable).toBe(false);
  });

  it('游戏根整盘不进 Ctrl+P，口上域 / 作品目录 / 附加根进；存档不进检索', () => {
    const folders = buildWorkspaceFolders(baseInput);
    expect(byPath(folders, GAME_ROOT)!.quickOpen).toBe(false);
    expect(byPath(folders, KOJO)!.quickOpen).toBe(true);
    expect(byPath(folders, WORK_ROOT)!.quickOpen).toBe(true);
    expect(byPath(folders, EXTRA)!.quickOpen).toBe(true);
    // 存档在游戏根里（上面那条用例已证明会被折掉）⇒ 这里用一个根外的存档目录看它的能力
    const outside = buildWorkspaceFolders({ projectRoot: GAME_ROOT, savDir: 'D:/存档' });
    expect(byPath(outside, 'D:/存档')).toMatchObject({ role: 'game', search: false, quickOpen: false, watch: true });
  });

  it('监视覆盖五类根（存档也要看——游戏自己会写）', () => {
    const folders = buildWorkspaceFolders(baseInput);
    expect(folders.every((f) => f.watch)).toBe(true);
  });
});

describe('buildWorkspaceFolders · 去重与去嵌套', () => {
  it('同一路径两种写法只留一个根（pathKey 折叠大小写与分隔符）', () => {
    const folders = buildWorkspaceFolders({
      projectRoot: 'C:/Game',
      kojoPaths: ['C:/Game/ERB', 'c:\\game\\erb'],
      authorDirs: ['C:/game/'],
    });
    expect(folders.map((f) => f.role)).toEqual(['author']);
    expect(folders[0]!.path).toBe('C:/game/');
  });

  it('同路径多角色取更具体的那个：作品目录 > 游戏根 > 附加根（可写口径不被只读盖住）', () => {
    const folders = buildWorkspaceFolders({
      projectRoot: 'C:/Game',
      authorDirs: ['C:/Game'],
      extraRoots: ['C:/Game'],
    });
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({ path: 'C:/Game', role: 'author', writable: true });
  });

  it('存档折进游戏根（能力是子集），口上域保留（多一条 Ctrl+P）', () => {
    const folders = buildWorkspaceFolders(baseInput);
    expect(byPath(folders, SAV)).toBeUndefined();
    expect(byPath(folders, KOJO)).toBeDefined();
  });

  it('同前缀邻居不算嵌套：`<根>-备份` 是另一个根', () => {
    const folders = buildWorkspaceFolders({
      projectRoot: 'C:/Game',
      extraRoots: ['C:/Game-备份'],
    });
    expect(folders.map((f) => f.role)).toEqual(['game', 'extra']);
  });

  it('空根 / 非字符串一律丢弃（不许把遍历带成"根为空"）', () => {
    const folders = buildWorkspaceFolders({
      projectRoot: '',
      kojoPaths: ['', KOJO],
      savDir: null,
      authorDirs: [],
      extraRoots: [],
    });
    expect(folders.map((f) => f.path)).toEqual([KOJO]);
  });
});

describe('按能力取根（五条消费者的唯一入口）', () => {
  const folders = buildWorkspaceFolders(baseInput);

  it('监视 / 浏览根含游戏根；内层根被外层覆盖后不再重复交出', () => {
    expect(watchRootsOf(folders)).toEqual([GAME_ROOT, WORK_ROOT, EXTRA]);
    // 口上域与存档都落在游戏根之内 ⇒ 只留游戏根一份（否则同一批文件被监视两遍）
    expect(browsableRootsOf(folders)).toEqual(watchRootsOf(folders));
  });

  it('Ctrl+P 根 = 口上域 ∪ 作品目录 ∪ 附加根（不含整盘游戏根）', () => {
    expect(quickOpenRootsOf(folders)).toEqual([KOJO, WORK_ROOT, EXTRA]);
    // 整项目诊断的扫描根与它同集（能按名找得到的地方就是要扫的地方）
    expect(scanRootsOf(folders)).toEqual(quickOpenRootsOf(folders));
  });

  it('检索根 = 游戏根 ∪ 作品目录 ∪ 附加根；口上域被游戏根覆盖、存档不在检索面', () => {
    expect(searchRootsOf(folders)).toEqual([GAME_ROOT, WORK_ROOT, EXTRA]);
  });

  it('作品目录互相嵌套时只留外层（内层由外层检索覆盖）', () => {
    const nested = buildWorkspaceFolders({ projectRoot: GAME_ROOT, authorDirs: ['C:/w', 'C:/w/p1'] });
    expect(searchRootsOf(nested)).toEqual([GAME_ROOT, 'C:/w']);
    // 内层那条在模型里也折掉了（外层的递归列举已经覆盖它；树因此不会把同一批文件列两组）
    expect(nested.filter((f) => f.role === 'author')).toHaveLength(1);
  });

  it('folderOfPath 命中最深的那个根（文件树给"这一格属于谁"上屏用）', () => {
    expect(folderOfPath(folders, `${WORK_ROOT}/p1/a.ERB`)!.path).toBe(WORK_ROOT);
    expect(folderOfPath(folders, `${GAME_ROOT}/x/y.ERB`)!.path).toBe(GAME_ROOT);
    expect(folderOfPath(folders, 'Z:/别处/x.ERB')).toBeUndefined();
  });
});

describe('workspaceFoldersOf（内核接线：作品目录活读）', () => {
  const project = {
    rootDir: GAME_ROOT,
    adapterId: 'test',
    kojoPaths: [KOJO],
    savDir: SAV,
    charaIndex: new Map(),
  } as unknown as GameProject;

  const kernelWith = (projectDirs: () => string[]): Pick<Kernel, 'workspaces'> =>
    ({ workspaces: { projectDirs } as unknown as Kernel['workspaces'] });

  it('无项目 ⇒ 空模型（欢迎页没有根可谈）', () => {
    expect(workspaceFoldersOf(kernelWith(() => [WORK_ROOT]), null, [EXTRA])).toEqual([]);
  });

  it('每次现读 projectDirs：本会话新建的作品立刻进模型（不缓存）', () => {
    const dirs = [WORK_ROOT];
    const kernel = kernelWith(() => [...dirs]);
    expect(workspaceFoldersOf(kernel, project).filter((f) => f.role === 'author')).toHaveLength(1);
    dirs.push('D:/另一个落点/p2');
    expect(workspaceFoldersOf(kernel, project).filter((f) => f.role === 'author')).toHaveLength(2);
  });

  it('工作区服务不可用（浏览器开发壳）⇒ 作品目录那一支吞成空，其余根照旧', () => {
    const kernel = kernelWith(() => {
      throw new Error('Workspace service is unavailable (no platform data directory)');
    });
    const folders = workspaceFoldersOf(kernel, project, [EXTRA]);
    expect(folders.some((f) => f.role === 'author')).toBe(false);
    expect(quickOpenRootsOf(folders)).toEqual([KOJO, EXTRA]);
  });
});
