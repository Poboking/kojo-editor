import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TabChip } from '../src/ui/tab-chip';

/**
 * 标签视觉件（欢迎页第九批抽出）：当前无页面渲染，形状锁保证以后复用时不漂。
 * SSR 不序列化事件处理器，这里只钉结构与无障碍文案。
 */

const render = (props: Parameters<typeof TabChip>[0]): string =>
  renderToStaticMarkup(h(TabChip, props));

describe('TabChip · 可复用标签视觉', () => {
  it('label / 图标 / 关闭钮齐全', () => {
    const html = render({ label: '欢迎', icon: 'home', onClose: () => {} });
    expect(html).toContain('class="tab-chip"');
    expect(html).toContain('tab-chip-icon');
    expect(html).toContain('>欢迎</span>');
    expect(html).toContain('class="tab-chip-close"');
    expect(html).toContain('aria-label="关闭欢迎"');
    expect(html).toContain('title="关闭欢迎"');
  });

  it('active 态带 is-active；缺省不带', () => {
    expect(render({ label: 'a', active: true })).toContain('tab-chip is-active');
    expect(render({ label: 'a' })).not.toContain('is-active');
  });

  it('不给 onClose 就不渲染关闭钮；closeLabel 可覆盖', () => {
    expect(render({ label: 'a' })).not.toContain('tab-chip-close');
    const html = render({ label: 'a', onClose: () => {}, closeLabel: '收起' });
    expect(html).toContain('aria-label="收起"');
  });
});
