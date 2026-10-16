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
 * 判定顺序：BOM → UTF-8 合法性 → 中日韩三族评分（shift_jis / gbk / big5）→ 兜底 shift_jis。
 * 纯 ASCII 文件会命中 'utf-8'（等价安全：ASCII 是 UTF-8 子集，也会是 Shift-JIS 子集）。
 *
 * 三族评分（2026-10-17 编码标签批）：GBK/Big5 无 BOM 中文文件的字节序列**大多也是合法
 * Shift-JIS**（高位单字节 + 高位对都碰得上），旧口径一律兜底成 shift_jis 后，
 * "编辑一次再保存"就走 SJIS 解码→重编码，简中/繁中字节当场毁掉。评分从解码文本的
 * 字符类别取证（见 {@link probeLegacyCjk}），零编辑场景另有 io 层逐字节直写快道兜住。
 *
 * 注意：读路径（`readText` / `readTexts`）已改走 `decodeWithProbe`（一次解码同时得到
 * 文本与编码，省掉"先全文校验一遍、再全文解码一遍"的双重成本）；
 * 本函数保留给**写路径**（`probeOnDisk`）与其它需要"只要编码判据"的调用方。
 */
export function probeEncoding(bytes: Uint8Array): FileEncoding {
  if (bytes.length >= 3 && bytes[0] === BOM_UTF8[0] && bytes[1] === BOM_UTF8[1] && bytes[2] === BOM_UTF8[2]) {
    return 'utf-8-bom';
  }
  if (bytes.length >= 2 && bytes[0] === BOM_UTF16_LE[0] && bytes[1] === BOM_UTF16_LE[1]) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === BOM_UTF16_BE[0] && bytes[1] === BOM_UTF16_BE[1]) return 'utf-16be';
  if (isValidUtf8(bytes)) return 'utf-8';
  return probeLegacyCjk(bytes).encoding;
}

/**
 * 族评分（**与 Rust 宿主 `cjk_family_score` 逐条一致**，检索预览与编辑器必须看到同一文本）：
 * CJK 统一表意文字、中日韩标点/全角形式各记 1 分；假名（平假名/片假名/长音符）是
 * 日文的独有证据、只计入 shift_jis 族、记 2 分；ASCII 与替换字符 U+FFFD 不计。
 * 半角片假名区间（U+FF61–U+FF9F）**故意不计**——GBK 中文按 SJIS 解出来的典型垃圾正是它。
 */
function scoreLegacyFamily(text: string, isShiftJis: boolean): number {
  let score = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80 || cp === 0xfffd) continue;
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3000 && cp <= 0x303f) ||
      (cp >= 0xff01 && cp <= 0xff60)
    ) {
      score += 1;
    } else if (
      isShiftJis &&
      ((cp >= 0x3041 && cp <= 0x3096) || (cp >= 0x30a1 && cp <= 0x30fa) || cp === 0x30fc)
    ) {
      score += 2;
    }
  }
  return score;
}

/**
 * 非 UTF-8 的三族裁决：shift_jis / gbk / big5 各做**非严格**全量解码并评分。
 * 规则（确定性，两侧同序：sjis → gbk → big5，平局归先者）：
 * - 基准 = shift_jis 的分数（哪怕它含替换字符——旧口径本就兜底到它，垃圾文件维持原判）；
 * - gbk / big5 只有**全文件零替换字符**（该族严格无损解得动）且分数**严格大于**当前最好者才上位；
 * - 三族都是 0 分（纯高位垃圾）⇒ 落回 shift_jis，与旧行为逐字节一致。
 * 代价：仅非 UTF-8 文件多两遍解码——语料实测 UTF-8 族占绝对多数，批量路径不受影响。
 * gb18030 不参与探测（GBK 严格超集、常用区字节同形），探测产出 `gbk` 即安全往返。
 */
function probeLegacyCjk(bytes: Uint8Array): { encoding: FileEncoding; text: string } {
  const sjisText = new TextDecoder('shift_jis').decode(bytes);
  let best = {
    encoding: 'shift_jis' as FileEncoding,
    text: sjisText,
    score: scoreLegacyFamily(sjisText, true),
  };
  for (const label of ['gbk', 'big5'] as const) {
    const text = new TextDecoder(label).decode(bytes);
    if (text.includes('\uFFFD')) continue; // 该族解不干净 ⇒ 直接失去资格
    const score = scoreLegacyFamily(text, false);
    if (score > best.score) best = { encoding: label, text, score };
  }
  return { encoding: best.encoding, text: best.text };
}

/** `decodeWithProbe` 的产物：文本（未剥换行，未归一化）+ 探测出的编码 */
export interface ProbedDecode {
  text: string;
  encoding: FileEncoding;
}

/**
 * 探测 + 解码**一次做完**（2026-10-16 批量 IO 批）。
 *
 * 旧路径是双重全量解码：`probeEncoding`（内含 `isValidUtf8` 的 fatal 全文解一遍，
 * 抛错即弃）→ `decode`（再全文解一遍）。对每个文件白烧一遍全量 UTF-8 校验的 CPU
 * ——批量读把这件事的账放大了（一次开项目 ~9,000 个文件）。
 *
 * 判定顺序与 `probeEncoding` **逐条一致**（等价性由对拍测试钉死，两者共用
 * {@link probeLegacyCjk}）：
 * BOM（utf-8-bom / utf-16le / utf-16be，BOM 由 TextDecoder 按 WHATWG 标准剥掉）
 * → 直接以 fatal 模式解 UTF-8（成功 = utf-8，失败的那次尝试就是校验本身，不再重复）
 * → 三族评分（shift_jis / gbk / big5，胜者的解码文本直接复用，不再多解一遍）
 * → 三族零分时兜底 shift_jis（不严格口径，无法映射字节替换为 U+FFFD，与既有行为一致）。
 */
export function decodeWithProbe(bytes: Uint8Array): ProbedDecode {
  if (bytes.length >= 3 && bytes[0] === BOM_UTF8[0] && bytes[1] === BOM_UTF8[1] && bytes[2] === BOM_UTF8[2]) {
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8-bom' };
  }
  if (bytes.length >= 2 && bytes[0] === BOM_UTF16_LE[0] && bytes[1] === BOM_UTF16_LE[1]) {
    return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === BOM_UTF16_BE[0] && bytes[1] === BOM_UTF16_BE[1]) {
    return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be' };
  }
  try {
    // fatal = 校验与解码合体：成功的那一次输出就是正文，不再有第二遍
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    // 非 UTF-8：三族裁决的胜者文本直接复用（其解码本就发生了，不多花一遍）
    const probed = probeLegacyCjk(bytes);
    return { text: probed.text, encoding: probed.encoding };
  }
}

export type EolStyle = 'crlf' | 'lf';

/**
 * 探测换行的**多数派**风格（仅用于决定"新增/被改行"该用哪种换行；
 * 无换行或平局默认 lf）。
 *
 * 注意：本函数**只**产出"默认换行"判据，不再参与还原——逐行还原见
 * {@link splitPreserveEol} / {@link reconstructEol}。旧实现把整文件归一到单一
 * 多数派 `eol` 再 `applyEol` 全量重写，会让"少数派换行的行"在一次无关编辑+保存后
 * 被静默翻转（改动了用户没碰的字节）；孤立 `\r`（旧 Mac）文件因这里忽略计数
 * 返回 'lf'，从而被整文件重写。逐行保真把这两条都堵住了。
 */
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
      // 孤立 \r（旧 Mac）不参与多数派计数
    } else if (c === 10 /* \n */) {
      lf++;
    }
  }
  return crlf > lf ? 'crlf' : 'lf';
}

/** 归一化为内部表示（\n）——编辑器模型/逐行比较的规范形态 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * 写出时把**整段**统一为单一风格（仅在调用方**显式**指定 eol、或无原文映射可用时兜底）。
 * 保真写回请走 {@link reconstructEol}（逐行保留原换行）。
 */
export function applyEol(text: string, eol: EolStyle): string {
  return eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
}

/** 原文换行指纹：按原样切出的"行内容 + 分隔符"。`parts.length === terms.length + 1` */
export interface EolMap {
  /** 各行内容（不含任何 `\r`/`\n`）；末段是最后一个分隔符之后残留的内容（常为空串） */
  parts: string[];
  /** `terms[i]` 是 `parts[i]` 与 `parts[i+1]` 之间的原始换行（`\r\n` / `\n` / `\r`） */
  terms: string[];
}

/**
 * 逐字节保真地把原文切成行与分隔符（内部表示不掺和）：
 * `\r\n` 视为**一个**分隔符，孤立 `\r`、孤立 `\n` 各为一个分隔符。
 * 不变式：`parts.join` 用对应 `terms` 拼接可**逐字节还原** `raw`。
 */
export function splitPreserveEol(raw: string): EolMap {
  const parts: string[] = [];
  const terms: string[] = [];
  let cur = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\r') {
      if (raw[i + 1] === '\n') {
        terms.push('\r\n');
        i++;
      } else {
        terms.push('\r');
      }
      parts.push(cur);
      cur = '';
    } else if (c === '\n') {
      terms.push('\n');
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return { parts, terms };
}

/** {@link splitPreserveEol} 的逆：由行与分隔符**逐字节**拼回原文（零改动快道回填指纹用） */
export function joinPreserveEol(map: EolMap): string {
  let out = map.parts[0] ?? '';
  for (let i = 0; i < map.terms.length; i++) out += map.terms[i] + (map.parts[i + 1] ?? '');
  return out;
}

/**
 * 逐行保真还原：**未改动的行保留其原始换行**，只有被创建/改动的行才采用 `defaultEol`。
 *
 * 判据：把 `newText`（按内部 `\n` 规范化的模型文本）与 {@link EolMap} 的行内容做
 * **公共前缀 + 公共后缀**对齐（覆盖"改一行""中间插几行""末尾追加/删除"这些真实编辑形态）；
 * 落在前缀/后缀里且相邻两行都命中原文同一相邻位置的**分隔符**才还原原换行，
 * 其余（改动行两侧、新增行）用 `defaultEol`。零改动时逐字节还原为原文。
 *
 * 内部结构（{@link EolMap}）只活在 encoding/io 之间，不改 readText/writeText 对外签名。
 */
export function reconstructEol(orig: EolMap, newText: string, defaultEol: EolStyle): string {
  const nLines = normalizeEol(newText).split('\n');
  const n = nLines.length;
  const o = orig.parts.length;
  const defTerm = defaultEol === 'crlf' ? '\r\n' : '\n';

  let p = 0;
  while (p < n && p < o && nLines[p] === orig.parts[p]) p++;
  let s = 0;
  while (s < n - p && s < o - p && nLines[n - 1 - s] === orig.parts[o - 1 - s]) s++;

  const off = o - n;
  // 新行 i 命中的原行下标（未命中 ⇒ -1）
  const origIndex = (i: number): number =>
    i < p ? i : i >= n - s ? i + off : -1;

  let out = '';
  for (let i = 0; i < n - 1; i++) {
    const a = origIndex(i);
    const b = origIndex(i + 1);
    out += nLines[i];
    out += a >= 0 && b === a + 1 ? orig.terms[a] : defTerm;
  }
  out += nLines[n - 1];
  return out;
}

/**
 * UTF-16 写回补 BOM：解码时 TextDecoder/encoding_rs 会**剥掉** BOM，
 * 而两个桥的 `encode` 对 `utf-16le`/`utf-16be` 都产出**无 BOM** 字节
 * （`UTF_16LE.encode` 不自动加 BOM）⇒ 直接写回会吃掉 BOM。
 * 本探测只对**带 BOM** 的 UTF-16 文件判为 utf-16le/be，故补回 BOM 即还原原貌。
 * 其余编码原样返回。
 */
export function withUtf16Bom(body: string, encoding: FileEncoding): string {
  if (body.charCodeAt(0) === 0xfeff) return body; // 已含，别加两次
  if (encoding === 'utf-16le' || encoding === 'utf-16be') return `\uFEFF${body}`;
  return body;
}
