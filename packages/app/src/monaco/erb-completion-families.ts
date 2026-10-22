import type * as Monaco from './entry';
import { ENGINE_VARIABLE_FAMILIES } from '@kojo/plugin-kojo-sugar';
import { col0Of, lineAt } from './kojo-completion-position';

/**
 * ERB-FAMILY · `.erb` **变量族头补全**（`CF` → `CFLAG`；写 `:` 时由宿主的触发链弹族名）。
 *
 * 缺陷⑤前半：EC-2 的 `erb-completion-variables.ts` 只补 `族:` **之后**的名字，族头本身此前
 * 无源可补（作者打 `CF` 等不到 `CFLAG`）。真源 = `kojo-sugar` 的 `ENGINE_VARIABLE_FAMILIES`
 * （与 `erb-completion-variables.ts` 同一份 import，宿主零抄本）。
 *
 * 形态：`label` / `insertText` / `filterText` = 族名，**不插冒号**——冒号在触发链上补；
 * ERB 大小写不敏感（Emuera 全大写指令语境）：前缀与族名统一 `toUpperCase` 比较、
 * 展示保留原名（`cf|` 命中 `CFLAG`）。
 *
 * 名字位判据 = 共享的 {@link erbDeclaredNameSlot}（**签名定死**：同批 `#DIM` 声明名源
 * `erb-completion-declared.ts` 复用它，不另抄一份"裸标识符名位"扫描）。
 * 位置不符 / 桩 model 缺件（`getLineContent` 缺席）⇒ `[]`，**不猜、不抛**。
 */

/**
 * 名字字符集（正向定义；ASCII 词字符 + 假名 + 汉字 + 全角字母数字 + 半角片假名）——
 * 与 `erb-completion-functions.ts` 的 ERB 方言口径同集。`$` **不在**集内（`$标签` 的
 * `$` 由 {@link ERB_SIGIL_BEFORE} 排除兜住，否则 `$CF` 会被拼进段而漏网）。
 */
const NAME_CHAR_RE =
  /[0-9A-Za-z_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff10-\uff19\uff21-\uff3a\uff41-\uff5a\uff66-\uff9f]/;

/**
 * token 起点前一枚字符的**排除集**（防守；这些位置的归属主收口在装配层白名单）：
 * `#` / `[` = 预处理 / 区间标记记号，`@` = ERB 函数定义位，`$` = 标签，`%` = 表单串，
 * 引号 = 字符串字面量，`:` / `：` = `族:名` 段分隔（那里是 EC-2 的名字位，不是族头位）。
 *
 * 导出（additive）：`erb-completion-members.ts` 的点号成员位判定要拒绝 `$标签.` / `@函数.`
 * 这类**被 sigil 领起的 token**（那是别的源的位），复用这一份排除集、不另抄第二份。
 */
export const ERB_SIGIL_BEFORE: ReadonlySet<string> = new Set(['#', '[', '@', '$', '%', '"', "'", '：', ':']);

/** 裸标识符名字位（0 基区间、左含右不含；`prefix` = 光标前已输入部分；与 `KojoNameField` 同形） */
export interface ErbNameSlot {
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
}

/**
 * 光标处的**裸标识符名位**（共享判据，纯函数；`column` = Monaco 的 1 基列）。
 *
 * 口径与 `kojo-completion-position.identifierFieldAt` **同形**：左右**至少一侧**是名字字符
 * 才算（行尾 / 空白空插入点 ⇒ `null`），区间 = 光标处连续名字字符段的完整跨度。
 * 例外：token 起点前一枚字符 ∈ {@link ERB_SIGIL_BEFORE} ⇒ `null`。
 * 列越界夹进线内；非法列 ⇒ `null`（一切判据落空，而不是抛）。
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
 * 产出 `.erb` **族头**补全候选（纯函数，供补全基座调用）。
 *
 * 行为：仅当光标落在裸标识符名位（{@link erbDeclaredNameSlot}）时产出候选；
 * 候选 = `ENGINE_VARIABLE_FAMILIES` 全表按**大小写不敏感前缀**过滤（两串都 `toUpperCase`，
 * 展示保留族名原形），`kind` = Variable，`detail` = `引擎族头`，替换范围**只覆盖名字段**；
 * 排序受控（**前缀精确优先**，与 `erb-completion-variables.ts` 同法）。
 * 位置不符 / 前缀无任何族命中 ⇒ `[]`，不抛。
 */
export function erbFamilyCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): Monaco.languages.CompletionItem[] {
  const slot = erbDeclaredNameSlot(lineAt(model, position.lineNumber), position.column);
  if (slot === null) return [];
  const needle = slot.prefix.toUpperCase();
  const range: Monaco.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: slot.start + 1,
    endColumn: slot.end + 1,
  };
  const items: Monaco.languages.CompletionItem[] = [];
  for (const family of ENGINE_VARIABLE_FAMILIES) {
    const upper = family.toUpperCase();
    if (needle.length > 0 && !upper.startsWith(needle)) continue;
    const exact = needle.length > 0 && upper === needle;
    items.push({
      label: family,
      kind: monaco.languages.CompletionItemKind.Variable,
      insertText: family,
      filterText: family,
      detail: '引擎族头',
      range,
      sortText: `${exact ? '0' : '1'}_${family}`,
    });
  }
  return items;
}