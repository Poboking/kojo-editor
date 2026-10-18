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

import type { ControlFlowStatement, ErbIndex } from './erb';
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
  /**
   * 分支上下文路径（外→内，段 id 序列）——v0.2 第六批：本地量数据流的
   * 可达性判定用（`前缀包含` = 赋值语句与使用点同路径或为祖先路径）。
   * 仅明细视图填充（聚合视图不保留）。
   */
  context?: string[];
  /**
   * 同行谓词间的合取标记（v0.2 第十二批修复 H1）。
   * CASE 的 `a TO b` 区间展开为 `subject >= a` 与 `subject <= b` 两条
   * 同行谓词，其真实语义是 **AND**（`a <= v && v <= b`）——缺省（undefined）
   * 表示同行 OR（逗号列表的"任一命中"）。分支折叠按"同行内：AND 组
   * 先归约、组间再 OR"消费；向后兼容（无标记的老数据按 OR）。
   */
  conjunction?: 'and';
}

/**
 * 本地量赋值语句（v0.2 第六批；v0.2 第七批扩展 ARG/ARGS）——
 * `LOCAL(:n) = 表达式` 等直线赋值的**结构事实**。
 *
 * 语义（回放侧解释，抽取侧只记录）：
 * - 目标槽位 = `name:index`（裸 `LOCAL` ≡ `LOCAL:0`，与索引段声明规则一致）；
 * - `context` = 分支上下文路径（与 `FunctionPredicate.context` 同构）：
 *   赋值点在使用点的祖先路径（前缀包含）上才算"可达"；
 * - RHS 无法解析 → `opaque`（回放求值时降级 unknown，绝不猜测）；
 * - `ARG / ARGS` = 参数槽直线赋值（v0.2 第七批）——口上惯用法
 *   `SIF !ARG / ARG = TARGET`（参数补位）。**静态叠加层不消费**（ARG 读取
 *   仍走调用上下文注入优先），只有**内联解释器**（顺序执行语义）消费：
 *   参数补位赋值在 SIF 条件为真时才生效，静态数据流无法表达。
 */
export interface FunctionAssignment {
  /** 目标变量（Emuera 语言级局部量族 + 参数槽族） */
  name: 'LOCAL' | 'LOCALS' | 'RESULT' | 'RESULTS' | 'ARG' | 'ARGS';
  /** 下标（缺省 0） */
  index: number;
  /** RHS 表达式 AST */
  expr: ConditionExpr;
  /** RHS 原文（展示 / 排障） */
  text: string;
  /** 赋值行（1 基） */
  line: number;
  /** 分支上下文路径（外→内） */
  context: string[];
}

/**
 * RETURNF 语句的结构事实（v0.2 第七批）——内联求值的返回点资料。
 * 与 `FunctionAssignment` 同类：抽取层只记录，回放层（内联解释器）消费。
 */
export interface FunctionReturn {
  /** 返回表达式 AST（无法解析 → opaque） */
  expr: ConditionExpr;
  /** 原文（展示 / 排障） */
  text: string;
  /** 行（1 基） */
  line: number;
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
  /**
   * 函数体结束行（1 基，含；v0.2 第七批）——内联求值需按行区间取函数体
   * （调用方据此读文件切片），与抽取侧的行区间语义一致 [startLine, endLine]。
   */
  endLine: number;
  /** 控制流骨架（完整语句序列：IF/ELSEIF/ELSE/ENDIF/SELECTCASE/CASE…） */
  statements: ControlFlowStatement[];
  /** 谓词序列（按行序；CASE 每值一条） */
  predicates: FunctionPredicate[];
  /**
   * 本地量赋值语句序列（v0.2 第六批；按行序）——回放的数据流资料。
   * 只收录目标为 LOCAL/LOCALS/RESULT/RESULTS/ARG/ARGS 的直线赋值（含 `+=` 等
   * 复合赋值 → 记为 opaque 载体的"失效点"，防误报旧值）。
   */
  assignments: FunctionAssignment[];
  /**
   * RETURNF 返回点序列（v0.2 第七批；按行序）——内联解释器的返回值资料。
   * 仅明细视图填充（聚合路径零开销）。
   */
  returns: FunctionReturn[];
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
  /**
   * **离线抽取**（additive，2026-10-19 性能批）：对调用方提供的任意 `ErbIndex`
   * （例如工作区口上包索引——`erb-parser` 的 `buildIndex([workspaceArtifactRoot])` 产物）
   * 做一次条件抽取，结果只经返回值交给调用方（条件矩阵等工作区视图消费）。
   *
   * 隔离边界：**不触碰父服务状态**——`currentIndex()` 不变、不通知订阅者、
   * 不读也不写快照、不清洗也不污染明细 / 正文缓存；抽取仍复用同一套 schema 标注、
   * 批量读与 worker 分发路径（与 `ensureIndex()` 同源，不存在第二套抽取逻辑）。
   *
   * 空索引 ⇒ 返回**形状稳定的空结果**（`byFunction` 为空 Map，不抛错）。
   *
   * `texts`（additive）给出「路径 → 待抽取正文」的覆盖表：工作区 `.kojo` 的产物 ERB
   * **从不落盘**，抽取器不能按 `filePath` 读盘；给表后该路径一律用表内文本（缺项仍走
   * `readFile`）。不给 = 逐文件读盘（旧行为逐字不变）。
   *
   * **可选方法**：旧版本服务未实现，消费方必须先判
   * `typeof service.extractIndex === 'function'`，否则降级（隐藏矩阵 / 退回 `ensureIndex()`）。
   */
  extractIndex?(index: ErbIndex, texts?: ReadonlyMap<string, string>): Promise<ConditionIndex>;
  /** 订阅索引更新（立即以当前值回调一次，返回退订函数） */
  subscribe(cb: (index: ConditionIndex | null) => void): () => void;
  /**
   * 解析单个表达式文本（失败 → `{ kind: 'opaque', text }` 整体降级）。
   *
   * **无状态纯函数**，不依赖索引，可随时调用。**使用方（v0.3 批 S5）**：
   * 语法糖提升建议器（`@kojo/plugin-kojo-sugar` 的 `sugar.lift`）——它需要
   * 判断"这个 IF / SELECTCASE 的条件表达式糖层能否原样重写"，`opaque` 即
   * "不能，跳过不产出候选"的信号。
   *
   * 之所以**做成服务方法**而不是让 kojo-sugar 直接 import condition-extractor
   * 包：插件不得交叉 import（解耦审计 C 项），只能经服务槽单向依赖。
   */
  parseExpression(text: string): ConditionExpr;
}

/** 规范化变量引用为依赖键（如 CFLAG:2 / TALENT:恋慕 / LOCAL） */
export function dependencyKey(ref: Pick<VariableRef, 'name' | 'indices'>): string {
  return ref.indices.length === 0 ? ref.name : `${ref.name}:${ref.indices.join(':')}`;
}
