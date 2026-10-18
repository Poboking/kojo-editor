/**
 * 目录真实内容行（递归渲染）——文件树唯一的"一行行怎么画"出口
 * （FE-REF ⑤ 自 `FileTree.tsx` 的 `dirRows` 逐字搬出，闭包变量改为显式 props）。
 *
 * 本组件**无状态**：目录缓存、展开集合、行内编辑态一律由宿主传入，因此口上视图的
 * 包层与文件系统视图的根层复用**同一套**渲染（两条视图线的行样式/权限标记/右键口径
 * 不可能再分叉）。递归没有深度上限（语料里有五层深的包内目录），`depth === 0` 的
 * 去重规则必须与 `visibleEntries` 同一口径。
 */
import { memo, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import type { DirEntry } from '@kojo/plugin-api';
import { Icon } from './icons';
import { BINARY_EXT, erbExt } from './file-tree-model';
import { pkey } from './file-tree-ops';
import { EditRow } from './file-tree-rows';
import type { DirState, EditState, MenuScope } from './file-tree-types';

export interface DirRowsProps {
  /** 本层目录（绝对路径；缓存键与 key 前缀都用它） */
  readonly dir: string;
  readonly depth: number;
  /** 包层已平铺的 ERB 键集（只在 depth === 0 生效，见 `visibleEntries`） */
  readonly skip: ReadonlySet<string>;
  /** 目录列举缓存（宿主持有；本层没键 = 什么都不画，由宿主决定占位文案） */
  readonly dirCache: ReadonlyMap<string, DirState>;
  readonly subOpen: ReadonlySet<string>;
  /** 行内编辑态（宿主持有；create 插在本层最上，rename 把命中那行换成输入框） */
  readonly edit: EditState | null;
  readonly editValue: string;
  readonly glossOf: (name: string) => string;
  readonly activeFile: string | null;
  readonly setEditValue: (v: string) => void;
  readonly commitEdit: () => void;
  readonly cancelEdit: () => void;
  readonly toggleSub: (dir: string) => void;
  readonly openMenu: (e: ReactMouseEvent, scope: MenuScope) => void;
  readonly onOpenFile: (path: string) => void;
}

/**
 * 一份目录清单的排序结果（PS-6 第 4 项）。
 *
 * `localeCompare` 是这批行里最贵的一步：旧实现每次渲染、每一层都要把整份清单重排一遍，
 * 一次外部改动重列 K 层就是 K 次全排序，而清单内容压根没换。
 * 键用**条目数组的引用**（`DirEntry[]` 由 `listDir` 一次产出、放进 dirCache 就不再变），
 * ⇒ 数组身份 = 内容身份；列举换新数组自然就是新的一格，不会捞到旧顺序。
 * WeakMap ⇒ 目录从缓存里退场时这份排序跟着被回收，不留第二条不衰减的内存。
 */
const sortedByEntries = new WeakMap<readonly DirEntry[], { dirs: DirEntry[]; files: DirEntry[] }>();

function sortedDirsAndFiles(entries: readonly DirEntry[]): { dirs: DirEntry[]; files: DirEntry[] } {
  const hit = sortedByEntries.get(entries);
  if (hit) return hit;
  const byName = (a: DirEntry, b: DirEntry): number => a.name.localeCompare(b.name);
  const out = {
    dirs: entries.filter((d) => d.isDirectory).sort(byName),
    files: entries.filter((d) => !d.isDirectory).sort(byName),
  };
  sortedByEntries.set(entries, out);
  return out;
}

/**
 * 一个目录的真实内容行（递归）。目录可再展开；文件按类型给不同处置。
 *
 * PS-16 memo 化：`subOpen` / `dirCache` / `edit` 等引用型 props 由宿主稳定持有，
 * 树内无关 state（菜单、批注、过滤前帧）翻动时整层跳过；递归子层经 `{...props}`
 * 展开传播同一批引用 ⇒ 父层重渲时未变的子层也整层跳过。回调不稳定的宿主形态
 * 会让 memo 失效（见 `FileTree.tsx` 的 useCallback 链）。
 *
 * `skip` 只在**包根那一层**生效：那里的 ERB 与包层平铺列表同级重复（同一个东西在
 * 同一个视觉层级出现两遍），所以略过。**嵌套目录必须如实显示自己的 ERB**——
 * 它们住在另一层，不是重复；若一并略过，装了 10 个面文件的子目录会被渲染成空目录，
 * 等于谎报文件系统（实测语料 `灵梦-少女之梦/没写的` 就有 10 个 ERB）。
 *
 * 口径与 `visibleEntries` 逐字相同（depth===0 才按 pkey 去重），只是**先去重再排序**
 * 改成"排好序再按同一把尺滤"——顺序不变、行数不变，省掉的是每帧重排。
 */
export const DirRows = memo(function DirRows(props: DirRowsProps): ReactElement[] {
  const {
    dir,
    depth,
    skip,
    dirCache,
    subOpen,
    edit,
    editValue,
    glossOf,
    activeFile,
    setEditValue,
    commitEdit,
    cancelEdit,
    toggleSub,
    openMenu,
    onOpenFile,
  } = props;
  const state = dirCache.get(dir);
  if (state === undefined) return [];
  if (state === 'loading' || state === 'error') {
    return [
      <li key={`${dir}::note`} className="tree-note">
        {state === 'loading' ? '读取目录…' : '目录读取失败（需要桌面壳权限）'}
      </li>,
    ];
  }
  const sorted = sortedDirsAndFiles(state);
  // 包根层：与平铺列表同级的 ERB 在这里略过（判据与 `visibleEntries` 同一条）
  const visibleFiles = depth === 0 ? sorted.files.filter((d) => !skip.has(pkey(d.path))) : sorted.files;
  if (sorted.dirs.length === 0 && visibleFiles.length === 0) {
    return [<li key={`${dir}::empty`} className="tree-note">（空目录）</li>];
  }
  const dirs = sorted.dirs;
  const files = visibleFiles;
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
            <ul className="tree-files nested">
              <DirRows {...props} dir={d.path} depth={depth + 1} skip={skip} />
            </ul>
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
});
