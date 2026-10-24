import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 缩进导轨「值单源」闸（视觉批十三 · BOARD 遗留项「两条缩进导轨收成一条全局规则」）。
 *
 * 背景：文件树（L16）、大纲（L19）、教程目录（L19 二轮）三处各画了一条 1px 竖线，
 * 口径都写着「1px + var(--border)，悬停/当前提到 --border-strong」，但三份实现各写各的字面，
 * 改色/改宽度要改三处（L19 提交 c6a5f494 自认「不共用代码」）。
 * 本批把**宽度与两档颜色**收到 `tokens.css` 的 `--rail-w` / `--rail-color` /
 * `--rail-color-strong`，三处只许 `var()` 消费；图样（伪元素实心条 vs 随 depth 伸缩的
 * repeating-linear-gradient）因结构差异不强行统一，故本闸只钉值这一层。
 *
 * 判据按**声明名取值**（照 `tutorial-code-block.test.ts` 的 `decls()` 写法），
 * 排版 / 声明顺序 / 注释措辞都不参与；改语义才红。
 *
 * 「三档下都有值」：`--rail-color` / `--rail-color-strong` 是描边族的别名，dark 基线在
 * `tokens.css :root`，light / mint-dark 由各自主题块重定义 `--border` / `--border-strong`
 * 后经 var() 链自动翻色——本闸按档合成终值表并展开 var() 链，逐档验宽度与颜色都解析得出来。
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const tokensSrc = read('../src/tokens.css');
const lightSrc = read('../src/themes/light.css');
const mintSrc = read('../src/themes/mint-dark.css');

const FILE_TREE = read('../src/file-tree.css');
const OUTLINE = read('../src/outline-panel.css');
const DEV_NOTE = read('../src/dev-note.css');

/** 去掉注释（注释里的旧口径措辞不该影响判据） */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取某条规则的声明块：从 marker 起找到第一对花括号。这几条规则体内没有嵌套块，够用。 */
function ruleBody(css: string, marker: string): string {
  const src = stripComments(css);
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`样式表里找不到规则起点：${marker}`);
  const open = src.indexOf('{', at);
  const close = src.indexOf('}', open);
  if (open < 0 || close < 0) throw new Error(`规则块不完整：${marker}`);
  return src.slice(open + 1, close);
}

/** 声明块 → 属性表（同名后到者覆盖，与浏览器一致）；空白与声明顺序都不参与判据 */
function decls(css: string, marker: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of ruleBody(css, marker).split(';')) {
    const at = raw.indexOf(':');
    if (at <= 0) continue;
    const prop = raw.slice(0, at).trim().toLowerCase();
    if (prop === '') continue;
    map.set(prop, raw.slice(at + 1).replace(/\s+/g, ' ').trim());
  }
  return map;
}

/* ------------------------------ token 表解析与 var() 展开 ------------------------------ */

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** 大括号深度扫描：收集选择器恰为 `want` 的声明块里的全部自定义属性（后到覆盖先到）。 */
function collectRootDecls(src: string, want: string): Map<string, string> {
  const text = stripComments(src);
  const out = new Map<string, string>();
  const stack: Array<{ head: string; body: string }> = [];
  let buf = '';
  for (const ch of text) {
    if (ch === '{') {
      stack.push({ head: norm(buf), body: '' });
      buf = '';
      continue;
    }
    if (ch === '}') {
      const top = stack.pop();
      if (top && top.head === want) {
        for (const d of top.body.split(';')) {
          const idx = d.indexOf(':');
          if (idx <= 0) continue;
          const prop = norm(d.slice(0, idx));
          if (prop.startsWith('--')) out.set(prop, norm(d.slice(idx + 1)));
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

/** 按档合成终值表：基础 `:root` 打底，`[data-theme=…]` 同名覆盖压上（与浏览器级联同构） */
function layer(themeSelector: string | null): Map<string, string> {
  const map = collectRootDecls(tokensSrc, ':root');
  if (themeSelector) {
    const over = collectRootDecls(themeSelector === 'light' ? lightSrc : mintSrc, themeSelector);
    for (const [k, v] of over) map.set(k, v);
  }
  return map;
}

function findCloseParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 把 `var(--x)` / `var(--x, 兜底)` 迭代展开成字面串；解析不出（无定义且无兜底）返回 null。 */
function expandVars(value: string, map: Map<string, string>): string | null {
  let v = value;
  for (let i = 0; i < 32; i++) {
    const m = /var\(/i.exec(v);
    if (!m || m.index === undefined) return v;
    const open = v.indexOf('(', m.index);
    const close = findCloseParen(v, open);
    if (close < 0) return null;
    const inner = v.slice(open + 1, close);
    let depth = 0;
    let comma = -1;
    for (let j = 0; j < inner.length; j++) {
      const c = inner[j];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) {
        comma = j;
        break;
      }
    }
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? '' : inner.slice(comma + 1).trim();
    const tokenVal = map.get(name);
    const repl = tokenVal !== undefined ? tokenVal : fallback;
    if (repl === '') return null;
    v = v.slice(0, m.index) + repl + v.slice(close + 1);
  }
  return null;
}

const HEX = /^#[0-9a-f]{3,8}$/i;

/* ------------------------------ ① token 单源 ------------------------------ */

describe('缩进导轨：宽度与颜色单源在 tokens.css', () => {
  it('tokens.css 基础 :root 定义三枚导轨刻度，且颜色是描边族别名', () => {
    const base = collectRootDecls(tokensSrc, ':root');
    expect(base.get('--rail-w'), '导轨宽度 token 丢了').toBe('1px');
    expect(base.get('--rail-color'), '导轨静息色不再是 --border 的别名').toBe('var(--border)');
    expect(base.get('--rail-color-strong'), '导轨提亮色不再是 --border-strong 的别名').toBe(
      'var(--border-strong)',
    );
  });

  const TIERS: Array<[string, string | null]> = [
    ['dark', null],
    ['light', "root[data-theme='light']"],
    ['mint-dark', "root[data-theme='mint-dark']"],
  ];

  it('三档下三枚导轨 token 都能解析出值，且颜色随该档 --border 族翻色', () => {
    for (const [id, selector] of TIERS) {
      const map = layer(selector ? `:${selector}` : null);
      const width = expandVars(map.get('--rail-w') ?? '', map);
      const color = expandVars(map.get('--rail-color') ?? '', map);
      const strong = expandVars(map.get('--rail-color-strong') ?? '', map);

      expect(width, `${id} 档的 --rail-w 解析不出`).toBe('1px');
      expect(color, `${id} 档的 --rail-color 解析不出颜色`).toMatch(HEX);
      expect(strong, `${id} 档的 --rail-color-strong 解析不出颜色`).toMatch(HEX);
      // 别名而不是另抄一份 hex：解析结果必须与同档描边族逐字相等
      expect(color, `${id} 档导轨静息色与 --border 脱钩了`).toBe(expandVars(map.get('--border') ?? '', map));
      expect(strong, `${id} 档导轨提亮色与 --border-strong 脱钩了`).toBe(
        expandVars(map.get('--border-strong') ?? '', map),
      );
    }
  });
});

/* ------------------------------ ② 三处消费点 ------------------------------ */

/** 导轨规则里不许再出现的字面：裸 1px（宽度）与裸描边色（颜色） */
function expectNoRailLiterals(body: string, label: string): void {
  const flat = body.replace(/\s+/g, ' ');
  expect(flat, `${label} 还在写裸 1px 导轨宽度`).not.toMatch(/(^|[^\w-])1px\b/);
  expect(flat, `${label} 还在写裸描边色 var(--border)`).not.toContain('var(--border)');
  expect(flat, `${label} 还在写裸描边色 var(--border-strong)`).not.toContain('var(--border-strong)');
}

describe('文件树导轨（file-tree.css）', () => {
  const BASE = '.tree-group > .tree-files::before,';
  const HOVER = '.tree-group > .tree-files:hover::before,';
  const ACTIVE = '.tree-group > .tree-files:has(.tree-file.active)::before,';

  it('宽度 / 静息色 / 提亮色都取导轨 token', () => {
    const base = decls(FILE_TREE, BASE);
    expect(base.get('width'), '文件树导轨宽度没吃 --rail-w').toBe('var(--rail-w)');
    expect(base.get('background'), '文件树导轨静息色没吃 --rail-color').toBe('var(--rail-color)');
    expect(decls(FILE_TREE, HOVER).get('background'), '文件树悬停提亮没吃 --rail-color-strong').toBe(
      'var(--rail-color-strong)',
    );
    expect(decls(FILE_TREE, ACTIVE).get('background'), '文件树选中提亮没吃 --rail-color-strong').toBe(
      'var(--rail-color-strong)',
    );
    for (const [label, marker] of [
      ['静息', BASE],
      ['悬停', HOVER],
      ['选中', ACTIVE],
    ] as const) {
      expectNoRailLiterals(ruleBody(FILE_TREE, marker), `文件树导轨${label}规则`);
    }
  });
});

describe('大纲导轨（outline-panel.css）', () => {
  const PANEL = '.outline-panel {';
  const ROW = '.outline-row {';

  it('局部两档颜色指向导轨 token，渐变里的线宽取 --rail-w', () => {
    const panel = decls(OUTLINE, PANEL);
    expect(panel.get('--outline-guide'), '大纲静息导轨色没指向 --rail-color').toBe('var(--rail-color)');
    expect(panel.get('--outline-guide-strong'), '大纲提亮导轨色没指向 --rail-color-strong').toBe(
      'var(--rail-color-strong)',
    );

    const row = decls(OUTLINE, ROW);
    const image = row.get('background-image') ?? '';
    expect(image, '大纲导轨不再是 repeating-linear-gradient 图样').toContain('repeating-linear-gradient(');
    expect(image, '大纲渐变的线宽没吃 --rail-w').toContain('var(--rail-w)');
    expect(image, '大纲渐变的颜色没吃面板内局部变量 --outline-guide').toContain('var(--outline-guide)');
    expectNoRailLiterals(ruleBody(OUTLINE, ROW), '大纲导轨图样');
  });
});

describe('教程目录层级线（dev-note.css）', () => {
  const BASE = '.wizard.tutorial .tutorial-toc .tutorial-toc-item::before {';
  const STRONG = '.wizard.tutorial .tutorial-toc .tutorial-toc-item:hover::before,';

  it('宽度 / 静息色 / 提亮色都取导轨 token', () => {
    const base = decls(DEV_NOTE, BASE);
    expect(base.get('width'), '教程层级线宽度没吃 --rail-w').toBe('var(--rail-w)');
    expect(base.get('background'), '教程层级线静息色没吃 --rail-color').toBe('var(--rail-color)');
    expect(decls(DEV_NOTE, STRONG).get('background'), '教程层级线提亮没吃 --rail-color-strong').toBe(
      'var(--rail-color-strong)',
    );
    expectNoRailLiterals(ruleBody(DEV_NOTE, BASE), '教程层级线静息规则');
    expectNoRailLiterals(ruleBody(DEV_NOTE, STRONG), '教程层级线提亮规则');
  });
});
