/**
 * 标识符字符集——**语言面唯一一份**（`isNameChar` 及其字符类的单一真源）。
 *
 * ## 为什么独立成模块、而不是塞进 `declarations.ts`
 *
 * 这份字符集的消费方分两类：语言面自己（声明名 / 符号名的切词）与**宿主**的补全位置判据
 * （`app/src/monaco/kojo-completion-position.ts` 的 `isNameChar` / `nameWordsOf` /
 * `identifierFieldAt`，ERB 与 `.kojo` 两条补全都吃它）。后者在**开机图**里。
 * 若字符集住在 `declarations` 里，宿主为了一个单字符判据就要把整包声明层拖进首屏；
 * 单开一个零 import 的叶子，两边都只付这一枚的代价。
 *
 * ## 口径（2026-10-26 批：两门语言一套类表）
 *
 * 规范口径其实只有一条：**名字的后续字符 = 字母 / 数字 / 下划线**
 * （`KOJO-2.0-LANGUAGE-SPEC.md` §2.4；core `isIdentifier` 逐字是
 * `[\p{L}_][\p{L}\p{N}_]*`，Emuera 的 ERB 记号字符同样按 `[\p{L}\p{N}_]` 取词）。
 * 本表的码位区间就是这条口径在编辑器切词面的落实：
 * ASCII 字母数字 / 下划线 + 拉丁补充 + CJK（假名 / 扩展 A / 汉字 / **兼容汉字**）+
 * **全角数字** + 全角拉丁 + **半角片假名**。
 *
 * 两门语言**唯一**的实际差异是 `$`：
 * - `.kojo` 糖（v1.7）的字符串形参/实参后缀 `$`（`实参$`）属于名字本体 ⇒ 进
 *   {@link NAME_CHAR_CLASS}（`isNameChar` 的取词尺，B1 行为逐字保留）；
 * - ERB 的 `$` 是**标签记号**（`$标签`），不是名字字符 ⇒ ERB 名字槽用
 *   {@link ERB_NAME_CHAR_CLASS}（同一份基表去掉 `$`）。并进名字会让 `CALL $FOO` 把
 *   `$` 当成函数名的一部分（`erb-completion-families.ts` 的 `$CF` 同理）。
 *
 * ⚠ 与 `kojo-core` 的 `isIdentifier(text)` **不是同一件事**，别互换：那是"整串是不是一个
 * 合法标识符"（走 core 词法），这是"**单个字符**能不能续在一个名字里"（走编辑器切词）。
 * core 不收 `$`，而 `.kojo` 糖的取词尺收它——判据不同源，别拿本表当语言校验用。
 */

type CharRange = readonly [lo: number, hi: number];

const rangeText = (ranges: readonly CharRange[]): string =>
  ranges.map(([lo, hi]) => `${String.fromCharCode(lo)}-${String.fromCharCode(hi)}`).join('');

/** 拉丁字母补充（`\p{L}` 的一部分；`.kojo` 侧此前已有，统一后两门语言同集） */
const LATIN_SUPPLEMENT_RANGES: readonly CharRange[] = [[0x00c0, 0x024f]];
/** 假名 / CJK 扩展 A / 汉字 / 兼容汉字 */
const CJK_RANGES: readonly CharRange[] = [
  [0x3040, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
];
/** 全角数字（`\p{N}`；真实语料的名字里有它，缺了会在此截断成两个词） */
const FULLWIDTH_DIGIT_RANGES: readonly CharRange[] = [[0xff10, 0xff19]];
/** 全角拉丁（大写段与小写段之间隔着全角符号，不并成一个区间） */
const FULLWIDTH_LATIN_RANGES: readonly CharRange[] = [
  [0xff21, 0xff3a],
  [0xff41, 0xff5a],
];
/** 半角片假名（`ｱ`–`ﾟ`；老语料里与全角假名混写） */
const HALFWIDTH_KATAKANA_RANGES: readonly CharRange[] = [[0xff66, 0xff9f]];

/**
 * 两门语言共用的名字字符**源码串**（不含外层方括号、不含 `$`）。
 *
 * 对外给**字符串**而不是 `RegExp` 对象：消费方要把它拼进自己的正则（如
 * `nameWordsOf` 的 `${NAME_CHAR_CLASS}+`），共享一个带 `g` 标志的正则会因
 * `lastIndex` 串味——这是本仓踩过的那一类坑，故只交**字符类文本**。
 */
const SHARED_NAME_CHAR_CLASS: string =
  '0-9A-Za-z_' +
  rangeText(LATIN_SUPPLEMENT_RANGES) +
  rangeText(CJK_RANGES) +
  rangeText(FULLWIDTH_DIGIT_RANGES) +
  rangeText(FULLWIDTH_LATIN_RANGES) +
  rangeText(HALFWIDTH_KATAKANA_RANGES);

/**
 * `.kojo` 的名字字符类 = 共用集 + `$`（字符串形参后缀 `实参$`；B1 行为逐字保留）。
 * ERB 侧**不得**用这一份（`$` 是标签记号，见模块头注）。
 */
export const NAME_CHAR_CLASS: string = `${SHARED_NAME_CHAR_CLASS}$`;

/**
 * ERB 的名字字符类 = 共用集（**无 `$`**）。
 * `@kojo/plugin-erb-parser` 的 `NAME_CHAR_RE` 从这里派生——ERB 名字槽只有这一处真源。
 */
export const ERB_NAME_CHAR_CLASS: string = SHARED_NAME_CHAR_CLASS;

const NAME_CHAR_RE = new RegExp(`[${NAME_CHAR_CLASS}]`);

/**
 * 单字符是不是名字字符。
 *
 * 逐字保留搬运前的实现（`NAME_CHAR_RE.test(ch)`，无 `g` 标志 ⇒ 不做 `lastIndex` 记账）：
 * 调用方一律传**单个**码元。B1 的判据是"行为逐字不变"，此处**刻意不加**长度守卫——
 * 加守卫是收紧语义，那是另一个批的事。
 */
export function isNameChar(ch: string): boolean {
  return NAME_CHAR_RE.test(ch);
}

/** CJK 判定（含扩展 A / 假名）；CJK-primary 过滤用（表里有中文名 ⇒ 纯 ASCII 名视作隐藏别名） */
const CJK_RE = new RegExp(`[${rangeText(CJK_RANGES)}]`);

export function isCjk(ch: string): boolean {
  return CJK_RE.test(ch);
}
