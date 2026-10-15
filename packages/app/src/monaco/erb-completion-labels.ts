import type * as Monaco from 'monaco-editor';

/**
 * EC-4 · `.erb` 的 `$标签` 补全 —— 写 `GOTO` / `JUMP` 之后，弹**本文件内**已定义的标签名。
 *
 * 口上没有模块系统：跳转只在同一文件内成立，故候选**只扫当前 model 全文**取 `^\s*\$名字`
 * 形式的定义，跨文件一律不做（不做索引、不做猜测）。
 *
 * 纯逻辑 + 薄翻译（与 `kojo-completion-variables.ts` 同纪律）：本模块**只**导出可单测的
 * 纯函数，不注册 provider（装配点由 ERB 补全基座负责，宿主层零改动）。
 * 位置不符 / 无标签定义 ⇒ 返回 `[]`，**不猜、不抛**。
 */

/** 跳转指令（取值当目标名）：`GOTO` 及其别名 `JUMP`（`TRYCGOTO` 等变体不在此列）。 */
const JUMP_KEYWORDS = ['GOTO', 'JUMP'] as const;

/** 标签定义扫描：行首（可含前导空白）`$名字`，名字止于空白 / `;`（与 `erb-language` 词法一致）。 */
const LABEL_DEF_RE = /^\s*\$([^\s;]+)/gm;

/**
 * 跳转上下文：光标**前文**以 `<分隔>(GOTO|JUMP)` + 空白 + 可选 `$` + 名字残片 收尾。
 * 分隔含行首 / 空白 / `;` / `:`（覆盖缩进行首与 `SIF … : GOTO …` 行内形态）；
 * 前缀字符非分隔 ⇒ `TRYCGOTO` 之类的复合词不误触。
 */
const JUMP_CONTEXT_RE = new RegExp(`(?:^|[\\s;:])(${JUMP_KEYWORDS.join('|')})[ \\t]+(\\$?)([^\\s;]*)$`);

/** 标签名字符：非空白、非 `;`（与定义扫描的正向口径对齐） */
const isLabelChar = (ch: string): boolean => !/[\s;]/.test(ch);

/** 全文扫描标签定义名（去重、保序） */
function definedLabels(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(LABEL_DEF_RE)) {
    const name = m[1];
    if (name !== undefined && name.length > 0 && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * 产出跳转指令（`GOTO` / `JUMP`）后**本文件内** `$标签` 名的补全候选（**纯函数**）。
 *
 * 行为：仅当光标前文以跳转指令 + 空白收尾时产出候选；候选来自当前 model 全文的标签定义
 * （去重保序）。`kind` = Reference，`insertText` = 名字（**不重复补 `$`**——作者已敲 `$` 则
 * 与 `$` 并存），`detail` = `标签（本文件）`；排序受控（前缀精确匹配优先），替换范围
 * **只覆盖标签名那一段**（含前导 `$` 时 `$` 留在范围外）。位置不符 / 无标签 / 前缀无命中
 * ⇒ 返回 `[]`，不抛。
 */
export function erbLabelCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): Monaco.languages.CompletionItem[] {
  const line = model.getLineContent(position.lineNumber);
  const col0 = Math.min(Math.max(position.column - 1, 0), line.length);
  const before = line.slice(0, col0);

  // 只在跳转上下文产出：其余位置一问即走，绝不猜。
  const ctx = JUMP_CONTEXT_RE.exec(before);
  if (ctx === null) return [];

  const labels = definedLabels(model.getValue());
  if (labels.length === 0) return [];

  const prefix = ctx[3] ?? '';
  const matched = prefix.length === 0 ? labels : labels.filter((name) => name.startsWith(prefix));
  if (matched.length === 0) return [];

  // 替换范围左界 = 名字段起点（已跳过可选 `$`）；右界向右吃满名字段。
  const start = col0 - prefix.length;
  let end = col0;
  while (end < line.length && isLabelChar(line[end]!)) end++;

  const range: Monaco.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: start + 1,
    endColumn: end + 1,
  };

  return matched.map((name) => ({
    label: name,
    kind: monaco.languages.CompletionItemKind.Reference,
    insertText: name,
    detail: '标签（本文件）',
    range,
    sortText: `${prefix.length > 0 && name === prefix ? '0' : '1'}_${name}`,
  }));
}
