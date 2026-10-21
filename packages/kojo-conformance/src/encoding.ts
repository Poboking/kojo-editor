/**
 * Conformance kit · 编码 / EOL 取证（纯函数，零 IO）。
 *
 * 口径与 core 的 `EncodingPolicy` 对齐（设计稿 §10.4 / §10.9）：
 * - 编码按**文件**保留：UTF-8（无 BOM）/ UTF-8 BOM / UTF-16LE BOM；
 * - EOL 只记事实，不归一化；`mixed` 必须能被识别出来（保存时不得全仓归一化）；
 * - 本模块只做"字节 ⇄ 文本"的确定性换算与读数，不读盘、不碰宿主。
 *
 * 为什么手写 UTF-16LE：kit 要能在 Node / 浏览器测试里同样跑，不引 `Buffer`
 * （`TextEncoder` 只支持 UTF-8）。UTF-16 码元直接按 2 字节小端写，代理对天然正确。
 */
import type { EolPolicy, TextEncoding } from '@kojo/kojo-core';

/** EOL 读数（比 `EolPolicy` 多一个 `none`：空文件/单行文件没有换行可谈） */
export type ConformanceEol = 'crlf' | 'lf' | 'mixed' | 'none';

/** 写盘目标形状（BOM 由 encoding 本身决定，不再单列布尔） */
export interface ConformanceTextShape {
  readonly encoding: TextEncoding;
  readonly eol: 'crlf' | 'lf';
  /** 补一个末尾换行（已有换行不重复补；空文本不补） */
  readonly trailingNewline: boolean;
}

/** 解码读数：encoding 已含 BOM 事实，`bom` 是给报告看的冗余读数 */
export interface DecodedConformanceText {
  readonly text: string;
  readonly encoding: TextEncoding;
  readonly eol: ConformanceEol;
  readonly bom: boolean;
}

const BOM_UTF8: readonly number[] = Object.freeze([0xef, 0xbb, 0xbf]);
const BOM_UTF16LE: readonly number[] = Object.freeze([0xff, 0xfe]);

/** 判断一个字符串是否是契约里的编码名（运行时输入守卫用） */
export function isTextEncoding(value: string): value is TextEncoding {
  return value === 'utf-8' || value === 'utf-8-bom' || value === 'utf-16le-bom';
}

/** 判断 EOL 读数是否合法 */
export function isConformanceEol(value: string): value is ConformanceEol {
  return value === 'crlf' || value === 'lf' || value === 'mixed' || value === 'none';
}

/** 把任意 EOL 归一成 `\n`（只用于比较/再编码，不用于写回源文件） */
export function normalizeEolToLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** EOL 读数：三种换行分别计数；只要有混用就是 `mixed`，没有换行是 `none` */
export function detectEol(text: string): ConformanceEol {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) {
      if (i > 0 && text.charCodeAt(i - 1) === 0x0d) crlf++;
      else lf++;
    } else if (code === 0x0d) {
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 0x0a) continue;
      cr++;
    }
  }
  if (crlf === 0 && lf === 0 && cr === 0) return 'none';
  if (crlf > 0 && lf === 0 && cr === 0) return 'crlf';
  if (lf > 0 && crlf === 0 && cr === 0) return 'lf';
  return 'mixed';
}

/** adapter 的 EOL 策略是否接受某个读数（`mixed` 接受一切；`none` 不违反任何策略） */
export function eolPolicyAccepts(policy: EolPolicy, eol: ConformanceEol): boolean {
  if (eol === 'none' || policy === 'mixed') return true;
  return policy === eol;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/** 每个 UTF-16 码元写 2 字节小端 */
function encodeUtf16Le(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[i * 2] = code & 0xff;
    out[i * 2 + 1] = code >>> 8;
  }
  return out;
}

function decodeUtf16Le(bytes: Uint8Array): string {
  if (bytes.length % 2 !== 0) {
    throw new TypeError(`UTF-16LE 字节数必须是偶数（收到 ${bytes.length} 字节）`);
  }
  const units: number[] = [];
  for (let i = 0; i < bytes.length; i += 2) {
    units.push((bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8));
  }
  let out = '';
  const CHUNK = 0x1000;
  for (let i = 0; i < units.length; i += CHUNK) {
    out += String.fromCharCode(...units.slice(i, i + CHUNK));
  }
  return out;
}

function concatBytes(prefix: readonly number[], body: Uint8Array): Uint8Array {
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

/** 探测编码（只认契约里的三种；非法 UTF-8 返回 null，不猜 GBK 一类） */
export function detectTextEncoding(bytes: Uint8Array): TextEncoding | null {
  if (startsWith(bytes, BOM_UTF16LE)) return 'utf-16le-bom';
  if (startsWith(bytes, BOM_UTF8)) return 'utf-8-bom';
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    decoder.decode(bytes);
    return 'utf-8';
  } catch {
    return null;
  }
}

/** 文本 → 字节，**EOL 原样保留**（round-trip 取证用；不归一、不补末尾换行） */
export function encodeConformanceTextPreservingEol(text: string, encoding: TextEncoding): Uint8Array {
  switch (encoding) {
    case 'utf-8':
      return new TextEncoder().encode(text);
    case 'utf-8-bom':
      return concatBytes(BOM_UTF8, new TextEncoder().encode(text));
    case 'utf-16le-bom':
      return concatBytes(BOM_UTF16LE, encodeUtf16Le(text));
    default: {
      const exhaustive: never = encoding;
      throw new TypeError(`未知编码：${String(exhaustive)}`);
    }
  }
}

/**
 * 文本 → 字节（确定性换算）。
 *
 * 先归一 `\n`，再按目标 EOL 展开；`utf-8-bom` / `utf-16le-bom` 自动带 BOM。
 * 不写盘、不改源文本。
 */
export function encodeConformanceText(text: string, shape: ConformanceTextShape): Uint8Array {
  if (!isTextEncoding(shape.encoding)) {
    throw new TypeError(`未知编码：${shape.encoding}`);
  }
  if (shape.eol !== 'crlf' && shape.eol !== 'lf') {
    throw new TypeError(`未知 EOL：${shape.eol}`);
  }
  const normalized = normalizeEolToLf(text);
  const eol = shape.eol === 'crlf' ? '\r\n' : '\n';
  let body = shape.eol === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized;
  if (shape.trailingNewline && body.length > 0 && !body.endsWith(eol)) {
    body += eol;
  }
  return encodeConformanceTextPreservingEol(body, shape.encoding);
}

/**
 * 字节 → 文本 + 编码/EOL 读数。
 *
 * BOM 会被剥掉（`text` 不含 BOM）；非法字节抛 `TypeError`，不静默替换。
 */
export function decodeConformanceText(bytes: Uint8Array): DecodedConformanceText {
  if (startsWith(bytes, BOM_UTF16LE)) {
    const text = decodeUtf16Le(bytes.subarray(BOM_UTF16LE.length));
    return { text, encoding: 'utf-16le-bom', eol: detectEol(text), bom: true };
  }
  if (startsWith(bytes, BOM_UTF8)) {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(BOM_UTF8.length),
    );
    return { text, encoding: 'utf-8-bom', eol: detectEol(text), bom: true };
  }
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return { text, encoding: 'utf-8', eol: detectEol(text), bom: false };
}

/** 产物末尾是否恰好以换行收尾（空串 = false） */
export function hasTrailingEol(text: string): boolean {
  return text.endsWith('\n') || text.endsWith('\r');
}
