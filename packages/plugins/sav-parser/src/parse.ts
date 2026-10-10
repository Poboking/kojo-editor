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

/** 读变量流（到 EOF / EOC 为止；区级流中的 separator 罕见，跳过） */
function readVarStream(r: ByteReader, policy: CellPolicy): ArchiveVariable[] {
  const vars: ArchiveVariable[] = [];
  for (;;) {
    const v = readVar(r, policy);
    if (v === 'eof' || v === 'eoc') return vars;
    if (v === 'separator') continue;
    vars.push(v);
  }
}

/** 读一个角色块（内置变量流 + Separator + #DIM 变量流 + EOC） */
function readCharBlock(r: ByteReader, index: number, policy: CellPolicy): ArchiveCharacterBlock {
  const vars: ArchiveVariable[] = [];
  let dimSepIndex: number | null = null;
  for (;;) {
    const v = readVar(r, policy);
    if (v === 'eof') {
      throw new ArchiveParseError(`角色块 #${index} 未以 EOC 结束（先遇到 EOF）`, r.offset);
    }
    if (v === 'eoc') break;
    if (v === 'separator') {
      dimSepIndex = vars.length;
      continue;
    }
    vars.push(v);
  }
  return { index, vars, dimSepIndex };
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
  // head[12..16] 为引擎保留字段（实测恒 0，不消费）

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
  if (fileType === 'normal' || fileType === 'charvar') {
    chars = [];
    for (let i = 0; i < charCount; i++) chars.push(readCharBlock(r, i, policy));
  }

  // ---- 主变量区（normal / var） ----
  let vars: ArchiveVariable[] | undefined;
  if (fileType === 'normal' || fileType === 'var') {
    vars = readVarStream(r, policy);
  }

  // ---- 全局变量区（global） ----
  let globalVars: ArchiveVariable[] | undefined;
  if (fileType === 'global') {
    globalVars = readVarStream(r, policy);
  }

  // ---- EM 扩展区（normal / global 的第二段） ----
  let emVars: ArchiveVariable[] | undefined;
  if ((fileType === 'normal' || fileType === 'global') && r.remaining > 0) {
    emVars = readVarStream(r, policy);
  }

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
  return out;
}
