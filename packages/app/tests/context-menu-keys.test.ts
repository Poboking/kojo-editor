// @vitest-environment happy-dom
/**
 * 右键菜单的键盘可用性（1023 批 · WP6.4 残留）：Home/End、首字母跳转、Tab、子菜单逐级。
 *
 * 判据都是**行为级**（真挂载、真派发 KeyboardEvent、看焦点落在哪个按钮上）：
 * - Home/End 直达首/末个**可用**项（跳 disabled）；
 * - type-ahead：可打印字符 500ms 内累积成查询串，从当前项之后找下一个 label 前缀命中项，
 *   绕回即循环；同字符连按在同类项之间循环；输入法组合期与组合键不拦截；
 * - Tab 关整棵菜单、**不** preventDefault（焦点交给浏览器默认顺序），且卸载时不再把焦点
 *   抢回触发元素；
 * - 既有键位不退：↑/↓、→/←、Esc（含子菜单逐级）、选中。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ContextMenu,
  TYPE_AHEAD_RESET_MS,
  nextTypeAheadQuery,
  typeAheadCharOf,
  typeAheadIndex,
  type ContextMenuItem,
} from '../src/ui/context-menu';

const item = (id: string, label: string, extra: Partial<ContextMenuItem> = {}): ContextMenuItem => ({
  id,
  label,
  ...extra,
});

// 本文件用真挂载 + act 派发键盘事件（与 palette-menu / file-tree 同口径）
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let onDismiss: ReturnType<typeof vi.fn<() => void>>;
/** 本次用例挂到 body 上的触发元素（上一用例不收拾干净会互相抢焦点） */
let triggers: HTMLButtonElement[];

beforeEach(() => {
  triggers = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onDismiss = vi.fn<() => void>();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  for (const trigger of triggers) trigger.remove();
});

/**
 * 触发元素：菜单打开前它拿着焦点，Esc 关闭时该还给它。
 *
 * 挂在 `document.body` 而不是 React 容器里——`createRoot` 首次渲染会清空容器的既有子节点，
 * 触发元素跟着被摘掉的话，「归还焦点」的判据（目标必须仍在文档里）就天然不成立了。
 */
function mountTrigger(): HTMLButtonElement {
  const trigger = document.createElement('button');
  trigger.textContent = '触发处';
  document.body.appendChild(trigger);
  triggers.push(trigger);
  trigger.focus();
  return trigger;
}

interface HarnessProps {
  readonly items: readonly ContextMenuItem[];
  readonly onSelect?: (id: string) => void;
}

/** 受控壳：onDismiss 后真的卸载菜单（否则「关掉」在测试里只是一次回调） */
function Harness({ items, onSelect }: HarnessProps): ReturnType<typeof h> {
  const [open, setOpen] = useState(true);
  if (!open) return h('p', { id: 'after-menu' }, '菜单之后');
  return h(ContextMenu, {
    x: 10,
    y: 10,
    items,
    ariaLabel: '测试菜单',
    onSelect: onSelect ?? (() => undefined),
    onDismiss: () => {
      onDismiss();
      setOpen(false);
    },
  });
}

async function mountMenu(items: readonly ContextMenuItem[], onSelect?: (id: string) => void): Promise<void> {
  await act(async () => {
    root.render(h(Harness, { items, onSelect }));
  });
}

/** 当前聚焦项的文字（不在菜单项上 ⇒ null） */
function focusedLabel(): string | null {
  const active = document.activeElement;
  const label = active?.closest('[role="menuitem"]')?.querySelector('.context-menu-label');
  return label?.textContent ?? null;
}

function menus(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="menu"]'));
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const target = (document.activeElement as HTMLElement | null) ?? container;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

/* ------------------------------ 纯函数：首字母 ------------------------------ */

describe('typeAheadCharOf · 哪些按键参与首字母', () => {
  it('单字符归一化成小写', () => {
    expect(typeAheadCharOf({ key: 'a' })).toBe('a');
    expect(typeAheadCharOf({ key: 'A' })).toBe('a');
    expect(typeAheadCharOf({ key: '复' })).toBe('复');
  });

  it('空格 / 组合键 / 输入法组合期 / 多字符键名 都不参与', () => {
    expect(typeAheadCharOf({ key: ' ' })).toBeNull();
    expect(typeAheadCharOf({ key: 'Enter' })).toBeNull();
    expect(typeAheadCharOf({ key: 'ArrowDown' })).toBeNull();
    expect(typeAheadCharOf({ key: 'c', ctrlKey: true })).toBeNull();
    expect(typeAheadCharOf({ key: 'v', metaKey: true })).toBeNull();
    expect(typeAheadCharOf({ key: 'f', altKey: true })).toBeNull();
    expect(typeAheadCharOf({ key: 'n', isComposing: true })).toBeNull();
  });
});

describe('nextTypeAheadQuery · 500ms 累积窗口', () => {
  it('首字符直接成串；窗口内追加；超窗重开', () => {
    expect(nextTypeAheadQuery('', 'a', 0)).toBe('a');
    expect(nextTypeAheadQuery('a', 'b', 120)).toBe('ab');
    expect(nextTypeAheadQuery('ab', 'c', TYPE_AHEAD_RESET_MS + 1)).toBe('c');
  });

  it('同字符连按 ⇒ 回到单字符（在同类项之间循环，而不是拼成永不命中的「打打」）', () => {
    expect(nextTypeAheadQuery('打', '打', 100)).toBe('打');
    expect(nextTypeAheadQuery('ab', 'b', 100)).toBe('abb'); // 不是同一字符 ⇒ 正常追加
  });
});

describe('typeAheadIndex · 落点', () => {
  const items = [
    item('open', '打开'),
    item('close', '关闭'),
    item('recent', '打开最近'),
    item('del', '删除', { disabled: true }),
  ];

  it('从当前项之后找前缀命中项，绕回即循环', () => {
    expect(typeAheadIndex(items, -1, '打')).toBe(0);
    expect(typeAheadIndex(items, 0, '打')).toBe(2);
    expect(typeAheadIndex(items, 2, '打')).toBe(0); // 绕回
  });

  it('跳过 disabled；大小写不敏感；无命中 / 空串 → -1', () => {
    expect(typeAheadIndex(items, -1, '删')).toBe(-1);
    expect(typeAheadIndex([item('x', 'Copy')], -1, 'c')).toBe(0);
    expect(typeAheadIndex(items, -1, '不存在的')).toBe(-1);
    expect(typeAheadIndex(items, -1, '')).toBe(-1);
    expect(typeAheadIndex([], -1, 'a')).toBe(-1);
  });
});

/* ------------------------------ 行为：Home / End ------------------------------ */

describe('Home / End', () => {
  const items = [
    item('a', '第一项'),
    item('b', '第二项', { disabled: true }),
    item('c', '第三项'),
    item('d', '末项', { disabled: true }),
  ];

  it('End 到末个可用项（跳过末尾 disabled），Home 回头项', async () => {
    mountTrigger();
    await mountMenu(items);
    expect(focusedLabel()).toBe('第一项'); // 打开即聚焦首项

    await press('End');
    expect(focusedLabel()).toBe('第三项');

    await press('Home');
    expect(focusedLabel()).toBe('第一项');
  });

  it('End 的首选被 disabled 跳过（末项禁用 ⇒ 落它前面那个可用项）', async () => {
    mountTrigger();
    await mountMenu([item('x', '甲'), item('y', '乙'), item('z', '丙', { disabled: true })]);
    await press('End');
    expect(focusedLabel()).toBe('乙');
  });

  it('Home / End 会 preventDefault（不把滚动交给页面）', async () => {
    mountTrigger();
    await mountMenu([item('a', '一'), item('b', '二')]);
    expect((await press('End')).defaultPrevented).toBe(true);
  });
});

/* ------------------------------ 行为：首字母跳转 ------------------------------ */

describe('type-ahead（首字母跳转）', () => {
  const items = [
    item('open', '打开'),
    item('close', '关闭'),
    item('recent', '打开最近'),
    item('new-file', '新建文件'),
    item('new-dir', '新建文件夹'),
  ];

  it('敲首字母跳到下一个同前缀项；再敲一次在同前缀项之间循环', async () => {
    mountTrigger();
    await mountMenu(items);
    expect(focusedLabel()).toBe('打开');

    expect((await press('打')).defaultPrevented).toBe(true);
    expect(focusedLabel()).toBe('打开最近');

    await press('打'); // 同字符连按 ⇒ 循环回前一个
    expect(focusedLabel()).toBe('打开');
  });

  it('窗口内第二个字符把查询串变长（「新」→「新建」不是从头再来）', async () => {
    mountTrigger();
    await mountMenu(items);
    await press('新');
    expect(focusedLabel()).toBe('新建文件');
    await press('建'); // 查询串 = 新建 ⇒ 从当前项之后找，命中「新建文件夹」
    expect(focusedLabel()).toBe('新建文件夹');
    await press('文'); // 查询串 = 新建文 ⇒ 从下一项绕回「新建文件」
    expect(focusedLabel()).toBe('新建文件');
  });

  it('输入法组合期不拦截（焦点不动、不 preventDefault）', async () => {
    mountTrigger();
    await mountMenu(items);
    const event = await press('打', { isComposing: true });
    expect(event.defaultPrevented).toBe(false);
    expect(focusedLabel()).toBe('打开');
  });

  it('组合键不参与（Ctrl+C 不跳项）；无命中也不 preventDefault', async () => {
    mountTrigger();
    await mountMenu(items);
    expect((await press('c', { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(focusedLabel()).toBe('打开');
    expect((await press('z')).defaultPrevented).toBe(false);
    expect(focusedLabel()).toBe('打开');
  });
});

/* ------------------------------ 行为：Tab ------------------------------ */

describe('Tab', () => {
  it('关掉整棵菜单但不 preventDefault；焦点不被抢回触发处', async () => {
    const trigger = mountTrigger();
    await mountMenu([item('a', '复制'), item('b', '粘贴')]);
    expect(menus()).toHaveLength(1);

    const event = await press('Tab');
    expect(event.defaultPrevented).toBe(false);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(menus()).toHaveLength(0);
    // 焦点归还被主动放弃：Tab 的落点由浏览器默认顺序决定，不该被拉回触发元素
    expect(document.activeElement).not.toBe(trigger);
    expect(focusedLabel()).toBeNull();
  });

  it('Esc 仍归还焦点给触发元素（与 Tab 相反的路）', async () => {
    const trigger = mountTrigger();
    await mountMenu([item('a', '复制')]);
    const event = await press('Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });
});

/* ------------------------------ 行为：既有键位不退 ------------------------------ */

describe('方向键 / 子菜单 / 选中（回归）', () => {
  it('↓ 跳过 disabled，到边界即停', async () => {
    mountTrigger();
    await mountMenu([
      item('a', '一'),
      item('b', '二', { disabled: true }),
      item('c', '三'),
    ]);
    await press('ArrowDown');
    expect(focusedLabel()).toBe('三');
    await press('ArrowDown');
    expect(focusedLabel()).toBe('三');
  });

  const tree = [
    item('copy', '复制'),
    item('more', '更多', { children: [item('c1', '子项一'), item('c2', '子项二')] }),
  ];

  it('→ 打开子菜单并聚焦首项；Esc 逐级收起；← 回父项', async () => {
    mountTrigger();
    await mountMenu(tree);
    await press('ArrowDown');
    expect(focusedLabel()).toBe('更多');

    await press('ArrowRight');
    expect(menus()).toHaveLength(2);
    expect(menus()[1]!.getAttribute('aria-label')).toBe('更多');
    expect(focusedLabel()).toBe('子项一');

    await press('Escape'); // 只收子菜单
    expect(menus()).toHaveLength(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(focusedLabel()).toBe('更多');

    await press('ArrowRight');
    expect(menus()).toHaveLength(2);
    await press('ArrowLeft');
    expect(menus()).toHaveLength(1);
    expect(focusedLabel()).toBe('更多');

    await press('Escape'); // 再关整棵
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(menus()).toHaveLength(0);
  });

  it('子菜单里按 Tab 关的是整棵菜单（子菜单不会单独留在屏上）', async () => {
    mountTrigger();
    await mountMenu(tree);
    await press('ArrowDown');
    await press('ArrowRight');
    expect(menus()).toHaveLength(2);

    const event = await press('Tab');
    expect(event.defaultPrevented).toBe(false);
    expect(menus()).toHaveLength(0);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('点一项 → onSelect 拿到 id，随后关闭', async () => {
    const onSelect = vi.fn();
    mountTrigger();
    await mountMenu([item('copy', '复制')], onSelect);
    const button = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    await act(async () => {
      button.click();
    });
    expect(onSelect).toHaveBeenCalledWith('copy');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
