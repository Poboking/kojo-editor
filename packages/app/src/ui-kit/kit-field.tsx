/**
 * KitField —— 设置行模板的单品叶子（1026 kit-converge C2-c / VIS-40）。
 *
 * 「标题 + 说明 + 控件槽」的三件套行模板：两列栅格、右轴钉控件。此前各页手写
 * `.settings-row` 外壳（设置页一个文件里 40+ 次），三件套的沟宽、字号、从属线、失效态
 * 各自手抄一遍——本件把这份模板收成一副骨架。样式住 `ui-kit.css`（`.kit-field*`，只吃 token）。
 *
 * 叶子纪律照 `kit-radio`：消费方直引本文件，不经桶棒（开机图只为真用到的件付费）。
 * 实现自 `index.tsx` 原样搬来，桶棒改为 re-export——导出面一字不变。
 */
import { type ReactElement, type ReactNode } from 'react';

/** 类名拼接（ui-kit 总纲里那枚私有小工具；叶子各自内联一份，不为一行工具拉桶棒进图） */
const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');

export interface KitFieldProps {
  /** 行标题（一行话说清这项是什么） */
  title: ReactNode;
  /** 副行说明（settings-hint 语言：12px dim、行高 1.6） */
  description?: ReactNode;
  /** 控件槽：渲染在右轴（与文字列共享 16px 栅格沟） */
  control?: ReactNode;
  /** 追加在描述之后的额外内容（如 has-field 的独占行输入） */
  children?: ReactNode;
  /**
   * `'label'` = 整行即点即切（把行内第一个可标记控件当 labelee，开关行的既有做法）；
   * 默认 `'div'`。行内用 KitCheck / KitRadio 时**不要**带可见文字再套 label 行——
   * 二选一：要么 `as="label"` + 无文字控件，要么控件自带文字。
   */
  as?: 'div' | 'label';
  /** 从属项：缩进一级 + 左侧 2px 从属线 */
  nested?: boolean;
  /** 控件当前不起作用：整行降透明度、撤 hover、撤指针语义（settings-row.off 口径） */
  inactive?: boolean;
  id?: string;
  className?: string;
}

/** 设置行模板：标题 + 描述 + 控件槽，两列栅格，宽度上限 760（L09 行模板的收编目标）。 */
export function KitField({
  title,
  description,
  control,
  children,
  as = 'div',
  nested = false,
  inactive = false,
  id,
  className,
}: KitFieldProps): ReactElement {
  const Wrapper = as === 'label' ? 'label' : 'div';
  return (
    <Wrapper
      id={id}
      className={cx(
        'kit-field',
        as === 'label' && 'kit-field-clickable',
        nested && 'kit-field-nested',
        inactive && 'kit-field-inactive',
        className,
      )}
    >
      <span className="kit-field-text">
        <span className="kit-field-title">{title}</span>
        {description !== undefined ? <span className="kit-field-desc">{description}</span> : null}
        {children}
      </span>
      {control !== undefined ? <span className="kit-field-ctl">{control}</span> : null}
    </Wrapper>
  );
}
