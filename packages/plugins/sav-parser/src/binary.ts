/**
 * 存档二进制读取原语（游戏无关）。
 *
 * 严格镜像引擎读侧的字节语义（真实六档字节级实测，见逆向系列《存档实战解析》）：
 * - 字符串：.NET BinaryWriter 写法的 7-bit 变长前缀是**字节数**（GetByteCount），
 *   不是字符数——UTF-16LE 下含非 ASCII 字符的串两者差一倍，是实战最大的坑；
 * - 整数（m_ReadInt 镜像）：≤ 0xCF 单字节直读；0xD0 = Int16；0xD1 = Int32；
 *   0xD2 = Int64。
 *
 * 所有越界 / 非法编码都抛 `ArchiveParseError`（携带字节偏移），绝不静默。
 */

/** 存档解析错误（携带字节偏移，便于对真实档排障） */
export class ArchiveParseError extends Error {
  constructor(
    message: string,
    public readonly offset: number,
  ) {
    super(`${message} @0x${offset.toString(16)}`);
    this.name = 'ArchiveParseError';
  }
}

export class ByteReader {
  private pos = 0;
  private readonly view: DataView;
  private readonly utf16 = new TextDecoder('utf-16le');
  /** 解析警告（如 Int64 超出安全整数范围被近似；不中断解析，不静默） */
  readonly warnings: string[] = [];

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get offset(): number {
    return this.pos;
  }

  get size(): number {
    return this.buf.length;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  private need(n: number, what: string): void {
    if (n < 0 || this.pos + n > this.buf.length) {
      throw new ArchiveParseError(`${what}越界：需要 ${n} 字节，剩余 ${this.remaining}`, this.pos);
    }
  }

  byte(): number {
    this.need(1, '读字节');
    return this.view.getUint8(this.pos++);
  }

  int16(): number {
    this.need(2, 'Int16');
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  int32(): number {
    this.need(4, 'Int32');
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  int64(): bigint {
    this.need(8, 'Int64');
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** Int64 读为 number；超出安全整数范围时记警告（近似保留，不中断） */
  int64AsNumber(what: string): number {
    const v = this.int64();
    const n = Number(v);
    if (!Number.isSafeInteger(n)) {
      this.warnings.push(`${what}的值 ${v.toString()} 超出安全整数范围，已按双精度近似`);
    }
    return n;
  }

  /**
   * 以已读首字节解码整数（m_ReadInt 镜像；标量与数组元素共用）。
   */
  intFromByte(first: number, what = '整数'): number {
    if (first <= 0xcf) return first;
    if (first === 0xd0) return this.int16();
    if (first === 0xd1) return this.int32();
    if (first === 0xd2) return this.int64AsNumber(what);
    throw new ArchiveParseError(`${what}非法首字节 0x${first.toString(16)}`, this.pos - 1);
  }

  /** 读一个编码整数（自读首字节）。 */
  varInt(what = '整数'): number {
    return this.intFromByte(this.byte(), what);
  }

  /** 7-bit 变长无符号整数（.NET BinaryWriter 长度前缀语义）。 */
  private sevenBitUInt(what: string): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (shift > 35) throw new ArchiveParseError(`${what}的 7-bit 前缀超过 6 字节（流已错位）`, this.pos - 1);
      const b = this.byte();
      // 用乘法而非位运算：避开 32 位溢出，5 字节前缀（2^35）仍在安全整数内
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return value;
      shift += 7;
    }
  }

  /** 读 .NET BinaryWriter 字符串：7-bit 变长前缀（**字节数**）+ UTF-16LE 正文。 */
  str(what = '字符串'): string {
    const byteLength = this.sevenBitUInt(`${what}长度`);
    if (byteLength % 2 !== 0) {
      throw new ArchiveParseError(`${what}字节长度为奇数（${byteLength}）——流已错位`, this.pos);
    }
    this.need(byteLength, `${what}正文`);
    const s = this.utf16.decode(this.buf.subarray(this.pos, this.pos + byteLength));
    this.pos += byteLength;
    return s;
  }
}
