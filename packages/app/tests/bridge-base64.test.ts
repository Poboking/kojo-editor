/**
 * base64 编解码的等价性（P0-2 批：把"快照落盘 48MB 的编码"从 2,473ms 压下去）。
 *
 * 换实现的唯一约束是**逐字节同输出**：`write_file_bytes` 只收 base64 字符串，
 * Rust 侧照 `STANDARD` 表解码，任何一位不同都会写坏盘上文件。
 * 故这里钉三件事：
 * 1. 回退路径（`encodeBase64Table`）与 `btoa` 的参考实现逐字符相等（含 0x80–0xFF）；
 * 2. 生产入口 `bytesToBase64` 走原生还是回退，输出都与参考实现相等（原生只在
 *    Chromium 133+ 有，node/vitest 里通常没有 ⇒ 这条同时守"两条路同结果"）；
 * 3. 往返可逆 + 三种补位长度（0/1/2 余数）都对。
 */
import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, encodeBase64Table } from '../src/bridge/invoke';

/** 参考实现：旧写法（`btoa` + 二进制串）——它才是"口径真源"，不是被优化的对象 */
const reference = (bytes: Uint8Array): string => {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
};

/** 确定性伪随机字节（覆盖 0x00–0xFF 全值域，含 base64 边界 0x80） */
const bytesOf = (n: number, seed = 1): Uint8Array => {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s & 0xff;
  }
  return out;
};

describe('bridge/invoke · base64（换实现不换口径）', () => {
  it('回退编码器与 btoa 参考实现逐字符相等（0..96 全长度 + 全值域字节）', () => {
    for (let n = 0; n <= 96; n++) {
      const bytes = bytesOf(n, n + 1);
      expect(encodeBase64Table(bytes), `n=${n}`).toBe(reference(bytes));
    }
    // 覆盖 0x00/0x7F/0x80/0xFF 四个边界值（0x80 是"latin1 映射"类实现最容易错的地方）
    const edges = new Uint8Array([0x00, 0x7f, 0x80, 0xff, 0x00, 0x80]);
    expect(encodeBase64Table(edges)).toBe(reference(edges));
  });

  it('生产入口（原生或回退）输出与参考实现相等，且往返可逆', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 1023, 1024, 1025, 100_000]) {
      const bytes = bytesOf(n, 7);
      const b64 = bytesToBase64(bytes);
      expect(b64, `n=${n}`).toBe(reference(bytes));
      expect([...base64ToBytes(b64)], `roundtrip n=${n}`).toEqual([...bytes]);
    }
  });

  it('补位形态：余 1 补 `==`、余 2 补 `=`、整三无补位', () => {
    expect(bytesToBase64(new Uint8Array([0x41]))).toBe('QQ==');
    expect(bytesToBase64(new Uint8Array([0x41, 0x42]))).toBe('QUI=');
    expect(bytesToBase64(new Uint8Array([0x41, 0x42, 0x43]))).toBe('QUJD');
  });
});
