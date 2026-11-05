/**
 * 具名常量候选（P4，面板可用性批；纯函数，零 IO 零 React）。
 *
 * ## 补的是哪个洞
 *
 * 口上里最常见的字符串分派长这样：
 *
 * ```erb
 * SELECTCASE ARGS
 * CASE OPR_战斗前
 * ...
 * ```
 *
 * `OPR_战斗前` 不是字面量，而是同一个 ERB 文件顶部 `#DIMS CONST OPR_战斗前 = "战斗前"`
 * 声明的**具名常量**。上一批的 `argSlotCandidates`（`panel-logic.ts`）只能从谓词 AST 里
 * 捡**字面量**候选 ⇒ 这类槽一个候选都没有，作者面对一个"不知道值"的名字只能手敲。
 * 本模块先把常量声明解析成 `名字 → 值`，再把「`ARG`/`ARGS` 槽 == 具名常量」比较里的
 * **真实值**补成候选（字符串原样、数字转串），面板据此一键填 `"战斗前"`。
 *
 * 分层：文件文本由调用方（面板集成）读好传入，本模块**不碰 IO**；解析结果也只按槽键
 * 聚合成 `Map<slotKey, string[]>`，是否与字面量候选合并、怎么渲染都是面板的事。
 *
 * ## 边界（不猜的地方，逐条对应测试）
 * - 只解析**同一段文本**里的声明（真语料里常量与口上同文件；跨 `.ERH` 装载不在本模块）；
 * - 值只认**单个**整数字面量（十进制可带 `-`；另收真语料常见的 `0x` 十六进制）与
 *   **单个**带引号字符串；表达式 / 别名（`#DEFINE A B+1`）/ 数组列表（`0, 100, 500` /
 *   `"a", "b"`）/ 无值声明（`#DIM CONST REF NAME`）一律跳过——不猜；
 * - `#DIM` 家族必须带 `CONST` 修饰词：`#DIM NAME = 351` 是**可写变量**（运行期会被改），
 *   不是常量；`#DEFINE` 本身就是"定义"语义，无需修饰词；
 * - 同名**后声明覆盖先声明**（引擎按文件序解释，与 `.ERH` 名表的"先定义优先"是两回事：
 *   这里读的是**一份文件内的执行序**）；
 * - 字符串内部内容**不转义**（原样保留；引号口径与 `scanner.sliceExpression` 一致：
 *   引号内的 `;` 不当注释起点）。
 */

import type { ConditionExpr, FunctionPredicate } from '@kojo/plugin-api';
import { slotKey } from './panel-logic';

/** 一条具名常量（`name` 保留声明原样，`value` 是字面量值本身：整数或字符串） */
export interface ConstValue {
  readonly name: string;
  readonly value: string | number;
}

/**
 * 每个槽位的常量候选上限 —— 与 `panel-logic.MAX_SLOT_CANDIDATES` **同数（20）**。
 * 不直接 import 那个常量：它是"字面量候选"的口径，本模块是另一路来源，两者的上限
 * 各自成立（面板合并两路后如需再截，由面板决定），协同的是数字而非耦合。
 */
export const MAX_CONST_CANDIDATES = 20;

/** 参与候选的比较运算符（与契约 `ConditionComparison.op` 同表；`argSlotCandidates` 同口径） */
const COMPARISON_OPS = new Set(['==', '!=', '<', '<=', '>', '>=']);

/**
 * `#DIM` 家族里本模块认的声明指令：`DIM`（数值）/ `DIMS`（字符串）/ `DIMSTR`（字符串别名）。
 * `DIMF` 是浮点、`DIMCHAR` 是字符（`#DIMCHAR CONST` 声明的是字符维，不是名字=值），
 * 两者的值都不是"整数或字符串"⇒ 不在解析范围内。
 */
const DIM_DIRECTIVES = new Set(['DIM', 'DIMS', 'DIMSTR']);

/**
 * 声明前置修饰词（Emuera `UserDefinedVariableData.Create` 认的关键词集）：
 * 顺序任意、可出现多个（实测 `#DIM CONST SAVEDATA` / `#DIM SAVEDATA CONST` 都有）。
 */
const DIM_MODIFIERS = new Set([
  'CONST',
  'SAVEDATA',
  'GLOBAL',
  'REF',
  'NOINIT',
  'CHARA',
  'LOCAL',
  'STATIC',
  'DYNAMIC',
  'OUT',
  'CHARADATA',
]);

/** 名字里不许出现的字符（名字是一个记号；出现这些说明把数组/表达式/注释尾巴当名字了） */
const BAD_NAME_CHARS = /[\s\u3000=,()[\]{}:"'#$]/;

/**
 * 行首「代码前缀」`;!;` / `;#;` 的长度（0 = 没有）。
 *
 * 与 `erb-parser/scanner.ts` 的 `erbCodePrefixLength` 同判据（插件间禁 import，就地镜像）：
 * `;!;[SKIPSTART]` 在引擎里**真的**开停用区，`[SKIPEND]` 对称——屏蔽状态算错会让
 * 死区里的"声明"混进候选表。
 */
function codePrefixLength(trimmed: string): number {
  if (trimmed.length < 3) return 0;
  const head = trimmed.slice(0, 3);
  return head === ';!;' || head === ';#;' ? 3 : 0;
}

/**
 * 引号之外截断行内注释（`;` 起）。
 * 字符串内的 `;` 原样保留（`#DIMS CONST S = "a;b"` 的值就是 `a;b`）——
 * 与 `erb-parser/scanner.ts` 的 `sliceExpression`、`condition-extractor` 的
 * `sliceInlineComment` 同一规则。未闭合引号按"到行尾都是字符串"处理（不截断），
 * 这类行后面的值解析会因缺收尾引号失败 ⇒ 自然跳过，不做二次猜测。
 */
function stripInlineComment(line: string): string {
  let inStr = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (!inStr && c === ';') return line.slice(0, i);
  }
  return line;
}

/** 名字是否像一个声明名（非空、不含分隔/括号/引号/注释符这类"越界"字符） */
function isConstName(name: string): boolean {
  return name.length > 0 && !BAD_NAME_CHARS.test(name);
}

/**
 * 值解析（只认能证明的）：整数字面量 → number；单个带引号字符串 → string（内部原样）。
 *
 * - 十进制可带 `-`（`#DIM CONST N = -5`）；超出安全整数 → undefined（不丢精度地猜）；
 * - `0x` 十六进制也认（真语料 `#DIM CONST C_YELLOW = 0xFFFF00` 一类，engine 视作整数）；
 * - 其它一律 undefined：表达式（`0x44 + 1`）、别名（`既成事実&1p0`）、变量名、数组列表。
 */
function parseValueLiteral(raw: string): string | number | undefined {
  const t = raw.trim();
  if (/^-?\d+$/.test(t)) {
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  if (/^0[xX][0-9a-fA-F]+$/.test(t)) {
    const n = Number.parseInt(t.slice(2), 16);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  // 单个字符串：必须以引号起、以引号止，且**内部没有引号**。
  // `"a", "b"`（字符串列表）内部有一枚收尾引号 ⇒ 不命中（否则贪婪匹配会把它吞成一个值）；
  // `"a"x`（引号后还有残留）同样不命中。转义形态（如 `\"`）内部也含引号 ⇒ 一律跳过不猜。
  const sm = /^"([^"]*)"$/.exec(t);
  if (sm) return sm[1]!;
  return undefined;
}

/** 收一条声明：键按**大写**归一（引擎标识符大小写不敏感），同名后声明覆盖先声明 */
function putConst(out: Map<string, ConstValue>, name: string, value: string | number): void {
  const key = name.toUpperCase();
  if (key.length === 0) return;
  out.set(key, { name, value });
}

/**
 * 解析 `#DIM` 家族声明体（指令之后、注释已截断）：`[*修饰词] NAME [= 值]`。
 *
 * 只收带 `CONST` 的（无 CONST 的是可写变量）；没有 `=`（`#DIM CONST REF NAME`）或值不是
 * 字面量 ⇒ 跳过。`[` / `,` 出现即视为数组声明 / 新变量族，名字校验会把它挡掉。
 */
function parseDimBody(out: Map<string, ConstValue>, input: string): void {
  let rest = input;
  const modifiers = new Set<string>();
  for (;;) {
    const km = /^([A-Za-z_][A-Za-z0-9_]*)(?=[\s\u3000=,[]|$)/.exec(rest);
    if (!km) break;
    const keyword = km[1]!.toUpperCase();
    if (!DIM_MODIFIERS.has(keyword)) break;
    modifiers.add(keyword);
    rest = rest.slice(km[1]!.length).trim();
  }
  // 可写变量不是常量：`#DIM NAME = 351` 的值运行期会被改，收了就是猜
  if (!modifiers.has('CONST')) return;
  const eq = rest.indexOf('=');
  if (eq < 0) return; // `#DIM CONST REF NAME`：声明的是引用，没有可证明的值
  const name = rest.slice(0, eq).trim();
  if (!isConstName(name)) return;
  const value = parseValueLiteral(rest.slice(eq + 1));
  if (value === undefined) return;
  putConst(out, name, value);
}

/**
 * 解析 `#DEFINE NAME 值`（指令之后、注释已截断）：名字到第一个空白为止，其余是值。
 * 没有值时跳过（`#DEFINE NAME` 只是登记符号）；值不是字面量同理。
 */
function parseDefineBody(out: Map<string, ConstValue>, input: string): void {
  if (input.length === 0) return;
  const sp = input.search(/[\s\u3000]/);
  if (sp < 0) return;
  const name = input.slice(0, sp);
  if (!isConstName(name)) return;
  const value = parseValueLiteral(input.slice(sp));
  if (value === undefined) return;
  putConst(out, name, value);
}

/**
 * 解析一段 ERB 文本里的具名常量声明（纯函数）。
 *
 * 认的形态（宽容、只收能证明的）：
 * ```erb
 * #DIM CONST NAME = 42            ; 修饰词顺序任意、可多个
 * #DIMS CONST NAME = "文本"        ; 字符串常量（口上字符串分派的主力）
 * #DIMSTR CONST NAME = "文本"
 * #DEFINE NAME 42
 * ```
 * 处理规则：
 * - 行尾 `;` 注释先截（引号内的 `;` 不截）；
 * - `[SKIPSTART]` … `[SKIPEND]` 区间整段跳过（含两枚标记行；嵌套 `[SKIPSTART]` 不叠层，
 *   区内只认 `[SKIPEND]`，与 scanner 同判）；`;!;` / `;#;` 前缀先剥再判标记；
 * - 声明行必须**行首**就是 `#`（`;!;` 之后是语句，不是预处理器行）；
 * - 同名后声明覆盖先声明（引擎按文件序解释）。
 *
 * @param text 一段 ERB 文本（可含多行；调用方给整份文件文本）
 * @returns 键 = **大写归一**名字（引擎标识符大小写不敏感）；无声明 → 空 Map
 */
export function parseConstDeclarations(text: string): Map<string, ConstValue> {
  const out = new Map<string, ConstValue>();
  let inSkip = false;
  for (const rawLine of text.split(/\r\n?|\n/)) {
    // `trim()` 顺带吃掉行首 BOM（U+FEFF 属 WhiteSpace）
    const outer = rawLine.trim();
    const prefix = codePrefixLength(outer);
    const body = prefix === 0 ? outer : outer.slice(prefix);
    if (inSkip) {
      if (body === '[SKIPEND]') inSkip = false;
      continue;
    }
    if (body === '[SKIPSTART]') {
      inSkip = true;
      continue;
    }
    // 声明行必须行首就是 `#`：剥掉代码前缀后的 `#`（`;!;#DIM …`）是语句不是预处理器行
    if (!outer.startsWith('#')) continue;
    const line = stripInlineComment(outer).trim();
    if (line.length === 0) continue;
    const m = /^#([A-Za-z_]+)(?=[\s\u3000]|$)([\s\S]*)$/.exec(line);
    if (!m) continue;
    const directive = m[1]!.toUpperCase();
    const rest = (m[2] ?? '').trim();
    if (directive === 'DEFINE') {
      parseDefineBody(out, rest);
      continue;
    }
    if (!DIM_DIRECTIVES.has(directive)) continue;
    parseDimBody(out, rest);
  }
  return out;
}

/**
 * `ARG`/`ARGS` 槽引用 → `{ kind, index }`；非槽引用 / 动态下标 → null（不猜）。
 * 判据与 `panel-logic.argSlotRef` **同形**（裸名 ≡ `:0`，与引擎寻址一致）；
 * 动态下标（`ARG:ARG:0`、`ARGS:RESULT`）静态看不出是哪一格，跳过。
 */
function argSlotRef(expr: ConditionExpr): { kind: 'int' | 'str'; index: number } | null {
  if (expr.kind !== 'ref') return null;
  const name = expr.name.toUpperCase();
  if (name !== 'ARG' && name !== 'ARGS') return null;
  const rawIdx = expr.indices[0];
  const idx = rawIdx === undefined ? 0 : /^\d+$/.test(rawIdx) ? Number(rawIdx) : null;
  if (idx === null) return null;
  return { kind: name === 'ARG' ? 'int' : 'str', index: idx };
}

/**
 * 常量引用侧取值：`ref`（裸名、无下标）或 `nameValue`（`[[词]]`）的大写名在表里 ⇒ 返回
 * 声明值；否则 null。
 *
 * 带下标的 `ref`（`CONST_NAME:2`）是**变量元素**而不是常量值本身 ⇒ 不算常量引用。
 */
function constRefValue(expr: ConditionExpr, consts: ReadonlyMap<string, ConstValue>): string | number | null {
  if (expr.kind === 'nameValue') {
    return consts.get(expr.name.toUpperCase())?.value ?? null;
  }
  if (expr.kind !== 'ref') return null;
  if (expr.indices.length > 0) return null;
  return consts.get(expr.name.toUpperCase())?.value ?? null;
}

/**
 * 把「`ARG`/`ARGS` 槽 == 具名常量」比较里的常量值变成候选（纯函数）。
 *
 * 递归范围与 `argSlotCandidates` / `exprArgSlots` 同口径：binary 两侧、ternary 三段、
 * call 参数、unary 操作数（CASE 展开形 `subject == 值` 天然是 binary）。命中的条件：
 * 一侧是 `ARG`/`ARGS` 静态下标引用，另一侧是 `ref`/`nameValue` 且大写名在 `consts` 里；
 * 比较符限 `==` `!=` `<` `<=` `>` `>=`（与契约 `ConditionComparison.op` 同表）。
 *
 * 候选文本：字符串**原样**、数字 `String(n)`；按首次出现序去重，每槽上限
 * {@link MAX_CONST_CANDIDATES}（20）。空串常量值不产出（槽文本为空 = "未填"，不可区分）。
 *
 * @param predicates 单函数的谓词明细（`functionPredicates` 的产物；CASE 已展开）
 * @param consts {@link parseConstDeclarations} 的结果（键大写归一）
 * @returns 键 = `slotKey(kind, index)` 同形（`int:0` / `str:1`）；只含**有候选**的槽
 */
export function resolveConstCandidates(
  predicates: readonly FunctionPredicate[],
  consts: ReadonlyMap<string, ConstValue>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (consts.size === 0) return out;
  const seen = new Map<string, Set<string>>();
  const add = (kind: 'int' | 'str', index: number, value: string | number): void => {
    const text = typeof value === 'number' ? String(value) : value;
    if (text.length === 0) return; // 空串与"没填"在槽里不可区分 ⇒ 不当候选
    const key = slotKey(kind, index);
    let list = out.get(key);
    if (!list) {
      list = [];
      out.set(key, list);
      seen.set(key, new Set());
    }
    if (list.length >= MAX_CONST_CANDIDATES) return;
    const dedupe = seen.get(key)!;
    if (dedupe.has(text)) return;
    dedupe.add(text);
    list.push(text);
  };
  const walk = (expr: ConditionExpr): void => {
    switch (expr.kind) {
      case 'binary': {
        if (COMPARISON_OPS.has(expr.op)) {
          const leftSlot = argSlotRef(expr.left);
          const rightConst = constRefValue(expr.right, consts);
          if (leftSlot && rightConst !== null) add(leftSlot.kind, leftSlot.index, rightConst);
          const rightSlot = argSlotRef(expr.right);
          const leftConst = constRefValue(expr.left, consts);
          if (rightSlot && leftConst !== null) add(rightSlot.kind, rightSlot.index, leftConst);
        }
        walk(expr.left);
        walk(expr.right);
        return;
      }
      case 'ternary':
        walk(expr.cond);
        walk(expr.then);
        walk(expr.else);
        return;
      case 'call':
        for (const a of expr.args) walk(a);
        return;
      case 'unary':
        walk(expr.operand);
        return;
      default:
        return; // literal / ref / nameValue / opaque：没有更深的比较
    }
  };
  for (const p of predicates) walk(p.expr);
  return out;
}
