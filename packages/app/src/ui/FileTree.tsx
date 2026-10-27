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

import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
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
  deleteConfirmText,
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
import { baseName, buildFileGroups, dirsToRelist, kojoOwners, middleEllipsis, rowKeyOf, TREE_LABEL_MAX } from './file-tree-model';
import { createEntryIfAbsent } from './file-tree-create';
import { browsableRootsOf, type WorkspaceFolder } from './workspace-folders';
import { filterRenderPlan, nextFilterWindow } from './file-tree-filter-window';
import { EditRow, FileRows } from './file-tree-rows';
import { TreeProbMark } from './file-tree-row';
import { DirRows } from './file-tree-dir-rows';
import { getActivePath, setActivePath, subscribeActivePath } from './file-tree-selection';
import { clearSelected, getSelectedPaths } from './file-tree-multi-selection';
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
  const onFilesGone = useLatestCallback(rest.onFilesGone);
  const onAddFolder = useLatestCallback(rest.onAddFolder);
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
      onFilesGone={onFilesGone}
      onAddFolder={onAddFolder}
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
 * 文件树本体（state + 异步 IO + 事件接线 + 渲染）。
 *
 * 与外壳同一份实现，只差一件事：**不再收 `activeFile`**（见 `FileTree` 的注释）。
 */
const FileTreeBody = memo(function FileTreeBody({ project, index, onOpenFile, listDir, walkDir, onImportPackage, io, onRevealInExplorer, guardFileOp, onFilesGone, refreshNonce, gloss, extraRoots, onAddFolder, onCompareFiles, workspaceFolders, onDiskEntriesChanged }: FileTreeBodyProps): ReactElement {
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

  /** 包目录绝对路径（index 路径为全路径，直接拼接包目录名） */
  const pkgDirOf = (g: Group, subLabel: string): string =>
    `${g.prefix.replace(/[\\/]+$/, '')}/${subLabel}`;

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
      for (const [dir, state] of updates) next.set(dir, state);
      if (next.size <= DIR_CACHE_MAX) return next;
      for (const key of [...next.keys()]) {
        if (next.size <= DIR_CACHE_MAX) break;
        if (!subOpen.has(key)) next.delete(key);
      }
      return next;
    });
  }, [subOpen]);

  /**
   * 一批目录一起列、**一次落地**（PS-6）：外部改动重列走的就是这条。
   *
   * 序号闸照旧逐目录认领先后（迟到的那份不认领）；某一份失败只把**那一个目录**标成
   * error，其余照收——一颗失败不许把整批拖成空白（也不静默：DirRows 会画失败行）。
   */
  const fetchDirs = useCallback((dirs: readonly string[]): void => {
    if (!listDir || dirs.length === 0) return;
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
   */
  const applyReveal = (list: readonly Group[], r: RevealResult): void => {
    if (r.mode === 'expand') {
      for (const g of list) {
        for (const s of g.subs) {
          if (s.label === null) continue;
          if (!pkgFolder.has(packageKey(g.label, s.label))) ensureDir(pkgDirOf(g, s.label));
        }
      }
    } else {
      setSubOpen(new Set());
    }
    setOpened(r.openedGroups);
    setPkgFolder(r.openedPackages);
    setRevealNote(r.feedback);
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
  const relistShown = (): number => {
    const dirs = new Set(dirsToRelist(subOpen, pkgFolder, collectPackages(groups)));
    // 文件系统视图（B5/D1）：根层全部根一并重列（多根时折叠着的也会被取到顶层——手动
    // 重读是显式动作，宁可多取一层也不留"按了刷新还有根没重列"的疑心）
    if (view === 'fs') for (const r of fsRoots) dirs.add(r);
    // 一次失效 = 一次请求批 = **一帧**（旧实现每份目录响应各排一帧，K 层展开就是 K 帧全树）
    fetchDirs([...dirs]);
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

  /** 删除（文件/目录同一入口）：守门 → 量级确认 → 落地 → 只重列受影响目录 */
  const doDelete = (path: string, isDir: boolean): void => {
    const blocked = guardFileOp?.([path]) ?? null;
    if (blocked) {
      note(blocked);
      return;
    }
    if (io && !io.isWritable(path)) {
      note('这个位置在只读范围内，不能删除。要先在「只读」徽章那里批准写权限。');
      return;
    }
    const proceed = (fileCount?: number): void => {
      // 递归删除是把大刀：文案必须让用户看清刀多大（N 现算失败退化为无数字，警示语保留）
      if (!window.confirm(deleteConfirmText({ name: baseName(path), isDir, fileCount }))) return;
      const doing = isDir ? io!.removeDir(path) : io!.removeFile(path);
      void doing.then(
        () => {
          refetchDirs([parentDir(path)]);
          if (isDir) pruneCacheUnder(path);
          onFilesGone?.([path], []);
          note(`已删除${isDir ? '文件夹' : '文件'}「${baseName(path)}」`);
        },
        (err: unknown) => noteErr(err, '删除'),
      );
    };
    if (isDir && walkDir) {
      // N 现算：失败（浏览器壳无 io / 目录不可读）退化为无数字文案，不阻断
      void walkDir(path, { includeFiles: true, includeDirs: false })
        .then((entries) => proceed(entries.filter((x) => !x.isDirectory).length))
        .catch(() => proceed(undefined));
    } else {
      proceed(undefined);
    }
  };

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
        if (path) doDelete(path, scope.kind === 'dir' || scope.kind === 'package');
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
    }
  };

  /**
   * 菜单能力位（铁律 4：没有通道的项整项不显示，不许灰着不说话）。
   *
   * 只有**真实存在**的通道才设位：命令面板 / 文件历史看命令注册表，重列看 `listDir`，
   * 添加文件夹看宿主回调，剪贴板看 `navigator.clipboard`。
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
    // DOM 提交后再滚：两拍 rAF 保证新展开的行已挂载
    scrollLocate(plan.targetPath);
    locateTarget.current = null;
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

  /**
   * 现场变了就再试一次（目录列举回来 / 分组换了 / 视图切了 / 过滤词落定）。
   * 读的是 ref，没有待办就立刻返回——这条 effect 不会自己触发渲染。
   */
  useEffect(() => {
    if (locateTarget.current !== null) runLocateRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, deferredFilter, view, dirCache]);

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
        </p>
      ) : null}
      <ul className="tree-groups" ref={treeBodyRef}>
        {view === 'fs' ? (
          // 文件系统视图（B5/D1）：单根 = project.rootDir 第一层直接铺开（原形态，零扰动）；
          // 有附加根 = 每根一个可折叠分组头并列（复用 subOpen 折叠 + dirCache 惰性列举，
          // 展开哪层取哪层）。内容行复用 DirRows（惰性加载 / 二进制标记 / gloss / B1 右键
          // 菜单全在）；失败走 DirRows 既有 error 态（需要桌面壳权限），绝不点了没反应。
          multiRootFs ? (
            fsRoots.map((root) => {
              const isOpen = subOpen.has(root);
              return (
                <li key={root} className="tree-group" data-open={isOpen ? '1' : '0'}>
                  <button
                    className="tree-group-btn"
                    title={`${root}${fsRootRoleOf(root) ? `（${fsRootRoleOf(root)}）` : ''}`}
                    onClick={() => toggleSub(root)}
                  >
                    <span className="caret">
                      <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} />
                    </span>
                    <span className="group-label">{middleEllipsis(baseName(root), TREE_LABEL_MAX)}</span>
                  </button>
                  {/* 折叠容器（VIS-31）：`ul` 仍是本 `li` 的直接子元素——导轨那三条
                      `.tree-group > .tree-files*` 选择器因此一个字没动 */}
                  <TreeFoldBody
                    open={isOpen}
                    body={() => (
                      <ul className="tree-files">
                        {dirCache.has(root) ? (
                          <DirRows {...dirRowsBase} dir={root} depth={0} skip={EMPTY_SKIP} />
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
        {visible.map((g) => {
          const isOpen = opened.has(g.label) || deferredFilter.length > 0;
          return (
            <li key={g.label} className="tree-group" data-open={isOpen ? '1' : '0'}>
              <button
                className="tree-group-btn"
                title={`${g.label}（右键查看更多）`}
                data-drop-dir={g.prefix || undefined}
                // 行面（1023）：行数据放 DOM，面的 build 从 target 读——不放闭包（多实例安全）
                data-context-surface="file-tree"
                data-tree-kind="group"
                data-tree-label={g.label}
                data-tree-path={g.prefix}
                onClick={() => toggleGroup(g.label)}
              >
                <span className="caret">
                  <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} />
                </span>
                <span className="group-label">{g.label}</span>
                <span className="group-count">{g.total}</span>
                <NodeProblemBadge groups={groups} kind="group" nodeKey={g.label} scope="角色目录" />
              </button>
              {/* 折叠容器（VIS-31 · 见 `TreeFoldBody`）：`ul` 仍是本 `li` 的直接子元素，
                  导轨那三条 `.tree-group > .tree-files*` 选择器一个字没动 */}
              <TreeFoldBody
                open={isOpen}
                body={() => (
                <ul className="tree-files">
                  {g.subs.map((s) => {
                    // 根散文件（无包目录兜底）：直接平铺在角色组下
                    if (s.label === null) {
                      return (
                        <FileRows
                          key={`${g.label}::(根散文件)`}
                          files={s.files}
                          limit={renderLimitOf(g, s)}
                          onOpenFile={onOpenFile}
                          edit={fileEdit}
                        />
                      );
                    }
                    const label = s.label;
                    const pkgKey = packageKey(g.label, label);
                    const pkgDir = pkgDirOf(g, label);
                    const isFolder = pkgFolder.has(pkgKey) && deferredFilter.length === 0;
                    const renamingPkg = edit?.mode === 'rename' && edit.isDir && edit.path === pkgDir;
                    return (
                      <li key={label} className="tree-package-node">
                        {renamingPkg ? (
                          <EditRow
                            value={editValue}
                            placeholder="新名称"
                            onChange={setEditValue}
                            onCommit={commitEdit}
                            onCancel={cancelEdit}
                          />
                        ) : (
                          <button
                            className="tree-package"
                            title={pkgDir}
                            data-drop-dir={pkgDir}
                            data-context-surface="file-tree"
                            data-tree-kind="package"
                            data-tree-label={label}
                            data-tree-path={pkgDir}
                            onClick={() => togglePkgFolder(pkgKey, pkgDir)}
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
                          <ul className="tree-files nested pkg-real">
                            <DirRows {...dirRowsBase} dir={pkgDir} depth={0} skip={erbKeysOf(s)} />
                          </ul>
                        ) : null}
                        <ul className="tree-files nested">
                          <FileRows
                            files={s.files}
                            limit={renderLimitOf(g, s)}
                            onOpenFile={onOpenFile}
                            edit={fileEdit}
                          />
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
        {rootGroupsVisible.map(({ folder, key, files, status, hits }) => {
          const isOpen = opened.has(key) || deferredFilter.length > 0;
          return (
            <li key={key} className="tree-group tree-root-group" data-open={isOpen ? '1' : '0'}>
              <button
                className="tree-group-btn"
                title={`${folder.path}（${folder.writable ? '可写' : '只读'}）`}
                data-drop-dir={folder.path}
                data-context-surface="file-tree"
                data-tree-kind="group"
                data-tree-label={folder.label}
                data-tree-path={folder.path}
                onClick={() => toggleGroup(key)}
              >
                <span className="caret">
                  <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} />
                </span>
                <span className="group-label">{middleEllipsis(folder.label, TREE_LABEL_MAX)}</span>
                <span className="dim tree-root-role">{folder.writable ? '可写' : '只读'}</span>
                <span className="group-count">{files.length}</span>
              </button>
              <TreeFoldBody
                open={isOpen}
                body={() => (
                  <ul className="tree-files">
                    {status === 'error' ? (
                      <li className="tree-note">这个文件夹读不到（可能已移动，或当前环境没有桌面壳权限）</li>
                    ) : files.length === 0 ? (
                      <li className="tree-note">
                        {status === 'loading' ? '读取文件夹…' : '这个文件夹里还没有 ERB 方言文件'}
                      </li>
                    ) : (
                      <FileRows files={hits} limit={hits.length} onOpenFile={onOpenFile} edit={fileEdit} />
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
      {/* 就地渲染的 FileTreeContextMenu 自 1023 批起不再挂在这里：菜单统一由根宿主
          （`context-menu-host.tsx` 的固定层）渲染，浮层裁剪与遮挡一次收口。那个组件
          保留在 file-tree-menu.tsx 作兜底实现（根宿主缺席的宿主可自渲染）。 */}
    </div>
  );
});
