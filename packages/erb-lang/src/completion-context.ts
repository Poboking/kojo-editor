/**
 * `.erb` 补全的**位置门 v2**（`@kojo/erb-lang/completion-context`；纯逻辑、零 Monaco、零 IO）。
 *
 * 门类（{@link ErbCompletionGate}；判定顺序见 {@link erbCompletionGate}，严格）：
 * - `'in-string'`：光标**不在代码视野**里——落在字符串字面量内部（引号配平为奇；FORM 串同形，
 *   `""` 是 Emuera 的字面引号转义）且**不在闭合插值区**，或落在 `;` 起、到行尾的**行注释**里
 *   ⇒ 整轮零候选（"台词与注释不弹"就是这一态）；
 * - `'interp-expr'`（K2-3）：光标在字符串字面量内部、且处在**闭合的** `%…%` / `{…}` / `\@…\@`
 *   插值区里（判据 {@link erbInterpRegionAt}）⇒ 与 `default` 同口径不过滤（表达式候选）；
 * - `'bit-slot'`：位原语（`GETBIT` / `SETBIT` / `CLEARBIT` / `INVERTBIT`）第二实参坑**开着且空**
 *   ⇒ 只留 `erb-bits`；
 * - `'directive-token'`：行首 `#…` / `[…]` 记号位 ⇒ 只留 `erb-directives`；
 * - `'def-slot'`：行首 `@名字` 定义位（{@link parseErbNameSlot} 非空）⇒ 只留 `erb-functions`；
 * - `'call-target'`：**直系调用**语句名（`CALL` / `CALLL` / `CALLF` / `TRYCALL`，见
 *   {@link ERB_CALL_STATEMENTS}）之后、同一行第一个**顶层逗号**之前 ⇒ 只留 `erb-functions`；
 * - `'label-target'`：跳转家族（{@link ERB_JUMP_KEYWORDS}）目标位（{@link erbLabelSlot} 非空）
 *   ⇒ 只留 `erb-labels`；
 * - `'variable-slot'`：变量引用末段（族头 ∈ `ENGINE_VARIABLE_FAMILIES`，判据
 *   {@link erbVariableSlotAt}）⇒ 只留 `erb-variables`；
 * - `'default'`：其余位置 ⇒ 维持现行为（全部 source 照旧）。
 *
 * ## 为什么这一段住语言面库（LAU-4 续，2026-10-30）
 *
 * 「这一格到底能不能弹补全、能弹的是哪一族」是**语言事实**，与哪部游戏、哪个编辑器无关；
 * 而它此前与候选装配一起住在宿主 `app/src/monaco/erb-completion-context.ts`。判据进包之后，
 * 插件的供方能对同一个位置给出与宿主逐字相同的判断（宿主侧那份现在只是 re-export），
 * 不出现"宿主按一种口径判、供方按另一种"的两份真相。
 *
 * ## 过滤口径
 *
 * 门是**过滤**不是重排：各 source 的自带排序语义原样不动。过滤名单按**候选源 sourceId**
 * 执行（数据 = {@link ERB_GATE_SOURCE_WHITELIST}），不按 kind——同为 `Function` 的系统函数与
 * 项目函数按 kind 分不开，那是缺陷 2 的根因。
 *
 * ## 分工纪律
 *
 * - 逗号 / 括号扫描复用 `./completion-bits` 的 `topLevelComma` / `matchingParen`（位坑判据
 *   `erbBitSlotOpen` 同源）；变量引用判据复用 `./completion-variables` 的 `erbVariableSlotAt`；
 *   标签位判据（{@link erbLabelSlot}）在本文件**单源导出**；
 * - 空白类走 `@kojo/kojo-lang/completion` 的 `BLANK_CLASS_STR` **单源**（与糖层 lexer 同口径：
 *   全角空格算缩进，NBSP 不算），本文件不再手写 `[ \t]`；
 * - 「语句关键字 + 名字槽种类」与「名字槽解析」在本文件**只声明一份**（{@link ERB_CALL_STATEMENTS}
 *   / {@link parseErbNameSlot}），候选源复用同一张表 + 同一个解析器。
 */
import { BLANK_CLASS_STR, isAllBlank, isBlank } from '@kojo/kojo-lang/completion';
import { ERB_NAME_CHAR_CLASS } from '@kojo/kojo-lang/name-chars';
import { erbBitSlotOpen, topLevelComma } from './completion-bits';
import { erbVariableSlotAt } from './completion-variables';

/**
 * 补全位置门（v2 九态）。`'in-string'` 的门名沿用 = 「此处非代码视野」，注释一并复用
 * ——消费方的 `locate`（`in-string` ⇒ 整轮零候选）不必新增分支；
 * `'interp-expr'` 与 `default` 同样**不进**置空分支（串内插值区给表达式候选）。
 */
export type ErbCompletionGate =
  | 'call-target'
  | 'def-slot'
  | 'label-target'
  | 'variable-slot'
  | 'bit-slot'
  | 'directive-token'
  | 'in-string'
  | 'interp-expr'
  | 'default';

/** 语句关键字之后那一位的**槽种类**（门与候选源按各自口径消费，见清单注） */
export type ErbCallSlotKind = 'func' | 'form' | 'label';

/** 一条「语句关键字 + 其后那一位的种类」 */
export interface ErbCallStatement {
  readonly kw: string;
  readonly slot: ErbCallSlotKind;
}

/**
 * ERB「语句之后跟着一个名字位」的**单一真源**清单（门与函数名候选源共用；不得再留第二份）。
 *
 * 分类依据（与 `erb-parser/src/references.ts` 的可见性口径同向——那里把「参数位就是函数名」
 * 的直系族单列成 `CALL_FAMILY`，并明示 `JUMP`/`GOTO` 目标是标签、`*FORM*` 参数是表达式）：
 * - `'func'`：**直系调用**，名字位就是函数名 ⇒ 门 `'call-target'`（只留 `erb-functions`）；
 * - `'form'`：`*FORM*` 全族，名字位是**表达式**（FORM 串，可含 `%…%` / `{…}` 插值）⇒ 候选源
 *   照常在该位出货（插值例外），但**不设门**（`default`）——收窄成「只给函数名」会砍掉
 *   表达式该有的一整片子集；
 * - `'label'`：跳转家族（{@link ERB_JUMP_KEYWORDS}），目标是行号 / `$标签` ⇒ 门 `'label-target'`
 *   （只留 `erb-labels`），函数名候选源**不再认**这两位。
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
  { kw: 'GOTO', slot: 'label' },
  { kw: 'TRYGOTO', slot: 'label' },
];

/**
 * 跳转家族关键字（标签目标位；与解析器实名对齐——`erb-parser/src/symbols.ts` 的
 * `JUMP_FAMILY`）。标签位判据 {@link erbLabelSlot} 与候选源**共用这一份**。
 */
export const ERB_JUMP_KEYWORDS: readonly string[] = ['JUMP', 'GOTO', 'TRYJUMP', 'TRYGOTO'];

/** 关键字（大写）→ 槽种类：消费方据此决定「名字槽里能不能有插值」，不靠 `includes('FORM')` 猜子串 */
export const ERB_CALL_SLOT_BY_KEYWORD: ReadonlyMap<string, ErbCallSlotKind> = new Map(
  ERB_CALL_STATEMENTS.map((s) => [s.kw.toUpperCase(), s.slot]),
);

/**
 * 按槽种类挑出关键字，**长词在前**（正则交替若短词在前会被前缀遮蔽：`CALL` 吃掉 `CALLFORM` 那一位）。
 * 排序按长度降序 ⇒ 清单的书写顺序不承载语义。
 */
export function erbCallKeywords(slots: readonly ErbCallSlotKind[]): string[] {
  return ERB_CALL_STATEMENTS.filter((s) => slots.includes(s.slot))
    .map((s) => s.kw)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 拼「行首空白 + 语句关键字」的**锚定**正则（空白类走 `BLANK_CLASS_STR` 单源；`i` = 大小写不敏感）。
 * 捕获组 1 = 命中的关键字（消费方拿去 {@link ERB_CALL_SLOT_BY_KEYWORD} 查种类）。
 *
 * `requireBlank`：`true` ⇒ 关键字后**必须有**空白（候选源侧）；`false` ⇒ 只要求词边界 `\b`
 * （门侧：光标可紧贴关键字尾 `CALL|`，同时仍挡住 `CALLFOO` 那类长词）。
 */
export function erbCallStatementRe(slots: readonly ErbCallSlotKind[], requireBlank: boolean): RegExp {
  const alt = erbCallKeywords(slots).join('|');
  const tail = requireBlank ? `[${BLANK_CLASS_STR}]+` : `\\b[${BLANK_CLASS_STR}]*`;
  return new RegExp(`^[${BLANK_CLASS_STR}]*(${alt})${tail}`, 'i');
}

/** 直系调用语句（门的判据；只吃 `'func'` 槽 ⇒ `CALL` / `CALLL` / `CALLF` / `TRYCALL`） */
const CALL_STMT_RE = erbCallStatementRe(['func'], false);

/* ============================== 名字槽（定义位 / 调用位共用） ============================== */

/**
 * 名字字符集（正向定义）——**ERB 侧唯一一份**：从语言面 `@kojo/kojo-lang/name-chars` 的
 * `ERB_NAME_CHAR_CLASS` 派生（两门语言共用同一张基表）。
 *
 * 为什么**不含 `$`**：ERB 的 `$` 是标签记号（`$标签`），并进名字会让 `CALL $FOO` 把 `$`
 * 当成函数名的一部分；kojo 侧那份 `NAME_CHAR_CLASS` 含 `$`（糖的 `实参$` 后缀）。
 */
export const NAME_CHAR_RE = new RegExp(`[${ERB_NAME_CHAR_CLASS}]`);

/** 定义位：行首可选空白 + `@`（`@` 之后即函数名）；空白类走 `BLANK_CLASS_STR` 单源 */
export const DEF_RE = new RegExp(`^[${BLANK_CLASS_STR}]*@`);

function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && NAME_CHAR_RE.test(ch);
}

/** 名字槽（0 基区间 + 光标前已输入前缀） */
export interface ErbNameSlot {
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
}

/** 名字槽是否**停在**未闭合的 `%…%` / `{…}` 内（严格在插值里 ⇒ 不猜） */
function insideInterp(section: string): boolean {
  let pct = 0;
  let brace = 0;
  for (const ch of section) {
    if (ch === '%') pct++;
    else if (ch === '{') brace++;
    else if (ch === '}') brace--;
  }
  return pct % 2 === 1 || brace !== 0;
}

/**
 * 解析「名字槽」里的补全位置（**纯函数**；`col0` = 0 基列）。定义位（`@`）与调用位（调用关键字）
 * 判据的**单源**。
 *
 * `boundStart` = 名字槽左界（`@` 之后 / 调用关键字 + 空白之后）；名字槽右界 = 该界之后
 * 第一个 `(` / `;` / 空白。返回 `null` = 该处不是可补全的名字位置：
 * 光标越过槽右界 / 非 `allowInterp` 槽里混入非名字字符 / `allowInterp` 槽里光标严格停在
 * 未闭合插值内——**一律不猜**。
 */
export function parseErbNameSlot(
  lineText: string,
  col0: number,
  boundStart: number,
  allowInterp: boolean,
): ErbNameSlot | null {
  if (col0 < boundStart) return null;

  let slotEnd = boundStart;
  while (slotEnd < lineText.length) {
    const ch = lineText[slotEnd]!;
    if (ch === '(' || ch === ';' || isBlank(ch)) break; // 空白类走单源（全角空格同样是槽分隔）
    slotEnd++;
  }
  if (col0 > slotEnd) return null;

  const section = lineText.slice(boundStart, col0);
  if (allowInterp) {
    if (insideInterp(section)) return null;
  } else if (![...section].every(isNameChar)) {
    return null;
  }

  let start = col0;
  while (start > boundStart && isNameChar(lineText[start - 1])) start--;
  let end = col0;
  while (end < lineText.length && isNameChar(lineText[end])) end++;

  return { start, end, prefix: lineText.slice(start, col0) };
}

/* ============================== 标签目标位 ============================== */

/** 标签槽（0 基区间 + 光标前已输入的残片；可选 `$` 留在区间外） */
export interface ErbLabelSlot {
  /** 名字段起点（0 基，含）——替换范围左界（已跳过可选 `$`） */
  readonly start: number;
  /** 名字段终点（0 基，不含）——向右吃到空白 / `;` 为止 */
  readonly end: number;
  /** 光标前已输入的残片（用于过滤 / 排序） */
  readonly prefix: string;
}

/** 标签名字符：非空白、非 `;`（与定义扫描 `^\s*\$名字` 的正向口径对齐） */
const isLabelChar = (ch: string): boolean => !/[\s;]/.test(ch);

/**
 * 跳转上下文：光标**前文**以 `<分隔>(跳转关键字)` + 空白 + 可选 `$` + 名字残片 收尾。
 * 分隔含行首 / 空白 / `;` / 半角 `:` / 全角 `：`；前缀字符非分隔 ⇒ `TRYCGOTO` 之类的复合词
 * 不误触。空白一律 `BLANK_CLASS_STR` 单源（全角空格算分隔）；关键字取 {@link ERB_JUMP_KEYWORDS}
 * 长词在前。`i` 标志：Emuera 的语句关键字大小写不敏感（`goto 好感` 是合法 ERB）。
 */
const LABEL_CONTEXT_RE = new RegExp(
  `(?:^|[${BLANK_CLASS_STR};:：])(${[...ERB_JUMP_KEYWORDS]
    .sort((a, b) => b.length - a.length)
    .join('|')})[${BLANK_CLASS_STR}]+(\\$?)([^\\s;]*)$`,
  'i',
);

/**
 * 光标处的**标签目标位**（纯函数；`column` = Monaco 的 1 基列）：跳转家族关键字之后、
 * 空白之后（可选 `$`）、名字残片段内 ⇒ 返回名字段 `{start,end,prefix}`；否则 `null`（不猜）。
 * `start` 已跳过可选 `$`（替换范围不含 `$`），`end` 向右吃满标签名字符。
 */
export function erbLabelSlot(line: string, column: number): ErbLabelSlot | null {
  if (!Number.isFinite(column) || column < 1) return null;
  const col0 = Math.min(column - 1, line.length);
  const ctx = LABEL_CONTEXT_RE.exec(line.slice(0, col0));
  if (ctx === null) return null;
  const prefix = ctx[3] ?? '';
  const start = col0 - prefix.length;
  let end = col0;
  while (end < line.length && isLabelChar(line[end]!)) end++;
  return { start, end, prefix };
}

/* ============================== 位置门（v2 九态） ============================== */

/** 代码视野三态（{@link erbCodeViewOf} 的内部口径）：普通代码 / 串内 / `;` 注释内 */
export type ErbCodeView = 'code' | 'string' | 'comment';

/**
 * 光标之前（`[0, col0)`）处于哪种**代码视野**：普通代码 / 字符串字面量内 / `;` 行注释内。
 *
 * 一次线性扫描、**按状态推进**（普通 → 串内 → 注释），不是"先数引号再看分号"——
 * `;` 也会出现在字符串里（`PRINT "a;b"`），两种顺序给出的答案不同（缺陷 1 的根因）。口径：
 * - 普通态：`"` ⇒ 进串；`;` ⇒ 进注释（此点之后一律不是代码）；
 * - 串内态：`""` 是 Emuera 的**字面引号转义**（消费两个字符、状态不变——光标停在成对引号
 *   **中间**时，数引号的旧口径会算出"偶数 ⇒ 串外"从而在字符串里弹代码补全）；单个 `"` ⇒ 出串；
 * - 引号未闭合 ⇒ 「到行尾都是串」（与 `erb-parser` 的 `codeViewOf` 同方向的保守选择）。
 *
 * 导出给真语料活闸（`erb-ternary-paint.corpus.test.ts`）判"这一枚 `%`/`{` 是不是在串里"，
 * 与补全门共用同一把尺子——不另写第二份引号/注释扫描。
 */
export function erbCodeViewOf(lineText: string, col0: number): ErbCodeView {
  let inString = false;
  let i = 0;
  while (i < col0) {
    const ch = lineText[i]!;
    if (inString) {
      if (ch === '"') {
        if (lineText[i + 1] === '"') {
          // 引擎的字面引号转义：消费两个字符、状态不变
          i += 2;
          continue;
        }
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === ';') {
      return 'comment'; // 注释态：此处起不给代码补全
    }
    i++;
  }
  return inString ? 'string' : 'code';
}

/**
 * 光标是否落在 FORM 串内一个**闭合插值区**（`%…%` / `{…}` / `\@…\@`；纯函数，
 * `column` = Monaco 的 1 基列）。K2-3 / 缺陷 ③：串内不再一律零候选——ERB 作者写表达式
 * 最常落的位置就在串里的插值段内（`{条件?真#假}`、`%…%`、内联三元 `\@条件?真#假\@`）。
 *
 * 本函数是 `condition-extractor/src/inline.ts` 判据的**第二实现**（契约禁跨插件 import；
 * 一致性由 `erb-interp-single-source.test.ts` 兜底），但两面的**深度口径有意分歧**：
 * - **一致（字形集）**：`\@` 是两字符字形、按出现序两两配对；`{…}` **引号盲视**且嵌套感知；
 *   只有**最外层**闭合 `{}` 区间算区；**未闭合区不算插值**（宁少不错）。
 * - **分歧 1（括号深度不参与判据）**：串里的内容本来就是文本视野，串在代码侧被包了几层
 *   括号与串内区是不是插值无关（真语料 `CALL COLORMESSAGE(@"%\@ … \@%…", …)` 整条 `@"…"`
 *   是函数实参，串内 `\@…\@` 仍是作者正写的内联三元）。
 * - **分歧 2（花括号深度保留）**：`%` / `\@` 只在 `{…}` 区**外**认——`{…}` 区内是表达式视野
 *   （`{A % B}` 的 `%` 是取模）。
 * - **分歧 3（`%…%` 为补全面独有）**：inline.ts 根本不扫 `%…%`；补全面刻意宽于依赖抽取。
 * - **边界口径（测试钉死）**：光标可停区间 = [开记号之后一列, 闭记号尾之后一列]，含两端
 *   （作者打字序就是「先 `%…%` 再补收尾引号」）。
 */
export function erbInterpRegionAt(lineText: string, column: number): boolean {
  if (!Number.isFinite(column) || column < 1) return false;
  const col0 = Math.min(column - 1, lineText.length);
  // 闭合插值区的**光标可停区间** [lo, hi]（0 基 caret 列）：lo = 开记号尾后一列，
  // hi = 闭记号尾后一列（边界含）；区内判据 = lo <= col0 <= hi
  const regions: { lo: number; hi: number }[] = [];
  let inString = false;
  let braceDepth = 0; // { 深度（引号盲视：串内外一律计数）；括号深度**不**参与，见头注分歧 1
  let topBraceOpen = -1; // 当前最外层 `{` 的索引（深度回 0 时产出闭合区）
  let pctOpen = -1; // 未配对 `%` 的索引（串闭合即丢弃）
  let atOpen = -1; // 未配对 `\@` 字形的起始索引（`\` 位；串闭合即丢弃）
  let i = 0;
  while (i < lineText.length) {
    const ch = lineText[i]!;
    if (inString) {
      if (ch === '"') {
        if (lineText[i + 1] === '"') {
          i += 2;
          continue;
        }
        inString = false;
        pctOpen = -1; // 串闭合：未配对的开记号 = 未闭合区，不算插值
        atOpen = -1;
        i += 1;
        continue;
      }
      if (ch === '\\' && lineText[i + 1] === '@') {
        if (braceDepth === 0 && pctOpen < 0) {
          if (atOpen < 0) atOpen = i;
          else {
            regions.push({ lo: atOpen + 2, hi: i + 2 }); // 闭字形 `\@` 占 i..i+1：尾后一列含入
            atOpen = -1;
          }
        }
        i += 2;
        continue;
      }
      if (ch === '%' && braceDepth === 0 && atOpen < 0) {
        if (pctOpen < 0) pctOpen = i;
        else {
          regions.push({ lo: pctOpen + 1, hi: i + 1 });
          pctOpen = -1;
        }
        i += 1;
        continue;
      }
      // 落穿：串内的 `{` `}` 照下面计数（引号盲视）；`(` `)` `[` `]` 只是文本
    } else if (ch === '"') {
      inString = true;
      i += 1;
      continue;
    } else if (ch === ';') {
      break; // 注释尾巴：此点之后的字形不参与插值配对
    }
    if (ch === '{') {
      if (braceDepth === 0) topBraceOpen = i;
      braceDepth += 1;
    } else if (ch === '}') {
      if (braceDepth > 0) {
        braceDepth -= 1;
        if (braceDepth === 0 && topBraceOpen >= 0) {
          regions.push({ lo: topBraceOpen + 1, hi: i + 1 });
          topBraceOpen = -1;
        }
      }
    }
    i += 1;
  }
  return regions.some((r) => col0 >= r.lo && col0 <= r.hi);
}

/**
 * 判定光标处的补全门类（**纯函数**；`column` = Monaco 的 1 基列）。判定顺序**严格**：
 *
 * a) 非法列 ⇒ `default`；
 * b) 代码视野（串内 / 注释）：注释或「串内且不在闭合插值区」⇒ `in-string`（整轮零候选）；
 *    串内且光标停在 `{…}` / `%…%` / `\@…\@` **闭合区**里 ⇒ `interp-expr`；
 * c) 位坑（{@link erbBitSlotOpen}）⇒ `bit-slot`；
 * d) 行首页首 `#…` / `[…]` 记号位 ⇒ `directive-token`（token 起点 = 从光标向左吃名字字符；
 *    起点之前全空白、记号前一枚字符为 `#` 或 `[`——`PRINT #DIM` 这类行中形态不认）；
 * e) 行首 `@名字` 定义位 ⇒ `def-slot`；
 * f) `CALL` 系名字位 ⇒ `call-target`（光标在语句名之后、且在第一个顶层逗号之前；越过 `(` 或
 *    顶层逗号 ⇒ 本门不命中，流程落到 g/h/i，`CALL FOO, 族:名` 的实参位仍归 `variable-slot`）；
 * g) 跳转家族标签位 ⇒ `label-target`；
 * h) 变量引用末段 ⇒ `variable-slot`；
 * i) 其余 ⇒ `default`。
 */
export function erbCompletionGate(lineText: string, column: number): ErbCompletionGate {
  if (!Number.isFinite(column) || column < 1) return 'default';
  const col0 = Math.min(column - 1, lineText.length);

  // b) 代码视野（缺陷 1）：注释 / 串内非插值位 ⇒ 不给代码补全；扫描按状态推进，
  //    注释里的孤立半角引号不得再把同行代码位一票否决。K2-3（缺陷 ③）例外分支：光标在
  //    串内**闭合插值区** ⇒ `interp-expr`，与 default 同口径不过滤。
  const view = erbCodeViewOf(lineText, col0);
  if (view !== 'code') {
    if (view === 'string' && erbInterpRegionAt(lineText, column)) return 'interp-expr';
    return 'in-string';
  }

  // c) 位坑：位原语第二实参坑「开着且空」
  if (erbBitSlotOpen(lineText, column)) return 'bit-slot';

  // d) 行首 `#…` / `[…]` 记号位：token 起点向左吃名字字符，记号前一枚字符是 `#` / `[`
  let tokStart = col0;
  while (tokStart > 0 && isNameChar(lineText[tokStart - 1])) tokStart--;
  const marker = tokStart > 0 ? lineText[tokStart - 1] : undefined;
  if ((marker === '#' || marker === '[') && isAllBlank(lineText.slice(0, tokStart - 1))) {
    return 'directive-token';
  }

  // e) 定义位：行首 `@` + 名字槽内
  const def = DEF_RE.exec(lineText);
  if (def !== null && parseErbNameSlot(lineText, col0, def[0].length, false) !== null) return 'def-slot';

  // f) 直系调用语句名位（越过 `(` / 顶层逗号 ⇒ 不算 call-target）
  const m = CALL_STMT_RE.exec(lineText);
  if (m !== null && col0 >= m[0].length) {
    const kwEnd = m[0].length;
    // 名字段之后已出现 `(`（`CALL(...)` / `CALLF FOO(...)` 的实参括号）⇒ 光标在表达式里
    const openParen = lineText.indexOf('(', kwEnd);
    // 顶层逗号 = 实参列表起点；光标越过它 ⇒ 实参位
    const comma = topLevelComma(lineText, kwEnd, lineText.length);
    if (!(openParen >= 0 && openParen < col0) && !(comma >= 0 && col0 > comma)) return 'call-target';
  }

  // g) 跳转家族标签位（`JUMP` / `GOTO` / `TRYJUMP` / `TRYGOTO` + 空白之后）
  if (erbLabelSlot(lineText, column) !== null) return 'label-target';

  // h) 变量引用末段（族头 ∈ ENGINE_VARIABLE_FAMILIES）
  if (erbVariableSlotAt(lineText, column) !== null) return 'variable-slot';

  return 'default';
}

/* ============================== 白名单数据（装配层消费：按 sourceId 过滤） ============================== */

/**
 * 门 → **只留这些 source** 的白名单（装配层的 keep 滤器消费；缺键 = 不过滤）。
 *
 * 语义：白名单门只保留名单内 source 的候选；`default` / `in-string` / `interp-expr` **不设**
 * （`in-string` 本就整轮零候选；`interp-expr` = "走 default 的白名单"，即不过滤的表达式候选
 * 全集——给它配一份名单就是把 default 抄成第二份真相）。
 */
export const ERB_GATE_SOURCE_WHITELIST: Readonly<
  Partial<Record<ErbCompletionGate, ReadonlySet<string>>>
> = {
  'call-target': new Set(['erb-functions']),
  'def-slot': new Set(['erb-functions']),
  'label-target': new Set(['erb-labels']),
  'variable-slot': new Set(['erb-variables']),
  'bit-slot': new Set(['erb-bits']),
  'directive-token': new Set(['erb-directives']),
};