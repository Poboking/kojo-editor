/**
 * Conformance kit · 行为 differential 的归一化与逐行 diff（纯函数）。
 *
 * 定位（设计稿 §10.9 / §16.6）：
 * - differential 比较的是**行为序列**，不是旧产物的字节：BOM / EOL / 注释不构成行为；
 * - 只剥**整行注释**（行首非空白字符命中注释前缀）。不剥行内 `;`：ERB 的 `;` 也可能是
 *   作者正文/引擎原文，行内切分不是 kit 能替 adapter 决定的事实；
 * - 归一化不静默：剥掉多少注释/空行都记进读数，diff 摘要里可见。
 */
import type { ConformanceEol } from './encoding.js';
import { detectEol, normalizeEolToLf } from './encoding.js';

/** 归一化选项（默认值就是 differential 的推荐口径） */
export interface ArtifactNormalizationOptions {
  /** 去掉开头的 UTF-8 BOM（默认 true） */
  readonly stripBom?: boolean;
  /** `\r\n` / `\r` → `\n`（默认 true） */
  readonly normalizeEol?: boolean;
  /** 剥整行注释（默认 true） */
  readonly stripComments?: boolean;
  /** 注释前缀（默认 `;` / `//`） */
  readonly commentPrefixes?: readonly string[];
  /** 去掉空行（默认 true：空行不是行为） */
  readonly dropBlankLines?: boolean;
  /** 去行尾空白（默认 false：产物字节里的行尾空白可能是引擎事实） */
  readonly trimTrailingWhitespace?: boolean;
}

/** 归一化读数（`lines` 是参与比较的行；计数用于报告） */
export interface NormalizedArtifact {
  readonly lines: readonly string[];
  readonly hadBom: boolean;
  readonly eol: ConformanceEol;
  readonly removedComments: number;
  readonly removedBlankLines: number;
  readonly originalLineCount: number;
}

export type ArtifactLineDiffKind = 'same' | 'removed' | 'added';

/** 逐行 diff 项：`artifactLine` 只对 candidate 行有值，`baselineLine` 只对 baseline 行有值 */
export interface ArtifactLineDiff {
  readonly kind: ArtifactLineDiffKind;
  /** 1 基 candidate 行号；removed 为 null */
  readonly artifactLine: number | null;
  /** 1 基 baseline 行号；added 为 null */
  readonly baselineLine: number | null;
  readonly baseline: string | null;
  readonly candidate: string | null;
}

export interface LineDiffSummary {
  readonly same: number;
  readonly removed: number;
  readonly added: number;
}

export interface DifferentialResult {
  readonly equal: boolean;
  readonly baseline: NormalizedArtifact;
  readonly candidate: NormalizedArtifact;
  readonly diff: readonly ArtifactLineDiff[];
  readonly summary: LineDiffSummary;
  readonly firstDifference: ArtifactLineDiff | null;
}

const DEFAULT_COMMENT_PREFIXES: readonly string[] = Object.freeze([';', '//']);
const LCS_CELL_LIMIT = 4_000_000;

function stripBom(text: string): { readonly text: string; readonly hadBom: boolean } {
  if (text.charCodeAt(0) === 0xfeff) return { text: text.slice(1), hadBom: true };
  return { text, hadBom: false };
}

function isCommentLine(line: string, prefixes: readonly string[]): boolean {
  const trimmed = line.trimStart();
  return prefixes.some((prefix) => prefix.length > 0 && trimmed.startsWith(prefix));
}

/**
 * 归一化一段产物/基线。
 *
 * 行号口径：`lines` 是**归一化后**的数组，diff 的 `artifactLine` / `baselineLine` 也都是
 * 归一化后的 1 基下标（与报告里的读数同口径；原始行号另由 `originalLineCount` 提示）。
 */
export function normalizeArtifact(
  text: string,
  options: ArtifactNormalizationOptions = {},
): NormalizedArtifact {
  const stripBomEnabled = options.stripBom ?? true;
  const normalizeEolEnabled = options.normalizeEol ?? true;
  const stripComments = options.stripComments ?? true;
  const dropBlankLines = options.dropBlankLines ?? true;
  const trimTrailingWhitespace = options.trimTrailingWhitespace ?? false;
  const prefixes = options.commentPrefixes ?? DEFAULT_COMMENT_PREFIXES;

  const bomResult = stripBomEnabled ? stripBom(text) : { text, hadBom: false };
  const eol = detectEol(bomResult.text);
  const normalizedEol = normalizeEolEnabled ? normalizeEolToLf(bomResult.text) : bomResult.text;
  const rawLines = normalizedEol.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();

  const lines: string[] = [];
  let removedComments = 0;
  let removedBlankLines = 0;
  for (const rawLine of rawLines) {
    if (stripComments && isCommentLine(rawLine, prefixes)) {
      removedComments++;
      continue;
    }
    const line = trimTrailingWhitespace ? rawLine.trimEnd() : rawLine;
    if (dropBlankLines && line.trim().length === 0) {
      removedBlankLines++;
      continue;
    }
    lines.push(line);
  }

  return {
    lines,
    hadBom: bomResult.hadBom,
    eol,
    removedComments,
    removedBlankLines,
    originalLineCount: rawLines.length,
  };
}

/**
 * 逐行 LCS diff（小输入精确；超大输入退化为"公共前缀/后缀 + 中间整段替换"，
 * 不把 2000 行级基线拖成 O(n²) 内存）。
 */
export function diffArtifactLines(
  baseline: readonly string[],
  candidate: readonly string[],
): readonly ArtifactLineDiff[] {
  const n = baseline.length;
  const m = candidate.length;
  if (n === 0 && m === 0) return Object.freeze([]);
  if (n === 0 || m === 0 || n * m > LCS_CELL_LIMIT) {
    return diffByPrefixSuffix(baseline, candidate);
  }

  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const current = i * width + j;
      if (baseline[i] === candidate[j]) {
        dp[current] = (dp[(i + 1) * width + (j + 1)] ?? 0) + 1;
      } else {
        const down = dp[(i + 1) * width + j] ?? 0;
        const right = dp[i * width + (j + 1)] ?? 0;
        dp[current] = down >= right ? down : right;
      }
    }
  }

  const out: ArtifactLineDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (baseline[i] === candidate[j]) {
      out.push({
        kind: 'same',
        artifactLine: j + 1,
        baselineLine: i + 1,
        baseline: baseline[i] ?? null,
        candidate: candidate[j] ?? null,
      });
      i++;
      j++;
      continue;
    }
    const down = dp[(i + 1) * width + j] ?? 0;
    const right = dp[i * width + (j + 1)] ?? 0;
    if (down >= right) {
      out.push({
        kind: 'removed',
        artifactLine: null,
        baselineLine: i + 1,
        baseline: baseline[i] ?? null,
        candidate: null,
      });
      i++;
    } else {
      out.push({
        kind: 'added',
        artifactLine: j + 1,
        baselineLine: null,
        baseline: null,
        candidate: candidate[j] ?? null,
      });
      j++;
    }
  }
  while (i < n) {
    out.push({
      kind: 'removed',
      artifactLine: null,
      baselineLine: i + 1,
      baseline: baseline[i] ?? null,
      candidate: null,
    });
    i++;
  }
  while (j < m) {
    out.push({
      kind: 'added',
      artifactLine: j + 1,
      baselineLine: null,
      baseline: null,
      candidate: candidate[j] ?? null,
    });
    j++;
  }
  return Object.freeze(out);
}

/** 退化路径：公共前缀/后缀保持 same，中间整段 removed + added */
function diffByPrefixSuffix(
  baseline: readonly string[],
  candidate: readonly string[],
): readonly ArtifactLineDiff[] {
  const out: ArtifactLineDiff[] = [];
  let prefix = 0;
  while (
    prefix < baseline.length &&
    prefix < candidate.length &&
    baseline[prefix] === candidate[prefix]
  ) {
    out.push({
      kind: 'same',
      artifactLine: prefix + 1,
      baselineLine: prefix + 1,
      baseline: baseline[prefix] ?? null,
      candidate: candidate[prefix] ?? null,
    });
    prefix++;
  }
  let baselineEnd = baseline.length;
  let candidateEnd = candidate.length;
  while (
    baselineEnd > prefix &&
    candidateEnd > prefix &&
    baseline[baselineEnd - 1] === candidate[candidateEnd - 1]
  ) {
    baselineEnd--;
    candidateEnd--;
  }
  for (let i = prefix; i < baselineEnd; i++) {
    out.push({
      kind: 'removed',
      artifactLine: null,
      baselineLine: i + 1,
      baseline: baseline[i] ?? null,
      candidate: null,
    });
  }
  for (let j = prefix; j < candidateEnd; j++) {
    out.push({
      kind: 'added',
      artifactLine: j + 1,
      baselineLine: null,
      baseline: null,
      candidate: candidate[j] ?? null,
    });
  }
  for (let i = baselineEnd, j = candidateEnd; i < baseline.length && j < candidate.length; i++, j++) {
    out.push({
      kind: 'same',
      artifactLine: j + 1,
      baselineLine: i + 1,
      baseline: baseline[i] ?? null,
      candidate: candidate[j] ?? null,
    });
  }
  return Object.freeze(out);
}

/** diff 摘要计数（报告用） */
export function summarizeLineDiff(diff: readonly ArtifactLineDiff[]): LineDiffSummary {
  let same = 0;
  let removed = 0;
  let added = 0;
  for (const item of diff) {
    if (item.kind === 'same') same++;
    else if (item.kind === 'removed') removed++;
    else added++;
  }
  return { same, removed, added };
}

/** 归一化 + diff 的完整入口（kit 与单测共用） */
export function compareArtifacts(
  baseline: string,
  candidate: string,
  options: ArtifactNormalizationOptions = {},
): DifferentialResult {
  const normalizedBaseline = normalizeArtifact(baseline, options);
  const normalizedCandidate = normalizeArtifact(candidate, options);
  const diff = diffArtifactLines(normalizedBaseline.lines, normalizedCandidate.lines);
  const firstDifference = diff.find((item) => item.kind !== 'same') ?? null;
  return {
    equal: firstDifference === null,
    baseline: normalizedBaseline,
    candidate: normalizedCandidate,
    diff,
    summary: summarizeLineDiff(diff),
    firstDifference,
  };
}
