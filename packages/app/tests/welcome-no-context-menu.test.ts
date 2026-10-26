// @vitest-environment happy-dom
/**
 * 欢迎页**免右键面**的判据（2026-10-26，接替原 `pages-menus.test.ts`）。
 *
 * ## 为什么这页从"有菜单"变成"不出菜单"
 *
 * 原用例钉的是 `welcome` / `welcome-recent` 两个面的菜单项集合（打开 / 移除 / 复制路径 /
 * 在资源管理器里显示…）。2026-10-26 用户实测发现右键直接把欢迎页打死，根因是**样式分档**：
 * 菜单的定位几何当时全写在重档 `styles-project.css` 里，而重档只在进项目时动态加载
 * ⇒ 弹窗态的菜单是一块没有定位的通栏裸块，遮罩算出 0 高（点空白关不掉），
 * 且 `.context-menu-backdrop` 只要在文档里整窗拖动就被 `canStartWindowDragFrom` 拒掉。
 *
 * 处置：欢迎页成为**免右键面**——清单里 `welcome` 带 `suppressMenu: true`，根路由第零级
 * 命中即返回 `null`；整条菜单子系统退役。几何同时下沉到轻档 `context-menu.css`
 * （判据在 `context-menu-layering.test.ts`）。
 *
 * ## 白名单为什么是清单的一列，而不是另一个标记
 *
 * 第一版用的是独立 DOM 标记（`data-no-context-menu`），2026-10-26 收口时改成清单字段：
 * 清单本来就是"有哪些区域、各叫什么"的唯一真源，"这片出不出菜单"是同一件事的另一面；
 * 两个机制并存 ⇒ 两处真源必然漂。现在宿主仍写 `data-context-surface="welcome"`（它确实是
 * 一个有宿主的区域），"不出菜单"只在清单里说一次。
 *
 * 白名单是**整片**语义（一路查到文档根）：面里的任何元素都不出菜单，连输入框面与已登记的
 * 面都不问——欢迎页上浮起的模态是卡片的**兄弟节点**，不在这一面里。
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// 副作用 import：欢迎页在模块顶层声明自己的面（"谁渲染谁声明"）
import '../src/ui/WelcomeView';
import {
  clipboardAvailable,
  copyText,
  isFailureNote,
  isPrimaryButton,
} from '../src/ui/context-menu-pages';
import {
  CONTEXT_SURFACE_MANIFEST,
  buildContextMenuRoute,
  declareContextSurface,
  getContextSurface,
  listSuppressedSurfaces,
} from '../src/ui/context-surfaces';

/**
 * 读源码：happy-dom 环境里 `import.meta.url` 不是 file: 协议（`fileURLToPath` 会炸），
 * 所以先试 URL 锚定、再退回从 cwd 逐级上溯——`pnpm test`（root）与 `--filter app`
 * 两种起跑点都能命中，找不到就明确炸给看，不静默空扫（同 `welcome-layout.test.ts` 口径）。
 */
function read(relative: string): string {
  const candidates: string[] = [];
  try {
    candidates.push(path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', relative));
  } catch {
    /* 非 file: 环境：留逐级上溯兜底 */
  }
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    candidates.push(path.join(dir, 'packages', 'app', 'src', relative));
    candidates.push(path.join(dir, 'src', relative));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }
  throw new Error(`${relative} 未找到（cwd=${process.cwd()}）`);
}

const WELCOME_SRC = read('ui/WelcomeView.tsx');
const PAGES_SRC = read('ui/context-menu-pages.ts');

const event = (): MouseEvent =>
  new MouseEvent('contextmenu', { bubbles: true, clientX: 8, clientY: 9 });

/** 造一片欢迎页（面根 + 卡片 + 最深节点），返回卡片里那个最深的元素 */
function mountWelcome(): { root: HTMLElement; deep: HTMLElement } {
  const root = document.createElement('div');
  root.setAttribute('data-context-surface', 'welcome');
  const card = document.createElement('div');
  card.className = 'welcome-card';
  const deep = document.createElement('span');
  deep.className = 'welcome-tagline';
  card.appendChild(deep);
  root.appendChild(card);
  document.body.appendChild(root);
  return { root, deep };
}

/** 清场：每个用例都从干净文档起（注册表是模块级单例，只在需要时按 id 覆盖） */
function resetDom(): void {
  document.body.innerHTML = '';
}

describe('免右键面：欢迎页整片不出菜单', () => {
  it('面根里任意位置右键 ⇒ 一个菜单都不开（连兜底都不给）', () => {
    resetDom();
    const { deep } = mountWelcome();
    expect(buildContextMenuRoute(deep, event())).toBeNull();
  });

  it('按钮里的文字也算同一片（行内深处不逃逸）', () => {
    resetDom();
    const { root } = mountWelcome();
    const button = document.createElement('button');
    const label = document.createElement('span');
    button.appendChild(label);
    root.appendChild(button);
    expect(buildContextMenuRoute(label, event())).toBeNull();
  });

  it('面里的输入框也不出菜单（白名单先于输入框面）', () => {
    resetDom();
    const { root } = mountWelcome();
    const input = document.createElement('input');
    root.appendChild(input);
    expect(buildContextMenuRoute(input, event())).toBeNull();
  });

  it('面里即使有已登记的面，也不问它（面的 build 一次都不跑）', () => {
    resetDom();
    let calls = 0;
    declareContextSurface({
      id: 'status-bar',
      ariaLabel: '状态栏菜单',
      area: 'chrome',
      build: () => {
        calls += 1;
        return [{ id: 'status.demo', label: '演示项' }];
      },
    });
    const { root } = mountWelcome();
    const surfaceRoot = document.createElement('div');
    surfaceRoot.setAttribute('data-context-surface', 'status-bar');
    root.appendChild(surfaceRoot);
    expect(buildContextMenuRoute(surfaceRoot, event())).toBeNull();
    expect(calls).toBe(0);
  });

  it('白名单之外照旧：应用根仍给通用菜单——白名单没有把整站关掉', () => {
    resetDom();
    mountWelcome();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const route = buildContextMenuRoute(outside, event());
    expect(route?.source).toBe('app-fallback');
  });

  it('兄弟节点上的面照常接管（面根不是祖先就不挡）', () => {
    resetDom();
    mountWelcome();
    declareContextSurface({
      id: 'tutorial',
      ariaLabel: '教程菜单',
      area: 'chrome',
      build: () => [{ id: 'tutorial.restart', label: '重新开始教程' }],
    });
    const modal = document.createElement('div');
    modal.setAttribute('data-context-surface', 'tutorial');
    const deep = document.createElement('p');
    modal.appendChild(deep);
    document.body.appendChild(modal);
    const route = buildContextMenuRoute(deep, event());
    expect(route?.source).toBe('tutorial');
  });
});

describe('白名单是清单的一列（不是第二张表）', () => {
  const manifestOf = (id: string) => CONTEXT_SURFACE_MANIFEST.find((entry) => entry.id === id);

  it('清单里 welcome 带 suppressMenu: true，且它是唯一一个免右键面', () => {
    expect(manifestOf('welcome')?.suppressMenu).toBe(true);
    expect(listSuppressedSurfaces()).toEqual(['welcome']);
  });

  it('免右键面不许有 build（有 build = 有人还想给它菜单，两处说法打架）', () => {
    for (const id of listSuppressedSurfaces()) {
      expect(getContextSurface(id), `${id} 未声明`).toBeDefined();
      expect(getContextSurface(id)?.build, `${id} 免右键却有 build`).toBeUndefined();
    }
  });

  it('清单里没有 welcome-recent（行级面随菜单一起退役，整页一片白名单即可覆盖）', () => {
    expect(manifestOf('welcome-recent')).toBeUndefined();
    expect(getContextSurface('welcome-recent')).toBeUndefined();
  });

  it('欢迎页真有面根、真有声明（清单 ⇄ 宿主对账，与 context-coverage 同一把尺）', () => {
    expect(WELCOME_SRC).toContain('data-context-surface="welcome"');
    expect(WELCOME_SRC).toContain("declareContextSurface({ id: 'welcome'");
    // 第一版的独立 DOM 标记已退役：不许再有两套机制并存
    expect(WELCOME_SRC).not.toContain('data-no-context-menu');
  });

  it('WelcomeView 不再注册接线桥，也没有"菜单回执"那一行了', () => {
    expect(WELCOME_SRC).not.toContain('registerWelcomeMenuBridge');
    expect(WELCOME_SRC).not.toContain('useMenuNote');
    expect(WELCOME_SRC).not.toContain('welcome-menu-note');
    // 行上不再挂只给菜单读的行数据
    expect(WELCOME_SRC).not.toContain('data-recent-root');
  });

  it('context-menu-pages 只剩公共小件（欢迎页菜单构建器全退役）', () => {
    for (const gone of [
      'buildWelcomePageMenu',
      'buildWelcomeRecentMenu',
      'registerWelcomeMenuBridge',
      'WELCOME_PAGE_ACTION',
      'WELCOME_RECENT_ACTION',
    ]) {
      expect(PAGES_SRC, gone).not.toContain(gone);
    }
    // 留下的这几件仍要导出（设置页 / 快捷键页在消费）
    expect(PAGES_SRC).toContain('export function clipboardAvailable');
    expect(PAGES_SRC).toContain('export function copyText');
    expect(PAGES_SRC).toContain('export function useMenuNote');
    expect(PAGES_SRC).toContain('export function isFailureNote');
  });
});

describe('公共小件（原用例的接续）', () => {
  it('回执文案的成败判据：成功不上错误色，失败上', () => {
    expect(isFailureNote('已复制项目路径')).toBe(false);
    expect(isFailureNote('复制失败：剪贴板拒绝了这次写入')).toBe(true);
    expect(isFailureNote('这个动作现在没法执行')).toBe(true);
  });

  it('遮罩关窗只认左键：右键是开菜单，不是关浮层', () => {
    expect(isPrimaryButton({ button: 0 })).toBe(true);
    expect(isPrimaryButton({ button: 1 })).toBe(false); // 中键
    expect(isPrimaryButton({ button: 2 })).toBe(false); // 右键
  });

  it('没有剪贴板 ⇒ clipboardAvailable 为 false（能力不存在就不许假装有）', () => {
    const saved = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    try {
      expect(clipboardAvailable()).toBe(false);
    } finally {
      if (saved === undefined) delete (navigator as unknown as { clipboard?: unknown }).clipboard;
      else Object.defineProperty(navigator, 'clipboard', saved);
    }
  });

  it('没有剪贴板时复制要留下失败回执（不许静默）', () => {
    const saved = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const notes: string[] = [];
    try {
      copyText('D:/proj', '项目路径', (line) => notes.push(line));
    } finally {
      if (saved === undefined) delete (navigator as unknown as { clipboard?: unknown }).clipboard;
      else Object.defineProperty(navigator, 'clipboard', saved);
    }
    expect(notes).toEqual(['复制失败：当前环境没有可用的剪贴板']);
  });

  it('写成功 ⇒ 一句「已复制…」；写失败 ⇒ 一句失败（两条路都要说话）', async () => {
    const saved = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const notes: string[] = [];
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: () => Promise.resolve() },
        configurable: true,
      });
      copyText('D:/proj', '项目路径', (line) => notes.push(line));
      await Promise.resolve();
      await Promise.resolve();

      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: () => Promise.reject(new Error('denied')) },
        configurable: true,
      });
      copyText('D:/proj', '项目路径', (line) => notes.push(line));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      if (saved === undefined) delete (navigator as unknown as { clipboard?: unknown }).clipboard;
      else Object.defineProperty(navigator, 'clipboard', saved);
    }
    expect(notes).toEqual(['已复制项目路径', '复制失败：剪贴板拒绝了这次写入']);
  });
});
