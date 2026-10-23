/**
 * 教程面的右键菜单（1023 覆盖面批 · WP4.8）。
 *
 * ## 为什么菜单算在宿主这一侧
 *
 * 教程浮层由内置教程插件渲染（`tutorial-overlay.ts`），宿主只拿到一串 React 元素，
 * 不持有它的组件树、也不该为"认一个代码块"去 import 插件。插件同理够不着宿主的
 * 面注册表（依赖方向是 宿主 → 插件，反着来就是环）。于是分工照 `_common.md` 的口径：
 *
 * - **插件只标注 DOM**：教程根带 `data-context-surface="tutorial"`、代码块带
 *   `data-tutorial-code`、目录条目带 `data-tutorial-section="<第几节>"`；
 * - **宿主只读 DOM**：本模块据这些标记算菜单、跑动作；插件对右键一无所知。
 *
 * 这也正是 `context-surfaces.ts` 头注第 4 条（多实例面把行数据放 DOM 属性）的同款做法。
 *
 * ## 三级策略里的位置
 *
 * 点中代码块 / 目录条目 / 链接 ⇒ 本面出菜单；点中抬头、导语、散文段落这些**没有标记**
 * 的地方 ⇒ `build` 返回 `null`（这一级不表态），交给兜底菜单（复制 / 全选 / 命令面板）。
 * 教程是"读"的界面，正文本来就该拿到通用的复制与全选——不抢。
 *
 * ## 动作只借现成的
 *
 * - 复制：`navigator.clipboard.writeText`（与文件树 / 标签页同一套用法）；
 * - 全选代码：`Selection.selectAllChildren`（不是 `execCommand('selectAll')`——那会
 *   把整页选进去）；
 * - 跳到章节：**点一下那条目录项**（`click()` 触发它自己的 onClick），跳转与滚动仍是
 *   插件那一条实现，宿主不另写第二份；
 * - 在浏览器打开：`openExternal` 平台原语（外链闸 https + 主机白名单的唯一执法点在
 *   Rust，本层不复制白名单，只做"https 才给这一项"的形状筛）。
 */
import { openExternal } from '../bridge/tauri-bridge';
import type { ContextMenuItem } from './context-menu-model';
import { declareContextSurface, type ContextSurfaceMenu } from './context-surfaces';

/** 教程面的动作 id（面自己的动作词表，不是命令——无对应命令，不冒充命令） */
export const TUTORIAL_MENU_IDS = {
  copyCode: 'tutorial.copyCode',
  selectCode: 'tutorial.selectCode',
  copyLink: 'tutorial.copyLink',
  openLink: 'tutorial.openLink',
  jumpSection: 'tutorial.jumpSection',
} as const;

/** 右键命中的教程目标（三类，各自对应一组菜单项） */
export type TutorialMenuTarget =
  | { readonly kind: 'code'; readonly element: HTMLElement; readonly text: string }
  | { readonly kind: 'link'; readonly element: HTMLElement; readonly href: string }
  | { readonly kind: 'section'; readonly element: HTMLElement; readonly index: number };

/** 剪贴板是否可用（每次现算：无剪贴板的环境要给禁用 + 原因，不能给死按钮） */
function clipboardReady(): boolean {
  if (typeof navigator === 'undefined') return false;
  const clip: Clipboard | undefined = navigator.clipboard;
  return typeof clip?.writeText === 'function';
}

/**
 * 外链能不能交给系统浏览器（**形状筛**，不是白名单）：
 * 平台闸只放 `https`（且主机在白名单、无 userinfo、无非默认端口），
 * 本层只知道"协议对不对"——所以只对 https 出这一项，其余链接静默地没有这一项，
 * 而不是给一个点了必被拒的按钮。
 */
function looksOpenable(href: string): boolean {
  return /^https:\/\//i.test(href.trim());
}

/**
 * 从被右击的元素反推教程目标：链接 → 代码块 → 目录条目（由具体到宽泛）。
 *
 * 三者互不包含（链接在正文里、代码块是 `<pre>`、目录条目在左栏），顺序只影响
 * "万一将来有嵌套"时谁优先；链接排第一是因为它带自己的去处，最具体。
 * 认不出 ⇒ `null` ⇒ 面不表态，走兜底。
 */
export function readTutorialTarget(target: HTMLElement): TutorialMenuTarget | null {
  const link = target.closest<HTMLElement>('a[href]');
  if (link !== null) {
    const href = link.getAttribute('href')?.trim() ?? '';
    if (href !== '') return { kind: 'link', element: link, href };
  }
  const code = target.closest<HTMLElement>('[data-tutorial-code]');
  if (code !== null) {
    const text = code.textContent ?? '';
    if (text !== '') return { kind: 'code', element: code, text };
  }
  const section = target.closest<HTMLElement>('[data-tutorial-section]');
  if (section !== null) {
    const raw = section.getAttribute('data-tutorial-section') ?? '';
    const index = Number(raw);
    if (Number.isInteger(index) && index >= 0) return { kind: 'section', element: section, index };
  }
  return null;
}

/** 构建选项（测试用来钉"没有剪贴板"的那条分支） */
export interface TutorialMenuOptions {
  /** 缺省 = 现算环境 */
  readonly canCopy?: boolean;
}

/**
 * 目标 → 菜单项（纯函数：不碰 DOM、不跑动作，测试直接打它）。
 *
 * 文案全中文，一律不给快捷键提示——教程面的动作都不是命令，键位只能来自
 * `menuItemFromCommand` / `KEYBINDING_SPECS`，本面没有对应命令就不编一个。
 */
export function buildTutorialMenuItems(
  target: TutorialMenuTarget,
  options: TutorialMenuOptions = {},
): ContextMenuItem[] {
  const canCopy = options.canCopy ?? clipboardReady();
  switch (target.kind) {
    case 'code':
      return [
        canCopy
          ? { id: TUTORIAL_MENU_IDS.copyCode, label: '复制代码', icon: 'code' }
          : {
              id: TUTORIAL_MENU_IDS.copyCode,
              label: '复制代码',
              icon: 'code',
              disabled: true,
              disabledReason: '当前环境没有可用的剪贴板',
            },
        { id: TUTORIAL_MENU_IDS.selectCode, label: '全选代码' },
      ];
    case 'link': {
      const items: ContextMenuItem[] = [
        canCopy
          ? { id: TUTORIAL_MENU_IDS.copyLink, label: '复制链接' }
          : {
              id: TUTORIAL_MENU_IDS.copyLink,
              label: '复制链接',
              disabled: true,
              disabledReason: '当前环境没有可用的剪贴板',
            },
      ];
      if (looksOpenable(target.href)) {
        items.push({
          id: TUTORIAL_MENU_IDS.openLink,
          label: '在浏览器打开',
          icon: 'popout',
          dividerBefore: true,
        });
      }
      return items;
    }
    case 'section':
      return [{ id: TUTORIAL_MENU_IDS.jumpSection, label: '跳到这一节', icon: 'target' }];
  }
}

/** 写剪贴板（失败只留日志：本层没有通知通道，成功也无提示——粘贴一下就知道有没有） */
function copyToClipboard(text: string): boolean {
  if (!clipboardReady()) return false;
  void navigator.clipboard.writeText(text).catch((error: unknown) => {
    console.warn('[右键菜单] 教程复制失败：', error);
  });
  return true;
}

/** 全选一个元素的文本（`selectAllChildren` 只吃这一个子树，不会波及整页） */
function selectElementText(element: HTMLElement): boolean {
  if (typeof window === 'undefined') return false;
  const selection = window.getSelection();
  if (selection === null) return false;
  selection.selectAllChildren(element);
  return true;
}

/**
 * 执行一项（面自己的分发；未知 id 返回 false，不抛）。
 *
 * 「跳到这一节」用 `click()` 而不是自己算滚动：跳转 / 焦点 / scroll-spy 全在插件的
 * 点击处理器里，右键菜单只是**另一条入口**，不是第二份实现。
 */
export function runTutorialMenuAction(target: TutorialMenuTarget, id: string): boolean {
  switch (id) {
    case TUTORIAL_MENU_IDS.copyCode:
      return target.kind === 'code' ? copyToClipboard(target.text) : false;
    case TUTORIAL_MENU_IDS.selectCode:
      return target.kind === 'code' ? selectElementText(target.element) : false;
    case TUTORIAL_MENU_IDS.copyLink:
      return target.kind === 'link' ? copyToClipboard(target.href) : false;
    case TUTORIAL_MENU_IDS.openLink:
      if (target.kind !== 'link' || !looksOpenable(target.href)) return false;
      // 闸在 Rust：被拒（非白名单主机等）只会走到 catch —— 本层没有通知通道，
      // 留日志而不是假装成功（外链 toast 的合法出口在 App 的 `ui.openExternal` 消费方）。
      void openExternal(target.href).catch((error: unknown) => {
        console.warn('[右键菜单] 教程外链被拒：', error);
      });
      return true;
    case TUTORIAL_MENU_IDS.jumpSection:
      if (target.kind !== 'section') return false;
      target.element.click();
      return true;
    default:
      return false;
  }
}

/** 面自己的菜单（`{ items, onSelect }` 对象形态——数组形态点了不做事） */
export function buildTutorialMenu(
  target: TutorialMenuTarget,
  options: TutorialMenuOptions = {},
): ContextSurfaceMenu | null {
  const items = buildTutorialMenuItems(target, options);
  if (items.length === 0) return null;
  return { items, onSelect: (id) => void runTutorialMenuAction(target, id) };
}

/**
 * 登记教程面（模块加载即登记，与 `input` 面同款：不需要任何生命周期协作）。
 *
 * 由 `main.tsx` 以副作用 import 引入；测试也可以直接 import 本模块拿到同一个面。
 */
declareContextSurface({
  id: 'tutorial',
  ariaLabel: '教程菜单',
  area: 'chrome',
  build: (ctx) => {
    const target = readTutorialTarget(ctx.target);
    if (target === null) return null; // 抬头 / 导语 / 散文：不表态，走兜底
    return buildTutorialMenu(target);
  },
});
