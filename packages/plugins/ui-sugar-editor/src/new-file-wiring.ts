/**
 * 新建口上文件的**总线接线**（从 `index.ts` 的 `activate()` 原样迁出：意图字符串、
 * 注释与挂卸次序逐字不变）。
 *
 * 分工：落盘编排（工作区落点 / 另存 / 交给新建项目向导）住在 `new-file-flow.ts`，
 * 向导组件住在 `new-file-wizard.ts`；本文件只管"把流程挂到宿主总线上、插件卸载时
 * 退净"。`ui.overlay` / `editor.command` / `ui.toolbar` 三张注册表仍留在 `index.ts`。
 */

import type { FileIO, PluginContext, WorkspaceService } from '@kojo/plugin-api';
import { NEW_KOJO_OVERLAY_ID } from './new-file-wizard';
import { createNewFileFlow, type NewFileFlow } from './new-file-flow';

/** 接线产出的两样东西（`index.ts` 的向导注册还要用） */
export interface KojoNewFileWiring {
  readonly flow: NewFileFlow;
  /** 打开并定位：复用宿主既有通道 `editor.revealLocation` */
  readonly revealPath: (path: string) => void;
}

/** 接线依赖（全部由 `index.ts` 的 `activate()` 注入） */
export interface KojoNewFileWiringDeps {
  readonly ctx: PluginContext;
  readonly io: FileIO;
  readonly workspaces: WorkspaceService;
}

export function wireNewKojoFileFlow(deps: KojoNewFileWiringDeps): KojoNewFileWiring {
  const { ctx, io, workspaces } = deps;

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

  return { flow, revealPath };
}
