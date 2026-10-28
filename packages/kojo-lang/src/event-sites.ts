/**
 * 2.0 **事件挂点**的唯一投影：`# 机 <事件>` 与 `@织 <事件>` 的名字段（LAU-D2）。
 *
 * ## 为什么要有这一枚叶子
 *
 * 事件名是**方言事实**的第一个落点（§5.5 第 1、2 行）：引用面（`kojo2-references`）要按它
 * 归符号、悬停要讲它、`dialect lint` 要拿它去对 `eventCatalog`。三处若各自扫一遍字符串，
 * 迟早漂成"补全按一种前缀算、诊断按另一种算"。所以判据只此一份，三个消费方 import 同一枚。
 *
 * ## 判据从哪来（不是字符串扫描）
 *
 * 事件行由**core 词法行**认：`decl` + `word === KOJO_DECL_WORDS[2]`（`# 机`）或
 * `dispatch` + `word === KOJO_DISPATCH_WORDS[9]`（`@织`），且该词在 2.0 词表内（`known`）。
 * 名字段取 `splitSpaces(line.rest, line.restOffset)[0]`——与 core parser 取事件名的那一行
 * **同一个函数、同一份偏移**（`parser.ts::parseMachineDecl` / `parseWeaveDecl` 都是
 * `splitSpaces(...)[0].text`），所以"哪个词算事件名"不存在第二套判据。
 *
 * 特意**不**复用 `completion.ts` 的 `machineEventSlotPrefix`：那是**光标位**的判据
 * （"光标此刻是不是在写事件名"），只在光标那一行上成立；本模块回答的是"这一篇里有哪些
 * 事件挂点"，两者用途不同。共用的是更下面那一层（core 词法行 + `splitSpaces`）。
 *
 * ## 为什么住在包不住宿主（B3c 车道 2 搬入）
 *
 * 这枚叶子的三个消费方里，**两个不是 Monaco 面**（引用面、方言 lint），而第三个（悬停）的
 * 供方从 B3c 起是插件——插件读不到 `packages/app/src/**`。判据留在宿主就等于逼每个消费方
 * 各抄一份（正是本文件头注要防的那件事）。搬入是**纯搬家**：判据、偏移、导出名一字未动，
 * 只有 `Kojo2Document` 的 import 从包桶改成同包相对路径。
 */

import {
  KOJO_DECL_WORDS,
  KOJO_DISPATCH_WORDS,
  splitSpaces,
  type KojoLexLine,
} from '@kojo/kojo-core';
import type { Kojo2Document } from './declarations';

/** `# 机`（声明词，core 位序 §3.3） */
const MACHINE_WORD = KOJO_DECL_WORDS[2];
/** `@织`（调度词，core 位序 §2.1） */
const WEAVE_WORD = KOJO_DISPATCH_WORDS[9];

/**
 * 一处事件挂点（1 基列、尾列半开；与 Monaco / core / plugin-api 同口径）。
 *
 * `machine`：`true` = `# 机`（本文件挂到该事件上，声明位）；`false` = `@织`（监听位）。
 */
export interface Kojo2EventSite {
  readonly name: string;
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly machine: boolean;
}

/**
 * 一行的事件名（`# 机` / `@织` 之后的第一个词）。
 *
 * 不是事件行 / 没写名字（裸 `# 机`、`@织` 后面空着）⇒ `null`：那两种形状由 parser 报
 * `core/lex/anchor`，本模块**不替它猜一个事件名**（猜出来的名字会让"未知事件"诊断指空）。
 */
function eventNameOf(
  line: KojoLexLine,
): { readonly name: string; readonly offset: number; readonly machine: boolean } | null {
  let machine: boolean;
  if (line.kind === 'decl' && line.known && line.word === MACHINE_WORD) machine = true;
  else if (line.kind === 'dispatch' && line.known && line.word === WEAVE_WORD) machine = false;
  else return null;
  const first = splitSpaces(line.rest, line.restOffset)[0];
  if (first === undefined || first.text.length === 0) return null;
  return { name: first.text, offset: first.offset, machine };
}

/**
 * 这一篇的全部事件挂点（源码序：行 → 列）。
 *
 * 只吃 `kojo2DocumentOf` 的**同一份词法行**（它已经跑过 `lex` + `parse`）：调用方拿文档索引
 * 进来，本函数不再解析一次。`@原生` 体内 / 台词正文里的 `# 机` 不是 `decl` 行，天然不进表。
 */
export function kojo2EventSitesOf(document: Kojo2Document): Kojo2EventSite[] {
  const out: Kojo2EventSite[] = [];
  for (const line of document.lines) {
    const event = eventNameOf(line);
    if (event === null) continue;
    const startColumn = event.offset - line.lineOffset + 1;
    out.push({
      name: event.name,
      line: line.number,
      startColumn,
      endColumn: startColumn + event.name.length,
      machine: event.machine,
    });
  }
  return out;
}

/**
 * 光标处的事件挂点（1 基列；尾列按**可停靠**算：光标停在名字后一位仍算在这一枚上，
 * 与 `kojo2-references` 的位点归属同一条口径——作者点名字末尾不该"什么都查不到"）。
 */
export function kojo2EventSiteAt(
  sites: readonly Kojo2EventSite[],
  line: number,
  column: number,
): Kojo2EventSite | null {
  const col0 = column - 1;
  for (const site of sites) {
    if (site.line !== line) continue;
    if (col0 >= site.startColumn - 1 && col0 <= site.endColumn - 1) return site;
  }
  return null;
}
