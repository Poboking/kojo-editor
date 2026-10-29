/**
 * Kojo 2.0 词法层的**类型与词表单源**（本文件零运行时依赖，只有常量与类型）。
 *
 * 口径（设计稿 §2.4 / §4.13 / §10.4 / §10.7）：
 * - 源事实（BOM / CRLF / LF / 混合 EOL）**只记录不归一化**：编码与换行的保真是 Unit 的事，
 *   本层把事实原样交给宿主，保存时不许"顺手统一"；
 * - 物理行 → 逻辑行**一对一**：2.0 行尾 `续` 是等待三态之一，不是折行（§2.4 表），
 *   因此这里没有 1.0 的"折行段"概念；行的物理行号 = 逻辑行号，折回物理行列是恒等映射；
 * - 缩进**计数**不锚全文正则：缩进列宽 = 空格 1 / Tab 按 4 计；结构行出现 Tab 由调用方报错；
 * - 位置：本文件只放 0 基 UTF-16 偏移，1 基位置换算统一走 `positions.ts`（§4.13 唯一入口）；
 * - 词表（声明词 / 调度词 / 类型 / 存储期 / 织入修饰词 / 旧写法词）在**本文件唯一定义**，
 *   lexer / parser / 降糖都从这里取，禁止各处自持一份字符串表。
 */
import type { KojoWaitMode } from './ast.js';
import type { KojoDiagnostic } from './diagnostics.js';
import type { PositionIndex } from './positions.js';

/* ============================== 缩进与词表 ============================== */

/** 2.0 一级缩进 = 4 空格（§4.13）；Tab 只允许出现在 `@原生` 块体 */
export const KOJO_INDENT_WIDTH = 4;

/** 行尾"不等待"标记（§2.4：与行首 `@续` 是两个字面相同、位置不同的东西） */
export const KOJO_WAIT_CONTINUE = '续';
/** 显式空行语句（§4.7 三态：`空行` / `空行 等待` / `空行 续`） */
export const KOJO_BLANK_LINE = '空行';
/** `空行 等待` 的强制等待词 */
export const KOJO_BLANK_WAIT = '等待';

/**
 * `#` 声明词（§3.3）。
 *
 * ⚠ **位序是公开契约**：下游按位置取词（`kojo2-format.ts` 的 `slice(0, 5)` 与
 * `[, , , , , TABLE, POOL, TEMPLATE]`、`kojo-lang` 的 declarations / symbols / inlay、
 * `kojo2-highlight` / `codelens` / `references` / `indent`）。
 *
 * 3 号位＝原 `变量` 位、4 号位＝原 `常量` 位：两写法合并为 `# 设`（§3.4）后，两位**同字
 * `设`**（4 号位保留为占位，下游"常量位"取词继续成立；补全侧按 Set 去重）。
 *
 * 末位 `方言`（LAU §5.3）＝ 方言**断言**词位：它不指向任何游戏事实，参数对 core 是不透明
 * 字符串（core 不解释、不校验它属于哪个方言）；词表里**不许**出现任何方言名取值。
 */
export const KOJO_DECL_WORDS = ['幕', '视角', '机', '设', '设', '对照表', '池', '模', '方言'] as const;
export type KojoDeclWord = (typeof KOJO_DECL_WORDS)[number];
/** 声明词集合（词表单源；parser 只查这一份） */
export const KOJO_DECL_WORD_SET: ReadonlySet<string> = new Set<string>(KOJO_DECL_WORDS);

/** `@` 调度词（§2.1 / §8 / §9；`@续` 与行尾 `续` 不同字面位置） */
export const KOJO_DISPATCH_WORDS = [
  '算',
  '着色',
  '颜绘',
  '随机',
  '组',
  '循',
  '复',
  '巡',
  '函',
  '织',
  '标',
  '跳',
  '返',
  '断',
  '续',
  '原生',
] as const;
export type KojoDispatchWord = (typeof KOJO_DISPATCH_WORDS)[number];
export const KOJO_DISPATCH_WORD_SET: ReadonlySet<string> = new Set<string>(KOJO_DISPATCH_WORDS);

/** `@织` 修饰词（§8.6：固定集合，是保留词，事件名不能与修饰词同名） */
export const KOJO_WEAVE_MODIFIERS = ['之前', '之后', '接管'] as const;
export type KojoWeaveModifierWord = (typeof KOJO_WEAVE_MODIFIERS)[number];

/** `# 设` 类型词（§3.4.2） */
export const KOJO_INT_TYPE = '整数';
export const KOJO_STRING_TYPE = '字符串';
export const KOJO_TYPE_WORDS = [KOJO_INT_TYPE, KOJO_STRING_TYPE] as const;

/** 存储期词（§3.4.4）；顺序即默认值优先级 */
export const KOJO_STORAGE_WORDS = ['场景', '存档', '会话'] as const;
export type KojoStorageWord = (typeof KOJO_STORAGE_WORDS)[number];
export const KOJO_DEFAULT_STORAGE: KojoStorageWord = '场景';

/** `# 对照表 ... 依据 <表达式>` 的来源词；表默认分支词 `否`（§6.1） */
export const KOJO_TABLE_SUBJECT = '依据';
export const KOJO_TABLE_DEFAULT = '否';
/**
 * 表行的分档箭头（§6.1）：规范形是键盘直出的 `->`，`→` 是等价别名；
 * 两者同一颗记号，AST 不区分。表上下文以外不具语法意义。
 */
export const KOJO_TABLE_ARROWS = ['->', '→'] as const;
/** 规范形（诊断 / 补全 / 格式化统一用它） */
export const KOJO_TABLE_ARROW_CANONICAL = '->';

/** `# 模` 的插槽字面量（§7.2：最多一个，只在行首独立成行时有语法意义） */
export const KOJO_TEMPLATE_SLOT = '[插槽]';

/** 编译器保留前缀（§3.4.5 / §11.3 `core/decl/reserved-name`） */
export const KOJO_RESERVED_PREFIX = '__kojo_';

/** adapter `domainSymbols` 固定域符号（§3.6）；作者不得声明成变量 */
export const KOJO_DOMAIN_SYMBOL_NAMES = ['我', '你', '她'] as const;
export const KOJO_DOMAIN_SYMBOL_SET: ReadonlySet<string> = new Set<string>(KOJO_DOMAIN_SYMBOL_NAMES);

/** `@颜绘` 对象词（§8.3：只有第一个词恰为 `我` / `你` 时才解析为对象） */
export const KOJO_FACE_OBJECT_WORDS = ['我', '你'] as const;
/** `@颜绘` 参数上限（对象之外：表情 / 服装 / 差分 / 特效，§8.3） */
export const KOJO_FACE_MAX_ARGS = 4;

/* ============================== 源事实 ============================== */

/**
 * BOM 事实。`lex` 收到的是**已解码**的 JS 字符串，UTF-8 BOM 与 UTF-16LE BOM 解码后同为
 * `U+FEFF`，故这里只记录"有没有 BOM 字符"，编码判别在 Unit 解码层（`encodingPolicy`）。
 */
export type KojoBomKind = 'none' | 'feff';

/** 单行行尾种类；`none` = 文件末行无换行 */
export type KojoEolKind = 'lf' | 'crlf' | 'cr' | 'none';

/** 整文件 EOL 风格事实；`mixed` 一旦出现就保留，保存时**不归一化**（§10.4） */
export type KojoEolStyle = 'lf' | 'crlf' | 'cr' | 'mixed' | 'none';

/** 文件级源事实：编码不变量与 EOL 读数（Unit 保留用） */
export interface KojoSourceFacts {
  readonly bom: KojoBomKind;
  readonly eol: KojoEolStyle;
  /** CRLF 行数 */
  readonly crlf: number;
  /** LF（不含 CRLF 的裸 LF）行数 */
  readonly lf: number;
  /** 裸 CR（老 Mac 风格）行数 */
  readonly cr: number;
  /** 物理行数（末行无换行也算一行；空文件 0） */
  readonly physicalLines: number;
  /** 逻辑行数（与物理行数相等，保留字段便于宿主断言） */
  readonly logicalLines: number;
  /** 含 BOM 时首个内容行的起始偏移（0 基）；无 BOM 为 0 */
  readonly contentStart: number;
}

/** 物理行：只描述源文本事实，不做任何 2.0 判定 */
export interface KojoPhysicalLine {
  /** 1 基物理行号 */
  readonly number: number;
  /** 行首在源文本里的 0 基 UTF-16 偏移（含 BOM 时首行从 BOM 之后算） */
  readonly offset: number;
  /** 行内容（不含行尾 EOL、不含 BOM） */
  readonly text: string;
  /** 本行行尾；`none` = 文件末行无换行 */
  readonly eol: KojoEolKind;
  /** 缩进列宽：空格 1 / Tab 按 4 计（结构层比较用） */
  readonly indentWidth: number;
  /** 缩进占用的**码元数**（切片用） */
  readonly indentChars: number;
  /** 行首 Tab 个数（>0 的结构行必须报错） */
  readonly tabs: number;
  /** 空白行（只有空白字符） */
  readonly blank: boolean;
  /** 整行 `//` 注释（内容首非空白即 `//`） */
  readonly comment: boolean;
}

/* ============================== 逻辑行 ============================== */

/**
 * 逻辑行种类。每一行只属于一种：
 * - `blank` / `comment`：物理空行与整行注释，不进 AST（source map 另记）；
 * - `decl` / `dispatch`：`#` / `@` 锚点行；
 * - `narration` / `dialogue` / `bareQuote` / `blankLine`：叙事面；
 * - `trigger`：`!` 触发；
 * - `condition`：`?` 条件行（含 `? 否`）；
 * - `escaped`：行首 `\` 转义的普通文本（§2.6：`\>` 不是旁白，是字面文本）；
 * - `text`：未分类裸行（叙事区报裸旁白/裸台词，调度区按 §4.4 判定赋值/调用）；
 * - `native`：`@原生` 围栏内的物理行原文（已按围栏标出，不再解释 2.0 语法）；
 * - `legacy`：旧写法行（§12.1 全表；parser 出迁移诊断，绝不进 AST）；
 * - `options`：`选项：` 待定 UI 块头（parser 建 `optionsBlock` + `core/options/pending` warning）；
 * - `unknown`：识别不出、且不属于已知旧写法的行（parser 报错兜底）。
 */
export type KojoLineKind =
  | 'blank'
  | 'comment'
  | 'decl'
  | 'dispatch'
  | 'narration'
  | 'dialogue'
  | 'bareQuote'
  | 'blankLine'
  | 'trigger'
  | 'condition'
  | 'escaped'
  | 'text'
  | 'native'
  | 'legacy'
  | 'options'
  | 'unknown';

/** 所有逻辑行共有的源事实 */
export interface KojoLineBase {
  readonly kind: KojoLineKind;
  /** 1 基物理/逻辑行号（2.0 恒等） */
  readonly number: number;
  /** 行首（含缩进）0 基偏移 */
  readonly lineOffset: number;
  /** 内容首字符 0 基偏移（跳过缩进） */
  readonly contentOffset: number;
  /** 内容末 0 基偏移（不含 EOL；已去行尾空白与行尾 `续` / 提示组） */
  readonly contentEnd: number;
  /** 缩进列宽（空格 1 / Tab 按 4 计） */
  readonly indent: number;
  /** 行首 Tab 个数 */
  readonly tabs: number;
  /** 本行内容原文：`[contentOffset, contentEnd)` 的切片（各 kind 的专用字段见下） */
  readonly text: string;
  /** 有硬词法错误：parser **不得**据此建节点（错误恢复用，不是"半成品"） */
  readonly invalid: boolean;
}

/** 物理空行 */
export interface KojoBlankRecord extends KojoLineBase {
  readonly kind: 'blank';
}

/** 整行 `//` 注释 */
export interface KojoCommentRecord extends KojoLineBase {
  readonly kind: 'comment';
  /** `//` 之后的注释正文（不含 `//`） */
  readonly comment: string;
}

/** `@原生` 围栏内的原始物理行：不做任何 2.0 解释（§8.5） */
export interface KojoNativeRecord extends KojoLineBase {
  readonly kind: 'native';
  /** 物理行原文（含缩进、含行尾空白，**未去缩进**；去基准缩进是 parser 的事） */
  readonly raw: string;
  /** 是否为空白行（不参与基准缩进计算） */
  readonly blank: boolean;
  /** `@原生{ … }` 的收口行：与块头同缩进的单独一行 `}`（词法围栏在此结束） */
  readonly close?: boolean;
}

/** `#` 声明行的词法切分；是不是合法声明词由 parser 判 */
export interface KojoDeclRecord extends KojoLineBase {
  readonly kind: 'decl';
  /** `#` 与空白之后的词（`KOJO_DECL_WORDS` 各项，或未知词原样） */
  readonly word: string;
  /** 词之后的原文（已去前导空白、已去行尾空白） */
  readonly rest: string;
  /** `rest` 首字符的 0 基偏移 */
  readonly restOffset: number;
  /** 词是否在 2.0 声明词表内 */
  readonly known: boolean;
}

/** `@` 调度行的词法切分；词义与位置约束由 parser 判 */
export interface KojoDispatchRecord extends KojoLineBase {
  readonly kind: 'dispatch';
  /** `@` 之后的词（`算`/`函数`…，或未知词原样） */
  readonly word: string;
  /** 词之后的原文（已去前导空白、已去行尾空白）；`@算` 这类块头必须为空 */
  readonly rest: string;
  /** `rest` 首字符的 0 基偏移 */
  readonly restOffset: number;
  /** 词是否在 2.0 调度词表内 */
  readonly known: boolean;
}

/** `?` 条件行（§5） */
export interface KojoConditionRecord extends KojoLineBase {
  readonly kind: 'condition';
  /** `? 否` = 默认分支 */
  readonly isDefault: boolean;
  /** 条件表达式原文；默认分支为 `''` */
  readonly test: string;
  /** `test` 首字符 0 基偏移 */
  readonly testOffset: number;
}

/** `!` 触发行（§7.1 / §2.1） */
export interface KojoTriggerRecord extends KojoLineBase {
  readonly kind: 'trigger';
  /** 被调名字原样（池 / 模板 / 函数） */
  readonly name: string;
  /** `name` 首字符 0 基偏移 */
  readonly nameOffset: number;
  /** 实参切片（按顶层逗号切；无括号时空数组） */
  readonly args: readonly KojoCallArg[];
  /** 原文是否带 `(...)` */
  readonly hasParens: boolean;
}

/** 一个实参/参数/裸词切片（原文 + 0 基偏移） */
export interface KojoCallArg {
  /** 已 trim 首尾空白的原文 */
  readonly text: string;
  /** `text` 首字符的 0 基偏移 */
  readonly offset: number;
}

/** 行尾表演提示 `(心形)` / `(别过头)`（§4.8） */
export interface KojoHint {
  /** 括号内原文（已 trim） */
  readonly text: string;
  /** `(` 的 0 基偏移 */
  readonly offset: number;
}

/** 叙事面文本行共有的字段（台词 / 旁白 / 裸引号 / 裸行 / 转义行） */
export interface KojoTextFields {
  /** 等待三态（§4.7）：`续` → continue；其余 default；`空行 等待` 单独处理 */
  readonly wait: KojoWaitMode;
  /** 行尾提示组；合法时有值 */
  readonly hint: KojoHint | null;
  /** 行尾提示组个数（>1 是 `core/narrative/bad-hint`，§4.8 一行只挂一个） */
  readonly hintCount: number;
  /** 等待/提示剥离后的**正文**原文（台词 = 引号内，旁白 = `>` 之后） */
  readonly body: string;
  /** `body` 首字符 0 基偏移 */
  readonly bodyOffset: number;
  /** 正文片段（纯文本 / 插值；只扫描不解析表达式） */
  readonly parts: readonly KojoTextSegment[];
  /** 旧写法的行尾等待别名（`~` / `⏎` / `cont` / `continue`）；2.0 一律迁移报错 */
  readonly legacyWait: string | null;
}

/** `>` 旁白行（§4.6） */
export interface KojoNarrationRecord extends KojoLineBase, KojoTextFields {
  readonly kind: 'narration';
}

/** `角色：「…」` 台词行（§4.5） */
export interface KojoDialogueRecord extends KojoLineBase, KojoTextFields {
  readonly kind: 'dialogue';
  /** 说话人原样切片（已 trim） */
  readonly speaker: string;
  /** `speaker` 首字符 0 基偏移 */
  readonly speakerOffset: number;
}

/** 裸引号行（§4.10：只有 `# 池` / `选项` 内是正典，其余一律 `core/narrative/bare-quote`） */
export interface KojoBareQuoteRecord extends KojoLineBase, KojoTextFields {
  readonly kind: 'bareQuote';
  /** 起始引号字符：`「` 是 2.0 引号，`｢` 是必须迁移的半角旧引号 */
  readonly quote: '「' | '｢';
}

/** 未分类裸行（叙事区 = 裸旁白；调度区按 §4.4 再判赋值/调用/表达式） */
export interface KojoTextRecord extends KojoLineBase, KojoTextFields {
  readonly kind: 'text';
}

/** 行首 `\` 转义行（§2.6：`\>` 不是旁白，是字面文本） */
export interface KojoEscapedRecord extends KojoLineBase, KojoTextFields {
  readonly kind: 'escaped';
  /** 被还原的字面字符（`>` / `?` / `=` / …） */
  readonly escaped: string;
}

/** 显式空行语句（`空行` / `空行 等待` / `空行 续`，§4.7） */
export interface KojoBlankLineRecord extends KojoLineBase {
  readonly kind: 'blankLine';
  readonly wait: KojoWaitMode;
}

/** 旧写法行（§12.1）；parser 一律 error + 迁移码，`选项` 是唯一 warning */
export interface KojoLegacyRecord extends KojoLineBase {
  readonly kind: 'legacy';
  readonly legacy: KojoLegacyKind;
  /** 判别用的原文尾巴（词/冒号之后的内容，便于迁移建议） */
  readonly rest: string;
  /** `rest` 首字符 0 基偏移 */
  readonly restOffset: number;
}

/** `选项：` 待定 UI 块头（§7.5：2.0 保留局部 UI 字面量区，warning 不阻断） */
export interface KojoOptionsRecord extends KojoLineBase {
  readonly kind: 'options';
}

/** 兜底行：识别不出、也不是已知旧写法 */
export interface KojoUnknownRecord extends KojoLineBase {
  readonly kind: 'unknown';
  readonly reason: string;
}

/** 逻辑行判别联合 */
export type KojoLexLine =
  | KojoBlankRecord
  | KojoCommentRecord
  | KojoDeclRecord
  | KojoDispatchRecord
  | KojoConditionRecord
  | KojoTriggerRecord
  | KojoNarrationRecord
  | KojoDialogueRecord
  | KojoBareQuoteRecord
  | KojoTextRecord
  | KojoEscapedRecord
  | KojoBlankLineRecord
  | KojoNativeRecord
  | KojoLegacyRecord
  | KojoOptionsRecord
  | KojoUnknownRecord;

/* ============================== 旧写法种类 ============================== */

/**
 * 旧写法种类（§12.1 全表的**词法判别结果**）。
 * 语义映射（→ 哪个 `core/migration/*` / `core/narrative/*` 码）只在 parser 出现一次；
 * 词法层只负责"这行是旧写法 X"，不负责码与文案。
 */
export type KojoLegacyKind =
  /** `;` 注释（2.0 只认整行 `//`；`;` 仅限 `@原生`） */
  | 'semicolon'
  /** `#DIM` / `#FUNCTION` 等原生预处理器（无空格，必须进 `@原生`） */
  | 'preprocessor'
  /** `# 版本`（2.0 没有版本声明） */
  | 'version'
  /** `# 时机 <事件>`（→ `# 机`） */
  | 'timing'
  /** 旧文件头声明 `角色:` / `口上:` / `显示名:` / `简介:` / `开关:` */
  | 'head-decl'
  /** `如果` / `否则如果` / `否则` */
  | 'if'
  | 'elif'
  | 'else'
  /** `当` / `是` */
  | 'when'
  | 'is'
  /** `分支：` + `[条件]` */
  | 'branch'
  /** `循环` 族（含 `循环结束`） */
  | 'loop'
  | 'loop-end'
  /** `调用` / `返回` */
  | 'call'
  | 'return'
  /** `标签` / `跳到` */
  | 'goto-label'
  | 'goto-jump'
  /** `初回` / `询问` / `确认` */
  | 'ask'
  /** `隐藏情景:` / `隐藏口上:` */
  | 'hidden-timing'
  /** `别名` */
  | 'alias'
  /** `旁白色` / `口上色` */
  | 'color-option'
  /** `心形` 语句 / 块 */
  | 'heart'
  /** `着色` 块 */
  | 'color-block'
  /** `随机：` / `组：` / `数据表：` */
  | 'random-block'
  | 'group-block'
  | 'data-table'
  /** `选项：`（2.0 待定 UI：warning，不是旧语法例外） */
  | 'option'
  /** `@LABEL` / 原生标签 */
  | 'native-label'
  /** `@` 原生函数块 */
  | 'raw-function'
  /** 行首 `=`（1.0 写法：`= 返 n` / `= 变量 x`；2.0 只有 `@返` / 声明 / 裸赋值） */
  | 'equal-prefix'
  /** 行尾等待别名 `~` / `⏎` / `cont` / `continue` */
  | 'wait-mark';

/* ============================== 文本片段 ============================== */

/** 纯文本片段（转义已解，`text` 是"要打印的字"） */
export interface KojoLiteralTextSegment {
  readonly kind: 'text';
  /** 已解转义的字面文本 */
  readonly text: string;
  /** 源起点 0 基偏移（含转义符） */
  readonly offset: number;
  /** 源终点 0 基偏移（半开） */
  readonly endOffset: number;
}

/** 插值片段里的一段（表达式原文 + 源偏移；不解析表达式） */
export interface KojoInterpPiece {
  /** 原文（已 trim 首尾空白） */
  readonly text: string;
  /** `text` 首字符 0 基偏移 */
  readonly offset: number;
}

/** `{条件 ? A : B}` 的三段 */
export interface KojoInterpCondition {
  readonly cond: KojoInterpPiece;
  readonly then: KojoInterpPiece;
  readonly else: KojoInterpPiece;
}

/** `{…}` / `{条件 ? A : B}` 插值片段（只扫描，不解析表达式） */
export interface KojoInterpSegment {
  readonly kind: 'interp';
  /** `{…}` 原文（含花括号） */
  readonly raw: string;
  /** 花括号内原文 */
  readonly value: string;
  /** 花括号内原文首字符 0 基偏移 */
  readonly valueOffset: number;
  /** 三段条件插值；普通插值为 null */
  readonly condition: KojoInterpCondition | null;
  /** `{` 的 0 基偏移 */
  readonly offset: number;
  /** `}` 之后一位的 0 基偏移（半开） */
  readonly endOffset: number;
}

/** 文本片段判别联合 */
export type KojoTextSegment = KojoLiteralTextSegment | KojoInterpSegment;

/* ============================== 词法结果 ============================== */

/** `lex(source)` 的产物：源事实 + 行 + 诊断 + 位置换算器 */
export interface LexResult {
  readonly source: string;
  readonly facts: KojoSourceFacts;
  /** 全部物理行（`@原生` 原文与 source map 用） */
  readonly physical: readonly KojoPhysicalLine[];
  /** 全部逻辑行（与物理行一一对应） */
  readonly lines: readonly KojoLexLine[];
  /** 词法级诊断（parser 会原样并入 `KojoFile.diagnostics`） */
  readonly diagnostics: readonly KojoDiagnostic[];
  /** 0 基偏移 ⇄ 1 基行列（与 Monaco / plugin-api 同口径） */
  readonly positions: PositionIndex;
}

/* ============================== 待并入的 C1 诊断码 ============================== */

/* 空的：C1 所需的 core 码已全部并入 `diagnostics.ts`（词法 3 枚、声明 4 枚、迁移 10 枚）。
 * 本文件不再提供任何码别名——所有诊断直接写字面量，杜绝第二份码表。 */
