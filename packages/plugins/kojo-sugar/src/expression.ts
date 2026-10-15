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
import { isKnownFunctionName, lowerSystemFunctions } from './system-functions';
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
   * 缺省 = 该适配器未声明 → 未收录的中文调用形态**原样保留**并报
   * `function-name-unknown`（**warning**，fail-visible）。
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

  // ---- 1. 中文运算符（在字符串字面量外） ----
  let expr = replaceInCodeOutsideStrings(familyAliased, (code) => lowerOperators(code));

  // ---- 2. `不在`（范围取反；结构级，需整段扫描） ----
  expr = lowerNotIn(expr, ctx);

  // ---- 3. 代词与属性（在字符串字面量外） ----
  expr = replaceInCodeOutsideStrings(expr, (code) => lowerPronounsAndAttributes(code, ctx));

  // ---- 4. 条件别名回填（行内条件 `\@条件?真#假\@`；用函数式替换避免 `$` 被当替换模式） ----
  if (deferred.length === 0) return expr;
  return expr.replace(COND_SLOT_RE, (_whole, digits: string) => deferred[Number(digits)] ?? '');
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
function replaceToken(code: string, token: string, replacement: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    if (code.startsWith(token, i)) {
      const before = i > 0 ? code[i - 1]! : '';
      const after = i + token.length < code.length ? code[i + token.length]! : '';
      const isCjkToken = /[\u4e00-\u9fff]/.test(token);
      const boundaryBefore = isCjkToken ? !isIdentPart(before) : !isIdentPart(before);
      const boundaryAfter = isCjkToken ? !isIdentPart(after) : !isIdentPart(after);
      if (boundaryBefore && boundaryAfter) {
        out += replacement;
        i += token.length;
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
  for (const kw of NOTIN_KEYWORDS) {
    const idx = findToken(expr, kw);
    if (idx < 0) continue;
    const lhs = expr.slice(0, idx).trim();
    const rest = expr.slice(idx + kw.length).trim();
    const toIdx = findToken(rest, '到') >= 0 ? findToken(rest, '到') : findToken(rest, 'to');
    if (toIdx < 0) continue;
    const lo = rest.slice(0, toIdx).trim();
    const hi = rest.slice(toIdx + (rest.startsWith('到', toIdx) ? 1 : 2)).trim();
    if (lhs.length === 0 || lo.length === 0 || hi.length === 0) continue;
    if (/[()+-]/.test(lhs)) {
      ctx.report({
        code: 'notin-complex-operand',
        severity: 'warning',
        message: '「不在」左边是计算或函数调用，转译后会算两次（含 `随机(...)` 时会掷两次）。建议先赋给一个变量，再用「不在」。',
        loc: ctx.loc,
      });
    }
    return `!(${lhs} >= ${lo} && ${lhs} <= ${hi})`;
  }
  // `不在` 出现但形态不完整 → 不静默（保持原样会产出非法 ERB）
  if (NOTIN_KEYWORDS.some((kw) => expr.includes(kw))) {
    ctx.report({
      code: 'unknown-identifier',
      severity: 'error',
      message: '`不在` 需要写成「X 不在 a 到 b」，无法解析为范围取反。',
      loc: ctx.loc,
    });
  }
  return expr;
}

/** 找 token（词边界；返回首个下标，-1 = 未找到） */
function findToken(code: string, token: string): number {
  let i = 0;
  while (i < code.length) {
    if (code.startsWith(token, i)) {
      const before = i > 0 ? code[i - 1]! : '';
      const after = i + token.length < code.length ? code[i + token.length]! : '';
      if (!isIdentPart(before) && !isIdentPart(after)) return i;
    }
    i++;
  }
  return -1;
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
      // 函数调用形态（后随 `(`）——原样保留；但**中文函数名**若系统表与 adapter 表
      // 都不认，则报 `function-name-unknown`（**warning**，fail-visible，不猜、不纠，
      // 产物逐字节照原样）。系统表命中的名字已在 step 0 降为原生名，不会走到这里。
      if (code[end] === '(') {
        if (CJK.test(ident) && !isKnownFunctionName(ident, ctx.libraryTable)) {
          ctx.report({
            code: 'function-name-unknown',
            severity: 'warning',
            message: `「${ident}」是中文函数名调用形态，但既不在系统函数表、也不在当前工程的基础库函数表里——该调用已原样写进产物（引擎多半取不到此函数）。若确认是自定义函数，请改为原生函数名，或确认该名已收录。`,
            loc: ctx.loc,
          });
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
