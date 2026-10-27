/**
 * 标识符字符集（**单一真源**）——表达式扫描（`expression.ts`）与系统函数名扫描
 * （`system-functions.ts`）共用同一张类表。
 *
 * 为什么单独一个模块（E16 批，2026-10-14）：这张表原先在两个文件里各抄一份，
 * 两份一旦口径分裂就会出现**产物正确却报 `unknown-identifier`**的诊断
 * （`NOWEX:Ｃ絶頂` 就是实例：函数名扫描与表达式扫描都在切同一个 token）。
 * 本模块是叶子（不 import 任何东西），所以既消掉了副本，也不会让
 * `system-functions.ts` 与 `expression.ts` 互相依赖（原头注的"无循环 import"纪律照旧成立）。
 *
 * 字符集口径：
 * - ASCII 字母 / 数字 / 下划线——ERB 变量与函数名本体；
 * - CJK（平假名 · 片假名 · 汉字 · 扩展 A）——糖里的具名索引（规范 §3.8：
 *   `CFLAG:TARGET:诶嘿嘿`），中文名必须支持；
 * - **全角拉丁字母**（`Ａ`–`Ｚ` U+FF21–FF3A、`ａ`–`ｚ` U+FF41–FF5A）——真实语料
 *   四面族的变量名就是这么写的（`NOWEX:Ｃ絶頂`：语料 2,471 处 / 152 份文件，
 *   `Ｃ絶頂` 单词 525 处）。缺它则在 `Ｃ` 处把标识符切断 ⇒ 后半截当新词解析 ⇒ 报错。
 *
 * 明确**不收**：全角标点（`，` `：` `（）` `％` 等）与全角数字（U+FF10–FF19）——
 * 规范 §8 要专门检测全角标点误用，认成标识符字符等于把误用吞进变量名里
 * （负断言见 `tests/engine-globals.test.ts`：`Ｃ，絶頂` 必须仍被切成两个词各自报错）。
 */

/**
 * 标识符字符**类表源**（字母 / 下划线 / CJK / 全角拉丁 `Ａ`–`Ｚ` `ａ`–`ｚ`；不含数字）。
 * 起始集与后续集**由同一串派生**（后续集 = 起始集 + `0-9` + `$`）——两张表各抄一份正是
 * 本模块要消掉的东西，故这里也不留两份可漂移的副本。
 */
const IDENT_CHARS = 'A-Za-z_\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uFF21-\\uFF3A\\uFF41-\\uFF5A';

/**
 * 字符串视图形参 / 实参的**声明后缀** `$`（v1.7：`实参$` / 形参名 `名字$`）。
 * **只进后续集、不进起始集**——`$` 起首的 ERB 标签（`$LABEL`）不受影响（起始集无 `$`）；
 * 与 `@"…"` 心形记号零冲突（`@` 本就不是标识符字符）。
 * 运算符边界判定（`下面的` 词边界）对 `$` 也因此成立——`实参$ 不在 …` 之类照常降糖。
 */
const IDENT_SUFFIX = '$';

const IDENT_START_RE = new RegExp(`[${IDENT_CHARS}]`);
const IDENT_PART_RE = new RegExp(`[${IDENT_CHARS}0-9${IDENT_SUFFIX}]`);

/** 标识符起始字符判定（`scanIdentifier` 的第一字符） */
export function isIdentStart(ch: string): boolean {
  return IDENT_START_RE.test(ch);
}

/** 标识符后续字符判定（词边界检查也用它） */
export function isIdentPart(ch: string): boolean {
  return IDENT_PART_RE.test(ch);
}

/**
 * 「函数头名 / 光标取词」共用的**名字字符**类源（起始集 + `0-9`；**刻意不含
 * `$`**、不含全角标点 / 全角数字——与文件头注的口径逐字一致）。
 *
 * 为什么有这一张（K2-PRE-REUSE ⑤）：`.kojo` 侧「名字 → 产物函数头」的自证闭环
 * （`definition.ts`）要求**取词尺与头名尺是同一套字符**——两处各写一个集，就会
 * 重现本批修的病：中文 / 日文函数名在光标处取不出整串、或取出了却在产物里找不到
 * `@` 头，作者看到的是"没有定义"。
 *
 * 为什么不是 {@link isIdentPart}：那个集含字符串变量后缀 `$`（`实参$` 的写法），
 * 而函数名引用与 `@` 头都不收它（`$` 起首的 `$LABEL` 归标签腿）。数字允许打头
 * 是逐字保留旧头名正则 `[A-Za-z0-9_]+` 的历史口径——ASCII 行为不变是本批硬判据。
 */
export const IDENT_NAME_CHARS = `${IDENT_CHARS}0-9`;

const IDENT_NAME_CHAR_RE = new RegExp(`[${IDENT_NAME_CHARS}]`);

/** 名字字符判定（头名正则组装与 `symbolTokenAt` 取词共用同一枚谓词） */
export function isIdentNameChar(ch: string): boolean {
  return IDENT_NAME_CHAR_RE.test(ch);
}
