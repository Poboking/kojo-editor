// @vitest-environment happy-dom
/**
 * 开源字体扩展批（2026-11-05）+ 同日 UI 收束批的回归钉子。分三层：
 *
 * ① **表的面**：`font-presets.ts` 至少 20 款带开源许可证的档位；每档主打面名字、许可证、
 *    标签齐全，且主打面真的出现在自己的栈里（否则预热量不到它、状态永远"检测中"）；
 *    两张表各自不许有重复栈（重复 = 两名两档但长得一模一样，纯噪声）。
 * ② **形态的面**：字体选择是设置页里**一个普通控件**，不是自带版式的独立页面／插件市场。
 *    收起只占一行凹井（描边 / 圆角 / 顶缘高光跟设置页其它控件同款）；展开是同一个井里的
 *    单列行式清单，发丝线分行、选中用短竖条。样式组件级引入、只吃 token、按容器折行、
 *    max-height 的 flex 清单不许压行（2026-11-05 卡片塌缩的同型护栏）。
 * ③ **真机的面**：默认收起时井里的大字样用生效栈渲染；展开后 20 档全在且各按自己的栈
 *    预览；点一档真的写进偏好、当前值行同步换名、清单像下拉一样收起；自定义输入仍在。
 *
 * 兼容口径：`font-presets.test.ts` 继续管栈形状 / 逐字闸 / 解析链，本文件不重复。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import { SettingsPanel, type SettingsPanelProps } from '../src/ui/SettingsPanel';
import {
  CODE_FONT_PRESETS,
  UI_FONT_PRESETS,
  fontFilterTagsFor,
  fontStackConcreteMembers,
  openSourceFontPresets,
  resolveCodeFontStack,
} from '../src/ui/font-presets';
import { EDITOR_DISPLAY_PREF_DEFAULT, loadEditorDisplayPrefs, saveEditorDisplayPrefs } from '../src/ui/editor-display-prefs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const tsx = (): string => read('../src/ui/SettingsPanel.tsx');
const css = (): string => read('../src/ui/settings-font.css');

const KNOWN_LICENSES = new Set(['OFL 1.1', 'Apache 2.0', 'MIT', 'UFL 1.0', '开源']);

/** CSSOM 会把 `style.fontFamily` 规范化（单引号→双引号、CJK 名去引号），比对前先抹平 */
const plainStack = (s: string): string => s.replace(/['"]/g, '').replace(/\s+/g, '').toLowerCase();

describe('开源字体档位表（≥20 款，元数据自洽）', () => {
  it('带许可证的档位不少于 20 款，且主打家族名互不重复', () => {
    const open = openSourceFontPresets();
    expect(open.length, '开源档位总数').toBeGreaterThanOrEqual(20);
    const families = open.map((p) => p.family);
    expect(families.every((f) => f !== '')).toBe(true);
    expect(new Set(families).size, '两档共用一张主打面 = 换档看不出区别').toBe(families.length);
  });

  it('每档许可证在册、标签非空、说明非空；系统 / 自定义档不冒充开源', () => {
    for (const p of [...CODE_FONT_PRESETS, ...UI_FONT_PRESETS]) {
      expect(p.label, `${p.id} 没有标题`).not.toBe('');
      expect(p.note, `${p.id} 没有说明`).not.toBe('');
      expect(p.tags.length, `${p.id} 没有筛选标签`).toBeGreaterThan(0);
      if (p.license !== '') {
        expect(KNOWN_LICENSES.has(p.license), `${p.id} 的许可证「${p.license}」不在册`).toBe(true);
      } else {
        expect(['内置', '系统', '自定义', '随代码'].some((t) => p.tags.includes(t)), `${p.id} 无许可证却没标成系统/自定义`).toBe(true);
      }
    }
  });

  it('主打面必须出现在自己的栈里（预热按栈成员量宽，否则状态永远点亮不了）', () => {
    for (const p of openSourceFontPresets()) {
      expect(fontStackConcreteMembers(p.stack), `${p.id} 的主打面 ${p.family} 不在栈里`).toContain(p.family);
    }
  });

  it('两张表各自没有重复栈；tags 派生工具仍自洽且「自定义」在列', () => {
    for (const [name, presets] of [
      ['代码档', CODE_FONT_PRESETS],
      ['界面档', UI_FONT_PRESETS],
    ] as const) {
      const stacks = presets.filter((p) => p.stack !== '').map((p) => p.stack);
      expect(new Set(stacks).size, `${name}出现重复栈`).toBe(stacks.length);
      const tags = fontFilterTagsFor(presets);
      expect(tags).toContain('自定义');
      expect(new Set(tags).size).toBe(tags.length);
    }
  });

  it('旧档位 id 一个不少（老用户存过的偏好不许读成"不在列表里"）', () => {
    expect(CODE_FONT_PRESETS.map((p) => p.id)).toEqual(
      expect.arrayContaining(['default', 'sarasa', 'jbmono-noto', 'lxgw', 'system', 'custom']),
    );
    expect(UI_FONT_PRESETS.map((p) => p.id)).toEqual(
      expect.arrayContaining(['system', 'source-han', 'pingfang', 'mono', 'custom']),
    );
  });
});

describe('字体选择器的形态面（融入设置页 / 只吃 token / 按容器折行）', () => {
  it('settings-font.css 由 SettingsPanel 静态引入，且不在常驻首屏链里', () => {
    expect(tsx()).toContain("import './settings-font.css';");
    expect(read('../src/main.tsx')).not.toContain('settings-font.css');
  });

  it('清单是单列行式，不是两列卡片网格；插件市场那套元素一个都不许回来', () => {
    const sheet = css();
    expect(sheet).toMatch(/\.font-picker-list\s*\{[^}]*display:\s*flex/);
    expect(sheet).toMatch(/\.font-picker-list\s*\{[^}]*flex-direction:\s*column/);
    expect(sheet, '两列卡片网格 = 插件市场感的主要来源').not.toMatch(/grid-template-columns:\s*repeat\(2/);
    for (const stale of [
      'font-gallery',
      'font-card',
      'font-gallery-chip',
      'font-gallery-hero-watermark',
      'font-gallery-notice',
    ]) {
      expect(sheet, `样式表里残留了 ${stale}`).not.toContain(stale);
    }
    expect(sheet, '新增样式不许写死颜色，一律走主题 token').not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('源码里没有字样纸 / 搜索 / 筛选 chip / 卡片；只有一个凹井 + 展开清单', () => {
    const src = tsx();
    for (const marker of [
      'font-picker-current',
      'font-picker-list',
      'font-picker-option',
      'font-picker-custom',
      'data-font-preview={a.group}',
      'aria-expanded={open}',
      'role="radiogroup"',
    ]) {
      expect(src, `缺 ${marker}`).toContain(marker);
    }
    for (const stale of ['font-gallery', 'font-card', 'fontFilterTagsFor', 'font-gallery-chip']) {
      expect(src, `源码里残留了 ${stale}`).not.toContain(stale);
    }
  });

  it('井的边框跟设置页其它控件同款；分行用发丝线，选中用短竖条而不是整圈卡片描边', () => {
    const sheet = css().replace(/\/\*[\s\S]*?\*\//g, '');
    const current = sheet.match(/\.font-picker \.font-picker-current\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(current, '控件描边走 --border 中档').toMatch(/border:\s*1px solid var\(--border\)/);
    expect(current, '中件圆角').toMatch(/border-radius:\s*var\(--radius-md\)/);
    expect(current, '井面顶缘高光跟 settings-stepper 同款').toMatch(/box-shadow:\s*var\(--edge-raise\)/);
    expect(sheet).toMatch(/\.font-picker \.font-picker-option\s*\{[^}]*border-bottom:\s*1px solid var\(--border-subtle\)/);
    expect(sheet, '选中态是左侧短竖条').toMatch(/:has\(\.kit-radio-input:checked\)::before/);
  });

  it('带 max-height 的 flex 清单不许压行：每行 flex: none', () => {
    // 注释里也会写到 `flex-shrink: 1` 这类反例，先剥掉注释，只比对真声明
    const sheet = css().replace(/\/\*[\s\S]*?\*\//g, '');
    const list = sheet.match(/\.font-picker-list\s*\{([^}]*)\}/)?.[1] ?? '';
    const option = sheet.match(/\.font-picker \.font-picker-option\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(list).toMatch(/max-height:\s*320px/);
    expect(option, '默认 flex-shrink:1 会把 20 行压进 320px 再整片溢出').toMatch(/flex:\s*none|flex-shrink:\s*0/);
  });

  it('动效只在「未要求减弱动效」时出现，应用内减弱档一并压平', () => {
    const sheet = css();
    expect(sheet).toContain('@media (prefers-reduced-motion: no-preference)');
    expect(sheet).toContain(":root:not([data-motion='reduced'])");
    expect(sheet).toMatch(/\.font-picker\s*\{[^}]*container-type:\s*inline-size/);
    expect(sheet).toMatch(/@container \(max-width: 460px\)/);
  });

  it('预览字样关掉连字：跟应用「连字恒关」口径一致，不然 != -> 会被糊成 ≠ →', () => {
    const sheet = css();
    for (const sel of ['.font-picker-current-preview', '.font-picker-option-sample']) {
      const block = sheet.match(new RegExp(`${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
      expect(block, `${sel} 没关连字`).toMatch(/font-variant-ligatures:\s*none/);
    }
  });

  it('窄容器折行稳定成两段：状态点脱离换行流，不会把 20 行挤成两种高度', () => {
    const sheet = css().replace(/\/\*[\s\S]*?\*\//g, '');
    const narrow = sheet.match(/@container \(max-width: 460px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(narrow, '拿不到窄容器段').not.toBe('');
    expect(narrow).toMatch(/\.font-picker-option-meta\s*\{[^}]*flex:\s*1 1 100%/);
    expect(narrow, '状态点留在换行流里会被长档位名挤到第三段').toMatch(
      /\.font-picker-option-state\s*\{[^}]*position:\s*absolute/,
    );
    expect(narrow, '两段之间要留一丝行距，否则字样与家族名贴成叠字').toMatch(/gap:\s*var\(--space-1\)/);
  });
});

const noop = (): void => {};
const asyncNoop = async (): Promise<void> => {};

function panelProps(over: Partial<SettingsPanelProps> = {}): SettingsPanelProps {
  return {
    onClose: noop,
    initialSection: 'editor',
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
    inlineCompletionOn: true,
    commitInlineCompletion: noop,
    inlineMinShowDelay: 0,
    commitInlineMaxCandidates: noop,
    inlineMaxCandidates: 5,
    commitInlineMinShowDelay: noop,
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
    openUpdateDialog: noop,
    ...over,
  };
}

/** 挂载「编辑器」节（编程字体那一行在这里），返回容器与卸载句柄 */
async function mount(): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(h(SettingsPanel, panelProps()));
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe('字体选择器真机读感（happy-dom 挂载设置页编辑器节）', () => {
  it('默认收起：设置页里只多一行凹井，井里的大字样用当前生效栈渲染', async () => {
    const { container, unmount } = await mount();
    const picker = container.querySelector<HTMLElement>('.font-picker')!;
    expect(picker.getAttribute('data-open')).toBe('0');
    expect(container.querySelectorAll('.font-picker-list').length, '清单不该常驻').toBe(0);
    expect(container.querySelectorAll('.font-picker-option').length, '20 档不该铺满设置页').toBe(0);
    expect(container.querySelector<HTMLButtonElement>('.font-picker-current')!.getAttribute('aria-expanded')).toBe('false');
    // 字体控件仍是那一行 stacked 设置项的直接内容，不是另起一个页面
    expect(container.querySelector('.settings-row.stacked > .font-picker')).not.toBeNull();

    const preview = container.querySelector<HTMLElement>('[data-font-preview="code-font-preset"]')!;
    expect(plainStack(preview.style.fontFamily)).toBe(plainStack(resolveCodeFontStack(loadEditorDisplayPrefs()).stack));
    await unmount();
  });

  it('展开后 20 档全在、每行按自己的栈预览；再点收起就回到一行', async () => {
    const { container, unmount } = await mount();
    const current = container.querySelector<HTMLButtonElement>('.font-picker-current')!;
    await act(async () => current.click());
    expect(current.getAttribute('aria-expanded')).toBe('true');
    const options = container.querySelectorAll<HTMLElement>('.font-picker-option.kit-radio');
    expect(options.length).toBe(CODE_FONT_PRESETS.length);
    const fira = [...options].find((o) => o.querySelector('.font-picker-option-name')?.textContent === 'Fira Code');
    expect(fira).toBeDefined();
    expect(plainStack(fira!.querySelector<HTMLElement>('.font-picker-option-sample')!.style.fontFamily)).toBe(
      plainStack(CODE_FONT_PRESETS.find((p) => p.id === 'fira-noto')!.stack),
    );
    // 自定义是清单最后一行，不再是带虚线框的独立块
    expect(container.querySelector('.font-picker-custom .settings-font-input')).not.toBeNull();
    expect(container.querySelector('.font-picker-list > :last-child')?.classList.contains('font-picker-custom')).toBe(true);

    await act(async () => current.click());
    expect(container.querySelectorAll('.font-picker-list').length).toBe(0);
    await unmount();
  });

  it('点一档真的写进偏好、当前值行同步换名，清单像下拉一样收起', async () => {
    const { container, unmount } = await mount();
    await act(async () => container.querySelector<HTMLButtonElement>('.font-picker-current')!.click());
    const target = CODE_FONT_PRESETS.find((p) => p.id === 'hack-noto')!;
    const option = [...container.querySelectorAll<HTMLElement>('.font-picker-option.kit-radio')].find(
      (o) => o.querySelector('.font-picker-option-name')?.textContent === target.label,
    )!;
    await act(async () => option.querySelector<HTMLInputElement>('.kit-radio-input')!.click());
    expect(loadEditorDisplayPrefs().codeFontPreset).toBe(target.id);
    expect(container.querySelector<HTMLElement>('.font-picker-current-name')!.textContent).toBe(target.label);
    expect(container.querySelectorAll('.font-picker-list').length, '选完应收起').toBe(0);
    // 收尾：把偏好放回缺省，别把测试用的选择带进后面的用例
    expect(EDITOR_DISPLAY_PREF_DEFAULT.codeFontPreset).toBe('default');
    await act(async () => saveEditorDisplayPrefs({ codeFontPreset: 'default', fontFamily: '' }));
    await unmount();
  });
});
