/**
 * 搜索结果面板的右键菜单数据面（1023 覆盖面批 · WP3.1）。
 *
 * ## 分层
 *
 * - **纯逻辑**（本文件上半）：能力开关 → 菜单项清单、选中 id → 动作分发。输入是
 *   「这条命中/这个文件 + 面板此刻有哪些通道」，输出是 `ContextMenuItem[]`——没有 React、
 *   没有 DOM、没有剪贴板，测试直接打这两个函数就能钉死「有哪些项 / 哪项为什么按不了」。
 * - **面接线**（本文件下半）：`search-results` 面的 `build`，只做一件事——从被右击的
 *   元素上读出「这是文件头还是命中行、是哪一条」，然后交给上面的纯函数。
 *
 * ## 为什么行的身份挂在 DOM 属性上，而不是组件闭包
 *
 * 面板会因侧栏切换反复挂载/卸载，菜单又是**模块级注册**的（`declareContextSurface` 幂等
 * 覆盖会告警）——所以面只声明一次，行的身份走 `data-search-*`（与文件树面同一条口径）。
 * 面板只把「此刻的通道与回调」放进模块级上下文（`setSearchMenuContext`），
 * 每次渲染刷新；菜单构建时现取，不持有过期的 props 闭包。
 *
 * ## 没做的项（无既有通道，宁可不显示也不造业务逻辑）
 *
 * - 「在侧边打开」：全仓没有"把某个文件开进新编辑器组"的既有命令/回调
 *   （`editor-groups` 只有整组拆分 `workbench.splitEditor`，不是"打开这个文件"）；
 * - 「在此文件中替换」：`search-store.runReplace` 的模式只有 `all` / `one`，
 *   没有"只替换这个文件"的通道；
 * - 「排除此文件 / 排除此目录」：glob 过滤框只支持正向模式（`parseFileFilter` 与 Rust
 *   `glob_to_regex` 都无反选语义），把 `!path` 塞进去只会一条都搜不到。
 */
import type { SearchMatch } from '../bridge/search';
import { isTextInputTarget, type ContextMenuItem } from './context-menu-model';
import {
  declareContextSurface,
  type ContextSurfaceBuildResult,
} from './context-surfaces';

/* ══════════════════════════ ① 能力开关 ══════════════════════════ */

/**
 * 搜索面板这一层的通道开关。缺哪条通道，依赖它的菜单项**整项不显示**
 * （铁律 4：能力不存在就别摆一个按不动的入口）。
 */
export interface SearchMenuCapabilities {
  /**
   * 替换管线是否就绪：结果已是完成态（`phase === 'done'`）且没有别的替换在写盘。
   * 不满足时「替换此匹配」**保留但禁用**并说原因——这一步之后就能用，入口值得留着。
   */
  readonly canReplace: boolean;
  /** 桌面壳通道（`show_in_folder`）：浏览器开发壳没有，整项不显示 */
  readonly canReveal: boolean;
  /** 剪贴板可用（`navigator.clipboard.writeText`） */
  readonly canCopy: boolean;
}

/* ══════════════════════════ ② 菜单项 id ══════════════════════════ */

/** 文件组（文件头）菜单的 id（选中后由 `runSearchFileMenuAction` 分发） */
export const SEARCH_FILE_MENU_IDS = {
  open: 'search.file.open',
  copyPath: 'search.file.copyPath',
  reveal: 'search.file.reveal',
} as const;

/** 命中行菜单的 id */
export const SEARCH_MATCH_MENU_IDS = {
  open: 'search.match.open',
  copyLine: 'search.match.copyLine',
  copyPath: 'search.match.copyPath',
  reveal: 'search.match.reveal',
  replace: 'search.match.replace',
} as const;

/**
 * 「替换此匹配」被禁用的原因。
 *
 * 必须说**真实的那一条**：`canReplace` 由三件事合判（有结果 / 检索已到完成态 /
 * 没有替换正在写盘，见 `SearchPanel` 的注入处）。旧文案只写了"替换条件未填写"——
 * 作者明明填好了条件，只是上一次替换还在落盘，却被告知"条件没填"，于是回头去改输入框
 * （铁律 4：原因说错等于没原因）。这里如实列出两种可预判的等待态，不猜是哪一种
 * ——菜单拿到的只是一个布尔值，说多了就成了编。
 */
export const REPLACE_DISABLED_REASON = '检索还没结束或有替换正在写入——这一刻不能替换';

/* ══════════════════════════ ③ 菜单构建（纯函数） ══════════════════════════ */

/**
 * 文件组菜单：打开 | 复制路径 | 在资源管理器中显示。
 *
 * 「打开」= 打开该文件并落到它第一条命中（`onReveal` 既有通道），不是"打开空白文件"——
 * 作者从检索结果里点一个文件，想看的就是它为什么命中。
 */
export function buildSearchFileMenu(caps: SearchMenuCapabilities): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { id: SEARCH_FILE_MENU_IDS.open, label: '打开', icon: 'code' },
  ];
  if (caps.canCopy) {
    items.push({ id: SEARCH_FILE_MENU_IDS.copyPath, label: '复制路径', dividerBefore: true });
  }
  if (caps.canReveal) {
    items.push({
      id: SEARCH_FILE_MENU_IDS.reveal,
      label: '在资源管理器中显示',
      icon: 'popout',
      dividerBefore: true,
    });
  }
  return items;
}

/**
 * 命中行菜单：打开 | 复制命中行 / 复制路径 | 在资源管理器中显示 | 替换此匹配。
 *
 * 「复制命中行」复制的是后端给的 `preview`（命中所在整行；超长行由后端以命中为中心开窗，
 * 省略号已含在串里）——面板拿不到比它更完整的行文本，不自己回读文件。
 */
export function buildSearchMatchMenu(caps: SearchMenuCapabilities): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { id: SEARCH_MATCH_MENU_IDS.open, label: '打开', icon: 'code' },
  ];
  if (caps.canCopy) {
    items.push(
      { id: SEARCH_MATCH_MENU_IDS.copyLine, label: '复制命中行', dividerBefore: true },
      { id: SEARCH_MATCH_MENU_IDS.copyPath, label: '复制路径' },
    );
  }
  if (caps.canReveal) {
    items.push({
      id: SEARCH_MATCH_MENU_IDS.reveal,
      label: '在资源管理器中显示',
      icon: 'popout',
      dividerBefore: true,
    });
  }
  items.push(
    caps.canReplace
      ? { id: SEARCH_MATCH_MENU_IDS.replace, label: '替换此匹配', icon: 'wand', dividerBefore: true }
      : {
          id: SEARCH_MATCH_MENU_IDS.replace,
          label: '替换此匹配',
          icon: 'wand',
          dividerBefore: true,
          disabled: true,
          disabledReason: REPLACE_DISABLED_REASON,
        },
  );
  return items;
}

/* ══════════════════════════ ④ 动作分发 ══════════════════════════ */

/** 菜单动作落点（面板注入；纯函数只负责"该叫哪一个"，不碰剪贴板与 IPC） */
export interface SearchMenuHandlers {
  /** 打开命中并定位（面板走既有 `onReveal`） */
  readonly openMatch: (path: string, match: SearchMatch) => void;
  /** 写剪贴板（失败说明由面板自己上屏） */
  readonly copyText: (text: string) => void;
  /** 在系统资源管理器中显示 */
  readonly revealPath: (path: string) => void;
  /** 替换一处（面板走既有 `runReplace({ kind: 'one' })` 并重跑检索） */
  readonly replaceMatch: (path: string, match: SearchMatch) => void;
}

/** 文件组菜单分发；返回 `false` = 不是本菜单的 id（调用方无事可做） */
export function runSearchFileMenuAction(
  id: string,
  path: string,
  firstMatch: SearchMatch | null,
  handlers: SearchMenuHandlers,
): boolean {
  switch (id) {
    case SEARCH_FILE_MENU_IDS.open:
      // 组里一条命中都没有 = 不知道该落到哪一行：不猜，交回 false（面板不给这种组画文件头）
      if (firstMatch === null) return false;
      handlers.openMatch(path, firstMatch);
      return true;
    case SEARCH_FILE_MENU_IDS.copyPath:
      handlers.copyText(path);
      return true;
    case SEARCH_FILE_MENU_IDS.reveal:
      handlers.revealPath(path);
      return true;
    default:
      return false;
  }
}

/** 命中行菜单分发；返回 `false` = 不是本菜单的 id */
export function runSearchMatchMenuAction(
  id: string,
  path: string,
  match: SearchMatch,
  handlers: SearchMenuHandlers,
): boolean {
  switch (id) {
    case SEARCH_MATCH_MENU_IDS.open:
      handlers.openMatch(path, match);
      return true;
    case SEARCH_MATCH_MENU_IDS.copyLine:
      handlers.copyText(match.preview);
      return true;
    case SEARCH_MATCH_MENU_IDS.copyPath:
      handlers.copyText(path);
      return true;
    case SEARCH_MATCH_MENU_IDS.reveal:
      handlers.revealPath(path);
      return true;
    case SEARCH_MATCH_MENU_IDS.replace:
      handlers.replaceMatch(path, match);
      return true;
    default:
      return false;
  }
}

/* ══════════════════════════ ⑤ 面接线 ══════════════════════════ */

/** 行身份属性（组件写、`build` 读；与文件树 `data-tree-path` 同一条口径） */
export const SEARCH_MATCH_ATTR = 'data-search-match';
export const SEARCH_FILE_ATTR = 'data-search-file';
export const SEARCH_PATH_ATTR = 'data-search-path';
export const SEARCH_LINE_ATTR = 'data-search-line';
export const SEARCH_COLUMN_ATTR = 'data-search-column';

/**
 * 面板此刻的上下文：能力 + 动作落点 + 两条按身份回查命中的通道。
 *
 * 按身份回查（而不是把 `SearchMatch` 塞进 DOM 属性）：菜单只从 DOM 读「是哪一条」，
 * 命中本体留在现场那份投影里——属性里塞 JSON 会在结果刷新后指向一条已经不存在的命中。
 */
export interface SearchMenuContext {
  readonly capabilities: SearchMenuCapabilities;
  readonly handlers: SearchMenuHandlers;
  /** 按 路径 + 行 + 列 找回那条命中（找不到 = `null`，菜单整级不表态） */
  readonly findMatch: (path: string, line: number, column: number) => SearchMatch | null;
  /** 该文件组的第一条命中（文件头「打开」的落点） */
  readonly firstMatchOf: (path: string) => SearchMatch | null;
}

let current: SearchMenuContext | null = null;

/** 面板每次渲染刷新（卸载传 `null`：能力撤回，面随即不表态，走兜底菜单） */
export function setSearchMenuContext(context: SearchMenuContext | null): void {
  current = context;
}

/** 整数属性解析（缺属性 / 坏值 → `null`，不拿 NaN 去查命中） */
function attributeInt(el: HTMLElement, name: string): number | null {
  const raw = el.getAttribute(name);
  if (raw === null) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * `search-results` 面的构建（导出给测试直接打，不必经过整棵路由）。
 *
 * 三级命中：命中行 → 文件组 → 不表态（`null`，根路由继续往输入框面 / 兜底走）。
 */
export function buildSearchSurfaceMenu(target: HTMLElement): ContextSurfaceBuildResult {
  const context = current;
  if (context === null) return null;
  // 输入框归全局 `input` 面（检索框、替换框虽在面板里，剪切/复制/粘贴不该被本面接管）
  if (isTextInputTarget(target)) return null;

  const matchRow = target.closest<HTMLElement>(`[${SEARCH_MATCH_ATTR}]`);
  if (matchRow !== null) {
    const path = matchRow.getAttribute(SEARCH_PATH_ATTR);
    const line = attributeInt(matchRow, SEARCH_LINE_ATTR);
    const column = attributeInt(matchRow, SEARCH_COLUMN_ATTR);
    if (path === null || line === null || column === null) return null;
    const match = context.findMatch(path, line, column);
    if (match === null) return null;
    const handlers = context.handlers;
    return {
      items: buildSearchMatchMenu(context.capabilities),
      onSelect: (id) => {
        runSearchMatchMenuAction(id, path, match, handlers);
      },
    };
  }

  const fileRow = target.closest<HTMLElement>(`[${SEARCH_FILE_ATTR}]`);
  if (fileRow !== null) {
    const path = fileRow.getAttribute(SEARCH_PATH_ATTR);
    if (path === null) return null;
    const firstMatch = context.firstMatchOf(path);
    const handlers = context.handlers;
    return {
      items: buildSearchFileMenu(context.capabilities),
      onSelect: (id) => {
        runSearchFileMenuAction(id, path, firstMatch, handlers);
      },
    };
  }

  // 结果区的空白 / 状态区：本面没有专属动作，交给兜底（空壳菜单不如通用菜单）
  return null;
}

declareContextSurface({
  id: 'search-results',
  ariaLabel: '搜索结果菜单',
  area: 'panel',
  build: (ctx) => buildSearchSurfaceMenu(ctx.target),
});
