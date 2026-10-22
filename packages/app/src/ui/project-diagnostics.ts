/**
 * 整项目诊断采集器（工包「未打开文件永不上账」那条缺腿，2026-10-20）。
 *
 * ## 它补的是哪半条腿
 *
 * `problem-store` 此前只有一路上账的口子（`EditorPane` 发布波浪线时顺手写），于是
 * "项目级计数"是假的：没打开过的文件根本不在账上。这一模块把**采集**这半条腿做成
 * 可单测的纯逻辑——槽位 `ui.editor.decorator` 的 `decorate({path,text,project})`
 * **零 model 依赖**（`kojo-fix-all.documentDiagnostics` 已经在这么用），文本经内核 io
 * 读盘，产物按 `project-scan` 那一簇上账。
 *
 * ## 这里刻意**没有**的东西
 *
 * 1. **没有调度**：不起定时器、不订阅事件、不碰 `bootstrap.ts`。谁在什么时机叫我、
 *    隔多久叫一次，是宿主的事（建议见批次回报）；本模块只保证"被叫到就能跑、能停"。
 * 2. **没有写盘**：只读诊断。写路径一个都没有。
 * 3. **没有域外读取**：`roots()` 声明的允许根之外**一个字节都不读**（拒读也计数、也要说得出，
 *    见 `outOfRoots`）——内核 io 那侧本来就有闸，这里再上一道是因为"上账"比"读盘"更该负责。
 *
 * ## 四条判据（都在单测里钉着）
 *
 * ① **批量上限 + 按目录/角色分批**：一轮最多办 `maxFiles` 个文件，办不完不装办完
 *    （`capped` 进覆盖读数）；分批键默认 = 父目录，可由宿主换成角色键，让"同一作者包的
 *    文件挨着出"，中途取消也留下一段完整的结论。
 * ② **迟到不许覆盖新账**（与 `createMarkerRunner` 同一条纪律，判据在这里更简单）：
 *    每次 `run()` 领一个世代号 `my`，**任何 await 之后、任何外部效果之前**都要复查
 *    `runId === my`；不符就丢弃这份结果并计入 `discarded`（不静默）。这里没有
 *    "model 版本号"可比——扫描结果对应的是**盘上内容**，新一轮一开就跑同一批路径，
 *    旧轮那份注定过期，所以世代号单键就够，不需要 marker 那套版本+世代双保险。
 * ③ **单文件抛错只跳该文件**：读盘炸了 ⇒ `skipped++`、点名进 `errors`、继续下一个；
 *    某一路诊断贡献方炸了 ⇒ 其余路照常上账，但这一格计入 `degraded`（少一路是事实，
 *    不许当成"这个文件只有这些问题"）。
 * ④ **取消即停**：`cancel()` 推进世代号，循环在每个检查点退出，覆盖读数落 `cancelled`
 *    ——屏幕上已上账的那部分仍然说得清自己只覆盖了一半。
 *
 * ## 2.0 那一格（additive，K2-PROJECT-HOST）
 *
 * 同一轮扫描里额外跑一次 `.kojo2` **项目级**分析（跨文件重名 / Layer / 接管 / 被压 / 存储期）：
 * 文本**复用这一轮已读的那一份**（不二次读盘），结论按文件合并进**同一个** `publish`。
 * `.kojo` 与未装配（`deps.kojo2Project` 缺席 / 开关关）时逐字无改动——v1 那一路的
 * 采集、分批、世代、覆盖读数全部照旧。判定与映射在 `kojo2-project-analysis.ts`，
 * 本文件只做"什么时候叫、把结果并进哪一格、耗时怎么报"。
 *
 * 两个刻意的取舍：① `.kojo2` 的 publish 延到**整轮读完**之后（跨文件结论必须看全，且这
 * 一路只读一次盘），中途取消 ⇒ 这些文件的旧账原样留着，与"这一轮根本没跑到它们"同义；
 * ② 2.0 这一格炸了只把 `degraded` / `errors` 点亮，v1 那一路的结果照旧上账，整轮不崩。
 *
 * adapter 可以是**惰性 getter**（生产 = 动态 `import()`，不进开机静态图）：分析入口因此是
 * async 的；装载失败由分析模块自己折成 `stats.adapterUnavailable` + 一次可见读数，不把整轮
 * 拖崩。`await` 之后照本文件第 ② 条纪律复查世代，迟到结论一个字都不上账。
 */

import type { EditorDecoratorContribution, GameProject, LineDecoration } from '@kojo/plugin-api';
import { isUnderPath, parentDir, pkey } from './file-tree-ops';
import {
  KOJO2_PROJECT_PROBLEM_PATH,
  analyzeKojo2ProjectAsync,
  kojo2ProjectPassEnabled,
  type Kojo2ProjectDocument,
  type Kojo2ProjectPassOptions,
  type Kojo2ProjectStats,
} from './kojo2-project-analysis';
import { isKojo2Path } from './kojo2-open';
import type { EditorProblem, ProjectScanCoverage, ProjectScanStatus } from './problem-store';

/** 一路装饰贡献的最小面（与 `marker-pool.MarkerContributor` 同形；槽位贡献天然满足） */
export type ScanContributor = Pick<EditorDecoratorContribution, 'id' | 'decorate'>;

/** 一轮最多办几个文件（0 = 不限） */
export const SCAN_MAX_FILES_PER_RUN = 400;
/** 两批之间让路一次的粒度 */
export const SCAN_BATCH_SIZE = 16;
/** 点名给作者看的错误条数上限（其余折成数字，不把 tooltip 写成日志） */
export const SCAN_ERROR_SAMPLE = 5;

/**
 * 一条 `LineDecoration` → 一条面板行。
 *
 * 映射必须与 `EditorPane.publish` **逐字段同款**（含"只有 startColumn 时 columnEnd 退化成它"），
 * 否则同一份波浪线从两条腿进面板会长出两种形状——那又是一个口径分叉。
 */
export function toEditorProblem(path: string, d: LineDecoration): EditorProblem {
  return {
    path,
    line: d.line,
    ...(d.startColumn !== undefined
      ? { span: { columnStart: d.startColumn, columnEnd: d.endColumn ?? d.startColumn } }
      : {}),
    severity: d.severity,
    message: d.message,
    ...(d.code ? { code: d.code } : {}),
    ...(d.source ? { source: d.source } : {}),
  };
}

/** 单个文件的采集结果（`failedContributors` = 这一格里抛错的那几路的 id） */
export interface ScannedFile {
  readonly problems: readonly EditorProblem[];
  readonly failedContributors: readonly string[];
}

/**
 * 问全部贡献方要这一份文件的诊断（**逐路隔离**：一路炸不许带走整份文件）。
 *
 * 与 `kojo-fix-all.documentDiagnostics` 的唯一区别是"炸了要说得出是谁炸的"——
 * 批量修复那一边少一路动作不影响正确性，这一边少一路诊断会直接改变**计数**，
 * 所以必须把 id 交出去让调用方上账（铁律 4）。
 */
export function decorateScanFile(
  contributors: readonly ScanContributor[],
  file: { path: string; text: string; project: GameProject | null },
): ScannedFile {
  const problems: EditorProblem[] = [];
  const failed: string[] = [];
  for (const c of contributors) {
    try {
      for (const d of c.decorate({ ...file }) ?? []) problems.push(toEditorProblem(file.path, d));
    } catch {
      failed.push(c.id);
    }
  }
  return { problems, failedContributors: failed };
}

/* -------------------------------- 分批 -------------------------------- */

export interface BatchPlanOptions {
  /** 分批键（默认 = 父目录；宿主可换成角色 / 作者包键，让同一角色的文件挨着出） */
  readonly keyOf?: (path: string) => string;
  readonly perBatch?: number;
  /** 本轮上限（0 = 不限） */
  readonly maxFiles?: number;
}

export interface ScanBatch {
  /** 分批键的归一形态（判据用） */
  readonly key: string;
  /** 分批键的原样形态（进度文案用） */
  readonly label: string;
  readonly paths: readonly string[];
}

/**
 * 路径集 → 有序批次：先按批键（码点序）排、键内按路径码点序排，再按 `perBatch` 切、
 * 按 `maxFiles` 截断。
 *
 * 三件事都刻意：① **不用 localeCompare**（CJK 分区域，同一份输入换台机器就换序，
 * 测不出来也复现不了）；② 截断发生在**排好序之后** ⇒ 同一批输入必得同一批子集，
 * 反复"跑到上限就停"也不会每次换一批文件（作者看到的是稳定的那一段，而不是随机的）；
 * ③ 去重按 `pkey`（Windows 两种写法是同一个文件，读两遍算两遍就是造假账）。
 */
export function planScanBatches(paths: readonly string[], opts: BatchPlanOptions = {}): ScanBatch[] {
  const perBatch = Math.max(1, Math.floor(opts.perBatch ?? SCAN_BATCH_SIZE));
  const maxFiles = Math.max(0, Math.floor(opts.maxFiles ?? SCAN_MAX_FILES_PER_RUN));
  const keyOf = opts.keyOf ?? parentDir;
  const seen = new Set<string>();
  const byKey = new Map<string, { label: string; paths: string[] }>();
  for (const p of paths) {
    const k = pkey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    const group = keyOf(p);
    const gk = pkey(group) || '\u0000';
    const slot = byKey.get(gk);
    if (slot) slot.paths.push(p);
    else byKey.set(gk, { label: group, paths: [p] });
  }
  const groups = [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: ScanBatch[] = [];
  let taken = 0;
  for (const [key, g] of groups) {
    const sorted = [...g.paths].sort((a, b) => (pkey(a) < pkey(b) ? -1 : pkey(a) > pkey(b) ? 1 : 0));
    for (let i = 0; i < sorted.length; i++) {
      if (maxFiles > 0 && taken >= maxFiles) break;
      taken++;
      const last = out.at(-1);
      if (last !== undefined && last.key === key && last.paths.length < perBatch) {
        (last.paths as string[]).push(sorted[i]!);
      } else {
        out.push({ key, label: g.label, paths: [sorted[i]!] });
      }
    }
    if (maxFiles > 0 && taken >= maxFiles) break;
  }
  return out;
}

/** 允许域闸门：`roots` 为空一律拒（没声明根 = 没资格读任何东西） */
export function filterInsideRoots(
  paths: readonly string[],
  roots: readonly string[],
): { readonly allowed: readonly string[]; readonly rejected: readonly string[] } {
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const p of paths) {
    (roots.some((r) => isUnderPath(r, p)) ? allowed : rejected).push(p);
  }
  return { allowed, rejected };
}

/* -------------------------------- 采集器 -------------------------------- */

export interface ProjectScannerDeps {
  /** 待扫文件集（宿主接 `ErbIndex.files.keys()` 或 `walkDialectPaths`；本模块不认识内核） */
  listFiles(): readonly string[] | Promise<readonly string[]>;
  /** 允许读的根（= 项目里口上目录那一份；空数组 ⇒ 什么都不读） */
  roots(): readonly string[];
  project(): GameProject | null;
  /** 槽位贡献快照（顺序即合并顺序，与编辑器那一簇同一把尺） */
  contributors(): readonly ScanContributor[];
  /** 只读文本（内核 io；本模块不碰任何写路径） */
  readFile(path: string): Promise<string>;
  /** 一格里整档上账（宿主 = `problem-store.setProjectScanProblems`）；空数组由 store 决定留不留 */
  publish(path: string, problems: readonly EditorProblem[]): void;
  /** 覆盖读数（宿主 = `problem-store.setProjectScanCoverage`）；进度与降级全从这里说话 */
  onCoverage?(c: ProjectScanCoverage): void;
  /** 关标签后排进来的复核路径（宿主 = `problem-store.takeRescanPaths`），并入本轮 */
  extraPaths?(): readonly string[];
  /** 复核队列当前长度（宿主 = `problem-store.rescanPendingPaths().length`）；只读数、不排空 */
  pendingRescanCount?(): number;
  /** 每批之间让一次路（宿主接 `kernel.compute.yieldToMain`；缺省 = 微任务） */
  yieldBetween?(): Promise<void>;
  /**
   * Kojo 2.0 项目级分析的装配面（**additive**；缺省 = 不跑）。
   *
   * 给出它之后，`.kojo2` 文件在**同一轮扫描**里额外过一次项目级分析（复用本文件刚读到的
   * 文本，不二次读盘），结论与本文件的 v1 诊断合并后经同一个 `publish` 上账。
   * `.kojo` 文件、`enabled()` 为 false、或这个字段缺席时，v1 行为逐字不变。
   */
  readonly kojo2Project?: Kojo2ProjectPassOptions;
  perBatch?: number;
  maxFiles?: number;
}

export interface ScanRunOptions {
  readonly perBatch?: number;
  readonly maxFiles?: number;
  /** 只办复核队列（增量那一轮）：不重新列举文件、不受整轮上限影响 */
  readonly rescanOnly?: boolean;
}

export interface ScanError {
  readonly path: string;
  readonly reason: string;
}

export interface ScanOutcome {
  readonly status: ProjectScanStatus;
  readonly scanned: number;
  readonly total: number;
  readonly published: number;
  readonly skipped: number;
  readonly degraded: number;
  readonly outOfRoots: number;
  /** 因世代已换而被丢弃的结果份数（迟到防护生效的证据） */
  readonly discarded: number;
  readonly batches: number;
  /** 是否撞到本轮上限（⇒ 覆盖不完整） */
  readonly capped: boolean;
  readonly errors: readonly ScanError[];
  /**
   * 2.0 项目级分析读数（additive）：`null` = 这一轮没跑（`.kojo2` 为零 / 开关关 / 未装配）。
   * 跑了但零份 `.kojo2` 时也是 `null`——"没这一步"与"这一步跑了但没结论"要说得出区别。
   */
  readonly kojo2: Kojo2ProjectStats | null;
}

/** 累计中的那一轮（对外只交出 `ScanOutcome` 那份只读镜像；写它的是采集器自己） */
interface OutcomeDraft {
  status: ProjectScanStatus;
  scanned: number;
  total: number;
  published: number;
  skipped: number;
  degraded: number;
  outOfRoots: number;
  discarded: number;
  batches: number;
  capped: boolean;
  errors: ScanError[];
  kojo2: Kojo2ProjectStats | null;
}

const idleCoverage = (roots: readonly string[]): ProjectScanCoverage => ({
  status: 'idle',
  roots,
  scanned: 0,
  total: 0,
  skipped: 0,
  degraded: 0,
  outOfRoots: 0,
  pendingRescan: 0,
  capped: false,
});

/** 这一文件的 v1 诊断 + 2.0 项目级结论（空的那一侧直接复用原数组，不白复制一次） */
function mergeProblems(
  own: readonly EditorProblem[],
  project: readonly EditorProblem[],
): readonly EditorProblem[] {
  if (project.length === 0) return own;
  if (own.length === 0) return project;
  return [...own, ...project];
}

/**
 * 2.0 判定段的耗时读数。
 *
 * 宿主给了 `onTiming` 就交出去（接 perf / 日志）；没给就打印一行——**判定段按「万级 @函」
 * 归一**（`ms/万 @函`），口径与 core `tests/project.bench.test.ts` 的万级函数读数、
 * 以及本仓既有「13.5ms / 10k」那一族读法一致，便于直接横向比。解析耗时单列：
 * 那一段随文本量线性，且文本已在内存（**不含读盘**）。
 */
function reportKojo2Timing(options: Kojo2ProjectPassOptions, stats: Kojo2ProjectStats): void {
  if (options.onTiming !== undefined) {
    options.onTiming(stats.timing);
    return;
  }
  const t = stats.timing;
  // 样本太小（个位数文件）时归一出来的"万函数耗时"没有意义，只在有量的时候才报
  const perTenThousand =
    stats.functions >= 1_000 ? (t.analyzeMs / stats.functions) * 10_000 : null;
  // eslint-disable-next-line no-console
  console.info(
    `[project-scan] kojo2 项目级分析：${stats.documents} 份 .kojo2 / ${stats.functions} 个 @函 / ${stats.weaves} 个 @织` +
      ` → ${stats.problems} 条问题；判定 ${t.analyzeMs.toFixed(2)}ms` +
      (perTenThousand === null ? '' : `（≈${perTenThousand.toFixed(1)}ms/万 @函）`) +
      ` · 解析 ${t.parseMs.toFixed(2)}ms · 合计 ${t.totalMs.toFixed(2)}ms` +
      '（口径：文本已在内存，不含读盘）',
  );
}

/**
 * 采集器本体：**一个实例 = 一条世代线**。
 *
 * `run()` 可重入：后发起的那一轮领新世代号，前一轮在下一个检查点自己退场（不并发跑两轮
 * 互相踩账，也不需要锁）。返回的 `Promise` 永远 resolve（意外也折成 `status:'failed'`），
 * 宿主不必处理 rejection —— 采集炸了不该把调用它的 effect 也炸掉，但它必须看得见（`errors`）。
 */
export function createProjectScanner(deps: ProjectScannerDeps): {
  run(opts?: ScanRunOptions): Promise<ScanOutcome>;
  cancel(): void;
  isRunning(): boolean;
  coverage(): ProjectScanCoverage;
} {
  let runId = 0;
  /** 正在跑的那一轮的世代号（0 = 没有轮次在跑；被取代的那一轮自己退场时不许把它踩掉的这格清零） */
  let runningId = 0;
  let last: ProjectScanCoverage = idleCoverage([]);

  const emit = (patch: Partial<ProjectScanCoverage> & { status: ProjectScanStatus }): void => {
    last = { ...last, ...patch };
    deps.onCoverage?.(last);
  };

  async function run(opts: ScanRunOptions = {}): Promise<ScanOutcome> {
    const my = ++runId; // 新账一开，所有在途的旧账一律作废
    runningId = my;
    const perBatch = Math.max(1, Math.floor(opts.perBatch ?? deps.perBatch ?? SCAN_BATCH_SIZE));
    const maxFiles = Math.max(0, Math.floor(opts.maxFiles ?? deps.maxFiles ?? SCAN_MAX_FILES_PER_RUN));
    const outcome: OutcomeDraft = {
      status: 'running',
      scanned: 0,
      total: 0,
      published: 0,
      skipped: 0,
      degraded: 0,
      outOfRoots: 0,
      discarded: 0,
      batches: 0,
      capped: false,
      errors: [],
      kojo2: null,
    };
    const roots = deps.roots();
    /**
     * 2.0 那一格的装配读数：`enabled` 只在这一轮开头读一次（与语言面 / 主题同一口径：
     * 装配那一刻定，不逐文件现问）。false ⇒ 下面连 `.kojo2` 判据都不调，v1 行为逐字不变。
     */
    const kojo2 = deps.kojo2Project;
    const kojo2Active = kojo2ProjectPassEnabled(kojo2);
    const kojo2IsKojo2 = kojo2?.isKojo2 ?? isKojo2Path;
    /** 本轮读到的 `.kojo2` 文本 + 它们各自的 v1 诊断（结论要看完所有文件才出 ⇒ 延后上账） */
    const kojo2Documents: Kojo2ProjectDocument[] = [];
    const kojo2Pending = new Map<string, readonly EditorProblem[]>();
    // 整格重置：上一轮剩下的 skipped / outOfRoots 不许在这一轮刚开始时就挂在读数上
    emit({ ...idleCoverage(roots), status: 'running', roots });
    const stale = (): boolean => runId !== my;
    const pending = (): number => deps.pendingRescanCount?.() ?? 0;
    const note = (path: string, reason: string): void => {
      if (outcome.errors.length < SCAN_ERROR_SAMPLE) outcome.errors.push({ path, reason });
    };
    const quit = (status: ProjectScanStatus): ScanOutcome => {
      if (runningId === my) runningId = 0; // 被取代的那一轮退场时不许踩掉新轮的"在跑"读数
      const final = { ...outcome, status };
      // **被取代的那一轮不写读数**：新轮正在按自己的进度刷这一格，旧轮拿一堆 0 去覆盖
      // 就是"迟到结果盖新账"本身（取消那一路由 `cancel()` 自己落 cancelled，不靠这里）
      if (!stale()) {
        emit({
          status,
          roots,
          scanned: final.scanned,
          total: final.total,
          skipped: final.skipped,
          degraded: final.degraded,
          outOfRoots: final.outOfRoots,
          pendingRescan: pending(),
          capped: final.capped,
        });
      }
      return final;
    };

    try {
      const listed = opts.rescanOnly ? [] : await deps.listFiles();
      if (stale()) return quit('cancelled');
      const queued = deps.extraPaths?.() ?? [];
      const { allowed, rejected } = filterInsideRoots([...listed, ...queued], roots);
      outcome.outOfRoots = rejected.length;
      const batches = planScanBatches(allowed, { perBatch, maxFiles });
      outcome.total = allowed.length;
      outcome.batches = batches.length;
      const planned = batches.reduce((n, b) => n + b.paths.length, 0);
      outcome.capped = planned < allowed.length;
      if (allowed.length === 0) {
        // 一个都不许读 = 这一轮的结论覆盖面是零，不能伪装成"扫完了、什么都没扫出来"
        return quit(rejected.length > 0 || roots.length === 0 ? 'failed' : 'complete');
      }

      const contributors = deps.contributors();
      const project = deps.project();
      for (const batch of batches) {
        if (stale()) return quit('cancelled');
        const yielder = deps.yieldBetween?.() ?? Promise.resolve();
        await yielder;
        if (stale()) return quit('cancelled');
        for (const path of batch.paths) {
          if (stale()) return quit('cancelled');
          let text: string;
          try {
            text = await deps.readFile(path);
          } catch (e) {
            outcome.skipped++;
            outcome.scanned++;
            note(path, `读盘失败：${String(e instanceof Error ? e.message : e)}`);
            continue;
          }
          // await 之后的第一个动作就是问"还是我这一轮吗"——不是就整份丢掉，
          // 迟到的扫描结论盖掉新一轮刚写的账，跟迟到的波浪线盖掉新 model 是同一个 bug
          if (stale()) {
            outcome.discarded++;
            return quit('cancelled');
          }
          const scanned = decorateScanFile(contributors, { path, text, project });
          if (scanned.failedContributors.length > 0) {
            outcome.degraded++;
            note(path, `诊断方抛错已跳过：${scanned.failedContributors.join('、')}`);
          }
          // `.kojo2` 的项目级结论要看完这一轮**所有**文件才出得来（跨文件事实），
          // 所以这里只记账、不立刻 publish；文本就此留在内存，绝不为分析再读一次盘。
          if (kojo2Active && kojo2IsKojo2(path)) {
            const layerId = kojo2?.layerOf?.(path);
            kojo2Documents.push({ path, text, ...(layerId === undefined ? {} : { layerId }) });
            kojo2Pending.set(path, scanned.problems);
          } else {
            deps.publish(path, scanned.problems);
            outcome.published++;
          }
          outcome.scanned++;
        }
        emit({
          status: 'running',
          roots,
          scanned: outcome.scanned,
          total: outcome.total,
          skipped: outcome.skipped,
          degraded: outcome.degraded,
          outOfRoots: outcome.outOfRoots,
          pendingRescan: pending(),
          capped: outcome.capped,
        });
      }
      if (kojo2Active && kojo2 !== undefined && kojo2Documents.length > 0) {
        if (stale()) return quit('cancelled');
        try {
          // 惰性 adapter 可能异步装载（`import()`）：入口是 async 的，解析失败会自己降级成
          // "无 adapter"并置 `stats.adapterUnavailable`，不把整轮炸掉（判据在分析模块里）。
          const analysis = await analyzeKojo2ProjectAsync({
            documents: kojo2Documents,
            ...(kojo2.adapter === undefined ? {} : { adapter: kojo2.adapter }),
            ...(kojo2.onAdapterUnavailable === undefined
              ? {}
              : { onAdapterUnavailable: kojo2.onAdapterUnavailable }),
            ...(kojo2.storage === undefined ? {} : { storage: kojo2.storage }),
            ...(kojo2.parse === undefined ? {} : { parse: kojo2.parse }),
            ...(kojo2.projectPath === undefined ? {} : { projectPath: kojo2.projectPath }),
            ...(kojo2.now === undefined ? {} : { now: kojo2.now }),
          });
          // await 之后同一纪律：世代已换 ⇒ 这份迟到的结论一个字都不许上账。
          if (stale()) return quit('cancelled');
          // 一文件一次 publish：本文件的 v1 诊断 + 落在它头上的项目级结论（整档替换语义）
          for (const [path, ownProblems] of kojo2Pending) {
            deps.publish(path, mergeProblems(ownProblems, analysis.problemsByPath.get(path) ?? []));
            outcome.published++;
          }
          // 项目级（无单一声明/监听可指）那一格也要上账：只活在返回值里就等于悄悄丢掉（铁律 4）
          const projectPath = kojo2.projectPath ?? KOJO2_PROJECT_PROBLEM_PATH;
          deps.publish(projectPath, analysis.problemsByPath.get(projectPath) ?? []);
          outcome.kojo2 = analysis.stats;
          reportKojo2Timing(kojo2, analysis.stats);
        } catch (e) {
          // 同上：被取代的那一轮连降级路径也不许上账（旧轮写出旧结论 = 迟到盖新账）。
          if (stale()) return quit('cancelled');
          // 2.0 这一格炸了：本轮其余结论照旧上账，但"少了一路"必须看得见（不静默）
          outcome.degraded += kojo2Pending.size;
          note('(kojo2 项目级分析)', `分析异常：${String(e instanceof Error ? e.message : e)}`);
          for (const [path, ownProblems] of kojo2Pending) {
            deps.publish(path, ownProblems);
            outcome.published++;
          }
        }
      }
      return quit('complete');
    } catch (e) {
      // listFiles / contributors / publish 里的意外：本轮到此为止，但要说得出停在哪
      note('(采集器)', `采集器异常：${String(e instanceof Error ? e.message : e)}`);
      return quit(stale() ? 'cancelled' : 'failed');
    }
  }

  return {
    run,
    cancel(): void {
      if (runningId === 0) return;
      const snapshotOfRun = last;
      runId++; // 在途那一份在每个检查点自己认输（并**不**再写读数，见 quit 那段）
      runningId = 0;
      emit({ ...snapshotOfRun, status: 'cancelled' });
    },
    isRunning(): boolean {
      return runningId !== 0;
    },
    coverage(): ProjectScanCoverage {
      return last;
    },
  };
}
