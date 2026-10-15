/**
 * 「保存时整理空白」偏好（E2，2026-10-15 格式化批）：零 React 纯逻辑，可单测。
 *
 * 存法照 `motion-pref.ts` 先例 —— localStorage + 设置页一个开关，**不新造第二套偏好机制**。
 *
 * ## 默认关
 *
 * 本仓既定口径「新功能默认关」，这里还多一条领域理由：格式化重写的正是**空白**，
 * 而作者可能拿 TAB / 4 空格 / 全角空格的混用来做注释对齐（语料里全角空格 1.54% 的行
 * 全是行中有意的排版）。保存这个动作每天都在发生，默认开启等于把没做错的事反复重写。
 *
 * ## 真源只有一份：localStorage，保存链路每次现读
 *
 * 设置页只写值 + 持有渲染用的镜像；`savePath` 落盘前现读一次。于是"刚翻的开关"与
 * "编辑器闭包里的旧值"不可能不一致（与 `direct-mode` / `sealed` 同一条读取路径）。
 */

/** 偏好键（localStorage） */
const PREF_KEY = 'kojo.ui.formatOnSave.v1';

/** 存进 localStorage 的两个取值（布尔在存储里是字符串，此处收口） */
const ON = 'on';

/** 缺省 = 关（见模块头「默认关」） */
export const FORMAT_ON_SAVE_DEFAULT = false;

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响保存） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读偏好（只有明确存过 `on` 才算开；读不到 / 抛错一律回默认，绝不抛到保存链路） */
export function loadFormatOnSavePref(): boolean {
  const s = storage();
  if (!s) return FORMAT_ON_SAVE_DEFAULT;
  try {
    return s.getItem(PREF_KEY) === ON;
  } catch {
    return FORMAT_ON_SAVE_DEFAULT;
  }
}

/** 写偏好（写不进去不算错：只影响下次保存是否整理，不影响本次） */
export function saveFormatOnSavePref(on: boolean): void {
  const s = storage();
  if (!s) return;
  try {
    if (on) s.setItem(PREF_KEY, ON);
    else s.removeItem(PREF_KEY);
  } catch {
    /* 隐私模式 / 配额满：静默降级为"本次会话按默认关" */
  }
}
