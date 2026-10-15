/**
 * 语法糖契约（v0.3 批 S1）——表层语法（表层 DSL）→ 原生 ERB 的转译契约。
 *
 * 表层语法权威：`docs/SYNTAX-SUGAR-SURFACE-SPEC.md`（v1.2 冻结版）；
 * 架构落位与批次路线：`docs/archive/SYNTAX-SUGAR-IMPL-REVIEW-2026-10-11.md` §八。
 *
 * 设计分层（"一切皆插件"）：
 * - **契约**（本文件，游戏无关）：糖文档模型（front-matter + 时机列表）、
 *   SugarNode 联合 AST（**每个节点携源位置**，源映射地基）、转译服务接口、
 *   诊断结构与行级源映射；
 * - **引擎**（`kojo-sugar` 插件，S2 批建）：行式词法 → AST（缩进配对）→ codegen；
 * - **知识来源**：变量名字典 / 时机分野模板来自 game adapter（游戏知识只进
 *   adapter）——变量字典经 `VariableSchema`、**分野模板经 `KojoFaceTable`
 *   （`game.adapter` 槽位上的 `kojoFaceTemplates`）**，转译器只消费不解释；
 *   `别名` 是**文件级 front-matter 层**，叠加在 adapter 字典之上
 *   且优先于它（规范 §3.8）——因此 `AliasDecl` 属契约层，不属 adapter。
 *
 * 中文关键字本身是**跨游戏语言层**（不是某个游戏的领域知识），故住在本契约；
 * eraTW 特定的旗标命名/配色常量来自 adapter。命名零游戏名词（审计 A 项——
 * `kojo` / `chara` 是钦定的跨游戏术语；裸格式名词同样在禁用清单内）。
 *
 * 与既有资产的关系（审阅 §八对表结论）：
 * - 条件表达式复用 `condition-extractor` 的 ERB 表达式子集（`ConditionExpr`
 *   同源规则镜像），糖侧只做**降糖**（代词 / 属性 / 中文运算符 → ERB 表达式）；
 * - 转译产物必须是"**可回放形态**"（直线赋值 / IF 链 / SELECTCASE / CALL 子集），
 *   才喂得起 `state-replay`（审阅 §1.2-2）；
 * - 预览是 `state-replay` 的消费方，不自建模拟器（审阅 §1.4）。
 *
 * 稳健性原则：转译**宽容但不静默**——能继续就继续（尽量产出 full–AST），
 * 但每一处偏离都进 `SugarDiagnostic[]`。
 *
 * 分层与 IO（v0.3 批 S3 更新）：
 * - `parse` / `transpile` / `sourceOf` 仍是**纯函数**（不读不写文件）——它们可在
 *   WebView 与批处理里高并发调用；
 * - `compileToFile` 是**唯一含 IO** 的入口（S3 批新增）：转译 → 编码组装 →
 *   写盘一体。其写盘顺序沿用注入器范式（守卫 → 生成 → 备份 → 双闸写 → 回读
 *   验证，见 `snapshot.ts` 的 `SnapshotWriteService`），**失败一律 fail-closed**。
 *   之所以并入本服务而非另立服务键：编译器本就是"产物流向磁盘"的单一动作，
 *   拆分只会让消费方（S4 保存 UI）承担两步编排 + 状态传递。
 */

import type { Logger } from './base';
import type { FileIO } from './io';
import type { BranchChainOutcome, FunctionReplay, ReplayCallContext, ReplayUnknown } from './replay';

/* ============================ 源位置（源映射地基） ============================ */

/**
 * 源位置（1 基行 / 1 基列，与编辑器惯例一致）。
 *
 * 每个 SugarNode 都携带 `loc`——这是"生成的每一行都能回溯到源位置"的地基
 * （审阅 §1.2：源映射从第一天维护）。列以 **UTF-16 码元**计数（与 Monaco /
 * JS 字符串索引一致；规范 §9 的验收是"定位到源文件具体列"）。
 */
export interface SugarPosition {
  /** 行（1 基） */
  line: number;
  /** 列（1 基；UTF-16 码元） */
  column: number;
}

/**
 * 源区间（半开区间 `[start, end)`；`end` 指向最后一个字符之后）。
 * 多行节点（块）的 `end` 落在**块尾**（含块体；不含后续空行）。
 */
export interface SugarSourceSpan {
  start: SugarPosition;
  end: SugarPosition;
}

/** 所有 SugarNode 共有的形状：带判别式 `kind` 与源位置 */
interface SugarNodeBase {
  /** 该节点在源文件中的区间（含块体） */
  loc: SugarSourceSpan;
}

/* ============================== 插值 ============================== */

/**
 * 插值 —— 规范 §3.4 统一 `{…}` 记号。
 *
 * 两种形态（共用一个节点类型，靠 `kind` 判别）：
 * - `expr`：值插值（`{她的好感度}` / `{她}`）——`text` 为 `{}` 内原文（不含花括号），
 *   数值族/字符串族的沉降差异由转译器按变量字典决定（契约层不解释，因为
 *   "哪个变量是字符串族"是 adapter 字典知识）；
 * - `cond`：行内条件（`{条件 ? "A" : "B"}`，C# 风格三元）——`thenText` / `elseText`
 *   为**分支片段原文**（不含引号；`elseText` 缺省 = 省略假分支）。
 *
 * 边界（规范 §3.6 硬约束）：`{}` 内**不允许**出现 `当` / `如果` 表达式——
 * ERB 行内条件 `\@…\@` 不支持嵌套。编辑器把这种写法报为编译错误（诊断码
 * `interpolation-block-expression`）。
 */
export interface Interpolation extends SugarNodeBase {
  kind: 'interpolation';
  /** 插值形态 */
  form: 'expr' | 'cond';
  /** `{}` 内原文（不含花括号；展示与回溯用） */
  text: string;
  /** form='cond' 时的条件原文（不含 `?`）；form='expr' 时缺省 */
  condText?: string;
  /** form='cond' 时的真分支片段原文；form='expr' 时缺省 */
  thenText?: string;
  /** form='cond' 时的假分支片段原文；**缺省 = 省略假分支**（安全写法） */
  elseText?: string;
}

/* ============================== 文本行 ============================== */

/**
 * 文本行 —— 规范 §3.3「一行文本就是一行文本」。
 *
 * 一个文本行是**逻辑行**（源折行 `\` 已合并），对应一条 PRINT 指令。
 * 两种降糖形态由转译器按规范 §5.1/§5.2 决定：
 * - 常规 → `PRINTFORM{W|L|DW|DL}` 单条指令；
 * - 纯条件行（整行只有一个条件插值、且假分支为空）→ `IF` 块（规范 §3.3 末段）。
 * 契约层只描述**源事实**（是不是台词 / 要不要等 / 插值序列），不预设产物形态。
 */
export interface TextLine extends SugarNodeBase {
  kind: 'textLine';
  /**
   * 是否台词（规范 §1.3 的 99% 相关律）：去插值后的首个非空白字符是
   * `「` / `｢` → true。台词 = 作者色（不取 `D` 后缀）；旁白 = 默认色。
   */
  speech: boolean;
  /** 是否等待（规范 §3.3）：行尾无 `续` → true（默认等待） */
  wait: boolean;
  /**
   * 行内插值序列（按出现顺序）。
   * `text` 字段未保留剥离插值后的字面片段——转译器按同一 `loc` 从源文本切片
   * 重建，避免同一份文本在两处重复存储（契约层不复制源）。
   */
  interpolations: Interpolation[];
}

/* ============================== 条件语句块 ============================== */

/**
 * `如果` 语句块（规范 §3.5）——缩进即块，自动补 `ENDIF`。
 *
 * 编译器**统一产出块结构**（故意不用 `SIF`：`SIF` 只能管一行，是维护陷阱）。
 */
export interface IfBlock extends SugarNodeBase {
  kind: 'ifBlock';
  /** 分支链（≥1 条）：`如果` / `否则如果`* / `否则`? */
  branches: IfBranch[];
}

/** `如果` / `否则如果` / `否则` 的单条分支 */
export interface IfBranch {
  /** 分支关键字类别 */
  kind: 'if' | 'elseif' | 'else';
  /**
   * 条件原文（ERB 表达式，中文运算符未降糖前原样）；
   * `else` 分支为空串。
   */
  condition: string;
  /** 分支体（缩进更深的节点序列） */
  body: SugarNode[];
  /** 分支头所在源位置（`否则` 分支同样有） */
  loc: SugarSourceSpan;
}

/**
 * `如果` **表达式**（赋值位置，规范 §3.5）——把分支结果直接赋给左值。
 *
 * 结构 = 一个 `IfBlock` + `target` 左值；产物为"逐分支写 `左值 = 分支值`"的
 * `IF` 块。**必须含 `否则` 分支**（规范 §3.5：否则左值存在未赋值路径）——
 * 缺失时报诊断 `expr-missing-else`，且不产出半成品 ERB。
 */
export interface IfExpr {
  kind: 'ifExpr';
  /** 赋值目标原文（可能是 `别名`，转译器按 §5.0 先展开） */
  target: string;
  /** 表达式 `如果` 的块结构（`IfBranch.body` 各含**单个表达式节点**） */
  block: IfBlock;
  /** 整个表达式区域的位置（块头 → 块尾） */
  loc: SugarSourceSpan;
}

/* ============================== 选择语句块 ============================== */

/**
 * `当` 语句块（规范 §3.6）——Kotlin `when` 的中文形态。
 * 产物 = `SELECTCASE` / `CASE` / `CASEELSE` / `ENDSELECT`。
 */
export interface WhenBlock extends SugarNodeBase {
  kind: 'whenBlock';
  /** 分派表达式原文（`当 表达式：` 的表达式） */
  subject: string;
  /** 分支序列（`是 …` 与可选的 `否则`） */
  branches: WhenBranch[];
}

/** `当` 的单条分支 */
export interface WhenBranch {
  /** 分支类别：`是` = CASE；`否则` = CASEELSE */
  kind: 'case' | 'else';
  /**
   * `是` 的值区间（按源顺序；`否则` 为空数组）。
   * 每个区间对应一个 `CASE` 值或一条 `CASE a TO b`。
   */
  values: WhenCaseValue[];
  /** 分支体（`否则` 分支 = 语句块形态；`是` 分支在语句块形态下同） */
  body: SugarNode[];
  /** 分支头源位置 */
  loc: SugarSourceSpan;
}

/** `是` 的单个值区间：单值 / `a 到 b` / 逗号列表中的一项 */
export interface WhenCaseValue {
  /** 区间起点原文（数字或字符串字面量） */
  from: string;
  /** `到` 上界原文（含）；单值时为 null（→ `CASE v`） */
  to: string | null;
  /** 值区间本身的位置 */
  loc: SugarSourceSpan;
}

/**
 * `当` **表达式**（赋值位置，规范 §3.6）——各分支用 `->` 给出值。
 *
 * **必须含 `否则` 分支**（同 `IfExpr`：保证左值在所有路径被赋值）；
 * 缺失时报诊断 `expr-missing-else`。
 */
export interface WhenExpr {
  kind: 'whenExpr';
  /** 赋值目标原文（可能为 `别名`，按 §5.0 先展开） */
  target: string;
  /** 表达式 `当` 的块结构（`WhenBranch.body` 各含**单个表达式节点**） */
  block: WhenBlock;
  /** 整个表达式区域的位置（块头 → 块尾） */
  loc: SugarSourceSpan;
}

/* ============================== 随机语句块 ============================== */

/**
 * `随机` 语句块（规范 §3.6 末）——等概率，修掉 `RAND:n` 连写的概率坑。
 *
 * 产物 = `LOCAL = RAND:n` + `SELECTCASE` / `CASE 0..n-1` / `ENDSELECT`。
 * 槽位按规范 §5.4 冻结口径分配（每块独占一个 `LOCAL:N`，嵌套递增）——
 * 该分配是**转译器内部决策**，契约层只描述"候选序列"，不含槽位号。
 */
export interface RandomBlock extends SugarNodeBase {
  kind: 'randomBlock';
  /** 候选（≥2；每个候选是块体节点序列，通常为单条文本行） */
  alternatives: {
    body: SugarNode[];
    loc: SugarSourceSpan;
  }[];
}

/**
 * `随机` 行内简写（规范 §3.6：集合字面量形态，适合一句话的随机）。
 * 例：`随机 「嗯。」,「哦？」,「……」` —— 产物与块形态同构（`RAND:3` + SELECTCASE）。
 */
export interface RandomInline extends SugarNodeBase {
  kind: 'randomInline';
  /** 候选原文序列（含引号，按源顺序） */
  alternatives: string[];
}

/* ============================== 候选组（§3.6） ============================== */

/**
 * `组：` 候选组（规范 §3.6）——把「一个候选想说好几句」写成一条候选。
 *
 * 有意义的位置是 `随机：` 的**候选**（也可在时机正文里作纯分组透传，文档不教）。
 * 组体逐句**透传**进所在候选，不产生任何包装行——产物与「几行裸行候选」同构
 * （`随机：` 的候选边界是**行**，这个写法只是把多行收进一条候选）。
 * 组体允许与「如果」块体同口径的内容（台词 / 旁白 / 心形 / 空行 / 原生行 /
 * 注释 / 更深的块）；空组报 `block-empty`。
 */
export interface GroupBlock extends SugarNodeBase {
  kind: 'groupBlock';
  /** 组体（逐句透传） */
  body: SugarNode[];
}

/* ============================== 段块 ============================== */

/**
 * `段` 块（E13 批）——**多信封分段**的糖形。
 *
 * ## 它解决的问题
 *
 * 绝顶 / 性交面的库内主流形态是"一个函数里 N 个 `LOCAL = n` + `IF LOCAL && <条件>`
 * 信封段"（`M2`/`M3` 记入チェック信封）。手写每段 6–7 行脚手架，且 `LOCAL` 槽
 * **不可写**（它不是变量族头，糖里写不出来）。`段` 把整段脚手架收成一行块头。
 *
 * ## 写法与产物
 *
 * ```
 * 段 NOWEX:噴乳：
 *     「……」
 * 段 TFLAG:193 关：
 *     「……」
 * ```
 *
 * 产物（每段一个信封；`关` 段写 `LOCAL = 0`，即库内"停用占位"语义）：
 *
 * ```
 * ;-------------------------------------------------
 * ;NOWEX:噴乳（記入チェック＝1）
 * LOCAL = 1
 * ;-------------------------------------------------
 * IF LOCAL && NOWEX:噴乳
 *     …
 * ENDIF
 * ```
 *
 * ## 契约口径
 *
 * - `condition` 是**段头原文**（`段` 之后、`关`/冒号之前的 ERB 条件表达式）——
 *   与 `如果` 走**同一条**表达式降糖管线；契约层不解释它；
 * - 段是**时机正文顶层**的写法：同一时机里要么全是 `段`、要么全无（混排报错，
 *   见诊断码 `section-mixed`）；段内**不许再嵌套** `段`（`section-nested`）。
 */
export interface SectionBlock extends SugarNodeBase {
  kind: 'sectionBlock';
  /** 段头原文（ERB 条件表达式；未降糖） */
  condition: string;
  /** `关`（禁用占位）：产物把该段的 `LOCAL` 写成 `0`（与库内空模板同义） */
  disabled: boolean;
  /** 段体（缩进更深的节点序列；不得再含 `段`） */
  body: SugarNode[];
}

/* ============================== 初回块（ONCE） ============================== */

/**
 * `初回 "key"：` 块 —— 引擎 `ONCE(...)` 变量式访问器的块形糖。
 *
 * 「这个 key 是第一次」时走块体：产物 = `IF ONCE(<key>)` … `ENDIF`（块体经 `emitBody`，
 * 故块内 `你：` 自机台词 / `着色` 的 run 口径与其它块完全同源）。
 *
 * ## 契约口径
 *
 * - `key` 是**块头原文**（`初回` 之后、块头冒号之前；未降糖）——字符串字面量或既有
 *   表达式口径（可含 `{}` 插值），走与 `如果` 同一条表达式降糖管线；
 * - `ONCE` 是**变量式访问器**（`ONCE(名称, 初期値, キャラ番号…)`，可读可写）：一参形
 *   `ONCE(名称)`、二参形 `ONCE(名称, 初期値)`、三参形 `ONCE(名称, 初期値, キャラ番号)`。
 *   二参形在**有 `角色:` 文件头**时由转译器补上角色号（编号来自 adapter 解析出的
 *   `charNo`，糖里零硬编码）；三参形原样。
 */
export interface OnceBlock extends SugarNodeBase {
  kind: 'onceBlock';
  /** 块头原文（`初回` 之后、块头冒号之前的 ERB 表达式原文；未降糖） */
  readonly key: string;
  /** 块体（缩进更深的节点序列） */
  readonly body: SugarNode[];
}

/* ============================== 选项块 ============================== */

/**
 * `选项` 块（规范 §3.7）——菜单交互。
 *
 * 产物 = `PRINTBUTTON "文本", "n"` ×N + `INPUTS` + `SELECTCASE RESULTS`。
 * 返回值由工具按**书写顺序**分配 `"1".."n"`（v1 不提供手写返回值——这正是
 * 消灭参数顺序/数值陷阱的设计）。
 *
 * 约束（规范 §3.7）：**每个时机只允许一个 `选项` 块，且不允许嵌套**
 * （两个 `INPUTS` 共用同一个 `RESULTS`，嵌套无解）——违者报诊断
 * `choice-multiple` / `choice-nested`。多轮选择走原生直通 `$标签` + `GOTO`。
 */
export interface ChoiceBlock extends SugarNodeBase {
  kind: 'choiceBlock';
  /** 选项条目（按书写顺序；返回值按此顺序分配） */
  items: ChoiceItem[];
}

/** `选项` 的单条目（`「文本」：` + 缩进块体） */
export interface ChoiceItem {
  /** 按钮显示文本（不含引号；源为 `「…」` / `｢…｣`） */
  label: string;
  /** 条目体（可含 `如果`/`当`/`随机`/`着色` 等块，**不含** `选项`/`菜单` 块） */
  body: SugarNode[];
  /** 条目头源位置 */
  loc: SugarSourceSpan;
}

/* ============================== 菜单块 ============================== */

/**
 * `菜单` 块（`菜单：` / `menu：`）——数字输入菜单（`INPUT` 读回 `RESULT`）。
 *
 * 产物 = 逐条 `PRINTL [n] 标签` + `$INPUT_LOOP` 标签 + `INPUT` + `SELECTCASE RESULT`
 * 的 `CASE n` … `CASEELSE`（无效输入回跳重问，正常分支透出即退出）。**回跳环**是
 * 逐字照真实语料主流写法（`$标签` + `GOTO` 回跳，见 `codegen.emitMenuBlock`）。
 *
 * 约束同 `选项`：**每个时机只允许一个 `菜单` 块、且不允许嵌套**——两个 `INPUT`
 * 共用引擎约定的 `RESULT`，嵌套也解决不了冲突；违者复用诊断
 * `choice-multiple` / `choice-nested`（`SugarDiagnosticCode` 是闭集）。
 */
export interface MenuBlock extends SugarNodeBase {
  kind: 'menuBlock';
  /** 菜单条目（按书写顺序；编号 `[1]..[n]` 按此顺序分配；结构与 `ChoiceItem` 同） */
  items: ChoiceItem[];
}

/* ============================== 问答块（询问 / 确认） ============================== */

/**
 * `询问` / `确认` 块（作者面糖形）——**引擎封装的问答函数调用**（eraTW `ASK_M` / `ASK_YN`）。
 *
 * 与 `选项` / `菜单` 是**另一条管线**：后两者产引擎原生 `INPUTS` / `INPUT` 读回自己约定的
 * 变量（`RESULTS` / `RESULT`）；本组则产 `CALL ASK_M(...)`（或 `ASK_YN`）+ `SELECTCASE RESULT`
 * ——函数名 / 参数拼装 / 读回变量全是**游戏知识**，由 adapter（`KojoFaceTable.ask`）声明模板，
 * 契约层零游戏名词（与 `TimingBlock` 同一条纪律）。
 *
 * 两项是**不同族**（参数签名 / 返回语义不同），故各占一个糖位：
 * - `询问`（多选）：逐项 `标签,条件`，条件非 0 = 可选、0 = 灰显；
 * - `确认`（二择）：恰两项纯标签。
 *
 * 契约层只描述**源事实**（提示行 / 条目序列），产物形态（函数名 / 参数 / 读回变量）挂在
 * adapter 表上、由 codegen 求值。
 */
export interface AskMBlock extends SugarNodeBase {
  kind: 'askMBlock';
  /** 提问提示行（头部可选文案；缺省 = 不产提示行）。经文本行管线发出（可含插值 / 台词色） */
  prompt?: TextLine;
  /** 选项条目（按书写顺序；返回序号 `CASE 0..n-1` 按此顺序分配） */
  items: AskItem[];
}

/** `确认` 块（二择问句；eraTW `ASK_YN`）——结构与 `AskMBlock` 同，仅 adapter 模板不同 */
export interface AskYNBlock extends SugarNodeBase {
  kind: 'askYNBlock';
  /** 提问提示行（同上） */
  prompt?: TextLine;
  /** 选项条目（恰 `KojoAskForm.minOptions`/`maxOptions` 个） */
  items: AskItem[];
}

/** 问答块的单条目（`「标签」 [逐项显示条件]：` + 缩进块体） */
export interface AskItem {
  /** 选项显示标签（不含引号；源为 `「…」` / `｢…｣` / `"…"`） */
  label: string;
  /**
   * 逐项显示条件的原文（标签后的表达式；**仅当** adapter 模板的 `option` 含 `{value}` 时消费）。
   * 缺省 = 用模板 `defaultValue` 填充（eraTW `1` = 有效）。游戏知识只住 adapter。
   */
  value?: string;
  /** 条目体（可含 `如果`/`当`/`随机`/`着色` 等块） */
  body: SugarNode[];
  /** 条目头源位置 */
  loc: SugarSourceSpan;
}

/* ============================== 着色块 ============================== */

/**
 * `着色` 块（规范 §3.9）——`SETCOLOR` / `RESETCOLOR` 自动成对。
 */
export interface ColorBlock extends SugarNodeBase {
  kind: 'colorBlock';
  /** 颜色原文（如 `0xFF8080`），原样透传为 `SETCOLOR <color>` */
  color: string;
  /** 块体 */
  body: SugarNode[];
}

/** `心形`（规范 §3.9）——`CALL HPH_PRINT(@"…", "<mode>")` 中文别名糖 */
export interface HeartLine extends SugarNodeBase {
  kind: 'heartLine';
  /** 是否台词（规则与 TextLine 完全相同：有引号 = 台词 = 非 `d` 模式） */
  speech: boolean;
  /** 是否等待（行尾无 `续` → true） */
  wait: boolean;
  /** 行内插值序列（同 TextLine） */
  interpolations: Interpolation[];
}

/* ============================== 时机声明与文档 ============================== */

/**
 * 时机声明（规范 §3.2）——一个 `.kojo` 文件可含多个时机块。
 * 函数名由工具按 §5.5 拼接公式生成，**作者不写函数名**（这是"口上全哑"
 * 第一大原因的根治点）。
 */
export interface TimingBlock extends SugarNodeBase {
  kind: 'timingBlock';
  /**
   * 分野关键字原文（如 `指令` / `初见` / `事件` / `绝顶` / `射精` / `标记` /
   * `计数器` / `成功` / `追加源` / `日记` / `日常`）。**原样保留**——
   * 分野 → 函数名模板的映射由 adapter 侧知识（完整 37 调用面，
   * `KojoFaceTable`）与转译器共同解析，契约层不内嵌任何模板（否则游戏知识
   * 就会漏进契约）。
   */
  face: string;
  /** 编号（`时机 指令 310：` → `310`；无编号的分野缺省） */
  index?: string;
  /** 作者写的中文指令名原文（`时机 指令 摸屁股：` → `摸屁股`；与数字 `index` 并存，缺省 = 未写中文名） */
  readonly indexName?: string;
  /** 命名参数（`成否:` / `类型:` 等，按出现顺序） */
  namedParams: TimingNamedParam[];
  /**
   * 时机子句（`隐藏情景:` / `隐藏口上:`，规范 §3.2）——对应 MESSAGECHECK
   * 位协议，作者不必再背 `SETBIT`。
   */
  messageCheck: TimingMessageCheck[];
  /** 时机正文（缩进一级的节点序列） */
  body: SugarNode[];
}

/** 时机块头的命名参数（`成否: 游戏判定` → name='成否', value='游戏判定'） */
export interface TimingNamedParam {
  name: string;
  value: string;
  loc: SugarSourceSpan;
}

/** 时机内的 MESSAGECHECK 子句（`隐藏情景: 如果 她睡着了`） */
export interface TimingMessageCheck {
  /** 跳过目标：`情景`（bit0）或 `口上`（bit1） */
  scope: 'scene' | 'kojo';
  /** 条件原文（ERB 表达式，未降糖） */
  condition: string;
  loc: SugarSourceSpan;
}

/* ============================== 自定指令块 ============================== */

/**
 * 自定指令块（HK-12）——作者写中文指令名（如 `自定指令 赛钱：`），工具生成
 * 「NAME / ABLE / 本体」函数组（附录 C #34 五钩子）。
 *
 * 与 `TimingBlock` 同为**文档级块节点**。游戏知识只住 adapter：中文名 → 编号
 * 由指令表（`KojoInstructionTable`，来自 `CSV/Train.csv`）解析；编号缺省时由
 * codegen 在 `KojoFaceTable.customComRange`（eraTW：270–299）内自动分配、防撞车。
 * 契约层不内嵌任何游戏常量（否则游戏知识就会漏进契约）。
 */
export interface CustomCommandBlock extends SugarNodeBase {
  kind: 'custom-command';
  /** 作者写的中文指令名（如「赛钱」） */
  readonly name: string;
  /** 作者显式声明的编号（`编号: N`）；缺省 = 由 codegen 自动分配 */
  readonly index?: number;
  /**
   * `可否使用: <条件>` 可选子句（HK-12 五钩子之 `CAN_COM`）。
   * 值为**条件原文**（ERB 表达式，未降糖）；缺省 = 不生成该钩子函数（引擎自然回退）。
   * 产物走 `KojoFaceTable.customHooks.canCom` 模板（游戏知识只住 adapter）。
   */
  readonly canCom?: string;
  /**
   * `计数器不发: <条件>` 可选子句（HK-12 五钩子之 `COM_Counter不发`）。
   * 值为**条件原文**（未降糖）；缺省 = 不生成该钩子函数。
   * 产物走 `KojoFaceTable.customHooks.comCounter` 模板。
   */
  readonly comCounter?: string;
  /** 正文节点（与 TimingBlock 正文同口径） */
  readonly body: readonly SugarNode[];
}

/* ============================== 原生直通 ============================== */

/**
 * 原生直通（行）——规范 §3.10：行首是全大写英文指令或 `$标签` 时整行透传。
 * 糖不是围栏：任何原生 ERB 行都能原样嵌在时机正文里。
 */
export interface RawLine extends SugarNodeBase {
  kind: 'rawLine';
  /** 原样文本（不含行首缩进与行尾换行） */
  text: string;
}

/**
 * 注释行（2026-10-12 用户第 3 条：**注释不能丢**）。
 *
 * ## 为什么注释要进 AST
 *
 * 作者用 `;` 写分节线（`;------`）与意图说明（`;这里是告白分支`）。这些注释在**产物
 * `.ERB` 里丢掉** = 永久信息损失：产物是分发单位，也是日后「糖视图」重新读出的对象——
 * 注释没了，后来的人（包括作者自己）就只能面对一堆裸代码。实测语料 23.5% 的行是注释，
 * 且它们承载着作者的分节线索，不是可有可无的装饰。
 *
 * ## 边界（明确记录）
 *
 * - **空行不保留**（规范 §3.10：空行只用于分隔，不影响产物）——只在**注释**上做保留；
 * - **`随机` 块候选之间**的注释**不保留**：那里的每一行都被当作一个随机候选，
 *   塞进注释会改变候选序号（`LOCAL = RAND:n` 的 n）——宁可不保留，也不改语义。
 */
export interface CommentLine extends SugarNodeBase {
  kind: 'comment';
  /** 原样的注释文本（含行首 `;`，不含行首缩进） */
  text: string;
}

/**
 * 原生直通（块）——规范 §3.10：行首 `@` 起直到下一个 `@` 行或文件末尾，
 * **整块逐行原样透传**（块内不解析糖语法，可含 `#DIM` / `#FUNCTION` 等
 * 预处理行与任意中文文本）。
 *
 * `lines` 直接装原始行 —— 不 parse、不改写（不透明节点，错误隔离）。
 */
export interface RawFunctionBlock extends SugarNodeBase {
  kind: 'rawFunctionBlock';
  /** 原始行序列（按源顺序；不含行尾换行符） */
  lines: string[];
  /**
   * 若为显式围栏（```erb 围栏 / 行首 `@erb`，审阅 §1.3 第一版边界）标记来源；
   * 注释式 `@` 函数块缺省。
   */
  fence?: boolean;
}

/* ============================== 用户函数（B4 批：公共段 / 自定义函数最小形） ============================== */

/**
 * 用户自定义函数声明块（B4 批；规范 §7.2 重开的最小形）。
 *
 * 表层：`函数 <名>(<形参,…>)：` + 缩进正文。作者**只写名字与形参**，
 * 产物函数名由工具按 adapter 的命名模板拼接
 * （`KojoFaceTable.userFunction.template`，如 `M_KOJO_K{n}_{name}`）——
 * 游戏惯例只住 adapter，契约层零游戏名词（与 `TimingBlock` 同一条纪律）。
 *
 * 形参按**位置**绑定引擎实参记号：第 k 个形参（1 起）在产物里对应
 * `ARG`（k=1）/ `ARG:1`（k=2）/ `ARG:2`（k=3）…（对齐真实语料
 * `@K11_ZE(ARGS,ARG,ARG:1)` 的位置绑定口径：声明位第 k 个接第 k 个实参）。
 * 形参名在函数体内经别名表映射为对应记号，作者照名字读写即可。
 *
 * 与既有面的边界（不冲突论证见 §7.2 与提交说明）：
 * - 与 `RawFunctionBlock`（顶层 `@` 块原样透传）不同——本块**是糖**，产物按公式生成函数名；
 * - 与 `自定指令`（`CustomCommandBlock`，生成引擎固定入口函数组）不同——本块生成的是
 *   **作者自己的函数**，入口由作者在正文里 `调用` 或表达式调用；
 * - 与 `libraryTable`（adapter 基础库函数名表）不同——本块走「**每文件合成表**」，
 *   只把本文件声明的名字并入，不改变 adapter 表的口径。
 */
export interface FunctionBlock extends SugarNodeBase {
  kind: 'functionBlock';
  /** 作者写的函数名（中文/标识符原文；**不含**游戏侧前缀） */
  readonly name: string;
  /** 形参名（按声明顺序；空数组 = 无参） */
  readonly params: readonly string[];
  /** 正文节点（与 `TimingBlock` 正文同口径） */
  readonly body: readonly SugarNode[];
}

/**
 * `返回 <值>` / 裸 `返回`（B4 批）——用户函数体内的返回语句。
 *
 * 二态（按真实语料钉死）：
 * - **有值** = 值函数：产物函数头挂 `#FUNCTION`（数值返回）/ `#FUNCTIONS`（字符串返回），
 *   语句本身落 `RETURNF <值>`（表达式位置调用要求 `#FUNCTION` + `RETURNF`）；
 * - **无值**（裸 `返回`）= 过程：产物落 `RETURN`，函数头**不**挂 `#FUNCTION`。
 */
export interface ReturnStatement extends SugarNodeBase {
  kind: 'returnStatement';
  /** 返回值原文（ERB 表达式/字面量；裸 `返回` 时缺省） */
  readonly value?: string;
}

/**
 * `调用 <名>(<实参…>)`（B4 批）——**语句位置**的用户函数调用（产物 `CALL <名>(<实参>)`）。
 *
 * 表达式位置的调用不另造语法：直接在条件 / 插值里写 `名字(实参)`，经每文件合成表降为
 * 产物函数名（与系统函数名同一降糖管线）。
 */
export interface CallStatement extends SugarNodeBase {
  kind: 'callStatement';
  /** 被调函数名原文 */
  readonly name: string;
  /** 实参原文（逗号分隔；空串 = 无参） */
  readonly args: string;
}

/**
 * 单行条件（`如果 <条件> 则 <语句>`）——产物 `SIF <条件>` + 紧随其后的**恰好一条**
 * 语句行，**不产** `ENDIF`。
 *
 * 与 `IfBlock`（块形，自动补 `ENDIF`）是两条独立通路，天然不歧义：块形由**行尾冒号**
 * 触发（`如果 X：`），本形由**中缀 `则`**触发（`如果 X 则 Y`，无尾冒号）。引擎 `SIF`
 * 只守护**下一行**，故 `statement` 必须是能编译为**单行产物**的语句；否则转译器自动
 * 退化为完整 `IF` / `ENDIF` 块（不静默改变语义）。
 *
 * 对标真实语料：`SIF !CFLAG:11:K11EN_ZE` + 紧随一行 `RETURNF` 的引擎写法。
 */
export interface SingleIfStatement extends SugarNodeBase {
  kind: 'singleIfStatement';
  /** 条件原文（ERB 表达式，中文运算符未降糖前原样） */
  readonly condition: string;
  /** 被守护的单条语句 */
  readonly statement: SugarNode;
}

/* ============================== 别名声明 ============================== */

/**
 * `别名` 声明的**右值形态**（规范 §3.1 表）——决定读写性：
 *
 * | 形态 | 例 | 读写性 |
 * |---|---|---|
 * | `variable` | `别名 X = CFLAG:TARGET:1088` | **可读可写** |
 * | `character` | `别名 X = 角色 15` | **只读**（→ `%CALLNAME:15%`） |
 * | `number` | `别名 X = 0` | **只读**（表达式位置展开为字面量） |
 * | `string` | `别名 X = "小露"` | **只读**（同上） |
 * | `conditional` | `别名 X = 恋人 ? "甲" : "乙"` | **只读**（→ 行内条件 `\@…\@`） |
 *
 * 只读别名出现在**赋值左值**位置 → 编译错误（否则会展开成 `0 = 1`）——
 * 诊断码 `readonly-alias-assignment`（规范 §3.1 / §8 lint 清单）。
 */
export type AliasValueKind = 'variable' | 'character' | 'number' | 'string' | 'conditional';

/** 别名右值（判别式 `kind` 直接对应 `AliasValueKind`） */
export type AliasValue =
  | { kind: 'variable'; /** 目标变量引用原文（如 `CFLAG:TARGET:1088` / `TCVAR:TARGET:20`） */ text: string }
  | { kind: 'character'; /** 角色 CSV 编号（原文，如 `15`） */ no: string }
  | { kind: 'number'; /** 数值字面量原文（如 `0`） */ text: string }
  | { kind: 'string'; /** 字符串字面量内容（不含引号，如 `小露`） */ text: string }
  | {
      kind: 'conditional';
      /** 条件表达式原文（如 `她的恋慕`；展开时按表达式降糖） */
      cond: string;
      /** 真分支字面量（不含引号，如 `小露`；与 `{}` 行内条件同款，规范 §3.4） */
      thenText: string;
      /** 假分支字面量（不含引号）；缺省 = 省略假分支（与 `{条件 ? 真}` 同形） */
      elseText?: string;
    };

/**
 * `别名` 声明（规范 §3.1 / §3.8 / §5.0）。
 *
 * 三条约束（规范 §3.1，编辑器在扫描前即校验）：
 * ① 只能出现在文件头（**所有 `时机` 块之前**）——违者诊断 `alias-not-in-header`；
 * ② 不得与保留代词 `她` / `你` 同名、不得重名——诊断 `alias-name-conflict`；
 * ③ 只在当前文件生效，不跨文件（工具不合并不同文件的别名表）。
 *
 * 语义：`别名` **优先于** adapter 变量字典（同名冲突时作者显式声明覆盖默认解析）。
 */
export interface AliasDecl extends SugarNodeBase {
  kind: 'aliasDecl';
  /** 别名名（作者自定义标识符） */
  name: string;
  /** 右值（四形态联合） */
  value: AliasValue;
}

/* ============================== 常量声明（7 号批） ============================== */

/**
 * `常量 <名> = <值>` 声明（7 号批）——**文件级、编译期展开**，产物**零引擎足迹**。
 *
 * 动机（真实语料）：eraTW 口上作者把"给数值编号起名"的共享常量集中在 `.ERH` 里
 * （`#DIM CONST K11_雾雨迷境_被下药次数 = 1022`），正文里再用 `CFLAG:11:<常量名>`
 * 或裸常量名当数值。糖此前**只读** `.ERH`（适配器分层字典），没有"在 `.kojo` 里
 * 声明常量"的入口——本节点补上这一半。
 *
 * 形态（与 `别名` 同款"词后跟空白"）：`常量 <名> = <整数>`（英文别名 `const`）。
 * **右值限十进制整数字面量**（编译期展开只接字面量；编号起名场景不需要别的）。
 *
 * **产物口径（宏化修订）**：**不发射** `#DIM CONST`（初版曾写成"函数外顶格发射"）——
 * Emuera 里函数外的 `#DIM CONST` 是**游戏级全局**，两个 `.kojo` 各写一个同名常量、
 * 或与语料既有 `.ERH` 全局名撞上，都会让游戏**加载期**整体失败（实测语料：顶层声明
 * 6,011 条、跨文件重名 0 条——作者一贯守规，正因撞上就是崩）。而糖内**全部**引用在
 * 编译期已被字面量替换 ⇒ 该声明对语义是死重，却占着唯一的引擎全局足迹与全部撞名面
 * ⇒ 去掉它，"用户 × 用户"与"用户 × 语料 `.ERH`"两类撞名**构造性消失**。产物里只在
 * 文件顶部留一行注释 `; 常量 <名> = <值>（编译期展开为字面量，不占引擎全局名）`，
 * 常量不是凭空消失（作者在产物里仍看得到它展开成了什么）。
 *
 * 三条约束（与 `AliasDecl` 同口径）：
 * ① 只能出现在文件头（所有 `时机` 之前）——违者 `alias-not-in-header`；
 * ② 不得与保留代词 `她` / `你`、既有别名同名；不得重名——`alias-name-conflict` /
 *    `alias-duplicate`；**不得与 adapter 字典已知的变量名同名**（宏化后的残余坑：
 *    编译期展开会在本文件里静默遮蔽该名字，含 `CFLAG:…:<名>` 的第三段）——同码；
 * ③ 只在当前文件生效——以"只读数字别名"并入表达式别名表（`CFLAG:11:<名>`、
 *    裸 `<名>` 均解析为数值），**不落任何引擎声明**。
 */
export interface ConstDecl extends SugarNodeBase {
  kind: 'constDecl';
  /** 常量名（作者自定义标识符） */
  name: string;
  /** 十进制整数字面量原文（如 `1022`） */
  value: string;
}

/* ============================== SugarNode 联合 ============================== */

/**
 * 糖 AST 节点联合。
 *
 * 判别式统一为 `kind`——消费方用 `switch (node.kind)` 收窄。TS7 对"联合字面量
 * 属性"的 narrow 不可靠（IMPLEMENTATION-LOG 项目教训），因此本契约**只把
 * 单字符/独立字段（`kind` / `form`）用作判别式**，需要组合判定时提供显式类型守卫
 * （见文件末尾 `is*` 系列）。
 *
 * 语句位置节点与表达式位置节点在类型上分离：
 * - `SugarStatement`：可出现在时机正文 / 块体里的节点；
 * - `SugarExprNode`：只出现在表达式位置（`IfExpr` / `WhenExpr` 的分支值）。
 * 二者并集即 `SugarNode`。
 */
export type SugarStatement =
  | TextLine
  | HeartLine
  | IfBlock
  | WhenBlock
  | RandomBlock
  | RandomInline
  | GroupBlock
  | ChoiceBlock
  | MenuBlock
  | AskMBlock
  | AskYNBlock
  | ColorBlock
  | SectionBlock
  | OnceBlock
  | CustomCommandBlock
  | CallStatement
  | ReturnStatement
  | SingleIfStatement
  | RawLine
  | RawFunctionBlock
  | CommentLine;

/** 表达式位置节点（仅出现在 `IfExpr` / `WhenExpr` 的分支体里） */
export type SugarExprNode = IfExpr | WhenExpr | RawLine;

/** 全部 SugarNode（语句 ∪ 表达式；`AliasDecl` / `TimingBlock` 是文档级节点，另见 `SugarTopLevelNode`） */
export type SugarNode = SugarStatement | SugarExprNode;

/**
 * 文档级节点（只出现在文件顶层，不进块体）：
 * `别名` 声明 / 时机块 / 自定指令块。
 */
export type SugarTopLevelNode = AliasDecl | ConstDecl | TimingBlock | CustomCommandBlock | FunctionBlock | CommentLine;

/* ============================== 文档与头声明 ============================== */

/**
 * 文件头声明（front-matter，规范 §3.1）——由"新建向导"生成，作者几乎不用手写。
 *
 * 未声明的可选项，工具**不生成**对应函数（引擎侧自然回退：无色则用默认色，
 * 无开关函数则按默认关处理）。
 */
export interface SugarFrontMatter {
  /**
   * 角色编号（`角色: 12`）——必填。用于 `K{No}` 与 `CFLAG:{No}`。
   * **规范约束**：`口上:` 的值必须写不带下划线的人名，工具负责补前导下划线。
   */
  charNo?: string;
  /** `口上:` 家族名（别人版；省略 = 标准版，登记函数 `RESULTS` 保持为空） */
  family?: string;
  /**
   * 剧本选择器编号（`口上: <家族名> 选择器: <n>`）——同一个家族下的第 n 版口上。
   * 省略 = 初始（登记函数名不带选择器段）。**游戏知识的落点在 adapter**：登记函数名
   * 模板由 `KojoFaceTable.registration.declareSelector` 提供，转译器只补 `{n}`/`{s}`。
   */
  selector?: number;
  /** `显示名:` → 登记函数 `RESULTS:1` */
  displayName?: string;
  /** `简介:` → 登记函数 `RESULTS:2` */
  description?: string;
  /** `口上色:` → `@M_KOJO…_COLOR_K{No}` 内 `SETCOLOR`（原文，如 `0xE4FC08`） */
  color?: string;
  /**
   * `自机色:` → 正文 `你：` 自机（玩家）台词行的 `SETCOLOR`（原文，如 `0x4682B4`）。
   *
   * 与 `color`（角色色）**平行**：写侧 `你：<文本>` 行只认**行首前缀**，产物为
   * `SETCOLOR <自机色>` + 该行的**非 D 变体**打印（`PRINTFORM{L|W}`，文本去掉前缀、
   * 不加引号）——D 系忽略 `SETCOLOR`（= 旁白色），自机台词靠 `SETCOLOR` 上色。
   * 缺省（未声明）时工具回退到 adapter 的缺省自机色（`KojoFaceTable.playerColor`）；
   * 两者都缺省才报诊断并按普通旁白输出（不静默）。
   */
  playerColor?: string;
  /**
   * `旁白色:`（`默认` / `作者色`）——`默认` = 旁白走 `D` 系（默认色）；
   * `作者色` = 旁白也用角色色。**规范 §1.3 的引号×D 系 99% 相关律**的心智模型开关。
   */
  narrationColor?: '默认' | '作者色';
  /**
   * `函数前缀: <模板>`（B4-fp；**additive**）——作者**私有**的用户函数命名前缀。
   *
   * 声明时**优先于** adapter 的 `userFunction.template`；**未声明 = 逐字节走既有
   * adapter 模板**（旧文档零改动）。模板串里的占位符：`{n}` = 角色编号（`角色:`）、
   * `{name}` = 作者写的函数名原文（`函数 <名>：` 的 `<名>`）。**模板只给前缀/骨架、
   * 由作者提供**——转译器零游戏字面量（真语料私有前缀如 `K{n}_` / `Music_` /
   * `CHECK_COLLECTION_` 皆住 `.kojo` 文件头，不进任何插件）。
   *
   * 语义（纯函数）：模板含 `{name}` → 按位置代入函数名；**未含 `{name}`** → 视为
   * 前缀、渲染后**在末尾补上函数名**（`函数前缀: K{n}_` + `函数 问候()` → `K11_问候`）。
   * 非法模板（含未知占位符 / 空模板）→ 报既有码 `face-table-missing`（error）并
   * fail-closed（该文件的「函数」块不产半成品）。
   */
  functionPrefix?: string;
  /** `开关:` 条目（→ `@M_KOJO…_FLAGSETTING_K{No}`），按源顺序 */
  switches: { name: string; value: string; loc: SugarSourceSpan }[];
  /** 头部 `别名` 声明（按源顺序；规范 §3.1 三约束） */
  aliases: AliasDecl[];
}

/**
 * 糖文档 —— 一个 `.kojo` 源文件的解析模型。
 *
 * `topLevel` 顺序敏感：`别名` 只能出现在所有 `时机` 之前（规范 §3.1），
 * 该约束的**校验结果**进 `diagnostics`（不在这里抛错）。
 */
export interface SugarDoc {
  /** 源文件绝对路径（未落盘的新文件可为空串） */
  filePath: string;
  /** 文件头声明 */
  frontMatter: SugarFrontMatter;
  /** 顶层节点（别名声明 + 时机块，按源顺序） */
  topLevel: SugarTopLevelNode[];
  /** 解析诊断（含"能解析但有偏离"的提示；不中断解析） */
  diagnostics: SugarDiagnostic[];
}

/* ============================== 源映射与产物 ============================== */

/**
 * 源映射条目（审阅 §1.2：从第一天维护）。
 *
 * **粒度决策（请勿擅自细化/粗化）**：**行级**是 v1 地基（规范 §6 的 golden 验收是
 * 逐字节文本一致，行级足以支撑"生成的每一行回溯到源位置"）；`runs` 是 S6 编辑体验批
 * 补上的**列级**区段（规范 §9 待实测第 3 条"定位到源文件具体列"）——additive：
 * 行级字段语义与旧判据逐字不变，`runs` 缺省 = 该行只有可信的列区间为空（降糖改写行），
 * 消费端据此退行级。源折行 `\` 把多条源行合成一条产物行 → `sourceLine` 仍取**首行**，
 * 各列区段按 `runs` 落回**自己那条物理源行**（不是统统落回首行起点）。
 */
export interface SugarSourceMapEntry {
  /** 产物行号（1 基） */
  generatedLine: number;
  /** 对应源行（1 基；纯生成行——如 `ENDIF` / `ENDSELECT` / 包装函数骨架——为 null） */
  sourceLine: number | null;
  /** 该产物行覆盖的源区间（可为多行；纯生成行缺省） */
  span?: SugarSourceSpan;
  /**
   * 列级区段（S6 批；按 `generatedColumn` 升序、互不重叠；缺省 = 无列级记录）。
   * 只收录**逐码元恒等**的区段（源切片与产物切片逐码元相等）——绝不记录猜出来的列。
   */
  runs?: SugarColumnRun[];
}

/**
 * 列级区段（S6 批）——产物列 ↔ 源列的一段**逐码元恒等**对齐。
 *
 * 列口径（全链一致，勿改）：**1 基**、宽度按 **UTF-16 码元**（`String.length` / `slice`
 * 口径，与 Monaco 的列完全一致）。故中文/全角标点 = 1 码元，emoji（代理对）= 2 码元，
 * **不是码点数**；产物的 `\t` 缩进同样按 1 码元计入列。
 *
 * 段内映射是恒等平移：`源列 = source.column + (产物列 - generatedColumn)`，
 * 段外（产物前缀 / 降糖改写区）由查询端按「就近夹紧」回落，不猜。
 */
export interface SugarColumnRun {
  /** 区段起点所在产物列（1 基；UTF-16 码元） */
  generatedColumn: number;
  /** 区段宽度（码元数；产物与源同宽——恒等区段的定义） */
  length: number;
  /** 区段起点所在源位置（1 基列；折行时是该区段所属的**物理源行**，非逻辑首行） */
  source: SugarPosition;
}

/** 转译产物 */
export interface SugarTranspileResult {
  /** 生成的 ERB 全文（**未落盘**；写盘走 `compileToFile`，S3 批） */
  erb: string;
  /** 源映射（行级地基 + S6 列级区段；按 generatedLine 升序） */
  sourceMap: SugarSourceMapEntry[];
  /**
   * 全量诊断（parse + transpile）。**非空不必然代表失败**：
   * `severity: 'error'` 存在时不应落盘半成品 ERB（规范 §5.3：
   * 缩进异常/缺 `否则` 等 → 阻止编译，不生成半成品），`compileToFile`
   * 据此在**写盘前**拒编译（fail-closed）。
   */
  diagnostics: SugarDiagnostic[];
}

/* ============================== 编译落盘（S3 批） ============================== */

/**
 * 产物编码（写盘字节层；**不是**文本层的 `EolStyle` 语义）。
 *
 * **实证口径（2026-10-11 全语料实测，覆盖规范 §8 的 CRLF 断言）**：
 * eraTW 4.980 整合版全树 3,818 个 ERB 中 **LF-only 3,787 / CRLF-only 3**
 * （口上域 2,317 个文件 **LF 2,316 / CRLF 0**）——即游戏自带文件几乎全是
 * **LF 换行 + UTF-8 BOM**（BOM 出现率 98.9%，口上域 2,312/2,317）。规范 §8
 * 的"CRLF"与语料不符，实现以**语料为准**（产物须与同目录既有文件同构，
 * 否则 diff 整文件重写）。末尾换行方面语料"有 2,564 / 无 1,254"无硬性约定，
 * 本项目**统一保留末尾换行**（POSIX 惯例 + 规范 §8 明文）。
 * 该偏离已记入 IMPLEMENTATION-LOG §5.29。
 */
export interface SugarCompileEncoding {
  /** 字节序标记：`true`（默认）= 写 UTF-8 BOM（`EF BB BF`），与游戏自带文件一致 */
  bom: boolean;
  /** 换行风格（默认 `lf`；`crlf` 仅在显式指定时使用，规范 §8 字面口径） */
  eol: 'lf' | 'crlf';
  /** 末尾换行（默认 `true`；POSIX 惯例 + 规范 §8 明文） */
  trailingNewline: boolean;
}

/** 编译选项 */
export interface SugarCompileOptions extends SugarTranspileOptions {
  /**
   * 产物编码（缺省 = 语料实证口径：`{bom:true, eol:'lf', trailingNewline:true}`）。
   * 显式传入可覆盖单项——未给的字段取默认值。
   */
  encoding?: Partial<SugarCompileEncoding>;
  /**
   * 写盘前是否**同时**写一份行级源映射旁挂文件（`{targetPath}.map.json`）。
   * 缺省 `false`：S3 只产 ERB 本体，源映射旁挂留给 S4 编辑体验批按需开启。
   */
  writeSourceMap?: boolean;
}

/**
 * 编译依赖（实现侧注入；`kojo-sugar` 装配时提供）。
 *
 * 之所以独立成形：编译链路需要内核 io（写盘）与转译函数（纯逻辑），
 * 把二者显式注入让"写盘顺序"可被单测以替身精确驱动（双闸/备份/回读
 * 各路径覆盖），而不必启动整个内核。
 */
export interface SugarCompilerDeps {
  /** 内核文件 IO（第一道闸 writablePaths 的强制执行者） */
  io: FileIO;
  /** 转译函数（纯逻辑；通常即本服务的 `transpile`） */
  transpile: (source: string, options?: SugarCompileOptions) => SugarTranspileResult;
  /** 可选日志（写盘摘要） */
  log?: Logger;
}

/** 编译落盘结果（回读验证已通过才返回；失败显式抛错并携带备份位置） */
export interface SugarCompileResult {
  /** 写入的产物路径（绝对路径） */
  erbPath: string;
  /** 写盘总字节数（含 BOM / 换行，即真正落盘的字节数） */
  byteSize: number;
  /** 写前备份路径（内核 io backup；目标原文件不存在时为 null） */
  backupPath: string | null;
  /** 源映射旁挂文件路径（仅当 `writeSourceMap: true` 时） */
  sourceMapPath?: string;
  /** 本次编译的全量诊断（含 info/warning；`error` 已在写盘前拒绝，不会走到这里） */
  diagnostics: SugarDiagnostic[];
}

/** 内存编译产物（`compileToBytes` 的结果；零 IO，供导出 ZIP 直接吃） */
export interface SugarCompiledBytes {
  /** 落盘字节（BOM + 换行 + 末尾换行已按语料口径组装） */
  bytes: Uint8Array;
  /** 转译结果（产物文本 + 源映射 + 诊断） */
  transpile: SugarTranspileResult;
}

/**
 * 编译失败错误（fail-closed）。
 *
 * 与 `WriteNotAllowedError` 的分工：路径越权**原样传播** `WriteNotAllowedError`
 * （内核第一道闸的语义，消费方按类型判定）；本错误承载**编译域**的失败
 * （error 诊断阻止写盘 / 回读验证不一致），并**携带上下文**（目标路径 +
 * 备份位置），便于 UI 精确提示"原文件已备份于 X"。
 */
export class SugarCompileError extends Error {
  /** 目标产物路径（可能尚未写入——如 error 诊断在写盘前拒绝） */
  readonly targetPath: string;
  /** 若已写入或已备份：备份路径（未备份时为 null） */
  readonly backupPath: string | null;
  /** 触发失败的诊断（编译拒绝时有值；回读失败时为空数组） */
  readonly diagnostics: readonly SugarDiagnostic[];

  constructor(
    message: string,
    info: { targetPath: string; backupPath?: string | null; diagnostics?: readonly SugarDiagnostic[] },
  ) {
    super(message);
    this.name = 'SugarCompileError';
    this.targetPath = info.targetPath;
    this.backupPath = info.backupPath ?? null;
    this.diagnostics = info.diagnostics ?? [];
  }
}

/* ============================== 保存目标推导与前置检查（S7 批） ============================== */

/**
 * 全角空格（`U+3000`）——**语料里的排版陷阱**（规范 §8：保存期告警）。
 *
 * 属**语言层事实**（非游戏知识），故住契约层并作为**单一真源**：预览面板与
 * 保存前置检查共用（两处各写一遍会让"什么算全角空格"的判据悄悄分叉）。
 *
 * 证据（eraTW 4.980 全量实测）：口上语料 3,599,696 行中含 `U+3000` 者 55,565
 * 行（1.54%），**全部为行中用途**（注释分隔 `;【TARGET】　欲情の珠`、以及编译器
 * 生成的台词缩进 `PRINTFORMW 　「…」`），**行首出现 0 次**。故它是"正常但极易
 * 与半角空格混看"的字符——保存期**告警**（不阻断），由作者判断是否本意。
 */
export const FULLWIDTH_SPACE = '\u3000';

/**
 * 含全角空格（`U+3000`）的源行号（1 基，按升序）。
 *
 * 判据与既有预览面板一致：**行内任一位置**出现 `U+3000` 即计入（不做"仅行首"
 * 收窄——上游 S4-UI 批已按整行判定冻结，收窄会与面板相矛盾）。
 */
export function fullwidthSpaceLines(source: string): number[] {
  const out: number[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(FULLWIDTH_SPACE)) out.push(i + 1);
  }
  return out;
}

/**
 * 由 `.kojo` 源路径推导目标 `.erb` 产物路径（**纯函数**；不触达磁盘）。
 *
 * 规则：**同目录、同基名，扩展名 `.kojo` → `.ERB`**（大小写不敏感，`\` / `/`
 * 分隔符一律保留原样）。非 `.kojo`（或空路径）→ `null`。
 *
 * 依据（真实语料）：产物布局为 `個人口上/{编号 名称}/{口上名}/M_KOJO_K{n}_{分野}.ERB`，
 * 源 `.kojo` 由编辑器"新建向导"与产物**同目录**生成、并沿用产物基名（`K{No}` +
 * 分野都已在源文件名里，见 `M_KOJO_K49_指令.kojo` 惯例）——故"换扩展名"即正确
 * 推导。**不做跨目录/改名**：那属新建向导与命名校验的职责（后者需 adapter 的
 * `M_KOJO_K{No}` 命名知识，不在本通用函数内）。
 */
export function resolveSugarTarget(sourcePath: string): string | null {
  if (!sourcePath) return null;
  const m = /\.kojo$/i.exec(sourcePath);
  if (!m) return null;
  return `${sourcePath.slice(0, sourcePath.length - m[0].length)}.ERB`;
}

/** 保存被阻止的原因（**闭集**；命名零游戏名词） */
export type SugarSaveBlockReason =
  /** 源路径非 `.kojo` —— 无对应产物目标（如误对原生 `.ERB` 触发保存流程） */
  | 'source-not-kojo'
  /** 转译产 `error` 诊断 —— fail-closed，不落盘半成品（同 `compileToFile` 守卫） */
  | 'transpile-error';

/** 保存前置检查请求（纯数据；不读盘不写盘） */
export interface SugarSavePlanRequest {
  /** `.kojo` 源文本（内存态） */
  source: string;
  /** 源文件绝对路径（推导目标产物路径的依据） */
  sourcePath: string;
  /** 转译选项（`filePath` 缺省取 `sourcePath`；显式给出则覆盖） */
  options?: SugarTranspileOptions;
}

/**
 * 保存计划（`planSave` 的产物）——**保存 UI 的唯一前置入口**。
 *
 * 把"保存一颗 `.kojo`"所需的三件事一次算齐：① 目标产物路径推导；② 转译
 * （产物 + 源映射 + 诊断）；③ 全角空格告警行。**纯函数**语义（`planSave`
 * 不读盘不写盘不发事件），落盘仍由 `compileToFile` 负责（S3 写链路）。
 *
 * `blocked` 的语义是"**不要走落盘**"：源非 `.kojo`（无目标）或转译产 error
 * （半成品不可落盘）。全角空格**只告警不阻断**（见 `FULLWIDTH_SPACE` 证据）。
 */
export interface SugarSavePlan {
  /** 源文件绝对路径（回显） */
  sourcePath: string;
  /** 推导出的产物目标路径；源非 `.kojo` → `null` */
  erbPath: string | null;
  /** 转译结果（产物 + 行级源映射 + 全量诊断） */
  transpile: SugarTranspileResult;
  /** 含全角空格（`U+3000`）的源行号（升序）——保存期告警，**不阻断** */
  fullwidthSpaceLines: number[];
  /** 是否阻止落盘（`erbPath === null`，或转译含 error 诊断） */
  blocked: boolean;
  /** 阻止原因（`blocked === true` 时必有值） */
  blockedReason?: SugarSaveBlockReason;
}

/* ============================== 诊断 ============================== */

/**
 * 升糖应用失败错误（fail-closed；S5-UI 批）。
 *
 * 与 `SugarCompileError` 同构（同名同形状的字段），理由：两者的失败模式
 * 完全一致（校验拒绝 / 写盘失败 / 回读不一致），消费方（UI）应当用**同一套
 * 提示逻辑**处理，不该因为"这次是升糖而不是编译"就分叉。
 *
 * 与 `WriteNotAllowedError` 的分工同 `SugarCompileError`：路径越权**原样传播**。
 */
export class SugarApplyError extends Error {
  /** 目标源文件路径 */
  readonly targetPath: string;
  /** 若已备份：备份路径（未备份时为 null） */
  readonly backupPath: string | null;

  constructor(message: string, info: { targetPath: string; backupPath?: string | null }) {
    super(message);
    this.name = 'SugarApplyError';
    this.targetPath = info.targetPath;
    this.backupPath = info.backupPath ?? null;
  }
}

/** 诊断严重度（与 `conventions.ts` 的 `ConventionSeverity` 同口径） */
export type SugarSeverity = 'error' | 'warning' | 'info';

/**
 * 诊断码 —— **闭集**（S2 实现时只允许新增，不得临时发明字符串）。
 * 命名零游戏名词。
 */
export type SugarDiagnosticCode =
  /* --- 结构 / 缩进（规范 §5.3） --- */
  | 'indent-mismatch' // 缩进不齐 / 回缩异常
  | 'block-empty' // 块头无体（`如果 …：` 后没有更深缩进的内容）
  | 'unclosed-block' // 块未闭合（文件尾仍处于块内；糖本应消灭此类，防御性保留）
  /* --- 表达式 `如果` / `当`（规范 §3.5 / §3.6） --- */
  | 'expr-missing-else' // 赋值位置的 如果 / 当 缺 `否则` 分支（必须穷尽）
  | 'expr-body-not-expression' // 表达式 当/如果 的分支体不是 `-> 单个表达式`
  /**
   * E17：语句面「当」块主体为常量 `RAND:n` / 糖形 `随机(n)`（n ≥ 1）、无 `否则`，
   * 且 `是` 档位并集未盖满 `0..n-1`——掷到缺失档位时引擎静默（什么都不会打印）。
   * 分支值含别名 / 变量 / 字符串等不可证形态时不报（宁可不报、绝不猜）。
   */
  | 'rand-case-incomplete'
  /* --- 插值（规范 §3.4 / §3.6 边界） --- */
  | 'interpolation-block-expression' // `{}` 内出现 当 / 如果（行内条件不支持嵌套）
  | 'interpolation-unclosed' // `{` 未收尾
  | 'interpolation-nested' // 插值嵌套（`{}` 内再写 `{}`）
  | 'stray-percent' // 文本中的落单半角 `%`（FORM 串里是变量记号）
  /* --- 别名（规范 §3.1 / §3.8 / §5.0） --- */
  | 'alias-not-in-header' // `别名` 出现在 时机 块之后
  | 'alias-name-conflict' // 别名与保留代词 `她`/`你` 同名，或别名互相重名
  | 'alias-duplicate' // 同一别名重复声明
  | 'readonly-alias-assignment' // 只读别名（角色/字面量）出现在赋值左值
  | 'alias-unknown-target' // 别名右值无法解析（非四形态）
  /* --- 时机（规范 §3.2） --- */
  | 'timing-face-unknown' // 分野关键字不在 adapter 的分野表（KojoFaceTable.faces）
  | 'face-table-missing' // 当前适配器未提供分野表 / 某类模板缺失（如配色/开关）
  | 'timing-duplicate' // 同名编号在同一文件内重复
  /**
   * **生成的函数名**在同一文件里撞车（跨分野也算）。
   * 与 `timing-duplicate` 的分工：后者只看"同一分野 + 同一编号"这种写法层面的重复；
   * 本码看**产物**——两条不同的写法（如 `指令 310 成否: …` 与独立的 `时机 成功 310：`）
   * 渲染出同一个函数头时，引擎会撞「重复定义」，而这在写法表面上完全看不出冲突。
   */
  | 'function-name-duplicate'
  | 'timing-empty-body' // 时机无正文（占位写法；产出 `LOCAL = 0` 占位，INFO）
  /**
   * HK-11②：`时机 指令 <中文名>：` 的中文名不在 adapter 的指令表
   * （`KojoInstructionTable`；数据源 = 工程 `CSV/Train.csv`）。**fail-closed**：
   * 绝不猜编号、不产半成品——报错措辞含「未命名指令（编号 N）」（数字编号路径不受影响）。
   * P-5 起**同一码**也覆盖 `当 …： 是 <中文名>：` 的 `CASE` 值查不到：
   * 该值保留原文（不被换成猜来的编号）并报本码——不新增码、不另开口径。
   */
  | 'timing-instruction-unknown'
  /** HK-12：自定指令块缺 `编号:` 且 adapter 未声明编号可用段（`customComRange`）；fail-closed 不产半成品。 */
  | 'custom-command-no-range'
  /** HK-12：自定指令编号自动分配失败（`customComRange` 段已被占满）；需显式写 `编号:` 或腾出空位。 */
  | 'custom-command-range-exhausted'
  /* --- 选项（规范 §3.7） --- */
  | 'choice-multiple' // 一个时机内出现多个 `选项` 块
  | 'choice-nested' // `选项` 块嵌套
  /* --- 段块（E13 批） --- */
  /** `段` 块嵌套（段体内再出现 `段`）——库内信封段是同层的，嵌套会把 `LOCAL` 槽的语义搅混。 */
  | 'section-nested'
  /**
   * 时机正文**顶层**同时写了 `段` 与普通语句——两种产物的骨架不同（有无外层
   * `IF LOCAL` 信封），拼在一起没有唯一可写回的形状；报错并**不产半成品**。
   */
  | 'section-mixed'
  /* --- 文本行（规范 §3.3 / §4.4） --- */
  | 'cont-inside-quotes' // `续` 标记写在了引号内
  | 'unknown-identifier' // 未命中别名的裸标识符且不在变量字典中
  /**
   * P-10③：`族头:具名索引` 的**名称段不在该族的名称表里**（拼错/瞎造的具名）。
   * 与 `unknown-identifier` 的分工：后者是"这个名字谁都认不出"（error，产物不可信）；
   * 本码是"族头认得出、名称段查无"——**产物照原样输出**（引擎侧可能仍有其约定），
   * 只是不再静默。**严重度 = warning 起步**（真语料实测的表外写法里含动态索引等合法形态，
   * 直接 error 会误伤；升级判据见 BOARD P-10③）。
   */
  | 'family-name-unknown'
  /**
   * ZH-F1：**中文函数名调用形态**（`名字(`）既不在跨游戏语言层的系统函数表
   * （`SYSTEM_FUNCTION_ALIASES`）也不在该游戏的基础库/常用函数表
   * （`KojoLibraryTable`）里。
   * 与 `unknown-identifier` 的分工：后者是"裸标识符谁都认不出"（error）；本码只看
   * **调用形态**（名字后随 `(`），散文 / 别名 / 变量引用不会命中——**产物照原样输出**
   * （作者写的名字原样写进 ERB），只是不再静默。**严重度 = warning 起步**（不猜、不纠）。
   */
  | 'function-name-unknown'
  /** 规范 §3.5：`X 不在 a 到 b` 的 `X` 含 `+`/`-`/函数调用——会整体求值两次（含 `随机(...)` 时会掷两次）；提示先赋临时变量。 */
  | 'notin-complex-operand'
  /* --- 原生直通（规范 §3.10） --- */
  | 'raw-block-inline' // 原生直通块出现在非顶层位置（如嵌在句子中间）
  /* --- 兜底 --- */
  | 'internal'; // 转译器自身异常（绝不静默；由 S2 使用）

/**
 * 单条诊断。
 *
 * 与 `ConventionIssue` 的一致性：两者都带 `(file, line, column)` 与 severity——
 * 于是"点击诊断跳转"可直接复用宿主既有的 `editor.revealLocation` 通道。
 */
export interface SugarDiagnostic {
  code: SugarDiagnosticCode;
  severity: SugarSeverity;
  /** 人读消息（中文；面向作者，不暴露内部术语） */
  message: string;
  /** 源位置（无位置信息时为 null——如整文件级约束） */
  loc: SugarPosition | null;
  /** 相关源区间（可选；高亮整段用） */
  span?: SugarSourceSpan;
}

/* ============================== 转译服务 ============================== */

/** 转译选项 */
export interface SugarTranspileOptions {
  /**
   * 源文件路径（仅用于诊断与 sourceMap 元信息；不触发任何 IO）。
   * 缺省 = 内存中的未命名文档。
   */
  filePath?: string;
  /**
   * 文件名（用于 §5.5 的文件名约定；缺省由 `filePath` 推导）。
   * 与 `filePath` 二者至少一个可推得文件名——否则 `file-not-named` 类的
   * 命名约束无法校验（S2 使用）。
   */
  fileName?: string;
}

/**
 * 语法糖转译服务（服务键 `sugar.transpile`；由 `kojo-sugar` 插件提供，S2 批建）。
 *
 * **纯函数语义**（`parse` / `transpile` / `sourceOf`）：不读文件、不写文件、
 * 不触达工程状态——输入字符串 → 输出产物。这样它才能既跑在 Node（测试）、
 * 又跑在 WebView（生产），并可在批处理里高并发调用（审阅 §四-4：单文件转译
 * 目标 <50ms）。
 *
 * `compileToFile`（S3 批）是**唯一含 IO** 的方法：转译 + 编码组装 + 写盘一体。
 * 实现方须依赖内核 io（`kernel.io`）走第一道闸，安全顺序见方法注。
 */
export interface SugarTranspileService {
  /**
   * 解析为文档模型（不转译）。失败（如编码/结构严重错误）→ 抛错；
   * "能解析但有偏离"→ 保留 AST 并把问题写进 `SugarDoc.diagnostics`（宽容但不静默）。
   */
  parse(source: string, options?: SugarTranspileOptions): SugarDoc;
  /**
   * 转译：源 → ERB 产物 + 行级源映射 + 诊断。
   * 内部等价于 `parse` → codegen；`sourceMap` 由转译过程直接产出
   * （不靠事后 diff 反推）。
   */
  transpile(source: string, options?: SugarTranspileOptions): SugarTranspileResult;
  /**
   * 由产物行号反查源位置（源映射查询；源映射缺该行 → null，
   * 例如包装函数骨架这类纯生成行）。
   */
  sourceOf(result: SugarTranspileResult, generatedLine: number): SugarPosition | null;
  /**
   * **列级反查**（S6 批；additive，两参 `sourceOf` 逐字不变）：产物 (行, 列) → 源位置。
   * 列 1 基、UTF-16 码元（口径同 `SugarPosition`）。
   * 该行有列区段时逐码元定位；列落进产物前缀 / 行尾越界 / 降糖改写区 → **就近夹紧**到
   * 相邻区段边界（仍在本产物行的映射之内，绝不跨行猜）；该行无列区段 → 退化为
   * `sourceOf` 的行级结果。纯生成行（`sourceLine === null`）→ null。
   */
  sourceColumnOf(result: SugarTranspileResult, generatedLine: number, generatedColumn: number): SugarPosition | null;
  /**
   * **正查**（S6 批；**可选能力**——旧实现方零改动）：源位置 → 产物 (行, 列)。
   * 与 `sourceColumnOf` 共用同一条 `runs` 数据的正向索引，用于往返自证与
   * "源改处高亮产物"。源位置落在无区段的降糖改写区 → null（不猜）；多候选取产物行最小者。
   */
  generatedOf?(result: SugarTranspileResult, source: SugarPosition): SugarPosition | null;
  /**
   * 编译并落盘（S3 批；**唯一含 IO 的方法**）。
   *
   * 安全顺序（复用注入器范式，**不得简化**）：
   * 1. **守卫（先于一切副作用）**：转译产 `error` 诊断 → 抛 `SugarCompileError`
   *    （不产半成品、不建目录、不备份、不写盘）；
   * 2. **组装**：产物文本 → 按 `encoding` 编码为字节（BOM + 换行 + 末尾换行）；
   * 3. **目录**：目标父目录不存在则经内核 io `ensureDir` 创建（仍过第一道闸）；
   * 4. **备份**：目标已存在时先经内核 io `backup` 入 `{appData}/backup/{hash}/`；
   * 5. **写盘**：内核 io `writeBytes`（第一道闸 `writablePaths`；越权抛
   *    `WriteNotAllowedError` **原样传播**，此时备份已做、原文件未覆盖）；
   * 6. **回读验证**：重新读字节 → 与产物字节逐字节比对，不一致抛
   *    `SugarCompileError`（**携带备份路径**）。
   *
   * @param source `.kojo` 源文本
   * @param targetPath 产物 `.erb` 目标路径（绝对路径；须在可写域内）
   * @throws `WriteNotAllowedError` 路径越权 / `SugarCompileError` 编译拒绝或回读失败
   */
  compileToFile(source: string, targetPath: string, options?: SugarCompileOptions): Promise<SugarCompileResult>;
  /**
   * 编译到**内存字节**（导出 ZIP 用；纯函数，零 IO）。
   *
   * 与 `compileToFile` 的 1+2 步（转译 → 守卫 → 按语料口径组装 BOM/换行/末尾换行）
   * **同一条代码路径**：产物字节只有一处定义，导出与保存不会各自拼一遍而漂移。
   *
   * 用途：把作者工作区里的 `.kojo` 源变成游戏认得的 `.ERB` 字节，**不落任何临时文件**。
   * 守卫同口径——转译抛错或产 `error` 诊断即抛 `SugarCompileError`，绝不返回半成品。
   *
   * @param source `.kojo` 源文本
   * @param options 转译 + 编码选项（与 `compileToFile` 同形）
   * @param targetLabel 出错时用来指认文件的人读标签（如 `包名/事件.ERB`）；缺省 `(内存)`
   */
  compileToBytes(source: string, options?: SugarCompileOptions, targetLabel?: string): SugarCompiledBytes;
  /**
   * 保存前置检查（S7 批；**纯函数**，不读盘不写盘不发事件）。
   *
   * 把"保存一颗 `.kojo`"所需的三件事一次算齐（推导目标 + 转译 + 全角空格告警），
   * 供保存 UI 在**调用落盘前**决定"能否保存 / 存到哪 / 有无排版提醒"。落盘本身
   * 仍走 `compileToFile`（S3 写链路）——本方法只做**只读前置**，把守卫前置，
   * 让 UI 拿到 `blocked` 而无需先触发 IO 副作用。
   *
   * `filePath` 缺省取 `request.sourcePath`（保证诊断里的文件名与目标推导同源）。
   *
   * @param request 源文本 + 源路径（+ 可选转译选项）
   * @returns 保存计划（`erbPath` 推导、转译结果、全角空格行号、`blocked`）
   */
  planSave(request: SugarSavePlanRequest): SugarSavePlan;
}

/* ============================== 显式类型守卫 ============================== */
/*
 * TS7 对"联合字面量属性"的判别式 narrow 不可靠（项目教训，IMPLEMENTATION-LOG §九-10）：
 * 即便写了 `if (v.kind === 'variable' || v.kind === 'character') return;`，
 * 后续代码也可能不把该变体排除。凡需要"组合判定"的地方一律走显式守卫——
 * 下述函数即契约层对外的标准判定入口（S2 / UI / linter 共用同一套语义）。
 */

/** 文本行 */
export function isTextLine(node: SugarNode): node is TextLine {
  return node.kind === 'textLine';
}

/** 心形行 */
export function isHeartLine(node: SugarNode): node is HeartLine {
  return node.kind === 'heartLine';
}

/** 值插值（`{表达式}`）；不含行内条件 */
export function isValueInterpolation(node: Interpolation): boolean {
  return node.form === 'expr';
}

/** 行内条件插值（`{条件 ? A : B}`） */
export function isConditionalInterpolation(node: Interpolation): node is Interpolation & { form: 'cond' } {
  return node.form === 'cond';
}

/** 变量别名（可读可写） */
export function isVariableAlias(value: AliasValue): value is Extract<AliasValue, { kind: 'variable' }> {
  return value.kind === 'variable';
}

/** 角色别名（只读） */
export function isCharacterAlias(value: AliasValue): value is Extract<AliasValue, { kind: 'character' }> {
  return value.kind === 'character';
}

/** 数值字面量别名（只读） */
export function isNumberAlias(value: AliasValue): value is Extract<AliasValue, { kind: 'number' }> {
  return value.kind === 'number';
}

/** 字符串字面量别名（只读） */
export function isStringAlias(value: AliasValue): value is Extract<AliasValue, { kind: 'string' }> {
  return value.kind === 'string';
}

/** 条件表达式别名（只读；右值展开为行内条件 `\@…\@`） */
export function isConditionalAlias(value: AliasValue): value is Extract<AliasValue, { kind: 'conditional' }> {
  return value.kind === 'conditional';
}

/**
 * 只读别名判定 —— **唯一的只读性真源**（消费者不要各自写 if 链）。
 *
 * 只读 = 角色引用 / 数值字面量 / 字符串字面量 / 条件表达式四种（规范 §3.1 表）。
 * 只有变量别名可作赋值左值。
 */
export function isReadonlyAlias(value: AliasValue): boolean {
  return value.kind !== 'variable';
}

/**
 * 别名可否作赋值左值。
 * 与 `!isReadonlyAlias` 等价——保留两个方向的名字，让调用点自解释
 * （判"能否写"比判"是否只读"在 lint 规则里更常见）。
 */
export function isWritableAlias(value: AliasValue): boolean {
  return value.kind === 'variable';
}

/** 表达式位置节点（赋值位置的 如果 / 当） */
export function isExprNode(node: SugarNode): node is SugarExprNode {
  return node.kind === 'ifExpr' || node.kind === 'whenExpr';
}

/** 原生直通（行或块） */
export function isRawNode(node: SugarNode): node is RawLine | RawFunctionBlock {
  return node.kind === 'rawLine' || node.kind === 'rawFunctionBlock';
}

/** 文档级节点（别名声明 / 时机块 / 自定指令块 / 用户函数块） */
export function isTopLevelNode(node: SugarTopLevelNode): boolean {
  return (
    node.kind === 'aliasDecl' ||
    node.kind === 'timingBlock' ||
    node.kind === 'custom-command' ||
    node.kind === 'functionBlock'
  );
}

/* ============================== 预览（S4 批） ============================== */

/**
 * 预览请求 —— 「拿着这份糖源码，在**这份存档状态**下，会走到哪、说什么」。
 *
 * 数据层契约：不含任何 UI 表达（渲染留给消费方）；所有字段都是可序列化的
 * 纯数据，便于测试与跨进程传递（WebView ↔ Rust 侧）。
 */
export interface SugarPreviewRequest {
  /** `.kojo` 源文本（内存态；预览**不读盘**） */
  source: string;
  /** 源文件路径（诊断与源映射元信息；缺省 = 未命名文档） */
  filePath?: string;
  /** 文件名（§5.5 命名约定校验用；缺省由 `filePath` 推导） */
  fileName?: string;
  /**
   * 存档归档路径（`sav*` / 容器）；**缺省 = 无状态预览**——
   * 此时 `archive` 为 null、所有回放字段缺席，但三向映射的
   * 「糖行 ↔ ERB 行」两向仍完整可用（编辑器高亮/跳转不需要存档）。
   */
  archivePath?: string;
  /**
   * 被回放角色的 CSV 编号；缺省时**从糖源码头部 `角色:` 推导**
   * （`frontMatter.charNo`）——作者写 `角色: 12` 就不必再传一次。
   */
  characterNo?: number;
  /** 函数回放的调用上下文（ARG/ARGS 注入；缺省 = 一律 unknown） */
  callContext?: ReplayCallContext;
}

/**
 * 消息块 —— 「一段会实际输出的文本」及其产物行区间。
 *
 * v1 粒度 = **产物语句块**（一条 `PRINTFORM*` / `CALL HPH_PRINT` / 一次
 * 条件分支体）：足够支撑"点糖源码某行 → 高亮产物区间 + 显示该状态下的
 * 可达性"。逐字符的最终渲染串（含变量展开）不在本层——那需要 FORM
 * 求值（`%…%` / `{}` / `\@…\@` 展开），留待后续批（与规范 §9 的第 4 条
 * 实测同批），本层只给**结构可达性 + 谓词三值结果**。
 */
export interface SugarPreviewMessageBlock {
  /** 该块在产物 ERB 中的起止行（1 基，闭区间） */
  fromLine: number;
  toLine: number;
  /**
   * 块的**直接**文本内容（产物原文，未做 FORM 展开）。
   * 纯结构行（`IF` / `ELSE` / `ENDSELECT` / `LOCAL = 1` 等）不单独成块——
   * 它们作为 `guards` / 行区间折进所属块。
   */
  text: string;
  /**
   * 该块属于哪个产物函数（`FunctionReplay.normalizedName`，如
   * `M_KOJO_MESSAGE_COM_K12_310_1`）；仅当回放可用且有函数覆盖该行时有值。
   */
  functionName?: string;
  /**
   * 覆盖该块的**分支链**走向（来自 `FunctionReplay.branches`，按行区间
   * 相交匹配）。空数组 = 该块不在任何条件分支内（无条件输出）。
   */
  branches: BranchChainOutcome[];
  /**
   * 该块的可达性（由覆盖它的分支链折叠而来）：
   * - `reachable`：无条件，或所覆盖链均 `taken` 且命中本块所在分支；
   * - `unreachable`：存在某条覆盖链确定没走到本块所在分支；
   * - `unknown`：存在 unknown 条件且前序未定（无法判定）。
   */
  reachability: PreviewReachability;
  /** `reachability === 'unknown'` 时的原因（取首个阻断链的原因） */
  unknown?: ReplayUnknown;
}

/** 块可达性三档（与 `FunctionReplay.confidence` 同精神：不确定就显式标） */
export type PreviewReachability = 'reachable' | 'unreachable' | 'unknown';

/**
 * 三向映射的一行 —— 糖源码行 → 生成产物行 → 回放消息块。
 *
 * **为什么是"糖行索引"而不是"产物行索引"**：编辑器的锚点在糖源码
 * （作者看的就是它），跳转/高亮/悬浮都以糖行为主键；产物行与消息块是
 * 附着信息。故 `lines` 按糖源行升序，`generatedLines` 可空（纯糖语法行
 * ——如 `时机 …：` 块头——在产物里对应的是函数骨架，没有逐行对应）。
 */
export interface SugarPreviewLine {
  /** 糖源码行号（1 基） */
  sourceLine: number;
  /** 该源行的原文（去行尾换行；便于 UI 直接渲染气泡，不必回读源） */
  sourceText: string;
  /**
   * 该源行生成的产物行号列表（升序；由转译源映射反查）。
   * **空数组 = 纯糖语法行**（不给糖行硬塞产物行——那才是伪造映射）。
   */
  generatedLines: number[];
  /** 该源行产出的消息块（按 fromLine 升序）；非文本行多为空数组 */
  messageBlocks: SugarPreviewMessageBlock[];
}

/**
 * 预览结果（结构性；`archive` 为 null 时回放字段全部缺席）。
 */
export interface SugarPreviewResult {
  /**
   * 转译产物（**未落盘**；与 `transpile` 逐字节一致）。预览永不写盘——
   * 落盘是 `compileToFile` 的职责（S3），预览只读。
   */
  transpile: SugarTranspileResult;
  /** 三向映射（按糖源行升序；行数 = 源文件行数） */
  lines: SugarPreviewLine[];
  /**
   * 结构行（产物中不承载文本、但决定控制流的行）——`IF` / `ELSE` /
   * `ELSEIF` / `ENDIF` / `SELECTCASE` / `CASE` / `CASEELSE` / `ENDSELECT` /
   * 包装骨架 / `LOCAL = n`。单独列出，供 UI 画"折叠括号"或过滤。
   */
  structuralLines: number[];
  /**
   * 回放上下文；**null = 无状态预览**（未传 `archivePath`，或存档解析
   * 失败、回放服务缺席——`archive.reason` 说明是哪一种）。
   * **显式降级，不抛错**：预览是只读观察面，"没有状态"是合法输入。
   */
  archive: SugarPreviewArchive | null;
}

/** 预览的回放侧上下文（有存档且回放成功时） */
export interface SugarPreviewArchive {
  /** 存档归档路径 */
  archivePath: string;
  /** 被回放角色的 CSV 编号 */
  characterNo: number;
  /** 角色显示名（不可读时 null） */
  characterName: string | null;
  /**
   * 产物函数的回放结果（按产物行升序；每项 `null` = 该函数不在
   * 索引中——如 `M_KOJO_COLOR_*` 这类无谓词的骨架函数会被回放器
   * 返回 total=0 的结果，不在索引里才是 null）。
   */
  functions: SugarPreviewFunctionReplay[];
}

/** 单函数的回放摘要（预览视角的精简投影；完整结果见 `FunctionReplay`） */
export interface SugarPreviewFunctionReplay {
  functionName: string;
  /**
   * 该函数在产物 ERB 中的行区间（1 基，闭区间）。
   * 由产物文本扫描 `@函数名` 得出——**不复用回放器的 `startLine`**
   * （那是磁盘文件的行号，与本预览的内存产物不同源）。
   */
  fromLine: number;
  toLine: number;
  /** 回放结果；null = 索引中无此函数 */
  replay: FunctionReplay | null;
}

/**
 * 无状态预览的原因（**闭集**，命名零游戏名词）。
 *
 * 之所以要分类而不是一个布尔：UI 需要区分"作者没给存档"（正常）与
 * "存档坏了/回放服务没装"（要提示），二者对作者的处置完全不同。
 */
export type SugarPreviewDegradeReason =
  /** 请求未提供 `archivePath`（正常路径：纯糖预览） */
  | 'no-archive-requested'
  /** 糖源码未声明 `角色:`，且请求未给 `characterNo`（无法定位角色） */
  | 'no-character'
  /** `state.replay` 服务缺席（插件未激活 / 依赖不满足） */
  | 'replay-service-unavailable'
  /** 存档解析失败（文件不存在 / 格式不符 / 角色不在快照） */
  | 'archive-unreadable'
  /** 回放过程抛错（引擎侧异常；已捕获并降级） */
  | 'replay-failed';

/**
 * 语法糖预览服务（服务键 `sugar.preview`；S4 批）。
 *
 * **职责边界（本批只做数据层）**：
 * - 输入糖源码 → `transpile`（**复用**，不重实现）→ 得产物 + 源映射；
 * - 产物函数名 → **复用 `state.replay`** 回放（不新建模拟器）；
 * - 折成三向映射「糖行 ↔ ERB 行 ↔ 消息块」。
 *
 * **事件纪律**（S3 已落 `file.changed` payload 契约）：本服务**只消费**
 * 事件（缓存失效等），**绝不发射**——预览是观察者，不是变更源。
 *
 * **失败语义**：转译产 `error` 诊断时**不抛错**——`transpile.diagnostics`
 * 原样带出，`lines` 仍按源行骨架给出（编辑器照常画诊断标记）；
 * 回放侧一律**结构化降级**（`archive: null` + `reason`）。
 * 只有"输入本身不合法"（如 `source` 非字符串）才抛错。
 *
 * **坐标契约**：`lines[].generatedLines` / `messageBlocks[].fromLine` 以及
 * `archive.functions[].fromLine` 全部以**本次产物的行号**（1 基）为坐标系。
 * 实现方须保证回放侧的行号与之同源（详见 `kojo-sugar/src/preview.ts` 头注）
 * ——否则"ERB 行 ↔ 消息块"这一向会错位（本批已知边界）。
 */
export interface SugarPreviewService {
  /**
   * 生成预览：糖源码 → 转译 → （可选）状态回放 → 三向映射。
   *
   * 异步原因（**只有回放侧是异步**）：`state.replay` 的 `createView` /
   * `replayFunction` 是 Promise（要读存档二进制）；转译本身是同步纯函数。
   *
   * 不写盘、不发射事件、不修改任何插件状态（可安全并发调用）。
   */
  preview(request: SugarPreviewRequest): Promise<SugarPreviewResult>;
}

/** 消息块是否可达 */
export function isReachableBlock(block: SugarPreviewMessageBlock): boolean {
  return block.reachability === 'reachable';
}

/** 某糖源行是否有产物（纯糖语法行 = false） */
export function hasGenerated(line: SugarPreviewLine): boolean {
  return line.generatedLines.length > 0;
}

/** 预览是否带状态（有存档且回放成功） */
export function hasArchive(result: SugarPreviewResult): result is SugarPreviewResult & { archive: SugarPreviewArchive } {
  return result.archive !== null;
}

/* ============================== 提升建议（S5 批） ============================== */

/**
 * 糖提升建议（lift-suggester）—— **原生 ERB → 糖候选**，与降糖方向相反。
 *
 * 设计前提（`docs/archive/LIFT-SUGGESTER-DESIGN.md` §1，源自 `SYNTAX-SUGAR-DESIGN.md` §八）：
 * 编译是**有损**的（同一个 ERB 片段可能有多种合理糖写法），故升糖**永不自动应用**，
 * 只出建议、逐条确认。识别的安全前提不是"看起来像"，而是**"转回去逐字节一样"**：
 * 每个候选的 `sugarSource` 都交给 `sugar.transpile` 跑一遍，产物与原文本区间
 * **逐字节一致**才算成立；不一致一律**降级为不建议**（宁可漏报，不可错报）。
 *
 * 该自证让"误报"在结构上不可能：**未通过 round-trip 的候选根本不在结果里**。
 */

/**
 * 糖类型（v1 四类，对应规范 §3 的四组糖）。
 *
 * 注意与 `SugarNode.kind` 是不同维度：这里是"**候选是什么糖**"，
 * `sugarSource` 才是那个糖的源码片段。
 */
export type SugarLiftKind =
  /** PRINT 家族消息行（`PRINTFORM{W,L,DW,DL} …`）→ 糖文本行（规范 §3.3 / §5.1） */
  | 'print-message'
  /** `IF … ENDIF` 块 → `如果 / 否则如果 / 否则`（规范 §3.5） */
  | 'if-block'
  /** `SELECTCASE … ENDSELECT` 分派 → `当 / 是 / 否则`（规范 §3.6） */
  | 'selectcase'
  /** 重复出现的变量引用 → `别名` 声明建议（规范 §3.1 / §5.0） */
  | 'alias';

/**
 * 候选置信度 —— **v1 闭集只有一档**（`verified` = round-trip 逐字节一致）。
 *
 * 之所以不设"可能对"的低档：契约层不允许出现"未经自证"的候选（设计稿 §4.1）。
 * 未来若确需降档，必须同时改本节注释与此处的测试——**默认的"宁可漏报"不可被
 * 悄悄放宽**。
 */
export type SugarLiftConfidence = 'verified';

/**
 * round-trip 证据 —— "为什么这个候选可以被信任"的**显式**凭据。
 *
 * 消费方（UI 的"逐条确认"流）不需要读实现就知道候选的合法性来源：
 * 把 `sugarSource` 交给 `sugar.transpile` 再比对，即得本对象。
 */
export interface SugarLiftRoundTrip {
  /** 是否逐字节一致。**v1 结果里恒为 true**（false 的候选已被丢弃）。 */
  verified: boolean;
  /** 原文本区间（源行去行尾换行，按 `\n` 连接） */
  originalText: string;
  /** 糖片段转译回来的文本（已去掉自证壳的基准缩进） */
  generatedText: string;
  /**
   * 首个差异位置（1 基行 / 列）。
   * `verified: true` 时缺省；保留此字段供未来低置信档与调试使用
   * ——v1 的 `candidates` 里不会出现带本字段的项。
   */
  firstDiff?: SugarPosition;
}

/**
 * 糖候选 —— 一段"可以写成糖"的原生 ERB 及其建议糖源码。
 *
 * **区间语义**：`fromLine..toLine` 是**闭区间**（1 基），指代原文中**被替换**的整段。
 * 例外见 `alias`：其 `fromLine === toLine` 且指向**建议插入点**（首次出现行），
 * `sugarSource` 是要加到**文件头**的声明行——消费方须按 `kind === 'alias'` 分支处理。
 */
export interface SugarLiftCandidate {
  kind: SugarLiftKind;
  /** 源 ERB 闭区间起点（1 基） */
  fromLine: number;
  /** 源 ERB 闭区间终点（1 基） */
  toLine: number;
  /**
   * 建议的糖源码片段（**多行时以 `\n` 分隔**；不含外层缩进基准，
   * 缩进由消费方按所在位置平移）。首行不带前导空白，后续行携带相对缩进。
   */
  sugarSource: string;
  /** 置信度（v1 恒 `verified`） */
  confidence: SugarLiftConfidence;
  /**
   * 该候选成立所依赖的**旁白口径**（spec §3.1 `旁白色:` 头部开关）。
   *
   * **为什么候选要带这个**：糖层对"无引号文本"的 `D` 归属由头部开关决定——
   * `默认` → `PRINTFORMDW/L`；`作者色` → `PRINTFORMW/L`。故同一段糖片段在两种
   * 口径下产出的 ERB 不同，自证必须逐个试（见 `lift.ts`）。命中口径记在这里：
   * `默认` 时消费方**无需**改动文件头；`作者色` 时**应用候选必须把 `旁白色: 作者色`
   * 写入文件头**，否则产出的 ERB 会与原文不一致（自证的成立条件被破坏）。
   *
   * `kind === 'alias'` 的候选项不涉及文本输出，此字段可缺省。
   */
  narrationColor?: '默认' | '作者色';
  /** round-trip 证据（见 `SugarLiftRoundTrip`） */
  roundTrip: SugarLiftRoundTrip;
  /** 人读说明（中文；面向作者，不暴露内部术语） */
  reason: string;
}

/**
 * 未产出候选的原因（**闭集**；命名零游戏名词）。
 *
 * **不静默**是内核铁律的一部分：每一处"看到了但不建议"都必须在 `skipped` 里
 * 可见，否则作者会以为工具漏看（而实际是我们判定它不能安全升糖）。
 */
export type SugarLiftSkipReason =
  /** PRINT 变体无糖形态（`PRINTFORM` / `PRINTFORMD` 的不换行不等待、`PRINTL` / `PRINT` / `PRINTD` 等非 FORM 系） */
  | 'unsupported-print-variant'
  /** 条件表达式**整体不可解析**（`condition-extractor` 的 `opaque` 信号）→ 无法回写糖条件 */
  | 'unparsable-condition'
  /** 块内含糖未覆盖的控制流（`SIF` / `FOR` / `WHILE` / `REPEAT` / `DO` / TRY 系 / PRINTDATA 系 等） */
  | 'unsupported-control-flow'
  /** 含 `$标签` / `GOTO`（糖产物不生成标签，无法逐字节还原） */
  | 'label-or-goto'
  /** 含 `#` 预处理行 / `@` 函数边界（穿越函数或进入指令区） */
  | 'macro-or-directive'
  /** 同一缩进层的文本域（PRINT 系）与逻辑域（赋值/控制流）**混行**，无法构成单一糖节点 */
  | 'mixed-domain-line'
  /** 块内注释 / 空行打断连段（无法构成单一糖节点，且原样保留会破坏 round-trip） */
  | 'comment-interference'
  /** **round-trip 逐字节不一致** → 降级（设计稿 §3.2；宁可漏报） */
  | 'roundtrip-mismatch'
  /** 糖片段转译自身产 `error` 诊断（生成器给了非法糖）→ 丢弃 */
  | 'transpile-error'
  /** 形态不在 v1 四类糖之内（`PRINTBUTTON` / `SETCOLOR` / `CALL HPH_PRINT` / 随机组 等） */
  | 'not-covered';

/** 被跳过的区间（**显式**记录，不静默） */
export interface SugarLiftSkip {
  /** 源 ERB 闭区间起点（1 基） */
  fromLine: number;
  /** 源 ERB 闭区间终点（1 基） */
  toLine: number;
  reason: SugarLiftSkipReason;
  /** 人读说明（中文；可含该区间的首行摘要，便于作者定位） */
  message: string;
}

/**
 * 提升建议请求 —— 对**一段原生 ERB 文本**做升糖分析。
 *
 * 纯数据、不含 UI 表达；`source` 是内存态文本，本服务**不读盘**
 * （与服务面"纯函数"纪律一致）。`characterNo` / `timingFace` / `timingIndex`
 * 仅用于拼装 round-trip 自证所需的**最小 `.kojo`**——它们不影响识别结果本身
 * （自证只看形态是否一致），缺省时用占位值即可。
 */
export interface SugarLiftRequest {
  /** 待分析的原生 ERB 文本（内存态；不读盘） */
  source: string;
  /** 源文件路径（诊断元信息；不触发 IO） */
  filePath?: string;
  /** 角色号（拼装自证样例用；缺省从文本内的 `_K{n}` 反推，仍不得则用占位 `0`） */
  characterNo?: number;
  /** 时机分野（自证样例块头用；缺省 `指令`） */
  timingFace?: string;
  /** 时机编号（同上；缺省 `1`） */
  timingIndex?: string;
}

/** 提升建议结果 */
export interface SugarLiftResult {
  /** 候选（按 `fromLine` 升序；全部已通过 round-trip 自证） */
  candidates: SugarLiftCandidate[];
  /** 被跳过的区间（按 `fromLine` 升序；**显式**，不静默） */
  skipped: SugarLiftSkip[];
  /**
   * 本次分析是否发生了**能力降级**——即"条件可解析性"这一判据不可用
   * （`condition.extractor` 服务缺席 / 解析抛错）。
   * true 时分析仍继续（结构判据不受影响），但 `unparsable-condition`
   * 这类跳过不会被检出；消费方应据此提示"建议质量下降"。
   */
  degraded: boolean;
}

/**
 * 语法糖提升建议服务（服务键 `sugar.lift`；S5 批）。
 *
 * **职责边界**：
 * - 输入原生 ERB → 扫描四类糖形态 → 组装糖片段 → **复用 `sugar.transpile`** round-trip 自证；
 * - **不写盘**（应用建议是 UI 批的职责）、**不发事件**（只读观察面）、不修改任何插件状态；
 * - 不产候选的每一处都在 `skipped` 里可见。
 *
 * **同步**：与 `preview` 不同，升糖**不需要回放**——全链路是同步纯函数
 * （转译本身同步），故本方法返回结果而非 Promise。
 */
export interface SugarLiftService {
  /**
   * 生成提升建议。
   *
   * 只有"输入本身不合法"（`source` 非字符串）才抛错；其余一律以
   * `candidates` / `skipped` 表达（含转译器内部异常 → `transpile-error` 跳过）。
   */
  liftSuggest(request: SugarLiftRequest): SugarLiftResult;

  /**
   * 生成**整文件糖投影**（B 层；见本文件末「升糖投影」节）。
   *
   * 与 `liftSuggest` 的分工：后者是"哪些片段能安全写回 `.kojo`"（强自证，宁可漏报）；
   * 本方法是"整份 ERB 显示成糖以后长什么样"（逐行局部映射，一行失败只影响那一行）。
   * 两者**并存**，`liftSuggest` 的行为不受本方法影响。
   *
   * 只有"输入本身不合法"（`source` 非字符串）才抛错。
   */
  liftProject(request: SugarProjectRequest): SugarProjectResult;
}

/** 候选是否已通过 round-trip 自证（v1 恒 true；守卫留作未来低置信档的兼容位） */
export function isVerifiedCandidate(candidate: SugarLiftCandidate): boolean {
  return candidate.confidence === 'verified' && candidate.roundTrip.verified;
}

/** 结果是否有候选 */
export function hasCandidates(result: SugarLiftResult): boolean {
  return result.candidates.length > 0;
}


/* ============================== 升糖投影（B 层） ============================== */

/**
 * 升糖**投影** —— 原生 ERB → 糖显示（**只用于看**，零写盘）。
 *
 * ## 与「提升建议」（`liftSuggest`）的分工
 *
 * `liftSuggest` 问的是"这段 ERB 能不能被**安全地**改写成糖、写回 `.kojo`"——
 * 它的自证是"转译回去逐字节一致"，为写盘安全设计，宁可漏报。
 *
 * 本投影问的是另一件事："这份 ERB **显示成糖**以后长什么样"。显示对不上没有代价
 * （展开仍能看到原文），所以判据从"整段自证"换成**逐行局部映射**：
 *
 * - 映射规则表**封闭且逐条可审计**（`IF X` → `如果 X：` 是 1:1 语法映射，不需要"证明"）；
 * - **一行失败只影响那一行**——该行原样保留为 ERB（fail-visible），不向上传播；
 * - 映射不上的行**显式**计入 `stats.nativeByReason`（不静默）。
 *
 * 依据：`docs/archive/LIFT-REMEASURE-2026-10-12.md` §7.1。
 *
 * ## 语义边界
 *
 * - 输出是**投影**不是等价改写：不承诺能写回、不承诺 round-trip；
 * - 不读盘 / 不写盘 / 不发事件（与 `preview` / `liftSuggest` 同款只读纪律）；
 * - 契约层零游戏知识、零 Monaco 概念（渲染由 app 壳落地）。
 */

/**
 * 投影中的一行有四种落点（**内部口径**，不单独建模为类型——UI 只消费整份 `text` 与
 * `stats`）：
 *
 * - `speech`：台词/旁白文本行（`PRINTFORM{W,L,DW,DL} …` → 糖文本行，`L` 后缀补 ` 续`）；
 * - `control`：糖覆盖的控制流行（`IF X` → `如果 X：` 等；`ENDIF`/`ENDSELECT` 收束不显示）；
 * - `passthrough`：注释 / 空行——糖表层语法与 ERB 完全一致，原样透传；
 * - `native`：不在糖覆盖范围内的行——**原样保留为 ERB**（fail-visible）。
 */

/**
 * "这一行为什么保留原生写法"（**闭集**；命名零游戏名词）。
 *
 * 与 `SugarLiftSkipReason` 不同：那是"候选级"的拒绝原因（强自证口径），
 * 本枚举是"行级"的透出口径（投影口径）。
 */
export type SugarProjectNativeReason =
  /**
   * PRINT 家族里**不是"读者要读的文本"**的行：按钮 / 排版类变体
   * （`PRINTBUTTON` `PRINTLC` `PRINTS` `PRINTPLAIN*` `PRINTV` `PRINTFORMK*`…）、
   * 无换行变体的空体（`PRINT` / `PRINTFORM` 空体既不输出也不换行）、
   * 以及指令后直接跟 `;` 注释的写法。
   * （`PRINTL` / `PRINTW` / `PRINTDL` / `PRINTDW` / `PRINT` / `PRINTD` / `PRINTFORM*`
   * 的文本体**已投影为文本行**——批 F；`PRINTDATA` 系是块开词，归 `unsupported-control-flow`。）
   */
  | 'unsupported-print-variant'
  /** **FORM 行**（`PRINTFORM*`）的行内条件 `\@cond?A#B\@` **解析不了**时才保留原生
   *（批 G 起默认投影为糖三元 `{cond ? "A" : "B"}`；不配对 / 缺 `?` 或 `#` / 空条件 → 整行不猜）。
   * 非 FORM 行里的 `\@` 是被打印的字面字符，不受本因影响 */
  | 'inline-condition'
  /** 糖未覆盖的控制流（循环 / TRY 系 / PRINTDATA 系 / `$标签` / `GOTO` 等，
   * 以及**批 H 判据不满足的 `SIF`**——正文不是"恰好一条语句"时整行不动） */
  | 'unsupported-control-flow'
  /** 落在数据表体（PRINTDATA 系）或 `[SKIPSTART]…[SKIPEND]` 区内——不是可显示的语句 */
  | 'data-or-skip'
  /** 其余（赋值、调用、`#` / `@` 指令行等） */
  | 'other';

/** 投影统计（UI 用来回答"这个文件里哪些行没被升糖、为什么"——不静默） */
export interface SugarProjectStats {
  /** 源文件总行数 */
  totalLines: number;
  /**
   * **被糖投影覆盖**的源行数：台词/旁白行 + 糖覆盖的控制流行。
   *
   * 含 `ENDIF` / `ENDSELECT` 这类**不产出可见行**的收束行——它们被缩进语义吸收，
   * 仍属于"被糖覆盖"。这条口径的收益是一条可断言的不变量：
   * `projectedLines + passthroughLines + nativeLines === totalLines`
   * （每一行都必须落在三类之一，**没有行会凭空消失**）。
   */
  projectedLines: number;
  /** 原样透传的注释 / 空行数 */
  passthroughLines: number;
  /** 保留原生写法的行数 */
  nativeLines: number;
  /** 保留原生写法的**分因**计数（按 count 降序；空因不列出） */
  nativeByReason: { reason: SugarProjectNativeReason; count: number }[];
}

/** 糖投影请求（纯数据；`source` 是内存态文本，本服务不读盘） */
export interface SugarProjectRequest {
  /** 待投影的原生 ERB 文本（内存态；不读盘） */
  source: string;
  /** 源文件路径（诊断元信息；不触发 IO） */
  filePath?: string;
}

/**
 * 投影出的**连续可映射段**（消费方把它落成编辑器里的一个就地视图）。
 *
 * ## 为什么是"段"而不是整份 `text`
 *
 * 宿主（Monaco）插入就地视图用的是 ViewZone——它要的正是**区间 + 该区间的替换文本**
 * 这两样东西：区间用来折叠原文，文本用来显示糖。整份 `text` 答不出"哪几行被替换了"，
 * 宿主拿到它还得自己再切一遍（重复实现同一套分段规则）。
 *
 * 段数组是区间与文本的**唯一真源**：把段按 `fromLine` 排好，段与段之间的行即
 * "原样保留"的行——不需要第二份全文。
 *
 * 不变量：段**按 `fromLine` 升序**且**互不重叠**（相邻段之间至少隔一行原生行）。
 */
export interface SugarProjectSegment {
  /** 源区间起点（1 基，含） */
  fromLine: number;
  /** 源区间终点（1 基，含）——含收束行（`ENDIF` 不产出可见行，但占区间） */
  toLine: number;
  /**
   * 该段的糖写法（多行，`\n` 分隔；缩进已归一为 TAB）。
   *
   * 缩进以**段内可见行的最小层为基准 0**：段是就地插入的独立视图，不继承源文件
   * 的外层缩进（否则插到原文区间上方会莫名其妙地右移）。
   */
  sugarText: string;
  /** 糖写法的可见行数（= `sugarText` 的行数；宿主算 ViewZone 高度用） */
  lineCount: number;
}

/** 糖投影结果 */
export interface SugarProjectResult {
  /** 连续可映射段（升序、互不重叠；见 `SugarProjectSegment`） */
  segments: SugarProjectSegment[];
  /** 统计（回答"这个文件里哪些行没被升糖、为什么"——不静默） */
  stats: SugarProjectStats;
}


/* ============================== 升糖应用（S5-UI 批） ============================== */

/**
 * 升糖应用 —— 「把选中的候选写回 `.kojo` 源文件」的**结果预览**。
 *
 * ## 为什么应用是"源文本 → 源文本"而不是"ERB → ERB"
 *
 * 升糖的产物是**糖源码**（`.kojo`），不是 ERB。候选只在**糖层**成立
 * （`sugarSource` 落在 `.kojo` 里），所以"应用" = 把源 `.kojo` 里对应
 * 的那段原生 ERB 换成糖写法。落盘走的仍是 `.kojo` 源文件，**产物 ERB 由
 * 后续的 `compileToFile` 负责**——本服务不产 ERB。
 *
 * 这保证了 round-trip 不变量在应用后**仍然成立**：应用后源文件再编译一次，
 * 产物应与应用前的 ERB 语义等价（这正是自证所断言的性质）。
 *
 * ## 顺序：**倒序替换**（从后往前）
 *
 * 候选按 `fromLine` 升序排列，但替换必须**从最大行号开始**——否则先替换的
 * 候选会改变后一个候选的行号，导致错位。这是本服务唯一的"顺序敏感"点，
 * 实现里有显式断言（见 `lift-apply.ts`）。
 */
export interface SugarLiftApplyPreview {
  /** 应用后的 `.kojo` 全文 */
  text: string;
  /**
   * 行级差量（按 `fromLine` 升序）。
   * 供 UI 的 diff 视图消费；不产候选 / 被忽略的区间**不在**此表内。
   */
  hunks: SugarLiftDiffHunk[];
  /** 实际被替换的候选数（= 请求里通过校验收到的候选数） */
  appliedCount: number;
  /**
   * 本次应用是否**改动了文件头**（写入了 `旁白色: 作者色` 声明行）。
   * 供 UI 提示"文件头已变更"——某些作者对此敏感。
   */
  frontMatterChanged: boolean;
}

/**
 * 行级差量（一行替换 = 一个 hunk；v1 不做多行合并）。
 *
 * 之所以不引入通用 diff 库：升糖的差量**结构已知**（每条候选替换一个已知闭区间），
 * 不需要"求最短编辑脚本"；把已知的东西再猜一遍只会引入不确定性。
 * 通用 diff 留给未来"应用后再验证"的批次（那时才需要真比对）。
 */
export interface SugarLiftDiffHunk {
  /** 源 `.kojo` 中的闭区间（1 基；替换前的位置） */
  fromLine: number;
  /** 源 `.kojo` 中的闭区间终点（1 基） */
  toLine: number;
  /** 被替换掉的原行（去行尾换行） */
  removed: string[];
  /** 替换进来的糖源码行（去外层基准缩进后的相对形态） */
  added: string[];
}

/**
 * 升糖应用请求 —— 对**一段 `.kojo` 源文本**应用若干候选。
 *
 * 纯数据；`source` 是内存态文本，本服务**不读盘**（写盘走 `applyToFile`）。
 */
export interface SugarLiftApplyRequest {
  /** 待修改的 `.kojo` 源文本（内存态） */
  source: string;
  /**
   * 要应用的候选（**必须来自同一份 `source` 的 `liftSuggest` 结果**）。
   *
   * 校验是**严格**的：区间越界 / 候选之间的相对顺序与前文不匹配（源自不同
   * 版本的扫描结果）→ 抛错，不静默跳过。理由是"应用错行"的代价远高于"拒绝"。
   */
  candidates: readonly SugarLiftCandidate[];
  /**
   * 候选所在位置的**缩进基准**（tab 数）。
   *
   * `sugarSource` 首行不带前导空白（契约如此），后续行携带相对缩进；实际
   * 写入时必须按候选在源文件中的**真实缩进层**平移。缺省 = 从被替换区间的
   * **首行**推导（这是绝大多数情况下的正确值，因为候选区间不以空白开头）。
   */
  indentBase?: number;
}

/**
 * 升糖应用结果（`applyToFile` 落盘后返回）。
 *
 * **与 `SugarCompileResult` 同构**：`backupPath` / `byteSize` 语义一致
 * （写前备份 + 回读验证字节数），便于消费方用同一套提示。
 */
export interface SugarLiftApplyResult {
  /** 写入的 `.kojo` 源文件路径（绝对路径） */
  sourcePath: string;
  /** 写盘总字节数（含 BOM / 换行） */
  byteSize: number;
  /** 写前备份路径（目标原文件不存在时为 null） */
  backupPath: string | null;
  /** 实际应用的候选数 */
  appliedCount: number;
  /** 应用预览（同 `SugarLiftApplyPreview`；供落盘后回显 diff） */
  preview: SugarLiftApplyPreview;
}

/**
 * 升糖应用服务（服务键 `sugar.liftApply`；S5-UI 批）。
 *
 * **职责边界**：
 * - `apply(request)`：**纯函数**（内存态文本 → 内存态文本 + diff），不读不写；
 * - `applyToFile(source, path, request)`：走**与 `compileToFile` 完全同款**的
 *   写链路（编码组装 → 目录 → 备份 → 内核 io 写盘〔第一道闸 `writablePaths`〕
 *   → 回读验证），**不绕过任何一闸**；成功后由实现方发 `file.changed`。
 *
 * 为什么把"应用"单独做一个服务键而不是塞进 `sugar.lift`：`sugar.lift` 是
 * **只读观察面**（不读盘不写盘不发事件，契约已承诺）；写能力必须显式声明，
 * 否则"哪些插件能写盘"就不再可审计。**能力面 = 服务键面**。
 */
export interface SugarLiftApplyService {
  /** 应用候选到内存态源文本（纯函数；不同步落盘） */
  apply(request: SugarLiftApplyRequest): SugarLiftApplyPreview;
  /**
   * 应用候选并落盘（同 `compileToFile` 写链路；成功发 `file.changed`）。
   *
   * @throws SugarApplyError 校验失败 / 编码失败 / 越权（`WriteNotAllowedError`
   *   原样传播）/ 回读不一致 —— 错误消息必带备份位置（若已备份）。
   */
  applyToFile(sourcePath: string, request: SugarLiftApplyRequest): Promise<SugarLiftApplyResult>;
}
