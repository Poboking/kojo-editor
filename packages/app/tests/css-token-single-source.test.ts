/**
 * CSS 自定义属性单源（视觉批十一 · 收尾路 R2 · 债二）。
 *
 * 立论：`var(--x)` 里那个 `--x` 必须**有地方定义**，否则这一格永远吃字面回落——
 * 回落值是人手抄的，主题翻色、档位选择、缩放都追不到它，读代码的人还以为是 token 在生效。
 * 本批点名的实锤就是 `--font-sans`：`styles-project.css` 的 `.nav-badge` 长期写
 * `var(--font-sans, sans-serif)`，而这个 token 全仓从未定义过（改前静态量测），
 * 于是那枚徽章一直在吃死回落，L20 落地的界面字体档位（真源 `ui/font-presets.ts` +
 * tokens.css 的 `--font-ui`）对它完全无效。现在接回 `--font-ui`，本闸钉住不再回潮。
 *
 * 判据（三条，全静态，node 环境跑 readFileSync）：
 *  ① 消费面：任何 CSS 文件里的 `var(--x)` 必须落在下面三个集合之一——
 *     A. 任意 CSS 文件里有 `--x:` 声明（tokens.css / themes/*.css / 切片内的局部作用域）；
 *     B. **由 TS 行内注入**（`style={{ '--x': … }}` / `['--x'] = …` / `setProperty('--x', …)`）；
 *        这一条不是正则放宽：B 的成员逐枚点名（见 INJECTED_ROSTER），并且要验到写入形态本身，
 *        只提一次名字（注释里说说）不算。
 *     C. 兜底豁免名单 FALLBACK_PHANTOM_ROSTER（见下）——历史上"从未定义、只靠字面回落"的幻影
 *        逐枚登记（R2 立账时 22 枚，体感批 B-5 转正三枚老命名残留后 19 枚）；名单是
 *        **只许缩不许涨**的欠账账本。
 *  ② `--font-sans` 全仓不再被引用，且 `.nav-badge` 那格吃的是 `--font-ui`。
 *  ③ 名单即口径：①算出来的三个集合与登记的名单**逐字相等**——新幻影进不来，
 *     转正掉的必须从账上划掉（划不掉的红是故意的）。
 *
 * ⚠ 口径边界（免得下一批误读）：C 里的成员**都带字面回落**（`var(--x, 实值)`），
 * 所以它们今天"看起来是对的"。本闸另加一条硬判据：名单内一枚都不许以**裸 `var(--x)`**
 * 形态出现（裸的 = 声明整体失效，那不是欠账而是坏码）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG_ROOT = fileURLToPath(new URL('../../../packages', import.meta.url));
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === 'coverage') continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const all = walk(PKG_ROOT);
const relOf = (p: string): string => path.relative(PKG_ROOT, p).split(path.sep).join('/');
/** 注释一律先剥：`--diff-hunk` 那类只在注释里"建议将来登记"的名字不该被当成声明或引用 */
const stripCssComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');
/** 块注释 + 行注释都剥（"历史说明注释"允许提死掉的名字，活代码不许） */
const stripComments = (s: string): string => stripCssComments(s).replace(/\/\/[^\n]*/g, '');

const cssFiles = all.filter((p) => p.endsWith('.css'));
const tsFiles = all.filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.ts$/.test(p) && /[/\\]src[/\\]/.test(p));

/** A：任意 CSS 里的 `--x:` 声明（含 tokens.css、themes/*.css 与切片内的局部作用域） */
const declaredInCss = new Set<string>();
/** B：TS 里以写入形态出现的 token 名 */
const injectedFromTs = new Set<string>();
/** 消费面：CSS 里 `var(--x)` 引用的名字 */
const usedInCss = new Map<string, string[]>();
/** 裸引用（无回落）的名字，用于第 ③ 条的硬判据 */
const bareUse = new Map<string, string[]>();
const withFallback = new Map<string, string[]>();

for (const p of cssFiles) {
  const body = stripCssComments(readFileSync(p, 'utf8'));
  for (const m of body.matchAll(/(?:^|[;{\s])(--[A-Za-z0-9-]+)\s*:/g)) declaredInCss.add(m[1]!);
  for (const m of body.matchAll(/var\(\s*(--[A-Za-z0-9-]+)(\s*,)?/g)) {
    const name = m[1]!;
    const bucket = m[2] ? withFallback : bareUse;
    if (!bucket.has(name)) bucket.set(name, []);
    bucket.get(name)!.push(relOf(p));
    if (!usedInCss.has(name)) usedInCss.set(name, []);
    usedInCss.get(name)!.push(relOf(p));
  }
}

for (const p of tsFiles) {
  const body = readFileSync(p, 'utf8');
  for (const m of body.matchAll(/['"`](--[A-Za-z0-9-]+)['"`]/g)) {
    const name = m[1]!;
    // 只认**写入形态**：行内 style 的键 / 计算属性赋值 / setProperty 实参
    const esc = name.replace(/-/g, '\\-');
    const writes = new RegExp(`\\[\\s*['"]${esc}['"]\\s*\\]\\s*=|['"]${esc}['"]\\s*:|setProperty\\(\\s*['"]${esc}['"]`).test(body);
    if (writes) injectedFromTs.add(name);
  }
}

/** 幻影 = 有消费、CSS 没声明、TS 也没注入 */
const phantoms = [...usedInCss.keys()].filter((n) => !declaredInCss.has(n) && !injectedFromTs.has(n)).sort();

/**
 * C · 兜底豁免账（19 枚，逐枚点名）：全部是「从未定义、只靠 `var(--x, 字面回落)` 活着」
 * 的历史幻影（tokens.css L01 那节注释称之「幻影转正」待办）。**这里不放宽判据**——
 * 它们今天渲染得出东西来，是因为回落值就是它们想要的数；转正的代价是给它们一个定义点，
 * 而那属于 L01/L09 的色面工作，不在本路射程。谁转正一枚，就从这本账上划掉一行。
 *
 * 体感批 B-5（2026-10-26）划掉三枚老命名残留：`--bg-1` / `--bg-hover` / `--r-1`——
 * 全仓只剩 `styles-project.css` 的 `.inj-rescan` 一族还在引用它们（三处兜底各写各的字面量），
 * 现已改吃定义点真身：底 → `transparent`（原兜底即终值）、悬停底 → `--wash-neutral`、
 * 圆角 → `--radius-sm`（4px 同值）、描边 → `--border`（`#d8dde3` 那份是浅色档的抄来的死兜底）。
 * 逐字等值由新建的 `styles-wash-token-discipline.test.ts` 拿**改前字面量**当期望值对拍。
 */
const FALLBACK_PHANTOM_ROSTER: readonly string[] = [
  // —— 面板/表格的头部槽位（sticky 头那一族：由消费方按面板写死，从未有定义点）——
  '--head-bg',
  '--head-border',
  '--head-fg',
  '--head-pad-i',
  '--head-pad-y',
  '--sticky-bg',
  '--sticky-z',
  // —— 注记条 / 井 / 发丝线（同族"槽位由调用方给"的历史写法）——
  '--note-bar',
  '--note-fg',
  '--note-pad',
  '--well-bg',
  '--well-radius',
  '--hair-color',
  // —— 芯片与波纹槽位（--chip-* 走回落；--rx/--ry 是"纯 CSS 拿不到指针点"的槽位，见波效应规则注释）——
  '--chip-bg',
  '--chip-fg',
  '--rx',
  '--ry',
  // —— 语义色待转正（kojo2 的 diff 段、ui-kit 的行宽上限）——
  '--diff-hunk',
  '--kit-field-max-width',
];

/**
 * B · 合法的内联注入出口（逐枚点名 + 验到写入形态）：这些名字 CSS 里根本没有定义点，
 * 值由组件按行/按元素现算后写进行内样式——**这是设计如此**，不是漏网。
 * 名单外若冒出新的"TS 注入 + CSS 消费"组合，本闸红：先来说清为什么不是该进 tokens.css。
 */
const INJECTED_ROSTER: readonly [string, string][] = [
  ['--prob-tint', 'app/src/ui/ProblemPanel.tsx'], // 按严重度给行的那层淡底（style={{ '--prob-tint': … }}）
  ['--outline-depth', 'app/src/ui/OutlinePanel.tsx'], // 缩进层级：无单位数字，只有行自己知道自己是第几级
  ['--ksp-gutter', 'app/src/ui/SearchPanel.tsx'], // 结果列的槽位宽：随实测字符数现算
  ['--cm-row-h', 'plugins/ui-condition-matrix/src/index.ts'], // 行视口化：实测行高写回网格（插件侧，非宿主知识）
  ['--cm-rowhead-w', 'plugins/ui-condition-matrix/src/index.ts'], // 首列列宽拖拽后的钉住值
];

describe('CSS 自定义属性单源 · 消费面必须有定义点', () => {
  it('扫到了样式与脚本（防"零文件假绿"）', () => {
    expect(cssFiles.length).toBeGreaterThanOrEqual(25);
    expect(tsFiles.length).toBeGreaterThan(300);
    expect(usedInCss.size).toBeGreaterThan(100);
    expect(declaredInCss.size).toBeGreaterThan(100);
  });

  it(`幻影名单逐字相等：现算 ${phantoms.length} 枚 == 账上 ${FALLBACK_PHANTOM_ROSTER.length} 枚（新增即红，转正就划行）`, () => {
    expect(phantoms).toEqual([...FALLBACK_PHANTOM_ROSTER].sort());
  });

  it('账上每一枚都带字面回落：裸 `var(--x)` 且无定义 = 声明整体失效，那是坏码不是欠账', () => {
    const naked = phantoms.filter((n) => bareUse.has(n));
    expect(naked.map((n) => `${n} @ ${bareUse.get(n)!.join(',')}`), naked.join(' / ')).toEqual([]);
  });

  it('内联注入出口逐枚点名，且验到"真的在写它"这一形态（只在注释里提名字不算）', () => {
    const computed = [...injectedFromTs].filter((n) => usedInCss.has(n) && !declaredInCss.has(n)).sort();
    expect(computed).toEqual(INJECTED_ROSTER.map(([n]) => n).sort());
    for (const [name, file] of INJECTED_ROSTER) {
      const body = readFileSync(path.join(PKG_ROOT, file), 'utf8');
      const esc = name.replace(/-/g, '\\-');
      expect(
        new RegExp(`\\[\\s*['"]${esc}['"]\\s*\\]\\s*=|['"]${esc}['"]\\s*:|setProperty\\(\\s*['"]${esc}['"]`).test(body),
        `${name}：${file} 里没有写入形态（只提名字不算注入）`,
      ).toBe(true);
    }
  });
});

describe('债二本体 · `--font-sans` 幻影已接到界面字体真源', () => {
  it('全仓（CSS 与 TS）不再有对 `--font-sans` 的**活引用**（历史说明注释里提名字不算）', () => {
    const refs: string[] = [];
    for (const p of [...cssFiles, ...tsFiles]) {
      const body = stripComments(readFileSync(p, 'utf8'));
      if (/--font-sans\b/.test(body)) refs.push(relOf(p));
    }
    expect(refs, `--font-sans 又回来了：${refs.join(', ')}`).toEqual([]);
  });

  it('.nav-badge 那格改吃 --font-ui（界面字体的真源：ui/font-presets.ts + tokens.css）', () => {
    const css = read('../src/styles-project.css');
    const body = stripCssComments(css);
    const i = body.indexOf('.nav-badge {');
    expect(i, 'styles-project.css 里找不到 .nav-badge 规则').toBeGreaterThan(-1);
    const block = body.slice(i, body.indexOf('}', i));
    expect(block).toMatch(/font-family:\s*var\(--font-ui\);/);
    expect(block).not.toMatch(/--font-sans/);
  });

  it('--font-ui 确有定义点（tokens.css 的 :root 那行 + UI_FONT_CSS_LINE 逐字在册）', () => {
    expect(declaredInCss.has('--font-ui')).toBe(true);
    expect(read('../src/tokens.css')).toContain('--font-ui:');
  });
});
