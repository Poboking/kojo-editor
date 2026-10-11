import { useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import type { DirEntry, ErbIndex, GameProject } from '@kojo/plugin-api';

interface Props {
  project: GameProject;
  index: ErbIndex | null;
  activeFile: string | null;
  onOpenFile: (path: string) => void;
  /** 目录列举（真实文件夹视图用；宿主注入内核 io，浏览器环境可能抛错——调用侧已兜底） */
  listDir?: (path: string) => Promise<DirEntry[]>;
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

/** 右键菜单作用域：单个角色 / 整棵树根 */
type MenuScope = { kind: 'group'; group: Group } | { kind: 'root' };

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
 * 口上文件树：角色 → 作者包（可折叠，默认折叠）→ 包内容。
 *
 * 两个层级动作（小巧思定稿）：
 * - **点击作者包节点** = 原地展开该包的真实文件夹内容（子目录 / README·ライセンス
 *   等附加文件 / 面文件——与磁盘布局一致；惰性 listDir，失败时回落为仅面文件并自解释）；
 * - **右键「查看被隐藏的文件和文件夹」** = 按作用域批量展开：角色节点 → 该角色全部
 *   作者包的真实文件夹；树根空白处 → 所有角色的全部真实文件夹。
 *
 * 展开状态由组件内 state 持有——宿主（ProjectView）以稳定组件身份注入，
 * 打开文件不会因重渲染而丢掉展开状态。
 */
export function FileTree({ project, index, activeFile, onOpenFile, listDir }: Props): ReactElement {
  const [filter, setFilter] = useState('');
  const [opened, setOpened] = useState<Set<string>>(new Set());
  /** 作者包展开态（默认折叠） */
  const [pkgOpen, setPkgOpen] = useState<Set<string>>(new Set());
  /** 包目录列举缓存（真实文件夹视图；按包 key 惰性加载） */
  const [dirCache, setDirCache] = useState<Map<string, DirState>>(new Map());
  /** 右键菜单（壳层私有轻量实现） */
  const [menu, setMenu] = useState<{ x: number; y: number; scope: MenuScope } | null>(null);

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

  /** 真实文件夹视图的惰性加载（失败落 'error' 态自解释） */
  const ensureDir = (pkgKey: string, dir: string): void => {
    if (!listDir || dirCache.has(pkgKey)) return;
    setDirCache((m) => new Map(m).set(pkgKey, 'loading'));
    void listDir(dir)
      .then((entries) => setDirCache((m) => new Map(m).set(pkgKey, entries)))
      .catch(() => setDirCache((m) => new Map(m).set(pkgKey, 'error')));
  };

  /** 点击作者包节点 = 展开/折叠该包的真实文件夹内容 */
  const togglePkg = (pkgKey: string, dir: string): void => {
    const willOpen = !pkgOpen.has(pkgKey);
    setPkgOpen((prev) => toggleIn(prev)(pkgKey));
    if (willOpen) ensureDir(pkgKey, dir);
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

  /** 右键「查看被隐藏的文件和文件夹」：按作用域批量展开全部包的真实文件夹 */
  const revealAll = (scope: MenuScope): void => {
    setMenu(null);
    const pkgs = collectPackages(scope);
    setOpened((prev) => new Set([...prev, ...pkgs.map((p) => p.group)]));
    setPkgOpen((prev) => new Set([...prev, ...pkgs.map((p) => p.key)]));
    for (const p of pkgs) ensureDir(p.key, p.dir);
  };

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

  /** 包内真实文件夹内容：目录 → 非 ERB 附加文件 → ERB 面文件 */
  const packageExtras = (pkgKey: string, s: PackageGroup): ReactElement | null => {
    const state = dirCache.get(pkgKey);
    if (state === undefined) return null; // 未触发加载（如过滤强制展开）——只露面文件
    if (state === 'loading') return <li className="tree-extra tree-note">读取目录…</li>;
    if (state === 'error') return <li className="tree-extra tree-note">目录读取失败（需要桌面壳权限）</li>;
    const erbNames = new Set(s.files.map((f) => baseName(f).toLowerCase()));
    const dirs = state.filter((d) => d.isDirectory).sort((a, b) => a.name.localeCompare(b.name));
    const extras = state
      .filter((d) => !d.isDirectory && !erbNames.has(d.name.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
    return (
      <>
        {dirs.map((d) => (
          <li key={d.path} className="tree-extra" title={`${d.path}（子目录）`}>
            <span className="tree-extra-icon">📁</span>
            <span className="tree-extra-name">{d.name}</span>
          </li>
        ))}
        {extras.map((d) => (
          <li key={d.path} className="tree-extra" title={`${d.path}（附加文件，不在口上索引内）`}>
            <span className="tree-extra-icon">📄</span>
            <span className="tree-extra-name">{d.name}</span>
          </li>
        ))}
      </>
    );
  };

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
        <button className="ghost small" onClick={() => setOpened(new Set(visible.map((g) => g.label)))}>
          展开全部
        </button>
        <button
          className="ghost small"
          onClick={() => {
            setOpened(new Set());
            setPkgOpen(new Set());
          }}
        >
          折叠全部
        </button>
      </div>
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
                <span className="caret">{isOpen ? '▾' : '▸'}</span>
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
                    const isPkgOpen = pkgOpen.has(pkgKey) || filter.length > 0;
                    return (
                      <li key={label} className="tree-package-node">
                        <button
                          className="tree-package"
                          title={pkgDir}
                          onClick={() => togglePkg(pkgKey, pkgDir)}
                          onContextMenu={(e) => {
                            // 包节点不弹菜单（点击即展开真实内容）；阻止冒泡到树根菜单
                            e.preventDefault();
                            e.stopPropagation();
                          }}
                        >
                          <span className="caret">{isPkgOpen ? '▾' : '▸'}</span>
                          <span className="tree-package-name">{s.label}</span>
                          <span className="group-count">{s.files.length}</span>
                        </button>
                        {isPkgOpen ? (
                          <ul className="tree-files nested">
                            {packageExtras(pkgKey, s)}
                            {s.files.map(fileRow)}
                          </ul>
                        ) : null}
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
            <button role="menuitem" onClick={() => revealAll(menu.scope)}>
              <span className="check" />
              {menu.scope.kind === 'root'
                ? '查看被隐藏的文件和文件夹（全部角色）'
                : '查看被隐藏的文件和文件夹'}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
