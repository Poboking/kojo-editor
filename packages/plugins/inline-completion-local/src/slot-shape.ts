import { erbCodeBodyOf, erbCodePrefixLength, isErbCommentLine } from '@kojo/plugin-api';

/**
 * 名字槽判定（**供方的语言知识**，契约明写宿主不切词）。
 *
 * 三条形状各配一条"这个位置几乎不可能是在写别的东西"的结构判据；判据全部只看**行首那一段**，
 * 因此不需要整篇文本、不需要代码视野（字符串/注释刷白），也不需要 adapter 的任何事实。
 *
 * ## 列坐标口径
 *
 * 出入参一律 **0 基码元下标**（`start` 含、`end` 不含），换算成契约的 1 基列在 `provider.ts`
 * 一处完成。行原文按 `prefix + suffix` 重组（两者逐字是"光标把当前行切成的两段原始字面"），
 * 所以本模块**从不**再读 `lineText`——两处取行必然出现"光标下标与行内容不是同一次采样"。
 *
 * ## 边界词表为什么写在这里而不是从契约取
 *
 * 名字槽的结束判据（`( , 空格 制表 ;`）与 `erb-parser/scanner.ts::parseFunctionDefinition`
 * 逐字同一套。两处各写一遍就是本仓最贵的那类债（漂移的表现：幽灵文本吃掉或漏掉尾巴），
 * 但解析器没有、也不该为本包导出这张表（插件之间禁止交叉 import）。**已上报**组长：
 * 与 `;!;` 那条同法——把边界判据提到 `plugin-api`（先例 `erb-code-prefix.ts`），
 * 两侧共读一份。在那之前，这里是最小复写 + 逐字注明出处。
 */

/** 三条形状各自查哪份名录（口径与 `catalog.ts` 的两个目录一一对应） */
export type SlotCatalog = 'functions' | 'declared';

/** 一个被认出来的名字槽 */
export interface ErbNameSlot {
  readonly shape: 'definition' | 'call' | 'declaration';
  /** 名字槽起点（整行 0 基码元下标，含） */
  readonly start: number;
  /** 名字槽终点（整行 0 基码元下标，不含；`end === start` = 槽还空着） */
  readonly end: number;
  /** 槽里**已经打出来**的字面（光标左侧那一段；可能为空串 = 作者还没打字） */
  readonly typed: string;
  readonly catalog: SlotCatalog;
}

/**
 * 名字槽的**结束**判据：命中其一即名字到此为止。
 * 出处：`erb-parser/scanner.ts::parseFunctionDefinition` 的五个 delimiter，逐字同一套，
 * 不许多不许少（多一个 = 少补一截；少一个 = 吃掉后面的实参）。
 * `\r\n` 与全角 `；`／`，` 是本包补的**安全侧**：它们绝不出现在解析器认的名字里，
 * 把它们也判成结束只会让槽更短，不会让幽灵文本盖到别的记号上。
 *
 * ⚠ 导出名带 `_FOR_TEST` 是有意的（不是手滑）：**运行期只被本文件用**，导出只为那枚对拍闸
 * `tests/terminator-single-source.test.ts` 能把这张表与解析器那侧逐字符比一次。不导出的话，
 * "两处各写一遍"就只剩注释在守着；导出不带标记又会被当成公开面被别处消费。
 * 真正的长期解（提到 `plugin-api` 共读）欠在组长的台账上，理由写在那枚测试的头注里。
 */
export const NAME_TERMINATORS_FOR_TEST: ReadonlySet<string> = new Set([
  '(',
  ',',
  ' ',
  '\t',
  ';',
  '\r',
  '\n',
  '；',
  '，',
]);

/** `CALL` 直系族之后必须至少一格空白才叫关键字结束（粘连形 `CALLFORM` 之类一律不认） */
const SPACE_CHARS: ReadonlySet<string> = new Set([' ', '\t', '　']);

/**
 * 之后那一位是**按名调用目标**的语句词。
 *
 * 这三枚是引擎（EraBasic）词汇，不是任何一部游戏的词汇——审计 D 项拦的是后者；同一口径的
 * 先例：`erb-parser/src/arity.ts` 头注「只认 `CALL` / `TRYCALL` / `TRYCCALL` 三种按名带
 * 实参的调用面」。据此**刻意不收**：
 * - `TRYCALLLIST` / `TRYGOTOLIST` 族：后面是**名字清单**（逗号分隔多槽），本包只服务首槽，
 *   认下整行等于承诺一个并不存在的切词能力；
 * - `CALLFORM` / `FORM`：后面是字符串拼接式，名字在引号里，不是裸标识符槽；
 * - `GOTO` / `JUMP`：目标是标签，见回执"没做的形状"。
 */
const CALL_NAME_SLOT_WORDS: ReadonlySet<string> = new Set(['CALL', 'TRYCALL', 'TRYCCALL']);

/** 取串首 `[A-Za-z_]+` 的长度（与 `erb-parser/references.ts` 的 `leadLen` 同一把尺） */
function leadingAsciiWordLength(text: string): number {
  let len = 0;
  while (len < text.length) {
    const c = text.charCodeAt(len);
    const isAlpha = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
    if (!isAlpha) break;
    len++;
  }
  return len;
}

/** 从 `from` 起把名字槽读到终点（不新增"什么算名字字符"的判据：只认结束集） */
function slotEndOf(text: string, from: number): number {
  let i = from;
  while (i < text.length && !NAME_TERMINATORS_FOR_TEST.has(text[i]!)) i++;
  return i;
}

/** 跳过 `from` 起的空白 */
function skipSpaces(text: string, from: number): number {
  let i = from;
  while (i < text.length && SPACE_CHARS.has(text[i]!)) i++;
  return i;
}

/** `@` 之后的第一个非空白下标；整段空白 → -1（与解析器的 `firstNonSpace` 同判据） */
function firstNonSpace(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (!SPACE_CHARS.has(text[i]!)) return i;
  }
  return -1;
}

/** 组装一个槽（坐标从"段内"映回"整行"） */
function makeSlot(
  shape: ErbNameSlot['shape'],
  catalog: SlotCatalog,
  base: number,
  start: number,
  end: number,
  typed: string,
): ErbNameSlot {
  return { shape, start: base + start, end: base + end, typed, catalog };
}

/**
 * 在 `scanned` 那段里从 `start` 起量出名字槽，并把光标位置对上去。
 *
 * **光标越过槽尾 ⇒ 这一格不再服务**（返回 `null`，而不是把区间收窄到槽尾）：
 * `@AB C` 里光标停在 `C` 上时，作者已经不在写那枚名字了，此时把 `AB` 的整段区间报上去
 * 等于"在我脚下的另一格上出字"。宁可不出，不给出不在光标处的补全。
 */
function slotIn(
  shape: ErbNameSlot['shape'],
  catalog: SlotCatalog,
  scanned: string,
  base: number,
  start: number,
  col: number,
): ErbNameSlot | null {
  const end = slotEndOf(scanned, start);
  if (col > end) return null;
  return makeSlot(shape, catalog, base, start, end, scanned.slice(start, col));
}

/**
 * 光标落在哪一条名字槽上？不是任何一条 → `null`（= 这个位置我不服务，供方弃权）。
 *
 * `directives` = 本项目实际用过的 `#DIM` 族指令名（大写集合，来自索引派生）。集合为空
 * （还没索引 / 项目里没有声明）时声明位自然不成立——**不硬编码词表**的代价与收益都在这里：
 * 代价是这一形状在未开项目时不工作（那种情形本就该 `failed`），收益是解析器扩族时本包零改动。
 */
export function erbNameSlotAt(
  prefix: string,
  suffix: string,
  directives: ReadonlySet<string>,
): ErbNameSlot | null {
  const line = prefix + suffix;
  const cursor = prefix.length;
  if (!Number.isFinite(cursor) || cursor < 0 || cursor > line.length) return null;
  // 单行判据：请求里那两段里出现换行 = 光标不在"一行之内"的常规形态（粘行 / 多选区），
  // 本包的三条形状全按单行算，读不懂就不猜。
  if (/[\r\n]/.test(line)) return null;

  const indentLength = line.length - line.trimStart().length;
  const afterIndent = line.slice(indentLength);
  const codePrefixLength = erbCodePrefixLength(afterIndent);
  const base = indentLength + codePrefixLength;
  // 光标还在缩进或代码前缀里（没进到内容）：不判位
  if (cursor < base) return null;
  const body = erbCodeBodyOf(afterIndent);
  const col = cursor - base;
  if (body.length === 0 || isErbCommentLine(body)) return null;

  // —— 形状①：行首 `@` 定义位 ——
  if (body.startsWith('@')) {
    const afterAt = body.slice(1);
    const nameStart = firstNonSpace(afterAt);
    if (nameStart < 0) return null;
    if (afterAt[nameStart] === '"') return null; // `@"…"` 是 FORM 续行，不是定义（解析器同判据）
    const start = 1 + nameStart;
    if (col < start) return null; // 光标还在 `@` 与其后空白之间
    return slotIn('definition', 'functions', body, base, start, col);
  }

  // —— 形状②：行首 CALL 直系族的调用位 ——
  const leadLength = leadingAsciiWordLength(body);
  if (leadLength > 0 && CALL_NAME_SLOT_WORDS.has(body.slice(0, leadLength).toUpperCase())) {
    const next = body[leadLength];
    if (next !== undefined && !SPACE_CHARS.has(next)) return null; // 粘连（词表按整词判，这里兜一次）
    const start = skipSpaces(body, leadLength);
    if (col < start) return null;
    return slotIn('call', 'functions', body, base, start, col);
  }

  // —— 形状③：`#<声明指令>` 之后的声明名位 ——
  if (body.startsWith('#')) {
    const afterHash = body.slice(1);
    // `#` 占一格：段内坐标系（`afterHash`）里光标要先减那一格，否则整条形状向右错一位
    const hashCol = col - 1;
    if (hashCol < 0) return null;
    const wordLength = leadingAsciiWordLength(afterHash);
    if (wordLength === 0) return null;
    if (!directives.has(afterHash.slice(0, wordLength).toUpperCase())) return null;
    const start = skipSpaces(afterHash, wordLength);
    if (hashCol < start) return null;
    // `#DIM` 行里逗号之后的那一段是**数组维度/初值**，不是第二个名字
    // （契约 `ErbDim` 头注：基线语料 1,774 条带顶层逗号的声明里没有一个多变量形），
    // 而 `slotEndOf` 的结束集里就有 `,` ⇒ 天然只服务首槽。
    return slotIn('declaration', 'declared', afterHash, base + 1, start, hashCol);
  }

  return null;
}
