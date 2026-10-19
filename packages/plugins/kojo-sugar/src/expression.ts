/**
 * 表达式降糖（规范 §3.4 / §3.5 / §3.8 / §4.3 / §5.0）。
 *
 * 输入是**表层表达式原文**（可能含中文运算符、代词、属性访问、别名），
 * 输出是原生 ERB 表达式。本模块零游戏知识——「变量名 → 变量族」的解析
 * 走注入的字典查询（`DictionaryLookup`，由 adapter 提供）。
 *
 * 两条纪律：
 * 1. **系统函数名先，别名次之**（HK-11① + 规范 §5.0 第 0 步）：先把中文系统函数名
 *    降为 ERB 函数名（`获取标记(` → `GETBIT(`），再做别名替换；
 * 2. **宽容但不静默**：不认识的标识符不原样输出，而是报诊断
 *    （`unknown-identifier` / `alias-unknown-target`）——口上里拼写错误
 *    几乎一律表现为"口上静默失效"，必须显式暴露。
 *    唯一的**原样放行**通道是 `engine-globals.ts` 的裸引擎全局白名单
 *    （`SELECTCOM` / `ARG` / `TARGET` …）：那些是引擎固定词、作者造不出这个名字，
 *    放行不会掩护拼写错误（判据与语料实测计数见该模块头注）。
 *    带族头的 `族头:具名索引`（`NOWEX:噴乳`）走**另一条**通道：族头认得出就原样进产物，
 *    但 P-10③（2026-10-14）起**不再零诊断**——字典的族名表在位而名称查无时报
 *    `family-name-unknown`（**warning**，产物照旧；口径见 `reportUnlistedFamilyName`）。
 */

import type { AliasValue, KojoLibraryTable, SugarDiagnostic, SugarPosition } from '@kojo/plugin-api';
import { operatorTable, NOTIN_KEYWORDS, RESERVED_PRONOUNS, argPositionToken, VARIADIC_ARG_NUMERIC, VARIADIC_ARG_STRING } from './keywords';
import { isKnownFunctionName, lowerSystemFunctions, suggestFunctionName } from './system-functions';
import { resolveEngineGlobal } from './engine-globals';
import { isIdentPart, isIdentStart } from './identifier-chars';
import { CJK } from './lexer';
import type { AliasTable, DictionaryLookup } from './types';

/** 降糖上下文 */
export interface ExprContext {
  /** 别名表（文件级；规范 §3.1 ③ 不跨文件） */
  aliases: AliasTable;
  /** 变量字典（adapter 提供；缺省 = 无字典，属性/裸标识符一律报错） */
  dictionary?: DictionaryLookup;
  /**
   * 基础库 / 常用函数名表（adapter 提供；游戏知识；ZH-F1）。
   * 本层把**中文函数名调用形态**降为原生 ERB 函数名（系统函数表优先，本表次之）；
   * 缺省 = 该适配器未声明 → 未收录的中文调用形态**原样保留**并**分级**报诊断
   * （ZH-D1：表内有唯一高置信近名 ⇒ `function-name-typo` **error**；纯未知 ⇒
   * `function-name-unknown` **warning**。判据见 `system-functions.ts::suggestFunctionName`）。
   */
  libraryTable?: KojoLibraryTable;
  /** 诊断收集器 */
  report: (diag: SugarDiagnostic) => void;
  /** 诊断定位（表达式子串的起始位置；列偏移由调用方补齐） */
  loc: SugarPosition | null;
  /**
   * 文件头 `角色:` 解析出的**角色编号**（1 号任务 `初回` 用；编号只从 adapter 解析结果来，
   * `初回("key", 初期値)` 的二参形在此值存在时补成三参
   * `ONCE("key", 初期値, <charNo>)`；缺省 = 不补（原样透传）。
   */
  charNo?: string;
  /**
   * 当前作用域声明的**实参槽位数**（v1.7）：用户函数 = 形参表长度；时机 = `参数:`
   * 归一化后的令牌数（无声明 = 0）。`实参:n` / `实参$:n` 引用位置 `n-1 ≥ 本数`
   * （未声明槽位）时**报 error、绝不产静默空值**——引擎对未声明槽位的实参是静默丢弃
   * （读到 0，见规范 §3.2 沙盒实测）。缺省 = 0（任何 `实参` 引用都 fail-visible）。
   */
  argSlotCount?: number;
  /**
   * 条件别名展开的**环检测**栈（`别名 A = A ? …` 自引用会让条件降糖无限递归）。
   * 本层内部使用，调用方无需设置（`substituteAliases` 惰性初始化）。
   */
  expanding?: Set<string>;
}

/**
 * 判断是否为"裸标识符"（含可能的 `:` 索引段），返回结束下标；否则 -1。
 *
 * 字符集走 `./identifier-chars`（**单一真源**，与 `system-functions.ts` 的函数名扫描
 * 同一张表）：ERB 变量引用 = `IDENT` 或 `IDENT:index`（`index` 可为数字 / 中文名），
 * 中文名必须支持（规范 §3.8：`CFLAG:TARGET:诶嘿嘿`），全角拉丁字母也必须支持
 * （语料四面族写 `NOWEX:Ｃ絶頂`）——口径连同理由写在 `identifier-chars.ts`。
 */
function scanIdentifier(src: string, from: number): number {
  if (from >= src.length || !isIdentStart(src[from]!)) return -1;
  let i = from + 1;
  while (i < src.length && isIdentPart(src[i]!)) i++;
  return i;
}

/** 全角空格（规范 §8：全角标点检测） */
export const FULLWIDTH_SPACE = '\u3000';

/* ============================ 字面量与字符串保护 ============================ */

/**
 * 把表达式切成「代码段」与「字符串字面量段」——降糖**不进入**字符串字面量
 * （规范 §5.0 第 1-a 步：不进入字符串字面量与注释）。
 *
 * ERB 字符串字面量用 `"` 包裹（无转义概念，引擎的 `"` 不可内嵌）。
 */
function splitStringLiterals(expr: string): { text: string; isString: boolean }[] {
  const out: { text: string; isString: boolean }[] = [];
  let buf = '';
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (ch === '"') {
      if (buf.length > 0) {
        out.push({ text: buf, isString: false });
        buf = '';
      }
      let j = i + 1;
      while (j < expr.length && expr[j] !== '"') j++;
      out.push({ text: expr.slice(i, Math.min(j + 1, expr.length)), isString: true });
      i = Math.min(j + 1, expr.length);
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.length > 0) out.push({ text: buf, isString: false });
  return out;
}

/* ============================== 别名替换（§5.0） ============================== */

/** 别名替换结果：`text` = 替换后的表达式；`hitAlias` = 是否命中过别名 */
interface AliasSubstitution {
  text: string;
  /** 命中别名的目标原文（用于记录"该表达式引用了哪些别名"，供 lint 复用） */
  used: string[];
}

/**
 * 别名替换（规范 §5.0 第 1 步）——在代码段内做**词边界**替换。
 *
 * 各形态处理：
 * - `variable`：读位置 → 目标变量引用原文（`CFLAG:TARGET:1088`）；
 * - `character`：表达式位置 → `%CALLNAME:N%`（字符串插值形态；ERB 中
 *   `%…%` 是字符串记号，在条件表达式里按字符串比较）；
 * - `number` / `string`：表达式位置 → 字面量**纯文本展开**（规范 §5.0 边注）；
 * - `conditional`：表达式位置 → 行内条件 `\@条件?真#假\@`（B3）。**先占位、末尾回填**：
 *   分支是字面量片段（同 codegen `expandFragment`），若让它随本层产物流过后续
 *   运算符/代词降糖，`?只有你#别靠太近` 里的 `你` / `她的X` 会被静默改写
 *   （正是 `expandFragment` 那条回归的口径）。占位符在 `lowerExpression` 末尾
 *   原样回填 ⇒ 分支/条件**不再经过任何降糖** ⇒ 与 `{}` 行内条件逐字节同款。
 *
 * 注意：`character` / `number` / `string` / `conditional` 是**只读**的；出现在赋值
 * 左值时由调用方（`expandTarget`）报 `readonly-alias-assignment`——本函数只负责展开。
 */
function substituteAliases(expr: string, ctx: ExprContext, deferred: string[]): AliasSubstitution {
  const used: string[] = [];
  const parts = splitStringLiterals(expr);
  const out = parts.map((part) => {
    if (part.isString) return part.text;
    return replaceInCode(part.text, (ident) => {
      const alias = ctx.aliases.get(ident);
      if (!alias) return null;
      used.push(ident);
      if (alias.value.kind === 'conditional') {
        // 环检测：`别名 A = A ? …` 的条件降糖会无限递归。自引用时不展开（保持原样，
        // 由既有 `unknown-identifier` 兜底——**不新增诊断码**）。
        const guard = (ctx.expanding ??= new Set<string>());
        if (guard.has(ident)) return null;
        guard.add(ident);
        const expansion = aliasValueToExpression(alias.value, ctx);
        guard.delete(ident);
        deferred.push(expansion);
        return `${COND_SLOT_OPEN}${deferred.length - 1}${COND_SLOT_CLOSE}`;
      }
      return aliasValueToExpression(alias.value);
    });
  });
  return { text: out.join(''), used };
}

/** 条件别名占位符（PUA 包裹——非标识符字符，运算符/代词/`不在` 降糖一律绕过它） */
const COND_SLOT_OPEN = '\uE000';
const COND_SLOT_CLOSE = '\uE001';
const COND_SLOT_RE = /\uE000(\d+)\uE001/g;

/** 别名右值 → 表达式形态原文（只读性由调用方判定；`ctx` 仅条件形态需要） */
export function aliasValueToExpression(value: AliasValue, ctx?: ExprContext): string {
  switch (value.kind) {
    case 'variable':
      return value.text;
    case 'character':
      return `%CALLNAME:${value.no}%`;
    case 'number':
      return value.text;
    case 'string':
      return `"${value.text}"`;
    case 'conditional':
      return conditionalAliasExpression(value, ctx);
  }
}

/**
 * 条件别名 → ERB 行内条件（B3）。
 *
 * 产物形态与 `{}` 行内条件**逐字节同款**（规范 §3.4；codegen `renderInterpolation`
 * 的 `\\@${cond}?${then}#${else}\\@`）：省略假分支 → `\@条件?真\@`，不加空格。
 * - 条件 → 表达式降糖（同 `renderInterpolation` 对 `it.condText` 的处理）；
 * - 分支 → 字面量片段，只降糖 `%…%`（同 codegen `expandFragment`）。
 * 无 `ctx`（纯函数调用点）时条件/分支原样——由调用方保证带台账走完整降糖。
 */
function conditionalAliasExpression(
  value: Extract<AliasValue, { kind: 'conditional' }>,
  ctx?: ExprContext,
): string {
  const cond = ctx ? lowerExpression(value.cond, ctx) : value.cond;
  const thenText = ctx ? expandBranchFragment(value.thenText, ctx) : value.thenText;
  const elseText = value.elseText === undefined
    ? undefined
    : ctx
      ? expandBranchFragment(value.elseText, ctx)
      : value.elseText;
  if (elseText === undefined || elseText.length === 0) return `\\@${cond}?${thenText}\\@`;
  return `\\@${cond}?${thenText}#${elseText}\\@`;
}

/** 行内条件分支片段降糖：只动 `%…%` 内的原生表达式，其余字面量原样（同 codegen `expandFragment`） */
function expandBranchFragment(fragment: string, ctx: ExprContext): string {
  return fragment.replace(/%([^%]+)%/g, (_whole, inner: string) => `%${lowerExpression(inner, ctx)}%`);
}

/**
 * 代码段内做标识符替换。
 *
 * 替换器返回 `null` = 不替换；否则返回替换文本。
 * 扫描时**跳过** `IDENT:index` 的 `:index` 部分——别名是"整个变量引用"的
 * 简写，`别名 X = CFLAG:…` 后 `X` 不会再被 `:` 索引（规范未定义索引别名）。
 */
function replaceInCode(code: string, replacer: (ident: string) => string | null): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const end = scanIdentifier(code, i);
    if (end < 0) {
      out += code[i]!;
      i++;
      continue;
    }
    const ident = code.slice(i, end);
    const replacement = replacer(ident);
    out += replacement ?? ident;
    i = end;
  }
  return out;
}

/* ======================== 家族头中文别名（D2，§表达式族头中文化） ======================== */

/**
 * 家族头中文别名替换（D2）——`<别名>:` / `<别名>：` → `<引擎族头>:`（**冒号归一为半角**）。
 *
 * 硬性约束（一条不满足即不替换）：
 * 1. **挂在系统函数名降糖之后**（见 `lowerExpression` 的顺序注释）：`获取标记(` 此时已是
 *    `GETBIT(`；且下方只认"紧跟冒号"的形态，两重保险；
 * 2. **只认 `<别名>` 紧跟 `:` 或全角 `：`**（`现在:噴乳` / `现在：噴乳`）；**不跟冒号一律不碰**
 *    ——这是避开 `获取标记(` / 裸词 `标记` 等误伤的主判据；
 * 3. **作者别名优先**：`ctx.aliases` 已有同名条目 ⇒ **不替换**（作者写了 `别名 现在 = …`）；
 * 4. **表住 adapter**：查 `ctx.dictionary?.familyAlias`（缺省 / 未登记 ⇒ 不替换，不猜）。
 *
 * 全角冒号**只在这一个位置**容忍（历史上 SIF 的冒号有歧义 ⇒ 不做表达式级全局归一）。
 * 段条件（`若 …：`）/ `如果` / `当` / 行内条件天然同源生效——本函数就在唯一降糖管线里，
 * **不另建第二套替换器**（lexer/parser 也不重复做）。
 */
function lowerFamilyAliases(code: string, ctx: ExprContext): string {
  const alias = ctx.dictionary?.familyAlias;
  if (!alias) return code;
  let out = '';
  let i = 0;
  while (i < code.length) {
    const end = scanIdentifier(code, i);
    if (end < 0) {
      out += code[i]!;
      i++;
      continue;
    }
    const name = code.slice(i, end);
    const next = code[end];
    if ((next === ':' || next === '：') && !ctx.aliases.has(name)) {
      const family = alias(name);
      if (family !== undefined && family.length > 0) {
        out += `${family}:`;
        i = end + 1;
        continue;
      }
    }
    out += name;
    i = end;
  }
  return out;
}

/* ============================ 代词与属性（§3.8） ============================ */

/** 代词 → 字符串插值（`{她}` → `%CALLNAME:TARGET%`） */
const PRONOUN_MAP: ReadonlyMap<string, string> = new Map([
  ['她', '%CALLNAME:TARGET%'],
  ['你', '%CALLNAME:MASTER%'],
]);

/**
 * **反向**代词表（原生记号 → 糖代词；`%CALLNAME:TARGET%` → `她`）——升糖**投影**用
 * （`project.ts`：把别人写的 ERB 显示成糖，让不懂 EraBasic 的人也能读懂台词）。
 *
 * 从 `PRONOUN_MAP` **派生**，而不是手写第二份：正反两向分开维护必然漂移
 * （改了正向忘改反向 = 投影显示出糖里根本不存在的写法）。派生让"正反对称"
 * 成为**构造事实**，不靠纪律。
 */
export const PRONOUN_REVERSE: ReadonlyMap<string, string> = new Map(
  [...PRONOUN_MAP].map(([pronoun, form]) => [form, pronoun] as const),
);

/** 属性访问：`她的X` / `你的X` → 变量族查询（规范 §3.8） */
const ATTRIBUTE_PREFIX: ReadonlyMap<string, string> = new Map([
  ['她的', 'TARGET'],
  ['你的', 'MASTER'],
]);

/**
 * 表达式降糖主入口。
 *
 * 顺序（不可调换）：系统函数名 → 别名替换 → 代词 → 属性 → 中文运算符 → `不在`。
 * 原因：系统函数名（HK-11①）是**词形级**的、别名替换是**文本级**的（规范 §5.0
 * 明确"先于所有其它降糖"）、代词/属性/运算符是**结构级**的；系统函数名先做，
 * 使 `获取标记(…)` 在后续各步眼里是原生 `GETBIT(…)`。
 */
export function lowerExpression(raw: string, ctx: ExprContext): string {
  // ---- 0. `初回(...)` → `ONCE(...)`（1 号任务；先于一切，见 `lowerOnceCalls` 头注） ----
  const onceLowered = lowerOnceCalls(raw, ctx);

  // ---- 0. 系统函数名中文化（HK-11①；先于一切，见模块头注顺序说明） ----
  // 系统函数表优先，次查 adapter 基础库函数表（ZH-F1）：两者都认的调用形态降为原生名。
  const named = lowerSystemFunctions(onceLowered, ctx.libraryTable);

  // ---- 0b. 别名替换（先于一切降糖） ----
  // 条件别名先占位（`deferred`），待第 3 步后原样回填——分支/条件不再被后续降糖波及。
  const deferred: string[] = [];
  const substituted = substituteAliases(named, ctx, deferred).text;

  // ---- 0c. 家族头中文别名（D2；挂在系统函数名降糖之后，见 `lowerFamilyAliases` 头注）----
  // 只认 `<别名>` 紧跟 `:`/`：` 的形态；作者同名别名优先（其替换已在 0b 生效 / 显式跳过）。
  const familyAliased = replaceInCodeOutsideStrings(substituted, (code) => lowerFamilyAliases(code, ctx));

  // ---- 1–3. 表达式主体（中文运算符 → `不在` → 代词与属性） ----
  const expr = lowerExpressionCore(familyAliased, ctx);

  // ---- 4. 条件别名回填（行内条件 `\@条件?真#假\@`；用函数式替换避免 `$` 被当替换模式） ----
  if (deferred.length === 0) return expr;
  return expr.replace(COND_SLOT_RE, (_whole, digits: string) => deferred[Number(digits)] ?? '');
}

/* ======================= 全角标点检查（1019 批 P0） ======================= */

/** 诊断文案里的语境词（作者视角；不提"规则/码"） */
export type FullwidthPunctWhere = 'condition' | 'assignment' | 'expression';

const FULLWIDTH_PUNCT_WHERE_LABEL: Readonly<Record<FullwidthPunctWhere, string>> = {
  condition: '条件',
  assignment: '赋值',
  expression: '表达式',
};

/**
 * 表达式源切片的**全角标点**检查：引擎只认半角 `:` / `=`。
 *
 * 为什么必须拦：`如果 CFLAG：1：2 == 0：` 会被原样编成 `IF CFLAG：1：2 == 0`，
 * `CFLAG：1：2 ＝ 3` 甚至会被当台词打印（`PRINTFORMDW …`）——零诊断、坏字节落盘。
 *
 * 口径（只此两类字符，别扩大）：
 * - 报全角冒号 `：` 与全角等号 `＝`；跳过双引号字面量内部（那是作者要打印/比较的文本）；
 * - **例外**：`：` 紧跟**已登记族头别名**（`现在：噴乳`，D2 糖面）不报——`lowerFamilyAliases`
 *   会把它归一成半角，属合法写法；查表走 `ctx.dictionary.familyAlias`（未注入 ⇒ 不豁免）。
 * - `loc` = 表达式切片起点（列 1 基）；命中位置按码元偏移逐个后移。**error**——
 *   `compileToBytes` / `planSave` 见 error 即整体拒绝落盘（既有闸，不另造通道）。
 */
export function reportFullwidthExprPunct(
  raw: string,
  ctx: ExprContext,
  where: FullwidthPunctWhere = 'expression',
): void {
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '：' && isFamilyAliasColon(raw, i, ctx)) continue;
    if (ch !== '：' && ch !== '＝') continue;
    const half = ch === '：' ? ':' : '=';
    const loc = ctx.loc;
    ctx.report({
      code: 'fullwidth-expr-punct',
      severity: 'error',
      message: `${FULLWIDTH_PUNCT_WHERE_LABEL[where]}里用了全角「${ch}」——引擎不认，请改成半角「${half}」。`,
      loc: loc ? { line: loc.line, column: loc.column + i } : null,
    });
  }
}

/**
 * 该 `：` 是否是 D2 族头别名的合法糖面（`<已登记别名>：<槽>`）。
 *
 * 判据与 `lowerFamilyAliases` 逐字同源：向前扫一个完整标识符，作者同名别名优先
 * （`ctx.aliases` 有登记 ⇒ 不豁免——那正是 `防护②` 的口径）。
 */
function isFamilyAliasColon(raw: string, at: number, ctx: ExprContext): boolean {
  const alias = ctx.dictionary?.familyAlias;
  if (!alias) return false;
  let start = at - 1;
  while (start >= 0 && isIdentPart(raw[start]!)) start--;
  if (start === at - 1) return false;
  const name = raw.slice(start + 1, at);
  if (ctx.aliases.has(name)) return false;
  const family = alias(name);
  return family !== undefined && family.length > 0;
}

/**
 * 表达式主体降糖（**步骤 1–3**：中文运算符 → `不在` → 代词与属性）——不含别名替换（步骤 0b）
 * 与条件别名回填（步骤 4）。
 *
 * 抽成独立函数的唯一理由 = **位名表层语法**（v1.8）：`GETBIT(<变量引用>, <位名>)` 的第一
 * 实参（变量引用）要在步骤 3 的 `GETBIT(` 挂钩处**单独**走一遍步骤 3，才能得到
 * 「族头:…:索引」形态的变量引用，好交给 `DictionaryLookup.bitIndexOf` 解析位名。该子表达式
 * 此时已过外侧的 0b/0c/1/2（重跑步骤 1/2 幂等），故只需补步骤 3（本函数照全跑）。
 * 两条位槽路（表达式形 / 语句形）据此**共用同一枚解析函数 `resolveBitSlotName`**（单一真源）。
 */
function lowerExpressionCore(code: string, ctx: ExprContext): string {
  // ---- 1. 中文运算符（在字符串字面量外） ----
  let expr = replaceInCodeOutsideStrings(code, (c) => lowerOperators(c));

  // ---- 2. `不在`（范围取反；结构级，需整段扫描） ----
  expr = lowerNotIn(expr, ctx);

  // ---- 3. 代词与属性（在字符串字面量外） ----
  expr = replaceInCodeOutsideStrings(expr, (c) => lowerPronounsAndAttributes(c, ctx));

  return expr;
}

/**
 * `初回(...)` → `ONCE(...)`（1 号任务）——引擎 `ONCE` 变量式访问器的表达式 / 块头降糖。
 *
 * 为什么单列一步、而不塞进 `SYSTEM_FUNCTION_ALIASES`：`ONCE` 是**变量式访问器**
 * （`ONCE(名称, 初期値, キャラ番号…)`，可读可写），它的**二参形**要按文件头 `角色:` 的
 * 编号**补第三参**——这不是"换名"，别名表机制表达不了（且反向投影会把它当普通函数）。
 *
 * 口径（对齐真实语料 `M_KOJO_K11_*.ERB`）：
 * - 一参 `初回("key")` → `ONCE("key")`（原样）；
 * - 二参 `初回("key", 1)` → `ONCE("key",1,<charNo>)`（**有** `角色:` 编号时补第三参）；
 * - ≥三参原样（作者已显式给了角色号）；
 * - 顶层逗号规整为无空格半角 `,`（与语料产物对齐）；
 * - 尊重字符串字面量与括号配对（`"初回("` 不被误换；参数里的括号不打乱拆参）；
 * - 零参 `初回()` → 报 `block-empty`（复用既有码；不静默）。
 *
 * 只在 `初回` 后（可隔空白）紧跟 `(` 时触发；`初回` 作为更大标识符的一部分不触发
 * （前必须是标识符边界）。
 */
function lowerOnceCalls(raw: string, ctx: ExprContext): string {
  const NAME = '初回';
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    // 字符串字面量原样透传（降糖不进入字符串）
    if (ch === '"') {
      const end = raw.indexOf('"', i + 1);
      const stop = end < 0 ? raw.length : end + 1;
      out += raw.slice(i, stop);
      i = stop;
      continue;
    }
    const atWordStart = i === 0 || !isIdentPart(raw[i - 1]!);
    if (atWordStart && raw.startsWith(NAME, i)) {
      let j = i + NAME.length;
      while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t' || raw[j] === FULLWIDTH_SPACE)) j++;
      if (raw[j] === '(') {
        const close = matchCloseParen(raw, j);
        if (close < 0) {
          // 括号未闭合：不猜，只把名字原样透传（后续各步照常报可达诊断）
          out += NAME;
          i += NAME.length;
          continue;
        }
        const args = splitTopLevelArgs(raw.slice(j + 1, close));
        if (args.length === 0) {
          ctx.report({
            code: 'block-empty',
            severity: 'error',
            message:
              '`初回(...)` 缺 key——引擎 `ONCE(名称, …)` 的第一个实参是变量名（字符串字面量或表达式），不能为空。',
            loc: ctx.loc,
          });
          out += 'ONCE()';
          i = close + 1;
          continue;
        }
        if (args.length === 2 && ctx.charNo !== undefined && ctx.charNo.length > 0) {
          args.push(ctx.charNo);
        }
        out += 'ONCE(' + args.join(',') + ')';
        i = close + 1;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** 找 `open` 处 `(` 的配对 `)`（尊重字符串字面量）；找不到返回 -1 */
function matchCloseParen(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** 按**顶层**逗号（含全角 `，`）拆实参并 trim；空串 → `[]` */
function splitTopLevelArgs(inner: string): string[] {
  if (inner.trim().length === 0) return [];
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i]!;
    if (ch === '"') {
      const end = inner.indexOf('"', i + 1);
      const stop = end < 0 ? inner.length : end + 1;
      buf += inner.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if ((ch === ',' || ch === '，') && depth === 0) {
      out.push(buf.trim());
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  out.push(buf.trim());
  return out;
}

/** 只在非字符串段上应用变换 */
function replaceInCodeOutsideStrings(expr: string, fn: (code: string) => string): string {
  return splitStringLiterals(expr)
    .map((part) => (part.isString ? part.text : fn(part.text)))
    .join('');
}

/** 中文运算符 → ERB（长词优先） */
function lowerOperators(code: string): string {
  let out = code;
  for (const [cn, erb] of operatorTable()) {
    out = replaceToken(out, cn, erb);
  }
  return out;
}

/**
 * 词边界替换（不进入标识符内部）。
 * `非` 是单字且可能出现在标识符里（如变量名含"非"），故必须做边界判定：
 * 前一个字符不是标识符字符、后一个字符不是标识符字符。
 */
function replaceToken(code: string, word: string, replacement: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    if (code.startsWith(word, i)) {
      const before = i > 0 ? code[i - 1]! : '';
      const after = i + word.length < code.length ? code[i + word.length]! : '';
      const isCjkWord = /[\u4e00-\u9fff]/.test(word);
      const boundaryBefore = !isIdentPart(before);
      const boundaryAfter = !isIdentPart(after);
      if (boundaryBefore && boundaryAfter) {
        out += replacement;
        i += word.length;
        continue;
      }
    }
    out += code[i]!;
    i++;
  }
  return out;
}

/**
 * `X 不在 a 到 b` → `!(X >= a && X <= b)`（规范 §3.5）。
 *
 * 规范明确：**不要**转成 `X < a || X > b`（`&&`/`||` 不短路，二者求值次数
 * 相同；取舍理由是语义直接映射）。`X` 含 `+`/`-`/函数调用时转译器**不做**
 * 自动转写（避免擅自引入临时变量），就地报 `notin-complex-operand`（warning）。
 */
function lowerNotIn(expr: string, ctx: ExprContext): string {
  const ops = topLevelBoolOps(expr);
  let out = '';
  let consumed = 0;
  let scanFrom = 0;
  let lowered = false;
  let broken = false;
  for (;;) {
    let hit: { idx: number; kw: string } | null = null;
    for (const kw of NOTIN_KEYWORDS) {
      const rel = findTokenOutsideStrings(expr.slice(scanFrom), kw);
      if (rel < 0) continue;
      const abs = scanFrom + rel;
      if (hit === null || abs < hit.idx) hit = { idx: abs, kw };
    }
    if (hit === null) break;
    const { idx, kw } = hit;
    // 本命中所属的布尔操作数：lhs 截到上一个顶层 &&/|| 之右
    const prevOp = [...ops].reverse().find((o) => o.idx + o.text.length <= idx);
    const start = prevOp ? prevOp.idx + prevOp.text.length : 0;
    const segFrom = idx + kw.length;
    const toA = findTokenOutsideStrings(expr.slice(segFrom), '到');
    const toB = findTokenOutsideStrings(expr.slice(segFrom), 'to');
    const toRel = toA < 0 ? toB : toB < 0 ? toA : Math.min(toA, toB);
    const toAbs = toRel < 0 ? -1 : segFrom + toRel;
    const toLen = toAbs >= 0 && expr.startsWith('到', toAbs) ? 1 : 2;
    // hi 截到下一个顶层 &&/|| 之左（原文运算符接回后缀）
    const nextOp = toAbs >= 0 ? ops.find((o) => o.idx > toAbs) : undefined;
    const end = nextOp ? nextOp.idx : expr.length;
    const lhs = toAbs >= 0 ? expr.slice(start, idx).trim() : '';
    const lo = toAbs >= 0 ? expr.slice(segFrom, toAbs).trim() : '';
    const hi = toAbs >= 0 ? expr.slice(toAbs + toLen, end).trim() : '';
    if (
      toAbs < 0 ||
      lhs.length === 0 ||
      lo.length === 0 ||
      hi.length === 0 ||
      NOTIN_KEYWORDS.some((k) => findTokenOutsideStrings(lo, k) >= 0 || findTokenOutsideStrings(hi, k) >= 0)
    ) {
      broken = true; // 形态不完整 / 边界内嵌套「不在」：整条保守放弃，不产出半吊子 ERB
      break;
    }
    if (/[()+-]/.test(lhs)) {
      ctx.report({
        code: 'notin-complex-operand',
        severity: 'warning',
        message: '「不在」左边是计算或函数调用，转译后会算两次（含 `随机(...)` 时会掷两次）。建议先赋给一个变量，再用「不在」。',
        loc: ctx.loc,
      });
    }
    // 接缝空白保原文（trim 的代价不能转嫁给拼接缝）：lhs 段的首空白接在上一运算符
    // 之后、hi 段的尾空白接在下一运算符之前——丢了就烧成 `99)&&` / `&&!(`
    //（2026-10-16 修复批自己的回归用例抓到的形状）。
    const leadWs = /^\s*/.exec(expr.slice(start, idx))![0]!;
    const tailWs = /\s*$/.exec(expr.slice(toAbs + toLen, end))![0]!;
    out += expr.slice(consumed, start) + leadWs + `!(${lhs} >= ${lo} && ${lhs} <= ${hi})` + tailWs;
    consumed = end;
    scanFrom = end;
    lowered = true;
  }
  if (broken) {
    // `不在` 出现但形态不完整 → 不静默（保持原样会产出非法 ERB）
    ctx.report({
      code: 'unknown-identifier',
      severity: 'error',
      message: '`不在` 需要写成「X 不在 a 到 b」，无法解析为范围取反。',
      loc: ctx.loc,
    });
    return expr;
  }
  if (!lowered) return expr;
  return out + expr.slice(consumed);
}

/** 找词（词边界；返回首个下标，-1 = 未找到） */
function findToken(code: string, word: string): number {
  let i = 0;
  while (i < code.length) {
    if (code.startsWith(word, i)) {
      const before = i > 0 ? code[i - 1]! : '';
      const after = i + word.length < code.length ? code[i + word.length]! : '';
      if (!isIdentPart(before) && !isIdentPart(after)) return i;
    }
    i++;
  }
  return -1;
}

/** 找词（词边界；**跳过字符串字面量段**——台词里的「不在」不是运算符；-1 = 未找到） */
function findTokenOutsideStrings(code: string, word: string): number {
  let offset = 0;
  for (const part of splitStringLiterals(code)) {
    if (!part.isString) {
      const hit = findToken(part.text, word);
      if (hit >= 0) return offset + hit;
    }
    offset += part.text.length;
  }
  return -1;
}

/** 顶层布尔运算符（&& / ||；字符串外、括号深度 0；按出现序）——「不在」的边界尺 */
function topLevelBoolOps(code: string): { idx: number; text: string }[] {
  const out: { idx: number; text: string }[] = [];
  let offset = 0;
  for (const part of splitStringLiterals(code)) {
    if (!part.isString) {
      let depth = 0;
      let i = 0;
      while (i < part.text.length) {
        const ch = part.text[i]!;
        if (ch === '(') {
          depth++;
        } else if (ch === ')') {
          if (depth > 0) depth--;
        } else if (depth === 0 && (ch === '&' || ch === '|')) {
          const two = part.text.slice(i, i + 2);
          if (two === '&&' || two === '||') {
            out.push({ idx: offset + i, text: two });
            i += 2;
            continue;
          }
        }
        i++;
      }
    }
    offset += part.text.length;
  }
  return out;
}

/**
 * 代词与属性降糖。
 *
 * - `她` / `你`（**独立词**，不黏在标识符里）→ `%CALLNAME:TARGET%` / `%CALLNAME:MASTER%`；
 * - `她的X` / `你的X` → 查字典得变量族 → `{CFLAG:TARGET:X}` 形态的**表达式原文**
 *   （注意：表达式位置用 `{}` 还是 `%%` 由**插值上下文**决定，本函数返回
 *   统一的内部形态 `FAMILY:TARGET:NAME`，由插值层包装）。
 *
 * 裸标识符（既非别名、也非字典命中）→ 报 `unknown-identifier`（规范 §5.2）。
 */
function lowerPronounsAndAttributes(code: string, ctx: ExprContext): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    // 角色引用属性优先（`角色12的好感度`；规范 §3.8 的"引用其它角色"，批 L 落地）
    const role = matchRoleAttribute(code, i);
    if (role) {
      const nameEnd = scanIdentifier(code, role.nameStart);
      const name = nameEnd > 0 ? code.slice(role.nameStart, nameEnd) : '';
      if (name.length > 0) {
        out += resolveAttribute(role.no, name, ctx);
        i = nameEnd;
        continue;
      }
      // `角色12的` 后面没有标识符 → 原样两个字符继续走常规分支（不猜）
    }

    // 属性访问优先（`她的X` 比 `她` 长）
    const attrPrefix = matchAttributePrefix(code, i);
    if (attrPrefix) {
      const nameEnd = scanIdentifier(code, i + 2);
      const name = nameEnd > i + 2 ? code.slice(i + 2, nameEnd) : '';
      if (name.length > 0) {
        const resolved = resolveAttribute(attrPrefix.scope, name, ctx);
        out += resolved;
        i = nameEnd;
        continue;
      }
    }

    // 代词（独立词）
    const pronoun = matchPronoun(code, i);
    if (pronoun) {
      out += PRONOUN_MAP.get(pronoun)!;
      i += pronoun.length;
      continue;
    }

    // `实参` / `实参$`（规范 §3.2，v1.7）：不定形参的**具名视图**。
    // `实参:n → ARG:<n-1>`、`实参$:n → ARGS:<n-1>`（n = **全局 1 基**实参位置）；
    // 裸 `实参` ≡ `实参:1`、裸 `实参$` ≡ `实参$:1`。整词匹配（`实参表` 不误伤）。
    // 引用**未声明**位置（n-1 ≥ argSlotCount）→ error（fail-visible；引擎静默丢实参，绝不读空值）。
    const argEnd = scanIdentifier(code, i);
    if (argEnd > 0) {
      const argIdent = code.slice(i, argEnd);
      if (argIdent === VARIADIC_ARG_NUMERIC || argIdent === VARIADIC_ARG_STRING) {
        const stringView = argIdent === VARIADIC_ARG_STRING;
        let j = argEnd;
        let seg = '';
        let hadColon = false;
        if (j < code.length && code[j] === ':') {
          hadColon = true;
          const segEnd = scanIndexSegment(code, j + 1);
          if (segEnd > 0) {
            seg = code.slice(j + 1, segEnd);
            j = segEnd;
          }
        }
        const malformed = hadColon && !/^\d+$/.test(seg);
        const n = malformed ? 1 : Number(seg === '' ? 1 : seg);
        const slots = ctx.argSlotCount ?? 0;
        if (malformed || n < 1 || n - 1 >= slots) {
          const tokenText = code.slice(i, j);
          ctx.report({
            code: 'unknown-identifier',
            severity: 'error',
            message: malformed
              ? `「${tokenText}」——\`${argIdent}\` 后的索引只能是**正整数**（从 1 起的全局实参位置），如 \`${argIdent}:1\`、\`${argIdent}:3\`。`
              : `「${tokenText}」引用的是实参表第 ${n} 个位置，但当前作用域只声明了 ${slots} 个实参槽位（时机用「参数:」、函数用形参表声明）——引擎对**未声明**槽位的实参是静默丢弃（读到 0），故这里拒绝生成、不写空值。请补声明或改用已声明的名字。`,
            loc: ctx.loc,
          });
          out += tokenText;
          i = j;
          continue;
        }
        out += argPositionToken(stringView, n - 1);
        i = j;
        continue;
      }
    }

    // 标识符（可能是原生 ERB 变量引用 / 函数名 / 关键字）
    const end = scanIdentifier(code, i);
    if (end > 0) {
      const ident = code.slice(i, end);
      // 原生 ERB 变量引用（含 `:` 索引）——原样保留，不报错
      let j = end;
      while (j < code.length && code[j] === ':') {
        const segEnd = scanIndexSegment(code, j + 1);
        if (segEnd < 0) break;
        j = segEnd;
      }
      if (j > end) {
        const ref = code.slice(i, j);
        // 原生 ERB 变量引用（含 `:` 索引）——**原样保留**，但 P-10③ 起不再"零诊断"：
        // 族表在位而名称段查无 ⇒ 报 warning（产物不变，见 `reportUnlistedFamilyName`）。
        // ALS-R2：扫描器在 `:` 后遇到非标识符/非数字（语料实有 `SOURCE:LOCAL:(LOCAL:1)`
        // 的 `(`）时，会把**三段作用域写法截成两段**，`unlistedFamilyName` 自己那条
        // "三段及以上一律放行"就被截词绕过（实测 `SOURCE:LOCAL` 因此在画蛇添足版 /
        // 魔王改版各多判 6 处假阳性）。截断处仍是 `:` ⇒ 整条不核：**只减假阳性，
        // 不减抓错能力**（真二段形 `NOWEX:噴乳乳瞎写` 后面不接 `:`，照判）。
        const truncatedAtColon = j < code.length && code[j] === ':';
        if (!truncatedAtColon) reportUnlistedFamilyName(ref, ctx);
        out += ref;
        i = j;
        continue;
      }
      // ERB 运算符关键字——原样保留
      if (isErbKeyword(ident)) {
        out += ident;
        i = end;
        continue;
      }
      // 位名表层语法（v1.8）：`GETBIT(<变量引用>, <位名>)` 的**第二实参**写成裸中文位名时，
      // 先按「该变量自身位表」解析（`resolveBitSlotName`，与语句形**共用同一枚**）。
      // 解析在则**消费整个调用**（第二实参换成引擎位号 / 报歧义或查无 error）；不解析
      // （非裸名 / 作者别名 / 字典缺省）则落回下方原样放行——产物与改前逐字节相同。
      if (code[end] === '(' && ident === 'GETBIT' && ctx.dictionary?.bitIndexOf !== undefined) {
        const close = matchCloseParen(code, end);
        if (close > 0) {
          const args = splitTopLevelArgs(code.slice(end + 1, close));
          if (args.length === 2) {
            // 静默探测第一实参（不产任何诊断），只为拿「族头:…:索引」形态的变量引用
            const probe: ExprContext = { ...ctx, report: () => {} };
            const varRef = lowerExpressionCore(args[0]!, probe);
            const resolved = resolveBitSlotName(varRef, args[1]!, ctx);
            if (resolved !== null) {
              out += `${ident}(${lowerExpressionCore(args[0]!, ctx)}, ${resolved})`;
              i = close + 1;
              continue;
            }
          }
        }
      }
      // 函数调用形态（后随 `(`）——名字**原样保留**，但两表皆不认的**中文函数名**分级诊断
      // （ZH-D1，判据与语料读数见 `system-functions.ts::suggestFunctionName`）：
      // · 表内有唯一高置信近名 ⇒ `function-name-typo` **error**：作者照文案改一个词就能过，
      //   且 error 存在即拒绝产字节 / 拒绝写盘（`compileToBytes` / `planSave` 的 fail-closed
      //   闸），半成品进不了游戏；
      // · 无近名 / 近名歧义 ⇒ `function-name-unknown` **warning**（fail-visible，不猜、不纠，
      //   产物逐字节照原样）——真语料里表外中文名绝大多数是基础库/自定义 `@函数` 的合法写法，
      //   一刀切升 error 会让 158 个文件红到编译不动（读数见 `suggestFunctionName` 头注）。
      // 系统表命中的名字已在 step 0 降为原生名，不会走到这里。
      if (code[end] === '(') {
        if (CJK.test(ident) && !isKnownFunctionName(ident, ctx.libraryTable)) {
          const near = suggestFunctionName(ident, ctx.libraryTable);
          if (near) {
            ctx.report({
              code: 'function-name-typo',
              severity: 'error',
              message: `「${ident}(…)」既不在系统函数表、也不在当前工程的基础库函数表里，而两张表里只有一个相近名「${near.name}」（原生名 ${near.engineName}）——这多半是把「${near.name}」拼错了。该行已原样进产物、且本文件已被拒绝编译（不写盘、不导字节）：请改成「${near.name}(…)」；若这确实是本项目的自定义函数，请直接用它的原生函数名书写。`,
              loc: ctx.loc,
            });
          } else {
            ctx.report({
              code: 'function-name-unknown',
              severity: 'warning',
              message: `「${ident}」是中文函数名调用形态，但既不在系统函数表、也不在当前工程的基础库函数表里——该调用已原样写进产物（引擎多半取不到此函数）。若确认是自定义函数，请改为原生函数名，或确认该名已收录。`,
              loc: ctx.loc,
            });
          }
        }
        out += ident;
        i = end;
        continue;
      }
      // 裸标识符：字典能解析 → 展开；否则报错（不静默）
      const resolved = resolveBareIdentifier(ident, ctx);
      out += resolved;
      i = end;
      continue;
    }

    out += code[i]!;
    i++;
  }
  return out;
}

/**
 * 匹配角色引用属性 `角色<数字>的`（规范 §3.8"引用其它角色"）。
 *
 * 判据：`角色` 前不粘标识符；`角色` 后**必须是纯数字**（变量号写法如 `角色X的` 一律不认——
 * 那是动态作用域，糖里不承诺）；数字后必须是 `的`。返回属性名的起始下标。
 */
function matchRoleAttribute(code: string, i: number): { no: string; nameStart: number } | null {
  if (!code.startsWith('角色', i)) return null;
  if (i > 0 && isIdentPart(code[i - 1]!)) return null;
  let j = i + 2;
  while (j < code.length && /[0-9]/.test(code[j]!)) j++;
  if (j === i + 2 || code[j] !== '的') return null;
  return { no: code.slice(i + 2, j), nameStart: j + 1 };
}

/** 匹配属性前缀（`她的` / `你的`；返回 scope 与长度） */
function matchAttributePrefix(code: string, i: number): { scope: string } | null {  for (const [prefix, scope] of ATTRIBUTE_PREFIX) {
    if (code.startsWith(prefix, i)) {
      // 前缀之后必须是标识符起始（避免 `她的` 后接运算符被误判）
      const next = code[i + prefix.length];
      if (next !== undefined && isIdentStart(next)) return { scope };
    }
  }
  return null;
}

/** 匹配代词（`她` / `你`；独立词——前后都不是标识符字符） */
function matchPronoun(code: string, i: number): string | null {
  for (const pronoun of PRONOUN_MAP.keys()) {
    if (!code.startsWith(pronoun, i)) continue;
    const before = i > 0 ? code[i - 1]! : '';
    const after = i + pronoun.length < code.length ? code[i + pronoun.length]! : '';
    // `她的X` 由属性分支处理，这里排除后随标识符的情形
    if (!isIdentPart(before) && !isIdentPart(after)) return pronoun;
  }
  return null;
}

/** 扫描 `:index` 段（返回结束下标；`-1` = 非法） */
function scanIndexSegment(code: string, from: number): number {
  if (from >= code.length) return -1;
  const end = scanIdentifier(code, from);
  if (end > 0) return end;
  // 纯数字索引（如 `:1088`）——`scanIdentifier` 不允许数字起始
  let i = from;
  while (i < code.length && /[0-9]/.test(code[i]!)) i++;
  return i > from ? i : -1;
}

/** ERB 关键字/运算符标记（这些不是变量名，原样保留） */
function isErbKeyword(ident: string): boolean {
  return (
    ident === 'true' ||
    ident === 'false' ||
    ident === 'null' ||
    ident === 'AND' ||
    ident === 'OR' ||
    ident === 'XOR' ||
    ident === 'TO'
  );
}

/**
 * `她的X` → 变量族查询结果（内部统一形态 `FAMILY:TARGET:X`）。
 *
 * 例：`她的恋慕` → 字典查 `TALENT` 族含 `恋慕` → `TALENT:TARGET:恋慕`。
 * 字典缺失 / 查不到 → 报 `unknown-identifier`，并**保留原样**（不至于产出
 * 语法崩溃的 ERB，但诊断明确）。
 */
function resolveAttribute(scope: string, name: string, ctx: ExprContext): string {
  // `名字` 特例：`CALLNAME` **以角色号为索引**，不存在"名字的索引"。
  // 走通用查表会得到 `CALLNAME:TARGET:名字`（引擎里是 1D 数组的越界写法）。
  if (name === '名字') return `CALLNAME:${scope}`;
  const family = ctx.dictionary?.resolveFamily(name);
  if (!family) {
    ctx.report({
      code: 'unknown-identifier',
      severity: 'error',
      message: `无法解析「${name}」所属的变量族（变量字典未收录或未加载）。`,
      loc: ctx.loc,
    });
    return `${scope}:${name}`;
  }
  return `${family}:${scope}:${name}`;
}

/** 裸标识符解析：引擎全局 → 原样；字典命中 → 展开为 `FAMILY:index`；否则报错 */
function resolveBareIdentifier(ident: string, ctx: ExprContext): string {
  // 保留代词已在上游处理；此处仅防御
  if (RESERVED_PRONOUNS.includes(ident)) {
    return PRONOUN_MAP.get(ident) ?? ident;
  }
  // **裸引擎全局**（`SELECTCOM` / `PREVCOM` / `ARG` / `TARGET` …无族头的引擎自带标量）
  // → 原样输出。先于字典：字典是**可选注入**的（无工程 / 无 adapter 时 `dictionary`
  // 为 undefined），而这些名字属 ERB 语言层、不属任何游戏的变量表（判据与实测计数
  // 见 `engine-globals.ts`）。
  const engineGlobal = resolveEngineGlobal(ident);
  if (engineGlobal) return engineGlobal;
  const resolved = ctx.dictionary?.resolve(ident);
  if (!resolved) {
    ctx.report({
      code: 'unknown-identifier',
      severity: 'error',
      message: `未定义的标识符「${ident}」——若它是自定义变量名或角色引用，请先在文件头用「别名」声明。`,
      loc: ctx.loc,
    });
    return ident;
  }
  return resolved;
}

/**
 * **位槽**里的裸中文位名 → 引擎位号（v1.8 位名表层语法）——表达式形与语句形**共用**（单一真源）。
 *
 * `variableRef` = 位槽第一实参经既有 `resolveFamily` / `resolve` 链路解析出的**变量引用**
 * （`CFLAG:TARGET:1` / `TFLAG:193`：语句形由 `expandTarget` 给出、表达式形由 `lowerExpressionCore`
 * 给出）；`slotRaw` = 作者在位槽位置写的原文。
 *
 * 判据（**优先级不静默**；与 `DictionaryLookup.bitIndexOf` 头注一致）：
 * ① 作者**别名**优先（同名别名存在 ⇒ 本函数不管）；② 再试**位名**（只在该变量**自身**位表内按
 * `label` 整词精确匹配）；③ 位名命中而该名**同时**又是可解析的变量 / 引擎全局 ⇒ **报歧义 error**
 * （绝不静默取其一）；④ 都不中 ⇒ 原样交回既有链路（`unknown-identifier`）。
 *
 * 返回值：
 * - `null` = **本函数不管**（位槽非单一裸标识符 / 该名是作者别名 / 字典不支持本能力 / 该名是可
 *   解析的变量），调用方照常走 `lowerExpression`（行为与改前逐字相同）；
 * - **非 null 字符串** = 本函数已接管该位槽：`bit` 命中 → 该位号的**十进制文本**；`bit` 未命中
 *   但第一实参确是引擎变量引用（或命中却有歧义）→ **原样**位名 + 报 error（fail-visible，
 *   **不猜、不产半成品**，且不与 `unknown-identifier` 双报）。
 */
export function resolveBitSlotName(
  variableRef: string | undefined,
  slotRaw: string,
  ctx: ExprContext,
): string | null {
  const name = slotRaw.trim();
  if (name.length === 0) return null;
  // 位名必须是**单一裸标识符**（无 `:` 索引、无运算符、无括号）——否则是普通表达式，交回下游
  const end = scanIdentifier(name, 0);
  if (end !== name.length) return null;
  // ① 作者别名优先：同名别名存在 ⇒ 不管（交给别名替换 / `lowerExpression` 展开）
  if (ctx.aliases.has(name)) return null;
  // 缺省（字典不支持 / 未打开工程）⇒ 不做（行为与今天逐字相同）
  const bitIndexOf = ctx.dictionary?.bitIndexOf;
  if (!bitIndexOf) return null;
  const bit = bitIndexOf(variableRef ?? '', name);
  // ③ 该名同时又是可解析的变量 / 引擎全局
  const alsoVariable =
    resolveEngineGlobal(name) !== undefined || ctx.dictionary?.resolve(name) !== undefined;
  if (bit !== undefined) {
    if (alsoVariable) {
      ctx.report({
        code: 'bit-name-unknown',
        severity: 'error',
        message: `位槽里的「${name}」既是变量引用「${variableRef ?? ''}」位表里的位名、又是可解析的变量 / 引擎全局——位名解析有歧义，拒绝猜测。请改用数字位号，或把该变量名别名化以消歧。`,
        loc: ctx.loc,
      });
      return name;
    }
    return String(bit);
  }
  // ② 位名未命中，但该名是可解析的变量 ⇒ 交回既有链路（按变量解析）
  if (alsoVariable) return null;
  // 第一实参确是引擎变量引用（有族头）⇒ 报「该变量位表里查无此位名」；否则交回 `unknown-identifier`
  if (variableRef !== undefined && ctx.dictionary?.resolve(variableRef) !== undefined) {
    ctx.report({
      code: 'bit-name-unknown',
      severity: 'error',
      message: `位槽写了位名「${name}」，但变量引用「${variableRef}」的位表里查无此名（或该变量没有位表数据）——拒绝猜测。请改用数字位号，或确认该位名已收录。`,
      loc: ctx.loc,
    });
    return name;
  }
  return null;
}

/**
 * `族头:具名索引` 的名称段核对（P-10③「族头直通改条件校验」；**warning 起步**）。
 *
 * 为什么报在这里而不是 `dictionary.resolve`：`resolve` 的返回只有"原文 / undefined"
 * 两态，undefined 会被 `resolveBareIdentifier` 报成 `unknown-identifier`（**error**）——
 * 而那正是本批要避免的误伤（真语料里 `NOWEX:i`、`NOWEX:COUNT` 这类动态索引形态合法）。
 * 本点又与 `engine-globals.ts` 同源，故"族引用放行"只此一处，判据零分裂。
 *
 * 三条放行口径（与 `types.ts` 的 `unlistedFamilyName` 一致）：
 * 1. 字典未注入 / 不提供核对（旧字典形态）⇒ 与今天逐字相同的静默放行；
 * 2. 该族无名称表 / 名称段是纯数字 / 三段及以上作用域写法 ⇒ 无判据，放行
 *    （**含被扫描器在 `:` 处截断的三段形**，ALS-R2：截断处仍是 `:` 就不调用本核对）；
 * 3. 名称段本身是**裸引擎全局**（`NOWEX:COUNT`：循环/计数写法）⇒ 放行，不报。
 */
function reportUnlistedFamilyName(ref: string, ctx: ExprContext): void {
  const check = ctx.dictionary?.unlistedFamilyName;
  if (!check) return;
  const off = check(ref);
  if (!off) return;
  if (resolveEngineGlobal(off.name)) return; // 动态索引（引擎固定词），不是拼错的具名
  ctx.report({
    code: 'family-name-unknown',
    severity: 'warning',
    message: `变量族「${off.family}」的名称表里查不到具名索引「${off.name}」——该行仍原样写进产物，但引擎多半取不到值（拼错请改正；该名字若来自游戏侧的追加名表，可忽略本提示）。`,
    loc: ctx.loc,
  });
}

/* ============================== 赋值左值展开（§5.0 / §3.1） ============================== */

/**
 * 展开赋值**左值**（规范 §5.0 第 1-a 步 + §3.1 只读约束）。
 *
 * - 变量别名 → 目标变量引用（可读写）；
 * - 只读别名（角色 / 字面量）→ 报 `readonly-alias-assignment`**并拒绝**
 *   （返回 `null` 让调用方中止该节点，绝不产出 `0 = 1` 这类无意义产物）；
 * - 非别名 → 按普通变量引用降糖（属性 / 代词不合法于左值，但保持宽容）。
 */
export function expandTarget(raw: string, ctx: ExprContext): string | null {
  const ident = raw.trim();
  const alias = ctx.aliases.get(ident);
  if (alias) {
    if (alias.readonly) {
      ctx.report({
        code: 'readonly-alias-assignment',
        severity: 'error',
        message: `「${ident}」是只读别名（${readonlyAliasKindLabel(alias.value.kind)}），不能作为赋值目标。`,
        loc: ctx.loc,
      });
      return null;
    }
    return aliasValueToExpression(alias.value);
  }
  // `实参` / `实参$`（及其 `:n` 形）是**只读实参视图**，不能作为赋值目标（v1.7：
  // 关键字后接 `=` 即拒绝——避免把「实参」当成一个可写变量名静默吞掉）。
  if (/^实参(\$)?(:\d+)?$/.test(ident)) {
    ctx.report({
      code: 'unknown-identifier',
      severity: 'error',
      message: `「${ident}」是实参视图（\`实参:n\` / \`实参$:n\`），不能作为赋值目标；要写引擎槽位请直接用原生 \`ARG\` / \`ARGS\`。`,
      loc: ctx.loc,
    });
    return null;
  }
  // 普通左值：只做运算符/代词降糖（左值一般是变量引用）
  return lowerExpression(ident, ctx);
}

/** 只读别名的类别标签（诊断文案用；与 `isReadonlyAlias` 的 kind 集合对齐） */
function readonlyAliasKindLabel(kind: AliasValue['kind']): string {
  switch (kind) {
    case 'character':
      return '角色引用';
    case 'conditional':
      return '条件表达式';
    default:
      return '字面量';
  }
}
