/**
 * Kojo 2.0 补全 · **块级 snippets 数据源**（K2-COMPLETE-SNIPPETS）。
 *
 * ## 分工（既有纪律不变）
 * `kojo2-completion.ts` 的 `kojo2CompletionAt` 是**纯函数候选模型**：源码进、词形候选出，
 * `insertText` 一律是原文名字，**不塞括号 / snippet**（调用形态不归它猜）。本文件是**宿主
 * 翻译层**的追加口：宿主在行首位置把这里的条目按 `kind: 'snippet'` 追加到同一轮候选里，
 * 翻成 `CompletionItemKind.Snippet` + `InsertTextRules.InsertAsSnippet`。
 * 纯函数那一侧逐字不变——"snippet 只在宿主翻译层按 kind 追加"就是这一条。
 *
 * ## 为什么是数据
 * 五副骨架（`?` 链 / `# 表` 两列 / `# 池` 分支 / `@巡` / `# 机` 事件头）都是**语言形状**：
 * 词形从 core 词表 / 声明索引派生（`# 表` / `# 池` 取 `KOJO2_DECL_WORD_BY_KIND`，`# 机` 取
 * `KOJO2_MACHINE_WORD`，`@巡` 取 `KOJO2_DISPATCH_WORDS` 的位序），本文件**不手抄任何新词形**；
 * 缩进写死 4 空格（与 `KOJO_INDENT_WIDTH` 同值，`@巡` 体一级、分支体两级）。
 *
 * ## `insertText` 的占位符约定（Monaco snippet 语法）
 * - `${1:名字}` = 带默认文本的 tab stop（编号 1 起，按书写顺序递增）；`$0` = 收尾光标；
 * - **字面文本里不出现 `$` / `}`**（会变成 tab-stop / 截断 placeholder）——默认文本用
 *   `……` / `「……」` / 条件说明这类中文占位，字面花括号一律不写；
 * - 宿主**不得**再二次转义（与 `.kojo` 侧 `escapeSnippetText` 的分工不同：那里的模板正文
 *   是作者字节拼出来的，这里的正文是本文件写死的常量）。
 *
 * ## 位置门
 * 五副骨架都只在**行首**（光标之前只有空白）出货：行中写块骨架没有语法意义
 * （`?` / `#` / `@` 都只在行首开块），也与"锚点候选在行首"的既有产品口径一致。
 */

import { KOJO_TABLE_DEFAULT, KOJO_TABLE_SUBJECT } from '@kojo/kojo-core';
import { isAllBlank } from './kojo-completion-position';
import {
  KOJO2_DECL_WORD_BY_KIND,
  KOJO2_MACHINE_WORD,
  type Kojo2Query,
} from '@kojo/kojo-lang';
import { KOJO2_DISPATCH_WORDS } from './kojo2-lexicon';

/** 表 / 池 / 机 / 巡 的词形（core 词表 / 声明索引派生，不写字形）。 */
const TABLE_WORD = KOJO2_DECL_WORD_BY_KIND.table;
const POOL_WORD = KOJO2_DECL_WORD_BY_KIND.pool;
/** `# 表` 的两枚结构词（`由` / `否`；core 词表派生）。 */
const TABLE_SUBJECT_WORD = KOJO_TABLE_SUBJECT;
const DEFAULT_BRANCH_WORD = KOJO_TABLE_DEFAULT;
/** `@巡` 在 core 调度词表里的位序（`tokens.ts` §2.1；取不到 = 空串 ⇒ 该条不派生） */
const TOUR_WORD = KOJO2_DISPATCH_WORDS[7] ?? '';

/** 一级缩进（与 core `KOJO_INDENT_WIDTH` 同值；本文件只此一处写它）。 */
const INDENT = '    ';
const INDENT2 = INDENT + INDENT;

/** 一条块级 snippet（纯数据；`kind` 固定 `'snippet'`，宿主据此映射 Monaco 的 Snippet 档）。 */
export interface Kojo2CompletionSnippet {
  /** 稳定 id（宿主去重 / 测试定位用；不是给作者看的） */
  readonly id: string;
  /** 面板显示名（带触发形态，便于作者按已输入字符过滤：`#` / `?` / `@` 开头） */
  readonly label: string;
  /** Monaco snippet 正文（占位符约定见模块头注） */
  readonly insertText: string;
  /** 面板说明（中文） */
  readonly detail: string;
  /** 排名键（追加档位：排在纯函数候选之后由宿主决定，这里只给稳定的相对序） */
  readonly sortText: string;
  /** 语义类别（宿主只认这一枚来追加；纯函数候选永不产出这一档） */
  readonly kind: 'snippet';
}

/**
 * 五副块骨架（顺序 = 面板序）。每条 `insertText` 的占位符含义写在该条注释里。
 */
export const kojo2CompletionSnippets: readonly Kojo2CompletionSnippet[] = Object.freeze([
  {
    id: 'chain-question',
    // `? 链`：条件 → 分支体 → `? 否` → 默认分支体；`$0` 收在最后一条分支体。
    label: '? 链（条件 + 否）',
    insertText: [
      `? \${1:条件}`,
      `${INDENT}\${2:> ……}`,
      `? \${3:${DEFAULT_BRANCH_WORD}}`,
      `${INDENT}\${4:> ……}$0`,
    ].join('\n'),
    detail: '条件链骨架：条件分支 + `? 否` 默认分支',
    sortText: '9_snippet_01_chain',
    kind: 'snippet',
  },
  {
    id: 'table-two-columns',
    // `# 表` 两列：`表名 由 主语` + 两列行（范围 + 文本）+ `否` 兜底。
    label: `# ${TABLE_WORD}（两列）`,
    insertText: [
      `# ${TABLE_WORD} \${1:表名} ${TABLE_SUBJECT_WORD} \${2:主语}`,
      `${INDENT}\${3:0..99} \${4:疏远}`,
      `${INDENT}\${5:100..499} \${6:平常}`,
      `${INDENT}\${7:${DEFAULT_BRANCH_WORD}} \${8:未知}$0`,
    ].join('\n'),
    detail: '两列表骨架：范围列 + 文本列，末行 `否` 兜底',
    sortText: '9_snippet_02_table',
    kind: 'snippet',
  },
  {
    id: 'pool-branches',
    // `# 池` 分支：池名 + 两条 `?` 分支（末条必为 `否`）。
    label: `# ${POOL_WORD}（分支）`,
    insertText: [
      `# ${POOL_WORD} \${1:池名}`,
      `${INDENT}? \${2:条件}`,
      `${INDENT2}\${3:> ……}`,
      `${INDENT}? \${4:${DEFAULT_BRANCH_WORD}}`,
      `${INDENT2}\${5:> ……}$0`,
    ].join('\n'),
    detail: '条件池骨架：`?` 分支 + `? 否` 收尾（池体必须是条件链）',
    sortText: '9_snippet_03_pool',
    kind: 'snippet',
  },
  {
    id: 'foreach-tour',
    // `@巡` 骨架：集合 → 条件分支 → `? 否`；集合名与条件都是占位符。
    label: `@${TOUR_WORD} 骨架`,
    insertText: [
      `@${TOUR_WORD} \${1:集合}`,
      `${INDENT}? \${2:条件}`,
      `${INDENT2}\${3:> ……}`,
      `${INDENT}? \${4:${DEFAULT_BRANCH_WORD}}`,
      `${INDENT2}\${5:> ……}$0`,
    ].join('\n'),
    detail: '遍历骨架：`@巡 <集合>` + 分支体（集合由 adapter 声明）',
    sortText: '9_snippet_04_tour',
    kind: 'snippet',
  },
  {
    id: 'machine-header',
    // `# 机` 事件头：事件名 + 参数（参数个数由 adapter 目录决定，占位符只留一格）。
    label: `# ${KOJO2_MACHINE_WORD}（事件头）`,
    insertText: `# ${KOJO2_MACHINE_WORD} \${1:事件} \${2:参数}$0`,
    detail: '事件头骨架：`# 机 <事件> [参数…]`（事件名由 adapter 目录补全）',
    sortText: '9_snippet_05_machine',
    kind: 'snippet',
  },
]);

/**
 * 宿主翻译层的**位置门 + 追加口**：行首（光标之前只有空白）⇒ 五副骨架，否则零条。
 *
 * 纯函数 `kojo2CompletionAt` **不会**调用它（也不产出 `kind: 'snippet'`）；宿主在拿到纯函数
 * 候选之后自行追加，两路互不占地。行首空白口径与位置层同一份（含全角空格 / 制表）。
 */
export function kojo2SnippetCandidatesAt(
  query: Kojo2Query,
  snippets: readonly Kojo2CompletionSnippet[] = kojo2CompletionSnippets,
): readonly Kojo2CompletionSnippet[] {
  const lineText = query.source.split(/\r\n|\r|\n/)[query.line - 1] ?? '';
  const col0 = Math.min(Math.max(query.column - 1, 0), lineText.length);
  if (!isAllBlank(lineText.slice(0, col0))) return [];
  return snippets;
}
