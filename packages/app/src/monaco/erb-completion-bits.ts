import type * as Monaco from './entry';
import type { VariableSchema } from '@kojo/plugin-api';
import {
  erbBitSlotOpen,
  erbBitSlotRegionBlank,
  findBitSlot,
  matchingParen,
  topLevelComma,
} from '@kojo/plugin-erb-parser';

export { erbBitSlotOpen, findBitSlot, matchingParen, topLevelComma };

/**
 * D7 · `.erb` 正文里的**位补全 + 位名悬停**。
 *
 * Emuera 位原语**四件套**（位号可为数字，也可为变量，实证 `GETBIT(HOLD, LOCAL)`）：
 * - 表达式形：`GETBIT(变量, 位)`（第二实参坑）；
 * - 语句形（无括号）：`SETBIT 变量, 位` / `CLEARBIT 变量, 位` / `INVERTBIT 变量, 位`
 *   （逗号之后）。
 * `CHECKBIT` 不存在——不认（**不猜**）。
 *
 * 候选 = 第一实参变量在 `VariableSchema` 里的 `VariableInfo.bits`
 * （`ReadonlyArray<{ bit: number; label: string }>`，契约槽位见 `@kojo/plugin-api`）。
 * 位表由 adapter 提供；本层**只读不解释**、**零产出即零候选**（表缺席 / 无位表 ⇒ `[]`，
 * 绝不静默生成假位号）。
 *
 * 位置判据（严格，**严禁**泛化成「任意逗号后就是位」）：命中时还须满足
 * ①光标落在**该原语的第二实参区间内**；②该区间此刻**为空**（纯空白）——作者一旦写了
 * 内容（含把位号写成变量 `LOCAL`）就**不抢候选**（作者写变量不得被打扰）。
 * ①+② 合成单一判据 `erbBitSlotOpen`（导出；位置门 / 触发探针消费，签名定死），
 * 与候选门共用同一条内部空判据——**禁止各写一份**。
 *
 * 第一实参的切法（批⑧）：Emuera 变量引用可以是两段式 `族:索引`，也可以是**三段式**
 * `族:角色:名`（`TALENT:TARGET:性別` / `TCVAR:TARGET:随便`，真语料 78 处）——中段是
 * **角色 / 作用域表达式**，**名字在末段**；而 adapter 的 `lookup(variableName, index)`
 * （`eratw-adapter/variable-schema.ts` 名称表分支）只把**单段名**交给 `byIndex` / `byName`
 * 查表 ⇒ 整段 `TARGET:性別` 当索引必然查不中（这是一批位表全空的根因）。故切法**定死**为：
 * 族 = 第一个冒号前段，索引 = 最后一个冒号后段（无冒号 = 裸族头，索引缺省）；
 * 两段式首末冒号同一条 ⇒ 与旧切法逐字等价（零行为变化）。
 *
 * 与既有各 source 同纪律：纯函数 + 薄 Monaco 翻译、只读模型、不产生编辑、不发事件；
 * provider 注册不在本模块——编排层把它接进补全基座（`erb-completion.ts`）与悬停基座
 * （`kojo-hover.ts`）。
 *
 * ## 2026-10-30（LAU-4 续）：位槽**判据**已搬进包，本文件只剩候选与悬停的形状翻译
 *
 * `findBitSlot` / `erbBitSlotOpen` / `matchingParen` / `topLevelComma` / `ErbBitSlot` 整块
 * 搬到判据家（2026-10-31 起是常驻插件 `@kojo/plugin-erb-parser` 的 `src/completion.ts`，此前
 * 在 `@kojo/erb-lang/completion-bits`）——"光标是不是停在空的位坑里"是**语言事实**，位置门
 * 与插件供方都要吃同一份，而插件读不到宿主。本文件的 import 与 re-export 摆在同一处
 * （四枚旧导出的名字与签名一字未改，既有 import 点与测试零改动）。
 */

/** 位原语单字 → 语句形（无括号）还是表达式形（带括号） */
const BIT_PRIMITIVES = /\b(GETBIT|SETBIT|CLEARBIT|INVERTBIT)\b/gi;

/** 位名悬停命中（1 基列区间，供 hover 高亮） */
export interface ErbBitHoverHit {
  /** 中文位名（`VariableInfo.bits[].label` 原文） */
  readonly name: string;
  /** 位号 */
  readonly bit: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

export type { ErbBitSlot } from '@kojo/plugin-erb-parser';

/**
 * 把第一实参变量引用解析成 `VariableInfo.bits`（**纯函数**；段切法见文件头注）。
 * 族 = 第一个冒号前段；索引 = **最后一个**冒号后段（无冒号 = 裸族头 ⇒ `index` 缺省）。
 * 依据：adapter `lookup` 按**单段名**查 `byIndex` / `byName`，三段式中段是角色表达式、
 * 名字在末段；两段式首末冒号同一条 ⇒ 与旧切法逐字等价。
 * 查不到 / 无位表 / 抛错 ⇒ `undefined`（**不猜**，绝不静默造位号）。
 */
function resolveBits(
  schema: VariableSchema,
  variableRef: string,
): ReadonlyArray<{ bit: number; label: string }> | undefined {
  if (variableRef.length === 0) return undefined;
  const first = variableRef.indexOf(':');
  const last = variableRef.lastIndexOf(':');
  const name = first < 0 ? variableRef : variableRef.slice(0, first);
  const index = last < 0 ? undefined : variableRef.slice(last + 1);
  let bits: ReadonlyArray<{ bit: number; label: string }> | undefined;
  try {
    bits = schema.lookup(name, index)?.bits;
  } catch {
    return undefined;
  }
  return bits !== undefined && bits.length > 0 ? bits : undefined;
}

/**
 * 产出位槽的补全候选（**纯函数**，供补全基座调用）。
 *
 * 行为：仅当光标落在四种位原语的第二实参坑、且该坑**为空**（纯空白）时，取第一实参
 * 变量在 `schema` 里的 `bits`，逐位产出候选——`label` = `位号 中文位名`、`insertText` = 位号、
 * `kind` = `EnumMember`、`documentation` = 中文位名、`detail` = 变量引用原文。
 * 非位槽 / 坑内有内容（含写成变量）/ 无位表 / `schema` 缺省 ⇒ `[]`（不猜、不抛）。
 */
export function erbBitCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  schema: VariableSchema | undefined,
): Monaco.languages.CompletionItem[] {
  if (!schema) return [];
  if (!Number.isFinite(position.lineNumber) || position.lineNumber < 1) return [];
  if (!Number.isFinite(position.column) || position.column < 1) return [];

  const line = model.getLineContent(position.lineNumber);
  const slot = findBitSlot(line, position.column);
  if (slot === null) return [];
  // 位坑已有内容（作者写了位号 / 写成变量 `LOCAL`）⇒ 不抢候选（不打扰作者写变量）
  if (!erbBitSlotRegionBlank(line, slot)) return [];

  const bits = resolveBits(schema, slot.variableRef);
  if (bits === undefined) return [];

  const range: Monaco.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: position.column,
    endColumn: position.column,
  };
  const items: Monaco.languages.CompletionItem[] = [];
  const seen = new Set<string>();
  for (const b of bits) {
    const label = `${b.bit} ${b.label}`;
    if (seen.has(label)) continue;
    seen.add(label);
    items.push({
      label,
      kind: monaco.languages.CompletionItemKind.EnumMember,
      insertText: String(b.bit),
      detail: slot.variableRef,
      documentation: b.label,
      range,
      sortText: `${String(b.bit).padStart(4, '0')}_${label}`,
    });
  }
  return items;
}

/**
 * 解析光标下**位槽里的位号** → 中文位名（**纯函数**，供悬停基座调用）。
 *
 * 返回 `undefined` = 该处没有可显示的位名（**不猜**：非位槽 / 光标不在数字上 /
 * 第一实参变量查不到位表 / 位号不在表内，一律不显示）。
 */
export function erbBitHoverName(
  lineText: string,
  column: number,
  schema: VariableSchema | undefined,
): ErbBitHoverHit | undefined {
  if (!schema) return undefined;
  const slot = findBitSlot(lineText, column);
  if (slot === null) return undefined;
  const col0 = Math.min(column - 1, lineText.length);

  // 光标所在（或紧邻）的**数字串**，须整体落在位槽区间内
  let start = col0;
  while (start > slot.regionStart && isDigit(lineText[start - 1]!)) start--;
  let end = col0;
  while (end < slot.regionEnd && isDigit(lineText[end]!)) end++;
  if (start === end) return undefined;
  const token = lineText.slice(start, end);
  if (!/^\d+$/.test(token)) return undefined;

  const bits = resolveBits(schema, slot.variableRef);
  if (bits === undefined) return undefined;
  const bit = Number(token);
  const entry = bits.find((b) => b.bit === bit);
  if (entry === undefined) return undefined;
  return { name: entry.label, bit, startColumn: start + 1, endColumn: end + 1 };
}
