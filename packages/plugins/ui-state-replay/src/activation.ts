/**
 * 回放面板**自己的**激活层（从 `index.ts` 的 `activate()` 原样迁出，语义逐字不变）。
 *
 * 三件事住在这里，都不碰 React：
 *   1. **协议查询** `currentProtocol()` —— 当前那枚 adapter 由契约的 `activeGameAdapter` 认；
 *   2. **存档清单**（`snapshot.source` 扫描 + 归属守卫 + `project.opened/closed` 订阅）；
 *   3. **待处理回放意图**（`kojo.replayFunction` 订阅在激活层，面板没挂载时先落在
 *      `pending` 里等兑现；带 `locate` 且没人在听时经 `ui.panel.float` 浮起自己）。
 *
 * 状态挂在返回对象的**字段**上（原先是 activate 闭包里的 `let`）：面板组件读写
 * `state.archives` / `state.pending` 与旧的闭包读取完全同构，订阅表 `listeners`
 * 与挂载凭据 `mounted` 仍是同一份 Set 实例。
 */

import type {
  GameAdapter,
  GameProject,
  PluginContext,
  ProjectService,
  SlotRegistry,
  SnapshotSourceService,
} from '@kojo/plugin-api';
import { activeGameAdapter } from '@kojo/plugin-api';
import type { LocateRequest } from './panel-logic';

/** 存档清单项（面板只用到这四个字段，不搬原始 meta） */
export interface ArchiveEntryUi {
  path: string;
  fileName: string;
  saveMes: string;
  charCount: number;
}

export interface ReplayActivation {
  /** 当前适配器的口上调用协议（缺省 → undefined，面板降级为裸文本上下文输入） */
  currentProtocol(): GameAdapter['kojoCallProtocol'];
  /** 存档清单（`refreshArchives` 整表替换；面板渲染时直接读） */
  archives: ArchiveEntryUi[];
  /** 清单是否已就绪（失败也算就绪：空列表 + 显式错误，不静默转圈） */
  archivesReady: boolean;
  /** 待处理的回放意图（面板消费后置 null） */
  pending: { functionName: string; locate?: LocateRequest } | null;
  /** 活着的面板订阅者（面板挂载时 add / 卸载时 delete） */
  listeners: Set<() => void>;
  /** 活着的面板实例（浮动窗与停靠位共用同一组件；空 = 没人在听） */
  mounted: Set<object>;
}

export function createReplayActivation(ctx: PluginContext, deps: {
  project: ProjectService;
  snapshots: SnapshotSourceService;
  slots: SlotRegistry;
  /** 本面板的贡献 id（"浮起自己"那条意图与 `ui.panel` 注册共用一个真源） */
  panelId: string;
}): ReplayActivation {
  const { project, snapshots, slots, panelId } = deps;

  /** 当前适配器的口上调用协议（当前那枚由契约的 `activeGameAdapter` 认） */
  const currentProtocol = (): GameAdapter['kojoCallProtocol'] =>
    activeGameAdapter(slots.query('game.adapter'), project.current()?.adapterId)?.kojoCallProtocol;

  // ---- React 外部源（面板组件订阅） ----
  const state: ReplayActivation = {
    currentProtocol,
    archives: [],
    archivesReady: false,
    pending: null,
    listeners: new Set<() => void>(),
    mounted: new Set<object>(),
  };
  const notify = (): void => {
    for (const cb of [...state.listeners]) {
      try {
        cb();
      } catch (err) {
        ctx.log.warn(`Replay panel listener threw: ${String(err)}`);
      }
    }
  };

  const refreshArchives = (): void => {
    const current: GameProject | null = project.current();
    if (!current) {
      state.archives = [];
      state.archivesReady = false;
      notify();
      return;
    }
    void snapshots
      .scan()
      .then((scan) => {
        // 2026-10-16 归属守卫：扫描在途时可能换项目，旧回包整链丢弃
        if (project.current() !== current) return;
        state.archives = scan.entries
          .filter((e) => !e.error)
          .map((e) => ({
            path: e.path,
            fileName: e.fileName,
            saveMes: e.meta?.saveMes ?? '',
            charCount: e.meta?.charCount ?? 0,
          }));
        state.archivesReady = true;
        notify();
      })
      .catch((err) => {
        if (project.current() !== current) return;
        ctx.log.warn(`Replay panel scan failed: ${String(err)}`);
        state.archivesReady = true; // 失败也是"就绪"（空列表 + 显式错误，不静默转圈）
        notify();
      });
  };

  ctx.onDispose(ctx.bus.on('project.opened', () => refreshArchives()));
  ctx.onDispose(ctx.bus.on('project.closed', () => refreshArchives()));
  if (project.current()) refreshArchives();

  /* ---------------- 待处理回放意图（G1，2026-10-16） ----------------
   *
   * 意图订阅从组件里**提到插件激活层**。本面板是 `location:'aux'` +
   * `defaultActive:false`，作者按跳转键时它多半根本没挂载——旧写法（组件内
   * `bus.on`）在那种情况下**一个监听者都没有**，事件发进空气里：这正是铁律 4
   * 说的最坏失败模式（按了没反应），而且它此前也悄悄影响着导航面板那颗 ⟲。
   * 提到这一层后：意图先落在闭包里，面板挂载（或被浮起）后自己取用。
   *
   * 带 `locate` 的请求（编辑器那条键）额外承诺"一定看得见"：面板不在屏上时
   * 由本插件经既有的 `ui.panel.float` 意图把自己浮出来——可见性是本面板的私事，
   * 宿主既不问也不该知道哪只面板挂着什么。**不带 `locate` 的旧发起方行为逐字不变**
   * （不浮窗、不改任何既有面板的默认行为）。
   */
  ctx.onDispose(
    ctx.bus.on('kojo.replayFunction', (ev) => {
      state.pending = { functionName: ev.functionName, ...(ev.locate ? { locate: ev.locate } : {}) };
      if (ev.locate && state.mounted.size === 0) {
        ctx.bus.emit('ui.panel.float', { id: panelId, source: 'ui-state-replay' });
      }
      notify();
    }),
  );

  return state;
}
