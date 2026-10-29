/**
 * `KojoEmitBackend`：core 降糖与"引擎长什么样"之间的**唯一外注边界**。
 *
 * 纪律（设计稿 §1.1 / §8 / §10.2）：
 * - core 不 import 任何插件、不认识任何具体游戏、不写死 ERB 关键字：
 *   PRINT 变体选择、`(心形)` 落 `HPH_PRINT`、`SETCOLOR/RESETCOLOR`、`@随机` 落点
 *   （`PRINTDATA` / `DATALIST` / `RAND+SELECTCASE`）、`@织` 的 `#PRI/#LATER/#ONLY`，
 *   **全部**由 adapter 实现本接口注入；
 * - backend 是纯函数式发射器：一个请求 → 0/1/多行产物文本；不读盘、不保留状态；
 * - **fail-closed 通道**：返回 `EmitFailure` 表示"这一段表达不了"，core 原样收诊断且
 *   **不产任何半成品字节**（作者文本编码失败就走它，见 `literal.ts`）。
 *
 * 契约（写死，adapter 作者必读）：
 * 1. `text.line` / `blank.line` / `presentation.face` 每次调用**至多返回一行**——
 *    `?` 链的 `SIF` 降级依赖这条（单行才可 `SIF cond` + 一行）；
 * 2. 请求里的表达式一律是**源切片**（`KojoExprText`），表达式到 ERB 的编译由 adapter
 *    用既有 expression 管线完成——core 不重复实现表达式词法/语法；
 * 3. 作者文本进引擎字面量必须调 `literal.ts::encodeEngineLiteral`（唯一编码器），
 *    失败就把诊断包成 `EmitFailure` 返回，不许手写转义、不许静默丢字符。
 */
import type {
  KojoAssignOp,
  KojoAssignTarget,
  KojoExprText,
  KojoMachineDecl,
  KojoOptionItem,
  KojoRandomCandidate,
  KojoSpan,
  KojoSpeech,
  KojoTextPart,
  KojoWeaveModifier,
} from '../ast.js';
import type { KojoDiagnostic } from '../diagnostics.js';
import type { ForeachLoopPlan, ForeachSlotRole } from './expand/foreach.js';
import type { OptionsEtbPlan } from './expand/options.js';
/* 等值分派的结构请求（K2-DISPATCH-WIRING）：**type-only**——契约文件只登记形状，
   运行时实现归 adapter；擦除后不产生 core → 计划的运行时环。 */
import type { PoolDispatchEmitRequest } from './expand/pool-plan.js';
import type { TableDispatchEmitRequest } from './expand/table-plan.js';

/* ============================== 发射结果 ============================== */

/** fail-closed：本段表达不了；core 收诊断、不产字节 */
export interface EmitFailure {
  readonly diagnostics: readonly KojoDiagnostic[];
}

/**
 * 一次发射的结果：
 * - `string`：一行产物；
 * - `readonly string[]`：多行产物（每行都映射到同一请求的源 span）；
 * - `null`：本构造没有产物行（如 `@算` 的视觉分组）；
 * - `EmitFailure`：fail-closed（core 收诊断）。
 */
export type EmitResult = string | readonly string[] | null | EmitFailure;

export function isEmitFailure(result: EmitResult): result is EmitFailure {
  return typeof result === 'object' && result !== null && !Array.isArray(result);
}

/* ============================== profile 读数 ============================== */

/** 演出能力声明（§10.2 presentation；未声明即 error，不静默降级） */
export interface KojoPresentationCapabilities {
  /** `(心形)` 一类行尾表演提示落 `HPH_PRINT` 的能力 */
  readonly heart: boolean;
  /** `@着色` → `SETCOLOR/RESETCOLOR` */
  readonly color: boolean;
  /** `@颜绘` → `PRINT_FACE` / `PRINT_FACE_PLAYER` */
  readonly face: boolean;
  /** `@随机` 落点 */
  readonly random: boolean;
  /** `选项`（2.0 待定 UI） */
  readonly options: boolean;
}

/** program extension 细粒度开关（§9.1） */
export interface KojoProgramFeatures {
  readonly arrays: boolean;
  readonly while: boolean;
  readonly goto: boolean;
  readonly recursion: boolean;
  readonly foreach: boolean;
  readonly repeat: boolean;
}

/**
 * profile 读数（§10.2）。**缺一律留 undefined**：core 见到 undefined 报
 * `core/wait/no-profile` / `core/profile/missing`，绝不替作者选默认值。
 */
export interface KojoLoweringProfile {
  /** 无行尾 `续` 时等不等；undefined = 缺 profile（error） */
  readonly waitDefault?: 'wait' | 'continue';
  readonly narrationColor?: 'author' | 'default' | 'auto';
  readonly dialogueColor?: 'author' | 'default';
  readonly colorMode?: 'D' | 'plain';
  readonly poolStyle?: 'if' | 'selectcase';
  readonly randStyle?: 'printdata' | 'printdatal' | 'rand-selectcase';
  /** `@织` 修饰词（之前/之后/接管）是否可用：`emuera-buckets` 才能用 */
  readonly priorityModel?: 'emuera-buckets' | 'none';
  readonly presentations: KojoPresentationCapabilities;
  /**
   * 程序层落点能力（§9.1）。
   *
   * **这是"落点"一侧**：`programFeatures.<键>` = 本 backend 真能发出的产物能力。
   * 作者能不能写由 adapter 的 `programFeatures` 决定（声明一侧）；两侧的收口判定只有一处
   * （`lower/feature-gate.ts::resolveProgramFeatures` / `checkFeature`），主链与查询面都读它，
   * 别在这里或调用方另写一份判断（K2-FEATURE-GATE-UNIFY）。
   */
  readonly programFeatures?: KojoProgramFeatures;
}

/* ============================== 文本 / 空行（三正交） ============================== */

/** 等待轴解析后的两态（`waitDefault` 已由 core 消费 profile 解析） */
export type ResolvedWait = 'wait' | 'continue';

/** 颜色轴：行内不写颜色；颜色只来自 profile 或外层 `@着色` 块 */
export type TextColor =
  | { readonly kind: 'profile' }
  | { readonly kind: 'block'; readonly color: KojoExprText };

/** 行尾提示由 adapter 判定的三态 */
export type HintSupport =
  /** adapter 认识且声明了对应演出（如 `心形` → HPH_PRINT） */
  | 'supported'
  /** 导演批注：不打印、不进玩家文本，保留在 source map / 产物注释里 */
  | 'annotation'
  /** adapter 认识这个提示名，但当前 profile 没声明对应演出 → core 报 error（不生成无效 ERB） */
  | 'unsupported';

export interface TextEmitRequest {
  readonly speech: KojoSpeech;
  /** dialogue 的说话人原文；narration 为 null */
  readonly speaker: string | null;
  /** 池内裸引号的默认说话人（`# 视` 目标）；无则 null */
  readonly defaultSpeaker: string | null;
  readonly parts: readonly KojoTextPart[];
  readonly wait: ResolvedWait;
  readonly color: TextColor;
  /** 行尾表演提示原文；无则 null */
  readonly hint: string | null;
  readonly hintRole: Exclude<HintSupport, 'unsupported'> | null;
  readonly span: KojoSpan;
}

export interface BlankEmitRequest {
  readonly wait: ResolvedWait;
  readonly span: KojoSpan;
}

export interface KojoTextEmitter {
  /** 至多一行（SIF 降级契约） */
  line(request: TextEmitRequest): EmitResult;
}

export interface KojoBlankEmitter {
  /** 至多一行（SIF 降级契约） */
  line(request: BlankEmitRequest): EmitResult;
}

/* ============================== 条件链 ============================== */

export interface KojoControlEmitter {
  /** adapter 是否支持 `SIF`（单语句条件）；false 时 core 一律发完整 IF 链 */
  readonly sifSupported: boolean;
  /** `? <条件>` 链头（真分支） */
  ifHeader(test: KojoExprText): EmitResult;
  /** `? <条件>` 链中后续分支 */
  elseIfHeader(test: KojoExprText): EmitResult;
  /** `? 否` */
  elseHeader(): EmitResult;
  /** 链尾 */
  ifFooter(): EmitResult;
  /** `SIF <条件>`：只作用于紧随的一行 */
  sifHeader(test: KojoExprText): EmitResult;
}

/* ============================== 演出（颜色 / 颜绘 / 随机 / 织） ============================== */

export interface FaceEmitRequest {
  /** 省略对象 = `我`（`# 视` 角色），由 adapter 解析成具体角色槽 */
  readonly object: 'me' | 'you' | null;
  /** 依次为 表情 / 服装 / 差分 / 特效（可省略；`""` 是占位） */
  readonly args: readonly KojoExprText[];
  readonly span: KojoSpan;
}

/** `@随机` 候选纯度事实：core 只算事实，落点由 adapter 按 randStyle 决定 */
export type RandomCandidatePurity = 'single-line-text' | 'group-text' | 'control-or-side-effect';

export interface RandomEmitRequest {
  readonly purity: RandomCandidatePurity;
  readonly candidates: readonly KojoRandomCandidate[];
  /** 隐藏槽名（`__kojo_rand_*`），RAND+SELECTCASE 落点使用 */
  readonly slot: string;
  readonly span: KojoSpan;
}

export interface WeaveEmitRequest {
  readonly event: string;
  readonly args: readonly string[];
  readonly modifiers: readonly KojoWeaveModifier[];
  readonly span: KojoSpan;
  /**
   * **该监听函数自己的**隐藏槽清单（去重、稳定序；没有则空数组）。
   * ERB 局部槽跨函数不可见：监听体的槽不能并进主 `# 机` 的 wrapper 声明。
   * core 的 compile 总是传；adapter 实现按它发 `#LOCALSIZE`/声明。
   */
  readonly slots: readonly KojoHiddenSlot[];
}

/**
 * `选项`（2.0 待定 UI）：label 是按钮文字，body 是该按钮触发的正文。
 *
 * `plan` 是 core 算好的 **ETB 结构计划**（按钮顺序 / 回传值 / 输入步 / 分支骨架）。
 * 2.0 编译主链（`expand/walk.ts`）**总是**给；缺省只发生在走通用 lower（无 adapter
 * 能力闸的块级预览路径）时——新 adapter 应按 `plan` 落点，读到 undefined 就 fail-closed。
 * 这是 additive 字段：旧 adapter 只读 `items`/`span` 仍结构兼容。
 */
export interface OptionsEmitRequest {
  readonly items: readonly KojoOptionItem[];
  readonly span: KojoSpan;
  readonly plan?: OptionsEtbPlan;
}

export interface KojoPresentationEmitter {
  colorEnter(color: KojoExprText): EmitResult;
  colorExit(): EmitResult;
  /** 至多一行（SIF 降级契约） */
  face(request: FaceEmitRequest): EmitResult;
  /**
   * `@随机`：落点（PRINTDATA / DATALIST / RAND+SELECTCASE）由 adapter 选。
   * `lowerCandidate(candidate, index)` 是 core 提供的"把该候选照常降糖"的回调——**返回**该候选的
   * 已降糖行（core 用子缓冲算好；source map 归到块头，§10.7"随机隐藏槽映射到块头"）。
   * adapter 负责把 头 + 各候选行 + 尾组装成完整产物行返回（顺序由 adapter 定，core 不再插队）。
   */
  randomBlock(
    request: RandomEmitRequest,
    lowerCandidate: (candidate: KojoRandomCandidate, index: number) => readonly string[],
  ): EmitResult;
  /**
   * `选项` 块（2.0 待定 UI）：头/尾/按钮如何落由 adapter 决定；
   * `request.plan` 给按钮顺序/回传值/分派骨架（core 的结构事实，adapter 不猜）；
   * `lowerItem(item, index)` **返回**该按钮正文的已降糖行（同上，source map 归块头）。
   */
  optionsBlock(
    request: OptionsEmitRequest,
    lowerItem: (item: KojoOptionItem, index: number) => readonly string[],
  ): EmitResult;
  /**
   * `# 池` 的**可证等值**落点（K2-POOL-SELECTCASE；additive）。
   *
   * 缺省 = 老 adapter 不支持：core 保持既有 `IF / ELSEIF / ELSE` 链（产物逐字节不变，
   * 不是错误、也不静默降半档）。提供时，core 只在 `pool-plan.ts` 判定**同一主语 +
   * 整数等值可证**时调用；`request.caseLines[i]` ↔ `request.plan.cases[i]`，每行都是
   * core 已降糖的产物行（无缩进），adapter 只缩进嵌入、**不得改写/删除/插入/重排**。
   * 主语求值行由 core 在请求之前发完，adapter 不重复求值。
   *
   * 返回值是**整块**产物行（块头 + 各档 + 兜底 + 块尾）或 `EmitFailure`（fail-closed）。
   */
  poolDispatch?(request: PoolDispatchEmitRequest): EmitResult;
}

export interface KojoWeaveEmitter {
  weaveHeader(request: WeaveEmitRequest): EmitResult;
  weaveFooter(): EmitResult;
}

/* ============================== 调度区 / 程序层（`@算` 等） ============================== */

export interface AssignEmitRequest {
  readonly target: KojoAssignTarget;
  readonly op: KojoAssignOp;
  readonly value: KojoExprText;
  readonly span: KojoSpan;
}

export interface CallEmitRequest {
  readonly name: string;
  readonly args: readonly KojoExprText[];
  readonly span: KojoSpan;
}

export interface ExprCallEmitRequest {
  readonly call: KojoExprText;
  readonly span: KojoSpan;
}

/**
 * `@巡` 的完整索引循环请求（additive；2.0 主链优先走 `program.forEachLoop`）。
 *
 * 分工（与 `选项` 的 ETB 计划同一口径）：
 * - `plan` 是 core 校验过的**纯事实**（槽名 / 绑定 / 长度机制 / 空集合整块跳过），
 *   adapter 不得改变这些语义（不得先跑一轮再判空、不得把结束值改成含）；
 * - `body` 是**已降糖**的循环体行（core 用子缓冲算好，`state.loopDepth` 已生效）：
 *   adapter 只负责缩进嵌入，**不得改写/删除/插入** body 行；
 * - 产物形状（索引循环关键字、元素取法）是 adapter 的落点事实，core 零引擎关键字。
 */
export interface ForEachEmitRequest {
  readonly plan: ForeachLoopPlan;
  readonly body: readonly string[];
  readonly span: KojoSpan;
}

export interface KojoProgramEmitter {
  /** `@算` 视觉分组开（没有运行时表示时返回 null） */
  sandboxEnter(): EmitResult;
  /** `@算` 视觉分组关 */
  sandboxExit(): EmitResult;
  assign(request: AssignEmitRequest): EmitResult;
  call(request: CallEmitRequest): EmitResult;
  exprCall(request: ExprCallEmitRequest): EmitResult;
  loopJump(mode: 'break' | 'continue'): EmitResult;
  returnValue(value: KojoExprText | null): EmitResult;
  label(name: string): EmitResult;
  jump(target: string): EmitResult;
  whileHeader(test: KojoExprText): EmitResult;
  whileFooter(): EmitResult;
  repeatHeader(count: KojoExprText): EmitResult;
  repeatFooter(): EmitResult;
  /**
   * **旧路径**（通用 lower；没有展开感知的块级预览）：`@巡` 的头/尾。
   * 2.0 主链不走它——主链用下面的 `forEachLoop`（带 plan 与已降糖 body）。
   */
  forEachHeader(collection: KojoExprText): EmitResult;
  forEachFooter(): EmitResult;
  /**
   * `@巡` 索引循环（additive；**2.0 主链的唯一落点**）。
   *
   * 缺省 = 老 backend 不支持：core 报 `core/feature/unsupported` 且**不产字节**
   * （fail-closed，不退回 `forEachHeader/Footer` 猜绑定）。
   */
  forEachLoop?(request: ForEachEmitRequest): EmitResult;
  /**
   * `# 对照表` 的**可证等值**落点（K2-TABLE-SELECTCASE；additive）。
   *
   * 缺省 = 老 adapter 不支持：core 保持既有等值 `IF / ELSEIF / ELSE` 链（产物逐字节
   * 不变，不是错误）。提供时，core 只在 `table-plan.ts` 判定全部臂是精确整数等值、
   * 臂数达标、判别式纯整数时调用；`request.armLines[i]` ↔ `request.plan.cases[i]`，
   * 每行都是 core 已降糖的产物行（无缩进），adapter 只缩进嵌入、**不得改写/删除/插入/重排**。
   * 判别式求值行由 core 在请求之前发完，adapter 不重复求值。
   *
   * 返回值是**整块**产物行（块头 + 各档 + 兜底 + 块尾）或 `EmitFailure`（fail-closed）。
   */
  tableDispatch?(request: TableDispatchEmitRequest): EmitResult;
}

/* ============================== 文件装配（`# 机` 事件头） ============================== */

/**
 * core 在产物里**只发引用、不发表明**的隐藏槽（`__kojo_` 保留前缀）。
 *
 * 声明（ERB 的 `#DIM` / `#DIMS` / LOCAL 等）是装配事实：core 把清单交给 adapter 的
 * `wrapMachine` / `weaveHeader`，由它按槽的静态类型事实落声明；**不要让 adapter 反推
 * body 文本，也不要靠名字后缀猜类型**。
 */
export type KojoHiddenSlotKind = 'table' | 'random' | 'template' | 'foreach' | 'pool';

/** 槽的用途细分（additive；adapter 可选读，声明形态/命名可据此分档） */
export type KojoHiddenSlotRole =
  /** `# 对照表` 的判别值槽（整数，只求值一次） */
  | 'table-subject'
  /** `# 对照表` 的分档结果值槽（类型 = 表值列类型） */
  | 'table-value'
  /** `@随机` 的候选下标槽（整数） */
  | 'random-slot'
  /** `@巡` 的索引槽（整数；`{下标}` 直接引用） */
  | 'foreach-index'
  /** `@巡` 的元素槽（数组元素 / 角色号） */
  | 'foreach-element'
  /** `@巡` 的键槽（键值集合；`{键}`） */
  | 'foreach-key'
  /** `@巡` 的名字槽（角色集合的 `{名}`） */
  | 'foreach-name'
  /** `# 池` 的主语槽（整数，只求值一次；池的分派判别值） */
  | 'pool-subject'
  /** 其它编译期构造预留 */
  | 'template-slot';

/**
 * `@巡` 槽角色 → 隐藏槽角色（`foreach.ts` 的槽事实是语言层的，契约角色是发射层的）。
 *
 * 唯一一份映射：walk 发槽、adapter 声明、测试断言都按它对齐。
 */
export const FOREACH_HIDDEN_SLOT_ROLES: Readonly<Record<ForeachSlotRole, KojoHiddenSlotRole>> = Object.freeze({
  index: 'foreach-index',
  element: 'foreach-element',
  key: 'foreach-key',
  name: 'foreach-name',
});

/** 槽的静态类型事实（ERB 声明用：int → `#DIM`，string → `#DIMS`） */
export type KojoHiddenSlotValueType = 'int' | 'string';

export interface KojoHiddenSlot {
  /** 隐藏槽名（`__kojo_` 前缀） */
  readonly name: string;
  /** 槽的来源构造（声明形态可能不同） */
  readonly kind: KojoHiddenSlotKind;
  /**
   * 槽值的静态类型（**必填事实**）：ERB 声明据此选 `#DIM`（int）/ `#DIMS`（string）。
   * - 表判别槽 `__kojo_table_<名>`：恒 `int`（分档表达式是整数）；
   * - 表值槽 `__kojo_table_<名>__value`：该表 values 的声明类型（表值同质）；
   * - `@随机` 的 `__kojo_rand_<行>`：文本候选落点 `string`；含控制流/副作用走
   *   `RAND+SELECTCASE` 时是候选下标，`int`（core 按候选纯度给最可证值）；
   * - 池主语槽 `__kojo_pool_<池名>`：恒 `int`（池分派只对整数等值可证）。
   */
  readonly valueType: KojoHiddenSlotValueType;
  /** 用途细分（additive；表有两槽，adapter 需要区分判别值 / 分档结果） */
  readonly role?: KojoHiddenSlotRole;
}

/**
 * `# 机 <事件> [参数…]` 的事件头/包装函数请求。
 *
 * 包装形状（事件函数名、伴生函数、守卫、`#PRI` 头、`@函数名`…）是 **adapter 的模板事实**，
 * 宿主没有能力凭空知道，所以由 backend 注入；core 只把 body 行交给它，并把返回的
 * wrapper 行登记进 source map（wrapper 行 → `# 机` 声明 span = 事件头 origin）。
 *
 * **body 契约**（source map 靠它找回 body 子序列）：
 * - body 是已降糖行，**没有统一缩进**（core 不排版）；
 * - adapter 返回完整产物行时，body 行必须**按原顺序原样嵌入**：可以加缩进（`trimStart()`
 *   后逐字相等即可），**不得改写/删除/插入** body 行；wrapper 行放在 body 前后。
 */
export interface MachineWrapRequest {
  readonly machine: KojoMachineDecl;
  /** 已降糖的正文行（无 wrapper；core 不缩进） */
  readonly body: readonly string[];
  readonly view: string | null;
  /** 本文件用到的隐藏槽清单（去重、稳定序；adapter 据此发声明） */
  readonly slots: readonly KojoHiddenSlot[];
}

/* ============================== 后端 ============================== */

/** adapter 注入的唯一实现面 */
export interface KojoEmitBackend {
  readonly id: string;
  readonly profile: KojoLoweringProfile;
  /** 行尾提示判定（`心形` 是否 HPH_PRINT 是 adapter 的知识，不是 core 的） */
  hintSupport(hint: string): HintSupport;
  readonly text: KojoTextEmitter;
  readonly blank: KojoBlankEmitter;
  readonly control: KojoControlEmitter;
  readonly presentation: KojoPresentationEmitter;
  readonly weave: KojoWeaveEmitter;
  readonly program: KojoProgramEmitter;
  /**
   * `# 机` 事件包装（**有 `# 机` 时必须实现**，否则 compile 报 `core/feature/unsupported`）：
   * 返回完整产物行（body 原样嵌入，位置/缩进由 adapter 定）。
   * 每个文件最多一个 `# 机`，调用一次；`@织` 不走这个钩子（它有自己的 weaveHeader/weaveFooter）。
   */
  readonly wrapMachine?: (request: MachineWrapRequest) => EmitResult;
}
