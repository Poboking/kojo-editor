// @vitest-environment happy-dom
/**
 * **CTX-SMOKE 判定逻辑的 DOM 重演**（2026-10-23）。
 *
 * 真机冒烟要 Rust 全量编译才能跑（本机没有 `src-tauri/target`），所以这里在 happy-dom 里
 * 把**同一份判据**重演一遍：渲染真实的 `ContextMenuHost` ＋ 真实的三级路由
 * （`buildContextMenuRoute`），再喂 `judgeContextMenuProbes` —— 判的是冒烟脚本会判的那几条，
 * 不另写一套"大概相当"的期望。
 *
 * 覆盖：
 * - **B**：`data-context-surface` 热区 → 路由命中该面 → 菜单 aria-label 等于清单中文名
 *   （含反例：命中兜底面时判红）；
 * - **A2**：宿主渲染出来的菜单项全中文、aria-label 透传（含反例：混进英文项判红）；
 * - **C**：遮罩上 `mousedown` 右键不关菜单、左键关（`isPrimaryButton` 修复的行为面；
 *   真机 C 组是同一串事件序列）；
 * - **D**：层叠判定是纯数值/命中测试，happy-dom 没有布局 ⇒ 直接喂读数验判据边界
 *   （1299 红 / 1300 绿 / 命中测试落空红）。
 *
 * 目的很具体：真机冒烟不可跑的那些日子里，至少"判据会不会误判"是每次 CI 都在验的。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { buildContextMenuRoute, declareContextSurface } from '../src/ui/context-surfaces';
import {
  closeContextMenu,
  ContextMenuHost,
  openContextMenu,
} from '../src/ui/context-menu-host';
import { judgeContextMenuProbes } from '../../../tools/context-menu-smoke.mjs';

/* 测试面：id 取清单里已有的（不新增面，也不触发"清单外 id"告警） */
const TABS_ITEMS = [{ id: 'tabs.close', label: '关闭标签', group: '标签' }];
declareContextSurface({
  id: 'tabs',
  ariaLabel: '标签页菜单',
  area: 'explorer',
  build: () => TABS_ITEMS,
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const groupChecks = (checks: readonly { group: string; ok: boolean; name: string }[], group: string) =>
  checks.filter((c) => c.group === group);
const failedNames = (checks: readonly { ok: boolean; name: string }[]) =>
  checks.filter((c) => c.ok !== true).map((c) => c.name);

/** 只有 B 组读数的骨架（另外两处热区按"不在场"跳过——与真机同一档语义） */
const bReadings = (zone: Record<string, unknown>) => ({
  b: [
    { key: 'file-tree', label: '文件树行', applicable: false, reason: '文件树行热区不在场（重演里没有文件树）' },
    zone,
    { key: 'panel', label: '面板', applicable: false, reason: '面板热区不在场（重演里没有面板）' },
  ],
});

describe('B · 热区 → 面 → aria-label（真实三级路由）', () => {
  it('data-context-surface="tabs" 的宿主右键命中 tabs 面，aria-label 是清单中文名', () => {
    const host = document.createElement('div');
    host.setAttribute('data-context-surface', 'tabs');
    const deep = document.createElement('span');
    host.appendChild(deep);
    document.body.appendChild(host);

    const route = buildContextMenuRoute(deep, new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 20 }));
    expect(route?.source).toBe('tabs');
    expect(route?.ariaLabel).toBe('标签页菜单');

    const judged = judgeContextMenuProbes(
      bReadings({
        key: 'tabs',
        label: '标签页',
        applicable: true,
        expectId: 'tabs',
        surfaceId: 'tabs',
        menu: true,
        ariaLabel: route?.ariaLabel ?? null,
        items: (route?.items ?? []).map((i) => i.label),
      }),
    );
    expect(failedNames(groupChecks(judged.checks, 'B'))).toEqual([]);
    host.remove();
  });

  it('反例：命中的是兜底面（aria-label=通用菜单）⇒ B 组判红，不会"没炸就算过"', () => {
    const plain = document.createElement('div');
    const deep = document.createElement('span');
    plain.appendChild(deep);
    document.body.appendChild(plain);

    const route = buildContextMenuRoute(deep, new MouseEvent('contextmenu', { bubbles: true, clientX: 9, clientY: 9 }));
    expect(route?.source).toBe('app-fallback');
    expect(route?.ariaLabel).toBe('通用菜单');

    const judged = judgeContextMenuProbes(
      bReadings({
        key: 'tabs',
        label: '标签页',
        applicable: true,
        expectId: 'tabs',
        surfaceId: 'app-fallback',
        menu: true,
        ariaLabel: route?.ariaLabel ?? null,
        items: ['复制'],
      }),
    );
    expect(failedNames(groupChecks(judged.checks, 'B'))).toContain('B 标签页 不是兜底菜单');
    plain.remove();
  });
});

describe('A2/C · 真实 ContextMenuHost 的渲染与遮罩事件', () => {
  let container: HTMLDivElement;
  let root: Root;

  const menuEl = (): HTMLElement | null => container.querySelector<HTMLElement>('.context-menu-host .context-menu');
  const backdropEl = (): HTMLElement | null => container.querySelector<HTMLElement>('.context-menu-backdrop');

  const openEditorMenu = async (items: readonly { id: string; label: string }[]): Promise<void> => {
    await act(async () => {
      openContextMenu({
        x: 40,
        y: 60,
        items,
        ariaLabel: '编辑器菜单',
        onSelect: () => undefined,
      });
    });
  };

  const pressBackdrop = async (button: number): Promise<void> => {
    const backdrop = backdropEl();
    expect(backdrop, '遮罩必须在场（C 组的前提）').not.toBeNull();
    await act(async () => {
      backdrop!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button }));
    });
  };

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(ContextMenuHost, null));
    });
  });

  afterEach(async () => {
    await act(async () => {
      closeContextMenu();
    });
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('渲染出的菜单项全中文，aria-label 透传（A2 的判据在真实 DOM 上也成立）', async () => {
    await openEditorMenu([
      { id: 'frame.copyPath', label: '复制文件路径' },
      { id: 'workbench.commandPalette', label: '命令面板' },
    ]);
    const menu = menuEl();
    expect(menu).not.toBeNull();
    expect(menu?.getAttribute('aria-label')).toBe('编辑器菜单');
    const texts = Array.from(menu!.querySelectorAll('[role="menuitem"]')).map((el) =>
      String(el.textContent ?? '').trim(),
    );
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((t) => /[\u4e00-\u9fff]/.test(t))).toBe(true);

    const judged = judgeContextMenuProbes({
      a2: {
        applicable: true,
        menu: true,
        ariaLabel: menu?.getAttribute('aria-label') ?? null,
        items: texts,
        cjkAll: texts.every((t) => /[\u4e00-\u9fff]/.test(t)),
        english: texts.filter((t) => ['Copy', 'Paste', 'Select All', 'Inspect'].includes(t)),
        editorAlive: true,
      },
    });
    const a2 = groupChecks(judged.checks, 'A').filter((c) => c.name.startsWith('A2'));
    expect(failedNames(a2)).toEqual([]);
  });

  it('宿主是最后一道中文化闸：英文项被丢弃，屏上只剩中文项', async () => {
    await openEditorMenu([
      { id: 'frame.copyPath', label: '复制文件路径' },
      { id: 'native.selectAll', label: 'Select All' },
    ]);
    const texts = Array.from(menuEl()!.querySelectorAll('[role="menuitem"]')).map((el) =>
      String(el.textContent ?? '').trim(),
    );
    expect(texts).toEqual(['复制文件路径']);
  });

  it('反例：读数里混进英文原生项 ⇒ A2 判定红（真机读数面；宿主过滤挡不住"面自己造了英文项"的回归）', () => {
    const texts = ['复制文件路径', 'Select All'];
    const judged = judgeContextMenuProbes({
      a2: {
        applicable: true,
        menu: true,
        ariaLabel: '编辑器菜单',
        items: texts,
        cjkAll: texts.every((t) => /[\u4e00-\u9fff]/.test(t)),
        english: texts.filter((t) => ['Copy', 'Paste', 'Select All', 'Inspect'].includes(t)),
        editorAlive: true,
      },
    });
    const a2 = groupChecks(judged.checks, 'A').filter((c) => c.name.startsWith('A2'));
    expect(failedNames(a2)).toEqual(['A2 菜单项全中文', 'A2 无英文原生项']);
  });

  it('遮罩上右键（button=2）不关菜单、左键（button=0）关 —— C 组同一串事件', async () => {
    await openEditorMenu([{ id: 'frame.copyPath', label: '复制文件路径' }]);
    expect(menuEl()).not.toBeNull();
    const hadBackdrop = backdropEl() !== null;
    expect(hadBackdrop).toBe(true);

    await pressBackdrop(2);
    const afterRight = menuEl() !== null;
    expect(afterRight, '右键按下就把菜单关掉了：遮罩没走 isPrimaryButton').toBe(true);

    await pressBackdrop(0);
    const afterLeft = menuEl() !== null;
    expect(afterLeft).toBe(false);

    const judged = judgeContextMenuProbes({
      c: { opened: true, backdrop: hadBackdrop, afterRight, afterLeft },
    });
    expect(failedNames(groupChecks(judged.checks, 'C'))).toEqual([]);
  });

  it('反例：把右键当成"关窗"（afterRight=false）⇒ C 判红', () => {
    const judged = judgeContextMenuProbes({ c: { opened: true, backdrop: true, afterRight: false, afterLeft: false } });
    expect(failedNames(groupChecks(judged.checks, 'C'))).toEqual(['C 遮罩上右键不关菜单']);
  });
});

describe('D · 层叠判据的边界（纯读数）', () => {
  const baseD = {
    opened: true,
    hostZ: 1300,
    menuZ: 1101,
    insideHost: true,
    floats: [{ z: 1200, text: '浮窗' }],
    inlineMenus: [1101],
    itemRect: { left: 10, top: 10, width: 100, height: 20 },
    hitTag: 'span',
    hitInside: true,
  };

  it('宿主 1300 / 浮层 1200 / 就地菜单 1101 / 命中测试通过 ⇒ 全过', () => {
    const judged = judgeContextMenuProbes({ d: baseD });
    expect(failedNames(groupChecks(judged.checks, 'D'))).toEqual([]);
  });

  it('宿主 1299 ⇒ 红（差一档就是被浮层盖住）', () => {
    const judged = judgeContextMenuProbes({ d: { ...baseD, hostZ: 1299 } });
    expect(failedNames(groupChecks(judged.checks, 'D'))).toContain('D 宿主 z-index ≥ 1300');
  });

  it('浮层数值 ≥ 宿主 ⇒ 红', () => {
    const judged = judgeContextMenuProbes({ d: { ...baseD, floats: [{ z: 1300, text: '浮窗' }] } });
    expect(failedNames(groupChecks(judged.checks, 'D'))).toContain('D 浮层都压在宿主之下');
  });

  it('数值对但命中测试落空 ⇒ 红（"点不到"只有命中测试抓得住）', () => {
    const judged = judgeContextMenuProbes({ d: { ...baseD, hitInside: false, hitTag: 'div' } });
    expect(failedNames(groupChecks(judged.checks, 'D'))).toContain('D 菜单项真的在最高层（命中测试）');
  });

  it('菜单挂在宿主外（层叠上下文不可比）⇒ 红', () => {
    const judged = judgeContextMenuProbes({ d: { ...baseD, insideHost: false } });
    expect(failedNames(groupChecks(judged.checks, 'D'))).toContain('D 菜单挂在宿主内');
  });
});

describe('总闸口径：缺组不绿 / 跳过不算失败', () => {
  it('四组全缺 ⇒ pass=false（不会因为一条都没跑到就判过）', () => {
    const judged = judgeContextMenuProbes({});
    expect(judged.pass).toBe(false);
    const groups = new Set(judged.checks.map((c) => c.group));
    expect([...groups].sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('B 组"热区不在场"记为跳过而非失败，但会列进 skipped', () => {
    const judged = judgeContextMenuProbes({
      b: [
        { key: 'file-tree', label: '文件树行', applicable: false, reason: '不在场' },
        { key: 'tabs', label: '标签页', applicable: false, reason: '不在场' },
        { key: 'panel', label: '面板', applicable: false, reason: '不在场' },
      ],
    });
    const b = groupChecks(judged.checks, 'B');
    expect(b.every((c) => c.ok)).toBe(true);
    expect(judged.skipped.length).toBe(3);
    // 其余组还没过 ⇒ 总闸仍是红（跳过不等于整轮绿）
    expect(judged.pass).toBe(false);
  });
});
