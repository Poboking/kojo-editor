/**
 * 存档二进制写入原语（游戏无关；v1.1 写侧预研 PoC，v0.2 第十一批）。
 *
 * 与 `ByteReader`（读侧）逐原语对称，镜像引擎写侧字节语义：
 * - 整数（m_ReadInt 的逆）：值 ∈ [0, 0xCF] 单字节直写；否则 0xD0 + Int16 /
 *   0xD1 + Int32 / 0xD2 + Int64（小端）。**编码决策与引擎写侧的完全一致性
 *   由金样本逐字节对比验证**（见 golden-roundtrip.test.ts）；
 * - 字符串：7-bit 变长前缀（**UTF-16LE 字节数**）+ UTF-16LE 正文；
 * - 越界 / 非法值抛 `ArchiveParseError`，绝不静默。
 */

import { ArchiveParseError } from './binary';

export class ByteWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;
  private view = new DataView(new ArrayBuffer(8));

  get offset(): number {
    return this.length;
  }

  /** 累计产物（拷贝合并；调用一次即冻结语义） */
  toBytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  private push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  byte(b: number): void {
    if (!Number.isInteger(b) || b < 0 || b > 0xff) {
      throw new ArchiveParseError(`写字节非法值：${b}`, this.offset);
    }
    this.push(new Uint8Array([b]));
  }

  int16(v: number): void {
    this.view.setInt16(0, v, true);
    this.push(new Uint8Array(this.view.buffer.slice(0, 2)));
  }

  int32(v: number): void {
    this.view.setInt32(0, v, true);
    this.push(new Uint8Array(this.view.buffer.slice(0, 4)));
  }

  int64(v: bigint | number): void {
    this.view.setBigInt64(0, BigInt(v), true);
    this.push(new Uint8Array(this.view.buffer.slice(0, 8)));
  }

  /**
   * m_ReadInt 的逆（标量与数组元素、跳跃量共用）：≤ 0xCF 单字节；
   * Int16 / Int32 / Int64 定宽前缀按最小可容纳宽度选择。
   */
  encodeInt(v: number): void {
    if (!Number.isInteger(v)) {
      throw new ArchiveParseError(`写整数非整数值：${v}`, this.offset);
    }
    if (v >= 0 && v <= 0xcf) {
      this.byte(v);
      return;
    }
    if (v >= -0x8000 && v <= 0x7fff) {
      this.byte(0xd0);
      this.int16(v);
      return;
    }
    if (v >= -0x80000000 && v <= 0x7fffffff) {
      this.byte(0xd1);
      this.int32(v);
      return;
    }
    if (v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER) {
      this.byte(0xd2);
      this.int64(BigInt(v));
      return;
    }
    throw new ArchiveParseError(`写整数超出安全整数范围：${v}`, this.offset);
  }

  /** 7-bit 变长无符号整数（.NET BinaryWriter 长度前缀语义）。 */
  sevenBitUInt(v: number): void {
    if (!Number.isInteger(v) || v < 0) {
      throw new ArchiveParseError(`7-bit 前缀要求非负整数：${v}`, this.offset);
    }
    let x = v;
    for (;;) {
      let b = x % 128; // 乘除法而非位运算：与读侧同口径，避开 32 位截断
      x = Math.floor(x / 128);
      if (x !== 0) b += 0x80;
      this.byte(b);
      if (x === 0) return;
    }
  }

  /** .NET BinaryWriter 字符串：7-bit 前缀（**UTF-16LE 字节数**）+ UTF-16LE 正文。 */
  str(s: string): void {
    const units: number[] = [];
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
        const lo = s.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          // 代理对：两个码元原样写回（UTF-16LE）
          units.push(code, lo);
          i++;
          continue;
        }
      }
      units.push(code);
    }
    this.sevenBitUInt(units.length * 2);
    const buf = new Uint8Array(units.length * 2);
    const dv = new DataView(buf.buffer);
    for (let i = 0; i < units.length; i++) dv.setUint16(i * 2, units[i]!, true);
    this.push(buf);
  }
}
