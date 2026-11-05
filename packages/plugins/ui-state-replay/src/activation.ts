/**
 * 回放面板**自己的**激活层（从 `index.ts` 的 `activate()` 原样迁出，语义逐字不变）。
 *
 * 三件事住在这里，都不碰 React：
 *   1. **协议查询** `currentProtocol()` —— 当前那枚 adapter 由契约的 `activeGameAdapter` 认；
 *   2. **存档清单**（`snapshot.source` 缓存初值 + 订阅 + 归属守卫；面板可「重新扫描」）；
 *   3. **待处理回放意图**（`kojo.replayFunction` 订阅在激活层，面板没挂载时先落在
 *      `pending` 里等兑现；没人在听时经 `ui.panel.float` 浮起自己，P9）。
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
  SnapshotArchiveEntry,
  SnapshotScanResult,
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
  /** 存档清单（`rescan` / 服务订阅整表替换；面板渲染时直接读） */
  archives: ArchiveEntryUi[];
  /** 清单是否已就绪（失败也算就绪：空列表 + 显式错误，不静默转圈） */
  archivesReady: boolean;
  /** 是否有一轮扫描在途（「重新扫描」按钮的 busy / disabled 判据） */
  scanning: boolean;
  /** 显式扫描错误（失败时清单仍算就绪，但原因必须看得见） */
  archivesError: string | null;
  /** 重新扫描存档目录（面板按钮 / project 事件共用；失败不静默） */
  rescan(): void;
  /** 待处理的回放意图（面板消费后置 null） */
  pending: { functionName: string; locate?: LocateRequest } | null;
  /** 活着的面板订阅者（面板挂载时 add / 卸载时 delete） */
  listeners: Set<() => void>;
  /** 活着的面板实例（浮动窗与停靠位共用同一组件；空 = 没人在听） */
  mounted: Set<object>;
}

/** 扫描条目 → 面板清单项（浅解析失败的条目剔除：它们的 meta 不可用，列出来只会误导） */
function toArchiveEntries(entries: readonly SnapshotArchiveEntry[]): ArchiveEntryUi[] {
  return entries
    .filter((e) => !e.error)
    .map((e) => ({
      path: e.path,
      fileName: e.fileName,
      saveMes: e.meta?.saveMes ?? '',
      charCount: e.meta?.charCount ?? 0,
    }));
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
    scanning: false,
    archivesError: null,
    rescan: () => undefined, // 占位；同一闭包内随后绑定真实实现
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

  /** 采纳一次扫描结果的清单（调用方负责归属守卫与 notify） */
  const adopt = (scan: SnapshotScanResult): void => {
    state.archives = toArchiveEntries(scan.entries);
    state.archivesReady = true;
    state.scanning = false;
    state.archivesError = null;
  };

  /**
   * 重新扫描（P4）：面板「重新扫描」按钮与 project 事件共用这一条路。
   *
   * 失败口径（铁律 4，不静默）：`archivesReady` 置 true（转圈必须停）+ `archivesError`
   * 保留显式原因；清单保持上一次已知值（不假装"项目里没存档"）。
   * 换项目 / 关项目时旧回包按归属守卫整链丢弃（2026-10-16 口径不变）。
   */
  const rescan = (): void => {
    const current: GameProject | null = project.current();
    if (!current) {
      state.archives = [];
      state.archivesReady = false;
      state.scanning = false;
      state.archivesError = null;
      notify();
      return;
    }
    state.scanning = true;
    state.archivesError = null;
    notify();
    void snapshots
      .scan()
      .then((scan) => {
        if (project.current() !== current) return; // 扫描在途时换了项目：旧回包丢弃
        adopt(scan);
        notify();
      })
      .catch((err: unknown) => {
        if (project.current() !== current) return;
        ctx.log.warn(`Replay panel scan failed: ${String(err)}`);
        state.scanning = false;
        state.archivesReady = true; // 失败也是"就绪"（旧列表 + 显式错误，不静默转圈）
        state.archivesError = err instanceof Error ? err.message : String(err);
        notify();
      });
  };
  state.rescan = rescan;

  /**
   * P4（2026-11-05 面板可用性批）：清单初值取服务的 `snapshots.current()`
   * ——缓存命中时首帧就有清单，不必先转一圈；并订阅 `snapshots.subscribe`
   * 跟随服务侧的扫描结果。
   *
   * 修的是什么：此前只订 `project.opened/closed` 自己扫一次，服务侧（注入面板
   * 重扫 / 归档浏览器重扫 / 项目打开自动扫描）更新了清单本面板不知道 ⇒
   * 空态文案让人"去状态注入器重扫"是条死路（那边扫完也不通知这边）。
   *
   * 契约口径：`subscribe` 会**立刻**用当前缓存值回调一次（sav-parser
   * `engine.ts:195-197`）；`project.closed` 时服务 `clear()` 再回调 `null`
   * ⇒ 这里跟着清空。订阅收口在 `ctx.onDispose`。
   *
   * 顺序有讲究：**先订阅再取初值**——subscribe 的立即回调若带着 `null`
   * （服务还没扫过）会把 `scanning` 归零，放在 rescan 之后就会把"正在扫"
   * 抹成"空闲"。
   */
  ctx.onDispose(
    snapshots.subscribe((scan) => {
      if (scan === null) {
        // 项目关闭 / 服务重置：清单清空（面板另有 project.closed 归零，这里只保证数据不残留）
        state.archives = [];
        state.archivesReady = false;
        state.scanning = false;
        state.archivesError = null;
        notify();
        return;
      }
      adopt(scan);
      notify();
    }),
  );

  const cached = snapshots.current();
  if (project.current()) {
    if (cached) {
      adopt(cached);
    } else {
      rescan(); // 服务还没扫过（例如本面板先于项目事件激活）：自己发起一轮
    }
  }

  ctx.onDispose(ctx.bus.on('project.opened', () => rescan()));
  ctx.onDispose(ctx.bus.on('project.closed', () => rescan()));

  /* ---------------- 待处理回放意图（G1，2026-10-16） ----------------
   *
   * 意图订阅从组件里**提到插件激活层**。本面板是 `location:'aux'` +
   * `defaultActive:false`，作者按跳转键时它多半根本没挂载——旧写法（组件内
   * `bus.on`）在那种情况下**一个监听者都没有**，事件发进空气里：这正是铁律 4
   * 说的最坏失败模式（按了没反应），而且它此前也悄悄影响着导航面板那颗 ⟲。
   * 提到这一层后：意图先落在闭包里，面板挂载（或被浮起）后自己取用。
   *
   * P9（2026-11-05）：**只要没人在听就浮窗**，不再要求带 `locate`。
   * 旧口径只对"从编辑器跳到命中状态"那条键浮窗；函数树右键「在回放面板解释」
   * 不带 `locate`，于是"点了没反应"，要等之后某时刻面板被别的路径挂载才突然兑现
   * ——按了必须有反应（铁律 4），意图的来源不该决定它看不看得见。
   */
  ctx.onDispose(
    ctx.bus.on('kojo.replayFunction', (ev) => {
      state.pending = { functionName: ev.functionName, ...(ev.locate ? { locate: ev.locate } : {}) };
      if (state.mounted.size === 0) {
        ctx.bus.emit('ui.panel.float', { id: panelId, source: 'ui-state-replay' });
      }
      notify();
    }),
  );

  return state;
}
