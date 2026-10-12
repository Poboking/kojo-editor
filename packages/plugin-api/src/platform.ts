import type { FileChangeKind } from './events';
import type { Unsubscribe } from './base';

/** 内核支持的文本编码（内部统一 UTF-8 表示，读写时按文件探测/保持） */
export type FileEncoding = 'utf-8' | 'utf-8-bom' | 'shift_jis' | 'utf-16le' | 'utf-16be';

export interface DirEntry {
  name: string;
  /** 绝对路径 */
  path: string;
  isDirectory: boolean;
}

export interface FileStat {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
}

export interface WalkOptions {
  /** 最大递归深度（相对于起点，0 = 只列本层）；默认不限 */
  maxDepth?: number;
  includeFiles?: boolean;
  includeDirs?: boolean;
  /** 返回 false 时跳过该条目（目录被跳过则整棵子树跳过） */
  filter?: (entry: DirEntry) => boolean;
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
   * 导出目录（2026-10-12 口上项目批 P-D）：弹对话框选择导出目的地，把 `srcDir`
   * **整个目录**复制进去（保留目录名），返回导出落点目录的完整路径；
   * 用户取消 → null。对话框 + 复制绑定在**同一个平台命令**（用户确认才写盘）。
   * 目标已存在同名目录时报错不覆盖。Node 桥无对话框 → 抛 unsupported。
   */
  exportDirectory(srcDir: string, opts?: { title?: string }): Promise<string | null>;
  /**
   * 导出**单个文件**（2026-10-12 导出批，ZIP 发布包用）：弹系统保存对话框，把 `bytes`
   * 写到用户选定的位置，返回落点完整路径；用户取消 → null。
   *
   * 与 `exportDirectory` 同一条授权模型：**对话框与写盘绑定在同一个平台命令**，
   * JS 拿不到落点决定权，所以落点在写白名单之外是设计意图而非漏洞。
   * `fileName` 只是对话框预填建议（平台侧会剥掉路径分隔符）。
   * Node 桥无对话框 → 抛 unsupported。
   */
  exportFile(fileName: string, bytes: Uint8Array, opts?: { title?: string }): Promise<string | null>;
  /** 应用数据目录（存储域 / 备份的根） */
  appDataDir(): Promise<string>;
  /** 字节 → 字符串 */
  decode(bytes: Uint8Array, encoding: FileEncoding): Promise<string>;
  /** 字符串 → 字节 */
  encode(text: string, encoding: FileEncoding): Promise<Uint8Array>;
}
