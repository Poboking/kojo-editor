/**
 * 口上 XML 的编码探测与解码。
 *
 * 为什么 BOM 必须压过 XML 声明：eraFL 语料里有 9 份口上 XML 是 **UTF-16LE + BOM，
 * 但声明写的是 `encoding="utf-8"`**。按声明解会得到一串 U+FFFD（整份读不出来），
 * 只有先看前两字节才读得对。BOM 是字节层面的事实，声明只是作者手写的一行文本，
 * 冲突时事实优先——这也是 XML 规范自己的口径（附录 F：BOM 存在时以 BOM 为准）。
 *
 * 为什么不用 `readText` 那套内核探测：内核的 `FileEncoding` 面还带着 shift_jis / gbk
 * 等候选，对"口上 XML 只可能是 UTF-8 家族或 UTF-16"这个封闭场景是多余猜测；
 * 而猜错一次的代价是整份文件变成乱码。这里只认 BOM + 默认 UTF-8，判据唯一。
 */

import type { KojoXmlEncoding } from '@kojo/plugin-api';

/** UTF-8 BOM（EF BB BF） */
const BOM_UTF8 = [0xef, 0xbb, 0xbf] as const;
/** UTF-16LE BOM（FF FE） */
const BOM_UTF16LE = [0xff, 0xfe] as const;
/** UTF-16BE BOM（FE FF） */
const BOM_UTF16BE = [0xfe, 0xff] as const;

function startsWith(bytes: Uint8Array, bom: readonly number[]): boolean {
  if (bytes.length < bom.length) return false;
  for (let i = 0; i < bom.length; i++) {
    if (bytes[i] !== bom[i]) return false;
  }
  return true;
}

/**
 * 探测编码。BOM 优先，无 BOM 一律按 UTF-8（本语料的实际分布只有这四种）。
 *
 * `utf-16le` / `utf-16be` 只认 BOM：无 BOM 的 UTF-16 在 XML 里本就非法，
 * 硬猜会把一份正常的 UTF-8 文件解成"每两字节一个汉字"的垃圾，代价远大于收益。
 */
export function detectKojoXmlEncoding(bytes: Uint8Array): {
  encoding: KojoXmlEncoding;
  hasBom: boolean;
} {
  // FF FE 00 00 是 UTF-32LE 的 BOM，不能当 UTF-16LE 吃掉；语料里没有，但判据要写对
  if (startsWith(bytes, BOM_UTF16LE) && !(bytes.length >= 4 && bytes[2] === 0 && bytes[3] === 0)) {
    return { encoding: 'utf-16le', hasBom: true };
  }
  if (startsWith(bytes, BOM_UTF16BE)) {
    return { encoding: 'utf-16be', hasBom: true };
  }
  if (startsWith(bytes, BOM_UTF8)) {
    return { encoding: 'utf-8-bom', hasBom: true };
  }
  return { encoding: 'utf-8', hasBom: false };
}

/**
 * 解码字节 → 文本。返回的 `text` **不含 BOM**（BOM 是容器信息，不该混进正文，
 * 否则第一行的列号会整体偏移 1，所有 span 都错位）。
 *
 * UTF-16 走 `TextDecoder`（Node 与浏览器都有，且比手写码元拼接更稳）；
 * 截断的奇数长度尾字节由解码器按 U+FFFD 处理，不抛异常。
 */
export function decodeKojoXmlBytes(bytes: Uint8Array): {
  text: string;
  encoding: KojoXmlEncoding;
} {
  const { encoding } = detectKojoXmlEncoding(bytes);
  switch (encoding) {
    case 'utf-16le':
      return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding };
    case 'utf-16be':
      return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding };
    case 'utf-8-bom':
      return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding };
    case 'utf-8':
      return { text: new TextDecoder('utf-8').decode(bytes), encoding };
  }
}
