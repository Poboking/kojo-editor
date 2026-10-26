/**
 * 编辑器显示偏好（用户反馈批，2026-10-19）：行高 / 空白符 / 缩略图 / 行号 / 字体族 / 行内提示。
 *
 * 零 React 纯逻辑（localStorage + 订阅表），存法照 `layout-pref.ts` / `motion-pref.ts` 先例，
 * **不新造第二套偏好机制**。设置页与常驻壳层都经 `useSyncExternalStore` 读同一份快照：
 * 设置页一改，EditorPane 的订阅回调立刻把补丁 `updateOptions` 下去，无需重开文件。
 *
 * 与体量档的关系（`editor-options.ts` 是体量轴唯一真源，本模块**不改档位表**）：
 * - `minimap`（C-1b 起三态）：`off` = 永远关；`on` = small/large 开、huge 仍关
 *   （99 万行档的那一刀不因偏好回退）；`follow`（**新缺省**）= 只在「小体量 + 不是 `.kojo`
 *   正文 + 不是 `.kojo` 预览投影」时画——中日文台词正文里那条纵览是一竖彩色噪点，
 *   长文导航本来就该靠大纲与「转到行」。判据只看**此刻屏幕上的那份文档**（调用方给上下文）。
 * - `inlayHints` 同理：用户关掉 = 永远关；开着时大文件仍由 provider 侧的
 *   `inlayHintsAffordable` 让路（本模块不越过那条判据）。
 * - 行高 / 空白符 / 行号 / 字体族与体量正交，用户值直接生效。
 *
 * 字体族**不进 `editorOptionsForLineCount`**（`code-font.ts` 的不变式：降级集永不含字体键）：
 * 它只在 create 路径与偏好变更时 `updateOptions`，与 `CODE_FONT_BASELINE` 同一条轴。
 *
 * ## 行高存的是**字号倍数**，不是 px（C2，2026-10-26 阅读面批）
 *
 * 改前缺省 `lineHeight: 0` = 交给 Monaco 自动算，实测 **19px**（Windows 的 GOLDEN 比
 * 1.35 × 14px）——那是给拉丁字母排的疏密，中日文台词读起来"行行粘连"。现在缺省 1.5
 * （14px ⇒ **21px**），并给三档：紧凑 1.35（= 老自动值 19px）/ 舒适 1.5（21px）/ 宽松 1.7（24px）。
 *
 * **为什么是倍数而不是固定 px**：Monaco 的 `lineHeight` 本来就吃两段语义
 * （`fontInfo.js` 的 `BareFontInfo._create`：`0` ⇒ 按字号算；`0 < v < 8` ⇒ v × 字号；
 * `v ≥ 8` ⇒ 绝对像素，`EditorFloatOption.clamp(0, 150)`）。存倍数的直接收益是**跟字号走**：
 * 正文字号偏好 10–28px（`font-size-pref.ts`），固定 21px 在字号 24px 时只有 0.88 行——
 * 字放大、行贴死，而偏好订阅回调**不会**因为改字号重发显示补丁（`use-editor-preferences`
 * 的 `fontSizeUnsub` 只管字号与缩放两条轴），写死像素等于给"放大正文"埋一颗雷。
 * 倍数由 Monaco 自己乘字号，改字号当场生效，零接线。
 *
 * **盘上三态并存**（`sanitizeLineHeight` 的合法域就是 Monaco 那一套）：
 * - 老盘里的绝对像素（18/20/22/24/28，当年手选的）**原样保留**，渲染逐像素不变；
 *   这批作者在设置页看到的三档全不亮，点一下任选一档即迁到倍数口径；
 * - 老盘里的 `0`（旧缺省的"自动"）**一次性解释成 1.5**。判据：`write()` 每次落盘都会把
 *   当时的行高镜像进这一格（改任意一项显示偏好都会写 `0`），所以盘上的 `0` 分不清
 *   "从没选过"与"特意选了自动"——按"没选过"处理，让老作者也吃到 CJK 行距；
 * - 界面上不再提供"自动"：它在 Windows 上就是 1.35×，与「紧凑」档逐像素等价，两格并一格。
 *
 * ## `uiFontScale`（C-1b）：界面字号缩放——它**不是 Monaco 选项**
 *
 * 这一位管的是**外壳文字**（标签页、面板标题、树行、设置页），走 CSS 自定义属性
 * `--fs-*`；编辑器正文字号另有真源（`font-size-pref.ts` 的 `fontSize` / `zoomLevel`），
 * 两条轴互不覆写。生效路径照 `theme-pref.ts` / `motion-pref.ts` 那一套：值落根元素的
 * **行内声明**，由样式表的 `:root` 那份基线让位（行内 > 任何作者样式规则）。
 *
 * 基线值**不在本模块抄一份表**：写入前先摘掉自己那几位，再从计算样式读回 `--fs-*` 的现值
 * 按倍率取整（`--fs-0` 将来在 CSS 里改成 12px，这里自然跟着变）。缺省 100% 时几位行内声明
 * 全部摘除 ⇒ 没动过这一项的作者，界面逐字不变。三主题不覆写 `--fs-*`（真源只在基线 `:root`），
 * 减动效那条链也不吃字号 ⇒ 两档都不受影响。
 *
 * 覆盖面（实测口径，别把它说成"整个界面都放大"）：全量样式表 344 条 `font-size` 里 325 条走
 * `--fs-*` ⇒ 这一档盖住界面文字的绝大多数；余下 19 条是图标格与个别数字格的字面量，不参与缩放。
 * 编辑区内的一切字号仍由 Monaco 的 `fontSize` / `zoomLevel` 管（`font-size-pref.ts`），两轴零交集。
 *
 * **为什么这里一行 CSS 都不写**（免得下一批"顺手补上"）：`styles.css` 是轻档、`styles-project.css`
 * 是全量副本，两者由 `tests/styles-split.equivalence.test.ts` 的 A 闸钉成"轻档行序列 ⊆ 重档行序列"
 * ——往轻档加一行新规则（`:root[data-ui-scale=…] { --fs-0: … }`）而重档没有同一行，当场红。
 * 行内声明这条路口子不用碰、两条闸都不用动，而且 `--fs-*` 的数值真源仍然只在 CSS 一处。
 */

import { useSyncExternalStore } from 'react';
import { isUsableCodeFontStack, CODE_FONT_CSS_TOKEN, CODE_FONT_STACK } from './code-font';
import {
  CODE_FONT_PRESET_IDS,
  UI_FONT_PRESET_IDS,
  UI_FONT_CSS_TOKEN,
  UI_FONT_SYSTEM_STACK,
  resolveCodeFontStack,
  resolveUiFontStack,
  sanitizeUiFontFamily,
} from './font-presets';
import { editorProfileTierForLineCount, type EditorOptionPatch } from './editor-options';

/** Monaco `renderWhitespace` 的登记值（0.57 d.ts 逐字照抄，不另造词汇） */
export type RenderWhitespacePref = 'none' | 'boundary' | 'selection' | 'trailing' | 'all';

/** Monaco `lineNumbers` 的登记值 */
export type LineNumbersPref = 'on' | 'off' | 'relative' | 'interval';

/**
 * 缩略图（C-1b 三态）：
 * - `off` 永远不画；
 * - `on` 画，但 huge 档那一刀照旧（体量档是真源，偏好不许把它翻回来）；
 * - `follow`（缺省）只在「小体量 + `.kojo` 正文之外 + 预览投影之外」画。
 *
 * 联合里刻意不出现布尔：旧版布尔值由 {@link normalizeMinimapPref} 在清洗层翻成 `on`/`off`，
 * 老用户读盘即恢复自己当年的选择，不需要他们重做一遍。
 */
export type MinimapPref = 'follow' | 'on' | 'off';

/** 界面字号缩放（%）：三档离散值，不做自由输入——自由值会让取整后相邻两档看起来一样 */
export type UiFontScalePref = 100 | 110 | 125;

/** 行高三档（值 = Monaco `lineHeight` 的字号倍数；14px 字号下的实际行高写在注释里） */
export type LineHeightPresetId = 'compact' | 'comfortable' | 'loose';

/**
 * 行高三档（**设置页与缺省值的同一真源**，UI 不另抄一份数字）：
 * 1.35 ⇒ 19px（Windows 上 Monaco 的自动值，即改造前的观感）/ 1.5 ⇒ 21px / 1.7 ⇒ 24px。
 * 上界刻意不到 2.0：1.7 已是"宽"，再宽一行就散，读口上反而更容易串行。
 */
export const LINE_HEIGHT_PRESETS: readonly {
  readonly id: LineHeightPresetId;
  readonly value: number;
  readonly label: string;
}[] = [
  { id: 'compact', value: 1.35, label: '紧凑' },
  { id: 'comfortable', value: 1.5, label: '舒适' },
  { id: 'loose', value: 1.7, label: '宽松' },
];

/** 缺省行高（= 「舒适」档）：CJK 正文的 1.5× */
export const LINE_HEIGHT_DEFAULT = 1.5;

/**
 * 缩略图「跟随」档要问的两条判据（都关于**此刻屏幕上那份文档**，与行数正交）：
 * - `preview`：挂的是 `.kojo` 预览投影（派生只读文本，通读的是原文不是它）；
 * - `kojoText`：文件本身是 `.kojo` 口上正文（台词为主，缩略图只剩一竖噪点）。
 */
export interface MinimapViewContext {
  readonly preview?: boolean;
  readonly kojoText?: boolean;
}

export interface EditorDisplayPrefs {
  /**
   * 行高：**字号倍数**（0 < v < 8）或绝对像素（8–150），语义与 Monaco 的 `lineHeight` 逐字一致。
   * 缺省 {@link LINE_HEIGHT_DEFAULT} = 1.5（14px 字号 ⇒ 21px）。见文件头「行高存的是字号倍数」。
   */
  readonly lineHeight: number;
  readonly renderWhitespace: RenderWhitespacePref;
  /** 缩略图三态（`on` 时仍受体量档约束；`follow` 还受 {@link MinimapViewContext} 约束） */
  readonly minimap: MinimapPref;
  readonly lineNumbers: LineNumbersPref;
  /** 自定义字体族；空串 = 用档位表解析出的栈（L20 之前 = 用 `CODE_FONT_STACK`）。非空时**它赢**（兼容红线） */
  readonly fontFamily: string;
  /** 代码字体档位 id（`font-presets.ts` 在册；未知 id 读盘即回落 `default`） */
  readonly codeFontPreset: string;
  /** 界面字体档位 id（`system` / `source-han` / `pingfang` / `mono` / `custom`） */
  readonly uiFontPreset: string;
  /** 界面字体自定义栈；空串 = 用档位（`custom` 档选而栈空 ⇒ 回落 `system` 且可见） */
  readonly uiFontFamily: string;
  /** 行内提示总开关（true 时仍受体量档约束） */
  readonly inlayHints: boolean;
  /** 界面外壳文字缩放（%）；100 = 样式表现值，一位都不覆写 */
  readonly uiFontScale: UiFontScalePref;
}

export const EDITOR_DISPLAY_PREF_DEFAULT: EditorDisplayPrefs = {
  lineHeight: LINE_HEIGHT_DEFAULT,
  renderWhitespace: 'none',
  minimap: 'follow',
  lineNumbers: 'on',
  fontFamily: '',
  codeFontPreset: 'default',
  uiFontPreset: 'system',
  uiFontFamily: '',
  inlayHints: true,
  uiFontScale: 100,
};

const LINE_HEIGHT_KEY = 'kojo.ui.editor.lineHeight.v1';
const RENDER_WHITESPACE_KEY = 'kojo.ui.editor.renderWhitespace.v1';
/** 旧版布尔缩略图键（'1'/'0'）：仍读（老用户恢复自己的选择）、仍镜像写（旧版本回滚也认） */
const MINIMAP_KEY = 'kojo.ui.editor.minimap.v1';
/** 三态缩略图键（'follow'/'on'/'off'）：新真源，缺席时回落到上面那把旧尺子 */
const MINIMAP_MODE_KEY = 'kojo.ui.editor.minimapMode.v1';
const LINE_NUMBERS_KEY = 'kojo.ui.editor.lineNumbers.v1';
const FONT_FAMILY_KEY = 'kojo.ui.editor.fontFamily.v1';
/** 代码字体档位（L20）：新加的一层；旧 `fontFamily` 文本仍是自定义档的真值（兼容红线） */
const CODE_FONT_PRESET_KEY = 'kojo.ui.editor.codeFontPreset.v1';
/** 界面字体档位与自定义栈（L20）：真源在 `font-presets.ts` 的档位表 */
const UI_FONT_PRESET_KEY = 'kojo.ui.editor.uiFontPreset.v1';
const UI_FONT_FAMILY_KEY = 'kojo.ui.editor.uiFontFamily.v1';
const INLAY_HINTS_KEY = 'kojo.ui.editor.inlayHints.v1';
const UI_FONT_SCALE_KEY = 'kojo.ui.editor.uiFontScale.v1';

const RENDER_WHITESPACE_VALUES: readonly RenderWhitespacePref[] = [
  'none',
  'boundary',
  'selection',
  'trailing',
  'all',
];

/** 五档展示序（= Monaco 登记序；状态栏 popover 与设置页同序，不另造词汇） */
export const RENDER_WHITESPACE_CHOICES: readonly RenderWhitespacePref[] = RENDER_WHITESPACE_VALUES;

/** 五档中文标签（状态栏那格与菜单同词；取值就是 Monaco 登记值，落 Monaco 前零翻译） */
export const RENDER_WHITESPACE_LABELS: Record<RenderWhitespacePref, string> = {
  none: '不显示',
  boundary: '边界处',
  selection: '仅选区',
  trailing: '仅行尾',
  all: '全部',
};

/**
 * 空白符命令的切向（`workbench.toggleRenderWhitespace`）：`none ↔ all` 两态翻转，
 * 其余档（boundary / selection / trailing）按**非 none** 处理 ⇒ 落到 `none`。
 * 细粒度档（哪一处显示）留给状态栏 / 设置页的五档选择，命令只当"一眼看懂的总开关"。
 */
export function nextRenderWhitespaceToggle(current: RenderWhitespacePref): RenderWhitespacePref {
  return current === 'none' ? 'all' : 'none';
}
const LINE_NUMBERS_VALUES: readonly LineNumbersPref[] = ['on', 'off', 'relative', 'interval'];
const MINIMAP_VALUES: readonly MinimapPref[] = ['follow', 'on', 'off'];
export const UI_FONT_SCALE_VALUES: readonly UiFontScalePref[] = [100, 110, 125];

/**
 * 界面字号的那几位 token（与 `styles.css` 基础 `:root` 的 `--fs-*` 同一清单）。
 * 这里只登记**名字**，数值一律现读 CSS——本模块不抄第二份字号表。
 */
export const UI_FONT_SCALE_TOKENS: readonly string[] = [
  '--fs-0',
  '--fs-1',
  '--fs-2',
  '--fs-3',
  '--fs-4',
  '--fs-5',
  '--fs-display',
];

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readEnum<T extends string>(raw: string | null | undefined, allowed: readonly T[], fallback: T): T {
  return raw !== undefined && raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * 行高清洗：合法域**就是 Monaco 自己那一套**（`fontInfo.js` 的 `BareFontInfo._create`
 * + `EditorFloatOption.clamp(0, 150)`），落盘值原样是其中一态，读盘不做换算：
 * - `0 < v < 8` ⇒ **字号倍数**（Monaco 的 em 语义；保留两位小数，1.0 是下限——再低行与行就压在一起）；
 * - `8 ≤ v ≤ 150` ⇒ 绝对像素（取整）；
 * - `0` ⇒ **迁到缺省 1.5**（不是"自动"，理由见文件头：盘上的 0 分不清没选过与选了自动，
 *   而界面上已不提供自动档）。负数 / 非有限数 / 非数字串同样回落缺省。
 *
 * 数字串照收（localStorage 里存的就是串，同 `sanitizeUiFontScale` 的口径）；
 * 脏值**回落缺省**而不是回落 0——0 会把上面那条迁移又走一遍，等于没清洗。
 */
export function sanitizeLineHeight(raw: unknown): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return LINE_HEIGHT_DEFAULT;
  if (n === 0) return LINE_HEIGHT_DEFAULT;
  if (n < 8) return Math.min(7.99, Math.max(1, Math.round(n * 100) / 100));
  return Math.min(150, Math.round(n));
}

/**
 * 缩略图取值归一（**向后兼容的唯一入口**）：
 * - 旧版布尔：`true → 'on'`、`false → 'off'`——老用户当年怎么选，今天就怎么显示；
 * - 三态字符串：原样收下；
 * - 其它（脏值 / 缺席）：返回 `null`，由调用方决定回落哪一把尺子（读盘层会继续往下试旧键）。
 */
export function normalizeMinimapPref(raw: unknown): MinimapPref | null {
  if (typeof raw === 'boolean') return raw ? 'on' : 'off';
  if (typeof raw === 'string') {
    const hit = (MINIMAP_VALUES as readonly string[]).includes(raw);
    if (hit) return raw as MinimapPref;
  }
  return null;
}

/** 旧键的 `'1'/'0'` 读法（其余一律 `null` = 这台机器上根本没存过缩略图） */
function legacyMinimapPref(raw: string | null): MinimapPref | null {
  if (raw === '1') return 'on';
  if (raw === '0') return 'off';
  return null;
}

/**
 * 界面字号缩放清洗：只认登记档位（数字或数字串都收，localStorage 里存的是串）；
 * 脏值回落 100 = **不覆写任何 CSS**，与"从没动过这一项"逐字等价。
 */
export function sanitizeUiFontScale(raw: unknown): UiFontScalePref {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return EDITOR_DISPLAY_PREF_DEFAULT.uiFontScale;
  const hit = (UI_FONT_SCALE_VALUES as readonly number[]).includes(n);
  return hit ? (n as UiFontScalePref) : EDITOR_DISPLAY_PREF_DEFAULT.uiFontScale;
}

/**
 * 单个 token 的倍率取整：`'11px' × 1.25 → '14px'`。
 *
 * 只认**纯 px 字面量**——CSS 变量可以写成 `calc(...)`、`em` 或另一枚 var，那些形态一律返回
 * `null` 表示"这一位不覆写"。宁可界面字号这一格保持基线，也不猜一份算错的像素值（铁律 4：
 * 校验不了的就不办，但绝不静默办错）。取整是为了避免出现 13.75px 这种既发虚又难核对的值。
 */
export function scaleFontToken(base: string, ratio: number): string | null {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(base.trim());
  if (!m) return null;
  const px = Number(m[1]);
  if (!Number.isFinite(px) || px <= 0) return null;
  const scaled = Math.round(px * ratio);
  return scaled >= 1 ? `${scaled}px` : null;
}

/** 只用到 `style` 那两位的最小根元素面（node 单测给一枚假对象即可钉死生效路径） */
export interface UiFontScaleRoot {
  readonly style: {
    removeProperty(name: string): void;
    setProperty(name: string, value: string): void;
  };
}

function defaultFontScaleRoot(): UiFontScaleRoot | null {
  if (typeof document === 'undefined') return null;
  return document.documentElement as unknown as UiFontScaleRoot;
}

/** 现读样式表里那一位 token 的计算值（本模块唯一取基线数字的地方，绝不吃硬编码表） */
function computedTokenReader(root: UiFontScaleRoot): (name: string) => string {
  return (name: string): string => {
    try {
      if (typeof getComputedStyle !== 'function') return '';
      return getComputedStyle(root as unknown as Element).getPropertyValue(name);
    } catch {
      return '';
    }
  };
}

/**
 * 把界面字号缩放落到根元素的**行内声明**上（生效路径单源、可单测，照 `applyThemePref` 形态）。
 *
 * 顺序有讲究：**先摘掉自己写的那几位再读基线**——否则第二次缩放会拿上一次的结果当基数，
 * 每翻一档就在已放大的数字上再乘一遍（实测会一路涨到界面糊掉）。摘干净后读回来的就是
 * 样式表 `:root`（以及当前主题）的原值，倍率永远以基线为尺。
 */
export function applyUiFontScalePref(
  scale: UiFontScalePref = loadEditorDisplayPrefs().uiFontScale,
  root: UiFontScaleRoot | null = defaultFontScaleRoot(),
  readToken: (name: string) => string = root ? computedTokenReader(root) : () => '',
): void {
  if (!root) return;
  for (const token of UI_FONT_SCALE_TOKENS) root.style.removeProperty(token);
  const ratio = sanitizeUiFontScale(scale) / 100;
  if (ratio === 1) return; // 100% = 基线原样生效：一位都不写
  for (const token of UI_FONT_SCALE_TOKENS) {
    const scaled = scaleFontToken(readToken(token), ratio);
    if (scaled !== null) root.style.setProperty(token, scaled);
  }
}

/**
 * 字体族清洗：空串 = 用默认栈；否则去空成员、补 `monospace` 兜底并整体校验。
 * 半坏栈（空成员 / 无泛型兜底）一律回落默认栈——`code-font.ts` 实测空串会让
 * Monaco 的度量错位，宁可作者这次自定义不生效，也不喂坏值。
 */
export function sanitizeFontFamily(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const members = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (members.length === 0) return '';
  if (members.at(-1)?.toLowerCase() !== 'monospace') members.push('monospace');
  const stack = members.join(', ');
  return isUsableCodeFontStack(stack) ? stack : '';
}

/** 清洗层入参：全部可选（补丁形态），且 `minimap` 允许是旧布尔（历史调用点与历史落盘值都还在发布尔） */
type PrefsInput = Partial<Omit<EditorDisplayPrefs, 'minimap' | 'uiFontScale'>> & {
  readonly minimap?: unknown;
  readonly uiFontScale?: unknown;
};

function sanitizePrefs(prefs: PrefsInput): EditorDisplayPrefs {
  return {
    lineHeight: sanitizeLineHeight(prefs.lineHeight),
    renderWhitespace: readEnum(prefs.renderWhitespace, RENDER_WHITESPACE_VALUES, EDITOR_DISPLAY_PREF_DEFAULT.renderWhitespace),
    minimap: normalizeMinimapPref(prefs.minimap) ?? EDITOR_DISPLAY_PREF_DEFAULT.minimap,
    lineNumbers: readEnum(prefs.lineNumbers, LINE_NUMBERS_VALUES, EDITOR_DISPLAY_PREF_DEFAULT.lineNumbers),
    fontFamily: sanitizeFontFamily(prefs.fontFamily),
    // 档位 id 只认在册表（脏值回落缺省档）；回落事实由 `resolveCodeFontStack`/`resolveUiFontStack`
    // 在解析层再兜一次（直接喂未清洗 prefs 的调用方也能读出 fellBack）
    codeFontPreset: readEnum(prefs.codeFontPreset, CODE_FONT_PRESET_IDS, EDITOR_DISPLAY_PREF_DEFAULT.codeFontPreset),
    uiFontPreset: readEnum(prefs.uiFontPreset, UI_FONT_PRESET_IDS, EDITOR_DISPLAY_PREF_DEFAULT.uiFontPreset),
    uiFontFamily: sanitizeUiFontFamily(prefs.uiFontFamily),
    inlayHints: prefs.inlayHints !== false,
    uiFontScale: sanitizeUiFontScale(prefs.uiFontScale),
  };
}

let snapshotCache: EditorDisplayPrefs | null = null;

export function loadEditorDisplayPrefs(): EditorDisplayPrefs {
  let fresh: EditorDisplayPrefs;
  const s = storage();
  if (!s) {
    fresh = { ...EDITOR_DISPLAY_PREF_DEFAULT };
  } else {
    try {
      fresh = sanitizePrefs({
        // 没存过 ⇒ 新缺省（1.5）；存过 `0`（旧缺省的自动）⇒ 清洗层按"没选过"迁到 1.5
        lineHeight: Number(s.getItem(LINE_HEIGHT_KEY) ?? String(LINE_HEIGHT_DEFAULT)),
        renderWhitespace: readEnum(
          s.getItem(RENDER_WHITESPACE_KEY),
          RENDER_WHITESPACE_VALUES,
          EDITOR_DISPLAY_PREF_DEFAULT.renderWhitespace,
        ),
        // 三态键优先；缺席时旧布尔键说了算（老用户不会被"跟随"覆盖掉自己的选择）；
        // 两把尺子都没存过 ⇒ 'follow'（新缺省策略）
        minimap:
          normalizeMinimapPref(s.getItem(MINIMAP_MODE_KEY)) ??
          legacyMinimapPref(s.getItem(MINIMAP_KEY)) ??
          EDITOR_DISPLAY_PREF_DEFAULT.minimap,
        lineNumbers: readEnum(
          s.getItem(LINE_NUMBERS_KEY),
          LINE_NUMBERS_VALUES,
          EDITOR_DISPLAY_PREF_DEFAULT.lineNumbers,
        ),
        fontFamily: s.getItem(FONT_FAMILY_KEY) ?? '',
        codeFontPreset: s.getItem(CODE_FONT_PRESET_KEY) ?? EDITOR_DISPLAY_PREF_DEFAULT.codeFontPreset,
        uiFontPreset: s.getItem(UI_FONT_PRESET_KEY) ?? EDITOR_DISPLAY_PREF_DEFAULT.uiFontPreset,
        uiFontFamily: s.getItem(UI_FONT_FAMILY_KEY) ?? '',
        inlayHints: s.getItem(INLAY_HINTS_KEY) !== '0',
        uiFontScale: sanitizeUiFontScale(s.getItem(UI_FONT_SCALE_KEY)),
      });
    } catch {
      fresh = { ...EDITOR_DISPLAY_PREF_DEFAULT };
    }
  }
  if (
    snapshotCache !== null &&
    snapshotCache.lineHeight === fresh.lineHeight &&
    snapshotCache.renderWhitespace === fresh.renderWhitespace &&
    snapshotCache.minimap === fresh.minimap &&
    snapshotCache.lineNumbers === fresh.lineNumbers &&
    snapshotCache.fontFamily === fresh.fontFamily &&
    snapshotCache.codeFontPreset === fresh.codeFontPreset &&
    snapshotCache.uiFontPreset === fresh.uiFontPreset &&
    snapshotCache.uiFontFamily === fresh.uiFontFamily &&
    snapshotCache.inlayHints === fresh.inlayHints &&
    snapshotCache.uiFontScale === fresh.uiFontScale
  ) {
    return snapshotCache;
  }
  snapshotCache = fresh;
  return fresh;
}

/* ---------------------------- 订阅（版本号驱动重渲） ---------------------------- */

let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const l of listeners) l();
}

export function subscribeEditorDisplayPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function editorDisplayPrefsVersion(): number {
  return version;
}

export function useEditorDisplayPrefs(): EditorDisplayPrefs {
  return useSyncExternalStore(subscribeEditorDisplayPrefs, loadEditorDisplayPrefs, loadEditorDisplayPrefs);
}

/* ---------------------------- 写入口 ---------------------------- */

function samePrefs(a: EditorDisplayPrefs, b: EditorDisplayPrefs): boolean {
  return (
    a.lineHeight === b.lineHeight &&
    a.renderWhitespace === b.renderWhitespace &&
    a.minimap === b.minimap &&
    a.lineNumbers === b.lineNumbers &&
    a.fontFamily === b.fontFamily &&
    a.codeFontPreset === b.codeFontPreset &&
    a.uiFontPreset === b.uiFontPreset &&
    a.uiFontFamily === b.uiFontFamily &&
    a.inlayHints === b.inlayHints &&
    a.uiFontScale === b.uiFontScale
  );
}

/** 字体四键（档位 × 2 + 两段自定义文本）里是否有任何一位变了 */
function fontFieldsChanged(a: EditorDisplayPrefs, b: EditorDisplayPrefs): boolean {
  return (
    a.fontFamily !== b.fontFamily ||
    a.codeFontPreset !== b.codeFontPreset ||
    a.uiFontPreset !== b.uiFontPreset ||
    a.uiFontFamily !== b.uiFontFamily
  );
}

function write(patch: PrefsInput): EditorDisplayPrefs {
  const current = loadEditorDisplayPrefs();
  const next = sanitizePrefs({ ...current, ...patch });
  // 与当前同值 ⇒ 整次写入是无操作：不落盘也不广播。少这一道，设置页每点一次"当前值"
  // 都会让 EditorPane 补发一次 updateOptions、并让订阅方（useSyncExternalStore）白渲一次。
  if (samePrefs(current, next)) return current;
  const s = storage();
  if (s) {
    try {
      s.setItem(LINE_HEIGHT_KEY, String(next.lineHeight));
      s.setItem(RENDER_WHITESPACE_KEY, next.renderWhitespace);
      s.setItem(MINIMAP_MODE_KEY, next.minimap);
      // 旧键按新值镜像（'follow' 对旧版本就是"开"——那一版本来也没有跟随档）。
      // 只为回滚兜底：读的一侧仍是三态键优先。
      s.setItem(MINIMAP_KEY, next.minimap === 'off' ? '0' : '1');
      s.setItem(LINE_NUMBERS_KEY, next.lineNumbers);
      s.setItem(FONT_FAMILY_KEY, next.fontFamily);
      s.setItem(CODE_FONT_PRESET_KEY, next.codeFontPreset);
      s.setItem(UI_FONT_PRESET_KEY, next.uiFontPreset);
      s.setItem(UI_FONT_FAMILY_KEY, next.uiFontFamily);
      s.setItem(INLAY_HINTS_KEY, next.inlayHints ? '1' : '0');
      s.setItem(UI_FONT_SCALE_KEY, String(next.uiFontScale));
    } catch {
      // 存储不可写（隐私模式等）：本次改动仍在内存快照里活到会话结束，绝不抛进渲染链
    }
  }
  snapshotCache = next;
  // 界面字号缩放的生效路径就这一格（写侧当场落根元素，不用等编辑器重挂）：
  // 与 `theme-pref.ts` 的 setter 同款形态——落盘与应用在同一个入口，谁都不许只写不应用。
  if (next.uiFontScale !== current.uiFontScale) applyUiFontScalePref(next.uiFontScale);
  // 字体档位/自定义一改，当场把内联 `--font-code` / `--font-ui` 落根元素（与字号缩放同款"写侧即应用"）
  if (fontFieldsChanged(current, next)) applyFontStackCssPrefs(next);
  bump();
  return next;
}

/**
 * 保存一份（或一部分）显示偏好；返回清洗后的完整快照。
 *
 * `minimap` 的形参**宽到旧布尔**（历史调用点还在发布尔）：清洗层把它翻成 `'on'/'off'`，
 * 调用方不必一起改，也不会把布尔原样写进盘里。
 */
export function saveEditorDisplayPrefs(
  patch: Partial<Omit<EditorDisplayPrefs, 'minimap'>> & { readonly minimap?: MinimapPref | boolean },
): EditorDisplayPrefs {
  return write(patch);
}

/** 全部回到缺省（设置页「恢复默认」用） */
export function resetEditorDisplayPrefs(): EditorDisplayPrefs {
  return write({ ...EDITOR_DISPLAY_PREF_DEFAULT });
}

/** 哪些键已偏离缺省（设置页「已修改」过滤与徽标用；顺序稳定） */
export function modifiedEditorDisplayKeys(
  prefs: EditorDisplayPrefs = loadEditorDisplayPrefs(),
): (keyof EditorDisplayPrefs)[] {
  const keys: (keyof EditorDisplayPrefs)[] = [
    'lineHeight',
    'renderWhitespace',
    'minimap',
    'lineNumbers',
    'fontFamily',
    'codeFontPreset',
    'inlayHints',
    'uiFontScale',
    'uiFontPreset',
    'uiFontFamily',
  ];
  return keys.filter((k) => prefs[k] !== EDITOR_DISPLAY_PREF_DEFAULT[k]);
}

/* ---------------------------- Monaco 补丁 ---------------------------- */

/**
 * 缩略图到底画不画（**唯一判据**；档位表不读偏好，偏好也不改档位表）。
 *
 * 三条口径按"谁说了算"排：
 * ① `off` 一律不画——用户明说的选择最大；
 * ② huge 档一律不画——体量档那一刀不因偏好回退（`on` 也拦不住 99 万行）；
 * ③ `follow`（缺省）在 ② 之上再让两条**内容**判据：`.kojo` 正文与预览投影不画，
 *    大/超大档的长文也不画 ⇒ 只有"小体量的代码文件"保留这条纵览。
 */
export function minimapEnabledFor(
  lineCount: number,
  pref: MinimapPref = loadEditorDisplayPrefs().minimap,
  ctx: MinimapViewContext = {},
): boolean {
  const mode = normalizeMinimapPref(pref) ?? EDITOR_DISPLAY_PREF_DEFAULT.minimap;
  if (mode === 'off') return false;
  const tier = editorProfileTierForLineCount(lineCount);
  if (tier === 'huge') return false;
  if (mode === 'on') return true;
  if (ctx.preview || ctx.kojoText) return false;
  return tier === 'small';
}

/**
 * 体量无关的显示补丁（行高 / 空白符 / 缩略图 / 行号 / 行内提示）。
 *
 * 调用方：EditorPane 的 create options、三个 `applySizeTier` 写入点、偏好订阅回调。
 * `minimap` / `inlayHints` 在这里叠加体量档的上限（见文件头），**不改档位表本身**；
 * `minimapCtx` 只喂 `follow` 那两条内容判据（缺省空对象 = 屏幕上还没有文档）。
 *
 * 刻意**不含** `uiFontScale`：那一位是外壳 CSS 变量，不是 Monaco 选项（见文件头那条边界）。
 */
export function editorDisplayOptionPatch(
  lineCount: number,
  prefs: EditorDisplayPrefs = loadEditorDisplayPrefs(),
  minimapCtx: MinimapViewContext = {},
): EditorOptionPatch {
  return {
    lineHeight: prefs.lineHeight,
    renderWhitespace: prefs.renderWhitespace,
    minimap: {
      enabled: minimapEnabledFor(lineCount, prefs.minimap, minimapCtx),
      renderCharacters: false,
      maxColumn: 72,
    },
    lineNumbers: prefs.lineNumbers,
    inlayHints: { enabled: prefs.inlayHints ? 'on' : 'off' },
  };
}

/**
 * 把解析出的两条栈落到根元素的**内联声明**上（L20 生效链的 CSS 侧，形态照 `applyUiFontScalePref`）：
 * - 内联样式压过 `:root` 规则，天然就是"用户选了别的"的表达；`styles.css` / `tokens.css` 里的
 *   `CODE_FONT_CSS_LINE` / `UI_FONT_CSS_LINE` 两条闸逐字不动——默认档**一位都不写**，
 *   没动过字体项的作者界面与编辑器逐字不变。
 * - 与 Monaco 侧同串：那一份出自 `editorDisplayFontPatch`（同一对 `resolve*` 函数），
 *   `font-presets.test.ts` 一条断言读两个出口，防再次分叉。
 * - 触发点两处：`write()`（设置页改完当场见效）与 `editorDisplayFontPatch()`
 *   （编辑器 create / 偏好订阅回调都会经过它 ⇒ 下次启动播种，无需动别人模块的接线）。
 */
export function applyFontStackCssPrefs(
  prefs: EditorDisplayPrefs = loadEditorDisplayPrefs(),
  root: UiFontScaleRoot | null = defaultFontScaleRoot(),
): void {
  if (!root) return;
  const code = resolveCodeFontStack(prefs);
  if (code.stack === CODE_FONT_STACK) root.style.removeProperty(CODE_FONT_CSS_TOKEN);
  else root.style.setProperty(CODE_FONT_CSS_TOKEN, code.stack);
  const ui = resolveUiFontStack(prefs);
  if (ui.stack === UI_FONT_SYSTEM_STACK) root.style.removeProperty(UI_FONT_CSS_TOKEN);
  else root.style.setProperty(UI_FONT_CSS_TOKEN, ui.stack);
}

/**
 * 字体补丁（Monaco 侧）：**只**在 create 路径与偏好变更时使用（`code-font.ts` 的不变式：
 * 体量降级集永不含字体键）。
 *
 * 返回值口径：
 * - 全默认（`default` 档 + 空自定义文本 ⇒ 生效栈就是 `CODE_FONT_STACK`）时发空补丁——
 *   create 路径已 spread `CODE_FONT_BASELINE`，再发一遍同串是零增益噪声（旧测试钉的就是 `{}`）；
 * - 其余情况发 `resolveCodeFontStack` 的生效栈（档位栈 / 老自由文本，同一出口）；
 * - 坏栈不发送（`isUsableCodeFontStack` 挡掉后 Monaco 留平台默认，宁缺毋错）。
 *
 * 顺手承担 CSS 侧播种（见 `applyFontStackCssPrefs` 头注；node 环境无 `document` ⇒ 空转）。
 */
export function editorDisplayFontPatch(
  prefs: EditorDisplayPrefs = loadEditorDisplayPrefs(),
): EditorOptionPatch {
  applyFontStackCssPrefs(prefs);
  const resolved = resolveCodeFontStack(prefs);
  if (
    resolved.stack === CODE_FONT_STACK &&
    !resolved.fellBack &&
    prefs.codeFontPreset === 'default' &&
    prefs.fontFamily === ''
  ) {
    return {};
  }
  return isUsableCodeFontStack(resolved.stack) ? { fontFamily: resolved.stack } : {};
}

/**
 * 浮层编辑器（比对窗 / 快修预览窗）的代码字体补丁——**与主编辑器同串的第二只出口**
 * （视觉批十二 L20 点名的欠账，路 R2 收）。
 *
 * 改前实况：两个浮层只铺 `CODE_FONT_BASELINE`（那张缺省栈），主编辑器却在这条基线之上
 * 再叠 `editorDisplayFontPatch`。于是作者把代码档换成「更纱黑体等宽」之类时，编辑器里
 * 换了字、比对窗与预览窗仍是老栈——同一段代码在屏幕上以两种字面并排，读起来像字体坏了。
 * 这一枚把浮层接回**同一条解析链**（`resolveCodeFontStack`），不另起炉灶。
 *
 * 与 `editorDisplayFontPatch` 的差别只有一处：**不顺手做 CSS 播种**
 * （`applyFontStackCssPrefs` 归编辑器 create 与偏好写入那条链，只读浮层不是它的入口）。
 * 默认档也原样发一遍生效栈（而不是发空补丁）：浮层的基线垫底、这一格覆盖，
 * 「三处同串」因此是**构造上成立**，不是两处碰巧算出同一个数。
 * 栈坏掉（理论不该发生，护栏仍在）⇒ 发空补丁，浮层退回缺省基线，绝不喂半坏值。
 */
export function overlayCodeFontPatch(
  prefs: EditorDisplayPrefs = loadEditorDisplayPrefs(),
): EditorOptionPatch {
  const resolved = resolveCodeFontStack(prefs);
  return isUsableCodeFontStack(resolved.stack) ? { fontFamily: resolved.stack } : {};
}
