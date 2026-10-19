import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RecentProject } from '@kojo/plugin-api';
import { WelcomeView } from '../src/ui/WelcomeView';

/**
 * 欢迎页版式回归（用户反馈第 2 条）：欢迎页是"选目录前"的整页视图，不该模拟
 * 工作区标签栏（VSCode 的欢迎标签是进入编辑器之后才成立的）。
 *
 * 这里钉的是 SSR 形状：欢迎页**完全没有标签**（`.welcome-tabbar` / `.welcome-tab` /
 * tab/tabpanel 语义一律不出现）；卡片在舞台里居中并带 aria-label；关闭 × 贴卡片
 * 右上角；两栏内容（教程三卡 + 最近）一个不少。标签视觉已抽成独立可复用件
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
  it('三张教程卡（口上教程 / 语法教程 / 语法全表）都在', () => {
    const html = render();
    expect(html.match(/class="welcome-tutorial"/g)).toHaveLength(3);
    expect(html).toContain('口上教程');
    expect(html).toContain('语法教程');
    expect(html).toContain('语法全表');
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
