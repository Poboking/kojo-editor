import { STATEMENT_FUNCTIONS, SUGAR_LEXICON_WORDS } from '@kojo/plugin-kojo-sugar';
import { classifyKojoLine } from './kojo-native-zone';
import {
  BLANK_CLASS_STR,
  col0Of,
  insideInterpolation,
  insideStringOrComment,
  isAllBlank,
  isBlank,
  kojoKeywordAnchor,
} from './kojo-completion-position';

/**
 * QSUG-1 · `.kojo` 快建议（`quickSuggestions`）的**代码位门**。
 *
 * `quickSuggestions` 全局打开后，Monaco 会在每次键入后调用 provider；`.erb` 有
 * `erbCompletionGate` 把字符串 / `;` 注释清零，而 `.kojo` 还多一类 Monaco 不认识的东西：
 * **台词 / 旁白行**。糖词法把它们分类为 `text` / `heartText`（`classifyLine` 的兜底分支），
 * 语义上是打印给玩家的正文，不是代码；在这些行里弹关键字 / 函数名 / 库函数是纯噪声。
 *
 * 判据分三层（顺序严格）：
 * 1. `comment` ⇒ 不供；
 * 2. `text` ⇒ **只放行三类代码位**：`{…}` 插值内（变量名）、行首正在输入**语句关键字**
 *    （`如` → `如果`、`调` → `调用`）、行首语句关键字 + 空白之后的参数/表达式位
 *    （`如果 好感度 |`、`调用 |`）——后两类用词表自身的锚，不手抄词形；
 * 3. `heartText` ⇒ 只放行 `{…}` 插值（心形行正文同样是台词）；
 * 4. 其余（`blank` / 头部声明 / 各类块头 / 赋值 / 原生直通行…）⇒ 代码位；
 *    其中真正的字符串 / `;` 注释仍按 `.kojo` 既有判据清零。
 *
 * **不能只看 `classifyLine`**：`.kojo` 的块头 / 调用行在**写完整之前**会落 `text`
 * （`如果 好` 还没有收尾冒号、`调用 ` 还没有函数名）——只看行类会把"正在敲关键字"
 * 这一最该补全的瞬间全部掐死。故 `text` 分支补了"语句关键字前缀 / 关键字锚"两条。
 *
 * 台词 / 旁白里出现 `{…}` 是合法插值，所以插值永远放行；注释行里的 `{}` 不视为代码。
 * 纯函数、零 IO；`column` 为 Monaco 的 1 基列，非法列一律判否（不猜）。
 */

/** 语句位置的关键字角色（`value` = 别名右值词，如 `等于`，不是行首语句） */
const STATEMENT_KEYWORD_IDS = SUGAR_LEXICON_WORDS.filter((w) => w.role !== 'value').map((w) => w.id);

/** 行首「语句关键字 + 空白」锚（词形 / 长词在前 / 英文别名全部来自词表单源） */
const STATEMENT_ANCHOR: RegExp = kojoKeywordAnchor(STATEMENT_KEYWORD_IDS);

/** 语句形中文函数（`设置标记 X, n`；表在 `kojo-sugar/statement-functions.ts`，不在此手抄词形） */
const STATEMENT_FUNCTION_WORDS: readonly string[] = [...STATEMENT_FUNCTIONS.keys()];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 行首「语句形函数 + 空白」锚（与关键字锚同款空白类；词形来自语句函数表） */
const STATEMENT_FUNCTION_ANCHOR = new RegExp(
  `^[${BLANK_CLASS_STR}]*(?:${STATEMENT_FUNCTION_WORDS.map(escapeRegExp).join('|')})[${BLANK_CLASS_STR}]+`,
);

/** 去重后的语句词形（关键字 + 语句函数；只用于"前缀是不是某个关键字的开头"） */
const STATEMENT_WORDS: readonly string[] = [
  ...new Set([
    ...SUGAR_LEXICON_WORDS.filter((w) => w.role !== 'value').map((w) => w.word),
    ...STATEMENT_FUNCTION_WORDS,
  ]),
];

/**
 * 光标正在写**本行第一个 token**，且这个前缀是某个语句关键字的开头。
 *
 * 只认"token 起点之前全是空白"（行首 token）；行中 token（`调用 名` 的名字段）由
 * {@link STATEMENT_ANCHOR} 那一层接住。空前缀（空行 / 行首刚按下第一个字）返回 true。
 */
function isTypingStatementKeyword(line: string, col0: number): boolean {
  let start = col0;
  while (start > 0) {
    const ch = line[start - 1]!;
    if (isBlank(ch) || ch === '：' || ch === ':') break;
    start--;
  }
  if (!isAllBlank(line.slice(0, start))) return false;
  if (start === col0) return true; // 行首 / 空行：块骨架与关键字全表都该在
  const prefix = line.slice(start, col0);
  return STATEMENT_WORDS.some((word) => word.startsWith(prefix));
}

/**
 * 光标处是否属于 `.kojo` 的**代码视野**（`quickSuggestions` / 手动补全共用）。
 * `false` = 本轮整轮零候选（台词 / 旁白 / 注释），provider 直接返回空列表。
 */
export function kojoCodePositionAt(line: string, column: number): boolean {
  const col0 = col0Of(line, column);
  if (col0 === null) return false;

  const cls = classifyKojoLine(line);
  if (cls.kind === 'comment') return false;

  if (cls.kind === 'heartText') {
    // 心形行：整行是台词，只有 `{…}` 插值算代码
    return insideInterpolation(line, col0);
  }

  if (cls.kind === 'text') {
    // 台词 / 旁白：插值放行；行首关键字前缀 / 关键字锚之后的参数位放行（见模块头注）
    if (insideInterpolation(line, col0)) return true;
    if (isTypingStatementKeyword(line, col0)) return true;
    return STATEMENT_ANCHOR.test(line) || STATEMENT_FUNCTION_ANCHOR.test(line);
  }

  // 其余行类都是代码位；真正的字符串 / 行注释仍按 `.kojo` 既有判据清零
  return !insideStringOrComment(line, col0);
}
