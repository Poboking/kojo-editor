import type * as Monaco from './entry';
import { projectFunctionCandidates, type CompletionNameSlot } from './completion-core';
import {
  DEF_RE,
  ERB_CALL_SLOT_BY_KEYWORD,
  erbCallStatementRe,
  parseErbNameSlot,
} from './erb-completion-context';

/**
 * EC-3 · `.erb` **函数名补全** —— 定义位（行首 `@<前缀>`）与调用位
 * （`CALL` 系 / `*FORM*` 系之后）弹出项目函数名候选。
 *
 * 「哪些语句之后那一位算名字位」**不在本文件声明**——单源是 `erb-completion-context.ts`
 * 的 `ERB_CALL_STATEMENTS`（门与候选源共用同一张表，缺陷 2 的分叉由此消掉）；
 * 本文件只按槽种类决定**那一位里能不能有插值**（`'form'` 槽可以，`'func'` 槽不行）。
 *
 * 跳转家族（`JUMP` / `GOTO` / `TRYJUMP` / `TRYGOTO`，槽种类 `'label'`）**连调用位都不认**：
 * 那里是标签目标，候选归 `erb-completion-labels.ts`、门归 `'label-target'`（本批口径：
 * JUMP / GOTO 位只出标签候选；旧行为「JUMP 位出函数名」是有意变更）。
 *
 * 名字来源 = 基座传入的 `functionNames`（`ErbIndex.byName` 的键，按 `fingerprint` 记忆化）；
 * 本模块**不读盘、不 import 内核 / 插件**，只做**本方言的位置判定**：
 * 哪些列是"名字槽"（`@` 之后 / 调用关键字之后 / FORM 串的插值例外）是 ERB 语法知识，
 * 判据实现（`DEF_RE` / `parseErbNameSlot`）单源在 `erb-completion-context.ts`，本文件只引用；
 * **槽里怎么出货**（前缀二分索引、大小写归一、千条上限、按数组身份记忆化）
 * 一律吃 `completion-core.projectFunctionCandidates` 那一份实现——`.kojo` 的
 * `kojo-completion-functions.ts` 用的是同一份，两语言不再各抄一遍索引。
 * Monaco provider 注册刻意不在此处——编排层负责把本函数接进补全基座。
 *
 * 前缀匹配**大小写不敏感**（Emuera 函数名大小写不敏感，与 `ErbIndex.normalizedName` 同口径）。
 *
 * 纯函数 + 薄 Monaco 翻译（纪律同 `kojo-completion-faces.ts`）：位置不符 / 名字表缺省
 * ⇒ 返回 `[]`，**绝不猜、绝不抛**。
 */

/**
 * 调用位（长词在前 + 关键字后必须有空白，装配见 `erbCallStatementRe`）；只吃 `'func'` / `'form'`
 * 槽——`'label'` 槽（跳转家族）是标签位，不在本源的职责内。语句清单由 `ERB_CALL_STATEMENTS`
 * 单源给出，本处**不再自持一份**。
 */
const CALL_RE = erbCallStatementRe(['func', 'form'], true);

/**
 * 光标处的 ERB **函数名槽**（定义位 `@…` 或调用位；纯函数，可单测）。
 * 位置不符 ⇒ `null`（不猜）。槽种类查 `ERB_CALL_SLOT_BY_KEYWORD`：`'form'`（`*FORM*` 全族）
 * 之后的槽是 FORM 串，允许 `%…%` / `{…}` 段；`'func'` 之后的槽只收名字字符。
 */
export function erbFunctionNameSlot(line: string, column: number): CompletionNameSlot | null {
  const col0 = Math.min(Math.max(column - 1, 0), line.length);
  const def = DEF_RE.exec(line);
  if (def !== null) return parseErbNameSlot(line, col0, def[0].length, false);
  const call = CALL_RE.exec(line);
  if (call !== null) {
    const allowInterp = ERB_CALL_SLOT_BY_KEYWORD.get(call[1]!.toUpperCase()) === 'form';
    return parseErbNameSlot(line, col0, call[0].length, allowInterp);
  }
  return null;
}

/**
 * 产出 `.erb` 函数名补全候选（**纯函数**，供补全基座调用）。
 *
 * 行为：仅当光标落在**定义位**（行首 `@` 之后的名字槽）或**调用位**（`CALL` 系 / `*FORM*` 系
 * 之后的名字槽，`'form'` 槽允许 `%…%` / `{…}` 段）时产出候选；名字取自 `functionNames`
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