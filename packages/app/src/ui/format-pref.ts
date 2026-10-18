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

/* ==========================================================================================
 * 格式化规则开关（P2-14，additive）
 *
 * 上面的老键只回答「保存时要不要整理」这一个布尔；本批把**整理规则本身**从"全开、零可配"
 * 扩成两条逐条可关的开关（全角空格折算 / 缩进归一），规则本体在
 * `packages/plugins/kojo-sugar/src/formatter.ts` 的 `FormatRuleOptions`（缺省全开 ⇒
 * 不传与传"全开"逐字等价），这里只是它的偏好面。读方（手动整理的组请求、保存链路
 * 落盘前）都以 {@link loadFormatRulesPref} **现读**，没有第二份缓存可漂。
 *
 * ## 为什么是新键而不是往老键里塞
 *
 * 老键的值域是**单字符串 `'on'`**（读取口径 `=== 'on'`），而它的读取方
 * （`EditorPane.savePath` 的保存链路、`ShellLayout` 的设置镜像）都是**既有调用点**，
 * 本批一个都不动——往里塞第二份语义就等于改它们的口径。所以规则开关住**独立的 JSON 键**，
 * 老键照旧只管总开关，两键互不知晓：additive 的标准做法（键缺席 = 全部默认）。
 *
 * ## 兼容口径（老用户零感知）
 *
 * 新键**不存在** ⇒ 两条规则都算**开**——已存 `on` 的老用户、以及从没动过设置的用户，
 * 读到的规则与今天的格式化行为逐字一致。只有显式把某条关掉的用户才会长出新键。
 * ======================================================================================== */

/** 规则开关的 localStorage 键（JSON：`{"fullWidthSpace":bool,"indent":bool}`） */
const RULES_KEY = 'kojo.ui.formatRules.v1';

/** 两条格式化规则的开关（字段名与插件的 `FormatRuleOptions` 逐字对应，结构相容直传） */
export interface FormatRules {
  /** 全角空格折算（行首缩进 U+3000 → 2 半角、注释区 → 1 半角）；关 = U+3000 原样保留 */
  fullWidthSpace: boolean;
  /** 缩进归一（仅 .kojo 糖行：行首空白按单位 × 层级重排）；关 = 行首空白一字不动 */
  indent: boolean;
}

/** 缺省 = 两条全开（与"规则开关出现之前"的格式化行为逐字等价） */
export const FORMAT_RULES_DEFAULT: FormatRules = { fullWidthSpace: true, indent: true };

/** 只信布尔：JSON 里缺字段 / 脏值一律落回该条的默认（开）——半份键不是半份行为 */
function asBool(v: unknown): boolean {
  return typeof v === 'boolean' ? v : true;
}

/**
 * 读规则开关（node / 隐私模式 / 键缺席 / JSON 脏 ⇒ 缺省全开，绝不抛）。
 * **每次现读**：格式化 provider 与设置页都以本函数取值，没有第二份缓存可漂移。
 */
export function loadFormatRulesPref(): FormatRules {
  const s = storage();
  if (!s) return { ...FORMAT_RULES_DEFAULT };
  try {
    const raw = s.getItem(RULES_KEY);
    if (raw === null) return { ...FORMAT_RULES_DEFAULT };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...FORMAT_RULES_DEFAULT };
    const o = parsed as Record<string, unknown>;
    return { fullWidthSpace: asBool(o.fullWidthSpace), indent: asBool(o.indent) };
  } catch {
    return { ...FORMAT_RULES_DEFAULT };
  }
}

/**
 * 写规则开关（与 `saveFormatOnSavePref` 同一存储纪律）：**两条全开 = 清键**（存储里不留
 * "默认"的第二种写法，键缺席语义恒为全开）；写不进去不算错，只影响下次整理的读数。
 */
export function saveFormatRulesPref(rules: FormatRules): void {
  const s = storage();
  if (!s) return;
  try {
    if (rules.fullWidthSpace && rules.indent) s.removeItem(RULES_KEY);
    else s.setItem(RULES_KEY, JSON.stringify({ fullWidthSpace: !!rules.fullWidthSpace, indent: !!rules.indent }));
  } catch {
    /* 隐私模式 / 配额满：静默降级为"本次会话按内存值走" */
  }
}
