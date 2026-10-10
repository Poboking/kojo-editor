/**
 * 状态回放契约（v0.2 第五批：state-replay 先行）——架构文档 §5.3 的编辑器内**近似回放**。
 *
 * 定位：不做完整 EraBasic 解释器——把口上函数中的条件谓词（`condition.extractor`
 * 的明细产物）在**快照状态视图**（`snapshot.source` 的档案归约）上求值，输出
 * "该状态下每条谓词是否成立"。这是近似：函数调用 / rename 词 / 伪变量 / 动态索引
 * 等超出求值器能力的部分降级为 `unknown` 并**显式标注原因**（绝不猜测），
 * 函数级置信度三档（架构 §5.3：确定 / 部分未知 / 无法判定）。
 *
 * 设计分层（"一切皆插件"）：
 * - **契约**（本文件，游戏无关）：状态视图、求值结果、回放服务接口；
 * - **引擎**（`state-replay` 插件）：Emuera 变量寻址语义（TARGET 补位 / 稀疏数组
 *   取值 / 三值求值）——引擎级语言知识，跨游戏一致；
 * - **输入**：谓词明细来自 `condition.extractor`，存档模型来自 `snapshot.source`，
 *   具名索引字典来自 game adapter 的 `variableSchema`——本服务只做编排与求值。
 *
 * 术语：`unknown` 是**能力边界的诚实呈现**，不是错误；`read` / 求值绝不抛错。
 */

import type { ConditionExpr, VariableRef } from './conditions';

/** 未知原因分类（UI 分组统计 / 提示文案用） */
export type ReplayUnknownCode =
  | 'opaque' // 表达式未被解析（opaque 降级）
  | 'call' // 函数调用（近似回放不执行函数）
  | 'rename' // `[[词]]` rename 语法（读取期替换，编辑器保留原文）
  | 'pseudo' // 伪变量（RAND / CHARANUM 等计算值）
  | 'dynamic-index' // 动态索引段（如 `YOGORE:(GET_CHARAHOME(TARGET))`）
  | 'named-index' // 具名索引无法解析（无字典 / 词不在字典）
  | 'missing-var' // 快照与引擎变量清单中均无此变量
  | 'index-oob' // 索引超出数组声明长度
  | 'truncated' // 数组单元在解析时被省略 / 截断（keepArrayCells 策略）
  | 'type' // 类型不匹配（如数字与字符串比较）
  | 'divide-by-zero'
  | 'too-many-args' // 引用参数个数超过变量维度
  | 'string-compare' // 字符串序比较（求值器不支持，== / != 除外）
  | 'non-numeric' // 条件表达式结果非数值（无法判定真值）
  | 'other';

/** 未知结果（携带原因分类与人类可读信息） */
export interface ReplayUnknown {
  code: ReplayUnknownCode;
  message: string;
}

/** 变量 / 表达式求值结果 */
export type ReplayValue =
  | { kind: 'value'; value: number | string }
  | { kind: 'unknown'; unknown: ReplayUnknown };

/** 条件判定结果（引擎语义：数值非零为真；字符串不能作条件） */
export type ReplayOutcome =
  | { kind: 'true' }
  | { kind: 'false' }
  | { kind: 'unknown'; unknown: ReplayUnknown };

/** 单谓词求值记录 */
export interface PredicateReplay {
  /** 谓词来源（IF / ELSEIF / SIF / CASE） */
  kind: 'IF' | 'ELSEIF' | 'SIF' | 'CASE';
  /** 谓词原文（CASE 为展开前原文） */
  text: string;
  /** 来源行（1 基） */
  line: number;
  /** 求值结果 */
  outcome: ReplayOutcome;
  /** 解析后 AST（展示 / 回溯用；与明细同源） */
  expr: ConditionExpr;
}

/** 函数级回放结果 */
export interface FunctionReplay {
  normalizedName: string;
  filePath: string;
  startLine: number;
  predicates: PredicateReplay[];
  stats: {
    total: number;
    hit: number;
    miss: number;
    unknown: number;
  };
  /**
   * 置信度三档（架构 §5.3）：
   * - `exact`：全部谓词可判定；
   * - `partial`：部分 unknown；
   * - `unknown`：全部 unknown（或函数无谓词时 total=0 → exact）。
   */
  confidence: 'exact' | 'partial' | 'unknown';
}

/**
 * 回放状态视图：一份归档 + 一个角色 → 可查询的变量状态。
 *
 * 上下文语义（引擎级，与 VariableParser 补位规则一致）：
 * - `TARGET` 补位 / 显式 `TARGET` → 被回放角色的注册号；
 * - `MASTER` / `ASSI` → 取自快照顶层变量（缺省 0 / -1 与引擎初始值一致）。
 */
export interface ReplayStateView {
  /** 被回放角色的 CSV 编号（口上 `K{no}` 的 no） */
  readonly characterNo: number;
  /** 该角色在快照中的显示名（NAME 标量；不可读时 null） */
  readonly characterName: string | null;
  /** 快照来源（档案路径） */
  readonly archivePath: string;
  /**
   * 读一个变量引用（求值原语 / 展示排障用）。
   * 绝不抛错：不可读 → `unknown` 且原因明确。
   */
  read(ref: VariableRef): ReplayValue;
}

/** 回放服务（服务键 `state.replay`）。 */
export interface StateReplayService {
  /**
   * 创建回放视图：解析档案 → 定位角色（CSV NO）。
   * 失败（档案解析失败 / 角色不在该快照）→ **拒绝并抛错**（显式，不静默）。
   */
  createView(archivePath: string, characterNo: number): Promise<ReplayStateView>;
  /**
   * 回放单函数：按需取谓词明细（`condition.extractor`）→ 逐条在视图上求值。
   * @returns 函数不存在 / 无索引时 null（显式）；函数无谓词 → total=0 的结果。
   */
  replayFunction(view: ReplayStateView, functionName: string): Promise<FunctionReplay | null>;
  /** 批量回放（视图复用；函数不存在时对应条目为 null） */
  replayFunctions(view: ReplayStateView, functionNames: readonly string[]): Promise<(FunctionReplay | null)[]>;
}
