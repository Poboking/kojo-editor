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
  ArchiveArrayCell,
  ArchiveArrayVariable,
  ArchiveCellPatch,
  ArchiveCharacterBlock,
  ArchiveFileType,
  ArchiveOverrideValue,
  ArchiveOverrides,
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

/** 下标元组比较（同维度；逐元素升序） */
function compareIndex(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return a.length - b.length;
}

/**
 * 被修改数组变量的重编码单元集：既有 cells 与补丁按下标合并（同下标替换、
 * 新下标插入），**Int64 精度守卫**——任一单元值超出安全整数域即拒绝注入
 * （该值在读侧已被双精度近似，重编码会写回错误字节损坏存档，绝不静默）。
 */
function mergedCells(v: ArchiveArrayVariable, patches: readonly ArchiveCellPatch[]): ArchiveArrayCell[] {
  requireFullCells(v);
  const all = [...v.cells, ...patches] as const;
  for (const c of all) {
    if (typeof c.value === 'number' && !Number.isSafeInteger(c.value)) {
      throw new ArchiveParseError(
        `数组 ${v.key} 的单元值 ${c.value} 超出安全整数域（读侧已近似，重编码会损坏存档）——注入被拒绝`,
        v.offset,
      );
    }
  }
  const byIndex = new Map<string, ArchiveArrayCell>();
  for (const c of v.cells) byIndex.set(c.index.join(','), { index: [...c.index], value: c.value });
  for (const p of patches) {
    if (p.index.length !== v.saveLen.length) {
      throw new ArchiveParseError(
        `数组 ${v.key} 补丁下标维度不符（${p.index.length} vs ${v.saveLen.length}）`,
        v.offset,
      );
    }
    byIndex.set(p.index.join(','), { index: [...p.index], value: p.value });
  }
  return [...byIndex.values()].sort((a, b) => compareIndex(a.index, b.index));
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

function writeVar(w: ByteWriter, v: ArchiveVariable, override?: ArchiveOverrideValue): void {
  // ---- passthrough 路径（方案 B：有 raw 视图且未修改 → 整段原样复制）----
  // raw 区间含类型 token + key + 值，必须在写 token 之前短路。
  if (override === undefined && v.raw) {
    w.bytes(v.raw);
    return;
  }

  const token = TYPE_TOKEN[v.type];
  if (token === undefined) throw new ArchiveParseError(`未知变量类型：${v.type}`, v.offset);
  w.byte(token);
  w.str(v.key);

  // ---- 覆盖路径（被修改变量：重编码 + Int64 守卫）----
  if (override !== undefined) {
    if (v.type === 'int') {
      if (typeof override !== 'number') throw new ArchiveParseError(`整数变量 ${v.key} 的覆盖值须为 number`, v.offset);
      w.encodeInt(override);
      return;
    }
    if (v.type === 'str' || v.type === 'xml') {
      if (typeof override !== 'string') throw new ArchiveParseError(`字符串变量 ${v.key} 的覆盖值须为 string`, v.offset);
      w.str(override);
      return;
    }
    if (v.type.startsWith('int-array') || v.type.startsWith('str-array')) {
      if (!Array.isArray(override) || override.length === 0) {
        throw new ArchiveParseError(`数组变量 ${v.key} 的覆盖值须为非空 ArchiveCellPatch 数组`, v.offset);
      }
      if (!('cells' in v)) throw new ArchiveParseError(`变量 ${v.key} 不支持单元补丁（非数组变量）`, v.offset);
      const patched: ArchiveArrayVariable = { ...v, cells: mergedCells(v, override) };
      switch (v.type) {
        case 'int-array-1d':
          writeIntArray1D(w, patched);
          return;
        case 'int-array-2d':
          writeIntArray2D(w, patched);
          return;
        case 'int-array-3d':
          writeIntArray3D(w, patched);
          return;
        case 'str-array-1d':
          writeStrArray1D(w, patched);
          return;
        case 'str-array-2d':
          writeStrArray2D(w, patched);
          return;
        case 'str-array-3d':
          writeStrArray3D(w, patched);
          return;
      }
    }
    throw new ArchiveParseError(`变量类型 ${v.type} 暂不支持注入覆盖（${v.key}）`, v.offset);
  }

  // ---- 传统重编码路径（无 raw：如手工构造的 archive 或 keepRaw 未开启）----
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

function writeVarStream(w: ByteWriter, vars: readonly ArchiveVariable[], overrides?: ReadonlyMap<string, ArchiveOverrideValue>): void {
  for (const v of vars) writeVar(w, v, overrides?.get(v.key));
  w.byte(0xff); // EOF
}

function writeCharBlock(w: ByteWriter, block: ArchiveCharacterBlock, overrides?: ReadonlyMap<string, ArchiveOverrideValue>): void {
  const sep = block.dimSepIndex;
  for (let i = 0; i < block.vars.length; i++) {
    if (sep !== null && sep !== undefined && i === sep) w.byte(0xfd); // Separator（#DIM 界）
    const v = block.vars[i]!;
    writeVar(w, v, overrides?.get(v.key));
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
 *
 * v0.2 第十三批方案 B：
 * - 未覆盖且有 `raw` 视图的变量**原样复制**（passthrough）——Int64 近似值
 *   永不重编码，近似档（save01+）的写回从"显式拒绝"变为"字节级安全"；
 * - `overrides` 列出的变量重编码（数组 = 单元级补丁合并），任一值超出安全
 *   整数域即抛错拒绝（损坏不落盘）。
 *
 * cells 省略/截断的档：无覆盖时靠 raw passthrough 仍可重序列化；**被覆盖的**
 * 数组若 cells 截断则拒绝（显式抛错，不静默产出损坏载荷）。
 */
export function serializePayload(archive: SnapshotArchive, opts?: { overrides?: ArchiveOverrides }): Uint8Array {
  const w = new ByteWriter();
  const ft = archive.fileType;
  w.byte(FILE_TYPE_CODE[ft]);
  w.int64(BigInt(archive.uniqueCode));
  w.int64(BigInt(archive.gameVersion));
  w.str(archive.saveMes);
  if (ft === 'normal' || ft === 'charvar') {
    w.int64(BigInt(archive.charCount));
    for (const block of archive.chars ?? []) {
      writeCharBlock(w, block, opts?.overrides?.chars?.get(block.index));
    }
  }
  if (ft === 'normal' || ft === 'var') {
    writeVarStream(w, archive.vars ?? [], opts?.overrides?.vars);
  }
  if (ft === 'global') {
    writeVarStream(w, archive.globalVars ?? [], opts?.overrides?.vars);
  }
  if ((ft === 'normal' || ft === 'global') && archive.emVars) {
    writeVarStream(w, archive.emVars, opts?.overrides?.vars);
  }
  return w.toBytes();
}
