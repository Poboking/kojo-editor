/**
 * 编译落盘（v0.3 批 S3）——`.kojo` 源 → 合规 `.erb` 字节落盘的一体链路。
 *
 * 安全顺序（**复刻注入器范式**，`sav-parser/engine.ts` 的 `inject` 同款，
 * 不得简化）：
 * 1. **守卫（先于一切副作用）**：转译产 `error` 诊断 → 抛 `SugarCompileError`
 *    （不产半成品、不建目录、不备份、不写盘）；
 * 2. **组装**：产物文本 → 按编码口径编成字节（BOM + 换行 + 末尾换行）；
 * 3. **目录**：目标父目录不存在则经内核 io `ensureDir`（仍过第一道闸）；
 * 4. **备份**：目标已存在时先经内核 io `backup` 入 `{appData}/backup/{hash}/`；
 * 5. **写盘**：内核 io `writeBytes`（第一道闸 `writablePaths`；越权抛
 *    `WriteNotAllowedError` **原样传播**——此时备份已做、原文件未覆盖）；
 * 6. **回读验证**：重新读字节 → 与产物字节逐字节比对，不一致抛
 *    `SugarCompileError`（**携带备份路径**）。
 *
 * 顺序即安全语义（同注入器）：守卫在备份**之前**抛；越权写抛出时备份已存在、
 * 目标未被覆盖；回读失败时报错消息必带备份位置。
 *
 * **编码口径（不是 kernel 的 "保编码保换行"）**：产物是**新建/全量重写**的
 * 生成物，不存在"保持原样"语义，故走字节层 `writeBytes` 自组装字节，而非
 * `writeText` 的 `preserve` 通道。默认口径见 `SugarCompileEncoding` 头注
 * （BOM + LF + 末尾换行；以真实语料为准，覆盖规范 §8 的 CRLF 断言）。
 */

import type {
  FileIO,
  Logger,
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

/** 编译落盘（依赖注入：转译函数 + 内核 io + 可选日志） */
export async function compileToFile(
  deps: SugarCompilerDeps,
  source: string,
  targetPath: string,
  options?: SugarCompileOptions,
): Promise<SugarCompileResult> {
  const { transpile, io, log } = deps;
  const absoluteTarget = normalize(targetPath);

  // ---- 1. 转译 + 守卫（先于一切副作用）----
  let result: SugarTranspileResult;
  try {
    result = transpile(source, options);
  } catch (err) {
    // 转译器自身异常：包装为编译错误（仍属编译域失败），不触达磁盘
    throw new SugarCompileError(`转译失败：${err instanceof Error ? err.message : String(err)}`, {
      targetPath: absoluteTarget,
      backupPath: null,
    });
  }
  const errors = errorDiagnostics(result.diagnostics);
  if (errors.length > 0) {
    throw new SugarCompileError(`编译被拒绝（${errors.length} 项错误，未写盘）：${summarizeErrors(errors)}`, {
      targetPath: absoluteTarget,
      backupPath: null,
      diagnostics: errors,
    });
  }

  // ---- 2. 编码组装 ----
  const encoding = resolveEncoding(options);
  const bytes = encodeErbBytes(result.erb, encoding);

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

  // ---- 6. 回读验证（字节级；不一致 = 致命，携带备份位置）----
  let persisted: Uint8Array;
  try {
    persisted = await io.readBytes(absoluteTarget);
  } catch (err) {
    const hint = backupPath ? `——原文件已备份于 ${backupPath}` : '';
    throw new SugarCompileError(`回读验证失败（无法重新读取产物）：${err instanceof Error ? err.message : String(err)}${hint}`, {
      targetPath: absoluteTarget,
      backupPath,
    });
  }
  if (!bytesEqual(persisted, bytes)) {
    const hint = backupPath ? `——原文件已备份于 ${backupPath}` : '（原文件此前不存在，无备份）';
    throw new SugarCompileError(
      `回读验证失败（落盘字节与产物不一致：期望 ${bytes.length}B，实得 ${persisted.length}B）${hint}`,
      { targetPath: absoluteTarget, backupPath },
    );
  }

  // ---- 7.（可选）源映射旁挂 ----
  let sourceMapPath: string | undefined;
  if (options?.writeSourceMap) {
    sourceMapPath = `${absoluteTarget}.map.json`;
    const mapBytes = new TextEncoder().encode(`${JSON.stringify(result.sourceMap, null, 2)}\n`);
    // 旁挂文件与产物同域；同样先备份（已存在时）再写再回读
    await io.backup(sourceMapPath);
    await io.writeBytes(sourceMapPath, mapBytes);
    const readBack = await io.readBytes(sourceMapPath);
    if (!bytesEqual(readBack, mapBytes)) {
      const hint = backupPath ? `——原文件已备份于 ${backupPath}` : '';
      throw new SugarCompileError(`回读验证失败（源映射旁挂文件不一致）${hint}`, {
        targetPath: absoluteTarget,
        backupPath,
      });
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
