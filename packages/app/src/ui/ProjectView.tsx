import type { ReactElement } from 'react';
import type { Kernel } from '@kojo/kernel';
import type { ErbIndex, GameProject } from '@kojo/plugin-api';
import type { RevealTarget } from './App';
import { EditorPane } from './EditorPane';
import { FileTree } from './FileTree';
import { PanelHost } from './PanelHost';

interface Props {
  kernel: Kernel;
  project: GameProject;
  index: ErbIndex | null;
  indexing: boolean;
  activeFile: string | null;
  reveal: RevealTarget | null;
  onOpenFile: (path: string) => void;
  /** 编辑器脏状态上抛（切换文件确认用，审阅 M4 修复） */
  onDirtyChange?: (dirty: boolean) => void;
  /** 保存句柄注册（"保存并前往"流程用） */
  registerSave?: (fn: (() => Promise<boolean>) | null) => void;
  onClose: () => void;
  /** 写权限状态（P0 状态栏徽章 + 保存置灰；宿主通用 chrome，零业务词） */
  writable: boolean;
  /** 重授权入口（徽章点击 / 通知 action 共用） */
  onReauth: () => void;
}

export function ProjectView({
  kernel,
  project,
  index,
  indexing,
  activeFile,
  reveal,
  onOpenFile,
  onDirtyChange,
  registerSave,
  onClose,
  writable,
  onReauth,
}: Props): ReactElement {
  const panels = kernel.slots.query('ui.panel');

  // 统计（v0.1 验收指标：角色数 / 文件数 / 函数数）
  let fileCount = 0;
  let fnCount = 0;
  if (index) {
    for (const f of index.files.values()) {
      fileCount++;
      fnCount += f.functions.length;
    }
  }

  return (
    <div className="project">
      <header className="project-header">
        <div className="proj-title">
          <strong>{project.adapterId}</strong>
          <span className="proj-dir" title={project.rootDir}>
            {project.rootDir}
          </span>
        </div>
        <div className="proj-stats">
          <span>角色 {project.charaIndex.size}</span>
          <span>文件 {indexing ? '…' : fileCount}</span>
          <span>函数 {indexing ? '…' : fnCount}</span>
        </div>
        <button className="ghost" onClick={onClose}>
          关闭项目
        </button>
      </header>

      <div className="project-body">
        <aside className="sidebar">
          <section className="panel file-panel">
            <h3>口上文件</h3>
            <FileTree project={project} index={index} activeFile={activeFile} onOpenFile={onOpenFile} />
          </section>

          {/* 槽位渲染：本项目的全部 ui.panel 贡献（order 排序） */}
          {panels.map((p) => (
            <PanelHost key={p.id} contribution={p} />
          ))}
        </aside>

        <main className="editor-host">
          {/* 只读横幅（P0 实机反馈修复）：重授权入口不能只靠底部窄徽章——常驻可见可点 */}
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
        </main>
      </div>

      {/* P0 简化状态栏（P1 换五区骨架、P3 槽位化）：写权限徽章常驻——安全相关信息不隐藏 */}
      <footer className="statusbar">
        {writable ? (
          <span className="sb-writable ok" title="写权限已批准">
            可写
          </span>
        ) : (
          <button className="sb-writable ro" title="只读：写权限未批准，点击重新授权" onClick={onReauth}>
            只读
          </button>
        )}
      </footer>
    </div>
  );
}
