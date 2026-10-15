import type * as Monaco from './entry';
import { SYSTEM_FUNCTION_REVERSE } from '@kojo/plugin-kojo-sugar';

/**
 * EC-5 · `.erb`（EraBasic）**系统函数名补全（英文名）**。
 *
 * 词表**单一真源**同 kojo 侧：`kojo-sugar` 的 `SYSTEM_FUNCTION_ALIASES`（中文名 → 英文名）。
 * 本模块只读其**反向派生** `SYSTEM_FUNCTION_REVERSE`（英文名 → 中文名）——与
 * `kojo-language.ts` 的 `SYSTEM_FUNCTION_WORDS`（中文名，插 `名字(`）**同源反向**：
 * 那边给 `.kojo` 插中文名，这边给 `.erb` 插英文名（`GETBIT(`）。本文件**不另抄英文名表**。
 *
 * 位置判据（**表达式 / 实参里可写函数名**的位置才产出；不满足一律 `[]`、绝不猜、绝不抛）：
 * 1. **注释行**：行首（含缩进）`;` 起头 = Emuera 整行注释 → `[]`；
 * 2. **字符串内**：光标前该行 `"` 计数为奇 = 光标落在字符串字面量里（含未闭合串端点）→ `[]`；
 * 3. **指令行首**：光标处的词**之前全是空白**（词即本行第一个 token）→ `[]`——该位是
 *    ERB 指令 / `@` 函数定义 / `$` 标签 / `#` 预处理的名字位，不是实参位（`GETBIT` 亦属
 *    指令，行首形态是语句而非表达式）；
 * 4. **非法位置**：`lineNumber` / `column` 非有限或 `< 1` → `[]`。
 *
 * 命中时的候选形态：`label` = **英文名**（`GETBIT`），`insertText` = 调用形态 `名字(`
 * （作者接着补实参），`kind` = `Function`，`documentation` = `**英文名** ↔ 中文名`
 * （同源对照，作者一眼看得懂），替换范围 = `getWordUntilPosition`，`sortText` 前缀精确优先。
 *
 * 纯函数 + 薄 Monaco 翻译（与 `kojo-hover.ts` / `kojo-completion-faces.ts` 同纪律）：
 * 只读模型、不产生编辑、不发事件；provider 注册不在本模块——编排层把它接进补全基座。
 */
export function erbSystemFunctionCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): Monaco.languages.CompletionItem[] {
  if (!model || !position) return [];
  if (!Number.isFinite(position.lineNumber) || position.lineNumber < 1) return [];
  if (!Number.isFinite(position.column) || position.column < 1) return [];

  const line = model.getLineContent(position.lineNumber);
  const col0 = Math.min(position.column - 1, line.length);

  // 1) 行首 `;` 整行注释
  if (/^\s*;/.test(line)) return [];

  // 2) 光标前未闭合的 `"` → 落在字符串字面量里
  let quotes = 0;
  for (let i = 0; i < col0; i++) {
    if (line[i] === '"') quotes++;
  }
  if (quotes % 2 === 1) return [];

  const word = model.getWordUntilPosition(position);
  // 3) 词前全是空白 → 行首指令位（`@` / `$` / `#` / 指令名），不是实参位
  if (/^[ \t]*$/.test(line.slice(0, word.startColumn - 1))) return [];

  const range: Monaco.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn,
  };
  // ERB 命令大小写不敏感：前缀按大写比较（输入 `get` 亦命中 `GETBIT`）
  const prefix = word.word.toUpperCase();

  const items: Monaco.languages.CompletionItem[] = [];
  for (const [name, cn] of SYSTEM_FUNCTION_REVERSE) {
    const exact = prefix.length > 0 && name === prefix;
    const hit = prefix.length > 0 && name.startsWith(prefix);
    items.push({
      label: name,
      kind: monaco.languages.CompletionItemKind.Function,
      insertText: `${name}(`,
      detail: '系统函数',
      documentation: `**${name}** ↔ ${cn}`,
      range,
      sortText: `${exact ? '0' : hit ? '1' : '2'}_${name}`,
    });
  }
  return items;
}
