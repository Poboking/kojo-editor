/**
 * 存档文件级解析（游戏无关；镜像引擎二进制读侧全流程）。
 *
 * 流程：16 字节明文头（魔数 + 格式版本 + 保留字段）→ 正文（gzip 或裸字节）→
 *   文件类型 / 唯一码 / 游戏版本 / 存档备注 → [角色区] → [主变量区] → [EM 扩展区]。
 *
 * 本实现为 `sav-parse/parse_sav.cjs` 协议成果的 TS 移植（真实六档全字节实测零残余，
 * 见逆向系列《存档实战解析》）。差异点（均为改进）：
 * - 字符串长度前缀按**字节数**语义严格校验（奇数字节即报错）；
 * - Int64 超出安全整数范围时记 warning（不静默）；
 * - 支持 `headerOnly`（扫描场景）与 cells 省略 / 截断策略（内存控制）。
 */

import type {
  ArchiveArrayType,
  ArchiveArrayVariable,
  ArchiveCharacterBlock,
  ArchiveContainerFormat,
  ArchiveFileType,
  ArchiveMapVariable,
  ArchiveParseOptions,
  ArchiveVariable,
  SnapshotArchive,
} from '@kojo/plugin-api';
import { basename } from '@kojo/plugin-api';
import {
  KEEP_ALL_CELLS,
  readIntArray1D,
  readIntArray2D,
  readIntArray3D,
  readStrArray1D,
  readStrArray2D,
  readStrArray3D,
  type ArrayReadResult,
  type CellPolicy,
} from './arrays';
import { ArchiveParseError, ByteReader } from './binary';
import { gunzipBytes } from './gunzip';
import { recordFidelity, type SepPositions } from './fidelity';

/** 压缩存档魔数（明文头前 8 字节） */
export const MAGIC_GZIP = 0x0a50495a41524589n;
/** 未压缩存档魔数（明文头前 8 字节） */
export const MAGIC_RAW = 0x0a1a0a0d41524589n;
/** 本解析器支持的二进制格式版本（实测 1808） */
export const FORMAT_VERSION = 1808;

const FILE_TYPES: Record<number, ArchiveFileType> = {
  0: 'normal',
  1: 'global',
  2: 'var',
  3: 'charvar',
};

/** 变量流 token：变量本体或流控制标记 */
type VarToken = ArchiveVariable | 'eof' | 'eoc' | 'separator';

function arrayVar(type: ArchiveArrayType, key: string, offset: number, arr: ArrayReadResult): ArchiveArrayVariable {
  const v: ArchiveArrayVariable = {
    type,
    key,
    offset,
    saveLen: arr.saveLen,
    cursor: arr.cursor,
    nonEmpty: arr.nonEmpty,
    cells: arr.cells,
  };
  if (arr.cells.length < arr.nonEmpty) v.cellsTruncated = true;
  return v;
}

/** 读一个变量（含流控制标记）；镜像引擎 ReadVariableCode + LoadVariableBinary 合流语义 */
function readVar(r: ByteReader, policy: CellPolicy): VarToken {
  const offset = r.offset;
  const t = r.byte();
  if (t === 0xff) return 'eof';
  if (t === 0xfe) return 'eoc';
  if (t === 0xfd) return 'separator';
  const key = r.str('变量名');
  let v: ArchiveVariable;
  switch (t) {
    case 0x00:
      v = { type: 'int', key, value: r.varInt('整数变量值'), offset };
      break;
    case 0x10:
      v = { type: 'str', key, value: r.str('字符串变量值'), offset };
      break;
    case 0x01:
      v = arrayVar('int-array-1d', key, offset, readIntArray1D(r, policy));
      break;
    case 0x02:
      v = arrayVar('int-array-2d', key, offset, readIntArray2D(r, policy));
      break;
    case 0x03:
      v = arrayVar('int-array-3d', key, offset, readIntArray3D(r, policy));
      break;
    case 0x11:
      v = arrayVar('str-array-1d', key, offset, readStrArray1D(r, policy));
      break;
    case 0x12:
      v = arrayVar('str-array-2d', key, offset, readStrArray2D(r, policy));
      break;
    case 0x13:
      v = arrayVar('str-array-3d', key, offset, readStrArray3D(r, policy));
      break;
    case 0x20: {
      const count = r.int32();
      const pairs: Array<readonly [string, string]> = [];
      for (let i = 0; i < count; i++) pairs.push([r.str('映射键'), r.str('映射值')]);
      v = { type: 'map', key, count, pairs, offset };
      break;
    }
    case 0x21:
      v = { type: 'xml', key, value: r.str('XML 内容'), offset };
      break;
    case 0x22:
      v = { type: 'datatable', key, schema: r.str('表 schema'), data: r.str('表数据'), offset };
      break;
    default:
      throw new ArchiveParseError(`未知变量类型 0x${t.toString(16)}（key=${key}）`, offset);
  }
  // 方案 B（v0.2 第十三批）：keepRaw 时记录原始字节区间（subarray 视图）——
  // 写侧对未修改变量原样复制，Int64 近似值永不写回。
  if (policy.keepRaw) v.raw = r.span(offset);
  return v;
}

/** 变量流读取结果：变量本体 + **有序分隔符位置**（保真回环需按原位置回写 0xFD） */
interface VarStreamResult {
  vars: ArchiveVariable[];
  seps: number[];
}

/** 读变量流（到 EOF / EOC 为止；区级流中的 separator 保序记账，不再丢弃） */
function readVarStream(r: ByteReader, policy: CellPolicy): VarStreamResult {
  const vars: ArchiveVariable[] = [];
  const seps: number[] = [];
  for (;;) {
    const v = readVar(r, policy);
    if (v === 'eof' || v === 'eoc') return { vars, seps };
    if (v === 'separator') {
      seps.push(vars.length);
      continue;
    }
    vars.push(v);
  }
}

/** 角色块读取结果：变量本体 + **全部**分隔符位置 + 内置/#DIM 分界（首分隔符） */
interface CharBlockResult {
  vars: ArchiveVariable[];
  seps: number[];
  dimSepIndex: number | null;
}

/** 读一个角色块（内置变量流 + Separator + #DIM 变量流 + EOC；分隔符可有多个） */
function readCharBlock(r: ByteReader, index: number, policy: CellPolicy): CharBlockResult {
  const vars: ArchiveVariable[] = [];
  const seps: number[] = [];
  for (;;) {
    const v = readVar(r, policy);
    if (v === 'eof') {
      throw new ArchiveParseError(`角色块 #${index} 未以 EOC 结束（先遇到 EOF）`, r.offset);
    }
    if (v === 'eoc') break;
    if (v === 'separator') {
      seps.push(vars.length);
      continue;
    }
    vars.push(v);
  }
  // 契约字段仍表意"内置 / #DIM 分界"：取**首个**分隔符位置（金样本 ≤1 分隔符时
  // 与旧"仅记最后一个"的行为一致，多分隔符时不再互相覆盖丢字节）。
  return { vars, seps, dimSepIndex: seps.length > 0 ? seps[0]! : null };
}

/**
 * 解析一个完整存档文件（含 gzip 解压）。
 *
 * @param bytes 原始文件字节（含 16 字节明文头）
 * @param path  文件路径（写入结果用于展示 / 回溯）
 */
export async function parseArchive(
  bytes: Uint8Array,
  path: string,
  opts: ArchiveParseOptions = {},
): Promise<SnapshotArchive> {
  const policy: CellPolicy = {
    keep: opts.keepArrayCells !== false,
    max: opts.maxCellsPerArray ?? KEEP_ALL_CELLS.max,
    keepRaw: opts.keepRaw === true,
  };

  // ---- 16 字节明文头 ----
  if (bytes.length < 16) {
    throw new ArchiveParseError('文件过短（不足 16 字节明文头）', 0);
  }
  const head = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = head.getBigUint64(0, true);
  let format: ArchiveContainerFormat;
  if (magic === MAGIC_GZIP) format = 'gzip';
  else if (magic === MAGIC_RAW) format = 'raw';
  else throw new ArchiveParseError(`未知存档魔数 0x${magic.toString(16).padStart(16, '0')}`, 0);
  const version = head.getUint32(8, true);
  if (version !== FORMAT_VERSION) {
    throw new ArchiveParseError(`不支持的二进制格式版本 ${version}（本解析器支持 ${FORMAT_VERSION}）`, 8);
  }
  // head[12..16] 为引擎保留字段（实测恒 0，但**不假设**——捕获原始 4 字节，
  // 重组容器时原样回写，使非 0 保留字节的档也能逐字节 round-trip）。
  const reservedHeader = bytes.slice(12, 16);

  // ---- 正文 ----
  const body = format === 'gzip' ? await gunzipBytes(bytes.subarray(16)) : bytes.subarray(16);

  // ---- 正文顶层 ----
  const r = new ByteReader(body);
  const ft = r.byte();
  const fileType = FILE_TYPES[ft];
  if (!fileType) throw new ArchiveParseError(`未知文件类型 ${ft}`, 0);
  const uniqueCode = r.int64().toString();
  const gameVersion = r.int64().toString();
  const saveMes = r.str('存档备注');

  let charCount = 0;
  if (fileType === 'normal' || fileType === 'charvar') {
    charCount = r.int64AsNumber('角色数');
  }

  const meta = {
    path,
    fileName: basename(path),
    size: bytes.length,
    format,
    version,
    fileType,
    uniqueCode,
    gameVersion,
    saveMes,
    charCount,
    decompressedSize: body.length,
  };

  // headerOnly：浅解析（扫描场景）到此为止
  if (opts.headerOnly) {
    const out: SnapshotArchive = {
      ...meta,
      bodySize: body.length,
      consumed: r.offset,
      remaining: body.length - r.offset,
    };
    if (r.warnings.length > 0) out.warnings = [...r.warnings];
    return out;
  }

  // ---- 角色区 ----
  let chars: ArchiveCharacterBlock[] | undefined;
  const charSeps = new Map<number, SepPositions>();
  if (fileType === 'normal' || fileType === 'charvar') {
    chars = [];
    for (let i = 0; i < charCount; i++) {
      const block = readCharBlock(r, i, policy);
      if (block.seps.length > 0) charSeps.set(i, block.seps);
      chars.push({ index: i, vars: block.vars, dimSepIndex: block.dimSepIndex });
    }
  }

  // ---- 主变量区（normal / var） ----
  let vars: ArchiveVariable[] | undefined;
  let varSeps: SepPositions = [];
  if (fileType === 'normal' || fileType === 'var') {
    const stream = readVarStream(r, policy);
    vars = stream.vars;
    varSeps = stream.seps;
  }

  // ---- 全局变量区（global） ----
  let globalVars: ArchiveVariable[] | undefined;
  let globalVarSeps: SepPositions = [];
  if (fileType === 'global') {
    const stream = readVarStream(r, policy);
    globalVars = stream.vars;
    globalVarSeps = stream.seps;
  }

  // ---- EM 扩展区（normal / global 的第二段） ----
  let emVars: ArchiveVariable[] | undefined;
  let emVarSeps: SepPositions = [];
  if ((fileType === 'normal' || fileType === 'global') && r.remaining > 0) {
    const stream = readVarStream(r, policy);
    emVars = stream.vars;
    emVarSeps = stream.seps;
  }

  // ---- 尾部残余字节（最后一个 EOF 之后未被消费的正文；原样回写才能逐字节还原）----
  const trailingBytes = body.slice(r.offset);

  const out: SnapshotArchive = {
    ...meta,
    bodySize: body.length,
    consumed: r.offset,
    remaining: body.length - r.offset,
  };
  if (chars) out.chars = chars;
  if (vars) out.vars = vars;
  if (globalVars) out.globalVars = globalVars;
  if (emVars) out.emVars = emVars;
  if (r.warnings.length > 0) out.warnings = [...r.warnings];
  recordFidelity(out, {
    reservedHeader,
    trailingBytes,
    varSeps,
    globalVarSeps,
    emVarSeps,
    charSeps,
  });
  return out;
}
