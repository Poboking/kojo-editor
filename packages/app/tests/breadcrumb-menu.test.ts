// @vitest-environment happy-dom
/**
 * 面包屑右键菜单（1023 覆盖面批 · WP2.5）的判据。
 *
 * 三件事各钉一条：
 * - 「复制层级名」复制的是**名字**，与「复制路径」是两件事（任务口径）；
 * - 能力缺席就整项不显示（没有路径 / 没有项目根 / 没有桌面壳通道 / 没有剪贴板）；
 * - 一个项目都没有（`levels` 为空 ⇒ 整条栏不渲染 ⇒ 面拿不到现场）时，右键**退兜底**
 *   ——不弹空壳菜单。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  crumbContextMenuItems,
  crumbSiblingId,
  crumbSiblingIndex,
  type CrumbLevel,
  type CrumbMenuCapability,
  type CrumbMenuItemSpec,
} from '../src/ui/breadcrumb-path';
import {
  crumbSurfaceItems,
  setCrumbMenuRuntime,
  type CrumbMenuRuntime,
} from '../src/ui/breadcrumb-bar';
import { buildContextMenuRoute } from '../src/ui/context-surfaces';
import { isChineseMenuLabel } from '../src/ui/context-menu-model';

const FULL_CAP: CrumbMenuCapability = {
  canClipboard: true,
  hasFilePath: true,
  hasProjectRoot: true,
  canReveal: true,
};

const level = (over: Partial<CrumbLevel> = {}): CrumbLevel => ({
  current: { name: '『共通』イベント関数', kind: 'function', startLine: 40 },
  siblings: [
    { name: '『共通』イベント関数', kind: 'function', startLine: 40 },
    { name: '『固有』イベント関数', kind: 'function', startLine: 88 },
  ],
  hidden: 0,
  ...over,
});

const items = (index = 1, cap: CrumbMenuCapability = FULL_CAP, lv: CrumbLevel = level()) =>
  crumbContextMenuItems({ level: lv, index, levelCount: 3, cap });

describe('面包屑右键 · 项集合', () => {
  it('全能力：复制层级名 | 复制路径、复制相对路径 | 显示 | 选择上级、选择同级', () => {
    expect(items().map((i) => i.id)).toEqual([
      'copy-name',
      'copy-path',
      'copy-rel-path',
      'reveal',
      'select-parent',
      'siblings',
    ]);
  });

  it('「复制层级名」是名字不是路径（与「复制路径」两条独立项）', () => {
    const copy = items().find((i) => i.id === 'copy-name')!;
    expect(copy.label).toBe('复制层级名');
    expect(items().find((i) => i.id === 'copy-path')!.label).toBe('复制路径');
  });
});

describe('面包屑右键 · 能力缺席整项不显示', () => {
  it('没有剪贴板：三个复制项全部消失（点不动的入口不如没有）', () => {
    const ids = items(1, { ...FULL_CAP, canClipboard: false }).map((i) => i.id);
    expect(ids).not.toContain('copy-name');
    expect(ids).not.toContain('copy-path');
    expect(ids).not.toContain('copy-rel-path');
  });

  it('拿不到文件路径：复制路径 / 相对路径 / 在资源管理器中显示都消失', () => {
    const ids = items(1, { ...FULL_CAP, hasFilePath: false }).map((i) => i.id);
    expect(ids).toEqual(['copy-name', 'select-parent', 'siblings']);
  });

  it('拿不到项目根：只有「复制相对路径」消失（其余照常）', () => {
    const ids = items(1, { ...FULL_CAP, hasProjectRoot: false }).map((i) => i.id);
    expect(ids).toContain('copy-path');
    expect(ids).not.toContain('copy-rel-path');
  });

  it('浏览器壳（无桌面壳通道）：「在资源管理器中显示」整项消失', () => {
    expect(items(1, { ...FULL_CAP, canReveal: false }).map((i) => i.id)).not.toContain('reveal');
  });
});

describe('面包屑右键 · 禁用必须说话', () => {
  it('最外层没有上级：禁用 + 原因（项仍在，消失会被读成菜单坏了）', () => {
    const parent = items(0).find((i) => i.id === 'select-parent')!;
    expect(parent.disabled).toBe(true);
    expect(parent.disabledReason).toContain('最外一层');
  });

  it('非最外层：上级可点（没有 disabled）', () => {
    expect(items(1).find((i) => i.id === 'select-parent')!.disabled).toBeFalsy();
  });

  it('同级只有自己：整项不显示（点开只有自己的空壳不如没有）', () => {
    const solo = level({ siblings: [{ name: '只有我', kind: 'function', startLine: 5 }] });
    expect(items(1, FULL_CAP, solo).map((i) => i.id)).not.toContain('siblings');
  });

  it('同级被窗口截断：如实追加一条禁用说明（截断要说出来）', () => {
    const truncated = level({ hidden: 8 });
    const parent = items(1, FULL_CAP, truncated).find((i) => i.id === 'siblings')!;
    const tail = parent.children!.at(-1)!;
    expect(tail.disabled).toBe(true);
    expect(tail.label).toContain('8');
    expect(tail.disabledReason).toBeTruthy();
  });

  it('同级子菜单项带行号提示，当前项打勾', () => {
    const children = items(1).find((i) => i.id === 'siblings')!.children!;
    expect(children[0]!.shortcut).toBe('第 40 行');
    expect(children[0]!.checked).toBe(true);
    expect(children[1]!.checked).toBeFalsy();
  });
});

describe('面包屑右键 · 文案全中文 / 子菜单 id 编解码', () => {
  it('每一条 label（含子菜单与禁用说明）都含中文', () => {
    const walk = (list: readonly CrumbMenuItemSpec[]): void => {
      for (const item of list) {
        expect(isChineseMenuLabel(item.label), item.id).toBe(true);
        if (item.disabledReason !== undefined) expect(isChineseMenuLabel(item.disabledReason)).toBe(true);
        if (item.children !== undefined) walk(item.children);
      }
    };
    walk(items(1));
  });

  it('同级 id 编解码往返一致；非同级 id 一律 null（安静忽略）', () => {
    expect(crumbSiblingId(3)).toBe('sibling:3');
    expect(crumbSiblingIndex('sibling:3')).toBe(3);
    expect(crumbSiblingIndex('copy-path')).toBeNull();
    expect(crumbSiblingIndex('sibling:x')).toBeNull();
  });
});

describe('面包屑面路由 · 无现场 / 无项目时退兜底', () => {
  const act = vi.fn();
  const runtime = (over: Partial<CrumbMenuRuntime> = {}): CrumbMenuRuntime => ({
    levels: [level()],
    canClipboard: true,
    hasFilePath: true,
    hasProjectRoot: true,
    canReveal: true,
    act,
    ...over,
  });

  beforeEach(() => {
    act.mockClear();
    setCrumbMenuRuntime(null);
    document.body.innerHTML = '';
  });

  const mountBar = (index?: number): HTMLElement => {
    const bar = document.createElement('div');
    bar.setAttribute('data-context-surface', 'breadcrumb');
    const seg = document.createElement('span');
    if (index !== undefined) seg.setAttribute('data-crumb-index', String(index));
    bar.appendChild(seg);
    document.body.appendChild(bar);
    return seg;
  };

  it('没有现场（面包屑没挂载 / 一条链都没有）：这一级不表态 → 兜底菜单', () => {
    const seg = mountBar(0);
    expect(buildContextMenuRoute(seg, new MouseEvent('contextmenu'))?.source).toBe('app-fallback');
  });

  it('有现场：命中 breadcrumb 面，无障碍名来自清单，选中带回下标', () => {
    setCrumbMenuRuntime(runtime());
    const seg = mountBar(0);
    const route = buildContextMenuRoute(seg, new MouseEvent('contextmenu'));
    expect(route?.source).toBe('breadcrumb');
    expect(route?.ariaLabel).toBe('面包屑菜单');
    expect(route?.items.map((i) => i.id)).toContain('copy-name');
    route?.onSelect('select-parent');
    expect(act).toHaveBeenCalledWith('select-parent', 0);
  });

  it('链为空（空数组）：即便有现场也不接管', () => {
    setCrumbMenuRuntime(runtime({ levels: [] }));
    const seg = mountBar(0);
    expect(buildContextMenuRoute(seg, new MouseEvent('contextmenu'))?.source).toBe('app-fallback');
  });

  it('点在两段之间的缝隙（没有 data-crumb-index）：不接管', () => {
    setCrumbMenuRuntime(runtime());
    const seg = mountBar();
    expect(buildContextMenuRoute(seg, new MouseEvent('contextmenu'))?.source).toBe('app-fallback');
  });

  it('映射层把子菜单一并带出（同级那一项带 children）', () => {
    const rt = runtime();
    const mapped = crumbSurfaceItems(level(), 1, rt);
    const siblings = mapped.find((i) => i.id === 'siblings')!;
    expect(siblings.children).toHaveLength(2);
    expect(siblings.children?.[0]?.id).toBe('sibling:0');
  });
});
