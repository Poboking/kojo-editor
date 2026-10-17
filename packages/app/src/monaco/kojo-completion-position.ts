import type * as Monaco from './entry';

/**
 * COMPL-SHARED · `.kojo` 补全的**行内位置判据**（字符串 / 注释 / 插值 / 名字段）。
 *
 * `.kojo` 各 source（库函数名、项目函数名……）判的是同一件事："光标这一处是不是一个可补全的
 * 名字位"。此前每个 source 自持一份字符集与扫描——本模块把它收成**一份**，口径与 `kojo-sugar`
 * 对齐（`identifier-chars.ts` 未对外导出，故 app 层按既有纪律自持一份，但只此一份）。
 */

/**
 * 字符类由各段**码位区间**拼出（与 `kojo-sugar` 的 `identifier-chars.ts` 同口径）：
 * 转义写法在编辑往返里极易错位，码位区间只有一处真相。
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

/** 标识符字符集：ASCII 字母 / 数字 / 下划线 + `$`（只作后续字符）+ CJK + 全角拉丁 */
const NAME_CHAR_RE = new RegExp(
  `[0-9A-Za-z_$${rangeText(CJK_RANGES)}${rangeText(FULLWIDTH_LATIN_RANGES)}]`,
);

/** CJK 判定（含扩展 A / 假名）；CJK-primary 过滤用（表里有中文名 ⇒ 纯 ASCII 名视作隐藏别名） */
const CJK_RE = new RegExp(`[${rangeText(CJK_RANGES)}]`);

export function isNameChar(ch: string): boolean {
  return NAME_CHAR_RE.test(ch);
}

export function isCjk(ch: string): boolean {
  return CJK_RE.test(ch);
}

/**
 * 光标是否落在行内**字符串 / 注释**里（与 `kojo-sugar` 的 `inlineCommentIndex` 同口径：
 * 引号配平后第一个 `;` 起至行尾）。字符串内 / 注释内不给候选。
 */
export function insideStringOrComment(line: string, col0: number): boolean {
  let inString = false;
  const stop = Math.min(col0, line.length);
  for (let i = 0; i < stop; i++) {
    const ch = line[i]!;
    if (ch === '"') inString = !inString;
    else if (!inString && ch === ';') return true;
  }
  return inString;
}

/** 光标是否在 `{ … }` 插值内（向左找 `{`，途中遇 `}` 即已在插值外）——插值里是变量名的地盘 */
export function insideInterpolation(line: string, col0: number): boolean {
  for (let i = col0 - 1; i >= 0; i--) {
    const ch = line[i]!;
    if (ch === '}') return false;
    if (ch === '{') return true;
  }
  return false;
}

/** 一个名字段（0 基、左含右不含；`prefix` = 光标前已输入部分） */
export interface KojoNameField {
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
}

/**
 * 光标处的**连续标识符段**（左右至少一侧是标识符字符才算名字位，否则 `null`）。
 * 替换范围只覆盖这一段，绝不越过分隔符。
 */
export function identifierFieldAt(line: string, col0: number): KojoNameField | null {
  const left = col0 > 0 ? line[col0 - 1]! : undefined;
  const right = col0 < line.length ? line[col0]! : undefined;
  const onLeft = left !== undefined && isNameChar(left);
  const onRight = right !== undefined && isNameChar(right);
  if (!onLeft && !onRight) return null;
  let start = col0;
  let end = col0;
  while (start > 0 && isNameChar(line[start - 1]!)) start--;
  while (end < line.length && isNameChar(line[end]!)) end++;
  return { start, end, prefix: line.slice(start, col0) };
}

/**
 * 名字段的**终止字符**：`( ) , ， ;` + 半角空格 / 制表 / 全角空格
 * （糖的实参列表与语句界标；全角空格是中文输入的常规分隔）。
 */
const NAME_TERMINATOR_RE = new RegExp(`[(),;${String.fromCharCode(0xff0c, 0x20, 0x09, 0x3000)}]`);

/**
 * 关键字**之后**的名字槽（行首 `调用 X` / `函数 X(` 那一类）：自 `boundStart` 起连续吃到终止字符
 * 为止；光标越过槽右界 ⇒ `null`（那已经不是名字位，不猜）；槽里混进非名字字符 ⇒ `null`。
 */
export function nameFieldAfter(line: string, col0: number, boundStart: number): KojoNameField | null {
  if (col0 < boundStart) return null;
  let slotEnd = boundStart;
  while (slotEnd < line.length && !NAME_TERMINATOR_RE.test(line[slotEnd]!)) slotEnd++;
  if (col0 > slotEnd) return null;
  const section = line.slice(boundStart, col0);
  if (![...section].every(isNameChar)) return null;
  let start = col0;
  let end = col0;
  while (start > boundStart && isNameChar(line[start - 1]!)) start--;
  while (end < slotEnd && isNameChar(line[end]!)) end++;
  return { start, end, prefix: line.slice(start, col0) };
}

/** 取行文本（桩 model 缺 `getLineContent` ⇒ 空串：一切判据落空，而不是抛） */
export function lineAt(model: Monaco.editor.ITextModel, lineNumber: number): string {
  const read = (model as { getLineContent?: (n: number) => string | undefined }).getLineContent;
  return typeof read === 'function' ? read.call(model, lineNumber) ?? '' : '';
}
