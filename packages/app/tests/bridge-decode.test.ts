/**
 * 桌面桥的解码语义（IMPLEMENTATION-LOG §5.91：读路径不再把整份字节送回 Rust 解码）。
 *
 * W12 ENC-SRC 后的地位：Rust 侧对照命令 `decode_bytes`（当年验"客户端 TextDecoder vs
 * encoding_rs"等价性的探针）已删——判序与 fatal/替换策略合一进 `DECODE_PROBE_POLICY`
 * 共享常量表，检索侧由 `utf8_decode_whatwg` 与 TextDecoder 逐字节对齐。本文件钉 Tauri 桥
 * 这一侧：①标签表 = `@kojo/plugin-api` 单源（node 桥 import 同一常量，两桥同形在构造上
 * 成立——PITFALLS 73 的解码侧对应物）；②同一组跨语言 GOLDEN 样本（与
 * `packages/kernel/tests/encoding-decode-policy.test.ts` 和 Rust `search_tests.rs` 同表）
 * 下 `tauriBridge.decode` 与内核 `decodeWithProbe` 逐字一致。
 */
import { decodeWithProbe, isValidUtf8, probeEncoding } from '@kojo/kernel';
import { DECODE_LABEL, type FileEncoding } from '@kojo/plugin-api';
import { describe, expect, it } from 'vitest';
import { tauriBridge } from '../src/bridge/tauri-bridge';

const ALL: FileEncoding[] = ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'shift_jis', 'gbk', 'gb18030', 'big5'];

const hex = (s: string): Uint8Array =>
  Uint8Array.from((s.match(/\s*[0-9A-Fa-f]{2}/g) ?? []).map((x) => parseInt(x.trim(), 16)));

describe('桌面桥解码（客户端 TextDecoder，单源标签表）', () => {
  it('标签表覆盖 FileEncoding 全部取值，且每个标签都能构造 TextDecoder', () => {
    expect(Object.keys(DECODE_LABEL).sort()).toEqual([...ALL].sort());
    for (const enc of ALL) {
      const label = DECODE_LABEL[enc];
      expect(() => new TextDecoder(label)).not.toThrow();
    }
  });

  it('utf-8-bom 剥前导 BOM，正文逐字保留（与 Rust 侧同判据）', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x42, 0x0a]);
    expect(await tauriBridge.decode(bytes, 'utf-8-bom')).toBe('AB\n');
    // 无 BOM 时不该多吃一个字符
    expect(await tauriBridge.decode(new Uint8Array([0x41, 0x42]), 'utf-8')).toBe('AB');
  });

  it('utf-16le / utf-16be 的 BOM 与代理对', async () => {
    expect(await tauriBridge.decode(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]), 'utf-16le')).toBe('AB');
    expect(await tauriBridge.decode(new Uint8Array([0xfe, 0xff, 0x00, 0x41, 0xd8, 0x3d, 0xde, 0x00]), 'utf-16be')).toBe('A😀');
  });

  it('shift_jis 解全角/半角混排（含 0xA1-0xDF 半角 kana 区与制表符）', async () => {
    const bytes = new Uint8Array([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xa2, 0x82, 0x94, 0x09, 0xa1, 0xb3, 0xdf]);
    expect(await tauriBridge.decode(bytes, 'shift_jis')).toBe('こんいｔ\t｡ｳﾟ');
  });

  it('gbk / gb18030 / big5 中文解码（2026-10-17 编码标签批；WHATWG 标签，与 encoding_rs 同表）', async () => {
    // C4E3 BAC3 = 你好（GBK/GB18030）；A741 A66E = 你好（Big5）
    expect(await tauriBridge.decode(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]), 'gbk')).toBe('你好');
    expect(await tauriBridge.decode(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]), 'gb18030')).toBe('你好');
    expect(await tauriBridge.decode(new Uint8Array([0xa7, 0x41, 0xa6, 0x6e]), 'big5')).toBe('你好');
  });
  /** 跨语言 GOLDEN（子集，按本桥已知的标签解码语义钉文本；全表 + 期望编码在内核对拍文件钉） */
  const GOLDEN: Array<{ name: string; bytes: Uint8Array; text: string }> = [
    { name: 'UTF-8 BOM 合法正文', bytes: hex('EF BB BF 61 62'), text: 'ab' },
    { name: 'UTF-8 BOM + 非法字节连跑（旧对照探针的唯一分叉桶）', bytes: hex('EF BB BF FF FE 41'), text: '\uFFFD\uFFFDA' },
    { name: 'UTF-16 LE 奇数尾字节', bytes: hex('FF FE 61'), text: '\uFFFD' },
    { name: 'UTF-16 BE 代理对', bytes: hex('FE FF D8 3D DE 00'), text: '\u{1F600}' },
    { name: 'Shift-JIS 中孤立非法字节', bytes: hex('41 FF 42'), text: 'A\uFFFDB' },
    { name: 'Shift-JIS 引导字节截断在流尾', bytes: hex('82'), text: '\uFFFD' },
  ];

  for (const g of GOLDEN) {
    it(`桥 decode = 内核 decodeWithProbe：${g.name}`, async () => {
      const encoding = probeEncoding(g.bytes);
      expect(await tauriBridge.decode(g.bytes, encoding)).toBe(g.text);
      expect(decodeWithProbe(g.bytes).text).toBe(g.text);
    });
  }

  /**
   * 可达性守门（保留）：读路径的标签由 `probeEncoding` 决定——表里没有 BOM 的非法字节流
   * 永远拿不到 `utf-8` 标签（先落 utf-16 BOM 桶或 SJIS 兜底），所以"按 utf-8 标签喂非法
   * 字节"只在**显式指定编码**时可达；该桶两侧语义由上面 GOLDEN 与 Rust `utf8_decode_whatwg`
   * 逐字钉住（§5.90 时代的"唯一分叉"已消除，不再是不可达托辞）。
   */
  it('非法 UTF-8 字节不会被标成 utf-8 ⇒ 判序表是唯一的桶分配者', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x41]);
    expect(isValidUtf8(bytes)).toBe(false);
    const picked = probeEncoding(bytes);
    expect(picked).not.toBe('utf-8');
    expect(picked).not.toBe('utf-8-bom');
    expect(picked).toBe('utf-16le');
    // 合法 UTF-8 才可能拿到 utf-8 标签（该桶两侧已逐字符核对：真实语料 114 文件 + 合成样例）
    expect(probeEncoding(new Uint8Array([0xe6, 0x97, 0xa5, 0xe6, 0x9c, 0xac]))).toBe('utf-8');
  });
});
