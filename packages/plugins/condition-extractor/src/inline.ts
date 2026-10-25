/**
 * 文本内联条件扫描（Emuera 三元的两形；游戏无关）。
 *
 * ## 语法事实
 * Emuera 的三元有两形（Era Wiki `Emuera/exop` §Ternary Operators、
 * `Emuera/exetc` §Using Formatted Strings in String Expressions）：
 *
 * - **文本形** `\@<条件>?<真文>#<假文>\@` —— `#` 是 else 分隔符（**不是** `:`），
 *   可直接写在 `PRINTFORM` 族实参 / `@"…"` 串 / `PRINTDATA` 体里，不需要包壳；
 * - **数值形** `<目标> = <条件> ? <真> # <假>` —— 本模块只管花括号插值
 *   `{<条件> ? <真> # <假>}` 这一处（整条赋值语句的条件由控制流面负责）。
 *
 * 两形的**条件半边**都是真谓词：它决定"这句话在这个状态下会不会出现"。
 *
 * ## 只做识别，不做求值
 * 本模块只负责把条件原文切出来（`text`）与定位（`column`），解析交给调用方的
 * `parseExpression`——解析失败即 `opaque`，绝不猜。三条保守口径：
 * 1. `\@` 缺收尾 / 缺 `?` ⇒ 整枚跳过（残句不产谓词）；
 * 2. `?` `#` `\@` 只在**顶层**认（引号内、`{}` `()` `[]` 内一律是文本）；
 * 3. 花括号形要求整条插值**解析成顶层三元**才算条件——`{CFLAG:0}` 这类纯取值
 *    插值不产谓词（否则每句显示都会凭空多一条依赖）。
 */

/** 行内识别到的一处内联条件 */
export interface InlineCondition {
  /** 条件原文（已 trim） */
  text: string;
  /** 标记在行内的 0 基列（`\@` 的 `\`，或 `{` 的位置；展示 / 排障用） */
  column: number;
}

/** 引号 / 括号感知的"找标记"：只在顶层（深度 0、串外）命中 `hit` */
function findTopLevel(
  s: string,
  from: number,
  hit: (s: string, i: number) => boolean,
): number {
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
    if (c === '{' || c === '(' || c === '[') {
      depth++;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0 && hit(s, i)) return i;
  }
  return -1;
}

/** 顶层 `\@` 起点（`\` 起、后随 `@`）；未命中 -1 */
const atTextOpen = (s: string, i: number): boolean => s[i] === '\\' && s[i + 1] === '@';

/**
 * 文本形 `\@条件?真#假\@` 的条件扫描。
 *
 * 真 / 假两段只是**输出文本**，本模块不解析其内容（里面的 `{…}` 插值会由
 * 花括号形另走一遍，两条谓词各自成立）。因此 `#` 不参与切分判据——只要
 * 收尾 `\@` 在，`?` 之前就是条件。
 *
 * @returns 按出现顺序的条件列表（同行可有多枚）
 */
export function scanTextTernaries(line: string): InlineCondition[] {
  const out: InlineCondition[] = [];
  let cursor = 0;
  for (;;) {
    const open = line.indexOf('\\@', cursor);
    if (open < 0) break;
    const q = findTopLevel(line, open + 2, (s, i) => s[i] === '?' || atTextOpen(s, i));
    if (q < 0) break; // 无 `?`：残句，后面也不会有完整的三元
    if (atTextOpen(line, q)) {
      cursor = q + 2; // 空条件 `\@\@`：跳过这一对
      continue;
    }
    const cond = line.slice(open + 2, q).trim();
    const close = findTopLevel(line, q + 1, atTextOpen);
    if (close < 0) break; // 未闭合：不猜
    if (cond.length > 0) out.push({ text: cond, column: open });
    cursor = close + 2;
  }
  return out;
}

/**
 * 花括号插值形 `{条件 ? 真 # 假}` 的条件扫描。
 *
 * 判据刻意收紧到"**整条插值解析成顶层三元**"：`{CFLAG:0}` 这类取值插值遍地都是，
 * 若按"含 `?`"认会把显示文本当条件，凭空造依赖。解析器实例由调用方注入
 * （本模块不 import 表达式实现，保持"扫描 / 解析"两层可分）。
 *
 * @param parse 表达式解析器（返回 `{ kind }`；失败实现应给 `opaque`）
 */
export function scanBraceTernaries(
  line: string,
  parse: (text: string) => { kind: string },
): InlineCondition[] {
  const out: InlineCondition[] = [];
  let cursor = 0;
  for (;;) {
    const open = line.indexOf('{', cursor);
    if (open < 0) break;
    const close = matchBrace(line, open);
    if (close < 0) {
      cursor = open + 1; // 未闭合（ASCII 画的散括号）：跳到下一处
      continue;
    }
    cursor = close + 1;
    const inner = line.slice(open + 1, close).trim();
    if (inner.length === 0 || !inner.includes('?')) continue;
    if (parse(inner).kind !== 'ternary') continue;
    const q = findTopLevel(inner, 0, (s, i) => s[i] === '?');
    const cond = (q > 0 ? inner.slice(0, q) : inner).trim();
    if (cond.length > 0) out.push({ text: cond, column: open });
  }
  return out;
}

/**
 * `{` 的配对 `}`（嵌套感知）；未闭合 -1。
 *
 * **不认引号**：FORM 串里 `"` 是要输出的字面量（`PRINTFORM "「%名字%」"` 的常态），
 * `{}` 在引号内外一律照插值处理——把引号当边界反而会漏掉 `"{A ? 1 # 0}"` 这种真条件。
 */
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
