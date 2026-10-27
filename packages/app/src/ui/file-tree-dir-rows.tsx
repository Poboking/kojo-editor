/**
 * 目录真实内容行（递归渲染）——文件树唯一的"一行行怎么画"出口
 * （FE-REF ⑤ 自 `FileTree.tsx` 的 `dirRows` 逐字搬出，闭包变量改为显式 props）。
 *
 * 本组件**无状态**：目录缓存、展开集合、行内编辑态一律由宿主传入，因此口上视图的
 * 包层与文件系统视图的根层复用**同一套**渲染（两条视图线的行样式/权限标记/诊断徽标/右键口径
 * 不可能再分叉）。递归没有深度上限（语料里有五层深的包内目录），`depth === 0` 的
 * 去重规则必须与 `visibleEntries` 同一口径。
 *
 * 选中态与诊断量**不进 props**（PERF 批）：两者都由行组件自己订阅模块级 store，
 * 本组件因此对"谁被选中""谁有诊断"一无所知——切标签时不重画任何一层。
 */
import { memo, useSyncExternalStore, type ReactElement } from 'react';
import { Icon } from './icons';
import { BINARY_EXT, erbExt, middleEllipsis, sortedDirsAndFiles, TREE_LABEL_MAX } from './file-tree-model';
import { isRowActive, subscribeSelection } from './file-tree-selection';
import {
  isRowSelected,
  setSelected,
  subscribeMultiSelection,
  toggleSelected,
} from './file-tree-multi-selection';
import { useRowProblems } from './file-tree-problem-view';
import { pkey } from './file-tree-ops';
import { ROW_PROB_SCOPE, TreeProbMark } from './file-tree-row';
import { EditRow } from './file-tree-rows';
import type { OpenFileOptions } from './tabs-ops';
import type { DirState, EditState } from './file-tree-types';

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
  readonly setEditValue: (v: string) => void;
  readonly commitEdit: () => void;
  readonly cancelEdit: () => void;
  readonly toggleSub: (dir: string) => void;
  readonly onOpenFile: (path: string, opts?: OpenFileOptions) => void;
  /**
   * `aria-level` 的基准（WS-11）：这一层第 0 深度对应的层级。
   *
   * 缩进（`depth`）与层级（`aria-level`）是两件事——文件系统视图单根铺开时第 0 层就是树的第 1 层，
   * 而包内真实文件夹的第 0 层住在第 3 层。缺省 1 ⇒ 老调用点零改动。
   */
  readonly levelBase?: number;
}

/**
 * 一份目录清单的排序结果已上移到 `file-tree-model.sortedDirsAndFiles`（WS-12）：
 * 渲染侧与扁平行模型侧（`file-tree-flat`）必须读同一份顺序，各排一遍迟早漂。
 *
 * 文件系统视图里的一条**文件行**（从 `DirRows` 的 `files.map` 里提出来，PERF 批）。
 *
 * 提出来只为一件事：选中态与诊断量都由行自己订阅（`file-tree-selection` /
 * `file-tree-problem-view`），不再从 `DirRows` 的 props 穿进来。`DirRows` 因此对
 * "谁是活动文件""谁有诊断"一无所知 ⇒ 切标签 / 诊断版本翻新时整层目录行零重画，
 * 只有真变了的那一行翻自己的快照。
 *
 * props 全是值（`label` 已在调用点裁好）⇒ `memo` 浅比较能挡住同层其它行的重画；
 * 压缩包/资源那一档根本不走这里（见 `BINARY_EXT` 分支）：它们在编辑器里打不开，
 * 注册表里没有键——给没有数据的地方留一枚徽章位就是造假。
 */
const DirFileRow = memo(function DirFileRow(props: {
  path: string;
  isErb: boolean;
  label: string;
  level: number;
  onOpenFile: (path: string, opts?: OpenFileOptions) => void;
}): ReactElement {
  const active = useSyncExternalStore(
    subscribeSelection,
    () => isRowActive(props.path),
    () => isRowActive(props.path),
  );
  const selected = useSyncExternalStore(
    subscribeMultiSelection,
    () => isRowSelected(props.path),
    () => isRowSelected(props.path),
  );
  const prob = useRowProblems(props.path);
  return (
    <button
      // class 串用 join 拼，尾随空格会让精确串断言失配（见 `file-tree-row.FileRow`）
      className={[
        'tree-file',
        active && 'active',
        selected && !active && 'multi-selected',
        !props.isErb && 'tree-extra-file',
      ]
        .filter(Boolean)
        .join(' ')}
      role="treeitem"
      aria-level={props.level}
      aria-selected={selected}
      // 整棵树只有一个 tab 停靠点（roving tabindex，判据与接线见 `FileTree` 的 WS-11 那一段）
      tabIndex={-1}
      data-tid={props.path}
      aria-current={active ? 'true' : undefined}
      // 多选态给读屏 / 测试一个稳定挂点（不与 aria-current 的"当前项"语义抢位）
      data-multi-selected={selected ? 'true' : undefined}
      title={props.isErb ? props.path : `${props.path}（附加文件，不在口上索引内）`}
      data-locate={props.path}
      data-context-surface="file-tree"
      data-tree-kind="file"
      data-tree-path={props.path}
      onClick={(e) => {
        // Shift + 单击 = 连选（动作在树容器的冒泡侧，判据住 `file-tree-keyboard`）：
        // 这一行什么都不做，绝不能把"连选"顺手变成"打开"。
        if (e.shiftKey) {
          e.preventDefault();
          return;
        }
        // 与 `file-tree-row.FileRow` 同一口径：Ctrl / Cmd = 勾选（不打开），纯单击 = 收回单选并预览。
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          toggleSelected(props.path);
          return;
        }
        setSelected([props.path]);
        props.onOpenFile(props.path, { preview: true });
      }}
    >
      {props.label}
      {prob ? <TreeProbMark scope={ROW_PROB_SCOPE} error={prob.error} warning={prob.warning} /> : null}
    </button>
  );
});

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
    setEditValue,
    commitEdit,
    cancelEdit,
    toggleSub,
    onOpenFile,
    levelBase = 1,
  } = props;
  /** 这一层的 `aria-level`（缩进仍走 depth，层级另算——见 props 上那条注释） */
  const level = levelBase + depth;
  const state = dirCache.get(dir);
  if (state === undefined) return [];
  if (state === 'loading' || state === 'error') {
    return [
      <li key={`${dir}::note`} className="tree-note" role="presentation">
        {state === 'loading' ? '读取目录…' : '目录读取失败（需要桌面壳权限）'}
      </li>,
    ];
  }
  const sorted = sortedDirsAndFiles(state);
  // 包根层：与平铺列表同级的 ERB 在这里略过（判据与 `visibleEntries` 同一条）
  const visibleFiles = depth === 0 ? sorted.files.filter((d) => !skip.has(pkey(d.path))) : sorted.files;
  if (sorted.dirs.length === 0 && visibleFiles.length === 0) {
    return [<li key={`${dir}::empty`} className="tree-note" role="presentation">（空目录）</li>];
  }
  const dirs = sorted.dirs;
  const files = visibleFiles;
  /** 缩进步进由 `--tree-indent`（`.file-tree` 上定义，14px）派生：depth 每加一层正好一档。
   *  像素真源不住 TS（与 OutlinePanel 的 `--outline-depth` 同族：深度是数据，算式在 CSS）。 */
  const pad = { paddingLeft: `calc(var(--tree-indent) * ${depth})` };
  /** 该层正在新建（输入行插在本层最上）；与 rename 行共用 EditRow */
  const creatingHere = edit?.mode === 'create' && edit.dir === dir ? edit : null;
  return [
    ...(creatingHere
      ? [
          <li key={`${dir}::create`} style={pad} role="presentation">
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
        // 包装层不进可达性树（`role="none"`）：`role="treeitem"` 住在里面那枚行元素上，
        // 层级由 `aria-level` 明说 ⇒ 读屏报得出的层级与键盘走的层级是同一个数（WS-11）
        <li key={d.path} role="none">
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
              role="treeitem"
              aria-level={level}
              aria-expanded={subOpen.has(d.path)}
              aria-selected={false}
              tabIndex={-1}
              data-tid={d.path}
              title={d.path}
              data-drop-dir={d.path}
              data-context-surface="file-tree"
              data-tree-kind="dir"
              data-tree-path={d.path}
              onClick={(e) => {
                if (e.shiftKey) {
                  // Shift + 单击 = 连选（动作在树容器的冒泡侧）；不改展开现场
                  e.preventDefault();
                  return;
                }
                toggleSub(d.path);
              }}
            >
              <span className="caret">
                <Icon name={subOpen.has(d.path) ? 'chevron-down' : 'chevron-right'} size={12} />
              </span>
              <span className="tree-dir-name">{glossOf(d.name)}</span>
            </button>
          )}
          {subOpen.has(d.path) ? (
            <ul className="tree-files nested" role="group">
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
          <li key={d.path} style={pad} role="presentation">
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
        <li key={d.path} className="tree-extra" style={pad} role="presentation" title={`${d.path}（压缩包/资源，不在编辑器内打开）`}>
          <span className="tree-extra-name">{glossOf(d.name)}</span>
        </li>
      ) : (
        <li key={d.path} style={pad} role="none">
          <DirFileRow
            path={d.path}
            isErb={erbExt(d.name)}
            label={middleEllipsis(glossOf(d.name), TREE_LABEL_MAX)}
            level={level}
            onOpenFile={onOpenFile}
          />
        </li>
      );
    }),
  ];
});
