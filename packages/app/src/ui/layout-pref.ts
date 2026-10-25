/**
 * 排版偏好（P2-16，2026-10-20）：折行三选一 + 多光标修饰键 + 列选择。
 * 零 React 纯逻辑（localStorage + 订阅表），node 可单测——存法照 `format-pref.ts` /
 * `motion-pref.ts` 先例，**不新造第二套偏好机制**。
 *
 * 生效路径只有一条：`editor-options.ts` 的 {@link layoutPrefPatch} 每次落档现读本模块
 * （与 `format-pref.ts`「保存链路每次现读」同一条纪律）——EditorPane 的 create options、
 * `applySizeTier` 的三个写入点（切标签 / 挂预览 / 撤预览）全都经过它，没有第二条路径
 * 另写 `wordWrap`。读不到 / 抛错一律回缺省，绝不抛到编辑器链路。
 *
 * ## 三个缺省值 = 今天的行为（P2-16 硬判据：缺省让今天逐字不变）
 *
 * - **折行缺省「跟随体量档」**：完全交给档位表（`editor-options.ts` 的 small/large
 *   `'on'`、huge `'off'`），即今天硬编码的那一份；且"没存过键"与"存了 tier"同义，
 *   老用户零迁移。
 * - **列选择缺省关**：与 Monaco 自己的注册缺省一致（`editorOptions.js` 的
 *   `EditorBooleanOption(28, 'columnSelection', false, …)`）⇒ 不传这条选项的今天
 *   与显式传 false 的明天逐字等价。
 * - **多光标修饰键缺省 `ctrlCmd`**：**这是产品决策，不是继承缺省**——vendor 实测
 *   （`editorOptions.js` 的 `new EditorEnumOption(86, 'multiCursorModifier',
 *   'altKey', 'alt', ['ctrlCmd', 'alt'], …)`，注册缺省 internal `'altKey'` /
 *   schema `'alt'`）Monaco 的注册缺省其实是 **`alt`**；任务卡面上写的「Monaco 缺省值」
 *   与实测不符，取 `ctrlCmd` 的两条理由：① Alt 是 Windows 输入法切换的高发键，
 *   中文作者 Alt+点击容易和切词手势撞；②「按住 Ctrl/Cmd 点选 = 多选」是资源管理器
 *   与多数工具的大众肌肉记忆。代价说清（铁律 4，不静默）：没动过这项的作者，多光标
 *   从 Alt+点击 变成 Ctrl/Cmd+点击——设置页二选一，一键可回退。
 */

/** 折行三选一：`tier` = 跟随体量档（档位表自己定）；`on` / `off` = 强制 */
export type WordWrapPref = 'tier' | 'on' | 'off';

/**
 * 多光标修饰键二选一。取值就是 Monaco 0.57 `monaco.d.ts` 的登记值
 * （`multiCursorModifier?: 'ctrlCmd' | 'alt'`）——偏好里不另造一套词汇，
 * 落到 Monaco 时零翻译。
 */
export type MultiCursorModifierPref = 'ctrlCmd' | 'alt';

/** 三个排版偏好的一份快照（设置页镜像与落档补丁都读它） */
export interface LayoutPref {
  wordWrap: WordWrapPref;
  multiCursorModifier: MultiCursorModifierPref;
  columnSelection: boolean;
}

/** 偏好键（localStorage；与 `kojo.ui.*.v1` 同一套命名） */
const WORD_WRAP_KEY = 'kojo.ui.layout.wordWrap.v1';
const MULTI_CURSOR_KEY = 'kojo.ui.layout.multiCursorModifier.v1';
const COLUMN_SELECTION_KEY = 'kojo.ui.layout.columnSelection.v1';

/** 折行缺省 = 跟随体量档（见模块头「三个缺省值」） */
export const WORD_WRAP_DEFAULT: WordWrapPref = 'tier';

/** 三档展示序（状态栏 popover：跟随档 → 开 → 关） */
export const WORD_WRAP_CHOICES: readonly WordWrapPref[] = ['tier', 'on', 'off'];

/** 三档中文标签（状态栏那格与菜单同词，与设置页「折行」一项同口径） */
export const WORD_WRAP_LABELS: Record<WordWrapPref, string> = {
  tier: '跟随档',
  on: '开',
  off: '关',
};

/**
 * Alt+Z 的切向（**状态栏 / 命令 / 快捷键三条入口共用的互操作判据单源**）：
 * 永远在「开 / 关」两个显式值之间翻转，三档里的 `tier`（跟随档）被显式切换即离开。
 * - `on → off`；`off → on`；
 * - `tier →` 看**此刻屏幕上那份文档**在档位表上的生效值 `tierEffective`（调用方经
 *   `layoutPrefPatch(lineCount).wordWrap` 现算）：生效开 ⇒ 写 `off`，生效关 ⇒ 写 `on`。
 *
 * `tier` 这一档**不许删**：它仍是「没存过键」与「跟随体量档」的既有真源（见模块头），
 * 显式翻过之后作者仍能在状态栏 / 设置页把它调回跟随档。
 */
export function nextWordWrapToggle(current: WordWrapPref, tierEffective: 'on' | 'off'): WordWrapPref {
  const effective = current === 'tier' ? tierEffective : current;
  return effective === 'on' ? 'off' : 'on';
}

/** 多光标修饰键缺省 = ctrlCmd（产品决策，理由见模块头） */
export const MULTI_CURSOR_MODIFIER_DEFAULT: MultiCursorModifierPref = 'ctrlCmd';

/** 列选择缺省 = 关（与 Monaco 注册缺省一致） */
export const COLUMN_SELECTION_DEFAULT = false;

/** 整份缺省（读不到 / 存坏 / 抛错时的回落值） */
export const LAYOUT_PREF_DEFAULT: LayoutPref = {
  wordWrap: WORD_WRAP_DEFAULT,
  multiCursorModifier: MULTI_CURSOR_MODIFIER_DEFAULT,
  columnSelection: COLUMN_SELECTION_DEFAULT,
};

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响编辑器） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 严格口径读枚举：只有登记值算数，别的（含空串 / 脏值 / 大小写变体）回落缺省 */
function readEnum<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

const WORD_WRAP_VALUES: readonly WordWrapPref[] = ['tier', 'on', 'off'];
const MULTI_CURSOR_VALUES: readonly MultiCursorModifierPref[] = ['ctrlCmd', 'alt'];

/**
 * 读偏好（三键各自严格校验；读不到 / 抛错一律回缺省，绝不抛到编辑器链路）。
 *
 * 引用稳定（`useSyncExternalStore` 的 getSnapshot 契约）：三字段都没变 ⇒ 返回**上一次
 * 那个对象**——设置页订阅表（autosave / font-size 先例的快照都是原始值，Object.is 直接
 * 可比），本偏好是仓里第一份对象快照，不缓存引用 React 会判定"快照在变"而死循环重渲染。
 * 缓存只省引用、不省真值：每次仍现读 localStorage，devtools / 另一窗口改了照样立即生效。
 */
let snapshotCache: LayoutPref | null = null;

export function loadLayoutPref(): LayoutPref {
  let fresh: LayoutPref;
  const s = storage();
  if (!s) {
    fresh = { ...LAYOUT_PREF_DEFAULT };
  } else {
    try {
      fresh = {
        wordWrap: readEnum(s.getItem(WORD_WRAP_KEY), WORD_WRAP_VALUES, WORD_WRAP_DEFAULT),
        multiCursorModifier: readEnum(
          s.getItem(MULTI_CURSOR_KEY),
          MULTI_CURSOR_VALUES,
          MULTI_CURSOR_MODIFIER_DEFAULT,
        ),
        // 布尔同 `suggest-pref.ts` 的 loadBooleanPref 口径：只有 '1' 算开
        columnSelection: s.getItem(COLUMN_SELECTION_KEY) === '1',
      };
    } catch {
      fresh = { ...LAYOUT_PREF_DEFAULT };
    }
  }
  if (
    snapshotCache !== null &&
    snapshotCache.wordWrap === fresh.wordWrap &&
    snapshotCache.multiCursorModifier === fresh.multiCursorModifier &&
    snapshotCache.columnSelection === fresh.columnSelection
  ) {
    return snapshotCache;
  }
  snapshotCache = fresh;
  return fresh;
}

/** 变更订阅表（同一张表：设置页与 EditorPane 的落档补丁都订这里） */
const listeners = new Set<() => void>();

/** 写一个键 + 通知订阅者（写不进去静默降级：只影响下次启动的默认值，本次会话仍立即生效） */
function writePref(key: string, value: string): void {
  const s = storage();
  if (s) {
    try {
      s.setItem(key, value);
    } catch {
      /* 隐私模式 / 配额满：静默降级为"本次会话按已存值走" */
    }
  }
  for (const listener of listeners) listener();
}

/** 写折行（三个值都是真选择，'tier' 也落键——不像布尔那样"关 = 删键"） */
export function saveWordWrapPref(value: WordWrapPref): void {
  writePref(WORD_WRAP_KEY, value);
}

/** 写多光标修饰键（登记值直存，落 Monaco 前零翻译） */
export function saveMultiCursorModifierPref(value: MultiCursorModifierPref): void {
  writePref(MULTI_CURSOR_KEY, value);
}

/** 写列选择（'1' = 开、'0' = 关，口径同 `suggest-pref.ts`） */
export function saveColumnSelectionPref(on: boolean): void {
  writePref(COLUMN_SELECTION_KEY, on ? '1' : '0');
}

/** 订阅偏好变化（返回取消订阅函数；调用方卸载时必须取消，否则闭包攥着已 dispose 的编辑器） */
export function subscribeLayoutPref(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
