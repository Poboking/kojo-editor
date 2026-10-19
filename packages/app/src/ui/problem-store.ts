/**
 * 编辑器「问题」汇总（壳层私有，2026-10-14 看板 HK-4 · UI-6）。
 *
 * 为什么单独成文件（不写在 ProblemPanel 里）：这是**数据判据**，不是渲染细节。
 * 上线前 `erb-parser`（结构类，error）与 `condition-extractor`（表达式类，warning）
 * 两层波浪线**只画在 Monaco 里**，没有可展开的列表——本模块把两层的 `LineDecoration`
 * 汇总成一份可订阅的注册表，再抽成纯函数才能被单测钉住（与 §5.105 把布局 reducer
 * 搬到 `layout.ts`、把通知淘汰规则放进 `notice-queue.ts` 同一做法）。
 *
 * 键 = 文件路径。装饰器的唯一计算点在 `EditorPane.refreshMarkers`，那里逐文件整份重发；
 * 标签关闭 / 卸载即清键——避免切走的文件留下「幽灵诊断」。
 *
 * **本文件同时是诊断计数的唯一派生处**（工包 E，2026-10-19：「三处三个口径」收成一个真相）：
 * 面板表头、面板组头、状态栏那颗、文件树徽标一律读 `summarizeProblems`，连状态栏的
 * **可见范围标签**（`PROBLEM_SCOPE`）也从这里出——标签与计数分家过一次（旧标签写「本文件」、
 * 数的却是全部已打开文件的合并值），把两样东西放进同一个数据模块才不会再分叉。
 */

import type { KernelEventMap } from '@kojo/plugin-api';
import { pkey } from './file-tree-ops';

/** 落点区间（契约 `editor.revealLocation.span` 反推；面板不自立形状） */
export type ProblemSpan = NonNullable<KernelEventMap['editor.revealLocation']['span']>;

export interface EditorProblem {
  /** 文件路径（原样保留，跳源行与分组都靠它） */
  path: string;
  /** 1 基行号 */
  line: number;
  /**
   * 波浪线盖住的**列区间**（1 基、UTF-16 码元、终点不含）——W9 落点 span 批补上的一环：
   * 装饰器本来就带 `startColumn` / `endColumn`，此前汇总到面板时被整条丢掉，
   * 于是"点问题跳过去落在行首、同一个位置按 F12 落在名字那一列"。
   * 缺席 = 这一条只有行级信息（退化判据唯一，住在 `monaco/reveal-position.ts`，面板不许自算）。
   */
  span?: ProblemSpan;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** 可选诊断码（工具提示 / 过滤用；游戏无关的稳定标识） */
  code?: string;
  /**
   * 诊断码的**可读来源标签**（additive，DIAG-LINK 2026-10-18）：`LineDecoration.source`
   * 原样带到面板行——多来源发布后，同一个 `code` 可能住在几条流水线上，面板要说得出
   * "这条是谁报的"，而 `code` 是稳定标识、不许带来源限定词（改名即断链）。
   * 缺省 = 旧行为（面板只显示 `code`）。
   */
  source?: string;
}

/** 严重度排序权重（error 最靠前；越小越先出） */
const SEVERITY_RANK: Record<EditorProblem['severity'], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * 严重度 → 上屏配色（**唯一一份**）：面板行圆点、面板表头、面板组头、状态栏、文件树徽标
 * 全读这张表。颜色也是口径的一部分——两处各定一色，迟早长成"同一档两种红"。
 */
export const SEVERITY_TINT: Record<EditorProblem['severity'], string> = {
  error: '#e06c75',
  warning: '#d19a66',
  info: '#7f9cc0',
};

/**
 * 这份注册表的**范围真相**，含上屏标签（工包 E 判据①：标签与计数同源同口径）。
 *
 * 注册表的键只在文件被编辑器打开时才上账（`EditorPane` 的 marker publish 写、关标签清），
 * 所以这里数的一律是「已打开文件的合并值」——旧标签写「本文件」是假的（活动文件换了、
 * 其余标签的诊断照样留在计数里）。状态栏那颗要么改成按活动文件计数（需要宿主把活动路径
 * 送进来，本批禁区），要么让标签承认口径；这里选后者，且标签文本只有一个真源。
 */
export const PROBLEM_SCOPE = {
  /** 状态栏可见标签（`.sb-scope-tag`）；与同排那枚「项目」标签对举 */
  label: '已打开',
  /**
   * 同一颗的 tooltip。`不含未打开文件与整项目结论 ≠ 项目级约定计数` 这一段是
   * `tests/shell-info-design.test.ts` 钉住的口径原文，不许顺手改写。
   */
  title:
    '已打开文件的波浪线合并值（各诊断贡献方合并；不含未打开文件与整项目结论 ≠ 项目级约定计数）· 问题面板 (Ctrl+Shift+M)',
} as const;

/**
 * 扁平列表的排序口径（导出供单测钉死）：
 * severity（error > warning > info）→ path 升序 → line 升序。
 *
 * 不修改入参（返回新数组）——React state 依赖引用不变性。
 */
export function sortProblems(items: readonly EditorProblem[]): EditorProblem[] {
  return [...items].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });
}

/** 模块级注册表：path → 该文件的全部问题（整份替换语义，不做增量） */
const registry = new Map<string, EditorProblem[]>();
const listeners = new Set<() => void>();

/**
 * 版本号 + 脏标记（PS-15）：`notify` 只置脏加版本，`snapshot` 只在**脏时**重算——
 * 同一版本内多次 `snapshot()` 返回**同一引用**（订阅回调 / 渲染 / 计数三方都来问时
 * 扁平化 + 排序只算一次），干净时零分配零排序。`version()` 供消费方做 memo 依赖
 * （数字比较，不持有数组引用也能知道"变没变"）。
 */
let version = 0;
let dirty = true;
let cached: readonly EditorProblem[] = [];

function notify(): void {
  dirty = true;
  version++;
  for (const l of listeners) l();
}

/** 当前版本号（每次实际变更 +1；消费方做 cheap 比较用） */
export function currentVersion(): number {
  return version;
}

/** 整份替换某文件的诊断；空数组即删除该键（该文件已无问题） */
export function setProblems(path: string, items: readonly EditorProblem[]): void {
  if (items.length === 0) {
    if (registry.delete(path)) notify();
    return;
  }
  registry.set(path, [...items]);
  notify();
}

/** 清掉某文件的诊断（标签关闭 / 卸载时调，防残留） */
export function clearProblems(path: string): void {
  if (registry.delete(path)) notify();
}

/** 清空全部（编辑器整体卸载时调） */
export function clearAllProblems(): void {
  if (registry.size === 0) return;
  registry.clear();
  notify();
}

/**
 * 扁平化 + 排序后的只读快照（**脏时重算，干净时返回同一引用**——同一版本内幂等，
 * 这是 `useSyncExternalStore` 形态的消费方不无限重渲的前提；见 `currentVersion`）。
 */
export function snapshot(): readonly EditorProblem[] {
  if (!dirty) return cached;
  const out: EditorProblem[] = [];
  for (const items of registry.values()) out.push(...items);
  cached = sortProblems(out);
  dirty = false;
  return cached;
}

/** 订阅变更（变更即通知）；返回退订函数 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/* ---------------- 诊断计数的唯一派生（面板 / 状态栏 / 文件树共用） ---------------- */

/** 三档计数（`info` 也数——面板表头要给人看；文件树只取错误/警告两档，见 `FileTree`） */
export interface ProblemCounts {
  readonly error: number;
  readonly warning: number;
  readonly info: number;
}

/** 单个文件的计数；`path` = 注册表里的原始写法（跳源与分组都按它） */
export interface ProblemFileCounts extends ProblemCounts {
  readonly path: string;
}

export interface ProblemSummary {
  readonly counts: ProblemCounts;
  /** 有诊断的文件（序 = 入参里该文件首次出现的序，即 `snapshot()` 口径下的严重级序） */
  readonly files: readonly ProblemFileCounts[];
  /** 原始路径 → 该文件计数（问题面板的组头用它：键与 `groupProblems` 逐字同形） */
  readonly byPath: ReadonlyMap<string, ProblemFileCounts>;
  /**
   * 归一路径（`pkey`）→ 该文件计数。
   *
   * 文件树的行路径来自磁盘列举，与注册表键可能差个分隔符方向 / 盘符与扩展名大小写
   * （Windows 两种写法是同一个文件）。让消费方各自归一 = 两处各定一把尺，所以归一
   * 在这一条派生里做完；同键的多种写法计数**合并**（同一个文件不该被数成两份）。
   */
  readonly byKey: ReadonlyMap<string, ProblemFileCounts>;
}

const EMPTY_SUMMARY_VALUE: ProblemSummary = {
  counts: { error: 0, warning: 0, info: 0 },
  files: [],
  byPath: new Map<string, ProblemFileCounts>(),
  byKey: new Map<string, ProblemFileCounts>(),
};

/** 空表常量（订阅方在无诊断时拿到**同一引用**，不每帧新造一份空对象） */
export const EMPTY_PROBLEM_SUMMARY: ProblemSummary = EMPTY_SUMMARY_VALUE;

/** 入参数组身份 → 派生结果（数组不可变 ⇒ 身份即内容；随入参退场一起回收） */
const summaryCache = new WeakMap<readonly EditorProblem[], ProblemSummary>();

/**
 * 一份诊断序列 → 全局计数 + 按文件计数（**纯函数**，面板分组、状态栏、文件树徽标共用）。
 *
 * 为什么由它而不是由 `groupProblems` 出组头数字：`groupProblems` 自己也在数三档，
 * 两处各数一套就是"三处三个口径"的复发形态。这里数一次，面板拿 `byPath` 填组头，
 * 树拿 `byKey` 填徽标，状态栏拿 `counts` 填那颗——同一次遍历的同一份结果。
 */
export function summarizeProblems(items: readonly EditorProblem[]): ProblemSummary {
  if (items.length === 0) return EMPTY_PROBLEM_SUMMARY;
  const hit = summaryCache.get(items);
  if (hit !== undefined) return hit;

  interface MutableFileCounts {
    path: string;
    error: number;
    warning: number;
    info: number;
  }
  const counts = { error: 0, warning: 0, info: 0 };
  const files: MutableFileCounts[] = [];
  const byPath = new Map<string, MutableFileCounts>();
  for (const it of items) {
    counts[it.severity]++;
    let f = byPath.get(it.path);
    if (f === undefined) {
      f = { path: it.path, error: 0, warning: 0, info: 0 };
      byPath.set(it.path, f);
      files.push(f);
    }
    f[it.severity]++;
  }
  const byKey = new Map<string, ProblemFileCounts>();
  for (const f of files) {
    const key = pkey(f.path);
    const merged = byKey.get(key);
    byKey.set(
      key,
      merged === undefined
        ? f
        : {
            path: merged.path,
            error: merged.error + f.error,
            warning: merged.warning + f.warning,
            info: merged.info + f.info,
          },
    );
  }
  const built: ProblemSummary = { counts, files, byPath, byKey };
  summaryCache.set(items, built);
  return built;
}

