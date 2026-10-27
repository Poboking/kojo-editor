// @vitest-environment happy-dom
/**
 * WS-13 2b 车 · 树内拖拽搬运的**接线层** DOM 自证。
 *
 * 判据那份（`file-tree-drag.test.ts`）钉的是"该作用哪几份、落到哪一格、非法时说什么"；
 * 这一份钉的是"接在这棵树上真的走完全程"：
 *
 * **拖起 → 经过（落点高亮）→ 松手 → 落点真的变了 → 回执一句人话**，
 * 并且整条腿落完后仍然只有一条：计划层 `buildFileOpsPlan` + 执行层 `runFileOps` +
 * 同一句冲突问句 + 同一个脏闸（拖拽**不开第二套搬运**）。
 *
 * ⚠ 事件形态：happy-dom 下手工派发 `MouseEvent('dragstart'/'dragover'/'drop')` 并挂一个
 * 真 `dataTransfer` 替身（`setData/getData/types` 三件齐全）——React 的拖拽合成事件读的就是
 * 这一格，替身与浏览器同形，因此**测的是同一条接线**，不是自造的通道。
 * 外部文件拖入那条腿（`ui/drag-drop.ts`，走 Rust 事件）载荷里没有自家 MIME ⇒ 本层一律不接，
 * 这里也照这条钉一格（不许误触发）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ErbIndex, GameProject } from '@kojo/plugin-api';
import { FileTree } from '../src/ui/FileTree';
import { resetMultiSelectionForTest, getSelectedPaths } from '../src/ui/file-tree-multi-selection';
import { resetSelectionForTest } from '../src/ui/file-tree-selection';
import { resetFileClipboardForTest } from '../src/ui/file-clipboard';
import { TREE_DRAG_MIME, decodeTreeDragPayload } from '../src/ui/file-tree-drag';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KOJO = 'C:/koa/001';
const PKG = `${KOJO}/包A`;
const A = `${PKG}/a.ERB`;
const B = `${PKG}/b.ERB`;
const SCATTER = `${KOJO}/散落.ERB`;

const norm = (p: string): string => p.replace(/[\\/]+/g, '/').toLowerCase();

/* --------------------------- 假盘（与 2a 那份同形，最小化） --------------------------- */

interface Disk {
  readonly files: Map<string, string>;
  readonly dirs: Set<string>;
  writable: boolean;
  readonly ioCalls: string[];
}

function makeDisk(seed: Array<[string, string]>): Disk {
  const disk: Disk = {
    files: new Map(seed.map(([p, c]) => [norm(p), c] as [string, string])),
    dirs: new Set<string>(),
    writable: true,
    ioCalls: [],
  };
  for (const [p] of seed) {
    const parts = norm(p).split('/');
    for (let i = 1; i < parts.length; i++) disk.dirs.add(parts.slice(0, i).join('/'));
  }
  return disk;
}

function makeIo(disk: Disk) {
  return {
    isWritable: (_path: string) => disk.writable,
    async createFileExclusive(path: string): Promise<boolean> {
      disk.ioCalls.push('createFileExclusive');
      if (disk.files.has(norm(path)) || disk.dirs.has(norm(path))) return false;
      disk.files.set(norm(path), '');
      return true;
    },
    async createDirExclusive(path: string): Promise<boolean> {
      disk.ioCalls.push('createDirExclusive');
      if (disk.dirs.has(norm(path)) || disk.files.has(norm(path))) return false;
      disk.dirs.add(norm(path));
      return true;
    },
    async copyFile(from: string, to: string): Promise<void> {
      disk.ioCalls.push('copyFile');
      const src = disk.files.get(norm(from));
      if (src === undefined) throw new Error(`源不在了 ${from}`);
      disk.files.set(norm(to), src);
    },
    async rename(from: string, to: string): Promise<void> {
      disk.ioCalls.push('rename');
      if (disk.files.has(norm(to)) || disk.dirs.has(norm(to))) throw new Error('目标已存在');
      const content = disk.files.get(norm(from));
      if (content === undefined) throw new Error(`没有这个东西 ${from}`);
      disk.files.delete(norm(from));
      disk.files.set(norm(to), content);
    },
    async removeFile(path: string): Promise<void> {
      disk.ioCalls.push('removeFile');
      disk.files.delete(norm(path));
    },
    async walkDir(path: string) {
      disk.ioCalls.push('walkDir');
      const out: Array<{ name: string; path: string; isDirectory: boolean }> = [];
      const root = norm(path);
      for (const [p] of disk.files) if (p.startsWith(`${root}/`)) out.push({ name: p.slice(root.length + 1), path: p, isDirectory: false });
      return out;
    },
    async backup(path: string): Promise<string | null> {
      disk.ioCalls.push('backup');
      return disk.files.has(norm(path)) ? 'bak' : null;
    },
    async removeDir(_path: string): Promise<void> {},
  };
}

function listDirOf(disk: Disk) {
  return async (dir: string): Promise<Array<{ name: string; path: string; isDirectory: boolean }>> => {
    const out: Array<{ name: string; path: string; isDirectory: boolean }> = [];
    const root = norm(dir).replace(/\/+$/, '');
    const seen = new Set<string>();
    for (const [p] of disk.files) {
      const parent = p.slice(0, Math.max(p.lastIndexOf('/'), 0));
      if (parent !== root) continue;
      const name = p.slice(root.length + 1);
      if (!name.includes('/')) out.push({ name, path: p, isDirectory: false });
    }
    for (const d of disk.dirs) {
      if (!d.startsWith(`${root}/`)) continue;
      const rest = d.slice(root.length + 1);
      if (rest !== '' && !rest.includes('/') && !seen.has(rest)) {
        seen.add(rest);
        out.unshift({ name: rest, path: d, isDirectory: true });
      }
    }
    return out;
  };
}

const project = {
  charaIndex: new Map([[1, { no: 1, name: '灵梦', kojoDir: KOJO }]]),
  kojoPaths: ['C:/koa'],
  rootDir: 'C:/koa',
} as unknown as GameProject;

const index = {
  files: new Map([A, B, SCATTER].map((f) => [f, null])),
  byName: new Map(),
} as unknown as ErbIndex;

/* ------------------------------ 挂载与探针 ------------------------------ */

let container: HTMLElement;
let root: Root;
let disk: Disk;
const gone: Array<[readonly string[], ReadonlyArray<{ from: string; to: string }>]> = [];

interface MountOpts {
  dirtyOf?: (paths: readonly string[]) => string[];
  writable?: boolean;
}

async function mount(opts: MountOpts = {}, seed?: Array<[string, string]>): Promise<void> {
  disk = makeDisk(seed ?? [[A, 'A'], [B, 'B'], [SCATTER, 'S']]);
  if (opts.writable === false) disk.writable = false;
  root = createRoot(container);
  await act(async () => {
    root.render(
      h(FileTree, {
        project,
        index,
        activeFile: null,
        onOpenFile: (): void => {},
        io: makeIo(disk) as never,
        listDir: listDirOf(disk) as never,
        dirtyOf: opts.dirtyOf as never,
        onFilesGone: (deleted: readonly string[], renamed: ReadonlyArray<{ from: string; to: string }>) => gone.push([deleted, renamed]),
      }),
    );
  });
  // 展开角色组（行模型里有了行才能拖）
  await click(container.querySelector('button.tree-group-btn'));
}

const treeEl = (): HTMLElement => container.querySelector<HTMLElement>('.file-tree [role="tree"]')!;
const rowOf = (path: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`[role="treeitem"][data-tid="${path}"]`);
  expect(el, `树里没有这一行 ${path}`).toBeTruthy();
  return el!;
};
/** 落点行：作者包行（`data-tid` 是 `p:` 前缀的行号，不是路径） */
const pkgRow = (): HTMLElement => {
  const el = container.querySelector<HTMLElement>('[role="treeitem"][data-tree-kind="package"]');
  expect(el, '树里没有作者包行').toBeTruthy();
  return el!;
};
const statusLine = (): string =>
  [...container.querySelectorAll<HTMLElement>('[role="status"]')].map((el) => el.textContent ?? '').join('\n');
const modal = (label: string): HTMLElement | null => document.body.querySelector<HTMLElement>(`.modal[aria-label="${label}"]`);
const modalButtons = (): HTMLButtonElement[] => {
  const box = document.body.querySelector<HTMLElement>('.modal[role="dialog"]');
  return box === null ? [] : [...box.querySelectorAll<HTMLButtonElement>('.modal-actions button')];
};

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await act(async () => {});
}

async function click(el: Element | null | undefined): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function clickRow(path: string, mod: { ctrl?: boolean } = {}): Promise<void> {
  await act(async () => {
    rowOf(path).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: mod.ctrl ?? false }));
  });
}

async function pick(label: string): Promise<void> {
  const btn = modalButtons().find((b) => (b.textContent ?? '').includes(label));
  expect(btn, `对话框里没有「${label}」这一项`).toBeTruthy();
  await act(async () => {
    btn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

/** dataTransfer 替身：浏览器那三件能力（写 / 读 / types）都给齐，React 读的就是这一格 */
function makeDataTransfer(initial?: Record<string, string>): {
  dataTransfer: {
    effectAllowed: string;
    dropEffect: string;
    setData(t: string, v: string): void;
    getData(t: string): string;
    readonly types: string[];
  };
} {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    dataTransfer: {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: (t: string, v: string): void => {
        store.set(t, v);
      },
      getData: (t: string): string => store.get(t) ?? '',
      get types(): string[] {
        return [...store.keys()];
      },
    },
  };
}

type DragMod = { ctrl?: boolean; meta?: boolean; shift?: boolean };

/** 派一条真拖拽事件（同一条链：dragstart → dragover → drop；载荷在链上原样传递） */
async function drag(type: string, from: Element, dt: ReturnType<typeof makeDataTransfer>['dataTransfer'], mod: DragMod = {}): Promise<{ defaultPrevented: boolean }> {
  let ev: MouseEvent | null = null;
  await act(async () => {
    ev = new MouseEvent(type, { bubbles: true, cancelable: true, ctrlKey: mod.ctrl ?? false, metaKey: mod.meta ?? false, shiftKey: mod.shift ?? false });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    from.dispatchEvent(ev);
  });
  return { defaultPrevented: ev!.defaultPrevented };
}

/** 一步到位的拖拽（拖起 → 经过落点 → 松手）。
 * `target` 给落点那一行；Ctrl 决定移动还是复制。分步的用例自己派事件（看高亮要用中间态）。
 */
async function dragTo(sourcePath: string, target: Element, mod: DragMod = {}): Promise<void> {
  const holder = makeDataTransfer();
  await drag('dragstart', rowOf(sourcePath), holder.dataTransfer, mod);
  await drag('dragover', target, holder.dataTransfer, mod);
  await drag('drop', target, holder.dataTransfer, mod);
  await settle();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  resetSelectionForTest();
  resetMultiSelectionForTest();
  resetFileClipboardForTest();
  gone.length = 0;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  resetFileClipboardForTest();
});

/* ------------------------------ 拖起：作用于选择集 ------------------------------ */

describe('树内拖拽 · 拖起 = 作用于选择集', () => {
  it('在已选中的行上拖起 ⇒ 载荷就是整批（多选集），不另起一套拖拽选择', async () => {
    await mount();
    await clickRow(A);
    await clickRow(B, { ctrl: true });
    const holder = makeDataTransfer();
    await drag('dragstart', rowOf(A), holder.dataTransfer);
    const payload = decodeTreeDragPayload(holder.dataTransfer.getData(TREE_DRAG_MIME));
    expect(payload.map((p) => p.path)).toEqual([A, B]);
    expect(getSelectedPaths()).toEqual([A, B]); // 选择集一个字没改
  });

  it('在未选中的行上按下 ⇒ 先把选择收到那一行再拖（与点行同一口径）', async () => {
    await mount();
    await clickRow(A);
    await clickRow(B, { ctrl: true }); // 集合 = A、B
    const holder = makeDataTransfer();
    await drag('dragstart', rowOf(SCATTER), holder.dataTransfer); // 按下的 SCATTER 不在集合里
    expect(getSelectedPaths()).toEqual([SCATTER]);
    expect(decodeTreeDragPayload(holder.dataTransfer.getData(TREE_DRAG_MIME))).toEqual([{ path: SCATTER, isDir: false }]);
  });

  it('角色分组头不是可搬动的条目 ⇒ 拖不起来、当场 preventDefault 并说出原因', async () => {
    await mount();
    const head = container.querySelector<HTMLElement>('button.tree-group-btn')!;
    const holder = makeDataTransfer();
    const res = await drag('dragstart', head, holder.dataTransfer);
    expect(res.defaultPrevented).toBe(true);
    expect(holder.dataTransfer.getData(TREE_DRAG_MIME)).toBe('');
    expect(statusLine()).toContain('角色分组');
  });
});

/* ------------------------------ 经过：落点高亮 ------------------------------ */

describe('树内拖拽 · 经过时落点看得见', () => {
  it('拖过合法目录行 ⇒ 落点那一格挂上高亮类；拖过非法落点 ⇒ 同一格加"不许落"的变体', async () => {
    await mount();
    const holder = makeDataTransfer();
    await drag('dragstart', rowOf(A), holder.dataTransfer);
    const ok = await drag('dragover', treeEl().querySelector<HTMLElement>(`[role="treeitem"][data-tid="${SCATTER}"]`)!, holder.dataTransfer);
    expect(ok.defaultPrevented).toBe(true); // 接住这一格，松手才有回执
    expect(rowOf(SCATTER).classList.contains('kojo-drop-hover')).toBe(true);
    expect(rowOf(SCATTER).classList.contains('kojo-drop-nocopy')).toBe(false);
    expect(holder.dataTransfer.dropEffect).toBe('move');

    await drag('dragover', pkgRow(), holder.dataTransfer); // 落点 = A 自己那一格 ⇒ 非法
    expect(pkgRow().classList.contains('kojo-drop-nocopy')).toBe(true);
    expect(rowOf(SCATTER).classList.contains('kojo-drop-hover')).toBe(false); // 旧落点摘干净
  });

  it('Ctrl + 拖 ⇒ 高亮照样有、dropEffect 变成 copy', async () => {
    await mount();
    const holder = makeDataTransfer();
    await drag('dragstart', rowOf(A), holder.dataTransfer);
    await drag('dragover', rowOf(SCATTER), holder.dataTransfer, { ctrl: true });
    expect(holder.dataTransfer.dropEffect).toBe('copy');
    expect(rowOf(SCATTER).classList.contains('kojo-drop-hover')).toBe(true);
  });

  it('拖拽收尾（dragend）⇒ 高亮一类都不留', async () => {
    await mount();
    const holder = makeDataTransfer();
    await drag('dragstart', rowOf(A), holder.dataTransfer);
    await drag('dragover', rowOf(SCATTER), holder.dataTransfer);
    await drag('dragend', rowOf(A), holder.dataTransfer);
    expect(rowOf(SCATTER).className).not.toContain('kojo-drop');
  });
});

/* ------------------------------ 松手：移动 / 复制 / 回执 ------------------------------ */

describe('树内拖拽 · 松手落地', () => {
  it('纯拖 = 移动：整批源都换到新目录，回执一句人话点名落点', async () => {
    await mount();
    await clickRow(A);
    await clickRow(B, { ctrl: true });
    await dragTo(A, rowOf(SCATTER));
    expect(disk.files.has(norm(A))).toBe(false);
    expect(disk.files.has(norm(B))).toBe(false);
    expect(disk.files.get(norm(`${KOJO}/a.ERB`))).toBe('A');
    expect(disk.files.get(norm(`${KOJO}/b.ERB`))).toBe('B');
    expect(statusLine()).toContain('已把 2 项移到「001」');
    // 标签跟着换路径（与剪切粘贴同一条收尾腿）
    expect(gone[gone.length - 1]?.[1]).toEqual([
      { from: A, to: `${KOJO}/a.ERB` },
      { from: B, to: `${KOJO}/b.ERB` },
    ]);
  });

  it('Ctrl + 拖 = 复制：源还在原地', async () => {
    await mount();
    await clickRow(A);
    await dragTo(A, rowOf(SCATTER), { ctrl: true });
    expect(disk.files.has(norm(A))).toBe(true);
    expect(disk.files.get(norm(`${KOJO}/a.ERB`))).toBe('A');
    expect(statusLine()).toContain('已把 1 项复制到「001」');
  });

  it('拖回自己所在的那一格 ⇒ 如实拒 + 说出原因，一个 IO 都不发（不许"松手没反应"）', async () => {
    await mount();
    await clickRow(A);
    await dragTo(A, pkgRow());
    expect(statusLine()).toContain('没有落下任何东西');
    expect(statusLine()).toContain('本来就在这一格里');
    expect(disk.ioCalls).toEqual([]);
  });

  it('撞名 ⇒ 与粘贴**同一条**冲突问句（模态四选项），选「保留两者」就自动改名落地', async () => {
    await mount({}, [[A, 'A'], [B, 'B'], [SCATTER, 'S'], [`${KOJO}/a.ERB`, '旧内容']]);
    await clickRow(A);
    const holder = makeDataTransfer();
    await drag('dragstart', rowOf(A), holder.dataTransfer);
    await drag('dragover', rowOf(SCATTER), holder.dataTransfer);
    await drag('drop', rowOf(SCATTER), holder.dataTransfer);
    await settle();
    expect(modal('同名条目怎么处理')).not.toBeNull();
    expect(modalButtons().map((b) => b.textContent)).toEqual([
      '保留两者（自动改名）',
      '覆盖同名条目',
      '跳过同名条目',
      '全部取消',
    ]);
    await pick('保留两者');
    expect(disk.files.get(norm(`${KOJO}/a.ERB`))).toBe('旧内容');
    expect(disk.files.get(norm(`${KOJO}/a 2.ERB`))).toBe('A');
  });

  it('只读落点：一条 IO 都不发，逐项点名（写允许域铁律）', async () => {
    await mount({ writable: false });
    await clickRow(A);
    await dragTo(A, rowOf(SCATTER));
    expect(disk.ioCalls).toEqual([]);
    expect(statusLine()).toContain('只读范围内');
    expect(statusLine()).toContain('a.ERB');
  });
});

/* ------------------------------ 脏闸：与粘贴同一条腿 ------------------------------ */

describe('树内拖拽 · 脏闸', () => {
  it('拖着有未保存修改的文件 ⇒ 问一次（同一句问句）；答「继续」才落地、标签跟着换路径', async () => {
    await mount({ dirtyOf: (paths) => (paths.some((p) => norm(p) === norm(A)) ? ['a.ERB'] : []) });
    await clickRow(A);
    const holder = makeDataTransfer();
    await drag('dragstart', rowOf(A), holder.dataTransfer);
    await drag('dragover', rowOf(SCATTER), holder.dataTransfer);
    await drag('drop', rowOf(SCATTER), holder.dataTransfer);
    await settle();
    const box = modal('有未保存的修改');
    expect(box).not.toBeNull();
    expect(box!.textContent).toContain('移走之后编辑器里的改动会跟着文件一起过去');
    await pick('继续');
    expect(disk.files.has(norm(A))).toBe(false);
    expect(disk.files.get(norm(`${KOJO}/a.ERB`))).toBe('A');
    expect(gone[gone.length - 1]?.[1]).toEqual([{ from: A, to: `${KOJO}/a.ERB` }]);
  });

  it('答「取消」⇒ 一个字节都不动', async () => {
    await mount({ dirtyOf: () => ['a.ERB'] });
    await clickRow(A);
    await dragTo(A, rowOf(SCATTER));
    await pick('取消');
    expect(disk.ioCalls).toEqual([]);
    expect(disk.files.has(norm(A))).toBe(true);
    expect(statusLine()).toContain('已取消');
  });
});

/* ------------------------------ 与既有拖拽腿互不相扰 ------------------------------ */

describe('树内拖拽 · 不抢别的通道', () => {
  it('外部文件拖入（载荷里没有自家 MIME）⇒ 本层一个字都不接：不 preventDefault、不发 IO', async () => {
    await mount();
    await clickRow(A);
    const external = makeDataTransfer({ Files: '', 'text/uri-list': 'file:///C:/tmp/x.ERB' });
    const over = await drag('dragover', rowOf(SCATTER), external.dataTransfer);
    const dropped = await drag('drop', rowOf(SCATTER), external.dataTransfer);
    expect(over.defaultPrevented).toBe(false);
    expect(dropped.defaultPrevented).toBe(false);
    expect(disk.ioCalls).toEqual([]);
    expect(rowOf(SCATTER).classList.contains('kojo-drop-hover')).toBe(false);
  });

  it('松手在说明行 / 树外 ⇒ 也是原话，不是静默', async () => {
    await mount();
    await clickRow(A);
    const note = container.querySelector<HTMLElement>('.tree-note') ?? treeEl();
    await dragTo(A, note);
    expect(statusLine()).toContain('没有落下任何东西');
    expect(disk.ioCalls).toEqual([]);
  });
});
