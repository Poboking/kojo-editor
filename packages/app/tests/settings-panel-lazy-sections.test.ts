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
 * 3. **首屏 DOM 上限**：`.settings-host` 子树元素数 ≤ 140（2026-10-27 现值 115；七节全挂
 *    实测 1462，是它的十倍——这条是"别悄悄退回全挂"的兜底 tripwire，不卡正常加行）；
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
    // 「通用」节的行序（自上而下）：写作模式 / 居中限宽 → 面板（口上 XML 显示开关，
    // 用户 2026-10-27 反馈 5）→ 搜索（双击 Shift 呼出全局搜索，2026-10-28 体验对等批新增行）
    // → 封存功能 → 布局。缺省收起的面板也**有**这一行：它管的是
    // 活动栏入口，与面板当前显不显示无关。
    expect(keys.filter((k) => k.startsWith('general.'))).toEqual([
      'general.zen',
      'general.zenLimitWidth',
      'general.panel.kojo-xml',
      'general.doubleShiftSearch',
      'general.sealed',
      'general.layout',
    ]);
    expect(keys.filter((k) => k.startsWith('editor.') || k.startsWith('appearance.'))).toEqual([]);
  });

  it('导航栏仍是全量八项（懒挂载不藏入口；2026-10-27 加「工作区」）', () => {
    const html = renderToString(h(SettingsPanel, panelProps()));
    const tabs = [...html.matchAll(/class="settings-nav-item[^"]*"/g)];
    expect(tabs).toHaveLength(8);
    for (const label of ['通用', '外观', '编辑器', '工作区', '语言能力', '口上市场', '快捷键', '关于']) {
      expect(html).toContain(`>${label}<`);
    }
  });

  it('八节 render() 都非 null（「空节从导航栏消失」的老口径没被改动静默改掉）', () => {
    const sections = SETTINGS_SECTIONS(panelProps());
    expect(sections.map((s) => s.id)).toEqual([
      'general',
      'appearance',
      'editor',
      'workspace',
      'capabilities',
      'market',
      'keybindings',
      'about',
    ]);
    for (const section of sections) {
      expect(section.render(), `${section.id} 返回了 null`).not.toBeNull();
    }
  });

  it('首屏 DOM 上限：挂载后 .settings-host 子树元素数 ≤ 140（全挂七节会远超）', async () => {
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
      console.log(`[settings-lazy] 首屏 .settings-host 子树元素数：${count}（闸：≤140）`);
      // 这条闸只抓一件事：**有人把七节又全挂回来**。七节全挂实测 1462 节点（2026-10-27
      // 临时探针量的），与下面这枚数差一个数量级，判别力不缺。
      // 闸从 120 抬到 140（2026-10-27 用户反馈 5 批）：改前现值已到 103（旧闸只剩 17 的
      // 余量），本批增设「面板」组 + 一行「口上 XML」开关再 +12 ⇒ 115/120 只剩 5——
      // 那个余量会让**下一行正常设置**就撞红，是这条闸的误报面，不是它要抓的事故。
      // 抬到 140 后余量 25（约两行），仍离 1462 有十倍。
      expect(count).toBeLessThanOrEqual(140);
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
