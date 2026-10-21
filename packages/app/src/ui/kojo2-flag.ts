/**
 * Kojo 2.0 **预演开关**（K2-EDITOR-WIRE）：默认关，只开"可打开"，不切流。
 *
 * 存法照 `tree-sitter-pref.ts` / `semantic-color-pref.ts` 先例 —— localStorage 唯一真源 +
 * 订阅表，**不新造第二套偏好机制**。键沿用 `kojo.ui.*.v1` 一族；只有明确存过 `on` 才算开
 * （坏值 / 手改 / 隐私模式一律回默认，失败方向永远是"少露"，不是"多露"）。
 *
 * ## 为什么必须默认关
 *
 * 2.0 的宿主语言服务、结构层、保存 / 部署链路都还没接（那是 K2-CUTOVER 的事）。本开关
 * 只负责让 `.kojo2` 文件在真实编辑器里**打得开、脸是对的**；默认开会让作者在预览语法上
 * 写出工具还不能完整接住的内容。
 *
 * ## 生效时机：装配那一刻
 *
 * `monaco/languages.ts` 在**模块求值**时读一次本开关：descriptor 表是进程级只增表，
 * 开关翻了也要重载窗口才换表（本批不提供运行时热切换——半套切流比不切更危险）。
 *
 * ## 作者面文案
 *
 * 本模块是机器面（devtools / 将来的设置页），标识符与键名可以和代码对得上；真要上屏时
 * 由调用方写人话，这里不产出任何界面文案。
 */

/** 开关键（localStorage；与 `kojo.ui.*.v1` 同一套命名） */
export const KOJO2_CUTOVER_KEY = 'kojo.ui.kojo2Cutover.v1';

/** 缺省 = 关（见模块头「为什么必须默认关」） */
export const KOJO2_CUTOVER_DEFAULT = false;

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响编辑器） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 读开关：只有存过 `on` 才算开；没存过 / 坏值 / 读抛错一律回默认关。
 *
 * 每次现读、不做模块级缓存：真源只有 localStorage 一份，devtools 改了立即反映在
 * **下一处读取**上（下一次重载窗口即生效）。
 */
export function isKojo2CutoverEnabled(): boolean {
  const s = storage();
  if (!s) return KOJO2_CUTOVER_DEFAULT;
  try {
    return s.getItem(KOJO2_CUTOVER_KEY) === 'on';
  } catch {
    return KOJO2_CUTOVER_DEFAULT;
  }
}

/** 变更订阅表（`set` 后逐一通知；将来的设置页 / 调试面板订这张表） */
const listeners = new Set<() => void>();

/**
 * 写开关 + 通知订阅者。
 *
 * 关 = 删键（不留 `off` 残值，与本仓布尔偏好同一口径）；写不进去（隐私模式 / 配额满）
 * 静默降级为"本次会话不生效"，但**绝不抛进渲染链**。
 */
export function setKojo2CutoverEnabled(on: boolean): void {
  const s = storage();
  if (s) {
    try {
      if (on) s.setItem(KOJO2_CUTOVER_KEY, 'on');
      else s.removeItem(KOJO2_CUTOVER_KEY);
    } catch {
      /* 隐私模式 / 配额满：只丢掉这一次选择，不抛 */
    }
  }
  for (const listener of listeners) listener();
}

/** 订阅开关变化（返回取消订阅函数；组件卸载时必须取消） */
export function subscribeKojo2Cutover(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
