import type {
  BackupVersion,
  BatchFileStat,
  DirEntry,
  FileEncoding,
  FileIO,
  FilePickFilter,
  FileStat,
  Logger,
  PlatformBridge,
  RawFileRead,
  TextFile,
  TrashEntry,
  WalkOptions,
  WriteTextOptions,
} from '@kojo/plugin-api';
import { WriteNotAllowedError } from '@kojo/plugin-api';
import {
  applyEol,
  decodeWithProbe,
  detectEol,
  joinPreserveEol,
  normalizeEol,
  probeEncoding,
  reconstructEol,
  splitPreserveEol,
  withUtf16Bom,
  type EolMap,
} from './encoding';
import { basename, isPathUnder, join, pathKey } from '@kojo/plugin-api';
import { TrashManager } from './trash';

/**
 * 文件 IO 服务实现。
 *
 * 安全模型（架构文档 §3.4 "游戏目录整体只读假设"）：
 * - 写路径白名单：默认空（一切拒绝）；项目打开并由用户批准后 setWritableRoots 放行；
 * - 越权写入抛 WriteNotAllowedError——写保护是内核级不变量，不依赖调用方自觉；
 * - 写前自动备份（{appDataDir}/backup/，按文件保留最近 N 版）+ 原子写（平台桥保证）；
 * - 编码保持：读时探测并缓存，写时默认 'preserve'（一次保存毁半库是历史教训）；
 * - **双闸并存**（v0.2 第十四批，审阅 M3）：本层白名单是第一道闸（判定域 = 用户批准的
 *   writablePaths，是项目根的子集）；Tauri 宿主 Rust 侧另有写允许域第二道闸
 *   （判定域 = 项目根整体 + appDataDir，project.opened 注册 / project.closed 清除）。
 *   两闸语义以更严者为准；本层契约与行为不变。
 */

const BACKUP_KEEP_PER_FILE = 20;

/* --------------------------- 批量读参数（2026-10-16 批量 IO 批） --------------------------- */

/**
 * `readTexts` 的读批大小：一次 `readFilesRaw` 的帧大小 ≈ 批大小 × 单文件均长。
 * 64 × 60KB ≈ 4MB/帧——IPC 一趟的合理量级，同时把解帧+解码的单段主线程时间压在毫秒级。
 */
const READ_BATCH_SIZE = 64;
/** 批量 stat 的分块（小载荷；分块只为不让单次 JSON 失控，与读批可不同） */
const STAT_CHUNK_SIZE = 512;

/**
 * 会话文本缓存上限（**两把尺同时生效**，先到先削）。
 *
 * 取值的依据（这是"后续抽取/校验阶段零重复读盘"的成立条件——STOP 门槛）：
 * 真实口上域约 2,317 文件 / 144MB（utf-8 字节）/ 3.6M 行（历史实测），
 * 混合中日文与 ERB 语法后约 5–9 千万个 UTF-16 code unit（映射到 JS 堆约 100–180MB）；
 * 两把尺都留一倍量级余量，低于它冷开时抽取/校验段会出现"缓存已被解析段挤掉"
 * 的重读——那正是本批要消掉的数千次单文件读（2,000 文件合成探针在 96M 字符
 * 上限下实测被削掉 347 个文件、引出 347 次重读，故这版取 128M）。
 */
const TEXT_CACHE_MAX_FILES = 4096;
const TEXT_CACHE_MAX_CHARS = 128 * 1024 * 1024;

/**
 * 原文换行指纹缓存上限（{@link EolMap}）：只为"保换行逐行还原"服务。
 * 尺子取字符数（parts 拼接长度），与文本缓存同数量级但留更紧——指纹可即时重算，
 * 丢几热的代价只是"下一次无关保存少认几行原换行"，不是数据损坏。
 */
const EOLMAP_CACHE_MAX_FILES = 8192;
const EOLMAP_CACHE_MAX_CHARS = 96 * 1024 * 1024;

/**
 * 原文**字节**快照上限（零改动保存的逐字节直写快道）：字节比文本大，留最小的量级，
 * 只用来兜住"GBK/SJIS 等未被编码表覆盖的文件在零改动保存时被解码→重编码毁字节"这一最坏形状。
 * 超尺从队首削；丢了就退回逐行还原（真 UTF-8/SJIS 文件仍字节级一致）。
 */
const RAW_BYTES_CACHE_MAX_FILES = 1024;
const RAW_BYTES_CACHE_MAX_BYTES = 64 * 1024 * 1024;

interface TextCacheEntry {
  /** 校验判据（与批量 stat 的值同源）：mtime+size 皆非空且全等才命中 */
  mtimeMs: number | null;
  size: number | null;
  file: TextFile;
}

/** FNV-1a 32 位哈希（备份桶 / 回收站条目 id 的身份尺；输入先经 pathKey 折叠写法） */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 本地时刻文件名段（备份版本 / 回收站条目 / ops journal id 共用同一形态） */
export function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/** 备份版本文件名（timestamp() 的唯一合法形态；列举与恢复都按此认，别放宽） */
export const BACKUP_VERSION_RE = /^\d{8}-\d{6}-\d{3}\.bak$/;

/** 备份桶目录段名（backup() 的落点；哈希段才是身份，前缀只是人读便利） */
export function backupBucketName(absPath: string): string {
  return `${basename(absPath).slice(0, 40).replace(/[^A-Za-z0-9._-]/g, '_')}-${backupHashOf(absPath)}`;
}

/** 备份桶属主清单文件名（桶内固定名；记 pathKey 原文，读侧比对防碰撞串桶） */
export const BACKUP_OWNER_FILE = 'owner.json';

/**
 * 文件 → 备份桶哈希（身份尺：`pathKey` 折叠大小写与分隔符）。
 * 列举/恢复**按哈希后缀找桶**而不是重拼段名——写侧段名取的是当时的 basename 原样，
 * 同一个文件 "事件.ERB / 事件.erb" 两种写法会落进两个前缀；只认哈希才读得回全部版本。
 */
export function backupHashOf(absPath: string): string {
  return fnv1a(pathKey(absPath));
}

/** 从版本文件名解析本地时刻（ms）；形态不对返回 null（判据不猜） */
export function parseBackupTakenAtMs(id: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})\.bak$/.exec(id);
  if (!m) return null;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    Number(m[7]),
  );
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export class FileIOServiceImpl implements FileIO {
  private writableRoots: string[] = [];
  /** 应用自有常驻可写根（工作区等；不受 setWritableRoots([]) 收回影响） */
  private appWritableRoots: string[] = [];
  private readonly encodingCache = new Map<string, FileEncoding>();
  private readonly eolCache = new Map<string, 'crlf' | 'lf'>();
  /**
   * 原文逐行换行指纹（内部结构；不改 readText/writeText 对外签名）——
   * 让"保换行"写回时**未改动的行保留其原始换行**，只有创建/改动行采用多数派。
   */
  private readonly eolMapCache = new Map<string, EolMap>();
  private eolMapChars = 0;
  /**
   * 原文**字节**快照（零改动保存的逐字节直写快道）：模型文本与原文逐行全等 ⇒
   * 直接把当初读到的字节原样落盘，绕开"解码→重编码"（GBK 等未覆盖编码毁字节的根因）。
   */
  private readonly rawBytesCache = new Map<string, Uint8Array>();
  private rawBytesTotal = 0;
  /** 回收站（2026-10-16 undo 批）：removeDir/removeFile 的落点从"直接删"改为"移入" */
  private readonly trash: TrashManager;
  /**
   * 会话级文本缓存（**只服务 `readTexts` 批量路径**；`readText` 单文件路径不接——
   * 打开文件永远新鲜读盘，编辑器语义）。
   *
   * FIFO（Map 插入序）：命中不动序（热点文件反复命中时不被反复推新，序更稳）；
   * 重新读入=重新插入（挪到队尾）。写路径（writeText / writeBytes / restoreBackup）
   * 失效对应 path——"刚写完再批量读"必须看到新内容。
   */
  private readonly textCache = new Map<string, TextCacheEntry>();
  /** 缓存占用（UTF-16 code unit 计；字符串长度是内存量的可靠下界代理） */
  private textCacheChars = 0;
  private textCacheHits = 0;
  private textCacheMisses = 0;
  private readonly textCacheMaxFiles: number;
  private readonly textCacheMaxChars: number;

  constructor(
    private readonly bridge: PlatformBridge,
    private readonly log?: Logger,
    /**
     * 会话文本缓存上限的测试注入口（additive；缺省 = 上文两把尺）。
     * 只为让"超限削最旧"这条纪律能被廉价地钉死——生产调用方零改动。
     */
    cacheCaps: { maxFiles?: number; maxChars?: number } = {},
  ) {
    this.textCacheMaxFiles = cacheCaps.maxFiles ?? TEXT_CACHE_MAX_FILES;
    this.textCacheMaxChars = cacheCaps.maxChars ?? TEXT_CACHE_MAX_CHARS;
    this.trash = new TrashManager(bridge, log);
  }

  /* ------------------------------ 读 ------------------------------ */

  async readText(path: string): Promise<TextFile> {
    // 读字节与 stat **互不依赖**：一起发出，别再串行等一个 RTT（§5.117）。
    // 冷开一次要读 6,855 个文件（抽取 2,285 + 逐文件校验 4,570），每次都白等一趟。
    const bytesCall = this.bridge.readFileBytes(path);
    const statCall = this.bridge.stat(path);
    // 给 stat 分支一个"已处理"的落点，免得它在读路先失败时变成 unhandled rejection；
    // 真正的异常仍由下面 await 抛出，语义与串行版一致（不吞错）。
    statCall.catch(() => {});
    const bytes = await bytesCall;
    // 探测+解码一次做完（2026-10-16 批量 IO 批）：旧的 probeEncoding+decode 是
    // "全文 fatal 校验一遍 + 全文解码一遍"的双重成本，这里省掉第一遍。
    const { text: raw, encoding } = decodeWithProbe(bytes);
    const eol = detectEol(raw);
    const text = normalizeEol(raw);
    const key = pathKey(path);
    this.encodingCache.set(key, encoding);
    this.eolCache.set(key, eol);
    this.putEolMap(key, raw);
    this.putRawBytes(key, bytes);
    const st = await statCall;
    return { path, text, encoding, eol, mtimeMs: st?.mtimeMs ?? null };
  }

  /**
   * 批量读文本（2026-10-16 批量 IO 批）：
   * 批量 stat 校验会话缓存 → 未命中者按批 `readFilesRaw`（每批一趟 IPC）→ 逐文件解码。
   * 失败位为 null（与 `readText` 抛错的失败条件一致；批量语义下不整批抛）。
   */
  async readTexts(paths: readonly string[]): Promise<Array<TextFile | null>> {
    if (paths.length === 0) return [];
    const out: Array<TextFile | null> = new Array(paths.length).fill(null);

    // 1) 缓存命中判定：批量 stat（小载荷）。mtime+size 任一缺失或不等 ⇒ 判未命中（保守）。
    const missIdx: number[] = [];
    for (let start = 0; start < paths.length; start += STAT_CHUNK_SIZE) {
      const end = Math.min(start + STAT_CHUNK_SIZE, paths.length);
      const chunk = paths.slice(start, end);
      const stats = await this.bridge.statFiles(chunk);
      for (let k = 0; k < chunk.length; k++) {
        const st: BatchFileStat | undefined = stats[k];
        const key = pathKey(chunk[k]!);
        const cached = this.textCache.get(key);
        if (
          cached &&
          st?.exists === true &&
          st.mtimeMs !== null &&
          st.size !== null &&
          cached.mtimeMs !== null &&
          cached.size !== null &&
          cached.mtimeMs === st.mtimeMs &&
          cached.size === st.size
        ) {
          out[start + k] = cached.file;
          this.textCacheHits++;
        } else {
          missIdx.push(start + k);
        }
      }
    }

    // 2) 未命中：按批读（一批一趟 IPC），逐文件解码、入缓存
    for (let start = 0; start < missIdx.length; start += READ_BATCH_SIZE) {
      const idx = missIdx.slice(start, start + READ_BATCH_SIZE);
      const chunkPaths = idx.map((i) => paths[i]!);
      const reads = await this.bridge.readFilesRaw(chunkPaths);
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k]!;
        const path = paths[i]!;
        const r: RawFileRead | undefined = reads[k];
        if (!r || r.status !== 'ok') {
          // 失败可见（不静默）：批量读的失败位在契约里就是 null，日志给出原因类别
          this.textCacheMisses++;
          this.log?.warn(
            `readTexts: 读失败（${r?.status ?? 'missing-entry'}）：${path}`,
          );
          continue;
        }
        const { text: raw, encoding } = decodeWithProbe(r.data);
        const eol = detectEol(raw);
        const tf: TextFile = {
          path,
          text: normalizeEol(raw),
          encoding,
          eol,
          mtimeMs: r.mtimeMs,
        };
        out[i] = tf;
        this.textCacheMisses++;
        // 与 readText 同口径的编码/EOL/换行指纹/字节快照缓存（写回 preserve 的判据）
        const key = pathKey(path);
        this.encodingCache.set(key, encoding);
        this.eolCache.set(key, eol);
        this.putEolMap(key, raw);
        this.putRawBytes(key, r.data);
        this.putTextCache(key, { mtimeMs: r.mtimeMs, size: r.size ?? r.data.length, file: tf });
      }
    }
    return out;
  }

  /** 入缓存（FIFO：重读=重新入队尾；超尺从队首削） */
  private putTextCache(key: string, entry: TextCacheEntry): void {
    const existing = this.textCache.get(key);
    if (existing) {
      this.textCacheChars -= existing.file.text.length;
      this.textCache.delete(key);
    }
    this.textCache.set(key, entry);
    this.textCacheChars += entry.file.text.length;
    while (this.textCache.size > this.textCacheMaxFiles || this.textCacheChars > this.textCacheMaxChars) {
      const oldest = this.textCache.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.textCache.get(oldest);
      this.textCache.delete(oldest);
      if (evicted) this.textCacheChars -= evicted.file.text.length;
    }
  }

  /** 入缓存换行指纹（FIFO：重读=重新入队尾；超尺从队首削）。raw = 原文（未归一化）。 */
  private putEolMap(key: string, raw: string): void {
    const map = splitPreserveEol(raw);
    const len = raw.length;
    const prev = this.eolMapCache.get(key);
    if (prev) {
      this.eolMapCache.delete(key);
      this.eolMapChars -= this.eolMapLen(prev);
    }
    this.eolMapCache.set(key, map);
    this.eolMapChars += len;
    while (this.eolMapCache.size > EOLMAP_CACHE_MAX_FILES || this.eolMapChars > EOLMAP_CACHE_MAX_CHARS) {
      const oldest = this.eolMapCache.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.eolMapCache.get(oldest);
      this.eolMapCache.delete(oldest);
      if (evicted) this.eolMapChars -= this.eolMapLen(evicted);
    }
  }

  private eolMapLen(map: EolMap): number {
    // parts 总长 + terms 每段一 code unit（近似原文件字符数，作 FIFO 尺子）
    let n = 0;
    for (const p of map.parts) n += p.length;
    for (const t of map.terms) n += t.length;
    return n;
  }

  /** 入缓存原文字节快照（零改动直写快道）；FIFO 超尺从队首削 */
  private putRawBytes(key: string, bytes: Uint8Array): void {
    const prev = this.rawBytesCache.get(key);
    if (prev) {
      this.rawBytesCache.delete(key);
      this.rawBytesTotal -= prev.length;
    }
    this.rawBytesCache.set(key, bytes);
    this.rawBytesTotal += bytes.length;
    while (
      this.rawBytesCache.size > RAW_BYTES_CACHE_MAX_FILES ||
      this.rawBytesTotal > RAW_BYTES_CACHE_MAX_BYTES
    ) {
      const oldest = this.rawBytesCache.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.rawBytesCache.get(oldest);
      this.rawBytesCache.delete(oldest);
      if (evicted) this.rawBytesTotal -= evicted.length;
    }
  }

  /**
   * 失效某 path 的**全部**内容相关缓存（文本/换行指纹/字节快照）——写路径调用：
   * 刚写完（或外部字节改动）后再读必须是新真相。writeText / writeBytes / restoreBackup
   * 在盘上落下新内容后会即时用新内容回填指纹与快照，removeFile / copyFile 只清不回填。
   */
  private invalidateTextCache(path: string): void {
    const key = pathKey(path);
    const existing = this.textCache.get(key);
    if (existing) {
      this.textCache.delete(key);
      this.textCacheChars -= existing.file.text.length;
    }
    const prevMap = this.eolMapCache.get(key);
    if (prevMap) {
      this.eolMapCache.delete(key);
      this.eolMapChars -= this.eolMapLen(prevMap);
    }
    const prevBytes = this.rawBytesCache.get(key);
    if (prevBytes) {
      this.rawBytesCache.delete(key);
      this.rawBytesTotal -= prevBytes.length;
    }
  }

  readBytes(path: string): Promise<Uint8Array> {
    return this.bridge.readFileBytes(path);
  }

  /**
   * 批量读原始字节（2026-10-16 市场与导入 IO 批）：按 `READ_BATCH_SIZE` 分批走
   * `readFilesRaw`（一批一趟 IPC，Tauri 侧二进制帧）。
   *
   * **刻意不进会话文本缓存**（与 `readTexts` 的差别）：本方法的用途是"把刚落盘的那一份
   * 字节读回来算校验锚"，缓存会让锚变成上一版的锚；口径与 `readBytes` 一致 = 每次真读盘。
   * 逐文件失败位为 `null` 并出声（批量语义不整批抛；失败条件与 `readBytes` 抛错一致）。
   */
  async readBytesMany(paths: readonly string[]): Promise<Array<Uint8Array | null>> {
    const out: Array<Uint8Array | null> = new Array<Uint8Array | null>(paths.length).fill(null);
    for (let start = 0; start < paths.length; start += READ_BATCH_SIZE) {
      const idx: number[] = [];
      const chunk: string[] = [];
      for (let k = start; k < Math.min(start + READ_BATCH_SIZE, paths.length); k++) {
        idx.push(k);
        chunk.push(paths[k]!);
      }
      const reads = await this.bridge.readFilesRaw(chunk);
      for (let k = 0; k < idx.length; k++) {
        const r: RawFileRead | undefined = reads[k];
        if (!r || r.status !== 'ok') {
          this.log?.warn(`readBytesMany: 读失败（${r?.status ?? 'missing-entry'}）：${chunk[k]!}`);
          continue;
        }
        out[idx[k]!] = r.data;
      }
    }
    return out;
  }

  /* ------------------------------ 写 ------------------------------ */

  async writeText(path: string, text: string, opts?: WriteTextOptions): Promise<void> {
    this.assertWritable(path);

    const key = pathKey(path);
    let encoding: FileEncoding;
    if (opts?.encoding && opts.encoding !== 'preserve') {
      encoding = opts.encoding;
    } else {
      encoding = this.encodingCache.get(key) ?? (await this.probeOnDisk(path)) ?? 'utf-8-bom';
    }

    let eol: 'crlf' | 'lf';
    if (opts?.eol && opts.eol !== 'preserve') {
      eol = opts.eol;
    } else {
      eol = this.eolCache.get(key) ?? 'lf';
    }

    if (opts?.backup !== false) {
      await this.backup(path);
    }

    // "保换行"模式：调用方未显式指定 eol（缺省或 'preserve'）⇒ 逐行保留原文换行。
    // 显式 eol（save-handler 回滚路径）⇒ 尊重用户整段统一意图，走 applyEol。
    const preserveEol = opts?.eol === undefined || opts.eol === 'preserve';
    // "保编码"同理：显式换编码（如导入/转码）时绝不走"逐字节直写原样"的快道。
    const preserveEncoding = opts?.encoding === undefined || opts.encoding === 'preserve';
    const eolMap = preserveEol ? this.eolMapCache.get(key) : undefined;

    // 零改动快道：保编码 + 模型文本逐行全等于原文 ⇒ 直接落回当初读到的原始字节，
    // 彻底绕开"解码→重编码"。这是 GBK/Big5 等编码表尚未覆盖的文件在
    // "零次编辑却毁字节"这一最坏形状下的唯一在范围内的防线（编码标签缺失需改契约，见回执）。
    const origBytes = eolMap && preserveEncoding ? this.rawBytesCache.get(key) : undefined;
    if (eolMap && origBytes && this.isUnmodifiedAgainst(eolMap, text)) {
      await this.bridge.writeFileBytes(path, origBytes);
      this.encodingCache.set(key, encoding);
      this.eolCache.set(key, eol);
      // 先按"盘上已变"清三类缓存，再用同一份原文回填指纹/快照（局部引用仍有效）；
      // 文本缓存判据 mtime 过期，留空待批量读重读——刚写完再批量读必须看到新内容。
      this.invalidateTextCache(path);
      this.putEolMap(key, joinPreserveEol(eolMap));
      this.putRawBytes(key, origBytes);
      return;
    }

    // 逐行还原：未改动行保留原换行，改动/新增行采用多数派 `eol`。
    const body = eolMap ? reconstructEol(eolMap, text, eol) : applyEol(normalizeEol(text), eol);
    // UTF-16：解码剥了 BOM、桥的 encode 产出无 BOM ⇒ 写回前补回，保字节往返。
    const bytes = await this.bridge.encode(withUtf16Bom(body, encoding), encoding);
    await this.bridge.writeFileBytes(path, bytes);
    this.encodingCache.set(key, encoding);
    this.eolCache.set(key, eol);
    // 先清三类缓存（文本判据过期），再用刚落盘的内容回填指纹/快照，
    // 供下一次 preserve 保存继续逐行保真（局部 body/bytes 仍是盘上新真相）。
    this.invalidateTextCache(path);
    this.putEolMap(key, body);
    this.putRawBytes(key, bytes);
  }

  /** 模型文本（按 `\n` 规范化）是否与原文指纹的各行**逐行全等**（零改动判据） */
  private isUnmodifiedAgainst(map: EolMap, text: string): boolean {
    const lines = normalizeEol(text).split('\n');
    if (lines.length !== map.parts.length) return false;
    for (let i = 0; i < lines.length; i++) if (lines[i] !== map.parts[i]) return false;
    return true;
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    this.assertWritable(path);
    await this.bridge.writeFileBytes(path, data);
    // 编码/EOL/换行指纹/字节快照跟着盘上新真相走（与 restoreBackup 同口径，2026-10-16 修复批）：
    // 字节级写入可以换编码/换行（导入、外部同步），缓存若不刷新，
    // 下一次 writeText 的 preserve 会按旧编码/旧换行写回——「保编码 / 保换行」不变量被打破。
    const key = pathKey(path);
    const { text: raw, encoding } = decodeWithProbe(data);
    // 先失效（invalidate 现会连带清掉旧的指纹/快照），再按新盘上真相回填
    this.invalidateTextCache(path);
    this.encodingCache.set(key, encoding);
    this.eolCache.set(key, detectEol(raw));
    this.putEolMap(key, raw);
    this.putRawBytes(key, data);
  }

  private async probeOnDisk(path: string): Promise<FileEncoding | null> {
    if (!(await this.bridge.exists(path))) return null;
    const bytes = await this.bridge.readFileBytes(path);
    return probeEncoding(bytes);
  }

  /* ------------------------------ 目录 ------------------------------ */

  async ensureDir(path: string): Promise<void> {
    // 与 writeBytes 同闸：先建目录再写文件的链路里，目录创建同样不能越权
    // （否则会先在域外造出目录，违反"游戏目录整体只读"）。
    this.assertWritable(path);
    await this.bridge.ensureDir(path);
  }

  listDir(path: string): Promise<DirEntry[]> {
    return this.bridge.listDir(path);
  }

  /**
   * 递归遍历 + **本层唯一兑现的 `filter`**（2026-10-16 桥分叉批）。
   *
   * `filter` 是一个 JS 闭包，而平台桥可能跨进程：桌面壳的 `walkDir` =
   * `invoke('walk_dir', { path, opts })`，参数过一次 JSON 序列化，函数值**整键消失**
   * （Rust 的 `WalkOptionsDto` 本来也只有四个可序列化字段）。此前这里把 opts 原样转给桥，
   * 于是「类型说 filter 有、桥根本不认」：node 测试桥自己递归并兑现 filter ⇒ 测试全绿，
   * 生产里整棵 ERB 根 4,519 份文件全回来，再逐份串行读盘 = 开项目 24.4 秒
   * （守门：`packages/plugins/eratw-adapter/tests/variable-schema.walkdir-ipc.test.ts`）。
   *
   * 修法只有一条站得住：**谓词由内核兑现，桥一律不经眼**（只有一份实现，
   * 桥分叉在构造上不可能，不必逐桥对拍）。代价是语义收窄为
   * **「只筛输出条目，不剪枝」**——枚举先于筛选，剪掉子树已无从谈起（要限深请用 `maxDepth`）。
   * 全仓三处调用方的谓词都写成 `e.isDirectory || …`（本就不剪枝），语义零变化。
   */
  async walkDir(path: string, opts?: WalkOptions): Promise<DirEntry[]> {
    const { filter, ...enumeration } = opts ?? {};
    if (filter === undefined) return this.bridge.walkDir(path, opts);
    const entries = await this.bridge.walkDir(path, enumeration);
    return entries.filter(filter);
  }

  exists(path: string): Promise<boolean> {
    return this.bridge.exists(path);
  }

  stat(path: string): Promise<FileStat | null> {
    return this.bridge.stat(path);
  }

  /**
   * 批量 stat（PERF-10b）：**透传平台桥现成的 `statFiles` 命令**，按 `STAT_CHUNK_SIZE` 分块
   * （与 `readTexts` 校验会话缓存用的是同一条桥命令、同一份分块常量 ⇒ 没有第二套批量形态）。
   *
   * 判定与 `exists`/`stat` 同源（桥侧同一道 `metadata`/`stat` 调用），本层不改判据、不加缓存：
   * "在不在位"是每次真问盘一次的答案，缓存它 = 造出第二份真相。
   * 桥少回某一项（契约上不该发生）⇒ 该位按"取不到"给出 `exists:false` 并**出声**，绝不静默补位。
   */
  async statFiles(paths: readonly string[]): Promise<BatchFileStat[]> {
    const out: BatchFileStat[] = [];
    for (let start = 0; start < paths.length; start += STAT_CHUNK_SIZE) {
      const chunk = paths.slice(start, start + STAT_CHUNK_SIZE);
      const got = await this.bridge.statFiles(chunk);
      for (let k = 0; k < chunk.length; k++) {
        const st = got[k];
        if (st === undefined) {
          this.log?.warn(`statFiles: 桥未返回第 ${k} 项（按"取不到"处理）：${chunk[k]!}`);
          out.push({ path: chunk[k]!, exists: false, mtimeMs: null, size: null });
          continue;
        }
        out.push(st);
      }
    }
    return out;
  }

  /* --------------------------- 写白名单 --------------------------- */

  setWritableRoots(roots: string[]): void {
    this.writableRoots = roots.map((r) => r);
  }

  setAppWritableRoots(roots: string[]): void {
    this.appWritableRoots = roots.map((r) => r);
  }

  addAppWritableRoot(root: string): void {
    // 追加去重（整替语义留给 setAppWritableRoots，两者各有调用方，不混用）
    const key = pathKey(root);
    if (this.appWritableRoots.some((r) => pathKey(r) === key)) return;
    this.appWritableRoots.push(root);
  }

  /**
   * 自选「项目位置」根（2026-10-14 批）：**对话框即授权**——授权发生在平台命令内
   * （目录对话框与写进常驻根清单绑成一个原子动作），本层只负责把结果同步进第一道闸。
   * 与 `exportFile` 同族：刻意不接受路径入参，JS 侧没有"给个路径就放行"的入口。
   */
  async chooseWorkspaceRoot(opts?: { title?: string }): Promise<string | null> {
    const root = await this.bridge.chooseWorkspaceRoot(opts);
    if (root === null) return null; // 取消 = 什么都不改
    this.addAppWritableRoot(root);
    this.log?.info(`Project location authorized: ${root}`);
    return root;
  }

  isWritable(path: string): boolean {
    return [...this.writableRoots, ...this.appWritableRoots].some((root) => isPathUnder(root, path));
  }

  private assertWritable(path: string): void {
    if (!this.isWritable(path)) {
      throw new WriteNotAllowedError(path, [...this.writableRoots, ...this.appWritableRoots]);
    }
  }

  /* ------------------------------ 备份 ------------------------------ */

  /** 桶属主清单的读取态：absent = 历史旧桶（无清单），ok = 可比对，corrupt = 无法证明 */
  private async bucketOwnerOf(
    dir: string,
  ): Promise<{ kind: 'absent' } | { kind: 'ok'; key: string } | { kind: 'corrupt' }> {
    const file = join(dir, BACKUP_OWNER_FILE);
    if (!(await this.bridge.exists(file))) return { kind: 'absent' };
    try {
      const bytes = await this.bridge.readFileBytes(file);
      const raw = JSON.parse(new TextDecoder().decode(bytes)) as { v?: unknown; pathKey?: unknown };
      if (raw.v !== 1 || typeof raw.pathKey !== 'string') throw new Error('owner 字段不合形态');
      return { kind: 'ok', key: raw.pathKey };
    } catch (err) {
      this.log?.warn(`备份桶属主清单损坏：${dir} — ${String(err)}`);
      return { kind: 'corrupt' };
    }
  }

  /**
   * 某文件当前写法下的备份桶目录（写侧：backup() 落点）。
   *
   * 桶身份 = 32 位 FNV-1a(pathKey)：数千同名文件的语料下存在生日碰撞（~0.06%），
   * 碰撞的两个文件会算出同一个桶名 ⇒ 不设属主闸，A 的备份会落进 B 的桶、恢复时
   * 静默串档。属主闸（owner.json 记 pathKey 原文）：桶被别人占着（或清单损坏无法
   * 证明）⇒ 换下一个副本桶名（`-2`/`-3`），绝不与外来者共桶。
   */
  private async bucketDirFor(path: string): Promise<string> {
    const appData = await this.bridge.appDataDir();
    const backupRoot = join(appData, 'backup');
    const key = pathKey(path);
    for (const suffix of ['', '-2', '-3']) {
      const dir = join(backupRoot, `${backupBucketName(path)}${suffix}`);
      const owner = await this.bucketOwnerOf(dir);
      if (owner.kind === 'absent' || (owner.kind === 'ok' && owner.key === key)) return dir;
      this.log?.warn(
        `备份桶 ${dir} 属主${owner.kind === 'corrupt' ? '清单损坏' : '是其他文件'}（32 位哈希碰撞防御），改用副本桶`,
      );
    }
    throw new Error(`备份桶分配失败（连续三个桶名都被其他文件占用）：${path}`);
  }

  /**
   * 某文件**全部**备份桶目录（读侧：按桶名段找 + 属主校验，折叠历史写法造成的前缀差异）。
   * 历史旧桶（无 owner.json）按现通配放行（兼容口径，不炸旧数据）；属主是他人的桶
   * **绝不**出现在结果里——旧实现按哈希后缀通配，碰撞桶的版本会互相看见、恢复即串档。
   */
  private async findBucketDirs(path: string): Promise<string[]> {
    const appData = await this.bridge.appDataDir();
    const root = join(appData, 'backup');
    const hash = backupHashOf(path);
    const key = pathKey(path);
    const out: string[] = [];
    for (const e of await this.bridge.listDir(root)) {
      if (!e.isDirectory) continue;
      // 桶名 = `前缀-<hash8>`，副本桶带 `-N` 尾；末段必须正好是 hash8 或 hash8-N
      const m = /^(.+)-([0-9a-f]{8})(?:-(\d+))?$/.exec(e.name);
      if (m === null || m[2] !== hash) continue;
      const owner = await this.bucketOwnerOf(e.path);
      if (owner.kind === 'ok' && owner.key !== key) {
        this.log?.warn(`备份桶 ${e.path} 属主是其他文件（32 位哈希碰撞防御），跳过该桶`);
        continue;
      }
      if (owner.kind === 'corrupt') {
        this.log?.warn(`备份桶 ${e.path} 属主清单损坏，无法证明属主，跳过该桶`);
        continue;
      }
      out.push(e.path);
    }
    return out;
  }

  async backup(path: string): Promise<string | null> {
    if (!(await this.bridge.exists(path))) return null;
    // 目录结构：backup/{sanitized-prefix-hash}/{timestamp}.bak
    const dir = await this.bucketDirFor(path);
    await this.bridge.ensureDir(dir);
    // 属主清单与版本同桶：写侧每次落账（同内容覆写，字节级幂等）；读侧比对防串桶。
    // 先写属主再写版本——崩溃窗口留下的"有主无版"桶无害，反过来（无主有版）就只能靠通配。
    await this.bridge.writeFileBytes(
      join(dir, BACKUP_OWNER_FILE),
      new TextEncoder().encode(JSON.stringify({ v: 1, pathKey: pathKey(path) })),
    );
    const target = join(dir, `${timestamp()}.bak`);
    await this.bridge.copyFile(path, target);
    await this.pruneBackups(dir);
    this.log?.debug(`Backup created: ${target}`);
    return target;
  }

  async listBackups(path: string): Promise<BackupVersion[]> {
    const out: BackupVersion[] = [];
    for (const dir of await this.findBucketDirs(path)) {
      const entries = (await this.bridge.listDir(dir)).filter(
        (e) => !e.isDirectory && BACKUP_VERSION_RE.test(e.name),
      );
      for (const e of entries) {
        const st: FileStat | null = await this.bridge.stat(e.path);
        if (st === null) {
          // stat 竞态失败（列完被删）：整条剔除并出声——宁可少一版，不给一版假的尺寸/时间
          this.log?.warn(`备份版本 stat 失败（跳过该条）：${e.path}`);
          continue;
        }
        out.push({
          id: e.name,
          path: e.path,
          takenAtMs: parseBackupTakenAtMs(e.name),
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      }
    }
    // 时间戳文件名字典序 = 时序；新在前（列表第一行就是"最近一版"）
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }

  async restoreBackup(path: string, versionId: string): Promise<void> {
    if (!BACKUP_VERSION_RE.test(versionId)) {
      throw new Error(`无效的历史版本号：${versionId}`);
    }
    // 第一道闸先行：只读的游戏目录在这里就可见拒绝（WriteNotAllowedError），不动盘也不读备份
    this.assertWritable(path);
    let src: string | null = null;
    for (const dir of await this.findBucketDirs(path)) {
      const candidate = join(dir, versionId);
      const st = await this.bridge.stat(candidate);
      if (st !== null && !st.isDirectory) {
        src = candidate;
        break;
      }
    }
    if (src === null) throw new Error(`历史版本不存在：${versionId}`);
    const bytes = await this.bridge.readFileBytes(src);
    await this.backup(path); // 写前自动备份：恢复不吃掉现状（与 writeText 同款时序）
    await this.bridge.writeFileBytes(path, bytes); // 字节级 + 平台原子写：零转码
    // 编码/EOL/换行指纹/字节快照跟着版本走：否则下一次 writeText 的 preserve 会用"恢复前那一版"的编码/换行
    const key = pathKey(path);
    const { text: raw, encoding } = decodeWithProbe(bytes);
    this.invalidateTextCache(path); // 会话文本缓存同 writeText：恢复后批量读必须是新版（先清再按新版回填）
    this.encodingCache.set(key, encoding);
    this.eolCache.set(key, detectEol(raw));
    this.putEolMap(key, raw);
    this.putRawBytes(key, bytes);
    this.log?.info(`Backup restored: ${src} -> ${path}`);
  }

  private async pruneBackups(dir: string): Promise<void> {
    const entries = (await this.bridge.listDir(dir))
      .filter((e) => !e.isDirectory && e.name.endsWith('.bak'))
      .sort((a, b) => a.name.localeCompare(b.name));
    const excess = entries.length - BACKUP_KEEP_PER_FILE;
    for (let i = 0; i < excess; i++) {
      try {
        // 管理性裁剪直走桥（2026-10-16 undo 批）：备份桶裁剪进回收站会让回收站
        // 自增殖（每 20 版裁一轮塞 1-2 条目），且被裁的版本永远没人"后悔"。
        await this.bridge.removeFile(entries[i]!.path);
      } catch (err) {
        this.log?.warn(`Failed to prune backup ${entries[i]!.path}: ${String(err)}`);
      }
    }
  }

  /* ------------------------------ 导出 ------------------------------ */

  /**
   * 导出单个文件（导出批，ZIP 发布包）：**对话框即授权**——对话框与写盘都在平台命令内，
   * 内核不经手落点，故刻意不调 `assertWritable`（导出的意义正是落到白名单外，
   * 如桌面 / 发布目录）。字节由调用方（插件）备好，内核只搬运。
   */
  async exportFile(
    fileName: string,
    bytes: Uint8Array,
    opts?: { title?: string },
  ): Promise<string | null> {
    const target = await this.bridge.exportFile(fileName, bytes, opts);
    if (target !== null) this.log?.info(`File exported: ${fileName} -> ${target}`);
    return target;
  }

  /**
   * 文件选择对话框（发布通道批，additive 可选）：本层零判定、零许可授予——只选不读不写。
   * 平台桥缺席（Node 桥等）⇒ 一句人话（照 `exportFile` 的 unsupported 口径，不静默）。
   */
  async chooseFile(opts?: {
    title?: string;
    filters?: readonly FilePickFilter[];
  }): Promise<string | null> {
    const choose = this.bridge.chooseFile;
    if (choose === undefined) throw new Error('当前平台没有文件选择能力（需要桌面壳）');
    return choose.call(this.bridge, opts);
  }

  /* ------------------------ 平台原语透传（零新逻辑） ------------------------ */

  /** 见契约：只用于派生应用自有子目录；**不是**写允许域的扩大入口（铁律 6） */
  appDataDir(): Promise<string> {
    return this.bridge.appDataDir();
  }

  /** 移动：from 与 to **两端都断言**（越权的一端任一个都足以拒绝） */
  async rename(from: string, to: string): Promise<void> {
    this.assertWritable(from);
    this.assertWritable(to);
    await this.bridge.rename(from, to);
  }

  /**
   * 服务端复制：**只对 `to` 断言**（见契约 `FileIO.copyFile`）。
   *
   * 读侧不过闸是**刻意的**，不是漏闸：`from` 恒在只读的游戏目录里，而"读"从来
   * 不受写允许域约束；把 `rename` 的两端断言照抄过来会误拒整条导入链路。
   * 写侧与 `writeBytes` 同闸同罚（`WriteNotAllowedError`），平台侧还有第二道闸。
   * 本方法不新增任何"域外写"能力 ⇒ 铁律 6 的唯一法定通道仍然只有 `exportFile`。
   */
  async copyFile(from: string, to: string): Promise<void> {
    this.assertWritable(to);
    await this.bridge.copyFile(from, to);
    // 落盘内容换了：会话文本缓存必须失效（口径与 writeBytes 逐字相同）
    this.invalidateTextCache(to);
  }

  /**
   * 递归删除目录（2026-10-16 undo 批：改为**移入回收站** `{appData}/trash/`，
   * manifest 记原路径，`restore` 可整体还原；不存在时幂等成功——契约不变）。
   * 同样先过 `assertWritable`——删是比写更狠的盘上动作，回收站不放宽闸。
   * 平台第二道闸仍拦真删（trash 内部的搬运走的是内核自有管理域，与备份同先例）。
   */
  async removeDir(path: string): Promise<void> {
    this.assertWritable(path);
    if (!(await this.bridge.exists(path))) return; // 幂等语义与旧 bridge.removeDir 一致
    await this.trash.moveIntoTrash(path, 'dir');
  }

  /**
   * 删除**单个文件**（2026-10-16 undo 批：同样改为**移入回收站**）。
   *
   * 闸的语义与 `removeDir` 同闸同罚：先过 `assertWritable`，平台侧另有第二道闸。
   * 删除成功后内核会同步失效该 path 的会话文本缓存（口径与 `writeBytes` 逐字相同）。
   *
   * **幂等语义不变**：目标不存在时如实拒绝（trash 搬不动一个不存在的东西，
   * rename 的 NotFound 原样上抛）——"删一个自以为存在的东西"应当听见响。
   *
   * 例外（管理性删除绕回收站）：内核内部对自身域的裁剪（如备份桶 prune）直走
   * 桥原语——管理性删除进回收站会让回收站自增殖，是错位不是安全。
   *
   * @throws WriteNotAllowedError 当路径不在可写白名单内
   */
  async removeFile(path: string): Promise<void> {
    this.assertWritable(path);
    await this.trash.moveIntoTrash(path, 'file');
    this.invalidateTextCache(path);
  }

  /* ----------------------- 回收站（W11 可见批；全 additive） ----------------------- */

  /** 见契约：把 `{appData}/trash/` 的既有条目读回来（只读，不受写允许域约束） */
  listTrash(opts?: { forPath?: string }): Promise<TrashEntry[]> {
    return this.trash.list(opts);
  }

  /**
   * 恢复回收站条目到原路径（契约 `FileIO.restoreFromTrash`）。
   *
   * 三件事一件都不能少，顺序也不许换：
   * 1. **第一道闸先行**（`assertWritable(originalPath)`）——恢复是一次写盘，落点可能在
   *    只读的游戏目录里；越权就可见拒绝，一个字节都不搬；
   * 2. **现状先落账**——原位若站着**一个文件**而条目也是文件，先把原位那份 `backup()`
   *    进写前备份账（于是它出现在同一条时间线上，恢复不吃掉现状）；
   * 3. 搬回原位后刷新编码/EOL 缓存 + 失效会话文本缓存（口径与 `restoreBackup` 逐字相同：
   *    盘上换了内容，preserve 的判据必须跟着新真相走）。
   *
   * 目录形条目撞上"原位已有东西"由低层 `TrashManager.restore` 拒绝（整棵子树没有
   * 一份现状可以备份，覆盖它不是恢复而是换数据）——错误原话随异常上抛给 UI。
   */
  async restoreFromTrash(id: string): Promise<string> {
    const view = await this.trash.entryOf(id);
    if (view === null) throw new Error(`回收站条目不存在或已失效：${id}`);
    this.assertWritable(view.originalPath);
    const occupant = await this.bridge.stat(view.originalPath);
    if (occupant !== null && !occupant.isDirectory && view.kind === 'file') {
      await this.backup(view.originalPath); // 写前备份：恢复不吃掉现状（与 restoreBackup 同款时序）
    }
    const restored = await this.trash.restore(id, { overwrite: true });
    // 编码/EOL 跟着盘上新真相走，会话文本缓存失效（与 restoreBackup / writeBytes 同口径）
    const bytes = await this.bridge.readFileBytes(restored).catch(() => null);
    if (bytes !== null) {
      const { text: raw, encoding } = decodeWithProbe(bytes);
      this.encodingCache.set(pathKey(restored), encoding);
      this.eolCache.set(pathKey(restored), detectEol(raw));
    }
    this.invalidateTextCache(restored);
    this.log?.info(`回收站条目已恢复：${id} -> ${restored}`);
    return restored;
  }

  /** 见契约：不传 ids = 超期自动清理（跳过被引用的）；传 ids = 用户显式彻底删除 */
  purgeTrash(ids?: readonly string[]): Promise<number> {
    if (ids === undefined) return this.trash.purge();
    return this.trash.purgeIds(ids);
  }

  /** 见契约：会话内"时间线正在引用这些条目"，自动清理跳过它们（整替语义） */
  holdTrash(ids: readonly string[]): void {
    this.trash.hold(ids);
  }

  /** 调试/测试辅助：当前缓存状态（含会话文本缓存的命中读数——批量 IO 批的轻量上报面） */
  debugCaches(): {
    encoding: Map<string, FileEncoding>;
    eol: Map<string, 'crlf' | 'lf'>;
    text: { files: number; chars: number; hits: number; misses: number };
  } {
    return {
      encoding: this.encodingCache,
      eol: this.eolCache,
      text: {
        files: this.textCache.size,
        chars: this.textCacheChars,
        hits: this.textCacheHits,
        misses: this.textCacheMisses,
      },
    };
  }
}
