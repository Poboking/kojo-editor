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
 * 本地历史的一个备份版本（`listBackups` 条目；1015 历史批）。
 *
 * 版本来自**写前自动备份**的既有落点（`{appDataDir}/backup/{bucket}/{timestamp}.bak`），
 * 本契约只是把这份目录读回来——不引入第二套备份约定。
 */
export interface BackupVersion {
  /** 版本号 = 备份文件名（`YYYYMMDD-HHmmss-mmm.bak`；单层、无分隔符） */
  id: string;
  /** 备份文件绝对路径（appData 恒可读；可交给 readText / diff 视图现读） */
  path: string;
  /** 文件名时间戳解析出的版本时刻（本地时区 epoch ms；解析失败 = null，不猜） */
  takenAtMs: number | null;
  /** 字节数（与 `mtimeMs` 同源来自 stat；stat 竞态失败的条目整条剔除并记日志，不拿 0 兜底） */
  size: number;
  mtimeMs: number;
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
  /**
   * **追加**一个常驻可写根（2026-10-14 新建项目自选位置批）。
   * 与 `setAppWritableRoots` 的整替语义并存：本方法只追加、已存在的根去重后跳过，
   * 用于"会话中途新增一个授权根"而不收回既有授权（同一目录的不同写法算同一个根）。
   */
  addAppWritableRoot(root: string): void;
  /**
   * 自选「项目位置」根（2026-10-14 新建项目自选位置批）：系统目录对话框选一个文件夹，
   * 选定即由平台侧（对话框与授权绑在同一个平台命令内）登记为常驻授权根，
   * 本层同步把它追加进常驻可写根；返回选定路径，取消 → null。
   *
   * 与 `exportFile` 同族、同一暴露方式：这是插件侧唯一能"让写允许域变宽"的通道，
   * 而它**不接受路径入参**——授权只能来自用户在对话框里的显式选择（铁律 6）。
   * 平台无对话框能力（Node 桥）时抛错，调用侧自解释呈现。
   */
  chooseWorkspaceRoot(opts?: { title?: string }): Promise<string | null>;
  isWritable(path: string): boolean;
  /** 手动备份文件；返回备份路径（文件不存在时返回 null） */
  backup(path: string): Promise<string | null>;
  /**
   * 列出某文件的全部本地历史版本（additive，1015 历史批）。
   *
   * 落点与哈希口径 = `backup()` 那一份单一真源（同桶名规则、同文件名格式），
   * **新按旧排**（时间戳文件名字典序 = 时序）。从未写过 = 空数组，不是错误。
   * 只读操作：不受写白名单约束，游戏目录里的文件同样列得到。
   */
  listBackups(path: string): Promise<BackupVersion[]>;
  /**
   * 用某个历史版本覆盖磁盘当前内容（additive，1015 历史批；本地时间线「恢复这一版」）。
   *
   * 写路径**只走既有链路**，不开新的写入口：
   * - 第一道闸 `assertWritable` 先行（只读的游戏目录 → `WriteNotAllowedError`，可见拒绝）；
   * - 恢复前对当前内容做**写前自动备份**（与 `writeText` 同款时序，恢复不吃掉现状）；
   * - **字节级**写回 + 平台原子写：版本内容原样落盘（编码 / EOL = 那一版自己，零转码），
   *   并同步刷新内核的编码/EOL 缓存，后续 `writeText` 的 preserve 口径跟着版本走。
   * versionId 必须命中备份文件名格式（拒绝一切分隔符 / `..`，路径不可逃逸出备份桶）。
   */
  restoreBackup(path: string, versionId: string): Promise<void>;
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
