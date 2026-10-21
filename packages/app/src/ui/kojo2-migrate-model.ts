/**
 * Kojo 2.0 迁移向导 · 模型层（M7.3 / M7.5 / U6.7）。
 *
 * 职责只有三件事，全部与 React 无关、可在 node 环境直接单测：
 *
 * 1. **dry-run**：`v1 source + filePath → migrateKojoSource`，产出逐行 diff、
 *    unsupported 台账（带原行文本）、诊断与逐文件迁移计划。dry-run 的 IO 端口
 *    类型只有 `readText`——"不写盘"不是靠调用方自觉，而是**类型上做不到**。
 * 2. **计划**：每个文件写明编码 / EOL 保留口径、写前备份、回滚口令
 *    （`restoreBackup(path, versionId)` 的原文提示），以及应用后回填的版本号。
 * 3. **应用**：先复核盘上内容仍是 dry-run 看到的那一份（防外部改动），再 `backup`
 *    → `writeText({ encoding:'preserve', eol:'preserve' })` → **readback 断言**；
 *    任一环失败（含回读不一致）都回滚到备份或显式重写原文。迁移失败不破坏源。
 *
 * 纪律：
 * - 读写只经 `@kojo/plugin-api` 的 `FileIO` 子集（真身 = `kernel.io`），测试注入假 io；
 * - 全部入参 / 返回值 readonly，零 `any`；错误只以字符串消息露出，不吞成静默；
 * - 整批默认 fail-closed：只要有一个文件阻断，`applyMigratePlan` 一个字节都不写。
 */
import {
  migrateKojoSource,
  summarizeMigration,
  type MigrateResult,
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
}

/** 单文件 dry-run + 迁移计划 */
export interface MigrateFilePlan {
  readonly filePath: string;
  /** 当前口径 = 原地改写；留字段供后续 `.kojo2` 目标模式接线 */
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

  let result: MigrateResult;
  try {
    result = migrateKojoSource(source, input.speaker === undefined ? {} : { speaker: input.speaker });
  } catch (error) {
    return failedPlan(filePath, targetPath, encoding, eol, errorText(error), emptyDiffText);
  }

  const diff = buildMigrateDiff(source, result.code, result.sourceMap);
  const diffText = formatMigrateDiff(filePath, diff);
  const sourceLines = splitLines(source);
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
    },
  };
}

/** 批量 dry-run（逐文件顺序读；单文件读失败只标记该文件，不抛整批） */
export async function dryRunMigrateFiles(
  io: MigrateReadPort,
  filePaths: readonly string[],
  options: { readonly speaker?: string } = {},
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
  const parts = text.replace(/\r\n?/g, '\n').split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** readback / stale 判等用：内核读文本已归一化，这里再兜一层 CRLF 源 */
function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
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
    applyHint: `应用时先备份 ${filePath}，再原地写入 2.0 文本（编码 / 换行保持原样）`,
    rollbackHint:
      versionId === null
        ? `回滚：restoreBackup("${filePath}", "<备份版本号>")`
        : `回滚：restoreBackup("${filePath}", "${versionId}")`,
  };
}

function diagnosticView(
  filePath: string,
  diagnostic: MigrateResult['diagnostics'][number],
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
