/**
 * KitSearchField —— 检索输入井的单品叶子（1026 kit-converge C1-b / VIS-42）。
 *
 * 现状是搜索框五份独立实现（`.kb-search-input` / `.launcher-search-input` /
 * `.mk-search-wrap` / `.settings-search-input` / `.settings-searchbar`），真机缺陷：
 * 设置浮层那枚放大镜落在输入框**外沿**（图标与输入框是并列兄弟、边框只画在 input 上）。
 * 本件把「井」做成主体：边框 / 焦点环 / 井底都住在 `.kit-search-field` 这一层，
 * 图标、输入、右侧动作槽、清空钮全在**框内**。度量基线 = 检索面板 `ksp-*`
 * （井 26px、框内输入净高 24 撑满井口、清空钮走 `kit-icon-btn` 的 24×24 热区语言）。
 *
 * 叶子纪律照 `kit-radio`：消费方直引本文件，不经桶棒。井内 input **不强加 kit 类**——
 * 判据锚类（如 `search-input ksp-input`）由 `inputClassName` 逐字落上，井内 reset
 * 吃 `.kit-search-field input` 元素选择器，特异性照样赢。
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';

/** 类名拼接（ui-kit 总纲里那枚私有小工具；叶子各自内联一份） */
const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');

export interface KitSearchFieldProps {
  value: string;
  /** 直接给字符串，不向调用方泄漏 event（ui-kit 族规） */
  onChange: (value: string) => void;
  /** 无障碍名**必传**：没有名字的控件不许存在 */
  ariaLabel: string;
  placeholder?: string;
  title?: string;
  /** 框内前导图标（放大镜等；`aria-hidden` 由本件兜住）。缺省不画——`ksp` 档无图标 */
  icon?: ReactNode;
  /** 右侧动作槽：框内 toggle 组 / 过滤胶囊等，排在清空钮之前 */
  actions?: ReactNode;
  /** 给了 ⇒ 值非空时出清空钮（清空语义交回调用方：聚焦、 Esc、历史都随它） */
  onClear?: () => void;
  /** 清空钮外观（推荐 `<Icon name="close"/>`，颜色走 currentColor） */
  clearIcon?: ReactNode;
  /** 清空钮无障碍名（缺省「清空输入」） */
  clearLabel?: string;
  /** 输入类型（缺省 `search`；检索面板传 `text`——`type=search` 自带原生 Esc 清空腿，会改既有键行为） */
  type?: 'search' | 'text';
  /** 判据锚类：逐字落进 input 的 class，前面**不垫**任何 kit 类 */
  inputClassName?: string;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  /** 面板要程序化聚焦/失焦输入框（headRef 同族需求） */
  inputRef?: Ref<HTMLInputElement>;
  autoComplete?: 'on' | 'off';
  spellCheck?: boolean;
  disabled?: boolean;
  id?: string;
  /** 井本体（宿主面板）的追加类 */
  className?: string;
}

/** 检索输入井：图标在框内 · 右侧动作槽 · 清空钮（值非空才出现）。 */
export function KitSearchField({
  value,
  onChange,
  ariaLabel,
  placeholder,
  title,
  icon,
  actions,
  onClear,
  clearIcon,
  clearLabel = '清空输入',
  type = 'search',
  inputClassName,
  onKeyDown,
  inputRef,
  autoComplete,
  spellCheck,
  disabled = false,
  id,
  className,
}: KitSearchFieldProps): ReactElement {
  return (
    <span className={cx('kit-search-field', className)}>
      {icon !== undefined ? (
        <span className="kit-search-field-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <input
        id={id}
        ref={inputRef}
        type={type}
        className={inputClassName}
        value={value}
        placeholder={placeholder}
        title={title}
        aria-label={ariaLabel}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {actions}
      {onClear !== undefined && value !== '' ? (
        <button
          type="button"
          className="kit-icon-btn kit-search-field-clear"
          data-size={14}
          aria-label={clearLabel}
          title={clearLabel}
          disabled={disabled}
          onClick={onClear}
        >
          {clearIcon}
        </button>
      ) : null}
    </span>
  );
}
