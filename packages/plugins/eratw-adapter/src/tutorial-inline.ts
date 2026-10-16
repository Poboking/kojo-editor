/**
 * 教程正文的行内标记解析（2026-10-16 TUT-1）：把 `**粗体**` 与反引号代码解析成
 * 节点树，由 `tutorial-overlay.ts` 渲染成 <strong> / <code>。
 *
 * 为什么自己写这一小段而不是引 Markdown 依赖：教程正文只用了这两种标记（198 个
 * 字段实测：45 段粗体 / 175 段代码，零未配平、零优先级冲突），完整 Markdown 解析器
 * 要处理链接 / 列表 / 表格一整套，还会对正文里的全角括号、星号做意外转换；这里
 * 需要的是一个行为可穷举的扫描器。
 *
 * 配对规则（宽松失败，宁缺勿乱）：
 * - 从左到右单遍扫描；反引号先于 `**` 判定（反引号里的 `**` 是字面文本），
 *   与常见 Markdown 的优先级一致；
 * - 标记找不到闭合就按字面文本走（`**` 未闭合时两个星号都原样保留），不抛错、
 *   不吞字符——内容写坏一个字，屏幕上只是多一个星号，不会整段消失；
 * - 粗体内部再解析一层行内代码（`` **`否则` 必须写** `` 这种包法按两相渲染）；
 * - 不做反斜杠转义：正文字符串里的 `\` 就是字面反斜杠（样例里有 `` `\` `` 这种码段，
 *   若把反斜杠当转义符，它的闭合反引号会被吃掉，整段错配）。
 */

export type TutorialInlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: TutorialInlineNode[] };

export function parseTutorialInline(src: string): TutorialInlineNode[] {
  const nodes: TutorialInlineNode[] = [];
  let text = '';
  let i = 0;
  const flushText = (): void => {
    if (text.length > 0) {
      nodes.push({ kind: 'text', text });
      text = '';
    }
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '`') {
      const close = src.indexOf('`', i + 1);
      if (close > i) {
        flushText();
        nodes.push({ kind: 'code', text: src.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    } else if (ch === '*' && src[i + 1] === '*') {
      const close = src.indexOf('**', i + 2);
      if (close > i) {
        flushText();
        nodes.push({ kind: 'strong', children: parseTutorialInline(src.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  flushText();
  return nodes;
}
