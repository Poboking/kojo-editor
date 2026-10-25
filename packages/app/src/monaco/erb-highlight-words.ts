import { ERB_CONTROL_STATEMENTS } from '@kojo/plugin-erb-parser';
import { ERB_DIRECTIVES } from './erb-directives';

/**
 * ERB 高亮**补集**（2026-10-18 SUGGEST-2C；2026-10-25 P0-2 收窄）。
 *
 * 为什么需要补集：`ERB_DIRECTIVES` 是「口上高频子集」，口径服务于**补全候选**
 * （低频语句不该塞进补全列表冲淡热门项）。高亮是另一件事——作者在文件里写下的
 * 引擎语句无论频次都该有颜色，否则 `SETVAR` / `REDRAW` 这类词在屏上就是白字。
 * 两个口径共用**同一份真源**，只是消费面不同：
 *
 * - 控制流语句：**P0-2 起已并入 `ERB_DIRECTIVES` 的派生面**（`erb-directives.ts`
 *   从 `ERB_CONTROL_STATEMENTS` 追加），所以这里不再需要为它们兜底——结构认的词
 *   现在补全也认、着色也认，一个来源；
 * - 结构扫描器**不建模**的引擎内建单行语句：`ERB_ENGINE_EXTRA_STATEMENTS`
 *   （本模块是这批词的单一真源；出处 = 引擎 `FunctionIdentifier.cs` 的语句组，
 *   eraTW 4.980 语料词频：HTML_PRINT 519 / REDRAW 307 / FORCEWAIT 162）。
 *
 * 派生顺序：两表并集 → 去掉 `ERB_DIRECTIVES` 已有词（补集严格是"补"）→
 * 大小写归一去重 → 码元序排序（同一输入恒得同一顺序）。`.erb` 与 `.kojo`
 * 原生行高亮都从这里取，不许在语言定义里另写字面量。
 */
export const ERB_ENGINE_EXTRA_STATEMENTS: readonly string[] = [
  // 变量按名读写（引擎内建单行语句；不是表达式函数）
  'SETVAR',
  'GETVAR',
  // 输出 / 排版 / 文件（结构扫描器不建模）
  'FORCEWAIT',
  'HTML_PRINT',
  'PRINTCPERLINE',
  'REDRAW',
  'SAVETEXT',
  'LOADTEXT',
];

/** 两表并集，按**大小写不敏感**去重（先出现者保留原样），产物码元序排序 */
function unionSorted(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const word of list) {
      if (word.length === 0) continue;
      const key = word.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(word);
    }
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const DIRECTIVE_SET = new Set(ERB_DIRECTIVES.map((w) => w.toUpperCase()));

/**
 * 高亮补集 = （控制流语句 ∪ 引擎内建单行语句）− `ERB_DIRECTIVES`。
 * 每词都能追到 `ERB_CONTROL_STATEMENTS` 或 `ERB_ENGINE_EXTRA_STATEMENTS`
 * （`tests/erb-highlight.test.ts` 逐词断言）。
 */
export const ERB_HIGHLIGHT_EXTRA_WORDS: readonly string[] = unionSorted(
  ERB_CONTROL_STATEMENTS,
  ERB_ENGINE_EXTRA_STATEMENTS,
).filter((w) => !DIRECTIVE_SET.has(w.toUpperCase()));

/** `.erb` 高亮全表（指令子集 + 补集）；补全**不**消费本表 */
export const ERB_HIGHLIGHT_WORDS: readonly string[] = unionSorted(ERB_DIRECTIVES, ERB_HIGHLIGHT_EXTRA_WORDS);
