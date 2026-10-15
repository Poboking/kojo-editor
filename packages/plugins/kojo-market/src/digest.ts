/**
 * 校验锚：SHA-256。
 *
 * **全仓唯一一份实现**（守门测试 `tests/single-source.test.ts` 断言这一点）。
 * 只准用 `crypto.subtle`——`plugin-api/fingerprint.ts` 的 `stableHash`/`foldDigest`
 * 是**非密码学**哈希（FNV 折叠，14 位十六进制），拿来当校验锚等于没有校验。
 */

import type { PackFileEntry } from '@kojo/plugin-api';

/** 最小结构面（本包不在 DOM lib 下编译，故不引 `SubtleCrypto` 类型名） */
interface SubtleLike {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}
interface CryptoLike {
  subtle?: SubtleLike;
}

function subtle(): SubtleLike {
  const s = (globalThis as { crypto?: CryptoLike }).crypto?.subtle;
  if (s === undefined || typeof s.digest !== 'function') {
    throw new Error('市场校验锚不可用：本平台没有 crypto.subtle（WebCrypto）');
  }
  return s;
}

const HEX = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 0xf]!;
  return out;
}

/** 字节 → 64 位小写十六进制 sha256 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await subtle().digest('SHA-256', bytes)));
}

/**
 * UTF-8 字符串 → 字节（只用 `String` 级操作，不依赖 `TextEncoder` 全局——
 * 本包要在 Node 测试与 WebView 两种环境下同一份代码跑）。
 */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.codePointAt(i)!;
    if (cp > 0xffff) i++; // 代理对只算一次
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(
      0xf0 | (cp >> 18),
      0x80 | ((cp >> 12) & 0x3f),
      0x80 | ((cp >> 6) & 0x3f),
      0x80 | (cp & 0x3f),
    );
  }
  return Uint8Array.from(out);
}

/**
 * 逐文件锚的**折叠摘要**（本地目录源没有 zip 容器，`InstalledPack.zipSha256` 存这个）。
 *
 * 口径钉死，别改：条目按 `path` 字典序排，每行 `${path}\u0000${sha256}`，
 * 行内以 `\u0001` 连接后整体 UTF-8 编码，再做一次 SHA-256。
 * 同法在任何机器上都能从 `files[]` 复算，故它不是"新造的权威"，只是逐文件锚的指纹。
 */
export async function contentDigestOf(files: readonly PackFileEntry[]): Promise<string> {
  const folded = [...files]
    .map((f) => `${f.path}\u0000${f.sha256}`)
    .sort()
    .join('\u0001');
  return sha256Hex(utf8Bytes(folded));
}
