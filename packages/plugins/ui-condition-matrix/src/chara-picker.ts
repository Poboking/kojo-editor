/**
 * 角色搜索选择器（条件矩阵工具条用；React + 结构化事件类型，零宿主依赖）。
 *
 * 原生 `<select>` 在 250+ 角色时要滚很久；作者找角色通常知道编号或名字的
 * 一部分。这里给一个「聚焦即搜」的组合框：编号 / 名字子串都能命中，键盘
 * ↑↓ + Enter 可选，Esc 收起；不选中任何角色时清空回「全部」。
 *
 * 交互刻意保持轻：输入框失焦即收起、每项 `onMouseDown` 阻止默认（点选项不会
 * 先把焦点丢给 body）。**命中项全部渲染**（用户反馈：60 条上限让 250+ 角色的
 * 大盘只能看到前 60 个）；列表自身滚动，键盘活动项随之滚进视野。过滤是本地
 * 数组扫描，不做 async 搜索。
 */

import { createElement, useEffect, useRef, useState, type ReactNode } from 'react';

export interface CharaChoice {
  readonly no: number;
  readonly name: string;
  /** 该角色的函数数（列表右侧的计数徽章） */
  readonly count: number;
}

export interface CharaPickerProps {
  readonly choices: readonly CharaChoice[];
  readonly value: number | null;
  readonly onChange: (no: number | null) => void;
  readonly renderIcon?: (name: string, size?: number) => unknown;
}

function labelOf(choice: CharaChoice): string {
  return choice.name ? `K${choice.no} ${choice.name}` : `K${choice.no}`;
}

/** 结构化的输入元素引用（根 tsconfig 不带 DOM lib，插件侧沿用既有做法） */
type InputLike = { focus?: () => void };
/** 结构化的弹层引用：只用来把键盘活动项滚进视野 */
type PopLike = {
  querySelector?: (selector: string) => { scrollIntoView?: (opts: { block: 'nearest' }) => void } | null;
} | null;

export function CharaPicker(props: CharaPickerProps): ReactNode {
  const { choices, value, onChange, renderIcon } = props;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<InputLike | null>(null);
  const popRef = useRef<PopLike>(null);

  const selected = value === null ? null : choices.find((c) => c.no === value) ?? null;
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? choices.filter(
        (c) =>
          c.name.toLowerCase().includes(needle) ||
          String(c.no) === needle ||
          `k${c.no}` === needle,
      )
    : choices;

  // 选中项随过滤收缩后，活动行可能越界——钳回合法区间，Enter 不选错人
  useEffect(() => {
    if (active >= filtered.length) setActive(filtered.length > 0 ? filtered.length - 1 : 0);
  }, [filtered.length, active]);

  // 列表全量渲染后键盘仍要能走到底：活动项变化时把它滚进可视区（不抢外层滚动）
  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector?.('.cm-chara-opt.active')?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  const pick = (choice: CharaChoice | undefined): void => {
    if (!choice) return;
    onChange(choice.no);
    setOpen(false);
    setQuery('');
    setActive(0);
  };

  const icon = (name: string, size: number, fallback: string): ReactNode =>
    (renderIcon?.(name, size) as ReactNode | undefined) ?? fallback;

  const inputValue = open ? query : selected ? labelOf(selected) : '';
  const placeholder = selected ? labelOf(selected) : `搜索角色（${choices.length}）`;

  const onKeyDown = (e: {
    key: string;
    preventDefault(): void;
    stopPropagation(): void;
  }): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      pick(filtered[active]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setQuery('');
    }
  };

  return createElement(
    'div',
    { className: 'cm-chara' + (open ? ' open' : '') },
    createElement(
      'div',
      { className: 'cm-chara-box' },
      createElement('span', { className: 'cm-chara-icon', 'aria-hidden': 'true' }, icon('search', 12, '⌕')),
      createElement('input', {
        className: 'cm-chara-input',
        type: 'text',
        role: 'combobox',
        ref: inputRef,
        'aria-expanded': open,
        'aria-autocomplete': 'list',
        value: inputValue,
        placeholder,
        title: selected ? `${labelOf(selected)}（点击可搜索并切换）` : '按编号或名字搜索角色',
        onFocus: () => {
          setOpen(true);
          setQuery('');
          setActive(0);
        },
        onBlur: (e: {
          currentTarget: { contains?: (n: unknown) => boolean };
          relatedTarget?: unknown;
        }) => {
          const rel = e.relatedTarget;
          if (rel !== null && rel !== undefined && e.currentTarget.contains?.(rel)) return;
          setOpen(false);
          setQuery('');
        },
        onChange: (e: { target: { value: string } }) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        },
        onKeyDown,
      }),
      selected
        ? createElement(
            'button',
            {
              className: 'cm-chara-clear',
              type: 'button',
              title: '清除角色选择',
              'aria-label': '清除角色选择',
              onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
              onClick: () => {
                onChange(null);
                setOpen(true);
                inputRef.current?.focus?.();
              },
            },
            icon('close', 11, '×'),
          )
        : null,
    ),
    open
      ? createElement(
          'div',
          { className: 'cm-chara-pop', role: 'listbox', ref: popRef },
          filtered.length === 0
            ? createElement('div', { className: 'cm-chara-note dim' }, '没有匹配的角色')
            : filtered.map((choice, i) =>
                createElement(
                  'button',
                  {
                    key: choice.no,
                    type: 'button',
                    role: 'option',
                    'aria-selected': choice.no === value,
                    className:
                      'cm-chara-opt' +
                      (choice.no === value ? ' on' : '') +
                      (i === active ? ' active' : '') +
                      (choice.count === 0 ? ' empty' : ''),
                    title: `${labelOf(choice)} · ${choice.count > 0 ? `${choice.count} 个函数` : '尚无口上函数'}`,
                    onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
                    onMouseEnter: () => setActive(i),
                    onClick: () => pick(choice),
                  },
                  createElement('span', { className: 'cm-chara-no' }, `K${choice.no}`),
                  createElement('span', { className: 'cm-chara-name' }, choice.name || '（无名）'),
                  createElement('span', { className: 'cm-chara-count dim' }, String(choice.count)),
                ),
              ),
          createElement(
            'div',
            { className: 'cm-chara-foot dim' },
            `匹配 ${filtered.length} 人${needle ? '' : '（可输入编号 / 名字缩小范围）'}`,
          ),
        )
      : null,
  );
}
