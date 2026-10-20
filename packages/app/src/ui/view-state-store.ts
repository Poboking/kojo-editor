import { pathKey } from '@kojo/plugin-api';

/**
 * 编辑器视图状态的跨会话持久层：localStorage、版本化键、LRU 上限、损坏即整库清洗。
 * 纯逻辑零 React 零 Monaco——Monaco 视图状态在这里只是 `unknown`，抽取/钳制是纯函数，可单测。
 * 与布局同族（layout.ts 的"版本化 key + 清洗"路子），独立成库：键按 项目根+文件绝对路径 组合。
 *
 * 版本策略（folds 为 additive 字段，**不 bump schema、不改键**）：
 * - 旧版本写出的 v1 条目没有 folds ⇒ 读入时补 []（视作"无折叠"），不迁移、不炸；
 * - 旧版本读到带 folds 的新条目会忽略该未知字段，下次 flush 自然退回无 folds——可接受的降级
 *   （光标/滚动不受影响，只是折叠丢一次）；bump 版本会整库丢弃旧光标状态，代价大于收益。
 * - 条目内 folds 损坏只清该字段（selections 仍有效）；selections 损坏才整条摘除（原纪律不变）。
 */

const STORE_KEY = 'kojo.viewState.v1';
const SCHEMA_VERSION = 1;
export const MAX_ENTRIES = 300;
export const FLUSH_DEBOUNCE_MS = 600;
const MAX_SELECTIONS = 64;

/**
 * 折叠体积闸（每条目 + 全库双预算）：
 * - 每条文件最多 MAX_FOLDS_PER_FILE 条（约 38KB/文件；Monaco 默认 foldingMaximumRegions=5000，
 *   作者日常折叠远低于此，400 已覆盖整份大脚本的粗粒度折叠）；
 * - 全库最多 MAX_TOTAL_FOLDS 条（约 570KB ≈ localStorage 常见 5MB 配额的 12%）；
 * 超预算一律**先丢折叠、保光标/滚动**：从最久未用（Map 头部）的条目开始整条清空 folds，
 * 光标是主、折叠是次，绝不因为折叠把视图状态整条挤掉。
 */
export const MAX_FOLDS_PER_FILE = 400;
export const MAX_TOTAL_FOLDS = 6000;

export interface SerializedRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** IEditorViewState 的可序列化子集：光标/选区 + 滚动 + 折叠（自 pick，不盲存整对象） */
export interface ViewSlice {
  selections: SerializedRange[];
  scrollTop: number;
  scrollLeft: number;
  /**
   * 折叠 memento（可选 = additive：旧版本条目没有该字段，读入视作 []；写入时缺失同样视作 []）。
   * 行号与 Monaco 一致，1-based。
   */
  folds?: SerializedFold[];
}

/**
 * 单条折叠：Monaco folding contribution memento 的可序列化子集。
 * 现行 0.57 的 `saveViewState()` 落在 `contributionsState['editor.contrib.folding'].collapsedRegions`，
 * 形如 `{ startLineNumber, endLineNumber, isCollapsed, source, checksum }`；部分嵌入/旧版形态
 * 是 `{ startLineNumber, endLineNumber, type }`。两类都收，恢复时按 `collapsedRegions` 原形喂回。
 */
export interface SerializedFold {
  startLineNumber: number;
  endLineNumber: number;
  /** 折叠类型（Monaco 部分版本/provider 带；无则省略键） */
  type?: string;
  /** Monaco memento 字段：是否处于折叠态（缺省由 Monaco 视作 true） */
  isCollapsed?: boolean;
  /** 折叠来源（0 = provider，其余 = manual/auto；恢复时透传） */
  source?: number;
  /** 行内容校验和：内容变了的折叠由 Monaco applyMemento 自行跳过，不恢复错位折叠 */
  checksum?: number;
}

interface PersistedEnvelope {
  v: number;
  entries: Record<string, ViewSlice>;
}

/** 键归一化走 pathKey（Windows 折叠大小写与分隔符，与全仓路径判等同口径） */
export function viewStateKey(root: string, file: string): string {
  return `${pathKey(root)}\u0000${pathKey(file)}`;
}

function positiveInt(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const n = Math.trunc(raw);
  return n >= 1 ? n : null;
}

function nonNegative(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function sanitizeRange(raw: unknown): SerializedRange | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const sl = positiveInt(r.startLineNumber);
  const sc = positiveInt(r.startColumn);
  const el = positiveInt(r.endLineNumber);
  const ec = positiveInt(r.endColumn);
  if (sl === null || sc === null || el === null || ec === null) return null;
  return { startLineNumber: sl, startColumn: sc, endLineNumber: el, endColumn: ec };
}

function nonNegativeInt(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const n = Math.trunc(raw);
  return n >= 0 ? n : null;
}

function boundedText(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s.length >= 1 && s.length <= maxLen ? s : null;
}

/** 单条折叠清洗：必须正序且跨 >= 2 行；余下字段按形状自 pick（坏字段丢字段、不丢条目） */
function sanitizeFold(raw: unknown): SerializedFold | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const sl = positiveInt(r.startLineNumber);
  const el = positiveInt(r.endLineNumber);
  if (sl === null || el === null || sl >= el) return null;
  const fold: SerializedFold = { startLineNumber: sl, endLineNumber: el };
  const type = boundedText(r.type, 64);
  if (type !== null) fold.type = type;
  if (typeof r.isCollapsed === 'boolean') fold.isCollapsed = r.isCollapsed;
  const source = nonNegativeInt(r.source);
  if (source !== null) fold.source = source;
  const checksum = nonNegativeInt(r.checksum);
  if (checksum !== null) fold.checksum = checksum;
  return fold;
}

/** 折叠数组清洗：坏条摘除、同区间去重、按文件预算截断（保留靠前的折叠） */
function sanitizeFolds(raw: unknown, limit = MAX_FOLDS_PER_FILE): SerializedFold[] {
  if (!Array.isArray(raw)) return [];
  const out: SerializedFold[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const f = sanitizeFold(item);
    if (!f) continue;
    const k = `${f.startLineNumber}:${f.endLineNumber}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
    if (out.length >= limit) break;
  }
  return out;
}

function sanitizeSlice(raw: unknown): ViewSlice | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.selections)) return null;
  const selections: SerializedRange[] = [];
  for (const item of r.selections) {
    const s = sanitizeRange(item);
    if (!s) continue;
    selections.push(s);
    if (selections.length >= MAX_SELECTIONS) break;
  }
  if (selections.length === 0) return null;
  return {
    selections,
    scrollTop: nonNegative(r.scrollTop),
    scrollLeft: nonNegative(r.scrollLeft),
    folds: sanitizeFolds(r.folds), // 缺失/损坏 ⇒ []，不拖垮本条目的光标状态
  };
}

function rangeFromCursorStateEntry(item: unknown): SerializedRange | null {
  if (typeof item !== 'object' || item === null) return null;
  const e = item as Record<string, unknown>;
  // monaco 现行形态 { modelState: { selection, position } }；兼容裸 { selection } 与仅 { position }
  const modelState = typeof e.modelState === 'object' && e.modelState !== null ? (e.modelState as Record<string, unknown>) : undefined;
  const sel = sanitizeRange(e.selection ?? modelState?.selection);
  if (sel) return sel;
  const pos = (typeof e.position === 'object' && e.position !== null ? e.position : modelState?.position) as
    | { lineNumber?: unknown; column?: unknown }
    | null
    | undefined;
  if (!pos) return null;
  const ln = positiveInt(pos.lineNumber);
  const col = positiveInt(pos.column);
  if (ln === null || col === null) return null;
  return { startLineNumber: ln, startColumn: col, endLineNumber: ln, endColumn: col };
}

export const FOLDING_CONTRIBUTION_ID = 'editor.contrib.folding';

/**
 * 恢复折叠用的 contribution 状态：`editor.getContribution(FOLDING_CONTRIBUTION_ID)` 拿到
 * FoldingController 后，把它喂给 `restoreViewState(state)` 即可（Monaco 只读 collapsedRegions）。
 * 空数组 ⇒ null（调用方据此跳过，别拿空状态去触发一次不必要的 restore）。
 * 本库零 Monaco 依赖，这里只产出纯数据，接线由 EditorPane 完成。
 */
export function foldRestoreState(
  folds: readonly SerializedFold[] | undefined,
): { collapsedRegions: SerializedFold[] } | null {
  if (!folds || folds.length === 0) return null;
  return { collapsedRegions: folds.map((f) => ({ ...f })) };
}

/**
 * 从 Monaco `saveViewState()` 产物里取折叠 memento 数组，兼容三种形态：
 * 1. 现行 0.57：`contributionsState['editor.contrib.folding'].collapsedRegions`；
 * 2. 旧版贡献直接返回数组：`contributionsState['editor.contrib.folding']` 本身；
 * 3. 其他嵌入/替身：`viewState.folds` 直接挂在视图状态上（任务口径的"原形"）。
 */
function foldRangesFromViewState(viewState: unknown): unknown[] {
  if (typeof viewState !== 'object' || viewState === null) return [];
  const vs = viewState as Record<string, unknown>;
  const contributions = vs.contributionsState;
  if (typeof contributions === 'object' && contributions !== null) {
    const state = (contributions as Record<string, unknown>)[FOLDING_CONTRIBUTION_ID];
    if (Array.isArray(state)) return state;
    if (typeof state === 'object' && state !== null) {
      const collapsed = (state as Record<string, unknown>).collapsedRegions;
      if (Array.isArray(collapsed)) return collapsed;
    }
  }
  return Array.isArray(vs.folds) ? vs.folds : [];
}

/**
 * 从 Monaco `saveViewState()` 的产物 + 当时的滚动读数抽取可序列化子集。
 * 只按形状取值（cursorState[].modelState.selection + 折叠 memento），零类型依赖；
 * 取不到任何合法选区 → null（宁可这次不落盘，不存坏数据）；折叠缺失/损坏 → folds: []。
 */
export function extractViewSlice(viewState: unknown, scrollTop: number, scrollLeft: number): ViewSlice | null {
  if (typeof viewState !== 'object' || viewState === null) return null;
  const cursorState = (viewState as { cursorState?: unknown }).cursorState;
  const selections: SerializedRange[] = [];
  if (Array.isArray(cursorState)) {
    for (const item of cursorState) {
      const s = rangeFromCursorStateEntry(item);
      if (!s) continue;
      selections.push(s);
      if (selections.length >= MAX_SELECTIONS) break;
    }
  }
  if (selections.length === 0) return null;
  return {
    selections,
    scrollTop: nonNegative(scrollTop),
    scrollLeft: nonNegative(scrollLeft),
    folds: sanitizeFolds(foldRangesFromViewState(viewState)),
  };
}

/**
 * 钳进到当前文件几何（文件可能变短；调用方拿到的一定是合法行列、合法折叠）。
 * 折叠的钳法：两端钳进 [1, lineCount]，钳完不足两行（或起点已越过文件尾）⇒ 丢掉该条；
 * 位置被钳过的折叠丢弃 checksum（旧校验和对应的是旧几何，留着只会让 Monaco 误跳过）。
 */
export function clampSlice(slice: ViewSlice, lineCount: number, maxColumnOf: (line: number) => number): ViewSlice {
  const cl = Math.max(1, Math.trunc(lineCount) || 1);
  const clampLine = (n: number): number => Math.min(Math.max(1, n), cl);
  const selections = slice.selections.map((r) => {
    const sl = clampLine(r.startLineNumber);
    const el = clampLine(r.endLineNumber);
    return {
      startLineNumber: sl,
      startColumn: Math.min(Math.max(1, r.startColumn), Math.max(1, Math.trunc(maxColumnOf(sl)) || 1)),
      endLineNumber: el,
      endColumn: Math.min(Math.max(1, r.endColumn), Math.max(1, Math.trunc(maxColumnOf(el)) || 1)),
    };
  });
  const folds: SerializedFold[] = [];
  const seen = new Set<string>();
  for (const f of sanitizeFolds(slice.folds)) {
    const sl = clampLine(f.startLineNumber);
    const el = clampLine(f.endLineNumber);
    if (sl >= el) continue; // 文件变短后折不满两行：丢这一条，绝不抛
    const key = `${sl}:${el}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const moved = sl !== f.startLineNumber || el !== f.endLineNumber;
    const out: SerializedFold = { startLineNumber: sl, endLineNumber: el };
    if (f.type !== undefined) out.type = f.type;
    if (f.isCollapsed !== undefined) out.isCollapsed = f.isCollapsed;
    if (f.source !== undefined) out.source = f.source;
    if (!moved && f.checksum !== undefined) out.checksum = f.checksum;
    folds.push(out);
  }
  return { selections, scrollTop: slice.scrollTop, scrollLeft: slice.scrollLeft, folds };
}

// cache 的失效判据 = localStorage 引用变了（测试替换替身 / 环境切换都自动重读）
let cache: Map<string, ViewSlice> | null = null;
let cacheSource: unknown = undefined;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** LRU 条目上限：Map 头部 = 最久未用 */
function trimEntries(m: Map<string, ViewSlice>): void {
  while (m.size > MAX_ENTRIES) {
    const first = m.keys().next();
    if (first.done) break;
    m.delete(first.value);
  }
}

/** 全库折叠总预算：超了从最久未用（Map 头部）的条目起整条清空 folds，光标/滚动原样保留 */
function enforceFoldBudget(m: Map<string, ViewSlice>): void {
  let total = 0;
  for (const s of m.values()) total += s.folds?.length ?? 0;
  if (total <= MAX_TOTAL_FOLDS) return;
  for (const [k, s] of m) {
    if (total <= MAX_TOTAL_FOLDS) break;
    const n = s.folds?.length ?? 0;
    if (n === 0) continue;
    total -= n;
    m.set(k, { ...s, folds: [] });
  }
}

function loadCache(): Map<string, ViewSlice> {
  const source = globalThis.localStorage;
  if (cache && cacheSource === source) return cache;
  const m = new Map<string, ViewSlice>();
  try {
    const raw = source?.getItem(STORE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      const env = parsed as { v?: unknown; entries?: unknown } | null;
      if (env && env.v === SCHEMA_VERSION && env.entries && typeof env.entries === 'object') {
        for (const [k, v] of Object.entries(env.entries)) {
          const s = sanitizeSlice(v);
          if (s) m.set(k, s);
        }
      }
    }
  } catch {
    m.clear(); // 整库损坏：静默清空回退，下次 flush 以干净数据覆写
  }
  trimEntries(m);
  enforceFoldBudget(m);
  cache = m;
  cacheSource = source;
  return m;
}

/** 读（LRU touch：命中即刷到"最近使用"端） */
export function getViewState(root: string, file: string): ViewSlice | null {
  const m = loadCache();
  const k = viewStateKey(root, file);
  const v = m.get(k);
  if (!v) return null;
  m.delete(k);
  m.set(k, v);
  return v;
}

/** 写（进 LRU 尾端 + 超限淘汰 + 折叠预算 + 防抖落盘；非法 slice 静默丢弃） */
export function setViewState(root: string, file: string, slice: ViewSlice): void {
  const s = sanitizeSlice(slice);
  if (!s) return;
  const m = loadCache();
  const k = viewStateKey(root, file);
  m.delete(k);
  m.set(k, s);
  trimEntries(m);
  enforceFoldBudget(m);
  if (flushTimer === null) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushViewStates();
    }, FLUSH_DEBOUNCE_MS);
  }
}

/** 立即落盘并取消在途防抖（beforeunload / 卸载钩子用；localStorage 不可用则易失不阻塞） */
export function flushViewStates(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const m = loadCache();
  enforceFoldBudget(m); // 外部若直接改过 cache 里的 slice，落盘前再兜一次体积闸
  try {
    const env: PersistedEnvelope = { v: SCHEMA_VERSION, entries: Object.fromEntries(m) };
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(env));
  } catch {
    // 隐私模式 / 配额满：本会话视图状态退化为易失，绝不影响编辑
  }
}

/** 清理：不传 root = 整库；传 root = 只清该项目（root 归一化同键口径） */
export function clearViewStates(root?: string): void {
  const m = loadCache();
  if (root === undefined) {
    m.clear();
  } else {
    const prefix = `${pathKey(root)}\u0000`;
    for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k);
  }
  flushViewStates();
}
