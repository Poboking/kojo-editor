/**
 * 显示行扫描（v0.3 台词推演批；游戏无关；本插件私有）。
 *
 * 职责：把函数体里的 PRINT 系语句行切成**结构事实**（`FunctionDisplayLine`），
 * 台词推演（state-replay 的 `transcript` 构建）据此回答"这行会不会输出、输出什么"。
 *
 * ## 插值切片判据（单一真源：本文件）
 *
 * 回放侧**只按 `DisplayInterpolation.start/end` 偏移切片替换，不再扫一遍**——
 * 插值语法判据只住这里，两处各写一遍必漂（PITFALLS 同族教训）。三形：
 * - `%表达式%`：FORM 串插值（只在 FORM 族动词的载荷里认——普通 `PRINT` 的
 *   `%` 是字面量，引擎不插值，认了就是假插值）；
 * - `{表达式}`：FORM 串的另一写法（配对判据与 `inline.ts` 的 `matchBrace`
 *   同源：引号内外一律照插值处理）；
 * - `\@条件?真文#假文\@`：文本三元整枚切片——条件半边同时由
 *   `collectInlinePredicates` 收作 `INLINE` 谓词，这里补齐真假两支文本。
 *
 * ## 边界口径（v1 刻意不建模，宁少勿错）
 * - `PRINTDATA` 系数据块整块跳过（块体行是数据不是语句；分块条件化输出
 *   留给后续批）；
 * - `PRINTV` 族（载荷 = 单表达式）照收，推演侧按表达式求值；
 * - 非 FORM 族的 `%` / `{` 一律字面量（普通 PRINT 不插值，引擎语义）；
 * - `DRAWLINE` / `PRINTBUTTON` 系照收为显示行（确实往消息窗输出）。
 *
 * ## `SIF` 同行守卫（v0.3 修正）
 *
 * 引擎语义：`SIF 条件 语句` 只约束**同一行**的语句（`SIF` 单独成行等于空操作）。
 * 因此 `SIF CFLAG:好感 > 50 PRINTFORML …` 必须收成一条**带守卫**的显示行
 * （`sifGuarded = true`，守卫谓词就是本行那条 `SIF`）。反向推断（"上一行是 SIF
 * 就守这一行"）**刻意不做**：那在引擎里不成立，会把会显示的行误报成不显示。
 *
 * ⚠ 频次据实（2026-11-02 eraTW 4.981 语料实测）：这种写法**只有 37 行**（同语料
 * `SIF` 总行 30,953，绝大多数是 `SIF cond CALL/RETURN`）。所以本支是"语义正确性"
 * 修复，不是覆盖率大头——别拿它当"口上大半都靠 SIF 打印"的依据。
 */

import type { DisplayInterpolation, FunctionDisplayLine } from '@kojo/plugin-api';
import { erbCodeBodyOf } from '@kojo/plugin-api';
import { parseExpression } from './expr';

/** PRINTDATA 系开块词（与 extract.ts 的 CTX_PRINTDATA_OPEN 同源；插件内禁交叉 import，就地登记） */
const PRINTDATA_OPEN = new Set([
  'PRINTDATA', 'PRINTDATAL', 'PRINTDATAW', 'PRINTDATAK', 'PRINTDATAKL', 'PRINTDATAKW', 'PRINTDATAD', 'PRINTDATADL', 'PRINTDATADW',
  'DATALIST', 'STRDATA',
]);

/** 数据块闭合词（ENDDATA / ENDLIST；与 scanner CLOSE_KINDS 同源） */
const DATA_CLOSE = new Set(['ENDDATA', 'ENDLIST']);

/** 行首 PRINT 动词（ASCII 大写；语料实证动词全大写） */
const PRINT_VERB_RE = /^PRINT[A-Z]*/;

/** 行首 `SIF` 守卫（词边界：`SIF` 后必须空白，`SIFFOO` 不是 SIF） */
const SIF_PREFIX_RE = /^SIF\s+/;

/** 位置 i 起的 PRINT 动词（词尾须断开：`PRINTFLAG` 这种标识符不算动词） */
function printVerbAt(s: string, i: number): string | null {
  const m = PRINT_VERB_RE.exec(s.slice(i));
  if (!m) return null;
  const after = s[i + m[0].length];
  if (after !== undefined && /[A-Za-z0-9_]/.test(after)) return null;
  return m[0];
}

/**
 * `SIF 条件 语句` 里**语句起点**的下标（找不到 PRINT 系语句 → -1）。
 *
 * 判据：顶层（引号外、括号深度 0）且前面是空白的 PRINT 动词。取**首个**候选——
 * 条件表达式里不会再出现裸 PRINT 动词（出现即是函数名 `PRINTxxx(...)`，那是
 * 调用不是本行语句，但语料里无此形态，出现也只影响一行，宁少勿错）。
 */
function findSifStatementStart(s: string, from: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') {
      if (depth > 0) depth--;
    } else if (depth === 0 && (c === ' ' || c === '\t') && printVerbAt(s, i + 1) !== null) {
      return i + 1;
    }
  }
  return -1;
}

/** FORM 族判定：载荷是 FORM 串（插值语法生效） */
function isFormVerb(verb: string): boolean {
  return verb.includes('FORM');
}

/**
 * 引号 / 括号感知的顶层扫描（与 inline.ts 的 findTopLevel 同判据）：
 * 只在深度 0、串外命中。`{}` 在 FORM 串里**不是**括号屏蔽（`{插值}` 本身
 * 就是语法），因此这里屏蔽集只含 `()` `[]`。
 */
function findTopLevel(s: string, from: number, hit: (s: string, i: number) => boolean): number {
  let depth = 0;
  let inStr = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '(' || c === '[') {
      depth++;
      continue;
    }
    if (c === ')' || c === ']') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0 && hit(s, i)) return i;
  }
  return -1;
}

const atTernaryOpen = (s: string, i: number): boolean => s[i] === '\\' && s[i + 1] === '@';

/** `{` 的配对 `}`（嵌套感知、不认引号；与 inline.ts matchBrace 同判据）；未闭合 -1 */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 扫一条 FORM 载荷的插值切片（线性单趟；按出现顺序）。
 * 切片失败（未闭合等）→ 该处按字面量处理（不猜、不产假插值）。
 */
function scanInterpolations(payload: string): DisplayInterpolation[] {
  const out: DisplayInterpolation[] = [];
  let i = 0;
  while (i < payload.length) {
    // 文本三元 `\@cond?then#else\@`
    if (atTernaryOpen(payload, i)) {
      const close = findTopLevel(payload, i + 2, atTernaryOpen);
      if (close < 0) {
        i += 2; // 未闭合：这两个字符按字面量走（不猜）
        continue;
      }
      const inner = payload.slice(i + 2, close);
      const q = findTopLevel(inner, 0, (s, pos) => s[pos] === '?');
      if (q < 0) {
        i = close + 2; // 缺 `?`：整枚按字面量
        continue;
      }
      const condText = inner.slice(0, q).trim();
      const hash = findTopLevel(inner, q + 1, (s, pos) => s[pos] === '#');
      const thenText = (hash >= 0 ? inner.slice(q + 1, hash) : inner.slice(q + 1)).trim();
      const elseText = hash >= 0 ? inner.slice(hash + 1).trim() : '';
      if (condText.length > 0) {
        out.push({
          form: 'inlineTernary',
          text: condText,
          expr: parseExpression(condText),
          start: i,
          end: close + 2,
          thenText,
          elseText,
        });
      }
      i = close + 2;
      continue;
    }
    // 百分号插值 `%expr%`（`%%` = 字面量百分号的保守豁免）
    if (payload[i] === '%') {
      if (payload[i + 1] === '%') {
        i += 2;
        continue;
      }
      const close = payload.indexOf('%', i + 1);
      if (close > i + 1) {
        const exprText = payload.slice(i + 1, close).trim();
        if (exprText.length > 0) {
          out.push({ form: 'percent', text: exprText, expr: parseExpression(exprText), start: i, end: close + 1 });
        }
        i = close + 1;
        continue;
      }
      i++; // 未闭合：字面量
      continue;
    }
    // 花括号插值 `{expr}`
    if (payload[i] === '{') {
      const close = matchBrace(payload, i);
      if (close > i + 1) {
        const exprText = payload.slice(i + 1, close).trim();
        if (exprText.length > 0) {
          out.push({ form: 'brace', text: exprText, expr: parseExpression(exprText), start: i, end: close + 1 });
        }
        i = close + 1;
        continue;
      }
      i++; // 未闭合：字面量
      continue;
    }
    i++;
  }
  return out;
}

/**
 * 收集函数体的显示行（结构事实；解析失败 → opaque，绝不抛）。
 *
 * 保守口径（与 `collectAssignments` / `collectInlinePredicates` 同族）：
 * 跳过空行 / `;` 注释 / `#` 指令 / `@` 头 / `$` 标签行与 `[SKIPSTART]`…
 * `[SKIPEND]` 停用区；`PRINTDATA` 系数据块整块跳过（见头注边界口径）。
 *
 * @param startLine 函数体首行（1 基，含）；调用方传"头行 + 1"
 * @param endLine   函数体末行（1 基，含）
 * @param contextOf 提供时填分支上下文（推演的本地量可达性用）
 */
export function collectDisplayLines(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  contextOf?: (line: number) => string[],
): FunctionDisplayLine[] {
  const out: FunctionDisplayLine[] = [];
  let inSkipBlock = false;
  let inDataBlock = false;

  for (let i = Math.max(1, startLine); i <= endLine && i <= lines.length; i++) {
    const raw = lines[i - 1] ?? '';
    // 列坐标按原文（切片偏移以载荷为参照，行内平移不影响）；代码前缀（`;!;`）后是真代码
    const code = erbCodeBodyOf(raw.trim()).trim();

    if (inSkipBlock) {
      if (code === '[SKIPEND]') inSkipBlock = false;
      continue;
    }
    if (code === '[SKIPSTART]') {
      inSkipBlock = true;
      continue;
    }
    if (code.length === 0 || code.startsWith(';') || code.startsWith('#') || code.startsWith('@') || code.startsWith('$')) continue;

    if (inDataBlock) {
      if (DATA_CLOSE.has(code)) inDataBlock = false;
      continue;
    }
    const dataVerb = PRINTDATA_OPEN.has(code);
    if (dataVerb) {
      inDataBlock = true;
      continue;
    }

    // `SIF 条件 PRINT…`：守卫与语句同行（见头注）；语句不是 PRINT 系 → 本行无显示行
    let sifGuarded = false;
    let stmtAt = 0;
    const sif = SIF_PREFIX_RE.exec(code);
    if (sif) {
      stmtAt = findSifStatementStart(code, sif[0].length);
      if (stmtAt < 0) continue;
      sifGuarded = true;
    }

    const verb = printVerbAt(code, stmtAt);
    if (!verb) continue;
    let payload = code.slice(stmtAt + verb.length).trim();
    // 行内注释截断（引号外；与 collectAssignments 同逻辑——`PRINTL 你好 ;注释`）
    {
      let inStr = false;
      for (let k = 0; k < payload.length; k++) {
        const c = payload[k]!;
        if (c === '"') inStr = !inStr;
        else if (c === ';' && !inStr) {
          payload = payload.slice(0, k).trimEnd();
          break;
        }
      }
    }
    // FORM 族才扫插值；普通 PRINT 的 `%`/`{` 是字面量（引擎语义，见头注）
    const interpolations = isFormVerb(verb) ? scanInterpolations(payload) : [];
    const context = contextOf ? contextOf(i) : undefined;
    out.push({
      line: i,
      verb,
      payload,
      interpolations,
      ...(sifGuarded ? { sifGuarded: true } : {}),
      ...(context ? { context } : {}),
    });
  }
  return out;
}
