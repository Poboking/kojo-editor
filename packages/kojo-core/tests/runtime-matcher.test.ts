import { describe, expect, it } from 'vitest';
import type {
  Capability,
  KojoSpan,
  KojoTheaterLocation,
  KojoTheaterTime,
  LinkedProject,
  ResolvedTheater,
  SourceMapPolicy,
} from '../src/index.js';
import { selectRuntimeTheater } from '../src/index.js';

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
    groups: [{ canonicalId: 'target.初见', theaters, duplicate }],
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
    const duplicated = theater({ fileId: 'file:dup', location: location('unrestricted', ''), time: time('unrestricted', '') });
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