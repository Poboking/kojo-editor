/**
 * ui-kit — 全站控件语言的唯一地基（批次十一 L14）。
 *
 * 收编现状（实测口径见 ui-kit/README.md）：`Switch`（ui/Switch.tsx）、分段
 * `theme-seg-btn`（styles-project.css:4242）、主题卡 `role=radio`、原生 radio
 * （kojo2-cutover-settings）、原生 checkbox + `<select>`（问题面板，全仓零 CSS）、
 * 四套计数徽标、三档空态、`↵ ⇧ ↑↓ F4` 与 `Ctrl+K Z` 混排的键位提示。
 *
 * 三条硬纪律：
 * ① 类名一律 `kit-` 前缀（与 `ksp-` / `sfb-` 同一命名法），样式全部住在
 *    `ui-kit.css`，由 main.tsx 在 styles.css 族之后加载；
 * ② 零游戏知识：本目录只谈「控件」，不谈任何项目语汇；
 * ③ 颜色 / 圆角 / 字号 / 动效**只吃 token**；需要新 token 时写
 *    `var(--xxx, <深色现值>)` 兜底并在 README 登记，`:root` 归 L01。
 *
 * a11y 基线：每个交互件都有显式语义名（`label` / `ariaLabel` **必传**——没有
 * 名字的控件不许存在）、`:focus-visible` 焦点环统一 `--shadow-focus`、命中区
 * ≥24×24（WCAG 2.5.8，P3-2 热区口径）。
 */
import {
  Fragment,
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

/* ------------------------------- 小工具 ------------------------------- */

const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');

/* ------------------------------- KitField ------------------------------- */

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

/* ------------------------------- KitCheck ------------------------------- */

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

/* ------------------------------- KitRadio ------------------------------- */

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

/* ------------------------------- KitSelect ------------------------------- */

export interface KitSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface KitSelectProps {
  value: string;
  /** 直接给选中项的 value，不泄漏 event */
  onChange: (value: string) => void;
  options: readonly KitSelectOption[];
  /** 无障碍名（原生 select 没有可见标题时必填语义） */
  ariaLabel: string;
  title?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * 下拉选择：`appearance:none` 的真 `<select>` 住在 sunken 井里 + 自绘 chevron。
 * 键盘 / 屏幕阅读器语义全部走原生（这是刻意取舍：不做 listbox 重实现，只把**外观**收进
 * 控件语言）；弹层菜单面按 token 给 `option` 底色与文字色。
 */
export function KitSelect({
  value,
  onChange,
  options,
  ariaLabel,
  title,
  disabled = false,
  id,
  className,
}: KitSelectProps): ReactElement {
  return (
    <span className={cx('kit-select', className)}>
      <select
        id={id}
        className="kit-select-input"
        value={value}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="kit-select-arrow" aria-hidden="true" />
    </span>
  );
}

/* ------------------------------ KitSegmented ------------------------------ */

export interface KitSegmentedOption<T extends string = string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface KitSegmentedProps<T extends string = string> {
  options: readonly KitSegmentedOption<T>[];
  /** 当前值；允许 null（未选，首个可选项进 Tab 序） */
  value: T | null;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

/**
 * 分段单选（收编 `theme-segment` / `theme-seg-btn` 的度量，语义升级）：
 * `role=radiogroup` + 每档 `role=radio`，方向键**换档即移焦**（APG radio group 口径），
 * Tab 只在选中档停留（roving tabIndex）。
 */
export function KitSegmented<T extends string = string>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled = false,
  className,
}: KitSegmentedProps<T>): ReactElement {
  const btnRefs = useRef<Partial<Record<string, HTMLButtonElement | null>>>({});

  const selectableAt = (i: number): boolean => {
    const o = options[i];
    return o !== undefined && !o.disabled && !disabled;
  };

  /** 从 cur 出发按 dir 绕圈找第一个可用档，选中它并把焦点带过去 */
  const move = (dir: 1 | -1): void => {
    const n = options.length;
    if (n === 0) return;
    const cur = options.findIndex((o) => o.value === value);
    for (let k = 1; k <= n; k++) {
      const i = (((cur === -1 ? (dir === 1 ? -1 : 0) : cur) + dir * k) % n + n) % n;
      if (selectableAt(i)) {
        const v = (options[i] as KitSegmentedOption<T>).value;
        onChange(v);
        btnRefs.current[v]?.focus();
        return;
      }
    }
  };

  const pickEnd = (fromStart: boolean): void => {
    const n = options.length;
    for (let k = 0; k < n; k++) {
      const i = fromStart ? k : n - 1 - k;
      if (selectableAt(i)) {
        const v = (options[i] as KitSegmentedOption<T>).value;
        onChange(v);
        btnRefs.current[v]?.focus();
        return;
      }
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'Home':
        event.preventDefault();
        pickEnd(true);
        break;
      case 'End':
        event.preventDefault();
        pickEnd(false);
        break;
      default:
        break;
    }
  };

  // 未选时首个可用档进 Tab 序（APG：radiogroup 恰有一个可聚焦成员）
  const firstSelectable = options.find((_o, i) => selectableAt(i))?.value;
  const tabbable = value ?? firstSelectable;

  return (
    <div className={cx('kit-segmented', className)} role="radiogroup" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={o.value === tabbable ? 0 : -1}
            disabled={disabled || o.disabled}
            className={cx('kit-seg-btn', selected && 'on')}
            ref={(el) => {
              btnRefs.current[o.value] = el;
            }}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------ KitIconButton ------------------------------ */

/** 图标尺寸四档契约（L10 图标体系批：12 / 14 / 16 / 22） */
export type KitIconSize = 12 | 14 | 16 | 22;

export interface KitIconButtonProps {
  /** 必传：按钮的无障碍名（同时落 `aria-label` 与缺省 `title`）——无名钮不许存在 */
  label: string;
  /** 图标内容（推荐 `<Icon name="…" />`，颜色走 currentColor） */
  children: ReactNode;
  onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  /** toggle 型钮：给了就落 `aria-pressed`，on 态走 accent 语言（ksp-toggle 口径） */
  active?: boolean;
  /** 比 label 更详细的悬停解释；label 仍是无障碍名 */
  hint?: string;
  size?: KitIconSize;
  type?: 'button' | 'submit' | 'reset';
  className?: string;
}

/**
 * 图标按钮：静息无框、hover / focus 才出面（ksp-icon-btn 度量：22 见方盒、
 * `::before` 透明热区补到 24×24）。盒宽 = max(22, glyph+6)，glyph 档位写进
 * `--kit-ib-glyph`，内部 svg 尺寸跟着档位走。
 */
export function KitIconButton({
  label,
  children,
  onClick,
  disabled = false,
  active,
  hint,
  size = 16,
  type = 'button',
  className,
}: KitIconButtonProps): ReactElement {
  return (
    <button
      type={type}
      className={cx('kit-icon-btn', active !== undefined && active && 'on', className)}
      data-size={size}
      aria-label={label}
      aria-pressed={active}
      title={hint ?? label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/* --------------------------------- KitKbd --------------------------------- */

/** 键位归一语言：修饰键用词（Ctrl/Alt/Shift/Win），方向键用符号（↑↓←→），其余用词。 */
const KBD_ALIASES: Readonly<Record<string, string>> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  meta: 'Win',
  cmd: 'Win',
  command: 'Win',
  super: 'Win',
  win: 'Win',
  windows: 'Win',
  up: '↑',
  arrowup: '↑',
  down: '↓',
  arrowdown: '↓',
  left: '←',
  arrowleft: '←',
  right: '→',
  arrowright: '→',
  enter: 'Enter',
  return: 'Enter',
  esc: 'Esc',
  escape: 'Esc',
  tab: 'Tab',
  space: 'Space',
  plus: '+',
};

export function kbdTokenLabel(token: string): string {
  const t = token.trim();
  const alias = KBD_ALIASES[t.toLowerCase()];
  if (alias !== undefined) return alias;
  return t.length === 1 ? t.toUpperCase() : t;
}

export interface KitKbdProps {
  /** 单串 = 一个组合（`"Shift+Alt+F"`）；数组 = 和弦分步（`["Ctrl+K", "Z"]`） */
  combo: string | readonly string[];
  className?: string;
}

/** 键位提示统一语言：一枚 `<kbd>`，组合内逐键芯片 + 淡色 `+`，和弦步之间留沟。 */
export function KitKbd({ combo, className }: KitKbdProps): ReactElement {
  const chords = (Array.isArray(combo) ? combo : [combo]).map((c) =>
    c
      .split('+')
      .map(kbdTokenLabel)
      .filter((k) => k !== ''),
  );
  return (
    <kbd className={cx('kit-kbd', className)} aria-label={Array.isArray(combo) ? combo.join(' 然后 ') : combo}>
      {chords.map((keys, ci) => (
        <span key={ci} className="kit-kbd-chord">
          {keys.map((k, ki) => (
            <Fragment key={ki}>
              {ki > 0 ? (
                <span className="kit-kbd-sep" aria-hidden="true">
                  +
                </span>
              ) : null}
              <span className="kit-kbd-key">{k}</span>
            </Fragment>
          ))}
        </span>
      ))}
    </kbd>
  );
}

/* -------------------------------- KitCount -------------------------------- */

export type KitCountTone = 'neutral' | 'accent' | 'danger' | 'warning' | 'success';

export interface KitCountProps {
  value: number;
  /** 溢出阈值（含）：value > max 时显示 `${max}+`（缺省 99） */
  max?: number;
  /** 语义色档：错误计数用 danger、过滤命中用 accent……文字档保证 AA */
  tone?: KitCountTone;
  /** 悬停解释（溢出态缺省回落真实值原文） */
  title?: string;
  className?: string;
}

/** 统一计数徽标（收编四套并存徽章 + ksp-file-count）：pill、bg-3 井底、tabular-nums。 */
export function KitCount({ value, max = 99, tone = 'neutral', title, className }: KitCountProps): ReactElement {
  const overflow = value > max;
  const shown = overflow ? `${max}+` : `${value}`;
  return (
    <span
      className={cx('kit-count', tone !== 'neutral' && `kit-count-${tone}`, className)}
      title={title ?? (overflow ? `${value}` : undefined)}
      aria-label={overflow ? `${value}` : undefined}
    >
      {shown}
    </span>
  );
}

/* -------------------------------- KitEmpty -------------------------------- */

export interface KitEmptyAction {
  label: string;
  onClick: () => void;
}

export interface KitEmptyProps {
  title: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  action?: KitEmptyAction;
  /** `'stack'` = kb-empty 档（居中立列）；`'inline'` = picker-empty / settings-results-empty 档（一行灰字） */
  variant?: 'stack' | 'inline';
  /** 状态驱动的空态（搜索筛空了要播报）：落 `role="status"` */
  announce?: boolean;
  className?: string;
}

/** 统一空态：图标 + 一句标题 + 一句引导 + 可选退路动作（收编三档现状）。 */
export function KitEmpty({
  title,
  hint,
  icon,
  action,
  variant = 'stack',
  announce = false,
  className,
}: KitEmptyProps): ReactElement {
  return (
    <div
      className={cx('kit-empty', variant === 'inline' ? 'kit-empty-inline' : 'kit-empty-stack', className)}
      role={announce ? 'status' : undefined}
    >
      {icon !== undefined ? (
        <span className="kit-empty-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="kit-empty-title">{title}</span>
      {hint !== undefined ? <span className="kit-empty-hint">{hint}</span> : null}
      {action !== undefined ? (
        <button type="button" className="kit-empty-action" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------- KitSkeleton ------------------------------- */

export interface KitSkeletonProps {
  /** 文本占位条数；>0 时渲染多行骨架（替掉浮层加载态那句 `.dim`） */
  lines?: number;
  /** 单块形态的宽 / 高（数字按 px） */
  width?: number | string;
  height?: number | string;
  /** 给读取屏的加载说明；给了就落 `role="status"` + `aria-busy` */
  label?: string;
  className?: string;
}

const kitDim = (v: number | string | undefined): string | undefined =>
  typeof v === 'number' ? `${v}px` : v;

/** 骨架占位（收编 `.skeleton`）：sunken 底 + 扫光；reduced-motion 下静止。 */
export function KitSkeleton({ lines = 0, width, height, label, className }: KitSkeletonProps): ReactElement {
  const statusProps =
    label !== undefined ? { role: 'status' as const, 'aria-busy': true, 'aria-label': label } : {};
  if (lines > 0) {
    return (
      <span className={cx('kit-skeleton-stack', className)} {...statusProps}>
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="kit-skeleton kit-skeleton-line" />
        ))}
      </span>
    );
  }
  const style: CSSProperties = { width: kitDim(width), height: kitDim(height) };
  return <span className={cx('kit-skeleton', className)} style={style} {...statusProps} />;
}

export { KitGallery } from './KitGallery';
