/**
 * PERF-9 · 「改一棵文件」之后的**重抽/重校**成本随项目规模的形状（合成可写量例盘）。
 *
 * ## 唯一要回答的问题（BOARD §S PERF-9 判据①）
 * 真语料已知的读数只到「全命中时抽取 19–20ms（复用 2,325）」与「冷开级联 3.06–3.38s」，
 * 中间那条**没人量过**：作者只改一棵文件、下次开项目时，级联要付多少，
 * 以及这笔钱**是否随盘的大小线性涨**（＝增量化到底值不值得立项）。
 * 本文件产的就是这条数：`改一棵 ÷ 全量` 的比值，两档规模各一份。
 *
 * ## 为什么必须是可写量例盘
 * 判据要写盘（mtime+size 得真的变）⇒ 语料盘整体只读是硬约束（AGENTS §二 铁律 5），
 * 一律用 `os.tmpdir()` 下的合成盘（生成代码见 `./helpers/synth-eratw-corpus.ts`），**跑完自删**。
 * 夹具内容不入库（体积太大），仓库里只留生成代码。
 *
 * ## 一轮 = 四次开项目（同窗交替，取中位数）
 * | 轮 | 动什么 | 该看到什么 | 用来读什么 |
 * |---|---|---|---|
 * | `COLD`   | 全新内核 + 空存储 ⇒ 三份快照都不在 | 复用 0 / 全量 | 「全量」分母 |
 * | `HOT0`   | 盘上一个字节都没改 | 复用 N / 重算 0 | **纯固定税**（walk·stat·装载·聚合） |
 * | `ONE`    | 只改一棵口上 `.ERB`（追加一个函数） | 复用 N−1 / 重算 1 | 判据①的分子 |
 * | `DIGEST` | 只改一份 CHARA CSV（ERB 一个没动） | 索引仍 N−1… 复用，抽取/校验**全局判据**失效 ⇒ 复用 0 | 钉住 PITFALLS §76 那条形状 |
 *
 * `DIGEST` 就是把「快照换代一次性重建」钉成用例的那一支：以后谁把 8.3s 的一次性重算
 * 读成回退，这一条会直接给出「摘要变了 ⇒ 必然全量、且只此一次」的形状证据。
 *
 * ## 计时口径（PITFALLS §72 三条硬规矩）
 * - 一律 `performance.now()`，**同窗交替**（四个轮次在同一 rep 内依次跑，rep 之间重复），
 *   **取中位数**（不用 min：min 是重尾统计量）；
 * - **绝不跨窗比值** ⇒ 分子分母都取自同一 rep 的同一段窗口；
 * - **默认档只放轻量档**（200 棵），2,000 棵重档走 `KOJO_PERF_HEAVY=1`，
 *   否则会把同池别人的计时断言饿死。
 *
 * ## 断言口径：本批**只产数，不钉绝对阈值**
 * 没有任何 `toBeLessThan(毫秒)`。判绿锚在两件可确定的事上：
 * ①**比值可读出**（每一轮的三段都拿到正数、规模自证成立）；
 * ②**复用计数不为假**（逐轮的「复用/重算」必须等于该轮该看到的数，
 *   且各轮的抽取统计（函数数/谓词数）与 `COLD` **逐项相等**——增量路径不许偷偷少算文件）。
 * 真要立阈值，等有基线数之后由组长定。
 *
 * ## 已知口径边界（读数时要带着走的 caveat）
 * - node 桥**没有 worker 通道**（`compute.offload` 一律内联回退，日志里的「内联 N」就是它），
 *   所以这里的绝对值必然高于真壳；本批要的**比值与形状**不受影响（分子分母同一口径）。
 * - 抽取段与校验段**都挂在 `kojo.functionChanged` 上、同时起跑** ⇒ 两条分段墙钟是叠着的，
 *   不能相加。「级联合计」读的是 `project.opened → 校验有结果` 这一条链（与 STATE §二
 *   性能行的「校验有结果」同口径），不是三段之和。产品自己的 `extract breakdown` 头注
 *   早就写明这件事（「读盘/扫描/循环三段之和会大于本轮总时长」）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  ConditionIndex,
  ConditionExtractorService,
  ConventionLinterService,
  ConventionReport,
  ErbParserService,
  Logger,
} from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { createKernel, type Kernel } from '../src/kernel';
import { NodeBridge } from './helpers/node-bridge';
import { MemoryStorageBackend } from './helpers/memory-storage';
import {
  mutateInputDigest,
  mutateOneCorpusFile,
  restoreCorpusFile,
  writeSynthCorpus,
  type SynthCorpus,
} from './helpers/synth-eratw-corpus';
import { createErbParserPlugin, scanControlFlow } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { createConventionLinterPlugin } from '@kojo/plugin-convention-linter';
import { createConditionExtractorPlugin, conditionExtractorTasks } from '@kojo/plugin-condition-extractor';

const HEAVY = process.env.KOJO_PERF_HEAVY === '1';
/** 两档规模：默认档只留轻量档（重档进池会把同池计时断言饿死——PITFALLS §72） */
const TIERS = HEAVY ? [200, 2000] : [200];
/** 同窗交替的重复轮数（中位数取样；3 轮足够把首轮 JIT 冷压到中位数之外） */
const REPS = 3;

/**
 * 缩放探盘用的两个旋钮（**不是判据**，只用于复跑时换规模/换取样数；默认值就是上面的两档）：
 * `KOJO_PERF9_FILES=100,500` ／ `KOJO_PERF9_REPS=5`。
 */
const FILES_ENV = process.env.KOJO_PERF9_FILES;
const REPS_ENV = process.env.KOJO_PERF9_REPS;
const ACTIVE_TIERS = FILES_ENV ? FILES_ENV.split(',').map((s) => Number(s.trim())).filter((n) => n > 0) : TIERS;
const ACTIVE_REPS = REPS_ENV ? Math.max(1, Number(REPS_ENV)) : REPS;
const RUN_TAG = `${process.pid}-${Date.now().toString(36)}`;

/**
 * 合成盘里**口上域之外**的方言文件数（`ERB/口上・メッセージ関連/KOJO_MESSAGE.ERB` +
 * `ERB/共通/合成自定名.ERH`）。项目级索引批起索引面 = 口上根 ∪ 只读基座库根（整棵 ERB），
 * 所以「扫到多少棵 / 复用多少棵 / 抽取多少棵」的口径是 `files + LIBRARY_DIALECT_FILES`；
 * 面向作者的校验分区仍只数口上域（`files`）。
 */
const LIBRARY_DIALECT_FILES = 2;

/** 单轮四段的一把读数（全部 `performance.now()` 墙钟；ms） */
interface RoundReading {
  readonly kind: 'COLD' | 'HOT0' | 'ONE' | 'DIGEST';
  readonly files: number;
  /** `project.open()` 自身（含 adapter 吃 CSV + 扫整棵 ERB 根的 `.ERH`） */
  readonly openMs: number;
  /** project.opened → `kojo.functionChanged`（索引段整段） */
  readonly indexMs: number;
  /** → ConditionIndex 落地（自 indexMs 起算的整段，含装载与重算） */
  readonly extractMs: number;
  /** → ConventionReport 落地 */
  readonly lintMs: number;
  /* 索引段内部拆分（产品自己的 `index breakdown` 行） */
  readonly walkMs: number;
  readonly statMs: number;
  readonly snapshotMs: number;
  readonly parseMs: number;
  readonly aggregateMs: number;
  /** 反向引用扫描段（H2 批）：本轮扫了几棵、花了多久——冷建里它是索引段的另一笔大头 */
  readonly refsMs: number;
  readonly refsRescan: number;
  readonly indexReused: number;
  readonly indexTotal: number;
  /* 抽取段内部拆分（产品自己的 `extract breakdown` 行） */
  readonly loadMs: number;
  readonly readMs: number;
  readonly scanMs: number;
  readonly extractLoopMs: number;
  readonly extractReused: number;
  readonly extractRecomputed: number;
  readonly lintRecomputedFiles: number;
  readonly lintReusedRules: number;
  readonly lintRules: number;
  /** 分区复用读数（PERF-12b）：`lint breakdown` 里各分区规则 `分复用 r/t` 的 r 之和与 t（=本轮文件数） */
  readonly lintCrossReusedSum: number;
  readonly lintCrossRules: number;
  readonly lintCrossTotal: number;
  readonly lintIssues: number;
  readonly failedRules: number;
  /** 产品自报的分段时长（`ConditionIndex.durationMs` / `ConventionReport.durationMs`） */
  readonly condDurationMs: number;
  readonly lintDurationMs: number;
  /** `lint breakdown` 原文（逐规则 ms/项数，比值破线时靠这条定位是哪条规则整包重算） */
  readonly lintBreakdown: string;
  /** 逐规则耗时之和 */
  readonly lintRulesMs: number;
  /** 校验段自报时长 − 逐规则之和 ＝ 落在逐规则之外的成本（快照装载/合并 + 与抽取段抢同一事件循环） */
  readonly lintOverheadMs: number;
  /* 正确性自证（判据②「复用计数不为假」比的就是这几项） */
  readonly condFunctions: number;
  readonly condPredicates: number;
  readonly condDeps: number;
  readonly indexedFiles: number;
}

/* ============================== 产品日志读数 ============================== */

/** `  index breakdown: walk 185ms · stat 0ms · snapshot 543ms (…) · read+parse 12ms · aggregate 68ms …` */
const RE_INDEX_SEGMENTS =
  /walk (\d+)ms · stat (\d+)ms · snapshot (\d+)ms[\s\S]*?read\+parse (\d+)ms · aggregate (\d+)ms/;
const RE_INDEX_REUSED = /reused (\d+)\/(\d+)/;
/** `… · refs scan 412ms (rescan 2000, aggregate deferred) …` —— 反向引用段（本轮新读的那批才扫） */
const RE_REFS = /refs scan (\d+)ms \(rescan (\d+)/;
const RE_INDEX_LINE = /Indexed (\d+) ERB files, (\d+) distinct functions/;
/** `  extract breakdown: 装载 12ms · 读盘 3ms · 扫描 40ms（…）· 抽取循环 5ms ｜ 处理 1 文件（复用 2199）` */
const RE_EXTRACT_SEGMENTS = /装载 (\d+)ms · 读盘 (\d+)ms · 扫描 (\d+)ms[\s\S]*?抽取循环 (\d+)ms/;
const RE_EXTRACT_PROCESSED = /处理 (\d+) 文件（复用 (\d+)）/;
const RE_COND_LINE =
  /Condition index: (\d+) functions scanned, (\d+) predicates \((\d+) unparsed\), (\d+) functions with deps, (\d+) dependencies in (\d+)ms（复用 (\d+) \/ 重算 (\d+) 文件）/;
const RE_LINT_LINE = /Convention lint: (\d+) issue\(s\)[\s\S]*?in (\d+)ms across (\d+) rule\(s\)/;
const RE_LINT_FILES = /逐文件重算 (\d+) 个文件/;
/** 产品自报的分段时长与逐规则拆分（本轮那一条，取窗口内最后一次） */
const RE_COND_DURATION = /Condition index:[\s\S]*?in (\d+)ms（复用/;
const RE_LINT_DURATION = /Convention lint:[\s\S]*?in (\d+)ms across (\d+) rule\(s\)/;
const RE_LINT_BREAKDOWN = /lint breakdown: [^\n]*/g;
/** `分复用 r/t`（PERF-12b）：分区规则本轮按 mtime 复用的贡献数（t=本轮文件数） */
const RE_LINT_CROSS = /分复用 (\d+)\/(\d+)/g;

function readCrossReuse(breakdown: string): { sum: number; rules: number; total: number } {
  let sum = 0;
  let rules = 0;
  let total = 0;
  const re = new RegExp(RE_LINT_CROSS.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(breakdown)) !== null) {
    sum += Number(m[1]);
    total = Number(m[2]);
    rules++;
  }
  return { sum, rules, total };
}

/**
 * 取窗口内**最后一条**匹配（一轮里若有多次运行，最后一条才是本轮那一次）。
 * 产品日志是分段落进共享数组的，窗口按轮切；`exec` 只取首条会被上一轮的尾巴骗。
 */
function num(re: RegExp, text: string, group: number): number {
  const all = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`));
  if (!all || all.length === 0) return Number.NaN;
  const m = new RegExp(re.source, '').exec(all[all.length - 1]!);
  return m ? Number(m[group]) : Number.NaN;
}

/* ============================== 工具 ============================== */

function median(xs: number[]): number {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return Number.NaN;
  return v[Math.floor(v.length / 2)]!;
}

const ms = (n: number): string => (Number.isFinite(n) ? `${n.toFixed(1)}ms` : 'n/a');
const ratio = (a: number, b: number): string =>
  Number.isFinite(a) && Number.isFinite(b) && b > 0 ? (a / b).toFixed(3) : 'n/a';

/** 等一件异步收尾（快照落盘是 fire-and-forget）——只能拿产品日志当信号 */
async function waitForLog(logs: readonly string[], from: number, re: RegExp, deadlineMs: number): Promise<boolean> {
  const until = performance.now() + deadlineMs;
  for (;;) {
    for (let i = from; i < logs.length; i++) if (re.test(logs[i]!)) return true;
    if (performance.now() > until) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/* ============================== 一轮开项目 ============================== */

interface RoundResult {
  readonly reading: RoundReading;
  /** 本轮日志窗口 [from, to) —— 供跨轮扫描用 */
  readonly logTo: number;
}

/**
 * 跑一轮「开项目级联」：`（可选）关项目 →（可选）改盘 → 开项目`，
 * 三段达成时间全部由**产品自己的事件/订阅**打点（不额外调服务，避免二次触发级联）。
 */
async function runRound(
  kernel: Kernel,
  corpus: SynthCorpus,
  logs: string[],
  kind: RoundReading['kind'],
  opts: { mutate?: () => void; closeFirst: boolean },
): Promise<RoundResult> {
  const logFrom = logs.length;
  const wallStart = Date.now();

  const resolveGate = {
    index: null as null | ((mark: number) => void),
    extract: null as null | ((mark: number, idx: ConditionIndex) => void),
    lint: null as null | ((mark: number, rep: ConventionReport) => void),
  };
  const indexDone = new Promise<number>((res) => {
    resolveGate.index = res;
  });
  const extractDone = new Promise<{ mark: number; index: ConditionIndex }>((res) => {
    resolveGate.extract = (mark, index) => res({ mark, index });
  });
  const lintDone = new Promise<{ mark: number; report: ConventionReport }>((res) => {
    resolveGate.lint = (mark, report) => res({ mark, report });
  });

  const offs: (() => void)[] = [];
  const t0 = performance.now();
  let openMs = Number.NaN;
  try {
    if (opts.closeFirst) await kernel.project.close();
    if (opts.mutate) opts.mutate();

    const extractor = kernel.services.get<ConditionExtractorService>(WellKnownServices.ConditionExtractor);
    const linter = kernel.services.get<ConventionLinterService>(WellKnownServices.ConventionLinter);

    offs.push(
      kernel.bus.on('kojo.functionChanged', (ev) => {
        if ((ev as { projectRoot?: string }).projectRoot !== corpus.root) return;
        resolveGate.index?.(performance.now() - t0);
      }),
    );
    offs.push(
      extractor.subscribe((idx) => {
        if (!idx || idx.finishedAt <= wallStart) return;
        resolveGate.extract?.(performance.now() - t0, idx);
      }),
    );
    offs.push(
      linter.subscribe((rep) => {
        if (!rep || rep.finishedAt <= wallStart || rep.ruleCount === 0) return;
        resolveGate.lint?.(performance.now() - t0, rep);
      }),
    );

    const tOpen = performance.now();
    await kernel.project.open(corpus.root);
    openMs = performance.now() - tOpen;

    const deadlineMs = HEAVY ? 300_000 : 90_000;
    const indexMs = await withDeadline(indexDone, deadlineMs, `${kind}: kojo.functionChanged 未到达`, logs);
    const extract = await withDeadline(extractDone, deadlineMs, `${kind}: ConditionIndex 未落地`, logs);
    const lint = await withDeadline(lintDone, deadlineMs, `${kind}: ConventionReport 未落地`, logs);
    const window = logs.slice(logFrom).join('\n');

    const lintBreakdown = lastMatch(RE_LINT_BREAKDOWN, window);
    const cross = readCrossReuse(lintBreakdown);
    const lintDurationMs = num(RE_LINT_DURATION, window, 1);
    const lintRulesMs = sumRuleMs(lintBreakdown);

    const reading: RoundReading = {
      kind,
      files: corpus.files,
      openMs,
      indexMs,
      extractMs: extract.mark,
      lintMs: lint.mark,
      walkMs: num(RE_INDEX_SEGMENTS, window, 1),
      statMs: num(RE_INDEX_SEGMENTS, window, 2),
      snapshotMs: num(RE_INDEX_SEGMENTS, window, 3),
      parseMs: num(RE_INDEX_SEGMENTS, window, 4),
      aggregateMs: num(RE_INDEX_SEGMENTS, window, 5),
      indexReused: num(RE_INDEX_REUSED, window, 1),
      indexTotal: num(RE_INDEX_REUSED, window, 2),
      refsMs: num(RE_REFS, window, 1),
      refsRescan: num(RE_REFS, window, 2),
      loadMs: num(RE_EXTRACT_SEGMENTS, window, 1),
      readMs: num(RE_EXTRACT_SEGMENTS, window, 2),
      scanMs: num(RE_EXTRACT_SEGMENTS, window, 3),
      extractLoopMs: num(RE_EXTRACT_SEGMENTS, window, 4),
      extractReused: num(RE_EXTRACT_PROCESSED, window, 2),
      extractRecomputed: num(RE_EXTRACT_PROCESSED, window, 1),
      lintRecomputedFiles: num(RE_LINT_FILES, window, 1),
      lintReusedRules: countMatches(window, /\(复用\)/g),
      lintCrossReusedSum: cross.sum,
      lintCrossRules: cross.rules,
      lintCrossTotal: cross.total,
      lintRules: num(RE_LINT_LINE, window, 3),
      lintIssues: num(RE_LINT_LINE, window, 1),
      failedRules: lint.report.failedRules.length,
      condDurationMs: num(RE_COND_DURATION, window, 1),
      lintDurationMs,
      lintBreakdown,
      lintRulesMs,
      lintOverheadMs: Number.isFinite(lintDurationMs) ? lintDurationMs - lintRulesMs : Number.NaN,
      condFunctions: extract.index.stats.functions,
      condPredicates: extract.index.stats.predicates,
      condDeps: extract.index.stats.dependencies,
      indexedFiles: num(RE_INDEX_LINE, window, 1),
    };

    /* 快照落盘是 fire-and-forget：下一轮的「复用」全靠它 ⇒ 收口前必须等齐。
     * 但三段各自都写着「本轮没重算任何东西就不写」（`snapshotDirty` / `computed.size > 0` /
     * `recomputedFiles > 0 || 有规则未复用`）⇒ **等哪一段要看本轮读到的重算数**：
     * 零改动轮（HOT0）与「只改非 ERB 输入」轮（DIGEST 的索引段）本来就不该有 saved 行，
     * 无条件等就是自己把自己吊死。游标用**本轮起点** logFrom——索引的 saved 行早在
     * 抽取/校验跑完之前就进数组了，拿 `logs.length` 当起点会把它跳过。 */
    const pendingWaits: Array<Promise<boolean>> = [];
    if (reading.indexReused < reading.indexTotal) {
      pendingWaits.push(waitForLog(logs, logFrom, /Index snapshot saved/, 30_000));
    }
    if (reading.extractRecomputed > 0) {
      pendingWaits.push(waitForLog(logs, logFrom, /Condition snapshot saved/, 30_000));
    }
    if (reading.lintRecomputedFiles > 0 || reading.lintReusedRules < reading.lintRules) {
      pendingWaits.push(waitForLog(logs, logFrom, /Convention snapshot saved/, 30_000));
    }
    const saved = await Promise.all(pendingWaits);
    if (saved.some((ok) => !ok)) {
      throw new Error(
        `${kind}: 本轮确实重算了东西（索引 ${reading.indexTotal - reading.indexReused} 棵 / ` +
          `抽取 ${reading.extractRecomputed} 棵 / 校验逐文件 ${reading.lintRecomputedFiles} 棵），` +
          `但快照落盘 30s 内没收口 ⇒ 下一轮的复用判据会失真`,
      );
    }
    return { reading, logTo: logs.length };
  } finally {
    for (const off of offs) {
      try {
        off();
      } catch {
        /* 退订失败不影响读数 */
      }
    }
  }
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

/** 窗口内最后一条整行匹配（本轮那一次的拆分；上一轮的尾巴在窗口外） */
function lastMatch(re: RegExp, text: string): string {
  const all = text.match(re.flags.includes('g') ? re : new RegExp(re.source, `${re.flags}g`));
  return all && all.length > 0 ? all[all.length - 1]! : '';
}

/** `lint breakdown` 行里逐规则耗时之和（差额＝逐规则之外：快照装载/合并 + 与抽取段争用同一事件循环） */
function sumRuleMs(breakdown: string): number {
  let sum = 0;
  const re = /(\d+)ms\/\d+项/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(breakdown)) !== null) sum += Number(m[1]);
  return sum;
}

async function withDeadline<T>(p: Promise<T>, deadlineMs: number, what: string, logs: readonly string[]): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      rej(new Error(`${what}（${deadlineMs}ms 内）；末 6 行日志：\n${logs.slice(-6).join('\n')}`));
    }, deadlineMs);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ============================== 一档规模 ============================== */

async function measureTier(files: number): Promise<RoundReading[]> {
  const root = mkdtempSync(nodeJoin(tmpdir(), `kojo-perf9-${RUN_TAG}-${files}-`));
  const readings: RoundReading[] = [];
  try {
    const corpus = writeSynthCorpus(root, { files });
    // eslint-disable-next-line no-console
    console.log(
      `[perf9][盘] ${files} 棵口上 ERB · ${corpus.functions} 函数 · ${corpus.lines} 行 · ` +
        `${(corpus.bytes / 1048576).toFixed(1)} MiB（真语料口径 2,325 棵 / 99,228 函数 / 1,040 行每棵）`,
    );

    for (let rep = 0; rep < ACTIVE_REPS; rep++) {
      // 每 rep 一具全新内核：存储清零 ⇒ COLD 一定是「三份快照都不在」的真全量
      const appData = mkdtempSync(nodeJoin(tmpdir(), `kojo-perf9-app-${RUN_TAG}-${files}-${rep}-`));
      const logs: string[] = [];
      const logger: Logger = {
        debug: (m) => logs.push(String(m)),
        info: (m) => logs.push(String(m)),
        warn: (m) => logs.push(String(m)),
        error: (m) => logs.push(String(m)),
      };
      const kernel = await createKernel({
        platform: new NodeBridge(appData),
        plugins: [
          createErbParserPlugin(),
          createEratwAdapterPlugin(),
          createConventionLinterPlugin(),
          createConditionExtractorPlugin(),
        ],
        storageBackend: new MemoryStorageBackend(),
        logger,
      });
      // 宿主装配（与 app/bootstrap 同构）：node 桥无 worker 通道，条件抽取的
      // `condition.extractFile` 任务（PS-11 起主循环每文件一条）需要本地实现兜底，
      // 不注册则 offload 抛错、抽取全 skip（condFunctions 归零）。
      for (const [kind, impl] of Object.entries(conditionExtractorTasks(scanControlFlow))) {
        kernel.compute.registerTask(kind, impl as never);
      }
      await kernel.start();
      try {
        const cold = await runRound(kernel, corpus, logs, 'COLD', { closeFirst: false });
        // HOT0：盘上一个字节都没改 ⇒ 只该付固定税（walk·stat·装载·聚合）
        const hot0 = await runRound(kernel, corpus, logs, 'HOT0', { closeFirst: true });
        // ONE：只改一棵（插一行正文批注 ⇒ mtime 与 size 双变；不加函数不改谓词数）
        // 取样点按 rep 散开（都改第 0 棵会让「目录缓存热不热」混进读数）
        const victim = corpus.erbPaths[(rep * 7919) % corpus.erbPaths.length]!;
        const one = await runRound(kernel, corpus, logs, 'ONE', {
          closeFirst: true,
          mutate: () => mutateOneCorpusFile(victim, `${files}-${rep}`),
        });
        // DIGEST：只改一份 CHARA CSV ⇒ 非 ERB 输入摘要变 ⇒ 派生缓存全局判据失效（PITFALLS §76）
        const digest = await runRound(kernel, corpus, logs, 'DIGEST', {
          closeFirst: true,
          mutate: () => mutateInputDigest(corpus.charaCsvPath, `${files}-${rep}`),
        });
        readings.push(cold.reading, hot0.reading, one.reading, digest.reading);

        // 还原被改的那一棵，保证下一 rep 的盘内容与上一 rep 逐字节一致
        restoreCorpusFile(victim, corpus.originals.get(victim)!);
      } finally {
        await kernel.stop();
        rmSync(appData, { recursive: true, force: true });
      }
    }
    return readings;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* ============================== 报告 ============================== */

function reportTier(readings: RoundReading[]): void {
  const byKind = (k: RoundReading['kind']): RoundReading[] => readings.filter((r) => r.kind === k);
  const fmt = (r: RoundReading): string =>
    `[perf9][${r.kind}] 盘 ${r.files} 棵 ｜ open ${ms(r.openMs)} · index ${ms(r.indexMs)}` +
    `（walk ${ms(r.walkMs)}/stat ${ms(r.statMs)}/snapshot ${ms(r.snapshotMs)}/parse ${ms(r.parseMs)}/agg ${ms(r.aggregateMs)}/refs ${ms(r.refsMs)}` +
    ` 复用 ${r.indexReused}/${r.indexTotal}）` +
    ` · extract ${ms(r.extractMs - r.indexMs)}（装载 ${ms(r.loadMs)}/读盘 ${ms(r.readMs)}/扫描 ${ms(r.scanMs)}/循环 ${ms(r.extractLoopMs)}` +
    ` 复用 ${r.extractReused} / 重算 ${r.extractRecomputed}）` +
    ` · lint ${ms(r.lintMs - r.indexMs)}（规则复用 ${r.lintReusedRules}/${r.lintRules}、逐文件重算 ${r.lintRecomputedFiles}、` +
    `跨文件分复用 ${r.lintCrossReusedSum}/${r.lintCrossRules * r.lintCrossTotal}${r.lintCrossRules ? `（${r.lintCrossRules} 条×${r.lintCrossTotal} 棵）` : ''}）` +
    ` ｜ 函数 ${r.condFunctions} 谓词 ${r.condPredicates} 依赖 ${r.condDeps} 问题 ${r.lintIssues}` +
    ` ｜ 自报 抽取 ${ms(r.condDurationMs)} 校验 ${ms(r.lintDurationMs)}` +
    `（逐规则 ${ms(r.lintRulesMs)} / 规则外 ${ms(r.lintOverheadMs)}）\n` +
    `      ${r.lintBreakdown}`;
  for (const r of readings) {
    // eslint-disable-next-line no-console
    console.log(fmt(r));
  }

  const med = (k: RoundReading['kind'], pick: (r: RoundReading) => number): number =>
    median(byKind(k).map(pick));
  const cold = {
    index: med('COLD', (r) => r.indexMs),
    extract: med('COLD', (r) => r.extractMs - r.indexMs),
    lint: med('COLD', (r) => r.lintMs - r.indexMs),
    total: med('COLD', (r) => r.lintMs),
  };
  const one = {
    index: med('ONE', (r) => r.indexMs),
    extract: med('ONE', (r) => r.extractMs - r.indexMs),
    lint: med('ONE', (r) => r.lintMs - r.indexMs),
    total: med('ONE', (r) => r.lintMs),
  };
  const hot0 = {
    index: med('HOT0', (r) => r.indexMs),
    extract: med('HOT0', (r) => r.extractMs - r.indexMs),
    lint: med('HOT0', (r) => r.lintMs - r.indexMs),
    total: med('HOT0', (r) => r.lintMs),
  };
  const digest = {
    index: med('DIGEST', (r) => r.indexMs),
    extract: med('DIGEST', (r) => r.extractMs - r.indexMs),
    lint: med('DIGEST', (r) => r.lintMs - r.indexMs),
    total: med('DIGEST', (r) => r.lintMs),
  };
  // eslint-disable-next-line no-console
  console.log(
    `[perf9][中位数] 盘 ${readings[0]!.files} 棵（${ACTIVE_REPS} 轮同窗交替）\n` +
      `  COLD   index ${ms(cold.index)} · extract ${ms(cold.extract)} · lint ${ms(cold.lint)}（级联合计 ${ms(cold.total)}）\n` +
      `  HOT0   index ${ms(hot0.index)} · extract ${ms(hot0.extract)} · lint ${ms(hot0.lint)}（合计 ${ms(hot0.total)}）\n` +
      `  ONE    index ${ms(one.index)} · extract ${ms(one.extract)} · lint ${ms(one.lint)}（合计 ${ms(one.total)}）\n` +
      `  DIGEST index ${ms(digest.index)} · extract ${ms(digest.extract)} · lint ${ms(digest.lint)}（合计 ${ms(digest.total)}）\n` +
      `[perf9][比值 改一棵 ÷ 全量] index ${ratio(one.index, cold.index)} · extract ${ratio(one.extract, cold.extract)}` +
      ` · lint ${ratio(one.lint, cold.lint)} · 级联合计 ${ratio(one.total, cold.total)}\n` +
      `[perf9][比值 零改动 ÷ 全量] index ${ratio(hot0.index, cold.index)} · extract ${ratio(hot0.extract, cold.extract)}` +
      ` · lint ${ratio(hot0.lint, cold.lint)} —— 这一行就是「改一棵也躲不掉的固定税」占全量的比例\n` +
      `[perf9][比值 改摘要 ÷ 全量] index ${ratio(digest.index, cold.index)} · extract ${ratio(digest.extract, cold.extract)}` +
      ` · lint ${ratio(digest.lint, cold.lint)} —— 摘要换代＝一次性全量，形状应与 COLD 同形\n` +
      `[perf9][分区复用（PERF-12b 判据②）] ONE 轮分区规则 ${med('ONE', (r) => r.lintCrossRules)} 条，` +
      `共复用 ${med('ONE', (r) => r.lintCrossReusedSum)}/${med('ONE', (r) => r.lintCrossRules * r.lintCrossTotal)} 份跨文件贡献` +
      `（COLD ${med('COLD', (r) => r.lintCrossReusedSum)} 份、DIGEST ${med('DIGEST', (r) => r.lintCrossReusedSum)} 份——都该是 0）\n` +
      `[perf9][固定税拆分] 改一棵轮里**一件都没重算也照样付**的那几段（中位数）：` +
      `walk ${ms(med('ONE', (r) => r.walkMs))}（全量 ${ms(med('COLD', (r) => r.walkMs))}）· ` +
      `快照装载 ${ms(med('ONE', (r) => r.snapshotMs))} · 索引聚合 ${ms(med('ONE', (r) => r.aggregateMs))} · ` +
      `抽取装载 ${ms(med('ONE', (r) => r.loadMs))} · refs ${ms(med('ONE', (r) => r.refsMs))}（重扫 ${med('ONE', (r) => r.refsRescan)} 棵）· ` +
      `校验逐规则 ${ms(med('ONE', (r) => r.lintRulesMs))}／规则外 ${ms(med('ONE', (r) => r.lintOverheadMs))}` +
      `（全量 ${ms(med('COLD', (r) => r.lintRulesMs))}／${ms(med('COLD', (r) => r.lintOverheadMs))}）`,
  );
}

/* ============================== 用例 ============================== */

describe('PERF-9 改一棵的重抽/重校成本随规模的形状（合成可写量例盘）', () => {
  for (const files of ACTIVE_TIERS) {
    it(
      `${files} 棵：COLD / HOT0 / ONE / DIGEST 四段读数 + 改一棵÷全量 比值`,
      async () => {
        const readings = await measureTier(files);
        expect(readings.length).toBe(ACTIVE_REPS * 4);
        // 索引面 = 口上根 ∪ 只读基座库根（整棵 ERB）：合成盘里口上域之外还有
        // `ERB/口上・メッセージ関連/KOJO_MESSAGE.ERB`（路由总表）与
        // `ERB/共通/合成自定名.ERH`（作者自定名表），这两份也计入 `Indexed N ERB files`
        // 与 `reused r/t`、并参与抽取 ⇒ 口径是 `files + LIBRARY_DIALECT_FILES`。
        const indexed = files + LIBRARY_DIALECT_FILES;

        for (const r of readings) {
          // —— 判据①「比值可读出」：三段都拿到正数，产品自己的分段读数也拿到了
          for (const v of [r.openMs, r.indexMs, r.extractMs, r.lintMs]) {
            expect(Number.isFinite(v) && v > 0).toBe(true);
          }
          // —— 规模自证：这一档真的扫到了这么多棵（含基座库那两份），而且真的不是玩具盘
          expect(r.indexedFiles).toBe(indexed);
          expect(r.condFunctions).toBeGreaterThan(files * 20);
          // —— 内核不静默（AGENTS §二 铁律 4）：任何一轮都不许有规则静默失败
          expect(r.failedRules).toBe(0);
          // —— 复用计数不为假的另一半：各轮统计必须与全量逐项相等（增量不许漏文件）
          if (r.kind !== 'COLD') {
            const cold = readings.find((x) => x.kind === 'COLD' && x.files === r.files)!;
            expect(r.condFunctions).toBe(cold.condFunctions);
            expect(r.condPredicates).toBe(cold.condPredicates);
            expect(r.condDeps).toBe(cold.condDeps);
            expect(r.lintIssues).toBe(cold.lintIssues);
          }
        }

        const cold = readings.find((r) => r.kind === 'COLD')!;
        const hot0 = readings.find((r) => r.kind === 'HOT0')!;
        const one = readings.find((r) => r.kind === 'ONE')!;
        const digest = readings.find((r) => r.kind === 'DIGEST')!;

        // —— 判据②：逐轮的「复用/重算」必须等于该轮该看到的数（索引/抽取面含基座库）
        expect(cold.indexReused).toBe(0);
        expect(cold.indexTotal).toBe(indexed);
        expect(cold.extractReused).toBe(0);
        expect(cold.extractRecomputed).toBe(indexed);

        // 零改动：三段全命中，重算 0 棵（这就是「复用不为假」最强的一条反证）
        expect(hot0.indexReused).toBe(indexed);
        expect(hot0.extractReused).toBe(indexed);
        expect(hot0.extractRecomputed).toBe(0);

        // 改一棵：索引与抽取都只该重算那一棵
        expect(one.indexReused).toBe(indexed - 1);
        expect(one.indexTotal).toBe(indexed);
        expect(one.extractReused).toBe(indexed - 1);
        expect(one.extractRecomputed).toBe(1);

        // 改摘要：ERB 一个没动 ⇒ 索引仍按文件复用；抽取/校验的全局判据失效 ⇒ 一次性全量
        expect(digest.indexReused).toBe(indexed);
        expect(digest.extractReused).toBe(0);
        expect(digest.extractRecomputed).toBe(indexed);

        // —— 判据②（PERF-12b 追加）：跨文件分区复用读数
        // COLD：分区路径全量建贡献（复用 0，但规则确实走了分区）；本轮装配了 4 条分区规则
        expect(cold.lintCrossRules).toBe(4);
        expect(cold.lintCrossTotal).toBe(files);
        expect(cold.lintCrossReusedSum).toBe(0);
        // HOT0：整包复用快路径 ⇒ 分区根本不进（不是"分区没生效"，是更快的路径）
        expect(hot0.lintCrossRules).toBe(0);
        // ONE：4 条分区规则各自复用 files−1 份贡献（改一棵 ⇒ 只重算那一棵）——"0/7 整包重算"的反证
        expect(one.lintCrossRules).toBe(4);
        expect(one.lintCrossTotal).toBe(files);
        expect(one.lintCrossReusedSum).toBe(4 * (files - 1));
        // DIGEST：全局判据变 ⇒ 分区与桶一起作废（一次性全量，形状与 COLD 同）
        expect(digest.lintCrossRules).toBe(4);
        expect(digest.lintCrossReusedSum).toBe(0);

        reportTier(readings);
      },
      HEAVY ? 1_800_000 : 600_000,
    );
  }
});
