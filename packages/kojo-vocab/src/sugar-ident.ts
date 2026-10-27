/**
 * 糖**识别核**（W5 LIFT-PROJ-ALIGN，2026-10-14）—— 原生 ERB 形态识别的**唯一**一张表。
 *
 * ## 为什么要有这个文件
 *
 * 识别原本有**两套、互不喂结果**：
 *
 * - `lift.ts`（**写回口径**）：整段 round-trip 自证，规则表只覆盖 4 个 `PRINTFORM{W,L,DW,DL}`
 *   + `IF`/`SELECTCASE` 两族，外加一份自己抄的"未覆盖控制流"名单；
 * - `project.ts`（**显示口径**）：封闭规则表 + 逐行降级，批 F/G/H/N 陆续补上了 `PRINTL` 系、
 *   裸指令打空行、行内三元、`SIF`、代词/属性反糖、数据表……
 *
 * 两份表各长各的，后果是同一个形态在两侧**口径不一致**（`.erb` 糖视图能显示糖写法、
 * `.kojo` 的 💡 却不出候选），而任何一条映射规则都要**同步改两处**。
 *
 * ## 本模块的口径：识别一份、用途两个标志位
 *
 * - **writable**（写回）= `lift.ts` 允许**试着组装糖片段**的形态；组装完仍要过逐字节
 *   round-trip 自证，这个标志只是"值不值得试"的前置判据，不是"能不能写"的结论；
 * - **displayable**（显示）= `project.ts` 允许投影成糖的形态。
 *
 * 不变量（`tests/sugar-ident-invariants.test.ts` 逐条钉死、不许放宽成恒真）：
 *
 * ```text
 * displayable ⇒ 建议侧存在对应候选 ∥ 建议侧给出明确拒绝理由（SugarLiftSkip 里可见，不静默）
 * ```
 *
 * ## 分层纪律
 *
 * 这里放的是**语言/引擎级**形态知识（与 `PRINT` 家族、`IF`/`SELECTCASE` 关键字同族），
 * 零游戏名词（审计 A）。反糖要用的表（变量字典 / 时机分野 / 基础库）由调用方注入，
 * 本模块只管"哪里可以替换、替换失败怎么办"，不管"替换成什么"——两侧的差异通过
 * **回调**（`TernaryRender` 一类）传入，而不是通过第二份规则表。
 */

// 行首 / 行尾 / 缩进折算的唯一真源（CHARSET-SS 批）：本文件此前手写 `[ \t　]` 两份与一份
// 折算算法，与 lexer / formatter 各自漂移。`blank-charset.ts` 是零依赖叶子，不造环。
import { indentLevelOf as sharedIndentLevelOf, leadingBlank, trimTrailingBlank } from './blank-charset';

/* ============================== 行工具（两侧共用一份） ============================== */

/** 切源行（EOL 归一为 `\n`；去掉末尾空尾行） */
export function splitSourceLines(source: string): string[] {
  const src = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = src.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 去行首缩进 + 行尾空白（字符集 / 折算全走 `blank-charset.ts` 的唯一真源，此处不写第二份） */
export function contentOf(line: string): string {
  return trimTrailingBlank(line.slice(leadingBlank(line).length));
}

/** 去行尾空白（TAB / 空格 / 全角空格；PRINT 行"空体 vs 有体"的判据靠它，两侧同口径） */
export function trimTrailingSpace(text: string): string {
  return trimTrailingBlank(text);
}

/** 缩进层级（TAB =1、全角空格 =2、空格按 4 折算；与 lexer 同**一份**实现，不是同算法抄两份） */
export function indentLevelOf(line: string): number {
  return sharedIndentLevelOf(line);
}

/** 行首指令词（大写） */
export function leadingWord(text: string): string {
  const m = /^([A-Za-z_]+)/.exec(text);
  return m ? m[1]!.toUpperCase() : '';
}

/* ============================== PRINT 家族（一张表） ============================== */

/**
 * PRINT 变体的**语言事实**（三个判据都由指令名本身决定，一条都不猜）：
 *
 * - `form`：是否展开 FORM 记号（只有 `PRINTFORM*` 展开）。非 FORM 行里的
 *   `%…%` / `{…}` / 行内条件记号是**被打印的字面字符**，动它就等于篡改文本；
 * - `newline`：是否产生一行（`L` / `W` 后缀）。只有 `newline` 的行，空体才是"打空行"；
 *   `PRINT` / `PRINTD` / `PRINTFORM` / `PRINTFORMD` 无后缀 = 不换行（拼句片段）；
 * - `wait`：**有文本体**时 `W` 等待 → 糖不加标记，`L` 不等待 → 行尾 ` 续`（规范 §3.3）。
 *
 * 后缀 `D`（默认色 / 旁白）不在这里判：糖按引号自动决定色（规范 §1.3、§3.3），
 * 建议侧靠 round-trip 兜住"该有 D 却没有"的原生手写，显示侧不标色。
 */
export interface PrintVariant {
  readonly word: string;
  readonly form: boolean;
  readonly newline: boolean;
  readonly wait: boolean;
}

const PV = (word: string, form: boolean, newline: boolean, wait: boolean): readonly [string, PrintVariant] => [
  word,
  { word, form, newline, wait },
];

/**
 * **唯一**的 PRINT 表：`displayable` = 「在表里」，`writable` 见 `writablePrint()`。
 *
 * 表外的变体两侧都不动（`PRINTBUTTON` / `PRINTLC` / `PRINTS` / `PRINTPLAIN*` / `PRINTV` /
 * `PRINTFORMK*`…）：按钮与排版类指令的输出不是"读者要读的文本"，投影成台词会误导
 * （真实语料合计 <400 行，收益远低于风险）。`PRINTDATA` 系是**块开词**，归控制流表管。
 */
export const PRINT_VARIANTS: ReadonlyMap<string, PrintVariant> = new Map<string, PrintVariant>([
  PV('PRINTFORMW', true, true, true),
  PV('PRINTFORML', true, true, false),
  PV('PRINTFORMDW', true, true, true),
  PV('PRINTFORMDL', true, true, false),
  PV('PRINTFORM', true, false, false),
  PV('PRINTFORMD', true, false, false),
  PV('PRINTL', false, true, false),
  PV('PRINTW', false, true, true),
  PV('PRINTDL', false, true, false),
  PV('PRINTDW', false, true, true),
  PV('PRINT', false, false, false),
  PV('PRINTD', false, false, false),
]);

/**
 * **写回判据**（建议侧唯一的"值不值得试"关口）：只有 `form && newline` 四个变体有糖形态。
 *
 * - `PRINTFORM` / `PRINTFORMD`（无 `L/W` 后缀）= 不换行不等待（规范 §3.3 能力边界）；
 * - `PRINTL` / `PRINT` / `PRINTD` 系 = 非 FORM：糖的文本行**恒**产出 `PRINTFORM*`，
 *   组装出来的糖转回去必然不是原指令。**显示**成文本行没有代价（读者看到的与游戏
 *   打印的一致），**写回**有（会把非 FORM 行悄悄换成 FORM 行、改变插值语义）。
 *
 * 这就是"同一张表、两个标志位"的样板：`displayable` 为真、`writable` 为假。
 */
export function writablePrint(v: PrintVariant): boolean {
  return v.form && v.newline;
}

/** 匹配 PRINT 家族行：`(关键字) (文本体)`——`\s?` 让**裸指令**（语料里打空行的写法）也进表 */
export const PRINT_FAMILY_RE = /^(PRINT[A-Z]*)\s?([\s\S]*)$/;

/** 输出一行空行的糖写法（规范 §3.3 / 批 P：`空行` → 裸 `PRINTFORML`、`空行 等待` → `PRINTFORMDW`） */
export function blankLineSugar(wait: boolean): string {
  return wait ? '空行 等待' : '空行';
}

/** ` 续` 标记（= 换行但不等待）；无换行的片段不能谎称续行 */
export function contMark(v: PrintVariant): string {
  return v.newline && !v.wait ? ' 续' : '';
}

/** 指令后紧跟 `;` = 那是注释而不是要打印的字（`;` 在任意位置起效），一行给不出"空行 + 注释"两行显示 */
export function bodyIsComment(body: string): boolean {
  return body.startsWith(';');
}

/* ============================== 控制流关键字（一张表） ============================== */

/**
 * 一条控制流形态在**这张表里的身份**：
 *
 * - `block-head`：糖的缩进块开词（`IF` / `SELECTCASE`）→ 显示 + 写回（整块组装）；
 * - `branch`：块内的分支续行（`ELSEIF` / `ELSE` / `CASE` / `CASEELSE`）→ 显示，由父块组装；
 * - `sugar-close`：糖的缩进语义吸收掉的收束行（`ENDIF` / `ENDSELECT`）→ 显示为不可见；
 * - `single-line-head`：`SIF` → 显示成块头（判据由 `planSif` 管），写回成**单行**「如果 … 则 …」；
 * - `structural-open` / `structural-close`：糖层**没有**对应形态，只服务结构栈
 *   （数据表体、循环体里的行不该被投影成台词 ⇒ 必须数进嵌套深度）。
 */
export type ControlRole =
  | 'block-head'
  | 'branch'
  | 'sugar-close'
  | 'single-line-head'
  | 'structural-open'
  | 'structural-close';

/** 写回组装方式（`null` = 该形态不能由建议侧单独组装） */
export type WritebackMode = 'block' | 'single-line' | null;

export interface ControlShape {
  readonly kind: string;
  readonly role: ControlRole;
  /** 糖块头文本（`undefined` = 不投影；`null` = 投影为"不产出可见行"的收束） */
  readonly head?: (expr: string) => string | null;
  /** 块头必须带表达式（空表达式 = 不猜 → 原样保留） */
  readonly needsExpression?: boolean;
  /** 结构栈：开块类别（`IF` → `if`） */
  readonly open?: string;
  /** 结构栈：闭合行所闭合的类别（`ENDIF` → `if`） */
  readonly closes?: string;
  /** 块开词 → 配对闭合关键词（`IF` → `ENDIF`；建议侧配对块体用） */
  readonly closeWord?: string;
}

const CS = (
  kind: string,
  role: ControlRole,
  extra?: Partial<Omit<ControlShape, 'kind' | 'role'>>,
): readonly [string, ControlShape] => [kind, { kind, role, ...extra }];

const headOf = (make: (expr: string) => string | null): Pick<ControlShape, 'head'> => ({ head: make });

/** 糖块头文本 + 结构栈 + 写回方式——**全部**在这一张表里（两侧各按标志位取用） */
export const CONTROL_SHAPES: ReadonlyMap<string, ControlShape> = new Map<string, ControlShape>([
  CS('IF', 'block-head', {
    ...headOf((e) => `如果 ${e}：`),
    needsExpression: true,
    open: 'if',
    closeWord: 'ENDIF',
  }),
  CS('SELECTCASE', 'block-head', {
    ...headOf((e) => `当 ${e}：`),
    needsExpression: true,
    open: 'select',
    closeWord: 'ENDSELECT',
  }),
  CS('ELSEIF', 'branch', { ...headOf((e) => `否则如果 ${e}：`), needsExpression: true }),
  CS('ELSE', 'branch', headOf(() => '否则：')),
  CS('CASE', 'branch', { ...headOf((e) => `是 ${e}：`), needsExpression: true }),
  CS('CASEELSE', 'branch', headOf(() => '否则：')),
  CS('ENDIF', 'sugar-close', { ...headOf(() => null), closes: 'if' }),
  CS('ENDSELECT', 'sugar-close', { ...headOf(() => null), closes: 'select' }),
  CS('SIF', 'single-line-head', { ...headOf((e) => `如果 ${e}：`), needsExpression: true }),
  /* ---- 结构栈：糖层不覆盖，但必须数进嵌套（否则表体 / 循环体里的行会被当成台词投影） ---- */
  CS('FOR', 'structural-open', { open: 'for' }),
  CS('WHILE', 'structural-open', { open: 'while' }),
  CS('REPEAT', 'structural-open', { open: 'repeat' }),
  CS('DO', 'structural-open', { open: 'do' }),
  CS('DATALIST', 'structural-open', { open: 'list' }),
  CS('STRDATA', 'structural-open', { open: 'data' }),
  CS('NOSKIP', 'structural-open', { open: 'noskip' }),
  CS('CATCH', 'structural-open'),
  CS('NEXT', 'structural-close'),
  CS('WEND', 'structural-close'),
  CS('REND', 'structural-close'),
  CS('LOOP', 'structural-close'),
  CS('ENDDATA', 'structural-close'),
  CS('ENDLIST', 'structural-close'),
  CS('ENDNOSKIP', 'structural-close'),
  CS('ENDCATCH', 'structural-close'),
  CS('ENDFUNC', 'structural-close'),
  /* ---- `PRINTDATA` 系：数据表是**择一输出**的块，糖层没有对应写法（批 N 只做结构标注） ---- */
  CS('PRINTDATA', 'structural-open'),
  CS('PRINTDATAL', 'structural-open'),
  CS('PRINTDATAW', 'structural-open'),
  CS('PRINTDATAK', 'structural-open'),
  CS('PRINTDATAKL', 'structural-open'),
  CS('PRINTDATAKW', 'structural-open'),
  CS('PRINTDATAD', 'structural-open'),
  CS('PRINTDATADL', 'structural-open'),
  CS('PRINTDATADW', 'structural-open'),
  /* ---- TRY 系：糖层不做（规范 §7） ---- */
  CS('TRYCGOTO', 'structural-open'),
  CS('TRYCJUMP', 'structural-open'),
  CS('TRYCCALL', 'structural-open'),
  CS('TRYCGOTOFORM', 'structural-open'),
  CS('TRYCJUMPFORM', 'structural-open'),
  CS('TRYCCALLFORM', 'structural-open'),
  CS('TRYCALLLIST', 'structural-open'),
  CS('TRYGOTOLIST', 'structural-open'),
  CS('TRYJUMPLIST', 'structural-open'),
]);

/** 数据表开词（`planDataBlocks` 与结构栈共用一份；糖层不可写回） */
export const PRINTDATA_OPEN: ReadonlySet<string> = new Set(
  [...CONTROL_SHAPES.values()].filter((s) => s.kind.startsWith('PRINTDATA')).map((s) => s.kind),
);
/** TRY… 条件跳转系开词 */
export const TRY_CATCH_OPEN: ReadonlySet<string> = new Set([
  'TRYCGOTO',
  'TRYCJUMP',
  'TRYCCALL',
  'TRYCGOTOFORM',
  'TRYCJUMPFORM',
  'TRYCCALLFORM',
]);
/** TRY…LIST 函数表开词 */
export const TRY_LIST_OPEN: ReadonlySet<string> = new Set(['TRYCALLLIST', 'TRYGOTOLIST', 'TRYJUMPLIST']);
/**
 * TRY 家族的**第三档**：引擎里既不开块也没有配对闭合的单行语句（`funcMatch` 的"其余 TRY*"）。
 *
 * 为什么这张名单住识别核、而不住显示层的动词表：显示面的分诊判据是**档位**——开块那九枚
 * （`TRY_CATCH_OPEN ∪ TRY_LIST_OPEN`）归 ZH-C 的中性形，单行这一档归 ZH-S 的语句动词语。
 * 判据只有一份，`statement.ts` 认领的记号**由本集合派生**；两档互斥由
 * `tests/native-display-statement.test.ts` 逐字钉死（谁也不许认领对方那批，`startsWith('TRY')`
 * 那种前缀扩张更是结构性地不可能命中这里——本集合是**枚举**，不是模式）。
 *
 * 与 `pairOf()` 的关系：**故意不进结构栈**——单行语句不开块，数进嵌套就会造出幻影深度
 * （这正是 BUG-2 / L5 收敛掉的那个根因）。
 *
 * 认领面按**档位**划，不按命中率划：当前语料盘（4,393 份 `.ERB` 全量 token 扫描）实测
 * `TRYCALLFORM` 行首 1,440 / `TRYCALL` 342 / `TRYCCALLFORM` 196，而 `TRYGOTO`·`TRYGOTOFORM`·
 * `TRYJUMP`·`TRYJUMPFORM` **各 0 处**——词形有引擎 funcMatch 与跳转族（`ERB_JUMP_KEYWORDS`）
 * 两处理事做底，处数为 0 只说明这批盘没人写，不改变"读者撞见它时该给语句形而不是兜底"。
 */
export const TRY_SINGLE_LINE: ReadonlySet<string> = new Set([
  'TRYCALL',
  'TRYCALLFORM',
  'TRYJUMP',
  'TRYGOTO',
  'TRYGOTOFORM',
]);

/** 结构栈：开块语句 → 配对类别（`null` = 不开块）。两侧共用（投影数嵌套、建议侧判块内纯度） */
export function pairOf(kind: string): string | null {
  const s = CONTROL_SHAPES.get(kind);
  if (s === undefined) return null;
  if (s.open !== undefined) return s.open;
  if (s.role === 'structural-open') {
    if (PRINTDATA_OPEN.has(kind)) return 'data';
    if (TRY_CATCH_OPEN.has(kind)) return 'try';
    if (TRY_LIST_OPEN.has(kind)) return 'funclist';
  }
  return null;
}

/** 结构栈：闭合行（`ENDIF` / `NEXT` / `ENDDATA`…） */
export function isCloseKind(kind: string): boolean {
  const s = CONTROL_SHAPES.get(kind);
  return s !== undefined && (s.role === 'sugar-close' || s.role === 'structural-close');
}

/** 块开词 → 配对闭合关键词（建议侧找块尾用；非块开词 → `undefined`） */
export function closeWordOf(kind: string): string | undefined {
  return CONTROL_SHAPES.get(kind)?.closeWord;
}

/** 闭合行 → 它所闭合的开块类别（`ENDIF` → `if`） */
export function closesCategory(kind: string): string | undefined {
  return CONTROL_SHAPES.get(kind)?.closes;
}

/** 分支续行（`ELSEIF` / `ELSE` / `CASE` / `CASEELSE`——挂在它上面那条链上，自己不开块） */
export function isBranchKind(kind: string): boolean {
  return CONTROL_SHAPES.get(kind)?.role === 'branch';
}

/** 糖的收束行（`ENDIF` / `ENDSELECT`：被缩进语义吸收，不产出可见行） */
export function isSugarCloseKind(kind: string): boolean {
  return CONTROL_SHAPES.get(kind)?.role === 'sugar-close';
}

/**
 * 显示口径的糖块头**构造器**（`undefined` = 这一族没有糖块头形态，调用方留原代码）。
 *
 * **不接 `SIF`**：`SIF` 的投影归 `planSif` 管（判据不满足就整行不动），走通用通道会把
 * "投不了的 SIF"也标成块头，与批 H 的判据冲突。构造器的入参是**已 trim、已反糖**的表达式；
 * 返回 `null` = 收束行（`ENDIF` / `ENDSELECT`：被缩进语义吸收，不产出可见行）。
 */
export function controlHeadMaker(kind: string): ((expr: string) => string | null) | undefined {
  const s = CONTROL_SHAPES.get(kind);
  if (s === undefined || s.head === undefined) return undefined;
  if (s.role === 'single-line-head') return undefined;
  return s.head;
}

/**
 * 块头文本（`undefined` = 表里没有这一族 / 是收束行 / 需要表达式却给了空表达式
 * → 调用方整块不猜）。建议侧组装糖片段与显示侧投影都从这里取串——**块头文本只有一处**。
 */
export function controlHeadText(kind: string, expr: string): string | undefined {
  const mk = controlHeadMaker(kind);
  if (mk === undefined) return undefined;
  if (needsExpression(kind) && expr.trim().length === 0) return undefined;
  return mk(expr) ?? undefined;
}

/** 块头是否必须带表达式（空表达式 = 不猜，调用方留原代码） */
export function needsExpression(kind: string): boolean {
  return CONTROL_SHAPES.get(kind)?.needsExpression === true;
}

/**
 * 写回口径：这一族能否由建议侧组装。
 *
 * - `top-level`（缺省）：`block-head` 整块组装、`single-line-head` 单行组装；
 * - `inside-block`：块体里只接受 `block-head`（`SIF` 在块内仍按"糖未覆盖"处理——
 *   单行条件的产物会把正文缩进一级，块内混排无法逐字节还原）。
 */
export function writableControl(kind: string, mode: 'top-level' | 'inside-block' = 'top-level'): WritebackMode {
  const s = CONTROL_SHAPES.get(kind);
  if (s === undefined) return null;
  if (mode === 'inside-block' && s.role !== 'block-head') return null;
  if (s.role === 'block-head') return 'block';
  if (s.role === 'single-line-head') return 'single-line';
  return null;
}

/**
 * 「糖未覆盖的控制流」（在组装糖片段**之前**先筛掉整块；`.kojo` v1 不做循环与 TRY 系）。
 *
 * **由表派生**，不再是第二份名单（旧写法：`lift.ts` 一份 `UNSUPPORTED_FLOW`、
 * `project.ts` 一份 `SUGAR_CONTROL` + 三份开闭集合，加一族关键字要同步四处）。
 * 表里没有的关键字（`GOTO` / `SETCOLOR`…）不算控制流问题——它们由各自的判据处理。
 */
export function unsupportedInBlock(kind: string): boolean {
  const s = CONTROL_SHAPES.get(kind);
  if (s === undefined) return false;
  return s.role !== 'block-head' && s.role !== 'branch' && s.role !== 'sugar-close';
}

/** 不能当 `SIF` 正文的行：连写的另一条 `SIF`，以及**分支续行**（属于上面那条链，不是"被条件管的一条语句"） */
export const NON_BODY_LINE_KINDS: ReadonlySet<string> = new Set(['SIF', 'ELSE', 'ELSEIF', 'CASE', 'CASEELSE']);

/**
 * 单行条件的糖写法「如果 \<条件\> 则 \<语句\>」（规范 §3.5；产物 = `SIF 条件` + **恰好一条**
 * 语句行，不产 `ENDIF`）。`则` 是**独立词**（前后带空白边界），条件里撞字不会被切错。
 */
export function singleIfSugar(cond: string, statement: string): string {
  return `如果 ${cond.trim()} 则 ${statement.trim()}`;
}

/** `CASE a TO b, c` → 糖「a 到 b, c」（`lowerExpression` 会把「到」降回 `TO`）；无法一致映射 → `null` */
export function caseValuesToSugar(erbCase: string): string | null {
  const out: string[] = [];
  for (const p of splitTopLevel(erbCase)) {
    const t = p.trim();
    if (t.length === 0) return null;
    const m = /^([\s\S]+?)\s+TO\s+([\s\S]+)$/.exec(t);
    if (m) out.push(`${m[1]!.trim()} 到 ${m[2]!.trim()}`);
    else out.push(t);
  }
  return out.join(', ');
}

/** 顶层逗号切分（括号 / 引号感知） */
export function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      cur += c;
      if (c === '\\' && i + 1 < s.length) {
        cur += s[i + 1]!;
        i++;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      cur += c;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** `SIF 条件:命令` 的冒号形态（语料 0 例；没有表达式解析时分不清它和变量索引冒号 ⇒ 判据取"是就不动"） */
export function hasCommandColon(expr: string): boolean {
  return /[:：] *(PRINT|CALL|RETURN|GOTO|GOSUB|SETCOLOR|RESETCOLOR|CLEARLINE|FORCEWAIT|WAIT|INPUT|TRY|HIDE|SHOW|REDRAW|BREAK|RESTART|CATCH|IF|ELSE|SELECTCASE|CASE|END|NEXT|WEND|REND|LOOP|DO|WHILE|FOR)\b/.test(
    expr,
  );
}

/* ============================== 行内三元（一个判据核） ============================== */

/** 行内条件记号检测（只对 FORM 行有语义：非 FORM 行里它是字面字符） */
export function hasInlineCondition(text: string): boolean {
  return text.includes('\\@') || text.includes('@\\');
}

/** 一支行内条件拆出的三段（拆不出来 = 判据不满足，整行不动） */
export interface TernaryParts {
  cond: string;
  thenBranch: string;
  elseBranch: string;
}

/**
 * 单支拆段判据（两侧共用；旧写法是显示侧拆一遍、建议侧直接放弃整行——同一套语法的两份口径）：
 * 1. 必须有 `?`；2. `?` 后必须有 `#`（省略假分支的形态语料没有）；3. 条件段非空。
 */
export function splitTernarySpan(span: string): TernaryParts | null {
  const q = span.indexOf('?');
  if (q < 0) return null;
  const after = span.slice(q + 1);
  const h = after.indexOf('#');
  if (h < 0) return null;
  const cond = span.slice(0, q).trim();
  if (cond.length === 0) return null;
  return { cond, thenBranch: after.slice(0, h), elseBranch: after.slice(h + 1) };
}

/** 分支呈现：空 → 空串字面量；含 FORM 记号或引号 → 原样；纯字面 → 加引号（规范 §3.4 禁嵌套插值） */
export function ternaryBranch(raw: string): string {
  const t = raw.trim();
  if (t.length === 0) return '""';
  return /[%"{}]/.test(t) ? t : `"${t}"`;
}

/** 三段的渲染回调（显示侧给反糖后的条件、写回侧给原样条件——**判据同一份，词表各取所需**） */
export interface TernaryRender {
  /** 体外文本 */
  outer: (text: string) => string;
  /** 条件段 */
  cond: (cond: string) => string;
  /** 分支段（缺省 = `ternaryBranch`） */
  branch?: (raw: string) => string;
}

/**
 * 整行行内条件 → 糖三元（成对性判据 + 逐支拆段；任一条不满足 → `undefined` = 整行不动）。
 *
 * 语料实测（2,285 文件、该记号出现 8,582 行）：**7,997 行恰成一对**，
 * 而 3 / 5 个的共 18 行是断串——不猜。
 */
export function inlineConditionsToSugar(body: string, render: TernaryRender): string | undefined {
  const parts = body.split('\\@');
  if ((parts.length - 1) % 2 !== 0) return undefined;
  const branch = render.branch ?? ternaryBranch;
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      out += render.outer(parts[i]!);
      continue;
    }
    const t = splitTernarySpan(parts[i]!);
    if (t === null) return undefined;
    out += `{${render.cond(t.cond)} ? ${branch(t.thenBranch)} : ${branch(t.elseBranch)}}`;
  }
  return out;
}

/* ============================== 代词 / 属性（同一通道，两种用途） ============================== */

/**
 * **代词**反糖（`%CALLNAME:TARGET%` → `{她}`）为什么**写回也成立**：正向 `PRONOUN_MAP`
 * 的产物恰是那个 `%…%` 串，而 `codegen.classifyInterpolation` 对已是 `%…%` 的降糖结果
 * **原样透传**（不再包一层定界符）⇒ 正反对称是**构造事实**，不是巧合。
 *
 * 与**属性**反糖的分界（本批唯一需要钉死的语义差别）：`{CFLAG:TARGET:1088}` →
 * `{她的好感度}` 看着像糖，但降糖回来是 `{CFLAG:TARGET:1088}`——百分号插值在糖里会变成
 * 花括号形（定界符换了）⇒ 逐字节不等 ⇒ **只显不写**。
 */
export const PRONOUN_WRITABLE = true;
export const ATTRIBUTE_WRITABLE = false;
/** 族头中文化 / 函数名中文反显：糖层产物仍是英文原文 ⇒ 只显不写 */
export const NAME_ALIAS_WRITABLE = false;
/** 函数头 → 「时机 …：」（批 I 的时机名反解）：建议侧不产函数头候选 ⇒ 只显不写 */
export const FACE_HEAD_WRITABLE = false;

/* ============================== 别名（文件级声明） ============================== */

/** 触发「值得起别名」提示的最小重复次数（引入一行声明至少要省出 3 处才划算） */
export const ALIAS_MIN_OCCURRENCES = 3;

/**
 * 变量引用形态：`FAMILY:SEG` / `FAMILY:SEG:SEG`（如 `CFLAG:TARGET:1088`）。
 * 段内可能含中文（`TALENT:TARGET:胆怯`），故按"非分隔符"字符集而非 `\w`。
 */
export const VAR_REF_RE = /\b([A-Z][A-Z0-9_]*)((?::[^\s:%「」(){}]+)+)/g;

/**
 * **别名的用途标志位**（S5 实测定案；W5 从"藏在注释里"提升为表上的显式判据）：
 *
 * `writable = false` —— 别名是糖源码层的**预处理**（先把裸标识符换成目标、再降糖），
 * 而原生 ERB 里出现的引用**没有一种**是糖层会介入的形态（百分号插值 / 全大写直通行 /
 * 赋值左值都原样透传）。把引用换成别名后产物必然与原来不同 ⇒ round-trip 恒失败。
 *
 * `displayable = false` —— 别名是**文件级**声明、不是"这一行的糖写法"，投影不产出任何行。
 *
 * 两侧仍**共用同一个扫描**（`collectVarRefs` / `aliasCandidates`）：建议侧照常报告
 * "这里重复了 N 次，写糖时值得起个别名"（`not-covered`，不静默），显示侧不动。
 */
export const ALIAS_WRITABLE = false;
export const ALIAS_DISPLAYABLE = false;

/** 重复引用扫描（两侧共用；`skip` = 哪些行不参与统计） */
export function collectVarRefs(
  lines: readonly string[],
  skip: (content: string) => boolean = (c) =>
    c.length === 0 || c.startsWith(';') || c.startsWith('@') || c.startsWith('#'),
): Map<string, number[]> {
  const counts = new Map<string, number[]>();
  for (let i = 0; i < lines.length; i++) {
    const content = contentOf(lines[i]!);
    if (skip(content)) continue;
    for (const m of content.matchAll(VAR_REF_RE)) {
      const ref = `${m[1]}${m[2]}`;
      const list = counts.get(ref);
      if (list) list.push(i + 1);
      else counts.set(ref, [i + 1]);
    }
  }
  return counts;
}

/** 出现 ≥ `ALIAS_MIN_OCCURRENCES` 次的引用（同分按首次出现行升序，保证确定性） */
export function aliasCandidates(counts: ReadonlyMap<string, number[]>): Array<[string, number[]]> {
  return [...counts.entries()]
    .filter(([, ls]) => ls.length >= ALIAS_MIN_OCCURRENCES)
    .sort((a, b) => b[1].length - a[1].length || a[1][0]! - b[1][0]!);
}
