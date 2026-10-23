// @vitest-environment happy-dom
/**
 * 覆盖面契约（1023 · WP6.1）：清单与声明必须一一对应。
 *
 * 这条测试的存在理由，是这一批最容易被"看起来做完了"骗过去的地方：
 *
 * - **清单里有、没人声明**：`CONTEXT_SURFACE_MANIFEST` 是 WP0 按任务清单一次写全的
 *   31 个面（原本 33，`outline` 与 `market` 因无宿主已移除），逐路补面很容易漏掉一两面，
 *   而漏掉的那一面在运行期**没有任何报错**——右键落上去，走通用兜底菜单，用户以为"这里
 *   本来就没菜单"。本次盘面时就是这样发现 `market` / `plugin-panel` 悬空的。
 * - **有声明、清单里没有**：`declareContextSurface` 对清单外 id 只 warn 不抛（热重载友好），
 *   所以运行期也不会红；后果是"无障碍名"没有权威来源。
 *
 * 因此这里**显式 import 每一个声明模块**（副作用 import），把注册表填满再对账。
 * 这条路必须写死 import 清单：懒加载的模块（调用层级 / 差异视图…）不 import 就不会登记，
 * 而"忘了 import"正是要抓的那类错。
 */
import { describe, expect, it } from 'vitest';

// —— 副作用 import：这些模块在顶层 declareContextSurface，加载即登记 ——
import '../src/ui/context-surfaces';
import '../src/ui/search-menu';
import '../src/ui/problem-menu';
import '../src/ui/Palette';
import '../src/ui/editor-pane/preview-menu';
import '../src/ui/tutorial-context-menu';
import '../src/ui/context-menu-pages';
import '../src/ui/context-menu-shell';
import '../src/ui/tabs-bar';
import '../src/ui/file-tree-menu';
import '../src/ui/breadcrumb-bar';
import '../src/ui/CallHierarchyOverlay';
import '../src/ui/DiffViewOverlay';
import '../src/ui/FileHistoryOverlay';
import '../src/ui/OpsHistoryOverlay';
import '../src/ui/plugin-panel-menu';

import {
  CONTEXT_SURFACE_MANIFEST,
  getContextSurface,
  listContextSurfaces,
  type ContextSurfaceArea,
} from '../src/ui/context-surfaces';
import { isChineseMenuLabel } from '../src/ui/context-menu-model';

const AREAS: readonly ContextSurfaceArea[] = ['editor', 'explorer', 'panel', 'chrome', 'plugin', 'host'];

describe('覆盖面契约：清单 ⇄ 声明', () => {
  it('清单里每个面都有人声明（清单是契约，不是愿望清单）', () => {
    const missing = CONTEXT_SURFACE_MANIFEST.filter((entry) => getContextSurface(entry.id) === undefined).map(
      (entry) => entry.id,
    );
    expect(missing).toEqual([]);
  });

  it('没有清单外的声明（新面必须先来清单登记）', () => {
    const manifestIds = new Set(CONTEXT_SURFACE_MANIFEST.map((entry) => entry.id));
    const extra = listContextSurfaces()
      .filter((spec) => !manifestIds.has(spec.id))
      .map((spec) => spec.id);
    expect(extra).toEqual([]);
  });

  it('声明的无障碍名与清单逐字一致（清单是无障碍名的唯一真源）', () => {
    for (const entry of CONTEXT_SURFACE_MANIFEST) {
      const spec = getContextSurface(entry.id);
      expect(spec?.ariaLabel, entry.id).toBe(entry.ariaLabel);
    }
  });

  it('六个分区每个都至少有一个面（删面时要顺带想清楚分区还立不立得住）', () => {
    for (const area of AREAS) {
      const inArea = CONTEXT_SURFACE_MANIFEST.filter((entry) => entry.area === area);
      expect(inArea.length, area).toBeGreaterThan(0);
    }
  });

  it('每个面的无障碍名都是中文（英文 = 读屏里冒出生肉）', () => {
    for (const entry of CONTEXT_SURFACE_MANIFEST) {
      expect(isChineseMenuLabel(entry.ariaLabel), entry.id).toBe(true);
    }
  });
});

describe('覆盖面契约：无宿主的面不得只往清单里塞一行字', () => {
  /**
   * `outline`（大纲面板）在本次收口时从清单删除，理由是**本仓库没有对应的宿主**：
   * 只有语言能力枚举 `Outline` 与 documentSymbol 提供者，没有面板视图。
   *
   * 这条不是"禁止将来加"，而是**加回来时必须有宿主**：先把面板做出来，再连同
   * `data-context-surface` 一起登记，不要只往清单里塞一行字。
   *
   * （`market` 走过同一条路但结局相反：它先因无宿主被移除，随后插件面契约
   *  `plugin-api/src/context-surface.ts` 落地——插件把 build 交上来、宿主侧声明，
   *  宿主真的回来了，于是它被登记回清单。判据看的是"有没有宿主"，不是"曾经删没删过"。）
   */
  it('outline 不在清单里（本仓库无大纲面板）', () => {
    expect(CONTEXT_SURFACE_MANIFEST.map((entry) => entry.id)).not.toContain('outline');
  });

  it('market 在清单里且真有声明（插件承载、宿主声明）', () => {
    expect(CONTEXT_SURFACE_MANIFEST.map((entry) => entry.id)).toContain('market');
    expect(getContextSurface('market')).toBeDefined();
  });
});
