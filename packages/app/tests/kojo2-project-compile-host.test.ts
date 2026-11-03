import { describe, expect, it, vi } from 'vitest';
import type { GameProject } from '@kojo/plugin-api';
import { ERATW_DISPATCH_SELECTORS, ERATW_GAME_ADAPTER, ERATW_TARGET_REGISTRY } from '@kojo/plugin-eratw-adapter';
import { createEratwEmitBackend } from '../../plugins/eratw-adapter/src/kojo2/backend';
import { ERATW_CAPABILITY, ERATW_SOURCE_MAP } from '../../plugins/eratw-adapter/src/kojo2/capabilities';
import type { ProjectBuildProvenance } from '@kojo/kojo-core';
import { compileKojo2Project } from '../src/ui/kojo2-project-compile';

const PROJECT: GameProject = {
  rootDir: 'D:/p',
  adapterId: 'eratw',
  kojoPaths: ['D:/p/kojo'],
  writablePaths: [],
  charaIndex: new Map([[12, { no: 12, name: '角色', kojoDir: 'D:/p/kojo/12' }]]),
};

const PROVENANCE: ProjectBuildProvenance = {
  adapterId: 'eratw',
  adapterVersion: '2.0.0',
  adapterFactsVersion: '1',
  gameFingerprint: 'fixture',
  targetRegistryId: ERATW_TARGET_REGISTRY.registryId,
  targetRegistryVersion: ERATW_TARGET_REGISTRY.version,
  backendId: 'eratw',
  backendVersion: '1',
  coreVersion: '0.0.0',
  sourceMapPolicy: ERATW_SOURCE_MAP,
  capability: ERATW_CAPABILITY,
};

function backend() {
  return createEratwEmitBackend({ compileExpression: (expr) => expr.text });
}

describe('Host compileKojo2Project', () => {
  it('复用 charNo 算法与显式 familySegment，生成项目 ERB', () => {
    const result = compileKojo2Project({
      projectId: 'p1',
      provenance: PROVENANCE,
      project: PROJECT,
      documents: [
        { path: 'D:/p/kojo/12/a.kojo2', text: '【剧场：初见】\n# 视角 灵梦\n> 甲\n' },
        { path: 'D:/p/kojo/12/b.kojo2', text: '【剧场：初见｜学校】\n# 视角 灵梦\n> 乙\n' },
      ],
      adapter: ERATW_GAME_ADAPTER,
      backend: backend(),
      registry: ERATW_TARGET_REGISTRY,
      familySegmentOf: () => '',
    });

    expect(result.build.buildStatus).toBe('succeeded');
    expect(result.theaterErb).toHaveLength(2);
    expect(result.theaterErb[0]?.erb).toContain('M_KOJO_ENCOUNTER_K12');
    expect(result.complete).toBe(true);
  });

  it('没有 familySegment 事实时保持缺失，不自动补空串', () => {
    const result = compileKojo2Project({
      projectId: 'p1',
      provenance: PROVENANCE,
      project: PROJECT,
      documents: [{ path: 'D:/p/kojo/12/a.kojo2', text: '【剧场：初见】\n# 视角 灵梦\n> 甲\n' }],
      adapter: ERATW_GAME_ADAPTER,
      backend: backend(),
      registry: ERATW_TARGET_REGISTRY,
    });

    expect(result.build.buildStatus).toBe('failed');
    expect(result.theaterErb).toEqual([]);
    expect(result.build.diagnostics.map((diagnostic) => diagnostic.kind)).toContain(
      'function-name-context-missing',
    );
  });

  it('contextOf 注入的 Host 上下文被 compileKojo2Project 消费（不靠 project 旧推法）', () => {
    const contextOf = vi.fn((file: { path: string; layerId: string | null }) => {
      if (file.path.endsWith('a.kojo2')) return { charNo: '12', familySegment: '_学' };
      return {};
    });
    const result = compileKojo2Project({
      projectId: 'p1',
      provenance: PROVENANCE,
      project: null,
      documents: [{ path: 'D:/p/kojo/12/a.kojo2', text: '【剧场：初见】\n# 视角 灵梦\n> 甲\n' }],
      adapter: ERATW_GAME_ADAPTER,
      backend: backend(),
      registry: ERATW_TARGET_REGISTRY,
      contextOf,
    });

    expect(result.build.buildStatus).toBe('succeeded');
    expect(result.theaterErb).toHaveLength(1);
    expect(result.theaterErb[0]?.erb).toContain('M_KOJO_学_ENCOUNTER_K12');
    expect(contextOf).toHaveBeenCalledWith({ path: 'D:/p/kojo/12/a.kojo2', layerId: null });
  });

  it('contextOf 的显式空串 familySegment 在编译期保留（缺席 ≠ 空串）', () => {
    const result = compileKojo2Project({
      projectId: 'p1',
      provenance: PROVENANCE,
      project: null,
      documents: [{ path: 'D:/p/kojo/12/a.kojo2', text: '【剧场：初见】\n# 视角 灵梦\n> 甲\n' }],
      adapter: ERATW_GAME_ADAPTER,
      backend: backend(),
      registry: ERATW_TARGET_REGISTRY,
      contextOf: () => ({ charNo: '12', familySegment: '' }),
    });

    expect(result.build.buildStatus).toBe('succeeded');
    expect(result.theaterErb[0]?.erb).toContain('M_KOJO_ENCOUNTER_K12');
    expect(result.complete).toBe(true);
  });
});
describe('Host compileKojo2Project · M3 dispatch', () => {
  const DOCS = [
    { path: 'D:/p/kojo/12/a.kojo2', text: '【剧场：初见｜神社】\n# 视角 灵梦\n> 甲\n' },
    { path: 'D:/p/kojo/12/b.kojo2', text: '【剧场：初见｜学校】\n# 视角 灵梦\n> 乙\n' },
    { path: 'D:/p/kojo/12/c.kojo2', text: '【剧场：初见｜学校｜夜】\n# 视角 灵梦\n> 丙\n' },
  ] as const;

  it('dispatchSelectors + requireDispatch 走 Host 统一注入并产出最终 dispatch ERB', () => {
    const result = compileKojo2Project({
      projectId: 'p-dispatch',
      provenance: PROVENANCE,
      project: null,
      documents: DOCS,
      adapter: ERATW_GAME_ADAPTER,
      backend: backend(),
      registry: ERATW_TARGET_REGISTRY,
      contextOf: () => ({ charNo: '12', familySegment: '' }),
      dispatchSelectors: ERATW_DISPATCH_SELECTORS,
      requireDispatch: true,
    });

    expect(result.build.buildStatus).toBe('succeeded');
    expect(result.dispatchComplete).toBe(true);
    expect(result.dispatchErb).toHaveLength(1);
    expect(result.dispatchErb[0]?.erb).toContain('== "神社"');
    expect(result.dispatchErb[0]?.erb).toContain('IF TIME:2 == 6');
    expect(result.dispatchErb[0]?.erb).toContain('CALL M_KOJO_ENCOUNTER_K12__D1');
  });

  it('requireDispatch=true 但缺 selector：fail-closed，不发布 theaterErb / dispatchErb', () => {
    const result = compileKojo2Project({
      projectId: 'p-dispatch-missing',
      provenance: PROVENANCE,
      project: null,
      documents: DOCS,
      adapter: ERATW_GAME_ADAPTER,
      backend: backend(),
      registry: ERATW_TARGET_REGISTRY,
      contextOf: () => ({ charNo: '12', familySegment: '' }),
      requireDispatch: true,
    });

    expect(result.build.buildStatus).toBe('failed');
    expect(result.dispatchComplete).toBe(false);
    expect(result.dispatchErb).toEqual([]);
    expect(result.theaterErb).toEqual([]);
    expect(result.dispatchBackendDiagnostics.length).toBeGreaterThan(0);
  });
});
