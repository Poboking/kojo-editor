/**
 * 赋值 / 调用 / 输出行的中文显示形（**任务线 ZH-S**）。
 *
 * 覆盖面（认得出就翻，认不出返回 `null`，**绝不原样返回**）：
 * - 赋值：`<族头>[:作用域][:索引] = 值`（`+= -= *= /= |= '=` 同形）——族头经 `lookup.familyAlias`
 *   换成中文别名（`TFLAG:193 = 1` → `时标:193 = 1`）；查不到别名就保留族头原名，**但整行仍必须
 *   是中文形**（`RESULT` / `LOCAL` 这类语言层槽位给中文显示名）；左值既不是引擎族头、也不是
 *   语言层槽位，而**形状**仍是一个引用（`服装 = 裸` / `順位 -= 1` / `CFLAG:100(%A(B)%) = 1`）时
 *   ⇒ **载荷逐字带走，只加 `赋值` 词头**（判据与"为什么不翻"见 `isDataReference` 头注）；
 *   `'=`（ver1813 起的字符串赋值运算符）与 `|=`（按位或赋值）只补进既有运算符表，
 *   显示形原样保留运算符记号——两者与 `+=` 同一档，**不另造动词、不改写语义**；
 * - `TIMES <引用>, <数值>`：Emuera 的**小数乘算赋值**（文档口径 `TIMES A, 1.5` ⇔
 *   `A = A × 1.5`，结果取整）⇒ `乘算 <目标> × <数值>`。真语料 3,143 行**全部**是
 *   "恰好一个逗号 + 右值是数值字面量"（取证见 `renderTimes` 头注），其余形状一律 `null`；
 * - 裸自增 / 自减：`<引用> ++` / `<引用>--`（后缀）与 `++<引用>` / `-- <引用>`（前缀）——
 *   `自增 <目标>` / `自减 <目标>`；目标与赋值左值**同一把尺子**（`renderTarget` 的族头别名 /
 *   语言层槽位，查不到时 `isDataReference` 判形状、载荷逐字）。后缀形是语料大盘
 *   （`ABL:親密 ++` / `CFLAG:1:1009 ++`，实测 1,371 行），前缀形盘上 0 例、防御性认领；
 * - 调用：`CALL` / `CALLL` / `CALLFORM` / `CALLF` / `TRYCALL` / `TRYCALLFORM` / `TRYJUMP` /
 *   `TRYGOTO` / `TRYGOTOFORM`（后两枚 = `sugar-ident` 的 `TRY_SINGLE_LINE` 单行档，
 *   **不在** ZH-C 认领的那九枚开块词里）；
 * - 位原语：`SETBIT` / `CLEARBIT` / `INVERTBIT`；
 * - 输出族：`PRINT` / `PRINTL` / `PRINTW` / `PRINTV` / `PRINTVL` / `PRINTFORM*` / `PRINTDATA*` /
 *   `PRINTSINGLE*`（已有台词投影的形态**不要重复接管**，只补 `native()` 落到的那些变体）；
 * - 排版与等待：`SETCOLOR` / `RESETCOLOR` / `FONTBOLD` / `FONTITALIC` / `FONTSIZE` /
 *   `FONTREGULAR` / `FONTSTYLE` / `CLEARLINE`（**带不带参数都认**）/ `HTML_PRINT` /
 *   `FORCEWAIT` / `WAIT` / `DRAWLINE` / `BAR` / `BARL` / `REDRAW` / `VARSET`；
 * - 输入：`INPUT` / `INPUTS` / `PRINTBUTTON` / `PRINTBUTTONC`。
 *
 * 与 ZH-C 的分工：**本层只管"非块、非预处理"的行**；两条 pass 不许互相 import。
 * TRY 家族按**档位**分家（不是按前缀）：开块九枚归 ZH-C 的 `试探 原形 …`，
 * 单行档（`sugar-ident` 的 `TRY_SINGLE_LINE`）归本表的动词语——名单只有一份，互斥由测试钉。
 *
 * ## 口径备忘（写死在这里，免得读代码的人猜）
 * - 语言层槽位中文名：`LOCAL→局部` `LOCALS→局部$` `LOCALSS→局部表` `RESULT→结果`
 *   `RESULTS→结果$` `COUNT→计数` `COUNTS→计数$` `COUNTSS→计数表` `SUCCESS→成否`；
 *   `ARG→实参` / `ARGS→实参$` **复用 `keywords.ts` 的单一真源**（1 基换算：`ARG:k → 实参:(k+1)`，
 *   与 `argTokenCnLabel` 同口径），本层不另造第二套。
 * - 行尾节奏记号沿用投影既有语言：换行不等待 → ` 续`，等待 → ` 等待`，空体 → `空行`。
 * - 参数体（`%VAR%`、`@"…"`、函数名、数字索引）**原样照抄**——行内残留英文记号是允许的，
 *   红线只禁"整行逐字等于源行"。
 * - **赋值不是语句**：左值查不到别名、也不是语言层槽位，但形状仍是一个引用时 ⇒ 与"数据表条目
 *   正文逐字透传"同一档，形 = `赋值 <左值> <op> <右值>`（词头换中文、左右两侧文字一个字符不动，
 *   只重铺运算符两侧空白；理由见 `isDataReference` 头注）。这一档**不进 `KEYWORDS`**
 *   （显示形不承诺可写，与 `分组` / `试探` 同例）。
 * - 认不出 ⇒ `null`（`passes.ts` 负责显式兜底），宁缺勿猜。
 */

import { isIdentPart, isIdentStart } from '../identifier-chars';
import { VARIADIC_ARG_NUMERIC, VARIADIC_ARG_STRING } from '../keywords';
import { TRY_SINGLE_LINE } from '../sugar-ident';
import type { NativeDisplayInput, NativeDisplayLookup, NativeDisplayPass } from './types';

/* ==================== 词法小工具（行级，不建 token 流） ==================== */

/** 剥行尾 `;` 注释（引号内的 `;` 不算）；注释原样回填到渲染结果尾部 */
function splitTrailingComment(line: string): { code: string; comment: string } {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ';') return { code: line.slice(0, i).trimEnd(), comment: line.slice(i) };
  }
  return { code: line, comment: '' };
}

/** 按**顶层** `sep` 拆分（括号深度与引号内的分隔符不切） */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of s) {
    if (quote !== null) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      cur += ch;
      quote = ch;
      continue;
    }
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/* ==================== 目标（赋值左值 / 位原语第一参数） ==================== */

/**
 * 语言层内置槽位（Emuera 引擎级、非游戏知识）。
 * `实参` / `实参$` 不在这张表里——ARG 族走 `keywords.ts` 的单一真源单独处理。
 */
const LANG_SLOTS: Readonly<Record<string, string>> = {
  LOCAL: '局部',
  LOCALS: '局部$',
  LOCALSS: '局部表',
  RESULT: '结果',
  RESULTS: '结果$',
  COUNT: '计数',
  COUNTS: '计数$',
  COUNTSS: '计数表',
  SUCCESS: '成否',
};

/** 一个可赋值的引用：族头（可含 `$`）+ 零或多个 `:索引` / `[索引]` / `(索引)` 后缀 */
const TARGET_RE = /^([A-Za-z][A-Za-z0-9_$]*)((?::[^:,()[\]\s]+|\[[^[\]]*\]|\([^()]*\))*)$/;
/** 后缀链的第一段索引名（数字或符号名都喂 `slotCn`——批 F 口径：数字索引也能查到槽位中文名） */
const FIRST_SUFFIX_RE = /^:([^:()[\]\s]+)|^\[([^[\]]*)\]|^\(([^()]*)\)/;

interface RenderedTarget {
  readonly text: string;
  /** 至少发生了一次中文替换（别名 / 语言层槽位）——决定要不要补 `赋值` 动词 */
  readonly translated: boolean;
}

function renderTarget(raw: string, lookup: NativeDisplayLookup | undefined): RenderedTarget | null {
  const t = raw.trim();
  const m = TARGET_RE.exec(t);
  if (!m) return null;
  const family = m[1]!;
  const upper = family.toUpperCase();
  const suffixText = m[2] ?? '';

  if (upper === 'ARG' || upper === 'ARGS') {
    // 与 argTokenCnLabel 同口径：k=0 归一为裸形，k>=1 → 视图:(k+1)（表层索引是 1 基）
    const view = upper === 'ARG' ? VARIADIC_ARG_NUMERIC : VARIADIC_ARG_STRING;
    const idx = /^:(\d+)$/.exec(suffixText);
    if (idx) {
      const k = Number(idx[1]!);
      return { text: k === 0 ? view : `${view}:${k + 1}`, translated: true };
    }
    return { text: `${view}${suffixText}`, translated: true };
  }

  const lang = LANG_SLOTS[upper];
  if (lang !== undefined) return { text: `${lang}${suffixText}`, translated: true };

  const alias = lookup?.familyAlias(upper);
  if (alias === undefined) return { text: t, translated: false };

  let text = `${alias}${suffixText}`;
  const fm = FIRST_SUFFIX_RE.exec(suffixText);
  const indexName = fm?.[1] ?? fm?.[2] ?? fm?.[3];
  if (indexName !== undefined) {
    const cn = lookup?.slotCn(upper, indexName);
    if (cn !== undefined) text = `${text}（${cn}）`;
  }
  return { text, translated: true };
}

/* ==================== 赋值 ==================== */

/**
 * 「数据行左值」判据（**只看形状，不看名字**）：`服装` / `残りムシ数` / `K53_変数` /
 * `順位` / `%MACRO%` / `CFLAG:100(%A(TARGET)%)` 这一批左值——**作者自己 `#DIM` 出来的名字、
 * 宏名、索引里嵌了函数调用的引用**，共同点是"形状确实是给一个变量写值"。
 *
 * 导出只为把用例表钉死（`tests/native-display-data-line.test.ts`），**不给别处复用**——
 * `=` 的切分仍然只有 `ASSIGN_RE` 一条、`;` 注释剥离仍然只有 `splitTrailingComment` 一条，
 * 本函数不认运算符、不认注释，所以显示层没有长出第二份"看起来像赋值"的正则。
 *
 * ## 为什么不直接把 `TARGET_RE` 的族头字符类放开（这是本判据存在的唯一理由）
 * `TARGET_RE` 的族头必须是 ASCII 标识符，因为它的产物直接喂两张**游戏层**查表：
 * `lookup.familyAlias(族头大写)` 与 `lookup.slotCn(族头, 索引名)`。把字符类放开成任意
 * Unicode ⇒ 作者自造名（`服装`、`残りムシ数`）会进字典查询路径去**碰运气**：查到了就翻、
 * 查不到就原样——同一条行一会儿有中文一个叫没有，而且 `噴乳` 这类**槽位原名**与
 * **作者变量名**在字面上再也分不开。判据换成形状而非名字，正是为了不去碰那两张表。
 *
 * ## 为什么不翻译（头注承诺：显示形不许承诺可写，也不许造义项）
 * **赋值不是语句**：这一档与「数据表条目正文逐字透传」同一级——盘上那串就是作者要写进槽位的
 * **数据**，不是本工具理解的语法。左值名由 `#DIM` / 项目约定决定，没有任何登记表能担保它的
 * 中文义项 ⇒ **左值一个字符都不翻**；`%GET_BASESTYLE(TARGET, 表示形式)%` 这类右值是**表达式**，
 * 反糖它就得走转译器口径（那是写侧的事，且 `keywords.ts` 的写形才承诺可写），显示层只陈述
 * "这一行是赋值，不是工具读不懂"。词头沿用本文件已有的那条 `赋值 …`（同一把尺子、同一个叫法）：
 * 载荷文本逐字带走，只按那条既有形重铺运算符两侧的空白（`服装=裸` → `赋值 服装 = 裸`）。
 * 本档的右值**不再递归**：链式 `服装 = 順位 = 3` 整串留在载荷里，右值里不许长出第二个 `赋值` 词头；
 * 翻译档（左值至少发生一次中文替换）的链式递归照旧，与本文件既有行为逐字相同。
 */
const MACRO_REF_RE = /^%[^%'"`\s]+%$/;

export function isDataReference(raw: string): boolean {
  const t = raw.trim();
  if (t.length === 0) return false;
  // `%` 起头的是**宏赋值**（`%MACRO% = 1` 同样属"给变量写值"这一档）：只认整形 `%…%`，
  // 半截 `%` 不当宏（宁缺勿猜）。
  if (MACRO_REF_RE.test(t)) return true;
  // 其余引用必须从标识符起始字符开始（`identifier-chars` 单一真源：ASCII + CJK + 全角拉丁）；
  // `$` 起头不在这里——`$` 行由 `NOT_MY_LINE_RE` 交给标签 / ZH-C 口径，本层不抢。
  if (!isIdentStart(t[0]!)) return false;
  let depth = 0;
  for (const ch of t) {
    if (ch === '(' || ch === '[') {
      depth++; // 组内 = 索引载荷（函数调用 / 下标，可嵌套、可含空白与逗号）：逐字算，只要求配平
      continue;
    }
    if (ch === ')' || ch === ']') {
      depth--;
      if (depth < 0) return false;
      continue;
    }
    if (depth > 0) continue;
    if (isIdentPart(ch)) continue;
    if (ch === ':' || ch === '%' || ch === '.' || ch === '$') continue;
    // 组外出现空白 / 引号 / 花括号 / 比较与语句分隔记号 ⇒ 不是"一个引用"
    // （`IF A = 1` 的 `IF A`、`PRINTFORMW a = b` 的 `PRINTFORMW a` 就靠这条留在别层的口径上）
    return false;
  }
  return depth === 0;
}

/**
 * `目标[, 目标…] <op> <值>`；op ∈ `= += -= *= /= |= '=`（`==`/`<=` 这类比较不进这里）。
 *
 * `'=` / `|=` 是 2026-10-20 兜底长尾补登的两枚**同档运算符**（不是新语句）：
 * - `'=`：Emuera ver1813 起的**字符串赋值运算符**（`STR '= "あいう"` 与 `STR = あいう` 同义，
 *   区别只是右值允许字符串表达式）。显示形保留 `'=` 记号，避免读者把"只认字符串表达式的写法"
 *   读成普通 `=`（两者在写侧不是同一个运算符）；
 * - `|=`：**按位或赋值**（`ROOMDATA:ROOM |= 場所_広場` 一族）。同样只保留记号，
 *   不替读者改写成 `赋值 …` 之外的任何说法——运算语义由运算符本身陈述。
 */
const ASSIGN_RE = /^([^;=<>!]+?)\s*(\+=|-=|\*=|\/=|\|=|'=|=)(.*)$/;

function renderAssignment(code: string, lookup: NativeDisplayLookup | undefined, depth: number): string | null {
  if (depth > 3) return null;
  const m = ASSIGN_RE.exec(code);
  if (!m) return null;
  const lhsRaw = m[1]!.trim();
  const op = m[2]!;
  const rhs = m[3]!.trimStart();
  if (rhs.length === 0 || rhs.startsWith('=') || rhs.startsWith('==')) return null;

  const rendered: string[] = [];
  let translated = false;
  for (const part of splitTopLevel(lhsRaw, ',')) {
    const t = renderTarget(part, lookup);
    if (t === null) {
      // 不是引擎族头 / 语言层槽位 ⇒ 只有在**形状**仍是数据引用时才认领（逐字带走，见 `isDataReference`）；
      // 形状都不是引用（`IF A`、`PRINTFORMW a`…）⇒ 整行不认领（宁缺勿猜）
      if (!isDataReference(part)) return null;
      rendered.push(part.trim());
      continue;
    }
    rendered.push(t.text);
    translated ||= t.translated;
  }

  let rhsOut = rhs;
  // 链式 `A = B = 0` 的右值递归**只在翻译档做**：`赋值 <原文>` 那一档的载荷必须逐字，
  // 否则右值里再长出第二个 `赋值` 词头（`赋值 服装 = 赋值 順位 = 3`）就成了谎话。
  if (translated && ASSIGN_RE.test(rhs)) {
    const inner = renderAssignment(rhs, lookup, depth + 1);
    if (inner !== null) rhsOut = inner; // 翻不动就原样（行内英文允许）
  }

  if (translated) return `${rendered.join('，')} ${op} ${rhsOut}`;
  return `赋值 ${lhsRaw} ${op} ${rhsOut}`; // 查不到别名也必须给中文形
}

/* ==================== 裸自增 / 自减 ==================== */

/**
 * 后缀 / 前缀两形。**只在整行就是一个引用加运算符时认领**（两侧都不许有别的记号）：
 * - 后缀：`<引用> ++` / `<引用>++`（空白可有可无，`CFLAG:1:1007  ++` 盘上真形）；
 * - 前缀：`++<引用>` / `--<引用>`（盘上 0 例；`--` 前缀实测同样 0——两形都按同一判据防御性认领）。
 *
 * 为什么这样切不会误判"非自增的裸引用行"：`++`/`--` 必须是整行的**最后**一段（后缀）或
 * **最前**一段（前缀），中间那串再交给 `renderTarget` / `isDataReference` 判"是不是一个引用"。
 * 裸引用（`CFLAG:1:1009` / `ABL:親密` / `Snum`）不匹配任何一形 ⇒ `null`；`A + B ++` 的
 * 目标不是单个引用 ⇒ `null`；`X = Y++` 先被赋值档收走（右值逐字保留 `Y++`），不在这里被拆。
 */
const POSTFIX_INC_RE = /^(.+?)\s*(\+\+|--)$/;
const PREFIX_INC_RE = /^(\+\+|--)\s*(\S[\s\S]*)$/;

/** `++` → `自增`，`--` → `自减`（只翻**运算符这一层**；目标名一个字符都不猜，见下） */
const INC_VERBS: Readonly<Record<string, string>> = { '++': '自增', '--': '自减' };

/**
 * 裸自增 / 自减行 ⇒ `自增 <目标>` / `自减 <目标>`。
 *
 * ## 为什么不写成 `赋值 <目标> += 1`
 * `++` / `--` 是**单目自增运算符**，与 `+= 1` 同值但不同写法：显示形若改写成赋值，
 * 就把"这一行是表达式语句"读成了"这一行是赋值语句"——两种写法在 ERB 里是不同的语句类。
 * 词头只描述运算符本身（`自增` / `自减`），不替读者判断这个变量"是什么"。
 *
 * ## 目标怎么显示
 * 与赋值左值**同一把尺子**（本文件只有一份 `renderTarget`）：
 * - 引擎族头 / 语言层槽位 ⇒ 中文别名或中文槽位名（`LOCAL:2 ++` → `自增 局部:2`）；
 * - 作者自造名 / 宏 / 带函数调用索引的引用 ⇒ 形状判据（`isDataReference`）通过就**逐字**带走
 *   （`Snum++` → `自增 Snum`；`残りムシ数 --` → `自减 残りムシ数`）；
 * - 形状都不是一个引用 ⇒ `null`（`A + B ++` 不归本档）。
 *
 * ## 可逆性（"不丢信息"的落点）
 * 显示形携带**目标全文 + 运算符方向**；读回写形 `<目标> ++|--` 是逐字重建的。
 * 前缀 / 后缀在**语句位置**上语义等价（值不被使用），故不强留前后位置记号——
 * 这一点写死在注释里，免得以后有人把它当成漏掉的信息。
 *
 * 行尾注释由入口的 `splitTrailingComment` 统一剥离、原样缀回（`Snum++;2` → `自增 Snum ;2`）。
 */
function renderIncrement(code: string, lookup: NativeDisplayLookup | undefined): string | null {
  const m = POSTFIX_INC_RE.exec(code);
  let targetRaw: string;
  let op: string;
  if (m !== null) {
    targetRaw = m[1]!.trim();
    op = m[2]!;
  } else {
    const p = PREFIX_INC_RE.exec(code);
    if (p === null) return null;
    op = p[1]!;
    targetRaw = p[2]!.trim();
  }
  if (targetRaw.length === 0) return null;

  const rendered = renderTarget(targetRaw, lookup);
  if (rendered === null && !isDataReference(targetRaw)) return null;
  const target = rendered === null ? targetRaw : rendered.text;
  return `${INC_VERBS[op]!} ${target}`;
}

/* ==================== TIMES（小数乘算赋值） ==================== */

/**
 * `TIMES <引用>, <数值>` ⇒ `乘算 <目标> × <数值>`。
 *
 * ## 取证结论（2026-10-20 挂盘，全语料 3,143 行）
 * - **形状唯一**：3,143 / 3,143 行都恰好有**一个**顶层逗号，右值是数值字面量
 *   （整数 / 小数 / 尾点 `1.`；无一例表达式、变量或缺失）；左值全部是引用
 *   （`LOCAL` / `SOURCE:…` / `CUP:…` / 作者自造名 / 带函数调用索引的引用）。
 * - **语义有权威出处**：Emuera 文档（ERB 構文講座「小数の乗算」）原文口径
 *   `A = 1000` + `TIMES A, 1.5` ⇒ A 为 `1000×1.5`；结果是小数时取整。
 *   故显示词头用 `乘算`、运算符用 `×`——只陈述这一条被文档与语料同时钉住的语义。
 * - **不猜的形状**：无逗号 / 多个顶层逗号 / 右值不是数值字面量（变量、函数调用）
 *   一律 `null`（语料零样本，宁缺勿猜；显示层不替读者决定"那是不是乘法"）。
 *
 * 目标与赋值左值**同一把尺子**（`renderTarget`）：语言层槽位 / 族头别名中文化，
 * 查不到就按 `isDataReference` 的形状判据逐字带走。右值逐字照抄，不改写数值写法。
 */
const TIMES_RE = /^TIMES[ \t]+(\S[\s\S]*)$/;
/** 数值字面量：整数 / 小数 / 尾点（`1.` 盘上真形）；正负号可有 */
const TIMES_FACTOR_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function renderTimes(code: string, lookup: NativeDisplayLookup | undefined): string | null {
  const m = TIMES_RE.exec(code);
  if (m === null) return null;
  const parts = splitTopLevel(m[1]!, ',');
  if (parts.length !== 2) return null;
  const targetRaw = parts[0]!.trim();
  const factor = parts[1]!.trim();
  if (targetRaw.length === 0 || !TIMES_FACTOR_RE.test(factor)) return null;

  const rendered = renderTarget(targetRaw, lookup);
  if (rendered === null && !isDataReference(targetRaw)) return null;
  const target = rendered === null ? targetRaw : rendered.text;
  return `乘算 ${target} × ${factor}`;
}

/* ==================== 调用 ==================== */

const CALL_RE = /^(?:([A-Z][A-Z0-9_]*)[ \t]+(\S[\s\S]*)|([A-Z][A-Z0-9_]*))$/;
/**
 * 语句动词表（**显示词形住本表、档位名单住 `sugar-ident`**，两件事别混）。
 *
 * TRY 五枚全走本表：`TRYCALL` / `TRYCALLFORM` / `TRYJUMP` 一直在；`TRYGOTO` / `TRYGOTOFORM`
 * 是 goto 家族的单行变体（引擎 funcMatch 的"其余 TRY*"档），此前表里没有 ⇒ 落 `未识别语句 ·`
 * 兜底。词形上 `跳到` 与 ZH-C 的 `GOTO` 显示形同字（标签目标），`…形` 与 `调用形` 同构
 * （FORM 变体）⇒ 读者一眼看出"跳到族 + 试探"，而不是第四种叫法。
 *
 * 载荷**逐字带走**（`*标签` / `$标签` / 实参串都不剥前缀）——本层所有调用形同一条口径，
 * 前缀剥离是 ZH-C 的 `GOTO` 才有的装置（它那里目标是纯标签名）。
 *
 * `CALLF`（盘上 245 行落兜底）按 **`按钮C` 的同一条拼法**保留区别字母：它是 `CALL` 族里
 * 带 `F` 的那一枚（引擎内建单行语句，取证见 `packages/app/src/monaco/erb-directives.ts`
 * 与 `tests/erb-completion-context.test.ts` 的 `CALLF FOO(1)` 实参括号形态），
 * **我不替读者判定 `F` 改了哪一档语义**，所以既不写成 `调用` 也不写成 `调用形`，
 * 只把词头换成 `调用F`、实参逐字带走。
 */
const CALL_VERBS: Readonly<Record<string, { readonly verb: string; readonly tail: string }>> = {
  CALL: { verb: '调用', tail: '' },
  CALLL: { verb: '调用', tail: ' 续' },
  CALLFORM: { verb: '调用形', tail: '' },
  CALLF: { verb: '调用F', tail: '' },
  TRYCALL: { verb: '尝试调用', tail: '' },
  TRYCALLFORM: { verb: '尝试调用形', tail: '' },
  TRYJUMP: { verb: '尝试跳转', tail: '' },
  TRYGOTO: { verb: '尝试跳到', tail: '' },
  TRYGOTOFORM: { verb: '尝试跳到形', tail: '' },
};

/**
 * 本层认领的 TRY 记号 = 语句动词表 ∩ 识别核的单行档（**派生，不是第二份名单**）。
 *
 * 为什么要导出：装配顺序（control 先、statement 后）本身就是一条判据，而"两档互斥、
 * 单行档全被认领"这两件事只有在测试里能对着名单核——`STATEMENT_TRY_WORDS` 与
 * `TRY_SINGLE_LINE` 一旦漂移（加了一枚没给动词、或把开块词抄进动词表），
 * `tests/native-display-statement.test.ts` 立刻红。
 */
export const STATEMENT_TRY_WORDS: readonly string[] = Object.keys(CALL_VERBS)
  .filter((k) => TRY_SINGLE_LINE.has(k))
  .sort();

function renderCall(code: string): string | null {
  const m = CALL_RE.exec(code);
  if (!m) return null;
  const kw = (m[1] ?? m[3] ?? '').toUpperCase();
  const shape = CALL_VERBS[kw];
  if (shape === undefined) return null;
  const target = m[2];
  if (target === undefined) return null; // 裸 `CALL` 无目标 = 畸形行
  return `${shape.verb} ${target}${shape.tail}`;
}

/* ==================== 位原语 ==================== */

const BIT_RE = /^(SETBIT|CLEARBIT|INVERTBIT)[ \t]+(\S[\s\S]*)$/;
const BIT_VERBS: Readonly<Record<string, string>> = { SETBIT: '置位', CLEARBIT: '清位', INVERTBIT: '翻位' };

function renderBitOp(code: string, lookup: NativeDisplayLookup | undefined): string | null {
  const m = BIT_RE.exec(code);
  if (!m) return null;
  const parts = splitTopLevel(m[2]!, ',').map((x) => x.trim());
  const targetRaw = parts[0];
  const bits = parts.slice(1);
  if (targetRaw === undefined || bits.length === 0) return null; // 缺位号 = 畸形行
  const target = renderTarget(targetRaw, lookup);
  const targetText = target === null ? targetRaw : target.text;
  return `${BIT_VERBS[m[1]!.toUpperCase()]!} ${targetText} 第${bits.join('，')}位`;
}

/* ==================== 输出族 ==================== */

const PRINT_RE = /^(PRINT[A-Z]*)(?:[ \t]+(\S[\s\S]*))?$/;

interface PrintShape {
  readonly verb: string;
  /** 行尾节奏记号：` 续` / ` 等待`（沿用投影既有口径） */
  readonly tail?: string;
  /** 块开词：渲染成 `数据打印（逐行）：` 一类的块头，`''` = 无括注 */
  readonly data?: string;
}

/**
 * 只登记**投影表外**的变体（`PRINT_VARIANTS` 已认领的台词形不重复接管）；
 * 表外的 `PRINTKONST` / `PRINTLC` 等一律 `null`——没把握的记号不配拥有中文名。
 */
const PRINT_SHAPES: Readonly<Record<string, PrintShape>> = {
  PRINT: { verb: '片段打印' },
  PRINTL: { verb: '打印', tail: ' 续' },
  PRINTW: { verb: '打印', tail: ' 等待' },
  PRINTV: { verb: '数值打印' },
  PRINTVL: { verb: '数值打印', tail: ' 续' },
  PRINTVW: { verb: '数值打印', tail: ' 等待' },
  PRINTFORMV: { verb: '格式数值打印' },
  PRINTFORMVL: { verb: '格式数值打印', tail: ' 续' },
  PRINTSINGLE: { verb: '单项打印' },
  PRINTSINGLEL: { verb: '单项打印', tail: ' 续' },
  PRINTSINGLEW: { verb: '单项打印', tail: ' 等待' },
  PRINTSINGLEV: { verb: '单项数值打印' },
  PRINTSINGLEVL: { verb: '单项数值打印', tail: ' 续' },
  PRINTSINGLEVW: { verb: '单项数值打印', tail: ' 等待' },
  PRINTDATA: { verb: '数据打印', data: '' },
  PRINTDATAL: { verb: '数据打印', data: '逐行' },
  PRINTDATAW: { verb: '数据打印', data: '等待' },
  PRINTDATAS: { verb: '数据打印', data: '并排' },
};

function renderPrint(code: string): string | null {
  const m = PRINT_RE.exec(code);
  if (!m) return null;
  const shape = PRINT_SHAPES[m[1]!.toUpperCase()];
  if (shape === undefined) return null;
  const body = m[2];
  if (shape.data !== undefined) {
    const head = shape.data.length > 0 ? `${shape.verb}（${shape.data}）：` : `${shape.verb}：`;
    return body === undefined ? head : `${head} ${body}`;
  }
  if (body === undefined) {
    if (shape.tail === ' 等待') return '空行 等待';
    if (shape.tail === ' 续') return '空行';
    return shape.verb;
  }
  return `${shape.verb} ${body}${shape.tail ?? ''}`;
}

/* ==================== 按钮 / 输入 ==================== */

const BUTTON_RE = /^(PRINTBUTTON|PRINTBUTTONC)[ \t]+(\S[\s\S]*)$/;

function renderButton(code: string): string | null {
  const m = BUTTON_RE.exec(code);
  if (!m) return null;
  const verb = m[1] === 'PRINTBUTTON' ? '按钮' : '按钮C';
  const parts = splitTopLevel(m[2]!, ',').map((x) => x.trim());
  const label = parts[0];
  if (label === undefined || label.length === 0) return null;
  const rest = parts.slice(1);
  return rest.length > 0 ? `${verb} ${label} → ${rest.join('，')}` : `${verb} ${label}`;
}

/* ==================== 排版 / 等待（单词指令表） ==================== */

const LINE_WORD_RE = /^([A-Za-z][A-Za-z0-9_]*)(?:[ \t]+(\S[\s\S]*))?$/;

interface LayoutShape {
  readonly verb?: string;
  /** `none` = 不许带参数；`keep` = 参数原样照抄（必需）；`optional` = 参数原样（可缺）；`onoff` = `0/1 → 关/开` 其余照抄 */
  readonly arg?: 'none' | 'keep' | 'optional' | 'onoff';
  readonly tail?: string;
  /** 整行固定形（`INPUT` 这类"输出槽位是语言层约定"的行） */
  readonly fixed?: string;
}

/**
 * 登记判据（本表是**闭集**：表里没有的记号一律 `null`，与 `PRINT_SHAPES` 同一条纪律）。
 * `CLEARLINE` 的档位从 `none` 改成 `optional`（2026-10-20 兜底归因：盘上 395 行带参数的
 * `CLEARLINE …` 全落兜底 ⇒ 带参数的是同一条指令，参数是**载荷**、逐字带走，不是"另一条指令"）。
 * `HTML_PRINT` / `FONTREGULAR` / `FONTSTYLE` / `VARSET` 四枚同批补登：都是引擎内建单行语句
 * （名单与频次取证见 `packages/app/src/monaco/erb-directives.ts` 的语料词频注释），
 * 义项只翻**词头那一枚记号**，参数一律原样照抄（`arg` 非 `none` 的档都只做"换词首"）。
 */
const LAYOUT_SHAPES: Readonly<Record<string, LayoutShape>> = {
  SETCOLOR: { verb: '着色', arg: 'keep' },
  RESETCOLOR: { verb: '复原颜色', arg: 'none' },
  FONTBOLD: { verb: '粗体', arg: 'onoff' },
  FONTITALIC: { verb: '斜体', arg: 'onoff' },
  FONTSIZE: { verb: '字号', arg: 'optional' },
  FONTREGULAR: { verb: '复原字体', arg: 'optional' },
  FONTSTYLE: { verb: '字体样式', arg: 'optional' },
  CLEARLINE: { verb: '清空本行', arg: 'optional' },
  HTML_PRINT: { verb: 'HTML打印', arg: 'optional' },
  FORCEWAIT: { verb: '强制等待', arg: 'none' },
  WAIT: { verb: '等待', arg: 'none' },
  DRAWLINE: { verb: '分隔线', arg: 'optional' },
  BAR: { verb: '进度条', arg: 'keep' },
  BARL: { verb: '进度条', arg: 'keep', tail: ' 续' },
  REDRAW: { verb: '重绘', arg: 'optional' },
  RETURN: { verb: '返回', arg: 'optional' },
  VARSET: { verb: '赋值', arg: 'keep' },
  INPUT: { fixed: '输入 → 结果' },
  INPUTS: { fixed: '输入 → 结果$' },
};

function renderLayout(code: string): string | null {
  const m = LINE_WORD_RE.exec(code);
  if (!m) return null;
  const shape = LAYOUT_SHAPES[m[1]!.toUpperCase()];
  if (shape === undefined) return null;
  const body = m[2];
  if (shape.fixed !== undefined) return body === undefined ? shape.fixed : null; // 固定形不许挂参数
  if (shape.arg === 'none' && body !== undefined) return null; // 带参的"裸指令"不是我认的那条指令
  if (shape.arg === 'keep' && body === undefined) return null;
  let argOut = body;
  if (shape.arg === 'onoff' && body !== undefined) {
    argOut = body === '1' ? '开' : body === '0' ? '关' : body;
  }
  const head = argOut === undefined ? shape.verb! : `${shape.verb!} ${argOut}`;
  return `${head}${shape.tail ?? ''}`;
}

/* ==================== 入口 ==================== */

/** 前缀即"不归本层"的整行形态：`;` 注释、`#` 预处理、`$` 标签、`[` 停用区、`@` 函数头（全在 ZH-C / 结构层） */
const NOT_MY_LINE_RE = /^[;#$[@]/;

/**
 * `PRINT` 打头的一切行**不许进赋值档**：投影的台词形（`project.ts` 的 `printFamilyDisplay`）
 * 是这批行的既有口径（`PRINTKONST` / `PRINTLC` / 表外变体 ⇒ `台词 · <体>`），
 * 归因闸把 `printVariant` 钉成结构性 0 靠的就是它。表内变体在上面已由 `renderPrint` /
 * `renderButton` 收走，这里只挡"表外 + 行里恰好有个 `=`"的漏网形状（`PRINT%s=1` 一类）。
 */
const PRINT_LED_RE = /^PRINT/;

/** ZH-S 的入口（签名由 lead 钉死，禁止改名或加参） */
export const renderStatementLine: NativeDisplayPass = (input: NativeDisplayInput): string | null => {
  const trimmed = input.content.trim();
  if (trimmed.length === 0 || NOT_MY_LINE_RE.test(trimmed)) return null;
  const { code, comment } = splitTrailingComment(trimmed);
  if (code.length === 0) return null;
  const rendered =
    renderCall(code) ??
    renderBitOp(code, input.lookup) ??
    renderPrint(code) ??
    renderButton(code) ??
    renderLayout(code) ??
    // `PRINT` 打头的行不许进这两档：表外打印变体由投影的台词形收走，
    // 这里只防"行里恰好以 `++` 结尾"的漏网形状（`PRINTFORM ++`）被读成自增。
    (PRINT_LED_RE.test(code)
      ? null
      : renderTimes(code, input.lookup) ??
        renderAssignment(code, input.lookup, 0) ??
        renderIncrement(code, input.lookup));
  if (rendered === null) return null;
  const line = comment.length > 0 ? `${rendered} ${comment}` : rendered;
  return line === input.content ? null : line; // 红线自证：原样返回一律视为失败
};
