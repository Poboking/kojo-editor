/**
 * T6 · `.erb` 补全的**位置门 v2**（纯逻辑，零 Monaco 依赖）。
 *
 * 门类（{@link ErbCompletionGate}；判定顺序见 {@link erbCompletionGate}，严格）：
 * - `'in-string'`：光标**不在代码视野**里——落在字符串字面量内部（引号配平为奇；FORM 串同形，
 *   `""` 是 Emuera 的字面引号转义），或落在 `;` 起、到行尾的**行注释**里 ⇒ 整轮零候选；
 * - `'bit-slot'`：位原语（`GETBIT` / `SETBIT` / `CLEARBIT` / `INVERTBIT`）第二实参坑**开着且空**
 *   （{@link erbBitSlotOpen}）⇒ 只留 `erb-bits`；
 * - `'directive-token'`：行首 `#…` / `[…]` 记号位（token 起点之前全空白、记号前一枚字符为
 *   `#` 或 `[`）⇒ 只留 `erb-directives`；
 * - `'def-slot'`：行首 `@名字` 定义位（{@link parseErbNameSlot} 非空）⇒ 只留 `erb-functions`；
 * - `'call-target'`：**直系调用**语句名（`CALL` / `CALLL` / `CALLF` / `TRYCALL`，见
 *   {@link ERB_CALL_STATEMENTS}）之后、同一行第一个**顶层逗号**之前 ⇒ 只留 `erb-functions`；
 * - `'label-target'`：跳转家族（{@link ERB_JUMP_KEYWORDS}）目标位（{@link erbLabelSlot} 非空）
 *   ⇒ 只留 `erb-labels`；
 * - `'variable-slot'`：变量引用末段（族头 ∈ `ENGINE_VARIABLE_FAMILIES`，判据
 *   {@link erbVariableSlotAt}）⇒ 只留 `erb-variables`；
 * - `'default'`：其余位置 ⇒ 维持现行为（全部 source 照旧）。
 *
 * 缺陷 2 的旧口径是「按候选 **kind** 过滤」：同为 `Function` kind 的系统函数（`GETBIT` / `RAND` …）
 * 混进 CALL 位，`@` / `#` / `[` 位混入系统函数与行中关键字，`JUMP` / `GOTO` 位混入函数名。v2 把
 * 过滤口径改为**按候选源白名单**（数据 = {@link ERB_GATE_SOURCE_WHITELIST}；消费方 = 装配层
 * `erb-completion.ts` 的 keep 滤器，按 `sourceId` 执行）：门是**过滤**不是重排——各 source 自带的
 * 排序语义原样不动；`default` / `in-string` 不设名单（不新增过滤）。
 *
 * 分工纪律：
 * - 逗号 / 字符串扫描**复用** `erb-completion-bits` 的既有解析件（`topLevelComma`；位坑判据
 *   `erbBitSlotOpen` 同源）；变量引用判据复用 `erb-completion-variables` 的 `erbVariableSlotAt`；
 *   标签位判据（{@link erbLabelSlot}）在本文件**单源导出**、`erb-completion-labels.ts` 消费
 *   ——先例件各处共用一份，禁止抄第二份；
 * - 空白类走 `kojo-completion-position` 的 `BLANK_CLASS_STR` **单源**（与 `kojo-sugar` lexer
 *   同口径），本文件不再手写 `[ \t]`；
 * - 「语句关键字 + 名字槽种类」与「名字槽解析」在本文件**只声明一份**（{@link ERB_CALL_STATEMENTS} /
 *   {@link parseErbNameSlot}），候选源 `erb-completion-functions.ts` 复用同一张表 + 同一个解析器；
 * - 判据仍是**纯函数、零 IO、不依赖 parser**（本模块既有纪律；走 parser 的取舍另记，本批不动
 *   架构路线）。
 */

import { erbBitSlotOpen, topLevelComma } from './erb-completion-bits';
import type { CompletionNameSlot } from './completion-core';
import { erbVariableSlotAt } from './erb-completion-variables';
import { BLANK_CLASS_STR, isAllBlank, isBlank } from './kojo-completion-position';

/**
 * 补全位置门（v2 八态；见模块头注）。`'in-string'` 的门名沿用 = 「此处非代码视野」，注释一并复用
 * ——消费方 `erb-completion.ts` 的 `locate`（`in-string` ⇒ 整轮零候选）不必新增分支。
 */
export type ErbCompletionGate =
  | 'call-target'
  | 'def-slot'
  | 'label-target'
  | 'variable-slot'
  | 'bit-slot'
  | 'directive-token'
  | 'in-string'
  | 'default';

/**
 * 语句关键字之后那一位的**槽种类**（{@link ERB_CALL_STATEMENTS} 的分类字段）：
 * 门与候选源按各自口径消费（见清单注）。
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
 * 分类依据（与 `erb-parser/src/references.ts` 的可见性口径同向——那里把「参数位就是函数名」
 * 的直系族单列成 `CALL_FAMILY`，并明示 `JUMP`/`GOTO` 目标是标签、`*FORM*` 参数是表达式）：
 * - `'func'`：**直系调用**，名字位就是函数名 ⇒ 门 `'call-target'`（只留 `erb-functions`）；
 * - `'form'`：`*FORM*` 全族，名字位是**表达式**（FORM 串，可含 `%…%` / `{…}` 插值）⇒ 候选源
 *   照常在该位出货（插值例外），但**不设门**（`default`）——那里不是函数名槽，收窄成「只给函数名」
 *   会砍掉表达式该有的一整片子集（现状判据见既有 `CALLFORM → default` 用例）；
 * - `'label'`：跳转家族（{@link ERB_JUMP_KEYWORDS}，与解析器 `JUMP_FAMILY` 实名对齐），目标是
 *   行号 / `$标签` ⇒ 门 `'label-target'`（只留 `erb-labels`）；函数名候选源**不再认**这两位
 *   （本批口径：JUMP / GOTO 位只出标签候选——旧行为「JUMP 位出函数名」是有意变更，见函数源头注）。
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
 * `JUMP_FAMILY = {'JUMP','GOTO','TRYJUMP','TRYGOTO'}`）。标签位判据 {@link erbLabelSlot} 与
 * 候选源 `erb-completion-labels.ts` **共用这一份**。
 */
export const ERB_JUMP_KEYWORDS: readonly string[] = ['JUMP', 'GOTO', 'TRYJUMP', 'TRYGOTO'];

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

/* ============================== 名字槽（定义位 / 调用位共用；原 `erb-completion-functions` 私有件迁入） ============================== */

/** 名字字符集（正向定义；ASCII 词字符 + 假名 + 汉字 + 全角字母数字 + 半角片假名） */
export const NAME_CHAR_RE =
  /[0-9A-Za-z_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff10-\uff19\uff21-\uff3a\uff41-\uff5a\uff66-\uff9f]/;

/** 定义位：行首可选空白 + `@`（`@` 之后即函数名）；空白类走 `BLANK_CLASS_STR` 单源 */
export const DEF_RE = new RegExp(`^[${BLANK_CLASS_STR}]*@`);

function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && NAME_CHAR_RE.test(ch);
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
 * 判据的**单源**（原 `erb-completion-functions.ts` 私有件迁入；行为逐字保留）。
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
): CompletionNameSlot | null {
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

/* ============================== 标签目标位（原 `erb-completion-labels` 的 JUMP_CONTEXT_RE 迁入） ============================== */

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
 * 分隔含行首 / 空白 / `;` / 半角 `:` / 全角 `：`（覆盖缩进行首与 `SIF … : GOTO …` 行内形态）；
 * 前缀字符非分隔 ⇒ `TRYCGOTO` 之类的复合词不误触。空白一律 `BLANK_CLASS_STR` 单源
 * （全角空格算分隔——旧 `[ \t]+` 不认）；关键字取 {@link ERB_JUMP_KEYWORDS} 长词在前。
 */
const LABEL_CONTEXT_RE = new RegExp(
  `(?:^|[${BLANK_CLASS_STR};:：])(${[...ERB_JUMP_KEYWORDS]
    .sort((a, b) => b.length - a.length)
    .join('|')})[${BLANK_CLASS_STR}]+(\\$?)([^\\s;]*)$`,
);

/**
 * 光标处的**标签目标位**（纯函数；`column` = Monaco 的 1 基列）。语义 = `erb-completion-labels.ts`
 * 既有 `JUMP_CONTEXT_RE` 判据的**单源迁入**（该文件改为 import 本函数）：跳转家族关键字之后、
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

/* ============================== 位置门（v2 八态） ============================== */

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
 * 判定光标处的补全门类（**纯函数**；`column` = Monaco 的 1 基列）。判定顺序**严格**：
 *
 * a) 非法列 ⇒ `default`；
 * b) 代码视野（串内 / 注释）⇒ `in-string`——此时不再看语句前缀，串与注释里没有语句；
 * c) 位坑（{@link erbBitSlotOpen}：位原语第二实参坑开着且空）⇒ `bit-slot`；
 * d) 行首页首 `#…` / `[…]` 记号位 ⇒ `directive-token`（token 起点 = 从光标向左吃名字字符；
 *    起点之前全空白、记号前一枚字符为 `#` 或 `[`——`PRINT #DIM` 这类行中形态不认）；
 * e) 行首 `@名字` 定义位（{@link parseErbNameSlot} 非空）⇒ `def-slot`；
 * f) `CALL` 系（`'func'` 槽）名字位 ⇒ `call-target`：**既有判定逐字保留**——光标在语句名之后
 *    （含紧贴语句名尾）、且在第一个顶层逗号之前（无逗号 = 到行尾都是名字位）；越过 `(` 或顶层
 *    逗号 ⇒ **本门不命中**，流程落到 g/h/i（`CALL FOO, CFLAG:好` 这类实参位里的变量槽仍归
 *    `variable-slot`；既有钉住的 default 用例输入均不含标签 / 变量形态，结论逐字不变）；
 * g) 跳转家族标签位（{@link erbLabelSlot} 非空）⇒ `label-target`；
 * h) 变量引用末段（{@link erbVariableSlotAt} 非空）⇒ `variable-slot`；
 * i) 其余 ⇒ `default`。
 */
export function erbCompletionGate(lineText: string, column: number): ErbCompletionGate {
  if (!Number.isFinite(column) || column < 1) return 'default';
  const col0 = Math.min(column - 1, lineText.length);

  // b) 代码视野（缺陷 1）：串内（含 `""` 转义）/ `;` 注释 ⇒ 不给代码补全；
  //    扫描按状态推进，注释里的孤立半角引号不得再把同行代码位一票否决。
  if (erbCodeViewBlocked(lineText, col0)) return 'in-string';

  // c) 位坑：位原语第二实参坑「开着且空」（判据与位候选同源，零 Monaco 依赖）
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

  // f) 直系调用语句名位（既有判定逐字保留；越过 `(` / 顶层逗号 ⇒ 不算 call-target）
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
 * 门 → **只留这些 source** 的白名单（装配层 `erb-completion.ts` 的 keep 滤器消费；缺键 = 不过滤）。
 *
 * 语义：白名单门只保留名单内 source 的候选；`default` / `in-string` **不设**（`in-string` 本就
 * 整轮零候选）。门是过滤不是重排——各 source 的排序 / 去重语义原样不动。
 */
export const ERB_GATE_SOURCE_WHITELIST: Readonly<Partial<Record<ErbCompletionGate, ReadonlySet<string>>>> = {
  'call-target': new Set(['erb-functions']),
  'def-slot': new Set(['erb-functions']),
  'label-target': new Set(['erb-labels']),
  'variable-slot': new Set(['erb-variables']),
  'bit-slot': new Set(['erb-bits']),
  'directive-token': new Set(['erb-directives']),
};