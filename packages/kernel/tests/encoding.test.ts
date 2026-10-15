import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import type { FileEncoding } from '@kojo/plugin-api';
import { applyEol, decodeWithProbe, detectEol, isValidUtf8, normalizeEol, probeEncoding } from '../src/encoding';

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

/**
 * `decodeWithProbe`（2026-10-16 批量 IO 批）：一次解码同时得到 {text, encoding}，
 * 替代旧的"probeEncoding（全文 fatal 校验一遍）+ decode（全文再解一遍）"双重全量解码。
 *
 * 判据 = **对拍**：同一份字节下，新旧两条路径产出的 `{text, encoding}` 必须全等。
 * 旧路径按现行内核/桥口径复刻：`probeEncoding` → `TextDecoder(标签)`（node 桥与
 * tauri 桥的解码标签同表——utf-8-bom 与 utf-8 同走 'utf-8'）。
 */
describe('decodeWithProbe 与旧路径对拍（编码+文本全等）', () => {
  /** 旧读路径的解码标签（NodeBridge / tauri-bridge 的 DECODE_LABEL 同表） */
  const decodeLabel = (e: FileEncoding): string => (e === 'utf-8-bom' ? 'utf-8' : e);
  const oldPath = (bytes: Uint8Array): { text: string; encoding: FileEncoding } => {
    const encoding = probeEncoding(bytes);
    return { text: new TextDecoder(decodeLabel(encoding)).decode(bytes), encoding };
  };

  const utf8Body = '@M_KOJO_K1\nPRINTL 你好，世界\nCFLAG:2 = 10\n';
  const cases: Array<{ name: string; bytes: Uint8Array }> = [
    { name: 'UTF-8 无 BOM（多字节）', bytes: enc.encode(utf8Body) },
    {
      name: 'UTF-8-BOM（剥 BOM 语义在两条路径上一致）',
      bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode(utf8Body)]),
    },
    { name: '纯 ASCII', bytes: enc.encode('@FOO\nRETURN 1\n') },
    { name: '空文件', bytes: new Uint8Array([]) },
    { name: '仅 UTF-8 BOM（裸 3 字节）', bytes: new Uint8Array([0xef, 0xbb, 0xbf]) },
    { name: '混合换行（\r\n 与 \n 混排，探测与解码语义不掺和）', bytes: enc.encode('a\r\nb\nc\r\n') },
    { name: 'Shift-JIS（非法 UTF-8 序列 ⇒ 兜底分支）', bytes: new Uint8Array(iconv.encode('@K\nPRINTFORML 「こんにちは」\r\n', 'shift_jis')) },
    {
      name: 'Shift-JIS 含半角片假名',
      bytes: new Uint8Array(iconv.encode('ﾌｫﾙﾑ ﾃｽﾄ\n', 'shift_jis')),
    },
    {
      name: 'UTF-16LE（带 BOM）',
      bytes: new Uint8Array(iconv.encode('\uFEFF@U\nPRINTL 世界\n', 'utf-16le')),
    },
    {
      name: 'UTF-16BE（带 BOM）',
      bytes: new Uint8Array(iconv.encode('\uFEFF@U\nPRINTL 世界\n', 'utf-16be')),
    },
    { name: '残缺多字节序列（fatal 校验必须判失败 ⇒ 兜底）', bytes: new Uint8Array([0xe3, 0x81]) },
    { name: '高位字节孤例（0xFF，两条路径都走兜底）', bytes: new Uint8Array([0x41, 0xff, 0x42]) },
  ];

  for (const c of cases) {
    it(`${c.name}：{text, encoding} 与 probeEncoding+decode 全等`, () => {
      const old = oldPath(c.bytes);
      const got = decodeWithProbe(c.bytes);
      expect(got.encoding).toBe(old.encoding);
      expect(got.text).toBe(old.text);
    });
  }

  it('utf-8-bom 分支：BOM 不进入文本（与 sort 后的现有读路径行为一致）', () => {
    const got = decodeWithProbe(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]));
    expect(got.encoding).toBe('utf-8-bom');
    expect(got.text).toBe('A');
    expect(got.text).not.toContain('\uFEFF');
  });

  it('utf-16 分支：BOM 由解码器剥掉（读侧不在文本里看见 \\uFEFF）', () => {
    expect(decodeWithProbe(new Uint8Array(iconv.encode('\uFEFFAB', 'utf-16le')))).toEqual({
      text: 'AB',
      encoding: 'utf-16le',
    });
    expect(decodeWithProbe(new Uint8Array(iconv.encode('\uFEFFAB', 'utf-16be')))).toEqual({
      text: 'AB',
      encoding: 'utf-16be',
    });
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
