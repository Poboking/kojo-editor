import type * as Monaco from './entry';
import { BUILTIN_FUNCTION_NAMES, builtinSignatureLabel } from '@kojo/plugin-erb-parser';
import { SYSTEM_FUNCTION_REVERSE } from '@kojo/kojo-vocab/system-functions';
import { isAllBlank } from './kojo-completion-position';

/**
 * 系统函数候选的 documentation 头段：**中文别名（糖层，若有）+ 引擎签名（exmeth 静态表）**。
 *
 * provide 阶段（本模块）与 C-2 二次详情阶段（`erb-completion.ts` 的
 * `systemFunctionDetail`）共用这一支——两处各写一遍就是第二判据，漂移的表现是
 * 「列表里看到的和详情页看到的不一样」。
 */
export function systemFunctionDocumentation(name: string): string {
  const label = builtinSignatureLabel(name) ?? name;
  const cn = SYSTEM_FUNCTION_REVERSE.get(name);
  const head = cn === undefined ? `**${name}**` : `**${name}** ↔ ${cn}`;
  return label === name ? head : `${head}\n\n${label}`;
}

/**
 * EC-5 · `.erb`（EraBasic）**内建式中函数名补全（英文名）**。
 *
 * 词表真源 = `@kojo/plugin-erb-parser` 的 `BUILTIN_FUNCTION_NAMES`（Emuera `exmeth`
 * 静态签名表 170 名：154 个 wiki 载明签名 + 16 个分支扩展名，与实参个数/类型诊断
 * 同一张表）。`documentation` 合成两段：糖层中文别名（`kojo-sugar` 的
 * `SYSTEM_FUNCTION_REVERSE`，查得到才挂，78 名覆盖）+ 引擎签名——`.kojo` 侧糖语言的
 * 中文函数名补全仍走 kojo-sugar 正表，两张表服务两门语言，不是同一概念的双源。
 *
 * 位置判据（**表达式 / 实参里可写函数名**的位置才产出；不满足一律 `[]`、绝不猜、绝不抛）：
 * 1. **注释行**：行首（含缩进）`;` 起头 = Emuera 整行注释 → `[]`；
 * 2. **字符串内**：光标前该行 `"` 计数为奇 = 光标落在字符串字面量里（含未闭合串端点）→ `[]`；
 * 3. **指令行首**：光标处的词**之前全是空白**（词即本行第一个 token）→ `[]`——该位是
 *    ERB 指令 / `@` 函数定义 / `#` 预处理的名字位，不是实参位（`GETBIT` 亦属
 *    指令，行首形态是语句而非表达式）；空白口径**单源** `kojo-completion-position`
 *    的 `isAllBlank`（`\t` / 半角空格 / U+3000 全角空格，与 lexer 同集）；
 * 4. **`$` 紧前**：光标处词的**紧前一枚字符**是 `$` → `[]`——该位是 `$标签` 的名字位
 *    （行首 `$GET|` 即此形态）；行中 `GOTO $GET|` 由装配层白名单门收口，本模块只做
 *    本源防守；
 * 5. **非法位置**：`lineNumber` / `column` 非有限或 `< 1` → `[]`。
 *
 * 命中时的候选形态：`label` = **英文名**（`GETBIT`），`insertText` = 调用形态 `名字(`
 * （作者接着补实参），`kind` = `Function`，`documentation` = 中文别名（糖层，若有）
 * + 引擎签名（`GETBIT(int, int) → int`，wiki 未载明签名的只给名字），`detail` =
 * `系统函数`，替换范围 = `getWordUntilPosition`，`sortText` 前缀精确优先。
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
  // 3) 词前全是空白 → 行首指令位（`@` / `#` / 指令名）；空白口径单源 isAllBlank（含 U+3000）
  if (isAllBlank(line.slice(0, word.startColumn - 1))) return [];
  // 4) 词紧前是 '$' → `$标签` 名字位（本源防守；行中形态由装配层门收口）
  if (word.startColumn >= 2 && line[word.startColumn - 2] === '$') return [];

  const range: Monaco.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn,
  };
  // ERB 命令大小写不敏感：前缀按大写比较（输入 `get` 亦命中 `GETBIT`）
  const prefix = word.word.toUpperCase();

  const items: Monaco.languages.CompletionItem[] = [];
  for (const name of BUILTIN_FUNCTION_NAMES) {
    const exact = prefix.length > 0 && name === prefix;
    const hit = prefix.length > 0 && name.startsWith(prefix);
    items.push({
      label: name,
      kind: monaco.languages.CompletionItemKind.Function,
      insertText: `${name}(`,
      detail: '系统函数',
      documentation: systemFunctionDocumentation(name),
      range,
      sortText: `${exact ? '0' : hit ? '1' : '2'}_${name}`,
    });
  }
  return items;
}
