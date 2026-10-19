import { useSyncExternalStore } from 'react';
/**
 * 主题偏好（主题系统 2026-10-17；「跟随系统」2026-10 追加批）：零 React 纯逻辑 + 极小 React 钩子，可单测。
 *
 * 存法照 `glass-pref.ts` / `motion-pref.ts` 先例——localStorage 真源 + 订阅表，**不新造第二套
 * 偏好机制**；生效路径同款：把值写到根元素的 `data-theme` 属性上，由 `themes/*.css` 的
 * `:root[data-theme='…']` 块读取（换主题只翻 token 值，不动组件规则）。设置页一翻当场见效。
 *
 * ## 四档（落盘的是 `ThemeChoice`）
 * - `dark`：**缺省**，本仓既有蓝灰深色（`styles.css` 的 `:root` 就是它，值一律不动）。
 * - `light`：中性浅色（`themes/light.css`），VSCode Light+ 气质、保留蓝灰身份。
 * - `mint-dark`：薄荷暗色（`themes/mint-dark.css`），参考 Qoder 薄荷暗色。
 * - `system`：**跟随系统**——按 `prefers-color-scheme` 在深色/浅色之间解析，并监听系统档变化
 *   实时切换（订阅表收到通知 ⇒ `useThemePref` 的快照换成新具体档 ⇒ 壳层既有 effect 重写
 *   `data-theme`、Monaco 侧随同一钩子换主题——所有消费文件零改动）。
 *
 * ## 向后兼容（存储键不抬版本）
 * 老用户存的 `'dark' | 'light' | 'mint-dark'` 在新模型里仍是**合法选择**，读写原样、零迁移；
 * 非法/缺席折缺省 `dark` 的老口径逐字不变。`loadThemePref()` 的返回联合**没有**加 'system'：
 * 它给 Monaco / 壳层消费，永远返回解析后的具体三档（`monaco/theme.ts` 与 `ThemePref` 的
 * 双向同形编译钉因此不许动）。设置页要读的是「含 system 的选择」，走新入口 `useThemeChoice()`。
 * 副键 `kojo.ui.theme.manual.v1` 只存「最近一次手选的具体档」，仅在关闭跟随系统时用来还原；
 * 副键缺席不影响任何旧行为（缺省折 dark，与主键旧口径同源）。
 *
 * ## 缺省 dark 的理由
 * 主题是**替用户做的全局视觉决定**，本仓一贯「改视觉面默认克制」——不擅自把默认色换成新主题。
 * dark 下 `:root` 基础 token 原样生效，主题文件里 `[data-theme='dark']` 不写任何覆盖即可
 * （缺省态由基础 `:root` 承担），故首屏 splash 的硬编码 `#1e2227` 在默认档仍与 `--bg` 相等
 * （`tools/smoke-tauri-dom.mjs` 断言①钉的那条不变量不破坏）。`index.html` 早应用脚本把
 * 'system' 折成 dark 落 `data-theme`（该文件本批不归这条线所有）——挂载后本模块立刻按
 * 系统档改写，系统浅色的用户开机只会看到一小段深色引导，不产生错色常驻。
 */

/** 具体三档 = 写进 `data-theme` / Monaco 的生效档联合（与 `monaco/theme.ts` 逐字同形，不许加档） */
export type ThemePref = 'dark' | 'light' | 'mint-dark';

/** 用户选择 = 具体三档 + `system`；主键落盘的就是这个联合 */
export type ThemeChoice = ThemePref | 'system';

/** 主偏好键（localStorage，落 `ThemeChoice`） */
const THEME_KEY = 'kojo.ui.theme.v1';

/** 副键：最近一次**手选**的具体档——关闭跟随系统时还原用；不进生效路径，缺席无害 */
const THEME_MANUAL_KEY = 'kojo.ui.theme.manual.v1';

/** 缺省 = dark（既有蓝灰深色；加了 system 档之后缺省不变，老用户体验逐字不动） */
export const THEME_PREF_DEFAULT: ThemePref = 'dark';

/** 全部具体主题（设置页预览卡、`applyThemePref` 校验与 monaco 三套 id 映射共用这张表，单源不抄第二份） */
export const THEME_IDS: readonly ThemePref[] = ['dark', 'light', 'mint-dark'];

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

/** 选择归一：四档原样；非法/缺席一律回缺省 dark（绝不让脏值进存储或 `data-theme`） */
export function normalizeChoice(raw: string | null | undefined): ThemeChoice {
  return raw === 'system' || raw === 'dark' || raw === 'light' || raw === 'mint-dark'
    ? raw
    : THEME_PREF_DEFAULT;
}

/**
 * 【旧入口·保留】归一到具体三档：非法折 dark；'system' 在"要 concrete 的语境"里同样折 dark。
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
 * `system` 只在 dark / light 之间取——**薄荷是显式手选，不参与系统回退**；具体档原样通过。
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
 * 读**生效**主题（缺省 dark；永远是具体三档——system 在这里就被解析掉）。
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

/**
 * 写选择（先归一再存）+ 当场生效 + 维护系统监听 + 通知订阅者。
 * - 选具体档：主键与副键（手选备份）一并写成该档——点卡即手选。
 * - 选 `system`：主键写 'system'；副键**只在还没备份过时**补一份当前生效档，
 *   已有手选档（比如薄荷）不许被覆盖——那正是"关闭时沿用用户手选"要还原回去的值。
 */
export function setThemeChoice(choice: ThemeChoice): void {
  const c = normalizeChoice(choice);
  if (c === 'system') {
    if (readKey(THEME_MANUAL_KEY) === null) {
      writeKey(THEME_MANUAL_KEY, loadThemePref());
    }
  } else {
    writeKey(THEME_MANUAL_KEY, c);
  }
  writeKey(THEME_KEY, c);
  applyThemePref(c);
  syncSystemTracking();
  notifyThemePref();
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
