import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type ReactElement } from 'react';
import type { Kernel } from '@kojo/kernel';
import type { ErbIndex, GameProject, UIPanelContribution } from '@kojo/plugin-api';
import { WellKnownCommands } from '@kojo/plugin-api';
import type { RevealTarget } from './App';
import { EditorPane, type EditorPaneActions } from './EditorPane';
import { FileTree } from './FileTree';
import { ShellLayout, type EditorStatusInfo, type WorkbenchApi } from './ShellLayout';
import type { ShellCommandSpec } from './commands';

interface Props {
  kernel: Kernel;
  project: GameProject;
  index: ErbIndex | null;
  indexing: boolean;
  /** 索引构建失败原因（P0 实机反馈：两个树同时空必须能自解释，不能静默） */
  indexError: string | null;
  activeFile: string | null;
  /** 打开的标签页（P3 多标签；顺序即标签栏顺序） */
  openTabs: readonly string[];
  /** 各标签脏态（标签栏脏点 ●） */
  dirtyPaths: ReadonlySet<string>;
  reveal: RevealTarget | null;
  onOpenFile: (path: string) => void;
  /** 激活标签（点击标签 = 打开/切换；不丢内容） */
  onActivateTab: (path: string) => void;
  /** 请求关闭标签（脏标签由宿主弹确认） */
  onRequestCloseTab: (path: string) => void;
  /** 拖拽重排标签：把 path 移动到 toIndex（删除后插入语义） */
  onReorderTab: (path: string, toIndex: number) => void;
  /** 全部保存（Ctrl+Shift+S 壳层命令落地处） */
  onSaveAll: () => Promise<boolean>;
  /** 编辑器脏状态上抛（按路径；宿主维护 dirtyPaths） */
  onDirtyChange?: (path: string, dirty: boolean) => void;
  /** 编辑器动作句柄注册（宿主"保存并关闭 / 全部保存"流程用） */
  registerActions?: (actions: EditorPaneActions | null) => void;
  onClose: () => void;
  /** 重载项目（索引失败/状态过期时重开同目录，不切欢迎页） */
  onReload: () => void;
  /** 写权限状态（P0 状态栏徽章 + 保存置灰；宿主通用 chrome，零业务词） */
  writable: boolean;
  /** 重授权入口（徽章点击 / 通知 action 共用） */
  onReauth: () => void;
}

/** 标签显示名：路径末段（完整路径留 title 悬浮提示） */
function tabName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * 项目视图（UI 重设计批 P1；P3 多标签）：壳层 = 五区布局（ShellLayout），
 * 编辑器区内容 = 标签栏 + 只读横幅 + 编辑器/空态。
 *
 * 口上文件树是壳层**内建视图**，以与 `ui.panel` 槽同构的贡献形态注入
 * （group:'explorer'，与函数树合并为单 Explorer——定稿 Q5）。
 */
export function ProjectView({
  kernel,
  project,
  index,
  indexing,
  indexError,
  activeFile,
  openTabs,
  dirtyPaths,
  reveal,
  onOpenFile,
  onActivateTab,
  onRequestCloseTab,
  onReorderTab,
  onSaveAll,
  onDirtyChange,
  registerActions,
  onClose,
  onReload,
  writable,
  onReauth,
}: Props): ReactElement {
  const [editorStatus, setEditorStatus] = useState<EditorStatusInfo | null>(null);
  /** 壳层工作台 API（空态动作按钮：快速打开 / 命令面板 / 新建口上文件） */
  const [workbench, setWorkbench] = useState<WorkbenchApi | null>(null);
  /** Ctrl+W 命令读最新活动标签（壳层命令注册一次，闭包外取值） */
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;

  // 统计（v0.1 验收指标：角色数 / 文件数 / 函数数）
  let fileCount = 0;
  let fnCount = 0;
  if (index) {
    for (const f of index.files.values()) {
      fileCount++;
      fnCount += f.functions.length;
    }
  }

  // 快速打开候选（P2）：索引全量文件路径（壳层只消费泛型路径列表）
  const quickOpenFiles = useMemo<string[]>(() => (index ? [...index.files.keys()].sort() : []), [index]);

  // 编辑器区壳层命令（P3：关闭标签 / 全部保存——容器语义，零业务知识）
  const extraCommands = useMemo<readonly ShellCommandSpec[]>(
    () => [
      {
        id: 'workbench.closeActiveTab',
        title: '关闭当前标签',
        keybinding: 'ctrl+w',
        run: () => {
          const p = activeFileRef.current;
          if (p) onRequestCloseTab(p);
        },
      },
      {
        id: 'workbench.saveAll',
        title: '全部保存',
        keybinding: 'ctrl+shift+s',
        run: () => {
          void onSaveAll();
        },
      },
      {
        // 糖视图：整份 ERB 显示为语法糖（只读）。命令面板与快捷键都从这里进——
        // 与工具条按钮同一条意图事件，宿主（EditorPane）是唯一的状态所有者。
        // 标题跟其余命令同形（裸动宾、无括号，见「切换写作模式」），术语跟工具条同词
        // （「语法糖视图」，不叫"糖视图"——命令面板是作者找到这功能的入口，名字必须一致）。
        id: 'workbench.toggleSugarView',
        title: '切换语法糖视图',
        keybinding: 'ctrl+alt+t',
        run: () => {
          kernel.bus.emit('editor.sugarView.set', {});
        },
      },
    ],
    [onRequestCloseTab, onSaveAll, kernel],
  );

  // 内建文件树的**稳定组件身份**（用户反馈修复：打开文件会重建内联箭头组件 →
  // React 视作新组件类型 → 整树卸载重挂 → 展开状态被清空。改为身份恒定的包装
  // 组件 + ref 桥接最新 props：重渲染只更新属性，绝不重挂，展开状态常驻）。
  const listDir = useMemo(() => kernel.io.listDir.bind(kernel.io), [kernel]);
  // 导入作者包为工作区项目（口上项目批 P-F）：壳层只发意图事件，
  // 「导入成什么形态」由工作区消费方（适配器）解释——跨层零游戏知识
  const importPackage = useCallback(
    (pkg: { dir: string; label: string }) => {
      kernel.bus.emit('workspace.importRequested', {
        sourceDir: pkg.dir,
        suggestedName: pkg.label,
        source: 'file-tree',
      });
    },
    [kernel],
  );
  const fileTreeArgsRef = useRef({ project, index, activeFile, onOpenFile, listDir, importPackage });
  fileTreeArgsRef.current = { project, index, activeFile, onOpenFile, listDir, importPackage };
  const fileTreeComponent = useMemo(() => {
    const StableFileTree = (): ReactElement => {
      const a = fileTreeArgsRef.current;
      return (
        <FileTree
          project={a.project}
          index={a.index}
          activeFile={a.activeFile}
          onOpenFile={a.onOpenFile}
          listDir={a.listDir}
          onImportPackage={a.importPackage}
        />
      );
    };
    return StableFileTree;
  }, []);

  const builtinViews = useMemo<UIPanelContribution[]>(
    () => [
      {
        id: 'kojo.files',
        title: '口上文件',
        icon: '🗀',
        order: 30,
        group: 'explorer',
        location: 'sidebar',
        component: fileTreeComponent,
      },
    ],
    [fileTreeComponent],
  );

  /* ---------------- 标签栏：拖拽重排 + 滚轮横滚 + 活动标签滚入视口 ---------------- */

  /** 标签拖拽的自定义 MIME（只在标签条内部流转，防外部拖入误触发） */
  const TAB_DRAG_MIME = 'application/x-kojo-tab-move';
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [tabDropAt, setTabDropAt] = useState<{ path: string; before: boolean } | null>(null);

  // 活动标签保持可见（标签多到溢出时，点击树中文件也能定位到对应标签）
  useEffect(() => {
    tabsRef.current
      ?.querySelector('.editor-tab.active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeFile, openTabs.length]);

  const onTabDragStart = (e: ReactDragEvent, p: string): void => {
    e.dataTransfer.setData(TAB_DRAG_MIME, p);
    e.dataTransfer.setData('text/plain', p);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onTabDragOver = (e: ReactDragEvent, p: string): void => {
    if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    setTabDropAt({ path: p, before: e.clientX < r.left + r.width / 2 });
  };
  const onTabDrop = (e: ReactDragEvent, p: string): void => {
    const dragPath = e.dataTransfer.getData(TAB_DRAG_MIME);
    setTabDropAt(null);
    if (!dragPath || dragPath === p) return;
    e.preventDefault();
    const from = openTabs.indexOf(dragPath);
    let to = openTabs.indexOf(p);
    if (from < 0 || to < 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (e.clientX >= r.left + r.width / 2) to++;
    if (from < to) to--;
    if (from !== to) onReorderTab(dragPath, to);
  };
  const onTabDragEnd = (): void => setTabDropAt(null);

  return (
    <ShellLayout
      kernel={kernel}
      builtinViews={builtinViews}
      writable={writable}
      onReauth={onReauth}
      editorStatus={editorStatus}
      dirty={activeFile !== null && dirtyPaths.has(activeFile)}
      stats={{ fileCount, fnCount, indexing, indexError }}
      commandCtx={{ project, ...(activeFile ? { activeFile } : {}) }}
      onCloseProject={onClose}
      onReloadProject={onReload}
      quickOpenFiles={quickOpenFiles}
      onOpenFile={onOpenFile}
      extraCommands={extraCommands}
      onRegisterWorkbench={setWorkbench}
    >
      {/* 标签栏（P3：中键/× 关闭；脏点 ●；拖拽重排；滚轮横滚；溢出隐藏滚动条） */}
      {openTabs.length > 0 ? (
        <div
          ref={tabsRef}
          className="editor-tabs"
          role="tablist"
          onWheel={(e) => {
            // 垂直滚轮转横向滚动（现代编辑器的无感横滚；滚动条隐藏后这是主要滚动途径）
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
              e.currentTarget.scrollLeft += e.deltaY;
            }
          }}
        >
          {openTabs.map((p) => (
            <div
              key={p}
              role="tab"
              aria-selected={p === activeFile}
              className={`editor-tab ${p === activeFile ? 'active' : ''} ${
                tabDropAt?.path === p ? (tabDropAt.before ? 'drop-before' : 'drop-after') : ''
              }`}
              title={p}
              draggable
              onDragStart={(e) => onTabDragStart(e, p)}
              onDragOver={(e) => onTabDragOver(e, p)}
              onDrop={(e) => onTabDrop(e, p)}
              onDragEnd={onTabDragEnd}
              onClick={() => onActivateTab(p)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onRequestCloseTab(p);
                }
              }}
            >
              <span className="tab-label">{tabName(p)}</span>
              {dirtyPaths.has(p) ? <span className="tab-dirty" title="未保存">●</span> : null}
              <button
                className="tab-close"
                title="关闭标签 (Ctrl+W)"
                onClick={(e) => {
                  e.stopPropagation();
                  onRequestCloseTab(p);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {/* 只读横幅（P0 实机反馈修复）：重授权入口常驻可见可点 */}
      {!writable ? (
        <div className="ro-banner">
          <span>当前为只读：写权限未批准，保存不可用。修改仍可浏览与复制。</span>
          <button className="small" onClick={onReauth}>
            去授权
          </button>
        </div>
      ) : null}
      <div className="editor-body">
        {activeFile ? (
          <EditorPane
            kernel={kernel}
            filePath={activeFile}
            openPaths={openTabs}
            revealLine={reveal?.line}
            revealNonce={reveal?.nonce}
            onDirtyChange={onDirtyChange}
            registerActions={registerActions}
            onReauth={onReauth}
            onStatusInfo={setEditorStatus}
          />
        ) : (
          <div className="empty-state">
            <p>没有打开的文件</p>
            <div className="empty-actions">
              <button className="primary small" onClick={() => workbench?.openQuickOpen()}>
                打开文件… <span className="hint">Ctrl+P</span>
              </button>
              {workbench?.hasCommand(WellKnownCommands.NewKojoFile) ? (
                <button
                  className="ghost small"
                  onClick={() => workbench.runCommand(WellKnownCommands.NewKojoFile)}
                >
                  新建口上文件 <span className="hint">Ctrl+N</span>
                </button>
              ) : null}
              <button className="ghost small" onClick={() => workbench?.openPalette()}>
                命令面板 <span className="hint">Ctrl+Shift+P</span>
              </button>
            </div>
            <p className="dim">
              项目已索引 {fileCount} 个 ERB 文件、{fnCount} 个函数定义（口上域全量）
            </p>
          </div>
        )}
      </div>
    </ShellLayout>
  );
}
