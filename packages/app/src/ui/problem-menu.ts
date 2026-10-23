/**
 * 问题面板的右键菜单数据面（1023 覆盖面批 · WP3.2）。
 *
 * 分层与 `search-menu.ts` 逐条同款：上半是**纯逻辑**（能力 → 菜单项、选中 id → 动作），
 * 下半只做面接线（`problems` 面的 `build`：从被右击的元素读出「是哪一条问题」，
 * 其余交给纯函数）。行身份同样挂在 `data-problem-*` 上——面板会随底部面板切换反复
 * 挂载，面本身只在模块载入时声明一次。
 *
 * ## 没做的项（无既有通道）
 *
 * - 「忽略此问题」：`problem-store` 只有"整份发布诊断"，没有忽略清单/抑制规则这种持久
 *   通道；菜单里摆一个按了不生效的项，比没有更糟（铁律 4）；
 * - 「在侧边打开」类动作：全仓没有"开进新编辑器组"的通道（同 `search-menu` 的说明）。
 *
 * ## 复用既有能力，不另造
 *
 * - 复制文案 = `problem-fix.problemCopyText`（与行内「复制」按钮同一份文案）；
 * - 快速修复 = 面板既有的**唯一解**判据与落地（`rowFixAction` / `applyFix`）；
 * - 按规则过滤 = 把诊断码填进面板既有的过滤框（`filterText`），过滤尺一换，
 *   面板自己会把渲染窗口复位（既有 effect）。
 */
import type { ContextMenuItem } from './context-menu-model';
import { isTextInputTarget } from './context-menu-model';
import {
  declareContextSurface,
  type ContextSurfaceBuildResult,
} from './context-surfaces';
import type { EditorProblem } from './problem-store';

/* ══════════════════════════ ① 能力开关 ══════════════════════════ */

export interface ProblemMenuCapabilities {
  /** 剪贴板可用（缺 = 复制类项整项不显示） */
  readonly canCopy: boolean;
  /**
   * 这一条有没有**唯一解**快速修复（判据在 `problem-fix.collectRowFix`，
   * 与面板行内「修复」按钮同一条底座）。没有 = 整项不显示（不留死按钮）。
   */
  readonly canQuickFix: boolean;
  /** 诊断码（有码才给「按规则过滤」；没码的条目这条规则无从谈起） */
  readonly code: string | null;
}

/* ══════════════════════════ ② 菜单项 id ══════════════════════════ */

export const PROBLEM_MENU_IDS = {
  quickFix: 'problems.quickFix',
  reveal: 'problems.reveal',
  copyMessage: 'problems.copyMessage',
  filterByCode: 'problems.filterByCode',
  copyAll: 'problems.copyAll',
  clearFilter: 'problems.clearFilter',
} as const;

/** 面板级（空白 / 汇总行）两个动作的禁用原因（条件可补齐，所以留着入口） */
export const COPY_ALL_DISABLED_REASON = '当前没有可复制的问题';
export const CLEAR_FILTER_DISABLED_REASON = '当前没有设置过滤条件';

/* ══════════════════════════ ③ 菜单构建（纯函数） ══════════════════════════ */

/**
 * 单条问题的菜单：快速修复（唯一解才有） | 在编辑器中显示 | 复制消息 | 按规则过滤。
 *
 * 顺序理由：可执行的动作在前（修复是最贵的那一步），导航其次，复制与过滤归后半段；
 * 分段用 `dividerBefore`，不给 4 个项各配一个小节头（菜单会碎成一片标题）。
 */
export function buildProblemRowMenu(caps: ProblemMenuCapabilities): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (caps.canQuickFix) {
    items.push({ id: PROBLEM_MENU_IDS.quickFix, label: '快速修复', icon: 'wand' });
  }
  items.push({ id: PROBLEM_MENU_IDS.reveal, label: '在编辑器中显示', icon: 'code' });
  if (caps.canCopy) {
    items.push({ id: PROBLEM_MENU_IDS.copyMessage, label: '复制消息', dividerBefore: true });
  }
  if (caps.code !== null && caps.code !== '') {
    items.push({
      id: PROBLEM_MENU_IDS.filterByCode,
      label: `按规则「${caps.code}」过滤`,
      icon: 'search',
      dividerBefore: true,
    });
  }
  return items;
}

/** 面板级菜单的输入（汇总行 / 空白区的能力读数） */
export interface ProblemsPanelMenuInput {
  readonly canCopy: boolean;
  /** 面板里一共有多少条问题（0 = 「复制全部」禁用并说原因） */
  readonly itemCount: number;
  /** 当前有没有过滤条件（无 = 「清除过滤」禁用并说原因） */
  readonly filtering: boolean;
}

/**
 * 面板级菜单：复制全部问题 | 清除过滤。
 *
 * 两项都是"条件不满足时禁用 + 原因"而不是整项消失——它们的能力（剪贴板、过滤框）就在
 * 面板里，作者补一下条件就能用，藏起来等于说"这里没有这个功能"。
 */
export function buildProblemsPanelMenu(input: ProblemsPanelMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (input.canCopy) {
    items.push(
      input.itemCount > 0
        ? { id: PROBLEM_MENU_IDS.copyAll, label: '复制全部问题' }
        : {
            id: PROBLEM_MENU_IDS.copyAll,
            label: '复制全部问题',
            disabled: true,
            disabledReason: COPY_ALL_DISABLED_REASON,
          },
    );
  }
  items.push(
    input.filtering
      ? { id: PROBLEM_MENU_IDS.clearFilter, label: '清除过滤', dividerBefore: items.length > 0 }
      : {
          id: PROBLEM_MENU_IDS.clearFilter,
          label: '清除过滤',
          dividerBefore: items.length > 0,
          disabled: true,
          disabledReason: CLEAR_FILTER_DISABLED_REASON,
        },
  );
  return items;
}

/* ══════════════════════════ ④ 动作分发 ══════════════════════════ */

/** 菜单动作落点（面板注入） */
export interface ProblemMenuHandlers {
  /** 跳到问题所在位置（面板走既有 `onReveal`） */
  readonly reveal: (problem: EditorProblem) => void;
  /** 走既有行内修复落地（唯一解，一次编辑调用 = 一个撤销步） */
  readonly quickFix: (problem: EditorProblem) => void;
  /** 复制这一条的消息（文案真源在面板侧 `problemCopyText`，菜单不另写一份） */
  readonly copyProblem: (problem: EditorProblem) => void;
  /** 把规则码填进过滤框 */
  readonly filterByCode: (code: string) => void;
  /** 复制全部（文案由面板用 `problemCopyText` 逐条拼） */
  readonly copyAll: () => void;
  /** 清除过滤条件（严重级 + 文本） */
  readonly clearFilter: () => void;
}

/** 单条分发；返回 `false` = 不是本菜单的 id */
export function runProblemRowMenuAction(
  id: string,
  problem: EditorProblem,
  handlers: ProblemMenuHandlers,
): boolean {
  switch (id) {
    case PROBLEM_MENU_IDS.quickFix:
      handlers.quickFix(problem);
      return true;
    case PROBLEM_MENU_IDS.reveal:
      handlers.reveal(problem);
      return true;
    case PROBLEM_MENU_IDS.copyMessage:
      handlers.copyProblem(problem);
      return true;
    case PROBLEM_MENU_IDS.filterByCode:
      if (problem.code === undefined || problem.code === '') return false;
      handlers.filterByCode(problem.code);
      return true;
    default:
      return false;
  }
}

/** 面板级分发；返回 `false` = 不是本菜单的 id */
export function runProblemsPanelMenuAction(id: string, handlers: ProblemMenuHandlers): boolean {
  switch (id) {
    case PROBLEM_MENU_IDS.copyAll:
      handlers.copyAll();
      return true;
    case PROBLEM_MENU_IDS.clearFilter:
      handlers.clearFilter();
      return true;
    default:
      return false;
  }
}

/* ══════════════════════════ ⑤ 面接线 ══════════════════════════ */

export const PROBLEM_ROW_ATTR = 'data-problem-row';
export const PROBLEM_PATH_ATTR = 'data-problem-path';
export const PROBLEM_LINE_ATTR = 'data-problem-line';
export const PROBLEM_CODE_ATTR = 'data-problem-code';

/**
 * 面板此刻的上下文。`problemAt` 按身份回查问题本体：菜单只从 DOM 读「是哪一条」，
 * 问题对象留在现场那份 store 快照里（属性里塞消息文本会在重发布后指向旧诊断）。
 */
export interface ProblemsMenuContext {
  readonly capabilities: Omit<ProblemMenuCapabilities, 'canQuickFix' | 'code'>;
  readonly handlers: ProblemMenuHandlers;
  readonly problemAt: (path: string, line: number, code: string) => EditorProblem | null;
  readonly quickFixAvailable: (problem: EditorProblem) => boolean;
  readonly itemCount: () => number;
  readonly filtering: () => boolean;
}

let current: ProblemsMenuContext | null = null;

/** 面板每次渲染刷新（卸载传 `null`） */
export function setProblemsMenuContext(context: ProblemsMenuContext | null): void {
  current = context;
}

/** `problems` 面的构建（导出给测试直接打） */
export function buildProblemsSurfaceMenu(target: HTMLElement): ContextSurfaceBuildResult {
  const context = current;
  if (context === null) return null;
  // 过滤框 / 严重级勾选框归全局 `input` 面：粘贴与全选在那一面，不该被本面截走
  if (isTextInputTarget(target)) return null;

  const row = target.closest<HTMLElement>(`[${PROBLEM_ROW_ATTR}]`);
  if (row !== null) {
    const path = row.getAttribute(PROBLEM_PATH_ATTR);
    const rawLine = row.getAttribute(PROBLEM_LINE_ATTR);
    const line = rawLine === null ? Number.NaN : Number.parseInt(rawLine, 10);
    if (path === null || !Number.isFinite(line)) return null;
    const code = row.getAttribute(PROBLEM_CODE_ATTR) ?? '';
    const problem = context.problemAt(path, line, code);
    if (problem === null) return null;
    const handlers = context.handlers;
    return {
      items: buildProblemRowMenu({
        canCopy: context.capabilities.canCopy,
        canQuickFix: context.quickFixAvailable(problem),
        code: problem.code ?? null,
      }),
      onSelect: (id) => {
        runProblemRowMenuAction(id, problem, handlers);
      },
    };
  }

  const items = buildProblemsPanelMenu({
    canCopy: context.capabilities.canCopy,
    itemCount: context.itemCount(),
    filtering: context.filtering(),
  });
  // 剪贴板缺席 + 没有过滤条件 ⇒ 一项都没有：不表态，让兜底菜单接管（空壳不如通用菜单）
  if (items.length === 0) return null;
  const handlers = context.handlers;
  return {
    items,
    onSelect: (id) => {
      runProblemsPanelMenuAction(id, handlers);
    },
  };
}

declareContextSurface({
  id: 'problems',
  ariaLabel: '问题面板菜单',
  area: 'panel',
  build: (ctx) => buildProblemsSurfaceMenu(ctx.target),
});
