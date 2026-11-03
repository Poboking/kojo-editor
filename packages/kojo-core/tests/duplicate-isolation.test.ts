/**
 * P1-4 收尾：多角色 exact duplicate 隔离（core 纯函数层）。
 *
 * 场景：同一 canonical target 下
 * - K12 有两个完全相同的定义（真 duplicate，应被阻断）；
 * - K13 只定义一次（合法，应能独立匹配、dispatch plan 应为 ready）。
 *
 * 关键判据：K12 的 duplicate 不得污染 K13 的匹配/计划状态。
 */
import { describe, expect, it } from 'vitest';
import { buildProjectDispatchPlan, selectRuntimeTheater } from '../src/index.js';
import type {
  Capability,
  KojoSpan,
  KojoTheaterLocation,
  KojoTheaterTime,
  LinkedProject,
  ResolvedTheater,
  SourceMapPolicy,
} from '../src/index.js';

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
const CANONICAL = 'eratw.event.初见';

function location(kind: 'unrestricted' | 'exact', raw: string): KojoTheaterLocation {
  return { kind, raw, span: null };
}

function time(kind: 'unrestricted' | 'named', raw: string): KojoTheaterTime {
  return { kind, raw, span: null };
}

interface TheaterOptions {
  readonly fileId: string;
  readonly functionName: string;
  readonly location: KojoTheaterLocation;
  readonly time: KojoTheaterTime;
  readonly duplicate?: boolean;
}

function theater(options: TheaterOptions): ResolvedTheater {
  const name = options.functionName;
  return {
    theaterId: 'theater:' + options.fileId + ':0',
    fileId: options.fileId,
    ordinal: 0,
    origin: 'theater',
    rawTarget: '初见',
    location: options.location,
    time: options.time,
    canonicalId: CANONICAL,
    resolution: {
      registrationStatus: 'registered',
      status: 'supported',
      rawTarget: '初见',
      canonicalId: CANONICAL,
      descriptor: null,
      functionName: { kind: 'resolved', name, requiredContext: [], reason: null },
      diagnostics: [],
    },
    sourceArgs: { index: null, indexOrigin: 'none', span: null },
    engineFunctionName: { kind: 'resolved', name, requiredContext: [], reason: null },
    callSignature: null,
    sourceSpan: SPAN,
    duplicate: options.duplicate ?? false,
  };
}

function linked(theaters: readonly ResolvedTheater[], duplicateFunctionNames: readonly string[]): LinkedProject {
  return {
    projectId: 'duplicate-isolation',
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
        canonicalId: CANONICAL,
        theaters,
        duplicate: duplicateFunctionNames.length > 0,
        duplicateFunctionNames,
      },
    ],
    theaters,
    diagnostics: [],
  };
}

const SHRINE = location('exact', '神社');

/** K12 两份完全相同（duplicate）+ K13 一份合法；地点相同、时间不限。 */
function mixedProject(): LinkedProject {
  const k12a = theater({ fileId: 'file:12-a', functionName: 'M_KOJO_ENCOUNTER_K12', location: SHRINE, time: time('unrestricted', ''), duplicate: true });
  const k12b = theater({ fileId: 'file:12-b', functionName: 'M_KOJO_ENCOUNTER_K12', location: SHRINE, time: time('unrestricted', ''), duplicate: true });
  const k13 = theater({ fileId: 'file:13', functionName: 'M_KOJO_ENCOUNTER_K13', location: SHRINE, time: time('unrestricted', '') });
  return linked([k12a, k12b, k13], ['M_KOJO_ENCOUNTER_K12']);
}

describe('多角色 duplicate 隔离 · matcher', () => {
  it('不点名函数名：K12 的 duplicate 被过滤，K13 仍可唯一匹配', () => {
    const result = selectRuntimeTheater({
      linkedProject: mixedProject(),
      canonicalId: CANONICAL,
      location: '神社',
      time: null,
    });
    expect(result.status).toBe('selected');
    expect(result.selected?.engineFunctionName.name).toBe('M_KOJO_ENCOUNTER_K13');
    expect(result.candidates.map((candidate) => candidate.engineFunctionName)).toEqual(['M_KOJO_ENCOUNTER_K13']);
  });

  it('点名 K12：只拒绝该函数（duplicate 诊断），不波及组内其它角色', () => {
    const result = selectRuntimeTheater({
      linkedProject: mixedProject(),
      canonicalId: CANONICAL,
      location: '神社',
      time: null,
      engineFunctionName: 'M_KOJO_ENCOUNTER_K12',
    });
    expect(result.status).toBe('not-linked');
    expect(result.diagnostics[0]?.code).toBe('runtime/duplicate-group');
    expect(result.diagnostics[0]?.message).toContain('M_KOJO_ENCOUNTER_K12');
  });

  it('点名 K13：独立 selected，K12 重复不产生 ambiguous', () => {
    const result = selectRuntimeTheater({
      linkedProject: mixedProject(),
      canonicalId: CANONICAL,
      location: '神社',
      time: null,
      engineFunctionName: 'M_KOJO_ENCOUNTER_K13',
    });
    expect(result.status).toBe('selected');
    expect(result.selected?.engineFunctionName.name).toBe('M_KOJO_ENCOUNTER_K13');
  });

  it('只有重复定义时：拒绝选择并给 duplicate 诊断（不退化成 no-match）', () => {
    const onlyDuplicate = linked(
      [
        theater({ fileId: 'file:12-a', functionName: 'M_KOJO_ENCOUNTER_K12', location: SHRINE, time: time('unrestricted', ''), duplicate: true }),
        theater({ fileId: 'file:12-b', functionName: 'M_KOJO_ENCOUNTER_K12', location: SHRINE, time: time('unrestricted', ''), duplicate: true }),
      ],
      ['M_KOJO_ENCOUNTER_K12'],
    );
    const result = selectRuntimeTheater({
      linkedProject: onlyDuplicate,
      canonicalId: CANONICAL,
      location: '神社',
      time: null,
    });
    expect(result.status).toBe('not-linked');
    expect(result.diagnostics[0]?.code).toBe('runtime/duplicate-group');
  });
});

describe('多角色 duplicate 隔离 · dispatch plan', () => {
  it('K12 target blocked、K13 target ready；plan 的诊断点名 K12', () => {
    const plan = buildProjectDispatchPlan(mixedProject());
    expect(plan.status).toBe('blocked');
    const k12 = plan.targets.find((target) => target.functionName === 'M_KOJO_ENCOUNTER_K12');
    const k13 = plan.targets.find((target) => target.functionName === 'M_KOJO_ENCOUNTER_K13');
    expect(k12?.status).toBe('blocked');
    expect(k12?.duplicate).toBe(true);
    expect(k13?.status).toBe('ready');
    expect(k13?.duplicate).toBe(false);
    expect(k13?.branches).toHaveLength(1);
    const duplicate = plan.diagnostics.find((entry) => entry.code === 'dispatch/duplicate-group');
    expect(duplicate?.severity).toBe('error');
    expect(duplicate?.functionName).toBe('M_KOJO_ENCOUNTER_K12');
    expect(plan.diagnostics.some((entry) => entry.code === 'dispatch/ambiguous-branches')).toBe(false);
  });

  it('K13 的 ready 不依赖组顺序（输入置换后逐条相同）', () => {
    const forward = buildProjectDispatchPlan(mixedProject());
    const project = mixedProject();
    const reversed: LinkedProject = {
      ...project,
      groups: [{ ...project.groups[0]!, theaters: [...project.groups[0]!.theaters].reverse() }],
      theaters: [...project.theaters].reverse(),
    };
    expect(buildProjectDispatchPlan(reversed).targets).toEqual(forward.targets);
  });
});
