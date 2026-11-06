import type { ErbFunctionRef, ErbIndex, ErbParam, LineDecoration } from '@kojo/plugin-api';
import { isErbDialectPath, MODEL_TOKEN_CLASS } from '@kojo/plugin-api';
import { normalizedUpper, visibleCodeLines, type VisibleCodeLine } from './references';

/**
 * ERB 实参个数诊断（批次十 S7；**纯函数**：文本 + 函数目录进、波浪线数据出）。
 *
 * ## 为什么要有（以及为什么只剩一条）
 *
 * 引擎权威是 `Process.CalledFunction.ConvertArg`（行号会漂），不是文档：
 * - **多给**：转换循环的上界是 `fixedArgCount`，多余实参**既不报错也不警告**，直接丢弃
 *   （`Statements/ArgumentBuilder.cs` 里那句 `warn("引数が多すぎます")` 是被注释掉的死码）
 *   ⇒ 这一档**不产诊断**（D02 翻转：真语料 111 处「多给」全在跑的成品 mod，判据方向本来就反了）；
 * - **少给**：槽位缺实参时取 `func.Def[i]`，而 `ErbLoader` 对 **ARG 家族形参无条件合成**默认值
 *   （见 {@link IMPLICIT_DEFAULT_NAME}）⇒ 作者表里绝大多数槽"没有默认值"是**扫描器口径**，
 *   不是引擎口径；只有名字不是 ARG 家族又没写 `=` 的槽，`Def[i]` 才真的是 null，
 *   此时 `CompatiFuncArgOptional`（默认 false）那条 `CanNotOmitArgWithMessage` 才会响；
 * - 形参名可以写成**可变下标**（`ARG:X` / `ARG:(ARG:0)`），此时个数不可证。
 *
 * 于是这一层剩下的可证错误只有一条：{@link ArityOutcome} 的 `missing-required`，
 * 而它今天**只分类、默认不上屏**（缺的那格事实见 {@link MISSING_REQUIRED_DIAGNOSABLE_BY_DEFAULT}）。
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
  /** 已摊平的可见行（`visibleCodeLineList` 产物）：多消费者共用时传它 */
  readonly visible?: readonly VisibleCodeLine[];
  /**
   * 是否把 `missing-required` 这一档定罪上屏（缺省 = {@link MISSING_REQUIRED_DIAGNOSABLE_BY_DEFAULT}，
   * 即 **false**：eraTW 语料 473 处命中全是"私有数组当形参"这一类不可证形态）。
   *
   * 只关"投影"，不关判据：`arityOutcomeOf` 的分档结论与这条开关无关。
   */
  readonly diagnoseMissingRequired?: boolean;
}

/**
 * 一处调用点（1 基行号；列均为**行内 0 基**，输出时再换算 1 基）。
 *
 * `collectArityDiagnostics`（用户函数个数）与 `builtins.ts` 的内建实参诊断
 * （个数 + 类型）共用这一形状——两处各写一遍扫描就是第二判据，漂移的表现是
 * "同一行调用，一边报一边不报"。
 */
export interface ErbCallSite {
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
  /** 逐实参槽（与 `given` 同源；类型判据按槽位对签名） */
  readonly spans: readonly ArgSpan[];
}

/** 一个实参槽的行内 0 基半开区间 */
export interface ArgSpan {
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
): ErbCallSite {
  const bounds = argBounds(raw, spans);
  return { line, name, nameStart, nameEnd, given: spans.length, argFirst: bounds.first, argLast: bounds.last, spans };
}

/**
 * `CALL` 直系族的调用点解析。
 *
 * 名字槽判据与 `scanUndefinedCallTargets` 逐字同源：关键字后**第一个记号**、与关键字之间
 * 只许空白、变量成员访问占槽不算。名字之后只认两种实参形（括号形 / 逗号形），
 * 其余（FORM 拼接、单独的成员访问）⇒ `null`，整行不判。
 */
function callSiteOf(line: VisibleCodeLine, code: string): ErbCallSite | null {
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
function expressionSites(line: VisibleCodeLine, code: string, skipStarts: ReadonlySet<number>): ErbCallSite[] {
  const raw = line.raw;
  const out: ErbCallSite[] = [];
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

/**
 * 引擎装载期会**合成**默认值的形参槽。
 *
 * 出处（`Script/Loader/ErbLoader.cs` 形参表解析；行号会漂，判据不会）：
 * 1. 每个形参槽先算 `canDef = (code == ARG|ARGS|ARGF) || Identifier.IsPrivate`；
 * 2. 槽位**没写** `= 值` 时走 `if (canDef) def = new SingleLongTerm(0)`
 *    （float→0.0、string→""）——**只要 canDef 成立，作者不写默认值引擎替他写**；
 * 3. `canDef` 之前还有两道硬门：裸名（`VariableNoArgTerm`）形参若不是私有变量直接
 *    加载失败（`ArgHasNotSubscript`），非常量下标同理（`ArgSubscriptOnlyConst`）。
 *    ⇒ 一个**能加载成功**的函数里，"裸名"形参必然落在第 2 条里（ARG 家族或私有变量）。
 *
 * 结论：`Process.CalledFunction.ConvertArg` 的 `func.Def[i]` 只对
 * **「带下标、且基础名不是 ARG 家族」的槽**（= 把全局数组元素当形参用）才是 null，
 * 省略那种槽才吃得到 `CanNotOmitArgWithMessage`
 * （`CompatiFuncArgOptional`：eraTW 的 `emuera.config:61` 明写
 * `ALLOW ARGUMENTS OMISSION FOR USER FUNCTIONS:NO`，兜不住这一档）。
 *
 * 语料对拍（`arity.corpus.test.ts`）把三档分布钉住：老判据在 4,258 文件上判出的
 * 45,079 处「少给」全部落在引擎会补默认值的槽上（`ARG:1` / `精液量` / `L_STYLE` 这一类），
 * 一处都不是可证那一档 ⇒ 「少给必需」这一腿今天只能按可证形状判。
 */
const IMPLICIT_DEFAULT_NAME = /^(?:ARG|ARGS|ARGF)\b/i;

/** 形参名里是否带下标（`NAME:3` / `NAME：3`）——裸名走引擎合成默认值那条路 */
const HAS_SUBSCRIPT = /[:：]/;

/**
 * 该槽在引擎里能否被省略（可证的那部分）。
 *
 * 显式 `=` ∨ 裸名 ∨ ARG 家族下标形 ⇒ **可证可省**（引擎补默认值）。
 * 剩下的"带下标且基础名不是 ARG 家族"那一族（`@GetRandMaterial(QYT, PriceRange:0, PriceRange:1)`）
 * 是唯一还可能是必需槽的形状——但紧邻定义行的 `#DIM PriceRange, 2` 说明它在真实语料里
 * 是**函数体内声明的私有数组**（`canDef` 成立 ⇒ 装载期照样合成默认值 ⇒ 省略合法）。
 * "函数体内私有数组"与"真全局数组元素"的差别需要 `ErbParam` 之外的第三格事实
 * （基础名的声明位置），本层今天拿不到 ⇒ 这一族只分类、默认不定罪：
 * 见 {@link MISSING_REQUIRED_DIAGNOSABLE_BY_DEFAULT}。
 */
function omissibleSlot(param: ErbParam): boolean {
  if (param.hasDefault) return true;
  if (!HAS_SUBSCRIPT.test(param.name)) return true;
  return IMPLICIT_DEFAULT_NAME.test(param.name);
}

/**
 * 「少给必需」这一档**默认不上屏**（D02 交付定，2026-11-24 eraTW 实测）。
 *
 * 判据本体活着：`arityOutcomeOf` 照样分得出 `missing-required`，`arity.test.ts` 里
 * 显式开开关直接覆盖那条支路（不是走不到的死支）。关的是"定罪"这一步——
 * 语料 473 处命中全长在 `@F(X, ARR:0, ARR:1)` + 函数体内 `#DIM ARR, 2` 这种
 * 私有数组形态上，引擎替作者把默认值补了，上屏就是 473 条假红。
 * 补齐"基础名声明在函数体内"这一格事实（`scanner.ts` / `snapshot.ts` 的活）之后
 * 把这个常量抬成 `true`，或调用点显式传 `diagnoseMissingRequired: true` 复核。
 */
export const MISSING_REQUIRED_DIAGNOSABLE_BY_DEFAULT = false;

/** 必填下界：**最后一个引擎不会补默认值的形参**序号 + 1（默认值可写在中间，不能只数个数） */
function requiredCount(params: readonly ErbParam[]): number {
  let required = 0;
  for (let i = 0; i < params.length; i++) {
    if (!omissibleSlot(params[i]!)) required = i + 1;
  }
  return required;
}

/**
 * 一处调用点对一张形参表的**可证结论**（判据的唯一真源；诊断只是它的一个投影）。
 *
 * 分成"结论 + 投影"两件事的理由：引擎对四档的容忍度本来就不同，而**接线层需要什么都能查到、
 * 但只把可证错误画上波浪线**。此前判据直接把结论烤成文案，接线层（`offload.ts`）只能拿
 * 子串去筛——那是第二判据，而且是会随措辞漂移的那一份。
 */
export type ArityOutcome =
  | { readonly kind: 'ok' }
  /** 形参表带可变下标：个数本身由运行期算，不猜 */
  | { readonly kind: 'unprovable'; readonly reason: 'variable-slot' }
  /** 多给——引擎 `ConvertArg` 只吃到 `fixedArgCount`，多余实参**静默丢弃**（既不报错也不警告） */
  | { readonly kind: 'extra'; readonly total: number; readonly given: number }
  /** 省略的槽全部有默认值（显式 `=` 或 ARG 家族的合成默认值）：引擎合法写法 */
  | { readonly kind: 'omitted-optional'; readonly total: number; readonly required: number; readonly given: number }
  /** 少给了**引擎不会补默认值**的必需槽 ⇒ `CanNotOmitArgWithMessage`：本模块唯一可证错误 */
  | {
      readonly kind: 'missing-required';
      readonly total: number;
      readonly required: number;
      readonly given: number;
      readonly paramName: string;
    };

/** 结论 = 个数与形参表的关系（**纯函数**，不碰文案） */
export function arityOutcomeOf(site: ErbCallSite, params: readonly ErbParam[]): ArityOutcome {
  if (hasVariableSlot(params)) return { kind: 'unprovable', reason: 'variable-slot' };
  const total = params.length;
  const required = requiredCount(params);
  const given = site.given;
  if (given > total) return { kind: 'extra', total, given };
  if (given < required)
    return { kind: 'missing-required', total, required, given, paramName: params[required - 1]!.name };
  if (given < total) return { kind: 'omitted-optional', total, required, given };
  return { kind: 'ok' };
}

/**
 * 结论 → 波浪线：**只有 `missing-required` 有投影**（引擎运行期真会报的那条）。
 *
 * `extra` / `omitted-optional` / `ok` / `unprovable` 一律不产——不是"留支待日后打开"，
 * 而是引擎在这一档根本不会失败，把它烤成诊断就是把作者的正常写法当错。
 */
function decorationOf(site: ErbCallSite, outcome: ArityOutcome): LineDecoration | null {
  if (outcome.kind !== 'missing-required') return null;
  const range =
    site.argFirst >= 0
      ? { startColumn: site.argFirst + 1, endColumn: site.argLast + 1 }
      : { startColumn: site.nameStart + 1, endColumn: site.nameEnd + 1 };
  return {
    line: site.line,
    severity: 'error',
    message: `函数「${site.name}」的实参个数不对：期望 ${outcome.required} 个，实际 ${outcome.given} 个——第 ${outcome.required} 个形参「${outcome.paramName}」没有默认值，实参不能省略；在这一行的实参后面用逗号补上第 ${outcome.required} 个。`,
    ...range,
    code: ARITY_MISMATCH_CODE,
  };
}

/**
 * 「这一组同名定义能不能合成一张形参表」的**唯一判据**（纯函数）。
 *
 * 多处定义（重名函数）**全部一致**（个数、逐名、默认值有无都相同）才给表；
 * 分歧 = 证明不了作者调的是哪一个 ⇒ `null`。任一处的形参表取不到（快照裁剪 /
 * 索引只留了 ref）也是 `null`——**证明不了就不猜**。
 *
 * `paramsOf` 把「ref → 形参表」这一步留给调用方：索引路径按 `filePath + startLine`
 * 回查（{@link arityParamsOf}），而**整项目一次成型**的那条路径（R4b 的批量上下文）
 * 预先建了 `startLine → ErbFunction` 的表，逐名回查是 O(1) 而不是每次 `find` 一遍。
 * 判据本身只有这一份——两条路径不可能给出不同的答案。
 *
 * `hasDefault` 在这里只是**一致性比较的一个维度**（两边写的 `= 值` 不同就是两张表），
 * 它不参与"能不能省略"的结论——那一结论由 {@link omissibleSlot} 按引擎口径再判一次。
 */
export function agreedParamsOf(
  refs: readonly ErbFunctionRef[],
  paramsOf: (ref: ErbFunctionRef) => readonly ErbParam[] | undefined,
): readonly ErbParam[] | null {
  if (refs.length === 0) return null;
  let agreed: readonly ErbParam[] | null = null;
  for (const def of refs) {
    const params = paramsOf(def);
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
 * 从项目索引取一个函数的形参表（**纯函数**，不读盘）。
 *
 * `byName` 存的是 `ErbFunctionRef`（无形参），形参表在 `files` 的同名定义上——
 * 按 `filePath + startLine` 对回 `ErbFunction`。判据本体在 {@link agreedParamsOf}。
 * 口径与 `inlay-hints.ts` 的 `inlaySlotsOf` 同源（那边只比槽名，这边还要比默认值）。
 */
export function arityParamsOf(index: ErbIndex, normalizedName: string): readonly ErbParam[] | null {
  const defs = index.byName.defsOf(normalizedName);
  if (defs.length === 0) return null;
  return agreedParamsOf(defs, (def) => index.files.get(def.filePath)?.functions.find((f) => f.startLine === def.startLine)?.params);
}

/**
 * 单可见行的调用点扫描（**纯函数**）：CALL 直系族名字槽 + 表达式里的 `名字(`。
 *
 * 判据与 `collectArityDiagnostics` 此前的行内逻辑逐字相同（CALL 名字槽优先、
 * 同一名字不进表达式结果、成员访问/FORM 拼接不判）；抽出来只为让内建实参诊断
 * 复用同一把尺子。产出顺序 = CALL 名字槽在前、表达式位按列升序。
 */
export function erbCallSitesOf(line: VisibleCodeLine, code: string): readonly ErbCallSite[] {
  const out: ErbCallSite[] = [];
  const call = callSiteOf(line, code);
  const skip = new Set<number>();
  if (call !== null) {
    skip.add(call.nameStart);
    out.push(call);
  }
  for (const site of expressionSites(line, code, skip)) out.push(site);
  return out;
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
  const lines = input.visible ?? visibleCodeLines(input.text);
  for (const line of lines) {
    if (line.isDefinition) continue;
    // 预筛：非 CALL 行且原文无 `(` ⇒ 无调用点（codeView 保长）。CALL 槽不能跳：`CALL FOO` 无括号也合法
    if (!line.isCallLine && line.raw.indexOf('(') < 0) continue;
    const code = line.codeView();
    for (const site of erbCallSitesOf(line, code)) {
      const params = input.catalog(normalizedUpper(site.name));
      if (!params) continue;
      const outcome = arityOutcomeOf(site, params);
      if (outcome.kind === 'missing-required' && !(input.diagnoseMissingRequired ?? MISSING_REQUIRED_DIAGNOSABLE_BY_DEFAULT))
        continue; // 定罪开关关着（默认）：只分类，不上屏
      const issue = decorationOf(site, outcome);
      if (issue !== null) out.push(issue);
    }
  }
  out.sort((a, b) => a.line - b.line || (a.startColumn ?? 0) - (b.startColumn ?? 0));
  return out;
}
