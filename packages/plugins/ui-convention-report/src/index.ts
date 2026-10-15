import { createElement, useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  ConventionIssue,
  ConventionLinterService,
  ConventionReport,
  ErbParserService,
  FamilyIndexRule,
  GameProject,
  Plugin,
  ProjectService,
  SlotRegistry,
  UIPanelProps,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { charaDirOwners, type OwnershipDeps } from './ownership';
import { buildGroupView, GROUP_MODE_LABEL, GROUP_MODES, type GroupMode } from './view';

/**
 * 约定校验结果面板（`ui.panel` 槽贡献）。
 *
 * 分层：本插件只做**呈现 + 跳转意图**，不做校验逻辑（校验在 convention-linter 引擎、
 * 规则在 game adapter）。点击问题 → 通过内核事件 `editor.revealLocation` 请求宿主
 * 打开文件并定位行（不直接依赖 app 壳，保持插件可独立分发）。
 *
 * 三种分组视角（`./view.ts` + `./ownership.ts` 两个纯模块，本文件只搬运状态）：
 * 默认「按规则看」与本批之前逐字一致；「按角色看 / 按家族看」把同一批条目换个主语，
 * 归属判据一律来自 `ConventionIssue` 既有字段、适配器家族规则与 `charaIndex`
 * ——本插件**不认识任何游戏命名形状**，也不在这里复刻第二份角色清单。
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
    requires: [WellKnownServices.ConventionLinter, WellKnownServices.ErbParser, KernelServices.Project, KernelServices.Slots],
    activate(ctx) {
      const linter = ctx.inject<ConventionLinterService>(WellKnownServices.ConventionLinter);
      const parser = ctx.inject<ErbParserService>(WellKnownServices.ErbParser);
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      const slots = ctx.inject<SlotRegistry>(KernelServices.Slots);

      /** 当前激活适配器的家族规则（多适配器共存时按 adapterId 精确匹配；与导航树同一取法） */
      const currentFamilyIndex = (current: GameProject | null): FamilyIndexRule | null => {
        if (!current) return null;
        for (const contribution of slots.query('game.adapter')) {
          if (contribution.adapter.gameId === current.adapterId && contribution.adapter.functionFamilyIndex) {
            return contribution.adapter.functionFamilyIndex;
          }
        }
        return null;
      };

      /**
       * 归属判据的三口子（每次取当前值：切项目 / 关项目后不能拿旧表去归属新数据）。
       * `functionAt` 缺席（索引未就绪）与家族规则缺席都只意味着**少一级判据**，
       * 条目的归属会相应变少并在总账里如实显示 —— 不降级成"全部未知角色"。
       */
      const ownershipDeps = (current: GameProject | null): OwnershipDeps => ({
        familyIndex: currentFamilyIndex(current),
        functionAt: parser.functionAt ? (path, line) => parser.functionAt!(path, line) : undefined,
        dirOwners: charaDirOwners(current?.charaIndex ?? null),
      });

      function ConventionPanel(props: UIPanelProps): unknown {
        const [report, setReport] = useState<ConventionReport | null>(() => linter.report());
        const [running, setRunning] = useState(false);
        const [expanded, setExpanded] = useState<Set<string>>(new Set());
        const [showAll, setShowAll] = useState<Set<string>>(new Set());
        /** 分组视角：默认「按规则看」（= 本批之前的视图） */
        const [mode, setMode] = useState<GroupMode>('rule');

        /** 图标桥（E6 图标统一）：宿主经 props.renderIcon 注入；缺省回退纯文本字形（绝不空白） */
        const ic = (name: string, size: number, fallback: string): ReactNode =>
          (props.renderIcon?.(name, size) as ReactNode | undefined) ?? fallback;

        useEffect(() => {
          const un = linter.subscribe(setReport);
          return () => {
            un();
          };
        }, []);

        const rulesById = useMemo(() => new Map(linter.rules().map((r) => [r.id, r])), [report]);

        /**
         * 当前视角的分组（纯函数，见 `./view.ts`）。
         * 默认 `rule`：与改造前同一份分组、同一套排序；`character` / `family` 才会去
         * 问索引与家族规则（不选就不付这笔钱）。
         */
        const view = useMemo(() => {
          const current = project.current();
          return buildGroupView(mode, report?.issues ?? [], {
            ruleDescription: (id) => rulesById.get(id)?.description ?? id,
            ownership: ownershipDeps(current),
            charaIndex: current?.charaIndex ?? null,
          });
        }, [mode, report, rulesById]);

        const rerun = (): void => {
          setRunning(true);
          // 手动重跑 = 强制真算（结果快照只服务于开项目级联的自动那一路）
          void linter.run({ force: true }).finally(() => setRunning(false));
        };

        const toggle = (setter: typeof setExpanded, id: string): void => {
          setter((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        };

        /** 跳转意图：`source` 记的是"从哪一组点出来的"（角色/家族视角里就是那一组的标签） */
        const open = (issue: ConventionIssue, groupTitle: string): void => {
          if (!issue.filePath) return;
          ctx.bus.emit('editor.revealLocation', {
            filePath: issue.filePath,
            line: issue.line,
            source: groupTitle,
          });
        };

        if (!report) {
          return createElement(
            'div',
            { className: 'panel-convention-report' },
            createElement('div', { className: 'conv-empty dim' }, '尚未运行（打开项目后自动校验）'),
          );
        }

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
          // 分组视角切换（默认「按规则看」）。三个词都是人话，且都是**同一批条目的分组方式**，
          // 不是三套数据 —— 切换不重跑校验、不改条目，只换主语。
          createElement(
            'span',
            { className: 'conv-modes', role: 'group', 'aria-label': '分组方式' },
            ...GROUP_MODES.map((m) =>
              createElement(
                'button',
                {
                  key: m,
                  className: m === mode ? 'small conv-mode-on' : 'ghost small',
                  'aria-pressed': m === mode,
                  onClick: () => setMode(m),
                },
                GROUP_MODE_LABEL[m],
              ),
            ),
          ),
          createElement('span', { className: 'dim conv-meta' }, report.adapterId ? `适配器 ${report.adapterId}` : '未打开项目'),
        );

        // 归属总账（只有角色/家族视角才有；数字与条目数逐字对得上）
        const summary = view.summary
          ? createElement('div', { className: 'conv-rollup dim' }, view.summary)
          : null;

        // 失败规则显式提示（绝不静默）
        const failed =
          report.failedRules.length > 0
            ? createElement(
                'div',
                { className: 'conv-failed' },
                createElement(
                  'div',
                  { className: 'conv-failed-head' },
                  ic('warning', 12, '⚠'),
                  ` ${report.failedRules.length} 条规则执行失败`,
                ),
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
          view.groups.length === 0
            ? createElement('div', { className: 'conv-empty dim' }, '未发现问题 ✅')
            : createElement(
                'ul',
                { className: 'conv-groups' },
                ...view.groups.map((group) => {
                  const isOpen = expanded.has(group.key);
                  const cap = showAll.has(group.key) ? group.count : RENDER_CAP;
                  return createElement(
                    'li',
                    { key: group.key, className: 'conv-group' },
                    createElement(
                      'button',
                      { className: 'conv-group-btn', onClick: () => toggle(setExpanded, group.key) },
                      createElement('span', { className: 'caret' }, ic(isOpen ? 'chevron-down' : 'chevron-right', 12, isOpen ? '▾' : '▸')),
                      createElement('span', { className: 'conv-rule-id' }, group.title),
                      createElement('span', { className: 'conv-group-count' }, String(group.count)),
                    ),
                    createElement('div', { className: 'conv-rule-desc dim' }, group.desc),
                    isOpen
                      ? createElement(
                          'ul',
                          { className: 'conv-issues' },
                          ...group.issues.slice(0, cap).map((issue, i) =>
                            createElement(
                              'li',
                              { key: issue.key ?? `${group.key}-${i}`, className: 'conv-issue' },
                              createElement(
                                'button',
                                {
                                  className: `conv-issue-btn sev-${issue.severity}`,
                                  title: issue.message,
                                  onClick: () => open(issue, group.title),
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
                                // 角色/家族的一组里混着多条规则 ⇒ 条目行得说出它是哪条规则的事；
                                // 规则视角那一带已经在组头上给过，不重复显示。
                                group.showRuleTag
                                  ? createElement('span', { className: 'conv-issue-rule dim' }, issue.ruleId)
                                  : null,
                                createElement('span', { className: 'conv-issue-msg' }, issue.message),
                              ),
                            ),
                          ),
                          group.count > cap
                            ? createElement(
                                'li',
                                { className: 'conv-more' },
                                createElement(
                                  'button',
                                  { className: 'ghost small', onClick: () => toggle(setShowAll, group.key) },
                                  `显示全部 ${group.count} 条`,
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
          summary,
          failed,
          list,
          createElement(
            'div',
            { className: 'conv-legend dim' },
            `严重度：${SEVERITY_LABEL.error} / ${SEVERITY_LABEL.warning} / ${SEVERITY_LABEL.info}`,
          ),
        );
      }

      /* --------------------------- 状态栏诊断计数 --------------------------- */

      // 状态栏聚合计数（`ui.statusbar` 槽，P3b）：数据源与底部区面板同一份 report。
      // 壳层暂无「打开指定容器」的通用事件，点击落地为 title 提示 Ctrl+J（切换底部区）
      // ——不静默、不假装可点。
      //
      // **配色只留给 error**（2026-10-13 目视体检 §5.122 §五-2）：全量铺严重度色时，
      // 状态栏是这个项目最吵的一处——真实语料的 `⚠ 647` 用琥珀色大写数字，视觉重量压过
      // 同排的「可写」胶囊，而它是**项目级常态计数**，不是用户此刻要对的东西。
      // 严重度的语义在底部面板里逐条呈现；状态栏只该在"有 error"时唤醒读者
      // （error 一律是全项目 0 条，因为约定校验的 error 是真事故）。数字用等宽数位防抖。
      function StatusCounts(props: UIPanelProps): unknown {
        const [report, setReport] = useState<ConventionReport | null>(() => linter.report());
        useEffect(() => linter.subscribe(setReport), []);

        /** 图标桥：同 ConventionPanel（状态栏小件亦经 props.renderIcon 注入，缺省回退字形） */
        const ic = (name: string, size: number, fallback: string): ReactNode =>
          (props.renderIcon?.(name, size) as ReactNode | undefined) ?? fallback;
        if (!report) return createElement('span', { className: 'dim' }, '校验 —');
        const c = report.counts;
        const item = (icon: string, glyph: string, n: number, critical: boolean): ReactNode =>
          createElement(
            'span',
            {
              className: 'sb-diag-item',
              ...(critical && n > 0 ? { style: { color: SEVERITY_COLOR.error } } : {}),
            },
            ic(icon, 12, glyph),
            ` ${n}`,
          );
        return createElement(
          'span',
          { className: 'sb-diag', title: '约定校验计数（Ctrl+J 切换底部区查看明细）' },
          item('close', '✕', c.error, true),
          item('warning', '⚠', c.warning, false),
          item('info', 'ℹ', c.info, false),
        );
      }

      ctx.slots.register('ui.statusbar', {
        id: 'convention-counts',
        align: 'left',
        order: 20,
        component: StatusCounts,
      });

      ctx.slots.register('ui.panel', {
        id: 'convention-report',
        title: '约定校验',
        icon: 'check',
        order: 50,
        // UI 重设计批 P1：诊断列表迁底部区（Problems 形态，定稿 §四/§6.3）
        location: 'bottom',
        component: ConventionPanel,
      });
    },
  };
}
