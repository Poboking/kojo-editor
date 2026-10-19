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
import { isUsableCodeFontStack } from './code-font';
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
  /** 行高（px；0 = 交给 Monaco 按字号算，即今天的行为） */
  readonly lineHeight: number;
  readonly renderWhitespace: RenderWhitespacePref;
  /** 缩略图三态（`on` 时仍受体量档约束；`follow` 还受 {@link MinimapViewContext} 约束） */
  readonly minimap: MinimapPref;
  readonly lineNumbers: LineNumbersPref;
  /** 自定义字体族；空串 = 用 `CODE_FONT_STACK` */
  readonly fontFamily: string;
  /** 行内提示总开关（true 时仍受体量档约束） */
  readonly inlayHints: boolean;
  /** 界面外壳文字缩放（%）；100 = 样式表现值，一位都不覆写 */
  readonly uiFontScale: UiFontScalePref;
}

export const EDITOR_DISPLAY_PREF_DEFAULT: EditorDisplayPrefs = {
  lineHeight: 0,
  renderWhitespace: 'none',
  minimap: 'follow',
  lineNumbers: 'on',
  fontFamily: '',
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
const INLAY_HINTS_KEY = 'kojo.ui.editor.inlayHints.v1';
const UI_FONT_SCALE_KEY = 'kojo.ui.editor.uiFontScale.v1';

const RENDER_WHITESPACE_VALUES: readonly RenderWhitespacePref[] = [
  'none',
  'boundary',
  'selection',
  'trailing',
  'all',
];
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

/** 行高合法域：0（自动）或 14–96 的整数；非法值回落 0，绝不把怪值喂进 Monaco */
export function sanitizeLineHeight(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  const n = Math.trunc(raw);
  if (n === 0) return 0;
  return Math.min(96, Math.max(14, n));
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
        lineHeight: Number(s.getItem(LINE_HEIGHT_KEY) ?? '0'),
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
    a.inlayHints === b.inlayHints &&
    a.uiFontScale === b.uiFontScale
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
    'inlayHints',
    'uiFontScale',
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

/** 字体族补丁：只在 create 路径与偏好变更时使用（空串 = 不发送，保留默认栈） */
export function editorDisplayFontPatch(
  prefs: EditorDisplayPrefs = loadEditorDisplayPrefs(),
): EditorOptionPatch {
  return prefs.fontFamily === '' ? {} : { fontFamily: prefs.fontFamily };
}
