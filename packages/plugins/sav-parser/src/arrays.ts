/**
 * 数组游程解码（游戏无关；严格镜像引擎读侧的游程语义，六档全字节实测）。
 *
 * 游程标记：
 * - `0xFF` 数组结束；`0xF0` 跳过若干连续空元素（行内 / 1D）；
 * - `0xF1` / `0xE0`：跳行 / 换行（2D 及以上）；`0xF2` / `0xE1`：跳面 / 换面（3D）；
 * - `0xD8`：字符串元素前缀（其后跟一个字符串）。
 *
 * 稀疏存储：只落非零 / 非空单元（全零尾段被写侧剪枝）；`saveLen` 为声明维度长度，
 * `cursor` 为解码推进到的位置——两者共同还原完整形状。
 */

import type { ArchiveArrayCell } from '@kojo/plugin-api';
import type { ByteReader } from './binary';
import { ArchiveParseError } from './binary';

/** cells 保留策略：省略（keep=false）或截断（超过 max）；游标推进始终完整执行 */
export interface CellPolicy {
  keep: boolean;
  max: number;
}

/** 默认策略：完整保留 */
export const KEEP_ALL_CELLS: CellPolicy = { keep: true, max: Number.POSITIVE_INFINITY };

export interface ArrayReadResult {
  /** 声明维度长度（1-3 个元素） */
  saveLen: number[];
  /** 读毕游标（1-3 个元素） */
  cursor: number[];
  /** 非零 / 非空单元数（始终准确） */
  nonEmpty: number;
  /** 保留的单元（可能被省略 / 截断） */
  cells: ArchiveArrayCell[];
}

/** cells 收集器：统一处理省略与截断 */
class CellSink {
  readonly cells: ArchiveArrayCell[] = [];
  nonEmpty = 0;

  constructor(private readonly policy: CellPolicy) {}

  push(index: number[], value: number | string): void {
    if (this.policy.keep && this.cells.length < this.policy.max) {
      this.cells.push({ index, value });
    }
    this.nonEmpty++;
  }
}

export function readIntArray1D(r: ByteReader, policy: CellPolicy): ArrayReadResult {
  const saveLen = r.int32();
  const sink = new CellSink(policy);
  let x = 0;
  for (;;) {
    const b = r.byte();
    if (b === 0xff) break;
    if (b === 0xf0) {
      x += r.varInt('数组跳跃');
      continue;
    }
    sink.push([x], r.intFromByte(b, '数组元素'));
    x++;
  }
  return { saveLen: [saveLen], cursor: [x], nonEmpty: sink.nonEmpty, cells: sink.cells };
}

export function readIntArray2D(r: ByteReader, policy: CellPolicy): ArrayReadResult {
  const l0 = r.int32();
  const l1 = r.int32();
  const sink = new CellSink(policy);
  let x = 0;
  let y = 0;
  for (;;) {
    const b = r.byte();
    if (b === 0xff) break;
    if (b === 0xf1) {
      x += r.varInt('行跳跃');
      y = 0;
      continue;
    }
    if (b === 0xe0) {
      x++;
      y = 0;
      continue;
    }
    if (b === 0xf0) {
      y += r.varInt('列跳跃');
      continue;
    }
    sink.push([x, y], r.intFromByte(b, '数组元素'));
    y++;
  }
  return { saveLen: [l0, l1], cursor: [x, y], nonEmpty: sink.nonEmpty, cells: sink.cells };
}

export function readIntArray3D(r: ByteReader, policy: CellPolicy): ArrayReadResult {
  const l0 = r.int32();
  const l1 = r.int32();
  const l2 = r.int32();
  const sink = new CellSink(policy);
  let x = 0;
  let y = 0;
  let z = 0;
  for (;;) {
    const b = r.byte();
    if (b === 0xff) break;
    if (b === 0xf2) {
      x += r.varInt('面跳跃');
      y = 0;
      z = 0;
      continue;
    }
    if (b === 0xe1) {
      x++;
      y = 0;
      z = 0;
      continue;
    }
    if (b === 0xf1) {
      y += r.varInt('行跳跃');
      z = 0;
      continue;
    }
    if (b === 0xe0) {
      y++;
      z = 0;
      continue;
    }
    if (b === 0xf0) {
      z += r.varInt('列跳跃');
      continue;
    }
    sink.push([x, y, z], r.intFromByte(b, '数组元素'));
    z++;
  }
  return { saveLen: [l0, l1, l2], cursor: [x, y, z], nonEmpty: sink.nonEmpty, cells: sink.cells };
}

export function readStrArray1D(r: ByteReader, policy: CellPolicy): ArrayReadResult {
  const saveLen = r.int32();
  const sink = new CellSink(policy);
  let x = 0;
  for (;;) {
    const b = r.byte();
    if (b === 0xff) break;
    if (b === 0xf0) {
      x += r.varInt('数组跳跃');
      continue;
    }
    if (b === 0xd8) {
      sink.push([x], r.str('字符串元素'));
      x++;
      continue;
    }
    throw new ArchiveParseError(`字符串数组元素非法首字节 0x${b.toString(16)}`, r.offset - 1);
  }
  return { saveLen: [saveLen], cursor: [x], nonEmpty: sink.nonEmpty, cells: sink.cells };
}

export function readStrArray2D(r: ByteReader, policy: CellPolicy): ArrayReadResult {
  const l0 = r.int32();
  const l1 = r.int32();
  const sink = new CellSink(policy);
  let x = 0;
  let y = 0;
  for (;;) {
    const b = r.byte();
    if (b === 0xff) break;
    if (b === 0xf1) {
      x += r.varInt('行跳跃');
      y = 0;
      continue;
    }
    if (b === 0xe0) {
      x++;
      y = 0;
      continue;
    }
    if (b === 0xf0) {
      y += r.varInt('列跳跃');
      continue;
    }
    if (b === 0xd8) {
      sink.push([x, y], r.str('字符串元素'));
      y++;
      continue;
    }
    throw new ArchiveParseError(`字符串数组元素非法首字节 0x${b.toString(16)}`, r.offset - 1);
  }
  return { saveLen: [l0, l1], cursor: [x, y], nonEmpty: sink.nonEmpty, cells: sink.cells };
}

export function readStrArray3D(r: ByteReader, policy: CellPolicy): ArrayReadResult {
  const l0 = r.int32();
  const l1 = r.int32();
  const l2 = r.int32();
  const sink = new CellSink(policy);
  let x = 0;
  let y = 0;
  let z = 0;
  for (;;) {
    const b = r.byte();
    if (b === 0xff) break;
    if (b === 0xf2) {
      x += r.varInt('面跳跃');
      y = 0;
      z = 0;
      continue;
    }
    if (b === 0xe1) {
      x++;
      y = 0;
      z = 0;
      continue;
    }
    if (b === 0xf1) {
      y += r.varInt('行跳跃');
      z = 0;
      continue;
    }
    if (b === 0xe0) {
      y++;
      z = 0;
      continue;
    }
    if (b === 0xf0) {
      z += r.varInt('列跳跃');
      continue;
    }
    if (b === 0xd8) {
      sink.push([x, y, z], r.str('字符串元素'));
      z++;
      continue;
    }
    throw new ArchiveParseError(`字符串数组元素非法首字节 0x${b.toString(16)}`, r.offset - 1);
  }
  return { saveLen: [l0, l1, l2], cursor: [x, y, z], nonEmpty: sink.nonEmpty, cells: sink.cells };
}
