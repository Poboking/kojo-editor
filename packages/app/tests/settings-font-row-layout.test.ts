/**
 * 设置页字体档位两行（编程字体 / 界面字体）的排版回归钉。
 *
 * 用户反馈：外观 → 界面字体整块把标签压成一字一行的竖排。根因是这两行仍走
 * `.settings-row` 的两列栅格——标签 `<span>` 被规则钉在 1/1 格，控件块是无格位的
 * `<div>`，自动排进第 2 列（auto 列吃 max-content），文字列被压到近 0 宽。
 * TSX 里原先那两条内联 `flexDirection: 'column'` 对 grid 无效，等于什么都没修。
 *
 * 判据两条：两行都挂 `stacked`（单列 flex），CSS 里那条类确实是 flex column。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tsx = readFileSync(new URL('../src/ui/SettingsPanel.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles-project.css', import.meta.url), 'utf8');

/** 取承载 `data-settings-key` 的那个开标签（属性顺序不参与判据） */
function openingTagOf(key: string): string {
  const re = new RegExp(`<div\\b[^>]*data-settings-key="${key}"[^>]*>`);
  return re.exec(tsx)?.[0] ?? '';
}

describe('设置页字体档位行的排版（两行通栏堆叠，不是两列栅格）', () => {
  for (const key of ['editor.fontFamily', 'appearance.uiFontFamily']) {
    it(`${key}：挂 stacked，且不再用内联 flexDirection 假装修版`, () => {
      const tag = openingTagOf(key);
      expect(tag).not.toBe('');
      expect(tag).toContain('stacked');
      expect(tag).not.toContain('flexDirection');
    });
  }

  it('.settings-row.stacked = 单列 flex（离开两列栅格）', () => {
    const rule = /\.settings-row\.stacked\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).toMatch(/flex-direction:\s*column/);
  });
});
