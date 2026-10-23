// @vitest-environment happy-dom
/**
 * 批次十一 L03（问题面板视觉族）的交付闸。
 *
 * 口径一句话：**屏幕上不再有字符图标、不再有裸生控件，而对面两批的功能腿
 * （1023 右键面 / 1020 行导航 + ARIA）与工包 E 的读数契约一根都不能少**。
 *
 * 四组判据：
 * 1. **字符图标清零（上屏腿）**：`▸ ▾ ✅` 全文件绝迹；`✕ ⚠ ℹ` 只许住在
 *    `SEVERITY_GLYPH` 那枚**读数腿**常量里（CSS 视觉隐藏，屏幕阅读器与
 *    `problem-truth-single-source` 那把尺共用）——渲染后的面板 markup 里，
 *    每一枚 ✕⚠ℹ 都必须落在 `.prob-count-sr` 格内，图标本体一律 `icons.tsx` 的 SVG。
 * 2. **工具条没有裸生控件**：`select` 必穿 `.prob-select` 住在 `.prob-select-wrap`
 *    井里并配 SVG 箭头；`input[type=checkbox]` 必是 `.prob-check-input`（视觉隐藏、
 *    语义腿仍原生）配 `.prob-check-box` 自绘方框——原生控件留在 DOM 是**设计**
 *    （键盘 / 弹层 / 对面 `problem-menu` 让位给全局输入框面的判据都吃它），
 *    被禁的是"裸 native 外观落进全局 button/select 默认档"。
 * 3. **token 与滚动收口**：`problem-panel.css` 的 `border-radius` 只许
 *    `var(--radius-*)` 或重置用的 `0`（与已合流 `search-panel.css` 的 `ksp-input`
 *    同一档）；`.prob-list` 不再自带 `max-height`/`overflow`（双重滚动交回
 *    `.container-body`），`styles-project.css` 里旧 `.prob-*` 单类段已删净。
 * 4. **空态走统一语言**：零诊断时出 `.conv-empty.prob-empty` + `check` SVG
 *    （与约定校验面板共用 `.conv-empty` 那一族，不是再造一套空态）。
 *
 * 对面功能的驻留用同一份 markup 反证：根上有 `data-context-surface="problems"`、
 * 行上有 `data-problem-row` + 身份三属性、勾选/下拉/输入都带 `aria-label`、
 * 组头 `aria-expanded`——rebase 合流后这些若被视觉改造挤掉，这里当场红。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProblemPanel } from '../src/ui/ProblemPanel';
import { clearAllProblems, setProblems, type EditorProblem } from '../src/ui/problem-store';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const panelSrc = read('../src/ui/ProblemPanel.tsx');
const cssSrc = read('../src/problem-panel.css');
const projectCss = read('../src/styles-project.css');
const mainSrc = read('../src/main.tsx');

const F1 = 'C:/game/ERB/001/M_KOJO_K1_1.ERB';
const F2 = 'C:/game/ERB/002/M_KOJO_K2_1.ERB';

const mk = (over: Partial<EditorProblem> = {}): EditorProblem => ({
  path: F1,
  line: 3,
  severity: 'error',
  message: '结构不闭合',
  ...over,
});

/** 两来源 × 三严重级：把工具条（下拉出现）、分组头、三枚计数徽标全画一遍 */
const fullStore = (): void => {
  setProblems(F1, [
    mk(),
    mk({ line: 9, severity: 'warning', message: '表达式缺 else', source: 'condition-extractor' }),
    mk({ line: 12, severity: 'info', message: '提示', source: 'condition-extractor' }),
  ]);
  setProblems(F2, [mk({ path: F2, source: 'erb-parser' })]);
};

afterEach(() => clearAllProblems());

describe('字符图标清零：▸▾✅ 绝迹，✕⚠ℹ 只住读数腿', () => {
  it('源码里 ▸ ▾ ▶ ◀ ✓ ✅ 一个都不剩（组头折叠箭头已换 icons.tsx 的 chevron SVG）', () => {
    for (const glyph of ['\u25B8', '\u25BE', '\u25B6', '\u25C0', '\u2713', '\u2705']) {
      expect([...panelSrc].filter((c) => c === glyph), `ProblemPanel.tsx 残留 ${glyph}`).toHaveLength(0);
      expect([...cssSrc].filter((c) => c === glyph), `problem-panel.css 残留 ${glyph}`).toHaveLength(0);
    }
    expect(panelSrc).toContain("'chevron-right'");
    expect(panelSrc).toContain("'chevron-down'");
  });

  it('✕ ⚠ ℹ 三字符在源码里只出现在注释、读数腿常量与状态栏读数契约里', () => {
    // 面板上屏腿不许再写字符：JSX 里 `>✕` / `{SEVERITY_GLYPH…}` 只许经读数腿一格出字
    const glyphLines = panelSrc
      .split('\n')
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /[✕⚠ℹ]/.test(l))
      .map(({ l, i }) => `${i + 1}: ${l.trim()}`);
    for (const line of glyphLines) {
      // 注释行（模块/常量的口径说明）
      if (/^\s*(\*|\/\*|\/\/)/.test(line.replace(/^\d+: /, ''))) continue;
      // 读数腿常量本体（SEVERITY_GLYPH 的三行）
      if (/error: '✕'|warning: '⚠'|info: 'ℹ'/.test(line)) continue;
      // 状态栏 ProblemsStatusItem 的读数契约：`statusCounts` 那把尺按
      // `.sb-problems-item` 的首个文本节点（`✕ n`）取数（problem-truth-single-source 钉死），
      // 换形要连那把尺一起换——不在本 lane 的文件边界内，留组长按排期并线。
      if (/✕ \{error\}|⚠ \{warning\}|ℹ \{info\}/.test(line)) continue;
      expect.fail(`ProblemPanel.tsx 出现计划外的字符图标行：${line}`);
    }
  });

  it('SSR：面板 markup 里每枚 ✕⚠ℹ 都落在 .prob-count-sr 读数腿内，图标本体全是 SVG', () => {
    fullStore();
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    const stripped = markup.replace(/<span class="prob-count-sr">[^<]*<\/span>/g, '<!--sr-->');
    for (const glyph of ['✕', '⚠', 'ℹ']) {
      expect([...stripped].filter((c) => c === glyph), `上屏腿混进字符 ${glyph}`).toHaveLength(0);
    }
    // 组头三档徽标的可见腿 = SVG（error/warning/info 各自的名字进 icon 类）
    expect(markup).toContain('class="icon prob-count-icon');
    // 读数腿仍在（工包 E 那把尺的取数点：>✕ n< 文本形态；组头各数各组，这里两枚 ✕ 1）
    expect(markup).toContain('<span class="prob-count-sr">✕ 1</span>');
    expect(markup).toContain('<span class="prob-count-sr">⚠ 1</span>');
    expect(markup).toContain('<span class="prob-count-sr">ℹ 1</span>');
  });
});

describe('工具条：原生控件只许穿 prob 族的外衣', () => {
  it('select 必穿 .prob-select 住 .prob-select-wrap，配 SVG 箭头（不穿回全局默认档）', () => {
    fullStore();
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    expect(markup).toContain('class="prob-select-wrap"');
    expect(markup).toContain('<select class="prob-filter prob-select"');
    expect(markup).toContain('class="icon prob-select-caret"');
    // 裸生 select（没有 prob-select 的）一个都不许有
    const selects = [...markup.matchAll(/<select\b([^>]*)>/g)].map((m) => m[1] ?? '');
    expect(selects.length).toBeGreaterThan(0);
    for (const attrs of selects) expect(attrs).toContain('prob-select');
  });

  it('checkbox 必是 KitCheck 族：语义腿（真 input）留着，外观腿是自绘方框 + check SVG', () => {
    // 剥掉注释再数：只有 KitCheck 一处产 checkbox 元素，别处再冒原生勾选就是回流
    const codeOnly = panelSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const checks = [...codeOnly.matchAll(/type="checkbox"/g)];
    expect(checks.length).toBe(1);
    fullStore();
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    const boxes = [...markup.matchAll(/<input([^>]*)>/g)].filter((m) => (m[1] ?? '').includes('checkbox'));
    expect(boxes.length).toBe(3); // 三档严重级各一枚
    for (const box of boxes) {
      expect(box[1]).toContain('prob-check-input');
    }
    expect(markup).toContain('class="prob-check-box"');
    expect((markup.match(/class="icon prob-check-glyph"/g) ?? []).length).toBe(3);
  });

  it('过滤输入井与检索面板 ksp-field 同族：input 无框、焦点环画在井上', () => {
    fullStore();
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    expect(markup).toContain('class="prob-field"');
    expect(markup).toContain('class="prob-filter prob-input"');
  });
});

describe('token 与滚动收口', () => {
  it('problem-panel.css 的 border-radius 只许 var(--radius-*) 或重置用的 0', () => {
    const offenders = [...cssSrc.matchAll(/border-radius:\s*([^;]+);/g)]
      .map((m) => (m[1] ?? '').trim())
      .filter((v) => v !== '0' && !/^var\(--radius-[a-z]+\)$/.test(v));
    expect(offenders, `裸数字圆角: ${offenders.join(', ')}`).toEqual([]);
    // 全部半径声明都在这两个合法形态里
    expect([...cssSrc.matchAll(/border-radius:/g)].length).toBeGreaterThan(8);
  });

  it('.prob-list 不再自带 max-height/overflow（双重滚动交回 .container-body）', () => {
    const listRule = cssSrc.slice(
      cssSrc.indexOf('.panel-problems.prob .prob-list'),
      cssSrc.indexOf('.panel-problems.prob .prob-group'),
    );
    expect(listRule).toContain('max-height: none');
    expect(listRule).not.toMatch(/overflow:\s*auto/);
    // styles-project.css 的旧单类段删净：不再有任何 `.prob-* {` 规则体（注释里提到不算）
    expect(projectCss).not.toMatch(/^\.prob-(list|item|code)\s*\{/m);
    expect(projectCss).not.toMatch(/^\.panel-problems\s*\{/m);
  });

  it('problem-panel.css 在 main.tsx 的静态样式链里（首屏可见，不随项目懒块后到）', () => {
    expect(mainSrc).toContain("import './problem-panel.css';");
  });

  it('KitCount 的 ui-kit-candidate 标记在 CSS 与组件两侧都在（收编线索不丢）', () => {
    expect(cssSrc).toContain('ui-kit-candidate: KitCount');
    expect(panelSrc).toContain('ui-kit-candidate: KitCount');
  });
});

describe('空态走统一 EmptyState 语言（.conv-empty 族，不是再造一套）', () => {
  it('零诊断 ⇒ conv-empty + prob-empty + check SVG + 一句话', () => {
    clearAllProblems();
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    expect(markup).toContain('class="conv-empty prob-empty dim"');
    expect(markup).toContain('未发现问题');
    expect(markup).toContain('class="icon prob-empty-icon"');
    expect(markup).not.toContain('✅');
  });

  it('过滤筛光 ≠ 没问题：prob-empty-filtered 单独说话并指出清除入口（铁律 4）', () => {
    // 文本过滤把所有条目筛光的形态由源码闸钉：两态类名与文案判据分居两处
    expect(panelSrc).toContain('"conv-empty prob-empty-filtered dim"');
    expect(panelSrc).toContain('没有匹配过滤条件的问题');
    expect(cssSrc).toContain('.prob-empty-filtered');
  });
});

describe('rebase 合流驻留闸：对面的功能腿与 ARIA 都在', () => {
  it('1023 右键面：根认领 surface、行带身份三属性', () => {
    fullStore();
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    expect(markup).toContain('data-context-surface="problems"');
    expect(markup).toContain('data-problem-row=""');
    expect(markup).toContain(`data-problem-path="${F1}"`);
    expect(markup).toContain('data-problem-code=');
  });

  it('ARIA 面：勾选/下拉/输入有无障碍名，组头有 aria-expanded，读数腿之外 aria-hidden 归位', () => {
    fullStore();
    const markup = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    expect(markup).toContain('aria-label="按诊断来源过滤问题"');
    expect(markup).toContain('aria-label="按消息、诊断码、来源或路径过滤问题"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('<span class="prob-count-num" aria-hidden="true">');
    expect(markup).toContain('<span class="prob-check-box" aria-hidden="true">');
  });
});
