import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import type { DirEntry, ErbIndex, GameProject } from '@kojo/plugin-api';
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
interface PackageGroup {
  /** 包目录名；null = 直接挂在角色目录根下的散文件（如 159 先代 无包目录） */
  label: string | null;
  /** 包内 ERB 面文件（来自索引） */
  files: string[];
}

interface Group {
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

/** ERB 系扩展名（与 erb-parser 的 `ERB_EXT = /\.er[bm]$/i` 同口径）：
 *  嵌套目录里的 ERB 走普通文件行样式，非 ERB 才标「不在索引内」 */
function erbExt(name: string): boolean {
  return /\.er[bm]$/i.test(name);
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
export function FileTree({ project, index, activeFile, onOpenFile, listDir, onImportPackage, refreshNonce, gloss }: Props): ReactElement {
  /** 名称显示对照（缺省 = 恒等，保持旧行为） */
  const glossOf = gloss ?? ((n: string): string => n);
  const [filter, setFilter] = useState('');
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

  const groups = useMemo<Group[]>(() => {
    if (!index) return [];
    const owners: Array<{ prefix: string; label: string }> = [];
    for (const c of project.charaIndex.values()) {
      if (c.kojoDir) owners.push({ prefix: c.kojoDir, label: `#${c.no} ${c.name}` });
    }
    owners.sort((a, b) => b.prefix.length - a.prefix.length);

    const map = new Map<string, { prefix: string; subs: Map<string | null, string[]> }>();
    for (const path of index.files.keys()) {
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
  }, [index, project]);

  const visible = useMemo(() => {
    if (!filter) return groups;
    const q = filter.toLowerCase();
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
  }, [groups, filter]);

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

  const fileRow = (f: string): ReactElement => (
    <li key={f}>
      <button
        className={`tree-file ${f === activeFile ? 'active' : ''}`}
        title={f}
        onClick={() => onOpenFile(f)}
      >
        {baseName(f)}
      </button>
    </li>
  );

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

  if (!index) {
    return <div className="tree-loading">索引中…</div>;
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
          const isOpen = opened.has(g.label) || filter.length > 0;
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
                    if (s.label === null) return s.files.map(fileRow);
                    const label = s.label;
                    const pkgKey = `${g.label}::${label}`;
                    const pkgDir = pkgDirOf(g, label);
                    const isFolder = pkgFolder.has(pkgKey) && filter.length === 0;
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
                        <ul className="tree-files nested">{s.files.map(fileRow)}</ul>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
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
