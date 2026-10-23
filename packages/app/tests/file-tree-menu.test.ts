// @vitest-environment happy-dom
/**
 * 文件树右键菜单（1023 覆盖面批 · WP2.1 / WP2.2）的判据。
 *
 * 判据分三层，全部打在**纯函数 / 数据面**上，不靠完整渲染：
 * - 作用域 × 能力 × 视图 的 id 集合（哪一项在、哪一项不在）；
 * - 禁用必须说话（文件历史只认活动文件、没有活动文件时的定位）；
 * - 中文文案与命令项一致（命令面板的标题与键位取自键位注册表，不另造第二份）；
 * - 面路由：行元素 → `file-tree` 面、空白区 → `file-tree-root` 面、拿不到现场 → 兜底。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FileTreeContextMenu,
  fileTreeSurfaceMenu,
  readFileTreeScope,
  scopeKindOf,
  scopePathOf,
  setFileTreeMenuRuntime,
  toContextMenuItem,
  type FileTreeContextMenuProps,
  type FileTreeMenuRuntime,
  type FileTreeScope,
} from '../src/ui/file-tree-menu';
import { menuItemsFor, type MenuCapability, type MenuView } from '../src/ui/file-tree-ops';
import type { MenuScope } from '../src/ui/file-tree-types';
import { buildContextMenuRoute } from '../src/ui/context-surfaces';
import { isChineseMenuLabel, registerContextMenuCommandRunner } from '../src/ui/context-menu-model';
import { keybindingSpecOf } from '../src/ui/keybindings';

const cap = (over: Partial<MenuCapability> = {}): MenuCapability => ({
  hasIo: true,
  canReveal: true,
  canImport: true,
  canClipboard: true,
  canRelist: true,
  canHistory: true,
  canCommandPalette: true,
  canAddFolder: true,
  ...over,
});

const FULL = cap();
const NONE = cap({
  hasIo: false,
  canReveal: false,
  canImport: false,
  canClipboard: false,
  canRelist: false,
  canHistory: false,
  canCommandPalette: false,
  canAddFolder: false,
});

const idsOf = (scope: Parameters<typeof menuItemsFor>[0], c: MenuCapability, view: MenuView = 'kojo') =>
  menuItemsFor(scope, c, { view, activeFile: null }).map((i) => i.id);

const fileScope = (path = 'C:/koa/001/a.ERB'): FileTreeScope => ({ kind: 'file', path });
const dirScope = (path = 'C:/koa/001/少女之梦'): FileTreeScope => ({ kind: 'dir', path });
const pkgScope = (): FileTreeScope => ({ kind: 'package', dir: 'C:/koa/001/少女之梦', label: '少女之梦' });
const groupScope = (): FileTreeScope => ({ kind: 'group', label: '#1 霊夢', prefix: 'C:/koa/001' });

const contextEvent = (): MouseEvent => new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 20 });

/* ------------------------------ 作用域 × 能力矩阵 ------------------------------ */

describe('文件作用域 · 能力缺项时整项不显示', () => {
  it('全能力：九项，顺序 = 打开 | 复制三连 | 显示 | 刷新、历史 | 重命名、删除', () => {
    expect(idsOf('file', FULL)).toEqual([
      'open',
      'copy-name',
      'copy-path',
      'copy-rel-path',
      'reveal',
      'refresh',
      'history',
      'rename',
      'delete',
    ]);
  });

  it('剪贴板缺席：新增的「复制文件名」收走；既有两条复制项保留（旧口径不动）', () => {
    expect(idsOf('file', cap({ canClipboard: false }))).toContain('copy-path');
    expect(idsOf('file', cap({ canClipboard: false }))).not.toContain('copy-name');
  });

  it('无重列通道：刷新整项消失（没有 listDir 就没有这条腿）', () => {
    expect(idsOf('file', cap({ canRelist: false }))).not.toContain('refresh');
  });

  it('文件历史命令未注册：整项消失（不是灰着）', () => {
    expect(idsOf('file', cap({ canHistory: false }))).not.toContain('history');
  });

  it('无 io：重命名 / 删除整组消失（盘上动作没有落点）', () => {
    expect(idsOf('file', NONE)).toEqual(['open', 'copy-path', 'copy-rel-path']);
  });
});

describe('目录 / 作者包作用域', () => {
  it('目录：新建 | 复制 | 显示 | 刷新、折叠全部 | 重命名、删除', () => {
    expect(idsOf('dir', FULL)).toEqual([
      'new-file',
      'new-dir',
      'copy-name',
      'copy-path',
      'reveal',
      'refresh',
      'collapse-all',
      'rename',
      'delete',
    ]);
  });

  it('作者包：导入只在有通道时置顶；导入缺席时新建组顶头', () => {
    expect(idsOf('package', FULL)[0]).toBe('import');
    expect(idsOf('package', cap({ canImport: false }))[0]).toBe('new-file');
  });

  it('目录 / 包都不带「复制相对路径」（那是文件作用域的项，路径语义不同）', () => {
    expect(idsOf('dir', FULL)).not.toContain('copy-rel-path');
    expect(idsOf('package', FULL)).not.toContain('copy-rel-path');
  });
});

describe('根 / 角色组 / 空白区 · 被撤掉的那条工具条（WP2.2）', () => {
  it('角色组：视图两项 + 添加文件夹 + 展开/收起本组 + 定位 + 重读', () => {
    expect(idsOf('group', FULL)).toEqual([
      'switch-view-kojo',
      'switch-view-fs',
      'add-folder',
      'expand-all',
      'collapse-all',
      'locate',
      'relist',
    ]);
  });

  it('空白区：与角色组同源，另加命令面板（树里没东西可点时的兜底入口）', () => {
    const ids = idsOf('blank', FULL);
    expect(ids).toEqual([
      'switch-view-kojo',
      'switch-view-fs',
      'add-folder',
      'expand-all',
      'collapse-all',
      'locate',
      'relist',
      'command-palette',
    ]);
    expect(idsOf('group', FULL)).not.toContain('command-palette');
  });

  it('文件系统视图：展开全部整项不显示（按需列举的树一次性展开 = 递归读盘），折叠全部仍在', () => {
    const fsIds = idsOf('blank', FULL, 'fs');
    expect(fsIds).not.toContain('expand-all');
    expect(fsIds).toContain('collapse-all');
    expect(idsOf('group', FULL, 'fs')).not.toContain('expand-all');
  });

  it('视图切换两项用勾选表达"现在在哪一视图"', () => {
    const kojo = menuItemsFor('blank', FULL, { view: 'kojo' });
    expect(kojo.find((i) => i.id === 'switch-view-kojo')!.checked).toBe(true);
    expect(kojo.find((i) => i.id === 'switch-view-fs')!.checked).toBeFalsy();
    const fs = menuItemsFor('blank', FULL, { view: 'fs' });
    expect(fs.find((i) => i.id === 'switch-view-fs')!.checked).toBe(true);
  });

  it('无添加文件夹通道 / 无命令通道 / 无重列通道：对应项整项不显示', () => {
    const ids = idsOf('blank', cap({ canAddFolder: false, canCommandPalette: false, canRelist: false }));
    expect(ids).not.toContain('add-folder');
    expect(ids).not.toContain('command-palette');
    expect(ids).not.toContain('relist');
    expect(ids).toEqual(['switch-view-kojo', 'switch-view-fs', 'expand-all', 'collapse-all', 'locate']);
  });
});

/* ------------------------------ 禁用必须说话 ------------------------------ */

describe('禁用项 · 灰着不说话 = 违反铁律 4', () => {
  it('文件历史：只有这一行就是活动文件时才可点，否则禁用 + 人话原因', () => {
    const notActive = menuItemsFor('file', FULL, { activeFile: 'C:/koa/other.ERB', path: 'C:/koa/001/a.ERB' });
    const item = notActive.find((i) => i.id === 'history')!;
    expect(item.disabled).toBe(true);
    expect(item.disabledReason).toContain('当前正在编辑的文件');

    const active = menuItemsFor('file', FULL, { activeFile: 'c:/KOA/001/A.erb', path: 'C:/koa/001/a.ERB' });
    expect(active.find((i) => i.id === 'history')!.disabled).toBeFalsy(); // 归一口径：大小写/分隔符不算两份文件
  });

  it('定位当前文件：没有活动文件时禁用 + 原因，而不是灰着不出声', () => {
    const idle = menuItemsFor('blank', FULL, { activeFile: null });
    const item = idle.find((i) => i.id === 'locate')!;
    expect(item.disabled).toBe(true);
    expect(item.disabledReason).toContain('没有打开的文件');

    const busy = menuItemsFor('blank', FULL, { activeFile: 'C:/koa/001/a.ERB' });
    expect(busy.find((i) => i.id === 'locate')!.disabled).toBeFalsy();
  });

  it('每条禁用项都带原因（没有原因的空灰是 bug，不是风格）', () => {
    for (const scope of ['file', 'dir', 'package', 'group', 'blank'] as const) {
      for (const item of menuItemsFor(scope, FULL, { view: 'fs', activeFile: null })) {
        if (item.disabled === true) expect(item.disabledReason, `${scope}/${item.id}`).toBeTruthy();
      }
    }
  });
});

/* ------------------------------ 文案与命令一致 ------------------------------ */

describe('文案 · 全中文 + 命令项不另造第二份', () => {
  it('每个作用域的每一条 label 都含中文', () => {
    for (const scope of ['file', 'dir', 'package', 'group', 'blank'] as const) {
      for (const view of ['kojo', 'fs'] as const) {
        for (const item of menuItemsFor(scope, FULL, { view, activeFile: 'C:/koa/a.ERB', path: 'C:/koa/a.ERB' })) {
          expect(isChineseMenuLabel(item.label), `${scope}/${item.id}`).toBe(true);
        }
      }
    }
  });

  it('禁用原因也是中文（英文原因等于没解释）', () => {
    for (const item of menuItemsFor('blank', FULL, { activeFile: null })) {
      if (item.disabledReason !== undefined) expect(isChineseMenuLabel(item.disabledReason), item.id).toBe(true);
    }
  });

  it('命令面板项的标题与键位取自键位注册表，与命令面板一字不差', () => {
    const spec = menuItemsFor('blank', FULL).find((i) => i.id === 'command-palette')!;
    expect(spec.command).toBe('workbench.commandPalette');
    const registered = keybindingSpecOf(spec.command!);
    expect(registered?.title).toBe('命令面板');
    // 映射后标题以注册表为准（规格里的中文只是兜底）
    const mapped = toContextMenuItem({ ...spec, label: '占位' });
    expect(mapped.label).toBe(registered!.title);
    expect(mapped.shortcut).toBeTruthy(); // 真实键位（Ctrl+Shift+P），不是编的
  });
});

/* ------------------------------ 面路由与分发 ------------------------------ */

describe('面路由 · 行元素 → file-tree，空白区 → file-tree-root', () => {
  const act = vi.fn();
  const runtime = (over: Partial<FileTreeMenuRuntime> = {}): FileTreeMenuRuntime => ({
    view: 'kojo',
    activeFile: null,
    capability: FULL,
    act,
    ...over,
  });

  beforeEach(() => {
    act.mockClear();
    setFileTreeMenuRuntime(null);
    document.body.innerHTML = '';
    // 命令通道（壳层注入的那一根线）：菜单的命令类项在右键那一刻现探，所以这里要真的注册一个
    registerContextMenuCommandRunner({ hasCommand: () => true, runCommand: () => true });
  });

  afterEach(() => {
    registerContextMenuCommandRunner(null);
  });

  const mount = (attrs: Record<string, string>, tag = 'button'): HTMLElement => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.appendChild(el);
    return el;
  };

  it('文件行：命中 file-tree 面，ariaLabel 来自清单，选中走面的分发', () => {
    setFileTreeMenuRuntime(runtime());
    const row = mount({
      'data-context-surface': 'file-tree',
      'data-tree-kind': 'file',
      'data-tree-path': 'C:/koa/001/a.ERB',
    });
    const route = buildContextMenuRoute(row, contextEvent());
    expect(route?.source).toBe('file-tree');
    expect(route?.ariaLabel).toBe('文件树菜单');
    expect(route?.items.map((i) => i.id)).toContain('history');
    route?.onSelect('open');
    expect(act).toHaveBeenCalledWith('open', { kind: 'file', path: 'C:/koa/001/a.ERB' });
  });

  it('角色组标题行：作用域带 label 与 prefix（动作侧据此找回 Group）', () => {
    setFileTreeMenuRuntime(runtime());
    const row = mount({
      'data-context-surface': 'file-tree',
      'data-tree-kind': 'group',
      'data-tree-label': '#1 霊夢',
      'data-tree-path': 'C:/koa/001',
    });
    const route = buildContextMenuRoute(row, contextEvent());
    expect(route?.items.map((i) => i.id)).toContain('expand-all');
    route?.onSelect('collapse-all');
    expect(act).toHaveBeenCalledWith('collapse-all', { kind: 'group', label: '#1 霊夢', prefix: 'C:/koa/001' });
  });

  it('空白区（容器）：命中 file-tree-root 面，带命令面板', () => {
    setFileTreeMenuRuntime(runtime());
    const root = mount({ 'data-context-surface': 'file-tree-root' }, 'div');
    const inner = document.createElement('span');
    root.appendChild(inner);
    const route = buildContextMenuRoute(inner, contextEvent());
    expect(route?.source).toBe('file-tree-root');
    expect(route?.ariaLabel).toBe('文件树根菜单');
    expect(route?.items.map((i) => i.id)).toContain('command-palette');
    route?.onSelect('relist');
    expect(act).toHaveBeenCalledWith('relist', { kind: 'blank' });
  });

  it('嵌套：行的面属性比容器更近 ⇒ 由行接管（不会被空白区菜单盖掉）', () => {
    setFileTreeMenuRuntime(runtime());
    const root = mount({ 'data-context-surface': 'file-tree-root' }, 'div');
    const row = document.createElement('button');
    row.setAttribute('data-context-surface', 'file-tree');
    row.setAttribute('data-tree-kind', 'dir');
    row.setAttribute('data-tree-path', 'C:/koa/001/少女之梦');
    root.appendChild(row);
    expect(buildContextMenuRoute(row, contextEvent())?.source).toBe('file-tree');
    expect(buildContextMenuRoute(root, contextEvent())?.source).toBe('file-tree-root');
  });

  it('拿不到现场（树没挂载 / 已卸载）：这一级不表态，落到兜底菜单', () => {
    const row = mount({
      'data-context-surface': 'file-tree',
      'data-tree-kind': 'file',
      'data-tree-path': 'C:/koa/a.ERB',
    });
    const route = buildContextMenuRoute(row, contextEvent());
    expect(route?.source).toBe('app-fallback');
  });

  it('行上的文本输入（重命名 / 过滤框）交给 input 面，不被树菜单抢走', () => {
    setFileTreeMenuRuntime(runtime());
    const input = mount({ 'data-context-surface': 'file-tree-root' }, 'input');
    expect(buildContextMenuRoute(input, contextEvent())?.source).toBe('input');
  });
});

describe('DOM 读作用域 / 映射', () => {
  const rowOf = (attrs: Record<string, string>): HTMLElement => {
    document.body.innerHTML = '';
    const el = document.createElement('button');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.appendChild(el);
    return el;
  };

  it('缺路径的文件行不表态（宁可回落兜底，也不猜一个空路径的动作）', () => {
    expect(readFileTreeScope(rowOf({ 'data-context-surface': 'file-tree', 'data-tree-kind': 'file' }))).toBeNull();
  });

  it('作者包作用域读出 dir + label', () => {
    expect(
      readFileTreeScope(
        rowOf({
          'data-context-surface': 'file-tree',
          'data-tree-kind': 'package',
          'data-tree-path': 'C:/koa/001/少女之梦',
          'data-tree-label': '少女之梦',
        }),
      ),
    ).toEqual({ kind: 'package', dir: 'C:/koa/001/少女之梦', label: '少女之梦' });
  });

  it('种类与路径的投影：空白区没有路径（不许拿空串去复制/去删）', () => {
    expect(scopeKindOf({ kind: 'blank' })).toBe('blank');
    expect(scopePathOf({ kind: 'blank' })).toBeUndefined();
    expect(scopePathOf(pkgScope())).toBe('C:/koa/001/少女之梦');
    expect(scopePathOf(groupScope())).toBe('C:/koa/001');
  });

  it('面菜单：文件行的条目数与纯函数一致（映射不额外增删）', () => {
    registerContextMenuCommandRunner({ hasCommand: () => true, runCommand: () => true });
    const rt: FileTreeMenuRuntime = { view: 'kojo', activeFile: null, capability: FULL, act: () => {} };
    const items = fileTreeSurfaceMenu(fileScope(), rt);
    expect(items.map((i) => i.id)).toEqual(menuItemsFor('file', FULL, { view: 'kojo', activeFile: null, path: 'C:/koa/001/a.ERB' }).map((i) => i.id));
    expect(fileTreeSurfaceMenu(dirScope(), rt).length).toBeGreaterThan(0);
    expect(fileTreeSurfaceMenu(pkgScope(), rt).length).toBeGreaterThan(0);
    registerContextMenuCommandRunner(null);
  });

  it('危险项映射出 danger（删除靠它上危险色）', () => {
    const rt: FileTreeMenuRuntime = { view: 'kojo', activeFile: null, capability: FULL, act: () => {} };
    expect(fileTreeSurfaceMenu(fileScope(), rt).find((i) => i.id === 'delete')?.danger).toBe(true);
  });
});

/* ------------------------------ 兜底实现（就地渲染） ------------------------------ */

describe('FileTreeContextMenu · 兜底实现（根宿主缺席时自渲染）', () => {
  const render = (scope: MenuScope, props: Partial<FileTreeContextMenuProps> = {}): string =>
    renderToStaticMarkup(
      h(FileTreeContextMenu, {
        x: 40,
        y: 60,
        capability: FULL,
        onDismiss: () => {},
        onAction: () => {},
        scope,
        ...props,
      }),
    );

  const labelsOf = (html: string): string[] =>
    Array.from(html.matchAll(/class="context-menu-label">([^<]+)</g), (m) => m[1] ?? '');

  it('文件作用域：与根宿主同一份文案（中文、删除危险色）', () => {
    const html = render({ kind: 'file', path: 'C:/koa/p.ERB' }, { activeFile: 'C:/koa/p.ERB' });
    expect(html).toContain('aria-label="文件操作"');
    expect(labelsOf(html)).toEqual([
      '打开',
      '复制文件名',
      '复制路径',
      '复制相对路径',
      '在资源管理器中显示',
      '刷新',
      '文件历史',
      '重命名',
      '删除',
    ]);
    expect(html).toContain('context-menu-item danger');
  });

  it('root 作用域 = 空白区那一套（视图两项 + 命令面板）', () => {
    const html = render({ kind: 'root' });
    expect(html).toContain('aria-label="目录操作"');
    expect(labelsOf(html)).toEqual([
      '视图：口上树',
      '视图：文件系统',
      '添加文件夹…',
      '展开全部',
      '折叠全部',
      '定位当前文件',
      '重读（重新扫描）',
      '命令面板',
    ]);
  });
});
