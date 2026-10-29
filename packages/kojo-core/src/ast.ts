/**
 * Kojo 2.0 AST —— core 层的唯一中间表示。
 *
 * 设计口径（v0.9）：
 * - 位置一律 **1 基行 / 1 基列、UTF-16 码元**（与 Monaco、plugin-api 同坐标系）；
 * - 表达式**不在 core 重复实现**词法/语法：节点只持源切片 `ExprText`，降糖交给既有
 *   expression 管线（复用映射见 `docs/KOJO-2.0-LANGUAGE-SPEC.md` §15.2）；
 * - 节点全部 readonly + 判别联合：解析器一次性建树，下游零拷贝遍历；
 * - 注释与物理空行只作为 `KojoLine` 事实留在词法层，不进 AST（source map 另行记录）。
 */

/** 1 基位置；column 为 UTF-16 码元（与 Monaco 列同口径） */
export interface KojoPosition {
  readonly line: number;
  readonly column: number;
}

/** 半开区间 [start, end)；end 不含端点（与 plugin-api 的 range 口径一致） */
export interface KojoSpan {
  readonly start: KojoPosition;
  readonly end: KojoPosition;
}

/** 表达式源切片：原文 + 位置；不在此层做表达式解析 */
export interface KojoExprText {
  readonly text: string;
  readonly span: KojoSpan;
}

/** 字面量（声明初值/常量/表值/`@着色` 颜色） */
export type KojoLiteral = number | string;

/* ============================== 声明 ============================== */

export type KojoVarStorage = 'scene' | 'save' | 'session';
export type KojoValueType = 'int' | 'string';

/** `# 幕 <标题>`：场景序列，不提升、不是函数（见 `KojoSceneNode`） */
export interface KojoSceneNode {
  readonly kind: 'sceneNode';
  /** null = 隐式场景（文件没有 `# 幕`，或首个 `# 幕` 之前的正文） */
  readonly title: string | null;
  readonly items: readonly KojoNarrativeNode[];
  readonly span: KojoSpan;
}

/** `# 视 <目标>`：视角；`{我}` 指向它 */
export interface KojoViewDecl {
  readonly kind: 'view';
  readonly target: string;
  readonly span: KojoSpan;
}

/** `# 机 <事件> [参数…]`：本文件挂到 adapter 的哪个事件上（事件名由 adapter 解析） */
export interface KojoMachineDecl {
  readonly kind: 'machine';
  readonly event: string;
  /** 事件参数原样（core 不懂事件形状，adapter 校验） */
  readonly args: readonly string[];
  readonly span: KojoSpan;
}

/**
 * `# 方言 <名字>`：这份文件**自证**属于哪个方言（LAU §5.3 第 3 级；spec §3.3）。
 *
 * 三条约束（① 可选 ② **只断言不赋值** ③ 错配是 error）里，core 只负责形状：
 * - `name` 是作者写的**不透明字符串**——core 不解释它、不校验它是不是某个已知方言，
 *   词表里也**不许**出现任何方言名取值（零游戏名词铁律）；
 * - 与解析链结论（`detect()` → `project.adapterId`）的对账、以及
 *   `core/dialect/mismatch` / `core/dialect/unbound` 都**不在本层**（方言层的事）；
 * - 不进文件命名空间：它不声明一个可被引用的名字（`declNameOf` 归 unnamed 一路）。
 */
export interface KojoDialectDecl {
  readonly kind: 'dialect';
  /** 被断言的方言名字原文（已 trim；对 core 不透明） */
  readonly name: string;
  readonly span: KojoSpan;
}

/** `# 变量 <名> <类型> [= <初值>] [场景|存档|会话]` */
export interface KojoVarDecl {
  readonly kind: 'var';
  readonly name: string;
  readonly valueType: KojoValueType;
  /** 一维数组长度；undefined = 标量 */
  readonly arraySize?: KojoExprText;
  readonly init?: KojoLiteral;
  readonly storage: KojoVarStorage;
  readonly span: KojoSpan;
}

/** `# 常量 <名> <类型> = <值>` */
export interface KojoConstDecl {
  readonly kind: 'const';
  readonly name: string;
  readonly valueType: KojoValueType;
  readonly value: KojoLiteral;
  readonly span: KojoSpan;
}

/** `# 对照表 <名> 依据 <表达式>` 的一行；range 为闭/开/精确值 */
export interface KojoTableRow {
  readonly from: KojoExprText | null;
  readonly to: KojoExprText | null;
  readonly value: KojoLiteral;
  readonly span: KojoSpan;
}

/** `# 对照表`: 静态、非重叠、`否` 必填；`否` 行以 `from === null && to === null` 表示 */
export interface KojoTableDecl {
  readonly kind: 'table';
  readonly name: string;
  readonly subject: KojoExprText;
  readonly rows: readonly KojoTableRow[];
  readonly span: KojoSpan;
}

export interface KojoTemplateParam {
  readonly name: string;
  readonly span: KojoSpan;
}

/** `# 模 <名>(参数…)`：编译期展开；`slot` = `[插槽]` 在 body 中的位置 */
export interface KojoTemplateDecl {
  readonly kind: 'template';
  readonly name: string;
  readonly params: readonly KojoTemplateParam[];
  readonly body: readonly KojoNarrativeNode[];
  readonly slotIndex: number | null;
  readonly span: KojoSpan;
}

export interface KojoFunctionParam {
  readonly name: string;
  readonly defaultValue?: KojoLiteral;
  readonly span: KojoSpan;
}

/** `@函 <名>(参数…)`：运行期函数（program extension） */
export interface KojoFunctionDecl {
  readonly kind: 'function';
  readonly name: string;
  readonly params: readonly KojoFunctionParam[];
  readonly body: readonly KojoDispatchNode[];
  readonly span: KojoSpan;
}

export type KojoWeaveModifier = 'pri' | 'later' | 'only';

/** `@织 <事件> [之前|之后|接管]`：事件监听 */
export interface KojoWeaveDecl {
  readonly kind: 'weave';
  readonly event: string;
  readonly args: readonly string[];
  readonly modifiers: readonly KojoWeaveModifier[];
  readonly body: readonly KojoNarrativeNode[];
  readonly span: KojoSpan;
}

/** `# 池 <名>`：条件台词池；分支体是叙事节点 */
export interface KojoConditionBranch {
  /** null = `? 否` */
  readonly test: KojoExprText | null;
  readonly body: readonly KojoNarrativeNode[];
  readonly span: KojoSpan;
}

export interface KojoPoolDecl {
  readonly kind: 'pool';
  readonly name: string;
  readonly branches: readonly KojoConditionBranch[];
  readonly span: KojoSpan;
}

export type KojoDecl =
  | KojoViewDecl
  | KojoMachineDecl
  | KojoDialectDecl
  | KojoVarDecl
  | KojoConstDecl
  | KojoTableDecl
  | KojoTemplateDecl
  | KojoFunctionDecl
  | KojoWeaveDecl
  | KojoPoolDecl;

/* ============================== 叙事节点 ============================== */

export type KojoWaitMode = 'default' | 'wait' | 'continue';

/** 文本行里的片段：纯文本 / 插值（插值可带行内条件三段） */
export type KojoTextPart =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'interp';
      readonly expr: KojoExprText;
      /** `{条件 ? A : B}` 的三段（无则纯表达式插值） */
      readonly cond?: { readonly cond: KojoExprText; readonly then: KojoExprText; readonly else: KojoExprText };
    };

export type KojoSpeech =
  /** `角色：「…」`；speaker 为原样说话人切片 */
  | { readonly kind: 'dialogue'; readonly speaker: string }
  /** `> …` */
  | { readonly kind: 'narration' }
  /** `# 池` 内裸引号：省略说话人，默认 `{我}` */
  | { readonly kind: 'bareQuote' };

/** 叙事文本行；表演提示 `(心形)` / `(微笑)` 等只留原文，落点由 adapter 决定 */
export interface KojoTextLine {
  readonly kind: 'textLine';
  readonly speech: KojoSpeech;
  readonly parts: readonly KojoTextPart[];
  readonly wait: KojoWaitMode;
  readonly hint?: string;
  readonly span: KojoSpan;
}

/** `空行` / `空行 等待` / `空行 续` */
export interface KojoBlankLine {
  readonly kind: 'blankLine';
  readonly wait: KojoWaitMode;
  readonly span: KojoSpan;
}

/** `? …` 条件链（一条链一个节点；分支体为叙事节点） */
export interface KojoConditionChain {
  readonly kind: 'conditionChain';
  readonly branches: readonly KojoConditionBranch[];
  readonly span: KojoSpan;
}

/** `@着色 <颜色>` 块 */
export interface KojoColorBlock {
  readonly kind: 'colorBlock';
  readonly color: KojoExprText;
  readonly body: readonly KojoNarrativeNode[];
  readonly span: KojoSpan;
}

/** `@随机` 的候选：单行文本 / `@组` */
export type KojoRandomCandidate =
  | { readonly kind: 'randomLine'; readonly line: KojoTextLine | KojoBlankLine; readonly span: KojoSpan }
  | { readonly kind: 'randomGroup'; readonly body: readonly KojoNarrativeNode[]; readonly span: KojoSpan };

/** `@随机` 块 */
export interface KojoRandomBlock {
  readonly kind: 'randomBlock';
  readonly candidates: readonly KojoRandomCandidate[];
  readonly span: KojoSpan;
}

/**
 * `@原生` 缩进围栏：块体保留物理行原文（去基准缩进后）。
 *
 * `lineColumns`（additive，可选）：`lines[i]` 第一个码元在**物理源行**里的 1 基列
 * （UTF-16 码元口径）。去缩进是"按缩进**宽度**剥前导空白"（Tab 按 4 计、全角空格按 2 计），
 * 被剥掉的**码元数**无法从去缩进后的文本反推（`\t\tX` 与 `        X` 去缩进后同形），
 * 所以只有握着原文的 parser 能给出精确起点列。缺省（手工构造的节点 / 旧消费方）⇒
 * lowering 退化为去缩进视图坐标，不伪造物理列（见 `lower/native.ts`）。
 *
 * 纯空白行按 §8.5「空行原样保留」保留**物理行原文**（含缩进空白，字节零丢失），
 * 其 `lineColumns[i]` 恒为 `1`：视图文本 = 物理行全文，折回是恒等映射；纯空白行没有
 * "第一个内容字符"，取行首（任何 > 1 的值都会把空白字节映射到行外）。
 */
export interface KojoNativeBlock {
  readonly kind: 'nativeBlock';
  readonly lines: readonly string[];
  readonly lineColumns?: readonly number[];
  readonly span: KojoSpan;
}

/** `@算` 块：调度区节点的视觉分组 */
export interface KojoSandboxBlock {
  readonly kind: 'sandboxBlock';
  readonly body: readonly KojoDispatchNode[];
  readonly span: KojoSpan;
}

/** `@颜绘` 单行：`[对象] [表情] [服装] [差分] [特效]` */
export interface KojoFaceLine {
  readonly kind: 'faceLine';
  readonly object: 'me' | 'you' | null;
  readonly args: readonly KojoExprText[];
  readonly span: KojoSpan;
}

/** `选项：` 的按钮条目：`「标签」：` + 缩进正文（待定 UI，parser 仍建树，lowering 给 warning） */
export interface KojoOptionItem {
  readonly label: string;
  readonly body: readonly KojoNarrativeNode[];
  readonly span: KojoSpan;
}

/** `选项：` 块（2.0 待定 UI；adapter presentation，core 只保形） */
export interface KojoOptionsBlock {
  readonly kind: 'optionsBlock';
  readonly items: readonly KojoOptionItem[];
  readonly span: KojoSpan;
}

export type KojoNarrativeNode =
  | KojoTextLine
  | KojoBlankLine
  | KojoConditionChain
  | KojoColorBlock
  | KojoRandomBlock
  | KojoNativeBlock
  | KojoSandboxBlock
  | KojoFaceLine
  | KojoOptionsBlock
  /* 叙事区允许 `! 池名 / ! 模名(...) / ! 函名(...)`（§3.8 / §4.9） */
  | KojoCallStmt
  /* 程序层块可出现在叙事区（设计稿 §4.9 / §9.4） */
  | KojoWhileLoop
  | KojoRepeatLoop
  | KojoForEachLoop
  | KojoLoopJumpStmt
  | KojoLabelStmt
  | KojoJumpStmt;

/* ============================== 调度区 / 程序层 ============================== */

/** 赋值目标：名字 / 数组元素 / 角色属性（原样切片，语义在 S5 校验） */
export interface KojoAssignTarget {
  readonly text: string;
  readonly span: KojoSpan;
}

export type KojoAssignOp = '=' | '+=' | '-=' | '*=' | '/=';

/** 赋值/增量语句 */
export interface KojoAssignStmt {
  readonly kind: 'assign';
  readonly target: KojoAssignTarget;
  readonly op: KojoAssignOp;
  readonly value: KojoExprText;
  readonly span: KojoSpan;
}

/** `! 名(实参…)` / 池/模板调用 */
export interface KojoCallStmt {
  readonly kind: 'call';
  readonly name: string;
  readonly args: readonly KojoExprText[];
  /** `! 模名(…)` 调用处缩进块 = `[插槽]` 内容（§7.2）；池/函调用为空 */
  readonly body?: readonly KojoNarrativeNode[];
  readonly span: KojoSpan;
}

/** 裸函数调用（允许但轻提示） */
export interface KojoExprCallStmt {
  readonly kind: 'exprCall';
  readonly call: KojoExprText;
  readonly span: KojoSpan;
}

/** `@续` / `@断` */
export interface KojoLoopJumpStmt {
  readonly kind: 'loopJump';
  readonly mode: 'break' | 'continue';
  readonly span: KojoSpan;
}

/** `@返 [表达式]` */
export interface KojoReturnStmt {
  readonly kind: 'return';
  readonly value?: KojoExprText;
  readonly span: KojoSpan;
}

/** `@标 <名>` */
export interface KojoLabelStmt {
  readonly kind: 'label';
  readonly name: string;
  readonly span: KojoSpan;
}

/** `@跳 <名>` */
export interface KojoJumpStmt {
  readonly kind: 'jump';
  readonly target: string;
  readonly span: KojoSpan;
}

/** 调度区条件链（分支体为调度语句） */
export interface KojoDispatchCondition {
  readonly kind: 'dispatchCondition';
  readonly branches: readonly {
    readonly test: KojoExprText | null;
    readonly body: readonly KojoDispatchNode[];
    readonly span: KojoSpan;
  }[];
  readonly span: KojoSpan;
}

/** `@循 <条件>`（program extension） */
export interface KojoWhileLoop {
  readonly kind: 'whileLoop';
  readonly test: KojoExprText;
  readonly body: readonly KojoDispatchNode[];
  readonly span: KojoSpan;
}

/** `@复 <次数>`（program extension） */
export interface KojoRepeatLoop {
  readonly kind: 'repeatLoop';
  readonly count: KojoExprText;
  readonly body: readonly KojoDispatchNode[];
  readonly span: KojoSpan;
}

/** `@巡 <集合>`（program extension）；绑定名由 adapter 声明 */
export interface KojoForEachLoop {
  readonly kind: 'forEachLoop';
  readonly collection: KojoExprText;
  readonly body: readonly KojoNarrativeNode[];
  readonly span: KojoSpan;
}

export type KojoDispatchNode =
  | KojoAssignStmt
  | KojoCallStmt
  | KojoExprCallStmt
  | KojoLoopJumpStmt
  | KojoReturnStmt
  | KojoLabelStmt
  | KojoJumpStmt
  | KojoDispatchCondition
  | KojoWhileLoop
  | KojoRepeatLoop
  | KojoForEachLoop
  | KojoSandboxBlock
  | KojoNativeBlock
  /* 调度区允许显式打印（`@函` / 循环体内可用 `>` / `角色：`，§4.1 / §7.3） */
  | KojoTextLine
  | KojoBlankLine
  | KojoFaceLine;

/* ============================== 文件 ============================== */

/**
 * 一个 2.0 源文件。声明提升（`decls` 独立于场景），`# 幕` 按书写顺序切成 `scenes`；
 * 没有 `# 幕` 或首个 `# 幕` 之前有正文时，用 `title: null` 的隐式场景承载。
 */
export interface KojoFile {
  readonly decls: readonly KojoDecl[];
  readonly scenes: readonly KojoSceneNode[];
  /** 文件级诊断（词法/解析阶段）；类型与全局码表同源 */
  readonly diagnostics: readonly import('./diagnostics.js').KojoDiagnostic[];
}
