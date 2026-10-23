/**
 * 问题面板的**纯逻辑层**（批次十 S14，2026-10-23）——过滤 / 分组 / 计数 / 稳定排序 /
 * 过滤条件持久化，全部是不碰 React、不碰 Monaco、不碰 IPC 的纯函数（node 可直接单测）。
 *
 * 为什么从 `problem-fix` 里再分一层：`problem-fix` 管的是"这一条能不能修、怎么修"
 * （候选筛选 + 改写计划），本模块管的是"这一屏该画哪些、按什么序、各数几条"。
 * 两件事的判据各自被单测钉住，面板只负责把结果画出来。分组 / 过滤的语义与
 * `problem-fix` 既有实现保持一致（组序 = 过滤后序列首次出现序），S14 在其上补了
 * **来源过滤**与**稳定排序**（同键条目保持入参原序）。
 *
 * 文本过滤是**字面子串**，不是正则：作者输 `M_KOJO`、`缺 else`、`erb.1001` 都按
 * 原样找；`.*`、`(` 这类字符不被当成模式（问题面板是检索框，不是正则控制台）。
 */

import { shortPath } from '@kojo/plugin-api';
import type { EditorProblem } from './problem-store';

/* ══════════════════════════ ① 过滤（严重级 + 来源 + 文本子串） ══════════════════════════ */

export type ProblemSeverity = EditorProblem['severity'];

/**
 * 契约里只有三档严重级（`EditorProblem.severity`，无 hint——装饰器与面板的既定形状，
 * 不为不存在的档留过滤位：给一个永远数 0 的开关就是撒谎）。
 */
export const ALL_SEVERITIES: readonly ProblemSeverity[] = ['error', 'warning', 'info'];

/** 未标注来源的键（`source` 缺席的诊断归到这一档；上屏文案由面板给） */
export const UNLABELED_SOURCE = '';

/** 一条问题在"来源"这一维上的键：有 `source` 用原样，没有归到 `UNLABELED_SOURCE` */
export function problemSourceKey(problem: Pick<EditorProblem, 'source'>): string {
  return problem.source ?? UNLABELED_SOURCE;
}

/** 过滤判据：严重级多选 + 来源多选（`null` = 全部来源）+ 文本子串（空串 = 不过滤文本） */
export interface ProblemFilter {
  readonly severities: ReadonlySet<ProblemSeverity>;
  /** `null` = 不按来源筛（不是空集合：空集合 = 一条都不留） */
  readonly sources: ReadonlySet<string> | null;
  readonly text: string;
}

/**
 * 纯过滤（不改入参顺序，返回新数组）：
 * - 严重级不在选中集合 ⇒ 丢；
 * - 来源集合非 `null` 且本条来源不在其中 ⇒ 丢；
 * - 文本非空时按**不区分大小写的字面子串**匹配 `message` / `code` / `source` / `path`
 *   ——作者拿它找"报错里带某某词的""ERB1001 这一族"或"某个文件里的"，四样都是
 *   屏幕上的可见信息；只认 message 会漏掉按码 / 按来源 / 按文件找的那几半。
 *   `includes` 而非 `RegExp`：`.*`、`(`、`[` 一律按字符本身对待（正则无）。
 *
 * 中文没有大小写，`toLowerCase` 只负责拉丁字母那半边（`ELSE` / `else` 同一条路）。
 */
export function filterProblems(
  items: readonly EditorProblem[],
  filter: ProblemFilter,
): EditorProblem[] {
  const needle = filter.text.trim().toLowerCase();
  return items.filter((it) => {
    if (!filter.severities.has(it.severity)) return false;
    if (filter.sources !== null && !filter.sources.has(problemSourceKey(it))) return false;
    if (needle.length === 0) return true;
    return (
      it.message.toLowerCase().includes(needle) ||
      (it.code !== undefined && it.code.toLowerCase().includes(needle)) ||
      (it.source !== undefined && it.source.toLowerCase().includes(needle)) ||
      it.path.toLowerCase().includes(needle)
    );
  });
}

/** 当前过滤条件是否真的在筛东西（全开 + 全部来源 + 空文本 = 旧口径，不显示"筛出"） */
export function isFiltering(filter: Pick<ProblemFilter, 'severities' | 'sources' | 'text'>): boolean {
  return (
    filter.text.trim() !== '' ||
    filter.severities.size !== ALL_SEVERITIES.length ||
    filter.sources !== null
  );
}

/* ══════════════════════════ ② 来源清单（过滤下拉的选项 + 计数） ══════════════════════════ */

export interface ProblemSourceOption {
  /** 过滤用的键（= `source` 原样，或缺省时的 `UNLABELED_SOURCE`） */
  readonly key: string;
  /** 上屏短名（`source` 原样；缺省来源给中文占位） */
  readonly label: string;
  /** 该来源下的问题条数 */
  readonly count: number;
}

/**
 * 从当前问题序列里折出**来源清单**（序 = 首次出现序，计数 = 条数）。
 *
 * 与 `groupProblems` 同一条做法：选项不另按字典序排——面板上一屏两套排序会让
 * 作者的下拉记忆失效；首次出现序跟着 `snapshot()` 的严重级序走，谁报得多谁靠前。
 */
export function sourceOptions(items: readonly EditorProblem[]): ProblemSourceOption[] {
  const out: ProblemSourceOption[] = [];
  const byKey = new Map<string, { key: string; label: string; count: number }>();
  for (const it of items) {
    const key = problemSourceKey(it);
    let hit = byKey.get(key);
    if (hit === undefined) {
      hit = { key, label: it.source ?? '未标注来源', count: 0 };
      byKey.set(key, hit);
      out.push(hit);
    }
    hit.count++;
  }
  return out;
}

/* ══════════════════════════ ③ 计数（全局 + 每组） ══════════════════════════ */

export interface ProblemCounts {
  readonly error: number;
  readonly warning: number;
  readonly info: number;
  /** 三档之和（"共 N 条"用） */
  readonly total: number;
}

/** 三档计数 + 总数（纯函数；组头 / 表头 / 筛出提示都从这里取同一份读数） */
export function countProblems(items: readonly EditorProblem[]): ProblemCounts {
  let error = 0;
  let warning = 0;
  let info = 0;
  for (const it of items) {
    if (it.severity === 'error') error++;
    else if (it.severity === 'warning') warning++;
    else info++;
  }
  return { error, warning, info, total: error + warning + info };
}

/* ══════════════════════════ ④ 稳定排序 ══════════════════════════ */

/** 严重度排序权重（error 最靠前；越小越先出） */
const SEVERITY_RANK: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * 稳定排序（纯函数，不改入参）：severity（error > warning > info）→ path 升序 →
 * line 升序；**键全相等时保持入参原序**（显式带原下标，不赌运行时的排序实现——
 * 同一文件同一行上的多条诊断，换一次引擎版本就悄悄换序是作者最难察觉的那种回归）。
 */
export function sortProblemList(items: readonly EditorProblem[]): EditorProblem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const bySeverity = SEVERITY_RANK[a.item.severity] - SEVERITY_RANK[b.item.severity];
      if (bySeverity !== 0) return bySeverity;
      if (a.item.path !== b.item.path) return a.item.path < b.item.path ? -1 : 1;
      if (a.item.line !== b.item.line) return a.item.line - b.item.line;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

/* ══════════════════════════ ⑤ 按文件分组 ══════════════════════════ */

export interface ProblemGroupCounts {
  readonly error: number;
  readonly warning: number;
  readonly info: number;
}

export interface ProblemGroup {
  /** 完整路径（折叠判据 / 跳源用的都是它） */
  readonly path: string;
  /** 组头显示的短路径（`shortPath` 口径，与检索面板同源） */
  readonly label: string;
  /** 组内问题（保持过滤后序列的原顺序） */
  readonly items: EditorProblem[];
  /**
   * 组内每条问题在**过滤后全序**里的下标（与 `items` 一一同序）。
   * 渲染窗口按全局条目裁剪时用它判"这一条进没进窗"——同一路径的多个严重级段
   * 收进一组后，组内条目在全局序列里不保证连续。
   */
  readonly indices: readonly number[];
  readonly counts: ProblemGroupCounts;
  /** 组内第一条在过滤后全序里的下标 */
  readonly startIndex: number;
}

/**
 * 分组（纯函数）：键 = 完整路径；组序 = **在过滤后序列里的首次出现序**。
 *
 * 组序跟着首次出现走而不是另按路径字典序：扁平列表的既有口径是
 * `sortProblemList`（severity → path → line），分组只是把同一段折叠起来看——
 * "错误最多的文件排最前"这一语义不因分组而变；另立一把字典序尺子等于
 * 同一屏两套排序，作者折叠/展开时行序会跳。
 */
export function groupProblems(items: readonly EditorProblem[]): ProblemGroup[] {
  // 组装期用可变形状（push / 计数累加），出组前冻成 `ProblemGroup` 的只读视图
  interface MutableGroup {
    path: string;
    label: string;
    items: EditorProblem[];
    indices: number[];
    counts: { error: number; warning: number; info: number };
    startIndex: number;
  }
  const groups: MutableGroup[] = [];
  const byPath = new Map<string, MutableGroup>();
  items.forEach((it, index) => {
    let group = byPath.get(it.path);
    if (group === undefined) {
      group = {
        path: it.path,
        // 组头短路径与检索面板/行内定位同一条 `shortPath`（单一真源，不抄第二份）
        label: shortPath(it.path),
        items: [],
        indices: [],
        counts: { error: 0, warning: 0, info: 0 },
        startIndex: index,
      };
      byPath.set(it.path, group);
      groups.push(group);
    }
    group.items.push(it);
    group.indices.push(index);
    if (it.severity === 'error') group.counts.error++;
    else if (it.severity === 'warning') group.counts.warning++;
    else group.counts.info++;
  });
  return groups;
}

/* ══════════════════════════ ⑥ 过滤条件持久化 ══════════════════════════ */

/**
 * 面板过滤条件的**壳层私有**持久化（WebView localStorage，`kojo.ui.problemFilter.v1`）。
 *
 * 纪律与 `panel-prefs.ts` / `direct-mode.ts` 同款：无 `window`（测试 / 非浏览器）/
 * 隐私模式 / 坏值 → 一律回默认、**绝不抛**；不做模块级缓存（读 localStorage 是幂等投影）。
 *
 * 只记**选择**（严重级、来源、文本），不记窗口深度与折叠：后者随本轮会话走，
 * 下次打开时"从第一屏看起"才是可预期的。
 */
export interface ProblemFilterPrefs {
  readonly severities: readonly ProblemSeverity[];
  /** `null` = 全部来源；`UNLABELED_SOURCE` 表示"只看未标注来源的" */
  readonly source: string | null;
  readonly text: string;
}

/** 缺省 = 不过滤（与改动前的面板逐字一致） */
export const DEFAULT_PROBLEM_FILTER: ProblemFilterPrefs = {
  severities: ALL_SEVERITIES,
  source: null,
  text: '',
};

const FILTER_PREF_KEY = 'kojo.ui.problemFilter.v1';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 严重级数组归一：只留契约里的三档、去重、按固定序（坏值 → 全开） */
function normalizeSeverities(raw: unknown): readonly ProblemSeverity[] {
  if (!Array.isArray(raw)) return ALL_SEVERITIES;
  const picked = ALL_SEVERITIES.filter((s) => raw.includes(s));
  // 空数组是作者"一档都不看"的真实选择，照存；只有**形状不对**才回默认
  return picked;
}

/** 读过滤条件（缺省 / 坏值 / 读不到 → `DEFAULT_PROBLEM_FILTER`） */
export function loadProblemFilterPrefs(): ProblemFilterPrefs {
  const s = storage();
  if (!s) return DEFAULT_PROBLEM_FILTER;
  try {
    const raw = s.getItem(FILTER_PREF_KEY);
    if (raw === null) return DEFAULT_PROBLEM_FILTER;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PROBLEM_FILTER;
    const obj = parsed as { severities?: unknown; source?: unknown; text?: unknown };
    return {
      severities: normalizeSeverities(obj.severities),
      source: typeof obj.source === 'string' ? obj.source : null,
      text: typeof obj.text === 'string' ? obj.text : '',
    };
  } catch {
    // 手改坏的 JSON / 隐私模式读不到 ⇒ 回默认（脏数据的失败方向必须保守）
    return DEFAULT_PROBLEM_FILTER;
  }
}

/** 写过滤条件；写不进去静默降级（只影响下次启动，不影响本次会话） */
export function saveProblemFilterPrefs(prefs: ProblemFilterPrefs): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(
      FILTER_PREF_KEY,
      JSON.stringify({ severities: prefs.severities, source: prefs.source, text: prefs.text }),
    );
  } catch {
    /* 静默降级为"本次会话有效" */
  }
}

/** 面板态 → 纯过滤判据（`source` 单值在判据里折成单元素集合；`null` 原样保留） */
export function filterOfPrefs(prefs: ProblemFilterPrefs): ProblemFilter {
  return {
    severities: new Set(prefs.severities),
    sources: prefs.source === null ? null : new Set([prefs.source]),
    text: prefs.text,
  };
}
