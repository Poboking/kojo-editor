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
 * v0.2 第六批扩展：本地量数据流（`FunctionPredicates.assignments` 驱动）、
 * 引擎内置纯函数子集求值、`ReplayCallContext` 调用上下文注入（ARG/ARGS）。
 *
 * 术语：`unknown` 是**能力边界的诚实呈现**，不是错误；`read` / 求值绝不抛错。
 */

import type { ConditionExpr, VariableRef } from './conditions';

/** 未知原因分类（UI 分组统计 / 提示文案用） */
export type ReplayUnknownCode =
  | 'opaque' // 表达式未被解析（opaque 降级）
  | 'call' // 函数调用（近似回放不执行函数）
  | 'builtin' // 内置函数存在但此调用无法求值（参数未知 / 越界 / 类型不符）
  | 'rename' // `[[词]]` rename 语法（读取期替换，编辑器保留原文）
  | 'pseudo' // 伪变量（RAND / CHARANUM 等计算值）
  | 'local-no-write' // 本地量在函数内无可见赋值（v0.2 第六批起：本地量数据流的边界）
  | 'call-context' // ARG/ARGS 为调用参数，未提供（或未覆盖该槽位的）调用上下文
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
  /**
   * 同行合取标记（v0.2 第十二批修复 H1；自 `FunctionPredicate.conjunction`
   * 透传）——`'and'` = CASE `TO` 区间的半边谓词，同行归约须先组内 AND。
   * 缺省 = 同行 OR（逗号列表语义）。
   */
  conjunction?: 'and';
}

/** 函数级回放结果 */
export interface FunctionReplay {
  normalizedName: string;
  filePath: string;
  startLine: number;
  predicates: PredicateReplay[];
  /**
   * 分支走向（v0.2 第九批）：把谓词三值结果按 IF/ELSEIF/ELSE 链与
   * SELECTCASE/CASE 链折叠，回答"该状态会走哪个分支"（比逐条谓词
   * 更接近作者视角）。含嵌套链（按 depth 区分）与可达性传播。
   */
  branches: BranchChainOutcome[];
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

/** 分支链类别 */
export type BranchChainKind = 'if-chain' | 'select-chain';

/**
 * 单条分支链的求值结果（v0.2 第九批）。
 *
 * 语义（引擎语言层，与 scanner 配对表同源）：
 * - IF 链 = IF → (ELSEIF)* → (ELSE)? → ENDIF；求值走首个真谓词，全假 → ELSE。
 * - SELECTCASE 链 = SELECTCASE → (CASE)* → (CASEELSE)? → ENDSELECT；
 *   CASE 谓词（抽取层已展开为 `subject == 值` 等）同理，CASEELSE = 兜底。
 *
 * **可达性传播**：链头若位于某条外层链"未进入分支"的行区间内 → 该链
 * 不可达（`unreachable`）——外层未命中时内层条件即使为真也不会执行。
 * 已知近似（刻意不建模）：循环体内链的多次执行（回放取单遍语义）。
 */
export interface BranchChainOutcome {
  kind: BranchChainKind;
  /** 链头行（IF / SELECTCASE；1 基） */
  headLine: number;
  /** 块深度（缩进呈现用） */
  depth: number;
  /** 链成员（按行序；条件成员含谓词原文） */
  members: {
    line: number;
    kind: 'IF' | 'ELSEIF' | 'ELSE' | 'CASE' | 'CASEELSE';
    /** 谓词原文（ELSE/CASEELSE 为空串） */
    text: string;
  }[];
  /** 命中分支行（outcome = 'taken' 时非空；跳转定位用） */
  takenLine: number | null;
  /**
   * - `taken`：确定命中某分支；
   * - `no-match`：全假且无 ELSE/CASEELSE（落空——口上域少见但合法）；
   * - `unknown`：链上存在未知条件且前序全假（无法判定走向）；
   * - `unreachable`：外层链未进入本链所在分支。
   */
  outcome: 'taken' | 'no-match' | 'unknown' | 'unreachable';
  /** outcome = 'unknown' 时的原因（来自首个阻断判定的谓词） */
  unknown?: ReplayUnknown;
}

/**
 * 调用上下文（v0.2 第六批）——模拟"该函数被这样调用"时的实参注入。
 *
 * 语义（引擎 `ConvertArg` / `IntoFunction`，Process.CalledFunction.cs:162-239 +
 * Process.State.cs:495-515）：签名声明的参数槽在**调用时必有值**——实参或
 * 默认值 0/''；但**转发自路由层的值本身是场景输入**（如"约会对象编号"），
 * 编辑器无从推断 → 注入之外一律 unknown（显式，不猜测 0）。
 *
 * 槽位编号：`ARG` 裸名 ≡ `ARG:0`（1D 数组裸引用 = 0 号下标，引擎
 * VariableParser 语义），因此 `ints[0]` 对应签名的第一个参数槽。
 */
export interface ReplayCallContext {
  /** ARG 槽位值（0 起；`undefined` / 缺省 = 该槽位未知） */
  ints?: readonly (number | undefined)[];
  /** ARGS 槽位值（0 起；同上） */
  strs?: readonly (string | undefined)[];
}

/** 单函数回放选项 */
export interface ReplayFunctionOptions {
  /** 调用上下文（未提供 → ARG/ARGS 引用一律 unknown('call-context')） */
  callContext?: ReplayCallContext;
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
   * @param options 回放选项（调用上下文注入等）
   * @returns 函数不存在 / 无索引时 null（显式）；函数无谓词 → total=0 的结果。
   */
  replayFunction(view: ReplayStateView, functionName: string, options?: ReplayFunctionOptions): Promise<FunctionReplay | null>;
  /** 批量回放（视图复用；函数不存在时对应条目为 null） */
  replayFunctions(
    view: ReplayStateView,
    functionNames: readonly string[],
    options?: ReplayFunctionOptions,
  ): Promise<(FunctionReplay | null)[]>;
}
