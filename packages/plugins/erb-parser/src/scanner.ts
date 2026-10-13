import type { ControlFlowStatement, ErbDim, ErbFile, ErbFunction, ErbParam } from '@kojo/plugin-api';

/**
 * ERB 结构扫描器（宽容解析，不做完整语法检查）。
 *
 * 只承诺"结构感知"（架构文档 §5.2 / 设计方案 §2）：
 * - 函数边界：`@NAME` / `@NAME(params)`；`$label` 不是函数；
 * - 声明：`#DIM*` 系列（收集名字，语义细分留给 v0.2 对照 Emuera VariableDeclaration）；
 * - 标记：`#FUNCTION` / `#FUNCTIONS`（真实写法在 @ 行**之后**的函数体内，见 AUTO_AEGI.ERB:60-61；
 *   同样兼容写在 @ 前——宽容解析两种都标记）；
 * - 区间：`[SKIPSTART]` … `[SKIPEND]` 内不解析；
 * - 注释：行首 `;`；定义行支持行内 `;` 注释（在括号配对之后截断）。
 *
 * 已知边界（v0.1 接受）：关键字缩写（IF 的 `I`、`SIF`…）不识别（无害）；
 * PRINT 变体与条件块留给 v0.2。
 */

/** 行内换行归一（插件内自带，不依赖 kernel——插件只允许依赖 plugin-api） */
function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** 顶层分隔符切分（感知括号与双引号；用于参数表） */
export function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (const ch of s) {
    if (inStr) {
      cur += ch;
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** 解析形参表（括号内内容）：`ARG, ARG:1 = 3, ref X, ARGS:1 = ""` */
export function parseParams(inner: string): ErbParam[] {
  if (inner.trim().length === 0) return [];
  return splitTopLevel(inner, ',')
    .map((part) => {
      const t = part.trim();
      if (t.length === 0) return null;
      const eq = t.indexOf('=');
      const namePart = eq >= 0 ? t.slice(0, eq) : t;
      // 形如 `ref ARG` / `ARG:1` / `OVERRIDE_TARGET = -1`
      const segments = namePart.trim().split(/\s+/);
      const name = segments[segments.length - 1] ?? '';
      if (name.length === 0) return null;
      return { name, hasDefault: eq >= 0 } satisfies ErbParam;
    })
    .filter((p): p is ErbParam => p !== null);
}

/** 解析 `@NAME(…)` 定义行（输入为已 trim 的行） */
export function parseFunctionDefinition(trimmed: string): { name: string; params: ErbParam[] } | null {
  if (!trimmed.startsWith('@')) return null;
  const body = trimmed.slice(1);
  let nameEnd = body.length;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '(' || c === ' ' || c === '\t' || c === ';') {
      nameEnd = i;
      break;
    }
  }
  const name = body.slice(0, nameEnd).trim();
  if (name.length === 0) return null;

  let params: ErbParam[] = [];
  const rest = body.slice(nameEnd);
  if (rest.startsWith('(')) {
    // 括号配对（感知引号）
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i]!;
      if (inStr) {
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const inner = end > 0 ? rest.slice(1, end) : rest.slice(1);
    params = parseParams(inner);
  }
  return { name, params };
}

const DIM_RE = /^#(DIMSTR|DIMCHAR|DIMS|DIM)\s+(.*)$/i;
const DIM_MODIFIERS = /^(CONST|SAVEDATA|GLOBAL|REF|NOINIT|CHARA)\s+/i;

/** 解析 `#DIM` 系列声明行 */
export function parseDimDeclaration(trimmed: string): { directive: string; name: string } | null {
  const m = DIM_RE.exec(trimmed);
  if (!m) return null;
  let rest = m[2]!.trim();
  // 去修饰词（可能存在多个，如 `CONST SAVEDATA`——循环剥离）
  let guard = 0;
  while (DIM_MODIFIERS.test(rest) && guard++ < 4) {
    rest = rest.replace(DIM_MODIFIERS, '').trim();
  }
  const name = rest.split(/[\s,=]/)[0] ?? '';
  if (name.length === 0) return null;
  return { directive: m[1]!.toUpperCase(), name };
}

/** 解析 ERB 文本（纯函数，测试友好） */
/**
 * 函数上方注释块的**保留字符上限**。
 *
 * 实测真实语料平均 76 字符，但存在 2,120 字符的英文长文档离群值。
 * 索引会被快照持久化（见 snapshot.ts），离群长文不截断会让单函数吃掉整份快照的预算，
 * 所以截断并留省略号——**截断是显式降级，不是丢数据**（原文仍在文件里，悬停看到前缀即可以定位）。
 */
export const DOC_MAX_CHARS = 600;

/** 纯装饰线：`;` 加一串 `=` `-` `*` `＊` 或空白（eraTW 作者用它画框）。 */
const DOC_DECORATION_ONLY = /^;[\s=\-*＊─━]*$/;

/**
 * 把 `@` 行上方收集到的原始注释行清洗成展示文本；无可展示内容 → undefined。
 *
 * 纯函数、可单测。规则：
 * 1. 丢掉纯装饰线（`;====` 这类画框用的横线）——它们对读代码的人零信息量；
 * 2. 去掉 `;` 前缀与紧随的一个空格；
 * 3. 逐行右trim，整体再trim；全空 → undefined（**缺省而非空串**，避免索引堆无用字段）。
 */
export function cleanDocBlock(rawLines: readonly string[]): string | undefined {
  const kept: string[] = [];
  for (const line of rawLines) {
    if (DOC_DECORATION_ONLY.test(line)) continue;
    const body = line.replace(/^;\s?/, '').trimEnd();
    if (body.length > 0) kept.push(body);
  }
  if (kept.length === 0) return undefined;
  let text = kept.join('\n');
  if (text.length > DOC_MAX_CHARS) {
    text = `${text.slice(0, DOC_MAX_CHARS - 1).trimEnd()}…`;
  }
  return text;
}

export function parseErbText(text: string, path = '<memory>'): ErbFile {
  const lines = normalizeEol(text).split('\n');
  const lineCount = lines.length;

  const functions: ErbFunction[] = [];
  const dims: ErbDim[] = [];
  let hasFunctionDirective = false;
  let inSkipBlock = false;

  /** #FUNCTION 标记：正常写在 @ 行之后（标记"上一个遇到的函数"）；写在其前则标记"下一个函数" */
  let pendingMarkerBeforeNext = false;

  /**
   * `@` 行上方紧邻的 `;` 注释块缓冲（用户反馈 9：函数名全大写 + 长前缀难辨识，
   * 悬停要给注释原文）。遇到任何**语句行**即清空——注释是跟着它下面那个声明的，
   * 隔了一条语句再挂到后面的函数上就是张冠李戴。
   */
  let docBuf: string[] = [];
  let blankRun = 0;
  const clearDoc = (): void => {
    docBuf = [];
    blankRun = 0;
  };
  /** 连续空行超过这个数就断开——防止文件头的注释块跨越大段空白粘到后面的函数上 */
  const DOC_MAX_BLANK_GAP = 2;

  const markExpression = (): void => {
    const last = functions[functions.length - 1];
    if (last && last.startLine === currentFuncStart) {
      last.isExpressionFunction = true;
    }
  };

  let currentFuncStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();

    if (inSkipBlock) {
      if (trimmed === '[SKIPEND]') inSkipBlock = false;
      continue;
    }
    if (trimmed === '[SKIPSTART]') {
      inSkipBlock = true;
      continue;
    }
    if (trimmed.length === 0) {
      // 空行不断块（作者常在注释与 @ 行之间留一行），但连续过多空行视为断开
      if (++blankRun > DOC_MAX_BLANK_GAP) clearDoc();
      continue;
    }
    if (trimmed.startsWith(';')) {
      docBuf.push(trimmed);
      blankRun = 0;
      continue;
    }

    if (trimmed.startsWith('#')) {
      const upper = trimmed.toUpperCase();
      if (upper.startsWith('#FUNCTION')) {
        // #FUNCTION / #FUNCTIONS（含 #FUNCTIONS 是字符串版）
        if (/^#FUNCTIONS?(\s|$)/.test(upper.replace(/\s*;.*$/, ''))) {
          hasFunctionDirective = true;
          if (currentFuncStart >= 0) {
            markExpression();
          } else {
            pendingMarkerBeforeNext = true;
          }
        }
        continue;
      }
      const dim = parseDimDeclaration(trimmed);
      if (dim) {
        dims.push({ name: dim.name, directive: dim.directive, line: i + 1 });
        clearDoc(); // #DIM 上方的注释是说明这个变量声明的，不能挂到后面的函数上
      }
      continue;
    }

    if (trimmed.startsWith('$')) {
      clearDoc(); // 跳转标签同理：注释属于标签，不属于后面第一个函数
      continue;
    }

    if (trimmed.startsWith('@')) {
      const def = parseFunctionDefinition(trimmed);
      if (def) {
        const doc = cleanDocBlock(docBuf);
        functions.push({
          name: def.name,
          normalizedName: def.name.toUpperCase(),
          params: def.params,
          startLine: i + 1,
          endLine: lineCount, // 稍后收紧
          filePath: path,
          isExpressionFunction: pendingMarkerBeforeNext,
          ...(doc !== undefined ? { docComment: doc } : {}),
        });
        pendingMarkerBeforeNext = false;
        currentFuncStart = i + 1;
      }
      clearDoc();
      continue;
    }
    // 其余行为函数体/顶层语句：不影响结构扫描（v0.1）
    clearDoc();
  }

  // 收紧 endLine：下一个函数定义前一行
  for (let i = 0; i < functions.length; i++) {
    const next = functions[i + 1];
    functions[i]!.endLine = next ? next.startLine - 1 : lineCount;
  }

  return { path, functions, dims, hasFunctionDirective, lineCount };
}

// ---------------------------------------------------------------------------
// 控制流骨架扫描（v0.2 第四批）——纯结构，零语义。
// 配对表以引擎源码为准（FunctionIdentifier.cs funcMatch，见逆向文档
// 《eratw4.980-Lang与Statements边角.md》§funcMatch 结构配对表）：
//   IF→ENDIF / SELECTCASE→ENDSELECT / REPEAT→REND / FOR→NEXT / WHILE→WEND /
//   DO→LOOP / TRYC 六个→CATCH→ENDCATCH / PRINTDATA 系 9 个→ENDDATA /
//   DATALIST→ENDLIST / STRDATA→ENDDATA / NOSKIP→ENDNOSKIP /
//   TRYCALLLIST/TRYGOTOLIST/TRYJUMPLIST→ENDFUNC（配对类 funclist）
// 注意：TRYCALL/TRYCALLFORM/TRYGOTO/TRYJUMP 等是单行语句，不开块（BUG-2 修复）。
// ---------------------------------------------------------------------------

/** 开块语句：kind → 配对类别 */
const OPEN_KINDS: Readonly<Record<string, string>> = {
  IF: 'if',
  SELECTCASE: 'select',
  FOR: 'for',
  WHILE: 'while',
  REPEAT: 'repeat',
  DO: 'do',
  DATALIST: 'list',
  STRDATA: 'data',
  NOSKIP: 'noskip',
};

/** 分支语句：与所配对的开块语句同深度 */
const BRANCH_KINDS: Readonly<Record<string, string>> = {
  ELSEIF: 'if',
  ELSE: 'if',
  CASE: 'select',
  CASEELSE: 'select',
  CATCH: 'try',
};

/** 闭合语句 */
const CLOSE_KINDS: Readonly<Record<string, string>> = {
  ENDIF: 'if',
  ENDSELECT: 'select',
  NEXT: 'for',
  WEND: 'while',
  REND: 'repeat',
  LOOP: 'do',
  ENDDATA: 'data',
  ENDLIST: 'list',
  ENDNOSKIP: 'noskip',
  ENDCATCH: 'try',
  ENDFUNC: 'funclist',
};

/** 单行语句（不配对、不开块；如 SIF = Single IF） */
const LEAF_KINDS = new Set(['SIF']);

/**
 * TRY 系精确三档（引擎 FunctionIdentifier.cs funcMatch :460-487 逐条对齐，BUG-2 修复）：
 * - 配 CATCH 的恰为 6 个：TRYCGOTO / TRYCJUMP / TRYCCALL（±FORM）；
 * - 配 ENDFUNC 的恰为 3 个：TRYCALLLIST / TRYGOTOLIST / TRYJUMPLIST（独立配对类 funclist）；
 * - 其余 TRY*（TRYCALL / TRYCALLFORM / TRYGOTO / TRYGOTOFORM / TRYJUMP / TRYJUMPFORM）
 *   是**单行语句**，不开块——旧版 startsWith('TRY') 把它们误当开块，产生幻影深度。
 */
const TRY_CATCH_OPEN: ReadonlySet<string> = new Set([
  'TRYCGOTO',
  'TRYCJUMP',
  'TRYCCALL',
  'TRYCGOTOFORM',
  'TRYCJUMPFORM',
  'TRYCCALLFORM',
]);
const TRY_LIST_OPEN: ReadonlySet<string> = new Set(['TRYCALLLIST', 'TRYGOTOLIST', 'TRYJUMPLIST']);

/** PRINTDATA 系精确 9 个（funcMatch :477-485；DATALIST/STRDATA 在 OPEN_KINDS 单列） */
const PRINTDATA_OPEN: ReadonlySet<string> = new Set([
  'PRINTDATA',
  'PRINTDATAL',
  'PRINTDATAW',
  'PRINTDATAK',
  'PRINTDATAKL',
  'PRINTDATAKW',
  'PRINTDATAD',
  'PRINTDATADL',
  'PRINTDATADW',
]);

/**
 * 控制流角色（配对表的唯一出口）。
 *
 * 为什么要把这张表封成函数而不是直接 export 那几个 Record：结构体检（`structure.ts`）与骨架扫描
 * （本文件 `scanControlFlow`）**必须用同一份配对表**——两处各自持有一份表就必然漂移，
 * 而漂移的表现为"波浪线指错了行"，比没有波浪线更糟（本项目口径：错标比不标危险）。
 */
export type ControlFlowRole = 'open' | 'branch' | 'close' | 'leaf';

/** 一行原文 → 控制流语句的形状（不是控制流语句则 null） */
export interface ControlFlowToken {
  /** 引擎里的语句原词（大写归一后的形态，如 `ENDIF`） */
  readonly kind: string;
  readonly role: ControlFlowRole;
  /** 配对类别（`if` / `select` / `try` / `funclist` …；leaf 为空串） */
  readonly pair: string;
  /** 语句后面的原文（截行内注释之前；只有需要表达式的语句非空） */
  readonly expression: string;
}

/** 提取表达式原文的语句（其余受支持语句的 expression 为空串） */
const EXPRESSION_KINDS = new Set(['IF', 'ELSEIF', 'SIF', 'SELECTCASE', 'CASE', 'REPEAT', 'FOR', 'WHILE']);

/**
 * 配对分类（表在文件头，逐条对齐引擎 `FunctionIdentifier.cs` 的 funcMatch）。
 * 骨架扫描与结构体检都走这道门——**这是配对表的单一真源**。
 */
export function classifyControlFlow(kind: string): { role: ControlFlowRole; pair: string } | null {
  if (LEAF_KINDS.has(kind)) return { role: 'leaf', pair: '' };
  if (OPEN_KINDS[kind] !== undefined) return { role: 'open', pair: OPEN_KINDS[kind]! };
  if (BRANCH_KINDS[kind] !== undefined) return { role: 'branch', pair: BRANCH_KINDS[kind]! };
  if (CLOSE_KINDS[kind] !== undefined) return { role: 'close', pair: CLOSE_KINDS[kind]! };
  if (PRINTDATA_OPEN.has(kind)) return { role: 'open', pair: 'data' };
  if (TRY_CATCH_OPEN.has(kind)) return { role: 'open', pair: 'try' };
  if (TRY_LIST_OPEN.has(kind)) return { role: 'open', pair: 'funclist' };
  return null;
}

/** 行首 `;` 注释、`@` / `#` / `$` 指令行不参与控制流（`#` 同时是结构体检的区域边界，见 structure.ts） */
export function isIgnorableFlowLine(trimmed: string): boolean {
  return (
    trimmed.length === 0 ||
    trimmed.startsWith(';') ||
    trimmed.startsWith('@') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('$')
  );
}

/** 一行取控制流形状；不是控制流语句 → null */
export function controlFlowToken(trimmed: string): ControlFlowToken | null {
  const wordMatch = /^([A-Za-z_]+)/.exec(trimmed);
  if (!wordMatch) return null;
  const kind = wordMatch[1]!.toUpperCase();
  const classified = classifyControlFlow(kind);
  if (!classified) return null;
  const rest = trimmed.slice(wordMatch[1]!.length);
  return {
    kind,
    role: classified.role,
    pair: classified.pair,
    expression: EXPRESSION_KINDS.has(kind) ? sliceExpression(rest) : '',
  };
}

/**
 * 截取表达式原文：在**引号外**遇到 `;` 视为行内注释截断；
 * 字符串内的 `;` 原样保留（如 `IF STR == "a;b"`）。
 */
function sliceExpression(rest: string): string {
  let inStr = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (inStr) {
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === ';') return rest.slice(0, i).trim();
  }
  return rest.trim();
}

/**
 * 控制流视野下的逐行形状（`scanControlFlow` 与结构体检共用，见 `forEachControlFlowLine`）。
 *
 * - `statement` = null 时 `boundary` 才可能为 true（`@` / `#` / `$` 指令行）；
 * - `[SKIPSTART]…[SKIPEND]` 区间内的行两者都为 false（整段屏蔽）。
 */
export interface ControlFlowLine {
  /** 1 基行号 */
  readonly line: number;
  /** 该行原文（trim 后） */
  readonly text: string;
  /** 函数/区域边界行（`@` 或 `#` 开头；`$` 标签不算边界） */
  readonly boundary: boolean;
  /** 控制流语句形状；不是控制流语句则 null */
  readonly statement: ControlFlowToken | null;
}

/**
 * 逐行喂给控制流的**唯一**遍历（2026-10-13 反馈 7）。
 *
 * 为什么要有这一道门：骨架扫描（索引/条件抽取的热路径）与结构体检（编辑器波浪线）必须看到
 * **同一批行**。两份各自的"哪些行算数"规则一旦分叉，表现就是"波浪线指的行骨架里根本没有"——
 * 排查成本极高。屏蔽规则（注释、`@`/`#`/`$`、`[SKIPSTART]…[SKIPEND]`）从此只写在这里。
 */
export function forEachControlFlowLine(text: string, visit: (l: ControlFlowLine) => void): void {
  const lines = normalizeEol(text).split('\n');
  let inSkipBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (inSkipBlock) {
      if (trimmed === '[SKIPEND]') inSkipBlock = false;
      continue;
    }
    if (trimmed === '[SKIPSTART]') {
      inSkipBlock = true;
      continue;
    }
    if (trimmed.length === 0 || trimmed.startsWith(';') || trimmed.startsWith('$')) continue;
    if (trimmed.startsWith('@') || trimmed.startsWith('#')) {
      visit({ line: i + 1, text: trimmed, boundary: true, statement: null });
      continue;
    }
    visit({ line: i + 1, text: trimmed, boundary: false, statement: controlFlowToken(trimmed) });
  }
}

/**
 * 配对类别 → 该类别的闭合语句原词（结构体检的话术要用）。
 * 从 `CLOSE_KINDS` **反查**得到——不再抄第二份表；每个类别在这里都只有一个闭合词，
 * 所以返回值是单值而不是数组。查不到返回空串（调用方要能容忍"说不出闭合词"）。
 */
export function closerNameForPair(pair: string): string {
  for (const [closer, p] of Object.entries(CLOSE_KINDS)) {
    if (p === pair) return closer;
  }
  return '';
}

/**
 * 控制流骨架扫描（纯函数，宽容解析）：
 * - 线性输出全部控制流语句，附带块深度（见 `ControlFlowStatement` 契约）；
 * - `[SKIPSTART]…[SKIPEND]`、注释、`@` / `#` / `$` 行不参与；
 * - 配对不完好（孤儿闭合 / 错配嵌套）时不中断：闭合语句向栈内查找最近匹配项，
 *   找不到则不动栈——深度尽量保持可用（真实语料配平完好，此路径为防御性）。
 *
 * 报错是另一个人的活：结构体检在 `structure.ts`，与这里共用 `forEachControlFlowLine` 的视野。
 */
export function scanControlFlow(text: string): ControlFlowStatement[] {
  const out: ControlFlowStatement[] = [];
  const stack: string[] = []; // 配对类别栈

  forEachControlFlowLine(text, ({ line, statement }) => {
    if (!statement) return;
    const { kind, expression, role, pair } = statement;

    if (role === 'leaf') {
      out.push({ kind, expression, depth: stack.length, line });
    } else if (role === 'open') {
      out.push({ kind, expression, depth: stack.length, line });
      stack.push(pair);
    } else if (role === 'branch') {
      // 与所配对的开启语句同深度（向栈内找最近匹配；找不到时退化为"栈内一层"）
      let found = -1;
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s] === pair) {
          found = s;
          break;
        }
      }
      out.push({ kind, expression, depth: found >= 0 ? found : Math.max(0, stack.length - 1), line });
    } else {
      // 闭合：向栈内查找最近匹配项并弹到它（含）；找不到则不动栈
      let found = -1;
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s] === pair) {
          found = s;
          break;
        }
      }
      if (found >= 0) stack.length = found;
      out.push({ kind, expression, depth: stack.length, line });
    }
  });

  return out;
}
