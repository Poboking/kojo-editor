/**
 * KitRadio —— 自绘单选点（`ui-kit` 单品叶子）。
 *
 * 为什么从 `./index.tsx` 拆出来（PS-10 减面批）：`./index.tsx` 是 ui-kit 的**桶棒**，
 * 曾把全部 10 件收在一份 19.6 KB 源码里；而开机图里只有真用到的那一件需要同步可得——
 * `kojo2-cutover-settings.tsx`（唯一在图内的消费方）只用 `KitRadio`，引桶棒就把其余九件
 * 整包拖进欢迎页。拆成单品叶子、消费方直引本文件后，桶棒（`./index.tsx`）整份出图
 * （约 −18 KB），功能面一枚不少（桶棒仍 re-export 本件，懒面既有 `from '../ui-kit'` 不用改）。
 *
 * 纪律与 a11y 基线沿用 ui-kit 总纲：类名 `kit-` 前缀、只吃 token、隐藏的真 `<input type="radio">`
 * 承载键盘 / 读屏语义，`aria-label` 落在无可见文字的那一档。
 */
import type { ReactElement, ReactNode } from 'react';

/** 类名拼接（ui-kit 总纲里那枚私有小工具；叶子各自内联一份，不为一行工具拉桶棒进图） */
const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');

export interface KitRadioProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  children?: ReactNode;
  /** 同组互斥的 DOM name（一组 KitRadio 共用一枚） */
  name?: string;
  value?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/** 自绘单选点：视觉隐藏的真 `<input type="radio">` + 圆环芯（替掉 kojo2-cutover 的原生档）。 */
export function KitRadio({
  checked,
  onChange,
  label,
  children,
  name,
  value,
  disabled = false,
  id,
  className,
}: KitRadioProps): ReactElement {
  const Wrapper = children !== undefined ? 'label' : 'span';
  return (
    <Wrapper className={cx('kit-radio', className)}>
      <input
        id={id}
        type="radio"
        className="kit-radio-input"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        aria-label={children === undefined ? label : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="kit-radio-dot" aria-hidden="true" />
      {children !== undefined ? <span className="kit-radio-text">{children}</span> : null}
    </Wrapper>
  );
}