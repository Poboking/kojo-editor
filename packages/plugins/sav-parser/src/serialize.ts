/**
 * 存档载荷重序列化（游戏无关；v1.1 写侧预研 PoC，v0.2 第十一批）。
 *
 * `serializePayload(archive)` 把解析产物写回**载荷层字节**（不含 16 字节
 * 明文头与 gzip 容器——容器层对称性由 CompressionStream 提供，注入器实现
 * 时再验证）。与 parse.ts 逐结构对称：
 *
 *   顶层：fileType + int64(uniqueCode) + int64(gameVersion) + str(saveMes)
 *         + int64(charCount)（normal/charvar）
 *   角色块 ×N：内置变量流 + [0xFD 分隔（#DIM 界）] + 0xFE
 *   主变量区 / 全局区 / EM 区：变量流 + 0xFF
 *
 * **数组游程重编码**（与引擎写侧决策同构，金样本逐字节对比验证）：
 * - 1D：cell 间隙 → 0xF0 + encodeInt(gap)；值 → encodeInt；结束 → 0xFF；
 * - 2D：x 前进 1 → 0xE0；x 跳 n>1 → 0xF1 + encodeInt(n)；y 跳 → 0xF0 + encodeInt；
 * - 3D：z 跳 → 0xF0；y 进 1 → 0xE0；y 跳 → 0xF1；x 进 1 → 0xE1；x 跳 → 0xF2；
 * - 字符串数组：cell → 0xD8 + str；
 * - 尾段剪枝：最后一个 cell 写完即 0xFF（全零/全空尾段不写，cursor 语义由
 *   读取侧推进自然一致）。
 *
 * **已知边界（不静默）**：cells 被省略/截断的档（keepArrayCells=false 或
 * 超 max）不可重序列化——抛 `ArchiveParseError`（金样本测试必须全量保留）。
 */

import type {
  ArchiveArrayVariable,
  ArchiveCharacterBlock,
  ArchiveFileType,
  ArchiveVariable,
  SnapshotArchive,
} from '@kojo/plugin-api';
import { ArchiveParseError } from './binary';
import { ByteWriter } from './writer';

const TYPE_TOKEN: Record<ArchiveVariable['type'], number> = {
  int: 0x00,
  'int-array-1d': 0x01,
  'int-array-2d': 0x02,
  'int-array-3d': 0x03,
  str: 0x10,
  'str-array-1d': 0x11,
  'str-array-2d': 0x12,
  'str-array-3d': 0x13,
  map: 0x20,
  xml: 0x21,
  datatable: 0x22,
};

function requireFullCells(v: ArchiveArrayVariable): void {
  if (v.cellsTruncated) {
    throw new ArchiveParseError(`数组 ${v.key} 的 cells 被截断，无法重序列化（需全量解析档）`, v.offset);
  }
}

// ---------------------------------------------------------------------------
// 数组游程重编码
// ---------------------------------------------------------------------------

function writeIntArray1D(w: ByteWriter, v: ArchiveArrayVariable): void {
  requireFullCells(v);
  w.int32(v.saveLen[0]!);
  let x = 0;
  for (const cell of v.cells) {
    const cx = cell.index[0]!;
    if (cx < x) throw new ArchiveParseError(`数组 ${v.key} cells 未按序（${x} → ${cx}）`, v.offset);
    if (cx > x) {
      w.byte(0xf0);
      w.encodeInt(cx - x);
      x = cx;
    }
    if (typeof cell.value !== 'number') throw new ArchiveParseError(`数组 ${v.key} 单元类型不符`, v.offset);
    w.encodeInt(cell.value);
    x++;
  }
  w.byte(0xff);
}

function writeIntArray2D(w: ByteWriter, v: ArchiveArrayVariable): void {
  requireFullCells(v);
  w.int32(v.saveLen[0]!);
  w.int32(v.saveLen[1]!);
  // **行驱动编码**（金样本 cursor 证据：GMF_MAPNAME cursor=[12,0]——最后行写完
  // 仍写 0xE0 换行）：每行内容后必写 0xE0；行间 dx=1 → 0xE0、dx>1 → 0xF1+n；
  // 行内列跳 → 0xF0+n；结束 → 0xFF。
  let i = 0;
  let curX = 0;
  while (i < v.cells.length) {
    const rowX = v.cells[i]!.index[0]!;
    if (rowX < curX) throw new ArchiveParseError(`数组 ${v.key} cells 未按序`, v.offset);
    if (rowX > curX) {
      if (rowX - curX === 1) w.byte(0xe0);
      else {
        w.byte(0xf1);
        w.encodeInt(rowX - curX);
      }
    }
    let y = 0;
    while (i < v.cells.length && v.cells[i]!.index[0] === rowX) {
      const cell = v.cells[i]!;
      const cy = cell.index[1]!;
      if (cy < y) throw new ArchiveParseError(`数组 ${v.key} 列未按序`, v.offset);
      if (cy > y) {
        w.byte(0xf0);
        w.encodeInt(cy - y);
      }
      if (typeof cell.value !== 'number') throw new ArchiveParseError(`数组 ${v.key} 单元类型不符`, v.offset);
      w.encodeInt(cell.value);
      y = cy + 1;
      i++;
    }
    w.byte(0xe0); // 行末换行（引擎写侧行驱动结构；最后一行也写——cursor 证据）
    curX = rowX + 1;
  }
  w.byte(0xff);
}

function writeIntArray3D(w: ByteWriter, v: ArchiveArrayVariable): void {
  requireFullCells(v);
  w.int32(v.saveLen[0]!);
  w.int32(v.saveLen[1]!);
  w.int32(v.saveLen[2]!);
  // **面>行>列 嵌套行驱动**（与 2D 同构的 cursor 推理）：行末 0xE0（y++）、
  // 面末 0xE1（x++）；跨行/跨面跳跃 0xF1/0xF2 + n；列内跳 0xF0 + n。
  let i = 0;
  let curX = 0;
  while (i < v.cells.length) {
    const faceX = v.cells[i]!.index[0]!;
    if (faceX < curX) throw new ArchiveParseError(`数组 ${v.key} cells 未按序`, v.offset);
    if (faceX > curX) {
      if (faceX - curX === 1) w.byte(0xe1);
      else {
        w.byte(0xf2);
        w.encodeInt(faceX - curX);
      }
    }
    let curY = 0;
    while (i < v.cells.length && v.cells[i]!.index[0] === faceX) {
      const rowY = v.cells[i]!.index[1]!;
      if (rowY < curY) throw new ArchiveParseError(`数组 ${v.key} 行未按序`, v.offset);
      if (rowY > curY) {
        if (rowY - curY === 1) w.byte(0xe0);
        else {
          w.byte(0xf1);
          w.encodeInt(rowY - curY);
        }
      }
      let z = 0;
      while (i < v.cells.length && v.cells[i]!.index[0] === faceX && v.cells[i]!.index[1] === rowY) {
        const cell = v.cells[i]!;
        const cz = cell.index[2]!;
        if (cz < z) throw new ArchiveParseError(`数组 ${v.key} 列未按序`, v.offset);
        if (cz > z) {
          w.byte(0xf0);
          w.encodeInt(cz - z);
        }
        if (typeof cell.value !== 'number') throw new ArchiveParseError(`数组 ${v.key} 单元类型不符`, v.offset);
        w.encodeInt(cell.value);
        z = cz + 1;
        i++;
      }
      w.byte(0xe0); // 行末换行
      curY = rowY + 1;
    }
    w.byte(0xe1); // 面末换面
    curX = faceX + 1;
  }
  w.byte(0xff);
}

function writeStrArray1D(w: ByteWriter, v: ArchiveArrayVariable): void {
  requireFullCells(v);
  w.int32(v.saveLen[0]!);
  let x = 0;
  for (const cell of v.cells) {
    const cx = cell.index[0]!;
    if (cx < x) throw new ArchiveParseError(`数组 ${v.key} cells 未按序`, v.offset);
    if (cx > x) {
      w.byte(0xf0);
      w.encodeInt(cx - x);
      x = cx;
    }
    if (typeof cell.value !== 'string') throw new ArchiveParseError(`数组 ${v.key} 单元类型不符`, v.offset);
    w.byte(0xd8);
    w.str(cell.value);
    x++;
  }
  w.byte(0xff);
}

function writeStrArray2D(w: ByteWriter, v: ArchiveArrayVariable): void {
  requireFullCells(v);
  w.int32(v.saveLen[0]!);
  w.int32(v.saveLen[1]!);
  // 行驱动（同 writeIntArray2D；cell → 0xD8 + str）
  let i = 0;
  let curX = 0;
  while (i < v.cells.length) {
    const rowX = v.cells[i]!.index[0]!;
    if (rowX < curX) throw new ArchiveParseError(`数组 ${v.key} cells 未按序`, v.offset);
    if (rowX > curX) {
      if (rowX - curX === 1) w.byte(0xe0);
      else {
        w.byte(0xf1);
        w.encodeInt(rowX - curX);
      }
    }
    let y = 0;
    while (i < v.cells.length && v.cells[i]!.index[0] === rowX) {
      const cell = v.cells[i]!;
      const cy = cell.index[1]!;
      if (cy < y) throw new ArchiveParseError(`数组 ${v.key} 列未按序`, v.offset);
      if (cy > y) {
        w.byte(0xf0);
        w.encodeInt(cy - y);
      }
      if (typeof cell.value !== 'string') throw new ArchiveParseError(`数组 ${v.key} 单元类型不符`, v.offset);
      w.byte(0xd8);
      w.str(cell.value);
      y = cy + 1;
      i++;
    }
    w.byte(0xe0);
    curX = rowX + 1;
  }
  w.byte(0xff);
}

function writeStrArray3D(w: ByteWriter, v: ArchiveArrayVariable): void {
  requireFullCells(v);
  w.int32(v.saveLen[0]!);
  w.int32(v.saveLen[1]!);
  w.int32(v.saveLen[2]!);
  // 面>行>列 嵌套行驱动（同 writeIntArray3D；cell → 0xD8 + str）
  let i = 0;
  let curX = 0;
  while (i < v.cells.length) {
    const faceX = v.cells[i]!.index[0]!;
    if (faceX < curX) throw new ArchiveParseError(`数组 ${v.key} cells 未按序`, v.offset);
    if (faceX > curX) {
      if (faceX - curX === 1) w.byte(0xe1);
      else {
        w.byte(0xf2);
        w.encodeInt(faceX - curX);
      }
    }
    let curY = 0;
    while (i < v.cells.length && v.cells[i]!.index[0] === faceX) {
      const rowY = v.cells[i]!.index[1]!;
      if (rowY < curY) throw new ArchiveParseError(`数组 ${v.key} 行未按序`, v.offset);
      if (rowY > curY) {
        if (rowY - curY === 1) w.byte(0xe0);
        else {
          w.byte(0xf1);
          w.encodeInt(rowY - curY);
        }
      }
      let z = 0;
      while (i < v.cells.length && v.cells[i]!.index[0] === faceX && v.cells[i]!.index[1] === rowY) {
        const cell = v.cells[i]!;
        const cz = cell.index[2]!;
        if (cz < z) throw new ArchiveParseError(`数组 ${v.key} 列未按序`, v.offset);
        if (cz > z) {
          w.byte(0xf0);
          w.encodeInt(cz - z);
        }
        if (typeof cell.value !== 'string') throw new ArchiveParseError(`数组 ${v.key} 单元类型不符`, v.offset);
        w.byte(0xd8);
        w.str(cell.value);
        z = cz + 1;
        i++;
      }
      w.byte(0xe0);
      curY = rowY + 1;
    }
    w.byte(0xe1);
    curX = faceX + 1;
  }
  w.byte(0xff);
}

// ---------------------------------------------------------------------------
// 变量 / 区 / 载荷
// ---------------------------------------------------------------------------

function writeVar(w: ByteWriter, v: ArchiveVariable): void {
  const token = TYPE_TOKEN[v.type];
  if (token === undefined) throw new ArchiveParseError(`未知变量类型：${v.type}`, v.offset);
  w.byte(token);
  w.str(v.key);
  // 判别式 narrow 在联合字面量属性上不可靠（§九-10），显式守卫
  const isIntScalar = v.type === 'int' && typeof (v as { value: unknown }).value === 'number';
  const isStrScalar = (v.type === 'str' || v.type === 'xml') && typeof (v as { value: unknown }).value === 'string';
  if (isIntScalar) {
    w.encodeInt((v as { value: number }).value);
    return;
  }
  if (isStrScalar) {
    w.str((v as { value: string }).value);
    return;
  }
  switch (v.type) {
    case 'map':
      w.int32(v.count);
      for (const [k, val] of v.pairs) {
        w.str(k);
        w.str(val);
      }
      break;
    case 'datatable':
      w.str(v.schema);
      w.str(v.data);
      break;
    case 'int-array-1d':
      writeIntArray1D(w, v);
      break;
    case 'int-array-2d':
      writeIntArray2D(w, v);
      break;
    case 'int-array-3d':
      writeIntArray3D(w, v);
      break;
    case 'str-array-1d':
      writeStrArray1D(w, v);
      break;
    case 'str-array-2d':
      writeStrArray2D(w, v);
      break;
    case 'str-array-3d':
      writeStrArray3D(w, v);
      break;
  }
}

function writeVarStream(w: ByteWriter, vars: readonly ArchiveVariable[]): void {
  for (const v of vars) writeVar(w, v);
  w.byte(0xff); // EOF
}

function writeCharBlock(w: ByteWriter, block: ArchiveCharacterBlock): void {
  const sep = block.dimSepIndex;
  for (let i = 0; i < block.vars.length; i++) {
    if (sep !== null && sep !== undefined && i === sep) w.byte(0xfd); // Separator（#DIM 界）
    writeVar(w, block.vars[i]!);
  }
  if (sep !== null && sep !== undefined && sep >= block.vars.length) w.byte(0xfd);
  w.byte(0xfe); // EOC
}

const FILE_TYPE_CODE: Record<ArchiveFileType, number> = {
  normal: 0,
  global: 1,
  var: 2,
  charvar: 3,
};

/**
 * 载荷层重序列化（parse 的逆；不含明文头与 gzip 容器）。
 * cells 省略/截断的档不可重序列化（显式抛错，不静默产出损坏载荷）。
 */
export function serializePayload(archive: SnapshotArchive): Uint8Array {
  const w = new ByteWriter();
  const ft = archive.fileType;
  w.byte(FILE_TYPE_CODE[ft]);
  w.int64(BigInt(archive.uniqueCode));
  w.int64(BigInt(archive.gameVersion));
  w.str(archive.saveMes);
  if (ft === 'normal' || ft === 'charvar') {
    w.int64(BigInt(archive.charCount));
    for (const block of archive.chars ?? []) writeCharBlock(w, block);
  }
  if (ft === 'normal' || ft === 'var') {
    writeVarStream(w, archive.vars ?? []);
  }
  if (ft === 'global') {
    writeVarStream(w, archive.globalVars ?? []);
  }
  if ((ft === 'normal' || ft === 'global') && archive.emVars) {
    writeVarStream(w, archive.emVars);
  }
  return w.toBytes();
}
