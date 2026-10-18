import { useEffect } from 'react';
import type { Kernel } from '@kojo/kernel';
import type { ErbParserService, OpJournal } from '@kojo/plugin-api';
import { KernelServices } from '@kojo/plugin-api';
import { bindDiffView, DIFF_VIEW_OVERLAY_ID } from './diff-view';
import { createDiffViewOverlay } from './DiffViewOverlay';
// P2-14：quick fix 预览 overlay（确认才落的那扇窗）——照 diff view 那格的注法追加。
// **不静态 import `editor-global-providers`**：那个模块静态挂着整个 monaco provider
// 世界（PS-10 开机图闸的真判据），预览确认是低频路径——apply / activePaneId 都走
// 点击那一刻的动态 import（overlay 的 deps 本就收 Promise）。
import { QUICK_FIX_PREVIEW_OVERLAY_ID } from './quick-fix-preview';
import { createQuickFixPreviewOverlay } from './QuickFixPreviewOverlay';
import {
  FILE_HISTORY_OVERLAY_ID,
  setFileHistoryTarget,
  SHOW_FILE_HISTORY_COMMAND_ID,
} from './file-history';
import { createFileHistoryOverlay } from './FileHistoryOverlay';
import { OPS_HISTORY_OVERLAY_ID, SHOW_OPS_HISTORY_COMMAND_ID } from './ops-history';
import { createOpsHistoryOverlay } from './OpsHistoryOverlay';
import {
  CALL_HIERARCHY_COMMAND_ID,
  CALL_HIERARCHY_OVERLAY_ID,
  setCallHierarchyState,
} from './call-hierarchy';
import { createCallHierarchyOverlay } from './CallHierarchyOverlay';
import { readJumpProbe } from './jump-to-state';

/**
 * 覆盖层 + 命令槽位的主机接线（2026-10-15 比对/历史批、批 E 调用层级、2026-10-16 undo 批）。
 *
 * 从 App 抽出的独立一块：整段只吃 `kernel`（依赖数组就 `[kernel]` 一个）、只调模块级工厂，
 * 不碰任何 App React state——所以能在组件体的同一位置无条件调用，React 钩子次序不变。
 */
export function useShellOverlays(kernel: Kernel | null): void {
  // 通用 diff 视图（2026-10-15 比对/历史批）：宿主注册 ui.overlay 贡献并订阅
  // `ui.diffView.open` 意图（插件发意图、宿主落地；与 editor.revealLocation 同款）。
  // 本地时间线（同批）：命令进（活动文件在 ctx 里）→ 状态单源 → ui.overlay 开窗；
  // 「对比」发同一枚 diff 意图（F1 视图复用），「恢复」只经 kernel.io 既有写链路。
  useEffect(() => {
    if (!kernel) return;
    const unBind = bindDiffView(kernel);
    const unReg = kernel.slots.register('ui.overlay', {
      id: DIFF_VIEW_OVERLAY_ID,
      order: 40,
      size: 'wide',
      component: createDiffViewOverlay({
        io: kernel.io,
        close: () =>
          kernel.bus.emit('ui.overlay.close', { id: DIFF_VIEW_OVERLAY_ID, source: 'host:diff-view' }),
      }),
    });
    const unRegHistory = kernel.slots.register('ui.overlay', {
      id: FILE_HISTORY_OVERLAY_ID,
      order: 41,
      size: 'wide',
      component: createFileHistoryOverlay({
        io: kernel.io,
        requestDiff: (p) => kernel.bus.emit('ui.diffView.open', { ...p, source: 'host:file-history' }),
        close: () =>
          kernel.bus.emit('ui.overlay.close', { id: FILE_HISTORY_OVERLAY_ID, source: 'host:file-history' }),
      }),
    });
    const unRegHistoryCommand = kernel.slots.register('editor.command', {
      id: SHOW_FILE_HISTORY_COMMAND_ID,
      title: '显示当前文件的历史版本',
      when: (ctx) => Boolean(ctx.activeFile),
      run: (ctx) => {
        if (!ctx.activeFile) return;
        setFileHistoryTarget(ctx.activeFile);
        kernel.bus.emit('ui.overlay.open', {
          id: FILE_HISTORY_OVERLAY_ID,
          source: 'host:file-history',
        });
      },
    });
    // 调用层级（批 E，2026-10-16）：宿主自建只读查询面板（Monaco standalone 无
    // CallHierarchy API，取证见 PITFALLS §83）。判定与收集全在
    // `monaco/erb-call-hierarchy.ts`（复用 erb.parser 反向索引与 functionAt 通道），
    // 这里只做两件接线：命令面板入口 + overlay 注册。位点现取 `readJumpProbe()`
    // （G1 既有探针——`EditorCommandContext` 没有光标行，不为此扩宿主管道）；
    // 跳转落既有 `editor.revealLocation`，与转到定义同一条通道。
    const parser = (): ErbParserService | undefined => kernel.services.tryGet<ErbParserService>('erb.parser');
    const unRegCallHierarchy = kernel.slots.register('ui.overlay', {
      id: CALL_HIERARCHY_OVERLAY_ID,
      order: 42,
      component: createCallHierarchyOverlay({
        currentIndex: () => {
          try {
            return parser()?.currentIndex() ?? null;
          } catch {
            return null;
          }
        },
        functionAt: (path, line) => {
          try {
            const service = parser();
            // 三态：通道不存在（服务/方法缺席）⇒ null（数据层退化到索引自扫）；
            // 在场则它的 undefined 是权威的"不在此函数内"
            return service?.functionAt ? service.functionAt(path, line) : null;
          } catch {
            return null;
          }
        },
        reveal: (path, line, column) =>
          kernel.bus.emit('editor.revealLocation', {
            filePath: path,
            line,
            ...(column !== undefined ? { column } : {}),
            source: '调用层级',
          }),
        close: () =>
          kernel.bus.emit('ui.overlay.close', { id: CALL_HIERARCHY_OVERLAY_ID, source: 'host:call-hierarchy' }),
      }),
    });
    const unRegCallHierarchyCommand = kernel.slots.register('editor.command', {
      id: CALL_HIERARCHY_COMMAND_ID,
      title: '查看当前函数的调用层级（谁调用它 / 它调用谁）',
      when: (ctx) => Boolean(ctx.activeFile),
      run: () => {
        const probe = readJumpProbe();
        if (!probe) {
          setCallHierarchyState({
            kind: 'rejected',
            reason: '编辑器还没准备好——先打开一份文件，把光标放到函数体里，再运行本命令。',
          });
        } else if (probe.derivedView) {
          setCallHierarchyState({
            kind: 'rejected',
            reason: '现在屏幕上的是派生视图（行号不属于原文）——切回原代码再查看调用层级。',
          });
        } else {
          setCallHierarchyState({ kind: 'request', request: { filePath: probe.path, line: probe.line } });
        }
        kernel.bus.emit('ui.overlay.open', { id: CALL_HIERARCHY_OVERLAY_ID, source: 'host:call-hierarchy' });
      },
    });
    // 操作历史（2026-10-16 undo 批）：磁盘侧批操作的撤销面。服务键 additive
    // （kernel.ops 缺席 = 不注册，命令面板里也不出现——降级零痕迹）。
    const opsService = kernel.services.tryGet<OpJournal>(KernelServices.Ops);
    const unRegOps = opsService
      ? kernel.slots.register('ui.overlay', {
          id: OPS_HISTORY_OVERLAY_ID,
          order: 43,
          size: 'wide',
          component: createOpsHistoryOverlay({
            ops: opsService,
            close: () =>
              kernel.bus.emit('ui.overlay.close', { id: OPS_HISTORY_OVERLAY_ID, source: 'host:ops-history' }),
          }),
        })
      : undefined;
    const unRegOpsCommand = opsService
      ? kernel.slots.register('editor.command', {
          id: SHOW_OPS_HISTORY_COMMAND_ID,
          title: '操作历史（脚手架/保存/注入的批回滚）',
          run: () => {
            kernel.bus.emit('ui.overlay.open', {
              id: OPS_HISTORY_OVERLAY_ID,
              source: 'host:ops-history',
            });
          },
        })
      : undefined;
    // 快速修复预览（P2-14）：💡 的改文本动作先出 diff 预览、确认才落。依赖注入与
    // diff view 那格同款：apply 落地走 editor-global-providers 的既有 applyTextEdits，
    // activePaneId 反查触发修复的实例，close 走既有 ui.overlay.close 通道。
    const unRegQuickFixPreview = kernel.slots.register('ui.overlay', {
      id: QUICK_FIX_PREVIEW_OVERLAY_ID,
      order: 44,
      size: 'wide',
      component: createQuickFixPreviewOverlay({
        apply: (actionId) => import('./editor-global-providers').then((m) => m.applyQuickFixEdits(actionId)),
        activePaneId: () => import('./editor-global-providers').then((m) => m.focusedPaneIdOf()),
        close: () =>
          kernel.bus.emit('ui.overlay.close', { id: QUICK_FIX_PREVIEW_OVERLAY_ID, source: 'host:quick-fix-preview' }),
      }),
    });
    return () => {
      unBind();
      unReg();
      unRegHistory();
      unRegHistoryCommand();
      unRegOps?.();
      unRegOpsCommand?.();
      unRegCallHierarchy();
      unRegCallHierarchyCommand();
      unRegQuickFixPreview();
    };
  }, [kernel]);
}
