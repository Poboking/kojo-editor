import { useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import type { DirEntry, ErbIndex, FileIO, GameProject, WalkOptions } from '@kojo/plugin-api';
import { isErbDialectPath } from '@kojo/plugin-api';
import {
  packageKey,
  revealMenuLabel,
  toggleReveal,
  type RevealGroup,
  type RevealResult,
} from './file-tree-reveal';
import {
  deleteConfirmText,
  fsLocatePlanOfRoots,
  isUnderPath,
  joinPath,
  locatePlanOf,
  menuItemsFor,
  parentDir,
  relativeToRoot,
  validateEntryName,
  type LocatePlan,
  type MenuCapability,
  type MenuItemId,
} from './file-tree-ops';
import { Icon } from './icons';

interface Props {
  project: GameProject;
  index: ErbIndex | null;
  activeFile: string | null;
  onOpenFile: (path: string) => void;
  /** 目录列举（真实文件夹视图用；宿主注入内核 io，浏览器环境可能抛错——调用侧已兜底） */
  listDir?: (path: string) => Promise<DirEntry[]>;
  /**
   * 递归列举（冷开快照用；宿主注入内核 io — 与 erb-parser 的索引 walk 同一条桥）。
   *
   * 动机（2026-10-16 树即时批）：索引要 7.5s 才就绪，这期间左栏全空。冷开时对
   * `project.kojoPaths` 各做**一次** `walkDir` 就能拿全口上域的方言文件清单（角色归属
   * 来自 `charaIndex`，打开项目即已可用），按同一分组结构先出树；索引就绪后按同一
   * 构建函数切回索引路径（同一文件集 ⇒ 不重排）。缺省 → 退回旧行为（等索引）。
   */
  walkDir?: (path: string, opts?: WalkOptions) => Promise<DirEntry[]>;
  /** 导入作者包为工作区项目（口上项目批 P-F；缺省 → 不显示导入菜单项） */
  onImportPackage?: (pkg: { dir: string; label: string }) => void;
  /**
   * 内核文件 IO（文件树编辑批 B1/B2）：新建 / 重命名 / 删除的落地面。
   * 缺省 → 这三类菜单项**整组不显示**（没有能力的动作灰着不说话 = 违反铁律 4）。
   * 写允许域由 io.isWritable 预检——不可行的位置给一句人话，绝不绕闸也绝不静默失败。
   */
  io?: FileIO;
  /**
   * 「在资源管理器中显示」（B3 的 UI 侧预留；桌面壳才有这能力）。
   * 缺省 → 菜单项不显示（浏览器壳没有这能力，灰着不说话 = 违反铁律 4）。
   */
  onRevealInExplorer?: (path: string) => void;
  /**
   * 脏标签守门（删除/重命名前先问宿主）：返回第一份拦下操作的**人话理由**；null = 放行。
   *
   * 落法理由（welcome 批先例）：openTabs / dirtyPaths 的状态单源在宿主（App），
   * 所以"这份文件现在能不能动"也由宿主裁决——树只发意图，不持有标签状态的影子副本。
   * 宿主同时拦「精确命中」与「打开中的脏文件位于被删/改名目录之下」两种形态。
   */
  guardFileOp?: (paths: readonly string[]) => string | null;
  /**
   * 盘上操作成功后通知宿主收尾：关掉被删文件的干净标签、改写被重命名文件的标签路径。
   * 与 guardFileOp 同理落在宿主——标签列表是它的 state，树侧只报告事实（谁没了/搬去哪）。
   */
  onFilesGone?: (deleted: readonly string[], renamed: ReadonlyArray<{ from: string; to: string }>) => void;
  /**
   * 目录缓存失效信号（HK-5，2026-10-13）：宿主在口上域发生外部改动时递增。
   * 值本身没有意义，**变化**才是事件——用 nonce 而不是布尔，是因为连续两次改动
   * 都必须各刷新一次（布尔会在第二次被 React 合并掉）。
   */
  refreshNonce?: number;
  /**
   * 名称显示对照（缺省 = 原样）：消费方据日文→中文词典把作者包目录名 / 目录名 / 文件名
   * 渲染为「日文（中文）」。**只改显示文本**——title / path / key 一律用原名。
   */
  gloss?: (name: string) => string;
  /**
   * 会话级附加根（D1，对标 VSCode Add Folder to Workspace）：fs 视图根层与项目根
   * 并列显示的额外根。缺省 → fs 视图维持单根（零视觉扰动）；非空 → 根层每根一个
   * 分组头（复用 subOpen 折叠 + dirCache 惰性列举）。
   */
  extraRoots?: readonly string[];
  /** 「添加文件夹…」入口（对话框与去重都在宿主 App；缺省 → 按钮不显示） */
  onAddFolder?: () => void;
}

/** 作者包子目录（角色目录下的一层子文件夹 = 作者版本号包目录） */
export interface PackageGroup {
  /** 包目录名；null = 直接挂在角色目录根下的散文件（如 159 先代 无包目录） */
  label: string | null;
  /** 包内 ERB 面文件（来自索引） */
  files: string[];
}

export interface Group {
  label: string;
  /** 角色目录前缀（计算包目录绝对路径用） */
  prefix: string;
  subs: PackageGroup[];
  total: number;
}

type DirState = DirEntry[] | 'loading' | 'error';

/** 压缩包 / 图片等二进制附件：只展示不可打开（打开只会给 Monaco 喂一堆乱码） */
const BINARY_EXT = /\.(7z|zip|rar|png|jpe?g|gif|bmp|ico|webp|mp3|ogg|wav|ttf|otf|dll|exe)$/i;

/** 路径归一键（Windows 大小写不敏感；同一文件在两处只出现一次） */
function pkey(p: string): string {
  return p.replace(/[\\/]+/g, '/').toLowerCase();
}

/** ERB 方言扩展名：口径直接问契约层的单一真源（`plugin-api/erb-ext`，FT-2 收口），
 *  不再靠注释与人肉对齐。嵌套目录里的方言文件走普通文件行样式，非方言才标「不在索引内」。
 *  与 erb-parser 的索引 walk 共用同一条谓词 ⇒ "标了在索引里"与"真在索引里"不可能再分裂。 */
function erbExt(name: string): boolean {
  return isErbDialectPath(name);
}

/**
 * 真实文件夹视图某一层该显示哪些条目（纯函数，可单测）。
 *
 * `skip`（包层已平铺的 ERB 路径）**只在 depth === 0 生效**：那里与平铺列表同级，
 * 不去重就是同一层级出现两遍同一个文件。嵌套目录必须原样返回——它们住在另一层，
 * 不是重复；若一并去重，装了 10 个面文件的子目录会被渲染成空目录，
 * **等于对文件系统撒谎**（本函数就是为锁死这条不变量而存在：
 * 实现在 `灵梦-少女之梦/没写的` 上踩过一次）。
 */
export function visibleEntries(
  entries: readonly DirEntry[],
  depth: number,
  skip: ReadonlySet<string>,
): DirEntry[] {
  return depth === 0 ? entries.filter((d) => !skip.has(pkey(d.path))) : [...entries];
}

/**
 * 失效时该重列哪些目录（纯函数，可单测；HK-5）。
 *
 * = **正在显示的**：展开着的子目录 ∪ 已点开「真实文件夹视图」的包目录。
 * 折叠着的不重列——等下次展开惰性取，为看不见的东西打一圈 `listDir` 是纯浪费；
 * 展开态本身一概不动（那是作者的现场，不是缓存的一部分）。
 */
export function dirsToRelist(
  subOpen: ReadonlySet<string>,
  openPkgKeys: ReadonlySet<string>,
  packages: readonly { key: string; dir: string }[],
): string[] {
  const out = new Set<string>(subOpen);
  for (const p of packages) if (openPkgKeys.has(p.key)) out.add(p.dir);
  return [...out];
}

/** 右键菜单作用域：单个角色 / 整棵树根 / 单个作者包（导入口径，P-F）/ 单个目录 / 单个文件 */
type MenuScope =
  | { kind: 'group'; group: Group }
  | { kind: 'root' }
  | { kind: 'package'; dir: string; label: string }
  | { kind: 'dir'; path: string }
  | { kind: 'file'; path: string };

/**
 * 行内编辑态（B1/B2）：重命名与新建共用一个输入框。
 *
 * - `create`：在 `dir` 里新建；dir 的列举必须已展开（调用侧先开层），输入行插在该层最上；
 * - `rename`：把 path 那一行改画成输入框（同 VSCode；Esc 取消 / Enter 确认 / 失焦取消）。
 */
type EditState =
  | { mode: 'create'; kind: 'file' | 'dir'; dir: string }
  | { mode: 'rename'; path: string; isDir: boolean };

/** 行内编辑输入框（模块级 ⇒ SSR 单测可用；受控值在宿主，Esc/Enter/失焦三个出口都从这里出） */
function EditRow(props: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}): ReactElement {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // 同 VSCode：出现即聚焦并全选（输入新名直接覆盖旧名）
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="tree-edit-input"
      value={props.value}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          props.onCommit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          props.onCancel();
        }
      }}
      onBlur={props.onCancel}
    />
  );
}

/** 角色目录前缀（长前缀优先，避免嵌套目录误归属） */
function ownerOf(
  path: string,
  owners: readonly { prefix: string; label: string }[],
): { prefix: string; label: string } | undefined {
  return owners.find((o) => path.startsWith(o.prefix));
}

/** 取角色目录下的第一层子目录名（作者包目录）；直接挂根下 → null */
function packageDirOf(path: string, prefix: string): string | null {
  const rel = path.slice(prefix.length).replace(/^[\\/]+/, '');
  const m = /[\\/]/.exec(rel);
  return m ? rel.slice(0, m.index) : null;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/**
 * 角色归属表（charaIndex → 目录前缀；长前缀优先，避免嵌套目录误归属）。
 * 单一来源：索引路径与冷开 walk 快照共用 —— 两边的分组结果才可能逐字一致。
 */
export function kojoOwners(project: GameProject): Array<{ prefix: string; label: string }> {
  const owners: Array<{ prefix: string; label: string }> = [];
  for (const c of project.charaIndex.values()) {
    if (c.kojoDir) owners.push({ prefix: c.kojoDir, label: `#${c.no} ${c.name}` });
  }
  owners.sort((a, b) => b.prefix.length - a.prefix.length);
  return owners;
}

/**
 * 路径清单 → 角色 / 作者包分组（纯函数，可单测）。
 *
 * **索引路径与冷开 walk 快照共用这一个构建函数**：快照期与索引期按同一口径分组，
 * 索引就绪切换时结构逐字相同 —— 不会出现"树重排"的视觉抖动。
 * 旧实现把这段逻辑内嵌在 useMemo 里并直接吃 `index.files.keys()`，无法被 walk 复用。
 */
export function buildFileGroups(
  paths: Iterable<string>,
  owners: readonly { prefix: string; label: string }[],
): Group[] {
  const map = new Map<string, { prefix: string; subs: Map<string | null, string[]> }>();
  for (const path of paths) {
    const owner = ownerOf(path, owners) ?? { prefix: '', label: '(未归属)' };
    let g = map.get(owner.label);
    if (!g) {
      g = { prefix: owner.prefix, subs: new Map() };
      map.set(owner.label, g);
    }
    const sub = owner.prefix ? packageDirOf(path, owner.prefix) : null;
    const arr = g.subs.get(sub);
    if (arr) arr.push(path);
    else g.subs.set(sub, [path]);
  }

  // 归属组按编号排（label 前缀 #n），未归属垫底；包按字典序，根散文件在前
  const sorted = [...map.entries()].sort((a, b) => {
    if (a[0] === '(未归属)') return 1;
    if (b[0] === '(未归属)') return -1;
    return parseInt(a[0].slice(1), 10) - parseInt(b[0].slice(1), 10);
  });
  return sorted.map(([label, g]) => {
    const subs: PackageGroup[] = [...g.subs.entries()]
      .sort((a, b) => {
        if (a[0] === null) return -1;
        if (b[0] === null) return 1;
        return a[0].localeCompare(b[0]);
      })
      .map(([subLabel, files]) => ({ label: subLabel, files: files.sort() }));
    return { label, prefix: g.prefix, subs, total: subs.reduce((n, s) => n + s.files.length, 0) };
  });
}

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
 * 过滤态首帧渲染的文件行上界（PERF-6，2026-10-16 树即时批）。
 *
 * **为什么过滤态要单独设窗**：过滤会把**每个命中组强制展开**
 * （`isOpen = opened.has(label) || filter`——这是"打了字就看见结果"的既有语义，不许改）。
 * 语料口径 155 组 / 2,325 文件：一个短词（如 `k1`）命中上千文件 ⇒ 一次 deferred 提交
 * 就把上千行全挂进 DOM，输入框依旧卡。deferred 只让**打字**不卡，救不了**提交**那一帧。
 * 这里给提交帧上界：首帧 120 行，点「继续显示后续命中」每次 +240（单调、可达全量——
 * 不是"截了就不给看"的死上限）。函数树侧同理，见 navigator 的 `FaceList` 窗口。
 */
export const FILTER_WINDOW_INITIAL = 120;
/** 每次「继续显示后续命中」追加的文件行数 */
export const FILTER_WINDOW_STEP = 240;

/** 包行键（组标签 + 包标签；根散文件 = 空串）——渲染计划与渲染侧共用这一份口径 */
function rowKeyOf(groupLabel: string, subLabel: string | null): string {
  return `${groupLabel}::${subLabel ?? ''}`;
}

/** 过滤态渲染计划（见 `filterRenderPlan`） */
export interface FilterRenderPlan {
  /** 每个包本次渲染的行数（缺键 = 0 行） */
  readonly perPackage: ReadonlyMap<string, number>;
  /** 本次真正渲染的文件行数 */
  readonly rendered: number;
  /** 命中总数（真实计数——组头/包头的计数用它，不用渲染数） */
  readonly matched: number;
  /** 本次未渲染的命中数（>0 时树尾挂「继续显示」哨兵） */
  readonly hidden: number;
}

/**
 * 过滤态的渲染计划（纯函数，可单测）。
 *
 * 预算按「组序 → 包序 → 包内路径序」贪心切分（即树本身的显示顺序 ⇒ 前两窗的内容
 * 与不截断时**逐字同构**，不会出现"先显示的后面消失"）。
 * **组与包结构一律保留**：组头/包头的计数始终是真实命中数，被裁的只是行 DOM
 * ⇒ 计划不撒谎，也不改变命中集合（只是分帧显示）。
 */
export function filterRenderPlan(groups: readonly Group[], limit: number | undefined): FilterRenderPlan {
  const budget = limit ?? FILTER_WINDOW_INITIAL;
  let left = Math.max(0, budget);
  const perPackage = new Map<string, number>();
  let rendered = 0;
  let matched = 0;
  for (const g of groups) {
    for (const s of g.subs) {
      matched += s.files.length;
      const take = Math.min(s.files.length, left);
      if (take > 0) {
        perPackage.set(rowKeyOf(g.label, s.label), take);
        left -= take;
        rendered += take;
      }
    }
  }
  return { perPackage, rendered, matched, hidden: matched - rendered };
}

/**
 * 过滤窗口下一步（纯函数）：`min(matched, max(INITIAL, 当前 + STEP))`。
 * 单调不减、单步增量 ≤ STEP、终值 = matched（全量可达）。
 */
export function nextFilterWindow(current: number | undefined, matched: number): number {
  const base = current ?? FILTER_WINDOW_INITIAL;
  return Math.min(matched, Math.max(FILTER_WINDOW_INITIAL, base + FILTER_WINDOW_STEP));
}

/** ERB 平铺行（模块级组件 ⇒ 可 SSR 单测"一次渲染多少行"；窗口大小由 `limit` 决定） */
export interface FileRowsProps {
  readonly files: readonly string[];
  /** 本次最多渲染的行数（≥ files.length 即全量 = 改动前行为） */
  readonly limit: number;
  readonly activeFile: string | null;
  readonly onOpenFile: (path: string) => void;
  /**
   * 行内重命名（B1）：与 path 匹配的那行改画输入框（node 由宿主造好塞进来，
   * FileRows 保持无知——它不认识编辑态，只知道"这一行换成这个元素"）。
   * 缺省 → 无编辑，旧行为。
   */
  readonly edit?: { readonly path: string; readonly node: ReactElement } | null;
  /** 文件行右键（B1；缺省 → 文件行无右键，旧行为） */
  readonly onFileContext?: (e: ReactMouseEvent, path: string) => void;
}

export function FileRows({ files, limit, activeFile, onOpenFile, edit, onFileContext }: FileRowsProps): ReactElement {
  const rows = limit >= files.length ? files : files.slice(0, Math.max(0, limit));
  return (
    <>
      {rows.map((f) => (
        <li key={f}>
          {edit && edit.path === f ? (
            edit.node
          ) : (
            <button
              className={`tree-file ${f === activeFile ? 'active' : ''}`}
              title={f}
              data-locate={f}
              onClick={() => onOpenFile(f)}
              onContextMenu={onFileContext ? (e) => onFileContext(e, f) : undefined}
            >
              {baseName(f)}
            </button>
          )}
        </li>
      ))}
    </>
  );
}

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
export function FileTree({ project, index, activeFile, onOpenFile, listDir, walkDir, onImportPackage, io, onRevealInExplorer, guardFileOp, onFilesGone, refreshNonce, gloss, extraRoots, onAddFolder }: Props): ReactElement {
  /** 名称显示对照（缺省 = 恒等，保持旧行为） */
  const glossOf = gloss ?? ((n: string): string => n);
  const [filter, setFilter] = useState('');
  /**
   * 视图切换（B5）：口上树（角色 → 作者包 → 口上文件的语义分组）⇄ 整个游戏目录（文件系统视图）。
   *
   * - 浏览现场，**不持久化**：切走再切回，语义视图的展开态（opened / pkgFolder / subOpen）原样保留；
   * - 文件系统视图**复用**同一套 dirRows / subOpen / dirCache——dirCache 按绝对路径键控，
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
  /** 右键菜单（壳层私有轻量实现） */
  const [menu, setMenu] = useState<{ x: number; y: number; scope: MenuScope } | null>(null);
  /** 批量展开/收起后的一句可读数（反馈 6：没有反馈的批量动作＝用户读成"点了没反应"） */
  const [revealNote, setRevealNote] = useState<string | null>(null);
  /** 行内编辑（新建 / 重命名；B1/B2） */
  const [edit, setEdit] = useState<EditState | null>(null);
  const [editValue, setEditValue] = useState('');
  /** B4 定位请求（activeFile 变化时的自动定位；落地后由定位 effect 自己清空） */
  const [locateReq, setLocateReq] = useState<{ file: string } | null>(null);
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
   * 分组来源优先级：索引（权威）→ 冷开快照（索引未就绪的先手）。
   * 两者共用 `buildFileGroups` 同一构建函数 + 同一 owners 表 ⇒ 同一文件集下结构逐字相同，
   * 索引就绪切换时不重排。
   */
  const groups = useMemo<Group[]>(() => {
    const paths = index ? [...index.files.keys()] : snapPaths;
    if (!paths) return [];
    return buildFileGroups(paths, kojoOwners(project));
  }, [index, snapPaths, project]);

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

  /** 发起一次列举（不看缓存，总是重新取；结果按请求序号认领先后） */
  const fetchDir = (dir: string): void => {
    if (!listDir) return;
    const seq = (dirReq.current.get(dir) ?? 0) + 1;
    dirReq.current.set(dir, seq);
    setDirCache((m) =>
      // **首次展开**才显示「读取目录…」；失效重列时旧内容原地留着、新结果到了再换。
      // 否则作者每按一次 Ctrl+S（保存也是外部改动的一种），整棵树的展开层就闪一下空白——
      // 这是本批自己引入的风险：以前根本没有第二次列举，现在有了，就不能让它打扰人。
      m.has(dir) ? m : new Map(m).set(dir, 'loading'),
    );
    void listDir(dir)
      .then((entries) => {
        if (dirReq.current.get(dir) !== seq) return;
        setDirCache((m) => new Map(m).set(dir, entries));
      })
      .catch(() => {
        if (dirReq.current.get(dir) !== seq) return;
        setDirCache((m) => new Map(m).set(dir, 'error'));
      });
  };

  /** 真实文件夹视图的惰性加载（按绝对路径；已缓存则零请求） */
  const ensureDir = (dir: string): void => {
    if (!listDir || dirCache.has(dir)) return;
    fetchDir(dir);
  };

  /** 点击包标题行 = 追加 / 收起真实文件夹内容（ERB 列表始终原地不动） */
  const togglePkgFolder = (pkgKey: string, dir: string): void => {
    const willEnter = !pkgFolder.has(pkgKey);
    setPkgFolder((prev) => toggleIn(prev)(pkgKey));
    if (willEnter) ensureDir(dir);
  };

  /** 子目录展开/折叠（递归；首次展开才取该层） */
  const toggleSub = (dir: string): void => {
    const willOpen = !subOpen.has(dir);
    setSubOpen((prev) => toggleIn(prev)(dir));
    if (willOpen) ensureDir(dir);
  };

  /**
   * fs 视图的根层清单（D1 会话级附加根）：项目根恒在首位，附加根按加入顺序并列。
   * 只有**一个**根时维持 B5 原形态（根层直接铺开、无分组头），零视觉扰动。
   */
  const fsRoots = useMemo<string[]>(
    () => [project.rootDir, ...(extraRoots ?? [])],
    [project.rootDir, extraRoots],
  );
  const multiRootFs = fsRoots.length > 1;

  /**
   * 进入文件系统视图（B5）时惰性取项目根的第一层：根 = `project.rootDir`
   * （GameProject 契约的项目根字段，口上目录们与其他一切都在它之下）。
   * 失败（浏览器壳无桌面壳权限等）走 dirRows 既有 error 态口径——「目录读取失败（需要桌面壳权限）」。
   * 多根形态（D1）：根头默认**折叠**，展开（toggleSub）时才取——不为看不见的东西打 IO。
   */
  useEffect(() => {
    if (view === 'fs' && !multiRootFs) ensureDir(project.rootDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, project.rootDir, listDir, multiRootFs]);

  /** 收集作用域内全部作者包（根散文件无包目录，不在真实文件夹视图范围） */
  const collectPackages = (scope: MenuScope): Array<{ key: string; dir: string; group: string }> => {
    const gs = scope.kind === 'group' ? [scope.group] : groups;
    const out: Array<{ key: string; dir: string; group: string }> = [];
    for (const g of gs) {
      for (const s of g.subs) {
        if (s.label === null) continue;
        out.push({ key: `${g.label}::${s.label}`, dir: pkgDirOf(g, s.label), group: g.label });
      }
    }
    return out;
  };

  /** 右键「显示所有文件和文件夹」：按作用域批量展开真实文件夹内容 */
  const revealAll = (scope: MenuScope): void => {
    setMenu(null);
    const pkgs = collectPackages(scope);
    setOpened((prev) => new Set([...prev, ...pkgs.map((p) => p.group)]));
    setPkgFolder((prev) => new Set([...prev, ...pkgs.map((p) => p.key)]));
    for (const p of pkgs) ensureDir(p.dir);
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
  const relistShown = (): void => {
    for (const dir of dirsToRelist(subOpen, pkgFolder, collectPackages({ kind: 'root' }))) fetchDir(dir);
    // 文件系统视图（B5/D1）：根层全部根一并重列（多根时折叠着的也会被取到顶层——手动
    // 重读是显式动作，宁可多取一层也不留"按了刷新还有根没重列"的疑心）
    if (view === 'fs') for (const r of fsRoots) fetchDir(r);
  };

  const lastNonce = useRef(refreshNonce);
  useEffect(() => {
    if (refreshNonce === undefined || refreshNonce === lastNonce.current) return;
    lastNonce.current = refreshNonce;
    relistShown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce]);

  const openMenu = (e: ReactMouseEvent, scope: MenuScope): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 260), y: e.clientY, scope });
  };

  /* ---------------- 文件/目录编辑（B1/B2 文件树编辑批） ---------------- */

  /** 轻反馈（复用 revealNote 同款形态——一句话状态行，不建 toast 基建） */
  const note = (msg: string): void => setRevealNote(msg);
  const noteErr = (err: unknown, action: string): void => {
    const msg = err instanceof Error ? err.message : String(err);
    // 越权写（WriteNotAllowedError）的消息是英文内部术语：换成人话，其余原样带出
    setRevealNote(String(err instanceof Error && err.name === 'WriteNotAllowedError')
      ? '这个位置在只读范围内，不能在这里修改文件。要先在「只读」徽章那里批准写权限。'
      : `${action}失败：${msg}`);
  };

  /** 把某个目录的父层「打开到可见」：新建/重命名的输入行必须落在已展开的那一层 */
  const openLayerOf = (dir: string): void => {
    // 是某个作者包目录 → 打开包的真实文件夹视图（新建的文件 immediate 可见处就在这）
    for (const g of groups) {
      for (const s of g.subs) {
        if (s.label !== null && pkey(pkgDirOf(g, s.label)) === pkey(dir)) {
          setOpened((prev) => new Set(prev).add(g.label));
          setPkgFolder((prev) => new Set(prev).add(`${g.label}::${s.label}`));
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
  const pruneCacheUnder = (dir: string): void => {
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
  };

  /** 重命名目录后 subOpen 里的旧前缀跟着搬（展开态是作者的现场，搬目录不算丢现场） */
  const remapSubOpen = (fromDir: string, toDir: string): void => {
    setSubOpen((prev) => {
      const next = new Set<string>();
      for (const k of prev) next.add(isUnderPath(fromDir, k) ? joinPath(toDir, k.slice(fromDir.replace(/[\\/]+$/, '').length + 1)) : k);
      return next;
    });
  };

  /** 操作涉及哪些目录就重列哪些（重命名要重列 from 与 to 两个父目录；不全树重挂） */
  const refetchDirs = (dirs: readonly string[]): void => {
    const seen = new Set<string>();
    for (const d of dirs) {
      if (!d || seen.has(pkey(d))) continue;
      seen.add(pkey(d));
      fetchDir(d);
    }
  };

  const commitEdit = (): void => {
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
      const doing =
        e.kind === 'file'
          ? io!.writeBytes(target, new Uint8Array()) // 新建空文件走既有写链路（备份=空文件无旧版可备）
          : io!.ensureDir(target);
      void doing.then(
        () => {
          setEdit(null);
          // 只重列落点目录；新文件立刻可见处 = 包的真实文件夹视图（openLayerOf 已打开）
          refetchDirs([e.dir]);
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
  };

  const cancelEdit = (): void => setEdit(null);

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

  const scopePathOf = (scope: MenuScope): string => {
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

  const runMenuAction = (id: MenuItemId, scope: MenuScope): void => {
    setMenu(null);
    const path = scopePathOf(scope);
    switch (id) {
      case 'open':
        if (scope.kind === 'file') onOpenFile(scope.path);
        break;
      case 'copy-path':
        if (path) copyText(path, '已复制完整路径');
        break;
      case 'copy-rel-path':
        if (scope.kind === 'file') copyText(relativeToRoot(scope.path, project.rootDir), '已复制相对路径');
        break;
      case 'reveal':
        if (path) onRevealInExplorer?.(path);
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
    }
  };

  const menuCapability: MenuCapability = {
    hasIo: io !== undefined,
    canReveal: onRevealInExplorer !== undefined,
    canImport: onImportPackage !== undefined,
  };

  /* ---------------- B4：定位当前文件 ---------------- */

  /** 自动定位：activeFile 变化时展开到所在组/包并滚到那一行（首次挂载不算"变化"） */
  const firstActiveRef = useRef(true);
  useEffect(() => {
    if (firstActiveRef.current) {
      firstActiveRef.current = false;
      return;
    }
    if (activeFile) setLocateReq({ file: activeFile });
  }, [activeFile]);

  /**
   * 在树体内找 data-locate 行并滚到刚好可见。比对走归一键（pkey）：
   * 文件系统视图的行路径来自磁盘列举（DirEntry.path），与 activeFile 的写法可能差个
   * 分隔符/大小写——按字面比对会漏滚，归一后 Windows 两种写法都命中。
   */
  const scrollLocate = (targetPath: string): void => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const body = treeBodyRef.current;
        if (!body) return;
        const key = pkey(targetPath);
        for (const el of body.querySelectorAll<HTMLElement>('button[data-locate]')) {
          if (pkey(el.dataset.locate ?? '') === key) {
            el.scrollIntoView({ block: 'nearest' });
            break;
          }
        }
      }),
    );
  };

  useEffect(() => {
    if (!locateReq) return;
    if (view === 'fs') {
      // 文件系统视图：locatePlanOf 是语义树口径，不适用——退化为「从所属根到 activeFile
      // 逐级展开」（D1：fsRoots 逐根算归属，附加根内的文件同样定位得到）。
      // 目录列举是异步的：父层清单没回来时先不清请求也不硬滚（dirCache 变化会重跑本 effect），
      // 回来后行已挂载，两拍 rAF 再滚（nearest 只滚到刚好可见，不拽容器乱跳）。
      const plan = fsLocatePlanOfRoots(fsRoots, locateReq.file);
      if (!plan) {
        setLocateReq(null); // 不在任何根下：安静放弃，不报错
        return;
      }
      if (multiRootFs) {
        // 多根形态：先把所属根的分组头打开（单根形态没有分组头，根层本来就铺开）
        setSubOpen((prev) => new Set(prev).add(plan.root));
        ensureDir(plan.root);
      }
      for (const d of plan.dirs) {
        setSubOpen((prev) => new Set(prev).add(d));
        ensureDir(d);
      }
      const parent = plan.dirs[plan.dirs.length - 1] ?? plan.root;
      const st = dirCache.get(parent);
      if (st === undefined || st === 'loading') return; // 等列举回来
      if (st === 'error') {
        setLocateReq(null); // 列不动就不硬撑（失败行已在树上自解释）
        return;
      }
      scrollLocate(locateReq.file);
      setLocateReq(null);
      return;
    }
    if (deferredFilter) {
      // 过滤态：结果被渲染窗口截断、强制全展开也不是用户的现场——自动定位安静放弃；
      // 手动定位等过滤词清空（deferred 追上）后由本 effect 重跑。
      return;
    }
    const plan: LocatePlan | null = locatePlanOf(groups, locateReq.file, (prefix, label) =>
      joinPath(prefix, label),
    );
    if (!plan) return; // 未归属 / 不在索引里：安静放弃，不报错
    setOpened((prev) => new Set(prev).add(plan.groupLabel));
    if (plan.pkg) {
      setPkgFolder((prev) => new Set(prev).add(plan.pkg!.key));
      ensureDir(plan.pkg!.dir);
    }
    // DOM 提交后再滚：两拍 rAF 保证新展开的行已挂载
    scrollLocate(plan.targetPath);
    setLocateReq(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locateReq, groups, deferredFilter, view, dirCache]);

  /**
   * 该包本次渲染的行数（PERF-6 过滤窗口）。
   * 非过滤态 `plan === null` ⇒ 全量（改动前行为）；过滤态按 `filterRenderPlan` 的预算切。
   */
  const renderLimitOf = (g: Group, s: PackageGroup): number =>
    plan ? (plan.perPackage.get(rowKeyOf(g.label, s.label)) ?? 0) : s.files.length;

  /**
   * 一个目录的真实内容行（递归）。目录可再展开；文件按类型给不同处置。
   *
   * `skip` 只在**包根那一层**生效：那里的 ERB 与包层平铺列表同级重复（同一个东西在
   * 同一个视觉层级出现两遍），所以略过。**嵌套目录必须如实显示自己的 ERB**——
   * 它们住在另一层，不是重复；若一并略过，装了 10 个面文件的子目录会被渲染成空目录，
   * 等于谎报文件系统（实测语料 `灵梦-少女之梦/没写的` 就有 10 个 ERB）。
   */
  const dirRows = (dir: string, depth: number, skip: Set<string>): ReactElement[] => {
    const state = dirCache.get(dir);
    if (state === undefined) return [];
    if (state === 'loading' || state === 'error') {
      return [
        <li key={`${dir}::note`} className="tree-note">
          {state === 'loading' ? '读取目录…' : '目录读取失败（需要桌面壳权限）'}
        </li>,
      ];
    }
    const byName = (a: DirEntry, b: DirEntry): number => a.name.localeCompare(b.name);
    const visible = visibleEntries(state, depth, skip);
    if (visible.length === 0) {
      return [<li key={`${dir}::empty`} className="tree-note">（空目录）</li>];
    }
    const dirs = visible.filter((d) => d.isDirectory).sort(byName);
    const files = visible.filter((d) => !d.isDirectory).sort(byName);
    const pad = { paddingLeft: `${depth * 14}px` };
    /** 该层正在新建（输入行插在本层最上）；与 rename 行共用 EditRow */
    const creatingHere = edit?.mode === 'create' && edit.dir === dir ? edit : null;
    return [
      ...(creatingHere
        ? [
            <li key={`${dir}::create`} style={pad}>
              <EditRow
                value={editValue}
                placeholder={creatingHere.kind === 'file' ? '新文件名' : '新文件夹名'}
                onChange={setEditValue}
                onCommit={commitEdit}
                onCancel={cancelEdit}
              />
            </li>,
          ]
        : []),
      ...dirs.map((d) => {
        const renaming = edit?.mode === 'rename' && edit.isDir && edit.path === d.path;
        return (
          <li key={d.path}>
            {renaming ? (
              <div style={pad}>
                <EditRow
                  value={editValue}
                  placeholder="新名称"
                  onChange={setEditValue}
                  onCommit={commitEdit}
                  onCancel={cancelEdit}
                />
              </div>
            ) : (
              <button
                className="tree-dir"
                style={pad}
                title={d.path}
                data-drop-dir={d.path}
                onClick={() => toggleSub(d.path)}
                onContextMenu={(e) => openMenu(e, { kind: 'dir', path: d.path })}
              >
                <span className="caret">
                  <Icon name={subOpen.has(d.path) ? 'chevron-down' : 'chevron-right'} size={12} />
                </span>
                <span className="tree-dir-name">{glossOf(d.name)}</span>
              </button>
            )}
            {subOpen.has(d.path) ? (
              <ul className="tree-files nested">{dirRows(d.path, depth + 1, skip)}</ul>
            ) : null}
          </li>
        );
      }),
      ...files.map((d) => {
        const renaming = edit?.mode === 'rename' && !edit.isDir && edit.path === d.path;
        if (renaming) {
          return (
            <li key={d.path} style={pad}>
              <EditRow
                value={editValue}
                placeholder="新名称"
                onChange={setEditValue}
                onCommit={commitEdit}
                onCancel={cancelEdit}
              />
            </li>
          );
        }
        return BINARY_EXT.test(d.name) ? (
          <li key={d.path} className="tree-extra" style={pad} title={`${d.path}（压缩包/资源，不在编辑器内打开）`}>
            <span className="tree-extra-name">{glossOf(d.name)}</span>
          </li>
        ) : (
          <li key={d.path} style={pad}>
            <button
              className={`tree-file ${d.path === activeFile ? 'active' : ''} ${erbExt(d.name) ? '' : 'tree-extra-file'}`}
              title={erbExt(d.name) ? d.path : `${d.path}（附加文件，不在口上索引内）`}
              data-locate={d.path}
              onClick={() => onOpenFile(d.path)}
              onContextMenu={(e) => openMenu(e, { kind: 'file', path: d.path })}
            >
              {glossOf(d.name)}
            </button>
          </li>
        );
      }),
    ];
  };

  /** 包层已平铺的 ERB 路径集（子目录渲染时去重用） */
  const erbKeysOf = (s: PackageGroup): Set<string> => new Set(s.files.map(pkey));

  /** 平铺 ERB 行的行内重命名（FileRows 是无知组件：编辑节点在这里造好塞进去） */
  const fileEdit =
    edit && edit.mode === 'rename' && !edit.isDir
      ? {
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
        }
      : null;
  /** 平铺 ERB 行右键（B1：文件行也有菜单了） */
  const onFileContext = (e: ReactMouseEvent, path: string): void => openMenu(e, { kind: 'file', path });

  if (!index && snapPaths === null) {
    // 索引未就绪且快照未到：占位自解释。
    // 没有 walkDir（纯浏览器宿主 ⇒ 根本没有先手快照）或快照读盘失败 ⇒ 退回旧文案，
    // 不能对着人说"正在读取口上目录"而其实什么都没读。
    const text = walkDir && !walkFailed ? '正在读取口上目录…' : '索引中…';
    return <div className="tree-loading">{text}</div>;
  }

  return (
    <div
      className="file-tree"
      onContextMenu={view === 'kojo' ? (e) => openMenu(e, { kind: 'root' }) : undefined}
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
          全部退场——能力仍在（view 机器、extraRoots、applyReveal、relistShown 自动刷新、
          右键菜单「显示所有文件和文件夹」），只是不再占一条横向按钮带。 */}
      {revealNote ? (
        <p className="tree-reveal-note dim" role="status">
          {revealNote}
        </p>
      ) : null}
      <ul className="tree-groups" ref={treeBodyRef}>
        {view === 'fs' ? (
          // 文件系统视图（B5/D1）：单根 = project.rootDir 第一层直接铺开（原形态，零扰动）；
          // 有附加根 = 每根一个可折叠分组头并列（复用 subOpen 折叠 + dirCache 惰性列举，
          // 展开哪层取哪层）。内容行复用 dirRows（惰性加载 / 二进制标记 / gloss / B1 右键
          // 菜单全在）；失败走 dirRows 既有 error 态（需要桌面壳权限），绝不点了没反应。
          multiRootFs ? (
            fsRoots.map((root) => {
              const isOpen = subOpen.has(root);
              return (
                <li key={root} className="tree-group">
                  <button
                    className="tree-group-btn"
                    title={`${root}${root === project.rootDir ? '（项目根）' : '（本次会话添加的文件夹，重开项目后不再显示）'}`}
                    onClick={() => toggleSub(root)}
                  >
                    <span className="caret">
                      <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} />
                    </span>
                    <span className="group-label">{baseName(root)}</span>
                  </button>
                  {isOpen ? (
                    <ul className="tree-files">
                      {dirCache.has(root) ? (
                        dirRows(root, 0, new Set())
                      ) : (
                        <li className="tree-note">读取目录…</li>
                      )}
                    </ul>
                  ) : null}
                </li>
              );
            })
          ) : dirCache.has(project.rootDir) ? (
            dirRows(project.rootDir, 0, new Set())
          ) : (
            <li className="tree-note">读取目录…</li>
          )
        ) : (
          <>
        {visible.map((g) => {
          const isOpen = opened.has(g.label) || deferredFilter.length > 0;
          return (
            <li key={g.label} className="tree-group">
              <button
                className="tree-group-btn"
                title={`${g.label}（右键查看更多）`}
                data-drop-dir={g.prefix || undefined}
                onClick={() => toggleGroup(g.label)}
                onContextMenu={(e) => openMenu(e, { kind: 'group', group: g })}
              >
                <span className="caret">
                  <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} />
                </span>
                <span className="group-label">{g.label}</span>
                <span className="group-count">{g.total}</span>
              </button>
              {isOpen ? (
                <ul className="tree-files">
                  {g.subs.map((s) => {
                    // 根散文件（无包目录兜底）：直接平铺在角色组下
                    if (s.label === null) {
                      return (
                        <FileRows
                          key={`${g.label}::(根散文件)`}
                          files={s.files}
                          limit={renderLimitOf(g, s)}
                          activeFile={activeFile}
                          onOpenFile={onOpenFile}
                          edit={fileEdit}
                          onFileContext={onFileContext}
                        />
                      );
                    }
                    const label = s.label;
                    const pkgKey = `${g.label}::${label}`;
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
                            onClick={() => togglePkgFolder(pkgKey, pkgDir)}
                            onContextMenu={(e) => {
                              // 包节点右键 = 导入（P-F）+ 目录编辑（B1）；无任何能力时仅阻止冒泡
                              e.preventDefault();
                              e.stopPropagation();
                              openMenu(e, { kind: 'package', dir: pkgDir, label });
                            }}
                          >
                            <span className="caret">
                              <Icon name={isFolder ? 'chevron-down' : 'chevron-right'} size={12} />
                            </span>
                            <span className="tree-package-name">{glossOf(s.label)}</span>
                            <span className="group-count">{s.files.length}</span>
                          </button>
                        )}
                        {/* 追加式：真实文件夹内容在上、ERB 列表原地不动（无动画、不卸载） */}
                        {isFolder ? (
                          <ul className="tree-files nested pkg-real">{dirRows(pkgDir, 0, erbKeysOf(s))}</ul>
                        ) : null}
                        <ul className="tree-files nested">
                          <FileRows
                            files={s.files}
                            limit={renderLimitOf(g, s)}
                            activeFile={activeFile}
                            onOpenFile={onOpenFile}
                            edit={fileEdit}
                            onFileContext={onFileContext}
                          />
                        </ul>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
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
      {menu ? (
        <>
          <div className="context-menu-backdrop" onMouseDown={() => setMenu(null)} />
          <div className="context-menu" style={{ left: menu.x, top: menu.y }} role="menu" aria-orientation="vertical">
            {menu.scope.kind === 'root' || menu.scope.kind === 'group' ? (
              <button
                role="menuitem"
                onClick={() => {
                  if (menu.scope.kind === 'root') {
                    setMenu(null);
                    applyReveal(visible, toggleReveal(revealTargets(visible), revealStateOf()));
                  } else {
                    revealAll(menu.scope);
                  }
                }}
              >
                <span className="check" />
                {menu.scope.kind === 'root'
                  ? revealMenuLabel(revealTargets(visible), revealStateOf())
                  : '显示所有文件和文件夹'}
              </button>
            ) : (
              menuItemsFor(menu.scope.kind, menuCapability).map((item, i) => (
                <div key={item.id} role="none">
                  {item.dividerBefore && i > 0 ? <div className="context-menu-sep" role="separator" /> : null}
                  <button
                    role="menuitem"
                    className={item.id === 'delete' ? 'danger' : undefined}
                    onClick={() => runMenuAction(item.id, menu.scope)}
                  >
                    <span className="check" />
                    {item.label}
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
