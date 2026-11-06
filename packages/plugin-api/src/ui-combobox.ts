/**
 * KitCombobox —— **自绘弹层**下拉的通用单品叶子（2026-11-07 立档）。
 *
 * 为什么不是 KitSelect：ui-kit 的 `KitSelect` 刻意保留原生 `<select>`，只把外观收进
 * sunken 井；Windows WebView2 的 option 弹层由系统绘制，CSS 给它上底色不生效，
 * 深色面板一点开就是一块浅灰白。README §二 也写明「需要自绘弹层（分组、副标题）
 * 时另提件」——本件就是那一枚。
 *
 * 为什么住在 plugin-api：解耦铁律只许插件依赖 `@kojo/plugin-api`，插件不能 import
 * 宿主 app 的 ui-kit。把组件放在这里，宿主面板与所有插件共用**同一份实现**；
 * 视觉语言（`.kit-combobox-*`）住在 `ui-kit.css`，由 main.tsx 全局加载，插件只写类名。
 *
 * 本件零游戏知识、零 DOM 类型依赖（root tsconfig 只有 ES2022，故引用与事件都用结构化
 * 形状，同 `ui-condition-matrix/chara-picker.ts` 的既有做法）；键盘 / ARIA 走 APG
 * combobox 口径：↑↓ / Home / End / Enter / Space / Esc / Tab，roving `aria-activedescendant`。
 */

import { createElement, useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface KitComboboxOption {
  readonly value: string;
  readonly label: string;
  /** 右侧副信息（次要色、超长省略）；不渲染业务语义，只呈文本 */
  readonly hint?: string;
  /** 占位项：未选时显示，选中它等于清空（onChange(null)） */
  readonly placeholder?: boolean;
}

export interface KitComboboxProps {
  /** 当前值；null / '' 都视为未选 */
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
  readonly options: readonly KitComboboxOption[];
  /** 必传：没有名字的控件不许存在（ui-kit 总纲 a11y 基线） */
  readonly ariaLabel: string;
  readonly title?: string;
  /** 字段行左侧图标槽（调用方给自己的图标类名；本件不认业务图标） */
  readonly leading?: ReactNode;
  /** 字段行左侧短标签（例：字段名） */
  readonly label?: string;
  /** 弹层头部标题；给了才渲染头部 */
  readonly headTitle?: string;
  /** 弹层头部计数徽标 */
  readonly count?: number;
  /** 只有占位项时的空态文案 */
  readonly emptyText?: string;
  /** 弹层脚注（键位提示之类） */
  readonly footHint?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

/** 结构化引用 / 事件形状：不带 DOM lib，沿用 chara-picker 的既有做法 */
type FocusableLike = { focus?: () => void };
type PopLike = {
  querySelector?: (selector: string) => { scrollIntoView?: (opts: { block: 'nearest' }) => void } | null;
} | null;
interface KeyLike {
  readonly key: string;
  preventDefault(): void;
  stopPropagation(): void;
}
interface BlurLike {
  readonly currentTarget: { contains?: (n: unknown) => boolean };
  readonly relatedTarget?: unknown;
}
interface MouseLike {
  preventDefault(): void;
}

const FALLBACK_OPTION: KitComboboxOption = { value: '', label: '选择…', placeholder: true };

/**
 * 选中判据（纯函数，契约层单源）：占位项**永远不算选中**。
 *
 * 占位项的 value 是空串，而「未选」时 current 也是空串——朴素的值相等判据会把
 * 占位行点亮成选中态（蓝框 + 勾 + `aria-selected=true`），把「清除选择」误导成
 * 一个当前选项。字段行与弹层行都从这里吃同一份结论；本包测试不起 jsdom，
 * 判据单独导出（同 panel-row-nav 的做法）。
 */
export function kitComboboxIsSelected(
  choice: Pick<KitComboboxOption, 'value' | 'placeholder'> | undefined,
  current: string | null,
): boolean {
  return !!choice && !choice.placeholder && choice.value === (current ?? '');
}

/**
 * 自绘下拉：字段行是 `role=combobox` 的按钮，弹层是真正的 `role=listbox`。
 * 选项用 `onMouseDown` 阻止默认，避免焦点先丢给 body 把弹层提前收掉。
 */
export function KitCombobox(props: KitComboboxProps): ReactNode {
  const {
    value, onChange, options, ariaLabel, title, leading, label,
    headTitle, count, emptyText, footHint, disabled = false, className,
  } = props;
  const uid = useId();
  const listId = `${uid}-list`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<FocusableLike | null>(null);
  const popRef = useRef<PopLike>(null);

  const choices: readonly KitComboboxOption[] = options.length > 0 ? options : [FALLBACK_OPTION];
  const current = value ?? '';
  const selectedIndex = Math.max(0, choices.findIndex((c) => kitComboboxIsSelected(c, current)));
  const selected = choices[selectedIndex] ?? choices[0]!;
  const isSelected = (c: KitComboboxOption): boolean => kitComboboxIsSelected(c, current);

  // 选项表在弹层开着时变短：活动行钳回合法区间，Enter 不选错行。
  useEffect(() => {
    if (!open) return;
    setActive((i) => (i < choices.length ? i : choices.length - 1));
  }, [open, choices.length]);

  // 键盘走到哪行就滚进可视区，不抢外层面板的滚动。
  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector?.('.kit-combobox-opt.is-active')?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  const openList = (): void => {
    if (disabled) return;
    setActive(selectedIndex);
    setOpen(true);
  };

  const choose = (choice: KitComboboxOption | undefined): void => {
    if (!choice) return;
    onChange(choice.value || null);
    setOpen(false);
    triggerRef.current?.focus?.();
  };

  const onKeyDown = (e: KeyLike): void => {
    if (disabled) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (open) setActive((i) => (i + 1) % choices.length);
        else openList();
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (open) setActive((i) => (i - 1 + choices.length) % choices.length);
        else openList();
        return;
      case 'Home':
        if (open) { e.preventDefault(); setActive(0); }
        return;
      case 'End':
        if (open) { e.preventDefault(); setActive(choices.length - 1); }
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (open) choose(choices[active]);
        else openList();
        return;
      case 'Escape':
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus?.();
        }
        return;
      case 'Tab':
        if (open) setOpen(false);
        return;
      default:
        return;
    }
  };

  const field = createElement(
    'button',
    {
      className:
        'kit-combobox-field' +
        (open ? ' is-open' : '') +
        (selected.placeholder ? ' is-placeholder' : ''),
      type: 'button',
      role: 'combobox',
      'aria-haspopup': 'listbox',
      'aria-expanded': open,
      'aria-controls': listId,
      'aria-activedescendant': open ? `${uid}-opt-${active}` : undefined,
      'aria-label': ariaLabel,
      title,
      disabled,
      ref: triggerRef,
      onClick: () => (open ? setOpen(false) : openList()),
    },
    leading === undefined
      ? null
      : createElement('span', { className: 'kit-combobox-leading', 'aria-hidden': 'true' }, leading),
    label === undefined
      ? null
      : createElement('span', { className: 'kit-combobox-label' }, label),
    createElement('span', { className: 'kit-combobox-value' }, selected.label),
    selected.hint === undefined
      ? null
      : createElement('span', { className: 'kit-combobox-value-hint' }, selected.hint),
    createElement('span', { className: 'kit-combobox-caret', 'aria-hidden': 'true' }),
  );

  const pop = open
    ? createElement(
        'div',
        { className: 'kit-combobox-pop' },
        headTitle === undefined && count === undefined
          ? null
          : createElement(
              'div',
              { className: 'kit-combobox-head', 'aria-hidden': 'true' },
              createElement('span', { className: 'kit-combobox-head-title' }, headTitle ?? ''),
              count === undefined
                ? null
                : createElement('span', { className: 'kit-combobox-count' }, `${count}`),
            ),
        createElement(
          'div',
          {
            className: 'kit-combobox-list',
            role: 'listbox',
            id: listId,
            'aria-label': ariaLabel,
            ref: popRef,
          },
          ...choices.map((c, i) =>
            createElement(
              'button',
              {
                key: c.value || '__placeholder__',
                id: `${uid}-opt-${i}`,
                type: 'button',
                role: 'option',
                'aria-selected': isSelected(c),
                className:
                  'kit-combobox-opt' +
                  (isSelected(c) ? ' is-selected' : '') +
                  (i === active ? ' is-active' : '') +
                  (c.placeholder ? ' is-placeholder' : ''),
                title: c.hint === undefined ? c.label : `${c.label} — ${c.hint}`,
                // 点选项不先把焦点丢给 body（否则 wrap 的 blur 会先把弹层收掉）
                onMouseDown: (e: MouseLike) => e.preventDefault(),
                onMouseEnter: () => setActive(i),
                onClick: () => choose(c),
              },
              createElement('span', { className: 'kit-combobox-check', 'aria-hidden': 'true' }),
              createElement('span', { className: 'kit-combobox-opt-label' }, c.label),
              c.hint === undefined
                ? null
                : createElement('span', { className: 'kit-combobox-opt-hint' }, c.hint),
            ),
          ),
        ),
        choices.length <= 1 && emptyText !== undefined
          ? createElement('div', { className: 'kit-combobox-empty' }, emptyText)
          : null,
        footHint === undefined
          ? null
          : createElement('div', { className: 'kit-combobox-foot', 'aria-hidden': 'true' }, footHint),
      )
    : null;

  return createElement(
    'div',
    {
      className: 'kit-combobox' + (className === undefined ? '' : ` ${className}`),
      onKeyDown,
      // 焦点离开整块控件即收起，不挂全局 document 监听（插件侧也能安全卸载）
      onBlur: (e: BlurLike) => {
        const rel = e.relatedTarget;
        if (rel !== null && rel !== undefined && e.currentTarget.contains?.(rel)) return;
        setOpen(false);
      },
    },
    field,
    pop,
  );
}
