import type * as Monaco from './entry';
import type { ErbCompletionSource } from './erb-completion';
import { isLineHeadContext } from './erb-completion';

/**
 * `.erb` 补全 · **Snippet 块骨架源**（R4）：ERB 控制流块是**成对闭合**的
 * （IF/ENDIF、SELECTCASE/ENDSELECT、WHILE/WEND、FOR/NEXT）——漏一个闭合就是
 * 引擎加载失败，把整副骨架收成一条 snippet 候选（`InsertAsSnippet`）。
 *
 * 骨架**不带缩进**：ERB 原文语料口径不缩进（缩进折叠在原文上几乎无效），插出
 * 缩进反而制造与周边行的 diff 噪声。`.kojo` 侧的糖块骨架（4 空格缩进）在
 * `kojo-completion-snippets.ts`，两边口径各自贴合语料、互不复制。
 *
 * **不重复出条目**：本 source 注册在 `ERB_COMPLETION_SOURCES` **最前**，且只在
 * **行首**给骨架（复用 `isLineHeadContext`）——行首时与 `erb-directives` 的同名
 * 纯文本项按 label 去重（先注册者胜）只留骨架；行中关键字纯文本照旧。
 * `IF` 之外另设 `IF-ELSE` 完整骨架：label 不同不互斥，输入 `IF` 前缀两者都命中
 * （精确档在前）。
 */
export const ERB_SNIPPET_SOURCE: ErbCompletionSource = {
  id: 'erb-snippet',
  provide({ monaco, model, position, range }): Monaco.languages.CompletionItem[] {
    if (!isLineHeadContext(model, position)) return [];
    // 常量对象防御性读取（测试桩 / 旧运行时可能不挂 `CompletionItemInsertTextRule`）
    const kind = monaco.languages.CompletionItemKind.Snippet;
    const rule = monaco.languages.CompletionItemInsertTextRule?.InsertAsSnippet;
    const spec: readonly { label: string; insertText: string; detail: string }[] = [
      { label: 'IF', insertText: 'IF ${1:条件}\n$2\nENDIF$0', detail: '条件块骨架' },
      { label: 'IF-ELSE', insertText: 'IF ${1:条件}\n$2\nELSE\n$3\nENDIF$0', detail: '条件块骨架：含 ELSE' },
      { label: 'ELSEIF', insertText: 'ELSEIF ${1:条件}', detail: '否则如果分支' },
      { label: 'ELSE', insertText: 'ELSE', detail: '否则分支' },
      { label: 'SIF', insertText: 'SIF ${1:条件}\n$0', detail: '单行条件骨架：只守护下一行' },
      { label: 'WHILE', insertText: 'WHILE ${1:条件}\n$2\nWEND$0', detail: '循环块骨架' },
      { label: 'FOR', insertText: 'FOR ${1:变量}, ${2:起始}, ${3:结束}, ${4:步进}\n$5\nNEXT$0', detail: '计数循环骨架' },
      {
        label: 'SELECTCASE',
        insertText: 'SELECTCASE ${1:表达式}\nCASE ${2:值}\n$3\nCASEELSE\n$4\nENDSELECT$0',
        detail: '分派块骨架：CASE / CASEELSE',
      },
      { label: 'CASE', insertText: 'CASE ${1:值}', detail: '分派分支头' },
      { label: 'CASEELSE', insertText: 'CASEELSE', detail: '分派兜底分支' },
    ];
    return spec.map((s, idx) => ({
      label: s.label,
      kind,
      insertText: s.insertText,
      ...(rule !== undefined ? { insertTextRules: rule } : {}),
      detail: s.detail,
      range,
      sortText: `0_${String(idx).padStart(2, '0')}_${s.label}`,
    }));
  },
};
