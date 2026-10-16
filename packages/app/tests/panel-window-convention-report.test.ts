/**
 * 约定校验面板 · 组内条目列表（IssueList）的窗口化 DOM 行数上界证据（2026-10-16 窗口批）。
 *
 * 为什么住 app 侧：react-dom（SSR）只有 app 包依赖；断言对象是 ui-convention-report
 * 插件的 `IssueList`（相对导入其 src——与 vitest alias 同源）。
 *
 * 口径（照 face-list-render.test.ts）：初开 ≤ ISSUE_WINDOW_INITIAL / 触底每步 +STEP /
 * 窗口 ≥ total 哨兵消失（旧实现是每组硬截 300 + 「显示全部 N 条」一键全挂——
 * 前者第 301 条起不可达，后者一次挂满整组；窗口版两者合一：全量可达且增量有界）。
 */

import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConventionIssue } from '@kojo/plugin-api';
import { IssueList } from '../../plugins/ui-convention-report/src/index';
import { ISSUE_WINDOW_INITIAL, ISSUE_WINDOW_STEP } from '../../plugins/ui-convention-report/src/panel-logic';

function issue(i: number): ConventionIssue {
  return {
    ruleId: 'no-fullwidth',
    severity: 'warning',
    message: `第 ${i} 条约定问题`,
    filePath: '/p/kojo/001/A.ERB',
    line: i,
  };
}
const issues = (n: number): ConventionIssue[] => Array.from({ length: n }, (_, i) => issue(i + 1));
const count = (markup: string, sub: string): number => (markup.split(sub).length - 1);

function render(list: ConventionIssue[], limit: number | undefined, showRuleTag = false): string {
  return renderToStaticMarkup(
    h(IssueList, {
      groupKey: 'g1',
      issues: list,
      count: list.length,
      showRuleTag,
      limit,
      onGrow: () => {},
      onOpen: () => {},
    }),
  );
}

describe('IssueList · 组内条目窗口的 DOM 行数上界', () => {
  it('10k 条：初开只挂 INITIAL 条 + 一个哨兵（旧实现要挂 300 条且其余不可达）', () => {
    const html = render(issues(10_000), undefined);
    expect(count(html, 'conv-issue-btn')).toBe(ISSUE_WINDOW_INITIAL);
    expect(count(html, 'conv-more-btn')).toBe(1);
    expect(html).toContain(`显示更多（还剩 ${10_000 - ISSUE_WINDOW_INITIAL}）`);
  });

  it('窗口按 STEP 生长：每步只多挂 STEP 条；到 total 后哨兵消失', () => {
    const htmlStep = render(issues(10_000), ISSUE_WINDOW_INITIAL + ISSUE_WINDOW_STEP);
    expect(count(htmlStep, 'conv-issue-btn')).toBe(ISSUE_WINDOW_INITIAL + ISSUE_WINDOW_STEP);
    expect(htmlStep).toContain(`显示更多（还剩 ${10_000 - ISSUE_WINDOW_INITIAL - ISSUE_WINDOW_STEP}）`);

    const htmlFull = render(issues(10_000), 10_000);
    expect(count(htmlFull, 'conv-issue-btn')).toBe(10_000);
    expect(count(htmlFull, 'conv-more-btn')).toBe(0);
  });

  it('小列表（≤ INITIAL）：无哨兵、条数 = total（与旧实现的常见路径同构）', () => {
    const html = render(issues(25), undefined);
    expect(count(html, 'conv-issue-btn')).toBe(25);
    expect(count(html, 'conv-more-btn')).toBe(0);
  });

  it('行为语义不丢：定位行 / 严重度类名 / 规则视角不带规则标签、角色视角带', () => {
    const plain = render(issues(3), undefined);
    expect(count(plain, 'conv-issue-btn sev-warning')).toBe(3);
    expect(plain).toContain('A.ERB:1');
    expect(plain).toContain('第 1 条约定问题');
    expect(count(plain, 'conv-issue-rule')).toBe(0);
    expect(count(render(issues(3), undefined, true), 'conv-issue-rule')).toBe(3);
  });

  it('count 与 issues 长度不一致时仍以 count（组头总数）为窗口上界——不越界渲染', () => {
    const html = renderToStaticMarkup(
      h(IssueList, {
        groupKey: 'g1',
        issues: issues(5),
        count: 5,
        showRuleTag: false,
        limit: 10_000,
        onGrow: () => {},
        onOpen: () => {},
      }),
    );
    expect(count(html, 'conv-issue-btn')).toBe(5);
    expect(count(html, 'conv-more-btn')).toBe(0);
  });
});
