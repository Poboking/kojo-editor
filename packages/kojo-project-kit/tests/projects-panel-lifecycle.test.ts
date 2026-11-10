import { describe, expect, it, vi } from 'vitest';
import type { DirEntry, WorkspaceProject } from '@kojo/plugin-api';
import { createKojoProjectsPanel, type KojoProjectsPanelDeps } from '../src/projects-panel';

/**
 * 项目行动作（P0-7b）：删除项目的二次确认与项目设置小面板的交互契约。
 *
 * 这里用一个**有状态的 useState shim**（重渲染 = 重新调组件函数），
 * 于是"点删除 → 出现确认层 → 点取消/确认"这条链路可以在无 react-dom 的环境里走完；
 * 文案 / patch 组装的口径由 `project-settings.test.ts` 另行钉住。
 */

let cells: unknown[] = [];
let cursor = 0;
let rerender: () => void = () => {};

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (init: unknown): [unknown, (v: unknown) => void] => {
      const i = cursor++;
      if (i >= cells.length) {
        cells[i] = typeof init === 'function' ? (init as () => unknown)() : init;
      }
      const set = (v: unknown): void => {
        cells[i] = typeof v === 'function' ? (v as (prev: unknown) => unknown)(cells[i]) : v;
        rerender();
      };
      return [cells[i], set];
    },
    useRef: (init: unknown): { current: unknown } => ({ current: init }),
    useEffect: (): void => {},
  };
});

interface FakeNode {
  type: unknown;
  className: string;
  title: string | null;
  text: string;
  props: Record<string, unknown>;
}

function walk(node: unknown, out: FakeNode[] = []): FakeNode[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  out.push({
    type: el.type,
    className: String(el.props?.className ?? ''),
    title: typeof el.props?.title === 'string' ? el.props?.title : null,
    text: textOf(el.props?.children),
    props: el.props ?? {},
  });
  walk(el.props?.children, out);
  return out;
}

function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf((node as { props?: { children?: unknown } }).props?.children);
}

const has = (n: FakeNode, cls: string): boolean => n.className.split(/\s+/).includes(cls);
const byClass = (nodes: FakeNode[], cls: string): FakeNode[] => nodes.filter((n) => has(n, cls));
const byText = (nodes: FakeNode[], text: string): FakeNode | undefined =>
  nodes.find((n) => n.type === 'button' && n.text === text);
/** 确认层里的「删除」钮（行内动作排得更早，不能只按文字找） */
const confirmDeleteButton = (nodes: FakeNode[]): FakeNode | undefined =>
  nodes.find((n) => n.type === 'button' && n.text === '删除' && has(n, 'danger') && has(n, 'small'));

const project: WorkspaceProject = {
  id: 'p1',
  name: '堇子口上',
  createdAt: 0,
  updatedAt: 0,
  meta: { author: '某作者', version: '1.0' },
  artifacts: [],
};

function deps(over: Partial<KojoProjectsPanelDeps> = {}): KojoProjectsPanelDeps {
  return {
    subscribe: () => () => {},
    projects: () => [project],
    loading: () => false,
    error: () => null,
    refresh: () => {},
    projectDir: (id) => `/appdata/workspaces/${id}`,
    dirState: (): DirEntry[] | undefined => undefined,
    ensureDir: () => {},
    reveal: () => {},
    status: () => null,
    dismissStatus: () => {},
    exportArtifact: () => {},
    deployArtifact: () => {},
    attribution: () => undefined,
    ensureAttribution: () => {},
    createItem: async () => ({ ok: false, reason: 'not used' }),
    ...over,
  };
}

function mount(d: KojoProjectsPanelDeps): { draw: () => FakeNode[] } {
  cells = [];
  cursor = 0;
  const component = createKojoProjectsPanel(d);
  const draw = (): FakeNode[] => {
    cursor = 0;
    return walk(component({}));
  };
  rerender = draw;
  return { draw };
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('项目根新建 · 成功后条目可见', () => {
  function startNewItem(draw: () => FakeNode[], label: string, collapsed = true): void {
    const row = byClass(draw(), 'kp-project-btn')[0]!;
    if (collapsed) (row.props.onClick as () => void)();
    (row.props.onContextMenu as (e: unknown) => void)({
      clientX: 10,
      clientY: 10,
      preventDefault: () => {},
      stopPropagation: () => {},
    });
    const item = draw().find((n) => n.props.role === 'menuitem' && n.text.includes(label))!;
    (item.props.onClick as () => void)();
    (byClass(draw(), 'kp-draft-input')[0]!.props.onChange as (e: unknown) => void)({
      target: { value: '测试' },
    });
  }

  it.each([
    { kind: 'erb' as const, label: '新建 ERB 文件', name: '测试.erb', collapsed: true },
    { kind: 'erb' as const, label: '新建 ERB 文件', name: '测试.erb', collapsed: false },
    { kind: 'folder' as const, label: '新建文件夹', name: '测试', collapsed: true },
    { kind: 'folder' as const, label: '新建文件夹', name: '测试', collapsed: false },
  ])('$kind · collapsed=$collapsed：落点不变、创建后上树，文件打开一次', async ({ kind, label, name, collapsed }) => {
    const root = '/appdata/workspaces/p1';
    const path = `${root}/${name}`;
    const entries: DirEntry[] = [];
    const reveal = vi.fn();
    const createItem = vi.fn<KojoProjectsPanelDeps['createItem']>(async () => {
      entries.push({ name, path, isDirectory: kind === 'folder' });
      return { ok: true, path, displayName: name };
    });
    const { draw } = mount(deps({
      dirState: (dir) => (dir === root ? entries : undefined),
      createItem,
      reveal,
    }));
    startNewItem(draw, label, collapsed);
    (byClass(draw(), 'kp-draft-input')[0]!.props.onKeyDown as (e: unknown) => void)({ key: 'Enter' });
    await flush();

    expect(createItem).toHaveBeenCalledExactlyOnceWith(root, '测试', kind);
    expect(byClass(draw(), 'kp-draft-input')).toHaveLength(0);
    expect(byClass(draw(), 'kp-loose')).toHaveLength(1);
    expect(byClass(draw(), 'kp-loose')[0]!.text).toContain(name);
    if (kind === 'erb') expect(reveal).toHaveBeenCalledExactlyOnceWith(path);
    else expect(reveal).not.toHaveBeenCalled();
  });

  it('创建失败：保留名字和错误，不展开项目、不打开文件', async () => {
    const reveal = vi.fn();
    const root = '/appdata/workspaces/p1';
    const { draw } = mount(deps({
      dirState: (dir) => (dir === root ? [{ name: '已有.erb', path: `${root}/已有.erb`, isDirectory: false }] : undefined),
      createItem: async () => ({ ok: false, reason: '同名文件已存在' }),
      reveal,
    }));
    startNewItem(draw, '新建 ERB 文件');
    (byClass(draw(), 'kp-draft-input')[0]!.props.onKeyDown as (e: unknown) => void)({ key: 'Enter' });
    await flush();

    expect(byClass(draw(), 'kp-draft-input')[0]!.props.value).toBe('测试');
    expect(byClass(draw(), 'kp-draft-err')[0]!.text).toBe('同名文件已存在');
    expect(byClass(draw(), 'kp-loose')).toHaveLength(0);
    expect(reveal).not.toHaveBeenCalled();
  });

  it('取消新建：不创建、不展开项目、不打开文件', () => {
    const createItem = vi.fn<KojoProjectsPanelDeps['createItem']>();
    const reveal = vi.fn();
    const root = '/appdata/workspaces/p1';
    const { draw } = mount(deps({
      dirState: (dir) => (dir === root ? [{ name: '已有.erb', path: `${root}/已有.erb`, isDirectory: false }] : undefined),
      createItem,
      reveal,
    }));
    startNewItem(draw, '新建 ERB 文件');
    (byClass(draw(), 'kp-draft-input')[0]!.props.onKeyDown as (e: unknown) => void)({ key: 'Escape' });

    expect(byClass(draw(), 'kp-draft-input')).toHaveLength(0);
    expect(byClass(draw(), 'kp-loose')).toHaveLength(0);
    expect(createItem).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });
});

describe('项目行动作 · 设置 / 删除的入口', () => {
  it('deps 提供时项目行出现「设置」与「删除」（悬停态类组与包行同族）', () => {
    const { draw } = mount(
      deps({ removeProject: async () => ({ ok: true }), saveProjectSettings: async () => ({ ok: true }) }),
    );
    const actions = byClass(draw(), 'kp-row-actions');
    expect(actions).toHaveLength(1);
    expect(actions[0]!.text).toBe('设置删除');
  });

  it('缺省 deps ⇒ 一个项目动作都不画（没有的能力不摆样子）', () => {
    const nodes = mount(deps()).draw();
    expect(byClass(nodes, 'kp-row-actions')).toEqual([]);
  });
});

describe('删除项目 · 二次确认', () => {
  it('点「删除」弹出确认层：含项目名与「连同文件夹内全部内容一起删除，且不可恢复」；取消不产生任何写', async () => {
    let called = 0;
    const { draw } = mount(deps({ removeProject: async () => (called++, { ok: true }) }));
    (byText(draw(), '删除')!.props.onClick as () => void)();

    const confirm = byClass(draw(), 'modal-mask');
    expect(confirm).toHaveLength(1);
    const body = confirm[0]!.text;
    expect(body).toContain('堇子口上');
    expect(body).toContain('连同文件夹内全部内容一起删除，且不可恢复');

    (byText(draw(), '取消')!.props.onClick as () => void)();
    expect(byClass(draw(), 'modal-mask')).toEqual([]);
    expect(called).toBe(0);
  });

  it('确认后调用 removeProject（一次）；成功后收窗', async () => {
    const calls: Array<[string, string]> = [];
    const { draw } = mount(
      deps({
        removeProject: async (projectId, name) => {
          calls.push([projectId, name]);
          return { ok: true };
        },
      }),
    );
    (byText(draw(), '删除')!.props.onClick as () => void)();
    (confirmDeleteButton(draw())!.props.onClick as () => void)();
    await flush();
    expect(calls).toEqual([['p1', project.name]]);
    expect(byClass(draw(), 'modal-mask')).toEqual([]);
  });

  it('removeProject 失败：原因留在确认层里，窗不关', async () => {
    const { draw } = mount(deps({ removeProject: async () => ({ ok: false, reason: '目录被占用' }) }));
    (byText(draw(), '删除')!.props.onClick as () => void)();
    (confirmDeleteButton(draw())!.props.onClick as () => void)();
    await flush();
    expect(byClass(draw(), 'modal-mask')).toHaveLength(1);
    expect(byClass(draw(), 'kp-modal-err').map((n) => n.text)).toEqual(['目录被占用']);
  });
});

describe('项目设置 · 表单初值与保存', () => {
  it('打开设置：表单预填既有 meta.author / meta.version', () => {
    const { draw } = mount(deps({ saveProjectSettings: async () => ({ ok: true }) }));
    (byText(draw(), '设置')!.props.onClick as () => void)();
    const inputs = byClass(draw(), 'kp-field-input');
    expect((inputs[0]!.props.value as string)).toBe('堇子口上');
    expect(inputs[1]!.props.value).toBe('某作者');
    expect(inputs[2]!.props.value).toBe('1.0');
  });

  it('改作者后保存：patch 只带 meta.author（其余键原样），成功后收窗', async () => {
    const patches: Array<Record<string, unknown>> = [];
    const { draw } = mount(
      deps({
        saveProjectSettings: async (_id, patch) => {
          patches.push(patch);
          return { ok: true };
        },
      }),
    );
    (byText(draw(), '设置')!.props.onClick as () => void)();
    const authorInput = byClass(draw(), 'kp-field-input')[1]!;
    (authorInput.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: '新作者' },
    });
    (byText(draw(), '保存')!.props.onClick as () => void)();
    await flush();
    expect(patches).toEqual([{ meta: { author: '新作者', version: '1.0' } }]);
    expect(byClass(draw(), 'modal-mask')).toEqual([]);
  });

  it('未改动直接保存 ⇒ 不发写请求、直接收窗', async () => {
    let saved = 0;
    const { draw } = mount(
      deps({
        saveProjectSettings: async () => {
          saved++;
          return { ok: true };
        },
      }),
    );
    (byText(draw(), '设置')!.props.onClick as () => void)();
    (byText(draw(), '保存')!.props.onClick as () => void)();
    await flush();
    expect(saved).toBe(0);
    expect(byClass(draw(), 'modal-mask')).toEqual([]);
  });
});
