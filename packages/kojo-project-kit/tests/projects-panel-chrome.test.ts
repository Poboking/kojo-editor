import { describe, expect, it, vi } from 'vitest';
import type { DirEntry, WorkspaceProject } from '@kojo/plugin-api';
import { createKojoProjectsPanel, type KojoProjectsPanelDeps } from '../src/projects-panel';

/**
 * 「我的口上项目」面板的呈现契约（批次十一 · 视觉 L06）。
 *
 * 钉的是**呈现层四条不改语义的口径**，别的行为（列表 / 导入 / 部署 / 右键新建）由
 * `packages/plugins/eratw-adapter/tests/kojo-projects-panel.test.ts` 继续守着，这里不重复：
 * ① 工具条文字不许再被粘在图标后面（旧写法 `' 新建'` 的前导空格正是 260px 侧栏里的折行点）；
 * ② 教程区收起只靠 class，四行入口必须仍在元素树里（收起 ≠ 功能没了）；
 * ③ 双真相源那句整段解释留在 title，正文一句人话，且有关闭键；
 * ④ 空态卡与分组头的出现条件（CTA 跟 `openNewWizard` 走；分组头只在"两段同屏"时出现）。
 *
 * hook 走平凡 shim 直接调组件函数拿元素树（沿用同目录 title 批的走法，**刻意不引 react-dom**）；
 * `forceClosed` 那一档把初始为 true 的布尔态翻成 false——面板里初始为 true 的只有
 * `hintOpen`（双真相源提示）与 `tutOpen`（教程区），后者正是"收起态"要取证的那一格。
 */

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const forceClosed = (): boolean =>
    (globalThis as { __kojoForceClosed?: boolean }).__kojoForceClosed === true;
  return {
    ...actual,
    useState: (init: unknown): [unknown, () => void] => {
      const value = typeof init === 'function' ? (init as () => unknown)() : init;
      return [forceClosed() && value === true ? false : value, () => {}];
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
  children: unknown;
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
    children: el.props?.children,
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
const project = (artifacts: number): WorkspaceProject[] =>
  Array.from({ length: artifacts }, (_, i) => ({
    id: `p${i}`,
    name: `作品 ${i}`,
    createdAt: 0,
    updatedAt: 0,
    meta: {},
    artifacts: [{ id: `a${i}`, name: `包 ${i}`, dirName: `包${i}`, meta: {}, createdAt: 0 }],
  }));

function deps(over: Partial<KojoProjectsPanelDeps> = {}): KojoProjectsPanelDeps {
  return {
    subscribe: () => () => {},
    projects: () => project(1),
    loading: () => false,
    error: () => null,
    refresh: () => {},
    projectDir: (id) => `/appdata/workspaces/${id}`,
    // 项目根下有一个不属于任何包的平级目录 ⇒ "两段同屏"成立
    dirState: (absDir) =>
      absDir === '/appdata/workspaces/p0'
        ? ([{ name: '素材', path: '/appdata/workspaces/p0/素材', isDirectory: true }] as DirEntry[])
        : undefined,
    ensureDir: () => {},
    reveal: () => {},
    openTutorial: () => {},
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

const render = (d: KojoProjectsPanelDeps, forceClosed = false): FakeNode[] => {
  (globalThis as { __kojoForceClosed?: boolean }).__kojoForceClosed = forceClosed;
  try {
    return walk(createKojoProjectsPanel(d)({}));
  } finally {
    delete (globalThis as { __kojoForceClosed?: boolean }).__kojoForceClosed;
  }
};

describe('工具条 · 计数与动作分层（260px 侧栏不再撕裂）', () => {
  it('计数是纯文字：句子里没有图标节点，也没有多余空格', () => {
    const nodes = render(deps({ openNewWizard: () => {}, openImportWizard: () => {} }));
    const label = byClass(nodes, 'kp-toolbar-label')[0]!;
    expect(label.text).toBe('1 个项目');
    expect(walk(label.children).filter((n) => has(n, 'icon'))).toEqual([]);
    // 悬停还得说清这数数的是什么（游戏目录不计入）
    expect(label.title).toContain('工作区');
  });

  it('动作钮的文字各自成格，不再用「前导空格」与图标拼接', () => {
    const nodes = render(deps({ openNewWizard: () => {}, openImportWizard: () => {} }));
    const labels = byClass(nodes, 'kp-act-label').map((n) => n.text);
    expect(labels).toEqual(['新建', '导入项目', '刷新']);
    // 旧写法 `' 新建'` 的折行点：整棵树里不该再有以空格开头的动作文字
    for (const n of nodes) {
      if (typeof n.children === 'string') expect(n.children.startsWith(' '), n.children).toBe(false);
    }
  });

  it('三枚动作的 className 逐字仍是 ghost small（壳层小钮度量不动）', () => {
    const nodes = render(deps({ openNewWizard: () => {}, openImportWizard: () => {} }));
    const actions = byClass(nodes, 'kp-toolbar-actions')[0]!;
    const btns = walk(actions.children).filter((n) => n.type === 'button');
    expect(btns.map((b) => b.className)).toEqual(['ghost small', 'ghost small', 'ghost small']);
  });
});

describe('教程区 · 缺省展开（用户 1027 反馈 1），收起靠 class，入口一个不少', () => {
  it('缺省展开：题头 aria-expanded=true，四行直出，分割线在位，摘要让位', () => {
    const nodes = render(deps());
    const head = byClass(nodes, 'kp-tutorials-head')[0]!;
    expect(head.props['aria-expanded']).toBe(true);
    expect(byClass(nodes, 'kp-tutorials-body')[0]!.className).not.toContain('kp-collapsed');
    expect(byClass(nodes, 'kp-tutorial-btn').map((n) => n.text)).toEqual([
      '▤口上教程',
      '✦.kojo 语言教程',
      '❖Kojo 2.0 语言教程',
      '▦kojo 语法全表',
    ]);
    expect(byClass(nodes, 'kp-splitter')).toHaveLength(1);
    // 展开态不给摘要：同一事实已在四行里说过
    expect(byClass(nodes, 'kp-chip')).toEqual([]);
  });

  it('收起后：面板体整块 display:none（class 而不是条件渲染）、分割线不画、留一枚计数摘要', () => {
    const nodes = render(deps(), true);
    const head = byClass(nodes, 'kp-tutorials-head')[0]!;
    expect(head.props['aria-expanded']).toBe(false);
    expect(byClass(nodes, 'kp-tutorials-body')[0]!.className).toContain('kp-collapsed');
    expect(byClass(nodes, 'kp-tutorial-btn')).toHaveLength(4);
    expect(byClass(nodes, 'kp-splitter')).toEqual([]);
    // 收起态给一枚摘要，说清"这一行点开有四样东西"
    expect(byClass(nodes, 'kp-chip').map((n) => n.text)).toEqual(['4 本']);
  });

  it('没有教程提供方 ⇒ 教程区与题头整块不画（没有能力的入口不摆样子）', () => {
    const nodes = render(deps({ openTutorial: undefined }));
    expect(byClass(nodes, 'kp-tutorials-head')).toEqual([]);
    expect(byClass(nodes, 'kp-tutorials')).toEqual([]);
  });

  it('行点击仍只发语义 id（收纳形态不碰回调）', () => {
    const opened: string[] = [];
    const nodes = render(deps({ openTutorial: (which) => void opened.push(which) }));
    for (const n of byClass(nodes, 'kp-tutorial-btn')) (n.props.onClick as () => void)();
    expect(opened).toEqual(['kojo', 'sugar', 'kojo2', 'reference']);
  });
});

describe('双真相源提示 · 人话正文 + 完整口径在 title', () => {
  it('正文不含内部口号，整段解释收在 title，并给了关闭键', () => {
    const nodes = render(deps());
    const text = byClass(nodes, 'kp-notice-text')[0]!;
    expect(text.text).toBe('改的是工作区副本 · 部署后才进游戏');
    expect(text.title).toContain('工作区是可写的权威副本');
    expect(byClass(nodes, 'kp-notice-close')).toHaveLength(1);
    // 旧那条压在面板第一行的口号不再当正文（tutorial-content 引用的整句仍能在 title 找到）
    expect(nodes.some((n) => has(n, 'kp-notice') && n.text === '工作区为权威 · 游戏目录仅部署目标')).toBe(false);
  });
});

describe('空态与分组头', () => {
  it('没有项目 ⇒ 虚线空态卡（题头 + 一句指引），CTA 跟着 openNewWizard 走', () => {
    const withDep = render(deps({ projects: () => [], openNewWizard: () => {} }));
    expect(byClass(withDep, 'kp-card-title').map((n) => n.text)).toContain('这里还没有口上项目');
    expect(byClass(withDep, 'kp-card')[0]!.text).toContain('新建一个开始写');
    expect(byClass(withDep, 'kp-card-cta')).toHaveLength(1);
    const noDep = render(deps({ projects: () => [] }));
    expect(byClass(noDep, 'kp-card-cta')).toEqual([]);
    expect(byClass(noDep, 'kp-card-title')[0]!.text).toBe('这里还没有口上项目');
  });

  it('读失败 ⇒ 同一张卡换错误档，重试仍在', () => {
    const nodes = render(deps({ error: () => '盘没了' }));
    expect(byClass(nodes, 'kp-card-err')).toHaveLength(1);
    expect(byClass(nodes, 'kp-card-title')[0]!.text).toBe('工作区加载失败');
    expect(nodes.filter((n) => n.type === 'button' && n.text === '重试')).toHaveLength(1);
  });

  it('包与包外目录同屏 ⇒ 两段各有分组头；只有一段 ⇒ 不凭空加行', () => {
    const both = render(deps({ projects: () => project(1) }));
    expect(byClass(both, 'kp-group-title').map((n) => n.text)).toEqual(['作者包', '包之外的目录1']);
    const onlyPkg = render(deps({ projects: () => project(1), dirState: () => undefined }));
    expect(byClass(onlyPkg, 'kp-group-title')).toEqual([]);
  });

  it('包数徽标仍在项目行右端（分组头不重复同一个数）', () => {
    const nodes = render(deps());
    const counts = byClass(nodes, 'kp-count').map((n) => n.text);
    expect(counts).toContain('1 包');
    expect(counts.filter((t) => /^\d+$/.test(t))).toEqual(['1']);
  });
});
