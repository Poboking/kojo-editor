/**
 * Kojo 2.0 编辑器接入：**项目级 Application Service**（`kojo2-project-service-contract.ts`
 * 的默认实现）。
 *
 * 职责（对应契约注释里的分层）：
 * - **项目生命周期**：`refresh()` 现取快照（Host 端口）→ 编译协调 → 快照缓存 → 组装 →
 *   发布门禁；世代号保证换项目/重入后迟到的 `load()` 结果被丢弃；
 * - **诊断汇总**：把 core 的四种诊断形状（ProjectDiagnostic / DispatchPlanDiagnostic /
 *   KojoDiagnostic / ProjectAssemblyDiagnostic）映射成 UI 只认的 `Kojo2ProjectProblem[]`，
 *   不把 core 形状泄漏给面板；
 * - **组装与发布**：M1 legacy 字节由 Host 端口 `compileLegacy` 供给，`assembleProjectErb`
 *   判完整；发布只走 `deps.exportArtifact`（法定通道 = `kernel.io.exportFile`，对话框即授权）。
 *
 * 本文件不 import 任何插件、不读盘、不碰 React/Monaco；游戏事实全部来自
 * `deps.load()` 返回的 `Kojo2CompileBundle`。
 *
 * ## 口径（实现决定，照这里读代码）
 *
 * - **相位**：`idle` 无项目/已 reset；`loading` 正在取快照/编译；`ready` 当前源码
 *   `buildStatus==='succeeded'`；`failed` 取快照或编译抛错，或当前源码构建失败
 *   （`result` 仍保留为诊断视图）；`stale` 编辑器内容变了（`markStale`），`result` 不动。
 * - **缓存**：单条「当前快照」缓存（不做 LRU）。键 = provenance 身份（adapter /
 *   registry / backend / gameFingerprint / facts / core 版本 + capability + sourceMapPolicy）
 *   + 文档**有序** `(pathKey, stableHash(text), layerId)` + `dispatchSelectors` + 编译模式
 *   （`requireDispatch:true` / `emitDiagnosticArtifacts:true`）+ `projectId`。键相同 ⇒
 *   `stats.cacheHit=true`，复用上一条 `result/plan/assembly`，不重编译。
 * - **模式**：发布模式 `requireDispatch:true`；同时开 `emitDiagnosticArtifacts:true`——
 *   构建失败时仍能看到 ready target 的 dispatch ERB 作诊断材料（`publishable` 恒 false）。
 * - **组装时机**：`refresh` 在 `buildStatus==='succeeded'` 时**自动**跑一次
 *   `planProjectErbAssembly` + `assembleProjectErb`（`assemble()` 同时是公开入口，返回
 *   缓存）。构建失败时不组装（plan 诊断已可见，`assembly` 保持 null）。
 * - **publishable**：`当前源码 build succeeded ∧ assembly.status==='complete' ∧
 *   exportArtifact 已注入` 才为 true；`publishBlockReason` 是第一条人话原因（供 UI 禁用
 *   按钮）。`publish()` 与它同源，拒绝时 `unitCount=0`。`publish()` **不隐式重编译**：
 *   `stale`（源码已改未重建）/ `failed` 一律拒绝——调用方要先 `refresh('publish')`。
 * - **`reset()`**：换项目/关项目用。清空当前结果、诊断、缓存**与 `lastGood`**（不同项目
 *   的旧产物不允许被当成"上次成功"展示），世代 +1 作废在途 `refresh`，回 `idle`。
 * - **`dispose()`**：退订全部监听、作废在途 refresh、状态清回 `idle`（此后 `refresh`
 *   是 no-op；不通知 `onState`）。
 * - **诊断 severity**：core 目前只有 error/warning；映射时防御性过滤，只保留这两级
 *   （info 丢弃——契约 `Kojo2ProjectProblemSeverity` 没有 info）。
 * - **通道归属**：`result.build.diagnostics` → `build`；`result.dispatchDiagnostics` →
 *   `dispatch`；`result.dispatchBackendDiagnostics` + `result.backendDiagnostics` →
 *   `dispatch-backend`（渲染后端失败的两种落点同属一族：KojoDiagnostic 只有 span）；
 *   `plan/assembly.diagnostics` → `assembly`；运行时选择 → `runtime`。编译抛错/取快照
 *   失败 → `build` + `service/compile-failed`。
 * - **legacy**：`plan.legacyFiles` 逐份从 `snapshot.documents` 按 `pathKey` 找正文 →
 *   `snapshot.compileLegacy(document)`；找不到正文或返回 null 时记 `assembly/legacy-missing`
 *   可见问题（不静默），该份不进 `legacyErb`（assembly 仍会判 incomplete）。
 * - **`markStale(paths?)`**：`paths` 是契约预留（项目编译没有按文件增量，core 级重编），
 *   当前只按整体标脏。
 *
 * ## 表达式端口（`deps.compileExpression`）
 *
 * `Kojo2CompileBundle.createBackend` 的 `compileExpression` 必填；Service 从
 * `deps.compileExpression` 取，缺省为**恒等透传**（只保证结构与诊断成立，产物表达式不是
 * 最终发布口径——已知缺口，生产由 workflow/组合根注入 v1 `lowerExpression` 管线）。
 * 也可整体用 `deps.compile` 覆盖项目编译。
 */
import {
  assembleProjectErb,
  compileProject,
  parseSource,
  planProjectErbAssembly,
  type DispatchPlanDiagnostic,
  type KojoDiagnostic,
  type KojoEmitBackend,
  type KojoExprText,
  type KojoFile,
  type KojoSpan,
  type ProjectAssemblyDiagnostic,
  type ProjectCompileFileInput,
  type ProjectCompileInput,
  type ProjectCompileResult,
  type ProjectDiagnostic,
  type ProjectErbAssembly,
  type ProjectErbAssemblyPlan,
  type ProjectLegacyErbInput,
  type ProjectLegacyFileExpectation,
  type RuntimeSelectionRequest,
} from '@kojo/kojo-core';
import { pathKey, stableHash } from '@kojo/plugin-api';
import type {
  Kojo2ProjectLastGood,
  Kojo2ProjectProblem,
  Kojo2ProjectPublishResult,
  Kojo2ProjectRefreshReason,
  Kojo2ProjectService,
  Kojo2ProjectServiceDeps,
  Kojo2ProjectServicePhase,
  Kojo2ProjectServiceState,
  Kojo2ProjectServiceStats,
  Kojo2ProjectSnapshot,
  Kojo2RuntimePreview,
} from './kojo2-project-service-contract';
import type { Kojo2ProjectDocument } from './kojo2-project-analysis';
import { resolveKojo2FunctionNameContext } from './kojo2-project-analysis';
import { kojo2ProjectFileIdentity } from './kojo2-project-file-identity';
import { createKojo2ProjectProvenance } from './kojo2-project-provenance';
import { resolveKojo2RuntimeSelection } from './kojo2-runtime-diagnostics';

/* ============================== 常量 ============================== */

const DEFAULT_ARTIFACT_FILE_NAME = 'kojo2-project.ERB';

const EMPTY_STATS: Kojo2ProjectServiceStats = Object.freeze({
  documentCount: 0,
  theaterCount: 0,
  groupCount: 0,
  compileMs: 0,
  assemblyMs: 0,
  cacheHit: false,
});

/** 缺省表达式端口：恒等透传（**仅供测试/诊断**；生产必须注入真管线，见文件头「契约缺口」）。 */
function identityCompileExpression(expression: KojoExprText): string {
  return expression.text;
}

/* ============================== 内部工具 ============================== */

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function freezeProblem(problem: Kojo2ProjectProblem): Kojo2ProjectProblem {
  return Object.freeze({
    ...problem,
    candidateTheaterIds: Object.freeze([...problem.candidateTheaterIds]) as readonly string[],
  });
}

function projectProblem(input: {
  readonly channel: Kojo2ProjectProblem['channel'];
  readonly code: string;
  readonly severity: Kojo2ProjectProblem['severity'];
  readonly message: string;
  readonly path?: string | null;
  readonly line?: number | null;
  readonly column?: number | null;
  readonly fileId?: string | null;
  readonly canonicalId?: string | null;
  readonly functionName?: string | null;
  readonly candidateTheaterIds?: readonly string[];
}): Kojo2ProjectProblem {
  return freezeProblem({
    channel: input.channel,
    code: input.code,
    severity: input.severity,
    message: input.message,
    path: input.path ?? null,
    line: input.line ?? null,
    column: input.column ?? null,
    fileId: input.fileId ?? null,
    canonicalId: input.canonicalId ?? null,
    functionName: input.functionName ?? null,
    candidateTheaterIds: input.candidateTheaterIds ?? [],
  });
}

/** 编译失败（异常 / 取快照失败）的统一可见问题。 */
function compileFailureProblem(message: string): Kojo2ProjectProblem {
  return projectProblem({
    channel: 'build',
    code: 'service/compile-failed',
    severity: 'error',
    message,
  });
}

/** 按 `ProjectFileId` 反查真实路径；查不到 = null（不猜）。 */
function pathOfFileId(result: ProjectCompileResult | null, fileId: string | null): string | null {
  if (result === null || fileId === null) return null;
  const file = result.build.projectIR.files.find((candidate) => candidate.fileId === fileId);
  return file === undefined ? null : file.path;
}

function sameSpan(left: KojoSpan, right: KojoSpan): boolean {
  return (
    left.start.line === right.start.line &&
    left.start.column === right.start.column &&
    left.end.line === right.end.line &&
    left.end.column === right.end.column
  );
}

function spanStartsBeforeOrAt(outer: KojoSpan, inner: KojoSpan): boolean {
  return (
    outer.start.line < inner.start.line ||
    (outer.start.line === inner.start.line && outer.start.column <= inner.start.column)
  );
}

function spanEndsAfterOrAt(outer: KojoSpan, inner: KojoSpan): boolean {
  return (
    outer.end.line > inner.end.line ||
    (outer.end.line === inner.end.line && outer.end.column >= inner.end.column)
  );
}

interface SpanLocation {
  readonly fileId: string;
  readonly path: string | null;
  readonly line: number;
  readonly column: number;
}

/**
 * `KojoDiagnostic` 只有 `span`：按 dispatch plan 的 branch `sourceSpan` / `fileId` 反查文件。
 *
 * 先找**精确相同**的 span，再找**包含**该 span 的 branch（诊断常指向 branch 内部的表达式）；
 * 都查不到 ⇒ null（项目级落点，**不猜文件**）。
 */
function locateSpan(result: ProjectCompileResult, span: KojoSpan | null): SpanLocation | null {
  if (span === null) return null;
  const candidates: { readonly sourceSpan: KojoSpan; readonly fileId: string }[] = [];
  for (const target of result.dispatchPlan.targets) {
    for (const branch of target.branches) {
      candidates.push({ sourceSpan: branch.sourceSpan, fileId: branch.fileId });
    }
  }
  for (const theater of result.build.linkedProject?.theaters ?? []) {
    candidates.push({ sourceSpan: theater.sourceSpan, fileId: theater.fileId });
  }
  const located =
    candidates.find((candidate) => sameSpan(candidate.sourceSpan, span)) ??
    candidates.find(
      (candidate) =>
        spanStartsBeforeOrAt(candidate.sourceSpan, span) &&
        spanEndsAfterOrAt(candidate.sourceSpan, span),
    );
  if (located === undefined) return null;
  return {
    fileId: located.fileId,
    path: pathOfFileId(result, located.fileId),
    line: span.start.line,
    column: span.start.column,
  };
}

/* ============================== 诊断映射 ============================== */

function problemOfBuildDiagnostic(diagnostic: ProjectDiagnostic): Kojo2ProjectProblem {
  // `role:'project'` = 属于整个项目（版本 / 依赖 / 未分组），没有可跳转文件。
  const projectLevel = diagnostic.primary.role === 'project';
  const span = projectLevel ? null : diagnostic.primary.span;
  return projectProblem({
    channel: 'build',
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    path: projectLevel ? null : diagnostic.primary.path,
    line: span === null ? null : span.start.line,
    column: span === null ? null : span.start.column,
    fileId: projectLevel ? null : diagnostic.primary.fileId,
  });
}

function problemOfDispatchDiagnostic(
  diagnostic: DispatchPlanDiagnostic,
  result: ProjectCompileResult,
): Kojo2ProjectProblem {
  // plan 诊断是「目标级」的（多文件），落点取候选 Theater 的第一个文件；行号不冒充单行。
  const theater = result.build.projectIR.theaters.find((candidate) =>
    diagnostic.candidateTheaterIds.includes(candidate.theaterId),
  );
  return projectProblem({
    channel: 'dispatch',
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    path: theater === undefined ? null : pathOfFileId(result, theater.fileId),
    fileId: theater === undefined ? null : theater.fileId,
    canonicalId: diagnostic.canonicalId,
    functionName: diagnostic.functionName,
    candidateTheaterIds: diagnostic.candidateTheaterIds,
  });
}

function problemOfBackendDiagnostic(
  diagnostic: KojoDiagnostic,
  result: ProjectCompileResult,
): Kojo2ProjectProblem {
  // dispatch 渲染失败与 theaterErb 渲染失败同属「渲染后端」一族；KojoDiagnostic 只有 span，
  // 反查得到文件才给 path/line/column，否则落项目级（不猜）。
  const located = locateSpan(result, diagnostic.span);
  return projectProblem({
    channel: 'dispatch-backend',
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    path: located === null ? null : located.path,
    line: located === null ? null : located.line,
    column: located === null ? null : located.column,
    fileId: located === null ? null : located.fileId,
  });
}

function problemOfAssemblyDiagnostic(
  diagnostic: ProjectAssemblyDiagnostic,
  result: ProjectCompileResult | null,
): Kojo2ProjectProblem {
  return projectProblem({
    channel: 'assembly',
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    path: pathOfFileId(result, diagnostic.fileId),
    fileId: diagnostic.fileId,
    canonicalId: diagnostic.canonicalId,
    functionName: diagnostic.functionName,
  });
}

function problemOfRuntimeProblem(problem: {
  readonly code: string;
  readonly message: string;
  readonly canonicalId: string;
  readonly candidateTheaterIds: readonly string[];
}): Kojo2ProjectProblem {
  return projectProblem({
    channel: 'runtime',
    code: problem.code,
    severity: 'error',
    message: problem.message,
    canonicalId: problem.canonicalId,
    candidateTheaterIds: problem.candidateTheaterIds,
  });
}

/**
 * 汇总四类 core 诊断 + Service 自己的 legacy 问题。
 *
 * 组装诊断优先取 `assembly.diagnostics`（= plan 诊断 + 组装期诊断）；没有 assembly 时退回
 * plan 诊断。Service 追加的问题与 core 已有同 channel+code+fileId 条目时只留 core 那条
 * （避免 legacy-missing 双份噪声）。
 */
function collectProblems(
  result: ProjectCompileResult | null,
  plan: ProjectErbAssemblyPlan | null,
  assembly: ProjectErbAssembly | null,
  extras: readonly Kojo2ProjectProblem[],
): readonly Kojo2ProjectProblem[] {
  const problems: Kojo2ProjectProblem[] = [];
  if (result !== null) {
    for (const diagnostic of result.build.diagnostics) {
      problems.push(problemOfBuildDiagnostic(diagnostic));
    }
    for (const diagnostic of result.dispatchDiagnostics) {
      problems.push(problemOfDispatchDiagnostic(diagnostic, result));
    }
    for (const diagnostic of result.dispatchBackendDiagnostics) {
      problems.push(problemOfBackendDiagnostic(diagnostic, result));
    }
    for (const diagnostic of result.backendDiagnostics) {
      problems.push(problemOfBackendDiagnostic(diagnostic, result));
    }
  }
  const assemblyDiagnostics = assembly !== null ? assembly.diagnostics : (plan?.diagnostics ?? []);
  for (const diagnostic of assemblyDiagnostics) {
    problems.push(problemOfAssemblyDiagnostic(diagnostic, result));
  }
  // core 目前只有 error/warning；防御性过滤，契约 severity 只有这两级。
  const visible = problems.filter(
    (problem) =>
      problem.severity === 'error' || problem.severity === 'warning',
  );
  for (const extra of extras) {
    const duplicated = visible.some(
      (problem) =>
        problem.channel === extra.channel &&
        problem.code === extra.code &&
        problem.fileId === extra.fileId,
    );
    if (!duplicated) visible.push(extra);
  }
  return visible;
}

/* ============================== 缓存 / 组装的内部形状 ============================== */

interface CompiledSnapshotEntry {
  readonly cacheKey: string;
  readonly result: ProjectCompileResult;
  readonly plan: ProjectErbAssemblyPlan;
  readonly compileMs: number;
  assembly: ProjectErbAssembly | null;
  assemblyProblems: readonly Kojo2ProjectProblem[];
  assemblyMs: number;
}

interface AssembledSnapshot {
  readonly assembly: ProjectErbAssembly;
  readonly problems: readonly Kojo2ProjectProblem[];
  readonly ms: number;
}

function findDocument(
  documents: readonly Kojo2ProjectDocument[],
  path: string,
): Kojo2ProjectDocument | undefined {
  const wanted = pathKey(path);
  return documents.find((document) => pathKey(document.path) === wanted);
}

function legacyMissingProblem(
  expectation: ProjectLegacyFileExpectation,
  reason: string,
): Kojo2ProjectProblem {
  return projectProblem({
    channel: 'assembly',
    code: 'assembly/legacy-missing',
    severity: 'error',
    message: `legacy 文件 ${expectation.path} ${reason}：最终产物会缺这一份 ERB（M1 单文件路径未产出字节）。`,
    path: expectation.path,
    fileId: expectation.fileId,
  });
}

/* ============================== 服务 ============================== */

/**
 * 创建项目级 Application Service（契约默认实现）。
 *
 * `deps.compileExpression` 缺省恒等透传（只适合测试/诊断；生产由 Host 注入真管线）。
 */
export function createKojo2ProjectService(
  deps: Kojo2ProjectServiceDeps,
): Kojo2ProjectService {
  const now = deps.now ?? ((): number => Date.now());
  const listeners = new Set<() => void>();

  let generation = 0;
  let disposed = false;
  let phase: Kojo2ProjectServicePhase = 'idle';
  let projectId: string | null = null;
  let snapshot: Kojo2ProjectSnapshot | null = null;
  let result: ProjectCompileResult | null = null;
  let plan: ProjectErbAssemblyPlan | null = null;
  let assembly: ProjectErbAssembly | null = null;
  let assemblyProblems: readonly Kojo2ProjectProblem[] = [];
  let assemblyMs = 0;
  let baseProblems: readonly Kojo2ProjectProblem[] = [];
  let stats: Kojo2ProjectServiceStats = EMPTY_STATS;
  let lastGood: Kojo2ProjectLastGood | null = null;
  let errorMessage: string | null = null;
  let cache: CompiledSnapshotEntry | null = null;
  let currentState: Kojo2ProjectServiceState;

  /* -------- 状态构造 -------- */

  function firstProblemMessage(): string | null {
    const first = baseProblems[0];
    return first === undefined ? null : first.message;
  }

  function gateOf(): { publishable: boolean; publishBlockReason: string | null } {
    if (phase !== 'ready') {
      const reason =
        phase === 'idle'
          ? '没有可发布的项目'
          : phase === 'loading'
            ? '正在编译项目'
            : phase === 'stale'
              ? '源码已改动：请重新构建后再发布'
              : (firstProblemMessage() ?? errorMessage ?? '项目构建失败');
      return { publishable: false, publishBlockReason: reason };
    }
    if (result === null) {
      return { publishable: false, publishBlockReason: '没有可发布的编译结果' };
    }
    if (result.build.buildStatus !== 'succeeded') {
      return {
        publishable: false,
        publishBlockReason: firstProblemMessage() ?? '项目构建失败',
      };
    }
    if (assembly === null) {
      return { publishable: false, publishBlockReason: '项目尚未组装（先执行 assemble）' };
    }
    if (assembly.status !== 'complete') {
      const first = assembly.diagnostics[0];
      return {
        publishable: false,
        publishBlockReason:
          first === undefined ? '组装不完整（存在未补齐的产物）' : first.message,
      };
    }
    if (deps.exportArtifact === undefined) {
      return {
        publishable: false,
        publishBlockReason: '未配置导出通道（exportFile）：不能写盘',
      };
    }
    return { publishable: true, publishBlockReason: null };
  }

  function buildState(): Kojo2ProjectServiceState {
    const gate = gateOf();
    return Object.freeze({
      phase,
      projectId,
      generation,
      result,
      plan,
      assembly,
      lastGood,
      problems: Object.freeze([...baseProblems]) as readonly Kojo2ProjectProblem[],
      stats: Object.freeze({ ...stats }),
      publishable: gate.publishable,
      publishBlockReason: gate.publishBlockReason,
      error: errorMessage,
    });
  }

  function publishCurrentState(): void {
    currentState = buildState();
    if (deps.onState !== undefined) {
      try {
        deps.onState(currentState);
      } catch {
        // 监听方（React setState / 面板）自己炸了不能打断服务；状态已落盘，下一次事件会再来。
      }
    }
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // 同上：单个订阅者异常隔离，不影响其它订阅者。
      }
    }
  }

  /* -------- 快照 → 编译输入 -------- */

  function backendOf(snapshotToUse: Kojo2ProjectSnapshot): KojoEmitBackend {
    const bundle = snapshotToUse.bundle;
    if (bundle.adapterId !== bundle.adapter.id) {
      throw new Error(
        `2.0 编译事实自证 id 不一致：bundle.adapterId=${bundle.adapterId}，adapter.id=${bundle.adapter.id}（登记面必须对账，不能把别家事实交给本项目）。`,
      );
    }
    return bundle.createBackend({
      compileExpression: deps.compileExpression ?? identityCompileExpression,
    });
  }

  function cacheKeyOf(
    snapshotToUse: Kojo2ProjectSnapshot,
    backend: KojoEmitBackend,
  ): string {
    const bundle = snapshotToUse.bundle;
    return stableHash(
      JSON.stringify({
        cacheVersion: 1,
        projectId: snapshotToUse.projectId,
        // provenance 身份（任一字段变化都必须让缓存失效，M2 契约 §1.3）。
        adapterId: bundle.adapter.id,
        adapterVersion: bundle.adapter.version,
        adapterFactsVersion: '1',
        gameFingerprint: bundle.gameFingerprint.digest,
        targetRegistryId: bundle.registry.registryId,
        targetRegistryVersion: bundle.registry.version,
        backendId: backend.id,
        backendVersion: backend.version ?? null,
        coreVersion: '0.0.0',
        sourceMapPolicy: bundle.sourceMapPolicy,
        capability: bundle.capability,
        // 编译模式。
        dispatchSelectors: bundle.dispatchSelectors,
        requireDispatch: true,
        emitDiagnosticArtifacts: true,
        // 文档身份：有序（项目输出与文件注入顺序无关，但缓存键按调用方给的顺序记）。
        documents: snapshotToUse.documents.map((document) => [
          pathKey(document.path),
          stableHash(document.text),
          document.layerId ?? null,
        ]),
      }),
    );
  }

  function compileOf(
    snapshotToUse: Kojo2ProjectSnapshot,
    backend: KojoEmitBackend,
  ): ProjectCompileResult {
    const bundle = snapshotToUse.bundle;
    const provenance = createKojo2ProjectProvenance({
      adapter: bundle.adapter,
      registry: bundle.registry,
      backend,
      capability: bundle.capability,
      sourceMapPolicy: bundle.sourceMapPolicy,
    });
    const files: ProjectCompileFileInput[] = snapshotToUse.documents.map((document) => {
      const layerId = document.layerId ?? null;
      let file: KojoFile | null;
      try {
        file = parseSource(document.text);
      } catch {
        // 解析失败不阻断其它文件：core 会把该文件判 parseStatus:'failed' 并给诊断。
        file = null;
      }
      return {
        identity: kojo2ProjectFileIdentity(document.path, document.text, layerId),
        file,
        sourceText: document.text,
        functionNameContext: resolveKojo2FunctionNameContext(snapshotToUse.contextOf, {
          path: document.path,
          layerId,
        }),
      };
    });
    const input: ProjectCompileInput = {
      projectId: snapshotToUse.projectId,
      provenance,
      files,
      registry: bundle.registry,
      adapter: bundle.adapter,
      backend,
      requireDispatch: true,
      emitDiagnosticArtifacts: true,
      ...(bundle.dispatchSelectors === null ? {} : { dispatchSelectors: bundle.dispatchSelectors }),
    };
    return (deps.compile ?? compileProject)(input);
  }

  /* -------- 组装（legacy 字节由 Host 端口补） -------- */

  function ensureAssemblyOf(
    snapshotToUse: Kojo2ProjectSnapshot,
    resultToUse: ProjectCompileResult,
    planToUse: ProjectErbAssemblyPlan,
  ): AssembledSnapshot {
    const startedAt = now();
    const legacyErb: ProjectLegacyErbInput[] = [];
    const extras: Kojo2ProjectProblem[] = [];
    for (const expectation of planToUse.legacyFiles) {
      const document = findDocument(snapshotToUse.documents, expectation.path);
      if (document === undefined) {
        extras.push(legacyMissingProblem(expectation, '在快照 documents 中找不到正文'));
        continue;
      }
      let erb: string | null;
      try {
        erb = snapshotToUse.compileLegacy(document);
      } catch (error) {
        extras.push(
          legacyMissingProblem(expectation, `的 M1 单文件路径抛错（${describeError(error)}）`),
        );
        continue;
      }
      if (erb === null) {
        extras.push(
          legacyMissingProblem(expectation, '的 M1 单文件路径编译失败（compileLegacy 返回 null）'),
        );
        continue;
      }
      legacyErb.push({ fileId: expectation.fileId, erb });
    }
    const assembled = assembleProjectErb({ result: resultToUse, legacyErb });
    return {
      assembly: assembled,
      problems: extras,
      ms: Math.max(0, now() - startedAt),
    };
  }

  /* -------- 失败收尾 -------- */

  function applyFailure(
    loaded: Kojo2ProjectSnapshot | null,
    message: string,
    previousProblems: readonly Kojo2ProjectProblem[],
  ): void {
    // 失败不静默：错误一定进 problems；上一次 lastGood 保留（只读展示，永不可发布）。
    result = null;
    plan = null;
    assembly = null;
    assemblyProblems = [];
    assemblyMs = 0;
    baseProblems = [...previousProblems, compileFailureProblem(message)];
    errorMessage = message;
    phase = 'failed';
    if (loaded !== null) {
      snapshot = loaded;
      projectId = loaded.projectId;
      stats = Object.freeze({
        documentCount: loaded.documents.length,
        theaterCount: 0,
        groupCount: 0,
        compileMs: 0,
        assemblyMs: 0,
        cacheHit: false,
      });
    } else {
      stats = Object.freeze({ ...stats, cacheHit: false, compileMs: 0, assemblyMs: 0 });
    }
    publishCurrentState();
  }

  /* -------- 公开操作 -------- */

  async function refresh(reason: Kojo2ProjectRefreshReason): Promise<Kojo2ProjectServiceState> {
    // reason 只描述触发来源（open/manual/scan/publish），服务行为一致：全量重取快照。
    void reason;
    if (disposed) return currentState;
    const myGeneration = ++generation;
    const previousProblems = baseProblems;
    phase = 'loading';
    errorMessage = null;
    baseProblems = [];
    stats = Object.freeze({ ...stats, cacheHit: false });
    publishCurrentState();

    let loaded: Kojo2ProjectSnapshot | null;
    try {
      loaded = await deps.load();
    } catch (error) {
      if (myGeneration !== generation) return currentState;
      applyFailure(null, `读取项目快照失败：${describeError(error)}`, previousProblems);
      return currentState;
    }
    if (myGeneration !== generation) return currentState;
    if (loaded === null) {
      // 没有项目 = 明确降级：清空当前结果，回 idle（不编造空项目）。
      snapshot = null;
      projectId = null;
      result = null;
      plan = null;
      assembly = null;
      assemblyProblems = [];
      assemblyMs = 0;
      baseProblems = [];
      stats = EMPTY_STATS;
      phase = 'idle';
      publishCurrentState();
      return currentState;
    }

    let backend: KojoEmitBackend;
    try {
      backend = backendOf(loaded);
    } catch (error) {
      if (myGeneration !== generation) return currentState;
      applyFailure(loaded, `创建 2.0 发音后端失败：${describeError(error)}`, []);
      return currentState;
    }

    const key = cacheKeyOf(loaded, backend);
    if (cache !== null && cache.cacheKey === key) {
      // 同快照：直接复用上一次编译/组装结果（cacheHit=true，不重编译）。
      snapshot = loaded;
      projectId = loaded.projectId;
      result = cache.result;
      plan = cache.plan;
      assembly = cache.assembly;
      assemblyProblems = cache.assemblyProblems;
      assemblyMs = cache.assemblyMs;
      baseProblems = collectProblems(cache.result, cache.plan, cache.assembly, cache.assemblyProblems);
      stats = Object.freeze({
        documentCount: loaded.documents.length,
        theaterCount: cache.result.build.projectIR.theaters.length,
        groupCount: cache.result.build.linkedProject?.groups.length ?? 0,
        compileMs: 0,
        assemblyMs: cache.assemblyMs,
        cacheHit: true,
      });
      if (assembly !== null && assembly.status === 'complete') {
        lastGood = {
          projectId: loaded.projectId,
          plan: cache.plan,
          assembly,
          at: now(),
        };
      }
      phase = cache.result.build.buildStatus === 'succeeded' ? 'ready' : 'failed';
      publishCurrentState();
      return currentState;
    }

    const compileStartedAt = now();
    let compiled: ProjectCompileResult;
    try {
      compiled = compileOf(loaded, backend);
    } catch (error) {
      applyFailure(loaded, `项目编译失败：${describeError(error)}`, []);
      return currentState;
    }
    const compileMs = Math.max(0, now() - compileStartedAt);

    snapshot = loaded;
    projectId = loaded.projectId;
    result = compiled;
    plan = planProjectErbAssembly(compiled);
    // 新一次编译的结果必须清掉上一份组装缓存：失败构建没有可发布产物，
    // 旧 `complete` assembly 残留会让失败首帧的 state.assembly 仍显示上次成功
    // （发布门禁虽先看 phase，但诊断视图会漏 `assembly/build-failed`）。
    assembly = null;
    assemblyProblems = [];
    assemblyMs = 0;
    const buildSucceeded = compiled.build.buildStatus === 'succeeded';
    phase = buildSucceeded ? 'ready' : 'failed';
    errorMessage = buildSucceeded ? null : '项目构建失败（当前结果仅供诊断，不可发布）';

    const entry: CompiledSnapshotEntry = {
      cacheKey: key,
      result: compiled,
      plan,
      compileMs,
      assembly: null,
      assemblyProblems: [],
      assemblyMs: 0,
    };
    if (buildSucceeded) {
      // 只有构建成功才组装：失败构建没有可发布产物，plan 诊断已经够诊断视图用。
      const assembled = ensureAssemblyOf(loaded, compiled, plan);
      entry.assembly = assembled.assembly;
      entry.assemblyProblems = assembled.problems;
      entry.assemblyMs = assembled.ms;
      assembly = assembled.assembly;
      assemblyProblems = assembled.problems;
      assemblyMs = assembled.ms;
      if (assembled.assembly.status === 'complete') {
        lastGood = {
          projectId: loaded.projectId,
          plan,
          assembly: assembled.assembly,
          at: now(),
        };
      }
    }
    cache = entry;
    baseProblems = collectProblems(compiled, plan, assembly, assemblyProblems);
    stats = Object.freeze({
      documentCount: loaded.documents.length,
      theaterCount: compiled.build.projectIR.theaters.length,
      groupCount: compiled.build.linkedProject?.groups.length ?? 0,
      compileMs,
      assemblyMs,
      cacheHit: false,
    });
    publishCurrentState();
    return currentState;
  }

  function assemble(): ProjectErbAssembly | null {
    if (disposed) return assembly;
    if (assembly !== null) return assembly;
    if (snapshot === null || result === null || plan === null) return null;
    if (result.build.buildStatus !== 'succeeded') {
      // 构建失败没有可组装产物：plan 诊断（assembly/build-failed）已经可见，不重跑 legacy。
      return null;
    }
    const assembled = ensureAssemblyOf(snapshot, result, plan);
    assembly = assembled.assembly;
    assemblyProblems = assembled.problems;
    assemblyMs = assembled.ms;
    if (cache !== null && cache.result === result) {
      cache.assembly = assembly;
      cache.assemblyProblems = assemblyProblems;
      cache.assemblyMs = assemblyMs;
    }
    if (assembly.status === 'complete' && snapshot !== null) {
      lastGood = { projectId: snapshot.projectId, plan, assembly, at: now() };
    }
    baseProblems = collectProblems(result, plan, assembly, assemblyProblems);
    stats = Object.freeze({ ...stats, assemblyMs });
    publishCurrentState();
    return assembly;
  }

  function publishBundle(): {
    readonly fileName: string;
    readonly text: string;
    readonly unitCount: number;
  } | null {
    if (assembly === null) return null;
    const units = assembly.units;
    const body = units.map((unit) => unit.erb).join('\n\n');
    return Object.freeze({
      fileName: deps.artifactFileName ?? DEFAULT_ARTIFACT_FILE_NAME,
      text: body.length === 0 ? '' : `${body}\n`,
      unitCount: units.length,
    });
  }

  async function publish(): Promise<Kojo2ProjectPublishResult> {
    const blocked = (reason: string): Kojo2ProjectPublishResult =>
      Object.freeze({ ok: false, path: null, reason, unitCount: 0 });
    if (disposed) return blocked('服务已销毁');
    const gate = gateOf();
    if (!gate.publishable) return blocked(gate.publishBlockReason ?? '当前不可发布');
    const exportArtifact = deps.exportArtifact;
    if (exportArtifact === undefined) return blocked('未配置导出通道（exportFile）：不能写盘');
    const bundle = publishBundle();
    if (bundle === null) return blocked('没有可写出的组装产物');
    let path: string | null;
    try {
      path = await exportArtifact(bundle.fileName, new TextEncoder().encode(bundle.text));
    } catch (error) {
      return blocked(`写出产物失败：${describeError(error)}`);
    }
    if (path === null) return { ok: false, path: null, reason: '已取消导出', unitCount: 0 };
    return { ok: true, path, reason: null, unitCount: bundle.unitCount };
  }

  function previewRuntime(request: RuntimeSelectionRequest): Kojo2RuntimePreview | null {
    const linkedProject = result === null ? null : result.build.linkedProject;
    if (linkedProject === null) return null;
    const resolution = resolveKojo2RuntimeSelection({ ...request, linkedProject });
    return Object.freeze({
      selection: resolution.selection,
      problems: Object.freeze(
        resolution.problems.map(problemOfRuntimeProblem),
      ) as readonly Kojo2ProjectProblem[],
    });
  }

  function markStale(paths?: readonly string[]): void {
    // 契约预留：项目编译没有按文件增量（core 级重编），`paths` 只作将来缩小重扫范围的钩子。
    void paths;
    if (disposed) return;
    if (phase === 'idle' || phase === 'loading' || phase === 'stale') return;
    phase = 'stale';
    publishCurrentState();
  }

  function reset(): void {
    if (disposed) return;
    generation += 1; // 作废在途 refresh：旧 load / 旧 compile 的迟到结果一律丢弃。
    phase = 'idle';
    projectId = null;
    snapshot = null;
    result = null;
    plan = null;
    assembly = null;
    assemblyProblems = [];
    assemblyMs = 0;
    baseProblems = [];
    stats = EMPTY_STATS;
    lastGood = null;
    errorMessage = null;
    cache = null;
    publishCurrentState();
  }

  function subscribe(listener: () => void): () => void {
    if (disposed) return () => {};
    listeners.add(listener);
    return (): void => {
      listeners.delete(listener);
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    generation += 1; // 在途 refresh 恢复后按世代丢弃。
    listeners.clear();
    phase = 'idle';
    projectId = null;
    snapshot = null;
    result = null;
    plan = null;
    assembly = null;
    assemblyProblems = [];
    assemblyMs = 0;
    baseProblems = [];
    stats = EMPTY_STATS;
    lastGood = null;
    errorMessage = null;
    cache = null;
    // 已销毁：只更新内部快照，不再通知任何监听方（deps.onState 也不再打扰宿主）。
    currentState = buildState();
  }

  currentState = buildState();

  return {
    state: (): Kojo2ProjectServiceState => currentState,
    subscribe,
    refresh,
    markStale,
    previewRuntime,
    assemble,
    publish,
    publishBundle,
    reset,
    dispose,
  };
}
