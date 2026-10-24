/**
 * Kojo 2.0 **签名帮助**（K2-LSP-SIGNATURE）：调用位 / 声明头的形参提示，外加 `@巡` 集合名。
 *
 * ## 分层
 * 本文件是**纯函数**：源码文本 + 1 基行列进，签名事实出；零 IO、零 Monaco 注册。
 * 声明事实取自 `kojo2-declarations.ts` 的同一份索引（`# 模` / `@函` 的形参与默认值不另写
 * 第二份行内解析）；`@巡` 的集合语义**整条走 core 的 `planForEachLoop`**——哪几个绑定名合法、
 * 集合声明是否自洽、数组事实够不够，都由 core 那一份唯一真源回答，本文件只把计划翻成提示。
 * Monaco 翻译在 {@link toMonacoSignatureHelp} / {@link installKojo2SignatureHelpProvider}。
 *
 * ## 覆盖面（与任务书对齐）
 * 1. **调用位**：`! 函名(` / `! 模名(`（`@函` / `# 模` 声明头同样走这一条），以及表达式位置
 *    的裸调用 `名(`。被调名必须解析到**同文件**声明；嵌套调用取**最内层**未闭合括号。
 * 2. **声明头**：光标在 `# 模 名(…)` / `@函 名(…)` 的括号里 ⇒ 用该声明自己的形参。`@函`
 *    形参的默认值原样进参数标签（`数值 = 10`，来自声明索引的同一份事实）；`# 模` 的形参按
 *    core 语法**只写名字**（`parseTemplateDecl` 明确拒绝模板参数默认值），所以这里也不编造
 *    默认值。
 * 3. **`@巡` 集合名**：光标在 `@巡 <集合>` 的集合名上 ⇒ 提示该集合实际提供的绑定名
 *    （数组 `{值}`/`{下标}`、角色集合 `{角}`/`{名}`、键值集合 `{项}`/`{键}`），每个绑定的
 *    来源槽与静态类型写进 `documentation`。集合是否声明、绑定子集是否合法全部由 core 的
 *    `planForEachLoop` 判定。
 *
 * ## 「未知形参不猜」
 * - 被调名不在同文件声明索引里 ⇒ `null`（不造 ARG 兜底名、不按参数个数猜）；
 * - 被调名解析到池 / 表 / 变量等**没有形参**的声明 ⇒ `null`（池调用本来就无括号）；
 * - 声明头括号未闭合（正在敲、AST 还没有形参）⇒ `null`（宁可暂时不提示，也不给一个假的
 *   零形参签名）；
 * - `@巡` 集合未声明 / adapter 不给 `foreachCollections` / `programFeatures.foreach` 明确关闭 /
 *   声明自相矛盾（core 计划失败）⇒ `null`；
 * - 字符串字面量里 / `@原生` 体内 / 注释行 / 台词正文里 ⇒ `null`；`{…}` 插值内是表达式，
 *   照常应答。
 *
 * ## activeParameter 口径
 * 从**最内层未闭合左括号**之后数到光标，只数**顶层**逗号：字符串（`"…"`）里的逗号不数，
 * 嵌套 `()` / `[]` 里的逗号不数。落到第几个实参就高亮第几个形参；实参超出形参个数时夹到
 * **最后一个形参**（与 v1 的 `describeCallSignature` 同一口径，不假造第 N 槽）。声明头里
 * 数的是"第几个形参位置"，语义完全相同。
 *
 * ## 失败面
 * 纯函数整体包一层 try/catch：任何意外都回 `null`（编辑器的参数提示消失，但绝不把异常抛进
 * Monaco 的击键路径）；provider 层再兜一层，取文失败 / 声明索引抛错同样回 `undefined`。
 */

import type * as Monaco from './entry';
import {
  KOJO_DISPATCH_WORDS,
  planForEachLoop,
  splitSpaces,
  type ForeachArrayFact,
  type ForeachBindingSource,
  type GameAdapter,
  type KojoDispatchRecord,
  type KojoForEachLoop,
  type KojoLexLine,
  type KojoValueType,
} from '@kojo/kojo-core';
import { KOJO2_LANGUAGE_ID } from './kojo2-language';
import { isKojo2CutoverEnabled } from '../ui/kojo2-flag';
import {
  kojo2DeclarationNamed,
  kojo2DocumentOf,
  kojo2IsCodeSurface,
  kojo2IsNativeRecord,
  kojo2IsTextSurface,
  kojo2TypeWordOf,
  type Kojo2Declaration,
  type Kojo2Document,
} from '@kojo/kojo-lang';

/* ============================== 对外形状 ============================== */

/** 一个形参的提示（`label` 必须与 `Kojo2Signature.label` 里的片段**逐字一致**，Monaco 才能
 * 用参数标签在整条签名串上做定位高亮）。 */
export interface Kojo2SignatureParam {
  readonly label: string;
  /** 事实性说明（默认值 / 必填 / 模板引用形态 / `@巡` 绑定来源槽）；没有事实就不写。 */
  readonly documentation?: string;
}

/** 一条签名（`activeParameter` 跟着签名走：本层只有一条候选，值就是实参位）。 */
export interface Kojo2Signature {
  readonly label: string;
  readonly params: readonly Kojo2SignatureParam[];
  readonly activeParameter: number;
}

/** 一次签名帮助的结果（`activeSignature` 恒 0：同文件名字不重载）。 */
export interface Kojo2SignatureHelpResult {
  readonly signatures: readonly Kojo2Signature[];
  readonly activeSignature: number;
}

/** 查询位置：**1 基**行、**1 基**列（与 Monaco / core / plugin-api 同口径）。 */
export interface Kojo2SignaturePosition {
  readonly line: number;
  readonly column: number;
}

/**
 * 纯模型的可选注入面。`@巡` 是唯一需要游戏知识的格子：集合声明住在 adapter
 * （`foreachCollections`），没有 adapter ⇒ `@巡` 一律不应答（不猜集合）。
 */
export interface Kojo2SignatureOptions {
  readonly adapter?: GameAdapter | null;
}

/** adapter 注入面：直接给一枚，或给 getter 让宿主**请求时现取**（项目可开可关）。 */
export type Kojo2SignatureAdapterSource =
  | GameAdapter
  | null
  | undefined
  | (() => GameAdapter | null | undefined);

/** 安装器的注入面（生产走缺省；测试注入假 adapter / 追加触发字符）。 */
export interface Kojo2SignatureProviderOptions {
  readonly adapter?: Kojo2SignatureAdapterSource;
  /**
   * 既有触发字符清单（additive）：与 {@link KOJO2_SIGNATURE_TRIGGER_CHARS} **合并去重**后
   * 再挂给 provider。同语言多枚 provider 时 Monaco 自己也会并集触发字符，这一格只是把
   * "合并去重"做成可单测的纯函数，不依赖 Monaco 的内部顺序。
   */
  readonly extraTriggerCharacters?: readonly string[];
}

/* ============================== 常量 ============================== */

/**
 * 签名帮助触发字符（自定并说明）：
 * - `(` —— 刚进调用括号，作者正要填第一个形参；
 * - `,` —— 换到下一个形参（**仅半角**：2.0 的实参分隔符是半角逗号，全角 `，` 不是分隔符）。
 *
 * 不列 `)`：右括号意味着这次调用写完了，提示该收而不是该留。
 */
export const KOJO2_SIGNATURE_TRIGGER_CHARS: readonly string[] = Object.freeze(['(', ',']);

/** `@巡` 在调度词表里的位序（`tokens.ts` §2.1；只取位序，不写字形）。 */
const FOREACH_WORD = KOJO_DISPATCH_WORDS[7];

/** 跨行调用回看的行数上限：签名帮助在**每次击键**上同步应答，回看必须封顶。 */
const KOJO2_SIGNATURE_LOOKBACK_LINES = 64;

/** `@巡` 绑定来源 → 提示文案（来源是 core 的事实枚举，不是本层发明的分类）。 */
const BINDING_SOURCE_WORDS: Readonly<Record<ForeachBindingSource, string>> = Object.freeze({
  index: '下标',
  element: '元素',
  key: '键',
  name: '名字',
});

/** flag 关时交回的句柄（调用方照常 `dispose()`，什么也不会发生） */
const NOOP_DISPOSABLE: Monaco.IDisposable = { dispose: () => undefined };

/* ============================== 小工具（全部不抛） ============================== */

/** 某一行原文（越界 = 空串）。 */
function lineTextOf(document: Kojo2Document, line: number): string {
  return document.physical[line - 1]?.text ?? '';
}

/**
 * 光标向左最近的插值起点：返回 `{` 的 0 基下标；不在插值里（先遇 `}` 或什么都没有）⇒ `-1`。
 * 与 `kojo-completion-position.insideInterpolation` 同一判据，只是这里要那个下标的实际位置。
 */
function interpolationBraceBefore(text: string, col0: number): number {
  for (let i = Math.min(col0, text.length) - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === '}') return -1;
    if (ch === '{') return i;
  }
  return -1;
}

/**
 * 光标是否落在**字符串 / 注释**里（`from` 起算；引号配平后第一个 `;` 起至行尾）。
 * 台词行只从 `{` 之后算——台词正文里的引号不是 2.0 字符串。
 */
function insideStringOrCommentFrom(text: string, from: number, col0: number): boolean {
  let inString = false;
  const stop = Math.min(col0, text.length);
  for (let i = Math.max(0, from); i < stop; i++) {
    const ch = text[i]!;
    if (ch === '"') inString = !inString;
    else if (!inString && ch === ';') return true;
  }
  return inString;
}

/**
 * 单行括号净增量（`(` - `)`；字符串感知、引号外 `;` 起注释截断）。
 * **只数圆括号**：方括号的未闭合不影响"调用括号在哪一行开"，多收一行无害、少收一行会丢调用。
 */
function parenDeltaOfLine(record: KojoLexLine | undefined, text: string): number {
  if (record === undefined || !kojo2IsCodeSurface(record)) return 0;
  let delta = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === ';') break;
    if (ch === '(') delta++;
    else if (ch === ')') delta--;
  }
  return delta;
}

/** 跨行回看起点（0 基行下标）：向上收未闭合括号直到"关多"行或窗口上限。 */
function lookbackStart(document: Kojo2Document, lineIndex: number): number {
  let start = lineIndex;
  let depth = 0;
  for (let k = lineIndex - 1; k >= 0 && lineIndex - k <= KOJO2_SIGNATURE_LOOKBACK_LINES; k--) {
    depth += parenDeltaOfLine(document.lines[k], lineTextOf(document, k + 1));
    if (depth < 0) {
      start = k + 1; // 关多：这枚闭合属于别的调用，起点在它之后
      break;
    }
    start = k; // 平衡 / 正值都收进来（平衡行深度不变，拼进来无害）
  }
  return start;
}

/** 一个未闭合左括号的位置（1 基行 + 行内 0 基列）。 */
interface OpenParen {
  readonly line: number;
  readonly col: number;
}

/**
 * 光标前**最内层**未闭合左括号（纯文本扫描；字符串 / 注释 / `@原生` / 台词正文不参与）。
 *
 * 向上回看只跨**代码面**行：台词 / 旁白 / 注释 / `@原生` 行对括号深度贡献 0——它们里面的
 * 半角括号不能把一次真实调用"接"到自己身上。当前行是台词时只在 `{…}` 插值内扫（那是表达式）。
 */
function innermostOpenParen(
  document: Kojo2Document,
  lineIndex: number,
  col0: number,
): OpenParen | null {
  const start = lookbackStart(document, lineIndex);
  const stack: OpenParen[] = [];
  for (let index = start; index <= lineIndex; index++) {
    const record = document.lines[index];
    if (record === undefined) continue;
    const text = lineTextOf(document, index + 1);
    const isCursorLine = index === lineIndex;
    let from = 0;
    const to = isCursorLine ? Math.min(col0, text.length) : text.length;
    if (!kojo2IsCodeSurface(record)) {
      // 只有光标行的 `{…}` 插值是表达式位；其余（台词正文 / 原生 / 注释）不参与。
      if (!isCursorLine || !kojo2IsTextSurface(record)) continue;
      const brace = interpolationBraceBefore(text, col0);
      if (brace < 0) continue;
      from = brace + 1;
    }
    let inString = false;
    for (let i = from; i < to; i++) {
      const ch = text[i]!;
      if (inString) {
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === ';') break;
      if (ch === '(') stack.push({ line: index + 1, col: i });
      else if (ch === ')') stack.pop();
    }
  }
  return stack[stack.length - 1] ?? null;
}

/**
 * 从 `open` 之后数到光标处的**顶层逗号**个数（= activeParameter）。
 *
 * 字符串里的逗号不数，嵌套 `()` / `[]` 里的逗号不数；注释（`;` 起）截断。跨行调用按行推进，
 * 字符串态每行重置（2.0 字符串不跨行）。顶层遇到右括号 = 这个括号其实已经关了，立即收手。
 */
function topLevelCommas(
  document: Kojo2Document,
  openLine: number,
  openCol: number,
  cursorLine: number,
  cursorCol: number,
): number {
  let depth = 0;
  let commas = 0;
  for (let line = openLine; line <= cursorLine; line++) {
    const record = document.lines[line - 1];
    if (record === undefined) continue;
    const text = lineTextOf(document, line);
    const isLast = line === cursorLine;
    if (!kojo2IsCodeSurface(record) && !(isLast && kojo2IsTextSurface(record))) continue;
    const from = line === openLine ? openCol + 1 : 0;
    const to = isLast ? Math.min(cursorCol, text.length) : text.length;
    let inString = false;
    for (let i = from; i < to; i++) {
      const ch = text[i]!;
      if (inString) {
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === ';') break;
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') {
        if (depth === 0) return commas;
        depth--;
      } else if (depth === 0 && ch === ',') commas++;
    }
  }
  return commas;
}

/**
 * 左括号是否在同一行里被顶层 `)` 关上（字符串感知、`;` 注释截断）。
 * 声明头专用：括号没闭合时 parser 还没给出形参，**不知道就不提示**。
 */
function hasClosingParen(text: string, openCol: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = openCol; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === ';') return false;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return true;
    }
  }
  return false;
}

/**
 * 左括号之前的被调名（行内最后一段名字字符）：`! 函名(` / `@函 函名(` / `# 模 模名(` /
 * 表达式位裸调用 `函名(` 都归一到同一枚名字。括号前没有名字（`(1, 2)(`）⇒ `null`。
 */
const CALLEE_TOKEN_RE = /([^\s(),;\[\]{}"'!@#]+)$/u;

function calleeBefore(text: string, openCol: number): string | null {
  const match = CALLEE_TOKEN_RE.exec(text.slice(0, openCol));
  const name = match?.[1]?.trim() ?? '';
  return name.length > 0 ? name : null;
}

/** `activeParameter` 夹到最后一个形参；零形参恒 0（Monaco 越过只渲染成"无高亮"）。 */
function clampActiveParameter(index: number, paramCount: number): number {
  if (paramCount <= 0) return 0;
  return Math.min(Math.max(0, index), paramCount - 1);
}

/* ============================== 声明签名 ============================== */

/** 形参事实 → 提示参数（`label` 是声明索引里的原文，默认值随标签一起显示）。 */
function paramInfoOf(label: string, kind: 'function' | 'template'): Kojo2SignatureParam {
  if (kind === 'template') {
    return { label, documentation: `模板参数：正文里写 {${label}} 引用` };
  }
  const eq = label.indexOf(' = ');
  if (eq >= 0) return { label, documentation: `默认值：${label.slice(eq + 3)}` };
  return { label, documentation: '必填' };
}

/**
 * 声明的**声明头**形参是否已经被 parser 完整收下（括号闭合）。
 * 未闭合 ⇒ parser 的 `params` 是空数组但真实形参未知：不提示（不假造零形参签名）。
 */
function declarationHeaderComplete(
  document: Kojo2Document,
  declaration: Kojo2Declaration,
): boolean {
  const header = lineTextOf(document, declaration.line);
  const open = header.indexOf('(');
  if (open < 0) return true; // 无括号 ⇒ 合法零形参声明
  return hasClosingParen(header, open);
}

/** `# 模` / `@函` 声明 → 签名（形参原文 + 当前第几个 + 默认值说明）。 */
function signatureOfDeclaration(
  document: Kojo2Document,
  declaration: Kojo2Declaration,
  activeParameter: number,
): Kojo2SignatureHelpResult | null {
  const kind = declaration.kind;
  if (kind !== 'function' && kind !== 'template') return null;
  if (!declarationHeaderComplete(document, declaration)) return null;
  const params = (declaration.params ?? []).map((label) => paramInfoOf(label, kind));
  return {
    signatures: [
      {
        label: `${declaration.name}(${params.map((param) => param.label).join(', ')})`,
        params,
        activeParameter: clampActiveParameter(activeParameter, params.length),
      },
    ],
    activeSignature: 0,
  };
}

/* ============================== `@巡` 集合签名 ============================== */

/** 数组长度事实：十进制整数，或同文件 `# 常量` 的整数值（与 core `resolveArraySize` 同口径）。 */
const DECIMAL_SIZE_RE = /^\d+$/u;

function resolveArraySize(
  text: string,
  constants: ReadonlyMap<string, number>,
): number | null {
  const raw = text.trim();
  if (DECIMAL_SIZE_RE.test(raw)) {
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  }
  return constants.get(raw) ?? null;
}

/**
 * 本文件的可遍历数组事实（`# 变量 名 <类型>[N]`；N 可以是同文件整数常量）。
 * 读不到长度 / 没写元素类型的声明不进表——core 的 `@巡` 会按"数组未声明"报错，
 * 本层也就不给签名（不猜）。
 */
function foreachArrayFactsOf(document: Kojo2Document): readonly ForeachArrayFact[] {
  const constants = new Map<string, number>();
  for (const declaration of document.declarations) {
    if (declaration.kind !== 'constant' || declaration.constantValue === undefined) continue;
    const value = Number(declaration.constantValue);
    if (Number.isSafeInteger(value) && value >= 0) constants.set(declaration.name, value);
  }
  const facts: ForeachArrayFact[] = [];
  for (const declaration of document.declarations) {
    if (declaration.kind !== 'variable') continue;
    if (declaration.valueType === undefined || declaration.arraySize === undefined) continue;
    const size = resolveArraySize(declaration.arraySize, constants);
    if (size === null) continue;
    facts.push({ name: declaration.name, elementType: declaration.valueType, size });
  }
  return facts;
}

/**
 * 一个绑定事实的静态类型词。
 *
 * 元素绑定在**角色集合**里按 core 的 `elementType: 'character'` 说"角色号"（引擎里它就是
 * 整数，core 的绑定 `valueType` 也落成 int——这里取更贴近作者的那一侧事实，不另造类型）；
 * 其余绑定按 `valueType` 走 core 的类型词表。
 */
function foreachBindingTypeWord(
  elementType: string,
  binding: { readonly source: ForeachBindingSource; readonly valueType: KojoValueType },
): string {
  if (binding.source === 'element' && elementType === 'character') return '角色号';
  return kojo2TypeWordOf(binding.valueType);
}

/**
 * `@巡 <集合>` 的签名：集合名 + 这个集合**实际提供**的绑定名。
 *
 * 光标必须落在集合名上（名字起点到行尾之间，含名字之后的余量）；停在 `@巡` 词上不算。
 * 解析顺序：
 * 1. 没有 adapter / 没有 `foreachCollections` ⇒ `null`（集合名不可解析，不猜）；
 * 2. 把本文件数组事实 + 集合名交给 core 的 `planForEachLoop`（`programFeatures.foreach`
 *    明确关闭也算不可解析）；
 * 3. 计划失败（未声明 / 重复声明 / 绑定自相矛盾 / 长度机制坏掉）⇒ `null`；
 * 4. 计划成功 ⇒ 绑定名按声明序进参数位，`documentation` 写来源槽与静态类型。
 */
function foreachSignatureAt(
  document: Kojo2Document,
  record: KojoDispatchRecord,
  col0: number,
  adapter: GameAdapter | null | undefined,
): Kojo2SignatureHelpResult | null {
  if (adapter === null || adapter === undefined) return null;
  const tokens = splitSpaces(record.rest, record.restOffset);
  const token = tokens[0];
  if (token === undefined) return null;
  const collectionName = token.text.trim();
  if (collectionName.length === 0) return null;
  const lineOffset = record.lineOffset;
  const nameStart = token.offset - lineOffset;
  const lineLength = lineTextOf(document, record.number).length;
  // 光标必须在集合名上（含名字之后的同行余量）；停在 `@巡` 词上不算。
  if (col0 < nameStart || col0 > lineLength) return null;
  const contentEnd = record.contentEnd - lineOffset;

  const loop: KojoForEachLoop = {
    kind: 'forEachLoop',
    collection: {
      text: collectionName,
      span: {
        start: { line: record.number, column: nameStart + 1 },
        end: { line: record.number, column: nameStart + 1 + collectionName.length },
      },
    },
    body: [],
    span: {
      start: { line: record.number, column: 1 },
      end: { line: record.number, column: Math.max(1, contentEnd + 1) },
    },
  };

  let planned: ReturnType<typeof planForEachLoop>;
  try {
    planned = planForEachLoop(loop, adapter.foreachCollections ?? null, {
      enabled: adapter.programFeatures?.foreach === true,
      arrays: foreachArrayFactsOf(document),
    });
  } catch {
    return null;
  }
  if (!planned.ok) return null;

  const params: Kojo2SignatureParam[] = planned.plan.bindings.map((binding) => ({
    label: binding.name,
    documentation: `循环体里写 {${binding.name}}：${BINDING_SOURCE_WORDS[binding.source]}（${foreachBindingTypeWord(planned.plan.elementType, binding)}）`,
  }));
  return {
    signatures: [
      {
        label: `@${FOREACH_WORD} ${planned.plan.collection}(${params.map((param) => param.label).join(', ')})`,
        params,
        activeParameter: 0,
      },
    ],
    activeSignature: 0,
  };
}

/* ============================== 纯模型入口 ============================== */

/** 解析实现（`kojo2SignatureAt` 的 try/catch 由外层统一兜）。 */
function signatureHelpAt(
  source: string,
  position: Kojo2SignaturePosition,
  options: Kojo2SignatureOptions,
): Kojo2SignatureHelpResult | null {
  if (typeof source !== 'string' || source.length === 0) return null;
  if (!Number.isInteger(position.line) || position.line < 1) return null;
  if (!Number.isFinite(position.column) || position.column < 1) return null;

  const document = kojo2DocumentOf(source);
  const line = position.line;
  const record = document.lines[line - 1];
  if (record === undefined) return null;
  if (kojo2IsNativeRecord(record)) return null;
  if (!kojo2IsCodeSurface(record) && !kojo2IsTextSurface(record)) return null;

  const text = lineTextOf(document, line);
  const col0 = Math.min(Math.max(position.column - 1, 0), text.length);
  const textSurface = kojo2IsTextSurface(record);
  let scanFrom = 0;
  if (textSurface) {
    // 台词 / 旁白正文不提示；`{…}` 插值里是表达式，照常。
    const brace = interpolationBraceBefore(text, col0);
    if (brace < 0) return null;
    scanFrom = brace + 1;
  }
  if (insideStringOrCommentFrom(text, scanFrom, col0)) return null;

  // ① `@巡` 集合名（没有括号，先于调用位判定）。
  if (record.kind === 'dispatch' && record.known && record.word === FOREACH_WORD) {
    const foreach = foreachSignatureAt(document, record, col0, options.adapter);
    if (foreach !== null) return foreach;
  }

  // ② 调用位 / 声明头：最内层未闭合左括号 → 被调名 → 同文件声明。
  const open = innermostOpenParen(document, line - 1, col0);
  if (open === null) return null;
  const openText = lineTextOf(document, open.line);
  const callee = calleeBefore(openText, open.col);
  if (callee === null) return null;

  // 声明头优先按"这一行上的同名声明"取（同名声明是 core 的错误状态，这里仍给确定的落点）。
  const header = document.declarations.find(
    (declaration) =>
      declaration.line === open.line &&
      declaration.name === callee &&
      (declaration.kind === 'template' || declaration.kind === 'function'),
  );
  const declaration = header ?? kojo2DeclarationNamed(document, callee, open.line);
  if (declaration === undefined) return null;
  const activeParameter = topLevelCommas(document, open.line, open.col, line, col0);
  return signatureOfDeclaration(document, declaration, activeParameter);
}

/**
 * 光标处的签名帮助（**纯函数**）。
 *
 * 返回 `null` = 这里没有可解释的签名（**不猜**）：注释 / 字符串 / `@原生` / 台词正文、
 * 被调名不是同文件声明、声明没有形参、`@巡` 集合不可解析——全部走这一条。
 * `position` 是 1 基行列（Monaco 同口径）。
 */
export function kojo2SignatureAt(
  source: string,
  position: Kojo2SignaturePosition,
  options: Kojo2SignatureOptions = {},
): Kojo2SignatureHelpResult | null {
  try {
    return signatureHelpAt(source, position, options);
  } catch {
    return null; // 语言服务出错退化可见：提示消失，绝不抛进 Monaco 的击键路径
  }
}

/* ============================== Monaco 翻译 ============================== */

/**
 * 中性签名 → Monaco `SignatureHelp`。
 *
 * `parameters` 的 `label` 与签名串里的片段逐字一致（Monaco 拿参数标签在签名串上做正则定位
 * 高亮）；`documentation` 是纯文本（`string`），没有事实就不带这一格。顶层
 * `activeParameter` 取当前激活签名的那一格（Monaco 的协议字段在顶层）。
 */
export function toMonacoSignatureHelp(
  help: Kojo2SignatureHelpResult,
): Monaco.languages.SignatureHelp {
  const signatures: Monaco.languages.SignatureInformation[] = help.signatures.map((signature) => ({
    label: signature.label,
    parameters: signature.params.map((param) =>
      param.documentation === undefined
        ? { label: param.label }
        : { label: param.label, documentation: param.documentation },
    ),
    activeParameter: signature.activeParameter,
  }));
  const activeSignature =
    signatures.length === 0
      ? 0
      : clampActiveParameter(help.activeSignature, signatures.length);
  return {
    signatures,
    activeSignature,
    activeParameter: signatures[activeSignature]?.activeParameter ?? 0,
  };
}

/** 合并触发字符清单并去重（保持先出现者顺序；空串 / 非字符串丢弃）。 */
export function mergeTriggerCharacters(
  base: readonly string[],
  extra: readonly string[] | undefined,
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const ch of [...base, ...(extra ?? [])]) {
    if (typeof ch !== 'string' || ch.length === 0 || seen.has(ch)) continue;
    seen.add(ch);
    merged.push(ch);
  }
  return merged;
}

/** adapter 现取；getter 抛错 = 这一轮没有 adapter（不抛进 Monaco）。 */
function adapterAt(source: Kojo2SignatureAdapterSource): GameAdapter | undefined {
  if (source === null || source === undefined) return undefined;
  if (typeof source === 'function') {
    try {
      return source() ?? undefined;
    } catch {
      return undefined;
    }
  }
  return source;
}

/**
 * model + position → Monaco `SignatureHelp`（provider 与单测共用的翻译层）。
 * 取文失败 / 模型没有 `getValue` ⇒ `undefined`（不应答，不返回空签名把提示占住）。
 */
export function kojo2SignatureHelpOf(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  options: Kojo2SignatureOptions = {},
): Monaco.languages.SignatureHelp | undefined {
  let source: string;
  try {
    source = model.getValue();
  } catch {
    return undefined;
  }
  if (typeof source !== 'string') return undefined;
  const help = kojo2SignatureAt(
    source,
    { line: position.lineNumber, column: position.column },
    options,
  );
  return help === null ? undefined : toMonacoSignatureHelp(help);
}

/* ============================== 安装 ============================== */

/**
 * 为 **`kojo2` 语言 id** 注册签名帮助 provider（v1 的 `.kojo` / `.erb` 面由
 * `kojo-signature.ts` 各挂各的，互不重叠）。
 *
 * - **flag 关 ⇒ 零注册**（读 `ui/kojo2-flag.ts`，与语义着色 / 语言面同一条纪律）；
 * - 触发字符固定 `['(', ',']`，可用 `extraTriggerCharacters` 追加（合并去重）；
 * - 任何一轮解析抛错 ⇒ `undefined`（Monaco 会继续问下一家 / 收起提示，不让异常冒到击键路径）；
 * - 句柄 **dispose 幂等**，重复调用只撤一次；撤不掉也不外抛。
 */
export function installKojo2SignatureHelpProvider(
  monaco: typeof Monaco,
  options: Kojo2SignatureProviderOptions = {},
): Monaco.IDisposable {
  if (!isKojo2CutoverEnabled()) return NOOP_DISPOSABLE;

  const provider: Monaco.languages.SignatureHelpProvider = {
    signatureHelpTriggerCharacters: mergeTriggerCharacters(
      KOJO2_SIGNATURE_TRIGGER_CHARS,
      options.extraTriggerCharacters,
    ),
    provideSignatureHelp(model, position) {
      try {
        const help = kojo2SignatureHelpOf(model, position, { adapter: adapterAt(options.adapter) });
        if (help === undefined) return undefined;
        return { value: help, dispose: () => undefined };
      } catch {
        return undefined;
      }
    },
  };

  const registration = monaco.languages.registerSignatureHelpProvider(KOJO2_LANGUAGE_ID, provider);
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        registration.dispose();
      } catch {
        /* 幂等：撤不掉也不外抛 */
      }
    },
  };
}
