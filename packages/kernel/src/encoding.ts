import type { DecodeBomRule, FileEncoding } from '@kojo/plugin-api';
import { DECODE_LABEL, DECODE_PROBE_POLICY } from '@kojo/plugin-api';
import { normalizeEol as normalizeEolContract } from '@kojo/plugin-api/eol';

/**
 * 编码探测与换行处理。
 *
 * 背景（逆向文档实测）：
 * - ERB / CSV 生态极其混杂：Shift-JIS（日文原版）、UTF-8-BOM（汉化版）、UTF-16（罕见）；
 * - 引擎自身 DetectEncoding 存在已知 bug（Process.cs:589 错误回读 CSV 行时误用 ErbDir），
 *   编辑器必须自行做正确探测 + 写回保持，否则一次保存就毁半库文件。
 *
 * **判序与 fatal/替换策略只有一份定义**（W12 ENC-SRC）：`DECODE_PROBE_POLICY`
 * （`@kojo/plugin-api`，表体 = 同目录 `decode-probe-policy.json`）。本文件是它的 TS 解释者；
 * Rust 检索侧是同一张表的另一个解释者（`src-tauri/src/lib.rs` 的 `decode_with_policy`，
 * 编译期 `include_str!` 内嵌）。旧局三套解码判据（此处 / Rust `decode_for_search` /
 * Rust `decode_bytes`）已合一，跨语言对拍见 `encoding-decode-policy.test.ts` 与
 * `search_tests.rs::policy_table_decodes_golden_samples`。
 */

/** 判序第一环：BOM 前缀命中（表内顺序即判定顺序，逐条短路） */
function matchBomRule(bytes: Uint8Array): DecodeBomRule | null {
  for (const rule of DECODE_PROBE_POLICY.bomRules) {
    if (bytes.length < rule.bom.length) continue;
    let hit = true;
    for (let i = 0; i < rule.bom.length; i++) {
      if (bytes[i] !== rule.bom[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return rule;
  }
  return null;
}

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
 * 探测编码。判定顺序：BOM（策略表逐条）→ UTF-8 合法性 → 中日韩三族评分（shift_jis / gbk / big5）→ 兜底 shift_jis。
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
  const rule = matchBomRule(bytes);
  if (rule) return rule.encoding;
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
 * 探测 + 解码**一次做完**（2026-10-16 批量 IO 批；W12 ENC-SRC 起改为策略表解释者）。
 *
 * 与 `probeEncoding` 逐条同判序（等价性由对拍测试钉死）：
 * BOM（标签由 `DECODE_LABEL` 派生、顺序由策略表逐条判定，BOM 由 TextDecoder 按 WHATWG
 * 标准剥掉；非法尾随字节替换为 U+FFFD——不严格口径，与 Rust 侧 WHATWG 对齐解码同文）
 * → 直接以 fatal 模式解 UTF-8（成功 = utf-8，失败的那次尝试就是校验本身，不再重复）
 * → 三族评分（shift_jis / gbk / big5，胜者的解码文本直接复用，不再多解一遍）
 * → 三族零分时兜底 shift_jis（不严格口径，与既有行为、Rust 侧同判序一致）。
 */
export function decodeWithProbe(bytes: Uint8Array): ProbedDecode {
  const rule = matchBomRule(bytes);
  if (rule) {
    return { text: new TextDecoder(DECODE_LABEL[rule.encoding]).decode(bytes), encoding: rule.encoding };
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
  // 快筛：正文里一个 `\r` 都没有 ⇒ 全是 LF（含无换行的纯文本）。真语料 4,072 份里
  // 只有 30 份走这条，但它把"空文件 / 纯 ASCII 小文件"这一类零成本滤掉。
  if (text.indexOf('\r') < 0) return 'lf';
  // R7B（2026-10-31）：**按 `\n` 跳跃**而不是逐字符 `charCodeAt`。`indexOf` 在 V8 里是
  // 字节级的 memchr，1.17 亿码元真语料实测 **465ms → 274ms**（`\n` 数约 436 万，跳跃次数
  // 只有逐字符扫描的 1/27）。判据与旧实现逐位等价：`\r\n` 里的 `\n` 前驱是 `\r` ⇒ 记
  // crlf；其余 `\n` 记 lf；孤立 `\r` 不进任何桶——与旧实现 `i++` 跳过的口径相同。
  let crlf = 0;
  let lf = 0;
  let i = -1;
  for (;;) {
    i = text.indexOf('\n', i + 1);
    if (i < 0) break;
    if (i > 0 && text.charCodeAt(i - 1) === 13 /* \r */) crlf++;
    else lf++;
  }
  return crlf > lf ? 'crlf' : 'lf';
}

/**
 * 归一化为内部表示（`\n`）——编辑器模型/逐行比较的规范形态。
 *
 * **实现已收口到契约层**（R7B，2026-10-31）：`@kojo/plugin-api/eol` 是唯一一份，本函数
 * 只转一手。收口理由：同一条判决此前在仓里写着 6 份（本文件、`erb-parser` 的 scanner /
 * references、`condition-extractor` ×2、`convention-linter`、`plugin-api` 的
 * `splitModelLines`），其中 5 份是 `text.replace(/\r\n?/g, '\n')` 的字面复制 ⇒ 索引链路上
 * 同一份正文被"全文正则替换"了 5 遍（真语料 1.17 亿码元实测 2,415ms/遍）。契约层那一份
 * 再补了 `splitEolLines`（切行不再先 join 回整串），单遍 836ms。
 *
 * MEM-16 的读数仍然成立、仍是"不许改回 `replace`"的依据：V8 的
 * `String.prototype.replace` 在"真发生替换且结果够长"时产出 **ConsString（绳索）**，
 * `%DebugPrint` 报 `CONS_TWO_BYTE_STRING_TYPE`，实测驻留 **5.68 B/字符**（2,000 份真语料
 * CRLF 形态 193.9 MB），而这串会被 `readText`/`readTexts` 长期持在会话文本缓存里。
 * 现写法先 `indexOf('\r')` 探"有没有要改的"（无 ⇒ 零拷贝返回入参），有 `\r` 才
 * `split` + `join('\n')`——`join` 走 `StringBuilderConcat`，先算总长再分配一条平铺串
 * 逐段 `WriteToFlat` 拷贝（不建绳索），实测 30,001 段 / 165,000 字符仍报
 * `SEQ_TWO_BYTE_STRING_TYPE`，驻留 2.01 B/字符。
 *
 * 等价性（`/\r\n?/` ↔ `split(/\r\n|\r|\n/)`）由 `plugin-api/tests/eol.test.ts` 以旧写法为
 * 参照实现钉死；本仓不再有第二份实现。
 */
export function normalizeEol(text: string): string {
  return normalizeEolContract(text);
}

/**
 * 写出时把**整段**统一为单一风格（仅在调用方**显式**指定 eol、或无原文映射可用时兜底）。
 * 保真写回请走 {@link reconstructEol}（逐行保留原换行）。
 */
export function applyEol(text: string, eol: EolStyle): string {
  // MEM-16：`replace(/\n/g, '\r\n')` 长文本上产出 ConsString（绳索），而本函数的产物会被
  // `writeText` 存进换行指纹缓存长期持有 ⇒ 改走 split/join（StringBuilderConcat 产平铺串）。
  // 切分点与 replace 逐字等价：每个 `\n` 都换成分隔符，空段/首尾/连续分隔符原样保留。
  return eol === 'crlf' ? text.split('\n').join('\r\n') : text;
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
 *
 * 实现（2026-10 性能批 PS-2）：**分段一次切**（带捕获组的 `split`——捕获组的内容
 * 作为独立元素夹在行间，天然就是"行/分隔符/行/分隔符…"的交替形态），
 * 顶替旧的逐字符 `cur += c` 累加。旧实现实测 430k 字符 / 12.4k 行 **29.2ms 且留存 12.7MB**
 * （每行都产生一串一次性中间串），新实现 **~4ms / 亚 MB 级**；它在每一次文本读入上都要跑，
 * 冷开一次要过 5,500 万字符——这是本批最大的单点收益。
 * 边界与旧实现逐字等价（由既有黄金用例钉住）：首部/尾部/连续分隔符各产生空行段，
 * 空串产出 `{ parts: [''], terms: [] }`。
 */
export function splitPreserveEol(raw: string): EolMap {
  const segments = raw.split(/(\r\n|\r|\n)/);
  const parts: string[] = new Array((segments.length + 1) >> 1);
  const terms: string[] = new Array(segments.length >> 1);
  for (let i = 0; i < segments.length; i++) {
    // split 不产洞：下标在 length 界内必为 string（noUncheckedIndexedAccess 认不了，显式钉）
    const seg = segments[i] as string;
    if ((i & 1) === 0) parts[i >> 1] = seg;
    else terms[(i - 1) >> 1] = seg;
  }
  return { parts, terms };
}

/** {@link splitPreserveEol} 的逆：由行与分隔符**逐字节**拼回原文（零改动快道回填指纹用） */
export function joinPreserveEol(map: EolMap): string {
  // 交错压入一次 join（PS-2：与 split 同理，逐段 `+=` 在万行文件上是同一类浪费）
  const segs: string[] = new Array(map.parts.length + map.terms.length);
  let w = 0;
  segs[w++] = map.parts[0] ?? '';
  for (let i = 0; i < map.terms.length; i++) {
    segs[w++] = map.terms[i] ?? '';
    segs[w++] = map.parts[i + 1] ?? '';
  }
  return segs.join('');
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

  // MEM-16：与 `joinPreserveEol` 同理，逐段 `+=` 的产物是 ConsString（绳索）——本函数的
  // 返回值会被 `writeText` 存进换行指纹缓存长期持有，故交错压入一次 join 换平铺串。
  const segs: string[] = new Array((n - 1) * 2 + 1);
  let w = 0;
  for (let i = 0; i < n - 1; i++) {
    const a = origIndex(i);
    const b = origIndex(i + 1);
    segs[w++] = nLines[i] as string;
    segs[w++] = a >= 0 && b === a + 1 ? (orig.terms[a] as string) : defTerm;
  }
  segs[w] = nLines[n - 1] as string;
  return segs.join('');
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

/* -------------------- 显式编码（批次十 S2，additive） -------------------- */

/**
 * 全部受支持编码的**运行时枚举**（顺序 = UI 编码菜单的展示序）。
 * 与类型 `FileEncoding` 同源：新增一个字面量必须同时加到这里，
 * `decodeWithEncoding` / 显式编码入口的本层校验都按它认。
 */
export const ENCODING_IDS: readonly FileEncoding[] = [
  'utf-8',
  'utf-8-bom',
  'shift_jis',
  'gbk',
  'gb18030',
  'big5',
  'utf-16le',
  'utf-16be',
];

/** 运行时判定某字符串是不是受支持的编码（显式编码入口的第一道校验，未知编码必须报错） */
export function isFileEncoding(value: string): value is FileEncoding {
  return (ENCODING_IDS as readonly string[]).includes(value);
}

/**
 * **按调用方显式指定的编码**解码（不探测；批次十 S2）。
 *
 * 判据与两具平台桥的 `decode` 同形：`new TextDecoder(DECODE_LABEL[encoding])`，非法字节
 * 替换为 U+FFFD（不严格口径——"按这个编码看"本身就是用户的显式选择，解不干净时应当
 * 看见替换字符而不是被拒绝）。BOM 由 TextDecoder 按 WHATWG 剥掉。
 *
 * @throws 编码不在 `FileEncoding` 内（错误原话列出可选值，不静默猜）
 */
export function decodeWithEncoding(bytes: Uint8Array, encoding: FileEncoding): string {
  if (!isFileEncoding(encoding)) {
    throw new Error(`不支持的编码：${String(encoding)}（可选：${ENCODING_IDS.join(' / ')}）`);
  }
  return new TextDecoder(DECODE_LABEL[encoding]).decode(bytes);
}
