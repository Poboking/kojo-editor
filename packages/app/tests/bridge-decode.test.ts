/**
 * 桌面桥的解码语义（IMPLEMENTATION-LOG §5.91：读路径不再把整份字节送回 Rust 解码）。
 *
 * 这里能测的部分是「客户端解码本身」——它已不依赖 Tauri 运行时；
 * 而「与 Rust `encoding_rs` 是否等价」测不了（vitest 里没有 Rust 侧），
 * 那一半由真实 app 内的对照探针背书（同节记录：真实语料 114 文件逐字符相同 +
 * 16 例合成边界 15 例相同，唯一分叉的输入被下面的「不可达」用例钉住）。
 */
import { isValidUtf8, probeEncoding } from '@kojo/kernel';
import type { FileEncoding } from '@kojo/plugin-api';
import { describe, expect, it } from 'vitest';
import { DECODE_LABEL, tauriBridge } from '../src/bridge/tauri-bridge';

const ALL: FileEncoding[] = ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'shift_jis'];

describe('桌面桥解码（客户端 TextDecoder）', () => {
  it('标签表覆盖 FileEncoding 全部取值，且每个标签都能构造 TextDecoder', () => {
    expect(Object.keys(DECODE_LABEL).sort()).toEqual([...ALL].sort());
    for (const enc of ALL) {
      const label = DECODE_LABEL[enc];
      expect(() => new TextDecoder(label)).not.toThrow();
    }
  });

  it('utf-8-bom 剥前导 BOM，正文逐字保留（与 Rust 侧 encoding_rs 同口径）', async () => {
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

  /**
   * 钉住「唯一分叉不可达」：`[0xFF,0xFE,0x41]` 这串畸形字节按 `utf-8` 标签解时，
   * TextDecoder 给两个 U+FFFD + `A`，Rust 的 `encoding_rs` 只给一个 U+FFFD（真实 app 内实测的
   * 唯一不一致）。而读路径的标签由 `probeEncoding` 决定——它要把字节打成 `utf-8` 必须先过
   * `isValidUtf8`，这串字节过不了（它带 UTF-16LE BOM，直接落进 `utf-16le` 桶）⇒
   * **按 `utf-8` 标签喂非法字节这条路根本不存在**，可达桶两侧的语义由上面的用例逐字钉住。
   */
  it('非法 UTF-8 字节不会被标成 utf-8 ⇒ 两侧唯一的语义分叉在读取路径上不可达', () => {
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
