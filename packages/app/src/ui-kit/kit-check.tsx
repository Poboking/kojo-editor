/**
 * KitCheck —— 自绘复选框的单品叶子（1026 kit-converge C2-a / VIS-41）。
 *
 * 这枚件**本来就在基座里**，但问题面板 `ui/ProblemPanel.tsx` 自己又写了一枚同名
 * `function KitCheck`，把 `import { KitCheck } from '../ui-kit'` 遮掉（同名局部声明赢
 * 过 import 绑定）——于是"已收编"在代码里看不出来，CSS 也跟着留了第二份勾盒。
 * 本叶子的职责除了把件按 `kit-radio` 的先请出桶棒，更是把"基座只有这一枚 KitCheck"
 * 变成可判定的事实（判据在 tests/kit-field-converge.test.ts）。
 *
 * 叶子纪律照 `kit-radio`：消费方直引本文件，不经桶棒。实现自 `index.tsx` 原样搬来，
 * 桶棒改为 re-export——导出面一字不变。
 */
import { type ReactElement, type ReactNode } from 'react';

/** 类名拼接（ui-kit 总纲里那枚私有小工具；叶子各自内联一份，不为一行工具拉桶棒进图） */
const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');

export interface KitCheckProps {
  checked: boolean;
  /** 直接给布尔值，不向调用方泄漏 event（Switch 同族口径） */
  onChange: (checked: boolean) => void;
  /** 无障碍名；无可见文字时落 `aria-label`，有可见文字时文字即标签 */
  label: string;
  /** 可见文字（给了就换成 label 包裹，点文字即切换） */
  children?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/** 自绘复选框：视觉隐藏的真 `<input type="checkbox">` + 井面勾盒（替掉零 CSS 的原生档）。 */
export function KitCheck({
  checked,
  onChange,
  label,
  children,
  disabled = false,
  id,
  className,
}: KitCheckProps): ReactElement {
  const Wrapper = children !== undefined ? 'label' : 'span';
  return (
    <Wrapper className={cx('kit-check', className)}>
      <input
        id={id}
        type="checkbox"
        className="kit-check-input"
        checked={checked}
        disabled={disabled}
        aria-label={children === undefined ? label : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="kit-check-box" aria-hidden="true" />
      {children !== undefined ? <span className="kit-check-text">{children}</span> : null}
    </Wrapper>
  );
}
