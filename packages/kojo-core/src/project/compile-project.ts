/**
 * M2 P5：项目级编译编排。
 *
 * 流程：已有 AST + 文本 → 每个显式 Theater 只降糖成 TheaterLoweringUnit（不重解析）
 * → Project IR → TargetRegistry 解析 / 静态链接 → 用 Backend 为已解析 Theater 生成
 * 单 Theater ERB 单元。
 *
 * 边界：
 * - 不生成最终 dispatch ERB（M3 才做运行时 location/time 匹配与选择）；
 * - legacy `# 机` 的 M1 单文件路径不变，这里不重跑、不改字节；
 * - ProjectBuildResult 不携带发布产物；`theaterErb` 只是项目编译的附加视图。
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
import type { DispatchPlanDiagnostic } from './dispatch-plan.js';
import type { TargetRegistry } from './target-registry.js';

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
}

export interface ProjectTheaterErb {
  readonly theaterId: string;
  readonly erb: string;
}

export interface ProjectDispatchErb {
  readonly canonicalId: string;
  readonly erb: string;
}

export interface ProjectCompileResult {
  readonly build: ProjectBuildResult;
  /** 已解析目标 + 有 lowering unit 的 Theater 的单 Theater ERB；源顺序。 */
  readonly theaterErb: readonly ProjectTheaterErb[];
  /** Backend 生成失败时保留的可见诊断；项目构建失败时 build.buildStatus 已反映。 */
  readonly backendDiagnostics: readonly KojoDiagnostic[];
  /** M3 最终 dispatch ERB（每个 canonical target 一份）；backend 不支持时为空。 */
  readonly dispatchErb: readonly ProjectDispatchErb[];
  /** Dispatch plan 级阻断诊断（duplicate / 无 supported 分支）。 */
  readonly dispatchDiagnostics: readonly DispatchPlanDiagnostic[];
  /** Dispatch 渲染器返回的引擎诊断。 */
  readonly dispatchBackendDiagnostics: readonly KojoDiagnostic[];
  /** 所有应产出的 Theater 都成功产出，且项目构建 succeeded。 */
  readonly complete: boolean;
  /** 所有 canonical target 都成功渲染最终 dispatch ERB。 */
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
  const projectIR = buildProjectIR({
    projectId: input.projectId,
    provenance: input.provenance,
    files,
  });
  const { projectIR: resolvedIR, linkedProject } = linkProject(projectIR, input.registry);
  const build = buildProjectBuildResult(resolvedIR, linkedProject);

  if (build.buildStatus !== 'succeeded') {
    return {
      build,
      theaterErb: [],
      backendDiagnostics: [],
      dispatchErb: [],
      dispatchDiagnostics: [],
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
  for (const theater of linkedProject.theaters) {
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

  const dispatchPlan = buildProjectDispatchPlan(
    linkedProject,
    input.runtimeMatchPolicy ?? linkedProject.runtimeMatchPolicy ?? null,
  );
  const dispatchErb: ProjectDispatchErb[] = [];
  const dispatchBackendDiagnostics: KojoDiagnostic[] = [];
  let dispatchFailed = false;
  if (dispatchPlan.status === 'ready' && input.backend.renderDispatch !== undefined) {
    const renderDispatch = input.backend.renderDispatch;
    for (const target of dispatchPlan.targets) {
      const branches: DispatchRenderRequest['branches'][number][] = [];
      for (const branch of target.branches) {
        const sourceTheater = theaterById.get(branch.theaterId);
        if (sourceTheater === undefined || sourceTheater.unit === null) {
          dispatchFailed = true;
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
      if (first === undefined || firstSource === undefined || descriptor === null || branches.length !== target.branches.length) {
        dispatchFailed = true;
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
        erb: lines.length === 0 ? '' : `${lines.join('\n')}\n`,
      });
    }
  }
  const dispatchComplete =
    dispatchPlan.status === 'ready' &&
    input.backend.renderDispatch !== undefined &&
    !dispatchFailed &&
    dispatchErb.length === dispatchPlan.targets.length;
  const backendFailed =
    backendRejected || backendDiagnostics.some((diagnostic) => diagnostic.severity === 'error');
  const failed = backendFailed || (input.requireDispatch === true && dispatchFailed);
  const finalBuild: ProjectBuildResult = failed ? { ...build, buildStatus: 'failed' } : build;
  const complete = finalBuild.buildStatus === 'succeeded' && theaterErb.length === expected;
  return {
    build: finalBuild,
    theaterErb: failed ? [] : theaterErb,
    backendDiagnostics,
    dispatchErb: dispatchFailed ? [] : dispatchErb,
    dispatchDiagnostics: dispatchPlan.diagnostics,
    dispatchBackendDiagnostics,
    complete,
    dispatchComplete,
  };
}