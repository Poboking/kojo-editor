import { useSyncExternalStore } from 'react';
/**
 * 主题偏好（主题系统 2026-10-17；「跟随系统」2026-10 追加批；「经典编辑器色」2026-10-27 批）：零 React 纯逻辑 + 极小 React 钩子，可单测。
 *
 * 存法照 `glass-pref.ts` / `motion-pref.ts` 先例——localStorage 真源 + 订阅表，**不新造第二套
 * 偏好机制**；生效路径同款：把值写到根元素的 `data-theme` 属性上，由 `themes/*.css` 的
 * `:root[data-theme='…']` 块读取（换主题只翻 token 值，不动组件规则）。设置页一翻当场见效。
 *
 * ## 六档（落盘的是 `ThemeChoice`）
 * - `dark`：**缺省**，本仓既有蓝灰深色（`styles.css` 的 `:root` 就是它，值一律不动）。
 * - `light`：中性浅色（`themes/light.css`），VSCode Light+ 气质、保留蓝灰身份。
 * - `mint-dark`：薄荷暗色（`themes/mint-dark.css`），参考 Qoder 薄荷暗色。
 * - `one-dark`：Atom One Dark 原味（`themes/one-dark.css`）——本仓缺省 dark 的**语法色本来就
 *   是 One Dark 血统**（`c678dd`/`61afef`/`e06c75`/`98c379`/`d19a66`/`56b6c2` 逐字同源），
 *   它只是把底色换成了 App 的 `#1e2227`。这一档把底色还回官方 `#282c34`、面板还回 `#3e4451`，
 *   于是「同一个调色板、另一种底色」这件事第一次可切换。
 * - `rose-pine`：Rosé Pine（`themes/rose-pine.css`），玫瑰灰紫 + 低饱和，官方 base `#191724`。
 * - `synthwave84`：Synthwave '84（`themes/synthwave84.css`），霓虹粉青 + 深紫 `#262335`，
 *   参考 robb0wen/synthwave-vscode；【本批的审美主场，也是用户点名要的那一档】。
 * - `system`：**跟随系统**——按 `prefers-color-scheme` 在深色/浅色之间解析，并监听系统档变化
 *   实时切换（订阅表收到通知 ⇒ `useThemePref` 的快照换成新具体档 ⇒ 壳层既有 effect 重写
 *   `data-theme`、Monaco 侧随同一钩子换主题——所有消费文件零改动）。
 *
 * **为什么只有 dark/light 参与系统回退**：系统偏好只表达「深 or 浅」这一个维度，而
 * mint/one-dark/rose-pine/synthwave84 是**四套各有身份的深色**，系统无从替用户挑。它们
 * 一律是显式手选，`resolveThemeChoice('system', …)` 的返回值集合永远只有 `dark` / `light`。
 *
 * ## 向后兼容（存储键不抬版本）
 * 老用户存的 `'dark' | 'light' | 'mint-dark'` 在新模型里仍是**合法选择**，读写原样、零迁移；
 * 非法/缺席折缺省 `dark` 的老口径逐字不变。`loadThemePref()` 的返回联合**没有**加 'system'：
 * 它给 Monaco / 壳层消费，永远返回解析后的具体档（`monaco/theme.ts` 与 `ThemePref` 的
 * 双向同形编译钉因此不许动）。设置页要读的是「含 system 的选择」，走新入口 `useThemeChoice()`。
 * 副键 `kojo.ui.theme.manual.v1` 只存「最近一次手选的具体档」，仅在关闭跟随系统时用来还原；
 * 副键缺席不影响任何旧行为（缺省折 dark，与主键旧口径同源）。
 *
 * ## 缺省 dark 的理由
 * 主题是**替用户做的全局视觉决定**，本仓一贯「改视觉面默认克制」——不擅自把默认色换成新主题。
 * dark 下 `:root` 基础 token 原样生效，主题文件里 `[data-theme='dark']` 不写任何覆盖即可
 * （缺省态由基础 `:root` 承担），故首屏 splash 的硬编码 `#1e2227` 在默认档仍与 `--bg` 相等
 * （`tools/smoke-tauri-dom.mjs` 断言①钉的那条不变量不破坏）。`index.html` 早应用脚本把
 * 'system' 折成 dark 落 `data-theme`——挂载后本模块立刻按系统档改写，系统浅色的用户开机
 * 只会看到一小段深色引导，不产生错色常驻。
 *
 * ## 加一档要动哪里（2026-10-27 批的清单，别再漏）
 * ① 本文件：`ThemePref` / `THEME_IDS` / `normalizeChoice` 三处字面量；
 * ② `monaco/theme.ts`：`MonacoThemeId` / `MonacoThemePref` / `THEME_ID_BY_PREF` + 一套色板；
 * ③ `themes/<id>.css` + `main.tsx` 一行 import（缺 import = 全场落回基础 :root，静默）；
 * ④ `index.html`：早应用白名单 + 引导层那 14 条（`boot-sweep-single-source.test.ts` 会逐字
 *    比对该档 `--bg/--fg/--fg-dim/--bg-3/--accent` 与引导层，漏了当场红）；
 * ⑤ `SettingsPanel.tsx` 的 `THEME_LABELS` + `settings-appearance.css` 的卡面预览色
 *    （六档卡按 3 × 2 排，列数写死在 `.theme-cards` 上，**不随档数变**）；
 * ⑥ `ui/settings-search.ts` 的「已修改」判定：**不许枚举档名**，写成
 *    `c !== THEME_PREF_DEFAULT && c !== 'system'`。本批真踩过——那里原本是
 *    `c === 'light' || c === 'mint-dark'`，于是新三档选了也不算「改过」，搜索页静默不标记。
 * 少任何一处都有测试兜着（②③由 monaco-theme 的 CSS 源映射，④由 boot-sweep，①⑤由 typecheck），
 * **只有 ⑥ 没有闸**——它是一句布尔表达式，编译期抓不到，加档时记得回头看一眼。
 */

/** 具体档 = 写进 `data-theme` / Monaco 的生效档联合（与 `monaco/theme.ts` 逐字同形，不许加档） */
export type ThemePref = 'dark' | 'light' | 'mint-dark' | 'one-dark' | 'rose-pine' | 'synthwave84';

/** 用户选择 = 具体档 + `system`；主键落盘的就是这个联合 */
export type ThemeChoice = ThemePref | 'system';

/** 主偏好键（localStorage，落 `ThemeChoice`） */
const THEME_KEY = 'kojo.ui.theme.v1';

/** 副键：最近一次**手选**的具体档——关闭跟随系统时还原用；不进生效路径，缺席无害 */
const THEME_MANUAL_KEY = 'kojo.ui.theme.manual.v1';

/** 缺省 = dark（既有蓝灰深色；加了 system 档之后缺省不变，老用户体验逐字不动） */
export const THEME_PREF_DEFAULT: ThemePref = 'dark';

/**
 * 全部具体主题（设置页预览卡、`applyThemePref` 校验与 monaco 各套 id 映射共用这张表，单源不抄第二份）。
 * 次序＝设置页卡片的排列次序：先本仓三档（缺省 → 浅色 → 薄荷），再三套经典编辑器配色
 * （One Dark → Rosé Pine → Synthwave '84）。既有三档的相对次序与位置一格未动——老用户的
 * 肌肉记忆（第三张是薄荷）不该因为加档而漂。
 */
export const THEME_IDS: readonly ThemePref[] = [
  'dark',
  'light',
  'mint-dark',
  'one-dark',
  'rose-pine',
  'synthwave84',
];

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响本会话） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readKey(key: string): string | null {
  const s = storage();
  if (!s) return null;
  try {
    return s.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(key, value);
  } catch {
    /* 隐私模式 / 配额满：静默降级为"本次会话有效" */
  }
}

/**
 * 选择归一：合法档原样（用 `THEME_IDS.includes` 判，加档只改上面那张表一处）；
 * `system` 原样；非法/缺席一律回缺省 dark（绝不让脏值进存储或 `data-theme`）。
 */
export function normalizeChoice(raw: string | null | undefined): ThemeChoice {
  if (raw === 'system') return 'system';
  return raw !== null && raw !== undefined && (THEME_IDS as readonly string[]).includes(raw)
    ? (raw as ThemePref)
    : THEME_PREF_DEFAULT;
}

/**
 * 【旧入口·保留】归一到具体档：非法折 dark；'system' 在"要 concrete 的语境"里同样折 dark。
 * 语义与抬档前逐字一致（老单测零改动跑绿）；新代码请优先用 `normalizeChoice` / `resolveThemeChoice`。
 */
export function normalizeTheme(raw: string | null | undefined): ThemePref {
  const c = normalizeChoice(raw);
  return c === 'system' ? THEME_PREF_DEFAULT : c;
}

/** 系统现在是不是深色档？读不到 matchMedia 的环境一律按 dark 折（与基础 `:root` 缺省同向，绝不抛） */
export function systemPrefersDark(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
    return window.matchMedia('(prefers-color-scheme: dark)').matches === true;
  } catch {
    return true;
  }
}

/**
 * 纯解析（单测直钉）：选择 + 系统深浅 → 实际生效的具体档。
 * `system` 只在 dark / light 之间取——**四套深色（薄荷 / One Dark / Rosé Pine / Synthwave '84）
 * 都是显式手选，不参与系统回退**；具体档原样通过。
 */
export function resolveThemeChoice(choice: ThemeChoice, systemIsDark: boolean): ThemePref {
  return choice === 'system' ? (systemIsDark ? 'dark' : 'light') : choice;
}

/** 读落盘选择（含 'system'）——设置页选择器的勾选态用这个 */
export function loadThemeChoice(): ThemeChoice {
  return normalizeChoice(readKey(THEME_KEY));
}

/** 读「最近一次手选」的具体档（关闭跟随系统时还原用）；副键缺席/非法 → 缺省 dark，绝不抛 */
export function loadManualChoice(): ThemePref {
  return normalizeTheme(readKey(THEME_MANUAL_KEY));
}

/**
 * 读**生效**主题（缺省 dark；永远是具体档——system 在这里就被解析掉）。
 * 消费口径抬档前后逐字不变：Monaco / `data-theme` 一侧不需要知道 'system' 的存在。
 */
export function loadThemePref(): ThemePref {
  return resolveThemeChoice(loadThemeChoice(), systemPrefersDark());
}

const listeners = new Set<() => void>();

/**
 * 系统深浅监听（仅 'system' 态挂）：单例、进场挂/离场撤。变化 = notifyThemePref()——
 * `useThemePref` 的快照（解析后的具体档）随之翻转 ⇒ 壳层既有 effect 重写 `data-theme`、
 * EditorPane / diff / 预览的 Monaco 主题同步跟上。非 system 态收到系统变化不通知也不该通知
 * （快照本就由存储值决定）。挂不上监听的环境（node / 老内核）只是开机读数照常、无实时切换。
 */
let systemMq: MediaQueryList | null = null;
let systemTracking = false;

function onSystemSchemeChange(): void {
  notifyThemePref();
}

function syncSystemTracking(): void {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const wantTracking = loadThemeChoice() === 'system';
    if (wantTracking && !systemTracking) {
      systemMq = window.matchMedia('(prefers-color-scheme: dark)');
      systemMq.addEventListener('change', onSystemSchemeChange);
      systemTracking = true;
    } else if (!wantTracking && systemTracking && systemMq) {
      systemMq.removeEventListener('change', onSystemSchemeChange);
      systemMq = null;
      systemTracking = false;
    }
  } catch {
    /* 静默：实时切换降级为"下次挂载时按现场系统档解析"，绝不让异常上抛进设置页 */
  }
}

/** 订阅变化（返回取消函数）；订阅建立时顺带按当前选择维护系统监听 */
export function subscribeThemePref(listener: () => void): () => void {
  listeners.add(listener);
  syncSystemTracking();
  return () => {
    listeners.delete(listener);
  };
}

function notifyThemePref(): void {
  for (const listener of listeners) listener();
}

/* ------------------------------ 主题切换揭示（D4） ------------------------------ */

/**
 * 揭示的原点（视口坐标 px，左上角为 0,0）。缺省由本模块自己找：当前聚焦元素的中心
 * → 视口中心。调用方**想指定**（比如从菜单项触发、想从菜单那一点散开）才需要传。
 */
export interface ThemeRevealOrigin {
  readonly x: number;
  readonly y: number;
}

/**
 * 揭示用的**运行期几何量**：切换前写到 `:root` 的行内变量，由 `motion-visual.css` 的
 * `@keyframes theme-reveal` 消费。它们不是设计 token（不进 tokens.css、不参与主题翻值），
 * 每次切换现算现写、动画结束即撤，理由见本段末尾。
 */
const REVEAL_X = '--theme-reveal-x';
const REVEAL_Y = '--theme-reveal-y';
const REVEAL_R = '--theme-reveal-r';

/** 只为 `startViewTransition` 立的最小结构类型（DOM lib 版本不一定带它；不引 any） */
interface ViewTransitionHandle {
  readonly finished?: Promise<void>;
}
interface ViewTransitionCapableDocument {
  startViewTransition?: (update: () => void) => ViewTransitionHandle;
}

/**
 * 当前能不能做揭示。四条硬条件，任一不满足就**直接硬切**（与加分之前逐字一致）：
 * ① 有 document（node 单测环境没有）；
 * ② 内核认 `startViewTransition`（WebView2 / 老 Edge 的旧档、Safari 17 之前都没有）；
 * ③ 应用内「减弱动效」没开（`data-motion='reduced'`，真源 `motion-pref.ts`）；
 * ④ 系统档没要求减弱（`prefers-reduced-motion: reduce`）——系统档在不少 Windows 机器上
 *    是假阳性（见 styles.css 同段注记），但主题揭示是**纯装饰**，宁可少放一次动画。
 * 读 matchMedia 抛错按"允许"走：这里没有靠动画才能成立的事实，不该因抛错丢功能。
 */
function revealAllowed(): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  const doc = document as Document & ViewTransitionCapableDocument;
  if (typeof doc.startViewTransition !== 'function') return false;
  if (document.documentElement.getAttribute('data-motion') === 'reduced') return false;
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) return false;
  } catch {
    /* 读不到系统档：按允许处理 */
  }
  return true;
}

/**
 * 默认原点 = 当前聚焦元素的中心。
 *
 * 为什么不是"记住最后一次 pointerdown"：那需要在模块加载期挂一个全局监听（副作用藏在
 * import 里，单测与首屏图都要为它让路）。而**点卡换主题**这条主路径上，被点的
 * `<button class="theme-card">` 在 click 派发前就已经拿到焦点（Chromium/WebView2 的
 * mousedown 默认行为），于是 `activeElement` 天然就是"用户刚指的那一点"。
 * 键盘触发（命令面板 / Tab+Enter）没有鼠标点，退到视口中心由圆环居中散开，同样成立。
 */
function focusedElementCenter(): ThemeRevealOrigin | null {
  try {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  } catch {
    return null;
  }
}

/** 圆环要盖满视口：取原点到最远那个角的距离（四角同算，滚动/窗口尺寸都不必另判） */
function revealRadius(x: number, y: number): number {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return Math.hypot(Math.max(x, w - x), Math.max(y, h - y));
}

/**
 * 把"写 data-theme"这一步包进一次 View Transition，并在切换前把圆心与半径写到根元素上。
 *
 * 调用序（与逐字硬切的唯一差别就在这一层）：
 *   ① 写三个几何变量 → ② `startViewTransition(update)` → ③ update 里同步写 `data-theme`
 *   与通知订阅者（主题是**同步**改属性生效的，所以快照拍到的一定是新画面）
 *   → ④ 动画结束后把变量撤掉（只在值仍是本次写的那一份时撤，防止连点两次时误清新的）。
 *
 * 返回值只用于测试与调试：`true` = 走了揭示，`false` = 硬切。
 */
function applyThemeWithReveal(choice: ThemeChoice, origin?: ThemeRevealOrigin): boolean {
  const root = typeof document === 'undefined' ? null : document.documentElement;
  const concrete = resolveThemeChoice(normalizeChoice(choice), systemPrefersDark());
  // 点当前那一档 / 环境不支持 / 用户要静：一律走原路，零新增分支
  if (!root || root.getAttribute('data-theme') === concrete || !revealAllowed()) {
    applyThemePref(choice);
    notifyThemePref();
    return false;
  }
  const c = origin ?? focusedElementCenter() ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const radius = revealRadius(c.x, c.y);
  const px = `${Math.round(c.x)}px`;
  const py = `${Math.round(c.y)}px`;
  const pr = `${Math.round(radius)}px`;
  root.style.setProperty(REVEAL_X, px);
  root.style.setProperty(REVEAL_Y, py);
  root.style.setProperty(REVEAL_R, pr);
  const doc = document as Document & ViewTransitionCapableDocument;
  const clear = (): void => {
    if (root.style.getPropertyValue(REVEAL_X) !== px) return;
    root.style.removeProperty(REVEAL_X);
    root.style.removeProperty(REVEAL_Y);
    root.style.removeProperty(REVEAL_R);
  };
  const vt = doc.startViewTransition!(() => {
    applyThemePref(choice);
    notifyThemePref();
  });
  // `finished` 在被打断（连点第二次）时会 reject；两种结局都要收尾
  if (vt.finished) void vt.finished.then(clear, clear);
  else clear();
  return true;
}

/**
 * 写选择（先归一再存）+ 当场生效 + 维护系统监听 + 通知订阅者。
 * - 选具体档：主键与副键（手选备份）一并写成该档——点卡即手选。
 * - 选 `system`：主键写 'system'；副键**只在还没备份过时**补一份当前生效档，
 *   已有手选档（比如薄荷）不许被覆盖——那正是"关闭时沿用用户手选"要还原回去的值。
 * - `origin` 可选：只有"要从某一点散开"的调用方才传（见 `ThemeRevealOrigin`）；
 *   不传 = 从被点元素/视口中心散开，**原有调用方一个字都不用改**。
 */
export function setThemeChoice(choice: ThemeChoice, origin?: ThemeRevealOrigin): void {
  const c = normalizeChoice(choice);
  if (c === 'system') {
    if (readKey(THEME_MANUAL_KEY) === null) {
      writeKey(THEME_MANUAL_KEY, loadThemePref());
    }
  } else {
    writeKey(THEME_MANUAL_KEY, c);
  }
  writeKey(THEME_KEY, c);
  applyThemeWithReveal(c, origin);
  syncSystemTracking();
}

/** 【旧入口·保留】写具体档，等价 `setThemeChoice(t)` */
export function setThemePref(t: ThemePref): void {
  setThemeChoice(t);
}

/** 跟随系统开关：开 = 落 'system'；关 = 还原最近一次手选的具体档 */
export function setFollowSystem(on: boolean): void {
  setThemeChoice(on ? 'system' : loadManualChoice());
}

/**
 * 应用生效的唯一入口：把**解析后的具体档**写到根元素的 `data-theme` 属性上，供 `themes/*.css` 读取。
 * 绝不把字符串 'system' 写进 DOM——主题源没有那一块，写了等于全场静默落回基础 `:root`。
 *
 * `root` 取**结构化最小接口**（只要求 `setAttribute`）：本模块因此不依赖 DOM 类型，node 里用
 * 一枚假元素即可钉死生效路径；缺省 `document.documentElement`，无 `document` 环境安全跳过。
 */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
}

export function applyThemePref(
  t: ThemeChoice = loadThemePref(),
  root: ThemeRoot | null = typeof document === 'undefined' ? null : (document.documentElement as unknown as ThemeRoot),
): void {
  if (!root) return;
  root.setAttribute('data-theme', resolveThemeChoice(normalizeChoice(t), systemPrefersDark()));
}

/** React 读数（**生效**具体档）：壳层 / Monaco 消费；跟随系统时随系统变化实时翻转 */
export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribeThemePref, loadThemePref);
}

/** React 读数（落盘**选择**，含 'system'）：设置页选择器勾选态用这个，别拿生效档当选中态 */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribeThemePref, loadThemeChoice);
}
