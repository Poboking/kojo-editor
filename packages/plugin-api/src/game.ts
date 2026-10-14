/**
 * 游戏适配器契约。
 *
 * 铁律：内核源码中不允许出现任何具体游戏名——`GameAdapter` 的**形状**在这里（通用契约），
 * 内容（eraTW / eraK / … 的全部领域知识）只在各 game.adapter 插件中。
 */

import type { ConventionRule } from './conventions';

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
  match(fnName: string): FamilyMatch | null;
  /**
   * 面（`FamilyMatch.face`）→ 人类可读标签（可选；**游戏知识，只住 adapter**）。
   * 消费方（函数树导航 / 条件矩阵列头）据此本地化展示；未收录的面原样显示 token
   * （fail-visible，不猜）。`''`（其它）与 `'declare'`（家族声明）由消费方通用兜底。
   * 缺省 = 适配器未提供面标签，消费方全部原样显示。
   */
  readonly faceLabels?: Readonly<Record<string, string>>;
}

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
export interface KojoFaceTemplate {
  /**
   * 函数名模板。占位符（与 `docs/SYNTAX-SUGAR-SURFACE-SPEC.md` §5.5 同口径）：
   * - `{t}` = **家族段**（标准版空串、别人版 `_口上名`）；
   * - `{n}` = 角色号；
   * - `{i}` = 时机编号（**仅当本模板含 `{i}` 时**才消费 `时机` 声明的编号）；
   * - `${…}` 形态的**非占位**片段（如按 `类型:` 分派的段）由转译器在求值时
   *   提供上下文值，adapter 只声明模板文本。
   */
  readonly template: string;
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
   */
  readonly messageCheck?: {
    /**
     * 函数名段模板。`{n}` = 角色号、`{i}` = 时机编号、`{base}` = 主体函数名、
     * `{scope}` = 作用域段（语法层给语义名，转译器按 `scopes` 映射为段文本）。
     */
    readonly template: string;
    /** 作用域语义名 → 段文本（如 `scene` → `SCENE`、`kojo` → `KOJO`） */
    readonly scopes: Readonly<Record<string, string>>;
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
}

/**
 * 指令表（游戏知识，只住 adapter；糖层只查表不解释）。
 *
 * 数据源 = 当前打开工程的 `CSV/Train.csv`（引擎读取惯例 `TRAINNAME:编号`；
 * 270–299 = kojo_com 段）。各版本 / 汉化 / 魔改随文件自动跟随、**不内置打包**，
 * 故本表按 `loadProject` 生命周期持有。查不到的名字 / 编号一律 `undefined`，
 * **绝不猜**（规范 §5.3 精神：不产半成品）。
 */
export interface KojoInstructionTable {
  /** 无表 / 空表 = false */
  readonly hasTable: boolean;
  /** 中文名 → 编号（无则 `undefined`） */
  lookupByName(name: string): number | undefined;
  /** 编号 → 中文名（无则 `undefined`） */
  lookupByNo(no: number): string | undefined;
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

  /** 脚手架（生成新角色口上骨架；v0.3） */
  scaffold?(characterNo: number, options?: ScaffoldOptions): Promise<ScaffoldResult>;
}
