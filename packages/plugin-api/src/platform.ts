import type { FileChangeKind } from './events';
import type { Unsubscribe } from './base';
import type { LauncherHostBridge } from './launcher';
import type {
  MarketDownloadProgress,
  MarketPublishManifestSummary,
  MarketPublishOutcome,
  MarketPublishProgress,
} from './market';

/**
 * 内核支持的文本编码（内部统一 UTF-8 表示，读写时按文件探测/保持）。
 * `gbk` / `gb18030` / `big5` = 简中 / 大字符集简中 / 繁中传统编码（2026-10-17 编码标签批）；
 * 探测只会产出 `gbk` 与 `big5`（gb18030 是 GBK 严格超集、字节级兼容，无法从内容
 * 稳定区分，由调用方显式指名）。
 */
export type FileEncoding =
  | 'utf-8'
  | 'utf-8-bom'
  | 'shift_jis'
  | 'gbk'
  | 'gb18030'
  | 'big5'
  | 'utf-16le'
  | 'utf-16be';

/**
 * `FileEncoding` → WHATWG Encoding Standard 解码标签（**单源**，W12 ENC-SRC）。
 * 两具平台桥（Tauri / Node）都 import 这一张表——旧局是两份手抄，PITFALLS 73 同族教训：
 * 同形守卫只要有一边手抄就必然漂。`utf-8-bom` 走 `utf-8`：TextDecoder 默认剥前导 BOM。
 */
export const DECODE_LABEL: Record<FileEncoding, string> = {
  'utf-8': 'utf-8',
  'utf-8-bom': 'utf-8',
  shift_jis: 'shift_jis',
  gbk: 'gbk',
  gb18030: 'gb18030',
  big5: 'big5',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
};

/** 判序表的一条：字节前缀命中 ⇒ 该编码（解码标签由 `DECODE_LABEL` 派生） */
export interface DecodeBomRule {
  readonly bom: readonly number[];
  readonly encoding: FileEncoding;
}

/**
 * 解码判据**唯一形状**（version 1）：BOM 判序（`bomRules` 逐条）→ UTF-8 严格校验
 * （fatal；成功即正文）→ `fallbackEncoding` 不严格解码（非法字节替换为 U+FFFD，不抛）。
 *
 * 这是一份**跨语言可校验的共享常量表**：表体 = 同目录 `decode-probe-policy.json`——
 * Rust 宿主 `include_str!` 编译期内嵌并驱动其策略解释器（检索侧），TS 内核用下面的
 * `DECODE_PROBE_POLICY` 常量；两者逐字对拍由 `packages/kernel/tests/encoding-decode-policy.test.ts`
 * 钉死（表体漂一个字节即红）。此前 TS 内核 / Rust 检索 / Rust `decode_bytes` 三处各写各的
 * if 链，同一字节流的命中文本与编辑器文本可以不一致（U+FFFD vs fatal 拒绝）——已合一。
 */
export interface DecodeProbePolicy {
  readonly version: 1;
  readonly bomRules: readonly DecodeBomRule[];
  readonly fallbackEncoding: FileEncoding;
}

/** TS 侧的策略常量（解释者 = `packages/kernel/src/encoding.ts` 的 `decodeWithProbe` / `probeEncoding`） */
export const DECODE_PROBE_POLICY: DecodeProbePolicy = {
  version: 1,
  bomRules: [
    { bom: [0xef, 0xbb, 0xbf], encoding: 'utf-8-bom' },
    { bom: [0xff, 0xfe], encoding: 'utf-16le' },
    { bom: [0xfe, 0xff], encoding: 'utf-16be' },
  ],
  fallbackEncoding: 'shift_jis',
};

export interface DirEntry {
  name: string;
  /** 绝对路径 */
  path: string;
  isDirectory: boolean;
  /**
   * 仅当 `walkDir(path, { withMetadata: true })` 时填充：文件 mtime（epoch ms），
   * **与 `stat()` 同源同值**。用途是把"逐文件 stat 的 N 次 IPC"折进一次遍历
   * （IMPLEMENTATION-LOG §5.92 / §5.117：热开 2.66s 里 `stat` 独占 2.04s）。
   * 目录条目、或桥未实现该选项 ⇒ `undefined`；调用方必须能退化回 `stat()`，**不许拿 0 兜底**。
   */
  mtimeMs?: number;
  /** 同 `mtimeMs`：文件字节数 */
  size?: number;
}

export interface FileStat {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
}

/**
 * 批量读的**逐文件**结果（`readFilesRaw` 的返回值；2026-10-16 批量 IO 批）。
 *
 * 三态与 Rust 侧帧格式的 status 字段一一对应（0=ok / 1=not-found / 2=read-error）：
 * 批量语义下**逐文件失败不抛整批**，失败的构成本对象如实带回（不静默）。
 */
export interface RawFileRead {
  path: string;
  status: 'ok' | 'not-found' | 'read-error';
  /** 仅 `status==='ok'` 时有效；取不到为 null（绝不拿 0 兜底） */
  mtimeMs: number | null;
  /** 仅 `status==='ok'` 时有效；取不到为 null */
  size: number | null;
  /** `status==='ok'` 时为文件原始字节（不剥 BOM、不解码）；其余为空数组 */
  data: Uint8Array;
}

/** 批量 stat 的逐文件结果（`statFiles` 的返回值）。不存在/取不到 ⇒ `exists:false` + null 数值 */
export interface BatchFileStat {
  path: string;
  exists: boolean;
  mtimeMs: number | null;
  size: number | null;
}

/**
 * 远程**文本**拉取的结果（不落盘；小文件走 IPC 回字节）。
 * `finalUrl` 是重定向之后的落点，平台侧已按同一份白名单重核过（诊断用）。
 */
export interface RemoteText {
  text: string;
  bytes: number;
  status: number;
  finalUrl: string;
}

/** 远程拉取的可调项（限额由调用方从契约常量传入；平台侧只保留"没传时"的兜底口径） */
export interface RemoteTextOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * 容器（ZIP 包体）下载的结果。
 * **字节不经 IPC 回 TS**——容器落进平台侧自拼的暂存区，TS 只拿到"这次请求的事实"
 * （体积 / 状态码 / 终态 URL），摘要由 TS 侧对同一个文件复算。
 */
export interface RemoteDownload {
  bytes: number;
  status: number;
  finalUrl: string;
}

/** 容器下载的可调项（与取文本同口径；**刻意没有 proxy**——代理只认进程环境，见 Rust 侧） */
export interface RemoteDownloadOptions {
  timeoutMs?: number;
  /** 体积硬上限：调用方按注册表声明的 `zip.bytes` 传入 ⇒ 超声明一个字节都不收 */
  maxBytes?: number;
  /**
   * 下载进度回调（平台侧流式回报，**节流后**才到这里——不是逐块直发，见 Rust `market.rs`）。
   * 可选：不给 ⇒ 平台侧一条进度都不发。Node 测试桥没有远程能力，本项随之缺席。
   */
  onProgress?: (p: MarketDownloadProgress) => void;
}

/**
 * 解压限额：三个数**全部由调用方从契约常量传入**（`market.ts` 的 `MARKET_MAX_*`）。
 * 平台侧不留默认值 = 不留第二份真相。
 */
export interface RemoteExtractLimits {
  maxEntries: number;
  maxDepth: number;
  maxUnpackedBytes: number;
}

/** 解出来的一个条目：posix 相对路径（`/`）+ 落盘真实字节数 */
export interface RemoteExtractEntry {
  path: string;
  bytes: number;
}

export interface RemoteExtractResult {
  entries: RemoteExtractEntry[];
  totalBytes: number;
}

/** 容器发布（上传）的可调项（限额由调用方从契约常量传入；平台侧只保留"没传时"的兜底口径） */
export interface RemotePublishOptions {
  timeoutMs?: number;
  /** 上传体积硬上限：调用方按契约常量 `MARKET_MAX_CONTAINER_UPLOAD_BYTES` 传入 */
  maxBytes?: number;
  /** 覆盖发布端点（默认 `MARKET_DEFAULT_PUBLISH_URL`；主机不落平台放行表 ⇒ 拒，无任意主机通道） */
  endpoint?: string;
  /** 上传进度回调（平台侧节流后回报，口径与下载同款 ≥64 KiB 或 ≥100 ms） */
  onProgress?: (p: MarketPublishProgress) => void;
}

/** 文件选择对话框的扩展名过滤项（平台侧原样递给系统对话框；扩展名不带点） */
export interface FilePickFilter {
  /** 过滤项的人读名（如 `市场包容器`） */
  readonly name: string;
  /** 扩展名列表（如 `['zip']`） */
  readonly extensions: readonly string[];
}

/**
 * 远程面的**两层唯一契约**（内核服务键 `kernel.remote`，实现 = 平台桥的零逻辑透传）：
 * 取文本 / 容器下载 / 容器解压。
 *
 * 单独立一个服务键的理由与 `sugar.liftApply` 同源：**能力面 = 服务键面**。
 * 出网与读写文件是两种能力，插件要网络就得显式 require，
 * 不能靠"反正我已经有 `kernel.io` 了"顺带拿到。
 * `FileIO` 因此**没有**任何远程方法（2026-10-15 收口：远程面只有 `kernel.remote` 这一条入口）。
 *
 * 容器下载/解压**也挂在这个键**而不是新开一个键，理由是实测的：本键的 `marketDownload`
 * 与 `fetchText` 在平台侧共用同一条出网链路（协议/白名单/逐跳重核/体积各只有一份实现），
 * 而新开键要动装配（`bootstrap.ts`）与 `KernelServices`；`kojo-market` 已经 `requires` 本键
 * ⇒ 加方法零接线改动、插件侧仍只有"一条远程入口"这一个事实。
 * 解压不远程，但它只碰 `marketDownload` 落下的那个同名容器，与它同键 = 一条链路的两个动词，
 * 分键反而让"能不能装包"变成两个独立条件的乘积。
 *
 * 契约里**没有任何主机名**：哪些地址可信由平台侧唯一决定（Rust `market.rs`），
 * 两处各写一份白名单必然漂。
 *
 * 三个方法名三层同名（Rust 命令 / 桥 / 服务；改名只许一次改齐三层，
 * 半个改名会让 `kernel.remote` 与桥各说各话）。
 */
export interface RemoteService {
  /**
   * @throws 平台无此能力（Node 桥）、URL 被白名单/协议/端口闸拒、跳到白名单外、
   * 体积超限、超时、非 UTF-8 —— 一律抛错并带人话原因，调用侧自解释呈现。
   */
  fetchText(url: string, opts?: RemoteTextOptions): Promise<RemoteText>;
  /**
   * 把一个远程**容器**下载进平台侧暂存区，返回这次请求的事实。
   *
   * **没有目标路径参数**：落点由平台侧拼成 `<appData>/market/.staging/<containerName>`
   * （形态照 `exportFile`——授权绑在命令内，JS 拿不到落点决定权）。名字受平台侧的字面闸
   * （必须 `.zip` 结尾、字符集 `[a-z0-9._-]`），**下载与解压共用同一个名字** ⇒ 不存在
   * "写成 .bin 读成 .zip"的两份真相。出网判定（协议 / 可信主机 / 逐跳重核 / 体积）与
   * `fetchText` 是同一条链路，故不在本层再写一份。
   *
   * @throws 平台无此能力（Node 测试桥）/ 名字不合规 / URL 被闸拒 / 体积超限 / 超时 / 非 2xx
   */
  marketDownload(url: string, containerName: string, opts?: RemoteDownloadOptions): Promise<RemoteDownload>;
  /**
   * 把暂存区里那个容器解到**暂存子树内**的 `targetName` 目录，返回解出的条目清单与真实总字节。
   *
   * 与 `marketDownload` 共用同一个容器名 ⇒ 两个命令指向同一个文件。条目路径 / 类型（符号链接
   * 与普通文件）/ 深度 / 条目数 / 解压总字节的闸全在平台侧，**限额数字来自本调用**（契约常量）。
   * 内容口径（哪些条目算合法包内容）不在这层——由 `kojo-market` 按 `pack.json` 双向对平。
   * 失败 ⇒ 平台侧已解出的部分整体删掉，不留残壳。
   */
  marketExtract(containerName: string, targetName: string, limits: RemoteExtractLimits): Promise<RemoteExtractResult>;
  /**
   * 把一个容器**原样上传**到市场发布后端（`POST /publish`；2026-10-16 发布通道批，additive）。
   *
   * **additive 可选**：既有桩（Node 测试桥与各假桥）零改动；无此能力的平台在内核
   * 透传层给一句人话（`kernel/remote.ts` 判缺席）。三方法名三层同名
   * （Rust 命令 `market_publish` / 桥 / 服务）。
   *
   * `zipPath` 是用户经系统对话框选定的文件（**对话框即授权**，照 `exportFile` 的哲学；
   * 读侧无闸是既有口径——`readFileBytes` 同样读任意路径）。zip **零解包零改写**：
   * 平台侧流式读原文件上传，字节不经 IPC 回 JS。manifest 概要只是随行身份字段，
   * 服务端解容器对平才算数。
   *
   * @throws 平台无此能力 / 端点不落放行表 / 体积超限 / 超时 / 响应不可解析——一律人话；
   *         后端**明确拒绝**（`ok:false`）不走抛错，返回 `MarketPublishOutcome` 的 rejected 分支。
   */
  marketPublish?(
    zipPath: string,
    manifest: MarketPublishManifestSummary,
    deviceToken: string,
    opts?: RemotePublishOptions,
  ): Promise<MarketPublishOutcome>;
  /**
   * 向发布后端换一枚设备令牌（`POST /device-token`；发布通道批，additive 可选，
   * 缺席语义同 `marketPublish`）。令牌真源在平台响应，本层零判定；
   * 存取（storage 复用）由 `kojo-market` 服务编排。
   */
  marketDeviceToken?(endpoint?: string): Promise<string>;
}

export interface WalkOptions {
  /** 最大递归深度（相对于起点，0 = 只列本层）；默认不限 */
  maxDepth?: number;
  includeFiles?: boolean;
  includeDirs?: boolean;
  /**
   * 输出条目谓词——**只筛返回集合，不剪枝**（2026-10-16 桥分叉批改口径）。
   *
   * 兑现方 = 内核 `FileIO.walkDir`（`kernel/src/io.ts`），**平台桥不得实现它**：
   * 本字段是 JS 闭包，跨进程桥（`invoke('walk_dir')`）过一次 JSON 就整键消失，
   * 宿主 DTO 里根本没有这一项。让桥各自实现 = 若干份真相，实测代价是
   * 「node 桥兑现 filter ⇒ 测试全绿；Tauri 桥静默丢弃 ⇒ 生产把整棵树读进内存再逐份串行读盘」。
   * 因此本层的枚举**先于**筛选，剪掉一棵子树在构造上不可能——需要限深请用 `maxDepth`。
   *
   * 旧语义「对目录返回 `false` ⇒ 连整棵子树一起剪掉」废止。既有调用方全部写成
   * `e => e.isDirectory || 判定(e.name)`（本就不依赖剪枝），结果集逐字不变。
   */
  filter?: (entry: DirEntry) => boolean;
  /**
   * true ⇒ 每个**文件**条目顺带填 `mtimeMs` / `size`（见 `DirEntry`）。
   * 默认 false：不改变既有调用的开销形态（列目录仍是列目录）。
   */
  withMetadata?: boolean;
}

/** 文件监视回调（内核会在平台事件之上做去抖与归一化） */
export type WatchCallback = (kind: FileChangeKind, path: string) => void;
/** 某个根目录没能监视上（路径不存在 / 权限 / 句柄耗尽） */
export interface WatchFailure {
  root: string;
  reason: string;
}

/**
 * 监视器的**自述**（BUG-5，2026-10-13）：平台层只报告事实，判级与呈现归内核/宿主。
 *
 * - `started`：起监视的即时结果。`watched` 空 = 一个根都没监视上；
 *   `failures` 非空但 `watched` 非空 = 部分监视（宿主须显式说明少了哪些）；
 * - `error`：监视**运行期间**自身出错（目录被卸载 / 底层句柄失效）。
 *   此前这类错误无处可报——`WatchCallback` 只承载文件事件，
 *   监视器静默失灵就等于"看起来在监视、其实早已停摆"。
 */
export type WatchReport =
  | { readonly type: 'started'; readonly watched: string[]; readonly failures: WatchFailure[] }
  | { readonly type: 'error'; readonly reason: string };

export type WatchReportCallback = (report: WatchReport) => void;

/**
 * 平台桥：内核与宿主环境（Node / Tauri）之间的全部 IO 原语。
 *
 * 设计约束：
 * - 内核与插件只依赖此接口，不 import 任何平台的 fs / path / 进程 API；
 * - `writeFileBytes` 必须实现为原子写（临时文件 + rename），调用方无需自行保证；
 * - 解码 = 两桥同形（W12 ENC-SRC）：一律 `new TextDecoder(DECODE_LABEL[encoding])`，
 *   标签表只在本文件这一份；编码侧 Node 用 iconv-lite/TextEncoder、Tauri 用 Rust encoding_rs
 *   （写向的转码器，不引入第二条**读判据**）。
 */
export interface PlatformBridge {
  readFileBytes(path: string): Promise<Uint8Array>;
  /**
   * **批量**读原始字节 + 元数据（2026-10-16 批量 IO 批；additive）。
   *
   * 一次 IPC 带回 N 个文件（Tauri 侧走二进制帧，无 base64 膨胀）。冷开一次项目要读
   * ~9,000 次单文件，每次单文件读= 2 趟 IPC 往返——批量命令把这笔账压成一趟。
   *
   * 契约：返回数组**与入参一一对应**（含重复路径的逐位对应）；逐文件失败以
   * `RawFileRead.status` 如实带回，**不抛整批**；单次调用建议 ≤64 个路径
   * （帧大小与解帧一条主线程同步段的量都随 N 线性涨）。
   */
  readFilesRaw(paths: readonly string[]): Promise<RawFileRead[]>;
  /**
   * **批量** stat（2026-10-16 批量 IO 批；additive）。小载荷，JSON 形态即可。
   * 返回与入参一一对应；不存在 ⇒ `exists:false`（判据不猜，绝不拿 0 兜底）。
   */
  statFiles(paths: readonly string[]): Promise<BatchFileStat[]>;
  /** 原子写：同目录临时文件 + rename 覆盖 */
  writeFileBytes(path: string, data: Uint8Array): Promise<void>;
  ensureDir(path: string): Promise<void>;
  /**
   * **独占创建空文件**（2026-10-27 独占创建原语批；WS-01 竞态的闭合点）。
   *
   * 平台侧必须落成 OS 的 `CREATE_NEW` / `O_CREAT|O_EXCL`：**判存在与建文件是同一个
   * 原子系统调用**——不存在"先 exists 再写"之间那扇会被别人塞进同名文件、再被这次
   * 零字节写静默清空的窗口。
   *
   * - 目标不存在 ⇒ 建一个空文件，返回 `true`；
   * - 目标已存在（文件或文件夹占位） ⇒ **一个字节都不动**，返回 `false`；
   * - 其它失败（父目录不存在 / 权限 / 越权） ⇒ 抛错（不折叠成 `false`——那会把
   *   "写不进去"说成"已存在"）。
   *
   * 写允许域闸与 `writeFileBytes` 同口径、在落盘之前。
   */
  createFileExclusive(path: string): Promise<boolean>;
  /**
   * **独占创建目录**（同批）：`mkdir` 的原子 EEXIST 语义，而不是 `create_dir_all`
   * 那种"已存在也静默成功"——调用方要区分"这次真建了"与"它本来就在"。
   *
   * - 成功 ⇒ `true`；已存在 ⇒ `false`（不动既有内容、不递归）；
   * - 父目录不存在 / 权限 / 越权 ⇒ 抛错（不折叠成 `false`）。
   */
  createDirExclusive(path: string): Promise<boolean>;
  /** 非递归列目录；路径不存在时返回空数组 */
  listDir(path: string): Promise<DirEntry[]>;
  /**
   * 递归遍历；路径不存在时返回空数组。
   *
   * 桥**只负责枚举**：收到的 `opts` 里保证没有 `filter`（谓词由内核 `FileIO.walkDir` 兑现，
   * 见 `WalkOptions.filter`）。跨进程实现只需映射 `maxDepth` / `includeFiles` /
   * `includeDirs` / `withMetadata` 四个可序列化字段，**不要**为本字段发明线格式——
   * 那会造出第二份筛选真相。
   */
  walkDir(path: string, opts?: WalkOptions): Promise<DirEntry[]>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat | null>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  /** 递归删除目录（不存在则幂等成功；写允许域同 writeFileBytes） */
  removeDir(path: string): Promise<void>;
  /**
   * 监视若干目录（递归）；返回取消函数。
   *
   * `onReport`（BUG-5 新增，可选）收监视器**自述**：起监视的逐根结果 +
   * 运行期自身出错。缺省调用方（测试）可只关心文件事件。
   */
  watchDirs(
    paths: string[],
    onEvent: WatchCallback,
    onReport?: WatchReportCallback,
  ): Promise<Unsubscribe>;
  /** 目录选择对话框；用户取消返回 null */
  chooseDirectory(opts?: { title?: string }): Promise<string | null>;
  /**
   * 文件选择对话框（发布通道批，additive 可选）：弹系统文件对话框让作者选**一个文件**，
   * 返回完整路径；取消 → null。**只选不读不写**：本原语不授予任何写许可（不是铁律 6
   * 的写允许域入口），读侧无闸是既有口径（`readFileBytes` 同样读任意路径）。
   * `filters` 只是对话框的扩展名过滤建议（平台侧原样递给系统对话框）。
   * 无对话框能力的平台（Node 桥）不实现，内核透传层给一句人话（照 `exportFile`）。
   */
  chooseFile?(opts?: {
    title?: string;
    filters?: readonly FilePickFilter[];
  }): Promise<string | null>;
  /**
   * 导出**单个文件**（2026-10-12 导出批，ZIP 发布包用）：弹系统保存对话框，把 `bytes`
   * 写到用户选定的位置，返回落点完整路径；用户取消 → null。
   *
   * 授权模型 = **对话框与写盘绑定在同一个平台命令**，JS 拿不到落点决定权，
   * 所以落点在写白名单之外是设计意图而非漏洞。
   * `fileName` 只是对话框预填建议（平台侧会剥掉路径分隔符）。
   * Node 桥无对话框 → 抛 unsupported。
   */
  exportFile(fileName: string, bytes: Uint8Array, opts?: { title?: string }): Promise<string | null>;
  /**
   * 自选「项目位置」根（2026-10-14 新建项目自选位置批）：弹系统目录对话框，
   * 用户选定后由**平台侧在同一个命令内**把该目录登记为常驻授权根并持久化，返回其路径；
   * 取消 → null（授权状态一个字节都不动）。
   *
   * 授权模型与 `exportFile` 同族 = **对话框即授权**：
   * 平台不存在"接受一个路径参数就放行写权限"的命令，JS 拿不到写允许域的扩大入口。
   * Node 桥无对话框 → 抛 unsupported。
   *
   * `forbidRoots`（2026-10-27 游戏目录防护批，additive）：这些目录不许被选成项目位置。
   * 平台侧在**登记 / 落盘之前**做双向包含判定（相等 / 位于其下 / 包含它），
   * 命中即返回中文 Err、一个字节的授权都不留。空列表 / 缺席 = 行为与历史逐字一致。
   */
  chooseWorkspaceRoot(opts?: { title?: string; forbidRoots?: readonly string[] }): Promise<string | null>;
  /**
   * 撤销一个自选项目位置根的常驻授权（2026-10-27 撤销批）。
   *
   * 平台侧把它从常驻授权根（`workspace_roots.txt`）与准入根（`approved_roots.txt`）
   * 两份清单里移除并按规范化路径口径落盘、失效规范化备忘录；默认工作区根（appData 下）
   * 拒绝撤销。这是全仓唯一一条**收窄**写允许域的命令——它只有路径参数，
   * 但只能让允许域变小，故不违铁律 6（铁律 6 管的是"扩大"）。
   * Node 桥无此能力（没有对应的授权状态）→ 抛 unsupported。
   */
  revokeWorkspaceRoot(path: string): Promise<void>;
  /**
   * 目录选择对话框：只弹框、只返回路径，**不登记任何授权**（2026-10-27 导入来源批）。
   *
   * 与 `chooseDirectory`（会登记准入根）和 `chooseWorkspaceRoot`（会登记常驻可写根）
   * 的区别就是这一句"不登记"：选一个**只读来源**（导入的作者包目录）不该让来源
   * 变成可写域——那正是"选到游戏目录就把游戏目录授权了"的旧缺陷。
   * 取消 → null。无对话框能力的平台（Node 桥）不实现，内核透传层给一句人话。
   */
  pickDirectory?(opts?: { title?: string }): Promise<string | null>;
  /**
   * 另存为的**落点选择**对话框（1028 批，additive 可选）：弹系统保存对话框（预填 `defaultFileName`），
   * **只交回选定路径，不写盘、不读取、不授予任何许可**；取消 → null。
   * 与 `exportFile` 刻意分家（那条才是对话框绑写盘的法定域外通道，铁律 6）：本命令交回的只是
   * 候选落点，落盘照旧走内核 io 写允许域双闸——域外落点由调用层诚实拒绝（另存为没有域外通道）。
   */
  pickSavePath?(opts?: {
    title?: string;
    defaultFileName?: string;
    filters?: readonly FilePickFilter[];
  }): Promise<string | null>;
  /**
   * 已获常驻授权的**自选**项目位置根（绝对路径列表；不含默认工作区根，
   * 那由内核自己按 appDataDir 拼）。不存在的目录平台侧会剔除并出声。
   * 无此能力的平台（Node 桥）返回空列表。
   */
  listWorkspaceRoots(): Promise<string[]>;
  /** 应用数据目录（存储域 / 备份的根） */
  appDataDir(): Promise<string>;
  /**
   * 拉一个远程**文本**（注册表索引这类小文件；**不落盘**，字节经 IPC 回来）。
   *
   * **能信哪些主机由平台侧唯一决定**：协议 / 主机白名单 / 逐跳重定向重核 / 体积上限 / 超时
   * 全在平台命令内完成，本层与内核零判定 ⇒ 全仓不存在第二份白名单（它会漂）。
   * 调用方只拿到"要么是人话错误、文本要么可信"。
   *
   * 无此能力的平台（Node 桥）**抛错**，调用侧自解释呈现（照 `exportFile` / `chooseWorkspaceRoot`
   * 口径）——不许为了"测试里能跑"在 Node 桥复制一份白名单或退回 `fetch()`。
   */
  fetchText(url: string, opts?: RemoteTextOptions): Promise<RemoteText>;
  /**
   * 容器下载到平台侧暂存区（语义与拒因见 `RemoteService.marketDownload`，**同一份口径**）。
   * 落点由平台侧自己拼、名字受平台侧字面闸约束 ⇒ 本层没有目标路径参数。
   * 无此能力的平台（Node 桥）抛错，不降级。
   */
  marketDownload(url: string, containerName: string, opts?: RemoteDownloadOptions): Promise<RemoteDownload>;
  /**
   * 容器解压到暂存子树内的 `targetName` 目录（语义见 `RemoteService.marketExtract`）。
   * 限额三个数一律由调用方从契约常量传入；失败由平台侧清掉已解出的全部内容。
   */
  marketExtract(containerName: string, targetName: string, limits: RemoteExtractLimits): Promise<RemoteExtractResult>;
  /**
   * 容器原样上传到发布后端（语义与拒因见 `RemoteService.marketPublish`，同一份口径）。
   * **additive 可选**：无此能力的平台（Node 桥）不实现，内核透传层给一句人话。
   */
  marketPublish?(
    zipPath: string,
    manifest: MarketPublishManifestSummary,
    deviceToken: string,
    opts?: RemotePublishOptions,
  ): Promise<MarketPublishOutcome>;
  /** 换设备令牌（语义见 `RemoteService.marketDeviceToken`）；additive 可选，缺席语义同上 */
  marketDeviceToken?(endpoint?: string): Promise<string>;
  /**
   * 启动器宿主原语（2026-10-26 启动器落地批，additive 可选）。
   *
   * 为什么是**一个子对象**而不是二十几个平铺方法：启动器是一整个能力面（进程 / 实例 /
   * 日志 / 信任），平铺进 `PlatformBridge` 会让"要读盘的人顺带看见要起进程的人"这层
   * 边界彻底糊掉；子对象缺席 = 该平台没有启动器能力，内核透传层给一句人话
   * （照 `exportFile` / `chooseWorkspaceRoot` 的既有口径），**不降级**。
   *
   * 形状见 `LauncherHostBridge`：没有任何方法接受「目标程序路径」，也没有任何方法
   * 接受「写到这里的路径」——落点只有 appData 现算与「对话框即授权」两种。
   */
  launcher?: LauncherHostBridge;
  /**
   * 字节 → 字符串（按标签解码，不探测）。两桥实现逐字同形：
   * `new TextDecoder(DECODE_LABEL[encoding]).decode(bytes)`——探测判序在上层
   * `decodeWithProbe`（内核单源），桥不得自带第二套探测。
   */
  decode(bytes: Uint8Array, encoding: FileEncoding): Promise<string>;
  /** 字符串 → 字节 */
  encode(text: string, encoding: FileEncoding): Promise<Uint8Array>;
}
