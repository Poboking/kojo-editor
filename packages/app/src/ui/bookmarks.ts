/**
 * 文档内书签（1026 编辑器体感 C 批）的**纯逻辑真源**：每个文件一枚行号集合。
 *
 * 零 React、零 Monaco import（单测在 node 里直接打）——装饰层（`editor-pane/use-bookmarks.ts`）
 * 与命令层（`ShellLayout` 的 `bookmarks.*`）都只在这上面做接线，判据一律住这里。
 *
 * ## 口径
 *
 * - **行号 1 基**，与全仓行号口径一致；集合**升序去重**（同一行两个书签没有意义，
 *   而 Monaco 装饰、next/prev 都按单调序工作）。
 * - **书签是「行号锚」**（不是内容锚）：编辑后按 Monaco 的 change 事件**平移**——
 *   变更区间在书签行之下 ⇒ 不动；在其之上 ⇒ 整段平移；书签行**落在被编辑区间内** ⇒
 *   钉到变更起点（`startLine`）。取舍写在这里，可测判据见 {@link shiftBookmarkLines}：
 *   内容锚（记住那一行的文本、编辑后按文本找回）在口上文本里极易张冠李戴（同一句台词
 *   满篇都是），行锚的代价是"在某行上方插入内容后书签留在原行"——这正是作者改稿时
 *   想要的（书签标的是"这一行还要看"），不是缺陷。
 * - 持久化走 **localStorage**（照 `keybindings.ts` / `editor-display-prefs.ts` 惯例）：
 *   坏数据回缺省、读不到不抛、写不进也留在内存活到本会话结束——**绝不抛进编辑器链路**。
 * - 键按 `pathKey` 归一（Windows 大小写/分隔符折叠，与全仓路径判等同尺）：`C:\a\B.erb`
 *   与 `c:/A/b.erb` 是同一份书签。
 */

import { pathKey } from '@kojo/plugin-api';

/** 持久化键（localStorage；与 `kojo.ui.*.v1` 同一套命名） */
export const BOOKMARKS_STORAGE_KEY = 'kojo.ui.bookmarks.v1';

/**
 * 装饰类名（**单源**；`ui/bookmark-gutter.css` 与装饰层都照这里取值——
 * CSS 里手抄一份字面量就等于把改名时机漏在样式表里）。
 */
export const BOOKMARK_GLYPH_CLASS = 'kojo-bookmark-glyph';
export const BOOKMARK_LINE_CLASS = 'kojo-bookmark-line';

/**
 * 一次内容变更的**行锚视图**（Monaco `IModelContentChange` 的投影，刻意不带 Monaco 类型——
 * 两侧各自把 `range` / `text` 折成这三元组，本模块就永远不需要 import Monaco）。
 *
 * - `startLine` / `endLine`：被替换区间的起止行（旧坐标，1 基，含两端）；
 * - `lineDelta`：替换后该区间的行数 − 原区间行数（插入 = 正、删除 = 负、行内编辑 = 0）。
 */
export interface BookmarkChange {
  readonly startLine: number;
  readonly endLine: number;
  readonly lineDelta: number;
}

/** 数据面（导出只为测试与诊断；改动一律走上面的函数） */
type BookmarkStore = Map<string, number[]>;

let store: BookmarkStore = loadStore();
let version = 0;
const listeners = new Set<() => void>();

/** 行号是否合法（正整数；`NaN` / 小数 / 0 / 负数一律拒绝——坏数据不许进集合） */
function isValidLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** 去重 + 升序（集合的唯一形态；所有出口都经这一道） */
function normalizeLines(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * 路径 → 存储键；`null` = 这个路径不构成一份文档（空串）。
 *
 * 必须显式判空串：`pathKey('')` 归一成 `'.'`（`normalize` 对空串的约定），
 * 不拦的话「没有文件」会被当成一个叫 `.` 的文件收进存储。
 */
function storeKeyOf(path: string): string | null {
  if (typeof path !== 'string' || path === '') return null;
  const key = pathKey(path);
  return key === '' ? null : key;
}

/** 两个已排序集合是否逐元素相等（判断"这次变更有没有真的动到书签"，动没动决定要不要广播） */
function sameLines(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 盘上任意形态 → 干净存储（**绝不抛**）。
 *
 * 过滤非对象 / 非数组行集 / 非法行号；键**再走一次 `pathKey`** 归一（手改过的盘上
 * 键可能是原始写法，而查询一律按归一键）：同一归一键的多条取并集，不丢任何一枚书签。
 */
export function sanitizeBookmarks(raw: unknown): BookmarkStore {
  const out: BookmarkStore = new Map();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || key === '') continue;
    if (!Array.isArray(value)) continue;
    const lines = normalizeLines(value.filter(isValidLine));
    if (lines.length === 0) continue;
    const norm = pathKey(key);
    if (norm === '') continue;
    const prior = out.get(norm);
    out.set(norm, prior === undefined ? lines : normalizeLines([...prior, ...lines]));
  }
  return out;
}

function loadStore(): BookmarkStore {
  try {
    if (typeof localStorage === 'undefined') return new Map();
    const raw = localStorage.getItem(BOOKMARKS_STORAGE_KEY);
    if (!raw) return new Map();
    return sanitizeBookmarks(JSON.parse(raw));
  } catch {
    // 坏 JSON / 存储不可读：回空表——书签丢了可以重加，启动炸了不行
    return new Map();
  }
}

function persist(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(Object.fromEntries(store)));
    }
  } catch {
    // 存储不可写（隐私模式等）：改动仍在内存里活到本会话结束，功能不因此坏掉
  }
}

function bump(): void {
  version++;
  for (const cb of [...listeners]) cb();
}

/** 订阅书签变化（装饰层据此重铺；返回退订函数） */
export function subscribeBookmarks(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前版本号（测试与诊断读数用） */
export function bookmarksVersion(): number {
  return version;
}

/* ---------------------------- 查询 ---------------------------- */

/** 某个文件的书签行（**升序**，返回副本：调用方拿到的数组怎么改都动不了真源） */
export function bookmarkLinesOf(path: string): readonly number[] {
  const key = storeKeyOf(path);
  if (key === null) return [];
  const lines = store.get(key);
  return lines === undefined ? [] : [...lines];
}

/** 这一行是不是书签 */
export function hasBookmark(path: string, line: number): boolean {
  const key = storeKeyOf(path);
  if (key === null) return false;
  const lines = store.get(key);
  return lines !== undefined && lines.includes(line);
}

/** 某个文件的书签数 */
export function bookmarkCountOf(path: string): number {
  const key = storeKeyOf(path);
  return key === null ? 0 : (store.get(key)?.length ?? 0);
}

/** 有书签的文件数（读数用；不做书签列表，故不必暴露具体路径） */
export function bookmarkFileCount(): number {
  return store.size;
}

/* ---------------------------- 修改 ---------------------------- */

/**
 * 切换某一行的书签，返回**是否新增**（true = 加上了，false = 取消了；非法行号 / 空路径
 * 一律 no-op 返回 false，坏数据不进集合）。
 */
export function toggleBookmark(path: string, line: number): boolean {
  if (!isValidLine(line)) return false;
  const key = storeKeyOf(path);
  if (key === null) return false;
  const current = store.get(key) ?? [];
  const added = !current.includes(line);
  const next = added ? normalizeLines([...current, line]) : current.filter((value) => value !== line);
  if (next.length === 0) store.delete(key);
  else store.set(key, next);
  persist();
  bump();
  return added;
}

/** 清空某个文件的全部书签，返回被清掉的条数（0 = 本来就没有，不广播——一次无改动的点击不该让界面抖） */
export function clearFileBookmarks(path: string): number {
  const key = storeKeyOf(path);
  if (key === null) return 0;
  const current = store.get(key);
  if (current === undefined || current.length === 0) return 0;
  store.delete(key);
  persist();
  bump();
  return current.length;
}

/** 清空全部文件的全部书签，返回被清掉的条数（0 = 本来就是空的，不落盘不广播） */
export function clearAllBookmarks(): number {
  let count = 0;
  for (const lines of store.values()) count += lines.length;
  if (count === 0) return 0;
  store = new Map();
  persist();
  bump();
  return count;
}

/* ---------------------------- 书签间跳转（单调序列 + 回绕） ---------------------------- */

/**
 * 下一个书签行（严格大于 `fromLine` 的第一枚）；`fromLine` 之后没有 ⇒ **回绕**到第一枚。
 *
 * 为什么回绕而不是"到头就没反应"：书签集合是一圈（VSCode 书签扩展同口径）——作者连按
 * 到末尾再按一次得到"回到第一个"才是可预期的；停在末尾等于按下去屏上什么都不发生，
 * 正是铁律 4 要堵的静默。返回 `null` 只表示"这个文件根本没有书签"，命令侧据此出声。
 */
export function nextBookmark(path: string, fromLine: number): number | null {
  const key = storeKeyOf(path);
  const lines = key === null ? undefined : store.get(key);
  if (lines === undefined || lines.length === 0) return null;
  for (const line of lines) if (line > fromLine) return line;
  return lines[0]!;
}

/** 上一个书签行（严格小于 `fromLine` 的最后一枚）；之前没有 ⇒ **回绕**到最后一枚（理由同上） */
export function prevBookmark(path: string, fromLine: number): number | null {
  const key = storeKeyOf(path);
  const lines = key === null ? undefined : store.get(key);
  if (lines === undefined || lines.length === 0) return null;
  let candidate: number | null = null;
  for (const line of lines) if (line < fromLine) candidate = line;
  return candidate ?? lines[lines.length - 1]!;
}

/* ---------------------------- 行号漂移（本批最易出 bug 的点） ---------------------------- */

/**
 * 一次变更后的书签行号平移（**纯函数**；口径见模块头「书签是行号锚」）。
 *
 * - `line < startLine`：变更完全在书签**下方** ⇒ 不动；
 * - `line > endLine`：变更完全在书签**上方** ⇒ `line += lineDelta`（上插下删整段平移）；
 * - `startLine <= line <= endLine`：书签行**落在被编辑区间内** ⇒ 钉到 `startLine`
 *   （行内编辑不动它；整行被删则书签落到删除点，即"最接近的锚"，不静默消失）。
 *
 * `maxLine` 给得出（调用方传编辑后的模型行数）时把结果**夹取**到 `[1, maxLine]`：
 * 删除文档末尾那段时，钉在删除点的书签可能越过新末行——夹回来比丢掉一枚书签可预期。
 */
export function shiftBookmarkLines(
  lines: readonly number[],
  change: BookmarkChange,
  maxLine?: number,
): number[] {
  const start = Math.max(1, change.startLine);
  const end = Math.max(start, change.endLine);
  const out: number[] = [];
  for (const line of lines) {
    let next: number;
    if (line < start) next = line;
    else if (line > end) next = line + change.lineDelta;
    else next = start;
    if (next < 1) next = 1;
    if (maxLine !== undefined && next > maxLine) next = Math.max(1, maxLine);
    out.push(next);
  }
  return normalizeLines(out);
}

/**
 * 把一串变更折进某个文件的书签集合，返回**是否真的动了**（动了才落盘 + 广播）。
 *
 * 多个变更按 `startLine` **降序**逐个应用：Monaco 的变更都以**旧坐标**给出，从文档尾部
 * 往前折，后方变更带来的平移就不会污染前方变更的行号基准。文件本来没有书签 / 折完与
 * 原来一样 ⇒ 不落盘不广播（编辑热路径上"没书签的文件"零开销）。
 */
export function applyContentChanges(
  path: string,
  changes: readonly BookmarkChange[],
  maxLine?: number,
): boolean {
  const key = storeKeyOf(path);
  if (key === null) return false;
  const current = store.get(key);
  if (current === undefined || current.length === 0 || changes.length === 0) return false;
  let lines: number[] = current;
  const ordered = [...changes].sort((a, b) => b.startLine - a.startLine);
  for (const change of ordered) lines = shiftBookmarkLines(lines, change, maxLine);
  if (sameLines(lines, current)) return false;
  if (lines.length === 0) store.delete(key);
  else store.set(key, lines);
  persist();
  bump();
  return true;
}