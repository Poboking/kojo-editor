/**
 * 问题面板的**纯逻辑层**（P2-13，2026-10-19）——分组 / 过滤 / 复制文案 / 行内修复的
 * 候选筛选与改写计划，全部是不碰 React、不碰 Monaco、不碰 IPC 的纯函数（node 可单测）。
 *
 * 分层理由（与 `problem-store.ts` 抽出时同一条）：这些是**数据判据**，不是渲染细节。
 * 判据住在这里被单测钉死，`ProblemPanel.tsx` 只做"把判据的结果画出来 + 把用户意图
 * 递回来"；Monaco 的落地（Range 构造、`applyEdits`）留在面板的动态加载层——面板的
 * **静态模块图必须零 Monaco**（`tests/ps6-rows.test.ts` 在 node 里直接渲染本面板，
 * Monaco 的模块图一加载就摸 `window`，见 `editor-model-pool-instance.ts` 的头注）。
 *
 * 与 `kojo-code-action.ts` 的关系：**只复用，不抄第二份**。"一条诊断有几个解"的唯一
 * 判据底座（`quickFixOwnership` ⇒ `pickPreferred`）住在那里，`kojo-fix-all.ts`（E3
 * 「全部修复」）读的就是同一张表——本模块的行内 fix 按钮判据读同一张表的同一把尺，
 * 三处（💡 星标 / 批量修复 / 面板按钮）对"唯一解"的回答不可能分叉。该文件自身**零
 * 运行时 Monaco 依赖**（`tests/kojo-code-action.test.ts` 就在 node 里跑它），所以这里
 * 的 import 不破坏本文件的 node 可测性（类型 import 的 Monaco 不算）。
 */

import type {
  EditorCodeAction,
  EditorCodeActionContribution,
  EditorTextEdit,
  GameProject,
  LineDecoration,
} from '@kojo/plugin-api';
import { errorText, shortPath } from '@kojo/plugin-api';
import type { EditorProblem } from './problem-store';
import {
  diagnosticKey,
  monacoActionKind,
  pickPreferred,
  type PreferredCandidate,
} from '../monaco/kojo-code-action';

/* ══════════════════════════ ① 过滤（严重级 + 文本子串） ══════════════════════════ */

export type ProblemSeverity = EditorProblem['severity'];

/**
 * 契约里只有三档严重级（`EditorProblem.severity`，无 hint——装饰器与面板的既定形状，
 * 不为不存在的档留过滤位：给一个永远数 0 的开关就是撒谎）。
 */
export const ALL_SEVERITIES: readonly ProblemSeverity[] = ['error', 'warning', 'info'];

/** 过滤判据：严重级多选（任一命中即可）+ 文本子串（空串 = 不过滤文本） */
export interface ProblemFilter {
  readonly severities: ReadonlySet<ProblemSeverity>;
  readonly text: string;
}

/**
 * 纯过滤（不改入参顺序，返回新数组）：
 * - 严重级不在选中集合 ⇒ 丢；
 * - 文本非空时按**不区分大小写的子串**匹配 `message` 与 `code`——作者拿它找
 *   "报错里带某某词的"或"ERB1001 这一族"，码也是上屏内容的一半（诊断码芯片），
 *   只认 message 会漏掉按码搜索这一半。
 */
export function filterProblems(
  items: readonly EditorProblem[],
  filter: ProblemFilter,
): EditorProblem[] {
  const needle = filter.text.trim().toLowerCase();
  return items.filter((it) => {
    if (!filter.severities.has(it.severity)) return false;
    if (needle.length === 0) return true;
    return (
      it.message.toLowerCase().includes(needle) ||
      (it.code !== undefined && it.code.toLowerCase().includes(needle))
    );
  });
}

/* ══════════════════════════ ② 按文件分组 ══════════════════════════ */

export interface ProblemGroupCounts {
  readonly error: number;
  readonly warning: number;
  readonly info: number;
}

export interface ProblemGroup {
  /** 完整路径（折叠判据 / 跳源用的都是它） */
  readonly path: string;
  /** 组头显示的短路径（`shortPath` 口径，与检索面板同源） */
  readonly label: string;
  /** 组内问题（保持过滤后序列的原顺序 = 严重级 → 路径 → 行） */
  readonly items: EditorProblem[];
  /**
   * 组内每条问题在**过滤后全序**里的下标（与 `items` 一一同序）。
   * 渲染窗口按全局条目裁剪时用它判"这一条进没进窗"——分组会把同一路径的
   * 多个严重级段收进一组，组内条目在全局序列里**不保证连续**，组级下标
   * （`startIndex`）盖不住"组内后半截越窗"的情形。
   */
  readonly indices: readonly number[];
  readonly counts: ProblemGroupCounts;
  /**
   * 组内第一条在**过滤后全序**里的下标（渲染窗口按全局条目裁剪时用）。
   */
  readonly startIndex: number;
}

/**
 * 分组（纯函数）：键 = 完整路径；组序 = **在过滤后序列里的首次出现序**。
 *
 * 为什么组序跟着首次出现走而不是另按路径字典序：扁平列表的既有口径是
 * `sortProblems`（severity → path → line），分组只是把同一段折叠起来看——
 * "错误最多的文件排最前"这一语义不因分组而变；另立一把字典序尺子等于
 * 同一屏两套排序，作者折叠/展开时行序会跳。
 */
export function groupProblems(items: readonly EditorProblem[]): ProblemGroup[] {
  // 组装期用可变形状（push / 计数累加），出组前冻成 `ProblemGroup` 的只读视图
  interface MutableGroup {
    path: string;
    label: string;
    items: EditorProblem[];
    indices: number[];
    counts: { error: number; warning: number; info: number };
    startIndex: number;
  }
  const groups: MutableGroup[] = [];
  const byPath = new Map<string, MutableGroup>();
  items.forEach((it, index) => {
    let group = byPath.get(it.path);
    if (group === undefined) {
      group = {
        path: it.path,
        // 组头短路径与检索面板/旧行内定位同一条 `shortPath`（单一真源，不抄第二份）
        label: shortPath(it.path),
        items: [],
        indices: [],
        counts: { error: 0, warning: 0, info: 0 },
        startIndex: index,
      };
      byPath.set(it.path, group);
      groups.push(group);
    }
    group.items.push(it);
    group.indices.push(index);
    if (it.severity === 'error') group.counts.error++;
    else if (it.severity === 'warning') group.counts.warning++;
    else group.counts.info++;
  });
  return groups;
}

/* ══════════════════════════ ③ 复制文案 ══════════════════════════ */

/**
 * 剪贴板文案 = `路径:行号 [severity] 消息`（纯函数，node 可单测）。
 *
 * 两条口径的理由：
 * - **完整路径**（不是短路径）：粘贴的去处通常是终端、issue 或"打开文件"对话框，
 *   完整路径能直接用；短路径是组头/行内的**显示**口径，两边各司其职。
 * - **`[error]` 方括号英文标记**：ASCII、可 grep、与 Monaco/VSCode 的严重级词一致，
 *   粘进日志与 issue 里任何工具都认得；中文词（错误/警告/提示）已由面板计数区承担
 *   **显示**职责，剪贴板文案的服务对象是机器与检索。方括号把标记与消息正文隔开，
 *   消息本身首词不会被误并。
 */
export function problemCopyText(
  problem: Pick<EditorProblem, 'path' | 'line' | 'severity' | 'message'>,
): string {
  return `${problem.path}:${problem.line} [${problem.severity}] ${problem.message}`;
}

/* ══════════════════════════ ④ 行内修复：诊断翻译 + 唯一解筛选 + 改写计划 ══════════════════════════ */

/**
 * 一条面板问题 → 契约诊断形状（`LineDecoration`），供 `ui.editor.codeAction` 槽的
 * `provideActions` 应答判据用。与 `kojo-code-action.ts` 的 `markersToDecorations`
 * 反翻译同族：**这条问题本来就是从那份装饰折出来的**（EditorPane.refreshMarkers），
 * 翻回去应当逐字段还原——列区间（span）、诊断码、来源标签都带回去，认领匹配
 * （`diagnosticKey`：严重级+行+消息+码，刻意不含列）才对得上。
 */
export function problemLineDecoration(problem: EditorProblem): LineDecoration {
  return {
    line: problem.line,
    severity: problem.severity,
    message: problem.message,
    ...(problem.span !== undefined
      ? { startColumn: problem.span.columnStart, endColumn: problem.span.columnEnd }
      : {}),
    ...(problem.code !== undefined ? { code: problem.code } : {}),
    ...(problem.source !== undefined ? { source: problem.source } : {}),
  };
}

/** 一次问槽请求的中性事实（`provideCodeActionsFor` 同款形状，纯数据可单测） */
export interface RowFixRequest {
  readonly path: string;
  readonly text: string;
  readonly project: GameProject | null;
  readonly lineCount: number;
  /** 问题所在行（1 基）——与 💡 区间请求的 `line` 同义 */
  readonly line: number;
  /** 这条问题翻译出的契约诊断（单条：面板按钮是**针对这一条**的请求） */
  readonly diagnostic: LineDecoration;
}

/**
 * 对一条诊断问 `ui.editor.codeAction` 槽，**唯一解才给按钮**。
 *
 * 问法与 `editor-global-providers.ts` 的 `provideCodeActions` 逐字同款：把请求折成
 * `provideActions` 的入参（`scope` 缺省 = 'range' 区间请求，`line` + `diagnostics`
 * 指明这条诊断），每个贡献隔离抛错（单贡献炸了只丢它自己的动作，不静默吞整轮）。
 * 判据与 💡 的 `isPreferred` 同一条底座：本次请求的这条诊断**恰好只有一条快速修复
 * 认领** ⇒ 返回那条动作；零条（按钮不渲染，不留按了没反应的死按钮——铁律 4）或
 * 多条（不替作者选）⇒ `undefined`。`refactor` 类不是"红线的解"，与
 * `quickFixOwnership` 同口径不参与计数。
 */
export function collectRowFix(
  contributions: readonly EditorCodeActionContribution[],
  request: RowFixRequest,
): EditorCodeAction | undefined {
  const requested: readonly LineDecoration[] = [request.diagnostic];
  const actions: EditorCodeAction[] = [];
  const candidates: PreferredCandidate[] = [];
  for (const contribution of contributions) {
    let provided: EditorCodeAction[];
    try {
      provided = contribution.provideActions({
        path: request.path,
        text: request.text,
        project: request.project,
        lineCount: request.lineCount,
        line: request.line,
        diagnostics: [...requested],
      });
    } catch (e: unknown) {
      console.warn(
        `[problem-fix] '${contribution.id}' provideActions 抛错：${errorText(e)}`,
      );
      continue;
    }
    for (const action of provided) {
      candidates.push({ kind: monacoActionKind(action.kind), diagnostics: action.diagnostics ?? [] });
      actions.push(action);
    }
  }
  const preferred = pickPreferred(candidates, requested);
  if (preferred.size !== 1) return undefined;
  return actions[[...preferred][0]!];
}

/**
 * 一条问题的行内修复**缓存键**：路径 ⊕ 诊断身份（`diagnosticKey` 口径——严重级 +
 * 行 + 消息 + 码，刻意不含列）。面板按它记住"这条诊断问过的答案"：同一版本文本上
 * 重渲零重问（问槽一次 = 供方整篇扫一遍，重复问就是白付），文本一改（版本号变）
 * 自动作废重问。
 */
export function rowFixKey(problem: EditorProblem): string {
  return `${problem.path}\u0000${diagnosticKey(problemLineDecoration(problem))}`;
}

/** `applyLineEdits` 落地前的中间形状：夹取与降序都已折好（1 基闭区间 + 整行替换文本） */
export interface PlannedLineEdit {
  readonly fromLine: number;
  readonly toLine: number;
  readonly newText: string;
}

/**
 * 行级改写计划（纯函数）——判据照 `applyTextEdits` 的注释逐条同源：
 * - **坐标夹取**：贡献方给出的行号可能因"供给与执行之间用户又编辑了"而过期，
 *   夹取而非报错（陈旧行号不该让面板崩）；`NaN` / 非整数按缺省折回（与
 *   `applyTextEdits` 的 `Math.trunc(x) || 缺省` 同一口径）；
 * - **降序应用**：从最大行号开始替换，前面的行号才不会因替换而位移；
 * - **单次落地**：产物交给宿主**一次**编辑调用（Monaco 侧 `applyEdits` =
 *   `pushEditOperations` 一次 = **一个撤销步**，`Ctrl+Z` 一次撤回整条修复）。
 *
 * 为什么判据在纯函数里而 `applyTextEdits` 在 Monaco 层里也算"同一条"：那边的
 * 三条注释就是本函数的三条注释——落点（model vs editor）不同，坐标系与纪律相同。
 */
export function planLineEdits(
  lineCount: number,
  edits: readonly EditorTextEdit[],
): PlannedLineEdit[] {
  if (edits.length === 0 || lineCount < 1) return [];
  return edits
    .map((e) => {
      const from = Math.min(Math.max(1, Math.trunc(e.fromLine) || 1), lineCount);
      const to = Math.min(Math.max(from, Math.trunc(e.toLine) || from), lineCount);
      return { fromLine: from, toLine: to, newText: e.newText };
    })
    .sort((a, b) => b.fromLine - a.fromLine);
}

/* ══════════════════════════ ⑤ 宿主座（模块级注入，jump-to-state 同款） ══════════════════════════ */

/**
 * 面板行内修复需要的**宿主能力**（由 App 挂载时注册、卸载时清座）。
 *
 * 为什么经宿主座而不给面板传 props：ProblemPanel 的挂载点在 ProjectView（懒链），
 * 而 kernel 的权威在 App——把 kernel 一路穿 props 要动一串不在本任务独占集里的
 * 文件。模块级注册（`setJumpProbe` / `shell-overlays.ts` 的先例）让面板"问能力"
 * 而不认识 kernel；座为 `null`（未挂载 / 已卸载）⇒ 面板**不给修复按钮**——能力
 * 缺席是可见的（没有按钮），不是按了没反应的死按钮。
 */
export interface ProblemFixHost {
  /** `ui.editor.codeAction` 槽的当前贡献快照（每次问询现取，表随插件激活/项目切换而变） */
  readonly codeActionContributions: () => readonly EditorCodeActionContribution[];
  /** 当前项目（`kernel.project.current()` 同口径；供 `provideActions` 的 `project` 入参） */
  readonly project: () => GameProject | null;
  /**
   * 该路径**当前挂在编辑器上的那份 model** 的读数（文本 / 行数 / 版本号）。
   *
   * 行内修复的判据请求需要**当前文本**（贡献方按它算动作），而面板的静态模块图
   * 零 Monaco——文本只有宿主拿得到（`openModelAcrossGroups`）。文件没开着 ⇒
   * `null` = 这一行不给修复按钮（问题来自已打开文件的波浪线，闭文件是少数派；
   * 没有按钮是可见的"没能力"，不是死按钮）。`versionId` 供面板缓存判"文本变没变"。
   */
  readonly documentOf: (
    path: string,
  ) => { readonly text: string; readonly lineCount: number; readonly versionId: number } | null;
  /**
   * 把改写计划落到该路径的 live model（**一次编辑调用 = 一个撤销步**，`Ctrl+Z`
   * 一次撤回整条修复）。落点判定与坐标纪律照 `applyTextEdits` 同一条（夹取 +
   * 降序 + 单次落地——判据已在 `planLineEdits` 折好，这里只认领编辑器并落地）。
   * 返回是否真落了一笔；`false` = 文件已不在任何打开的标签里（调用方显式说，
   * 不静默）。
   */
  readonly applyRowFix: (path: string, planned: readonly PlannedLineEdit[]) => Promise<boolean>;
}

let problemFixHost: ProblemFixHost | null = null;

export function setProblemFixHost(host: ProblemFixHost | null): void {
  problemFixHost = host;
}

/** 读宿主座；未注册（编辑器未挂载 / 测试环境）→ `null`，面板按"没有修复能力"处理 */
export function readProblemFixHost(): ProblemFixHost | null {
  return problemFixHost;
}
