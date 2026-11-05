/**
 * Kojo 2.0 补全 · **块级 snippets 数据源**（K2-COMPLETE-SNIPPETS；W1 起新正典优先）。
 *
 * ## 分工（既有纪律不变）
 * `completion.ts` 的 `kojo2CompletionAt` 是**纯函数候选模型**：源码进、词形候选出，
 * `insertText` 一律是原文名字，**不塞括号 / snippet**（调用形态不归它猜）。本文件是**翻译层**
 * 的追加口：消费方在行首位置把这里的条目按 `kind: 'snippet'` 追加到同一轮候选里，宿主再翻成
 * `CompletionItemKind.Snippet` + `InsertTextRules.InsertAsSnippet`。
 * 纯函数那一侧逐字不变——"snippet 只在翻译层按 kind 追加"就是这一条。
 *
 * ## W1/W2 新正典优先（2026-11 语言重构）
 * `docs/KOJO-2.0-LANGUAGE-REDESIGN.md` §2 把作者语法换代：方寸声明 `【…】`、冒号动作 `算：`、
 * `若/再若/否则`、`演：`、裸行旁白。本文件的**数组序就是面板序**，因此新正典模板全部排在前面
 * （`sortText` 前缀 `8_snippet_c…`），旧写法模板保留在后（前缀 `9_snippet_l…`，detail 逐条标注
 * "旧写法（兼容）"）——迁移期旧文件还要写，但作者第一眼看到的必须是新正典。
 *
 * ## 为什么是数据 / 词形零抄本
 * 骨架是**语言形状**：词形从 core 词表 / 声明索引派生（`【对照表】`/`【池】` 取
 * `KOJO2_DECL_WORD_BY_KIND`、`【挂】` 取方寸别名表、`【函】` 取调度词表、类型正典取
 * `KOJO2_TYPE_WORD_ALIAS`、循环控制取 `KOJO2_LOOP_CONTROL_CANONICAL_WORDS`），本文件**不手抄
 * 任何新词形**；缩进写死 4 空格（与 `KOJO_INDENT_WIDTH` 同值，`@巡` 体一级、分支体两级）。
 *
 * ## `insertText` 的占位符约定（Monaco snippet 语法）
 * - `${1:名字}` = 带默认文本的 tab stop（编号 1 起，按书写顺序递增）；`$0` = 收尾光标；
 * - **字面文本里不出现 `$` / `}`**（会变成 tab-stop / 截断 placeholder）——默认文本用
 *   `……` / `「……」` / 条件说明这类中文占位，字面花括号一律不写；
 * - 宿主**不得**再二次转义（与 `.kojo` 侧 `escapeSnippetText` 的分工不同：那里的模板正文
 *   是作者字节拼出来的，这里的正文是本文件写死的常量）。
 *
 * ## 位置门
 * 所有骨架都只在**行首**（光标之前只有空白）出货：行中写块骨架没有语法意义
 * （`?` / `#` / `@` / `【` 都只在行首开块），也与"锚点候选在行首"的既有产品口径一致。
 *
 * ## 为什么住在包不住宿主（B3c 车道 2 搬入）
 * 这些骨架是补全候选的一部分，而 B3c 起补全的**供方是插件**——插件读不到
 * `packages/app/src/**`。数据留在宿主 = 插件必须抄一份 = 骨架词形漂移（头注那句"不手抄
 * 任何新词形"从此无人守）。搬入是**纯搬家**；W1 只做加法（新正典条目在前、旧条目保留并标注）。
 */

import {
  KOJO_TABLE_ARROWS,
  KOJO_TABLE_DEFAULT,
  KOJO_TABLE_SUBJECT,
} from '@kojo/kojo-core';
import { isAllBlank } from './completion';
import {
  KOJO2_DECL_WORD_BY_KIND,
  KOJO2_MACHINE_WORD,
  type Kojo2Query,
} from './declarations';
import {
  KOJO2_ACTION_WORD_ALIAS,
  KOJO2_CANONICAL_ELSE_WORD,
  KOJO2_CANONICAL_IF_WORD,
  KOJO2_CANONICAL_CALL_WORD,
  KOJO2_DISPATCH_WORDS,
  KOJO2_HEADER_CLOSE,
  KOJO2_HEADER_OPEN,
  KOJO2_LOOP_CONTROL_CANONICAL_WORDS,
  KOJO2_TYPE_WORD_ALIAS,
  kojo2CanonicalHeaderWord,
} from './lexicon';

/** 表 / 池 / 机的词形（core 词表 / 声明索引派生，不写字形）。 */
const TABLE_WORD = KOJO2_DECL_WORD_BY_KIND.table;
const POOL_WORD = KOJO2_DECL_WORD_BY_KIND.pool;
const SCENE_WORD = KOJO2_DECL_WORD_BY_KIND.scene;
const VARIABLE_WORD = KOJO2_DECL_WORD_BY_KIND.variable;
/** `【对照表】` 的两枚结构词（`依据` / `否`；core 词表派生）。 */
const TABLE_SUBJECT_WORD = KOJO_TABLE_SUBJECT;
const DEFAULT_BRANCH_WORD = KOJO_TABLE_DEFAULT;
/** 表体分档箭头：正典 `→`（`->` 兼容；作者面模板用正典形）。 */
const TABLE_ARROW_WORD = KOJO_TABLE_ARROWS[1] ?? KOJO_TABLE_ARROWS[0] ?? '';
/** `@巡` 在 core 调度词表里的位序（`tokens.ts` §2.1；取不到 = 空串 ⇒ 该条不派生） */
const TOUR_WORD = KOJO2_DISPATCH_WORDS[7] ?? '';
/** `@函` 在 core 调度词表里的位序（`【函 …】` 的方寸词）。 */
const FUNCTION_WORD = KOJO2_DISPATCH_WORDS[8] ?? '';

/** `【挂 …】`（机器头新正典词）、`【定 …】`（编译期常量）、`【设 …】`（运行期变量）。 */
const MACHINE_HEADER_WORD = kojo2CanonicalHeaderWord(KOJO2_MACHINE_WORD);
const FIXED_HEADER_WORD = kojo2CanonicalHeaderWord(VARIABLE_WORD);
const SET_HEADER_WORD = VARIABLE_WORD;

/** 类型词正典（`数` / `文字`；旧 `整数` / `字符串` 兼容）。 */
const INT_TYPE_WORD = [...KOJO2_TYPE_WORD_ALIAS.keys()][0] ?? '';
const STRING_TYPE_WORD = [...KOJO2_TYPE_WORD_ALIAS.keys()][1] ?? '';

/** 循环控制正典（`下一轮` / `跳出循环`）。 */
const NEXT_ROUND_WORD = KOJO2_LOOP_CONTROL_CANONICAL_WORDS[0] ?? '';
const BREAK_LOOP_WORD = KOJO2_LOOP_CONTROL_CANONICAL_WORDS[1] ?? '';

/** 冒号动作正典词（`算` / `色` / `循环` …）：由 core 别名表**反查**既有调度词得到，零手抄。 */
const actionWordOf = (oldDispatchWord: string): string => {
  for (const [surface, word] of KOJO2_ACTION_WORD_ALIAS) {
    if (word === oldDispatchWord) return surface;
  }
  return oldDispatchWord;
};

/** 一级缩进（与 core `KOJO_INDENT_WIDTH` 同值；本文件只此一处写它）。 */
const INDENT = '    ';
const INDENT2 = INDENT + INDENT;

/** 方寸行包装：`【词 内容】`（词形由调用方给，本函数只管收口）。 */
function headerLine(word: string, content: string): string {
  return `${KOJO2_HEADER_OPEN}${word} ${content}${KOJO2_HEADER_CLOSE}`;
}

/** 一条块级 snippet（纯数据；`kind` 固定 `'snippet'`，宿主据此映射 Monaco 的 Snippet 档）。 */
export interface Kojo2CompletionSnippet {
  /** 稳定 id（宿主去重 / 测试定位用；不是给作者看的） */
  readonly id: string;
  /** 面板显示名（带触发形态，便于作者按已输入字符过滤：`【` / `若` / `算` / `#` / `?` / `@` 开头） */
  readonly label: string;
  /** Monaco snippet 正文（占位符约定见模块头注） */
  readonly insertText: string;
  /** 面板说明（中文；旧写法条目以「旧写法（兼容）：」开头） */
  readonly detail: string;
  /** 排名键（同档内相对序；正典 `8_snippet_c…` 在前、旧写法 `9_snippet_l…` 在后） */
  readonly sortText: string;
  /** 语义类别（宿主只认这一枚来追加；纯函数候选永不产出这一档） */
  readonly kind: 'snippet';
}

/** 新正典条的 id 前缀（面板序 = 数组序；宿主也按 sortText 兜一层）。 */
const CANON_SORT = '8_snippet_c';
const LEGACY_SORT = '9_snippet_l';

/**
 * 块骨架（顺序 = 面板序）：**新正典在前**（方寸声明 / 条件链 / 冒号动作 / 演调用），
 * 旧写法五副保留在后并逐条标注兼容（迁移期旧文件还要写）。
 */
export const kojo2CompletionSnippets: readonly Kojo2CompletionSnippet[] = Object.freeze([
  /* ============================== 新正典（W1/W2） ============================== */
  {
    id: 'canon-scene-header',
    // 方寸场景头：`【幕 …】`（旧写法 `# 幕 …`）。
    label: `${KOJO2_HEADER_OPEN}${SCENE_WORD} 场景${KOJO2_HEADER_CLOSE}`,
    insertText: `${headerLine(SCENE_WORD, `\${1:神社清晨}`)}$0`,
    detail: '方寸声明：场景头（新正典；旧写法 `# 幕 …`）',
    sortText: `${CANON_SORT}01_scene`,
    kind: 'snippet',
  },
  {
    id: 'canon-machine-header',
    // 方寸机器头：`【挂 <事件> <参数…>】`（旧写法 `# 机 …`；`挂` 才是新作者语法）。
    label: `${KOJO2_HEADER_OPEN}${MACHINE_HEADER_WORD} 事件${KOJO2_HEADER_CLOSE}`,
    insertText: `${headerLine(MACHINE_HEADER_WORD, `\${1:指令} \${2:310}`)}$0`,
    detail: '方寸声明：事件头（新正典 `【挂 …】`；旧写法 `# 机 …`）',
    sortText: `${CANON_SORT}02_machine`,
    kind: 'snippet',
  },
  {
    id: 'canon-fixed-decl',
    // 编译期常量：`【定 名 数 = 值】`（必须有初值、不能写存储期；旧写法是 `# 设 …` 的字面量形态）。
    label: `${KOJO2_HEADER_OPEN}${FIXED_HEADER_WORD} 常量${KOJO2_HEADER_CLOSE}`,
    insertText: `${headerLine(FIXED_HEADER_WORD, `\${1:亲近线} ${INT_TYPE_WORD} = \${2:500}`)}$0`,
    detail: `方寸声明：编译期常量（新正典 \`【${FIXED_HEADER_WORD} …】\`）`,
    sortText: `${CANON_SORT}03_fixed`,
    kind: 'snippet',
  },
  {
    id: 'canon-set-decl',
    // 运行期变量：`【设 名 数 = 值 [存储期]】`（旧写法 `# 设 …`）。
    label: `${KOJO2_HEADER_OPEN}${SET_HEADER_WORD} 变量${KOJO2_HEADER_CLOSE}`,
    insertText: `${headerLine(SET_HEADER_WORD, `\${1:计数} ${INT_TYPE_WORD} = \${2:0}`)}$0`,
    detail: `方寸声明：运行期变量（新正典 \`【${SET_HEADER_WORD} …】\`）`,
    sortText: `${CANON_SORT}04_set`,
    kind: 'snippet',
  },
  {
    id: 'canon-string-decl',
    // 文字变量：`【设 名 文字 = "…"】`（类型词正典 `文字`）。
    label: `${KOJO2_HEADER_OPEN}${SET_HEADER_WORD} 文字变量${KOJO2_HEADER_CLOSE}`,
    insertText: `${headerLine(SET_HEADER_WORD, `\${1:称呼} ${STRING_TYPE_WORD} = "\${2:灵梦}"`)}$0`,
    detail: `方寸声明：文字变量（类型词正典 \`${STRING_TYPE_WORD}\`；旧词 \`字符串\` 兼容）`,
    sortText: `${CANON_SORT}05_string`,
    kind: 'snippet',
  },
  {
    id: 'canon-function-header',
    // 方寸函数头：`【函 名(参数)】`（旧写法 `@函 …`；体缩进在下一行写）。
    label: `${KOJO2_HEADER_OPEN}${FUNCTION_WORD} 函数${KOJO2_HEADER_CLOSE}`,
    insertText: `${headerLine(FUNCTION_WORD, `\${1:增加羁绊}(\${2:目标}, \${3:数值 = 10})`)}$0`,
    detail: '方寸声明：运行期函数（新正典 `【函 …】`；旧写法 `@函 …`）',
    sortText: `${CANON_SORT}06_function`,
    kind: 'snippet',
  },
  {
    id: 'canon-condition-chain',
    // 条件链：`若 条件：` / `否则：`（旧写法 `? 条件` / `? 否`）；叙事用裸行。
    label: `${KOJO2_CANONICAL_IF_WORD}…${KOJO2_CANONICAL_ELSE_WORD}：条件链`,
    insertText: [
      `${KOJO2_CANONICAL_IF_WORD} \${1:条件}：`,
      `${INDENT}\${2:……}`,
      `${KOJO2_CANONICAL_ELSE_WORD}：`,
      `${INDENT}\${3:……}$0`,
    ].join('\n'),
    detail: '条件链骨架：`若 条件：` + `否则：`（新正典；旧写法 `? …` / `? 否`）',
    sortText: `${CANON_SORT}07_condition`,
    kind: 'snippet',
  },
  {
    id: 'canon-calc-block',
    // 状态更新块：`算：`（旧写法 `@算`）。
    label: `${actionWordOf(KOJO2_DISPATCH_WORDS[0] ?? '')}：状态更新`,
    insertText: [`${actionWordOf(KOJO2_DISPATCH_WORDS[0] ?? '')}：`, `${INDENT}\${1:变量} = \${2:值}$0`].join(
      '\n',
    ),
    detail: '状态更新块：`算：`（新正典；旧写法 `@算`）',
    sortText: `${CANON_SORT}08_calc`,
    kind: 'snippet',
  },
  {
    id: 'canon-perform',
    // 调用：`演：名字(args)`（旧写法 `! 名字`）。
    label: `${KOJO2_CANONICAL_CALL_WORD}：调用`,
    insertText: `${KOJO2_CANONICAL_CALL_WORD}：\${1:名字}(\${2:实参})$0`,
    detail: '调用池 / 模板 / 函数：`演：名字(...)`（新正典；旧写法 `! 名字`）',
    sortText: `${CANON_SORT}09_perform`,
    kind: 'snippet',
  },
  {
    id: 'canon-pool',
    // `【池 名】` + `若 …：` / `否则：` 分支（旧写法 `# 池` + `?` 分支）。
    label: `${KOJO2_HEADER_OPEN}${POOL_WORD} 条件池${KOJO2_HEADER_CLOSE}`,
    insertText: [
      headerLine(POOL_WORD, `\${1:早安问候}`),
      `${INDENT}${KOJO2_CANONICAL_IF_WORD} \${2:条件}：`,
      `${INDENT2}\${3:「……」}`,
      `${INDENT}${KOJO2_CANONICAL_ELSE_WORD}：`,
      `${INDENT2}\${4:「早。」}$0`,
    ].join('\n'),
    detail: '条件池骨架：`【池 …】` + `若/否则`（新正典；池体必须是条件链）',
    sortText: `${CANON_SORT}10_pool`,
    kind: 'snippet',
  },
  {
    id: 'canon-table',
    // `【对照表 名 依据 主语】` + `→` 分档行（旧写法 `# 对照表` + `->`）。
    label: `${KOJO2_HEADER_OPEN}${TABLE_WORD} 分档${KOJO2_HEADER_CLOSE}`,
    insertText: [
      headerLine(TABLE_WORD, `\${1:心情} ${TABLE_SUBJECT_WORD} \${2:恋慕}`),
      `${INDENT}\${3:0..99} ${TABLE_ARROW_WORD} \${4:疏远}`,
      `${INDENT}\${5:100..499} ${TABLE_ARROW_WORD} \${6:平常}`,
      `${INDENT}\${7:${DEFAULT_BRANCH_WORD}} ${TABLE_ARROW_WORD} \${8:未知}$0`,
    ].join('\n'),
    detail: `对照表骨架：范围 ${TABLE_ARROW_WORD} 值，末行 \`${DEFAULT_BRANCH_WORD}\` 兜底（新正典）`,
    sortText: `${CANON_SORT}11_table`,
    kind: 'snippet',
  },
  {
    id: 'canon-loop',
    // 循环：`循环：条件`（旧写法 `@循 条件`）；循环控制正典 `下一轮` / `跳出循环` 写进注释位。
    label: `${actionWordOf(KOJO2_DISPATCH_WORDS[5] ?? '')}：条件循环`,
    insertText: [
      `${actionWordOf(KOJO2_DISPATCH_WORDS[5] ?? '')}：\${1:条件}`,
      `${INDENT}\${2:……}`,
      `${INDENT}${NEXT_ROUND_WORD}$0`,
    ].join('\n'),
    detail: `条件循环：\`循环：\`（新正典；跳出写 \`${BREAK_LOOP_WORD}\`，旧写法 \`@循\` / \`@断\` / \`@续\`）`,
    sortText: `${CANON_SORT}12_loop`,
    kind: 'snippet',
  },

  /* ============================== 旧写法（兼容；迁移期保留） ============================== */
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
    detail: '旧写法（兼容）：条件链骨架（`? …` / `? 否`；新正典用 `若/否则`）',
    sortText: `${LEGACY_SORT}01_chain`,
    kind: 'snippet',
  },
  {
    id: 'table-two-columns',
    // `# 对照表`：`表名 依据 主语` + 分档行（范围 -> 文本）+ `否` 兜底。
    label: `# ${TABLE_WORD}（两列）`,
    insertText: [
      `# ${TABLE_WORD} \${1:表名} ${TABLE_SUBJECT_WORD} \${2:主语}`,
      `${INDENT}\${3:0..99} ${TABLE_ARROW_WORD} \${4:疏远}`,
      `${INDENT}\${5:100..499} ${TABLE_ARROW_WORD} \${6:平常}`,
      `${INDENT}\${7:${DEFAULT_BRANCH_WORD}} ${TABLE_ARROW_WORD} \${8:未知}$0`,
    ].join('\n'),
    detail: '旧写法（兼容）：对照表骨架（`# 对照表`；新正典用 `【对照表 …】`）',
    sortText: `${LEGACY_SORT}02_table`,
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
    detail: '旧写法（兼容）：条件池骨架（`# 池` + `?` 分支；新正典用 `【池 …】` + `若`）',
    sortText: `${LEGACY_SORT}03_pool`,
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
    detail: '旧写法（兼容）：遍历骨架（`@巡 <集合>`；新正典用 `遍历：集合`）',
    sortText: `${LEGACY_SORT}04_tour`,
    kind: 'snippet',
  },
  {
    id: 'machine-header',
    // `# 机` 事件头：事件名 + 参数（参数个数由 adapter 目录决定，占位符只留一格）。
    label: `# ${KOJO2_MACHINE_WORD}（事件头）`,
    insertText: `# ${KOJO2_MACHINE_WORD} \${1:事件} \${2:参数}$0`,
    detail: '旧写法（兼容）：事件头骨架（`# 机 …`；新正典用 `【挂 …】`）',
    sortText: `${LEGACY_SORT}05_machine`,
    kind: 'snippet',
  },
]);

/**
 * 宿主翻译层的**位置门 + 追加口**：行首（光标之前只有空白）⇒ 全部骨架，否则零条。
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
