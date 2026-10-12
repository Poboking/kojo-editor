import type { ReactElement } from 'react';

interface Props {
  filePath: string;
  /**
   * 触发语境（P3 多标签批）：
   * - `close`：关闭脏标签页（按钮文案「保存并关闭」）；
   * - `switch`：旧式切换文件（保留兼容；按钮文案「保存并前往」）。
   */
  context?: 'close' | 'switch';
  /** 待前往的目标（保留或丢弃未保存修改后打开/关闭） */
  onDecide: (action: 'save-then-go' | 'discard' | 'cancel') => void;
}

/**
 * 未保存修改确认对话框（审阅 M4 修复，2026-10-10；P3 扩展关闭标签语境）。
 *
 * 关闭脏标签 / 切换文件时，若编辑器有未保存修改：
 * - 保存并关闭/前往：先保存（失败则停留并显示错误），成功后继续；
 * - 丢弃修改：直接继续（当前修改不可恢复）；
 * - 取消：留在当前状态。
 */
export function UnsavedConfirmDialog({ filePath, context = 'close', onDecide }: Props): ReactElement {
  const verb = context === 'close' ? '关闭标签页' : '切换文件';
  const saveLabel = context === 'close' ? '保存并关闭' : '保存并前往';
  return (
    <div className="modal-mask">
      <div className="modal" role="dialog" aria-modal="true" aria-label="有未保存的修改">
        <h2>有未保存的修改</h2>
        <p>
          <code>{filePath}</code> 有未保存的修改。{verb}前，请选择处理方式：
        </p>
        <div className="modal-actions">
          <button className="ghost" onClick={() => onDecide('cancel')}>
            取消
          </button>
          <button className="ghost" onClick={() => onDecide('discard')}>
            丢弃修改
          </button>
          <button className="primary" onClick={() => onDecide('save-then-go')}>
            {saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
