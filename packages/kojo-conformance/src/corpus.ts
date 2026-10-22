/**
 * 真实语料机（K2-CORPUS-REAL）——把迁移 differential 接到**真实语料目录**。
 *
 * 与 `migration.ts` 的分工：
 * - `migration.ts` 的语料是**仓内受控语料**（`<id>.v1.kojo.txt` + manifest + 双 golden），
 *   每份都有期望状态，错了就红；
 * - 本模块的语料是**真实目录**（语料机/作者工程）：目录名会变、可能整目录暂离、文件数不封顶，
 *   所以口径不同——**发现 → 逐份迁移 + 两侧编译 → 只报告、不判定**（真实语料没有"期望状态"，
 *   把 `differs` / `blocked` 当失败等于让一个必然有缺口的读数永远红）。
 *
 * 但"只报告"不等于"全绿"：
 * - **语料不在位 = SKIP（rc=2），不是 0 cases 通过**；缺席证据来自语料解析链
 *   （`KOJO_CORPUS_DIR` / `tools/corpus.mjs --print`，由宿主注入，本模块不读 `process.env`）；
 * - **目录在位但一份 `.kojo` 都没有 = rc=1**（真实语料机的 ERB 盘本来就没有 v1 作者源，
 *   这不是"干净"，是"没有可迁移对象"）；
 * - 单份读不出来 / 写盘失败 = rc=1，并把问题逐条上屏。
 *
 * ## 设计边界
 *
 * 纯逻辑：发现、状态聚合、抽样、manifest 生成、CLI 解析全部在这里；**所有 IO 与哈希都注入**
 * （`CorpusIo` / `CorpusHasher`），本模块不 import `node:fs` / `node:crypto`、不碰 `process`。
 * 宿主（`tools/kojo-conformance.mjs`）负责把真目录、真编译器、真迁移器、`node:crypto` 装进来。
 *
 * ## 状态口径
 *
 * 逐份产出的状态与 `migrate-diff` 同构（`identical` / `normalized-equal` / `differs` / `blocked`），
 * `blocked` 的原因映射到语料机词表：
 *
 * | 语料机原因 | 来源（migration.ts） | 含义 |
 * |---|---|---|
 * | `v1-compile-failed` | 同名 | v1 侧编不出来 ⇒ 没有可比基线 |
 * | `migration-unsupported` | 同名 | 迁移台账非空 ⇒ 2.0 源不是可编译形态 |
 * | `2.0-compile-failed` | `v2-compile-failed` | 迁移产物仍编不过（**红灯**，不是正常缺口） |
 * | `migration-error` | 同名 | 迁移器抛错（坏了，不是"报 unsupported"） |
 *
 * 聚合率只有一条口径：`可迁移 / 总数` = `readings.migration.ok` 的份数 / 参与迁移的份数。
 * 它**不受** v1 编译成功与否影响（迁移与 v1 编译是两条独立链路），也**不是**"两侧产物相同"率。
 * 报告同时给 `unmigratable = total - migratable`（与可迁移相加恒等于总数），以及**主因**分组计数
 * （单因分类沿用 migrate-diff 的优先级，故 `migration-unsupported` 组份数 ≠ `unmigratable`——
 * "v1 编不出且迁移也失败"的份数记在 v1 名下；两个账本分开看，别混）。
 */

import {
  runMigrationDifferential,
  type MigrationBlockedReason,
  type MigrationCase,
  type MigrationCaseReadings,
  type MigrationClassifier,
  type MigrationDiffLine,
  type MigrationMigrator,
  type MigrationStatus,
  type MigrationV1Compiler,
  type MigrationV2Compiler,
} from './migration.js';

/* ============================== 0. 常量与路径 ============================== */

/** v1 作者源后缀（真实语料里"可迁移对象"的唯一判据） */
export const V1_SOURCE_SUFFIX = '.kojo';
/** 2.0 源后缀：明确排除（`.kojo2` 不是迁移输入） */
export const V2_SOURCE_SUFFIX = '.kojo2';

/** `--generate-manifest` 默认抽样上限（真实语料可上万份，抽样是**回归样本**不是全集） */
export const DEFAULT_SAMPLE_SIZE = 60;

/**
 * 真实语料抽样 fixture 的落点（相对仓库根；宿主拼绝对路径后注入）。
 *
 * 与合成语料目录 `SYNTHETIC_CORPUS_DIR` 分开：`--generate-manifest` **只**写这里，
 * 绝不覆盖合成语料的 `manifest.json`（那是 29 份手写期望的唯一真源）。
 */
export const REAL_CORPUS_DIR = 'packages/kojo-core/tests/fixtures/migrate-corpus-real';
export const SYNTHETIC_CORPUS_DIR = 'packages/kojo-core/tests/fixtures/migrate-corpus';
/** 真实语料抽样 manifest 的 schema（与合成语料 `kojo-migration-corpus/1` 分开） */
export const REAL_CORPUS_SCHEMA = 'kojo-migration-corpus-real/1';
/** 抽样副本的溯源文件后缀 */
export const REAL_V1_SUFFIX = '.v1.kojo.txt';
export const REAL_META_SUFFIX = '.meta.json';
export const REAL_MANIFEST_NAME = 'manifest.json';

const BOM_CODE_POINT = 0xfeff;

/** 反斜杠归一为 `/`；根尾斜杠去掉（盘符根 `D:/` 保留） */
function normalizeDir(dir: string): string {
  const slashed = dir.replaceAll('\\', '/');
  if (slashed === '') return '';
  if (slashed === '/') return '/';
  const trimmed = slashed.replace(/\/+$/, '');
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}/`;
  return trimmed;
}

function normalizeRelPath(entry: string): string {
  let value = entry.replaceAll('\\', '/');
  while (value.startsWith('./')) value = value.slice(2);
  while (value.startsWith('/')) value = value.slice(1);
  return value;
}

function joinPath(dir: string, rel: string): string {
  if (dir === '' || dir === '.') return rel;
  return dir.endsWith('/') ? `${dir}${rel}` : `${dir}/${rel}`;
}

/** 码点序（与 locale 无关；报告 case 序 = 路径序） */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const encodeUtf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/* ============================== 1. IO 端口 ============================== */

/**
 * 注入的 IO 端口（宿主给真文件系统；测试给内存实现）。
 *
 * - `listFiles` 返回**相对路径**（可 `/` 或 `\`），语义与 `migration.ts` 的同名端口一致；
 *   目录不存在 / 不可读时**必须抛错**（缺席判据靠它，不许静默返回空数组）；
 * - `readBytes` / `writeBytes` 是字节面（保真副本 + sha256）；缺省时退化为 UTF-8 文本编码，
 *   语义等价于"文件是合法 UTF-8"这一真实前提（非法字节序的源不是迁移输入）；
 * - `mkdir` 缺省 = 宿主不支持建目录，`--generate-manifest` 报错而不是猜路径。
 */
export interface CorpusIo {
  readonly listFiles: (dir: string) => readonly string[];
  readonly readText: (path: string) => string;
  readonly readBytes?: (path: string) => Uint8Array;
  readonly writeText?: (path: string, text: string) => void;
  readonly writeBytes?: (path: string, bytes: Uint8Array) => void;
  readonly mkdir?: (dir: string) => void;
}

/** 哈希端口：输入**字节**，输出小写十六进制 sha256（`node:crypto` 由宿主注入） */
export type CorpusHasher = (bytes: Uint8Array) => string;

/* ============================== 2. 发现 ============================== */

/** 一次发现的结果（`total` = 截断前份数；`selected` = 实际参与本次的份数） */
export interface CorpusDiscovery {
  readonly root: string;
  readonly total: number;
  readonly selected: readonly string[];
  readonly limit: number | null;
  readonly truncated: boolean;
}

export interface DiscoverCorpusOptions {
  readonly io: Pick<CorpusIo, 'listFiles'>;
  /** 上限（正整数）；`null` / 缺省 = 不截断 */
  readonly limit?: number | null;
}

function assertLimit(limit: number | null): void {
  if (limit === null) return;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`--limit 必须是正整数（收到 ${String(limit)}）`);
  }
}

/** v1 源判据：`.kojo` 结尾、`.kojo2` 不算（大小写不敏感；Windows 盘面两种都见过） */
function isV1SourcePath(rel: string): boolean {
  const lower = rel.toLowerCase();
  if (lower.endsWith(V2_SOURCE_SUFFIX)) return false;
  return lower.endsWith(V1_SOURCE_SUFFIX);
}

/**
 * 递归发现语料根下的 v1 `.kojo` 源（相对路径、去重、码点序、按 `limit` 截断）。
 *
 * 递归由 `io.listFiles` 的契约承担（真实宿主一跳到底；测试可给任意形状），
 * 本函数只做**筛选 + 稳定排序 + 截断**——排序必须在截断之前，否则"稳定抽样"无从谈起。
 *
 * `listFiles` 抛错 = 语料不在位（调用方转 SKIP，不许当成 0 份）。
 */
export function discoverCorpus(root: string, options: DiscoverCorpusOptions): CorpusDiscovery {
  const limit = options.limit ?? null;
  assertLimit(limit);
  const normalizedRoot = normalizeDir(root);
  const listed = options.io.listFiles(normalizedRoot);
  const unique = new Set<string>();
  for (const entry of listed) {
    const rel = normalizeRelPath(entry);
    if (rel.length === 0) continue;
    if (!isV1SourcePath(rel)) continue;
    unique.add(rel);
  }
  const all = [...unique].sort(compareCodeUnits);
  const selected = limit === null ? all : all.slice(0, limit);
  return {
    root: normalizedRoot,
    total: all.length,
    selected: Object.freeze(selected),
    limit,
    truncated: selected.length < all.length,
  };
}

/* ============================== 3. 逐份 case 与聚合 ============================== */

/** 语料机 blocked 原因（与 `migration.ts` 一一对应，`v2-compile-failed` 改叫 `2.0-compile-failed`） */
export type CorpusBlockedReason =
  | 'migration-unsupported'
  | 'v1-compile-failed'
  | '2.0-compile-failed'
  | 'migration-error';

/** EOL 档（`mixed` = CRLF 与裸 LF/CR 混用：真实作者文件常见，如实报） */
export type CorpusEol = 'lf' | 'crlf' | 'mixed';

/** 一条语料问题（读不出 / 目标非法 / 空语料；CLI 失败清单） */
export type CorpusProblemKind = 'io' | 'empty' | 'target' | 'corpus';

export interface CorpusProblem {
  readonly id: string;
  readonly kind: CorpusProblemKind;
  readonly message: string;
}

/** 单份语料读数（状态 + 身份 + 差异摘要；产物全文按 `json` 可选） */
export interface CorpusCaseReport {
  /** 语料根下的相对路径（`/` 归一；报告序 = 路径序） */
  readonly id: string;
  readonly status: MigrationStatus;
  /** 原始 blocked 原因（`migration.ts` 词表） */
  readonly blockedReason: MigrationBlockedReason | null;
  /** 语料机分类（`null` = 非 blocked） */
  readonly reason: CorpusBlockedReason | null;
  readonly bytes: number;
  readonly sha256: string;
  readonly eol: CorpusEol;
  readonly bom: boolean;
  readonly diff: {
    readonly removed: number;
    readonly added: number;
    readonly firstDifference: MigrationDiffLine | null;
  };
  readonly readings: MigrationCaseReadings;
  /** 证据（非 `--json` 口径才带；产物全文可能很大） */
  readonly products?: {
    readonly v1: string | null;
    readonly migrated: string | null;
    readonly v2: string | null;
  };
}

/** 状态分布（与 migrate-diff 同构，原因用**语料机词表**） */
export interface CorpusSummary {
  readonly cases: number;
  readonly identical: number;
  readonly normalizedEqual: number;
  readonly differs: number;
  readonly blocked: number;
  readonly blockedByReason: readonly CorpusReasonCount[];
}

export interface CorpusReasonCount {
  readonly reason: CorpusBlockedReason;
  readonly cases: number;
}

/** 聚合率：可迁移份数 / 参与迁移份数；按 blocked 原因分组计数 */
export interface CorpusRateReport {
  readonly total: number;
  /** `readings.migration.ok === true` 的份数（迁移器产出了可编译形态的 2.0 源） */
  readonly migratable: number;
  /** `migratable / total`（total = 0 时为 0，不造 1.0） */
  readonly rate: number;
  /** `total - migratable`：迁移台账非空或迁移器抛错的份数（与 `migratable` 相加恒等于 `total`） */
  readonly unmigratable: number;
  /**
   * **主因**归到 `migration-unsupported` 的份数。
   *
   * 与 `unmigratable` 是两个口径、可能不等：blocked 主因沿用 migrate-diff 的单因优先级
   * （v1 编不出 > 迁移 unsupported），所以"v1 编不出且迁移也失败"的份数记在
   * `v1-compile-failed` 名下。**别把它当迁移失败总数**——那看 `unmigratable`。
   */
  readonly unsupportedCases: number;
  readonly byReason: readonly CorpusReasonCount[];
}

export interface CorpusMigrationResult {
  /** `cases.length > 0 && problems.length === 0` */
  readonly ok: boolean;
  readonly root: string;
  readonly discovery: CorpusDiscovery;
  readonly cases: readonly CorpusCaseReport[];
  readonly summary: CorpusSummary;
  readonly rate: CorpusRateReport;
  readonly problems: readonly CorpusProblem[];
}

export interface RunCorpusMigrationOptions {
  readonly root: string;
  /** 已发现清单（缺省 = `discoverCorpus`；宿主已扫过一遍时直接传，避免二次遍历真实盘） */
  readonly files?: readonly string[];
  /** 已发现结果（带上则原样用于报告，含 total/limit/truncated） */
  readonly discovery?: CorpusDiscovery;
  readonly compileV1: MigrationV1Compiler;
  readonly compile2: MigrationV2Compiler;
  readonly migrate: MigrationMigrator;
  readonly limit?: number | null;
  /** `true` = JSON 口径：逐份不带产物全文（报告体量可控） */
  readonly json?: boolean;
  readonly io: CorpusIo;
  readonly sha256: CorpusHasher;
  readonly classify?: MigrationClassifier;
}

/** `migration.ts` 原因 → 语料机词表 */
export function corpusReasonOf(reason: MigrationBlockedReason | null): CorpusBlockedReason | null {
  if (reason === null) return null;
  return reason === 'v2-compile-failed' ? '2.0-compile-failed' : reason;
}

interface CorpusFileFacts {
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly eol: CorpusEol;
  readonly bom: boolean;
}

function eolOf(text: string): CorpusEol {
  const hasCrlf = text.includes('\r\n');
  const withoutCrlf = text.replace(/\r\n/g, '');
  const hasLoneLf = withoutCrlf.includes('\n');
  const hasLoneCr = withoutCrlf.includes('\r');
  if (hasCrlf && (hasLoneLf || hasLoneCr)) return 'mixed';
  return hasCrlf ? 'crlf' : 'lf';
}

function readFacts(io: CorpusIo, hasher: CorpusHasher, absolute: string): CorpusFileFacts {
  const text = io.readText(absolute);
  const bytes = io.readBytes === undefined ? encodeUtf8(text) : io.readBytes(absolute);
  return {
    text,
    bytes,
    sha256: hasher(bytes),
    eol: eolOf(text),
    bom: text.charCodeAt(0) === BOM_CODE_POINT,
  };
}

function countByReason(cases: readonly CorpusCaseReport[]): readonly CorpusReasonCount[] {
  const tally = new Map<CorpusBlockedReason, number>();
  for (const item of cases) {
    if (item.reason === null) continue;
    tally.set(item.reason, (tally.get(item.reason) ?? 0) + 1);
  }
  return Object.freeze(
    [...tally.entries()]
      .map(([reason, casesCount]) => ({ reason, cases: casesCount }))
      .sort((left, right) => right.cases - left.cases || compareCodeUnits(left.reason, right.reason)),
  );
}

function summarizeCorpus(cases: readonly CorpusCaseReport[]): CorpusSummary {
  const counts = { identical: 0, normalizedEqual: 0, differs: 0, blocked: 0 };
  for (const item of cases) {
    if (item.status === 'identical') counts.identical++;
    else if (item.status === 'normalized-equal') counts.normalizedEqual++;
    else if (item.status === 'differs') counts.differs++;
    else counts.blocked++;
  }
  return {
    cases: cases.length,
    identical: counts.identical,
    normalizedEqual: counts.normalizedEqual,
    differs: counts.differs,
    blocked: counts.blocked,
    blockedByReason: countByReason(cases),
  };
}

function rateOf(cases: readonly CorpusCaseReport[]): CorpusRateReport {
  const total = cases.length;
  const migratable = cases.filter((item) => item.readings.migration.ok).length;
  return {
    total,
    migratable,
    rate: total === 0 ? 0 : migratable / total,
    unmigratable: total - migratable,
    unsupportedCases: cases.filter((item) => item.reason === 'migration-unsupported').length,
    byReason: countByReason(cases),
  };
}

/**
 * 跑一批真实语料的迁移对拍（只报告、不判定）。
 *
 * 流程：发现（未给 `files`/`discovery` 时）→ 逐份读源（读不出的进问题清单，不中断整批）→
 * 复用 `runMigrationDifferential` 完成"迁移 + v1 编译 + 2.0 编译 + 状态判定" →
 * 映射成语料机报告（相对路径为 id、字节/哈希/EOL/BOM 一并记账）。
 */
export function runCorpusMigration(options: RunCorpusMigrationOptions): CorpusMigrationResult {
  const discovery: CorpusDiscovery =
    options.discovery ??
    (options.files === undefined
      ? discoverCorpus(options.root, { io: options.io, limit: options.limit ?? null })
      : {
          root: normalizeDir(options.root),
          total: options.files.length,
          selected: Object.freeze([...new Set(options.files.map(normalizeRelPath))]),
          limit: options.limit ?? null,
          truncated: false,
        });

  const includeProducts = options.json !== true;
  const problems: CorpusProblem[] = [];
  const inputs: MigrationCase[] = [];
  const facts = new Map<string, CorpusFileFacts>();
  for (const rel of discovery.selected) {
    const absolute = joinPath(discovery.root, rel);
    try {
      const item = readFacts(options.io, options.sha256, absolute);
      facts.set(rel, item);
      inputs.push({ id: rel, source: item.text });
    } catch (error: unknown) {
      problems.push({ id: rel, kind: 'io', message: `读取 ${absolute} 失败：${errorMessage(error)}` });
    }
  }
  if (inputs.length === 0) {
    problems.push({
      id: '(empty)',
      kind: 'empty',
      message: `语料目录 ${discovery.root} 里没有可读的 ${V1_SOURCE_SUFFIX} v1 源（发现 ${discovery.total} 份）`,
    });
  }

  const differential = runMigrationDifferential({
    cases: inputs,
    compileV1: options.compileV1,
    compile2: options.compile2,
    migrate: options.migrate,
    ...(options.classify === undefined ? {} : { classify: options.classify }),
  });

  const cases: CorpusCaseReport[] = differential.cases.map((report) => {
    const fact = facts.get(report.id);
    if (fact === undefined) throw new Error(`内部不一致：${report.id} 没有文件读数`);
    return {
      id: report.id,
      status: report.status,
      blockedReason: report.blockedReason,
      reason: corpusReasonOf(report.blockedReason),
      bytes: fact.bytes.byteLength,
      sha256: fact.sha256,
      eol: fact.eol,
      bom: fact.bom,
      diff: {
        removed: report.diff.removed,
        added: report.diff.added,
        firstDifference: report.diff.firstDifference,
      },
      readings: report.readings,
      ...(includeProducts ? { products: report.products } : {}),
    };
  });

  return {
    ok: cases.length > 0 && problems.length === 0,
    root: discovery.root,
    discovery,
    cases: Object.freeze(cases),
    summary: summarizeCorpus(cases),
    rate: rateOf(cases),
    problems: Object.freeze(problems),
  };
}

/* ============================== 4. 真实语料抽样 manifest ============================== */

/**
 * 抽样结果的一条：**源字节副本**（`.v1.kojo.txt`）+ 溯源 meta（`.meta.json`）。
 *
 * `source` 是**语料根下相对路径**，不是绝对路径：绝对路径会把机器布局写进仓库
 * （本仓纪律：语料路径不入库），而相对路径足以从语料根重新定位同一份文件。
 * `bytes` / `sha256` 是副本的字节数与哈希——"副本确实来自那份源"的凭据。
 */
export interface CorpusSampleEntry {
  readonly id: string;
  readonly source: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly file: string;
  readonly meta: string;
  /** 源文本（BOM 以 U+FEFF 保留；`writeText` 宿主可直接落盘） */
  readonly v1Text: string;
  readonly v1Bytes: Uint8Array;
  readonly metaText: string;
}

export interface CorpusManifestGeneration {
  readonly dir: string;
  readonly outDir: string;
  readonly discovery: CorpusDiscovery;
  readonly sampled: readonly CorpusSampleEntry[];
  /** `manifest.json` 全文（可直接落盘） */
  readonly manifestText: string;
  /** 已写入的路径（按 id 序，manifest 在最后） */
  readonly files: readonly string[];
  readonly problems: readonly CorpusProblem[];
}

export interface GenerateCorpusManifestOptions {
  readonly io: CorpusIo;
  readonly sha256: CorpusHasher;
  /** 落点目录（宿主注入；CLI 固定为仓内真实语料 fixture 目录） */
  readonly outDir: string;
  readonly limit?: number | null;
  /** 默认 `DEFAULT_SAMPLE_SIZE`（≤60） */
  readonly sampleSize?: number;
  /** 已发现结果（宿主已扫过一遍时直接传） */
  readonly discovery?: CorpusDiscovery;
}

const REAL_MANIFEST_NOTES = [
  '真实语料抽样 manifest（`corpus --generate-manifest`）。',
  `抽样规则：路径码点序排序后**等距**取 ≤${DEFAULT_SAMPLE_SIZE} 份（稳定、可复现；不是随机）。`,
  '每份 case = 语料根下 `<source>` 的逐字节副本（`<id>.v1.kojo.txt`）+ 溯源 `<id>.meta.json`。',
  'meta 只记 `id` / `source`（语料根下相对路径）/ `bytes` / `sha256`：不写机器路径、不摘录原文之外的事实。',
  `合成语料（${SYNTHETIC_CORPUS_DIR}/manifest.json）是另一套 schema（kojo-migration-corpus/1），本生成器不写它。`,
].join('\n');

/**
 * 稳定等距抽样：排序后的清单里按 `floor(i * N / max)` 取 `max` 份。
 *
 * 为什么等距而不是随机：抽样要能复现（同一语料重跑得到同一批样本），
 * 等距还天然覆盖路径两端（不同作者目录 / 不同命名段），比 `slice(0, 60)` 有代表性。
 */
export function sampleEvenly(files: readonly string[], maxSamples: number = DEFAULT_SAMPLE_SIZE): readonly string[] {
  if (!Number.isSafeInteger(maxSamples) || maxSamples <= 0) {
    throw new RangeError(`抽样上限必须是正整数（收到 ${String(maxSamples)}）`);
  }
  if (files.length <= maxSamples) return Object.freeze([...files]);
  const step = files.length / maxSamples;
  const out: string[] = [];
  for (let i = 0; i < maxSamples; i++) {
    const item = files[Math.floor(i * step)];
    if (item === undefined) continue;
    out.push(item);
  }
  return Object.freeze(out);
}

/** 落点守卫：不得钻出 `..`、不得是合成语料目录（`migrate-corpus-real` 不是 `migrate-corpus` 的前缀陷阱） */
function assertOutDir(outDir: string): string {
  const normalized = normalizeDir(outDir);
  if (normalized === '' || normalized === '.' || normalized === '/') {
    throw new RangeError(`--generate-manifest 的落点目录不合法：${JSON.stringify(outDir)}`);
  }
  const segments = normalized.split('/');
  if (segments.includes('..')) {
    throw new RangeError(`--generate-manifest 的落点不得包含 '..'：${normalized}`);
  }
  const lower = normalized.toLowerCase();
  const synthetic = SYNTHETIC_CORPUS_DIR.toLowerCase();
  if (lower === synthetic || lower.endsWith(`/${synthetic}`) || lower.includes(`/${synthetic}/`)) {
    throw new RangeError(`拒绝写入合成语料目录（${SYNTHETIC_CORPUS_DIR}）：真实抽样只能落 ${REAL_CORPUS_DIR}`);
  }
  return normalized;
}

/** 相对路径 → fixture 文件名前缀（保持可读、去非法字符；过长/撞名由调用方补哈希） */
function caseIdOf(rel: string, digest: string): string {
  const withoutExt = rel.replace(/\.kojo$/i, '');
  const base = withoutExt
    .replaceAll('\\', '/')
    .replaceAll('/', '__')
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '');
  const safe = base.length === 0 ? 'case' : base;
  return safe.length > 96 ? `${safe.slice(0, 84)}-${digest.slice(0, 8)}` : safe;
}

function uniqueCaseId(rel: string, digest: string, used: Set<string>): string {
  const base = caseIdOf(rel, digest);
  let id = base;
  if (!used.has(id)) return id;
  id = `${base}-${digest.slice(0, 8)}`;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}-${digest.slice(0, 8)}-${suffix}`;
    suffix++;
  }
  return id;
}

function metaTextOf(entry: { readonly id: string; readonly source: string; readonly bytes: number; readonly sha256: string }): string {
  return `${JSON.stringify(
    { id: entry.id, source: entry.source, bytes: entry.bytes, sha256: entry.sha256 },
    null,
    2,
  )}\n`;
}

function writeEntry(io: CorpusIo, target: string, text: string, bytes: Uint8Array): void {
  if (io.writeBytes !== undefined) {
    io.writeBytes(target, bytes);
    return;
  }
  if (io.writeText === undefined) throw new Error('宿主不支持写盘（缺 writeText / writeBytes）');
  io.writeText(target, text);
}

/**
 * 生成真实语料抽样 fixture：`<outDir>/<id>.v1.kojo.txt` + `<id>.meta.json` + `manifest.json`。
 *
 * 纪律：
 * - **只报告不判定**：抽样里没有 expected（真实语料的现状就是现读数）；
 * - 先全读、后全写：任一份读不出就整批不写（不留半套 fixture）；
 * - 写盘失败即停，已写路径进 `files` 供人清理；`problems` 非空 = CLI rc=1；
 * - 落点只允许 `outDir` 一层（文件名由 id 生成且已消毒），任何写入都在 `outDir/` 之下。
 */
export function generateCorpusManifest(
  root: string,
  options: GenerateCorpusManifestOptions,
): CorpusManifestGeneration {
  const sampleSize = options.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  if (!Number.isSafeInteger(sampleSize) || sampleSize <= 0) {
    throw new RangeError(`抽样上限必须是正整数（收到 ${String(sampleSize)}）`);
  }
  const outDir = assertOutDir(options.outDir);
  const discovery = options.discovery ?? discoverCorpus(root, { io: options.io, limit: options.limit ?? null });
  const problems: CorpusProblem[] = [];
  const emptyManifest = {
    schema: REAL_CORPUS_SCHEMA,
    notes: REAL_MANIFEST_NOTES,
    cases: [] as readonly unknown[],
  };
  const emptyText = `${JSON.stringify(emptyManifest, null, 2)}\n`;

  if (discovery.total === 0) {
    problems.push({
      id: '(empty)',
      kind: 'empty',
      message: `语料目录 ${discovery.root} 里没有 ${V1_SOURCE_SUFFIX} v1 源：没有可抽样对象（不是"全绿"）`,
    });
    return {
      dir: discovery.root,
      outDir,
      discovery,
      sampled: Object.freeze([]),
      manifestText: emptyText,
      files: Object.freeze([]),
      problems: Object.freeze(problems),
    };
  }

  const chosen = sampleEvenly(discovery.selected, sampleSize);
  const used = new Set<string>();
  const prepared: CorpusSampleEntry[] = [];
  for (const rel of chosen) {
    const absolute = joinPath(discovery.root, rel);
    let fact: CorpusFileFacts;
    try {
      fact = readFacts(options.io, options.sha256, absolute);
    } catch (error: unknown) {
      problems.push({ id: rel, kind: 'io', message: `读取 ${absolute} 失败：${errorMessage(error)}` });
      continue;
    }
    const id = uniqueCaseId(rel, fact.sha256, used);
    used.add(id);
    const file = `${id}${REAL_V1_SUFFIX}`;
    const meta = `${id}${REAL_META_SUFFIX}`;
    prepared.push({
      id,
      source: rel,
      bytes: fact.bytes.byteLength,
      sha256: fact.sha256,
      file,
      meta,
      v1Text: fact.text,
      v1Bytes: fact.bytes,
      metaText: metaTextOf({ id, source: rel, bytes: fact.bytes.byteLength, sha256: fact.sha256 }),
    });
  }
  // 先全读后全写：只抽到一部分（读失败）也不落半套
  if (problems.length > 0) {
    return {
      dir: discovery.root,
      outDir,
      discovery,
      sampled: Object.freeze(prepared),
      manifestText: emptyText,
      files: Object.freeze([]),
      problems: Object.freeze(problems),
    };
  }

  const manifest = {
    schema: REAL_CORPUS_SCHEMA,
    notes: REAL_MANIFEST_NOTES,
    cases: prepared.map((entry) => ({
      id: entry.id,
      source: entry.source,
      bytes: entry.bytes,
      sha256: entry.sha256,
      file: entry.file,
      meta: entry.meta,
    })),
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

  // 落盘能力先查：缺 writeText 就在写任何副本之前报错（不留半套 fixture）
  if (options.io.writeText === undefined) {
    return {
      dir: discovery.root,
      outDir,
      discovery,
      sampled: Object.freeze(prepared),
      manifestText: emptyText,
      files: Object.freeze([]),
      problems: Object.freeze([
        { id: '(io)', kind: 'target' as const, message: '宿主不支持写盘（缺 writeText）' },
      ]),
    };
  }

  const files: string[] = [];
  try {
    options.io.mkdir?.(outDir);
    for (const entry of prepared) {
      writeEntry(options.io, joinPath(outDir, entry.file), entry.v1Text, entry.v1Bytes);
      files.push(joinPath(outDir, entry.file));
      writeEntry(options.io, joinPath(outDir, entry.meta), entry.metaText, encodeUtf8(entry.metaText));
      files.push(joinPath(outDir, entry.meta));
    }
    options.io.writeText(joinPath(outDir, REAL_MANIFEST_NAME), manifestText);
    files.push(joinPath(outDir, REAL_MANIFEST_NAME));
  } catch (error: unknown) {
    problems.push({
      id: '(io)',
      kind: 'target',
      message: `写入 ${outDir} 失败（已写 ${files.length} 个文件）：${errorMessage(error)}`,
    });
  }

  return {
    dir: discovery.root,
    outDir,
    discovery,
    sampled: Object.freeze(prepared),
    manifestText,
    files: Object.freeze(files),
    problems: Object.freeze(problems),
  };
}

/* ============================== 5. CLI ============================== */

export const CORPUS_CLI_USAGE = [
  '用法:',
  '  kojo-conformance corpus [--dir <语料根>] [--limit N] [--json]',
  '  kojo-conformance corpus [--dir <语料根>] [--limit N] --generate-manifest',
  '  kojo-conformance corpus help',
  '',
  '语料根缺省走仓库统一解析链（`tools/corpus.mjs`：--dir > KOJO_CORPUS_DIR > 扫盘认内容）：',
  '  node tools/kojo-conformance.mjs corpus --json',
  '  node tools/kojo-conformance.mjs corpus --dir <语料根> --limit 200 --json',
  '',
  '发现规则：递归找 `.kojo`（排除 `.kojo2`），路径码点序排序后按 --limit 截断。',
  '状态：identical / normalized-equal / differs / blocked；blocked 原因分',
  '  migration-unsupported / v1-compile-failed / 2.0-compile-failed / migration-error。',
  '聚合率：可迁移份数 / 参与迁移份数（migration.ok；与"两侧产物相同"无关）。',
  '',
  '--generate-manifest：只做真实语料**抽样**（默认 ≤60 份，路径序等距），写',
  `  ${REAL_CORPUS_DIR}/<id>${REAL_V1_SUFFIX} + <id>${REAL_META_SUFFIX} + ${REAL_MANIFEST_NAME}`,
  `  合成语料（${SYNTHETIC_CORPUS_DIR}/manifest.json）绝不被覆盖。`,
  '',
  '退出码: 0 跑完（读数如实，blocked/differs 不算失败）',
  '        1 目录在位但没有 .kojo / 读写失败',
  '        2 语料不在位（SKIP，不是绿）或用法错误',
].join('\n');

export type CorpusVerdict = 'ok' | 'fail' | 'skip';

/** `--generate-manifest` 的报告体（manifest 全文随报告返回，落盘已在生成器里做） */
export interface CorpusManifestReport {
  readonly outDir: string;
  readonly discovered: number;
  readonly sampled: number;
  readonly files: readonly string[];
  readonly text: string;
}

/** CLI 报告（顶层字段序固定：verdict / dir / discovery / summary / rate / cases / problems / manifest / usage） */
export interface CorpusCliReport {
  readonly verdict: CorpusVerdict;
  readonly dir: string;
  readonly discovery: CorpusDiscovery | null;
  readonly summary: CorpusSummary;
  readonly rate: CorpusRateReport;
  readonly cases: readonly CorpusCaseReport[];
  readonly problems: readonly CorpusProblem[];
  readonly manifest: CorpusManifestReport | null;
  /** 非 null = 用法 / help 文本（`--json` 对它不生效） */
  readonly usage: string | null;
}

/** 语料根解析结果（宿主注入：真实解析链 / 测试替身） */
export type CorpusRootResolution =
  | { readonly ok: true; readonly dir: string }
  | { readonly ok: false; readonly dir: string | null; readonly reason: string };

export interface CorpusCliDeps {
  readonly io: CorpusIo;
  readonly compileV1: MigrationV1Compiler;
  readonly compile2: MigrationV2Compiler;
  readonly migrate: MigrationMigrator;
  readonly sha256: CorpusHasher;
  /** `--dir` 缺席时的真实语料解析（SKIP 判据在宿主侧） */
  readonly resolveRoot: () => CorpusRootResolution;
  /** `--generate-manifest` 的落点（宿主注入绝对路径） */
  readonly realCorpusDir: string;
  readonly classify?: MigrationClassifier;
}

export interface CorpusCliResult {
  readonly exitCode: 0 | 1 | 2;
  readonly report: CorpusCliReport;
  readonly text: string;
}

interface CorpusCliArgs {
  readonly dir: string | null;
  readonly limit: number | null;
  readonly json: boolean;
  readonly generateManifest: boolean;
  readonly help: boolean;
  readonly error: string | null;
}

function parseCorpusArgs(argv: readonly string[]): CorpusCliArgs {
  if (argv[0] === 'help' || argv.includes('help') || argv.includes('--help') || argv.includes('-h')) {
    return {
      dir: null,
      limit: null,
      json: argv.includes('--json'),
      generateManifest: false,
      help: true,
      error: null,
    };
  }
  let dir: string | null = null;
  let limit: number | null = null;
  let json = false;
  let generateManifest = false;
  let error: string | null = null;
  const fail = (message: string): void => {
    if (error === null) error = message;
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (token === '') {
      fail('空参数');
      continue;
    }
    if (token === 'corpus') continue;
    if (token === '--json') {
      if (json) fail('重复参数：--json');
      json = true;
      continue;
    }
    if (token === '--generate-manifest') {
      if (generateManifest) fail('重复参数：--generate-manifest');
      generateManifest = true;
      continue;
    }
    if (token === '--limit') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        fail('缺少 --limit 的值');
        continue;
      }
      i++;
      if (limit !== null) {
        fail('重复参数：--limit');
        continue;
      }
      if (!/^[0-9]+$/.test(value) || Number(value) <= 0) {
        fail(`--limit 必须是正整数（收到 ${JSON.stringify(value)}）`);
        continue;
      }
      limit = Number(value);
      continue;
    }
    if (token === '--dir') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        fail('缺少 --dir 的值');
        continue;
      }
      i++;
      if (dir !== null) fail('重复参数：--dir');
      else if (value.trim().length === 0) fail('--dir 的值不能为空');
      else dir = value;
      continue;
    }
    fail(`未知参数：${token}`);
  }
  return { dir, limit, json, generateManifest, help: false, error };
}

function emptySummaryReport(): CorpusSummary {
  return { cases: 0, identical: 0, normalizedEqual: 0, differs: 0, blocked: 0, blockedByReason: Object.freeze([]) };
}

function emptyRateReport(): CorpusRateReport {
  return { total: 0, migratable: 0, rate: 0, unmigratable: 0, unsupportedCases: 0, byReason: Object.freeze([]) };
}

function emptyReport(verdict: CorpusVerdict, dir: string): CorpusCliReport {
  return {
    verdict,
    dir,
    discovery: null,
    summary: emptySummaryReport(),
    rate: emptyRateReport(),
    cases: Object.freeze([]),
    problems: Object.freeze([]),
    manifest: null,
    usage: null,
  };
}

function skipReport(dir: string, reason: string): CorpusCliReport {
  return {
    ...emptyReport('skip', dir),
    problems: Object.freeze([{ id: '(corpus)', kind: 'corpus' as const, message: reason }]),
  };
}

function usageReport(dir: string, reason: string): CorpusCliReport {
  return { ...emptyReport('skip', dir), usage: `${CORPUS_CLI_USAGE}\n\n错误：${reason}` };
}

/**
 * `corpus` 子命令主入口（纯逻辑；零 `process.exit`、零宿主 API）。
 *
 * 退出码口径：
 * - 0 = 跑完 / 生成完（`differs` / `blocked` 是**读数**，不是失败；真实语料无期望）；
 * - 1 = 目录在位但没有可迁移源 / 读写失败；
 * - 2 = 语料不在位（SKIP，明确上屏「语料不在位」）/ 用法错误。
 */
export function runCorpusCli(argv: readonly string[], deps: CorpusCliDeps): CorpusCliResult {
  const parsed = parseCorpusArgs(argv);
  if (parsed.help) {
    const report: CorpusCliReport = { ...emptyReport('ok', ''), usage: CORPUS_CLI_USAGE };
    return { exitCode: 0, report, text: `${CORPUS_CLI_USAGE}\n` };
  }
  if (parsed.error !== null) {
    const report = usageReport(parsed.dir ?? '', parsed.error);
    return { exitCode: 2, report, text: formatCorpusReport(report) };
  }

  let root: string;
  if (parsed.dir !== null) {
    root = parsed.dir;
  } else {
    const resolution = deps.resolveRoot();
    if (!resolution.ok) {
      const report = skipReport(resolution.dir ?? '', resolution.reason);
      return { exitCode: 2, report, text: formatCorpusReport(report, { json: parsed.json }) };
    }
    root = resolution.dir;
  }

  let discovery: CorpusDiscovery;
  try {
    discovery = discoverCorpus(root, { io: deps.io, limit: parsed.limit });
  } catch (error: unknown) {
    // 目录读不了 = 语料不在位（不是 0 份通过）：显式 --dir 指错也落这一档
    const report = skipReport(root, `语料不在位：无法列出 ${root}（${errorMessage(error)}）`);
    return { exitCode: 2, report, text: formatCorpusReport(report, { json: parsed.json }) };
  }

  if (parsed.generateManifest) {
    const generation = generateCorpusManifest(root, {
      io: deps.io,
      sha256: deps.sha256,
      outDir: deps.realCorpusDir,
      limit: parsed.limit,
      discovery,
    });
    const report: CorpusCliReport = {
      ...emptyReport(generation.problems.length === 0 ? 'ok' : 'fail', generation.dir),
      discovery: generation.discovery,
      problems: generation.problems,
      manifest: {
        outDir: generation.outDir,
        discovered: generation.discovery.total,
        sampled: generation.sampled.length,
        files: generation.files,
        text: generation.manifestText,
      },
    };
    const exitCode: 0 | 1 = generation.problems.length === 0 && generation.sampled.length > 0 ? 0 : 1;
    return { exitCode, report, text: formatCorpusReport(report, { json: parsed.json }) };
  }

  const result = runCorpusMigration({
    root,
    discovery,
    ...(parsed.limit === null ? {} : { limit: parsed.limit }),
    compileV1: deps.compileV1,
    compile2: deps.compile2,
    migrate: deps.migrate,
    ...(parsed.json ? { json: true } : {}),
    io: deps.io,
    sha256: deps.sha256,
    ...(deps.classify === undefined ? {} : { classify: deps.classify }),
  });
  const exitCode: 0 | 1 = result.cases.length > 0 && result.problems.length === 0 ? 0 : 1;
  const report: CorpusCliReport = {
    verdict: exitCode === 0 ? 'ok' : 'fail',
    dir: result.root,
    discovery: result.discovery,
    summary: result.summary,
    rate: result.rate,
    cases: result.cases,
    problems: result.problems,
    manifest: null,
    usage: null,
  };
  return { exitCode, report, text: formatCorpusReport(report, { json: parsed.json }) };
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function reasonLine(reasons: readonly CorpusReasonCount[]): string {
  if (reasons.length === 0) return '（无 blocked）';
  return reasons.map((item) => `${item.reason} ${item.cases}`).join(' · ');
}

/**
 * 报告渲染：`--json` 给机器（顶层字段序固定、case 序 = 路径序、问题序 = 发生序）；
 * 人话报告把"缺席 = SKIP"与"0 份 = FAIL"两档写得一眼可辨。
 */
export function formatCorpusReport(report: CorpusCliReport, options: { readonly json?: boolean } = {}): string {
  if (report.usage !== null) return `${report.usage}\n`;
  if (options.json === true) return `${JSON.stringify(report, null, 2)}\n`;

  const discovery = report.discovery;
  const lines: string[] = [];
  if (report.verdict === 'skip') {
    lines.push(`kojo-conformance corpus · SKIP（语料不在位）· dir=${report.dir || '(未解析)'}`);
    for (const problem of report.problems) lines.push(`  原因：${problem.message}`);
    lines.push('这是 SKIP，不是绿：语料缺席不会被记成 0 cases 通过。');
    lines.push(`用法：node tools/kojo-conformance.mjs corpus --dir <语料根> [--limit N] [--json]`);
    return `${lines.join('\n')}\n`;
  }

  if (report.manifest !== null) {
    lines.push(
      `kojo-conformance corpus --generate-manifest · dir=${report.dir} · 发现 ${report.manifest.discovered} 份 ${V1_SOURCE_SUFFIX}` +
        ` · 抽样 ${report.manifest.sampled} 份 · 落点 ${report.manifest.outDir}`,
    );
    for (const problem of report.problems) lines.push(`  [${problem.kind}] ${problem.id}  ${problem.message}`);
    if (report.problems.length === 0) {
      for (const file of report.manifest.files) lines.push(`  写入 ${file}`);
    }
    lines.push('', report.problems.length === 0 ? 'RESULT: PASS（抽样 manifest 已生成）' : 'RESULT: FAIL（零落盘）');
    return `${lines.join('\n')}\n`;
  }

  const selected = discovery === null ? 0 : discovery.selected.length;
  const limitText = discovery === null || discovery.limit === null ? '不限' : String(discovery.limit);
  lines.push(
    `kojo-conformance corpus · dir=${report.dir} · 发现 ${discovery?.total ?? 0} 份 ${V1_SOURCE_SUFFIX}` +
      ` · 本次 ${selected} 份（limit ${limitText}${discovery?.truncated === true ? ' · 已截断' : ''}）`,
  );
  lines.push(
    `状态: identical ${report.summary.identical} · normalized-equal ${report.summary.normalizedEqual}` +
      ` · differs ${report.summary.differs} · blocked ${report.summary.blocked}`,
  );
  lines.push(
    `可迁移 ${report.rate.migratable}/${report.rate.total}（${percent(report.rate.rate)}）` +
      ` · 不可迁移 ${report.rate.unmigratable} · 按原因: ${reasonLine(report.rate.byReason)}`,
  );
  if (report.cases.length > 0) {
    lines.push('cases:');
    for (const item of report.cases) {
      const blocked = item.reason === null ? '' : `  (${item.reason})`;
      lines.push(
        `  ${item.status.padEnd(15)} ${item.id}${blocked}  bytes=${item.bytes} sha256=${item.sha256.slice(0, 12)}…` +
          `  v1=${item.readings.v1.ok ? 'ok' : 'fail'} 2.0=${item.readings.v2.ok ? 'ok' : 'fail'}`,
      );
      if (item.diff.firstDifference !== null) {
        const first = item.diff.firstDifference;
        const side = first.baseline ?? first.candidate ?? '';
        lines.push(`      diff -${item.diff.removed}/+${item.diff.added}  ${side.slice(0, 60)}`);
      }
    }
  }
  if (report.problems.length > 0) {
    lines.push('', `问题 (${report.problems.length})`);
    for (const problem of report.problems) lines.push(`  [${problem.kind}] ${problem.id}  ${problem.message}`);
  }
  lines.push(
    '',
    report.verdict === 'ok'
      ? 'RESULT: OK（读数如实；differs / blocked 不是失败，是现状）'
      : `RESULT: FAIL（${report.problems.length} 个问题；0 份可迁移源不是全绿）`,
  );
  return `${lines.join('\n')}\n`;
}
