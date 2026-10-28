/**
 * 口上文件树组件本体（state + 异步 IO + 事件接线）。
 *
 * 拆分口径（FE-REF ⑤）：不属于 React 的东西一律搬出——`file-tree-types`（类型面）、
 * `file-tree-model`（分组/筛选纯模型）、`file-tree-filter-window`（过滤态预算）、
 * `file-tree-rows`（EditRow / FileRows）、`file-tree-dir-rows`（递归目录行）、
 * `file-tree-menu`（右键菜单 JSX）。本文件只剩：状态与它的两条异步通道（冷开快照 /
 * 目录列举 + 失效重列）、展开与编辑动作、定位 effect，以及把上面几块接起来的渲染。
 *
 * 诊断可见性（工包 E + 本批）：折到**角色组 / 作者包**两层的聚合留在 `file-tree-problem-view`
 * （`treeProblemMarks`），但**订阅下沉到节点**——组头 / 包头 / 单条文件行各自订阅
 * `problem-store`，宿主不再订阅诊断版本号。旧写法把 `probs` / `probMarks` 当引用型 props 穿
 * 进来，诊断版本一翻（切标签就会翻）整棵树被迫重画；现在版本翻新的代价只剩"每个徽标做一次
 * `Map.get` + 字符串比较"。画法与配色仍只有一枚（`TreeProbMark`），树里不存在第二份计数。
 */

import { Fragment, createElement, memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode, type UIEvent as ReactUIEvent } from 'react';
import { createPortal } from 'react-dom';
import type { DirEntry, GameProject, WalkOptions } from '@kojo/plugin-api';
import {errorText,  isErbDialectPath } from '@kojo/plugin-api';
import {
  collapseAll as collapseAllReveal,
  expandAll as expandAllReveal,
  packageKey,
  type RevealGroup,
  type RevealResult,
} from './file-tree-reveal';
import {
  COMMAND_PALETTE_COMMAND,
  compareSelectionPair,
  dirtyGateText,
  fsLocatePlanOfRoots,
  isUnderPath,
  joinPath,
  locatePlanOf,
  parentDir,
  pkey,
  relativeToRoot,
  validateEntryName,
  type LocatePlan,
  type MenuCapability,
  type MenuItemId,
} from './file-tree-ops';
import {
  CONFLICT_CHOICES,
  buildFileOpsPlan,
  conflictQuestion,
  type ConflictDecision,
  type FileOpEntry,
  type FileOpMode,
  type FileOpsPlan,
} from './file-ops-plan';
import { runFileOps } from './file-ops-exec';
import {
  TREE_DRAG_MIME,
  TREE_DROP_NO_CLASS,
  TREE_DROP_OK_CLASS,
  acceptsTreeDrop,
  decodeTreeDragPayload,
  encodeTreeDragPayload,
  planTreeDragSources,
  planTreeDropTarget,
  treeDropClasses,
  treeDropRejectSentence,
} from './file-tree-drag';
import { undoUnavailableText, type DeletePlan } from './file-delete-plan';
import {
  READONLY_BLOCK_REASON,
  clearDeleteBatchLedger,
  getLastDeleteBatch,
  runBatchDelete,
  undoDeleteBatch,
} from './file-delete-exec';
import {
  clearFileClipboard,
  fileClipSentence,
  getFileClipMode,
  getFileClipboard,
  hasFileClipboard,
  setExplorerOpsRuntime,
  setFileClipboard,
  type ClipEntry,
  type ExplorerOp,
} from './file-clipboard';
import { baseName, buildFileGroups, dirsToRelist, kojoOwners, middleEllipsis, rowKeyOf, TREE_LABEL_MAX } from './file-tree-model';
import { createEntryIfAbsent } from './file-tree-create';
import { browsableRootsOf, type WorkspaceFolder } from './workspace-folders';
import { filterRenderPlan, nextFilterWindow } from './file-tree-filter-window';
import {
  allSelectablePaths,
  buildFsFlatTree,
  buildKojoFlatTree,
  groupRowId,
  indexOfId,
  leafRowId,
  packageRowId,
  rangePaths,
  rowAt,
  TREE_ROW_H,
  type FlatRow,
  type FlatTree,
  type KojoGroupInput,
} from './file-tree-flat';
import {
  anchorScrollTop,
  cullSpacerPx,
  fullRange,
  isCulledSlice,
  scrollToShow,
  sliceBlock,
  sliceSpan,
  spacerStyle,
  visibleRange,
  type VisibleRange,
} from './file-tree-virtual';
import { clipTargetDirOf, planRowClick, planTreeKey, rowIsClipSource, rowIsDir, treeKeyEventOf } from './file-tree-keyboard';
import { planDirCacheEviction, protectedDirKeysOf } from './file-tree-cache';
import { EditRow, FileRows } from './file-tree-rows';
import { TreeProbMark } from './file-tree-row';
import { DirRows } from './file-tree-dir-rows';
import { useModalEscape } from './modal-stack';
import { getActivePath, setActivePath, subscribeActivePath } from './file-tree-selection';
import { clearSelected, getSelectedPaths, setSelected } from './file-tree-multi-selection';
import { useNodeProblems } from './file-tree-problem-view';
import { setFileTreeMenuRuntime, type FileTreeScope } from './file-tree-menu';
import { canRunContextMenuCommand, runContextMenuCommand } from './context-menu-model';
import { SHOW_FILE_HISTORY_COMMAND_ID } from './file-history';
import type { DirState, EditState, Group, PackageGroup, Props } from './file-tree-types';
import { Icon } from './icons';
import { overlaySkeletonRows } from './overlay-chrome';
// 跨面动效切片（1026 车道 A）：逐行进场的图样与两条压平口径。组件级引入 ⇒ 与
// `css-slices-wired` 那条"只认 import 语句"的判据同一口径（注释里提文件名不算接线）；
// 切片内每条规则都靠特异性取胜，不靠到达顺序。
import './motion-surface.css';

/** 纯函数与上限常量住模型层；此处再导出保持既有消费方（`tab-row` / 测试）的导入面不变 */
export { middleEllipsis, TREE_LABEL_MAX };

/**
 * PS-16 稳定化三件模块级常量：穿进行组件的引用型 props 必须同帧同引用，memo 才有得看。
 * - `IDENTITY_GLOSS`：`gloss` 缺省时的恒等映射（旧写法 `gloss ?? ((n) => n)` 每帧新函数，
 *   全树 DirRows 的 memo 全数失效）；
 * - `EMPTY_SKIP`：fs 视图根层的空 skip（旧写法内联 `new Set()` 每帧新集合）；
 * - `erbKeysCache`：包层 ERB 键集按包对象身份缓存（`sortedByEntries` 同款 WeakMap 先例，
 *   数组身份 = 内容身份，包退场随之回收）。
 */
const IDENTITY_GLOSS = (n: string): string => n;
const EMPTY_SKIP: ReadonlySet<string> = new Set();
/** 未传附加根时的恒等空数组（旧写法宿主每帧 `extraRoots ?? []` 造新数组 ⇒ 内部 memo 必失效） */
const EMPTY_EXTRA_ROOTS: readonly string[] = [];
/** 未传工作区根模型时的恒等空数组（同上：引用恒定，别在渲染期造新数组） */
const EMPTY_WORKSPACE_FOLDERS: readonly WorkspaceFolder[] = [];

/**
 * 附加根的可写态现判（WS-08；工作区模型缺席时的兜底）：走内核 `io.isWritable`
 * （与写闸同一把尺子）。没有 io（纯浏览器宿主）或判定抛错一律按**只读**——
 * "说不出可写"绝不能亮成可写。模型在场时以 `folder.writable` 为准（那是角色的判据，
 * 附加根本来就不进写允许域，两者结论一致）。
 */
function rootWritableOf(io: Props['io'], root: string): boolean {
  if (io === undefined) return false;
  try {
    return io.isWritable(root);
  } catch {
    return false;
  }
}
/**
 * 树冷开的骨架行数（VIS-34）：7 行落在"一眼看得出是一列，而不是一屏"的那档——
 * 少于 6 行读起来像装饰线，多于 8 行就开始替真实内容许愿。入场节拍只铺前 6 行
 * （`ui/motion-surface.css`），第 7 行与前一行同拍，不收尾拖沓。
 */
const TREE_COLD_SKELETON_ROWS = 7;
const erbKeysCache = new WeakMap<PackageGroup, ReadonlySet<string>>();

/** 目录缓存上界（超界先淘汰未展开的最旧条目；全在展开则原样保留——展开态是作者的现场） */
const DIR_CACHE_MAX = 400;

/**
 * 冷开快照：对口上根各做**一次** `walkDir`，拿全部方言文件路径。
 *
 * 过滤谓词与 erb-parser 的索引 walk **逐字同款**。口径（2026-10-16 桥分叉批改）：
 * `filter` 由**内核**兑现、**只筛输出条目、不剪枝**（谓词是闭包，跨进程桥收不到它，
 * 剪枝在构造上不可能）⇒ `e.isDirectory ||` 只是把目录侧交回默认口径（本调用 `includeDirs:false`，
 * 目录条目本就不出现），真正的文件侧筛在下面那行**再判一次**——读盘集合的规模不委托给桥。
 */
export async function walkDialectPaths(
  walkDir: (path: string, opts?: WalkOptions) => Promise<DirEntry[]>,
  roots: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    const entries = await walkDir(root, {
      includeFiles: true,
      includeDirs: false,
      filter: (e) => e.isDirectory || isErbDialectPath(e.name),
    });
    for (const e of entries) {
      if (!e.isDirectory && isErbDialectPath(e.name)) out.push(e.path);
    }
  }
  return out;
}

/**
 * CSS 属性选择器的字符串值转义（PS-6 定位那一条）。
 *
 * 只做两件事：`\` 翻倍、`"` 前置反斜杠——Windows 路径几乎必带前者，后者是属性值定界符。
 * 真撞上更冷的字符（换行之类）就点名失败，接着走归一比对那条兜底腿，不会漏定位。
 */
export function escapeAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// 中段省略（`middleEllipsis` / `TREE_LABEL_MAX`）已下沉到 `file-tree-model.ts`：
// 文件树的包/根/单条文件行与标签页共用同一把尺，定义点只留一处（口径与"为什么保后缀"
// 写在模型那一处，`file-tree.test.ts` 钉行为）。

/* ---------------- 诊断徽标（工包 E：树三层都开口，画法只有一枚） ---------------- */

/**
 * 折叠函数的公共出口留在文件树模块（既有消费方按这个名字与这个路径导入）；实现与
 * 节点级订阅同住 `file-tree-problem-view`，共用同一份缓存。
 */
export { treeProblemMarks } from './file-tree-problem-view';

/**
 * 组 / 包标题行末尾的两档徽标（**节点自己订阅诊断**，PERF 批）。
 *
 * 旧形态由宿主算好聚合表再当 prop 穿进来 ⇒ 宿主必须订阅诊断版本号，而 `problem-store`
 * 的版本号**每切一次标签就 +1**（活动文件的诊断重新登记）⇒ 一次切换就把整棵树（60 个组头
 * + 全部可见行）重画一遍。现在这一层自己订阅：快照是**字符串**，这一格的内容没变 ⇒
 * React 不为它排重渲染，宿主对诊断完全无感。
 *
 * 画法不在这里：`✕ n` / `⚠ n` 的字面、`SEVERITY_TINT` 那三个色、tooltip 与 aria 的措辞
 * 全住 `file-tree-row.tsx` 的 `TreeProbMark`（单条文件行用的就是同一枚）。宿主这一层只
 * 负责把聚合结果换成它的入参——配色与句式一旦在两个模块各写一遍，就迟早长成
 * "同一档两种红"或"同一个数两种说法"。
 */
const NodeProblemBadge = memo(function NodeProblemBadge({
  groups,
  kind,
  nodeKey,
  scope,
}: {
  readonly groups: readonly Group[];
  readonly kind: 'group' | 'package';
  readonly nodeKey: string;
  readonly scope: string;
}): ReactElement | null {
  const mark = useNodeProblems(groups, kind, nodeKey);
  if (mark === undefined) return null;
  return (
    <TreeProbMark
      scope={scope}
      error={mark.error}
      warning={mark.warning}
      files={mark.files}
      more={mark.more}
    />
  );
});

/**
 * 口上文件树：角色 → 作者包 → 口上文件（默认平铺共存，c087db9 形态）。
 *
 * 作者包**单态 + 追加式展开**（2026-10-12 用户反馈 6/7 重做）：
 * - **默认**：包标题行之下列出该包的口上 ERB 文件（借阅找思路，一眼全览）；
 * - **点击包标题行**：在 ERB 列表**上方追加**该包的**真实文件夹内容**——子目录（可继续
 *   递归展开）、README·ライセンス 等附加文件。ERB 列表**原地不动、不消失、无过渡动画**；
 * - 附件按惰性 `listDir` 逐层取（展开哪层取哪层），失败自解释回落。
 *
 * **为什么不再用「平铺态 ↔ 文件夹态」二选一**：旧实现把 ERB 列表用高度过渡压成 0 高、
 * 另挂一棵 `.pkg-folder` 子树替代——两棵 `<ul>` 里 `key={f}` 重复，React 整体卸载重挂，
 * 叠加高度/透明度/入场三处动画，来回点击即整棵树抖动（用户反馈 7 的 bug 根因）。
 * 追加式没有那个问题：同一批 DOM 节点、同一套 key、零动画。
 *
 * 展开状态由组件内 state 持有——宿主（ProjectView）以稳定组件身份注入，
 * 打开文件不会因重渲染而丢掉展开状态。
 *
 * **目录缓存有一条外部失效通道**（HK-5，2026-10-13）：宿主在口上域发生外部改动时
 * 递增 `refreshNonce`，树重列**正在显示**的那些目录，展开态一律不动、旧列表原地留着
 * （不闪空白）。此前 `dirCache` 没有任何失效通道 ⇒ 外面丢进一个文件，树里不出现，
 * 除非重开项目——实机线在 §5.87 里把这条明记为"留给能做 GUI 的那一批"。
 */
/** 内部本体的 props：**没有** `activeFile`（选中态走模块级订阅，见 `file-tree-selection`） */
export type FileTreeBodyProps = Omit<Props, 'activeFile'>;

/**
 * 文件树对外组件 = **同步选中态的外壳** + 本体（`FileTreeBody`，memo）。
 *
 * 为什么要分成两层（PERF 批实测的病灶）：`activeFile` 是宿主的 prop，换了它，本组件
 * 必然重画；旧实现里本体与外壳是同一个函数 ⇒ 换一次活动文件就把整棵树的 JSX 重新
 * 造一遍（60 个角色组头 + 全部可见文件行），真壳实测「最长帧 70–93ms / (render) 桶
 * 100 ms 级」，而其中真正该变的东西只有两行。
 *
 * 现在外壳只做一件事：把 `activeFile` 灌进模块级 store（`setActivePath`，同值幂等），
 * 然后渲染 memo 化的本体。本体对选中态一无所知 ⇒ 换活动文件时它的 props 逐个相等、
 * 整棵树的 JSX 一个都不重建，只有订阅了 store 的那两行翻转自己的布尔快照。
 *
 * 为什么写在 `useLayoutEffect` 而**不是**渲染期：渲染期写外部 store 会去通知
 * 已在渲染的另一批组件（React 会报 "Cannot update a component while rendering"），
 * 这条路径必须保持纯。layout effect 在提交阶段、绘制之前跑，行订阅收到的更新是同步
 * 提交的 ⇒ 上屏仍是新选中态；挂载那一拍本体先按上一帧的值渲染一次（通常就是 null），
 * 随后由行订阅的挂载自检补齐——与骨架无关，且不会漏掉任何一次选中切换。
 */
export function FileTree(props: Props): ReactElement {
  const { activeFile, ...rest } = props;
  useLayoutEffect(() => setActivePath(activeFile), [activeFile]);
  /**
   * 回调型 props 走一层恒等转发（PERF 批）。
   *
   * 宿主那侧（`ProjectView` 的 `fileTreeArgsRef` 桥）每帧都把 `onAddExtraRoot` 之类重新
   * 塞一次，其中若干个是**没有 useCallback 的闭包** ⇒ 引用每帧都换 ⇒ 本体 memo 被击穿，
   * 切一次标签整棵树重画一遍。树对这些回调只有"调用"一种用法（从不拿身份做渲染判据，
   * 唯一的例外是"有没有这个能力"—— 菜单项整项显示/不显示），所以用固定转发函数接住、
   * 调用时打到最新那一份：行为等价，引用恒定。
   *
   * 存在性跟着 prop 走：宿主没给能力 ⇒ 转发函数也**是 undefined** ⇒ 菜单口径逐字不变。
   */
  const onOpenFile = useLatestCallback(rest.onOpenFile)!;
  const listDir = useLatestCallback(rest.listDir);
  const walkDir = useLatestCallback(rest.walkDir);
  const onImportPackage = useLatestCallback(rest.onImportPackage);
  const onRevealInExplorer = useLatestCallback(rest.onRevealInExplorer);
  const guardFileOp = useLatestCallback(rest.guardFileOp);
  const dirtyOf = useLatestCallback(rest.dirtyOf);
  const onSearchInFolder = useLatestCallback(rest.onSearchInFolder);
  const onFilesGone = useLatestCallback(rest.onFilesGone);
  const onAddFolder = useLatestCallback(rest.onAddFolder);
  const onRemoveExtraRoot = useLatestCallback(rest.onRemoveExtraRoot);
  const onCompareFiles = useLatestCallback(rest.onCompareFiles);
  const onDiskEntriesChanged = useLatestCallback(rest.onDiskEntriesChanged);
  return (
    <FileTreeBody
      {...rest}
      onOpenFile={onOpenFile}
      listDir={listDir}
      walkDir={walkDir}
      onImportPackage={onImportPackage}
      onRevealInExplorer={onRevealInExplorer}
      guardFileOp={guardFileOp}
      dirtyOf={dirtyOf}
      onSearchInFolder={onSearchInFolder}
      onFilesGone={onFilesGone}
      onAddFolder={onAddFolder}
      onRemoveExtraRoot={onRemoveExtraRoot}
      onCompareFiles={onCompareFiles}
      onDiskEntriesChanged={onDiskEntriesChanged}
      extraRoots={rest.extraRoots && rest.extraRoots.length > 0 ? rest.extraRoots : EMPTY_EXTRA_ROOTS}
    />
  );
}

/** 见 `FileTree` 里那段注释：恒等稳定的"转发到最新一份"回调；缺省保持缺省 */
function useLatestCallback<T extends (...args: never[]) => unknown>(fn: T | undefined): T | undefined {
  const latest = useRef(fn);
  latest.current = fn;
  const present = fn !== undefined;
  return useMemo(
    () => (present ? (((...args: never[]) => (latest.current as T)(...args)) as T) : undefined),
    [present],
  );
}

/**
 * 组展开折叠的挂载壳（1026 车道 A · VIS-31）。
 *
 * 只做一件事：决定 `ul.tree-files` **在不在 DOM 里**，让 `file-tree.css` 那条
 * `grid-template-rows: 0fr ⇄ 1fr` 的两个方向都播得完。
 *
 * - **展开侧不走 effect**：0fr→1fr 的过渡要靠同一帧里就有真实内容高度差；`useEffect`
 *   要到绘制之后才跑 ⇒ 会先空跑一帧光板。这里用 React 官方的"渲染期按 props 变化调状态"
 *   （与上面 `useLatestCallback` 同一类渲染期写法），同帧就把 `ul` 挂上。
 * - **收起侧延迟卸载**：`lingering` 把 `ul` 再多留 `FOLD_EXIT_MS`，退场播完才真卸载 ⇒
 *   静息的折叠组零 DOM、零行渲染成本（不会为了动画把整棵子树常驻）。
 * - `body` 是**惰性**的（函数，不是 children）：折叠态下那一大段 `g.subs.map(...)`
 *   压根不该构造 React 元素——改成 children 就是把「折叠组也每帧造一遍元素」的
 *   成本塞回 PS-16 那条渲染纪律里。
 * - 不用 `ui/overlay-chrome` 的 `useOverlayPresence`：那是浮层的在场钩子（同一份时机
 *   服务的是"宿主什么时候把浮层节点摘掉"），展开折叠要的是上面那条同帧挂载，形态不同。
 * - 定位（`scrollLocate`）在退场这 200ms 里可能点名到一条已被裁到零高的行：它的矩形落在
 *   容器内 ⇒ `scrollLocateIntoRow` 的"已可见"判据直接返回，不滚动、不报错——与改前
 *   （那行压根不在 DOM 里，两条腿都点不到）终态一致，无需额外排除。
 */
const FOLD_EXIT_MS = 200; // 与 --dur-2（200ms）同档；CSS 改过渡时长这里同步

function TreeFoldBody({ open, body }: { open: boolean; body: () => ReactNode }): ReactElement | null {
  const [prevOpen, setPrevOpen] = useState(open);
  const [lingering, setLingering] = useState(false);
  if (prevOpen !== open) {
    setPrevOpen(open);
    setLingering(!open);
  }
  useEffect(() => {
    if (open || !lingering) return;
    const timer = setTimeout(() => setLingering(false), FOLD_EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, lingering]);
  if (!open && !lingering) return null;
  return <>{body()}</>;
}

/**
 * 虚拟化垫高行（WS-12 · 欠账批扩到三层）：把裁掉的行换成一条等高的占位。
 *
 * 为什么必须有它：裁行不改滚动高度是**虚拟化能用起来的前提**——没有垫高，滚动条长度跟着
 * 挂载行数走，作者一滚就"越滚越短"，视口与行号的对应关系也一并作废。高度取自行模型
 * （`file-tree-virtual.sliceBlock` 算出的像素，含各级 `<ul>` 的边距口径），不是猜的。
 *
 * 三个使用位置（同一个形状，不另造第二枚组件）：
 * - 叶子行裁口的头尾（组 ul / 包 ul 里，垫的是被裁的那几行）；
 * - **整组**在视口之外（`tree-groups` 的直接子，替掉整个 `li.tree-group`）；
 * - **整包**在视口之外（组 ul 的直接子，替掉整个 `li.tree-package-node`）。
 * 后两档的高度来自 `sliceSpan` 的含缝口径（那两级 `<ul>` 连同它们的下边距一起没了），
 * 前一档来自 `sliceBlock` 的行底口径（缝仍由常驻的 `<ul>` 带）——两边混用就会多垫或少垫一档缝。
 *
 * `aria-hidden` + `role="presentation"`：占位不是树项，读屏与键盘都不该撞上它。
 * 内联 `style.height` 而不是 CSS 类：本切片那条"不许写带长度的 height"红线管的是
 * 样式表里的**固定**高度（密度口径），动态垫高本来就没有固定值可写。
 *
 * `tag`（欠账批新增）：占位替的是**列表项**就用 `li`（默认——树根 ul 与组 / 包的 ul 里），
 * 替的是**一行行元素自己**（组头按钮、包头按钮、根分组那条头行容器）就用 `div`——
 * 那一格住在 `li.tree-group` / `li.tree-package-node` 里面，再挂一枚 `<li>` 就是
 * "`<li>` 嵌在 `<li>` 里"的非法 HTML（React 会直接报 hydration 错，浏览器解析也会把树拆歪）。
 */
function TreeSpacer({ px, tag = 'li' }: { px: number; tag?: 'li' | 'div' }): ReactElement | null {
  const style = spacerStyle(px);
  if (style === null) return null;
  return createElement(tag, { className: 'tree-vspacer', role: 'presentation', 'aria-hidden': true, style });
}

/* ---------------- WS-13 搬运家族的现场问句（冲突四选项 / 脏闸） ---------------- */

/**
 * 一次待答的问句（**同一时刻只挂一枚**——搬运是串行的：上一问没答完，后到的动作被挡并说人话）。
 *
 * 形态照 `UnsavedConfirmDialog` / `WritableApprovalDialog` 那三家模态的房规：
 * `.modal[aria-label]` + `useModalEscape`，且 Esc 恒落"一个字节都不动"那一格（冲突问 = 全部取消、
 * 脏闸问 = 不搬）。**挂在 body 上**而不是就地渲染：树滚动容器带 `contain: layout paint`
 * （styles-project.css 长列表隔离带），fixed 遮罩在它里面会被钉成面板大小——与右键菜单
 * 走根宿主同一个理由。上屏回执不建第二套 toast：一句话状态行走既有的 `revealNote`。
 */
interface FileOpsAsk {
  readonly label: string;
  readonly text: string;
  readonly choices: ReadonlyArray<{ readonly value: string; readonly label: string; readonly primary?: boolean }>;
  readonly escapeValue: string;
  readonly pick: (value: string) => void;
}

function FileOpsAskDialog({ ask }: { ask: FileOpsAsk }): ReactElement {
  useModalEscape(() => ask.pick(ask.escapeValue));
  return createPortal(
    <div className="modal-mask">
      <div className="modal" role="dialog" aria-modal="true" aria-label={ask.label}>
        <h2>{ask.label}</h2>
        {/* dirtyGateText / conflictQuestion 都带换行与逐条点名，pre-line 让换行照上屏 */}
        <p style={{ whiteSpace: 'pre-line' }}>{ask.text}</p>
        <div className="modal-actions">
          {ask.choices.map((c) => (
            <button key={c.value} className={c.primary === true ? 'primary' : 'ghost'} onClick={() => ask.pick(c.value)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 文件树本体（state + 异步 IO + 事件接线 + 渲染）。
 *
 * 与外壳同一份实现，只差一件事：**不再收 `activeFile`**（见 `FileTree` 的注释）。
 */
const FileTreeBody = memo(function FileTreeBody({ project, index, onOpenFile, listDir, walkDir, onImportPackage, io, onRevealInExplorer, guardFileOp, dirtyOf, onSearchInFolder, onFilesGone, refreshNonce, gloss, extraRoots, onAddFolder, onRemoveExtraRoot, onCompareFiles, workspaceFolders, onDiskEntriesChanged }: FileTreeBodyProps): ReactElement {
  /** 名称显示对照（缺省 = 恒等，保持旧行为；IDENTITY_GLOSS 模块级 ⇒ 引用恒定） */
  const glossOf = gloss ?? IDENTITY_GLOSS;
  const [filter, setFilter] = useState('');
  /**
   * 视图切换（B5）：口上树（角色 → 作者包 → 口上文件的语义分组）⇄ 整个游戏目录（文件系统视图）。
   *
   * - 浏览现场，**不持久化**：切走再切回，语义视图的展开态（opened / pkgFolder / subOpen）原样保留；
   * - 文件系统视图**复用**同一套 DirRows / subOpen / dirCache——dirCache 按绝对路径键控，
   *   两视图天然共享同一份目录缓存（包的真实文件夹视图与这里就是同一批目录）；
   * - 收起文件系统视图时其在 subOpen 里的展开态**保留**：现场即现场，切回来还开着。
   */
  const [view, setView] = useState<'kojo' | 'fs'>('kojo');
  /** 过滤走 deferred：输入框每击键即时响应，全量过滤 + 重渲染只对落定值跑 */
  const deferredFilter = useDeferredValue(filter);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  /** 展开了「真实文件夹内容」的作者包（默认关——只露 ERB 列表） */
  const [pkgFolder, setPkgFolder] = useState<Set<string>>(new Set());
  /** 递归展开的子目录（按绝对路径） */
  const [subOpen, setSubOpen] = useState<Set<string>>(new Set());
  /** 目录列举缓存（**按绝对路径**键控——子目录也要能展开） */
  const [dirCache, setDirCache] = useState<Map<string, DirState>>(new Map());
  /** 批量展开/收起后的一句可读数（反馈 6：没有反馈的批量动作＝用户读成"点了没反应"） */
  const [revealNote, setRevealNote] = useState<string | null>(null);
  /** 行内编辑（新建 / 重命名；B1/B2） */
  const [edit, setEdit] = useState<EditState | null>(null);
  const [editValue, setEditValue] = useState('');
  /**
   * B4 定位请求（选中文件变化时的自动定位；落地后自己清空）。
   *
   * **ref 而不是 state**（PERF 批）：定位是"一次事件 + 一次 DOM 动作"，不是渲染输入。
   * 旧写法把它放 state（`locateReq`）⇒ 每次切标签多一次 setState → 整树重画 → 再跑一个
   * effect，一次切换里出现两批 DOM 变动。
   */
  const locateTarget = useRef<string | null>(null);
  /** 树滚动容器（定位时在其内找 data-locate 行；scrollIntoView 用 nearest 不拽容器） */
  const treeBodyRef = useRef<HTMLUListElement | null>(null);

  /* ---------------- WS-11 键盘与可访问性 / WS-12 行虚拟化的现场 ---------------- */

  /**
   * 滚动现场（虚拟化窗口的输入）。
   *
   * 只记 `top`（scrollTop）与 `h`（clientHeight）两枚数：行模型给每一行算了 `top`，
   * 窗口 = 二分这两个数得到的行区间 ⇒ 挂载行数只跟视口有关，跟树的长度无关。
   */
  const [scroll, setScroll] = useState<{ top: number; h: number }>({ top: 0, h: 0 });
  /**
   * 焦点行的行号（= DOM 上的 `data-tid`，判据与口径住 `file-tree-flat`）。
   *
   * 存 **tid 而不是下标**：展开 / 收起会让下标整体平移，而 tid 认的是那一行本身
   * ——锚点保持与"焦点行滚出窗口后重新挂上"都靠它。
   */
  const [focusTid, setFocusTid] = useState<string | null>(null);
  /** 连选锚点（Shift+↑↓ / Shift+点击 的另一端；非连选动作会把它挪到当前行） */
  const anchorIdx = useRef(-1);
  /**
   * "下一次提交该把 DOM 焦点交给哪一行"（行号 = `data-tid`）。
   *
   * 为什么需要这一格：虚拟化下焦点行可能还没挂出来（滚动与挂载差一帧），
   * 当场 `focus()` 会点到 null 上 ⇒ 表现为"按了 End，焦点凭空没了"。
   * 交给每次提交后的那趟 roving 扫描统一办结（见下面那个 layout effect）。
   */
  const pendingFocus = useRef<string | null>(null);
  /** 展开/收起前的锚点现场（视口不跳那条判据的"改前"半边） */
  const anchorRow = useRef<{ tid: string; top: number; scroll: number } | null>(null);
  /**
   * 锚点采集的 ref 版实现。
   *
   * 实现在下面 WS-12 那一块（它要读行模型与焦点行），这里先立一个恒等函数占位：
   * `toggleSub` 这类早期 `useCallback` 要引用它，而"什么时候真的采锚点"由 ref 里的最新一份决定
   * ——与 `runLocateRef` 同一条写法（闭包每帧刷新，避免读到上一帧的现场）。
   */
  const captureAnchorRef = useRef<() => void>(() => {});
  /** 淘汰保护集每帧刷在这里（`applyDirUpdates` 读 ref ⇒ 不会因为现场变化换身份、击穿行组件 memo） */
  const protectDirs = useRef<Set<string>>(new Set());

  /* ---------------- 即时化：索引未就绪时用 walk 快照先出树（2026-10-16 树即时批） ---------------- */

  /**
   * 冷开快照（`{ proj, paths }` 带项目身份——切项目后旧快照立即视为不存在，
   * 绝不让上一个项目的文件在渲染窗口里闪现）。索引就绪后被索引路径取代。
   */
  const [walkSnap, setWalkSnap] = useState<{ proj: GameProject; paths: string[] } | null>(null);
  const [walkFailed, setWalkFailed] = useState(false);
  /** 快照请求序号：项目切换/连续刷新时只认最后一次（与 dirReq 同一套"迟到不认领"口径） */
  const walkSeq = useRef(0);
  useEffect(() => {
    if (index || !walkDir) return; // 索引就绪 ⇒ 快照退役；无 walkDir（纯浏览器宿主）⇒ 旧行为
    const seq = ++walkSeq.current;
    setWalkFailed(false);
    void walkDialectPaths(walkDir, project.kojoPaths)
      .then((paths) => {
        if (walkSeq.current !== seq) return;
        setWalkSnap({ proj: project, paths });
      })
      .catch(() => {
        if (walkSeq.current !== seq) return;
        setWalkFailed(true); // 失败不空转：退回「索引中…」占位（索引失败另有状态栏自解释）
      });
  }, [project, index, walkDir, refreshNonce]);

  /** 当前有效的快照路径（项目身份匹配才认） */
  const snapPaths = walkSnap && walkSnap.proj === project ? walkSnap.paths : null;

  /**
   * 工作区根模型（WS-04）：`author` / `extra` 根各有**独立顶层分组**。
   *
   * 为什么必须先有这份：作者工作区里的文件「搜索 / 监视都认，树里没有」——那是五套根集合
   * 各拼各的直接后果。模型把根与角色/可写性一次说清，这里只负责画。
   */
  const folders = workspaceFolders ?? EMPTY_WORKSPACE_FOLDERS;
  /**
   * 需要**独立顶层分组**的根（作者作品目录 + 会话附加根）。
   * 游戏根 / 口上域 / 存档不在此列：它们的内容由角色分组（口上域）与文件系统视图（游戏根）覆盖，
   * 再列一遍就是把同一批游戏文件画成两遍。
   */
  const rootFolders = useMemo(() => folders.filter((f) => f.role !== 'game'), [folders]);

  /**
   * 分组来源优先级：索引（权威）→ 冷开快照（索引未就绪的先手）。
   * 两者共用 `buildFileGroups` 同一构建函数 + 同一 owners 表 ⇒ 同一文件集下结构逐字相同，
   * 索引就绪切换时不重排。
   *
   * WS-04：**归到 author / extra 根名下的路径在这里先剔掉**——它们在顶层那几组里各出现一次；
   * 不剔就是同一批文件两处可见（"不要把游戏内文件重复列一遍"的同一条纪律）。
   * 剔除按**根的路径前缀**做（同步、零 IO）：不依赖那几组的内容是否已经走完。
   */
  const groups = useMemo<Group[]>(() => {
    const paths = index ? [...index.files.keys()] : snapPaths;
    if (!paths) return [];
    const claimed = rootFolders.map((f) => f.path);
    const kept = claimed.length === 0 ? paths : paths.filter((p) => !claimed.some((root) => isUnderPath(root, p)));
    return buildFileGroups(kept, kojoOwners(project));
  }, [index, snapPaths, project, rootFolders]);

  /**
   * 诊断：**宿主不订阅**（PERF 批）。
   *
   * 旧写法在这里 `useSyncExternalStore(problem-store)` 拿版本号、再把汇总表当引用型 props
   * 穿下去；而版本号**每切一次标签就 +1**（活动文件的诊断重新登记）⇒ 一次切换把整棵树重画。
   * 现在组头 / 包头 / 单条文件行各自订阅（`file-tree-problem-view`），版本翻新只让"内容真的
   * 变了"的那几个节点重渲染，宿主这一帧与诊断无关。
   *
   * 口径诚实：注册表里只有**已打开文件**的诊断（未打开文件的项目级诊断没有上账的腿），
   * 所以徽标说的是"这一层/这一行里已打开的文件有诊断"，tooltip 里那句范围标签与状态栏那颗
   * 取自同一个 `PROBLEM_SCOPE`（句式住在 `TreeProbMark`）。
   */

  const visible = useMemo(() => {
    if (!deferredFilter) return groups;
    const q = deferredFilter.toLowerCase();
    return groups
      .map((g) => {
        const subs = g.subs
          .map((s) => ({
            ...s,
            files: s.files.filter(
              (f) => f.toLowerCase().includes(q) || (s.label?.toLowerCase().includes(q) ?? false),
            ),
          }))
          .filter((s) => s.files.length > 0);
        return { ...g, subs, total: subs.reduce((n, s) => n + s.files.length, 0) };
      })
      .filter((g) => g.subs.length > 0 || g.label.toLowerCase().includes(q));
  }, [groups, deferredFilter]);

  /* ---------------- author / extra 根的独立顶层分组（WS-04） ---------------- */

  /** 根清单的身份串（换根 / 增删根 ⇒ 重新走一遍列举）；`refreshNonce` 之外再吃它 */
  const rootWalkKey = rootFolders.map((f) => pkey(f.path)).join('\n');
  /** 逐根列举结果（`'error'` = 这个文件夹读不到；缺席 = 还没列） */
  const [rootWalk, setRootWalk] = useState<{
    key: string;
    states: ReadonlyMap<string, readonly string[] | 'error'>;
  }>({ key: '', states: new Map() });
  const rootFoldersRef = useRef(rootFolders);
  rootFoldersRef.current = rootFolders;
  useEffect(() => {
    if (!walkDir || rootFolders.length === 0) return;
    const picked = rootFoldersRef.current;
    const key = picked.map((f) => pkey(f.path)).join('\n');
    const states = new Map<string, readonly string[] | 'error'>();
    let alive = true;
    void Promise.all(
      picked.map(async (folder) => {
        try {
          states.set(pkey(folder.path), await walkDialectPaths(walkDir, [folder.path]));
        } catch {
          states.set(pkey(folder.path), 'error');
        }
      }),
    ).then(() => {
      if (alive) setRootWalk({ key, states });
    });
    return () => {
      alive = false;
    };
    // 依赖刻意只到 key / refreshNonce：`rootFolders` 每帧是新数组，进依赖就是每帧重走一遍列举
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walkDir, rootWalkKey, refreshNonce]);

  /**
   * 每个 author / extra 根的文件集 = 索引里落在该根下的条目 ∪ 该根的列举结果。
   *
   * 两路并起来而不是二选一：作者作品目录本来就在索引扫描面里（索引更权威、含未打开文件），
   * 而会话附加根**不在**索引面里（只能靠列举）。更具体的根（落在本根之内的另一个分组根）
   * 自己列，这里剔掉——否则同一个文件在两组的顶层各出现一次。
   */
  const rootGroups = useMemo(() => {
    const walked = rootWalk.key === rootWalkKey ? rootWalk.states : null;
    const indexed = index ? [...index.files.keys()] : snapPaths ?? [];
    return rootFolders.map((folder) => {
      const collected = new Map<string, string>();
      for (const path of indexed) if (isUnderPath(folder.path, path)) collected.set(pkey(path), path);
      const state = walked?.get(pkey(folder.path));
      if (Array.isArray(state)) for (const path of state) if (!collected.has(pkey(path))) collected.set(pkey(path), path);
      const nested = rootFolders.filter(
        (other) => pkey(other.path) !== pkey(folder.path) && isUnderPath(folder.path, other.path),
      );
      const files = [...collected.values()]
        .filter((path) => !nested.some((other) => isUnderPath(other.path, path)))
        .sort();
      const status: 'ready' | 'loading' | 'error' =
        Array.isArray(state) || files.length > 0 ? 'ready' : state === 'error' ? 'error' : 'loading';
      return { folder, key: `root:${pkey(folder.path)}`, files, status };
    });
  }, [rootFolders, rootWalk, rootWalkKey, index, snapPaths]);

  /** 过滤态：命中词落到文件路径上；整组没命中也留着（组头自带计数=0 是诚实反馈） */
  const rootGroupsVisible = useMemo(() => {
    const q = deferredFilter.toLowerCase();
    if (!q) return rootGroups.map((g) => ({ ...g, hits: g.files }));
    return rootGroups
      .map((g) => ({ ...g, hits: g.files.filter((f) => f.toLowerCase().includes(q)) }))
      .filter((g) => g.hits.length > 0 || g.folder.label.toLowerCase().includes(q));
  }, [rootGroups, deferredFilter]);

  /**
   * 过滤态渲染窗口（PERF-6）：窗口挂在**它所属的过滤词**上 ⇒ 换词自动回落到首帧上界，
   * 不需要 useEffect（少一次重渲染，也不会有"旧窗口套到新词上"的中间帧）。
   */
  const [filterWin, setFilterWin] = useState<{ q: string; win: number | undefined }>({
    q: '',
    win: undefined,
  });
  const winOf = deferredFilter === filterWin.q ? filterWin.win : undefined;
  /** 渲染计划（仅过滤态；非过滤态组默认折叠，行数已被展开态本身约束） */
  const plan = useMemo(
    () => (deferredFilter ? filterRenderPlan(visible, winOf) : null),
    [visible, deferredFilter, winOf],
  );
  const growFilterWindow = (): void => {
    setFilterWin({ q: deferredFilter, win: nextFilterWindow(winOf, plan?.matched ?? 0) });
  };

  const toggleIn = (set: Set<string>) => (key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  const toggleGroup = (label: string): void => setOpened((prev) => toggleIn(prev)(label));

  /** 包目录绝对路径（index 路径为全路径，直接拼接包目录名）；两形共一条算式，不抄第二遍 */
  const pkgDirOfPrefix = (prefix: string, subLabel: string): string =>
    `${prefix.replace(/[\\/]+$/, '')}/${subLabel}`;
  const pkgDirOf = (g: Group, subLabel: string): string => pkgDirOfPrefix(g.prefix, subLabel);

  /**
   * 每个目录"最新一次列举请求"的序号。响应回来时只认自己那一次：
   * 外部改动会紧接着再发一次列举，若旧请求后到，屏幕上就会**倒灌回改动前那份目录**
   * ——而且没有下一次失效来纠正它（作者看到的就是"文件没出现"这个老 bug 的又一形态）。
   */
  const dirReq = useRef<Map<string, number>>(new Map());

  /** 一次列举落地：若干目录并成**一次** state 更新（PS-6 第 4 项）。
   *
   * 旧形态 `relistShown` 对每个正在显示的目录各发一次 `listDir`，每份响应各自
   * `setDirCache` ⇒ K 个目录 = K 帧全树重渲染，而它们本来属于**同一次失效**。
   *
   * 顺带管住缓存体量：`dirCache` 以前只在删除/改名时剪枝，展开过又收起的目录永远留着
   * （条目数组是实打实的内存）。超出上界时先淘汰"当前没展开"的最旧条目；
   * 全都在展开着就原样留着——**展开态是作者的现场，缓存不许把它挤成空白**。
   */
  const applyDirUpdates = useCallback((updates: ReadonlyMap<string, DirState>): void => {
    setDirCache((prev) => {
      const next = new Map(prev);
      for (const [key, state] of updates) next.set(key, state);
      if (next.size <= DIR_CACHE_MAX) return next;
      // 淘汰顺序由 `file-tree-cache` 那条纯判据给（插入序 = 首次列举先后 ⇒ 先丢最早那份没在用的）
      for (const key of planDirCacheEviction([...next.keys()], next.size, DIR_CACHE_MAX, protectDirs.current)) {
        next.delete(key);
      }
      return next;
    });
  }, []);

  /**
   * 一批目录一起列、**一次落地**（PS-6）：外部改动重列走的就是这条。
   *
   * 序号闸照旧逐目录认领先后（迟到的那份不认领）；某一份失败只把**那一个目录**标成
   * error，其余照收——一颗失败不许把整批拖成空白（也不静默：DirRows 会画失败行）。
   */
  const fetchDirs = useCallback((dirs: readonly string[], onSettled?: (failed: number, listed: number) => void): void => {
    if (!listDir || dirs.length === 0) {
      onSettled?.(0, 0);
      return;
    }
    const seqs = new Map<string, number>();
    const loading = new Map<string, DirState>();
    for (const dir of dirs) {
      const seq = (dirReq.current.get(dir) ?? 0) + 1;
      dirReq.current.set(dir, seq);
      seqs.set(dir, seq);
      // **首次展开**才显示「读取目录…」；失效重列时旧内容原地留着、新结果到了再换。
      // 否则作者每按一次 Ctrl+S（保存也是外部改动的一种），整棵树的展开层就闪一下空白——
      // 这是本批自己引入的风险：以前根本没有第二次列举，现在有了，就不能让它打扰人。
      if (!dirCache.has(dir)) loading.set(dir, 'loading');
    }
    if (loading.size > 0) applyDirUpdates(loading);
    void Promise.allSettled(dirs.map((dir) => listDir(dir))).then((settled) => {
      const updates = new Map<string, DirState>();
      settled.forEach((r, i) => {
        const dir = dirs[i] as string;
        if (dirReq.current.get(dir) !== seqs.get(dir)) return;
        updates.set(dir, r.status === 'fulfilled' ? r.value : 'error');
      });
      if (updates.size > 0) applyDirUpdates(updates);
      // 一句人话回执的"读不到"那一半：批量展开要等列举回来才知道有几个目录失败
      let failed = 0;
      updates.forEach((state) => {
        if (state === 'error') failed++;
      });
      onSettled?.(failed, updates.size);
    });
  }, [listDir, dirCache, applyDirUpdates]);

  /** 发起一次列举（不看缓存，总是重新取；结果按请求序号认领先后） */
  const fetchDir = useCallback((dir: string): void => {
    fetchDirs([dir]);
  }, [fetchDirs]);

  /** 真实文件夹视图的惰性加载（按绝对路径；已缓存则零请求） */
  const ensureDir = useCallback((dir: string): void => {
    if (!listDir || dirCache.has(dir)) return;
    fetchDir(dir);
  }, [listDir, dirCache, fetchDir]);

  /** 点击包标题行 = 追加 / 收起真实文件夹内容（ERB 列表始终原地不动） */
  const togglePkgFolder = useCallback((pkgKey: string, dir: string): void => {
    const willEnter = !pkgFolder.has(pkgKey);
    setPkgFolder((prev) => toggleIn(prev)(pkgKey));
    if (willEnter) ensureDir(dir);
  }, [pkgFolder, ensureDir]);

  /** 子目录展开/折叠（递归；首次展开才取该层） */
  const toggleSub = useCallback((dir: string): void => {
    captureAnchorRef.current();
    const willOpen = !subOpen.has(dir);
    setSubOpen((prev) => toggleIn(prev)(dir));
    if (willOpen) ensureDir(dir);
  }, [subOpen, ensureDir]);

  /**
   * 幂等的"打开"三件套（PERF 批：定位不再造多余渲染）。
   *
   * 旧写法 `setOpened((prev) => new Set(prev).add(x))` 无论**是否已展开**都换一个新 Set
   * ⇒ React 认定 state 变了 ⇒ 整棵树重画一次。自动定位每次切标签都会走这条路，
   * 于是「已经展开好的分组」也被迫重画。这里在归约函数里先判一遍：已展开直接返回原引用，
   * React 的 `Object.is` 判等就会跳过这次提交。
   */
  const openGroup = (label: string): void => {
    setOpened((prev) => (prev.has(label) ? prev : new Set(prev).add(label)));
  };
  const openPackage = (key: string): void => {
    setPkgFolder((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  };
  const openSubDir = (dir: string): void => {
    setSubOpen((prev) => (prev.has(dir) ? prev : new Set(prev).add(dir)));
  };

  /**
   * fs 视图的根层清单：取自工作区根模型里带 `browsable` 的那一组（游戏根 + 口上域 +
   * 存档 + 作品目录 + 附加根，嵌套已折叠）；模型缺席 ⇒ 旧行为（项目根 ∪ 附加根）。
   *
   * 只有**一个**根时维持 B5 原形态（根层直接铺开、无分组头），零视觉扰动；
   * 多根时每根一个分组头（D1 的形态，作品目录同样受益：作者作品在真实文件夹视图里
   * 第一次看得见、点得开）。
   */
  const fsRoots = useMemo<string[]>(() => {
    if (folders.length === 0) return [project.rootDir, ...(extraRoots ?? [])];
    const browsable = browsableRootsOf(folders);
    return browsable.length > 0 ? browsable : [project.rootDir];
  }, [folders, project.rootDir, extraRoots]);
  const multiRootFs = fsRoots.length > 1;
  /** fs 视图根头的角色（标题上屏用：可写 / 只读 / 项目根，别让作者猜这一格是谁） */
  const fsRootRoleOf = useCallback(
    (root: string): string => {
      const hit = folders.find((f) => pkey(f.path) === pkey(root));
      if (hit === undefined) return root === project.rootDir ? '项目根' : '';
      if (hit.role === 'author') return '你的作品目录（可写）';
      if (hit.role === 'extra') return '本次会话添加的文件夹（只读）';
      return hit.path === project.rootDir ? '项目根' : hit.label;
    },
    [folders, project.rootDir],
  );

  /**
   * 进入文件系统视图（B5）时惰性取项目根的第一层：根 = `project.rootDir`
   * （GameProject 契约的项目根字段，口上目录们与其他一切都在它之下）。
   * 失败（浏览器壳无桌面壳权限等）走 DirRows 既有 error 态口径——「目录读取失败（需要桌面壳权限）」。
   * 多根形态（D1）：根头默认**折叠**，展开（toggleSub）时才取——不为看不见的东西打 IO。
   */
  useEffect(() => {
    if (view === 'fs' && !multiRootFs) ensureDir(project.rootDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, project.rootDir, listDir, multiRootFs]);

  /** 收集作用域内全部作者包（根散文件无包目录，不在真实文件夹视图范围） */
  const collectPackages = (gs: readonly Group[]): Array<{ key: string; dir: string; group: string }> => {
    const out: Array<{ key: string; dir: string; group: string }> = [];
    for (const g of gs) {
      for (const s of g.subs) {
        if (s.label === null) continue;
        out.push({ key: packageKey(g.label, s.label), dir: pkgDirOf(g, s.label), group: g.label });
      }
    }
    return out;
  };

  /** 作用域内可展开的组与包（根散文件无包层，不参与"展开"这件事） */
  const revealTargets = (gs: readonly Group[]): RevealGroup[] =>
    gs.map((g) => ({
      label: g.label,
      packages: g.subs.map((s) => s.label).filter((x): x is string => x !== null),
    }));

  const revealStateOf = () => ({ openedGroups: opened, openedPackages: pkgFolder });

  /**
   * 落一次批量结果：状态 + 惰性取目录 + 一句反馈，三件事一起做。
   *
   * 上游的「展开全部」原先只管角色组、不管组里的作者包——用户于是看见"点了没反应"。
   * 这里两层一起动，并让根节点的入口变成**可逆开关**（全展开时它反向成收起）。
   *
   * **列举走一次批量**（WS-12）：改前对每个待展开的包各调一次 `ensureDir` ⇒
   * K 个包 = K 轮 `listDir` 请求 + K 次 `setDirCache`（每次都是一帧全树重渲染）。
   * 现在一次收集、一次 `fetchDirs` ⇒ 一帧落地；回执也说清"展开了多少行、有几个目录读不到"。
   */
  const applyReveal = (list: readonly Group[], r: RevealResult): void => {
    if (r.mode === 'expand') {
      captureAnchorRef.current();
      const missing: string[] = [];
      let fileRows = 0;
      for (const g of list) {
        if (!opened.has(g.label)) fileRows += g.total;
        for (const s of g.subs) {
          if (s.label === null) continue;
          const key = packageKey(g.label, s.label);
          if (pkgFolder.has(key)) continue;
          const dir = pkgDirOf(g, s.label);
          if (!dirCache.has(dir)) missing.push(dir);
        }
      }
      const head = fileRows > 0 ? `${r.feedback}（新增 ${fileRows} 行文件）` : r.feedback;
      setRevealNote(missing.length > 0 && listDir === undefined ? `${head}——目录读取通道不可用` : head);
      fetchDirs(missing, (failed) => {
        if (failed === 0) return;
        setRevealNote(`${head}；${failed} 个目录读不到（权限或已移动）`);
      });
    } else {
      captureAnchorRef.current();
      setSubOpen(new Set());
    }
    setOpened(r.openedGroups);
    setPkgFolder(r.openedPackages);
    if (r.mode !== 'expand') setRevealNote(r.feedback);
  };

  /**
   * 外部改动 → 目录缓存失效（HK-5；实机线 §5.87 留下的欠账，本组接）。
   *
   * 三条刻意的克制：
   * - **只重列正在显示的目录**：折叠着的等下次展开惰性取，不为看不见的东西打一圈 IO；
   * - **展开态一律不动**：`opened` / `pkgFolder` / `subOpen` 是作者的现场，不是缓存的一部分
   *   （当年"打开文件就丢展开态"那个 bug 就败在把现场当缓存一起重挂）；
   * - **依赖只有 nonce**：展开/折叠自身变化绝不能触发重列，否则点一下树就是一次目录请求风暴。
   */
  /**
   * 重列当前显示的目录。**失效信号与手动「重新读取」共用这一条**（HK-5）。
   *
   * 手动那枚按钮不是多余的装饰：`file.watchState` 会如实报 `partial` / `unavailable`
   * （§5.84）——某些根没监视上、或平台根本没有监视能力（浏览器开发壳）。那时
   * 自动失效一条都不会到，作者手里必须还有一条不用重开项目的路。
   */
  /**
   * 重列请求批是否还在途（D-1 真壳实测抓出的洞）：`relistShown` 捕获锚点后，**响应落地前
   * 还有一发同帧的 setState**（手动那枚「重读」点完就写一句话回执 `note`），那一帧把一次性
   * 锚点白白用掉、真清单回来插行时反而没人补量。恢复侧只要看见这里还是 true 就续期锚点
   * （与「列举在途续期」同一条腿，只是那份 loading 判据盖不到 cached 目录的重列）。
   */
  const relistInFlight = useRef(false);

  const relistShown = (): number => {
    // D-1「视口不跳」的第三条腿：重列回来的清单**可能比缓存里长**（外面丢进新文件），
    // 这些行插在焦点行上面时浏览器只保 scrollTop、不保行——先记锚点，落地那一帧由
    // 恢复侧把视口偏移补回去（与 toggleSub / applyReveal 同一形态）。
    captureAnchorRef.current();
    const dirs = new Set(dirsToRelist(subOpen, pkgFolder, collectPackages(groups)));
    // 文件系统视图（B5/D1）：根层全部根一并重列（多根时折叠着的也会被取到顶层——手动
    // 重读是显式动作，宁可多取一层也不留"按了刷新还有根没重列"的疑心）
    if (view === 'fs') for (const r of fsRoots) dirs.add(r);
    // 一次失效 = 一次请求批 = **一帧**（旧实现每份目录响应各排一帧，K 层展开就是 K 帧全树）
    relistInFlight.current = true;
    fetchDirs([...dirs], () => {
      relistInFlight.current = false;
    });
    return dirs.size;
  };

  const lastNonce = useRef(refreshNonce);
  useEffect(() => {
    if (refreshNonce === undefined || refreshNonce === lastNonce.current) return;
    lastNonce.current = refreshNonce;
    relistShown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce]);

  /* ---------------- 文件/目录编辑（B1/B2 文件树编辑批） ---------------- */

  /** 轻反馈（复用 revealNote 同款形态——一句话状态行，不建 toast 基建） */
  const note = useCallback((msg: string): void => setRevealNote(msg), []);
  const noteErr = useCallback((err: unknown, action: string): void => {
    const msg = errorText(err);
    // 越权写（WriteNotAllowedError）的消息是英文内部术语：换成人话，其余原样带出
    setRevealNote(String(err instanceof Error && err.name === 'WriteNotAllowedError')
      ? '这个位置在只读范围内，不能在这里修改文件。要先在「只读」徽章那里批准写权限。'
      : `${action}失败：${msg}`);
  }, []);

  /** 把某个目录的父层「打开到可见」：新建/重命名的输入行必须落在已展开的那一层 */
  const openLayerOf = (dir: string): void => {
    // 是某个作者包目录 → 打开包的真实文件夹视图（新建的文件 immediate 可见处就在这）
    for (const g of groups) {
      for (const s of g.subs) {
        if (s.label !== null && pkey(pkgDirOf(g, s.label)) === pkey(dir)) {
          const key = packageKey(g.label, s.label);
          setOpened((prev) => new Set(prev).add(g.label));
          setPkgFolder((prev) => new Set(prev).add(key));
          ensureDir(dir);
          return;
        }
      }
    }
    // 否则按子目录展开（父包视图由调用点保证已开——能右键到它就说明开着）
    setSubOpen((prev) => new Set(prev).add(dir));
    ensureDir(dir);
  };

  const beginCreate = (kind: 'file' | 'dir', dir: string): void => {
    // 过滤态强制全展开、且真实文件夹视图被隐藏（isFolder 要求非过滤）——编辑需要看到那层，清词最自解释
    if (deferredFilter) setFilter('');
    openLayerOf(dir);
    setEdit({ mode: 'create', kind, dir });
    setEditValue('');
  };

  const beginRename = (path: string, isDir: boolean): void => {
    if (isDir && deferredFilter) setFilter('');
    setEdit({ mode: 'rename', path, isDir });
    setEditValue(baseName(path));
  };

  /** dirCache 剪枝：整目录没了/搬走了，其下所有缓存条目一并退场（防重建后捞出幽灵子树） */
  const pruneCacheUnder = useCallback((dir: string): void => {
    setDirCache((m) => {
      const next = new Map(m);
      let changed = false;
      for (const k of next.keys()) {
        if (isUnderPath(dir, k)) {
          next.delete(k);
          changed = true;
        }
      }
      return changed ? next : m;
    });
  }, []);

  /** 重命名目录后 subOpen 里的旧前缀跟着搬（展开态是作者的现场，搬目录不算丢现场） */
  const remapSubOpen = useCallback((fromDir: string, toDir: string): void => {
    setSubOpen((prev) => {
      const next = new Set<string>();
      for (const k of prev) next.add(isUnderPath(fromDir, k) ? joinPath(toDir, k.slice(fromDir.replace(/[\\/]+$/, '').length + 1)) : k);
      return next;
    });
  }, []);

  /** 操作涉及哪些目录就重列哪些（重命名要重列 from 与 to 两个父目录；不全树重挂） */
  const refetchDirs = useCallback((dirs: readonly string[]): void => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const d of dirs) {
      if (!d || seen.has(pkey(d))) continue;
      seen.add(pkey(d));
      out.push(d);
    }
    // 与失效重列同一条批处理腿：改名涉及两层 ⇒ 一次请求批、一帧落地（不是两帧）
    fetchDirs(out);
  }, [fetchDirs]);

  const commitEdit = useCallback((): void => {
    const e = edit;
    if (!e) return;
    const name = editValue.trim();
    const invalid = validateEntryName(name);
    if (invalid) {
      // 名字不合法：留在编辑态让用户改，说清错在哪（不闪退不静默）
      note(invalid);
      return;
    }
    if (e.mode === 'create') {
      const target = joinPath(e.dir, name);
      // 预检第一道闸（kernel.isWritable）：可行才试——说人话在先，而不是等异常再说英文
      if (io && !io.isWritable(e.dir)) {
        setEdit(null);
        note('这个位置在只读范围内，不能在这里新建。要先在「只读」徽章那里批准写权限。');
        return;
      }
      // 同名守门（WS-01）：盘上已有同名条目 ⇒ 不写不覆盖，编辑行留着让作者改名。
      // 判据与文案在 `file-tree-create`；落盘走 OS 级独占创建（O_EXCL），不再先查后写。
      void createEntryIfAbsent(io!, { target, kind: e.kind, name }).then(
        (outcome) => {
          if (!outcome.created) {
            note(outcome.message);
            return;
          }
          setEdit(null);
          // 只重列落点目录；新文件立刻可见处 = 包的真实文件夹视图（openLayerOf 已打开）
          refetchDirs([e.dir]);
          // WS-05：新文件立刻进索引（平铺列表 / 函数树 / Ctrl+T 马上跟），不等 watcher 去抖
          if (e.kind === 'file') onDiskEntriesChanged?.({ changed: [target], removed: [] });
          note(`已新建${e.kind === 'file' ? '文件' : '文件夹'}「${name}」`);
        },
        (err: unknown) => noteErr(err, '新建'),
      );
      return;
    }
    // rename
    const parent = parentDir(e.path);
    const to = joinPath(parent, name);
    if (pkey(to) === pkey(e.path)) {
      setEdit(null);
      return; // 名字没变：等于取消
    }
    const blocked = guardFileOp?.([e.path]) ?? null;
    if (blocked) {
      setEdit(null);
      note(blocked);
      return;
    }
    if (io && (!io.isWritable(e.path) || !io.isWritable(to))) {
      setEdit(null);
      note('这个位置在只读范围内，不能重命名。要先在「只读」徽章那里批准写权限。');
      return;
    }
    void io!.rename(e.path, to).then(
      () => {
        setEdit(null);
        refetchDirs([parent]);
        if (e.isDir) {
          pruneCacheUnder(e.path);
          remapSubOpen(e.path, to);
          // 旧目录下的展开视图缓存一并退场；组/包的展开键是标签，不随路径变，不用动
        }
        onFilesGone?.([], [{ from: e.path, to }]);
        note(`已重命名为「${name}」`);
      },
      (err: unknown) => noteErr(err, '重命名'),
    );
  }, [edit, editValue, io, guardFileOp, onFilesGone, refetchDirs, note, noteErr, pruneCacheUnder, remapSubOpen, onDiskEntriesChanged]);

  const cancelEdit = useCallback((): void => setEdit(null), []);

  /* 「删除」只有一条腿：`requestDelete` → `runDeleteBatch`（见 WS-13 2c 那一段）。
   * 原来这里还有一条 `doDelete`——同一动作按勾选集大小分档：勾一枚走 `window.confirm` +
   * `guardFileOp` 一刀拒绝脏文件，勾两枚才走逐条点名的模态。同一个动作两种 UI、两种脏口径
   * 就是本批要收掉的东西，于是那条腿连同它的文案（`file-tree-ops.deleteConfirmText`）一起退场。 */

  const copyText = (text: string, doneNote: string): void => {
    const clip = navigator.clipboard;
    if (!clip) {
      note('复制失败：当前环境没有可用的剪贴板');
      return;
    }
    void clip.writeText(text).then(
      () => note(doneNote),
      () => note('复制失败：剪贴板不可用'),
    );
  };

  /* ---------------- WS-13：剪贴板家族（复制 / 剪切 / 粘贴 / 创建副本）的接线 ---------------- */

  /**
   * 待答问句（冲突四选项 / 脏闸二选项）。
   *
   * ref 与 state 同步维护：ref 给**同一个 tick 里的第二个动作**看（粘贴链还挂在 await 上时，
   * state 尚未提交），挡下重入并说人话；state 只决定这一帧画不画面。
   */
  const [fileOpsAsk, setFileOpsAsk] = useState<FileOpsAsk | null>(null);
  const fileOpsAskRef = useRef<FileOpsAsk | null>(null);
  /** 落盘在途闸：一次搬运没跑完之前不接第二次（IO 是异步的，双击粘贴不该跑两遍） */
  const fileOpsBusy = useRef(false);
  /**
   * 回执旁边那个「撤销这次删除」还在不在（数字 = 这一批有几份能放回原位）。
   *
   * 真相住在 `file-delete-exec` 的会话台账里，这里只决定这一帧画不画那个按钮——
   * 台账空了（撤销用掉 / 换项目 / 撤销后仍有没放回的为零）就必须收掉，不许留一个点了只会说
   * "没有可撤销的删除"的假入口（铁律 4）。
   */
  const [undoOffer, setUndoOffer] = useState<number | null>(null);

  const askFileOps = (
    spec: Omit<FileOpsAsk, 'pick'>,
    fallback: string,
  ): Promise<string> => {
    if (fileOpsAskRef.current !== null) {
      note('上一个动作还在等作者决定——先把那一个答了。');
      return Promise.resolve(fallback);
    }
    return new Promise<string>((resolve) => {
      const ask: FileOpsAsk = {
        ...spec,
        pick: (value: string): void => {
          fileOpsAskRef.current = null;
          setFileOpsAsk(null);
          resolve(value);
        },
      };
      fileOpsAskRef.current = ask;
      setFileOpsAsk(ask);
    });
  };

  /** 撞名问句：文案与选项都取自计划层单源（`conflictQuestion` / `CONFLICT_CHOICES`） */
  const askConflict = (plan: FileOpsPlan): Promise<ConflictDecision> =>
    askFileOps(
      {
        label: '同名条目怎么处理',
        text: conflictQuestion(plan),
        choices: CONFLICT_CHOICES.map((c) => ({
          value: c.action,
          label: c.label,
          primary: c.action === 'keepBoth',
        })),
        escapeValue: 'cancel',
      },
      'cancel',
    ) as Promise<ConflictDecision>;

  /** 脏闸问句：文案单源在 `file-tree-ops.dirtyGateText`，措辞不在此处重写 */
  const askDirtyGate = (kind: 'move' | 'overwrite' | 'delete', names: readonly string[]): Promise<boolean> =>
    askFileOps(
      {
        label: '有未保存的修改',
        text: dirtyGateText(kind, names),
        choices: [
          { value: 'cancel', label: '取消' },
          { value: 'go', label: '继续', primary: true },
        ],
        escapeValue: 'cancel',
      },
      'cancel',
    ).then((v) => v === 'go');

  /**
   * 行模型现读"这一格是什么"（多选集只存路径，种类必须从当场还在的行上取——
   * 树可能已经变了，猜种类就是把目录当文件搬）。
   */
  const clipEntriesOf = (paths: readonly string[]): ClipEntry[] => {
    const byKey = new Map<string, (typeof tree.rows)[number]>();
    for (const r of tree.rows) if (r.path !== '') byKey.set(pkey(r.path), r);
    const out: ClipEntry[] = [];
    for (const p of paths) {
      const r = byKey.get(pkey(p));
      if (r === undefined || !rowIsClipSource(r)) continue;
      out.push({ path: r.path, isDir: r.kind === 'dir' || r.kind === 'package' });
    }
    return out;
  };

  /** 搬运的宾语（口径与键位层注释一致）：右击行不在勾选集里就以它为准，否则多选集，再否则焦点行 */
  const clipSources = (hintPath?: string): ClipEntry[] => {
    const selection = getSelectedPaths();
    if (hintPath !== undefined && !selection.some((s) => pkey(s) === pkey(hintPath))) {
      return clipEntriesOf([hintPath]);
    }
    if (selection.length > 0) {
      const entries = clipEntriesOf(selection);
      if (entries.length > 0) return entries;
    }
    const focusRow = focusIndex >= 0 ? rowAt(tree, focusIndex) : undefined;
    if (focusRow === undefined || !rowIsClipSource(focusRow)) return [];
    return [{ path: focusRow.path, isDir: focusRow.kind === 'dir' || focusRow.kind === 'package' }];
  };

  /** 落点目录（焦点行所在那一格；口径住 `clipTargetDirOf`） */
  const clipTargetDir = (): string | null =>
    clipTargetDirOf(focusIndex >= 0 ? rowAt(tree, focusIndex) : undefined);

  /** 搬运参与跨根判定的根清单（项目根 + 会话附加根 + 工作区各根；`buildFileOpsPlan` 的 roots 口径） */
  const moveRoots = (): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of [project.rootDir, ...(extraRoots ?? []), ...folders.map((f) => f.path)]) {
      if (r === '' || seen.has(pkey(r))) continue;
      seen.add(pkey(r));
      out.push(r);
    }
    return out;
  };

  /** 目标目录现状：粘贴那一刻现取一次（列表比缓存新 ⇒ 撞名问句问得准）；取不到退回缓存/空 */
  const targetEntriesOf = async (dir: string): Promise<FileOpEntry[]> => {
    if (listDir !== undefined) {
      try {
        const list = await listDir(dir);
        return list.map((e) => ({ path: e.path, isDir: e.isDirectory }));
      } catch {
        /* 读不动不硬撑：落地那步走独占创建，预检只是提前把话说清楚（见 file-ops-plan 模块头） */
      }
    }
    const st = dirCache.get(dir);
    return Array.isArray(st) ? st.map((e) => ({ path: e.path, isDir: e.isDirectory })) : [];
  };

  /** 计划 → （冲突问一句）→ 执行层落盘 → 回执上屏 + 目录重列 + 索引/标签收尾 + 剪贴板收尾 */
  const executeFileOps = async (args: {
    intent: 'paste' | 'duplicate';
    mode: FileOpMode;
    sources: readonly FileOpEntry[];
    targetDir: string;
  }): Promise<void> => {
    if (io === undefined) {
      note('当前环境没有落盘的通道（纯浏览器宿主）——复制进剪贴板可以，粘贴落不了地。');
      return;
    }
    if (fileOpsBusy.current) {
      note('上一个搬运还在落盘——稍等一下。');
      return;
    }
    fileOpsBusy.current = true;
    try {
      const plan = buildFileOpsPlan({
        sources: args.sources,
        targetDir: args.targetDir,
        targetEntries: await targetEntriesOf(args.targetDir),
        mode: args.mode,
        intent: args.intent,
        roots: moveRoots(),
      });
      const hasConflict = plan.items.some((i) => i.status === 'conflict');
      let decision: ConflictDecision = 'skip';
      if (hasConflict) {
        // 副本的本义就是"原地再落一份"：撞名（通常就是与源自己撞）不改名没有别的落法，
        // 问一句等于把作者已经说清楚的事再问一遍；粘贴才需要问。
        decision = plan.intent === 'duplicate' ? 'keepBoth' : await askConflict(plan);
      }
      let writable = false;
      try {
        writable = io.isWritable(plan.targetDir);
      } catch {
        writable = false; // "说不出可写"绝不亮成可写（与根头那格同一把尺）
      }
      const outcome = await runFileOps({
        io,
        plan,
        decision,
        targetWritable: writable,
        // 脏闸接真源：`dirtyOf` 由宿主从会话脏态投影（判据住 disk-reconcile，树不自造第二份"脏"）
        dirty: dirtyOf !== undefined ? { dirtyOf, askDirty: askDirtyGate } : undefined,
      });
      note(outcome.resultText);
      // 收尾三件（与新建/重命名既有口径同一条腿）：落点与源所在层各重列一次、索引增量上报、
      // 剪切落地的标签改写走 onFilesGone 的 renamed 那半（"跟着搬"而不是"被删了"）
      refetchDirs([plan.targetDir, ...plan.items.map((i) => parentDir(i.from))]);
      const movedTos = outcome.moved.map((m) => m.to);
      const movedFroms = outcome.moved.map((m) => m.from);
      if (outcome.created.length > 0 || movedTos.length > 0 || movedFroms.length > 0) {
        onDiskEntriesChanged?.({ changed: [...outcome.created, ...movedTos], removed: movedFroms });
      }
      if (outcome.moved.length > 0) {
        for (const m of outcome.moved) pruneCacheUnder(m.from);
        onFilesGone?.([], outcome.moved.map((m) => ({ from: m.from, to: m.to })));
        // 剪切落地的部分从剪贴板退场；没落地的（跳过/拒绝/失败）仍留在原地，剪贴板留着它们才能重试
        const gone = new Set(movedFroms.map((p) => pkey(p)));
        const rest = getFileClipboard().filter((e) => !gone.has(pkey(e.path)));
        setFileClipboard(rest, 'cut');
      }
    } finally {
      fileOpsBusy.current = false;
    }
  };

  /** 一次动作的总入口（键位、菜单、命令面板运行时桥三条腿汇到这一处） */
  const runClipOp = (op: ExplorerOp, hintPath?: string, hintDir?: string | null): void => {
    if (op === 'copy' || op === 'cut') {
      const entries = clipSources(hintPath);
      if (entries.length === 0) {
        note(
          hintPath !== undefined
            ? '这一格眼下不在树里（可能刚被移动或删掉）——先刷新再看一眼。'
            : `先选中要搬的条目（文件、文件夹或作者包），再${op === 'copy' ? '复制' : '剪切'}。`,
        );
        return;
      }
      setFileClipboard(entries, op === 'cut' ? 'cut' : 'copy');
      note(fileClipSentence());
      return;
    }
    if (op === 'paste') {
      const targetDir = hintDir !== undefined ? hintDir : clipTargetDir();
      if (!hasFileClipboard()) {
        note('剪贴板是空的——先在树上选中要搬的东西，再按复制。');
        return;
      }
      if (targetDir === null || targetDir === '') {
        note('没有明确的落点目录——先把焦点落到一个文件夹（或作者包）上，再粘贴。');
        return;
      }
      void executeFileOps({ intent: 'paste', mode: getFileClipMode() === 'cut' ? 'move' : 'copy', sources: getFileClipboard(), targetDir }).catch(
        (err: unknown) => noteErr(err, '粘贴'),
      );
      return;
    }
    // duplicate：原地再落一份（落点 = 源自己那一格）
    const entries = clipSources(hintPath);
    if (entries.length === 0) {
      note('先选中要做副本的条目（文件、文件夹或作者包）。');
      return;
    }
    const targetDir = hintDir !== undefined ? hintDir : parentDir(entries[0]!.path);
    if (targetDir === null || targetDir === '') {
      note('这一格读不出它所在的文件夹——先刷新再看一眼。');
      return;
    }
    void executeFileOps({ intent: 'duplicate', mode: 'copy', sources: entries, targetDir }).catch(
      (err: unknown) => noteErr(err, '创建副本'),
    );
  };

  /* ---------------- WS-13 2b：树内拖拽搬运（拖起=选择集 / 落点=目录行 / 纯拖=移动 / Ctrl 拖=复制） ---------------- */

  /**
   * 这一批拖的是哪几份（拖起那一刻定下来，松手时多选集可能已经被别的事件改过）。
   *
   * `dataTransfer` 里也写了一份同样的载荷（自家 MIME）：ref 是同一个 tick 的快路径，
   * 载荷是"事件绕道而来"（浏览器把 drop 交给别的表面）时仍能自证的那条慢路径。
   */
  const treeDragRef = useRef<{ readonly sources: readonly FileOpEntry[] } | null>(null);
  /** 当前亮着落点高亮的那一行（类是命令式挂摘的：dragover 每秒几十次，不该为它重渲染树） */
  const dragHoverElRef = useRef<HTMLElement | null>(null);

  /** 事件源 → 行元素（行内嵌套的 span / 图标都算命中它所属的那一行） */
  const treeRowElOf = (target: EventTarget | null): HTMLElement | null => {
    const el = target as HTMLElement | null;
    if (el === null || typeof el.closest !== 'function') return null;
    return el.closest<HTMLElement>('[role="treeitem"]');
  };

  /** 行元素 → 行下标（`data-tid` 是 DOM 与行模型之间唯一的桥，判据住 `file-tree-flat`） */
  const treeRowIndexFrom = (el: HTMLElement | null): number => {
    const tid = el?.dataset.tid;
    return tid === undefined ? -1 : indexOfId(tree, tid);
  };

  /** 落点高亮：换行先摘干净，再按判决挂类（可落一档描边 / 非法再加一格"不许落"） */
  const setTreeDropHover = (el: HTMLElement | null, ok: boolean): void => {
    if (dragHoverElRef.current !== el) {
      dragHoverElRef.current?.classList.remove(TREE_DROP_OK_CLASS, TREE_DROP_NO_CLASS);
      dragHoverElRef.current = el;
    }
    if (el === null) return;
    for (const cls of treeDropClasses(ok)) el.classList.add(cls);
  };

  const clearTreeDropHover = (): void => {
    dragHoverElRef.current?.classList.remove(TREE_DROP_OK_CLASS, TREE_DROP_NO_CLASS);
    dragHoverElRef.current = null;
  };

  /**
   * 拖起（WS-13 2b · 判据全住 `file-tree-drag`，这里只接线）。
   *
   * 三条口径：① 宾语就是**多选集真源**（按下那一行在集合里 = 拖整批；不在 = 先按点行的
   * 既有口径收到那一行——勾选集合只收文件行，目录行按下时不动它，与鼠标侧逐字一致）；
   * ② 拖不起来的（角色分组头 / 说明行）当场 preventDefault 并**说清为什么**，不许静默；
   * ③ 载荷只写自家 MIME ⇒ 外部文件拖入那条腿（`ui/drag-drop.ts`）一个字都不受影响。
   */
  const handleTreeDragStart = (e: ReactDragEvent<HTMLUListElement>): void => {
    const el = treeRowElOf(e.target);
    const index = treeRowIndexFrom(el);
    if (index < 0) return;
    const row = rowAt(tree, index);
    const plan = planTreeDragSources({
      tree,
      pressedIndex: index,
      selectedPaths: getSelectedPaths(),
      anchorIndex: anchorIdx.current,
      shift: e.shiftKey,
    });
    if (plan.sources.length === 0) {
      e.preventDefault();
      note(plan.reason ?? '这一格拖不动。');
      treeDragRef.current = null;
      return;
    }
    if (plan.collapseTo !== null) {
      if (row !== undefined && row.selectable) setSelected([plan.collapseTo]);
      anchorIdx.current = index;
    } else if (e.shiftKey) {
      setSelected(plan.sources.map((s) => s.path));
    }
    if (row !== undefined) setFocusTid(row.id);
    treeDragRef.current = { sources: plan.sources };
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData(TREE_DRAG_MIME, encodeTreeDragPayload(plan.sources));
  };

  /**
   * 拖过（落点高亮 + 允许 drop）。
   *
   * **非法落点也接住 drop**：这里若 `preventDefault` 都不做，浏览器就会把松手吃掉，
   * 作者看到的正是任务里点名不许有的"松手没反应"。形状交给 `treeDropClasses`，
   * 原因交给 drop 那一句回执——悬停阶段只负责"看得见这里落不下去"。
   */
  const handleTreeDragOver = (e: ReactDragEvent<HTMLUListElement>): void => {
    if (!acceptsTreeDrop(e.dataTransfer.types)) return;
    const el = treeRowElOf(e.target);
    const sources = treeDragRef.current?.sources ?? decodeTreeDragPayload(e.dataTransfer.getData(TREE_DRAG_MIME));
    const verdict = planTreeDropTarget({
      tree,
      overIndex: treeRowIndexFrom(el),
      sources,
      ctrl: e.ctrlKey,
      meta: e.metaKey,
      roots: moveRoots(),
    });
    e.preventDefault();
    e.dataTransfer.dropEffect = verdict.mode;
    setTreeDropHover(el, verdict.ok);
  };

  /** 真正离开树容器才清高亮（行与行之间移动会反复触发 leave，闪断即噪声——照 `panel-drop` 口径） */
  const handleTreeDragLeave = (e: ReactDragEvent<HTMLUListElement>): void => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    clearTreeDropHover();
  };

  /**
   * 松手落地：**唯一一条腿就是粘贴那条腿**（`executeFileOps`）。
   *
   * 计划层现读目标目录现状 → 撞名问句与粘贴同一句、同四选项；脏源问一次也同一条腿；
   * 落盘走执行层（独占创建堵 TOCTOU）；收尾（重列目录 / 索引增量 / 标签换路径 / 回执）
   * 全在既有那半条上，本处只补一句"落不下去"的原因。
   */
  const handleTreeDrop = (e: ReactDragEvent<HTMLUListElement>): void => {
    if (!acceptsTreeDrop(e.dataTransfer.types)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = treeRowElOf(e.target);
    const sources = treeDragRef.current?.sources ?? decodeTreeDragPayload(e.dataTransfer.getData(TREE_DRAG_MIME));
    treeDragRef.current = null;
    clearTreeDropHover();
    const verdict = planTreeDropTarget({
      tree,
      overIndex: treeRowIndexFrom(el),
      sources,
      ctrl: e.ctrlKey,
      meta: e.metaKey,
      roots: moveRoots(),
    });
    if (!verdict.ok || verdict.targetDir === null) {
      note(treeDropRejectSentence(verdict.reason ?? '这一格落不下去——要落到目录行、作者包行或角色分组行上。'));
      return;
    }
    void executeFileOps({ intent: 'paste', mode: verdict.mode, sources, targetDir: verdict.targetDir }).catch(
      (err: unknown) => noteErr(err, '拖拽搬运'),
    );
  };

  /** 拖拽收尾（落在窗口外 / 按 Esc 中止都会走到这里）：载荷与高亮一起清，不留半个现场 */
  const handleTreeDragEnd = (): void => {
    treeDragRef.current = null;
    clearTreeDropHover();
  };

  /* ---------------- WS-13 2c：批量删除 + 回收站 + 撤销 ---------------- */

  /**
   * 删除确认问句：文案单源在 `file-delete-plan.deleteBatchConfirmText`（逐条点名），这里不改写一个字。
   *
   * **一枚与二十枚都是这同一段模态**（同一 `aria-label`、同一"逐项点名 + 去路"结构）——
   * 标题与按钮上的数字跟着计划走，勾一项时就是「删除 1 项」。
   */
  const askDeleteConfirm = (plan: DeletePlan, text: string): Promise<boolean> =>
    askFileOps(
      {
        label: '删除这些条目',
        text,
        choices: [
          { value: 'cancel', label: '取消' },
          { value: 'go', label: `删除 ${plan.targets.length} 项`, primary: true },
        ],
        escapeValue: 'cancel',
      },
      'cancel',
    ).then((v) => v === 'go');

  /** 目录连带规模：确认之前现算一次（一趟 walkDir 拿整棵子树；读不到就如实退化，不猜数字） */
  const carriedSizes = async (entries: readonly FileOpEntry[]): Promise<Map<string, { files?: number; dirs?: number }>> => {
    const sizes = new Map<string, { files?: number; dirs?: number }>();
    if (walkDir === undefined) return sizes;
    await Promise.all(
      entries
        .filter((e) => e.isDir)
        .map(async (e) => {
          const key = pkey(e.path);
          if (sizes.has(key)) return;
          sizes.set(key, {});
          try {
            const list = await walkDir(e.path, { includeFiles: true, includeDirs: true });
            let files = 0;
            let dirs = 0;
            for (const x of list) {
              if (pkey(x.path) === key) continue; // walkDir 把根自己也列出来：那一格不是"连带"
              if (x.isDirectory) dirs += 1;
              else files += 1;
            }
            sizes.set(key, { files, dirs });
          } catch {
            sizes.set(key, {});
          }
        }),
    );
    return sizes;
  };

  /**
   * 删除落地的**唯一一条腿**（勾一枚与勾一整批都进这里；名字里的 "batch" 是"这一份清单"的意思）。
   *
   * 执行层给的是完整事实（删成几项 / 回收站对上几号 / 哪几条被挡下），这里只做五件收尾：
   * 回执上屏（附撤销入口）、受影响目录重列、被删目录的缓存退场、标签与索引跟着盘上真相走、
   * 勾选集清空（条目已经不在盘上，留着一个指向不存在路径的勾选等于骗下一次删除）。
   */
  const runDeleteBatch = async (entries: readonly FileOpEntry[]): Promise<void> => {
    if (io === undefined) {
      note('当前环境没有落盘的通道（纯浏览器宿主）——删除落不了地。');
      return;
    }
    if (fileOpsBusy.current) {
      note('上一个动作还在落盘——稍等一下。');
      return;
    }
    fileOpsBusy.current = true;
    try {
      const sizes = await carriedSizes(entries);
      const outcome = await runBatchDelete({
        io,
        entries,
        sizeOf: (p) => sizes.get(pkey(p)),
        blockedOf: (p) => {
          let writable = false;
          try {
            writable = io.isWritable(p);
          } catch {
            writable = false; // "说不出可写"绝不亮成可写（与根头那格同一把尺）
          }
          return writable ? null : READONLY_BLOCK_REASON;
        },
        // 脏闸接的是同一份真源（判据住 disk-reconcile.dirtyNamesIn；批删问一次，不逐条问）
        dirty: dirtyOf !== undefined ? { dirtyOf, askDirty: askDirtyGate } : undefined,
        confirm: askDeleteConfirm,
      });
      note(outcome.resultText);
      setUndoOffer(outcome.batch === null ? null : outcome.batch.records.length);
      const gone = [...outcome.deleted, ...outcome.untracked];
      if (gone.length === 0) return;
      const parents: string[] = [];
      const seenParent = new Set<string>();
      for (const g of gone) {
        if (g.isDir) pruneCacheUnder(g.path);
        const parent = parentDir(g.path);
        if (parent === '' || seenParent.has(pkey(parent))) continue;
        seenParent.add(pkey(parent));
        parents.push(parent);
      }
      refetchDirs(parents);
      const gonePaths = gone.map((g) => g.path);
      onFilesGone?.(gonePaths, []);
      onDiskEntriesChanged?.({ changed: [], removed: gonePaths });
      setSelected([]);
    } finally {
      fileOpsBusy.current = false;
    }
  };

  /**
   * 撤销刚才那一批（回收站 → 原路径，逐条 `restoreFromTrash`）。
   *
   * 入口两条：回执旁边那个按钮 + 命令面板 `explorer.undoDeleteEntry`——同一个函数，
   * 不建第二套 toast，也不给撤销抢 `Ctrl+Z`（那是编辑器的键）。
   */
  const runUndoDelete = async (): Promise<void> => {
    const batch = getLastDeleteBatch();
    if (batch === null || batch.records.length === 0) {
      setUndoOffer(null);
      note(undoUnavailableText());
      return;
    }
    if (io === undefined) {
      note('当前环境没有落盘的通道（纯浏览器宿主）——撤销也落不了地。');
      return;
    }
    if (fileOpsBusy.current) {
      note('上一个动作还在落盘——稍等一下。');
      return;
    }
    fileOpsBusy.current = true;
    try {
      const outcome = await undoDeleteBatch({ io, batch });
      note(outcome.resultText);
      setUndoOffer(outcome.remaining.length > 0 ? outcome.remaining.length : null);
      if (outcome.restored.length === 0) return;
      const parents: string[] = [];
      const seenParent = new Set<string>();
      for (const r of outcome.restored) {
        if (r.isDir) pruneCacheUnder(r.path);
        const parent = parentDir(r.path);
        if (parent === '' || seenParent.has(pkey(parent))) continue;
        seenParent.add(pkey(parent));
        parents.push(parent);
      }
      refetchDirs(parents);
      onDiskEntriesChanged?.({ changed: outcome.restored.map((r) => r.path), removed: [] });
    } finally {
      fileOpsBusy.current = false;
    }
  };

  /**
   * 删除的宾语判据（三条入口——键位 / 右键 / 命令面板——汇到这一处）。
   *
   * **一个动作一种形态**：不分档。宾语照 `clipSources` 的口径现读（右击行不在勾选集里就以它
   * 为准，否则勾选集，再否则焦点行——"只删点的那一行"这条老读感就是这么保留的），
   * 无论读出一枚还是二十枚都交给 `runDeleteBatch`：同一段逐条点名的模态、同一份回收站台账、
   * 同一颗「撤销这次删除」，脏文件也是**问一次、可继续**（不再被 `guardFileOp` 一刀拒绝）。
   */
  const requestDelete = (hintPath: string): void => {
    const entries = clipSources(hintPath);
    if (entries.length === 0) {
      note('先选中要删的条目（文件、文件夹或作者包），再按删除。');
      return;
    }
    void runDeleteBatch(entries).catch((err: unknown) => noteErr(err, '删除'));
  };

  /**
   * 把执行入口登记进运行时桥（每次渲染整体替换；卸载即 null——与菜单运行时同一形态）。
   * 命令面板不持有现场：宾语与落点只有树自己当场知道，打过来由这里现读。
   */
  const runClipOpRef = useRef(runClipOp);
  runClipOpRef.current = runClipOp;
  const runUndoDeleteRef = useRef(runUndoDelete);
  runUndoDeleteRef.current = runUndoDelete;
  useEffect(() => {
    setExplorerOpsRuntime({
      run: (op) => runClipOpRef.current(op),
      undoDelete: () => void runUndoDeleteRef.current().catch((err: unknown) => noteErr(err, '撤销')),
    });
  });
  useEffect(
    () => () => {
      setExplorerOpsRuntime(null);
      // 卸载时还挂着没答的问句：把 ref 清掉，别留一个永远等不到的"在等决定"
      fileOpsAskRef.current = null;
    },
    [],
  );

  /**
   * 换项目即清剪贴板（模块级会话态活得比一次挂载久）。
   * 只在**根真的变了**时清：侧栏开关导致的重挂不清——"上次剪了什么"在现场还在的项目里仍有效。
   *
   * 删除台账同一处理：里面装的是**上一个项目的绝对路径**，跨项目留着既撤销不动
   * （回收站的恢复要过新项目这一侧的写允许域，必然被拒），又会把"上次删了什么"留在界面上骗人。
   */
  const clipRootRef = useRef(project.rootDir);
  useEffect(() => {
    if (pkey(clipRootRef.current) === pkey(project.rootDir)) return;
    clipRootRef.current = project.rootDir;
    clearFileClipboard();
    clearDeleteBatchLedger();
  }, [project.rootDir]);

  /** 右键作用域自己那一格的落点目录（粘贴到菜单右击处；口径与 `clipTargetDirOf` 一致） */
  const scopeTargetDir = (scope: FileTreeScope): string | null => {
    switch (scope.kind) {
      case 'file':
        return parentDir(scope.path);
      case 'dir':
        return scope.path;
      case 'package':
        return scope.dir;
      case 'group':
        return scope.prefix;
      case 'blank':
        return null;
    }
  };

  /** 作用域自身的路径（文件 / 目录 / 作者包；角色组与空白区没有可复制/可删的路径） */
  const scopePathOf = (scope: FileTreeScope): string => {
    switch (scope.kind) {
      case 'file':
        return scope.path;
      case 'dir':
        return scope.path;
      case 'package':
        return scope.dir;
      default:
        return '';
    }
  };

  /**
   * 刷新（当前作用域）：只重列这一个目录，不动展开态（HK-5 的"手动那条腿"）。
   * 文件作用域 = 它所在的文件夹；目录 / 作者包 = 它自己。
   */
  const refreshScope = (scope: FileTreeScope): void => {
    const dir =
      scope.kind === 'file'
        ? parentDir(scope.path)
        : scope.kind === 'dir'
          ? scope.path
          : scope.kind === 'package'
            ? scope.dir
            : '';
    if (!dir || !listDir) return;
    fetchDirs([dir]);
    note(`已重新读取「${baseName(dir)}」`);
  };

  /**
   * 展开全部：角色组作用域只展开本组（含组里的作者包——旧工具条只做组那一层，
   * 用户于是读成"点了没反应"）；其余作用域 = 整棵树。
   */
  const expandScope = (scope: FileTreeScope): void => {
    if (scope.kind === 'group') {
      const g = groups.find((x) => x.label === scope.label);
      if (g === undefined) {
        note('这个角色目录已经不在树里了——可能刚被重命名或删除，先刷新看看');
        return;
      }
      applyReveal([g], expandAllReveal(revealTargets([g]), revealStateOf()));
      return;
    }
    applyReveal(visible, expandAllReveal(revealTargets(visible), revealStateOf()));
  };

  /** 收起：角色组作用域只收本组；其余作用域收整棵树（含真实文件夹层） */
  const collapseScope = (scope: FileTreeScope): void => {
    if (scope.kind === 'group') {
      const g = groups.find((x) => x.label === scope.label);
      if (g === undefined) {
        note('这个角色目录已经不在树里了——可能刚被重命名或删除，先刷新看看');
        return;
      }
      const pkgKeys = g.subs
        .filter((s): s is PackageGroup & { label: string } => s.label !== null)
        .map((s) => packageKey(g.label, s.label));
      setOpened((prev) => {
        const next = new Set(prev);
        next.delete(g.label);
        return next;
      });
      setPkgFolder((prev) => {
        const next = new Set(prev);
        for (const key of pkgKeys) next.delete(key);
        return next;
      });
      // 组内子目录的展开态一并收（组外的现场不动——收起一个组不该惊动别的组）
      setSubOpen((prev) => {
        const next = new Set<string>();
        for (const dir of prev) if (!isUnderPath(g.prefix, dir)) next.add(dir);
        return next;
      });
      note(`已收起「${g.label}」`);
      return;
    }
    applyReveal(groups, collapseAllReveal());
  };

  const runMenuAction = (id: MenuItemId, scope: FileTreeScope): void => {
    const path = scopePathOf(scope);
    switch (id) {
      case 'open':
        if (scope.kind === 'file') onOpenFile(scope.path);
        break;
      case 'copy-name':
        if (path) copyText(baseName(path), `已复制文件名「${baseName(path)}」`);
        break;
      case 'copy-path':
        if (path) copyText(path, '已复制完整路径');
        break;
      case 'copy-rel-path':
        if (scope.kind === 'file') copyText(relativeToRoot(scope.path, project.rootDir), '已复制相对路径');
        break;
      case 'compare-selected': {
        // 菜单只在"恰选 2 个文件且这一行在其中"时给出这一项（判据在 file-tree-ops），
        // 这里再判一次是防"集合在右键与点击之间被改动"的极小窗口——拿不到就照实说一句。
        const pair = compareSelectionPair(
          getSelectedPaths(),
          scope.kind === 'file' ? scope.path : undefined,
        );
        if (pair === null) {
          note('要比较两个文件：按住 Ctrl 点第二个文件，再右键「比较已选文件」');
          break;
        }
        if (onCompareFiles === undefined) {
          note('当前环境打不开比较视图（差异视图通道不可用）');
          break;
        }
        onCompareFiles(pair[0], pair[1]);
        break;
      }
      case 'reveal':
        if (path) onRevealInExplorer?.(path);
        break;
      case 'refresh':
        refreshScope(scope);
        break;
      case 'history':
        // 面板读的是**当前编辑中的文件**（命令 when 判据）：菜单只在这一行就是活动文件时
        // 才可点（禁用原因见 file-tree-ops.historyItem），这里只负责把命令发出去。
        if (!runContextMenuCommand(SHOW_FILE_HISTORY_COMMAND_ID)) {
          note('文件历史打不开：先打开这份文件，再查看它的历史版本');
        }
        break;
      case 'new-file':
        if (path) beginCreate('file', path);
        break;
      case 'new-dir':
        if (path) beginCreate('dir', path);
        break;
      case 'rename':
        if (path) beginRename(path, scope.kind === 'dir' || scope.kind === 'package');
        break;
      case 'delete':
        // 右键「删除」：右击那一格不在勾选集里就只删它，否则删整批（种类由行模型现读，不靠作用域猜）
        if (path) requestDelete(path);
        break;
      case 'import':
        if (scope.kind === 'package') onImportPackage?.({ dir: scope.dir, label: scope.label });
        break;
      case 'expand-all':
        expandScope(scope);
        break;
      case 'collapse-all':
        collapseScope(scope);
        break;
      case 'locate': {
        const current = getActivePath();
        if (current) requestLocate(current);
        break;
      }
      case 'relist': {
        const count = relistShown();
        note(count > 0 ? `已重新扫描 ${count} 个目录` : '没有展开的目录可重扫——展开文件夹后再试');
        break;
      }
      case 'switch-view-kojo':
        setView('kojo');
        break;
      case 'switch-view-fs':
        // 根层第一层由 `view === 'fs'` 那条既有 effect 惰性取（这里不重复打 IO）
        setView('fs');
        break;
      case 'add-folder':
        onAddFolder?.();
        break;
      case 'command-palette':
        if (!runContextMenuCommand(COMMAND_PALETTE_COMMAND)) note('命令面板打不开：命令还没注册好');
        break;
      /* ---- WS-13 剪贴板家族 + 按目录限定检索（宾语 = 右击行或多选集，落点 = 右击那一格） ---- */
      case 'clip-copy':
        runClipOp('copy', scopePathOf(scope));
        break;
      case 'clip-cut':
        runClipOp('cut', scopePathOf(scope));
        break;
      case 'clip-paste':
        runClipOp('paste', undefined, scopeTargetDir(scope));
        break;
      case 'duplicate':
        // 副本落 = 源自己那一格的**兄弟层**（hintDir 不给，runClipOp 自己按源路径取父目录；
        // 把目录的副本落进目录自己里面是要被计划层判掉的那种圈）
        runClipOp('duplicate', scopePathOf(scope));
        break;
      case 'search-in-folder': {
        // 作用域 = **右击那一格自己的目录**（文件行取它所在那层，目录/包行取本身），
        // 不是当前活动文件——右键 B 目录却搜到 A 文件的层是说不通的那种错。
        // 落点在宿主：`search-store.openFolderSearchScope`（设目录作用域 + 翻搜索视图上屏）。
        const dir = scopeTargetDir(scope);
        if (dir !== null) onSearchInFolder?.(dir);
        break;
      }
    }
  };

  /**
   * 菜单能力位（铁律 4：没有通道的项整项不显示，不许灰着不说话）。
   *
   * 只有**真实存在**的通道才设位：命令面板 / 文件历史看命令注册表，重列看 `listDir`，
   * 添加文件夹看宿主回调，剪贴板看 `navigator.clipboard`。
   *
   * 搬运家族（WS-13）的位 = **执行层的原语齐不齐**：落地要 `createFileExclusive` /
   * `createDirExclusive` / `copyFile` / `rename` / `removeFile`（全在契约 `FileIO` 上，
   * io 在场即齐）——纯浏览器宿主没有 io ⇒ 四项整组不显示。
   * 「在此文件夹中搜索」看宿主的 `onSearchInFolder` 回调（落点是 `search-store` 的
   * `openFolderSearchScope`，宿主没接就不摆一项点了没反应的入口）。
   */
  const menuCapability: MenuCapability = {
    hasIo: io !== undefined,
    canReveal: onRevealInExplorer !== undefined,
    canImport: onImportPackage !== undefined,
    canClipboard: typeof navigator !== 'undefined' && navigator.clipboard !== undefined,
    canRelist: listDir !== undefined,
    canHistory: canRunContextMenuCommand(SHOW_FILE_HISTORY_COMMAND_ID),
    canCommandPalette: canRunContextMenuCommand(COMMAND_PALETTE_COMMAND),
    canAddFolder: onAddFolder !== undefined,
    canMoveEntries: io !== undefined,
    canSearchInFolder: onSearchInFolder !== undefined,
  };

  /**
   * 把当前现场交给面（行菜单在根宿主里构建时读它）。
   *
   * 每次渲染整体替换：视图 / 活动文件 / 能力位 / 分发函数都跟着这一帧的真相走，
   * 不需要「依赖变了重新声明面」那套（重复声明会告警，也会让两个实例互相覆盖）。
   * 卸载清空 ⇒ 面拿不到桥就返回 null，右键落回兜底，不弹空壳。
   */
  useEffect(() => {
    setFileTreeMenuRuntime({
      view,
      activeFile: getActivePath(),
      capability: menuCapability,
      // 多选集现读（不是注册这帧的快照）：勾选不引起树重渲，快照会过期（见 file-tree-menu）
      selection: getSelectedPaths,
      // 剪贴板条目数同样现读：粘贴项只在剪贴板非空时出现（空集合给灰态 = 点了没反应）
      clipCount: () => getFileClipboard().length,
      act: runMenuAction,
    });
  });
  useEffect(() => () => setFileTreeMenuRuntime(null), []);

  /**
   * 换项目 / 树卸载时清多选集（D 批）。
   *
   * 多选集是模块级单例，活得比一次挂载久：不清，换项目后可能拿上一个项目的两份路径去
   * 「比较已选文件」（读了旧项目的盘、还以为是当前项目）。清在"项目身份变了"与"卸载"两拍，
   * 与 `file-tree-selection` 的"卸载不清活动文件"刻意不同——活动文件由宿主 prop 每帧同步，
   * 本集合没有那条同步腿，只能自己收。
   */
  useEffect(() => {
    clearSelected();
    return () => clearSelected();
    // 只认项目根：同一项目重载（索引重建 / 重开同目录）不该清掉作者的勾选——
    // 勾的是"这一份项目里的文件"，根没变，勾选就仍有意义。
  }, [project.rootDir]);

  /* ---------------- B4：定位当前文件 ---------------- */

  /**
   * 在树体内找 data-locate 行并滚到刚好可见。比对走归一键（pkey）：
   * 文件系统视图的行路径来自磁盘列举（DirEntry.path），与 activeFile 的写法可能差个
   * 分隔符/大小写——按字面比对会漏滚，归一后 Windows 两种写法都命中。
   *
   * 目标行**已经整行可见**时直接返回（PERF 批）：旧实现无条件 `scrollIntoView`，
   * 于是每次切标签都要读一遍几何、算一次滚动——而绝大多数切换的目标行本来就在视口里
   * （同一个作者包、相邻的几个面文件）。判据用容器矩形与行矩形比，留 1px 余量给
   * 亚像素取整。
   */
  const scrollLocate = (targetPath: string): void => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const body = treeBodyRef.current;
        if (!body) return;
        // 先按字面路径**点名**要那一行（PS-6：旧实现每次都把挂在树上的每一行都摸一遍，
        // 过滤态一帧挂上千行时，定位一次就是一次全表扫描）。属性值里的 `\` 与 `"` 要转义，
        // Windows 路径几乎必带 `\`。
        const direct = body.querySelector<HTMLElement>(
          `button[data-locate="${escapeAttrValue(targetPath)}"]`,
        );
        if (direct) {
          scrollLocateIntoRow(body, direct);
          return;
        }
        // 点不到才退回归一比对：磁盘列举的行与 activeFile 的写法可能差个分隔符/大小写
        // （Windows 两种写法都算同一个文件），这条腿是那种情形的兜底，不是常规路径。
        const key = pkey(targetPath);
        for (const el of body.querySelectorAll<HTMLElement>('button[data-locate]')) {
          if (pkey(el.dataset.locate ?? '') === key) {
            scrollLocateIntoRow(body, el);
            break;
          }
        }
      }),
    );
  };

  /**
   * 滚到"刚好可见"——**已在视口内就一个像素都不动**。
   *
   * `scrollIntoView({block:'nearest'})` 本身只做最小滚动，但它仍是一次几何读取 + 一次
   * 滚动意图（合成层会跟着动、容器可能带 scroll-behavior 动画）。命中率最高的情形
   * （目标行就在当前视口里）根本不需要它，所以先自己判一次。
   */
  const scrollLocateIntoRow = (body: HTMLElement, row: HTMLElement): void => {
    const rowRect = row.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const visible =
      rowRect.top >= bodyRect.top - 1 &&
      rowRect.bottom <= bodyRect.bottom + 1 &&
      rowRect.left >= bodyRect.left - 1 &&
      rowRect.right <= bodyRect.right + 1;
    if (visible) return;
    row.scrollIntoView({ block: 'nearest' });
  };

  /**
   * 落一次定位请求（读**当前现场**，不产生任何 state 更新）。
   *
   * 旧实现在这里用了 `locateReq` state + effect：切标签 ⇒ setState ⇒ 整树重画 ⇒
   * effect ⇒ 展开态 setState ⇒ 又一棵树重画 ⇒ 才滚。现在改成"订阅回调直接调本函数"，
   * 一次切换里 locate 这条腿最多只做真正必要的展开（已展开的分组不 setState——
   * 归约函数返回原引用，React 直接跳过）。
   *
   * 三种"还不能完成"的情形都**留着** `locateTarget`：目录列举在途（等 dirCache effect
   * 再试）、过滤态（等抖动的过滤词落定）、未归属（等分组变化）——与旧 effect 的
   * 依赖集一一对应，但都不再需要一次渲染来驱动。
   */
  const runLocate = (): void => {
    const target = locateTarget.current;
    if (target === null) return;
    // D-1「视口不跳」的第四条腿：定位途中会改展开态（openGroup / openPackage / openSubDir），
    // 插进来的行落在焦点行**上面**时不能把视口从作者盯着的那一行拽走——请求还没落定
    // （等列举 / 等行模型追上）的每一帧都由锚点保偏移；而**落定那一拍**的滚动是定位自己
    // 发的（scrollToIndex / scrollLocate），锚点当场作废，恢复腿不许把它拽回去。
    captureAnchorRef.current();
    if (view === 'fs') {
      // 文件系统视图：locatePlanOf 是语义树口径，不适用——退化为「从所属根到 activeFile
      // 逐级展开」（D1：fsRoots 逐根算归属，附加根内的文件同样定位得到）。
      // 目录列举是异步的：父层清单没回来时先不清请求也不硬滚（dirCache 变化会重跑），
      // 回来后行已挂载，两拍 rAF 再滚（nearest 只滚到刚好可见，不拽容器乱跳）。
      const plan = fsLocatePlanOfRoots(fsRoots, target);
      if (!plan) {
        locateTarget.current = null; // 不在任何根下：安静放弃，不报错
        return;
      }
      if (multiRootFs) {
        // 多根形态：先把所属根的分组头打开（单根形态没有分组头，根层本来就铺开）
        openSubDir(plan.root);
        ensureDir(plan.root);
      }
      for (const d of plan.dirs) {
        openSubDir(d);
        ensureDir(d);
      }
      const parent = plan.dirs[plan.dirs.length - 1] ?? plan.root;
      const st = dirCache.get(parent);
      if (st === undefined || st === 'loading') return; // 等列举回来
      if (st === 'error') {
        locateTarget.current = null; // 列不动就不硬撑（失败行已在树上自解释）
        return;
      }
      scrollLocate(target);
      locateTarget.current = null;
      anchorRow.current = null; // 落定：这一拍的滚动归定位自己，锚点作废（不许拽回去）
      return;
    }
    if (deferredFilter) {
      // 过滤态：结果被渲染窗口截断、强制全展开也不是用户的现场——自动定位安静放弃；
      // 手动定位等过滤词清空（deferred 追上）后再试。
      return;
    }
    const plan: LocatePlan | null = locatePlanOf(groups, target, (prefix, label) =>
      joinPath(prefix, label),
    );
    if (!plan) return; // 未归属 / 不在索引里：安静放弃，不报错
    openGroup(plan.groupLabel);
    if (plan.pkg) {
      openPackage(plan.pkg.key);
      ensureDir(plan.pkg.dir);
    }
    /**
     * 虚拟化之后，"行在不在 DOM 里"不再等价于"行在不在树里"（WS-12）。
     *
     * 所以先问**行模型**：目标行已经在这份现场里 ⇒ 把它的顶部滚进视口（窗口跟着滚动事件
     * 重算 ⇒ 下一帧它就真挂出来），顺手把焦点交给它；还没进模型（组刚展开、这一帧的模型
     * 是展开前那份）⇒ **留着这条定位请求**，等 `tree` 变化那条 effect 再试一次。
     * DOM 那条腿照旧兜底跑一遍：两拍 rAF 后如果行已经挂上，`scrollLocate` 会精确滚到它。
     */
    const index = indexOfId(tree, leafRowId(plan.targetPath));
    if (index < 0) {
      scrollLocate(plan.targetPath);
      return; // 现场还没追上（等下一帧）：不清请求，也不硬滚
    }
    scrollToIndex(index);
    setFocusTid(tree.rows[index]?.id ?? null);
    scrollLocate(plan.targetPath);
    locateTarget.current = null;
    anchorRow.current = null; // 落定：滚动归定位自己（含"焦点本来就在目标行"那种，锚点会把这拍拽回去）
  };
  /** 订阅回调与 effect 都走这一格：闭包每帧刷新，避免读到上一帧的现场 */
  const runLocateRef = useRef(runLocate);
  runLocateRef.current = runLocate;

  /**
   * 选中变化 ⇒ 记下目标并就地尝试（**不 setState**）。
   *
   * 挂载那一次不会走到这里：外壳在渲染期就把当时的 `activeFile` 灌进 store 了
   * （见 `FileTree` 的注释），订阅装好时选中态已经是对的 ⇒ 旧实现里那条
   * "首次挂载不算变化"的特判（`firstActiveRef`）在这里自然消失。
   */
  useEffect(
    () =>
      subscribeActivePath((path) => {
        if (path === null) return;
        locateTarget.current = path;
        runLocateRef.current();
      }),
    [],
  );

  /** 记一次定位请求（右键菜单「定位到当前文件」走这条，与自动定位同一个落点） */
  function requestLocate(file: string): void {
    locateTarget.current = file;
    runLocateRef.current();
  }

  /**
   * 该包本次渲染的行数（PERF-6 过滤窗口）。
   * 非过滤态 `plan === null` ⇒ 全量（改动前行为）；过滤态按 `filterRenderPlan` 的预算切。
   */
  const renderLimitOf = (g: Group, s: PackageGroup): number =>
    plan ? (plan.perPackage.get(rowKeyOf(g.label, s.label)) ?? 0) : s.files.length;

  /**
   * `DirRows` 的宿主侧接线（口上视图的包层与文件系统视图的根层复用同一套行渲染）。
   *
   * 目录缓存、展开集合、行内编辑态由本组件持有——行渲染只是被画出来的那一层，现场仍在树里
   * （切视图/重渲染不丢展开态）。选中态与诊断量**不在这里**（行自己订阅，见
   * `file-tree-selection` / `file-tree-problem-view`）。dir / depth / skip 在调用点各自覆盖。
   */
  const dirRowsBase = {
    dirCache,
    subOpen,
    edit,
    editValue,
    glossOf,
    setEditValue,
    commitEdit,
    cancelEdit,
    toggleSub,
    onOpenFile,
  };


  /** 包层已平铺的 ERB 路径集（子目录渲染时去重用；PS-16：按包对象身份 WeakMap 缓存 ⇒ 引用恒定） */
  const erbKeysOf = (s: PackageGroup): ReadonlySet<string> => {
    let hit = erbKeysCache.get(s);
    if (hit === undefined) {
      hit = new Set(s.files.map(pkey));
      erbKeysCache.set(s, hit);
    }
    return hit;
  };

  /* ---------------- WS-12：扁平行模型 + 虚拟化窗口（判据住 `file-tree-flat` / `file-tree-virtual`） ---------------- */

  /** 正在新建的那一层（行模型要给它的输入行算一格高度，不然滚动会跳） */
  const createInDir = edit?.mode === 'create' ? edit.dir : null;

  /**
   * 当前现场会被画成哪些行（一次算清，含每行的像素顶部与层级）。
   *
   * 两个视图共用一份行模型：口上视图的行**会被裁**（虚拟化），文件系统视图的行不会
   * ——它逐层惰性列举，规模由作者的展开动作本身约束。但 ↑↓ / →← / Home / End 与
   * `aria-level` 在两个视图里走的是同一批判据，不出现"这棵树认键盘、那棵树不认"。
   */
  const tree: FlatTree = useMemo(() => {
    if (view === 'fs') {
      return buildFsFlatTree({
        multiRoot: multiRootFs,
        subOpen,
        dirCache,
        createInDir,
        roots: multiRootFs
          ? fsRoots.map((root) => ({ key: root, label: baseName(root), dir: root, open: subOpen.has(root) }))
          : [{ key: project.rootDir, label: baseName(project.rootDir), dir: project.rootDir, open: true }],
      });
    }
    const kojoInputs: KojoGroupInput[] = visible.map((g) => ({
      group: g,
      open: opened.has(g.label) || deferredFilter.length > 0,
      pkgFolderOpen: (pkgKey: string) => pkgFolder.has(pkgKey) && deferredFilter.length === 0,
      limitOf: (subIdx: number) => renderLimitOf(g, g.subs[subIdx] as PackageGroup),
    }));
    const rootInputs: KojoGroupInput[] = rootGroupsVisible.map((rg) => ({
      group: { label: rg.folder.label, prefix: rg.folder.path, subs: [{ label: null, files: rg.hits }], total: rg.hits.length },
      key: rg.key,
      open: opened.has(rg.key) || deferredFilter.length > 0,
      pkgFolderOpen: () => false,
      // 说明行（读不到 / 还在读 / 还没有方言文件）也占一行高度：不算进去滚动就会整组错位
      note:
        rg.status === 'error'
          ? '这个文件夹读不到（可能已移动，或当前环境没有桌面壳权限）'
          : rg.files.length === 0
            ? rg.status === 'loading'
              ? '读取文件夹…'
              : '这个文件夹里还没有 ERB 方言文件'
            : undefined,
    }));
    return buildKojoFlatTree({
      groups: [...kojoInputs, ...rootInputs],
      subOpen,
      dirCache,
      pkgDirOf: pkgDirOfPrefix,
      createInDir,
    });
    // 依赖里给的都是渲染帧现读的量（`renderLimitOf` / `pkgDirOf` 是每帧重建的纯闭包，
    // 它们吃的 state 已经逐枚列在下面 ⇒ 不会读到上一帧）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, multiRootFs, fsRoots, project.rootDir, visible, rootGroupsVisible, opened, pkgFolder, subOpen, dirCache, plan, deferredFilter, createInDir]);

  /**
   * 本次挂载的行区间。
   *
   * 口上视图按视口裁；文件系统视图不裁（`fullRange`）——见上面那段取舍。
   * 两视图都过这一格 ⇒ "非过滤态与过滤态走同一条虚拟化路径"是结构上的，不是两条 if。
   *
   * **这一格窗口就是三层裁点唯一的输入**（WS-12 欠账批）：组（`sliceSpan(grp.span)`）、
   * 包（`sliceSpan(sub.span)`）、平铺 ERB（`sliceBlock`）都拿它算 ⇒ 视口之外的行不分种类，
   * 一律不挂 DOM、只垫高度；不存在"叶子行走窗口、结构行走常驻"那两套口径。
   */
  const range: VisibleRange = view === 'kojo' ? visibleRange(tree.rows, scroll.top, scroll.h) : fullRange(tree.rows.length);
  /**
   * 现场变了就再试一次（目录列举回来 / 分组换了 / 视图切了 / 过滤词落定 / **行模型换了**）。
   * 读的是 ref，没有待办就立刻返回——这条 effect 不会自己触发渲染。
   *
   * 为什么搬在行模型之后、并把 `tree` 放进依赖：虚拟化让"目标行挂不挂得出来"变成**行模型**的
   * 属性——刚展开的那一组要等新模型算出来才认得出目标行（少了这条，展开后的自动定位会安静地不滚）。
   */
  useEffect(() => {
    if (locateTarget.current !== null) runLocateRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, deferredFilter, view, dirCache, tree]);

  /** 焦点行的下标（tid 是真源，下标每帧从模型现推 ⇒ 展开/收起之后仍指同一行） */
  const focusIndex = focusTid === null ? -1 : indexOfId(tree, focusTid);

  /**
   * 目录缓存的淘汰保护集（WS-12）：正在显示的层一个都不许被挤掉。
   *
   * 每帧现读进 ref（`applyDirUpdates` 从 ref 取 ⇒ 现场变化不会让那枚回调换身份，
   * 穿进行组件的 `toggleSub` 引用也就不会因此抖动）。
   * 改前只护 `subOpen` 一件：点开过「真实文件夹内容」的包目录（键是包键）与焦点行 /
   * 多选行所在层都露着，缓存超 400 条时会被淘汰成空白。
   */
  protectDirs.current = protectedDirKeysOf({
    subOpen,
    openPackageDirs: collectPackages(groups)
      .filter((p) => pkgFolder.has(p.key))
      .map((p) => p.dir),
    focusPath: focusIndex >= 0 ? (rowAt(tree, focusIndex)?.path ?? null) : null,
    selectedPaths: getSelectedPaths(),
    editingDir: edit?.mode === 'create' ? edit.dir : edit?.mode === 'rename' ? parentDir(edit.path) : null,
  });

  const viewportH = (): number => {
    const body = treeBodyRef.current;
    return body === null || body.clientHeight <= 0 ? scroll.h : body.clientHeight;
  };
  const maxScroll = (): number => Math.max(0, tree.height - viewportH());

  /** 把第 index 行滚进视口（先滚、后挂、再聚焦；判据是行模型的像素，不读 DOM 矩形） */
  const scrollToIndex = (index: number): void => {
    const row = rowAt(tree, index);
    const body = treeBodyRef.current;
    if (row === undefined || body === null) return;
    const next = scrollToShow(row.top, body.scrollTop, viewportH(), maxScroll());
    if (Math.abs(next - body.scrollTop) > 0.5) {
      body.scrollTop = next;
      setScroll((prev) => (prev.top === next ? prev : { ...prev, top: next }));
    }
  };

  /**
   * 展开 / 收起之前先记下锚点行在视口里的位置。
   *
   * 浏览器只会替我们保持 `scrollTop`，而"在它上面插入几十行"恰恰会让盯着的那一行跑掉；
   * 这里改成保持**锚点行的视口偏移**（`anchorScrollTop` 那条纯判据）。
   */
  const captureAnchorImpl = (): void => {
    const body = treeBodyRef.current;
    const row = focusIndex >= 0 ? rowAt(tree, focusIndex) : undefined;
    if (body === null || row === undefined || focusTid === null) {
      anchorRow.current = null;
      return;
    }
    anchorRow.current = { tid: row.id, top: row.top, scroll: body.scrollTop };
  };
  captureAnchorRef.current = captureAnchorImpl;

  /**
   * 锚点保持：展开 / 收起之后把焦点行顶回它原来在视口里的位置（WS-12「视口不跳」）。
   *
   * 浏览器只会替我们保持 `scrollTop`，而"在它上面插入几十行"恰恰会让盯着的那一行跑掉；
   * 这里改成保持**锚点行的视口偏移**（`anchorScrollTop` 那条纯判据）。
   *
   * **有列举在途时续期**：点开一个包的"真实文件夹"要等 `listDir` 回来才算数，
   * 中间那一格「读取目录…」只有 1 行，真清单回来时可能变成 20 行——都是插在锚点上面。
   * 一次性的锚点会在第一段落地时用掉，剩下的那次插行就照样跳。续期到"没有 loading 为止"，
   * 且只在焦点行自己还活着时续（焦点换了 = 作者已经不盯它了；行没了 = 收起的正是它）。
   */
  useLayoutEffect(() => {
    const held = anchorRow.current;
    anchorRow.current = null;
    const body = treeBodyRef.current;
    if (held === null || body === null) return;
    const index = indexOfId(tree, held.tid);
    const row = index >= 0 ? rowAt(tree, index) : undefined;
    if (row === undefined || row.id !== focusTid) return;
    const next = anchorScrollTop(held.top, row.top, held.scroll, Math.max(0, tree.height - (body.clientHeight || scroll.h)));
    if (Math.abs(next - body.scrollTop) > 0.5) {
      body.scrollTop = next;
      setScroll((prev) => (prev.top === next ? prev : { ...prev, top: next }));
    }
    let loading = false;
    dirCache.forEach((state) => {
      if (state === 'loading') loading = true;
    });
    // 「重列批在途」与「列举 loading」并列的续期理由：relistShown 走的是缓存里已有的目录，
    // 不会有 loading 那一格，但响应落地前的同帧 setState（回执一句话）会先吃掉一次性锚点。
    if (loading || relistInFlight.current) anchorRow.current = { tid: row.id, top: row.top, scroll: body.scrollTop };
  });

  /**
   * roving tabindex：整棵树**只有一个** tab 停靠点。
   *
   * 为什么走 DOM 而不是 props：焦点行下标每次移动都变，把它穿进行组件就是给 PS-16 那批
   * memo 新增一位"每帧可能换引用的 prop"；而 tabindex 本来就是 DOM 的事（焦点在哪一行是
   * DOM 的事实，不是渲染输入）。每帧只扫**挂载中**的行的这一格属性，代价与窗口同档。
   *
   * 同一趟扫描顺手把"焦点该落在哪一行"办结（`pendingFocus`）：键盘移动焦点时目标行可能
   * 还在窗口外（滚动与挂载差一帧），这里等它挂出来再聚焦 ⇒ 不会出现"按了 End 焦点没了"。
   * 模型里已经不存在的行号直接作废（不留一个将来会误抢焦点的待办）。
   */
  useLayoutEffect(() => {
    const body = treeBodyRef.current;
    if (body === null) return;
    const rows = body.querySelectorAll<HTMLElement>('[role="treeitem"]');
    let placed = false;
    let target: HTMLElement | null = null;
    for (const el of rows) {
      const tid = el.dataset.tid;
      const on = !placed && focusTid !== null && tid === focusTid;
      const next = on ? 0 : -1;
      if (el.tabIndex !== next) el.tabIndex = next;
      // WS-13 2b：拖拽的"可拖"同样走 DOM 而不是 props——理由与上面那格 tabindex 一字不差
      // （行组件是 memo 过的无知组件，多一位 prop 就多一位"每帧可能换引用"；虚拟化裁掉的行
      // 本来也没挂出来，代价与窗口同档）。**每一行都可拖**：角色分组头 / 说明性行被拖起来时
      // 由 `planTreeDragSources` 当场拦下并说出原因（拖不动 ≠ 不许按，静默才是问题）。
      if (!el.draggable) el.draggable = true;
      if (on) placed = true;
      if (tid !== undefined && tid === pendingFocus.current) target = el;
    }
    if (!placed && rows.length > 0 && rows[0]!.tabIndex !== 0) rows[0]!.tabIndex = 0;
    if (pendingFocus.current !== null && indexOfId(tree, pendingFocus.current) < 0) pendingFocus.current = null;
    if (target !== null) {
      pendingFocus.current = null;
      target.focus({ preventScroll: true });
    }
  });

  /** 焦点交给当前焦点行（没有焦点行就落到第一个挂载的树项——E 车道接线契约的那半条） */
  const focusRovingRow = (): void => {
    const body = treeBodyRef.current;
    if (body === null) return;
    const rows = body.querySelectorAll<HTMLElement>('[role="treeitem"]');
    let target: HTMLElement | null = null;
    for (const el of rows) {
      if (focusTid !== null && el.dataset.tid === focusTid) {
        target = el;
        break;
      }
    }
    const hit = target ?? (rows[0] as HTMLElement | undefined) ?? null;
    if (hit === null) return;
    const tid = hit.dataset.tid;
    if (tid !== undefined) {
      setFocusTid(tid);
      pendingFocus.current = tid;
    }
    hit.focus({ preventScroll: true });
  };

  /**
   * 焦点落到第 index 行（键盘导航与 Shift 连选都收在这一条腿上）。
   *
   * 口径与 VSCode 的资源管理器一致：移动焦点即改动单选集合（Shift 从锚点连选），
   * 结构行没有可勾选的身份 ⇒ 集合收回空（"勾了要比较的两份文件"那种集合由鼠标侧维持）。
   */
  const moveFocus = (index: number, extend: boolean): void => {
    const row = rowAt(tree, index);
    if (row === undefined) return;
    if (extend) {
      const from = anchorIdx.current >= 0 ? anchorIdx.current : focusIndex;
      setSelected(rangePaths(tree, from, index));
    } else {
      anchorIdx.current = index;
      setSelected(row.selectable && row.path !== '' ? [row.path] : []);
    }
    setFocusTid(row.id);
    pendingFocus.current = row.id;
    scrollToIndex(index);
  };

  /** 展开 / 收起一行（三种结构行各有各的现场集合；口径与既有的 toggle* 逐字相同） */
  const setOpenRow = (row: FlatRow, want: boolean): void => {
    captureAnchorRef.current();
    if (row.kind === 'group') {
      const key = row.id.slice(2);
      setOpened((prev) => {
        if (prev.has(key) === want) return prev;
        const next = new Set(prev);
        if (want) next.add(key);
        else next.delete(key);
        return next;
      });
      return;
    }
    if (row.kind === 'package') {
      const pkgKey = row.id.slice(2);
      setPkgFolder((prev) => {
        if (prev.has(pkgKey) === want) return prev;
        const next = new Set(prev);
        if (want) next.add(pkgKey);
        else next.delete(pkgKey);
        return next;
      });
      if (want) ensureDir(row.path);
      return;
    }
    if (row.kind === 'dir') {
      setSubOpen((prev) => {
        if (prev.has(row.path) === want) return prev;
        const next = new Set(prev);
        if (want) next.add(row.path);
        else next.delete(row.path);
        return next;
      });
      if (want) ensureDir(row.path);
    }
  };

  /**
   * 树容器的按键接管（WS-11）。
   *
   * 两道"不抢"的闸：① 事件源是行内编辑输入框 ⇒ 一个字都不碰（Enter/Esc 是它的）；
   * ② 判据表以外的键一律 `noop`（白名单），既不 preventDefault 也不 stopPropagation ⇒
   * Monaco、标签栏、宿主键位都在这套判据之外。命中了的键才 `stopPropagation`——
   * 全局键位注册表也认 Ctrl+A / Delete 这类组合，不拦就会一次按键做两件事。
   */
  const handleTreeKey = (e: ReactKeyboardEvent<HTMLUListElement>): void => {
    const src = e.target as HTMLElement | null;
    if (src !== null && src.closest('input') !== null) return;
    const cmd = planTreeKey(treeKeyEventOf(e), tree, focusIndex);
    if (cmd.type === 'noop') return;
    e.preventDefault();
    e.stopPropagation();
    const row = 'index' in cmd ? rowAt(tree, cmd.index) : undefined;
    switch (cmd.type) {
      case 'focus':
        moveFocus(cmd.index, cmd.extend);
        break;
      case 'expand':
        if (row !== undefined) setOpenRow(row, true);
        break;
      case 'collapse':
        if (row !== undefined) setOpenRow(row, false);
        break;
      case 'toggle':
        if (row !== undefined) setOpenRow(row, !row.open);
        break;
      case 'open':
        if (row !== undefined && row.path !== '') {
          anchorIdx.current = cmd.index;
          setFocusTid(row.id);
          setSelected([row.path]);
          onOpenFile(row.path);
        }
        break;
      case 'rename':
        if (row !== undefined && row.path !== '') beginRename(row.path, rowIsDir(tree, cmd.index));
        break;
      case 'delete':
        // Delete / Backspace：焦点行没被勾选就只删它，否则删整批（接线与宾语判据住 `requestDelete`）
        if (row !== undefined && row.path !== '') requestDelete(row.path);
        break;
      case 'selectAll': {
        /**
         * 全选 = **整个行模型里所有可勾选的行**，不是"眼前那一屏"（WS-12 欠账批改口径）。
         *
         * 改前收的是 `rangePaths(tree, range.start, range.end - 1)`。那是 WS-11 时代的口径——
         * 当时"窗口外的行"压根不存在，行模型就是 DOM。虚拟化之后两头都变了：
         * ① 真语料 2,689 行的模型里，窗口只覆盖三十几行 ⇒ 按一次全选只收 30 枚，
         *    这句"全选"就是说谎（改前真壳实测：滚到深处按 Ctrl+A 收 21 枚）；
         * ② WS-13 起全选集直接喂给复制 / 剪切 / **删除**（`clipSources` 读的就是这份多选集），
         *    "全选只删到眼前那一屏"比读起来别扭危险得多。
         *
         * 被裁掉的行本来就不在 DOM 里，勾选态由 `file-tree-multi-selection` 那份集合自己维持
         * ⇒ 滚回来时 `FileRows` 按同一判据点亮，不需要它们此刻挂着。回执那句必须报**总数**
         * （确认框那侧 `file-delete-plan` 的 `DELETE_LIST_LIMIT` 已经会如实说"另有 K 项没列出"，
         * 这一句不许只说"已全选"）；一棵没有可勾选文件的树也要说出来，不许静默。
         */
        const all = allSelectablePaths(tree);
        setSelected(all);
        note(
          all.length === 0
            ? '这一棵树里现在没有可勾选的文件行（还没展开，或展开的几组里没有口上文件）'
            : `已全选：这一棵树里 ${all.length} 份口上文件都进了勾选集（复制 / 剪切 / 删除都按这一批走）`,
        );
        break;
      }
      /* ---- WS-13 剪贴板家族（宾语与落点全部现读：多选集 → 焦点行） ---- */
      case 'copy':
        runClipOp('copy');
        break;
      case 'cut':
        runClipOp('cut');
        break;
      case 'paste':
        runClipOp('paste');
        break;
      case 'duplicate':
        runClipOp('duplicate');
        break;
    }
  };

  /**
   * 行上的点击（容器冒泡侧；WS-11 的鼠标腿）。
   *
   * 行组件自己只处理 Ctrl 勾选与纯单击打开，**Shift 那一支被它们明确让开**（不 preventDefault
   * 就会把连选做成打开）。这里补齐：焦点带到被点的那一行，并按 Shift 做区间连选。
   */
  const handleTreeClick = (e: ReactMouseEvent<HTMLUListElement>): void => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[role="treeitem"]') ?? null;
    if (el === null) return;
    const tid = el.dataset.tid;
    if (tid === undefined) return;
    const index = indexOfId(tree, tid);
    if (index < 0) return;
    const plan2 = planRowClick({ shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey }, index);
    if (plan2.type === 'none') return;
    setFocusTid(tid);
    if (plan2.type === 'range') {
      const from = anchorIdx.current >= 0 ? anchorIdx.current : focusIndex;
      setSelected(rangePaths(tree, from, index));
      // 连选之后焦点也在被点的那一行上（浏览器会把焦点留在被点的按钮上，键盘接着走就行）
      pendingFocus.current = tid;
      return;
    }
    anchorIdx.current = index;
  };

  /** 滚动现场（虚拟化的唯一输入；同一档位不重排渲染） */
  const handleTreeScroll = (e: ReactUIEvent<HTMLUListElement>): void => {
    const body = e.currentTarget;
    const top = body.scrollTop;
    const h = body.clientHeight;
    setScroll((prev) => (prev.top === top && prev.h === h ? prev : { top, h }));
  };

  /** 平铺 ERB 行的行内重命名（FileRows 是无知组件：编辑节点在这里造好塞进去；
   *  PS-16 useMemo ⇒ 非编辑期恒为 null 同一引用，不惊动 FileRows 的 memo） */
  const fileEdit = useMemo(() => {
    if (!(edit && edit.mode === 'rename' && !edit.isDir)) return null;
    return {
      path: edit.path,
      node: (
        <EditRow
          value={editValue}
          placeholder="新名称"
          onChange={setEditValue}
          onCommit={commitEdit}
          onCancel={cancelEdit}
        />
      ),
    };
  }, [edit, editValue, commitEdit, cancelEdit]);

  if (!index && snapPaths === null) {
    // 索引未就绪且快照未到：占位自解释。
    // 没有 walkDir（纯浏览器宿主 ⇒ 根本没有先手快照）或快照读盘失败 ⇒ 退回旧文案，
    // 不能对着人说"正在读取口上目录"而其实什么都没读。
    const text = walkDir && !walkFailed ? '正在读取口上目录…' : '索引中…';
    return (
      <div className="tree-loading">
        {text}
        {/* 冷开骨架（VIS-34）：一句话下面垫 7 行 shimmer。`.tree-loading::before`
            那枚单色环（styles-project 的 H 段）继续在转，这里补的是"大概有多长、快到了"——
            改前冷开只有这一句文字，读数回来时整棵树从空白直接撑满，读起来像卡了一下。
            行组件复用 `ui/overlay-chrome.overlaySkeletonRows`（`.skeleton` 的扫光 +
            `.ov-skeleton-row` 的度量都是既有的，本批只是给它第一个消费方）；
            排布与宽度阶梯在 `file-tree.css`，入场节拍在 `ui/motion-surface.css`。
            ⚠ 状态栏那格索引读数（`.sb-idx`）归 Lane D，这里不伸手。 */}
        {overlaySkeletonRows(TREE_COLD_SKELETON_ROWS)}
      </div>
    );
  }

  return (
    <div
      className="file-tree"
      // 空白区面（1023 覆盖面批）：行元素各自带 `file-tree` 面（`closest` 命中最近的那个），
      // 落在 ul / 状态行 / 内边距上的右键就由这一个接管——菜单走根宿主，不再就地渲染。
      data-context-surface="file-tree-root"
    >
      {/* 文件系统视图不放过滤框：按名过滤要递归走全树，与惰性加载天然打架（没展开的层根本没数据）
          ——与其给一个「看着在、但只滤已展开层」的鬼状态，不如不显示；找文件靠打开文件时的自动定位。 */}
      {view === 'kojo' ? (
        <input
          className="tree-filter"
          placeholder={`过滤 ${groups.length} 个角色目录…`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      ) : null}
      {/* 顶部工具条已撤（用户反馈批）：视图切换 / 添加文件夹 / 展开折叠 / 定位 / 重读六个按钮
          全部退场——能力仍在，1023 批起全部收进「根 / 角色组」右键菜单（空白区另有一条
          命令面板），不再占一条横向按钮带。 */}
      {revealNote ? (
        <p className="tree-reveal-note dim" role="status">
          {revealNote}
          {/* 撤销那颗挂在回执同一行末尾（WS-13 2c）：删除的去路与退路必须在同一句里看得见，
              而不是让人去翻命令面板。台账空了就必须消失——留一颗点了只会说"没有可撤销的"的按钮
              正是铁律 4 禁的那种形状。命令面板那条 `explorer.undoDeleteEntry` 是同一个函数。 */}
          {undoOffer !== null ? (
            <button
              type="button"
              className="ghost tree-undo-delete"
              onClick={() => void runUndoDelete().catch((err: unknown) => noteErr(err, '撤销'))}
            >
              撤销这次删除（{undoOffer} 项）
            </button>
          ) : null}
        </p>
      ) : null}
      {/* WS-11 树的语义根：`role="tree"` + `aria-multiselectable`（可勾选 = 多项可选）。
          `tabIndex=-1` 不是给 Tab 用的，是给"把焦点交给树"用的那条腿——E 车道的命令拿到
          `document.querySelector('.file-tree [role="tree"]')` 之后 `.focus()`，
          下面的 `onFocus` 就把键盘焦点转给当前焦点行（没有焦点行时落到第一行）。
          行本身用 roving tabindex（整棵树只有一个停靠点），判据与接线见上面那两个 layout effect。 */}
      <ul
        className="tree-groups"
        ref={treeBodyRef}
        role="tree"
        aria-multiselectable="true"
        tabIndex={-1}
        onKeyDown={handleTreeKey}
        onClick={handleTreeClick}
        onScroll={handleTreeScroll}
        // WS-13 2b：树内拖拽搬运。事件全部**在容器上委托**（与点击 / 键盘同一条腿）：
        // 行组件是 memo 过的无知组件，给它们加拖拽回调就是给每一行挂一位"每帧可能换引用"的 prop。
        onDragStart={handleTreeDragStart}
        onDragOver={handleTreeDragOver}
        onDragLeave={handleTreeDragLeave}
        onDrop={handleTreeDrop}
        onDragEnd={handleTreeDragEnd}
        onFocus={(e) => {
          if (e.target !== e.currentTarget) return;
          focusRovingRow();
        }}
      >
        {view === 'fs' ? (
          // 文件系统视图（B5/D1）：单根 = project.rootDir 第一层直接铺开（原形态，零扰动）；
          // 有附加根 = 每根一个可折叠分组头并列（复用 subOpen 折叠 + dirCache 惰性列举，
          // 展开哪层取哪层）。内容行复用 DirRows（惰性加载 / 二进制标记 / gloss / B1 右键
          // 菜单全在）；失败走 DirRows 既有 error 态（需要桌面壳权限），绝不点了没反应。
          multiRootFs ? (
            fsRoots.map((root) => {
              const isOpen = subOpen.has(root);
              const isProjectRoot = root === project.rootDir;
              // 可写态：工作区模型在场取角色判据（`folder.writable`），缺席才按 io 现判；
              // 判定抛错按只读显示——"说不出可写"绝不能亮成可写。
              const rootFolder = folders.find((f) => pkey(f.path) === pkey(root));
              const writableRoot = !isProjectRoot && (rootFolder !== undefined ? rootFolder.writable : rootWritableOf(io, root));
              /**
               * 只有**会话附加根**可以移除（WS-08）。作者作品目录 / 口上域 / 存档都是
               * 项目事实，移掉就是在 UI 上撒谎（盘上还在、下次开项目又回来）。
               * 模型缺席时 fs 根 = 项目根 ∪ `extraRoots` ⇒ 非项目根就是附加根。
               */
              const removable =
                !isProjectRoot &&
                (rootFolder !== undefined
                  ? rootFolder.role === 'extra'
                  : (extraRoots ?? []).some((r) => pkey(r) === pkey(root)));
              return (
                <li key={root} className="tree-group" data-open={isOpen ? '1' : '0'} role="none">
                  {/* 组头行（WS-08）：折叠按钮 + 只读/可写标签 + 移除入口。
                      行尾按钮不能嵌进折叠按钮（button 里套 button 是非法结构），故加这层行容器。
                      WS-04 合并后可写态优先取工作区模型（角色判据）；模型缺席才按 io 现判。 */}
                  <div className="tree-group-head">
                    <button
                      className="tree-group-btn"
                      role="treeitem"
                      aria-level={1}
                      aria-expanded={isOpen}
                      aria-selected={false}
                      tabIndex={-1}
                      data-tid={root}
                      title={`${root}${fsRootRoleOf(root) ? `（${fsRootRoleOf(root)}）` : ''}`}
                      onClick={() => {
                        captureAnchorRef.current();
                        toggleSub(root);
                      }}
                    >
                      <span className="caret">
                        <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} />
                      </span>
                      <span className="group-label">{middleEllipsis(baseName(root), TREE_LABEL_MAX)}</span>
                    </button>
                    {isProjectRoot ? null : (
                      <span
                        className={writableRoot ? 'tree-root-tag is-writable' : 'tree-root-tag'}
                        title={
                          writableRoot
                            ? rootFolder?.role === 'author'
                              ? '你的作品目录：可直接保存'
                              : '这个根在写允许域内，可以直接保存'
                            : rootFolder?.role === 'extra'
                              ? '附加根默认只读：写仍走项目授权域'
                              : '项目内容默认只读：写仍走项目授权域'
                        }
                      >
                        {writableRoot ? '可写' : '只读'}
                      </span>
                    )}
                    {!removable || onRemoveExtraRoot === undefined ? null : (
                      <button
                        className="tree-root-remove"
                        title={`从工作区移除：${root}`}
                        aria-label={`从工作区移除 ${baseName(root)}`}
                        onClick={() => onRemoveExtraRoot(root)}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    )}
                  </div>
                  {/* 折叠容器（VIS-31）：`ul` 仍是本 `li` 的直接子元素——导轨那三条
                      `.tree-group > .tree-files*` 选择器因此一个字没动 */}
                  <TreeFoldBody
                    open={isOpen}
                    body={() => (
                      <ul className="tree-files">
                        {dirCache.has(root) ? (
                          <DirRows {...dirRowsBase} dir={root} depth={0} skip={EMPTY_SKIP} levelBase={2} />
                        ) : (
                          <li className="tree-note">读取目录…</li>
                        )}
                      </ul>
                    )}
                  />
                </li>
              );
            })
          ) : dirCache.has(project.rootDir) ? (
            <DirRows {...dirRowsBase} dir={project.rootDir} depth={0} skip={EMPTY_SKIP} />
          ) : (
            <li className="tree-note">读取目录…</li>
          )
        ) : (
          <>
        {visible.map((g, groupIdx) => {
          const isOpen = opened.has(g.label) || deferredFilter.length > 0;
          const groupTid = groupRowId(g.label);
          /**
           * 这一组的挂载判决（WS-12 欠账批：组头与包行也进视口裁切）。
           *
           * 三层裁点各自一条 `sliceSpan` / `sliceBlock`，口径互不重叠：
           * - **整组**在窗口外 ⇒ 一条等高占位替掉整个 `li.tree-group`（组头 + 里面的包 +
           *   两级 `<ul>` 连同它们的下边距全都在 `span` 里报掉了）；
           * - 组**相交** ⇒ 组头那一行按行号自己判在不在窗口里（挂载的组也有"头在窗口上方"那格），
           *   里面的每个包段再各自判——整包在外 ⇒ 一条占位替掉整个 `li.tree-package-node`；
           * - 包**相交** ⇒ 平铺 ERB 仍按既有的叶子块 `sliceBlock` 裁（**行底口径**：那档 2px 缝
           *   由还挂在 DOM 里的 `ul.tree-files.nested` 带，占位不许再垫一遍，见 `TreeSpacer` 注释）。
           *
           * `grp === undefined`（模型与渲染同帧不同步的兜底）⇒ 一行都不裁，退回本批之前的形状。
           */
          const grp = tree.groups[groupIdx];
          const gSlice = grp === undefined ? null : sliceSpan(grp.span, tree.rows, range);
          if (gSlice !== null && isCulledSlice(gSlice)) return <TreeSpacer key={g.label} px={cullSpacerPx(gSlice)} />;
          const headerIn = grp === undefined || (grp.start >= range.start && grp.start < range.end);
          return (
            <li key={g.label} className="tree-group" data-open={isOpen ? '1' : '0'} role="none">
              {headerIn ? (
                <button
                  className="tree-group-btn"
                  role="treeitem"
                  aria-level={1}
                  aria-expanded={isOpen}
                  aria-selected={false}
                  tabIndex={-1}
                  data-tid={groupTid}
                  title={`${g.label}（右键查看更多）`}
                  data-drop-dir={g.prefix || undefined}
                  // 行面（1023）：行数据放 DOM，面的 build 从 target 读——不放闭包（多实例安全）
                  data-context-surface="file-tree"
                  data-tree-kind="group"
                  data-tree-label={g.label}
                  data-tree-path={g.prefix}
                  onClick={() => {
                    captureAnchorRef.current();
                    toggleGroup(g.label);
                  }}
                >
                  <span className="caret">
                    <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} />
                  </span>
                  <span className="group-label">{g.label}</span>
                  <span className="group-count">{g.total}</span>
                  <NodeProblemBadge groups={groups} kind="group" nodeKey={g.label} scope="角色目录" />
                </button>
              ) : (
                // 组头滚出窗口：等高占位顶上（22px 那一档就是行模型里这一行的高度）
                <TreeSpacer tag="div" px={TREE_ROW_H} />
              )}
              {/* 折叠容器（VIS-31 · 见 `TreeFoldBody`）：`ul` 仍是本 `li` 的直接子元素，
                  导轨那三条 `.tree-group > .tree-files*` 选择器一个字没动 */}
              <TreeFoldBody
                open={isOpen}
                body={() => (
                <ul className="tree-files" role="group">
                  {g.subs.map((s, subIdx) => {
                    // 本组本次挂载的行区间裁到"这个包的 ERB 列表 / 这段根散文件"这一格
                    const block = tree.blockOf(groupIdx, subIdx);
                    const slice = block === undefined ? null : sliceBlock(block, tree.rows, range);
                    const from = slice === null ? 0 : slice.from - (block?.start ?? 0);
                    const count = slice === null ? renderLimitOf(g, s) : slice.to - slice.from;
                    // 整段（包头 + 真实文件夹层 + ERB 列表 + 那档 ul 缝）都在窗口外 ⇒ 一条占位
                    const sub = grp?.subs[subIdx];
                    const sSlice = sub === undefined ? null : sliceSpan(sub.span, tree.rows, range);
                    if (sSlice !== null && isCulledSlice(sSlice)) {
                      return <TreeSpacer key={s.label === null ? `${g.label}::(根散文件)` : s.label} px={cullSpacerPx(sSlice)} />;
                    }
                    const subHeaderIn = sub === undefined || (sub.headerIdx >= range.start && sub.headerIdx < range.end);
                    // 根散文件（无包目录兜底）：直接平铺在角色组下
                    if (s.label === null) {
                      return (
                        <Fragment key={`${g.label}::(根散文件)`}>
                          <TreeSpacer px={slice?.leadPx ?? 0} />
                          <FileRows
                            files={s.files}
                            from={from}
                            limit={count}
                            level={2}
                            onOpenFile={onOpenFile}
                            edit={fileEdit}
                          />
                          <TreeSpacer px={slice?.trailPx ?? 0} />
                        </Fragment>
                      );
                    }
                    const label = s.label;
                    const pkgKey = packageKey(g.label, label);
                    const pkgDir = pkgDirOf(g, label);
                    const isFolder = pkgFolder.has(pkgKey) && deferredFilter.length === 0;
                    const renamingPkg = edit?.mode === 'rename' && edit.isDir && edit.path === pkgDir;
                    return (
                      <li key={label} className="tree-package-node" role="none">
                        {renamingPkg ? (
                          <EditRow
                            value={editValue}
                            placeholder="新名称"
                            onChange={setEditValue}
                            onCommit={commitEdit}
                            onCancel={cancelEdit}
                          />
                        ) : !subHeaderIn ? (
                          // 包头滚出窗口：等高占位顶上（这一格正在重命名时上面那支优先，输入框不许被裁）
                          <TreeSpacer tag="div" px={TREE_ROW_H} />
                        ) : (
                          <button
                            className="tree-package"
                            role="treeitem"
                            aria-level={2}
                            aria-expanded={isFolder}
                            aria-selected={false}
                            tabIndex={-1}
                            data-tid={packageRowId(pkgKey)}
                            title={pkgDir}
                            data-drop-dir={pkgDir}
                            data-context-surface="file-tree"
                            data-tree-kind="package"
                            data-tree-label={label}
                            data-tree-path={pkgDir}
                            onClick={() => {
                              captureAnchorRef.current();
                              togglePkgFolder(pkgKey, pkgDir);
                            }}
                          >
                            <span className="caret">
                              <Icon name={isFolder ? 'chevron-down' : 'chevron-right'} size={12} />
                            </span>
                            {/* 长包名中段省略（L16）：完整路径已在 title 上，裁的只是显示 */}
                            <span className="tree-package-name">{middleEllipsis(glossOf(s.label), TREE_LABEL_MAX)}</span>
                            <span className="group-count">{s.files.length}</span>
                            <NodeProblemBadge
                              groups={groups}
                              kind="package"
                              nodeKey={pkgKey}
                              scope={`作者包 ${label}`}
                            />
                          </button>
                        )}
                        {/* 追加式：真实文件夹内容在上、ERB 列表原地不动（无动画、不卸载） */}
                        {isFolder ? (
                          <ul className="tree-files nested pkg-real" role="group">
                            <DirRows {...dirRowsBase} dir={pkgDir} depth={0} skip={erbKeysOf(s)} levelBase={3} />
                          </ul>
                        ) : null}
                        <ul className="tree-files nested" role="group">
                          <TreeSpacer px={slice?.leadPx ?? 0} />
                          <FileRows
                            files={s.files}
                            from={from}
                            limit={count}
                            level={3}
                            onOpenFile={onOpenFile}
                            edit={fileEdit}
                          />
                          <TreeSpacer px={slice?.trailPx ?? 0} />
                        </ul>
                      </li>
                    );
                  })}
                </ul>
                )}
              />
            </li>
          );
        })}
        {/* author / extra 根的独立顶层分组（WS-04）：组头标明可写 / 只读，行可点开。
            游戏内文件**不在这里**（角色分组已经列过一遍），剔除在 `groups` 那一格做过。 */}
        {rootGroupsVisible.map(({ folder, key, files, status, hits }, ri) => {
          const isOpen = opened.has(key) || deferredFilter.length > 0;
          const groupIdx = visible.length + ri;
          const block = tree.blockOf(groupIdx, 0);
          const slice = block === undefined ? null : sliceBlock(block, tree.rows, range);
          // 与角色分组同一套三层判决（这一层的"子段"只有那条根散文件，叶子块自己就裁完了）
          const grp = tree.groups[groupIdx];
          const gSlice = grp === undefined ? null : sliceSpan(grp.span, tree.rows, range);
          if (gSlice !== null && isCulledSlice(gSlice)) return <TreeSpacer key={key} px={cullSpacerPx(gSlice)} />;
          const headerIn = grp === undefined || (grp.start >= range.start && grp.start < range.end);
          return (
            <li key={key} className="tree-group tree-root-group" data-open={isOpen ? '1' : '0'} role="none">
              {/* 组头行：折叠按钮 + （仅会话附加根）移除入口。行尾按钮不能嵌进折叠按钮
                  （button 里套 button 是非法结构），故与 fs 视图同用一层行容器。
                  WS-08：移除入口必须住在这里——附加根常落在项目根之内，fs 视图会把它
                  折进项目根头，那条路上根本没有它自己的头行可挂按钮。
                  滚出窗口时整条头行（含那颗移除按钮）换成一条等高占位：域外的行本来就不该看得见摸得着。 */}
              {!headerIn ? (
                <TreeSpacer tag="div" px={TREE_ROW_H} />
              ) : (
              <div className="tree-group-head">
                <button
                  className="tree-group-btn"
                  role="treeitem"
                  aria-level={1}
                  aria-expanded={isOpen}
                  aria-selected={false}
                  tabIndex={-1}
                  data-tid={groupRowId(key)}
                  title={`${folder.path}（${folder.writable ? '可写' : '只读'}）`}
                  data-drop-dir={folder.path}
                  data-context-surface="file-tree"
                  data-tree-kind="group"
                  data-tree-label={folder.label}
                  data-tree-path={folder.path}
                  onClick={() => {
                    captureAnchorRef.current();
                    toggleGroup(key);
                  }}
                >
                  <span className="caret">
                    <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} />
                  </span>
                  <span className="group-label">{middleEllipsis(folder.label, TREE_LABEL_MAX)}</span>
                  <span className="dim tree-root-role">{folder.writable ? '可写' : '只读'}</span>
                  <span className="group-count">{files.length}</span>
                </button>
                {folder.role !== 'extra' || onRemoveExtraRoot === undefined ? null : (
                  <button
                    className="tree-root-remove"
                    title={`从工作区移除：${folder.path}`}
                    aria-label={`从工作区移除 ${folder.label}`}
                    onClick={() => onRemoveExtraRoot(folder.path)}
                  >
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>
              )}
              <TreeFoldBody
                open={isOpen}
                body={() => (
                  <ul className="tree-files" role="group">
                    {status === 'error' ? (
                      <li className="tree-note" role="presentation">这个文件夹读不到（可能已移动，或当前环境没有桌面壳权限）</li>
                    ) : files.length === 0 ? (
                      <li className="tree-note" role="presentation">
                        {status === 'loading' ? '读取文件夹…' : '这个文件夹里还没有 ERB 方言文件'}
                      </li>
                    ) : (
                      <>
                        <TreeSpacer px={slice?.leadPx ?? 0} />
                        <FileRows
                          files={hits}
                          from={slice === null ? 0 : slice.from - (block?.start ?? 0)}
                          limit={slice === null ? hits.length : slice.to - slice.from}
                          level={2}
                          onOpenFile={onOpenFile}
                          edit={fileEdit}
                        />
                        <TreeSpacer px={slice?.trailPx ?? 0} />
                      </>
                    )}
                  </ul>
                )}
              />
            </li>
          );
        })}
        {plan && plan.hidden > 0 ? (
          <li className="tree-filter-more" key="__filter_window_more">
            <button className="ghost small" onClick={growFilterWindow}>
              命中 {plan.matched} 个文件，本帧只渲染 {plan.rendered} 个（其余 {plan.hidden} 个未挂载）——继续显示下一批
            </button>
          </li>
        ) : null}
          </>
        )}
      </ul>
      {plan && plan.hidden > 0 ? (
        <p className="tree-reveal-note dim" role="status">
          过滤强制全展开 ⇒ 只显示前 {plan.rendered} / {plan.matched} 个命中（点树尾按钮继续加载，或把过滤词写长一点）
        </p>
      ) : null}
      {/* WS-13 现场问句（同名条目四选项 / 脏闸二选项）：portal 挂 body——树容器带
          `contain: layout paint`，fixed 遮罩就地渲染会被钉成面板大小（与右键菜单走根宿主同因） */}
      {fileOpsAsk === null ? null : <FileOpsAskDialog ask={fileOpsAsk} />}
      {/* 就地渲染的 FileTreeContextMenu 自 1023 批起不再挂在这里：菜单统一由根宿主
          （`context-menu-host.tsx` 的固定层）渲染，浮层裁剪与遮挡一次收口。那个组件
          保留在 file-tree-menu.tsx 作兜底实现（根宿主缺席的宿主可自渲染）。 */}
    </div>
  );
});
