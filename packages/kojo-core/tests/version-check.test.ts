/**
 * P1-3 项目级版本校验地基单测：`validateProjectProvenanceVersions`。
 *
 * 口径（M2-P0 Contracts §1.3）：adapterId / adapterVersion / backendId / backendVersion
 * 四轴都必须存在且逐字匹配；缺失与不匹配都 fail-closed 产生 kind=version-mismatch 的
 * error 诊断，不静默回落。
 */
import { describe, expect, it } from 'vitest';
import {
  buildProjectIR,
  validateProjectProvenanceVersions,
  type ProjectBuildProvenance,
  type TargetRegistry,
} from '../src/index.js';

const REGISTRY: TargetRegistry = {
  registryId: 'synthetic.registry',
  version: '1',
  adapterId: 'synthetic',
  adapterVersion: '1',
  targets: [],
};

const BACKEND = { id: 'synthetic.backend', version: '1' } as const;

const PROVENANCE: ProjectBuildProvenance = {
  adapterId: 'synthetic',
  adapterVersion: '1',
  adapterFactsVersion: '1',
  gameFingerprint: 'synthetic',
  targetRegistryId: REGISTRY.registryId,
  targetRegistryVersion: REGISTRY.version,
  backendId: BACKEND.id,
  backendVersion: BACKEND.version,
  coreVersion: '0.0.0',
  sourceMapPolicy: {
    granularity: 'line',
    mapsEventHeader: false,
    mapsTemplateExpansion: false,
    mapsPoolExpansion: false,
    mapsNativeLines: false,
    mapsRandomSlots: false,
  },
  capability: {
    executesCode: false,
    fileAccess: 'none',
    networkAccess: 'none',
    writablePaths: 'none',
    integrity: 'none',
  },
};

function projectWith(overrides: Partial<ProjectBuildProvenance>) {
  return buildProjectIR({
    projectId: 'version-check',
    provenance: { ...PROVENANCE, ...overrides },
    files: [],
  });
}

function validate(
  overrides: Partial<ProjectBuildProvenance>,
  backend: { readonly id: string; readonly version?: string } = BACKEND,
) {
  return validateProjectProvenanceVersions(projectWith(overrides), { registry: REGISTRY, backend });
}

describe('P1-3 validateProjectProvenanceVersions · 四轴全匹配', () => {
  it('四轴逐字相等 → 空诊断', () => {
    expect(validate({})).toEqual([]);
  });
});

describe('P1-3 validateProjectProvenanceVersions · Adapter 轴', () => {
  it('adapterId 空串 = 缺失 → version-mismatch error', () => {
    const diagnostics = validate({ adapterId: '' });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.kind).toBe('version-mismatch');
    expect(diagnostics[0]?.code).toBe('core/project/version-mismatch');
    expect(diagnostics[0]?.severity).toBe('error');
    expect(diagnostics[0]?.primary.role).toBe('project');
    expect(diagnostics[0]?.message).toContain('adapterId');
  });

  it('adapterId null 同样按缺失处理', () => {
    const diagnostics = validate({ adapterId: null as unknown as string });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('adapterId');
  });

  it('adapterId 不匹配 → version-mismatch error', () => {
    const diagnostics = validate({ adapterId: 'other-adapter' });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('Adapter 身份不匹配');
    expect(diagnostics[0]?.message).toContain('other-adapter');
  });

  it('adapterVersion 空串 = 缺失 → version-mismatch error', () => {
    const diagnostics = validate({ adapterVersion: '' });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.kind).toBe('version-mismatch');
    expect(diagnostics[0]?.message).toContain('adapterVersion');
  });

  it('adapterVersion 不匹配 → version-mismatch error', () => {
    const diagnostics = validate({ adapterVersion: '0.9.0' });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('Adapter 版本不匹配');
    expect(diagnostics[0]?.message).toContain('0.9.0');
  });
});

describe('P1-3 validateProjectProvenanceVersions · Backend 轴', () => {
  it('backendId 空串 = 缺失 → version-mismatch error', () => {
    const diagnostics = validate({ backendId: '' });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('backendId');
  });

  it('backendId 不匹配 → version-mismatch error', () => {
    const diagnostics = validate({ backendId: 'other-backend' });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('Backend 身份不匹配');
    expect(diagnostics[0]?.message).toContain('other-backend');
  });

  it('backendVersion null = 缺失 → version-mismatch error', () => {
    const diagnostics = validate({ backendVersion: null });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('backendVersion');
  });

  it('backend 未声明 version → 无法校验即阻断', () => {
    const diagnostics = validate({}, { id: BACKEND.id });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.kind).toBe('version-mismatch');
    expect(diagnostics[0]?.message).toContain('没有声明 version');
  });

  it('backendVersion 不匹配 → version-mismatch error', () => {
    const diagnostics = validate({ backendVersion: '2' });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('Backend 版本不匹配');
  });

  it('多轴同时错误：逐轴全部报出，不取第一条', () => {
    const diagnostics = validate({
      adapterId: 'other-adapter',
      adapterVersion: '0',
      backendId: 'other-backend',
    });
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.every((diagnostic) => diagnostic.kind === 'version-mismatch')).toBe(true);
    expect(diagnostics.every((diagnostic) => diagnostic.severity === 'error')).toBe(true);
  });
});
