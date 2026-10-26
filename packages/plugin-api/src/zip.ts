/**
 * ZIP（PKZIP 2.0）容器写出器 —— **纯 TS，零依赖，不碰磁盘**。
 *
 * ## 为什么在 TS 层，不给 Rust 加 `zip` crate（用户 2026-10-12 拍板）
 *
 * Rust 宿主的定位是「只做 IO 原语、零业务逻辑」。ZIP 组装是业务逻辑
 * （决定打包哪些文件、叫什么名、用什么压缩），放 Rust 就把这条边界凿穿了。
 * 而压缩本身并不需要库：`CompressionStream('deflate-raw')` 是 **平台自带**的
 * Web 流 API（WebView2/Chromium 与 Node 18+ 都有），产出的正是 ZIP method 8
 * 要的 raw deflate 字节流。所以本模块只做**容器封装**：本地头 + 中央目录 + EOCD + CRC32。
 *
 * ## 三条不能省的规矩
 *
 * 1. **UTF-8 文件名标志位（general purpose bit 11 = `0x0800`）必置**。
 *    口上包里的文件名是中文/日文，不置这一位 = 声明"名字是 CP437"，
 *    解压出来就是乱码目录名。这是本模块存在的理由之一，不是可选项。
 * 2. **分隔符一律 `/`**（ZIP 规范），Windows 的 `\` 会被当成文件名的一部分，
 *    于是解出一个名字叫 `ERB\口上\事件.kojo` 的文件而不是一层目录。
 * 3. **压完变大就退回 store（method 0）**。几十字节的短文件 deflate 后普遍膨胀，
 *    与其硬塞不如原样存——同时让"压缩失败/不可用"天然退化成 store 而非报错。
 *
 * ## 不做的事
 *
 * - 不支持 ZIP64（>4 GiB 或 >65,535 条目）。口上包是几十个小文本文件，
 *   真到那一步再说；这里用 `throw` 明确拒绝而不是静默产出坏包。
 * - 不加密、不加注释、不写扩展字段。
 *
 * ## 往返契约（W14）：写与解**必须互相认识**
 *
 * 打包住本模块（TS），解包住宿主 `app/src-tauri/src/market.rs`（Rust）。两侧语言不同、
 * 不能共享实现，于是**规则本身**收成一张显式共享的常量表
 * `fixtures/zip-roundtrip/contract.json`：
 * 容器名字面闸、条目路径闸（含判定**顺序**）、限额、以及一个由本模块真造出来的
 * 容器样本 `fixtures/zip-roundtrip/container.zip` 的逐条目钉数（名字 / CRC / 字节 / 内容）。
 * TS 侧判据在 `tests/zip-roundtrip.test.ts`，Rust 侧在 `market_tests.rs`，
 * **同一张表、同一组期望值**——任何一侧改了规则，另一侧的测试当场红。
 *
 * 本模块因此提供三件原语（全部零 IO）：
 * - `zipEntryContractProblem` / `zipContainerContractProblem`：平台解包器契约的纯判定
 *   （拒绝码字面与顺序与 Rust 逐字同源）；
 * - `readZipContainer`：最小容器**读器**，把中央目录 ↔ 本地头的互指关系核出来
 *   （写侧自己看不见自己写的包，过去因此没有任何验证回路）；
 * - `buildZip(entries, { contract: 'extractable' })`：产出"必然可被平台解包器读出"的包，
 *   违例在写第一个字节之前就抛（目录条目 / 深度 / 条目数 / 总字节 / 重名一律拒）。
 */

import {
  MARKET_MAX_FILE_ENTRIES,
  MARKET_MAX_PATH_DEPTH,
  MARKET_MAX_UNPACKED_BYTES,
  MARKET_ZIP_SUFFIX,
} from './market';

/** ZIP 条目（调用方负责把内容读成字节；本模块不做任何 IO） */
export interface ZipEntry {
  /**
   * 包内路径，**必须**用 `/` 分隔（如 `事件.kojo`、`子目录/README.md`）。
   * 以 `/` 结尾 = 目录条目。
   */
  name: string;
  /** 文件内容；目录条目传空数组 */
  data: Uint8Array;
  /**
   * 该条目的时间戳（epoch ms）。缺省取 `date` 参数或当前时间——
   * **不取文件真实 mtime**：导出包要可复现，同内容两次导出应逐字节相同。
   */
  mtimeMs?: number;
}

/** 构建选项 */
export interface ZipOptions {
  /** 全部条目的统一时间戳（epoch ms）；缺省 = `Date.now()` */
  date?: number;
  /** 是否尝试 deflate（`false` = 全部 store）。缺省 `true`（平台不支持时自动退回 store） */
  compress?: boolean;
  /**
   * 契约档位。缺省 `'generic'` = 只守 ZIP 规范（允许目录条目、允许任意深度）。
   * `'extractable'` = 额外守**平台解包器契约**（`zipContainerContractProblem` 那套闸：
   * 无目录条目、深度 ≤ 契约上限、条目数与解压总字节不超限额、无重名（含大小写折叠）、
   * 条目名 UTF-8 不超 65,535 字节），违例在写第一个字节之前抛 `${拒绝码}：…`。
   * 要给市场/暂存链路消费的包**必须**用这一档——否则打出来的包平台侧解不开，
   * 而作者只有在导入那一刻才知道。
   */
  contract?: 'generic' | 'extractable';
  /** `'extractable'` 档的限额覆盖（缺省 = 契约常量 `ZIP_EXTRACT_LIMITS`） */
  limits?: ZipContractLimits;
}

/** ZIP 里 DOS 时间戳的合法年份下限（1980）；更早的 mtime 会被夹到这一天 */
const DOS_EPOCH_YEAR = 1980;
/**
 * general purpose bit flag：bit 11 = 文件名/注释用 UTF-8。
 * 名字规范只有一个真源就是这一位：Rust 侧的 `zip` 读器在**这一位缺失**时把名字按
 * **CP437** 解码（`zip-4.6.1/src/read.rs:1306` → `from_cp437`），于是中文条目名会安静地
 * 变成制表符块字符——路径闸照样放行、落盘却是乱码文件名。往返契约因此在**解包侧**
 * 也钉住这一位（`entry-name-encoding`），不只靠写侧自觉。
 */
export const ZIP_FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** version needed to extract = 2.0（deflate 与 store 都是 20） */
const VERSION_NEEDED = 20;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
/** ZIP64 的中央目录定位记录签名（本模块与平台解包器都不支持 ZIP64 ⇒ 见到就拒） */
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
/** EOCD 的固定长度与 ZIP64 哨兵值（计数 `0xFFFF` / 偏移 `0xFFFFFFFF`） */
const EOCD_SIZE = 22;
const ZIP64_SENTINEL_U16 = 0xffff;
const ZIP64_SENTINEL_U32 = 0xffffffff;

/* ------------------------------ CRC32 ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** 标准 ZIP/PKZIP CRC-32（多项式反序 0xEDB88320） */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------ 名字校验 ------------------------------ */

/**
 * 包内路径校验（防"坏包"与解压侧的 zip-slip）。
 * 通过则返回规范化后的名字（`\` → `/`），非法则抛中文错误。
 *
 * 这一条是**写侧**规矩（作者目录里的 `ERB\口上\…` 要变成合法的包内路径）；
 * 解包侧的同一套形态规矩是 `zipEntryContractProblem`（拒绝码字面与 Rust 同源）。
 * 两者不是一份实现，是因为它们**判的东西不同**：这里先把反斜杠归一为正斜杠再放行，
 * 那里必须把反斜杠原样拒掉（容器里已经写进去的反斜杠是坏包，不是"可归一的输入"）。
 */
export function normalizeEntryName(name: string): string {
  const slashed = name.replaceAll('\\', '/');
  if (slashed.startsWith('/')) throw new Error(`ZIP 条目名不能是绝对路径：${name}`);
  if (/^[A-Za-z]:/.test(slashed)) throw new Error(`ZIP 条目名不能带盘符：${name}`);
  if (/\/{2,}/.test(slashed)) throw new Error(`ZIP 条目名含空路径段：${name}`);
  if (/\0/.test(slashed)) throw new Error('ZIP 条目名含空字符');
  // 目录条目以 `/` 结尾是 ZIP 表达"这是个目录"的**唯一**手段（外部属性那位各家工具
  // 并不一致），所以先把这一位摘掉再逐段查——否则 `子目录/` 会被当成"末尾有个空段"。
  const body = slashed.endsWith('/') ? slashed.slice(0, -1) : slashed;
  if (body.length === 0) throw new Error('ZIP 条目名不能为空');
  for (const seg of body.split('/')) {
    if (seg === '' || seg === '.') throw new Error(`ZIP 条目名含空路径段：${name}`);
    if (seg === '..') throw new Error(`ZIP 条目名不允许上跳（解压侧会被引导写到包外）：${name}`);
  }
  const bytes = new TextEncoder().encode(slashed);
  if (bytes.length > ZIP_MAX_NAME_BYTES) {
    throw new Error(`ZIP 条目名过长（UTF-8 ${bytes.length} 字节 > ${ZIP_MAX_NAME_BYTES}）：${name}`);
  }
  return slashed;
}

/* --------------------------- 往返契约（与 Rust 共享一张表） --------------------------- */

/**
 * 平台解包器（`app/src-tauri/src/market.rs`）的拒绝码。
 * **字面与判定顺序都是契约的一部分**：两侧逐字同源，共享表 `fixtures/zip-roundtrip/contract.json`
 * 逐条钉住（Rust 侧的 `entry_path_problem` 注释也指向同一张表）。
 * 新增一个码 = 两侧各加一处实现 + 表里加一行；只在一侧加，对拍测试当场红。
 */
export type ZipContractCode =
  | 'path-empty-segment'
  | 'path-drive'
  | 'path-backslash'
  | 'path-absolute'
  | 'path-dotdot'
  /** 任一段尾随 `.` 或空格（Windows 落盘时静默剥掉，包内名字与落盘名字从此不是同一串） */
  | 'path-windows-unsafe'
  | 'path-depth'
  | 'entry-name-encoding'
  | 'entry-duplicate'
  | 'entries-limit'
  | 'bytes-limit'
  | 'container-zip64'
  | 'container-structure';

/** 解包侧的三个限额（**只从市场契约常量取**，本模块不写死第二份真相） */
export interface ZipContractLimits {
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly maxUnpackedBytes: number;
}

/** 限额的唯一取法：契约常量（`market.ts`）→ 解包契约形状 */
export const ZIP_EXTRACT_LIMITS: ZipContractLimits = {
  maxEntries: MARKET_MAX_FILE_ENTRIES,
  maxDepth: MARKET_MAX_PATH_DEPTH,
  maxUnpackedBytes: MARKET_MAX_UNPACKED_BYTES,
};

/** 条目名的 UTF-8 字节上限（ZIP 的 `file name length` 是 u16） */
export const ZIP_MAX_NAME_BYTES = 0xffff;

/** 暂存/容器名的字符集与长度闸（与 Rust `staging_component_problem` 逐字同源） */
export const ZIP_CONTAINER_NAME_MAX = 64;
const CONTAINER_NAME_BODY = /^[a-z0-9._-]+$/;

/**
 * 容器名字面闸：**TS 侧的唯一实现**，与 Rust `container_name_problem` 同一套规则。
 * 合法返回 `null`，非法返回**与人话同一句的拒因**（冒号前的那一段两侧逐字相同，
 * 对拍测试就比那一段——`{:?}` 调试引号那种语言差异不进契约）。
 *
 * 这条闸过去只在 Rust 有实现，TS 侧靠 `PACK_ID_RE`（≤ 64 的 **id**）间接兜着，
 * 于是 `id` 取满 64 字符时派生出的 `<id>-<version>.zip` 长 74 ⇒ 平台侧一句
 * "名字长度必须在 1..=64"把包拒在暂存区外。共享表的 `containerNames` 逐条钉住两侧同判。
 */
export function zipContainerNameProblem(name: string): string | null {
  if (name.length === 0 || name.length > ZIP_CONTAINER_NAME_MAX) {
    return `名字长度必须在 1..=${ZIP_CONTAINER_NAME_MAX}`;
  }
  if (!CONTAINER_NAME_BODY.test(name)) {
    return '名字只允许 [a-z0-9._-]（拒分隔符、反斜杠、盘符、大写）';
  }
  if (/^\.+$/.test(name)) return '名字不能是纯点名';
  if (!name.endsWith(MARKET_ZIP_SUFFIX) || name.length === MARKET_ZIP_SUFFIX.length) {
    return `容器名必须以 ${MARKET_ZIP_SUFFIX} 结尾且主体非空`;
  }
  return null;
}

/**
 * Windows 保留设备名（Win32 文件名判据：`CON` 本体与带扩展名变体都建不出来）。
 * 与 `packages/app/src/ui/file-tree-ops.ts` 的本地建名闸同源同表（那边多拦了历史 DOS 的
 * `CLOCK$`，现代 Win32 已不保留，本表不收——包侧假阳性会拒掉合法市场包，从严 only 本地）。
 */
const WINDOWS_RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * 条目名段是否命中 Windows 保留设备名（大小写不敏感；`CON` / `CON.txt` / `CON.tar.gz`
 * 同拒——Win32 取首个点前的主干判保留）。导出给 archive 名字闸复用，第二份表不存在。
 */
export function isWindowsReservedDeviceNameSegment(segment: string): boolean {
  const upper = segment.toUpperCase();
  const stem = upper.includes('.') ? upper.slice(0, upper.indexOf('.')) : upper;
  return WINDOWS_RESERVED_DEVICE_NAMES.has(upper) || WINDOWS_RESERVED_DEVICE_NAMES.has(stem);
}

/**
 * 单个条目名的闸（**容器里原样出现的那个名字**，不做 `\` → `/` 归一：
 * 反斜杠形态本身就是拒绝项 `path-backslash`）。判定顺序与 Rust 逐字一致。
 */
export function zipEntryContractProblem(
  name: string,
  maxDepth: number = ZIP_EXTRACT_LIMITS.maxDepth,
): ZipContractCode | null {
  if (name.length === 0) return 'path-empty-segment';
  // NUL 不是"路径段"问题，而是**根本无法成为一个文件名**：两侧都归到名字编码这一类
  if (name.includes('\0')) return 'entry-name-encoding';
  if (/^[A-Za-z]:/.test(name)) return 'path-drive';
  // 盘符位之外的 `:` 一律拒（NTFS 备用数据流 ADS 注入面，如 `file.txt:stream`）——
  // 复用 `path-drive` 码，与市场清单侧 `packEntryPathProblem` 以及 Rust 解包器同一条口径。
  if (name.includes(':')) return 'path-drive';
  if (name.includes('\\')) return 'path-backslash';
  if (name.startsWith('/')) return 'path-absolute';
  // 尾斜杠（目录条目）落进"空段"：平台解包器只准落普通文件，目录靠父目录自建
  const segments = name.split('/');
  if (segments.some((s) => s.length === 0 || s === '.')) return 'path-empty-segment';
  if (segments.some((s) => s === '..')) return 'path-dotdot';
  // 尾随 `.` / 空格：Windows 落盘时会静默剥掉（`a.txt.` → `a.txt`），包内名字与落盘名字
  // 从此不是同一串 ⇒ 与 Rust `entry_path_problem` 同判（码复用市场侧既有的
  // `path-windows-unsafe`，不新造码；判定顺序也一致：尾点/尾空格先于保留设备名）。
  if (segments.some((s) => s.endsWith('.') || s.endsWith(' '))) return 'path-windows-unsafe';
  // Windows 保留设备名段：归入既有 `entry-name-encoding` 码（NUL 同款先例——不是路径段
  // 问题，是"根本无法成为一个文件名"）。挂点在尾点/尾空格之后、depth 之前，既有码判定顺序
  // 不变；Rust 解包器（`archive_guard.rs::entry_path_problem`）在 L0 批补上同一条。
  if (segments.some((s) => isWindowsReservedDeviceNameSegment(s))) return 'entry-name-encoding';
  if (segments.length > maxDepth) return 'path-depth';
  return null;
}

/** 读出的容器条目（`readZipContainer` 的产物；字段全部来自中央目录，另有本地头核对结果） */
export interface ZipContainerEntry {
  /** 按 bit 11 解出来的名字（本模块写的包恒带 bit 11 ⇒ 恒为 UTF-8） */
  name: string;
  /** 中央目录里的**原始名字字节**（名字编码闸只看这个） */
  rawName: Uint8Array;
  /** general purpose bit flag（中央目录那份） */
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  /** 本地头起始偏移 */
  localOffset: number;
  /** 中央目录记录起始偏移（篡改用例按它定位） */
  centralOffset: number;
  /** 数据起始偏移（本地头 + 名 + extra 算出来的实际落点） */
  dataOffset: number;
  /** 原始负载字节（store = 内容本身；deflate = raw deflate 流） */
  payload: Uint8Array;
  /** 本地头与中央目录是否逐字段互指一致（签名、名字、flags、method、crc、两个尺寸） */
  localMatchesCentral: boolean;
}

/** 一次容器解析的结果 */
export interface ZipContainer {
  entries: ZipContainerEntry[];
  /** 中央目录/EOCD 里出现 ZIP64 哨兵或 ZIP64 定位记录 ⇒ 本契约明确不支持 */
  zip64: boolean;
  /** EOCD 声明的条目数（可能与实际读出的条数不符——不符即 `container-structure`） */
  declaredEntryCount: number;
  totalUnpackedBytes: number;
  /** 同一个中央目录被读器（Rust `zip` crate 同款口径）**按原始名字去重后**的条数。
   * 相等 = 没有重名条目；不等 ⇒ 这只容器交给读器会被静默合并，落盘内容已不是包里的内容 */
  dedupedEntryCount: number;
}

/** 容器结构本身不可信（签名错位、中央目录越界、本地头与中央目录不互指…） */
export class ZipContainerStructureError extends Error {
  readonly code = 'container-structure' as const;
  constructor(message: string) {
    super(`${'container-structure'}：${message}`);
    this.name = 'ZipContainerStructureError';
  }
}

const utf8Fatal = new TextDecoder('utf-8', { fatal: true });

/** 原始名字字节是否是一段合法 UTF-8 */
function isUtf8Bytes(bytes: Uint8Array): boolean {
  try {
    utf8Fatal.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * **最小容器读器**：EOCD → 中央目录 → 回到每条的本地头核互指字段。
 *
 * 存在的理由：写侧过去看不见自己写出去的东西，"打包成功"只等于"字节长度为正"。
 * 导出链路因此可以在交给用户之前把包读回来（`package-actions.ts` 的导出前自证），
 * 对拍测试也用它把篡改过的容器喂给同一份纯判定 `zipContainerContractProblem`。
 * 只读不落盘、不解压（`inflateZipEntry` 单独一条），结构违例直接抛
 * `ZipContainerStructureError`——那是"坏包"，不是"名字非法"。
 */
export function readZipContainer(bytes: Uint8Array): ZipContainer {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < EOCD_SIZE) throw new ZipContainerStructureError('字节数不足一个 EOCD');
  // EOCD 只能从尾部倒着找（前面可以有任意多的数据与注释）
  let eocd = -1;
  const scanFrom = Math.max(0, bytes.length - EOCD_SIZE - 0xffff);
  for (let i = bytes.length - EOCD_SIZE; i >= scanFrom; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      // 尾部剩下的字节必须正好等于"注释声明长度"，否则这个签名在注释里
      if (i + EOCD_SIZE + view.getUint16(i + 20, true) === bytes.length) {
        eocd = i;
        break;
      }
    }
  }
  if (eocd < 0) throw new ZipContainerStructureError('找不到 EOCD');
  if (eocd + EOCD_SIZE !== bytes.length && view.getUint16(eocd + 20, true) !== 0) {
    throw new ZipContainerStructureError('容器带注释，本契约不接受');
  }
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) {
    throw new ZipContainerStructureError('多磁盘容器不在契约内');
  }
  const declaredEntryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralStart = view.getUint32(eocd + 16, true);
  let zip64 =
    declaredEntryCount === ZIP64_SENTINEL_U16 ||
    centralSize === ZIP64_SENTINEL_U32 ||
    centralStart === ZIP64_SENTINEL_U32;
  // ZIP64 定位记录紧挨在 EOCD 之前（sig4 + 磁盘号4 + ZIP64 EOCD 偏移8 + 总磁盘数4 = 20 字节）
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === SIG_ZIP64_LOCATOR) {
    const z64Record = view.getUint32(eocd - 12, true); // 定位记录里那个 8 字节偏移的低 32 位
    if (z64Record + 4 <= bytes.length && view.getUint32(z64Record, true) !== SIG_ZIP64_EOCD) {
      throw new ZipContainerStructureError('ZIP64 定位记录指向的记录签名不符');
    }
    zip64 = true;
  }
  if (centralStart + centralSize > eocd) {
    throw new ZipContainerStructureError('中央目录越出容器边界');
  }
  // ZIP64 不在这条链路上"尽力读一读"：哨兵值把偏移与计数都替换成了 0xFFFF/0xFFFFFFFF，
  // 硬读只会读出一堆假条目。契约明确不支持，如实标出来交给 `zipContainerContractProblem` 判。
  if (zip64) {
    return {
      entries: [],
      zip64: true,
      declaredEntryCount,
      totalUnpackedBytes: 0,
      dedupedEntryCount: 0,
    };
  }

  const entries: ZipContainerEntry[] = [];
  let total = 0;
  let p = centralStart;
  for (let n = 0; n < declaredEntryCount; n++) {
    const centralOffset = p;
    if (p + 46 > bytes.length) throw new ZipContainerStructureError(`第 ${n} 条中央目录记录越界`);
    if (view.getUint32(p, true) !== SIG_CENTRAL) {
      throw new ZipContainerStructureError(`第 ${n} 条中央目录签名不符`);
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    // 变量段先核边界再取字节：越界的 `slice` 会**静默截断**，那正是"读出来少几个字节"的假成功
    if (p + 46 + nameLen + extraLen + commentLen > eocd) {
      throw new ZipContainerStructureError(`第 ${n} 条中央目录记录跨过 EOCD`);
    }
    const rawName = bytes.slice(p + 46, p + 46 + nameLen);
    const name = isUtf8Bytes(rawName) ? utf8Fatal.decode(rawName) : new TextDecoder().decode(rawName);
    p += 46 + nameLen + extraLen + commentLen;

    // 回到本地头：ZIP 的字节位置由**本地头**的两个长度字段决定，而校验与尺寸由**中央目录**说话，
    // 两者不互指就是坏包（解出来是错字节）。这条不变量只有读侧能证伪。
    if (localOffset + 30 > bytes.length) {
      throw new ZipContainerStructureError(`第 ${n} 条的本地头偏移越界`);
    }
    if (view.getUint32(localOffset, true) !== SIG_LOCAL) {
      throw new ZipContainerStructureError(`第 ${n} 条的本地头签名不符`);
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCrc = view.getUint32(localOffset + 14, true);
    const localCompressed = view.getUint32(localOffset + 18, true);
    const localUncompressed = view.getUint32(localOffset + 22, true);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
    if (dataOffset + compressedSize > bytes.length) {
      throw new ZipContainerStructureError(`第 ${n} 条的数据越界`);
    }
    const localName = bytes.slice(localOffset + 30, localOffset + 30 + localNameLen);
    const localMatchesCentral =
      localNameLen === nameLen &&
      uint8ArrayEq(localName, rawName) &&
      localFlags === flags &&
      localMethod === method &&
      localCrc === crc &&
      localCompressed === compressedSize &&
      localUncompressed === uncompressedSize;
    if (!localMatchesCentral) {
      throw new ZipContainerStructureError(`第 ${n} 条的本地头与中央目录不互指`);
    }
    total += uncompressedSize;
    entries.push({
      name,
      rawName,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      centralOffset,
      dataOffset,
      payload: bytes.slice(dataOffset, dataOffset + compressedSize),
      localMatchesCentral: true,
    });
  }
  if (p !== eocd) throw new ZipContainerStructureError('中央目录没有刚好走到 EOCD');
  return {
    entries,
    zip64: false,
    declaredEntryCount,
    totalUnpackedBytes: total,
    dedupedEntryCount: new Set(entries.map((e) => e.name)).size,
  };
}

function uint8ArrayEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 容器级契约判定（纯函数，吃 `readZipContainer` 的结果）。
 * 返回首个违例的 `拒绝码：人话`，合法返回 `null`——**首个即拒**与解包侧同一口径。
 *
 * 覆盖解包侧全部四条硬闸：条目名形态、名字编码（bit 11 / UTF-8 / NUL）、
 * 重名（精确 + 大小写折叠，Windows 文件系统不区分大小写）、条目数与解压总字节。
 */
export function zipContainerContractProblem(
  container: ZipContainer,
  limits: ZipContractLimits = ZIP_EXTRACT_LIMITS,
): string | null {
  if (container.zip64) return 'container-zip64：容器使用 ZIP64，平台解包器不接受';
  if (container.entries.length !== container.declaredEntryCount) {
    return `container-structure：EOCD 声明 ${container.declaredEntryCount} 条，实际读出 ${container.entries.length} 条`;
  }
  if (container.entries.length > limits.maxEntries) {
    return `entries-limit：条目数 ${container.entries.length} 超过上限 ${limits.maxEntries}`;
  }
  if (container.totalUnpackedBytes > limits.maxUnpackedBytes) {
    return `bytes-limit：声明解压总字节 ${container.totalUnpackedBytes} 超过上限 ${limits.maxUnpackedBytes}`;
  }
  const seen = new Set<string>();
  for (const entry of container.entries) {
    const pathProblem = zipEntryContractProblem(entry.name, limits.maxDepth);
    if (pathProblem !== null) return `${pathProblem}：条目路径非法 ${JSON.stringify(entry.name)}`;
    if (entry.rawName.length > ZIP_MAX_NAME_BYTES) {
      return `entry-name-encoding：条目名 UTF-8 ${entry.rawName.length} 字节 > ${ZIP_MAX_NAME_BYTES}`;
    }
    if (!isUtf8Bytes(entry.rawName)) {
      return `entry-name-encoding：条目名不是合法 UTF-8：${JSON.stringify(entry.name)}`;
    }
    // bit 11 缺失 + 名字含非 ASCII ⇒ 解包器按 CP437 解码，落盘文件名与包内名字不是同一串
    const nonAscii = entry.rawName.some((b) => b >= 0x80);
    if (nonAscii && (entry.flags & ZIP_FLAG_UTF8) === 0) {
      return `entry-name-encoding：条目名含非 ASCII 却没置 UTF-8 标志位（bit 11）：${JSON.stringify(entry.name)}`;
    }
    if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) {
      return `container-structure：条目 ${JSON.stringify(entry.name)} 用了契约外的压缩法 ${entry.method}`;
    }
    if (!entry.localMatchesCentral) {
      return `container-structure：条目 ${JSON.stringify(entry.name)} 的本地头与中央目录不互指`;
    }
    const key = entry.name.toLowerCase();
    if (seen.has(key)) {
      return `entry-duplicate：条目路径重复 ${JSON.stringify(entry.name)}`;
    }
    seen.add(key);
  }
  return null;
}

/** 解出一个条目的原始字节（deflate 走平台 `DecompressionStream('deflate-raw')`） */
export async function inflateZipEntry(entry: ZipContainerEntry): Promise<Uint8Array> {
  if (entry.method === METHOD_STORE) return entry.payload;
  if (entry.method !== METHOD_DEFLATE) {
    throw new ZipContainerStructureError(`压缩法 ${entry.method} 不在契约内`);
  }
  const DS = (globalThis as { DecompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array> })
    .DecompressionStream;
  if (typeof DS !== 'function') {
    throw new ZipContainerStructureError('平台没有 DecompressionStream，解不了 deflate 条目');
  }
  // `payload.slice()` 复制到独立 buffer：`BlobPart` 在 DOM/node 两套类型下都要求
  // 底层 ArrayBuffer 不与 `bytes` 的视图偏移共享（与 `sav-parser/gunzip.ts` 同一口径）
  const input = new Blob([entry.payload.slice()]).stream();
  const inflated = input.pipeThrough(new DS('deflate-raw'));
  const buf = await new Response(inflated as unknown as ReadableStream).arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.length !== entry.uncompressedSize) {
    throw new ZipContainerStructureError(
      `条目 ${JSON.stringify(entry.name)} 解出 ${bytes.length} 字节，中央目录声明 ${entry.uncompressedSize}`,
    );
  }
  if (crc32(bytes) !== entry.crc) {
    throw new ZipContainerStructureError(`条目 ${JSON.stringify(entry.name)} 的 CRC32 与中央目录不符`);
  }
  return bytes;
}

/**
 * 写侧的守契约判定（`contract: 'extractable'` 用）：条目名与规模全部按解包侧的闸过一遍。
 * 违例返回 `${拒绝码}：人话`（与解包侧报错同一形状），合法返回 `null`。
 * 入参是**已归一**的名字（`normalizeEntryName` 之后）加原始字节数——目录条目在这一档被拒。
 */
function extractableProblem(
  entries: readonly { name: string; bytes: number }[],
  limits: ZipContractLimits = ZIP_EXTRACT_LIMITS,
): string | null {
  if (entries.length > limits.maxEntries) {
    return `entries-limit：条目数 ${entries.length} 超过上限 ${limits.maxEntries}`;
  }
  let total = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    const code = zipEntryContractProblem(entry.name, limits.maxDepth);
    if (code !== null) return `${code}：条目路径非法 ${JSON.stringify(entry.name)}`;
    if (entry.name.endsWith('/')) {
      return `path-empty-segment：平台解包器不落目录条目：${JSON.stringify(entry.name)}`;
    }
    const nameBytes = new TextEncoder().encode(entry.name).length;
    if (nameBytes > ZIP_MAX_NAME_BYTES) {
      return `entry-name-encoding：条目名 UTF-8 ${nameBytes} 字节 > ${ZIP_MAX_NAME_BYTES}`;
    }
    const key = entry.name.toLowerCase();
    if (seen.has(key)) return `entry-duplicate：条目路径重复 ${JSON.stringify(entry.name)}`;
    seen.add(key);
    total += entry.bytes;
    if (total > limits.maxUnpackedBytes) {
      return `bytes-limit：解压总字节 ${total} 超过上限 ${limits.maxUnpackedBytes}`;
    }
  }
  return null;
}

/** 期望回来的那一条（与 `ZipEntry` 同名同义，只是不认目录条目那一档的字段） */
export interface ZipExpectation {
  name: string;
  data: Uint8Array;
}

/**
 * **往返自证**：把刚打好的容器读回来，走一遍解包侧的契约判定，再逐条目核
 * 名字、字节数、CRC、以及 inflate 出来的内容；全通过返回 `null`，
 * 否则返回**首个**问题的 `${拒绝码}：人话`。
 *
 * 为什么需要它：打包（TS）与解包（Rust）分家于两种语言，写侧过去对"自己写出了什么"
 * 零感知——本地头与中央目录不互指、CRC 不符、名字被截断这类结构性毛病，唯一会知道的人
 * 是解包失败那一刻的用户。这一条把发现点挪回写侧（几十个小文本文件的额外一趟 inflate，
 * 毫秒级），并与 `market_tests.rs` 的解包判据共用同一张共享表钉住的同一套拒绝码。
 */
export async function verifyZipRoundtrip(
  bytes: Uint8Array,
  expected: readonly ZipExpectation[],
  limits: ZipContractLimits = ZIP_EXTRACT_LIMITS,
): Promise<string | null> {
  let container: ZipContainer;
  try {
    container = readZipContainer(bytes);
  } catch (err: unknown) {
    return err instanceof Error ? err.message : `container-structure：${String(err)}`;
  }
  const problem = zipContainerContractProblem(container, limits);
  if (problem !== null) return problem;
  if (container.entries.length !== expected.length) {
    return `container-structure：包内 ${container.entries.length} 条，期望 ${expected.length} 条`;
  }
  for (let i = 0; i < container.entries.length; i++) {
    const entry = container.entries[i]!;
    const want = expected[i]!;
    const wantName = normalizeEntryName(want.name);
    if (entry.name !== wantName) {
      return `container-structure：第 ${i} 条名字往返不符（包内 ${JSON.stringify(entry.name)}，期望 ${JSON.stringify(wantName)}）`;
    }
    if (entry.uncompressedSize !== want.data.length) {
      return `entry-bytes：${JSON.stringify(wantName)} 字节数往返不符（包内 ${entry.uncompressedSize}，期望 ${want.data.length}）`;
    }
    if (entry.crc !== crc32(want.data)) {
      return `entry-bytes：${JSON.stringify(wantName)} 的 CRC32 与期望内容不符`;
    }
    const back = await inflateZipEntry(entry);
    if (!uint8ArrayEq(back, want.data)) {
      return `entry-bytes：${JSON.stringify(wantName)} 内容逐字节往返不符`;
    }
  }
  return null;
}

/* ------------------------------ DOS 时间 ------------------------------ */

/** epoch ms → ZIP 的 DOS date/time（1980 起算；更早夹到 1980-01-01） */
export function dosDateTime(epochMs: number): { date: number; time: number } {
  const d = new Date(epochMs);
  const year = Math.max(DOS_EPOCH_YEAR, d.getFullYear());
  return {
    date: ((year - DOS_EPOCH_YEAR) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
  };
}

/* ------------------------------ deflate ------------------------------ */

/**
 * raw deflate。平台不支持（无 `CompressionStream`）→ 返回 `null`，调用方退回 store。
 * 单独导出是为了让"压缩不可用"这条降级路径可被单测直接驱动。
 */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: new (format: string) => CompressionStreamLike })
    .CompressionStream;
  if (typeof CS !== 'function' || data.length === 0) return null;
  try {
    const cs = new CS('deflate-raw');
    const writer = cs.writable.getWriter();
    void writer.write(data);
    void writer.close();
    // 借 Response 把 readable 收成整块字节（WebView2 / Node 18+ 都有 Response）
    const buf = await new Response(cs.readable as unknown as ReadableStream).arrayBuffer();
    const bytes = new Uint8Array(buf);
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null; // 压缩是加分项：任何异常都退回 store，绝不因此丢文件
  }
}

/** 只用得到的那一小块 `CompressionStream` 形状（不依赖 DOM lib 的具体版本） */
interface CompressionStreamLike {
  readable: unknown;
  writable: WritableStream<Uint8Array>;
}

/* ------------------------------ 组装 ------------------------------ */

interface Prepared {
  nameBytes: Uint8Array;
  method: number;
  payload: Uint8Array;
  crc: number;
  uncompressedSize: number;
  localOffset: number;
  isDir: boolean;
}

/**
 * 把条目集打成一个 ZIP 文件的字节。
 *
 * 顺序：逐条目写本地头 + 数据，同时攒中央目录记录，最后写中央目录 + EOCD。
 * 全量在内存里拼（口上包量级 = 几十个小文本文件，最坏几 MB），不做流式输出——
 * 流式会让"先算 CRC 再回头写头"这件事复杂化，而这里没有任何体积压力值得那样换。
 */
export async function buildZip(entries: readonly ZipEntry[], opts: ZipOptions = {}): Promise<Uint8Array> {
  const when = dosDateTime(opts.date ?? Date.now());
  const tryCompress = opts.compress !== false;
  const prepared: Prepared[] = [];

  // 契约档：在**一个字节都没开始拼之前**把整张条目表过一遍解包侧的闸
  // （拒在压缩之前，才不至于让作者等一次转译 + 一次压缩才拿到一句"这包平台解不开"）。
  // 名字先做**分隔符归一**再判：`\` → `/` 是写侧对作者输入的容错，归一之后还违例的
  // 才是真毛病；判定与报错都用解包侧那套拒绝码（不再另造一句只此一层认识的话）。
  if (opts.contract === 'extractable') {
    const limits = opts.limits ?? ZIP_EXTRACT_LIMITS;
    const problem = extractableProblem(
      entries.map((e) => ({ name: e.name.replaceAll('\\', '/'), bytes: e.data.length })),
      limits,
    );
    if (problem !== null) throw new Error(problem);
  }

  for (const entry of entries) {
    const name = normalizeEntryName(entry.name);
    const isDir = name.endsWith('/');
    const raw = isDir ? new Uint8Array(0) : entry.data;
    let method = METHOD_STORE;
    let payload = raw;
    if (tryCompress && !isDir && raw.length > 0) {
      const zipped = await deflateRaw(raw);
      // 只有"真的变小了"才用 deflate（规矩 3）
      if (zipped !== null && zipped.length < raw.length) {
        method = METHOD_DEFLATE;
        payload = zipped;
      }
    }
    prepared.push({
      nameBytes: new TextEncoder().encode(name),
      method,
      payload,
      crc: isDir ? 0 : crc32(raw),
      uncompressedSize: raw.length,
      localOffset: 0, // 下面第二遍填
      isDir,
    });
  }

  // 第一遍算总长度，一次分配（避免边拼边扩容）
  let total = 0;
  for (const p of prepared) {
    total += 30 + p.nameBytes.length + p.payload.length; // 本地头 + 名 + 数据
  }
  let centralSize = 0;
  for (const p of prepared) {
    centralSize += 46 + p.nameBytes.length;
  }
  if (prepared.length > 0xffff) {
    throw new Error(`ZIP 条目数 ${prepared.length} 超过 ZIP64 门槛 65,535（本模块刻意不支持 ZIP64）`);
  }
  if (total + centralSize + 22 > 0xffffffff) {
    throw new Error('ZIP 总体积超过 4 GiB（ZIP64 门槛），本模块不支持');
  }

  const out = new Uint8Array(total + centralSize + 22);
  const view = new DataView(out.buffer);
  let off = 0;
  const u16 = (v: number) => { view.setUint16(off, v, true); off += 2; };
  const u32 = (v: number) => { view.setUint32(off, v >>> 0, true); off += 4; };
  const put = (bytes: Uint8Array) => { out.set(bytes, off); off += bytes.length; };

  for (const p of prepared) {
    p.localOffset = off;
    u32(SIG_LOCAL);
    u16(VERSION_NEEDED);
    u16(ZIP_FLAG_UTF8);
    u16(p.method);
    u16(when.time);
    u16(when.date);
    u32(p.crc);
    u32(p.payload.length);
    u32(p.uncompressedSize);
    u16(p.nameBytes.length);
    u16(0); // extra field length
    put(p.nameBytes);
    put(p.payload);
  }

  const centralStart = off;
  for (const p of prepared) {
    u32(SIG_CENTRAL);
    u16(VERSION_NEEDED); // version made by
    u16(VERSION_NEEDED); // version needed to extract
    u16(ZIP_FLAG_UTF8);
    u16(p.method);
    u16(when.time);
    u16(when.date);
    u32(p.crc);
    u32(p.payload.length);
    u32(p.uncompressedSize);
    u16(p.nameBytes.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk number start
    u16(0); // internal attributes
    u32(0); // external attributes（目录条目也不置 0x10：靠名字尾斜杠表达，跨工具更稳）
    u32(p.localOffset);
    put(p.nameBytes);
  }
  // 必须在写 EOCD **之前**定格：`u32/u16` 会推进 `off`，等写完前缀再算就多算 12 字节，
  // 于是"中央目录紧接 EOCD"这条不变量被破坏（部分解压工具直接判坏包）。
  const centralEnd = off;

  u32(SIG_EOCD);
  u16(0); // this disk
  u16(0); // disk with central directory
  u16(prepared.length);
  u16(prepared.length);
  u32(centralEnd - centralStart); // central directory size
  u32(centralStart);
  u16(0); // comment length

  return out;
}
