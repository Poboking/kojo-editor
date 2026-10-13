/**
 * 图标通道宿主侧单测（E6）：`UIPanelProps.renderIcon` 的注入与回退契约。
 *
 * 两条底线：
 * - **注入**：经 PanelBody / StatusbarItem 渲染的贡献方拿到图标注册表桥，图标名
 *   真的画成 SVG；
 * - **回退**：renderIcon 缺省（旧宿主 / 无渲染环境）时贡献方按纯文本字形渲染，
 *   不能空白——这是 `UIPanelProps` 里那条"可选"注释的可执行版本。
 *
 * 为什么是 `.ts` 而非 `.tsx`：本仓 vitest 的 include 只收 `tests/**\/*.test.ts`，
 * app 的 typecheck 也只含 `tests/**\/*.ts`——`.tsx` 会既不运行也不被类型检查。
 * 故用 createElement（与仓库其它测试同风格，无 JSX）。
 */

import { describe, expect, it } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UIPanelProps } from '@kojo/plugin-api';
import { PanelBody, StatusbarItem } from '../src/ui/PanelHost';

/** 最小消费方：renderIcon 在就画图标，不在就回退字形（贡献方须遵守的契约） */
const consumer = (props: UIPanelProps) =>
  h('span', null, (props.renderIcon?.('add', 12) as ReactNode | undefined) ?? '＋');

describe('图标通道：宿主注入（PanelBody / StatusbarItem）', () => {
  it('PanelBody 把 renderIcon 桥给贡献方，图标渲染为 SVG', () => {
    const html = renderToStaticMarkup(h(PanelBody, { contribution: { id: 'demo', component: consumer } }));
    expect(html).toContain('<svg');
  });

  it('StatusbarItem 同样注入图标通道', () => {
    const html = renderToStaticMarkup(
      h(StatusbarItem, { contribution: { id: 'demo', component: consumer } }),
    );
    expect(html).toContain('<svg');
  });

  it('renderIcon 缺省时组件按回退字形渲染，不空白', () => {
    const html = renderToStaticMarkup(h(consumer, {}));
    expect(html).toContain('＋');
    expect(html).not.toContain('<svg');
  });

  it('未命中注册表的图标名按字形原样回落（第三方单字符约定不受影响）', () => {
    const named = (props: UIPanelProps) =>
      h('span', null, props.renderIcon?.('★', 12) as ReactNode | undefined);
    const html = renderToStaticMarkup(h(PanelBody, { contribution: { id: 'demo', component: named } }));
    expect(html).toContain('★');
    expect(html).not.toContain('<svg');
  });
});
