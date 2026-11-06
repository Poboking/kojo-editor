/**
 * 反向引用边的**增量维护**（MCP-PERF-S2，2026-11-06；纯数据、零 IO、可单测）。
 *
 * 为什么要有这一层：`incremental.ts` 的增量把 `byName` / 文件表维护得很好，唯独
 * `references` 刻意不带——反向引用边是「当时名录下的可见记号扫描」结果，跨文件的
 * 边没法安全更新 ⇒ 下一次 `index.references` 访问触发整树全量重扫（真语料 ~3s）。
 * 本模块把那条「整树重扫」拆成「per-file 的引用流出账 + 受影响名字的组局部重建」：
 *
 * - **流出账**：每文件的 refs 流水本来就记录了"本文件引用了哪些名字"（`refsByPath`）。
 *   单文件变化后，受影响的只有「变过的文件的流出 ∪ 被这些流出改动的名字的流入」。
 * - **倒排**：`nameToFiles`（名字 → 引用它的文件，按文件序升序）——重建一个名字的组
 *   只遍历"提到它的文件"，不再扫全树。
 * - **溯源巡检**（复用快照热轮的既有判据，**判据单源**）：名录变了（对称差非空）时，
 *   未变文件的流出账是否仍可信由 `candidateHashes`（候选记号哈希集）裁决——
 *   对称差哈希与候选集不相交 ⇒ 可证不变，免扫；否则该文件重扫一遍（真语料实测
 *   改/名一个中等用量名字只牵动个位数文件）。判据核心 `candidateSetHits` 与
 *   快照侧 `refsProvableUnchanged` 共用一份循环（`snapshot.ts`）。
 * - **版本号**：每次增量 `version` +1；`ErbIndex.version` / `ErbReferenceIndex.version`
 *   随索引一起换代，查询方拿到版本即可判断 stale。
 * - **显式 stale**：判不了的名字进 `dirtyNames`，随 `ErbReferenceIndex.staleNames`
 *   **可见地**交出——组内容仍是尽力而为的最新账（不答空），可信度由标注如实声明。
 *   不再静默排整树重扫。判不了的唯一形态是「受染未变文件的重扫读盘失败」：该文件
 *   进 `unsoundByPath` 名册，本轮变掉的名字（旧账只可能在这批名字上多边/少边）记为
 *   可疑；名册里的文件后来重扫成功或退场即除名，全体名册清空 ⇒ stale 面回空集。
 *
 * 语义红线：`ErbIndex.references` 的回答逐位不变——组内排序 = 文件序（`orderToPath`
 * 的升序序号）→ 行 → 列，与 `buildReferenceIndex` 按同一份 `files` 迭代序聚合的产出
 * 逐位一致（`refs-incremental.test.ts` 对拍钉死）。快照格式不动；`refsProvableUnchanged`
 * 等既有判定不动。
 */

import type { ErbFile, ErbReference, ErbReferenceIndex } from '@kojo/plugin-api';
import { buildReferenceIndex, forEachRef, KIND_BY_FLAG, type FileRefs } from './references';

/**
 * 常驻的反向边状态（**跨整扫/增量轮存活**，与 `index` 同寿命：项目关闭即重建）。
 *
 * 内存账（真语料口径）：`refsByPath` 与快照条目的 refs 是同一枚数组的别名（零拷贝）；
 * `candidatesByPath` 与快照条目的 `candidateHashes` 同理；倒排 ~130k (名,文件) 对 ≈ 2MB；
 * `orderToPath` 每文件一槽 ≈ 32KB。物化表 `bySymbol` 就是既有 `referencesBuild` 的产物，
 * 时机不变（首次消费才建）。
 */
export interface RefsLiveState {
  /** 索引版本号：整扫与增量各 +1（`ErbIndex.version` 的真源） */
  version: number;
  /** per-file 引用流出账（全文件；复用条目与快照 refs 同一枚数组，零拷贝） */
  readonly refsByPath: Map<string, FileRefs>;
  /** per-file 候选记号哈希集（溯源巡检的免疫判据；与快照条目同枚数组或新扫时现算） */
  readonly candidatesByPath: Map<string, Uint16Array>;
  /** path → 文件序号（`files` 迭代序的镜像；替换保序、新增递增） */
  readonly orderOfPath: Map<string, number>;
  /** 序号 → path（append-only 数组；删除置 `undefined` 留洞，序号不回收） */
  readonly orderToPath: (string | undefined)[];
  /**
   * 倒排：名字 → 引用它的文件的**升序序号**数组（惰性：首次增量轮或首次需要时建）。
   * 升序不变量：预热按 `files` 序铺、摘除 `splice` 保序、挂边二分插入。
   */
  nameToFiles: Map<string, number[]> | null;
  /** 物化的反向索引（惰性：首次 `index.references` 访问才建；增量轮就地更新组） */
  bySymbol: Map<string, readonly ErbReference[]> | null;
  /**
   * 重扫失败（判不了）的文件 → 当时记为可疑的名字集（显式 stale 面的原料）。
   * 文件重扫成功或退场即除名；`dirtyNames` 每轮从这本名册重算（见 {@link recomputeDirtyNames}）。
   */
  readonly unsoundByPath: Map<string, Set<string>>;
  /** 判不了的名字（显式 stale 面；`ErbReferenceIndex.staleNames` 的真源） */
  readonly dirtyNames: Set<string>;
  /** 已发出去的视图缓存（`version` 变即作废重建） */
  view: ErbReferenceIndex | null;
  viewVersion: number;
  /** 目前见过的最大序号（新文件取 `maxOrder + 1`） */
  maxOrder: number;
}

export function createRefsLiveState(): RefsLiveState {
  return {
    version: 0,
    refsByPath: new Map(),
    candidatesByPath: new Map(),
    orderOfPath: new Map(),
    orderToPath: [],
    nameToFiles: null,
    bySymbol: null,
    unsoundByPath: new Map(),
    dirtyNames: new Set(),
    view: null,
    viewVersion: -1,
    maxOrder: -1,
  };
}

/** 版本换代（整扫或增量各一次）：视图缓存随之作废 */
export function bumpRefsVersion(state: RefsLiveState): number {
  state.version++;
  state.view = null;
  return state.version;
}

/**
 * 整扫轮预热：铺流出账全集 + 候选集 + 文件序（**倒排与物化仍懒**）。
 *
 * `refsFallback` / `candidatesFallback` 负责按路径取数——构建轮先问本轮重扫的产出、
 * 再回退快照条目（零拷贝别名）。refs 缺失的文件同样占一个序号（`files` 序即真相），
 * 组重建与全量聚合对它的处理一致（跳过）。
 *
 * 刻意不建倒排：预热只需 O(文件数)，倒排的 O(引用总数) 留给第一次真正需要它的
 * 增量轮/物化去付——热开项目若没人保存文件也没人查引用，一笔都不出。
 */
export function prewarmRefsLive(
  state: RefsLiveState,
  files: ReadonlyMap<string, ErbFile>,
  refsFallback: (path: string) => FileRefs | undefined,
  candidatesFallback: (path: string) => Uint16Array | undefined,
): void {
  state.refsByPath.clear();
  state.candidatesByPath.clear();
  state.orderOfPath.clear();
  state.orderToPath.length = 0;
  state.maxOrder = -1;
  state.nameToFiles = null;
  state.bySymbol = null;
  state.view = null;
  state.viewVersion = -1;
  state.unsoundByPath.clear();
  state.dirtyNames.clear();
  let order = 0;
  for (const path of files.keys()) {
    const refs = refsFallback(path);
    if (refs !== undefined) {
      state.refsByPath.set(path, refs);
      const candidates = candidatesFallback(path);
      if (candidates !== undefined) state.candidatesByPath.set(path, candidates);
    }
    state.orderOfPath.set(path, order);
    state.orderToPath[order] = path;
    order++;
  }
  state.maxOrder = order - 1;
}

/**
 * 倒排（惰性）：从流出账全集铺 `nameToFiles`。
 *
 * 序不变量的来源：`refsByPath` 的迭代序 = 插入序 = 文件序（预热按 `files` 序铺、
 * 增量新增的文件序号递增且 Map 项追加在尾部、中间删除不改变相对序）⇒ 逐文件
 * 顺序遍历时每个名字收到的序号天然升序，免去逐数组排序。
 */
export function ensureInverted(state: RefsLiveState): Map<string, number[]> {
  if (state.nameToFiles !== null) return state.nameToFiles;
  const inverted = new Map<string, number[]>();
  for (const [path, refs] of state.refsByPath) {
    const order = state.orderOfPath.get(path);
    if (order === undefined) continue;
    forEachRef(refs, (name) => {
      let arr = inverted.get(name);
      if (arr === undefined) inverted.set(name, (arr = []));
      if (arr.length === 0 || arr[arr.length - 1] !== order) arr.push(order);
    });
  }
  state.nameToFiles = inverted;
  return inverted;
}

/**
 * 从倒排**按序重建**一个名字的组（组内 = 文件序 → 行 → 列；与全量聚合逐位一致）。
 *
 * `filePath` 复用 `ErbFile.path` 的同一字符串实例——与 `buildReferenceIndex` 同一条纪律，
 * 几百万引用点不各拷一份路径。`endColumn = column + 名字长度` 同口径。
 */
export function rebuildNameGroup(
  state: RefsLiveState,
  files: ReadonlyMap<string, ErbFile>,
  name: string,
): ErbReference[] {
  const orders = state.nameToFiles?.get(name);
  if (orders === undefined || orders.length === 0) return [];
  const out: ErbReference[] = [];
  for (const order of orders) {
    const path = state.orderToPath[order];
    if (path === undefined) continue;
    const file = files.get(path);
    if (file === undefined) continue;
    const refs = state.refsByPath.get(path);
    if (refs === undefined) continue;
    forEachRef(refs, (refName, line, column, kind) => {
      if (refName !== name) return;
      out.push({ filePath: file.path, line, column, endColumn: column + name.length, kind: KIND_BY_FLAG[kind]! });
    });
  }
  return out;
}

/** 一次增量要挂上的新事实：重扫文件的新流水 + 新候选集 */
export interface RescanOutcome {
  readonly refs: FileRefs;
  readonly candidates: Uint16Array;
}

/** 升序插入一个序号（倒排数组的不变量维护；数组短（平均 ~5），二分足以） */
function insertOrder(arr: number[], order: number): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < order) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, order);
}

/**
 * 应用一次增量（**就地**更新常驻态；返回受影响的名字集）。
 *
 * `rescanned`：这轮重扫出的新流水（变过的文件 + 溯源巡检判"受染"的未变文件）；
 * `removedPaths`：实际从索引退场的路径（目录前缀已展开成逐文件）。
 *
 * 受影响名字 = 摘掉的旧流水的名字 ∪ 挂上的新流水的名字。物化表在 ⇒ 每个受影响名字
 * 的组**就地重建**（新数组替换旧数组——已发出的读数是 `slice` 副本，不受影响）；
 * 未物化 ⇒ 只更新流出账与倒排，物化时从当前状态自然建出正确结果。
 *
 * 序不变量：退场文件让位（留洞）；重扫文件**座位保留**——先摘流水再挂回，它的序号
 * 仍在原位（倒排边二分插回）；新文件序号全局最大（`files` 迭代序也是追加在尾，
 * 两边逐位对齐，见头注"语义红线"）。
 */
export function applyRefsLiveDelta(
  state: RefsLiveState,
  files: ReadonlyMap<string, ErbFile>,
  rescanned: ReadonlyMap<string, RescanOutcome>,
  removedPaths: ReadonlySet<string>,
): ReadonlySet<string> {
  const trackGroups = state.bySymbol !== null || state.nameToFiles !== null;
  const inverted = trackGroups ? ensureInverted(state) : null;
  const affected = new Set<string>();

  /** `keepSeat`：重扫文件摘流水但**保座位**（序号不换）；退场文件连座位一起让出 */
  const drop = (path: string, keepSeat: boolean): void => {
    const order = state.orderOfPath.get(path);
    const old = state.refsByPath.get(path);
    state.refsByPath.delete(path);
    state.candidatesByPath.delete(path);
    if (!keepSeat) {
      state.orderOfPath.delete(path);
      if (order !== undefined) state.orderToPath[order] = undefined;
    }
    if (inverted !== null && old !== undefined && order !== undefined) {
      forEachRef(old, (name) => {
        const arr = inverted.get(name);
        if (arr === undefined) return;
        const at = arr.indexOf(order);
        if (at < 0) return;
        arr.splice(at, 1);
        if (arr.length === 0) inverted.delete(name);
        affected.add(name);
      });
    }
    if (!keepSeat) state.unsoundByPath.delete(path); // 退场 = 它的疑点随文件一起消失
  };
  for (const path of removedPaths) drop(path, false);
  for (const path of rescanned.keys()) {
    if (state.refsByPath.has(path)) drop(path, true);
  }

  for (const [path, fresh] of rescanned) {
    state.refsByPath.set(path, fresh.refs);
    state.candidatesByPath.set(path, fresh.candidates);
    // 重扫成功 = 这份文件的账重新可信：从 unsound 名册除名（哪怕它是好几轮前判不了的）
    state.unsoundByPath.delete(path);
    const existing = state.orderOfPath.get(path);
    let order: number;
    if (existing === undefined) {
      order = ++state.maxOrder;
      state.orderOfPath.set(path, order);
      state.orderToPath[order] = path;
    } else {
      order = existing;
      state.orderToPath[order] = path;
    }
    if (inverted !== null) {
      // 同文件同名多条边只登记一次文件（流水按行列升序，同名可能反复出现）
      const seen = new Set<string>();
      forEachRef(fresh.refs, (name) => void seen.add(name));
      for (const name of seen) {
        let arr = inverted.get(name);
        if (arr === undefined) inverted.set(name, (arr = []));
        if (!arr.includes(order)) insertOrder(arr, order);
        affected.add(name);
      }
    }
  }

  if (state.bySymbol !== null) {
    for (const name of affected) {
      const group = rebuildNameGroup(state, files, name);
      if (group.length === 0) state.bySymbol.delete(name);
      else state.bySymbol.set(name, group);
    }
  }
  recomputeDirtyNames(state);
  return affected;
}

/**
 * 显式 stale 面的重算（`dirtyNames` 的唯一真源是 `unsoundByPath` 名册）：
 * 名册里每份文件在**判不了那一刻**记下的可疑名字（本轮变掉的名字——旧账只可能
 * 在这批名字上多边/少边）。文件重扫成功 / 退场即除名（{@link applyRefsLiveDelta}），
 * 名册空 ⇒ stale 面回空集（常态单文件保存永远走不到这里）。
 */
function recomputeDirtyNames(state: RefsLiveState): void {
  state.dirtyNames.clear();
  for (const names of state.unsoundByPath.values()) {
    for (const name of names) state.dirtyNames.add(name);
  }
  syncViewStaleNames(state);
}

/**
 * 重扫失败的唯一合法出口（**可见、不答空**）：文件进 unsound 名册，可疑名字
 * 随 `ErbReferenceIndex.staleNames` 交出。调用方给的是"这一轮判不了的文件 →
 * 本轮变掉的名字"；同文件多轮失败按并集累积。
 */
export function markRescanFailures(
  state: RefsLiveState,
  failures: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  for (const [path, names] of failures) {
    const acc = state.unsoundByPath.get(path);
    if (acc === undefined) state.unsoundByPath.set(path, new Set(names));
    else for (const name of names) acc.add(name);
  }
  recomputeDirtyNames(state);
}

/** 把 dirtyNames 的现状同步到已发出的视图缓存（无视图 / 空集 = 键缺席，契约同观感） */
function syncViewStaleNames(state: RefsLiveState): void {
  if (state.view === null) return;
  const carrier = state.view as { staleNames?: ReadonlySet<string> };
  if (state.dirtyNames.size > 0) carrier.staleNames = state.dirtyNames;
  else delete carrier.staleNames;
}

/**
 * 物化反向索引（惰性，`index.references` 首次访问的时机——PERF-7 纪律不变）。
 * 从流出账全集按 `files` 迭代序聚合，产出与整轮冷建逐位一致。
 */
export function ensureBySymbol(state: RefsLiveState, files: ReadonlyMap<string, ErbFile>): Map<string, readonly ErbReference[]> {
  if (state.bySymbol !== null) return state.bySymbol;
  state.bySymbol = new Map(buildReferenceIndex(files.values(), state.refsByPath).bySymbol);
  return state.bySymbol;
}

/**
 * `index.references` 的视图（**同一代同枚对象**：`version` 没变就复用缓存，
 * 与既有 `referencesBuild` 的"构建结果自持缓存"同一条纪律）。
 */
export function refsViewOf(state: RefsLiveState, files: ReadonlyMap<string, ErbFile>): ErbReferenceIndex {
  if (state.view !== null && state.viewVersion === state.version) return state.view;
  const view: ErbReferenceIndex = { bySymbol: ensureBySymbol(state, files), version: state.version };
  state.view = view;
  state.viewVersion = state.version;
  syncViewStaleNames(state);
  return view;
}