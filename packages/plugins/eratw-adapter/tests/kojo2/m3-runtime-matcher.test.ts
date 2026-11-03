import { describe, expect, it } from 'vitest';
import {
  compileProject,
  createProjectFileIdentity,
  parseSource,
  buildProjectDispatchPlan,
  dispatchTargetPlanOf,
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
  ERATW_GAME_ADAPTER,
  ERATW_SOURCE_MAP,
  ERATW_TARGET_REGISTRY,
} from '../../src/kojo2/index.js';

const PROVENANCE: ProjectBuildProvenance = {
  adapterId: 'eratw',
  adapterVersion: '2.0.0',
  adapterFactsVersion: '1',
  gameFingerprint: 'm3-runtime-matcher',
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

function source(header: string, line: string): string {
  return header + '\n# 视角 灵梦\n> ' + line + '\n';
}

function compile(files: readonly ProjectCompileFileInput[]): ProjectCompileResult {
  return compileProject({
    projectId: 'm3-runtime-matcher',
    provenance: PROVENANCE,
    files,
    registry: ERATW_TARGET_REGISTRY,
    adapter: ERATW_GAME_ADAPTER,
    backend: createEratwEmitBackend({ compileExpression: (expr) => expr.text }),
  });
}

function linked(result: ProjectCompileResult): LinkedProject {
  if (result.build.linkedProject === null) throw new Error('expected LinkedProject');
  return result.build.linkedProject;
}

const SHRINE = fileInput('D:/proj/01-shrine.kojo2', source('【剧场：初见｜神社】', '神社'), '12');
const SCHOOL = fileInput('D:/proj/02-school.kojo2', source('【剧场：初见｜学校】', '学校'), '13');
const SCHOOL_NIGHT = fileInput(
  'D:/proj/03-school-night.kojo2',
  source('【剧场：初见｜学校｜夜晚】', '夜校'),
  '14',
);

describe('M3 Runtime Matcher · 与 M2 compileProject 的端到端接缝', () => {
  it('M2 ResolvedTheater 携带 parser location/time，M3 不需要重解析源文本', () => {
    const result = compile([SHRINE, SCHOOL]);
    expect(result.build.buildStatus).toBe('succeeded');
    const theater = result.build.linkedProject?.theaters[0];
    expect(theater?.location).toMatchObject({ kind: 'exact', raw: '神社' });
    expect(theater?.time).toMatchObject({ kind: 'unrestricted' });
  });

  it('运行时地点精确选择神社/学校', () => {
    const project = linked(compile([SHRINE, SCHOOL]));
    const shrine = selectRuntimeTheater({
      linkedProject: project,
      canonicalId: 'eratw.event.初见',
      location: '神社',
      time: null,
    });
    const school = selectRuntimeTheater({
      linkedProject: project,
      canonicalId: 'eratw.event.初见',
      location: '学校',
      time: null,
    });
    expect(shrine.status).toBe('selected');
    expect(school.status).toBe('selected');
    expect(shrine.selected?.engineFunctionName.name).toContain('K12');
    expect(school.selected?.engineFunctionName.name).toContain('K13');
  });

  it('named time 提高特异性：夜晚选夜校，null 时间选无时间限制的学校', () => {
    const project = linked(compile([SHRINE, SCHOOL, SCHOOL_NIGHT]));
    const night = selectRuntimeTheater({
      linkedProject: project,
      canonicalId: 'eratw.event.初见',
      location: '学校',
      time: '夜晚',
    });
    const anyTime = selectRuntimeTheater({
      linkedProject: project,
      canonicalId: 'eratw.event.初见',
      location: '学校',
      time: null,
    });
    expect(night.status).toBe('selected');
    expect(night.selected?.engineFunctionName.name).toContain('K14');
    expect(anyTime.status).toBe('selected');
    expect(anyTime.selected?.engineFunctionName.name).toContain('K13');
  });

  it('未匹配地点为 no-match，不拿文件顺序兜底', () => {
    const result = selectRuntimeTheater({
      linkedProject: linked(compile([SHRINE, SCHOOL])),
      canonicalId: 'eratw.event.初见',
      location: '家',
      time: null,
    });
    expect(result.status).toBe('no-match');
    expect(result.selected).toBeNull();
  });

  it('文件输入置换不改变运行时选择', () => {
    const forward = linked(compile([SHRINE, SCHOOL, SCHOOL_NIGHT]));
    const backward = linked(compile([SCHOOL_NIGHT, SCHOOL, SHRINE]));
    const pick = (project: LinkedProject): string | null =>
      selectRuntimeTheater({
        linkedProject: project,
        canonicalId: 'eratw.event.初见',
        location: '学校',
        time: '夜晚',
      }).selected?.engineFunctionName.name ?? null;
    expect(pick(backward)).toBe(pick(forward));
    expect(pick(forward)).toContain('K14');
  });
});
describe('M3 Dispatch Plan · compileProject 候选组', () => {
  it('计划只列 supported 分支，按 specificity 降序', () => {
    const project = linked(compile([SHRINE, SCHOOL, SCHOOL_NIGHT]));
    const plan = buildProjectDispatchPlan(project);
    expect(plan.status).toBe('ready');
    const target = dispatchTargetPlanOf(plan, 'eratw.event.初见');
    expect(target?.branches.map((branch) => branch.specificity)).toEqual([3, 2, 2]);
    expect(target?.branches[0]?.functionName).toContain('K14');
  });

  it('计划仍保留文件输入无关的稳定顺序', () => {
    const forward = buildProjectDispatchPlan(linked(compile([SHRINE, SCHOOL, SCHOOL_NIGHT])));
    const backward = buildProjectDispatchPlan(linked(compile([SCHOOL_NIGHT, SCHOOL, SHRINE])));
    expect(backward.targets).toEqual(forward.targets);
    expect(backward.diagnostics).toEqual(forward.diagnostics);
  });
});