/**
 * 壳层全局键盘的判定逻辑（零 React，2026-10-12 P4 补测批抽出）。
 *
 * 抽出来的理由不是「为了有测试」，而是 Esc 的**优先级顺序本身是一条会咬人的规则**：
 * 设置 overlay 开着时按 Esc 必须只关 overlay，全禅状态原样保留。判定留在组件的
 * if 阶梯里就只能靠人眼读；分离后，顺序由这个模块单源持有。
 */

/**
 * Esc 链上的五层在场标志。
 *
 * `picker` = 命令面板 / 快速打开在前台——它们自己监听 Esc 并 `stopPropagation`，
 * 全局侧**必须原样让位**（多做任何一步都会把「关掉浮层背后的东西」变成「关掉浮层背后的东西，
 * 还顺手关了它下面那层」）。
 *
 * `modal` = 宿主模态栈有内容（HK-2：写权限批准 / 未保存确认 / 保存告警 / 糖视图引导 /
 * ERB 解锁）。排在 overlay 之前：模态正在问一个当下就要答案的问题，而向导只是背景流程。
 * 拿「栈深 > 0」当在场判据而不是在组件里再写一遍 if 阶梯——顺序只有这一处持有。
 */
export interface EscLayers {
  readonly picker: boolean;
  readonly modal: boolean;
  readonly overlay: boolean;
  readonly settings: boolean;
  readonly zen: boolean;
}

/** Esc 命中层的顺序（UI 重设计定稿 §八 + HK-2 模态层；改顺序等于改产品行为，须走批次记录） */
export const ESC_PRIORITY = ['picker', 'modal', 'overlay', 'settings', 'zen'] as const;

export type EscLayer = (typeof ESC_PRIORITY)[number];

/**
 * 这次 Esc 由哪一层承接？返回最靠前的在场层，全部不在场则 `null`。
 *
 * 值域是**单个层名而不是数组**——「一次按键只关一层」由返回类型保证，不靠调用方自觉。
 */
export function resolveEscLayer(layers: EscLayers): EscLayer | null {
  for (const layer of ESC_PRIORITY) {
    if (layers[layer]) return layer;
  }
  return null;
}

/**
 * 全局快捷键的合成期门（2026-10-12 实机缺陷：中文输入法按 Esc 撤销拼音候选，被壳层当成
 * 「Esc 关闭设置页 / 退出全禅」——两个完全不同的用户意图在代码里是同一条路径）。
 *
 * 三条判据叠用，各自兜不同的事件形态：
 * - `isComposing`：Chromium 对合成期间的键事件置 true，是主判据；
 * - `keyCode === 229`：`Process` 键码，兜部分版本在 Esc 上把 `isComposing` 已翻回 false 的情形；
 * - `sessionComposing`：由 `compositionstart` / `compositionend` 维护的会话标志，兜「事件属性
 *   没带上合成态」的第三方输入法。
 *
 * 已知未覆盖形态（**故意不发明魔法数**，等实机取证再补）：若某 IME 把 `compositionend`
 * 派发到这次 Esc 的 keydown **之前**，三条判据会同时失效——那时需要的是「刚结束合成」的
 * 时间窗判据，且必须配可注入时钟，而不是散落的毫秒常量。
 */
export interface ComposingEvidence {
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

/** 输入法合成期的通用键码（`key` 为 `Process` 时的 keyCode 值） */
export const IME_PROCESS_KEY_CODE = 229;

export function isComposingEvent(event: ComposingEvidence, sessionComposing: boolean): boolean {
  return event.isComposing === true || event.keyCode === IME_PROCESS_KEY_CODE || sessionComposing;
}

/** DOM 的 Element 节点类型（用数字而非 DOM 全局：node 测试无 DOM，替身按同一判据构造） */
const ELEMENT_NODE_TYPE = 1;

/** 输入类控件的标签名（小写；select 也吃字符与方向键，算「正在输入」） */
const EDITABLE_TAG_NAMES: ReadonlySet<string> = new Set(['input', 'textarea', 'select']);

/** `EventTarget` → `Element` 的结构类型守卫（非元素返回 false，绝不抛） */
function isElementTarget(target: EventTarget | null): target is Element {
  if (target === null || typeof target !== 'object') return false;
  const candidate = target as Partial<Element> & { nodeType?: number };
  return (
    candidate.nodeType === ELEMENT_NODE_TYPE &&
    typeof candidate.tagName === 'string' &&
    typeof candidate.closest === 'function'
  );
}

/**
 * 事件目标是不是「正在输入」的可编辑面（2026-10-19 语言 P0 批：输入中的 Ctrl+W / Ctrl+B
 * 会把树内改名 / 过滤输入框 blur 掉，`onCancel` 静默作废一次改名——全局键必须先问这一条）。
 *
 * 判据刻意分三层而不是「见到 input 就拦」：
 * 1. 只有真元素参与判定（`nodeType === 1`；null / Document / Window / 文本节点一律 false）；
 * 2. `.monaco-editor` 内的目标**先放行**：Monaco 的键盘输入落在隐藏 textarea 上，但它属于
 *    编辑器而不是表单——编辑器内的 Ctrl+W / Ctrl+B 必须继续走宿主分发（VSCode 行为）；
 * 3. `input` / `textarea` / `select` 与 contenteditable（空串或 `"true"`，含祖先继承）
 *    才算「正在输入」。`contenteditable="false"` 与未设置不算。
 *
 * 用数字 `nodeType` + 结构判据（`tagName` / `closest`）而不是 `instanceof Element`：
 * 仓库测试跑在 node 环境（无 DOM 全局），替身元素按同一套最小面构造，判据两边同源。
 */
export function isEditableKeyTarget(target: EventTarget | null): boolean {
  if (!isElementTarget(target)) return false;
  // Monaco 优先：它内部也有 textarea / contenteditable，但那是编辑器，不是表单
  if (target.closest('.monaco-editor') !== null) return false;
  if (EDITABLE_TAG_NAMES.has(target.tagName.toLowerCase())) return true;
  // contenteditable 走 closest：可编辑容器里的子节点（真正的光标落点）同样算
  return target.closest('[contenteditable=""], [contenteditable="true"]') !== null;
}

/**
 * 全局快捷键的三层早退证据（顺序即优先级，2026-10-19 语言 P0 批）。
 *
 * - `defaultPrevented`：更靠内层的处理者已经消费过这次按键（组件 preventDefault 过），
 *   全局侧再动一次就是「同一按键两处生效」；
 * - `composing`：输入法合成期（判据见 `isComposingEvent`）；
 * - `editableTarget`：事件目标正在输入（判据见 `isEditableKeyTarget`）。
 *
 * 命中任意一层 ⇒ 不 `preventDefault`、不执行命令，把原生行为原样留给输入框。
 * 抽成单源的理由：这三条一旦散在组件 if 阶梯里，顺序与「拦截 or 让位」的语义
 * 就只能靠人眼读——而错一次的表现是「改名静默作废」这种最难回放的缺陷。
 */
export interface GlobalKeyEvidence {
  readonly defaultPrevented: boolean;
  readonly composing: boolean;
  readonly editableTarget: boolean;
}

/** 早退层顺序（改顺序等于改产品行为；`defaultPrevented` 永远最靠前） */
export const GLOBAL_KEY_GATE_PRIORITY = ['defaultPrevented', 'composing', 'editableTarget'] as const;

export type GlobalKeyBlocker = (typeof GLOBAL_KEY_GATE_PRIORITY)[number];

/** 本次按键命中的早退层；`null` = 三层全过，可以进入分发 */
export type GlobalKeyGate = GlobalKeyBlocker | null;

/** 本次按键该由哪一层早退？三层全不命中返回 `null`（与 `resolveEscLayer` 同款单值语义） */
export function resolveGlobalKeyGate(evidence: GlobalKeyEvidence): GlobalKeyGate {
  for (const gate of GLOBAL_KEY_GATE_PRIORITY) {
    if (evidence[gate]) return gate;
  }
  return null;
}

/**
 * 分发决策：三层早退全过 **且** 命令在当前上下文启用，才允许 `preventDefault` + `run`。
 *
 * `enabled` 必须由调用方用既有的 `commandEnabled`（命令面板同一条判据）求值后传入：
 * 无项目时 Ctrl+N 在面板里是灰的，键盘侧不许仍弹出新建向导（铁律 4 的同口径）。
 */
export interface GlobalCommandDecision extends GlobalKeyEvidence {
  readonly enabled: boolean;
}

export function shouldRunGlobalCommand(decision: GlobalCommandDecision): boolean {
  return resolveGlobalKeyGate(decision) === null && decision.enabled;
}

/**
 * 方向键漫游（roving tabindex）的下一个落点（2026-10-14 HK-4 UI 批：焦点环与键盘可达）。
 *
 * 语义（调用方原样消费返回值）：
 * - `ArrowRight` / `ArrowDown` 前进一格，`ArrowLeft` / `ArrowUp` 后退一格；
 * - `Home` → `0`，`End` → `count - 1`；
 * - **边界一律回绕**（wrap-around）：末尾再前进落到 `0`，`0` 再后退落到 `count - 1`。
 *   选回绕而非停在末尾，与 ARIA APG 的 tablist 范例一致——一组控件是一圈，不是一条死胡同。
 * - 非漫游键 → `null`（调用方**原样让位**给原生行为：Enter/Space 激活、Tab 跳走都不该被吞）。
 *
 * 边界：`count <= 0` 返回 `null`（空集合无可漫游）；`current` 先夹取到 `[0, count-1]`
 * 再算（`Array#indexOf` 的 `-1` 就是靠这一步归位到 0）。
 */
export function nextRovingIndex(current: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  const cur = Math.min(count - 1, Math.max(0, current));
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (cur + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (cur - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
