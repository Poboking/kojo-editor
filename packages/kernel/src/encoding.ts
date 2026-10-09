import type { FileEncoding } from '@kojo/plugin-api';

/**
 * 编码探测与换行处理。
 *
 * 背景（逆向文档实测）：
 * - ERB / CSV 生态极其混杂：Shift-JIS（日文原版）、UTF-8-BOM（汉化版）、UTF-16（罕见）；
 * - 引擎自身 DetectEncoding 存在已知 bug（Process.cs:589 错误回读 CSV 行时误用 ErbDir），
 *   编辑器必须自行做正确探测 + 写回保持，否则一次保存就毁半库文件。
 */

const BOM_UTF8 = [0xef, 0xbb, 0xbf] as const;
const BOM_UTF16_LE = [0xff, 0xfe] as const;
const BOM_UTF16_BE = [0xfe, 0xff] as const;

/** UTF-8 严格校验（无 BOM 场景判定 UTF-8 vs Shift-JIS） */
export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * 探测编码。
 * 判定顺序：BOM → UTF-8 合法性 → 兜底 Shift-JIS（eramaker 生态事实标准）。
 * 纯 ASCII 文件会命中 'utf-8'（等价安全：ASCII 是 UTF-8 子集，也会是 Shift-JIS 子集）。
 */
export function probeEncoding(bytes: Uint8Array): FileEncoding {
  if (bytes.length >= 3 && bytes[0] === BOM_UTF8[0] && bytes[1] === BOM_UTF8[1] && bytes[2] === BOM_UTF8[2]) {
    return 'utf-8-bom';
  }
  if (bytes.length >= 2 && bytes[0] === BOM_UTF16_LE[0] && bytes[1] === BOM_UTF16_LE[1]) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === BOM_UTF16_BE[0] && bytes[1] === BOM_UTF16_BE[1]) return 'utf-16be';
  if (isValidUtf8(bytes)) return 'utf-8';
  return 'shift_jis';
}

export type EolStyle = 'crlf' | 'lf';

/** 探测换行风格（多数派投票；无换行时默认 lf） */
export function detectEol(text: string): EolStyle {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13 /* \r */) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      }
      // 孤立 \r（旧 Mac）忽略计数
    } else if (c === 10 /* \n */) {
      lf++;
    }
  }
  return crlf > lf ? 'crlf' : 'lf';
}

/** 归一化为内部表示（\n） */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** 写出时应用目标换行风格 */
export function applyEol(text: string, eol: EolStyle): string {
  return eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
}
