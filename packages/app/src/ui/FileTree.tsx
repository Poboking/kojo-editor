import { useMemo, useState, type ReactElement } from 'react';
import type { ErbIndex, GameProject } from '@kojo/plugin-api';

interface Props {
  project: GameProject;
  index: ErbIndex | null;
  activeFile: string | null;
  onOpenFile: (path: string) => void;
}

/** 作者子目录分组（角色目录下的一层子文件夹 = 作者版本号目录） */
interface SubGroup {
  /** 子目录名；null = 直接挂在角色目录根下的散文件 */
  label: string | null;
  files: string[];
}

interface Group {
  label: string;
  /** 角色目录前缀（计算相对路径 → 作者子目录用） */
  prefix: string;
  subs: SubGroup[];
  total: number;
}

/** 角色目录前缀（长前缀优先，避免嵌套目录误归属） */
function ownerOf(
  path: string,
  owners: readonly { prefix: string; label: string }[],
): { prefix: string; label: string } | undefined {
  return owners.find((o) => path.startsWith(o.prefix));
}

/** 取角色目录下的第一层子目录名（作者版本号目录）；直接挂根下 → null */
function authorDirOf(path: string, prefix: string): string | null {
  const rel = path.slice(prefix.length).replace(/^[\\/]+/, '');
  const m = /[\\/]/.exec(rel);
  return m ? rel.slice(0, m.index) : null;
}

/**
 * 口上文件树：角色目录 → 作者版本号子目录 → 文件 三级分组 + 过滤框。
 *
 * 目录结构如实还原磁盘布局（不同作者的口上按子文件夹归属），不拍平。
 * 展开状态由组件内 state 持有——宿主（ProjectView）以稳定组件身份注入，
 * 打开文件不会因重渲染而丢掉展开状态。
 */
export function FileTree({ project, index, activeFile, onOpenFile }: Props): ReactElement {
  const [filter, setFilter] = useState('');
  const [opened, setOpened] = useState<Set<string>>(new Set());

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
      const sub = owner.prefix ? authorDirOf(path, owner.prefix) : null;
      const arr = g.subs.get(sub);
      if (arr) arr.push(path);
      else g.subs.set(sub, [path]);
    }

    // 归属组按编号排（label 前缀 #n），未归属垫底；作者子目录按字典序，根散文件在前
    const sorted = [...map.entries()].sort((a, b) => {
      if (a[0] === '(未归属)') return 1;
      if (b[0] === '(未归属)') return -1;
      return parseInt(a[0].slice(1), 10) - parseInt(b[0].slice(1), 10);
    });
    return sorted.map(([label, g]) => {
      const subs: SubGroup[] = [...g.subs.entries()]
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

  const toggle = (label: string): void => {
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  if (!index) {
    return <div className="tree-loading">索引中…</div>;
  }

  return (
    <div className="file-tree">
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
        <button className="ghost small" onClick={() => setOpened(new Set())}>
          折叠全部
        </button>
      </div>
      <ul className="tree-groups">
        {visible.map((g) => {
          const isOpen = opened.has(g.label) || filter.length > 0;
          return (
            <li key={g.label} className="tree-group">
              <button className="tree-group-btn" onClick={() => toggle(g.label)}>
                <span className="caret">{isOpen ? '▾' : '▸'}</span>
                <span className="group-label">{g.label}</span>
                <span className="group-count">{g.total}</span>
              </button>
              {isOpen ? (
                <ul className="tree-files">
                  {g.subs.map((s) => (
                    <li key={s.label ?? '(根目录)'}>
                      {s.label !== null ? (
                        <div className="tree-author" title={s.label}>
                          <span className="tree-author-name">{s.label}</span>
                          <span className="group-count">{s.files.length}</span>
                        </div>
                      ) : null}
                      <ul className={`tree-files ${s.label !== null ? 'nested' : ''}`}>
                        {s.files.map((f) => (
                          <li key={f}>
                            <button
                              className={`tree-file ${f === activeFile ? 'active' : ''}`}
                              title={f}
                              onClick={() => onOpenFile(f)}
                            >
                              {f.split(/[\\/]/).pop()}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
