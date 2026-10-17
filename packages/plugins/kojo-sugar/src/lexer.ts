/**
 * 三段式转译 · 第一段（行式词法）+ 第二段（缩进配对 → SugarNode AST）。
 *
 * 词法决策（照抄规范 §3 / §5.3，不自由发挥）：
 * - **逻辑行**：行尾 `\` 折行合并为一条逻辑行（规范 §3.10）；产物只生成一条 PRINT；
 * - **块头** = 以全角 `：`（或等价半角 `:`）结尾的行；块体缩进必须**更深**；
 * - **缩进**：TAB 或 N 个空格（统一折算为缩进层级）；缩进异常报 `indent-mismatch`
 *   并**阻止编译**（规范 §5.3：不生成半成品 ERB）；
 * - **原生直通**：全大写指令行 / `$标签` → `RawLine`；行首 `@` → `RawFunctionBlock`
 *   （直到下一个 `@` 行或文件末尾，整块原样透传，规范 §3.10）；
 * - **注释** `;` 起至行尾；编辑器显示灰色，不进 AST 正文（但进 `loc`）。
 */

import type {
  AliasDecl,
  AliasValue,
  HeartLine,
  IfBlock,
  IfBranch,
  IfExpr,
  Interpolation,
  RandomBlock,
  RandomInline,
  RawFunctionBlock,
  RawLine,
  SugarDiagnostic,
  SugarDoc,
  SugarFrontMatter,
  SugarNode,
  SugarPosition,
  SugarSourceSpan,
  SugarTopLevelNode,
  TextLine,
  TimingBlock,
  TimingMessageCheck,
  TimingNamedParam,
  WhenBlock,
  WhenBlock as WhenBlockT,
  WhenBranch,
  WhenCaseValue,
  WhenExpr,
} from '@kojo/plugin-api';
import {
  argTokenToEngineToken,
  canonicalTimingParamName,
  CONT_MARKS,
  HEAD_DECL_KEYS,
  FULLWIDTH_SPACE,
  FULLWIDTH_COLON,
  endsWithBlockColon,
  lookupKeyword,
  stripBlockColon,
  WAIT_MARKS,
  TIMING_ARGS_PARAM,
  type KeywordId,
} from './keywords';
import { STATEMENT_FUNCTIONS } from './statement-functions';
import type { DiagnosticSink } from './types';

/* ============================== 物理行 → 逻辑行 ============================== */

/**
 * 折行段（S6 列级映射的地基）：一条逻辑行由哪几个**物理行**拼成。
 *
 * 折行把多条源行合成一条产物行 ⇒ 只有知道「逻辑偏移落在哪个物理行」，
 * 产物列才能折回**正确的源行与源列**（而不是统统落回首行起点）。
 */
export interface FoldSegment {
  /** 该段起点在**逻辑文本**里的 0 基码元偏移 */
  offset: number;
  /** 该段所属物理行（1 基） */
  line: number;
  /** 该段首字符在物理行里的列（1 基；UTF-16 码元。续接行按 `trimStart` 合并 ⇒ 跳过行首空白） */
  column: number;
}

/** 逻辑行：一条"逻辑上不可分"的源行（`\` 折行已合并） */
export interface LogicalLine {
  /** 首个物理行的行号（1 基） */
  line: number;
  /** 最后一个物理行的行号（1 基） */
  endLine: number;
  /** 合并后的文本（不含行尾换行；`\` 与换行已剥离） */
  text: string;
  /** 缩进层级（0 基；TAB 或 2/4 空格折算） */
  indent: number;
  /** 原始缩进前缀（用于诊断消息） */
  rawIndent: string;
  /** 折行段（升序；未折行 = 单段 `{offset:0, line, column:1}`） */
  segments: readonly FoldSegment[];
}

/**
 * 把源文本切成逻辑行。
 *
 * 折行规则（规范 §3.10）：行尾 `\`（可后随空白）表示"物理折行、逻辑同一行"。
 * 合并时**去掉** `\`，并把下一行按 `trimStart` 续接（缩进不进入内容）。
 */
export function splitLogicalLines(source: string): LogicalLine[] {
  const physical = source.split(/\r\n|\r|\n/);
  const out: LogicalLine[] = [];
  let i = 0;
  while (i < physical.length) {
    const startLine = i + 1;
    let text = physical[i]!;
    let endLine = startLine;
    const segments: FoldSegment[] = [{ offset: 0, line: startLine, column: 1 }];
    // 折行续接：仅在行尾（去尾空白后）为 `\` 时合并
    while (/(^|[^\\])\\\s*$/.test(text)) {
      text = text.replace(/\\\s*$/, '');
      i++;
      if (i >= physical.length) break;
      endLine = i + 1;
      const next = physical[i]!;
      // `trimStart` 去掉的**码元**数 = 续接段在物理行里的起始列（-1）；
      // 用长度差而非正则，口径与 JS 的空白定义（含全角空格 U+3000）逐字一致。
      const head = next.length - next.trimStart().length;
      segments.push({ offset: text.length, line: endLine, column: head + 1 });
      text += next.trimStart();
    }
    const rawIndentMatch = /^[ \t\u3000]*/.exec(text)!;
    const rawIndent = rawIndentMatch[0];
    out.push({
      line: startLine,
      endLine,
      text,
      indent: indentLevel(rawIndent),
      rawIndent,
      segments,
    });
    i++;
  }
  return out;
}

/**
 * 源侧「逻辑行」视图（S6 列级映射用；键 = 该逻辑行的**首个物理行号**，1 基）。
 *
 * 转译是 `source → AST → 产物` 的单向流，codegen 手里只有节点 `loc`；本视图补上
 * 「那一行的逻辑全文 + 折行段」，让列区段能在**生成时**就地校验并落到物理列，
 * 而不是事后拿正则去产物里回推（产物里没有源列信息，回推只能猜）。
 */
export interface SourceLineView {
  /** 合并折行后的逻辑全文（含首行缩进） */
  readonly text: string;
  /** 折行段（升序；未折行 = 单段） */
  readonly segments: readonly FoldSegment[];
}

export function sourceLineViews(source: string): Map<number, SourceLineView> {
  const map = new Map<number, SourceLineView>();
  for (const line of splitLogicalLines(source)) map.set(line.line, { text: line.text, segments: line.segments });
  return map;
}

/**
 * 逻辑偏移（0 基码元）→ 物理源位置（1 基列）。越界按尾段夹紧，绝不抛错——
 * 列映射是**查询**，宁可给保守值也不静默失败。
 */
export function logicalPosition(segments: readonly FoldSegment[], offset: number): SugarPosition {
  let seg = segments[0] ?? { offset: 0, line: 1, column: 1 };
  for (const s of segments) {
    if (s.offset > offset) break;
    seg = s;
  }
  return { line: seg.line, column: seg.column + Math.max(0, offset - seg.offset) };
}

/** 缩进折算：TAB = 1 级；空格每 4 个 = 1 级（余数按 1 级算，避免半级丢失）；全角空格同理 */
function indentLevel(rawIndent: string): number {
  let tabs = 0;
  let spaces = 0;
  for (const ch of rawIndent) {
    if (ch === '\t') tabs++;
    else if (ch === FULLWIDTH_SPACE) spaces += 2;
    else if (ch === ' ') spaces += 1;
  }
  return tabs + (spaces > 0 ? Math.ceil(spaces / 4) : 0);
}

/** 去掉行首缩进与行尾空白（保留内部空白） */
export function contentOf(line: LogicalLine): string {
  return line.text.slice(line.rawIndent.length).replace(/\s+$/, '');
}

/**
 * 行内第一个**引号外** `;` 的下标（没有则 -1）。`stripInlineComment` 与格式化共用这一份
 * 判据——"注释从哪开始"有两份实现就会分叉（格式化按另一套切，注释掉进代码里就是改语义）。
 */
export function inlineCommentIndex(content: string): number {
  let inStr = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (ch === '"') inStr = !inStr;
    else if (ch === ';' && !inStr) return i;
  }
  return -1;
}

/**
 * 结构化行的 `;` 行内注释剥离：截到行内第一个**引号外**的 `;`（含）为止。
 * 引号内的 `;` 属于字符串值（如字符串别名），不剥。文本行不经此函数——
 * 台词里的 `;` 是作者要打印的字符（见 `classifyLine` 的分派注释）。
 */
export function stripInlineComment(content: string): string {
  const i = inlineCommentIndex(content);
  return i < 0 ? content : content.slice(0, i).replace(/\s+$/, '');
}

/* ============================== 行分类（词法决策） ============================== */

/** 行类别 */
export type LineClass =
  | { kind: 'blank' }
  | { kind: 'comment' }
  | { kind: 'rawLine'; text: string }
  | { kind: 'rawBlockStart' }
  | { kind: 'headDecl'; key: KeywordId; value: string }
  | {
      kind: 'aliasDecl';
      name: string;
      value: AliasValue;
      /** 右值形态残缺（有顶层 `?` 但非完整条件）→ 由 parser 报 `alias-unknown-target` */
      malformed?: boolean;
    }
  /** 文件级常量声明 `常量 <名> = <值>`（7 号批）——编译期展开为字面量，产物零声明 */
  | { kind: 'constDecl'; name: string; value: string; malformed?: boolean }
  | { kind: 'switchItem'; name: string; value: string }
  | { kind: 'timingHead'; face: string; index?: string; indexName?: string; namedParams: TimingNamedParam[] }
  | { kind: 'customCommandHead'; name: string; index?: number; canCom?: string; comCounter?: string }
  | { kind: 'ifHead'; variant: 'if' | 'elseif' | 'else'; condition: string; inline?: string }
  | { kind: 'whenHead'; subject: string }
  | { kind: 'caseHead'; values: WhenCaseValue[] }
  | { kind: 'randomHead' }
  | { kind: 'randomInline'; alternatives: string[] }
  /** 文件头选项 `随机形: <值>`（P-4；`直出` = 随机块直出形，别的值按缺省形处理） */
  | { kind: 'randomShapeDecl'; value: string }
  | { kind: 'groupHead' }
  | { kind: 'sectionHead'; condition: string }
  /** `初回 "key"：` 块头（1 号任务；产物 = `IF ONCE(<key>)` … `ENDIF`） */
  | { kind: 'onceHead'; key: string }
  /** `选项：` 块头（按钮形；产物 PRINTBUTTON + INPUTS + SELECTCASE RESULTS） */
  | { kind: 'choiceHead' }
  /** `菜单：` / `menu：` 块头（数字输入菜单形；产物 PRINTL [n] + INPUT + SELECTCASE RESULT + 回跳环） */
  | { kind: 'menuHead' }
  /**
   * `询问 [提示]：` / `ask [提示]：` 块头（引擎封装多选问答；产物 `CALL <adapter 函数>(...)` +
   * `SELECTCASE`）。`prompt` = 头部可选提问文案原文（缺省 = 不产提示行）。
   */
  | { kind: 'askMHead'; prompt?: string }
  /**
   * `确认 [提示]：` / `confirm [提示]：` 块头（引擎封装二择问答；产物同上，模板不同）。
   */
  | { kind: 'askYNHead'; prompt?: string }
  | { kind: 'choiceItem'; label: string }
  | { kind: 'colorHead'; color: string }
  /** `心形：` / `heart：` 连续块头（P-7；块体是文本行，逐行产 HPH_PRINT） */
  | { kind: 'heartHead' }
  | { kind: 'exprHead'; variant: 'if' | 'when'; target: string; rest: string }
  | { kind: 'messageCheck'; scope: 'scene' | 'kojo'; condition: string }
  | { kind: 'arrowCase'; values: WhenCaseValue[]; value: string }
  | { kind: 'arrowElse'; value: string }
  /** 经验结算行（B5）：`结算 <引用> <op> <值>` → 产一行 `EXP:<引用> <op> <值>` 原生 ERB */
  | { kind: 'settle'; expr: string }
  /**
   * 数值增减行（1016 批）：`增减 <族>:<对象>:<槽> <op> <增量>` → 产一行
   * `CALL <族目标函数>(…)`。`ref` = `族:对象:槽` 原文；`op` ∈ `+=` / `-=` / `=`；
   * `delta` = 增量表达式原文。**族 → 目标函数 + 参数序由 adapter 增减族表声明**
   * （游戏知识只住 adapter），codegen 只查不解释；未登记族 / 变量槽形态不符 fail-closed。
   */
  | { kind: 'mutator'; ref: string; op: '+' | '-' | '='; delta: string }
  /**
   * 行首语句形中文函数调用（位糖 = 方案 E；v1.7）：`设置标记 X, n` → `SETBIT X, n` 等。
   * `engine` = 原生 ERB 语句形函数名（白名单 `statement-functions.ts` 单一真源）；
   * `target` = 变量引用原文；`slot` = 位号表达式原文（皆在 codegen 降糖）。
   */
  | { kind: 'statementCall'; engine: string; target: string; slot: string }
  | { kind: 'assign'; target: string; expr: string }
  | { kind: 'blankLine'; wait: boolean }
  | { kind: 'heartText'; raw: string }
  | { kind: 'text'; raw: string }
  /* ---- 用户函数最小面（B4 批） ---- */
  /**
   * 函数声明块头 `函数 <名>(形参,…)：` / `function <名>(…)：`（B4 批；形参默认值见
   * `defaults`——本批新增 `形参 = 整数` 形）。
   */
  | {
      kind: 'functionHead';
      name: string;
      params: string[];
      /** 与 `params` 下标对齐的默认值**原文**（无默认值位 = undefined；只做词法拆分） */
      defaults?: (string | undefined)[];
    }
  /** 语句位置的用户函数调用 `调用 <名>(实参,…)` / `call <名>(…)` */
  | { kind: 'callStatement'; name: string; args: string }
  /** 函数体返回值 `返回 [值]` / `return [值]`（裸 `返回` = 过程函数收尾） */
  | { kind: 'returnStatement'; value?: string }
  /* ---- 单行条件（本批） ---- */
  /**
   * `如果 <条件> 则 <语句>` —— 整行一条语句（产物 `SIF <条件>` + 紧随一条语句行）。
   * `statementOffset` = 语句原文在**去注释后的整行内容**里的 0 基码元偏移
   * （parser 据它合成"语句行"以复用既有语句分类与列映射）。
   */
  | { kind: 'singleIfHead'; condition: string; statement: string; statementOffset: number };

/**
 * `空行` / `blank`（可带一个行尾标记）→ 一条"输出一行空行"的语句（规范 §3.3，批 P）。
 *
 * 判据是**整行恰好是这个词**：台词里出现"空行"两个字的写法（`空行是什么`、`「空行」`）
 * 绝不能被当成指令——那会把作者要打印的字变成控制语句。标记只认 `CONT_MARKS` / `WAIT_MARKS`
 * 那两组，`空行 不等待` 一类自造说法不认（宁可作者写 `空行` / `空行 续` / `空行 等待`）。
 *
 * **默认不等待**（v1.5，对齐语料主流）：`空行` → 裸 `PRINTFORML`；`空行 等待`（`WAIT_MARKS`）
 * 才落 `PRINTFORMDW`。`续`（`CONT_MARKS`）与默认同义（都 = 不等待），保留以兼容既有写法。
 */
const BLANK_LINE_RE = /^(空行|blank)(?:[ \t]+(\S+))?$/i;

function matchBlankLine(code: string): { kind: 'blankLine'; wait: boolean } | null {
  const m = BLANK_LINE_RE.exec(code);
  if (!m) return null;
  const mark = m[2];
  if (mark === undefined) return { kind: 'blankLine', wait: false };
  if (CONT_MARKS.includes(mark)) return { kind: 'blankLine', wait: false };
  return WAIT_MARKS.includes(mark) ? { kind: 'blankLine', wait: true } : null;
}

/* ---------------------- 用户函数最小面（B4 批）：调用 / 返回 ---------------------- */

/** `调用 <名>(实参,…)` 的行首判定：词后必须跟空白（`调用 名字` 形态） */
const CALL_STATEMENT_RE = /^(调用|call)[ \t\u3000]+(.+)$/;
/** 裸 `返回` / `return`（整行恰为该词） */
const RETURN_BARE_RE = /^(返回|return)$/;
/** `返回 <值>` / `return <值>`（词后跟空白与一个值） */
const RETURN_VALUE_RE = /^(返回|return)[ \t\u3000]+(.+)$/;

/**
 * `调用 <名>(实参,…)` / `调用 <名>`（B4 批）→ 语句位置**用户函数调用**。
 *
 * 判据：行首恰为 `调用` / `call`，其后跟空白。实参括号可选（中/半角括号均可）；
 * 无括号 = 无实参调用。**实参原文整串交给 codegen**（与系统函数名同一条降糖管线）。
 */
function parseCallStatement(code: string): { kind: 'callStatement'; name: string; args: string } | null {
  const m = CALL_STATEMENT_RE.exec(code);
  if (!m) return null;
  const target = m[2]!.trim();
  if (target.length === 0) return null;
  const paren = /^([^(（]*?)\s*[（(]\s*(.*?)\s*[)）]$/.exec(target);
  if (paren) {
    const name = paren[1]!.trim();
    if (name.length === 0) return null;
    return { kind: 'callStatement', name, args: paren[2]!.trim() };
  }
  return { kind: 'callStatement', name: target, args: '' };
}

/**
 * `返回 [值]`（B4 批）→ 函数体**返回值**语句。
 *
 * 判据与 `空行` 同款"整行/词+空白"边界：
 * - 整行恰为 `返回` / `return` → 裸返回（过程函数收尾，产物落 `RETURN`）；
 * - 后跟空白与一个值 → 值返回（产物落 `RETURNF <值>`，函数头挂 `#FUNCTION`/`#FUNCTIONS`）。
 */
function parseReturnStatement(code: string): { kind: 'returnStatement'; value?: string } | null {
  if (RETURN_BARE_RE.test(code)) return { kind: 'returnStatement' };
  const m = RETURN_VALUE_RE.exec(code);
  if (!m) return null;
  const value = m[2]!.trim();
  if (value.length === 0) return { kind: 'returnStatement' };
  return { kind: 'returnStatement', value };
}

/* ------------------ 数值增减行（1016 批）：`增减 <族>:<对象>:<槽> <op> <增量>` ------------------ */

/** `增减` / `adjust` 行体的结构切分（词后正文 → `ref` / `op` / `delta` 三段原文） */
interface MutatorParts {
  readonly ref: string;
  readonly op: '+' | '-' | '=';
  readonly delta: string;
}

/**
 * 把 `增减` 之后的正文切成 `族:对象:槽` / 运算符 / 增量三段（纯词法，不解释族语义）。
 *
 * 运算符取**首个**顶层出现的 `+=` / `-=` / 裸 `=`，且**排除比较运算符**
 * （前一字符为 `=` / `!` / `<` / `>` / `\` 时不算）——`增减 CFLAG:TARGET:2 等于 3`
 * 走运算符表（`=` 前后带空白）时不会在此被误切。
 *
 * 三段缺任一（无 ref / 无运算符 / 空增量）→ 返回 `null`：退回普通文本行（同 `结算`
 * 的结构残缺退化口径）。三段内容**原样**交给 codegen——族 / 对象 / 槽的语义由
 * adapter 增减族表声明，转译器不解释（游戏知识只住 adapter）。
 */
function parseMutatorLine(body: string): MutatorParts | null {
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '=') continue;
    const prev = i > 0 ? body[i - 1]! : '';
    // 比较运算符族一律不算赋值运算符：`!=` / `<=` / `>=`（前字符）+ `==`（后字符）
    if (prev === '=' || prev === '!' || prev === '<' || prev === '>' || prev === '\\') continue;
    if (body[i + 1] === '=') continue;
    let op: '+' | '-' | '=';
    let refEnd: number;
    if (prev === '+') {
      op = '+';
      refEnd = i - 1;
    } else if (prev === '-') {
      op = '-';
      refEnd = i - 1;
    } else {
      op = '=';
      refEnd = i;
    }
    const ref = body.slice(0, refEnd).trim();
    const delta = body.slice(i + 1).trim();
    if (ref.length === 0 || delta.length === 0) return null;
    return { ref, op, delta };
  }
  return null;
}

/* ------------------ 行首语句形中文函数调用（位糖 = 方案 E；v1.7） ------------------ */

/** 白名单关键字整词 + 其后必须跟空白（半角或全角）——词形边界天然排除 `设置标记xx` / `置位状態` */
const STATEMENT_FN_RE = new RegExp(`^(${[...STATEMENT_FUNCTIONS.keys()].join('|')})[ \\t\\u3000]+(.*)$`);

/**
 * `设置标记 <变量引用>, <位号表达式>`（严格白名单 3 枚）→ 行首语句形中文函数调用。
 *
 * `X`（变量引用）与 `n`（位号表达式）都只是**原文**——代词/别名/中文运算符/系统函数名
 * 的降糖都在 codegen 完成（别名表、字典、`expandTarget`/`lowerExpression` 都在那边）。
 * 此处只做：整词判定 + **赋值守卫** + 顶层逗号切分。
 *
 * **赋值守卫**：关键字后首个非空白字符若是 `=`，拒绝本形态（退回普通赋值判定）——
 * 否则 `设置标记 = 1` 这类把关键字吞成左值前缀的静默 bug 会在此重演（同 `结算` 行
 * 排在上方的理由）。
 */
function parseStatementFunction(
  code: string,
): { kind: 'statementCall'; engine: string; target: string; slot: string } | null {
  const m = STATEMENT_FN_RE.exec(code);
  if (!m) return null;
  const name = m[1]!;
  const rest = m[2]!;
  if (rest.trimStart().startsWith('=')) return null; // 赋值守卫
  const engine = STATEMENT_FUNCTIONS.get(name);
  if (engine === undefined) return null;
  const parts = splitTopLevel(rest, /[,，]/);
  const target = parts[0]!.trim();
  if (target.length === 0) return null;
  const slot = parts.length > 1 ? parts.slice(1).join('，').trim() : '';
  return { kind: 'statementCall', engine, target, slot };
}

/* ---------------------- 单行条件（本批）：`如果 <条件> 则 <语句>` ---------------------- */

/** 行首 `如果` / `if` + 空白 + 余下正文（`则` 分隔词的界标判定在 `trySingleIfStatement` 内做） */
const SINGLE_IF_HEAD_RE = /^(如果|if)[ \t\u3000]+(.+)$/;
/**
 * `则` / `then` 分隔词：**带空白边界**——前有空白（或行首）、后有空白（或行尾）。
 * 只在条件里出现"独立的 `则` 词"时才切两段；`「则」`（引号内无空白边界）不受影响。
 */
const SINGLE_IF_SEP_RE = /(?:^|[ \t\u3000])(?:则|then)(?=[ \t\u3000]|$)/;

/**
 * `如果 <条件> 则 <语句>`（本批）→ **单行条件**。
 *
 * 判据：行首恰为 `如果` / `if`，其后跟空白，且余下正文里有一个**独立**的 `则` / `then`
 * 分隔词（前后带空白边界）。条件为空 / `则` 后无语句仍返回类别（两段为空串），
 * 由 parser 落 error、**不产半成品**（与"块头无体"同一口径）。
 *
 * 切分后各段用 `trim` 归整；`statementOffset` 给出语句原文在**去注释后内容**里的起点，
 * 供 parser 合成语句行（列映射定准）。**未去注释**时（`code` 是 `content` 的前缀）偏移
 * 可直接当 `content` 的偏移用。
 */
function trySingleIfStatement(content: string): LineClass | null {
  const m = SINGLE_IF_HEAD_RE.exec(content);
  if (!m) return null;
  const rest = m[2]!;
  const sep = SINGLE_IF_SEP_RE.exec(rest);
  if (!sep) return null;
  // 分隔词自身宽度（去掉可能的**前置空白**——`m[0]` 可能是 ` 则` 形态）
  const sepTokenLen = sep[0]!.replace(/^[ \t\u3000]*/, '').length;
  const sepIdxInRest = sep.index + sep[0]!.length - sepTokenLen;
  const after = rest.slice(sepIdxInRest + sepTokenLen);
  const lead = after.length - after.trimStart().length;
  const statement = after.trim();
  const statementOffset = content.length - rest.length + sepIdxInRest + sepTokenLen + lead;
  return {
    kind: 'singleIfHead',
    condition: rest.slice(0, sepIdxInRest).trim(),
    statement,
    statementOffset,
  };
}

/** 全大写原生指令判定（规范 §3.10）：`SETCOLOR` / `IF` / `CALL` / `RAND` / `TFLAG:193 = 0` */
const RAW_INSTR_RE = /^[A-Z][A-Z0-9_]*(?:[:.][^\s]*)?(?:\s|=|$)/;

/** CJK 区段（平假名 / 片假名 / 汉字 / 半角片假名）——下面两个字符类共用这一份区间 */
const CJK_RANGES = '\\u3040-\\u30ff\\u4e00-\\u9fff\\uff66-\\uff9f';

/**
 * 含 CJK——中文指令名判定（HK-11②）。
 * **单一真源**：`codegen.ts` 的 `当/是` CASE 值判定（P-5）复用本串，别再抄第二份
 * （E16 刚为两份 `isIdentPart` 副本付过返工代价）。
 */
export const CJK = new RegExp(`[${CJK_RANGES}]`);

/**
 * 「名字令牌」字符类**源**（正反两侧单一真源）：ASCII 标识符字符 + 上面那批 CJK 区间。
 *
 * - 正向（本模块）：`时机 <分野> <令牌>` 的令牌判定（HK-11②）；
 * - 反向（`faces-reverse`）：`{i}` 槽的锚定正则。
 *
 * 两侧不同源就会出现「写得出来、读不回来」的往返不闭合——实测坑：尾部形态名
 * `特殊エフェクト` 含**片假名**，旧字符类 `[0-9A-Za-z_\u4e00-\u9fff]` 把它整头判掉。
 */
export const NAME_TOKEN_CHARS = `0-9A-Za-z_${CJK_RANGES}`;

/**
 * 行分类（纯函数；不做配对）。
 *
 * 判定顺序即优先级（照抄规范 §3.10 + §3.3）：
 * 原生直通 → 头部/别名 → 块头 → 表达式头 → 赋值 → 文本。
 * 顺序很重要：`IF TFLAG:193 = 0` 必须走原生直通而非"如果"糖（大小写不同，
 * 天然区分；但 `CALL X` 之类的中文里不可能出现）。
 */
export function classifyLine(line: LogicalLine): LineClass {
  const content = contentOf(line);
  if (content.length === 0) return { kind: 'blank' };
  if (content.startsWith(';')) return { kind: 'comment' };
  if (content.startsWith('@')) return { kind: 'rawBlockStart' };

  // ---- 原生直通（行）----
  if (RAW_INSTR_RE.test(content) || content.startsWith('$')) {
    return { kind: 'rawLine', text: content };
  }

  // ---- 结构化行的 `;` 行内注释剥离（引号内的 `;` 不剥）----
  // 头部声明 / 别名 / 赋值 / 子句 / 块头的值会进入函数名、别名表或表达式降糖——
  // 注释残留是**静默破坏**：规范 §3.1 的示例全带行内注释（`角色: 12 ; 必填…`），
  // 不剥则函数名里嵌进注释文本、别名值吞掉整段注释，产物看似能跑、引擎调不到、
  // 插值引用别名时逐词报 `unknown-identifier`（2026-10-12 教学样例批实证）。
  // 文本行与原生直通**不剥**：台词里的 `;` 是作者要打印的字符；ERB 直通行的
  // `;` 注释原样保留（那边本来就是合法注释）。
  const code = stripInlineComment(content);

  // ---- 单行条件 `如果 条件 则 语句`（本批）----
  // **必须先于块头判定**：`如果 X 则 Y`（无尾冒号）若先经块头判定会被当 `如果 X 则 Y` 的
  // 块头并吞掉后续缩进行。`则`/`then` 是**位置式**界标（带空白边界），条件里的变量名撞词
  // 不受影响；`「则」` 这类引号内的写法也切不到。
  const singleIf = trySingleIfStatement(code);
  if (singleIf) return singleIf;

  // ---- 块头优先（规范 §5.3：块头一律以冒号结尾）----
  // 注意：块头（`如果 …：` / `时机 …：` / `当 …：` …）也可能含冒号
  // （如 `时机 指令 310 成否: 游戏判定：`）。判据是"行尾是块头终止符"。
  if (endsWithBlockColon(code)) {
    const block = parseBlockHead(code);
    if (block) return block;
  }

  // ---- 单行块头 `如果 条件： 内容`（规范 §3.5）----
  // 块头关键字后跟 `：` 与行内体；编译为 `IF … / 体 / ENDIF` 三行。
  const inlineBlock = tryInlineBlockHead(code);
  if (inlineBlock) return inlineBlock;

  // ---- 无冒号的块关键字：行内随机简写 `随机 「甲」,「乙」`（§3.6 末）----
  // `随机` / `random` 后跟候选列表（以 `,` 分隔）时是行内简写形态。
  const inlineRandom = tryInlineRandom(code);
  if (inlineRandom) return inlineRandom;

  // ---- 头部声明 `词: 值`（词与冒号之间无空白；`角色: 12` / `口上: 破空`）----
  const headMatch = /^([^:：\s]+)\s*[:：]\s*(.*)$/.exec(code);
  if (headMatch) {
    const key = headMatch[1]!;
    const value = headMatch[2]!;

    // P-4 文件头选项 `随机形: 直出`——判定归本处位置式扫描（先于下方 `lookupKeyword`）。
    // `随机形` 本体已登记 `KEYWORDS`（head.randomShape，ZH-E 起）：**只为高亮/补全可见**，
    // 判定路径与登记互不相干——挂进 `HEAD_DECL_KEYS` 反而会改走 headDecl（值语义
    // 由 parser 的 applyHeadDecl 解释，那边没有这个键），口径说明见 keywords.ts 注释。
    if (key === '随机形') return { kind: 'randomShapeDecl', value: value.trim() };

    const kw = lookupKeyword(key);

    // 头部声明（`角色:` / `口上:` …）——注意 `开关:` 后跟缩进块
    if (kw && (HEAD_DECL_KEYS as readonly KeywordId[]).includes(kw)) {
      return { kind: 'headDecl', key: kw, value: value.trim() };
    }

    // 时机内子句 `隐藏情景: 如果 …` / `隐藏口上: 如果 …`（规范 §3.2；**行尾不带冒号**）
    if (kw === 'inline.hideScene') {
      return { kind: 'messageCheck', scope: 'scene', condition: stripConditionPrefix(value.trim()) };
    }
    if (kw === 'inline.hideKojo') {
      return { kind: 'messageCheck', scope: 'kojo', condition: stripConditionPrefix(value.trim()) };
    }
  }

  // ---- `别名 X = 目标`（规范 §3.1；**名与冒号间有空白**，故不进 headMatch）----
  const aliasMatch = /^(别名|alias)\s+(.+)$/.exec(code);
  if (aliasMatch) {
    return parseAliasDecl(aliasMatch[2]!);
  }

  // ---- `常量 <名> = <值>`（7 号批：文件级常量 → 编译期展开，产物零声明）----
  // 与 `别名 X = 目标` 同款"一行一条、词后跟空白"形态（`常量名` 这类无空白的词形不识别）。
  // **排在 `parseAssignment` 之前**：否则 `常量 X = 1022` 会被赋值扫描吞成左值 `常量 X`
  // （同 `结算` 行排在赋值之前的理由）。
  const constMatch = /^(常量|const)\s+(.+)$/.exec(code);
  if (constMatch) {
    return parseConstDecl(constMatch[2]!);
  }

  // ---- 表达式 如果 / 当（赋值位置；规范 §3.5 / §3.6 识别规则）----
  // 行首是"目标变量 + `=`"、右侧以 `如果`/`当` 开头、行尾是块头冒号。
  // **不依赖 headMatch**——目标变量名可能含空白（如 `她的心情 = 当 …：`）。
  if (endsWithBlockColon(code)) {
    const exprHead = parseExprHead(stripBlockColon(code));
    if (exprHead) return exprHead;
  }

  // ---- 经验结算行（B5）：`结算 <表达式>` → `EXP:<表达式>` ----
  // 行级糖：把 `EXP:` 变量族的一次经验结算收成一行可读糖。表达式**原文逐字**接到
  // `EXP:` 前缀后——省略/显式作用域两形态都归作者写（转译器不解释作用域词、也不编名字）。
  // 排在赋值（`parseAssignment`）**之前**：`结算 Ｍ经验 += 1` 里的 `+=` 会被赋值扫描
  // 误吞成左值 `结算 Ｍ经验 +`。手写 `EXP:…` 行不受此影响——它们由更早的 `RAW_INSTR_RE`
  // 截获（全大写族头），只有本糖关键字以 CJK 起头时才需要在这里守门。
  const settleHead = /^(\S+)[ \t\u3000]+(.+)$/.exec(code);
  if (settleHead && lookupKeyword(settleHead[1]!) === 'inline.settle') {
    return { kind: 'settle', expr: settleHead[2]!.trim() };
  }

  // ---- 数值增减行（1016 批）：`增减 <族>:<对象>:<槽> <op> <增量>` ----
  // 与 `结算` 同款"词 + 空白 + 余下正文"的位置式判定（不走关键字表）。三元结构
  // `族:对象:槽` + 运算符 + 增量；运算符切分须**排除比较运算符**（`==` / `!=` /
  // `<=` / `>=`）——否则 `增减 CFLAG:TARGET:2 等于 3` 类写法会被误吞。结构残缺
  // （无 ref / 无运算符 / 空增量）→ 返回 null，退回普通文本行（同 `结算` 的退化口径）。
  const mutHead = /^(增减|adjust)[ \t\u3000]+(.+)$/.exec(code);
  if (mutHead) {
    const parsed = parseMutatorLine(mutHead[2]!);
    if (parsed) return { kind: 'mutator', ...parsed };
    // 结构残缺（无运算符 / 空增量 / 比较运算符）→ **直接落文本行**：不能让
    // `增减 CFLAG:TARGET:2 +=` 掉进赋值扫描被吞成左值 `增减 CFLAG:TARGET:2 +`
    // （那会报 `unknown-identifier` 且产出半成品赋值行）。与 `结算` 退化口径一致：
    // 原样打印、不静默吞、不产 CALL。
    return { kind: 'text', raw: content };
  }

  // ---- 行首语句形中文函数调用（位糖 = 方案 E；v1.7）：`设置标记 X, n` ----
  // 严格白名单 3 枚（`statement-functions.ts` 单一真源）。**排在赋值（`parseAssignment`）之前**：
  // `设置标记 她的既成事実, 0` 若无此判定会落兜底 `text` 被当旁白静默吞掉（违反「内核不静默」）。
  // 插在本处（结算之后、赋值之前）——不与块头 / 头部声明 / 别名 / 调用 / 返回 / 结算抢道。
  const stmtFn = parseStatementFunction(code);
  if (stmtFn) return stmtFn;

  // ---- 赋值（`X = 表达式`）——`=` 不在引号内、不是比较运算符 ----
  const assign = parseAssignment(code);
  if (assign) return assign;

  // ---- `调用 名字(实参)` / `返回 [值]`（B4 批：用户函数最小面）----
  // 语句位置的调用与返回值。两者都是**整行语句**（不带块头冒号），判据与 `空行`
  // 同款"词后必须跟空白 / 整行恰为该词"——`「返回」` 这类引号内的写法不在此列。
  const call = parseCallStatement(code);
  if (call) return call;
  const ret = parseReturnStatement(code);
  if (ret) return ret;

  // ---- `空行`（规范 §3.3；批 P）----
  // 判据是**整行恰为该词**（可带行尾 `续` 类标记）：台词里出现"空行"两个字的写法
  // （`空行是什么` / `「空行」`）绝不能被当成指令——那是把作者要打印的字变成控制语句。
  const blank = matchBlankLine(code);
  if (blank) return blank;

  // ---- `心形 「…」`（规范 §3.9：行首心形标记 = HPH_PRINT 糖）----
  // 判定：行首为空白的 `心形` / `heart`，其后必须跟空白与内容。
  const heartMatch = /^(心形|heart)\s+(.*)$/.exec(code);
  if (heartMatch) {
    return { kind: 'heartText', raw: heartMatch[2]! };
  }

  // ---- 兜底：文本行（含 `续` 标记处理在 AST 层）----
  return { kind: 'text', raw: content };
}

/* ------------------------------ 头部 / 别名解析 ------------------------------ */

/**
 * 单行块头（规范 §3.5）：`如果 条件： 内容`。
 *
 * 块头关键字（`如果`/`否则如果`/`当`…）后跟顶层 `：` 与**行内体**。
 * `ifHead` 携带 `inline` 体原文；parser 把它转成一个行内语句节点。
 */
function tryInlineBlockHead(content: string): LineClass | null {
  // 条件段用**贪婪**匹配并回溯到**最后一个后跟空白的**块头冒号：
  // 条件里自身可能含冒号（`FLAG:70` / `CFLAG:2`），懒匹配会在那里截断。
  const m = /^([^\s:：]+)\s+(.+)[:：]\s+(\S.*)$/.exec(content);
  if (!m) return null;
  const kw = lookupKeyword(m[1]!);
  if (!kw) return null;
  const cond = m[2]!.trim();
  const inline = m[3]!.trim();
  if (cond.length === 0 || inline.length === 0) return null;
  switch (kw) {
    case 'block.if':
      return { kind: 'ifHead', variant: 'if', condition: cond, inline };
    case 'block.elif':
      return { kind: 'ifHead', variant: 'elseif', condition: cond, inline };
    default:
      return null;
  }
}

/**
 * 行内随机简写（规范 §3.6 末）：`随机 「甲」,「乙」` / `random「甲」,「乙」`
 * （无行尾冒号，故不进块头分支）。候选以顶层 `,` / `，` 分隔，且至少两个候选
 * （单个候选无随机意义，按普通文本处理更符合直觉）。
 */
function tryInlineRandom(content: string): LineClass | null {
  const m = /^(随机|random)\s+(.+)$/.exec(content);
  if (!m) return null;
  const alternatives = splitRandomAlternatives(m[2]!);
  if (alternatives.length < 2) return null;
  return { kind: 'randomInline', alternatives };
}

/** `别名 X = 目标` → `AliasDecl` 的原始形态 */
function parseAliasDecl(value: string): LineClass {
  const m = /^(\S+)\s*=\s*(.+)$/.exec(value.trim());
  if (!m) {
    return { kind: 'aliasDecl', name: value.trim(), value: { kind: 'number', text: '' } };
  }
  const name = m[1]!;
  const rhs = m[2]!.trim();
  const parsed = parseAliasValue(rhs);
  const malformed = hasTopLevelQuestion(rhs) && parsed.kind !== 'conditional';
  return malformed
    ? { kind: 'aliasDecl', name, value: parsed, malformed: true }
    : { kind: 'aliasDecl', name, value: parsed };
}

/**
 * `常量 <名> = <值>` → 原始形态（7 号批）。
 *
 * 只做**词法**拆分（名 / 值原文）；右值是否整数字面量、名是否合法一律交 `parser`
 * 校验并落诊断（与 `别名` 同一分工）。缺 `=` → 标 `malformed`，由 parser 报
 * `alias-unknown-target`（**不新增诊断码**）。
 */
function parseConstDecl(value: string): LineClass {
  const m = /^(\S+)\s*=\s*(.+)$/.exec(value.trim());
  if (!m) {
    return { kind: 'constDecl', name: value.trim(), value: '', malformed: true };
  }
  return { kind: 'constDecl', name: m[1]!, value: m[2]!.trim() };
}

/** 右值是否含顶层 `?`（引号 / 括号 / 花括号外）——用于识别"想写条件却没写完整"的残缺形态 */
function hasTopLevelQuestion(rhs: string): boolean {
  return findTopLevel(rhs.trim(), '?') >= 0;
}

/**
 * 别名右值形态（规范 §3.1 表 + 条件形态）。
 *
 * - `角色 N` / `char N` → `character`；
 * - `"…"` → `string`；
 * - 纯数字 → `number`；
 * - 顶层 `?`（+ 可选 `:`）→ `conditional`（与 `{}` 行内条件同形，规范 §3.4）；
 * - 其余（含 `CFLAG:TARGET:1088` / `DAY`）→ `variable`。
 *
 * 条件形态残缺（`?` 后缺条件或缺真分支）→ 退回 `variable` 并由调用方标记 `malformed`
 * （parser 报 `alias-unknown-target`——**不新增诊断码**）。
 */
export function parseAliasValue(rhs: string): AliasValue {
  const trimmed = rhs.trim();

  // 条件形态：顶层 `?`（真分支），可选 `:` 切假分支——与 `buildInterpolation` 同口径。
  const qIdx = findTopLevel(trimmed, '?');
  if (qIdx >= 0) {
    const cond = trimmed.slice(0, qIdx).trim();
    const branches = trimmed.slice(qIdx + 1);
    const colonIdx = findTopLevel(branches, ':');
    const thenRaw = colonIdx >= 0 ? branches.slice(0, colonIdx) : branches;
    const elseRaw = colonIdx >= 0 ? branches.slice(colonIdx + 1) : undefined;
    const thenText = unquote(thenRaw);
    const elseText = elseRaw === undefined ? undefined : unquote(elseRaw);
    if (cond.length > 0 && thenText.length > 0) {
      return elseText === undefined || elseText.length === 0
        ? { kind: 'conditional', cond, thenText }
        : { kind: 'conditional', cond, thenText, elseText };
    }
    // 残缺 → 退回 `variable`（调用方据 `hasTopLevelQuestion` 标 malformed）
    return { kind: 'variable', text: trimmed };
  }

  if (/^角色\s+\S+$/.test(trimmed) || /^char\s+\S+$/.test(trimmed)) {
    const no = trimmed.replace(/^(角色|char)\s+/, '').trim();
    return { kind: 'character', no };
  }
  if (/^".*"$/.test(trimmed)) {
    return { kind: 'string', text: trimmed.slice(1, -1) };
  }
  if (/^-?\d+$/.test(trimmed)) {
    return { kind: 'number', text: trimmed };
  }
  return { kind: 'variable', text: trimmed };
}

/** `时机 <分野> [编号] [命名参数…]` */
function parseTimingHead(value: string): LineClass | null {
  const inner = stripBlockColon(value.trim());
  if (inner.length === 0) return null;
  const parts = inner.split(/\s+/);
  const face = parts[0]!;
  if (face.length === 0) return null;
  let index: string | undefined;
  let indexName: string | undefined;
  const namedParams: TimingNamedParam[] = [];
  for (let i = 1; i < parts.length; i++) {
    const token = parts[i]!;
    // 命名参数形态：`成否: 游戏判定` 已被 `:` 切走，故在此只可能是 `X:` + 值
    if (token.endsWith('：') || token.endsWith(':')) {
      const name = canonicalTimingParamName(stripBlockColon(token));
      let val = parts[i + 1] ?? '';
      i++;
      // 值以逗号收尾 = 作者把令牌列表写成了 `ARG, ARG:1`（逗号后带空白）——
      // 续接到下一个令牌，令"逗号分隔列表"与"整串无空白"两种写法等价。
      // 只在**上一段以逗号结尾**时续接，故 `成否: 游戏判定 310` 这类既有写法不受影响。
      while (/[，,]$/.test(val) && i + 1 < parts.length) {
        val += parts[++i]!;
      }
      namedParams.push({ name, value: val, loc: zeroSpan() });
      continue;
    }
    // 只写了关键字、没写值：`时机 事件 1 参数:` 的那枚冒号**同时**是块头终止符，
    // 被 `stripBlockColon` 吃掉后只剩裸词 `参数`（英文别名 `args` 同理，且它在
    // "全是 ASCII"这一点上与编号同形，故必须**先于**编号判定）。绝不能当成"没写"
    // 静默放行——记一条空值命名参数，由 parser 报 error（想声明却没写完）。
    if (canonicalTimingParamName(token) === TIMING_ARGS_PARAM) {
      namedParams.push({ name: TIMING_ARGS_PARAM, value: '', loc: zeroSpan() });
      continue;
    }
    // HK-11②：编号可以是**中文指令名**（`时机 指令 摸屁股：`）——不能只认 ASCII，
    // 否则中文名会被静默丢弃（返工高危点）。数字仍进 `index`（旧写法逐字节不破），
    // 中文名进 `indexName`，由 codegen 经 adapter 指令表解析成编号（fail-closed）。
    if (index === undefined && indexName === undefined) {
      if (/^[0-9A-Za-z_]+$/.test(token)) {
        index = token;
        continue;
      }
      if (CJK.test(token)) {
        indexName = token;
        continue;
      }
    }
  }
  return {
    kind: 'timingHead',
    face,
    ...(index !== undefined ? { index } : {}),
    ...(indexName !== undefined ? { indexName } : {}),
    namedParams,
  };
}

/**
 * `自定指令 <中文名> [编号: N] [可否使用: <条件>] [计数器不发: <条件>]`（HK-12）。
 *
 * 与 `类型: 自定指令`（时机命名参数右值）**同名不同上下文**：这里只出现在
 * **行首块头**（由 `parseBlockHead` 经关键字表分派），右值路径不查关键字表。
 *
 * 可选子句（块头，顺序任意、可缺省）：
 * - `编号: N`（数字）：显式编号；缺省 = 由 codegen 在 adapter 的 `customComRange`
 *   内自动分配；
 * - `可否使用: <条件>`（HK-12 五钩子之 `CAN_COM`）：值为条件原文；
 * - `计数器不发: <条件>`（HK-12 五钩子之 `COM_Counter不发`）：值为条件原文。
 *
 * 子句键只在**后跟冒号**时才是子句（`编号\s*[:：]`）——名字里恰好含这些词
 * 不会误判（除非名字后紧跟冒号，那本身就不是合法名字）。
 */
function parseCustomCommandHead(rest: string): LineClass | null {
  const inner = rest.trim();
  if (inner.length === 0) return null;

  // 子句键扫描（键必须在词边界、且后跟全/半角冒号）
  const clauseRe = /(?:^|\s)(编号|可否使用|计数器不发)\s*[:：]/g;
  const marks: { key: string; start: number; valueStart: number }[] = [];
  for (let m = clauseRe.exec(inner); m !== null; m = clauseRe.exec(inner)) {
    marks.push({ key: m[1]!, start: m.index, valueStart: m.index + m[0].length });
  }
  if (marks.length === 0) {
    return { kind: 'customCommandHead', name: inner };
  }

  const name = inner.slice(0, marks[0]!.start).trim();
  if (name.length === 0) return null;

  let index: number | undefined;
  let canCom: string | undefined;
  let comCounter: string | undefined;
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]!;
    const end = i + 1 < marks.length ? marks[i + 1]!.start : inner.length;
    const value = inner.slice(mark.valueStart, end).trim();
    if (mark.key === '编号') {
      if (/^\d+$/.test(value)) index = Number(value);
    } else if (value.length > 0) {
      if (mark.key === '可否使用') canCom = value;
      else comCounter = value;
    }
  }
  return {
    kind: 'customCommandHead',
    name,
    ...(index !== undefined ? { index } : {}),
    ...(canCom !== undefined ? { canCom } : {}),
    ...(comCounter !== undefined ? { comCounter } : {}),
  };
}

/**
 * `函数 <名>(形参,…)：` / `函数 <名>：`（B4 批）→ 用户函数声明块头。
 *
 * 名后可选括号形参（中/半角括号均可；形参以中/半角逗号分隔）；无括号 = 无参。
 * 名与形参名的合法性不在此校验（产物命名走 adapter 模板，形参 → `ARG` 位置映射在
 * codegen；函数名最终形态由模板渲染，转译器只做占位符求值）。
 *
 * **形参默认值**（本批）：形参写成 `名 = <值>` 时，`<值>` 作为默认值原样输出到产物
 * 形参段（引擎声明位 `ARG = <值>`）。词法只做**位置式**拆分——形参片段以
 * `/^(\S+)\s*=\s*(.+)$/` 切出「名 / 值」，与 `常量` 批（`parseConstDecl`）逐字同款；
 * `=` 两侧空白自由、`名=值` 也认。**不在此判值是否整数**（交 parser 校验并落诊断）。
 * 无任何默认值时**不写** `defaults` 字段（既有产物逐字节不变）。
 */
function parseFunctionHead(rest: string): LineClass | null {
  const t = rest.trim();
  if (t.length === 0) return null;
  const paren = /^([^(（]*?)\s*[（(]\s*(.*?)\s*[)）]$/.exec(t);
  if (paren) {
    const name = paren[1]!.trim();
    if (name.length === 0) return null;
    const inner = paren[2]!.trim();
    const segs =
      inner.length === 0 ? [] : splitTopLevel(inner, /[,，]/).map((s) => s.trim()).filter((s) => s.length > 0);
    const params: string[] = [];
    const defaults: (string | undefined)[] = [];
    let hasDefault = false;
    for (const seg of segs) {
      const m = /^(\S+)\s*=\s*(.+)$/.exec(seg);
      if (m && m[1]!.length > 0) {
        params.push(m[1]!);
        defaults.push(m[2]!.trim());
        hasDefault = true;
      } else {
        params.push(seg);
        defaults.push(undefined);
      }
    }
    return hasDefault
      ? { kind: 'functionHead', name, params, defaults }
      : { kind: 'functionHead', name, params };
  }
  return { kind: 'functionHead', name: t, params: [] };
}

/**
 * `若 <ERB条件>：`（P-1R 批；1016 批删去旧形 `段` / `section`，只留 `若` 一词形）——库内
 * 「多信封分段」的可写块头。
 *
 * 段头一律按 **ERB 条件**解析（与 `如果` 同一条降糖管线，`expression.ts`）：
 * `若 NOWEX:噴乳：` / `若 非 NOWEX:噴乳：` / `若 她的恋慕 >= 1：`。
 *
 * 头位规则：
 * - **只认行首那一个独立词**：`parseBlockHead` 的首词切分已保证——`若干年后：` 的首词是
 *   `若干年后`（非关键字）⇒ 天然落回普通行，不会被当段头；
 * - **`若` 要求行尾终止符是全角 `：`**。判据不满足 → 返回 null，整行按普通文本处理
 *   （不造第二套诊断）。
 *
 * 表层**没有**停用标记：`（关）` / 尾随 `关` 都不再被识别（1016 批删去）——行尾括注只当
 * 条件的一部分。条件为空（`若 ：`）→ 返回 null。
 */
function parseSectionHead(rest: string, head: string, raw: string): LineClass | null {
  // 头位闸：唯一词形 `若`，行尾终止符必须全角
  if (head === '若' && !raw.endsWith(FULLWIDTH_COLON)) return null;
  const trimmed = rest.trim();
  if (trimmed.length === 0) return null;
  return { kind: 'sectionHead', condition: trimmed };
}

/**
 * **保留段名表**（P-3 初回段）——段头若**恰为**这些词，产物按**整串硬编译**发。
 *
 * 为什么不能走 `lowerExpression`：`首次` 只是 `system-functions.ts` 的**函数别名**
 * （`首次(` → `FIRSTTIME(`），而 `SELECTCOM` 在糖表达式的裸标识符路径上不是可解析
 * 标识符 ⇒ `若 首次：` 若走常规段管线会报 `unknown-identifier`。故本段把
 * `FIRSTTIME(SELECTCOM)` **整串硬编译**（对齐 `M_KOJO_K35_奉仕系コマンド.ERB:20-32`）。
 *
 * 信封口径与普通段不同：普通段写 bare `LOCAL = n` + `IF LOCAL && <条件>`，
 * 本表段写 `LOCAL:1 = n` + `IF LOCAL:1 && FIRSTTIME(SELECTCOM)`（M6 子信封）——
 * 两套口径各自保留，互不覆盖。
 */
export interface SectionPreset {
  /** 信封槽位编号（产物写 `LOCAL:<local>`） */
  readonly local: number;
  /** 硬编译的 ERB 条件串（不走表达式降糖） */
  readonly condition: string;
}
export const RESERVED_SECTION_NAMES: ReadonlyMap<string, SectionPreset> = new Map([
  ['首次', { local: 1, condition: 'FIRSTTIME(SELECTCOM)' }],
]);

/* ------------------------------ `参数:` 声明校验 ------------------------------ */

/**
 * 合法的形参令牌（规范 §3.2；引擎侧实参位置记号）——**中文主形 + 隐藏兼容别名**：
 * - `实参` / `实参:<数字>`：数值视图（1 基索引）；等价 `ARG` / `ARG:<数字>`（旧写法，兼容）；
 * - `实参$`：字符串视图（整组实参记号，位置 0）；等价裸 `ARGS`（旧写法，兼容）。
 *   带索引的字符串视图只开放中文写法 `实参$:<数字>` → 规范化为 `ARGS:<n-1>`
 *   （手写原生 `ARGS:<数字>` 仍非法，规范 §3.2 L271 明文）。
 *
 * 归一化单一真源见 `argTokenToEngineToken`（`keywords.ts`）。
 */
/** `参数:` 校验结果（`decl` = 规范化声明串，逗号分隔、无空白；codegen 逐字转发用） */
export type TimingArgsCheck =
  | { ok: true; decl: string; tokens: readonly string[] }
  | { ok: false; reason: string };

/**
 * 校验时机块头 `参数:` 的取值（规范 §3.2，v1.5/v1.6）。
 *
 * 口径：**逗号分隔**（半角 `,` 与全角 `，` 均可）的令牌序列，每支经
 * `argTokenToEngineToken` 归一为引擎记号（`ARG` / `ARG:<数字>` / `ARGS`）——
 * 中文主形（`实参` / `实参:<数字>` / `实参$` / `实参$:<数字>`）与旧写法
 * （`ARG` / `ARG:<数字>` / 裸 `ARGS`）都收，其余一律不认（`FOO` / `ARGS:2` /
 * `实参:0` / 空串 / 空令牌皆错）。纯函数——诊断由调用方（parser）落，词法层不碰 sink。
 */
export function checkTimingArgsDeclaration(value: string): TimingArgsCheck {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, reason: '「参数:」后面是空的——要声明形参就写令牌（如 `参数: 实参, 实参:2`），不需要形参就整个子句别写。' };
  const raw = trimmed.split(/[,，]/).map((t) => t.trim());
  const engine = raw.map((t) => argTokenToEngineToken(t));
  const badIdx = engine.findIndex((t) => t === null);
  if (badIdx >= 0) {
    const bad = raw[badIdx]!;
    return {
      ok: false,
      reason:
        '`参数:` 只接受逗号分隔的实参令牌 `实参` / `实参:<数字>` / `实参$`（旧写法 `ARG` / `ARG:<数字>` / 裸 `ARGS` 仍兼容），收到「' +
        (bad.length === 0 ? '（空令牌）' : bad) +
        '」。',
    };
  }
  const tokens = engine as string[];
  return { ok: true, decl: tokens.join(','), tokens };
}

/* ------------------------------ 表达式头 / 赋值 ------------------------------ */

/**
 * 识别赋值位置的表达式 `如果` / `当`（规范 §3.5 / §3.6 识别规则）：
 * 行首是"目标变量 + `=`"、右侧以 `如果`/`当` 开头。
 */
function parseExprHead(body: string): LineClass | null {
  const m = /^([^=]+?)\s*=\s*(如果|if|当|when)(?:\s+(.*))?$/.exec(body.trim());
  if (!m) return null;
  const target = m[1]!.trim();
  const kw = m[2]!;
  const variant: 'if' | 'when' = kw === '如果' || kw === 'if' ? 'if' : 'when';
  return { kind: 'exprHead', variant, target, rest: (m[3] ?? '').trim() };
}

/** 普通赋值：`目标 = 表达式`（`=` 两侧不强求空格；排除比较运算符 `==` / `>=` …） */
function parseAssignment(content: string): LineClass | null {
  // 逐字符扫描，找顶层单个 `=`（不在字符串内、不是 `==` / `>=` / `<=` / `!=`）
  let inString = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch !== '=') continue;
    const prev = i > 0 ? content[i - 1]! : '';
    const next = i + 1 < content.length ? content[i + 1]! : '';
    if (prev === '=' || next === '=' || prev === '!' || prev === '>' || prev === '<' || prev === '\\') continue;
    const target = content.slice(0, i).trim();
    const expr = content.slice(i + 1).trim();
    if (target.length === 0) return null;
    return { kind: 'assign', target, expr };
  }
  return null;
}

/* ------------------------------ 块头解析 ------------------------------ */

function parseBlockHead(content: string): LineClass | null {
  const body = stripBlockColon(content);
  const m = /^([^\s:：]+)\s*(.*)$/.exec(body);
  if (!m) return null;
  const kw = lookupKeyword(m[1]!);
  if (!kw) return null;
  const rest = m[2]!.trim();

  switch (kw) {
    case 'block.timing':
      return parseTimingHead(rest);
    case 'block.if':
      return { kind: 'ifHead', variant: 'if', condition: rest };
    case 'block.elif':
      return { kind: 'ifHead', variant: 'elseif', condition: rest };
    case 'block.else':
      return { kind: 'ifHead', variant: 'else', condition: '' };
    case 'block.when':
      return { kind: 'whenHead', subject: rest };
    case 'block.is':
      return { kind: 'caseHead', values: parseCaseValues(rest) };
    case 'block.random':
      return rest.length > 0 ? { kind: 'randomInline', alternatives: splitRandomAlternatives(rest) } : { kind: 'randomHead' };
    case 'block.group':
      // `组` 只作**裸块头**（`组：`）；带其它内容的写法不识别（按普通文本走，不静默吞掉）
      return rest.length === 0 ? { kind: 'groupHead' } : null;
    case 'block.section':
      return parseSectionHead(rest, m[1]!, content);
    case 'block.once':
      // `初回 "key"：`（1 号任务）——块头原文当 key（字符串字面量 / 既有表达式口径，可含 `{}` 插值）。
      // 空 key 也返回，交给 parser 报 `block-empty`（不在此造第二套诊断）。
      return { kind: 'onceHead', key: rest };
    case 'block.choice':
      // `选项：`（英文小写别名 `choice：`）——按钮形菜单，产物 PRINTBUTTON + INPUTS + RESULTS。
      return { kind: 'choiceHead' };
    case 'block.menu':
      // `菜单：`（英文小写别名 `menu：`）——数字输入菜单，产物 PRINTL [n] + INPUT + SELECTCASE RESULT。
      // 只收**裸块头**（`菜单：`）——带其它内容的写法不识别（按普通文本走，不静默吞掉）。
      return rest.length === 0 ? { kind: 'menuHead' } : null;
    case 'block.askM':
      // `询问 [提示]：` / `ask [提示]：`——引擎封装多选问答（产物 CALL <adapter 函数> + SELECTCASE）。
      // 头部可带**可选**提问文案（`询问 "要不要一起修炼？"：`）——原文交给 parser 走文本行管线。
      return rest.length === 0 ? { kind: 'askMHead' } : { kind: 'askMHead', prompt: rest };
    case 'block.askYN':
      // `确认 [提示]：` / `confirm [提示]：`——引擎封装二择问答，头部提示同 `询问`。
      return rest.length === 0 ? { kind: 'askYNHead' } : { kind: 'askYNHead', prompt: rest };
    case 'block.color':
      return { kind: 'colorHead', color: rest };
    case 'block.customCommand':
      return parseCustomCommandHead(rest);
    case 'block.function':
      return parseFunctionHead(rest);
    case 'inline.heart':
      // `心形：` / `heart：` 连续块头（P-7）：块体是文本行（逐行产 HPH_PRINT）。
      // 只收**裸块头**（`rest` 为空）——单行形 `心形 「…」` 不带块头冒号，走
      // `classifyLine` 末尾的 `heartText` 分支，两条路径互不干扰。
      return rest.length === 0 ? { kind: 'heartHead' } : null;
    case 'inline.hideScene':
      return { kind: 'messageCheck', scope: 'scene', condition: stripConditionPrefix(rest) };
    case 'inline.hideKojo':
      return { kind: 'messageCheck', scope: 'kojo', condition: stripConditionPrefix(rest) };
    default:
      return null;
  }
}

/** 单行形式（规范 §3.5）：`如果 FLAG:70： 「（……这是……）」` → 块头 + 行内体 */
function splitInlineBody(head: LineClass & { kind: 'ifHead' }): LineClass {
  return head;
}

/** `隐藏情景: 如果 她睡着了` → 条件原文（剥掉可选的 `如果` 前缀） */
function stripConditionPrefix(rest: string): string {
  return rest.replace(/^(如果|if)\s+/, '').trim();
}

/** `是 1：` / `是 2, 3：` / `是 5 到 8：` → 值区间序列 */
function parseCaseValues(rest: string): WhenCaseValue[] {
  if (rest.length === 0) return [];
  const commaParts = splitTopLevel(rest, /[,，]/);
  const out: WhenCaseValue[] = [];
  for (const part of commaParts) {
    const p = part.trim();
    if (p.length === 0) continue;
    const range = /^(.*?)\s+(到|to)\s+(.*)$/.exec(p);
    if (range) {
      out.push({ from: range[1]!.trim(), to: range[3]!.trim(), loc: zeroSpan() });
    } else {
      out.push({ from: p, to: null, loc: zeroSpan() });
    }
  }
  return out;
}

/** `随机 「嗯。」,「哦？」,「……」` → 候选原文序列 */
function splitRandomAlternatives(rest: string): string[] {
  return splitTopLevel(rest, /[,，]/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 顶层切分（不进入引号/花括号内） */
export function splitTopLevel(text: string, sep: RegExp): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let inString = false;
  let inBracket = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') inString = !inString;
    if (!inString) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === '{') inBracket = true;
      else if (ch === '}') inBracket = false;
    }
    if (!inString && depth === 0 && !inBracket && sep.test(ch)) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

/** 空区间（列信息由上层补齐；行号在 AST 构建时回填） */
function zeroSpan(): SugarSourceSpan {
  return { start: { line: 0, column: 1 }, end: { line: 0, column: 1 } };
}

/* ============================== 文本行 / 插值解析 ============================== */

/**
 * 解析文本行为 `TextLine` / `HeartLine`（规范 §3.3 / §3.4 / §3.9）。
 *
 * 步骤：剥 `续` 标记 → 判定 speech → 扫插值 → 生成节点。
 */
export function parseTextLine(
  line: LogicalLine,
  sink: DiagnosticSink,
): { speech: boolean; wait: boolean; interpolations: Interpolation[]; body: string } {
  const content = contentOf(line);
  const { text, wait } = stripCont(content, sink, line);
  const interpolations = scanInterpolations(text, line.line, sink);
  const speech = detectSpeechOf(text, interpolations);
  return { speech, wait, interpolations, body: text };
}

/** 剥 `续` 标记（导出供 `心形` 行复用；规则与文本行完全一致） */
export function stripCont(
  content: string,
  sink: DiagnosticSink,
  line: LogicalLine,
): { text: string; wait: boolean } {
  // 检测"引号内出现 `续`"——引号内文本不做替换，故只做诊断
  detectContInsideQuotes(content, sink, line);

  for (const mark of CONT_MARKS) {
    const re = new RegExp(`(?:^|\\s)${escapeRe(mark)}\\s*$`);
    if (re.test(content)) {
      const stripped = content.replace(re, (m0) => (m0.startsWith(' ') ? '' : ''));
      return { text: stripped.replace(/\s+$/, ''), wait: false };
    }
  }
  return { text: content, wait: true };
}

/** 台词判定（导出供 `心形` 行复用） */
export function detectSpeechOf(text: string, interpolations: Interpolation[]): boolean {
  let stripped = text;
  const sorted = [...interpolations].sort((a, b) => b.loc.start.column - a.loc.start.column);
  for (const it of sorted) {
    if (it.loc.start.line !== it.loc.end.line) continue;
    stripped = stripped.slice(0, it.loc.start.column - 1) + stripped.slice(it.loc.end.column - 1);
  }
  const first = stripped.replace(/^[\s\u3000]+/, '')[0];
  return first === '「' || first === '｢';
}

/** 引号内出现 `续` → 诊断（规范 §8 lint 清单） */
function detectContInsideQuotes(content: string, sink: DiagnosticSink, line: LogicalLine): void {
  for (const mark of ['续', 'cont', 'continue']) {
    const re = new RegExp(`[「｢][^」｣]*${escapeRe(mark)}[^」｣]*[」｣]`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      sink.report({
        code: 'cont-inside-quotes',
        severity: 'error',
        message: `「续」写在了引号内——它是行尾标记，必须写在引号之外。`,
        loc: { line: line.line, column: m.index + 1 },
      });
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 扫描插值 `{…}`（规范 §3.4 / §5.2）。
 *
 * - `{条件 ? "A" : "B"}` → `cond` 形态（`thenText` / `elseText` 不含引号）；
 * - `{条件 ? "A"}` → `cond` 形态，`elseText` 缺省；
 * - 其余 → `expr` 形态；
 * - `{}` 内出现 `当` / `如果` → `interpolation-block-expression`（硬约束 §3.6）；
 * - `{` 未收尾 → `interpolation-unclosed`；`{}` 内再写 `{}` → `interpolation-nested`。
 */
export function scanInterpolations(text: string, lineNo: number, sink: DiagnosticSink): Interpolation[] {
  const out: Interpolation[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch !== '{') {
      i++;
      continue;
    }
    const startCol = i + 1;
    // 找配对的 `}`（不嵌套）
    let j = i + 1;
    let inner = '';
    let closed = false;
    while (j < text.length) {
      const c = text[j]!;
      if (c === '}') {
        closed = true;
        break;
      }
      if (c === '{') {
        sink.report({
          code: 'interpolation-nested',
          severity: 'error',
          message: '插值不能嵌套——`{}` 内不能再写 `{}`；需要按分支显示不同内容时请用行内条件 `{条件 ? A : B}`。',
          loc: { line: lineNo, column: j + 1 },
        });
        break;
      }
      inner += c;
      j++;
    }
    if (!closed) {
      sink.report({
        code: 'interpolation-unclosed',
        severity: 'error',
        message: '插值 `{` 没有对应的 `}`。',
        loc: { line: lineNo, column: startCol },
      });
      i = j >= text.length ? text.length : j + 1;
      continue;
    }
    const endCol = j + 2; // `}` 之后一列（1 基，半开区间）
    out.push(buildInterpolation(inner, lineNo, startCol, endCol, sink));
    i = j + 1;
  }
  return out;
}

function buildInterpolation(
  inner: string,
  lineNo: number,
  startCol: number,
  endCol: number,
  sink: DiagnosticSink,
): Interpolation {
  const loc: SugarSourceSpan = {
    start: { line: lineNo, column: startCol },
    end: { line: lineNo, column: endCol },
  };
  const trimmed = inner.trim();

  // 硬约束：`{}` 内不可写 `当` / `如果`（规范 §3.6 末）
  // 注意：CJK 后 `\b` 不成立（`\w` 默认不含 CJK），故不能用 `\b` 收尾——
  // 用"行首 + 空白/结尾"判定。
  if (/^(当|when|如果|if)(\s|$)/.test(trimmed)) {
    sink.report({
      code: 'interpolation-block-expression',
      severity: 'error',
      message: '插值 `{}` 内不能写「当」/「如果」——ERB 行内条件不支持嵌套；请改用行内条件 `{条件 ? A : B}`，或把条件提为整行。',
      loc: { line: lineNo, column: startCol },
    });
    return { kind: 'interpolation', form: 'expr', text: trimmed, loc };
  }

  // 行内条件：含顶层 `?`
  const qIdx = findTopLevel(trimmed, '?');
  if (qIdx >= 0) {
    const condText = trimmed.slice(0, qIdx).trim();
    const branches = trimmed.slice(qIdx + 1);
    const colonIdx = findTopLevel(branches, ':');
    if (colonIdx >= 0) {
      const thenRaw = branches.slice(0, colonIdx).trim();
      const elseRaw = branches.slice(colonIdx + 1).trim();
      return {
        kind: 'interpolation',
        form: 'cond',
        text: trimmed,
        condText,
        thenText: unquote(thenRaw),
        elseText: unquote(elseRaw),
        loc,
      };
    }
    return {
      kind: 'interpolation',
      form: 'cond',
      text: trimmed,
      condText,
      thenText: unquote(branches.trim()),
      loc,
    };
  }

  return { kind: 'interpolation', form: 'expr', text: trimmed, loc };
}

/** 找顶层字符（不进入引号 / 括号 / 花括号） */
function findTopLevel(text: string, target: string): number {
  let depth = 0;
  let inString = false;
  let inBracket = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') inString = !inString;
    if (!inString) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === '{') inBracket = true;
      else if (ch === '}') inBracket = false;
      else if (ch === target && depth === 0 && !inBracket) return i;
    }
  }
  return -1;
}

/** 去引号（`"A"` → `A`；无引号原样） */
function unquote(s: string): string {
  const t = s.trim();
  if (/^".*"$/.test(t)) return t.slice(1, -1);
  return t;
}

/* ============================== 导出：AST 构建入口（在 parser.ts） ============================== */

export { zeroSpan };
export type { SugarNode };
