import type * as Monaco from './entry';
import type { KojoLibraryTable } from '@kojo/plugin-api';
import { identifierFieldAt, insideInterpolation, insideStringOrComment, isCjk } from './kojo-completion-position';

/**
 * KC-4 · `.kojo` 中文**库函数名**的正向补全（`libraryCompletionItems`）。
 *
 * 落点：表达式 / 正文的**标识符位置**（字符串内 / 注释内 / `{ … }` 插值内不给——插值里那一处
 * 是 `kojo-variable` 的地盘）。名字来源 = `table.names?.()`（KC-4 新增的**可选**枚举能力；
 * 未提供 ⇒ 零候选，降级信号由装配层的 `requires: 'libraryTable'` 发，本模块不另造一套）。
 *
 * 糖层消费形态是**调用形**（`名字(` → 原生 ERB 名，见 `lowerSystemFunctions`）⇒ `insertText`
 * 带左括号；`detail` 的原生名一律回 `lookupByName` 取（**只用表、不猜**；枚举有而正查无 =
 * 表自相矛盾，该名直接跳过）。
 *
 * 纯函数：只读模型、不产生编辑、不写盘、不发事件；位置不符 / 表缺省 / 枚举能力缺席一律 `[]`，
 * 绝不抛。Monaco provider 注册刻意不在此处——编排层（`kojo-completion.ts`）负责接进补全基座。
 *
 * COMPL-SHARED：字符集 / 字符串注释 / 插值 / 标识符段四件位置判据一律吃
 * `kojo-completion-position.ts` 那一份（与项目函数名同一路），本模块不再自持一份。
 */

/**
 * 产出中文库函数名候选（**纯函数**，供补全基座调用）。
 *
 * 行为：光标落在标识符上（左右至少一侧是标识符字符）⇒ 光标所处标识符段为替换范围，
 * `kind` = `Function`，`insertText` = `名字(`（调用形），`detail` = `库函数 → 原生名`，
 * 前缀过滤 / 排序（`names()` 返回序）与 CJK-primary（表里有中文名 ⇒ 纯 ASCII 名视作隐藏
 * 兼容别名，不进面板，同 `kojo-face` 的 `valueSetOf` 口径）照既有 source 打法。
 */
export function libraryCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  table: KojoLibraryTable | undefined,
): Monaco.languages.CompletionItem[] {
  if (!model || !position) return [];
  if (!Number.isFinite(position.lineNumber) || position.lineNumber < 1) return [];
  if (!Number.isFinite(position.column) || position.column < 1) return [];
  // fail-closed：表缺席 / 空表 / 未提供枚举能力 ⇒ 零候选（降级信号由 `requires` 机制发）。
  if (!table || table.hasTable === false) return [];
  const enumerate = table.names;
  if (typeof enumerate !== 'function') return [];

  const line = model.getLineContent(position.lineNumber);
  const col0 = position.column - 1;
  if (col0 > line.length) return [];
  if (insideStringOrComment(line, col0)) return [];
  if (insideInterpolation(line, col0)) return [];

  // 标识符位置：光标须贴在标识符字符上（左或右），否则不是可补全的名字位（不猜）。
  const field = identifierFieldAt(line, col0);
  if (field === null) return [];
  const { start, end, prefix } = field;

  const range: Monaco.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: start + 1,
    endColumn: end + 1,
  };
  const kind = monaco.languages.CompletionItemKind.Function;
  const all = [...enumerate()];
  const hasCjk = all.some((n) => isCjk(n));

  const out: Monaco.languages.CompletionItem[] = [];
  const seen = new Set<string>();
  all.forEach((name, idx) => {
    if (name.length === 0 || seen.has(name)) return;
    if (hasCjk && !isCjk(name)) return;
    if (prefix.length > 0 && !name.startsWith(prefix)) return;
    const native = table.lookupByName(name);
    if (native === undefined) return; // 枚举里有、正查无 = 表自相矛盾 ⇒ 不猜，跳过
    seen.add(name);
    out.push({
      label: name,
      kind,
      insertText: `${name}(`,
      filterText: name,
      detail: `库函数 → ${native}`,
      range,
      sortText: `${String(idx).padStart(3, '0')}_${name}`,
    });
  });
  return out;
}
