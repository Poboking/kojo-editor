// @vitest-environment happy-dom
/**
 * WS-11（键盘语义与可访问性）+ WS-12（行虚拟化）的** DOM 侧自证**。
 *
 * 纯模块那边钉的是判据（`file-tree-flat` / `file-tree-virtual` / `file-tree-keyboard`），
 * 这一份钉的是"接线之后真的是这个行为"：
 *
 * 1. **E 车道的跨车道契约**：`document.querySelector('.file-tree [role="tree"]')` 拿得到树，
 *    对它 `focus()` 就把键盘焦点交给当前焦点行（没有焦点行时落到第一行）；
 * 2. 语义：`role="tree"` + `aria-multiselectable` + 行的 `role="treeitem"` / `aria-level` /
 *    `aria-expanded` / `aria-selected`；
 * 3. roving tabindex：整棵树只有一个 `tabIndex=0` 的停靠点；
 * 4. 键位：↑↓ / Shift+↑↓ / → / ← / Home / End / Enter / Ctrl+A / F2 的实际后果；
 * 5. **规模**：一万行的假项目，挂载行数 ≪ 总行数，且滚到任意位置挂出来的是那一段该挂的行。
 *
 * ⚠ happy-dom 不做布局：`clientHeight` 恒 0 ⇒ 视口走 `FALLBACK_VIEWPORT_H` 那一档兜底，
 * 滚动位置由测试手动写 `scrollTop` 并派发 `scroll` 事件驱动（这正是组件读的那两个数）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ErbIndex, GameProject } from '@kojo/plugin-api';
import { FileTree } from '../src/ui/FileTree';
import { getSelectedPaths, resetMultiSelectionForTest } from '../src/ui/file-tree-multi-selection';
import { resetSelectionForTest, setActivePath } from '../src/ui/file-tree-selection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KOJO = 'C:/koa/001';
const PKG = `${KOJO}/包A`;

/** 一万行的假项目：一个角色目录 · 一个作者包 · `count` 份 ERB（文件名零填充 ⇒ 顺序可读） */
function fakeProject(count: number): { project: GameProject; index: ErbIndex; files: string[] } {
  const files = Array.from({ length: count }, (_, i) => `${PKG}/M_KOJO_K1_${String(i).padStart(5, '0')}.ERB`);
  const project = {
    charaIndex: new Map([[1, { no: 1, name: '灵梦', kojoDir: KOJO }]]),
    kojoPaths: ['C:/koa'],
    rootDir: 'C:/game',
  } as unknown as GameProject;
  return { project, index: { files: new Map(files.map((f) => [f, null])), byName: new Map() } as unknown as ErbIndex, files };
}

let container: HTMLElement;
let root: Root;

interface MountOpts {
  /** 假项目的文件行数（默认一万行：虚拟化那组判据要的量级） */
  filesCount?: number;
  onOpenFile?: (p: string) => void;
  io?: unknown;
  listDir?: (dir: string) => Promise<{ name: string; path: string; isDirectory: boolean }[]>;
}

/** 把树挂起来（默认口上视图；组与包都还没展开） */
async function mount(props: MountOpts = {}): Promise<void> {
  const { project, index } = fakeProject(props.filesCount ?? 10_000);
  const onOpenFile = props.onOpenFile ?? ((): void => {});
  root = createRoot(container);
  await act(async () => {
    root.render(
      h(FileTree, {
        project,
        index,
        activeFile: null,
        onOpenFile,
        io: props.io as never,
        listDir: props.listDir as never,
      }),
    );
  });
}

const treeEl = (): HTMLElement => container.querySelector<HTMLElement>('.file-tree [role="tree"]')!;
const items = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('.file-tree [role="treeitem"]')];
const mountedFileRows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('button.tree-file[data-locate]')];
const spacers = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('.tree-vspacer')];

async function click(el: HTMLElement | null | undefined, mod: { shift?: boolean; ctrl?: boolean } = {}): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        shiftKey: mod.shift ?? false,
        ctrlKey: mod.ctrl ?? false,
      }),
    );
  });
}

async function key(k: string, mod: { shift?: boolean; ctrl?: boolean } = {}): Promise<void> {
  await act(async () => {
    treeEl().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, shiftKey: mod.shift ?? false, ctrlKey: mod.ctrl ?? false }));
  });
}

async function openGroup(): Promise<void> {
  await click(container.querySelector('button.tree-group-btn'));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  resetSelectionForTest();
  resetMultiSelectionForTest();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
});

describe('WS-11 · 语义与跨车道契约', () => {
  it('树容器找得到、说得出"这是可多选的树"', async () => {
    await mount();
    const tree = treeEl();
    expect(tree).not.toBeNull();
    expect(tree.getAttribute('aria-multiselectable')).toBe('true');
    expect(tree.tagName.toLowerCase()).toBe('ul');
  });

  it('对它 focus() ⇒ 焦点交给第一行（没有焦点行时的兜底）', async () => {
    await mount();
    await act(async () => {
      treeEl().focus();
    });
    const active = document.activeElement as HTMLElement | null;
    expect(active?.getAttribute('role')).toBe('treeitem');
    expect(active?.dataset.tid).toBe('g:#1 灵梦');
  });

  it('已有焦点行时 focus() 交回**那一行**，不是第一行', async () => {
    await mount();
    await openGroup();
    await act(async () => {
      treeEl().focus();
    });
    await key('ArrowDown'); // 组头 → 包头
    const groupHeader = items()[0];
    expect(groupHeader?.dataset.tid).toBe('g:#1 灵梦');
    expect((document.activeElement as HTMLElement).dataset.tid).toBe('p:#1 灵梦::包A');
    await act(async () => {
      treeEl().focus();
    });
    expect(document.activeElement).not.toBe(groupHeader);
    expect((document.activeElement as HTMLElement).dataset.tid).toBe('p:#1 灵梦::包A');
  });

  it('行带 role / aria-level / aria-expanded / aria-selected；层级按组 1、包 2、文件 3 读得出', async () => {
    await mount();
    await openGroup();
    const group = container.querySelector<HTMLButtonElement>('button.tree-group-btn')!;
    expect(group.getAttribute('role')).toBe('treeitem');
    expect(group.getAttribute('aria-level')).toBe('1');
    expect(group.getAttribute('aria-expanded')).toBe('true');
    const pkg = container.querySelector<HTMLButtonElement>('button.tree-package')!;
    expect(pkg.getAttribute('aria-level')).toBe('2');
    expect(pkg.getAttribute('aria-expanded')).toBe('false');
    const file = mountedFileRows()[0]!;
    expect(file.getAttribute('role')).toBe('treeitem');
    expect(file.getAttribute('aria-level')).toBe('3');
    expect(file.getAttribute('aria-selected')).toBe('false');
  });

  it('整棵树只有一个 tab 停靠点（焦点行 0、其余 -1）', async () => {
    await mount();
    await openGroup();
    await act(async () => {
      treeEl().focus();
    });
    await key('ArrowDown');
    const tabbable = items().filter((el) => el.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(document.activeElement);
    expect(items().filter((el) => el.tabIndex === -1).length).toBeGreaterThan(5);
  });
});

describe('WS-11 · 键位后果', () => {
  it('↓ / ↑ 移动焦点并把多选集带到那一行', async () => {
    await mount();
    await openGroup();
    await act(async () => {
      treeEl().focus();
    });
    expect(getSelectedPaths()).toEqual([]);
    await key('ArrowDown'); // 组头 → 包头（包头不是文件 ⇒ 集合仍然空）
    expect(getSelectedPaths()).toEqual([]);
    await key('ArrowDown'); // 包头 → 第一份文件
    expect(getSelectedPaths()).toEqual(['C:/koa/001/包A/M_KOJO_K1_00000.ERB']);
    expect(mountedFileRows()[0]?.getAttribute('aria-selected')).toBe('true');
    await key('ArrowUp'); // 回到包头 ⇒ 集合收回空（结构行没有可勾选的身份）
    expect(getSelectedPaths()).toEqual([]);
  });

  it('Shift + ↓ 连选：两行同时 aria-selected，集合是区间里的文件', async () => {
    await mount();
    await openGroup();
    await act(async () => {
      treeEl().focus();
    });
    await key('ArrowDown');
    await key('ArrowDown'); // 现在站在第一份文件上
    await key('ArrowDown', { shift: true });
    expect(getSelectedPaths()).toEqual([
      'C:/koa/001/包A/M_KOJO_K1_00000.ERB',
      'C:/koa/001/包A/M_KOJO_K1_00001.ERB',
    ]);
    expect(container.querySelectorAll('[aria-selected="true"]').length).toBe(2);
  });

  it('→ 进子层 / ← 收起与回父层', async () => {
    await mount();
    await openGroup();
    await act(async () => {
      treeEl().focus();
    });
    await key('ArrowRight'); // 组头（已展开）→ 第一个子行 = 包头
    expect((document.activeElement as HTMLElement).dataset.tid).toBe('p:#1 灵梦::包A');
    await key('ArrowRight'); // 包还没点开真实文件夹 ⇒ 这次是展开
    expect(container.querySelector('button.tree-package')?.getAttribute('aria-expanded')).toBe('true');
    await key('ArrowLeft'); // 焦点在包头上 ⇒ 收起
    expect(container.querySelector('button.tree-package')?.getAttribute('aria-expanded')).toBe('false');
    await key('ArrowLeft'); // 再按 ⇒ 回父层（组头）
    expect((document.activeElement as HTMLElement).dataset.tid).toBe('g:#1 灵梦');
  });

  it('Home / End 落到首末行（End 那行原本还在窗口外，靠滚动把它接住）', async () => {
    await mount();
    await openGroup();
    await act(async () => {
      treeEl().focus();
    });
    await key('End');
    const last = (document.activeElement as HTMLElement) ?? null;
    expect(last?.getAttribute('role')).toBe('treeitem');
    expect(last?.dataset.tid).toBe('C:/koa/001/包A/M_KOJO_K1_09999.ERB');
    await key('Home');
    expect((document.activeElement as HTMLElement).dataset.tid).toBe('g:#1 灵梦');
  });

  it('Enter 打开当前文件；Space 同一条腿', async () => {
    const opened: string[] = [];
    await mount({ onOpenFile: (p: string) => opened.push(p) });
    await openGroup();
    await act(async () => {
      treeEl().focus();
    });
    await key('ArrowDown'); // 组头 → 包头
    await key('ArrowDown'); // 包头 → 第一份文件
    await key('Enter');
    expect(opened).toEqual(['C:/koa/001/包A/M_KOJO_K1_00000.ERB']);
    await key('ArrowDown');
    await key(' ');
    expect(opened).toHaveLength(2);
  });

  it('Ctrl + A 只把**当前可见**的行收进集合（裁掉的行不进）', async () => {
    await mount();
    await openGroup();
    await act(async () => {
      treeEl().focus();
    });
    await key('a', { ctrl: true });
    const selected = getSelectedPaths();
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(200); // 一万行里只选了窗口那一段
    expect(selected).toContain('C:/koa/001/包A/M_KOJO_K1_00000.ERB');
  });

  it('F2 走既有行内重命名链路（输入框出现在被命名的那一行）', async () => {
    await mount();
    await openGroup();
    await act(async () => {
      treeEl().focus();
    });
    await key('ArrowDown');
    await key('ArrowDown');
    await key('F2');
    expect(container.querySelectorAll('.tree-edit-input')).toHaveLength(1);
  });

  it('表外的键不接管：Ctrl+S 之类既不 preventDefault 也不动焦点', async () => {
    await mount();
    await openGroup();
    await act(async () => {
      treeEl().focus();
    });
    await key('ArrowDown');
    const before = (document.activeElement as HTMLElement).dataset.tid;
    const handled = await act(async () => {
      const e = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
      treeEl().dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(handled).toBe(false);
    expect((document.activeElement as HTMLElement).dataset.tid).toBe(before);
  });

  it('行内编辑输入框里的键不被树抢走（Enter 归输入框）', async () => {
    await mount();
    await openGroup();
    await act(async () => {
      treeEl().focus();
    });
    await key('ArrowDown');
    await key('ArrowDown');
    await key('F2');
    const input = container.querySelector<HTMLInputElement>('.tree-edit-input')!;
    const tid = (document.activeElement as HTMLElement).dataset.tid;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    expect((document.activeElement as HTMLElement).dataset.tid).toBe(tid); // 焦点还在编辑框那格
  });
});

describe('WS-12 · 一万行的挂载规模', () => {
  it('挂载行数 ≪ 总行数，且由垫高行补回被裁的高度', async () => {
    await mount({ filesCount: 10_000 });
    await openGroup();
    const fileRows = mountedFileRows().length;
    expect(fileRows).toBeGreaterThan(0);
    expect(fileRows).toBeLessThan(80); // 兜底视口那档：30 行 + overscan，远小于 10,000
    const sp = spacers();
    expect(sp.length).toBeGreaterThan(0);
    const padPx = sp.reduce((n, el) => n + Number.parseFloat(el.style.height || '0'), 0);
    // 恒等式：**挂出来的行 + 垫高 = 整块的真实高度**（一万行 × 22px，一行不多一行不少）
    expect(padPx + fileRows * 22).toBe(10_000 * 22);
    expect(sp.every((el) => el.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  it('滚到任意位置 ⇒ 挂出来的是那一段该挂的行（不是开头、也不是空屏）', async () => {
    await mount({ filesCount: 10_000 });
    await openGroup();
    const tree = treeEl();
    await act(async () => {
      // 跳到第 5,000 行附近：行头 = 组头 + 包头 ⇒ 文件序号 = (scrollTop/22) - 2
      tree.scrollTop = 5_000 * 22;
      tree.dispatchEvent(new Event('scroll'));
    });
    const rows = mountedFileRows();
    expect(rows.length).toBeGreaterThan(0);
    const expectTid = 'C:/koa/001/包A/M_KOJO_K1_04998.ERB';
    expect(rows.some((el) => el.dataset.locate === expectTid)).toBe(true);
    expect(rows.some((el) => el.dataset.locate === 'C:/koa/001/包A/M_KOJO_K1_00000.ERB')).toBe(false);
    expect(rows.some((el) => el.dataset.locate === 'C:/koa/001/包A/M_KOJO_K1_09999.ERB')).toBe(false);
  });

  it('结构行（组头 / 包头）常驻不裁，叶子行才进窗口', async () => {
    await mount({ filesCount: 10_000 });
    await openGroup();
    expect(container.querySelectorAll('button.tree-group-btn')).toHaveLength(1);
    expect(container.querySelectorAll('button.tree-package')).toHaveLength(1);
    // 说明：包还没点开真实文件夹 ⇒ 没有 DirRows 层，叶子块就是那一份 ERB 列表
    expect(spacers().length).toBeGreaterThan(0);
  });

  it('展开作者包的真实文件夹层不改挂载规模（目录层按现场展开，行数仍受窗口约束）', async () => {
    const listDir = async (dir: string) => [
      { name: 'sub', path: `${dir}/sub`, isDirectory: true },
      { name: 'readme.txt', path: `${dir}/readme.txt`, isDirectory: false },
    ];
    await mount({ filesCount: 10_000, listDir });
    await openGroup();
    await click(container.querySelector('button.tree-package'));
    await act(async () => {});
    expect(container.querySelectorAll('button.tree-file[data-locate]').length).toBeLessThan(120);
    const dir = container.querySelector<HTMLButtonElement>('button.tree-dir');
    expect(dir?.getAttribute('role')).toBe('treeitem');
    expect(dir?.getAttribute('aria-level')).toBe('3');
    expect(dir?.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('WS-12 · 展开/收起的视口不跳', () => {
  /**
   * 鼠标那一条腿：**点开哪一行，停在原处的就是哪一行**。
   *
   * 这里旧判据钉的是"按改前的焦点行补量"（`scrollTop = 2 × 22`），那是把两条判据拧成了一股反绳：
   * ① `planRowClick`（WS-11 鼠标侧，本文件上面那组已经钉绿）说**纯单击 ⇒ 焦点落到被点那一行**；
   * ② 锚点自己的口径（`FileTree` 的 WS-12 那段）说"焦点换了 = 作者已经不盯它了"⇒ 锚点跟着焦点走。
   * 点击落在包头上时，插进来的两行在**它下面** ⇒ 该补的量恒为 0；补 44 反而把作者刚点的那一行
   * 从鼠标底下顶出去（真语料里一个包二十几行就是五百多像素，直接顶出视口），
   * 与浏览器自己的 scroll anchoring（内容插在锚点下面就不动）正好相反。
   *
   * ⚠ 旧的第二条断言 `mountedFileRows()[0]` 在这个场景里也永远对不上：包的真实文件夹一展开，
   * `ul.pkg-real` 里的 a.txt / b.txt 本身就是 `button.tree-file[data-locate]`，排在 ERB 列表**前面**
   * ⇒ 第一枚挂载的文件行必然是 a.txt，与 scrollTop 一个字都没关系。改成按行号查——
   * "锚点行前面正好多了两行"既证明了这次真在锚点上面插了行（于是"视口不动"不是空断言），
   * 也仍然钉住锚点行没被虚拟化裁走。
   */
  it('鼠标点开真实文件夹：焦点随点击换到被点那一行 ⇒ 视口跟着它停住（插在它下面的行不拽视口）', async () => {
    const listDir = async (dir: string) => [
      { name: 'a.txt', path: `${dir}/a.txt`, isDirectory: false },
      { name: 'b.txt', path: `${dir}/b.txt`, isDirectory: false },
    ];
    await mount({ filesCount: 300, listDir });
    await openGroup();
    await act(async () => {
      treeEl().focus();
    });
    await key('ArrowDown'); // → 包头
    await key('ArrowDown'); // → 第一份 ERB（改前的焦点行）
    expect(treeEl().scrollTop).toBe(0);
    const anchorLocate = mountedFileRows()[0]?.dataset.locate;
    // 点开包的真实文件夹：两行目录内容插在改前的焦点行**上面**
    await click(container.querySelector('button.tree-package'));
    await act(async () => {});
    // 焦点确实随点击换成了被点的包头（锚点因此跟着它走，不再认原来那一行）
    expect(items().find((el) => el.tabIndex === 0)?.dataset.tid).toBe('p:#1 灵梦::包A');
    // 原来那一行还在窗口里，而且前面正好多了两行 ⇒ 插行是真的，视口却没跟着走
    expect(mountedFileRows().findIndex((el) => el.dataset.locate === anchorLocate)).toBe(2);
    expect(treeEl().scrollTop).toBe(0);
  });

  /**
   * 键盘 / 异步那一条腿——**这才是"补同样的量"的现场**：焦点行一个字没动，
   * 内容却从它上面落下来（上一层的列举还在途、锚点续期到焦点行身上）。
   *
   * 场景按真语料的形态排：包里两个子目录 `subA`（列举挂住在途）与 `subB`；
   * 键盘依次点开包 → 点开 subA（只露「读取目录…」一行）→ 焦点下到 subB → 点开 subB；
   * 此刻 subA 的清单才落地，把那一格说明行换成三行 ⇒ subB（焦点行）上面净多两行。
   * 全程只有按键与异步回执、没有鼠标 ⇒ 焦点一直是 subB，锚点保持那条腿必须补出 2 × 22px。
   */
  it('焦点行不动、它上面的列举异步落地 ⇒ scrollTop 正好补进插进来的那两行（锚点续期那条腿）', async () => {
    type Entry = { name: string; path: string; isDirectory: boolean };
    const SUB_A = `${PKG}/subA`;
    const SUB_B = `${PKG}/subB`;
    let releaseSubA: ((v: Entry[]) => void) | null = null;
    const listDir = (dir: string): Promise<Entry[]> => {
      if (dir === PKG) {
        return Promise.resolve([
          { name: 'subA', path: SUB_A, isDirectory: true },
          { name: 'subB', path: SUB_B, isDirectory: true },
        ]);
      }
      if (dir === SUB_A) {
        // 故意挂住：这一层的列举跨越好几帧才回来，正是"锚点续期"要接的那一段
        return new Promise<Entry[]>((resolve) => {
          releaseSubA = resolve;
        });
      }
      return Promise.resolve([]);
    };
    await mount({ filesCount: 300, listDir });
    await openGroup();
    await act(async () => {
      treeEl().focus();
    });
    await key('ArrowDown'); // → 包头
    await key('ArrowRight'); // 键盘点开真实文件夹（锚点 = 包头，插在它下面 ⇒ 视口不动）
    await key('ArrowDown'); // → subA
    await key('ArrowRight'); // 点开 subA：这层还在途，只露「读取目录…」一行
    await key('ArrowDown'); // → subB（说明行不是树项，焦点跨过它落到下一格）
    await key('ArrowRight'); // 点开 subB；此刻 subA 还在途 ⇒ 锚点续期在 subB 身上
    await act(async () => {});
    expect(treeEl().scrollTop).toBe(0);
    expect(items().find((el) => el.tabIndex === 0)?.dataset.tid).toBe(SUB_B);
    // subA 的清单落地：三行取代那一格说明行 ⇒ 焦点行上面净多 2 × 22px
    await act(async () => {
      releaseSubA?.([
        { name: 'g1.txt', path: `${SUB_A}/g1.txt`, isDirectory: false },
        { name: 'g2.txt', path: `${SUB_A}/g2.txt`, isDirectory: false },
        { name: 'g3.txt', path: `${SUB_A}/g3.txt`, isDirectory: false },
      ]);
      releaseSubA = null;
    });
    await act(async () => {});
    // 锚点行的视口内偏移保持不变：行模型把它往下推 44px ⇒ scrollTop 正好补 44px
    expect(treeEl().scrollTop).toBe(2 * 22);
    // 补量之后焦点仍在 subB（补的是视口，不是把焦点交出去）
    expect(items().find((el) => el.tabIndex === 0)?.dataset.tid).toBe(SUB_B);
  });
});

describe('多选与鼠标连选', () => {
  it('Shift + 点击 ⇒ 从锚点连选到被点那一行，且不打开文件', async () => {
    const opened: string[] = [];
    await mount({ filesCount: 300, onOpenFile: (p: string) => opened.push(p) });
    await openGroup();
    const rows = mountedFileRows();
    await click(rows[0]); // 纯单击：打开 + 焦点落这一行（连选锚点）
    await click(rows[2], { shift: true });
    expect(opened).toHaveLength(1); // Shift 那一次不打开
    expect(getSelectedPaths()).toEqual([
      rows[0]?.dataset.locate,
      rows[1]?.dataset.locate,
      rows[2]?.dataset.locate,
    ]);
  });

  it('Ctrl + 点击保留既有的勾选集（旧口径一字不动）', async () => {
    await mount({ filesCount: 300 });
    await openGroup();
    const rows = mountedFileRows();
    await click(rows[0]);
    await act(async () => {
      rows[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    expect(getSelectedPaths()).toHaveLength(2);
  });
});

describe('活动文件仍然点亮那一行（既有语义不因本批回退）', () => {
  it('aria-current 只有一枚，且与 .active 同源', async () => {
    await mount({ filesCount: 300 });
    await openGroup();
    await act(async () => {
      setActivePath('C:/koa/001/包A/M_KOJO_K1_00001.ERB');
    });
    const active = container.querySelectorAll('.tree-file.active');
    expect(active).toHaveLength(1);
    expect(container.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  });
});
