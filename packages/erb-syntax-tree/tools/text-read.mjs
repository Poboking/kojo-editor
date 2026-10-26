/**
 * text-read.mjs —— 语料读数工具的**统一取文口径**。
 *
 * 为什么需要：eraNTR 有 17 份 `.ERH` 是 **UTF-16LE + BOM**（`FF FE`）。宿主编辑器侧有完整
 * 编码探测（`FileEncoding` 五值：utf-8 / utf-8-bom / utf-16le / utf-16be / shift_jis），
 * 读数工具过去一律 `readFileSync(..., 'utf8')` —— 那 17 份量到的全是乱码：读数崩到
 * **4.7 万 ERROR**，而 A/B 两版都崩（与文法无关，纯工具口径错）。
 *
 * 这里只补 BOM 级判定（BOM 是确定性的，无需探测猜测）：UTF-8（含 BOM）原样返回，
 * BOM 由语法层 `\uFEFF` 的 extras 吸收；UTF-16 按字节序解码后返回纯文本。
 */
import { readFileSync } from 'node:fs';

/** 按 BOM 取文（UTF-8 / UTF-8-BOM 原样，UTF-16LE/BE 解码）。 */
export function readErbText(file) {
  const buf = readFileSync(file);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le', 2);
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // 奇数字节（截断文件）丢掉最后一个字节，否则 swap16 直接抛。
    const len = buf.length - 2 - ((buf.length - 2) % 2);
    const body = Buffer.from(buf.subarray(2, 2 + len));
    body.swap16();
    return body.toString('utf16le');
  }
  return buf.toString('utf8');
}
