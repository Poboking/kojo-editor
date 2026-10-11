import type { ReactElement } from 'react';
import type { EditorSaveWarning } from '@kojo/plugin-api';

interface Props {
  warning: EditorSaveWarning;
  onDecide: (action: 'cancel' | 'save-anyway' | 'fix-and-save') => void;
}

/** 告警里最多列出的行号数（余量只给计数，避免弹窗被长列表撑爆） */
const LINE_CAP = 12;

/**
 * 保存期告警确认对话框（2026-10-12 保存接线批）。
 *
 * 目前唯一来源 = 全角空格（`EditorSaveWarning.kind === 'fullwidth-space'`，
 * 规范 §8「保存时告警」）。**默认不阻断**——"仍然保存"一键放行；另提供
 * **一键修复**（宿主把 `U+3000` 替换为半角空格后重存），尊重作者本意而不
 * 强改内容。
 */
export function SaveWarningDialog({ warning, onDecide }: Props): ReactElement {
  const lines = warning.lines.slice(0, LINE_CAP);
  return (
    <div className="modal-mask">
      <div className="modal">
        <h2>保存提醒</h2>
        <p>{warning.message}</p>
        {lines.length > 0 ? (
          <p className="dim">
            涉及行：{lines.join('、')}
            {warning.lines.length > LINE_CAP ? ` …（共 ${warning.lines.length} 行）` : ''}
          </p>
        ) : null}
        <p className="dim">全角空格多数是行中排版（注释分隔 / 台词缩进）的有意用法；请确认是否为本意。</p>
        <div className="modal-actions">
          <button className="ghost" onClick={() => onDecide('cancel')}>
            取消
          </button>
          <button className="ghost" onClick={() => onDecide('save-anyway')}>
            仍然保存
          </button>
          <button className="primary" onClick={() => onDecide('fix-and-save')}>
            替换为半角空格并保存
          </button>
        </div>
      </div>
    </div>
  );
}