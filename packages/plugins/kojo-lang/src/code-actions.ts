/**
 * `ui.editor.codeAction` 供方：包里的一键迁移判据（`@kojo/kojo-lang/code-actions`）→
 * 契约的 `EditorCodeAction[]`（B3j，2026-10-30）。
 *
 * ## 这一格回答什么
 *
 * 2.0 编译器对旧写法**只报错、不解释**；本供方把"请按 §12.1 迁移"变成可点的动作。
 * 触发条件 / 编辑集合 / 通过收口校验（改后 `parse` 不新增错误、目标码必须消失）全在包里，
 * 本文件只做三件事：**语言分派**（非 kojo2 弃权）、**形状搬运**（诊断 / 编辑 / 类别），
 * 以及"抛错 ⇒ 这一轮没有动作"的隔离。
 *
 * ## 三态（与 hover / signatureHelp 同一条纪律，但契约形状不同）
 *
 * 槽 `ui.editor.codeAction` 的 `provideActions` **没有** `undefined` 这一态（返回数组），
 * 所以"弃权"写成 `[]`：非 kojo2 文件 / 位置未知 / 这个区间没有波浪线 ⇒ 空数组。
 * 宿主对空数组不解释（不画任何菜单项），与"这家没话说"的旧口径一致。
 *
 * ## 为什么诊断要从契约形状再翻回 core 形状
 *
 * 宿主递来的是**面上正画着的** `LineDecoration`（行级契约，列可选），而判据吃 core 的
 * `KojoDiagnostic`（1 基 span）。这一层只做**逐字搬运 + 列夹取**，不重算诊断——
 * 两处各算一份必然漂移（哪一份"对"取决于去抖时机）。
 */
import type {
  EditorCodeAction,
  EditorTextEdit,
  GameProject,
  LineDecoration,
} from '@kojo/plugin-api';
import type { DiagnosticCode, KojoDiagnostic } from '@kojo/kojo-core';
import {
  kojo2CodeActionFacts,
  type Kojo2CodeActionFact,
} from '@kojo/kojo-lang/code-actions';
import { isKojo2Request } from './request';

/** `provideActions(file)` 里本供方真正读的那几格（宿主给得更多，忽略即可） */
export interface Kojo2CodeActionFile {
  readonly path: string;
  readonly text: string;
  readonly project: GameProject | null;
  readonly line?: number;
  readonly lineCount?: number;
  readonly diagnostics?: readonly LineDecoration[];
}

/** 一份源码的行视图（只为把 `LineDecoration` 的列夹进行宽） */
function lineOf(text: string, line: number): string {
  const lines = text.split(/\r\n|\r|\n/);
  return lines[line - 1] ?? '';
}

function clampColumn(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(min, Math.trunc(value)), max);
}

/**
 * `LineDecoration[]` → `KojoDiagnostic[]`：**同一批诊断、同一份坐标**，只换容器。
 *
 * - 没码的装饰不收（判据没法认领"这是不是我认识的构造"）；
 * - 列按行宽夹取（与宿主正向翻译 `decorationsToMarkers` 同一条口径：越界值不该让
 *   整条动作消失）；
 * - `info` 按 `error` 收（core 只有两档，旧宿主 `MarkerSeverity !== Warning ⇒ error` 同口径）。
 */
export function coreDiagnosticsOf(
  decorations: readonly LineDecoration[],
  text: string,
): KojoDiagnostic[] {
  const out: KojoDiagnostic[] = [];
  for (const decoration of decorations) {
    const code = decoration.code;
    if (typeof code !== 'string' || code.length === 0) continue;
    const line = Math.max(1, Math.trunc(decoration.line) || 1);
    const lineText = lineOf(text, line);
    const startColumn = clampColumn(decoration.startColumn ?? 1, 1, lineText.length + 1);
    const endColumn = clampColumn(
      decoration.endColumn ?? startColumn,
      startColumn,
      lineText.length + 1,
    );
    out.push({
      code: code as DiagnosticCode,
      severity: decoration.severity === 'warning' ? 'warning' : 'error',
      message: decoration.message,
      span: {
        start: { line, column: startColumn },
        end: { line, column: endColumn },
      },
    });
  }
  return out;
}

/** 契约类别：只有"修缩进"是改写写法（`refactor`），其余都是修一条诊断（`quickfix`） */
function contractKindOf(fact: Kojo2CodeActionFact): EditorCodeAction['kind'] {
  return fact.kind === 'indent' ? 'refactor' : 'quickfix';
}

function decorationOf(diagnostic: KojoDiagnostic): LineDecoration {
  const span = diagnostic.span;
  return {
    line: span?.start.line ?? 1,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(span === null
      ? {}
      : { startColumn: span.start.column, endColumn: span.end.column }),
    code: diagnostic.code,
  };
}

function editOf(edit: Kojo2CodeActionFact['edits'][number]): EditorTextEdit {
  return {
    fromLine: edit.range.startLine,
    toLine: edit.range.endLine,
    newText: edit.newText,
  };
}

function actionOf(fact: Kojo2CodeActionFact): EditorCodeAction {
  return {
    title: fact.title,
    kind: contractKindOf(fact),
    diagnostics: fact.diagnostics.map(decorationOf),
    edits: fact.edits.map(editOf),
    // 契约要求 `run`；给出 `edits` 时宿主**优先执行改写、从不调用它**（与
    // `erb-parser` / `convention-linter` 两枚既有供方同款写法）。本供方不做"发意图"型动作。
    run: () => undefined,
  };
}

/**
 * 一次 `provideActions` → 契约动作列表。
 *
 * 弃权（`[]`）的四种情形：不是 2.0 文件（路径扩展名判）、位置未知（`line` 缺省）、
 * 这个区间没有波浪线（`diagnostics` 空）、以及判据抛错（坏输入 / 词法意外——作者能读懂的
 * 退化，不让异常穿回宿主）。**认了但这条不修**同样给 `[]`：本供方没有"空结果要顶掉下一家"
 * 的语义（槽是并集型，宿主把各家动作拼在一起）。
 */
export function provideCodeActions(file: Kojo2CodeActionFile): EditorCodeAction[] {
  if (!isKojo2Request({ path: file.path })) return [];
  const line = file.line;
  if (line === undefined || !Number.isFinite(line) || line < 1) return [];
  const decorations = file.diagnostics ?? [];
  if (decorations.length === 0) return [];
  const diagnostics = coreDiagnosticsOf(decorations, file.text);
  if (diagnostics.length === 0) return [];
  try {
    return kojo2CodeActionFacts({
      source: file.text,
      diagnostics,
      line,
      filePath: file.path,
    }).map(actionOf);
  } catch {
    return [];
  }
}
