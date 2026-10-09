import { describe, expect, it } from 'vitest';
import { applyEol, detectEol, isValidUtf8, normalizeEol, probeEncoding } from '../src/encoding';

const enc = new TextEncoder();

describe('编码探测', () => {
  it('UTF-8 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('口上')]);
    expect(probeEncoding(bytes)).toBe('utf-8-bom');
  });

  it('UTF-16 LE / BE BOM', () => {
    expect(probeEncoding(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toBe('utf-16le');
    expect(probeEncoding(new Uint8Array([0xfe, 0xff, 0x00, 0x41]))).toBe('utf-16be');
  });

  it('无 BOM 的 UTF-8（含多字节）', () => {
    expect(probeEncoding(enc.encode('こんにちは、世界'))).toBe('utf-8');
  });

  it('纯 ASCII → utf-8（等价安全）', () => {
    expect(probeEncoding(enc.encode('@M_KOJO_K1_EVENT\nPRINTL foo'))).toBe('utf-8');
  });

  it('Shift-JIS 字节（非法 UTF-8 序列）', () => {
    // あいう in Shift-JIS
    const sjis = new Uint8Array([0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4]);
    expect(probeEncoding(sjis)).toBe('shift_jis');
  });

  it('isValidUtf8 对残缺多字节序列判 false', () => {
    expect(isValidUtf8(new Uint8Array([0xe3, 0x81]))).toBe(false);
    expect(isValidUtf8(enc.encode('正常'))).toBe(true);
    expect(isValidUtf8(new Uint8Array([]))).toBe(true);
  });
});

describe('换行处理', () => {
  it('探测 crlf / lf（多数派）', () => {
    expect(detectEol('a\r\nb\r\nc\r\n')).toBe('crlf');
    expect(detectEol('a\nb\nc\n')).toBe('lf');
    expect(detectEol('a\r\nb\nc\r\n')).toBe('crlf'); // 2 crlf vs 1 lf
    expect(detectEol('no newline')).toBe('lf');
  });

  it('归一化与还原', () => {
    expect(normalizeEol('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
    expect(applyEol('a\nb', 'crlf')).toBe('a\r\nb');
    expect(applyEol('a\nb', 'lf')).toBe('a\nb');
  });

  it('往返：混合换行归一化后再按 crlf 还原是纯 crlf', () => {
    const mixed = 'x\r\ny\nz\r\n';
    expect(applyEol(normalizeEol(mixed), 'crlf')).toBe('x\r\ny\r\nz\r\n');
  });
});
