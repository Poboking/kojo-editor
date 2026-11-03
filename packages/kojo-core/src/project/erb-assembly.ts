/**
 * Kojo 2.0 M2/M3 收尾：**最终 ERB 产物组装**（纯函数、零 IO、零游戏名词）。
 *
 * 口径（Assembly Contract，文档：`docs/KOJO-2.0-ARTIFACT-ASSEMBLY.md`）：
 * - `CompileProjectResult.dispatchErb` 是**最终运行时调度产物**：每个
 *   canonical target × `functionName` 一份，多角色按函数名拆份，直接拼接不会重复定义
 *   运行时函数；
 * - `CompileProjectResult.theaterErb` 只是**单 Theater 编译 / 兼容 / 预览视图**，绝不进入
 *   最终组装：多个 Theater 可以产生同名 `@函数`，直接拼会重复定义；计划里只用
 *   `previewOnlyTheaterCount` 报数量，供 UI 预览与诊断，"不代表可发布"；
 * - legacy-machine（`# 机`）的 ERB 由 **M1 单文件路径**产出，必须由 Host 显式传入
 *   `legacyErb`；跳过 legacy ≠ 项目完整——缺一份就 `incomplete` + `legacy-missing`；
 * - 同一运行时函数名在最终 units 里只能出现一次：dispatch units 按 `functionName` 查重，
 *   重复即 `duplicate-runtime-function`（不发布"看似完整"的重复定义）；
 * - 构建失败 / dispatch plan 有 error / `dispatchErb` 与 plan 的 ready target 对不上 /
 *   legacy 缺文件，全部 ⇒ `incomplete` + 具体诊断。
 *
 * 本模块只做**组装事实**：不重跑编译、不解析、不读写盘、不碰 Monaco；判断依据是
 * `ProjectCompileResult` 与 Host 显式传入的 legacy 字节。
 */
import type { ProjectCompileResult } from './compile-project.js';
import type { ProjectFileId, TheaterId } from './identity.js';
import { compareText } from './ordering.js';

/* ============================== 契约类型 ============================== */

/** Host 用 M1 单文件路径产出的一份 legacy ERB；`fileId` 必须来自 Project IR。 */
export interface ProjectLegacyErbInput {
  readonly fileId: ProjectFileId;
  readonly erb: string;
}

export type ProjectAssemblyDiagnosticCode =
  | 'assembly/build-failed'
  | 'assembly/dispatch-incomplete'
  | 'assembly/legacy-missing'
  | 'assembly/legacy-unknown'
  | 'assembly/duplicate-runtime-function';

/**
 * 组装诊断：全部 error 级（组装层没有 warning——warning 已经由 dispatch plan 给出，
 * 例如 legacy 跳过；组装只回答"这份产物能不能发布"）。
 */
export interface ProjectAssemblyDiagnostic {
  readonly code: ProjectAssemblyDiagnosticCode;
  readonly severity: 'error';
  readonly message: string;
  readonly fileId: ProjectFileId | null;
  readonly canonicalId: string | null;
  readonly functionName: string | null;
}

/** 计划要求的 legacy-machine 文件：`path` 供 Host 定位，`theaterIds` 供诊断视图下钻。 */
export interface ProjectLegacyFileExpectation {
  readonly fileId: ProjectFileId;
  readonly path: string;
  readonly theaterIds: readonly TheaterId[];
}

/** 计划要求的一份 dispatch 产物：canonical target + 运行时函数名（= units 身份）。 */
export interface ProjectDispatchUnitExpectation {
  readonly canonicalId: string;
  readonly functionName: string;
}

/**
 * 组装计划（可单独跑，任何构建结果都可读）：
 * `status==='ready'` 只说明"发布所需的事实已经齐了"，不代表 ERB 字节已经是最终版；
 * `assembleProjectErb` 才拿字节并给出 `complete`.
 */
export interface ProjectErbAssemblyPlan {
  readonly status: 'ready' | 'incomplete';
  /** 来自 `dispatchPlan.targets` 中 `status==='ready'` 的 target（构建失败时也给，供诊断视图）。 */
  readonly dispatchUnits: readonly ProjectDispatchUnitExpectation[];
  /** legacy-machine 文件（按 fileId 聚合）；其 ERB 必须由 Host 用 M1 单文件路径显式传入。 */
  readonly legacyFiles: readonly ProjectLegacyFileExpectation[];
  /**
   * `theaterErb` 的份数：**只报数量，不进入组装**。多个单 Theater 产物可以含同名
   * `@函数`，把它们拼进最终产物 = 重复定义运行时函数。
   */
  readonly previewOnlyTheaterCount: number;
  readonly diagnostics: readonly ProjectAssemblyDiagnostic[];
}

export type ProjectErbUnitKind = 'dispatch' | 'legacy-m1';

/**
 * 最终产物的一份 unit：
 * - `kind:'dispatch'` 时 `canonicalId` / `functionName` 有值，`fileId` 为 null；
 * - `kind:'legacy-m1'` 时 `fileId` 有值，`canonicalId` / `functionName` 为 null（M1 字节的
 *   函数身份由 adapter/backend 决定，组装层不猜）。
 */
export interface ProjectErbUnit {
  readonly kind: ProjectErbUnitKind;
  readonly canonicalId: string | null;
  readonly functionName: string | null;
  readonly fileId: ProjectFileId | null;
  readonly erb: string;
}

export interface ProjectErbAssemblyInput {
  readonly result: ProjectCompileResult;
  /** Host 用 M1 单文件路径产出的 legacy ERB；缺省 = 没有传（legacy 项目即 incomplete）。 */
  readonly legacyErb?: readonly ProjectLegacyErbInput[];
}

export interface ProjectErbAssembly {
  /** 仅当 `diagnostics` 为空才是 `complete`；消费方发布前必须检查这一位。 */
  readonly status: 'complete' | 'incomplete';
  /** 组装出的字节（dispatch 在前、legacy 在后）；`incomplete` 时只是诊断材料，不是可发布产物。 */
  readonly units: readonly ProjectErbUnit[];
  readonly plan: ProjectErbAssemblyPlan;
  /** = plan 诊断 + 组装阶段诊断（同一 error 口径）。 */
  readonly diagnostics: readonly ProjectAssemblyDiagnostic[];
}

/* ============================== 内部工具 ============================== */

function diagnostic(
  code: ProjectAssemblyDiagnosticCode,
  message: string,
  refs: {
    readonly fileId?: ProjectFileId | null;
    readonly canonicalId?: string | null;
    readonly functionName?: string | null;
  } = {},
): ProjectAssemblyDiagnostic {
  return {
    code,
    severity: 'error',
    message,
    fileId: refs.fileId ?? null,
    canonicalId: refs.canonicalId ?? null,
    functionName: refs.functionName ?? null,
  };
}

/** units 身份键：canonical target + 运行时函数名（与 dispatch plan 的 dispatchKey 同口径）。 */
function dispatchUnitKey(canonicalId: string, functionName: string): string {
  return canonicalId + '\u0000' + functionName;
}

/* ============================== 计划 ============================== */

/**
 * 由编译结果生成组装计划（纯数据，不读字节）。
 *
 * dispatch units 取 `result.dispatchPlan.targets` 里 `status==='ready'` 的 target：
 * 被 plan 阻断的 target（duplicate / 同特异性歧义 / 无可分派 Theater）不在计划里，
 * 因此不会被当作"应发布"的产物；构建失败时仍产出该列表，供编辑器诊断视图使用
 * （例如 K12 重复被隔离、K13 仍 ready 的可读证据）。
 */
export function planProjectErbAssembly(result: ProjectCompileResult): ProjectErbAssemblyPlan {
  const diagnostics: ProjectAssemblyDiagnostic[] = [];
  const buildStatus = result.build.buildStatus;

  const dispatchUnits: ProjectDispatchUnitExpectation[] = result.dispatchPlan.targets
    .filter((target) => target.status === 'ready')
    .map((target) => ({
      canonicalId: target.canonicalId,
      functionName: target.functionName,
    }));

  // legacy 文件期望：Project IR 的 theater 事实按 fileId 聚合，path 从 files 取；
  // 排序用 fileId 码元序，保证与文件注入顺序无关（项目输出必须输入顺序无关）。
  const pathByFileId = new Map<ProjectFileId, string>();
  for (const file of result.build.projectIR.files) pathByFileId.set(file.fileId, file.path);
  const theaterIdsByFileId = new Map<ProjectFileId, TheaterId[]>();
  for (const theater of result.build.projectIR.theaters) {
    if (theater.origin !== 'legacy-machine') continue;
    const bucket = theaterIdsByFileId.get(theater.fileId);
    if (bucket === undefined) theaterIdsByFileId.set(theater.fileId, [theater.theaterId]);
    else bucket.push(theater.theaterId);
  }
  const legacyFiles: ProjectLegacyFileExpectation[] = [...theaterIdsByFileId.entries()]
    .map(([fileId, theaterIds]) => ({
      fileId,
      path: pathByFileId.get(fileId) ?? '',
      theaterIds,
    }))
    .sort((a, b) => compareText(a.fileId, b.fileId));

  if (buildStatus !== 'succeeded') {
    diagnostics.push(
      diagnostic(
        'assembly/build-failed',
        `项目构建状态为 ${buildStatus}（analysisStatus=${result.build.analysisStatus}）：构建成功是发布前提，拒绝组装最终 ERB。`,
      ),
    );
  }

  // plan 层的每一条 error 都转成一条可下钻的组装诊断：不把"哪个 target 被阻断"糊成一句。
  const planErrors = result.dispatchPlan.diagnostics.filter(
    (entry) => entry.severity === 'error',
  );
  for (const entry of planErrors) {
    const functionLabel = entry.functionName === null ? '组级' : `函数 ${entry.functionName}`;
    diagnostics.push(
      diagnostic(
        'assembly/dispatch-incomplete',
        `dispatch plan 阻断 canonical target ${entry.canonicalId}（${functionLabel}）：[${entry.code}] ${entry.message}`,
        { canonicalId: entry.canonicalId, functionName: entry.functionName },
      ),
    );
  }
  if (result.dispatchPlan.status !== 'ready' && planErrors.length === 0) {
    diagnostics.push(
      diagnostic(
        'assembly/dispatch-incomplete',
        'dispatch plan 状态为 blocked，但没有任何 error 级计划诊断：拒绝据此组装。',
      ),
    );
  }

  // 构建成功才做数量对账：构建失败时 dispatchErb 恒为空（compileProject 不发布半成品），
  // 再逐 target 报缺失只会把 build-failed 淹没成噪声。
  if (buildStatus === 'succeeded' && result.dispatchErb.length !== dispatchUnits.length) {
    diagnostics.push(
      diagnostic(
        'assembly/dispatch-incomplete',
        `dispatch 产物数量（${result.dispatchErb.length}）与计划 ready target 数（${dispatchUnits.length}）不一致：存在缺失或多余的 target，拒绝发布。`,
      ),
    );
  }

  return {
    status: diagnostics.length === 0 ? 'ready' : 'incomplete',
    dispatchUnits,
    legacyFiles,
    previewOnlyTheaterCount: result.theaterErb.length,
    diagnostics,
  };
}

/* ============================== 组装 ============================== */

/**
 * 组装最终 ERB units。
 *
 * 规则：
 * - dispatch units 直接取 `result.dispatchErb`（plan ready target 的已渲染字节）；
 * - legacy units 只取 Host 传入且匹配期望 fileId 的 ERB，按 M1 单文件路径原样透传（不重编译）；
 * - 未知 legacy fileId → `legacy-unknown`（不产出 unit）；期望的 legacy 文件没传 → `legacy-missing`；
 * - dispatch units 的 `functionName` 重复 → `duplicate-runtime-function`，只保留第一份
 *   （同一运行时函数只输出一次是硬约束）；
 * - plan 为 ready 时再做一次**函数名级**对账：`dispatchErb` 缺/多 target 都给
 *   `dispatch-incomplete`（plan 只做数量对账，这里补名字对账）；
 * - `status==='complete'` 仅当诊断为空。
 */
export function assembleProjectErb(input: ProjectErbAssemblyInput): ProjectErbAssembly {
  const plan = planProjectErbAssembly(input.result);
  const diagnostics: ProjectAssemblyDiagnostic[] = [...plan.diagnostics];
  const units: ProjectErbUnit[] = [];

  const expectedKeys = new Set(
    plan.dispatchUnits.map((unit) => dispatchUnitKey(unit.canonicalId, unit.functionName)),
  );
  const seenKeys = new Set<string>();
  const extraKeys: ProjectDispatchUnitExpectation[] = [];
  const emittedFunctionNames = new Set<string>();

  for (const entry of input.result.dispatchErb) {
    const key = dispatchUnitKey(entry.canonicalId, entry.functionName);
    // 先登记 key：重复项也算"该 target 有产物"，避免同时误报 dispatch-incomplete。
    seenKeys.add(key);
    if (!expectedKeys.has(key)) {
      extraKeys.push({ canonicalId: entry.canonicalId, functionName: entry.functionName });
    }
    if (emittedFunctionNames.has(entry.functionName)) {
      diagnostics.push(
        diagnostic(
          'assembly/duplicate-runtime-function',
          `运行时函数 ${entry.functionName} 在最终 dispatch 产物中出现多次（canonical ${entry.canonicalId}）：同一运行时函数只能输出一份，已丢弃重复项。`,
          { canonicalId: entry.canonicalId, functionName: entry.functionName },
        ),
      );
      continue;
    }
    emittedFunctionNames.add(entry.functionName);
    units.push({
      kind: 'dispatch',
      canonicalId: entry.canonicalId,
      functionName: entry.functionName,
      fileId: null,
      erb: entry.erb,
    });
  }

  // 名字级对账只在 plan 认为"齐了"时做：plan 已 incomplete 时缺失原因已经报过，
  // 再逐 target 重复报只会淹没真正的首因。
  if (plan.status === 'ready') {
    for (const expected of plan.dispatchUnits) {
      if (!seenKeys.has(dispatchUnitKey(expected.canonicalId, expected.functionName))) {
        diagnostics.push(
          diagnostic(
            'assembly/dispatch-incomplete',
            `dispatch 计划要求 canonical target ${expected.canonicalId}（函数 ${expected.functionName}），但最终产物缺少它。`,
            { canonicalId: expected.canonicalId, functionName: expected.functionName },
          ),
        );
      }
    }
    for (const extra of extraKeys) {
      diagnostics.push(
        diagnostic(
          'assembly/dispatch-incomplete',
          `最终 dispatch 产物含计划外的 canonical target ${extra.canonicalId}（函数 ${extra.functionName}）：plan 是组装的唯一依据，拒绝发布。`,
          { canonicalId: extra.canonicalId, functionName: extra.functionName },
        ),
      );
    }
  }

  // legacy：Host 显式传入（M1 单文件路径产出）。未知 / 缺失 / 同一文件重复传入都可见。
  const expectedFileIds = new Set(plan.legacyFiles.map((file) => file.fileId));
  const providedByFileId = new Map<ProjectFileId, ProjectLegacyErbInput>();
  for (const legacy of input.legacyErb ?? []) {
    if (!expectedFileIds.has(legacy.fileId)) {
      diagnostics.push(
        diagnostic(
          'assembly/legacy-unknown',
          `legacy ERB 的 fileId 在项目里没有对应的 legacy-machine theater：${legacy.fileId}`,
          { fileId: legacy.fileId },
        ),
      );
      continue;
    }
    if (providedByFileId.has(legacy.fileId)) {
      diagnostics.push(
        diagnostic(
          'assembly/duplicate-runtime-function',
          `legacy 文件 ${legacy.fileId} 传入了多份 ERB：同一文件的运行时函数只能输出一份，保留第一份。`,
          { fileId: legacy.fileId },
        ),
      );
      continue;
    }
    providedByFileId.set(legacy.fileId, legacy);
  }
  for (const expectation of plan.legacyFiles) {
    const provided = providedByFileId.get(expectation.fileId);
    if (provided === undefined) {
      diagnostics.push(
        diagnostic(
          'assembly/legacy-missing',
          `legacy-machine 文件 ${expectation.path}（${expectation.fileId}）的 ERB 必须由 M1 单文件路径产出并由 Host 传入：缺失即不完整。`,
          { fileId: expectation.fileId },
        ),
      );
      continue;
    }
    units.push({
      kind: 'legacy-m1',
      canonicalId: null,
      functionName: null,
      fileId: expectation.fileId,
      erb: provided.erb,
    });
  }

  return {
    status: diagnostics.length === 0 ? 'complete' : 'incomplete',
    units,
    plan,
    diagnostics,
  };
}
