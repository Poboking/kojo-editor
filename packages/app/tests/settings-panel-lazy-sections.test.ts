// @vitest-environment happy-dom
/**
 * 设置页「只挂当前一节」的结构守门（2026-10-25 设置页性能批）。
 *
 * 背景：`SettingsPanel` 此前用 `.map((sec) => ({ sec, el: sec.render() }))` 判「哪一节是空的」，
 * 顺手把七节的 JSX 元素树全搭一遍（1,583 行），真正用到的只有一节；而设置搜索每敲一个字
 * 都会走一遍这条路径。本批改成「只为当前节调 `render()`」，另外六节在 DOM / 元素树上都不存在。
 *
 * 这一页钉四件事（全部是可观察结构，不是实现细节）：
 * 1. **首屏只建当前一节的 DOM**：默认进「通用」时，面板里一枚编辑器 / 外观的锚点都没有；
 * 2. **导航栏仍是全量七项**（懒挂载不许把入口藏了）；
 * 3. **首屏 DOM 上限**：`.settings-host` 子树元素数 ≤ 120（改前实测 ~90，留足增长余量；
 *    七节全挂的话是它的数倍——这条是"别悄悄退回全挂"的兜底 tripwire）；
 * 4. **没有空节**：七节 `render()` 都非 null，「空节从导航栏消失」这条老口径因此不会被
 *    本次改动静默改变（真出现空节时，本用例会先红，提醒把可见性判据补回去）。
 */
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { SETTINGS_SECTIONS, SettingsPanel, type SettingsPanelProps } from '../src/ui/SettingsPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = (): void => {};
const asyncNoop = async (): Promise<void> => {};

/** 壳层传进来的那一整套（值全部取"什么都没改过"的缺省态） */
function panelProps(over: Partial<SettingsPanelProps> = {}): SettingsPanelProps {
  return {
    onClose: noop,
    initialSection: 'general',
    commands: [],
    zen: false,
    zenLimitWidth: false,
    dispatch: noop,
    onResetLayout: noop,
    themePref: 'dark',
    motionPref: 'full',
    commitMotionPref: noop,
    panelVirtualize: true,
    glassTransparency: 15,
    sealed: true,
    nameColorOn: false,
    fontSize: 16,
    fontZoom: 0,
    quickSuggestionsOn: true,
    commitQuickSuggestions: noop,
    wordSuggestionsOn: true,
    commitWordSuggestions: noop,
    suggestDelay: 0,
    commitSuggestDelay: noop,
    // 幽灵文本三格（IC 批 A 车道）：值取"从没改过"的缺省态，与上面那组同口径
    inlineCompletionOn: true,
    commitInlineCompletion: noop,
    inlineMinShowDelay: 0,
    commitInlineMinShowDelay: noop,
    inlineMaxCandidates: 5,
    commitInlineMaxCandidates: noop,
    sugarViewOn: false,
    applySugarViewPref: noop,
    formatOnSave: false,
    commitFormatOnSave: noop,
    codeLensOn: false,
    commitCodeLens: noop,
    autosaveMode: 'off',
    directMode: false,
    marketSource: null,
    marketEndpointDraft: '',
    setMarketEndpointDraft: noop,
    saveMarketEndpoint: asyncNoop,
    resetMarketEndpoint: asyncNoop,
    appVersion: '0.0.0-test',
    updatePhase: { kind: 'idle' },
    updateStatusLine: null,
    runUpdateCheck: asyncNoop,
    installUpdate: asyncNoop,
    ...over,
  };
}

/** 页面上实际出现的设置锚点（`data-settings-key`）——本节行是否被渲染，一眼可见 */
const anchorKeys = (root: ParentNode): string[] =>
  [...root.querySelectorAll('[data-settings-key]')].map((el) => el.getAttribute('data-settings-key') ?? '');

const settingsHostOf = (root: ParentNode): Element | null => root.querySelector('.settings-host');

describe('设置页只挂当前一节（懒挂载）', () => {
  it('默认进「通用」：页面上只有通用节的锚点，编辑器 / 外观节的锚点一枚都不在', () => {
    const html = renderToString(h(SettingsPanel, panelProps()));
    const keys = [...html.matchAll(/data-settings-key="([^"]+)"/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => k.startsWith('general.'))).toEqual([
      'general.zen',
      'general.zenLimitWidth',
      'general.sealed',
      'general.layout',
    ]);
    expect(keys.filter((k) => k.startsWith('editor.') || k.startsWith('appearance.'))).toEqual([]);
  });

  it('导航栏仍是全量七项（懒挂载不藏入口）', () => {
    const html = renderToString(h(SettingsPanel, panelProps()));
    const tabs = [...html.matchAll(/class="settings-nav-item[^"]*"/g)];
    expect(tabs).toHaveLength(7);
    for (const label of ['通用', '外观', '编辑器', '语言能力', '口上市场', '快捷键', '关于']) {
      expect(html).toContain(`>${label}<`);
    }
  });

  it('七节 render() 都非 null（「空节从导航栏消失」的老口径没被改动静默改掉）', () => {
    const sections = SETTINGS_SECTIONS(panelProps());
    expect(sections.map((s) => s.id)).toEqual([
      'general',
      'appearance',
      'editor',
      'capabilities',
      'market',
      'keybindings',
      'about',
    ]);
    for (const section of sections) {
      expect(section.render(), `${section.id} 返回了 null`).not.toBeNull();
    }
  });

  it('首屏 DOM 上限：挂载后 .settings-host 子树元素数 ≤ 120（全挂七节会远超）', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(h(SettingsPanel, panelProps()));
    });
    try {
      const host = settingsHostOf(container);
      expect(host).not.toBeNull();
      const count = host!.querySelectorAll('*').length;
      // 读数随跑随打（照 ps10-eager-graph 的先例）：闸绿时也能拿到现值，交付回执不必靠人肉复算。
      console.log(`[settings-lazy] 首屏 .settings-host 子树元素数：${count}（闸：≤120）`);
      // 改前实测（真壳 headless）：整个文档 +90 节点、面板内 32 节点；
      // 闸设 120 = 现有读数的三倍余量，只抓"有人把七节又全挂回来"这一档事故。
      expect(count).toBeLessThanOrEqual(120);
      // 同一口径的第二枚钉子：锚点只属于当前一节
      expect(anchorKeys(host!).filter((k) => k.startsWith('editor.'))).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });
});
