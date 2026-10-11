import { useMemo, useRef, useState, type ReactElement } from 'react';
import type { Kernel } from '@kojo/kernel';
import type { ErbIndex, GameProject, UIPanelContribution } from '@kojo/plugin-api';
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
    ],
    [onRequestCloseTab, onSaveAll],
  );

  const builtinViews = useMemo<UIPanelContribution[]>(
    () => [
      {
        id: 'kojo.files',
        title: '口上文件',
        icon: '🗀',
        order: 30,
        group: 'explorer',
        location: 'sidebar',
        component: () => (
          <FileTree project={project} index={index} activeFile={activeFile} onOpenFile={onOpenFile} />
        ),
      },
    ],
    [project, index, activeFile, onOpenFile],
  );

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
      {/* 标签栏（P3：中键/× 关闭；脏点 ●；溢出横向滚动） */}
      {openTabs.length > 0 ? (
        <div className="editor-tabs" role="tablist">
          {openTabs.map((p) => (
            <div
              key={p}
              role="tab"
              aria-selected={p === activeFile}
              className={`editor-tab ${p === activeFile ? 'active' : ''}`}
              title={p}
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
            writable={writable}
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
              {workbench?.hasCommand('kojo.newKojoFile') ? (
                <button className="ghost small" onClick={() => workbench.runCommand('kojo.newKojoFile')}>
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
