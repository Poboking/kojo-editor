/**
 * 约定校验结果快照（2026-10-12「体感丝滑」批 →「按文件增量」批）。
 *
 * ## 为什么存在
 * 全量校验在真实语料上实测 **3.6 s**，而插件订阅 `kojo.functionChanged` 每次开项目都自动催动。
 * 产出却只有 793 条 / ~0.4 MB——是级联三段里性价比最高的缓存目标。
 *
 * ## 为什么 v1 的整块缓存不够用（§5.70 的同一课）
 * v1 的判据里含**整项目 ERB 指纹** ⇒ "作者改了一个文件"就整包作废、重跑全部规则。
 * 而逐规则计时实测（`engine.ts` 的 breakdown 行）显示成本分布极不均：
 * `form-triple-symbol` 一条就占 **55%**（2008ms，只产出 8 条问题），它**只看单个文件的正文**。
 *
 * ## 三层判据（各管各的粒度，v2）
 * | 层 | 判据（存盘字段） | 不符的代价 |
 * |---|---|---|
 * | 全局 | 项目根 / `adapterId` / `expectFingerprint`（= `inputDigest` + 语义版本 + 规则清单摘要） | 整包弃用 |
 * | 整项目层 | `erbFingerprint`（全部 ERB 的体量指纹） | **只重算 `scope:'project'` 的规则** |
 * | 逐文件层 | 桶里的 `mtimeMs` vs `ErbIndex.fileMtimes`（任一侧 null ⇒ 该文件不复用） | **只重算那一个文件** |
 *
 * 于是：一个文件都没改 ⇒ 三层全命中 ⇒ 零计算（与 v1 同速）；改一个文件 ⇒ 只付
 * 「跨文件规则 + 那一个文件的逐文件规则」，不再付全库正文扫描。
 * 两个指纹字段**刻意分开**：合成一个就又回到"改一个文件让全局判据也失效"的老毛病。
 *
 * ## v3：跨文件规则的分区层（`units` + `partitionKeys`）
 * `partition` 化的 `scope:'project'` 规则把"每文件的结构化贡献"按 mtime 逐文件缓存
 * （与桶同族判据），另按 `partitionKeys[ruleId]`（外部输入摘要，如路由表内容）整体失效；
 * `projectResults` 仍受整项目指纹约束——分区层是它在"改一棵"时的补救路径。
 * **PERF-12c**：真语料上贡献占了主快照 79% 的体积（4.0 MB / 5.1 MB）⇒ "全命中轮"也要
 * 整份读盘 + parse 才换来一句零计算。贡献改走**按规则一条键**（`lint-units-v1-*`），
 * 只在真有分区规则要重算时懒取；主快照不再携带 `units`（旧键读出仍兼容：字段可选）。
 *
 * ## 纪律
 * - **fail-closed**：全局判据或结构任一不符 ⇒ null（调用方删除并重算），绝不"修"快照；
 * - **有失败的就不存那一块**：某条整项目规则抛错 ⇒ 不写它的结论；某文件抛错 ⇒ 不留该文件的桶。
 *   坏一次不能永久缓存坏结果（取代 v1"整报告带 `failedRules` 就拒绝命中"——现在粒度到桶，
 *   不需要整包连坐）；
 * - **`run({ force: true })` 仍绕过快照**：面板「重新校验」是用户的显式意图；
 * - 逐文件桶**只装 `scope:'file'` 的规则**：跨文件规则塞进桶会让"改 A 文件"给出过期结论。
 */
import { combineDigests, foldDigest } from '@kojo/plugin-api';
import type {
  CacheExpect,
  ConventionIssue,
  ConventionPolicy,
  ConventionRule,
  ConventionSeverity,
  GameProject,
} from '@kojo/plugin-api';

/** 校验语义版本；改任何规则的判定口径时 +1（v1 整块报告 ⇒ v2 三层判据 + 逐文件桶 ⇒ v3 跨文件分区） */
export const LINT_SNAPSHOT_FORMAT = 3;

/** 存储键（固定槽位：版本在 payload 里，换格式时旧文件读出即判死并被覆盖，不留孤儿） */
export const LINT_STORE_KEY = 'lint-report-v1';

const SEVERITIES: readonly ConventionSeverity[] = ['error', 'warning', 'info'];

/** 一个文件在某条 `scope:'file'` 规则下的结论 */
export interface LintFileBucket {
  readonly mtimeMs: number | null;
  readonly issues: ConventionIssue[];
}

/** 一个文件在某条分区化跨文件规则（`partition`）下的贡献（JSON 值；null = 本文件无贡献） */
export interface LintUnitEntry {
  readonly mtimeMs: number | null;
  readonly unit: unknown;
}

/** 可复用的校验缓存本体（三层判据里后两层的"结果侧"） */
export interface LintCache {
  /** 本次缓存对应的整项目 ERB 指纹——只约束 `projectResults`，不约束桶 */
  readonly erbFingerprint: string;
  /** `scope:'project'` 规则的结论（ruleId → issues；抛错的规则不在此列） */
  readonly projectResults: Record<string, ConventionIssue[]>;
  /** `scope:'file'` 规则的逐文件桶（ruleId → 路径 → 桶） */
  readonly buckets: Record<string, Record<string, LintFileBucket>>;
  /** 分区化跨文件规则的逐文件贡献（ruleId → 路径 → 分区）；判据 = mtime + `partitionKeys` */
  readonly projectUnits?: Record<string, Record<string, LintUnitEntry>>;
  /** 分区规则的外部输入摘要（ruleId → `partition.key()`）；不等 ⇒ 该规则分区全弃 */
  readonly partitionKeys?: Record<string, string>;
  /**
   * 运行期标记（**不落盘**）：这次装载遇到的是 12b 的旧形态（贡献还塞在主快照里）且被
   * 有意跳过未解码。引擎据此**即使本轮零重算也要重写一次主快照**——否则那句"全命中"
   * 每轮都要为已经不需要的 4 MB 付读盘 + 走结构的钱，拆键也就白拆了。
   */
  readonly droppedUnits?: boolean;
}

/** 落盘形态（v2）。桶的元组：`[mtime]` = 该文件这次什么都没产出，`[mtime, issues]` = 有结论 */
type BucketTuple = [number | null] | [number | null, ConventionIssue[]];
/** 分区元组：`[mtime, unit]`（unit 恒在——null 也是合法结论「本文件无贡献」） */
type UnitTuple = [number | null, unknown];

export interface StoredLintCache {
  readonly format: number;
  readonly projectRoot: string;
  readonly adapterId: string;
  /** 全局判据（`inputDigest` + 语义版本 + 规则清单摘要），即 `CacheExpect.fingerprint` */
  readonly expectFingerprint: string;
  /** 整项目层判据（`ErbIndex.fingerprint`） */
  readonly erbFingerprint: string;
  readonly savedAt: number;
  readonly project: Record<string, ConventionIssue[]>;
  readonly buckets: Record<string, Record<string, BucketTuple>>;
  readonly units: Record<string, Record<string, UnitTuple>>;
  readonly partitionKeys: Record<string, string>;
}

/** 分区贡献的独立存储键前缀（PERF-12c）：`lint-units-v1-<ruleId 摘要>`，每条分区规则一键 */
export const LINT_UNITS_KEY_PREFIX = 'lint-units-v1-';

/**
 * 分区贡献的存储键名（确定性、有界、防穿越）。
 * 尾缀固定带 `ruleId` 的摘要 ⇒ 清洗后的前缀即使相互撞车也不会共用一键；
 * 键名不可反解，清理孤儿由**当前规则集正算键名取补集**完成（见 `decodeUnits` 的同侧纪律）。
 */
export function lintUnitsKey(ruleId: string): string {
  const safe = ruleId
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[^A-Za-z0-9_]/, '_')
    .slice(0, 90); // 14（前缀）+ 90 + 1 + 12（摘要）≤ 120 ⇒ 过得了内核的键名校验
  const digest = foldDigest([ruleId]).slice(0, 12);
  return `${LINT_UNITS_KEY_PREFIX}${safe}-${digest}`;
}

/** 盘上的分区贡献（单规则一条键；判据自带，不与主快照同生共死） */
export interface StoredLintUnits {
  readonly format: number;
  readonly projectRoot: string;
  readonly adapterId: string;
  readonly expectFingerprint: string;
  readonly ruleId: string;
  /** 写入时的 `partition.key()`（外部输入摘要）；不等 ⇒ 整键弃用 */
  readonly key: string;
  readonly savedAt: number;
  readonly units: Record<string, UnitTuple>;
}

export function encodeUnits(args: {
  ruleId: string;
  key: string;
  units: Readonly<Record<string, LintUnitEntry>>;
  expect: CacheExpect;
  savedAt?: number;
}): StoredLintUnits {
  const out: Record<string, UnitTuple> = {};
  for (const [path, u] of Object.entries(args.units)) out[path] = [u.mtimeMs, u.unit];
  return {
    format: LINT_SNAPSHOT_FORMAT,
    projectRoot: args.expect.projectRoot,
    adapterId: args.expect.adapterId,
    expectFingerprint: args.expect.fingerprint,
    ruleId: args.ruleId,
    key: args.key,
    savedAt: args.savedAt ?? Date.now(),
    units: out,
  };
}

/**
 * 还原某条规则的分区贡献；**全局判据 / ruleId / 结构**任一不符 ⇒ null（调用方删键并重算）。
 * 返回里的 `key` 交给引擎与本轮 `partition.key()` 比对（外部输入摘要不符 ⇒ 整键弃用，fail-closed）。
 */
export function decodeUnits(
  raw: unknown,
  expect: CacheExpect,
  ruleId: string,
): { key: string; units: Record<string, LintUnitEntry> } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Partial<StoredLintUnits>;
  if (s.format !== LINT_SNAPSHOT_FORMAT) return null;
  if (s.projectRoot !== expect.projectRoot) return null;
  if (s.adapterId !== expect.adapterId) return null;
  if (s.expectFingerprint !== expect.fingerprint) return null;
  if (s.ruleId !== ruleId) return null;
  if (typeof s.key !== 'string') return null;
  if (typeof s.units !== 'object' || s.units === null) return null;
  const units: Record<string, LintUnitEntry> = {};
  for (const [path, tuple] of Object.entries(s.units)) {
    if (!Array.isArray(tuple) || tuple.length !== 2) return null;
    const mtime = tuple[0];
    if (mtime !== null && typeof mtime !== 'number') return null;
    units[path] = { mtimeMs: mtime as number | null, unit: tuple[1] };
  }
  return { key: s.key, units };
}

/**
 * 规则清单摘要：`id + 级别 + 描述 + scope`。
 * `scope` 必须入摘要——一条规则从 `'project'` 改判成 `'file'`（或反之）**改变缓存语义**，
 * 摘要不变却继续复用旧桶就会把跨文件结论当逐文件结论用。逻辑变化仍靠 `LINT_SNAPSHOT_FORMAT`。
 */
export function rulesDigest(rules: readonly ConventionRule[]): string {
  return foldDigest(
    rules.map((r) => `${r.id}\u0000${r.severity}\u0000${r.description ?? ''}\u0000${r.scope ?? 'project'}`),
  );
}

/**
 * 静默策略摘要：策略改变 issue 输出，必须进全局判据，否则换策略后仍复用旧结果。
 * 只认「规则 id + 名字集 + 正则 + 理由」——理由进摘要是有意的：报告文案会跟着变。
 */
export function policyDigest(policy: ConventionPolicy | undefined): string | null {
  if (policy === undefined || policy.length === 0) return null;
  return foldDigest(
    policy.map(
      (s) => `${s.ruleId}\u0000${(s.names ?? []).join(',')}\u0000${s.namePattern ?? ''}\u0000${s.reason}`,
    ),
  );
}

/**
 * 全局层判据（**不含 ERB 指纹**：那一项现在只约束整项目层，见 `LintCache.erbFingerprint`）。
 * 缺 `inputDigest` 或规则清单为空 ⇒ null ⇒ 不缓存（判据不全就不缓存）。
 */
export function lintExpect(args: {
  project: Pick<GameProject, 'rootDir' | 'adapterId' | 'inputDigest'>;
  rules: readonly ConventionRule[];
  policy?: ConventionPolicy;
}): CacheExpect | null {
  const parts: Array<string | null | undefined> = [
    args.project.inputDigest,
    `fmt${LINT_SNAPSHOT_FORMAT}`,
    args.rules.length > 0 ? rulesDigest(args.rules) : null,
  ];
  const pd = policyDigest(args.policy);
  if (pd !== null) parts.push(pd);
  const fingerprint = combineDigests(parts);
  if (!fingerprint) return null;
  return { projectRoot: args.project.rootDir, adapterId: args.project.adapterId, fingerprint };
}

export function encodeCache(args: { cache: LintCache; expect: CacheExpect; savedAt?: number }): StoredLintCache {
  const buckets: Record<string, Record<string, BucketTuple>> = {};
  for (const [ruleId, byPath] of Object.entries(args.cache.buckets)) {
    const out: Record<string, BucketTuple> = {};
    for (const [path, b] of Object.entries(byPath)) {
      out[path] = b.issues.length === 0 ? [b.mtimeMs] : [b.mtimeMs, b.issues];
    }
    buckets[ruleId] = out;
  }
  const units: Record<string, Record<string, UnitTuple>> = {};
  for (const [ruleId, byPath] of Object.entries(args.cache.projectUnits ?? {})) {
    const out: Record<string, UnitTuple> = {};
    for (const [path, u] of Object.entries(byPath)) out[path] = [u.mtimeMs, u.unit];
    units[ruleId] = out;
  }
  return {
    format: LINT_SNAPSHOT_FORMAT,
    projectRoot: args.expect.projectRoot,
    adapterId: args.expect.adapterId,
    expectFingerprint: args.expect.fingerprint,
    erbFingerprint: args.cache.erbFingerprint,
    savedAt: args.savedAt ?? Date.now(),
    project: args.cache.projectResults,
    buckets,
    units,
    partitionKeys: args.cache.partitionKeys ?? {},
  };
}

function isIssue(v: unknown): v is ConventionIssue {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.ruleId === 'string' &&
    typeof o.message === 'string' &&
    typeof o.severity === 'string' &&
    SEVERITIES.includes(o.severity as ConventionSeverity)
  );
}

function isIssueList(v: unknown): v is ConventionIssue[] {
  return Array.isArray(v) && v.every(isIssue);
}

/**
 * 还原缓存；**全局判据**（格式 / 项目根 / 适配器 / `expectFingerprint`）或结构任一不符 ⇒ null。
 * 整项目层与逐文件层是否可用交给引擎：前者比 `erbFingerprint`，后者比 `mtimeMs`。
 */
export function decodeCache(
  raw: unknown,
  expect: CacheExpect,
  opts: { includeUnits?: boolean } = {},
): LintCache | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Partial<StoredLintCache>;
  if (s.format !== LINT_SNAPSHOT_FORMAT) return null;
  if (s.projectRoot !== expect.projectRoot) return null;
  if (s.adapterId !== expect.adapterId) return null;
  if (s.expectFingerprint !== expect.fingerprint) return null;
  if (typeof s.erbFingerprint !== 'string') return null;
  if (typeof s.project !== 'object' || s.project === null) return null;
  if (typeof s.buckets !== 'object' || s.buckets === null) return null;

  const projectResults: Record<string, ConventionIssue[]> = {};
  for (const [ruleId, list] of Object.entries(s.project)) {
    if (!isIssueList(list)) return null;
    projectResults[ruleId] = list;
  }

  const buckets: Record<string, Record<string, LintFileBucket>> = {};
  for (const [ruleId, byPath] of Object.entries(s.buckets)) {
    if (typeof byPath !== 'object' || byPath === null) return null;
    const out: Record<string, LintFileBucket> = {};
    for (const [path, tuple] of Object.entries(byPath as Record<string, unknown>)) {
      if (!Array.isArray(tuple) || tuple.length < 1 || tuple.length > 2) return null;
      const mtime = tuple[0];
      if (mtime !== null && typeof mtime !== 'number') return null;
      if (tuple.length === 2 && !isIssueList(tuple[1])) return null;
      out[path] = {
        mtimeMs: mtime as number | null,
        issues: tuple.length === 2 ? (tuple[1] as ConventionIssue[]) : [],
      };
    }
    buckets[ruleId] = out;
  }

  const projectUnits: Record<string, Record<string, LintUnitEntry>> = {};
  let droppedUnits = false;
  if (opts.includeUnits !== false) {
    if (s.units !== undefined) {
      if (typeof s.units !== 'object' || s.units === null) return null;
      for (const [ruleId, byPath] of Object.entries(s.units)) {
        if (typeof byPath !== 'object' || byPath === null) return null;
        const out: Record<string, LintUnitEntry> = {};
        for (const [path, tuple] of Object.entries(byPath as Record<string, unknown>)) {
          if (!Array.isArray(tuple) || tuple.length !== 2) return null;
          const mtime = tuple[0];
          if (mtime !== null && typeof mtime !== 'number') return null;
          out[path] = { mtimeMs: mtime as number | null, unit: tuple[1] };
        }
        projectUnits[ruleId] = out;
      }
    }
  } else if (s.units !== undefined && typeof s.units === 'object' && Object.keys(s.units).length > 0) {
    droppedUnits = true; // 12b 的旧形态：贡献还塞在主快照里 ⇒ 标记给引擎改写一次（不"修"、只用桶与结论）
  }
  const partitionKeys: Record<string, string> = {};
  if (s.partitionKeys !== undefined) {
    if (typeof s.partitionKeys !== 'object' || s.partitionKeys === null) return null;
    for (const [ruleId, key] of Object.entries(s.partitionKeys)) {
      if (typeof key !== 'string') return null;
      partitionKeys[ruleId] = key;
    }
  }
  return {
    erbFingerprint: s.erbFingerprint,
    projectResults,
    buckets,
    projectUnits: Object.keys(projectUnits).length > 0 ? projectUnits : undefined,
    partitionKeys: Object.keys(partitionKeys).length > 0 ? partitionKeys : undefined,
    droppedUnits: droppedUnits ? true : undefined,
  };
}
