/**
 * @kojo/plugin-ui-sugar-editor
 *
 * 语法糖**编辑体验**（v0.3 批 S6 + 2026-10-12 保存接线批）：三处贡献，都只做
 * **呈现/翻译/编排**，语义全在 `kojo-sugar` 的 `sugar.transpile`（纯函数）——
 *
 *   1. `ui.editor.decorator`（id `sugar-diagnostics`）：对当前 `.kojo` 源转译，
 *      把诊断翻成**行级装饰**（带列区间）→ 宿主（app 壳）消费为 Monaco markers，
 *      即规范 §8「危险波浪线」；
 *   2. `ui.editor.saveHandler`（id `sugar-save`，2026-10-12 批）：接管 `.kojo`
 *      保存——保存源文件 + 经 `planSave`/`compileToFile` 编译产物（逻辑见
 *      `save-handler.ts`）；宿主零 `.kojo` 知识，缺失时退化为缺省保存；
 *   3. `ui.panel`（id `sugar-verdict`，标题「糖判定」）：当前 `.kojo` 文件的
 *      **编译判定**——可编译 / 有警告 / 不可编译 + 逐条诊断（点击 → 定位源行）。
 *
 * 分层与解耦（对应 ARCHITECTURE.md §4 与 DSH 哲学）：
 *   - 装饰与判定都是**纯函数**（不读盘不写盘不发事件）——`decorate()` 拿到的
 *     就是宿主给的 `{path, text}`，转译器无 IO；面板的读盘走内核 io（只读）；
 *   - 判定/装饰归类在 `panel-logic.ts`（零 React，可单测）；
 *   - 当前文件来自宿主事件 `editor.activeFileChanged`（不持有宿主引用）；
 *   - 跳转复用宿主既有通道 `editor.revealLocation`；
 *   - 零游戏知识：本插件不认得任何游戏术语，变量字典/分野模板全在 adapter。
 */

import { createElement, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  FileIO,
  Plugin,
  ProjectService,
  SlotRegistry,
  SugarDiagnostic,
  SugarTranspileService,
  WorkspaceService,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownCommands, WellKnownServices } from '@kojo/plugin-api';
import {
  buildVerdictRows,
  degradeText,
  diagnosticDecorations,
  isKojoFile,
  summarize,
  type VerdictDegrade,
  type VerdictRow,
  type VerdictSummary,
} from './panel-logic';
import { NEW_KOJO_OVERLAY_ID, createNewKojoWizard } from './new-file-wizard';
import { createNewFileFlow } from './new-file-flow';
import { performSugarSave } from './save-handler';

/** 诊断渲染上限（防 DOM 爆炸；超出显式计数） */
const DIAG_CAP = 200;

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

      /* -------------------- 贡献 1：编辑器波浪线（纯函数） -------------------- */

      ctx.slots.register('ui.editor.decorator', {
        id: 'sugar-diagnostics',
        title: '语法糖诊断波浪线',
        order: 10,
        decorate(file): ReturnType<typeof diagnosticDecorations> {
          if (!isKojoFile(file.path)) return [];
          try {
            const r = sugar.transpile(file.text, { filePath: file.path });
            return diagnosticDecorations(r.diagnostics);
          } catch {
            // 转译器自身异常：绝不在编辑器里炸（宿主本就会隔离装饰器异常，这里
            // 显式兜底，让"这一文件无波浪线"而非"整个装饰链断掉"）。
            return [];
          }
        },
      });

      /* -------------------- 贡献 2：保存接管（转译 + 编译落盘） -------------------- */

      // Ctrl+S（`.kojo`）由宿主就近征询本接管者：保存源文件 + 编译产物 `.ERB`
      //（逻辑在 save-handler.ts，纯编排；转译/编译与落盘闸门全在既有链路）。
      ctx.slots.register('ui.editor.saveHandler', {
        id: 'sugar-save',
        title: '语法糖保存（转译 + 编译落盘）',
        order: 10,
        matches: (path) => isKojoFile(path),
        save: (request) => performSugarSave({ sugar, io }, request),
      });

      /* -------------------- 贡献 3：糖判定面板 -------------------- */
      function VerdictPanel(): unknown {
        const [filePath, setFilePath] = useState<string | null>(null);
        const [degrade, setDegrade] = useState<VerdictDegrade>('no-project');
        const [summary, setSummary] = useState<VerdictSummary | null>(null);
        const [rows, setRows] = useState<readonly VerdictRow[]>([]);
        const [error, setError] = useState<string | null>(null);
        const [nonce, setNonce] = useState(0);

        // 当前文件（宿主广播）——换文件即重置
        useEffect(() => {
          const un = ctx.bus.on('editor.activeFileChanged', (p) => {
            setFilePath(p.filePath);
            setSummary(null);
            setRows([]);
            setError(null);
            setNonce(0);
            setDegrade(p.filePath ? (isKojoFile(p.filePath) ? 'reading' : 'not-kojo') : 'no-project');
          });
          return un;
        }, []);

        // 读文件（只读）→ 转译 → 判定；换文件 / 手动刷新都走这里
        useEffect(() => {
          const path = filePath;
          if (!path || !isKojoFile(path)) return;
          let cancelled = false;
          setDegrade('reading');
          setError(null);
          void io
            .readText(path)
            .then((tf) => {
              if (cancelled) return;
              const r = sugar.transpile(tf.text, { filePath: path });
              const mapped = r.sourceMap.filter((e) => e.sourceLine !== null).length;
              setSummary(summarize(tf.text, r.erb, mapped, r.diagnostics));
              setRows(buildVerdictRows(r.diagnostics));
            })
            .catch((err: unknown) => {
              if (cancelled) return;
              setError(err instanceof Error ? err.message : String(err));
              setDegrade('read-error');
            });
          return () => {
            cancelled = true;
          };
        }, [filePath, nonce]);

        /** 点击定位：请求宿主打开并滚动到该行 */
        const reveal = (line: number): void => {
          if (!filePath) return;
          ctx.bus.emit('editor.revealLocation', { filePath, line });
        };

        const shell = (children: ReactNode[]): ReactNode =>
          createElement(
            'div',
            { className: 'panel-sugar-verdict' },
            createElement(
              'div',
              { className: 'sv-toolbar' },
              createElement('span', { className: 'dim' }, '糖判定（转译诊断；只读）'),
              createElement(
                'button',
                { className: 'ghost small', onClick: () => setNonce((n) => n + 1), disabled: !isKojoFile(filePath) },
                '刷新',
              ),
            ),
            ...children,
          );

        if (!isKojoFile(filePath)) {
          return shell([createElement('div', { className: 'sv-empty dim' }, degradeText(degrade))]);
        }
        if (degrade === 'reading') {
          return shell([createElement('div', { className: 'sv-empty dim' }, degradeText(degrade))]);
        }
        if (error) {
          return shell([
            createElement('div', { className: 'sv-error' }, `${degradeText(degrade)}：${error}`),
            createElement(
              'div',
              { className: 'sv-actions' },
              createElement('button', { className: 'ghost small', onClick: () => setNonce((n) => n + 1) }, '重试'),
            ),
          ]);
        }
        if (!summary) {
          return shell([createElement('div', { className: 'sv-empty dim' }, degradeText('reading'))]);
        }

        const statusBox = createElement(
          'div',
          { className: `sv-verdict ${summary.status}` },
          createElement('span', { className: 'sv-verdict-badge' }, summary.label),
          createElement('span', { className: 'sv-counts' },
            createElement('span', { className: 'sv-count err' }, `错误 ${summary.counts.error}`),
            createElement('span', { className: 'sv-count warn' }, `警告 ${summary.counts.warning}`),
            createElement('span', { className: 'sv-count info' }, `提示 ${summary.counts.info}`),
          ),
        );

        const meta = createElement(
          'div',
          { className: 'sv-meta dim' },
          `源行 ${summary.sourceLines} · 产物行 ${summary.generatedLines} · 已映射 ${summary.mappedLines} 行`,
        );

        const list =
          rows.length === 0
            ? createElement('div', { className: 'sv-empty dim' }, '无诊断 ✅')
            : createElement(
                'div',
                { className: 'sv-list' },
                ...rows.slice(0, DIAG_CAP).map((r) =>
                  createElement(
                    'div',
                    {
                      key: r.key,
                      className: `sv-row ${r.severity}`,
                      onClick: r.line !== null ? () => reveal(r.line as number) : undefined,
                      title: r.line !== null ? '点击定位到源行' : '文件级诊断',
                    },
                    createElement('span', { className: 'sv-sev' }, sevLabel(r.severity)),
                    createElement('span', { className: 'sv-loc dim' }, r.line === null ? '—' : `L${r.line}:${r.column ?? 1}`),
                    createElement('span', { className: 'sv-code dim' }, r.code),
                    createElement('span', { className: 'sv-msg' }, r.message),
                  ),
                ),
                rows.length > DIAG_CAP
                  ? createElement('div', { className: 'dim sv-hint' }, `其余 ${rows.length - DIAG_CAP} 条未显示`)
                  : null,
              );

        return shell([statusBox, meta, list]);
      }

      ctx.slots.register('ui.panel', {
        id: 'sugar-verdict',
        title: '糖判定',
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
      const revealPath = (path: string): void =>
        ctx.bus.emit('editor.revealLocation', { filePath: path, source: 'ui-sugar-editor' });

      const flow = createNewFileFlow({
        io,
        workspaces,
        log: ctx.log,
        reveal: revealPath,
        // 跨插件请人开门：发语义意图（不是对方的 overlay id——那个字符串一进契约层
        // 就把游戏词写进了 plugin-api），关联号随意图走
        openProjectWizard: (token) =>
          ctx.bus.emit('workspace.newProjectRequested', {
            requestToken: token,
            source: 'ui-sugar-editor',
          }),
        reopenWizard: () =>
          ctx.bus.emit('ui.overlay.open', { id: NEW_KOJO_OVERLAY_ID, source: 'ui-sugar-editor' }),
      });
      ctx.onDispose(() => flow.dispose());

      // 新建项目向导建完项目 → 兑现那份被"跳去建项目"打断的口上文件（反馈 3 a1）
      ctx.onDispose(
        ctx.bus.on('workspace.projectCreated', (ev) => {
          void flow.onProjectCreated(ev.projectId, ev.requestToken);
        }),
      );

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