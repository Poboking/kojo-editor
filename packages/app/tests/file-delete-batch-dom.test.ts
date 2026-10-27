// @vitest-environment happy-dom
/**
 * WS-13 2c 车 · **批量删除接线层**的 DOM 级自证（树上按 Delete 真的是这个行为）。
 *
 * 纯函数那边钉的是判据（`file-delete-plan` / `file-delete-exec`），这一份钉四件接线的东西：
 *
 * 1. **分档**：单击一行（勾选集里只有它）按 Delete ⇒ 走的还是那条单条老腿（`window.confirm` +
 *    那句旧回执 + 守门一刀拒绝脏文件）；勾到第二行才换成整批新腿；
 * 2. **确认框逐条点名**（模态、不是 `window.confirm`），答"取消"一个字节都不动；
 * 3. **回收站与撤销**：删完那句回执旁边那颗「撤销这次删除」点得动、盘上真的回来且内容逐字一致；
 *    命令面板 `explorer.undoDeleteEntry` 那条腿打的是同一个函数；台账空着时说的是指引而不是假成功；
 * 4. **脏闸复用同一份投影**：问一句、答"不"整批作废。
 *
 * ⚠ 假 io 只做删除与撤销要的那几枚原语（回收站语义照内核 `TrashManager` 复刻，见
 * `file-delete-exec.test.ts`）；问句模态经 `createPortal` 挂 body。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DirEntry, ErbIndex, GameProject, TrashEntry } from '@kojo/plugin-api';
import { FileTree } from '../src/ui/FileTree';
import { resetMultiSelectionForTest } from '../src/ui/file-tree-multi-selection';
import { resetSelectionForTest } from '../src/ui/file-tree-selection';
import { runExplorerUndoDelete } from '../src/ui/file-clipboard';
import { clearDeleteBatchLedger } from '../src/ui/file-delete-exec';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KOJO = 'C:/koa/001';
const PKG = `${KOJO}/包A`;
const A = `${PKG}/a.ERB`;
const B = `${PKG}/b.ERB`;
const SCATTER = `${KOJO}/散落.ERB`;

const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
const parentOf = (p: string): string => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));

interface Entry {
  id: string;
  originalPath: string;
  kind: 'dir' | 'file';
  files: Map<string, string>;
  dirs: string[];
}

interface Disk {
  readonly files: Map<string, string>;
  readonly dirs: Set<string>;
  readonly trash: Entry[];
  readonly calls: string[];
  writable: boolean;
}

function makeDisk(seed: Array<[string, string]>): Disk {
  const disk: Disk = { files: new Map(), dirs: new Set(), trash: [], calls: [], writable: true };
  for (const [p, c] of seed) {
    disk.files.set(norm(p), c);
    let q = parentOf(p);
    while (q !== '' && !disk.dirs.has(norm(q))) {
      disk.dirs.add(norm(q));
      q = parentOf(q);
    }
  }
  return disk;
}

let seq = 0;

function makeIo(disk: Disk) {
  const view = (e: Entry): TrashEntry => ({
    id: e.id,
    originalPath: e.originalPath,
    kind: e.kind,
    deletedAtMs: 0,
    expiresAtMs: 9e15,
    bytes: null,
    payloadPath: `${e.originalPath}.payload`,
  });
  const related = (e: Entry, want: string): boolean => {
    const at = norm(e.originalPath);
    return at === want || at.startsWith(`${want}/`) || want.startsWith(`${at}/`);
  };
  return {
    isWritable: (_path: string) => disk.writable,
    async removeFile(path: string): Promise<void> {
      disk.calls.push(`removeFile:${norm(path)}`);
      const key = norm(path);
      const content = disk.files.get(key);
      if (content === undefined) throw new Error(`没有这个东西：${path}`);
      disk.files.delete(key);
      disk.trash.push({ id: `T${++seq}`, originalPath: path, kind: 'file', files: new Map([[key, content]]), dirs: [] });
    },
    async removeDir(path: string): Promise<void> {
      disk.calls.push(`removeDir:${norm(path)}`);
      const key = norm(path);
      if (!disk.dirs.has(key)) return;
      const inner = new Map<string, string>();
      for (const [p, c] of disk.files) if (p.startsWith(`${key}/`)) inner.set(p, c);
      const innerDirs = [...disk.dirs].filter((x) => x.startsWith(`${key}/`));
      for (const p of inner.keys()) disk.files.delete(p);
      for (const p of [...disk.dirs].filter((x) => x === key || x.startsWith(`${key}/`))) disk.dirs.delete(p);
      disk.trash.push({ id: `T${++seq}`, originalPath: path, kind: 'dir', files: inner, dirs: innerDirs });
    },
    async listTrash(opts?: { forPath?: string }): Promise<TrashEntry[]> {
      const want = opts?.forPath === undefined ? null : norm(opts.forPath);
      const out = want === null ? [...disk.trash] : disk.trash.filter((e) => related(e, want));
      return out.reverse().map(view);
    },
    async restoreFromTrash(id: string): Promise<string> {
      const idx = disk.trash.findIndex((e) => e.id === id);
      if (idx < 0) throw new Error(`回收站条目不存在或已失效：${id}`);
      const entry = disk.trash[idx]!;
      const target = norm(entry.originalPath);
      if (disk.dirs.has(target)) throw new Error(`原位置已存在，不能恢复（回收站不覆盖）：${entry.originalPath}`);
      if (entry.kind === 'file') {
        if (disk.files.has(target)) disk.files.delete(target);
        disk.files.set(target, [...entry.files.values()][0] ?? '');
      } else {
        disk.dirs.add(target);
        for (const dd of entry.dirs) disk.dirs.add(dd);
        for (const [p, c] of entry.files) disk.files.set(p, c);
      }
      disk.trash.splice(idx, 1);
      return entry.originalPath;
    },
    async walkDir(path: string): Promise<DirEntry[]> {
      const key = norm(path);
      const out: DirEntry[] = [{ name: path.slice(path.lastIndexOf('/') + 1), path, isDirectory: true }];
      for (const p of disk.files.keys()) if (p.startsWith(`${key}/`)) out.push({ name: p.slice(key.length + 1), path: p, isDirectory: false });
      for (const dd of disk.dirs) if (dd.startsWith(`${key}/`)) out.push({ name: dd.slice(key.length + 1), path: dd, isDirectory: true });
      return out;
    },
  };
}

function listDirOf(disk: Disk) {
  return async (dir: string): Promise<DirEntry[]> => {
    const out: DirEntry[] = [];
    const root = norm(dir);
    const seen = new Set<string>();
    for (const [p] of disk.files) {
      if (parentOf(p) !== root) continue;
      out.push({ name: p.slice(root.length + 1), path: p, isDirectory: false });
    }
    for (const dd of disk.dirs) {
      if (!dd.startsWith(`${root}/`)) continue;
      const rest = dd.slice(root.length + 1);
      if (rest !== '' && !rest.includes('/') && !seen.has(rest)) {
        seen.add(rest);
        out.unshift({ name: rest, path: dd, isDirectory: true });
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
  files: new Map([A, B, SCATTER].map((x) => [x, null])),
  byName: new Map(),
} as unknown as ErbIndex;

let container: HTMLElement;
let root: Root;
let disk: Disk;
const gone: Array<[readonly string[], ReadonlyArray<{ from: string; to: string }>]> = [];
const deltas: Array<{ changed: readonly string[]; removed: readonly string[] }> = [];
/** 单条老腿用的 `window.confirm`：记下它被问了什么、答什么（旧语义有没有被换掉就看这个） */
const confirmAsk: string[] = [];
let confirmAnswer = true;

interface MountOpts {
  dirtyOf?: (paths: readonly string[]) => string[];
  writable?: boolean;
}

async function mount(opts: MountOpts = {}, seed?: Array<[string, string]>): Promise<void> {
  disk = makeDisk(seed ?? [[A, 'AAA'], [B, 'BBB'], [SCATTER, 'SSS']]);
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
        walkDir: ((p: string) => makeIo(disk).walkDir(p)) as never,
        dirtyOf: opts.dirtyOf as never,
        onFilesGone: (deleted: readonly string[], renamed: ReadonlyArray<{ from: string; to: string }>) =>
          gone.push([deleted, renamed]),
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
const undoButton = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('button.tree-undo-delete');

async function clickRow(path: string, mod: { ctrl?: boolean } = {}): Promise<void> {
  const row = fileRows().find((el) => norm(el.dataset.locate ?? '') === norm(path));
  expect(row, `树里没有这一行 ${path}`).toBeTruthy();
  await act(async () => {
    row!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: mod.ctrl ?? false }));
  });
}

async function key(k: string): Promise<void> {
  await act(async () => {
    treeEl().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await act(async () => {});
}

async function click(el: Element | null | undefined): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function pick(label: string): Promise<void> {
  const btn = modalButtons().find((b) => (b.textContent ?? '').includes(label));
  expect(btn, `对话框里没有「${label}」这一项`).toBeTruthy();
  await act(async () => {
    btn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function expandGroup(): Promise<void> {
  await click(container.querySelector('button.tree-group-btn'));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  resetSelectionForTest();
  resetMultiSelectionForTest();
  clearDeleteBatchLedger();
  gone.length = 0;
  deltas.length = 0;
  confirmAsk.length = 0;
  confirmAnswer = true;
  window.confirm = ((msg?: string): boolean => {
    confirmAsk.push(String(msg ?? ''));
    return confirmAnswer;
  }) as never;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  clearDeleteBatchLedger();
});

describe('Delete 的两档 · 有没有多选集', () => {
  it('只勾着一行（单击也会写进勾选集）⇒ 走的还是那条单条老腿：window.confirm + 旧那句回执，不出现批量模态', async () => {
    await mount();
    await expandGroup();
    await clickRow(A);
    await key('Delete');
    await settle();
    expect(confirmAsk.join('\n')).toContain('确定删除文件「a.ERB」吗');
    expect(confirmAsk.join('\n')).toContain('回收站');
    expect(modal('删除这些条目')).toBeNull();
    expect(disk.files.has(norm(A))).toBe(false);
    expect(statusLine()).toContain('已删除文件「a.ERB」');
    // 旧腿不进撤销台账（简报口径：无多选集 = 旧行为零改动）
    expect(undoButton()).toBeNull();
  });

  it('单条删目录 ⇒ 老腿那句"将同时删除其中的 N 个文件"照旧（walkDir 现算的刀口没丢）', async () => {
    await mount();
    await expandGroup();
    const dirRow = [...container.querySelectorAll<HTMLElement>('button')].find((el) =>
      (el.textContent ?? '').includes('包A'),
    );
    expect(dirRow, '树里没有包A 那一行').toBeTruthy();

    await act(async () => {
      dirRow!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await key('Delete');
    await settle();
    expect(confirmAsk.join('\n')).toContain('确定删除文件夹「包A」吗');
    expect(confirmAsk.join('\n')).toContain('其中的 2 个文件会一起移入回收站');
    expect(disk.files.has(norm(A))).toBe(false);
    expect(disk.files.has(norm(B))).toBe(false);
  });

  it('勾到第二行 ⇒ 换成整批新腿：模态逐条点名、按钮写着"删除 2 项"', async () => {
    await mount();
    await expandGroup();
    await clickRow(A);
    await clickRow(B, { ctrl: true });
    await key('Delete');
    await settle();
    const box = modal('删除这些条目');
    expect(box).not.toBeNull();
    const text = box!.textContent ?? '';
    expect(text).toContain('确定删除这 2 项吗？（2 个文件）');
    expect(text).toContain('「a.ERB」');
    expect(text).toContain('「b.ERB」');
    expect(text).toContain('回收站');
    expect(confirmAsk).toEqual([]); // 一次 `window.confirm` 都没惊动
    expect(modalButtons().map((b) => b.textContent)).toEqual(['取消', '删除 2 项']);
  });

  it('批量模态答"取消"⇒ 一个字节都不动', async () => {
    await mount();
    await expandGroup();
    await clickRow(A);
    await clickRow(B, { ctrl: true });
    await key('Delete');
    await settle();
    await pick('取消');
    expect(disk.calls).toEqual([]);
    expect(disk.files.has(norm(A))).toBe(true);
    expect(statusLine()).toContain('一个字节都没动');
    expect(undoButton()).toBeNull();
  });
});

describe('整批删除 · 回收站与撤销', () => {
  it('删两枚 ⇒ 盘上没了 + 回执说清去向；点回执旁边那颗 ⇒ 内容逐字回到原位、那颗消失', async () => {
    await mount();
    await expandGroup();
    await clickRow(A);
    await clickRow(B, { ctrl: true });
    await key('Delete');
    await settle();
    await pick('删除 2 项');
    expect(disk.files.has(norm(A))).toBe(false);
    expect(disk.files.has(norm(B))).toBe(false);
    expect(disk.trash.map((e) => e.kind)).toEqual(['file', 'file']);
    expect(statusLine()).toContain('已删除 2 项（2 个文件）');
    expect(undoButton()?.textContent).toContain('撤销这次删除（2 项）');
    // 收尾三件：标签端走、索引报 removed、目录重列（这里用回调读数验）
    const sortedAB = [...[A, B]].sort();
    expect([...(gone.at(-1)?.[0] ?? [])].sort()).toEqual(sortedAB);
    expect([...(deltas.at(-1)?.removed ?? [])].sort()).toEqual(sortedAB);

    await click(undoButton());
    expect(disk.files.get(norm(A))).toBe('AAA');
    expect(disk.files.get(norm(B))).toBe('BBB');
    expect(statusLine()).toContain('已放回 2 项');
    expect(undoButton()).toBeNull();
    expect(disk.trash).toHaveLength(0);
    expect([...(deltas.at(-1)?.changed ?? [])].sort()).toEqual(sortedAB);
  });

  it('命令面板那条腿打的是同一个函数：台账空着时说的是指引，不是"已放回 0 项"', async () => {
    await mount();
    await expandGroup();
    expect(runExplorerUndoDelete()).toBe(true); // 桥在、这条腿也登记了（树挂载着）
    await settle();
    expect(statusLine()).toContain('没有可撤销的删除');
    expect(disk.calls).toEqual([]);
  });

  it('台账跨两次动作仍然只留最近那一批（撤销不许把早先那批也捞回来）', async () => {
    await mount();
    await expandGroup();
    await clickRow(A);
    await clickRow(B, { ctrl: true });
    await key('Delete');
    await settle();
    await pick('删除 2 项');
    await click(undoButton());
    // 放回原位后再删一次（这次只勾一枚 + 另一枚走单条老腿）⇒ 台账只剩新那批
    await clickRow(SCATTER);
    await clickRow(A);
    await clickRow(SCATTER, { ctrl: true });
    await key('Delete');
    await settle();
    await pick('删除 2 项');
    expect(disk.trash.filter((e) => e.kind === 'file').length).toBeGreaterThan(0);
    await click(undoButton());
    expect(disk.files.get(norm(A))).toBe('AAA');
    expect(disk.files.get(norm(SCATTER))).toBe('SSS');
    // 更早那批（第一次删的 a/b）已经被这一轮的撤销用掉 ⇒ 再点撤销只会说"没有可撤销的"
    expect(undoButton()).toBeNull();
  });
});

describe('批删的脏闸（与 2a 那条确认框同形态，问一次）', () => {
  const dirty = { dirtyOf: (paths: readonly string[]) => (paths.some((p) => norm(p) === norm(A)) ? ['a.ERB'] : []) };

  it('命中未保存修改 ⇒ 确认之后再问一句；答"取消"整批作废', async () => {
    await mount(dirty);
    await expandGroup();
    await clickRow(A);
    await clickRow(B, { ctrl: true });
    await key('Delete');
    await settle();
    await pick('删除 2 项');
    const box = modal('有未保存的修改');
    expect(box).not.toBeNull();
    expect(box!.textContent).toContain('编辑器里那份还没存的改动不会跟着进去');
    await pick('取消');
    expect(disk.calls).toEqual([]);
    expect(disk.files.has(norm(A))).toBe(true);
    expect(statusLine()).toContain('未保存的修改');
  });

  it('答"继续"⇒ 整批照删，回执与那颗撤销都在', async () => {
    await mount(dirty);
    await expandGroup();
    await clickRow(A);
    await clickRow(B, { ctrl: true });
    await key('Delete');
    await settle();
    await pick('删除 2 项');
    await pick('继续');
    expect(disk.files.has(norm(A))).toBe(false);
    expect(undoButton()?.textContent).toContain('撤销这次删除（2 项）');
  });
});

describe('批删的写允许域（只读 ⇒ 一条 IO 都不发、逐条点名）', () => {
  it('不可写 ⇒ 确认框与回执都点名，盘上不动', async () => {
    await mount({ writable: false });
    await expandGroup();
    await clickRow(A);
    await clickRow(B, { ctrl: true });
    await key('Delete');
    await settle();
    const box = modal('删除这些条目');
    expect(box, '整批都在只读域里 ⇒ 没有可删的条目，不该问确认').toBeNull();
    expect(disk.calls).toEqual([]);
    expect(statusLine()).toContain('只读范围内');
    expect(statusLine()).toContain('a.ERB');
    expect(statusLine()).toContain('b.ERB');
  });
});
