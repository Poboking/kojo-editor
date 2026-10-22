/**
 * Kojo 2.0 **符号重命名**（K2-LSP-RENAME）：同文件声明 + 全部可证引用位的 F2 改名。
 *
 * ## 这一层回答什么
 *
 * 源码 + 1 基行列（+ 新名）进：
 * - {@link kojo2PrepareRename}：光标处是不是一个**可改名符号**（`# 变量 / 常量 / 表 / 池 / 模`
 *   与 `@函` 的名字），不是就给一条作者能读懂的拒绝理由；
 * - {@link kojo2RenameAt}：那个符号在**同一份文件**里的全部可证引用位 → `{range, newText}` 编辑集；
 * - {@link validateKojo2RenameName}（任务口径里的 `validateName`）：新名合法性与重名闸。
 *
 * 全是纯函数：零 IO、零 Monaco、零注册。Monaco 协议翻译只在 {@link installKojo2RenameProvider}
 * 这一层，且**只挂 `kojo2`**（v1 的 `.kojo` / `.erb` 面各由 `kojo-rename` / `erb-rename` 负责）。
 *
 * ## 引用面：只收"core AST 亲口认下的表达式位"
 *
 * 引用判据**不自写第二套词法**：声明名区间来自 `kojo2-declarations.ts` 的同一份索引，
 * 表达式位来自 core 的 AST（`KojoExprText`）——`tokenizeExpr` 把每个表达式切片切成 token，
 * 只取 `ident`。于是：
 * - **插值**：台词 / 旁白 / 裸引号 / 转义行里的 `{…}`（`KojoTextPart.kind === 'interp'`，含
 *   `{条件 ? A : B}` 三段）；
 * - **`!` 调用**：`trigger` 词法行给了 `name` + `nameOffset`（池 / 模 / 函三种调用同一形状）；
 * - **`@巡`**：`KojoForEachLoop.collection`（以及 `@复` 次数 / `@循` 条件 / `@返` 值）；
 * - **表判别式引用**：`# 表 … 由 <表达式>` 的 subject、表行的 `from` / `to` 端点（常量）、
 *   赋值 / 裸调用 / 条件链 test 等一切表达式位；
 * - **数组长度**：`# 变量 名 整数[<常量>]` 的 size 表达式（规范 §9.2 允许常量）。
 *
 * 排除面同样是"core 说的"，不是本层猜的：
 * - `@原生` 体内是原始行（AST 里只有 `nativeBlock.lines` 原文），**不产任何引用**；
 * - 字符串字面量：`tokenizeExpr` 把 `"…"` 整枚切成 `string` token，**字面量内容永不进引用集**
 *   （与 core 降糖的 `replaceIdentifiers` 跳过字符串同口径）；
 * - 注释：不在 AST 里；
 * - 表值列：AST 里只有 `KojoTableRow.value`（`KojoLiteral`），不是表达式 ⇒ 值列里恰好与
 *   变量同名的词**不是引用**；
 * - 声明处参数：`# 模` / `@函` 的形参名不是文件符号，且其函数体内同名出现一律按**局部名**
 *   跳过（避免"改全局变量顺手把形参改掉"）；
 * - `@巡` 的六个绑定名（`值 / 下标 / 角 / 名 / 项 / 键`，真源 = core 的
 *   `FOREACH_BINDING_NAMES`）在循环体内遮蔽同名文件变量，同样跳过；
 * - 属性位：`x.长度` 的 `长度`、`{角色}的恋慕` 的 `恋慕` 不是文件符号（token 前一枚是 `.`
 *   或 `的` 即跳过）；
 * - `# 幕` 标题、`# 视` / `# 机` / `@标` / `@跳` 不是本批的可改名符号。
 *
 * ## 全或无（与 v1 rename / code action 同一条纪律）
 *
 * 三条闸，任何一条不过 ⇒ **`edits` 为空**且 `blockers` 说清原因：
 * 1. 新名必须是合法的 2.0 标识符（core `isIdentifier`）且不与既有声明重名（§3.2）；
 * 2. 引用扫描途中任何一枚表达式 `tokenizeExpr` 失败 ⇒ 整次取消（少改一处 = 同名分叉，
 *    比不改更糟；**宁缺勿猜**）；
 * 3. 把编辑应用到自己那份源码上，再用 core `parseSource` 复查：**必须零 error**——
 *    否则说明这次改名把文件改坏了（或文件本来就有语法错），一律不产编辑。
 *
 * ## WorkspaceEdit 只含本文件
 *
 * 2.0 的符号是**文件局部**名字（规范 §7.2 排除跨文件可见）：本通道只往请求的 model 上落编辑。
 * 跨文件 / 项目索引（同名的另一份 `.kojo2`）留给项目索引批，本层不猜、不串道。
 *
 * ## 失败面
 *
 * provider 体内任何抛错都收成"拒绝理由"（Monaco 把 throw 吞成"功能突然没了"，作者看不到
 * 原因）；注册半途抛错原样外抛（只有一枚注册，没有半成品要回滚）；flag 关 ⇒ 立即返回空操作
 * （**零注册**），dispose 幂等且逐枚隔离。
 */
import type * as Monaco from './entry';
import {
  FOREACH_BINDING_NAMES,
  isIdentifier,
  parseSource,
  tokenizeExpr,
  type ExprToken,
  type KojoDecl,
  type KojoDispatchNode,
  type KojoExprText,
  type KojoFile,
  type KojoNarrativeNode,
} from '@kojo/kojo-core';
import { errorText } from '@kojo/plugin-api';
import { KOJO2_LANGUAGE_ID } from './kojo2-constants';
import {
  KOJO2_DECL_WORD_BY_KIND,
  kojo2DeclarationAt,
  kojo2DeclarationHeaderAt,
  kojo2DocumentOf,
  kojo2IsNativeRecord,
  kojo2IsTextSurface,
  kojo2TokenSpanAt,
  type Kojo2Declaration,
  type Kojo2DeclarationKind,
  type Kojo2Document,
} from './kojo2-declarations';
import { isKojo2CutoverEnabled } from '../ui/kojo2-flag';
import { reject } from './rename-rejection';

/* ============================== 公共形状 ============================== */

/** 可改名符号的种类（`# 幕` 标题不是符号：它没有引用面）。 */
export type Kojo2RenameableKind = Exclude<Kojo2DeclarationKind, 'scene'>;

/** 一次请求的位置（1 基行列；与 Monaco / core 同口径） */
export interface Kojo2RenamePosition {
  readonly line: number;
  readonly column: number;
}

/** 一条单行编辑区间（1 基、尾列半开；与 Monaco `IRange` 同口径） */
export interface Kojo2RenameRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** 一条替换：把 `range` 上的原文换成 `newText`。 */
export interface Kojo2RenameEdit {
  readonly range: Kojo2RenameRange;
  readonly newText: string;
}

/** 请求位置上的符号事实（种类文案来自 core 词表，本层不写中文字形）。 */
export interface Kojo2RenameSymbol {
  readonly name: string;
  readonly kind: Kojo2RenameableKind;
  /** 种类词（`变量` / `表` / `函` …；与悬停 / 转定义同一张表） */
  readonly kindLabel: string;
  /** 声明行号（1 基） */
  readonly line: number;
  /** **声明处**名字段区间（不是光标处那枚引用） */
  readonly range: Kojo2RenameRange;
}

/** 一次改名请求的读数；`blockers` 非空 ⇒ `edits` 恒为空（全或无）。 */
export interface Kojo2RenameResult {
  readonly symbol: Kojo2RenameSymbol | null;
  readonly edits: readonly Kojo2RenameEdit[];
  readonly blockers: readonly string[];
}

/** prepare 语义的读数（Monaco `resolveRenameLocation` 的纯模型形态）。 */
export interface Kojo2PrepareResult {
  readonly symbol: Kojo2RenameSymbol | null;
  /** 光标处名字段区间（给输入框初值划选；不在符号上 = `null`） */
  readonly range: Kojo2RenameRange | null;
  readonly blockers: readonly string[];
}

/** 新名校验结果。 */
export type Kojo2NameVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/* ============================== 内部形状 ============================== */

/** 一次"名字出现位"（1 基、尾列半开）。 */
interface Occurrence {
  readonly name: string;
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

interface SymbolEntry {
  readonly declaration: Kojo2Declaration & { readonly kind: Kojo2RenameableKind };
  readonly occurrences: Occurrence[];
}

interface RenameIndex {
  readonly document: Kojo2Document;
  readonly symbols: ReadonlyMap<string, SymbolEntry>;
  /** 出现位 key → 符号名（O(1) 判"光标这枚 token 是不是某个符号的出现位"） */
  readonly byOccurrence: ReadonlyMap<string, string>;
  /** 同名声明（core 已报 `core/decl/duplicate-name`；这里额外记一份，改名一律拒绝） */
  readonly duplicates: ReadonlySet<string>;
  /** 引用扫描中证明不了的表达式（非空 ⇒ 一次都不改） */
  readonly failures: readonly string[];
  /** 整份文件索引失败（极端兜底；`null` = 正常） */
  readonly fatal: string | null;
}

type Locals = ReadonlySet<string>;

const NO_LOCALS: Locals = new Set<string>();

function occurrenceKey(line: number, startColumn: number, endColumn: number): string {
  return `${line}:${startColumn}:${endColumn}`;
}

function rangeOfOccurrence(occurrence: Occurrence): Kojo2RenameRange {
  return {
    startLine: occurrence.line,
    startColumn: occurrence.startColumn,
    endLine: occurrence.line,
    endColumn: occurrence.endColumn,
  };
}

/* ============================== 引用扫描（core AST 当判官） ============================== */

function localsOfParams(params: readonly { readonly name: string }[]): Locals {
  const set = new Set<string>();
  for (const param of params) set.add(param.name);
  return set;
}

/** `@巡` 绑定名（真源 = core；不在这里手抄 `值 / 角 / 键` 等字形）。 */
function withForeachBindings(locals: Locals): Locals {
  const set = new Set<string>(locals);
  for (const name of FOREACH_BINDING_NAMES) set.add(name);
  return set;
}

/**
 * 把一段表达式切片切成 token，收下"名字位"上的 ident（0 基偏移 → 1 基列）。
 *
 * `startColumn` = 切片首字符的 1 基列；切片必须是单行（跨行就说不清坐标，记 failure 不猜）。
 * 跳过前面是 `.`（成员）或 `的`（属性访问）的 ident——那些不是文件符号。
 */
function scanExprText(
  text: string,
  line: number,
  startColumn: number,
  locals: Locals,
  calls: {
    readonly push: (occurrence: Occurrence) => void;
    readonly fail: (reason: string) => void;
  },
): void {
  if (text.length === 0) return;
  if (/[\r\n]/.test(text)) {
    calls.fail(`第 ${line} 行的表达式跨了行，名字坐标不可证（本层只改单行表达式位）`);
    return;
  }
  const tokenized = tokenizeExpr(text);
  if (!tokenized.ok) {
    calls.fail(
      `第 ${line} 行的表达式无法词法化（${tokenized.error.code}），改名会漏引用，已取消`,
    );
    return;
  }
  let previous: ExprToken | undefined;
  for (const token of tokenized.tokens) {
    const before = previous;
    previous = token;
    if (token.kind !== 'ident') continue;
    if (before?.kind === 'dot') continue;
    if (before?.kind === 'ident' && before.text === '的') continue;
    if (locals.has(token.text)) continue;
    calls.push({
      name: token.text,
      line,
      startColumn: startColumn + token.start,
      endColumn: startColumn + token.end,
    });
  }
}

/** `KojoExprText` → 出现位（空表达式直接跳过：AST 用空切片表示"这里没有表达式"）。 */
function scanExpr(
  expr: KojoExprText | null | undefined,
  locals: Locals,
  calls: {
    readonly push: (occurrence: Occurrence) => void;
    readonly fail: (reason: string) => void;
  },
): void {
  if (expr === null || expr === undefined) return;
  scanExprText(expr.text, expr.span.start.line, expr.span.start.column, locals, calls);
}

/**
 * 赋值目标（`KojoAssignTarget`）→ 引用位。
 *
 * 只认三种可证形态（与 core sema 的 `ParsedTarget` 同向）：
 * `名字` / `名字[下标表达式]` / `名字.长度`；`{名字}` 简单名字引用取其花括号里的名字。
 * `{角色}的<属性>` 这类**属性位**不是文件符号 ⇒ 整段不产（宁缺勿猜）。
 */
function scanAssignTarget(
  target: { readonly text: string; readonly span: { readonly start: { readonly line: number; readonly column: number } } },
  locals: Locals,
  calls: {
    readonly push: (occurrence: Occurrence) => void;
    readonly fail: (reason: string) => void;
  },
): void {
  const line = target.span.start.line;
  const base = target.span.start.column;
  const text = target.text;
  const simple = /^([\p{L}_][\p{L}\p{N}_]*)(?:\[([\s\S]*)\]|\.长度)?$/u.exec(text);
  if (simple !== null) {
    const name = simple[1]!;
    if (!locals.has(name)) {
      calls.push({ name, line, startColumn: base, endColumn: base + name.length });
    }
    const indexText = simple[2];
    if (indexText !== undefined) {
      const open = text.indexOf('[');
      scanExprText(indexText, line, base + open + 1, locals, calls);
    }
    return;
  }
  const braced = /^\{\s*([\p{L}_][\p{L}\p{N}_]*)\s*\}$/u.exec(text);
  if (braced !== null) {
    const name = braced[1]!;
    if (!locals.has(name)) {
      const at = text.indexOf(name);
      calls.push({ name, line, startColumn: base + at, endColumn: base + at + name.length });
    }
  }
}

/**
 * 遍历 AST 收全部"可证引用位"（不含声明名；声明由 {@link buildRenameIndex} 从词法索引取）。
 *
 * 为什么用 AST 而不是整行扫标识符：整行扫会把表值列（`0..99 疏远` 的 `疏远`）、台词正文、
 * 形参、循环绑定一起卷进来——那些都不是引用，改了就是改坏作者文本。
 */
function collectReferenceOccurrences(
  file: KojoFile,
  document: Kojo2Document,
  failures: string[],
): Occurrence[] {
  const out: Occurrence[] = [];
  const calls = {
    push: (occurrence: Occurrence): void => {
      out.push(occurrence);
    },
    fail: (reason: string): void => {
      if (!failures.includes(reason)) failures.push(reason);
    },
  };

  const walkNodes = (
    nodes: readonly (KojoNarrativeNode | KojoDispatchNode)[],
    locals: Locals,
  ): void => {
    for (const node of nodes) walkNode(node, locals);
  };

  const walkNarrative = (nodes: readonly KojoNarrativeNode[], locals: Locals): void => {
    walkNodes(nodes, locals);
  };

  const walkNode = (node: KojoNarrativeNode | KojoDispatchNode, locals: Locals): void => {
    switch (node.kind) {
      case 'textLine': {
        for (const part of node.parts) {
          if (part.kind !== 'interp') continue;
          scanExpr(part.expr, locals, calls);
          if (part.cond !== undefined) {
            scanExpr(part.cond.cond, locals, calls);
            scanExpr(part.cond.then, locals, calls);
            scanExpr(part.cond.else, locals, calls);
          }
        }
        return;
      }
      case 'blankLine':
        return;
      case 'conditionChain':
        for (const branch of node.branches) {
          scanExpr(branch.test, locals, calls);
          walkNarrative(branch.body, locals);
        }
        return;
      case 'dispatchCondition':
        for (const branch of node.branches) {
          scanExpr(branch.test, locals, calls);
          walkNodes(branch.body, locals);
        }
        return;
      case 'colorBlock':
        scanExpr(node.color, locals, calls);
        walkNarrative(node.body, locals);
        return;
      case 'randomBlock':
        for (const candidate of node.candidates) {
          if (candidate.kind === 'randomLine') walkNode(candidate.line, locals);
          else walkNarrative(candidate.body, locals);
        }
        return;
      case 'nativeBlock':
        // `@原生` 体内是原始行：整条语言服务退让，一个引用都不产。
        return;
      case 'sandboxBlock':
        walkNodes(node.body, locals);
        return;
      case 'faceLine':
        for (const arg of node.args) scanExpr(arg, locals, calls);
        return;
      case 'optionsBlock':
        for (const item of node.items) walkNarrative(item.body, locals);
        return;
      case 'call':
        for (const arg of node.args) scanExpr(arg, locals, calls);
        return;
      case 'assign':
        scanAssignTarget(node.target, locals, calls);
        scanExpr(node.value, locals, calls);
        return;
      case 'exprCall':
        scanExpr(node.call, locals, calls);
        return;
      case 'return':
        scanExpr(node.value, locals, calls);
        return;
      case 'whileLoop':
        scanExpr(node.test, locals, calls);
        walkNodes(node.body, locals);
        return;
      case 'repeatLoop':
        scanExpr(node.count, locals, calls);
        walkNodes(node.body, locals);
        return;
      case 'forEachLoop':
        scanExpr(node.collection, locals, calls);
        walkNodes(node.body, withForeachBindings(locals));
        return;
      case 'loopJump':
      case 'label':
      case 'jump':
        // `@断 / @续` 没有名字；`@标 / @跳` 是标签命名空间，不是本批的符号。
        return;
      default:
        return;
    }
  };

  const walkDecl = (decl: KojoDecl, locals: Locals): void => {
    switch (decl.kind) {
      case 'var':
        scanExpr(decl.arraySize, locals, calls);
        return;
      case 'const':
        return;
      case 'table':
        scanExpr(decl.subject, locals, calls);
        for (const row of decl.rows) {
          scanExpr(row.from, locals, calls);
          scanExpr(row.to, locals, calls);
        }
        return;
      case 'template':
        walkNarrative(decl.body, localsOfParams(decl.params));
        return;
      case 'function':
        walkNodes(decl.body, localsOfParams(decl.params));
        return;
      case 'pool':
        for (const branch of decl.branches) {
          scanExpr(branch.test, locals, calls);
          walkNarrative(branch.body, locals);
        }
        return;
      case 'weave':
        walkNarrative(decl.body, locals);
        return;
      case 'view':
      case 'machine':
        // 目标 / 事件名是 adapter 事实，不是文件符号。
        return;
      default:
        return;
    }
  };

  for (const decl of file.decls) walkDecl(decl, NO_LOCALS);
  for (const scene of file.scenes) walkNarrative(scene.items, NO_LOCALS);

  // `! 名` 调用名：词法层的 trigger 记录给了精确偏移（池 / 模 / 函同一形状）。
  for (const line of document.lines) {
    if (line.kind !== 'trigger') continue;
    if (line.name.length === 0) continue;
    out.push({
      name: line.name,
      line: line.number,
      startColumn: line.nameOffset - line.lineOffset + 1,
      endColumn: line.nameOffset - line.lineOffset + 1 + line.name.length,
    });
  }

  return out;
}

/* ============================== 索引 ============================== */

function isRenameableDeclaration(
  declaration: Kojo2Declaration,
): declaration is Kojo2Declaration & { readonly kind: Kojo2RenameableKind } {
  return declaration.kind !== 'scene';
}

/** 把出现位收进符号表（同 key 只收一次：AST 与 trigger 两条腿理论上不重叠，仍防一手）。 */
function collectIndexed(
  byOccurrence: Map<string, string>,
  handled: Set<string>,
  candidate: Occurrence,
  entry: SymbolEntry,
): void {
  const key = occurrenceKey(candidate.line, candidate.startColumn, candidate.endColumn);
  if (handled.has(key)) return;
  handled.add(key);
  entry.occurrences.push(candidate);
  byOccurrence.set(key, entry.declaration.name);
}

/**
 * 建一次改名索引（词法声明索引 + core AST 引用面）。
 *
 * 两次 parse（`kojo2DocumentOf` 与 `parseSource`）都是纯函数且编辑器显式动作（F2）才付：
 * 词法索引给名字区间，AST 给"哪些切片真的是表达式"——两边的真源不同，缺一条都不完整。
 */
function buildRenameIndex(source: string): RenameIndex {
  try {
    const document = kojo2DocumentOf(source);
    const file = parseSource(source);
    const symbols = new Map<string, SymbolEntry>();
    const byOccurrence = new Map<string, string>();
    const handled = new Set<string>();
    const duplicates = new Set<string>();

    for (const declaration of document.declarations) {
      if (!isRenameableDeclaration(declaration)) continue;
      let entry = symbols.get(declaration.name);
      if (entry === undefined) {
        entry = { declaration, occurrences: [] };
        symbols.set(declaration.name, entry);
      } else {
        duplicates.add(declaration.name);
      }
      collectIndexed(
        byOccurrence,
        handled,
        {
          name: declaration.name,
          line: declaration.line,
          startColumn: declaration.nameStart,
          endColumn: declaration.nameEnd,
        },
        entry,
      );
    }

    const failures: string[] = [];
    const references = collectReferenceOccurrences(file, document, failures);
    for (const reference of references) {
      const entry = symbols.get(reference.name);
      if (entry === undefined) continue; // 未声明名字 / 域符号 / 形参（已被 locals 挡掉）
      collectIndexed(byOccurrence, handled, reference, entry);
    }

    for (const entry of symbols.values()) {
      entry.occurrences.sort(
        (a, b) =>
          a.line - b.line || a.startColumn - b.startColumn || a.endColumn - b.endColumn,
      );
    }

    return { document, symbols, byOccurrence, duplicates, failures, fatal: null };
  } catch (error: unknown) {
    return {
      document: kojo2DocumentOf(''),
      symbols: new Map<string, SymbolEntry>(),
      byOccurrence: new Map<string, string>(),
      duplicates: new Set<string>(),
      failures: [],
      fatal: `无法建立本文件的符号索引：${errorText(error)}`,
    };
  }
}

/* ============================== 光标定位 ============================== */

type Located =
  | { readonly kind: 'symbol'; readonly name: string; readonly range: Kojo2RenameRange }
  | { readonly kind: 'reject'; readonly reason: string };

function declarationHeaderLabel(declaration: Kojo2Declaration): string {
  const word = KOJO2_DECL_WORD_BY_KIND[declaration.kind];
  return declaration.kind === 'function' ? `@${word}` : `# ${word}`;
}

function declarationRangeOf(declaration: Kojo2Declaration): Kojo2RenameRange {
  return {
    startLine: declaration.line,
    startColumn: declaration.nameStart,
    endLine: declaration.line,
    endColumn: declaration.nameEnd,
  };
}

function symbolOf(entry: SymbolEntry): Kojo2RenameSymbol {
  return {
    name: entry.declaration.name,
    kind: entry.declaration.kind,
    kindLabel: KOJO2_DECL_WORD_BY_KIND[entry.declaration.kind],
    line: entry.declaration.line,
    range: declarationRangeOf(entry.declaration),
  };
}

/**
 * 光标 → 符号（或一条拒绝理由）。
 *
 * 位置门（与悬停 / 转定义同向，但更严——改名会写盘）：
 * `注释` / `@原生` / 旧写法行 / `# 幕` 标题一律不认；台词旁白只认 `{…}` 插值内的名字
 * （由出现位表判，普通文字自然落不进去）；声明头（`# 变量` 词上）指路到名字。
 */
function locate(index: RenameIndex, position: Kojo2RenamePosition): Located {
  const { document } = index;
  const line = Math.trunc(position.line);
  const column = Math.trunc(position.column);
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) {
    return {
      kind: 'reject',
      reason: `光标位置（第 ${position.line} 行第 ${position.column} 列）不是有效坐标`,
    };
  }
  if (line > document.physical.length) {
    return { kind: 'reject', reason: `第 ${line} 行不在本文件里` };
  }
  const record = document.lines[line - 1];
  if (record === undefined) {
    return { kind: 'reject', reason: `第 ${line} 行不在本文件里` };
  }
  if (record.kind === 'comment') {
    return { kind: 'reject', reason: '注释里的文字不是 2.0 符号：改名不会动注释' };
  }
  if (kojo2IsNativeRecord(record)) {
    return {
      kind: 'reject',
      reason: '`@原生` 体内的行原样透传给生成物，不是 2.0 符号（改名无从谈起）',
    };
  }
  if (record.kind === 'legacy') {
    return {
      kind: 'reject',
      reason: '旧写法行（§12.1）不是 2.0 符号：先在 2.0 语法上重写这一行',
    };
  }
  if (record.kind === 'blank') {
    return { kind: 'reject', reason: '空行上没有可改名的符号' };
  }
  if (record.kind === 'blankLine') {
    return { kind: 'reject', reason: '`空行` 语句没有名字' };
  }

  const text = document.physical[line - 1]?.text ?? '';
  const col0 = Math.min(Math.max(column - 1, 0), text.length);

  const atDeclaration = kojo2DeclarationAt(document, line, col0);
  if (atDeclaration !== undefined && atDeclaration.kind === 'scene') {
    return {
      kind: 'reject',
      reason: '`# 幕` 的标题不是可改名符号（本批只支持变量 / 常量 / 表 / 池 / 模 / 函）',
    };
  }
  const header = kojo2DeclarationHeaderAt(document, line, col0);
  if (header !== undefined) {
    if (header.kind === 'scene') {
      return {
        kind: 'reject',
        reason: '`# 幕` 的标题不是可改名符号（本批只支持变量 / 常量 / 表 / 池 / 模 / 函）',
      };
    }
    return {
      kind: 'reject',
      reason: `光标在声明头（\`${declarationHeaderLabel(header)}\`）上：把光标移到名字「${header.name}」上再按 F2`,
    };
  }

  const token = kojo2TokenSpanAt(text, col0);
  if (token === null) {
    return { kind: 'reject', reason: '光标不在名字上（这里没有可改名的符号）' };
  }
  const range: Kojo2RenameRange = {
    startLine: line,
    startColumn: token.start + 1,
    endLine: line,
    endColumn: token.end + 1,
  };
  const name = index.byOccurrence.get(occurrenceKey(line, token.start + 1, token.end + 1));
  if (name !== undefined) return { kind: 'symbol', name, range };

  if (kojo2IsTextSurface(record)) {
    return {
      kind: 'reject',
      reason:
        '台词 / 旁白里的普通文字不是符号：只有 `{…}` 插值里的已声明名字才能改名',
    };
  }
  if (index.symbols.has(token.text)) {
    return {
      kind: 'reject',
      reason: `「${token.text}」在这里不是可证引用位（字符串 / 属性名 / 表值列等不参与改名）`,
    };
  }
  return {
    kind: 'reject',
    reason: `「${token.text}」不是本文件声明的符号（改名只支持同文件声明）`,
  };
}

/* ============================== 新名校验 ============================== */

/**
 * 新名闸：core `isIdentifier` + 与既有声明重名（§3.2）。
 *
 * 只做这两条是刻意的：更细的语义（类型 / 只读 / 域符号冲突）由 core 的 `parse` 与编译器
 * 报，改名这一层不替作者做产品决策。
 */
export function validateKojo2RenameName(
  source: string,
  newName: string,
): Kojo2NameVerdict {
  let document: Kojo2Document;
  try {
    document = kojo2DocumentOf(source);
  } catch (error: unknown) {
    return { ok: false, reason: `无法读取本文件的声明（${errorText(error)}），新名校验不成立` };
  }
  return validateNameAgainst(document, newName);
}

/** 任务口径里的 `validateName`：与 {@link validateKojo2RenameName} 同一枚（别名只为名字对得上）。 */
export const validateName: (source: string, newName: string) => Kojo2NameVerdict =
  validateKojo2RenameName;

function validateNameAgainst(document: Kojo2Document, newName: string): Kojo2NameVerdict {
  if (newName.length === 0) {
    return { ok: false, reason: '新名不能为空' };
  }
  if (!isIdentifier(newName)) {
    return {
      ok: false,
      reason: `「${newName}」不是合法的 2.0 名字：须以字母 / 下划线 / 汉字开头，后续可含数字（§3.2）`,
    };
  }
  for (const declaration of document.declarations) {
    if (declaration.kind === 'scene') continue;
    if (declaration.name === newName) {
      return {
        ok: false,
        reason: `「${newName}」已在本文件声明过（§3.2 一个文件里名字不能重名，改名会让新旧名分叉）`,
      };
    }
  }
  return { ok: true };
}

/* ============================== 应用编辑（复查 + 预览共用） ============================== */

interface SourceLines {
  readonly lines: string[];
  readonly eols: string[];
}

/** 切行并记住每行原 EOL（CRLF / LF / 裸 CR 逐字还原——改名不许顺手归一化换行）。 */
function splitSourceLines(source: string): SourceLines {
  const lines: string[] = [];
  const eols: string[] = [];
  const eolRe = /\r\n|\r|\n/g;
  let last = 0;
  for (let match = eolRe.exec(source); match !== null; match = eolRe.exec(source)) {
    lines.push(source.slice(last, match.index));
    eols.push(match[0]);
    last = match.index + match[0].length;
  }
  lines.push(source.slice(last));
  eols.push('');
  return { lines, eols };
}

/**
 * 把编辑集应用到源码上（**导出仅为可单测 / 宿主预览**：真壳落地仍由 Monaco 的 WorkspaceEdit
 * 完成——本层不写第二个编辑应用机制）。
 */
export function kojo2RenamedSource(
  source: string,
  edits: readonly Kojo2RenameEdit[],
): string {
  const { lines, eols } = splitSourceLines(source);
  const byLine = new Map<number, Kojo2RenameEdit[]>();
  for (const edit of edits) {
    if (edit.range.startLine !== edit.range.endLine) continue; // 本层只产单行编辑
    const bucket = byLine.get(edit.range.startLine);
    if (bucket === undefined) byLine.set(edit.range.startLine, [edit]);
    else bucket.push(edit);
  }
  for (const [line, bucket] of byLine) {
    const index = line - 1;
    const current = lines[index];
    if (current === undefined) continue;
    let next = current;
    // 同一行多处：**从右往左**应用，先应用的替换不移动后面的原始列。
    for (const edit of [...bucket].sort((a, b) => b.range.startColumn - a.range.startColumn)) {
      const start = Math.max(0, edit.range.startColumn - 1);
      const end = Math.max(start, edit.range.endColumn - 1);
      if (start > next.length || end > next.length) continue;
      next = next.slice(0, start) + edit.newText + next.slice(end);
    }
    lines[index] = next;
  }
  let out = '';
  for (let i = 0; i < lines.length; i += 1) out += `${lines[i] ?? ''}${eols[i] ?? ''}`;
  return out;
}

/** 应用后的解析错误（`null` = 解析器抛错，产物不可用）。 */
function postRenameErrors(source: string): readonly string[] | null {
  try {
    const file = parseSource(source);
    return file.diagnostics
      .filter((diagnostic) => diagnostic.severity === 'error')
      .map((diagnostic) => diagnostic.message);
  } catch {
    return null;
  }
}

/* ============================== 主入口 ============================== */

/** prepare 语义：光标处能不能改名、改的是谁、为什么不能。 */
export function kojo2PrepareRename(
  source: string,
  position: Kojo2RenamePosition,
): Kojo2PrepareResult {
  const index = buildRenameIndex(source);
  if (index.fatal !== null) return { symbol: null, range: null, blockers: [index.fatal] };
  const located = locate(index, position);
  if (located.kind === 'reject') return { symbol: null, range: null, blockers: [located.reason] };
  const entry = index.symbols.get(located.name);
  if (entry === undefined) {
    return {
      symbol: null,
      range: null,
      blockers: [`「${located.name}」没有可用的声明事实（索引失效）`],
    };
  }
  // 同名声明（core 已报 `core/decl/duplicate-name`）：prepare 就拒绝，不弹输入框让作者白打一遍。
  if (index.duplicates.has(located.name)) {
    return {
      symbol: symbolOf(entry),
      range: located.range,
      blockers: [`本文件有同名声明（core 已报 \`core/decl/duplicate-name\`），「${located.name}」改名会串道`],
    };
  }
  return { symbol: symbolOf(entry), range: located.range, blockers: [] };
}

/**
 * 一次改名（纯函数）：符号 + 全部可证引用位 → `{range, newText}` 编辑集。
 *
 * `newName` 是 F2 输入框里的产物名；`blockers` 非空即**一条编辑都不产**（全或无，见模块头）。
 */
export function kojo2RenameAt(
  source: string,
  position: Kojo2RenamePosition,
  newName: string,
): Kojo2RenameResult {
  const index = buildRenameIndex(source);
  if (index.fatal !== null) return { symbol: null, edits: [], blockers: [index.fatal] };
  const located = locate(index, position);
  if (located.kind === 'reject') {
    return { symbol: null, edits: [], blockers: [located.reason] };
  }
  const entry = index.symbols.get(located.name);
  if (entry === undefined) {
    return {
      symbol: null,
      edits: [],
      blockers: [`「${located.name}」没有可用的声明事实（索引失效）`],
    };
  }
  const symbol = symbolOf(entry);
  const blockers: string[] = [];

  if (index.duplicates.has(located.name)) {
    blockers.push(
      `本文件有同名声明（core 已报 \`core/decl/duplicate-name\`）：「${located.name}」改名会串道，已取消`,
    );
  }
  if (newName === symbol.name) {
    blockers.push('新名与原名相同（无需改名）');
  } else {
    const verdict = validateNameAgainst(index.document, newName);
    if (!verdict.ok) blockers.push(verdict.reason);
  }
  for (const failure of index.failures) blockers.push(failure);
  if (blockers.length > 0) return { symbol, edits: [], blockers };

  const edits: Kojo2RenameEdit[] = entry.occurrences.map((occurrence) => ({
    range: rangeOfOccurrence(occurrence),
    newText: newName,
  }));

  // 收口：把编辑应用到源码上，再用 core `parseSource` 复查（**必须零 error**）。
  const renamed = kojo2RenamedSource(source, edits);
  const errors = postRenameErrors(renamed);
  if (errors === null) {
    return {
      symbol,
      edits: [],
      blockers: ['改名后的源码无法解析（core parseSource 抛错），已取消'],
    };
  }
  if (errors.length > 0) {
    return {
      symbol,
      edits: [],
      blockers: [
        `改名后的源码还有 ${errors.length} 处解析错误（第一处：${errors[0] ?? ''}），已取消——` +
          '按 core `parseSource` 零 error 才落地（§3.2）',
      ],
    };
  }

  return { symbol, edits, blockers: [] };
}

/* ============================== Monaco 翻译层 ============================== */

/** flag 关时交回的句柄（调用方照常 `dispose()`，什么也不会发生） */
const NOOP_DISPOSABLE: Monaco.IDisposable = { dispose: () => undefined };

/** 零宽区间（拒绝时 Monaco 要一枚 range 才肯显示理由；不选中任何文字）。 */
function zeroRange(line: number, column: number): Monaco.IRange {
  return {
    startLineNumber: line,
    startColumn: column,
    endLineNumber: line,
    endColumn: column,
  };
}

function toMonacoRange(range: Kojo2RenameRange): Monaco.IRange {
  return {
    startLineNumber: range.startLine,
    startColumn: range.startColumn,
    endLineNumber: range.endLine,
    endColumn: range.endColumn,
  };
}

function prepareRejection(position: Monaco.Position, reason: string): Monaco.languages.RenameLocation & Monaco.languages.Rejection {
  return {
    range: zeroRange(position.lineNumber, position.column),
    text: '',
    rejectReason: reason,
  };
}

/** 模型上的静态闸：只读 / 已释放的 model 不是作者源文（预览 / 生成面）——一律不改。 */
function modelRefusal(model: Monaco.editor.ITextModel): string | null {
  try {
    if (typeof model.isDisposed === 'function' && model.isDisposed()) {
      return '模型已释放，改名取消';
    }
    // Monaco 0.57 的 `ITextModel` 没有 `isReadOnly`：只读事实住在 `getOptions().readOnly`。
    const getOptions = (
      model as unknown as { getOptions?: () => { readonly readOnly?: boolean } | undefined }
    ).getOptions;
    if (typeof getOptions === 'function') {
      const options = getOptions.call(model);
      if (options?.readOnly === true) {
        return '这是只读模型（预览 / 生成面）：生成行不能改名，请回到源文件';
      }
    }
  } catch {
    return '读不到模型状态，改名取消';
  }
  return null;
}

function sourceOfModel(model: Monaco.editor.ITextModel): string | null {
  try {
    const source = model.getValue();
    return typeof source === 'string' ? source : null;
  } catch {
    return null;
  }
}

/**
 * 为 `kojo2` 语言注册 RenameProvider（**只此一枚**），返回**幂等** disposable。
 *
 * - flag 关 ⇒ 空操作（**零注册**）；
 * - selector 只有 `KOJO2_LANGUAGE_ID`：v1 `.kojo` 的 F2 由 `kojo-rename` 另挂，两边不重叠；
 * - `resolveRenameLocation` 在任何拒绝路径上都给 `rejectReason`（Monaco 0.57 见理由就丢弃
 *   输入框并就近提示——作者看得到"为什么不能改"）；
 * - `provideRenameEdits` 只产**本 model** 的 `IWorkspaceTextEdit`（跨文件留给项目索引批）；
 * - provider 体内任何抛错都退成拒绝理由，绝不把 throw 甩进 Monaco。
 */
export function installKojo2RenameProvider(
  monaco: typeof Monaco,
): Monaco.IDisposable {
  if (!isKojo2CutoverEnabled()) return NOOP_DISPOSABLE;

  const provider: Monaco.languages.RenameProvider = {
    resolveRenameLocation(model, position) {
      const refusal = modelRefusal(model);
      if (refusal !== null) return prepareRejection(position, refusal);
      const source = sourceOfModel(model);
      if (source === null) return prepareRejection(position, '取不到这份文件的内容，改名取消');
      try {
        const prepared = kojo2PrepareRename(source, {
          line: position.lineNumber,
          column: position.column,
        });
        if (prepared.blockers.length > 0) {
          return prepareRejection(position, prepared.blockers[0]!);
        }
        if (prepared.symbol === null || prepared.range === null) {
          return prepareRejection(position, '这里没有可改名的符号');
        }
        return { range: toMonacoRange(prepared.range), text: prepared.symbol.name };
      } catch (error: unknown) {
        console.warn(`[kojo2-rename] prepare 抛错：${errorText(error)}`);
        return prepareRejection(position, `解析改名位置失败：${errorText(error)}`);
      }
    },

    provideRenameEdits(model, position, newName) {
      const refusal = modelRefusal(model);
      if (refusal !== null) return reject(refusal);
      const source = sourceOfModel(model);
      if (source === null) return reject('取不到这份文件的内容，改名取消');
      try {
        const result = kojo2RenameAt(
          source,
          { line: position.lineNumber, column: position.column },
          newName,
        );
        if (result.symbol === null) {
          return reject(result.blockers[0] ?? '这里没有可改名的符号');
        }
        if (result.blockers.length > 0) {
          return reject(result.blockers.join('\n'));
        }
        if (result.edits.length === 0) {
          return reject('没有可落地的编辑（引用集为空），改名取消');
        }
        const uri = (model as unknown as { uri?: Monaco.Uri }).uri;
        if (uri === undefined || uri === null) {
          return reject('这份文件没有 URI，无法构造 WorkspaceEdit');
        }
        return {
          edits: result.edits.map((edit) => ({
            resource: uri,
            versionId: undefined,
            textEdit: { range: toMonacoRange(edit.range), text: edit.newText },
          })),
        };
      } catch (error: unknown) {
        console.warn(`[kojo2-rename] 落地失败：${errorText(error)}`);
        return reject(`重命名失败：${errorText(error)}`);
      }
    },
  };

  const registration = monaco.languages.registerRenameProvider(KOJO2_LANGUAGE_ID, provider);

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        registration.dispose();
      } catch {
        /* 幂等 + 不抛：一枚撤不掉不许把卸载链带崩 */
      }
    },
  };
}
