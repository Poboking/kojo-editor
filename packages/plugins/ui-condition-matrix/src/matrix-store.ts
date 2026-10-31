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
  FileIO,
  PluginContext,
  ProjectService,
  StateDependency,
  SugarTranspileService,
  WorkspaceProject,
  WorkspaceService,
} from '@kojo/plugin-api';
import type { CharacterEntry, CharacterIndex, MatrixMemo } from './matrix-logic';
import { buildCharacterIndex, createMatrixMemo } from './matrix-logic';
import type { AdapterServices } from './adapter-services';
import type { WorkspacePackRef } from './matrix-scope';
import { loadWorkspaceIndex } from './workspace-index';

/** 工作区包矩阵的加载态（一次只加载用户选中的那一枚 artifact） */
export interface WorkspaceMatrixState {
  /** 当前加载/已加载的 `ws:` 包键（null = 还没选过工作区包） */
  readonly key: string | null;
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly charaNo: number | null;
  readonly entry: CharacterEntry | null;
  /** 工作区函数名 → 状态依赖（抽取失败/旧服务缺席时回退游戏索引） */
  readonly depsOf: ((normalizedName: string) => StateDependency[]) | null;
  readonly problems: readonly string[];
  readonly stats: { readonly files: number; readonly functions: number; readonly kojoFiles: number } | null;
  readonly error: string | null;
}

const IDLE_WORKSPACE_MATRIX: WorkspaceMatrixState = {
  key: null,
  status: 'idle',
  charaNo: null,
  entry: null,
  depsOf: null,
  problems: [],
  stats: null,
  error: null,
};

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
  /** 工作区包矩阵（用户选中的那一枚 artifact 的索引/抽取结果） */
  workspaceMatrix: WorkspaceMatrixState;
  /** 加载（或重载）工作区包矩阵；面板在包下拉切换时调用 */
  loadWorkspaceMatrix(pack: { key: string; ref: WorkspacePackRef }, charaNo: number): void;
}

export function createMatrixStore(ctx: PluginContext, deps: {
  parser: ErbParserService;
  project: ProjectService;
  conditionExtractor: ConditionExtractorService;
  services: AdapterServices;
  io: Pick<FileIO, 'walkDir' | 'readTexts'>;
  sugar?: Pick<SugarTranspileService, 'transpile'>;
  workspaces?: WorkspaceService;
}): MatrixStore {
  const { parser, project, conditionExtractor, services, io, sugar, workspaces } = deps;

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
    workspaceMatrix: IDLE_WORKSPACE_MATRIX,
    loadWorkspaceMatrix,
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

  // ---- 工作区包矩阵（「我的口上项目」视图）----
  /** 在途代次：切换包 / 重载都 +1，旧结果回来直接丢弃 */
  let workspaceMatrixGen = 0;

  function loadWorkspaceMatrix(pack: { key: string; ref: WorkspacePackRef }, charaNo: number): void {
    const gen = ++workspaceMatrixGen;
    state.workspaceMatrix = {
      key: pack.key,
      status: 'loading',
      charaNo,
      entry: null,
      depsOf: null,
      problems: [],
      stats: null,
      error: null,
    };
    notify();
    void (async () => {
      try {
        const bundle = await loadWorkspaceIndex(
          { io, parser, ...(sugar ? { sugar } : {}) },
          pack.ref.rootPath,
        );
        if (gen !== workspaceMatrixGen) return;
        const charIndex = buildCharacterIndex(bundle.displayIndex, services.currentFamilyIndex());
        const entry = charIndex.entries.get(charaNo) ?? null;
        let depsOf: ((normalizedName: string) => StateDependency[]) | null = null;
        if (typeof conditionExtractor.extractIndex === 'function') {
          const conditions = await conditionExtractor.extractIndex(bundle.extractIndex, bundle.texts);
          if (gen !== workspaceMatrixGen) return;
          const byName = new Map<string, StateDependency[]>();
          for (const [name, cond] of conditions.byFunction) {
            byName.set(name.toUpperCase(), cond.dependencies);
          }
          // 未命中（该文件抽取失败 / 无依赖）回退游戏索引：同名函数的依赖口径仍有一份
          depsOf = (normalizedName) => byName.get(normalizedName.toUpperCase()) ?? services.depsOf(normalizedName);
        } else {
          depsOf = services.depsOf;
        }
        state.workspaceMatrix = {
          key: pack.key,
          status: 'ready',
          charaNo,
          entry,
          depsOf,
          problems: bundle.problems,
          stats: {
            files: bundle.displayIndex.files.size,
            functions: entry?.functions.length ?? 0,
            kojoFiles: bundle.kojoFiles,
          },
          error: null,
        };
      } catch (err) {
        if (gen !== workspaceMatrixGen) return;
        const msg = err instanceof Error ? err.message : String(err);
        state.workspaceMatrix = {
          key: pack.key,
          status: 'error',
          charaNo,
          entry: null,
          depsOf: null,
          problems: [],
          stats: null,
          error: msg,
        };
        ctx.log.warn(`Workspace matrix load failed for '${pack.ref.rootPath}': ${msg}`);
      }
      if (gen === workspaceMatrixGen) notify();
    })();
  }

  const resetWorkspaceMatrix = (): void => {
    workspaceMatrixGen++;
    state.workspaceMatrix = IDLE_WORKSPACE_MATRIX;
  };

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

  /**
   * 建表调度（STATE §四 记的那条欠账，2026-10-31 收口）：`buildCharacterIndex` 是**全量**扫
   * 117k 函数的一次性成本（实测 **292ms**），而触发它的 `kojo.functionChanged` 是**索引任务里
   * 同步发出来**的——直接跟在同一拍上，等于让「索引已可用」那一帧再背一次建表的账。
   *
   * 推到下一轮宏任务（与 `navigator-store.scheduleRebuild` 同形）：索引帧按时收尾（面板先落
   * 「建表中」），建表自成一条短帧；同一轮里的多次触发只建一次（后到的索引赢），已建过的
   * 索引仍由 `rebuild` 的实例去重兜底。这不是"少算一次"——`characterIndex` 仍是同一个纯函数
   * 的结果，只是不跟索引挤在同一帧里。
   */
  let pendingBuild: ErbIndex | null = null;
  let buildScheduled = false;
  const scheduleRebuild = (index: ErbIndex | null): void => {
    pendingBuild = index;
    if (buildScheduled) return;
    buildScheduled = true;
    setTimeout(() => {
      buildScheduled = false;
      const next = pendingBuild;
      pendingBuild = null;
      rebuild(next);
    }, 0);
  };
  ctx.onDispose(() => {
    buildScheduled = false;
    pendingBuild = null;
  });

  /** 等待索引就绪并重建（项目刚打开时索引可能在途） */
  function refresh(): void {
    if (!project.current()) {
      pendingBuild = null; // 清挂起：否则宏任务会把已关项目的矩阵建回来
      rebuild(null);
      return;
    }
    // 归属守卫（照 `navigator-store` 2026-10-16 那条）：`ensureIndex` 在途时可能跨项目切换，
    // 旧回包落地前必须校验归属，否则建成「A 索引 + B 角色字典」的矩阵。
    const requested = project.current();
    state.loadError = null;
    notify();
    void parser
      .ensureIndex()
      .then((index) => {
        if (project.current() !== requested) return;
        scheduleRebuild(index);
      })
      .catch((err: unknown) => {
        if (project.current() !== requested) return;
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
      resetWorkspaceMatrix();
      refresh();
      reloadWorkspaces();
    }),
  );
  ctx.onDispose(
    ctx.bus.on('project.closed', () => {
      resetWorkspaceMatrix();
      // 清挂起的建表：否则宏任务会把已关项目刚算出的索引建回来
      pendingBuild = null;
      rebuild(null);
    }),
  );
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
