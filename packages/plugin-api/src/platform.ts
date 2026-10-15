import type { FileChangeKind } from './events';
import type { Unsubscribe } from './base';

/** 内核支持的文本编码（内部统一 UTF-8 表示，读写时按文件探测/保持） */
export type FileEncoding = 'utf-8' | 'utf-8-bom' | 'shift_jis' | 'utf-16le' | 'utf-16be';

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
 * 远程取文本的两层契约（内核服务键 `kernel.remote`，实现 = 平台桥的零逻辑透传）。
 *
 * 单独立一个服务键的理由与 `sugar.liftApply` 同源：**能力面 = 服务键面**。
 * 出网与读写文件是两种能力，插件要网络就得显式 require，
 * 不能靠"反正我已经有 `kernel.io` 了"顺带拿到。
 * `FileIO` 因此**没有**任何远程方法（2026-10-15 收口：远程面只有 `kernel.remote` 这一条入口）。
 *
 * 契约里**没有任何主机名**：哪些地址可信由平台侧唯一决定（Rust `market.rs`），
 * 两处各写一份白名单必然漂。
 *
 * 方法名两层同名 `fetchText`（桥 = 传输原语、服务 = 插件面；改名只许一次改齐两侧，
 * 半个改名会让 `kernel.remote` 与桥各说各话）。
 */
export interface RemoteService {
  /**
   * @throws 平台无此能力（Node 桥）、URL 被白名单/协议/端口闸拒、跳到白名单外、
   * 体积超限、超时、非 UTF-8 —— 一律抛错并带人话原因，调用侧自解释呈现。
   */
  fetchText(url: string, opts?: RemoteTextOptions): Promise<RemoteText>;
}

export interface WalkOptions {
  /** 最大递归深度（相对于起点，0 = 只列本层）；默认不限 */
  maxDepth?: number;
  includeFiles?: boolean;
  includeDirs?: boolean;
  /** 返回 false 时跳过该条目（目录被跳过则整棵子树跳过） */
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
 * - 编解码由平台提供：Node 用 WHATWG TextDecoder/iconv-lite，Tauri 用 Rust encoding_rs。
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
  /** 非递归列目录；路径不存在时返回空数组 */
  listDir(path: string): Promise<DirEntry[]>;
  /** 递归遍历；路径不存在时返回空数组 */
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
   */
  chooseWorkspaceRoot(opts?: { title?: string }): Promise<string | null>;
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
  /** 字节 → 字符串 */
  decode(bytes: Uint8Array, encoding: FileEncoding): Promise<string>;
  /** 字符串 → 字节 */
  encode(text: string, encoding: FileEncoding): Promise<Uint8Array>;
}
