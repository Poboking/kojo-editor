import { describe, expect, it } from 'vitest';
import type {
  Capability,
  KojoSpan,
  KojoTheaterLocation,
  KojoTheaterTime,
  LinkedProject,
  ResolvedTheater,
  RuntimeMatchPolicy,
  SourceMapPolicy,
} from '../src/index.js';
import { buildProjectDispatchPlan, dispatchTargetPlanOf, selectRuntimeTheater } from '../src/index.js';

const CAPABILITY: Capability = {
  executesCode: false,
  fileAccess: 'none',
  networkAccess: 'none',
  writablePaths: 'none',
  integrity: 'none',
};

const SOURCE_MAP: SourceMapPolicy = {
  granularity: 'line',
  mapsEventHeader: false,
  mapsTemplateExpansion: false,
  mapsPoolExpansion: false,
  mapsNativeLines: false,
  mapsRandomSlots: false,
};

const SPAN: KojoSpan = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };

function location(kind: 'unrestricted' | 'exact', raw: string): KojoTheaterLocation {
  return { kind, raw, span: null };
}

function time(kind: 'unrestricted' | 'named', raw: string): KojoTheaterTime {
  return { kind, raw, span: null };
}

interface TheaterOptions {
  readonly fileId: string;
  readonly ordinal?: number;
  readonly location: KojoTheaterLocation;
  readonly time: KojoTheaterTime;
  readonly duplicate?: boolean;
}

function theater(options: TheaterOptions): ResolvedTheater {
  const ordinal = options.ordinal ?? 0;
  return {
    theaterId: 'theater:' + options.fileId + ':' + String(ordinal),
    fileId: options.fileId,
    ordinal,
    origin: 'theater',
    rawTarget: '初见',
    location: options.location,
    time: options.time,
    canonicalId: 'target.初见',
    resolution: {
      registrationStatus: 'registered',
      status: 'supported',
      rawTarget: '初见',
      canonicalId: 'target.初见',
      descriptor: null,
      functionName: { kind: 'resolved', name: 'M_KOJO_ENCOUNTER_K12', requiredContext: [], reason: null },
      diagnostics: [],
    },
    sourceArgs: { index: null, indexOrigin: 'none', span: null },
    engineFunctionName: { kind: 'resolved', name: 'M_KOJO_ENCOUNTER_K12', requiredContext: [], reason: null },
    callSignature: null,
    sourceSpan: SPAN,
    duplicate: options.duplicate ?? false,
  };
}

function linked(theaters: readonly ResolvedTheater[], duplicate = false): LinkedProject {
  return {
    projectId: 'runtime-test',
    provenance: {
      adapterId: 'test',
      adapterVersion: '1',
      adapterFactsVersion: '1',
      gameFingerprint: 'test',
      targetRegistryId: 'test.registry',
      targetRegistryVersion: '1',
      backendId: 'test',
      backendVersion: '1',
      coreVersion: '0',
      sourceMapPolicy: SOURCE_MAP,
      capability: CAPABILITY,
    },
    groups: [
      {
        canonicalId: 'target.初见',
        theaters,
        duplicate,
        duplicateFunctionNames: duplicate ? ['M_KOJO_ENCOUNTER_K12'] : [],
      },
    ],
    theaters,
    diagnostics: [],
  };
}

describe('M3 Runtime Matcher · location/time 选择', () => {
  it('exact location 胜过 unrestricted location', () => {
    const exact = theater({ fileId: 'file:exact', location: location('exact', '神社'), time: time('unrestricted', '') });
    const wildcard = theater({ fileId: 'file:wildcard', location: location('unrestricted', ''), time: time('unrestricted', '') });
    const result = selectRuntimeTheater({
      linkedProject: linked([wildcard, exact]),
      canonicalId: 'target.初见',
      location: '神社',
      time: null,
    });
    expect(result.status).toBe('selected');
    expect(result.selected?.theaterId).toBe(exact.theaterId);
    expect(result.candidates.map((candidate) => candidate.specificity)).toEqual([2, 0]);
  });

  it('exact location 必须非 null 且逐字相等；不做 trim/大小写折叠', () => {
    const exact = theater({ fileId: 'file:exact', location: location('exact', '神社'), time: time('unrestricted', '') });
    const project = linked([exact]);
    expect(selectRuntimeTheater({ linkedProject: project, canonicalId: 'target.初见', location: null, time: null }).status).toBe('no-match');
    expect(selectRuntimeTheater({ linkedProject: project, canonicalId: 'target.初见', location: ' 神社 ', time: null }).status).toBe('no-match');
    expect(selectRuntimeTheater({ linkedProject: project, canonicalId: 'target.初见', location: '神社', time: null }).status).toBe('selected');
  });

  it('named time 只匹配逐字相同的时间；unrestricted time 接收 null', () => {
    const night = theater({ fileId: 'file:night', location: location('unrestricted', ''), time: time('named', '夜晚') });
    const project = linked([night]);
    expect(selectRuntimeTheater({ linkedProject: project, canonicalId: 'target.初见', location: '任意', time: '夜晚' }).status).toBe('selected');
    expect(selectRuntimeTheater({ linkedProject: project, canonicalId: 'target.初见', location: '任意', time: '白天' }).status).toBe('no-match');
    expect(selectRuntimeTheater({ linkedProject: project, canonicalId: 'target.初见', location: '任意', time: null }).status).toBe('no-match');
  });

  it('无候选时 no-match，且不按文件顺序选第一个', () => {
    const a = theater({ fileId: 'file:a', location: location('exact', '学校'), time: time('unrestricted', '') });
    const b = theater({ fileId: 'file:b', location: location('exact', '神社'), time: time('unrestricted', '') });
    const result = selectRuntimeTheater({ linkedProject: linked([a, b]), canonicalId: 'target.初见', location: '家', time: null });
    expect(result.status).toBe('no-match');
    expect(result.selected).toBeNull();
    expect(result.diagnostics[0]?.code).toBe('runtime/no-match');
  });

  it('同特异性多候选为 ambiguous，不按 fileId/ordinal 决胜', () => {
    const a = theater({ fileId: 'file:a', location: location('unrestricted', ''), time: time('unrestricted', '') });
    const b = theater({ fileId: 'file:b', location: location('unrestricted', ''), time: time('unrestricted', '') });
    const result = selectRuntimeTheater({ linkedProject: linked([b, a]), canonicalId: 'target.初见', location: '家', time: null });
    expect(result.status).toBe('ambiguous');
    expect(result.selected).toBeNull();
    expect(result.diagnostics[0]?.code).toBe('runtime/ambiguous');
    expect(result.diagnostics[0]?.candidateTheaterIds).toEqual([a.theaterId, b.theaterId]);
  });

  it('duplicate group / 未链接 target 都拒绝选择', () => {
    const duplicated = theater({
      fileId: 'file:dup',
      location: location('unrestricted', ''),
      time: time('unrestricted', ''),
      duplicate: true,
    });
    const duplicateResult = selectRuntimeTheater({
      linkedProject: linked([duplicated], true),
      canonicalId: 'target.初见',
      location: null,
      time: null,
    });
    expect(duplicateResult.status).toBe('not-linked');
    expect(duplicateResult.diagnostics[0]?.code).toBe('runtime/duplicate-group');

    const missing = selectRuntimeTheater({
      linkedProject: linked([duplicated]),
      canonicalId: 'target.不存在',
      location: null,
      time: null,
    });
    expect(missing.status).toBe('not-linked');
    expect(missing.diagnostics[0]?.code).toBe('runtime/not-linked');
  });

  it('特异性总分：unrestricted/unrestricted=0，named=1，exact=2，exact+named=3', () => {
    const cases = [
      { loc: location('unrestricted', ''), tm: time('unrestricted', ''), score: 0 },
      { loc: location('unrestricted', ''), tm: time('named', '夜晚'), score: 1 },
      { loc: location('exact', '神社'), tm: time('unrestricted', ''), score: 2 },
      { loc: location('exact', '神社'), tm: time('named', '夜晚'), score: 3 },
    ] as const;
    for (const item of cases) {
      const candidate = theater({ fileId: 'file:' + String(item.score), location: item.loc, time: item.tm });
      const result = selectRuntimeTheater({
        linkedProject: linked([candidate]),
        canonicalId: 'target.初见',
        location: '神社',
        time: '夜晚',
      });
      expect(result.candidates[0]?.specificity).toBe(item.score);
    }
  });
});
describe('M3 Dispatch Plan · 候选组 → 确定性分支计划', () => {
  it('branches 按 specificity 降序，fileName 从 resolution 原样带出', () => {
    const wildcard = theater({ fileId: 'file:wildcard', location: location('unrestricted', ''), time: time('unrestricted', '') });
    const named = theater({ fileId: 'file:named', location: location('unrestricted', ''), time: time('named', '夜晚') });
    const exact = theater({ fileId: 'file:exact', location: location('exact', '神社'), time: time('unrestricted', '') });
    const both = theater({ fileId: 'file:both', location: location('exact', '神社'), time: time('named', '夜晚') });
    const plan = buildProjectDispatchPlan(linked([wildcard, named, exact, both]));
    expect(plan.status).toBe('ready');
    expect(plan.diagnostics).toEqual([]);
    expect(plan.targets[0]?.branches.map((branch) => branch.specificity)).toEqual([3, 2, 1, 0]);
    expect(plan.targets[0]?.branches.every((branch) => branch.functionName === 'M_KOJO_ENCOUNTER_K12')).toBe(true);
  });

  it('duplicate 组阻断计划，并点名全部候选', () => {
    const a = theater({ fileId: 'file:a', location: location('unrestricted', ''), time: time('unrestricted', ''), duplicate: true });
    const b = theater({ fileId: 'file:b', location: location('unrestricted', ''), time: time('unrestricted', ''), duplicate: true });
    const plan = buildProjectDispatchPlan(linked([a, b], true));
    expect(plan.status).toBe('blocked');
    expect(plan.targets[0]?.status).toBe('blocked');
    expect(plan.targets[0]?.duplicate).toBe(true);
    expect(plan.diagnostics[0]?.code).toBe('dispatch/duplicate-group');
    expect(plan.diagnostics[0]?.candidateTheaterIds).toEqual([a.theaterId, b.theaterId]);
  });

  it('dispatchTargetPlanOf 取目标计划，未知 target 返回 null', () => {
    const one = theater({ fileId: 'file:one', location: location('exact', '神社'), time: time('unrestricted', '') });
    const plan = buildProjectDispatchPlan(linked([one]));
    expect(dispatchTargetPlanOf(plan, 'target.初见')?.branches).toHaveLength(1);
    expect(dispatchTargetPlanOf(plan, 'target.不存在')).toBeNull();
  });
});
describe('M3 Dispatch Plan · P1-1 歧义与 matcher 一致 / P1-2 legacy 边界', () => {
  const ALIAS_POLICY: RuntimeMatchPolicy = {
    id: 'test.alias',
    locationAliases: { 博麗神社: ['神社'] },
  };

  it('别名展开后同特异性分支条件重叠：plan 阻断，matcher 同样 ambiguous（不会静默按 fileId 决胜）', () => {
    const shrine = theater({ fileId: 'file:01', location: location('exact', '神社'), time: time('unrestricted', '') });
    const hakurei = theater({ fileId: 'file:02', location: location('exact', '博麗神社'), time: time('unrestricted', '') });
    const project = linked([shrine, hakurei]);
    // 运行时选择：两条分支都命中 → 同特异性 → ambiguous
    const selection = selectRuntimeTheater({
      linkedProject: project,
      canonicalId: 'target.初见',
      location: '神社',
      time: null,
      runtimeMatchPolicy: ALIAS_POLICY,
    });
    expect(selection.status).toBe('ambiguous');
    // 计划：不得让渲染器拿到可以按顺序决胜的 target
    const plan = buildProjectDispatchPlan(project, ALIAS_POLICY);
    expect(plan.status).toBe('blocked');
    expect(plan.targets[0]?.status).toBe('blocked');
    const ambiguous = plan.diagnostics.find((entry) => entry.code === 'dispatch/ambiguous-branches');
    expect(ambiguous?.severity).toBe('error');
    expect(ambiguous?.candidateTheaterIds).toEqual([shrine.theaterId, hakurei.theaterId]);
  });

  it('同特异性但 location 不相交：plan 保持 ready（不误报）', () => {
    const shrine = theater({ fileId: 'file:01', location: location('exact', '神社'), time: time('unrestricted', '') });
    const school = theater({ fileId: 'file:02', location: location('exact', '学校'), time: time('unrestricted', '') });
    const plan = buildProjectDispatchPlan(linked([shrine, school]), ALIAS_POLICY);
    expect(plan.status).toBe('ready');
    expect(plan.targets[0]?.status).toBe('ready');
    expect(plan.diagnostics).toEqual([]);
  });

  it('不同特异性重叠不阻断：matcher 唯一最高，dispatch 的降序渲染与之一致', () => {
    const exact = theater({ fileId: 'file:exact', location: location('exact', '神社'), time: time('unrestricted', '') });
    const wildcard = theater({ fileId: 'file:wildcard', location: location('unrestricted', ''), time: time('unrestricted', '') });
    const project = linked([wildcard, exact]);
    expect(
      selectRuntimeTheater({ linkedProject: project, canonicalId: 'target.初见', location: '神社', time: null }).status,
    ).toBe('selected');
    const plan = buildProjectDispatchPlan(project);
    expect(plan.status).toBe('ready');
    expect(plan.targets[0]?.status).toBe('ready');
  });

  it('时间条件重叠（白天 vs 全天）同样阻断', () => {
    const day = theater({ fileId: 'file:day', location: location('unrestricted', ''), time: time('named', '白天') });
    const allDay = theater({ fileId: 'file:all', location: location('unrestricted', ''), time: time('named', '全天') });
    const policy: RuntimeMatchPolicy = {
      id: 'test.time',
      timeRanges: { 白天: [{ min: 2, max: 4 }], 全天: [{ min: 1, max: 7 }] },
    };
    const plan = buildProjectDispatchPlan(linked([day, allDay]), policy);
    expect(plan.status).toBe('blocked');
    expect(plan.targets[0]?.status).toBe('blocked');
    expect(plan.diagnostics.some((entry) => entry.code === 'dispatch/ambiguous-branches')).toBe(true);
  });

  it('legacy-machine 分支不进 dispatch target，只给 warning；显式 Theater 产物不被拖空', () => {
    const explicit = theater({ fileId: 'file:explicit', location: location('exact', '神社'), time: time('unrestricted', '') });
    const legacy = { ...theater({ fileId: 'file:legacy', location: location('unrestricted', ''), time: time('unrestricted', '') }), origin: 'legacy-machine' as const };
    const plan = buildProjectDispatchPlan(linked([explicit, legacy]));
    expect(plan.status).toBe('ready');
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]?.branches.map((branch) => branch.origin)).toEqual(['theater']);
    const skipped = plan.diagnostics.find((entry) => entry.code === 'dispatch/legacy-machine-skipped');
    expect(skipped?.severity).toBe('warning');
    expect(skipped?.candidateTheaterIds).toEqual([legacy.theaterId]);
  });

  it('legacy-only 组：plan ready + 0 target + warning（不再产生失败，也不产生 no-supported 误报）', () => {
    const legacy = { ...theater({ fileId: 'file:legacy', location: location('unrestricted', ''), time: time('unrestricted', '') }), origin: 'legacy-machine' as const };
    const plan = buildProjectDispatchPlan(linked([legacy]));
    expect(plan.status).toBe('ready');
    expect(plan.targets).toEqual([]);
    expect(plan.diagnostics.map((entry) => entry.code)).toEqual(['dispatch/legacy-machine-skipped']);
  });

  it('歧义诊断与目标顺序无关（输入置换结果逐条相同）', () => {
    const a = theater({ fileId: 'file:01', location: location('exact', '神社'), time: time('unrestricted', '') });
    const b = theater({ fileId: 'file:02', location: location('exact', '博麗神社'), time: time('unrestricted', '') });
    const forward = buildProjectDispatchPlan(linked([a, b]), ALIAS_POLICY);
    const backward = buildProjectDispatchPlan(linked([b, a]), ALIAS_POLICY);
    expect(backward.status).toBe(forward.status);
    expect(backward.targets).toEqual(forward.targets);
    expect(backward.diagnostics).toEqual(forward.diagnostics);
  });
});