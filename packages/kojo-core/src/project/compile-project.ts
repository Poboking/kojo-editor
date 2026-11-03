/**
 * M2 P5 / M3：项目级编译编排。
 *
 * 流程：已有 AST + 文本 → 每个显式 Theater 只降糖成 TheaterLoweringUnit（不重解析）
 * → Project IR → 版本校验 → TargetRegistry 解析 / 静态链接 → 用 Backend 为已解析
 * Theater 生成单 Theater ERB 单元 →（M3）dispatch plan + 最终 dispatch ERB。
 *
 * 边界：
 * - legacy `# 机` 的 M1 单文件路径不变，这里不重跑、不改字节；它也不进入 M3 dispatch
 *   （plan 给 warning 跳过，不拖累显式 Theater 的 dispatch 产物）；
 * - 同特异性且条件可能同时命中的分支在 plan 层阻断（`dispatch/ambiguous-branches`），
 *   渲染器永远拿不到「可以按 fileId 顺序静默决胜」的 target；
 * - ProjectBuildResult 不携带发布产物；`theaterErb` / `dispatchErb` 是项目编译视图。
 */
import type { GameAdapter } from '../adapter.js';
import type { KojoSpan } from '../ast.js';
import { compileKojoFile } from '../compile.js';
import type { KojoDiagnostic } from '../diagnostics.js';
import type { DispatchRenderRequest, DispatchSelectors, KojoEmitBackend } from '../lower/backend.js';
import type { RuntimeMatchPolicy } from '../runtime-policy.js';
import { isEmitFailure } from '../lower/backend.js';
import type { ProjectBuildProvenance, ProjectBuildResult, ProjectFileInput } from './ir.js';
import { buildProjectBuildResult, buildProjectIR } from './ir.js';
import { linkProject } from './linker.js';
import { buildProjectDispatchPlan } from './dispatch-plan.js';
import type { DispatchPlanDiagnostic, ProjectDispatchPlan } from './dispatch-plan.js';
import type { TargetRegistry } from './target-registry.js';
import { validateProjectProvenanceVersions } from './version-check.js';

export interface ProjectCompileFileInput extends ProjectFileInput {
  readonly sourceText: string;
}

export interface ProjectCompileInput {
  readonly projectId: string;
  readonly provenance: ProjectBuildProvenance;
  readonly files: readonly ProjectCompileFileInput[];
  readonly registry: TargetRegistry;
  readonly adapter: GameAdapter;
  readonly backend: KojoEmitBackend;
  /** M3：Host 注入的运行时 selector；缺省 = 没有事实（adapter 必须 fail-closed）。 */
  readonly dispatchSelectors?: DispatchSelectors;
  /** M3：显式覆盖 registry 的 runtimeMatchPolicy；缺省读 registry。 */
  readonly runtimeMatchPolicy?: RuntimeMatchPolicy | null;
  /** M3：要求最终 dispatch ERB 必须成功；缺省 false 保持 M2 后端兼容。 */
  readonly requireDispatch?: boolean;
  /**
   * 构建失败时是否仍产出**诊断用** dispatchERB 预览（缺省 false）。
   *
   * 用于编辑器在「同 canonical 下 K12 重复、K13 合法」时仍能展示 K13 的调度产物。
   * 这些产物**不可发布**（buildStatus 仍 failed，assembly 会判 incomplete）；
   * 默认关，保持「失败不发布半成品」的既有语义。
   */
  readonly emitDiagnosticArtifacts?: boolean;
}

export interface ProjectTheaterErb {
  readonly theaterId: string;
  readonly erb: string;
}

export interface ProjectDispatchErb {
  readonly canonicalId: string;
  /** P1-4：同一 canonical 可按角色/家族函数名拆成多份；产物必须自带函数身份。 */
  readonly functionName: string;
  readonly erb: string;
}

export interface ProjectCompileResult {
  readonly build: ProjectBuildResult;
  /** 已解析目标 + 有 lowering unit 的 Theater 的单 Theater ERB；canonical→fileId→span 稳定序。 */
  readonly theaterErb: readonly ProjectTheaterErb[];
  /** Backend 生成失败时保留的可见诊断；项目构建失败时 build.buildStatus 已反映。 */
  readonly backendDiagnostics: readonly KojoDiagnostic[];
  /** M3 最终 dispatch ERB（canonical target × functionName 一份；多角色会拆多份）。 */
  readonly dispatchErb: readonly ProjectDispatchErb[];
  /** Dispatch plan 级诊断：duplicate / 无 supported 分支 / 同特异性歧义（error）/ legacy 跳过（warning）。 */
  readonly dispatchDiagnostics: readonly DispatchPlanDiagnostic[];
  /**
   * M3 调度计划（纯数据，任何构建结果都可读；构建失败时用于编辑器诊断视图）。
   *
   * 它是最终产物组装的唯一依据：`status==='ready'` 的 target 才有 dispatchErb；
   * legacy 分支不在此列；同 functionName 的 duplicate 只阻断该函数。
   */
  readonly dispatchPlan: ProjectDispatchPlan;
  /** Dispatch 渲染器返回的引擎诊断（含不可渲染来源的显式诊断）。 */
  readonly dispatchBackendDiagnostics: readonly KojoDiagnostic[];
  /** 所有应产出的 Theater 都成功产出，且项目构建 succeeded。 */
  readonly complete: boolean;
  /** 所有「可分派」target 都成功渲染最终 dispatch ERB；legacy-only 项目无 target 时视为完整。 */
  readonly dispatchComplete: boolean;
}

function loweringInputOf(
  fileInput: ProjectCompileFileInput,
  adapter: GameAdapter,
  backend: KojoEmitBackend,
): ProjectFileInput {
  if (fileInput.file === null) return fileInput;
  // legacy `# 机` 也会在 AST 里合成一个 theater，但它的字节属于 M1 单文件路径。
  // 项目层只对显式剧场做 `theaterUnitsOnly` 降糖：这里绝不重跑 wrapMachine，
  // 否则项目路径会再走一遍 M1 的 free-text 函数名渲染（第二套实现）。
  if (fileInput.file.hasTheaterSyntax !== true) return fileInput;
  const theaters = fileInput.file.theaters ?? [];
  if (theaters.length === 0) return fileInput;

  const compiled = compileKojoFile(fileInput.file, {
    adapter,
    backend,
    sourceText: fileInput.sourceText,
    theaterUnitsOnly: true,
  });
  const diagnostics: readonly KojoDiagnostic[] = [
    ...fileInput.file.diagnostics,
    ...compiled.diagnostics,
  ];
  return {
    ...fileInput,
    diagnostics,
    lowering: {
      units: compiled.theaterUnits ?? [],
      status: compiled.theaterUnitsStatus ?? 'not-applicable',
      diagnostics: compiled.diagnostics,
    },
  };
}

function backendFailureDiagnostic(
  backendId: string,
  theaterId: string,
  span: KojoSpan | null,
  reason: string,
): KojoDiagnostic {
  return {
    code: 'unit/backend-incomplete',
    severity: 'error',
    message: `backend（${backendId}）拒绝生成 Theater ${theaterId} 的 ERB：${reason}`,
    span,
  };
}

type SuccessfulWrapResult = string | readonly string[] | null;

function linesOf(result: SuccessfulWrapResult): readonly string[] {
  if (result === null) return [];
  return typeof result === 'string' ? [result] : result;
}

/**
 * 项目级编译入口。
 *
 * 只对显式 Theater 文件跑 `theaterUnitsOnly` 降糖；legacy-machine 文件保留
 * `unitStatus:'not-applicable'`，继续由 M1 单文件路径负责其 ERB 字节。
 */
export function compileProject(input: ProjectCompileInput): ProjectCompileResult {
  const files = input.files.map((fileInput) => loweringInputOf(fileInput, input.adapter, input.backend));
  const baseIR = buildProjectIR({
    projectId: input.projectId,
    provenance: input.provenance,
    files,
  });
  // P1-3：Adapter / Backend 版本轴必须先于链接校验；失配时把诊断并入 Project IR，
  // 让 buildStatus 走 failed 并阻断产物发布（M2-P0 Contracts §1.3）。
  const versionDiagnostics = validateProjectProvenanceVersions(baseIR, {
    registry: input.registry,
    backend:
      input.backend.version === undefined
        ? { id: input.backend.id }
        : { id: input.backend.id, version: input.backend.version },
  });
  const projectIR =
    versionDiagnostics.length === 0
      ? baseIR
      : { ...baseIR, diagnostics: [...baseIR.diagnostics, ...versionDiagnostics] };
  const { projectIR: resolvedIR, linkedProject } = linkProject(projectIR, input.registry);
  const build = buildProjectBuildResult(resolvedIR, linkedProject);
  // M3 收尾：plan 在构建失败时也要可读（编辑器诊断视图 / 多角色重复隔离需要看到
  // K13 仍 ready 而只有 K12 被阻断）。它不构成可发布产物。
  const dispatchPlan = buildProjectDispatchPlan(
    linkedProject,
    input.runtimeMatchPolicy ?? linkedProject.runtimeMatchPolicy ?? null,
  );

  const diagnosticOnly = build.buildStatus !== 'succeeded';
  if (diagnosticOnly && input.emitDiagnosticArtifacts !== true) {
    return {
      build,
      theaterErb: [],
      backendDiagnostics: [],
      dispatchErb: [],
      dispatchDiagnostics: dispatchPlan.diagnostics,
      dispatchPlan,
      dispatchBackendDiagnostics: [],
      complete: false,
      dispatchComplete: false,
    };
  }

  const theaterById = new Map(resolvedIR.theaters.map((theater) => [theater.theaterId, theater]));
  const theaterErb: ProjectTheaterErb[] = [];
  const backendDiagnostics: KojoDiagnostic[] = [];
  let expected = 0;
  let backendRejected = false;
  // 诊断预览（buildStatus failed）只渲染 dispatch；theaterErb 属可发布/兼容视图，保持为空。
  for (const theater of diagnosticOnly ? [] : linkedProject.theaters) {
    const sourceTheater = theaterById.get(theater.theaterId);
    if (sourceTheater === undefined || sourceTheater.unit === null) continue;
    if (theater.engineFunctionName.kind !== 'resolved' || theater.engineFunctionName.name === null) continue;
    const descriptor = theater.resolution.descriptor;
    if (descriptor === null) continue;
    const wrap = input.backend.wrapMachine;
    if (wrap === undefined) {
      backendRejected = true;
      backendDiagnostics.push(
        backendFailureDiagnostic(
          input.backend.id,
          theater.theaterId,
          theater.sourceSpan,
          'backend 没有实现 wrapMachine。',
        ),
      );
      continue;
    }
    expected++;
    const result = wrap({
      machine: {
        kind: 'machine',
        event: descriptor.eventBinding,
        args: theater.sourceArgs.index === null ? [] : [theater.sourceArgs.index],
        span: theater.sourceSpan,
      },
      body: sourceTheater.unit.body,
      view: null,
      slots: sourceTheater.unit.slots,
      resolvedFunctionName: theater.engineFunctionName,
    });
    if (isEmitFailure(result)) {
      backendRejected = true;
      // Backend 的诊断是失败原因的唯一真源：保留它，不吞成一句泛化消息。
      backendDiagnostics.push(...result.diagnostics);
      if (!result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
        backendDiagnostics.push(
          backendFailureDiagnostic(
            input.backend.id,
            theater.theaterId,
            theater.sourceSpan,
            'backend 返回 EmitFailure 但没有给 error 级诊断。',
          ),
        );
      }
      continue;
    }
    const lines = linesOf(result);
    theaterErb.push({
      theaterId: theater.theaterId,
      erb: lines.length === 0 ? '' : `${lines.join('\n')}\n`,
    });
  }

  const dispatchErb: ProjectDispatchErb[] = [];
  const dispatchBackendDiagnostics: KojoDiagnostic[] = [];
  const renderDispatch = input.backend.renderDispatch;
  // P1-2：legacy-machine 已被 plan 排除（warning 见 dispatchDiagnostics），这里只渲染
  // ready target；某个 target 失败只记诊断 + 跳过它，不清空其它 target 的产物。
  const readyTargets = dispatchPlan.targets.filter((target) => target.status === 'ready');
  let dispatchFailed = false;
  if (readyTargets.length > 0 && renderDispatch === undefined) {
    dispatchFailed = true;
    dispatchBackendDiagnostics.push(
      backendFailureDiagnostic(
        input.backend.id,
        'dispatch',
        null,
        'backend 没有实现 renderDispatch：项目存在可分派的 target，但没有 dispatch 渲染端口。',
      ),
    );
  }
  if (renderDispatch !== undefined) {
    for (const target of readyTargets) {
      const branches: DispatchRenderRequest['branches'][number][] = [];
      let branchFailed = false;
      for (const branch of target.branches) {
        const sourceTheater = theaterById.get(branch.theaterId);
        if (sourceTheater === undefined || sourceTheater.unit === null) {
          branchFailed = true;
          // P1-2：不可渲染的来源必须有可见诊断，不能只置失败位。
          dispatchBackendDiagnostics.push(
            backendFailureDiagnostic(
              input.backend.id,
              `dispatch:${target.canonicalId}`,
              branch.sourceSpan,
              `Theater ${branch.theaterId} 没有 lowering unit（legacy-machine 的 ERB 由 M1 单文件路径负责）：拒绝渲染 dispatch 半成品。`,
            ),
          );
          continue;
        }
        branches.push({
          theaterId: branch.theaterId,
          locationKind: branch.locationKind,
          locationRaw: branch.locationRaw,
          timeKind: branch.timeKind,
          timeRaw: branch.timeRaw,
          specificity: branch.specificity,
          conditions: branch.conditions,
          body: sourceTheater.unit.body,
          slots: sourceTheater.unit.slots,
          span: branch.sourceSpan,
        });
      }
      const first = target.branches[0];
      const firstSource = first === undefined ? undefined : theaterById.get(first.theaterId);
      const descriptor = firstSource?.targetResolution?.descriptor ?? null;
      if (
        branchFailed ||
        first === undefined ||
        firstSource === undefined ||
        descriptor === null ||
        branches.length !== target.branches.length
      ) {
        dispatchFailed = true;
        if (!branchFailed) {
          dispatchBackendDiagnostics.push(
            backendFailureDiagnostic(
              input.backend.id,
              `dispatch:${target.canonicalId}`,
              first?.sourceSpan ?? null,
              'dispatch target 的来源/描述不可用（缺 Theater unit 或 TargetDescriptor）：跳过该 target。',
            ),
          );
        }
        continue;
      }
      const args: readonly string[] = firstSource.sourceArgs.index === null ? [] : [firstSource.sourceArgs.index];
      const rendered = renderDispatch({
        selectors: input.dispatchSelectors ?? null,
        canonicalId: target.canonicalId,
        functionName: target.functionName,
        event: descriptor.eventBinding,
        args,
        branches,
        span: first.sourceSpan,
      });
      if (isEmitFailure(rendered)) {
        dispatchFailed = true;
        dispatchBackendDiagnostics.push(...rendered.diagnostics);
        if (!rendered.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
          dispatchBackendDiagnostics.push(
            backendFailureDiagnostic(
              input.backend.id,
              `dispatch:${target.canonicalId}`,
              first.sourceSpan,
              'backend.renderDispatch 返回 EmitFailure 但没有给 error 级诊断。',
            ),
          );
        }
        continue;
      }
      const lines = linesOf(rendered);
      dispatchErb.push({
        canonicalId: target.canonicalId,
        functionName: target.functionName,
        erb: lines.length === 0 ? '' : `${lines.join('\n')}\n`,
      });
    }
  }
  const planHasError = dispatchPlan.diagnostics.some((entry) => entry.severity === 'error');
  const dispatchIncomplete =
    planHasError || dispatchFailed || dispatchErb.length !== readyTargets.length;
  const dispatchComplete = renderDispatch !== undefined && !dispatchIncomplete;
  const backendFailed =
    backendRejected || backendDiagnostics.some((diagnostic) => diagnostic.severity === 'error');
  // requireDispatch 只要求「可分派的部分」成功：legacy-only 项目没有 M3 dispatch 任务，
  // 不应因为 legacy 由 M1 接管而整体失败（P1-2）。诊断预览模式仍保持 buildStatus failed。
  const failed = diagnosticOnly || backendFailed || (input.requireDispatch === true && dispatchIncomplete);
  const finalBuild: ProjectBuildResult = failed ? { ...build, buildStatus: 'failed' } : build;
  const complete = finalBuild.buildStatus === 'succeeded' && theaterErb.length === expected;
  return {
    build: finalBuild,
    theaterErb: failed ? [] : theaterErb,
    backendDiagnostics,
    // 诊断预览只放 dispatch（不可发布）；其余失败仍遵守「不发布半成品」。
    dispatchErb: diagnosticOnly ? dispatchErb : failed ? [] : dispatchErb,
    dispatchDiagnostics: dispatchPlan.diagnostics,
    dispatchPlan,
    dispatchBackendDiagnostics,
    complete,
    dispatchComplete,
  };
}