/**
 * 1026 kit-converge C1 判据：`KitPanelHeader` 三家同源 · `KitSearchField` 三处接入。
 *
 * 三条腿（口径照 `search-hit-area.test.ts` / `problem-panel-ux.test.ts` 的先例）：
 * ① 源码闸：消费方**直引叶子**（不经桶棒，开机图纪律）、JSX 真用、旧类名在源文件里
 *    整体退场（旧 CSS 由 L02 收尾，本批只保证类不再被挂上）；
 * ② 件契约闸：`renderToStaticMarkup` 钉槽位顺序 / 缺省不画空壳 / 修饰类 / 图标在井内 /
 *    清空钮只在值非空时出现且穿 `kit-icon-btn` 的 24×24 热区语言；
 * ③ 面板接线 SSR：问题面板出 `bleed` 档、检索面板的查询井是 `kit-search-field`
 *    且判据锚类 `search-input ksp-input` 逐字保留。
 *
 * 本文件待在默认 node 环境（读源码 + SSR 字符串），不在注释里写任何 vitest 环境指令字面量。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { KitPanelHeader } from '../src/ui-kit/kit-panel-header';
import { KitSearchField } from '../src/ui-kit/kit-search-field';
import { ProblemPanel } from '../src/ui/ProblemPanel';
import { clearAllProblems, setProblems } from '../src/ui/problem-store';
import { SearchPanel } from '../src/ui/SearchPanel';
import { resetSearch, setSearchRunner } from '../src/ui/search-store';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const problemSrc = read('../src/ui/ProblemPanel.tsx');
const searchSrc = read('../src/ui/SearchPanel.tsx');
const outlineSrc = read('../src/ui/OutlinePanel.tsx');
const kbSrc = read('../src/ui/KeybindingsPage.tsx');
const settingsSrc = read('../src/ui/SettingsPanel.tsx');

/* ============================ ① KitPanelHeader 三家同源 ============================ */

describe('KitPanelHeader：三家面板头同用一个骨架', () => {
  for (const [name, src] of [
    ['ProblemPanel.tsx', problemSrc],
    ['SearchPanel.tsx', searchSrc],
    ['OutlinePanel.tsx', outlineSrc],
  ] as const) {
    it(`${name}：直引叶子（不经桶棒）且 JSX 用 <KitPanelHeader`, () => {
      expect(src).toContain("from '../ui-kit/kit-panel-header'");
      expect(src).toMatch(/<KitPanelHeader\b/);
    });
  }

  it('旧 header 类名在三个源文件里整体退场（prob-head / ksp-head / outline-panel__meta）', () => {
    expect(problemSrc).not.toMatch(/className="prob-head|prob-head/);
    expect(searchSrc).not.toMatch(/ksp-head/);
    expect(outlineSrc).not.toMatch(/outline-panel__meta/);
  });

  it('headRef（虚拟列表要量常驻头挡住多高）仍递给 KitPanelHeader 的根 div', () => {
    expect(problemSrc).toMatch(/<KitPanelHeader[^>]*ref=\{headRef\}/s);
    expect(searchSrc).toMatch(/<KitPanelHeader[^>]*ref=\{headRef\}/s);
  });

  it('件契约：标题·计数·动作三槽同主行、动作右靠；三槽全缺省不画空主行', () => {
    const withSlots = renderToStaticMarkup(
      h(KitPanelHeader, { title: '符号', count: h('b', null, '3'), actions: 'fold' }, h('i', null, 'row')),
    );
    expect(withSlots).toContain('class="kit-panel-header"');
    expect(withSlots).toContain('kit-panel-header-main');
    // 槽位顺序：标题 → 计数 → 动作（右靠那条腿在 ui-kit.css，由 ui-kit-css 的 token 闸罩着）
    expect(withSlots.indexOf('kit-panel-header-title')).toBeLessThan(withSlots.indexOf('kit-panel-header-count'));
    expect(withSlots.indexOf('kit-panel-header-count')).toBeLessThan(withSlots.indexOf('kit-panel-header-actions'));
    // children 是主行之外的追加行
    expect(withSlots.indexOf('kit-panel-header-actions')).toBeLessThan(withSlots.indexOf('<i>row</i>'));

    const childrenOnly = renderToStaticMarkup(h(KitPanelHeader, null, h('div', null, 'toolbar')));
    expect(childrenOnly).not.toContain('kit-panel-header-main');
    expect(childrenOnly).toContain('<div class="kit-panel-header"');
  });

  it('修饰档落进 class：bleed / raised / meta / static', () => {
    expect(renderToStaticMarkup(h(KitPanelHeader, { bleed: true }))).toContain('kit-panel-header-bleed');
    expect(renderToStaticMarkup(h(KitPanelHeader, { raised: true, meta: true }))).toContain(
      'kit-panel-header-raised kit-panel-header-meta',
    );
    expect(renderToStaticMarkup(h(KitPanelHeader, { sticky: false }))).toContain('kit-panel-header-static');
    expect(renderToStaticMarkup(h(KitPanelHeader, {}))).not.toContain('kit-panel-header-static');
  });

  it('面板 SSR 接线：问题面板出 bleed 档、检索与大纲出基座档', () => {
    setProblems('C:/game/ERB/001/M_KOJO_K1_1.ERB', [
      { path: 'C:/game/ERB/001/M_KOJO_K1_1.ERB', line: 3, severity: 'error', message: '结构不闭合' },
    ]);
    const prob = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => undefined }));
    expect(prob).toContain('<div class="kit-panel-header kit-panel-header-bleed"');
    expect(prob).not.toContain('prob-head');
    clearAllProblems();

    const ksp = renderToStaticMarkup(h(SearchPanel, { roots: ['C:\\game'], onReveal: () => undefined }));
    expect(ksp).toContain('<div class="kit-panel-header"');
    expect(ksp).not.toContain('ksp-head');
  });
});

/* ============================ ② KitSearchField 三处接入 ============================ */

describe('KitSearchField：keybindings / settings / search-panel 三处接入', () => {
  for (const [name, src] of [
    ['KeybindingsPage.tsx', kbSrc],
    ['SettingsPanel.tsx', settingsSrc],
    ['SearchPanel.tsx', searchSrc],
  ] as const) {
    it(`${name}：直引叶子（不经桶棒）且 JSX 用 <KitSearchField`, () => {
      expect(src).toContain("from '../ui-kit/kit-search-field'");
      expect(src).toMatch(/<KitSearchField\b/);
    });
  }

  it('旧搜索框类名退场：kb 三件套与 settings 图标/输入/清空不再被挂上', () => {
    expect(kbSrc).not.toMatch(/className="kb-search/);
    expect(settingsSrc).not.toMatch(/className="settings-search-(input|icon|clear)"/);
    expect(settingsSrc).not.toMatch(/className="settings-search-modified/); // 胶囊进了动作槽（模板串除外）
    // 「已修改」胶囊仍穿它自己的判据类（样式真源在 settings-search.css，本批不动那份文件）
    expect(settingsSrc).toMatch(/className=\{`settings-search-modified/);
  });

  it('图标在框内：根井 → 图标 → input → 动作槽 → 清空钮，全在同一口井里', () => {
    const s = renderToStaticMarkup(
      h(KitSearchField, {
        value: 'abc',
        onChange: () => undefined,
        ariaLabel: '搜索测试',
        icon: h('svg', { 'data-mock': 'icon' }),
        actions: h('button', { 'data-mock': 'action' }, 'pill'),
        onClear: () => undefined,
        clearIcon: h('svg', { 'data-mock': 'clear' }),
      }),
    );
    expect(s).toContain('<span class="kit-search-field">');
    // 图标在根井之内、input 之前（"落在输入框外沿"那枚真机缺陷的结构判据）
    expect(s.indexOf('class="kit-search-field"')).toBeLessThan(s.indexOf('data-mock="icon"'));
    expect(s.indexOf('data-mock="icon"')).toBeLessThan(s.indexOf('<input'));
    expect(s.indexOf('<input')).toBeLessThan(s.indexOf('data-mock="action"'));
    expect(s.indexOf('data-mock="action"')).toBeLessThan(s.indexOf('data-mock="clear"'));
    // 一切都在井的收尾 </span> 之前
    expect(s.indexOf('data-mock="clear"')).toBeLessThan(s.lastIndexOf('</span>'));
    // 图标腿不参与朗读（无障碍名由 input 的 aria-label 承担）
    expect(s).toContain('aria-hidden="true"');
    expect(s).toContain('aria-label="搜索测试"');
  });

  it('清空钮：值空不画；值非空出现且穿 kit-icon-btn（24×24 热区语言）+ 无障碍名必落', () => {
    const empty = renderToStaticMarkup(
      h(KitSearchField, { value: '', onChange: () => undefined, ariaLabel: 'x', onClear: () => undefined }),
    );
    expect(empty).not.toContain('kit-search-field-clear');
    const filled = renderToStaticMarkup(
      h(KitSearchField, {
        value: 'q',
        onChange: () => undefined,
        ariaLabel: 'x',
        onClear: () => undefined,
        clearLabel: '清空搜索',
      }),
    );
    expect(filled).toContain('kit-icon-btn kit-search-field-clear');
    expect(filled).toContain('data-size="14"');
    expect(filled).toContain('aria-label="清空搜索"');
  });

  it('inputClassName 逐字落上：kit 不在前面垫自己的类（判据锚 `search-input ksp-input` 不漂）', () => {
    const s = renderToStaticMarkup(
      h(KitSearchField, {
        value: '',
        onChange: () => undefined,
        ariaLabel: 'x',
        inputClassName: 'search-input ksp-input',
      }),
    );
    expect(s).toContain('class="search-input ksp-input"');
  });

  it('onChange 交字符串不泄漏 event（ui-kit 族规；件内与三家消费方同口径）', () => {
    const fieldSrc = read('../src/ui-kit/kit-search-field.tsx');
    expect(fieldSrc).toContain('onChange(e.target.value)');
    expect(kbSrc).toContain('onChange={setQuery}');
    expect(settingsSrc).toContain('onChange={setQuery}');
    expect(searchSrc).toContain('onChange={setQuery}');
  });

  it('面板 SSR 接线：检索面板查询井 = kit 井 + ksp 度量锚；旧查询行 div 不再出现在首行', () => {
    resetSearch();
    setSearchRunner(null);
    const ksp = renderToStaticMarkup(h(SearchPanel, { roots: ['C:\\game'], onReveal: () => undefined }));
    expect(ksp).toContain('class="kit-search-field ksp-field"');
    expect(ksp).toContain('class="search-input ksp-input"');
    // 查询井走 kit 后，裸 `<div class="ksp-field">` 不再出现在静态渲染里（替换行默认折叠，
    // 展开时仍是旧档）；kit 井 + ksp 锚只此一枚在首行
    expect((ksp.match(/<div class="ksp-field">/g) ?? []).length).toBe(0);
    expect((ksp.match(/class="kit-search-field ksp-field"/g) ?? []).length).toBe(1);
    // 框内 toggle 组仍住井内（动作槽）
    expect(ksp.indexOf('class="kit-search-field ksp-field"')).toBeLessThan(ksp.indexOf('ksp-toggles'));
  });
});

/* ============================ ③ 切片接线（css-slices-wired 同口径的显式自证） ============================ */

describe('新接的线条被真 import', () => {
  it('settings-search-kit.css 由 SettingsPanel 静态引入', () => {
    expect(settingsSrc).toMatch(/import\s*'\.\/settings-search-kit\.css'/);
  });
  it('常驻头与井的基座度量住在 ui-kit.css（token 闸由 ui-kit-css.test.ts 罩）', () => {
    const kit = read('../src/ui-kit/ui-kit.css');
    for (const sel of ['.kit-panel-header', '.kit-panel-header-bleed', '.kit-search-field', '.kit-search-field input']) {
      expect(kit, `${sel} 规则块不见了`).toContain(sel);
    }
  });
});

afterEach(() => {
  clearAllProblems();
  resetSearch();
  setSearchRunner(null);
});
