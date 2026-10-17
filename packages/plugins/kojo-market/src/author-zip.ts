/**
 * 普通作品包 zip 的**宽松读取**（ZIP-1，2026-10-18）。
 *
 * 市场容器读取（`market_extract` / `zipContainerContractProblem`）是**严格契约**：
 * 只收普通文件条目、条目名必须是 UTF-8 且置 bit 11。老作者（本编辑器之前）的 zip 恰好
 * 三条都踩：Windows 压缩/7-Zip 默认出 CP932 文件名、常有显式目录条目、外层再包一层文件夹。
 * 于是这里另开一条**只读**的宽松路：
 *
 * - 用同一份 `readZipContainer` 解析中央目录（容器结构仍然严判：本地头/中央目录必须互指）；
 * - 条目名先按 UTF-8 解；失败再在 Shift-JIS / GBK / EUC-JP / Big5 / Windows-1252 里按可信度打分选优
 *   （不认 bit 11：旧工具的标志位与真实字节经常对不上）；
 * - 目录条目跳过、系统垃圾（`__MACOSX/`、`.DS_Store`、`Thumbs.db`、`__MACOSX/._*`）跳过；
 * - 路径闸仍复用 `normalizeEntryName` + `zipEntryContractProblem`（zip-slip / 盘符 /
 *   上跳 / 保留设备名 / 深度一个都不放过）；
 * - 单层包裹目录自动剥掉（Windows「压缩文件夹」形态），保证进包路径与工作区发布同形。
 *
 * **零写盘**：字节只在内存里解出，不复制源 zip、不落暂存区。限额与市场容器同一张表
 * （`MARKET_MAX_*`），所以"普通包"不会成为绕过限额的第二条路。
 */

import {
  MARKET_MAX_FILE_ENTRIES,
  MARKET_MAX_PATH_DEPTH,
  MARKET_MAX_UNPACKED_BYTES,
  MarketError,
  inflateZipEntry,
  normalizeEntryName,
  zipEntryContractProblem,
  type MarketRejectCode,
  type MarketZipFile,
  type ZipContainer,
} from '@kojo/plugin-api';

/** 普通作品包读取的限额（与市场容器同源，不写第二份数字） */
export interface AuthorZipLimits {
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly maxUnpackedBytes: number;
}

export const AUTHOR_ZIP_LIMITS: AuthorZipLimits = {
  maxEntries: MARKET_MAX_FILE_ENTRIES,
  maxDepth: MARKET_MAX_PATH_DEPTH,
  maxUnpackedBytes: MARKET_MAX_UNPACKED_BYTES,
};

/** 读取结果（`skipped` / `strippedRoot` 是给作者看的"发生了什么"，不是拒绝） */
export interface AuthorZipInspection {
  readonly files: readonly MarketZipFile[];
  readonly skipped: readonly string[];
  readonly strippedRoot?: string;
}

const utf8Fatal = new TextDecoder('utf-8', { fatal: true });

/**
 * 旧 zip 的候选编码（按优先级；同分时先出现的赢）。
 *
 * 为什么不止 Shift-JIS：实测同一台中文 Windows 上 7-Zip 默认参数打的日文包，
 * 条目名是 **GBK**（`主口上` = D6 F7 BF DA C9 CF），按 Shift-JIS 会解成半角片假名乱码。
 * 旧日文包则可能是 CP932；EUC-JP / Big5 作兜底。TextDecoder 不保证全平台都有这些标签
 * （构造会抛），所以逐个 try，缺哪门就跳过哪门。
 */
const LEGACY_DECODERS: ReadonlyArray<InstanceType<typeof TextDecoder>> = (() => {
  const out: Array<InstanceType<typeof TextDecoder>> = [];
  for (const label of ['shift_jis', 'gbk', 'euc-jp', 'big5', 'windows-1252']) {
    try {
      out.push(new TextDecoder(label));
    } catch {
      // 平台没有这门编码：跳过（不影响其余候选）
    }
  }
  return out;
})();

/**
 * 解码质量打分：同一串字节用不同旧编码解出来的都是"合法字符串"，只能挑更可信的那份。
 * - 替换符（U+FFFD）几乎一票否决；
 * - 半角片假名是 Shift-JIS 误读 GBK 的典型产物（`ﾖﾚﾉﾏ`），重罚；
 * - CJK / 假名加分，ASCII 与常见文件名标点小加分，控制字符/私用区重罚。
 * 同分时按 `LEGACY_DECODERS` 的优先级取先出现者（Shift-JIS → GBK → EUC-JP → Big5 → 1252）。
 */
function nameScore(name: string): number {
  let score = 0;
  for (const ch of name) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '\uFFFD') score -= 1000;
    else if (cp >= 0xff61 && cp <= 0xff9f) score -= 40;
    else if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) score -= 100;
    else if (cp >= 0xe000 && cp <= 0xf8ff) score -= 200;
    else if (cp >= 0x4e00 && cp <= 0x9fff) score += 4;
    // 假名与汉字同分：GBK 的 kana 区与 EUC-JP 字节重合，若假名低一分，
    // 同一串 kana 字节会被 Big5/其它候选"解成稀有汉字"而抢走（实测 `ライセンス…`）。
    else if (cp >= 0x3040 && cp <= 0x30ff) score += 4;
    else score += 1;
  }
  return score;
}

/** 加密标志位（bit 0/1/2 = 传统加密，bit 6 = 强加密）；普通作品包也不收 */
const FLAG_ENCRYPTED = 0x0001 | 0x0002 | 0x0004 | 0x0040;

/** 系统垃圾文件名（小写比较）；`._*` 是 macOS AppleDouble 边车 */
const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

/**
 * 条目名解码：UTF-8 优先（无论 bit 11 是否置位——有些工具置了位但字节本身是 UTF-8），
 * 失败后在旧编码候选里按 `nameScore` 选最可信的一份。
 *
 * 为什么不看 bit 11 决定：老工具的位与字节经常对不上；这里的目标是"把作者的文件名读对"，
 * 不是校验市场容器契约。真正的市场容器仍走严格解包。
 */
export function decodeAuthorZipName(raw: Uint8Array): string {
  try {
    return utf8Fatal.decode(raw);
  } catch {
    // 不是合法 UTF-8：继续尝试旧 Windows 编码
  }
  let best: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const decoder of LEGACY_DECODERS) {
    const name = decoder.decode(raw);
    const score = nameScore(name);
    // 同分不换（`LEGACY_DECODERS` 的顺序就是优先级）
    if (score > bestScore) {
      best = name;
      bestScore = score;
    }
  }
  // 空表（平台连 windows-1252 都没有）才会走到这里；UTF-8 lossy 是最后的兜底
  return best ?? new TextDecoder().decode(raw);
}

/** 目录条目 / 系统垃圾（在**归一后的 posix 路径**上判） */
function shouldSkip(path: string): boolean {
  const segments = path.split('/');
  if (segments[0]?.toLowerCase() === '__macosx') return true;
  const base = segments[segments.length - 1]?.toLowerCase() ?? '';
  return JUNK_NAMES.has(base) || base.startsWith('._');
}

/** `ZipContractCode` → 市场错误码；市场码表没有的两类归到 `extract-failed` */
function rejectCodeOf(code: string): MarketRejectCode {
  switch (code) {
    case 'path-absolute':
    case 'path-drive':
    case 'path-backslash':
    case 'path-dotdot':
    case 'path-empty-segment':
    case 'path-windows-unsafe':
    case 'path-depth':
    case 'entry-duplicate':
    case 'entries-limit':
    case 'bytes-limit':
      return code;
    default:
      return 'extract-failed';
  }
}

/** 单层包裹目录：所有文件都在同一个顶层目录下、且根目录没有文件 ⇒ 返回该目录名 */
function singleWrappingRoot(files: readonly MarketZipFile[]): string | undefined {
  if (files.length === 0) return undefined;
  if (files.some((f) => !f.path.includes('/'))) return undefined;
  const roots = new Set(files.map((f) => f.path.slice(0, f.path.indexOf('/'))));
  if (roots.size !== 1) return undefined;
  return roots.values().next().value;
}

/**
 * 把一个普通作品包容器解成内存文件表。
 *
 * 顺序 = 容器中央目录顺序（稳定，便于作者对照）；重名按大小写折叠判死（Windows 落盘会互覆）。
 * 目录条目与系统垃圾不进 `files`，但如实进 `skipped`；单层包裹目录名进 `strippedRoot`。
 *
 * @throws MarketError 条目名/路径/限额/重名/解压任一不合格（消息直接给作者看）
 */
export async function inspectAuthorZip(
  container: ZipContainer,
  limits: AuthorZipLimits = AUTHOR_ZIP_LIMITS,
): Promise<AuthorZipInspection> {
  if (container.zip64) {
    throw new MarketError('extract-failed', '这个 zip 用了 ZIP64（超大容器），编辑器暂时读不了；请用普通 zip 重新压缩。');
  }
  if (container.entries.length > limits.maxEntries) {
    throw new MarketError(
      'entries-limit',
      `这个 zip 有 ${container.entries.length} 个条目，超过上限 ${limits.maxEntries}；请先精简包内容。`,
    );
  }
  if (container.totalUnpackedBytes > limits.maxUnpackedBytes) {
    throw new MarketError(
      'bytes-limit',
      `这个 zip 解压后约 ${Math.ceil(container.totalUnpackedBytes / 1024 / 1024)} MB，超过上限 ${Math.floor(limits.maxUnpackedBytes / 1024 / 1024)} MB；请先瘦身。`,
    );
  }

  const files: MarketZipFile[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const entry of container.entries) {
    const decoded = decodeAuthorZipName(entry.rawName);
    if (decoded.replaceAll('\\', '/').endsWith('/')) {
      skipped.push(decoded);
      continue;
    }
    let normalized: string;
    try {
      normalized = normalizeEntryName(decoded);
    } catch (err) {
      throw new MarketError(
        'extract-failed',
        `这个 zip 里有个条目名不能安全解出：${decoded}（${err instanceof Error ? err.message : String(err)}）`,
        decoded,
      );
    }
    if (shouldSkip(normalized)) {
      skipped.push(normalized);
      continue;
    }
    const problem = zipEntryContractProblem(normalized, limits.maxDepth);
    if (problem !== null) {
      throw new MarketError(
        rejectCodeOf(problem),
        `这个 zip 里有个条目路径不合法（${problem}）：${normalized}`,
        normalized,
      );
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      throw new MarketError('entry-duplicate', `这个 zip 里有重复的条目路径（不区分大小写）：${normalized}`, normalized);
    }
    seen.add(key);
    if ((entry.flags & FLAG_ENCRYPTED) !== 0) {
      throw new MarketError('extract-failed', `这个 zip 里的条目是加密的，编辑器读不了：${normalized}`, normalized);
    }
    let bytes: Uint8Array;
    try {
      bytes = await inflateZipEntry(entry);
    } catch (err) {
      throw new MarketError(
        'extract-failed',
        `这个 zip 里的文件解不出来：${normalized}（${err instanceof Error ? err.message : String(err)}）`,
        normalized,
      );
    }
    files.push({ path: normalized, bytes });
  }

  if (files.length === 0) {
    throw new MarketError(
      'content-missing',
      '这个 zip 里没有可发布的文件（目录与系统垃圾不算内容）；请确认选的是口上作品包。',
    );
  }

  const strippedRoot = singleWrappingRoot(files);
  const finalFiles =
    strippedRoot === undefined
      ? files
      : files.map((f) => ({ path: f.path.slice(strippedRoot.length + 1), bytes: f.bytes }));
  return strippedRoot === undefined
    ? { files: finalFiles, skipped }
    : { files: finalFiles, skipped, strippedRoot };
}
