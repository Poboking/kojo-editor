/**
 * @kojo/plugin-ui-sugar-editor
 *
 * 语法糖**编辑体验**（v0.3 批 S6 + 2026-10-12 保存接线批 + 2026-10-19 W3 快速修复批）：
 * 四处贡献，都只做
 * **呈现/翻译/编排**，语义全在 `kojo-sugar` 的 `sugar.transpile`（纯函数）——
 *
 *   1. `ui.editor.decorator`（id `sugar-diagnostics`）：对当前 `.kojo` 源转译，
 *      把诊断翻成**行级装饰**（带列区间）→ 宿主（app 壳）消费为 Monaco markers，
 *      即规范 §8「危险波浪线」；
 *   2. `ui.editor.codeAction`（id `sugar-quickfix`，2026-10-19 W3 批）：把**可自动修**的那几条
 *      转译诊断落成 `kind:'quickfix'` 动作（自带 `edits` + 原样回递的那条波浪线）——判据闭集
 *      与"代回转译器自证"都在 `kojo-quickfix.ts`；只改 model、不写盘；
 *   3. `ui.editor.saveHandler`（id `sugar-save`，2026-10-12 批）：接管 `.kojo`
 *      保存——保存源文件 + 经 `planSave`/`compileToFile` 编译产物（逻辑见
 *      `save-handler.ts`）；宿主零 `.kojo` 知识，缺失时退化为缺省保存；
 *   4. `ui.panel`（id `sugar-verdict`，标题「糖判定」）：当前 `.kojo` 文件的
 *      **编译判定**——可编译 / 有警告 / 不可编译 + 逐条诊断（点击 → 定位源行）。
 *
 * 分层与解耦（对应 ARCHITECTURE.md §4 与 DSH 哲学）：
 *   - 装饰与判定都是**纯函数**（不读盘不写盘不发事件）——`decorate()` 拿到的
 *     就是宿主给的 `{path, text}`，转译器无 IO；面板的读盘走内核 io（只读）；
 *   - 判定/装饰归类在 `panel-logic.ts`（零 React，可单测）；
 *   - 快速修复的判据闭集与自证归类在 `kojo-quickfix.ts`（零 React、零 IO，可单测）；
 *   - 当前文件 / 文本真相 / 光标位点分别来自宿主事件 `editor.activeFileChanged` /
 *     `editor.documentChanged`（C2：编辑器缓冲 = 当前可编译真相，读盘只是还没收到
 *     广播前的兜底）/ `editor.cursorMoved`（C1 反向下行：光标动、诊断高亮跟）——
 *     W4 起三条订阅住共享核 `createPanelTruthController`（attach 一次订齐、
 *     dispose 一次退净），面板不持有宿主引用、也不自带第二份事件拷贝；
 *   - 跳转复用宿主既有通道 `editor.revealLocation`；
 *   - 零游戏知识：本插件不认得任何游戏术语，变量字典/分野模板全在 adapter。
 *
 * 模块布局（2026-10-17 拆分批；本文件只剩**装配注册**与**守卫钉住的诊断列表**）：
 *   `decorations.ts` 波浪线翻译核 + 任务 kind · `verdict-panel.ts` 判定面板组件 ·
 *   `new-file-wiring.ts` 新建流程的总线挂卸 · `new-file-flow.ts` 落盘编排 ·
 *   `new-file-wizard.ts` 向导组件 · `save-handler.ts` 保存链路 · `panel-logic.ts` 判定归类 ·
 *   `kojo-quickfix.ts` 快速修复判据（`.kojo` 后缀与写允许域两道闸按该文件头注留在本文件）。
 *   「显示更多」哨兵与诊断列表（`MoreRow` / `VerdictDiagList` / `sevLabel`）留在本文件：
 *   app 侧静态守卫 `packages/app/tests/diagnostic-copy.test.ts` 钉的就是这段源码文本。
 */

import { createElement, useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import type {
  FileIO,
  LineDecoration,
  OpJournal,
  Plugin,
  PluginContextMenuAnchor,
  ProjectService,
  SlotRegistry,
  SugarDiagnostic,
  SugarTranspileService,
  WorkspaceService,
} from '@kojo/plugin-api';
import {
  KernelServices,
  WellKnownCommands,
  WellKnownServices,
  diagnosticDisplay,
} from '@kojo/plugin-api';
import {
  MORE_ROW_STYLE,
  MORE_ROW_TITLE,
  attachGrowSentinel,
  diagWindowSize,
  isKojoFile,
  moreRowLabel,
  type VerdictRow,
} from './panel-logic';
import { SUGAR_DECORATIONS_TASK, createSugarDecorations } from './decorations';
import { NEW_KOJO_OVERLAY_ID, createNewKojoWizard } from './new-file-wizard';
import { wireNewKojoFileFlow } from './new-file-wiring';
import { performSugarSave } from './save-handler';
import { buildSugarQuickFixes } from './kojo-quickfix';
import { createVerdictPanel } from './verdict-panel';

/* ------------------------------ 诊断窗口 ------------------------------ */

/**
 * 「显示更多」哨兵（诊断列表触底器）。
 *
 * W4 起观察器行为、title/文案/样式全部住在契约层 `sugar-panels`
 * （`attachGrowSentinel` / `moreRowLabel` / `MORE_ROW_STYLE`——本面板曾自带
 * 第二份拷贝，现与预览面板同壳同核）；这里只余"把核装进 React"的最小胶水，
 * 无任何分支。观察器不可用（SSR / 测试 / 旧环境）时核返回空退订 ⇒ 退化为
 * 纯点击按钮，功能不丢。className 保持 `sv-more-btn`（视觉口径不漂）。
 */
function MoreRow({ remaining, onMore }: { remaining: number; onMore: () => void }): ReactElement {
  const anchor = useRef<unknown>(null);
  /** 最新回调引用（observer 只挂一次，不做重复挂卸） */
  const onMoreRef = useRef(onMore);
  onMoreRef.current = onMore;
  useEffect(() => attachGrowSentinel(anchor.current, () => onMoreRef.current()), []);
  return createElement(
    'button',
    {
      ref: (node: unknown): void => {
        anchor.current = node;
      },
      className: 'ghost small dim sv-more-btn',
      style: MORE_ROW_STYLE,
      title: MORE_ROW_TITLE,
      onClick: () => onMore(),
    },
    moreRowLabel(remaining),
  );
}

/** 诊断列表（窗口化渲染；模块级组件 ⇒ 可独立 SSR 单测 DOM 行数上界） */
export interface VerdictDiagListProps {
  readonly rows: readonly VerdictRow[];
  /** 当前渲染窗口行数（undefined = 初始窗口） */
  readonly limit: number | undefined;
  /** 触底 / 点击「显示更多」→ 追加一窗（新值由 growWindow(prev, total, DIAG_WINDOW) 计算） */
  readonly onGrow: (total: number) => void;
  /** 点击诊断行 = 定位源行意图（宿主消费） */
  readonly onReveal: (line: number) => void;
  /** C1 反向下行：光标所在源行（null = 无位点/派生视图，不高亮） */
  readonly cursorLine?: number | null;
  /** 高亮行节点回执（面板侧 scrollIntoView 跟随用；缺省 = 不跟随） */
  readonly cursorRef?: { current: FollowNode | null };
  /** 右键诊断行（1023 批，可选）：跳到源行 · 复制诊断 */
  readonly onMenu?: (row: VerdictRow, event: PluginContextMenuAnchor) => void;
}

export function VerdictDiagList(props: VerdictDiagListProps): ReactElement {
  const { rows } = props;
  const win = diagWindowSize(rows.length, props.limit);
  return createElement(
    'div',
    { className: 'sv-list' },
    ...rows.slice(0, win).map((r) => {
      // ZH-D2：芯片第一眼给**中文短名**，原码逐字留在芯片自身的悬停 title
      // （报障要能贴码）。真源 = 契约层 `plugin-api/diagnostic-copy.ts`，
      // 本面板**不自带映射**——两处各抄一份迟早分叉。
      const disp = diagnosticDisplay(r.code);
      // C1 反向下行：光标所在源行的诊断高亮（文件级诊断 r.line = null 不参与比对）
      const isCur = props.cursorLine != null && r.line === props.cursorLine;
      return createElement(
        'div',
        {
          key: r.key,
          className: `sv-row ${r.severity}${isCur ? ' cur' : ''}`,
          ref: isCur ? props.cursorRef : undefined,
          onClick: r.line !== null ? () => props.onReveal(r.line as number) : undefined,
          title: r.line !== null ? '点击定位到源行' : '文件级诊断',
          ...(props.onMenu === undefined
            ? {}
            : { onContextMenu: (event: PluginContextMenuAnchor) => props.onMenu?.(r, event) }),
        },
        createElement('span', { className: 'sv-sev' }, sevLabel(r.severity)),
        createElement('span', { className: 'sv-loc dim' }, r.line === null ? '—' : `L${r.line}:${r.column ?? 1}`),
        createElement('span', { className: 'sv-code dim', title: disp.title }, disp.name),
        createElement('span', { className: 'sv-msg' }, r.message),
      );
    }),
    rows.length > win
      ? createElement(MoreRow, {
          key: 'more',
          remaining: rows.length - win,
          onMore: () => props.onGrow(rows.length),
        })
      : null,
  );
}

/** 高亮行的最小节点形状（插件 tsconfig 无 DOM lib ⇒ 自备；scrollIntoView 跟随用） */
export type FollowNode = { scrollIntoView?(arg: { block: string }): void };

export function createUiSugarEditorPlugin(): Plugin {
  return {
    id: 'ui-sugar-editor',
    version: '0.3.0',
    // 硬依赖：装饰与判定的语义都是"呈现 sugar.transpile 的结果"；缺席则本插件无意义
    // （workspaces 自 2026-10-13 反馈 3 起是新建向导的落点来源——内核常驻服务，恒在）
    requires: [
      WellKnownServices.SugarTranspile,
      KernelServices.IO,
      KernelServices.Project,
      KernelServices.Slots,
      KernelServices.Workspaces,
    ],
    activate(ctx) {
      const sugar = ctx.inject<SugarTranspileService>(WellKnownServices.SugarTranspile);
      const io = ctx.inject<FileIO>(KernelServices.IO);
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      const slots = ctx.inject<SlotRegistry>(KernelServices.Slots);
      const workspaces = ctx.inject<WorkspaceService>(KernelServices.Workspaces);
      // 批操作 journal（2026-10-16 undo 批，additive 可选）：`.kojo` 保存的两文件批
      // 进操作历史；缺席 = save-handler 自有快照兜底，行为仍是"半批回滚"
      const journal = ctx.tryInject<OpJournal>(KernelServices.Ops);

      /* -------------------- 贡献 1：编辑器波浪线（纯函数） -------------------- */

      // 翻译核与任务 kind 已迁出到 `decorations.ts`（quickfix 自证吃的还是这同一份）；
      // 本文件只剩注册。
      const kojoDecorations = createSugarDecorations(sugar);

      ctx.slots.register('ui.editor.decorator', {
        id: 'sugar-diagnostics',
        title: '.kojo 诊断波浪线',
        order: 10,
        offloadKind: SUGAR_DECORATIONS_TASK,
        decorate(file): LineDecoration[] {
          return kojoDecorations(file.path, file.text);
        },
      });

      /* -------------------- 贡献 1b：波浪线的快速修复（W3） -------------------- */

      /**
       * `Ctrl+.` 与「全部修复」此前在 `.kojo` 上**恒为 0 个可修项**：当时唯一的 codeAction
       * 供方 `ui-sugar-lift` 给的是 `kind:'refactor'`（改写法不是消诊断），而宿主
       * `kojo-fix-all.ts` 把 refactor 排除在"唯一解"判据外。本贡献补 `kind:'quickfix'`
       * 那一格（LIFT-2 后它已是 `.kojo` 唯一的供方），并把**宿主递进来的那条
       * LineDecoration 原样**填进 `diagnostics`（B9）。
       *
       * 收敛的码是闭集、且每条动作都经过"代回转译器再跑一遍波浪线"的自证——判据与理由
       * 全在 `kojo-quickfix.ts` 头注。这里只接线：**零写盘**（产物是 `EditorTextEdit`，
       * 落盘仍由作者 Ctrl+S 走贡献 2 的保存链路）。
       */
      ctx.slots.register('ui.editor.codeAction', {
        id: 'sugar-quickfix',
        order: 20,
        provideActions: ({ path, text, diagnostics }) => {
          // 两道闸都在接线层，判据本体不认识它们：
          // ① 只对 `.kojo` 供（本插件的波浪线只作用于糖源）；
          // ② **只给能写的文件**改写动作（`kernel.io.isWritable`，与保存按钮同源口径）——
          //    与 `erb-structure-fix`、`convention-linter` 同一条保守纪律：Monaco 的
          //    `executeEdits` 不看写权限，不挡就会给一份"改脏了却存不下去"的只读缓冲。
          //    作者工作区是**常驻可写根**（铁律 5），故正常写作路径不受本闸影响；
          //    会话内解锁（轴二）那一份插件看不见 ⇒ 依旧不给（刻意保守，与那两家同判）。
          if (!isKojoFile(path) || !io.isWritable(path)) return [];
          return buildSugarQuickFixes({
            text,
            // 宿主没给波浪线（旧宿主 / 该区间本来没红线）就一条不产：不凭空造 quickfix
            diagnostics: diagnostics ?? [],
            decorate: (source) => kojoDecorations(path, source),
            // ZH-F2 登记动作的落点判据：块边界一律问 `sugar.parse`（真解析器），本插件不自己认行。
            // 抛错（结构严重损坏的文档）⇒ 空表：没有可靠落点就不给动作（与 decorate 的兜底同口径）。
            topLevelOf: (source) => {
              try {
                return sugar.parse(source, { filePath: path }).topLevel;
              } catch {
                return [];
              }
            },
            onDegrade: (reason) => ctx.log.warn(`sugar-quickfix（${path}）：${reason}`),
          });
        },
      });

      /* -------------------- 贡献 2：保存接管（转译 + 编译落盘） -------------------- */

      // Ctrl+S（`.kojo`）由宿主就近征询本接管者：保存源文件 + 编译产物 `.ERB`
      //（逻辑在 save-handler.ts，纯编排；转译/编译与落盘闸门全在既有链路）。
      ctx.slots.register('ui.editor.saveHandler', {
        id: 'sugar-save',
        title: '.kojo 保存（转译 + 编译落盘）',
        order: 10,
        matches: (path) => isKojoFile(path),
        save: (request) => performSugarSave({ sugar, io, journal: journal ?? undefined }, request),
      });

      /* -------------------- 贡献 3：糖判定面板 -------------------- */

      // 面板组件（状态、取真相、判定分档与渲染）已迁出到 `verdict-panel.ts`；本文件只留
      // 注册与诊断列表——诊断列表受 app 侧 diagnostic-copy 静态守卫钉在本文件，故由这里递进去。
      const VerdictPanel = createVerdictPanel({ ctx, sugar, io, diagList: VerdictDiagList });

      ctx.slots.register('ui.panel', {
        id: 'sugar-verdict',
        title: '.kojo1 校验',
        icon: 'target',
        order: 76,
        // UI 重设计批 P1：诊断性质 → 底部区 tab（定稿 §四）
        location: 'bottom',
        defaultActive: false,
        component: VerdictPanel,
      });

      /* -------------- 贡献 4：新建口上文件命令（P2；定稿 §6.1） -------------- */

      // 动作真源在命令；工具栏只引用 id（定稿 §三宿主编排规则）。
      // when：有打开项目才可用（无项目时向导也无落点）。
      ctx.slots.register('editor.command', {
        id: WellKnownCommands.NewKojoFile,
        title: '新建口上文件',
        category: '文件',
        keybinding: 'ctrl+n',
        when: (c) => c.project !== null,
        run: () => {
          ctx.bus.emit('ui.overlay.open', { id: NEW_KOJO_OVERLAY_ID, source: 'ui-sugar-editor' });
        },
      });

      // 「浮动 .kojo 校验面板」（R8 命令面板补齐批，additive）：糖判定是编辑 .kojo 时的
      // 高频面，命令面板给它一个入口——发既有 `ui.panel.float` 意图、宿主落地为浮窗
      // （非模态，与 overlay 同款模式）。判定知识全在 VerdictPanel，命令只负责"叫它出来"。
      ctx.slots.register('editor.command', {
        id: 'kojo.sugarVerdict.float',
        title: '浮动 .kojo1 校验面板',
        category: '文件',
        run: () => {
          ctx.bus.emit('ui.panel.float', { id: 'sugar-verdict', source: 'ui-sugar-editor' });
        },
      });

      ctx.slots.register('ui.toolbar', {
        id: 'sugar-new-kojo-btn',
        title: '新建口上文件',
        icon: 'add',
        order: 10,
        command: WellKnownCommands.NewKojoFile,
        when: (c) => c.project !== null,
      });

      /* -------------- 贡献 5：新建向导 overlay（P2；反馈 3 改落点） -------------- */

      // 向导知识来源：角色经 kernel.project，命名/分野经 game.adapter 槽的分野
      // 模板表（fail-closed：模板缺省则向导显式不可用，不猜命名）。
      // 落盘编排（工作区落点 / 另存 / 交给新建项目向导）住在 `new-file-flow.ts`。
      // 总线接线（reveal 意图 / 跨插件请人开门 / 建完项目兑现 + 卸载退净）住在
      // `new-file-wiring.ts`；本文件只留三张注册表。
      const { flow, revealPath } = wireNewKojoFileFlow({ ctx, io, workspaces });

      ctx.slots.register('ui.overlay', {
        id: NEW_KOJO_OVERLAY_ID,
        order: 10,
        component: createNewKojoWizard({
          project,
          slots,
          flow,
          close: () => ctx.bus.emit('ui.overlay.close', { id: NEW_KOJO_OVERLAY_ID, source: 'ui-sugar-editor' }),
          reveal: revealPath,
        }),
      });
    },
  };
}

function sevLabel(s: SugarDiagnostic['severity']): string {
  if (s === 'error') return '错误';
  if (s === 'warning') return '警告';
  return '提示';
}
