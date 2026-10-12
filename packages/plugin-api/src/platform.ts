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
  /** 监视若干目录（递归）；返回取消函数 */
  watchDirs(paths: string[], onEvent: WatchCallback): Promise<Unsubscribe>;
  /** 目录选择对话框；用户取消返回 null */
  chooseDirectory(opts?: { title?: string }): Promise<string | null>;
  /**
   * 导出目录（2026-10-12 口上项目批 P-D）：弹对话框选择导出目的地，把 `srcDir`
   * **整个目录**复制进去（保留目录名），返回导出落点目录的完整路径；
   * 用户取消 → null。对话框 + 复制绑定在**同一个平台命令**（用户确认才写盘）。
   * 目标已存在同名目录时报错不覆盖。Node 桥无对话框 → 抛 unsupported。
   */
  exportDirectory(srcDir: string, opts?: { title?: string }): Promise<string | null>;
  /** 应用数据目录（存储域 / 备份的根） */
  appDataDir(): Promise<string>;
  /** 字节 → 字符串 */
  decode(bytes: Uint8Array, encoding: FileEncoding): Promise<string>;
  /** 字符串 → 字节 */
  encode(text: string, encoding: FileEncoding): Promise<Uint8Array>;
}
