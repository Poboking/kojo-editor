// @vitest-environment happy-dom
/**
 * PS-16 memo 判据（渲染计数，零墙钟断言 ⇒ 留在功能池）。
 *
 * 计数法：`vi.mock` 把行组件换成「memo 包裹的计数透传层」——count++ 只在 memo
 * 放行（props 真变了）之后发生，比较语义与真组件同款（默认浅比较）。判据 =
 * "什么变化穿到了行"：树内无关 state（右键菜单）翻动 ⇒ 行组件执行次数不变；
 * `activeFile` 切换 ⇒ 行级 memo 后全树只有新旧两行重画。
 *
 * 计数口径说明：mock 只包模块导出——`DirRows` 的**递归子层**走模块内部绑定，
 * 不经过导出代理 ⇒ dirRows 计的是 FileTree 顶层装配的根层执行次数。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement as h, memo, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DirEntry, ErbIndex, GameProject } from '@kojo/plugin-api';
import { FileTree } from '../src/ui/FileTree';
import type { FileRowProps } from '../src/ui/file-tree-row';
import type { FileRowsProps } from '../src/ui/file-tree-rows';
import type { DirRowsProps } from '../src/ui/file-tree-dir-rows';

const counts = vi.hoisted(() => ({ fileRows: 0, fileRow: 0, dirRows: 0 }));

vi.mock('../src/ui/file-tree-rows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/file-tree-rows')>();
  return {
    ...actual,
    FileRows: memo((props: FileRowsProps): ReactElement => {
      counts.fileRows++;
      // memo 包装产物是组件对象不是函数 ⇒ 元素化交回 React（内层 memo 比较照跑）
      return h(actual.FileRows, props);
    }),
  };
});
vi.mock('../src/ui/file-tree-row', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/file-tree-row')>();
  return {
    ...actual,
    FileRow: memo((props: FileRowProps): ReactElement => {
      counts.fileRow++;
      return h(actual.FileRow, props);
    }),
  };
});
vi.mock('../src/ui/file-tree-dir-rows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/file-tree-dir-rows')>();
  return {
    ...actual,
    DirRows: memo((props: DirRowsProps): ReactElement => {
      counts.dirRows++;
      return h(actual.DirRows, props);
    }),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 一个角色 · 一个包（3 个 ERB）+ 一个根散文件 ⇒ FileRows 两条装配线 + DirRows 一条 */
const FILES = [
  'C:/koa/001/包A/M_KOJO_K1_a.ERB',
  'C:/koa/001/包A/M_KOJO_K1_b.ERB',
  'C:/koa/001/包A/M_KOJO_K1_c.ERB',
  'C:/koa/001/散落.ERB',
];
const project = {
  charaIndex: new Map([[1, { no: 1, name: '灵梦', kojoDir: 'C:/koa/001' }]]),
  kojoPaths: ['C:/koa'],
  rootDir: 'C:/game',
} as unknown as GameProject;
const index = { files: new Map(FILES.map((f) => [f, null])), byName: new Map() } as unknown as ErbIndex;

const listDir = async (dir: string): Promise<DirEntry[]> =>
  dir.endsWith('包A')
    ? [
        { name: 'sub', path: `${dir}/sub`, isDirectory: true },
        { name: 'readme.txt', path: `${dir}/readme.txt`, isDirectory: false },
      ]
    : [];

const treeProps = {
  project,
  index,
  activeFile: null as string | null,
  onOpenFile: () => {},
  listDir,
};

/** 展开组 + 展开包真实文件夹，让三条装配线全部挂载 */
async function mountTree(container: HTMLElement, activeFile: string | null = null): Promise<Root> {
  const root = createRoot(container);
  await act(async () => {
    root.render(h(FileTree, { ...treeProps, activeFile }));
  });
  await act(async () => {
    (container.querySelector('.tree-group-btn') as HTMLElement | null)?.click();
  });
  await act(async () => {
    (container.querySelector('.tree-package') as HTMLElement | null)?.click();
  });
  await act(async () => {});
  return root;
}

describe('FileTree · PS-16 行组件 memo（渲染计数）', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    counts.fileRows = 0;
    counts.fileRow = 0;
    counts.dirRows = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
  });

  it('树内无关 state（右键菜单）翻动 ⇒ 行组件一次都不执行', async () => {
    root = await mountTree(container);
    // 基线：3 条装配线已挂载（根散 FileRows + 包A FileRows + 包A DirRows 根层）
    const base = { ...counts };
    expect(base.fileRows).toBeGreaterThan(0);
    expect(base.fileRow).toBeGreaterThan(0);
    expect(base.dirRows).toBeGreaterThan(0);
    // 开右键菜单：FileTree 自己的 state ⇒ 本体重渲，行组件 props 全同 ⇒ memo 全挡
    await act(async () => {
      container.querySelector('.file-tree')?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
    expect(counts.fileRows).toBe(base.fileRows);
    expect(counts.fileRow).toBe(base.fileRow);
    expect(counts.dirRows).toBe(base.dirRows);
  });

  it('activeFile 切换 ⇒ 行元素零创建，树内只有新旧两行被改属性（PERF 批判据）', async () => {
    root = await mountTree(container, 'C:/koa/001/包A/M_KOJO_K1_a.ERB');
    const base = { ...counts };
    // 选中态自 PERF 批起走模块级订阅（不进 props）⇒ 父级连"整组重画"都不该发生：
    // 三条装配线（两条 FileRows + DirRows 根层）的 memo 全部命中，行元素一个都不重建。
    const touched = new Set<string>();
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as HTMLElement;
        if (el.classList?.contains('tree-file')) touched.add(el.getAttribute('data-tree-path') ?? '');
      }
    });
    mo.observe(container.querySelector('.file-tree') as Element, {
      attributes: true,
      subtree: true,
      attributeFilter: ['class', 'aria-current'],
    });
    await act(async () => {
      root.render(h(FileTree, { ...treeProps, activeFile: 'C:/koa/001/包A/M_KOJO_K1_c.ERB' }));
    });
    mo.disconnect();
    expect(counts.fileRows - base.fileRows).toBe(0); // 组级：零放行
    expect(counts.fileRow - base.fileRow).toBe(0); // 行级：零元素创建
    expect(counts.dirRows - base.dirRows).toBe(0);
    // DOM 那面：恰好两行（旧选中 a、新选中 c）被改过，其余行一个属性都没动
    expect([...touched].sort()).toEqual([
      'C:/koa/001/包A/M_KOJO_K1_a.ERB',
      'C:/koa/001/包A/M_KOJO_K1_c.ERB',
    ]);
    // 行为不变：选中仍恰好一行，且是新那行
    const active = container.querySelectorAll('.tree-file.active');
    expect(active).toHaveLength(1);
    expect(active[0]?.getAttribute('data-tree-path')).toBe('C:/koa/001/包A/M_KOJO_K1_c.ERB');
    expect(container.querySelectorAll('.tree-file[aria-current="true"]')).toHaveLength(1);
  });

  it('包层 ERB 键集（skip）引用恒定 ⇒ 连续无关帧不换新 Set', async () => {
    root = await mountTree(container);
    const base = { ...counts };
    // 同 props 整树重渲（外层任意 state 翻转的等价形态）：行组件全挡
    await act(async () => {
      root.render(h(FileTree, { ...treeProps }));
    });
    await act(async () => {
      container.querySelector('.file-tree')?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
    expect(counts.fileRows).toBe(base.fileRows);
    expect(counts.dirRows).toBe(base.dirRows);
  });
});

/** 父侧稳定化是 memo 的前提（对照组：穿新函数 ⇒ memo 必失效，语义边界如实记录） */
describe('FileTree · 对照组（钉住 memo 语义边界）', () => {
  let container: HTMLElement;
  let root: Root;
  beforeEach(() => {
    counts.fileRows = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
  });

  it('宿主每帧传新 gloss ⇒ glossOf 穿 DirRows props ⇒ memo 放行（旧形态的失效源）', async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(h(FileTree, { ...treeProps, gloss: (n: string) => n }));
    });
    await act(async () => {
      (container.querySelector('.tree-group-btn') as HTMLElement | null)?.click();
    });
    await act(async () => {
      (container.querySelector('.tree-package') as HTMLElement | null)?.click();
    });
    await act(async () => {});
    const base = counts.dirRows;
    await act(async () => {
      // 新函数引用的 gloss ⇒ glossOf 换 ⇒ DirRows props 换 ⇒ 放行（memo 没挡住是**正确**的：显示名逻辑变了）
      root.render(h(FileTree, { ...treeProps, gloss: (n: string) => n }));
    });
    expect(counts.dirRows - base).toBe(1);
  });
});