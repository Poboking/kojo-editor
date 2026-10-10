/**
 * 状态快照来源契约（v0.2 第四批：sav-parser 先行 / v1.0 快照回放的地基）。
 *
 * 设计分层（"一切皆插件"）：
 * - **契约**（本文件，游戏无关）：存档（archive）的通用结构模型与快照来源服务接口。
 *   Emuera 系引擎的二进制存档格式（"1808"）是**引擎级**通用格式（跨游戏一致），
 *   因此结构模型属于契约层；具体游戏语义（哪个编号是角色好感度等）由 game adapter
 *   的 `variableSchema` / `stateModel` 提供，通用层只做结构呈现；
 * - **引擎**（`sav-parser` 插件）：字节协议解析（纯读先行；写/注入随 v1.1）；
 * - **消费者**：state-replay（v1.0：把归档模型归约为状态快照并驱动条件求值）、
 *   未来的归档浏览器面板。
 *
 * 术语：用 archive（存档归档）指代已解析的二进制内容，服务键为 `snapshot.source`。
 *
 * 稳健性原则：解析**宽容但不静默**——单档失败进 `error` 字段不中断扫描；
 * 残余字节 / 精度降级 / 数组截断全部有显式标记。
 */

/** 存档文件类型（引擎二进制格式顶层枚举） */
export type ArchiveFileType = 'normal' | 'global' | 'var' | 'charvar';

/** 容器编码：gzip（压缩存档魔数）或 raw（未压缩正文） */
export type ArchiveContainerFormat = 'gzip' | 'raw';

/** 数组变量类型（int/str × 1D/2D/3D） */
export type ArchiveArrayType =
  | 'int-array-1d'
  | 'int-array-2d'
  | 'int-array-3d'
  | 'str-array-1d'
  | 'str-array-2d'
  | 'str-array-3d';

/** 稀疏数组单元（多维度下标 + 值） */
export interface ArchiveArrayCell {
  /** 下标（1-3 个元素，与数组维度一致） */
  index: readonly number[];
  value: number | string;
}

/** 标量变量 */
export interface ArchiveScalarVariable {
  type: 'int' | 'str';
  key: string;
  value: number | string;
  /** 流内起始字节偏移（排障用） */
  offset: number;
  /**
   * 原始字节区间（v0.2 第十三批方案 B；仅 `keepRaw` 解析选项下记录）——
   * 类型 token 起、值毕（不含流控制标记）。写侧 passthrough：未修改的变量
   * 原样复制，绕开重编码（Int64 近似值不再写回 = 损坏风险归零）。
   */
  raw?: Uint8Array;
}

/**
 * 数组变量（稀疏存储：仅非零/非空单元；全零尾段被写侧游程优化剪除，
 * 读侧通过 saveLen 恢复声明长度）。
 */
export interface ArchiveArrayVariable {
  type: ArchiveArrayType;
  key: string;
  /** 声明维度长度（1-3 个元素） */
  saveLen: readonly number[];
  /** 读毕游标（1-3 个元素，与维度一致） */
  cursor: readonly number[];
  /** 非零/非空单元数（cells 被省略时仍准确） */
  nonEmpty: number;
  /** 非空单元；`keepArrayCells:false` 或超出上限时被省略/截断 */
  cells: readonly ArchiveArrayCell[];
  /** cells 不完整（被省略或截断——显式标记，不静默） */
  cellsTruncated?: boolean;
  offset: number;
  /** 原始字节区间（v0.2 第十三批方案 B；语义同 ArchiveScalarVariable.raw） */
  raw?: Uint8Array;
}

/** 键值对映射变量 */
export interface ArchiveMapVariable {
  type: 'map';
  key: string;
  count: number;
  pairs: ReadonlyArray<readonly [string, string]>;
  offset: number;
  /** 原始字节区间（v0.2 第十三批方案 B；语义同 ArchiveScalarVariable.raw） */
  raw?: Uint8Array;
}

/** XML 串变量 */
export interface ArchiveXmlVariable {
  type: 'xml';
  key: string;
  value: string;
  offset: number;
  /** 原始字节区间（v0.2 第十三批方案 B；语义同 ArchiveScalarVariable.raw） */
  raw?: Uint8Array;
}

/** 数据表变量（schema 串 + data 串） */
export interface ArchiveDataTableVariable {
  type: 'datatable';
  key: string;
  schema: string;
  data: string;
  offset: number;
  /** 原始字节区间（v0.2 第十三批方案 B；语义同 ArchiveScalarVariable.raw） */
  raw?: Uint8Array;
}

export type ArchiveVariable =
  | ArchiveScalarVariable
  | ArchiveArrayVariable
  | ArchiveMapVariable
  | ArchiveXmlVariable
  | ArchiveDataTableVariable;

/**
 * 角色块（存档角色区条目）：
 * 内置变量流 + 分隔符 + #DIM 扩展变量流。
 */
export interface ArchiveCharacterBlock {
  /** 出现顺序（0 基；角色区序号，非角色编号） */
  index: number;
  /** 变量（按流序；前 `dimSepIndex` 个为内置变量，其后为 #DIM 变量） */
  vars: readonly ArchiveVariable[];
  /** 内置 / #DIM 变量的分界点（无分隔符时 null） */
  dimSepIndex: number | null;
}

/** 存档元数据（浅解析即可获得的部分） */
export interface ArchiveMeta {
  path: string;
  fileName: string;
  /** 原始文件字节数 */
  size: number;
  format: ArchiveContainerFormat;
  /** 二进制格式版本（本引擎为 1808） */
  version: number;
  fileType: ArchiveFileType;
  /** 唯一码（64 位整数，字符串保精度） */
  uniqueCode: string;
  /** 游戏侧版本（64 位整数，字符串保精度） */
  gameVersion: string;
  /** 存档备注（引擎写入，如日期 / 地点 / 角色） */
  saveMes: string;
  /** 角色数（仅 normal / charvar 有意义；其余为 0） */
  charCount: number;
  /** 解压后正文字节数 */
  decompressedSize: number;
}

/** 完整解析结果 */
export interface SnapshotArchive extends ArchiveMeta {
  /** 角色区（normal / charvar） */
  chars?: readonly ArchiveCharacterBlock[];
  /** 主变量区（normal / var） */
  vars?: readonly ArchiveVariable[];
  /** 全局变量区（global） */
  globalVars?: readonly ArchiveVariable[];
  /** 扩展区（normal / global 的第二段：Map / Xml / DataTable 等） */
  emVars?: readonly ArchiveVariable[];
  /** 正文总字节数 */
  bodySize: number;
  /** 已消费字节数 */
  consumed: number;
  /** 残余字节数（>0 = 协议未完全消费；显式呈现，不静默） */
  remaining: number;
  /** 解析警告（如 64 位值超安全整数范围的精度提示；不中断解析） */
  warnings?: readonly string[];
}

/** 扫描阶段单档条目 */
export interface SnapshotArchiveEntry {
  path: string;
  fileName: string;
  size: number;
  mtimeMs: number | null;
  /** 浅解析元数据（解析失败时 null，原因见 error） */
  meta: ArchiveMeta | null;
  /** 浅解析失败原因（显式呈现，不静默） */
  error?: string;
}

/** 扫描结果 */
export interface SnapshotScanResult {
  /** 已扫描目录（项目无存档目录时为空串） */
  dir: string;
  entries: readonly SnapshotArchiveEntry[];
  scannedAt: number;
  durationMs: number;
}

/** 深解析选项 */
export interface ArchiveParseOptions {
  /** 是否保留数组单元（默认 true）；false = 仅摘要（saveLen / nonEmpty / cursor） */
  keepArrayCells?: boolean;
  /** 单数组保留单元上限（默认不限；超出时截断并标记 cellsTruncated） */
  maxCellsPerArray?: number;
  /** 只解析顶层头即返回（扫描场景；角色区 / 变量区全部省略） */
  headerOnly?: boolean;
  /**
   * 是否记录每个变量的原始字节区间 `raw`（v0.2 第十三批方案 B；默认 false）。
   * 写侧 passthrough（未修改变量原样复制）与注入器前置——raw 是 subarray 视图
   * （共享正文缓冲，无逐变量拷贝开销）。
   */
  keepRaw?: boolean;
}

// ---------------------------------------------------------------------------
// 注入覆盖（v0.2 第十三批方案 B：改槽注入的契约层）
// ---------------------------------------------------------------------------

/** 数组单元补丁（index 全维度下标；value 必须在安全整数 / 字符串域内） */
export interface ArchiveCellPatch {
  index: readonly number[];
  value: number | string;
}

/**
 * 单变量覆盖值：
 * - `number | string`：标量变量整体替换（int 须为安全整数）；
 * - `ArchiveCellPatch[]`：数组变量**单元级补丁**（与既有 cells 按下标合并——
 *   同下标替换、新下标插入，其余单元原样保留）。
 */
export type ArchiveOverrideValue = number | string | readonly ArchiveCellPatch[];

/** 注入覆盖集（serializePayload 的改槽输入；未列出的变量一律原样 passthrough） */
export interface ArchiveOverrides {
  /** 顶层 / 主变量区 / 全局区 / EM 区变量（按 key；key 冲突时各区按流序首个命中） */
  vars?: ReadonlyMap<string, ArchiveOverrideValue>;
  /** 角色块覆盖：角色块 index（0 基，ArchiveCharacterBlock.index）→ (key → 覆盖值) */
  chars?: ReadonlyMap<number, ReadonlyMap<string, ArchiveOverrideValue>>;
}

/**
 * 快照来源服务（服务键 `snapshot.source`）。
 *
 * v1.0 的 state-replay 与归档浏览器消费本服务；写 / 注入（架构文档 §5.5）
 * 随 v1.1 扩展本服务的写侧能力。
 */
export interface SnapshotSourceService {
  /** 扫描当前项目的存档目录（浅解析列档；无项目 / 无目录时返回空结果） */
  scan(): Promise<SnapshotScanResult>;
  /** 最近一次扫描结果（未扫描时为 null） */
  current(): SnapshotScanResult | null;
  /** 深解析单个档案（完整变量视图；路径可来自扫描结果或用户直选） */
  parse(path: string, opts?: ArchiveParseOptions): Promise<SnapshotArchive>;
  /** 订阅扫描结果变化（项目打开自动扫描完成后触发） */
  subscribe(cb: (result: SnapshotScanResult | null) => void): () => void;
}
