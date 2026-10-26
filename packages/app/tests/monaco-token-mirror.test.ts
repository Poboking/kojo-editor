import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import {
  KOJO_DARK_COLORS,
  KOJO_LIGHT_COLORS,
  KOJO_MINT_COLORS,
  defineMonacoThemes,
  type MonacoThemeId,
} from '../src/monaco/theme';

/**
 * Monaco 部件色 ↔ 设计 token 逐字对拍（VIS-53 · 2026-10-26 车道 E3）。
 *
 * 立论：`monaco/theme.ts` 那三张 `colors` 表是**裸 hex 镜像 token**——`editor.background`
 * 抄 `--bg`、`editor.lineHighlightBackground` 抄 `--bg-2`、`editorCursor.foreground` 抄
 * `--accent-text`、`editor.selectionBackground` 与 `--sel-bg` 同值不同串。 Monaco 拿不到
 * CSS 变量（`defineTheme` 只收字面量），所以这份抄本**注定存在**；问题从来不是"能不能不抄"，
 * 而是"抄了之后没人对"。此前谁改了 `tokens.css` / `themes/*.css` 而忘了 theme.ts，
 * 全仓一道闸都不会红——屏上却是编辑器与外壳分家两块底。
 *
 * 本文件把"同源"这一维钉成判据（口径照 `code-font.test.ts` / `font-presets.test.ts`
 * 那种 CSS↔TS 互抄的先例）：
 *  ① `MIRROR`：逐格点名「Monaco 键 ↔ 哪枚 token」，按档展开 token 终值后与 theme.ts 比对。
 *     `exact` = 通道 + alpha 全等（alpha 只容 1/255 的 8bit 舍入，见 `ALPHA_TOLERANCE`）；
 *     `channel` = **通道必须逐字同值**，alpha 归 Monaco 自己的一档（Monaco 的 wash 普遍比
 *     UI 的 wash 更透/更实，这是设计，不是漂移）。通道同值这一半照样能抓住"翻色忘跟"。
 *  ② `SYNTAX_MIRROR`：括号高亮六档 / 意外括号 / 墨档 info 色镜像**主题自己的语法档**
 *     （`keyword` / `entity.name.function` / …）——同源关系在 TS 内部，不看 CSS。
 *  ③ `ROSTER`：既没有 token 对位、也不该硬凑对位的档（行号三档、搜索命中黄、纯白输入面…），
 *     逐档登记理由。**只许缩不许涨**；新增 colors 键而不进①②③ 当场红。
 *  ④ 覆盖闭合：三张表的键集相等，且每一档 ① ∪ ② ∪ ③ **恰好等于**那张表的键集——
 *     既没有漏格的 Monaco 色，也没有已经删掉却还留在账上的幽灵键。
 *
 * ⚠ 与 `theme-color-gates.test.ts` 的分工：那边量的是**语法前景 vs 主题底**（46 条规则 ×3 档
 * ≥4.5 对比 + 去重前景两两 ΔE≥12 + 跨语言同义档同色 + kojo2/kojo colors 同族），
 * 判据一格未动；本文件只补"部件色与 token 同源"这一维。两边的底是同一个
 * `colors['editor.background']`（头注口径：不是 vs-dark 的 `#1e1e1e`）。
 *
 * 变异实测（2026-10-26 交付回执，三侧各注一条、逐条实测必红后还原）：
 *   ① theme.ts 侧 `KOJO_DARK_COLORS['editor.background']` `#1e2227`→`#1e2228` ⇒ 红（exact 档）；
 *   ② theme.ts 侧 `editorBracketHighlight.foreground1` `#c678dd`→`#c678de` ⇒ 红（语法同源档）；
 *   ③ token 侧 `themes/light.css` 的 `--bg-2` `#eaeef2`→`#ebeff3` ⇒ 红 **7 格**
 *      （lineHighlight 两格 + list 三格 + stickyScrollHover + hoverWidget 状态条——
 *       正是"翻了 token 忘了 theme.ts"那一手，2026-10-26 之前全仓零反应）。
 */

/* ------------------------------ ① 装配：读的是真主题，不是私有导出 ------------------------------ */

interface CapturedTheme {
  readonly rules: Monaco.editor.ITokenThemeRule[];
  readonly colors: Record<string, string>;
}

/** flag 关（缺省 `v1-only`）：v1 三套同步定义，2.0 三套不动态加载——本闸只管 v1 三张表 */
function stubFlagOff(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      },
    },
  });
}

function captureThemes(): Map<MonacoThemeId, CapturedTheme> {
  stubFlagOff();
  const themes = new Map<MonacoThemeId, CapturedTheme>();
  const monaco = {
    editor: {
      defineTheme: (id: string, theme: CapturedTheme): void => {
        themes.set(id as MonacoThemeId, theme);
      },
    },
    languages: {},
  } as unknown as typeof Monaco;
  defineMonacoThemes(monaco);
  return themes;
}

const THEMES = captureThemes();

/* ------------------------------ ② CSS token 终值表（与浏览器级联同构） ------------------------------ */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

const TOKENS_SRC = read('../src/tokens.css');
const LIGHT_SRC = read('../src/themes/light.css');
const MINT_SRC = read('../src/themes/mint-dark.css');

function rootDecls(src: string, want: string): Map<string, string> {
  const text = stripComments(src);
  const out = new Map<string, string>();
  const stack: { head: string; body: string }[] = [];
  let buf = '';
  for (const ch of text) {
    if (ch === '{') {
      stack.push({ head: squash(buf), body: '' });
      buf = '';
      continue;
    }
    if (ch === '}') {
      const top = stack.pop();
      if (top && top.head === want) {
        for (const d of top.body.split(';')) {
          const i = d.indexOf(':');
          if (i <= 0) continue;
          const prop = squash(d.slice(0, i));
          if (prop.startsWith('--') && squash(d.slice(i + 1)) !== '') out.set(prop, squash(d.slice(i + 1)));
        }
      }
      buf = '';
      continue;
    }
    if (stack.length > 0) stack[stack.length - 1]!.body += ch;
    buf += ch;
  }
  return out;
}

function buildLayer(themeSelector: string | null): Map<string, string> {
  const map = new Map(rootDecls(TOKENS_SRC, ':root'));
  if (themeSelector === null) return map;
  for (const src of [LIGHT_SRC, MINT_SRC]) {
    for (const [k, v] of rootDecls(src, themeSelector)) map.set(k, v);
  }
  return map;
}

const TIERS = ['dark', 'light', 'mint-dark'] as const;
type Tier = (typeof TIERS)[number];

const THEME_ID_BY_TIER: Readonly<Record<Tier, MonacoThemeId>> = {
  dark: 'kojo-dark',
  light: 'kojo-light',
  'mint-dark': 'kojo-mint-dark',
};
const COLORS_BY_TIER: Readonly<Record<Tier, Readonly<Record<string, string>>>> = {
  dark: KOJO_DARK_COLORS,
  light: KOJO_LIGHT_COLORS,
  'mint-dark': KOJO_MINT_COLORS,
};
const LAYERS: Readonly<Record<Tier, Map<string, string>>> = {
  dark: buildLayer(null),
  light: buildLayer(":root[data-theme='light']"),
  'mint-dark': buildLayer(":root[data-theme='mint-dark']"),
};

/* ------------------------------ ③ 颜色求值 ------------------------------ */

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function findClose(s: string, open: number): number {
  let d = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '(') d += 1;
    else if (s[i] === ')') {
      d -= 1;
      if (d === 0) return i;
    }
  }
  return -1;
}

function expandVars(value: string, map: Map<string, string>): string | null {
  let v = value;
  for (let iter = 0; iter < 32; iter += 1) {
    const m = /var\(/i.exec(v);
    if (!m || m.index === undefined) return v;
    const open = v.indexOf('(', m.index);
    const close = findClose(v, open);
    if (close < 0) return null;
    const inner = v.slice(open + 1, close);
    let depth = 0;
    let comma = -1;
    for (let i = 0; i < inner.length; i += 1) {
      const c = inner[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      else if (c === ',' && depth === 0) {
        comma = i;
        break;
      }
    }
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? '' : inner.slice(comma + 1).trim();
    const got = map.get(name);
    const repl = got !== undefined ? got : fallback;
    if (repl === '') return null;
    v = v.slice(0, m.index) + repl + v.slice(close + 1);
  }
  return null;
}

const clamp255 = (n: number): number => Math.max(0, Math.min(255, n));

/** hex（3/6/8 位，Monaco 用 8 位带 alpha）与 rgb()/rgba()（逗号式与 `r g b / a` 斜杠式） */
function parseColor(raw: string): Rgba | null {
  const v = squash(raw);
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(v);
  if (hex) {
    const h = hex[1]!;
    const at = (i: number, w: number): number => {
      const part = h.slice(i, i + w);
      return w === 1 ? Number.parseInt(part + part, 16) : Number.parseInt(part, 16);
    };
    if (h.length === 3 || h.length === 4) return { r: at(0, 1), g: at(1, 1), b: at(2, 1), a: h.length === 4 ? at(3, 1) / 255 : 1 };
    if (h.length === 6 || h.length === 8) return { r: at(0, 2), g: at(2, 2), b: at(4, 2), a: h.length === 8 ? at(6, 2) / 255 : 1 };
    return null;
  }
  if (/^transparent$/i.test(v)) return { r: 0, g: 0, b: 0, a: 0 };
  const fn = /^rgba?\(([^)]*)\)$/i.exec(v);
  if (!fn) return null;
  const inner = fn[1]!.replace(/,/g, ' ');
  const slash = inner.indexOf('/');
  const main = slash < 0 ? inner : inner.slice(0, slash);
  const alphaRaw = slash < 0 ? null : inner.slice(slash + 1).trim();
  const parts = main.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;
  const num = (t: string): number | null => {
    if (t.endsWith('%')) {
      const p = Number.parseFloat(t);
      return Number.isFinite(p) ? clamp255((p / 100) * 255) : null;
    }
    const n = Number.parseFloat(t);
    return Number.isFinite(n) ? clamp255(n) : null;
  };
  const r = num(parts[0]!);
  const g = num(parts[1]!);
  const b = num(parts[2]!);
  if (r === null || g === null || b === null) return null;
  const aRaw = alphaRaw ?? (parts.length >= 4 ? parts[3]! : '1');
  const a = aRaw.endsWith('%') ? Number.parseFloat(aRaw) / 100 : Number.parseFloat(aRaw);
  if (!Number.isFinite(a)) return null;
  return { r, g, b, a: Math.max(0, Math.min(1, a)) };
}

const channelHex = (c: Rgba): string =>
  `#${[c.r, c.g, c.b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
const alphaByte = (c: Rgba): number => Math.round(Math.max(0, Math.min(1, c.a)) * 255);

/**
 * CSS 侧 alpha（0..1 的十进制）→ Monaco 侧 alpha（8bit）的**唯一合法误差**：1/255。
 * `--sel-bg: rgb(10 92 194 / .28)` 写成 hex8 是 `0x47`(71) 还是 `0x48`(72) 取决于舍入方向，
 * 两者都不是"漂了"；再大就是有人动过其中一侧。（通道一律逐字等，不给容差。）
 */
const ALPHA_TOLERANCE = 1;

function compare(mode: 'exact' | 'channel', tokenValue: Rgba, monacoValue: Rgba): string | null {
  if (channelHex(tokenValue) !== channelHex(monacoValue)) {
    return `通道不同：token ${channelHex(tokenValue)} / theme.ts ${channelHex(monacoValue)}（alpha ${alphaByte(tokenValue)}/${alphaByte(monacoValue)}）`;
  }
  if (mode === 'exact' && Math.abs(alphaByte(tokenValue) - alphaByte(monacoValue)) > ALPHA_TOLERANCE) {
    return `alpha 漂了：token α=${alphaByte(tokenValue)}/255 vs theme.ts α=${alphaByte(monacoValue)}/255（exact 档只容 ${ALPHA_TOLERANCE}）`;
  }
  return null;
}

/* ------------------------------ ④ 对拍表 ------------------------------ */

/** `'--tok'` = exact；`['--tok', 'channel']` = 只钉通道；`null` = 本档不钉（走 ROSTER） */
type Spec = string | readonly [string, 'channel'] | null;

interface MirrorRow {
  key: string;
  tiers: readonly [Spec, Spec, Spec];
}

const m = (key: string, dark: Spec, light: Spec, mint: Spec): MirrorRow => ({ key, tiers: [dark, light, mint] });
const w = (token: string): Spec => [token, 'channel'];

const MIRROR: readonly MirrorRow[] = [
  // —— 编辑器底与字（外壳同一块面：`--bg` / `--fg` 一动，三格全要跟） ——
  m('editor.background', '--bg', '--bg', '--bg'),
  m('editorGutter.background', '--bg', '--bg', '--bg'),
  m('editorOverviewRuler.background', '--bg', '--bg', '--bg'),
  m('editorStickyScroll.background', '--bg', '--bg', '--bg'),
  m('minimap.background', '--bg', '--bg', '--bg'),
  m('editor.foreground', '--fg', '--fg', '--fg'),
  m('editorLineNumber.activeForeground', '--fg', '--fg', '--fg'),
  m('input.foreground', '--fg', '--fg', '--fg'),
  m('menu.foreground', '--fg', '--fg', '--fg'),
  m('list.hoverForeground', '--fg', '--fg', '--fg'),
  m('editorWidget.foreground', '--fg', '--fg', '--fg'),
  m('editorSuggestWidget.foreground', '--fg', '--fg', '--fg'),
  m('editorHoverWidget.foreground', '--fg', '--fg', '--fg'),
  m('input.placeholderForeground', null, null, '--fg-dim'),
  m('editorSuggestWidgetStatus.foreground', null, null, '--fg-dim'),
  m('list.activeSelectionForeground', null, '--fg', '--fg'),
  m('menu.selectionForeground', null, '--fg', '--fg'),
  m('editorSuggestWidget.selectedForeground', null, '--fg', '--fg'),
  // —— 当前行 / 列表选中面 ——
  m('editor.lineHighlightBackground', '--bg-2', '--bg-2', '--bg-2'),
  m('editor.lineHighlightBorder', '--bg-2', '--bg-2', '--bg-2'),
  m('list.inactiveSelectionBackground', '--bg-2', '--bg-2', '--bg-2'),
  m('editorStickyScrollHover.background', '--bg-2', '--bg-2', '--bg-2'),
  m('menu.background', '--bg-2', null, '--bg-2'),
  m('editorWidget.background', '--bg-2', null, '--bg-2'),
  m('editorSuggestWidget.background', '--bg-2', null, '--bg-2'),
  m('editorHoverWidget.background', '--bg-2', null, '--bg-2'),
  m('list.hoverBackground', '--bg-3', '--bg-2', '--bg-3'),
  m('list.focusBackground', '--bg-3', '--bg-2', '--bg-3'),
  m('list.activeSelectionBackground', '--bg-3', '--bg-3', '--bg-3'),
  m('menu.selectionBackground', '--bg-3', '--bg-3', '--bg-3'),
  m('editorSuggestWidget.selectedBackground', '--bg-3', '--bg-3', '--bg-3'),
  m('editorHoverWidget.statusBarBackground', '--bg-3', '--bg-2', '--bg-3'),
  m('input.background', '--bg-3', null, '--bg-3'),
  m('editorRuler.foreground', '--bg-3', '--border-subtle', '--border-subtle'),
  m('editorIndentGuide.background1', '--border-subtle', null, null),
  m('editorStickyScroll.border', '--border-subtle', null, null),
  // —— 描边族（发丝线一根线：全档都从 border/border-strong 取） ——
  m('editorWhitespace.foreground', '--border', '--border', '--border'),
  m('editorOverviewRuler.border', '--border', '--border', '--border'),
  m('menu.border', '--border', '--border', '--border'),
  m('menu.separatorBackground', '--border', '--border-subtle', '--border'),
  m('widget.border', '--border', '--border', '--border'),
  m('editorWidget.border', '--border', '--border', '--border'),
  m('editorSuggestWidget.border', '--border', '--border', '--border'),
  m('editorHoverWidget.border', '--border', '--border', '--border'),
  m('diffEditor.border', '--border', '--border', '--border'),
  m('editorIndentGuide.activeBackground1', '--border-strong', null, '--border-strong'),
  m('input.border', '--border-strong', '--border', '--border-strong'),
  // —— accent / 光标 / 徽章（本档的"活"色，四枚一起钉） ——
  m('editorCursor.foreground', '--accent-text', '--accent-text', '--focus-ring'),
  m('editorLink.activeForeground', '--accent-text', '--accent-text', '--accent-text'),
  m('editorInfo.foreground', '--accent-text', '--accent-text', null),
  m('list.highlightForeground', '--accent-text', '--accent-text', '--accent-text'),
  m('list.focusHighlightForeground', '--accent-text', '--accent-text', '--accent-text'),
  m('editorSuggestWidget.highlightForeground', '--accent-text', '--accent-text', '--accent-text'),
  m('editorSuggestWidget.focusHighlightForeground', '--accent-text', '--accent-text', '--accent-text'),
  m('editorHoverWidget.highlightForeground', '--accent-text', '--accent-text', '--accent-text'),
  m('badge.background', '--accent-strong', '--accent-strong', '--accent-strong'),
  m('badge.foreground', '--on-accent', '--on-accent', '--on-accent'),
  m('focusBorder', '--accent', '--accent', '--focus-ring'),
  m('editorBracketMatch.border', '--accent', '--accent', '--accent'),
  // —— 语义三档（错误 / 警告 / 意外括号） ——
  m('editorError.foreground', '--red', '--red', '--red'),
  m('editorWarning.foreground', '--amber', '--amber', '--amber'),
  // —— wash 家族：通道与 token 逐字同值，alpha 是 Monaco 自己的一档 ——
  m('editor.selectionBackground', '--sel-bg', '--sel-bg', '--sel-bg'),
  m('editor.inactiveSelectionBackground', '--active', '--accent-soft', w('--active')),
  m('editorBracketMatch.background', '--active', '--accent-soft', '--active'),
  m('editor.selectionHighlightBackground', w('--accent'), w('--accent'), w('--accent')),
  m('editor.wordHighlightBackground', w('--accent'), w('--accent'), w('--accent')),
  m('editor.wordHighlightStrongBackground', w('--accent'), w('--accent'), w('--accent')),
  m('editor.findRangeHighlightBackground', w('--accent'), w('--accent'), w('--accent')),
  m('editor.findMatchBackground', w('--amber'), null, w('--amber')),
  m('editor.findMatchHighlightBackground', w('--amber'), null, w('--amber')),
  m('scrollbarSlider.background', w('--scroll-thumb'), w('--scroll-thumb'), w('--scroll-thumb')),
  m('scrollbarSlider.hoverBackground', w('--scroll-thumb-hover'), w('--scroll-thumb-hover'), w('--scroll-thumb-hover')),
  m('scrollbarSlider.activeBackground', w('--scroll-thumb-active'), w('--scroll-thumb-active'), w('--scroll-thumb-active')),
  m('diffEditor.insertedTextBackground', w('--green'), w('--green'), w('--green')),
  m('diffEditor.insertedLineBackground', w('--green'), w('--green'), w('--green')),
  m('diffEditorGutter.insertedLineBackground', w('--green'), w('--green'), w('--green')),
  m('diffEditorOverview.insertedForeground', w('--green'), w('--green'), w('--green')),
  m('diffEditor.removedTextBackground', w('--red'), w('--red'), w('--red')),
  m('diffEditor.removedLineBackground', w('--red'), w('--red'), w('--red')),
  m('diffEditorGutter.removedLineBackground', w('--red'), w('--red'), w('--red')),
  m('diffEditorOverview.removedForeground', w('--red'), w('--red'), w('--red')),
  m('diffEditor.diagonalFill', w('--border'), w('--border'), w('--border')),
];

/** 部件色 ↔ 主题自己的语法档（TS 内部同源：括号六档必须就是那六档语法色） */
interface SyntaxRow {
  key: string;
  tiers: readonly [Spec, Spec, Spec];
}

const s = (key: string, dark: Spec, light: Spec, mint: Spec): SyntaxRow => ({ key, tiers: [dark, light, mint] });

const SYNTAX_MIRROR: readonly SyntaxRow[] = [
  s('editorBracketHighlight.foreground1', 'keyword', 'keyword', 'keyword'),
  s('editorBracketHighlight.foreground2', 'entity.name.function', 'entity.name.function', 'entity.name.function'),
  s('editorBracketHighlight.foreground3', 'label', 'label', 'label'),
  s('editorBracketHighlight.foreground4', 'keyword.preprocessor', 'keyword.preprocessor', 'keyword.preprocessor'),
  s('editorBracketHighlight.foreground5', 'variable', 'keyword.erb', 'variable'),
  s('editorBracketHighlight.foreground6', 'string', 'string', 'string'),
  s('editorBracketHighlight.unexpectedBracket.foreground', 'variable', 'variable', 'variable'),
  s('editorInfo.foreground', null, null, 'entity.name.function'),
];

/**
 * 既无 token 对位、也不硬凑对位的档（逐档登记理由）。**只许缩不许涨**：
 * 转正一枚（换 `var()` 同源）就把它从这里划掉、并进 `MIRROR`。
 */
interface RosterRow {
  key: string;
  tiers: readonly [boolean, boolean, boolean];
  why: string;
}

const ROSTER: readonly RosterRow[] = [
  {
    key: 'editorLineNumber.foreground',
    tiers: [true, true, true],
    why: '行号静息档比本档 --fg-dim 再沉一档（dark 7d8794 / light 6e7781 / mint 6f8c7d）——CSS 族里没有这一档，硬挂 --fg-dim 会让行号与次要文字同值',
  },
  {
    key: 'editorIndentGuide.activeBackground1',
    tiers: [false, true, false],
    why: '⚠ 浅档导轨激活色 #afb8c1 与本档 --border-strong #aeb8c2 差 1 个色阶（R/B 各差 1）——肉眼无差、但不是同值；同一串 #afb8c1 还被 editorLineNumber.dimmedForeground 用着（两件事共用一枚值）。要归 --border-strong 就得动 theme.ts 那 1/255，判据留给组长',
  },
  {
    key: 'editorLineNumber.dimmedForeground',
    tiers: [true, true, true],
    why: '折叠行的行号：比静息档再沉一档，同样无 token 对位',
  },
  {
    key: 'input.placeholderForeground',
    tiers: [true, true, false],
    why: '⚠ 与 --fg-dim 已经分家：dark token 抬到 909aa4、浅档 --fg-dim 是 59636e，theme.ts 还停在旧值 8b949e / 6e7781（本闸把它记在账上而不是硬钉同源，是要组长判的既有漂移，不在 E3 的调色授权内）',
  },
  {
    key: 'editorSuggestWidgetStatus.foreground',
    tiers: [true, true, false],
    why: '同上分家（dark 8b949e / light 57606a，浅档那枚恰好等于本档注释色，但不是同源关系，不当 --fg-dim 钉）',
  },
  {
    key: 'list.activeSelectionForeground',
    tiers: [true, false, false],
    why: 'dark 的选中字 e6edf3 比 --fg (d7dce2) 亮一档；浅档与墨档已改回本档 --fg',
  },
  { key: 'menu.selectionForeground', tiers: [true, false, false], why: '同 list.activeSelectionForeground（dark e6edf3）' },
  { key: 'editorSuggestWidget.selectedForeground', tiers: [true, false, false], why: '同上（dark e6edf3）' },
  {
    key: 'menu.background',
    tiers: [false, true, false],
    why: '浅档浮层取**纯白面** #ffffff：本档 --surface 是 --bg (#f6f8fa)，没有"卡片白"这一枚 token（待补）',
  },
  { key: 'editorWidget.background', tiers: [false, true, false], why: '同上（浅档纯白面）' },
  { key: 'editorSuggestWidget.background', tiers: [false, true, false], why: '同上（浅档纯白面）' },
  { key: 'editorHoverWidget.background', tiers: [false, true, false], why: '同上（浅档纯白面）' },
  { key: 'input.background', tiers: [false, true, false], why: '同上（浅档输入井 = 纯白面）' },
  {
    key: 'editorIndentGuide.background1',
    tiers: [false, true, true],
    why: '导轨静息档：浅档 d8dee4 / 墨档 243a30 都落在本档 --border 与 --border-subtle 之间，硬挂任一枚都会改渲染值',
  },
  { key: 'editorStickyScroll.border', tiers: [false, true, true], why: '同上（粘滚条分隔线取导轨那一档）' },
  {
    key: 'editor.findMatchBackground',
    tiers: [false, true, false],
    why: '浅档搜索黄 d4a72c 比本档 --amber (8a5a04) 亮得多（压在浅底上才认得出"命中"），不是同一支色，不硬挂',
  },
  { key: 'editor.findMatchHighlightBackground', tiers: [false, true, false], why: '同上（次级命中 α 档）' },
];

/* ------------------------------ ⑤ 判据 ------------------------------ */

const specOf = (row: { tiers: readonly Spec[] }, tier: Tier): Spec => row.tiers[TIERS.indexOf(tier)] ?? null;
const specKey = (spec: Spec): string | null => (spec === null ? null : typeof spec === 'string' ? spec : spec[0]);
const specMode = (spec: Spec): 'exact' | 'channel' => (typeof spec === 'string' || spec === null ? 'exact' : spec[1]);

function resolveToken(tier: Tier, token: string): Rgba | null {
  const map = LAYERS[tier];
  const raw = map.get(token);
  if (raw === undefined) return null;
  const expanded = expandVars(raw, map);
  if (expanded === null) return null;
  return parseColor(expanded);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VIS-53 ①：Monaco 部件色 ↔ CSS token 逐格对拍', () => {
  it('三档都装配到了、每档 ≥80 键且键集逐字相等（少一格 / 多一格当场红）', () => {
    const sets = TIERS.map((tier) => Object.keys(COLORS_BY_TIER[tier]).sort());
    expect(sets[0]!.length, 'dark 部件色键数跌破 80（2.0 补齐时的规模线）').toBeGreaterThanOrEqual(80);
    for (let i = 1; i < sets.length; i += 1) {
      expect(sets[i], `${TIERS[i]} 与 dark 的 colors 键集分家`).toEqual(sets[0]);
    }
    for (const tier of TIERS) {
      const theme = THEMES.get(THEME_ID_BY_TIER[tier]);
      expect(theme, `没捕获到 ${THEME_ID_BY_TIER[tier]}（装配面漂 = 本闸整个红）`).toBeDefined();
      expect(Object.keys(theme!.colors).sort(), `${tier}：装配后的 colors 不是那张表`).toEqual(sets[0]!);
    }
  });

  it('对拍表本体够大（≥60 条镜像关系，短了就是"把闸写松"）', () => {
    expect(MIRROR.length).toBeGreaterThanOrEqual(60);
    expect(SYNTAX_MIRROR.length).toBeGreaterThanOrEqual(8);
  });

  for (const tier of TIERS) {
    it(`${tier}：每一格展开 token 终值后与 theme.ts 同值（exact 连 alpha，channel 只容 alpha 自成一档）`, () => {
      const bad: string[] = [];
      for (const row of MIRROR) {
        const spec = specOf(row, tier);
        if (spec === null) continue;
        const token = specKey(spec)!;
        const monaco = COLORS_BY_TIER[tier][row.key];
        if (monaco === undefined) {
          bad.push(`${row.key}：theme.ts 里没这格（token ${token} 挂空）`);
          continue;
        }
        const fromCss = resolveToken(tier, token);
        const fromTs = parseColor(monaco);
        if (fromCss === null) {
          bad.push(`${row.key} ← ${token}：token 在该档解析不出颜色（未定义 / 环 / 非颜色值）`);
          continue;
        }
        if (fromTs === null) {
          bad.push(`${row.key}：theme.ts 的值不是可解析颜色（${monaco}）`);
          continue;
        }
        const diff = compare(specMode(spec), fromCss, fromTs);
        if (diff) bad.push(`${row.key} ↔ ${token}（${specMode(spec)}）：${diff}`);
      }
      expect(bad.join('\n'), `${tier} 有 ${bad.length} 格 Monaco 色与 token 断了同源：\n${bad.join('\n')}`).toBe('');
    });
  }

  it('MIRROR 里不许出现重复键（同一格挂两枚 token = 对拍口径分叉）', () => {
    const seen = new Set<string>();
    const dup = MIRROR.filter((row) => (seen.has(row.key) ? true : (seen.add(row.key), false)));
    expect(dup.map((r) => r.key).join(', ')).toBe('');
  });
});

describe('VIS-53 ②：括号 / 意外括号 ↔ 主题自己的语法档', () => {
  for (const tier of TIERS) {
    it(`${tier}：逐格等于同一套主题 rules 里那一档的前景`, () => {
      const theme = THEMES.get(THEME_ID_BY_TIER[tier])!;
      const fgOf = (token: string): string | undefined =>
        theme.rules.find((rule) => rule.token === token)?.foreground;
      const bad: string[] = [];
      for (const row of SYNTAX_MIRROR) {
        const token = specOf(row, tier);
        if (token === null || typeof token !== 'string') {
          if (token !== null) bad.push(`${row.key}：语法镜像只接受 token 名`);
          continue;
        }
        const ruleFg = fgOf(token);
        const color = COLORS_BY_TIER[tier][row.key];
        if (ruleFg === undefined) {
          bad.push(`${row.key} ← ${token}：本套主题没有这条语法规则的前景`);
          continue;
        }
        if (color === undefined) {
          bad.push(`${row.key}：colors 表里没这格`);
          continue;
        }
        if (color.toLowerCase() !== `#${ruleFg.toLowerCase()}`) {
          bad.push(`${row.key}=${color} 与语法档 ${token}=#${ruleFg} 分家`);
        }
      }
      expect(bad.join('\n'), `${tier} 的 TS 内部同源断了：\n${bad.join('\n')}`).toBe('');
    });
  }
});

describe('VIS-53 ④：覆盖闭合——每一格要么钉了同源，要么在账上', () => {
  for (const tier of TIERS) {
    it(`${tier}：MIRROR ∪ SYNTAX ∪ ROSTER 恰好等于 colors 键集（漏一格红、幽灵键也红）`, () => {
      const claimed = new Map<string, string>();
      const collide: string[] = [];
      const claim = (key: string, from: string): void => {
        const prev = claimed.get(key);
        if (prev !== undefined) collide.push(`${key}：同时被 ${prev} 和 ${from} 认领`);
        claimed.set(key, from);
      };
      for (const row of MIRROR) if (specOf(row, tier) !== null) claim(row.key, 'MIRROR');
      for (const row of SYNTAX_MIRROR) if (specOf(row, tier) !== null) claim(row.key, 'SYNTAX');
      for (const row of ROSTER) if (row.tiers[TIERS.indexOf(tier)]) claim(row.key, 'ROSTER');
      const keys = Object.keys(COLORS_BY_TIER[tier]);
      const unclaimed = keys.filter((k) => !claimed.has(k));
      const ghosts = [...claimed.keys()].filter((k) => !keys.includes(k));
      expect(collide.join('\n'), `${tier}：一格被两处认领\n${collide.join('\n')}`).toBe('');
      expect(unclaimed.join(', '), `${tier}：这些 Monaco 色既没同源、也没登记（裸 hex 回潮的入口）\n`).toBe('');
      expect(ghosts.join(', '), `${tier}：账上/表里还挂着已经不存在的键`).toBe('');
    });

    it(`${tier}：ROSTER 只许缩不许涨（转正一枚就划一行）`, () => {
      const n = ROSTER.filter((row) => row.tiers[TIERS.indexOf(tier)]).length;
      // 2026-10-26 E3 建账基线：dark 7 / light 14 / mint 4（合计 25 格）
      const BASELINE: Readonly<Record<Tier, number>> = { dark: 7, light: 14, 'mint-dark': 4 };
      expect(
        n,
        `${tier} 档的登记数 ${n} 超过基线 ${BASELINE[tier]}——新出现的裸 hex 不许进账：要么并进 MIRROR（与 token 同源），要么说清为什么它不该存在`,
      ).toBeLessThanOrEqual(BASELINE[tier]!);
    });
  }
});
