// @vitest-environment happy-dom
/**
 * 左键判据的唯一来源（1023 覆盖面批 · WP6 防回归）。
 *
 * 这一批真实踩到的坑：**一个判据被三处遮罩各自手写**。
 * - `Palette.tsx` 的 picker 遮罩 `onMouseDown={onClose}`：右键按下先把快速打开关掉，
 *   根路由随后收到 contextmenu，面已不在场——菜单永远弹不出来；
 * - `ShellLayout.tsx` 的 `overlay-backdrop`：同款。教程浮层与设置页**分别、独立**撞到，
 *   说明这不是某一处的疏忽，而是"没有统一判据"的必然；
 * - `SettingsPanel.tsx` 的 `closeOnBackdrop`：pages-settings 那路自己发现并修了，
 *   但当时把判据定义在 `context-menu-pages.ts`（页面菜单模块）里——Palette / 壳层要用
 *   就得从"页面菜单"import，语义上说不通，也预示着迟早会出现第四份。
 *
 * 现在判据收在 `context-menu-model.isPrimaryButton`（数据面，零 React），三处共用。
 *
 * **守门只盯遮罩那一段**：`ShellLayout` 里另有 4 处 `e.button !== 0` 是**拖拽起点**
 * 判定（`startDrag` / `startFloatDrag` / `startFloatResize` / `startSectionDrag`），
 * 语义同为"只认左键"、但属稳定路径且与本批无关——把它们一起改掉只是 diff 噪音，
 * 还会动到拖拽的热路径。守门按锚点切片，只对遮罩生效。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isPrimaryButton } from '../src/ui/context-menu-model';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('isPrimaryButton · 只认左键', () => {
  it('左键 true；中键 / 右键 / 侧键 false', () => {
    expect(isPrimaryButton({ button: 0 })).toBe(true);
    expect(isPrimaryButton({ button: 1 })).toBe(false);
    expect(isPrimaryButton({ button: 2 })).toBe(false);
    expect(isPrimaryButton({ button: 3 })).toBe(false);
  });
});

describe('源码守门：遮罩一律走 isPrimaryButton', () => {
  /** 取锚点之后的一段（遮罩的 handler 就在这附近）；不做解析，只覆盖到即可 */
  const around = (source: string, anchor: string, size = 700): string => {
    const at = source.indexOf(anchor);
    expect(at, `锚点 ${anchor} 必须还在`).toBeGreaterThan(-1);
    return source.slice(at, at + size);
  };

  const backdrops = [
    { file: '../src/ui/Palette.tsx', anchor: 'picker-backdrop' },
    { file: '../src/ui/ShellLayout.tsx', anchor: 'overlay-backdrop' },
    { file: '../src/ui/SettingsPanel.tsx', anchor: 'closeOnBackdrop' },
    // 第四份漏网（CTX-SMOKE 真机冒烟抓到的）：根宿主菜单自己的遮罩原本写成
    // `onMouseDown={onDismiss}`——右键在菜单外按一下先关菜单、紧接着 `onContextMenu`
    // 又把 contextmenu 吃掉 ⇒ 「右键点外面，菜单没了、新的也不出来」。
    { file: '../src/ui/context-menu.tsx', anchor: 'context-menu-backdrop' },
  ] as const;

  for (const { file, anchor } of backdrops) {
    it(`${file} 的 ${anchor} 用了统一判据`, () => {
      expect(around(read(file), anchor)).toContain('isPrimaryButton');
    });

    it(`${file} 的 ${anchor} 没有手写按键数值`, () => {
      // 手写 `.button === 0` / `.button !== 0` 就是第四份判据——三份已经漏过两次
      expect(around(read(file), anchor)).not.toMatch(/\.button\s*[!=]==?\s*0/);
    });
  }
});
