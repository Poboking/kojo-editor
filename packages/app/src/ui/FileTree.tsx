import { useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import type { DirEntry, ErbIndex, GameProject, WalkOptions } from '@kojo/plugin-api';
import { isErbDialectPath } from '@kojo/plugin-api';
import {
  collapseAll,
  expandAll,
  packageKey,
  revealMenuLabel,
  toggleReveal,
  type RevealGroup,
  type RevealResult,
} from './file-tree-reveal';
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

/** 右键菜单作用域：单个角色 / 整棵树根 / 单个作者包（导入口径，P-F） */
type MenuScope =
  | { kind: 'group'; group: Group }
  | { kind: 'root' }
  | { kind: 'package'; dir: string; label: string };

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
 * 过滤谓词与 erb-parser 的索引 walk **逐字同款**——特别含 `e.isDirectory ||`：
 * `walkDir` 的 filter 对目录返回 false 会连整棵子树一起剪掉（PITFALLS §58 的静默少收），
 * 写成纯扩展名筛就只剩根层。返回结果只留文件侧（目录条目排除）。
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
}

export function FileRows({ files, limit, activeFile, onOpenFile }: FileRowsProps): ReactElement {
  const rows = limit >= files.length ? files : files.slice(0, Math.max(0, limit));
  return (
    <>
      {rows.map((f) => (
        <li key={f}>
          <button
            className={`tree-file ${f === activeFile ? 'active' : ''}`}
            title={f}
            onClick={() => onOpenFile(f)}
          >
            {baseName(f)}
          </button>
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
export function FileTree({ project, index, activeFile, onOpenFile, listDir, walkDir, onImportPackage, refreshNonce, gloss }: Props): ReactElement {
  /** 名称显示对照（缺省 = 恒等，保持旧行为） */
  const glossOf = gloss ?? ((n: string): string => n);
  const [filter, setFilter] = useState('');
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
    return [
      ...dirs.map((d) => (
        <li key={d.path}>
          <button className="tree-dir" style={pad} title={d.path} onClick={() => toggleSub(d.path)}>
            <span className="caret">
              <Icon name={subOpen.has(d.path) ? 'chevron-down' : 'chevron-right'} size={12} />
            </span>
            <span className="tree-dir-name">{glossOf(d.name)}</span>
          </button>
          {subOpen.has(d.path) ? (
            <ul className="tree-files nested">{dirRows(d.path, depth + 1, skip)}</ul>
          ) : null}
        </li>
      )),
      ...files.map((d) =>
        BINARY_EXT.test(d.name) ? (
          <li key={d.path} className="tree-extra" style={pad} title={`${d.path}（压缩包/资源，不在编辑器内打开）`}>
            <span className="tree-extra-name">{glossOf(d.name)}</span>
          </li>
        ) : (
          <li key={d.path} style={pad}>
            <button
              className={`tree-file ${d.path === activeFile ? 'active' : ''} ${erbExt(d.name) ? '' : 'tree-extra-file'}`}
              title={erbExt(d.name) ? d.path : `${d.path}（附加文件，不在口上索引内）`}
              onClick={() => onOpenFile(d.path)}
            >
              {glossOf(d.name)}
            </button>
          </li>
        ),
      ),
    ];
  };

  /** 包层已平铺的 ERB 路径集（子目录渲染时去重用） */
  const erbKeysOf = (s: PackageGroup): Set<string> => new Set(s.files.map(pkey));

  if (!index && snapPaths === null) {
    // 索引未就绪且快照未到：占位自解释。
    // 没有 walkDir（纯浏览器宿主 ⇒ 根本没有先手快照）或快照读盘失败 ⇒ 退回旧文案，
    // 不能对着人说"正在读取口上目录"而其实什么都没读。
    const text = walkDir && !walkFailed ? '正在读取口上目录…' : '索引中…';
    return <div className="tree-loading">{text}</div>;
  }

  return (
    <div className="file-tree" onContextMenu={(e) => openMenu(e, { kind: 'root' })}>
      <input
        className="tree-filter"
        placeholder={`过滤 ${groups.length} 个角色目录…`}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="tree-actions">
        <button
          className="ghost small"
          onClick={() => applyReveal(visible, expandAll(revealTargets(visible), revealStateOf()))}
        >
          展开全部
        </button>
        <button className="ghost small" onClick={() => applyReveal(visible, collapseAll())}>
          折叠全部
        </button>
        <button
          className="ghost small"
          title="重新读取已展开的目录（外部新增/删除的文件没自动出现时用；监视不可用时这是唯一入口）"
          onClick={relistShown}
        >
          重新读取
        </button>
      </div>
      {revealNote ? (
        <p className="tree-reveal-note dim" role="status">
          {revealNote}
        </p>
      ) : null}
      <ul className="tree-groups">
        {visible.map((g) => {
          const isOpen = opened.has(g.label) || deferredFilter.length > 0;
          return (
            <li key={g.label} className="tree-group">
              <button
                className="tree-group-btn"
                title={`${g.label}（右键查看更多）`}
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
                        />
                      );
                    }
                    const label = s.label;
                    const pkgKey = `${g.label}::${label}`;
                    const pkgDir = pkgDirOf(g, label);
                    const isFolder = pkgFolder.has(pkgKey) && deferredFilter.length === 0;
                    return (
                      <li key={label} className="tree-package-node">
                        <button
                          className="tree-package"
                          title={pkgDir}
                          onClick={() => togglePkgFolder(pkgKey, pkgDir)}
                          onContextMenu={(e) => {
                            // 包节点右键 = 导入口径（P-F）；无导入能力时仅阻止冒泡
                            e.preventDefault();
                            e.stopPropagation();
                            if (onImportPackage) openMenu(e, { kind: 'package', dir: pkgDir, label });
                          }}
                        >
                          <span className="caret">
                            <Icon name={isFolder ? 'chevron-down' : 'chevron-right'} size={12} />
                          </span>
                          <span className="tree-package-name">{glossOf(s.label)}</span>
                          <span className="group-count">{s.files.length}</span>
                        </button>
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
      </ul>
      {plan && plan.hidden > 0 ? (
        <p className="tree-reveal-note dim" role="status">
          过滤强制全展开 ⇒ 只显示前 {plan.rendered} / {plan.matched} 个命中（点树尾按钮继续加载，或把过滤词写长一点）
        </p>
      ) : null}
      {menu ? (
        <>
          <div className="context-menu-backdrop" onMouseDown={() => setMenu(null)} />
          <div className="context-menu" style={{ left: menu.x, top: menu.y }} role="menu">
            {menu.scope.kind === 'package' ? (
              <button
                role="menuitem"
                onClick={() => {
                  const scope = menu.scope;
                  setMenu(null);
                  if (scope.kind === 'package') onImportPackage?.({ dir: scope.dir, label: scope.label });
                }}
              >
                <span className="check" />
                导入为我的口上项目
              </button>
            ) : (
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
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
