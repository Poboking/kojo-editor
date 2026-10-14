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
