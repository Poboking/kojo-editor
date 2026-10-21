/**
 * 编译落盘（v0.3 批 S3）——`.kojo` 源 → 合规 `.erb` 字节落盘的一体链路。
 *
 * 安全顺序（**复刻注入器范式**，`sav-parser/engine.ts` 的 `inject` 同款，
 * 不得简化）：
 * 1. **守卫（先于一切副作用）**：转译产 `error` 诊断 → 抛 `SugarCompileError`
 *    （不产半成品、不建目录、不备份、不写盘）；
 * 2. **组装**：产物文本 → 按编码口径编成字节（BOM + 换行 + 末尾换行）；
 * 3. **目录**：目标父目录不存在则经内核 io `ensureDir`（仍过第一道闸）；
 * 4. **备份**：目标已存在时先经内核 io `backup` 入 `{appData}/backup/{hash}/`
 *    （这份备份即「写前状态」的快照，回读失败时靠它恢复）；
 * 5. **写盘**：内核 io `writeBytes`（第一道闸 `writablePaths`；越权抛
 *    `WriteNotAllowedError` **原样传播**——此时备份已做、原文件未覆盖）；
 * 6. **回读验证**：重新读字节 → 与产物字节逐字节比对；**失败即回滚**
 *    （读抛或字节不一致都算）：有备份 → 读备份字节原样写回恢复原文件；
 *    无备份 → 移除半成品。回滚后抛 `SugarCompileError`，消息带回滚结果
 *    （回滚自身失败也如实上文本，备份位置照旧在——作者可手动恢复）。
 *
 * 顺序即安全语义（同注入器）：守卫在备份**之前**抛；越权写抛出时备份已存在、
 * 目标未被覆盖；回读失败即 abort 对位——**坏/半产物不许留盘**，写前状态必须
 * 原样回来（口径照内核 journal 的回滚：有快照写回、无快照删除，见
 * `kernel/src/journal.ts::rollbackEntries`）。
 *
 * **编码口径（不是 kernel 的 "保编码保换行"）**：产物是**新建/全量重写**的
 * 生成物，不存在"保持原样"语义，故走字节层 `writeBytes` 自组装字节，而非
 * `writeText` 的 `preserve` 通道。默认口径见 `SugarCompileEncoding` 头注
 * （BOM + LF + 末尾换行；以真实语料为准，覆盖规范 §8 的 CRLF 断言）。
 */

import type {
  FileIO,
  Logger,
  SugarCompiledBytes,
  SugarCompilerDeps,
  SugarCompileOptions,
  SugarCompileResult,
  SugarDiagnostic,
  SugarTranspileResult,
} from '@kojo/plugin-api';
import { SugarCompileError } from '@kojo/plugin-api';
import { dirname, normalize } from '@kojo/plugin-api';

/** 默认编码口径（实证：eraTW 语料 BOM + LF；末尾换行按 POSIX/规范 §8） */
const DEFAULT_ENCODING = { bom: true, eol: 'lf', trailingNewline: true } as const;

/** UTF-8 BOM 字节 */
const BOM_BYTES = new Uint8Array([0xef, 0xbb, 0xbf]);

/**
 * 把产物文本编成**落盘字节**（BOM + 换行 + 末尾换行）。
 *
 * 归一化策略：先把内部 `\n` 统一，再按目标 eol 展开；末尾换行按选项补齐
 * 或移除——保证"产物文本语义"与"落盘字节"一致且可断言。
 */
export function encodeErbBytes(text: string, opts: Required<{ bom: boolean; eol: 'lf' | 'crlf'; trailingNewline: boolean }>): Uint8Array {
  // 归一化为 \n（内部表示可能已含 CRLF，避免二次展开成 \r\r\n）
  let body = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // 末尾换行：先剥离可能已存在的尾换行，再按选项重建（避免叠加）
  const withoutTrail = body.endsWith('\n') ? body.slice(0, -1) : body;
  body = opts.trailingNewline && withoutTrail.length > 0 ? `${withoutTrail}\n` : withoutTrail;
  if (opts.eol === 'crlf') {
    body = body.replace(/\n/g, '\r\n');
  }
  const encoded = new TextEncoder().encode(body);
  if (!opts.bom) return encoded;
  const out = new Uint8Array(BOM_BYTES.length + encoded.length);
  out.set(BOM_BYTES, 0);
  out.set(encoded, BOM_BYTES.length);
  return out;
}

/** 字节级相等（长度 + 逐字节） */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 解析编码选项（缺省 = 语料实证口径；未给的字段取默认值） */
function resolveEncoding(opts?: SugarCompileOptions): { bom: boolean; eol: 'lf' | 'crlf'; trailingNewline: boolean } {
  const e = opts?.encoding;
  return {
    bom: e?.bom ?? DEFAULT_ENCODING.bom,
    eol: e?.eol ?? DEFAULT_ENCODING.eol,
    trailingNewline: e?.trailingNewline ?? DEFAULT_ENCODING.trailingNewline,
  };
}

/** error 级诊断（守卫依据：存在即拒绝，不产半成品） */
function errorDiagnostics(list: readonly SugarDiagnostic[]): SugarDiagnostic[] {
  return list.filter((d) => d.severity === 'error');
}

/** 诊断摘要（人读；用于错误消息，不泄漏内部术语） */
function summarizeErrors(list: readonly SugarDiagnostic[]): string {
  const head = list.slice(0, 3).map((d) => {
    const at = d.loc ? `第 ${d.loc.line} 行` : '文件级';
    return `${at}：${d.message}`;
  });
  const more = list.length > 3 ? `（另有 ${list.length - 3} 条）` : '';
  return head.join('；') + more;
}

/**
 * 编译到**内存字节**（`compileToFile` 的 1+2 步，零 IO）。
 *
 * 为什么单独存在：导出 ZIP 要在内存里把 `.kojo` 变成 `.ERB` 字节，绝不能"先写临时
 * 文件再读回来"——那会在工作区或临时目录留下半成品，还要再走一遍写闸。
 *
 * 关键是**编码口径只有一份**：`compileToFile` 现在就是调本函数拿字节，再走它的
 * 3-6 步（建目录 / 备份 / 写盘 / 回读比对）。否则"导出产物"与"保存产物"会各自
 * 组装 BOM 与换行，迟早对不上（本仓 `0bf2eb9` 记过的双源漂移类型）。
 *
 * 守卫与落盘路径同口径：转译抛错或产 `error` 诊断 → 抛 `SugarCompileError`，
 * **绝不返回半成品字节**。
 */
export function compileToBytes(
  transpile: SugarCompilerDeps['transpile'],
  source: string,
  options?: SugarCompileOptions,
  targetLabel = '(内存)',
): SugarCompiledBytes {
  let result: SugarTranspileResult;
  try {
    result = transpile(source, options);
  } catch (err) {
    throw new SugarCompileError(`转译失败：${err instanceof Error ? err.message : String(err)}`, {
      targetPath: targetLabel,
      backupPath: null,
    });
  }
  const errors = errorDiagnostics(result.diagnostics);
  if (errors.length > 0) {
    throw new SugarCompileError(`编译被拒绝（${errors.length} 项错误）：${summarizeErrors(errors)}`, {
      targetPath: targetLabel,
      backupPath: null,
      diagnostics: errors,
    });
  }
  return { bytes: encodeErbBytes(result.erb, resolveEncoding(options)), transpile: result };
}

/* ============================== 回读失败回滚 ============================== */

/** 回滚结果（诊断用：成功带动作描述，失败带原因） */
type RollbackResult = { ok: true; detail: string } | { ok: false; reason: string };

/**
 * 回滚到**写前状态**（回读验证失败时调用；注入器 `journal.abort` 的本文件对位）。
 *
 * - 有备份（目标写前存在）→ 读备份字节**原样写回**（`writeBytes` 无写前备份，
 *   不会把坏产物折进作者可见的历史版本账）；
 * - 无备份（目标写前不存在）→ 移除半成品（`removeFile` 与 `writeBytes` 同一道
 *   写闸；先 `exists` 兜竞态——文件已然消失等于写前状态已达成）。
 *
 * 口径照内核 journal 的回滚（`kernel/src/journal.ts::rollbackEntries`）：有快照
 * 写回、无快照删除。**刻意不在回滚前备份坏产物**——那会把损坏字节写进作者可见
 * 的备份时间线，而写前那份备份本来就是恢复源。
 */
async function rollbackToPreWrite(io: FileIO, path: string, backupPath: string | null): Promise<RollbackResult> {
  try {
    if (backupPath !== null) {
      const original = await io.readBytes(backupPath);
      await io.writeBytes(path, original);
      return { ok: true, detail: `原文件已从备份恢复：${backupPath}` };
    }
    if (await io.exists(path)) await io.removeFile(path);
    return { ok: true, detail: '目标写前不存在，半成品已移除' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** 回滚结果 → 诊断片段：成功明示写前状态已恢复；失败明示原因与手动兜底（不静默） */
function rollbackOutcome(rollback: RollbackResult, backupPath: string | null): string {
  if (rollback.ok) return `已回滚到写前状态（${rollback.detail}）`;
  return backupPath !== null
    ? `回滚失败（${rollback.reason}）；原文件已备份于 ${backupPath}，请手动恢复`
    : `回滚失败（${rollback.reason}）；目标写前不存在且无备份可恢复，盘上可能残留半成品，请手动处理`;
}

/**
 * 回读验证失败：**先回滚到写前状态，再带完整诊断抛错**。
 *
 * 错误文本 = 失败 headline + 回滚结果。回滚自身失败也如实进文本（备份位置照旧
 * 在）——失败路径不静默是本链路的安全语义，不是可选项。
 */
async function readbackFailureError(
  io: FileIO,
  path: string,
  backupPath: string | null,
  headline: string,
): Promise<SugarCompileError> {
  const rollback = await rollbackToPreWrite(io, path, backupPath);
  return new SugarCompileError(`${headline}——${rollbackOutcome(rollback, backupPath)}`, {
    targetPath: path,
    backupPath,
  });
}

/** 编译落盘（依赖注入：转译函数 + 内核 io + 可选日志） */
export async function compileToFile(
  deps: SugarCompilerDeps,
  source: string,
  targetPath: string,
  options?: SugarCompileOptions,
): Promise<SugarCompileResult> {
  const { io, log } = deps;
  const absoluteTarget = normalize(targetPath);

  // ---- 1+2. 转译 + 守卫 + 编码组装（与内存编译同一条路径，见 compileToBytes）----
  const { bytes, transpile: result } = compileToBytes(deps.transpile, source, options, absoluteTarget);

  // ---- 3. 目录（域内才建；越权在此即抛，仍无备份副作用）----
  const parent = dirname(absoluteTarget);
  if (parent && parent !== '.' && !(await io.exists(parent))) {
    await io.ensureDir(parent);
  }

  // ---- 4. 备份（目标已存在才做；内部 exists 判定，不存在返回 null）----
  const backupPath = await io.backup(absoluteTarget);

  // ---- 5. 写盘（第一道闸；越权 WriteNotAllowedError 原样传播，不吞不包）----
  try {
    await io.writeBytes(absoluteTarget, bytes);
  } catch (err) {
    // 包装非越权错误以携带上下文；越权错误原样抛出（消费方按类型判定）
    if (err instanceof SugarCompileError) throw err;
    const name = err instanceof Error ? err.name : '';
    if (name === 'WriteNotAllowedError') throw err;
    const hint = backupPath ? `——原文件已备份于 ${backupPath}` : '';
    throw new SugarCompileError(`写盘失败：${err instanceof Error ? err.message : String(err)}${hint}`, {
      targetPath: absoluteTarget,
      backupPath,
    });
  }

  // ---- 6. 回读验证（字节级；不一致 = 致命：先回滚到写前状态，再带诊断抛错）----
  // 坏/半产物不许留盘（K2-PRE-REUSE ③）：读抛或字节不一致都先回滚——有备份
  // 恢复原文件、无备份移除半成品；回滚成败都进错误文本（不静默）。
  let persisted: Uint8Array;
  try {
    persisted = await io.readBytes(absoluteTarget);
  } catch (err) {
    throw await readbackFailureError(
      io,
      absoluteTarget,
      backupPath,
      `回读验证失败（无法重新读取产物）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!bytesEqual(persisted, bytes)) {
    throw await readbackFailureError(
      io,
      absoluteTarget,
      backupPath,
      `回读验证失败（落盘字节与产物不一致：期望 ${bytes.length}B，实得 ${persisted.length}B）`,
    );
  }

  // ---- 7.（可选）源映射旁挂 ----
  let sourceMapPath: string | undefined;
  if (options?.writeSourceMap) {
    const sidecarPath = `${absoluteTarget}.map.json`;
    sourceMapPath = sidecarPath;
    const mapBytes = new TextEncoder().encode(`${JSON.stringify(result.sourceMap, null, 2)}\n`);
    // 旁挂文件与产物同域；同样先备份（已存在时）再写再回读。
    // 旁挂回读失败 ⇒ 只回滚旁挂本身：主产物已逐字节通过验证，不因可选的旁挂
    // 失败而撤销；错误文本明确区分两者（主产物在位 + 旁挂回滚结果）。
    const sidecarBackup = await io.backup(sidecarPath);
    try {
      await io.writeBytes(sidecarPath, mapBytes);
    } catch (err) {
      if (err instanceof SugarCompileError) throw err;
      if (err instanceof Error && err.name === 'WriteNotAllowedError') throw err;
      throw new SugarCompileError(
        `源映射旁挂写盘失败：${err instanceof Error ? err.message : String(err)}` +
          (sidecarBackup ? `——原旁挂已备份于 ${sidecarBackup}` : ''),
        { targetPath: sidecarPath, backupPath: sidecarBackup },
      );
    }
    let sidecarRead: Uint8Array;
    try {
      sidecarRead = await io.readBytes(sidecarPath);
    } catch (err) {
      const rollback = await rollbackToPreWrite(io, sidecarPath, sidecarBackup);
      throw new SugarCompileError(
        `回读验证失败（无法重新读取源映射旁挂）：${err instanceof Error ? err.message : String(err)}` +
          `——主产物已落盘且通过回读验证（${absoluteTarget}，${bytes.length}B），` +
          `旁挂${rollbackOutcome(rollback, sidecarBackup)}`,
        { targetPath: sidecarPath, backupPath: sidecarBackup },
      );
    }
    if (!bytesEqual(sidecarRead, mapBytes)) {
      const rollback = await rollbackToPreWrite(io, sidecarPath, sidecarBackup);
      throw new SugarCompileError(
        `回读验证失败（源映射旁挂落盘字节与产物不一致：期望 ${mapBytes.length}B，实得 ${sidecarRead.length}B）` +
          `——主产物已落盘且通过回读验证（${absoluteTarget}，${bytes.length}B），` +
          `旁挂${rollbackOutcome(rollback, sidecarBackup)}`,
        { targetPath: sidecarPath, backupPath: sidecarBackup },
      );
    }
  }

  log?.debug(`Sugar compiled: ${source.split('\n').length} source lines → ${bytes.length}B @ ${absoluteTarget}`);
  return {
    erbPath: absoluteTarget,
    byteSize: bytes.length,
    backupPath,
    ...(sourceMapPath ? { sourceMapPath } : {}),
    diagnostics: result.diagnostics,
  };
}

/** 供插件装配使用：把 io 与转译函数绑成编译依赖 */
export function makeCompilerDeps(
  io: FileIO,
  transpile: (source: string, options?: SugarCompileOptions) => SugarTranspileResult,
  log?: Logger,
): SugarCompilerDeps {
  return { io, transpile, ...(log ? { log } : {}) };
}
