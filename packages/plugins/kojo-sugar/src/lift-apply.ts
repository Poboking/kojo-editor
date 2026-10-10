/**
 * 升糖应用（v0.3 批 S5-UI）—— 「把选中的升糖候选写回 `.kojo` 源文件」。
 *
 * ## 两条链路，一个语义
 *
 * - `applyLift(request)`：**纯函数**。内存态 `.kojo` 文本 → 应用后文本 + 行级 diff。
 *   不读盘、不写盘、不发事件。UI 的"预览 diff"用的就是它。
 * - `createSugarLiftApplyService(deps).applyToFile(path, request)`：把 `applyLift`
 *   的结果落盘。写链路与 S3 的 `compileToFile` **逐条对齐**（顺序即安全语义）：
 *     1. 校验 + 组装（先于一切副作用）
 *     2. 编码（BOM + LF + 末尾换行——与 S3 同口径，**复用** `encodeErbBytes`）
 *     3. 目录（域内才建；越权在此即抛，仍无备份副作用）
 *     4. 备份（目标已存在才做）
 *     5. 写盘（内核 io 第一道闸 `writablePaths`；`WriteNotAllowedError` **原样传播**）
 *     6. 回读验证（字节级；不一致 = 致命，携带备份位置）
 *     7. 发 `file.changed`
 *
 * ## 为什么"倒序替换"是必须的（且要显式断言）
 *
 * 候选的 `fromLine`/`toLine` 是**替换前的**行号。若按升序替换，第一个候选之后
 * 的所有行号都会位移，后续候选指向的就不再是原来的行。故**必须从最大行号开始**。
 * 这是整个模块唯一的顺序敏感点——所以实现里不"依赖直觉"，而是**先排序再断言
 * 候选两两不重叠**（重叠在合法输入下不可能发生，一旦发生就是调用方传了坏数据，
 * 此时静默继续会写出错乱的文件，必须抛错）。
 *
 * ## 文件头（`旁白色:`）的处理
 *
 * `narrationColor === '作者色'` 的候选，其自证成立的前提是 `.kojo` 文件头里有
 * `旁白色: 作者色`。应用时若文件头没有该声明，**必须补上**——否则应用后的源
 * 文件再编译，产物会与原文不一致（自证所断言的性质被破坏）。
 *
 * 反向亦然：若本次没应用任何 `作者色` 候选，而文件头里**已有** `旁白色: 作者色`，
 * **不动它**——那是作者的既有选择，不是本服务该改的东西（零侵入原则）。
 */

import type {
  FileIO,
  Logger,
  SugarLiftApplyPreview,
  SugarLiftApplyRequest,
  SugarLiftApplyResult,
  SugarLiftCandidate,
  SugarLiftDiffHunk,
} from '@kojo/plugin-api';
import { SugarApplyError } from '@kojo/plugin-api';
import { encodeErbBytes, bytesEqual } from './compile';

/* ============================== 行工具 ============================== */

/** 切行（去行尾换行；EOL 归一为 `\n`）——与 `lift.ts` 同口径 */
function splitLines(source: string): string[] {
  return source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/** 前导空白宽度（tab 记 1，其余空白按 1 计——与 `lift.ts` 的 `indentOf` 同口径） */
function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && (line[n] === '\t' || line[n] === ' ')) n++;
  return n;
}

/** 行内容（去前导空白） */
function contentOf(line: string): string {
  return line.slice(indentOf(line));
}

/** 是否空白行（空串或纯注释——注释行不参与缩进推导） */
function isBlank(line: string): boolean {
  const t = line.trim();
  return t.length === 0;
}

/* ============================== 文件头 ============================== */

/** 文件头里 `旁白色: <mode>` 声明行的正则（容忍全角/半角冒号与前后空白） */
const NARRATION_DECL_RE = /^\s*旁白色\s*[:：]\s*(\S+)\s*$/;

/**
 * 文件头**声明行**（`键: 值`）的通用形态。
 *
 * 为什么需要它：文件头不是只有 `旁白色:`——`角色:` 也是声明行，且它通常**排在
 * 第一行**。若只认 `旁白色:`，扫描会在 `角色: 1` 处就判定"声明区结束"，
 * 于是插入点落在 `角色:` **之前**（把 `旁白色:` 写到 `角色:` 上面）——引擎读
 * 头部时按行序解析，这会破坏"角色必须在旁白色之前"的既有语料惯例。
 */
const DECL_LINE_RE = /^\s*\S+\s*[:：]\s*\S.*$/;

/** 该行是否文件头声明区的一部分（空白 / 头注横幅 / `键: 值`） */
function isFrontMatterLine(line: string): boolean {
  if (isBlank(line)) return true;
  if (line.trim().startsWith('//')) return true;
  return DECL_LINE_RE.test(line);
}

/** 扫描文件头声明区（首个非声明行之前）——返回声明行下标与口径值 */
function readNarrationDecl(lines: readonly string[]): { index: number | null; mode: string | null } {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!isFrontMatterLine(line)) break;
    const m = NARRATION_DECL_RE.exec(line);
    if (m) return { index: i, mode: m[1]! };
  }
  return { index: null, mode: null };
}

/** 声明区插入点：最后一个声明行之后（保持头注横幅在最上、既有声明次序不变） */
function frontMatterInsertIndex(lines: readonly string[]): number {
  let i = 0;
  let lastDecl = -1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (!isFrontMatterLine(line)) break;
    if (DECL_LINE_RE.test(line)) lastDecl = i;
  }
  // 有声明 → 紧跟最后一个声明；无声明（只有横幅/空行）→ 首个非头注区之前
  if (lastDecl >= 0) return lastDecl + 1;
  let j = 0;
  while (j < lines.length && (isBlank(lines[j]!) || lines[j]!.trim().startsWith('//'))) j++;
  return j;
}

/* ============================== 应用（纯函数） ============================== */

/** 相对缩进展开：`sugarSource` 首行无前导空白，后续行按基准平移 */
function indentSugar(sugarSource: string, base: number): string[] {
  const pad = '\t'.repeat(Math.max(0, base));
  return sugarSource.split('\n').map((l) => (l.length > 0 ? `${pad}${l}` : l));
}

/** 候选区间是否落在正文内（1 基闭区间；`alias` 类不参与替换） */
function isReplaceableRange(c: SugarLiftCandidate, lineCount: number): boolean {
  if (c.kind === 'alias') return false;
  if (!Number.isInteger(c.fromLine) || !Number.isInteger(c.toLine)) return false;
  return c.fromLine >= 1 && c.toLine >= c.fromLine && c.toLine <= lineCount;
}

/**
 * 应用候选到内存态 `.kojo` 源文本（纯函数）。
 *
 * 校验（**任一不过即抛 `SugarApplyError`**，绝不静默跳过——"应用错行"的代价
 * 远高于"拒绝"）：
 * 1. 候选区间必须落在源文本行数内；
 * 2. 候选两两**不得重叠**（合法输入的必然性质；违反即调用方数据有问题）；
 * 3. 候选区间指向的原文必须与 `roundTrip.originalText` **逐行一致**
 *    （这是"候选来自本份 source"的直接证据——行号漂移会在这里被抓到）。
 */
export function applyLift(request: SugarLiftApplyRequest): SugarLiftApplyPreview {
  const { source } = request;
  if (typeof source !== 'string') {
    throw new SugarApplyError('升糖应用的输入必须是字符串（.kojo 源文本）', { targetPath: '' });
  }
  const candidates = (request.candidates ?? []).filter((c) => c.kind !== 'alias');
  const lines = splitLines(source);

  // ---- 1/2/3. 校验 ----
  const sorted = [...candidates].sort((a, b) => a.fromLine - b.fromLine || a.toLine - b.toLine);
  for (const c of sorted) {
    if (!isReplaceableRange(c, lines.length)) {
      throw new SugarApplyError(
        `候选区间越界（第 ${c.fromLine}–${c.toLine} 行，源文本共 ${lines.length} 行）——候选可能来自旧版扫描结果`,
        { targetPath: '' },
      );
    }
  }
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.fromLine <= prev.toLine) {
      throw new SugarApplyError(
        `候选区间重叠（第 ${prev.fromLine}–${prev.toLine} 行 与 第 ${cur.fromLine}–${cur.toLine} 行）——同一段正文不能被替换两次`,
        { targetPath: '' },
      );
    }
  }
  const hunks: SugarLiftDiffHunk[] = [];
  for (const c of sorted) {
    const original = lines.slice(c.fromLine - 1, c.toLine).map(contentOf);
    const expected = splitLines(c.roundTrip.originalText).map(contentOf);
    if (original.length !== expected.length || original.some((l, i) => l !== expected[i])) {
      throw new SugarApplyError(
        `候选与源文本不一致（第 ${c.fromLine}–${c.toLine} 行）：候选记录的原文已不在该位置——请重新扫描`,
        { targetPath: '' },
      );
    }
    hunks.push({
      fromLine: c.fromLine,
      toLine: c.toLine,
      removed: lines.slice(c.fromLine - 1, c.toLine),
      added: [],
    });
  }

  // ---- 4. 倒序替换（顺序敏感点；见模块头注）----
  const out = [...lines];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const c = sorted[i]!;
    const base = request.indentBase ?? indentOf(lines[c.fromLine - 1] ?? '');
    const added = indentSugar(c.sugarSource, base);
    out.splice(c.fromLine - 1, c.toLine - c.fromLine + 1, ...added);
    hunks[i]!.added = added;
  }

  // ---- 5. 文件头：仅在需要时补声明（绝不删既有声明）----
  const needsAuthorColor = sorted.some((c) => c.narrationColor === '作者色');
  let frontMatterChanged = false;
  const decl = readNarrationDecl(out);
  if (needsAuthorColor && decl.mode !== '作者色') {
    const declLine = '旁白色: 作者色';
    if (decl.index !== null) {
      // 已有声明但口径不同 → 改写该行（就地，不改动行数）
      out[decl.index] = declLine;
    } else {
      out.splice(frontMatterInsertIndex(out), 0, declLine);
    }
    frontMatterChanged = true;
  }

  return {
    text: out.join('\n'),
    hunks,
    appliedCount: sorted.length,
    frontMatterChanged,
  };
}

/* ============================== 落盘（写链路） ============================== */

/** 写链路依赖（与 `SugarCompilerDeps` 同构；`io` = 内核第一道闸） */
export interface LiftApplyDeps {
  /** 内核文件 IO（第一道闸 `writablePaths` 的强制执行者） */
  io: FileIO;
  /** 可选日志（写盘摘要） */
  log?: Logger;
}

/**
 * 应用候选并落盘（`.kojo` 源文件；与 `compileToFile` 同款写链路）。
 *
 * **不读源文件**——`request.source` 就是权威内容（调用方从编辑器缓冲区拿到）。
 * 这样"编辑器里的未保存内容"也能被应用，且不存在"读了盘上旧内容又按缓冲区行号
 * 替换"的错配风险：校验第 3 条（原文逐行比对）保证了缓冲区与候选同源。
 */
export async function applyLiftToFile(
  deps: LiftApplyDeps,
  sourcePath: string,
  request: SugarLiftApplyRequest,
): Promise<SugarLiftApplyResult> {
  const { io, log } = deps;

  // ---- 1. 校验 + 组装（先于一切副作用）----
  let preview: SugarLiftApplyPreview;
  try {
    preview = applyLift(request);
  } catch (err) {
    if (err instanceof SugarApplyError) {
      throw new SugarApplyError(err.message, { targetPath: sourcePath, backupPath: null });
    }
    throw new SugarApplyError(`升糖应用失败：${err instanceof Error ? err.message : String(err)}`, {
      targetPath: sourcePath,
      backupPath: null,
    });
  }

  // ---- 2. 编码（与 S3 同口径，复用同一编码器）----
  const bytes = encodeErbBytes(preview.text, { bom: true, eol: 'lf', trailingNewline: true });

  // ---- 3. 目录（域内才建；越权在此即抛，仍无备份副作用）----
  const slash = Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\'));
  const parent = slash > 0 ? sourcePath.slice(0, slash) : '';
  if (parent && !(await io.exists(parent))) {
    await io.ensureDir(parent);
  }

  // ---- 4. 备份（目标已存在才做）----
  const backupPath = await io.backup(sourcePath);

  // ---- 5. 写盘（第一道闸；越权原样传播，不吞不包）----
  try {
    await io.writeBytes(sourcePath, bytes);
  } catch (err) {
    if (err instanceof Error && err.name === 'WriteNotAllowedError') throw err;
    const hint = backupPath ? `——原文件已备份于 ${backupPath}` : '';
    throw new SugarApplyError(`写盘失败：${err instanceof Error ? err.message : String(err)}${hint}`, {
      targetPath: sourcePath,
      backupPath,
    });
  }

  // ---- 6. 回读验证（字节级；不一致 = 致命，携带备份位置）----
  let persisted: Uint8Array;
  try {
    persisted = await io.readBytes(sourcePath);
  } catch (err) {
    const hint = backupPath ? `——原文件已备份于 ${backupPath}` : '';
    throw new SugarApplyError(
      `回读验证失败（无法重新读取文件）：${err instanceof Error ? err.message : String(err)}${hint}`,
      { targetPath: sourcePath, backupPath },
    );
  }
  if (!bytesEqual(persisted, bytes)) {
    const hint = backupPath ? `——原文件已备份于 ${backupPath}` : '（原文件此前不存在，无备份）';
    throw new SugarApplyError(
      `回读验证失败（落盘字节与产物不一致：期望 ${bytes.length}B，实得 ${persisted.length}B）${hint}`,
      { targetPath: sourcePath, backupPath },
    );
  }

  log?.debug(`Sugar lift applied: ${preview.appliedCount} candidate(s) → ${bytes.length}B @ ${sourcePath}`);
  return {
    sourcePath,
    byteSize: bytes.length,
    backupPath,
    appliedCount: preview.appliedCount,
    preview,
  };
}

/**
 * 装配应用服务（`kojo-sugar` 的 `index.ts` 调用）。
 *
 * `onApplied` 是**事件发口的注入**：实现层（本模块）不该知道内核总线的存在
 * ——"应用成功后要发 `file.changed`"是**装配层**的接线决策（谁有 bus 谁发）。
 * 这样本模块仍然零内核依赖，可单测。
 */
export function createSugarLiftApplyService(deps: LiftApplyDeps & { onApplied?: (path: string) => void }) {
  return {
    apply: (request: SugarLiftApplyRequest): SugarLiftApplyPreview => applyLift(request),
    applyToFile: async (
      sourcePath: string,
      request: SugarLiftApplyRequest,
    ): Promise<SugarLiftApplyResult> => {
      const result = await applyLiftToFile(deps, sourcePath, request);
      // ---- 7. 事件（写盘成功后才发；失败路径由抛错终止，不发）----
      deps.onApplied?.(sourcePath);
      return result;
    },
  };
}
