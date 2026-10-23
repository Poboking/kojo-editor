/**
 * 欢迎页（整面 / 最近项目行）的右键菜单数据面（零渲染，可直接打纯函数）。
 *
 * ## 为什么单开一个模块
 *
 * 菜单项的判据（哪一项显示、哪一项灰着、灰的原因是什么）必须能被单测直接打，
 * 不能建立在"整页渲染出来点一下"上；欢迎页整面与最近项目行共享同一套「复制成功/失败
 * 都要说话」的口径——放在组件里会被复制两遍。
 *
 * ## 模块边界（2026-10 减重后）
 *
 * 本模块在开机图上（`main.tsx → App → WelcomeView → 这里`），所以它**只装欢迎页要用的东西**。
 * 设置页与快捷键页的两个面已经搬到 `settings-menu.ts`——那两个面依赖设置项索引、
 * 外观偏好与键位表，而它们的宿主（`SettingsPanel.tsx`）本来就是懒加载的，没有理由让
 * 首屏替它们付账。**不要在这里转发 `settings-menu` 的符号**，也不要 value-import
 * `settings-search` / `editor-display-prefs` / `editor-options` / `keybindings`——
 * 那等于把剪断的懒边接回首屏（判据见 `settings-menu.test.ts`）。
 *
 * 本模块留下的公共小件（`clipboardAvailable` / `copyText` / `useMenuNote` / `isFailureNote`）
 * 仍被设置页与快捷键页引用：它们本来就已在首屏，反着依赖（懒 → 常驻）不会带重新东西。
 *
 * ## 结构（照地基的三件套，不自创第二套）
 *
 * - 面的注册在**模块顶层**（`declareContextSurface`）：id 取自 `CONTEXT_SURFACE_MANIFEST`
 *   （`welcome` / `welcome-recent`），`build` 只做两件事——① 从 `target` 读 DOM 上的
 *   **行数据**（`data-recent-root`）；② 把行数据与「本页注册的接线桥」合成纯函数入参。
 * - 欢迎页在挂载时 `registerWelcomeMenuBridge` 注册一枚**接线桥**：桥里只有回调与只读读数，
 *   没有菜单知识。页面卸载即 `null`，所以菜单不会对着一个已经不存在的页面发动作。
 * - 抽屉里全是纯函数（`buildWelcomeRecentMenu` / `buildWelcomePageMenu`）：
 *   输入上下文、输出 items，测试直接打它们。
 *
 * ## 三条铁律的落点
 *
 * 1. **文案全中文**（含 CJK），命令类项一律 `menuItemFromCommand` 取标题与键位；
 * 2. **能力不存在 ⇒ 整项不显示**：没有 Tauri（`show_in_folder` 不可用）就没有「在资源管理器中显示」；
 *    没有剪贴板就没有任何「复制…」项；命令行没就绪就没有命令项；
 * 3. **暂不可用 ⇒ `disabled: true` + `disabledReason` 人话**：打不开的最近项目、
 *    命令通道没就绪的命令项，一律灰着并说明为什么。
 */
import { useEffect, useState } from 'react';
import {
  buildFallbackMenu,
  canRunContextMenuCommand,
  menuItemFromCommand,
  runFallbackMenuAction,
  type ContextMenuItem,
} from './context-menu-model';
import { declareContextSurface } from './context-surfaces';

/* ==========================================================================================
 * 一、公共小件：剪贴板与「一句话回执」
 *
 * 这几件不是欢迎页专属：设置页与快捷键页（`settings-menu.ts`，懒 chunk）也引用它们，
 * 所以留在本模块而不是跟着页面走——懒模块从常驻模块取料，不会把常驻图撑大。
 * ========================================================================================== */

/**
 * 当前环境有没有可写剪贴板。
 *
 * 构建期判据：没有就让「复制…」整项不出现（铁律的「能力不存在」），
 * 而不是给一个按下去只弹失败的入口。
 */
export function clipboardAvailable(): boolean {
  if (typeof navigator === 'undefined') return false;
  const clip: Clipboard | undefined = navigator.clipboard;
  return clip !== undefined && typeof clip.writeText === 'function';
}

/**
 * 写剪贴板并留下人话回执（成功、失败都说一句）。
 *
 * 复制是**最容易读成"没生效"**的动作：不吭声时作者只能反复点，最后怀疑按钮坏了。
 * 回执走各页自己的状态行（`role="status"`），不弹模态、不抢焦点。
 */
export function copyText(text: string, what: string, note: (line: string) => void): void {
  if (!clipboardAvailable()) {
    note('复制失败：当前环境没有可用的剪贴板');
    return;
  }
  void navigator.clipboard.writeText(text).then(
    () => note(`已复制${what}`),
    () => note('复制失败：剪贴板拒绝了这次写入'),
  );
}

/** 菜单回执在屏幕上留多久（毫秒）：够读完一句中文，又不至于赖着） */
const MENU_NOTE_MS = 2600;

/**
 * 页面级的「菜单回执」状态（`note` 人话上屏 + 到时自动收起）。
 *
 * 各页共用这一份：菜单动作的回执不该三种写法——一处 `role="status"`、一处 toast、
 * 一处只写 console，作者会以为只有某一页的复制生效了。
 */
export function useMenuNote(): readonly [string | null, (line: string) => void] {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(() => setNote(null), MENU_NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);
  return [note, setNote] as const;
}

/**
 * 回执是不是一条失败（上错误色用）。
 *
 * 判据落在文案上而不是多开一条 tone 通道：回执的措辞本来就要求把成败说出来
 * （「已复制…」/「复制失败：…」），颜色只是给这句话加一层强调——只靠颜色表意
 * 对色觉障碍与读屏都不作数。
 */
export function isFailureNote(line: string): boolean {
  return line.includes('失败') || line.includes('没法');
}

/**
 * 这次按下是不是**主键**（左键）——实现与文档已上收到数据面 `context-menu-model.ts`
 * （`isPrimaryButton`）：Palette / ShellLayout / 设置页三处共用同一个判据，
 * 各写一份 `button === 0` 迟早会漏掉一处。这里保留转发是为了不让既有 import 断掉。
 */
export { isPrimaryButton } from './context-menu-model';

/* ==========================================================================================
 * 二、欢迎页 · 最近项目行（WP4.4）
 * ========================================================================================== */

/** 行的动作 id（面自己的词表，不是命令） */
export const WELCOME_RECENT_ACTION = {
  open: 'welcome.openRecent',
  remove: 'welcome.removeRecent',
  copyPath: 'welcome.copyPath',
  reveal: 'welcome.reveal',
} as const;

/** 最近项目行的菜单入参（全部是纯数据：行读什么就传什么） */
export interface WelcomeRecentMenuInput {
  /** 打开这一项被挡住的人话原因（`null` = 现在就能打开） */
  readonly openBlockedReason: string | null;
  /** 目录已不存在（`stat` 判过）：行仍可点着重试，但「在资源管理器中显示」没意义 */
  readonly missing: boolean;
  /** 桌面壳在（`show_in_folder` 可用） */
  readonly canReveal: boolean;
  /** 剪贴板可用 */
  readonly canCopy: boolean;
}

/**
 * 最近项目行的菜单。
 *
 * - **打开**：被挡住（内核装配中 / 正在打开项目）时灰着并说明；
 * - **从最近移除**：走页面的既有移除回调（乐观更新 + 持久层都在那边）；
 * - **复制项目路径**：没有剪贴板就整项不出现；
 * - **在资源管理器中显示**：只有桌面壳才显示这一项；目录已不存在时灰着说明。
 *
 * 「在新组打开」**不做**：宿主没有「把项目开进新编辑器组」的能力（开项目 = 整块换工作区，
 * 编辑器组只切标签），菜单不为凑项新造业务逻辑。
 */
export function buildWelcomeRecentMenu(input: WelcomeRecentMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      id: WELCOME_RECENT_ACTION.open,
      label: '打开这个项目',
      icon: 'files',
      ...(input.openBlockedReason === null
        ? {}
        : { disabled: true, disabledReason: input.openBlockedReason }),
    },
    {
      id: WELCOME_RECENT_ACTION.remove,
      label: '从「最近」里移除',
      icon: 'trash',
      dividerBefore: true,
    },
  ];
  if (input.canCopy) {
    items.push({ id: WELCOME_RECENT_ACTION.copyPath, label: '复制项目路径' });
  }
  if (input.canReveal) {
    items.push({
      id: WELCOME_RECENT_ACTION.reveal,
      label: '在资源管理器中显示',
      icon: 'popout',
      dividerBefore: true,
      ...(input.missing ? { disabled: true, disabledReason: '这个目录已经不在了' } : {}),
    });
  }
  return items;
}

/* ==========================================================================================
 * 三、欢迎页 · 整面（WP4.4 的兜底：没有最近项目时的启动入口）
 * ========================================================================================== */

/** 整页面的动作 id */
export const WELCOME_PAGE_ACTION = {
  openDirectory: 'welcome.openDirectory',
  resume: 'welcome.resume',
  clearRecent: 'welcome.clearRecent',
} as const;

export interface WelcomePageMenuInput {
  readonly openBlockedReason: string | null;
  /** 有可继续的会话（最近一次打开的根，且没有待决的崩溃恢复） */
  readonly resumeAvailable: boolean;
  readonly hasRecent: boolean;
  /** 命令通道就绪（命令项否则灰着说明，不冒充能按） */
  readonly commandsReady: boolean;
  /** 通用项（复制 / 全选）：直接借兜底菜单的一份，页面不另写剪贴板判据 */
  readonly generic: readonly ContextMenuItem[];
}

/**
 * 欢迎页整面的菜单：启动（打开文件夹 / 继续上次会话） → 命令（命令面板 / 打开设置）
 * → 清理（清空最近项目） → 通用（复制 / 全选）。
 *
 * 为什么把通用项并进来：整面右键若不表态就会落到兜底菜单，可欢迎页上恰恰有大量可复制的
 * 路径文本（最近项目那张表）。这里复用兜底菜单算好的两项，不自己判断选区。
 */
export function buildWelcomePageMenu(input: WelcomePageMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      id: WELCOME_PAGE_ACTION.openDirectory,
      label: '打开文件夹…',
      icon: 'files',
      ...(input.openBlockedReason === null
        ? {}
        : { disabled: true, disabledReason: input.openBlockedReason }),
    },
  ];
  if (input.resumeAvailable) {
    items.push({
      id: WELCOME_PAGE_ACTION.resume,
      label: '继续上次会话',
      icon: 'history',
      ...(input.openBlockedReason === null
        ? {}
        : { disabled: true, disabledReason: input.openBlockedReason }),
    });
  }
  let firstCommand = true;
  for (const id of ['workbench.commandPalette', 'layout.openSettings']) {
    const item = menuItemFromCommand(id, firstCommand ? { dividerBefore: true } : undefined);
    if (item === null) continue; // 命令未登记 ⇒ 整项不显示
    firstCommand = false;
    items.push(
      input.commandsReady
        ? item
        : { ...item, disabled: true, disabledReason: '命令还没就绪，稍后再试' },
    );
  }
  if (input.hasRecent) {
    items.push({
      id: WELCOME_PAGE_ACTION.clearRecent,
      label: '清空最近项目',
      icon: 'trash',
      dividerBefore: true,
    });
  }
  input.generic.forEach((item, at) => {
    items.push(at === 0 ? { ...item, dividerBefore: true } : item);
  });
  return items;
}

/* ==========================================================================================
 * 四、接线桥（欢迎页挂载时注册；卸载即撤掉）
 * ========================================================================================== */

/** 欢迎页的接线桥（只有回调与只读读数，没有任何菜单知识） */
export interface WelcomeMenuBridge {
  /** 打开被挡住的人话原因（`null` = 现在就能打开） */
  openBlockedReason(): string | null;
  canReveal(): boolean;
  resumeAvailable(): boolean;
  hasRecent(): boolean;
  openRecent(rootDir: string): void;
  removeRecent(rootDir: string): void;
  reveal(rootDir: string): void;
  openDirectory(): void;
  resumeSession(): void;
  clearRecent(): void;
  note(line: string): void;
}

let welcomeBridge: WelcomeMenuBridge | null = null;

/** 注册欢迎页接线桥（`null` = 卸载） */
export function registerWelcomeMenuBridge(bridge: WelcomeMenuBridge | null): void {
  welcomeBridge = bridge;
}

/* ==========================================================================================
 * 五、两个面的注册（模块顶层：模块被加载即登记，热重载幂等覆盖）
 * ========================================================================================== */

/** 最近项目行：行数据在 DOM，能力读数在桥 */
declareContextSurface({
  id: 'welcome-recent',
  ariaLabel: '最近项目菜单',
  area: 'chrome',
  build: (ctx) => {
    const bridge = welcomeBridge;
    const row = ctx.target.closest<HTMLElement>('[data-context-surface="welcome-recent"]');
    if (bridge === null || row === null) return null; // 这一级不表态 ⇒ 往兜底走
    const rootDir = row.getAttribute('data-recent-root') ?? '';
    if (rootDir === '') return null;
    const items = buildWelcomeRecentMenu({
      openBlockedReason: bridge.openBlockedReason(),
      missing: row.getAttribute('data-recent-missing') === '1',
      canReveal: bridge.canReveal(),
      canCopy: clipboardAvailable(),
    });
    return {
      items,
      onSelect: (id) => {
        switch (id) {
          case WELCOME_RECENT_ACTION.open:
            bridge.openRecent(rootDir);
            break;
          case WELCOME_RECENT_ACTION.remove:
            bridge.removeRecent(rootDir);
            bridge.note('已从「最近」里移除');
            break;
          case WELCOME_RECENT_ACTION.copyPath:
            copyText(rootDir, '项目路径', bridge.note);
            break;
          case WELCOME_RECENT_ACTION.reveal:
            bridge.reveal(rootDir);
            break;
          default:
            break;
        }
      },
    };
  },
});

/** 欢迎页整面：没有最近项目时这里就是启动入口 */
declareContextSurface({
  id: 'welcome',
  ariaLabel: '欢迎页菜单',
  area: 'chrome',
  build: (ctx) => {
    const bridge = welcomeBridge;
    if (bridge === null) return null;
    const items = buildWelcomePageMenu({
      openBlockedReason: bridge.openBlockedReason(),
      resumeAvailable: bridge.resumeAvailable(),
      hasRecent: bridge.hasRecent(),
      commandsReady:
        canRunContextMenuCommand('workbench.commandPalette') ||
        canRunContextMenuCommand('layout.openSettings'),
      // 通用项借兜底菜单现算（复制 / 全选），页面不另写一份选区判据
      generic: buildFallbackMenu(ctx.target).filter(
        (item) => item.id === 'clipboard.copy' || item.id === 'selection.selectAll',
      ),
    });
    return {
      items,
      onSelect: (id) => {
        switch (id) {
          case WELCOME_PAGE_ACTION.openDirectory:
            bridge.openDirectory();
            break;
          case WELCOME_PAGE_ACTION.resume:
            bridge.resumeSession();
            break;
          case WELCOME_PAGE_ACTION.clearRecent:
            bridge.clearRecent();
            bridge.note('已清空最近项目（磁盘上的文件没动）');
            break;
          default:
            // 命令项与通用项（复制 / 全选）都走地基的统一分发，本页不另写一套执行路径
            if (!runFallbackMenuAction(id, ctx.target)) bridge.note('这个动作现在没法执行');
            break;
        }
      },
    };
  },
});
