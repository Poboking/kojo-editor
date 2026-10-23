/**
 * 迁移 differential harness（K2-MIGRATION-DIFFERENTIAL）——**v1 编译产物 ⇄ 2.0 编译产物**的行为对拍。
 *
 * 定位（设计稿 §16.8 M7.1 / M7.2 / M7.6）：
 * - 纯逻辑：编译器（`compileV1` / `compile2`）、迁移器（`migrate`）、语料（`cases`）**全部注入**；
 *   本模块不读盘、不写盘、不 import 宿主、不碰 `process`。CLI 只做 argv + IO + 落文本。
 * - 一条 case = 一份 v1 源；两边产物都来自**真编译链路**（v1 侧 = kojo-sugar 真入口，
 *   2.0 侧 = 真 core + 真 adapter backend），本模块只比较、不编译。
 * - **不洗白**：归一化只允许下面 `MIGRATION_NORMALIZATIONS` 写死的几项（注释 / 空行 / 包装头 /
 *   排版空白），每条都写明依据；`PRINTFORMDW` vs `PRINTFORMW`、引号有无、`SETCOLOR` 有无
 *   这类**行为差异**一律落 `differs`，绝不进白名单。测试逐条钉住这一点。
 *
 * ## 四种状态
 *
 * | status | 含义 |
 * |---|---|
 * | `identical` | 两侧产物**逐字节**相同（BOM/EOL 也不差） |
 * | `normalized-equal` | 只有白名单里的差异（注释 / 空行 / 包装头 `(ARG)` / 排版缩进） |
 * | `differs` | 归一化后仍有差异 ⇒ 产物行为不同（如实记账，不当 green） |
 * | `blocked` | 无法判定：v1 侧编不出来 / 迁移有 unsupported / 2.0 侧编不出来 |
 *
 * `blocked` 不是"通过"：它带 `blockedReason` 与迁移台账（`unsupported` 逐条 construct），
 * 是**缺口清单**而不是豁免。只有"落盘判据 `ok === true`"的 case 才有 2.0 产物可比。
 *
 * ## 迁移率口径（`migrationReport`）
 *
 * "v1 写法"按**行**计（`collectV1Sites`）：非空、非整行注释、能被 v1 判别器认出的每一行 = 1 处。
 * - `unsupported` = 迁移台账覆盖的行数（块级 unsupported 含**整块缩进体**——机械层原样保留的
 *   就是这些行，它们没有被迁移，不能算进"已迁移"）；
 * - `autoMigrated` = `v1Sites − unsupported`；
 * - 按 construct 分类：已迁移行归它的判别种类，unsupported 行归台账里的 construct。
 *
 * 这条口径是**保守**的：`@原生` 围栏里的行（语义层搬运）算"已迁移"（它们真的换了形态），
 * 但块内仍是 v1 写法——所以报告同时给 `rewrites` 读数（语义层改写了哪些块），供人复核。
 */
import { classifyV1, diagnoseV1IndentMismatch, type V1Kind } from '@kojo/kojo-core';

/* ============================== 1. 公共形状 ============================== */

/** 一条 case 的对拍状态 */
export type MigrationStatus = 'identical' | 'normalized-equal' | 'differs' | 'blocked';

/**
 * blocked 的原因（每一条都对应"为什么不能判定"，不混入"判出差异"）：
 * - `v1-compile-failed`：v1 侧有 error 诊断或抛错 ⇒ 没有可比基线；
 * - `migration-unsupported`：迁移台账非空（`ok === false`）⇒ 2.0 源根本不是可编译形态；
 * - `migration-error`：迁移器抛错（不是"报 unsupported"，是坏了）；
 * - `v2-compile-failed`：迁移产物仍有 error 诊断 ⇒ 迁移输出不合法（**红灯**，不是正常缺口）。
 */
export type MigrationBlockedReason =
  | 'v1-compile-failed'
  | 'migration-unsupported'
  | 'migration-error'
  | 'v2-compile-failed';

/** 一条诊断（只取报告需要的三格；各编译链路自己产） */
export interface MigrationDiagnostic {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
  /** 诊断定位的 1 基行号（additive；旧实现不填 = 读数照旧） */
  readonly line?: number | null;
}

/** 编译器输出的最小契约（v1 / 2.0 同形） */
export interface MigrationCompilerOutput {
  /** 无 error 诊断才算 true；`text` 可为空串（失败时不保证有产物） */
  readonly ok: boolean;
  readonly text: string;
  readonly diagnostics?: readonly MigrationDiagnostic[];
}

/** v1 编译器（真入口：kojo-sugar `transpile`）；可抛错，harness 记为 blocked */
export type MigrationV1Compiler = (source: string) => MigrationCompilerOutput;

/** 2.0 编译器（真入口：core `compileKojoSource` + adapter backend）；可抛错 */
export type MigrationV2Compiler = (source: string) => MigrationCompilerOutput;

/** 迁移台账的一条（`line` = v1 源 1 基行号） */
export interface MigrationUnsupportedSite {
  readonly line: number;
  readonly construct: string;
  readonly code?: string;
}

/** 迁移器输出（`migrateKojoSourceSemantic` 的子集；不 import core 的具体类型，便于注入替身） */
export interface MigrationOutput {
  readonly ok: boolean;
  /** 迁移后文本；`ok=false` 时不可迁移区间原样保留（不是半成品） */
  readonly code: string;
  readonly unsupported: readonly MigrationUnsupportedSite[];
}

/** 迁移器（真入口：core `migrateKojoSourceSemantic`）；可抛错 */
export type MigrationMigrator = (source: string) => MigrationOutput;

/** case 的期望（语料清单里的基线；缺省 = 只报告，不判定） */
export interface MigrationCaseExpectation {
  readonly status: MigrationStatus;
  /** `status === 'blocked'` 时必须写明原因，否则期望本身不自洽 */
  readonly blockedReason?: MigrationBlockedReason | null;
}

/** 一条 case：v1 源 + 期望 */
export interface MigrationCase {
  readonly id: string;
  /** v1 源文本 */
  readonly source: string;
  readonly expect?: MigrationCaseExpectation | null;
}

/** 白名单归一化的命中项（报告可见：剥了什么、为什么剥） */
export interface MigrationNormalizationHit {
  readonly id: MigrationNormalizationId;
  /** 被剥掉 / 改写的行数（`eol` 记换行符处数） */
  readonly lines: number;
  readonly why: string;
}

/** 白名单项 id（写死在 `MIGRATION_NORMALIZATIONS`，测试逐条钉） */
export type MigrationNormalizationId =
  | 'bom'
  | 'eol'
  | 'machine-header'
  | 'comment-lines'
  | 'blank-lines'
  | 'wrapper-arg-list'
  | 'indent';

/** 一条差异（归一化后的行号，1 基；`baseline` = v1 产物侧） */
export interface MigrationDiffLine {
  readonly kind: 'removed' | 'added';
  readonly baselineLine: number | null;
  readonly candidateLine: number | null;
  readonly baseline: string | null;
  readonly candidate: string | null;
}

/** 差异摘要（diff 进 JSON 的可读形态） */
export interface MigrationDiffSummary {
  readonly same: number;
  readonly removed: number;
  readonly added: number;
  readonly firstDifference: MigrationDiffLine | null;
  /** 第一条差异起的最多 8 行（报告/断言用） */
  readonly excerpt: readonly MigrationDiffLine[];
}

/** 单 case 读数 */
export interface MigrationCaseReadings {
  readonly v1: {
    readonly ok: boolean;
    readonly lines: number;
    readonly errors: number;
    readonly firstErrorCode: string | null;
  };
  readonly v2: {
    readonly ok: boolean;
    readonly lines: number;
    readonly errors: number;
    readonly firstErrorCode: string | null;
  };
  readonly migration: {
    readonly ok: boolean;
    readonly unsupported: number;
    readonly unsupportedConstructs: readonly string[];
    readonly outputLines: number;
  };
  readonly normalization: readonly MigrationNormalizationHit[];
}

/** 单 case 报告 */
export interface MigrationCaseReport {
  readonly id: string;
  readonly status: MigrationStatus;
  readonly blockedReason: MigrationBlockedReason | null;
  /** blocked 的可定位成因（additive；`v1-compile-failed` 且首错为 `indent-mismatch` 时给出） */
  readonly blockedDetail: string | null;
  /** 与 `expect` 是否相符（无期望 = true，只报告） */
  readonly ok: boolean;
  /** 与期望不符的原因（人话；`ok=true` 时为 null） */
  readonly mismatch: string | null;
  readonly diff: MigrationDiffSummary;
  readonly readings: MigrationCaseReadings;
  /** 证据：两侧产物与迁移后源（golden 复核 / 调试用） */
  readonly products: {
    readonly v1: string | null;
    readonly migrated: string | null;
    readonly v2: string | null;
  };
}

/** construct 计数（迁移率分类） */
export interface MigrationConstructCount {
  readonly construct: string;
  readonly sites: number;
  readonly migrated: number;
  readonly unsupported: number;
}

/** 迁移率报告（可 JSON；字段序固定） */
export interface MigrationRateReport {
  readonly cases: number;
  readonly v1Sites: number;
  readonly autoMigrated: number;
  readonly unsupported: number;
  /** `autoMigrated / v1Sites`（无写法时为 0） */
  readonly migrationRate: number;
  readonly byConstruct: readonly MigrationConstructCount[];
}

/** 期望不符的一条（CLI 的失败清单） */
export interface MigrationCaseFailure {
  readonly id: string;
  /** `expectation` = 状态与期望不符；`golden` = 复核产物与语料 golden 不一致 */
  readonly kind: 'expectation' | 'golden';
  readonly message: string;
}

/** 状态分布汇总 */
export interface MigrationDifferentialSummary {
  readonly cases: number;
  readonly identical: number;
  readonly normalizedEqual: number;
  readonly differs: number;
  readonly blocked: number;
  readonly blockedByReason: readonly { readonly reason: MigrationBlockedReason; readonly cases: number }[];
  /** 全部 case 与期望相符（golden 复核的失败由 CLI 追加进 `failures`，不改本字段） */
  readonly ok: boolean;
}

/** 一次 differential 的完整结果 */
export interface MigrationDifferentialResult {
  readonly ok: boolean;
  readonly cases: readonly MigrationCaseReport[];
  readonly summary: MigrationDifferentialSummary;
  readonly migrationReport: MigrationRateReport;
  readonly failures: readonly MigrationCaseFailure[];
}

/** 注入依赖（编译器 / 迁移器 / 判别器全部注入；判别器缺省用 core 的 `classifyV1`） */
export interface MigrationDifferentialInput {
  readonly cases: readonly MigrationCase[];
  readonly compileV1: MigrationV1Compiler;
  readonly compile2: MigrationV2Compiler;
  readonly migrate: MigrationMigrator;
  /** v1 行判别器（迁移率分类用）；缺省 = core `classifyV1` */
  readonly classify?: MigrationClassifier;
}

/* ============================== 2. 归一化白名单 ============================== */

/** 一条白名单项的定义（id + 依据；报告与文档共用这一份） */
export interface MigrationNormalizationSpec {
  readonly id: MigrationNormalizationId;
  readonly why: string;
}

/**
 * **归一化白名单（写死，逐条给依据）**。
 *
 * 判据只有一条：这条差异**不可能是行为差异**，且成因是"两层 codegen 的包装/排版口径"而不是
 * 作者语义。任何落不到这条判据上的差异都不许进白名单——`differs` 是诚实读数，不是待修项。
 */
export const MIGRATION_NORMALIZATIONS: readonly MigrationNormalizationSpec[] = Object.freeze([
  Object.freeze({
    id: 'bom',
    why: 'UTF-8 BOM 是编码面（`encoding` check 的对象），引擎不把 BOM 当程序文本；两侧产物 BOM 与否不构成行为。',
  }),
  Object.freeze({
    id: 'eol',
    why: '行终止符是编码面（CRLF/LF）；ERB 引擎按行读，EOL 不构成行为（迁移层另有 M7.3 EOL 保留契约）。',
  }),
  Object.freeze({
    id: 'machine-header',
    why: '`;kojo2:` 是 2.0 backend 的**包装头**回显行（整行 `;` 注释），v1 codegen 没有这条回显；注释不是可执行行为。',
  }),
  Object.freeze({
    id: 'comment-lines',
    why: '整行 `;` 注释是 ERB 注释：引擎不执行、不打印。v1 会把源里的 `;` 注释原样带进产物、2.0 直接丢弃——注释留存策略不是行为。',
  }),
  Object.freeze({
    id: 'blank-lines',
    why: '空行不产生任何引擎指令（打印空行走 `PRINTFORML` 显式行）；产物里的纯空行是排版。',
  }),
  Object.freeze({
    id: 'wrapper-arg-list',
    why:
      '`# 机` 的包装头：2.0 backend 恒在**分发函数与其 CALL** 上带 `(ARG)` 形参声明（§3.5 参数声明），' +
      'v1 只在作者写了 `参数:` 时才带。仅当两侧产物**再没有其他 `ARG`/`ARGS` 记号**时才归一（否则 ARG 真被 ' +
      '读取，形参有无会改行为 ⇒ 不归一、记 `differs`）。',
  }),
  Object.freeze({
    id: 'indent',
    why:
      '前导空白在 ERB 里**没有语义**（引擎按行解析；块嵌套由 `IF`/`ENDIF` 这类行本身承载，行文本不变就改变不了挂点）。' +
      'v1 codegen 用 TAB、2.0 codegen 用 4 空格——这是两层排版口径差，不是作者语义差。',
  }),
]);

const NORMALIZATION_INDEX = new Map(MIGRATION_NORMALIZATIONS.map((entry) => [entry.id, entry]));

/**
 * UTF-8 BOM 的码元（U+FEFF）。
 *
 * 本模块只在**剥除**位置用到它（归一化 / 行计数），不是产出点——本仓"BOM 产出具"唯一性闸
 * （`encoding-policy`）统计的是 `\uFEFF` 字面与 BOM 字节三连，故这里刻意用码点常量表达，
 * 避免在扫描面上留下一个会被误读成"又一处 BOM 产出"的字面量。
 */
const BOM_CODE_POINT = 0xfeff;
const BOM_CHAR = String.fromCharCode(BOM_CODE_POINT);

/** 去掉开头的 BOM 码元（无则原样返回） */
function stripBomChar(text: string): string {
  return text.startsWith(BOM_CHAR) ? text.slice(BOM_CHAR.length) : text;
}

/** 按 id 取依据（报告与测试共用；缺项 = 白名单表缺陷，如实报 id） */
export function normalizationWhy(id: MigrationNormalizationId): string {
  return NORMALIZATION_INDEX.get(id)?.why ?? id;
}

/** 归一化结果：行 + 命中项 */
export interface NormalizedMigrationProduct {
  readonly lines: readonly string[];
  readonly hits: readonly MigrationNormalizationHit[];
  /** `wrapper-arg-list` 因 ARG 真被引用而放弃归一时的人话原因（否则 null） */
  readonly wrapperArgListSkipped: string | null;
}

/** `;kojo2:` 包装头（2.0 backend 的回显注释） */
const MACHINE_HEADER_RE = /^;\s*kojo2:/;

/** 分发函数 / `CALL` 上的形参表（只认 ARG 家族，别的一律不动） */
const WRAPPER_ARG_LIST_RE = /^(\s*)(@[^\s(]+|CALL[ \t]+[^\s(]+)\((?<params>[^()]*)\)$/;

/** ARG 记号（形参表之外还出现 = 真被读） */
const ARG_TOKEN_RE = /(^|[^A-Za-z0-9_])ARGS?(:[0-9]+)?([^A-Za-z0-9_]|$)/;

function isWrapperArgParam(params: string): boolean {
  const tokens = params.split(',').map((token) => token.trim());
  return tokens.length > 0 && tokens.every((token) => /^ARGS?(:[0-9]+)?$/.test(token));
}

/**
 * 按白名单归一一段产物（v1 与 2.0 两侧各跑一遍，同一份实现）。
 *
 * 顺序即语义：先剥编码面（BOM/EOL），再剥包装头/注释/空行，再归一行内包装头形参，
 * 最后统一前导空白。每一步都记命中行数——报告里"为什么算 equal"必须可复核。
 */
export function normalizeMigrationProduct(text: string): NormalizedMigrationProduct {
  const hits: MigrationNormalizationHit[] = [];
  const push = (id: MigrationNormalizationId, lines: number): void => {
    if (lines <= 0) return;
    hits.push({ id, lines, why: normalizationWhy(id) });
  };

  let body = text;
  if (body.charCodeAt(0) === BOM_CODE_POINT) {
    body = body.slice(1);
    push('bom', 1);
  }

  const crlf = (body.match(/\r\n/g) ?? []).length;
  const loneCr = (body.match(/\r(?!\n)/g) ?? []).length;
  if (crlf > 0 || loneCr > 0) {
    body = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    push('eol', crlf + loneCr);
  }

  const rawLines = body.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();

  const kept: string[] = [];
  let machineHeaders = 0;
  let commentLines = 0;
  let blankLines = 0;
  for (const line of rawLines) {
    if (MACHINE_HEADER_RE.test(line)) {
      machineHeaders++;
      continue;
    }
    const trimmedStart = line.trimStart();
    if (trimmedStart.startsWith(';') || trimmedStart.startsWith('//')) {
      commentLines++;
      continue;
    }
    if (trimmedStart.length === 0) {
      blankLines++;
      continue;
    }
    kept.push(line);
  }
  push('machine-header', machineHeaders);
  push('comment-lines', commentLines);
  push('blank-lines', blankLines);

  // 包装头形参：先试着剥，再看 ARG 是否在别处真被引用；真被引用就整步放弃（不猜）。
  let wrapperArgListSkipped: string | null = null;
  let stripped = 0;
  const withoutParams = kept.map((line) => {
    const match = WRAPPER_ARG_LIST_RE.exec(line);
    if (match === null) return line;
    const params = match.groups?.['params'] ?? '';
    if (!isWrapperArgParam(params)) return line;
    stripped++;
    return `${match[1] ?? ''}${match[2] ?? ''}`;
  });
  let lines = kept;
  if (stripped > 0) {
    const argStillUsed = withoutParams.some((line) => ARG_TOKEN_RE.test(line));
    if (argStillUsed) {
      wrapperArgListSkipped =
        '产物里除包装头形参外仍有 `ARG` / `ARGS` 记号：形参声明有无会改变 ARG 的可见性 ⇒ 不归一，记 `differs`。';
    } else {
      lines = withoutParams;
      push('wrapper-arg-list', stripped);
    }
  }

  let indented = 0;
  const unindented = lines.map((line) => {
    const next = line.replace(/^[ \t\u3000]+/, '');
    if (next !== line) indented++;
    return next;
  });
  push('indent', indented);

  return { lines: Object.freeze(unindented), hits: Object.freeze(hits), wrapperArgListSkipped };
}

/* ============================== 3. 逐行 diff ============================== */

const DIFF_EXCERPT_LIMIT = 8;

/** 逐行 LCS diff（规模上限与 conformance kit 同口径；超大输入退化为前后缀对齐） */
function diffLines(baseline: readonly string[], candidate: readonly string[]): readonly MigrationDiffLine[] {
  const n = baseline.length;
  const m = candidate.length;
  const out: MigrationDiffLine[] = [];
  if (n === 0 && m === 0) return Object.freeze(out);
  if (n === 0 || m === 0 || n * m > 4_000_000) {
    const prefix = Math.min(n, m);
    for (let i = prefix; i < n; i++) {
      out.push({ kind: 'removed', baselineLine: i + 1, candidateLine: null, baseline: baseline[i] ?? null, candidate: null });
    }
    for (let j = prefix; j < m; j++) {
      out.push({ kind: 'added', baselineLine: null, candidateLine: j + 1, baseline: null, candidate: candidate[j] ?? null });
    }
    return Object.freeze(out);
  }

  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const at = i * width + j;
      if (baseline[i] === candidate[j]) dp[at] = (dp[(i + 1) * width + (j + 1)] ?? 0) + 1;
      else dp[at] = Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + (j + 1)] ?? 0);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (baseline[i] === candidate[j]) {
      i++;
      j++;
      continue;
    }
    const down = dp[(i + 1) * width + j] ?? 0;
    const right = dp[i * width + (j + 1)] ?? 0;
    if (down >= right) {
      out.push({ kind: 'removed', baselineLine: i + 1, candidateLine: null, baseline: baseline[i] ?? null, candidate: null });
      i++;
    } else {
      out.push({ kind: 'added', baselineLine: null, candidateLine: j + 1, baseline: null, candidate: candidate[j] ?? null });
      j++;
    }
  }
  while (i < n) {
    out.push({ kind: 'removed', baselineLine: i + 1, candidateLine: null, baseline: baseline[i] ?? null, candidate: null });
    i++;
  }
  while (j < m) {
    out.push({ kind: 'added', baselineLine: null, candidateLine: j + 1, baseline: null, candidate: candidate[j] ?? null });
    j++;
  }
  return Object.freeze(out);
}

function summarizeDiff(diff: readonly MigrationDiffLine[], same: number): MigrationDiffSummary {
  const first = diff[0] ?? null;
  return {
    same,
    removed: diff.filter((item) => item.kind === 'removed').length,
    added: diff.filter((item) => item.kind === 'added').length,
    firstDifference: first,
    excerpt: Object.freeze(diff.slice(0, DIFF_EXCERPT_LIMIT)),
  };
}

/* ============================== 4. 迁移率 ============================== */

/** v1 判别种类 → 报告里的 construct 名（单一真源；语料清单的 `constructs` 用同一批词） */
const CONSTRUCT_LABELS: Readonly<Record<V1Kind['kind'], string>> = Object.freeze({
  blank: '空行',
  comment: '注释',
  kojo2: '已是 2.0 行',
  text: '叙事行',
  version: '版本声明',
  preprocessor: '预处理器',
  skipStart: 'SKIP 区',
  skipEnd: 'SKIP 区',
  rawAt: '原生 @ 块',
  headDecl: '文件头声明',
  timingHead: '时机块',
  timingHash: '# 时机 声明',
  ifHead: '如果 / 否则如果',
  elseHead: '否则',
  whenHead: '当 / 是 分支',
  isHead: '是 臂',
  branchHead: '分支规则池',
  askHead: '初回 / 询问 / 确认',
  hiddenHead: '隐藏情景 / 隐藏口上',
  loopHead: '循环族',
  loopEnd: '循环族',
  catchHead: '出错处理族',
  catchEnd: '出错处理族',
  dataHead: '数据表族',
  dataEnd: '数据表族',
  menuHead: '菜单',
  choiceHead: '选项块',
  choiceItem: '选项条目',
  colorHead: '着色',
  randomHead: '随机',
  randomInline: '随机',
  groupHead: '组',
  heartHead: '心形',
  heartLine: '心形',
  functionHead: '函数',
  callStatement: '调用',
  returnStatement: '返回',
  labelDecl: '标签',
  jumpStatement: '跳到',
  other: '清单外写法',
});

/** v1 判别器（core 的 `classifyV1` 返回 `Classified`，这里两种形状都收） */
export type MigrationClassifier = (body: string) => V1Kind | ClassifiedLike;

/** `classifyV1` 的外层形状（`{ kind, comment }`）——只取 `kind` */
export interface ClassifiedLike {
  readonly kind: V1Kind;
}

/** 归一判别器返回值：`V1Kind.kind` 是字符串，`Classified.kind` 是对象 */
function toKind(value: V1Kind | ClassifiedLike): V1Kind {
  const nested = (value as ClassifiedLike).kind;
  return typeof nested === 'object' ? nested : (value as V1Kind);
}

/** 一行 v1 的判别名（`other` 用判别器给的具体 construct，分类更细） */
export function v1ConstructOf(body: string, classify: MigrationClassifier = classifyV1): string {
  const kind = toKind(classify(body));
  if (kind.kind === 'other') return kind.construct;
  return CONSTRUCT_LABELS[kind.kind];
}

/** 一处 v1 写法（site） */
export interface V1Site {
  /** 1 基行号 */
  readonly line: number;
  readonly construct: string;
  /** 缩进层级（前导空白 4 宽一级：TAB=4、全角空格=2、空格=1） */
  readonly indent: number;
}

/** 整行是 v1/2.0 注释或空行（不是"写法"） */
function isNonSiteLine(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length === 0) return true;
  return trimmed.startsWith(';') || trimmed.startsWith('//');
}

function indentOf(line: string): number {
  const lead = /^[ \t\u3000]*/.exec(line)?.[0] ?? '';
  let width = 0;
  for (const ch of lead) width += ch === '\t' ? 4 : ch === '\u3000' ? 2 : 1;
  return Math.floor(width / 4);
}

/**
 * 逐行收集 v1 写法（**行口径**：一处 = 一行）。
 *
 * 口径说明：这里不合并块——`如果` 头与它的缩进体各算一处写法（作者的每一行都是他要维护的一处
 * v1 写法）。unsupported 的块覆盖在 `countMigrationRate` 里按缩进体折算，两处口径互补。
 */
export function collectV1Sites(source: string, classify: MigrationClassifier = classifyV1): readonly V1Site[] {
  const lines = stripBomChar(source).split(/\r\n|\r|\n/);
  const sites: V1Site[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const body = line.replace(/^[ \t\u3000]*/, '');
    if (isNonSiteLine(body)) continue;
    sites.push({ line: i + 1, construct: v1ConstructOf(body, classify), indent: indentOf(line) });
  }
  return Object.freeze(sites);
}

/** 一条 unsupported 覆盖的行区间（块级：头 + 所有更深缩进行；叶级：仅该行） */
function unsupportedRange(source: string, headLine: number): { readonly from: number; readonly to: number } {
  const lines = stripBomChar(source).split(/\r\n|\r|\n/);
  const headIndex = headLine - 1;
  const headLineText = lines[headIndex];
  if (headLineText === undefined) return { from: headLine, to: headLine };
  const headIndent = indentOf(headLineText);
  let end = headLine;
  for (let i = headIndex + 1; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const body = raw.replace(/^[ \t\u3000]*/, '');
    if (body.trim().length === 0) continue;
    if (indentOf(raw) <= headIndent) break;
    end = i + 1;
  }
  return { from: headLine, to: end };
}

/**
 * 迁移率：v1 写法总数 / 自动迁移数 / unsupported 数（按 construct 分类）。
 *
 * `unsupported` 行集合 = 台账每条按缩进体展开后的并集；`migrated` = 其余 site。
 */
export function countMigrationRate(
  cases: readonly { readonly id: string; readonly source: string; readonly unsupported: readonly MigrationUnsupportedSite[] }[],
  classify: MigrationClassifier = classifyV1,
): MigrationRateReport {
  const tally = new Map<string, { sites: number; migrated: number; unsupported: number }>();
  const bump = (construct: string, field: 'sites' | 'migrated' | 'unsupported'): void => {
    const entry = tally.get(construct) ?? { sites: 0, migrated: 0, unsupported: 0 };
    entry[field]++;
    entry.sites++;
    tally.set(construct, entry);
  };

  let v1Sites = 0;
  let unsupported = 0;
  for (const item of cases) {
    const sites = collectV1Sites(item.source, classify);
    const covered = new Map<number, string>();
    for (const entry of item.unsupported) {
      const range = unsupportedRange(item.source, entry.line);
      for (let line = range.from; line <= range.to; line++) {
        if (!covered.has(line)) covered.set(line, entry.construct);
      }
    }
    for (const site of sites) {
      v1Sites++;
      const blockedConstruct = covered.get(site.line);
      if (blockedConstruct !== undefined) {
        unsupported++;
        bump(blockedConstruct, 'unsupported');
      } else {
        bump(site.construct, 'migrated');
      }
    }
  }

  const byConstruct: MigrationConstructCount[] = [...tally.entries()]
    .map(([construct, entry]) => ({
      construct,
      sites: entry.sites,
      migrated: entry.migrated,
      unsupported: entry.unsupported,
    }))
    .sort(
      (left, right) =>
        right.sites - left.sites || (left.construct < right.construct ? -1 : left.construct > right.construct ? 1 : 0),
    );

  return {
    cases: cases.length,
    v1Sites,
    autoMigrated: v1Sites - unsupported,
    unsupported,
    migrationRate: v1Sites === 0 ? 0 : (v1Sites - unsupported) / v1Sites,
    byConstruct,
  };
}

/* ============================== 5. 主入口 ============================== */

/** 一次迁移调用的结果（抛错也算一种结果：不让一条坏 case 打断整批） */
export interface MigrationAttempt {
  readonly output: MigrationOutput | null;
  readonly threw: boolean;
}

/** 跑一次迁移器（与对拍同一口径；CLI / 测试复用） */
export function attemptMigration(migrate: MigrationMigrator, source: string): MigrationAttempt {
  try {
    return { output: migrate(source), threw: false };
  } catch {
    return { output: null, threw: true };
  }
}

function emptyDiff(): MigrationDiffSummary {
  return { same: 0, removed: 0, added: 0, firstDifference: null, excerpt: Object.freeze([]) };
}

/** 只留 error 级诊断（warning 不阻断对拍；与迁移/编译口径一致） */
function errorDiagnostics(diagnostics: readonly MigrationDiagnostic[] | undefined): readonly MigrationDiagnostic[] {
  return (diagnostics ?? []).filter((diagnostic) => diagnostic.severity === 'error');
}

/** 产物体量读数（末行换行不算一行） */
function lineCountOf(text: string): number {
  if (text.length === 0) return 0;
  const lines = stripBomChar(text).split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function uniqueConstructs(unsupported: readonly MigrationUnsupportedSite[]): readonly string[] {
  return Object.freeze([...new Set(unsupported.map((entry) => entry.construct))].sort());
}

interface RunCaseInput {
  readonly testCase: MigrationCase;
  readonly attempt: MigrationAttempt;
  readonly compileV1: MigrationV1Compiler;
  readonly compile2: MigrationV2Compiler;
}

/** 单 case 的对拍（编译器抛错也收进来，不让一条 bad case 打断整批） */
function runCase(input: RunCaseInput): MigrationCaseReport {
  const { testCase, attempt } = input;
  const expect = testCase.expect ?? null;
  const mismatchOf = (status: MigrationStatus, blockedReason: MigrationBlockedReason | null): string | null => {
    if (expect === null) return null;
    if (expect.status !== status) return `期望状态 ${expect.status}，实测 ${status}`;
    if (status !== 'blocked') return null;
    const expectedReason = expect.blockedReason ?? null;
    if (expectedReason !== blockedReason) {
      return `期望 blocked 原因 ${expectedReason ?? '(未写)'}，实测 ${blockedReason ?? '(未写)'}`;
    }
    return null;
  };
  const build = (
    status: MigrationStatus,
    blockedReason: MigrationBlockedReason | null,
    diff: MigrationDiffSummary,
    readings: MigrationCaseReadings,
    products: MigrationCaseReport['products'],
  ): MigrationCaseReport => {
    const mismatch = mismatchOf(status, blockedReason);
    return {
      id: testCase.id,
      status,
      blockedReason,
      blockedDetail: blockedDetailOf(blockedReason),
      ok: mismatch === null,
      mismatch,
      diff,
      readings,
      products,
    };
  };

  /**
   * blocked 的可定位成因（additive）：只解释 `indent-mismatch`——v1 的同一句报错压了
   * 四类成因，作者拿到 blocked 也不知道改哪儿。其余 code 原样保留，不抢 v1 的话。
   */
  function blockedDetailOf(reason: MigrationBlockedReason | null): string | null {
    if (reason !== 'v1-compile-failed') return null;
    const first = v1Errors[0];
    if (first === undefined || first.code !== 'indent-mismatch') return null;
    const line = first.line ?? null;
    if (line === null) return null;
    return diagnoseV1IndentMismatch(testCase.source, line)?.detail ?? null;
  }

  /* ---- 1. v1 侧（基线）---- */
  let v1Text: string | null = null;
  let v1Errors: readonly MigrationDiagnostic[] = [];
  let v1Ok = false;
  try {
    const output = input.compileV1(testCase.source);
    v1Ok = output.ok;
    v1Text = output.text;
    v1Errors = errorDiagnostics(output.diagnostics);
  } catch {
    v1Errors = [{ code: 'migration/compile-v1-threw', severity: 'error', message: 'v1 编译器抛错' }];
    v1Ok = false;
  }
  const v1Reading = {
    ok: v1Ok && v1Errors.length === 0,
    lines: v1Text === null ? 0 : lineCountOf(v1Text),
    errors: v1Errors.length,
    firstErrorCode: v1Errors[0]?.code ?? null,
  };

  /* ---- 2. 迁移 ---- */
  const migration = attempt.output;
  const unsupported = migration?.unsupported ?? [];
  const migrationReading = {
    ok: migration?.ok === true && !attempt.threw,
    unsupported: unsupported.length,
    unsupportedConstructs: uniqueConstructs(unsupported),
    outputLines: migration === null ? 0 : lineCountOf(migration.code),
  };
  const noV2 = { ok: false, lines: 0, errors: 0, firstErrorCode: null } as const;

  if (!v1Reading.ok || migration === null || !migration.ok) {
    const reason: MigrationBlockedReason = attempt.threw
      ? 'migration-error'
      : !v1Reading.ok
        ? 'v1-compile-failed'
        : 'migration-unsupported';
    return build(
      'blocked',
      reason,
      emptyDiff(),
      { v1: v1Reading, v2: noV2, migration: migrationReading, normalization: Object.freeze([]) },
      { v1: v1Text, migrated: migration?.code ?? null, v2: null },
    );
  }

  /* ---- 3. 2.0 侧 ---- */
  let v2Text: string | null = null;
  let v2Errors: readonly MigrationDiagnostic[] = [];
  let v2Ok = false;
  try {
    const output = input.compile2(migration.code);
    v2Ok = output.ok;
    v2Text = output.text;
    v2Errors = errorDiagnostics(output.diagnostics);
  } catch {
    v2Errors = [{ code: 'migration/compile-v2-threw', severity: 'error', message: '2.0 编译器抛错' }];
  }
  const v2Reading = {
    ok: v2Ok && v2Errors.length === 0,
    lines: v2Text === null ? 0 : lineCountOf(v2Text),
    errors: v2Errors.length,
    firstErrorCode: v2Errors[0]?.code ?? null,
  };
  if (!v2Reading.ok || v2Text === null || v1Text === null) {
    return build(
      'blocked',
      'v2-compile-failed',
      emptyDiff(),
      { v1: v1Reading, v2: v2Reading, migration: migrationReading, normalization: Object.freeze([]) },
      { v1: v1Text, migrated: migration.code, v2: v2Text },
    );
  }

  /* ---- 4. 逐字节 / 白名单比较 ---- */
  if (v1Text === v2Text) {
    return build(
      'identical',
      null,
      { ...emptyDiff(), same: lineCountOf(v1Text) },
      { v1: v1Reading, v2: v2Reading, migration: migrationReading, normalization: Object.freeze([]) },
      { v1: v1Text, migrated: migration.code, v2: v2Text },
    );
  }

  const normalizedV1 = normalizeMigrationProduct(v1Text);
  const normalizedV2 = normalizeMigrationProduct(v2Text);
  const diff = diffLines(normalizedV1.lines, normalizedV2.lines);
  const hits: MigrationNormalizationHit[] = [...normalizedV1.hits, ...normalizedV2.hits];
  const skipped = [normalizedV1.wrapperArgListSkipped, normalizedV2.wrapperArgListSkipped].filter(
    (item): item is string => item !== null,
  );
  if (skipped.length > 0) hits.push({ id: 'wrapper-arg-list', lines: 0, why: skipped[0] ?? '' });
  const same = Math.min(normalizedV1.lines.length, normalizedV2.lines.length) - diff.length;
  const readings: MigrationCaseReadings = {
    v1: v1Reading,
    v2: v2Reading,
    migration: migrationReading,
    normalization: Object.freeze(hits),
  };
  const status: MigrationStatus = diff.length === 0 ? 'normalized-equal' : 'differs';
  return build(status, null, summarizeDiff(diff, Math.max(same, 0)), readings, {
    v1: v1Text,
    migrated: migration.code,
    v2: v2Text,
  });
}

/**
 * 跑一批 case 的迁移 differential（纯函数；异常输入不外溢）。
 *
 * 返回的 `ok` = **全部 case 与期望相符**（无期望的 case 恒 true）。没有期望时恒 true——
 * "与期望一致"是回归门，不是"全部 equal"：全 `differs` 也可以是绿的，因为那是如实读到的现状。
 */
export function runMigrationDifferential(input: MigrationDifferentialInput): MigrationDifferentialResult {
  const classify = input.classify ?? classifyV1;
  const reports: MigrationCaseReport[] = [];
  const failures: MigrationCaseFailure[] = [];
  const rateCases: { readonly id: string; readonly source: string; readonly unsupported: readonly MigrationUnsupportedSite[] }[] = [];

  for (const testCase of input.cases) {
    const attempt = attemptMigration(input.migrate, testCase.source);
    const report = runCase({
      testCase,
      attempt,
      compileV1: input.compileV1,
      compile2: input.compile2,
    });
    reports.push(report);
    rateCases.push({ id: testCase.id, source: testCase.source, unsupported: attempt.output?.unsupported ?? [] });
    if (!report.ok) {
      failures.push({ id: report.id, kind: 'expectation', message: report.mismatch ?? '与期望不符' });
    }
  }

  const counts = { identical: 0, normalizedEqual: 0, differs: 0, blocked: 0 };
  const blockedReasons = new Map<MigrationBlockedReason, number>();
  for (const report of reports) {
    if (report.status === 'identical') counts.identical++;
    else if (report.status === 'normalized-equal') counts.normalizedEqual++;
    else if (report.status === 'differs') counts.differs++;
    else {
      counts.blocked++;
      const reason = report.blockedReason ?? 'migration-unsupported';
      blockedReasons.set(reason, (blockedReasons.get(reason) ?? 0) + 1);
    }
  }

  return {
    ok: failures.length === 0,
    cases: Object.freeze(reports),
    summary: {
      cases: reports.length,
      identical: counts.identical,
      normalizedEqual: counts.normalizedEqual,
      differs: counts.differs,
      blocked: counts.blocked,
      blockedByReason: Object.freeze(
        [...blockedReasons.entries()]
          .map(([reason, cases]) => ({ reason, cases }))
          .sort((left, right) => right.cases - left.cases || (left.reason < right.reason ? -1 : 1)),
      ),
      ok: failures.length === 0,
    },
    migrationReport: countMigrationRate(rateCases, classify),
    failures: Object.freeze(failures),
  };
}

/* ============================== 6. 语料目录（IO 注入） ============================== */

/** 注入的 IO 端口（与 conformance CLI 的 `ConformanceIoPort` 同形；只给文本 + 文件清单） */
export interface MigrationCorpusIo {
  /** 读一段 UTF-8 文本；不存在/不可读时抛错 */
  readonly readText: (path: string) => string;
  /** 列目录下的文件（**相对路径**，分隔符可 `/` 或 `\`）；不存在时抛错 */
  readonly listFiles: (dir: string) => readonly string[];
  /** 写一段 UTF-8 文本（`--out` 用；缺注 = 该宿主不支持落盘，CLI 报用法错误） */
  readonly writeText?: (path: string, text: string) => void;
}

/** 语料分层：双 golden（可迁移可编译） / v1 产物 + 台账（2.0 产物不可得） */
export type MigrationCorpusTier = 'dual-golden' | 'baseline+ledger';

/** 片段补全：由源 fixture 自带的测试衣口径决定，**不改写正文** */
export interface MigrationCorpusCompletion {
  /** 剥掉源文件首部 `//` 说明横幅（kojo-sugar golden 测试 `readKojo` 同口径） */
  readonly stripBanner: boolean;
  /** 源文件缺 `角色:` 时补的说话人；null = 不补 */
  readonly prependChara: string | null;
}

/** 清单里的一条（字段序固定，便于人读与 diff） */
export interface MigrationCorpusCaseRecord {
  readonly id: string;
  /** 源 fixture 的仓内路径（溯源） */
  readonly source: string;
  /** 源 fixture 内容的 sha256（复制保真凭据） */
  readonly sourceSha256: string;
  /** `.v1.kojo.txt` 开头被 loader 剥掉的溯源头注行数 */
  readonly headerLines: number;
  readonly eol: 'lf' | 'crlf';
  /**
   * 编码面 BOM 声明（M7.3「编码/EOL 保留」的读入侧）。
   *
   * - `none` = 无 BOM（旧清单缺省按此判）；
   * - `utf-8` = 文件首字节是三连 `EF BB BF`。
   *
   * loader 会先按声明复核实物字节、再把 BOM 剥掉后才把正文交给编译器：BOM 是编码面，
   * 不是程序文本（与归一化白名单 `bom` 同一条依据）。声明与实物不符 ⇒ 进 `problems`，
   * 不猜（否则 BOM 会混进首行，v1 侧直接 `unknown-identifier`）。
   */
  readonly bom?: 'none' | 'utf-8';
  readonly tier: MigrationCorpusTier;
  /** 该 case 覆盖的 v1 写法（按迁移报告同一套 construct 词表） */
  readonly constructs: readonly string[];
  readonly completion: MigrationCorpusCompletion;
  readonly notes: string;
  /** `null` = 只报告不判定（`--generate-manifest` 骨架用；首跑后再按读数填状态） */
  readonly expected: MigrationCaseExpectation | null;
}

/** 语料清单 */
export interface MigrationCorpusManifest {
  readonly schema: string;
  readonly notes: string;
  readonly cases: readonly MigrationCorpusCaseRecord[];
}

/** 一条 case 的 golden（`.v1.erb` / `.2.erb` / `.ledger.json`；缺项 = null） */
export interface MigrationCorpusGolden {
  readonly id: string;
  readonly v1Product: string | null;
  readonly v2Product: string | null;
  /** 台账原文（JSON 文本；解析在复核处） */
  readonly ledger: string | null;
}

/** 载入后的语料 */
export interface MigrationCorpus {
  readonly dir: string;
  readonly manifest: MigrationCorpusManifest | null;
  /** `source` 已剥头注并施加 completion（可直接喂编译器 / 迁移器） */
  readonly cases: readonly MigrationCase[];
  /** 与 `cases` 同序的清单项（供报告展示来源与覆盖面） */
  readonly records: readonly MigrationCorpusCaseRecord[];
  readonly goldens: ReadonlyMap<string, MigrationCorpusGolden>;
  /** 目录级问题（缺文件 / JSON 坏 / 头注行数越界）：直接进 CLI 失败清单 */
  readonly problems: readonly MigrationCaseFailure[];
}

/** 语料目录约定（loader 与语料机一致：只认这几个后缀）
 *
 * `.v1.kojo.txt` 而不是 `.v1.kojo`：语料是**迁移输入快照**，不是 v1 生产语料；仓内多处
 * 全仓扫描（tree-sitter A/B 棘轮等）按 `*.kojo` 递归收集，`.kojo.txt` 不在其内——
 * 否则迁移快照会被算进 v1 质量分母（批次三已踩过同类坑，见 PITFALLS）。
 */
export const MIGRATION_CORPUS_SUFFIXES = Object.freeze({
  manifest: 'manifest.json',
  v1: '.v1.kojo.txt',
  v1Product: '.v1.erb',
  v2Product: '.2.erb',
  ledger: '.ledger.json',
});

function normalizeDir(dir: string): string {
  const slashed = dir.replaceAll('\\', '/');
  if (slashed === '/' || slashed === '') return slashed;
  return slashed.replace(/\/+$/, '');
}

function normalizeRelPath(entry: string): string {
  let value = entry.replaceAll('\\', '/');
  while (value.startsWith('./')) value = value.slice(2);
  while (value.startsWith('/')) value = value.slice(1);
  return value;
}

function joinPath(dir: string, rel: string): string {
  if (dir === '' || dir === '.') return rel;
  if (dir === '/') return `/${rel}`;
  return `${dir}/${rel}`;
}

function corpusProblem(id: string, message: string): MigrationCaseFailure {
  return { id, kind: 'golden', message };
}

/**
 * 施加片段补全（与 kojo-sugar golden 测试 `readKojo` 同口径；纯文本，不改写正文）。
 *
 * EOL 按输入原样保留（M7.3）：CRLF 档切出来的行仍用 CRLF 拼回去，补的 `角色:` 行也用
 * 同一档行尾。早先实现固定 `join('\n')`，会把 CRLF 语料在 loader 这一步洗成 LF——
 * 那让"CRLF 字节保真"的判据在进编译器前就失效（源快照字节对了、编译输入不对）。
 */
export function applyMigrationCompletion(raw: string, completion: MigrationCorpusCompletion): string {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let lines = raw.split(/\r\n|\r|\n/);
  if (completion.stripBanner) lines = lines.filter((line) => !line.startsWith('//'));
  const text = lines.join(eol);
  if (completion.prependChara !== null && completion.prependChara.length > 0) {
    if (!/^[ \t]*角色\s*[:：]/m.test(text)) return `角色: ${completion.prependChara}${eol}${text}`;
  }
  return text;
}

/**
 * 载入语料目录（IO 注入；不读宿主的 argv / process）。
 *
 * 纪律：
 * - `manifest.json` 是**唯一真源**：没有它 = 语料不完整（问题清单里如实记），不猜 case 列表；
 * - `.v1.kojo.txt` 的头注行由 `headerLines` 精确剥掉（头注是溯源信息，不进编译输入）；
 * - golden / 台账缺失**不是**目录问题（blocked case 本来就没有 `.2.erb`），只在复核时报。
 */
export function loadMigrationCorpus(io: MigrationCorpusIo, dir: string): MigrationCorpus {
  const root = normalizeDir(dir);
  const problems: MigrationCaseFailure[] = [];
  let entries: readonly string[];
  try {
    entries = io.listFiles(root);
  } catch (error: unknown) {
    return {
      dir: root,
      manifest: null,
      cases: Object.freeze([]),
      records: Object.freeze([]),
      goldens: new Map(),
      problems: Object.freeze([corpusProblem('(io)', `无法列出语料目录 ${root}：${errorMessage(error)}`)]),
    };
  }
  const normalized = [...new Set(entries.map(normalizeRelPath))].sort();
  const fileSet = new Set(normalized);

  const manifestPath = joinPath(root, MIGRATION_CORPUS_SUFFIXES.manifest);
  let manifest: MigrationCorpusManifest | null = null;
  try {
    const parsed: unknown = JSON.parse(io.readText(manifestPath));
    if (!isManifest(parsed)) {
      problems.push(corpusProblem(MIGRATION_CORPUS_SUFFIXES.manifest, '清单形状不合法（缺 schema / cases 或字段类型不对）'));
    } else {
      manifest = parsed;
    }
  } catch (error: unknown) {
    problems.push(corpusProblem(MIGRATION_CORPUS_SUFFIXES.manifest, `无法读取清单 ${manifestPath}：${errorMessage(error)}`));
  }

  const records: MigrationCorpusCaseRecord[] = [];
  const cases: MigrationCase[] = [];
  const goldens = new Map<string, MigrationCorpusGolden>();
  for (const record of manifest?.cases ?? []) {
    const v1Rel = `${record.id}${MIGRATION_CORPUS_SUFFIXES.v1}`;
    if (!fileSet.has(v1Rel)) {
      problems.push(corpusProblem(record.id, `清单列了 case 但缺源文件 ${v1Rel}`));
      continue;
    }
    let stored: string;
    try {
      stored = io.readText(joinPath(root, v1Rel));
    } catch (error: unknown) {
      problems.push(corpusProblem(record.id, `无法读取 ${v1Rel}：${errorMessage(error)}`));
      continue;
    }
    // 编码面：先认实物字节，再与清单声明复核（声明是回归锚，不拿来"修"实物）。
    const actualBom: 'none' | 'utf-8' = stored.charCodeAt(0) === BOM_CODE_POINT ? 'utf-8' : 'none';
    const declaredBom = record.bom ?? 'none';
    if (declaredBom !== actualBom) {
      problems.push(
        corpusProblem(
          record.id,
          `${v1Rel} 的 BOM 声明是 ${declaredBom}，实物是 ${actualBom}（BOM 属编码面：声明与字节必须一致）`,
        ),
      );
      continue;
    }
    const decoded = actualBom === 'utf-8' ? stripBomChar(stored) : stored;
    const actualEol: 'lf' | 'crlf' = decoded.includes('\r\n') ? 'crlf' : 'lf';
    if (record.eol !== actualEol) {
      problems.push(
        corpusProblem(record.id, `${v1Rel} 的 EOL 声明是 ${record.eol}，实物是 ${actualEol}（按声明切会把头注切错）`),
      );
      continue;
    }
    const eol = actualEol === 'crlf' ? '\r\n' : '\n';
    const lines = decoded.split(eol);
    if (record.headerLines < 0 || record.headerLines >= lines.length) {
      problems.push(corpusProblem(record.id, `${v1Rel} 的头注行数 ${record.headerLines} 越界（共 ${lines.length} 行）`));
      continue;
    }
    const body = lines.slice(record.headerLines).join(eol);
    records.push(record);
    cases.push({
      id: record.id,
      source: applyMigrationCompletion(body, record.completion),
      expect: record.expected,
    });
    goldens.set(record.id, {
      id: record.id,
      v1Product: readOptional(io, root, fileSet, `${record.id}${MIGRATION_CORPUS_SUFFIXES.v1Product}`, problems),
      v2Product: readOptional(io, root, fileSet, `${record.id}${MIGRATION_CORPUS_SUFFIXES.v2Product}`, problems),
      ledger: readOptional(io, root, fileSet, `${record.id}${MIGRATION_CORPUS_SUFFIXES.ledger}`, problems),
    });
  }

  if (manifest !== null && manifest.cases.length === 0) {
    problems.push(corpusProblem('(empty)', '清单里没有任何 case：空语料不是"全绿"（检查 --dir 是否指对）'));
  }

  return {
    dir: root,
    manifest,
    cases: Object.freeze(cases),
    records: Object.freeze(records),
    goldens,
    problems: Object.freeze(problems),
  };
}

function readOptional(
  io: MigrationCorpusIo,
  root: string,
  fileSet: ReadonlySet<string>,
  rel: string,
  problems: MigrationCaseFailure[],
): string | null {
  if (!fileSet.has(rel)) return null;
  try {
    return io.readText(joinPath(root, rel));
  } catch (error: unknown) {
    problems.push(corpusProblem(rel, `无法读取 ${rel}：${errorMessage(error)}`));
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isManifest(value: unknown): value is MigrationCorpusManifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { schema?: unknown; cases?: unknown; notes?: unknown };
  if (typeof candidate.schema !== 'string' || !Array.isArray(candidate.cases)) return false;
  return candidate.cases.every((item: unknown) => {
    if (typeof item !== 'object' || item === null) return false;
    const entry = item as Partial<MigrationCorpusCaseRecord>;
    return (
      typeof entry.id === 'string' &&
      typeof entry.source === 'string' &&
      typeof entry.headerLines === 'number' &&
      typeof entry.completion === 'object' &&
      entry.completion !== null &&
      // `null` 合法 = 清单骨架的"只报告不判定"（`--generate-manifest` 初版）
      (entry.expected === null || (typeof entry.expected === 'object' && entry.expected !== null))
    );
  });
}

/* ============================== 7. golden 复核 ============================== */

/** 台账 golden 的可复核形状（写死；与生成器一致） */
export interface MigrationLedgerGolden {
  readonly id: string;
  readonly status: MigrationStatus;
  readonly blockedReason: MigrationBlockedReason | null;
  readonly v1: {
    readonly ok: boolean;
    readonly lines: number;
    readonly errors: number;
    readonly firstErrorCode: string | null;
  };
  readonly migration: {
    readonly ok: boolean;
    readonly unsupported: number;
    readonly unsupportedConstructs: readonly string[];
    readonly outputLines: number;
  };
}

/**
 * 复核语料 golden：`v1.erb` / `2.erb` 逐字节，`ledger.json` 逐字段。
 *
 * 复核是**回归门**：产物变了就红（哪怕"变好了"）——真产物是语料的锚，改它要走更新语料的流程。
 */
export function verifyMigrationGoldens(
  corpus: MigrationCorpus,
  result: MigrationDifferentialResult,
): readonly MigrationCaseFailure[] {
  const failures: MigrationCaseFailure[] = [];
  for (let i = 0; i < result.cases.length; i++) {
    const report = result.cases[i];
    if (report === undefined) continue;
    const golden = corpus.goldens.get(report.id) ?? null;
    if (golden === null) continue;

    if (golden.v1Product !== null && report.products.v1 !== golden.v1Product) {
      failures.push({
        id: report.id,
        kind: 'golden',
        message: `v1 产物与 ${report.id}${MIGRATION_CORPUS_SUFFIXES.v1Product} 不一致（${describeProductMismatch(golden.v1Product, report.products.v1)}）`,
      });
    }
    if (golden.v2Product !== null) {
      if (report.products.v2 === null) {
        failures.push({
          id: report.id,
          kind: 'golden',
          message: `有 ${report.id}${MIGRATION_CORPUS_SUFFIXES.v2Product} 基线，但本次没有 2.0 产物（status=${report.status}）`,
        });
      } else if (report.products.v2 !== golden.v2Product) {
        failures.push({
          id: report.id,
          kind: 'golden',
          message: `2.0 产物与 ${report.id}${MIGRATION_CORPUS_SUFFIXES.v2Product} 不一致（${describeProductMismatch(golden.v2Product, report.products.v2)}）`,
        });
      }
    }
    if (golden.ledger !== null) {
      const actual: MigrationLedgerGolden = {
        id: report.id,
        status: report.status,
        blockedReason: report.blockedReason,
        v1: report.readings.v1,
        migration: report.readings.migration,
      };
      let expected: unknown;
      try {
        expected = JSON.parse(golden.ledger);
      } catch (error: unknown) {
        failures.push({ id: report.id, kind: 'golden', message: `台账 golden 不是合法 JSON：${errorMessage(error)}` });
        continue;
      }
      if (!deepEqualJson(expected, actual)) {
        failures.push({
          id: report.id,
          kind: 'golden',
          message: `迁移台账与 ${report.id}${MIGRATION_CORPUS_SUFFIXES.ledger} 不一致（blockedReason / unsupported 计数 / construct 清单变了）`,
        });
      }
    }
  }
  return Object.freeze(failures);
}

/** 产物不一致的一句话摘要（长度 + 第一条差异行） */
function describeProductMismatch(expected: string, actual: string | null): string {
  if (actual === null) return '本次没有产物';
  const expectedLines = expected.split(/\r\n|\r|\n/);
  const actualLines = actual.split(/\r\n|\r|\n/);
  const limit = Math.min(expectedLines.length, actualLines.length);
  for (let i = 0; i < limit; i++) {
    if (expectedLines[i] !== actualLines[i]) {
      return `首差第 ${i + 1} 行：期望 ${clip(expectedLines[i] ?? '')} / 实得 ${clip(actualLines[i] ?? '')}`;
    }
  }
  return `行数 ${expectedLines.length} → ${actualLines.length}`;
}

function clip(text: string, limit = 80): string {
  return text.length <= limit ? JSON.stringify(text) : `${JSON.stringify(text.slice(0, limit))}…`;
}

/** 结构相等（只认 JSON 值；对象键序无关） */
function deepEqualJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqualJson(item, right[index]));
  }
  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
    const leftKeys = Object.keys(left as Record<string, unknown>);
    const rightKeys = Object.keys(right as Record<string, unknown>);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) =>
      deepEqualJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    );
  }
  return false;
}

/* ============================== 8. 真实目录 manifest 骨架 ============================== */

/** 生成骨架的结果（`text` 就是可直接落盘的 `manifest.json` 全文） */
export interface MigrationManifestSkeleton {
  readonly dir: string;
  readonly manifest: MigrationCorpusManifest;
  readonly text: string;
  readonly caseIds: readonly string[];
  /** 目录级问题（读不出 / 无候选）；缺伴生 golden 只记 note，不算问题 */
  readonly problems: readonly MigrationCaseFailure[];
}

/** 骨架顶注（与语料机约定同一套词；`expected:null` 的含义写清楚） */
const MANIFEST_SKELETON_NOTES = [
  '迁移 differential 语料清单（`--generate-manifest` 初版骨架）。',
  '由真实目录里现存的 `<id>.v1.kojo.txt` 反推 case；以下字段是**占位**，首跑前必须人工补：',
  '`source`（仓内/语料机溯源路径）、`sourceSha256`、`headerLines`（首部溯源头注行数；',
  '没头注填 0）、`completion`（源 fixture 自带的片段补全口径）、`expected`（首跑 `migrate-diff`',
  '后按实测 status/blockedReason 填；`null` = 只报告不判定）。',
  '`eol` / `bom` 由生成器按实物字节探测，loader 会复核声明与实物一致（编码面不猜）。',
].join('\n');

/**
 * 从真实目录生成 `manifest.json` 初版骨架（纯逻辑；IO 注入，不写盘）。
 *
 * 只认扁平目录（与 `loadMigrationCorpus` 同一约定：`v1Rel = <id>.v1.kojo.txt`）：
 * 子目录里的同名文件不会被猜成 case；清单骨架里把跳过的条目数写进 notes。
 */
export function generateMigrationManifest(io: MigrationCorpusIo, dir: string): MigrationManifestSkeleton {
  const root = normalizeDir(dir);
  const problems: MigrationCaseFailure[] = [];
  const notes: string[] = [MANIFEST_SKELETON_NOTES];
  let entries: readonly string[];
  try {
    entries = io.listFiles(root);
  } catch (error: unknown) {
    return {
      dir: root,
      manifest: { schema: 'kojo-migration-corpus/1', notes: MANIFEST_SKELETON_NOTES, cases: Object.freeze([]) },
      text: `${JSON.stringify({ schema: 'kojo-migration-corpus/1', notes: MANIFEST_SKELETON_NOTES, cases: [] }, null, 2)}\n`,
      caseIds: Object.freeze([]),
      problems: Object.freeze([corpusProblem('(io)', `无法列出语料目录 ${root}：${errorMessage(error)}`)]),
    };
  }

  const normalized = [...new Set(entries.map(normalizeRelPath))].sort();
  const fileSet = new Set(normalized);
  const nested: string[] = [];
  const ids: string[] = [];
  for (const entry of normalized) {
    if (!entry.endsWith(MIGRATION_CORPUS_SUFFIXES.v1)) continue;
    if (entry.includes('/')) {
      nested.push(entry);
      continue;
    }
    ids.push(entry.slice(0, -MIGRATION_CORPUS_SUFFIXES.v1.length));
  }
  ids.sort();
  if (nested.length > 0) {
    notes.push(`跳过 ${nested.length} 份子目录候选（loader 只认扁平目录）：${nested.slice(0, 3).join('、')}${nested.length > 3 ? ' …' : ''}`);
  }
  if (ids.length === 0) {
    problems.push(
      corpusProblem('(empty)', `目录里没有 <id>${MIGRATION_CORPUS_SUFFIXES.v1}；检查 --dir 是否指到真实语料目录`),
    );
  }

  const cases: MigrationCorpusCaseRecord[] = [];
  for (const id of ids) {
    const v1Rel = `${id}${MIGRATION_CORPUS_SUFFIXES.v1}`;
    let stored: string;
    try {
      stored = io.readText(joinPath(root, v1Rel));
    } catch (error: unknown) {
      problems.push(corpusProblem(id, `无法读取 ${v1Rel}：${errorMessage(error)}`));
      continue;
    }
    const bom: 'none' | 'utf-8' = stored.charCodeAt(0) === BOM_CODE_POINT ? 'utf-8' : 'none';
    const decoded = bom === 'utf-8' ? stripBomChar(stored) : stored;
    const hasCrlf = decoded.includes('\r\n');
    const hasLoneLf = /\n/.test(decoded.replace(/\r\n/g, ''));
    const eol: 'lf' | 'crlf' = hasCrlf ? 'crlf' : 'lf';
    const constructs = [...new Set(collectV1Sites(decoded).map((site) => site.construct))].sort();
    const missing: string[] = [];
    for (const suffix of [MIGRATION_CORPUS_SUFFIXES.v1Product, MIGRATION_CORPUS_SUFFIXES.ledger]) {
      if (!fileSet.has(`${id}${suffix}`)) missing.push(`${id}${suffix}`);
    }
    const dual = fileSet.has(`${id}${MIGRATION_CORPUS_SUFFIXES.v2Product}`);
    const noteParts = [
      '`--generate-manifest` 初版骨架：source / sourceSha256 / headerLines / completion / expected 待补；首跑后按读数填。',
    ];
    if (hasCrlf && hasLoneLf) noteParts.push('⚠ 实物是混合 EOL（CRLF + 裸 LF）：loader 只认单一档，先统一行尾。');
    if (!dual && !fileSet.has(`${id}${MIGRATION_CORPUS_SUFFIXES.ledger}`)) {
      noteParts.push(`缺伴生 ${missing.join(' / ') || 'golden'}：blocked case 至少要有 .ledger.json。`);
    }
    cases.push({
      id,
      source: v1Rel,
      sourceSha256: '',
      headerLines: 0,
      eol,
      bom,
      tier: dual ? 'dual-golden' : 'baseline+ledger',
      constructs,
      completion: { stripBanner: false, prependChara: null },
      notes: noteParts.join(' '),
      expected: null,
    });
  }

  const manifest: MigrationCorpusManifest = {
    schema: 'kojo-migration-corpus/1',
    notes: notes.join('\n'),
    cases: Object.freeze(cases),
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  return {
    dir: root,
    manifest,
    text,
    caseIds: Object.freeze(cases.map((entry) => entry.id)),
    problems: Object.freeze(problems),
  };
}

/* ============================== 9. CLI（纯逻辑；IO / 编译器注入） ============================== */

export const MIGRATION_CLI_USAGE = [
  '用法:',
  '  kojo-conformance migrate-diff --dir <语料目录> [--json] [--no-golden]',
  '  kojo-conformance migrate-diff --dir <真实目录> --generate-manifest [--out <manifest.json>]',
  '  kojo-conformance migrate-diff help',
  '',
  '真实目录还没有 manifest.json 时（先出骨架，再人工补字段）:',
  '  node tools/kojo-conformance.mjs migrate-diff --generate-manifest --dir <真实目录>',
  '  骨架打印到 stdout；`--out <path>` 直接落盘（占位字段见骨架顶注）。',
  '',
  '语料目录约定（见 <目录>/manifest.json）:',
  '  <id>.v1.kojo.txt v1 源（首 headerLines 行是溯源头注，不进编译）',
  '  <id>.v1.erb      v1 真产物 golden（首次生成后即回归基线）',
  '  <id>.2.erb       2.0 真产物 golden（仅可迁移可编译的 case 有）',
  '  <id>.ledger.json 迁移台账 golden（blocked case 的缺口清单）',
  '',
  '真实语料复跑（语料机到位后）:',
  '  KOJO_MIGRATION_CORPUS_DIR=<语料机目录> node tools/kojo-conformance.mjs migrate-diff',
  '  （未给 --dir 时读该环境变量；语料机目录按同一 manifest 约定先落双 golden，再跑这条）',
  '',
  '退出码: 0 全部与期望一致 / 1 有失败（状态不符 / golden 漂移 / 语料缺件）/ 2 用法错误',
].join('\n');

/** CLI 报告：case 只留读数与差异摘要（产物不进 JSON，避免报告被 golden 淹没） */
export interface MigrationCliCaseReport {
  readonly id: string;
  readonly status: MigrationStatus;
  readonly blockedReason: MigrationBlockedReason | null;
  /** blocked 的可定位成因（additive；`null` = 无更细解释） */
  readonly blockedDetail: string | null;
  readonly ok: boolean;
  readonly diff: {
    readonly removed: number;
    readonly added: number;
    readonly firstDifference: MigrationDiffLine | null;
  };
  readonly readings: MigrationCaseReadings;
  readonly expected: MigrationCaseExpectation | null;
}

/** CLI 报告（顶层字段序固定：dir / summary / rate / cases / failures / usage） */
export interface MigrationCliReport {
  readonly dir: string;
  readonly summary: MigrationDifferentialSummary;
  readonly migrationReport: MigrationRateReport;
  readonly cases: readonly MigrationCliCaseReport[];
  readonly failures: readonly MigrationCaseFailure[];
  /** 非 null = 用法 / help 文本（exit 2 或 help；`--json` 对它不生效） */
  readonly usage: string | null;
  /** 非 null = `--generate-manifest` 模式（`text` 恒为可直接落盘的清单全文） */
  readonly manifest: {
    readonly text: string;
    readonly outPath: string | null;
    readonly cases: number;
  } | null;
}

/** CLI 依赖：IO + 三条真入口（v1 编译 / 2.0 编译 / 迁移）；本模块不认识任何具体游戏或插件 */
export interface MigrationCliDeps {
  readonly io: MigrationCorpusIo;
  readonly compileV1: MigrationV1Compiler;
  readonly compile2: MigrationV2Compiler;
  readonly migrate: MigrationMigrator;
  readonly classify?: MigrationClassifier;
}

/** CLI 结果：退出码 + 文本（调用方自己写 stdout / 落 exitCode） */
export interface MigrationCliResult {
  readonly exitCode: 0 | 1 | 2;
  readonly report: MigrationCliReport;
  readonly text: string;
}

interface MigrationCliArgs {
  readonly dir: string | null;
  readonly json: boolean;
  readonly golden: boolean;
  readonly help: boolean;
  readonly generateManifest: boolean;
  readonly out: string | null;
  readonly error: string | null;
}

function parseMigrationArgs(argv: readonly string[]): MigrationCliArgs {
  if (argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
    return {
      dir: null,
      json: argv.includes('--json'),
      golden: false,
      help: true,
      generateManifest: false,
      out: null,
      error: null,
    };
  }
  let dir: string | null = null;
  let json = false;
  let golden = true;
  let generateManifest = false;
  let out: string | null = null;
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
    if (token === 'migrate-diff') continue;
    if (token === '--json') {
      if (json) fail('重复参数：--json');
      json = true;
      continue;
    }
    if (token === '--no-golden') {
      if (!golden) fail('重复参数：--no-golden');
      golden = false;
      continue;
    }
    if (token === '--generate-manifest') {
      if (generateManifest) fail('重复参数：--generate-manifest');
      generateManifest = true;
      continue;
    }
    if (token === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        fail('缺少 --out 的值');
        continue;
      }
      i++;
      if (out !== null) fail('重复参数：--out');
      else if (value.trim().length === 0) fail('--out 的值不能为空');
      else out = value;
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
  return { dir, json, golden, help: false, generateManifest, out, error };
}

function emptySummary(): MigrationDifferentialSummary {
  return {
    cases: 0,
    identical: 0,
    normalizedEqual: 0,
    differs: 0,
    blocked: 0,
    blockedByReason: Object.freeze([]),
    ok: true,
  };
}

function emptyRate(): MigrationRateReport {
  return { cases: 0, v1Sites: 0, autoMigrated: 0, unsupported: 0, migrationRate: 0, byConstruct: Object.freeze([]) };
}

function usageReport(dir: string, reason: string): MigrationCliReport {
  return {
    dir,
    summary: emptySummary(),
    migrationReport: emptyRate(),
    cases: Object.freeze([]),
    failures: Object.freeze([]),
    usage: `${MIGRATION_CLI_USAGE}\n\n错误：${reason}`,
    manifest: null,
  };
}

function formatRate(rate: MigrationRateReport): string {
  const percent = (rate.migrationRate * 100).toFixed(1);
  return `迁移率 ${rate.autoMigrated}/${rate.v1Sites} 处 v1 写法（${percent}%）· unsupported ${rate.unsupported}`;
}

/**
 * 人话报告：状态分布 → 迁移率（按 construct）→ 逐 case → 失败清单 → 结论。
 *
 * `--json` 输出 `JSON.stringify(report, null, 2)`：顶层字段序固定、case 顺序 = 清单顺序、失败顺序稳定。
 */
export function formatMigrationReport(report: MigrationCliReport, options: { readonly json?: boolean } = {}): string {
  if (report.usage !== null) return `${report.usage}\n`;
  if (report.manifest !== null) {
    if (report.failures.length > 0) {
      // 生成失败（空目录 / 读不出 / 写盘失败）时不能只打一份空骨架：失败原因要上屏
      return `${[
        '清单骨架生成失败：',
        ...report.failures.map((failure) => `  [${failure.kind}] ${failure.id}  ${failure.message}`),
        '',
        `用法：${
          MIGRATION_CLI_USAGE.split('\n').find((line) => line.includes('node tools/kojo-conformance.mjs'))?.trim() ??
          'node tools/kojo-conformance.mjs migrate-diff --generate-manifest --dir <真实目录>'
        }`,
      ].join('\n')}\n`;
    }
    // 骨架模式：stdout 直接就是可落盘的 manifest.json（`--out` 时改成人话回执，全文进文件）
    if (report.manifest.outPath === null) return report.manifest.text;
    return `已写入清单骨架 ${report.manifest.outPath}（${report.manifest.cases} cases；占位字段见文件顶注）\n`;
  }
  if (options.json === true) return `${JSON.stringify(report, null, 2)}\n`;

  const summary = report.summary;
  const lines: string[] = [
    `kojo-conformance migrate-diff · dir=${report.dir} · ${summary.cases} cases` +
      ` · identical ${summary.identical} · normalized-equal ${summary.normalizedEqual}` +
      ` · differs ${summary.differs} · blocked ${summary.blocked}`,
    formatRate(report.migrationReport),
  ];
  if (summary.blockedByReason.length > 0) {
    lines.push(
      `blocked: ${summary.blockedByReason.map((item) => `${item.reason} ${item.cases}`).join(' · ')}`,
    );
  }
  if (report.migrationReport.byConstruct.length > 0) {
    lines.push('按 construct:');
    for (const row of report.migrationReport.byConstruct) {
      lines.push(
        `  ${row.construct}  sites=${row.sites} migrated=${row.migrated} unsupported=${row.unsupported}`,
      );
    }
  }
  lines.push('cases:');
  for (const item of report.cases) {
    const blocked = item.blockedReason === null ? '' : `  (${item.blockedReason})`;
    const detail = item.blockedDetail === null ? '' : `  — ${item.blockedDetail}`;
    lines.push(`  ${item.ok ? 'PASS' : 'FAIL'}  ${item.id}  ${item.status}${blocked}${detail}`);
    if (item.diff.firstDifference !== null) {
      const first = item.diff.firstDifference;
      const side = first.baseline ?? first.candidate ?? '';
      lines.push(`      diff -${item.diff.removed}/+${item.diff.added}  ${
        first.kind === 'removed' ? `v1 独有：${clip(side, 60)}` : `2.0 独有：${clip(side, 60)}`
      }`);
    }
  }
  if (report.failures.length > 0) {
    lines.push('', `FAILURES (${report.failures.length})`);
    for (const failure of report.failures) {
      lines.push(`  [${failure.kind}] ${failure.id}  ${failure.message}`);
    }
  }
  lines.push('', report.failures.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${report.failures.length} failures, exit 1)`);
  return `${lines.join('\n')}\n`;
}

/**
 * `migrate-diff` 主入口（纯逻辑；零 `process.exit`、零宿主 API）。
 *
 * 流程：载入语料 → differential → golden 复核 → 组装报告。失败清单 = 状态与期望不符 +
 * golden 漂移 + 语料缺件；`--no-golden` 只跳过 golden 复核（状态门仍生效）。
 */
export function runMigrationCli(argv: readonly string[], deps: MigrationCliDeps): MigrationCliResult {
  const parsed = parseMigrationArgs(argv);
  if (parsed.help) {
    const report: MigrationCliReport = {
      dir: '',
      summary: emptySummary(),
      migrationReport: emptyRate(),
      cases: Object.freeze([]),
      failures: Object.freeze([]),
      usage: MIGRATION_CLI_USAGE,
      manifest: null,
    };
    return { exitCode: 0, report, text: `${MIGRATION_CLI_USAGE}\n` };
  }
  if (parsed.error !== null) {
    const report = usageReport(parsed.dir ?? '', parsed.error);
    return { exitCode: 2, report, text: formatMigrationReport(report) };
  }
  if (parsed.dir === null) {
    const reason = parsed.generateManifest
      ? '--generate-manifest 需要 --dir <真实目录>：node tools/kojo-conformance.mjs migrate-diff --generate-manifest --dir <目录>'
      : 'migrate-diff 需要 --dir <语料目录>（目录里没有 manifest.json 时先跑 --generate-manifest）';
    const report = usageReport('', reason);
    return { exitCode: 2, report, text: formatMigrationReport(report) };
  }
  if (parsed.out !== null && !parsed.generateManifest) {
    const report = usageReport(parsed.dir, '--out 只能与 --generate-manifest 一起用');
    return { exitCode: 2, report, text: formatMigrationReport(report) };
  }

  if (parsed.generateManifest) {
    const skeleton = generateMigrationManifest(deps.io, parsed.dir);
    const failures: MigrationCaseFailure[] = [...skeleton.problems];
    let outPath: string | null = null;
    // 有问题（空目录 / 读不出）时不写半成品骨架：先让失败原因上屏
    if (parsed.out !== null && failures.length === 0) {
      if (deps.io.writeText === undefined) {
        failures.push(corpusProblem('(io)', `本宿主不支持写盘，无法 --out ${parsed.out}；去掉 --out 让骨架走 stdout`));
      } else {
        try {
          deps.io.writeText(parsed.out, skeleton.text);
          outPath = parsed.out;
        } catch (error: unknown) {
          failures.push(corpusProblem('(io)', `写入 ${parsed.out} 失败：${errorMessage(error)}`));
        }
      }
    }
    const report: MigrationCliReport = {
      dir: skeleton.dir,
      summary: emptySummary(),
      migrationReport: emptyRate(),
      cases: Object.freeze([]),
      failures: Object.freeze(failures),
      usage: null,
      manifest: { text: skeleton.text, outPath, cases: skeleton.caseIds.length },
    };
    const exitCode: 0 | 1 = failures.length === 0 && skeleton.caseIds.length > 0 ? 0 : 1;
    return { exitCode, report, text: formatMigrationReport(report) };
  }

  const corpus = loadMigrationCorpus(deps.io, parsed.dir);
  const result = runMigrationDifferential({
    cases: corpus.cases,
    compileV1: deps.compileV1,
    compile2: deps.compile2,
    migrate: deps.migrate,
    ...(deps.classify === undefined ? {} : { classify: deps.classify }),
  });
  const failures: MigrationCaseFailure[] = [...corpus.problems, ...result.failures];
  if (corpus.manifest === null) {
    // 缺清单是"用法没走对"，不是产物差异：把下一步命令直接写在失败清单里（不静默）
    failures.push(
      corpusProblem(
        'manifest.json',
        `缺 manifest.json：先跑 \`migrate-diff --generate-manifest --dir ${parsed.dir}\` 生成骨架，补 source/headerLines/expected 后再跑本命令`,
      ),
    );
  }
  if (parsed.golden) failures.push(...verifyMigrationGoldens(corpus, result));

  const cases: MigrationCliCaseReport[] = result.cases.map((report) => ({
    id: report.id,
    status: report.status,
    blockedReason: report.blockedReason,
    blockedDetail: report.blockedDetail,
    ok: report.ok,
    diff: {
      removed: report.diff.removed,
      added: report.diff.added,
      firstDifference: report.diff.firstDifference,
    },
    readings: report.readings,
    expected: corpus.cases.find((item) => item.id === report.id)?.expect ?? null,
  }));

  const report: MigrationCliReport = {
    dir: corpus.dir,
    summary: result.summary,
    migrationReport: result.migrationReport,
    cases: Object.freeze(cases),
    failures: Object.freeze(failures),
    usage: null,
    manifest: null,
  };
  const exitCode: 0 | 1 = failures.length === 0 ? 0 : 1;
  return { exitCode, report, text: formatMigrationReport(report) };
}


