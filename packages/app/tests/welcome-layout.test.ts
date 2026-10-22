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
  closed: false,
  onClose: () => {},
  onReopen: () => {},
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

describe('欢迎页 · 卡片与关闭钮', () => {
  it('卡片有 aria-label="欢迎"（region 语义，替代旧 tabpanel）', () => {
    const html = render();
    expect(html).toContain('class="welcome-card" role="region" aria-label="欢迎"');
  });

  it('关闭钮在卡片内部（右上角定位），aria-label / title 正确', () => {
    const html = render();
    const cardAt = html.indexOf('class="welcome-card"');
    const closeAt = html.indexOf('class="welcome-close"');
    expect(cardAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(cardAt);
    expect(html).toContain('aria-label="关闭欢迎页"');
    expect(html).toContain('title="关闭欢迎页"');
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

describe('欢迎页 · 关闭态', () => {
  it('closed 时只剩居中空态，不出现任何标签', () => {
    const html = render({ closed: true });
    expect(html).toContain('welcome-closed');
    expect(html).toContain('重新打开欢迎页');
    expect(html).not.toContain('welcome-tab');
  });
});
