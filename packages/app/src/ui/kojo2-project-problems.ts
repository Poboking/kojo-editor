/**
 * Kojo 2.0 项目级问题 → 编辑器问题面板（Host 工作流出口）。
 *
 * ## 为什么单独一枚
 *
 * Service 汇总的是**项目域形状**（`Kojo2ProjectProblem`：channel / code / severity /
 * message / path / line / column / fileId / canonicalId / functionName / candidateTheaterIds），
 * 问题面板吃的是 `EditorProblem`（path 必填、行 1 基、可选列区间 span）。
 * 两者之间只差**一次翻译**，且翻译判据必须只有一份——所以它住在 UI 层、不塞进 Service
 * （Service 不认识问题面板），也不让每个命令各抄一遍。
 *
 * ## bucket 口径（与既有 `kojo2:project` 并存）
 *
 * 项目级问题（`path === null`）没有单文件落点，但问题面板的分组键是路径。它们统一落到
 * 虚拟 bucket {@link KOJO2_BUILD_PROBLEM_PATH}：
 * - 与 `kojo2:project`（`KOJO2_PROJECT_PROBLEM_PATH`，核心存储/项目分析那一簇）**互不覆盖**：
 *   两者是不同 bucket key，`problem-store` 按 key 各存一簇；
 * - 带真实文件路径的条目**保留自己的 path**（面板按条目 path 分组，点开就能跳文件）；
 * - 清账只清本 bucket（`clearKojo2ProjectProblems`），不碰别的簇。
 *
 * ## source 标签
 *
 * {@link KOJO2_BUILD_PROBLEM_SOURCE} 与 `kojo2-problem-wiring.ts` 的
 * `KOJO2_DIAGNOSTICS_SOURCE`（真源 `@kojo/kojo-lang/diagnostics` 的 `KOJO2_DIAGNOSTIC_SOURCE`）
 * 同值（`'Kojo 2.0'`）。**刻意复制字符串而不 import**：本模块只该进懒加载的工作流图，
 * 为一个常量把 kojo-lang 诊断链拖进静态图不值得；两处同源由 `KOJO2_DIAGNOSTICS_SOURCE`
 * 的别名注释与测试钉住，改口径要一起改。
 */
import { shortPath } from '@kojo/plugin-api';
import type { EditorProblem } from './problem-store';
import { setProjectScanProblems } from './problem-store';
import type {
  Kojo2ProjectProblem,
  Kojo2ProjectProblemChannel,
} from './kojo2-project-service-contract';

/** 项目级（无单文件落点）问题的虚拟分组键；与 `kojo2:project` 并存、互不覆盖。 */
export const KOJO2_BUILD_PROBLEM_PATH = 'kojo2:build';

/** 问题面板的来源标签（同源 `KOJO2_DIAGNOSTIC_SOURCE` = `'Kojo 2.0'`，见文件头）。 */
export const KOJO2_BUILD_PROBLEM_SOURCE = 'Kojo 2.0';

/** 通道标签：项目级条目没有路径可指，靠前缀说得出"这条是谁报的"。 */
const CHANNEL_LABELS: Readonly<Record<Kojo2ProjectProblemChannel, string>> = {
  build: '[构建]',
  dispatch: '[调度]',
  'dispatch-backend': '[调度渲染]',
  assembly: '[组装]',
  runtime: '[运行时]',
};

/** 通道标签（内部判据；未知通道由类型挡住）。 */
function channelLabel(channel: Kojo2ProjectProblemChannel): string {
  return CHANNEL_LABELS[channel];
}

/**
 * 一条 Service 问题 → 面板行。
 *
 * - 项目级（`path === null`）⇒ 虚拟落点 `kojo2:build` + 行 1，消息前缀通道标签；
 * - 有真实路径 ⇒ 保留路径，消息里带 `shortPath(path):line`（面板组头之外再给一次，
 *   因为项目级 bucket 里混着多文件条目时，单看组头看不出是哪一份）；
 * - `column` 有就给零宽区间的 `span`（1 基、终点 = `column + 1`，与 `ProblemSpan` 同口径）；
 * - `severity` / `code` 原样；`source` 盖本模块标签。
 */
function toEditorProblem(problem: Kojo2ProjectProblem): EditorProblem {
  const label = channelLabel(problem.channel);
  const hasPath = problem.path !== null && problem.path.length > 0;
  const line = problem.line ?? 1;
  const path = hasPath ? problem.path! : KOJO2_BUILD_PROBLEM_PATH;
  const message = hasPath
    ? `${label} ${shortPath(path)}:${line} ${problem.message}`
    : `${label} ${problem.message}`;
  const editor: EditorProblem = {
    path,
    line,
    severity: problem.severity,
    message,
    code: problem.code,
    source: KOJO2_BUILD_PROBLEM_SOURCE,
  };
  if (problem.column !== null && problem.column > 0) {
    editor.span = { columnStart: problem.column, columnEnd: problem.column + 1 };
  }
  return editor;
}

/** 批量翻译（保持 Service 给的顺序；排序由 `problem-store.snapshot()` 统一做）。 */
export function toEditorProblems(problems: readonly Kojo2ProjectProblem[]): EditorProblem[] {
  return problems.map(toEditorProblem);
}

/**
 * 把 Service 汇总的项目问题上账到问题面板。
 *
 * 整份替换 `kojo2:build` bucket：Service 每次状态变化给的都是当前快照，不做增量。
 * 空数组 = 本轮没有问题（`problem-store` 对扫描簇的空数组直接销账，不留幽灵组）。
 */
export function publishKojo2ProjectProblems(problems: readonly Kojo2ProjectProblem[]): void {
  setProjectScanProblems(KOJO2_BUILD_PROBLEM_PATH, toEditorProblems(problems));
}

/** 清空本模块的项目问题（关项目 / 卸载工作流时调；不碰 `kojo2:project` 等其它簇）。 */
export function clearKojo2ProjectProblems(): void {
  setProjectScanProblems(KOJO2_BUILD_PROBLEM_PATH, []);
}
