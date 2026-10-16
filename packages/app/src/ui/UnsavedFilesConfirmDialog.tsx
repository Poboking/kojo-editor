import type { ReactElement } from 'react';
import { useModalEscape } from './modal-stack';

interface Props {
  /** 全项目当前脏的文件路径集合（来自 App 的 dirtyPaths） */
  paths: ReadonlySet<string>;
  onDecide: (action: 'save-then-close' | 'discard' | 'cancel') => void;
}

/**
 * 关项目 / 关窗的未保存确认（2026-10-16 深审 A2）。
 *
 * 关标签的 `UnsavedConfirmDialog` 是**单文件**粒度；关项目面对的是一组脏文件，
 * 选项也从"保存并关闭"变成"保存全部并关闭"。三键流与 Esc 语义同源复用
 * （modal-mask + useModalEscape）：两个有损选项（丢弃 / 覆盖盘上）之外的
 * Esc 落在"什么都没发生"那一格（HK-2 口径）。
 */
export function UnsavedFilesConfirmDialog({ paths, onDecide }: Props): ReactElement {
  useModalEscape(() => onDecide('cancel'));
  const entries = [...paths].map((p) => ({ path: p, name: p.split(/[\\/]/).pop() ?? p }));
  return (
    <div className="modal-mask">
      <div className="modal" role="dialog" aria-modal="true" aria-label="有未保存的修改">
        <h2>有未保存的修改</h2>
        <p>
          {entries.length} 个文件有未保存的修改。关闭项目前，请选择处理方式：
        </p>
        <ul className="paths">
          {entries.map((e) => (
            <li key={e.path}>
              <code>{e.name}</code>
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button className="ghost" onClick={() => onDecide('cancel')}>
            取消
          </button>
          <button className="ghost" onClick={() => onDecide('discard')}>
            丢弃修改并关闭
          </button>
          <button className="primary" onClick={() => onDecide('save-then-close')}>
            保存全部并关闭
          </button>
        </div>
      </div>
    </div>
  );
}
