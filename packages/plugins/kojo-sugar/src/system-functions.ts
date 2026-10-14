/**
 * 系统函数中文别名（HK-11①）——**单一真源**。
 *
 * 作者在条件/正文里可能写到的系统函数（`GETBIT` / `FIRSTTIME` / `CHK_*` /
 * `RAND` / 引擎算术族 …，HANDOFF §13.4 HK-11 与附录 A）给出中文糖形；本表是
 * 唯一的一份——**降糖器与 Monaco 高亮/补全都从这里派生**，绝不各写一份。
 *
 * 三条纪律：
 * 1. **只收系统函数**：不含作者自定义函数（规范 §7.2 已排除"用户自定义扩展函数"）；
 * 2. **纯函数、无副作用、可扩展**：本模块只依赖叶子表 `identifier-chars`（标识符
 *    字符集单一真源；**不**依赖 `expression.ts`，避免循环 import），新增别名只改这一处；
 * 3. **fail-visible**：未收录的中文名**原样保留**（不静默改写）。
 */

import { isIdentPart } from './identifier-chars';

/**
 * 入库判据（HK-11① 扩容批）：
 * - **引擎内建**：Emuera 引擎自带、在游戏侧无 `@` 定义（语料实证：STRLENS/STRCOUNT/
 *   STRFIND/SUBSTRING/UNICODE/ENCODETOUNI/TOSTR/TOINT/CHKFONT/REPLACE/GETNUM/SUMARRAY/
 *   MATCH/FINDELEMENT/INRANGE/INRANGEARRAY/TOHALF/TOFULL/GETCHARA/SQRT…）；
 * - **eraTW 系统检查族 `CHK_*`**（HANDOFF §13.4 HK-11 点名）：定义在游戏基础库
 *   （如 `COMMON2.ERB` / `OGAMITAOSHI.ERB` / `BIRTH.ERB`），与项目内自定义 `@函数` 有别。
 * **不在本表**：依任务口径与规范 §7.2 排除的"游戏助手长尾 / 项目内自定义 `@函数`"
 * （`TEXTR` / `COLORMESSAGE` / `MAKE_INT` / `MAKE_STR` / `HE_SHE_CN` / `HPH_PRINT`
 * 等基础库助手与 K* 私有函数）。
 */

/** 中文名 → 原生 ERB 函数名（单一真源） */
export const SYSTEM_FUNCTION_ALIASES: ReadonlyMap<string, string> = new Map<string, string>([
  // 位运算族（引擎内置）
  ['获取标记', 'GETBIT'],
  ['设置标记', 'SETBIT'],
  ['清除标记', 'CLEARBIT'],
  ['反转标记', 'INVERTBIT'],
  // 算术 / 比对族（`state-replay` 的引擎内置纯函数子集）
  ['分组匹配', 'GROUPMATCH'],
  ['最大值', 'MAX'],
  ['最小值', 'MIN'],
  ['绝对值', 'ABS'],
  ['符号', 'SIGN'],
  ['限幅', 'LIMIT'],
  ['乘方', 'POWER'],
  ['平方根', 'SQRT'],
  // 随机族
  ['随机', 'RAND'],
  ['随机化', 'RANDOMIZE'],
  // 时间族
  ['当前时间', 'GETTIME'],
  ['毫秒', 'GETMILLISECOND'],
  // 字符串族（引擎内置）
  ['字符串长度', 'STRLENS'],
  ['出现次数', 'STRCOUNT'],
  ['查找位置', 'STRFIND'],
  ['取子串', 'SUBSTRING'],
  ['替换', 'REPLACE'],
  ['取码点', 'UNICODE'],
  ['编码取字', 'ENCODETOUNI'],
  ['转字符串', 'TOSTR'],
  ['转数值', 'TOINT'],
  ['转半角', 'TOHALF'],
  ['转全角', 'TOFULL'],
  ['检查字体', 'CHKFONT'],
  // 数组 / CSV 常量族（引擎内置）
  ['取常量', 'GETNUM'],
  ['数组求和', 'SUMARRAY'],
  ['数组计数', 'MATCH'],
  ['数组查找', 'FINDELEMENT'],
  ['区间判定', 'INRANGE'],
  ['区间计数', 'INRANGEARRAY'],
  ['取角色号', 'GETCHARA'],
  // 系统 / 游戏助手（HANDOFF §13.4 HK-11 点名）
  ['首次', 'FIRSTTIME'],
  // eraTW 系统检查族 `CHK_*`
  ['检查约会中', 'CHK_DATENOW'],
  ['检查焦点', 'CHK_FOCUS'],
  ['检查入口', 'CHK_ENTRANCE'],
  ['检查有孩子', 'CHK_HAVE_CHILD'],
  ['检查子名重复', 'CHK_CHILDNAME_DUPLICATION'],
  ['检查避妊恋爱', 'CHK_HININ_LOVE'],
  ['检查避妊恋爱二', 'CHK_HININ_LOVE_2'],
  ['检查避妊理由', 'CHK_HININ_REASON'],
  ['检查避妊理由二', 'CHK_HININ_REASON_2'],
]);

/** 按中文名长度降序（最长优先：`随机化` 先于 `随机`，避免前缀吞并） */
const BY_LENGTH: ReadonlyArray<readonly [string, string]> = [...SYSTEM_FUNCTION_ALIASES].sort(
  (a, b) => b[0].length - a[0].length,
);

/** ERB 字符串字面量 `"…"`（无转义概念）的结束下标；返回**闭合引号之后**的位置 */
function stringEnd(text: string, from: number): number {
  let j = from + 1;
  while (j < text.length && text[j] !== '"') j++;
  return Math.min(j + 1, text.length);
}

/**
 * 把表达式文本里的**调用形态**中文系统函数名替换为 ERB 函数名。
 *
 * 只对「中文名（可含空白）后随 `(`」生效——裸词（台词 / 属性词 / 别名）一律不动，
 * 故不会误伤同为中文名的普通文本。字符串字面量内部不改写；未收录的中文名原样保留
 * （fail-visible）。
 */
export function lowerSystemFunctions(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    const call = matchCall(text, i);
    if (call) {
      out += call.replacement;
      i = call.end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 在 `i` 处匹配「别名调用」；命中返回替换文本与结束下标（指向 `(`），否则 null */
function matchCall(text: string, i: number): { replacement: string; end: number } | null {
  // 词边界：前一个字符不得是标识符字符（避免从长中文串中截取子串误伤）
  if (i > 0 && isIdentPart(text[i - 1]!)) return null;
  for (const [cn, erb] of BY_LENGTH) {
    if (!text.startsWith(cn, i)) continue;
    // 名字与 `(` 之间允许空白（引擎侧 `GETBIT (…)` 亦合法），只换名字本身
    let j = i + cn.length;
    while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
    if (text[j] !== '(') continue;
    return { replacement: erb + text.slice(i + cn.length, j), end: j };
  }
  return null;
}
