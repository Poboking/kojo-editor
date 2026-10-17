/**
 * 约定问题的**一键修法**供给方（DIAG-LINK，2026-10-18）。
 *
 * ## 定位（为什么住这儿）
 * 契约把修法挂在问题上（`ConventionIssue.edits`，additive）——**规则自己给 `edits` 时它优先**，
 * 本模块只兜"规则还没吐出 `edits` 的那几条"（规则文件正被并发线重做，这里先让诊断面**今天就**
 * 能修，规则侧一旦直出 `edits`，本表对应那条自动失效 ⇒ 不留第二真相源）。
 *
 * ## 出动作的唯一门槛：**可证明**
 * 只在"改法由诊断本身唯一确定、不新增任何作者该自己决定的信息"时给动作；给不出就返回空数组
 * （折叠层据此**不产 quickfix**，波浪线照旧——全仓口径：不猜、不静默）。反例都说得出为什么不做：
 * - `sugar.expr-missing-else`：要补的是「否则」分支的**值**（补 `0` 还是补上一支的值是作者的
 *   决定）；插一个空的「否则：」能把编译错误变成"这条路径上左值不赋值"——那是把报错洗成静默，
 *   而且 `workbench.fixAll` 会成批替作者按下这个决定；
 * - `sugar.choice-multiple`：拆时机还是改原生直通 `GOTO`，形态不止一种；
 * - `erb.duplicate-function`：留哪一处定义是跨文件取舍（而且"哪处胜出"本身未经引擎实测坐实）。
 *
 * 纯函数：问题 + **当下缓冲区**的行进、修法出；不读盘不写盘不碰 Monaco。
 */

import type { ConventionIssue } from '@kojo/plugin-api';
import { CONT_INSIDE_QUOTES_RULE_ID, READONLY_ALIAS_ASSIGN_RULE_ID } from './rules/sugar-conventions';
import type { ConventionIssueEdit } from './diagnostics';

/** 与规则侧同一批续标记（规范 §3.3 的隐藏别名）。规则侧新增标记而这里没跟上 ⇒ **不出动作**（保守失效，绝不改错） */
const CONT_MARKS = ['续', '~', '⏎', 'cont', 'continue'] as const;

/** 与规则侧同一批引号对（半角 `"` 规则侧不参与判定，这里也不参与） */
const QUOTE_PAIRS: ReadonlyArray<readonly [open: string, close: string]> = [
  ['「', '」'],
  ['｢', '｣'],
  ['『', '』'],
  ['“', '”'],
];

interface ContCandidate {
  readonly open: number;
  readonly close: number;
  readonly openChar: string;
  readonly closeChar: string;
  readonly mark: string;
}

/** 一行里"引号内侧末尾正是续标记"的那些位置（与规则侧同形：标记紧贴右引号、忽略尾随空白） */
function contCandidates(line: string): ContCandidate[] {
  const out: ContCandidate[] = [];
  for (const [openChar, closeChar] of QUOTE_PAIRS) {
    let i = line.indexOf(openChar);
    while (i >= 0) {
      const j = line.indexOf(closeChar, i + 1);
      if (j < 0) break;
      const inner = line.slice(i + 1, j).replace(/\s+$/u, '');
      for (const mark of CONT_MARKS) {
        if (inner.endsWith(mark) && inner.length > mark.length) {
          out.push({ open: i, close: j, openChar, closeChar, mark });
          break;
        }
      }
      i = line.indexOf(openChar, j + 1);
    }
  }
  return out;
}

/**
 * `续` 在引号内 → 移到引号外（`「台词续」` ⇒ `「台词」 续`，规范 §3.3 的"正确写法"）。
 *
 * **只在整行唯一候选时给**：两处以上就不知道搬哪一处（返回空，一条都不动）。台词一字
 * 不动，只搬标记与右引号的相对位置 ⇒ 可证明。
 *
 * 落点写成 `{ line, column: 0 }` 且**不给 `end`**（契约 `SugarEdit.loc` 是必填、`end` 省略
 * = 整行替换那一行；缩进与行尾注释因此原样随 `newText` 带过去）。
 */
function relocateContMark(lineText: string, issueLine: number): readonly ConventionIssueEdit[] {
  const hits = contCandidates(lineText);
  if (hits.length !== 1) return [];
  const hit = hits[0]!;
  const body = lineText
    .slice(hit.open + 1, hit.close)
    .replace(/\s+$/u, '')
    .slice(0, -hit.mark.length);
  const newText = `${lineText.slice(0, hit.open)}${hit.openChar}${body}${hit.closeChar} ${hit.mark}${lineText.slice(hit.close + hit.closeChar.length)}`;
  if (newText === lineText) return [];
  return [{ description: `把「${hit.mark}」移到引号外（规范 §3.3）`, loc: { line: issueLine, column: 0 }, newText }];
}

/** `别名 X = 字面量` 声明（只读别名；这里只取"右值是不是字面量"这一件可判的事，**不重判违规**） */
const ALIAS_DECL = /^\s*(?:别名|alias)\s+([^\s=]+)\s*=\s*(.+?)\s*$/i;
const NUMERIC = /^-?\d+$/;
const QUOTED = /^".*"$/;
/** 赋值行 `X = 右值`（比较 `==` 排除在外；与规则侧同一形状） */
const ASSIGN = /^\s*([^\s=<>!]+)\s*=(?!=)\s*(.+?)\s*$/;

/**
 * 只读别名被当赋值左值（规范 §5.0）——**只接住"这行本就是无效写入"的那一小撮**：
 * 赋值右值与别名绑定的字面量**逐字相同**（`别名 冷淡 = 0` 之后写 `冷淡 = 0`）。
 * 糖语义里这句等于"把 0 写进 0"：转译器在 `expandTarget` 就拒绝该左值、整行不产出 ⇒
 * 注释掉它**零语义变化**。
 *
 * 右值不同（`冷淡 = 5`）时改法就是作者的决定（换绑？改名？删别名？），一律不给动作。
 * 别名名**从当下那一行的左值取**（不是从消息里抠文案）：转译器那条消息是
 * `「X」是只读别名（…），不能作为赋值目标。`——给人读的措辞，改了词就静默失灵，
 * 而"文案单源 = 转译器 + `diagnostic-copy`"也不许本层再抄一份正则去认（`issue.line`
 * 那一行的左值就是 X，是同一件事的结构化说法，且与判据同源）。
 */
function neutralizeNoopAliasAssign(lines: readonly string[], line: number): readonly ConventionIssueEdit[] {
  const assign = lines[line - 1]!;
  const hit = ASSIGN.exec(assign);
  if (!hit) return [];
  const name = hit[1]!;
  const rhs = hit[2]!;
  const literal = aliasLiteralFor(lines, name);
  if (literal === null || literal !== rhs) return [];
  return [
    {
      description: '注释掉这条无效赋值（右值与只读别名绑定的字面量相同）',
      loc: { line, column: 0 },
      newText: `; ${assign.trim()}`,
    },
  ];
}

/** 同一份文本里那条 `别名 X = <字面量>` 的字面量右值；非字面量 / 找不到 ⇒ null（不动手） */
function aliasLiteralFor(lines: readonly string[], name: string): string | null {
  for (const raw of lines) {
    const decl = ALIAS_DECL.exec(raw);
    if (!decl || decl[1] !== name) continue;
    const target = decl[2]!.trim();
    return NUMERIC.test(target) || QUOTED.test(target) ? target : null;
  }
  return null;
}

/**
 * 一条约定问题 → 它的一键修法；**没有可证明改法就返回空数组**（折叠层据此不产动作）。
 *
 * `lines` 是当下**缓冲区**的行数组（报告算自盘上那份文本，缓冲区可能已被继续编辑 ⇒
 * 每次请求都按现文本重算落点，对不上就不给，绝不按陈旧坐标硬写）。
 */
export function conventionIssueFixes(
  issue: ConventionIssue,
  lines: readonly string[],
): readonly ConventionIssueEdit[] {
  if (!issue.filePath || !/\.kojo$/i.test(issue.filePath)) return []; // 糖侧约定只管 `.kojo`（与规则侧同一条判据）
  const line = issue.line;
  if (typeof line !== 'number' || line < 1 || line > lines.length) return [];
  if (issue.ruleId === CONT_INSIDE_QUOTES_RULE_ID) return relocateContMark(lines[line - 1]!, line);
  if (issue.ruleId === READONLY_ALIAS_ASSIGN_RULE_ID) return neutralizeNoopAliasAssign(lines, line);
  return [];
}
