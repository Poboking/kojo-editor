import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TabBar } from '../src/ui/tabs-bar';

/**
 * 标签栏 SSR 形状锁（照 file-tree.test.ts 形态）：C1 右键菜单挂点、C2 固定标签的
 * 视觉与防误关、C3 全部保存恒在。行为面以 DOM 形状为准（SSR 不序列化事件处理器）。
 */

const TABS = ['C:/koa/p.ERB', 'C:/koa/q.ERB', 'C:/koa/r.ERB'];

const base = {
  openTabs: TABS,
  activeFile: 'C:/koa/q.ERB' as string | null,
  dirtyPaths: new Set<string>(),
  pinnedPaths: new Set<string>(),
  onActivateTab: () => {},
  onRequestCloseTab: () => {},
  onReorderTab: () => {},
  onTogglePin: () => {},
  onBatchCloseTab: () => {},
  onSaveAllClick: () => {},
  hasDirty: false,
};

const render = (props: Partial<typeof base> = {}): string =>
  renderToStaticMarkup(h(TabBar, { ...base, ...props }));

describe('TabBar · 基本形状', () => {
  it('每个 openTab 一枚 role=tab；活动标签带 active 类', () => {
    const html = render();
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('editor-tab active');
    expect(html.match(/editor-tab active/g)).toHaveLength(1);
  });

  it('激活标签的结构判据（P3-4）：active 类与 aria-selected="true" 同一枚、恒唯一', () => {
    const html = render();
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/aria-selected="false"/g)).toHaveLength(2);
    // 类名与 ARIA 不许分家（CSS 靠 .active 上色，辅助技术靠 aria-selected）；
    // SSR 属性序为 role → aria-selected → class，判据取 aria-selected="true" 起的那一小段
    const at = html.indexOf('aria-selected="true"');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(html.slice(at, at + 120)).toContain('class="editor-tab active"');
  });

  it('title 悬浮 = 完整路径；显示名 = 路径末段', () => {
    const html = render();
    expect(html).toContain('title="C:/koa/q.ERB"');
    expect(html).toContain('>q.ERB</span>');
  });

  it('脏标签有脏点（tab-dirty），干净的没有', () => {
    const html = render({ dirtyPaths: new Set(['C:/koa/p.ERB']) });
    expect(html.match(/tab-dirty/g)).toHaveLength(1);
  });
});

describe('TabBar · 固定标签（C2）', () => {
  it('固定标签带 pinned 类 + 竖标（tab-pin）', () => {
    const html = render({ pinnedPaths: new Set(['C:/koa/p.ERB']) });
    expect(html).toContain('editor-tab pinned');
    expect(html).toContain('tab-pin');
  });

  it('固定标签不渲染关闭钮（防误关）；非固定标签照常', () => {
    const html = render({ pinnedPaths: new Set(['C:/koa/p.ERB']) });
    // 三枚标签里只有两枚非固定 → 只有两个关闭钮
    expect(html.match(/tab-close/g)).toHaveLength(2);
    // pinned 那一枚的区块里没有 close 图标按钮（用标题区分：p.ERB 的 tab 无关闭钮）
    const pinnedChunk = html.slice(html.indexOf('p.ERB'), html.indexOf('q.ERB'));
    expect(pinnedChunk).toContain('tab-pin');
    expect(pinnedChunk).not.toContain('tab-close');
  });

  it('固定标签的 title 标注「已固定」（悬停自解释）', () => {
    const html = render({ pinnedPaths: new Set(['C:/koa/p.ERB']) });
    expect(html).toContain('title="C:/koa/p.ERB（已固定）"');
  });

  it('顺序照单全收：宿主给的顺序（固定区在前）就是渲染顺序，这里不二次排序', () => {
    const html = render({ openTabs: ['C:/koa/p.ERB', 'C:/koa/q.ERB', 'C:/koa/r.ERB'] });
    expect(html.indexOf('p.ERB')).toBeLessThan(html.indexOf('q.ERB'));
    expect(html.indexOf('q.ERB')).toBeLessThan(html.indexOf('r.ERB'));
  });
});

describe('TabBar · 全部保存显性入口（C3）', () => {
  it('按钮恒在，title 带快捷键（Ctrl+Shift+S）', () => {
    const html = render();
    expect(html).toContain('tab-save-all');
    expect(html).toContain('title="全部保存（Ctrl+Shift+S）"');
  });

  it('无脏标签弱化（idle 类）但不消失；有脏标签不弱化', () => {
    expect(render()).toContain('tab-save-all idle');
    expect(render({ hasDirty: true })).not.toContain('tab-save-all idle');
    expect(render({ hasDirty: true })).toContain('tab-save-all');
  });
});
