// @vitest-environment happy-dom
/**
 * 欢迎弹窗整窗拖动（2026-10-25 反馈：只有品牌那一小块能拖）。
 *
 * 判据：
 * - 交互控件 / 打开的模态或右键菜单 / 滚动条上不拖，其余任意位置可拖；
 * - 浏览器的 `startWindowDrag` 是安全 no-op；
 * - App 只在「无项目且非启动相位」挂这个 mousedown 监听（编辑器态归 WindowChrome）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { canStartWindowDragFrom, prepareWindowDrag } from '../src/ui/window-fullscreen';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('欢迎弹窗拖动判定', () => {
  it('普通空白区域可以拖', () => {
    const div = document.createElement('div');
    document.body.append(div);
    expect(canStartWindowDragFrom(div, 10, 10)).toBe(true);
  });

  it('交互控件与其内部都不拖（按钮 / 链接 / 输入 / 折叠头 / 右键菜单项 / data-no-drag）', () => {
    for (const tag of ['button', 'a', 'input', 'textarea', 'select', 'summary', 'label']) {
      const el = document.createElement(tag);
      document.body.append(el);
      expect(canStartWindowDragFrom(el, 10, 10), tag).toBe(false);
    }
    const attrCases: readonly (readonly [string, string])[] = [
      ['role', 'button'],
      ['role', 'menuitem'],
      ['contenteditable', 'true'],
      ['data-no-drag', ''],
    ];
    for (const [k, v] of attrCases) {
      const el = document.createElement('div');
      el.setAttribute(k, v);
      document.body.append(el);
      expect(canStartWindowDragFrom(el, 10, 10), `${k}=${v}`).toBe(false);
    }
    const button = document.createElement('button');
    const span = document.createElement('span');
    button.append(span);
    document.body.append(button);
    expect(canStartWindowDragFrom(span, 10, 10)).toBe(false);
  });

  it('模态 / 右键菜单打开时不拖（否则会把遮罩上的点击当成拖窗）', () => {
    const div = document.createElement('div');
    document.body.append(div);
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    document.body.append(mask);
    expect(canStartWindowDragFrom(div, 10, 10)).toBe(false);
    mask.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'context-menu-backdrop';
    document.body.append(backdrop);
    expect(canStartWindowDragFrom(div, 10, 10)).toBe(false);
  });

  it('可滚祖先的滚动条上不拖，轨道内侧仍可拖', () => {
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    Object.defineProperty(scroller, 'clientWidth', { value: 100 });
    Object.defineProperty(scroller, 'clientHeight', { value: 50 });
    Object.defineProperty(scroller, 'scrollHeight', { value: 200 });
    Object.defineProperty(scroller, 'scrollWidth', { value: 100 });
    scroller.getBoundingClientRect = () => ({ left: 0, top: 0, right: 120, bottom: 50, width: 120, height: 50, x: 0, y: 0, toJSON: () => ({}) });
    const inner = document.createElement('p');
    scroller.append(inner);
    document.body.append(scroller);

    expect(canStartWindowDragFrom(inner, 110, 20), '落在纵向滚动条上').toBe(false);
    expect(canStartWindowDragFrom(inner, 50, 20), '落在内容区').toBe(true);
  });

  it('浏览器 dev 里预载出的是 no-op（无壳不抛错）', async () => {
    const startDrag = await prepareWindowDrag();
    expect(() => startDrag()).not.toThrow();
  });
});

describe('App 接线', () => {
  const app = read('../src/ui/App.tsx');
  const welcome = read('../src/ui/WelcomeView.tsx');

  it('只在「无项目且非启动相位」挂整窗拖动，且走统一判定', () => {
    expect(app).toContain("if (project !== null || phase === 'boot') return;");
    expect(app).toContain('canStartWindowDragFrom(target, event.clientX, event.clientY)');
    expect(app).toContain('prepareWindowDrag()');
    expect(app).toContain('startDrag?.()');
    expect(app).toContain("frame.addEventListener('mousedown', onMouseDown)");
  });

  it('欢迎页不再自己挂 data-tauri-drag-region（避免同一次按下触发两遍原生拖动）', () => {
    expect(welcome).not.toMatch(/data-tauri-drag-region=/);
  });
});
