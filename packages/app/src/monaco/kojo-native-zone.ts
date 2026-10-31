import type * as Monaco from './entry';
import { classifyLine, splitLogicalLines, type LineClass } from '@kojo/kojo-vocab/lexer';
import { erbCompletionGate, erbLabelSlot } from '@kojo/plugin-erb-parser';
import { erbBitSlotOpen } from './erb-completion-bits';
import { erbFunctionNameSlot } from './erb-completion-functions';
import { erbVariableSlotAt } from './erb-completion-variables';
import { lineAt } from './kojo-completion-position';

/**
 * SUGGEST-2A · `.kojo` **原生区**判定（补全跨装配路由的位置判据；纯函数、零 IO）。
 *
 * `.kojo` 是超集：糖行 + 原生 ERB 直通（规范 `docs/SYNTAX-SUGAR-SURFACE-SPEC.md` §3.10）。
 * 补全要按**行**分流到两本候选册：糖册（`KOJO_COMPLETION_SOURCES`）与 ERB 册
 * （`ERB_COMPLETION_SOURCES`）。本模块只回答"这一行属于原生区吗 / 这一位是原生槽吗"，
 * 分流本身在 `kojo-completion.ts` 的装配 `route` 里（装配核只认 `route` 契约，不认语言）。
 *
 * ## 判据单一真源
 *
 * 行类一律经 `kojo-sugar` 的 `classifyLine(splitLogicalLines(text)[0])`（与 `enter.ts` 的
 * `sugarEnterIndentAfter` 同式）——**不在 app 层重写原生行正则**：全大写指令 / `$标签` /
 * `@` 块起点这三条判据住在转译器 lexer 里，抄第二份必然漂移（"能补上、编译炸"）。
 *
 * ## 原生区的两种形态
 *
 * 1. **行级**：当前行分类为 `rawLine`（行首全大写指令 / `$标签`）或 `rawBlockStart`（`@`）；
 * 2. **块级**：当前行在某个 `@` 原生函数块内——块从 `@` 行起直到**下一个 `@` 行或 EOF**
 *    （§3.10，块内不解析糖语法，可含 `#DIM` / `#FUNCTION` 等预处理行与任意文本）。
 *    判定 = 从当前行**向上**找最近的 `rawBlockStart`；找到即属于该块。
 *
 * 向上扫描有**固定上界** {@link KOJO_NATIVE_BLOCK_SCAN_LIMIT}：一个原生块就是一枚手写 ERB
 * 函数，真实 `.kojo` 里在几十行量级；上界把病态长文件（十万行）的单次补全成本钉在固定预算
 * 内。触界即判"非原生区"——**宁可退回糖册，也不拿界外的猜测污染糖位**。
 *
 * 纯糖行（`调用 |` / `时机 |` / 缩进块体）自身不是 `rawLine`，且糖区（首个 `@` 之前）向上
 * 扫不到 `rawBlockStart` ⇒ 恒返回 `false`，绝不路由进 ERB 源。
 */

/**
 * 向上找最近 `@` 的**行数上界**（含当前行之上连续扫描的行数）。
 *
 * 取值依据：`@` 原块 = 一枚手写 ERB 函数，真实口上里通常 10–200 行；2,000 行已覆盖"长篇
 * 工具函数 / 整表粘贴"这一极端。超界判非原生区（保守失败见模块头注）。
 */
export const KOJO_NATIVE_BLOCK_SCAN_LIMIT = 2000;

/**
 * 单行文本 → 行类（**与转译器同一份判型**，见模块头注）。
 *
 * `splitLogicalLines` 至少产出一条逻辑行（空串 / 空白串 → 一条 `blank`），故 `[0]` 恒在；
 * 只取首条是因为入参是**一物理行**：行尾 `\` 在本层没有续行可合并（`enter.ts` 同式）。
 */
export function classifyKojoLine(text: string): LineClass {
  return classifyLine(splitLogicalLines(text)[0]!);
}

/** 行类是否属于原生区（行级判据；块级由 {@link kojoNativeZoneAt} 的向上扫描补齐） */
function isNativeLineClass(cls: LineClass): boolean {
  return cls.kind === 'rawLine' || cls.kind === 'rawBlockStart';
}

/**
 * 快速预筛 + 权威判定一行是否 `rawBlockStart`（`@` 块起点）。
 *
 * 向上扫描至多 2,000 行、每击键一次：若每行都跑完整 `classifyLine`（词法 / 块头 / 控制语句一长串
 * 正则），糖区大文件会白付几毫秒。`rawBlockStart` 的定义又是最窄的一条——`contentOf` 之后以
 * `@` 开头——故先用 `trimStart().startsWith('@')` 预筛，**只有命中者**才跑 `classifyLine` 确认。
 * `trimStart` 的空白集是 lexer `rawIndent`（`[ \t\u3000]`）的**超集** ⇒ 只会多筛（如 NBSP 缩进），
 * 不会漏筛；最终答案仍由 {@link classifyKojoLine}（单一真源）给出。
 */
function isRawBlockStartLine(text: string): boolean {
  return text.trimStart().startsWith('@') && classifyKojoLine(text).kind === 'rawBlockStart';
}

/**
 * 当前行是否属于 `.kojo` 的原生区（纯函数，可单测）。
 *
 * - 当前行是 `rawLine` / `rawBlockStart` ⇒ `true`；
 * - 否则向上找最近的 `rawBlockStart`（`@`），行距不超过 {@link KOJO_NATIVE_BLOCK_SCAN_LIMIT}
 *   ⇒ `true`（块内任意行，含 `#DIM` / 注释 / 空白）；
 * - 其余（糖行 / 首个 `@` 之前的任何行 / 扫描触界）⇒ `false`。
 */
export function kojoNativeZoneAt(model: Monaco.editor.ITextModel, lineNumber: number): boolean {
  if (!Number.isFinite(lineNumber) || lineNumber < 1) return false;
  if (isNativeLineClass(classifyKojoLine(lineAt(model, lineNumber)))) return true;

  const floor = Math.max(1, lineNumber - KOJO_NATIVE_BLOCK_SCAN_LIMIT);
  for (let n = lineNumber - 1; n >= floor; n--) {
    if (isRawBlockStartLine(lineAt(model, n))) return true;
  }
  return false;
}

/**
 * 当前光标是否落在原生区里一个**值得主动触发补全的槽位**（纯函数，可单测）。
 *
 * 谓词 = 原生区 **且** ERB 位置门（{@link erbCompletionGate}）不是 `'in-string'`
 * （字符串 / `;` 注释内）也不是 `'default'`（表达式 / 文本位，等作者自己敲触发字符）。
 * 用于宿主"停顿触发 / 主动弹窗"的判据（本批只导出，接线由宿主负责）：原生区里
 * `CALL ` / `#D` / `CFLAG:` / `GOTO ` / `SETBIT CFLAG:1,` 这些**名字位**才值得主动弹；
 * 串内 / 注释内 / 普通表达式中间不打扰作者。
 *
 * 门的九态语义与白名单在 `@kojo/plugin-erb-parser` 单一真源；本函数只做"非空槽"判断，
 * 不复制任何名字位判据。
 */
export function kojoNativeSlotAt(model: Monaco.editor.ITextModel, position: Monaco.Position): boolean {
  const line = lineAt(model, position.lineNumber);
  // **先过 ERB 位置门，再问原生区**：糖区绝大多数行在这一步就是 `default`（`调用 …` /
  // 台词 / 块体），从而完全跳掉 `@` 块的向上扫描——这是每次击键都会走的热路径。
  // 门本身 O(行长)；原生区判定才是 O(扫描行数)。
  const gate = erbCompletionGate(line, position.column);
  if (gate === 'in-string' || gate === 'default') return false;
  // 门的某些态比**候选源自己的名字槽**宽：`call-target` 在 `CALL` 无尾随空白时也命中，
  // 但 `erb-functions` 的槽要求关键字后至少一枚空白。若这里只看门，敲完 `CALL` 的最后一个
  // `L` 就会弹一次**零候选**查询；那一轮 suggest state 尚未回 Idle 时，紧跟着的空格会被
  // gate ⑥ 当成「widget 还开着」而吞掉——真壳实测的 `CALL ` 盲区就是这么来的（`CALL M` 能出，
  // 因为多打一个 M 又触发了一次）。⇒ 这里逐态复用各源自己的槽判据（与 `ERB_NAME_SLOTS`
  // 同一批函数），只有"这一位真会出货"才允许主动触发。
  if (!kojoNativeZoneAt(model, position.lineNumber)) return false;
  switch (gate) {
    case 'directive-token':
      return true; // `#D` —— 候选源按全记号前缀出货，无额外名字槽
    case 'def-slot':
    case 'call-target':
      return erbFunctionNameSlot(line, position.column) !== null;
    case 'label-target':
      return erbLabelSlot(line, position.column) !== null;
    case 'variable-slot':
      return erbVariableSlotAt(line, position.column) !== null;
    case 'bit-slot':
      return erbBitSlotOpen(line, position.column);
    default:
      return false;
  }
}
