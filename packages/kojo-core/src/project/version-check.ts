/**
 * 项目级版本校验（P1-3）：把 M2 契约 §1.3 的「缺失或不匹配不得静默回落」落实成
 * 可复用的纯函数。
 *
 * 边界：
 * - 只消费 provenance 与 Adapter/TargetRegistry/Backend 的**声明事实**，不读盘、不猜版本；
 * - targetRegistryId / targetRegistryVersion 的比对仍由 linker 负责（那里已经有
 *   version-mismatch 诊断与传统口径）；本模块只补 Adapter 与 Backend 两轴；
 * - 输出 `ProjectDiagnostic`（kind = version-mismatch），由 compileProject 并入 Project IR，
 *   使 buildStatus 变 failed，不发布任何产物。
 *
 * 为什么单独一枚：版本核对是「构建入口」的事实校验，不属于链接算法，也不属于 adapter；
 * 放这里避免 linker 依赖 backend 形状。
 */
import type { ProjectDiagnostic, ProjectIR } from './ir.js';
import type { TargetRegistry } from './target-registry.js';

/** 版本校验所需的声明事实（backend 只需要最小形状，不 import 后端实现类型）。 */
export interface ProjectVersionCheckFacts {
  readonly registry: TargetRegistry;
  readonly backend: {
    readonly id: string;
    readonly version?: string;
  };
}

function versionDiagnostic(projectIR: ProjectIR, message: string): ProjectDiagnostic {
  return {
    kind: 'version-mismatch',
    code: 'core/project/version-mismatch',
    severity: 'error',
    message,
    primary: {
      fileId: '',
      path: projectIR.projectId,
      span: null,
      role: 'project',
    },
    related: [],
  };
}

function missing(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.length === 0;
}

/**
 * 校验 Adapter / Backend 版本轴；返回空数组 = 全部匹配。
 *
 * 口径（M2-P0 Contracts §1.3）：
 * - adapterId / adapterVersion 与 registry.adapterId / registry.adapterVersion 逐字相等；
 * - backendId 与 backend.id 逐字相等；
 * - backendVersion 必须非空，且与 backend.version 逐字相等（backend 未声明版本同样是
 *   「无法验证」⇒ 阻断，不静默放过）。
 */
export function validateProjectProvenanceVersions(
  projectIR: ProjectIR,
  facts: ProjectVersionCheckFacts,
): readonly ProjectDiagnostic[] {
  const provenance = projectIR.provenance;
  const diagnostics: ProjectDiagnostic[] = [];

  if (missing(provenance.adapterId)) {
    diagnostics.push(
      versionDiagnostic(projectIR, 'Project provenance 缺少 adapterId：拒绝在没有 Adapter 身份的情况下构建。'),
    );
  } else if (provenance.adapterId !== facts.registry.adapterId) {
    diagnostics.push(
      versionDiagnostic(
        projectIR,
        `Adapter 身份不匹配：provenance=${provenance.adapterId}，TargetRegistry=${facts.registry.adapterId}：拒绝静默回落。`,
      ),
    );
  }

  if (missing(provenance.adapterVersion)) {
    diagnostics.push(
      versionDiagnostic(projectIR, 'Project provenance 缺少 adapterVersion：拒绝在没有 Adapter 版本的情况下构建。'),
    );
  } else if (provenance.adapterVersion !== facts.registry.adapterVersion) {
    diagnostics.push(
      versionDiagnostic(
        projectIR,
        `Adapter 版本不匹配：provenance=${provenance.adapterVersion}，TargetRegistry=${facts.registry.adapterVersion}：拒绝静默回落。`,
      ),
    );
  }

  if (missing(provenance.backendId)) {
    diagnostics.push(
      versionDiagnostic(projectIR, 'Project provenance 缺少 backendId：拒绝在没有 Backend 身份的情况下构建。'),
    );
  } else if (provenance.backendId !== facts.backend.id) {
    diagnostics.push(
      versionDiagnostic(
        projectIR,
        `Backend 身份不匹配：provenance=${provenance.backendId}，实际 backend=${facts.backend.id}：拒绝静默回落。`,
      ),
    );
  }

  if (missing(provenance.backendVersion)) {
    diagnostics.push(
      versionDiagnostic(projectIR, 'Project provenance 缺少 backendVersion：无法校验后端版本，拒绝构建。'),
    );
  } else if (facts.backend.version === undefined || missing(facts.backend.version)) {
    diagnostics.push(
      versionDiagnostic(
        projectIR,
        `backend（${facts.backend.id}）没有声明 version：无法与 provenance.backendVersion=${provenance.backendVersion} 校验，拒绝静默回落。`,
      ),
    );
  } else if (provenance.backendVersion !== facts.backend.version) {
    diagnostics.push(
      versionDiagnostic(
        projectIR,
        `Backend 版本不匹配：provenance=${provenance.backendVersion}，实际 backend=${facts.backend.version}：拒绝静默回落。`,
      ),
    );
  }

  return diagnostics;
}
