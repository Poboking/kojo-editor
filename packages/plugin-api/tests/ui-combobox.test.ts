import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { KitCombobox, kitComboboxIsSelected, type KitComboboxOption } from '../src/ui-combobox';

/**
 * KitCombobox 契约（2026-11-07 自绘弹层下拉批）。
 *
 * 本包测试不起 jsdom（总纲）：交互态交给真机取证（debug-cli 截图 + DOM 复量），
 * 这里钉两件**纯结论**：
 * ① 选中判据的单源口径——占位项永远不算选中（'' === '' 会把「清除选择」行
 *    点亮成蓝框+勾，误导成一个当前选项；真机踩过，回归钉死）；
 * ② SSR 渲染的对外形状——字段行 combobox 语义、占位态类名、弹层关闭态不进树。
 */

const ROWS: readonly KitComboboxOption[] = [
  { value: '', label: '选择档位…', hint: '清除选择', placeholder: true },
  { value: 'save01.sav', label: 'save01.sav', hint: '第 1 日' },
  { value: 'save02.sav', label: 'save02.sav', hint: '第 3 日' },
];

describe('kitComboboxIsSelected：占位项永远不算选中', () => {
  it('未选（current 空串）时，占位行不亮、真档行也不亮', () => {
    expect(kitComboboxIsSelected(ROWS[0], '')).toBe(false);
    expect(kitComboboxIsSelected(ROWS[1], '')).toBe(false);
    expect(kitComboboxIsSelected(ROWS[2], '')).toBe(false);
  });

  it('选定真档时只有那行亮；占位行即使 value 相同也不亮', () => {
    expect(kitComboboxIsSelected(ROWS[1], 'save01.sav')).toBe(true);
    expect(kitComboboxIsSelected(ROWS[0], '')).toBe(false);
    expect(kitComboboxIsSelected(ROWS[2], 'save01.sav')).toBe(false);
  });

  it('undefined 行与 null current 都安全（不抛、返回 false）', () => {
    expect(kitComboboxIsSelected(undefined, null)).toBe(false);
    expect(kitComboboxIsSelected(ROWS[0], null)).toBe(false);
  });
});

describe('KitCombobox SSR 外形（关闭态）', () => {
  const render = (value: string | null): string =>
    renderToString(createElement(KitCombobox, {
      value,
      onChange: () => {},
      options: ROWS,
      ariaLabel: '选择存档档位',
      label: '存档',
      headTitle: '存档档位',
      count: 2,
    }));

  it('未选：字段行是 combobox 按钮的占位态，弹层不进树', () => {
    const html = render(null);
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('kit-combobox-field is-placeholder');
    expect(html).toContain('选择档位…');
    expect(html).not.toContain('role="listbox"');
    expect(html).not.toContain('kit-combobox-pop');
  });

  it('选定 save02：字段行退占位态、值行显示真档名', () => {
    const html = render('save02.sav');
    expect(html).toContain('kit-combobox-field"'); // 无 is-placeholder
    expect(html).not.toContain('is-placeholder');
    expect(html).toContain('save02.sav');
    expect(html).not.toContain('选择档位…');
  });

  it('零选项：回退占位项，字段行不空白', () => {
    const html = renderToString(createElement(KitCombobox, {
      value: null,
      onChange: () => {},
      options: [],
      ariaLabel: '选择存档档位',
    }));
    expect(html).toContain('选择…');
    expect(html).toContain('is-placeholder');
  });
});
