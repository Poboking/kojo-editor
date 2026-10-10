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
export function parseErbText(text: string, path = '<memory>'): ErbFile {
  const lines = normalizeEol(text).split('\n');
  const lineCount = lines.length;

  const functions: ErbFunction[] = [];
  const dims: ErbDim[] = [];
  let hasFunctionDirective = false;
  let inSkipBlock = false;

  /** #FUNCTION 标记：正常写在 @ 行之后（标记"上一个遇到的函数"）；写在其前则标记"下一个函数" */
  let pendingMarkerBeforeNext = false;

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
    if (trimmed.length === 0 || trimmed.startsWith(';')) continue;

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
      if (dim) dims.push({ name: dim.name, directive: dim.directive, line: i + 1 });
      continue;
    }

    if (trimmed.startsWith('$')) continue; // 跳转标签，不是函数

    if (trimmed.startsWith('@')) {
      const def = parseFunctionDefinition(trimmed);
      if (def) {
        functions.push({
          name: def.name,
          normalizedName: def.name.toUpperCase(),
          params: def.params,
          startLine: i + 1,
          endLine: lineCount, // 稍后收紧
          filePath: path,
          isExpressionFunction: pendingMarkerBeforeNext,
        });
        pendingMarkerBeforeNext = false;
        currentFuncStart = i + 1;
      }
      continue;
    }
    // 其余行为函数体/顶层语句：不影响结构扫描（v0.1）
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

/** 提取表达式原文的语句（其余受支持语句的 expression 为空串） */
const EXPRESSION_KINDS = new Set(['IF', 'ELSEIF', 'SIF', 'SELECTCASE', 'CASE', 'REPEAT', 'FOR', 'WHILE']);

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
 * 控制流骨架扫描（纯函数，宽容解析）：
 * - 线性输出全部控制流语句，附带块深度（见 `ControlFlowStatement` 契约）；
 * - `[SKIPSTART]…[SKIPEND]`、注释、`@` / `#` / `$` 行不参与；
 * - 配对不完好（孤儿闭合 / 错配嵌套）时不中断：闭合语句向栈内查找最近匹配项，
 *   找不到则不动栈——深度尽量保持可用（真实语料配平完好，此路径为防御性）。
 */
export function scanControlFlow(text: string): ControlFlowStatement[] {
  const lines = normalizeEol(text).split('\n');
  const out: ControlFlowStatement[] = [];
  const stack: string[] = []; // 配对类别栈
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
    if (trimmed.length === 0 || trimmed.startsWith(';')) continue;
    if (trimmed.startsWith('@') || trimmed.startsWith('#') || trimmed.startsWith('$')) continue;

    const wordMatch = /^([A-Za-z_]+)/.exec(trimmed);
    if (!wordMatch) continue;
    const kind = wordMatch[1]!.toUpperCase();
    const rest = trimmed.slice(wordMatch[1]!.length);

    let role: 'open' | 'branch' | 'close' | 'leaf' | null = null;
    let pair = '';
    if (LEAF_KINDS.has(kind)) {
      role = 'leaf';
    } else if (OPEN_KINDS[kind] !== undefined) {
      role = 'open';
      pair = OPEN_KINDS[kind]!;
    } else if (BRANCH_KINDS[kind] !== undefined) {
      role = 'branch';
      pair = BRANCH_KINDS[kind]!;
    } else if (CLOSE_KINDS[kind] !== undefined) {
      role = 'close';
      pair = CLOSE_KINDS[kind]!;
    } else if (PRINTDATA_OPEN.has(kind)) {
      role = 'open';
      pair = 'data';
    } else if (TRY_CATCH_OPEN.has(kind)) {
      role = 'open';
      pair = 'try';
    } else if (TRY_LIST_OPEN.has(kind)) {
      role = 'open';
      pair = 'funclist';
    }
    if (!role) continue;

    const expression = EXPRESSION_KINDS.has(kind) ? sliceExpression(rest) : '';

    if (role === 'leaf') {
      out.push({ kind, expression, depth: stack.length, line: i + 1 });
    } else if (role === 'open') {
      out.push({ kind, expression, depth: stack.length, line: i + 1 });
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
      out.push({ kind, expression, depth: found >= 0 ? found : Math.max(0, stack.length - 1), line: i + 1 });
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
      out.push({ kind, expression, depth: stack.length, line: i + 1 });
    }
  }

  return out;
}
