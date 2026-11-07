/**
 * 编辑器波浪线：条件表达式语法诊断（E8）。
 *
 * 只对**承载单条条件的控制流语句**跑表达式诊断（`IF` / `ELSEIF` / `SIF` /
 * `WHILE` / `SELECTCASE`），产出行级波浪线条目交给 `ui.editor.decorator` 槽。
 *
 * 口径（保守：错标比不标危险）：
 * - 排除 `CASE` / `PRINTDATA` 等——它们承载的是逗号列表 / 范围写法，表达式诊断器
 *   对其（合理地）误报，标出来的会是"假错"；
 * - `expression` 为空 / 只有空白 → 不诊断（无内容可判）；
 * - 同一行若命中多条，只留第一条（按行去重）；
 * - 文本为空 → 返回 `[]`；本函数**不得抛错**（扫描 / 诊断任一异常都当"无发现"）。
 *
 * 2026-10-16 erb-deep 批（T8）—— **表面扩面**：同一套 `diagnoseExpression` 现在
 * 也吃两类新表面（`expressionSurfaces`，本文件单一真源）：
 * - `assign`：赋值语句的右侧（`A = B + …` / `A += …` / `A:1:(X) = …`）；
 * - `interp`：字符串字面量内的插值段（`{表达式}` / `%表达式%`）。
 *
 * 为什么表面提取住在本文件而不是 erb-parser 服务面：这条波浪线的**运行时真路径是
 * worker offload**（任务表由装配层注入且只注入骨架扫描器这一个函数），服务句柄只有
 * 主线程回退路径够得着——提取逻辑放 erb-parser 就意味着 worker 路径永远缺这半张
 * 波浪线（两条走法不一致），要接上就得改装配层（越权）。放这里则 `collect` 内部
 * 直取，offload 与就地回退两条走法**零接线自动同源**；诊断器 `diagnoseExpression`
 * 逐字复用（零抄第二份），不新增任何跨插件依赖方向。
 */

import type { ControlFlowStatement } from '@kojo/plugin-api';
import { diagnoseExpression, splitTopLevelCommas } from './expr';

export interface ExprSyntaxDecoration {
  line: number;
  message: string;
  code: string;
  /** 1 基起始列（UTF-16 码元；additive，缺省 = 整行） */
  startColumn?: number;
  /** 1 基结束列（半开区间；与 `startColumn` 同给同缺） */
  endColumn?: number;
}

/** 承载单条（可解析）条件的控制流语句关键字。 */
const CONDITION_KINDS: ReadonlySet<string> = new Set(['IF', 'ELSEIF', 'SIF', 'WHILE', 'SELECTCASE']);

/**
 * 在行原文里定位表达式起点（0 基）。语句形如 `IF <expression>`：跳过行首缩进与关键字后
 * 再找表达式原文（trim 过的切片一定是行内子串；找不到就放弃列号，退回整行）。
 */
function expressionStartInLine(lineText: string | undefined, expression: string): number | undefined {
  if (lineText === undefined) return undefined;
  const head = /^[\s\u3000\u00a0]*[A-Za-z_]+/.exec(lineText);
  const from = head ? head[0].length : 0;
  const at = lineText.indexOf(expression, from);
  if (at >= 0) return at;
  const loose = lineText.indexOf(expression);
  return loose >= 0 ? loose : undefined;
}

/** 单字符宽度（UTF-16 码元；代理对 = 2） */
function charWidth(text: string, at: number): number {
  const cp = text.codePointAt(at);
  return cp !== undefined && cp > 0xffff ? 2 : 1;
}

// ---------------------------------------------------------------------------
// 表面提取（T8）：赋值右侧 + 字符串插值。纯函数，单遍线性。
// ---------------------------------------------------------------------------

export type ExpressionSurfaceOrigin = 'assign' | 'interp';

/** 一处"该当表达式读"的原文表面（1 基行号 + 原文 + 来源） */
export interface ExpressionSurface {
  line: number;
  expression: string;
  origin: ExpressionSurfaceOrigin;
}

/** 标识符首/续字符（口径与 expr.ts 词法器一致：非 ASCII 全算——日文变量名与具名索引） */
const isIdentStart = (c: string): boolean => /[A-Za-z_\u0080-\uffff]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_\u0080-\uffff]/.test(c);

/**
 * data 块系关键字（行首词，大写归一）：块内的行是**待打印的原文**（台词里的
 * "50%"、"{名前}"都是字面量），一律不提取。排除判据专用——配对表的单一真源
 * 仍在 erb-parser/scanner，这里只认"哪些词开/关数据块"这一个最小集合。
 */
const DATA_OPENERS: ReadonlySet<string> = new Set([
  'PRINTDATA',
  'PRINTDATAL',
  'PRINTDATAW',
  'PRINTDATAK',
  'PRINTDATAKL',
  'PRINTDATAKW',
  'PRINTDATAD',
  'PRINTDATADL',
  'PRINTDATADW',
  'STRDATA',
  'DATALIST',
]);
const DATA_CLOSERS: ReadonlySet<string> = new Set(['ENDDATA', 'ENDLIST']);

/**
 * 从 `s` 的 `i`（`s[i]==='"'`）扫描一个双引号字符串（`\X` 转义对直过），
 * 返回**闭合引号之后**的下标；未闭合 → -1。
 */
function skipString(s: string, i: number): number {
  i++;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) {
      i += 2; // \X 转义对（含 \"）
      continue;
    }
    i++;
    if (c === '"') return i;
  }
  return -1;
}

/**
 * `%…%` / `{…}` 插值段的结束位置（`from` = 开分隔符之后；返回闭分隔符之后 / 未闭合 -1）。
 * 插值里可再出现普通串与嵌套 `@"…"`——它们的引号属于内层表达式，不关闭外层串。
 */
function skipInterpBody(s: string, from: number, closer: '}' | '%'): number {
  let i = from;
  while (i < s.length) {
    const c = s[i]!;
    if (c === closer) return i + 1;
    if (c === '"' || (c === '@' && s[i + 1] === '"')) {
      const end = skipLiteral(s, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (c === '\\' && i + 1 < s.length) {
      i += 2;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * `@"…"` 逐字串的结束位置（`from` = 开引号之后；返回闭引号之后 / 未闭合 -1）。
 *
 * 语义与 `expr.ts` 词法器同口径（引擎 `LexicalAnalyzer.AnalyseFormattedString`）：
 * `%…%` / `{…}` 插值里的引号属于**内层表达式**，不关闭外层串
 * （`@"%FSYN("射精")%:手插进了你的…"` 是合法字面量，口上语料高频）。
 * 认不出时回退"下一枚引号即结束"（与旧口径一致，`@"50% OFF"` 这类孤立 `%` 不误开插值）。
 */
function skipVerbatimBody(s: string, from: number): number {
  let i = from;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"') return i + 1;
    if (c === '%' || c === '{') {
      const end = skipInterpBody(s, i + 1, c === '%' ? '%' : '}');
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (c === '\\' && i + 1 < s.length) {
      i += 2;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * 从 `i` 读一枚字面量：`i` 可以是 `"`（普通串）或 `@"` 的 `@`（逐字串）。
 * 返回闭合引号之后 / 未闭合 -1。
 *
 * **为什么要逐字串的这一口**（D18）：之前所有取串都从 `@"` 的那枚 `"` 起按普通串扫，
 * 撞上内层 `%FSYN("射精")%` 的引号就提前收串 ⇒ 后面的台词被切成"表面"送去诊断，
 * 语料上表现为一串"多了一个冒号 / 运算符“!”"（`%SPLIT_G(@"a:b:c")%` 族）。
 */
function skipLiteral(s: string, i: number): number {
  if (s[i] === '@' && s[i + 1] === '"') {
    const end = skipVerbatimBody(s, i + 2);
    return end >= 0 ? end : skipString(s, i + 1);
  }
  return s[i] === '"' ? skipString(s, i) : -1;
}

/** 引号感知截行内注释：顶层 `;` 起整段丢弃；字符串内的 `;` 原样保留 */
function stripInlineComment(line: string): string {
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === '"' || (c === '@' && line[i + 1] === '"')) {
      const end = skipLiteral(line, i);
      i = end < 0 ? line.length : end;
      continue;
    }
    if (c === ';') return line.slice(0, i);
    i++;
  }
  return line;
}

/**
 * 赋值左侧形状：`NAME` / `NAME:seg(:seg)*` / `[[rename]](:seg)*`。
 * seg = 标识符段（含数字）| `"字符串"` | `(平衡括号)`。不像变量引用 → false（调用方整行不报）。
 * 这道门顺手挡掉了 `IF A = 1`（LHS `IF A` 不合形状）、`#DIM X = 1`（`#` 行根本进不来）等非赋值行。
 */
function isVarRefLHS(s: string): boolean {
  const t = s.trim();
  if (t.length === 0) return false;
  let i = 0;
  if (t.startsWith('[[')) {
    const close = t.indexOf(']]', 2);
    if (close < 0) return false;
    i = close + 2;
  } else {
    if (!isIdentStart(t[0]!)) return false;
    i = 1;
    while (i < t.length && isIdentPart(t[i]!)) i++;
  }
  while (i < t.length) {
    if (t[i] !== ':') return false;
    i++;
    if (i >= t.length) return false;
    if (t[i] === '"') {
      const end = skipString(t, i);
      if (end < 0) return false; // 未闭合
      i = end;
    } else if (t[i] === '(') {
      let depth = 1;
      i++;
      while (i < t.length && depth > 0) {
        const c = t[i]!;
        if (c === '"') {
          const e = skipString(t, i);
          if (e < 0) return false;
          i = e;
          continue;
        }
        if (c === '(') depth++;
        else if (c === ')') depth--;
        i++;
      }
      if (depth !== 0) return false;
    } else if (isIdentPart(t[i]!)) {
      while (i < t.length && isIdentPart(t[i]!)) i++;
    } else {
      return false;
    }
  }
  return true;
}

/** 表达式合法的首记号字符（引号 / 数字 / 括号 / 单目 / 标识符含非 ASCII）；其余打头 = 裸文本赋值 */
const EXPR_FIRST = /^[A-Za-z0-9_"(+\-!~\u0080-\uffff]/;

/**
 * 全角文本标点（出引号外）：裸文本赋值 / 散文 / 美术图的强特征；ERB 标识符与运算不含它们。
 * 2026-11-07 D18 补入 `，` `：` `；` `・` 与书名/引号类括号——语料实证的口上散文断句字符
 * （`RESULTS = 陷落状态4以上，与恋恋一起…`、`时间在21:00以后，…`）。
 */
const BARE_TEXT_CHARS = /[「」『』（）！？…‥、。，：；・～♪＠￥※┃│《》〈〉【】〔〕“”‘’]/;

/** `变量:函数调用(…)` 索引（`CSTR:TOINT(X)` / `RAND: 陷落状态()`，冒号后容许空白）：合法 ERA，子集不覆盖 → 不猜 */
const REF_FUNC_INDEX = /:\s*[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*\s*\(/;

/** PRINT 系输出语句（`PRINTL -=彡…` 的文本里带 `=` 会被误读成复合赋值）：引擎保留字，不作 LHS */
const PRINT_LIKE_LHS = /^PRINT/i;

const isIdentChar = (c: string): boolean => /[A-Za-z0-9_\u0080-\uffff]/.test(c);
const isSpaceChar = (c: string): boolean => c === ' ' || c === '\t' || c === '\u3000' || c === '\u00a0';

/** "记号 —— 空白 —— 记号"（真表达式里记号相邻必隔 ASCII 运算符，`X Y` 本身即非法） */
const SPACE_GAP = /[A-Za-z0-9_\u0080-\uffff][ \t\u3000\u00a0]+[A-Za-z0-9_\u0080-\uffff]/;
/** 非 ASCII（日文 / 中文）：与 SPACE_GAP 同时出现 = 散文的强证据 */
const NON_ASCII = /[^\u0000-\u007f]/;
/** 解码替换符（内核探测式解码对不可解字节的产物）——不是作者写的字符 */
const DECODE_REPLACEMENT = '\uFFFD';

/** 把表达式里的字符串字面量换成 `""`（`@"…"` 走插值感知口）：散文判据只看代码面 */
function stripStringLiterals(expr: string): string {
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const c = expr[i]!;
    if (c === '"' || (c === '@' && expr[i + 1] === '"')) {
      const end = skipLiteral(expr, i);
      if (end < 0) return out; // 未闭合：其后全是串内容
      out += '""';
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 散文证据（D18「只在**真表达式位**判」的第一道门，语句路径与赋值 RHS 共用）。
 *
 * 语料实证的四类误报都不是表达式位，只是"行首/等号右边恰好长得像表达式"：
 * - 台词原文 / 美术图整行被当成代码（全角标点：`，` `：` `；` `「」` …）；
 * - 中日文散文断词（`X误写成SELECTCASE X`：记号之间只有一个空格——真表达式里记号相邻
 *   必隔 ASCII 运算符，`A B` 本身就是非法 token 序列，作者不会这么写）；
 * - 括号里一个光秃秃的问号（`觉妖怪与裂空刺眼惊(?)`：三元从不在 `(` 之后就 `?`）；
 * - 解码替换符（文件不是 UTF-8，内核探测式解码兜出来的 `�`；在其上判语法=判乱码）。
 *
 * 判据只看**出引号外**的部分：字符串里的全角标点与空格是正文，不是散文证据。
 */
function looksLikeProse(expression: string): boolean {
  if (expression.includes(DECODE_REPLACEMENT)) return true;
  const bare = stripStringLiterals(expression);
  if (BARE_TEXT_CHARS.test(bare)) return true;
  if (/\(\s*\?/.test(bare)) return true;
  return NON_ASCII.test(bare) && SPACE_GAP.test(bare);
}

/**
 * 表达式在行尾是否"开口"（`(` 有开无闭 / 引号未闭合）——跨行表达式的必要条件。
 * 只数出引号外的括号：串里的 `(` 是正文。
 */
function isUnterminatedAtEol(expression: string): boolean {
  let depth = 0;
  let i = 0;
  while (i < expression.length) {
    const c = expression[i]!;
    if (c === '"' || (c === '@' && expression[i + 1] === '"')) {
      const end = skipLiteral(expression, i);
      if (end < 0) return true; // 引号没闭合
      i = end;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    i++;
  }
  return depth > 0;
}

/** 折行续写最多往后看几行（语料实测最长的跨行实参表 = 5 行整） */
const MAX_CONTINUATION_LINES = 8;

/**
 * 折行续写证据（D18 第二道门）：骨架扫描器只有**单行视野**，跨行表达式在它眼里永远是
 * 残句。判据不用关键字表（"下一行像不像新语句"是开放集），而是**试一试**：
 * 把后续行逐行接上来，接到某一行能解析通过 ⇒ 这是折行续写，不是残句。
 *
 * 语料两例（都是合法 ERA，且都是本腿此前最扎眼的假阳性）：
 * `SIF GROUPMATCH(LOCALS:1, …` 十二行实参（fromEN/MISC.ERB）、
 * `IF MAX(` + 五行 `ITEM:…` 列表（COMF413 料理を作る.ERB）。
 */
function continuesOnNextLines(expression: string, lines: readonly string[], lineNo: number): boolean {
  if (!isUnterminatedAtEol(expression)) return false;
  let joined = expression;
  for (let k = lineNo; k < lines.length && k < lineNo + MAX_CONTINUATION_LINES; k++) {
    joined = `${joined} ${lines[k]!}`;
    if (diagnoseExpression(joined) === null) return true;
  }
  return false;
}

/**
 * 空格断 token 的裸文本（美术图 `AA:05 = 森森森　　林森`、词典 `X = fuck:thrust into:…`、
 * 台词对白）：空白两侧都是记号字符 → 不是表达式（真表达式里记号相邻必然隔着
 * ASCII 运算符，`X Y` 本身就是非法）。只看出引号外的部分（调用方循环内执行）。
 */
function bareTextSpaceGap(text: string, from: number, lastSig: string): boolean {
  if (!isIdentChar(lastSig)) return false;
  let j = from;
  while (j < text.length && isSpaceChar(text[j]!)) j++;
  if (j >= text.length) return false;
  return isIdentChar(text[j]!);
}

/**
 * RHS 上的 fail-open 守卫（读数来源：语料探针 expr-surfaces.corpus，四轮 10,908 → 4,650 →
 * 4,622 → 3,065 假红换来的判据）。表达式子集不覆盖的**合法 ERA 形态**整条不猜——
 * - `\@…\@` 条件插值（词法器没有 `\`，嵌套引号也拆不对）；
 * - ERA 三元 `? … # …` 的顶层 `#`（词法器只认 `? :`）；
 * - 实数字面量 `.`（`A = 1.5`；ERB 无成员访问，顶层 `.` 必是实数或垃圾，都不该报）；
 * - 字符字面量 `'x'`、扩展字面量 `@"…"`（`@` 不是表达式记号；前导 `@"` 已在调用前剥掉）；
 * - **字符串变量的插值展开 RHS**：`STR:0 = %RESULTS%` 是合法 ERA，`%` 的"模运算 vs
 *   插值"两读无法从语法分辨 → 见 `%` 一律不猜；
 * - 顶层 `,`（`LOCAL = 5, 6, 7` 多重代入）与**空实参**（`F(A, , 1)`，ERA 缺省实参）；
 * - 位或 `|`（`AA:02 = ┃|…` 美术图行；位或在赋值 RHS 的语料占比 ≈ 0，宁可漏诊）；
 * - **裸文本赋值**：`台词 = 「…」/「…」`、`XML = <ROOT />`——首记号不在表达式集合内、
 *   出引号外含全角文本标点、或空格断 token 的裸文本（这些行的 `{}`/`%%` 插值是引擎
 *   展开的字符串，不是表达式）；
 * - 内嵌引号（`@"…%F("A")%…"`，引号计数 > 2）：`@"` 串允许裸 `"`，朴素配对必然错切；
 * - `变量:函数(…)` 调用式索引（`CFLAG:TOINT(X)`、`Emot:IFEstr()`，语料高频）。
 */
function rhsBlockReason(rhs: string): boolean {
  // D18：散文证据（全角断句 / 中日文空格断词 / `(?` / 解码替换符）——不是表达式位
  if (looksLikeProse(rhs)) return true;
  if (rhs.includes('\\@')) return true;
  if (!EXPR_FIRST.test(rhs)) return true;
  if (REF_FUNC_INDEX.test(rhs)) return true;
  // 纯符号裸文本（`ARGS:1 = -` / `LOCALS = !`，语料实证）：无任何记号字符，必不是表达式
  if (!/[A-Za-z0-9_\u0080-\uffff"]/.test(rhs)) return true;
  let inStr = false;
  let depth = 0;
  let quotes = 0;
  let lastSig = '';
  for (let i = 0; i < rhs.length; i++) {
    const c = rhs[i]!;
    if (inStr) {
      if (c === '\\' && i + 1 < rhs.length) {
        i++; // \" 等转义对
        continue;
      }
      if (c === '"') {
        inStr = false;
        quotes++; // 闭引号同计数：`@"…%F("A", B)%…"` 的内嵌引号形态靠总数识别
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      quotes++;
      continue;
    }
    if (isSpaceChar(c)) {
      if (bareTextSpaceGap(rhs, i, lastSig)) return true;
      continue;
    }
    // 实数科学计数法（`mCID:1 = 19e2`，语料实证）：词法器只有整数
    if (/[0-9]/.test(lastSig) && (c === 'e' || c === 'E') && /[0-9+-]/.test(rhs[i + 1] ?? '')) return true;
    if (c === '(') depth++;
    else if (c === ')') {
      if (lastSig === ',') return true; // 空实参 `, )`
      depth = Math.max(0, depth - 1);
    } else if (c === ',') {
      if (lastSig === ',' || lastSig === '(') return true; // 空实参 `,,` / `(,`
      if (depth === 0) return true; // 多重代入形态
      if (rhs.slice(i + 1).trim().length === 0) return true; // 悬尾逗号（行尾续行形态）
    } else if (c === '#') {
      return true;
    } else if (c === '.' || c === "'" || c === '@' || c === '%' || c === '|' || c === '{' || c === '}') {
      // `{}`：插值花括号只活在字符串/裸文本里（`"射精"{LOCAL:1}`、`X {FLAG:…}`），表达式没有花括号
      return true;
    } else if (BARE_TEXT_CHARS.test(c)) {
      return true;
    }
    lastSig = c;
  }
  return quotes > 2; // 内嵌引号：@"…%F("A", B)%…" 形态，引号配对不可靠
}

/** 一个代码行（已截注释）里的字符串字面量内容 → 插值表面 */
function extractInterp(content: string, line: number, out: ExpressionSurface[]): void {
  if (content.includes('\\@')) return; // 条件插值：不在表达式子集内，整段不猜
  // `%\"…\"%` 美术包裹形态（语料实证：K14 系口上把整幅 AA 用转义引号塞进插值）——
  // 内层花括号/百分号全是图，整段不提取
  if (content.includes('\\' + '"')) return;
  // D18：`%` 计数为奇数 ⇒ 至少有一枚是字面量（`50%`）或模运算，插值边界从语法上分不清
  // （语料：`%C_SAMPLE_CHAR:(CNT % VARSIZE("X")) * W%`）。整串 fail-open，不猜。
  if (countUnescaped(content, '%') % 2 === 1) return;
  let i = 0;
  const n = content.length;
  while (i < n) {
    const c = content[i]!;
    if (c === '\\' && i + 1 < n) {
      i += 2; // \X 字面转义对（\{ \% 等）
      continue;
    }
    if (c === '{' || c === '%') {
      const close = content.indexOf(c === '{' ? '}' : '%', i + 1);
      if (close < 0) break; // 未闭合（"{名前" / "50%"）= 引擎按字面量打印 → 不报
      // `{表达式, 对齐, 宽度}` 与 `%表达式, 对齐, 宽度%` 的对齐参数都不是表达式
      // （语料实证 `{LOCAL, 2, RIGHT}` 与 `%…%` 同制）：只诊顶层逗号的第一段
      // （引号/括号感知切分；括号内的逗号是实参表，留在段里照诊）。
      maybeSurface(splitTopLevelCommas(content.slice(i + 1, close))[0] ?? '', line, 'interp', out);
      i = close + 1;
      continue;
    }
    i++;
  }
}

/** 未转义的字符计数（`\X` 转义对整体跳过）：判断插值边界是否成对 */
function countUnescaped(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) {
      i++;
      continue;
    }
    if (c === ch) n++;
  }
  return n;
}

/**
 * 插值段括号形态：'balanced' 配平 / 'unclosed' 有开无闭 / 'extra' 多右括号。
 * unclosed = 提取错位（`%X:(CNT % V(Y))%` 里 mod 撞上闭合格，语料实证的假红源）→ 不猜；
 * extra = 内容自己多了个右括号（`{D)}`）→ 真错，照报。
 */
function parenBalance(s: string): 'balanced' | 'unclosed' | 'extra' {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (c === '\\' && i + 1 < s.length) {
        i++;
        continue;
      }
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
      if (depth < 0) return 'extra';
    }
  }
  return depth === 0 ? 'balanced' : 'unclosed';
}

/**
 * 插值段的形状守卫（判据全来自语料探针的假红形态）：
 * - 散文（无表达式标记、非纯 ASCII 记号）→ 不提取——词法器把散文当大标识符本来
 *   也解析得过，会炸的是带空格断 token 的散文，必须挡在诊断前；
 * - `|` 是美术图 / HTML 模板字符（语料实证 `--|--` 分隔线）→ 不猜；
 * - 括号"有开无闭" = 提取错位（`%…%` 内含 mod 的嵌套形态）→ 不猜；多右括号（`{D)}`）= 真错，照报；
 * - `变量:函数()` 调用式索引、`\@`、`'`、`.`（实数）、`#`/`@`/`$` 都是子集外形态 → 不猜。
 * 真错（`{A +}` / `{TALENT:}` / `{D)}`）全部带标记，一条不漏。
 */
function maybeSurface(raw: string, line: number, origin: ExpressionSurfaceOrigin, out: ExpressionSurface[]): void {
  const t = raw.trim();
  if (t.length === 0) return;
  if (t.includes(DECODE_REPLACEMENT)) return; // 解码替换符：判乱码不是判语法
  if (t.includes('\\@') || t.includes("'") || t.includes('.') || t.includes('|')) return;
  if (t.startsWith('\\')) return; // 转义符打头 = 错位提取的垃圾（表达式不以 \ 开头）
  // `#`（ERA 三元）/ `@`（扩展字面量）/ `$`（口上脏话文本，语料实证）都不是表达式记号
  if (/[#@$]/.test(t)) return;
  if (REF_FUNC_INDEX.test(t)) return; // 变量:函数(…) 调用式索引，子集不覆盖
  // 空实参调用 `F(,1)` / `F(,,2)`（ERA 缺省实参，语料高频）与裸文本空格断 token
  if (/[,(]\s*,|,\s*\)/.test(t)) return;
  if (/[A-Za-z0-9_\u0080-\uffff][ \t\u3000]+[A-Za-z0-9_\u0080-\uffff]/.test(t)) return;
  if (!/[A-Za-z0-9_\u0080-\uffff]/.test(t)) return; // 纯标点垃圾（`{::}` 美术框线）
  if (parenBalance(t) === 'unclosed') return;
  const exprish = /[:()"+\-*/<>=!&|^?,]/.test(t) || /^[A-Za-z0-9_]+$/u.test(t);
  if (!exprish) return;
  out.push({ line, expression: t, origin });
}

/** 引号打头的 RHS：串闭后必须紧跟运算符/引号/行尾——`"射精"{LOCAL:1}` 是裸文本+引擎展开，不是表达式 */
const QUOTE_TRAILING_OK = /^[+\-*/%<>!=&|^?]/;

/**
 * assign 诊断面的"高置信"门（收窄判据，六轮语料探针的最终裁决）：
 * 裸文本赋值（`台词 = 「…」`、`SENSE = a/b/c`、`AA:03 = ____⊥⊥_/__!___`、词典行…）的
 * 合法形态空间是**开放集**，守卫穷举追不完（六轮 10,908→2,387 假红全是新形态）；而
 * 六轮全语料 assign 段**真错为 0**。按仓库宪法"错标比不标危险"，assign 只诊机器可证的
 * 表达式形态：引号 / 数字 / `(` 打头，或 ident 打头且带索引链（`:` 后有段）或调用 `(`。
 * 其余（`A = B + C` 这类纯变量运算）**不诊**——漏诊换取裸文本零假红，取舍记于此。
 */
function isHighConfidenceExprRhs(rhs: string): boolean {
  const c0 = rhs[0]!;
  if (c0 === '"') {
    const end = skipString(rhs, 0);
    if (end >= 0) {
      const rest = rhs.slice(end).trimStart();
      const nc = rest[0];
      if (nc !== undefined && !QUOTE_TRAILING_OK.test(nc)) return false;
    }
    return true;
  }
  if (/[0-9(]/.test(c0)) {
    if (c0 >= '0' && c0 <= '9') {
      // 数字打头的裸文本两型（语料实证）：数字后紧跟字母/下划线（`5种族` / `1p1` /
      // `30_BODY_WEAR`，含 `1e3` 科学计数法——词法器只有整数）；`0/1/` 式数字斜杠列表。
      if (/[0-9][_A-Za-z\u0080-\uffff]/.test(rhs)) return false;
      if (rhs.includes('/') && /^[0-9./\s]+$/.test(rhs)) return false;
    }
    return true;
  }
  if (/[A-Za-z_\u0080-\uffff]/.test(c0)) {
    if (rhs.includes('(')) return true;
    // `TALENT:恋慕 + 1` 过；`wait:` / `fuck:thrust` 这类冒号列表裸文本不猜
    return /[A-Za-z0-9_\u0080-\uffff]\s*:\s*[^\s:]/.test(rhs);
  }
  return false; // 单目（`-`/`!`/`~`）与其余打头：裸文本高发（`ARGS:1 = -`、`~ 　ヒ/フ`），不猜
}

/** 一枚"引号里是显示文本"的判据：整段插值就是这一枚字面量（`%"…"%` / `{"…"}`） */
function aloneInInterpolation(code: string, openQuote: number, closeQuote: number): boolean {
  let a = openQuote - 1;
  while (a >= 0 && isSpaceChar(code[a]!)) a--;
  let b = closeQuote + 1;
  while (b < code.length && isSpaceChar(code[b]!)) b++;
  const before = a >= 0 ? code[a]! : '';
  const after = b < code.length ? code[b]! : '';
  return (before === '%' || before === '{') && (after === '' || after === '%' || after === '}');
}

/** 一行代码（trim 后）→ 该行的表面；三遍线性（span 收集 / 赋值 / 插值），成本形状不变 */
function scanCodeLine(line: string, lineNo: number, out: ExpressionSurface[]): void {
  const code = stripInlineComment(line);
  // pass 1：字符串字面量 span 收集（未闭合串也记；"引号打头 + 词法错"的形态由
  // collect 层的字符串边界守卫过滤——美术图行里的 `\"` 会搅乱引号配对）。
  // `@"…"` 走**插值感知**口（见 `skipLiteral`），否则内层 `%F("…")%` 的引号会提前收串、
  // 把台词切成假表面。
  const spans: Array<{ start: number; end: number; display: boolean; verbatim: boolean }> = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    if (c !== '"' && !(c === '@' && code[i + 1] === '"')) {
      i++;
      continue;
    }
    const openQuote = c === '@' ? i + 1 : i;
    const end = skipLiteral(code, i);
    const closed = end >= 0;
    spans.push({
      start: openQuote + 1,
      end: closed ? end - 1 : code.length,
      // D18：`%"…"%` / `{"…"}` 里那枚字面量是**插值的结果值**（显示文本，语料实证全是
      // ASCII 美术图 `%"　 {:::＼:ヽ:_}…"%`）——插值语法只在格式串里成立，值不是格式串
      display: closed && aloneInInterpolation(code, openQuote, end - 1),
      verbatim: c === '@',
    });
    i = closed ? end : code.length;
  }
  // pass 2：顶层赋值算符（== / != / <= / >= 排除；<<= / >>= 认；+= 系认）。
  // `=` 出现在字符串内时上面那跳已经吞掉，天然到不了这里。
  i = 0;
  while (i < code.length) {
    const c = code[i]!;
    if (c === '"' || (c === '@' && code[i + 1] === '"')) {
      const end = skipLiteral(code, i);
      i = end < 0 ? code.length : end;
      continue;
    }
    if (c !== '=') {
      i++;
      continue;
    }
    const prev = i > 0 ? code[i - 1]! : '';
    const next = i + 1 < code.length ? code[i + 1]! : '';
    const prev2 = i > 1 ? code[i - 2]! : '';
    let opStart = i;
    let rhsFrom = i + 1;
    if (next === '=') {
      i += 2; // ==
      continue;
    }
    if (prev === '<' || prev === '>') {
      if ((prev === '<' && prev2 === '<') || (prev === '>' && prev2 === '>')) {
        opStart = i - 2; // <<= / >>=（若 LHS 合法）
        rhsFrom = i + 1;
      } else {
        i++; // <= / >=
        continue;
      }
    } else if (prev !== '' && '+-*/%^&|'.includes(prev)) {
      opStart = i - 1; // += -= *= /= %= &= |= ^=（!&= / !|= 非法写法会被 LHS 形状门挡掉）
      rhsFrom = i + 1;
    } else if (prev === '!') {
      i++; // !=
      continue;
    }
    const lhs = code.slice(0, opStart);
    const rhs0 = code.slice(rhsFrom).trim();
    if (isVarRefLHS(lhs) && !PRINT_LIKE_LHS.test(lhs) && rhs0.length > 0) {
      // 前导 `@"…"`：剥掉表达式子集不认识的 `@` 再诊断（`\@` 条件插值由守卫整条挡掉）
      const rhs = rhs0.startsWith('@"') ? rhs0.slice(1) : rhs0;
      if (isHighConfidenceExprRhs(rhs) && !rhsBlockReason(rhs)) {
        out.push({ line: lineNo, expression: rhs, origin: 'assign' });
      }
    }
    i = rhsFrom;
  }
  // pass 3：字符串内容 → 插值表面（插值值位置上的字面量不提取，见 `display`）
  for (const s of spans) {
    if (s.display) continue;
    const content = code.slice(s.start, s.end);
    // 逐字串里的**内嵌引号**（`@"%FSYN("射精:射")%…"`、`@"%getHtmlXray("XRAY", W)%"`）：
    // 插值边界的裁决权在引擎的 formatted-string 扫描，本子集不重写 ⇒ 整串不提取
    // （既有 fail-open，与 `rhsBlockReason` 的"引号总数 > 2"同一条取舍）。
    if (s.verbatim && countUnescaped(content, '"') >= 2) continue;
    extractInterp(content, lineNo, out);
  }
}

/**
 * 全文表面提取（纯函数，单遍线性）：
 * 注释行 / `@` `#` `$` 指令行 / `[SKIPSTART]…[SKIPEND]` 区 / **data 块内所有行**不提取；
 * 其余行逐行 `scanCodeLine`。任何异常由调用方按"无发现"兜底。
 */
export function expressionSurfaces(text: string): ExpressionSurface[] {
  if (text.length === 0) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: ExpressionSurface[] = [];
  const dataStack: string[] = [];
  let inSkip = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (inSkip) {
      if (trimmed === '[SKIPEND]') inSkip = false;
      continue;
    }
    if (trimmed === '[SKIPSTART]') {
      inSkip = true;
      continue;
    }
    const head = /^([A-Za-z_]+)/.exec(trimmed)?.[1]?.toUpperCase();
    if (dataStack.length > 0) {
      // data 块内：只跟踪嵌套开/关，其余（台词原文）一律不碰
      if (head !== undefined && DATA_CLOSERS.has(head)) dataStack.pop();
      else if (head !== undefined && DATA_OPENERS.has(head)) dataStack.push(head);
      continue;
    }
    if (head !== undefined && DATA_OPENERS.has(head)) {
      dataStack.push(head);
      continue;
    }
    if (
      trimmed.length === 0 ||
      trimmed.startsWith(';') ||
      trimmed.startsWith('@') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('$')
    ) {
      continue;
    }
    scanCodeLine(trimmed, i + 1, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 收集（既有条件链 + T8 表面，同一 byLine 去重）
// ---------------------------------------------------------------------------

/**
 * 单记号快判（性能）：单数字 / 单标识符 / 单个闭合字符串**不可能**解析失败，
 * 直接放行——语料上这类表面占大头（`A:1 = 1`、`STR:0 = "ok"`），每个都跑全量
 * 词法+语法是装饰热路径的主要成本。
 */
const CANNOT_FAIL = /^(?:\d+|[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*|"[^"]*")$/;

/** 对"承载条件的控制流语句 + 赋值右侧 + 插值段"跑表达式诊断；返回波浪线条目（按行号升序，同一行只留第一条）。 */
export function collectExprSyntaxDecorations(
  text: string,
  scanControlFlow: (text: string) => readonly ControlFlowStatement[],
): ExprSyntaxDecoration[] {
  if (text.length === 0) return [];

  let statements: readonly ControlFlowStatement[];
  try {
    statements = scanControlFlow(text);
  } catch {
    return []; // 扫描异常：按"无发现"处理（保守，绝不把异常当成一条错）
  }

  /**
   * 诊断记忆化 + 单记号快判（性能，语料探针 p99 51ms 换来的）：同一文本内表达式高度
   * 重复（`%RESULTS%`、`LOCAL = 1`…），只付一次解析钱；单数字 / 单标识符 / 单个闭合
   * 字符串**不可能**解析失败，直接放行。按调用建 Map：跨文件不共享状态（纯函数纪律）。
   */
  const memo = new Map<string, ReturnType<typeof diagnoseExpression>>();
  const diagnose = (expr: string): ReturnType<typeof diagnoseExpression> => {
    let hit = memo.get(expr);
    if (hit === undefined) {
      hit = diagnoseExpression(expr);
      memo.set(expr, hit);
    }
    return hit;
  };

  const lines = text.split(/\r\n|\r|\n/);
  // 按行去重：同一行只保留第一条命中的装饰（Map 插入序 = 语句扫描序；条件链先入，
  // 同行上条件优先于表面——IF 行里的插值由条件链那条覆盖）
  const byLine = new Map<number, ExprSyntaxDecoration>();
  for (const stmt of statements) {
    if (!CONDITION_KINDS.has(stmt.kind)) continue;
    if (stmt.expression.trim() === '') continue;
    let diag: ReturnType<typeof diagnoseExpression>;
    try {
      diag = diagnose(stmt.expression);
    } catch {
      diag = null; // 诊断器异常同样按"无发现"处理
    }
    if (diag === null) continue;
    if (byLine.has(stmt.line)) continue;
    // D18「只在真表达式位判」的两道门（只在**已判错**时问，正常行零成本）：
    // 1) 散文证据 —— 语句关键字也可以是散文行首（语料：更新日志 .erb 里的
    //    `SELECTCASE RAND:X误写成SELECTCASE X`、`if 破瓜，先是独有部分…`）；
    if (looksLikeProse(stmt.expression)) continue;
    // 2) 折行续写证据 —— 扫描器只有单行视野，跨行实参表在它眼里永远是残句
    //    （语料：`SIF GROUPMATCH(…` 十二行 / `IF MAX(` + 五行 ITEM 列表）。
    if (continuesOnNextLines(stmt.expression, lines, stmt.line)) continue;
    const entry: ExprSyntaxDecoration = {
      line: stmt.line,
      message: diag.message,
      code: `erb.expr-${diag.kind}`,
    };
    // 列区间（1 基、UTF-16、半开）：定位不到字符（如 EOF 处）就不给，退回整行
    const base = expressionStartInLine(lines[stmt.line - 1], stmt.expression);
    const pos = diag.pos;
    if (base !== undefined && pos !== undefined && pos >= 0 && pos < stmt.expression.length) {
      entry.startColumn = base + pos + 1;
      entry.endColumn = entry.startColumn + charWidth(stmt.expression, pos);
    }
    byLine.set(stmt.line, entry);
  }

  // T8：赋值右侧 + 插值表面（提取 / 诊断任一异常都当"无发现"）
  let surfaces: readonly ExpressionSurface[] = [];
  try {
    surfaces = expressionSurfaces(text);
  } catch {
    surfaces = [];
  }
  for (const s of surfaces) {
    if (byLine.has(s.line)) continue;
    if (CANNOT_FAIL.test(s.expression)) continue;
    let diag: ReturnType<typeof diagnoseExpression> = null;
    try {
      diag = diagnose(s.expression);
    } catch {
      diag = null;
    }
    // 引号打头 + 词法错 = 字符串边界不可靠（语料实证：AA 美术图行里的 `\"` 转义把
    // 引号配对搅乱）。真 syntax 错（`"a" +`）照报；字符串自身的边界问题不猜。
    if (diag !== null && diag.kind === 'lexical' && s.expression.startsWith('"')) continue;
    if (diag === null) continue;
    // D18：折行续写的赋值右侧同理不判（语料 `乘数 += LIMIT(` + 六行实参，只有单行视野的
    // 提取器看到的是残句；表面对与语句面对共用同一条"接上后续行能解析"的证据）
    if (continuesOnNextLines(s.expression, lines, s.line)) continue;
    byLine.set(s.line, { line: s.line, message: diag.message, code: `erb.expr-${diag.kind}` });
  }

  return [...byLine.values()].sort((a, b) => a.line - b.line);
}
