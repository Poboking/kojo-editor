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

import type { KojoLibraryTable } from '@kojo/plugin-api';
import { isIdentPart, isIdentStart } from './identifier-chars';

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
 *
 * ## ZH-F1：基础库 / 常用函数名（住 adapter，不进本表）
 *
 * 上表是**跨游戏语言层**的系统函数；游戏**基础库**里的助手 / 宏（`HPH_PRINT` /
 * `TEXTR` / `ASK_YN` …）不属语言层，住 adapter 的 `KojoLibraryTable`（经
 * `game.adapter` 槽位按 `adapterId` 注入）。本模块的扫描**先查系统表、再查 adapter
 * 表**（系统表优先）；两表都不认的**中文函数名调用形态**原样保留，由 `expression.ts`
 * 报 `function-name-unknown`（**warning**，fail-visible，不猜、不纠）。
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

/**
 * 原生 ERB 函数名 → 中文名（**反向派生**自 `SYSTEM_FUNCTION_ALIASES`；正反对称是构造
 * 事实，单一真源、绝不手抄第二张表——与 `PRONOUN_REVERSE` 同一条纪律）。同名多中文取
 * **首条**。显示侧（ZH-F2：投影反糖 / 宿主 hover）用它；查不到一律 `undefined`（不猜）。
 */
export const SYSTEM_FUNCTION_REVERSE: ReadonlyMap<string, string> = (() => {
  const reverse = new Map<string, string>();
  for (const [cn, erb] of SYSTEM_FUNCTION_ALIASES) {
    if (!reverse.has(erb)) reverse.set(erb, cn);
  }
  return reverse;
})();

/** ERB 字符串字面量 `"…"`（无转义概念）的结束下标；返回**闭合引号之后**的位置 */
function stringEnd(text: string, from: number): number {
  let j = from + 1;
  while (j < text.length && text[j] !== '"') j++;
  return Math.min(j + 1, text.length);
}

/**
 * 查一个中文函数名对应的 ERB 函数名：**系统函数表优先，再查 adapter 基础库表**。
 * 两表皆无 → `undefined`（**绝不猜**，规范 §5.3）。
 */
export function lookupFunctionName(name: string, libraryTable?: KojoLibraryTable): string | undefined {
  const system = SYSTEM_FUNCTION_ALIASES.get(name);
  if (system !== undefined) return system;
  return libraryTable?.lookupByName(name);
}

/** 该中文名是否被任一函数表收录（`expression.ts` 据它决定是否报 `function-name-unknown`） */
export function isKnownFunctionName(name: string, libraryTable?: KojoLibraryTable): boolean {
  return lookupFunctionName(name, libraryTable) !== undefined;
}

/**
 * 把表达式文本里的**调用形态**中文函数名替换为 ERB 函数名。
 *
 * 只对「中文名（可含空白）后随 `(`」生效——裸词（台词 / 属性词 / 别名）一律不动，
 * 故不会误伤同为中文名的普通文本。字符串字面量内部不改写；未收录的中文名原样保留
 * （fail-visible）。
 *
 * 扫描口径：以**最大标识符**为词元（`identifier-chars` 的起点集 + 后续集），整词查表
 * ——`随机化` 与 `随机` 各按**精确名**命中，"最长优先"由"整词"天然保证（不再需要长度
 * 降序表）。词元起点须**不粘在前一个标识符字符上**，与旧口径逐字等价。
 */
export function lowerSystemFunctions(text: string, libraryTable?: KojoLibraryTable): string {
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
    // 词元起点：标识符起始字符，且前一个字符不得是标识符字符（不从长中文串中截取子串）
    if (!isIdentStart(ch) || (i > 0 && isIdentPart(text[i - 1]!))) {
      out += ch;
      i++;
      continue;
    }
    // 扫**最大标识符**（整词精确查表）
    let e = i + 1;
    while (e < text.length && isIdentPart(text[e]!)) e++;
    const name = text.slice(i, e);
    // 名字与 `(` 之间允许空白（引擎侧 `GETBIT (…)` 亦合法），只换名字本身
    let j = e;
    while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
    if (text[j] === '(') {
      const erb = lookupFunctionName(name, libraryTable);
      if (erb !== undefined) {
        out += erb + text.slice(e, j);
        i = j;
        continue;
      }
    }
    out += name;
    i = e;
  }
  return out;
}
