/**
 * VIS-63（1026 编辑器体感 E1）：补全 / hover 弹层的宿主侧切片判据。
 *
 * 钉的是**形状**而不是观感（真机观感归组长的壳取证）：切片在册且真被 import、零硬编码色、
 * 字号只吃刻度、度量对齐既有浮层那四件 token、选中条走 inset 阴影、过渡不含几何量、
 * 每条弹层选择器都靠 `:root` 抬特异性（与注入顺序解耦）、减弱动效自带豁免。
 *
 * 静态读源码（node 环境），与 `css-slices-wired.test.ts` / `css-token-single-source.test.ts`
 * 同一口径；不在注释里写任何 vitest 环境指令字面量（见 PITFALLS 183）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const CSS_PATH = path.join(SRC, 'ui', 'editor-widget.css');
const css = readFileSync(CSS_PATH, 'utf8');
/** 判据一律看剥掉注释后的正文（注释里可以提死掉的名字，活代码不许） */
const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
const hostSource = readFileSync(path.join(SRC, 'ui/editor-pane/use-monaco-instance.ts'), 'utf8');

/** `selectorText { … }` 的 selectorText 全表（`@media` 那条也会被当成一段，按内容筛掉） */
const selectors = [...body.matchAll(/([^{}]+)\{/g)]
  .map((m) => m[1]!.trim())
  .filter((s) => s.length > 0 && !s.startsWith('@'));
/** 命中两枚弹层（含文档面板）的选择器——本文件的全部射程 */
const widgetSelectors = selectors
  .filter((s) => /suggest-widget|suggest-details|monaco-hover/.test(s))
  .flatMap((s) => s.split(',').map((one) => one.trim()))
  .filter((s) => /suggest-widget|suggest-details|monaco-hover/.test(s));

/** 所有 `transition:` / `animation:` 声明的值段 */
const timingDecls = [
  ...[...body.matchAll(/\btransition:\s*([^;]+);/g)].map((m) => ({ prop: 'transition', value: m[1]!.trim() })),
  ...[...body.matchAll(/\banimation:\s*([^;]+);/g)].map((m) => ({ prop: 'animation', value: m[1]!.trim() })),
];

describe('VIS-63 切片在册', () => {
  it('文件非空且被真 import（只认 import 语句，注释提文件名不算）', () => {
    expect(body.length, 'editor-widget.css 正文为空').toBeGreaterThan(200);
    expect(hostSource).toMatch(/import\s*['"][^'"]*editor-widget\.css['"]/);
  });

  it('射程覆盖两块弹层（补全 widget 与 hover widget 都要有落点）', () => {
    expect(widgetSelectors.length, '弹层选择器一条都没扫到').toBeGreaterThan(8);
    expect(selectors.some((s) => /\.suggest-widget/.test(s)), '补全 widget 没被接管').toBe(true);
    expect(selectors.some((s) => /\.monaco-hover/.test(s)), 'hover widget 没被接管').toBe(true);
    expect(selectors.some((s) => /\.suggest-details/.test(s)), '补全文档面板没被接管').toBe(true);
  });
});

describe('VIS-63 硬约束①：全部吃 var()，不写死颜色', () => {
  it('正文零十六进制色（注释里的例子不算）', () => {
    const hex = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    expect(hex, `写死的色值：${hex.join(' ')}`).toEqual([]);
  });

  it('rgb()/hsl() 只许套 var()（带 alpha 的派生色必须有 token 来源）', () => {
    const bad = [...body.matchAll(/\b(?:rgba?|hsla?)\(([^)]*)\)/g)]
      .filter((m) => !m[1]!.includes('var('))
      .map((m) => m[0]!);
    expect(bad, `裸分量色函数：${bad.join(' ')}`).toEqual([]);
  });

  it('本切片不代填 monaco 的主题表（--vscode-* 一枚都不声明——配色归 monaco/theme.ts）', () => {
    expect(body).not.toMatch(/--vscode-[A-Za-z0-9]+\s*:/);
  });
});

describe('VIS-63 硬约束②：字号只吃 --fs-* 六档', () => {
  it('每一处 font-size 都是 var(--fs-…)，且全文件零裸 px 字号', () => {
    const sizes = [...body.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(sizes.length, '一处字号都没写：刻度那条判据要的是"写就必须吃 token"').toBeGreaterThan(0);
    for (const v of sizes) expect(v, `font-size: ${v} 不吃 --fs-*`).toMatch(/^var\(--fs-[a-z0-9]+\)$/);
    expect(body).not.toMatch(/font-size:\s*\d+(\.\d+)?px/);
  });

  it('浮层度量四件齐：表面 / 描边 / 圆角 / 抬升', () => {
    for (const token of ['--surface-overlay', '--radius-lg', '--shadow-2']) {
      expect(body, `没用到 var(${token})`).toContain(`var(${token})`);
    }
    expect(body).toMatch(/border:\s*1px solid var\(--border\)/);
  });
});

describe('VIS-63 硬约束③：零布局抖动', () => {
  it('选中条走 box-shadow: inset，不靠几何量（宽 / 高 / 边框粗细）表达', () => {
    const focused = body.match(/\.monaco-list-row\.focused\s*\{([^}]*)\}/);
    expect(focused, '没找到选中行那一条规则').not.toBeNull();
    const decls = focused![1]!;
    expect(decls).toMatch(/box-shadow:\s*inset\s/);
    expect(decls).not.toMatch(/\b(width|height|padding|margin)\s*:/);
    expect(decls).not.toMatch(/border-(left|right|top|bottom)-width/);
  });

  it('transition 的属性表里一个几何量都没有（也不许 all）；animation 只许淡入淡出那一族', () => {
    const ALLOWED = new Set(['background-color', 'box-shadow', 'color', 'opacity', 'border-color', 'outline-color']);
    const offenders: string[] = [];
    for (const { prop, value } of timingDecls.filter((d) => d.prop === 'transition')) {
      if (value === 'none') continue;
      for (const seg of value.split(',')) {
        const name = seg.trim().split(/\s+/)[0] ?? '';
        if (!ALLOWED.has(name)) offenders.push(`${prop}: ${name}`);
      }
    }
    expect(offenders, `动了布局属性的动效：${offenders.join(' / ')}`).toEqual([]);
    expect(timingDecls.length, '本切片一处动效都没写（判据就空转了）').toBeGreaterThan(2);
    // animation 那一段的首个 token 是 keyframes 名，不是属性名：只拦"动几何时程"那一类
    for (const { prop, value } of timingDecls.filter((d) => d.prop === 'animation')) {
      expect(value, `${prop}: ${value} 里混进了几何量`).not.toMatch(/\b(width|height|padding|margin|top|left|transform)\b/);
    }
  });
});

describe('VIS-63 硬约束④：靠特异性取胜，不靠注入顺序', () => {
  it('每一条命中弹层的选择器都以 :root 起头（vendor 的 (0,2,0) 族必须被压过）', () => {
    const naked = widgetSelectors.filter((s) => !s.startsWith(':root'));
    expect(naked, `没有 :root 前缀的弹层选择器：${naked.join(' , ')}`).toEqual([]);
  });

  it('hover 那两层（外壳 / 内容）都用双类抬级：与 list 运行时追加的样式表比顺序无关', () => {
    expect(body).toMatch(/:root \.monaco-editor \.monaco-hover\.monaco-hover\b/);
    expect(body).toMatch(/:root \.monaco-editor \.monaco-resizable-hover\.monaco-resizable-hover\b/);
    // 外壳在场时内容层退让（那条必须比通用那条更高一级，否则面会画两遍）
    expect(body).toMatch(/:root \.monaco-editor \.monaco-resizable-hover\.monaco-resizable-hover > \.monaco-hover\b/);
  });

  it('候选行那一族把 vendor 的类链抄齐再补 .monaco-list-rows（(0,4,0) 起步的都在射程外）', () => {
    const rowRules = widgetSelectors.filter((s) => /\.monaco-list-row\b/.test(s));
    expect(rowRules.length).toBeGreaterThan(4);
    for (const s of rowRules) expect(s, `${s} 少了 .monaco-list-rows 那一级`).toContain('.monaco-list-rows');
  });
});

describe('VIS-63 硬约束⑤：减弱动效自带豁免', () => {
  it('两条开关都在册，并把本文件的局部节奏变量压成 0ms', () => {
    expect(body).toMatch(/:root\[data-motion='reduced'\]:root \.monaco-editor\s*\{[^}]*--ew-dur:\s*0ms/);
    expect(body).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?--ew-dur:\s*0ms/);
  });

  it('动效时长只从那一格局部变量取（谁也别再直接吃 --dur-*，否则豁免会漏落点）', () => {
    const direct = timingDecls.filter(({ value }) => value.includes('var(--dur-') || value.includes('var(--ease-'));
    expect(direct.map((d) => `${d.prop}: ${d.value}`), '绕过 --ew-* 那格的动效声明').toEqual([]);
    for (const { value } of timingDecls) {
      if (value === 'none') continue;
      expect(value, `这条没有吃局部节奏：${value}`).toContain('var(--ew-');
    }
  });
});
