// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RecentProject } from '@kojo/plugin-api';
import { WelcomeView, WELCOME_TUTORIALS } from '../src/ui/WelcomeView';

/**
 * 欢迎页版式回归（用户反馈第 2 条）：欢迎页是"选目录前"的整页视图，不该模拟
 * 工作区标签栏（VSCode 的欢迎标签是进入编辑器之后才成立的）。
 *
 * 这里钉的是 SSR 形状：欢迎页**完全没有标签**（`.welcome-tabbar` / `.welcome-tab` /
 * tab/tabpanel 语义一律不出现）；卡片在舞台里居中并带 aria-label；关闭 × 贴卡片
 * 右上角；两栏内容（教程四卡 + 最近）一个不少。标签视觉已抽成独立可复用件
 * （`tab-chip.tsx`），由 tab-chip.test.ts 单独看管。行为面（点击接线 / 居中滚动）
 * 由 CSS 与真壳承担，SSR 不序列化事件处理器。
 */

const entry = (rootDir: string, lastOpenedAt = 1000, adapterId = 'eratw'): RecentProject => ({
  rootDir,
  adapterId,
  lastOpenedAt,
});

const base = {
  phase: 'welcome' as const,
  error: null as string | null,
  recent: [entry('C:\\Game\\eraTW')],
  tauri: true,
  kernelReady: true,
  onOpenDirectory: () => {},
  onOpenRecent: () => {},
  onRemoveRecent: () => {},
  onClearRecent: () => {},
  statPath: async () => null,
  resumeRoot: null,
  onResumeSession: () => {},
  crashRecovery: null,
  onRecoverCrash: () => {},
  onDiscardCrash: () => {},
  onOpenTutorial: () => {},
};

const render = (props: Partial<typeof base> = {}): string =>
  renderToStaticMarkup(h(WelcomeView, { ...base, ...props }));

describe('欢迎页 · 去标签栏（用户反馈第 2 条）', () => {
  it('不渲染任何标签（tabbar / welcome-tab / tab 语义全部缺席）', () => {
    const html = render();
    expect(html).not.toContain('welcome-tabbar');
    expect(html).not.toContain('welcome-tab');
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain('role="tabpanel"');
  });

  it('居中舞台存在：.welcome-scroll 内是 .welcome-stage', () => {
    const html = render();
    expect(html).toContain('class="welcome-scroll"');
    expect(html).toContain('class="welcome-stage"');
    expect(html.indexOf('class="welcome-stage"')).toBeGreaterThan(html.indexOf('class="welcome-scroll"'));
  });
});

describe('欢迎页 · 卡片', () => {
  it('卡片有 aria-label="欢迎"（region 语义，替代旧 tabpanel）', () => {
    const html = render();
    expect(html).toContain('class="welcome-card" role="region" aria-label="欢迎"');
  });
});

describe('欢迎页 · 内容面不缩水', () => {
  it('四张教程卡（口上教程 / 语法教程 / Kojo 2.0 语言教程 / 语法全表）按阅读顺序排', () => {
    const html = render();
    expect(html.match(/class="welcome-tutorial"/g)).toHaveLength(4);
    expect(html).toContain('口上教程');
    expect(html).toContain('语法教程');
    expect(html).toContain('Kojo 2.0 语言教程');
    expect(html).toContain('语法全表');
    // 顺序 = 工作流 → v1 写法 → 2.0 写法 → 查表（插错一格就是让作者先读错的那本）
    const at = (title: string): number => html.indexOf(`welcome-tutorial-title">${title}<`);
    const order = ['口上教程', '语法教程', 'Kojo 2.0 语言教程', '语法全表'].map(at);
    for (const [i, pos] of order.entries()) expect(pos, `第 ${i + 1} 张卡没找到`).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('第四卡只发语义 id `kojo2`，且如实交代"默认档不认这一本"', () => {
    const kojo2 = WELCOME_TUTORIALS.find((t) => t.id === 'kojo2');
    expect(kojo2).toBeDefined();
    expect(kojo2!.title).toBe('Kojo 2.0 语言教程');
    // 卡片只许说"默认档≠这一本教的东西"，不许把读者留在"以为切了才有"的错觉里。
    // 档位标签的实名（「只认 v1」）住在 `kojo2-cutover.ts` 的 `KOJO2_STAGE_LABELS`，
    // **本层不引述**：一是这里"一句教程内容都不写"的既有纪律，二是 `app-version.test.ts`
    // 的禁死值闸扫整个 WelcomeView.tsx 文本，带 `v`＋数字的字面量一律红（两条闸撞过一次，
    // 撞回来的那次是标签引到宿主里，不是版本闸误报——所以宿主别抄标签）。
    expect(kojo2!.blurb).toContain('默认档');
    expect(kojo2!.blurb).toContain('老写法');
    expect(kojo2!.blurb).toContain('2.0');
    expect(kojo2!.blurb).not.toMatch(/v\d/);
    // 四张卡都是语义 id，宿主不许在这里认识任何 overlay 贡献名
    expect(WELCOME_TUTORIALS.map((t) => t.id)).toEqual(['kojo', 'sugar', 'kojo2', 'reference']);
  });

  it('提供方不在场（内核未装配）⇒ 四张卡一律 disabled 且带人话 title，不静默空点', () => {
    // 新加的那张走的必须是同一条开合判据（`tutorialsOpenable`）：不许出现"点得动却没浮层"的第四路入口
    expect(render().match(/class="welcome-tutorial" disabled/g)).toBeNull(); // 就绪态：四枚都可点
    expect(render({ kernelReady: false }).match(/class="welcome-tutorial" disabled="" title="内核装配中…"/g)).toHaveLength(
      4,
    );
  });

  it('最近区仍在：标题 / 路径行 / 清除入口', () => {
    const html = render();
    expect(html).toContain('welcome-recent');
    expect(html).toContain('id="welcome-recent-title"');
    expect(html).toContain('C:\\Game\\eraTW');
    expect(html).toContain('清除全部');
  });

  it('移除按钮降噪仍在约：平时收隐（CSS hover/focus 显现），可访问名不依赖可见文本', () => {
    const html = render();
    // 按钮留在 DOM 与 Tab 序里（键盘可达），只是样式上 hover/focus-within 才显现
    expect(html).toContain('class="welcome-recent-remove"');
    expect(html).toContain('aria-label="从列表移除：C:\\Game\\eraTW"');
  });

  it('右栏身份感样例在：.kojo 写法与 ERB 编译产物同屏对照', () => {
    const html = render();
    expect(html).toContain('welcome-sample');
    expect(html).toContain('如果');
    expect(html).toContain('CFLAG:TARGET:好感度');
    expect(html).toContain('ENDIF');
  });

  it('无最近项目时给空态文案（不出现路径行）', () => {
    const html = render({ recent: [] });
    expect(html).toContain('welcome-empty');
    expect(html).not.toContain('welcome-recent-list');
  });
});

/* ==================== 两态重构（批次十一 · 视觉 L04） ==================== */

/**
 * 体检判定要钉的三件事（缺口 ①「零测试」的补齐）：
 * ① 首屏同权重信息块从旧版的 10 块平铺降到 **3**（品牌头 / 主 CTA / 最近项目）；
 * ② 教程入口在欢迎页**只剩一条**折叠（四张卡照常渲染在折叠内——
 *    上面的既有用例仍按 4 枚 `welcome-tutorial` 计数，这条不许被"折叠=不渲染"顶掉）；
 * ③ 最近列表不再半行裁切：限高必须是**整数行倍率**（行高单源公式 + `calc(token * 整数)`），
 *    旧的 `max-height:168px` 定值不许回来。③ 走 CSS 源形状判定——SSR 不带样式表，
 *    排版数学只能在源里钉（与 tools/tests 两条源形状守卫同一把尺）。
 */

/**
 * welcome.css 读数：happy-dom 环境里 `import.meta.url` 不是 file: 协议（fileURLToPath 直接抛），
 * 所以先试 URL 锚定、再退回从 cwd 逐级上溯找文件——`pnpm test`（root）与 `--filter app`
 * 两种起跑点都能命中，找不到就明确炸给看，不静默空扫。
 */
function readWelcomeCss(): string {
  const candidates: string[] = [];
  try {
    candidates.push(path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'ui', 'welcome.css'));
  } catch {
    /* 非 file: 环境：留逐级上溯兜底 */
  }
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    candidates.push(path.join(dir, 'packages', 'app', 'src', 'ui', 'welcome.css'));
    candidates.push(path.join(dir, 'src', 'ui', 'welcome.css'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, 'utf8');
  }
  throw new Error(`welcome.css 未找到（cwd=${process.cwd()}）`);
}
const cssSrc = readWelcomeCss();

const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');

/** 从元素向上找指定 tagName 的祖先（不依赖 :scope/closest 的差异行为，happy-dom 与浏览器同判） */
function hasAncestor(el: Element | null, tagName: string): boolean {
  let p = el?.parentElement ?? null;
  while (p) {
    if (p.tagName === tagName) return true;
    p = p.parentElement;
  }
  return false;
}

describe('欢迎页 · 两态重构：首屏只留三件事', () => {
  it('main 首屏同权重信息块恰为 3（品牌头 + 主 CTA 区 + 最近项目区），折叠层不计入', () => {
    const doc = parse(render());
    const main = doc.querySelector('main.welcome-main');
    expect(main, 'main.welcome-main 缺席').not.toBeNull();
    const blocks = Array.from(main!.children).filter(
      (el) =>
        (el.tagName === 'HEADER' || el.tagName === 'SECTION') &&
        !el.classList.contains('welcome-fold'),
    );
    expect(
      blocks.map((el) => el.getAttribute('class')),
      '首屏信息块的名录与数量必须逐字是这三条',
    ).toEqual(['welcome-brand', 'welcome-section welcome-start', 'welcome-section welcome-recent']);
    // 次级层确实还挂在 main 里但不占首屏权重：最近文件是一条 .welcome-fold
    expect(main!.querySelector('section.welcome-fold.welcome-recent-files')).not.toBeNull();
  });

  it('教程入口只剩一条：折叠组唯一，四张卡全部收在 <details> 内', () => {
    const doc = parse(render());
    expect(doc.querySelectorAll('.welcome-tutorials')).toHaveLength(1);
    expect(doc.querySelectorAll('summary .welcome-side-title')).toHaveLength(1);
    const cards = doc.querySelectorAll('.welcome-tutorial');
    expect(cards).toHaveLength(4); // 折叠是收起不是卸载——这条与上面的 4 枚计数同源
    for (const c of Array.from(cards)) {
      expect(
        hasAncestor(c, 'DETAILS'),
        `教程卡「${c.querySelector('.welcome-tutorial-title')?.textContent ?? '?'}」不在折叠层里，首屏又平铺回去了`,
      ).toBe(true);
    }
  });

  it('编译样例在教程折叠内再收一层（默认不开），首屏不占位', () => {
    const doc = parse(render());
    const sample = doc.querySelector('.welcome-sample');
    expect(sample, '身份感样例仍要渲染（既有用例数得到内容）').not.toBeNull();
    // 样例外层是 `details.welcome-sample-fold`，它自己又嵌在教程折叠里 ⇒ 至少两层 DETAILS
    expect(hasAncestor(sample, 'DETAILS')).toBe(true);
    const innerFold = sample!.closest('details.welcome-sample-fold');
    expect(innerFold, '样例没被收成次级折叠').not.toBeNull();
    expect(hasAncestor(innerFold, 'DETAILS'), '样例折叠没有嵌在教程折叠内').toBe(true);
  });
});

describe('欢迎页 · 限高 = 整数行倍率（半行裁切同源修掉）', () => {
  it('行高与卡高两条单源公式在 .welcome-screen 定义', () => {
    expect(cssSrc).toMatch(/--welcome-card-h:\s*calc\([^;]+\);/);
    expect(cssSrc).toMatch(/--welcome-row-h:\s*calc\([^;]+\);/);
  });

  it('最近文件列表：行高吃 --welcome-row-h，限高是它的整数倍，定值 px 不许回来', () => {
    const rowRule = cssSrc.match(/\.welcome-recent-files \.welcome-recent-row\s*\{[^}]*\}/);
    expect(rowRule, '最近文件行高规则缺席').not.toBeNull();
    expect(rowRule![0]).toContain('height: var(--welcome-row-h)');
    const listRule = cssSrc.match(/\.welcome-recent-files \.welcome-recent-list\s*\{[^}]*\}/);
    expect(listRule, '最近文件列表限高规则缺席').not.toBeNull();
    const mult = listRule![0].match(/max-height:\s*calc\(var\(--welcome-row-h\)\s*\*\s*(\d+)\)/);
    expect(mult, '限高必须写成 calc(var(--welcome-row-h) * 整数)').not.toBeNull();
    expect(Number(mult![1])).toBeGreaterThan(0);
    expect(/max-height:\s*\d+px/.test(listRule![0]), '列表限高里出现定值 px（半行裁切的老病根）').toBe(
      false,
    );
  });

  it('最近项目大卡网格：卡高 = --welcome-card-h，限高 = 整数张卡 + 整道 gap', () => {
    const cardRule = cssSrc.match(/\.welcome-project-card\s*\{[^}]*\}/);
    expect(cardRule, '大卡高度规则缺席').not.toBeNull();
    expect(cardRule![0]).toContain('height: var(--welcome-card-h)');
    const gridRule = cssSrc.match(/\.welcome-project-grid\s*\{[^}]*\}/);
    expect(gridRule, '大卡网格限高规则缺席').not.toBeNull();
    expect(
      gridRule![0],
      '网格限高必须是 calc(var(--welcome-card-h) * 整数 + 间距)',
    ).toMatch(/max-height:\s*calc\(var\(--welcome-card-h\)\s*\*\s*\d+(\s*\+\s*var\(--space-\d+\))?\)/);
    expect(/max-height:\s*\d+px/.test(gridRule![0]), '网格限高里出现定值 px').toBe(false);
  });

  it('装配中转圈吃 --anim-spin：欢迎页零处 700ms 字面量、零处自写 spinner keyframes', () => {
    const spinRule = cssSrc.match(/\.welcome-screen \.welcome-notice \.spinner\s*\{[^}]*\}/);
    expect(spinRule, '欢迎页 spinner 规则缺席').not.toBeNull();
    expect(spinRule![0]).toContain('animation-duration: var(--anim-spin)');
    // 700ms 字面量只准死在值位（动画声明里）；注释里提一嘴历史值不算违规
    expect(cssSrc).not.toMatch(/animation[^;:]*:\s*[^;]*700ms/);
    expect(/duration:\s*700ms/.test(spinRule![0])).toBe(false);
    expect(cssSrc).not.toMatch(/@keyframes\s+u-spin/);
  });
});

/* 弹窗态滚动（2026-10-26 反馈批）：教程 →「看看中文口上怎么变成游戏指令」展开后，
   代码块掉到窗口边缘以下且整页滚不动。根因是弹窗舞台只有 `flex: 1 1 auto`，卡片
   `height:100%` 落回内容高（实测 863px > 视口 564px），外层 `overflow:hidden` 直接裁掉。
   判据：舞台拿确定高度、卡片单行栅格钉 1fr；量高态再回到静态自然高度。 */
describe('欢迎页 · 弹窗态两栏各自滚（折叠内容不被裁）', () => {
  it('弹窗舞台绝对定位铺满滚动区（百分比高度才有参照）', () => {
    const rule = cssSrc.match(/\.app-frame-popup \.welcome-stage\s*\{[^}]*\}/);
    expect(rule, '弹窗舞台规则缺席').not.toBeNull();
    expect(rule![0]).toContain('position: absolute');
    expect(rule![0]).toContain('inset: 0');
  });

  it('弹窗卡片单行栅格 minmax(0, 1fr)：两栏各自滚，不被内容撑高', () => {
    const rule = cssSrc.match(/\.app-frame-popup \.welcome-screen \.welcome-card\s*\{[^}]*\}/);
    expect(rule, '弹窗卡片规则缺席').not.toBeNull();
    expect(rule![0]).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  });

  it('量高态撤掉绝对定位（要读卡片的自然高度）', () => {
    const rule = cssSrc.match(/\.app-frame-popup\.welcome-popup-measuring \.welcome-stage\s*\{[^}]*\}/);
    expect(rule, '量高态舞台规则缺席').not.toBeNull();
    expect(rule![0]).toContain('position: static');
  });
});
