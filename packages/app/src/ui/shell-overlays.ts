import { useEffect } from 'react';
import type { Kernel } from '@kojo/kernel';
import type { ErbParserService, OpJournal } from '@kojo/plugin-api';
import { KernelServices } from '@kojo/plugin-api';
// P2-14 / PS-10 断链：diff view 一格整体走**动态装载**。这一格经
// `diff-view.ts → monaco/erb-language → theme → monaco/kojo-language →
// @kojo/plugin-kojo-sugar` 静态把糖词表（~900 KB 源码）挂回开机静态图；theme 的规则
// 数组虽已下沉叶子（`monaco/kojo-theme-rules.ts`），但 `diff-view.ts` 仍静态 import
// `kojo-language` 取语言 id——本文件是它唯一的宿主 import 点，改动态后糖包整包离开
// 开机图。**装载时机**：模块作用域就发起 import（本文件随 App 静态进开机图），effect
// 跑时 chunk 早已到位，注册落在同一 tick 的微任务里；比对意图只由文件历史 overlay 的
// 「对比」按钮发（人类点击节奏），不存在"意图早于绑定"的实测窗口。
const diffViewChunk: Promise<
  [typeof import('./diff-view'), typeof import('./DiffViewOverlay')]
> = Promise.all([import('./diff-view'), import('./DiffViewOverlay')]);
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
import { openModelAcrossGroups } from './editor-pane-registry';
import { readJumpProbe } from './jump-to-state';

/**
 * 覆盖层 + 命令槽位的主机接线（2026-10-15 比对/历史批、批 E 调用层级、2026-10-16 undo 批）。
 *
 * 从 App 抽出的独立一块：整段只吃 `kernel`（依赖数组就 `[kernel]` 一个）、只调模块级工厂，
 * 不碰任何 App React state——所以能在组件体的同一位置无条件调用，React 钩子次序不变。
 */
export function useShellOverlays(kernel: Kernel | null): void {
  useEffect(() => {
    if (!kernel) return;
    // 通用 diff 视图（2026-10-15 比对/历史批）：宿主注册 ui.overlay 贡献并订阅
    // `ui.diffView.open` 意图（插件发意图、宿主落地；与 editor.revealLocation 同款）。
    // 本地时间线（同批）：命令进（活动文件在 ctx 里）→ 状态单源 → ui.overlay 开窗；
    // 「对比」发同一枚 diff 意图（F1 视图复用），「恢复」只经 kernel.io 既有写链路。
    // 装载走 `diffViewChunk`（模块作用域已发起）：`disposed` 闩住"卸载早于装载到位"的
    // 竞态；槽位按 `order` 排序（kernel `slots.ts`），晚到不改 overlay 的相对次序。
    let disposed = false;
    const diffViewCleanups: Array<() => void> = [];
    void diffViewChunk.then(([diffView, diffViewOverlay]) => {
      if (disposed) return;
      const unBind = diffView.bindDiffView(kernel);
      const unReg = kernel.slots.register('ui.overlay', {
        id: diffView.DIFF_VIEW_OVERLAY_ID,
        order: 40,
        size: 'wide',
        component: diffViewOverlay.createDiffViewOverlay({
          io: kernel.io,
          close: () =>
            kernel.bus.emit('ui.overlay.close', { id: diffView.DIFF_VIEW_OVERLAY_ID, source: 'host:diff-view' }),
          // 批次十一 L12（关闭意图合流）：比对栈的收尾 `clearDiff()` 挂在 `deps.close()` 里，
          // 而 Esc / 点遮罩两条通道在壳层是直卸载宿主（不经过这颗 close）⇒ 只有按钮那条清栈，
          // 下次开窗读到陈年比对。这里把本 id 的 `ui.overlay.close` 事件回灌给组件；壳层一旦
          // 把那两条通道也改为**发同一枚总线事件**（见批次回执接线单），三条路就走同一条收账。
          onCloseIntent: (handler) =>
            kernel.bus.on('ui.overlay.close', (ev) => {
              if (ev.id === diffView.DIFF_VIEW_OVERLAY_ID) handler();
            }),
        }),
      });
      diffViewCleanups.push(() => {
        unBind();
        unReg();
      });
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
    // 调用层级（批 E，2026-10-16；批次十 2026-10-23 补语言分派）：宿主自建只读查询面板
    // （Monaco standalone 无 CallHierarchy API，取证见 PITFALLS §83）。面板按当前 model
    // 的语言分派取数依赖：`.erb`（及 v1 `.kojo`）走 `monaco/erb-call-hierarchy.ts`（复用
    // erb.parser 反向索引与 functionAt 通道），kojo2 走 `createKojo2CallHierarchyProvider()`。
    // 这里只做两件接线：命令面板入口 + overlay 注册。位点现取 `readJumpProbe()`
    // （G1 既有探针——`EditorCommandContext` 没有光标行，不为此扩宿主管道）；
    // 跳转落既有 `editor.revealLocation`，与转到定义同一条通道。
    // kojo2 的取数模块与**项目索引 resolver** 不在这一格注入：本文件不静态 import
    // `editor-global-providers`（PS-10 开机图闸），那两条腿由面板内部
    // `ui/call-hierarchy.ts` 的 `loadKojo2CallHierarchyPanelBundle()` 懒装载、装好后模块级快照同步取用
    // （批次十一 CALLHIER-INJECT：跨文件入 / 出边由此接上）。
    const parser = (): ErbParserService | undefined => kernel.services.tryGet<ErbParserService>('erb.parser');
    const unRegCallHierarchy = kernel.slots.register('ui.overlay', {
      id: CALL_HIERARCHY_OVERLAY_ID,
      order: 42,
      // 批次十一 L12：面板内层是 `ov-wide`（920）的查询面——`size` 缺席时宿主只有
      // 560 一档，920 的内层塞进 560 的外框 ⇒ 横向裁切 + 双滚动条（当年 `.kd-host`
      // 1180 塞窄宿主是同一颗雷）。补上这一行，档位由 `shell-overlays` 与浮层同源声明。
      size: 'wide',
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
        // ST-CONSUMERS：索引这一轮的可查事实（原样转述，宿主不代判形状；缺席 ⇒ 旧句）
        indexState: () => {
          try {
            return parser()?.indexState?.() ?? null;
          } catch {
            return null;
          }
        },
        // 语言分派（批次十）：给面板一份"请求文件的活动 model"。跨组反查走登记簿
        // （`openModelAcrossGroups` 按宿主键匹配，任一组开着即可）；文件已关 ⇒ null，
        // 面板逐字退回 ERB 分支的原有空态。只读，不碰任何 ref 写路径。
        modelFor: (path) => {
          try {
            return openModelAcrossGroups(path) ?? null;
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
          // 位点带上列（additive）：kojo2 的 prepare 按格子判定，列缺席时面板按行首问
          setCallHierarchyState({
            kind: 'request',
            request: {
              filePath: probe.path,
              line: probe.line,
              ...(probe.column !== undefined ? { column: probe.column } : {}),
            },
          });
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
      // diff view 一格：装载未到位就置闩（到位的 `.then` 会自行跳过注册）；
      // 已到位的跑收集到的 unBind/unReg（与原同步版同一对、同一次序）。
      disposed = true;
      for (const cleanup of diffViewCleanups) cleanup();
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
