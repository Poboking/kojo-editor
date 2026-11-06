/**
 * MCP 长任务面（Wave4 余项⑤「长任务 progress」· ADR-0013 P5「Tasks over MCP」，
 * 用户已于 2026-11-06 拍板开工）。
 *
 * ## 这一层只做一件事
 * 把**已经有诚实真源**的长操作建模成「可查询 / 可取消 / 有进度账」的任务，而不是让客户端
 * 只能发一次会撞 30s 请求超时的 `tools/call`。三件套缺任何一件 ⇒ 刻意不登记（铁律 4：
 * 真源不存在 ⇒ 不登记，绝不挂空串假实现）。
 *
 * ## 本批判性结论（逐条证据，全部实测自当前树）
 * **登记（三件套齐）**
 * - `kind:'search'` —— 进度真源 `src-tauri/src/lib.rs` 的 `SEARCH_PROGRESS_EVENT`
 *   （`kojo:search-progress`，载荷带 `searchId` / `filesScanned` / `totalFiles` /
 *   `matchCount`，按文件数与时间双条件节流）；取消真源 `cancel_search`（同一
 *   `SearchState.cancelled` 集合，检索线程逐文件读，按 `searchId` 精确认领）；
 *   可查询 = 本表持住的在途 promise 与终态返回值（**完成态以 `search_text` 返回值为唯一收口**，
 *   进度帧只作中途读数）。
 * - `kind:'validation'` —— 启动与终态真源 = 内核服务 `convention.linter` 的
 *   `run(opts)` / `report()`；取消真源 = `ConventionRunOptions.signal`（引擎只在文件单元
 *   间隙看这颗闸，掷点见 `convention-linter/src/engine.ts` 的 `makeCancelGate`）；
 *   **运行中没有逐单元进度回调** ⇒ 本面把 progress 显式标 `known:false` 并写明缺哪样，
 *   只有终态那一轮由引擎陈述 `incomplete{unitsDone,unitsTotal}`（事后读数，不冒充实时）。
 *
 * **刻意不登记（缺一件以上，逐条写明缺什么）**
 * - 索引构建（`erb.parser` / `buildIndex`）：可查询 ✓（`indexState()` 有 phase 与
 *   filesScanned），进度只有两个粗检查点（起扫 / walk 收口），**取消 ✗**（契约无取消位），
 *   且 `buildIndex(roots)` 会按调用方给的根集合**改写编辑器正在使用的同一份全局索引**
 *   ——那是 GUI 的导航真源，从 MCP 侧驱动等于拿只读面做写副作用。缺「取消」+ 副作用不可控 ⇒ 不登记。
 * - 导出（`export_file`）：落点由系统对话框显式选定（铁律 6 的法定通道，对话框与写盘绑在
 *   同一个 Rust 命令内），**无进度、无取消**，且任务参数绝不允许变成可选落点 ⇒ 不登记。
 * - 启动器任务表（`launcher_task_list` / `launcher_task_cancel`）：那一族**三件套齐全**
 *   （state / progress{done,total,unit,message} / cancellable），但它是启动器宿主自己的
 *   任务表，名字在端点按 `launcher_*` 判 privileged、授权走第三张表，与内核 writablePaths /
 *   exportFile 互不继承（铁律 7）。本批不并入，避免同一 URI 族出现两个主人；
 *   缺席事实在 `kojo://tasks` 的 `notIncluded[]` 里可见（不静默），并留账给主 agent 与启动器线合批。
 * - 内联只读检索（`workspace.searchAll` / `search.all`）：同一份 Rust 检索能力，但它是
 *   一次性请求-应答，客户端没有任务 id 可查可撤 ⇒ 不自动进任务表（避免"没人登记的任务"
 *   污染可查询面）。
 *
 * ## 生命周期与有界性（任务表不许无限增长）
 * - 表住在 WebView 模块作用域（与事件环形缓冲同一形态）：**页面重载即清空**，
 *   重载后查询旧 id 显式 `RESOURCE_UNAVAILABLE`（不空回帧）。
 * - 每会话在途上限 `TASK_MAX_RUNNING_PER_SESSION`；表行上限 `TASK_TABLE_MAX_ROWS`；
 *   已结束行保留 `TASK_RETENTION_MS`。回收是**惰性**的（每次入口先扫一遍），不留常驻定时器。
 * - 表满时先淘汰最旧的**已结束**行；一个都没淘汰得动 ⇒ 显式 `RESOURCE_UNAVAILABLE`，不排队不假装接受。
 * - 结果只在行内保留有界投影（`TASK_RESULT_HIT_CAP` / `TASK_FAILED_RULE_SAMPLE`），
 *   截断一律带 `truncated` 账。
 *
 * ## 进度口径（不许夸大）
 * - 首帧之前：`done/total` 一律 `null` + `phase:'waiting-first-frame'`——**绝不写 0**。
 * - 帧与帧之间：读数保持上一帧值并给出 `lastFrameAgeMs`，明说这是节流窗口内的旧值。
 * - `percent` 只在 total>0 时算，且带 `percentBasis` 说明分母口径；否则 `null`。
 *
 * ## 安全边界
 * - 零写盘：两种 kind 都不落项目目录（校验结果快照走内核既有 storage 命名空间，与面板
 *   「重新校验」同一条既有通道，本批不新建任何写口）；`roots` 一律由项目载荷投影
 *   （rootDir / kojoPaths），**不接受调用方给的绝对路径**。
 * - 会话隔离：行按 `sessionId + clientId` 记账，`status/cancel/list` 只见本会话的任务；
 *   不属本会话与不存在同形回 `RESOURCE_UNAVAILABLE`（不泄露他人任务的形状）。
 * - 取消是**请求**语义：Rust `cancel_search` 只置标记、终态才是事实；校验那轮若与 GUI
 *   在途轮合流（引擎的 `inFlight` 合流语义），本任务的取消位不起作用 ⇒ 终态用
 *   `cancelApplied:false` 如实陈述，绝不回一句「已取消」。
 */
import { McpFailure } from '@kojo/mcp-host';
import type { McpSessionScope } from '@kojo/mcp-host';
import {
  clampInt,
  nextSearchId,
  requireProject,
  rootDirOf,
  sanitizeEcho,
  searchRootsOf,
  toRelativePath,
  type McpKernelLike,
  type McpSearchRequestLike,
  type McpSearchResultLike,
  type McpTaskLegs,
} from './real-sources-io';

/* ------------------------------- 有界常量 ------------------------------- */

/** 每会话在途任务上限（超出即显式拒绝，不排队、不假装接受）。 */
export const TASK_MAX_RUNNING_PER_SESSION = 2;
/** 任务表行数上限（含在途；满了先淘汰最旧的已结束行）。 */
export const TASK_TABLE_MAX_ROWS = 32;
/** 已结束行的保留时长（毫秒）；到期由下一次入口惰性回收。 */
export const TASK_RETENTION_MS = 10 * 60 * 1000;
/** 终态检索结果在行内保留的命中条数上限（超出显式 truncated，不代表总数）。 */
export const TASK_RESULT_HIT_CAP = 200;
/** 单条检索任务允许请求的命中上限（送进 Rust 的那一档，超出即夹）。 */
export const TASK_SEARCH_MAX_RESULTS_LIMIT = 500;
/** 终态校验报告里 failedRules 的样本条数上限（条数另给，不把样本当全表）。 */
export const TASK_FAILED_RULE_SAMPLE = 20;
/** `kojo://tasks` 与 tasks.status 返回的行数上限。 */
export const TASK_LIST_ROW_CAP = 32;
/** 任务查询词回显上限（不把长串留在表里）。 */
const TASK_QUERY_ECHO_CHARS = 120;

/* ------------------------------- 形状 ------------------------------- */

export type McpTaskKind = 'search' | 'validation';
export type McpTaskStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

/** 与 Rust `SearchProgressPayload`（`kojo:search-progress`）同形的最窄投影。 */
export interface McpTaskSearchProgress {
  readonly searchId: number;
  readonly filesScanned: number;
  readonly totalFiles: number;
  readonly matchCount: number;
}

export type McpTaskSearchRunner = (
  request: McpSearchRequestLike,
  onProgress: (progress: McpTaskSearchProgress) => void,
) => Promise<McpSearchResultLike>;

/** 内核 `convention.linter` 服务的最窄投影（真 `ConventionLinterService` 结构满足）。 */
interface McpLinterLike {
  run?: (opts?: { force?: boolean; signal?: AbortSignal }) => Promise<unknown>;
  report?: () => unknown;
}

export interface McpTaskDeps {
  readonly getKernel: () => McpKernelLike | null;
  /** 带进度回调的检索腿（生产 = `bridge/search` 的 `searchInFiles`，测试给假件）。 */
  readonly search: McpTaskSearchRunner;
  /** 取消腿（生产 = `bridge/search` 的 `cancelSearch`）；缺席 ⇒ 取消显式 NOT_WIRED。 */
  readonly cancelSearch?: (searchId: number) => Promise<void>;
  /** 时钟（测试可注入固定值以验 TTL 与淘汰序）。 */
  readonly now?: () => number;
}

interface TaskRow {
  readonly taskId: string;
  readonly kind: McpTaskKind;
  readonly sessionId: string;
  readonly clientId: string;
  readonly createdAt: number;
  /** 检索类任务的壳层请求 id（取消与进度帧都按它认领）；校验类为 null。 */
  readonly searchId: number | null;
  /** 校验类任务自持的取消位；检索类为 null（取消走 `cancel_search`）。 */
  readonly controller: AbortController | null;
  /** 入参摘要（净化 + 限长；不把长串留在常驻表里）。 */
  readonly request: Record<string, unknown>;
  status: McpTaskStatus;
  endedAt: number | null;
  /** 运行中是否有真进度源（校验＝false，写明 reason；绝不用 0 冒充未知）。 */
  readonly progressKnown: boolean;
  readonly progressReason: string;
  done: number | null;
  total: number | null;
  unit: string | null;
  matchCount: number | null;
  frames: number;
  lastFrameAt: number | null;
  cancelRequested: boolean;
  /** null = 未请求取消 / 无从判定；true|false = 终态事实（合流时如实给 false）。 */
  cancelApplied: boolean | null;
  result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
}

/* ------------------------------- 常驻表（模块作用域） ------------------------------- */

let taskSeq = 0;
/** 页面内一次性随机前缀：任务 id 不可跨会话猜中（测试里恒为 local）。 */
const taskPageTag = newPageTag();
const taskRows = new Map<string, TaskRow>();

function newPageTag(): string {
  try {
    const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    const uuid = typeof cryptoObj?.randomUUID === 'function' ? cryptoObj.randomUUID() : '';
    const compact = uuid.replace(/-/g, '');
    if (/^[0-9a-f]{8,}$/.test(compact)) return compact.slice(0, 8);
  } catch {
    // 没有 WebCrypto（旧 WebView / 非安全上下文）⇒ 退回序号形态，可用性优先于隐蔽性
  }
  return 'local';
}

/**
 * 测试专用：清空常驻任务表与序号（表是模块作用域状态，跨用例必须可复位，否则
 * 行数上限 / TTL / 淘汰序的断言会被执行顺序污染）。与仓库既有 `reset*ForTest`
 * 家族同口径：生产代码不调，也不经任何 MCP 面暴露。
 */
export function resetMcpTaskTableForTest(): void {
  taskRows.clear();
  taskSeq = 0;
}

function nextTaskId(): string {
  taskSeq += 1;
  return `tsk-${taskPageTag}-${String(taskSeq)}`;
}

function isTerminal(status: McpTaskStatus): boolean {
  return status !== 'running';
}

function evictableRows(now: number): TaskRow[] {
  return [...taskRows.values()]
    .filter((r) => isTerminal(r.status) && r.endedAt !== null && now - r.endedAt >= TASK_RETENTION_MS)
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
}

/** 惰性回收：先按 TTL 清过期行，再按行数上限淘汰最旧的已结束行。不留定时器。 */
function collectExpired(now: number): void {
  for (const row of evictableRows(now)) taskRows.delete(row.taskId);
  while (taskRows.size > TASK_TABLE_MAX_ROWS) {
    const oldestFinished = [...taskRows.values()]
      .filter((r) => isTerminal(r.status))
      .sort((a, b) => (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt))[0];
    if (!oldestFinished) return; // 一个已结束行都没有 ⇒ 交给调用方显式拒绝（不偷偷挤掉在途任务）
    taskRows.delete(oldestFinished.taskId);
  }
}

function runningCountOf(sessionId: string): number {
  let n = 0;
  for (const row of taskRows.values()) if (row.sessionId === sessionId && row.status === 'running') n += 1;
  return n;
}

/* ------------------------------- 投影 ------------------------------- */

function percentOf(done: number | null, total: number | null): number | null {
  if (done === null || total === null || total <= 0) return null;
  return Math.min(100, Math.round((done / total) * 1000) / 10);
}

function progressView(row: TaskRow, now: number): Record<string, unknown> {
  const base: Record<string, unknown> = {
    known: row.progressKnown,
    unit: row.unit,
    done: row.done,
    total: row.total,
    frames: row.frames,
    lastFrameAt: row.lastFrameAt,
    lastFrameAgeMs: row.lastFrameAt === null ? null : Math.max(0, now - row.lastFrameAt),
    percent: percentOf(row.done, row.total),
  };
  if (!row.progressKnown) {
    // 没有实时进度源：把「不可知」写成事实，绝不给 0% / 空数组冒充
    base['phase'] = 'not-reported';
    base['reason'] = row.progressReason;
    return base;
  }
  if (row.frames === 0) {
    base['phase'] = 'waiting-first-frame';
    base['note'] = '壳层进度按节流上报，首帧之前没有任何读数（null 不是 0）。';
  } else {
    base['phase'] = row.status === 'running' ? 'reporting' : 'final-frame';
    base['note'] = '帧与帧之间读数保持上一帧值：lastFrameAgeMs 是这帧读数的年龄，不是 0%。';
  }
  if (row.matchCount !== null) base['matchCount'] = row.matchCount;
  return base;
}

function taskView(row: TaskRow, now: number, withResult: boolean): Record<string, unknown> {
  return {
    taskId: row.taskId,
    kind: row.kind,
    status: row.status,
    createdAt: row.createdAt,
    endedAt: row.endedAt,
    durationMs: row.endedAt === null ? null : Math.max(0, row.endedAt - row.createdAt),
    searchId: row.searchId,
    request: row.request,
    progress: progressView(row, now),
    cancelRequested: row.cancelRequested,
    cancelApplied: row.cancelApplied,
    ...(row.error !== null ? { error: row.error } : {}),
    ...(withResult ? { result: row.result } : { resultSummary: summaryOfResult(row) }),
  };
}

/** 列表态摘要：不整坨结果进列表，只给条数与截断账（有界性）。 */
function summaryOfResult(row: TaskRow): Record<string, unknown> | null {
  if (row.status === 'running') return null;
  const r = row.result;
  if (r === null) return null;
  const summary: Record<string, unknown> = {};
  if (typeof r['total'] === 'number') summary['total'] = r['total'];
  if (typeof r['truncated'] === 'boolean') summary['truncated'] = r['truncated'];
  if (typeof r['filesScanned'] === 'number') summary['filesScanned'] = r['filesScanned'];
  if (typeof r['issuesTotal'] === 'number') summary['issuesTotal'] = r['issuesTotal'];
  if (r['incomplete'] !== undefined) summary['incomplete'] = r['incomplete'];
  return summary;
}

/* ------------------------------- 判据与小件 ------------------------------- */

function requireTaskRow(taskIdRaw: unknown, scope: McpSessionScope): TaskRow {
  const taskId = typeof taskIdRaw === 'string' ? taskIdRaw.trim() : '';
  if (taskId === '' || taskId.length > 128) {
    throw new McpFailure('INVALID_ARGS', 'tasks 的 taskId 须为非空字符串（≤128 字符）');
  }
  const row = taskRows.get(taskId);
  // 「不存在 / 已被回收 / 属别的会话」三者同形：既显式（不空回帧）又不泄露他人任务形状。
  if (!row || row.sessionId !== scope.sessionId || row.clientId !== scope.clientId) {
    throw new McpFailure(
      'RESOURCE_UNAVAILABLE',
      `任务 ${sanitizeEcho(taskId)} 不在本会话的任务表内（不存在 / 已过保留期被回收 / 属其他会话；` +
        `页面重载会清空整表）。不静默、不空回帧——请重新 tasks.start。`,
    );
  }
  return row;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function kindOf(args: Record<string, unknown>): McpTaskKind {
  const kind = args['kind'];
  if (kind === 'search' || kind === undefined) return 'search';
  if (kind === 'validation') return 'validation';
  throw new McpFailure('INVALID_ARGS', `tasks.start 的 kind 须为 'search' | 'validation'：${sanitizeEcho(String(kind))}`);
}

/* ------------------------------- 终态投影 ------------------------------- */

function searchResultOf(result: McpSearchResultLike, rootDir: string): Record<string, unknown> {
  const hits: Record<string, unknown>[] = [];
  let scanned = 0;
  for (const file of result.files) {
    for (const match of file.matches) {
      scanned += 1;
      if (hits.length >= TASK_RESULT_HIT_CAP) continue; // 计数继续走，只是不再留条目（truncated 有账）
      const preview = typeof match.preview === 'string' ? match.preview.slice(0, 300) : '';
      hits.push({ path: toRelativePath(file.path, rootDir), line: match.line, preview });
    }
  }
  return {
    hits,
    total: result.totalMatches,
    // 三重截断合一：壳层自报 truncated（命中/单文件上限）+ 本面条目上限 + 总数与条目数之差
    truncated:
      result.truncated === true || scanned > hits.length || result.totalMatches > hits.length,
    hitsKept: hits.length,
    filesScanned: result.filesScanned,
    elapsedMs: result.elapsedMs,
    skipped: result.skipped,
    cancelled: result.cancelled === true,
  };
}

/** `ConventionReport` → 有界投影（只搬运引擎自己陈述的事实，不替它判形状）。 */
function validationReportOf(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    return { note: '校验服务返回的不是可辨认的报告对象（原样标注，不编造结论）', reportedType: raw === null ? 'null' : typeof raw };
  }
  const r = raw as Record<string, unknown>;
  const issues = Array.isArray(r['issues']) ? (r['issues'] as unknown[]) : [];
  const failedRules = Array.isArray(r['failedRules']) ? (r['failedRules'] as unknown[]) : [];
  const incomplete = r['incomplete'];
  const out: Record<string, unknown> = {
    issuesTotal: issues.length,
    counts: r['counts'] && typeof r['counts'] === 'object' ? r['counts'] : null,
    ruleCount: typeof r['ruleCount'] === 'number' ? r['ruleCount'] : null,
    durationMs: typeof r['durationMs'] === 'number' ? r['durationMs'] : null,
    failedRulesTotal: failedRules.length,
    failedRules: failedRules.slice(0, TASK_FAILED_RULE_SAMPLE).map((f) => {
      const o = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
      return { rule: asString(o['ruleId']), message: asString(o['error']).slice(0, 300) };
    }),
    truncated: failedRules.length > TASK_FAILED_RULE_SAMPLE,
  };
  if (incomplete && typeof incomplete === 'object') {
    const i = incomplete as Record<string, unknown>;
    out['incomplete'] = { unitsDone: typeof i['unitsDone'] === 'number' ? i['unitsDone'] : null, unitsTotal: typeof i['unitsTotal'] === 'number' ? i['unitsTotal'] : null };
    out['note'] = '这一轮被叫停：issues / counts 只覆盖已算完的那部分，没跑到的没有结论（≠ 没问题）。';
  }
  return out;
}

function failureOf(err: unknown): { code: string; message: string } {
  if (err instanceof McpFailure) return { code: err.code, message: err.message };
  return { code: 'TOOL_EXECUTION_FAILED', message: err instanceof Error ? err.message : String(err) };
}

/* ------------------------------- 两种 kind 的执行体 ------------------------------- */

function finishRow(row: TaskRow, status: McpTaskStatus, now: number): void {
  row.status = status;
  row.endedAt = now;
}

function runSearchTask(
  deps: McpTaskDeps,
  row: TaskRow,
  now: () => number,
  request: McpSearchRequestLike,
  rootDir: string,
): void {
  const searchId = request.searchId;
  let promise: Promise<McpSearchResultLike>;
  try {
    promise = Promise.resolve(deps.search(request, (p) => {
      // 帧按 searchId 认领：迟到/他人的帧不许改写本行读数（与壳层同一口径）
      if (p.searchId !== searchId) return;
      row.frames += 1;
      row.lastFrameAt = now();
      row.done = typeof p.filesScanned === 'number' ? p.filesScanned : row.done;
      row.total = typeof p.totalFiles === 'number' ? p.totalFiles : row.total;
      row.matchCount = typeof p.matchCount === 'number' ? p.matchCount : row.matchCount;
    }));
  } catch (err) {
    const t = now();
    row.error = failureOf(err);
    row.cancelApplied = row.cancelRequested ? false : null;
    finishRow(row, 'failed', t);
    return;
  }
  promise.then(
    (result) => {
      const t = now();
      const cancelled = result.cancelled === true;
      row.result = searchResultOf(result, rootDir);
      // 终态进度以收口返回值为准（完成态只有一个真源＝search_text 的返回值）
      if (typeof result.filesScanned === 'number') row.done = result.filesScanned;
      row.cancelApplied = row.cancelRequested ? cancelled : null;
      finishRow(row, cancelled ? 'cancelled' : 'succeeded', t);
    },
    (err: unknown) => {
      const t = now();
      row.error = failureOf(err);
      row.cancelApplied = row.cancelRequested ? false : null;
      finishRow(row, 'failed', t);
    },
  );
}

function runValidationTask(
  deps: McpTaskDeps,
  row: TaskRow,
  now: () => number,
  force: boolean,
): void {
  const kernel = deps.getKernel();
  const linter = kernel?.services.tryGet<McpLinterLike>('convention.linter');
  const controller = row.controller;
  let promise: Promise<unknown>;
  try {
    if (!linter || typeof linter.run !== 'function') {
      throw new McpFailure('NOT_WIRED', '校验任务未接线：内核未装配 convention.linter 服务或不提供 run（不静默）');
    }
    promise = Promise.resolve(linter.run({ force, ...(controller ? { signal: controller.signal } : {}) }));
  } catch (err) {
    const t = now();
    row.error = failureOf(err);
    row.cancelApplied = row.cancelRequested ? false : null;
    finishRow(row, 'failed', t);
    return;
  }
  promise.then(
    (report) => {
      const t = now();
      row.result = validationReportOf(report);
      const incomplete = row.result['incomplete'];
      const stopped = !!incomplete && typeof incomplete === 'object';
      if (stopped) {
        const i = incomplete as { unitsDone: number | null; unitsTotal: number | null };
        row.done = i.unitsDone;
        row.total = i.unitsTotal;
      }
      // 合流轮次（GUI 已起的那一轮）不归本任务的取消位管：终态没有 incomplete ⇒ 如实 false
      row.cancelApplied = row.cancelRequested ? stopped : null;
      finishRow(row, stopped ? 'cancelled' : 'succeeded', t);
    },
    (err: unknown) => {
      const t = now();
      row.error = failureOf(err);
      row.cancelApplied = row.cancelRequested ? false : null;
      finishRow(row, 'failed', t);
    },
  );
}

/* ------------------------------- 腿面（对外四枚） ------------------------------- */

/**
 * 任务腿面的装配点（表与投影都在本模块，`real-sources-io` 只做分派与缺席兜底）。
 * `deps.cancelSearch` 缺席 ⇒ 检索类任务的取消显式 NOT_WIRED（不假装已取消）。
 */
export function createMcpTaskLegs(deps: McpTaskDeps): McpTaskLegs {
  const now = deps.now ?? ((): number => Date.now());

  const start = async (args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown> => {
    const input = args ?? {};
    const kind = kindOf(input);
    collectExpired(now());
    const running = runningCountOf(scope.sessionId);
    if (running >= TASK_MAX_RUNNING_PER_SESSION) {
      throw new McpFailure(
        'RESOURCE_UNAVAILABLE',
        `本会话在途任务已达上限 ${TASK_MAX_RUNNING_PER_SESSION}（当前 ${running} 条在跑）：` +
          '先 tasks.status 看在跑的，或 tasks.cancel 一条再来。显式拒绝，不排队、不假装接受。',
      );
    }
    if (taskRows.size > TASK_TABLE_MAX_ROWS) {
      collectExpired(now());
      if (taskRows.size > TASK_TABLE_MAX_ROWS && evictableRows(now()).length === 0) {
        throw new McpFailure(
          'RESOURCE_UNAVAILABLE',
          `任务表已满（${taskRows.size} 行 / 上限 ${TASK_TABLE_MAX_ROWS}），且没有可回收的已结束行：显式拒绝新任务。`,
        );
      }
    }

    const taskId = nextTaskId();
    const created = now();
    const searchId = kind === 'search' ? nextSearchId() : null;

    let request: Record<string, unknown>;
    let row: TaskRow;
    if (kind === 'search') {
      const kernel = deps.getKernel();
      const project = requireProject(kernel); // 项目未开 ⇒ 当场显式失败，不留幽灵任务
      const rootDir = rootDirOf(project);
      if (rootDir === '') {
        throw new McpFailure('RESOURCE_UNAVAILABLE', '项目载荷缺 rootDir：检索任务无基准根（不静默）');
      }
      const query = input['query'];
      if (typeof query !== 'string' || query.length === 0) {
        throw new McpFailure('INVALID_ARGS', "tasks.start(kind:'search') 的 query 须为非空字符串");
      }
      if (query.length > 512) {
        throw new McpFailure('INVALID_ARGS', 'tasks.start(kind:\'search\') 的 query 长度须 ≤ 512');
      }
      const scopeArg = input['scope'];
      if (scopeArg !== undefined && scopeArg !== 'all' && scopeArg !== 'sources') {
        throw new McpFailure('INVALID_ARGS', `tasks.start 的 scope 须为 'all' | 'sources'：${sanitizeEcho(String(scopeArg))}`);
      }
      const maxResults = clampInt(input['maxResults'], TASK_RESULT_HIT_CAP, 1, TASK_SEARCH_MAX_RESULTS_LIMIT);
      const sourcesOnly = scopeArg === 'sources';
      const roots = searchRootsOf(project, rootDir, sourcesOnly);
      const kojoPaths = project['kojoPaths'];
      // 一次性检索沿用既有语义（sources 无目录时退回项目根）；任务面不这么做：
      // 一旦根集合与调用方要的不是同一件事，就显式拒绝，不建「已经在跑但注定扫 0 个文件 /
      // 扫了比要求更宽的根」的幽灵任务。
      const noSourceDirs = sourcesOnly && (!Array.isArray(kojoPaths) || kojoPaths.length === 0);
      if (roots.length === 0 || noSourceDirs) {
        throw new McpFailure(
          'RESOURCE_UNAVAILABLE',
          'scope:"sources" 下项目契约的 kojoPaths 没有任何合法目录：检索任务无根可扫' +
            '（不静默、不把范围悄悄放宽到项目根、也不返回空结果冒充「没命中」）',
        );
      }
      request = {
        query: query.length > TASK_QUERY_ECHO_CHARS ? `${query.slice(0, TASK_QUERY_ECHO_CHARS)}…` : query,
        scope: scopeArg === 'sources' ? 'sources' : 'all',
        maxResults,
        rootCount: roots.length,
      };
      row = {
        taskId,
        kind,
        sessionId: scope.sessionId,
        clientId: scope.clientId,
        createdAt: created,
        searchId,
        controller: null,
        request,
        status: 'running',
        endedAt: null,
        progressKnown: true,
        progressReason: '',
        done: null,
        total: null,
        unit: 'files',
        matchCount: null,
        frames: 0,
        lastFrameAt: null,
        cancelRequested: false,
        cancelApplied: null,
        result: null,
        error: null,
      };
      taskRows.set(taskId, row);
      const searchRequest: McpSearchRequestLike = {
        searchId: searchId ?? 0,
        roots,
        query,
        options: { isRegex: false, caseSensitive: false, wholeWord: false, extensions: [], maxResults },
      };
      runSearchTask(deps, row, now, searchRequest, rootDir);
      return taskView(row, now(), false);
    }

    // kind === 'validation'
    const force = input['force'] === true;
    if (input['force'] !== undefined && typeof input['force'] !== 'boolean') {
      throw new McpFailure('INVALID_ARGS', 'tasks.start(kind:\'validation\') 的 force 须为布尔值');
    }
    const kernel = deps.getKernel();
    const linter = kernel?.services.tryGet<McpLinterLike>('convention.linter');
    if (!linter || typeof linter.run !== 'function') {
      throw new McpFailure(
        'NOT_WIRED',
        '校验任务未接线：内核未装配 convention.linter 服务或不提供 run（不静默、不建无真源的排队）',
      );
    }
    request = { force };
    row = {
      taskId,
      kind,
      sessionId: scope.sessionId,
      clientId: scope.clientId,
      createdAt: created,
      searchId: null,
      controller: new AbortController(),
      request,
      status: 'running',
      endedAt: null,
      progressKnown: false,
      progressReason:
        '校验引擎不对外播报逐文件单元的实时进度：run 只在收尾那一轮陈述 incomplete{unitsDone,unitsTotal}，' +
        '中途没有任何可订阅的回调。此处 done/total 为 null 表示「不可知」，不是 0%，也不是「没在做」。',
      done: null,
      total: null,
      unit: 'file-units',
      matchCount: null,
      frames: 0,
      lastFrameAt: null,
      cancelRequested: false,
      cancelApplied: null,
      result: null,
      error: null,
    };
    taskRows.set(taskId, row);
    runValidationTask(deps, row, now, force);
    return taskView(row, now(), false);
  };

  const status = async (args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown> => {
    collectExpired(now());
    const row = requireTaskRow((args ?? {})['taskId'], scope);
    return taskView(row, now(), true);
  };

  const cancel = async (args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown> => {
    collectExpired(now());
    const row = requireTaskRow((args ?? {})['taskId'], scope);
    const t = now();
    if (isTerminal(row.status)) {
      // 终态取消是幂等（与启动器那张任务表同口径），不是错误：但也不谎称"取消了什么"
      return {
        taskId: row.taskId,
        kind: row.kind,
        status: row.status,
        cancelRequested: row.cancelRequested,
        cancelApplied: row.cancelApplied,
        alreadyFinished: true,
        note: '任务已是终态：取消请求无处可掷，幂等返回既有终态（不报错，也不谎称取消了什么）。',
      };
    }
    row.cancelRequested = true;
    if (row.kind === 'validation') {
      row.controller?.abort();
      return {
        taskId: row.taskId,
        kind: row.kind,
        status: row.status,
        cancelRequested: true,
        cancelApplied: null,
        note:
          '已置本任务的取消位：引擎只在文件单元的间隙看它，收尾后终态会给 cancelApplied 的真值。' +
          '若这一轮与界面在途的那轮合流（引擎的合流语义），本任务的取消位不起作用 ⇒ 终态如实报 cancelApplied:false。',
      };
    }
    if (row.searchId === null) {
      row.cancelApplied = false;
      throw new McpFailure('NOT_WIRED', '检索任务缺少壳层请求 id：取消无从认领（不静默）');
    }
    if (typeof deps.cancelSearch !== 'function') {
      throw new McpFailure(
        'NOT_WIRED',
        '检索取消腿未接线：宿主未注入 bridge/search 的 cancelSearch（不静默、不假装已取消）',
      );
    }
    try {
      await deps.cancelSearch(row.searchId);
    } catch (err) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `取消请求未能送达壳层（任务照旧在跑，终态不受影响）：${failureOf(err).message}`,
      );
    }
    return {
      taskId: row.taskId,
      kind: row.kind,
      status: row.status,
      searchId: row.searchId,
      cancelRequested: true,
      cancelApplied: null,
      note:
        '取消是请求语义：壳层只把这一条 searchId 记进取消集合，检索线程逐文件读到才提前收尾。' +
        '是否真的叫停以终态为准（status:cancelled + cancelApplied:true；抢先跑完则 cancelApplied:false）。',
      elapsedSinceStartMs: Math.max(0, t - row.createdAt),
    };
  };

  const list = async (scope: McpSessionScope): Promise<unknown> => {
    collectExpired(now());
    const t = now();
    const mine = [...taskRows.values()]
      .filter((r) => r.sessionId === scope.sessionId && r.clientId === scope.clientId)
      .sort((a, b) => b.createdAt - a.createdAt || b.taskId.localeCompare(a.taskId));
    const kept = mine.slice(0, TASK_LIST_ROW_CAP);
    return {
      tasks: kept.map((r) => taskView(r, t, false)),
      total: mine.length,
      truncated: mine.length > kept.length,
      scopeNote: '本表只含**当前编辑器页面**里由 tasks.start 登记、且属于本会话的任务；' +
        '页面重载即清空，已结束且超过保留期（10 分钟）的行会被回收，查它将显式 RESOURCE_UNAVAILABLE。',
      table: {
        maxRunningPerSession: TASK_MAX_RUNNING_PER_SESSION,
        maxRows: TASK_TABLE_MAX_ROWS,
        retentionMs: TASK_RETENTION_MS,
        resultHitCap: TASK_RESULT_HIT_CAP,
        rowCap: TASK_LIST_ROW_CAP,
      },
      // 缺席必须可见（铁律 4）：没有并进来的任务族逐条写明为什么没并，不当"这表就是全部"
      notIncluded: [
        {
          family: 'launcherTaskTable',
          status: 'NOT_MERGED',
          reason:
            '启动器另有自己的任务表（launcher_task_list / launcher_task_cancel，三件套齐全：state + progress{done,total,unit,message} + cancellable）。' +
            '它的工具名在端点按 launcher_* 判 privileged、授权走第三张表（与内核 writablePaths / exportFile 互不继承，铁律 7），' +
            '本批不并入以免同一 URI 族出现两个主人；并入需与启动器线合批。',
        },
        {
          family: 'indexBuild',
          status: 'NOT_WIRED',
          reason:
            '索引构建缺「取消」这一件（契约无取消位），且 buildIndex(roots) 会按调用方给的根集合改写编辑器正在使用的全局索引——只读面不做这个副作用。可查询事实另可经 project.info / 语义读数读到。',
        },
        {
          family: 'export',
          status: 'NOT_WIRED',
          reason:
            '导出是铁律 6 的法定通道：落点由系统对话框显式选定、对话框与写盘绑在同一个 Rust 命令内；无进度、无取消，且任务参数绝不允许变成可选落点 ⇒ 不任务化。',
        },
        {
          family: 'inlineSearch',
          status: 'NOT_TRACKED',
          reason:
            'workspace.searchAll / search.all 是同一次检索的一次性请求-应答形态，客户端没有任务 id 可查可撤，故不自动登记进表（要可查可撤请用 tasks.start(kind:search)）。',
        },
      ],
    };
  };

  return { start, status, cancel, list };
}
