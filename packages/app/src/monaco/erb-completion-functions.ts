import type * as Monaco from './entry';
import { projectFunctionCandidates, type CompletionNameSlot } from './completion-core';

/**
 * EC-3 · `.erb` **函数名补全** —— 定义位（行首 `@<前缀>`）与调用位
 * （`CALL` / `CALLFORM` / `TRYCALL` / `TRYCALLFORM` / `TRYCALLFORMF` / `TRYCCALLFORM` /
 * `JUMP` … 之后）弹出项目函数名候选。
 *
 * 名字来源 = 基座传入的 `functionNames`（`ErbIndex.byName` 的键，按 `fingerprint` 记忆化）；
 * 本模块**不读盘、不 import 内核 / 插件**，只做**本方言的位置判定**：
 * 哪些列是"名字槽"（`@` 之后 / 调用关键字之后 / FORM 串的插值例外）是 ERB 语法知识，
 * 归本文件；**槽里怎么出货**（前缀二分索引、大小写归一、千条上限、按数组身份记忆化）
 * 一律吃 `completion-core.projectFunctionCandidates` 那一份实现——`.kojo` 的
 * `kojo-completion-functions.ts` 用的是同一份，两语言不再各抄一遍索引。
 * Monaco provider 注册刻意不在此处——编排层负责把本函数接进补全基座。
 *
 * 前缀匹配**大小写不敏感**（Emuera 函数名大小写不敏感，与 `ErbIndex.normalizedName` 同口径）。
 *
 * 纯函数 + 薄 Monaco 翻译（纪律同 `kojo-completion-faces.ts`）：位置不符 / 名字表缺省
 * ⇒ 返回 `[]`，**绝不猜、绝不抛**。
 */

/** 名字字符集（正向定义；ASCII 词字符 + 假名 + 汉字 + 全角字母数字 + 半角片假名） */
const NAME_CHAR_RE =
  /[0-9A-Za-z_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff10-\uff19\uff21-\uff3a\uff41-\uff5a\uff66-\uff9f]/;

/** 定义位：行首可选空白 + `@`（`@` 之后即函数名） */
const DEF_RE = /^[ \t]*@/;

/**
 * 调用位关键字（长词在前；`i` 使指令大小写不敏感）。
 * `FORM` 类关键字（含 `FORM` 子串）后的名字槽是 FORM 串，可含 `%…%` / `{…}` 段。
 */
const CALL_RE =
  /^[ \t]*(TRYCALLFORMF|TRYCALLFORM|TRYCCALLFORM|CALLFORML|CALLFORMF|CALLFORM|CALLL|CALLF|CALL|TRYCALL|TRYJUMP|JUMP)[ \t]+/i;

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
 * 解析「名字槽」里的补全位置（**纯函数**；`col0` = 0 基列）。
 *
 * `boundStart` = 名字槽左界（`@` 之后 / 调用关键字 + 空白之后）；名字槽右界 = 该界之后
 * 第一个 `(` / `;` / 空白。返回 `null` = 该处不是可补全的名字位置：
 * 光标越过槽右界 / 非 `allowInterp` 槽里混入非名字字符 / `allowInterp` 槽里光标严格停在
 * 未闭合插值内——**一律不猜**。
 */
function parseNameSlot(
  lineText: string,
  col0: number,
  boundStart: number,
  allowInterp: boolean,
): CompletionNameSlot | null {
  if (col0 < boundStart) return null;

  let slotEnd = boundStart;
  while (slotEnd < lineText.length) {
    const ch = lineText[slotEnd]!;
    if (ch === '(' || ch === ';' || ch === ' ' || ch === '\t') break;
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

/**
 * 光标处的 ERB **函数名槽**（定义位 `@…` 或 `CALL` 系调用位；纯函数，可单测）。
 * 位置不符 ⇒ `null`（不猜）。`FORM` 类关键字后的槽允许 `%…%` / `{…}` 段。
 */
export function erbFunctionNameSlot(line: string, column: number): CompletionNameSlot | null {
  const col0 = Math.min(Math.max(column - 1, 0), line.length);
  const def = DEF_RE.exec(line);
  if (def !== null) return parseNameSlot(line, col0, def[0].length, false);
  const call = CALL_RE.exec(line);
  if (call !== null) {
    const allowInterp = call[1]!.toUpperCase().includes('FORM');
    return parseNameSlot(line, col0, call[0].length, allowInterp);
  }
  return null;
}

/**
 * 产出 `.erb` 函数名补全候选（**纯函数**，供补全基座调用）。
 *
 * 行为：仅当光标落在**定义位**（行首 `@` 之后的名字槽）或**调用位**（`CALL` 系 / `JUMP`
 * 之后的名字槽，FORM 关键字允许 `%…%` / `{…}` 段）时产出候选；名字取自 `functionNames`
 * （唯一真源，由基座传入），`kind` = `Function`，`insertText` = 名字（定义位**不再插
 * `@`**——`@` 已在文里），替换范围**只覆盖名字那一段**；排序受控（前缀精确优先，其次按名）。
 * 位置不符 / `functionNames` 缺省或为空 ⇒ 返回 `[]`，不抛。
 */
export function erbFunctionCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  functionNames: readonly (string | { name: string; file?: string })[] | undefined,
): Monaco.languages.CompletionItem[] {
  if (!monaco || !model || !position) return [];
  const { lineNumber, column } = position;
  if (!Number.isFinite(lineNumber) || lineNumber < 1) return [];
  if (!Number.isFinite(column) || column < 1) return [];
  return projectFunctionCandidates(
    monaco,
    functionNames,
    erbFunctionNameSlot(model.getLineContent(lineNumber), column),
    lineNumber,
  );
}
