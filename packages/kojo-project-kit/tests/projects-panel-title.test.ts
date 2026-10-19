import { describe, expect, it, vi } from 'vitest';
import type { DirEntry, WorkspaceProject } from '@kojo/plugin-api';
import { createKojoProjectsPanel, type KojoProjectsPanelDeps } from '../src/projects-panel';

/**
 * 截断名称节点的 title 兜底（用户反馈：名称被 CSS 省略号截断后悬停读不回全名）。
 *
 * 面板是纯 createElement 函数组件，这里沿用 eratw-adapter 面板批的走法：
 * 三个 hook 换平凡 shim 后直接调组件函数拿元素树，**刻意不引 react-dom**。
 * useState 的 shim 会把「空 Set 初始值」换成含目标目录的集合——这是唯一能让
 * 包行/目录行以展开态渲染的入口（openDirs 与 closedProjects 都按 id/路径取用，
 * 哨兵路径不匹配任何项目 id，故项目恒为展开）。
 */

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (init: unknown): [unknown, () => void] => {
      const value = typeof init === 'function' ? (init as () => unknown)() : init;
      if (value instanceof Set && value.size === 0) return [new Set([OPEN_DIR]), () => {}];
      return [value, () => {}];
    },
    useRef: (init: unknown): { current: unknown } => ({ current: init }),
    useEffect: (): void => {},
  };
});

/** 展开中的包目录（与 panelDeps 的 projectDir + dirName 拼出的路径逐字一致） */
const OPEN_DIR = '/appdata/workspaces/p1/宇佐见 堇子 v1.0';

/** 元素树里的一枚节点（type / className / title / 纯文本） */
interface FakeNode {
  type: string;
  className: string;
  title: string | null;
  text: string;
}

function walk(node: unknown, out: FakeNode[] = []): FakeNode[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  const className = String(el.props?.className ?? '');
  if (typeof el.type === 'string' && className.includes('kp-')) {
    out.push({
      type: String(el.type),
      className,
      title: typeof el.props?.title === 'string' ? el.props.title : null,
      text: textOf(el.props?.children),
    });
  }
  walk(el.props?.children, out);
  return out;
}

function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf((node as { props?: { children?: unknown } }).props?.children);
}

const projects: WorkspaceProject[] = [
  {
    id: 'p1',
    name: '0.4beta合集-宇佐见 堇子 v1.0',
    createdAt: 0,
    updatedAt: 0,
    meta: {},
    artifacts: [
      {
        id: 'a1',
        name: '0.4beta合集-宇佐见 堇子 v1.0',
        dirName: '宇佐见 堇子 v1.0',
        meta: { scriptNo: 3 },
        createdAt: 0,
      },
    ],
  },
];

const dirEntries: DirEntry[] = [
  { name: '素材', path: `${OPEN_DIR}/素材`, isDirectory: true },
  { name: '003 宇佐见 堇子 事件.kojo', path: `${OPEN_DIR}/003 宇佐见 堇子 事件.kojo`, isDirectory: false },
];

function panelDeps(): KojoProjectsPanelDeps {
  return {
    subscribe: () => () => {},
    projects: () => projects,
    loading: () => false,
    error: () => null,
    refresh: () => {},
    projectDir: (id) => `/appdata/workspaces/${id}`,
    dirState: (absDir) => (absDir === OPEN_DIR ? dirEntries : undefined),
    ensureDir: () => {},
    reveal: () => {},
    status: () => null,
    dismissStatus: () => {},
    exportArtifact: () => {},
    deployArtifact: () => {},
    attribution: () => undefined,
    ensureAttribution: () => {},
    createItem: async () => ({ ok: false, reason: 'not used' }),
  };
}

const rendered = (): FakeNode[] => walk(createKojoProjectsPanel(panelDeps())({}));

describe('截断名称节点带 title（完整原文，悬停可复原全名）', () => {
  it('项目名 / 包名 / 包目录名 / 目录行 / 文件行的名称 span 的 title = 完整文本', () => {
    const byClass = (cls: string): FakeNode[] =>
      rendered().filter((n) => n.className.split(/\s+/).includes(cls));

    const expectTitleEqText = (cls: string): void => {
      const nodes = byClass(cls);
      expect(nodes.length).toBeGreaterThan(0);
      for (const n of nodes) {
        expect(n.text.length).toBeGreaterThan(0);
        expect(n.title).toBe(n.text);
      }
    };

    expectTitleEqText('kp-project-name');
    expectTitleEqText('kp-artifact-name');
    expectTitleEqText('kp-dirname');
    expectTitleEqText('kp-dir-name');
    expectTitleEqText('kp-file-name');
  });

  it('零结构改动：只加 title 属性，类名与文本原样（渲染树里不新增/丢失名称节点）', () => {
    const names = rendered().filter((n) =>
      ['kp-project-name', 'kp-artifact-name', 'kp-dir-name', 'kp-file-name'].some((cls) =>
        n.className.split(/\s+/).includes(cls),
      ),
    );
    expect(names.map((n) => n.text)).toEqual([
      '0.4beta合集-宇佐见 堇子 v1.0', // 项目
      '0.4beta合集-宇佐见 堇子 v1.0', // 包
      '素材',
      '003 宇佐见 堇子 事件.kojo',
    ]);
  });
});
