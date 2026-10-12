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
 */

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
}

/** ZIP 里 DOS 时间戳的合法年份下限（1980）；更早的 mtime 会被夹到这一天 */
const DOS_EPOCH_YEAR = 1980;
/** general purpose bit flag：bit 11 = 文件名/注释用 UTF-8 */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** version needed to extract = 2.0（deflate 与 store 都是 20） */
const VERSION_NEEDED = 20;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

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
  if (bytes.length > 0xffff) throw new Error(`ZIP 条目名过长（UTF-8 ${bytes.length} 字节 > 65535）：${name}`);
  return slashed;
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
    u16(FLAG_UTF8);
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
    u16(FLAG_UTF8);
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
