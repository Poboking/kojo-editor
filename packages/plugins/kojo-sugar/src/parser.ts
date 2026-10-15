/**
 * 三段式转译 · 第二段：缩进配对 → `SugarNode` AST。
 *
 * 配对规则（照抄规范 §5.3，不自由发挥）：
 * - 块头以全角 `：` 结尾；块体缩进必须**比块头更深**；
 * - 缩进异常（回缩不齐、块头无体）→ 报错并**阻止编译**（不生成半成品）；
 * - `如果/否则如果/否则`、`当/是/否则`、`随机`、`选项`、`菜单`、`着色`、时机 各自成块；
 * - `选项` / `菜单` 块：每时机最多一个、不可嵌套（诊断 `choice-multiple` / `choice-nested`）；
 * - 表达式 `如果` / `当`：分支体必须是 `-> 单个表达式`，且必须有 `否则`
 *   （诊断 `expr-body-not-expression` / `expr-missing-else`）。
 *
 * 本段只做**结构**构建；表达式降糖发生在 codegen 段（`codegen.ts`）。
 */

import type {
  AliasDecl,
  AskItem,
  ConstDecl,
  CustomCommandBlock,
  FunctionBlock,
  GroupBlock,
  HeartLine,
  IfBlock,
  IfBranch,
  IfExpr,
  RandomBlock,
  RandomBlock as RandomBlockT,
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
  TimingNamedParam,
  WhenBlock,
  WhenBranch,
  WhenCaseValue,
  WhenExpr,
} from '@kojo/plugin-api';
import {
  checkTimingArgsDeclaration,
  classifyLine,
  contentOf,
  detectSpeechOf,
  parseAliasValue,
  parseTextLine,
  RESERVED_SECTION_NAMES,
  scanInterpolations,
  splitLogicalLines,
  stripCont,
  type LineClass,
  type LogicalLine,
} from './lexer';
import { TIMING_ARGS_PARAM } from './keywords';
import type { DiagnosticSink, HeartBlock, RandomShape } from './types';

/** 位置工具：由逻辑行构造源区间 */
function spanOf(line: LogicalLine, endLine?: number): SugarSourceSpan {
  return {
    start: { line: line.line, column: line.rawIndent.length + 1 },
    end: { line: endLine ?? line.endLine, column: 1 },
  };
}

function posOf(line: LogicalLine): { line: number; column: number } {
  return { line: line.line, column: line.rawIndent.length + 1 };
}

/** 可推进的物理行游标 */
class Cursor {  constructor(
    readonly lines: LogicalLine[],
    readonly sink: DiagnosticSink,
  ) {}

  private i = 0;
  /** 原生 `@` 块用的物理行视图（`LogicalLine` 与物理行一一对应时使用） */
  peek(): LogicalLine | undefined {
    return this.lines[this.i];
  }
  next(): LogicalLine | undefined {
    const l = this.lines[this.i];
    if (l) this.i++;
    return l;
  }
  get index(): number {
    return this.i;
  }
  set index(v: number) {
    this.i = v;
  }
  get done(): boolean {
    return this.i >= this.lines.length;
  }
}

/* ============================== 文档构建 ============================== */

export interface BuildDocResult {
  doc: SugarDoc;
}

/**
 * 顶层节点 —— 契约的 `SugarTopLevelNode` 只含 `AliasDecl | TimingBlock`
 * （文档级节点），但规范 §3.10 允许 `@` 原生函数块与原生直通行出现在文件
 * 顶层。转译器内部用本类型容纳它们；写回 `SugarDoc.topLevel` 时仍然合法
 * （`RawLine` / `RawFunctionBlock` 是 `SugarNode` 的子集，消费方按 `kind` 判别）。
 */
export type TopNode = SugarTopLevelNode | RawFunctionBlock | RawLine;

/** 构建 `SugarDoc`（顶层：头部声明 + 别名 + 时机块） */
export function buildDoc(source: string, filePath: string, sink: DiagnosticSink): SugarDoc {
  const lines = splitLogicalLines(source);
  const frontMatter = emptyFrontMatter();
  const topLevel: TopNode[] = [];
  const cursor = new Cursor(lines, sink);
  const aliasNames = new Set<string>();
  /** 已解析的常量名（重名 → `alias-duplicate`；与既有别名撞名 → `alias-name-conflict`） */
  const constNames = new Set<string>();
  let sawTiming = false;
  // P-4 文档级随机产物模式：文件头 `随机形: 直出` ⇒ `direct`（缺省 `default`）。
  // 头部选项先于时机块出现（照抄 `口上:` 一侧的写法约定），故在此按源顺序生效。
  let randomShape: RandomShape = 'default';

  // 供 `parseAliasLine` 使用：把解析出的别名同时登记进 frontMatter.aliases
  const registerAlias = (decl: AliasDecl) => {
    frontMatter.aliases.push(decl);
  };

  while (!cursor.done) {
    const line = cursor.peek()!;
    const content = contentOf(line);
    if (content.length === 0) {
      cursor.next();
      continue;
    }
    // 文件头注释**保留**（第 3 条）：它常是整份口上的标题/出处说明，产物里该有
    if (content.startsWith(';')) {
      cursor.next();
      topLevel.push({ kind: 'comment', text: content, loc: spanOf(line) });
      continue;
    }

    // ---- 原生函数块（行首 `@`；整块透传，规范 §3.10）----
    if (content.startsWith('@')) {
      const block = readRawFunctionBlock(cursor);
      topLevel.push(block);
      continue;
    }

    const cls = classifyLine(line);

    // ---- 头部声明 ----
    if (cls.kind === 'headDecl') {
      cursor.next();
      applyHeadDecl(frontMatter, cls.key, cls.value);
      // `开关:` 后的缩进块
      if (cls.key === 'head.switch') {
        readSwitchItems(cursor, line.indent, frontMatter);
      }
      continue;
    }

    // ---- P-4 文件头选项 `随机形: 直出`（文档级开关，先于时机块生效）----
    // 非 `直出` 的取值按缺省形处理（与 `旁白色:` 对未知值的归一同一口径，不另造诊断码）。
    if (cls.kind === 'randomShapeDecl') {
      cursor.next();
      randomShape = cls.value === '直出' ? 'direct' : 'default';
      continue;
    }

    // ---- 别名声明 ----
    if (cls.kind === 'aliasDecl') {
      cursor.next();
      const decl = buildAliasDecl(cls, line, sink, aliasNames);
      if (decl) {
        if (sawTiming) {
          sink.report({
            code: 'alias-not-in-header',
            severity: 'error',
            message: '「别名」只能写在文件头（所有「时机」之前）。',
            loc: posOf(line),
          });
        } else {
          registerAlias(decl);
        }
        topLevel.push(decl);
      }
      continue;
    }

    // ---- 常量声明（7 号批：文件级 → 编译期展开、产物零声明，与别名同受"须在头"约束）----
    if (cls.kind === 'constDecl') {
      cursor.next();
      const decl = buildConstDecl(cls, line, sink, aliasNames, constNames);
      if (decl) {
        if (sawTiming) {
          sink.report({
            code: 'alias-not-in-header',
            severity: 'error',
            message: '「常量」只能写在文件头（所有「时机」之前）。',
            loc: posOf(line),
          });
        }
        topLevel.push(decl);
      }
      continue;
    }

    // ---- 时机块 ----
    if (cls.kind === 'timingHead') {
      sawTiming = true;
      const block = readTimingBlock(cursor, cls, randomShape);
      topLevel.push(block);
      continue;
    }

    // ---- 自定指令块（HK-12；文档级，与时机同级，故同样受"别名须在头"约束）----
    if (cls.kind === 'customCommandHead') {
      sawTiming = true;
      const block = readCustomCommandBlock(cursor, cls, randomShape);
      topLevel.push(block);
      continue;
    }

    // ---- 用户函数声明块（B4 批；文档级，与时机/自定指令同级）----
    if (cls.kind === 'functionHead') {
      sawTiming = true;
      topLevel.push(readFunctionBlock(cursor, cls, randomShape));
      continue;
    }

    // ---- 顶层其它（原生行 / 意外内容）----
    if (cls.kind === 'rawLine') {
      cursor.next();
      topLevel.push({ kind: 'rawLine', text: cls.text, loc: spanOf(line) });
      continue;
    }

    // 顶层文本行——规范未定义（时机外不应有正文）；报错并跳过（不静默）
    cursor.next();
    sink.report({
      code: 'indent-mismatch',
      severity: 'error',
      message: '这一行不在任何「时机」块内——正文必须写在「时机 …：」之下。',
      loc: posOf(line),
    });
  }

  sortDiagnostics(sink);
  return { filePath, frontMatter, topLevel: topLevel as SugarTopLevelNode[], diagnostics: sink.all() };
}

/* ------------------------------ 头部 / 开关 / 别名 ------------------------------ */

function emptyFrontMatter(): SugarFrontMatter {
  return { switches: [], aliases: [] };
}

function applyHeadDecl(fm: SugarFrontMatter, key: string, value: string): void {
  switch (key) {
    case 'head.char':
      fm.charNo = value;
      break;
    case 'head.family': {
      // `口上: <家族名> [选择器: <n>]`——选择器是同一家族下的第 n 版口上。
      // 形态嵌在 `口上:` 一行的尾部（投影在文件头发 `口上:` 时即用它带出选择器）。
      const m = /^(.*?)\s+(?:选择器|selector)\s*[:：]\s*(\d+)$/.exec(value);
      if (m) {
        fm.family = m[1]!.trim();
        fm.selector = Number(m[2]!);
      } else {
        fm.family = value;
      }
      break;
    }
    case 'head.title':
      fm.displayName = value;
      break;
    case 'head.desc':
      fm.description = value;
      break;
    case 'head.color':
      fm.color = value;
      break;
    case 'head.playerColor':
      fm.playerColor = value;
      break;
    case 'head.narrationColor':
      fm.narrationColor = value === '作者色' ? '作者色' : '默认';
      break;
    // 头部选项 `函数前缀: <模板>`（B4-fp）——原样收进 front-matter；模板合法性由
    // 转译服务在出码前校验（fail-closed），解析段只做"存储"不做"解释"。
    case 'head.functionPrefix':
      fm.functionPrefix = value;
      break;
    default:
      break;
  }
}

/** `开关:` 后的缩进条目（`眠姦口上有: 是`） */
function readSwitchItems(cursor: Cursor, baseIndent: number, fm: SugarFrontMatter): void {
  while (!cursor.done) {
    const line = cursor.peek()!;
    const content = contentOf(line);
    if (content.length === 0) {
      cursor.next();
      continue;
    }
    if (line.indent <= baseIndent) return;
    const m = /^([^:：]+)\s*[:：]\s*(.*)$/.exec(content);
    if (!m) {
      cursor.next();
      continue;
    }
    fm.switches.push({
      name: m[1]!.trim(),
      value: m[2]!.trim(),
      loc: spanOf(line),
    });
    cursor.next();
  }
}

/** 构建 `AliasDecl`（含三约束校验） */
function buildAliasDecl(
  cls: LineClass & { kind: 'aliasDecl' },
  line: LogicalLine,
  sink: DiagnosticSink,
  seen: Set<string>,
): AliasDecl | null {
  const name = cls.name;
  if (name.length === 0) {
    sink.report({
      code: 'alias-unknown-target',
      severity: 'error',
      message: '「别名」缺少名称。',
      loc: posOf(line),
    });
    return null;
  }
  if (cls.malformed) {
    // 条件形态残缺（有顶层 `?` 但缺条件 / 真分支）→ **不新增诊断码**，复用 `alias-unknown-target`
    sink.report({
      code: 'alias-unknown-target',
      severity: 'error',
      message: `别名「${name}」的右值条件表达式残缺——请写成「条件 ? "真" : "假"」。`,
      loc: posOf(line),
    });
    return null;
  }
  if (name === '她' || name === '你') {
    sink.report({
      code: 'alias-name-conflict',
      severity: 'error',
      message: `「${name}」是保留代词，不能用作别名。`,
      loc: posOf(line),
    });
    return null;
  }
  if (seen.has(name)) {
    sink.report({
      code: 'alias-duplicate',
      severity: 'error',
      message: `别名「${name}」重复声明。`,
      loc: posOf(line),
    });
    return null;
  }
  seen.add(name);
  return { kind: 'aliasDecl', name, value: cls.value, loc: spanOf(line) };
}

/**
 * 构建 `ConstDecl`（7 号批）——文件级常量。
 *
 * 校验（**全部复用既有诊断码**，闭集不扩）：
 * - 名残缺 / 缺 `=`（`malformed`）→ `alias-unknown-target`；
 * - 值不是十进制整数字面量 → `alias-unknown-target`（编译期展开只接整数字面量，
 *   写个变量名会让这条声明在任何位置都取不到值 = 看似能跑、语义已错，必须在此拦下）；
 * - 名是保留代词 `她` / `你`，或与**既有别名**同名 → `alias-name-conflict`
 *   （两者会在表达式里争夺同一个标识符）；
 * - 常量重名 → `alias-duplicate`。
 */
function buildConstDecl(
  cls: LineClass & { kind: 'constDecl' },
  line: LogicalLine,
  sink: DiagnosticSink,
  aliasNames: ReadonlySet<string>,
  seen: Set<string>,
): ConstDecl | null {
  const name = cls.name;
  if (name.length === 0 || cls.malformed) {
    sink.report({
      code: 'alias-unknown-target',
      severity: 'error',
      message: '「常量」声明要写成 `常量 <名> = <整数>`。',
      loc: posOf(line),
    });
    return null;
  }
  if (!/^-?\d+$/.test(cls.value)) {
    sink.report({
      code: 'alias-unknown-target',
      severity: 'error',
      message: `常量「${name}」的值「${cls.value}」不是整数——常量在编译期展开成字面量，只接受十进制整数（如 常量 ${name} = 1022）。`,
      loc: posOf(line),
    });
    return null;
  }
  if (name === '她' || name === '你') {
    sink.report({
      code: 'alias-name-conflict',
      severity: 'error',
      message: `「${name}」是保留代词，不能用作常量名。`,
      loc: posOf(line),
    });
    return null;
  }
  if (aliasNames.has(name)) {
    sink.report({
      code: 'alias-name-conflict',
      severity: 'error',
      message: `常量「${name}」与既有别名同名——两者会在表达式里争夺同一个标识符，请改名。`,
      loc: posOf(line),
    });
    return null;
  }
  if (seen.has(name)) {
    sink.report({
      code: 'alias-duplicate',
      severity: 'error',
      message: `常量「${name}」重复声明。`,
      loc: posOf(line),
    });
    return null;
  }
  seen.add(name);
  return { kind: 'constDecl', name, value: cls.value, loc: spanOf(line) };
}

/* ------------------------------ 原生函数块（§3.10） ------------------------------ */

/**
 * 读取原生函数块：从当前 `@` 行起直到下一个 `@` 行或文件末尾。
 * **整块逐行原样透传**（块内不解析糖语法）——行文本取**物理行原文**
 * （保留缩进，因为 `#DIM` 等预处理行对列位置无要求但保持原样最安全）。
 */
function readRawFunctionBlock(cursor: Cursor): RawFunctionBlock {
  const first = cursor.next()!;
  const rawLines: string[] = [first.text];
  let last = first;
  while (!cursor.done) {
    const line = cursor.peek()!;
    if (contentOf(line).startsWith('@')) break;
    rawLines.push(line.text);
    last = line;
    cursor.next();
  }
  return {
    kind: 'rawFunctionBlock',
    lines: rawLines,
    loc: { start: { line: first.line, column: 1 }, end: { line: last.endLine, column: 1 } },
  };
}

/* ------------------------------ 时机块 ------------------------------ */

function readTimingBlock(
  cursor: Cursor,
  cls: LineClass & { kind: 'timingHead' },
  randomShape: RandomShape,
): TimingBlock {
  const head = cursor.next()!;
  const baseIndent = head.indent;
  const bodyParser = new BlockParser(cursor, baseIndent + 1, cursor.sink, randomShape);
  const { body, messageCheck, namedParams } = bodyParser.parseTimingBody();

  // 命名参数挂在**块头行**上：词法层的 `zeroSpan()` 在这里回填真实源区间
  // （`参数:` 这类子句写错时，诊断必须能点到块头那一行）。
  const headParams = mergeNamedParams(cls.namedParams, namedParams).map((p) => ({
    ...p,
    loc: p.loc.start.line === 0 ? spanOf(head) : p.loc,
  }));
  checkTimingArgsParams(headParams, head, cls.namedParams.length, cursor.sink);

  return {
    kind: 'timingBlock',
    face: cls.face,
    index: cls.index,
    indexName: cls.indexName,
    namedParams: headParams,
    messageCheck,
    body,
    loc: {
      start: posOf(head),
      end: { line: cursor.lines[Math.max(0, cursor.index - 1)]?.endLine ?? head.endLine, column: 1 },
    },
  };
}

/* ------------------------------ 自定指令块（HK-12） ------------------------------ */

/**
 * 读取 `自定指令 <名> [编号: N] [可否使用: <条件>] [计数器不发: <条件>]：` 块
 * → `CustomCommandBlock`（契约冻结形态）。
 *
 * 正文与 `TimingBlock` 同口径（`BlockParser.parseBody`）；可选钩子子句
 * （`可否使用:` / `计数器不发:`，HK-12 五钩子）在块头解析、原样透传到 AST，
 * 由 codegen 按 `customHooks` 模板产出（缺省不生成）。空体合法
 * （codegen 会落 `LOCAL = 0`，与时机块一致）。
 */
function readCustomCommandBlock(
  cursor: Cursor,
  cls: LineClass & { kind: 'customCommandHead' },
  randomShape: RandomShape,
): CustomCommandBlock {
  const head = cursor.next()!;
  const baseIndent = head.indent;
  const body = new BlockParser(cursor, baseIndent + 1, cursor.sink, randomShape).parseBody();
  return {
    kind: 'custom-command',
    name: cls.name,
    ...(cls.index !== undefined ? { index: cls.index } : {}),
    ...(cls.canCom !== undefined ? { canCom: cls.canCom } : {}),
    ...(cls.comCounter !== undefined ? { comCounter: cls.comCounter } : {}),
    body,
    loc: {
      start: posOf(head),
      end: { line: cursor.lines[Math.max(0, cursor.index - 1)]?.endLine ?? head.endLine, column: 1 },
    },
  };
}

/**
 * 读取 `函数 <名>(形参,…)：` 块 → `FunctionBlock`（契约冻结形态，B4 批）。
 *
 * 正文与 `TimingBlock` 同口径（`BlockParser.parseBody`：台词 / 控制流 / 赋值 / 原生行 /
 * 注释 / 更深的块，以及本批新增的 `调用` / `返回`）。空体合法（产物里由 codegen 落
 * 函数头 + 自然返回）。
 */
function readFunctionBlock(
  cursor: Cursor,
  cls: LineClass & { kind: 'functionHead' },
  randomShape: RandomShape,
): FunctionBlock {
  const head = cursor.next()!;
  const body = new BlockParser(cursor, head.indent + 1, cursor.sink, randomShape).parseBody();
  return {
    kind: 'functionBlock',
    name: cls.name,
    params: cls.params,
    body,
    loc: {
      start: posOf(head),
      end: { line: cursor.lines[Math.max(0, cursor.index - 1)]?.endLine ?? head.endLine, column: 1 },
    },
  };
}

/**
 * 校验块头的 `参数:` 声明（规范 §3.2，v1.5）。
 *
 * 复用既有诊断码 `timing-face-unknown`（契约 `SugarDiagnosticCode` 是**闭集**，
 * `plugin-api/tests/sugar.test.ts` 明写"不得临时发明字符串"）：两者的语义同为
 * "时机块头写了一个转译器无法落地的子句"，且同为 **error = 阻止出码**（规范 §5.3
 * 不生成半成品）。消息只谈 `参数:`，不复谈分野，作者读到的是准确的原因。
 *
 * `headParamCount` = 块头（词法层）解析出的命名参数条数——`参数:` 只可能写在块头，
 * 体内的条目（当前恒为空）不参与校验，避免把子句位置的锅算到块头上。
 */
function checkTimingArgsParams(
  params: TimingNamedParam[],
  head: LogicalLine,
  headParamCount: number,
  sink: DiagnosticSink,
): void {
  for (let i = 0; i < headParamCount; i++) {
    const p = params[i]!;
    if (p.name !== TIMING_ARGS_PARAM) continue;
    const checked = checkTimingArgsDeclaration(p.value);
    if (checked.ok) continue;
    sink.report({
      code: 'timing-face-unknown',
      severity: 'error',
      message: checked.reason,
      loc: posOf(head),
      span: spanOf(head),
    });
  }
}

function mergeNamedParams(a: TimingNamedParam[], b: TimingNamedParam[]): TimingNamedParam[] {
  return [...a, ...b];
}

/* ============================== 块体解析器 ============================== */

/**
 * 块体解析器：以"缩进层级"驱动递归下降。
 *
 * `minIndent` = 当前块体要求的最小缩进层级；遇到 `indent < minIndent` 即返回
 * （交还上层）；遇到 `indent > minIndent` 且上一个节点未开块 → 报 `indent-mismatch`
 * （规范 §5.3：缩进异常阻止编译）。
 */
class BlockParser {
  constructor(
    private readonly cursor: Cursor,
    private readonly minIndent: number,
    private readonly sink: DiagnosticSink,
    /** P-4 文档级随机产物模式——随嵌套块体一路下传（`随机` 可能是块体的任意深度） */
    private readonly randomShape: RandomShape = 'default',
  ) {}

  /**
   * 解析时机体：可含 `隐藏情景:` / `隐藏口上:` 子句（规范 §3.2）。
   * 返回语句序列与消息检查子句。
   */
  parseTimingBody(): {
    body: SugarNode[];
    messageCheck: { scope: 'scene' | 'kojo'; condition: string; loc: SugarSourceSpan }[];
    namedParams: TimingNamedParam[];
  } {
    const body: SugarNode[] = [];
    const messageCheck: { scope: 'scene' | 'kojo'; condition: string; loc: SugarSourceSpan }[] = [];
    const namedParams: TimingNamedParam[] = [];
    let choiceSeen = false;
    let menuSeen = false;

    while (!this.cursor.done) {
      const line = this.cursor.peek()!;
      const content = contentOf(line);
      if (content.length === 0) {
        this.cursor.next();
        continue;
      }
      if (line.indent < this.minIndent) break;
      if (line.indent > this.minIndent) {
        this.sink.report({
          code: 'indent-mismatch',
          severity: 'error',
          message: '缩进比同级更深的行前面没有块头（「如果 …：」/「当 …：」/「随机：」/「选项：」之一）。',
          loc: posOf(line),
        });
        this.skipOverIndented(line.indent);
        continue;
      }

      const cls = classifyLine(line);
      if (cls.kind === 'comment') {
        // 注释保留（第 3 条）——作者的分节线与意图说明要跟着进产物
        this.cursor.next();
        body.push({ kind: 'comment', text: contentOf(line), loc: spanOf(line) });
        continue;
      }
      if (cls.kind === 'messageCheck') {
        this.cursor.next();
        messageCheck.push({ scope: cls.scope, condition: cls.condition, loc: spanOf(line) });
        continue;
      }
      // 时机块头的命名参数若写在体内（少见）——忽略并前进
      const node = this.parseStatement(cls, line, { choiceSeen, menuSeen });
      if (node) {
        if (node.kind === 'choiceBlock') choiceSeen = true;
        if (node.kind === 'menuBlock') menuSeen = true;
        body.push(node);
      }
    }
    return { body, messageCheck, namedParams };
  }

  /** 单行块头的行内体 → 语句节点（文本 / 心形 / 原生行 / 赋值） */
  private buildInlineNode(line: LogicalLine, inline: string): SugarNode {
    const synthetic: LogicalLine = {
      ...line,
      text: inline,
      rawIndent: '',
      indent: line.indent + 1,
    };
    const cls = classifyLine(synthetic);
    switch (cls.kind) {
      case 'heartText':
        return this.buildHeartNode(synthetic, cls.raw);
      case 'blankLine':
        return this.buildBlankNode(synthetic, cls.wait);
      case 'rawLine':
        return { kind: 'rawLine', text: cls.text, loc: spanOf(line) } as RawLine;
      case 'settle':
        return { kind: 'rawLine', text: 'EXP:' + cls.expr, loc: spanOf(line) } as RawLine;
      case 'assign':
        return {
          kind: 'rawLine',
          text: `${cls.target} = ${cls.expr}`,
          loc: spanOf(line),
          _assign: { target: cls.target, expr: cls.expr },
        } as RawLine;
      default:
        return this.buildTextNode(synthetic, 'textLine');
    }
  }

  /** 解析一条语句（当前行 `indent === minIndent`） */
  private parseStatement(
    cls: LineClass,
    line: LogicalLine,
    state: { choiceSeen: boolean; menuSeen: boolean },
  ): SugarNode | null {
    switch (cls.kind) {
      case 'ifHead':
        return this.parseIfBlock(line);
      case 'whenHead':
        return this.parseWhenBlock(line, cls.subject);
      case 'exprHead':
        return this.parseExprHead(line, cls);
      case 'randomHead': {
        this.cursor.next();
        return this.parseRandomBody(line);
      }
      case 'sectionHead': {
        this.cursor.next();
        return this.parseSectionBody(line, cls);
      }
      case 'onceHead': {
        // `初回 "key"：`（1 号任务）：引擎 `ONCE(...)` 的块形糖。
        this.cursor.next();
        return this.parseOnceBody(line, cls.key);
      }
      case 'randomInline': {
        this.cursor.next();
        return {
          kind: 'randomInline',
          alternatives: cls.alternatives,
          loc: spanOf(line),
          _randomShape: this.randomShape,
        } as RandomInline;
      }
      case 'choiceHead': {
        this.cursor.next();
        if (state.choiceSeen) {
          this.sink.report({
            code: 'choice-multiple',
            severity: 'error',
            message: '一个「时机」内只允许一个「选项」块（两个 INPUTS 会争用同一个 RESULTS）。多轮选择请用原生 `$标签` + `GOTO`。',
            loc: posOf(line),
          });
        }
        return this.parseChoiceBody(line);
      }
      case 'menuHead': {
        this.cursor.next();
        if (state.menuSeen) {
          this.sink.report({
            code: 'choice-multiple',
            severity: 'error',
            message: '一个「时机」内只允许一个「菜单」块（两个 INPUT 会争用同一个 RESULT）。多轮选择请用原生 `$标签` + `GOTO` 回跳。',
            loc: posOf(line),
          });
        }
        return this.parseMenuBody(line);
      }
      case 'askMHead':
      case 'askYNHead': {
        this.cursor.next();
        // `询问` / `确认`：引擎封装问答函数调用。多次调用各自读回 `RESULT`、顺序执行互不冲突，
        // 故**不设**「每时机一个」限制（与 `选项`/`菜单` 的 INPUTS/INPUT 争用不同）。
        return this.parseAskBody(line, cls.prompt, cls.kind === 'askMHead' ? 'askMBlock' : 'askYNBlock');
      }
      case 'colorHead': {
        this.cursor.next();
        return this.parseColorBody(line, cls.color);
      }
      case 'heartHead': {
        this.cursor.next();
        return this.parseHeartBody(line);
      }
      case 'groupHead': {
        this.cursor.next();
        return this.parseGroupBody(line);
      }
      case 'rawLine': {
        this.cursor.next();
        return { kind: 'rawLine', text: cls.text, loc: spanOf(line) } as RawLine;
      }
      case 'settle': {
        // 经验结算行（B5）：`结算 <表达式>` 逐字接到 `EXP:` 前缀后，产一行原生 ERB
        // 直通行（原样透传、不降糖、不解释作用域词）——保证手写与本糖产物同一字节形。
        this.cursor.next();
        return { kind: 'rawLine', text: 'EXP:' + cls.expr, loc: spanOf(line) } as RawLine;
      }
      case 'assign': {
        // 语句级赋值 `X = 表达式`：左值走 §5.0 别名展开（只读别名报
        // `readonly-alias-assignment`），右值走表达式降糖——两者都在 codegen
        // 完成（需要别名表）。此处用 `rawLine` 承载，并挂 `_assign` 标记区分于
        // 真正的原生直通行（后者原样透传、不降糖）。
        this.cursor.next();
        return {
          kind: 'rawLine',
          text: `${cls.target} = ${cls.expr}`,
          loc: spanOf(line),
          _assign: { target: cls.target, expr: cls.expr },
        } as RawLine;
      }
      case 'text': {
        this.cursor.next();
        return this.buildTextNode(line, 'textLine');
      }
      case 'blankLine': {
        this.cursor.next();
        return this.buildBlankNode(line, cls.wait);
      }
      case 'heartText': {
        this.cursor.next();
        return this.buildHeartNode(line, cls.raw);
      }
      case 'callStatement': {
        // `调用 名字(实参)`（B4 批）：语句位置用户函数调用——对任何块体都合法。
        this.cursor.next();
        return { kind: 'callStatement', name: cls.name, args: cls.args, loc: spanOf(line) };
      }
      case 'returnStatement': {
        // `返回 [值]`（B4 批）：是否合法由 codegen 判定（只在「函数」块内合法）。
        this.cursor.next();
        return {
          kind: 'returnStatement',
          loc: spanOf(line),
          ...(cls.value !== undefined ? { value: cls.value } : {}),
        };
      }
      case 'singleIfHead':
        // 单行条件（本批）：`如果 条件 则 语句` —— 一条语句，**不消费后续行**。
        return this.parseSingleIfStatement(line, cls);
      case 'comment':
        // 注释**保留**（用户 2026-10-12 第 3 条：注释不能丢）——推进游标后作为
        // `comment` 节点收进当前块体（空行仍按 §3.10 丢弃：只用于分隔）。
        this.cursor.next();
        return { kind: 'comment', text: contentOf(line), loc: spanOf(line) };
      case 'blank':
        this.cursor.next();
        return null;
      default:
        // 不该出现的类别（如头部声明写在体内）
        this.cursor.next();
        this.sink.report({
          code: 'indent-mismatch',
          severity: 'error',
          message: '这一行不能出现在「时机」正文里。',
          loc: posOf(line),
        });
        return null;
    }
  }

  /** 跳过比给定缩进更深的行（错误恢复；不生成半成品） */
  private skipOverIndented(indent: number): void {
    while (!this.cursor.done) {
      const l = this.cursor.peek()!;
      if (contentOf(l).length === 0) {
        this.cursor.next();
        continue;
      }
      if (l.indent < indent) return;
      this.cursor.next();
    }
  }

  /* ------------------------------ 文本行 ------------------------------ */

  private buildTextNode(line: LogicalLine, kind: 'textLine' | 'heartLine'): TextLine | HeartLine {
    const parsed = parseTextLine(line, this.sink);
    return {
      kind,
      speech: parsed.speech,
      wait: parsed.wait,
      interpolations: parsed.interpolations,
      loc: spanOf(line),
      // 契约层不复制源片段；转译器按 `loc` 从源文本切片重建。
      // 这里直接携带**剥掉 `续` 标记后**的行原文（与插值列号同坐标系）。
      _raw: parsed.body,
    } as TextLine | HeartLine;
  }

  /**
   * `空行` → 一条**文本为空的文本行**（规范 §3.3；批 P）。
   *
   * 不新增 AST 节点：它本来就是"一行文本，只是文本为空"，产物规则与旁白同源
   * （`wait` 由 `空行` / `空行 等待` 决定）。这样做的代价是零扩散——所有遍历 AST 的
   * 地方（转译 / 预览 / 校验 / 高亮）不必为一个词多开一条分支。
   */
  private buildBlankNode(line: LogicalLine, wait: boolean): TextLine {
    return {
      kind: 'textLine',
      speech: false,
      wait,
      interpolations: [],
      loc: spanOf(line),
      _raw: '',
    } as TextLine;
  }

  /** 构建 `心形` 行（规范 §3.9）——判定规则与 TextLine 完全相同，仅标记不同 */
  private buildHeartNode(line: LogicalLine, raw: string): HeartLine {
    const { text, wait } = stripCont(raw, this.sink, line);
    const interpolations = scanInterpolations(text, line.line, this.sink);
    const speech = detectSpeechOf(text, interpolations);
    return {
      kind: 'heartLine',
      speech,
      wait,
      interpolations,
      loc: spanOf(line),
      _raw: text,
    } as HeartLine;
  }

  /* ------------------------------ 如果块 ------------------------------ */

  private parseIfBlock(headLine: LogicalLine): IfBlock {
    this.cursor.next();
    const headCls = classifyLine(headLine);
    // 本方法同时服务「语句级 如果 块」与「表达式 如果」（规范 §3.5）。
    // 语句级的头是 `ifHead`，表达式级的头是 `exprHead`——两者的条件原文分别在
    // `condition` / `rest` 上，这里统一成条件原文（契约规定 `else` 分支为空串）。
    const headCondition =
      headCls.kind === 'ifHead' ? headCls.condition : headCls.kind === 'exprHead' ? headCls.rest : '';
    const headInline = headCls.kind === 'ifHead' ? headCls.inline : undefined;
    const branches: IfBranch[] = [];
    let current: IfBranch = {
      kind: 'if',
      condition: headCondition,
      body: [],
      loc: spanOf(headLine),
    };
    branches.push(current);

    // 单行形式 `如果 条件： 内容`（规范 §3.5）——行内体直接成为首分支正文
    if (headInline && headInline.length > 0) {
      current.body.push(this.buildInlineNode(headLine, headInline));
    }

    const bodyIndent = headLine.indent + 1;
    while (!this.cursor.done) {
      const line = this.cursor.peek()!;
      const content = contentOf(line);
      if (content.length === 0) {
        this.cursor.next();
        // 空行在块体里仅作分隔；不退出（可能后面还有更深或更浅的同级分支）
        const nx = this.cursor.peek();
        if (!nx) break;
        if (contentOf(nx).length === 0) {
          this.cursor.next();
          continue;
        }
        if (nx.indent < headLine.indent) break;
        if (nx.indent === headLine.indent) {
          const c = classifyLine(nx);
          if (!(c.kind === 'ifHead' && c.variant !== 'if')) break;
        }
        continue;
      }
      if (line.indent < headLine.indent) break;
      if (line.indent === headLine.indent) {
        const c = classifyLine(line);
        if (c.kind === 'ifHead' && c.variant !== 'if') {
          this.cursor.next();
          current = { kind: c.variant, condition: c.condition, body: [], loc: spanOf(line) };
          branches.push(current);
          continue;
        }
        break; // 同级非分支行 → 本块结束
      }
      // 更深：进当前分支体
      const sub = new BlockParser(this.cursor, bodyIndent, this.sink, this.randomShape);
      const nodes = sub.parseBody();
      current.body.push(...nodes);
    }

    if (current.body.length === 0) {
      this.sink.report({
        code: 'block-empty',
        severity: 'error',
        message: '「如果」/「否则」分支没有正文（缩进更深的内容）。',
        loc: branches[branches.length - 1]!.loc.start,
      });
    }
    return { kind: 'ifBlock', branches, loc: mergeSpan(branches) };
  }

  /* ------------------------------ 当块 ------------------------------ */

  private parseWhenBlock(headLine: LogicalLine, subject: string): WhenBlock {
    this.cursor.next();
    const block = this.parseWhenBodyAfterHead(headLine, subject);
    this.checkRandCoverage(block);
    return block;
  }

  /**
   * E17：语句面「当」块的 `RAND:n` **缺档**诊断（规格见 `docs/SYNTAX-SUGAR-SURFACE-SPEC.md` §3.6 / §8）。
   *
   * 仅查**可证伪**的情形——主体是常量 `RAND:n` / 糖形 `随机(n)`（n ≥ 1 的十进制字面量）、
   * **没有** `否则：` 分支、且所有 `是` 值均为十进制字面量（单值或 `a 到 b` 区间）时，
   * `是` 档位并集未盖满 `0..n-1` → 报错（掷到缺失档位时引擎静默、什么都不会打印）。
   *
   * 主语含别名 / 变量 / 字符串字面量，或分支值含非数字字面量 → **一律不报**
   * （无法证明缺档，宁可不报、绝不猜）。表达式「当」（赋值位，`parseWhenExpr`）已有
   * `expr-missing-else` 覆盖，不走此处；原生 `SELECTCASE` 亦不在糖管辖内。
   */
  private checkRandCoverage(block: WhenBlock): void {
    const n = randLiteralCount(block.subject);
    if (n === null) return;
    if (block.branches.some((b) => b.kind === 'else')) return;

    const intervals: Array<readonly [number, number]> = [];
    const written: string[] = [];
    for (const branch of block.branches) {
      if (branch.kind !== 'case') continue;
      for (const v of branch.values) {
        const from = intLiteral(v.from);
        if (from === null) return; // 含无法证明的值 → 放弃（不猜）
        if (v.to === null) {
          intervals.push([from, from]);
          written.push(v.from.trim());
        } else {
          const to = intLiteral(v.to);
          if (to === null) return;
          intervals.push([from, to]);
          written.push(`${v.from.trim()} 到 ${v.to.trim()}`);
        }
      }
    }

    if (coversRange(intervals, n)) return;
    this.sink.report({
      code: 'rand-case-incomplete',
      severity: 'error',
      message:
        `「当 ${block.subject}：」的档位（${written.join('、')}）没盖满 0 到 ${n - 1}，` +
        `也没有「否则：」——掷到没写的档位时什么都不会发生。请补齐档位，或加一个「否则：」。`,
      loc: block.loc.start,
    });
  }

  /** 已消费行之后的块体解析（随机候选里出现块头时） */
  private parseWhenBlockFromClass(line: LogicalLine, subject: string): WhenBlock {
    return this.parseWhenBodyAfterHead(line, subject);
  }

  private parseWhenBodyAfterHead(headLine: LogicalLine, subject: string): WhenBlock {
    const branches: WhenBranch[] = [];
    const bodyIndent = headLine.indent + 1;

    while (!this.cursor.done) {
      const line = this.cursor.peek()!;
      const content = contentOf(line);
      if (content.length === 0) {
        this.cursor.next();
        continue;
      }
      if (line.indent < headLine.indent) break;
      if (line.indent === headLine.indent) break; // 同级 = 本块结束

      const cls = classifyLine(line);
      if (cls.kind === 'caseHead' && line.indent === bodyIndent) {
        this.cursor.next();
        const sub = new BlockParser(this.cursor, bodyIndent + 1, this.sink, this.randomShape);
        const body = sub.parseBody();
        if (body.length === 0) {
          this.sink.report({
            code: 'block-empty',
            severity: 'error',
            message: '「是 …」分支没有正文。',
            loc: posOf(line),
          });
        }
        branches.push({ kind: 'case', values: cls.values, body, loc: spanOf(line) });
        continue;
      }
      if (cls.kind === 'ifHead' && cls.variant === 'else' && line.indent === bodyIndent) {
        this.cursor.next();
        const sub = new BlockParser(this.cursor, bodyIndent + 1, this.sink, this.randomShape);
        const body = sub.parseBody();
        branches.push({ kind: 'else', values: [], body, loc: spanOf(line) });
        continue;
      }
      // 更深但既非 是/否则 → 缩进异常
      if (line.indent > bodyIndent) {
        this.sink.report({
          code: 'indent-mismatch',
          severity: 'error',
          message: '「当」块里只允许「是 …：」/「否则：」分支（缩进异常）。',
          loc: posOf(line),
        });
        this.skipOverIndented(line.indent);
        continue;
      }
      break;
    }

    if (branches.length === 0) {
      this.sink.report({
        code: 'block-empty',
        severity: 'error',
        message: '「当」块没有任何「是」分支。',
        loc: posOf(headLine),
      });
    }
    return { kind: 'whenBlock', subject, branches, loc: mergeSpan2(headLine, branches) };
  }

  /* ------------------------------ 表达式 如果 / 当 ------------------------------ */

  private parseExprHead(
    headLine: LogicalLine,
    cls: LineClass & { kind: 'exprHead' },
  ): IfExpr | WhenExpr | null {
    if (cls.variant === 'if') return this.parseIfExpr(headLine, cls);
    return this.parseWhenExpr(headLine, cls);
  }

  private parseIfExpr(
    headLine: LogicalLine,
    cls: LineClass & { kind: 'exprHead' },
  ): IfExpr | null {
    const block = this.parseIfBlock(headLine);
    // 分支体必须各含单个表达式节点
    for (const branch of block.branches) {
      if (branch.body.length !== 1) {
        this.sink.report({
          code: 'expr-body-not-expression',
          severity: 'error',
          message: '表达式「如果」的每个分支只能写一个值（一个表达式）。',
          loc: branch.loc.start,
        });
        return null;
      }
    }
    if (!block.branches.some((b) => b.kind === 'else')) {
      this.sink.report({
        code: 'expr-missing-else',
        severity: 'error',
        message: '表达式「如果」必须有「否则」分支，否则目标变量在有的路径上不会被赋值。',
        loc: block.loc.start,
      });
      return null;
    }
    return { kind: 'ifExpr', target: cls.target, block, loc: block.loc };
  }

  private parseWhenExpr(
    headLine: LogicalLine,
    cls: LineClass & { kind: 'exprHead' },
  ): WhenExpr | null {
    const block = this.parseWhenExprBody(headLine, cls.rest);
    for (const branch of block.branches) {
      if (branch.body.length !== 1) {
        this.sink.report({
          code: 'expr-body-not-expression',
          severity: 'error',
          message: '表达式「当」的每个分支只能写一个值（`是 值 -> 表达式`）。',
          loc: branch.loc.start,
        });
        return null;
      }
    }
    if (!block.branches.some((b) => b.kind === 'else')) {
      this.sink.report({
        code: 'expr-missing-else',
        severity: 'error',
        message: '表达式「当」必须有「否则」分支，否则目标变量在有的路径上不会被赋值。',
        loc: block.loc.start,
      });
      return null;
    }
    return { kind: 'whenExpr', target: cls.target, block, loc: block.loc };
  }

  /** 表达式 `当` 的块体：`是 值 -> 表达式` / `否则 -> 表达式` */
  private parseWhenExprBody(headLine: LogicalLine, subject: string): WhenBlock {
    this.cursor.next();
    const branches: WhenBranch[] = [];
    const bodyIndent = headLine.indent + 1;
    while (!this.cursor.done) {
      const line = this.cursor.peek()!;
      const content = contentOf(line);
      if (content.length === 0) {
        this.cursor.next();
        continue;
      }
      if (line.indent !== bodyIndent) break;
      const arrow = parseArrowCase(content);
      if (!arrow) {
        this.sink.report({
          code: 'expr-body-not-expression',
          severity: 'error',
          message: '表达式「当」的分支要写成「是 值 -> 表达式」或「否则 -> 表达式」。',
          loc: posOf(line),
        });
        break;
      }
      this.cursor.next();
      const valueLoc = spanOf(line);
      const exprNode: RawLine = { kind: 'rawLine', text: arrow.value, loc: valueLoc };
      if (arrow.kind === 'else') {
        branches.push({ kind: 'else', values: [], body: [exprNode], loc: valueLoc });
      } else {
        branches.push({ kind: 'case', values: arrow.values, body: [exprNode], loc: valueLoc });
      }
    }
    if (branches.length === 0) {
      this.sink.report({
        code: 'block-empty',
        severity: 'error',
        message: '表达式「当」没有任何「是 … -> …」分支。',
        loc: posOf(headLine),
      });
    }
    return { kind: 'whenBlock', subject, branches, loc: mergeSpan2(headLine, branches) };
  }

  /* ------------------------------ 随机块 ------------------------------ */

  private parseRandomBody(headLine: LogicalLine): RandomBlock {
    const bodyIndent = headLine.indent + 1;
    const alternatives: { body: SugarNode[]; loc: SugarSourceSpan }[] = [];
    while (!this.cursor.done) {
      const line = this.cursor.peek()!;
      const content = contentOf(line);
      if (content.length === 0) {
        this.cursor.next();
        continue;
      }
      if (line.indent < bodyIndent) break;
      if (line.indent !== bodyIndent) {
        this.sink.report({
          code: 'indent-mismatch',
          severity: 'error',
          message: '「随机」块的候选必须同级（每个候选是缩进一级的内容）。',
          loc: posOf(line),
        });
        this.skipOverIndented(line.indent);
        continue;
      }
      const cls = classifyLine(line);
      if (cls.kind === 'comment') {
        this.cursor.next();
        continue;
      }
      // 候选路径不过 parseBody，须在此补「选项」/「菜单」块守卫（与块体同款）
      if (cls.kind === 'choiceHead') {
        this.cursor.next();
        this.sink.report({
          code: 'choice-nested',
          severity: 'error',
          message: '「选项」块不能嵌套（内层 INPUTS 会覆盖外层 RESULTS）。',
          loc: posOf(line),
        });
        this.parseChoiceBody(line); // 仍解析以正确跳行，节点丢弃
        continue;
      }
      if (cls.kind === 'menuHead') {
        this.cursor.next();
        this.sink.report({
          code: 'choice-nested',
          severity: 'error',
          message: '「菜单」块不能嵌套（内层 INPUT 会覆盖外层 RESULT）。',
          loc: posOf(line),
        });
        this.parseMenuBody(line); // 仍解析以正确跳行，节点丢弃
        continue;
      }
      // 候选：一行内容（可为文本行 / 心形 / 原生行 / 深一层块）
      this.cursor.next();
      const startLine = line;
      const node = this.buildStandaloneNode(cls, line);
      // 若候选行是块头，继续吃缩进更深的行
      if (node && isBlockNode(node)) {
        const sub = new BlockParser(this.cursor, bodyIndent + 1, this.sink, this.randomShape);
        const extra = sub.parseBody();
        mergeBlockBody(node, extra);
      }
      const loc: SugarSourceSpan = {
        start: posOf(startLine),
        end: { line: this.cursor.lines[Math.max(0, this.cursor.index - 1)]?.endLine ?? startLine.endLine, column: 1 },
      };
      if (node) alternatives.push({ body: [node], loc });
    }
    if (alternatives.length === 0) {
      this.sink.report({
        code: 'block-empty',
        severity: 'error',
        message: '「随机」块没有任何候选。',
        loc: posOf(headLine),
      });
    }
    return {
      kind: 'randomBlock',
      alternatives,
      loc: mergeSpan2(headLine, alternatives),
      // P-4 产物模式（转译器内部决策，契约 `RandomBlock` 不含此字段）
      _randomShape: this.randomShape,
    } as RandomBlockT;
  }

  /** 把一行内容作为独立节点构建（随机候选 / 选项体内联用） */
  private buildStandaloneNode(cls: LineClass, line: LogicalLine): SugarNode | null {
    switch (cls.kind) {
      case 'text':
        return this.buildTextNode(line, 'textLine');
      case 'blankLine':
        return this.buildBlankNode(line, cls.wait);
      case 'heartText':
        return this.buildHeartNode(line, cls.raw);
      case 'callStatement':
        return { kind: 'callStatement', name: cls.name, args: cls.args, loc: spanOf(line) };
      case 'returnStatement':
        return {
          kind: 'returnStatement',
          loc: spanOf(line),
          ...(cls.value !== undefined ? { value: cls.value } : {}),
        };
      case 'singleIfHead':
        return this.parseSingleIfStatement(line, cls);
      case 'rawLine':
        return { kind: 'rawLine', text: cls.text, loc: spanOf(line) } as RawLine;
      case 'settle':
        return { kind: 'rawLine', text: 'EXP:' + cls.expr, loc: spanOf(line) } as RawLine;
      case 'ifHead':
        return this.parseIfBlockFromClass(line, cls);
      case 'whenHead':
        return this.parseWhenBlockFromClass(line, cls.subject);
      case 'randomHead':
        return this.parseRandomBody(line);
      case 'sectionHead':
        return this.parseSectionBody(line, cls);
      case 'onceHead':
        return this.parseOnceBody(line, cls.key);
      case 'randomInline':
        return {
          kind: 'randomInline',
          alternatives: cls.alternatives,
          loc: spanOf(line),
          _randomShape: this.randomShape,
        } as RandomInline;
      case 'colorHead':
        return this.parseColorBody(line, cls.color);
      case 'heartHead':
        return this.parseHeartBody(line);
      case 'groupHead':
        return this.parseGroupBody(line);
      case 'choiceHead':
        return this.parseChoiceBody(line);
      case 'menuHead':
        return this.parseMenuBody(line);
      case 'askMHead':
      case 'askYNHead':
        return this.parseAskBody(line, cls.prompt, cls.kind === 'askMHead' ? 'askMBlock' : 'askYNBlock');
      case 'exprHead':
        return this.parseExprHead(line, cls);
      case 'assign':
        return {
          kind: 'rawLine',
          text: `${cls.target} = ${cls.expr}`,
          loc: spanOf(line),
          _assign: { target: cls.target, expr: cls.expr },
        } as RawLine;
      default:
        return null;
    }
  }

  /** 已消费行之后的块体解析（随机候选里出现块头时） */
  private parseIfBlockFromClass(line: LogicalLine, cls: LineClass & { kind: 'ifHead' }): IfBlock {
    const branches: IfBranch[] = [{ kind: 'if', condition: cls.condition, body: [], loc: spanOf(line) }];
    let current = branches[0]!;
    const bodyIndent = line.indent + 1;
    while (!this.cursor.done) {
      const l = this.cursor.peek()!;
      const content = contentOf(l);
      if (content.length === 0) {
        this.cursor.next();
        continue;
      }
      if (l.indent < line.indent) break;
      if (l.indent === line.indent) {
        const c = classifyLine(l);
        if (c.kind === 'ifHead' && c.variant !== 'if') {
          this.cursor.next();
          current = { kind: c.variant, condition: c.condition, body: [], loc: spanOf(l) };
          branches.push(current);
          continue;
        }
        break;
      }
      const sub = new BlockParser(this.cursor, bodyIndent, this.sink, this.randomShape);
      current.body.push(...sub.parseBody());
    }
    return { kind: 'ifBlock', branches, loc: mergeSpan(branches) };
  }

  /* ------------------------------ 段块（E13 批） ------------------------------ */

  /**
   * `若 <ERB条件> [（关）]：` 块体（E13 批；旧形 `段 …：` / `段 … 关：` 兼容）——库内
   * 「多信封分段」的糖形。
   *
   * 判据与 `随机`/`着色` 同款：块体缩进更深，逐条走 `parseBody`。**禁止段嵌套**
   * （段体内再出现 `段`）——库内信封段是同层的，嵌套会让 `LOCAL` 槽的语义没有
   * 唯一写法；报 `section-nested` 并**不产半成品**（与 `choice-nested` 同口径）。
   */
  private parseSectionBody(headLine: LogicalLine, cls: LineClass & { kind: 'sectionHead' }): SugarNode {
    const bodyIndent = headLine.indent + 1;
    const body: SugarNode[] = [];
    while (!this.cursor.done) {
      const line = this.cursor.peek()!;
      const content = contentOf(line);
      if (content.length === 0) {
        this.cursor.next();
        continue;
      }
      if (line.indent < bodyIndent) break;
      if (line.indent > bodyIndent) {
        this.sink.report({
          code: 'indent-mismatch',
          severity: 'error',
          message: '缩进比同级更深的行前面没有块头。',
          loc: posOf(line),
        });
        this.skipOverIndented(line.indent);
        continue;
      }
      const inner = classifyLine(line);
      if (inner.kind === 'sectionHead') {
        // 段嵌套：报错，但**仍然解析**以正确跳行（与 `choice-nested` 同款错误恢复）
        this.cursor.next();
        this.sink.report({
          code: 'section-nested',
          severity: 'error',
          message: '「若」块不能嵌套——一个「时机」里的段是同层的，段内请用「如果」分叉。',
          loc: posOf(line),
        });
        this.parseSectionBody(line, inner);
        continue;
      }
      const node = this.parseStatement(inner, line, { choiceSeen: false, menuSeen: false });
      if (node) body.push(node);
    }
    if (body.length === 0) {
      this.sink.report({
        code: 'block-empty',
        severity: 'error',
        message: '「若」块没有正文（缩进更深的内容）。',
        loc: posOf(headLine),
      });
    }
    // P-3 保留段名（`首次`）：段头**恰为**表内词 ⇒ 挂 `_preset`，codegen 走整串硬编译
    // 分支（不把段名交给 `lowerExpression`，否则会吐 `unknown-identifier`）。
    const preset = RESERVED_SECTION_NAMES.get(cls.condition);
    return {
      kind: 'sectionBlock',
      condition: cls.condition,
      disabled: cls.disabled,
      body,
      loc: mergeSpan2(headLine, body.map((n) => ({ loc: n.loc }))),
      ...(preset ? { _preset: preset } : {}),
    } as SugarNode;
  }

  /* ------------------------------ 初回块（1 号任务） ------------------------------ */

  /**
   * `初回 "key"：` 块体（1 号任务）——引擎 `ONCE(...)` 变量式访问器的块形糖。
   *
   * 判据与 `着色` / `段` 同款：块体缩进更深，逐条走 `BlockParser.parseBody`（故块内
   * `你：` / `着色` 的 run 口径与其它块完全同源）。**缺 key / 空体一律 fail-closed**：
   * 报 `block-empty` 并**整块不产**（返回 null）——不拼半成品。
   */
  private parseOnceBody(headLine: LogicalLine, key: string): SugarNode | null {
    const bodyIndent = headLine.indent + 1;
    const sub = new BlockParser(this.cursor, bodyIndent, this.sink, this.randomShape);
    const body = sub.parseBody();
    if (key.trim().length === 0) {
      this.sink.report({
        code: 'block-empty',
        severity: 'error',
        message: '「初回」块头缺 key——写法是 `初回 "key"：`（key 进产物 `IF ONCE(<key>)`，字符串字面量或既有表达式口径均可）。',
        loc: posOf(headLine),
      });
      return null;
    }
    if (body.length === 0) {
      this.sink.report({
        code: 'block-empty',
        severity: 'error',
        message: '「初回」块没有正文（缩进更深的内容）。',
        loc: posOf(headLine),
      });
      return null;
    }
    return {
      kind: 'onceBlock',
      key: key.trim(),
      body,
      loc: mergeSpan2(headLine, body.map((n) => ({ loc: n.loc }))),
    } as SugarNode;
  }

  /* ------------------------------ 选项块 ------------------------------ */

  /**
   * `选项：` 块体（按钮形）——产物见 `codegen.emitChoiceBlock`。
   */
  private parseChoiceBody(headLine: LogicalLine): SugarNode {
    return this.parseItemizedBlock(headLine, '选项', 'choiceBlock');
  }

  /**
   * `菜单：` 块体（数字输入菜单形）——**条目结构与 `选项` 完全同形**
   * （`「标签」：` + 缩进分支体），差别只在产物（见 `codegen.emitMenuBlock`）。
   */
  private parseMenuBody(headLine: LogicalLine): SugarNode {
    return this.parseItemizedBlock(headLine, '菜单', 'menuBlock');
  }

  /**
   * `选项` / `菜单` 共用条目解析：条目 = `「标签」：` + 缩进分支体，逐条收集。
   * `blockName`（`选项` / `菜单`）仅用于诊断文案；`kind` 决定节点类型。
   */
  private parseItemizedBlock(
    headLine: LogicalLine,
    blockName: string,
    kind: 'choiceBlock' | 'menuBlock',
  ): SugarNode {
    const itemIndent = headLine.indent + 1;
    const items: { label: string; body: SugarNode[]; loc: SugarSourceSpan }[] = [];
    while (!this.cursor.done) {
      const line = this.cursor.peek()!;
      const content = contentOf(line);
      if (content.length === 0) {
        this.cursor.next();
        continue;
      }
      if (line.indent < itemIndent) break;
      if (line.indent !== itemIndent) {
        this.sink.report({
          code: 'indent-mismatch',
          severity: 'error',
          message: `「${blockName}」的条目必须同级（每个条目是 \`「文本」：\` + 缩进正文）。`,
          loc: posOf(line),
        });
        this.skipOverIndented(line.indent);
        continue;
      }
      if (!endsWithColon(content)) {
        this.sink.report({
          code: 'indent-mismatch',
          severity: 'error',
          message: `「${blockName}」的条目要写成 \`「文本」：\`（以全角冒号结尾）。`,
          loc: posOf(line),
        });
        this.cursor.next();
        continue;
      }
      this.cursor.next();
      const label = stripQuotes(stripTrailingColon(content));
      const sub = new BlockParser(this.cursor, itemIndent + 1, this.sink, this.randomShape);
      const body = sub.parseChoiceItemBody();
      items.push({ label, body, loc: spanOf(line) });
    }
    if (items.length === 0) {
      this.sink.report({
        code: 'block-empty',
        severity: 'error',
        message: `「${blockName}」块没有任何条目。`,
        loc: posOf(headLine),
      });
    }
    return {
      kind,
      items,
      loc: mergeSpan2(headLine, items),
    } as SugarNode;
  }

  /**
   * `询问` / `确认` 块体——条目 = `「标签」 [逐项显示条件]：` + 缩进分支体（与 `选项`/`菜单` 同构，
   * 多一枚**逐项显示条件** `[逐项显示条件]`；可选、缺省 `1`）。头部可选提示文案在此合成为一枚
   * `textLine`（走文本行管线：插值 / 台词色都照常），附在节点上由 codegen 经 `emitBody` 发出。
   *
   * **项数下限/上限是游戏知识**（由 adapter `KojoAskForm` 声明），故本段不校验——
   * 交由 codegen（`emitAskBlock`）按表判定、fail-closed 不产半成品。
   */
  private parseAskBody(
    headLine: LogicalLine,
    promptRaw: string | undefined,
    kind: 'askMBlock' | 'askYNBlock',
  ): SugarNode {
    const itemIndent = headLine.indent + 1;
    const blockName = kind === 'askMBlock' ? '询问' : '确认';
    const items: AskItem[] = [];
    while (!this.cursor.done) {
      const line = this.cursor.peek()!;
      const content = contentOf(line);
      if (content.length === 0) {
        this.cursor.next();
        continue;
      }
      if (line.indent < itemIndent) break;
      if (line.indent !== itemIndent) {
        this.sink.report({
          code: 'indent-mismatch',
          severity: 'error',
          message: `「${blockName}」的条目必须同级（每个条目是 \`「文本」 [逐项显示条件]：\` + 缩进正文）。`,
          loc: posOf(line),
        });
        this.skipOverIndented(line.indent);
        continue;
      }
      if (!endsWithColon(content)) {
        this.sink.report({
          code: 'indent-mismatch',
          severity: 'error',
          message: `「${blockName}」的条目要写成 \`「文本」 [逐项显示条件]：\`（以全角冒号结尾）。`,
          loc: posOf(line),
        });
        this.cursor.next();
        continue;
      }
      this.cursor.next();
      const { label, value } = splitAskItem(stripTrailingColon(content));
      const sub = new BlockParser(this.cursor, itemIndent + 1, this.sink, this.randomShape);
      const body = sub.parseBody();
      items.push(value !== undefined ? { label, value, body, loc: spanOf(line) } : { label, body, loc: spanOf(line) });
    }
    if (items.length === 0) {
      this.sink.report({
        code: 'block-empty',
        severity: 'error',
        message: `「${blockName}」块没有任何条目。`,
        loc: posOf(headLine),
      });
    }
    const prompt = promptRaw === undefined ? undefined : this.buildAskPrompt(headLine, promptRaw);
    return {
      kind,
      ...(prompt !== undefined ? { prompt } : {}),
      items,
      loc: mergeSpan2(headLine, items),
    } as SugarNode;
  }

  /** 头部可选提问文案 → `textLine`（走文本行管线：插值 / 台词色与普通正文同源） */
  private buildAskPrompt(headLine: LogicalLine, raw: string): TextLine {
    // 作者可写 `询问 "文案"：`（ASCII 引号包裹，剥掉引号）或 `询问 文案：`（原文即文案）。
    const text = stripAskPrompt(raw);
    const synthetic: LogicalLine = { ...headLine, text: headLine.rawIndent + text };
    return this.buildTextNode(synthetic, 'textLine') as TextLine;
  }

  /* ------------------------------ 着色块 ------------------------------ */

  private parseColorBody(headLine: LogicalLine, color: string): SugarNode {
    const bodyIndent = headLine.indent + 1;
    const sub = new BlockParser(this.cursor, bodyIndent, this.sink, this.randomShape);
    const body = sub.parseBody();
    if (body.length === 0) {
      this.sink.report({
        code: 'block-empty',
        severity: 'error',
        message: '「着色」块没有正文。',
        loc: posOf(headLine),
      });
    }
    return {
      kind: 'colorBlock',
      color,
      body,
      loc: mergeSpan2(headLine, body.map((n) => ({ loc: n.loc }))),
    };
  }

  /* ------------------------------ 心形连续块（P-7） ------------------------------ */

  /**
   * `心形：` / `heart：` 连续块体（P-7）——块体**只许文本行**（宁缺勿编）。
   *
   * 逐行按"文本行"规则解析（带「」引号 = 台词，不带 = 旁白，行尾可带 `续`），
   * 存成 `heartLine` 节点；产物端逐行复用单行形的心形管线（`emitTextLine` + `heartCall`），
   * 故模式字母规则与单行形**完全一致**。
   *
   * **fail-closed**：块体混入任何非文本行（控制流 / 赋值 / 别的块 / 缩进异常）⇒
   * 报 error（复用 `indent-mismatch`——与 `着色`/`随机`/`当` 对"块内非法内容"同一码），
   * 并给节点挂 `_invalid` ⇒ codegen 对该块**一条字节都不产**（不生成半成品）。
   */
  private parseHeartBody(headLine: LogicalLine): SugarNode {
    const bodyIndent = headLine.indent + 1;
    const body: SugarNode[] = [];
    let invalid = false;
    while (!this.cursor.done) {
      const line = this.cursor.peek()!;
      const content = contentOf(line);
      if (content.length === 0) {
        this.cursor.next();
        continue;
      }
      if (line.indent < bodyIndent) break;
      if (line.indent > bodyIndent) {
        // 更深但前面没有块头承接 → 缩进异常（与 `段`/`随机` 同款错误恢复）
        this.sink.report({
          code: 'indent-mismatch',
          severity: 'error',
          message: '「心形：」块里只允许文本行（台词 / 旁白，行尾可带 `续`）——这里缩进更深，前面却没有块头。',
          loc: posOf(line),
        });
        invalid = true;
        this.skipOverIndented(line.indent);
        continue;
      }
      const cls = classifyLine(line);
      switch (cls.kind) {
        case 'text':
        case 'heartText': {
          // `text` 用整行原文；`heartText` 是行内 `心形 「…」` 的体（已剥掉前缀）——
          // 两者都走"文本行规则"（`buildHeartNode`），与单行形完全同源。
          this.cursor.next();
          body.push(this.buildHeartNode(line, cls.kind === 'text' ? content : cls.raw));
          break;
        }
        case 'comment': {
          // 注释保留（"注释不能丢"）——它不是语句，不参与"只许文本行"判据
          this.cursor.next();
          body.push({ kind: 'comment', text: contentOf(line), loc: spanOf(line) });
          break;
        }
        case 'blank': {
          this.cursor.next();
          break;
        }
        default: {
          // 控制流 / 赋值 / 别的块 / 头部声明 …… 一律非法（宁缺勿编）
          this.cursor.next();
          this.sink.report({
            code: 'indent-mismatch',
            severity: 'error',
            message: '「心形：」块里只允许文本行（台词 / 旁白，行尾可带 `续`）——控制流 / 赋值 / 别的块不能写进来。',
            loc: posOf(line),
          });
          invalid = true;
          break;
        }
      }
    }
    if (!invalid && body.length === 0) {
      this.sink.report({
        code: 'block-empty',
        severity: 'error',
        message: '「心形：」块没有正文（缩进更深的内容）。',
        loc: posOf(headLine),
      });
    }
    return {
      kind: 'heartBlock',
      body,
      _invalid: invalid,
      loc: mergeSpan2(headLine, body),
    } as unknown as SugarNode;
  }

  /* ------------------------------ 候选组（E18） ------------------------------ */

  /**
   * `组：` 候选组（规范 §3.6）——把「一个候选想说好几句」收成一条候选。
   *
   * 组体与「着色」块体同口径（`parseBody`：台词/旁白/心形/空行/原生行/注释/更深的块），
   * 产物端**逐句透传**进所在候选（`codegen` 的 `groupBlock` 分支，不产生包装行）。
   * 空组报 `block-empty`。
   */
  private parseGroupBody(headLine: LogicalLine): GroupBlock {
    const bodyIndent = headLine.indent + 1;
    const sub = new BlockParser(this.cursor, bodyIndent, this.sink, this.randomShape);
    const body = sub.parseBody();
    if (body.length === 0) {
      this.sink.report({
        code: 'block-empty',
        severity: 'error',
        message: '「组：」是空的（组里至少要有一行内容）。',
        loc: posOf(headLine),
      });
    }
    return {
      kind: 'groupBlock',
      body,
      loc: mergeSpan2(headLine, body.map((n) => ({ loc: n.loc }))),
    };
  }

  /* ------------------------------ 通用块体 ------------------------------ */

  /** 解析块体直到缩进回退（块内**不允许** `选项` 块——`choice-nested`） */
  parseBody(): SugarNode[] {
    const out: SugarNode[] = [];
    while (!this.cursor.done) {
      const line = this.cursor.peek()!;
      const content = contentOf(line);
      if (content.length === 0) {
        this.cursor.next();
        continue;
      }
      if (line.indent < this.minIndent) break;
      if (line.indent > this.minIndent) {
        this.sink.report({
          code: 'indent-mismatch',
          severity: 'error',
          message: '缩进比同级更深的行前面没有块头。',
          loc: posOf(line),
        });
        this.skipOverIndented(line.indent);
        continue;
      }
      const cls = classifyLine(line);
      if (cls.kind === 'comment' || cls.kind === 'blank') {
        // 块体里的注释保留（第 3 条）；空行仍丢弃（§3.10）
        this.cursor.next();
        if (cls.kind === 'comment') {
          out.push({ kind: 'comment', text: contentOf(line), loc: spanOf(line) });
        }
        continue;
      }
      if (cls.kind === 'choiceHead') {
        this.cursor.next();
        this.sink.report({
          code: 'choice-nested',
          severity: 'error',
          message: '「选项」块不能嵌套（内层 INPUTS 会覆盖外层 RESULTS）。',
          loc: posOf(line),
        });
        // 仍然解析块体以正确跳行
        this.parseChoiceBody(line);
        continue;
      }
      if (cls.kind === 'menuHead') {
        this.cursor.next();
        this.sink.report({
          code: 'choice-nested',
          severity: 'error',
          message: '「菜单」块不能嵌套（内层 INPUT 会覆盖外层 RESULT）。',
          loc: posOf(line),
        });
        // 仍然解析块体以正确跳行
        this.parseMenuBody(line);
        continue;
      }
      const node = this.parseStatement(cls, line, { choiceSeen: false, menuSeen: false });
      if (node) out.push(node);
    }
    return out;
  }

  /** 选项条目体：不允许 `选项` 块（同上），并允许任意其它块 */
  parseChoiceItemBody(): SugarNode[] {
    return this.parseBody();
  }

  /* ------------------------------ 单行条件（本批） ------------------------------ */

  /**
   * `如果 <条件> 则 <语句>`（本批）→ `singleIfStatement`（产物 `SIF <条件>` + 一条语句行）。
   *
   * **绝不吞后续行**：语句段**不递归解块**——用白名单（`buildSingleIfStatement`）只认
   * 单行语句；块头 / 嵌套单行条件 / 已带冒号的写法一律拒绝并报错，**不调用**任何会消费
   * 后续行的解析器（更深缩进行由外层 `parseBody` 按 `indent-mismatch` 跳过）。
   *
   * 列映射：把语句原文合成一条"语句行"（`rawIndent` = 语句前全前缀），使
   * `contentOf` = 语句原文、`loc.start.column` = 语句在源行里的真实列。
   */
  private parseSingleIfStatement(
    line: LogicalLine,
    cls: LineClass & { kind: 'singleIfHead' },
  ): SugarNode | null {
    this.cursor.next();
    if (cls.condition.length === 0) {
      this.sink.report({
        code: 'indent-mismatch',
        severity: 'error',
        message: '单行条件「如果 … 则 …」缺条件——`则` 前面要写一个条件。',
        loc: posOf(line),
      });
      return null;
    }
    if (cls.statement.length === 0) {
      this.sink.report({
        code: 'block-empty',
        severity: 'error',
        message: '单行条件「如果 … 则 …」缺语句——`则` 后面要写一条语句。',
        loc: posOf(line),
      });
      return null;
    }
    const stmtStart = line.rawIndent.length + cls.statementOffset;
    const synthetic: LogicalLine = {
      ...line,
      text: line.text.slice(0, stmtStart) + cls.statement,
      rawIndent: line.text.slice(0, stmtStart),
      indent: line.indent,
    };
    const statement = this.buildSingleIfStatement(synthetic);
    if (!statement) {
      this.sink.report({
        code: 'indent-mismatch',
        severity: 'error',
        message:
          '单行条件「则」后面只能跟**一条语句**（打印行 / 心形行 / 原生指令行 / `调用` / `返回` 等）——' +
          '块头（带 `：`）与嵌套的「如果 … 则 …」不在此列，请改用多行块。',
        loc: posOf(line),
      });
      return null;
    }
    return {
      kind: 'singleIfStatement',
      condition: cls.condition,
      statement,
      loc: spanOf(line),
    } as SugarNode;
  }

  /**
   * 单行条件的「一条语句」构建：**白名单**——只认能编译成单行产物的语句形态；
   * 块头 / 嵌套单行条件 / 头部声明等一律返回 `null`（由调用方报错，不产半成品、不吞行）。
   */
  private buildSingleIfStatement(line: LogicalLine): SugarNode | null {
    const cls = classifyLine(line);
    switch (cls.kind) {
      case 'text':
        return this.buildTextNode(line, 'textLine');
      case 'heartText':
        return this.buildHeartNode(line, cls.raw);
      case 'blankLine':
        return this.buildBlankNode(line, cls.wait);
      case 'callStatement':
        return { kind: 'callStatement', name: cls.name, args: cls.args, loc: spanOf(line) };
      case 'returnStatement':
        return {
          kind: 'returnStatement',
          loc: spanOf(line),
          ...(cls.value !== undefined ? { value: cls.value } : {}),
        };
      case 'rawLine':
        return { kind: 'rawLine', text: cls.text, loc: spanOf(line) } as RawLine;
      case 'settle':
        return { kind: 'rawLine', text: 'EXP:' + cls.expr, loc: spanOf(line) } as RawLine;
      case 'assign':
        return {
          kind: 'rawLine',
          text: `${cls.target} = ${cls.expr}`,
          loc: spanOf(line),
          _assign: { target: cls.target, expr: cls.expr },
        } as RawLine;
      default:
        // 块头（`如果 X：` / `心形：` / `着色 …：`）/ 嵌套单行条件 / 其它 → 不认
        return null;
    }
  }
}

/* ============================== 小工具 ============================== */

function endsWithColon(s: string): boolean {
  return s.endsWith('：') || s.endsWith(':');
}
function stripTrailingColon(s: string): string {
  if (s.endsWith('：')) return s.slice(0, -1);
  if (s.endsWith(':')) return s.slice(0, -1);
  return s;
}
function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('「') && t.endsWith('」')) || (t.startsWith('｢') && t.endsWith('｣'))) {
    return t.slice(1, -1);
  }
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

/** 提问提示文案：剥掉外层 ASCII 双引号（`"文案"` → `文案`）；未包裹则原文返回 */
function stripAskPrompt(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

/**
 * `「标签」 [逐项显示条件]：` 头（已去尾冒号）→ 标签 + 可选条件原文。
 * 标签引号三种（`「」` / `｢｣` / `""`）与 `选项` 同口径；条件槽是标签后的其余原文（可空 = 缺省 `1`）。
 * 无引号时的兜底：按首个空白切（首段为标签，其余为条件）——`好呀 1` → 标签 `好呀`、条件 `1`。
 */
function splitAskItem(raw: string): { label: string; value?: string } {
  const t = raw.trim();
  const quoted = /^(?:「([^」]*)」|｢([^｣]*)｣|"([^"]*)")\s*([\s\S]*)$/.exec(t);
  if (quoted) {
    const label = (quoted[1] ?? quoted[2] ?? quoted[3])!;
    const rest = quoted[4]!.trim();
    return rest.length > 0 ? { label, value: rest } : { label };
  }
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(t);
  const label = m ? m[1]! : t;
  const value = m?.[2]?.trim();
  return value !== undefined && value.length > 0 ? { label, value } : { label };
}

/** `是 0 到 99 -> 值` / `否则 -> 值` */
function parseArrowCase(content: string): { kind: 'case' | 'else'; values: WhenCaseValue[]; value: string } | null {
  const arrowIdx = content.indexOf('->');
  if (arrowIdx < 0) return null;
  const headPart = content.slice(0, arrowIdx).trim();
  const value = content.slice(arrowIdx + 2).trim();
  if (value.length === 0) return null;
  const m = /^([^\s:：]+)\s*(.*)$/.exec(headPart);
  if (!m) return null;
  const kw = m[1]!;
  if (kw === '否则' || kw === 'else') return { kind: 'else', values: [], value };
  if (kw === '是' || kw === 'is') {
    return { kind: 'case', values: parseCaseValuesInline(m[2]!.trim()), value };
  }
  return null;
}

/** 与 `lexer.parseCaseValues` 同构（此处避免循环依赖） */
function parseCaseValuesInline(rest: string): WhenCaseValue[] {
  if (rest.length === 0) return [];
  const out: WhenCaseValue[] = [];
  for (const part of rest.split(/[,，]/)) {
    const p = part.trim();
    if (p.length === 0) continue;
    const range = /^(.*?)\s+(到|to)\s+(.*)$/.exec(p);
    if (range) out.push({ from: range[1]!.trim(), to: range[3]!.trim(), loc: zeroSpanLocal() });
    else out.push({ from: p, to: null, loc: zeroSpanLocal() });
  }
  return out;
}

function zeroSpanLocal(): SugarSourceSpan {
  return { start: { line: 0, column: 1 }, end: { line: 0, column: 1 } };
}

function mergeSpan(branches: IfBranch[]): SugarSourceSpan {
  const first = branches[0]!;
  const last = branches[branches.length - 1]!;
  return { start: first.loc.start, end: last.loc.end };
}

function mergeSpan2(
  head: { loc?: SugarSourceSpan } | LogicalLine,
  items: { loc: SugarSourceSpan }[],
): SugarSourceSpan {
  const start = 'loc' in head && head.loc ? head.loc.start : posOf(head as LogicalLine);
  const last = items.length > 0 ? items[items.length - 1]! : null;
  const end = last?.loc.end ?? { line: start.line, column: start.column };
  return { start, end };
}

/**
 * `RAND:n` / 糖形 `随机(n)` 常量主体 → n（n ≥ 1 的十进制字面量）；非此形态返回 null
 * （E17 缺档诊断只认这两种可证伪的常量主体）。大小写不敏感、允许中/半角括号与冒号。
 */
function randLiteralCount(subject: string): number | null {
  const m = /^(?:RAND|随机)\s*(?:[:：]\s*(\d+)|[（(]\s*(\d+)\s*[）)])$/i.exec(subject.trim());
  if (!m) return null;
  const raw = m[1] ?? m[2];
  if (raw === undefined) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

/** 十进制整数字面量 → 数值；否则 null（含别名 / 变量 / 字符串等不可证形态） */
function intLiteral(raw: string): number | null {
  const t = raw.trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

/** 区间并集是否盖满 `[0, n-1]`（空集 → 否；先按起点排序再贪心合并） */
function coversRange(intervals: ReadonlyArray<readonly [number, number]>, n: number): boolean {
  if (intervals.length === 0) return false;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  if (sorted[0]![0] > 0) return false; // 0 档未覆盖
  let hi = sorted[0]![1];
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = sorted[i]!;
    if (a > hi + 1) break; // 出现空档，后续区间再高也补不上中间
    if (b > hi) hi = b;
  }
  return hi >= n - 1;
}

/** 块类节点（需要继续吃更深缩进的块体） */
function isBlockNode(node: SugarNode): boolean {
  return (
    node.kind === 'ifBlock' ||
    node.kind === 'whenBlock' ||
    node.kind === 'colorBlock' ||
    node.kind === 'randomBlock' ||
    node.kind === 'groupBlock' ||
    node.kind === 'sectionBlock' ||
    node.kind === 'onceBlock' ||
    node.kind === 'choiceBlock' ||
    node.kind === 'menuBlock'
  );
}

/** 把额外块体合并进已构建的块节点（随机候选里出现块头时用） */
function mergeBlockBody(node: SugarNode, extra: SugarNode[]): void {
  if (extra.length === 0) return;
  if (node.kind === 'colorBlock' || node.kind === 'groupBlock' || node.kind === 'sectionBlock' || node.kind === 'onceBlock') {
    node.body.push(...extra);
  } else if (node.kind === 'ifBlock' && node.branches.length > 0) {
    node.branches[node.branches.length - 1]!.body.push(...extra);
  }
}

/** 诊断按源位置排序（稳定输出，便于 golden 与快照） */
export function sortDiagnostics(sink: DiagnosticSink): void {
  const all = sink.all();
  all.sort((a, b) => {
    const al = a.loc?.line ?? 0;
    const bl = b.loc?.line ?? 0;
    if (al !== bl) return al - bl;
    const ac = a.loc?.column ?? 0;
    const bc = b.loc?.column ?? 0;
    return ac - bc;
  });
}

export { spanOf, posOf };
