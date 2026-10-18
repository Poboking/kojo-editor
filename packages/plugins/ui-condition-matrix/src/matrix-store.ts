/**
 * 条件矩阵的**外部状态源**（从 `index.ts` 的 `activate()` 原样迁出，语义逐字不变）。
 *
 * 面板组件只 `subscribe`（`listeners`）+ 读字段，其余时序都住在这里：
 *   - `kojo.functionChanged` / `project.opened` → `refresh()`（等索引就绪再建表）；
 *   - `project.closed` → `rebuild(null)`；
 *   - 条件抽取索引就绪 → 代次 +1（矩阵记忆化随之失效重算）。
 *
 * 两条不静默的承诺（铁律 4）：建索引失败把原因留在 `loadError`（面板显式给「重试」）；
 * `lastBuiltIndex` 的实例去重只省算力，不改变「一次扫描即全量重算」的口径。
 * 状态挂在返回对象的**字段**上（原先是 activate 闭包里的 `let`），面板读法与闭包读取同构。
 */

import type {
  ConditionExtractorService,
  ErbIndex,
  ErbParserService,
  PluginContext,
  ProjectService,
  WorkspaceProject,
  WorkspaceService,
} from '@kojo/plugin-api';
import type { CharacterIndex, MatrixMemo } from './matrix-logic';
import { buildCharacterIndex, createMatrixMemo } from './matrix-logic';
import type { AdapterServices } from './adapter-services';

export interface MatrixStore {
  /** 角色 → 函数聚合（未建 / 项目关闭 = null） */
  characterIndex: CharacterIndex | null;
  /** 索引是否已就绪（含「失败也算就绪」：空清单 + 显式错误，不静默转圈） */
  indexReady: boolean;
  /** 抽取索引代次：矩阵记忆化的失效判据 */
  depsEpoch: number;
  /** 索引/建表失败原因（必须可见 + 可重试） */
  loadError: string | null;
  /** 矩阵结果记忆化（按「角色 × 依赖版本 × 适配器」缓存） */
  matrixMemo: MatrixMemo;
  /** 活着的面板订阅者（面板挂载时 add / 卸载时 delete） */
  listeners: Set<() => void>;
  /** 等待索引就绪并重建 */
  refresh(): void;
  /** 作者工作区项目清单（「我的口上项目」筛选与写源用；服务缺席 = 空清单） */
  workspaceProjects: readonly WorkspaceProject[];
  workspaceLoading: boolean;
  /** 工作区读取失败原因（可见，但不阻塞矩阵本体） */
  workspaceError: string | null;
  /** 重拉工作区项目（项目创建 / 打开项目后） */
  reloadWorkspaces(): void;
  /** 工作区项目目录（服务缺席 / 未命中 = null；不抛） */
  projectDir(projectId: string): string | null;
}

export function createMatrixStore(ctx: PluginContext, deps: {
  parser: ErbParserService;
  project: ProjectService;
  conditionExtractor: ConditionExtractorService;
  services: AdapterServices;
  workspaces?: WorkspaceService;
}): MatrixStore {
  const { parser, project, conditionExtractor, services, workspaces } = deps;

  // ---- 状态（React 外部源；面板组件读取并订阅） ----
  /** 上一次建索引所用的索引实例（去重判据：同一实例不重复全量遍历） */
  let lastBuiltIndex: ErbIndex | null = null;
  /** 工作区读取的代次与在途合并（快速连开项目 / 建项目时只认最后一趟） */
  let workspaceGen = 0;
  let workspaceInFlight = false;
  let workspacePending = false;
  const state: MatrixStore = {
    characterIndex: null,
    indexReady: false,
    /** 抽取索引代次：每次重建索引 / 条件索引就绪即 +1——矩阵记忆化的失效判据 */
    depsEpoch: 0,
    /** 索引/建表失败原因（必须可见 + 可重试，不静默停在占位） */
    loadError: null,
    /** 矩阵结果记忆化（按「角色 × 依赖版本 × 适配器」缓存，杜绝选择/过滤时整表重算） */
    matrixMemo: createMatrixMemo(),
    listeners: new Set<() => void>(),
    refresh,
    workspaceProjects: [],
    workspaceLoading: false,
    workspaceError: null,
    reloadWorkspaces,
    projectDir: (projectId: string): string | null => {
      try {
        return workspaces?.projectDir(projectId) ?? null;
      } catch (err) {
        ctx.log.warn(`Workspace projectDir failed for '${projectId}': ${String(err)}`);
        return null;
      }
    },
  };

  const notify = (): void => {
    for (const cb of [...state.listeners]) {
      try {
        cb();
      } catch (err) {
        ctx.log.warn(`Condition matrix listener threw: ${String(err)}`);
      }
    }
  };

  /**
   * 拉取作者工作区项目（「我的口上项目」筛选只读这一份清单）。
   * 失败不阻塞矩阵：错误留在 `workspaceError` 由面板显式显示；在途时再请求 =
   * 记一笔 pending，当前这趟结束后补拉一次（不会丢事件，也不会并发打两趟）。
   */
  function reloadWorkspaces(): void {
    if (!workspaces) return;
    if (workspaceInFlight) {
      workspacePending = true;
      return;
    }
    workspaceInFlight = true;
    const gen = ++workspaceGen;
    state.workspaceLoading = true;
    state.workspaceError = null;
    notify();
    void workspaces
      .list()
      .then((projects) => {
        if (gen !== workspaceGen) return;
        state.workspaceProjects = projects;
        state.workspaceLoading = false;
        state.workspaceError = null;
      })
      .catch((err: unknown) => {
        if (gen !== workspaceGen) return;
        const msg = err instanceof Error ? err.message : String(err);
        state.workspaceProjects = [];
        state.workspaceLoading = false;
        state.workspaceError = msg;
        ctx.log.warn(`Workspace list failed (my-packs filter hidden): ${msg}`);
      })
      .finally(() => {
        if (gen !== workspaceGen) return;
        workspaceInFlight = false;
        notify();
        if (workspacePending) {
          workspacePending = false;
          reloadWorkspaces();
        }
      });
  }

  const rebuild = (index: ErbIndex | null): void => {
    // 去重：`project.opened` 与 `kojo.functionChanged` 会双双触发 refresh，
    // 两者拿到同一索引实例——同一实例不重复全量遍历（一次扫描即全量重算）。
    if (lastBuiltIndex === index) return;
    lastBuiltIndex = index;
    state.depsEpoch++;
    if (!index || !project.current()) {
      state.characterIndex = null;
      state.indexReady = index !== null;
    } else {
      state.characterIndex = buildCharacterIndex(index, services.currentFamilyIndex());
      state.indexReady = true;
    }
    state.loadError = null;
    notify();
  };

  /** 等待索引就绪并重建（项目刚打开时索引可能在途） */
  function refresh(): void {
    if (!project.current()) {
      rebuild(null);
      return;
    }
    state.loadError = null;
    notify();
    void parser
      .ensureIndex()
      .then((index) => rebuild(index))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        state.loadError = msg;
        state.indexReady = false;
        ctx.log.error(`Condition matrix load failed: ${msg}`);
        notify();
      });
  }

  ctx.onDispose(ctx.bus.on('kojo.functionChanged', () => refresh()));
  ctx.onDispose(
    ctx.bus.on('project.opened', () => {
      refresh();
      reloadWorkspaces();
    }),
  );
  ctx.onDispose(ctx.bus.on('project.closed', () => rebuild(null)));
  // 新建 / 导入 / 发布工作区项目都会广播它；「我的口上项目」的匹配清单不能停在旧一份
  ctx.onDispose(ctx.bus.on('workspace.projectCreated', () => reloadWorkspaces()));
  // 条件抽取索引就绪后重绘（填色依赖 functionConditions；立即回调一次，无副作用）
  // 代次 +1：抽取索引可能已更新，矩阵缓存须失效重算
  ctx.onDispose(
    conditionExtractor.subscribe(() => {
      state.depsEpoch++;
      notify();
    }),
  );

  // 激活时已有现成索引（插件晚于项目打开加载）→ 立即构建
  if (project.current()) refresh();
  // 工作区与游戏项目独立：即使没有打开项目也先拉一份（面板打开即可标注「我的」）
  reloadWorkspaces();

  return state;
}
