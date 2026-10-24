import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EDITOR_MIN_SIZE,
  EDITOR_WINDOW_SIZE,
  WELCOME_MIN_SIZE,
  applyEditorWindow,
  applyWelcomeWindow,
  clampWelcomeWindowSize,
  type WelcomeWindowBackend,
  type WelcomeWindowSurface,
} from '../src/ui/window-fullscreen';

/**
 * 窗口几何两态（2026-10-25 启动弹窗批）的判据。
 *
 * 硬口径：
 * - 欢迎弹窗尺寸 = 欢迎卡核心区（宽度 1120 的设计值、高度由卡片自然高度给出），
 *   只受屏幕工作区夹取；下限 320×200。
 * - 进入弹窗必须**先降下限**再改尺寸（否则 570 会被编辑器 620 下限夹住）；
 *   进入编辑器要恢复 960×620 / 可缩放 / 可最大化。
 * - 全屏 / 最大化要先退，再改尺寸；所有失败只 warn，不挡启动。
 */

function fakeWindow(patch: Partial<WelcomeWindowSurface> = {}): WelcomeWindowSurface {
  const win: WelcomeWindowSurface = {
    isFullscreen: vi.fn(async () => false),
    isMaximized: vi.fn(async () => false),
    setFullscreen: vi.fn(async () => {}),
    unmaximize: vi.fn(async () => {}),
    setResizable: vi.fn(async () => {}),
    setMaximizable: vi.fn(async () => {}),
    setSize: vi.fn(async () => {}),
    setMinSize: vi.fn(async () => {}),
    center: vi.fn(async () => {}),
  };
  return Object.assign(win, patch);
}

function backendOf(getWindow: () => Promise<WelcomeWindowSurface>, isShell = true): WelcomeWindowBackend {
  return { isShell: () => isShell, getWindow: vi.fn(getWindow) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('clampWelcomeWindowSize：卡片核心区 → 屏幕工作区内的窗口尺寸', () => {
  it('常规屏幕原样返回（1120×570 = 一两个最近项目的卡片高度）', () => {
    expect(clampWelcomeWindowSize({ width: 1120, height: 570 }, { width: 1920, height: 1080 })).toEqual({
      width: 1120,
      height: 570,
    });
  });

  it('超出工作区时按边距夹取（1920×1080 → 高最多 1056）', () => {
    expect(clampWelcomeWindowSize({ width: 1120, height: 1200 }, { width: 1920, height: 1080 })).toEqual({
      width: 1120,
      height: 1056,
    });
  });

  it('小于下限时抬到 320×200；小数尺寸四舍五入', () => {
    expect(clampWelcomeWindowSize({ width: 200.4, height: 100.6 }, { width: 1920, height: 1080 })).toEqual({
      width: 320,
      height: 200,
    });
    expect(clampWelcomeWindowSize({ width: 1119.6, height: 510.34 }, { width: 1920, height: 1080 })).toEqual({
      width: 1120,
      height: 510,
    });
  });

  it('窄屏：宽高都按边距夹取', () => {
    expect(clampWelcomeWindowSize({ width: 1120, height: 700 }, { width: 1000, height: 600 })).toEqual({
      width: 976,
      height: 576,
    });
  });
});

describe('applyWelcomeWindow：弹窗态（无边框、不可缩放）', () => {
  it('先降下限再改尺寸，最后居中；同时关掉缩放与最大化', async () => {
    const win = fakeWindow();
    await applyWelcomeWindow({ width: 1120, height: 570 }, {}, backendOf(async () => win));

    expect(win.setResizable).toHaveBeenCalledWith(false);
    expect(win.setMaximizable).toHaveBeenCalledWith(false);
    expect(win.setMinSize).toHaveBeenCalledWith(WELCOME_MIN_SIZE);
    expect(win.setSize).toHaveBeenCalledWith({ width: 1120, height: 570 });
    expect(win.center).toHaveBeenCalledTimes(1);
    // 下限必须先落：高度 570 < 编辑器下限 620
    expect(vi.mocked(win.setMinSize).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(win.setSize).mock.invocationCallOrder[0]!,
    );
  });

  it('全屏 / 最大化先退，再改尺寸', async () => {
    const win = fakeWindow({
      isFullscreen: vi.fn(async () => true),
      isMaximized: vi.fn(async () => true),
    });
    await applyWelcomeWindow({ width: 1120, height: 510 }, {}, backendOf(async () => win));

    expect(win.setFullscreen).toHaveBeenCalledWith(false);
    expect(win.unmaximize).toHaveBeenCalledTimes(1);
    expect(vi.mocked(win.setFullscreen).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(win.setSize).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(win.unmaximize).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(win.setSize).mock.invocationCallOrder[0]!,
    );
  });

  it('center:false（内容变高变矮）= 只改尺寸，不把作者拖到的位置拽回屏幕中央', async () => {
    const win = fakeWindow();
    await applyWelcomeWindow({ width: 1120, height: 687 }, { center: false }, backendOf(async () => win));

    expect(win.setSize).toHaveBeenCalledWith({ width: 1120, height: 687 });
    expect(win.center).not.toHaveBeenCalled();
  });

  it('浏览器 dev（非壳）：不取窗口、不抛错', async () => {
    const getWindow = vi.fn(async () => fakeWindow());
    await expect(
      applyWelcomeWindow({ width: 1120, height: 570 }, {}, backendOf(getWindow, false)),
    ).resolves.toBeUndefined();
    expect(getWindow).not.toHaveBeenCalled();
  });

  it('取窗口失败：只 warn、不向外抛（弹窗几何失败不挡启动）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const backend = backendOf(async () => {
      throw new Error('no window');
    });
    await expect(applyWelcomeWindow({ width: 1120, height: 570 }, {}, backend)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('applyEditorWindow：编辑器态（可缩放、可最大化、下限 960×620）', () => {
  it('恢复可缩放 / 可最大化 / 下限与 1280×840，并居中', async () => {
    const win = fakeWindow();
    await applyEditorWindow(backendOf(async () => win));

    expect(win.setResizable).toHaveBeenCalledWith(true);
    expect(win.setMaximizable).toHaveBeenCalledWith(true);
    expect(win.setMinSize).toHaveBeenCalledWith(EDITOR_MIN_SIZE);
    expect(win.setSize).toHaveBeenCalledWith(EDITOR_WINDOW_SIZE);
    expect(win.center).toHaveBeenCalledTimes(1);
    expect(vi.mocked(win.setMinSize).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(win.setSize).mock.invocationCallOrder[0]!,
    );
  });

  it('浏览器 dev（非壳）：不取窗口、不抛错', async () => {
    const getWindow = vi.fn(async () => fakeWindow());
    await expect(applyEditorWindow(backendOf(getWindow, false))).resolves.toBeUndefined();
    expect(getWindow).not.toHaveBeenCalled();
  });

  it('setSize 失败：只 warn、不向外抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const win = fakeWindow({
      setSize: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(applyEditorWindow(backendOf(async () => win))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/**
 * 弹窗态没有系统标题栏 ⇒ 右上角必须有「只退应用」的 ×（启动层自带一枚）。
 * 欢迎页自己的 × 仍是「关闭欢迎页」（收起为 ClosedState），两者不许叠在同一点。
 */
describe('弹窗退出钮', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const app = read('../src/ui/App.tsx');
  const chromeCss = read('../src/window-chrome.css');
  const welcomeCss = read('../src/ui/welcome.css');

  it('只在「无项目且非启动相位」渲染，点击走 closeWindow', () => {
    expect(app).toContain("project === null && phase !== 'boot'");
    const at = app.indexOf('className="app-popup-close"');
    expect(at).toBeGreaterThan(-1);
    const block = app.slice(at - 200, at + 500);
    expect(block).toContain('aria-label="退出应用"');
    expect(block).toContain('title="退出应用"');
    expect(block).toContain('closeWindow()');
  });

  it('与启动层共用一套钮样式，且压住欢迎卡、低于模态遮罩', () => {
    expect(chromeCss).toMatch(/\.boot-splash-close,\s*\n\.app-popup-close\s*\{/);
    expect(chromeCss).toMatch(/\.app-popup-close\s*\{\s*\n\s*z-index: 3;/);
  });

  it('弹窗里欢迎页自己的 × 左移让位，保留「关闭欢迎页」语义', () => {
    expect(welcomeCss).toMatch(/\.app-frame-popup \.welcome-screen \.welcome-close \{\s*\n\s*right: 52px;/);
  });
});
