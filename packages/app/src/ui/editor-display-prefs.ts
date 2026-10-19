/**
 * 编辑器显示偏好（用户反馈批，2026-10-19）：行高 / 空白符 / 缩略图 / 行号 / 字体族 / 行内提示。
 *
 * 零 React 纯逻辑（localStorage + 订阅表），存法照 `layout-pref.ts` / `motion-pref.ts` 先例，
 * **不新造第二套偏好机制**。设置页与常驻壳层都经 `useSyncExternalStore` 读同一份快照：
 * 设置页一改，EditorPane 的订阅回调立刻把补丁 `updateOptions` 下去，无需重开文件。
 *
 * 与体量档的关系（`editor-options.ts` 是体量轴唯一真源，本模块**不改档位表**）：
 * - `minimap` 仍归体量档管：用户关掉 = 永远关；用户开着 = small/large 开、huge 仍关
 *   （99 万行档的那一刀不因偏好回退）。
 * - `inlayHints` 同理：用户关掉 = 永远关；开着时大文件仍由 provider 侧的
 *   `inlayHintsAffordable` 让路（本模块不越过那条判据）。
 * - 行高 / 空白符 / 行号 / 字体族与体量正交，用户值直接生效。
 *
 * 字体族**不进 `editorOptionsForLineCount`**（`code-font.ts` 的不变式：降级集永不含字体键）：
 * 它只在 create 路径与偏好变更时 `updateOptions`，与 `CODE_FONT_BASELINE` 同一条轴。
 */

import { useSyncExternalStore } from 'react';
import { isUsableCodeFontStack } from './code-font';
import { editorProfileTierForLineCount, type EditorOptionPatch } from './editor-options';

/** Monaco `renderWhitespace` 的登记值（0.57 d.ts 逐字照抄，不另造词汇） */
export type RenderWhitespacePref = 'none' | 'boundary' | 'selection' | 'trailing' | 'all';

/** Monaco `lineNumbers` 的登记值 */
export type LineNumbersPref = 'on' | 'off' | 'relative' | 'interval';

export interface EditorDisplayPrefs {
  /** 行高（px；0 = 交给 Monaco 按字号算，即今天的行为） */
  readonly lineHeight: number;
  readonly renderWhitespace: RenderWhitespacePref;
  /** 缩略图总开关（true 时仍受体量档约束） */
  readonly minimap: boolean;
  readonly lineNumbers: LineNumbersPref;
  /** 自定义字体族；空串 = 用 `CODE_FONT_STACK` */
  readonly fontFamily: string;
  /** 行内提示总开关（true 时仍受体量档约束） */
  readonly inlayHints: boolean;
}

export const EDITOR_DISPLAY_PREF_DEFAULT: EditorDisplayPrefs = {
  lineHeight: 0,
  renderWhitespace: 'none',
  minimap: true,
  lineNumbers: 'on',
  fontFamily: '',
  inlayHints: true,
};

const LINE_HEIGHT_KEY = 'kojo.ui.editor.lineHeight.v1';
const RENDER_WHITESPACE_KEY = 'kojo.ui.editor.renderWhitespace.v1';
const MINIMAP_KEY = 'kojo.ui.editor.minimap.v1';
const LINE_NUMBERS_KEY = 'kojo.ui.editor.lineNumbers.v1';
const FONT_FAMILY_KEY = 'kojo.ui.editor.fontFamily.v1';
const INLAY_HINTS_KEY = 'kojo.ui.editor.inlayHints.v1';

const RENDER_WHITESPACE_VALUES: readonly RenderWhitespacePref[] = [
  'none',
  'boundary',
  'selection',
  'trailing',
  'all',
];
const LINE_NUMBERS_VALUES: readonly LineNumbersPref[] = ['on', 'off', 'relative', 'interval'];

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readEnum<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** 行高合法域：0（自动）或 14–96 的整数；非法值回落 0，绝不把怪值喂进 Monaco */
export function sanitizeLineHeight(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  const n = Math.trunc(raw);
  if (n === 0) return 0;
  return Math.min(96, Math.max(14, n));
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

function sanitizePrefs(prefs: EditorDisplayPrefs): EditorDisplayPrefs {
  return {
    lineHeight: sanitizeLineHeight(prefs.lineHeight),
    renderWhitespace: readEnum(prefs.renderWhitespace, RENDER_WHITESPACE_VALUES, EDITOR_DISPLAY_PREF_DEFAULT.renderWhitespace),
    minimap: prefs.minimap !== false,
    lineNumbers: readEnum(prefs.lineNumbers, LINE_NUMBERS_VALUES, EDITOR_DISPLAY_PREF_DEFAULT.lineNumbers),
    fontFamily: sanitizeFontFamily(prefs.fontFamily),
    inlayHints: prefs.inlayHints !== false,
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
        minimap: s.getItem(MINIMAP_KEY) !== '0',
        lineNumbers: readEnum(
          s.getItem(LINE_NUMBERS_KEY),
          LINE_NUMBERS_VALUES,
          EDITOR_DISPLAY_PREF_DEFAULT.lineNumbers,
        ),
        fontFamily: s.getItem(FONT_FAMILY_KEY) ?? '',
        inlayHints: s.getItem(INLAY_HINTS_KEY) !== '0',
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
    snapshotCache.inlayHints === fresh.inlayHints
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
    a.inlayHints === b.inlayHints
  );
}

function write(patch: Partial<EditorDisplayPrefs>): EditorDisplayPrefs {
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
      s.setItem(MINIMAP_KEY, next.minimap ? '1' : '0');
      s.setItem(LINE_NUMBERS_KEY, next.lineNumbers);
      s.setItem(FONT_FAMILY_KEY, next.fontFamily);
      s.setItem(INLAY_HINTS_KEY, next.inlayHints ? '1' : '0');
    } catch {
      // 存储不可写（隐私模式等）：本次改动仍在内存快照里活到会话结束，绝不抛进渲染链
    }
  }
  snapshotCache = next;
  bump();
  return next;
}

/** 保存一份（或一部分）显示偏好；返回清洗后的完整快照 */
export function saveEditorDisplayPrefs(patch: Partial<EditorDisplayPrefs>): EditorDisplayPrefs {
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
  ];
  return keys.filter((k) => prefs[k] !== EDITOR_DISPLAY_PREF_DEFAULT[k]);
}

/* ---------------------------- Monaco 补丁 ---------------------------- */

/**
 * 体量无关的显示补丁（行高 / 空白符 / 缩略图 / 行号 / 行内提示）。
 *
 * 调用方：EditorPane 的 create options、三个 `applySizeTier` 写入点、偏好订阅回调。
 * `minimap` / `inlayHints` 在这里叠加体量档的上限（见文件头），**不改档位表本身**。
 */
export function editorDisplayOptionPatch(
  lineCount: number,
  prefs: EditorDisplayPrefs = loadEditorDisplayPrefs(),
): EditorOptionPatch {
  const tier = editorProfileTierForLineCount(lineCount);
  return {
    lineHeight: prefs.lineHeight,
    renderWhitespace: prefs.renderWhitespace,
    minimap: { enabled: prefs.minimap && tier !== 'huge', renderCharacters: false, maxColumn: 72 },
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
