import { describe, expect, it } from 'vitest';
import { ArchiveParseError, ByteReader } from '../src/binary';
import { W } from './helpers/synth';

/** 拼接 [字节, 0] 对（UTF-16LE ASCII） */
function utf16le(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    out.push(code & 0xff, (code >> 8) & 0xff);
  }
  return out;
}

describe('ByteReader 字符串：7-bit 前缀 = 字节数（GetByteCount 语义）', () => {
  it('ASCII "GLOBAL"（6 字符 = 12 字节）前缀为 0x0C（逆向实测实锤）', () => {
    const r = new ByteReader(new Uint8Array([0x0c, ...utf16le('GLOBAL')]));
    expect(r.str()).toBe('GLOBAL');
    expect(r.remaining).toBe(0);
  });

  it('非 ASCII（汉字）同样按字节数读取：4 字符 = 8 字节', () => {
    const bytes = Buffer.from('八云 紫', 'utf16le'); // 含空格的 4 字符
    const r = new ByteReader(W.concat(new Uint8Array([bytes.length]), new Uint8Array(bytes)));
    expect(r.str()).toBe('八云 紫');
    expect(bytes.length).toBe(8);
  });

  it('空串（前缀 0）', () => {
    const r = new ByteReader(new Uint8Array([0x00, 0x2a]));
    expect(r.str()).toBe('');
    expect(r.byte()).toBe(0x2a);
  });

  it('多字节 7-bit 前缀（长度 200 → 0xC8 0x01）', () => {
    const payload = Buffer.alloc(200);
    for (let i = 0; i < 100; i++) payload.writeUInt16LE(0x41, i * 2); // 'A' × 100
    const r = new ByteReader(W.concat(new Uint8Array([0xc8, 0x01]), new Uint8Array(payload)));
    expect(r.str()).toBe('A'.repeat(100));
    expect(r.remaining).toBe(0);
  });

  it('奇数字节长度 → 抛错（流错位快速失败）', () => {
    const r = new ByteReader(new Uint8Array([0x03, 0x41, 0x00, 0x42]));
    expect(() => r.str()).toThrow(/奇数/);
    expect(() => r.str()).toThrow(ArchiveParseError);
  });

  it('长度越界 → 抛错（不静默读空）', () => {
    const r = new ByteReader(new Uint8Array([0x20, 0x41, 0x00])); // 声称 32 字节仅 3 字节
    expect(() => r.str()).toThrow(/越界/);
  });
});

describe('ByteReader 整数编码（m_ReadInt 镜像）', () => {
  it('≤ 0xCF 单字节直读', () => {
    const r = new ByteReader(new Uint8Array([0x2a]));
    expect(r.varInt()).toBe(42);
  });

  it('0xD0 → Int16（含负值）', () => {
    const r = new ByteReader(W.concat(new Uint8Array([0xd0]), new W().u16(-5).bytes()));
    expect(r.varInt()).toBe(-5);
  });

  it('0xD1 → Int32', () => {
    const r = new ByteReader(W.concat(new Uint8Array([0xd1]), new W().u32(70000).bytes()));
    expect(r.varInt()).toBe(70000);
  });

  it('0xD2 → Int64（大数正确）', () => {
    const r = new ByteReader(W.concat(new Uint8Array([0xd2]), new W().i64(5_174_634_124n).bytes()));
    expect(r.varInt()).toBe(5_174_634_124);
  });

  it('0xD2 超安全整数范围 → 近似 + 警告（不抛错、不静默）', () => {
    const r = new ByteReader(W.concat(new Uint8Array([0xd2]), new W().i64(1n << 60n).bytes()));
    expect(r.varInt()).toBe(Number(1n << 60n));
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('安全整数');
  });

  it('非法首字节（0xE0）→ 抛错', () => {
    const r = new ByteReader(new Uint8Array([0xe0]));
    expect(() => r.varInt()).toThrow(/非法首字节 0xe0/);
  });

  it('流耗尽后继续读 → 抛错（带偏移）', () => {
    const r = new ByteReader(new Uint8Array([]));
    expect(() => r.byte()).toThrow(/越界/);
  });

  it('int64 原语返回 bigint（保精度）', () => {
    const r = new ByteReader(new W().i64(9223372036854775807n).bytes());
    expect(r.int64()).toBe(9223372036854775807n);
  });
});

describe('ByteReader 游标推进', () => {
  it('混合读取后 offset / remaining 精确', () => {
    const bytes = W.concat(
      new W().str('AB').bytes(), // 1 字节前缀（4 字节数）+ 4 字节正文 = 5
      new Uint8Array([0x07]), // 1
      new W().str('').bytes(), // 1（前缀 0）
    );
    const r = new ByteReader(bytes);
    expect(r.str()).toBe('AB');
    expect(r.offset).toBe(5);
    expect(r.varInt()).toBe(7);
    expect(r.str()).toBe('');
    expect(r.offset).toBe(bytes.length);
    expect(r.remaining).toBe(0);
  });
});
