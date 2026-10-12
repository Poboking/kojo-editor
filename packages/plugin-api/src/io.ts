import type { DirEntry, FileEncoding, FileStat, WalkOptions } from './platform';

export type EolStyle = 'crlf' | 'lf';

/** 读到的文本文件（含探测出的编码与换行风格） */
export interface TextFile {
  path: string;
  /** 统一内部表示：UTF-8、换行已归一化为 \n */
  text: string;
  encoding: FileEncoding;
  eol: EolStyle;
  mtimeMs: number | null;
}

export interface WriteTextOptions {
  /** 默认 'preserve'：保持文件原编码（在读取时探测）；首次写入找不到原编码时用 utf-8-bom */
  encoding?: FileEncoding | 'preserve';
  /** 默认 'preserve' */
  eol?: EolStyle | 'preserve';
  /** 默认 true：写前自动备份（{appDataDir}/backup/，保留最近 N 版） */
  backup?: boolean;
}

/**
 * 文件 IO 服务（内核 `kernel.io`）。
 *
 * 安全模型（对应架构文档 §3.4）：
 * - 游戏目录整体视为只读；写操作仅允许落在 `setWritableRoots` 声明的路径内，
 *   越权写入直接拒绝（异常），不依赖调用方自觉；
 * - 写前自动备份 + 原子写；
 * - 编码：读时探测、写时保持原编码（一次保存毁半库是历史教训）。
 */
export interface FileIO {
  readText(path: string): Promise<TextFile>;
  readBytes(path: string): Promise<Uint8Array>;
  /**
   * 写文本。
   * @throws WriteNotAllowedError 当路径不在可写白名单内
   */
  writeText(path: string, text: string, opts?: WriteTextOptions): Promise<void>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  /**
   * 递归创建目录（已存在则幂等成功）。
   *
   * 与 `writeBytes` 同受第一道闸约束：路径不在可写白名单内时拒绝并抛
   * `WriteNotAllowedError`（**先建目录再写文件**的链路里，目录创建同样不能
   * 越过白名单——否则会先在域外造出目录，违反"游戏目录整体只读"）。
   *
   * @throws WriteNotAllowedError 当路径不在可写白名单内
   */
  ensureDir(path: string): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  walkDir(path: string, opts?: WalkOptions): Promise<DirEntry[]>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat | null>;
  /** 声明可写根（由项目打开流程调用；替换而非追加） */
  setWritableRoots(roots: string[]): void;
  /**
   * 声明应用自有**常驻**可写根（如工作区根；2026-10-12 工作区批新增）。
   * 与 `setWritableRoots` 的项目授权语义独立：生命周期跟应用走，
   * **不受** `setWritableRoots([])`（项目关闭收回授权）影响。
   */
  setAppWritableRoots(roots: string[]): void;
  isWritable(path: string): boolean;
  /** 手动备份文件；返回备份路径（文件不存在时返回 null） */
  backup(path: string): Promise<string | null>;
  /**
   * 导出**单个文件**（2026-10-12 导出批）：平台保存对话框选落点 + 写字节，
   * 绑定在同一平台命令内。返回落点完整路径；取消 → null。
   *
   * 这是**唯一**一条合法的"写到白名单之外"通道：授权来自用户在系统对话框里的显式选择，
   * 故内核侧刻意不调 `assertWritable`。新增任何"写到域外"的能力必须照此形态
   * （对话框与写盘绑在同一个平台命令，JS 拿不到落点决定权），不得开放任意目标路径参数。
   * 平台无对话框能力（Node 桥）时抛错，调用侧自解释呈现。
   *
   * （2026-10-13 契约收缩：同形态的 `exportDirectory`（整目录复制）已删——导出改走 ZIP
   * 之后它在全仓没有任何生产调用方，而"只有一条法定绕闸通道"这句话不该同时挂着
   * 一条没人用的能力。要恢复请照 `exportFile` 的形态重新加，别留"以防万一"。）
   */
  exportFile(fileName: string, bytes: Uint8Array, opts?: { title?: string }): Promise<string | null>;
}

/** 越权写入错误（内核抛出、UI 捕获展示） */
export class WriteNotAllowedError extends Error {
  constructor(
    public readonly path: string,
    public readonly writableRoots: readonly string[],
  ) {
    super(`Write not allowed outside declared writable roots: ${path}`);
    this.name = 'WriteNotAllowedError';
  }
}
