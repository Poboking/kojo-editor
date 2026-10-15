/**
 * 可搬运任务（2026-10-16 装饰热路径批）。
 *
 * ## 为什么这一条要搬
 *
 * `ui.editor.decorator`（id `erb-expr-syntax`）此前在**主线程同步**跑
 * `scanControlFlow`（全文控制流骨架扫描）——而本插件早就通过 `erb.parser` 服务
 * 拿到过 offload 版（`scanControlFlowOffloaded`），装饰路径一个没接。
 *
 * ## 为什么任务表要"造表时把扫描器交进来"
 *
 * 任务实现必须是**纯函数 + 纯数据载荷**（跨不过结构化克隆的函数不能上 wire），
 * 而"扫骨架"这件事的所有权在 **erb-parser**，本插件按铁律不许 cross-import 它
 * （`audit:decoupling` C 项）。故本模块把扫描器留成**参数**：装配层
 * （app 的 `compute-tasks.ts`，唯一可以同时看见两个插件的层）用 erb-parser 导出的
 * 那个同名纯函数把表填上。worker 侧与宿主侧拿到的是**同一份填好的表**，不会漂移。
 */
import type {
  ComputeTaskTable,
  ControlFlowStatement,
  EditorDecoratePayload,
  LineDecoration,
} from '@kojo/plugin-api';
import { collectExprSyntaxDecorations } from './decorator';

/**
 * 任务 kind：条件表达式语法波浪线整条链（骨架扫描 + 逐条件表达式诊断 + 成形）。
 *
 * kind 前缀沿用 `erb.`（这条波浪线管的是 ERB 方言正文），与 `erb-structure` 同族。
 */
export const EXPR_SYNTAX_DECORATIONS_TASK = 'erb.exprSyntaxDecorations';

/** 本装饰器的适用性判据（口径与改动前的 `decorate` 逐字一致：只有正文才谈表达式） */
function isExprBearingPath(path: string): boolean {
  return /\.(erb|erm)$/i.test(path);
}

/**
 * 表达式语法波浪线的**单一真源**：`decorate()`（就地回退）与任务实现共用它。
 *
 * 骨架扫描器由调用方给定——同一个 `collectExprSyntaxDecorations` 已经在
 * "扫描/诊断任一异常都当无发现"这条保守口径上写死了，这里不另立判据。
 */
export function exprSyntaxDecorations(
  { path, text }: EditorDecoratePayload,
  scanControlFlow: (text: string) => readonly ControlFlowStatement[],
): LineDecoration[] {
  if (!isExprBearingPath(path) || text.length === 0) return [];
  return collectExprSyntaxDecorations(text, scanControlFlow).map((d) => ({
    line: d.line,
    severity: 'warning' as const,
    message: d.message,
    code: d.code,
  }));
}

/**
 * 本插件的可搬运任务表（装配层用 erb-parser 的 `scanControlFlow` 填；
 * 宿主侧 `registerTask` 与 worker 侧共用这一份，理由见文件头注）。
 */
export function conditionExtractorTasks(
  scanControlFlow: (text: string) => readonly ControlFlowStatement[],
): ComputeTaskTable {
  return {
    [EXPR_SYNTAX_DECORATIONS_TASK]: ((payload: EditorDecoratePayload): LineDecoration[] =>
      exprSyntaxDecorations(payload, scanControlFlow)) as never,
  };
}
