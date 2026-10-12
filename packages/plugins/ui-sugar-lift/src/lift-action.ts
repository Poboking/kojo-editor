/**
 * 「💡 改为语法糖写法」的**纯逻辑**（零 React、零 Monaco，可单测）。
 *
 * ## 这条路径在干什么（用户 2026-10-12 的 6a）
 *
 * 对 **`.kojo` 文件**：作者（尤其是熟悉 ERB 的老手）会在糖文件里写原生的 ERB 直通行；
 * 光标停在那种行上时，旁边出现 💡，点一下就把**原来的 ERB 写法换成糖写法**，写进源文件，
 * `Ctrl+Z` 可撤回。
 *
 * 这与 ERB 文件的"糖视图"是**两件事**，别混：
 * - `.kojo` 的 💡 = **改文件**（要写盘、要可撤销 → 走 `EditorCodeAction.edits`）；
 * - `.erb` 的糖视图 = **只用于看**（前端改动、零写盘 → 走 `provideLiftProject`）。
 *
 * ## 缩进：候选给的是**相对**缩进，落地必须补回原缩进
 *
 * `sugarSource` 由升糖器生成，其自身相对缩进以 **4 空格**为一级（与规范 §6 的示例、
 * 新建向导骨架、golden fixture 同口径）。但候选的坐标是"源文件里的某几行"，
 * 那几行可能嵌在任意深度——直接替进去会把缩进抹平。故此处按**源行的前导空白**
 * 给每一行补上基准缩进（空行不补，避免造出"只含空白的行"）。
 */

import type { EditorTextEdit, SugarLiftCandidate } from '@kojo/plugin-api';

/** 行前导空白（空格 / TAB / 全角空格——`.kojo` 三种都可能出现） */
export function leadingWhitespace(line: string): string {
  const m = /^[ \t\u3000]*/.exec(line);
  return m ? m[0] : '';
}

/**
 * 挑出**覆盖该行**的候选（升糖建议的"就近动作"）。
 *
 * - `alias`（别名声明建议）**不参与**：它没有行区间，也不是"把这段换成糖"，
 *   💡 对它没有意义；
 * - 同一行被多个候选覆盖时取**最先出现**（升糖器已按区间升序输出，父块在前）——
 *   "改这一段"在语义上就是改最外层那个可自证的片段。
 */
export function pickCandidate(
  candidates: readonly SugarLiftCandidate[],
  line: number,
): SugarLiftCandidate | undefined {
  return candidates.find((c) => c.kind !== 'alias' && line >= c.fromLine && line <= c.toLine);
}

/**
 * 候选 → 就地改写（`EditorTextEdit`）。
 *
 * `sourceLines` 是**当前**源文件按行切开的结果（1 基访问即 `sourceLines[fromLine - 1]`）；
 * 越界（供给与执行之间用户又编辑过）→ 缩进按空串处理，宿主另有行号夹取，不崩。
 */
export function toSugarEdit(
  candidate: SugarLiftCandidate,
  sourceLines: readonly string[],
): EditorTextEdit {
  const base = leadingWhitespace(sourceLines[candidate.fromLine - 1] ?? '');
  const newText = candidate.sugarSource
    .split('\n')
    .map((l) => (l.length === 0 ? l : `${base}${l}`))
    .join('\n');
  return { fromLine: candidate.fromLine, toLine: candidate.toLine, newText };
}

/** 💡 动作标题（面向作者，说清"改什么、可撤销"） */
export function actionTitle(candidate: SugarLiftCandidate): string {
  const what =
    candidate.kind === 'print-message'
      ? '文本行'
      : candidate.kind === 'if-block'
        ? '条件块'
        : candidate.kind === 'selectcase'
          ? '分派块'
          : '片段';
  return `改为语法糖写法（${what}·可 Ctrl+Z 撤回）`;
}
