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
 * ## 口径（与 `@kojo/plugin-kojo-sugar` 的 `identifier-chars.ts` 同源）
 *
 * ASCII 字母 / 数字 / 下划线 / `$` + CJK（假名 + 扩展 A + 汉字）+ 全角拉丁。
 * 字符类由**码位区间**拼出而不是转义写法：转义在编辑往返里极易错位，码位区间只有一处真相。
 *
 * ⚠ 与 `kojo-core` 的 `isIdentifier(text)` **不是同一件事**，别互换：那是"整串是不是一个
 * 合法标识符"（走 core 词法），这是"**单个字符**能不能续在一个名字里"（走编辑器切词）。
 * 两者对 `$` 与边界的口径并不相同——B1 是纯搬运批，任何语义靠拢都必须另开批。
 */

type CharRange = readonly [lo: number, hi: number];

const rangeText = (ranges: readonly CharRange[]): string =>
  ranges.map(([lo, hi]) => `${String.fromCharCode(lo)}-${String.fromCharCode(hi)}`).join('');

/** 假名 / CJK 扩展 A / 汉字 */
const CJK_RANGES: readonly CharRange[] = [
  [0x3040, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
];
/** 全角拉丁（大写段与小写段之间隔着全角符号，不并成一个区间） */
const FULLWIDTH_LATIN_RANGES: readonly CharRange[] = [
  [0xff21, 0xff3a],
  [0xff41, 0xff5a],
];

/**
 * 标识符字符类的**源码串**（不含外层方括号；`$` 已转义）。
 *
 * 对外给这个而不是给 `RegExp` 对象：消费方要把它拼进自己的正则（如
 * `nameWordsOf` 的 `${NAME_CHAR_CLASS}+`），共享一个带 `g` 标志的正则会因
 * `lastIndex` 串味——这是本仓踩过的那一类坑，故只交**字符类文本**。
 */
export const NAME_CHAR_CLASS: string = `0-9A-Za-z_$${rangeText(CJK_RANGES)}${rangeText(FULLWIDTH_LATIN_RANGES)}`;

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
