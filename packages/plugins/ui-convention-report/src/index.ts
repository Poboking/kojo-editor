import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
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
import {
  attachGrowSentinel,
  diagnosticDisplay,
  KernelServices,
  MORE_ROW_STYLE,
  MORE_ROW_TITLE,
  moreRowLabel,
  shortPath,
  WellKnownServices,
} from '@kojo/plugin-api';
import { charaDirOwners, type OwnershipDeps } from './ownership';
import { buildGroupView, GROUP_MODE_LABEL, GROUP_MODES, type GroupMode } from './view';
import { ISSUE_WINDOW_INITIAL, issueWindowSize, nextIssueWindow } from './panel-logic';
import {
  LINT_PROJECT_COMMAND_CATEGORY,
  LINT_PROJECT_COMMAND_ID,
  LINT_PROJECT_COMMAND_TITLE,
  LINT_STOP_COMMAND_CATEGORY,
  LINT_STOP_COMMAND_ID,
  LINT_STOP_COMMAND_TITLE,
  createLintRunStore,
  driveLintRun,
  lintRunBrief,
  lintRunText,
  type LintRunState,
} from './lint-run';

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

/* ------------------------------ 条目窗口 ------------------------------ */

/**
 * 「显示更多」哨兵（组内条目列表的触底器）。
 *
 * 观察器行为核住在契约层 `sugar-panels` 的 `attachGrowSentinel`（进入滚动视口即
 * 追加下一窗；观察器不可用——SSR / 测试 / 旧环境——时返回空退订 ⇒ 退化为**纯点击
 * 按钮**，功能不丢）。外观三件套（样式 / 悬停提示 / 「显示更多（还剩 N）」）与其余
 * 面板同源同值，**className 仍是本面板自己的 `conv-more-btn`**（视觉口径不漂）。
 * ref 用稳定回调 ref 拿真实节点，避免每次渲染重挂 observer；回调只在**触发时**经
 * `onMoreRef` 取最新值（observer 只挂一次，捕获旧闭包 = 窗口行为静默改变）。
 */
function MoreRow({ remaining, onMore }: { remaining: number; onMore: () => void }): ReactElement {
  const anchor = useRef<unknown>(null);
  const setAnchor = useCallback((node: unknown): void => {
    anchor.current = node;
  }, []);
  /** 最新回调引用（observer 只挂一次，不做重复挂卸） */
  const onMoreRef = useRef(onMore);
  onMoreRef.current = onMore;
  useEffect(() => attachGrowSentinel(anchor.current, () => onMoreRef.current()), []);
  return createElement(
    'button',
    {
      ref: setAnchor,
      className: 'ghost small dim conv-more-btn',
      style: MORE_ROW_STYLE,
      title: MORE_ROW_TITLE,
      onClick: () => onMore(),
    },
    moreRowLabel(remaining),
  );
}

/** 组内条目列表（窗口化渲染；模块级组件 ⇒ 可独立 SSR 单测 DOM 行数上界） */
export interface IssueListProps {
  /** 条目来源组（窗口按组键定位） */
  readonly groupKey: string;
  readonly issues: readonly ConventionIssue[];
  /** 组头已示总数（窗口逼近它时哨兵消失的判据） */
  readonly count: number;
  /** 角色/家族视角里条目行要带规则标识（一组里混着多条规则）；规则视角不需要 */
  readonly showRuleTag: boolean;
  /** 该组当前渲染窗口行数（undefined = 初始窗口） */
  readonly limit: number | undefined;
  /** 触底 / 点击「显示更多」→ 扩大该组窗口（新值由 nextIssueWindow 计算） */
  readonly onGrow: (groupKey: string, total: number) => void;
  /** 点击条目 = 跳转意图（宿主消费） */
  readonly onOpen: (issue: ConventionIssue) => void;
}

export function IssueList(props: IssueListProps): ReactElement {
  const { issues, count } = props;
  const win = issueWindowSize(count, props.limit);
  return createElement(
    'ul',
    { className: 'conv-issues' },
    ...issues.slice(0, win).map((issue, i) =>
      createElement(
        'li',
        { key: issue.key ?? `${props.groupKey}-${i}`, className: 'conv-issue' },
        createElement(
          'button',
          {
            className: `conv-issue-btn sev-${issue.severity}`,
            title: issue.message,
            onClick: () => props.onOpen(issue),
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
          props.showRuleTag
            ? createElement('span', { className: 'conv-issue-rule dim' }, issue.ruleId)
            : null,
          createElement('span', { className: 'conv-issue-msg' }, issue.message),
        ),
      ),
    ),
    count > win
      ? createElement(
          'li',
          { className: 'conv-more' },
          createElement(MoreRow, {
            key: 'more',
            remaining: count - win,
            onMore: () => props.onGrow(props.groupKey, count),
          }),
        )
      : null,
  );
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

      /**
       * 一次运行的读数仓（命令面板那条命令与面板「重新校验」按钮**共用同一份**）。
       * 覆盖文件数取引擎真正走过的那份清单 = 索引的 `files`，不在这里另数一遍目录。
       */
      const runStore = createLintRunStore();
      const coveredFileCount = (): number => parser.currentIndex()?.files.size ?? 0;
      const runProjectLint = (): Promise<void> =>
        driveLintRun({ linter, store: runStore, coveredFiles: coveredFileCount });
      // 自动那一路（存盘后引擎自己重跑）也得把读数刷新：只认按钮/命令的话，
      // 面板会一直挂着"上一次手动校验"的数字。
      ctx.onDispose(
        linter.subscribe((r) => {
          if (r) runStore.finish(r, coveredFileCount());
        }),
      );

      /** 校验中的那一档要有活读数：只有running时才挂表（跑完就停，不留常驻定时器） */
      function useLintRun(): { state: LintRunState; now: number } {
        const [state, setState] = useState<LintRunState>(() => runStore.get());
        const [now, setNow] = useState(() => Date.now());
        useEffect(() => runStore.subscribe(setState), []);
        useEffect(() => {
          if (state.phase !== 'running') return;
          setNow(Date.now());
          const t = setInterval(() => setNow(Date.now()), 400);
          return () => {
            clearInterval(t);
          };
        }, [state.phase]);
        return { state, now };
      }

      function ConventionPanel(props: UIPanelProps): unknown {
        const [report, setReport] = useState<ConventionReport | null>(() => linter.report());
        const run = useLintRun();
        const [expanded, setExpanded] = useState<Set<string>>(new Set());
        /** 各组已扩张的渲染窗口（行数；缺省 = ISSUE_WINDOW_INITIAL——旧实现每组硬截 300 条） */
        const [groupWindows, setGroupWindows] = useState<Map<string, number>>(new Map());
        /** 分组视角：默认「按规则看」（= 本批之前的视图） */
        const [mode, setMode] = useState<GroupMode>('rule');

        /** 触底 / 点击「显示更多」→ 按 STEP 追加（单调不减、步长有界；计算在 panel-logic 可单测） */
        const growGroup = useCallback((groupKey: string, total: number): void => {
          setGroupWindows((prev) => {
            const cur = prev.get(groupKey);
            const next = nextIssueWindow(cur, total);
            if (next === (cur ?? ISSUE_WINDOW_INITIAL)) return prev; // 无变化不重渲
            const m = new Map(prev);
            m.set(groupKey, next);
            return m;
          });
        }, []);

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
            ruleDescription: (id) => rulesById.get(id)?.description ?? diagnosticDisplay(id).name,
            ownership: ownershipDeps(current),
            charaIndex: current?.charaIndex ?? null,
          });
        }, [mode, report, rulesById]);

        const running = run.state.phase === 'running';

        /** 手动重跑 = 强制真算；与命令面板那条命令同一条通道（`driveLintRun`） */
        const rerun = (): void => {
          void runProjectLint();
        };
        /**
         * 叫停：只按下 `runStore` 手上那一轮的取消位（还是同一个 `store`，没有第二条取数通道）。
         * 收摊要等**正在算的那一棵**算完，所以按钮按下后仍会"校验中"一小会儿——
         * 那一轮的结论由引擎说（`report.incomplete`），这里不许自己改成"不完整"。
         */
        const stop = (): void => {
          runStore.cancel();
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

        /**
         * 本轮读数：查了多少个文件 / 用了多久 / 几处问题（跑坏时就是那句原因）。
         * 命令面板那条命令没有打开任何面板，这行 + 状态栏那枚就是它的回响。
         */
        const runLine =
          run.state.phase === 'idle'
            ? null
            : createElement('div', { className: 'conv-runline dim' }, lintRunText(run.state, run.now));

        if (!report) {
          return createElement(
            'div',
            { className: 'panel-convention-report' },
            createElement('div', { className: 'conv-empty dim' }, '尚未运行（打开项目后自动校验）'),
            runLine,
          );
        }

        const header = createElement(
          'div',
          { className: 'conv-summary' },
          createElement('span', { className: 'conv-count', style: { color: SEVERITY_COLOR.error } }, `错误 ${report.counts.error}`),
          createElement('span', { className: 'conv-count', style: { color: SEVERITY_COLOR.warning } }, `警告 ${report.counts.warning}`),
          createElement('span', { className: 'conv-count', style: { color: SEVERITY_COLOR.info } }, `提示 ${report.counts.info}`),
          createElement('span', { className: 'dim conv-meta' }, `${report.ruleCount} 条规则`),
        );

        const toolbar = createElement(
          'div',
          { className: 'conv-toolbar' },
          createElement(
            'button',
            { className: 'ghost small', disabled: running, onClick: rerun },
            running ? '校验中…' : '重新校验',
          ),
          // 只有真在跑才给这一枚（不在跑时按它没对象可停，灰着说话不如不出现）
          running
            ? createElement(
                'button',
                { className: 'ghost small', onClick: stop, title: '叫停这一轮：已查完的结论留着，这一轮不写进结果缓存' },
                '叫停',
              )
            : null,
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
                      ? createElement(IssueList, {
                          groupKey: group.key,
                          issues: group.issues,
                          count: group.count,
                          showRuleTag: group.showRuleTag,
                          limit: groupWindows.get(group.key),
                          onGrow: growGroup,
                          onOpen: (issue: ConventionIssue) => open(issue, group.title),
                        })
                      : null,
                  );
                }),
              );

        return createElement(
          'div',
          { className: 'panel-convention-report' },
          header,
          runLine,
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
      /**
       * 这枚小件数的是什么（2026-10-19 自造重叠清账批，判据②）：**项目级**约定计数——
       * 整份 `report.counts`，含**没在编辑器里打开**的文件与**没有文件归属**的整项目结论。
       * 它天生不等于同排那枚「问题 n」（后者只数**已打开文件**面上正画着的波浪线，
       * 且还含 ERB 结构 / 表达式 / `.kojo` 转译这几家自己的账），两本数各自说清口径、
       * 不许留两个裸数字（对账恒等式见 `convention-linter/src/index.ts` 的 DIAG-LINK 注）。
       */
      const STATUSBAR_TITLE =
        '项目级约定计数，含未打开文件与整项目结论 ≠ 状态栏「问题」· Ctrl+J 切换底部区查看明细';

      function StatusCounts(props: UIPanelProps): unknown {
        const [report, setReport] = useState<ConventionReport | null>(() => linter.report());
        useEffect(() => linter.subscribe(setReport), []);
        /** 在途/被叫停/失败的这一句只在这里出现一次：状态栏常驻，面板可能压根没打开 */
        const run = useLintRun();
        const brief = lintRunBrief(run.state, run.now);
        const title =
          run.state.phase === 'failed'
            ? `这轮校验没跑完：${run.state.errorText}`
            : run.state.phase === 'stopped'
              ? lintRunText(run.state, run.now)
              : STATUSBAR_TITLE;
        const critical = run.state.phase === 'failed';

        /** 图标桥：同 ConventionPanel（状态栏小件亦经 props.renderIcon 注入，缺省回退字形） */
        const ic = (name: string, size: number, fallback: string): ReactNode =>
          (props.renderIcon?.(name, size) as ReactNode | undefined) ?? fallback;
        const briefNode = brief
          ? createElement(
              'span',
              {
                className: 'sb-diag-item',
                ...(critical ? { style: { color: SEVERITY_COLOR.error } } : {}),
              },
              brief,
            )
          : null;
        if (!report)
          return createElement(
            'span',
            { className: 'dim', title },
            briefNode ?? '校验 —',
          );
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
          { className: 'sb-diag', title },
          briefNode,
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

      /* --------------------------- 全项目校验的命令面板入口 --------------------------- */

      /**
       * 判据**不在这里**：这条命令只做"叫引擎跑一轮 + 把读数送到既有面上"，
       * 遍历与转译全在 `convention-linter`（`driveLintRun` → `linter.run`，与面板按钮同一条通道）。
       * 刻意不写 `when`：没开项目时也按得下去，读数行会如实说"查了 0 个文件"——
       * 灰在面板里不说话才是本仓禁止的形态。
       */
      ctx.slots.register('editor.command', {
        id: LINT_PROJECT_COMMAND_ID,
        title: LINT_PROJECT_COMMAND_TITLE,
        category: LINT_PROJECT_COMMAND_CATEGORY,
        run: () => runProjectLint(),
      });

      /**
       * 叫停那条命令（ZH-F4b）：它**不取任何数**——只按下 `runStore` 手上那一轮的取消位，
       * 于是面板那枚「叫停」与命令面板这条命令停的必然是同一轮（两条收摊路迟早对不上账）。
       * 不在跑的时候按它 = 空操作，读数纹丝不动（引擎没起轮，就没有"半轮"可说）。
       */
      ctx.slots.register('editor.command', {
        id: LINT_STOP_COMMAND_ID,
        title: LINT_STOP_COMMAND_TITLE,
        category: LINT_STOP_COMMAND_CATEGORY,
        run: async () => {
          runStore.cancel();
        },
      });
    },
  };
}
