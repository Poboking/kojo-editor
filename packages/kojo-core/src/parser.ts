/**
 * Kojo 2.0 文法解析器：词法行 → `KojoFile`（严格按 `ast.ts` 建树）。
 *
 * 口径（设计稿 §3–§9 / §11 / §12）：
 * - **单一模式**：只认 2.0；旧写法（§12.1）只出迁移诊断，绝不进 AST；
 * - **声明提升**：`# 变量/# 常量/# 表/# 池/# 模/@函/@织` 进 `decls`；`# 幕` 按书写序切 `scenes`
 *   （首个幕之前的正文落 `title: null` 的隐式前奏场景；没有幕则整文件一个隐式场景）；
 * - **错误恢复**：错误行与它的缩进体整块跳过（不产半成品节点），但继续扫描后面的行，
 *   一次报多条；`KojoFile.diagnostics` 带 1 基 UTF-16 span；
 * - **表达式不在 core 重复实现**：条件/赋值/表端点只存源切片（`KojoExprText`）；
 *   全角标点诊断只走 `literal.ts::reportFullwidthExprPunct` 唯一入口；
 * - `@原生`：缩进围栏、块内原文去基准缩进（基准 = 非空行最小前导空白），Tab 原样；
 * - 性能：单遍推进（`st.i` 只增），块结构靠缩进计数，无全文正则、无 AST 后处理。
 */
import type {
  KojoAssignOp,
  KojoAssignStmt,
  KojoBlankLine,
  KojoCallStmt,
  KojoColorBlock,
  KojoConditionBranch,
  KojoConditionChain,
  KojoConstDecl,
  KojoDecl,
  KojoDialectDecl,
  KojoDispatchCondition,
  KojoDispatchNode,
  KojoExprCallStmt,
  KojoExprText,
  KojoFaceLine,
  KojoFile,
  KojoForEachLoop,
  KojoFunctionDecl,
  KojoFunctionParam,
  KojoJumpStmt,
  KojoLabelStmt,
  KojoLiteral,
  KojoLoopJumpStmt,
  KojoMachineDecl,
  KojoNarrativeNode,
  KojoNativeBlock,
  KojoOptionItem,
  KojoOptionsBlock,
  KojoPoolDecl,
  KojoRandomBlock,
  KojoRandomCandidate,
  KojoRepeatLoop,
  KojoReturnStmt,
  KojoSandboxBlock,
  KojoSceneNode,
  KojoSpan,
  KojoSpeech,
  KojoTableDecl,
  KojoTableRow,
  KojoTemplateDecl,
  KojoTemplateParam,
  KojoTextLine,
  KojoTextPart,
  KojoValueType,
  KojoVarDecl,
  KojoVarStorage,
  KojoViewDecl,
  KojoWeaveDecl,
  KojoWeaveModifier,
  KojoWhileLoop,
} from './ast.js';
import {
  createDiagnosticSink,
  severityOf,
  type CoreDiagnosticCode,
  type DiagnosticSink,
} from './diagnostics.js';
import { reportFullwidthExprPunct } from './literal.js';
import {
  decodeIntegerLiteral,
  decodeQuotedLiteral,
  findTopLevelAssignOp,
  isDecimalIntegerLiteral,
  isIdentifier,
  isIntegerLiteralText,
  isSpaceCode,
  lex,
  matchParenEnd,
  splitSpaces,
  splitTopLevelArgs,
  spanOfOffsets,
  trimEndOffset,
  trimStartOffset,
} from './lexer.js';
import type { PositionIndex } from './positions.js';
import {
  KOJO_DEFAULT_STORAGE,
  KOJO_DECL_WORDS,
  KOJO_DOMAIN_SYMBOL_SET,
  KOJO_FACE_MAX_ARGS,
  KOJO_INT_TYPE,
  KOJO_RESERVED_PREFIX,
  KOJO_STORAGE_WORDS,
  KOJO_STRING_TYPE,
  KOJO_TABLE_DEFAULT,
  KOJO_TABLE_SUBJECT,
  KOJO_TEMPLATE_SLOT,
  KOJO_WEAVE_MODIFIERS,
  type KojoCallArg,
  type KojoBareQuoteRecord,
  type KojoDeclRecord,
  type KojoDialogueRecord,
  type KojoEscapedRecord,
  type KojoLegacyKind,
  type KojoLexLine,
  type KojoNarrationRecord,
  type KojoNativeRecord,
  type KojoTextRecord,
  type KojoTextSegment,
  type LexResult,
} from './tokens.js';

/** 带叙事文本字段（wait / hint / parts / body）的行：`buildTextLine` 的收窄输入 */
type TextBearingLine =
  | KojoNarrationRecord
  | KojoDialogueRecord
  | KojoBareQuoteRecord
  | KojoTextRecord
  | KojoEscapedRecord;

/* ============================== 状态 ============================== */

type BlockKind =
  | 'top'
  | 'scene'
  | 'function'
  | 'weave'
  | 'sandbox'
  | 'loop'
  | 'color'
  | 'pool'
  | 'template'
  | 'random'
  | 'group'
  | 'options'
  | 'option-item';

interface CtxBase {
  readonly kind: BlockKind;
  /** 单元顶层（场景顶 / 函数体基准 / 监听体基准）：只有这里允许 `@标`（§9.4） */
  readonly labelsAllowed: boolean;
  /** `# 池` / `# 模` 内禁止副作用构造 */
  readonly unitTop: boolean;
}

interface SceneDraft {
  title: string | null;
  readonly items: KojoNarrativeNode[];
  startSpan: KojoSpan | null;
  endSpan: KojoSpan | null;
  span: KojoSpan | null;
  explicit: boolean;
}

interface ParserState {
  readonly source: string;
  readonly lines: readonly KojoLexLine[];
  readonly sink: DiagnosticSink;
  readonly positions: PositionIndex;
  i: number;
  readonly decls: KojoDecl[];
  readonly scenes: KojoSceneNode[];
  readonly declaredNames: Set<string>;
  /** 名字 → 声明种类标签（`变量`/`常量`/`表`/`池`/`模板`/`函数`）；调用体校验用 */
  readonly declKinds: Map<string, string>;
  hasMachine: boolean;
  hasView: boolean;
  /** `# 方言` 是否已经断言过（解析层只消费单值 `fileAssertion`，第二条起报错） */
  hasDialect: boolean;
  hasExplicitScene: boolean;
  optionsCount: number;
  loopDepth: number;
  functionDepth: number;
}

/* ============================== 入口 ============================== */

/** 解析入口：`parse(lex(source))`（纯函数；同输入必同输出） */
export function parse(input: LexResult): KojoFile {
  const sink = createDiagnosticSink();
  for (const diagnostic of input.diagnostics) sink.report(diagnostic);
  const st: ParserState = {
    source: input.source,
    lines: input.lines,
    sink,
    positions: input.positions,
    i: 0,
    decls: [],
    scenes: [],
    declaredNames: new Set<string>(),
    declKinds: new Map<string, string>(),
    hasMachine: false,
    hasView: false,
    hasDialect: false,
    hasExplicitScene: false,
    optionsCount: 0,
    loopDepth: 0,
    functionDepth: 0,
  };
  runTopLevel(st);
  validateCallBodies(st);
  reportMissingMachine(st);
  return { decls: st.decls, scenes: st.scenes, diagnostics: sink.all };
}

/** 便捷入口：源码一步到 AST（fixtures / 单测用；等价 `parse(lex(source))`） */
export function parseSource(source: string): KojoFile {
  return parse(lex(source));
}

function reportMissingMachine(st: ParserState): void {
  let firstItem: KojoNarrativeNode | null = null;
  for (let i = 0; i < st.scenes.length; i++) {
    const items = st.scenes[i]!.items;
    if (items.length > 0) {
      firstItem = items[0]!;
      break;
    }
  }
  if (firstItem !== null && !st.hasMachine) {
    reportSpan(
      st,
      'core/decl/missing-machine',
      '这个文件有正文却没有 `# 机`：正文要挂到哪个事件上？先写 `# 机 指令 310` 这类声明（§3.7）。',
      firstItem.span,
    );
  }
}

/* ============================== 诊断与位置 ============================== */

function report(st: ParserState, code: CoreDiagnosticCode, message: string, start: number, end: number): void {
  st.sink.report({
    code,
    severity: severityOf(code),
    message,
    span: spanOfOffsets(st.positions, start, end),
  });
}

function reportSpan(st: ParserState, code: CoreDiagnosticCode, message: string, span: KojoSpan | null): void {
  st.sink.report({ code, severity: severityOf(code), message, span });
}

function spanOffsets(st: ParserState, start: number, end: number): KojoSpan {
  return spanOfOffsets(st.positions, start, end);
}

function spanOfLine(st: ParserState, line: KojoLexLine): KojoSpan {
  return spanOffsets(st, line.contentOffset, line.contentEnd);
}

function spanOfToken(st: ParserState, token: KojoCallArg): KojoSpan {
  return spanOffsets(st, token.offset, token.offset + token.text.length);
}

/** 块节点收束位置：最后一个已消费的非空行内容尾（含 body）；无 body 用头行尾 */
function consumedEndOffset(st: ParserState, fallback: number): number {
  for (let i = st.i - 1; i >= 0; i--) {
    const line = st.lines[i]!;
    if (line.kind === 'blank') continue;
    return line.contentEnd;
  }
  return fallback;
}

function blockSpan(st: ParserState, header: KojoLexLine): KojoSpan {
  return spanOffsets(st, header.contentOffset, consumedEndOffset(st, header.contentEnd));
}

/** 表达式切片：trim 首尾空白 + 全角标点唯一入口诊断（只对表达式/条件位置调用） */
function makeExpr(st: ParserState, raw: string, rawOffset: number): KojoExprText {
  const start = trimStartOffset(raw, 0, raw.length);
  const end = trimEndOffset(raw, start, raw.length);
  const text = raw.slice(start, end);
  const span = spanOffsets(st, rawOffset + start, rawOffset + end);
  if (text.length > 0) {
    const diagnostics = reportFullwidthExprPunct(text, span);
    for (let i = 0; i < diagnostics.length; i++) st.sink.report(diagnostics[i]!);
  }
  return { text, span };
}

function makeExprFromToken(st: ParserState, token: KojoCallArg): KojoExprText {
  return makeExpr(st, token.text, token.offset);
}

/* ============================== 顶层推进 ============================== */

const TOP_CTX: CtxBase = { kind: 'top', labelsAllowed: true, unitTop: true };

function runTopLevel(st: ParserState): void {
  let current: SceneDraft = createSceneDraft(null, false, null);
  while (st.i < st.lines.length) {
    const line = st.lines[st.i]!;
    if (line.kind === 'blank' || line.kind === 'comment') {
      st.i++;
      continue;
    }
    if (line.kind === 'legacy') {
      handleLegacyLine(st, line);
      continue;
    }
    if (line.kind === 'unknown') {
      reportUnknownLine(st, line);
      continue;
    }
    if (line.invalid) {
      skipLineAndSubtree(st);
      continue;
    }
    if (line.indent !== 0) {
      report(st, 'core/lex/indent', '顶层行不能缩进：声明与正文都从行首开始（§4.13）。', line.lineOffset, line.contentOffset);
      skipLineAndSubtree(st);
      continue;
    }
    if (line.kind === 'decl') {
      if (line.word === '幕') {
        flushScene(st, current);
        current = createSceneDraft(line.rest, true, spanOfLine(st, line));
        if (line.rest.length === 0) {
          reportSpan(st, 'core/lex/anchor', '`# 幕` 后面缺场景标题（形如 `# 幕 神社清晨`）。', spanOfLine(st, line));
        }
        st.hasExplicitScene = true;
        st.i++;
        continue;
      }
      parseDeclaration(st, line);
      continue;
    }
    if (line.kind === 'dispatch' && (line.word === '函' || line.word === '织')) {
      parseDeclaration(st, line);
      continue;
    }
    const node = parseNarrativeStatement(st, line, TOP_CTX);
    if (node !== null) pushSceneItem(st, current, node);
  }
  flushScene(st, current);
}

function createSceneDraft(title: string | null, explicit: boolean, span: KojoSpan | null): SceneDraft {
  return { title, items: [], startSpan: null, endSpan: null, span, explicit };
}

function pushSceneItem(st: ParserState, draft: SceneDraft, node: KojoNarrativeNode): void {
  void st;
  draft.items.push(node);
  if (draft.startSpan === null) draft.startSpan = node.span;
  draft.endSpan = node.span;
}

function flushScene(st: ParserState, draft: SceneDraft): void {
  if (!draft.explicit && draft.items.length === 0) return;
  const startSpan = draft.startSpan ?? draft.span;
  if (startSpan === null) return;
  const endSpan = draft.endSpan ?? draft.span ?? startSpan;
  const startPos = draft.explicit && draft.span !== null ? draft.span.start : startSpan.start;
  const scene: KojoSceneNode = {
    kind: 'sceneNode',
    title: draft.title,
    items: draft.items,
    span: { start: startPos, end: endSpan.end },
  };
  st.scenes.push(scene);
}

/* ============================== 旧写法 / 未知行 ============================== */

interface LegacyDiagnostic {
  readonly code: CoreDiagnosticCode;
  readonly message: string;
}

function legacyDiagnostic(legacy: KojoLegacyKind, rest: string): LegacyDiagnostic {
  switch (legacy) {
    case 'semicolon':
      return {
        code: 'core/migration/comment',
        message: '2.0 叙事区不认 `;` 注释：请写整行 `//`；`;` 只留给 `@原生` 里的 ERB（§4.13）。',
      };
    case 'preprocessor':
      return {
        code: 'core/migration/raw',
        message: '`#DIM` / `#FUNCTION` 等原生预处理器不能直通 2.0：整段放进 `@原生` 块（§2.4）。',
      };
    case 'version':
      return {
        code: 'core/migration/version',
        message: '2.0 没有版本声明：删掉这一行，文件直接从声明或正文开始（§3.1）。',
      };
    case 'timing':
      return {
        code: 'core/migration/timing',
        message: '`# 时机` 已退场：写 `# 机 指令 310`；多个挂点请拆文件（§3.5）。',
      };
    case 'head-decl':
      return {
        code: 'core/migration/raw',
        message: '旧文件头声明（`角色:` / `口上:` / `显示名:` / `简介:` / `开关:`）已退场：搬到 adapter / 工程配置（§15.2.3）。',
      };
    case 'if':
    case 'elif':
    case 'else':
      return {
        code: 'core/migration/if',
        message: '`如果 / 否则如果 / 否则` 已退场：写 `?` 条件链，兜底分支写 `? 否`（§5.3）。',
      };
    case 'when':
    case 'is':
      return {
        code: 'core/migration/switch',
        message: '`当 / 是` 已退场：值查找写 `# 表`，语句块写 `?` 链（§6.5）。',
      };
    case 'branch':
      return {
        code: 'core/migration/branch',
        message: '`分支：` + `[条件]` 已退场：写 `?` 条件链或 `# 池`（§12.1）。',
      };
    case 'loop':
    case 'loop-end':
      return {
        code: 'core/migration/loop',
        message: '`循环` 已退场：条件循环写 `@循`，固定次数写 `@复`，遍历写 `@巡`（§9.3）。',
      };
    case 'call':
      return {
        code: 'core/migration/call-return',
        message: '`调用` 已退场：写 `! 名字(实参)`（§12.1）。',
      };
    case 'return':
      return {
        code: 'core/migration/call-return',
        message: '`返回` 已退场：返回值只写 `@返`，不写 `= 返` / 裸 `返`（§2.3）。',
      };
    case 'goto-label':
      return { code: 'core/migration/label', message: '`标签` 已退场：写 `@标 <名>`（§9.4）。' };
    case 'goto-jump':
      return { code: 'core/migration/label', message: '`跳到` 已退场：写 `@跳 <名>`（§9.4）。' };
    case 'ask':
      return {
        code: 'core/migration/ask',
        message: '`初回 / 询问 / 确认` 暂无 2.0 对应：用 `@原生` 写引擎问答（§12.1）。',
      };
    case 'hidden-timing':
      return {
        code: 'core/migration/hidden-timing',
        message: '`隐藏情景 / 隐藏口上` 已退场：写 `# 机` / `@织`；无对应时 `@原生`（§12.1）。',
      };
    case 'alias':
      return {
        code: 'core/migration/alias',
        message: '`别名` 已退场：改用 adapter 变量映射，或 `@原生`（§3.4.4）。',
      };
    case 'color-option':
      return {
        code: 'core/migration/color-option',
        message: '`旁白色 / 口上色` 已退场：搬到 project/file profile 的 `narrationColor` / `dialogueColor`（§4.7）。',
      };
    case 'heart':
      return {
        code: 'core/migration/heart',
        message: '`心形` 语句已退场：在台词/旁白行尾写 `(心形)`（§4.8）。',
      };
    case 'color-block':
      return {
        code: 'core/migration/color',
        message: '`着色` 块改成 `@着色 0xFF8080`：颜色开关由编译器自动配对，不用作者手写（§8.2）。',
      };
    case 'random-block':
      return {
        code: 'core/migration/random',
        message: '`随机：` 块改成 `@随机`：每个直接子项一个候选，多行候选写 `@组`（§8.4）。',
      };
    case 'group-block':
      return {
        code: 'core/migration/random',
        message: '`组：` 改成 `@组`：只在 `@随机` 内有效（§8.4）。',
      };
    case 'data-table':
      return {
        code: 'core/migration/data',
        message: '`数据表：` 是随机数据表：改成 `@随机`，不要映射成 `# 池`（§8.4）。',
      };
    case 'native-label':
      return {
        code: 'core/migration/label',
        message: '`@LABEL` 原生标签已退场：写 `@标`，或把原生标签放进 `@原生`（§2.4）。',
      };
    case 'raw-function':
      return {
        code: 'core/migration/raw',
        message: '`@` 原生函数块已退场：整块放进 `@原生` 缩进围栏（§8.5）。',
      };
    case 'equal-prefix':
      if (rest.trimStart().startsWith('返')) {
        return { code: 'core/migration/call-return', message: '返回值只写 `@返`：删掉行首 `=`（§2.3）。' };
      }
      return {
        code: 'core/migration/raw',
        message: '行首 `=` 不回归：声明写 `# 变量`，状态更新写 `@算`（§2.3）。',
      };
    case 'wait-mark':
      return {
        code: 'core/migration/wait',
        message: '行尾等待别名已退场：2.0 只写 `续`（§2.4 / §12.1）。',
      };
    default:
      return { code: 'core/migration/raw', message: '这是 1.0 写法：请按 §12.1 迁移到 2.0。' };
  }
}

function handleLegacyLine(st: ParserState, line: KojoLexLine): void {
  if (line.kind !== 'legacy') {
    st.i++;
    return;
  }
  const diagnostic = legacyDiagnostic(line.legacy, line.rest);
  reportSpan(st, diagnostic.code, diagnostic.message, spanOfLine(st, line));
  st.i++;
  skipIndentedBody(st, line.indent);
}

function reportUnknownLine(st: ParserState, line: KojoLexLine): void {
  reportSpan(
    st,
    'core/lex/anchor',
    '这一行不是 2.0 的合法行：检查行首锚点（`# @ > ? !`）与缩进。',
    spanOfLine(st, line),
  );
  st.i++;
  skipIndentedBody(st, line.indent);
}

function nextNonBlankIndex(st: ParserState, from: number): number {
  for (let i = from; i < st.lines.length; i++) {
    const line = st.lines[i]!;
    if (line.kind !== 'blank' && line.kind !== 'comment') return i;
  }
  return -1;
}

/** 跳过比 `indent` 更深的缩进体（错误恢复；空行按归属判定，不吞掉断链空行） */
function skipIndentedBody(st: ParserState, indent: number): void {
  while (st.i < st.lines.length) {
    const line = st.lines[st.i]!;
    if (line.kind === 'blank') {
      const next = nextNonBlankIndex(st, st.i + 1);
      if (next < 0 || st.lines[next]!.indent <= indent) break;
      st.i++;
      continue;
    }
    if (line.kind === 'comment') {
      st.i++;
      continue;
    }
    if (line.indent <= indent) break;
    st.i++;
  }
}

function skipLineAndSubtree(st: ParserState): void {
  const line = st.lines[st.i]!;
  st.i++;
  skipIndentedBody(st, line.indent);
}

/* ============================== 声明 ============================== */

function parseDeclaration(st: ParserState, header: KojoLexLine): void {
  if (header.kind === 'dispatch') {
    if (header.word === '函') parseFunctionDecl(st, header);
    else if (header.word === '织') parseWeaveDecl(st, header);
    else {
      reportSpan(st, 'core/decl/not-top-level', '这个调度词不能当声明。', spanOfLine(st, header));
      skipLineAndSubtree(st);
    }
    return;
  }
  if (header.kind !== 'decl') {
    skipLineAndSubtree(st);
    return;
  }
  if (!header.known) {
    reportSpan(
      st,
      'core/decl/unknown',
      `未知声明词 \`# ${header.word}\`：2.0 只认 ${KOJO_DECL_WORDS.join('/')}（§3.3）。`,
      spanOfLine(st, header),
    );
    skipLineAndSubtree(st);
    return;
  }
  if (header.invalid) {
    skipLineAndSubtree(st);
    return;
  }
  switch (header.word) {
    case '机':
      st.i++;
      parseMachineDecl(st, header);
      return;
    case '视':
      st.i++;
      parseViewDecl(st, header);
      return;
    case '方言':
      st.i++;
      parseDialectDecl(st, header);
      return;
    case '变量':
      st.i++;
      parseVarDecl(st, header);
      return;
    case '常量':
      st.i++;
      parseConstDecl(st, header);
      return;
    case '表':
      st.i++;
      parseTableDecl(st, header);
      return;
    case '池':
      st.i++;
      parsePoolDecl(st, header);
      return;
    case '模':
      st.i++;
      parseTemplateDecl(st, header);
      return;
    default:
      reportSpan(st, 'core/decl/unknown', `未知声明词 \`# ${header.word}\`。`, spanOfLine(st, header));
      skipLineAndSubtree(st);
  }
}

function registerDeclarationName(st: ParserState, name: string, span: KojoSpan, kindLabel: string): void {
  if (name.startsWith(KOJO_RESERVED_PREFIX)) {
    reportSpan(
      st,
      'core/decl/reserved-name',
      `\`${name}\` 用了编译器保留前缀 \`${KOJO_RESERVED_PREFIX}\`（§3.4.5）。`,
      span,
    );
    return;
  }
  if (KOJO_DOMAIN_SYMBOL_SET.has(name)) {
    reportSpan(
      st,
      'core/decl/reserved-name',
      `域符号 \`{${name}}\` 不能声明成${kindLabel}：它由 adapter 的 domainSymbols 提供（§3.6）。`,
      span,
    );
  }
  if (st.declaredNames.has(name)) {
    reportSpan(st, 'core/decl/duplicate-name', `\`${name}\` 已经在文件命名空间里声明过（§3.2 / §3.4.5）。`, span);
    return;
  }
  st.declaredNames.add(name);
  st.declKinds.set(name, kindLabel);
}

function declNameValid(st: ParserState, token: KojoCallArg | undefined): boolean {
  if (token === undefined) {
    reportSpan(st, 'core/lex/anchor', '声明缺名字。', null);
    return false;
  }
  if (!isIdentifier(token.text)) {
    reportSpan(
      st,
      'core/lex/anchor',
      `\`${token.text}\` 不是合法名字：以字母/下划线/汉字开头，后续可含数字（§2.4）。`,
      spanOfToken(st, token),
    );
    return false;
  }
  return true;
}

function parseMachineDecl(st: ParserState, header: KojoDeclRecord): void {
  const tokens = splitSpaces(header.rest, header.restOffset);
  if (tokens.length === 0) {
    reportSpan(st, 'core/lex/anchor', '`# 机` 缺事件名（形如 `# 机 指令 310`）。', spanOfLine(st, header));
    return;
  }
  if (st.hasMachine) {
    reportSpan(
      st,
      'core/decl/multiple-machine',
      '一个文件只能写一个 `# 机`；多个挂点请拆文件（§3.2）。',
      spanOfLine(st, header),
    );
  }
  st.hasMachine = true;
  const args: string[] = [];
  for (let i = 1; i < tokens.length; i++) args.push(tokens[i]!.text);
  const decl: KojoMachineDecl = { kind: 'machine', event: tokens[0]!.text, args, span: spanOfLine(st, header) };
  st.decls.push(decl);
}

function parseViewDecl(st: ParserState, header: KojoDeclRecord): void {
  const tokens = splitSpaces(header.rest, header.restOffset);
  if (tokens.length === 0) {
    reportSpan(st, 'core/lex/anchor', '`# 视` 缺目标（形如 `# 视 灵梦`）。', spanOfLine(st, header));
    return;
  }
  if (tokens.length > 1) {
    reportSpan(st, 'core/lex/anchor', '`# 视` 只接一个目标，多余内容请删掉（§3.6）。', spanOfLine(st, header));
  }
  if (st.hasView) {
    reportSpan(
      st,
      'core/decl/multiple-view',
      '一个文件只能写一个 `# 视`：2.0 不支持幕内切换视角（§3.2）。',
      spanOfLine(st, header),
    );
  }
  st.hasView = true;
  const decl: KojoViewDecl = { kind: 'view', target: tokens[0]!.text, span: spanOfLine(st, header) };
  st.decls.push(decl);
}

/**
 * `# 方言 <名字>`：只建形状，**不解释内容**（LAU §5.3 第 3 级 / spec §3.3）。
 *
 * - 参数是一个裸名字，core 按不透明字符串收下来交给上层对账；这里**不校验**它是不是
 *   某个已知方言（那会把手伸进方言事实，铁律 3）；
 * - 不进文件命名空间（不叫"声明一个名字"），但**查重**：解析层只消费单值 `fileAssertion`，
 *   第二条起必有一条被静默丢弃 ⇒ 报 `core/decl/multiple-dialect`（与 `# 视` 同一族纪律）；
 *   两条断言是不是"同一个方言"不是本层要回答的——冲突判据（`core/dialect/mismatch`）仍在方言层；
 * - 一行只收一个名字，与 `# 视` 同形。
 */
function parseDialectDecl(st: ParserState, header: KojoDeclRecord): void {
  const tokens = splitSpaces(header.rest, header.restOffset);
  if (tokens.length === 0) {
    reportSpan(
      st,
      'core/lex/anchor',
      '`# 方言` 缺被断言的名字（形如 `# 方言 <名字>`；§3.3）。',
      spanOfLine(st, header),
    );
    return;
  }
  if (tokens.length > 1) {
    reportSpan(
      st,
      'core/lex/anchor',
      '`# 方言` 只断言一个名字，多余内容请删掉（§3.3）。',
      spanOfLine(st, header),
    );
  }
  if (st.hasDialect) {
    reportSpan(
      st,
      'core/decl/multiple-dialect',
      '一个文件只能写一个 `# 方言`：第二条起会被静默丢弃，写下的断言不算数（§3.3）。',
      spanOfLine(st, header),
    );
  }
  st.hasDialect = true;
  const decl: KojoDialectDecl = { kind: 'dialect', name: tokens[0]!.text, span: spanOfLine(st, header) };
  st.decls.push(decl);
}

interface ParsedType {
  readonly valueType: KojoValueType;
  readonly arraySize?: KojoExprText;
}

function parseTypeToken(st: ParserState, token: KojoCallArg): ParsedType | null {
  const text = token.text;
  if (text === KOJO_INT_TYPE) return { valueType: 'int' };
  if (text === KOJO_STRING_TYPE) return { valueType: 'string' };
  const open = text.indexOf('[');
  if (open > 0 && text.charCodeAt(text.length - 1) === 93) {
    const base = text.slice(0, open);
    const inner = text.slice(open + 1, text.length - 1);
    const valueType: KojoValueType | null =
      base === KOJO_INT_TYPE ? 'int' : base === KOJO_STRING_TYPE ? 'string' : null;
    if (valueType !== null) {
      const size = makeExpr(st, inner, token.offset + open + 1);
      if (size.text.length === 0) {
        reportSpan(
          st,
          'core/decl/bad-array-size',
          '数组长度不能为空：写正整数或已声明的整数 `# 常量`（§3.4.2）。',
          spanOfToken(st, token),
        );
        return { valueType };
      }
      if (isDecimalIntegerLiteral(size.text)) {
        const n = decodeIntegerLiteral(size.text);
        if (n === null || n <= 0) {
          const reason =
            n === null
              ? `超出安全整数范围（±9007199254740991），会被静默舍入`
              : `必须是正整数`;
          reportSpan(st, 'core/decl/bad-array-size', `数组长度${reason}：\`${size.text}\` 不合法（§3.4.2）。`, size.span);
        }
      } else if (!isIdentifier(size.text)) {
        reportSpan(
          st,
          'core/decl/bad-array-size',
          '数组长度只能是正整数或已声明的整数 `# 常量`（§3.4.2）。',
          size.span,
        );
      }
      return { valueType, arraySize: size };
    }
  }
  reportSpan(
    st,
    'core/decl/unknown-type',
    `未知类型 \`${text}\`：2.0 只有 整数 / 字符串 / 整数[N] / 字符串[N]（§3.4.2）。`,
    spanOfToken(st, token),
  );
  return null;
}

/**
 * 整数字面量超出安全整数范围（`decodeIntegerLiteral` 已返 null，但形状确实是整数）。
 *
 * 诊断码取既有 `core/expr/bad-literal`：这是"这个字面量本身不能承载"（与 NUL / 未配对代理项
 * 同一族），不是"这里不是字面量"——所以不能借用 `core/decl/bad-initializer` /
 * `const-not-constant`（那两条指向的修法是"换成字面量"，而作者写的本来就是字面量）。
 */
function reportUnsafeInteger(st: ParserState, text: string, span: KojoSpan): boolean {
  if (!isIntegerLiteralText(text) || decodeIntegerLiteral(text) !== null) return false;
  reportSpan(
    st,
    'core/expr/bad-literal',
    `整数字面量 \`${text.trim()}\` 超出安全整数范围（±9007199254740991）：会被静默舍入，不能当常量 / 初值 / 表值（§3.4.3）。`,
    span,
  );
  return true;
}

function parseLiteralToken(
  st: ParserState,
  token: KojoCallArg,
  code: CoreDiagnosticCode,
  type: KojoValueType | null,
): KojoLiteral | null {
  const quoted = decodeQuotedLiteral(token.text);
  if (quoted !== null) {
    if (type === 'int') {
      reportSpan(st, 'core/decl/bad-initializer', '整数变量的初值不能是字符串（不做隐式转换，§3.4.2）。', spanOfToken(st, token));
      return null;
    }
    return quoted;
  }
  const int = decodeIntegerLiteral(token.text);
  if (int !== null) {
    if (type === 'string') {
      reportSpan(st, 'core/decl/bad-initializer', '字符串变量的初值不能是整数（不做隐式转换，§3.4.2）。', spanOfToken(st, token));
      return null;
    }
    return int;
  }
  if (reportUnsafeInteger(st, token.text, spanOfToken(st, token))) return null;
  reportSpan(
    st,
    code,
    '初值只允许字面量：整数字面量 / 双引号字符串 / 十六进制颜色（§3.4.3）。',
    spanOfToken(st, token),
  );
  return null;
}

function storageOfWord(word: string): KojoVarStorage | null {
  for (let i = 0; i < KOJO_STORAGE_WORDS.length; i++) {
    if (KOJO_STORAGE_WORDS[i] === word) return i === 0 ? 'scene' : i === 1 ? 'save' : 'session';
  }
  return null;
}

function parseVarDecl(st: ParserState, header: KojoDeclRecord): void {
  const tokens = splitSpaces(header.rest, header.restOffset);
  if (tokens.length < 2) {
    reportSpan(
      st,
      'core/lex/anchor',
      '`# 变量` 写成 `# 变量 <名> <类型> [= 初值] [场景|存档|会话]`（§3.4.1）。',
      spanOfLine(st, header),
    );
    return;
  }
  if (!declNameValid(st, tokens[0])) return;
  const name = tokens[0]!.text;
  const parsedType = parseTypeToken(st, tokens[1]!);
  if (parsedType === null) return;

  let storage: KojoVarStorage = KOJO_DEFAULT_STORAGE === '场景' ? 'scene' : 'scene';
  let init: KojoLiteral | undefined;
  let sawInit = false;
  for (let i = 2; i < tokens.length; i++) {
    const token = tokens[i]!;
    const storageWord = storageOfWord(token.text);
    if (storageWord !== null) {
      storage = storageWord;
      continue;
    }
    if (token.text.charCodeAt(0) === 61 /* = */) {
      if (sawInit) {
        reportSpan(st, 'core/decl/bad-initializer', '初值只能写一次。', spanOfToken(st, token));
        continue;
      }
      sawInit = true;
      if (token.text.length > 1) {
        init =
          parseLiteralToken(
            st,
            { text: token.text.slice(1), offset: token.offset + 1 },
            'core/decl/bad-initializer',
            parsedType.valueType,
          ) ?? undefined;
      } else {
        const next = tokens[i + 1];
        if (next === undefined) {
          reportSpan(st, 'core/decl/bad-initializer', '`=` 后面缺初值（§3.4.3）。', spanOfToken(st, token));
        } else {
          init = parseLiteralToken(st, next, 'core/decl/bad-initializer', parsedType.valueType) ?? undefined;
          i++;
        }
      }
      continue;
    }
    if (sawInit) {
      reportSpan(
        st,
        'core/decl/bad-initializer',
        '初值只能是字面量（整数字面量 / 字符串 / 十六进制颜色），不能写表达式（§3.4.3）。',
        spanOfToken(st, token),
      );
      continue;
    }
    reportSpan(
      st,
      'core/decl/unknown-storage',
      `\`${token.text}\` 不是存储期：只有 场景 / 存档 / 会话（§3.4.4）。`,
      spanOfToken(st, token),
    );
  }

  if (parsedType.arraySize !== undefined && sawInit) {
    reportSpan(
      st,
      'core/decl/bad-initializer',
      '数组声明不允许初值：元素按类型默认值初始化（§3.4.3）。',
      spanOfLine(st, header),
    );
    init = undefined;
  }
  registerDeclarationName(st, name, spanOfToken(st, tokens[0]!), '变量');
  const decl: KojoVarDecl = {
    kind: 'var',
    name,
    valueType: parsedType.valueType,
    arraySize: parsedType.arraySize,
    init,
    storage,
    span: spanOfLine(st, header),
  };
  st.decls.push(decl);
}

function parseConstDecl(st: ParserState, header: KojoDeclRecord): void {
  const tokens = splitSpaces(header.rest, header.restOffset);
  if (tokens.length < 2) {
    reportSpan(
      st,
      'core/lex/anchor',
      '`# 常量` 写成 `# 常量 <名> <类型> = <值>`（§3.4.1）。',
      spanOfLine(st, header),
    );
    return;
  }
  if (!declNameValid(st, tokens[0])) return;
  const name = tokens[0]!.text;
  const parsedType = parseTypeToken(st, tokens[1]!);
  if (parsedType === null) return;

  let eqIndex = -1;
  for (let i = 2; i < tokens.length; i++) {
    if (tokens[i]!.text.charCodeAt(0) === 61) {
      eqIndex = i;
      break;
    }
  }
  if (eqIndex < 0) {
    reportSpan(st, 'core/decl/bad-initializer', '`# 常量` 必须有初值：缺 `= <值>`（§3.4.3）。', spanOfLine(st, header));
    return;
  }
  const eqToken = tokens[eqIndex]!;
  let value: KojoLiteral | null;
  if (eqToken.text.length > 1) {
    value = parseLiteralToken(
      st,
      { text: eqToken.text.slice(1), offset: eqToken.offset + 1 },
      'core/decl/const-not-constant',
      parsedType.valueType,
    );
  } else {
    const next = tokens[eqIndex + 1];
    if (next === undefined) {
      reportSpan(st, 'core/decl/bad-initializer', '`=` 后面缺常量值（§3.4.3）。', spanOfToken(st, eqToken));
      return;
    }
    value = parseLiteralToken(st, next, 'core/decl/const-not-constant', parsedType.valueType);
  }
  if (value === null) return;
  registerDeclarationName(st, name, spanOfToken(st, tokens[0]!), '常量');
  const decl: KojoConstDecl = {
    kind: 'const',
    name,
    valueType: parsedType.valueType,
    value,
    span: spanOfLine(st, header),
  };
  st.decls.push(decl);
}

/* ============================== # 表 ============================== */

function parseTableDecl(st: ParserState, header: KojoDeclRecord): void {
  const tokens = splitSpaces(header.rest, header.restOffset);
  if (tokens.length === 0) {
    reportSpan(st, 'core/lex/anchor', '`# 表` 缺表名：写 `# 表 心情 由 恋慕`（§6.1）。', spanOfLine(st, header));
    return;
  }
  const nameToken = tokens[0]!;
  if (!declNameValid(st, nameToken)) return;

  let subject = makeExpr(st, '', header.contentEnd);
  let subjectFound = false;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text === KOJO_TABLE_SUBJECT) {
      subjectFound = true;
      const rawStart = token.offset + token.text.length;
      subject = makeExpr(st, st.source.slice(rawStart, header.contentEnd), rawStart);
      break;
    }
  }
  if (!subjectFound) {
    reportSpan(st, 'core/lex/anchor', '`# 表` 写成 `# 表 <名> 由 <表达式>`：缺 `由`（§6.1）。', spanOfLine(st, header));
  }

  const rows: KojoTableRow[] = [];
  const bodyIndent = header.indent + 4;
  while (st.i < st.lines.length) {
    const line = st.lines[st.i]!;
    if (line.kind === 'blank') break; // 物理空行结束表（§6.1）
    if (line.kind === 'comment') {
      st.i++;
      continue;
    }
    if (line.indent < bodyIndent) break;
    if (line.indent > bodyIndent) {
      report(st, 'core/lex/indent', `表行缩进必须恰好比 \`# 表\` 深一级（${bodyIndent} 空格）。`, line.lineOffset, line.contentOffset);
      skipLineAndSubtree(st);
      continue;
    }
    if (line.kind === 'legacy') {
      handleLegacyLine(st, line);
      continue;
    }
    if (line.invalid) {
      skipLineAndSubtree(st);
      continue;
    }
    const row = parseTableRow(st, line);
    if (row !== null) rows.push(row);
    st.i++;
  }
  registerDeclarationName(st, nameToken.text, spanOfToken(st, nameToken), '表');
  const decl: KojoTableDecl = {
    kind: 'table',
    name: nameToken.text,
    subject,
    rows,
    span: blockSpan(st, header),
  };
  st.decls.push(decl);
}

function parseTableRow(st: ParserState, line: KojoLexLine): KojoTableRow | null {
  const text = line.text;
  const base = line.contentOffset;
  if (text.trim() === KOJO_TABLE_DEFAULT) {
    reportSpan(st, 'core/table/empty-default', '`否` 行必须有值：`否 未知`（§6.1）。', spanOfLine(st, line));
    return { from: null, to: null, value: '', span: spanOfLine(st, line) };
  }
  let sep = -1;
  for (let i = 0; i < text.length; i++) {
    if (isSpaceCode(text.charCodeAt(i))) {
      sep = i;
      break;
    }
  }
  if (sep < 0) {
    reportSpan(st, 'core/table/value-empty', '表行必须是两列：`<范围> <值>`（§6.1）。', spanOfLine(st, line));
    return null;
  }
  let valueStart = sep;
  while (valueStart < text.length && isSpaceCode(text.charCodeAt(valueStart))) valueStart++;
  const rangeRaw = text.slice(0, sep);
  const valueRaw = text.slice(valueStart);
  const rowSpan = spanOfLine(st, line);
  const valueOffset = base + valueStart;

  if (rangeRaw === KOJO_TABLE_DEFAULT) {
    if (valueRaw.length === 0) {
      reportSpan(st, 'core/table/empty-default', '`否` 行必须有值：`否 未知`（§6.1）。', rowSpan);
    }
    return { from: null, to: null, value: decodeTableValue(st, valueRaw, valueOffset), span: rowSpan };
  }
  if (valueRaw.length === 0) {
    reportSpan(st, 'core/table/value-empty', '表行缺值列：`<范围> <值>`（§6.1）。', rowSpan);
  }

  const dots = rangeRaw.indexOf('..');
  if (dots >= 0) {
    const fromRaw = rangeRaw.slice(0, dots);
    const toRaw = rangeRaw.slice(dots + 2);
    const from = fromRaw.length === 0 ? null : makeExpr(st, fromRaw, base);
    const to = toRaw.length === 0 ? null : makeExpr(st, toRaw, base + dots + 2);
    if (from === null && to === null) {
      reportSpan(st, 'core/table/dynamic-endpoint', '范围两端不能同时为空（写 `500..` / `..100` / `0..100`）。', rowSpan);
    }
    return { from, to, value: decodeTableValue(st, valueRaw, valueOffset), span: rowSpan };
  }

  // 精确值 = 两端同值的退化闭区间（与 C2 `table.ts` 对齐）
  const exact = makeExpr(st, rangeRaw, base);
  return { from: exact, to: exact, value: decodeTableValue(st, valueRaw, valueOffset), span: rowSpan };
}

/**
 * 表值列解码（**会报诊断**：值列里恰好是整数写法、但超出安全整数时，不能静默退化成字符串
 * ——那会把 `# 表` 的整数列整片改成字符串列，作者读到的只是"类型不一致"）。
 */
function decodeTableValue(st: ParserState, raw: string, startOffset: number): KojoLiteral {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  const quoted = decodeQuotedLiteral(trimmed);
  if (quoted !== null) return quoted;
  const int = decodeIntegerLiteral(trimmed);
  if (int !== null) return int;
  if (isIntegerLiteralText(trimmed)) {
    report(
      st,
      'core/expr/bad-literal',
      `整数字面量 \`${trimmed}\` 超出安全整数范围（±9007199254740991）：会被静默舍入，不能当表值（§6.1）。`,
      startOffset,
      startOffset + trimmed.length,
    );
  }
  return trimmed;
}

/* ============================== # 池 / # 模 ============================== */

function parsePoolDecl(st: ParserState, header: KojoDeclRecord): void {
  const tokens = splitSpaces(header.rest, header.restOffset);
  if (tokens.length === 0) {
    reportSpan(st, 'core/lex/anchor', '`# 池` 缺池名：写 `# 池 早安问候`（§7.1）。', spanOfLine(st, header));
    return;
  }
  const nameToken = tokens[0]!;
  if (!declNameValid(st, nameToken)) return;

  const bodyIndent = header.indent + 4;
  const firstIndex = nextNonBlankIndex(st, st.i);
  let branches: readonly KojoConditionBranch[] = [];
  if (firstIndex < 0 || st.lines[firstIndex]!.indent < bodyIndent) {
    reportSpan(
      st,
      'core/pool/no-default',
      '`# 池` 体必须是一条 `?` 条件链，且以 `? 否` 收束（§7.1）。',
      spanOfLine(st, header),
    );
  } else if (st.lines[firstIndex]!.indent > bodyIndent) {
    report(
      st,
      'core/lex/indent',
      `池体缩进必须恰好比 \`# 池\` 深一级（${bodyIndent} 空格）。`,
      st.lines[firstIndex]!.lineOffset,
      st.lines[firstIndex]!.contentOffset,
    );
    skipIndentedBody(st, header.indent);
  } else if (st.lines[firstIndex]!.kind !== 'condition') {
    reportSpan(
      st,
      'core/pool/no-default',
      '`# 池` 体必须是一条 `?` 条件链（`? 条件` + `? 否`）；普通叙事请放场景正文（§7.1）。',
      spanOfLine(st, header),
    );
    skipIndentedBody(st, header.indent);
  } else {
    const chain = parseNarrativeConditionChain(st, { kind: 'pool', labelsAllowed: false, unitTop: false });
    if (chain !== null) branches = chain.branches;
  }
  registerDeclarationName(st, nameToken.text, spanOfToken(st, nameToken), '池');
  const decl: KojoPoolDecl = { kind: 'pool', name: nameToken.text, branches, span: blockSpan(st, header) };
  st.decls.push(decl);
}

/**
 * 参数列表收口：`)` 之后再出现非空白 = 右括号未配对 / 声明头有脏尾巴。
 * 扫描本身有界（matchParenEnd 单遍），这里只负责把「多余尾巴」变成诊断而不是静默吞掉。
 */
function reportParenTail(
  st: ParserState,
  rest: string,
  restOffset: number,
  close: number,
  header: KojoLexLine,
  label: string,
): void {
  if (rest.slice(close + 1).trim().length === 0) return;
  report(st, 'core/lex/anchor', `${label} 的参数列表 \`)\` 后不能有内容。`, restOffset + close + 1, header.contentEnd);
}

function parseTemplateDecl(st: ParserState, header: KojoDeclRecord): void {
  const rest = header.rest;
  const restOffset = header.restOffset;
  const open = rest.indexOf('(');
  let name = rest.trim();
  let params: KojoTemplateParam[] = [];
  if (open >= 0) {
    name = rest.slice(0, open).trim();
    const close = matchParenEnd(rest, open);
    if (close < 0) {
      reportSpan(st, 'core/lex/anchor', '`# 模` 的参数括号未闭合。', spanOfLine(st, header));
    } else {
      reportParenTail(st, rest, restOffset, close, header, '`# 模`');
      const argTokens = splitTopLevelArgs(rest.slice(open + 1, close), restOffset + open + 1);
      params = argTokens.map((token) => {
        const eq = token.text.indexOf('=');
        const paramName = (eq >= 0 ? token.text.slice(0, eq) : token.text).trim();
        if (!isIdentifier(paramName)) {
          reportSpan(
            st,
            'core/lex/anchor',
            `模板参数 \`${paramName}\` 不是合法名字（只写名字，不写默认值）。`,
            spanOfToken(st, token),
          );
        }
        return { name: paramName, span: spanOfToken(st, token) };
      });
    }
  }
  if (!isIdentifier(name)) {
    reportSpan(st, 'core/lex/anchor', `\`# 模\` 的名字 \`${name}\` 不是合法标识符。`, spanOfLine(st, header));
    return;
  }
  registerDeclarationName(st, name, spanOfLine(st, header), '模板');

  const body: KojoNarrativeNode[] = [];
  let slotIndex: number | null = null;
  const bodyIndent = header.indent + 4;
  const templateCtx: CtxBase = { kind: 'template', labelsAllowed: false, unitTop: false };
  while (st.i < st.lines.length) {
    const line = st.lines[st.i]!;
    if (line.kind === 'blank') {
      const next = nextNonBlankIndex(st, st.i + 1);
      if (next < 0 || st.lines[next]!.indent < bodyIndent) break;
      st.i++;
      continue;
    }
    if (line.kind === 'comment') {
      st.i++;
      continue;
    }
    if (line.indent < bodyIndent) break;
    if (line.invalid) {
      skipLineAndSubtree(st);
      continue;
    }
    if (line.indent > bodyIndent) {
      report(st, 'core/lex/indent', `模板体缩进必须恰好比 \`# 模\` 深一级（${bodyIndent} 空格）。`, line.lineOffset, line.contentOffset);
      skipLineAndSubtree(st);
      continue;
    }
    if (line.kind === 'text' && line.body === KOJO_TEMPLATE_SLOT) {
      if (slotIndex !== null) {
        reportSpan(st, 'core/template/multi-slot', '`# 模` 里 `[插槽]` 最多一个（§7.2）。', spanOfLine(st, line));
      } else {
        slotIndex = body.length;
      }
      st.i++;
      continue;
    }
    const node = parseNarrativeStatement(st, line, templateCtx);
    if (node !== null) body.push(node);
  }
  const decl: KojoTemplateDecl = {
    kind: 'template',
    name,
    params,
    body,
    slotIndex,
    span: blockSpan(st, header),
  };
  st.decls.push(decl);
}

/* ============================== @函 / @织 ============================== */

function parseFunctionDecl(st: ParserState, header: KojoLexLine): void {
  // 防御：本函数是块头消费者（调用方不会预推进），任何提前 return 都必须自己推进，否则顶层死循环。
  if (header.kind !== 'dispatch') {
    st.i++;
    return;
  }
  const rest = header.rest;
  const restOffset = header.restOffset;
  const open = rest.indexOf('(');
  let name = rest.trim();
  const params: KojoFunctionParam[] = [];
  if (open >= 0) {
    name = rest.slice(0, open).trim();
    const close = matchParenEnd(rest, open);
    if (close < 0) {
      reportSpan(st, 'core/lex/anchor', '`@函` 的参数括号未闭合。', spanOfLine(st, header));
    } else {
      reportParenTail(st, rest, restOffset, close, header, '`@函`');
      const argTokens = splitTopLevelArgs(rest.slice(open + 1, close), restOffset + open + 1);
      for (let i = 0; i < argTokens.length; i++) {
        const token = argTokens[i]!;
        const eq = findTopLevelAssignOp(token.text);
        let paramName = token.text;
        let defaultValue: KojoLiteral | undefined;
        if (eq !== null && eq.op === '=') {
          paramName = token.text.slice(0, eq.index).trim();
          const rawDefault = token.text.slice(eq.index + 1);
          const defaultOffset = token.offset + eq.index + 1;
          const quoted = decodeQuotedLiteral(rawDefault);
          const int = decodeIntegerLiteral(rawDefault);
          if (quoted !== null) defaultValue = quoted;
          else if (int !== null) defaultValue = int;
          else if (isIntegerLiteralText(rawDefault)) {
            report(
              st,
              'core/expr/bad-literal',
              `整数字面量 \`${rawDefault.trim()}\` 超出安全整数范围（±9007199254740991）：会被静默舍入，不能当默认值（§7.3）。`,
              defaultOffset,
              defaultOffset + rawDefault.length,
            );
          } else {
            report(
              st,
              'core/decl/bad-initializer',
              '函数参数默认值只能是字面量：整数 / 双引号字符串（§7.3）。',
              defaultOffset,
              defaultOffset + rawDefault.length,
            );
          }
        }
        if (!isIdentifier(paramName)) {
          reportSpan(st, 'core/lex/anchor', `参数名 \`${paramName}\` 不是合法标识符。`, spanOfToken(st, token));
        }
        params.push({ name: paramName, defaultValue, span: spanOfToken(st, token) });
      }
    }
  }
  if (!isIdentifier(name)) {
    reportSpan(
      st,
      'core/lex/anchor',
      `\`@函\` 的名字 \`${name}\` 不是合法标识符（形如 \`@函 增加羁绊(目标, 数值=10)\`）。`,
      spanOfLine(st, header),
    );
    // 块头消费者必须推进：名字非法（如 `@函 a)`）时旧路径直接 return，顶层拿到同一下标会无限重报 → OOM。
    skipLineAndSubtree(st);
    return;
  }
  registerDeclarationName(st, name, spanOfLine(st, header), '函数');

  st.i++;
  st.functionDepth++;
  const body = parseDispatchBlock(st, header.indent + 4, {
    kind: 'function',
    labelsAllowed: true,
    unitTop: true,
  });
  st.functionDepth--;
  const decl: KojoFunctionDecl = { kind: 'function', name, params, body, span: blockSpan(st, header) };
  st.decls.push(decl);
}

const WEAVE_MODIFIER_MAP: ReadonlyMap<string, KojoWeaveModifier> = new Map<string, KojoWeaveModifier>([
  ['之前', 'pri'],
  ['之后', 'later'],
  ['接管', 'only'],
]);

function parseWeaveDecl(st: ParserState, header: KojoLexLine): void {
  if (header.kind !== 'dispatch') {
    st.i++;
    return;
  }
  const tokens = splitSpaces(header.rest, header.restOffset);
  if (tokens.length === 0) {
    reportSpan(st, 'core/lex/anchor', '`@织` 缺事件名（形如 `@织 回合末 之后`）。', spanOfLine(st, header));
    // 同 `@函`：块头消费者必须推进；裸 `@织` 直接 return 会让顶层原地重报直到 OOM。
    skipLineAndSubtree(st);
    return;
  }
  let modifierStart = tokens.length;
  const modifiers: KojoWeaveModifier[] = [];
  const modifierWords = new Set<string>();
  while (modifierStart > 0) {
    const last = tokens[modifierStart - 1]!;
    const modifier = WEAVE_MODIFIER_MAP.get(last.text);
    if (modifier === undefined) break;
    if (modifierWords.has(last.text)) {
      reportSpan(st, 'core/weave/modifier-conflict', `\`@织\` 修饰词 \`${last.text}\` 重复（§8.6）。`, spanOfToken(st, last));
    }
    modifierWords.add(last.text);
    modifiers.unshift(modifier);
    modifierStart--;
  }
  if (modifierWords.has(KOJO_WEAVE_MODIFIERS[2]) && modifiers.length > 1) {
    reportSpan(st, 'core/weave/modifier-conflict', '`接管` 不能与 `之前 / 之后` 并用（§8.6）。', spanOfLine(st, header));
  }
  if (modifiers.length > 1) {
    reportSpan(
      st,
      'core/weave/modifier-conflict',
      '`@织` 的修饰词最多一个（`之前` / `之后` / `接管` 三选一，§8.6）。',
      spanOfLine(st, header),
    );
  }
  const event = tokens[0]!.text;
  const args: string[] = [];
  for (let i = 1; i < modifierStart; i++) args.push(tokens[i]!.text);

  st.i++;
  const body = parseNarrativeBlock(st, header.indent + 4, {
    kind: 'weave',
    labelsAllowed: true,
    unitTop: true,
  });
  const decl: KojoWeaveDecl = { kind: 'weave', event, args, modifiers, body, span: blockSpan(st, header) };
  st.decls.push(decl);
}

/* ============================== 块体推进 ============================== */

function parseNarrativeBlock(st: ParserState, baseIndent: number, ctx: CtxBase): KojoNarrativeNode[] {
  const out: KojoNarrativeNode[] = [];
  while (st.i < st.lines.length) {
    const line = st.lines[st.i]!;
    if (line.kind === 'blank') {
      const next = nextNonBlankIndex(st, st.i + 1);
      if (next < 0 || st.lines[next]!.indent < baseIndent) break;
      st.i++;
      continue;
    }
    if (line.indent < baseIndent) break;
    if (line.indent > baseIndent) {
      report(st, 'core/lex/indent', '缩进比所在块基准深一级以上，却没有块头（§4.13）。', line.lineOffset, line.contentOffset);
      skipLineAndSubtree(st);
      continue;
    }
    const node = parseNarrativeStatement(st, line, ctx);
    if (node !== null) out.push(node);
  }
  return out;
}

function parseDispatchBlock(st: ParserState, baseIndent: number, ctx: CtxBase): KojoDispatchNode[] {
  const out: KojoDispatchNode[] = [];
  while (st.i < st.lines.length) {
    const line = st.lines[st.i]!;
    if (line.kind === 'blank') {
      const next = nextNonBlankIndex(st, st.i + 1);
      if (next < 0 || st.lines[next]!.indent < baseIndent) break;
      st.i++;
      continue;
    }
    if (line.indent < baseIndent) break;
    if (line.indent > baseIndent) {
      report(st, 'core/lex/indent', '缩进比所在块基准深一级以上，却没有块头（§4.13）。', line.lineOffset, line.contentOffset);
      skipLineAndSubtree(st);
      continue;
    }
    const node = parseDispatchStatement(st, line, ctx);
    if (node !== null) out.push(node);
  }
  return out;
}

/* ============================== 叙事区语句 ============================== */

function parseNarrativeStatement(st: ParserState, line: KojoLexLine, ctx: CtxBase): KojoNarrativeNode | null {
  switch (line.kind) {
    case 'blank':
    case 'comment':
      st.i++;
      return null;
    case 'unknown':
      reportUnknownLine(st, line);
      return null;
    case 'legacy':
      handleLegacyLine(st, line);
      return null;
    case 'native':
      reportSpan(st, 'core/lex/anchor', '原始行只能出现在 `@原生` 块体内（§8.5）。', spanOfLine(st, line));
      st.i++;
      return null;
    case 'decl':
      reportBlockDeclaration(st, line, ctx);
      return null;
    case 'options':
      return parseOptionsBlock(st, line, ctx);
    case 'condition':
      return parseNarrativeConditionChain(st, ctx);
    case 'narration':
    case 'dialogue':
    case 'escaped': {
      if (line.invalid) {
        skipLineAndSubtree(st);
        return null;
      }
      st.i++;
      if (!validateTextRecord(st, line)) return null;
      const speech: KojoSpeech =
        line.kind === 'dialogue' ? { kind: 'dialogue', speaker: line.speaker } : { kind: 'narration' };
      return buildTextLine(st, line, speech);
    }
    case 'bareQuote': {
      if (line.invalid) {
        skipLineAndSubtree(st);
        return null;
      }
      if (ctx.kind !== 'pool') {
        reportSpan(
          st,
          'core/narrative/bare-quote',
          '2.0 裸引号不是台词：写 `角色：「…」`；只有 `# 池`（和 `选项` 的按钮标签）是局部例外（§4.10）。',
          spanOfLine(st, line),
        );
        st.i++;
        return null;
      }
      if (!st.hasView) {
        reportSpan(st, 'core/pool/no-view', '池内裸引号默认说话人是 `{我}`，但文件没有 `# 视`（§7.1）。', spanOfLine(st, line));
      }
      st.i++;
      if (!validateTextRecord(st, line)) return null;
      return buildTextLine(st, line, { kind: 'bareQuote' });
    }
    case 'blankLine':
      st.i++;
      if (line.invalid) return null;
      return { kind: 'blankLine', wait: line.wait, span: spanOfLine(st, line) };
    case 'trigger': {
      if (line.invalid) {
        skipLineAndSubtree(st);
        return null;
      }
      st.i++;
      if (ctx.kind === 'template') {
        reportSpan(st, 'core/template/side-effect', '模板里不能 `!` 调用函数（编译期展开，无运行期副作用，§7.2）。', spanOfLine(st, line));
      }
      const body = parseCallBody(st, line, ctx);
      return buildCallStmt(st, line, body);
    }
    case 'text':
      st.i++;
      return buildNarrativeBareText(st, line);
    case 'dispatch':
      return parseNarrativeDispatch(st, line, ctx);
    default:
      st.i++;
      return null;
  }
}

function reportBlockDeclaration(st: ParserState, line: KojoLexLine, ctx: CtxBase): void {
  if (line.kind === 'decl' && line.word === '幕') {
    if (ctx.kind === 'weave') {
      reportSpan(st, 'core/weave/scene-inside', '`@织` 块内不能写 `# 幕`：监听不是场景（§8.6）。', spanOfLine(st, line));
    } else {
      reportSpan(st, 'core/decl/not-top-level', '`# 幕` 只能写在文件顶层；块内不能开新场景（§3.2）。', spanOfLine(st, line));
    }
  } else {
    reportSpan(st, 'core/decl/not-top-level', '声明只能写在文件顶层：不能写进可执行块 / 池 / 模板（§3.2）。', spanOfLine(st, line));
  }
  st.i++;
  skipIndentedBody(st, line.indent);
}

function parseNarrativeDispatch(st: ParserState, line: KojoLexLine, ctx: CtxBase): KojoNarrativeNode | null {
  if (line.kind !== 'dispatch') {
    st.i++;
    return null;
  }
  if (line.invalid) {
    skipLineAndSubtree(st);
    return null;
  }
  switch (line.word) {
    case '算':
      return parseSandboxBlock(st, line, ctx);
    case '着色':
      return parseColorBlock(st, line, ctx);
    case '颜绘':
      return parseFaceLine(st, line);
    case '随机':
      return parseRandomBlock(st, line, ctx);
    case '组':
      reportSpan(
        st,
        'core/random/group-nested',
        '`@组` 只在 `@随机` 里有效：每个 `@组` 算一个候选，且不能嵌套（§8.4）。',
        spanOfLine(st, line),
      );
      skipLineAndSubtree(st);
      return null;
    case '循':
      return parseWhileLoop(st, line, ctx);
    case '复':
      return parseRepeatLoop(st, line, ctx);
    case '巡':
      return parseForEachLoop(st, line, ctx);
    case '断':
    case '续':
      return parseLoopJump(st, line, line.word === '断' ? 'break' : 'continue');
    case '标':
      return parseLabel(st, line, ctx);
    case '跳':
      return parseJump(st, line);
    case '返':
      reportSpan(st, 'core/func/return-outside', '`@返` 只能出现在 `@函` 里（§7.3）。', spanOfLine(st, line));
      skipLineAndSubtree(st);
      return null;
    case '原生':
      return parseNativeBlock(st, line, ctx);
    case '织':
    case '函':
      reportSpan(st, 'core/decl/not-top-level', '`@织` / `@函` 是声明，只能写在文件顶层（§3.2）。', spanOfLine(st, line));
      skipLineAndSubtree(st);
      return null;
    default:
      reportSpan(st, 'core/lex/anchor', `未知调度词 \`@${line.word}\`（§2.1）。`, spanOfLine(st, line));
      skipLineAndSubtree(st);
      return null;
  }
}

/* ============================== 调度区语句 ============================== */

function parseDispatchStatement(st: ParserState, line: KojoLexLine, ctx: CtxBase): KojoDispatchNode | null {
  switch (line.kind) {
    case 'blank':
    case 'comment':
      st.i++;
      return null;
    case 'unknown':
      reportUnknownLine(st, line);
      return null;
    case 'legacy':
      handleLegacyLine(st, line);
      return null;
    case 'native':
      reportSpan(st, 'core/lex/anchor', '原始行只能出现在 `@原生` 块体内（§8.5）。', spanOfLine(st, line));
      st.i++;
      return null;
    case 'decl':
      reportBlockDeclaration(st, line, ctx);
      return null;
    case 'options':
      reportSpan(st, 'core/decl/not-top-level', '`选项` 只能写在场景正文顶层（§7.5）。', spanOfLine(st, line));
      skipLineAndSubtree(st);
      return null;
    case 'condition':
      return parseDispatchConditionChain(st, ctx);
    case 'narration':
    case 'dialogue':
    case 'escaped': {
      if (line.invalid) {
        skipLineAndSubtree(st);
        return null;
      }
      st.i++;
      if (!validateTextRecord(st, line)) return null;
      const speech: KojoSpeech =
        line.kind === 'dialogue' ? { kind: 'dialogue', speaker: line.speaker } : { kind: 'narration' };
      return buildTextLine(st, line, speech);
    }
    case 'bareQuote':
      reportSpan(
        st,
        'core/narrative/bare-quote',
        '裸引号只允许出现在 `# 池` 里；调度区写 `角色：「…」`（§7.1）。',
        spanOfLine(st, line),
      );
      st.i++;
      return null;
    case 'blankLine':
      st.i++;
      if (line.invalid) return null;
      return { kind: 'blankLine', wait: line.wait, span: spanOfLine(st, line) };
    case 'trigger': {
      if (line.invalid) {
        skipLineAndSubtree(st);
        return null;
      }
      st.i++;
      if (ctx.kind === 'template') {
        reportSpan(st, 'core/template/side-effect', '模板里不能 `!` 调用函数（§7.2）。', spanOfLine(st, line));
      }
      const body = parseCallBody(st, line, ctx);
      return buildCallStmt(st, line, body);
    }
    case 'text': {
      st.i++;
      if (line.invalid) return null;
      return buildDispatchText(st, line);
    }
    case 'dispatch':
      return parseDispatchDispatch(st, line, ctx);
    default:
      st.i++;
      return null;
  }
}

function parseDispatchDispatch(st: ParserState, line: KojoLexLine, ctx: CtxBase): KojoDispatchNode | null {
  if (line.kind !== 'dispatch') {
    st.i++;
    return null;
  }
  if (line.invalid) {
    skipLineAndSubtree(st);
    return null;
  }
  switch (line.word) {
    case '算':
      return parseSandboxBlock(st, line, ctx);
    case '着色':
      reportSpan(st, 'core/color/unsupported', '`@着色` 是叙事区演出块：调度区不能写着色（§8.2）。', spanOfLine(st, line));
      skipLineAndSubtree(st);
      return null;
    case '颜绘':
      return parseFaceLine(st, line);
    case '随机':
      reportSpan(st, 'core/random/unsupported', '`@随机` 不能直接塞进 `@算` / 函数体：随机演出回到叙事区（§8.4）。', spanOfLine(st, line));
      skipLineAndSubtree(st);
      return null;
    case '组':
      reportSpan(st, 'core/random/group-nested', '`@组` 只在 `@随机` 里有效（§8.4）。', spanOfLine(st, line));
      skipLineAndSubtree(st);
      return null;
    case '循':
      return parseWhileLoop(st, line, ctx);
    case '复':
      return parseRepeatLoop(st, line, ctx);
    case '巡':
      return parseForEachLoop(st, line, ctx);
    case '断':
    case '续':
      return parseLoopJump(st, line, line.word === '断' ? 'break' : 'continue');
    case '标':
      return parseLabel(st, line, ctx);
    case '跳':
      return parseJump(st, line);
    case '返':
      return parseReturn(st, line);
    case '原生':
      return parseNativeBlock(st, line, ctx);
    case '织':
    case '函':
      reportSpan(st, 'core/decl/not-top-level', '`@织` / `@函` 是声明，只能写在文件顶层（§3.2）。', spanOfLine(st, line));
      skipLineAndSubtree(st);
      return null;
    default:
      reportSpan(st, 'core/lex/anchor', `未知调度词 \`@${line.word}\`（§2.1）。`, spanOfLine(st, line));
      skipLineAndSubtree(st);
      return null;
  }
}

/* ============================== 文本行构件 ============================== */

function validateTextRecord(st: ParserState, line: TextBearingLine): boolean {
  let ok = true;
  if (line.hintCount > 1) {
    reportSpan(st, 'core/narrative/bad-hint', '一行只挂一个行尾表演提示组（§4.8）。', spanOfLine(st, line));
    ok = false;
  }
  if (line.hint !== null && line.body.length === 0) {
    reportSpan(
      st,
      'core/narrative/bad-hint',
      '表演提示不能单独成行：挂到台词/旁白行尾，或用 `> （心跳声）` 当正文打印（§4.8）。',
      spanOfLine(st, line),
    );
    ok = false;
  }
  return ok;
}

function buildTextLine(st: ParserState, line: TextBearingLine, speech: KojoSpeech): KojoTextLine {
  return {
    kind: 'textLine',
    speech,
    parts: toTextParts(st, line.parts),
    wait: line.wait,
    hint: line.hint !== null && line.hintCount === 1 ? line.hint.text : undefined,
    span: spanOfLine(st, line),
  };
}

function toTextParts(st: ParserState, segments: readonly KojoTextSegment[]): KojoTextPart[] {
  const parts: KojoTextPart[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment.kind === 'text') {
      if (segment.text.length > 0) parts.push({ kind: 'text', text: segment.text });
      continue;
    }
    const expr = makeExpr(st, segment.value, segment.valueOffset);
    if (segment.condition === null) {
      parts.push({ kind: 'interp', expr });
      continue;
    }
    parts.push({
      kind: 'interp',
      expr,
      cond: {
        cond: makeExpr(st, segment.condition.cond.text, segment.condition.cond.offset),
        then: makeExpr(st, segment.condition.then.text, segment.condition.then.offset),
        else: makeExpr(st, segment.condition.else.text, segment.condition.else.offset),
      },
    });
  }
  return parts;
}

/** 叙事区裸行：一律 error（裸旁白 / 裸台词 / 叙事区原生行） */
function buildNarrativeBareText(st: ParserState, line: KojoLexLine): KojoNarrativeNode | null {
  if (line.kind !== 'text') return null;
  const text = line.text;
  if (text.charCodeAt(0) === 91 /* [ */) {
    reportSpan(
      st,
      'core/migration/branch',
      '`[条件]` 标签已退场：条件写 `?` 链，台词池写 `# 池`（§12.1）。',
      spanOfLine(st, line),
    );
    return null;
  }
  if (text.charCodeAt(0) === 40 /* ( */ && text.charCodeAt(text.length - 1) === 41 /* ) */ && text.indexOf('(', 1) < 0) {
    reportSpan(
      st,
      'core/narrative/bad-hint',
      '表演提示不能单独成行：挂到台词/旁白行尾；要打印括号文字写 `> （心跳声）`（§4.8）。',
      spanOfLine(st, line),
    );
    return null;
  }
  if (text.trimStart().startsWith('你：')) {
    reportSpan(
      st,
      'core/narrative/bare-narration',
      '旧 `你：` 前缀已退场：玩家台词写 `你：「…」`（§12.1）。',
      spanOfLine(st, line),
    );
    return null;
  }
  reportSpan(
    st,
    'core/narrative/bare-narration',
    '这行像旁白又像表达式：旁白写 `> …`，台词写 `角色：「…」`；原生 ERB 放进 `@原生`（§4.6 / §4.10）。',
    spanOfLine(st, line),
  );
  return null;
}

/** 调度区裸行：按 §4.4 顺序判赋值 / 调用 / 报错 */
function buildDispatchText(st: ParserState, line: KojoLexLine): KojoDispatchNode | null {
  if (line.kind !== 'text') return null;
  const text = line.body;
  const base = line.bodyOffset;
  const span = spanOfLine(st, line);

  // 调度区裸行 = 代码：全角标点走唯一入口（`x ＝ 1` 会先报 fullwidth 再报 not-expression）
  makeExpr(st, text, base);

  const assign = findTopLevelAssignOp(text);
  if (assign !== null) {
    const opLength = assign.op.length;
    const targetRaw = text.slice(0, assign.index);
    const valueRaw = text.slice(assign.index + opLength);
    const targetStart = trimStartOffset(targetRaw, 0, targetRaw.length);
    const targetEnd = trimEndOffset(targetRaw, targetStart, targetRaw.length);
    const targetText = targetRaw.slice(targetStart, targetEnd);
    if (targetText.length === 0) {
      reportSpan(st, 'core/expr/not-expression', '赋值左边缺目标（变量 / 数组元素 / 角色属性）。', span);
      return null;
    }
    const value = makeExpr(st, valueRaw, base + assign.index + opLength);
    if (value.text.length === 0) {
      reportSpan(st, 'core/expr/not-expression', '赋值右边缺表达式（§4.3）。', span);
      return null;
    }
    const node: KojoAssignStmt = {
      kind: 'assign',
      target: { text: targetText, span: spanOffsets(st, base + targetStart, base + targetEnd) },
      op: assign.op as KojoAssignOp,
      value,
      span,
    };
    return node;
  }

  const paren = text.indexOf('(');
  if (paren > 0 && isIdentifier(text.slice(0, paren).trim())) {
    const node: KojoExprCallStmt = { kind: 'exprCall', call: makeExpr(st, text, base), span };
    return node;
  }
  reportSpan(
    st,
    'core/expr/not-expression',
    '这一行既不是赋值也不是调用：补赋值运算符、`!` 或 `@返`；旁白写 `>`（§4.4）。',
    span,
  );
  return null;
}

/* ============================== 条件链 ============================== */

interface RawBranch<TBody> {
  readonly test: KojoExprText | null;
  readonly body: readonly TBody[];
  readonly span: KojoSpan;
}

function parseConditionChainCore<TBody>(
  st: ParserState,
  ctx: CtxBase,
  parseBody: (branchIndent: number, ctx: CtxBase) => TBody[],
): { readonly branches: RawBranch<TBody>[]; readonly span: KojoSpan } {
  const first = st.lines[st.i]!;
  const baseIndent = first.indent;
  const branchIndent = baseIndent + 4;
  const branches: RawBranch<TBody>[] = [];
  while (st.i < st.lines.length) {
    const line = st.lines[st.i]!;
    if (line.kind === 'blank') break; // 物理空行断链（§5）
    if (line.kind === 'comment') {
      st.i++;
      continue; // 注释不打断链
    }
    if (line.kind === 'legacy') {
      handleLegacyLine(st, line);
      continue;
    }
    if (line.indent !== baseIndent || line.kind !== 'condition') break;
    if (line.invalid) {
      skipLineAndSubtree(st);
      continue;
    }
    st.i++;
    const test: KojoExprText | null = line.isDefault ? null : makeExpr(st, line.test, line.testOffset);
    const body = parseBody(branchIndent, { ...ctx, labelsAllowed: false, unitTop: false });
    branches.push({ test, body, span: spanOffsets(st, line.contentOffset, consumedEndOffset(st, line.contentEnd)) });
  }
  return { branches, span: spanOffsets(st, first.contentOffset, consumedEndOffset(st, first.contentEnd)) };
}

function parseNarrativeConditionChain(st: ParserState, ctx: CtxBase): KojoConditionChain | null {
  const result = parseConditionChainCore<KojoNarrativeNode>(st, ctx, (branchIndent, branchCtx) =>
    parseNarrativeBlock(st, branchIndent, branchCtx),
  );
  if (result.branches.length === 0) return null;
  const branches: KojoConditionBranch[] = result.branches.map((branch) => ({
    test: branch.test,
    body: branch.body,
    span: branch.span,
  }));
  return { kind: 'conditionChain', branches, span: result.span };
}

function parseDispatchConditionChain(st: ParserState, ctx: CtxBase): KojoDispatchCondition | null {
  const result = parseConditionChainCore<KojoDispatchNode>(st, ctx, (branchIndent, branchCtx) =>
    parseDispatchBlock(st, branchIndent, branchCtx),
  );
  if (result.branches.length === 0) return null;
  return {
    kind: 'dispatchCondition',
    branches: result.branches.map((branch) => ({ test: branch.test, body: branch.body, span: branch.span })),
    span: result.span,
  };
}

/* ============================== 调度词构件 ============================== */

function ensureBlockHeaderEmpty(st: ParserState, line: KojoLexLine, word: string): boolean {
  if (line.kind === 'dispatch' && line.rest.length > 0) {
    reportSpan(st, 'core/lex/anchor', `\`@${word}\` 是块头，不接行内内容（§2.2）。`, spanOfLine(st, line));
    return false;
  }
  return true;
}

function parseSandboxBlock(st: ParserState, line: KojoLexLine, ctx: CtxBase): KojoSandboxBlock | null {
  if (ctx.kind === 'pool') {
    reportSpan(st, 'core/pool/side-effect', '`# 池` 内禁止副作用：不能写 `@算`（§7.1）。', spanOfLine(st, line));
  } else if (ctx.kind === 'template') {
    reportSpan(st, 'core/template/side-effect', '`# 模` 内禁止副作用：不能写 `@算`（§7.2）。', spanOfLine(st, line));
  } else if (ctx.kind === 'random' || ctx.kind === 'group') {
    reportSpan(
      st,
      'core/random/bare-control',
      '`@随机` 候选只能是单行文本或 `@组`：`@算` 必须包进 `@组`（§8.4）。',
      spanOfLine(st, line),
    );
  }
  if (!ensureBlockHeaderEmpty(st, line, '算')) {
    skipLineAndSubtree(st);
    return null;
  }
  st.i++;
  const body = parseDispatchBlock(st, line.indent + 4, { kind: 'sandbox', labelsAllowed: false, unitTop: false });
  return { kind: 'sandboxBlock', body, span: blockSpan(st, line) };
}

function parseColorBlock(st: ParserState, line: KojoLexLine, ctx: CtxBase): KojoColorBlock | null {
  if (ctx.kind === 'color') {
    reportSpan(
      st,
      'core/color/nested',
      '`@着色` 不能词法嵌套（不管隔多少层 `?`）：不同条件用平级 `@着色`（§8.2）。',
      spanOfLine(st, line),
    );
  } else if (ctx.kind === 'pool') {
    reportSpan(st, 'core/pool/side-effect', '`# 池` 内禁止 `@着色`（§7.1）。', spanOfLine(st, line));
  } else if (ctx.kind === 'template') {
    reportSpan(st, 'core/template/side-effect', '`# 模` 内禁止 `@着色`（§7.2）。', spanOfLine(st, line));
  }
  if (line.kind !== 'dispatch') return null;
  const color = makeExpr(st, line.rest, line.restOffset);
  if (color.text.length === 0) {
    reportSpan(st, 'core/lex/anchor', '`@着色` 缺颜色：写 `@着色 0xFF8080`（§8.2）。', spanOfLine(st, line));
  }
  st.i++;
  const body = parseNarrativeBlock(st, line.indent + 4, { kind: 'color', labelsAllowed: false, unitTop: false });
  if (!hasPrintableOutput(body)) {
    reportSpan(
      st,
      'core/color/no-output',
      '`@着色` 块里没有任何输出（只有计算）：颜色没有可配对的打印行（§8.2）。',
      blockSpan(st, line),
    );
  }
  return { kind: 'colorBlock', color, body, span: blockSpan(st, line) };
}

function hasPrintableOutput(nodes: readonly KojoNarrativeNode[]): boolean {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (
      node.kind === 'textLine' ||
      node.kind === 'blankLine' ||
      node.kind === 'faceLine' ||
      node.kind === 'randomBlock' ||
      node.kind === 'nativeBlock' ||
      node.kind === 'colorBlock' ||
      node.kind === 'optionsBlock'
    ) {
      return true;
    }
    if (node.kind === 'conditionChain' && conditionHasOutput(node)) return true;
  }
  return false;
}

function conditionHasOutput(chain: KojoConditionChain): boolean {
  for (let i = 0; i < chain.branches.length; i++) {
    if (hasPrintableOutput(chain.branches[i]!.body)) return true;
  }
  return false;
}

function parseFaceLine(st: ParserState, line: KojoLexLine): KojoFaceLine | null {
  if (line.kind !== 'dispatch') return null;
  const tokens = splitSpaces(line.rest, line.restOffset);
  let object: 'me' | 'you' | null = null;
  let start = 0;
  if (tokens.length > 0) {
    const first = tokens[0]!.text;
    if (first === '我') {
      object = 'me';
      start = 1;
    } else if (first === '你') {
      object = 'you';
      start = 1;
    }
  }
  const args: KojoExprText[] = [];
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i]!;
    args.push({ text: token.text, span: spanOffsets(st, token.offset, token.offset + token.text.length) });
  }
  if (args.length > KOJO_FACE_MAX_ARGS) {
    reportSpan(
      st,
      'core/face/args',
      `\`@颜绘\` 最多 ${KOJO_FACE_MAX_ARGS} 个参数（表情 / 服装 / 差分 / 特效，§8.3）。`,
      spanOfLine(st, line),
    );
  }
  st.i++;
  return { kind: 'faceLine', object, args, span: spanOfLine(st, line) };
}

function parseRandomBlock(st: ParserState, line: KojoLexLine, ctx: CtxBase): KojoRandomBlock | null {
  if (ctx.kind === 'random' || ctx.kind === 'group') {
    reportSpan(st, 'core/random/nested', '`@随机` 不能嵌套（§8.4）。', spanOfLine(st, line));
    skipLineAndSubtree(st);
    return null;
  }
  if (!ensureBlockHeaderEmpty(st, line, '随机')) {
    skipLineAndSubtree(st);
    return null;
  }
  st.i++;
  const baseIndent = line.indent + 4;
  const candidates: KojoRandomCandidate[] = [];
  while (st.i < st.lines.length) {
    const child = st.lines[st.i]!;
    if (child.kind === 'blank') {
      const next = nextNonBlankIndex(st, st.i + 1);
      if (next < 0 || st.lines[next]!.indent < baseIndent) break;
      reportSpan(st, 'core/random/empty-line', '`@随机` 内不允许物理空行：要分隔就用 `@组`（§8.4）。', spanOfLine(st, child));
      st.i++;
      continue;
    }
    if (child.kind === 'comment') {
      st.i++;
      continue;
    }
    if (child.indent < baseIndent) break;
    if (child.indent > baseIndent) {
      report(st, 'core/lex/indent', '`@随机` 的候选缩进必须恰好比块头深一级。', child.lineOffset, child.contentOffset);
      skipLineAndSubtree(st);
      continue;
    }
    if (child.invalid) {
      skipLineAndSubtree(st);
      continue;
    }
    if (child.kind === 'legacy') {
      handleLegacyLine(st, child);
      continue;
    }
    if (child.kind === 'dispatch' && child.word === '组') {
      candidates.push(parseRandomGroup(st, child, ctx));
      continue;
    }
    if (child.kind === 'dispatch' && child.word === '随机') {
      reportSpan(st, 'core/random/nested', '`@随机` 不能嵌套（§8.4）。', spanOfLine(st, child));
      skipLineAndSubtree(st);
      continue;
    }
    if (child.kind === 'dispatch' && child.word === '原生') {
      // 不是候选：让 `@原生` 自己报"禁止位置"（§8.5），再整块跳过
      parseNativeBlock(st, child, { kind: 'random', labelsAllowed: false, unitTop: false });
      continue;
    }
    if (child.kind === 'narration' || child.kind === 'dialogue' || child.kind === 'blankLine') {
      const node = parseNarrativeStatement(st, child, { kind: 'random', labelsAllowed: false, unitTop: false });
      if (node !== null && (node.kind === 'textLine' || node.kind === 'blankLine')) {
        candidates.push({ kind: 'randomLine', line: node, span: node.span });
      }
      continue;
    }
    if (child.kind === 'bareQuote') {
      reportSpan(
        st,
        'core/narrative/bare-quote',
        '`@随机` 候选内部按叙事规则写：裸引号只在 `# 池` 里有效（§8.4）。',
        spanOfLine(st, child),
      );
      st.i++;
      continue;
    }
    reportSpan(
      st,
      'core/random/bare-control',
      '`@随机` 的直接子项只能是单行文本或 `@组`：多行 / 条件 / 计算请包进 `@组`（§8.4）。',
      spanOfLine(st, child),
    );
    skipLineAndSubtree(st);
  }
  if (candidates.length === 1) {
    reportSpan(st, 'core/random/one-candidate', '`@随机` 至少要两个候选：只有一个候选就没有分叉（§8.4）。', blockSpan(st, line));
  }
  return { kind: 'randomBlock', candidates, span: blockSpan(st, line) };
}

function parseRandomGroup(st: ParserState, header: KojoLexLine, ctx: CtxBase): KojoRandomCandidate {
  void ctx;
  if (!ensureBlockHeaderEmpty(st, header, '组')) {
    skipLineAndSubtree(st);
    return { kind: 'randomGroup', body: [], span: spanOfLine(st, header) };
  }
  st.i++;
  const body = parseNarrativeBlock(st, header.indent + 4, { kind: 'group', labelsAllowed: false, unitTop: false });
  return { kind: 'randomGroup', body, span: blockSpan(st, header) };
}

function parseWhileLoop(st: ParserState, line: KojoLexLine, ctx: CtxBase): KojoWhileLoop | null {
  if (line.kind !== 'dispatch') return null;
  if (ctx.kind === 'pool') reportSpan(st, 'core/pool/side-effect', '`# 池` 内禁止循环（§7.1）。', spanOfLine(st, line));
  else if (ctx.kind === 'template') reportSpan(st, 'core/template/side-effect', '`# 模` 内禁止循环（§7.2）。', spanOfLine(st, line));
  else if (ctx.kind === 'random' || ctx.kind === 'group') {
    reportSpan(st, 'core/random/bare-control', '`@随机` 候选里不能有循环：包进 `@组` 也必须纯文本（§8.4）。', spanOfLine(st, line));
  }
  const test = makeExpr(st, line.rest, line.restOffset);
  if (test.text.length === 0) {
    reportSpan(st, 'core/lex/anchor', '`@循` 缺条件（形如 `@循 体力恢复 < 100`，§9.3）。', spanOfLine(st, line));
  } else if (test.text === '1' || test.text === '0') {
    reportSpan(st, 'core/control/constant-condition', `\`@循 ${test.text}\` 是恒定条件：作者负责终止（§9.3）。`, test.span);
  }
  st.i++;
  st.loopDepth++;
  const body = parseDispatchBlock(st, line.indent + 4, { kind: 'loop', labelsAllowed: false, unitTop: false });
  st.loopDepth--;
  return { kind: 'whileLoop', test, body, span: blockSpan(st, line) };
}

function parseRepeatLoop(st: ParserState, line: KojoLexLine, ctx: CtxBase): KojoRepeatLoop | null {
  if (line.kind !== 'dispatch') return null;
  if (ctx.kind === 'pool') reportSpan(st, 'core/pool/side-effect', '`# 池` 内禁止循环（§7.1）。', spanOfLine(st, line));
  else if (ctx.kind === 'template') reportSpan(st, 'core/template/side-effect', '`# 模` 内禁止循环（§7.2）。', spanOfLine(st, line));
  else if (ctx.kind === 'random' || ctx.kind === 'group') {
    reportSpan(st, 'core/random/bare-control', '`@随机` 候选里不能有循环（§8.4）。', spanOfLine(st, line));
  }
  if (line.rest.trimStart().startsWith('当')) {
    reportSpan(st, 'core/migration/loop', '`@复 当 <条件>` 已删除：条件循环统一写 `@循 <条件>`（§9.3）。', spanOfLine(st, line));
    skipLineAndSubtree(st);
    return null;
  }
  const count = makeExpr(st, line.rest, line.restOffset);
  if (count.text.length === 0) {
    reportSpan(st, 'core/lex/anchor', '`@复` 缺次数（正整数或整数常量，§9.3）。', spanOfLine(st, line));
  }
  st.i++;
  st.loopDepth++;
  const body = parseDispatchBlock(st, line.indent + 4, { kind: 'loop', labelsAllowed: false, unitTop: false });
  st.loopDepth--;
  return { kind: 'repeatLoop', count, body, span: blockSpan(st, line) };
}

function parseForEachLoop(st: ParserState, line: KojoLexLine, ctx: CtxBase): KojoForEachLoop | null {
  if (line.kind !== 'dispatch') return null;
  if (ctx.kind === 'pool') reportSpan(st, 'core/pool/side-effect', '`# 池` 内禁止循环（§7.1）。', spanOfLine(st, line));
  else if (ctx.kind === 'template') reportSpan(st, 'core/template/side-effect', '`# 模` 内禁止循环（§7.2）。', spanOfLine(st, line));
  else if (ctx.kind === 'random' || ctx.kind === 'group') {
    reportSpan(st, 'core/random/bare-control', '`@随机` 候选里不能有循环（§8.4）。', spanOfLine(st, line));
  }
  const collection = makeExpr(st, line.rest, line.restOffset);
  if (collection.text.length === 0) {
    reportSpan(st, 'core/lex/anchor', '`@巡` 缺集合（形如 `@巡 队伍`，§9.3）。', spanOfLine(st, line));
  }
  st.i++;
  st.loopDepth++;
  const body = parseNarrativeBlock(st, line.indent + 4, { kind: 'loop', labelsAllowed: false, unitTop: false });
  st.loopDepth--;
  return { kind: 'forEachLoop', collection, body, span: blockSpan(st, line) };
}

function parseLoopJump(st: ParserState, line: KojoLexLine, mode: 'break' | 'continue'): KojoLoopJumpStmt | null {
  if (line.kind !== 'dispatch') return null;
  if (line.rest.length > 0) {
    reportSpan(st, 'core/lex/anchor', `\`@${mode === 'break' ? '断' : '续'}\` 不接行内内容（§9.3）。`, spanOfLine(st, line));
  }
  if (st.loopDepth === 0) {
    reportSpan(
      st,
      mode === 'break' ? 'core/control/break-outside' : 'core/control/continue-outside',
      `\`@${mode === 'break' ? '断' : '续'}\` 只能出现在 \`@循\` / \`@巡\` / \`@复\` 体内（§9.3）。`,
      spanOfLine(st, line),
    );
  }
  st.i++;
  return { kind: 'loopJump', mode, span: spanOfLine(st, line) };
}

function parseLabel(st: ParserState, line: KojoLexLine, ctx: CtxBase): KojoLabelStmt | null {
  if (line.kind !== 'dispatch') return null;
  const name = line.rest.trim();
  if (name.length === 0) {
    reportSpan(st, 'core/lex/anchor', '`@标` 缺标签名（形如 `@标 主菜单`，§9.4）。', spanOfLine(st, line));
  } else if (!isIdentifier(name)) {
    reportSpan(st, 'core/lex/anchor', `标签名 \`${name}\` 不是合法标识符。`, spanOfLine(st, line));
  }
  if (ctx.kind === 'pool') reportSpan(st, 'core/pool/side-effect', '`# 池` 内禁止 `@标` / `@跳`（§7.1）。', spanOfLine(st, line));
  else if (ctx.kind === 'template') reportSpan(st, 'core/template/side-effect', '`# 模` 内禁止 `@标`（§7.2）。', spanOfLine(st, line));
  if (!ctx.labelsAllowed) {
    reportSpan(
      st,
      'core/goto/label-in-block',
      '`@标` 只能出现在单元体顶层（场景顶层 / 函数体基准 / 监听体基准），不能进条件分支或循环体（§9.4）。',
      spanOfLine(st, line),
    );
  }
  st.i++;
  return { kind: 'label', name, span: spanOfLine(st, line) };
}

function parseJump(st: ParserState, line: KojoLexLine): KojoJumpStmt | null {
  if (line.kind !== 'dispatch') return null;
  const target = line.rest.trim();
  if (target.length === 0) {
    reportSpan(st, 'core/lex/anchor', '`@跳` 缺目标标签名（§9.4）。', spanOfLine(st, line));
  } else if (!isIdentifier(target)) {
    reportSpan(st, 'core/lex/anchor', `标签名 \`${target}\` 不是合法标识符。`, spanOfLine(st, line));
  }
  st.i++;
  return { kind: 'jump', target, span: spanOfLine(st, line) };
}

function parseReturn(st: ParserState, line: KojoLexLine): KojoReturnStmt | null {
  if (line.kind !== 'dispatch') return null;
  if (st.functionDepth === 0) {
    reportSpan(st, 'core/func/return-outside', '`@返` 只能出现在 `@函` 里（§7.3）。', spanOfLine(st, line));
  }
  const value = line.rest.length > 0 ? makeExpr(st, line.rest, line.restOffset) : undefined;
  st.i++;
  return { kind: 'return', value, span: spanOfLine(st, line) };
}

function parseNativeBlock(st: ParserState, line: KojoLexLine, ctx: CtxBase): KojoNativeBlock | null {
  if (ctx.kind === 'pool') {
    reportSpan(st, 'core/pool/side-effect', '`# 池` 内禁止 `@原生`（§7.1）。', spanOfLine(st, line));
  } else if (ctx.kind === 'template') {
    reportSpan(st, 'core/template/side-effect', '`# 模` 内禁止 `@原生`（§7.2）。', spanOfLine(st, line));
  } else if (ctx.kind === 'color' || ctx.kind === 'random' || ctx.kind === 'group') {
    reportSpan(
      st,
      'core/native/disallowed-location',
      '`@原生` 不能写在 `@着色` / `@随机` 候选 / `@组` 里：会破坏颜色配对或随机落点（§8.5）。',
      spanOfLine(st, line),
    );
  }
  if (!ensureBlockHeaderEmpty(st, line, '原生')) {
    skipLineAndSubtree(st);
    return null;
  }
  const headerIndent = line.indent;
  st.i++;
  const records: KojoNativeRecord[] = [];
  while (st.i < st.lines.length) {
    const child = st.lines[st.i]!;
    if (child.kind !== 'native') break;
    records.push(child);
    st.i++;
  }
  let baseIndent = Number.POSITIVE_INFINITY;
  const included: KojoNativeRecord[] = [];
  for (let i = 0; i < records.length; i++) {
    const child = records[i]!;
    if (child.blank) {
      included.push(child);
      continue;
    }
    if (child.indent < headerIndent + 4) {
      reportSpan(
        st,
        'core/native/indent',
        `\`@原生\` 块体必须比块头深一级（至少 ${headerIndent + 4} 空格），这一行只有 ${child.indent}（§8.5）。`,
        spanOfLine(st, child),
      );
      continue;
    }
    if (child.indent < baseIndent) baseIndent = child.indent;
    included.push(child);
  }
  let hasContent = false;
  for (let i = 0; i < included.length; i++) {
    if (!included[i]!.blank) {
      hasContent = true;
      break;
    }
  }
  if (!hasContent) {
    reportSpan(st, 'core/native/empty', '`@原生` 是空块：逃生舱不能什么都不放（§8.5）。', blockSpan(st, line));
  }
  // 尾部空行只是块与下一行之间的分隔：不进块体（块体内空行照原文保留）
  while (included.length > 0 && included[included.length - 1]!.blank) included.pop();
  const base = baseIndent === Number.POSITIVE_INFINITY ? 0 : baseIndent;
  const lines: string[] = [];
  const lineColumns: number[] = [];
  for (let i = 0; i < included.length; i++) {
    const child = included[i]!;
    if (child.blank) {
      // §8.5「空行原样保留」压过 §C2.10 规则 4「归一为空行」：`@原生` 是字节逃生舱，
      // 纯空白行里的缩进空白也是作者的字节，归一为空行会静默丢字节（硬判据：字节零丢失）。
      // 原文 = 物理行全文（不含 EOL，EOL 由产物侧按 §10.4 统一）；视图文本 = 物理行，
      // 所以起点列只能是 1（折回恒等），纯空白行没有"第一个内容字符"可报。
      lines.push(child.raw);
      lineColumns.push(1);
      continue;
    }
    const dedented = dedentNative(child.raw, base);
    lines.push(dedented.text);
    // `lineColumns[i]` = 去缩进后行首码元在物理行里的 1 基列 = 被剥掉的码元数 + 1
    // （残余的相对缩进仍属于行文本，不另算"内容起点"）。
    lineColumns.push(dedented.removed + 1);
  }
  return { kind: 'nativeBlock', lines, lineColumns, span: blockSpan(st, line) };
}

/**
 * 按**缩进宽度**剥前导空白；返回去缩进文本 + 被剥掉的**码元数**。
 *
 * 尺子与 `kojo-sugar/blank-charset.ts::indentLevelOf` 同一套（core 不能 import 插件包，
 * 单向依赖 ⇒ 这里只复刻**宽度**定义，由测试钉住逐值相等）：半角空格 = 1、Tab = 4、
 * 全角空格 U+3000 = 2，4 宽 = 1 级。`base` 来自 lexer 的 `indentWidth`（只数空格/Tab），
 * 所以全角空格只可能在不再是行首缩进的位置出现：剥到 `base` 即停，绝不把一个字切成两半。
 */
function dedentNative(raw: string, base: number): { readonly text: string; readonly removed: number } {
  let width = 0;
  let i = 0;
  while (i < raw.length) {
    const c = raw.charCodeAt(i);
    if (c === 32) {
      if (width + 1 > base) break;
      width += 1;
      i++;
    } else if (c === 9) {
      if (width + 4 > base) break;
      width += 4;
      i++;
    } else if (c === 0x3000) {
      if (width + 2 > base) break;
      width += 2;
      i++;
    } else break;
  }
  return { text: raw.slice(i), removed: i };
}

/* ============================== 选项（待定 UI） ============================== */

function parseOptionsBlock(st: ParserState, line: KojoLexLine, ctx: CtxBase): KojoOptionsBlock | null {
  if (line.kind !== 'options') {
    st.i++;
    return null;
  }
  if (ctx.kind !== 'top' && ctx.kind !== 'scene') {
    reportSpan(st, 'core/decl/not-top-level', '`选项` 只能写在场景正文顶层，不能嵌套进块里（§7.5）。', spanOfLine(st, line));
    st.i++;
    skipIndentedBody(st, line.indent);
    return null;
  }
  st.optionsCount++;
  reportSpan(st, 'core/options/pending', '`选项` 是 2.0 待定 UI：语法可能变化（§7.5）。', spanOfLine(st, line));
  if (st.optionsCount > 1) {
    reportSpan(
      st,
      'core/options/pending',
      '一个场景最多一个 `选项`；多轮选择请走 `@原生` 或后续 `@选项` 设计（§7.5）。',
      spanOfLine(st, line),
    );
  }
  st.i++;
  const baseIndent = line.indent + 4;
  const items: KojoOptionItem[] = [];
  while (st.i < st.lines.length) {
    const child = st.lines[st.i]!;
    if (child.kind === 'blank') {
      const next = nextNonBlankIndex(st, st.i + 1);
      if (next < 0 || st.lines[next]!.indent < baseIndent) break;
      st.i++;
      continue;
    }
    if (child.kind === 'comment') {
      st.i++;
      continue;
    }
    if (child.indent < baseIndent) break;
    if (child.indent > baseIndent) {
      report(st, 'core/lex/indent', '`选项` 的按钮标签缩进必须恰好比块头深一级。', child.lineOffset, child.contentOffset);
      skipLineAndSubtree(st);
      continue;
    }
    if (child.invalid) {
      skipLineAndSubtree(st);
      continue;
    }
    if (child.kind === 'options') {
      reportSpan(st, 'core/decl/not-top-level', '`选项` 不能嵌套（§7.5）。', spanOfLine(st, child));
      skipLineAndSubtree(st);
      continue;
    }
    if (child.kind !== 'bareQuote' || !child.text.endsWith('：')) {
      reportSpan(
        st,
        'core/lex/anchor',
        '`选项` 内只接受按钮标签 `「标签」：` + 缩进正文（§7.5）。',
        spanOfLine(st, child),
      );
      skipLineAndSubtree(st);
      continue;
    }
    const label = child.body.trim();
    if (label.length === 0) {
      reportSpan(st, 'core/lex/anchor', '按钮标签不能为空：写 `「标签」：`（§7.5）。', spanOfLine(st, child));
    }
    st.i++;
    const body = parseNarrativeBlock(st, baseIndent + 4, { kind: 'option-item', labelsAllowed: false, unitTop: false });
    items.push({ label, body, span: spanOffsets(st, child.contentOffset, consumedEndOffset(st, child.contentEnd)) });
  }
  return { kind: 'optionsBlock', items, span: blockSpan(st, line) };
}

/* ============================== 句子构件 ============================== */

function buildCallStmt(
  st: ParserState,
  line: KojoLexLine,
  body: readonly KojoNarrativeNode[] | undefined,
): KojoCallStmt | null {
  if (line.kind !== 'trigger') return null;
  const args: KojoExprText[] = [];
  for (let i = 0; i < line.args.length; i++) args.push(makeExprFromToken(st, line.args[i]!));
  return { kind: 'call', name: line.name, args, body, span: spanOfLine(st, line) };
}

/**
 * `! 模名(…)` 调用处的缩进块（= 填充模板 `[插槽]` 的正文，§7.2）。
 * 只有紧跟着更深一层的行才认；池 / 函调用带缩进块在收尾校验里报 error。
 */
function parseCallBody(
  st: ParserState,
  header: KojoLexLine,
  ctx: CtxBase,
): readonly KojoNarrativeNode[] | undefined {
  const next = nextNonBlankIndex(st, st.i);
  if (next < 0) return undefined;
  const nextLine = st.lines[next]!;
  if (nextLine.indent <= header.indent) return undefined;
  const baseIndent = header.indent + 4;
  if (nextLine.indent > baseIndent) {
    report(
      st,
      'core/lex/indent',
      `调用处的缩进块必须比调用行深一级（${baseIndent} 空格）。`,
      nextLine.lineOffset,
      nextLine.contentOffset,
    );
    skipIndentedBody(st, header.indent);
    return undefined;
  }
  return parseNarrativeBlock(st, baseIndent, { kind: ctx.kind, labelsAllowed: false, unitTop: false });
}

/* ---- 收尾校验：调用体只能给 `# 模`（池 / 函不带 `[插槽]`，§7.2） ---- */

function validateCallBodies(st: ParserState): void {
  for (let i = 0; i < st.decls.length; i++) {
    const decl = st.decls[i]!;
    switch (decl.kind) {
      case 'function':
        walkDispatchList(st, decl.body);
        break;
      case 'weave':
      case 'template':
        walkNarrativeList(st, decl.body);
        break;
      case 'pool':
        for (let b = 0; b < decl.branches.length; b++) walkNarrativeList(st, decl.branches[b]!.body);
        break;
      default:
        break;
    }
  }
  for (let i = 0; i < st.scenes.length; i++) walkNarrativeList(st, st.scenes[i]!.items);
}

function walkNarrativeList(st: ParserState, nodes: readonly KojoNarrativeNode[]): void {
  for (let i = 0; i < nodes.length; i++) walkNarrativeNode(st, nodes[i]!);
}

function walkNarrativeNode(st: ParserState, node: KojoNarrativeNode): void {
  switch (node.kind) {
    case 'textLine':
    case 'blankLine':
    case 'faceLine':
    case 'nativeBlock':
    case 'label':
    case 'jump':
    case 'loopJump':
      return;
    case 'call':
      checkCallBody(st, node);
      if (node.body !== undefined) walkNarrativeList(st, node.body);
      return;
    case 'conditionChain':
      for (let i = 0; i < node.branches.length; i++) walkNarrativeList(st, node.branches[i]!.body);
      return;
    case 'colorBlock':
      walkNarrativeList(st, node.body);
      return;
    case 'optionsBlock':
      for (let i = 0; i < node.items.length; i++) walkNarrativeList(st, node.items[i]!.body);
      return;
    case 'randomBlock':
      for (let i = 0; i < node.candidates.length; i++) {
        const candidate = node.candidates[i]!;
        if (candidate.kind === 'randomGroup') walkNarrativeList(st, candidate.body);
      }
      return;
    case 'sandboxBlock':
      walkDispatchList(st, node.body);
      return;
    case 'whileLoop':
    case 'repeatLoop':
      walkDispatchList(st, node.body);
      return;
    case 'forEachLoop':
      walkNarrativeList(st, node.body);
      return;
    default:
      return;
  }
}

function walkDispatchList(st: ParserState, nodes: readonly KojoDispatchNode[]): void {
  for (let i = 0; i < nodes.length; i++) walkDispatchNode(st, nodes[i]!);
}

function walkDispatchNode(st: ParserState, node: KojoDispatchNode): void {
  switch (node.kind) {
    case 'assign':
    case 'exprCall':
    case 'label':
    case 'jump':
    case 'loopJump':
    case 'return':
    case 'nativeBlock':
    case 'textLine':
    case 'blankLine':
    case 'faceLine':
      return;
    case 'call':
      checkCallBody(st, node);
      if (node.body !== undefined) walkNarrativeList(st, node.body);
      return;
    case 'dispatchCondition':
      for (let i = 0; i < node.branches.length; i++) walkDispatchList(st, node.branches[i]!.body);
      return;
    case 'sandboxBlock':
    case 'whileLoop':
    case 'repeatLoop':
      walkDispatchList(st, node.body);
      return;
    case 'forEachLoop':
      walkNarrativeList(st, node.body);
      return;
    default:
      return;
  }
}

function checkCallBody(st: ParserState, call: KojoCallStmt): void {
  if (call.body === undefined) return;
  const kind = st.declKinds.get(call.name);
  if (kind === '池' || kind === '函数') {
    reportSpan(
      st,
      'core/template/unexpected-slot',
      `\`! ${call.name}\` 是${kind === '池' ? '池' : '函数'}调用，不带缩进块：缩进块只用来给 \`# 模\` 的 \`[插槽]\` 填内容（§7.2）。`,
      call.span,
    );
  }
}
