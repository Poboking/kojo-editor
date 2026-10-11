import { useMemo, useState, type ReactElement } from 'react';
import type { Kernel } from '@kojo/kernel';
import type { ErbIndex, GameProject, UIPanelContribution } from '@kojo/plugin-api';
import type { RevealTarget } from './App';
import { EditorPane } from './EditorPane';
import { FileTree } from './FileTree';
import { ShellLayout, type EditorStatusInfo } from './ShellLayout';

interface Props {
  kernel: Kernel;
  project: GameProject;
  index: ErbIndex | null;
  indexing: boolean;
  /** 索引构建失败原因（P0 实机反馈：两个树同时空必须能自解释，不能静默） */
  indexError: string | null;
  activeFile: string | null;
  reveal: RevealTarget | null;
  onOpenFile: (path: string) => void;
  /** 编辑器脏状态（切换文件确认用，审阅 M4 修复；状态栏保存态指示用） */
  editorDirty: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  /** 保存句柄注册（"保存并前往"流程用） */
  registerSave?: (fn: (() => Promise<boolean>) | null) => void;
  onClose: () => void;
  /** 重载项目（并行线新增：索引失败/状态过期时重开同目录，不切欢迎页） */
  onReload: () => void;
  /** 写权限状态（P0 状态栏徽章 + 保存置灰；宿主通用 chrome，零业务词） */
  writable: boolean;
  /** 重授权入口（徽章点击 / 通知 action 共用） */
  onReauth: () => void;
}

/**
 * 项目视图（UI 重设计批 P1）：壳层 = 五区布局（ShellLayout），
 * 编辑器区内容（只读横幅 + 编辑器/空态）作为 children 注入。
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
  reveal,
  onOpenFile,
  editorDirty,
  onDirtyChange,
  registerSave,
  onClose,
  onReload,
  writable,
  onReauth,
}: Props): ReactElement {
  const [editorStatus, setEditorStatus] = useState<EditorStatusInfo | null>(null);

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
      dirty={editorDirty}
      stats={{ fileCount, fnCount, indexing, indexError }}
      commandCtx={{ project, ...(activeFile ? { activeFile } : {}) }}
      onCloseProject={onClose}
      onReloadProject={onReload}
      quickOpenFiles={quickOpenFiles}
      onOpenFile={onOpenFile}
    >
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
            revealLine={reveal?.line}
            revealNonce={reveal?.nonce}
            onDirtyChange={onDirtyChange}
            registerSave={registerSave}
            writable={writable}
            onReauth={onReauth}
            onStatusInfo={setEditorStatus}
          />
        ) : (
          <div className="empty-state">
            <p>从左侧选择一个口上文件开始编辑</p>
            <p className="dim">
              项目已索引 {fileCount} 个 ERB 文件、{fnCount} 个函数定义（口上域全量）
            </p>
          </div>
        )}
      </div>
    </ShellLayout>
  );
}
