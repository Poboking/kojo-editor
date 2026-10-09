import { createElement, useEffect, useState } from 'react';
import type { ConventionIssue, ConventionLinterService, ConventionReport, Plugin } from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';

/**
 * 约定校验结果面板（`ui.panel` 槽贡献）。
 *
 * 分层：本插件只做**呈现 + 跳转意图**，不做校验逻辑（校验在 convention-linter 引擎、
 * 规则在 game adapter）。点击问题 → 通过内核事件 `editor.revealLocation` 请求宿主
 * 打开文件并定位行（不直接依赖 app 壳，保持插件可独立分发）。
 */

const SEVERITY_LABEL: Record<ConventionIssue['severity'], string> = {
  error: '错误',
  warning: '警告',
  info: '提示',
};

const SEVERITY_COLOR: Record<ConventionIssue['severity'], string> = {
  error: '#e06c75',
  warning: '#d19a66',
  info: '#7f9cc0',
};

/** 单规则最多渲染条数（避免上万行 DOM 拖垮面板） */
const RENDER_CAP = 300;

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.slice(-2).join('/');
}

export function createUiConventionReportPlugin(): Plugin {
  return {
    id: 'ui-convention-report',
    version: '0.2.0',
    requires: [WellKnownServices.ConventionLinter],
    activate(ctx) {
      const linter = ctx.inject<ConventionLinterService>(WellKnownServices.ConventionLinter);

      function ConventionPanel(): unknown {
        const [report, setReport] = useState<ConventionReport | null>(() => linter.report());
        const [running, setRunning] = useState(false);
        const [expanded, setExpanded] = useState<Set<string>>(new Set());
        const [showAll, setShowAll] = useState<Set<string>>(new Set());

        useEffect(() => {
          const un = linter.subscribe(setReport);
          return () => {
            un();
          };
        }, []);

        const rulesById = new Map(linter.rules().map((r) => [r.id, r]));

        const rerun = (): void => {
          setRunning(true);
          void linter.run().finally(() => setRunning(false));
        };

        const toggle = (setter: typeof setExpanded, id: string): void => {
          setter((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        };

        const open = (issue: ConventionIssue, ruleTitle: string): void => {
          if (!issue.filePath) return;
          ctx.bus.emit('editor.revealLocation', {
            filePath: issue.filePath,
            line: issue.line,
            source: ruleTitle,
          });
        };

        if (!report) {
          return createElement(
            'div',
            { className: 'panel-convention-report' },
            createElement('div', { className: 'conv-empty dim' }, '尚未运行（打开项目后自动校验）'),
          );
        }

        // 按规则分组
        const byRule = new Map<string, ConventionIssue[]>();
        for (const issue of report.issues) {
          const arr = byRule.get(issue.ruleId);
          if (arr) arr.push(issue);
          else byRule.set(issue.ruleId, [issue]);
        }
        const groups = [...byRule.entries()].sort((a, b) => b[1].length - a[1].length);

        const header = createElement(
          'div',
          { className: 'conv-summary' },
          createElement('span', { className: 'conv-count', style: { color: SEVERITY_COLOR.error } }, `错误 ${report.counts.error}`),
          createElement('span', { className: 'conv-count', style: { color: SEVERITY_COLOR.warning } }, `警告 ${report.counts.warning}`),
          createElement('span', { className: 'conv-count', style: { color: SEVERITY_COLOR.info } }, `提示 ${report.counts.info}`),
          createElement('span', { className: 'dim conv-meta' }, `${report.ruleCount} 规则 · ${report.durationMs}ms`),
        );

        const toolbar = createElement(
          'div',
          { className: 'conv-toolbar' },
          createElement(
            'button',
            { className: 'ghost small', disabled: running, onClick: rerun },
            running ? '校验中…' : '重新校验',
          ),
          createElement('span', { className: 'dim conv-meta' }, report.adapterId ? `适配器 ${report.adapterId}` : '未打开项目'),
        );

        // 失败规则显式提示（绝不静默）
        const failed =
          report.failedRules.length > 0
            ? createElement(
                'div',
                { className: 'conv-failed' },
                createElement('div', { className: 'conv-failed-head' }, `⚠ ${report.failedRules.length} 条规则执行失败`),
                createElement(
                  'ul',
                  { className: 'conv-failed-list' },
                  ...report.failedRules.map((f) =>
                    createElement('li', { key: f.ruleId }, createElement('code', null, f.ruleId), ` — ${f.error}`),
                  ),
                ),
              )
            : null;

        const list =
          groups.length === 0
            ? createElement('div', { className: 'conv-empty dim' }, '未发现问题 ✅')
            : createElement(
                'ul',
                { className: 'conv-groups' },
                ...groups.map(([ruleId, issues]) => {
                  const rule = rulesById.get(ruleId);
                  const title = rule ? rule.description : ruleId;
                  const isOpen = expanded.has(ruleId);
                  const cap = showAll.has(ruleId) ? issues.length : RENDER_CAP;
                  return createElement(
                    'li',
                    { key: ruleId, className: 'conv-group' },
                    createElement(
                      'button',
                      { className: 'conv-group-btn', onClick: () => toggle(setExpanded, ruleId) },
                      createElement('span', { className: 'caret' }, isOpen ? '▾' : '▸'),
                      createElement('span', { className: 'conv-rule-id' }, ruleId),
                      createElement('span', { className: 'conv-group-count' }, String(issues.length)),
                    ),
                    createElement('div', { className: 'conv-rule-desc dim' }, title),
                    isOpen
                      ? createElement(
                          'ul',
                          { className: 'conv-issues' },
                          ...issues.slice(0, cap).map((issue, i) =>
                            createElement(
                              'li',
                              { key: issue.key ?? `${ruleId}-${i}`, className: 'conv-issue' },
                              createElement(
                                'button',
                                {
                                  className: `conv-issue-btn sev-${issue.severity}`,
                                  title: issue.message,
                                  onClick: () => open(issue, title),
                                },
                                createElement('span', {
                                  className: 'conv-dot',
                                  style: { backgroundColor: SEVERITY_COLOR[issue.severity] },
                                }),
                                createElement(
                                  'span',
                                  { className: 'conv-issue-loc dim' },
                                  issue.filePath ? `${shortPath(issue.filePath)}:${issue.line ?? 0}` : '（无定位）',
                                ),
                                createElement('span', { className: 'conv-issue-msg' }, issue.message),
                              ),
                            ),
                          ),
                          issues.length > cap
                            ? createElement(
                                'li',
                                { className: 'conv-more' },
                                createElement(
                                  'button',
                                  { className: 'ghost small', onClick: () => toggle(setShowAll, ruleId) },
                                  `显示全部 ${issues.length} 条`,
                                ),
                              )
                            : null,
                        )
                      : null,
                  );
                }),
              );

        return createElement(
          'div',
          { className: 'panel-convention-report' },
          header,
          toolbar,
          failed,
          list,
          createElement(
            'div',
            { className: 'conv-legend dim' },
            `严重度：${SEVERITY_LABEL.error} / ${SEVERITY_LABEL.warning} / ${SEVERITY_LABEL.info}`,
          ),
        );
      }

      ctx.slots.register('ui.panel', {
        id: 'convention-report',
        title: '约定校验',
        icon: '✓',
        order: 50,
        component: ConventionPanel,
      });
    },
  };
}
