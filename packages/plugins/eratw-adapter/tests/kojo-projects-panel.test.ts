import { describe, expect, it, vi } from 'vitest';
import type {
  DirEntry,
  FileIO,
  OverlayContribution,
  PluginContext,
  UIPanelContribution,
  WorkspaceProject,
  WorkspaceService,
} from '@kojo/plugin-api';
import { createEratwAdapterPlugin } from '../src/plugin';
import {
  artifactDir,
  clampTutorialHeight,
  createKojoProjectsPanel,
  factsFromMeta,
  looseProjectDirs,
  packageFacts,
  sortDirEntries,
  TUTORIALS_MIN_H,
  type KojoProjectsPanelDeps,
} from '../src/kojo-projects-panel';
import type { PackageAttribution } from '../src/attribution';
import { NEW_KOJO_PROJECT_OVERLAY_ID } from '../src/new-project-wizard';
import { IMPORT_KOJO_OVERLAY_ID } from '../src/import-wizard';
import { DEPLOY_KOJO_OVERLAY_ID } from '../src/deploy-wizard';
import { DEPLOY_DIFF_OVERLAY_ID } from '../src/deploy-diff-panel';
import {
  KOJO_TUTORIAL_OVERLAY_ID,
  REFERENCE_TUTORIAL_OVERLAY_ID,
  SUGAR_TUTORIAL_OVERLAY_ID,
} from '../src/tutorial-overlay';

/* ------------------------------ 纯函数 ------------------------------ */

describe('目录条目排序（目录在前，名称中文本地化比较）', () => {
  const entry = (name: string, isDirectory: boolean): DirEntry => ({
    name,
    path: `/ws/${name}`,
    isDirectory,
  });

  it('目录恒在文件之前（不看名称）', () => {
    const sorted = sortDirEntries([entry('b.txt', false), entry('甲目录', true), entry('a.txt', false)]);
    expect(sorted.map((e) => e.name)).toEqual(['甲目录', 'a.txt', 'b.txt']);
  });

  it('不修改入参数组（返回新数组）', () => {
    const input = [entry('b', false), entry('a', false)];
    const sorted = sortDirEntries(input);
    expect(sorted).not.toBe(input);
    expect(input.map((e) => e.name)).toEqual(['b', 'a']);
  });
});

describe('包目录路径', () => {
  it('项目目录 + 包目录名（单层拼接）', () => {
    expect(artifactDir('/appdata/workspaces/p1', { dirName: '东方口上-灵梦 v1.0' })).toBe(
      '/appdata/workspaces/p1/东方口上-灵梦 v1.0',
    );
  });
});

/* ------------------------------ 教程区高度钳制（E9 分割线） ------------------------------ */

describe('教程区高度钳制（分割线拖拽）', () => {
  it('区间内原样返回（不偷偷吸附）', () => {
    expect(clampTutorialHeight(200, 800)).toBe(200);
    expect(clampTutorialHeight(TUTORIALS_MIN_H, 800)).toBe(TUTORIALS_MIN_H);
  });

  it('下限兜住内容：拖过头也保留「题头 + 两个入口」的高度', () => {
    expect(clampTutorialHeight(10, 800)).toBe(TUTORIALS_MIN_H);
    expect(clampTutorialHeight(-50, 800)).toBe(TUTORIALS_MIN_H);
  });

  it('上限给树体留可视高度：面板 800 → 上限 600；面板 1000 → 上限 800', () => {
    expect(clampTutorialHeight(999, 800)).toBe(600);
    expect(clampTutorialHeight(999, 1000)).toBe(800);
  });

  it('面板高度未知（≤0）钳到下限——宁可不拖，也不把两区挤没', () => {
    expect(clampTutorialHeight(300, 0)).toBe(TUTORIALS_MIN_H);
    expect(clampTutorialHeight(300, 100)).toBe(TUTORIALS_MIN_H);
  });
});

/**
 * 项目根上「包之外的目录」（UI 反馈 6）。
 *
 * 这条判据盯的是"建完了看不见"：项目行只渲染 workspace.json 登记的包，作者右键项目根
 * 建的平级文件夹因此从来不上树——盘上有、面上无，读起来仍像"点了没生效"。
 * 渲染侧的接线（项目行下面那一块）在真实壳里量（见 IMPLEMENTATION-LOG 本批实机轮），
 * 这里只钉挑法本身，别让"排除谁"变成读代码才知道的口头约定。
 */
describe('项目根的包外目录挑选（反馈 6）', () => {
  const dir = (name: string): DirEntry => ({ name, path: `/ws/${name}`, isDirectory: true });
  const file = (name: string): DirEntry => ({ name, path: `/ws/${name}`, isDirectory: false });

  it('排除与包同名的目录（包本体由包行呈现，列两次会让人以为有两个包）', () => {
    const got = looseProjectDirs([dir('春告げの庭-露米娅 v0.3'), dir('素材')], ['春告げの庭-露米娅 v0.3']);
    expect(got.map((e) => e.name)).toEqual(['素材']);
  });

  it('没有包时全列（新建第一个包之前的起手式同样要能看见自己建的目录）', () => {
    const got = looseProjectDirs([dir('备份'), dir('草稿')], []);
    expect(got.map((e) => e.name)).toEqual(['备份', '草稿']);
  });

  it('只挑目录：根上的散装文件不列（工作区清单 workspace.json 因此天然不进这棵树）', () => {
    const got = looseProjectDirs([file('workspace.json'), file('readme.txt'), dir('素材')], []);
    expect(got.map((e) => e.name)).toEqual(['素材']);
  });

  it('未触发列举 / 在途 / 读失败三种状态都返回空数组（不把"还没读到"当成"没有"）', () => {
    expect(looseProjectDirs(undefined, ['包'])).toEqual([]);
    expect(looseProjectDirs('loading', ['包'])).toEqual([]);
    expect(looseProjectDirs({ error: '拒绝访问' }, ['包'])).toEqual([]);
  });

  it('排序沿用同一条目录序（不自己另排一套，也不退化成磁盘顺序）', () => {
    const input = [dir('乙目录'), dir('甲目录'), dir('a-dir')];
    const got = looseProjectDirs(input, []);
    // 与 sortDirEntries 逐字同序：这条判据不依赖本机 ICU 的拼音实现，只钉"用的是同一把尺子"
    expect(got.map((e) => e.name)).toEqual(sortDirEntries(input).map((e) => e.name));
    expect(got.map((e) => e.name)).not.toEqual(input.map((e) => e.name));
  });

  it('不修改入参（返回新数组）', () => {
    const input = [dir('素材'), file('workspace.json')];
    const got = looseProjectDirs(input, []);
    expect(got).not.toBe(input);
    expect(input).toHaveLength(2);
  });

  it('包名重复出现也不影响判定（Set 语义，不用 includes 逐个比）', () => {
    const got = looseProjectDirs([dir('素材'), dir('包A')], ['包A', '包A']);
    expect(got.map((e) => e.name)).toEqual(['素材']);
  });
});

/* ------------------------------ 包事实行（T2 + 剧本号上树） ------------------------------ */

describe('packageFacts · 一行事实摘要', () => {
  const attr = (over: Partial<PackageAttribution> = {}): PackageAttribution => ({
    author: { value: 'holy', file: 'readme.txt', line: 2 },
    updated: null,
    license: { kind: 'none' },
    readmeFiles: ['readme.txt'],
    ...over,
  });

  it('三项齐全：目标 · 剧本 · 署名摘要按序拼接', () => {
    expect(
      packageFacts({ charaName: '霊夢', scriptNo: 3, attribution: attr() }).join(' · '),
    ).toBe('目标 霊夢 · 剧本3 · 原作者 holy · 未见授权相关文件');
  });

  it('缺项如实不显示，不补「未知」占位（满屏未知比空着更吵）', () => {
    expect(packageFacts({ charaName: null, scriptNo: null, attribution: null })).toEqual([]);
    // 剧本 1 也要显示——它是「指向哪个剧本」的确定事实，不是默认值噪声
    expect(packageFacts({ charaName: null, scriptNo: 1, attribution: null })).toEqual(['剧本1']);
  });

  it('meta 收窄：类型不对或缺失一律归 null，不猜', () => {
    expect(factsFromMeta({ charaName: '霊夢', scriptNo: 2 })).toEqual({ charaName: '霊夢', scriptNo: 2 });
    expect(factsFromMeta({ charaName: '', scriptNo: 0 })).toEqual({ charaName: null, scriptNo: 0 });
    expect(factsFromMeta({ charaName: 123, scriptNo: '3' })).toEqual({ charaName: null, scriptNo: null });
    expect(factsFromMeta({ scriptNo: 1.5 })).toEqual({ charaName: null, scriptNo: null });
    expect(factsFromMeta({})).toEqual({ charaName: null, scriptNo: null });
  });
});

/* ------------------------------ 插件注册形态 ------------------------------ */

interface FakeCtx {
  ctx: PluginContext;
  panels: UIPanelContribution[];
  overlays: OverlayContribution[];
  emits: Array<{ type: string; payload: unknown }>;
  /** 触发某内核事件的插件监听器（如 workspace.importRequested） */
  fire(type: string, payload: unknown): void;
}

function fakeWorkspaces(): WorkspaceService {
  const projects: WorkspaceProject[] = [];
  return {
    rootDir: () => '/appdata/workspaces',
    roots: () => ['/appdata/workspaces'],
    list: async () => projects,
    get: async () => null,
    create: async () => {
      throw new Error('not used');
    },
    update: async () => {
      throw new Error('not used');
    },
    remove: async () => {},
    projectDir: (id: string) => `/appdata/workspaces/${id}`,
    createArtifact: async () => {
      throw new Error('not used');
    },
    importDirectory: async () => {
      throw new Error('not used');
    },
    removeArtifact: async () => {},
    listDir: async () => [],
    readText: async () => {
      throw new Error('not used');
    },
    writeText: async () => {},
  };
}

function activateWithPanel(): FakeCtx {
  const panels: UIPanelContribution[] = [];
  const overlays: OverlayContribution[] = [];
  const emits: Array<{ type: string; payload: unknown }> = [];
  const handlers = new Map<string, (payload: unknown) => void>();
  const io = {
    listDir: async () => [],
  } as unknown as FileIO;
  const ctx = {
    pluginId: 'eratw-adapter',
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    onDispose: () => {},
    bus: {
      emit: (type: string, payload: unknown) => emits.push({ type, payload }),
      on: (type: string, handler: (payload: unknown) => void) => {
        handlers.set(type, handler);
        return () => {};
      },
    },
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return io as unknown as T;
      if (key === 'kernel.workspaces') return fakeWorkspaces() as unknown as T;
      // 新建向导依赖（P-C）：角色表来自当前游戏项目
      if (key === 'kernel.project') return { current: () => null } as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    slots: {
      register: (slot: string, item: UIPanelContribution) => {
        if (slot === 'ui.panel') panels.push(item);
        else if (slot === 'ui.overlay') overlays.push(item as unknown as OverlayContribution);
        return () => {};
      },
    },
  } as unknown as PluginContext;
  createEratwAdapterPlugin().activate(ctx);
  return {
    ctx,
    panels,
    overlays,
    emits,
    fire: (type, payload) => handlers.get(type)?.(payload),
  };
}

describe('「我的口上项目」面板注册（P-B）', () => {
  it('注册 ui.panel：独占活动栏图标（无 group）、sidebar、中文标题', () => {
    const { panels } = activateWithPanel();
    expect(panels).toHaveLength(1);
    const panel = panels[0]!;
    expect(panel.id).toBe('kojo-projects');
    expect(panel.title).toBe('我的口上项目');
    expect(panel.location).toBe('sidebar');
    // 不声明 group → 壳层按独占视图渲染出独立活动栏图标
    expect(panel.group).toBeUndefined();
    expect(typeof panel.component).toBe('function');
  });

  it('插件硬依赖包含 kernel.workspaces / kernel.project（缺席时可见地 inactive，不静默）', () => {
    const plugin = createEratwAdapterPlugin();
    expect(plugin.requires).toContain('kernel.workspaces');
    expect(plugin.requires).toContain('kernel.project');
  });
});

describe('口上项目向导注册（P-C 新建 / P-F 导入 / P-E 部署）', () => {
  it('注册七个 ui.overlay：新建 + 导入 + 部署 + 比对 + 两份教程 + 语法全表附录，id 与各引用常量一致', () => {
    const { overlays } = activateWithPanel();
    const ids = overlays.map((o) => o.id);
    expect(ids).toContain(NEW_KOJO_PROJECT_OVERLAY_ID);
    expect(ids).toContain(IMPORT_KOJO_OVERLAY_ID);
    expect(ids).toContain(DEPLOY_KOJO_OVERLAY_ID);
    expect(ids).toContain(DEPLOY_DIFF_OVERLAY_ID);
    expect(ids).toContain(SUGAR_TUTORIAL_OVERLAY_ID);
    expect(ids).toContain(KOJO_TUTORIAL_OVERLAY_ID);
    expect(ids).toContain(REFERENCE_TUTORIAL_OVERLAY_ID);
    expect(overlays).toHaveLength(7);
    for (const o of overlays) expect(typeof o.component).toBe('function');
  });

  it('三本教程与比对浮层标 size: wide（E9 宽版 · 1015 比对窗同款）；向导浮层维持缺省宽度档（旧行为不变）', () => {
    const { overlays } = activateWithPanel();
    for (const o of overlays) {
      const isWide =
        o.id === SUGAR_TUTORIAL_OVERLAY_ID ||
        o.id === KOJO_TUTORIAL_OVERLAY_ID ||
        o.id === REFERENCE_TUTORIAL_OVERLAY_ID ||
        o.id === DEPLOY_DIFF_OVERLAY_ID;
      expect(o.size).toBe(isWide ? 'wide' : undefined);
    }
  });

  it('监听 workspace.importRequested → 打开导入 overlay（意图 → 宿主落地）', () => {
    const { fire, emits } = activateWithPanel();
    fire('workspace.importRequested', {
      sourceDir: '/game/个人口上/001 灵梦/某包',
      suggestedName: '某包',
      source: 'file-tree',
    });
    const open = emits.find((e) => e.type === 'ui.overlay.open');
    expect(open).toBeTruthy();
    expect((open!.payload as { id: string }).id).toBe(IMPORT_KOJO_OVERLAY_ID);
  });

  it('监听 workspace.newProjectRequested → 打开新建项目 overlay（反馈 3 a1 的第一拍）', () => {
    const { fire, emits } = activateWithPanel();
    fire('workspace.newProjectRequested', { requestToken: 'kojo-m1-1', source: 'ui-sugar-editor' });
    const open = emits.find((e) => e.type === 'ui.overlay.open');
    expect(open).toBeTruthy();
    expect((open!.payload as { id: string }).id).toBe(NEW_KOJO_PROJECT_OVERLAY_ID);
  });

  it('监听 file.changed（HK-6）：工作区内的外部改动不抛错，也不对外发任何事件（只刷自家缓存）', () => {
    const { fire, emits } = activateWithPanel();
    const before = emits.length;
    // 目录还没被展开过（缓存空）⇒ 按"只重列看过的目录"这条规则，这里应当什么都不做，
    // 但**不能抛**：抛了就等于监视器一响、面板整块挂掉。
    expect(() =>
      fire('file.changed', { path: '/appdata/workspaces/w1-abc/某包/事件.kojo', kind: 'change' }),
    ).not.toThrow();
    expect(emits.length).toBe(before);
    // 工作区之外（游戏目录那半边）同样安静
    expect(() => fire('file.changed', { path: '/game/ERB/口上/x.ERB', kind: 'add' })).not.toThrow();
    expect(emits.length).toBe(before);
  });
});

/* ------------------------------ 工具条渲染分支（用户反馈批） ------------------------------ */

/**
 * 面板是纯 `createElement` 造的函数组件，本组断言只关心「dep 在不在 → 按钮在不在」这条
 * 渲染分支，不关心副作用与状态迁移；于是把三个 hook 换成平凡 shim，直接调用组件函数拿
 * 元素树来走。**刻意不引 react-dom**：本包只把 react 当 peerDep，为一条分支断言多背一个
 * 渲染器 devDep 不值当（`vi.mock` 被提升到文件顶，但其余用例既不渲染也不碰 hook）。
 */
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (init: unknown): [unknown, () => void] => [
      typeof init === 'function' ? (init as () => unknown)() : init,
      () => {},
    ],
    useRef: (init: unknown): { current: unknown } => ({ current: init }),
    useEffect: (): void => {},
  };
});

/** 元素树里的一枚按钮（type === 'button' 的节点 + 其纯文本） */
interface FakeButton {
  className: string;
  title: string;
  text: string;
}

/** 走元素树摘出所有 button 节点（含 className / title / 文本） */
function buttonsOf(node: unknown, out: FakeButton[] = []): FakeButton[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    for (const c of node) buttonsOf(c, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  const children = el.props?.children;
  if (el.type === 'button') {
    out.push({
      className: String(el.props?.className ?? ''),
      title: String(el.props?.title ?? ''),
      text: textOf(children),
    });
    return out;
  }
  buttonsOf(children, out);
  return out;
}

/** 元素树的纯文本投影（图标缺省 → 回退字形也在文本里，故只按"含"判定） */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf((node as { props?: { children?: unknown } }).props?.children);
}

function panelDeps(over: Partial<KojoProjectsPanelDeps> = {}): KojoProjectsPanelDeps {
  return {
    subscribe: () => () => {},
    projects: () => [],
    loading: () => false,
    error: () => null,
    refresh: () => {},
    projectDir: (id) => `/appdata/workspaces/${id}`,
    dirState: () => undefined,
    ensureDir: () => {},
    reveal: () => {},
    openTutorial: () => {},
    status: () => null,
    dismissStatus: () => {},
    exportArtifact: () => {},
    deployArtifact: () => {},
    compareArtifact: () => {},
    attribution: () => undefined,
    ensureAttribution: () => {},
    createItem: async () => ({ ok: false, reason: 'not used' }),
    ...over,
  };
}

const renderPanel = (deps: KojoProjectsPanelDeps): unknown => createKojoProjectsPanel(deps)({});

describe('面板工具条 · 「导入项目」按钮（dep 存在才画）', () => {
  it('注入 openImportWizard：按钮渲染在「新建」旁，风格与既有两枚一致（ghost small + 有 title）', () => {
    const btns = buttonsOf(renderPanel(panelDeps({ openNewWizard: () => {}, openImportWizard: () => {} })));
    const imp = btns.find((b) => b.text.includes('导入项目'));
    expect(imp).toBeTruthy();
    expect(imp!.className).toBe('ghost small');
    expect(imp!.title.length).toBeGreaterThan(0); // 图标+短词的按钮必须自带人话提示
    // 顺序：新建 → 导入项目 → 刷新（导入挨着新建，不插到刷新之后）
    const at = (word: string): number => btns.findIndex((b) => b.text.includes(word));
    expect(at('新建')).toBeLessThan(at('导入项目'));
    expect(at('导入项目')).toBeLessThan(btns.length - 1);
  });

  it('缺省 openImportWizard：整颗不画——没有能力的入口不灰着占位（与 openNewWizard 同款口径）', () => {
    const btns = buttonsOf(renderPanel(panelDeps({ openNewWizard: () => {} })));
    expect(btns.some((b) => b.text.includes('导入项目'))).toBe(false);
    expect(btns.some((b) => b.text.includes('新建'))).toBe(true); // 对照组：新建照画
  });
});
