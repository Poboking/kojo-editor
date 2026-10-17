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
}

export function createMatrixStore(ctx: PluginContext, deps: {
  parser: ErbParserService;
  project: ProjectService;
  conditionExtractor: ConditionExtractorService;
  services: AdapterServices;
}): MatrixStore {
  const { parser, project, conditionExtractor, services } = deps;

  // ---- 状态（React 外部源；面板组件读取并订阅） ----
  /** 上一次建索引所用的索引实例（去重判据：同一实例不重复全量遍历） */
  let lastBuiltIndex: ErbIndex | null = null;
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
  ctx.onDispose(ctx.bus.on('project.opened', () => refresh()));
  ctx.onDispose(ctx.bus.on('project.closed', () => rebuild(null)));
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

  return state;
}
