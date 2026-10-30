/**
 * ERB **变量族头**补全的判据（`@kojo/erb-lang/completion-families`）。
 *
 * ## 这一格回答什么
 *
 * 光标落在一个**裸标识符名位**上时，别名族头（写一段前缀等引擎族全名）。
 * 判据两件：①"这是不是一个裸标识符名位"（{@link erbDeclaredNameSlot}，与 `#DIM` 声明名
 * 源共用同一份扫描）；②"这张族表里哪些以已输入前缀起头"（大小写不敏感，展示保留原形）。
 *
 * ## 为什么在语言面库
 *
 * 族表是 `@kojo/kojo-vocab/engine` 的 `ENGINE_VARIABLE_FAMILIES`（跨游戏的语言事实）；
 * 名字位扫描是 ERB 的词法。"哪些位置算名字位、前缀怎么比"与哪部游戏无关，而 `#DIM`
 * 声明名源要用同一份判据——两份扫描必然漂移（漂移的表现是"族头补得上、声明名补不上"）。
 *
 * ## 形状
 *
 * 交回**中性候选**（`ErbCompletionItem`）：`label` / `insertText` / `filterText` = 族名，
 * **不插冒号**（冒号在触发链上补）；`kind` = `variable`；`detail` = `引擎族头`；
 * 替换范围只覆盖名字段；排序按**前缀精确优先**（`0_` / `1_` 档，与其它名位源同法）。
 * Monaco 条目的是宿主那一层（`app/src/monaco/erb-completion-families.ts`，只剩翻译）。
 */
import { ENGINE_VARIABLE_FAMILIES } from '@kojo/kojo-vocab/engine';
import { ERB_NAME_CHAR_CLASS } from '@kojo/kojo-lang/name-chars';
import type { ErbCompletionItem } from './completion-item';

/**
 * 名字字符集（**ERB 侧唯一一份**，与补全名字槽的 `NAME_CHAR_RE` 同源：都从
 * `@kojo/kojo-lang/name-chars` 的 `ERB_NAME_CHAR_CLASS` 派生）。
 * `$` **不在**集内（`$标签` 的 `$` 由 {@link ERB_SIGIL_BEFORE} 排除兜住，否则 `$CF`
 * 会被拼进段而漏网）；kojo 侧那份含 `$`（`实参$` 后缀）。
 */
const NAME_CHAR_RE = new RegExp(`[${ERB_NAME_CHAR_CLASS}]`);

/**
 * token 起点前一枚字符的**排除集**（防守；这些位置的归属主收口在装配层白名单）：
 * `#` / `[` = 预处理 / 区间标记记号，`@` = ERB 函数定义位，`$` = 标签，`%` = 表单串，
 * 引号 = 字符串字面量，`:` / `：` = `族:名` 段分隔（那里是变量名字位，不是族头位）。
 *
 * 导出：点号成员位判定要拒绝 `$标签.` / `@函数.` 这类**被 sigil 领起的 token**
 * （那是别的源的位），复用这一份排除集、不另抄第二份。
 */
export const ERB_SIGIL_BEFORE: ReadonlySet<string> = new Set(['#', '[', '@', '$', '%', '"', "'", '：', ':']);

/** 裸标识符名字位（0 基区间、左含右不含；`prefix` = 光标前已输入部分） */
export interface ErbNameSlot {
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
}

/** 1 基列 → 0 基列（越界夹进线内；非法列 ⇒ `null`，一切判据落空而不是抛） */
function col0Of(line: string, column: number): number | null {
  if (!Number.isFinite(column) || column < 1) return null;
  return Math.min(column - 1, line.length);
}

/**
 * 光标处的**裸标识符名位**（纯函数；`column` = Monaco 的 1 基列）。
 *
 * 口径：左右**至少一侧**是名字字符才算（行尾 / 空白空插入点 ⇒ `null`），
 * 区间 = 光标处连续名字字符段的完整跨度。例外：token 起点前一枚字符 ∈
 * {@link ERB_SIGIL_BEFORE} ⇒ `null`。
 */
export function erbDeclaredNameSlot(line: string, column: number): ErbNameSlot | null {
  const col0 = col0Of(line, column);
  if (col0 === null) return null;
  const left = col0 > 0 ? line[col0 - 1]! : undefined;
  const right = col0 < line.length ? line[col0]! : undefined;
  const onLeft = left !== undefined && NAME_CHAR_RE.test(left);
  const onRight = right !== undefined && NAME_CHAR_RE.test(right);
  if (!onLeft && !onRight) return null;
  let start = col0;
  let end = col0;
  while (start > 0 && NAME_CHAR_RE.test(line[start - 1]!)) start--;
  while (end < line.length && NAME_CHAR_RE.test(line[end]!)) end++;
  if (start > 0 && ERB_SIGIL_BEFORE.has(line[start - 1]!)) return null;
  return { start, end, prefix: line.slice(start, col0) };
}

/**
 * 产出族头候选（纯函数）。位置不符 / 前缀无任何族命中 ⇒ `[]`（不猜、不抛）。
 *
 * `lineNumber` 只用于把 0 基名字段换算成 1 基替换区间（调用方给的是光标所在行）。
 */
export function erbFamilyCandidates(line: string, column: number, lineNumber = 1): ErbCompletionItem[] {
  const slot = erbDeclaredNameSlot(line, column);
  if (slot === null) return [];
  const needle = slot.prefix.toUpperCase();
  const range = { line: lineNumber, startColumn: slot.start + 1, endColumn: slot.end + 1 };
  const items: ErbCompletionItem[] = [];
  for (const family of ENGINE_VARIABLE_FAMILIES) {
    const upper = family.toUpperCase();
    if (needle.length > 0 && !upper.startsWith(needle)) continue;
    const exact = needle.length > 0 && upper === needle;
    items.push({
      label: family,
      kind: 'variable',
      insertText: family,
      filterText: family,
      detail: '引擎族头',
      range,
      sortText: `${exact ? '0' : '1'}_${family}`,
    });
  }
  return items;
}