import type {
  BackupVersion,
  BatchFileStat,
  DirEntry,
  EventBus,
  FileChangeKind,
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
  decodeWithEncoding,
  decodeWithProbe,
  detectEol,
  ENCODING_IDS,
  isFileEncoding,
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

/**
 * 备份账的**字节级**上限（2026-10-18 字节上限批，两档）：
 * - 单桶档：一个文件的备份桶内全部 `.bak` 总字节超限 ⇒ 从最旧版起裁（先过份数档再过字节档）；
 * - 总量档：整个 `backup/` 根超限 ⇒ 跨桶按版本时序从最旧裁（`sweepBackupRootBytes`，节流巡检）。
 *
 * 取值依据 STATE §W 尺子（最大单文件 2.35MB）：20 版 × 2.35MB ≈ 47MB/桶，256MB 单桶档
 * 给足一个量级余量；总量 1GB 与 op 快照账（1GB）、回收站账（2GB）合计把 appData 封顶在
 * 有界范围（~4GB）。裁剪**必须出声**（warn 日志带数字，铁律 4）。
 */
export const BACKUP_MAX_BYTES_PER_FILE = 256 * 1024 * 1024;
export const BACKUP_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
/** 总量档巡检最小间隔：每次 backup 都全根扫太贵（数千桶），节流成分钟级 */
const BACKUP_BYTES_SWEEP_INTERVAL_MS = 60_000;

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
 * 原文换行指纹缓存上限（PS-2 起缓存的是**原始未归一化文本**这一份字符串，
 * EolMap 在真正发生"保换行保存"那一刻才即时切分——旧的"每次读入即拆成逐行数组"
 * 让每个文件在盘、文本缓存、指纹缓存里存了三份，万行文件的光谱数组实测按字符数记账
 * 低估真实留存约 20 倍。尺子改为**字节**（UTF-16：2 字节/code unit + 每串固定开销）。
 * 丢几热的代价只是"下一次无关保存少认几行原换行"，不是数据损坏。
 */
const EOLMAP_CACHE_MAX_FILES = 8192;
const EOLMAP_CACHE_MAX_BYTES = 192 * 1024 * 1024;

/**
 * 原文**字节**快照上限（零改动保存的逐字节直写快道）：字节比文本大，留最小的量级，
 * 只用来兜住"GBK/SJIS 等未被编码表覆盖的文件在零改动保存时被解码→重编码毁字节"这一最坏形状。
 * 超尺从队首削；丢了就退回逐行还原（真 UTF-8/SJIS 文件仍字节级一致）。
 */
const RAW_BYTES_CACHE_MAX_FILES = 1024;
const RAW_BYTES_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 编码/EOL 判据缓存的条目上限（PS-2）：这两个 Map 此前**无界**——
 * 冷开一轮两三千文件就长两三千条，且换项目不清。单条很小（键=路径折叠串），
 * 上限取"真实语料规模 + 一个数量级余量"，超限按 FIFO 从队首削。
 */
const META_CACHE_MAX_ENTRIES = 32768;

/** 每串 JS 字符串的固定堆开销估算（header + 对齐；字节尺子里与 2×code unit 相加） */
const STRING_OVERHEAD_BYTES = 64;
function stringRetentionBytes(chars: number): number {
  return chars * 2 + STRING_OVERHEAD_BYTES;
}

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
   * 原文换行指纹的**懒存底**（PS-2）：键 → 原始未归一化文本；EolMap 只在真正发生
   * "保换行保存"时由 {@link splitPreserveEol} 即时切出。旧局每次读入即拆逐行数组 =
   * 每个文件多背一整份拷贝（含逐串开销），而绝大多数读入的文件这一轮（乃至整个会话）
   * 都不会被保存。不改 readText/writeText 对外签名。
   */
  private readonly eolMapCache = new Map<string, string>();
  private eolMapBytes = 0;
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
  private readonly metaCacheMaxEntries: number;
  /** 备份字节档的注入上限（缺省 = 模块常量；测试用小值钉裁剪纪律） */
  private readonly backupMaxPerBucketBytes: number;
  private readonly backupMaxTotalBytes: number;
  /** 总量档巡检的节流锚（上次真扫时刻）；在途巡检的 promise 守门（防重叠） */
  private lastBackupBytesSweepAt = 0;
  private backupBytesSweep: Promise<void> = Promise.resolve();

  constructor(
    private readonly bridge: PlatformBridge,
    private readonly log?: Logger,
    /**
     * 会话文本缓存上限的测试注入口（additive；缺省 = 上文两把尺）。
     * 只为让"超限削最旧"这条纪律能被廉价地钉死——生产调用方零改动。
     * `maxMetaEntries`（PS-2 追加）：编码/EOL 判据缓存的条目上限注入点。
     */
    cacheCaps: { maxFiles?: number; maxChars?: number; maxMetaEntries?: number } = {},
    /**
     * 事件总线（2026-10-18 缓存失效批，additive 可选）：缺席 = 不发事件，其余行为逐字不变。
     * **只发 `file.changed`**——二进制写路径（writeBytes / removeFile / restoreBackup）落盘后
     * 广播一次，让消费了这些文件的下游缓存（插件的二进制解析记忆等）显式失效：
     * 知情写入方告诉缓存，文件监视器只是外部改盘的兜底，不是第一信源
     * （口径同 tsserver 单文件失效 / watcher `onFileChanged`；亦同 💡 升糖写完后
     * 由服务发事件的既有纪律）。文本路径不发——编辑器的保存回路自写自知。
     */
    private readonly bus?: EventBus,
    /**
     * 备份字节档（2026-10-18 字节上限批，additive 可选）：缺省 = 模块常量。
     * 测试注入小值把"超限裁最旧 + 出声"钉死，生产调用方零改动。
     */
    backupByteCaps: { maxPerBucketBytes?: number; maxTotalBytes?: number } = {},
  ) {
    this.textCacheMaxFiles = cacheCaps.maxFiles ?? TEXT_CACHE_MAX_FILES;
    this.textCacheMaxChars = cacheCaps.maxChars ?? TEXT_CACHE_MAX_CHARS;
    this.metaCacheMaxEntries = cacheCaps.maxMetaEntries ?? META_CACHE_MAX_ENTRIES;
    this.backupMaxPerBucketBytes = backupByteCaps.maxPerBucketBytes ?? BACKUP_MAX_BYTES_PER_FILE;
    this.backupMaxTotalBytes = backupByteCaps.maxTotalBytes ?? BACKUP_MAX_TOTAL_BYTES;
    this.trash = new TrashManager(bridge, log);
  }

  /** 二进制写路径落盘后的失效广播（载荷与监视器同源：路径**原样透传**，消费方判等走 pathKey） */
  private publishBinaryChange(kind: FileChangeKind, path: string): void {
    this.bus?.emit('file.changed', { kind, path });
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
    this.setMeta(this.encodingCache, key, encoding);
    this.setMeta(this.eolCache, key, eol);
    // PS-2③：只读路径（游戏目录整体只读）不留指纹/字节快照——它们永远不会被保存，
    // 留着就是把整库再背两份。写保护闸（assertWritable）本来就只放行 writablePaths，
    // 所以"可写才留"零保真损失；万一"先只读读入、后批准写、再保存"，writeText 会
    // 就地补捞一次盘上真相（见 ensureFingerprintFromDisk），逐行保真不变量不打折。
    this.rememberFingerprints(path, key, raw, bytes);
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
        // 与 readText 同口径的编码/EOL 判据缓存；指纹/字节快照同 readText 的"可写才留"闸
        const key = pathKey(path);
        this.setMeta(this.encodingCache, key, encoding);
        this.setMeta(this.eolCache, key, eol);
        this.rememberFingerprints(path, key, raw, r.data);
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

  /**
   * 入缓存换行指纹**存底**（懒存：只存原始串，EolMap 到保存那一刻才切；FIFO 重读=重新入队尾、
   * 超尺从队首削）。记账按**字节**（2 字节/code unit + 每串固定开销）——旧尺子按字符数记
   * 逐行数组，把真实留存低估了一个数量级。
   */
  private putEolMap(key: string, raw: string): void {
    const cost = stringRetentionBytes(raw.length);
    const prev = this.eolMapCache.get(key);
    if (prev) {
      this.eolMapCache.delete(key);
      this.eolMapBytes -= stringRetentionBytes(prev.length);
    }
    this.eolMapCache.set(key, raw);
    this.eolMapBytes += cost;
    while (this.eolMapCache.size > EOLMAP_CACHE_MAX_FILES || this.eolMapBytes > EOLMAP_CACHE_MAX_BYTES) {
      const oldest = this.eolMapCache.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.eolMapCache.get(oldest);
      this.eolMapCache.delete(oldest);
      if (evicted) this.eolMapBytes -= stringRetentionBytes(evicted.length);
    }
  }

  /**
   * 读入路径的指纹/字节快照登记闸（PS-2③）：**可写才留**。
   * 只读的游戏目录文件永远写不回去（写保护闸在 assertWritable），留整份第二拷贝纯属内存税。
   */
  private rememberFingerprints(path: string, key: string, raw: string, bytes: Uint8Array): void {
    if (!this.isWritable(path)) return;
    this.putEolMap(key, raw);
    this.putRawBytes(key, bytes);
  }

  /**
   * "先只读读入、后批准写、再保存"的补捞通道（PS-2）：保换行保存真正发生时无存底 ⇒
   * 用一趟 `readFilesRaw` 取回盘上真相做指纹（此刻文件还没被本会话写过，盘上 = 读入时所见）。
   * 读不到（新文件/竞态删除）⇒ 返回 undefined，落回既有的"无指纹 ⇒ 多数派统一换行"退化路，
   * 与旧行为在"从未读过的文件上保存"完全一致。
   */
  private async ensureFingerprintFromDisk(path: string, key: string): Promise<string | undefined> {
    const [r] = await this.bridge.readFilesRaw([path]);
    if (!r || r.status !== 'ok') return undefined;
    const { text: raw } = decodeWithProbe(r.data);
    this.putEolMap(key, raw);
    this.putRawBytes(key, r.data);
    return raw;
  }

  /** 编码/EOL 判据缓存的有界写入（PS-2④：此前无界）；FIFO：重复写=挪队尾 */
  private setMeta<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > this.metaCacheMaxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
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
      this.eolMapBytes -= stringRetentionBytes(prevMap.length);
    }
    const prevBytes = this.rawBytesCache.get(key);
    if (prevBytes) {
      this.rawBytesCache.delete(key);
      this.rawBytesTotal -= prevBytes.length;
    }
  }

  /**
   * 只peek会话文本缓存、**零 IPC**（PS-2②）：调用方能自证新鲜（例如同一批刚 stat/刚读过、
   * 级联里紧随其后的重复消费段）时用它，免掉 `readTexts` 为自证缓存新鲜而**每次必付**的
   * 批量 stat 一趟——refs 一轮 2,316 文件按批 64 就是 37 趟纯排队。未命中位返回 `null`
   * （**不读盘、不抛错**）：拿到 null 的调用方自己退回 `readTexts` 正常路径即可。
   * 契约面（`FileIO`）暂不含本方法——插件侧接入需一次 additive 契约扩展（见回执），
   * 实现先落在内核并在类型窄化的消费点（app 直持 FileIOServiceImpl）可用。
   */
  peekTexts(paths: readonly string[]): Array<TextFile | null> {
    const out: Array<TextFile | null> = new Array(paths.length).fill(null);
    for (let i = 0; i < paths.length; i++) {
      const cached = this.textCache.get(pathKey(paths[i]!));
      if (cached) {
        out[i] = cached.file;
        this.textCacheHits++;
      } else {
        this.textCacheMisses++;
      }
    }
    return out;
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
    // 懒切指纹（PS-2）：只有真正发生"保换行保存"才把存底串切成 EolMap；
    // 存底缺失（只读路径读入后才批准写的文件）⇒ 就地补捞一次盘上真相（一趟批量读）。
    let rawEol = preserveEol ? this.eolMapCache.get(key) : undefined;
    if (rawEol === undefined && preserveEol) {
      rawEol = await this.ensureFingerprintFromDisk(path, key);
    }
    const eolMap = rawEol === undefined ? undefined : splitPreserveEol(rawEol);

    // 零改动快道：保编码 + 模型文本逐行全等于原文 ⇒ 直接落回当初读到的原始字节，
    // 彻底绕开"解码→重编码"。这是 GBK/Big5 等编码表尚未覆盖的文件在
    // "零次编辑却毁字节"这一最坏形状下的唯一在范围内的防线（编码标签缺失需改契约，见回执）。
    const origBytes = eolMap && preserveEncoding ? this.rawBytesCache.get(key) : undefined;
    if (eolMap && origBytes && this.isUnmodifiedAgainst(eolMap, text)) {
      await this.bridge.writeFileBytes(path, origBytes);
      this.setMeta(this.encodingCache, key, encoding);
      this.setMeta(this.eolCache, key, eol);
      // 先按"盘上已变"清三类缓存，再用同一份原文回填指纹/快照（局部引用仍有效）；
      // 文本缓存判据 mtime 过期，留空待批量读重读——刚写完再批量读必须看到新内容。
      this.invalidateTextCache(path);
      // 零改动 ⇒ joinPreserveEol(eolMap) 逐字节等于存底 rawEol，直接回存底（免一次拼接）
      this.putEolMap(key, rawEol!);
      this.putRawBytes(key, origBytes);
      return;
    }

    // 逐行还原：未改动行保留原换行，改动/新增行采用多数派 `eol`。
    const body = eolMap ? reconstructEol(eolMap, text, eol) : applyEol(normalizeEol(text), eol);
    // UTF-16：解码剥了 BOM、桥的 encode 产出无 BOM ⇒ 写回前补回，保字节往返。
    const bytes = await this.bridge.encode(withUtf16Bom(body, encoding), encoding);
    await this.bridge.writeFileBytes(path, bytes);
    this.setMeta(this.encodingCache, key, encoding);
    this.setMeta(this.eolCache, key, eol);
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
    this.setMeta(this.encodingCache, key, encoding);
    this.setMeta(this.eolCache, key, detectEol(raw));
    this.putEolMap(key, raw);
    this.putRawBytes(key, data);
    // 失效广播（二进制写路径 = 撤销注入的回滚通道 journal 也走这里）：下游二进制缓存
    // 不能靠 mtime/size 判据——原地改值的重写 size 不变，粗粒度介质上 mtime 也可同值
    this.publishBinaryChange('change', path);
  }

  /* ---------------- 显式编码读写（批次十 S2：按指定编码重开 / 另存，additive） ---------------- */

  /** 编码判据的运行时校验（显式编码入口共用）：未知编码必须报错，绝不用别的编码静默写入 */
  private assertKnownEncoding(encoding: FileEncoding): void {
    if (!isFileEncoding(encoding)) {
      throw new Error(`不支持的编码：${String(encoding)}（可选：${ENCODING_IDS.join(' / ')}）`);
    }
  }

  /**
   * 按**调用方显式指定的编码**读回文本（不探测；批次十 S2）。
   *
   * 与 `readText` 的差别只有一条：解码判据不是探测结果而是入参 `encoding`——"文件其实是
   * GBK，我按 Shift-JIS 看"这类误判现场要靠它纠正。解码后**内核编码判据跟着入参走**：
   * `encodingCache` / `eolCache` / 换行指纹 / 原文字节快照一并按这份解读刷新（会话文本缓存
   * 同批失效），于是下一次 `writeText` 的 preserve 不会回退到旧探测编码。
   *
   * 读侧不过写闸（与 `readText` 同口径）；`writable > 0` 才留指纹/字节快照（与
   * `rememberFingerprints` 同一个闸：只读文件的这两份拷贝永远写不回去）。
   */
  async readTextWithEncoding(path: string, encoding: FileEncoding): Promise<TextFile> {
    this.assertKnownEncoding(encoding);
    const bytesCall = this.readBytes(path);
    const statCall = this.bridge.stat(path);
    statCall.catch(() => {});
    const bytes = await bytesCall;
    const raw = decodeWithEncoding(bytes, encoding);
    const eol = detectEol(raw);
    const key = pathKey(path);
    this.setMeta(this.encodingCache, key, encoding);
    this.setMeta(this.eolCache, key, eol);
    // 盘上字节没变，但**会话里对这份内容的解读**变了：批量读缓存与指纹/快照按新解读重刷
    this.invalidateTextCache(path);
    this.rememberFingerprints(path, key, raw, bytes);
    const st = await statCall;
    return { path, text: normalizeEol(raw), encoding, eol, mtimeMs: st?.mtimeMs ?? null };
  }

  /**
   * 把模型文本按**目标编码**编成字节（只编码、不写盘；批次十 S2）。
   *
   * 换行与 `writeText` 的 preserve 同判据：有原文指纹就逐行还原（未改动行保留原换行），
   * 没有就整段取缓存的多数派 eol（再没有 = lf）。UTF-16 补 BOM（桥的 encode 不产 BOM）。
   *
   * 目标编码不受支持时**直接报错**（`FileEncoding` 全集之外的值不许被静默写成别的编码）。
   */
  async encodeForSave(path: string, text: string, encoding: FileEncoding): Promise<Uint8Array> {
    this.assertKnownEncoding(encoding);
    const key = pathKey(path);
    const eol = this.eolCache.get(key) ?? 'lf';
    const rawEol =
      this.eolMapCache.get(key) ?? (await this.ensureFingerprintFromDisk(path, key));
    const body =
      rawEol === undefined
        ? applyEol(normalizeEol(text), eol)
        : reconstructEol(splitPreserveEol(rawEol), text, eol);
    return this.bridge.encode(withUtf16Bom(body, encoding), encoding);
  }

  /**
   * 让内核编码判据**跟随**刚写入的显式编码（批次十 S2）：`writeBytes` 是按探测回填的，
   * GBK 内容可能被探测成 shift_jis；本方法用调用方给的 `bytes` 按指定编码重解一遍，
   * 把编码/EOL 判据、换行指纹与原文字节快照统一到"作者选定的这个编码"。
   *
   * 调用时机 = 显式编码写盘之后（`saveWithEncoding`）；不写盘、不广播（写路径自己发）。
   */
  adoptEncoding(path: string, encoding: FileEncoding, bytes: Uint8Array): void {
    this.assertKnownEncoding(encoding);
    const key = pathKey(path);
    const raw = decodeWithEncoding(bytes, encoding);
    this.invalidateTextCache(path);
    this.setMeta(this.encodingCache, key, encoding);
    this.setMeta(this.eolCache, key, detectEol(raw));
    this.putEolMap(key, raw);
    this.putRawBytes(key, bytes);
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
   * 独占创建空文件（WS-01）：第一道闸先行，再把"判存在 + 建文件"这一原子动作交给平台桥
   * （Rust 侧 `CREATE_NEW`）。`false` = 目标已存在且**一个字节都没动**，原样上抛给调用方
   * 去说人话（不在这里变成异常）。
   */
  async createFileExclusive(path: string): Promise<boolean> {
    this.assertWritable(path);
    return this.bridge.createFileExclusive(path);
  }

  /** 独占创建目录（同批）：闸与 `ensureDir` 同闸；`false` = 同名目录已存在。 */
  async createDirExclusive(path: string): Promise<boolean> {
    this.assertWritable(path);
    return this.bridge.createDirExclusive(path);
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
    // PS-2④（project.closed 的内核侧兑现）：项目服务在 close 里把写根清空
    // （`project.ts:106`，全仓唯一的置空调用点）——以此作钩子丢弃本会话攒下的项目态缓存。
    // 此前换项目 A→B，A 的文本/指纹/字节三份拷贝**永久驻留**（12 个插件都清了状态，
    // 唯独 io 没清）。B 打开后照常重新攒，零语义损失。判空不看旧值：项目全程没有
    // 批准过写根时 close 也要清得到（置空清空的窄条件会在这条路径上漏）。
    // 残余风险只剩"用户在项目中途主动把写根收回为空"——代价是多一轮重读，不是错误。
    if (roots.length === 0) this.clearProjectCaches();
  }

  /**
   * 丢弃**项目态**会话缓存（文本/换行指纹存底/字节快照/编码与 EOL 判据）——
   * 常驻可写根（作者工作区）的文件缓存也一并丢弃：换项目本就意味着换工作现场，
   * 工作区文件会在下一次批量读时按新判据回填。计数器（hits/misses）是累计观测面，不清。
   */
  clearProjectCaches(): void {
    this.textCache.clear();
    this.textCacheChars = 0;
    this.eolMapCache.clear();
    this.eolMapBytes = 0;
    this.rawBytesCache.clear();
    this.rawBytesTotal = 0;
    this.encodingCache.clear();
    this.eolCache.clear();
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
   * （目录对话框与写进常驻根清单绑成一个原子动作）。
   * 与 `exportFile` 同族：刻意不接受路径入参，JS 侧没有"给个路径就放行"的入口。
   *
   * 2026-10-27 收窄批：本层**不再**把选定根整根追加进常驻可写根。那个动作曾让
   * "把游戏目录选成项目位置"直接等于游戏目录可写。现在选定根只回答"作品可以建在哪"，
   * 真正可写的是 `WorkspaceServiceImpl` 建出来/扫出来的作品目录（`projectDirs()`，
   * 由工作区服务整替同步进本层）。对话框取消时仍然一个字节都不改。
   */
  async chooseWorkspaceRoot(opts?: {
    title?: string;
    forbidRoots?: readonly string[];
  }): Promise<string | null> {
    const root = await this.bridge.chooseWorkspaceRoot(opts);
    if (root === null) return null; // 取消 = 什么都不改
    this.log?.info(`Project location selected (workspace service will register project dirs): ${root}`);
    return root;
  }

  /**
   * 目录选择对话框（2026-10-27 导入来源批，additive 可选）：**只选不读不写、不登记授权**。
   * 平台桥缺席（Node 桥等）⇒ 一句人话（照 `chooseFile` 的 unsupported 口径，不静默）。
   */
  async pickDirectory(opts?: { title?: string }): Promise<string | null> {
    const pick = this.bridge.pickDirectory;
    if (pick === undefined) throw new Error('当前平台没有目录选择能力（需要桌面壳）');
    return pick.call(this.bridge, opts);
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
    // 总量档巡检（节流 + 尽力而为，不阻塞本次备份的返回——照 trash 顺手清扫的形态）
    this.scheduleBackupBytesSweep();
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
    this.setMeta(this.encodingCache, key, encoding);
    this.setMeta(this.eolCache, key, detectEol(raw));
    this.putEolMap(key, raw);
    this.putRawBytes(key, bytes);
    // 失效广播：恢复 = 盘上换内容，下游二进制缓存必须知道（判据同为 mtime+size，
    // 恢复"注入前版本"与当前注入版可能同 size、同 mtime tick——见 2026-10-18 修复批）
    this.publishBinaryChange('change', path);
    this.log?.info(`Backup restored: ${src} -> ${path}`);
  }

  /**
   * 桶内裁剪，两档先後（2026-10-18 字节上限批）：
   * 1. 份数档（`BACKUP_KEEP_PER_FILE`，原有语义不动）；
   * 2. 单桶字节档（`maxPerBucketBytes`）：桶内 `.bak` 总字节超限 ⇒ **最旧先走**
   *    （版本文件名字典序 = 时序，与份数档同一把尺）。
   * 裁了多少必须出声（warn 带数字——铁律 4，内核不静默）。
   */
  private async pruneBackups(dir: string): Promise<void> {
    // withMetadata 一次带回 size；个别缺 size 的条目补一趟 stat（宁可多一趟，不拿 0 静默低估）
    const listed = await this.bridge
      .walkDir(dir, { includeFiles: true, withMetadata: true })
      .catch(() => [] as DirEntry[]);
    const entries = listed
      .filter((e) => !e.isDirectory && e.name.endsWith('.bak'))
      .sort((a, b) => a.name.localeCompare(b.name));
    const sized: Array<{ name: string; path: string; bytes: number }> = [];
    for (const e of entries) {
      let size = e.size ?? null;
      if (size === null) {
        const st = await this.bridge.stat(e.path).catch(() => null);
        size = st !== null && !st.isDirectory ? st.size : null;
      }
      if (size === null) {
        // stat 竞态失败（列完被删）：剔除并出声，与 listBackups 同口径
        this.log?.warn(`备份版本 stat 失败（跳过裁剪判定）：${e.path}`);
        continue;
      }
      sized.push({ name: e.name, path: e.path, bytes: size });
    }
    const byCount = sized.slice(0, Math.max(0, sized.length - BACKUP_KEEP_PER_FILE));
    let bucketBytes = sized.reduce((s, e) => s + e.bytes, 0);
    const overBytes: typeof sized = [];
    for (let i = 0; i < sized.length && bucketBytes > this.backupMaxPerBucketBytes; i++) {
      overBytes.push(sized[i]!);
      bucketBytes -= sized[i]!.bytes;
    }
    const victims = [...byCount, ...overBytes.filter((e) => !byCount.includes(e))];
    for (const v of victims) {
      try {
        // 管理性裁剪直走桥（2026-10-16 undo 批）：备份桶裁剪进回收站会让回收站
        // 自增殖（每 20 版裁一轮塞 1-2 条目），且被裁的版本永远没人"后悔"。
        await this.bridge.removeFile(v.path);
      } catch (err) {
        this.log?.warn(`Failed to prune backup ${v.path}: ${String(err)}`);
      }
    }
    if (overBytes.length > 0) {
      this.log?.warn(
        `备份桶字节超限，已裁最旧 ${overBytes.length} 版（桶 ${dir}，裁后约 ${bucketBytes}B / 上限 ${this.backupMaxPerBucketBytes}B）`,
      );
    }
  }

  /**
   * 总量档巡检（公开：测试与未来维护面可直调强制跑）：整个 `backup/` 根的 `.bak`
   * 总字节超 `maxTotalBytes` ⇒ 跨桶按**版本时序**从最旧裁到预算内。
   *
   * 节流（`BACKUP_BYTES_SWEEP_INTERVAL_MS`）：每次 backup 都全根扫太贵（数千桶 ×
   * walkDir），退成分钟级；`force: true` 绕过节流（测试用）。在途巡检不重叠
   * （promise 守门）。失败只 warn 不抛——巡检是尽力而为的维护动作，不该炸写路径。
   */
  async sweepBackupRootBytes(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastBackupBytesSweepAt < BACKUP_BYTES_SWEEP_INTERVAL_MS) return;
    this.lastBackupBytesSweepAt = now;
    const appData = await this.bridge.appDataDir();
    const root = join(appData, 'backup');
    const buckets = await this.bridge.listDir(root).catch(() => [] as DirEntry[]);
    const versions: Array<{ path: string; name: string; bucket: string; bytes: number }> = [];
    let total = 0;
    for (const b of buckets) {
      if (!b.isDirectory) continue;
      const files = await this.bridge
        .walkDir(b.path, { includeFiles: true, withMetadata: true })
        .catch(() => null);
      if (files === null) continue;
      for (const f of files) {
        if (f.isDirectory || !f.name.endsWith('.bak')) continue;
        // 缺 size 补 stat；再取不到就剔除并出声（不拿 0 静默低估总量）
        let size = f.size ?? null;
        if (size === null) {
          const st = await this.bridge.stat(f.path).catch(() => null);
          size = st !== null && !st.isDirectory ? st.size : null;
        }
        if (size === null) {
          this.log?.warn(`备份版本 stat 失败（总量巡检跳过该条）：${f.path}`);
          continue;
        }
        versions.push({ path: f.path, name: f.name, bucket: b.path, bytes: size });
        total += size;
      }
    }
    if (total <= this.backupMaxTotalBytes) return;
    // 版本名字典序 = 时序；从最旧开始删，直到进预算
    versions.sort((a, b) => a.name.localeCompare(b.name));
    let over = total;
    let pruned = 0;
    for (const v of versions) {
      if (over <= this.backupMaxTotalBytes) break;
      try {
        await this.bridge.removeFile(v.path);
        over -= v.bytes;
        pruned++;
      } catch (err) {
        this.log?.warn(`备份总量裁剪失败（保留现场）：${v.path} — ${String(err)}`);
      }
    }
    if (pruned > 0) {
      this.log?.warn(
        `备份总量超限（实算 ${total}B > 上限 ${this.backupMaxTotalBytes}B），跨桶按最旧先裁清掉 ${pruned} 版（裁后约 ${over}B）`,
      );
    }
  }

  /** 顺手总量巡检（节流内、尽力而为；挂 in-flight 守门防重叠） */
  private scheduleBackupBytesSweep(): void {
    this.backupBytesSweep = this.backupBytesSweep
      .then(() => this.sweepBackupRootBytes())
      .catch((err: unknown) => {
        this.log?.warn(`备份总量巡检失败（不影响本次备份）：${String(err)}`);
      });
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
    // 失效广播（撤销 op 内新建文件的回滚通道）：文件没了，下游缓存同样不许留
    this.publishBinaryChange('unlink', path);
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
      this.setMeta(this.encodingCache, pathKey(restored), encoding);
      this.setMeta(this.eolCache, pathKey(restored), detectEol(raw));
    }
    this.invalidateTextCache(restored);
    this.publishBinaryChange('add', restored); // 文件回到盘上（撤销删除）：下游缓存同样要收到（additive，同口径）
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
    /** PS-2 起指纹存底按字节记账（懒存：存的是未归一化原文串，保存那一刻才切 EolMap） */
    eolMaps: { files: number; bytes: number };
    rawBytes: { files: number; bytes: number };
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
      eolMaps: { files: this.eolMapCache.size, bytes: this.eolMapBytes },
      rawBytes: { files: this.rawBytesCache.size, bytes: this.rawBytesTotal },
    };
  }
}
