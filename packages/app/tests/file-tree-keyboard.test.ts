/**
 * 键盘语义判据（WS-11）的单测——**每条键位都有据可查**。
 *
 * 为什么必须单测这层：组件里的接线是"读到哪一行、preventDefault 了没有"，
 * 一旦判据漂了（比如把 ↑ 的越界当成"绕回开头"），只有把浏览器开起来按一遍才看得见。
 * 判据住纯模块 ⇒ 这里就能钉死，组件只余"照结果办事"。
 */
import { describe, expect, it } from 'vitest';
import { buildKojoFlatTree, firstNavigable, indexOfId, lastNavigable } from '../src/ui/file-tree-flat';
import type { Group } from '../src/ui/file-tree-types';
import { nextNavigable, planRowClick, planTreeKey, rowIsDir, treeKeyEventOf, edgeNavigable } from '../src/ui/file-tree-keyboard';

const group = (label: string, prefix: string, subs: Array<{ label: string | null; files: string[] }>): Group => ({
  label,
  prefix,
  subs: subs.map((s) => ({ label: s.label, files: [...s.files] })),
  total: subs.reduce((n, s) => n + s.files.length, 0),
});

/** 两个角色目录：一个展开（含一个作者包 + 一段根散文件）、一个折叠 */
const tree = buildKojoFlatTree({
  groups: [
    {
      group: group('#1 灵梦', 'C:/koa/001', [
        { label: null, files: ['C:/koa/001/散落.ERB'] },
        { label: '包A', files: ['C:/koa/001/包A/a.ERB', 'C:/koa/001/包A/b.ERB'] },
      ]),
      open: true,
      pkgFolderOpen: () => false,
    },
    { group: group('#2 巫女', 'C:/koa/002', [{ label: '包B', files: ['C:/koa/002/包B/c.ERB'] }]), open: false, pkgFolderOpen: () => false },
  ],
  subOpen: new Set(),
  dirCache: new Map(),
  pkgDirOf: (prefix, label) => `${prefix}/${label}`,
});

// 行序：0 组头1 | 1 散文件 | 2 包头 | 3 a.ERB | 4 b.ERB | 5 组头2
const ev = (key: string, mod: Partial<{ shift: boolean; ctrl: boolean; meta: boolean; alt: boolean }> = {}): ReturnType<typeof treeKeyEventOf> =>
  treeKeyEventOf({ key, shiftKey: mod.shift ?? false, ctrlKey: mod.ctrl ?? false, metaKey: mod.meta ?? false, altKey: mod.alt ?? false });

describe('planTreeKey · 移动', () => {
  it('↓ / ↑ 沿行序走，跨组不回头', () => {
    expect(planTreeKey(ev('ArrowDown'), tree, 0)).toEqual({ type: 'focus', index: 1, extend: false });
    expect(planTreeKey(ev('ArrowUp'), tree, 1)).toEqual({ type: 'focus', index: 0, extend: false });
    expect(planTreeKey(ev('ArrowDown'), tree, 4)).toEqual({ type: 'focus', index: 5, extend: false });
  });

  it('已经到底 / 到顶 ⇒ 不接管也不乱跳（"绕回开头"是读起来像 bug 的那种动作）', () => {
    expect(planTreeKey(ev('ArrowDown'), tree, 5)).toEqual({ type: 'noop' });
    expect(planTreeKey(ev('ArrowUp'), tree, 0)).toEqual({ type: 'noop' });
  });

  it('还没有焦点行时，第一次按 ↓ 就落到第一行', () => {
    expect(planTreeKey(ev('ArrowDown'), tree, -1)).toEqual({ type: 'focus', index: 0, extend: false });
  });

  it('Shift + ↓ = 连选（extend 位由修饰键决定，落点与不连选时同一行）', () => {
    expect(planTreeKey(ev('ArrowDown', { shift: true }), tree, 1)).toEqual({ type: 'focus', index: 2, extend: true });
  });

  it('Home / End 落在首末行', () => {
    expect(planTreeKey(ev('Home'), tree, 3)).toEqual({ type: 'focus', index: 0, extend: false });
    expect(planTreeKey(ev('End'), tree, 3)).toEqual({ type: 'focus', index: 5, extend: false });
  });

  it('说明行不是树项：↑↓ 直接跨过它', () => {
    const withNote = buildKojoFlatTree({
      groups: [{ group: group('#1', 'C:/a', [{ label: null, files: ['C:/a/x.ERB'] }]), open: true, pkgFolderOpen: () => false, note: '读取文件夹…' }],
      subOpen: new Set(),
      dirCache: new Map(),
      pkgDirOf: (p, l) => `${p}/${l}`,
    });
    // 0 组头 | 1 说明行 | 2 文件
    expect(nextNavigable(withNote, 0, 1)).toBe(2);
    expect(nextNavigable(withNote, 2, -1)).toBe(0);
    expect(edgeNavigable(withNote, 'first')).toBe(0);
    expect(edgeNavigable(withNote, 'last')).toBe(2);
  });
});

describe('planTreeKey · 展开与收起', () => {
  it('→ 折叠着就展开；已展开就进第一个子层', () => {
    expect(planTreeKey(ev('ArrowRight'), tree, 5)).toEqual({ type: 'expand', index: 5 }); // 折叠的组头2
    expect(planTreeKey(ev('ArrowRight'), tree, 0)).toEqual({ type: 'focus', index: 1, extend: false }); // 已展开 → 进子层
    expect(planTreeKey(ev('ArrowRight'), tree, 2)).toEqual({ type: 'expand', index: 2 }); // 折叠的包：先展开，不假装看得见
  });

  it('→ 已点开的包进它的真实文件夹层（子层第一个可聚焦的行）', () => {
    const dirTree = buildKojoFlatTree({
      groups: [{ group: group('#1 灵梦', 'C:/koa/001', [{ label: '包A', files: ['C:/koa/001/包A/a.ERB'] }]), open: true, pkgFolderOpen: () => true }],
      subOpen: new Set(['C:/koa/001/包A']),
      dirCache: new Map([['C:/koa/001/包A', [{ name: 'sub', path: 'C:/koa/001/包A/sub', isDirectory: true }]]]),
      pkgDirOf: (prefix, label) => `${prefix}/${label}`,
    });
    // 0 组头 | 1 包头(已点开) | 2 目录行 | 3 平铺 ERB
    expect(planTreeKey(ev('ArrowRight'), dirTree, 1)).toEqual({ type: 'focus', index: 2, extend: false });
    expect(planTreeKey(ev('ArrowLeft'), dirTree, 3)).toEqual({ type: 'focus', index: 1, extend: false });
    expect(planTreeKey(ev('ArrowLeft'), dirTree, 1)).toEqual({ type: 'collapse', index: 1 });
  });

  it('子层全是说明行时 → 不假装进得去（noop 比"跳到看不见的行"诚实）', () => {
    const noteTree = buildKojoFlatTree({
      groups: [{ group: group('#1', 'C:/a', [{ label: null, files: [] }]), open: true, pkgFolderOpen: () => false, note: '这个文件夹里还没有 ERB 方言文件' }],
      subOpen: new Set(),
      dirCache: new Map(),
      pkgDirOf: (p, l) => `${p}/${l}`,
    });
    // 0 组头 | 1 说明行 —— 没有可聚焦的子项
    expect(planTreeKey(ev('ArrowRight'), noteTree, 0)).toEqual({ type: 'noop' });
  });

  it('← 展开着就收起；已收起 / 叶子行回父层', () => {
    expect(planTreeKey(ev('ArrowLeft'), tree, 0)).toEqual({ type: 'collapse', index: 0 });
    expect(planTreeKey(ev('ArrowLeft'), tree, 3)).toEqual({ type: 'focus', index: 2, extend: false });
    expect(planTreeKey(ev('ArrowLeft'), tree, 5)).toEqual({ type: 'noop' }); // 顶层折叠行：已经没有父可回
  });

  it('叶子行按 → 什么都不做（不许"展开"出一个不存在的子层）', () => {
    expect(planTreeKey(ev('ArrowRight'), tree, 1)).toEqual({ type: 'noop' });
  });
});

describe('planTreeKey · 打开与编辑动作', () => {
  it('Enter / Space 打开文件行；结构行改成展开收起', () => {
    expect(planTreeKey(ev('Enter'), tree, 3)).toEqual({ type: 'open', index: 3 });
    expect(planTreeKey(ev(' '), tree, 3)).toEqual({ type: 'open', index: 3 });
    expect(planTreeKey(ev('Enter'), tree, 2)).toEqual({ type: 'toggle', index: 2 });
  });

  it('F2 = 重命名（文件 / 目录 / 作者包都有；角色组目录没有这条腿）', () => {
    expect(planTreeKey(ev('F2'), tree, 3)).toEqual({ type: 'rename', index: 3 });
    expect(planTreeKey(ev('F2'), tree, 2)).toEqual({ type: 'rename', index: 2 });
    expect(planTreeKey(ev('F2'), tree, 0)).toEqual({ type: 'noop' });
  });

  it('Delete = 删除（同一批可rename 的行）', () => {
    expect(planTreeKey(ev('Delete'), tree, 1)).toEqual({ type: 'delete', index: 1 });
    expect(planTreeKey(ev('Delete'), tree, 0)).toEqual({ type: 'noop' });
  });

  it('isDir 的判据与删除/重命名走哪条 IO 腿对齐', () => {
    expect(rowIsDir(tree, 3)).toBe(false);
    expect(rowIsDir(tree, 2)).toBe(true);
    expect(rowIsDir(tree, 0)).toBe(false); // 角色组目录不给删除
  });

  it('Ctrl / Cmd + A = 全选', () => {
    expect(planTreeKey(ev('a', { ctrl: true }), tree, 3)).toEqual({ type: 'selectAll' });
    expect(planTreeKey(ev('a', { meta: true }), tree, 3)).toEqual({ type: 'selectAll' });
  });

  it('没有焦点行 ⇒ 一切需要宾语的动作为 noop（没有当前行就没有"这一份"）', () => {
    expect(planTreeKey(ev('F2'), tree, -1)).toEqual({ type: 'noop' });
    expect(planTreeKey(ev('Enter'), tree, -1)).toEqual({ type: 'noop' });
    expect(planTreeKey(ev('Delete'), tree, -1)).toEqual({ type: 'noop' });
  });
});

describe('planTreeKey · 不抢键（白名单）', () => {
  it('表外的键一律 noop：字母 / 组合键 / 修饰键本身都交回宿主与编辑器', () => {
    expect(planTreeKey(ev('x'), tree, 3)).toEqual({ type: 'noop' });
    expect(planTreeKey(ev('Tab'), tree, 3)).toEqual({ type: 'noop' });
    expect(planTreeKey(ev('PageDown'), tree, 3)).toEqual({ type: 'noop' });
    expect(planTreeKey(ev('c', { ctrl: true }), tree, 3)).toEqual({ type: 'noop' });
    expect(planTreeKey(ev('ArrowDown', { ctrl: true }), tree, 3)).toEqual({ type: 'noop' });
    expect(planTreeKey(ev('a', { shift: true, ctrl: true }), tree, 3)).toEqual({ type: 'noop' });
  });

  it('Alt 一律不碰（Alt+… 是宿主与输入法的）', () => {
    expect(planTreeKey({ key: 'ArrowDown', shift: false, ctrl: false, meta: false, alt: true }, tree, 0)).toEqual({ type: 'noop' });
  });
});

describe('行号与点击语义', () => {
  it('firstNavigable / lastNavigable / indexOfId 与模型同一份行序', () => {
    expect(firstNavigable(tree)).toBe(0);
    expect(lastNavigable(tree)).toBe(5);
    expect(indexOfId(tree, 'C:/koa/001/包A/b.ERB')).toBe(4);
    expect(indexOfId(tree, '没有这一行')).toBe(-1);
  });

  it('Shift + 点击 = 连选；其余点击只把焦点带过去（打开与勾选仍由行组件自己办）', () => {
    expect(planRowClick({ shift: true, ctrl: false, meta: false }, 4)).toEqual({ type: 'range', index: 4 });
    expect(planRowClick({ shift: false, ctrl: false, meta: false }, 4)).toEqual({ type: 'focus', index: 4 });
    expect(planRowClick({ shift: false, ctrl: true, meta: false }, 4)).toEqual({ type: 'focus', index: 4 });
  });
});
