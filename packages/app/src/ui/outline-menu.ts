import type { ContextMenuItem } from './context-menu-model';
import { isTextInputTarget } from './context-menu-model';
import { declareContextSurface, type ContextSurfaceBuildResult } from './context-surfaces';

/**
 * 侧栏「大纲」面板的右键菜单（1023 覆盖面批 · WP3.3）。
 *
 * 形态照 `problem-menu.ts` 同款：**纯函数造项** + **模块级上下文** + **面声明**。
 * 面板本体（`OutlinePanel.tsx`，批次十 S9）不认得菜单：它只把"此刻有哪些行、
 * 跳到哪一行"这份现场报进来，菜单从 DOM 的 `data-outline-row` 读出"点的是哪一行"，
 * 再按 id 回查——不在属性里塞名字（重发布后属性会指向旧树）。
 *
 * 取舍（铁律 3「不新造业务逻辑」）：本面**只做入口与搬运**——
 * - 「转到符号」= 行点击那一个动作（`reveal`，宿主既有 `editor.revealLocation` 通道）；
 * - 三个复制项 = 把已经在屏上的文字拼成一段（不重新解析、不二次查询符号树）；
 * - 不做「折叠 / 展开全部」：面板当前没有折叠状态，加一个就是新造一份视图语义。
 */

/** 菜单项 id（面自己分发；不是命令 id，不冒充命令） */
export const OUTLINE_MENU_IDS = {
  goto: 'outline.goto',
  copyName: 'outline.copyName',
  copyLocation: 'outline.copyLocation',
  copySubtree: 'outline.copySubtree',
  copyAll: 'outline.copyAll',
} as const;

/** 没有符号时的禁用原因（"这里没有这个功能"与"现在没有东西可复制"是两句话） */
export const COPY_ALL_EMPTY_REASON = '这份文件里还没有可列出的符号';

/** 一行大纲在菜单侧的投影（DOM 只给身份，名字 / 行号从现场表里回查） */
export interface OutlineMenuRow {
  readonly id: string;
  readonly name: string;
  readonly detail: string | null;
  readonly depth: number;
  readonly startLine: number;
}

export interface OutlineMenuCapabilities {
  /** 剪贴板可写（不可写 ⇒ 三个复制项整项不显示：能力不存在就不摆入口） */
  readonly canCopy: boolean;
  /** 这一行有没有子符号（没有就不给「复制这一支」） */
  readonly hasChildren: boolean;
}

/**
 * 单行菜单：转到符号 | 复制符号名 · 复制位置 · 复制这一支。
 *
 * 顺序理由：导航在前（右键一行最想干的事），三段复制归后半段；复制组用
 * `dividerBefore` 断一次行，不给三项各配小节头。
 */
export function buildOutlineRowMenu(caps: OutlineMenuCapabilities): ContextMenuItem[] {
  const items: ContextMenuItem[] = [{ id: OUTLINE_MENU_IDS.goto, label: '转到符号', icon: 'code' }];
  if (caps.canCopy) {
    items.push({ id: OUTLINE_MENU_IDS.copyName, label: '复制符号名', dividerBefore: true });
    items.push({ id: OUTLINE_MENU_IDS.copyLocation, label: '复制位置（文件与行号）' });
    if (caps.hasChildren) {
      items.push({ id: OUTLINE_MENU_IDS.copySubtree, label: '复制这一支（含子符号）' });
    }
  }
  return items;
}

/** 面板级菜单：复制整份大纲（空树 ⇒ 禁用并说原因，不藏项） */
export function buildOutlinePanelMenu(input: { readonly canCopy: boolean; readonly rowCount: number }): ContextMenuItem[] {
  if (!input.canCopy) return [];
  return [
    input.rowCount > 0
      ? { id: OUTLINE_MENU_IDS.copyAll, label: '复制整份大纲' }
      : {
          id: OUTLINE_MENU_IDS.copyAll,
          label: '复制整份大纲',
          disabled: true,
          disabledReason: COPY_ALL_EMPTY_REASON,
        },
  ];
}

/**
 * 一份大纲的纯文本（缩进按层级两格）。
 *
 * `from` / `to` 给「复制这一支」用：起点那行连同其下 `depth` 更深的连续行。
 * 文案真源只有这一处——「复制整份」与「复制这一支」不各写一份排版。
 */
export function outlineText(rows: readonly OutlineMenuRow[], from = 0, to = rows.length - 1): string {
  return rows
    .slice(from, to + 1)
    .map((row) => `${'  '.repeat(Math.max(0, row.depth))}${row.name.length > 0 ? row.name : '（未命名）'}`)
    .join('\n');
}

/** 一份子树的范围：从 `from` 起，连续的 `depth > 起点 depth` 的那些行 */
export function outlineSubtreeEnd(rows: readonly OutlineMenuRow[], from: number): number {
  const base = rows[from]?.depth ?? 0;
  let end = from;
  for (let i = from + 1; i < rows.length; i += 1) {
    if ((rows[i]?.depth ?? 0) <= base) break;
    end = i;
  }
  return end;
}

/* ══════════════════════════ ② 动作分发 ══════════════════════════ */

export interface OutlineMenuHandlers {
  /** 跳源：文件 + 行（宿主既有通道；与行点击同一个入口） */
  readonly reveal: (row: OutlineMenuRow) => void;
  /** 写剪贴板：失败也要有可见回执（面板自己在 `flash` 那条链上画） */
  readonly copy: (text: string, okText: string) => void;
}

/** 单行菜单的动作分发（返回是否认得这个 id） */
export function runOutlineRowMenuAction(
  id: string,
  row: OutlineMenuRow,
  rows: readonly OutlineMenuRow[],
  index: number,
  handlers: OutlineMenuHandlers,
): boolean {
  switch (id) {
    case OUTLINE_MENU_IDS.goto:
      handlers.reveal(row);
      return true;
    case OUTLINE_MENU_IDS.copyName:
      handlers.copy(row.name, '已复制符号名');
      return true;
    case OUTLINE_MENU_IDS.copyLocation:
      handlers.copy(`${row.name}:${row.startLine}`, '已复制位置');
      return true;
    case OUTLINE_MENU_IDS.copySubtree:
      handlers.copy(outlineText(rows, index, outlineSubtreeEnd(rows, index)), '已复制这一支');
      return true;
    default:
      return false;
  }
}

/** 面板级动作分发 */
export function runOutlinePanelMenuAction(
  id: string,
  rows: readonly OutlineMenuRow[],
  handlers: OutlineMenuHandlers,
): boolean {
  if (id !== OUTLINE_MENU_IDS.copyAll) return false;
  handlers.copy(outlineText(rows), `已复制 ${rows.length} 个符号`);
  return true;
}

/* ══════════════════════════ ③ 面接线 ══════════════════════════ */

export const OUTLINE_ROW_ATTR = 'data-outline-row';
export const OUTLINE_ROW_ID_ATTR = 'data-outline-id';

/**
 * 面板此刻的现场（每次渲染刷新；卸载传 `null`）。
 *
 * `rows` 是面板刚画出来的那一份（与 DOM 同一序），菜单只按 index 取——
 * 两份序一旦分叉，复制出来的东西就会错位，所以这里**不设第二份来源**。
 */
export interface OutlineMenuContext {
  readonly canCopy: boolean;
  readonly rows: readonly OutlineMenuRow[];
  readonly handlers: OutlineMenuHandlers;
}

let current: OutlineMenuContext | null = null;

/** 面板每次提交后刷新；卸载不清空也行（面只认 DOM 上的 `data-context-surface`） */
export function setOutlineMenuContext(context: OutlineMenuContext | null): void {
  current = context;
}

/** `outline` 面的构建（导出给测试直接打） */
export function buildOutlineSurfaceMenu(target: HTMLElement): ContextSurfaceBuildResult {
  const context = current;
  if (context === null) return null;
  // 过滤 / 搜索一类的输入框若将来长在这里，归全局 `input` 面：粘贴与全选在那一面
  if (isTextInputTarget(target)) return null;

  const row = target.closest<HTMLElement>(`[${OUTLINE_ROW_ATTR}]`);
  const rowId = row?.getAttribute(OUTLINE_ROW_ID_ATTR) ?? null;
  const index = rowId === null ? -1 : context.rows.findIndex((r) => r.id === rowId);
  const hit = index < 0 ? undefined : context.rows[index];
  if (hit !== undefined) {
    const rows = context.rows;
    const hasChildren = outlineSubtreeEnd(rows, index) > index;
    const items = buildOutlineRowMenu({ canCopy: context.canCopy, hasChildren });
    return {
      items,
      onSelect: (id) => {
        runOutlineRowMenuAction(id, hit, rows, index, context.handlers);
      },
    };
  }

  const items = buildOutlinePanelMenu({ canCopy: context.canCopy, rowCount: context.rows.length });
  if (items.length === 0) return null;
  return {
    items,
    onSelect: (id) => {
      runOutlinePanelMenuAction(id, context.rows, context.handlers);
    },
  };
}

declareContextSurface({
  id: 'outline',
  ariaLabel: '大纲菜单',
  area: 'panel',
  build: (ctx) => buildOutlineSurfaceMenu(ctx.target),
});
