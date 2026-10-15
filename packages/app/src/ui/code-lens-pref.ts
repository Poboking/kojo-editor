/**
 * 「标注函数被谁调用」偏好（B8，2026-10-16 行内注解批）：零 React 纯逻辑，可单测。
 *
 * 存法照 `format-pref.ts` / `motion-pref.ts` 先例——localStorage + 设置页一个开关，
 * **不新造第二套偏好机制**。
 *
 * ## 默认关（本仓"新功能默认关"口径，这里还多一条领域理由）
 *
 * 这条能力**往正文里插行**：一条注解在 Monaco 里就是一个 view zone，作者打开开关的那一
 * 瞬间，屏幕上的正文行高就变了。真实语料给的**最坏观感**是 20.0% 的行插着注解
 * （过得了预算的 3,825 篇里最密的一份），单篇最多 **163 条**——不是花屏，但整屏的
 * 行位会挪动。这种量级的视觉冲击不能靠"读者自己承担"，必须让他主动来要。
 *
 * ## 真源只有一份：localStorage；编辑器和设置页各读各的
 *
 * 编辑器在**每次供给注解**时现读（`EditorPane` 的 resolve 判据），设置页只写值 + 持有一份
 * 渲染用的镜像，并广播一次 `editor.codeLens.set` 让 Monaco 把 `codeLens` 选项翻过去
 * （不推就当场看不见——理由写在 `plugin-api/events.ts` 那条事件的注释里）。
 * 两边读的都是同一把 localStorage，所以不存在"旧镜像"。
 */

/** 偏好键（localStorage） */
const PREF_KEY = 'kojo.ui.codeLens.v1';

/** 存进 localStorage 的取值（布尔在存储里是字符串，此处收口；关 = 不占键位） */
const ON = 'on';

/** 缺省 = 关（见上方「默认关」） */
export const CODE_LENS_DEFAULT = false;

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响编辑器） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读偏好（只有明确存过 `on` 才算开；读不到 / 抛错一律回默认，绝不抛到渲染链） */
export function loadCodeLensPref(): boolean {
  const s = storage();
  if (!s) return CODE_LENS_DEFAULT;
  try {
    return s.getItem(PREF_KEY) === ON;
  } catch {
    return CODE_LENS_DEFAULT;
  }
}

/** 写偏好（写不进去不算错：最多是下次开会回到默认） */
export function saveCodeLensPref(on: boolean): void {
  const s = storage();
  if (!s) return;
  try {
    if (on) s.setItem(PREF_KEY, ON);
    else s.removeItem(PREF_KEY);
  } catch {
    /* 隐私模式 / 配额满：静默降级为"本次会话按默认关" */
  }
}
