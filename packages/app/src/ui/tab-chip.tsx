/**
 * 标签视觉件（欢迎页第九批抽出，用户要求：标签页样式保留以便复用，但欢迎页不再渲染标签）。
 *
 * 视觉语言沿用原欢迎标签：`--bg` 底、1px 细描边、顶缘 2px accent 内高光、上圆角，
 * 形态是一枚「贴附在面板上缘」的 chip，而不是工作区标签条。当前不参与任何页面渲染，
 * 先作为可复用件与 SSR 形状锁保留；未来做真正的标签面时直接接这里，不再抄第二份配色。
 */
import type { ReactElement } from 'react';
import { Icon, type IconName } from './icons';
import './tab-chip.css';

export interface TabChipProps {
  readonly label: string;
  readonly icon?: IconName;
  /** 活动态（顶缘 accent 高光 + 前景提亮）；缺省 false */
  readonly active?: boolean;
  /** 给则渲染关闭钮；文案进 aria-label / title */
  readonly onClose?: () => void;
  readonly closeLabel?: string;
}

export function TabChip({
  label,
  icon,
  active = false,
  onClose,
  closeLabel,
}: TabChipProps): ReactElement {
  const closeText = closeLabel ?? `关闭${label}`;
  return (
    <div className={`tab-chip${active ? ' is-active' : ''}`}>
      {icon === undefined ? null : <Icon name={icon} size={14} className="tab-chip-icon" />}
      <span className="tab-chip-label">{label}</span>
      {onClose === undefined ? null : (
        <button
          type="button"
          className="tab-chip-close"
          aria-label={closeText}
          title={closeText}
          onClick={onClose}
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}
