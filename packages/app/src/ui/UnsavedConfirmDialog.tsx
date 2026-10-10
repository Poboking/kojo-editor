import type { ReactElement } from 'react';

interface Props {
  filePath: string;
  /** 待前往的目标（保留或丢弃未保存修改后打开） */
  onDecide: (action: 'save-then-go' | 'discard' | 'cancel') => void;
}

/**
 * 未保存修改确认对话框（审阅 M4 修复，2026-10-10）。
 *
 * 切换文件 / 点击校验问题跳转时，若当前编辑器有未保存修改：
 * - 保存并前往：先保存当前文件（失败则停留并显示错误），成功后切换；
 * - 丢弃修改：直接切换（当前修改不可恢复）；
 * - 取消：留在当前文件。
 */
export function UnsavedConfirmDialog({ filePath, onDecide }: Props): ReactElement {
  return (
    <div className="modal-mask">
      <div className="modal">
        <h2>有未保存的修改</h2>
        <p>
          <code>{filePath}</code> 有未保存的修改。切换文件将离开该文件，请选择处理方式：
        </p>
        <div className="modal-actions">
          <button className="ghost" onClick={() => onDecide('cancel')}>
            取消
          </button>
          <button className="ghost" onClick={() => onDecide('discard')}>
            丢弃修改
          </button>
          <button className="primary" onClick={() => onDecide('save-then-go')}>
            保存并前往
          </button>
        </div>
      </div>
    </div>
  );
}
