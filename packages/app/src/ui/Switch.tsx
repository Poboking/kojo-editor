import type { ReactElement } from 'react';

interface SwitchProps {
  checked: boolean;
  /** 拨动回调，直接给布尔值——不向调用方泄漏 event，与既有偏好 setter 无缝对接 */
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** 无障碍名（视觉隐藏的真 checkbox 用；label 文本另在行内，故这里给一份等价的短名） */
  label: string;
}

/**
 * 拨动开关（VSCode 精修批 2026-10-17）：`.switch` 那套 CSS 的极小 React 封装。
 *
 * 真 `<input type="checkbox">` 视觉隐藏、由 `.switch-track` / `.switch-thumb` 呈现拨动态——
 * 保留原生 checkbox 语义（键盘空格可切、`checked` 受控、屏幕阅读器读得出），只是把外观换成
 * 更现代的开关。放进 `<label className="settings-row">` 内 ⇒ 点整行即切换。
 *
 * 刻意只接 `checked: boolean` 与 `onChange(checked)`：调用方不必再写 `e.target.checked`，
 * 也杜绝了「第二个地方偷偷读 event」的分叉。纯展示件，零状态、零副作用。
 */
export function Switch({ checked, onChange, disabled = false, label }: SwitchProps): ReactElement {
  return (
    <span className="switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
    </span>
  );
}
