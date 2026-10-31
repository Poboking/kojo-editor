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
export type ScanContributor = Pick<EditorDecoratorContribution, 'id' | 'decorate' | 'bulk'>;

/** 一轮最多办几个文件（0 = 不限） */
export const SCAN_MAX_FILES_PER_RUN = 400;
/** 分批键的粒度（同一批"围着出结论"：中途取消也留下一段完整的分组） */
export const SCAN_BATCH_SIZE = 16;
/**
 * 让路粒度：**每办几个文件让一次路**（P0-2 批 4）。
 *
 * 旧口径是「一批（16 个文件）让一次」——那是 2026-10-20 写这一格时的假设：一次 `decorate`
 * 只需几毫秒。冷开实测（真壳 400 文件、页内四路探针、**不开 tracing**）把它推翻了：
 * 一个文件的整档诊断 ≈ 22ms（`expressionSites` 4.7ms + `visibleCodeLines` 3.5ms +
 * `collectUndefinedNameDiagnostics` 2.7ms + did-you-mean 那族 3.7ms，逐项自时间读数见
 * `2026-10-27-p0-2-batch4-findings.md` §3），16 个一批 = 一条 **580ms 长任务**——
 * 用户点完「打开文件夹」看到的那两下卡顿里，一下就是它（另一下是索引帧本身）。
 *
 * 让路粒度改成 1（单个文件）：最坏任务从「一批」降到「一个文件」，而总工时一字不变。
 * 判据是 §3.4「perf 窗口内无 >500ms 长任务」，把粒度钉在**项**上才有余量。
 */
export const SCAN_YIELD_EVERY_FILES = 1;
/**
 * 批量派发块的**上界**（R4b）：一块最多装这么多文件。
 *
 * 为什么派发粒度要大于上账粒度（`SCAN_BATCH_SIZE` = 16）：批量载荷里那截跨文件上下文
 * （声明名 + 实参目录，真语料 3.4M 码元）**整轮不变**，而结构化克隆按内容计价——
 * 真语料 400 文件实测：按批派发（57 批）把同一份上下文克隆了 57 遍，**序列化税 294ms**，
 * 占整轮主线程占用（305ms）的 96%。按 128 一块派发只需 4 次，同一份读数落到 ~20ms。
 *
 * 取 128 当**上界**而不是定值（2026-10-29 C 批遗留）：取消要能在有限步之内生效
 * （一块 ≈ 128 份文件的装饰计算，worker 侧真语料约 2s），而且一块的正文内存 ≈ 2.3MB。
 * 这一轮实际切多大由 {@link bulkChunkSize} 按"计划文件数 / 在飞宽度"算。
 */
export const SCAN_BULK_CHUNK = 128;
/**
 * 一块的**下界**：别为了几份文件把整份上下文克隆一遍（真语料每次克隆 4.1ms / 6.5MB）。
 *
 * 400 份以下的小盘子本来一轮就扫完了，切成 4 块只多交克隆税、不多拿到并行。
 * 取 `SCAN_BATCH_SIZE`（16）而不是更好看的 32：扫描器的"一批"本来就是 16，
 * 两个数字对齐之后"一块 ≥ 一批"这条性质不用额外记。
 */
export const SCAN_BULK_CHUNK_MIN = 16;
/**
 * 同时在飞的块数（C 批遗留，2026-10-29）：R4b 交付时**一次只在飞一块**，
 * 6.2s 全压在一个 worker 上，池子里另外三个从头闲到尾。
 *
 * 计算池的槽数 = `min(hardwareConcurrency - 1, 4)`（`bootstrap.installComputeTransport`），
 * 而 `createWorkerTransport` 是**严格轮转 + 不排队**（`cursor = (slot + 1) % size`）：
 * 调用方不并发 `invoke`，槽就永远只有一个在干活。
 *
 * 取 4 = 槽数上限：派得更密不会更快（多出来的块在同一条 worker 的消息队列里排队），
 * 只会多占内存与取消窗口。槽更少时也不亏——多出来的块照样排队，**总工时不变**，
 * 只是上下文的克隆税按块数走（4 块 × 4.1ms 已是这一点点的上限）。
 */
export const SCAN_BULK_INFLIGHT = 4;

/**
 * 这一轮每块装几份（见 {@link SCAN_BULK_CHUNK}：128 是上界，不是定值）。
 *
 * 目标：让**每一波正好铺满池子**——块数 ≈ 在飞宽度时，各槽收工时间最接近，并行墙钟
 * = 最晚收工的那一块。真语料 400 份、4 槽实测：固定 128 切成 128/128/128/16，尾巴块
 * 只 237ms 而三块各背 128 份 ⇒ 墙钟 1,884–1,950ms（3.0×）；按 400/4 = 100 切则
 * 1,457–1,565ms（**3.7×**），克隆税一分没多。再往小切不划算：13 块多花 37ms 克隆税，
 * 墙钟反而不动（1,851–2,006ms）——并行度已经被槽数封死。
 */
export function bulkChunkSize(planned: number, inflight: number): number {
  const width = Math.max(1, Math.floor(inflight));
  const target = Math.ceil(Math.max(1, Math.floor(planned)) / width);
  return Math.min(SCAN_BULK_CHUNK, Math.max(SCAN_BULK_CHUNK_MIN, target));
}
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
 * 批量通道算好的那批装饰：**贡献 id → 路径 → 该文件的装饰**。
 *
 * 只装"这一批确实走成了批量"的那些（贡献, 文件）对：`undefined` = 没走成，调用方按
 * 原来的路逐文件问 `decorate`。空数组是**合法结果**（这一路这一批没问题），与"没算过"
 * 必须分得开——所以这里用两层 Map 而不是一个 `Map<string, LineDecoration[]>`
 * （后者分不出"没这个键"与"有这个键但空"）。
 */
export type ScanPrefetch = ReadonlyMap<string, ReadonlyMap<string, readonly LineDecoration[]>>;

/** 已派出去、还没上账的一块（C 批遗留：多块在飞，上账按 FIFO） */
interface InFlightChunk {
  readonly files: readonly { readonly path: string; readonly text: string }[];
  /** 这块算完了（成功 / 失败都算"完"，失败时 `value === undefined` ⇒ 逐文件回退） */
  ready: boolean;
  value: ScanPrefetch | undefined;
  /** 只用于回压等待；不 reject（失败也 resolve，语义走 `value`） */
  done: Promise<void>;
}

/**
 * 问全部贡献方要这一份文件的诊断（**逐路隔离**：一路炸不许带走整份文件）。
 *
 * 与 `kojo-fix-all.documentDiagnostics` 的唯一区别是"炸了要说得出是谁炸的"——
 * 批量修复那一边少一路动作不影响正确性，这一边少一路诊断会直接改变**计数**，
 * 所以必须把 id 交出去让调用方上账（铁律 4）。
 *
 * `prefetch`（R4b）是「整批已经算好」的那一格：有就用、没有就问——**逐路独立**，
 * 于是"这一路批了、那一路没批"是常态而不是特例。
 */
export function decorateScanFile(
  contributors: readonly ScanContributor[],
  file: { path: string; text: string; project: GameProject | null },
  prefetch?: ScanPrefetch,
): ScannedFile {
  const problems: EditorProblem[] = [];
  const failed: string[] = [];
  for (const c of contributors) {
    const ready = prefetch?.get(c.id)?.get(file.path);
    if (ready !== undefined) {
      // 批量通道已经算过这一路这一份：产物与 `decorate` 逐条相同（契约里写死），
      // 这里只做与就地路径同一道映射，**不重算**
      for (const d of ready) problems.push(toEditorProblem(file.path, d));
      continue;
    }
    try {
      // `bulk: true` = 这一轮是**整项目扫描**，产物只进问题列表（R4a，契约见
      // `EditorDecoratorContribution.decorate`）。判据面（条数/位置/severity/code）不变，
      // 只让"给人看"的那截缺席——今天唯一的受益方是 erb-parser 的 did-you-mean。
      for (const d of c.decorate({ ...file, bulk: true }) ?? []) problems.push(toEditorProblem(file.path, d));
    } catch {
      failed.push(c.id);
    }
  }
  return { problems, failedContributors: failed };
}

/* ------------------------- 批量通道（R4b，2026-10-29） ------------------------- */

/** 送一批出去算的通道（宿主侧唯一实现 = `kernel.compute.offload`） */
export interface ScanBulkChannel {
  offload(kind: string, payload: unknown): Promise<unknown>;
}

/**
 * 批量通道的**每轮状态**（随 `run()` 生灭）。
 *
 * - `contexts`：贡献 id → 上下文。每轮**每贡献只构造一次**（`context()` 要读整份索引，
 *   逐批构造等于把固定税交 25 遍）。包一层 `{ ctx }` 是因为 `null` 是合法上下文
 *   （未开项目），不能让"没构造"和"构造出 null"共用一个表示。
 * - `broken`：这一轮该贡献的通道失败过。失败一次之后不再试——`compute.offload` 内部
 *   已经把"transport 挂了"折成"本地实现"，抛出来的错意味着**本地实现也炸了**，
 *   再试 24 次只是白花时间；回退逐文件仍会逐份上报失败（`degraded`），不静默。
 */
export interface ScanBulkState {
  readonly contexts: Map<string, { readonly ctx: unknown }>;
  readonly broken: Set<string>;
}

/**
 * 整批预取（R4b）：把「这一批文件 × 每一路声明了 `bulk` 的贡献」送出去算。
 *
 * 三条不变量（都是契约的子集，判据在单测里）：
 *
 * ① **顺序**：`perFile[i]` 属于 `files[i]`（契约写死）。这里只按路径归位、不重排——
 *    上账顺序仍由调用方的"文件 → 贡献顺序"决定，与翻转前**逐条相同**
 *    （`sortAndDedupe` 的去重是"留先到的"，顺序一变同一位置两条诊断就可能换人）。
 * ② **隔离**：任何一路炸了只影响那一路（`broken` 记名、这一批它不打标记），
 *    其余路照常批量。
 * ③ **可回退**：没算成的不留任何占位，调用方逐文件走 `decorate`——那条路是契约里
 *    写死的同义实现，不是"降级近似"。
 */
export async function prefetchScanBatch(
  contributors: readonly ScanContributor[],
  files: readonly { readonly path: string; readonly text: string }[],
  channel: ScanBulkChannel,
  state: ScanBulkState,
): Promise<ScanPrefetch> {
  const out = new Map<string, ReadonlyMap<string, readonly LineDecoration[]>>();
  if (files.length === 0) return out;
  for (const c of contributors) {
    const bulk = c.bulk;
    if (bulk === undefined || state.broken.has(c.id)) continue;
    let entry = state.contexts.get(c.id);
    if (entry === undefined) {
      try {
        entry = { ctx: bulk.context() };
      } catch {
        state.broken.add(c.id); // 上下文构造不出来 ⇒ 这一路整轮就地（`decorate` 不依赖它）
        continue;
      }
      state.contexts.set(c.id, entry);
    }
    try {
      const result = (await channel.offload(bulk.kind, { ctx: entry.ctx, files })) as
        | { perFile?: readonly (readonly LineDecoration[])[] }
        | undefined;
      const per = result?.perFile;
      // 形状自证：长度不符就当这一批没算成（宁慢不错，且不静默——下一批直接走就地）
      if (!Array.isArray(per) || per.length !== files.length) throw new Error('bulk result shape mismatch');
      const byPath = new Map<string, readonly LineDecoration[]>();
      for (let i = 0; i < files.length; i++) byPath.set(files[i]!.path, per[i] ?? []);
      out.set(c.id, byPath);
    } catch {
      state.broken.add(c.id);
    }
  }
  return out;
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
   * 批量通道（additive，2026-10-29 R4b）：把「一批文件 × 一路贡献」整批送出去算。
   *
   * 宿主侧唯一实现是 `kernel.compute.offload`（kind 不在任务表 / 通道不可用时它自己
   * 回退到本地实现，所以这里不必再判一次 `hasWorkerTask`）。**缺省 = 全部逐文件就地**，
   * 与 R4b 之前的行为逐字相同——单测与"无计算池"的宿主都走这一档。
   */
  offload?(kind: string, payload: unknown): Promise<unknown>;
  /**
   * 同时在飞的块数（additive，2026-10-29 C 批遗留）：缺省 {@link SCAN_BULK_INFLIGHT}。
   *
   * 只对"这一轮真的走批量"的贡献生效。单测用它把窗口钉成 `1`（复现 R4b 的串行派发，
   * 判据是"结果一字不差"）或 `2`（钉住"后块先回也得按序上账"）；宿主不传，用缺省。
   */
  bulkInflight?: number;
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
      /**
       * 批量通道的每轮状态（R4b）。随 `run()` 生灭 ⇒ 换一轮就是换一份上下文
       * （索引可能已经重建过，缓存按索引对象失效，不需要这里再管）。
       */
      const bulkState: ScanBulkState = { contexts: new Map(), broken: new Set() };
      const bulkChannel: ScanBulkChannel | null = deps.offload === undefined ? null : { offload: deps.offload };
      /**
       * 这一轮走不走批量（R4b）：**通道在 + 至少一路声明了 `bulk`**。
       *
       * 不走批量时逐批上账的粒度不变（`SCAN_BULK_CHUNK` 当 0 用）——既有的每一条语义
       * （让路点、`skipped`、`discarded`、`.kojo2` 延后上账）都按原样跑。
       */
      const bulkActive = bulkChannel !== null && contributors.some((c) => c.bulk !== undefined);
      /** 在飞窗口的宽度（见 `SCAN_BULK_INFLIGHT`：= 池的槽数上限，缺省 4） */
      const inflightWidth = Math.max(1, Math.floor(deps.bulkInflight ?? SCAN_BULK_INFLIGHT));
      /**
       * 这一轮每块装几份（见 {@link bulkChunkSize}：**128 是上界，不是定值**）。
       * 计划文件数是在 `planScanBatches` 之后就知道的 ⇒ 切块按"铺满池子"算，不猜。
       */
      const chunkSize = bulkActive ? bulkChunkSize(planned, inflightWidth) : 0;
      /** 已读、还没派出去的那一段（FIFO） */
      const publishQueue: { path: string; text: string }[] = [];
      /**
       * 已派出、还没上账的那些块（**FIFO**）。
       *
       * 顺序不能靠"谁先回谁先上账"：上账顺序一变，同一位置的两条诊断就可能换人
       * （`sortAndDedupe` 的去重是"留先到的"），判据面会跟着漂。所以算完的块
       * **先到的也得排队**，只认队首（见 `drainHead`）。
       */
      const inFlight: InFlightChunk[] = [];

      /** 逐文件上账（原样；`prefetch` 里有就走批量算好的那份） */
      const publishFiles = (files: readonly { path: string; text: string }[], prefetch: ScanPrefetch | undefined): void => {
        for (const file of files) {
          const scanned = decorateScanFile(contributors, { path: file.path, text: file.text, project }, prefetch);
          if (scanned.failedContributors.length > 0) {
            outcome.degraded++;
            note(file.path, `诊断方抛错已跳过：${scanned.failedContributors.join('、')}`);
          }
          // `.kojo2` 的项目级结论要看完这一轮**所有**文件才出得来（跨文件事实），
          // 所以这里只记账、不立刻 publish；文本就此留在内存，绝不为分析再读一次盘。
          if (kojo2Active && kojo2IsKojo2(file.path)) {
            const layerId = kojo2?.layerOf?.(file.path);
            kojo2Documents.push({ path: file.path, text: file.text, ...(layerId === undefined ? {} : { layerId }) });
            kojo2Pending.set(file.path, scanned.problems);
          } else {
            deps.publish(file.path, scanned.problems);
            outcome.published++;
          }
          outcome.scanned++;
        }
      };

      /**
       * 派一块出去（**不 await**；`take` = 这一块装几份）。
       *
       * 返回的那一刻只说明"已经交给计算池了"，说明不了"算完了"——算完看 `ready`。
       * 计算池是严格轮转 + 不排队（`createWorkerTransport`），所以并发的 `invoke`
       * 各自落到不同的槽上；这正是 R4b 缺的那一步（那时一次只 `await` 一块，
       * 池子里另外三个槽从头闲到尾）。
       */
      const dispatchChunk = (take: number): void => {
        if (take <= 0) return;
        const files = publishQueue.splice(0, take);
        if (files.length === 0) return;
        const chunk: InFlightChunk = { files, ready: !bulkActive, value: undefined, done: Promise.resolve() };
        if (bulkActive) {
          chunk.done = prefetchScanBatch(contributors, files, bulkChannel, bulkState).then(
            (value) => {
              chunk.value = value;
              chunk.ready = true;
            },
            () => {
              // 整块炸（`prefetchScanBatch` 已逐路吞错，走到这儿是它自己出了意外）：
              // 这一块**不留占位** ⇒ 上账时逐文件回退到 `decorate`，与"没算成"同义
              chunk.ready = true;
            },
          );
        }
        inFlight.push(chunk);
      };

      /** 上账队首那**一块**；返回 `false` = 世代已换（调用方立刻退场，一份都不许写） */
      const drainHead = async (): Promise<boolean> => {
        const head = inFlight[0];
        if (head === undefined) return true;
        if (!head.ready) await head.done;
        // await 之后的第一件事照旧是问"还是我这一轮吗"：迟到的批量结论一样会盖新账
        if (stale()) return false;
        inFlight.shift();
        publishFiles(head.files, head.value);
        return true;
      };

      /** 把**已经算好**的队首尽量上账（不阻塞；队首没好就一份都不动，顺序优先） */
      const drainSettled = async (): Promise<boolean> => {
        while (inFlight.length > 0 && inFlight[0]!.ready) {
          if (!(await drainHead())) return false;
        }
        return true;
      };

      for (const batch of batches) {
        if (stale()) return quit('cancelled');
        for (let i = 0; i < batch.paths.length; i++) {
          if (stale()) return quit('cancelled');
          // 让路点放在**读盘之前**：于是「上一项收尾」与「本项开工」之间必然有一次宏任务
          // 边界（粒度见 `SCAN_YIELD_EVERY_FILES` 头注——旧口径是每批一次，一批 580ms）
          if (i % SCAN_YIELD_EVERY_FILES === 0) {
            await (deps.yieldBetween?.() ?? Promise.resolve());
            if (stale()) return quit('cancelled');
          }
          const path = batch.paths[i]!;
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
          publishQueue.push({ path, text });
        }
        if (!bulkActive) {
          // 不批量：与改前**逐字相同**——这一批读完就上账这一批（没有"在飞"这回事）
          dispatchChunk(publishQueue.length);
        } else {
          // 攒够一块就派；**窗口满了先腾位**（唯一的回压点）。派出去就不等，等的只是位子
          while (publishQueue.length >= chunkSize) {
            while (inFlight.length >= inflightWidth) {
              if (!(await drainHead())) return quit('cancelled');
            }
            dispatchChunk(chunkSize);
          }
        }
        // 顺手把已经算好的队首上账（更新进度 / 尽早释放正文），不阻塞
        if (!(await drainSettled())) return quit('cancelled');
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
      // 收尾：余数也派出去（不足一块照样送），再按 FIFO 把在飞的全部上账。
      // **尾块同样受窗口管**：`inflightWidth === 1` 时"派一块等一块"这条口径不能在这里破
      // （reads 结束后直接多派一块，会让 R4b 的串行口径在最后一格悄悄变成并行）。
      // `await` 之后同一纪律：世代已换就一份都不上账。
      while (bulkActive && publishQueue.length > 0) {
        while (inFlight.length >= inflightWidth) {
          if (!(await drainHead())) return quit('cancelled');
        }
        dispatchChunk(Math.min(chunkSize, publishQueue.length));
      }
      while (inFlight.length > 0) {
        if (!(await drainHead())) return quit('cancelled');
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
