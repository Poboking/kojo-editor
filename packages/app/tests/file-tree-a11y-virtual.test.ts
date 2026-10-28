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
import { GAP_GROUP_UL, GAP_NESTED_UL, TREE_ROW_H } from '../src/ui/file-tree-flat';
import { FileTree } from '../src/ui/FileTree';
import { getSelectedPaths, resetMultiSelectionForTest } from '../src/ui/file-tree-multi-selection';
import { resetSelectionForTest, setActivePath } from '../src/ui/file-tree-selection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KOJO = 'C:/koa/001';
const PKG = `${KOJO}/包A`;

/** 角色目录键：`#<no> <名>`（组头 tid 与包键都从它派生，测试里要按它点名） */
const kojoDirOf = (no: number): string => `C:/koa/${String(no).padStart(3, '0')}`;
/**
 * 角色名：第一枚沿用旧夹具的「灵梦」——本文件已有 26 条判据按 `g:#1 灵梦` /
 * `p:#1 灵梦::包A` 点名行号，改名字就是无谓地把它们全搬一遍；多组只往后加。
 */
const nameOf = (no: number): string => (no === 1 ? '灵梦' : `角色${no}`);
const labelOf = (no: number): string => `#${no} ${nameOf(no)}`;

/**
 * `count` 行假项目 × `groups` 个角色目录 × `pkgs` 个作者包。
 *
 * 一角色一包就看不出**整包被裁**这一档（窗口落进这个包 = 这个包相交，同组别的包压根没有），
 * 所以三层裁切那组判据要 `pkgs >= 2`：窗口停在包 A 里，包 B 整段在下方 ⇒ 必须换成一条占位。
 * 默认一包 ⇒ 旧夹具的路径与行号点名一个字都不动。
 */
function fakeProject(count: number, groups = 1, pkgs = 1): { project: GameProject; index: ErbIndex; files: string[] } {
  const charaIndex = new Map<number, { no: number; name: string; kojoDir: string }>();
  const files: string[] = [];
  for (let no = 1; no <= groups; no++) {
    const dir = kojoDirOf(no);
    charaIndex.set(no, { no, name: nameOf(no), kojoDir: dir });
    for (let p = 0; p < pkgs; p++) {
      const pkgLabel = `包${String.fromCharCode(65 + p)}`;
      // 单包夹具不给文件名加字母（旧 26 条判据按 `M_KOJO_K1_00000.ERB` 点名行号）
      const infix = pkgs > 1 ? String.fromCharCode(97 + p) : '';
      for (let i = 0; i < count; i++) files.push(`${dir}/${pkgLabel}/M_KOJO_K${no}_${infix}${String(i).padStart(5, '0')}.ERB`);
    }
  }
  const project = {
    charaIndex,
    kojoPaths: ['C:/koa'],
    rootDir: 'C:/game',
  } as unknown as GameProject;
  return { project, index: { files: new Map(files.map((f) => [f, null])), byName: new Map() } as unknown as ErbIndex, files };
}

let container: HTMLElement;
let root: Root;

interface MountOpts {
  /** 假项目每包的行数量（默认一万行：虚拟化那组判据要的量级） */
  filesCount?: number;
  /** 角色目录枚数（默认 1；三层裁切那组判据要"很多组"才看得出组头被裁） */
  groups?: number;
  /** 每个角色的作者包枚数（默认 1；>=2 才出得来"同组里整包被裁"那一档） */
  pkgs?: number;
  onOpenFile?: (p: string) => void;
  io?: unknown;
  listDir?: (dir: string) => Promise<{ name: string; path: string; isDirectory: boolean }[]>;
}

/** 把树挂起来（默认口上视图；组与包都还没展开） */
async function mount(props: MountOpts = {}): Promise<void> {
  const { project, index } = fakeProject(props.filesCount ?? 10_000, props.groups, props.pkgs);
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

/** 滚到某一像素位（happy-dom 不做布局：`clientHeight` 恒 0 ⇒ 视口走兜底那一档，滚动位只能手给） */
async function scrollToTop(px: number): Promise<void> {
  await act(async () => {
    const body = treeEl();
    body.scrollTop = px;
    body.dispatchEvent(new Event('scroll'));
  });
}

/**
 * 把所有组都点开（三层裁切那组判据的前置现场）。
 *
 * ⚠ 三条都是本批 DOM 形状逼出来的，不是测试风格问题：
 * - **不能一次快照全点掉**：组头自己现在也会进裁切窗口，快照里深位置那几枚在点下去之前就已经
 *   脱离 DOM（React 的事件挂在根容器上，脱落的节点收不到 click）⇒ 每轮只点"此刻还挂在 DOM 里
 *   且收起着"的那一枚，点完重新查；
 * - **不能拿挂载数当"开完了"的判据**：全展开之后挂载窗口里本来就只剩几枚组头，
 *   数得出的是"我点过几枚"，所以自己记账；
 * - 一屏装不下整棵 ⇒ 没有收起的组头了就往下滚一档接着点（步长远小于窗口覆盖的行数，
 *   不会有组头被跨过去）。开不到 `expect` 枚 ⇒ 直接红，不许静默少开几组。
 */
async function openAllGroups(expect: number, totalPx: number): Promise<void> {
  const opened = new Set<string>();
  const step = 440;
  for (let guard = 0; guard < 800; guard++) {
    const closed = [...container.querySelectorAll<HTMLButtonElement>('button.tree-group-btn[aria-expanded="false"]')];
    const next = closed.find((el) => !opened.has(el.dataset.tid ?? ''));
    if (next !== undefined) {
      opened.add(next.dataset.tid ?? '');
      await click(next);
      continue;
    }
    const body = treeEl();
    if (body.scrollTop + body.clientHeight >= totalPx) break;
    await scrollToTop(body.scrollTop + step);
  }
  if (opened.size !== expect) throw new Error(`展不到底：点到 ${opened.size} 枚组头，现场该有 ${expect} 枚`);
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

  /**
   * WS-12 欠账批**改判据**（为什么改写在测试名之外还得写一遍）：
   *
   * 旧那条钉的是「Ctrl+A 只把当前可见的行收进集合（裁掉的行不进）」——WS-11 写它的时候
   * "窗口外的行"还不存在，行模型就是 DOM。之后两件事都变了：虚拟化让窗口只覆盖 2,689 行里的
   * 三十几行（真壳改前实测：滚到深处按一次 Ctrl+A 只收 21 枚），而 WS-13 把这份勾选集直接喂给
   * 复制 / 剪切 / **删除**。于是"全选"收眼前一屏就是说谎，而且是一把会误伤的刀。
   * 现在口径反过来：**整个行模型里所有可勾选的行**，与挂不挂载无关；DOM 侧只点亮挂得出来的那几枚。
   */
  it('Ctrl + A 收整个行模型里的可勾选行（不是眼前那一屏），勾选态只点亮挂得出来的那几枚', async () => {
    await mount();
    await openGroup();
    await act(async () => {
      treeEl().focus();
    });
    await key('a', { ctrl: true });
    const selected = getSelectedPaths();
    expect(selected).toHaveLength(10_000);
    expect(selected).toContain('C:/koa/001/包A/M_KOJO_K1_00000.ERB');
    expect(selected).toContain('C:/koa/001/包A/M_KOJO_K1_09999.ERB'); // 窗口两端之外的行也在
    // 挂载的那几十枚点亮，其余留在集合里等滚回来点亮
    const lit = container.querySelectorAll('[aria-selected="true"]').length;
    expect(lit).toBeGreaterThan(0);
    expect(lit).toBeLessThan(60);
    // 回执要说总数（不许只说"已全选"）
    expect(container.querySelector('.tree-reveal-note')?.textContent).toContain('10000');
  });

  it('滚到深处再 Ctrl + A：收的还是整棵树，不是那一段窗口', async () => {
    await mount();
    await openGroup();
    await scrollToTop(5_000 * TREE_ROW_H);
    await act(async () => {
      treeEl().focus();
    });
    await key('a', { ctrl: true });
    const selected = getSelectedPaths();
    expect(selected).toHaveLength(10_000);
    expect(selected[0]).toBe('C:/koa/001/包A/M_KOJO_K1_00000.ERB'); // 从第一行起，跟视口位置无关
    expect(container.querySelector('[data-locate="C:/koa/001/包A/M_KOJO_K1_00000.ERB"]')).toBeNull(); // 那行压根没挂
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

  /**
   * WS-12 欠账批**改判据**（为什么改写在这里，不许当成"为绿放宽"）：
   *
   * 旧的那条钉的是"结构行（组头 / 包头）常驻不裁，叶子行才进窗口"。那是当初的取舍，
   * 真壳读数把它推翻了：eraNAS 136 组全展开、滚到 scrollTop=30,000 时挂 319 枚 treeitem，
   * 其中**文件行只有 28 枚**，其余 291 枚全是恒挂载的组头与包头（136 + 155）——
   * 组数与包数同样是索引一次灌进来的，规模并不由作者的展开动作约束，
   * 于是"虚拟化"在最长的这两类行上根本没生效。
   *
   * 本批把裁点上提到三层（组 / 包 / 平铺 ERB），所以这条判据的方向**反过来**：
   * 深滚时视口之外的结构行也必须一枚都不挂。而"在窗口里就得挂得出来"那条腿由下面
   * 第一条钉住——裁的依据是视口位置，不是行的种类。
   */
  it('窗口顶部：组头与包头照旧挂得出来（裁的是视口之外，不是某一类行）', async () => {
    await mount({ filesCount: 10_000 });
    await openGroup();
    expect(container.querySelectorAll('button.tree-group-btn')).toHaveLength(1);
    expect(container.querySelectorAll('button.tree-package')).toHaveLength(1);
    // 说明：包还没点开真实文件夹 ⇒ 没有 DirRows 层，叶子块就是那一份 ERB 列表
    expect(spacers().length).toBeGreaterThan(0);
  });

  it('深滚：视口之外的组头与包头一枚都不挂（改前恒挂 60 枚结构行的那格）', async () => {
    const G = 30;
    const K = 8;
    const P = 2;
    // 每组：组头 + P 个（包头 + K 份 ERB），外加 P 档包列表 2px 与组列表 4px
    const perGroup = (1 + P * (1 + K)) * TREE_ROW_H + P * GAP_NESTED_UL + GAP_GROUP_UL;
    await mount({ filesCount: K, groups: G, pkgs: P });
    await openAllGroups(G, G * perGroup);
    await scrollToTop(15 * perGroup);
    const mounted = items();
    // 改前：30 枚组头 + 60 枚包头恒挂载；现在整棵树只许挂窗口那一段
    expect(container.querySelectorAll('button.tree-group-btn').length).toBeLessThan(6);
    expect(container.querySelectorAll('button.tree-package').length).toBeLessThan(12);
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(60);
    // 视口上方那一组的组头与包头确实不在 DOM 里（不是"挂了但看不见"）
    expect(container.querySelector('[data-tid="g:#1 灵梦"]')).toBeNull();
    expect(container.querySelector(`[data-tid="p:${labelOf(1)}::包A"]`)).toBeNull();
    // 整组被裁 ⇒ 一条等高占位替掉整个 li.tree-group（挂在树根 ul 上，不带 data-open）
    expect(container.querySelectorAll('.tree-groups > li.tree-vspacer').length).toBeGreaterThan(0);
    // 同组里"窗口停在包 A、包 B 整段在下方"那一档 ⇒ 占位挂在组的 ul 里，不是包 li
    // （这一档的**包级**判决由下面那条"长组中段"钉：短组夹具里窗口一次盖住两组多，
    //   出不了"同组内有包整个在窗口外"的现场，摘掉包级裁切也照样绿——量测装置自己得先能测到）
    expect(container.querySelectorAll('.tree-files > li.tree-vspacer').length).toBeGreaterThan(0);
    // roving tabindex：裁掉行之后仍然最多一个停靠点，且占位一枚都不带 role=treeitem
    expect(mounted.filter((el) => el.tabIndex === 0)).toHaveLength(1);
    expect(container.querySelectorAll('.tree-vspacer[role="treeitem"]').length).toBe(0);
  });

  it('长组中段：只挂文件行，同组里窗口之外的那个包整段不挂 li', async () => {
    const G = 3;
    const K = 200;
    const P = 2;
    /**
     * 组必须比窗口**高**才量得出第二层裁点：窗口（约 40 行）落在包 A 的文件中间时，
     * 包 B 整段在窗口下方 ⇒ 该挂一条占位，而不是"挂个 li、里面全是占位"。
     * （这一条是变异自检逼出来的：先写的版本用"每组 19 行"的短组夹具，
     * 窗口一次盖住两组多，摘掉包级裁切照样绿——那种现场根本出不了"同组内有包在窗口外"。）
     */
    const perGroup = (1 + P * (1 + K)) * TREE_ROW_H + P * GAP_NESTED_UL + GAP_GROUP_UL;
    await mount({ filesCount: K, groups: G, pkgs: P });
    await openAllGroups(G, G * perGroup);
    await scrollToTop(perGroup + 2_200);
    expect(container.querySelectorAll('button.tree-group-btn')).toHaveLength(0);
    expect(container.querySelectorAll('button.tree-package')).toHaveLength(0);
    const mounted = items();
    expect(mounted.length).toBeGreaterThan(0);
    // 挂出来的 treeitem 全是文件行——这正是"改前 360 枚里只有 31 枚是文件行"那个形状的反面
    expect(mounted.every((el) => el.classList.contains('tree-file'))).toBe(true);
    // 三个组里只有第二个的 li 挂得出来，而它里面也只有窗口经过的那一个包挂 li
    expect(container.querySelectorAll('li.tree-group').length).toBe(1);
    expect(container.querySelectorAll('li.tree-package-node').length).toBe(1);
    // 组头 / 两个包头那三格由等高占位与整段占位顶上：整模型高度一分不变
    const padPx = spacers().reduce((n, el) => n + Number.parseFloat(el.style.height || '0'), 0);
    const gapPx =
      container.querySelectorAll('.tree-groups > li.tree-group[data-open="1"]').length * GAP_GROUP_UL +
      container.querySelectorAll('li.tree-package-node').length * GAP_NESTED_UL;
    expect(padPx + mounted.length * TREE_ROW_H + gapPx).toBe(G * perGroup);
  });

  it('三层都裁 ⇒ scrollHeight 恒等于整模型高度（任何窗口位置一分不差）', async () => {
    const G = 6;
    const K = 12;
    const P = 3;
    // 每组：组头 + P 个（包头 + K 份 ERB）+ P 档 2px + 一档 4px；窗口约 40 行 ⇒ 组与包两档都被裁到
    const perGroup = (1 + P * (1 + K)) * TREE_ROW_H + P * GAP_NESTED_UL + GAP_GROUP_UL;
    const total = G * perGroup;
    await mount({ filesCount: K, groups: G, pkgs: P });
    await openAllGroups(G, total);
    for (const px of [0, 300, perGroup + 40, perGroup * 3, total]) {
      await scrollToTop(px);
      const padPx = spacers().reduce((n, el) => n + Number.parseFloat(el.style.height || '0'), 0);
      const rowsPx = (items().length + container.querySelectorAll('.tree-note').length) * TREE_ROW_H;
      // 常驻的 ul 带缝：展开着的组各一档 4px、挂出来的包各一档 2px（整段被裁的已在 padPx 里）
      const gapPx =
        container.querySelectorAll('.tree-groups > li.tree-group[data-open="1"]').length * GAP_GROUP_UL +
        container.querySelectorAll('li.tree-package-node').length * GAP_NESTED_UL;
      expect(`${px}:${padPx + rowsPx + gapPx}`).toBe(`${px}:${total}`);
    }
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

/**
 * D-1 收尾批的两条遗留腿（本组是这两条的**首证**，旧组一条都不动）：
 *
 * 1. **重列（relistShown）**：失效信号 / 手动「重新读取」触发的重列，清单**变长**才见得出跳
 *    ——新行插在焦点行上面，浏览器只保 scrollTop 不保行。捕获补在 `relistShown()` 开头
 *    （HK-5 的 nonce effect 与 `relist` 菜单分支共用这条），落地那一帧由恢复侧补 N × 22。
 * 2. **定位（runLocate）**：请求还没落定时（等行模型追上）展开插行不许把视口从焦点行拽走；
 *    落定那一拍的滚动归定位自己 ⇒ 当场作废锚点。这里的现场按"落定后不需要新滚动"排
 *    （目标行展开后正好落在补偿出的视口顶），跳没跳一眼可辨。
 */
describe('D-1 收尾批 · 重列与定位的视口不跳', () => {
  type Entry = { name: string; path: string; isDirectory: boolean };

  /** 一块可变的包目录清单：第一次列举给 1 行、重列给 5 行 ⇒「清单变长」是造出来的事实 */
  function grownListing(): { listDir: (dir: string) => Promise<Entry[]>; calls: () => number } {
    let n = 0;
    const listDir = async (dir: string): Promise<Entry[]> => {
      if (dir !== PKG) return [];
      n += 1;
      if (n === 1) return [{ name: 'a.txt', path: `${PKG}/a.txt`, isDirectory: false }];
      return ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map((name) => ({ name, path: `${PKG}/${name}`, isDirectory: false }));
    };
    return { listDir, calls: () => n };
  }

  it('重列清单变长、四行插在焦点行上面 ⇒ scrollTop 正好补 4 × 22（relistShown 的捕获腿）', async () => {
    const { listDir, calls } = grownListing();
    // refreshNonce 由 0 起步：下面抬到 1 就是 HK-5 的那一发失效信号
    const { project, index } = fakeProject(300);
    const treeElement = (nonce: number) =>
      h(FileTree, { project, index, activeFile: null, onOpenFile: (): void => {}, listDir: listDir as never, refreshNonce: nonce });
    root = createRoot(container);
    await act(async () => {
      root.render(treeElement(0));
    });
    await openGroup();
    await act(async () => {
      treeEl().focus();
    });
    await key('ArrowDown'); // 组头 → 包头
    await key('ArrowRight'); // 键盘点开真实文件夹（此刻这层只有 a.txt 一行）
    await act(async () => {});
    expect(calls()).toBe(1);
    await key('ArrowDown'); // → a.txt
    await key('ArrowDown'); // → 第一份 ERB（焦点行：真实文件夹的行列在它**上面**）
    expect(treeEl().scrollTop).toBe(0);
    // 失效信号：nonce 抬一格 → relistShown 重列 → 清单从 1 行长成 5 行（净多 4 行插在焦点行上面）
    await act(async () => {
      root.render(treeElement(1));
    });
    await act(async () => {});
    expect(calls()).toBe(2);
    expect(treeEl().scrollTop).toBe(4 * 22);
    // 补的是视口，焦点没被交出去：还站在第一份 ERB 上
    expect(items().find((el) => el.tabIndex === 0)?.dataset.tid).toBe('C:/koa/001/包A/M_KOJO_K1_00000.ERB');
  });

  /**
   * 真壳实测抓出的洞（E2E 复现后补的判据）：`relistShown` 捕获锚点后、响应落地前，
   * 树**还会经历别的渲染**（手动「重读」那支点完就 setState 写回执；用户也可能顺手滚一格）。
   * 一次性锚点会被那一帧白白吃掉，真清单回来插行时反而没人补量——恢复侧必须认
   * 「重列批在途」这份续期理由（cached 目录的重列没有 loading 那一格可认）。
   */
  it('重列在途时先落一发无关渲染（滚一格）⇒ 锚点续期，清单落地照样补 4 × 22', async () => {
    type Entry = { name: string; path: string; isDirectory: boolean };
    let releaseGrown: ((v: Entry[]) => void) | null = null;
    let calls = 0;
    const listDir = (dir: string): Promise<Entry[]> => {
      if (dir !== PKG) return Promise.resolve([]);
      calls += 1;
      if (calls === 1) {
        return Promise.resolve([{ name: 'a.txt', path: `${PKG}/a.txt`, isDirectory: false }]);
      }
      // 重列那一发挂住：先把"响应落地前的中间渲染"演出来
      return new Promise<Entry[]>((resolve) => {
        releaseGrown = resolve;
      });
    };
    const { project, index } = fakeProject(300);
    const treeElement = (nonce: number) =>
      h(FileTree, { project, index, activeFile: null, onOpenFile: (): void => {}, listDir: listDir as never, refreshNonce: nonce });
    root = createRoot(container);
    await act(async () => {
      root.render(treeElement(0));
    });
    await openGroup();
    await act(async () => {
      treeEl().focus();
    });
    await key('ArrowDown'); // → 包头
    await key('ArrowRight'); // 点开真实文件夹（1 行清单已落）
    await act(async () => {});
    await key('ArrowDown'); // → a.txt
    await key('ArrowDown'); // → 第一份 ERB（焦点行）
    expect(treeEl().scrollTop).toBe(0);
    // 失效信号：捕获锚点、重列请求挂住在途
    await act(async () => {
      root.render(treeElement(1));
    });
    // 响应没回来的这一拍里先来一发中间渲染：滚一格 ⇒ 消费掉一次性锚点（恢复回原位）——
    // 没有「重列在途续期」这条腿，真清单回来时就没有锚点可补了
    await act(async () => {
      treeEl().scrollTop = 10;
      treeEl().dispatchEvent(new Event('scroll'));
    });
    await act(async () => {});
    // 放行 grown 清单（1 行 → 5 行：四行插在焦点行上面）
    await act(async () => {
      releaseGrown?.(
        ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map((name) => ({ name, path: `${PKG}/${name}`, isDirectory: false })),
      );
      releaseGrown = null;
    });
    await act(async () => {});
    expect(treeEl().scrollTop).toBe(4 * 22);
    expect(items().find((el) => el.tabIndex === 0)?.dataset.tid).toBe('C:/koa/001/包A/M_KOJO_K1_00000.ERB');
  });

  /**
   * 两个角色组的现场：gA 折叠、gB 展开且焦点在 gB 头行；定位 gA 里的文件 ⇒
   * 展开 gA 把「包头 + a1」两行插在焦点行上面。落定后 a1 正好在补出来的视口顶
   * （不需要新滚动）——44px 只可能来自锚点补偿，摘掉捕获或恢复任何一条都回到 0。
   */
  it('定位要展开焦点行上面的组 ⇒ scrollTop 正好补 2 × 22，落定后焦点交给目标行（runLocate 的捕获腿）', async () => {
    const KOJO_A = 'C:/koa/001';
    const KOJO_B = 'C:/koa/002';
    const A1 = `${KOJO_A}/包A/a1.ERB`;
    const project = {
      charaIndex: new Map([
        [1, { no: 1, name: '灵梦', kojoDir: KOJO_A }],
        [2, { no: 2, name: '妖梦', kojoDir: KOJO_B }],
      ]),
      kojoPaths: ['C:/koa'],
      rootDir: 'C:/game',
    } as unknown as GameProject;
    const index = {
      files: new Map([A1, `${KOJO_B}/包B/b1.ERB`, `${KOJO_B}/包B/b2.ERB`].map((f) => [f, null])),
      byName: new Map(),
    } as unknown as ErbIndex;
    root = createRoot(container);
    await act(async () => {
      root.render(h(FileTree, { project, index, activeFile: null, onOpenFile: (): void => {} }));
    });
    // 只展开 gB（第二个组头）：此刻行序 = [gA 头, gB 头, gB 包, b1, b2]，焦点随点击落在 gB 头
    const groupHeads = container.querySelectorAll<HTMLButtonElement>('button.tree-group-btn');
    expect(groupHeads.length).toBe(2);
    await click(groupHeads[1] as HTMLElement);
    expect(items().find((el) => el.tabIndex === 0)?.dataset.tid).toBe('g:#2 妖梦');
    expect(treeEl().scrollTop).toBe(0);
    // 定位请求：gA 里那份文件——展开 gA 会在焦点行（gB 头）上面插两行
    await act(async () => {
      setActivePath(A1);
    });
    await act(async () => {});
    expect(treeEl().scrollTop).toBe(2 * 22);
    // 落定的语义没被锚点拖住：焦点行交给目标文件本身
    expect(items().find((el) => el.tabIndex === 0)?.dataset.tid).toBe(A1);
    // 原焦点行（gB 头）还在 DOM 里（补量不是把它滚没了）
    expect(container.querySelector('[data-tid="g:#2 妖梦"]')).not.toBeNull();
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
