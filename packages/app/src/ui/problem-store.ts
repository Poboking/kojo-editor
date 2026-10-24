/**
 * 编辑器「问题」汇总（壳层私有，2026-10-14 看板 HK-4 · UI-6）。
 *
 * 为什么单独成文件（不写在 ProblemPanel 里）：这是**数据判据**，不是渲染细节。
 * 上线前 `erb-parser`（结构类，error）与 `condition-extractor`（表达式类，warning）
 * 两层波浪线**只画在 Monaco 里**，没有可展开的列表——本模块把两层的 `LineDecoration`
 * 汇总成一份可订阅的注册表，再抽成纯函数才能被单测钉住（与 §5.105 把布局 reducer
 * 搬到 `layout.ts`、把通知淘汰规则放进 `notice-queue.ts` 同一做法）。
 *
 * 键 = 文件路径，值 = **按 origin 分簇的两份整档结果**（`open-file` / `project-scan`）。
 * 编辑器那一簇的唯一计算点在 `EditorPane.refreshMarkers`，那里逐文件整份重发、标签关闭即清
 * ——避免切走的文件留下「幽灵诊断」；整项目那一簇由 `project-diagnostics.ts` 的采集器写，
 * **只认自己的清账入口**（`clearProblems` / `clearAllProblems` 碰不到它，见下面 mutator 段）。
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

/**
 * 一条诊断是**从哪一簇**上账的（工包「缺腿」2026-10-20）。
 *
 * - `open-file`：编辑器里那份 model 的实时波浪线（`EditorPane` 的 marker publish 写）；
 * - `project-scan`：整项目采集器从**盘上内容**算出来的（见 `project-diagnostics.ts`）。
 *
 * 为什么要这一维：清账的时机是按"文件"来的（关标签、编辑器卸载），而上账的时机有两套
 * 完全不同的生命周期。**没有 origin 就没有分簇**——关一个标签会把同一份文件的整项目结论
 * 顺手抹掉，"关了就没"这个老毛病只换个地方复发。
 */
export type ProblemOrigin = 'open-file' | 'project-scan';

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
  /**
   * 这一条来自哪一簇（additive，缺省按 `open-file` 处理）。
   *
   * 由 store 在**上账时**盖章，消费方不自己填也不猜——写它的地方就是拥有这条真相的地方。
   * `summarizeProblems` 靠它把两簇分开数（`countsByOrigin`），状态栏的范围标签靠它说得出
   * "此刻屏幕上到底有几种来源"。既有消费方读不到这个字段也照常工作（旧形状零改动）。
   */
  origin?: ProblemOrigin;
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
 *
 * 值一律取 CSS 变量而不是裸 hex（视觉批十二 · BOARD `VIS-CONTRAST`）：这张表是内联到 DOM 上的，
 * 写死 hex 就等于绕开主题——真壳浅色档实测 `#d19a66` 压 `#eaeef2` 只有 **2.11:1**（正文需 4.5），
 * 而 `--warning` 在浅色档早已翻成沉着的 `#8a5a04`（5.08:1）。三档的颜色真源只在
 * `tokens.css` + `themes/*.css`，这里只点名角色。错误档点的是 `--danger-text`——
 * `--danger` (#e06c75) 压在最浅的 `--bg-3` 面上只有 4.11，正文级破线（批十二补的名单条）。
 */
export const SEVERITY_TINT: Record<EditorProblem['severity'], string> = {
  error: 'var(--danger-text)',
  warning: 'var(--warning)',
  info: 'var(--info)',
};

/**
 * 这份注册表的**范围真相**，含上屏标签（工包 E 判据①：标签与计数同源同口径）。
 *
 * 注册表现在有**两簇**（origin）：编辑器实时那一簇、整项目扫描那一簇。标签必须说得出
 * 屏幕上**实际混了几种**，两种谎都不许说：
 * ① 只有编辑器那一簇时仍写「已打开」——这时"不含未打开文件"是真的（原文由
 *    `tests/shell-info-design.test.ts` 逐字钉住，改口径要连它一起改）；
 * ② 扫描那一簇进了账，就**不许**再冒充"只有已打开文件"，也不许反过来冒充
 *    "整个项目都扫过了"——`PROBLEM_SCOPE` 因此不是常量而是**读数**：扫描没跑完、
 *    只覆盖部分目录、跑到批量上限就停、有文件读炸被跳过，都必须从这句话里看得出来（铁律 4）。
 */

/** 只有编辑器那一簇时的原文（唯一真源；静态闸钉的就是这一行） */
const OPEN_ONLY_SCOPE = {
  label: '已打开',
  title:
    '已打开文件的波浪线合并值（各诊断贡献方合并；不含未打开文件与整项目结论 ≠ 项目级约定计数）· 问题面板 (Ctrl+Shift+M)',
} as const;

/** 扫描那一簇的口径词：`complete` 之外一律不肯说"已扫描" */
function scanPhrase(c: ProjectScanCoverage): string {
  if (c.status === 'running') return '扫描中';
  if (c.status === 'complete' && !c.capped) return '已扫描';
  return '部分扫描';
}

/** 扫描那一簇的诚实细节：覆盖了几分之几、哪些目录、哪些没算进去 */
function scanDetail(c: ProjectScanCoverage): string {
  const bits: string[] = [];
  bits.push(c.total > 0 ? `覆盖 ${c.scanned}/${c.total} 个文件` : `已处理 ${c.scanned} 个文件`);
  bits.push(
    c.roots.length === 0
      ? '目录未声明'
      : c.roots.length <= 3
        ? `目录 ${c.roots.join('、')}`
        : `目录 ${c.roots.slice(0, 3).join('、')} 等 ${c.roots.length} 处`,
  );
  if (c.capped) bits.push(`到批量上限即停（${c.scanned} 个）`);
  if (c.status === 'cancelled') bits.push('已取消');
  if (c.status === 'failed') bits.push('本轮整体失败');
  if (c.skipped > 0) bits.push(`${c.skipped} 个文件读不动已跳过`);
  if (c.degraded > 0) bits.push(`${c.degraded} 个文件的某路诊断方抛错已跳过`);
  if (c.outOfRoots > 0) bits.push(`${c.outOfRoots} 个越界路径已拒读`);
  if (rescanQueue.size > 0) bits.push(`${rescanQueue.size} 个文件关标签后待复核`);
  if (rescanDropped > 0) bits.push(`${rescanDropped} 次复核已让给下一轮整扫`);
  return bits.join(' · ');
}

/** 合并态那两句话（两簇混在一处计数 ⇒ 只能这么写） */
function mergedScope(): { label: string; title: string } {
  const c = coverage;
  const phrase = scanPhrase(c);
  const label = openVisible > 0 && scanVisible > 0 ? `已打开+${phrase}` : phrase;
  return {
    label,
    title:
      `${label}两簇合并值（编辑器实时取内存、整项目取盘上；同一文件只出示一簇，不翻倍）` +
      ` · ${scanDetail(c)} · 未扫到的文件不参与计数 ≠ 项目级约定计数 · 问题面板 (Ctrl+Shift+M)`,
  };
}

/**
 * 可见标签 + tooltip。取**读数**：`scanVisible === 0` 时屏幕上根本没有扫描那一簇
 * （要么没扫过，要么扫过的文件全都开着、由更权威的实时簇压住），此时仍说「已打开」。
 */
export const PROBLEM_SCOPE: { readonly label: string; readonly title: string } = {
  get label(): string {
    return scanVisible === 0 ? OPEN_ONLY_SCOPE.label : mergedScope().label;
  },
  get title(): string {
    return scanVisible === 0 ? OPEN_ONLY_SCOPE.title : mergedScope().title;
  },
};

/**
 * 整项目那一簇的**覆盖读数**（由采集器写，见 `project-diagnostics.ts`）。
 *
 * 为什么放在 store 而不是只留在采集器里：范围标签住在 store，标签要诚实就必须读得到
 * "这轮跑到哪了、什么没算进去"——否则合并后的那句话就只会宣称"已扫描"，那是新造的假真相。
 */
export type ProjectScanStatus = 'idle' | 'running' | 'complete' | 'partial' | 'cancelled' | 'failed';

export interface ProjectScanCoverage {
  readonly status: ProjectScanStatus;
  /** 这轮实际允许读的根（**说了才能核对**：只覆盖部分目录时必须看得出来） */
  readonly roots: readonly string[];
  /** 本轮已处理的文件数 */
  readonly scanned: number;
  /** 本轮计划处理的文件数（0 = 未知） */
  readonly total: number;
  /** 读盘/解码抛错被跳过的文件（可见降级，不是"安静地少几个"） */
  readonly skipped: number;
  /** 某路诊断贡献方抛错的文件数（该文件其余路仍算，少一路是事实） */
  readonly degraded: number;
  /** 越界（不在允许根内）被拒读的路径数 */
  readonly outOfRoots: number;
  /** 关标签后等待复核的文件数（盘上内容可能已变） */
  readonly pendingRescan: number;
  /** 撞到批量上限 ⇒ 覆盖不完整 */
  readonly capped: boolean;
}

export const IDLE_SCAN_COVERAGE: ProjectScanCoverage = {
  status: 'idle',
  roots: [],
  scanned: 0,
  total: 0,
  skipped: 0,
  degraded: 0,
  outOfRoots: 0,
  pendingRescan: 0,
  capped: false,
};

let coverage: ProjectScanCoverage = IDLE_SCAN_COVERAGE;

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

/**
 * 模块级注册表：path → **按 origin 分的两份整档结果**（整份替换语义，不做增量）。
 *
 * `open`（编辑器实时，取内存）与 `scan`（整项目，取盘上）**谁也不覆盖谁**：
 * 同一文件两簇并存时对外只出示 `open`（它是同一份文档更新的真相），`scan` 留在账上，
 * 等标签关掉再回到台前。于是"关标签顺手抹掉项目级结论"这条老路被堵死，
 * 而"文件开着却同时数两遍同一个问题"这条新路也没开。
 */
interface ClusterPair {
  open?: EditorProblem[];
  scan?: EditorProblem[];
}

const registry = new Map<string, ClusterPair>();
const listeners = new Set<() => void>();

/** 关标签排进来的待复核路径（盘上内容可能已变；由采集器取用，`takeRescanPaths`） */
const rescanQueue = new Set<string>();
/** 队列上界：复核跟不上时宁可少排几个，也不能让队列无界长大（少排的都还会被整轮扫描覆盖） */
const RESCAN_QUEUE_MAX = 512;
/** 队满之后被让掉的复核次数（**让掉也要说得出**，不然"待复核"这个数就成了假账） */
let rescanDropped = 0;

/** 记一次复核（同一文件只记一次；越界那部分折成 `rescanDropped`，不静默丢弃） */
function noteRescan(path: string): void {
  if (rescanQueue.has(path)) return;
  if (rescanQueue.size >= RESCAN_QUEUE_MAX) {
    rescanDropped++;
    return;
  }
  rescanQueue.add(path);
}

/** 对外出示的那一簇（`open` 存在即权威，**含"打开且零问题"的空数组**——它压住旧扫描） */
function visibleOf(c: ClusterPair | undefined): readonly EditorProblem[] | undefined {
  if (c === undefined) return undefined;
  return c.open !== undefined ? c.open : c.scan;
}

/** 这一格对屏幕贡献了几条哪一簇（标签口径用；0/1 两态，逐格 O(1)） */
function tallyOf(c: ClusterPair | undefined): readonly [number, number] {
  const list = visibleOf(c);
  if (list === undefined || list.length === 0) return [0, 0];
  return c!.open !== undefined ? [1, 0] : [0, 1];
}

let openVisible = 0;
let scanVisible = 0;

const samePair = (a: ClusterPair | undefined, b: ClusterPair | undefined): boolean =>
  (a === undefined || b === undefined)
    ? a === undefined && b === undefined
    : a.open === b.open && a.scan === b.scan;

const slotKey = (origin: ProblemOrigin): keyof ClusterPair => (origin === 'open-file' ? 'open' : 'scan');

/**
 * 唯一的写入口：盖章 origin、维护两簇计数、空簇回收；**返回"内容真的变了没有"**。
 *
 * `items === null` = 撤销这一簇（`clearProblems` / 卸载那一族走法）。
 * 空数组按 origin 分两种语义，都被旧行为包着：编辑器那一簇给空 = 这一份文件干净，
 * 有扫描账在场时留一个 `open: []` 的**压制标记**（不然刚发布"干净"的文件会立刻把
 * 旧的扫描结论顶上台面，凭空多几条红线）；扫描那一簇给空 = 没东西可上账，直接销账。
 * 两边都没账时保持**完全不产生变更**（`tests/problem-store.test.ts` 钉的"空数组删不存在的键不通知"）。
 *
 * 拆成"改 + 报变更"两拍是因为批量清账（卸载 / 换项目）必须**一次通知**：逐格 notify
 * 会让每个订阅方在同一个动作里重算 N 遍，等于给一次卸载配了 N 次渲染。
 */
function applyCluster(path: string, origin: ProblemOrigin, items: readonly EditorProblem[] | null): boolean {
  const prev = registry.get(path);
  const before = tallyOf(prev);
  const next: ClusterPair = prev === undefined ? {} : { ...prev };
  const key = slotKey(origin);
  if (items === null) {
    delete next[key];
    if (origin === 'open-file') delete next.open; // 连带撤掉"打开且干净"的压制标记
  } else if (items.length === 0) {
    if (origin === 'open-file' && next.scan !== undefined) next.open = [];
    else delete next[key];
  } else {
    next[key] = items.map((it) => ({ ...it, origin }));
  }
  if (next.open === undefined && next.scan === undefined) registry.delete(path);
  else registry.set(path, next);
  const after = tallyOf(registry.get(path));
  if (after[0] !== before[0]) openVisible += after[0] - before[0];
  if (after[1] !== before[1]) scanVisible += after[1] - before[1];
  return !samePair(prev, registry.get(path));
}

function writeCluster(path: string, origin: ProblemOrigin, items: readonly EditorProblem[] | null): void {
  if (applyCluster(path, origin, items)) notify();
}

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

/** 整份替换某文件**编辑器那一簇**的诊断；空数组即撤销该簇（旧签名零改动） */
export function setProblems(path: string, items: readonly EditorProblem[]): void {
  writeCluster(path, 'open-file', items);
}

/** 整份替换某文件**整项目扫描那一簇**的诊断（additive：与 `setProblems` 平行、互不清账） */
export function setProjectScanProblems(path: string, items: readonly EditorProblem[]): void {
  writeCluster(path, 'project-scan', items);
}

/**
 * 关掉标签 / 卸载某文件：**只清编辑器那一簇**（工包「缺腿」判据①）。
 *
 * 顺带把这条路径记进待复核队列——它的内存结论已经作废，而账上那份扫描结果对应的是
 * **扫它那一刻的盘上内容**；文件在编辑器里被保存过就可能已经变了，所以要么复核要么让它
 * 自然退场。扫描还没跑过（`idle`，= 改动前的世界）时一律不记，旧行为逐字不变。
 */
export function clearProblems(path: string): void {
  if (coverage.status !== 'idle') noteRescan(path);
  const prev = registry.get(path);
  if (prev === undefined || prev.open === undefined) return;
  writeCluster(path, 'open-file', null);
}

/** 编辑器整体卸载：**只清编辑器那一簇**，项目级结论留在账上（这才叫"项目级"）；一次通知 */
export function clearAllProblems(): void {
  const paths = [...registry.keys()].filter((p) => registry.get(p)!.open !== undefined);
  if (coverage.status !== 'idle') for (const p of paths) noteRescan(p);
  // 一格编辑簇都没有 ⇒ 内容没变（只剩扫描账），按旧口径不惊动订阅方
  if (paths.length === 0) return;
  let changed = false;
  for (const p of paths) changed = applyCluster(p, 'open-file', null) || changed;
  if (changed) notify();
}

/** 撤销**全部**扫描那一簇（切换 / 关闭项目时调；编辑器那一簇零改动）；一次通知 */
export function clearProjectScan(): void {
  const paths = [...registry.keys()].filter((p) => registry.get(p)!.scan !== undefined);
  rescanQueue.clear();
  rescanDropped = 0;
  if (paths.length === 0) return;
  let changed = false;
  for (const p of paths) changed = applyCluster(p, 'project-scan', null) || changed;
  if (changed) notify();
}

/**
 * 扁平化 + 排序后的只读快照（**脏时重算，干净时返回同一引用**——同一版本内幂等，
 * 这是 `useSyncExternalStore` 形态的消费方不无限重渲的前提；见 `currentVersion`）。
 *
 * 每格只出**当前对外的那一簇** ⇒ 同一文件的两簇并存时天然不翻倍。
 */
export function snapshot(): readonly EditorProblem[] {
  if (!dirty) return cached;
  const out: EditorProblem[] = [];
  for (const c of registry.values()) {
    const list = visibleOf(c);
    if (list !== undefined) out.push(...list);
  }
  cached = sortProblems(out);
  dirty = false;
  return cached;
}

/* ---------------- 扫描覆盖读数（标签要说得出"扫到哪了、什么没算进去"） ---------------- */

/** 当前覆盖读数（`idle` = 这条腿还没接上；采集器每批更新一次） */
export function projectScanCoverage(): ProjectScanCoverage {
  return coverage;
}

const sameCoverage = (a: ProjectScanCoverage, b: ProjectScanCoverage): boolean =>
  a.status === b.status &&
  a.scanned === b.scanned &&
  a.total === b.total &&
  a.skipped === b.skipped &&
  a.degraded === b.degraded &&
  a.outOfRoots === b.outOfRoots &&
  a.pendingRescan === b.pendingRescan &&
  a.capped === b.capped &&
  a.roots.join('\u0001') === b.roots.join('\u0001');

/** 写入覆盖读数；**逐字段比对后**只在真变了时通知（每批一次的写入不该炸渲染） */
export function setProjectScanCoverage(next: ProjectScanCoverage): void {
  if (sameCoverage(coverage, next)) return;
  coverage = next;
  notify();
}

/** 扫描那一簇在账的文件数（标签与回报用它核对"说了几份就是几份"） */
export function projectScanFileCount(): number {
  let n = 0;
  for (const c of registry.values()) if (c.scan !== undefined && c.scan.length > 0) n++;
  return n;
}

/** 待复核路径（只读快照，不排空） */
export function rescanPendingPaths(): readonly string[] {
  return [...rescanQueue];
}

/** 待复核数量（采集器把它抄进覆盖读数；只读数、不动队列） */
export function rescanPendingCount(): number {
  return rescanQueue.size;
}

/** 排空式取用（采集器复核那一轮的唯一入口；`limit` 之后留给下一轮） */
export function takeRescanPaths(limit = 64): string[] {
  const out: string[] = [];
  for (const p of rescanQueue) {
    if (out.length >= limit) break;
    out.push(p);
  }
  for (const p of out) rescanQueue.delete(p);
  return out;
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
  /**
   * 按 origin 分簇的三档计数（additive，工包「缺腿」：合并数之外还要说得出"其中几来自扫描"）。
   *
   * 为什么不让消费方自己去数 origin：那正是"三处三个口径"的复发形态。这里数一次，
   * 谁要分簇读数谁来拿。**缺 `origin` 的入参按 `open-file` 记账**（旧调用零改动、旧数字零变化）。
   */
  readonly countsByOrigin: Readonly<Record<ProblemOrigin, ProblemCounts>>;
}

const EMPTY_SUMMARY_VALUE: ProblemSummary = {
  counts: { error: 0, warning: 0, info: 0 },
  files: [],
  byPath: new Map<string, ProblemFileCounts>(),
  byKey: new Map<string, ProblemFileCounts>(),
  countsByOrigin: {
    'open-file': { error: 0, warning: 0, info: 0 },
    'project-scan': { error: 0, warning: 0, info: 0 },
  },
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
  interface MutableCounts {
    error: number;
    warning: number;
    info: number;
  }
  const counts: MutableCounts = { error: 0, warning: 0, info: 0 };
  const byOrigin: Record<ProblemOrigin, MutableCounts> = {
    'open-file': { error: 0, warning: 0, info: 0 },
    'project-scan': { error: 0, warning: 0, info: 0 },
  };
  const files: MutableFileCounts[] = [];
  const byPath = new Map<string, MutableFileCounts>();
  for (const it of items) {
    counts[it.severity]++;
    byOrigin[it.origin ?? 'open-file'][it.severity]++;
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
  const built: ProblemSummary = { counts, files, byPath, byKey, countsByOrigin: byOrigin };
  summaryCache.set(items, built);
  return built;
}

