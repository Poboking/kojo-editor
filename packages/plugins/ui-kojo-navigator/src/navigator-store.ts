/**
 * 函数树的**外部状态源**（从 `index.ts` 的 `activate()` 原样迁出，时序与语义逐字不变）。
 *
 * 面板组件只订阅 `treeListeners` + 读只读字段（`let` 仍住原闭包，经访问器暴露 ⇒
 * 面板读法与原先的闭包读取同构），余下时序都住这里：
 *   - `kojo.functionChanged` / `project.opened` → `refresh()`（等索引就绪再建树）；
 *   - `project.closed` → `rebuild(null)`；
 *   - `NAV_SCOPE_EVENT` → 收窄宿主广播的"只看"戳后重扫（范围换了，同一份索引也是另一棵树）。
 *
 * 两条不静默的承诺（铁律 4）：建树/索引失败把原因留在 `loadError`（面板显式给「重试」）；
 * 实例去重（`shouldRebuildIndex`）只省算力，不改变「换范围必重扫」的口径。
 * 家族规则/面标签由 `index.ts` 的槽位查询提供，本模块不查槽位、不持游戏判据。
 */

import type {
  ErbIndex,
  ErbIndexState,
  ErbParserService,
  ErbScopeStamp,
  FamilyIndexRule,
  PluginContext,
  ProjectService,
} from '@kojo/plugin-api';
import { NAV_SCOPE_EVENT, isLibraryOnlyPath } from '@kojo/plugin-api';
import { type NavigatorTree, buildNavigatorTree, shouldRebuildIndex } from './tree';

/**
 * 宿主广播的"只看"范围载荷（`NAV_SCOPE_EVENT`；形状 = 契约的 `ErbScopeStamp`）。
 * 内核总线对自定义事件不做类型校验 ⇒ 这里**必须**自己收窄，畸形载荷按"不限"处理
 * （宁可多扫一轮，也不要把一棵树画成空白——空白会被读成"这个项目没有函数"）。
 */
function toScopeStamp(payload: unknown): ErbScopeStamp | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as { key?: unknown; roots?: unknown };
  if (typeof raw.key !== 'string' || !Array.isArray(raw.roots)) return null;
  const roots = raw.roots.filter((r): r is string => typeof r === 'string' && r !== '');
  return roots.length > 0 ? { key: raw.key, roots } : null;
}

/** 面板读取的外部状态源（读法与原闭包变量同构：字段只读，变化经 `treeListeners` 通知） */
export interface NavigatorStore {
  /** 当前函数树（未建 / 项目关闭 ⇒ null） */
  readonly tree: NavigatorTree | null;
  /** 索引是否就绪 */
  readonly indexReady: boolean;
  /**
   * 面向作者的函数索引（additive）：已剔除只读基座库文件。
   * 建树与面板搜索共用这一份，避免基础库函数混进「口上导航」的孤儿计数/搜索结果。
   */
  readonly index: ErbIndex | null;
  /** 当前"只看"范围（宿主广播的那一份；面板搜索与建树共用同一个戳） */
  readonly scope: ErbScopeStamp | null;
  /** 索引/建树失败原因（必须可见 + 可重试，不静默停在占位） */
  readonly loadError: string | null;
  /**
   * 索引这一轮的可查事实（IDX-STATE，**additive**）：提供方 `indexState()` 的原样转述，
   * 本状态源**不解释、不改写、不再判形状**（判据单源在 `erb-parser/index-state.ts`）。
   * 老实现不提供该方法 ⇒ `null`，面板退化成它原来的等待句（旧行为零改动）。
   */
  readonly indexState: ErbIndexState | null;
  /** 活着的面板订阅者（面板挂载时 add / 卸载时 delete） */
  readonly treeListeners: Set<() => void>;
  /** 等待索引就绪并重建（「重试」按钮与总线事件走同一条路径） */
  refresh(): void;
}

export function createNavigatorStore(ctx: PluginContext, deps: {
  parser: ErbParserService;
  project: ProjectService;
  currentFamilyIndex: () => FamilyIndexRule | null;
}): NavigatorStore {
  const { parser, project, currentFamilyIndex } = deps;
  // ---- 状态（React 外部源；面板组件读取并订阅） ----
  let tree: NavigatorTree | null = null;
  let indexReady = false;
  /** 上一次建树所用的索引实例（去重判据：同一实例不重复建树，见 `shouldRebuildIndex`） */
  let lastBuiltIndex: ErbIndex | null = null;
  /**
   * 只读基座库过滤后的作者索引（additive）。
   * 按**源索引实例**记忆：同一份索引重复 refresh（project.opened 与
   * kojo.functionChanged 成对触发）必须拿到同一实例，否则 `shouldRebuildIndex`
   * 的去重失效，95k 函数会被白建两遍树。
   */
  let authorIndexFrom: ErbIndex | null = null;
  let authorIndex: ErbIndex | null = null;
  /** 当前对面板暴露的作者视图（与建树所用同一实例） */
  let authorView: ErbIndex | null = null;
  const authorIndexOf = (index: ErbIndex | null): ErbIndex | null => {
    if (index === null) return null;
    if (authorIndexFrom === index) return authorIndex;
    const p = project.current();
    if (!p || (p.libraryPaths?.length ?? 0) === 0) {
      authorIndexFrom = index;
      authorIndex = index;
      return index;
    }
    authorIndexFrom = index;
    authorIndex = {
      ...index,
      files: new Map([...index.files].filter(([, f]) => !isLibraryOnlyPath(p, f.path))),
    };
    return authorIndex;
  };
  /**
   * 当前"只看"范围（宿主经 `NAV_SCOPE_EVENT` 广播的那一份，插件不持有判据）。
   * 上一次建树所用的范围 key——与索引实例**并列**的去重位：范围变了必须重扫，
   * 索引没变也不算"已经建过"（这正是 C3 批留下的那条断线：选择器只喂了全文检索）。
   */
  let scope: ErbScopeStamp | null = null;
  let lastBuiltScopeKey = '';
  /** 索引/建树失败原因（2026-10-11 实机反馈）：此前只在 catch 里 log.warn，
   *  面板永久停在「打开项目后自动构建函数索引…」占位，用户既不知失败也无从重试 */
  let loadError: string | null = null;
  const treeListeners = new Set<() => void>();

  const notify = (): void => {
    for (const cb of [...treeListeners]) {
      try {
        cb();
      } catch (err) {
        ctx.log.warn(`Navigator listener threw: ${String(err)}`);
      }
    }
  };

  const rebuild = (index: ErbIndex | null): void => {
    // 去重（2026-10-12 内核优化批）：`project.opened` 与 `kojo.functionChanged` 会
    // 双双触发 refresh，两者拿到的是同一个索引实例——同一实例不重复建树
    // （`buildNavigatorTree` 在 95k 函数上是近秒级开销，白跑第二遍纯属浪费）。
    // 但**范围变化抵消这条去重**：同一份索引换个范围就是另一棵树。
    const scoped = authorIndexOf(index);
    authorView = scoped;
    const scopeKey = scope?.key ?? '';
    if (!shouldRebuildIndex(lastBuiltIndex, scoped) && lastBuiltScopeKey === scopeKey) return;
    lastBuiltIndex = scoped;
    lastBuiltScopeKey = scopeKey;
    if (!scoped || !project.current()) {
      tree = null;
      indexReady = index !== null;
    } else {
      tree = buildNavigatorTree(scoped, currentFamilyIndex(), project.current()!.charaIndex, {
        scope,
      });
      indexReady = true;
    }
    loadError = null;
    notify();
  };

  /** 等待索引就绪并重建（项目刚打开时索引可能在途） */
  const refresh = (): void => {
    if (!project.current()) {
      rebuild(null);
      return;
    }
    // 2026-10-16 归属守卫：ensureIndex 在途时可能发生跨项目切换，旧回包落地前
    // 必须校验项目归属，否则建成「A 索引 + B 角色字典」的树（点击跳转会打开旧项目文件）。
    const requested = project.current();
    loadError = null;
    notify();
    void parser
      .ensureIndex()
      .then((index) => {
        if (project.current() !== requested) return;
        scheduleRebuild(index);
      })
      .catch((err: unknown) => {
        if (project.current() !== requested) return;
        // 失败必须可见（含建树抛错，此前被同一个 catch 静默吞掉）
        const msg = err instanceof Error ? err.message : String(err);
        loadError = msg;
        indexReady = false;
        ctx.log.error(`Navigator load failed: ${msg}`);
        notify();
      });
  };

  /**
   * 建树调度（P0-2 冷开实测）：建树是**全量**扫 99k 函数的一次性成本（逐函数解析家族 + 归属
   * + 排序，实测 200–400ms），而触发它的 `kojo.functionChanged` 是**索引任务里同步发出来**的
   * ——直接跟在同一拍上，等于让「索引已可用」那一帧再背一次建树的账（611ms 那帧里 240ms 是它）。
   *
   * 推到下一轮宏任务：索引帧按时收尾（状态栏/树面板先落「建树中」），建树自成一条短帧；
   * 同一轮里的多次触发只建一次（后到的索引赢），已建过的索引 + 范围仍由 `rebuild` 去重。
   * 这不是"少算一次"——`tree` 仍然是同一个纯函数的结果，只是不跟索引挤在一帧里。
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

  ctx.onDispose(ctx.bus.on('kojo.functionChanged', () => refresh()));
  ctx.onDispose(ctx.bus.on('project.opened', () => refresh()));
  ctx.onDispose(ctx.bus.on('project.closed', () => scheduleRebuild(null)));
  /**
   * 「只看」范围（W7 NAV-SCOPE）：宿主那条选择器的**同一份**戳广播到这里。
   * 索引实例没变也要重扫——范围换了，树就该换（旧行为是这里根本不读选择器，
   * 于是选定范围后全文检索只扫一处、函数树仍扫全量十万条）。
   */
  ctx.onDispose(
    ctx.bus.on(NAV_SCOPE_EVENT, (payload: unknown) => {
      scope = toScopeStamp(payload);
      const current = project.current();
      if (!current) return;
      const idx = parser.currentIndex();
      if (idx) scheduleRebuild(idx);
      else refresh();
    }),
  );

  // 激活时已有现成索引（插件晚于项目打开加载）→ 立即构建
  if (project.current()) refresh();

  return {
    get tree() {
      return tree;
    },
    get indexReady() {
      return indexReady;
    },
    get index() {
      return authorView;
    },
    get scope() {
      return scope;
    },
    get loadError() {
      return loadError;
    },
    /** 原样转述提供方的事实；方法缺席（老实现）⇒ null，面板退回旧等待句 */
    get indexState() {
      return parser.indexState?.() ?? null;
    },
    treeListeners,
    refresh,
  };
}
