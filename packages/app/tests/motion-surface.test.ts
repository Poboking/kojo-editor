/**
 * 1026 前端体感批 · 车道 A 的静态判据（VIS-31 / 32 / 33 / 34 / 35）。
 *
 * 为什么全是"读源码做文本断言"：这一车道改的是**手感**——过渡曲线、位移走哪条属性、
 * 骨架有没有接上。真壳像素归组长复验，node 池量不到；但"有没有做、有没有做成那一招"
 * 的一半能静态钉死，而恰恰是这一半最容易在后续批次里被无声拆掉：
 *  - 把 `transition` 从 `transform` 换回 `left` / `width`（每帧重排，"零布局抖动"是这仓的既有纪律）；
 *  - 把 `--anim-*` / `--dur-*` 又写成字面秒数（token 族回潮成"登记了没人吃"）；
 *  - `data-motion` 的档位值写错（VIS-35 就是这么坏了一条规则，静默了整整一批）。
 * 口径照 `css-font-size-scale.test.ts` / `ui-kit-css.test.ts`：注释先剥（旧值的说明文字不算违规），
 * 空白压平（多行写法与单行写法是同一件事，这是 CSS 语义不是放宽判据）。
 * 路径一律从 file URL 还原——中文路径的 checkout 上硬编码盘符必红。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 块注释剥掉：注记里允许引用改前的旧值与旧写法，活代码才算判据 */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');
/** 空白压平（换行与缩进不参与判断） */
const flat = (s: string): string => stripComments(s).replace(/\s+/g, ' ').trim();

const fileTreeCss = read('../src/file-tree.css');
const tabsBarCss = read('../src/tabs-bar.css');
const outlineCss = read('../src/outline-panel.css');
const noticesCss = read('../src/shell-notices.css');
const updateCss = read('../src/update-dialog.css');
const settingsCss = read('../src/settings-search.css');
const motionCss = read('../src/ui/motion-surface.css');
const tokensCss = read('../src/tokens.css');
const fileTreeTsx = read('../src/ui/FileTree.tsx');
const tabsBarTsx = read('../src/ui/tabs-bar.tsx');
const motionPrefTs = read('../src/ui/motion-pref.ts');

/** 取 `@keyframes 名字 { … }` 的正文（本仓 keyframes 只嵌一层 `{}`，不需要栈） */
const keyframesBody = (src: string, name: string): string => {
  const m = new RegExp(`@keyframes\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(src);
  expect(m, `keyframes ${name} 不在了`).not.toBeNull();
  return m![1]!;
};

/** 车道 A 独占的 CSS（VIS-33 的账就记在这几张纸上） */
const OWNED: Array<[string, string]> = [
  ['file-tree.css', fileTreeCss],
  ['tabs-bar.css', tabsBarCss],
  ['outline-panel.css', outlineCss],
  ['shell-notices.css', noticesCss],
  ['update-dialog.css', updateCss],
  ['settings-search.css', settingsCss],
  ['ui/motion-surface.css', motionCss],
];

/* ============================ VIS-31 · 三个高频面 ============================ */

describe('VIS-31 树组展开折叠：grid-template-rows 0fr→1fr，不碰 height', () => {
  it('折叠网格挂在 li.tree-group 自己身上，过渡吃 --dur-*/--ease-*', () => {
    expect(flat(fileTreeCss)).toMatch(
      /\.file-tree \.tree-group \{ display: grid; grid-template-rows: auto 0fr; transition: grid-template-rows var\(--dur-\d\) var\(--ease-[a-z]+\); \}/,
    );
    expect(flat(fileTreeCss)).toMatch(/\.file-tree \.tree-group\[data-open='1'\] \{ grid-template-rows: auto 1fr; \}/);
  });

  it('0fr 那一行的两个必要件在（overflow 裁内容 / min-height 压掉 min-content 基线）', () => {
    expect(flat(fileTreeCss)).toMatch(
      /\.file-tree \.tree-group > \.tree-files \{ overflow: hidden; min-height: 0; \}/,
    );
  });

  it('红线：height/max-height 一律不许进过渡（树是全站最长的一棵，逐帧重排读起来就是卡）', () => {
    expect(flat(fileTreeCss)).not.toMatch(/transition: [^;]*(?:max-)?height/);
  });

  it('行高密度没被顺手改：本切片不声明任何有值的 height，也不重定义 --tree-row-h（22px 是刻意密度）', () => {
    // 只放行 `min-height: 0`（0fr 那一行的必要件，上面单独钉过）——它不是尺寸，是"别撑开"；
    // 任何带长度含义的 height（px / rem / vh / % / var()）都是在动树的密度
    expect(stripComments(fileTreeCss)).not.toMatch(/[{;]\s*(?:min-|max-)?height:\s*(?:\d+(?:\.\d+)?(?:px|rem|em|vh|dvh|svh|%)|var\()/);
    expect(stripComments(fileTreeCss)).not.toMatch(/--tree-row-h\s*:/);
  });

  it('DOM 契约：ul.tree-files 仍是 li.tree-group 的直接子元素（导轨选择器不许多一层壳）', () => {
    // `indent-rail-single-source.test.ts` 钉的是选择器字面，这一条钉的是 DOM——
    // 谁把折叠容器改成 `<div>` 包一层，这里先红，而不是等到屏上导轨不见。
    expect(fileTreeTsx.match(/data-open=\{isOpen \? '1' : '0'\}/g) ?? []).toHaveLength(2);
    expect(fileTreeTsx).not.toMatch(/<div className="tree-fold"/);
    for (const sel of ['.tree-group > .tree-files', '.tree-group > .tree-files:hover::before', '.tree-group > .tree-files:has(.tree-file.active)::before']) {
      expect(fileTreeCss, `导轨选择器 ${sel} 被改写了`).toContain(sel);
    }
  });

  it('收起侧延迟卸载、展开侧同帧挂载（0fr→1fr 要有真实高度差可插值）', () => {
    expect(fileTreeTsx).toContain('function TreeFoldBody');
    expect(fileTreeTsx).toMatch(/setLingering\(!open\)/); // 渲染期调状态，不走 effect ⇒ 展开那一帧就有内容
    expect(fileTreeTsx).toMatch(/const FOLD_EXIT_MS = (\d+);/);
    expect(Number(/const FOLD_EXIT_MS = (\d+);/.exec(fileTreeTsx)![1])).toBe(200);
  });
});

describe('VIS-31 标签切换：活动指示条走 scaleX，不走 width/height', () => {
  it('指示条仍是 box-shadow 那一族，位移只吃 transform: scaleX()', () => {
    const f = flat(tabsBarCss);
    expect(f).toMatch(/\.editor-tabs-bar \.editor-tab::after \{[^}]*box-shadow: inset 0 2px 0 var\(--accent\);/);
    expect(f).toMatch(/\.editor-tabs-bar \.editor-tab::after \{[^}]*transform: scaleX\(0\);/);
    expect(f).toMatch(/\.editor-tabs-bar \.editor-tab\.active::after \{ transform: scaleX\(1\); \}/);
  });

  it('过渡挂在 transform 上（吃 --dur-*/--ease-*）', () => {
    expect(flat(tabsBarCss)).toMatch(/transition: transform var\(--dur-\d\) var\(--ease-[a-z]+\);/);
  });

  it('红线：本切片零 width/height 过渡（标签栏是横向 flex，宽度过渡 = 整条重排）', () => {
    expect(flat(tabsBarCss)).not.toMatch(/transition: [^;]*(?:width|height)/);
  });

  it('伪元素不抢命中、容器有定位上下文（position 是它唯一的布局增量）', () => {
    expect(flat(tabsBarCss)).toMatch(/\.editor-tabs-bar \.editor-tab \{ position: relative; \}/);
    expect(flat(tabsBarCss)).toMatch(/pointer-events: none;/);
  });
});

describe('VIS-31 大纲定位当前符号：200ms 左侧扫光走 transform', () => {
  it('扫光挂在 is-active 行的伪元素上，时长吃 --dur-2', () => {
    expect(flat(outlineCss)).toMatch(
      /\.outline-panel \.outline-row\.is-active::after \{[^}]*animation: outline-locate-sweep var\(--dur-2\)/,
    );
  });

  it('位移只用 translateX（keyframes 里不许出现 left / width / height）', () => {
    const body = keyframesBody(outlineCss, 'outline-locate-sweep');
    expect(body).toMatch(/transform: translateX\(/);
    expect(stripComments(body)).not.toMatch(/[{;]\s*(?:left|top|width|height)\s*:/);
  });

  it('基态不可见（opacity: 0）：压平后停在"没有光"，不是停在半道上的光带', () => {
    expect(flat(outlineCss)).toMatch(/\.outline-panel \.outline-row\.is-active::after \{[^}]*opacity: 0;/);
    expect(keyframesBody(outlineCss, 'outline-locate-sweep')).toMatch(/opacity: 0;/);
  });

  it('扫光不写死颜色：底片与光带全吃 var()（本仓既有那枚 `rgb(var(--accent-rgb))` 左条不算新增）', () => {
    expect(flat(outlineCss)).toMatch(/background: linear-gradient\(90deg, var\(--accent-soft\), transparent\)/);
    const added = outlineCss.slice(outlineCss.indexOf('1026 体感批 · 车道 A（VIS-31 大纲侧'));
    expect(stripComments(added)).not.toMatch(/rgba?\(|#[0-9a-f]{3,8}\b/i);
  });

  it('大纲的行密度刻度一个字没动（22px 与文件树同源，扫光不许把它抬走）', () => {
    expect(outlineCss).toMatch(/--outline-row-h:\s*22px/);
    expect(outlineCss).not.toMatch(/--outline-row-h:\s*(?!22px)\d/);
  });
});

/* ======================= VIS-34 · 树冷开骨架 ======================= */

describe('VIS-34 树冷开有骨架，不再只有一句文字', () => {
  it('接进 overlay-chrome 的 SkeletonRows（那张纸此前 0 消费）', () => {
    expect(fileTreeTsx).toMatch(/import \{ overlaySkeletonRows \} from '\.\/overlay-chrome';/);
    expect(fileTreeTsx).toMatch(/\{overlaySkeletonRows\(TREE_COLD_SKELETON_ROWS\)\}/);
  });

  it('行数是 6–8 那一档（少了像装饰线，多了替真实内容许愿）', () => {
    const n = Number(/const TREE_COLD_SKELETON_ROWS = (\d+);/.exec(fileTreeTsx)![1]);
    expect(n).toBeGreaterThanOrEqual(6);
    expect(n).toBeLessThanOrEqual(8);
  });

  it('一句话仍在（读屏与"确实在读"的那句短话不许被骨架替掉）', () => {
    expect(fileTreeTsx).toContain("'正在读取口上目录…'");
    expect(fileTreeTsx).toContain("'索引中…'");
  });

  it('骨架行的排布与宽度阶梯在 file-tree.css（切片的分工：度量归组件，动效归切片）', () => {
    expect(flat(fileTreeCss)).toMatch(/\.tree-loading \.ov-skeleton \{ display: flex; flex-direction: column;/);
    expect(stripComments(fileTreeCss)).toMatch(/\.tree-loading \.ov-skeleton > \.ov-skeleton-row:nth-child\(2n \+ 1\)/);
  });
});

/* ======================= VIS-33 · 时长吃 token ======================= */

describe('VIS-33 动效时长一律吃 --dur-*/--anim-*，不留字面秒数', () => {
  it('车道 A 独占的每张 CSS 里，animation/transition 简写都带 token（none 例外）', () => {
    const bare: string[] = [];
    for (const [name, src] of OWNED) {
      for (const m of flat(src).matchAll(/(?:^|[;{}])\s*(animation|transition):\s*([^;{}]+);/g)) {
        const value = m[2]!.trim();
        if (value.startsWith('none')) continue;
        if (/var\(--(?:dur|anim)-[a-z0-9-]+\)/.test(value)) continue;
        bare.push(`${name} → ${m[1]}: ${value}`);
      }
    }
    expect(bare).toEqual([]);
  });

  it('改前三枚字面量真的没了（1.2s pulse / 1.4s indeterminate / 1.5s 落点回执）', () => {
    expect(fileTreeCss + tabsBarCss + outlineCss + noticesCss + updateCss + settingsCss + motionCss).not.toMatch(
      /animation: [^;]*\b(?:1\.2s|1\.4s|1\.5s)\b/,
    );
  });

  it('--anim-* 族有了真消费方（此前全仓只剩 2 处，tokens 那节"只定义不替换"的账在缩）', () => {
    const hits = (updateCss.match(/var\(--anim-[a-z-]+\)/g) ?? []).length + (settingsCss.match(/var\(--anim-[a-z-]+\)/g) ?? []).length;
    expect(hits).toBeGreaterThanOrEqual(3);
    expect(updateCss).toMatch(/animation: update-dialog-pulse var\(--anim-breathe\)/);
    expect(updateCss).toMatch(/animation: update-dialog-indeterminate calc\(var\(--anim-spin\) \* 2\)/);
    expect(settingsCss).toMatch(/animation: settings-hit calc\(var\(--anim-spin\) \* 2\) var\(--ease-out\)/);
  });

  it('--stagger 第一次被吃（tokens.css 定义了它，改前全仓 0 消费）', () => {
    expect(tokensCss).toMatch(/--stagger:\s*\d+ms/);
    expect((motionCss.match(/var\(--stagger\)/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it('--ease-standard 有了消费方（改前全仓 0；这条不许退化成"登记而未使用"）', () => {
    const consumers = OWNED.filter(([, src]) => stripComments(src).includes('var(--ease-standard)')).map(([n]) => n);
    expect(consumers.length).toBeGreaterThanOrEqual(1);
  });
});

/* ======================= VIS-35 · data-motion 档位值 ======================= */

describe("VIS-35 压平口径只有一枚值：data-motion='reduced'", () => {
  const cssFiles = (() => {
    const acc: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = path.join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (e.endsWith('.css')) acc.push(p);
      }
    };
    walk(SRC);
    return acc;
  })();

  it('扫到了 CSS（防"零文件假绿"）', () => {
    expect(cssFiles.length).toBeGreaterThanOrEqual(20);
  });

  it('全仓 CSS 里 data-motion= 的值只有 reduced（off / full 一类自造档位 = 该条规则永不生效）', () => {
    const values = new Set<string>();
    const offenders: string[] = [];
    for (const p of cssFiles) {
      for (const m of stripComments(readFileSync(p, 'utf8')).matchAll(/data-motion\s*=\s*(['"])([^'"]+)\1/g)) {
        values.add(m[2]!);
        if (m[2] !== 'reduced') offenders.push(`${path.basename(p)} → '${m[2]}'`);
      }
    }
    expect(values.size, `offenders: ${offenders.join(', ')}`).toBe(1);
    expect([...values]).toEqual(['reduced']);
  });

  it('CSS 用的档位必须是 motion-pref.ts 真写得出的值（两边对不上就是死规则）', () => {
    const writable = new Set((motionPrefTs.match(/export type MotionPref = ([^;]+);/)?.[1] ?? '').match(/'[a-z-]+'(?=\s*(?:\||;|$))/g) ?? []);
    expect(writable.has("'reduced'")).toBe(true);
    for (const p of cssFiles) {
      for (const m of stripComments(readFileSync(p, 'utf8')).matchAll(/data-motion\s*=\s*(['"])([^'"]+)\1/g)) {
        expect(writable.has(`'${m[2]}'`), `${path.basename(p)} 判了 motion-pref 写不出的档位 '${m[2]}'`).toBe(true);
      }
    }
  });

  it('settings-search 那条落点回执：减弱档关掉动画后仍有实描边（信息一条不减）', () => {
    expect(flat(settingsCss)).toMatch(
      /:root\[data-motion='reduced'\] \[data-settings-key\]\[data-hit='1'\] \{ animation: none; outline: 1px solid var\(--accent/,
    );
  });
});

/* ======================= VIS-32 · 通知槽位让位 ======================= */

describe('VIS-32 通知让位的位移走 transform，落点声明与抬升算术一个都没动', () => {
  it('旧那三条几何过渡不在了吗（left/right/bottom 不再逐帧重排）', () => {
    expect(flat(noticesCss)).not.toMatch(/transition: (left|right|bottom) var\(/);
    expect(flat(noticesCss)).not.toMatch(/transition: left /);
  });

  it('落点仍由 left/right/bottom 声明（:has() 不可用时整组失效 = 改前形态）', () => {
    expect(flat(noticesCss)).toMatch(
      /body:has\(\.overlay-backdrop, \.modal-mask\) \.notification-center\.notification-shell \{ left: 16px; right: auto;/,
    );
    expect(flat(noticesCss)).toMatch(
      /\{ bottom: calc\(var\(--notice-slot-bottom\) \+ var\(--notice-err-h\) \+ var\(--notice-gap\)\); animation: notice-shell-rise/,
    );
  });

  it('keyframes 的 from 用同一族算出"让位前那一格"，没有第二份常数', () => {
    const rise = keyframesBody(noticesCss, 'notice-shell-rise');
    expect(rise).toMatch(/var\(--notice-err-h\)/);
    expect(rise).toMatch(/var\(--notice-gap\)/);
    expect(rise).toMatch(/transform: translate\(/);
    expect(stripComments(rise)).not.toMatch(/bottom:\s*\d/); // 不许再抄一枚抬升常数进 keyframes
    const shift = keyframesBody(noticesCss, 'notice-shell-shift');
    expect(shift).toMatch(/translate\(calc\(100vw - 32px - 100%\)/);
  });

  it('两条压平口径都关得掉动画与位移', () => {
    expect(flat(noticesCss)).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{ \.notification-center\.notification-shell \{ transition: none; animation: none; \} \}/,
    );
    expect(flat(noticesCss)).toMatch(
      /:root\[data-motion='reduced'\] \.notification-center\.notification-shell \{ transition: none; animation: none; \}/,
    );
  });
});

/* ======================= 跨面切片本身 ======================= */

describe('ui/motion-surface.css：切片真接线、图样不吃布局、压平闸带 delay', () => {
  it('被真 import（css-slices-wired 只认 import 语句，注释提文件名不算）', () => {
    for (const [name, src] of [['FileTree.tsx', fileTreeTsx], ['tabs-bar.tsx', tabsBarTsx]] as const) {
      expect(src, `${name} 没有引入动效切片`).toMatch(/import\s+['"]\.\/motion-surface\.css['"]/);
    }
  });

  it('逐行入场只动 opacity / transform（keyframes 里不许出现尺寸与偏移属性）', () => {
    const body = keyframesBody(motionCss, 'ms-row-in');
    expect(body).toMatch(/opacity:/);
    expect(body).toMatch(/transform: translateY\(/);
    expect(stripComments(body)).not.toMatch(/[{;]\s*(?:left|top|width|height|margin|padding)\s*:/);
  });

  it('入场带 backwards 填充：delay 期间是"还没到"，不是"先露出来再淡"', () => {
    expect(flat(motionCss)).toMatch(/animation: ms-row-in var\(--dur-\d\) var\(--ease-[a-z]+\) backwards;/);
  });

  it('压平闸同时关 animation 与 animation-delay（全局那条只压 duration，压不住 delay）', () => {
    const guards = [
      /@media \(prefers-reduced-motion: reduce\) \{ \.file-tree \.tree-files > li[^}]*animation: none; animation-delay: 0s; transition: none; \}/,
      /:root\[data-motion='reduced'\] \.file-tree \.tree-files > li[^}]*animation: none; animation-delay: 0s; transition: none; \}/,
    ];
    const f = flat(motionCss);
    for (const re of guards) expect(f, `压平闸缺一条：${re}`).toMatch(re);
    // 覆盖面：树行 / 骨架行 / 标签指示条 / 大纲扫光 / 通知列，一枚都不许漏
    for (const sel of ['.tree-loading .ov-skeleton > .ov-skeleton-row', '.editor-tabs-bar .editor-tab::after', '.outline-panel .outline-row.is-active::after', '.notification-center.notification-shell']) {
      expect(f).toContain(sel);
    }
  });

  it('切片零裸色（只吃 var()，颜色真源仍在 tokens/themes）', () => {
    expect(stripComments(motionCss)).not.toMatch(/rgba?\(|#[0-9a-f]{3,8}\b/i);
  });

  it('更新提醒卡的抬升仍会动（改前它是被那条几何过渡顺带过渡的，不能随本批静默消失）', () => {
    const f = flat(motionCss);
    expect(f).toMatch(
      /body:has\(\.update-notice-card\):not\(:has\(\.overlay-backdrop, \.modal-mask\)\) \.notification-center\.notification-shell \{ animation: notice-card-lift var\(--dur-\d\) var\(--ease-[a-z]+\); \}/,
    );
    const body = keyframesBody(motionCss, 'notice-card-lift');
    expect(body).toMatch(/var\(--notice-card-h\)/);
    expect(body).toMatch(/var\(--notice-gap\)/);
    // 分工而不是 coincidence：卡那一条把模态排除在外 ⇒ 与让位两条永不同时命中，
    // 同一条 `animation` 属性不会有两个来源靠注入顺序决胜
    expect(f).not.toMatch(/body:has\(\.update-notice-card\)(?!:not)[^{}]*\.notification-center/);
  });
});
