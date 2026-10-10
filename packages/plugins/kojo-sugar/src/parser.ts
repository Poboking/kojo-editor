/**
 * 三段式转译 · 第二段：缩进配对 → `SugarNode` AST。
 *
 * 配对规则（照抄规范 §5.3，不自由发挥）：
 * - 块头以全角 `：` 结尾；块体缩进必须**比块头更深**；
 * - 缩进异常（回缩不齐、块头无体）→ 报错并**阻止编译**（不生成半成品）；
 * - `如果/否则如果/否则`、`当/是/否则`、`随机`、`选项`、`着色`、时机 各自成块；
 * - `选项` 块：每时机最多一个、不可嵌套（诊断 `choice-multiple` / `choice-nested`）；
 * - 表达式 `如果` / `当`：分支体必须是 `-> 单个表达式`，且必须有 `否则`
 *   （诊断 `expr-body-not-expression` / `expr-missing-else`）。
 *
 * 本段只做**结构**构建；表达式降糖发生在 codegen 段（`codegen.ts`）。
 */

import type {
  AliasDecl,
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
  classifyLine,
  contentOf,
  detectSpeechOf,
  parseAliasValue,
  parseTextLine,
  scanInterpolations,
  splitLogicalLines,
  stripCont,
  type LineClass,
  type LogicalLine,
} from './lexer';
import type { DiagnosticSink } from './types';

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
  let sawTiming = false;

  // 供 `parseAliasLine` 使用：把解析出的别名同时登记进 frontMatter.aliases
  const registerAlias = (decl: AliasDecl) => {
    frontMatter.aliases.push(decl);
  };

  while (!cursor.done) {
    const line = cursor.peek()!;
    const content = contentOf(line);
    if (content.length === 0 || content.startsWith(';')) {
      cursor.next();
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

    // ---- 时机块 ----
    if (cls.kind === 'timingHead') {
      sawTiming = true;
      const block = readTimingBlock(cursor, cls);
      topLevel.push(block);
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
    case 'head.family':
      fm.family = value;
      break;
    case 'head.title':
      fm.displayName = value;
      break;
    case 'head.desc':
      fm.description = value;
      break;
    case 'head.color':
      fm.color = value;
      break;
    case 'head.narrationColor':
      fm.narrationColor = value === '作者色' ? '作者色' : '默认';
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
): TimingBlock {
  const head = cursor.next()!;
  const baseIndent = head.indent;
  const bodyParser = new BlockParser(cursor, baseIndent + 1, cursor.sink);
  const { body, messageCheck, namedParams } = bodyParser.parseTimingBody();

  return {
    kind: 'timingBlock',
    face: cls.face,
    index: cls.index,
    namedParams: mergeNamedParams(cls.namedParams, namedParams),
    messageCheck,
    body,
    loc: {
      start: posOf(head),
      end: { line: cursor.lines[Math.max(0, cursor.index - 1)]?.endLine ?? head.endLine, column: 1 },
    },
  };
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
        this.cursor.next();
        continue;
      }
      if (cls.kind === 'messageCheck') {
        this.cursor.next();
        messageCheck.push({ scope: cls.scope, condition: cls.condition, loc: spanOf(line) });
        continue;
      }
      // 时机块头的命名参数若写在体内（少见）——忽略并前进
      const node = this.parseStatement(cls, line, { choiceSeen });
      if (node) {
        if (node.kind === 'choiceBlock') choiceSeen = true;
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
      case 'rawLine':
        return { kind: 'rawLine', text: cls.text, loc: spanOf(line) } as RawLine;
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
    state: { choiceSeen: boolean },
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
      case 'randomInline': {
        this.cursor.next();
        return { kind: 'randomInline', alternatives: cls.alternatives, loc: spanOf(line) } as RandomInline;
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
      case 'colorHead': {
        this.cursor.next();
        return this.parseColorBody(line, cls.color);
      }
      case 'rawLine': {
        this.cursor.next();
        return { kind: 'rawLine', text: cls.text, loc: spanOf(line) } as RawLine;
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
      case 'heartText': {
        this.cursor.next();
        return this.buildHeartNode(line, cls.raw);
      }
      case 'comment':
        this.cursor.next();
        return null;
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
      const sub = new BlockParser(this.cursor, bodyIndent, this.sink);
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
        const sub = new BlockParser(this.cursor, bodyIndent + 1, this.sink);
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
        const sub = new BlockParser(this.cursor, bodyIndent + 1, this.sink);
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
      // 候选：一行内容（可为文本行 / 心形 / 原生行 / 深一层块）
      this.cursor.next();
      const startLine = line;
      const node = this.buildStandaloneNode(cls, line);
      // 若候选行是块头，继续吃缩进更深的行
      if (node && isBlockNode(node)) {
        const sub = new BlockParser(this.cursor, bodyIndent + 1, this.sink);
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
    return { kind: 'randomBlock', alternatives, loc: mergeSpan2(headLine, alternatives) };
  }

  /** 把一行内容作为独立节点构建（随机候选 / 选项体内联用） */
  private buildStandaloneNode(cls: LineClass, line: LogicalLine): SugarNode | null {
    switch (cls.kind) {
      case 'text':
        return this.buildTextNode(line, 'textLine');
      case 'heartText':
        return this.buildHeartNode(line, cls.raw);
      case 'rawLine':
        return { kind: 'rawLine', text: cls.text, loc: spanOf(line) } as RawLine;
      case 'ifHead':
        return this.parseIfBlockFromClass(line, cls);
      case 'whenHead':
        return this.parseWhenBlock(line, cls.subject);
      case 'randomHead':
        return this.parseRandomBody(line);
      case 'randomInline':
        return { kind: 'randomInline', alternatives: cls.alternatives, loc: spanOf(line) } as RandomInline;
      case 'colorHead':
        return this.parseColorBody(line, cls.color);
      case 'choiceHead':
        return this.parseChoiceBody(line);
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
      const sub = new BlockParser(this.cursor, bodyIndent, this.sink);
      current.body.push(...sub.parseBody());
    }
    return { kind: 'ifBlock', branches, loc: mergeSpan(branches) };
  }

  /* ------------------------------ 选项块 ------------------------------ */

  private parseChoiceBody(headLine: LogicalLine): SugarNode {
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
          message: '「选项」的条目必须同级（每个条目是 `「文本」：` + 缩进正文）。',
          loc: posOf(line),
        });
        this.skipOverIndented(line.indent);
        continue;
      }
      if (!endsWithColon(content)) {
        this.sink.report({
          code: 'indent-mismatch',
          severity: 'error',
          message: '「选项」的条目要写成 `「文本」：`（以全角冒号结尾）。',
          loc: posOf(line),
        });
        this.cursor.next();
        continue;
      }
      this.cursor.next();
      const label = stripQuotes(stripTrailingColon(content));
      const sub = new BlockParser(this.cursor, itemIndent + 1, this.sink);
      const body = sub.parseChoiceItemBody();
      items.push({ label, body, loc: spanOf(line) });
    }
    if (items.length === 0) {
      this.sink.report({
        code: 'block-empty',
        severity: 'error',
        message: '「选项」块没有任何条目。',
        loc: posOf(headLine),
      });
    }
    return {
      kind: 'choiceBlock',
      items,
      loc: mergeSpan2(headLine, items),
    };
  }

  /* ------------------------------ 着色块 ------------------------------ */

  private parseColorBody(headLine: LogicalLine, color: string): SugarNode {
    const bodyIndent = headLine.indent + 1;
    const sub = new BlockParser(this.cursor, bodyIndent, this.sink);
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
        this.cursor.next();
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
      const node = this.parseStatement(cls, line, { choiceSeen: false });
      if (node) out.push(node);
    }
    return out;
  }

  /** 选项条目体：不允许 `选项` 块（同上），并允许任意其它块 */
  parseChoiceItemBody(): SugarNode[] {
    return this.parseBody();
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

/** 块类节点（需要继续吃更深缩进的块体） */
function isBlockNode(node: SugarNode): boolean {
  return (
    node.kind === 'ifBlock' ||
    node.kind === 'whenBlock' ||
    node.kind === 'colorBlock' ||
    node.kind === 'randomBlock' ||
    node.kind === 'choiceBlock'
  );
}

/** 把额外块体合并进已构建的块节点（随机候选里出现块头时用） */
function mergeBlockBody(node: SugarNode, extra: SugarNode[]): void {
  if (extra.length === 0) return;
  if (node.kind === 'colorBlock') {
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
