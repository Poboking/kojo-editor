/**
 * Kojo 2.0 诊断 → 编辑器事件 → 既有问题面板的**接线层**（K2 batch-3）。
 *
 * ## 三层分工（B3 收口后：判据不在本文件）
 *
 * 1. `@kojo/plugin-kojo-lang` 经槽 `ui.editor.decorator` 作答（判据在
 *    `@kojo/kojo-lang/diagnostics`：core 编译 → 行 / 落点归一 / 失败口径）；
 * 2. `ui/kojo2-problem-sync.ts`：debounce / 只认活动 model / 版本过期丢弃 / 清理（纯状态机）；
 * 3. 本文件：把**编辑器事件**（内容变化 / 活动 model 切换）折成第 2 层的
 *    `setActive` + `schedule`，并把结果接到两处**既有**消费点——
 *    - `monaco.editor.setModelMarkers(model, 'kojo2-diagnostics', markers)`（波浪线）；
 *    - `problem-store.setProblems(path, items)`（问题面板的数据源，Ctrl+Shift+M）。
 *    没有新造第二套 UI / 第二个面板。**判据一个字都不留在这里**：本层只做请求与翻译。
 *
 * ## 为什么在 bridge 里再加一层 debounce
 *
 * `kojo2-problem-sync.schedule()` 的输入是**源文本字符串**：若在每次
 * `onDidChangeModelContent` 里直接 `model.getValue()`，一份 2 MB 的稿子每敲一个键就整篇
 * 复制一次（本仓对"整篇复制"的代价有一串实测，见 `marker-pool.ts` 头注的 PS-4/PS-5）。
 * 所以本层先按 `KOJO2_PROBLEM_DEBOUNCE_MS` 合并击键，**定时器响时才取一次文本**，再交给
 * 第 2 层（其自身 debounce 置 0：时间轴已在本层走完，重复等待只会让诊断慢 200ms）。
 * 第 2 层仍负责版本/世代判据，这里的文本与 `schedule` 捕获的版本号在同一拍读，不会错位。
 *
 * ## 事件语义
 *
 * - `onDidChangeModelContent`：合并击键 → 取文本 → 诊断（活动 model 才跑）；
 * - `onDidChangeModel`：换 model（切标签 / `setModel`）**立即**跑一次；目标按**路由**不归
 *   2.0 管（例如切回 `.erb`，或 `2.0-default` 下内容仍是 v1 的 `.kojo`）⇒ `sync.clear()`
 *   （撤旧波浪线 + 撤问题面板条目）。
 * - 卸载：取消定时器 → 撤两个监听 → `sync.dispose()`（幂等）。
 *
 * 路径以 **model 的 URI** 为准（`monaco.Uri.file(path)` 是 model 池建的），`filePathRef`
 * 只做兜底：`onDidChangeModel` 那一拍 `filePathRef` 可能还是上一个标签的值。
 *
 * ## 失败可见（铁律 4）
 *
 * 诊断入口抛错 / 编译入口自报失败 ⇒ 第 2 层清空旧 markers，本层再：
 * ① 往问题面板写一条 `kojo2/diagnostics-unavailable`（不是"没问题"，是"没有诊断"）；
 * ② 经注入的 `notify` 发一条 `error` toast（宿主 UI 的通知中心，非新造 UI）。
 * 两条都有，缺一条都会让"屏上什么都没有"被读成"这份文件是干净的"。
 *
 * ## 装配口径（B3 收口最后一格，2026-10-30）
 *
 * 判据与供方都在 `@kojo/plugin-kojo-lang`（槽 `ui.editor.decorator`，id `kojo2-diagnostics`）；
 * 本文件只剩**调度 + 翻译 + 降级**：把正文 / 路径 / 当前项目递进槽（请求），把行装饰翻成
 * markers 与问题面板行（翻译），把"没有供方 / 没面"折成可见的失败面（降级）。
 *
 * 两面（adapter + backend）由**插件**经 `@kojo/kojo-lang/diagnostics` 的登记表现取；宿主在
 * 装配时登记的那一枚 getter 用的是组合根 `bootstrap.ts::kojo2SurfaceForProject` 的同一套
 * 登记簿（见 `use-monaco-instance.ts` 的 `ensureGlobalProviders` 调用）——此前写死
 * `ERATW_GAME_ADAPTER` + `createEratwEmitBackend` 的 bug（打开 eraFL 工程拿到 eraTW 落点
 * 规则，不报错、只是错）不会回来：取不到两面 ⇒ 插件抛错 ⇒
 * {@link KOJO2_DIAGNOSTICS_FAILURE_CODE} 那条可见面，不给空诊断。
 *
 * 一处**已知缺口**仍在宿主装配侧：表达式端口暂用恒等透传（v1 `lowerExpression` 尚未接进
 * 2.0 面）、角色号只能从 `GameProject.charaIndex[].kojoDir` 的前缀推（推不到时 backend 会
 * 如实报 `unit/backend-incomplete`，不静默造一个假函数名）。
 */
import type * as Monaco from '../monaco/entry';
import type { Kernel } from '@kojo/kernel';
import type { GameProject, LineDecoration } from '@kojo/plugin-api';
import { isPathUnder, pathKey } from '@kojo/plugin-api';
// 不吃任何具体 adapter：入口 D（2026-10-25）之前这里静态 import 了 eraTW 的
// `ERATW_GAME_ADAPTER` + `createEratwEmitBackend`，于是打开 eraFL 工程时波浪线是拿 eraTW
// 的落点规则算的——不报错、只是错。B3 收口之后两面（adapter + backend）由**插件**经
// `@kojo/kojo-lang/diagnostics` 的登记表现取，宿主这一侧只剩"表达式端口"一个注入面
// （见 `kojo2IdentityCompileExpression`）与槽位调度。
import type { DialectBindingResolution, KojoDiagnostic } from '@kojo/kojo-core';
import {
  KOJO2_DIAGNOSTIC_SOURCE,
  KOJO2_DIAGNOSTICS_CONTRIBUTION_ID,
  kojo2RowsOfDiagnostics,
  type Kojo2DiagnosticRow,
} from '@kojo/kojo-lang/diagnostics';
import {
  forgetKojo2DiagnosticResult,
  kojo2DiagnosticResultFor,
} from '@kojo/kojo-lang/diagnostic-result';
import { buildKojo2SourceMapModel } from '@kojo/kojo-lang';
import {
  aggregateKojo2DialectLint,
  kojo2DialectLintProblems,
  lintKojo2Dialect,
  type Kojo2DialectLintReport,
} from '../monaco/kojo2-dialect-lint';
import type { Kojo2PreviewCompilation } from './kojo2-preview-entry';
import {
  KOJO2_PROBLEM_DEBOUNCE_MS,
  createKojo2ProblemSync,
  type Kojo2DebounceScheduler,
  type Kojo2DiagnoseFn,
  type Kojo2DiagnosticsArtifacts,
  type Kojo2DiagnosticsInput,
  type Kojo2DiagnosticsResult,
  type Kojo2MarkerHost,
  type Kojo2MarkerSeveritySource,
} from './kojo2-problem-sync';
import { clearProblems, setProblems, type EditorProblem } from './problem-store';
import type { NoticeInput } from './NotificationCenter';
import {
  isKojo2RouteablePath,
  kojo2DiagnosticsEnabled,
  kojo2RouteForPath,
} from './kojo2-diagnostics-gate';

/** 诊断失败在问题面板里的稳定诊断码（不是 core 诊断码；一眼看出这是工具链自己的事） */
export const KOJO2_DIAGNOSTICS_FAILURE_CODE = 'kojo2/diagnostics-unavailable';

/** 问题面板 / marker 的来源标签（真源在包内；这里留一枚同值别名给既有消费方） */
export const KOJO2_DIAGNOSTICS_SOURCE = KOJO2_DIAGNOSTIC_SOURCE;

/**
 * **表达式端口**：恒等透传（导出给宿主装配用：组合根那张表只差这一个端口）。
 *
 * core 交给 backend 的是表达式源切片（已由 core 做完语法/符号校验）；backend 只负责把它
 * 落成 ERB 表达式。v1 的 `lowerExpression` 尚未接进 2.0 面（切流批的事），所以本批用
 * 恒等透传：**诊断仍然成立**（语法/结构/事件目录/存储期等判据都在 core 与 backend 的
 * 其它腿上），缺的只是"表达式内容在产物里的最终形状"——那不影响波浪线的位置与条数。
 */
export function kojo2IdentityCompileExpression(expr: { readonly text: string }): string {
  return expr.text;
}

/** 同步诊断入口（`createKojo2Diagnostics` 本身是同步纯计算；异步化留给将来的 worker） */
export type Kojo2SyncDiagnoseFn = (input: Kojo2DiagnosticsInput) => Kojo2DiagnosticsResult;

/**
 * 方言诊断端口（LAU-D1b）：解析一次，把 `core/dialect/*` 那几条并进同一轮诊断。
 *
 * 语义全在 `@kojo/kojo-core` 的 `resolveDialectBinding`；本文件只做**并集**：
 * 方言诊断先上（无 span 的落在文件头），编译诊断照旧在后，markers 由同一份 source 重算。
 * 不给这个端口 ⇒ 这一批诊断与旧行为逐字相同（既有调用方零改动）。
 *
 * LAU-D2：同一份解析结果还喂**方言体检**（`dialect lint`）——绑定成功时用它的
 * `facts` / `carrier` / `validates` 判事件名与事件落点，`diagnostics` 里的
 * `core/carrier/unowned` 也接进同一张清单（不重造第二条）。未经绑定时体检交 `null`
 * （零诊断：没有事实 ≠ 事实不符）。
 */
export interface Kojo2DialectDeps {
  readonly resolve: (input: {
    readonly project: GameProject | null;
    readonly filePath: string;
    readonly source: string;
  }) => DialectBindingResolution;
}

/* ---------------------- 诊断形状 → markers（宿主只做这一段翻译） ---------------------- */

/** 一条判据行 → 契约行装饰（与插件侧 `toLineDecoration` 同一把尺子；方言诊断合并时用） */
function rowToDecoration(row: Kojo2DiagnosticRow): LineDecoration {
  return {
    line: row.line,
    startColumn: row.startColumn,
    endColumn: row.endColumn,
    ...(row.endLine === row.line ? {} : { endLine: row.endLine }),
    severity: row.severity,
    message: row.message,
    code: row.code,
    source: KOJO2_DIAGNOSTICS_SOURCE,
  };
}

/** 源文本行宽表（marker 落点夹取；与旧 `createSourceLineIndex` 同一口径，只留夹取要用的两格） */
function lineWidthsOf(sourceText: string): { readonly lineCount: number; widthOf(line: number): number } {
  const starts: number[] = [0];
  for (let offset = 0; offset < sourceText.length; offset += 1) {
    if (sourceText.charCodeAt(offset) === 10) starts.push(offset + 1);
  }
  const endOf = (line: number): number => {
    const next = starts[line];
    const rawEnd = next === undefined ? sourceText.length : next - 1;
    const start = starts[line - 1] ?? 0;
    if (rawEnd > start && sourceText.charCodeAt(rawEnd - 1) === 13) return rawEnd - 1;
    return rawEnd;
  };
  return {
    lineCount: starts.length,
    widthOf(line) {
      const start = starts[line - 1] ?? 0;
      return Math.max(1, endOf(line) - start + 1);
    },
  };
}

/**
 * 行装饰 → Monaco markers（**翻译**，判据已在包内做过落点归一）。
 *
 * 这里只夹到源文本现实（行号 / 列宽），不重算区间语义：判据搬走后 `normalizeSpan` 那套
 * 越界 / 零宽 / 代理对规则只住在 `@kojo/kojo-lang/diagnostics` 一处，宿主再抄一遍就是第二份。
 * 跨行装饰（`endLine`）原样保留——Monaco marker 原生支持多行区间。
 */
export function kojo2DecorationsToMarkers(
  monaco: Kojo2MarkerSeveritySource,
  decorations: readonly LineDecoration[],
  sourceText: string,
): Monaco.editor.IMarkerData[] {
  const widths = lineWidthsOf(sourceText);
  return decorations.map((decoration) => {
    const line = Math.min(Math.max(1, Math.trunc(decoration.line)), widths.lineCount);
    const startColumn = Math.min(
      Math.max(1, Math.trunc(decoration.startColumn ?? 1)),
      widths.widthOf(line),
    );
    const endLine = Math.min(Math.max(line, Math.trunc(decoration.endLine ?? line)), widths.lineCount);
    const endMaxColumn = widths.widthOf(endLine);
    const endColumn = Math.min(
      Math.max(endLine === line ? startColumn : 1, Math.trunc(decoration.endColumn ?? endMaxColumn)),
      endMaxColumn,
    );
    return {
      severity: decoration.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
      message: decoration.message,
      code: decoration.code,
      source: KOJO2_DIAGNOSTICS_SOURCE,
      startLineNumber: line,
      startColumn,
      endLineNumber: endLine,
      endColumn,
    };
  });
}

/** core 诊断 → 行装饰（方言诊断并入同一轮波浪线时走这里；落点归一与插件同一把尺子） */
export function kojo2DiagnosticsToDecorations(
  diagnostics: readonly KojoDiagnostic[],
  sourceText: string,
): LineDecoration[] {
  return kojo2RowsOfDiagnostics(diagnostics, sourceText).map(rowToDecoration);
}

/**
 * `KojoDiagnostic[]` → Monaco markers（**只做翻译**；判据在 `@kojo/kojo-lang/diagnostics`）。
 *
 * 保留这一枚给既有调用方（快速修复 / 方言测试按 core 诊断直接取 markers）：
 * 行 / 列归一在包内完成，这里只夹到源文本现实。
 */
export function kojo2DiagnosticsToMarkers(
  monaco: Kojo2MarkerSeveritySource,
  diagnostics: readonly KojoDiagnostic[],
  sourceText: string,
): Monaco.editor.IMarkerData[] {
  return kojo2DecorationsToMarkers(monaco, kojo2DiagnosticsToDecorations(diagnostics, sourceText), sourceText);
}

/**
 * 把方言诊断并进一次已完成的 2.0 诊断（纯函数；导出给 node 池直测）。
 *
 * 计数三格（`errorCount` / `warningCount` / `ok`）全部按并集重算——**不许**保留编译那次
 * 的读数：`core/dialect/mismatch` 是 error，留在旧读数里会让问题面板表头与状态栏对不上。
 * `artifacts` 原样保留（产物与 source map 仍只属于那一次编译）。
 */
export function withDialectDiagnostics(
  result: Kojo2DiagnosticsResult,
  dialectDiagnostics: readonly KojoDiagnostic[],
  severitySource: Kojo2MarkerSeveritySource,
  source: string,
): Kojo2DiagnosticsResult {
  if (dialectDiagnostics.length === 0) return result;
  const diagnostics = [...dialectDiagnostics, ...result.diagnostics];
  const errorCount = diagnostics.filter((item) => item.severity === 'error').length;
  const warningCount = diagnostics.filter((item) => item.severity === 'warning').length;
  return {
    ...result,
    diagnostics,
    markers: kojo2DiagnosticsToMarkers(severitySource, diagnostics, source),
    errorCount,
    warningCount,
    ok: result.error === null && errorCount === 0,
  };
}

/**
 * 把**方言体检**的结论挂到一次诊断结果上（LAU-D2；纯函数）。
 *
 * 与 {@link withDialectDiagnostics} 的分工：那一条把方言诊断并进**波浪线**（错配必须可见、
 * 必须有位置）；本函数只挂清单——`diagnostics` / `markers` / 三格计数**一个字都不动**，
 * 因为体检是聚合面（同类 400 条 ⇒ 1 行），把它并进 markers 就是几百条波浪线糊屏。
 * `lint === null`（未绑定 / 没跑）⇒ 原样返回，既有调用方零改动。
 */
export function withDialectLint(
  result: Kojo2DiagnosticsResult,
  lint: Kojo2DialectLintReport | null,
): Kojo2DiagnosticsResult {
  if (lint === null || lint.diagnostics.length === 0) return result;
  return { ...result, lint: { dialect: lint.dialect, diagnostics: lint.diagnostics } };
}

/** `createSlotKojo2Diagnose` 的依赖（内核槽位 + Monaco severity 表 + 可选方言端口） */
export interface Kojo2SlotDiagnoseOptions {
  /** 内核（槽查询 + 当前项目现取；项目可开可关，不缓存上一个项目的事实） */
  readonly kernel: Kernel;
  /** Monaco 的 severity 表（宿主传真实例；测试传同形状替身） */
  readonly severitySource: Kojo2MarkerSeveritySource;
  /** 方言诊断端口（LAU-D1b，可选；省略 ⇒ 不并方言诊断） */
  readonly dialect?: Kojo2DialectDeps;
}

/**
 * 造**问槽**的诊断入口（B3 收口最后一格的接线面）。
 *
 * ## 为什么是"问槽"而不是"叫编译"
 *
 * 文档级诊断的判据与供方都在 `@kojo/plugin-kojo-lang`（经专用槽 `ui.editor.decorator`）。
 * 宿主这层只该做三件事：把正文 / 路径 / 当前项目递进去（请求）、把回来的行装饰翻成
 * markers + 问题面板行（翻译）、把"没有供方 / 没面"说出口（降级）。判据一个字都不留——
 * 留了就是第二份，两份必然漂（B3c–B3j 一路搬空的同一条理由）。
 *
 * ## 失败口径（与旧实现逐字一致）
 *
 * - **没有供方**（插件未装载 / 未激活）⇒ 抛错，走 `onFailure` 的三种可见面（清旧波浪线 /
 *   面板写 `kojo2/diagnostics-unavailable` / toast），绝不交"空诊断"假装这份文件干净；
 * - **供方抛错**（例如这个工程没有 2.0 诊断面）⇒ 原样上抛，同上；
 * - **编译入口自报失败**（`error` 非空）⇒ 结果带 `error`，由同步器折成失败可见面；
 * - **方言诊断照旧并入同一轮**（LAU-D1b）：错配必须可见、必须有位置；计数三格按并集重算。
 *
 * ## 一次编译两处消费（K2-EDITOR-MOUNT ①）
 *
 * 编译成品（原始诊断 / 产物 / source map）由插件记进 `@kojo/kojo-lang/diagnostic-result`，
 * 这里按路径取回并核对正文一致——预览与展开视图读的是同一次编译，不是第二份。
 */
export function createSlotKojo2Diagnose(options: Kojo2SlotDiagnoseOptions): Kojo2SyncDiagnoseFn {
  return (input) => {
    const project = projectOfKernel(options.kernel);
    let contribution;
    try {
      contribution = options.kernel.slots
        .query('ui.editor.decorator')
        .find((item) => item.id === KOJO2_DIAGNOSTICS_CONTRIBUTION_ID);
    } catch {
      contribution = undefined;
    }
    if (contribution === undefined) {
      throw new Error(
        '2.0 文档级诊断的供方没有注册（@kojo/plugin-kojo-lang 未装载 / 未激活）：' +
          '本文件不做 2.0 诊断（不回退到任何宿主内实现）。',
      );
    }
    // 插件抛错（没有 2.0 诊断面 / 事实对不上）原样上抛 —— 走 onFailure 的可见面。
    const decorations = contribution.decorate({ path: input.filePath, text: input.source, project });
    const snapshot = kojo2DiagnosticResultFor(input.filePath);
    // 正文核对：两个分屏同名文件 / 迟到的一轮都可能留下别的快照，正文不符就当没有。
    const fresh = snapshot !== null && snapshot.source === input.source ? snapshot : null;
    const compileDiagnostics: readonly KojoDiagnostic[] = fresh?.diagnostics ?? [];
    const artifacts: Kojo2DiagnosticsArtifacts | null = fresh?.artifacts ?? null;
    const error: string | null = fresh?.error ?? null;

    // 这一轮文档级诊断的成品：形状全按槽契约（插件的行装饰）搬，判据一个字不重算。
    const base: Kojo2DiagnosticsResult = {
      filePath: input.filePath,
      diagnostics: compileDiagnostics,
      markers: kojo2DecorationsToMarkers(options.severitySource, decorations, input.source),
      artifacts,
      error,
      errorCount: compileDiagnostics.filter((item) => item.severity === 'error').length,
      warningCount: compileDiagnostics.filter((item) => item.severity === 'warning').length,
      ok: error === null && !compileDiagnostics.some((item) => item.severity === 'error'),
    };
    // LAU-D1b：方言诊断与编译诊断走**同一轮**、同一份 markers / 问题面板条目。
    // 方言侧不另开通道（铁律 4 的"冲突必须 error"就落在既有问题面板上）。
    const resolution: DialectBindingResolution | null =
      options.dialect === undefined
        ? null
        : options.dialect.resolve({ project, filePath: input.filePath, source: input.source });
    const merged = withDialectDiagnostics(
      base,
      resolution?.diagnostics ?? [],
      options.severitySource,
      input.source,
    );
    if (resolution === null) return merged;
    // LAU-D2：方言体检（`dialect lint`）——绑定成功才跑；未绑定 / 响应错配 ⇒ `binding === null`
    // ⇒ `lintKojo2Dialect` 直接交 `null`（零诊断：没有事实绝不报"未知事件"）。
    return withDialectLint(
      merged,
      lintKojo2Dialect({
        source: input.source,
        facts: resolution.binding?.facts ?? null,
        binding: resolution.binding,
        diagnostics: merged.diagnostics,
        resolutionDiagnostics: resolution.diagnostics,
      }),
    );
  };
}

/**
 * 从 `GameProject.charaIndex` 推角色号：**最长目录前缀**命中者胜（与文件树分组的
 * `kojoOwners` 同一条"长前缀优先"口径，避免嵌套目录误归属）。
 *
 * 纯函数、零 IO；`charaIndex` 缺席 / 文件不在任何 `kojoDir` 下 ⇒ `undefined`（不猜）。
 * 路径归一走契约的 `pathKey`（Windows 分隔符 / 大小写差异下同一个文件必须判得上）。
 */
export function charNoForProjectPath(project: GameProject | null, filePath: string): string | undefined {
  if (project === null) return undefined;
  // 契约上 `charaIndex` 是必填，但 `kernel.project.current()` 交给这里的是**运行期对象**：
  // 工程正在装载时它可能还是半成品。少了索引就让"这条链路抛 TypeError"顶掉真正的诊断
  // 结论（`onFailure` 会把 `Cannot read properties of undefined` 原样抖给作者），
  // 而正确语义是"推不出角色号"——由 backend 的 fail-closed 如实报缺。
  const index: GameProject['charaIndex'] | undefined = project.charaIndex;
  if (index === undefined || index === null || typeof index.values !== 'function') return undefined;
  let bestLength = -1;
  let found: string | undefined;
  for (const chara of index.values()) {
    if (typeof chara.kojoDir !== 'string' || chara.kojoDir.length === 0) continue;
    // 归属判据（分隔符 / 大小写）走契约的 `isPathUnder`，不在这里手写 startsWith——
    // win32 归一化后的分隔符是 `\`，拿 `/` 拼前缀在 Windows 上会恒定判不上。
    if (!isPathUnder(chara.kojoDir, filePath)) continue;
    const length = pathKey(chara.kojoDir).length;
    if (length > bestLength) {
      bestLength = length;
      found = String(chara.no);
    }
  }
  return found;
}

/** 从 kernel 现取项目（项目可开可关；每次诊断再读，不缓存上一个项目的事实） */
function projectOfKernel(kernel: Kernel): GameProject | null {
  try {
    return kernel.project.current();
  } catch {
    return null;
  }
}

/**
 * 宿主**没有**替换诊断入口时的缺省：问槽（`createSlotKojo2Diagnose`）。
 *
 * 这里不再保留任何"兜底编译"：判据与供方都在插件那一侧，宿主自留一份就是第二份判据。
 * 插件缺席 ⇒ 缺省入口抛错 ⇒ `onFailure` 的三种可见面齐亮（见 `Kojo2SlotDiagnoseOptions`）。
 */

/* ============================== 一次编译两处消费（K2-EDITOR-MOUNT ①） ============================== */

/**
 * 诊断那次 core 编译的**成品缓存**（预览面板的唯一数据源）。
 *
 * ## 为什么必须走缓存端口，而不是让预览自己编译
 *
 * 预览面板要的三格——产物 `erb`、诊断、**与产物同一次**的 source map——都已经在诊断链路
 * 里算出来了（`compileKojoSource` 一次给全）。让预览再编译一次 = 两份结果；哪怕输入一字
 * 不差，source map 也是两个对象，预览模型的"不同源"守卫（行数不等即 TypeError）随时会
 * 因为两次编译之间作者多敲了一个字而误报，而"用 A 次的产物配 B 次的 map"错位跳行是
 * 静默的数据级缺陷。所以本层把**诊断那一份**原样留下，预览只读。
 *
 * ## 口径
 *
 * - 键走契约的 `pathKey`（Windows 分隔符 / 大小写：model URI 与 io 路径不保证同一写法）；
 * - **有界**：只留最近 `limit` 份（缺省 {@link KOJO2_COMPILE_CACHE_LIMIT}）——作者来回切
 *   标签也不必每切一次就重编译一次，但绝不无界增长；
 * - 撤下（换标签 / 关文件 / 编译失败 / 卸载）由诊断接线调用 `forget`：**后台标签不保留
 *   2.0 结论**，与 markers / 问题面板同一条"只认活动 model"的真相。
 */
export interface Kojo2CompileCache {
  /** 该路径**上一次**诊断编译的成品（没有 / 已撤下 ⇒ `null`） */
  getLastCompile(filePath: string): Kojo2PreviewCompilation | null;
  /** 记下这一份（同一路径覆盖；超上限从最久未记的那份开始丢） */
  remember(filePath: string, compilation: Kojo2PreviewCompilation): void;
  /** 撤下这一份（不存在 = no-op） */
  forget(filePath: string): void;
  /** 全部撤下（卸载 / 换项目） */
  clear(): void;
  /** 当前留了几份（观测面：有界性的读数） */
  readonly size: number;
}

/** 缓存上限：远大于"同时开着的标签"，又小到不会留住一整天的产物 */
export const KOJO2_COMPILE_CACHE_LIMIT = 8;

/** 造一份缓存（纯内存、零 IO；宿主在装配那一刻建一份，诊断与预览共用同一个实例） */
export function createKojo2CompileCache(
  options: { readonly limit?: number } = {},
): Kojo2CompileCache {
  const limit = Math.max(1, Math.trunc(options.limit ?? KOJO2_COMPILE_CACHE_LIMIT));
  const entries = new Map<string, Kojo2PreviewCompilation>();
  return {
    getLastCompile(filePath) {
      if (typeof filePath !== 'string' || filePath.length === 0) return null;
      return entries.get(pathKey(filePath)) ?? null;
    },
    remember(filePath, compilation) {
      if (typeof filePath !== 'string' || filePath.length === 0) return;
      const key = pathKey(filePath);
      // 重插到队尾：Map 的插入序就是这里的 LRU，最近编译的那份最不容易被丢
      entries.delete(key);
      entries.set(key, compilation);
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    forget(filePath) {
      if (typeof filePath !== 'string' || filePath.length === 0) return;
      entries.delete(pathKey(filePath));
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * 把一次诊断的成品转成预览要的形状；转不出来（没有产物 / 入口不提供）⇒ `null`。
 *
 * source map 模型的构造（O(n) 切行，索引懒建）放在这里而不是预览的渲染链里：
 * 诊断跑完的那一拍是**作者停手之后**，渲染链里只该有模型查询。
 */
export function compilationOfDiagnostics(
  result: Pick<Kojo2DiagnosticsResult, 'diagnostics' | 'artifacts'>,
): Kojo2PreviewCompilation | null {
  const artifacts: Kojo2DiagnosticsArtifacts | null = result.artifacts ?? null;
  if (artifacts === null) return null;
  try {
    return {
      compiled: { erb: artifacts.erb, diagnostics: result.diagnostics },
      sourceMapModel: buildKojo2SourceMapModel(artifacts),
    };
  } catch {
    return null; // 产物/映射本身不自洽 ⇒ 预览不亮（诊断照常，问题面板是真相）
  }
}

/* ============================== markers → 问题面板 ============================== */

function problemSeverityOf(
  severitySource: Kojo2MarkerSeveritySource,
  severity: Monaco.MarkerSeverity,
): EditorProblem['severity'] {
  const table = severitySource.MarkerSeverity;
  if (severity === table.Warning) return 'warning';
  // Hint / Info 在 core 诊断里不存在（只有 error / warning 两档）；意外值按 info 记，
  // 不降级成 error（那会凭空造红线）。
  if (severity === table.Info || severity === table.Hint) return 'info';
  return 'error';
}

/**
 * 一次诊断的 markers → 问题面板条目（**整档替换**语义，与 `problem-store` 一致）。
 *
 * 列区间只在**同一行**时带上（`EditorProblem.line` 是单行；跨行 marker 的行号取起点，
 * 列区间若跨行就落回行级信息——面板的跳转判据 `reveal-position` 自己会退化）。
 */
export function kojo2ProblemsOf(
  filePath: string,
  markers: readonly Monaco.editor.IMarkerData[],
  severitySource: Kojo2MarkerSeveritySource,
): EditorProblem[] {
  return markers.map((marker) => ({
    path: filePath,
    line: marker.startLineNumber,
    ...(marker.endLineNumber === marker.startLineNumber && marker.endColumn > marker.startColumn
      ? { span: { columnStart: marker.startColumn, columnEnd: marker.endColumn } }
      : {}),
    severity: problemSeverityOf(severitySource, marker.severity),
    message: marker.message,
    ...(marker.code !== undefined ? { code: String(marker.code) } : {}),
    source: KOJO2_DIAGNOSTICS_SOURCE,
  }));
}

/** 诊断链路失败时上账的那一条（可见、可点、码稳定；不是"这份文件干净"） */
export function kojo2FailureProblem(filePath: string, message: string): EditorProblem {
  return {
    path: filePath,
    line: 1,
    severity: 'error',
    message: `Kojo 2.0 诊断链路失败：${message}（本文件旧波浪线已清空，修好前不会自动恢复）`,
    code: KOJO2_DIAGNOSTICS_FAILURE_CODE,
    source: KOJO2_DIAGNOSTICS_SOURCE,
  };
}

/* ============================== 编辑器事件 → 问题同步 ============================== */

/** 安装器的注入面（生产走缺省；测试注入假 editor / 假 diagnose / 手动时钟） */
export interface Kojo2ProblemWiringOptions {
  readonly editor: Monaco.editor.IStandaloneCodeEditor;
  readonly kernel: Kernel;
  /** 兜底路径（model URI 缺席时用；`onDidChangeModel` 那一拍它可能还是上一个标签的值） */
  readonly filePathRef: { current: string };
  /** 糖投影 model 是派生物（没有可诊断的语义）⇒ 跳过；非糖视图可省略 */
  readonly sugarModelRef?: { current: Monaco.editor.ITextModel | null };
  readonly markerHost: Kojo2MarkerHost;
  readonly severitySource: Kojo2MarkerSeveritySource;
  /** 宿主通知中心（失败可见）；缺省 = 只写问题面板 + console.error */
  readonly notify?: (notice: NoticeInput) => void;
  /** 替换诊断入口（测试 / 将来 worker）；缺省 = {@link createSlotKojo2Diagnose}（问槽） */
  readonly diagnose?: Kojo2DiagnoseFn;
  /**
   * 方言诊断端口（LAU-D1b，可选）：给缺省入口（`createSlotKojo2Diagnose`）用；与 `diagnose`
   * 互斥（自定义入口自带方言逻辑时不再叠）。省略 ⇒ 不并方言诊断（旧调用方零改动）。
   */
  readonly dialect?: Kojo2DialectDeps;
  readonly debounceMs?: number;
  readonly scheduler?: Kojo2DebounceScheduler;
  /** 问题面板写入端（缺省 = `problem-store.setProblems`） */
  readonly writeProblems?: (filePath: string, items: readonly EditorProblem[]) => void;
  /** 问题面板清理端（缺省 = `problem-store.clearProblems`） */
  readonly eraseProblems?: (filePath: string) => void;
  /**
   * **一次编译两处消费**的成品缓存（K2-EDITOR-MOUNT ①）：诊断跑完把这一份留下，
   * 预览面板按路径只读，源码全仓没有第二次 core 编译。省略 = 不缓存（只有诊断）。
   */
  readonly compileCache?: Kojo2CompileCache;
  /**
   * 缓存变化通知：`filePath` = 这一份已可预览；`null` = 这一份被撤下（换标签 / 关文件 /
   * 编译失败 / 卸载）。宿主据此让预览入口 `refresh` / `setFile(null)`——**只有这一条
   * 通知能保证预览与波浪线同源**（两者都是这次编译的产物）。
   */
  readonly onCompile?: (filePath: string | null) => void;
}

const GLOBAL_SCHEDULER: Kojo2DebounceScheduler = {
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * 从 model 上取真实路径（model 池用 `Uri.file(path)` 建 model；桩 model 允许没有 uri）。
 *
 * 导出给预览接线用（K2-EDITOR-MOUNT ①）：切标签那一拍要判"新标签是不是 `.kojo2`"，
 * 判据必须与诊断这条腿同一个（`filePathRef` 在 `onDidChangeModel` 的当拍可能还是旧值）。
 */
export function pathOfKojo2Model(model: Monaco.editor.ITextModel, fallback: string): string {
  const uri = (model as unknown as { uri?: { fsPath?: unknown } }).uri;
  if (uri && typeof uri === 'object' && typeof uri.fsPath === 'string' && uri.fsPath.length > 0) {
    return uri.fsPath;
  }
  return fallback;
}

/**
 * 装上 2.0 诊断接线，返回**幂等**的退场函数。
 *
 * 诊断是**语言面**（K2-SURFACE-DEFAULT）：`.kojo2` 一打开就归 2.0 管，不看切流阶段。
 * 保留 {@link kojo2DiagnosticsEnabled} 这一拍只是让装配处只有一个门（调用方零改动），
 * 它现在恒 `true`；真正的归属逐文件判（`kojo2OwnsDiagnostics`）。
 */
export function installKojo2ProblemWiring(options: Kojo2ProblemWiringOptions): () => void {
  if (!kojo2DiagnosticsEnabled()) return () => undefined;

  const { editor, kernel } = options;
  const writeProblems = options.writeProblems ?? setProblems;
  const eraseProblems = options.eraseProblems ?? clearProblems;
  const scheduler = options.scheduler ?? GLOBAL_SCHEDULER;
  const debounceMs = Math.max(0, Math.trunc(options.debounceMs ?? KOJO2_PROBLEM_DEBOUNCE_MS));
  const diagnose =
    options.diagnose ??
    createSlotKojo2Diagnose({
      kernel,
      severitySource: options.severitySource,
      ...(options.dialect !== undefined ? { dialect: options.dialect } : {}),
    });

  const notify = (notice: NoticeInput): void => {
    if (options.notify) {
      options.notify(notice);
      return;
    }
    console.error(`[kojo2-diagnostics] ${notice.message}${notice.detail ? ` · ${notice.detail}` : ''}`);
  };

  /**
   * 把这一轮诊断的成品留下（预览唯一的读入口；K2-EDITOR-MOUNT ①）。
   *
   * 没有产物 / 产物不自洽 ⇒ **撤下**并通知 `null`：预览不能拿上一轮的 map 配这一轮的产物。
   */
  const rememberCompilation = (filePath: string, result: Kojo2DiagnosticsResult): void => {
    const cache = options.compileCache;
    if (cache === undefined) return;
    const compilation = compilationOfDiagnostics(result);
    if (compilation === null) {
      cache.forget(filePath);
      options.onCompile?.(null);
      return;
    }
    cache.remember(filePath, compilation);
    options.onCompile?.(filePath);
  };

  /** 撤下这一份（换标签 / 关文件 / 失败 / 卸载）：预览随之卸载，不留在屏上 */
  const forgetCompilation = (filePath: string): void => {
    if (filePath.length === 0) return;
    options.compileCache?.forget(filePath);
    // 包内交接面同一条真相：波浪线撤了，那一份编译成品也不许留给别的面板读到。
    forgetKojo2DiagnosticResult(filePath);
    options.onCompile?.(null);
  };

  const sync = createKojo2ProblemSync({
    markerHost: options.markerHost,
    diagnose,
    // 时间轴在本层（见文件头「为什么再加一层 debounce」）；第 2 层一收到就排下一拍。
    debounceMs: 0,
    ...(options.scheduler !== undefined ? { scheduler } : {}),
    onDiagnostics: ({ filePath, result }) => {
      // LAU-D2：先写编译/方言那一片**逐行**问题，再追加**方言体检**的汇总行
      // （同类只一行，§5.5 呈现纪律）。两者走同一个 `writeProblems`（整档替换语义）——
      // 不新造第二个面板、第二条上账通道。
      const rows = kojo2ProblemsOf(filePath, result.markers, options.severitySource);
      const lint = result.lint;
      if (lint !== undefined) {
        rows.push(
          ...kojo2DialectLintProblems(
            filePath,
            aggregateKojo2DialectLint({ dialect: lint.dialect, diagnostics: lint.diagnostics }),
          ),
        );
      }
      writeProblems(filePath, rows);
      rememberCompilation(filePath, result);
    },
    onCleared: ({ filePath }) => {
      // 换标签 / 关文件 / 显式清理：面板里那一份也跟着撤（后台标签不保留 2.0 结论——
      // 第 2 层的判据就是"只认活动 model"，面板与波浪线必须同一个真相）。
      // `filePath` 为空 = 清理时已无从反查（model 已 dispose），没有可撤的条目。
      if (filePath.length > 0) eraseProblems(filePath);
      // 编译成品同一条真相：波浪线撤了，预览必须一起撤（否则作者看的是上一份字节）。
      forgetCompilation(filePath);
    },
    onFailure: ({ filePath, message }) => {
      // 旧波浪线已由第 2 层清掉；这里补"失败本身"的可见面（面板 + toast），
      // 不然"屏上什么都没了"会被读成"这份文件是干净的"。
      writeProblems(filePath, [kojo2FailureProblem(filePath, message)]);
      notify({
        kind: 'error',
        message: 'Kojo 2.0 诊断失败：这份文件暂时没有实时诊断（旧波浪线已清空）。',
        detail: message,
      });
    },
  });

  /**
   * 归 2.0 的文件这一拍**拿不到正文**时的可见提示（同一份只吵一次）。
   *
   * LAU-3b-FLIP 之后归属只认扩展名（`.kojo` / `.kojo2` 恒归 2.0），不再有"要正文才能
   * 定解析器"那一档；但诊断本身仍要正文——读不到就这一拍跳过，**不静默**：作者得知道
   * 波浪线为什么没亮，否则"屏上什么都没有"会被读成"这份文件是干净的"。
   */
  const warnedUnreadable = new Set<string>();
  const noteUnreadable = (filePath: string): void => {
    if (warnedUnreadable.has(filePath)) return;
    warnedUnreadable.add(filePath);
    notify({
      kind: 'info',
      message: 'Kojo 2.0：这份文件当前取不到正文，诊断这一拍先跳过（下次内容变化会重试）。',
      detail: filePath,
    });
  };

  /** 本轮诊断目标（`source` 只在归属判据必须读正文时带上，`run` 复用它不二次整篇复制） */
  interface WiringTarget {
    readonly model: Monaco.editor.ITextModel;
    readonly filePath: string;
    readonly source?: string;
  }

  /**
   * 当前该诊断的目标：活动 model 且**路由**判定归 2.0 管（糖投影 = 派生物，跳过）。
   *
   * 判据与语言面同一个入口（`kojo2-diagnostics-gate` 的 `kojo2RouteForPath`）：LAU-3b-FLIP
   * 之后扩展名即归属——`.kojo` / `.kojo2` ⇒ 接管，`.kojo1` / 非 kojo ⇒ 不接管。
   * `readSource=false` 只判路径（击键热路径）；`readSource=true` 才读正文，读不到就这一拍
   * **跳过**并露一句话（{@link noteUnreadable}），不猜、不静默。
   */
  const resolveTarget = (readSource: boolean): WiringTarget | null => {
    const model = editor.getModel();
    if (!model || model.isDisposed()) return null;
    if (options.sugarModelRef?.current === model) return null;
    const filePath = pathOfKojo2Model(model, options.filePathRef.current);
    // 便宜预筛：`.erb` / `.json` 之类每次击键都不该摸阶段与正文
    if (filePath.length === 0 || !isKojo2RouteablePath(filePath)) return null;

    const pathDecision = kojo2RouteForPath(filePath);
    if (pathDecision.kind !== 'resolved' || pathDecision.parser !== 'kojo2') return null;
    if (!readSource) return { model, filePath };
    try {
      return { model, filePath, source: model.getValue() };
    } catch {
      noteUnreadable(filePath);
      return null;
    }
  };

  let timer: unknown = null;
  const cancel = (): void => {
    if (timer === null) return;
    scheduler.clearTimeout(timer);
    timer = null;
  };

  /** 定时器响时才取一次文本（见文件头）；取完立刻交给第 2 层并催它跑（其 debounce = 0）。 */
  const run = (): void => {
    const target = resolveTarget(true);
    if (target === null) {
      sync.clear();
      return;
    }
    sync.setActive(target.model, target.filePath);
    const source = target.source ?? target.model.getValue();
    if (!sync.schedule(target.model, target.filePath, source)) return;
    void sync.flush();
  };

  const request = (immediate: boolean): void => {
    cancel();
    if (immediate) {
      run();
      return;
    }
    timer = scheduler.setTimeout(() => {
      timer = null;
      run();
    }, debounceMs);
  };

  const contentSub = editor.onDidChangeModelContent(() => {
    // 非 2.0 文件不排定时器（`.erb` 的每次击键都排一个 200ms 的空转没有必要）；
    // `needs-content` 也算"候选"：正文留到定时器响时只读一次，不在这里逐键扫全文。
    if (resolveTarget(false) === null) {
      cancel();
      sync.clear();
      return;
    }
    request(false);
  });
  const modelSub = editor.onDidChangeModel(() => request(true));
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cancel();
    contentSub.dispose();
    modelSub.dispose();
    sync.dispose();
  };
  // 装上就有一次：打开 2.0 文件（或挂载时正停在 2.0 文件上）首屏即诊断，不等人敲键。
  request(true);
  return dispose;
}
