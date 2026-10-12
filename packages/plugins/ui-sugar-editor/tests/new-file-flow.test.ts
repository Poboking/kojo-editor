/**
 * 「新建口上文件」落盘编排单测（2026-10-13 用户反馈 3 批）。
 *
 * 为什么不测向导组件而测这个模块：向导是 `createElement` 面板，插件包的
 * devDeps 只有 react（无 react-dom），点不了按钮；而反馈 3 真正容易坏的东西
 * 全在这里——**挂起意图与关联号的配对**、不覆盖、对话框取消不算失败、
 * 自动落盘失败要把作者请回来。这些都不需要渲染面板。
 *
 * 最该钉死的一条（安全语义）：作者取消新建项目之后，**下一次无关的创建
 * 绝不能**冒出一个他没要过的文件。见「号不匹配」那组用例。
 */

import { describe, expect, it, vi } from 'vitest';
import type { FileIO, Logger, WorkspaceProject, WorkspaceService } from '@kojo/plugin-api';
import { createNewFileFlow, latestArtifact, type KojoFileDraft } from '../src/new-file-flow';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const DRAFT: KojoFileDraft = { fileName: 'M_KOJO_K1_破空.kojo', text: '; 灵梦（1） · 破空\n角色: 1\n' };

function artifact(dirName: string, createdAt: number, id = dirName) {
  return { id, name: dirName, dirName, meta: {}, createdAt };
}

function project(id: string, artifacts: ReturnType<typeof artifact>[]): WorkspaceProject {
  return {
    id,
    name: `《${id}》`,
    createdAt: 1,
    updatedAt: 2,
    artifacts,
    meta: {},
  };
}

interface Harness {
  files: Map<string, string>;
  flow: ReturnType<typeof createNewFileFlow>;
  writes: string[];
  reveals: string[];
  opens: Array<{ token: string }>;
  reopens: number;
  notifies: number;
}

/**
 * 假 io / 假 workspaces：只实现本模块用到的那几个方法，
 * 其余按 `as unknown as` 收窄（与 adapter 侧测试同款做法）。
 */
function makeHarness(opts: {
  projects?: WorkspaceProject[];
  listError?: string;
  writable?: boolean;
  exportResult?: string | null;
  exportError?: string;
  writeError?: string;
} = {}): Harness {
  const files = new Map<string, string>();
  const writes: string[] = [];
  const reveals: string[] = [];
  const opens: Array<{ token: string }> = [];
  let reopens = 0;
  let notifies = 0;

  const io = {
    exists: async (p: string) => files.has(p),
    isWritable: () => opts.writable !== false,
    writeText: async (p: string, text: string) => {
      if (opts.writeError) throw new Error(opts.writeError);
      writes.push(p);
      files.set(p, text);
    },
    exportFile: async (fileName: string, bytes: Uint8Array) => {
      if (opts.exportError) throw new Error(opts.exportError);
      // ignoreBOM：默认 false 时 TextDecoder 会**吃掉**开头那个 BOM——
      // 那正好是要验的东西，不能让替身替它消化掉。
      files.set(`/picked/${fileName}`, new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes));
      return opts.exportResult === undefined ? `/picked/${fileName}` : opts.exportResult;
    },
  } as unknown as FileIO;

  const workspaces = {
    rootDir: () => '/appdata/workspaces',
    list: async () => {
      if (opts.listError) throw new Error(opts.listError);
      return opts.projects ?? [];
    },
    get: async (id: string) => (opts.projects ?? []).find((p) => p.id === id) ?? null,
    projectDir: (id: string) => `/appdata/workspaces/${id}`,
  } as unknown as WorkspaceService;

  const flow = createNewFileFlow({
    io,
    workspaces,
    log,
    reveal: (path) => reveals.push(path),
    openProjectWizard: (token) => opens.push({ token }),
    reopenWizard: () => {
      reopens += 1;
    },
  });
  // notify 计数：状态每变一次，界面就该重渲染一次
  flow.subscribe(() => {
    notifies += 1;
  });

  return {
    get files() {
      return files;
    },
    flow,
    writes,
    reveals,
    opens,
    get reopens() {
      return reopens;
    },
    get notifies() {
      return notifies;
    },
  };
}

/** 取本次 handoff 发出去的关联号（用例里反复要用，且断言"只开门一次"） */
function tokenOfOpen(h: Harness): string {
  expect(h.opens).toHaveLength(1);
  return h.opens[0]!.token;
}

describe('工作区项目列表', () => {
  it('reload 成功：loading 起、落项目、清错误', async () => {
    const h = makeHarness({ projects: [project('w1', [artifact('合集-灵梦 v1.0', 5)])] });
    h.flow.reload();
    expect(h.flow.state().loading).toBe(true);
    await vi.waitFor(() => expect(h.flow.state().loading).toBe(false));
    expect(h.flow.state().error).toBeNull();
    expect(h.flow.state().projects.map((p) => p.id)).toEqual(['w1']);
  });

  it('reload 失败：中文原因进 state（作者看得见，不是只在控制台）', async () => {
    const h = makeHarness({ listError: '工作区目录读不到' });
    h.flow.reload();
    await vi.waitFor(() => expect(h.flow.state().loading).toBe(false));
    expect(h.flow.state().error).toBe('工作区目录读不到');
    expect(h.flow.state().projects).toEqual([]);
  });
});

describe('落点目录推导', () => {
  it('项目目录 + 包目录名', () => {
    const h = makeHarness();
    expect(h.flow.landingDir('w1', artifact('我的合集-灵梦 v1.0', 5))).toBe(
      '/appdata/workspaces/w1/我的合集-灵梦 v1.0',
    );
  });

  it('没有包 / 目录名不是单层 → null（不猜落点）', () => {
    const h = makeHarness();
    expect(h.flow.landingDir('w1', null)).toBeNull();
    expect(h.flow.landingDir('w1', artifact('a/b', 5))).toBeNull();
    expect(h.flow.landingDir('w1', artifact('..', 5))).toBeNull();
    expect(h.flow.landingDir('w1', artifact('', 5))).toBeNull();
  });

  it('默认落点包 = 最近创建的那个（作者的下一步总在刚建好的包里继续）', () => {
    const p = project('w1', [artifact('老包', 1, 'a1'), artifact('新包', 9, 'a2'), artifact('中包', 5, 'a3')]);
    expect(latestArtifact(p)?.id).toBe('a2');
    expect(latestArtifact(null)).toBeNull();
    expect(latestArtifact(project('空', []))).toBeNull();
  });
});

describe('写进工作区（常态路径）', () => {
  it('落盘到包目录并返回绝对路径', async () => {
    const h = makeHarness();
    const r = await h.flow.createIn('/appdata/workspaces/w1/包', DRAFT);
    expect(r).toEqual({ ok: true, path: '/appdata/workspaces/w1/包/M_KOJO_K1_破空.kojo' });
    expect(h.files.get('/appdata/workspaces/w1/包/M_KOJO_K1_破空.kojo')).toBe(DRAFT.text);
  });

  it('同名已存在 → 拒绝且不覆盖（作者的东西不能被工具吃掉）', async () => {
    const h = makeHarness();
    h.files.set('/appdata/workspaces/w1/包/M_KOJO_K1_破空.kojo', '原作者写的口上，一个字都不能少');
    const r = await h.flow.createIn('/appdata/workspaces/w1/包', DRAFT);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('未覆盖');
    expect(h.writes).toEqual([]);
    expect(h.files.get('/appdata/workspaces/w1/包/M_KOJO_K1_破空.kojo')).toBe('原作者写的口上，一个字都不能少');
  });

  it('落点不在可写范围 → 拒（工作区恒可写，走到这里就是项目被挪进了游戏目录）', async () => {
    const h = makeHarness({ writable: false });
    const r = await h.flow.createIn('/game/ERB/包', DRAFT);
    expect(!r.ok && r.reason).toContain('不在可写范围内');
    expect(h.writes).toEqual([]);
  });

  it('文件名带路径段 → 拒（不信任上游拼出来的名字）', async () => {
    const h = makeHarness();
    const r = await h.flow.createIn('/appdata/workspaces/w1/包', { ...DRAFT, fileName: '../逃逸.kojo' });
    expect(!r.ok && r.reason).toContain('不是单层文件名');
    expect(h.writes).toEqual([]);
  });

  it('io 抛错 → 中文原因原样回给界面', async () => {
    const h = makeHarness({ writeError: '磁盘满了' });
    const r = await h.flow.createIn('/appdata/workspaces/w1/包', DRAFT);
    expect(!r.ok && r.reason).toBe('磁盘满了');
  });
});

describe('另存到自选文件夹（反馈 3 a2）', () => {
  it('走 exportFile：内容带 BOM（与工作区 .kojo 同口径），返回落点', async () => {
    const h = makeHarness();
    const r = await h.flow.saveToPickedFolder(DRAFT);
    expect(r).toEqual({ ok: true, path: '/picked/M_KOJO_K1_破空.kojo' });
    expect(h.files.get('/picked/M_KOJO_K1_破空.kojo')).toBe(`\uFEFF${DRAFT.text}`);
  });

  it('对话框里取消 = 不是失败（cancelled 标记，界面不该弹红字）', async () => {
    const h = makeHarness({ exportResult: null });
    const r = await h.flow.saveToPickedFolder(DRAFT);
    expect(!r.ok && r.cancelled).toBe(true);
  });

  it('平台没有对话框能力（Node 桥）→ 原因照实说', async () => {
    const h = makeHarness({ exportError: 'exportFile is not supported by this platform' });
    const r = await h.flow.saveToPickedFolder(DRAFT);
    expect(!r.ok && r.reason).toContain('not supported');
    expect(!r.ok && r.cancelled).toBeUndefined();
  });
});

describe('交给新建项目向导后自动落盘（反馈 3 a1）', () => {
  it('handoff：把内容挂起，并向新建项目向导送出关联号', () => {
    const h = makeHarness();
    h.flow.handoffToNewProject(DRAFT);
    const token = tokenOfOpen(h);
    expect(token.length).toBeGreaterThan(0);
    // 两次请求的号必须不同，否则上一份挂起的会串到这一次的兑现上
    h.flow.handoffToNewProject(DRAFT);
    expect(h.opens[1]!.token).not.toBe(token);
  });

  it('号对上了：写进新项目最新的作者包，并打开它', async () => {
    const created = project('w-new', [artifact('东方口上合集-灵梦 v1.0', 100)]);
    const h = makeHarness({ projects: [created] });
    h.flow.handoffToNewProject(DRAFT);
    const token = tokenOfOpen(h);
    await h.flow.onProjectCreated('w-new', token);
    const path = '/appdata/workspaces/w-new/东方口上合集-灵梦 v1.0/M_KOJO_K1_破空.kojo';
    expect(h.writes).toEqual([path]);
    expect(h.reveals).toEqual([path]);
    expect(h.reopens).toBe(0);
    expect(h.flow.takeNotice()).toBeNull();
  });

  it('号不对（作者取消了那次请求，之后从面板正常新建）：一个字都不写', async () => {
    const created = project('w-new', [artifact('别的项目', 100)]);
    const h = makeHarness({ projects: [created] });
    h.flow.handoffToNewProject(DRAFT);
    await h.flow.onProjectCreated('w-new', '别的会话的号');
    expect(h.writes).toEqual([]);
    expect(h.reveals).toEqual([]);
    // 作废是**一次性**的：紧接着再送一个"看起来对得上"的号也不该再写
    const token = tokenOfOpen(h);
    await h.flow.onProjectCreated('w-new', token);
    expect(h.writes).toEqual([]);
  });

  it('没人在等（向导由面板按钮开的）：不写、也不报错', async () => {
    const h = makeHarness({ projects: [project('w1', [artifact('包', 1)])] });
    await h.flow.onProjectCreated('w1', '随便什么号');
    expect(h.writes).toEqual([]);
    expect(h.flow.takeNotice()).toBeNull();
  });

  it('不带号的创建（导入向导那条新建项目分支）：同样不写', async () => {
    const h = makeHarness({ projects: [project('w1', [artifact('包', 1)])] });
    h.flow.handoffToNewProject(DRAFT);
    await h.flow.onProjectCreated('w1');
    expect(h.writes).toEqual([]);
  });

  it('新项目里没有作者包 → 失败可见：把作者请回向导并说明原因', async () => {
    const h = makeHarness({ projects: [project('w-new', [])] });
    h.flow.handoffToNewProject(DRAFT);
    await h.flow.onProjectCreated('w-new', tokenOfOpen(h));
    expect(h.writes).toEqual([]);
    expect(h.reopens).toBe(1);
    const notice = h.flow.takeNotice();
    expect(notice).toContain('M_KOJO_K1_破空.kojo');
    expect(notice).toContain('还没有作者包');
    // 一次性的：读过就没了，不会下次开向导还挂着
    expect(h.flow.takeNotice()).toBeNull();
  });

  it('自动落盘抛错 → 同样是可见失败，不静默', async () => {
    const h = makeHarness({
      projects: [project('w-new', [artifact('包', 1)])],
      writeError: '目标已存在，未覆盖',
    });
    h.flow.handoffToNewProject(DRAFT);
    await h.flow.onProjectCreated('w-new', tokenOfOpen(h));
    expect(h.reveals).toEqual([]);
    expect(h.reopens).toBe(1);
    expect(h.flow.takeNotice()).toContain('未覆盖');
  });

  it('项目 id 查不到（列表与事件之间被删）→ 按失败交代', async () => {
    const h = makeHarness({ projects: [] });
    h.flow.handoffToNewProject(DRAFT);
    await h.flow.onProjectCreated('w-gone', tokenOfOpen(h));
    expect(h.reopens).toBe(1);
    expect(h.flow.takeNotice()).toContain('还没有作者包');
  });
});

describe('dispose', () => {
  it('卸载后不再持有挂起意图，也不再通知', async () => {
    const h = makeHarness({ projects: [project('w1', [artifact('包', 1)])] });
    h.flow.handoffToNewProject(DRAFT);
    const token = tokenOfOpen(h);
    h.flow.dispose();
    await h.flow.onProjectCreated('w1', token);
    expect(h.writes).toEqual([]);
  });
});
