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

  /** 脚手架（生成新角色口上骨架；v0.3） */
  scaffold?(characterNo: number, options?: ScaffoldOptions): Promise<ScaffoldResult>;
}
