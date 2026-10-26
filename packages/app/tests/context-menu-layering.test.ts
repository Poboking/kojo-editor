/**
 * 右键菜单的**层叠判据**（1023 批 · WP6.4）：把「1300 盖过 1200、1200 盖过 1101」从注释
 * 变成测试。单测全绿不代表菜单没被浮层压住 —— z-index 只活在 CSS 里，改动它不会红任何行为用例。
 *
 * 纯源码判据（不读浏览器计算样式：jsdom / happy-dom 不算样式表，读出来永远是空）：
 * - 解析 `context-menu.css` / `styles-project.css` / `styles.css` 的规则块（容错注释、多行、空白）；
 * - `.context-menu-host` 的 `z-index` 是 1300（≥1300）；
 * - `.context-menu` 的 `z-index` 是 `calc(var(--z-modal) + 1)`，且 `--z-modal` 从 styles.css
 *   解析出 1100 ⇒ 实际 1101；
 * - 源码里确有裸 `1200` 的浮层档（`.notification-center`），且 1300 > 1200 > 1101；
 * - `.context-menu` 长菜单可滚：`max-height` 含 `vh` 兜底 + `overflow-y: auto`；
 * - 类名对得上：宿主/菜单组件的 className 与 CSS 里的选择器同源（防止 CSS 改名后测试仍绿）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8');

const HOST_CSS = read('context-menu.css');
const PROJECT_CSS = read('styles-project.css');
// 批次十一 L01：裸 `:root` 已从 styles.css / styles-project.css 两份逐字节副本收敛成单源
// `tokens.css`，所以档位真值只能从它读（从 styles.css 读会拿到 undefined）。
const TOKENS_CSS = read('tokens.css');
const HOST_SRC = read('ui/context-menu-host.tsx');
const MENU_SRC = read('ui/context-menu.tsx');

/* ------------------------------ 小型 CSS 解析 ------------------------------ */

interface CssRule {
  /** 选择器原文（逗号分隔的组选择器不拆，交给 matchesRule 逐条比） */
  readonly selector: string;
  /** 声明块原文（不含花括号） */
  readonly body: string;
}

/**
 * 把样式表拆成「选择器 + 声明块」。只做这件事，不做层叠/继承：
 * - 先剥注释（`/* ... *\/`，含换行）；
 * - 按花括号配对：`{` 之前的累积文本是选择器，`@` 开头的是 at-rule（`@media` / `@supports`），
 *   其块内嵌的普通规则照常收集（本仓的回落规则都写在 `@supports` / `@media` 里）。
 */
function parseRules(source: string): CssRule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  const frames: { selector: string; atRule: boolean }[] = [];
  let buffer = '';
  for (const ch of text) {
    if (ch === '{') {
      const selector = buffer.trim();
      frames.push({ selector, atRule: selector.startsWith('@') });
      buffer = '';
    } else if (ch === '}') {
      const frame = frames.pop();
      if (frame !== undefined && !frame.atRule) rules.push({ selector: frame.selector, body: buffer });
      buffer = '';
    } else {
      buffer += ch;
    }
  }
  return rules;
}

/** 空白容错：压成一个空格并去首尾（多行写法与单行写法等价） */
const squash = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** 比较用形态：连空格都不要（`calc(var(--z-modal) + 1)` 与 `calc(var(--z-modal)+1)` 等价） */
const tight = (value: string): string => value.replace(/\s+/g, '');

function selectorsOf(rule: CssRule): string[] {
  return rule.selector.split(',').map(squash);
}

/** 某条规则是否写了 `prop`（大小写不敏感；返回值已压过空白） */
function declOf(rules: readonly CssRule[], selector: string, prop: string): string | undefined {
  // 倒序 = 后写的赢（同一文件内的层叠口径）
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (!selectorsOf(rule).includes(selector)) continue;
    for (const part of rule.body.split(';')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      if (squash(part.slice(0, colon)).toLowerCase() !== prop) continue;
      return squash(part.slice(colon + 1));
    }
  }
  return undefined;
}

const HOST_RULES = parseRules(HOST_CSS);
const PROJECT_RULES = parseRules(PROJECT_CSS);
const TOKEN_RULES = parseRules(TOKENS_CSS);

describe('CSS 解析器本身（判据的地基）', () => {
  it('剥注释、多行声明、at-rule 内嵌规则都能读出来', () => {
    const rules = parseRules(`
      /* .ghost { z-index: 1 } 这条是注释，不算 */
      .a,
      .b {
        z-index: 7;
        color: red;
      }
      @supports not (display: grid) {
        .a {
          color: blue;
        }
      }
    `);
    expect(declOf(rules, '.a', 'z-index')).toBe('7');
    expect(declOf(rules, '.b', 'z-index')).toBe('7');
    expect(declOf(rules, '.a', 'color')).toBe('blue'); // at-rule 里最后一条赢
    expect(declOf(rules, '.ghost', 'z-index')).toBeUndefined();
  });
});

describe('层叠档位：根宿主 1300 > 浮层 1200 > 就地菜单 1101', () => {
  const hostZ = declOf(HOST_RULES, '.context-menu-host', 'z-index');
  const menuZ = declOf(HOST_RULES, '.context-menu', 'z-index');
  const modalVar = declOf(TOKEN_RULES, ':root', '--z-modal');
  /** 体感批 B-2 把宿主的裸值 1300 收进档位表 `--z-menu`（和 `--z-modal` / `--z-toast` 同一族）。
   *  本文件本来就是靠解析 `:root` 里的变量来算层序的（下面 `--z-modal` ⇒ 1101 就是一条解析路），
   *  所以这里照同一口径把 token 解成数——**判据强度不降**：既钉"宿主必须吃 `--z-menu`"，
   *  又钉"`--z-menu` 的真值仍是 1300"，比原来只钉一个字面量多拦一种漂移（谁挪档位表也红）。 */
  const hostZToken = hostZ ? /^var\((--z-[a-z0-9-]+)\)$/.exec(tight(hostZ)) : null;
  const hostZValue = hostZToken
    ? Number(declOf(TOKEN_RULES, ':root', hostZToken[1]))
    : Number(hostZ);

  it('主题里 --z-modal 是 1100（下面所有算式都从它出发）', () => {
    expect(modalVar).toBe('1100');
  });

  it('.context-menu-host 走档位表 --z-menu，解出来是 1300（且不低于 1300）', () => {
    expect(hostZ).toBeDefined();
    expect(hostZToken?.[1]).toBe('--z-menu');
    const value = hostZValue;
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(1300);
    expect(value).toBe(1300);
  });

  it('.context-menu 是 calc(var(--z-modal) + 1) ⇒ 1101', () => {
    expect(menuZ).toBeDefined();
    expect(tight(menuZ!)).toBe(tight('calc(var(--z-modal) + 1)'));
    const modal = Number(modalVar);
    const computed = modal + 1;
    expect(computed).toBe(1101);
    // 宿主必须压过就地菜单（同一屏上两者可能同时存在：根菜单开着、面板里的菜单又弹出）
    expect(hostZValue - computed).toBe(199);
  });

  it('浮层档在 1200（L02 把裸 1200 归档成 --z-toast），且三层严格递增', () => {
    // 原判据钉「源码里确有裸 1200」；批次十一 L02 把它换成语义 token。意图不变：
    // 仍要求存在一个 1200 档、那一档是提示/通知类浮层、且 1300 > 1200 > 1101。
    const toastVar = declOf(TOKEN_RULES, ':root', '--z-toast');
    expect(toastVar).toBe('1200');
    const tier = PROJECT_RULES.filter(
      (rule) => declOf([rule], selectorsOf(rule)[0]!, 'z-index') === 'var(--z-toast)',
    );
    expect(tier.length).toBeGreaterThan(0);
    // 1200 那一档得是「提示 / 通知」类浮层（不是随便哪个组件）
    const selector = selectorsOf(tier[0]!).join(' ');
    expect(selector).toMatch(/notification-center|floating-panel|toast/);

    const host = hostZValue;
    const menu = Number(modalVar) + 1;
    expect(host).toBeGreaterThan(1200);
    expect(1200).toBeGreaterThan(menu);
  });

  it('遮罩贴 --z-modal（1100），菜单比它高一级（点外面关得掉、菜单不被遮罩压住）', () => {
    expect(declOf(HOST_RULES, '.context-menu-backdrop', 'z-index')).toBe('var(--z-modal)');
  });
});

describe('长菜单可滚：max-height 含 vh 兜底 + overflow-y', () => {
  it('overflow-y 是 auto（长菜单不出视口，也不被裁掉半行）', () => {
    expect(declOf(HOST_RULES, '.context-menu', 'overflow-y')).toBe('auto');
  });

  it('max-height 有 vh 兜底（窗口再矮也不顶出屏幕）', () => {
    const maxHeight = declOf(HOST_RULES, '.context-menu', 'max-height');
    expect(maxHeight).toBeDefined();
    expect(maxHeight).toContain('vh');
    expect(maxHeight).toContain('min(');
  });

  it('overscroll-behavior: contain（滚到底不把编辑器一起滚）', () => {
    expect(declOf(HOST_RULES, '.context-menu', 'overscroll-behavior')).toBe('contain');
  });
});

describe('类名与组件同源（CSS 改名不能悄悄逃过判据）', () => {
  it('宿主组件渲染的类名正是 CSS 里有规则的那个', () => {
    expect(HOST_SRC).toContain('className="context-menu-host"');
    expect(HOST_CSS).toContain('.context-menu-host');
    // 固定层：只这样它才能脱离 .app-frame 的层叠上下文去压模态
    expect(declOf(HOST_RULES, '.context-menu-host', 'position')).toBe('fixed');
  });

  it('菜单组件用的 .context-menu / .context-menu--submenu 在 CSS 里都有规则', () => {
    expect(MENU_SRC).toContain('context-menu context-menu--shared');
    expect(declOf(HOST_RULES, '.context-menu', 'position')).toBe('fixed');
    const css = read('context-menu.css');
    expect(css).toContain('.context-menu.context-menu--submenu');
  });

  it('宿主样式表确实被菜单组件 import（否则 1300 这条规则根本不会加载）', () => {
    expect(MENU_SRC).toContain("import '../context-menu.css';");
  });
});

/**
 * 回归闸（2026-10-26 欢迎页事故）：菜单的**几何**必须住在轻档（`context-menu.css`，
 * 随 `ui/context-menu.tsx` 进首屏链），不能只写在重档 `styles-project.css` 里。
 *
 * 事故原貌：几何当时全在重档，而重档只在进项目时动态加载 ⇒ 欢迎弹窗 / 启动画面这些轻档
 * 状态里右键出来的菜单是一块**没有定位的通栏裸块**，遮罩算出 0 高（点空白关不掉），
 * 且 `.context-menu-backdrop` 一在文档里整窗拖动就被判据拒掉 —— 页面既点不动也拖不动。
 * 这里把「几何归轻档」钉成判据，避免下一批又把它挪回重档（挪回去这条会红）。
 */
describe('菜单几何归轻档（重档缺席时菜单也不能退化）', () => {
  const GEOMETRY = ['position', 'z-index', 'padding', 'border-radius', 'box-shadow'] as const;

  it('.context-menu 的几何在 context-menu.css 里逐条写全', () => {
    for (const prop of GEOMETRY) {
      expect(declOf(HOST_RULES, '.context-menu', prop), prop).toBeDefined();
    }
  });

  it('.context-menu-backdrop 的铺满几何也在轻档（遮罩没面积 = 点空白关不掉）', () => {
    expect(declOf(HOST_RULES, '.context-menu-backdrop', 'position')).toBe('fixed');
    expect(declOf(HOST_RULES, '.context-menu-backdrop', 'inset')).toBe('0');
  });

  it('重档不再重复声明这套几何（单一真源，不许两处各自漂移）', () => {
    for (const prop of ['position', 'padding', 'border-radius'] as const) {
      expect(declOf(PROJECT_RULES, '.context-menu', prop), prop).toBeUndefined();
    }
    expect(declOf(PROJECT_RULES, '.context-menu-backdrop', 'position')).toBeUndefined();
  });
});
