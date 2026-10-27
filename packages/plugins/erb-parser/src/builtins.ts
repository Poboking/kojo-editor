import type { LineDecoration } from '@kojo/plugin-api';
import { isErbDialectPath } from '@kojo/plugin-api';
import { erbCallSitesOf, type ArgSpan } from './arity';
import { normalizedUpper, visibleCodeLines, type VisibleCodeLine } from './references';

/**
 * ERB **内建式中函数**（Emuera `exmeth`）静态签名表 + 实参诊断。
 *
 * ## 数据来源与口径
 *
 * - 真源：Era Wiki `Emuera/exmeth`（https://wiki.eragames.rip/index.php/Emuera/exmeth，
 *   2026-10-25 取）；该页列 **177 条目**，合并同名重载（`GETCHARA` 两形、
 *   `GDRAWG`/`GDRAWSPRITE`/`SPRITECREATE` 多形等）后 = **154 个不同名**；另有 16 个
 *   eraTW/东方系分支扩展名**只收名字不判签名**（见 RAW 表末节），合计 **170 名**。
 * - `MOUSESKIP` 不收：wiki 里它以 `(int MOUSESKIP)` 带括号列出（非可调用函数），
 *   同名变量语义与本表无关。
 * - `INRANGEARRAY` / `INRANGECARRAY` 在 wiki 上**没有签名行** ⇒ 只收名字（补全列得出），
 *   个数/类型一律不判（不猜）。
 * - 本表是**静态数据**：不进索引契约、不进快照（否则 `SNAPSHOT_VERSION` 要无谓抬版），
 *   `ErbIndex` / `ArityCatalog` 一个字未动。
 *
 * ## 判据（可证明边界，错标比不标危险）
 *
 * - **个数**：多给实参 = error（引擎明确报"引数が多すぎる"）；少给 = **静默**
 *   （引擎按 0 / 空串兜底，缺省形参本就是合法省略）；可变实参族（`MAX(n, m…)` 等）
 *   不设上限、不判少给。
 * - **类型**：只判**可证**的实参形态——串字面量 `"…"` / `@"…"` / `%…%`（文字列）、
 *   数值字面量与 `{…}` 数值插值（数式）、已知内建调用的返回值类型。变量、成员访问、
 *   带运算符的复合表达式一律 `unknown` ⇒ 不判。
 * - **影子函数让位**：项目里存在同名用户函数（`@STRLENS`）时整个名字不判
 *   （调用方传 `isUserFunction`；Emuera 侧用户定义优先，猜错边就是满屏假红）。
 * - 未打开项目也判（静态表，不依赖索引）。
 *
 * ## 与用户函数个数诊断的关系
 *
 * 用户函数走 `arity.ts`（目录查询形参表）+ 宿主接线注①（多给降 warning 的抗噪口径）；
 * 内建走本模块独立一路、独立诊断码（`ERB_BUILTIN_ARGS` / `ERB_BUILTIN_ARG_TYPE`），
 * 问题面板可按码过滤。扫描尺子共用 `arity.ts` 的 `erbCallSitesOf`（单一真源）。
 */

/** 形参类型：`i` 数式 / `s` 文字列 / `v` 变量占槽（不判类型）/ `a` 任意 */
export type BuiltinParamType = 'int' | 'str' | 'var' | 'any';

/** 单个形参（`optional` = wiki 签名里带默认值，可省略） */
export interface BuiltinParam {
  readonly type: BuiltinParamType;
  readonly optional: boolean;
}

/** 一个内建函数的签名（`ret` / `params` 为 null = wiki 未载明，只认名字） */
export interface BuiltinSignature {
  readonly ret: 'int' | 'str' | null;
  readonly params: readonly BuiltinParam[] | null;
  /** 尾部可变实参（`MAX(n, m…)`）：不设个数上限 */
  readonly variadic: boolean;
}

/** 实参个数诊断码（问题面板可定位；稳定标识） */
export const BUILTIN_ARGS_CODE = 'ERB_BUILTIN_ARGS';

/** 实参类型诊断码（稳定标识） */
export const BUILTIN_ARG_TYPE_CODE = 'ERB_BUILTIN_ARG_TYPE';

/* ---------------- 静态签名表 ---------------- */

/**
 * 原始签名串记法（一行一个函数）：
 *
 * - 第 2 列返回类型：`i` 数式 / `s` 文字列 / `~` wiki 未载明；
 * - 第 3 列形参串：空格分隔的形参项，每项 = 类型符 + 可选 `?` 后缀（有默认值）；
 *   类型符 `i` 数式 / `s` 文字列 / `v` 变量 / `a` 任意；形参串整体为 `~` = wiki 未载明签名；
 *   形参串以 ` *` 结尾 = 尾部可变实参。
 *
 * 例：`['SUBSTRING', 's', 's i? i?']` = `str SUBSTRING(str s, int start = 0, int length = -1)`；
 * `['MAX', 'i', 'i i *']` = `int MAX(int n, int m...)`。
 *
 * `RAND` 两形皆标可选：wiki 凡例显示 `RAND(100)` 单参合法（min/max 的绑定语义与
 * 常规左序不同），保守起见不判它的少给。
 */
const RAW: readonly (readonly [name: string, ret: 'i' | 's' | '~', params: string])[] = [
  // —— 角色 CSV 查询族（wiki 1.2.1–1.2.35，含同名重载合并）——
  ['GETCHARA', 'i', 'i i?'],
  ['GETSPCHARA', 'i', 'i'],
  ['FINDCHARA', 'i', 'v a i? i?'],
  ['FINDLASTCHARA', 'i', 'v a i? i?'],
  ['CSVNAME', 's', 'i i?'],
  ['CSVCALLNAME', 's', 'i i?'],
  ['CSVNICKNAME', 's', 'i i?'],
  ['CSVMASTERNAME', 's', 'i i?'],
  ['CSVCSTR', 's', 'i i i?'],
  ['CSVBASE', 'i', 'i i i?'],
  ['CSVABL', 'i', 'i i i?'],
  ['CSVTALENT', 'i', 'i i i?'],
  ['CSVMARK', 'i', 'i i i?'],
  ['CSVEXP', 'i', 'i i i?'],
  ['CSVRELATION', 'i', 'i i i?'],
  ['CSVJUEL', 'i', 'i i i?'],
  ['CSVEQUIP', 'i', 'i i i?'],
  ['CSVCFLAG', 'i', 'i i i?'],
  ['EXISTCSV', 'i', 'i i?'],
  // —— 字符串 / 数值 / 时间 / 颜色族（wiki 1.2.36–1.2.133）——
  ['GETNUM', 'i', 'v s'],
  ['STRLENS', 'i', 's'],
  ['STRLENSU', 'i', 's'],
  ['SUBSTRING', 's', 's i? i?'],
  ['SUBSTRINGU', 's', 's i? i?'],
  ['CHARATU', 's', 's i?'],
  ['STRFIND', 'i', 's s i?'],
  ['STRFINDU', 'i', 's s i?'],
  ['STRCOUNT', 'i', 's s'],
  ['UNICODE', 's', 'i'],
  ['ENCODETOUNI', 'i', 's i?'],
  ['REPLACE', 's', 's s s'],
  ['ESCAPE', 's', 's'],
  ['VARSIZE', 'i', 's i?'],
  ['GETTIME', 'i', ''],
  ['GETTIMES', 's', ''],
  ['GETMILLISECOND', 'i', ''],
  ['GETSECOND', 'i', ''],
  ['CHKFONT', 'i', 's'],
  ['POWER', 'i', 'i i'],
  ['RAND', 'i', 'i? i?'],
  ['ABS', 'i', 'i'],
  ['SIGN', 'i', 'i'],
  ['MAX', 'i', 'i i *'],
  ['MIN', 'i', 'i i *'],
  ['LIMIT', 'i', 'i i i'],
  ['INRANGE', 'i', 'i i i'],
  ['SQRT', 'i', 'i'],
  ['GETBIT', 'i', 'i i'],
  ['CBRT', 'i', 'i'],
  ['LOG', 'i', 'i'],
  ['LOG10', 'i', 'i'],
  ['EXPONENT', 'i', 'i'],
  ['GETFONT', 's', ''],
  ['GETCOLOR', 'i', ''],
  ['GETDEFCOLOR', 'i', ''],
  ['GETBGCOLOR', 'i', ''],
  ['GETDEFBGCOLOR', 'i', ''],
  ['GETFOCUSCOLOR', 'i', ''],
  ['GETSTYLE', 'i', ''],
  ['CURRENTALIGN', 's', ''],
  ['CURRENTREDRAW', 'i', ''],
  ['TOSTR', 's', 'i s?'],
  ['GETPALAMLV', 'i', 'i i'],
  ['GETEXPLV', 'i', 'i i'],
  ['TOUPPER', 's', 's'],
  ['TOLOWER', 's', 's'],
  ['TOHALF', 's', 's'],
  ['TOFULL', 's', 's'],
  ['SUMARRAY', 'i', 'v i? i?'],
  ['MATCH', 'i', 'v a i? i?'],
  ['MAXARRAY', 'i', 'v i? i?'],
  ['MINARRAY', 'i', 'v i? i?'],
  ['SUMCARRAY', 'i', 'v i? i?'],
  ['CMATCH', 'i', 'v a i? i?'],
  ['MAXCARRAY', 'i', 'v i? i?'],
  ['MINCARRAY', 'i', 'v i? i?'],
  ['ISNUMERIC', 'i', 's'],
  ['TOINT', 'i', 's'],
  ['CHKDATA', 'i', 'i'],
  ['CHKCHARADATA', 'i', 's'],
  ['FIND_CHARADATA', 'i', 's'],
  ['SAVENOS', 'i', ''],
  ['PRINTCPERLINE', 'i', ''],
  ['LINEISEMPTY', 'i', ''],
  ['GROUPMATCH', 'i', 'a a *'],
  ['NOSAMES', 'i', 'a a *'],
  ['ALLSAMES', 'i', 'a a *'],
  ['ISSKIP', 'i', ''],
  ['MESSKIP', 'i', ''],
  ['CONVERT', 's', 'i *'],
  ['MONEYSTR', 's', 'i s?'],
  ['FINDELEMENT', 'i', 'v a i? i? i?'],
  ['FINDLASTELEMENT', 'i', 'v a i? i? i?'],
  ['BARSTR', 's', 'i i i'],
  ['COLOR_FROMNAME', 'i', 's'],
  ['COLOR_FROMRGB', 'i', 'i i i'],
  ['INRANGEARRAY', '~', '~'],
  ['INRANGECARRAY', '~', '~'],
  ['GETLINESTR', 's', 's'],
  ['PRINTCLENGTH', 'i', ''],
  ['STRFORM', 's', 's'],
  ['GETCONFIG', 's', 's'],
  ['GETCONFIGS', 's', 's'],
  ['HTML_POPPRINTINGSTR', 's', ''],
  ['HTML_GETPRINTEDSTR', 's', 'i'],
  ['HTML_ESCAPE', 's', 's'],
  ['HTML_TOPLAINTEXT', 's', 's'],
  ['SAVETEXT', 'i', 's i i? i?'],
  // wiki 1.2.126 原载 `str LOADTEXT(int fileNo{,…})`，但 era 分支普遍扩展为
  // 「文件号 / 文件名」双形（eraNAS 真语料 7 处调用：3 传 `@"…"` 串、4 传文件号）。
  // 首参按任意处理——双形皆合法，猜一边就是误报；个数仍照常判。
  ['LOADTEXT', 's', 'a i? i?'],
  ['GETKEY', 'i', 'i'],
  ['GETKEYTRIGGERED', 'i', 'i'],
  ['CLIENTWIDTH', 'i', ''],
  ['CLIENTHEIGHT', 'i', ''],
  ['MOUSEX', 'i', ''],
  ['MOUSEY', 'i', ''],
  ['ISACTIVE', 'i', ''],
  // —— 精灵 / 画布族（wiki 1.2.134–1.2.177，含同名重载合并）——
  ['SPRITECREATED', 'i', 's'],
  ['SPRITEWIDTH', 'i', 's'],
  ['SPRITEHEIGHT', 'i', 's'],
  ['SPRITEPOSX', 'i', 's'],
  ['SPRITEPOSY', 'i', 's'],
  ['SPRITESETPOS', 'i', 's i i'],
  ['SPRITEMOVE', 'i', 's i i'],
  ['GCREATE', 'i', 'i i i'],
  ['GCREATEFROMFILE', 'i', 'i s'],
  ['GDISPOSE', 'i', 'i'],
  ['GCLEAR', 'i', 'i i'],
  ['GFILLRECTANGLE', 'i', 'i i i i i'],
  ['GDRAWG', 'i', 'i i i i i i i i i i a?'],
  ['GDRAWGWITHMASK', 'i', 'i i i i i'],
  ['GDRAWSPRITE', 'i', 'i s i? i? i? i? a?'],
  ['GSETCOLOR', 'i', 'i i i i'],
  ['GSETBRUSH', 'i', 'i i'],
  ['GSETFONT', 'i', 'i s i'],
  ['GSETPEN', 'i', 'i i i'],
  ['GCREATED', 'i', 'i'],
  ['GWIDTH', 'i', 'i'],
  ['GHEIGHT', 'i', 'i'],
  ['GGETCOLOR', 'i', 'i i i'],
  ['GSAVE', 'i', 'i i'],
  ['GLOAD', 'i', 'i i'],
  ['SPRITECREATE', 'i', 's i i? i? i? i?'],
  ['SPRITEANIMECREATE', 'i', 's i i'],
  ['SPRITEANIMEADDFRAME', 'i', 's i i i i i i i i'],
  ['SPRITEDISPOSE', 'i', 's'],
  ['SPRITEGETCOLOR', 'i', 's i i'],
  ['CBGSETG', 'i', 'i i i i'],
  ['CBGSETSPRITE', 'i', 's i i i'],
  ['CBGCLEAR', 'i', ''],
  ['CBGCLEARBUTTON', 'i', ''],
  ['CBGREMOVERANGE', 'i', 'i i'],
  ['CBGREMOVEBMAP', 'i', ''],
  ['CBGSETBMAPG', 'i', 'i'],
  ['CBGSETBUTTONSPRITE', 'i', 'i s s i i i s?'],
  // —— 分支扩展名（eraTW 系 / 东方系；exmeth **未载明** ⇒ 只收名字，个数与类型一律不判）——
  // 来源：kojo-sugar 旧别名表（`.kojo` 糖层中文名仍在那边，不动）与 eraNAS 真语料
  // 独立调用用量（2026-10-25 实测，`(?<![A-Z0-9_])NAME(` 口径）：FIRSTTIME 13,914 /
  // CHK_DATENOW 398 / CHK_FOCUS 59 / CHK_HININ_LOVE 16 / CHK_HININ_REASON 9 /
  // CHK_ENTRANCE 6 / CHK_CHILDNAME_DUPLICATION 4 / CHK_HAVE_CHILD 3 / RANDOMIZE 2 /
  // SETBIT 1；余者为 0 用量（他盘在用，一并收留——只进补全，零误报面）。
  ['FIRSTTIME', '~', '~'],
  ['CHK_DATENOW', '~', '~'],
  ['CHK_FOCUS', '~', '~'],
  ['CHK_HININ_LOVE', '~', '~'],
  ['CHK_HININ_REASON', '~', '~'],
  ['CHK_ENTRANCE', '~', '~'],
  ['CHK_CHILDNAME_DUPLICATION', '~', '~'],
  ['CHK_HAVE_CHILD', '~', '~'],
  ['RANDOMIZE', '~', '~'],
  ['SETBIT', '~', '~'],
  ['CLEARBIT', '~', '~'],
  ['INVERTBIT', '~', '~'],
  ['ADD_FORCED_DATE', '~', '~'],
  ['CHK_HININ_LOVE_2', '~', '~'],
  ['CHK_HININ_REASON_2', '~', '~'],
  ['SET_KOJOCOLOR', '~', '~'],
];

function decodeParams(spec: string): readonly BuiltinParam[] | null {
  if (spec === '~') return null;
  const out: BuiltinParam[] = [];
  for (const tok of spec.split(' ')) {
    if (tok.length === 0) continue;
    const optional = tok.endsWith('?');
    const t = optional ? tok.slice(0, -1) : tok;
    const type: BuiltinParamType = t === 'i' ? 'int' : t === 's' ? 'str' : t === 'v' ? 'var' : 'any';
    out.push({ type, optional });
  }
  return out;
}

/** 归一化名 → 签名（`params: null` = wiki 未载明，只认名字） */
export const BUILTIN_SIGNATURES: ReadonlyMap<string, BuiltinSignature> = new Map(
  RAW.map(([name, ret, spec]) => {
    const variadic = spec.endsWith(' *');
    const body = variadic ? spec.slice(0, -2) : spec;
    return [
      name,
      {
        ret: ret === 'i' ? 'int' : ret === 's' ? 'str' : null,
        params: decodeParams(body),
        variadic,
      } satisfies BuiltinSignature,
    ];
  }),
);

/** 全部内建函数名（升序；补全与成员位的唯一候选源） */
export const BUILTIN_FUNCTION_NAMES: readonly string[] = [...BUILTIN_SIGNATURES.keys()].sort();

/** 查签名（大小写不敏感；没有这个名字 ⇒ `null`） */
export function builtinSignatureOf(name: string): BuiltinSignature | null {
  return BUILTIN_SIGNATURES.get(normalizedUpper(name)) ?? null;
}

const TYPE_WORD: Record<BuiltinParamType, string> = { int: 'int', str: 'str', var: 'var', any: 'any' };

/**
 * 人类可读签名（补全详情 / 工具提示用）：`STRLENS(str) → int`。
 * wiki 未载明签名的只给名字；没有这个名字 ⇒ `null`。
 */
export function builtinSignatureLabel(name: string): string | null {
  const sig = builtinSignatureOf(name);
  if (sig === null) return null;
  if (sig.params === null) return name;
  const ps = sig.params.map((p) => `${TYPE_WORD[p.type]}${p.optional ? '?' : ''}`);
  if (sig.variadic) ps.push('…');
  const ret = sig.ret === null ? '?' : sig.ret;
  return `${name}(${ps.join(', ')}) → ${ret}`;
}

/* ---------------- 实参诊断 ---------------- */

/** 诊断输入（`path` 用于方言门；`text` 是当前缓冲区原文） */
export interface BuiltinArgDiagnosticsInput {
  readonly path: string;
  readonly text: string;
  /**
   * 项目里的用户函数名判据（归一化大写进）；命中 = 同名用户函数存在，
   * 该名字整体不判（影子函数让位，见文件头注）。
   */
  readonly isUserFunction?: (normalizedName: string) => boolean;
  /** 已摊平的可见行（`visibleCodeLineList` 产物）：与 `collectArityDiagnostics` 同一个共用口 */
  readonly visible?: readonly VisibleCodeLine[];
}

/** 可证的实参表达式类型（判不出的 ⇒ `null`，一律不报） */
type ExprType = 'int' | 'str';

/** 空白字符（与 `arity.ts` 的 `isBlankChar` 同集：空格 / 制表 / U+3000） */
const isBlankChar = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\u3000';

/**
 * 整个实参槽是否就是一个 `NAME(…)` 调用（引号/嵌套括号感知，尾部不许有运算符）。
 * 是 ⇒ 该调用的返回类型可证；否 ⇒ `null`（复合表达式不猜）。
 */
function wholeCallType(text: string): ExprType | null {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(text);
  if (m === null) return null;
  let depth = 0;
  let inStr = false;
  for (let i = m[0]!.length - 1; i < text.length; i++) {
    const ch = text[i]!;
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
      if (depth === 0) {
        if (i !== text.length - 1) return null;
        const sig = builtinSignatureOf(m[1]!);
        return sig !== null && sig.ret !== null ? sig.ret : null;
      }
    }
  }
  return null;
}

/** 实参槽的可证类型（判不出 ⇒ `null`）；列区间为行内 0 基半开 */
function inferExprType(raw: string, span: ArgSpan): ExprType | null {
  let s = span.start;
  let e = span.end;
  while (s < e && isBlankChar(raw[s])) s++;
  while (e > s && isBlankChar(raw[e - 1])) e--;
  if (s >= e) return null;
  const text = raw.slice(s, e);
  const first = text[0]!;
  // 串字面量 / `@"…"` 格式化串 / `%…%` FORM 串 ⇒ 文字列
  if (first === '"' || first === '@' || first === '%') return 'str';
  // `{…}` 数值插值 ⇒ 数式
  if (first === '{') return 'int';
  if (/^[+-]?\d+$/.test(text)) return 'int';
  const up = text.toUpperCase();
  if (up === 'TRUE' || up === 'FALSE') return 'int';
  return wholeCallType(text);
}

/** 单个实参槽的去空白区间（诊断落点用；全空 ⇒ null） */
function trimmedSpan(raw: string, span: ArgSpan): ArgSpan | null {
  let s = span.start;
  let e = span.end;
  while (s < e && isBlankChar(raw[s])) s++;
  while (e > s && isBlankChar(raw[e - 1])) e--;
  return s >= e ? null : { start: s, end: e };
}

/**
 * 收集整篇缓冲区的内建实参诊断（**纯函数**：文本进、波浪线数据出）。
 *
 * 个数只判「多给」（少给 = 引擎合法省略，静默）；类型只判可证形态。
 * 非 ERB 方言路径 / 空文本 ⇒ 空数组；产出按行、列升序。
 */
export function collectBuiltinArgDiagnostics(input: BuiltinArgDiagnosticsInput): LineDecoration[] {
  if (!isErbDialectPath(input.path) || input.text.length === 0) return [];
  const out: LineDecoration[] = [];
  const lines = input.visible ?? visibleCodeLines(input.text);
  for (const line of lines) {
    if (line.isDefinition) continue;
    // 与 `collectArityDiagnostics` 同一道预筛（两家共用 `erbCallSitesOf`，预筛必须同形）
    if (!line.isCallLine && line.raw.indexOf('(') < 0) continue;
    const code = line.codeView();
    for (const site of erbCallSitesOf(line, code)) {
      const sig = builtinSignatureOf(site.name);
      // 未载明签名（INRANGEARRAY 等）/ 同名用户函数（影子让位）⇒ 不判
      if (sig === null || sig.params === null) continue;
      if (input.isUserFunction?.(normalizedUpper(site.name)) === true) continue;

      // 个数：只判多给（可变实参族不设上限）
      if (!sig.variadic && site.given > sig.params.length) {
        const range =
          site.argFirst >= 0
            ? { startColumn: site.argFirst + 1, endColumn: site.argLast + 1 }
            : { startColumn: site.nameStart + 1, endColumn: site.nameEnd + 1 };
        out.push({
          line: site.line,
          severity: 'error',
          message:
            `内建函数「${site.name}」的实参个数不对：最多 ${sig.params.length} 个，实际 ${site.given} 个` +
            '——多出的实参不会传给函数。',
          ...range,
          code: BUILTIN_ARGS_CODE,
        });
      }

      // 类型：逐槽对签名（只判 int/str 两档；var/any 与判不出的实参不报）。
      // 区间下标在 codeView 与原文之间等价（codeView 保长度：串体刷白、`;` 后补空格），
      // 但类型判据必须读**原文**——codeView 里串字面量已是空格，读它就永远判不出 str。
      for (let i = 0; i < site.spans.length && i < sig.params.length; i++) {
        const want = sig.params[i]!.type;
        if (want !== 'int' && want !== 'str') continue;
        const got = inferExprType(line.raw, site.spans[i]!);
        if (got === null || got === want) continue;
        const span = trimmedSpan(line.raw, site.spans[i]!);
        if (span === null) continue;
        out.push({
          line: site.line,
          severity: 'error',
          message:
            `内建函数「${site.name}」的第 ${i + 1} 个实参应是${want === 'str' ? '文字列' : '数式'}，` +
            `实际写的是${got === 'str' ? '文字列' : '数式'}——Emuera 1.808 起不再静默转换，运行时会直接报错。`,
          startColumn: span.start + 1,
          endColumn: span.end + 1,
          code: BUILTIN_ARG_TYPE_CODE,
        });
      }
    }
  }
  out.sort((a, b) => a.line - b.line || (a.startColumn ?? 0) - (b.startColumn ?? 0));
  return out;
}
