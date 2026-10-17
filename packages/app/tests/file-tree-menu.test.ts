import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileTreeContextMenu, type FileTreeContextMenuProps } from '../src/ui/file-tree-menu';
import type { MenuCapability } from '../src/ui/file-tree-ops';
import type { MenuScope } from '../src/ui/file-tree-types';

/**
 * 文件树右键菜单 SSR 形状锁（用户反馈 7）：共享 `<ContextMenu>` 的中文文案、
 * 作用域分支与「无能力整项不显示」。行为面（动作分发）由 file-tree-ops 纯函数用例看着。
 */

const FULL: MenuCapability = { hasIo: true, canReveal: true, canImport: true };

const base = {
  x: 40,
  y: 60,
  capability: FULL,
  revealLabel: () => '全部展开',
  onToggleReveal: () => {},
  onRevealScope: () => {},
  onDismiss: () => {},
  onAction: () => {},
};

const render = (scope: MenuScope, props: Partial<FileTreeContextMenuProps> = {}): string =>
  renderToStaticMarkup(h(FileTreeContextMenu, { ...base, scope, ...props }));

const labelsOf = (html: string): string[] =>
  Array.from(html.matchAll(/class="context-menu-label">([^<]+)</g), (m) => m[1] ?? '');

describe('FileTreeContextMenu · 文件作用域', () => {
  it('全能力：六项中文动作齐全，删除标危险色', () => {
    const html = render({ kind: 'file', path: 'C:/koa/p.ERB' });
    expect(html).toContain('context-menu--shared');
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-label="文件操作"');
    expect(labelsOf(html)).toEqual([
      '打开',
      '复制路径',
      '复制相对路径',
      '在资源管理器中显示',
      '重命名',
      '删除',
    ]);
    expect(html).toContain('context-menu-item danger');
  });

  it('无 IO / 无定位通道：重命名、删除、在资源管理器中显示整项不显示（不灰着）', () => {
    const html = render(
      { kind: 'file', path: 'C:/koa/p.ERB' },
      { capability: { hasIo: false, canReveal: false, canImport: false } },
    );
    expect(labelsOf(html)).toEqual(['打开', '复制路径', '复制相对路径']);
    expect(html).not.toContain('context-menu-item danger');
    expect(html.match(/role="menuitem"/g)).toHaveLength(3);
  });
});

describe('FileTreeContextMenu · 目录 / 包作用域', () => {
  it('目录：新建、复制、显示、重命名、删除齐全', () => {
    const html = render({ kind: 'dir', path: 'C:/koa/dir' });
    expect(labelsOf(html)).toEqual([
      '新建文件',
      '新建文件夹',
      '复制路径',
      '在资源管理器中显示',
      '重命名',
      '删除',
    ]);
    expect(html).toContain('aria-label="文件操作"');
  });

  it('包：可导入时「导入为我的口上项目」置顶；不可导入时整项消失', () => {
    const scope: MenuScope = { kind: 'package', dir: 'C:/koa/pkg', label: 'pkg' };
    expect(labelsOf(render(scope))[0]).toBe('导入为我的口上项目');
    const noImport = render(scope, {
      capability: { hasIo: true, canReveal: true, canImport: false },
    });
    expect(noImport).not.toContain('导入为我的口上项目');
    expect(labelsOf(noImport)[0]).toBe('新建文件');
  });
});

describe('FileTreeContextMenu · 根 / 角色组作用域', () => {
  it('根：全展开开关文案来自 revealLabel（惰性求值）', () => {
    const html = render({ kind: 'root' }, { revealLabel: () => '全部收起' });
    expect(html).toContain('aria-label="目录操作"');
    expect(labelsOf(html)).toEqual(['全部收起']);
  });

  it('角色组：显示该作用域内所有文件和文件夹', () => {
    const scope: MenuScope = {
      kind: 'group',
      group: { label: '角色', prefix: 'C:/koa/char', subs: [], total: 0 },
    };
    const html = render(scope);
    expect(html).toContain('aria-label="目录操作"');
    expect(labelsOf(html)).toEqual(['显示所有文件和文件夹']);
  });
});
