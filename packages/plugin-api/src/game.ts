/**
 * 游戏适配器契约。
 *
 * 铁律：内核源码中不允许出现任何具体游戏名——`GameAdapter` 的**形状**在这里（通用契约），
 * 内容（eraTW / eraK / … 的全部领域知识）只在各 game.adapter 插件中。
 */

import type { ConventionRule } from './conventions';
import type { ReplayCallContext } from './replay';

/** 角色条目（由适配器从游戏数据填充；内核只透传） */
export interface CharaInfo {
  /** CHARA NO —— 与口上函数命名 `M_KOJO_K{no}` 的编号对应 */
  no: number;
  /** 显示名 */
  name: string;
  /** 呼び名（可选） */
  callName?: string;
  /** 该角色在口上域下的目录（绝对路径；无口上目录时缺省） */
  kojoDir?: string;
}

/**
 * 项目载荷：内核视为不透明对象，仅提供最小通用形状。
 * 字段内容全部由适配器填充。
 */
export interface GameProject {
  rootDir: string;
  adapterId: string;
  /** 口上 ERB 目录（绝对路径） */
  kojoPaths: string[];
  /** 存档目录（无此概念的游戏可缺省） */
  savDir?: string;
  /** 适配器提议、用户批准后的可写路径（绝对路径） */
  writablePaths: string[];
  /** 角色号 → 角色信息 */
  charaIndex: Map<number, CharaInfo>;
  gameVersion?: string;
  /**
   * 适配器在 `loadProject` 里**实际读过的非 ERB 输入**的内容摘要
   * （CHARA 表、变量名称表……即 `charaIndex` / `variableSchema` 的来源数据）。
   *
   * 用途：ERB 正文的体量指纹覆盖不到这些文件，而派生缓存（条件抽取 / 约定校验）
   * 的产出依赖它们。内核不解释内容，只把它当作"判据的一部分"透传。
   * 缺省 ⇒ 下游派生缓存一律不命中（判据不全就不缓存）。
   */
  readonly inputDigest?: string;
}

/** 家族解析的形态类别 */
export type FamilyParseKind =
  | 'declare' // 家族声明（前缀_K{编号}[_{selector}]）
  | 'ok' // 常规口上函数
  | 'placeholder' // KX 占位符残留（模板置换事故）
  | 'kn' // K{n}_ 前缀私货形态
  | 'beforetrain'; // K{n}_BEFORETRAIN{family}（家族名后置）

/** 函数家族匹配结果（口上域命名解法产物） */
export interface FamilyMatch {
  /** 形态类别 */
  kind: FamilyParseKind;
  /** 前缀域：'M_KOJO' | 'KOJO' | 'DIARY' | 'RUN_INTO' | ''（裸家族/无前缀） */
  prefix: string;
  /** 家族名（'' = 初始家族/无家族） */
  family: string;
  /** 角色编号（无法归属时为 null） */
  characterNo: number | null;
  /** 剧本セレクタ编号（仅 declare 形态有意义；0 = 初始） */
  selector: number;
  /** 所属面（MESSAGE_COM / COUNTER / EVENT / FLAGSETTING…；无法识别为 ''） */
  face: string;
  /** 子号（PALAMCNG 变体 A/B…/IRAI 依頼名/MESSAGECHECK 子段） */
  sub: string;
  /** 是否为 MESSAGECHECK 否决钩子（位协议） */
  isMessageCheck: boolean;
  /** K{no} 之后的时机号/子号（已去前导下划线） */
  slot: string;
  /** KX 占位符残留标记 */
  isPlaceholder: boolean;
}

/** 家族识别规则：把函数名解析为结构（纯函数，规则由适配器提供） */
export interface FamilyIndexRule {
  readonly name: string;
  /**
   * 解析函数名 → 家族结构。
   *
   * `filePath` 为 **additive 可选**第二参：**不传 ⇒ 判定与旧版逐字一致**（占位符形态仍
   * `characterNo = null`）。传了路径的实现可据文件来源补全占位符归属（例如按文件名编号
   * 还原角色号），是否消费由规则实现自定；旧调用方零改动。
   */
  match(fnName: string, filePath?: string): FamilyMatch | null;
  /**
   * 面（`FamilyMatch.face`）→ 人类可读标签（可选；**游戏知识，只住 adapter**）。
   * 消费方（函数树导航 / 条件矩阵列头）据此本地化展示；未收录的面原样显示 token
   * （fail-visible，不猜）。`''`（其它）与 `'declare'`（家族声明）由消费方通用兜底。
   * 缺省 = 适配器未提供面标签，消费方全部原样显示。
   */
  readonly faceLabels?: Readonly<Record<string, string>>;
  /**
   * 「指令承载面」清单（游戏知识；只住 adapter）。
   * 列出的 face，其 `FamilyMatch.slot` 首位数字 = 指令编号；消费方（条件矩阵）
   * 据此把该面细分为「每指令一列」并经指令表取名。缺省 = 不细分（整面成列）。
   */
  readonly instructionFaces?: readonly string[];
}

/**
 * 变量字典条目的**来源层**（ ALS 批 / FT-1 三层数据源的显式化，可选字段）。
 *
 * - `'primary'`：主名表（游戏数据的第一层名字表）；
 * - `'append'`：追加名表（汉化 / 魔改给同一编号补的别名）；
 * - `'const'`：作者自定具名常量（剧本声明里的名字 = 整数）——**只做名字→编号换算，
 *   不宣称族归属**（同一个名字可以写在任意族后面）。
 *
 * 消费方口径：`lookup` 的"收录"判定三层都算（拼错名检测受益）；**族归属只认前两层，
 * 且主表优先**——否则追加表 / 常量表会把本来属于更早主表的归属抢走。
 * 缺省 = 未知来源 ⇒ 消费方按 `'primary'` 处理（旧字典形态零改动）。
 */
export type VariableSource = 'primary' | 'append' | 'const';

/** 变量字典条目（v0.2 起消费） */
export interface VariableInfo {
  /** 变量名（如 'CFLAG'、'TCVAR'） */
  name: string;
  /** 编号或具名索引（原样透传） */
  index?: number | string;
  /** 人类可读说明 */
  description?: string;
  /**
   * 具名索引解析出的数字编号（引擎关键字字典语义：`TALENT:恋慕` → 3）。
   * 数字索引时 = 自身；名称无法解析为编号时缺省。
   * 消费方（快照回放）用它把具名引用转入存档数据寻址。
   */
  resolvedIndex?: number;
  /** 位标志表（CFLAG 位图 / TCVAR:50 位表等） */
  bits?: ReadonlyArray<{ bit: number; label: string }>;
  /**
   * 本条目的来源层（见 `VariableSource`）。**可选、additive**：不提供的实现（旧字典）
   * 一律按主表处理 ⇒ 族归属行为与今天逐字相同。
   */
  source?: VariableSource;
}

/** 变量字典（口上相关变量、CFLAG 位图、好感变量等；版本化） */
export interface VariableSchema {
  readonly version: string;
  /** 游戏中该 schema 对应的版本标记（如 '4.980'） */
  readonly gameVersion?: string;
  /**
   * 字典**实际读过的输入**（如游戏 CSV 名称表）的内容摘要。
   *
   * 变量字典可以由游戏数据驱动（eraTW 读 `CSV/*.csv`），此时 `version` 是静态的、
   * 检不出"玩家改了 CSV 描述"。派生缓存（条件抽取的结果里带 schema 语义标签）
   * 必须把它折进失效判据，否则改了 CSV 还会复用旧标签。缺省 ⇒ 下游一律不缓存。
   */
  readonly inputDigest?: string;
  lookup(variableName: string, index?: number | string): VariableInfo | undefined;
  /**
   * 枚举某族**可写的索引名**（**可选能力**，additive）。
   *
   * 为什么需要：`lookup` 只能**按名查**，无法枚举；而编辑器补全（`.kojo` 插值里
   * `{她的<前缀>}` / `{角色N的<前缀>}`，规范 §3.8）要先知道"这族有哪些名字可写"
   * 才能弹出候选 —— 没有枚举就没法补全。
   *
   * 形状（**与 `lookup` 的语义分工**）：每个条目的 `name` = **该族的索引名**
   * （作者可写的名字，如 `好感度`），`index` / `resolvedIndex` = 其编号，
   * `source` = 来源层；`description` 若实现提供则作可读说明。条目的 `name` 因此
   * 与 `lookup(族, 编号)` 的 `name`（= 族名）**语义不同**——枚举法只服务"列出名字"。
   * 未收录 / 无该族 → 返回空数组（不猜，不抛）。
   *
   * 缺省（实现未提供本方法）= **不枚举**：消费方须据此返回空候选（不猜）。
   * 旧实现零改动仍通过编译。
   */
  names?(family: string): readonly VariableInfo[];
  /**
   * 家族头**中文别名**：表层可写的别名 → 引擎变量族头（**可选能力**，additive）。
   *
   * 用途：口上作者在表达式 / 段条件里写**中文族头**（`现在:噴乳` / `时标:192`）时，
   * 转译器据此把别名替换成引擎族头（`NOWEX:噴乳` / `TFLAG:192`）。**别名表是游戏知识
   * （同一套中文表层在不同 era 系游戏里对应的族头不同），故只住 adapter**；转译器只查
   * 表不解释（零硬编码）。
   *
   * 缺省（实现未提供本方法）= **不猜**：未登记的名字一律原样保留（消费方不做替换）。
   * 旧实现零改动仍通过编译、行为与今天逐字相同。
   */
  familyAlias?(name: string): string | undefined;
  /**
   * 家族头中文别名的**反向**：引擎变量族头 → 表层中文别名（**可选能力**，additive）。
   *
   * 用途：升糖**投影**的族头中文化——把 `NOWEX:噴乳` 这样的原生族头渲染成作者可写的
   * `现在：噴乳`，让不熟悉 EraBasic 的读者读懂。与 `familyAlias` 同一张表的反向查询。
   *
   * 缺省（实现未提供本方法）= **不做**：未登记 / 查不到的族头一律原样保留（不猜）。
   * 旧实现零改动仍通过编译。
   */
  familyAliasReverse?(family: string): string | undefined;
  /**
   * 槽位名的**原文 → 中文名**查询（**可选能力**，additive；契约字段名中性，语义由各
   * adapter 自行解释）。
   *
   * 用途：全中文阅读面上，族头有中文别名（`familyAlias`）只解决了"这一行开头"，
   * **槽位名本身**（如 `现在:噴乳` 里的 `噴乳`）仍是引擎原文逐字直通 ⇒ 读者看到的还是
   * 日文。本方法把游戏自带的汉化名词典做成一个**可查通道**，供预览 / 升糖侧问
   * "这个槽名有没有中文写法"。与 `lookup()` 的 `description` 用**同一份词典**，
   * 但那条只进悬停、进不了渲染。
   *
   * 形状：`engineFamilyUpper` = 引擎族头（大写；供实现按族取词，实现**可以忽略**该参数
   * ——例如词典本身就是扁平的"显示词 → 显示词"表）；`jpName` = 槽位**原文**。
   *
   * 缺省（实现未提供本方法）= **没有中文可写**。查询结果三态必须分清：
   * - 有登记 → 中文名；
   * - 查不到 → `undefined`（**绝不返回原文冒充命中**：那会把"词典缺这一条"伪装成
   *   "这行已经是中文"，正是要根除的 fail-open）；
   * - 消费方拿到 `undefined` 时原样保留，不做任何猜测（与 `familyAlias` 同一条红线）。
   * 旧实现零改动仍通过编译、行为与今天逐字相同。
   */
  slotCn?(engineFamilyUpper: string, jpName: string): string | undefined;
}

/**
 * 可校验的剧本约定（门禁矩阵、KOJO_VERSION 热更新等；v0.2 起消费）。
 * 形状与运行契约见 `./conventions`（校验器契约独立成篇，避免 game.ts 膨胀）。
 */
export type { ConventionRule } from './conventions';

/** 状态模型（哪些变量影响口上分支；v1.0 快照回放消费） */
export interface StateModel {
  readonly dimensions: ReadonlyArray<{
    key: string;
    label: string;
    /** 取值域描述（连续区间 / 枚举） */
    domain: string;
  }>;
}

/** 脚手架选项（v0.3） */
export interface ScaffoldOptions {
  familyName?: string;
  displayName?: string;
  intro?: string;
  /** 要接入的时机（缺省 = 起步四件套） */
  faces?: string[];
  targetDir?: string;
}

export interface ScaffoldResult {
  createdFiles: string[];
  /** 生成后完整性报告（人类可读行） */
  report: string[];
}

/**
 * 口上调用协议（v0.2 第十批）——路由层转发实参的槽位语义表。
 *
 * 口上函数的参数槽 = 路由层透传缓冲（如 eraTW 的 KOJO_MESSAGE_SEND 家族
 * 模板把 ARG:3/ARG:4 转发给口上函数的 ARG:0/ARG:1），**值是场景输入**
 * （不可推导）；但**槽位个数与含义**可由路由表静态声明。消费者（回放
 * 面板）据此生成场景参数输入与"默认场景"回放——全 0/'' 是引擎转发链
 * 未设置槽的确定事实（fresh 局部量语义），非猜测。
 */
export interface KojoCallSlot {
  /** 槽位号（ARG:n 的 n；字符串槽为 ARGS:n 的 n） */
  readonly index: number;
  /** 槽位类型（数值 ARG / 字符串 ARGS） */
  readonly kind: 'int' | 'str';
  /** 人类可读含义（如「事件子参数」「日期偏移」；展示用） */
  readonly label: string;
}

export interface KojoCallProtocol {
  /**
   * 声明一个口上函数的调用槽位（按签名顺序；null = 协议不认识该函数）。
   * 实现按函数名匹配路由模板（游戏知识），与本工程索引的函数名口径一致。
   */
  slotsFor(functionName: string): readonly KojoCallSlot[] | null;
  /**
   * 推导「确定槽值」调用上下文（v1.0 HK-20；可选——入口回放自动补确定事实用）。
   * 只含**引擎转发链未设置槽（0/''）**与**路由转发『发言者』槽（= 回放角色号）**
   * 等确定事实；场景输入一律不填（`undefined`）。无路由匹配 → `undefined`。
   * **绝不猜测场景输入**（引擎语义：fresh 局部量默认 0/''，见本接口头注释）。
   */
  deriveCallContext?(functionName: string, characterNo: number): ReplayCallContext | undefined;
}

/**
 * 时机分野模板表（v0.3 批 S2 补齐；游戏知识，只住 adapter）。
 *
 * 表层 DSL 的 `时机 <分野> [<编号>]：` 声明里，作者**只写分野关键字**（如
 * `初见` / `指令 310`），**不写函数名**。分野关键字 → 目标语言函数名的映射
 * 是**游戏知识**（同一套中文表层语法在不同 era 系游戏里目标函数名不同），
 * 故本表由 adapter 提供、由转译器**只消费不解释**——这正是"游戏知识只进
 * adapter"在糖链路里的落位（审阅 §8.1-3 对表结论：37 调用面模板表为 adapter
 * 新增）。
 *
 * 设计取舍（对称性）：与 `KojoCallProtocol` 同形——都是"游戏知识经槽位查询
 * 注入转译/校验层"的可替换 seam，而不把游戏常量塞进契约或通用插件。
 */
/**
 * `{i}` 槽的取值口径（IX-1 批具名；与 `KojoFaceTemplate.indexKind` 同域）。
 *
 * 具名的理由：分流判据有三个消费者（转译器 `resolveTimingIndex` / 悬停拼名 / 编号槽补全），
 * 三处各自 `indexKind` 判一遍就会出现"同槽异口径" ⇒ 具名后统一交给
 * `@kojo/plugin-api` 的 `index-slot.ts` 三枚纯函数（见该模块头注）。
 */
export type KojoIndexKind = 'command' | 'literal' | 'counter';

export interface KojoFaceTemplate {
  /**
   * 函数名模板。占位符（与 `docs/SYNTAX-SUGAR-SURFACE-SPEC.md` §5.5 同口径）：
   * - `{t}` = **家族段**（标准版空串、别人版 `_口上名`）；
   * - `{n}` = 角色号；
   * - `{i}` = 时机编号（**仅当本模板含 `{i}` 时**才消费 `时机` 声明的令牌；取值口径见 `indexKind`）；
   * - `${…}` 形态的**非占位**片段（如按 `类型:` 分派的段）由转译器在求值时
   *   提供上下文值，adapter 只声明模板文本。
   */
  readonly template: string;
  /**
   * `{i}` 槽的**取值口径**（additive；缺省 = `'command'`，旧适配器零改动）。
   *
   * - `'command'`（缺省）：时机头里那枚中文令牌按**指令名表**换算成编号
   *   （`时机 指令 摸屁股：` → `…_K{n}_310`）；查不到 **fail-closed**。纯数字令牌不查表。
   * - `'literal'`：令牌**原样透传**进函数名尾段、**不查任何表**。适用于尾部是
   *   **运行期字符串**（形态名）而非编号的调用面——引擎以
   *   `TRYCALLFORM …_K{n}_%ARGS:1%` 拼名（如 `时机 图像 特殊服装：` →
   *   `M_KOJO{t}_IMAGE_K{n}_特殊服装`）。
   * - `'counter'`（additive）：令牌按**计数器值域表**（`KojoCounterTable`）换算成编号
   *   （如 `时机 计数器 偷看：` → `…_K{n}_2`）。**纯数字令牌不查表、逐字节直通**（旧写法
   *   `时机 计数器 20：` 零改动）；**名查不到 fail-closed**（绝不猜编号）；**`hasTable=false`
   *   时名路径一律 fail-closed**。适用于 `{i}` 取值域是"引擎登记过的计数器集合"的调用面。
   *
   * **为什么必须由 adapter 声明**：同一个中文令牌在 `指令` 面是编号查表、在 `图像` 面
   * 是字面名、在 `计数器` 面是另一张**值域名表**；语法层据形态判不出来，只有游戏知识
   * 知道引擎怎么拼这个名。语义中立、零游戏名词——转译器只按本字段决定"查不查表、查哪张表"。
   * 取值判别一律走 `resolveKojoIndexName` / `kojoIndexCandidates`（IX-1：三消费者单一真源）。
   */
  readonly indexKind?: KojoIndexKind;
  /**
   * `{i}` 编号是否允许**省略自动分配**（additive；缺省 = `false`，旧适配器零改动）。
   *
   * 写了 `时机 <分野>：` 且**省略编号**时，转译器从 1 起取**最小未用**编号写进 `{i}`。
   * 「已占用」只看本文件——原生直通块里本族函数头的数字尾（按本模板拼出的名字形态）
   * 与本文件里显式写了数字编号的同族时机。显式编号路径逐字节不变；自动分配的编号
   * 走与手写编号**同一条**函数名拼接链（不存在第二套命名）。
   *
   * **为什么必须由 adapter 逐面声明**：能否自动分配是**游戏知识**——只有"编号在
   * 文件内是作者自管序号、缺号只是空位"的族才可分配；编号本身是**引擎键值语义**
   * （每个编号对应固定事件）的族必须**不声明**，否则自动号会拼出指向错误事件的
   * 函数名。语义中立、零游戏名词——转译器只按本字段决定"省略编号时分不分配"。
   */
  readonly autoIndex?: boolean;
  /**
   * 成否判定函数模板（`成否:` 非默认值时才生成；缺省 = 该分野无成否函数）。
   * 与主模板同一套占位符；`{i}` 消费编号。
   */
  readonly success?: { readonly template: string };
  /**
   * 模板求值所需的**上下文段**表（可选）。键 = 模板里 `${段名}` 的名字，
   * 值 = 该段的候选取值 → 段文本。缺省 = 模板不含上下文段。
   *
   * 例：`指令` 分野按 `类型:`（`COM` / `SCOM` / 自定指令…）在函数名中插入
   * 不同段——adapter 声明"段名 → 取值映射"，转译器按语法层语义选择取值。
   */
  readonly segments?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * MESSAGECHECK 钩子函数名模板（**additive**；规范 §3.2 `隐藏情景/隐藏口上`）。
   *
   * 写了 `隐藏情景:` / `隐藏口上:` 的分野**必须**声明本字段；缺省 = 该面**无**
   * MESSAGECHECK 钩子（转译器报 `face-table-missing` 并忽略该子句，**不静默**）。
   * 占位符同主模板（`{t}{n}{i}` + 本条的 `${段}`，复用本条 `segments`）。
   *
   * **为什么逐面**：`_MESSAGECHECK` 的**插入点处处不同**（实测引擎 `KOJO_MESSAGE.ERB`），
   * 统一成单条 `M_KOJO{t}_MESSAGECHECK_{scope}_K{n}_{i}` 会产出引擎**从不调用**的死函数名：
   * - `MESSAGE`（指令）：插在 `_MESSAGE_` 之后、`${com}` 段之前
   *   → `M_KOJO{t}_MESSAGE_MESSAGECHECK_${com}_K{n}_{i}`；
   * - `PALAMCNG`（绝顶 B / 射精 A2…）：插在子类型 `_{B|B2|C|A2}` 之前
   *   → `M_KOJO{t}_MESSAGE_PALAMCNG_MESSAGECHECK_{B|A2}_K{n}[_{i}]`；
   * - 其余（SPEVENT / CUSTOM_EVENT / DAILY_EVENT / MARKCNG / COUNTER）：插在 `_K{n}` 之前
   *   → `M_KOJO{t}_…_MESSAGECHECK_K{n}[_{i}]`。
   */
  readonly messageCheck?: { readonly template: string };
}

/**
 * 分野模板表（游戏知识；只住 adapter）。
 *
 * `faces` 的键 = 表层 DSL 的分野关键字**原文**（`初见` / `事件` / `指令`…），
 * 值 = 该分野的模板。转译器遇到关键字不在表内 → 报 `timing-face-unknown`，
 * **不产半成品**（规范 §5.3 精神）。
 */
export interface KojoFaceTable {
  /** 分野关键字 → 模板（键为表层关键字原文，转译器不解释其含义） */
  readonly faces: Readonly<Record<string, KojoFaceTemplate>>;
  /**
   * 登记 / 配色 / 开关**三件套**函数名模板（规范 §5.5：**不带家族段**，
   * 只有角色号）。缺省 = 该游戏无此三件套概念（转译器跳过对应产物）。
   */
  readonly registration?: {
    /** 登记函数（家族声明；`{n}` = 角色号） */
    readonly declare?: string;
    /** 配色函数 */
    readonly color?: string;
    /** 开关函数 */
    readonly flagSetting?: string;
    /**
     * 「选择器」登记函数（additive；规范 §5.5 的别人版变体）。
     * 占位符：`{n}` = 角色号、`{s}` = 选择器编号（写作 `口上: <家族名> 选择器: <n>`）。
     * `pragmas` = 紧随函数头的预处理行（原样输出，如 `#LOCALSIZE 1`）。
     * 缺省 = 该游戏无选择器登记形态 ⇒ 写了 `选择器:` 时报错（fail-closed，不产半成品）。
     */
    readonly declareSelector?: {
      readonly template: string;
      readonly pragmas?: readonly string[];
    };
  };
  /**
   * 成否判定位协议的**目标变量与原语**（规范 §5.5；游戏侧约定）。
   * 缺省 = 该游戏无成否位协议（转译器跳过 `成否:` 产物并记 INFO）。
   *
   * 例（eraTW）：`target: 'TFLAG:192'`，取值为 `成否:` 声明映射后的整数。
   */
  readonly successFlag?: {
    /** 目标变量原文（如 `TFLAG:192`） */
    readonly target: string;
    /** 取值映射：`成否:` 子句值 → 目标变量取值（缺省值由转译器兜底） */
    readonly values?: Readonly<Record<string, number>>;
  };
  /**
   * MESSAGECHECK 位协议的**目标段与原语**（规范 §3.2；游戏侧约定）。
   * 缺省 = 该游戏无 MESSAGECHECK 概念（转译器跳过 `隐藏情景/隐藏口上` 产物）。
   *
   * 函数名模板**不在这里**——`_MESSAGECHECK` 的插入点逐面不同，故由各分野的
   * `KojoFaceTemplate.messageCheck` 声明；本字段只管**位协议**（置位原语 + 位号）。
   */
  readonly messageCheck?: {
    /**
     * @deprecated 函数名已改为**逐面**声明（`KojoFaceTemplate.messageCheck.template`）：
     * 单一全局模板表达不了"插入点逐面不同"，会产出引擎从不调用的死函数名。
     * 保留本字段仅为旧适配器零改动，转译器已不再读取。
     */
    readonly template?: string;
    /**
     * @deprecated 作用域段文本（新形态的函数名里**没有** scope 段——只有位号随作用域变）。
     * 保留仅为旧适配器零改动，转译器已不再读取。
     */
    readonly scopes?: Readonly<Record<string, string>>;
    /** 置位原语模板（`{bit}` = 位号）。缺省 = `SETBIT RESULT, {bit}` */
    readonly setBit?: string;
    /** 作用域语义名 → 位号 */
    readonly bits: Readonly<Record<string, number>>;
  };
  /**
   * 自定指令编号可用段（HK-12；eraTW：270–299）。
   * 缺省 = 该游戏无「作者自定指令」概念（codegen 不做自动编号分配）。
   */
  readonly customComRange?: { readonly min: number; readonly max: number };
  /**
   * 缺省**自机色**（`你：` 自机/玩家台词未声明 `自机色:` 时的兜底 `SETCOLOR` 原文，
   * 如 `0x4682B4`）。**颜色字面量是游戏知识，只住 adapter**（kojo-sugar 无任何 `0x…`）。
   * 缺省 = 该游戏无缺省自机色（作者未声明时转译器报 `face-table-missing` 并按普通旁白输出）。
   */
  readonly playerColor?: string;
  /**
   * 自定函数钩子的函数名模板（附录 C 原文；{t}{n}{i} 占位符同主模板口径）。
   * 缺省 = 该游戏无对应钩子。eraTW 的九条见附录 C #34（自定指令五钩子）
   * 与 #3 自定事件 / #30 `CUSTOM_TALENT` / #31 `SHOP_BUTTON_CONDITION` / #32 `SHOP_BUTTON`。
   */
  readonly customHooks?: {
    readonly comName?: string;
    readonly comAble?: string;
    readonly com?: string;
    readonly canCom?: string;
    readonly comCounter?: string;
    readonly customEvent?: string;
    readonly customTalent?: string;
    readonly shopButtonCondition?: string;
    readonly shopButton?: string;
  };
  /**
   * 用户自定义函数的**产物命名模板**（B4 批；游戏知识，只住 adapter）。
   *
   * 占位符：`{n}` = 角色号、`{name}` = 作者写的函数名原文（表层 `函数 <名>：` 的 `<名>`）。
   * 转译器只做占位符求值，**不含任何游戏字面量**（与三件套 `registration.*` 同一条纪律）。
   * 缺省 = 该游戏无此命名惯例 ⇒ 写了 `函数` 块时 `face-table-missing`（fail-closed，
   * 不产半成品：无法确定函数名时宁可拒绝）。
   */
  readonly userFunction?: { readonly template: string };
  /**
   * 引擎封装的**问答函数**调用面模板（游戏知识，只住 adapter）。
   *
   * 表层 DSL 的 `询问` / `确认` 块产**引擎函数调用** + 读回返回值的 `SELECTCASE`——
   * 函数名（eraTW：`ASK_M` / `ASK_YN`）、参数拼装与读回变量（`RESULT`）都是游戏知识，
   * 故由 adapter 声明模板、转译器只替换占位符（糖里零硬编码）。
   * 缺省 = 该游戏无此问答函数 ⇒ 写了 `询问`/`确认` 块时 `face-table-missing`（fail-closed）。
   */
  readonly ask?: KojoAskTable;
}

/** 单个问答糖位的产物模板（`KojoFaceTable.ask` 的键值） */
export interface KojoAskForm {
  /**
   * 调用行模板。占位符 `{options}` = 逐项参数串（按书写顺序、以 `,` 连接、无空格）。
   * 例（eraTW 多选）：`CALL ASK_M({options})` → `CALL ASK_M("甲",1,"乙",1)`。
   */
  readonly call: string;
  /**
   * 单项参数模板。占位符：`{label}` = 已加引号的标签字面量、`{value}` = 逐项条件的
   * **降糖后**表达式（仅当本模板含 `{value}` 时才消费）。
   * 例（eraTW 多选）：`{label},{value}` → `"甲",1`；（eraTW 二择）：`{label}` → `"是"`。
   */
  readonly option: string;
  /** 读回变量名（`SELECTCASE <result>` 的主语；两类问句共用同一个返回值变量）。eraTW：`RESULT`。 */
  readonly result: string;
  /**
   * 逐项显示条件**缺省值**（仅当 `option` 含 `{value}`）。作者未写 `「标签」 逐项显示条件：` 时，
   * 用本值填充。缺省 = **必须写逐项显示条件**（缺则报错，不静默）。eraTW：`1`（= 选项有效）。
   */
  readonly defaultValue?: string;
  /** 项数下限（不足 → 报错，不产半成品）。 */
  readonly minOptions: number;
  /** 项数上限（超出 → 报错；缺省 = 不限）。 */
  readonly maxOptions?: number;
}

/**
 * 问答糖位表：多选 `询问`（eraTW `ASK_M`，逐项 `标签,条件`）与二择 `确认`
 * （eraTW `ASK_YN`，恰两项纯标签）。
 *
 * 两者是**不同族**（参数签名 / 返回语义不同），故各占一个糖位、各一条模板，
 * 由转译器按糖关键字分派（不合并成一条，避免参数形态被猜）。
 */
export interface KojoAskTable {
  /** `询问` 糖位（eraTW：`CALL ASK_M`） */
  readonly askM: KojoAskForm;
  /** `确认` 糖位（eraTW：`CALL ASK_YN`） */
  readonly askYN: KojoAskForm;
}

/**
 * 指令表（游戏知识，只住 adapter；糖层只查表不解释）。
 *
 * 数据源 = 当前打开工程的 `CSV/Train.csv`（引擎读取惯例 `TRAINNAME:编号`；
 * 270–299 = kojo_com 段）。各版本 / 汉化 / 魔改随文件自动跟随、**不内置打包**，
 * 故本表按 `loadProject` 生命周期持有。查不到的名字 / 编号一律 `undefined`，
 * **绝不猜**（规范 §5.3 精神：不产半成品）。
 *
 * 消费点：`时机 指令 <中文名>：` 的编号解析（HK-11②）与 `当 …： 是 <中文名>：`
 * 的 `CASE` 值解析（P-5）——同一张表、同一 fail-closed 口径。
 */
export interface KojoInstructionTable {
  /** 无表 / 空表 = false */
  readonly hasTable: boolean;
  /** 中文名 → 编号（无则 `undefined`） */
  lookupByName(name: string): number | undefined;
  /** 编号 → 中文名（无则 `undefined`） */
  lookupByNo(no: number): string | undefined;
  /**
   * 中文名的**枚举**（正向补全用；**可选能力**——未提供 = 宿主不产正向候选，**不猜**）。
   * 返回序即表层候选展示序（实现按数据源原序返回；同名多编号已去重）；无表 / 空表 = `[]`。
   * 与 `lookupByNo` 同一"反向查询"位置（本表原只有反查，正向补全缺枚举面）。
   */
  names?(): readonly string[];
}

/**
 * 基础库 / 常用函数名表（游戏知识，只住 adapter；ZH-F1）。
 *
 * 与 `KojoInstructionTable` 同形（同一 seam：adapter 建一张**纯数据表**、糖层只查
 * 不解释）：面向作者可写的**中文函数名** ↔ 游戏基础库里的**原生函数名**。数据源 =
 * 该游戏的基础库助手与宏（eraTW：`HPH_PRINT` / `TEXTR` / `ASK_YN` …），**静态、手工
 * 维护、可扩展**，故不随项目文件变化（不依赖 `loadProject`）。
 *
 * 消费点：`.kojo` 表达式里的**中文函数名调用形态**（`名字(` → 原生函数名）；未收录的
 * 中文调用形态**原样保留**并报诊断（fail-visible，绝不猜）。系统函数名（跨游戏语言层，
 * 见 kojo-sugar 的 `SYSTEM_FUNCTION_ALIASES`）优先于本表。查不到一律 `undefined`，
 * **绝不猜**（规范 §5.3 精神）。
 */
export interface KojoLibraryTable {
  /** 无表 / 空表 = false */
  readonly hasTable: boolean;
  /** 中文名 → 原生 ERB 函数名（无则 `undefined`） */
  lookupByName(name: string): string | undefined;
  /**
   * 原生函数名 → 中文名（反查；**可选能力**——宿主显示层据此本地化，未提供 = 不做）。
   * 无则 `undefined`。与 `KojoInstructionTable.lookupByNo` 同一"反向查询"位置。
   */
  lookupByFunction?(functionName: string): string | undefined;
  /**
   * 中文名的**枚举**（正向补全用；**可选能力**——未提供 = 宿主不产正向候选，**不猜**）。
   * 返回序即表层候选展示序（实现按数据源原序返回）；无表 / 空表 = `[]`。
   * 与 `lookupByFunction` 同一"反向查询"位置（本表原只有反查，正向补全缺枚举面）。
   */
  names?(): readonly string[];
}

/**
 * 「数值增减」族表规格（游戏知识，只住 adapter）。
 *
 * 与 `KojoLibraryTable` 同形（同一 seam：adapter 建一张**纯数据表**、糖层只查不解释）：
 * 把「变量族头」（作者写的 `族:对象:槽` 里的族头）映射到"改该族某个槽"的**产物形态**。
 * 数值增减糖（动词 + `族:对象:槽` ± 增量）据此降糖；未登记族 / 变量槽形态不符
 * **一律 fail-closed**（查不到即不降糖、报诊断，绝不猜）。
 *
 * **两种产物形态**（`form` 判别，二选一）：
 * - `'call'`：游戏提供了「增减封装函数」⇒ 产物 `CALL <engine>(…)`，实参序由 `argOrder` 声明；
 * - `'assign'`：游戏把增减**直写在变量上**（如 `CFLAG:对象:槽 += n`），没有任何封装函数
 *   可调 ⇒ 产物 `<template> <运算符> <增量>`。这不是"该族没登记"，而是该游戏的增减语义
 *   本来就不经过函数——硬造一条 `CALL` 只会调到一个不存在的函数。
 */
export type KojoMutatorSpec = KojoMutatorCallSpec | KojoMutatorAssignSpec;

/**
 * 变量槽（`族:对象:槽` 的第三段）的取值形态：
 * - `'number'`：只接受数字下标（写了名 ⇒ 不降糖、报诊断，fail-closed）；
 * - `'name-or-number'`：名或数字都**原样**透传（该族接受名，由语料实证）。
 */
export type MutatorSlotMode = 'number' | 'name-or-number';

/** `form: 'call'`：降成一条 `CALL <engine>(…)`。 */
export interface KojoMutatorCallSpec {
  readonly form: 'call';
  /** 目标原生 ERB 函数名。 */
  readonly engine: string;
  /** 三个实参各取哪一段（顺序 = 调用实参顺序）：表层 `族:对象:槽` 三段的角色 + 增量。 */
  readonly argOrder: readonly [MutatorArgRole, MutatorArgRole, MutatorArgRole];
  readonly slotMode: MutatorSlotMode;
}

/** `form: 'assign'`：降成一条直写赋值（该游戏没有增减封装函数）。 */
export interface KojoMutatorAssignSpec {
  readonly form: 'assign';
  /**
   * 产物左值模板：`{family}` / `{object}` / `{slot}` 三个占位按表层三段替换，其余字符原样。
   * 例：`'CFLAG:{object}:{slot}'`。族头别名也靠它（`'ABL:{object}:{slot}'` 可把作者写的
   * 中文族头映射到原生族，此时 `{family}` 不出现）。
   */
  readonly template: string;
  readonly slotMode: MutatorSlotMode;
}

/** 增减实参角色：`对象` / `变量槽` / `增量`（与表层 `族:对象:槽` + 右值一一对应）。 */
export type MutatorArgRole = 'object' | 'slot' | 'delta';

/**
 * 数值增减族表的**查询面**（糖层只查不解释；`hasTable=false` = 空表，查啥都 `undefined`）。
 */
export interface KojoMutatorTable {
  readonly hasTable: boolean;
  lookupByFamily(family: string): KojoMutatorSpec | undefined;
}

/**
 * 计数器值域名表（游戏知识，只住 adapter；1016 批）。
 *
 * 与 `KojoLibraryTable` / `KojoMutatorTable` 同形（同一 seam：adapter 建一张**纯数据表**、
 * 糖层只查不解释）：把 `KojoFaceTemplate.indexKind: 'counter'` 的面（eraTW：`计数器`）里
 * `{i}` 槽的**中文名**换算成**计数器编号**。数据源是该游戏引擎登记的计数器定义集合
 * （eraTW：`COUNTER_MESSAGE.ERB` 的 `@EVENT_COUNTER_MESSAGE{n}` 家族），**静态、手工维护、
 * 随实测增补**，故不依赖 `loadProject`。
 *
 * 消费点：`时机 <计数器面> <中文名>：` 的编号解析——**纯数字令牌不查表、逐字节直通**；
 * 名查不到 **fail-closed**（不降糖、报诊断，绝不猜编号）；`hasTable=false` 时名路径一律
 * fail-closed。查询一律可名可号，查不到返回 `undefined`（**绝不猜**，规范 §5.3 精神）。
 */
export interface KojoCounterTable {
  /** 无表 / 空表 = false */
  readonly hasTable: boolean;
  /** 编号 → 名（无则 undefined；"登记了编号但没拿到可靠名"同样 undefined） */
  lookupByNumber(no: number): string | undefined;
  /** 名 → 编号（无则 undefined；同名多编号取**首条**） */
  lookupByName(name: string): number | undefined;
  /**
   * 中文名的**枚举**（正向补全用；**可选能力**——未提供 = 宿主不产正向候选，**不猜**）。
   * 与 `KojoInstructionTable.names` 同形同义：返回序即表层候选展示序（实现按数据源原序
   * 返回；同名多编号已去重）；无表 / 空表 = `[]`。IX-1 批补上——此前本表只有正查/反查
   * 两路，编号槽补全因此无从枚举计数器名（错表候选的由来）。
   */
  names?(): readonly string[];
}

/**
 * 条件矩阵的**剧情线预设**（additive，2026-10-18 条件矩阵填格批）。
 *
 * 一条线 = 一个作者常用的状态主题（如「好感线」「恋慕线」）及其涉及的
 * **规范化状态键**（`StateDependency.key`，如 `CFLAG:好感度`）。
 * 矩阵面板只按 keys 匹配行、绝不猜测语义；键背后的游戏含义（哪个编号是
 * 好感、哪个素质是恋慕）是游戏知识，只能由 adapter 提供。
 *
 * 缺省 = 面板不显示剧情线快捷选格（不静默造一条猜出来的线）。
 */
export interface StateLinePreset {
  /** 稳定 id（面板内选择态用） */
  readonly id: string;
  /** 显示名（如「爱慕线」） */
  readonly label: string;
  /** 一句话说明（悬停提示；可选） */
  readonly description?: string;
  /** 归属该线的规范化状态键（精确匹配矩阵行键） */
  readonly keys: readonly string[];
}

/**
 * 游戏适配器（槽位 `game.adapter` 的负载）。
 * 同槽语义：同一项目同一时刻只有一个激活实现；detect 阶段内核轮询全部候选。
 */
export interface GameAdapter {
  /** 游戏标识（存储域后缀、日志用），如 'mygame' */
  readonly gameId: string;
  /** 展示名（人类可读），如 'My Game' */
  readonly displayName: string;

  /** 工程识别（黑盒；适配器内部可自由使用 ctx.io） */
  detect(rootDir: string): Promise<boolean>;
  /** 加载工程（黑盒；内核不感知内部步骤） */
  loadProject(rootDir: string): Promise<GameProject>;

  /** 函数家族识别规则（口上域知识的一部分） */
  readonly functionFamilyIndex?: FamilyIndexRule;
  /** 口上相关变量字典（版本化） */
  readonly variableSchema?: VariableSchema;
  /** 可校验的剧本约定清单 */
  readonly conventions?: readonly ConventionRule[];
  /** 状态模型（供快照/预览消费） */
  readonly stateModel?: StateModel;
  /** 口上调用协议（v0.2 第十批；可选——路由层转发实参的槽位语义表） */
  readonly kojoCallProtocol?: KojoCallProtocol;
  /**
   * 时机分野模板表（v0.3 批 S2 补齐；可选——表层 DSL 的分野关键字 → 目标
   * 函数名映射）。游戏知识只进 adapter；转译器只消费不解释。
   */
  readonly kojoFaceTemplates?: KojoFaceTable;
  /**
   * 指令表（HK-11；可选——面向「指令口上」的中文名 ↔ 编号查询）。
   * 由 adapter 从当前工程数据填充；糖层只查表不解释。
   */
  readonly kojoInstructionTable?: KojoInstructionTable;
  /**
   * 基础库 / 常用函数名表（ZH-F1；可选——中文名 ↔ 原生 ERB 函数名）。
   * 静态、手工维护（不依赖 `loadProject`）；糖层只查表不解释，未收录中文调用形态
   * 原样保留并报诊断（fail-visible）。
   */
  readonly kojoLibraryTable?: KojoLibraryTable;
  /**
   * 数值增减族表（可选——变量族头 ↔ **产物形态**：`CALL` 封装调用，或直写赋值）。
   * 静态、手工维护（不依赖 `loadProject`）；糖层只查表不解释，未登记族 / 变量槽形态
   * 不符**不降糖并报诊断**（fail-closed，绝不猜）。
   */
  readonly kojoMutatorTable?: KojoMutatorTable;
  /**
   * 计数器值域名表（1016 批；可选——计数器编号 ↔ 中文名）。
   * 静态、手工维护（不依赖 `loadProject`）；糖层只查表不解释，未登记的**名**一律
   * `undefined`（**不降糖并报诊断**，fail-closed，绝不猜）；纯数字令牌不查表、直通。
   */
  readonly kojoCounterTable?: KojoCounterTable;
  /**
   * 口上包「日文名 → 中文名」对照词典（展示用；游戏/语言知识，只住 adapter）。
   * 消费方（导入向导 / 文件树）据此把日文名展示为「日文（中文）」。缺省 = 不做对照。
   */
  readonly nameGlossary?: Readonly<Record<string, string>>;
  /**
   * 条件矩阵的剧情线预设（additive；状态键 → 作者常用主题线）。
   * 面板只按 `keys` 精确匹配行，语义全在 adapter；缺省 = 不显示剧情线快选。
   */
  readonly stateLinePresets?: readonly StateLinePreset[];

  /** 脚手架（生成新角色口上骨架；v0.3） */
  scaffold?(characterNo: number, options?: ScaffoldOptions): Promise<ScaffoldResult>;
}
