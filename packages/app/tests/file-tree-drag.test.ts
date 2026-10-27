/**
 * WS-13 2b 车 · 树内拖拽的**判据层**单证（纯函数，零 DOM）。
 *
 * 钉的都是会被点错的边界：拖起时到底作用几份、落点到底算哪一格、
 * 哪几种非法落点必须把原话说出口（不许"松手没反应"）。
 * 判据住在 `ui/file-tree-drag.ts`，组件只接线 ⇒ 这些边界在 node 里就能全跑完。
 */
import { describe, expect, it } from 'vitest';
import { buildKojoFlatTree, indexOfId } from '../src/ui/file-tree-flat';
import type { DirState, Group } from '../src/ui/file-tree-types';
import {
  TREE_DRAG_MIME,
  acceptsTreeDrop,
  decodeTreeDragPayload,
  encodeTreeDragPayload,
  planTreeDragSources,
  planTreeDropTarget,
  rowIsDragSource,
  treeDragModeOf,
  treeDropClasses,
  treeDropRejectSentence,
} from '../src/ui/file-tree-drag';
import type { FileOpEntry } from '../src/ui/file-ops-plan';

const KOJO = 'C:/koa/001';
const PKG = `${KOJO}/包A`;
const SUB = `${PKG}/子目录`;
const A = `${PKG}/a.ERB`;
const B = `${PKG}/b.ERB`;
const IN_SUB = `${SUB}/deep.ERB`;
const SCATTER = `${KOJO}/散落.ERB`;
const OTHER_DIR = 'C:/koa/002';

const group = (label: string, prefix: string, subs: Array<{ label: string | null; files: string[] }>): Group => ({
  label,
  prefix,
  subs: subs.map((s) => ({ label: s.label, files: [...s.files] })),
  total: subs.reduce((n, s) => n + s.files.length, 0),
});

/** 目录列举现场：包根一层有一个子目录 + 两份 ERB，子目录里再一份 */
const dirCache = new Map<string, DirState>([
  [
    PKG,
    [
      { name: '子目录', path: SUB, isDirectory: true },
      { name: 'a.ERB', path: A, isDirectory: false },
      { name: 'b.ERB', path: B, isDirectory: false },
    ],
  ],
  [SUB, [{ name: 'deep.ERB', path: IN_SUB, isDirectory: false }]],
]);

const tree = buildKojoFlatTree({
  groups: [
    {
      group: group('#1 灵梦', KOJO, [
        { label: null, files: [SCATTER] },
        { label: '包A', files: [A, B] },
      ]),
      open: true,
      pkgFolderOpen: () => true,
      note: '这一组的说明行（不是盘上的条目）',
    },
    { group: group('#2 巫女', OTHER_DIR, [{ label: null, files: [] }]), open: true, pkgFolderOpen: () => false },
    // 另一根上的角色目录（跨根判定用：它与 #1 同层，但不在同一个根里）
    { group: group('#3 附加', 'D:/work/003', [{ label: null, files: [] }]), open: true, pkgFolderOpen: () => false },
  ],
  subOpen: new Set([SUB]),
  dirCache,
  pkgDirOf: (prefix, label) => `${prefix}/${label}`,
});

/** 行下标（按路径 + 种类找，行序变了也不会指错） */
const idx = (path: string): number => {
  for (let i = 0; i < tree.rows.length; i++) {
    const r = tree.rows[i]!;
    if (r.path === path) return i;
  }
  return -1;
};
const noteIdx = indexOfId(tree, `${KOJO}/x.ERB::note`);

const ROOTS = ['C:/koa'];
const entryA: FileOpEntry = { path: A, isDir: false };
const entryPkg: FileOpEntry = { path: PKG, isDir: true };

describe('planTreeDragSources · 拖起 = 作用于选择集', () => {
  it('按下的那一行已在多选集里 ⇒ 拖的是整批（顺序就是勾选顺序），不动选择集', () => {
    const plan = planTreeDragSources({ tree, pressedIndex: idx(A), selectedPaths: [B, A] });
    expect(plan.sources).toEqual([{ path: B, isDir: false }, entryA]);
    expect(plan.collapseTo).toBeNull();
    expect(plan.reason).toBeNull();
  });

  it('按下的那一行不在多选集里 ⇒ 先收到那一行再拖（collapseTo = 它）', () => {
    const plan = planTreeDragSources({ tree, pressedIndex: idx(A), selectedPaths: [B] });
    expect(plan.collapseTo).toBe(A);
    expect(plan.sources).toEqual([entryA]);
  });

  it('目录行与作者包行都算目录（种类从当场还在的行上取，不许把目录当文件搬）', () => {
    expect(planTreeDragSources({ tree, pressedIndex: idx(SUB), selectedPaths: [] }).sources).toEqual([
      { path: SUB, isDir: true },
    ]);
    expect(planTreeDragSources({ tree, pressedIndex: idx(PKG), selectedPaths: [] }).sources).toEqual([entryPkg]);
  });

  it('角色分组头不是可搬动的条目 ⇒ 拖不起来并把原因说出口', () => {
    const g = tree.rows.findIndex((r) => r.kind === 'group');
    const plan = planTreeDragSources({ tree, pressedIndex: g, selectedPaths: [] });
    expect(plan.sources).toEqual([]);
    expect(plan.reason).toContain('角色分组');
  });

  it('说明行不是盘上的条目；行不存在也各有一句人话', () => {
    const n = tree.rows.findIndex((r) => r.kind === 'note');
    expect(planTreeDragSources({ tree, pressedIndex: n, selectedPaths: [] }).reason).toContain('说明');
    expect(planTreeDragSources({ tree, pressedIndex: 9999, selectedPaths: [] }).reason).toContain('不在树里');
  });

  it('多选集里那些已经不在树上的路径剔除（种类只从当场还在的行上取）', () => {
    const plan = planTreeDragSources({ tree, pressedIndex: idx(A), selectedPaths: [A, 'C:/koa/001/没了.ERB'] });
    expect(plan.sources).toEqual([entryA]);
  });

  it('Shift + 按下（锚点在场）⇒ 按 rangePaths 的既有口径连选这一段再拖', () => {
    const from = idx(A);
    const to = idx(B);
    const plan = planTreeDragSources({ tree, pressedIndex: to, selectedPaths: [], anchorIndex: from, shift: true });
    expect(plan.sources.map((s) => s.path)).toEqual([A, B]);
  });
});

describe('treeDragModeOf · 纯拖移动、Ctrl 复制', () => {
  it('纯拖 = move；Ctrl / Cmd = copy', () => {
    expect(treeDragModeOf({ ctrl: false, meta: false })).toBe('move');
    expect(treeDragModeOf({ ctrl: true, meta: false })).toBe('copy');
    expect(treeDragModeOf({ ctrl: false, meta: true })).toBe('copy');
  });
});

describe('planTreeDropTarget · 落点解析', () => {
  it('目录行 = 移进它自己；文件行 = 落到它所在那一格（与 explorer.pasteEntry 同一口径）', () => {
    const onDir = planTreeDropTarget({ tree, overIndex: idx(SUB), sources: [entryA], ctrl: false, meta: false, roots: ROOTS });
    expect(onDir.ok).toBe(true);
    expect(onDir.targetDir).toBe(SUB);
    expect(onDir.mode).toBe('move');

    const onFile = planTreeDropTarget({ tree, overIndex: idx(IN_SUB), sources: [entryA], ctrl: false, meta: false, roots: ROOTS });
    expect(onFile.ok).toBe(true);
    expect(onFile.targetDir).toBe(SUB);
  });

  it('作者包行 / 角色分组行也是落点（包行 = 包目录，组行 = 角色目录）', () => {
    const onPkg = planTreeDropTarget({ tree, overIndex: idx(PKG), sources: [entryA], ctrl: false, meta: false, roots: ROOTS });
    expect(onPkg.targetDir).toBe(PKG);
    const gIdx = tree.rows.findIndex((r) => r.kind === 'group' && r.path === OTHER_DIR);
    const onGroup = planTreeDropTarget({ tree, overIndex: gIdx, sources: [entryA], ctrl: false, meta: false, roots: ROOTS });
    expect(onGroup.ok).toBe(true);
    expect(onGroup.targetDir).toBe(OTHER_DIR);
  });

  it('Ctrl + 拖 ⇒ mode = copy（同一个落点，两种效果）', () => {
    const copy = planTreeDropTarget({ tree, overIndex: idx(SUB), sources: [entryA], ctrl: true, meta: false, roots: ROOTS });
    expect(copy.mode).toBe('copy');
    expect(copy.ok).toBe(true);
  });

  it('拖回自己所在的那一格 ⇒ 如实拒并说出原因（粘贴意图下同层非法）', () => {
    const plan = planTreeDropTarget({ tree, overIndex: idx(B), sources: [entryA], ctrl: false, meta: false, roots: ROOTS });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('本来就在这一格里');
    expect(treeDropRejectSentence(plan.reason ?? '')).toContain('没有落下任何东西');
  });

  it('把文件夹拖进它自己的子目录 ⇒ 计划层判掉，原话照上屏', () => {
    const plan = planTreeDropTarget({ tree, overIndex: idx(SUB), sources: [entryPkg], ctrl: false, meta: false, roots: ROOTS });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('不能放进它自己的子目录里');
  });

  it('跨根的落点不许静默：点名"跨根这一版不做"，并指出出项目的通道是导出', () => {
    const g3 = tree.rows.findIndex((r) => r.kind === 'group' && r.path === 'D:/work/003');
    const plan = planTreeDropTarget({ tree, overIndex: g3, sources: [entryA], ctrl: false, meta: false, roots: ['C:/koa', 'D:/work'] });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('不在同一个文件夹根里');
  });

  it('源本身落在所有根之外 ⇒ 同样点名（不能拿它当搬运的源）', () => {
    const plan = planTreeDropTarget({ tree, overIndex: idx(SUB), sources: [{ path: 'D:/else/a.ERB', isDir: false }], ctrl: false, meta: false, roots: ROOTS });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('不能拿它当搬运的源');
  });

  it('说明行没有落点：说的是"拖到目录行上"的指引', () => {
    const n = tree.rows.findIndex((r) => r.kind === 'note');
    const plan = planTreeDropTarget({ tree, overIndex: n, sources: [entryA], ctrl: false, meta: false, roots: ROOTS });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('目录行');
  });

  it('行不存在（拖到树外）⇒ 一句人话，targetDir 为 null', () => {
    const plan = planTreeDropTarget({ tree, overIndex: -1, sources: [entryA], ctrl: false, meta: false, roots: ROOTS });
    expect(plan).toMatchObject({ ok: false, targetDir: null, rowId: null });
    expect(plan.reason).toContain('不在树里');
  });

  it('手上没有条目 ⇒ 也说得出为什么（不是"松手没反应"）', () => {
    const plan = planTreeDropTarget({ tree, overIndex: idx(SUB), sources: [], ctrl: false, meta: false, roots: ROOTS });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('没有可以搬动的条目');
  });

  it('一批里只有部分是非法的 ⇒ 照落（ok），但非法那几条的原因要提前看得见', () => {
    const plan = planTreeDropTarget({
      tree,
      overIndex: idx(SUB),
      sources: [entryPkg, entryA],
      ctrl: false,
      meta: false,
      roots: ROOTS,
    });
    expect(plan.ok).toBe(true);
    expect(plan.reason).toContain('不能放进它自己的子目录里');
  });
});

describe('载荷与 MIME 约定（只认自家那条腿）', () => {
  it('编解码往返一致（含目录种类）', () => {
    const sources: FileOpEntry[] = [entryA, entryPkg];
    expect(decodeTreeDragPayload(encodeTreeDragPayload(sources))).toEqual(sources);
  });

  it('坏载荷宽容退化：非 JSON / 形状不对 / 空串都成空集合，绝不抛', () => {
    expect(decodeTreeDragPayload('{"a":1}')).toEqual([]);
    expect(decodeTreeDragPayload('[["x.ERB",2],["",0],null,[null,null]]')).toEqual([]);
    expect(decodeTreeDragPayload('["C:/koa/a.ERB"]')).toEqual([]);
    expect(decodeTreeDragPayload(null)).toEqual([]);
    expect(decodeTreeDragPayload(undefined)).toEqual([]);
    expect(decodeTreeDragPayload('')).toEqual([]);
  });

  it('本层只认自家 MIME：外部文件拖入（Files）不会误触发', () => {
    expect(acceptsTreeDrop([TREE_DRAG_MIME])).toBe(true);
    expect(acceptsTreeDrop(['Files', 'text/plain'])).toBe(false);
    expect(acceptsTreeDrop([])).toBe(false);
  });
});

describe('落点高亮与源判定（形状由判决决定）', () => {
  it('可落 = 一档描边；非法 = 同一档描边加"不许落"的变体（两者都看得见）', () => {
    expect(treeDropClasses(true)).toEqual(['kojo-drop-hover']);
    expect(treeDropClasses(false)).toContain('kojo-drop-hover');
    expect(treeDropClasses(false)).toContain('kojo-drop-nocopy');
  });

  it('能当源的行 = 能复制 / 剪切的那几行（角色分组头与说明行都不是）', () => {
    expect(rowIsDragSource(tree.rows[idx(A)])).toBe(true);
    expect(rowIsDragSource(tree.rows[idx(SUB)])).toBe(true);
    expect(rowIsDragSource(tree.rows.find((r) => r.kind === 'group'))).toBe(false);
    expect(rowIsDragSource(tree.rows.find((r) => r.kind === 'note'))).toBe(false);
    expect(rowIsDragSource(undefined)).toBe(false);
  });

  it('行号口径仍然只有一份（note 行不在模型里 ⇒ indexOfId 找不到）', () => {
    expect(noteIdx).toBeLessThan(0);
  });
});
