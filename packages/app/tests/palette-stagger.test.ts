/**
 * 命令面板逐行入场（1027 palette-stagger 批）的静态判据。
 *
 * 口径照 `motion-surface.test.ts` / `palette-groups.test.ts`：本仓测试环境是 node（无 jsdom），
 * DOM 那半边用 `react-dom/server` 静态渲染钉"类挂没挂上"，CSS 那半边读源码做文本断言——
 * 量不到的正是"有没有做成那一招"，而恰恰这一半最容易在后续批次里被无声拆掉：
 *  - 把 `stagger` 类摘了 ⇒ 面板回到"一整块弹出来"（没有任何一道闸会红）；
 *  - 在 `palette.css` 里手写第二套节拍（`animation:` 简写会把 `animation-delay` 复位成 0，
 *    等于当场拆掉机器的阶梯，再自己补一份延迟）；
 *  - 把压平闸的 `animation-delay: 0s` 漏掉 ⇒ 减弱档"先空一拍再出现"（`ui/motion-surface.css`
 *    头部踩过的那条坑：全局压时规则只压 duration，压不到 delay）；
 *  - 把选中行那 2px 从 `transform` 换回 `margin/padding` ⇒ 每次 ↑↓ 逐行重排。
 * 判据一律"改后不许更少"：每条都能单独把对应实现注错试红，实测读数写进本批提交信息。
 *
 * 路径从 file URL 还原（中文路径的 checkout 上硬编码盘符必红）。
 */
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EditorCommandContext } from '@kojo/plugin-api';
import { CommandPalette, QuickOpen } from '../src/ui/Palette';
import type { CommandEntry } from '../src/ui/commands';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 块注释剥掉：注记里要引用改前的旧写法与旧值（`both`、`--dur-3`），活代码才算判据 */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');
/** 空白压平：多行写法与单行写法是同一件事（CSS 语义），正则才不用管换行 */
const flat = (s: string): string => stripComments(s).replace(/\s+/g, ' ').trim();

const paletteCss = read('../src/ui/palette.css');
const stylesCss = read('../src/styles.css');
const tokensCss = read('../src/tokens.css');
const flatPalette = flat(paletteCss);

/* ---------------- 取自本仓真源的数值（判据不吃字面量，token 一改判据跟着改） ---------------- */

const tokenMs = (name: string): number => {
  const m = new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)ms`).exec(tokensCss);
  expect(m, `tokens.css 里 ${name} 不见了或不再是 ms`).not.toBeNull();
  return Number(m![1]);
};
const STAGGER_MS = tokenMs('--stagger');
const DUR1_MS = tokenMs('--dur-1');

/** 选择器的 (0, a, 0) 那一档：类 / 属性 / 伪类各算一枚（`*` 与元素级不算） */
const classWeight = (selector: string): number =>
  (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+(?:\([^)]*\))?/g) ?? []).length;

/** 取某条规则的正文（只在压平后的源码上找；本仓判据一贯口径） */
const ruleBody = (selector: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(flatPalette);
  expect(m, `palette.css 里找不到规则：${selector}`).not.toBeNull();
  return m![1]!;
};

/* ---------------- 渲染面（与 palette-groups 同一份最小命令表） ---------------- */

const CTX: EditorCommandContext = { project: null };
const FILE_A = 'C:\\game\\ERB\\口上A.ERB';
const CMD: readonly CommandEntry[] = [
  { id: 'workbench.saveAll', title: '全部保存', category: '工作台', keybinding: 'ctrl+shift+s', run: () => undefined },
  { id: 'workbench.closeAll', title: '关闭全部', category: '工作台', run: () => undefined },
  { id: 'layout.toggleZen', title: '切换写作模式', category: '布局', run: () => undefined },
];

const paletteHtml = (): string =>
  renderToStaticMarkup(createElement(CommandPalette, { commands: CMD, commandCtx: CTX, onClose: () => undefined }));

const quickOpenHtml = (): string =>
  renderToStaticMarkup(
    createElement(QuickOpen, {
      files: [FILE_A],
      commands: CMD,
      commandCtx: CTX,
      activeFileSymbols: () => null,
      activeFile: FILE_A,
      onOpenFile: () => undefined,
      onReveal: () => undefined,
      onClose: () => undefined,
    }),
  );

describe('① 逐行入场接的是既有那台机器（.stagger + --stagger，不新造）', () => {
  it('命令面板的列表容器真挂了 stagger（与 pk-list 同一枚 div，选择器才命中）', () => {
    expect(paletteHtml()).toContain('picker-list pk-list stagger');
  });

  it('作用域不外溢：快速打开的文件模式（default 档）一行都不入场', () => {
    const html = quickOpenHtml();
    expect(html).not.toContain('stagger');
    expect(html).not.toContain('pk-list');
  });

  it('机器本体仍在 styles.css（本批没搬、没抄）：.stagger 的阶梯吃 --stagger', () => {
    expect(flat(stylesCss)).toMatch(
      /\.stagger > \* \{ animation: u-rise var\(--dur-\d\) var\(--ease-[a-z]+\)(?: both)?; \}/,
    );
    expect(flat(stylesCss)).toMatch(/\.stagger > \*:nth-child\(2\) \{ animation-delay: calc\(var\(--stagger\) \* 1\); \}/);
    expect(tokensCss).toMatch(/--stagger:\s*\d+ms/);
  });

  it('palette.css 只以 longhand 收口（animation: 简写会把 animation-delay 复位 = 拆机器）', () => {
    for (const m of flatPalette.matchAll(/animation:\s*([^;]+);/g)) {
      expect(m[1]!.trim(), `出现了 animation: 简写「${m[1]}」`).toBe('none');
    }
    expect(flatPalette).toMatch(/animation: none;/); // 压平闸靠它关掉名字（见 describe ③）
  });

  it('时长降档吃 --dur-1（与文件树行同一把尺），缓动与关键帧仍由机器给（本文件不写死时长）', () => {
    expect(ruleBody('.picker-list.pk-list.stagger > *')).toMatch(/animation-duration: var\(--dur-1\);/);
    // 除压平闸里那枚刻意的 `0s`（0 = 关掉，不是节奏），本文件一条裸时长都不写
    const bare = [...stripComments(paletteCss).matchAll(/(?:animation|transition)[^;{}]*:[^;{}]*/g)]
      .map((m) => m[0] ?? '')
      .filter((decl) => /\b[1-9][\d.]*(ms|s)\b/.test(decl));
    expect(bare, `裸时长回潮：${bare.join(' | ')}`).toEqual([]);
  });

  it('填充收成 backwards：both 的 forwards 段会把终帧 transform: none 永久钉在行上（选中行位移就废了）', () => {
    expect(ruleBody('.picker-list.pk-list.stagger > *')).toMatch(/animation-fill-mode: backwards;/);
    expect(flatPalette).not.toMatch(/animation-fill-mode:\s*both/);
  });
});

describe('② 上限策略：阶梯在第 5 个封顶（首屏读得出内容，而不是动画排满）', () => {
  const plateau = /animation-delay: calc\(var\(--stagger\) \* (\d+)\)/.exec(
    ruleBody('.picker-list.pk-list.stagger > *:nth-child(n + 5)'),
  );

  it('平台段存在，且节拍仍来自 --stagger × 一个有限的台阶', () => {
    expect(plateau, 'palette.css 里的截断阶梯不在了').not.toBeNull();
    expect(Number(plateau![1])).toBeGreaterThanOrEqual(1);
  });

  it('封顶台阶 × 节拍 + 入场时长 ≤ 320ms：最晚一行也在首屏预算内到齐', () => {
    const budgetMs = Number(plateau![1]) * STAGGER_MS + DUR1_MS;
    // 机器默认排到 ×8 = 360ms（欢迎卡那种大块才需要），命令面板是"打开即读"的键盘面
    expect(budgetMs, `最晚一行要 ${budgetMs}ms 才到齐（> 首屏预算）`).toBeLessThanOrEqual(320);
  });

  it('形状是平台段而非取模：第 5 个起的深列同帧到齐（照机器 n+9 / 树行 n+7 的招式）', () => {
    expect(flatPalette).toMatch(/\.picker-list\.pk-list\.stagger > \*:nth-child\(n \+ 5\) \{/);
    expect(flatPalette).not.toMatch(/nth-child\(\s*\d+\s*n/); // 取模（`2n`/`3n+1`）会让深列错峰到几百毫秒
  });

  it('截断选择器比机器的阶梯更 Specific（组件 CSS 先于 styles.css 注入，同分必输）', () => {
    expect(classWeight('.picker-list.pk-list.stagger > *:nth-child(n + 5)')).toBeGreaterThan(
      classWeight('.stagger > *:nth-child(n + 9)'),
    );
    expect(classWeight('.picker-list.pk-list.stagger > *')).toBeGreaterThan(classWeight('.stagger > *'));
  });
});

describe('③ 压平闸：减弱档 delay 显式归零，且压得住阶梯', () => {
  /** 取某条前缀（选择器 / @media 头）后面第一条规则的正文；找不到就返回空串，让断言自己红 */
  const blockAfter = (prefix: string): string => {
    const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${esc}[^{]*\\{([^}]*)\\}`).exec(flatPalette)?.[1] ?? '';
  };

  for (const prefix of ['@media (prefers-reduced-motion: reduce)', ":root[data-motion='reduced']"]) {
    it(`${prefix} 这档：关 animation + delay 归零 + 关 transition 三条都在`, () => {
      const body = blockAfter(prefix);
      expect(body, `缺这一档的压平规则：${prefix}`).not.toBe('');
      expect(body).toContain('animation: none;');
      expect(body).toContain('animation-delay: 0s;');
      expect(body).toContain('transition: none;');
    });
  }

  it('压平选择器点名了 stagger 列表，且特异性高于最深的那级阶梯', () => {
    const mediaSel = /@media \(prefers-reduced-motion: reduce\) \{ ([^,{]+),/.exec(flatPalette)?.[1] ?? '';
    const attrSel = /(:root\[data-motion='reduced'\][^{,]*),/.exec(flatPalette)?.[1] ?? '';
    for (const [sel, label] of [[mediaSel, '@media 档'], [attrSel, "data-motion='reduced' 档"]] as const) {
      expect(sel, `${label} 没覆盖 stagger 列表`).toContain('.picker-list.pk-list.stagger');
      expect(sel, `${label} 没命中每个子元素（只压了部分行 = 深列仍先空一拍）`).toContain(':nth-child(n)');
      expect(classWeight(sel), `${label} 压不过本面那条截断阶梯`).toBeGreaterThan(
        classWeight('.picker-list.pk-list.stagger > *:nth-child(n + 5)'),
      );
    }
  });

  it('选中行的位移过渡在减弱档一起关掉（减弱要的是瞬间换行，不是 70ms 滑动）', () => {
    expect(flatPalette).toMatch(/:root \.pk-list \.picker-item \{ animation: none; animation-delay: 0s; transition: none; \}/);
    expect(flatPalette).toMatch(
      /:root\[data-motion='reduced'\] \.pk-list \.picker-item \{ animation: none; animation-delay: 0s; transition: none; \}/,
    );
  });
});

describe('④ 选中行的反馈：只有 2px transform，零重排属性', () => {
  it('active 那格挂的是 translateX，位移量取自 --space-0（token 里就是 2px）', () => {
    expect(ruleBody('.pk-list .picker-item.active')).toMatch(/transform: translateX\(var\(--space-0\)\);/);
    expect(tokensCss).toMatch(/--space-0:\s*2px/);
  });

  it('红线：active 规则里不出现 width / height / margin / padding / left / top（逐行重排）', () => {
    const body = ruleBody('.pk-list .picker-item.active');
    expect(stripComments(body)).not.toMatch(/(?:^|;)\s*(?:min-|max-)?(?:width|height|margin|padding|left|top)[^;]*;/);
  });

  it('过渡表里 transform 与 background-color 同拍同曲线，全吃 --dur-*/--ease-*', () => {
    expect(flatPalette).toMatch(
      /transition: background-color var\(--dur-[a-z0-9]+\) var\(--ease-[a-z]+\), transform var\(--dur-[a-z0-9]+\) var\(--ease-[a-z]+\);/,
    );
  });

  it('整张文件的过渡都不许碰布局属性（本面的位移只有一条通道）', () => {
    expect(flatPalette).not.toMatch(/transition: [^;]*(?:width|height|margin|padding|left|top)\b/);
  });
});
