import type * as Monaco from './entry';
import type { KojoLibraryTable } from '@kojo/plugin-api';

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
 */

/**
 * 标识符字符集（与 `kojo-sugar` 的 `identifier-chars.ts` 同口径：ASCII 字母 / 数字 / 下划线 +
 * CJK（假名 / 汉字 / 扩展 A）+ 全角拉丁；`$` 只作后续字符）。sugar 那份类表未对外导出，
 * 故 app 层按既有纪律自持一份（同 `kojo-completion-variables.ts` 的名字字符集）。
 */
const NAME_CHAR_RE = /[0-9A-Za-z_$\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uFF21-\uFF3A\uFF41-\uFF5A]/;
/** CJK 判定（含扩展 A / 假名）；CJK-primary 过滤用 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

function isNameChar(ch: string): boolean {
  return NAME_CHAR_RE.test(ch);
}

/**
 * 光标是否落在行内**字符串 / 注释**里（与 `kojo-sugar` 的 `inlineCommentIndex` 同口径：
 * 引号配平后第一个 `;` 起至行尾）。字符串内 / 注释内不给候选。
 */
function insideStringOrComment(line: string, col0: number): boolean {
  let inString = false;
  const stop = Math.min(col0, line.length);
  for (let i = 0; i < stop; i++) {
    const ch = line[i]!;
    if (ch === '"') inString = !inString;
    else if (!inString && ch === ';') return true;
  }
  return inString;
}

/** 光标是否在 `{ … }` 插值内（向左找 `{`，途中遇 `}` 即已在插值外）——让位给 `kojo-variable` */
function insideInterpolation(line: string, col0: number): boolean {
  for (let i = col0 - 1; i >= 0; i--) {
    const ch = line[i]!;
    if (ch === '}') return false;
    if (ch === '{') return true;
  }
  return false;
}

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
  const left = col0 > 0 ? line[col0 - 1]! : undefined;
  const right = col0 < line.length ? line[col0]! : undefined;
  const onLeft = left !== undefined && isNameChar(left);
  const onRight = right !== undefined && isNameChar(right);
  if (!onLeft && !onRight) return [];

  let start = col0;
  let end = col0;
  while (start > 0 && isNameChar(line[start - 1]!)) start--;
  while (end < line.length && isNameChar(line[end]!)) end++;

  const prefix = line.slice(start, col0);
  const range: Monaco.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: start + 1,
    endColumn: end + 1,
  };
  const kind = monaco.languages.CompletionItemKind.Function;
  const all = [...enumerate()];
  const hasCjk = all.some((n) => CJK_RE.test(n));

  const out: Monaco.languages.CompletionItem[] = [];
  const seen = new Set<string>();
  all.forEach((name, idx) => {
    if (name.length === 0 || seen.has(name)) return;
    if (hasCjk && !CJK_RE.test(name)) return;
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
