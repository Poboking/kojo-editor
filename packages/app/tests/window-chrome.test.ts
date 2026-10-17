import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WindowChrome, chromeActionsOf, windowStateOf } from '../src/ui/WindowChrome';
import { Icon } from '../src/ui/icons';

/**
 * 常驻窗口框架的静态判据（node + renderToStaticMarkup；不跑 effect / 不碰 DOM）。
 *
 * 两个纯函数钉死三态映射（普通 / 最大化 / 全屏）的按钮序列、图标与中文标签——
 * 这是标题栏唯一会随窗口态变化的部分；另钉住浏览器 dev / node 下 WindowChrome 返回 null
 * （没有壳就不画一条点不动的假标题栏），以及所有动作图标都真的注册在内置图标表里。
 */

describe('windowStateOf · 三态映射', () => {
  it('普通 / 最大化 / 全屏各归各位', () => {
    expect(windowStateOf({ fullscreen: false, maximized: false })).toBe('normal');
    expect(windowStateOf({ fullscreen: false, maximized: true })).toBe('maximized');
    expect(windowStateOf({ fullscreen: true, maximized: false })).toBe('fullscreen');
  });

  it('全屏压过最大化（全屏时 Windows 报的 maximized 不作为 UI 依据）', () => {
    expect(windowStateOf({ fullscreen: true, maximized: true })).toBe('fullscreen');
  });
});

describe('chromeActionsOf · 按钮序列 / 图标 / 中文标签', () => {
  it('普通窗口：最小化 → 最大化 → 关闭', () => {
    const actions = chromeActionsOf({ fullscreen: false, maximized: false });
    expect(actions.map((a) => a.id)).toEqual(['minimize', 'maximize', 'close']);
    expect(actions.map((a) => a.icon)).toEqual(['minimize', 'maximize', 'close']);
    expect(actions.map((a) => a.label)).toEqual(['最小化', '最大化', '关闭窗口']);
  });

  it('最大化：中间换成还原（图标与标签一起换）', () => {
    const actions = chromeActionsOf({ fullscreen: false, maximized: true });
    expect(actions.map((a) => a.id)).toEqual(['minimize', 'restore', 'close']);
    expect(actions.map((a) => a.icon)).toEqual(['minimize', 'restore', 'close']);
    expect(actions.map((a) => a.label)).toEqual(['最小化', '还原', '关闭窗口']);
  });

  it('全屏：中间换成退出全屏，最小化与关闭仍在，关闭恒在最后', () => {
    const actions = chromeActionsOf({ fullscreen: true, maximized: true });
    expect(actions.map((a) => a.id)).toEqual(['minimize', 'exit-fullscreen', 'close']);
    expect(actions.map((a) => a.icon)).toEqual(['minimize', 'exit-fullscreen', 'close']);
    expect(actions.map((a) => a.label)).toEqual(['最小化', '退出全屏', '关闭窗口']);
    expect(actions.at(-1)?.id).toBe('close');
  });

  it('每枚动作图标都注册在内置图标表（渲染出 svg 而不是字形兜底）', () => {
    const states = [
      { fullscreen: false, maximized: false },
      { fullscreen: false, maximized: true },
      { fullscreen: true, maximized: false },
    ];
    const icons = new Set(states.flatMap((s) => chromeActionsOf(s).map((a) => a.icon)));
    expect([...icons].sort()).toEqual(['close', 'exit-fullscreen', 'maximize', 'minimize', 'restore']);
    for (const name of icons) {
      const out = renderToStaticMarkup(createElement(Icon, { name }));
      expect(out.startsWith('<svg')).toBe(true);
    }
  });

  it('为全屏新增的两枚图标（fullscreen / exit-fullscreen）也都在表里', () => {
    for (const name of ['fullscreen', 'exit-fullscreen']) {
      const out = renderToStaticMarkup(createElement(Icon, { name }));
      expect(out.startsWith('<svg')).toBe(true);
    }
  });
});

describe('WindowChrome · 无壳环境', () => {
  it('浏览器 dev / node（isTauri 为 false）返回 null，不渲染假按钮', () => {
    expect(renderToStaticMarkup(createElement(WindowChrome))).toBe('');
  });
});
