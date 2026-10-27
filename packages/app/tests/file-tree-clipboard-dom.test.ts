// @vitest-environment happy-dom
/**
 * WS-13 2a 车 · 剪贴板家族**接线层**的 DOM 级自证。
 *
 * 纯模块那边钉的是判据（`file-ops-plan` / `file-ops-exec` / `file-clipboard`），
 * 这一份钉的是"接在树上真的是这个行为"：
 *
 * 1. Ctrl+C / Ctrl+X 的宾语取多选集、回执走一句话状态行（既有 `revealNote`，不建第二套 toast）；
 * 2. Ctrl+V 的完整链：现读剪贴板 → 计划 → **有冲突才问**（问句 = `.modal[aria-label]` 模态、
 *    四选项 = `CONFLICT_CHOICES`）→ 执行层落盘 → 回执上屏；
 * 3. 剪切落地的收尾：源真的走了、标签改写回调收到 renamed 对、剪贴板清掉；
 *    没落地的（全部取消）一个字节都不动；
 * 4. 「创建副本」撞的是自己 ⇒ **不问**（本义就是再落一份），直接「名字 2」；
 * 5. 只读落点：一条 IO 都不发、逐项点名（写允许域铁律 5/6）；
 * 6. 脏闸接到真源回调上：问句出现 → 答"取消"整个动作作废、答"继续"照常落地。
 *
 * ⚠ 夹具的假 io 只做搬运要的那几枚原语（结构同 `file-ops-exec.test` 的假盘，最小化）；
 * 冲突问句模态经 `createPortal` 挂 body（树容器带 `contain: layout paint`，就地渲染会被钉成面板大小）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ErbIndex, GameProject } from '@kojo/plugin-api';
import { FileTree } from '../src/ui/FileTree';
import { resetMultiSelectionForTest } from '../src/ui/file-tree-multi-selection';
import { resetSelectionForTest } from '../src/ui/file-tree-selection';
import { getFileClipboard, resetFileClipboardForTest } from '../src/ui/file-clipboard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KOJO = 'C:/koa/001';
const PKG = `${KOJO}/包A`;
const A = `${PKG}/a.ERB`;
const B = `${PKG}/b.ERB`;
const SCATTER = `${KOJO}/散落.ERB`;

const norm = (p: string): string => p.replace(/[\\/]+/g, '/').toLowerCase();

/** 一块最小假盘：搬运执行层要的几枚原语 + 可写开关（落点只读判据用） */
interface Disk {
  readonly files: Map<string, string>;
  readonly dirs: Set<string>;
  writable: boolean;
  readonly ioCalls: string[];
}

function makeDisk(seed: Array<[string, string]>): Disk {
  const disk: Disk = { files: new Map(seed.map(([p, c]) => [norm(p), c] as [string, string])), dirs: new Set<string>(), writable: true, ioCalls: [] };
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
      disk.ioCalls.push(`createFileExclusive`);
      if (disk.files.has(norm(path)) || disk.dirs.has(norm(path))) return false;
      disk.files.set(norm(path), '');
      return true;
    },
    async createDirExclusive(path: string): Promise<boolean> {
      disk.ioCalls.push(`createDirExclusive`);
      if (disk.dirs.has(norm(path)) || disk.files.has(norm(path))) return false;
      disk.dirs.add(norm(path));
      return true;
    },
    async copyFile(from: string, to: string): Promise<void> {
      disk.ioCalls.push(`copyFile`);
      const src = disk.files.get(norm(from));
      if (src === undefined) throw new Error(`源不在了 ${from}`);
      disk.files.set(norm(to), src);
    },
    async rename(from: string, to: string): Promise<void> {
      disk.ioCalls.push(`rename`);
      if (disk.files.has(norm(to)) || disk.dirs.has(norm(to))) throw new Error('目标已存在');
      const content = disk.files.get(norm(from));
      if (content === undefined) throw new Error(`没有这个东西 ${from}`);
      disk.files.delete(norm(from));
      disk.files.set(norm(to), content);
    },
    async removeFile(path: string): Promise<void> {
      disk.ioCalls.push(`removeFile`);
      disk.files.delete(norm(path));
    },
    async walkDir(path: string) {
      disk.ioCalls.push(`walkDir`);
      const out: Array<{ name: string; path: string; isDirectory: boolean }> = [];
      const root = norm(path);
      for (const [p] of disk.files) if (p.startsWith(`${root}/`)) out.push({ name: p.slice(root.length + 1), path: p, isDirectory: false });
      return out;
    },
    async backup(path: string): Promise<string | null> {
      disk.ioCalls.push(`backup`);
      return disk.files.has(norm(path)) ? 'bak' : null;
    },
    async removeDir(_path: string): Promise<void> {},
  };
}

/** 从假盘长出一棵目录清单（树与目标现状读的都是这一块盘） */
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

let container: HTMLElement;
let root: Root;
let disk: Disk;
const gone: Array<[readonly string[], ReadonlyArray<{ from: string; to: string }>]> = [];
const deltas: Array<{ changed: readonly string[]; removed: readonly string[] }> = [];

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
        onDiskEntriesChanged: (delta: { changed: readonly string[]; removed: readonly string[] }) => deltas.push(delta),
      }),
    );
  });
}

const treeEl = (): HTMLElement => container.querySelector<HTMLElement>('.file-tree [role="tree"]')!;
const fileRows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('button.tree-file[data-locate]')];
const statusLine = (): string =>
  [...container.querySelectorAll<HTMLElement>('[role="status"]')].map((el) => el.textContent ?? '').join('\n');
const modal = (label: string): HTMLElement | null => document.body.querySelector<HTMLElement>(`.modal[aria-label="${label}"]`);
const modalButtons = (): HTMLButtonElement[] => {
  const box = document.body.querySelector<HTMLElement>('.modal[role="dialog"]');
  return box === null ? [] : [...box.querySelectorAll<HTMLButtonElement>('.modal-actions button')];
};

async function clickRow(path: string, mod: { ctrl?: boolean } = {}): Promise<void> {
  const row = fileRows().find((el) => norm(el.dataset.locate ?? '') === norm(path));
  expect(row, `树里没有这一行 ${path}`).toBeTruthy();
  await act(async () => {
    row!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: mod.ctrl ?? false }));
  });
}

async function key(k: string, mod: { ctrl?: boolean; shift?: boolean } = {}): Promise<void> {
  await act(async () => {
    treeEl().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ctrlKey: mod.ctrl ?? false, shiftKey: mod.shift ?? false }));
  });
}

/** 把异步链（listDir / runFileOps / 对话框 resolve）跑完 */
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await act(async () => {});
}

async function click(el: Element | null | undefined): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  resetSelectionForTest();
  resetMultiSelectionForTest();
  resetFileClipboardForTest();
  gone.length = 0;
  deltas.length = 0;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  resetFileClipboardForTest();
});

describe('剪贴板家族 · 复制与剪切（宾语 = 多选集）', () => {
  it('Ctrl+C 收多选集进剪贴板，回执一句话上屏；再按 Ctrl+V 才有落点现读', async () => {
    await mount();
    await click(container.querySelector('button.tree-group-btn')); // 展开角色组
    await clickRow(A);
    await clickRow(B, { ctrl: true });
    await key('c', { ctrl: true });
    expect(getFileClipboard().map((e) => e.path)).toEqual([A, B]);
    expect(statusLine()).toContain('已复制 2 项');
  });

  it('Ctrl+X 记成剪切（落地在粘贴那一步；此刻一个字节都不动）', async () => {
    await mount();
    await click(container.querySelector('button.tree-group-btn'));
    await clickRow(A);
    await key('x', { ctrl: true });
    expect(getFileClipboard().map((e) => e.path)).toEqual([A]);
    expect(statusLine()).toContain('已剪切 1 项');
    expect(disk.files.has(norm(A))).toBe(true);
    expect(disk.ioCalls).toEqual([]);
  });

  it('剪贴板空着按粘贴 ⇒ 说的是指引，不是"0 项"（也不发一个 IO）', async () => {
    await mount();
    await click(container.querySelector('button.tree-group-btn'));
    await clickRow(SCATTER);
    await key('v', { ctrl: true });
    expect(statusLine()).toContain('剪贴板是空的');
    expect(disk.ioCalls).toEqual([]);
  });
});

describe('剪贴板家族 · 粘贴落地（复制模式）', () => {
  it('无撞名：直接落盘 + 回执点名落点 + 索引增量上报；剪贴板留着（复制可重复粘）', async () => {
    await mount();
    await click(container.querySelector('button.tree-group-btn'));
    await clickRow(A);
    await clickRow(B, { ctrl: true });
    await key('c', { ctrl: true });
    await clickRow(SCATTER); // 焦点换到散落文件：落点 = C:/koa/001
    await key('v', { ctrl: true });
    await settle();
    expect(disk.files.has(norm(`${KOJO}/a.ERB`))).toBe(true);
    expect(disk.files.has(norm(`${KOJO}/b.ERB`))).toBe(true);
    expect(statusLine()).toContain('已把 2 项复制到「001」');
    expect(getFileClipboard()).toHaveLength(2);
    const changed = deltas.flatMap((d) => d.changed);
    expect(changed).toContain(`${KOJO}/a.ERB`);
  });

  it('撞名 ⇒ 问句上屏（模态四选项，文案取自计划层单源）；选「跳过」不落地但照数点名', async () => {
    await mount({}, [[A, 'A'], [B, 'B'], [SCATTER, 'S'], [`${KOJO}/a.ERB`, '旧内容']]);
    await click(container.querySelector('button.tree-group-btn'));
    await clickRow(A);
    await key('c', { ctrl: true });
    await clickRow(SCATTER);
    await key('v', { ctrl: true });
    await settle();
    const box = modal('同名条目怎么处理');
    expect(box).not.toBeNull();
    expect(box!.textContent).toContain('已经有同名的东西');
    expect(modalButtons().map((b) => b.textContent)).toEqual([
      '保留两者（自动改名）',
      '覆盖同名条目',
      '跳过同名条目',
      '全部取消',
    ]);
    await pick('跳过同名条目');
    expect(modal('同名条目怎么处理')).toBeNull();
    expect(disk.files.get(norm(`${KOJO}/a.ERB`))).toBe('旧内容'); // 一个字没盖
    expect(statusLine()).toContain('跳过 1 项（a.ERB）');
  });

  it('撞名选「保留两者」⇒ 自动改名落「a 2.ERB」（独占创建抢名字）', async () => {
    await mount({}, [[A, 'A'], [B, 'B'], [SCATTER, 'S'], [`${KOJO}/a.ERB`, '旧内容']]);
    await click(container.querySelector('button.tree-group-btn'));
    await clickRow(A);
    await key('c', { ctrl: true });
    await clickRow(SCATTER);
    await key('v', { ctrl: true });
    await settle();
    await pick('保留两者');
    expect(disk.files.get(norm(`${KOJO}/a.ERB`))).toBe('旧内容');
    expect(disk.files.get(norm(`${KOJO}/a 2.ERB`))).toBe('A');
    expect(statusLine()).toContain('已把 1 项复制到「001」');
  });

  it('撞名选「全部取消」⇒ 一个字节都不动，剪贴板原样留着', async () => {
    await mount({}, [[A, 'A'], [B, 'B'], [SCATTER, 'S'], [`${KOJO}/a.ERB`, '旧内容']]);
    await click(container.querySelector('button.tree-group-btn'));
    await clickRow(A);
    await key('c', { ctrl: true });
    await clickRow(SCATTER);
    await key('v', { ctrl: true });
    await settle();
    await pick('全部取消');
    expect(statusLine()).toContain('已全部取消');
    expect(disk.ioCalls).toEqual([]);
    expect(getFileClipboard()).toHaveLength(1);
  });

  it('只读落点：一条 IO 都不发，逐项点名并说清去哪批准写权限', async () => {
    await mount({ writable: false });
    await click(container.querySelector('button.tree-group-btn'));
    await clickRow(A);
    await key('c', { ctrl: true });
    await clickRow(SCATTER);
    await key('v', { ctrl: true });
    await settle();
    expect(disk.ioCalls).toEqual([]);
    expect(statusLine()).toContain('只读范围内');
    expect(statusLine()).toContain('a.ERB');
  });
});

describe('剪贴板家族 · 剪切落地（move 模式的收尾三件）', () => {
  it('剪切 + 粘贴：源走了、标签改写收到 renamed 对、剪贴板清掉（成了的部分不许再搬一遍）', async () => {
    await mount();
    await click(container.querySelector('button.tree-group-btn'));
    await clickRow(B);
    await key('x', { ctrl: true });
    await clickRow(SCATTER);
    await key('v', { ctrl: true });
    await settle();
    expect(disk.files.has(norm(B))).toBe(false);
    expect(disk.files.has(norm(`${KOJO}/b.ERB`))).toBe(true);
    expect(statusLine()).toContain('已把 1 项移到「001」');
    expect(getFileClipboard()).toHaveLength(0);
    expect(gone).toHaveLength(1);
    expect(gone[0]?.[1]).toEqual([{ from: B, to: `${KOJO}/b.ERB` }]);
    expect(deltas[0]?.removed).toEqual([B]);
  });

  it('同层粘贴判掉并说清（不许把它搬给它自己——要同层副本走创建副本）', async () => {
    await mount();
    await click(container.querySelector('button.tree-group-btn'));
    await clickRow(A);
    await key('c', { ctrl: true });
    // 焦点仍在 a.ERB：落点 = 包目录 = 源自己那一格
    await key('v', { ctrl: true });
    await settle();
    expect(modal('同名条目怎么处理')).toBeNull();
    expect(statusLine()).toContain('本来就在这一格里');
    expect(disk.ioCalls).toEqual([]);
  });
});

describe('剪贴板家族 · 创建副本', () => {
  it('Ctrl+D 撞的是源自己 ⇒ 不问，直接「名字 2」落在同一格', async () => {
    await mount();
    await click(container.querySelector('button.tree-group-btn'));
    await clickRow(A);
    await key('d', { ctrl: true });
    await settle();
    expect(modal('同名条目怎么处理')).toBeNull();
    expect(disk.files.get(norm(`${PKG}/a 2.ERB`))).toBe('A');
    expect(disk.files.get(norm(A))).toBe('A'); // 源留在原地
    expect(statusLine()).toContain('已在「包A」里做出 1 份副本');
  });
});

describe('脏闸（宿主投影的 dirtyOf 在场时：问一句，答"不"整个动作作废）', () => {
  it('剪切带着未保存修改的源 ⇒ 问句出现；答「取消」一个字节不动、说清为什么', async () => {
    await mount({ dirtyOf: (paths) => (paths.some((p) => norm(p) === norm(A)) ? ['a.ERB'] : []) });
    await click(container.querySelector('button.tree-group-btn'));
    await clickRow(A);
    await key('x', { ctrl: true });
    await clickRow(SCATTER);
    await key('v', { ctrl: true });
    await settle();
    const box = modal('有未保存的修改');
    expect(box).not.toBeNull();
    expect(box!.textContent).toContain('未保存的修改');
    await pick('取消');
    expect(statusLine()).toContain('已取消：那些文件还有未保存的修改');
    expect(disk.ioCalls).toEqual([]);
    expect(disk.files.has(norm(A))).toBe(true);
  });

  it('答「继续」⇒ 照搬（改动跟着文件走这句已在问句里说清）', async () => {
    await mount({ dirtyOf: (paths) => (paths.some((p) => norm(p) === norm(A)) ? ['a.ERB'] : []) });
    await click(container.querySelector('button.tree-group-btn'));
    await clickRow(A);
    await key('x', { ctrl: true });
    await clickRow(SCATTER);
    await key('v', { ctrl: true });
    await settle();
    await pick('继续');
    expect(disk.files.has(norm(A))).toBe(false);
    expect(disk.files.has(norm(`${KOJO}/a.ERB`))).toBe(true);
  });
});
