/**
 * 条件矩阵「填格子」标记的 CSS 回归钉。
 *
 * 用户两次反馈标记不够醒目（第一次 `+`，第二次红圈）。2026-10-19 的红圈样式
 * 曾被另一批次的 CSS 合并整块覆盖回 `+`——样式没有类型检查，只能靠这条用例
 * 守住「填格模式必须出现红色打勾」这条产品口径。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles-project.css', import.meta.url), 'utf8');

/** 取从 `start` 到 `end` 之间的样式片段（end 不存在时取到文件尾） */
function sliceCss(start: string, end: string): string {
  const from = css.indexOf(start);
  const to = css.indexOf(end, from + start.length);
  return css.slice(from, to < 0 ? undefined : to);
}

describe('条件矩阵填格子标记（CSS）', () => {
  const marker = sliceCss('.cm-scroll.cm-fill :where(.cm-cell.off)', '.cm-cell.sel {');

  it('空缺格 = 红色打勾 + 红圈（不是旧的 +）', () => {
    expect(marker).toContain("content: '✓'");
    expect(marker).toContain('border: 1.5px solid var(--red)');
    expect(marker).toContain('border-radius: 50%');
    expect(marker).not.toContain("content: '+'");
  });

  it('已选格 = 实心红圆 + 白色 ✓，并给整格红框', () => {
    expect(marker).toContain('.cm-cell.off.fill-sel)');
    expect(marker).toContain('background: var(--red)');
    expect(marker).toContain('color: #fff');
    expect(marker).toContain('inset 0 0 0 1px var(--red)');
  });

  it('填格子开关激活态与标记同色（红）', () => {
    expect(css).toContain('.cm-toggle.on.cm-fill-toggle');
    const toggle = sliceCss('.cm-toggle.on.cm-fill-toggle', '}');
    expect(toggle).toContain('var(--red)');
  });

  it('填空条底色也随模式转红（不是只靠格子上的小标记）', () => {
    const bar = sliceCss('.cm-fillbar {', '}');
    expect(bar).toContain('var(--red)');
  });
});
