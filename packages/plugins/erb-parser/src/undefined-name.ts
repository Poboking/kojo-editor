/**
 * ERB 未定义名诊断（S8，2026-10-23）。
 *
 * 「这个名字在本文件的已知声明集里查无」——已知集四类：`#DIM` 族声明、函数局部
 * （形参）、ERB 语言语义词（本层小表）、引擎保留名（**宿主从共用词表注入**，本层不收）。
 * 诊断码 `ERB_UNDEFINED_NAME`，严重度 warning，并给编辑距离 ≤ 2 的 did-you-mean 候选。
 *
 * ## 为什么只扫"表达式语境"
 *
 * ERB 的行是**多义**的：`PRINTFORMW 今日は晴れ` 里每个词都是散文，而
 * `IF 晴れ == 1` 里每个词是变量。词法本身分不清二者，可证明的边界只有"这行的
 * **语句关键字**决定了后续是表达式还是文本"。因此本模块只扫：
 * - 表达式语句（`IF` / `ELSEIF` / `SIF` / `SELECTCASE` / `CASE` / `REPEAT` /
 *   `FOR` / `WHILE` / `RETURN` / `RETURNARG` / `SWAP`）；
 * - **赋值形**行（`X = …` / `X:Y = …` / `X[0] += …`），但只查右侧与条件里的**读**。
 *
 * 其余行（PRINT 族、CALL 族、JUMP/GOTO 族、`@` / `#` / `$`、未知语句）**整行不扫**——
 * 宁可少报（漏报只是没有提示），不可把散文/函数名标成未定义变量（错标比不标危险）。
 *
 * ## 写位置 = 声明位（重要语义）
 *
 * Emuera 真实语料大量存在不写 `#DIM` 的隐式变量（`A = 0`、`FOR p, …`）。因此
 * **赋值目标与 FOR 循环变量一律并入已知集**，只对读位置报"未定义"：
 * 真正的拼写错误仍会在 `IF` / 右侧表达式里暴露，而写位置不会成片误报。
 * 字符串型目标的右侧还可能是无引号文本（`CNAME = 你这家伙`、地图数组整行文字），
 * 这类赋值整行不扫（`stringNames` 供宿主补跨文件类型）。
 *
 * ## 词法屏蔽（与 `references.ts` 单一真源）
 *
 * 可见行遍历复用 `visibleCodeLines`：字符串内容与 `;` 注释尾巴等长刷白、
 * `[SKIPSTART]…[SKIPEND]` 整段屏蔽、`@` / `#` / `$` 行不产出代码视野。
 * 因此字符串 / 注释 / 死代码段里的同名文字不会被当成变量引用。
 *
 * ## 刻意不报的形状（fail-open 清单）
 *
 * - 数字（首字符是 `\p{N}`）；
 * - 函数名（记号后（可隔空白）紧跟 `(` 的调用形）；
 * - ERB 语句/词运算符/字面量（见 `ERB_LANGUAGE_KEYWORDS`）与宿主注入的引擎保留名（`builtinNames`）；
 * - 显示指令行（`PRINT` 全族）——其后的整段是文本，`=` 也不例外；
 * - 成员访问与索引链（记号紧邻半/全角冒号，冒号两侧**可隔空白**）；
 * - 通配/展开形（成对 `%NAME%`）、`@` 作用域写法、`￥` 具名索引（`FLAG:￥人気`）；
 * - `[[ … ]]` 双括号文本/字符名字面量；
 * - 名字内符号（`・`/`（）`/`／`/`？`/零宽空格）紧邻的记号——它只是一个更长声明名的一段；
 * - 字符串型伪变量（含 `STR`/`ARGS`/`TSTR`/`SAVESTR`/`NICKNAME`）赋值的整行；
 * - 赋值目标以数字开头（Emuera 标识符不许数字开头 ⇒ 那是散文被 `=` 误判）；
 * - CALLFORM 等动态调用行（整行不扫，见上）。
 *
 * 纯函数：文本 + 已知名集进、诊断数组出；不读盘、不碰工程状态。
 */
import type { LineDecoration } from '@kojo/plugin-api';
import { isErbDialectPath, MODEL_TOKEN_CLASS } from '@kojo/plugin-api';
import { DEFAULT_MAX_EDIT_DISTANCE, DEFAULT_MAX_SUGGESTIONS, suggestNames } from './did-you-mean';
import { splitErbLines, visibleCodeLines, type VisibleCodeLine } from './references';
import { parseErbText } from './scanner';

/** 诊断码（问题面板 / 工具提示分组；与同批 `ERB_ARITY_MISMATCH` 同一稳定标识口径） */
export const ERB_UNDEFINED_NAME = 'ERB_UNDEFINED_NAME' as const;

/**
 * 一条未定义名诊断。结构是 `LineDecoration` 的**超集**（多带名字与候选），
 * 因此可直接交给装饰器消费；候选也拼进了中文消息，面板不认扩展字段时仍有可读文案。
 */
export interface UndefinedNameDiagnostic extends LineDecoration {
  readonly severity: 'warning';
  readonly message: string;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly code: typeof ERB_UNDEFINED_NAME;
  /** 原文记号（保留大小写与 CJK 原形） */
  readonly name: string;
  /** 确定性排序的近名候选（可能为空） */
  readonly suggestions: readonly string[];
}

/**
 * 输入：文本 + 四类已知声明 + 可选外部名录。
 *
 * `dimNames` / `localNames` **缺省时从文本自身解析**（`#DIM` 族与形参；
 * 与 `parseErbText` 同一份判据）；显式传入时与解析结果**合并**——只会多认名字，
 * 不会因宿主漏传一格而制造误报。
 */
export interface UndefinedNameDiagnosticsInput {
  /** 文件文本（`.erb` / `.erm` / `.erh`；不传 `path` 时按方言文本处理） */
  readonly text: string;
  /** 共用扫描产物：`lines` = `splitErbLines` 产物（本模块一轮读三趟全文）；`visible` = `visibleCodeLineList` 产物（两趟共用） */
  readonly lines?: readonly string[];
  readonly visible?: readonly VisibleCodeLine[];
  /**
   * 文件路径（可选）。给了就按 `isErbDialectPath` 做方言门——`.kojo` 等非方言
   * 一律零诊断（语法诊断另有糖线）。不传 = 调用方已自行把门。
   */
  readonly path?: string;
  /** `#DIM` / `#DIMS` / `#DEFINE` 等声明名（与文本解析结果合并） */
  readonly dimNames?: readonly string[];
  /** 局部声明名（形参等；与文本解析结果合并，按全文件已知处理） */
  readonly localNames?: readonly string[];
  /**
   * 系统内置名（**宿主注入**）。
   *
   * 引擎保留名的真源是 `@kojo/plugin-api` 的 `ERB_ENGINE_RESERVED_IDENTIFIERS`
   * （跨 era 引擎级事实，不属于本规则）；装配处 `createErbParserPlugin` 缺省就取它。
   * **本规则不内置回落表**：没传 ⇒ 那些名字按未定义报，不猜。
   */
  readonly builtinNames?: readonly string[];
  /** 引擎 globals（适配器 / 字典注入；跨游戏通用层不解释） */
  readonly engineGlobalNames?: readonly string[];
  /**
   * 字符串型**引擎**伪变量（**宿主注入**；真源 = `ERB_ENGINE_STRING_IDENTIFIERS`）。
   *
   * 与 {@link stringNames} 同一个行为（赋值右侧整行不扫），差别只在来源：这里是
   * 引擎内建（跨 era 恒有），那里是适配器 / 工程索引的声明。
   */
  readonly engineStringNames?: readonly string[];
  /** 其它外部已知名（与上面几项合并） */
  readonly knownNames?: readonly string[];
  /**
   * 外部**字符串型**声明名（适配器 / 工程索引注入）。
   *
   * 赋值右侧在 ERB 里可以是无引号文本（`CNAME = 你这家伙`、地图数组整行文字），
   * 字符串型目标的右侧因此**整段不扫**；`dimNames` 只有名字没有类型，跨文件类型
   * 需要宿主从这里补。文本内 `#DIMS` / `#DIMSTR` / `#DIMCHAR` 已自动识别。
   */
  readonly stringNames?: readonly string[];
  /** 每条诊断最多给几个候选（缺省 {@link DEFAULT_MAX_SUGGESTIONS}） */
  readonly maxSuggestions?: number;
}

/** 只扫"关键字之后是表达式"的语句；其余语句整行不进入词法视野 */
const EXPRESSION_STATEMENTS: ReadonlySet<string> = new Set([
  'IF',
  'ELSEIF',
  'SIF',
  'SELECTCASE',
  'CASE',
  'REPEAT',
  'FOR',
  'WHILE',
  'RETURN',
  'RETURNARG',
  'SWAP',
]);

/**
 * ERB **语言语义**词：关键字 / 字面量 / 词运算符 / 语言槽位——它们不是变量引用。
 *
 * 只收"说这句话的那门语言"本身的东西：作用域声明词（`LOCAL` / `GLOBAL` 族）、
 * 字面量（`NULL` / `TRUE` / `FALSE` / `NONE`）、词运算符与 `CASE` 语法词（`AND` / `OR` /
 * `XOR` / `IS` / `TO` / `ELSE`）。
 *
 * **引擎级名字一枚都不在这里**（LAU-D2，2026-10-27）：族头、引擎标量、系统变量都是
 * "跨 era 恒有定义的名"，真源在 `@kojo/plugin-api` 的 `ERB_ENGINE_RESERVED_IDENTIFIERS`，
 * 由宿主经 {@link UndefinedNameDiagnosticsInput.builtinNames} **注入**——本包不存词表、
 * 也不内置回落表（没有词表 ⇒ 不认识的名字照报，不猜）。具体常量（`C_PINK` 一类）仍属
 * 适配器名录，走 `engineGlobalNames`，本层不抄第二份游戏知识。
 */
const ERB_LANGUAGE_IDENTIFIERS: readonly string[] = [
  // 语言层作用域词（`#DIM` 家族声明的作用域；不是引擎变量族）
  'LOCAL',
  'LOCALS',
  'GLOBAL',
  'GLOBALS',
  // 字面量
  'NULL',
  'TRUE',
  'FALSE',
  'NONE',
  // 词运算符 / CASE 语法词（Emuera 表达式里的别名写法）
  'AND',
  'OR',
  'XOR',
  'IS',
  'TO',
  'ELSE',
];

const ERB_LANGUAGE_KEYWORDS: ReadonlySet<string> = new Set(ERB_LANGUAGE_IDENTIFIERS);

/**
 * 字符串型的**语言槽位**：赋值右侧可以是无引号文本，整行不扫。
 *
 * 引擎侧的字符串伪变量（`NAME` / `CALLNAME` / `STR` / `TSTR` / `SAVESTR` …）真源在
 * `@kojo/plugin-api` 的 `ERB_ENGINE_STRING_IDENTIFIERS`，由宿主经
 * {@link UndefinedNameDiagnosticsInput.engineStringNames} 注入；本层只留语言自己的槽位。
 *
 * 语料实证（eraTW 4.980）：`ARGS = 共通` / `STR:16 = 破旧小屋` / `TSTR:1 = 科技蓝白呼吸`
 * 这类写法有 150+ 处——右侧的裸词是作者写的**文本**，不是变量引用。
 */
const STRING_LANGUAGE_IDENTIFIERS: ReadonlySet<string> = new Set(['LOCALS']);

/**
 * 赋值形行首：`名字` + 可选索引链（`[..]` / `:..`）+ 赋值运算符。
 *
 * 要求索引链**紧贴名字**（中间只许空白，见 `(?:[\t \u3000]*…)` 的外层），
 * 因此 `MESSAGE A = B` 这类"关键字 + 散文里恰好有等号"的行不会误命中。
 */
const ASSIGN_LINE_RE = new RegExp(
  `^[\\t \\u3000]*${MODEL_TOKEN_CLASS}+` +
    `(?:[\\t \\u3000]*(?:\\[[^\\]]*\\]|:[^\\s=;,]+))*` +
    `[\\t \\u3000]*(?:\\+|-|\\*|\\/|%|'|&|\\||\\^)?=(?!=)`,
  'u',
);

/** 记号切分（与 `MODEL_TOKEN_CLASS` 同一把尺：Unicode 字母/数字/下划线） */
const TOKEN_RUN = new RegExp(`${MODEL_TOKEN_CLASS}+`, 'gu');

/** 行首语句关键字（只认 ASCII 字母下划线；与 `visibleCodeLines` 的 CALL 判据同形） */
const LEADING_WORD_RE = /^[A-Za-z_]+/;

/**
 * 行首是 Emuera 的显示指令（`PRINT` / `PRINTL` / `PRINTFORM…` / `PRINTBUTTON…` 全族以
 * `PRINT` 开头）。
 *
 * 语料实证：`PRINTL =-._　…` 这类 ASCII 画/台词里带 `=`，会被赋值形预筛当成
 * "`PRINTL` = 一段表达式"——100 处误报全部来自这一条误判。显示指令之后的整段是文本，
 * 词法上与变量引用不可区分 ⇒ 整行不扫（与"PRINT 族整行不扫"的既定口径一致）。
 */
function isDisplayStatement(lead: string | undefined): boolean {
  return lead !== undefined && lead.startsWith('PRINT');
}

/** 行首名字（含 CJK；用于识别赋值目标） */
const LEADING_NAME_RE = new RegExp(`^[\\t \\u3000]*(${MODEL_TOKEN_CLASS}+)`, 'u');

/** `FOR <循环变量>, 起点, 终点`：循环变量是语法声明位（真实语料大量不写 #DIM） */
const FOR_HEAD_RE = /^[\t \u3000]*FOR[\t \u3000]+([^\s,]+)/i;

/** 首字符是数字 ⇒ 数值字面量，不是变量引用 */
const STARTS_WITH_NUMBER = /^\p{N}/u;

/** 含非 ASCII 字符（CASE 的无引号文本 / 名字内符号） */
const HAS_NON_ASCII = /[^\x00-\x7f]/;

const COLON_HALF = 0x3a;
const COLON_FULL = 0xff1a;
const DOUBLE_QUOTE = 0x22;
const BACKSLASH = 0x5c;
const SEMICOLON = 0x3b;
const PERCENT = 0x25;
const FULLWIDTH_PERCENT = 0xff05;
const AT_SIGN = 0x40;
const OPEN_PAREN = 0x28;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const YEN_HALF = 0xa5;
const YEN_FULL = 0xffe5;
const SPACE = 0x20;
const TAB = 0x09;
const FULLWIDTH_SPACE = 0x3000;

/** 记号紧邻半/全角冒号（变量成员 / 索引链的另一段） */
function colonAdjacent(text: string, start: number, end: number): boolean {
  // 语料实证：Emuera 允许冒号两侧带空白（`TALENT: 恋慕`、`SELECTCASE RAND : 5`）。
  // 只认零距离会把索引里的 CSV 名与 `RAND`/`TALENT` 这类族头全标成未定义变量。
  let i = start - 1;
  while (i >= 0 && isErbSpace(text.charCodeAt(i))) i--;
  if (i >= 0) {
    const before = text.charCodeAt(i);
    if (before === COLON_HALF || before === COLON_FULL) return true;
  }
  let j = end;
  while (j < text.length && isErbSpace(text.charCodeAt(j))) j++;
  if (j < text.length) {
    const after = text.charCodeAt(j);
    if (after === COLON_HALF || after === COLON_FULL) return true;
  }
  return false;
}

/** 行内空白（半角空格 / 制表 / 全角空格）——冒号两侧与显示文本判定共用 */
function isErbSpace(code: number): boolean {
  return code === SPACE || code === TAB || code === FULLWIDTH_SPACE;
}

/**
 * 记号紧邻 `%` 的**成对**展开形（`%NAME%`）、`@` 作用域写法或 `￥` 具名索引标记——不猜。
 *
 * `FLAG:￥人気` 的 `￥`（半/全角圆）是引擎的"具名索引"前缀，后面的名字不是变量引用。
 * `%` 只认两侧配对：`A%B` 是取模运算符，不该把 A / B 一并放过（那是漏报）。
 */
function wildAdjacent(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text.charCodeAt(start - 1) : -1;
  const after = end < text.length ? text.charCodeAt(end) : -1;
  return (
    (before === PERCENT && after === PERCENT) ||
    before === AT_SIGN ||
    after === AT_SIGN ||
    before === YEN_HALF ||
    before === YEN_FULL ||
    after === YEN_HALF ||
    after === YEN_FULL
  );
}

/** 具名索引 / `[[ … ]]` 字面量区段：记号落在里面就不算变量引用（一次算、多记号查） */
type Range = readonly [start: number, endExclusive: number];

/**
 * 名字内部符号（`・` 等）——记号紧邻它们时，说明它只是**一个更长声明名的一段**。
 *
 * 语料实证：`#DIM CONST P37夢幻遺跡・一階通路 = 37` 的声明名含 `・`，而记号尺
 * （`MODEL_TOKEN_CLASS`，与着色同源、不许在本层另开一把）会在 `・` 处切开，
 * 于是 `P37夢幻遺跡` / `一階通路` 两段都查不到声明——这类误报在语料里成片出现。
 * ERB 表达式没有 `・` 运算符，故紧邻即"更长名字的一段"是安全判据（宁可漏报）。
 */
const NAME_INTERNAL_SYMBOLS: ReadonlySet<number> = new Set([
  0x30fb, // ・ 中点
  0xff65, // ･ 半角中点
  0x200b, // ​ 零宽空格（语料把 `P235​​舞​的房間` 原样声明成名字）
  0xff08, // （
  0xff09, // ）
  0xff0f, // ／
  0xff1f, // ？
]);

function nameInternalAdjacent(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text.charCodeAt(start - 1) : -1;
  const after = end < text.length ? text.charCodeAt(end) : -1;
  return NAME_INTERNAL_SYMBOLS.has(before) || NAME_INTERNAL_SYMBOLS.has(after);
}

/** 索引名字符串的终止符：空白与表达式运算符（`・～／` 这类名字内符号不算） */
const INDEX_TERMINATORS: ReadonlySet<number> = new Set([
  SPACE,
  TAB,
  FULLWIDTH_SPACE,
  COLON_HALF,
  COLON_FULL,
  0x2c, // ,
  0x29, // )
  0x5d, // ]
  0x7d, // }
  0x3d, // =
  0x2b, // +
  0x2d, // -
  0x2a, // *
  0x2f, // /
  0x25, // %
  0x27, // '
  0x26, // &
  0x7c, // |
  0x5e, // ^
  0x3c, // <
  0x3e, // >
  0x21, // !
  0x3f, // ?
  0x3b, // ;
]);

/** `:名字` / `￥名字` 的区段：把 `TALENT:ARG:幼児／幼児退行` 整段屏蔽 */
function collectIndexRanges(text: string): Range[] {
  const ranges: Range[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== COLON_HALF && code !== COLON_FULL && code !== YEN_HALF && code !== YEN_FULL) continue;
    let j = i + 1;
    while (j < text.length && !INDEX_TERMINATORS.has(text.charCodeAt(j))) j++;
    if (j > i + 1) ranges.push([i + 1, j]);
    i = j - 1;
  }
  return ranges;
}

/** `[[ … ]]` 字面量区段；没闭合就不屏蔽（宁可漏，不可错） */
function collectBracketRanges(text: string): Range[] {
  const ranges: Range[] = [];
  for (let i = 0; i + 1 < text.length; i++) {
    if (text.charCodeAt(i) !== OPEN_BRACKET || text.charCodeAt(i + 1) !== OPEN_BRACKET) continue;
    let j = i + 2;
    while (j + 1 < text.length) {
      if (text.charCodeAt(j) === CLOSE_BRACKET && text.charCodeAt(j + 1) === CLOSE_BRACKET) break;
      j++;
    }
    if (j + 1 >= text.length) continue;
    ranges.push([i + 2, j]);
    i = j + 1;
  }
  return ranges;
}

/** 记号完全落在任一区段内 */
function insideRanges(ranges: readonly Range[], start: number, end: number): boolean {
  for (const [from, to] of ranges) {
    if (start >= from && end <= to) return true;
  }
  return false;
}

/**
 * 记号后（可隔空白）紧跟 `(` ⇒ 函数调用形，不是变量引用。
 *
 * 真实语料存在 `FINDELEMENT (K17C_RTF, ARG:0)` 这种**名字与括号之间带空格**的写法，
 * 只认零距离会把函数名标成未定义变量。
 */
function callAdjacent(text: string, end: number): boolean {
  let i = end;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code !== SPACE && code !== TAB && code !== FULLWIDTH_SPACE) break;
    i++;
  }
  return i < text.length && text.charCodeAt(i) === OPEN_PAREN;
}

/** 从 `open`（指向双引号）跳到闭引号**之后**；`\` 转义跳过下一字符；未闭合返回行尾 */
function skipQuoted(raw: string, open: number): number {
  for (let i = open + 1; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code === BACKSLASH) {
      i++;
      continue;
    }
    if (code === DOUBLE_QUOTE) return i + 1;
  }
  return raw.length;
}

/** 把 `[from, to)` 刷成等长空格（列坐标口径不变） */
function blankRange(chars: string[], from: number, to: number): void {
  for (let i = from; i < to; i++) chars[i] = ' ';
}

/**
 * 行内字符串的**补齐屏蔽**：只在共享 `codeView()` 的朴素引号配对会跑偏时启用。
 *
 * 两处确证跑偏（批次十二，真语料剩余命中的唯一误报类别）：
 * ① `\"` 转义——CASE 字符表 `"\"", …` 会让其后的开/闭引号整体翻转，`"l"` / `"y"` 泄漏；
 * ② `@"…%…%"` 插值串——插值里还能再放字符串（`%COND_STR("_Nude", …)%`），嵌套引号同样翻转。
 *
 * 判据只收"确证是字符串内容"的位置：`%…%` 之内是**表达式**，其中记号照常参与判定
 * （见 `undefined-name.test.ts` 的反证用例）。产出与原文**等长**，列坐标不变；
 * 其它行仍走 `visibleCodeLines().codeView()`（字符串/注释屏蔽的单一真源）。
 */
function maskQuotedLiterals(raw: string): string | null {
  if (!raw.includes('\\"') && !raw.includes('@"')) return null;
  const chars = raw.split('');
  let i = 0;
  while (i < raw.length) {
    const code = raw.charCodeAt(i);
    if (code === SEMICOLON) {
      blankRange(chars, i, raw.length);
      break;
    }
    if (code !== DOUBLE_QUOTE) {
      i++;
      continue;
    }
    const interpolated = i > 0 && raw.charCodeAt(i - 1) === AT_SIGN;
    if (!interpolated) {
      const after = skipQuoted(raw, i);
      blankRange(chars, i + 1, after);
      i = after;
      continue;
    }
    // `@"…"`：串体刷白，`%…%` 插值段保留为代码（段内字符串照常刷白）
    let j = i + 1;
    let contentStart = j;
    while (j < raw.length) {
      const inner = raw.charCodeAt(j);
      if (inner === BACKSLASH) {
        j += 2;
        continue;
      }
      if (inner === PERCENT) {
        blankRange(chars, contentStart, j);
        j++;
        while (j < raw.length) {
          const exprCode = raw.charCodeAt(j);
          if (exprCode === DOUBLE_QUOTE) {
            const after = skipQuoted(raw, j);
            blankRange(chars, j + 1, after);
            j = after;
            continue;
          }
          j++;
          if (exprCode === PERCENT) break;
        }
        contentStart = j;
        continue;
      }
      if (inner === DOUBLE_QUOTE) {
        blankRange(chars, contentStart, j);
        j++;
        break;
      }
      j++;
    }
    if (j >= raw.length) blankRange(chars, contentStart, raw.length);
    i = j;
  }
  return chars.join('');
}

/** 声明名归一：去 `;` 行注释尾巴、去尾部数组维度（旧式 `#DIM NAME[10]`）与空白 */
function declaredBaseName(raw: string): string {
  return raw.replace(/;.*$/, '').replace(/\[[^\]]*\]\s*$/, '').trim();
}

/** 往已知集里并入一批名字（大小写归一；保留首个原形供 did-you-mean 展示） */
function addNames(target: Map<string, string>, names: readonly string[] | undefined): void {
  if (names === undefined) return;
  for (const raw of names) {
    const name = declaredBaseName(raw);
    if (name.length === 0) continue;
    const upper = name.toUpperCase();
    if (!target.has(upper)) target.set(upper, name);
  }
}

/** 一个作用域的已知集：判定 + did-you-mean 候选池 */
interface KnownScope {
  has(upper: string): boolean;
  /** 候选池（延迟到第一次建议时构建） */
  candidates(): readonly string[];
}

/**
 * 收集未定义名诊断（**纯函数**、确定性输出）。
 *
 * 输出顺序 = 可见行序 → 行内记号序；每条诊断带 1 基列区间（不含端点，与 Monaco 同口径）。
 * 建议候选来自**当前作用域**（文件级已知 + 该函数的形参），并按
 * `did-you-mean.ts` 的确定性排序；距离阈值固定 ≤ 2。
 */
export function collectUndefinedNameDiagnostics(input: UndefinedNameDiagnosticsInput): UndefinedNameDiagnostic[] {
  const text = input.text ?? '';
  if (text.length === 0) return [];
  if (input.path !== undefined && !isErbDialectPath(input.path)) return [];

  // 全文的三趟读取共用一份产物（语义诊断那一轮四家消费方都走这条）：
  // 行数组一次切好，可见行摊平后**赋值目标趟与主扫描趟重复迭代同一份数组**。
  const rawLines = input.lines ?? splitErbLines(text);
  const visible = input.visible ?? [...visibleCodeLines(text)];

  const parsed = parseErbText(text, '<undefined-name>', rawLines);

  // ---- 文件级已知名（#DIM + 四类外部名录）----
  const baseDisplay = new Map<string, string>();
  addNames(baseDisplay, ERB_LANGUAGE_IDENTIFIERS);
  addNames(baseDisplay, input.builtinNames);
  addNames(baseDisplay, input.engineGlobalNames);
  addNames(baseDisplay, input.knownNames);
  addNames(baseDisplay, input.localNames);
  addNames(baseDisplay, input.dimNames);
  // 文本自身的 #DIM 族声明始终并入（与 parseErbText 同一份判据）
  addNames(baseDisplay, parsed.dims.map((dim) => dim.name));

  // ---- 字符串型声明（赋值右侧可能是无引号文本，整行不扫）----
  const stringVars = new Set<string>(STRING_LANGUAGE_IDENTIFIERS);
  for (const name of input.engineStringNames ?? []) stringVars.add(name.toUpperCase());
  for (const dim of parsed.dims) {
    if (dim.directive === 'DIMS' || dim.directive === 'DIMSTR' || dim.directive === 'DIMCHAR') {
      const name = declaredBaseName(dim.name);
      if (name.length > 0) stringVars.add(name.toUpperCase());
    }
  }
  for (const raw of input.stringNames ?? []) {
    const name = declaredBaseName(raw);
    if (name.length > 0) stringVars.add(name.toUpperCase());
  }

  // ---- FOR 循环变量：语法声明位（真实语料大量 `FOR p, …` 而不写 #DIM）----
  for (const raw of rawLines) {
    const head = FOR_HEAD_RE.exec(raw);
    if (head?.[1] === undefined) continue;
    const name = declaredBaseName(head[1]);
    if (name.length === 0) continue;
    const upper = name.toUpperCase();
    if (!baseDisplay.has(upper)) baseDisplay.set(upper, name);
  }

  // ---- 赋值目标：Emuera 允许隐式变量，写位置就是声明位（语料大量 `A = 0`）----
  // 只对**读**位置报告；写位置一律并入已知集（否则真实语料会成片误报）。
  for (const lineInfo of visible) {
    if (lineInfo.isDefinition) continue;
    const raw = lineInfo.raw;
    if (!raw.includes('=')) continue;
    const lead = LEADING_WORD_RE.exec(raw.trim())?.[0]?.toUpperCase();
    if (lead !== undefined && EXPRESSION_STATEMENTS.has(lead)) continue;
    if (isDisplayStatement(lead)) continue;
    const code = maskQuotedLiterals(raw) ?? lineInfo.codeView();
    if (!ASSIGN_LINE_RE.test(code)) continue;
    const lhs = LEADING_NAME_RE.exec(code)?.[1];
    if (lhs === undefined || STARTS_WITH_NUMBER.test(lhs)) continue;
    const name = declaredBaseName(lhs);
    if (name.length === 0) continue;
    const upper = name.toUpperCase();
    if (!baseDisplay.has(upper)) baseDisplay.set(upper, name);
  }

  let baseCandidates: readonly string[] | undefined;
  const baseScope: KnownScope = {
    has: (upper) => baseDisplay.has(upper),
    candidates: () => (baseCandidates ??= [...baseDisplay.values()]),
  };

  // ---- 函数作用域（形参）：按函数起始行缓存 ----
  const paramCandidates = new Map<number, readonly string[]>();
  const paramDisplayByStart = new Map<number, Map<string, string>>();
  for (const fn of parsed.functions) {
    const map = new Map<string, string>();
    for (const param of fn.params) {
      const name = declaredBaseName(param.name);
      if (name.length === 0) continue;
      const upper = name.toUpperCase();
      if (!map.has(upper)) map.set(upper, name);
    }
    paramDisplayByStart.set(fn.startLine, map);
  }

  const perFunctionScope = (startLine: number | undefined): KnownScope => {
    if (startLine === undefined) return baseScope;
    const params = paramDisplayByStart.get(startLine);
    if (params === undefined || params.size === 0) return baseScope;
    return {
      has: (upper) => baseDisplay.has(upper) || params.has(upper),
      candidates: () => {
        const cached = paramCandidates.get(startLine);
        if (cached !== undefined) return cached;
        const merged = [...baseDisplay.values()];
        for (const [upper, display] of params) if (!baseDisplay.has(upper)) merged.push(display);
        paramCandidates.set(startLine, merged);
        return merged;
      },
    };
  };

  const maxSuggestions = Math.max(0, Math.trunc(input.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS));
  const out: UndefinedNameDiagnostic[] = [];
  const functions = parsed.functions;
  let fnIndex = 0;

  for (const lineInfo of visible) {
    if (lineInfo.isDefinition) continue;

    // 当前行所属函数（形参作用域）；函数区间由 parseErbText 收紧，互不重叠
    while (fnIndex < functions.length && functions[fnIndex]!.endLine < lineInfo.line) fnIndex++;
    const current = functions[fnIndex];
    const inFunction = current !== undefined && current.startLine <= lineInfo.line && lineInfo.line <= current.endLine;
    const scope = perFunctionScope(inFunction ? current!.startLine : undefined);

    const raw = lineInfo.raw;
    const trimmed = raw.trim();
    const lead = LEADING_WORD_RE.exec(trimmed);
    const keyword = lead?.[0]?.toUpperCase();
    const isExpressionLine = keyword !== undefined && EXPRESSION_STATEMENTS.has(keyword);
    const isDisplay = isDisplayStatement(keyword);
    // 廉价预筛：只有表达式语句或原文带 `=` 的行才需要代码视野（避免全篇逐行刷白）
    if (!isExpressionLine && (isDisplay || !raw.includes('='))) continue;
    const code = maskQuotedLiterals(raw) ?? lineInfo.codeView();
    // 表达式语句或赋值形才进入词法扫描；其余行整行不扫（散文 / 函数名 / 动态调用）
    if (!isExpressionLine && (isDisplay || !ASSIGN_LINE_RE.test(code))) continue;
    // 字符串型赋值目标的右侧可以是无引号文本（`CNAME = 你这家伙`、地图数组整行文字），
    // 词法上与变量引用不可区分 ⇒ 整行跳过（fail-open）。
    if (!isExpressionLine) {
      const lhs = LEADING_NAME_RE.exec(code)?.[1];
      if (lhs === undefined || STARTS_WITH_NUMBER.test(lhs)) continue;
      if (stringVars.has(lhs.toUpperCase())) continue;
    }

    // 具名索引链 / `[[ … ]]` 字面量：一次算区段，行内多记号共用
    const indexRanges = collectIndexRanges(code);
    const bracketRanges = collectBracketRanges(code);
    // `CASE` 的值常是无引号文本（`CASE P512魔理沙宅・寝室`）；含非 ASCII 的记号不猜
    const isCaseLine = keyword === 'CASE';

    for (const match of code.matchAll(TOKEN_RUN)) {
      const start = match.index ?? 0;
      const token = match[0];
      const end = start + token.length;
      if (STARTS_WITH_NUMBER.test(token)) continue;
      const upper = token.toUpperCase();
      if (ERB_LANGUAGE_KEYWORDS.has(upper) || EXPRESSION_STATEMENTS.has(upper)) continue;
      if (colonAdjacent(code, start, end)) continue;
      if (nameInternalAdjacent(code, start, end)) continue;
      if (wildAdjacent(code, start, end)) continue;
      if (insideRanges(indexRanges, start, end)) continue;
      if (insideRanges(bracketRanges, start, end)) continue;
      if (isCaseLine && HAS_NON_ASCII.test(token)) continue;
      // 全角 `％` 是名字后缀 / 通配标记（`増加_２０％`），不是取模
      if (end < code.length && code.charCodeAt(end) === FULLWIDTH_PERCENT) continue;
      if (callAdjacent(code, end)) continue;
      if (scope.has(upper)) continue;

      const suggestions = maxSuggestions === 0
        ? []
        : suggestNames(token, scope.candidates(), {
            maxDistance: DEFAULT_MAX_EDIT_DISTANCE,
            limit: maxSuggestions,
          });
      out.push({
        line: lineInfo.line,
        severity: 'warning',
        message: buildMessage(token, suggestions),
        startColumn: start + 1,
        endColumn: end + 1,
        code: ERB_UNDEFINED_NAME,
        name: token,
        suggestions,
      });
    }
  }

  return out;
}

/** 中文诊断文案：名字 + 依据 + did-you-mean（无候选时不硬凑一句"没有建议"） */
function buildMessage(name: string, suggestions: readonly string[]): string {
  const base = `未定义的名称「${name}」：不在已知声明（#DIM / 局部 / 内置 / 引擎全局）中`;
  if (suggestions.length === 0) return `${base}。`;
  const quoted = suggestions.map((suggestion) => `「${suggestion}」`).join('、');
  return `${base}；你是不是想写${quoted}？`;
}
