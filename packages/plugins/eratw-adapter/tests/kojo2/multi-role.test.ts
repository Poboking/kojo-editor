/**
 * P1-4 多角色语义 + P1-3 版本校验（eraTW adapter 真实链路）：
 * - 两个角色（charNo 12 / 13）同 `【剧场：初见｜神社】`：合法多定义，不是 exact duplicate；
 * - dispatch plan 按 engineFunctionName 拆成两个 target（各自 1 branch）；
 * - matcher 不点名函数名 → ambiguous；点名 → selected；
 * - dispatchErb 按函数名产出两份；
 * - compileProject 对 provenance 四轴（adapterId/Version、backendId/Version）的版本失配
 *   fail-closed，诊断 kind=version-mismatch。
 */
import { describe, expect, it } from 'vitest';
import {
  buildProjectDispatchPlan,
  compileProject,
  createProjectFileIdentity,
  dispatchTargetPlanOf,
  parseSource,
  selectRuntimeTheater,
  type LinkedProject,
  type ProjectBuildProvenance,
  type ProjectCompileFileInput,
  type ProjectCompileResult,
} from '@kojo/kojo-core';
import { pathKey, stableHash } from '@kojo/plugin-api';
import {
  createEratwEmitBackend,
  ERATW_CAPABILITY,
  ERATW_DISPATCH_SELECTORS,
  ERATW_GAME_ADAPTER,
  ERATW_SOURCE_MAP,
  ERATW_TARGET_REGISTRY,
} from '../../src/kojo2/index.js';

const PROVENANCE: ProjectBuildProvenance = {
  adapterId: 'eratw',
  adapterVersion: '2.0.0',
  adapterFactsVersion: '1',
  gameFingerprint: 'multi-role',
  targetRegistryId: ERATW_TARGET_REGISTRY.registryId,
  targetRegistryVersion: ERATW_TARGET_REGISTRY.version,
  backendId: 'eratw',
  backendVersion: '1',
  coreVersion: '0.0.0',
  sourceMapPolicy: ERATW_SOURCE_MAP,
  capability: ERATW_CAPABILITY,
};

function fileInput(path: string, source: string, charNo: string): ProjectCompileFileInput {
  return {
    identity: createProjectFileIdentity(path, pathKey(path), null, stableHash(source)),
    file: parseSource(source),
    sourceText: source,
    functionNameContext: { charNo, familySegment: '' },
  };
}

function theaterSource(header: string, line: string): string {
  return header + '\n# 视角 灵梦\n> ' + line + '\n';
}

function backend() {
  return createEratwEmitBackend({ compileExpression: (expr) => expr.text });
}

const CHAR_NO_12 = fileInput(
  'D:/proj/multi-role-a.kojo2',
  theaterSource('【剧场：初见｜神社】', '灵梦的初见'),
  '12',
);
const CHAR_NO_13 = fileInput(
  'D:/proj/multi-role-b.kojo2',
  theaterSource('【剧场：初见｜神社】', '魔理沙的初见'),
  '13',
);

function compile(
  files: readonly ProjectCompileFileInput[],
  provenance: ProjectBuildProvenance = PROVENANCE,
  options: { readonly dispatchSelectors?: typeof ERATW_DISPATCH_SELECTORS; readonly requireDispatch?: boolean } = {},
): ProjectCompileResult {
  return compileProject({
    projectId: 'multi-role',
    provenance,
    files,
    registry: ERATW_TARGET_REGISTRY,
    adapter: ERATW_GAME_ADAPTER,
    backend: backend(),
    ...(options.dispatchSelectors === undefined ? {} : { dispatchSelectors: options.dispatchSelectors }),
    ...(options.requireDispatch === undefined ? {} : { requireDispatch: options.requireDispatch }),
  });
}

function linked(result: ProjectCompileResult): LinkedProject {
  if (result.build.linkedProject === null) throw new Error('expected LinkedProject');
  return result.build.linkedProject;
}

function versionMismatchDiagnostics(result: ProjectCompileResult) {
  return result.build.diagnostics.filter((diagnostic) => diagnostic.kind === 'version-mismatch');
}

describe('P1-4 多角色 · 两个 charNo 同 target/location/time 不判重复', () => {
  it('buildStatus succeeded，groups 1 组 2 theater，无 duplicate-theater', () => {
    const result = compile([CHAR_NO_12, CHAR_NO_13]);

    expect(result.build.buildStatus).toBe('succeeded');
    expect(result.complete).toBe(true);
    expect(result.build.projectIR.theaters.map((theater) => theater.linkStatus)).toEqual([
      'grouped',
      'grouped',
    ]);

    const project = linked(result);
    expect(project.groups).toHaveLength(1);
    const group = project.groups[0];
    expect(group?.canonicalId).toBe('eratw.event.初见');
    expect(group?.duplicate).toBe(false);
    expect(group?.theaters).toHaveLength(2);
    expect(group?.theaters.map((theater) => theater.engineFunctionName.name).sort()).toEqual([
      'M_KOJO_ENCOUNTER_K12',
      'M_KOJO_ENCOUNTER_K13',
    ]);
    expect(
      result.build.diagnostics.some((diagnostic) => diagnostic.kind === 'duplicate-theater'),
    ).toBe(false);
    expect(result.theaterErb).toHaveLength(2);
  });

  it('dispatch plan 按 functionName 拆 2 个 target，各自 1 branch', () => {
    const plan = buildProjectDispatchPlan(linked(compile([CHAR_NO_12, CHAR_NO_13])));

    expect(plan.status).toBe('ready');
    expect(plan.diagnostics).toEqual([]);
    expect(plan.targets).toHaveLength(2);
    expect(plan.targets.map((target) => target.functionName)).toEqual([
      'M_KOJO_ENCOUNTER_K12',
      'M_KOJO_ENCOUNTER_K13',
    ]);
    for (const target of plan.targets) {
      expect(target.status).toBe('ready');
      expect(target.canonicalId).toBe('eratw.event.初见');
      expect(target.branches).toHaveLength(1);
      expect(target.branches[0]?.functionName).toBe(target.functionName);
    }

    // 未点名函数名时 dispatchTargetPlanOf 不猜；点名才取到唯一计划。
    expect(dispatchTargetPlanOf(plan, 'eratw.event.初见')).toBeNull();
    expect(
      dispatchTargetPlanOf(plan, 'eratw.event.初见', 'M_KOJO_ENCOUNTER_K12')?.branches,
    ).toHaveLength(1);
    expect(
      dispatchTargetPlanOf(plan, 'eratw.event.初见', 'M_KOJO_ENCOUNTER_K13')?.branches,
    ).toHaveLength(1);
  });

  it('matcher：不点名 → ambiguous；点名 K12 / K13 → selected 且 theaterId 正确', () => {
    const project = linked(compile([CHAR_NO_12, CHAR_NO_13]));
    const theater12 = project.theaters.find(
      (theater) => theater.engineFunctionName.name === 'M_KOJO_ENCOUNTER_K12',
    );
    const theater13 = project.theaters.find(
      (theater) => theater.engineFunctionName.name === 'M_KOJO_ENCOUNTER_K13',
    );
    if (theater12 === undefined || theater13 === undefined) throw new Error('fixture 缺候选');

    const base = {
      linkedProject: project,
      canonicalId: 'eratw.event.初见',
      location: '神社',
      time: null,
    } as const;

    const ambiguous = selectRuntimeTheater(base);
    expect(ambiguous.status).toBe('ambiguous');
    expect(ambiguous.selected).toBeNull();
    expect([...ambiguous.diagnostics[0]?.candidateTheaterIds ?? []].sort()).toEqual(
      [theater12.theaterId, theater13.theaterId].sort(),
    );

    const selected12 = selectRuntimeTheater({
      ...base,
      engineFunctionName: 'M_KOJO_ENCOUNTER_K12',
    });
    expect(selected12.status).toBe('selected');
    expect(selected12.selected?.theaterId).toBe(theater12.theaterId);
    expect(selected12.candidates.map((candidate) => candidate.engineFunctionName)).toEqual([
      'M_KOJO_ENCOUNTER_K12',
    ]);

    const selected13 = selectRuntimeTheater({
      ...base,
      engineFunctionName: 'M_KOJO_ENCOUNTER_K13',
    });
    expect(selected13.status).toBe('selected');
    expect(selected13.selected?.theaterId).toBe(theater13.theaterId);
  });

  it('dispatchErb 两条且 functionName 分别为 K12/K13（requireDispatch 全绿）', () => {
    const result = compile([CHAR_NO_12, CHAR_NO_13], PROVENANCE, {
      dispatchSelectors: ERATW_DISPATCH_SELECTORS,
      requireDispatch: true,
    });

    expect(result.build.buildStatus).toBe('succeeded');
    expect(result.dispatchComplete).toBe(true);
    expect(result.dispatchErb).toHaveLength(2);
    const byFunction = new Map(result.dispatchErb.map((entry) => [entry.functionName, entry.erb]));
    expect([...byFunction.keys()].sort()).toEqual([
      'M_KOJO_ENCOUNTER_K12',
      'M_KOJO_ENCOUNTER_K13',
    ]);
    expect(byFunction.get('M_KOJO_ENCOUNTER_K12')).toContain('@M_KOJO_ENCOUNTER_K12');
    expect(byFunction.get('M_KOJO_ENCOUNTER_K13')).toContain('@M_KOJO_ENCOUNTER_K13');
    expect(result.dispatchErb.every((entry) => entry.canonicalId === 'eratw.event.初见')).toBe(true);
  });
});

describe('P1-3 版本校验 · compileProject 集成 fail-closed', () => {
  it('正确 provenance → succeeded，无 version-mismatch', () => {
    const result = compile([CHAR_NO_12, CHAR_NO_13]);
    expect(result.build.buildStatus).toBe('succeeded');
    expect(versionMismatchDiagnostics(result)).toEqual([]);
  });

  it('provenance.adapterVersion 错配 → failed + version-mismatch 诊断', () => {
    const result = compile([CHAR_NO_12], { ...PROVENANCE, adapterVersion: '9.9.9' });

    expect(result.build.buildStatus).toBe('failed');
    expect(result.theaterErb).toEqual([]);
    expect(result.dispatchErb).toEqual([]);
    const diagnostics = versionMismatchDiagnostics(result);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('core/project/version-mismatch');
    expect(diagnostics[0]?.severity).toBe('error');
    expect(diagnostics[0]?.message).toContain('Adapter 版本不匹配');
  });

  it('provenance.backendVersion 错配 → failed + version-mismatch 诊断', () => {
    const result = compile([CHAR_NO_12], { ...PROVENANCE, backendVersion: '9' });

    expect(result.build.buildStatus).toBe('failed');
    const diagnostics = versionMismatchDiagnostics(result);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('Backend 版本不匹配');
  });

  it('provenance.backendVersion 缺失 → failed + version-mismatch 诊断', () => {
    const result = compile([CHAR_NO_12], { ...PROVENANCE, backendVersion: null });

    expect(result.build.buildStatus).toBe('failed');
    expect(result.theaterErb).toEqual([]);
    const diagnostics = versionMismatchDiagnostics(result);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('backendVersion');
  });
});
