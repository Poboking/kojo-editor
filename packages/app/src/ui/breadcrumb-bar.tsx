/**
 * 面包屑栏（D1 宿主自绘；1020 编辑器体感批加 VS Code 式的**父级 / 同级下拉**）。
 *
 * 为什么单独成模块：`EditorPane.tsx` 已经装着全部编辑器生命周期，面包屑只是一条只读呈现栏；
 * 拆出来才能用 node SSR 单测钉死「同级列表 = 同层符号、点开跳哪一行」这类判据。
 * 数据全由宿主算好交进来（`breadcrumb-path.ts` 的 `crumbLevelsAt`），本组件零判据、零 IO。
 *
 * 下拉复用全站共享 `<ContextMenu>`（用户反馈 7 那套玻璃观感 + WAI-ARIA 键盘：↑↓ / Home / End /
 * Esc 关并把焦点还给打开前那枚按钮）——不再自己造第二份菜单。
 */
import { memo, useCallback, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import type { CrumbLevel } from './breadcrumb-path';
import { ContextMenu, type ContextMenuItem } from './context-menu';
import { Icon } from './icons';

export interface CrumbBarProps {
  /** 外→内逐级数据（空数组 = 整条栏不渲染） */
  readonly levels: readonly CrumbLevel[];
  /** 跳某一行的落点（宿主走既有 `editor.revealLocation`，本组件不知道文件与总线） */
  onRevealLine(line: number): void;
}

/** 同级列表的菜单项（纯映射；`hidden` 折成一条 disabled 尾行，截断要说出来） */
export function crumbMenuItems(level: CrumbLevel): ContextMenuItem[] {
  const items: ContextMenuItem[] = level.siblings.map((s, i) => ({
    id: `${i}`,
    label: s.name,
    shortcut: `第 ${s.startLine} 行`,
    checked: s.name === level.current.name && s.startLine === level.current.startLine,
  }));
  if (level.hidden > 0) {
    items.push({ id: 'hidden', label: `另有 ${level.hidden} 项未列出`, disabled: true, dividerBefore: true });
  }
  return items;
}

interface MenuState {
  readonly at: number;
  readonly x: number;
  readonly y: number;
}

export const CrumbBar = memo(function CrumbBar({ levels, onRevealLine }: CrumbBarProps): ReactElement | null {
  const [menu, setMenu] = useState<MenuState | null>(null);

  // Esc / 点击外部的关闭与焦点归还都由 <ContextMenu> 自己做，这里只记打开位置
  const openMenu = useCallback((e: ReactMouseEvent<HTMLButtonElement>, at: number): void => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ at, x: r.left, y: r.bottom + 2 });
  }, []);

  if (levels.length === 0) return null;
  const level = menu !== null ? levels[menu.at] : undefined;

  return (
    <div className="editor-crumb" aria-label="位置面包屑">
      {levels.map((lv, i) => {
        const c = lv.current;
        return (
          <span key={`${i}-${c.startLine}-${c.name}`} className="editor-crumb-seg">
            {i > 0 ? (
              <span className="editor-crumb-sep" aria-hidden="true">
                ›
              </span>
            ) : null}
            <button
              type="button"
              className="editor-crumb-item"
              title={`跳回「${c.name}」块头（第 ${c.startLine} 行）`}
              onClick={() => onRevealLine(c.startLine)}
            >
              {c.name}
            </button>
            <button
              type="button"
              className="editor-crumb-caret"
              aria-haspopup="menu"
              aria-expanded={menu !== null && menu.at === i}
              aria-label={`同级项（${c.name}）`}
              title="看同级的其它块"
              onClick={(e) => openMenu(e, i)}
            >
              <Icon name="chevron-down" size={11} />
            </button>
          </span>
        );
      })}
      {menu !== null && level !== undefined ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={crumbMenuItems(level)}
          ariaLabel="同级块"
          onSelect={(id) => {
            const picked = level.siblings[Number(id)];
            setMenu(null);
            if (picked) onRevealLine(picked.startLine);
          }}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
});
