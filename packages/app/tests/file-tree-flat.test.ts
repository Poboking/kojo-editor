/**
 * 扁平行模型（WS-12）的单测：行的**顺序、层级、像素顶部、父子指针、叶子块区间**。
 *
 * 这份模型是虚拟化与键盘导航共同的地基 ⇒ 这里钉的是"模型说有什么行"，
 * 而"DOM 上真的挂了什么行"由 `file-tree-a11y-virtual.test.tsx` 对着同一批判据复验。
 *
 * 另有一条**样式表同尺闸**：模型里的行高与两处 `<ul>` 下边距是按 CSS 的字面值复算的，
 * CSS 那三处一改，两边就会错位（表现为滚到底露空白 / 行高算错），所以让它先在这儿红。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DirEntry } from '@kojo/plugin-api';
import {
  GAP_GROUP_UL,
  GAP_NESTED_UL,
  TREE_ROW_H,
  buildFsFlatTree,
  buildKojoFlatTree,
  groupRowId,
  indexOfId,
  leafRowId,
  packageRowId,
  rangePaths,
  rowAt,
} from '../src/ui/file-tree-flat';
import type { DirState, Group } from '../src/ui/file-tree-types';

const entry = (name: string, isDirectory: boolean, dir: string): DirEntry => ({
  name,
  path: `${dir}/${name}`,
  isDirectory,
});

const group = (label: string, prefix: string, subs: Array<{ label: string | null; files: string[] }>): Group => ({
  label,
  prefix,
  subs: subs.map((s) => ({ label: s.label, files: [...s.files] })),
  total: subs.reduce((n, s) => n + s.files.length, 0),
});

const A1 = 'C:/koa/001/包A/M_KOJO_K1_a.ERB';
const A2 = 'C:/koa/001/包A/M_KOJO_K1_b.ERB';
const LOOSE = 'C:/koa/001/散落.ERB';

const base = group('#1 灵梦', 'C:/koa/001', [
  { label: null, files: [LOOSE] },
  { label: '包A', files: [A1, A2] },
]);

const NO_DIR: ReadonlyMap<string, DirState> = new Map();

describe('buildKojoFlatTree · 行序与层级', () => {
  it('折叠组只有一行（组头），且不产出叶子块', () => {
    const tree = buildKojoFlatTree({
      groups: [{ group: base, open: false, pkgFolderOpen: () => false }],
      subOpen: new Set(),
      dirCache: NO_DIR,
      pkgDirOf: (prefix, label) => `${prefix}/${label}`,
    });
    expect(tree.rows).toHaveLength(1);
    const header = rowAt(tree, 0)!;
    expect(header).toMatchObject({ id: groupRowId('#1 灵梦'), kind: 'group', level: 1, expandable: true, open: false, parentIdx: -1 });
    expect(tree.groups[0]!.blocks).toHaveLength(0);
  });

  it('展开组：组头 → 根散文件 → 包头 → 包内文件，层级 1/2/2/3', () => {
    const tree = buildKojoFlatTree({
      groups: [{ group: base, open: true, pkgFolderOpen: () => false }],
      subOpen: new Set(),
      dirCache: NO_DIR,
      pkgDirOf: (prefix, label) => `${prefix}/${label}`,
    });
    expect(tree.rows.map((r) => [r.kind, r.level])).toEqual([
      ['group', 1],
      ['file', 2],
      ['package', 2],
      ['file', 3],
      ['file', 3],
    ]);
    expect(tree.rows.map((r) => r.id)).toEqual([
      groupRowId('#1 灵梦'),
      leafRowId(LOOSE),
      packageRowId('#1 灵梦::包A'),
      leafRowId(A1),
      leafRowId(A2),
    ]);
  });

  it('父子指针：文件的父是包头、包头的父是组头、组头没有父', () => {
    const tree = buildKojoFlatTree({
      groups: [{ group: base, open: true, pkgFolderOpen: () => false }],
      subOpen: new Set(),
      dirCache: NO_DIR,
      pkgDirOf: (prefix, label) => `${prefix}/${label}`,
    });
    expect(rowAt(tree, 2)!.parentIdx).toBe(0); // 包头 → 组头
    expect(rowAt(tree, 3)!.parentIdx).toBe(2); // 包内文件 → 包头
    expect(rowAt(tree, 1)!.parentIdx).toBe(0); // 根散文件 → 组头
    expect(rowAt(tree, 0)!.parentIdx).toBe(-1);
    expect(rowAt(tree, 0)!.childIdx).toBe(1); // 第一个子行 = 根散文件
  });

  it('limitOf 裁掉的是**模型里的行**（与过滤窗口同一口径，不留第二份真相）', () => {
    const tree = buildKojoFlatTree({
      groups: [{ group: base, open: true, pkgFolderOpen: () => false, limitOf: (i) => (i === 1 ? 1 : 0) }],
      subOpen: new Set(),
      dirCache: NO_DIR,
      pkgDirOf: (prefix, label) => `${prefix}/${label}`,
    });
    // 根散文件那段预算 0 ⇒ 一行不挂；包A 只给 1 行
    expect(tree.rows.map((r) => r.kind)).toEqual(['group', 'package', 'file']);
    expect(rowAt(tree, 2)!.path).toBe(A1);
    const block = tree.blockOf(0, 1)!;
    expect({ ...block, start: block.start, end: block.end }).toMatchObject({ start: 2, end: 3, scatter: false, pkgKey: '#1 灵梦::包A' });
  });

  it('说明行（读不到 / 还没有方言文件）占一行高但不参与键盘导航', () => {
    const tree = buildKojoFlatTree({
      groups: [{ group: base, open: true, pkgFolderOpen: () => false, note: '这个文件夹读不到', key: 'root:C:/work' }],
      subOpen: new Set(),
      dirCache: NO_DIR,
      pkgDirOf: (prefix, label) => `${prefix}/${label}`,
    });
    expect(tree.rows[1]!.kind).toBe('note');
    expect(tree.rows[1]!.top).toBe(TREE_ROW_H);
    expect(tree.rows[2]!.top).toBe(TREE_ROW_H * 2);
    expect(indexOfId(tree, groupRowId('root:C:/work'))).toBe(0);
  });
});

describe('buildKojoFlatTree · 包内真实文件夹（递归）', () => {
  const dir = 'C:/koa/001/包A';
  const cache: ReadonlyMap<string, DirState> = new Map<string, DirState>([
    [dir, [entry('sub', true, dir), entry('readme.txt', false, dir), entry('附.ERB', false, dir)]],
    [`${dir}/sub`, [entry('深.ERB', false, `${dir}/sub`)]],
  ]);

  it('追加式：包头 → 目录行 → 目录内容 → 附加文件 → 平铺 ERB', () => {
    const tree = buildKojoFlatTree({
      groups: [{ group: base, open: true, pkgFolderOpen: (k) => k === '#1 灵梦::包A' }],
      subOpen: new Set([dir, `${dir}/sub`]),
      dirCache: cache,
      pkgDirOf: (prefix, label) => `${prefix}/${label}`,
    });
    expect(tree.rows.map((r) => `${r.kind}@${r.level}`)).toEqual([
      'group@1',
      'file@2',
      'package@2',
      'dir@3',
      'file@4',
      'file@3',
      'file@3',
      'file@3',
      'file@3',
    ]);
    // 三档下边距：递归层（sub 的 nested ul）+ 包的 ERB 列表 + 角色组内容列表；
    // 包根层自己不叠（`.pkg-real` 被压成 0）
    expect(tree.height).toBe(9 * TREE_ROW_H + 2 * GAP_NESTED_UL + GAP_GROUP_UL);
  });

  it('包根层的 ERB 与平铺列表同级 ⇒ 按 skip 去重（不对文件系统撒谎，也不重复列一遍）', () => {
    const dup: ReadonlyMap<string, DirState> = new Map<string, DirState>([[dir, [entry('M_KOJO_K1_a.ERB', false, dir), entry('只在这里.ERB', false, dir)]]]);
    const tree = buildKojoFlatTree({
      groups: [{ group: group('#1 灵梦', 'C:/koa/001', [{ label: '包A', files: [A1] }]), open: true, pkgFolderOpen: () => true }],
      subOpen: new Set(),
      dirCache: dup,
      pkgDirOf: (prefix, label) => `${prefix}/${label}`,
    });
    expect(tree.rows.map((r) => r.path)).toEqual([
      'C:/koa/001',
      'C:/koa/001/包A',
      `${dir}/只在这里.ERB`,
      A1,
    ]);
  });

  it('未列举 / 读取中 / 读取失败各画一行说明，且不带叶子块', () => {
    const loading = buildKojoFlatTree({
      groups: [{ group: group('#1', 'C:/koa/001', [{ label: '包A', files: [] }]), open: true, pkgFolderOpen: () => true }],
      subOpen: new Set(['C:/koa/001/包A']),
      dirCache: new Map<string, DirState>([['C:/koa/001/包A', 'loading']]),
      pkgDirOf: (prefix, label) => `${prefix}/${label}`,
    });
    expect(loading.rows.map((r) => r.kind)).toEqual(['group', 'package', 'note']);
    expect(loading.blockOf(0, 0)).toBeUndefined();
  });
});

describe('buildKojoFlatTree · 像素顶部与总高', () => {
  const build = (open: boolean, folderOpen: boolean): ReturnType<typeof buildKojoFlatTree> =>
    buildKojoFlatTree({
      groups: [{ group: base, open, pkgFolderOpen: () => folderOpen }],
      subOpen: new Set(),
      dirCache: NO_DIR,
      pkgDirOf: (prefix, label) => `${prefix}/${label}`,
    });

  it('行顶逐步累加行高；组内容列表那一档下边距算进总高、不算进行顶', () => {
    const tree = build(true, false);
    expect(tree.rows.map((r) => r.top)).toEqual([0, 22, 44, 66, 88]);
    // 5 行 × 22 + 组列表 4px（包的 ERB 列表那档下边距也在其中：包A 有列表、根散文件没有）
    expect(tree.height).toBe(5 * TREE_ROW_H + GAP_GROUP_UL + GAP_NESTED_UL);
  });

  it('折叠组只有组头一行，不带任何下边距', () => {
    const tree = build(false, false);
    expect(tree.height).toBe(TREE_ROW_H);
  });

  it('多组之间互不串味（第二组的顶部 = 第一组的总高）', () => {
    const two = buildKojoFlatTree({
      groups: [
        { group: base, open: true, pkgFolderOpen: () => false },
        { group: group('#2 巫女', 'C:/koa/002', [{ label: '包B', files: ['C:/koa/002/包B/x.ERB'] }]), open: false, pkgFolderOpen: () => false },
      ],
      subOpen: new Set(),
      dirCache: NO_DIR,
      pkgDirOf: (prefix, label) => `${prefix}/${label}`,
    });
    const first = two.groups[0]!;
    const second = two.groups[1]!;
    expect(second.headerIdx).toBe(first.end);
    expect(rowAt(two, second.headerIdx)!.top).toBe(first.end * TREE_ROW_H + GAP_GROUP_UL + GAP_NESTED_UL);
  });
});

/* ------------------------------ 三层裁点的像素上下沿（WS-12 欠账批） ------------------------------ */

describe('GroupRange.span / SubRange.span · 组与包也是裁点', () => {
  const tree = buildKojoFlatTree({
    groups: [{ group: base, open: true, pkgFolderOpen: () => false }],
    subOpen: new Set(),
    dirCache: NO_DIR,
    pkgDirOf: (prefix, label) => `${prefix}/${label}`,
  });

  it('整组的 span = 组头那一行起、组列表下边距止（行与缝一次算清）', () => {
    const g = tree.groups[0]!;
    // 5 行 × 22 + 包 ERB 列表 2px + 角色组列表 4px
    expect(g.span).toEqual({ start: 0, end: 5, topPx: 0, bottomPx: 5 * TREE_ROW_H + GAP_NESTED_UL + GAP_GROUP_UL });
    expect(g.span.bottomPx).toBe(tree.height);
  });

  it('子段两档形状各有其份：根散文件没头没缝，作者包带头也带 ERB 列表那档缝', () => {
    const g = tree.groups[0]!;
    expect(g.subs).toHaveLength(2);
    // [组头, 散落.ERB, 包头, A1, A2]：散落那段 = 第 1 行，包那段 = 第 2..4 行 + 2px 缝
    expect(g.subs[0]).toEqual({ span: { start: 1, end: 2, topPx: 22, bottomPx: 44 }, headerIdx: -1 });
    expect(g.subs[1]).toEqual({ span: { start: 2, end: 5, topPx: 44, bottomPx: 44 + 3 * TREE_ROW_H + GAP_NESTED_UL }, headerIdx: 2 });
    // 子段首尾相接（缝长在段自己身上，段间不另插一档）
    expect(g.subs[1]!.span.topPx).toBe(g.subs[0]!.span.bottomPx);
  });

  it('折叠组的 span 就是组头那一行、子段清单为空（没有下边距可垫）', () => {
    const closed = buildKojoFlatTree({
      groups: [{ group: base, open: false, pkgFolderOpen: () => false }],
      subOpen: new Set(),
      dirCache: NO_DIR,
      pkgDirOf: (prefix, label) => `${prefix}/${label}`,
    });
    expect(closed.groups[0]!.span).toEqual({ start: 0, end: 1, topPx: 0, bottomPx: TREE_ROW_H });
    expect(closed.groups[0]!.subs).toEqual([]);
  });

  it('说明行也算在组的"段外行"里（有它就没有整组少一档 22px）', () => {
    const noted = buildKojoFlatTree({
      groups: [{ group: base, open: true, pkgFolderOpen: () => false, note: '读取文件夹…', key: 'root:C:/work' }],
      subOpen: new Set(),
      dirCache: NO_DIR,
      pkgDirOf: (prefix, label) => `${prefix}/${label}`,
    });
    const g = noted.groups[0]!;
    expect(g.subs[0]!.span.topPx).toBe(2 * TREE_ROW_H); // 组头 + 说明行 之后才是第一段
    expect(g.subs[0]!.headerIdx).toBe(-1);
    expect(g.span.bottomPx).toBe(noted.height);
  });

  it('点开真实文件夹：目录行归进同一段，段底只多那档 ERB 缝（缝不被算两次）', () => {
    const dir = 'C:/koa/001/包A';
    const cache: ReadonlyMap<string, DirState> = new Map<string, DirState>([
      [dir, [entry('sub', true, dir), entry('readme.txt', false, dir)]],
      [`${dir}/sub`, [entry('深.ERB', false, `${dir}/sub`)]],
    ]);
    const withDirs = buildKojoFlatTree({
      groups: [{ group: base, open: true, pkgFolderOpen: () => true }],
      subOpen: new Set([dir, `${dir}/sub`]),
      dirCache: cache,
      pkgDirOf: (prefix, label) => `${prefix}/${label}`,
    });
    const g = withDirs.groups[0]!;
    const pkg = g.subs[1]!;
    expect(pkg.headerIdx).toBe(pkg.span.start); // 段就是从包头开始
    // 行：组头 / 散落 / 包头 / sub / 深.ERB / readme.txt / A1 / A2 = 8 行 + 两档递归缝 + 一档 ERB 缝 + 组缝
    expect(withDirs.rows).toHaveLength(8);
    expect(withDirs.height).toBe(8 * TREE_ROW_H + 2 * GAP_NESTED_UL + GAP_GROUP_UL);
    // 段内账：包头 + 目录三层（6 行）+ 两档递归/ERB 缝（sub 的 nested ul、包的 ERB ul）= 段高
    expect(pkg.span.bottomPx - pkg.span.topPx).toBe(6 * TREE_ROW_H + 2 * GAP_NESTED_UL);
    // 上一段（根散文件）不带缝、下一段紧接其后
    expect(g.subs[0]!.span.bottomPx).toBe(pkg.span.topPx);
  });
});

describe('rangePaths / indexOfId · 连选与焦点定位取的是同一批行', () => {
  const tree = buildKojoFlatTree({
    groups: [{ group: base, open: true, pkgFolderOpen: () => false }],
    subOpen: new Set(),
    dirCache: NO_DIR,
    pkgDirOf: (prefix, label) => `${prefix}/${label}`,
  });

  it('区间两端都含、顺序无关，且只收文件', () => {
    expect(rangePaths(tree, 1, 4)).toEqual([LOOSE, A1, A2]);
    expect(rangePaths(tree, 4, 1)).toEqual([LOOSE, A1, A2]);
    expect(rangePaths(tree, 0, 2)).toEqual([LOOSE]); // 组头与包头不是文件
  });

  it('越界端点被夹进模型（不把 undefined 漏给调用侧）', () => {
    expect(rangePaths(tree, -5, 999)).toEqual([LOOSE, A1, A2]);
  });

  it('indexOfId 认叶子行与结构行两类 id', () => {
    expect(indexOfId(tree, leafRowId(A2))).toBe(4);
    expect(indexOfId(tree, packageRowId('#1 灵梦::包A'))).toBe(2);
    expect(indexOfId(tree, '不存在')).toBe(-1);
  });
});

describe('buildFsFlatTree · 文件系统视图', () => {
  const root = 'C:/game';
  const cache: ReadonlyMap<string, DirState> = new Map<string, DirState>([
    [root, [entry('kojo', true, root), entry(' readme.txt', false, root)]],
    [`${root}/kojo`, [entry('001', true, `${root}/kojo`)]],
  ]);

  it('单根形态没有组头行：第 0 层就是第 1 层（目录在前、文件在后，递归紧贴在目录行下面）', () => {
    const tree = buildFsFlatTree({
      roots: [{ key: root, label: 'game', dir: root, open: true }],
      multiRoot: false,
      subOpen: new Set([`${root}/kojo`]),
      dirCache: cache,
    });
    expect(tree.rows.map((r) => `${r.kind}@${r.level}`)).toEqual(['dir@1', 'dir@2', 'file@1']);
    // 唯一展开着的那层（kojo）带一档递归列表下边距
    expect(tree.height).toBe(3 * TREE_ROW_H + GAP_NESTED_UL);
  });

  it('多根形态的根分组头是一条**目录行**（展开态住 subOpen，不是 opened）', () => {
    const tree = buildFsFlatTree({
      roots: [
        { key: root, label: 'game', dir: root, open: true },
        { key: 'D:/work', label: 'work', dir: 'D:/work', open: false },
      ],
      multiRoot: true,
      subOpen: new Set([root]),
      dirCache: cache,
    });
    expect(tree.rows.map((r) => `${r.kind}@${r.level}`)).toEqual(['dir@1', 'dir@2', 'file@2', 'dir@1']);
    expect(rowAt(tree, 0)!.id).toBe(root);
    expect(tree.groups.map((g) => g.open)).toEqual([true, false]);
    expect(tree.height).toBe(4 * TREE_ROW_H + GAP_GROUP_UL);
  });
});

/* ------------------------------ 样式表同尺闸 ------------------------------ */

describe('行模型的像素口径与 CSS 同源', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const styles = read('../src/styles-project.css');
  const tokens = read('../src/tokens.css');
  const flat = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
  const src = flat(styles);

  it('--tree-row-h 仍是 22px（模型的 TREE_ROW_H 就是它）', () => {
    expect(src).toMatch(/--tree-row-h: 22px/);
    expect(TREE_ROW_H).toBe(22);
  });

  it('角色组内容列表的下边距仍是 var(--space-1)（= 4px，GAP_GROUP_UL）', () => {
    expect(src).toMatch(/\.tree-files \{ list-style: none; margin: 0 0 var\(--space-1\);/);
    expect(flat(tokens)).toMatch(/--space-1: 4px/);
    expect(GAP_GROUP_UL).toBe(4);
  });

  it('嵌套列表的下边距仍是 var(--space-0)（= 2px，GAP_NESTED_UL），且 .pkg-real 压成 0', () => {
    expect(src).toMatch(/\.tree-files\.nested \{ padding-left: 0; margin-bottom: var\(--space-0\); \}/);
    expect(src).toMatch(/\.pkg-real \{ margin-bottom: 0; \}/);
    expect(flat(tokens)).toMatch(/--space-0: 2px/);
    expect(GAP_NESTED_UL).toBe(2);
  });
});
