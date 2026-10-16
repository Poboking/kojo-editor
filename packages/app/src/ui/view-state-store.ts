import { pathKey } from '@kojo/plugin-api';

/**
 * 编辑器视图状态的跨会话持久层：localStorage、版本化键、LRU 上限、损坏即整库清洗。
 * 纯逻辑零 React 零 Monaco——Monaco 视图状态在这里只是 `unknown`，抽取/钳制是纯函数，可单测。
 * 与布局同族（layout.ts 的"版本化 key + 清洗"路子），独立成库：键按 项目根+文件绝对路径 组合。
 */

const STORE_KEY = 'kojo.viewState.v1';
const SCHEMA_VERSION = 1;
export const MAX_ENTRIES = 300;
export const FLUSH_DEBOUNCE_MS = 600;
const MAX_SELECTIONS = 64;

export interface SerializedRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** IEditorViewState 的可序列化子集：光标/选区 + 滚动（自 pick，不盲存整对象） */
export interface ViewSlice {
  selections: SerializedRange[];
  scrollTop: number;
  scrollLeft: number;
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
  return { selections, scrollTop: nonNegative(r.scrollTop), scrollLeft: nonNegative(r.scrollLeft) };
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

/**
 * 从 Monaco `saveViewState()` 的产物 + 当时的滚动读数抽取可序列化子集。
 * 只按形状取值（cursorState[].modelState.selection），零类型依赖；
 * 取不到任何合法选区 → null（宁可这次不落盘，不存坏数据）。
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
  return { selections, scrollTop: nonNegative(scrollTop), scrollLeft: nonNegative(scrollLeft) };
}

/** 钳进到当前文件几何（文件可能变短；调用方拿到的一定是合法行列） */
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
  return { selections, scrollTop: slice.scrollTop, scrollLeft: slice.scrollLeft };
}

// cache 的失效判据 = localStorage 引用变了（测试替换替身 / 环境切换都自动重读）
let cache: Map<string, ViewSlice> | null = null;
let cacheSource: unknown = undefined;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

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
  while (m.size > MAX_ENTRIES) {
    const first = m.keys().next();
    if (first.done) break;
    m.delete(first.value);
  }
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

/** 写（进 LRU 尾端 + 超限淘汰 + 防抖落盘；非法 slice 静默丢弃） */
export function setViewState(root: string, file: string, slice: ViewSlice): void {
  const s = sanitizeSlice(slice);
  if (!s) return;
  const m = loadCache();
  const k = viewStateKey(root, file);
  m.delete(k);
  m.set(k, s);
  while (m.size > MAX_ENTRIES) {
    const first = m.keys().next();
    if (first.done) break;
    m.delete(first.value);
  }
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
