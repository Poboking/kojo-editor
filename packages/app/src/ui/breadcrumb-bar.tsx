/**
 * 面包屑栏（D1 宿主自绘；1020 编辑器体感批加 VS Code 式的**父级 / 同级下拉**；
 * 1023 覆盖面批加**右键菜单**）。
 *
 * 为什么单独成模块：`EditorPane.tsx` 已经装着全部编辑器生命周期，面包屑只是一条只读呈现栏；
 * 拆出来才能用 node SSR 单测钉死「同级列表 = 同层符号、点开跳哪一行」这类判据。
 * 数据全由宿主算好交进来（`breadcrumb-path.ts` 的 `crumbLevelsAt`），本组件零判据、零 IO。
 *
 * 两条菜单各管一件事（1023）：
 * - **左键那枚把手**仍就地弹同级列表（点一下就跳同级块，原来是这么用的，不改）；
 * - **右键任意一段**走根宿主（固定层，不会被编辑器工具栏裁掉）：复制层级名 / 复制路径 /
 *   复制相对路径 / 在资源管理器中显示 / 选择上级 / 选择同级。
 *
 * 右键菜单需要"当前文件路径"与"项目根"两样东西，而本组件的 props 里没有（宿主只传了
 * `levels` + `onRevealLine`）。取法沿用既有真源，不新造状态：
 * - 路径来自 `editor-pane-registry.focusedCtx()`（全仓唯一的"焦点实例"来源，provider 侧
 *   也读它）；
 * - 项目根来自 `kernel.project.current()`（内核项目服务的既有读数）。
 * 任一取不到就把对应项**整项不显示**（铁律 4：没有落点就不摆一个按不动的入口）。
 */
import { memo, useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import { crumbContextMenuItems, crumbSiblingIndex, type CrumbMenuItemSpec, type CrumbLevel } from './breadcrumb-path';
import { ContextMenu, type ContextMenuItem } from './context-menu';
import { isTextInputTarget } from './context-menu-model';
import { declareContextSurface, type ContextSurfaceBuildResult } from './context-surfaces';
import { focusedCtx, requireKernel } from './editor-pane-registry';
import { relativeToRoot } from './file-tree-ops';
import { useNotify } from './NotificationCenter';
import { revealFailureText, revealInExplorer } from './reveal-explorer';
import { isTauri } from '../bridge/invoke';
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

/* ---------------------------- 右键面的运行时桥 ---------------------------- */

/** 一次右键需要的现场（组件每次渲染整体替换；卸载清空） */
export interface CrumbMenuRuntime {
  readonly levels: readonly CrumbLevel[];
  readonly canClipboard: boolean;
  readonly hasFilePath: boolean;
  readonly hasProjectRoot: boolean;
  readonly canReveal: boolean;
  readonly act: (id: string, index: number) => void;
}

let runtime: CrumbMenuRuntime | null = null;

/** 登记当前面包屑的现场（组件每次渲染调用；`null` = 卸载） */
export function setCrumbMenuRuntime(next: CrumbMenuRuntime | null): void {
  runtime = next;
}

/** 一段面包屑的右键菜单（纯函数壳：给定现场与下标，返回渲染用条目） */
export function crumbSurfaceItems(level: CrumbLevel, index: number, rt: CrumbMenuRuntime): ContextMenuItem[] {
  const specs = crumbContextMenuItems({
    level,
    index,
    levelCount: rt.levels.length,
    cap: {
      canClipboard: rt.canClipboard,
      hasFilePath: rt.hasFilePath,
      hasProjectRoot: rt.hasProjectRoot,
      canReveal: rt.canReveal,
    },
  });
  return specs.map(toCrumbContextItem);
}

/** 规格 → 菜单项（子菜单递归：同级那一项自带一层） */
function toCrumbContextItem(spec: CrumbMenuItemSpec): ContextMenuItem {
  const children = spec.children?.map(toCrumbContextItem);
  return {
    id: spec.id,
    label: spec.label,
    ...(spec.icon === undefined ? {} : { icon: spec.icon }),
    ...(spec.shortcut === undefined ? {} : { shortcut: spec.shortcut }),
    ...(spec.dividerBefore === true ? { dividerBefore: true } : {}),
    ...(spec.disabled === true ? { disabled: true } : {}),
    ...(spec.disabledReason === undefined ? {} : { disabledReason: spec.disabledReason }),
    ...(spec.checked === true ? { checked: true } : {}),
    ...(children === undefined ? {} : { children }),
  };
}

/** 当前文件的绝对路径（焦点实例的既有读数；拿不到 ⇒ null，对应菜单项不显示） */
export function currentFilePath(): string | null {
  try {
    const path = focusedCtx()?.filePathRef.current ?? '';
    return path === '' ? null : path;
  } catch {
    return null;
  }
}

/** 当前项目根（内核项目服务的既有读数；拿不到 ⇒ null） */
export function currentProjectRoot(): string | null {
  try {
    const root = requireKernel().project.current()?.rootDir ?? '';
    return root === '' ? null : root;
  } catch {
    return null;
  }
}

/**
 * 面声明（模块顶层一次）：命中 `data-crumb-index` 那一段就算接管，否则返回 `null`
 * （点在两段之间的缝隙上 ⇒ 这一级不表态，根路由继续往兜底走）。
 */
function buildCrumbMenu(target: HTMLElement): ContextSurfaceBuildResult {
  if (isTextInputTarget(target)) return null;
  const rt = runtime;
  if (rt === null || rt.levels.length === 0) return null;
  const seg = target.closest<HTMLElement>('[data-crumb-index]');
  if (seg === null) return null;
  const raw = seg.getAttribute('data-crumb-index') ?? '';
  const index = /^\d+$/.test(raw) ? Number(raw) : -1;
  const level = rt.levels[index];
  if (level === undefined) return null;
  const items = crumbSurfaceItems(level, index, rt);
  if (items.length === 0) return null;
  return { items, onSelect: (id) => rt.act(id, index) };
}

declareContextSurface({
  id: 'breadcrumb',
  ariaLabel: '面包屑菜单',
  area: 'explorer',
  build: (ctx) => buildCrumbMenu(ctx.target),
});

/* ---------------------------- 组件 ---------------------------- */

interface MenuState {
  readonly at: number;
  readonly x: number;
  readonly y: number;
}

export const CrumbBar = memo(function CrumbBar({ levels, onRevealLine }: CrumbBarProps): ReactElement | null {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const notify = useNotify();

  // Esc / 点击外部的关闭与焦点归还都由 <ContextMenu> 自己做，这里只记打开位置
  const openMenu = useCallback((e: ReactMouseEvent<HTMLButtonElement>, at: number): void => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ at, x: r.left, y: r.bottom + 2 });
  }, []);

  /**
   * 右键动作（根宿主分发回来的那条）。复制一律走剪贴板并对结果出声——
   * 剪贴板在桌面壳里可能被拒（权限/焦点），静默失败等于"点了没反应"。
   */
  const copyText = useCallback(
    (text: string, done: string): void => {
      const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (clip === undefined) {
        notify({ kind: 'error', message: '复制失败：当前环境没有可用的剪贴板' });
        return;
      }
      void clip.writeText(text).then(
        () => notify({ kind: 'info', message: done }),
        () => notify({ kind: 'error', message: '复制失败：剪贴板不可用' }),
      );
    },
    [notify],
  );

  const act = useCallback(
    (id: string, index: number): void => {
      const level = levels[index];
      if (level === undefined) return;
      const filePath = currentFilePath();
      const sibling = crumbSiblingIndex(id);
      if (sibling !== null) {
        const picked = level.siblings[sibling];
        if (picked) onRevealLine(picked.startLine);
        return;
      }
      switch (id) {
        case 'copy-name':
          copyText(level.current.name, `已复制层级名「${level.current.name}」`);
          return;
        case 'copy-path':
          if (filePath !== null) copyText(filePath, '已复制文件路径');
          return;
        case 'copy-rel-path': {
          const root = currentProjectRoot();
          if (filePath !== null && root !== null) {
            copyText(relativeToRoot(filePath, root), '已复制相对路径');
          }
          return;
        }
        case 'reveal':
          if (filePath === null) return;
          void revealInExplorer(filePath).catch((err: unknown) => {
            notify({ kind: 'error', message: revealFailureText(err) });
          });
          return;
        case 'select-parent': {
          const parent = levels[index - 1];
          if (parent !== undefined) onRevealLine(parent.current.startLine);
          return;
        }
        default:
          return;
      }
    },
    [levels, onRevealLine, copyText, notify],
  );

  /**
   * 现场登记（每次渲染整体替换）。能力位每帧现探：剪贴板 / 桌面壳通道 / 文件路径 / 项目根
   * 都可能随环境变化，探一次的成本是几次属性读，换的是"菜单不会摆出一条按不动的命令"。
   */
  useEffect(() => {
    setCrumbMenuRuntime({
      levels,
      canClipboard: typeof navigator !== 'undefined' && navigator.clipboard !== undefined,
      hasFilePath: currentFilePath() !== null,
      hasProjectRoot: currentProjectRoot() !== null,
      canReveal: isTauri(),
      act,
    });
  });
  useEffect(() => () => setCrumbMenuRuntime(null), []);

  if (levels.length === 0) return null;
  const level = menu !== null ? levels[menu.at] : undefined;

  return (
    <div className="editor-crumb" aria-label="位置面包屑" data-context-surface="breadcrumb">
      {levels.map((lv, i) => {
        const c = lv.current;
        return (
          <span key={`${i}-${c.startLine}-${c.name}`} className="editor-crumb-seg" data-crumb-index={i}>
            {i > 0 ? (
              <span className="editor-crumb-sep" aria-hidden="true">
                ›
              </span>
            ) : null}
            <button
              type="button"
              className="editor-crumb-item"
              title={`跳回「${c.name}」块头（第 ${c.startLine} 行）；右键查看更多`}
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
