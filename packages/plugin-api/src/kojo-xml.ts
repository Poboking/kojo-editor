/**
 * 口上 XML 契约（2026-10-24 eraFL 适配批）。
 *
 * 背景：eraTW 的口上是「ERB 函数 + 条件行」，而 eraFL 把口上搬进了 XML——
 * 一个角色一份 `<data><command ...><contents>台词</contents></command></data>`，
 * 由同目录的 `KOJO_DEFINE_K{n}.ERB` 用 `KOJO_XML_REGISTER(...)` 注册进引擎。
 * 于是「口上」在 eraFL 里是**声明式数据文件**，不是代码；编辑器要有导航、校验、
 * 预览，就必须先有一份**结构模型**。
 *
 * 归属：模型形状（本文件）是跨游戏共享术语（kojo / chara 一族），放契约层；
 * 具体属性名、`com` 编号、`kojoPlace` 取值域这些**游戏知识**只许住在 adapter。
 * 因此本契约**不列举任何属性枚举**——`attrs` 是原样字典，语义由 adapter 解释。
 *
 * 坐标口径：**1 基行、1 基 UTF-16 码元列**（与 Monaco / `ErbReference` /
 * `RevealSpan` 同一条，见 `plugin-api/erb.ts` 注）。`end` 不含端点。
 */

/** 1 基行列（UTF-16 码元列） */
export interface KojoXmlPosition {
  readonly line: number;
  readonly column: number;
}

/** 半开区间 `[start, end)` */
export interface KojoXmlSpan {
  readonly start: KojoXmlPosition;
  readonly end: KojoXmlPosition;
}

/**
 * 源文件编码形态。
 *
 * `utf-16le` / `utf-16be` 不是理论情形：eraFL 真实语料里就有 9 份口上 XML 是
 * **UTF-16LE + 声明 `encoding="utf-8"`**——按声明解会整份读不出来，只有 BOM
 * 优先才读得对（见 adapter 的 `kojo-xml` 模块头）。故编码是模型的一部分，
 * 不是"读文件时的私事"。
 */
export type KojoXmlEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be';

/** 文件顶层元素形态：`data` = 现行格式；`kojodef` = 旧版（`<kojo>` 直挂 command） */
export type KojoXmlFormat = 'data' | 'kojodef' | 'unknown';

/**
 * 一条口上条目 = 一个 `<command>` 元素。
 *
 * `text` 是**正文**（`<contents>` 或旧格式的 `<kojo>` 文本），保留原始换行；
 * 渲染时才做 `%…%` / `[$…]` 之类替换（那属于预览面，不属模型）。
 */
export interface KojoXmlCommand {
  /** 文件内序号（0 基，按文档顺序） */
  readonly index: number;
  /** 整个 `<command>` 元素区间（含首尾标签） */
  readonly span: KojoXmlSpan;
  /** 正文所在区间（`<contents>` 内容，不含标签）；无正文 = null */
  readonly contentSpan: KojoXmlSpan | null;
  /** 全部属性原样字典（键 = 属性名，值 = 已解实体的字符串） */
  readonly attrs: Readonly<Record<string, string>>;
  /** 正文文本（已解实体；换行保留原样） */
  readonly text: string;
}

/** 诊断严重级（与 `CONVENTION_SEVERITY_ORDER` 同序：error > warning > info） */
export type KojoXmlSeverity = 'error' | 'warning' | 'info';

/**
 * 一条诊断。
 *
 * `code` 用点分命名空间（`kojo-xml.<面>.<判据>`），跨文件可聚合、可被面板分组。
 * `data` 是给 UI 的附加事实（如"期望值/实际值"），不参与判据。
 */
export interface KojoXmlDiagnostic {
  readonly path: string;
  readonly severity: KojoXmlSeverity;
  readonly code: string;
  readonly message: string;
  readonly span: KojoXmlSpan;
  readonly data?: Readonly<Record<string, string>>;
}

/** 一份口上 XML 的解析结果 */
export interface KojoXmlFile {
  readonly path: string;
  readonly format: KojoXmlFormat;
  readonly encoding: KojoXmlEncoding;
  /** 换行风格（写回时按它还原；eraFL 全仓 CRLF） */
  readonly eol: 'crlf' | 'lf';
  /** 角色号（由 adapter 从目录名 / 文件名解析；解析不到 = null） */
  readonly charaNo: number | null;
  readonly commands: readonly KojoXmlCommand[];
  readonly diagnostics: readonly KojoXmlDiagnostic[];
}

/** 全项目索引 */
export interface KojoXmlIndex {
  readonly files: readonly KojoXmlFile[];
  /** 条目总数（= 各文件 commands 长度之和） */
  readonly commandCount: number;
  /** 角色号 → 该角色的口上文件（按角色号升序，文件按路径升序） */
  readonly byChara: ReadonlyMap<number, readonly KojoXmlFile[]>;
  /** `com` 值 → 条目数（`com` 缺席记在 `''` 键下） */
  readonly byCom: ReadonlyMap<string, number>;
  /** 全项目诊断（已按 path/行列排序） */
  readonly diagnostics: readonly KojoXmlDiagnostic[];
  /** 索引构建时刻（`Date.now()`；面板显示"何时扫的"用） */
  readonly scannedAt: number;
}

/**
 * 属性规格（**由 adapter 提供**，编辑器侧只消费、不内置）。
 *
 * 为什么枚举不写在契约里：`kojoPlace` 的取值域、`com` 的编号含义都是**游戏事实**，
 * 一旦写进 `plugin-api` 或宿主 Monaco 层，等于把游戏知识搬进内核（违反架构铁律 1）。
 * 宿主拿到的是这份规格，画补全 / 写悬停 / 判枚举时只查表。
 */
export interface KojoXmlAttributeSpec {
  /** 属性名（原样，大小写敏感——XML 属性就是大小写敏感的） */
  readonly name: string;
  /** 悬停文档（一段人话，说明这个属性管什么） */
  readonly doc: string;
  /** 允许取值（缺省 = 自由文本，不判枚举） */
  readonly values?: readonly string[];
  /**
   * 取值域是否**封闭**（`true` = 越界即报；缺省 = 开放）。
   *
   * 为什么不是"有 `values` 就封闭"：`values` 同时承担补全候选的作用，而像恋爱状态、
   * 情绪这类取值域会随游戏版本增长——把它当封闭集报错，等于替游戏宣布"这个值不存在"。
   * 只有布尔族、位置族这类真正封闭的才标 `true`。
   */
  readonly closed?: boolean;
  /** 是否必填（缺省 = 可选；缺必填项由 adapter 的诊断面报，不由宿主猜） */
  readonly required?: boolean;
  /** 挂在哪一层（缺省 = `command`） */
  readonly on?: 'command' | 'kojo';
}

/** `com` 编号 → 人读名（来自游戏 CSV，不在契约里硬编） */
export interface KojoXmlComSpec {
  readonly code: string;
  readonly label: string;
}

/** 口上 XML 的**游戏侧规格**：属性表 + `com` 表 + 位置取值域 */
export interface KojoXmlSchema {
  readonly attributes: readonly KojoXmlAttributeSpec[];
  readonly commands: readonly KojoXmlComSpec[];
  /** `kojoPlace` / `place` 的取值域（空 = 不判） */
  readonly places: readonly string[];
}

/**
 * 口上 XML 服务（`kojo.xml`）。
 *
 * 只读：本服务**不写盘**。写回走内核 `FileIO`（双闸 + 备份），由消费方负责。
 * 索引随项目生命周期：`project.closed` 后 `index()` 返回 null（不返回旧项目的残留）。
 */
export interface KojoXmlService {
  /** 当前索引；未加载 / 项目已关 = null（**不静默给空索引**） */
  index(): KojoXmlIndex | null;
  /** 单文件查（未索引 = null） */
  file(path: string): KojoXmlFile | null;
  /** 游戏侧规格（属性 / com / place）；未加载 = null */
  schema(): KojoXmlSchema | null;
  /** 重扫（项目加载后由 adapter 触发；也供面板"刷新"按钮） */
  refresh(): Promise<KojoXmlIndex | null>;
  /** 订阅索引变化（返回取消函数） */
  subscribe(listener: () => void): () => void;
}
