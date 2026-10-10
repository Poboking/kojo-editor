/**
 * 条件谓词抽取契约（v0.2 第三批）。
 *
 * 设计分层（"一切皆插件"）：
 * - **契约**（本文件，游戏无关）：表达式 AST、函数级状态依赖、索引、服务接口；
 * - **引擎**（`condition-extractor` 插件）：控制流骨架 → 表达式解析 → 变量聚合；
 * - **语义标注**：变量的人类可读含义（如"哪个编号是好感度"）由 game adapter 的
 *   `variableSchema` 提供，引擎经槽位查询后**透传**——通用层不解释任何游戏常量。
 *
 * 稳健性原则：表达式解析**包容降级**——无法解析的片段成为 `opaque` 节点，
 * 绝不抛错中断（全量 99k 函数必须跑完）；未解析计数在结果中显式呈现（不静默）。
 */

import type { ControlFlowStatement } from './erb';
import type { VariableInfo } from './game';

/** 变量引用（如 `CFLAG:2`、`TALENT:恋慕`、`CFLAG:ARG:口上セレクタ`、`LOCAL`） */
export interface VariableRef {
  /** 归一化变量名（大写），如 'CFLAG' */
  name: string;
  /**
   * 下标段（原样保留、按出现顺序）：`CFLAG:2` → ['2']；
   * `CFLAG:2:300` → ['2','300']；`TALENT:恋慕` → ['恋慕']；`LOCAL` → []。
   */
  indices: string[];
  /** 源文原样（展示与回溯），如 'CFLAG:2:300' */
  text: string;
}

/**
 * ERB 表达式子集 AST。
 * `opaque` = 解析器无法完整理解的片段（保留原文，消费方可展示但不可求值）。
 * `nameValue` = 引擎 rename 语法 `[[词]]`（读取期按 _Rename.csv 替换；编辑器只保留原文）。
 */
export type ConditionExpr =
  | { kind: 'literal'; value: number | string; text: string }
  | { kind: 'ref'; name: string; indices: string[]; text: string }
  | { kind: 'call'; name: string; args: ConditionExpr[] }
  | { kind: 'unary'; op: string; operand: ConditionExpr }
  | { kind: 'binary'; op: string; left: ConditionExpr; right: ConditionExpr }
  | { kind: 'ternary'; cond: ConditionExpr; then: ConditionExpr; else: ConditionExpr }
  | { kind: 'nameValue'; name: string; text: string }
  | { kind: 'opaque'; text: string };

/** 谓词中的直接阈值比较（如 `CFLAG:2 >= 500` → op '>=', value 500） */
export interface ConditionComparison {
  /** 比较运算符：`==` / `!=` / `>` / `>=` / `<` / `<=` */
  op: string;
  /** 比较常量 */
  value: number | string;
  /** 常量原文（如 '500' / '"A"'） */
  text: string;
}

/**
 * 函数级状态依赖 —— 按变量引用聚合（导航徽章 / 条件矩阵的主数据）。
 * 例如某函数中出现 `CFLAG:2 >= 500` 与 `CFLAG:2 != 800` →
 * 一条依赖 { key:'CFLAG:2', count:2, comparisons:[{'>=' ,500},{'!=',800}] }。
 */
export interface StateDependency {
  /** 规范化键（`CFLAG:2` / `TALENT:恋慕`）；同名同索引不同拼写统一到它 */
  key: string;
  /** 变量名（大写） */
  name: string;
  /** 下标段 */
  indices: string[];
  /** 在函数条件中出现的总次数 */
  count: number;
  /** 直接阈值比较（去重，按首次出现序） */
  comparisons: ConditionComparison[];
  /** 首次出现行（1 基） */
  firstLine: number;
  /**
   * 语义标签（game adapter `variableSchema` 提供；通用层不解释内容）。
   * 例：CFLAG:2 → { name:'CFLAG', index:2, description:'好感度' }。
   */
  schema?: VariableInfo;
}

/** 单函数条件抽取结果 */
export interface FunctionConditions {
  normalizedName: string;
  filePath: string;
  /** 函数定义行（1 基） */
  startLine: number;
  /** 条件谓词总数（含未解析；SIF/IF/ELSEIF/CASE… 每行一条，CASE 列表每值一条） */
  predicateCount: number;
  /** 无法完整解析的谓词数（opaque 降级） */
  unparsedCount: number;
  /** 状态依赖（按 key 聚合后；空数组 = 该函数不含状态条件） */
  dependencies: StateDependency[];
}

/** 全项目条件索引 */
export interface ConditionIndex {
  projectRoot: string;
  finishedAt: number;
  durationMs: number;
  /** 归一化函数名 → 条件结果（仅收录"含谓词"的函数） */
  byFunction: Map<string, FunctionConditions>;
  stats: {
    /** 扫描的函数总数 */
    functions: number;
    /** 含状态依赖的函数数 */
    functionsWithDeps: number;
    /** 谓词总数 */
    predicates: number;
    /** 未解析谓词数 */
    unparsed: number;
    /** 依赖条目总数 */
    dependencies: number;
  };
}

/** 谓词来源语句类别（CASE 展开后的谓词标记其来源语句） */
export type PredicateSourceKind = 'IF' | 'ELSEIF' | 'SIF' | 'CASE';

/**
 * 单条谓词明细（`functionPredicates` 按需解析产物；不入全量索引——
 * 真实工程 49 万谓词常驻内存不划算，明细视图 / 快照回放按需重解析）。
 */
export interface FunctionPredicate {
  /** 来源语句类别 */
  kind: PredicateSourceKind;
  /** 谓词原文（CASE 为展开前原文；展示与回溯用） */
  text: string;
  /** 解析后 AST（CASE 已展开为 `subject == 值` 等；无法解析 → opaque） */
  expr: ConditionExpr;
  /** 来源语句行（1 基；CASE 列表展开的多条谓词共享该行） */
  line: number;
  /** 块深度（scanControlFlow 语义；分支链重建用） */
  depth: number;
}

/**
 * 单函数谓词明细（含完整控制流骨架）。
 * 与 `FunctionConditions`（聚合视图）不同：本结构保留逐条谓词与 AST——
 * 供快照回放求值（v1.0）与未来的明细视图消费，**按需解析、不入常驻索引**。
 */
export interface FunctionPredicates {
  normalizedName: string;
  filePath: string;
  startLine: number;
  /** 控制流骨架（完整语句序列：IF/ELSEIF/ELSE/ENDIF/SELECTCASE/CASE…） */
  statements: ControlFlowStatement[];
  /** 谓词序列（按行序；CASE 每值一条） */
  predicates: FunctionPredicate[];
}

/**
 * 条件抽取服务（服务键 `condition.extractor`）。
 * 消费者：导航面板（条件徽章）、条件矩阵面板（v1.x）、快照回放（v1.0）。
 */
export interface ConditionExtractorService {
  /** 最近一次全量索引（未完成时 null） */
  currentIndex(): ConditionIndex | null;
  /** 取全量索引；未构建则触发（与在途构建共享同一 Promise） */
  ensureIndex(): Promise<ConditionIndex>;
  /** 单函数条件（索引未含该函数时 undefined） */
  functionConditions(normalizedName: string): FunctionConditions | undefined;
  /**
   * 按需解析单函数的谓词明细（含控制流骨架）。
   * 函数不存在 / 无索引 / 读文件失败时返回 null（显式，不伪造空结果）。
   */
  functionPredicates(normalizedName: string): Promise<FunctionPredicates | null>;
  /** 订阅索引更新（立即以当前值回调一次，返回退订函数） */
  subscribe(cb: (index: ConditionIndex | null) => void): () => void;
}

/** 规范化变量引用为依赖键（如 CFLAG:2 / TALENT:恋慕 / LOCAL） */
export function dependencyKey(ref: Pick<VariableRef, 'name' | 'indices'>): string {
  return ref.indices.length === 0 ? ref.name : `${ref.name}:${ref.indices.join(':')}`;
}
