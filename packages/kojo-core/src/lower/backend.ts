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
  KojoOptionItem,
  KojoRandomCandidate,
  KojoSpan,
  KojoSpeech,
  KojoTextPart,
  KojoWeaveModifier,
} from '../ast.js';
import type { KojoDiagnostic } from '../diagnostics.js';

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
}

/** `选项`（2.0 待定 UI）：label 是按钮文字，body 是该按钮触发的正文 */
export interface OptionsEmitRequest {
  readonly items: readonly KojoOptionItem[];
  readonly span: KojoSpan;
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
   * `lowerItem(item, index)` **返回**该按钮正文的已降糖行（同上，source map 归块头）。
   */
  optionsBlock(
    request: OptionsEmitRequest,
    lowerItem: (item: KojoOptionItem, index: number) => readonly string[],
  ): EmitResult;
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
  forEachHeader(collection: KojoExprText): EmitResult;
  forEachFooter(): EmitResult;
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
}
