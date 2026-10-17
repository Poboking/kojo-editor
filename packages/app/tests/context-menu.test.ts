import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ContextMenu,
  MENU_VIEWPORT_MARGIN,
  clampMenuPosition,
  nextMenuIndex,
  type ContextMenuItem,
} from '../src/ui/context-menu';

/**
 * 共享右键菜单的纯函数判据（用户反馈 7）：视口夹取与键盘落点。
 * 组件层只做"把这两个结果接到 DOM 上"，形状/文案的回归由 SSR 用例（file-tree / tabs-bar）看着。
 */

const item = (id: string, extra: Partial<ContextMenuItem> = {}): ContextMenuItem => ({
  id,
  label: id,
  ...extra,
});

const VIEWPORT = { width: 1280, height: 720 };
const SIZE = { width: 260, height: 300 };

describe('clampMenuPosition · 视口夹取', () => {
  it('常规位置原样返回（菜单整个落在视口内）', () => {
    expect(clampMenuPosition(120, 90, SIZE, VIEWPORT)).toEqual({ left: 120, top: 90 });
  });

  it('右缘 / 下缘夹回视口内，并留 margin 呼吸', () => {
    expect(clampMenuPosition(1200, 700, SIZE, VIEWPORT)).toEqual({
      left: VIEWPORT.width - SIZE.width - MENU_VIEWPORT_MARGIN,
      top: VIEWPORT.height - SIZE.height - MENU_VIEWPORT_MARGIN,
    });
  });

  it('菜单比视口还大 → 贴住左上 margin（不出现负坐标）', () => {
    const huge = { width: 2000, height: 2000 };
    expect(clampMenuPosition(500, 500, huge, VIEWPORT)).toEqual({
      left: MENU_VIEWPORT_MARGIN,
      top: MENU_VIEWPORT_MARGIN,
    });
  });

  it('x/y 为负（多屏坐标 / 键盘锚点越界）→ 贴左边距', () => {
    expect(clampMenuPosition(-40, -12, SIZE, VIEWPORT)).toEqual({
      left: MENU_VIEWPORT_MARGIN,
      top: MENU_VIEWPORT_MARGIN,
    });
  });

  it('margin 可覆盖（调用侧给不同的边距口径）', () => {
    expect(clampMenuPosition(1279, 719, SIZE, VIEWPORT, 12)).toEqual({
      left: VIEWPORT.width - SIZE.width - 12,
      top: VIEWPORT.height - SIZE.height - 12,
    });
  });
});

describe('nextMenuIndex · 键盘落点', () => {
  const items = [item('a'), item('b', { disabled: true }), item('c'), item('d')];

  it('↓ 跳过 disabled 项；到边界即停（不循环）', () => {
    expect(nextMenuIndex(items, -1, 'ArrowDown')).toBe(0);
    expect(nextMenuIndex(items, 0, 'ArrowDown')).toBe(2); // 跳过 b
    expect(nextMenuIndex(items, 2, 'ArrowDown')).toBe(3);
    expect(nextMenuIndex(items, 3, 'ArrowDown')).toBe(3); // 末项即停
  });

  it('↑ 跳过 disabled 项；到边界即停（不循环）；无焦点时落末项', () => {
    expect(nextMenuIndex(items, -1, 'ArrowUp')).toBe(3);
    expect(nextMenuIndex(items, 3, 'ArrowUp')).toBe(2);
    expect(nextMenuIndex(items, 2, 'ArrowUp')).toBe(0); // 跳过 b
    expect(nextMenuIndex(items, 0, 'ArrowUp')).toBe(0);
  });

  it('Home / End 直达首个 / 末个可用项（同样跳过 disabled）', () => {
    expect(nextMenuIndex(items, 2, 'Home')).toBe(0);
    expect(nextMenuIndex(items, 1, 'End')).toBe(3);
    expect(nextMenuIndex([item('x', { disabled: true }), item('y')], -1, 'Home')).toBe(1);
  });

  it('全部 disabled → -1（焦点不落到不可用的项上）', () => {
    const allOff = [item('a', { disabled: true }), item('b', { disabled: true })];
    expect(nextMenuIndex(allOff, -1, 'ArrowDown')).toBe(-1);
    expect(nextMenuIndex(allOff, -1, 'End')).toBe(-1);
  });

  it('空菜单 → -1（不抛、不返回 0）', () => {
    expect(nextMenuIndex([], -1, 'ArrowDown')).toBe(-1);
  });
});

describe('ContextMenu · SSR 形状（aria / 分隔线 / 快捷键 / 危险项）', () => {
  const render = (items: readonly ContextMenuItem[]): string =>
    renderToStaticMarkup(
      h(ContextMenu, { x: 40, y: 60, items, onSelect: () => {}, onDismiss: () => {} }),
    );

  it('menu / menuitem 角色齐全，初始位置来自 x/y（测量在 effect 里，SSR 不参与）', () => {
    const html = render([item('open'), item('rename')]);
    expect(html).toContain('role="menu"');
    expect(html.match(/role="menuitem"/g)).toHaveLength(2);
    expect(html).toContain('left:40px');
    expect(html).toContain('top:60px');
  });

  it('快捷键右列、危险项、禁用项、勾选项各自上屏', () => {
    const html = render([
      item('close', { shortcut: 'Ctrl+W' }),
      item('delete', { danger: true, dividerBefore: true }),
      item('pin', { checked: true, disabled: true }),
    ]);
    expect(html).toContain('context-menu-shortcut');
    expect(html).toContain('Ctrl+W');
    expect(html).toContain('class="context-menu-item danger"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('disabled=""');
  });

  it('分隔线只出现在非首项之前（首项的 dividerBefore 被吞掉）', () => {
    expect(render([item('a', { dividerBefore: true }), item('b')])).not.toContain(
      'context-menu-sep',
    );
    expect(render([item('a'), item('b', { dividerBefore: true })])).toContain('context-menu-sep');
  });
});
