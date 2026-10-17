/**
 * T6 · `.erb` 补全的**位置门**（纯逻辑，零 Monaco 依赖）。
 *
 * 位置语义三态：
 * - `'call-target'`：**直系调用**语句名（`CALL` / `CALLL` / `CALLF` / `TRYCALL`，见
 *   {@link ERB_CALL_STATEMENTS}）之后、同一行第一个**顶层逗号**之前
 *   （逗号 = 实参列表起点，过了逗号就是实参位，不是函数名位）⇒ 只留函数名候选；
 * - `'in-string'`：光标**不在代码视野里**——落在字符串字面量内部（引号配平为奇；FORM 串同形，
 *   `""` 是 Emuera 的字面引号转义），或落在 `;` 起、到行尾的**行注释**里 ⇒ 不给代码补全；
 * - `'default'`：其余位置 ⇒ 维持现行为（六路 source 照旧）。
 *
 * 分工纪律：
 * - 逗号 / 字符串扫描**复用** `erb-completion-bits` 既有的解析件（`topLevelComma`）——
 *   位号 source 的先例件（括号配平 + 跳字符串），禁止抄第二份；
 * - 空白类走 `kojo-completion-position` 的 `BLANK_CLASS_STR` **单源**（与 `kojo-sugar` lexer
 *   同口径），本文件不再手写 `[ \t]`；
 * - 「哪些语句的名字位算调用目标」在本文件**只声明一份**（{@link ERB_CALL_STATEMENTS}），
 *   候选源 `erb-completion-functions.ts` 复用同一张表 + 同一个拼装器（缺陷 2：门与源口径分叉
 *   ⇒ `TRYCALL 名字` 处门不滤、源出函数名，整张关键字表混进来）；
 * - 判据仍是**纯函数、零 IO、不依赖 parser**（本模块既有纪律；走 parser 的取舍另记，本批不动架构路线）；
 * - 门是**过滤**不是重排：消费方（`erb-completion.ts`）在合并前按门类过滤各 source 的候选，
 *   各 source 自带的排序语义原样不动；
 * - 过滤按**候选 kind**（Function / Method）而非 source 名单——`ERB_COMPLETION_SOURCES`
 *   可扩展数组的结构不破坏（新 source 出函数名候选即自动进门）。
 */

import { topLevelComma } from './erb-completion-bits';
import { BLANK_CLASS_STR } from './kojo-completion-position';

/** 补全位置门三态（见模块头注；`'in-string'` 的门名沿用 = 「此处非代码视野」，注释一并复用） */
export type ErbCompletionGate = 'call-target' | 'in-string' | 'default';

/**
 * 语句关键字之后那一位的**槽种类**（{@link ERB_CALL_STATEMENTS} 的分类字段）：
 * 门只吃 `'func'`，候选源吃全部三种（各自口径见清单注）。
 */
export type ErbCallSlotKind = 'func' | 'form' | 'label';

/** 一条「语句关键字 + 其后那一位的种类」 */
export interface ErbCallStatement {
  readonly kw: string;
  readonly slot: ErbCallSlotKind;
}

/**
 * ERB「语句之后跟着一个名字位」的**单一真源**清单（门与函数名候选源共用；不得再留第二份语句表）。
 *
 * 分类依据（与 `erb-parser/src/references.ts:24-35` 的可见性口径同向——那里把「参数位就是函数名」
 * 的直系族单列成 `CALL_FAMILY`，并明示 `JUMP`/`GOTO` 目标是标签、`*FORM*` 参数是表达式）：
 * - `'func'`：**直系调用**，名字位就是函数名 ⇒ **进门**（`'call-target'`，只留函数名候选）；
 * - `'form'`：`*FORM*` 全族，名字位是**表达式**（FORM 串，可含 `%…%` / `{…}` 插值）⇒ 候选源
 *   照常在该位出货（插值例外），但**不进门**——那里不是函数名槽，收窄成「只给函数名」会砍掉
 *   表达式该有的一整片子集（现状判据见本文件既有的 `CALLFORM → default` 用例）；
 * - `'label'`：`JUMP` / `TRYJUMP`，目标是**行号 / `$标签`** ⇒ **不进门**：标签候选 `kind = Reference`
 *   （`erb-completion-labels.ts:109`），进了门会被 `erbGateFilter`（只留 Function / Method）**滤光**，
 *   是净退化。候选源仍认这两位（既有测试钉住 `JUMP CALL_` ⇒ 出函数名）。
 */
export const ERB_CALL_STATEMENTS: readonly ErbCallStatement[] = [
  { kw: 'CALL', slot: 'func' },
  { kw: 'CALLL', slot: 'func' },
  { kw: 'CALLF', slot: 'func' },
  { kw: 'TRYCALL', slot: 'func' },
  { kw: 'CALLFORM', slot: 'form' },
  { kw: 'CALLFORML', slot: 'form' },
  { kw: 'CALLFORMF', slot: 'form' },
  { kw: 'TRYCALLFORM', slot: 'form' },
  { kw: 'TRYCALLFORMF', slot: 'form' },
  { kw: 'TRYCCALLFORM', slot: 'form' },
  { kw: 'JUMP', slot: 'label' },
  { kw: 'TRYJUMP', slot: 'label' },
];

/** 关键字（大写）→ 槽种类：消费方据此决定「名字槽里能不能有插值」，不再 `includes('FORM')` 猜子串 */
export const ERB_CALL_SLOT_BY_KEYWORD: ReadonlyMap<string, ErbCallSlotKind> = new Map(
  ERB_CALL_STATEMENTS.map((s) => [s.kw.toUpperCase(), s.slot]),
);

/**
 * 按槽种类挑出关键字，**长词在前**（正则交替若短词在前会被前缀遮蔽：`CALL` 吃掉 `CALLFORM` 那一位）。
 * 排序按长度降序 ⇒ 清单的书写顺序不承载语义，追加条目不必操心先后。
 */
export function erbCallKeywords(slots: readonly ErbCallSlotKind[]): string[] {
  return ERB_CALL_STATEMENTS.filter((s) => slots.includes(s.slot))
    .map((s) => s.kw)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 拼「行首空白 + 语句关键字」的**锚定**正则（空白类走 `BLANK_CLASS_STR` 单源；`i` = 指令大小写不敏感）。
 * 捕获组 1 = 命中的关键字（消费方拿去 {@link ERB_CALL_SLOT_BY_KEYWORD} 查种类）。
 *
 * `requireBlank`：
 * - `true` ⇒ 关键字后**必须有**空白（候选源侧：名字槽已经在关键字之后）；
 * - `false` ⇒ 只要求词边界 `\b`（门侧：光标可紧贴关键字尾 `CALL|`，同时仍挡住 `CALLFOO` 那类长词）。
 */
export function erbCallStatementRe(slots: readonly ErbCallSlotKind[], requireBlank: boolean): RegExp {
  const alt = erbCallKeywords(slots).join('|');
  const tail = requireBlank ? `[${BLANK_CLASS_STR}]+` : `\\b[${BLANK_CLASS_STR}]*`;
  return new RegExp(`^[${BLANK_CLASS_STR}]*(${alt})${tail}`, 'i');
}

/** 直系调用语句（门的判据；只吃 `'func'` 槽 ⇒ `CALL` / `CALLL` / `CALLF` / `TRYCALL`） */
const CALL_STMT_RE = erbCallStatementRe(['func'], false);

/**
 * 光标之前（`[0, col0)`）是否**不在代码视野**里：落在字符串字面量内，或落在 `;` 行注释里。
 *
 * 一次线性扫描、**按状态推进**（普通 → 串内 → 注释），不是"先数引号再看分号"——
 * `;` 也会出现在字符串里（`PRINT "a;b"`），两种顺序给出的答案不同（缺陷 1 的根因）。口径：
 * - 普通态：`"` ⇒ 进串；`;` ⇒ 进注释（ERB 的 `;` 注释到行尾，此处之后一律不是代码）；
 * - 串内态：`""` 是 Emuera 的**字面引号转义**（消费两个字符、状态不变——光标停在成对引号
 *   **中间**时，数引号的旧口径会算出"偶数 ⇒ 串外"从而在字符串里弹代码补全）；单个 `"` ⇒ 出串；
 * - 引号未闭合 ⇒ 「到行尾都是串」（与 `erb-parser` 的 `codeViewOf` 同方向的保守选择：那种文本
 *   引擎本来就编译不过）。
 */
function erbCodeViewBlocked(lineText: string, col0: number): boolean {
  let inString = false;
  let i = 0;
  while (i < col0) {
    const ch = lineText[i]!;
    if (inString) {
      if (ch === '"') {
        if (lineText[i + 1] === '"') {
          i += 2; // Emuera 转义：一个字面引号，仍是串内
          continue;
        }
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === ';') {
      return true; // 注释态：此处起不给代码补全
    }
    i++;
  }
  return inString;
}

/**
 * 判定光标处的补全门类（**纯函数**；`column` = Monaco 的 1 基列）。
 *
 * - 代码视野判定先行：串内 / 注释内 ⇒ `in-string`（此时不再看语句前缀——串与注释里没有语句）；
 *   注释态**复用** `'in-string'` 这一门态而不新增第四态：消费方 `erb-completion.ts` 的 `locate`
 *   （`in-string` ⇒ 整轮零候选）与 `erbGateFilter`（三态闭集）都不必跟着改，风险为零。
 * - 直系调用语句（`'func'` 槽）后：光标在语句名之后（含紧贴语句名尾）、且在第一个顶层逗号之前
 *   （无逗号 = 到行尾都是名字位）。`CALL(表达式)` 的括号形态里光标越过名字段（`(` 已出现）⇒ 不是
 *   名字段，回 `default`（括号里是表达式，不是函数名槽）。
 */
export function erbCompletionGate(lineText: string, column: number): ErbCompletionGate {
  if (!Number.isFinite(column) || column < 1) return 'default';
  const col0 = Math.min(column - 1, lineText.length);

  // ① 代码视野（缺陷 1）：串内（含 `""` 转义）/ `;` 注释 ⇒ 不给代码补全；
  //    扫描按状态推进，注释里的孤立半角引号不得再把同行代码位一票否决。
  if (erbCodeViewBlocked(lineText, col0)) return 'in-string';

  const m = CALL_STMT_RE.exec(lineText);
  if (m === null || col0 < m[0].length) return 'default';

  const kwEnd = m[0].length;
  // 名字段之后已出现 `(`（`CALL(...)` / `CALLF FOO(...)` 的实参括号）⇒ 光标在表达式里，
  // 不是函数名槽 ⇒ 回现行为
  const openParen = lineText.indexOf('(', kwEnd);
  if (openParen >= 0 && openParen < col0) return 'default';
  // 顶层逗号 = 实参列表起点；光标越过它 ⇒ 实参位，回现行为
  const comma = topLevelComma(lineText, kwEnd, lineText.length);
  if (comma >= 0 && col0 > comma) return 'default';
  return 'call-target';
}
