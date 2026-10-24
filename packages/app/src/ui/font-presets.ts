/**
 * 字体档位表单一真源（视觉批十二 L20：「代码字体与界面字体各有多档可选」）。
 *
 * 分工：`code-font.ts` 仍是**缺省档**那条栈与其护栏（`isUsableCodeFontStack` /
 * `CODE_FONT_CSS_LINE` 闸）的真源；本文件在它之上登记"可选项"。两侧都不许另抄栈字符串。
 *
 * 三条硬口径（照 `code-font.ts` 文件头的不变式，每一档都得过）：
 * 1. **拉丁头 → CJK 尾 → 末位泛型**。中文面自带的半比例拉丁会接管前段（位置反了整套等宽就废），
 *    所以 CJK 成员一律排在全部拉丁成员之后——`font-presets.test.ts` 按名单逐档核对。
 * 2. 代码栈末位必须 `monospace`（`isUsableCodeFontStack`：空家族 = 整条声明失效）；
 *    UI 栈末位 `sans-serif`（`mono` 档例外——它吃所选代码栈，末位天然 `monospace`）。
 * 3. `custom` 档 `stack` 恒为空串：**真值在偏好里**（代码侧 = `fontFamily`，UI 侧 = `uiFontFamily`），
 *    不许把自定义吃进表里，也不许让表替自定义保管栈。
 *
 * 兼容红线（回归判据）：老用户存过非空 `fontFamily` 自由文本 ⇒ 它赢（`resolveCodeFontStack`
 * 先看文本再看档位 id）。档位选择是新加的一层，不是对旧口径的覆盖。
 */

import { CODE_FONT_STACK, isUsableCodeFontStack } from './code-font';

export interface FontPreset {
  readonly id: string;
  /** 作者面叫法（设置页 radio 文案） */
  readonly label: string;
  /** 完整 CSS 栈；`custom` 档恒为空串（真值在偏好里） */
  readonly stack: string;
  /** 一句话理由（设置页 hint 文案） */
  readonly note: string;
}

/** 代码档自定义的登记 id（`custom` = 吃 `fontFamily` 那条自由文本，语义与旧版逐字相同） */
export const CUSTOM_CODE_FONT_PRESET_ID = 'custom';
/** 界面档自定义的登记 id（吃 `uiFontFamily`） */
export const CUSTOM_UI_FONT_PRESET_ID = 'custom';

/**
 * 界面字体的现状栈：`tokens.css` 基础 `:root` 那行 `font-family` 的字面（逐字）。
 * `UI_FONT_CSS_LINE` 是它的闸——`font-presets.test.ts` 去 tokens.css 里逐字找，
 * 改一处必改两处（同 `CODE_FONT_CSS_LINE` 之于 styles/tokens 的 `--font-code`）。
 */
export const UI_FONT_SYSTEM_STACK =
  "'Segoe UI', 'Microsoft YaHei UI', 'Noto Sans CJK SC', sans-serif";

export const UI_FONT_CSS_TOKEN = '--font-ui';
export const UI_FONT_CSS_LINE = `${UI_FONT_CSS_TOKEN}: ${UI_FONT_SYSTEM_STACK};`;

/** 代码字体档位（含自定义共六档） */
export const CODE_FONT_PRESETS: readonly FontPreset[] = [
  {
    id: 'default',
    label: '均衡（内置）',
    stack: CODE_FONT_STACK,
    note: 'Cascadia 系打头、Era Mono SC 收尾的现缺省栈，缺哪张跳哪张',
  },
  {
    id: 'sarasa',
    label: '更纱黑体等宽',
    stack: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Sarasa Term SC', 'Microsoft YaHei', SimHei, monospace",
    note: 'Cascadia + Sarasa Term SC：更纱严格 2:1 全角，网格最稳',
  },
  {
    id: 'jbmono-noto',
    label: 'JetBrains + 思源等宽',
    stack: "'JetBrains Mono', Consolas, 'Noto Sans Mono CJK SC', 'Microsoft YaHei', SimHei, monospace",
    note: 'JetBrains Mono 打头、Noto Sans Mono CJK SC 收尾（两张都免安装费）',
  },
  {
    id: 'lxgw',
    label: '霞鹜等宽',
    stack: "'Cascadia Mono', Consolas, 'LXGW Console Mono', 'LXGW WenKai Mono', 'Microsoft YaHei', SimHei, monospace",
    note: '拉丁头喂 Cascadia/Consolas，霞鹜两名单收（Console Mono / WenKai Mono 都认）管汉字，口上作者常装',
  },
  {
    id: 'system',
    label: '系统零安装',
    stack: "Consolas, 'Microsoft YaHei UI', 'Microsoft YaHei', SimHei, monospace",
    note: 'Consolas + 雅黑 + SimHei：Windows 必装组合，一台新机器也不缺字',
  },
  {
    id: CUSTOM_CODE_FONT_PRESET_ID,
    label: '自定义',
    stack: '',
    note: '手打字体名（旧口径原样保留，非空时说了算）',
  },
];

/** 界面字体档位（含自定义共五档） */
export const UI_FONT_PRESETS: readonly FontPreset[] = [
  {
    id: 'system',
    label: '系统（现状）',
    stack: UI_FONT_SYSTEM_STACK,
    note: 'Segoe UI + 雅黑 UI：本来的样子，选它 = 一位都不覆写',
  },
  {
    id: 'source-han',
    label: '思源黑体',
    stack: "'Noto Sans SC', 'Source Han Sans SC', 'Microsoft YaHei UI', sans-serif",
    note: 'Noto Sans SC / 思源黑体优先，中文界面字重更整',
  },
  {
    id: 'pingfang',
    label: '苹方',
    stack: "'PingFang SC', 'Segoe UI', 'Microsoft YaHei UI', sans-serif",
    note: 'PingFang SC 打头（Mac 味），Windows 上自动落到 Segoe/雅黑',
  },
  {
    id: 'mono',
    label: '等宽（跟随代码字体）',
    // 表内值是缺省代码栈的代表；生效时 `resolveUiFontStack` 现取所选代码栈
    stack: CODE_FONT_STACK,
    note: '界面文字跟随所选代码字体，全等宽控选这档',
  },
  {
    id: CUSTOM_UI_FONT_PRESET_ID,
    label: '自定义',
    stack: '',
    note: '手打界面字体名（自动补 sans-serif 兜底）',
  },
];

export const CODE_FONT_PRESET_IDS: readonly string[] = CODE_FONT_PRESETS.map((p) => p.id);
export const UI_FONT_PRESET_IDS: readonly string[] = UI_FONT_PRESETS.map((p) => p.id);

/** 解析所需的最小偏好面（避免与 `editor-display-prefs.ts` 成循环依赖） */
export interface CodeFontPrefs {
  readonly fontFamily: string;
  readonly codeFontPreset: string;
}

export interface UiFontPrefs extends CodeFontPrefs {
  readonly uiFontFamily: string;
  readonly uiFontPreset: string;
}

export interface ResolvedFontStack {
  /** 生效栈（一定可用：代码侧过 `isUsableCodeFontStack`，界面侧过 `isUsableUiFontStack`） */
  readonly stack: string;
  /** 实际生效的档位 id（恒在册）——设置页"当前生效哪档"就看它，不许静默换栈 */
  readonly presetId: string;
  /** 用户存的原始档位 id（可能与生效的不同；回落事实由 `presetId !== requestedPresetId` 读出） */
  readonly requestedPresetId: string;
  /** 回落 = 生效档位不是请求档位（id 不认识的兜底与旧自定义覆盖都算，UI 要能看出来） */
  readonly fellBack: boolean;
}

function findPreset(presets: readonly FontPreset[], id: string): FontPreset | undefined {
  return presets.find((p) => p.id === id);
}

function fallbackToDefaultCode(requested: string): ResolvedFontStack {
  return { stack: CODE_FONT_STACK, presetId: 'default', requestedPresetId: requested, fellBack: true };
}

/**
 * 代码栈解析（生效链唯一入口）：
 * ① 非空 `fontFamily`（老用户 / 自定义档）说了算——兼容红线，不许把自定义吃掉；
 * ② `custom` 档但文本为空 ⇒ 回落 `default` 并标记 `fellBack`（可见，不是静默换栈）；
 * ③ 档位 id 不认识 ⇒ 回落 `default` 并标记 `fellBack`；
 * ④ 表内栈过不了护栏（理论不该发生，闸在测试里）⇒ 同样回落 `default`。
 */
export function resolveCodeFontStack(prefs: CodeFontPrefs): ResolvedFontStack {
  const requested = typeof prefs.codeFontPreset === 'string' ? prefs.codeFontPreset : 'default';
  const customText = typeof prefs.fontFamily === 'string' ? prefs.fontFamily.trim() : '';
  if (customText !== '') {
    const usable = isUsableCodeFontStack(prefs.fontFamily) ? prefs.fontFamily : CODE_FONT_STACK;
    return {
      stack: usable,
      presetId: 'custom',
      requestedPresetId: requested,
      fellBack: requested !== CUSTOM_CODE_FONT_PRESET_ID || usable !== prefs.fontFamily,
    };
  }
  if (requested === CUSTOM_CODE_FONT_PRESET_ID) {
    // 选了自定义却没填字：不猜，回落内置并让它可见
    return fallbackToDefaultCode(requested);
  }
  const preset = findPreset(CODE_FONT_PRESETS, requested);
  if (!preset || preset.stack === '' || !isUsableCodeFontStack(preset.stack)) {
    return fallbackToDefaultCode(requested);
  }
  return { stack: preset.stack, presetId: preset.id, requestedPresetId: requested, fellBack: false };
}

/** 泛型末位判定：sans-serif / serif / monospace 三个泛型关键字（大小写不敏感） */
const GENERIC_FAMILIES = new Set(['sans-serif', 'serif', 'monospace']);

/** UI 栈可用性：成员无空位 + 末位是泛型（同 `isUsableCodeFontStack` 的"空家族整条失效"理由） */
export function isUsableUiFontStack(stack: string): boolean {
  if (stack.trim() === '') return false;
  const members = stack.split(',');
  if (members.some((m) => m.trim() === '')) return false;
  const last = members.at(-1)?.trim().toLowerCase();
  return last !== undefined && GENERIC_FAMILIES.has(last);
}

/**
 * UI 自定义栈清洗（口径与 `sanitizeFontFamily` 对称）：空 = 用档位；否则去空成员、
 * 缺泛型补 `sans-serif`，半坏栈一律回落空串（= 不生效，宁可这次自定义不算数也不喂坏值）。
 */
export function sanitizeUiFontFamily(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const members = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (members.length === 0) return '';
  const last = members.at(-1)!.toLowerCase();
  if (!GENERIC_FAMILIES.has(last)) members.push('sans-serif');
  const stack = members.join(', ');
  return isUsableUiFontStack(stack) ? stack : '';
}

/** 界面栈解析：`mono` 档现取所选代码栈；自定义吃 `uiFontFamily`；未知 id 回落 `system` */
export function resolveUiFontStack(prefs: UiFontPrefs): ResolvedFontStack {
  const system = (): ResolvedFontStack => ({
    stack: UI_FONT_SYSTEM_STACK,
    presetId: 'system',
    requestedPresetId: typeof prefs.uiFontPreset === 'string' ? prefs.uiFontPreset : 'system',
    fellBack: true,
  });
  const requested = typeof prefs.uiFontPreset === 'string' ? prefs.uiFontPreset : 'system';
  if (requested === CUSTOM_UI_FONT_PRESET_ID) {
    const custom = typeof prefs.uiFontFamily === 'string' ? prefs.uiFontFamily.trim() : '';
    if (custom !== '' && isUsableUiFontStack(prefs.uiFontFamily)) {
      return { stack: prefs.uiFontFamily, presetId: 'custom', requestedPresetId: requested, fellBack: false };
    }
    return system();
  }
  if (requested === 'mono') {
    // 跟随代码字体：代码侧解析已经保证可用（末位 monospace）
    const code = resolveCodeFontStack(prefs);
    return { stack: code.stack, presetId: 'mono', requestedPresetId: requested, fellBack: false };
  }
  const preset = findPreset(UI_FONT_PRESETS, requested);
  if (!preset || preset.stack === '' || !isUsableUiFontStack(preset.stack)) return system();
  return { stack: preset.stack, presetId: preset.id, requestedPresetId: requested, fellBack: false };
}

/* ---------------------------- 可用性判定（可注入替身） ---------------------------- */

/** 判定替身：吃 CSS `font` 简写串（如 `16px "Cascadia Code"`），返回本机是否存在该面 */
export type FontPresenceChecker = (fontSpec: string) => boolean;

/** 栈成员拆名（去引号、去空白；泛型关键字也返回，由调用方过滤） */
export function fontStackMembers(stack: string): string[] {
  return stack
    .split(',')
    .map((m) => m.trim().replace(/^['"]|['"]$/g, ''))
    .filter((m) => m !== '');
}

/** 栈里的具体家族名（排除泛型关键字——泛型永远"存在"，标了是噪声） */
export function fontStackConcreteMembers(stack: string): string[] {
  return fontStackMembers(stack).filter((m) => !GENERIC_FAMILIES.has(m.toLowerCase()));
}

export interface FontPresenceEntry {
  readonly family: string;
  readonly present: boolean;
}

/**
 * 逐成员可用性（不静默口径的实现处）：返回每个具体家族的在册与否。
 * `checker` 拿不到（node 测试 / 老壳没有 `document.fonts`）⇒ 返回 `null` = **无法判定**，
 * UI 必须显示"判定不了"而不是"都装了"。
 */
export function checkFontStackPresence(
  stack: string,
  checker: FontPresenceChecker | null = domFontPresenceChecker(),
): FontPresenceEntry[] | null {
  if (checker === null) return null;
  return fontStackConcreteMembers(stack).map((family) => {
    try {
      return { family, present: checker(`16px "${family}"`) };
    } catch {
      // 判定本身抛错 = 判定不了这一枚，标成存在会撒谎，标成缺失会误报——按"存在"跳过标注，
      // 但整表仍返回（口径：判定失败不影响兜底栈本身生效）
      return { family, present: true };
    }
  });
}

/** 真壳判定源：`document.fonts.check`。没有 DOM 或该 API ⇒ `null`（调用方据此显示"判定不了"） */
export function domFontPresenceChecker(): FontPresenceChecker | null {
  if (typeof document === 'undefined') return null;
  const faceSets = (document as Document & { fonts?: { check?(font: string): boolean } }).fonts;
  if (!faceSets || typeof faceSets.check !== 'function') return null;
  return (fontSpec: string) => faceSets.check!(fontSpec);
}

/** 所见即所得预览样例：全角百分号 + 全角空格 + 中日汉字 + 常被连字糊掉的符号串 */
export const FONT_PREVIEW_SAMPLE = '@KOJO_無個性 霊夢 100％　ＡＢＣ != -> ::';
