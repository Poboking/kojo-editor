import type { ErbIndex, ErbParam, LineDecoration } from '@kojo/plugin-api';
import { isErbDialectPath, MODEL_TOKEN_CLASS } from '@kojo/plugin-api';
import { normalizedUpper, visibleCodeLines, type VisibleCodeLine } from './references';

/**
 * ERB 实参个数诊断（批次十 S7；**纯函数**：文本 + 函数目录进、波浪线数据出）。
 *
 * ## 为什么要有
 *
 * 引擎文档（Emuera `function.html`）把两侧规则写得很直白：
 * - 调用侧多给实参 = **错误**（"エラー(引数が多すぎる)"）；
 * - 调用侧少给实参 = 允许省略，但**没有默认值的形参**同样取证不到作者意图
 *   （引擎按 0 / 空串静默兜底，写错位置也照样跑）；
 * - 形参名可以写成**可变下标**（`ARG:X` / `ARG:(ARG:0)`），此时个数不可证。
 *
 * 前三件事里，前两件是作者最容易犯、引擎却只在运行时才"读歪"的错——把它们提前成
 * 波浪线，价值与结构体检同源。
 *
 * ## 可证明边界（错标比不标危险）
 *
 * - 只对**目录里已知**的函数判：`catalog` 返回 `null`/`undefined` 一律不报（未打开项目、
 *   索引没建好、名字拼错——都轮不到这一层）；
 * - 只认 `CALL` / `TRYCALL` / `TRYCCALL` 三种**按名带实参**的调用面；
 *   `TRYCALLLIST` 族后跟的是**函数名清单**，不是实参表，整族不判；
 * - `CALLFORM` / `FORM` 动态拼接、成员访问占槽（`CALL FLAG:X`）、
 *   名字之后既不是 `(` 也不是 `,` 的行 —— 整行不判（与 `scanUndefinedCallTargets`
 *   同一套 fail-open 判据）；
 * - **可变下标形参**（`ARG:X` / `ARGS:(…)`）⇒ 整个函数不判——个数本身由运行期算；
 * - 多处定义形参表不一致 ⇒ 目录查询给 `null`，不猜作者调的是哪一个
 *   （`arityParamsOf` 与 `inlaySlotsOf` 同一条一致性口径）。
 *
 * ## 省略形的计数纪律
 *
 * `CALL FOO` 与 `CALL FOO,` 都是**零实参**：末位空槽是书写尾巴，不占参数位。
 * 中间的空槽（`CALL FOO, , "x"`）**照样占位**——引擎按逗号序赋值，漏算它会把
 * "第 2 参给了"读成"第 1 参给了"，报的错就指错了位置。
 *
 * ## 行可见性与坐标
 *
 * 复用 `references.ts` 的 `visibleCodeLines`（`[SKIPSTART]` 区、整行 `;`、`#` 指令、
 * `$` 标签、`@` 定义行）与 `normalizedUpper`；列口径与反向索引逐字相同：
 * **1 基、UTF-16 码元、结束列不含端点**。diagnostic range 落在**实参区**，
 * 无实参时落在**函数名**（波浪线不会指着被调函数名说"实参不对"却又没有实参可指）。
 */

/** 诊断码（问题面板 / 工具提示分组用；稳定标识，不许带来源限定词） */
export const ARITY_MISMATCH_CODE = 'ERB_ARITY_MISMATCH';

/**
 * 函数目录查询：**归一化名 → 形参表**。
 *
 * 返回 `null` / `undefined` = 目录不认识这个名字（未建索引 / 名字不在项目里），
 * 消费方**一条不报**——这是 fail-open 的唯一判据，不要在这里猜"大概几个"。
 */
export type ArityCatalog = (normalizedName: string) => readonly ErbParam[] | null | undefined;

/** 单次诊断的输入（`path` 用于方言门；`text` 是当前缓冲区原文） */
export interface ArityInput {
  readonly path: string;
  readonly text: string;
  /** 函数目录（通常由 `arityParamsOf(index, name)` 构造，见下） */
  readonly catalog: ArityCatalog;
}

/** 一处调用点（1 基行号；列均为**行内 0 基**，输出时再换算 1 基） */
interface CallSite {
  readonly line: number;
  /** 调用点原样函数名（消息里按作者写法显示，不做大写改写） */
  readonly name: string;
  readonly nameStart: number;
  readonly nameEnd: number;
  /** 实参个数（末位空槽已剔除；中间空槽照算） */
  readonly given: number;
  /** 首个非空实参起点（0 基）；-1 = 全部为空 */
  readonly argFirst: number;
  /** 末个非空实参终点（0 基、不含）；-1 = 全部为空 */
  readonly argLast: number;
}

/** 一个实参槽的行内 0 基半开区间 */
interface ArgSpan {
  readonly start: number;
  readonly end: number;
}

const isBlankChar = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\u3000';

/** 名字槽之后的前导空白（与 `inlay-hints` 的 `SLOT_TOKEN_RE` 同口径） */
const SLOT_AFTER_WHITESPACE = new RegExp(`^[\\t \\u3000]*(${MODEL_TOKEN_CLASS}+)`, 'u');

/** 表达式调用扫描用的记号串（字符集字面量只住 plugin-api 的 `MODEL_TOKEN_CLASS`） */
const TOKEN_RUN = new RegExp(`${MODEL_TOKEN_CLASS}+`, 'gu');

/**
 * 记号两侧是否紧邻半/全角冒号（**变量成员访问**）。
 *
 * 与 `references.ts` 的 `colonAdjacent` 判据逐字相同（那边不导出，本模块只此一处消费）。
 * `CALL FLAG:X` 与表达式里的 `VAR:MEMBER(…)` 都不是函数名——判进来就会把变量名
 * 当成实参个数不符的函数。
 */
function colonAdjacent(code: string, start: number, end: number): boolean {
  const before = start > 0 ? code.charCodeAt(start - 1) : -1;
  const after = end < code.length ? code.charCodeAt(end) : -1;
  return before === 0x3a || before === 0xff1a || after === 0x3a || after === 0xff1a;
}

/** `(` 的配对 `)`（引号感知）；未闭合返回 -1（作者正在写的半截调用 = 按到行尾处理） */
function findParenClose(raw: string, open: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = open; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inStr) {
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 从 `from` 起找行内注释 `;`（引号外）的起点；没有则行尾 */
function commentAt(raw: string, from: number): number {
  let inStr = false;
  for (let i = from; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inStr) {
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === ';') return i;
  }
  return raw.length;
}

/**
 * 切一段实参表（`[from, to)`）：顶层半/全角逗号分隔，引号、`()` `[]` `{}` 嵌套感知，
 * 引号外的 `;` 提前收尾（行内注释尾巴不是实参）。
 *
 * 末尾空槽剔除（`CALL FOO,` = 0 个；`CALL FOO(a,)` = 1 个）——那是书写尾巴，
 * 引擎不按参数位读它；中间空槽保留（`CALL FOO, , "x"` = 2 个）。
 */
function splitArgs(raw: string, from: number, to: number): ArgSpan[] {
  const spans: ArgSpan[] = [];
  let start = from;
  let depth = 0;
  let inStr = false;
  let end = to;
  for (let i = from; i < to; i++) {
    const ch = raw[i]!;
    if (inStr) {
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === ';' && depth === 0) {
      end = i;
      break;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if ((ch === ',' || ch === '，') && depth === 0) {
      spans.push({ start, end: i });
      start = i + 1;
    }
  }
  spans.push({ start, end });
  while (spans.length > 0) {
    const last = spans[spans.length - 1]!;
    if (raw.slice(last.start, last.end).trim().length > 0) break;
    spans.pop();
  }
  return spans;
}

/** 实参区的首/末非空边界（0 基；全部空槽 ⇒ -1 / -1） */
function argBounds(raw: string, spans: readonly ArgSpan[]): { first: number; last: number } {
  let first = -1;
  let last = -1;
  for (const span of spans) {
    let s = span.start;
    while (s < span.end && isBlankChar(raw[s])) s++;
    let e = span.end;
    while (e > s && isBlankChar(raw[e - 1])) e--;
    if (e <= s) continue;
    if (first < 0) first = s;
    last = e;
  }
  return { first, last };
}

/** 由名字区间与实参表装配调用点（列与原文同位） */
function makeSite(
  line: number,
  raw: string,
  name: string,
  nameStart: number,
  nameEnd: number,
  spans: readonly ArgSpan[],
): CallSite {
  const bounds = argBounds(raw, spans);
  return { line, name, nameStart, nameEnd, given: spans.length, argFirst: bounds.first, argLast: bounds.last };
}

/**
 * `CALL` 直系族的调用点解析。
 *
 * 名字槽判据与 `scanUndefinedCallTargets` 逐字同源：关键字后**第一个记号**、与关键字之间
 * 只许空白、变量成员访问占槽不算。名字之后只认两种实参形（括号形 / 逗号形），
 * 其余（FORM 拼接、单独的成员访问）⇒ `null`，整行不判。
 */
function callSiteOf(line: VisibleCodeLine, code: string): CallSite | null {
  if (!line.isCallLine) return null;
  const raw = line.raw;
  const indent = raw.length - raw.trimStart().length;
  const keyword = raw.slice(indent, line.keywordEnd).toUpperCase();
  // LIST 族后跟的是"要依次调用的函数名清单"，不是实参表——整族不判。
  if (keyword.endsWith('LIST')) return null;

  const m = SLOT_AFTER_WHITESPACE.exec(code.slice(line.keywordEnd));
  if (m === null) return null; // 名字槽空着（`CALL` 单独一行）
  const nameStart = line.keywordEnd + m[0]!.length - m[1]!.length;
  const nameEnd = nameStart + m[1]!.length;
  // 关键字与名字之间只许空白：夹了 `%` / `"` / `{` 等 = FORM 动态拼接，不猜
  if (!/^[\t \u3000]*$/.test(raw.slice(line.keywordEnd, nameStart))) return null;
  if (colonAdjacent(code, nameStart, nameEnd)) return null;

  let at = nameEnd;
  while (at < raw.length && isBlankChar(raw[at])) at++;
  if (at >= raw.length || raw[at] === ';') {
    // 省略形：`CALL FOO` 没有实参（`CALL FOO,` 的末位空槽也会被 splitArgs 剔除）
    return makeSite(line.line, raw, raw.slice(nameStart, nameEnd), nameStart, nameEnd, []);
  }

  if (raw[at] === '(') {
    const close = findParenClose(raw, at);
    const to = close >= 0 ? close : raw.length;
    return makeSite(line.line, raw, raw.slice(nameStart, nameEnd), nameStart, nameEnd, splitArgs(raw, at + 1, to));
  }
  if (raw[at] === ',' || raw[at] === '，') {
    return makeSite(
      line.line,
      raw,
      raw.slice(nameStart, nameEnd),
      nameStart,
      nameEnd,
      splitArgs(raw, at + 1, commentAt(raw, at + 1)),
    );
  }
  return null; // 名字后既不是括号也不是逗号：成员访问 / 动态拼接，不判
}

/**
 * 表达式里的调用点：`名字` + 可选空白 + `(`。
 *
 * 只认**已知目录名**（调用方随后查表），因此 `IF (A)` 这类括号分组不会被误伤；
 * 成员访问（`VAR:MEMBER(…)`）按 `colonAdjacent` 退出。`skipStarts` 是同一行上
 * CALL 名字槽的起点集合——`CALL FOO(a)` 的 `FOO` 已按调用面判过，这里不重复。
 */
function expressionSites(line: VisibleCodeLine, code: string, skipStarts: ReadonlySet<number>): CallSite[] {
  const raw = line.raw;
  const out: CallSite[] = [];
  TOKEN_RUN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RUN.exec(code)) !== null) {
    const start = m.index;
    const end = start + m[0]!.length;
    if (skipStarts.has(start)) continue;
    if (colonAdjacent(code, start, end)) continue;
    let at = end;
    while (at < code.length && isBlankChar(code[at])) at++;
    if (code[at] !== '(') continue;
    const close = findParenClose(raw, at);
    const to = close >= 0 ? close : raw.length;
    out.push(makeSite(line.line, raw, raw.slice(start, end), start, end, splitArgs(raw, at + 1, to)));
  }
  return out;
}

/**
 * 形参表里是否有**可变下标**（`ARG:X` / `ARG:(ARG:0)` / `ARGS:任意非数字`）。
 *
 * 引擎文档把这种写法列为"动作可以，但不推荐"：下标本身由运行期算出来，
 * 声明个数与实参个数之间没有可证的对应 ⇒ 整个函数不判（不是"放宽上限"，是**不猜**）。
 * 纯数字下标（`ARG:0` / `ARGS:1`）是固定槽，照常判。
 */
function hasVariableSlot(params: readonly ErbParam[]): boolean {
  for (const p of params) {
    const m = /^(?:ARG|ARGS)\s*[:：](.*)$/i.exec(p.name);
    if (m !== null && !/^\d+$/.test(m[1]!.trim())) return true;
  }
  return false;
}

/** 必填下界：**最后一个没有默认值的形参**序号 + 1（默认值可写在中间，不能只数个数） */
function requiredCount(params: readonly ErbParam[]): number {
  let required = 0;
  for (let i = 0; i < params.length; i++) {
    if (!params[i]!.hasDefault) required = i + 1;
  }
  return required;
}

/** 一处调用点 → 一条诊断（正常个数 ⇒ null） */
function issueOf(site: CallSite, params: readonly ErbParam[]): LineDecoration | null {
  if (hasVariableSlot(params)) return null;
  const total = params.length;
  const required = requiredCount(params);
  const given = site.given;

  const range =
    site.argFirst >= 0
      ? { startColumn: site.argFirst + 1, endColumn: site.argLast + 1 }
      : { startColumn: site.nameStart + 1, endColumn: site.nameEnd + 1 };
  const head = `函数「${site.name}」的实参个数不对：期望 ${required > given ? required : total} 个，实际 ${given} 个`;

  if (given > total) {
    return {
      line: site.line,
      severity: 'error',
      message: `函数「${site.name}」的实参个数不对：期望 ${total} 个，实际 ${given} 个——多出的实参不会传给函数。`,
      ...range,
      code: ARITY_MISMATCH_CODE,
    };
  }
  if (given < required) {
    return {
      line: site.line,
      severity: 'error',
      message: `${head}——第 ${required} 个形参「${params[required - 1]!.name}」没有默认值，实参不能省略。`,
      ...range,
      code: ARITY_MISMATCH_CODE,
    };
  }
  if (given < total) {
    return {
      line: site.line,
      severity: 'warning',
      message: `${head}——省略的是有默认值的形参，补上更清楚。`,
      ...range,
      code: ARITY_MISMATCH_CODE,
    };
  }
  return null;
}

/**
 * 从项目索引取一个函数的形参表（**纯函数**，不读盘）。
 *
 * `byName` 存的是 `ErbFunctionRef`（无形参），形参表在 `files` 的同名定义上——
 * 按 `filePath + startLine` 对回 `ErbFunction`。多处定义（重名函数）**全部一致**
 * （个数、逐名、默认值有无都相同）才给表；分歧 = 证明不了作者调的是哪一个 ⇒ `null`。
 * 口径与 `inlay-hints.ts` 的 `inlaySlotsOf` 同源（那边只比槽名，这边还要比默认值）。
 */
export function arityParamsOf(index: ErbIndex, normalizedName: string): readonly ErbParam[] | null {
  const defs = index.byName.get(normalizedName);
  if (defs === undefined || defs.length === 0) return null;
  let agreed: readonly ErbParam[] | null = null;
  for (const def of defs) {
    const fn = index.files.get(def.filePath)?.functions.find((f) => f.startLine === def.startLine);
    const params = fn?.params;
    if (params === undefined) return null; // 定义体缺席（快照裁剪等）＝证明不了
    if (agreed === null) {
      agreed = params;
      continue;
    }
    if (agreed.length !== params.length) return null;
    for (let i = 0; i < params.length; i++) {
      if (agreed[i]!.name.toUpperCase() !== params[i]!.name.toUpperCase()) return null;
      if (agreed[i]!.hasDefault !== params[i]!.hasDefault) return null;
    }
  }
  return agreed;
}

/**
 * 收集整篇缓冲区的实参个数诊断（**纯函数**：文本 + 目录进、波浪线数据出）。
 *
 * 非 ERB 方言路径与空文本 ⇒ 空数组（与 `erbReferenceDecorations` 同一条门）。
 * 产出按行、列升序；同一行上的多个调用点各成一条（互不吞并）。
 */
export function collectArityDiagnostics(input: ArityInput): LineDecoration[] {
  if (!isErbDialectPath(input.path) || input.text.length === 0) return [];
  const out: LineDecoration[] = [];
  for (const line of visibleCodeLines(input.text)) {
    if (line.isDefinition) continue;
    const code = line.codeView();
    const call = callSiteOf(line, code);
    const skip = new Set<number>();
    if (call !== null) {
      skip.add(call.nameStart);
      const params = input.catalog(normalizedUpper(call.name));
      if (params) {
        const issue = issueOf(call, params);
        if (issue !== null) out.push(issue);
      }
    }
    for (const site of expressionSites(line, code, skip)) {
      const params = input.catalog(normalizedUpper(site.name));
      if (!params) continue;
      const issue = issueOf(site, params);
      if (issue !== null) out.push(issue);
    }
  }
  out.sort((a, b) => a.line - b.line || (a.startColumn ?? 0) - (b.startColumn ?? 0));
  return out;
}
