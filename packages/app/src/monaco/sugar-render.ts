/**
 * 糖视图的**着色渲染**：把投影出来的糖文本渲染成"和 `.kojo` 文件一模一样"的样子。
 *
 * ## 为什么要着色（而不是一坨纯文本）
 *
 * 糖视图的读者是**不熟悉 EraBasic 的人**。整份文件如果只有一种颜色，他仍然要逐字
 * 去分辨"这句是角色在说话"还是"这是一条规则"；而着色把这件事变成一眼的事：
 * 台词是台词色、`如果 / 否则 / 当` 是关键字色、原生代码是 ERB 色。
 *
 * ## 单一真源：复用 `.kojo` 的 Monarch 配色
 *
 * 颜色**不新起一套**，直接取自 `KOJO_SUGAR_THEME_RULES`（`.kojo` 编辑器主题的糖
 * 专属规则，`kojo-language.ts` 导出）。于是"糖视图里的糖"与"`.kojo` 文件里的糖"
 * 永远同色——读者在糖视图里认下的颜色，写 `.kojo` 时依然成立。
 *
 * 词法也用同一个 Monarch 语法（`monaco.editor.tokenize`，语言 id 即 `KOJO_LANGUAGE_ID`）：
 * 投影产出的是**表层语法**，正是该语法描述的对象。
 *
 * ## 降级
 *
 * 着色是**最佳努力**：`tokenize` 抛错或不可用 → 退回纯文本 `textContent`
 * （丑一点，但一定读得到）。绝不因为"上色失败"而让整块糖消失。
 */

import type * as Monaco from 'monaco-editor';
import { KOJO_LANGUAGE_ID, KOJO_SUGAR_THEME_RULES } from './kojo-language';

/** token → 前景色（`#rrggbb`）。从主题规则派生，不手抄第二份调色板 */
const TOKEN_COLORS: ReadonlyMap<string, string> = new Map(
  KOJO_SUGAR_THEME_RULES.filter((r) => r.foreground !== undefined).map((r) => [
    r.token,
    `#${r.foreground}`,
  ]),
);

/** 未被主题覆盖的 token 的前景（空串 = 交给 CSS 的 `--fg`，即"旁白 = 正文色"） */
export const SUGAR_DEFAULT_COLOR = '';

/**
 * 词法 token 类型 → 颜色。
 *
 * 取**最长前缀命中**：Monarch 会给出 `sugar.speech.delimiter` 这种更细的 type，
 * 而主题里粗细两级都有规则（引号 vs 台词本体）。精确命中优先，否则逐级回退
 * （`sugar.speech.delimiter` → `sugar.speech` → 默认色），最后兜底正文色。
 */
export function tokenColor(type: string): string {
  let t = type;
  for (;;) {
    const hit = TOKEN_COLORS.get(t);
    if (hit !== undefined) return hit;
    const dot = t.lastIndexOf('.');
    if (dot < 0) return SUGAR_DEFAULT_COLOR;
    t = t.slice(0, dot);
  }
}

/**
 * 把糖文本填进一个已有的 `<pre class="sugar-zone">`（宿主的分帧填充用它：先建空壳
 * 再按帧填内容，元素身份始终不变）。
 *
 * 输出形态是 `<pre class="sugar-zone">` + 每行一个 `<div class="sugar-line">`，
 * 行内按 token 切 `<span>` 上色。逐行用 `<div>` 而不是一个 `<pre>` 装整块：空行需要
 * **自己的行框**才能撑出行高（`\n\n` 在 `pre` 里只算一个换行符的位置，视觉上会"吃掉"一行）。
 *
 * 填充失败（`tokenize` 不可用等）→ 退回纯文本，**绝不留下空白**。
 */
export function fillSugarBlock(pre: HTMLElement, monaco: typeof Monaco, text: string): void {
  try {
    const raw = text.split('\n');
    const tokenized = monaco.editor.tokenize(text, KOJO_LANGUAGE_ID);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < raw.length; i++) {
      const line = document.createElement('div');
      line.className = 'sugar-line';
      const src = raw[i] ?? '';
      const tokens = tokenized[i] ?? [];
      if (tokens.length === 0) {
        line.textContent = src; // 纯空白行：无 token（但保留行框以撑出行高）
      } else {
        for (let t = 0; t < tokens.length; t++) {
          const from = tokens[t]!.offset;
          const to = t + 1 < tokens.length ? tokens[t + 1]!.offset : src.length;
          if (to <= from) continue;
          const span = document.createElement('span');
          const color = tokenColor(tokens[t]!.type);
          if (color !== '') span.style.color = color;
          span.textContent = src.slice(from, to);
          line.appendChild(span);
        }
      }
      frag.appendChild(line);
    }
    pre.textContent = '';
    pre.appendChild(frag);
  } catch {
    // 上色是加分项，不是前置条件：坏了就退回纯文本（正文色，仍可读）
    pre.textContent = text;
  }
}
