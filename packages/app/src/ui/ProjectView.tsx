import type { ReactElement } from 'react';
import type { Kernel } from '@kojo/kernel';
import type { ErbIndex, GameProject } from '@kojo/plugin-api';
import { EditorPane } from './EditorPane';
import { FileTree } from './FileTree';
import { PanelHost } from './PanelHost';

interface Props {
  kernel: Kernel;
  project: GameProject;
  index: ErbIndex | null;
  indexing: boolean;
  activeFile: string | null;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}

export function ProjectView({ kernel, project, index, indexing, activeFile, onOpenFile, onClose }: Props): ReactElement {
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
          {activeFile ? (
            <EditorPane kernel={kernel} filePath={activeFile} />
          ) : (
            <div className="empty-state">
              <p>从左侧选择一个口上文件开始编辑</p>
              <p className="dim">
                项目已索引 {fileCount} 个 ERB 文件、{fnCount} 个函数定义（口上域全量）
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
