import type { BatchFileStat, DirEntry, FileEncoding, FileStat, WalkOptions } from './platform';

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
  /**
   * **批量**读文本（2026-10-16 批量 IO 批；additive）。
   *
   * 语义与 `readText` 对齐（编码探测 / BOM / EOL 归一化同一条管线），差异有三：
   * - 内部按批走平台批量原语（每批一次 IPC），不再是每文件两趟往返；
   * - 逐文件失败**不抛整批**：失败位为 `null`（失败条件与 `readText` 抛错一致）；
   * - 可命中**会话级文本缓存**（mtime+size 判据；`writeText`/`writeBytes` 会失效该 path）。
   *   `readText` 单文件路径**刻意不接缓存**——打开文件永远新鲜读盘。
   *
   * 返回数组与入参一一对应（含重复路径）。批量抽帧/解码有一次性 CPU 成本，
   * **不要**拿它逐个文件调用（批量接口按批划算，单文件请用 `readText`）。
   */
  readTexts(paths: readonly string[]): Promise<Array<TextFile | null>>;
  readBytes(path: string): Promise<Uint8Array>;
  /**
   * **批量**读原始字节（2026-10-16 市场与导入 IO 批；additive）。
   *
   * 语义与 `readBytes` 对齐（**字节级、零转码**、读侧不受写允许域约束），差异同
   * `readTexts` 那三条：
   * - 内部按批走平台批量原语（每批一次 IPC，Tauri 侧二进制帧、无 base64 膨胀）；
   * - 逐文件失败**不抛整批**：失败位为 `null`（失败条件与 `readBytes` 抛错一致）；
   * - **不经任何缓存**——与 `readBytes` 同口径，每次真读盘。
   *   （这里读的是"刚落盘的那一份字节"，缓存会让校验锚变成"上一版的锚"，
   *   市场装包的逐文件复核要的就是新鲜字节。）
   *
   * 返回数组与入参一一对应（含重复路径）。批量帧有一次性解帧成本，
   * 单文件请用 `readBytes`。
   */
  readBytesMany(paths: readonly string[]): Promise<Array<Uint8Array | null>>;
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
  /**
   * 递归遍历。`opts.filter` 由**本层兑现**（内核实现），且**只筛输出条目、不剪枝**
   * ——谓词跨进程必丢，故桥侧永远收不到它（口径与理由见 `WalkOptions.filter`）。
   */
  walkDir(path: string, opts?: WalkOptions): Promise<DirEntry[]>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat | null>;
  /**
   * **批量** stat（2026-10-16 批量 IO 批交付在平台桥 `PlatformBridge.statFiles`；
   * 本方法是它在 `FileIO` 面上的透传，PERF-10b 追加）。
   *
   * 语义与 `exists`/`stat` 逐字对齐，差异只有一条：**N 个路径一趟**（内核按固定分块走
   * 桥的批量命令），不再"逐条 await"。判定量级不变——目录同样在判定面内（`exists` 本来
   * 就答目录在不在位），只是往返次数从 N 变成 1。
   *
   * - 返回数组与入参**一一对应**（含重复路径）；取不到/不存在 ⇒ `exists:false` + null 数值
   *   （判据不猜，绝不拿 0 兜底）；
   * - 只读操作：**不受写允许域约束**（与 `exists`/`stat` 同口径，游戏目录里的东西照样核得到）；
   * - 单路径请继续用 `exists`/`stat`——批量命令有一次性序列化成本，一条不值得。
   */
  statFiles(paths: readonly string[]): Promise<BatchFileStat[]>;
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
  /**
   * 应用数据目录（**平台桥已有原语的内核透传**）。
   *
   * 只用于**派生应用自有子目录**（如 `<appData>/market`、`<appData>/workspaces`）。
   * 扩大写允许域的唯一通道仍是 `chooseWorkspaceRoot`（对话框即授权，铁律 6）——
   * **本方法不是授权入口**：拿到 appData 路径不等于获得写权限。
   */
  appDataDir(): Promise<string>;
  /**
   * 重命名 / 移动（透传平台桥 `rename`，原子搬运用）。
   * **两端都过第一道闸**：`from` 与 `to` 任一越权即拒——移动等价于在 `to` 写，
   * 而 `from` 越权意味着在搬别人的东西。
   */
  rename(from: string, to: string): Promise<void>;
  /**
   * **服务端复制**（2026-10-16 市场与导入 IO 批；additive）：字节全程**不过 JS**，
   * 由平台侧一次搬完（Tauri = 一条 `copy_file` 命令，既不出字节也不建目录的往返）。
   *
   * 闸的语义**与 `rename` 不同，而且必须不同**：
   * - **只对 `to` 断言** `assertWritable`（写侧照 `writeBytes` 同闸）；
   * - **`from` 不过闸**——读路径本来就不受写允许域约束（整个游戏目录可读、不可写），
   *   而"从只读目录复制进作者工作区"正是本原语的主要用途。**照 `rename` 抄成两端断言，
   *   会把导入这条正常链路误拒**（`from` 恒在只读域内）。
   *
   * **这不是第二条绕开写允许域的通道**（铁律 6 的法定域外写通道只有 `exportFile`，
   * 它的授权来自系统对话框的显式选择）：本方法的 `to` 是一个**普通路径参数**，
   * 因此**必须**落在可写允许域内，否则 `WriteNotAllowedError`。
   * 换句话说本原语只省往返，**一个字节都不多写**：目标侧的判定与 `writeBytes` 逐字相同，
   * 平台侧另有第二道闸（Rust `copy_file` 的 `ensure_write_allowed(.., "copy_dst")`）。
   *
   * 其余口径：字节级（零转码，与 `readBytes`+`writeBytes` 同结果）；平台侧顺带
   * 创建 `to` 的父目录（故调用方**不必**先 `ensureDir`——那会让每文件多出一趟往返）；
   * `to` 已存在则被覆盖（与 `writeBytes` 的原子写同为"后写为准"，不做备份——
   * 备份是 `writeText` 那条编辑链路的事，搬运链路不背）。
   *
   * @throws WriteNotAllowedError 当 `to` 不在可写白名单内（`from` 不参与判定）
   */
  copyFile(from: string, to: string): Promise<void>;
  /**
   * 递归删除目录（透传平台桥 `removeDir`；不存在时幂等成功）。
   * 同样先过 `assertWritable`——删是比写更狠的盘上动作。
   */
  removeDir(path: string): Promise<void>;
  /**
   * 删除**单个文件**（透传平台桥 `removeFile`；additive，文件树编辑批）。
   *
   * 闸的语义与 `removeDir` 同闸同罚：先过 `assertWritable`——删是比写更狠的盘上动作，
   * 判定口径与 Windows 大小写/分隔符折叠都沿用第一道闸的既有约定（`pathKey`）；
   * 平台侧另有第二道闸（Rust `remove_file` 的 `ensure_write_allowed(.., "remove")`）。
   * 删除成功后内核会同步失效该 path 的会话文本缓存（口径与 `writeBytes` 逐字相同：
   * 盘上没了，缓存不能还留着旧内容）。
   *
   * **与 `removeDir` 的语义差**：本方法**不做幂等兜底**——目标不存在时如实拒绝
   * （平台侧 NotFound 原样上抛）。"删一个自以为存在的东西"应当听见响，
   * 而不是被静默吞掉；调用侧要"无所谓在不在"的清理语义请自行 catch。
   *
   * 只能删文件：目录请用 `removeDir`（平台侧对目录同样按 NotFound/失败拒绝）。
   *
   * @throws WriteNotAllowedError 当路径不在可写白名单内
   */
  removeFile(path: string): Promise<void>;
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
