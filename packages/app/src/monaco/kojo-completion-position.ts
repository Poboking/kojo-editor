import type * as Monaco from './entry';
import { SUGAR_LEXICON_WORDS, type SugarLexiconWord } from '@kojo/plugin-kojo-sugar';

/**
 * COMPL-SHARED · `.kojo` 补全的**行内位置判据**（字符串 / 注释 / 插值 / 名字段 / 关键字锚）。
 *
 * `.kojo` 各 source（库函数名、项目函数名……）判的是同一件事："光标这一处是不是一个可补全的
 * 名字位"。此前每个 source 自持一份字符集与扫描——本模块把它收成**一份**，口径与 `kojo-sugar`
 * 对齐（`identifier-chars.ts` 未对外导出，故 app 层按既有纪律自持一份，但只此一份）。
 *
 * 「关键字之后的名字位」也是同一件事的一半：锚（`行首空白 + 词形 + 空白`）此前有四处手拼
 * （`kojo-face` / `kojo-index` 各一份 `时机`、一份 `是`、`kojo-functions` 一份词表派生），
 * 拼装口径漂移无人可查 ⇒ 装配器与锚都收在本文件，各 source 只**引用**不**再造**。
 */

/**
 * 空白判据**单源**：字符集与 `kojo-sugar` lexer 逐字一致（它处处接受 `[ \t\u3000]+`，
 * `时机　本番：` 这类全角缩进/分隔能编译）。此前补全侧四套写法并存（`[ \t]` / `\s` / 自持全角），
 * 口径以"能编译的那一套"为准 ⇒ 收在此处一份，消费者只拼它。
 * NBSP 一类**故意不收**：lexer 不认，补全也不能认（否则补得上、编译炸）。
 */
export const BLANK_CLASS_STR = '\\t \\u3000';

/** 单字符空白判定用正则（同一字符集，非另一份手抄） */
export const BLANK_RE: RegExp = new RegExp(`[${BLANK_CLASS_STR}]`);

const ALL_BLANK_RE = new RegExp(`^[${BLANK_CLASS_STR}]*$`);

export function isBlank(ch: string): boolean {
  return BLANK_RE.test(ch);
}

/** text 全为空白视为真；空串视为真（行首判定用：光标之前只有空白） */
export function isAllBlank(text: string): boolean {
  return ALL_BLANK_RE.test(text);
}

/**
 * 字符类由各段**码位区间**拼出（与 `kojo-sugar` 的 `identifier-chars.ts` 同口径）：
 * 转义写法在编辑往返里极易错位，码位区间只有一处真相。
 *
 * B1 起**标识符字符集搬进语言面库**（`@kojo/kojo-lang` 的 `name-chars`）：它同时是
 * `kojo2-declarations` 切声明名的判据，而语言面库不能反过来 import 宿主。
 * 本模块只保留"行内位置"这一层（空白 / 字符串 / 注释 / 插值 / 名字段 / 关键字锚），
 * `isNameChar` 与 `isCjk` 按原样 re-export，既有 15 个 import 点一字不改。
 */
import { NAME_CHAR_CLASS, isCjk, isNameChar } from '@kojo/kojo-lang/name-chars';
/**
 * B2 起**文本面判读**（插值 / 字符串与注释）也搬进语言面库：转定义、悬停、语义着色、
 * 调用层级四条腿都要问同一句"这一格是代码还是台词"，而它们正陆续搬进
 * `@kojo/plugin-kojo-lang`——包看不见宿主，判据必须先在包里。这里原样 re-export，
 * 既有 import 点一行不动（与 `isNameChar` 搬迁时同一条纪律）。
 */
import { insideInterpolation, insideStringOrComment } from '@kojo/kojo-lang/interpolation';

export { isCjk, isNameChar, insideInterpolation, insideStringOrComment };

/** 文档词补全的逐行切词器（字符类与 {@link isNameChar} 同源；`+` = 连续段，入口重置 `lastIndex`） */
const NAME_WORD_RE = new RegExp(`[${NAME_CHAR_CLASS}]+`, 'g');

/** 一行里的全部连续标识符段（供文档词索引；不判语义、不做长度过滤） */
export function nameWordsOf(line: string): string[] {
  NAME_WORD_RE.lastIndex = 0;
  const out: string[] = [];
  for (let m = NAME_WORD_RE.exec(line); m !== null; m = NAME_WORD_RE.exec(line)) {
    if (m[0].length > 0) out.push(m[0]);
  }
  return out;
}

/**
 * 光标是否落在行内**字符串 / 注释**里 —— 实现已搬 `@kojo/kojo-lang/interpolation`
 * （见本文件头注的 import 段），此处不保留第二份。
 */

/** 光标是否在 `{ … }` 插值内 —— 实现已搬 `@kojo/kojo-lang/interpolation`。 */

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
const NAME_TERMINATOR_RE = new RegExp(`[(),;${String.fromCharCode(0xff0c)}${BLANK_CLASS_STR}]`);

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

/* ============================== 关键字锚（「行首关键字 + 空白」的**唯一**装配器） ============================== */

/** 词表关键字 id（`SugarLexiconWord['id']` 的原样别名；本模块只按 id 筛词形，不认识任何词） */
export type KojoKeywordId = SugarLexiconWord['id'];

/** 词形转正则片段（转义正则元字符——词形是作者字节，不受我们管） */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 关键字 id → 词形（去重、**长词在前**）。
 *
 * 词形一律取自 `kojo-sugar` 的 `SUGAR_LEXICON_WORDS`（单一真源，转译器改名即跟改）：宿主层
 * 手抄中文词形是 `kojo-lexicon-single-source` 守卫明令的红，且抄本必发散。长词在前是必需的
 * ——正则交替若短词在前会被前缀遮蔽（`是` 抢在 `是否` 那一位之前）。
 */
export function kojoKeywordWords(ids: readonly KojoKeywordId[]): string[] {
  const wanted = new Set<string>(ids);
  return [...new Set(SUGAR_LEXICON_WORDS.filter((w) => wanted.has(w.id)).map((w) => w.word))].sort(
    (a, b) => b.length - a.length,
  );
}

/**
 * 「行首空白 + 关键字 + 至少一个空白」的**锚定**前缀式（唯一一份装配器）。
 *
 * 口径：空白类走 {@link BLANK_CLASS_STR}（与转译器 lexer 逐字一致，含全角空格）；`i` = 英文
 * 隐藏别名与大小写写法都算同一条构造（规范 §4.1 约束的是**候选展示**，不是槽位判定）。
 * 词表被改空 ⇒ `/(?!)/`（该路永不命中，**不猜任何默认词**）。
 */
export function kojoKeywordAnchor(ids: readonly KojoKeywordId[]): RegExp {
  const words = kojoKeywordWords(ids);
  if (words.length === 0) return /(?!)/;
  return new RegExp(
    `^[${BLANK_CLASS_STR}]*(?:${words.map(escapeRegExp).join('|')})[${BLANK_CLASS_STR}]+`,
    'i',
  );
}

/** 时机块头锚（`block.timing`）——分野槽（KC-2）与编号槽（KC-3）**共用同一条**，不再各拼一份 */
export const TIMING_ANCHOR: RegExp = kojoKeywordAnchor(['block.timing']);
/** 分支头 `是 <值…>` 锚（`block.is`；`is` 后须有空白——`issue` 这类词不认） */
export const CASE_ANCHOR: RegExp = kojoKeywordAnchor(['block.is']);

/** 分野名令牌的终止符：空白 / 全角冒号 / 半角冒号（与 `kojo-sugar` 的 `parseTimingHead` 同向） */
const FACE_TOKEN_END_RE = /[\s：:]/;

/** 时机块头里**分野名段**的段界（0 基、左含右不含；`face` = 段文本） */
export interface TimingHeadParts {
  readonly faceStart: number;
  readonly faceEnd: number;
  readonly face: string;
}

/**
 * 行首 `时机 <分野>` 的**分野段段界**（锚 + 第一个空白/冒号为止）；非块头 ⇒ `null`。
 *
 * 此前 `kojo-face` 与 `kojo-index` 各算一遍同一段界（两条 `FACE_TOKEN_END_RE` + 同一条锚），
 * 收在这里一份：候选源算替换区间要用它，「上下文主动触发」判"这是不是名字位"也要它。
 */
export function timingHeadParts(line: string): TimingHeadParts | null {
  const head = TIMING_ANCHOR.exec(line);
  if (head === null) return null;
  const faceStart = head[0].length;
  let faceEnd = faceStart;
  while (faceEnd < line.length && !FACE_TOKEN_END_RE.test(line[faceEnd]!)) faceEnd++;
  return { faceStart, faceEnd, face: line.slice(faceStart, faceEnd) };
}

/**
 * **关键字锚之后**的名字槽（`column` = 1 基列；锚由调用方给 {@link kojoKeywordAnchor} 的产物）。
 *
 * 只做两件事：算锚右界 → 交给 {@link nameFieldAfter} 收槽。锚不命中 / 光标越出槽 ⇒ `null`。
 * 于是"行首关键字 + 名字位"这条判据在 `.kojo` 只有一份实现（`kojo-functions` 与主动触发共用）。
 */
export function nameSlotAfterAnchor(
  line: string,
  column: number,
  anchor: RegExp,
): KojoNameField | null {
  if (!Number.isFinite(column) || column < 1) return null;
  const col0 = Math.min(column - 1, line.length);
  const head = anchor.exec(line);
  if (head === null) return null;
  return nameFieldAfter(line, col0, head[0].length);
}

/** 列 → 0 基下标（夹进线内；非法列 ⇒ `null`，判据一律落空而不抛） */
export function col0Of(line: string, column: number): number | null {
  if (!Number.isFinite(column) || column < 1) return null;
  return Math.min(column - 1, line.length);
}
