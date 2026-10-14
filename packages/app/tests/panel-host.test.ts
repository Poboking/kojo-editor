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

/**
 * UI 偏好投影通道（2026-10-14 面板偏好批）：`PanelBody` 把宿主的 `uiPrefs` 转发给
 * 贡献方（`UIPanelProps.uiPrefs`）。两条底线：
 * - **转发**：给了 `{ panelVirtualize: true }` → 贡献方读到 true；
 * - **缺省保守**：不给 / 给空对象时，贡献方按契约回落到最保守值（`panelVirtualize` 读作 false）。
 */
const prefsConsumer = (props: UIPanelProps) =>
  h('span', { 'data-virtualize': String(props.uiPrefs?.panelVirtualize ?? false) });

describe('UI 偏好投影：PanelBody 下传 uiPrefs', () => {
  it('给了 uiPrefs 时原样转发给贡献方（panelVirtualize 开）', () => {
    const html = renderToStaticMarkup(
      h(PanelBody, {
        contribution: { id: 'demo', component: prefsConsumer },
        uiPrefs: { panelVirtualize: true },
      }),
    );
    expect(html).toContain('data-virtualize="true"');
  });

  it('缺省 uiPrefs 时贡献方读到保守值 false（= 全量渲染，改动前行为）', () => {
    const html = renderToStaticMarkup(
      h(PanelBody, { contribution: { id: 'demo', component: prefsConsumer } }),
    );
    expect(html).toContain('data-virtualize="false"');
  });

  it('显式 false 也原样转发（缺省与显式关语义一致）', () => {
    const html = renderToStaticMarkup(
      h(PanelBody, {
        contribution: { id: 'demo', component: prefsConsumer },
        uiPrefs: { panelVirtualize: false },
      }),
    );
    expect(html).toContain('data-virtualize="false"');
  });
});
