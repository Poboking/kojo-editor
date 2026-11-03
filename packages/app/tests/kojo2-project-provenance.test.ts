import { describe, expect, it } from 'vitest';
import type { KojoEmitBackend } from '@kojo/kojo-core';
import {
  ERATW_GAME_ADAPTER,
  ERATW_TARGET_REGISTRY,
} from '@kojo/plugin-eratw-adapter';
import { createEratwEmitBackend } from '../../plugins/eratw-adapter/src/kojo2/backend';
import { ERATW_CAPABILITY, ERATW_SOURCE_MAP } from '../../plugins/eratw-adapter/src/kojo2/capabilities';
import { compileKojo2Project } from '../src/ui/kojo2-project-compile';
import {
  createKojo2ProjectProvenance,
  type Kojo2ProjectProvenanceInput,
} from '../src/ui/kojo2-project-provenance';

function backend(): KojoEmitBackend {
  return createEratwEmitBackend({ compileExpression: (expr) => expr.text });
}

function input(overrides: Partial<Kojo2ProjectProvenanceInput> = {}): Kojo2ProjectProvenanceInput {
  return {
    adapter: ERATW_GAME_ADAPTER,
    registry: ERATW_TARGET_REGISTRY,
    backend: backend(),
    capability: ERATW_CAPABILITY,
    sourceMapPolicy: ERATW_SOURCE_MAP,
    ...overrides,
  };
}

describe('createKojo2ProjectProvenance · 派生事实', () => {
  it('从 eraTW 真实对象派生四轴身份与指纹（不手抄）', () => {
    const provenance = createKojo2ProjectProvenance(input());

    expect(provenance.adapterId).toBe(ERATW_GAME_ADAPTER.id);
    expect(provenance.adapterVersion).toBe(ERATW_GAME_ADAPTER.version);
    expect(provenance.adapterFactsVersion).toBe('1');
    expect(provenance.gameFingerprint).toBe(ERATW_GAME_ADAPTER.gameFingerprint.digest);
    expect(provenance.targetRegistryId).toBe(ERATW_TARGET_REGISTRY.registryId);
    expect(provenance.targetRegistryVersion).toBe(ERATW_TARGET_REGISTRY.version);
    expect(provenance.backendId).toBe('eratw');
    expect(provenance.backendVersion).toBe('1');
    expect(provenance.coreVersion).toBe('0.0.0');
    expect(provenance.capability).toBe(ERATW_CAPABILITY);
    expect(provenance.sourceMapPolicy).toBe(ERATW_SOURCE_MAP);
    expect(Object.isFrozen(provenance)).toBe(true);
  });

  it('显式 adapterFactsVersion / coreVersion / backend.version 被原样采用', () => {
    const provenance = createKojo2ProjectProvenance(
      input({
        adapterFactsVersion: '7',
        coreVersion: '9.9.9',
        backend: { id: 'custom-backend', version: '42' },
      }),
    );

    expect(provenance.adapterFactsVersion).toBe('7');
    expect(provenance.coreVersion).toBe('9.9.9');
    expect(provenance.backendId).toBe('custom-backend');
    expect(provenance.backendVersion).toBe('42');
  });
});

describe('createKojo2ProjectProvenance · 与 compileKojo2Project 的端到端接缝', () => {
  it('helper 产出的 provenance 直接过项目编译的版本校验：初见状 [剧场] 构建 succeeded', () => {
    const result = compileKojo2Project({
      projectId: 'provenance-host',
      provenance: createKojo2ProjectProvenance(input()),
      project: null,
      documents: [
        { path: 'D:/p/kojo/12/a.kojo2', text: '【剧场：初见】\n# 视角 灵梦\n> 甲\n' },
      ],
      adapter: ERATW_GAME_ADAPTER,
      backend: backend(),
      registry: ERATW_TARGET_REGISTRY,
      contextOf: () => ({ charNo: '12', familySegment: '' }),
    });

    expect(result.build.buildStatus).toBe('succeeded');
    expect(result.build.diagnostics.filter((d) => d.kind === 'version-mismatch')).toEqual([]);
    expect(result.theaterErb).toHaveLength(1);
    expect(result.theaterErb[0]?.erb).toContain('M_KOJO_ENCOUNTER_K12');
    expect(result.complete).toBe(true);
  });

  it('手抄错版本会被 compileProject 挡住（helper 不替 core 判一致性）', () => {
    const provenance = {
      ...createKojo2ProjectProvenance(input()),
      adapterVersion: '9.9.9-wrong',
    };
    const result = compileKojo2Project({
      projectId: 'provenance-mismatch',
      provenance,
      project: null,
      documents: [
        { path: 'D:/p/kojo/12/a.kojo2', text: '【剧场：初见】\n# 视角 灵梦\n> 甲\n' },
      ],
      adapter: ERATW_GAME_ADAPTER,
      backend: backend(),
      registry: ERATW_TARGET_REGISTRY,
      contextOf: () => ({ charNo: '12', familySegment: '' }),
    });

    expect(result.build.buildStatus).toBe('failed');
    expect(result.build.diagnostics.map((diagnostic) => diagnostic.kind)).toContain('version-mismatch');
    expect(result.theaterErb).toEqual([]);
  });
});

describe('createKojo2ProjectProvenance · fail-fast', () => {
  it('backend 未声明 version → throw（不等到编译期变成难懂诊断）', () => {
    const { version: _version, ...withoutVersion } = backend();
    expect(() =>
      createKojo2ProjectProvenance(input({ backend: withoutVersion })),
    ).toThrow(/backend\.version/);
  });

  it('backend.version 为空串 → throw', () => {
    expect(() =>
      createKojo2ProjectProvenance(input({ backend: { id: 'eratw', version: '' } })),
    ).toThrow(/backend\.version/);
  });

  it('adapter.id / adapter.version 为空串 → throw', () => {
    expect(() =>
      createKojo2ProjectProvenance(input({ adapter: { ...ERATW_GAME_ADAPTER, id: '' } })),
    ).toThrow(/adapter\.id/);
    expect(() =>
      createKojo2ProjectProvenance(input({ adapter: { ...ERATW_GAME_ADAPTER, version: '' } })),
    ).toThrow(/adapter\.version/);
  });

  it('registry 身份为空串 → throw', () => {
    expect(() =>
      createKojo2ProjectProvenance(input({ registry: { ...ERATW_TARGET_REGISTRY, registryId: '' } })),
    ).toThrow(/registry\.registryId/);
    expect(() =>
      createKojo2ProjectProvenance(input({ registry: { ...ERATW_TARGET_REGISTRY, version: '' } })),
    ).toThrow(/registry\.version/);
  });

  it('gameFingerprint 缺 digest → throw（游戏指纹是独立身份轴）', () => {
    expect(() =>
      createKojo2ProjectProvenance(
        input({
          adapter: {
            ...ERATW_GAME_ADAPTER,
            gameFingerprint: { digest: '', entries: [] },
          },
        }),
      ),
    ).toThrow(/gameFingerprint/);
  });

  it('显式传入空 adapterFactsVersion / coreVersion → throw（只认缺席，不认空串）', () => {
    expect(() =>
      createKojo2ProjectProvenance(input({ adapterFactsVersion: '' })),
    ).toThrow(/adapterFactsVersion/);
    expect(() => createKojo2ProjectProvenance(input({ coreVersion: '' }))).toThrow(/coreVersion/);
  });
});
