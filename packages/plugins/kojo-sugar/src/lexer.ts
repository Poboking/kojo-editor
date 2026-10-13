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
  CONT_MARKS,
  HEAD_DECL_KEYS,
  FULLWIDTH_SPACE,
  endsWithBlockColon,
  lookupKeyword,
  stripBlockColon,
  type KeywordId,
} from './keywords';
import type { DiagnosticSink } from './types';

/* ============================== 物理行 → 逻辑行 ============================== */

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
    // 折行续接：仅在行尾（去尾空白后）为 `\` 时合并
    while (/(^|[^\\])\\\s*$/.test(text)) {
      text = text.replace(/\\\s*$/, '');
      i++;
      if (i >= physical.length) break;
      endLine = i + 1;
      text += physical[i]!.trimStart();
    }
    const rawIndentMatch = /^[ \t\u3000]*/.exec(text)!;
    const rawIndent = rawIndentMatch[0];
    out.push({
      line: startLine,
      endLine,
      text,
      indent: indentLevel(rawIndent),
      rawIndent,
    });
    i++;
  }
  return out;
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
 * 结构化行的 `;` 行内注释剥离：截到行内第一个**引号外**的 `;`（含）为止。
 * 引号内的 `;` 属于字符串值（如字符串别名），不剥。文本行不经此函数——
 * 台词里的 `;` 是作者要打印的字符（见 `classifyLine` 的分派注释）。
 */
export function stripInlineComment(content: string): string {
  let inStr = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (ch === '"') inStr = !inStr;
    else if (ch === ';' && !inStr) return content.slice(0, i).replace(/\s+$/, '');
  }
  return content;
}

/* ============================== 行分类（词法决策） ============================== */

/** 行类别 */
export type LineClass =
  | { kind: 'blank' }
  | { kind: 'comment' }
  | { kind: 'rawLine'; text: string }
  | { kind: 'rawBlockStart' }
  | { kind: 'headDecl'; key: KeywordId; value: string }
  | { kind: 'aliasDecl'; name: string; value: AliasValue }
  | { kind: 'switchItem'; name: string; value: string }
  | { kind: 'timingHead'; face: string; index?: string; namedParams: TimingNamedParam[] }
  | { kind: 'ifHead'; variant: 'if' | 'elseif' | 'else'; condition: string; inline?: string }
  | { kind: 'whenHead'; subject: string }
  | { kind: 'caseHead'; values: WhenCaseValue[] }
  | { kind: 'randomHead' }
  | { kind: 'randomInline'; alternatives: string[] }
  | { kind: 'choiceHead' }
  | { kind: 'choiceItem'; label: string }
  | { kind: 'colorHead'; color: string }
  | { kind: 'exprHead'; variant: 'if' | 'when'; target: string; rest: string }
  | { kind: 'messageCheck'; scope: 'scene' | 'kojo'; condition: string }
  | { kind: 'arrowCase'; values: WhenCaseValue[]; value: string }
  | { kind: 'arrowElse'; value: string }
  | { kind: 'assign'; target: string; expr: string }
  | { kind: 'blankLine'; wait: boolean }
  | { kind: 'heartText'; raw: string }
  | { kind: 'text'; raw: string };

/**
 * `空行` / `blank`（可带一个行尾 `续` 类标记）→ 一条"输出一行空行"的语句（规范 §3.3，批 P）。
 *
 * 判据是**整行恰好是这个词**：台词里出现"空行"两个字的写法（`空行是什么`、`「空行」`）
 * 绝不能被当成指令——那会把作者要打印的字变成控制语句。标记只认 `CONT_MARKS` 那一组，
 * `空行 不等待` 一类自造说法不认（宁可作者写 `空行 续`）。
 */
const BLANK_LINE_RE = /^(空行|blank)(?:[ \t]+(\S+))?$/i;

function matchBlankLine(code: string): { kind: 'blankLine'; wait: boolean } | null {
  const m = BLANK_LINE_RE.exec(code);
  if (!m) return null;
  const mark = m[2];
  if (mark === undefined) return { kind: 'blankLine', wait: true };
  return CONT_MARKS.includes(mark) ? { kind: 'blankLine', wait: false } : null;
}

/** 全大写原生指令判定（规范 §3.10）：`SETCOLOR` / `IF` / `CALL` / `RAND` / `TFLAG:193 = 0` */
const RAW_INSTR_RE = /^[A-Z][A-Z0-9_]*(?:[:.][^\s]*)?(?:\s|=|$)/;

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

  // ---- 表达式 如果 / 当（赋值位置；规范 §3.5 / §3.6 识别规则）----
  // 行首是"目标变量 + `=`"、右侧以 `如果`/`当` 开头、行尾是块头冒号。
  // **不依赖 headMatch**——目标变量名可能含空白（如 `她的心情 = 当 …：`）。
  if (endsWithBlockColon(code)) {
    const exprHead = parseExprHead(stripBlockColon(code));
    if (exprHead) return exprHead;
  }

  // ---- 赋值（`X = 表达式`）——`=` 不在引号内、不是比较运算符 ----
  const assign = parseAssignment(code);
  if (assign) return assign;

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
  return { kind: 'aliasDecl', name, value: parseAliasValue(rhs) };
}

/**
 * 别名右值四形态（规范 §3.1 表）。
 *
 * - `角色 N` / `char N` → `character`；
 * - `"…"` → `string`；
 * - 纯数字 → `number`；
 * - 其余（含 `CFLAG:TARGET:1088` / `DAY`）→ `variable`。
 */
export function parseAliasValue(rhs: string): AliasValue {
  const trimmed = rhs.trim();
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
  const namedParams: TimingNamedParam[] = [];
  for (let i = 1; i < parts.length; i++) {
    const token = parts[i]!;
    // 命名参数形态：`成否: 游戏判定` 已被 `:` 切走，故在此只可能是 `X:` + 值
    if (token.endsWith('：') || token.endsWith(':')) {
      const name = stripBlockColon(token);
      const val = parts[i + 1] ?? '';
      namedParams.push({ name, value: val, loc: zeroSpan() });
      i++;
      continue;
    }
    if (index === undefined && /^[0-9A-Za-z_]+$/.test(token)) {
      index = token;
      continue;
    }
  }
  return { kind: 'timingHead', face, index, namedParams };
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
    case 'block.choice':
      return { kind: 'choiceHead' };
    case 'block.color':
      return { kind: 'colorHead', color: rest };
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
