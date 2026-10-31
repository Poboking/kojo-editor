/**
 * Kojo 2.0 迁移向导 · 模型层（M7.3 / M7.5 / U6.7）。
 *
 * 职责只有三件事，全部与 React 无关、可在 node 环境直接单测：
 *
 * 1. **dry-run**：`v1 source + filePath → migrateKojoSourceSemantic`，产出逐行 diff、
 *    语义升级台账（`rewrites`，每条自带一段 diff）、unsupported 台账（带原行文本）、
 *    诊断与逐文件迁移计划。dry-run 的 IO 端口类型只有 `readText`——"不写盘"不是靠
 *    调用方自觉，而是**类型上做不到**。
 * 2. **计划**：每个文件写明编码 / EOL 保留口径、写前备份、回滚口令
 *    （`restoreBackup(path, versionId)` 的原文提示），以及应用后回填的版本号。
 * 3. **应用**：先复核盘上内容仍是 dry-run 看到的那一份（防外部改动），再 `backup`
 *    → `writeText({ encoding:'preserve', eol:'preserve' })` → **readback 断言**；
 *    任一环失败（含回读不一致）都回滚到备份或显式重写原文。迁移失败不破坏源。
 *
 * 迁移引擎取 **语义层**（`migrateKojoSourceSemantic`，core 公共入口）：机械层对
 * `当 / 分支： / 初回` 三类构造一律记 unsupported，语义层把其中**可证**的那些先改写成 2.0
 * 文本、再交给机械层收口，并额外给出 `rewrites` 台账。落盘判据仍是机械层的 `ok`
 * （语义层是 `MigrateResult` 的超集，返回值结构兼容）——本层不放松 fail-closed。
 *
 * 目标口径（设计稿 §16.7 U6.7 裁决，写死在这里）：
 * **原地改写** —— `targetPath = filePath`，**不自动改扩展名**（不产出 `.kojo2`）、
 * **不删源文件**、不做"写完再删旧件"的两步。迁移后文件仍是 `.kojo`，内容为 2.0；
 * 切流阶段由 `kojo2-cutover` 的控制器决定用哪个解析器读它（本层不掺和路由）。
 *
 * 纪律：
 * - 读写只经 `@kojo/plugin-api` 的 `FileIO` 子集（真身 = `kernel.io`），测试注入假 io；
 * - 全部入参 / 返回值 readonly，零 `any`；错误只以字符串消息露出，不吞成静默；
 * - 整批默认 fail-closed：只要有一个文件阻断，`applyMigratePlan` 一个字节都不写。
 */
import { normalizeEol, splitEolLines } from '@kojo/plugin-api/eol';
import {
  migrateKojoSourceSemantic,
  summarizeMigration,
  type MigrateEventArgs,
  type SemanticMigrateResult,
  type SemanticRewrite,
  type SemanticRewriteKind,
} from '@kojo/kojo-core';
import type { EolStyle, FileEncoding, FileIO, TextFile } from '@kojo/plugin-api';

/**
 * 迁移向导的读写端口（`kernel.io` 的结构子集）。
 *
 * 只列迁移真正需要的四个能力：读、写、写前备份、按版本恢复。
 * `FileIO` 天然满足本接口，宿主直接传 `kernel.io` 即可。
 */
export type MigrateIoPort = Pick<FileIO, 'readText' | 'writeText' | 'backup' | 'restoreBackup'>;

/** dry-run 的只读端口：类型层面杜绝"预演时顺手写盘" */
export type MigrateReadPort = Pick<FileIO, 'readText'>;

/* ============================== 逐行 diff ============================== */

export type MigrateDiffKind = 'context' | 'added' | 'removed';

/** 一行 diff；`oldLine` / `newLine` 均为 1 基，缺省 = 该侧没有这一行 */
export interface MigrateDiffLine {
  readonly kind: MigrateDiffKind;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly text: string;
}

/**
 * 按迁移引擎的 `sourceMap`（新行 → 旧行）对齐两侧行，而不是另跑一套 LCS。
 *
 * 好处：①O(旧行 + 新行)，万行口上文件也不会在向导里卡住；②"这一行是从哪来的"
 * 与迁移引擎同源，不会出现 diff 说得通、迁移结果对不上的第二份判据。
 * 文本相同 = context（已 2.0 的行原样通过），文本改变 = removed + added。
 */
export function buildMigrateDiff(
  source: string,
  code: string,
  sourceMap: readonly number[],
): MigrateDiffLine[] {
  const oldLines = splitLines(source);
  const newLines = splitLines(code);
  const out: MigrateDiffLine[] = [];
  let nextOld = 1;

  for (let i = 0; i < newLines.length; i++) {
    const newLine = i + 1;
    const text = newLines[i] ?? '';
    const mapped = sourceMap[i];
    const oldLine = typeof mapped === 'number' && mapped >= 1 && mapped <= oldLines.length ? mapped : null;

    if (oldLine === null) {
      out.push({ kind: 'added', oldLine: null, newLine, text });
      continue;
    }

    // 映射跳过的旧行 = 迁移器丢弃的行（文件头元数据等）
    while (nextOld < oldLine) {
      out.push({ kind: 'removed', oldLine: nextOld, newLine: null, text: oldLines[nextOld - 1] ?? '' });
      nextOld++;
    }

    const oldText = oldLines[oldLine - 1] ?? '';
    if (nextOld === oldLine && oldText === text) {
      out.push({ kind: 'context', oldLine, newLine, text });
      nextOld = oldLine + 1;
    } else {
      if (nextOld === oldLine) {
        out.push({ kind: 'removed', oldLine, newLine: null, text: oldText });
        nextOld = oldLine + 1;
      }
      // 同一旧行产出多行时，后续新行只能是 added（不回退已消费的旧行）
      out.push({ kind: 'added', oldLine: null, newLine, text });
    }
  }

  while (nextOld <= oldLines.length) {
    out.push({ kind: 'removed', oldLine: nextOld, newLine: null, text: oldLines[nextOld - 1] ?? '' });
    nextOld++;
  }
  return out;
}

/** 统一 diff 文本（hunk 上下文 3 行）；给向导的 `<pre>` 预览与日志复制用 */
export function formatMigrateDiff(
  filePath: string,
  diff: readonly MigrateDiffLine[],
  context = 3,
): string {
  const header = [`--- a/${filePath}`, `+++ b/${filePath}`];
  if (diff.length === 0) return header.join('\n');

  const changed: number[] = [];
  for (let i = 0; i < diff.length; i++) if (diff[i]!.kind !== 'context') changed.push(i);
  if (changed.length === 0) return header.join('\n');

  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(diff.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  const lines: string[] = [...header];
  for (const range of ranges) {
    const slice = diff.slice(range.start, range.end + 1);
    let oldCount = 0;
    let newCount = 0;
    let oldStart = -1;
    let newStart = -1;
    for (const line of slice) {
      if (line.oldLine !== null) {
        oldCount++;
        if (oldStart < 0) oldStart = line.oldLine;
      }
      if (line.newLine !== null) {
        newCount++;
        if (newStart < 0) newStart = line.newLine;
      }
    }
    if (oldCount === 0) oldStart = boundaryStart(diff, range.start, 'oldLine');
    if (newCount === 0) newStart = boundaryStart(diff, range.start, 'newLine');

    lines.push(`@@ -${Math.max(0, oldStart)},${oldCount} +${Math.max(0, newStart)},${newCount} @@`);
    for (const line of slice) lines.push(`${diffPrefix(line.kind)}${line.text}`);
  }
  return lines.join('\n');
}

/** 纯插入 / 纯删除 hunk 的起始行：文件头无该侧行时写 0（unified diff 惯例） */
function boundaryStart(
  diff: readonly MigrateDiffLine[],
  start: number,
  side: 'oldLine' | 'newLine',
): number {
  for (let i = start - 1; i >= 0; i--) {
    const line = diff[i]!;
    const number = side === 'oldLine' ? line.oldLine : line.newLine;
    if (number !== null) return number;
  }
  return 0;
}

function diffPrefix(kind: MigrateDiffKind): string {
  if (kind === 'added') return '+';
  if (kind === 'removed') return '-';
  return ' ';
}

/* ============================== 语义升级台账 ============================== */

/**
 * 三种语义升级落点的人话（向导逐条上屏的标题；来源 = core `SemanticRewriteKind`）。
 *
 * 只在这里写一次：模型层不认识"表 / 池 / 原生围栏"的语义，它只是把 core 给的
 * `kind` 翻成人能读的一行标题——判据仍住在 core。
 */
const REWRITE_TITLES: Readonly<Record<SemanticRewriteKind, string>> = {
  'switch-table': '`当 / 是 / 否则` → `# 对照表` + 引用点',
  'branch-pool': '`分支：` → `# 池` + `! 池名`',
  'ask-native': '`初回 / 询问 / 确认` → `@原生` 围栏',
};

/**
 * 一条语义升级的上屏形态：**自带一段逐条 diff**（不是整份文件 diff 的碎片）。
 *
 * 为什么单独一段：整份 diff 里，`当` 块被换成 `# 对照表` 声明**提升到文件顶层** + 原位置换
 * 引用行，两处改动在整份 diff 里隔得很远；作者要点对"这条改写到底把哪几句搬走了"，
 * 只有把 `原块行 → 引用行` 并排放在一起才看得懂。
 */
export interface MigrateRewriteView {
  readonly kind: SemanticRewriteKind;
  /** 被改写的 v1 构造块头行（1 基） */
  readonly line: number;
  /** 该构造最后一行（含缩进体，1 基） */
  readonly endLine: number;
  /** 生成的表 / 池声明名；`ask-native` 为 null */
  readonly declName: string | null;
  /** 原位置替换出的引用行（`> {表}` / `! 池` / `@原生`） */
  readonly reference: string;
  /** 人话落点标题（见 `REWRITE_TITLES`） */
  readonly title: string;
  /** 被搬走的 v1 原块逐行原文（含块头与缩进体） */
  readonly removedLines: readonly string[];
  /** 该条改写的 diff 片段（向导逐条上屏 / 复制进迁移日志） */
  readonly diffText: string;
}

/**
 * core 的 `rewrites` → 上屏形态（纯函数；v1 原块文本从 `source` 按行号切出来）。
 *
 * 行号越界不猜：`line` 已经由 core 回映到 v1 源行，这里只做 `[line, endLine]` 的裁剪，
 * 切不到就退化成空块（diff 里只剩引用行），不编造原文。
 */
export function buildRewriteViews(
  filePath: string,
  source: string,
  rewrites: readonly SemanticRewrite[],
): MigrateRewriteView[] {
  const lines = splitLines(source);
  return rewrites.map((rewrite) => {
    const from = Math.max(1, rewrite.line);
    const to = Math.max(from, rewrite.endLine);
    const removedLines = lines.slice(from - 1, to);
    const view: Omit<MigrateRewriteView, 'diffText'> = {
      kind: rewrite.kind,
      line: rewrite.line,
      endLine: rewrite.endLine,
      declName: rewrite.declName,
      reference: rewrite.reference,
      title: REWRITE_TITLES[rewrite.kind],
      removedLines,
    };
    return { ...view, diffText: formatRewriteDiff(filePath, view) };
  });
}

/** 单条改写的 diff 文本：原块在左、落点在右（`ask-native` 的原块是被搬进围栏，故按 context 展示） */
export function formatRewriteDiff(
  filePath: string,
  rewrite: Omit<MigrateRewriteView, 'diffText'>,
): string {
  const kindTag = rewrite.declName === null ? rewrite.title : `${rewrite.title} · ${rewrite.declName}`;
  const head = [
    `--- a/${filePath}（v1 第 ${rewrite.line}–${rewrite.endLine} 行）`,
    `+++ b/${filePath}（2.0）`,
    `@@ ${kindTag} @@`,
  ];
  // `@原生` 围栏：原块逐行搬进围栏、一个字节都不解释 ⇒ 原块是 context，新增的只有围栏头
  const blockPrefix = rewrite.kind === 'ask-native' ? ' ' : '-';
  return [
    ...head,
    ...rewrite.removedLines.map((line) => `${blockPrefix}${line}`),
    `+${rewrite.reference}`,
  ].join('\n');
}

/* ============================== dry-run 结果 ============================== */

/** 不可迁移台账的上屏形态（多带一列原行文本） */
export interface MigrateUnsupportedView {
  /** v1 源 1 基行号 */
  readonly line: number;
  readonly construct: string;
  readonly targetHint: string;
  readonly code: string;
  /** 旧行原文（供向导原样展示"哪一句没迁"） */
  readonly sourceLine: string;
}

/** 诊断的上屏形态（带文件与行号） */
export interface MigrateDiagnosticView {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly line: number | null;
  readonly column: number | null;
  readonly filePath: string;
}

/** 写盘口径：编码 / EOL 一律 preserve（内核读时探测、写时保持） */
export interface MigrateWritePlan {
  readonly targetPath: string;
  readonly encoding: 'preserve';
  readonly eol: 'preserve';
  /** 写前必须已有备份（由 apply 先调 `io.backup`） */
  readonly preWriteBackup: true;
}

/** 备份 / 回滚口径（`versionId` 应用成功后才有；dry-run 阶段为 null） */
export interface MigrateBackupPlan {
  readonly required: true;
  readonly versionId: string | null;
  /** 给人看的应用说明 */
  readonly applyHint: string;
  /** 回滚口令：`restoreBackup(<path>, "<versionId>")` 的原文提示 */
  readonly rollbackHint: string;
}

/** 单文件读数（不参与判定，只供标题栏 / 列表 chips） */
export interface MigrateFileSummary {
  readonly ok: boolean;
  readonly unsupportedCount: number;
  readonly warningCount: number;
  readonly errorCount: number;
  readonly firstBlockedLine: number | null;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly newLineCount: number;
  /** 语义升级条数（`当` / `分支` / `初回` 里被可证改写的块） */
  readonly rewriteCount: number;
}

/** 单文件 dry-run + 迁移计划 */
export interface MigrateFilePlan {
  readonly filePath: string;
  /**
   * 目标路径 —— **原地改写**：恒等于 `filePath`（§16.7 U6.7 裁决）。
   *
   * 本层不改扩展名（不产出 `.kojo2`）、不删源：迁移后文件仍是 `.kojo`，内容为 2.0。
   * 字段保留是为了让"将来要落到别的路径"的模式（若设计稿改口径）有接线点，而不是
   * 现在就偷偷实现两套写盘语义。
   */
  readonly targetPath: string;
  readonly ok: boolean;
  /** 读盘 / 迁移引擎异常（非 unsupported）；有值即 ok=false */
  readonly error: string | null;
  readonly source: string;
  readonly code: string;
  /** 内容是否真的会变化（已 2.0 的文件 apply 时直接跳过） */
  readonly changed: boolean;
  readonly sourceEncoding: FileEncoding;
  readonly sourceEol: EolStyle;
  readonly write: MigrateWritePlan;
  readonly backup: MigrateBackupPlan;
  readonly diff: readonly MigrateDiffLine[];
  readonly diffText: string;
  /** 语义升级台账（core `rewrites` 的上屏形态；每条自带一段 diff） */
  readonly rewrites: readonly MigrateRewriteView[];
  readonly unsupported: readonly MigrateUnsupportedView[];
  readonly diagnostics: readonly MigrateDiagnosticView[];
  readonly summary: MigrateFileSummary;
}

/** 整批 dry-run 读数 */
export interface MigratePlanSummary {
  readonly fileCount: number;
  readonly migratableCount: number;
  readonly blockedCount: number;
  readonly readErrorCount: number;
  readonly unsupportedCount: number;
  readonly warningCount: number;
  readonly errorCount: number;
  readonly addedLines: number;
  readonly removedLines: number;
  /** 整批语义升级条数 */
  readonly rewriteCount: number;
}

/** 整批 dry-run 结果（`ok=false` ⇒ 默认拒绝整批写盘） */
export interface MigrateDryRun {
  readonly files: readonly MigrateFilePlan[];
  readonly ok: boolean;
  readonly summary: MigratePlanSummary;
}

/** `planMigrateFile` 入参：v1 源文本 + 文件身份 */
export interface MigratePlanInput {
  readonly filePath: string;
  readonly source: string;
  /** 内核读到的原编码（写盘时 preserve）；缺省按 utf-8 展示 */
  readonly encoding?: FileEncoding;
  /** 内核读到的原 EOL（写盘时 preserve）；缺省 lf */
  readonly eol?: EolStyle;
  /** v1 文件头缺 `角色:` 时的说话人兜底 */
  readonly speaker?: string;
  /**
   * adapter 事件目录的名字投影（`eventCatalog.events[].event`，K2-EVENT-FACEWORD）。
   *
   * 给了目录 ⇒ 迁移期就能把「`时机` 面词不在九事件内」判成 unsupported（不产会撞
   * `event/unknown` 的 `# 机`）；不给 ⇒ 沿用 v1 形状判定（不猜目录）。
   */
  readonly eventNames?: readonly string[];
  /**
   * adapter 事件**参数形状**投影（`projectEventArgs(eventCatalog)`，K2-MIGRATE-SHAPE）。
   *
   * 给了目录 ⇒ `时机 <面词> <参数…>` 的个数/形状在迁移期就校验（目录内面词但参数坏 →
   * unsupported，不产会在 2.0 撞 `event/argument` 的 `# 机`）；不给 ⇒ 沿用旧形状判定。
   */
  readonly eventArgs?: MigrateEventArgs;
}

/**
 * 纯函数：v1 源文本 → 单文件迁移计划（零 IO）。
 *
 * 这是 `dryRunMigrateFiles` 的内核，也直接供"编辑器里对当前 buffer 预演"用。
 */
export function planMigrateFile(input: MigratePlanInput): MigrateFilePlan {
  const filePath = input.filePath;
  const encoding = input.encoding ?? 'utf-8';
  const eol = input.eol ?? 'lf';
  const source = input.source;
  const targetPath = filePath;
  const write = writePlanFor(targetPath);
  const emptyDiffText = formatMigrateDiff(filePath, []);

  let result: SemanticMigrateResult;
  try {
    const migrateOptions: {
      speaker?: string;
      eventNames?: readonly string[];
      eventArgs?: MigrateEventArgs;
    } = {};
    if (input.speaker !== undefined) migrateOptions.speaker = input.speaker;
    if (input.eventNames !== undefined) migrateOptions.eventNames = input.eventNames;
    if (input.eventArgs !== undefined) migrateOptions.eventArgs = input.eventArgs;
    result = migrateKojoSourceSemantic(source, migrateOptions);
  } catch (error) {
    return failedPlan(filePath, targetPath, encoding, eol, errorText(error), emptyDiffText);
  }

  const diff = buildMigrateDiff(source, result.code, result.sourceMap);
  const diffText = formatMigrateDiff(filePath, diff);
  const sourceLines = splitLines(source);
  const rewrites = buildRewriteViews(filePath, source, result.rewrites);
  const unsupported: MigrateUnsupportedView[] = result.unsupported.map((item) => ({
    line: item.line,
    construct: item.construct,
    targetHint: item.targetHint,
    code: item.code,
    sourceLine: sourceLines[item.line - 1] ?? '',
  }));
  const summary = summarizeMigration(result);
  const addCount = diff.filter((line) => line.kind === 'added').length;
  const removeCount = diff.filter((line) => line.kind === 'removed').length;

  return {
    filePath,
    targetPath,
    ok: result.ok,
    error: null,
    source,
    code: result.code,
    changed: result.code !== source,
    sourceEncoding: encoding,
    sourceEol: eol,
    write,
    backup: backupPlanFor(filePath, null),
    diff,
    diffText,
    rewrites,
    unsupported,
    diagnostics: result.diagnostics.map((diagnostic) => diagnosticView(filePath, diagnostic)),
    summary: {
      ok: summary.ok,
      unsupportedCount: summary.unsupportedCount,
      warningCount: summary.warningCount,
      errorCount: summary.errorCount,
      firstBlockedLine: summary.firstBlockedLine,
      addedLines: addCount,
      removedLines: removeCount,
      newLineCount: splitLines(result.code).length,
      rewriteCount: rewrites.length,
    },
  };
}

/** 批量 dry-run（逐文件顺序读；单文件读失败只标记该文件，不抛整批） */
export async function dryRunMigrateFiles(
  io: MigrateReadPort,
  filePaths: readonly string[],
  options: {
    readonly speaker?: string;
    readonly eventNames?: readonly string[];
    readonly eventArgs?: MigrateEventArgs;
  } = {},
): Promise<MigrateDryRun> {
  const files: MigrateFilePlan[] = [];
  for (const filePath of filePaths) {
    let file: TextFile;
    try {
      file = await io.readText(filePath);
    } catch (error) {
      files.push(
        failedPlan(
          filePath,
          filePath,
          'utf-8',
          'lf',
          `读取失败：${errorText(error)}`,
          formatMigrateDiff(filePath, []),
        ),
      );
      continue;
    }
    files.push(
      planMigrateFile({
        filePath,
        source: file.text,
        encoding: file.encoding,
        eol: file.eol,
        ...(options.speaker === undefined ? {} : { speaker: options.speaker }),
        ...(options.eventNames === undefined ? {} : { eventNames: options.eventNames }),
        ...(options.eventArgs === undefined ? {} : { eventArgs: options.eventArgs }),
      }),
    );
  }
  return { files, ...summarizePlan(files) };
}

/* ============================== 应用 / 回滚 ============================== */

export type MigrateApplyStatus = 'applied' | 'rolled-back' | 'blocked' | 'stale' | 'failed';
export type MigrateRollbackMode = 'none' | 'restore-backup' | 'rewrite-source' | 'failed';

/** readback 事实（应用成功后回读的那一份） */
export interface MigrateReadback {
  readonly text: string;
  readonly encoding: FileEncoding;
  readonly eol: EolStyle;
}

/** 单文件应用结果 */
export interface MigrateFileApplyResult {
  readonly filePath: string;
  readonly status: MigrateApplyStatus;
  /** 是否真的写了盘（已 2.0 / 阻断 / stale = false） */
  readonly changed: boolean;
  readonly backupVersionId: string | null;
  readonly rollback: MigrateRollbackMode;
  /** 成功 = 迁移结果的回读；已回滚 = 恢复后的回读；取不到 = null */
  readonly readback: MigrateReadback | null;
  readonly message: string;
}

/** 整批应用结果 */
export interface MigrateApplyResult {
  /** 所有可执行文件都 applied，且没有任何回滚 / 失败 / stale */
  readonly ok: boolean;
  readonly files: readonly MigrateFileApplyResult[];
  readonly applied: number;
  /** 其中真正发生写盘的数量（已 2.0 的跳过不算） */
  readonly written: number;
  readonly rolledBack: number;
  readonly skipped: number;
  readonly message: string;
}

/** 应用选项 */
export interface MigrateApplyOptions {
  /**
   * 批次里有阻断文件时，是否仍应用其余文件。
   * 缺省 false = fail-closed（工程迁移的默认：要么整体迁完，要么一个字节都不动）。
   */
  readonly allowPartial?: boolean;
}

/** 整批应用：默认 fail-closed；逐文件串行，单文件失败只回滚该文件 */
export async function applyMigratePlan(
  io: MigrateIoPort,
  plan: MigrateDryRun,
  options: MigrateApplyOptions = {},
): Promise<MigrateApplyResult> {
  if (plan.files.length === 0) {
    return {
      ok: false,
      files: [],
      applied: 0,
      written: 0,
      rolledBack: 0,
      skipped: 0,
      message: '没有可迁移的文件',
    };
  }

  if (!plan.ok && options.allowPartial !== true) {
    const blocked = plan.files.map((file) =>
      skippedResult(file, '整批存在阻断文件，已拒绝写盘（源文件未被触碰）'),
    );
    return {
      ok: false,
      files: blocked,
      applied: 0,
      written: 0,
      rolledBack: 0,
      skipped: plan.files.length,
      message: `整批拒绝：${plan.summary.blockedCount + plan.summary.readErrorCount} 个文件阻断，未写入任何文件`,
    };
  }

  const files: MigrateFileApplyResult[] = [];
  for (const file of plan.files) {
    if (!file.ok) {
      files.push(skippedResult(file, file.error ?? '存在不可迁移行，未写盘'));
      continue;
    }
    files.push(await applyMigrateFile(io, file));
  }

  const applied = files.filter((file) => file.status === 'applied').length;
  const written = files.filter((file) => file.status === 'applied' && file.changed).length;
  const rolledBack = files.filter((file) => file.status === 'rolled-back').length;
  const skipped = files.filter((file) => file.status === 'blocked').length;
  const ok = files.every((file) => file.status === 'applied' || file.status === 'blocked');
  const message = ok
    ? `迁移完成：写入 ${written} 个文件${skipped > 0 ? `，跳过 ${skipped} 个阻断文件` : ''}`
    : `迁移未全部完成：写入 ${written}，回滚 ${rolledBack}，跳过 ${skipped}`;

  return { ok, files, applied, written, rolledBack, skipped, message };
}

/** 单文件撤销结果 */
export interface MigrateUndoFileResult {
  readonly filePath: string;
  readonly status: 'restored' | 'skipped' | 'failed';
  readonly readback: MigrateReadback | null;
  readonly message: string;
}

/** 整批撤销结果（应用成功后按备份版本回到迁移前） */
export interface MigrateUndoResult {
  readonly ok: boolean;
  readonly files: readonly MigrateUndoFileResult[];
  readonly restored: number;
  readonly skipped: number;
  readonly failed: number;
  readonly message: string;
}

/**
 * 撤销一次成功的应用：逐文件 `restoreBackup(versionId)` 并回读，断言回到迁移前文本。
 *
 * 撤销是"按本次写入留下的备份版本"恢复，不是重新跑迁移；恢复后仍不一致 = failed（上屏）。
 */
export async function undoMigratePlan(
  io: MigrateIoPort,
  plan: MigrateDryRun,
  applied: MigrateApplyResult,
): Promise<MigrateUndoResult> {
  const sourceOf = new Map(plan.files.map((file) => [file.filePath, file]));
  const files: MigrateUndoFileResult[] = [];

  for (const result of applied.files) {
    if (result.status !== 'applied' || !result.changed) {
      files.push({
        filePath: result.filePath,
        status: 'skipped',
        readback: result.readback,
        message: '本次未写入，无需撤销',
      });
      continue;
    }

    const original = sourceOf.get(result.filePath);
    if (original === undefined || result.backupVersionId === null) {
      files.push({
        filePath: result.filePath,
        status: 'failed',
        readback: null,
        message: '缺少迁移计划或备份版本号，无法撤销',
      });
      continue;
    }

    try {
      await io.restoreBackup(original.targetPath, result.backupVersionId);
      const readback = readbackOf(await io.readText(original.targetPath));
      if (normalizeText(readback.text) === normalizeText(original.source)) {
        files.push({
          filePath: result.filePath,
          status: 'restored',
          readback,
          message: `已按备份版本 ${result.backupVersionId} 恢复到迁移前`,
        });
      } else {
        files.push({
          filePath: result.filePath,
          status: 'failed',
          readback,
          message: '按备份恢复后回读与迁移前文本不一致',
        });
      }
    } catch (error) {
      files.push({
        filePath: result.filePath,
        status: 'failed',
        readback: null,
        message: `撤销失败：${errorText(error)}`,
      });
    }
  }

  const restored = files.filter((file) => file.status === 'restored').length;
  const skipped = files.filter((file) => file.status === 'skipped').length;
  const failed = files.filter((file) => file.status === 'failed').length;
  const ok = failed === 0 && restored > 0;
  return {
    ok,
    files,
    restored,
    skipped,
    failed,
    message:
      restored > 0
        ? `已撤销 ${restored} 个文件${failed > 0 ? `，${failed} 个失败` : ''}`
        : '没有可撤销的写入',
  };
}

/**
 * 单文件应用：复核 → 备份 → 写 → readback；任一步失败都回滚。
 *
 * 复核（stale）防的是"预演之后、点应用之前"盘上被外部改过——此时绝不能拿旧计划覆盖。
 */async function applyMigrateFile(
  io: MigrateIoPort,
  file: MigrateFilePlan,
): Promise<MigrateFileApplyResult> {
  if (!file.ok) return skippedResult(file, file.error ?? '存在不可迁移行，未写盘');

  // 已经 2.0：不备份、不写盘，避免无意义地改动 mtime 与备份账
  if (!file.changed) {
    return {
      filePath: file.filePath,
      status: 'applied',
      changed: false,
      backupVersionId: null,
      rollback: 'none',
      readback: null,
      message: '已是 2.0 写法，无需改写',
    };
  }

  let current: TextFile;
  try {
    current = await io.readText(file.targetPath);
  } catch (error) {
    return failedResult(file, `读取当前文件失败：${errorText(error)}`, null, null);
  }
  if (normalizeText(current.text) !== normalizeText(file.source)) {
    return {
      filePath: file.filePath,
      status: 'stale',
      changed: false,
      backupVersionId: null,
      rollback: 'none',
      readback: readbackOf(current),
      message: '文件在预演后被改动过，已放弃写入；请重新预演',
    };
  }

  let backupPath: string | null;
  try {
    backupPath = await io.backup(file.targetPath);
  } catch (error) {
    return failedResult(file, `写前备份失败：${errorText(error)}；未写入`, null, null);
  }
  if (backupPath === null) {
    return failedResult(file, '写前备份失败（备份返回空）；未写入', null, null);
  }
  const versionId = fileNameOf(backupPath);

  try {
    await io.writeText(file.targetPath, file.code, {
      encoding: 'preserve',
      eol: 'preserve',
      backup: false, // 本层已显式 backup（拿得到版本号），不让内核再备一份
    });
  } catch (error) {
    return rollbackAndReport(io, file, versionId, `写入失败：${errorText(error)}`);
  }

  let readback: TextFile;
  try {
    readback = await io.readText(file.targetPath);
  } catch (error) {
    return rollbackAndReport(io, file, versionId, `写入后回读失败：${errorText(error)}`);
  }
  if (normalizeText(readback.text) !== normalizeText(file.code)) {
    return rollbackAndReport(io, file, versionId, '回读内容与迁移结果不一致');
  }

  return {
    filePath: file.filePath,
    status: 'applied',
    changed: true,
    backupVersionId: versionId,
    rollback: 'none',
    readback: readbackOf(readback),
    message: '迁移已写入并通过回读校验',
  };
}

/** 回滚：优先按版本恢复；恢复不可用则显式重写原文；都不成 = failed（必须上屏） */
async function rollbackAndReport(
  io: MigrateIoPort,
  file: MigrateFilePlan,
  versionId: string,
  reason: string,
): Promise<MigrateFileApplyResult> {
  const attempts: string[] = [];
  let readback: MigrateReadback | null = null;

  try {
    await io.restoreBackup(file.targetPath, versionId);
    readback = readbackOf(await io.readText(file.targetPath));
    if (normalizeText(readback.text) === normalizeText(file.source)) {
      return {
        filePath: file.filePath,
        status: 'rolled-back',
        changed: true,
        backupVersionId: versionId,
        rollback: 'restore-backup',
        readback,
        message: `${reason}；已按备份版本 ${versionId} 回滚`,
      };
    }
    attempts.push('备份恢复后回读仍与原文不一致');
  } catch (error) {
    attempts.push(`备份恢复失败：${errorText(error)}`);
  }

  try {
    await io.writeText(file.targetPath, file.source, {
      encoding: 'preserve',
      eol: 'preserve',
      backup: false,
    });
    readback = readbackOf(await io.readText(file.targetPath));
    if (normalizeText(readback.text) === normalizeText(file.source)) {
      return {
        filePath: file.filePath,
        status: 'rolled-back',
        changed: true,
        backupVersionId: versionId,
        rollback: 'rewrite-source',
        readback,
        message: `${reason}；已重写原文回滚`,
      };
    }
    attempts.push('重写原文后回读仍不一致');
  } catch (error) {
    attempts.push(`重写原文失败：${errorText(error)}`);
  }

  return {
    filePath: file.filePath,
    status: 'failed',
    changed: true,
    backupVersionId: versionId,
    rollback: 'failed',
    readback,
    message: `${reason}；回滚失败：${attempts.join('；')}`,
  };
}

/* ============================== 小工具 ============================== */

/** 按 `\n` 切行；丢掉末尾换行产生的伪空行（与迁移引擎的 `readSource` 同口径） */
function splitLines(text: string): string[] {
  const parts = splitEolLines(text);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** readback / stale 判等用：内核读文本已归一化，这里再兜一层 CRLF 源 */
function normalizeText(text: string): string {
  return normalizeEol(text);
}

function writePlanFor(targetPath: string): MigrateWritePlan {
  return {
    targetPath,
    encoding: 'preserve',
    eol: 'preserve',
    preWriteBackup: true,
  };
}

function backupPlanFor(filePath: string, versionId: string | null): MigrateBackupPlan {
  return {
    required: true,
    versionId,
    applyHint: `应用时先备份 ${filePath}，再原地写入 2.0 文本（编码 / 换行保持原样；不改扩展名、不删源）`,
    rollbackHint:
      versionId === null
        ? `回滚：restoreBackup("${filePath}", "<备份版本号>")`
        : `回滚：restoreBackup("${filePath}", "${versionId}")`,
  };
}

function diagnosticView(
  filePath: string,
  diagnostic: SemanticMigrateResult['diagnostics'][number],
): MigrateDiagnosticView {
  return {
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    line: diagnostic.span?.start.line ?? null,
    column: diagnostic.span?.start.column ?? null,
    filePath,
  };
}

function summarizePlan(
  files: readonly MigrateFilePlan[],
): { readonly ok: boolean; readonly summary: MigratePlanSummary } {
  const blockedCount = files.filter((file) => file.error === null && !file.ok).length;
  const readErrorCount = files.filter((file) => file.error !== null).length;
  return {
    ok: files.length > 0 && blockedCount === 0 && readErrorCount === 0,
    summary: {
      fileCount: files.length,
      migratableCount: files.filter((file) => file.ok).length,
      blockedCount,
      readErrorCount,
      unsupportedCount: files.reduce((sum, file) => sum + file.unsupported.length, 0),
      warningCount: files.reduce((sum, file) => sum + file.summary.warningCount, 0),
      errorCount: files.reduce((sum, file) => sum + file.summary.errorCount, 0),
      addedLines: files.reduce((sum, file) => sum + file.summary.addedLines, 0),
      removedLines: files.reduce((sum, file) => sum + file.summary.removedLines, 0),
      rewriteCount: files.reduce((sum, file) => sum + file.summary.rewriteCount, 0),
    },
  };
}

function failedPlan(
  filePath: string,
  targetPath: string,
  encoding: FileEncoding,
  eol: EolStyle,
  error: string,
  diffText: string,
): MigrateFilePlan {
  return {
    filePath,
    targetPath,
    ok: false,
    error,
    source: '',
    code: '',
    changed: false,
    sourceEncoding: encoding,
    sourceEol: eol,
    write: writePlanFor(targetPath),
    backup: backupPlanFor(filePath, null),
    diff: [],
    diffText,
    rewrites: [],
    unsupported: [],
    diagnostics: [],
    summary: {
      ok: false,
      unsupportedCount: 0,
      warningCount: 0,
      errorCount: 0,
      firstBlockedLine: null,
      addedLines: 0,
      removedLines: 0,
      newLineCount: 0,
      rewriteCount: 0,
    },
  };
}

function skippedResult(file: MigrateFilePlan, message: string): MigrateFileApplyResult {
  return {
    filePath: file.filePath,
    status: 'blocked',
    changed: false,
    backupVersionId: null,
    rollback: 'none',
    readback: null,
    message,
  };
}

function failedResult(
  file: MigrateFilePlan,
  message: string,
  backupVersionId: string | null,
  readback: MigrateReadback | null,
): MigrateFileApplyResult {
  return {
    filePath: file.filePath,
    status: 'failed',
    changed: false,
    backupVersionId,
    rollback: 'none',
    readback,
    message,
  };
}

function readbackOf(file: TextFile): MigrateReadback {
  return { text: file.text, encoding: file.encoding, eol: file.eol };
}

function fileNameOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at >= 0 ? path.slice(at + 1) : path;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
