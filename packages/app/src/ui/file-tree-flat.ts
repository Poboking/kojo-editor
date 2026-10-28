/**
 * 文件树的**扁平行模型**（零 React、零 IO；WS-12 规模能力批新建）。
 *
 * ## 为什么要把树折成一份扁平行
 *
 * 树在 DOM 上是嵌套的（角色组 → 作者包 → 行，外加包内真实文件夹的递归），但**读者眼里它是一列行**：
 * 键盘的 ↑↓ 要"下一行"、虚拟化要"视口里第 30 到第 70 行"、读屏要"这一行的层级是几"。
 * 这三件事过去只能在 JSX 里各算各的（或者干脆算不出来 ⇒ 非过滤态整棵全挂进 DOM）。
 * 本模块把"当前现场会被画成哪些行"**一次算清**成一个有序数组，每行带：
 *
 * - `top`（像素）：这一行在滚动容器内容坐标里的位置 ⇒ 虚拟化与锚点保持都按它做算术，
 *   不假设"行高处处相等"（组列表 / 嵌套列表各带一档下边距，那些缝是真高度，
 *   假装看不见就会在滚到底时露出空白）；
 * - `level`：直接就是 `aria-level`（层级只有一份判据，读屏与键盘用的是同一个数）；
 * - `id`：稳定行号 = DOM 上的 `data-tid` ⇒ 键盘移动"焦点在第 n 行"不需要 DOM 顺序参与；
 * - `parentIdx` / `childIdx`：← / → 与父子跳转用，不靠 DOM 上溯；
 * - `blocks`：**叶子块**（一个包 / 一段根散文件的可裁行区间）——平铺 ERB 层的裁点；
 *   组与包两层的裁点是同文件里的 `groups[].span` / `groups[].subs[].span`（见下面那段三层口径）。
 *
 * ## 裁切的口径分三层（WS-12 欠账批收口）
 *
 * 最初只裁**叶子行**，理由是"结构行由作者手动展开、规模自带约束"。真语料（2,689 行）实测把这理由推翻了：
 * 索引一次灌进来的包与角色组本身就是 136 + 194 枚，滚到深处时挂载的 360 枚 treeitem 里
 * 只有 31 枚是文件行——**其余全是恒挂载的组头与包头**。所以裁剪上提到三层：
 * 组（`GroupRange.span`）→ 包 / 根散文件（`SubRange.span`）→ 平铺 ERB（`LeafBlock`）。
 * 每层都过 `file-tree-virtual.sliceSpan` 那三条不变量，视口在外的一律只垫高度。
 *
 * 仍然保留的一条纪律：**行语义一个字没动**——`rows` 的顺序、`top`、`level`、父子指针、
 * `leaf/selectable` 的判据都还是老那份；本批只往上加"块"的口径（`span`/`subs`），
 * 也就是"每块在滚动坐标里从哪到哪"，让裁与不裁都从同一份模型读数。
 *
 * 目录递归层（`DirRows`，包内真实文件夹）不进这套裁剪：它规模由展开动作本身约束、
 * 而且递归 `<ul>` 没有可用的裁点；整包被裁时它随包的 `span` 一起垫高，所以不会出现双份高度。
 *
 * ## `top` 的缝必须与 CSS 同源
 *
 * 行高与两处下边距是 CSS 里的事实（`--tree-row-h` / `.tree-files` / `.tree-files.nested`），
 * 本模块按字面值复算一遍；`file-tree-flat.test.ts` 有一条**样式表同尺闸**盯着那三条声明，
 * 它们一改就先是测试红，而不是等到滚到底发现行错位。
 */
import { BINARY_EXT, erbExt, sortedDirsAndFiles, visibleEntries } from './file-tree-model';
import { pkey } from './file-tree-ops';
import { packageKey } from './file-tree-reveal';
import type { DirState, Group } from './file-tree-types';

/* ------------------------------ 与 CSS 同源的度量 ------------------------------ */

/** 行高（`--tree-row-h`，styles-project.css 树度量段：组/包/目录/文件/附加条目同取一档） */
export const TREE_ROW_H = 22;
/** 角色组内容列表的下边距（`.tree-files { margin: 0 0 var(--space-1) }`，space-1 = 4px） */
export const GAP_GROUP_UL = 4;
/** 包内容与目录递归列表的下边距（`.tree-files.nested { margin-bottom: var(--space-0) }`，space-0 = 2px） */
export const GAP_NESTED_UL = 2;

/* ------------------------------ 行的形状 ------------------------------ */

export type FlatRowKind = 'group' | 'package' | 'dir' | 'file' | 'extra' | 'note';

export interface FlatRow {
  /** 稳定行号 = DOM 上的 `data-tid`（文件/目录用路径本身；组头 `g:` / 包头 `p:` 前缀） */
  readonly id: string;
  readonly kind: FlatRowKind;
  /** `aria-level`（1 起） */
  readonly level: number;
  /** 这一行在滚动容器内容坐标里的顶部（px） */
  readonly top: number;
  /** 文件 / 目录的绝对路径；组头是角色目录前缀；包头是包目录；note 为空串 */
  readonly path: string;
  readonly label: string;
  /** 叶子行（可被虚拟化裁掉的行） */
  readonly leaf: boolean;
  /** 能进多选集合的行（只有文件行；口径与 `file-tree-multi-selection` 一致） */
  readonly selectable: boolean;
  /** 有子层可展开（组 / 包 / 目录） */
  readonly expandable: boolean;
  readonly open: boolean;
  /** 父 treeitem 的行下标（-1 = 顶层） */
  readonly parentIdx: number;
  /** 第一个子行的行下标（-1 = 没有子层或当前折叠） */
  readonly childIdx: number;
}

/** 一个叶子块：`[start,end)` 是一段连续的可裁叶子行（同一个包 / 同一段根散文件） */
export interface LeafBlock {
  readonly start: number;
  readonly end: number;
  /** 所属组在 `groups` 里的下标 */
  readonly groupIdx: number;
  /** 所属包在 `group.subs` 里的下标（根散文件同样有下标，靠 `scatter` 区分） */
  readonly subIdx: number;
  readonly scatter: boolean;
  readonly pkgKey: string;
}

/**
 * 一段"能整块裁掉"的行区间，外加它在滚动内容坐标里的**真实上下沿**（WS-12 欠账批）。
 *
 * 为什么行数不够、必须有像素沿：`[start,end)` 只说"这几行"，而一组的最后一行下面还压着
 * `ul.tree-files` 的下边距、一包下面还压着 `ul.tree-files.nested` 的下边距——那些缝是真高度，
 * 但**不属于任何一行**。整块裁掉时这些缝也得由同一条占位垫出来，否则一裁 `scrollHeight` 就缩，
 * 与 `file-tree-virtual.test.ts` 钉死的"裁行不许改变滚动高度"直接冲突。
 * `bottomPx` 取的是构建时那一刻的累计高度（`b.top`）⇒ 行 + 缝一次算清，渲染侧不再自己补。
 */
export interface RowSpan {
  readonly start: number;
  readonly end: number;
  readonly topPx: number;
  readonly bottomPx: number;
}

/** 组内的一段子区间：一个作者包（含包头行 + 真实文件夹层 + 平铺 ERB 层）或一段根散文件 */
export interface SubRange {
  readonly span: RowSpan;
  /** 包头的行下标；根散文件没有包头 ⇒ -1（渲染侧据此决定那一格挂按钮还是挂占位） */
  readonly headerIdx: number;
}

/** 一组的行范围（含组头）与它的叶子块清单 */
export interface GroupRange {
  readonly headerIdx: number;
  readonly key: string;
  readonly start: number;
  readonly end: number;
  readonly open: boolean;
  readonly blocks: readonly LeafBlock[];
  /** 整组（组头 + 各级子层 + 组列表下边距）的像素上下沿 ⇒ 视口在外时整组一行不挂 */
  readonly span: RowSpan;
  /** 与 `subs` 数组同下标的子区间清单（折叠组为空） */
  readonly subs: readonly SubRange[];
}

export interface FlatTree {
  readonly rows: readonly FlatRow[];
  readonly groups: readonly GroupRange[];
  /** 组下标 → 该组的叶子块（渲染侧按 `groupIdx`/`subIdx` 直接取，不必扫全表） */
  readonly blockOf: (groupIdx: number, subIdx: number) => LeafBlock | undefined;
  /** 内容总高（px）：滚动条比例与"到底了没有"都按它判 */
  readonly height: number;
}

/* ------------------------------ 行号口径（DOM ↔ 模型唯一的桥） ------------------------------ */

export function groupRowId(key: string): string {
  return `g:${key}`;
}
export function packageRowId(pkgKey: string): string {
  return `p:${pkgKey}`;
}
/** 叶子行的 id 就是路径本身（同一棵树里一个文件只出现一次：包根层的 ERB 由 `skip` 去过重） */
export function leafRowId(path: string): string {
  return path;
}
/** note 行（读取目录… / 空目录 / 新建输入行）的行号：目录 + 角色，不参与键盘导航 */
export function noteRowId(dir: string, which: 'loading' | 'empty' | 'create'): string {
  return `${dir}::${which}`;
}

/* ------------------------------ 构建器 ------------------------------ */

/** 目录递归要读的三件现场（与 `DirRows` 的 props 同族，两个视图共用一份） */
export interface DirCtx {
  readonly subOpen: ReadonlySet<string>;
  readonly dirCache: ReadonlyMap<string, DirState>;
  /** 正在新建条目的目录（那一层多插一行输入框；算进高度，不然滚动会跳） */
  readonly createInDir?: string | null;
}

interface Builder {
  readonly rows: FlatRow[];
  readonly groups: GroupRange[];
  readonly blocks: LeafBlock[];
  top: number;
}

function makeBuilder(): Builder {
  return { rows: [], groups: [], blocks: [], top: 0 };
}

/**
 * 追一行并返回它的下标。父子关系由调用侧显式给（`parentIdx`），
 * 父行的 `childIdx` 取**第一个**挂上来的子行 ⇒ 一次构建就把两头的指针都填好，
 * 不需要第二趟回填，也就不会出现"数组顺序与父子关系各说各话"。
 */
function pushRow(
  b: Builder,
  input: Omit<FlatRow, 'top' | 'parentIdx' | 'childIdx'>,
  parentIdx: number,
): number {
  const index = b.rows.length;
  b.rows.push({ ...input, top: b.top, parentIdx, childIdx: -1 });
  b.top += TREE_ROW_H;
  const parent = parentIdx >= 0 ? b.rows[parentIdx] : undefined;
  if (parent !== undefined && parent.childIdx < 0) b.rows[parentIdx] = { ...parent, childIdx: index };
  return index;
}

/** 一行目录（`DirRows` 画的那一层）折成扁平行；顺序与组件逐字相同：目录在前、文件在后 */
function pushDirRows(b: Builder, ctx: DirCtx, dir: string, depth: number, level: number, skip: ReadonlySet<string>, parentIdx: number): void {
  const state = ctx.dirCache.get(dir);
  if (state === undefined) return;
  if (state === 'loading' || state === 'error') {
    pushRow(
      b,
      { id: noteRowId(dir, 'loading'), kind: 'note', level, path: '', label: state === 'loading' ? '读取目录…' : '目录读取失败（需要桌面壳权限）', leaf: false, selectable: false, expandable: false, open: false },
      parentIdx,
    );
    return;
  }
  const sorted = sortedDirsAndFiles(state);
  const files = depth === 0 ? visibleEntries(sorted.files, 0, skip) : sorted.files;
  if (sorted.dirs.length === 0 && files.length === 0) {
    pushRow(
      b,
      { id: noteRowId(dir, 'empty'), kind: 'note', level, path: '', label: '（空目录）', leaf: false, selectable: false, expandable: false, open: false },
      parentIdx,
    );
    return;
  }
  if (ctx.createInDir !== undefined && ctx.createInDir !== null && pkey(ctx.createInDir) === pkey(dir)) {
    pushRow(
      b,
      { id: noteRowId(dir, 'create'), kind: 'note', level, path: '', label: '新建…', leaf: false, selectable: false, expandable: false, open: false },
      parentIdx,
    );
  }
  for (const d of sorted.dirs) {
    const open = ctx.subOpen.has(d.path);
    const index = pushRow(
      b,
      { id: d.path, kind: 'dir', level, path: d.path, label: d.name, leaf: false, selectable: false, expandable: true, open },
      parentIdx,
    );
    if (open) {
      // 递归层 `ul.tree-files.nested` 自带一档下边距；它子树的行排在边距之后
      b.top += GAP_NESTED_UL;
      pushDirRows(b, ctx, d.path, depth + 1, level + 1, skip, index);
    }
  }
  for (const f of files) {
    const binary = BINARY_EXT.test(f.name);
    pushRow(
      b,
      { id: leafRowId(f.path), kind: binary ? 'extra' : 'file', level, path: f.path, label: f.name, leaf: true, selectable: !binary && erbExt(f.name), expandable: false, open: false },
      parentIdx,
    );
  }
}

/** 一个叶子块（同一个包的 ERB 列表 / 一段根散文件）：返回块区间，空列表不落块 */
function pushLeafBlock(b: Builder, files: readonly string[], level: number, parentIdx: number, meta: Omit<LeafBlock, 'start' | 'end'>): void {
  if (files.length === 0) return;
  const start = b.rows.length;
  for (const f of files) {
    pushRow(
      b,
      { id: leafRowId(f), kind: 'file', level, path: f, label: f, leaf: true, selectable: true, expandable: false, open: false },
      parentIdx,
    );
  }
  b.blocks.push({ ...meta, start, end: b.rows.length });
}

/* ------------------------------ 构建：口上语义视图 ------------------------------ */

export interface KojoGroupInput {
  readonly group: Group;
  /** 组键（缺省 = 角色目录标签；WS-04 的 author/extra 根分组传它自己的 `root:` 键） */
  readonly key?: string;
  readonly open: boolean;
  /** 这一组里每个包是否已点开「真实文件夹内容」（过滤态恒 false，是既有口径） */
  readonly pkgFolderOpen: (pkgKey: string) => boolean;
  /** 这个包本次**会渲染**的文件行数上限（过滤窗口的预算；不传 = 全量） */
  readonly limitOf?: (subIdx: number) => number;
  /**
   * 展开状态下这一组里那条**说明行**的文案（读不到 / 还在读 / 还没有方言文件）。
   *
   * 说明行不是树项、也不能裁，但它是真真实实占着一行的高度——不把它算进 `top`，
   * 虚拟化窗口与滚动高度就会按整组差一档错位（WS-04 那两组根分组就有这种行）。
   */
  readonly note?: string;
}

export interface KojoModelInput extends DirCtx {
  readonly groups: readonly KojoGroupInput[];
  /** 包目录绝对路径的算法（与组件里那枚 `pkgDirOf` 同一个） */
  readonly pkgDirOf: (prefix: string, subLabel: string) => string;
}

/**
 * 口上语义视图的扁平行模型（纯函数）。
 *
 * 组的顺序、包的顺序、过滤窗口预算都由调用侧（组件）给进来——本函数不读 React、不发 IO，
 * 所以"组件画了什么"与"模型说应该画什么"能在单测里逐字比对（虚拟化判据与键盘判据都靠这条）。
 */
export function buildKojoFlatTree(input: KojoModelInput): FlatTree {
  const b = makeBuilder();
  const perGroupBlocks: LeafBlock[][] = [];
  input.groups.forEach((gi, groupIdx) => {
    const key = gi.key ?? gi.group.label;
    const groupTopPx = b.top;
    const headerIdx = pushRow(
      b,
      { id: groupRowId(key), kind: 'group', level: 1, path: gi.group.prefix, label: gi.group.label, leaf: false, selectable: false, expandable: true, open: gi.open },
      -1,
    );
    const blocks: LeafBlock[] = [];
    const blockBase = b.blocks.length;
    const subs: SubRange[] = [];
    perGroupBlocks.push(blocks);
    if (gi.open) {
      if (gi.note !== undefined && gi.note !== '') {
        pushRow(
          b,
          { id: `${key}::note`, kind: 'note', level: 2, path: '', label: gi.note, leaf: false, selectable: false, expandable: false, open: false },
          headerIdx,
        );
      }
      gi.group.subs.forEach((s, subIdx) => {
        const subTopPx = b.top;
        const subRowBase = b.rows.length;
        const limit = gi.limitOf === undefined ? s.files.length : Math.max(0, Math.min(s.files.length, gi.limitOf(subIdx)));
        const shown = limit >= s.files.length ? s.files : s.files.slice(0, limit);
        if (s.label === null) {
          // 根散文件：没有包层，直接挂在角色组的 `ul.tree-files` 里
          pushLeafBlock(b, shown, 2, headerIdx, { groupIdx, subIdx, scatter: true, pkgKey: '' });
          subs.push({ span: { start: subRowBase, end: b.rows.length, topPx: subTopPx, bottomPx: b.top }, headerIdx: -1 });
          return;
        }
        const pkgKey = packageKey(gi.group.label, s.label);
        const dir = input.pkgDirOf(gi.group.prefix, s.label);
        const folderOpen = gi.pkgFolderOpen(pkgKey);
        const pkgIdx = pushRow(
          b,
          { id: packageRowId(pkgKey), kind: 'package', level: 2, path: dir, label: s.label, leaf: false, selectable: false, expandable: true, open: folderOpen },
          headerIdx,
        );
        if (folderOpen) {
          // 追加式：真实文件夹内容在 ERB 列表**上方**（`.pkg-real` 的下边距被压成 0，不带缝）
          const skip = new Set(s.files.map(pkey));
          pushDirRows(b, input, dir, 0, 3, skip, pkgIdx);
        }
        pushLeafBlock(b, shown, 3, pkgIdx, { groupIdx, subIdx, scatter: false, pkgKey });
        b.top += GAP_NESTED_UL; // 包的 ERB 列表 `ul.tree-files.nested` 一档下边距
        subs.push({ span: { start: pkgIdx, end: b.rows.length, topPx: subTopPx, bottomPx: b.top }, headerIdx: pkgIdx });
      });
      b.blocks.slice(blockBase).forEach((blk) => blocks.push(blk));
      b.top += GAP_GROUP_UL; // 角色组内容列表 `ul.tree-files` 一档下边距
    }
    const span: RowSpan = { start: headerIdx, end: b.rows.length, topPx: groupTopPx, bottomPx: b.top };
    b.groups.push({ headerIdx, key, start: headerIdx, end: b.rows.length, open: gi.open, blocks, span, subs });
  });
  return finish(b);
}

/* ------------------------------ 构建：文件系统视图 ------------------------------ */

export interface FsRootInput {
  /** 组键（组头行的 `data-tid` 用它） */
  readonly key: string;
  readonly label: string;
  readonly dir: string;
  readonly open: boolean;
}

export interface FsModelInput extends DirCtx {
  readonly roots: readonly FsRootInput[];
  /** 单根形态（B5 原样）：根层直接铺开，没有组头行 */
  readonly multiRoot: boolean;
}

/**
 * 文件系统视图的扁平行模型。
 *
 * **本视图不参与行虚拟化**（叶子块照建，但渲染侧不裁剪它）：内容逐层惰性列举，规模由作者的展开
 * 动作本身约束，而 `DirRows` 的递归层没有可用的裁剪点。行模型照建 ⇒ 两个视图的键盘与读屏同一套判据。
 */
export function buildFsFlatTree(input: FsModelInput): FlatTree {
  const b = makeBuilder();
  const skip = EMPTY_SKIP_SET;
  for (const root of input.roots) {
    if (!input.multiRoot) {
      pushDirRows(b, input, root.dir, 0, 1, skip, -1);
      continue;
    }
    /**
     * 多根形态的根分组头**是一条目录行**（kind `dir`），不是角色组行：
     * 它的展开状态住在 `subOpen`（按绝对路径），与角色组的 `opened`（按标签）是两套现场。
     * 行种类决定 ← / → 落到哪个集合上，写错就会"按了展开、收的不是这一层"。
     */
    const rootTopPx = b.top;
    const headerIdx = pushRow(
      b,
      { id: root.dir, kind: 'dir', level: 1, path: root.dir, label: root.label, leaf: false, selectable: false, expandable: true, open: root.open },
      -1,
    );
    /**
     * `subs` 恒空：多根的组头**是一条目录行**，它的整棵子树都由 `DirRows` 递归画，
     * 而本视图不参与行虚拟化（渲染侧走 `fullRange`）⇒ 这里只把整根的上下沿记全，
     * 让两个视图的模型形状一致（`span` 有、`subs` 空），不给 fs 视图留一条"半个裁点"。
     */
    if (root.open) {
      const blockBase = b.blocks.length;
      pushDirRows(b, input, root.dir, 0, 2, skip, headerIdx);
      b.top += GAP_GROUP_UL;
      const blocks = b.blocks.slice(blockBase);
      b.groups.push({ headerIdx, key: root.key, start: headerIdx, end: b.rows.length, open: true, blocks, span: { start: headerIdx, end: b.rows.length, topPx: rootTopPx, bottomPx: b.top }, subs: [] });
      continue;
    }
    b.groups.push({ headerIdx, key: root.key, start: headerIdx, end: b.rows.length, open: false, blocks: [], span: { start: headerIdx, end: b.rows.length, topPx: rootTopPx, bottomPx: b.top }, subs: [] });
  }
  return finish(b);
}

const EMPTY_SKIP_SET: ReadonlySet<string> = new Set<string>();

function finish(b: Builder): FlatTree {
  const byGroup = new Map<number, Map<number, LeafBlock>>();
  for (const blk of b.blocks) {
    let sub = byGroup.get(blk.groupIdx);
    if (sub === undefined) {
      sub = new Map();
      byGroup.set(blk.groupIdx, sub);
    }
    sub.set(blk.subIdx, blk);
  }
  return {
    rows: b.rows,
    groups: b.groups,
    height: b.top,
    blockOf: (groupIdx, subIdx) => byGroup.get(groupIdx)?.get(subIdx),
  };
}

/* ------------------------------ 查询助手（键盘与渲染共用） ------------------------------ */

export function rowAt(tree: FlatTree, index: number): FlatRow | undefined {
  return tree.rows[index];
}

/** 行下标 → `data-tid`（越界 null） */
export function idAt(tree: FlatTree, index: number): string | null {
  return tree.rows[index]?.id ?? null;
}

/** `data-tid` → 行下标（线性扫；只在"焦点行换了"这类低频事件里用） */
export function indexOfId(tree: FlatTree, id: string): number {
  for (let i = 0; i < tree.rows.length; i++) if (tree.rows[i]?.id === id) return i;
  return -1;
}

/** 这一行是不是键盘能站上去的树项（note 行只是说明文字，不是项） */
export function isNavigable(row: FlatRow): boolean {
  return row.kind !== 'note';
}

/** 第一个可聚焦的行下标（没有 = -1） */
export function firstNavigable(tree: FlatTree): number {
  for (let i = 0; i < tree.rows.length; i++) if (isNavigable(tree.rows[i] as FlatRow)) return i;
  return -1;
}

/** 最后一个可聚焦的行下标（没有 = -1） */
export function lastNavigable(tree: FlatTree): number {
  for (let i = tree.rows.length - 1; i >= 0; i--) if (isNavigable(tree.rows[i] as FlatRow)) return i;
  return -1;
}

/** 连选区间 `[from,to]`（两端都含，顺序无关）里可选中的文件路径 */
export function rangePaths(tree: FlatTree, from: number, to: number): string[] {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(tree.rows.length - 1, Math.max(from, to));
  const out: string[] = [];
  for (let i = lo; i <= hi; i++) {
    const row = tree.rows[i];
    if (row !== undefined && row.selectable && row.path !== '') out.push(row.path);
  }
  return out;
}

/** 当前模型里所有可选中（= 文件）行的路径（Ctrl+A 的全集；虚拟化裁掉的行也在内——见组件注释） */
export function allSelectablePaths(tree: FlatTree): string[] {
  const out: string[] = [];
  for (const row of tree.rows) if (row.selectable && row.path !== '') out.push(row.path);
  return out;
}
