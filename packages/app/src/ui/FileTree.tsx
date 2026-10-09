import { useMemo, useState, type ReactElement } from 'react';
import type { ErbIndex, GameProject } from '@kojo/plugin-api';

interface Props {
  project: GameProject;
  index: ErbIndex | null;
  activeFile: string | null;
  onOpenFile: (path: string) => void;
}

interface Group {
  label: string;
  files: string[];
}

/**
 * 口上文件树（v0.1）：按「角色目录」两段式分组 + 过滤框。
 * 函数树导航（按家族/时机三维）是 v0.2 的交付物；本版先保证"能列出全部文件"。
 */
export function FileTree({ project, index, activeFile, onOpenFile }: Props): ReactElement {
  const [filter, setFilter] = useState('');
  const [opened, setOpened] = useState<Set<string>>(new Set());

  const groups = useMemo<Group[]>(() => {
    if (!index) return [];
    // 角色目录前缀表（长前缀优先，避免嵌套目录误归属）
    const owners: Array<{ prefix: string; label: string }> = [];
    for (const c of project.charaIndex.values()) {
      if (c.kojoDir) owners.push({ prefix: c.kojoDir, label: `#${c.no} ${c.name}` });
    }
    owners.sort((a, b) => b.prefix.length - a.prefix.length);

    const map = new Map<string, string[]>();
    for (const path of index.files.keys()) {
      const owner = owners.find((o) => path.startsWith(o.prefix))?.label ?? '(未归属)';
      const arr = map.get(owner);
      if (arr) arr.push(path);
      else map.set(owner, [path]);
    }

    // 归属组按编号排（label 前缀 #n），未归属垫底
    const sorted = [...map.entries()].sort((a, b) => {
      if (a[0] === '(未归属)') return 1;
      if (b[0] === '(未归属)') return -1;
      const na = parseInt(a[0].slice(1), 10);
      const nb = parseInt(b[0].slice(1), 10);
      return na - nb;
    });
    return sorted.map(([label, files]) => ({ label, files: files.sort() }));
  }, [index, project]);

  const visible = useMemo(() => {
    if (!filter) return groups;
    const q = filter.toLowerCase();
    return groups
      .map((g) => ({ ...g, files: g.files.filter((f) => f.toLowerCase().includes(q)) }))
      .filter((g) => g.files.length > 0 || g.label.toLowerCase().includes(q));
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
                <span className="group-count">{g.files.length}</span>
              </button>
              {isOpen ? (
                <ul className="tree-files">
                  {g.files.map((f) => (
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
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
