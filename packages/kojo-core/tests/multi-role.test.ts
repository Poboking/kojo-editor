/**
 * P1-4 多角色语义（core 合成 fixture，不 import 任何 adapter 插件）：
 * - exact duplicate 键增加 engineFunctionName：不同函数名同 canonical/location/time 是合法多定义；
 * - 同函数名同五字段仍是 exact duplicate；
 * - matcher 不点名函数名 → ambiguous（不按顺序决胜），点名 → 唯一 selected；
 * - 输入顺序无关。
 *
 * 合成面：TargetRegistry 只声明一个 abstract target（函数名模板 `SYNTH_{n}`），
 * backend 只作为 provenance 的身份事实出现。
 */
import { describe, expect, it } from 'vitest';
import {
  buildProjectIR,
  createProjectFileIdentity,
  exactTheaterKeyOf,
  linkProject,
  parseSource,
  selectRuntimeTheater,
  type KojoTheater,
  type ProjectBuildProvenance,
  type ProjectFileInput,
  type TargetDescriptor,
  type TargetRegistry,
} from '../src/index.js';

const SYNTHETIC_TARGET: TargetDescriptor = {
  registrationStatus: 'registered',
  compileSupport: 'supported',
  canonicalId: 'synthetic.event.甲',
  surface: '甲',
  aliases: [],
  eventBinding: '开场',
  sourceArgs: [],
  unsupportedReason: null,
  functionName: { template: 'SYNTH_{n}', requiredSegments: [] },
  callSignature: {
    sourceArgs: [],
    wrapperFormals: [],
    companionFormals: [],
    returnProtocol: 'none',
    localPolicy: 'none',
  },
  runtimeProtocol: { protocolId: 'synthetic.protocol', version: '1', metadata: {} },
  parameterRules: [
    {
      token: 'n',
      segmentName: null,
      source: 'host-file',
      required: true,
      allowExplicitEmpty: false,
      adapterMayDeclareDefault: false,
      valueKind: 'char-no',
      valuePattern: '^\\d+$',
    },
  ],
  segmentDefaults: {},
};

const SYNTHETIC_REGISTRY: TargetRegistry = {
  registryId: 'synthetic.registry',
  version: '1',
  adapterId: 'synthetic',
  adapterVersion: '1',
  targets: [SYNTHETIC_TARGET],
};

/** 合成 backend 事实：core 测试只为 provenance 提供身份，不落到任何真实后端。 */
const SYNTHETIC_BACKEND = { id: 'synthetic.backend', version: '1' } as const;

const PROVENANCE: ProjectBuildProvenance = {
  adapterId: 'synthetic',
  adapterVersion: '1',
  adapterFactsVersion: '1',
  gameFingerprint: 'synthetic',
  targetRegistryId: SYNTHETIC_REGISTRY.registryId,
  targetRegistryVersion: SYNTHETIC_REGISTRY.version,
  backendId: SYNTHETIC_BACKEND.id,
  backendVersion: SYNTHETIC_BACKEND.version,
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

function fileInput(
  path: string,
  source: string,
  charNo: string,
): ProjectFileInput {
  return {
    identity: createProjectFileIdentity(path, path, null, 'hash:' + path),
    file: parseSource(source),
    functionNameContext: { charNo, familySegment: '' },
  };
}

const SHRINE_NIGHT_12 = fileInput(
  '/synthetic/a.kojo2',
  '【剧场：甲｜神社｜夜晚】\n> 灵梦的初见\n',
  '12',
);
const SHRINE_NIGHT_13 = fileInput(
  '/synthetic/b.kojo2',
  '【剧场：甲｜神社｜夜晚】\n> 魔理沙的初见\n',
  '13',
);

function link(files: readonly ProjectFileInput[]): ReturnType<typeof linkProject> {
  return linkProject(
    buildProjectIR({ projectId: 'synthetic-multi-role', provenance: PROVENANCE, files }),
    SYNTHETIC_REGISTRY,
  );
}

function theaterOf(linked: ReturnType<typeof linkProject>, functionName: string): KojoTheater {
  const theater = linked.projectIR.theaters.find(
    (candidate) => candidate.targetResolution?.functionName.name === functionName,
  );
  if (theater === undefined) throw new Error(`fixture 未找到函数名 ${functionName} 的 Theater`);
  return theater.theater;
}

describe('P1-4 ExactTheaterKey · engineFunctionName 进入唯一键', () => {
  it('不同函数名（不同角色）同 canonical/location/time：不是 duplicate，同组两候选', () => {
    const linked = link([SHRINE_NIGHT_12, SHRINE_NIGHT_13]);

    expect(linked.linkedProject.groups).toHaveLength(1);
    const group = linked.linkedProject.groups[0];
    expect(group?.canonicalId).toBe('synthetic.event.甲');
    expect(group?.duplicate).toBe(false);
    expect(group?.theaters).toHaveLength(2);
    expect(
      group?.theaters.map((theater) => theater.engineFunctionName.name).sort(),
    ).toEqual(['SYNTH_12', 'SYNTH_13']);

    expect(linked.projectIR.theaters.map((theater) => theater.linkStatus).sort()).toEqual([
      'grouped',
      'grouped',
    ]);
    expect(linked.linkedProject.diagnostics).toEqual([]);

    const key12 = exactTheaterKeyOf(
      linked.projectIR.theaters.find(
        (theater) => theater.targetResolution?.functionName.name === 'SYNTH_12',
      ) ?? linked.projectIR.theaters[0]!,
    );
    expect(key12?.engineFunctionName).toBe('SYNTH_12');
    expect(key12?.canonicalTargetId).toBe('synthetic.event.甲');
    expect(theaterOf(linked, 'SYNTH_13').target.raw).toBe('甲');
  });

  it('同函数名 + 同五字段：仍然是 exact duplicate，诊断保留原前缀并点名函数名', () => {
    const linked = link([SHRINE_NIGHT_12, fileInput('/synthetic/c.kojo2', '【剧场：甲｜神社｜夜晚】\n> 重复\n', '12')]);

    const group = linked.linkedProject.groups[0];
    expect(group?.duplicate).toBe(true);
    expect(group?.theaters).toHaveLength(2);
    expect(linked.projectIR.theaters.every((theater) => theater.linkStatus === 'duplicate')).toBe(true);

    const diagnostics = linked.linkedProject.diagnostics.filter(
      (diagnostic) => diagnostic.kind === 'duplicate-theater',
    );
    expect(diagnostics).toHaveLength(1);
    const diagnostic = diagnostics[0];
    expect(diagnostic?.code).toBe('core/target/duplicate-theater');
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.message.startsWith('exact duplicate：目标 synthetic.event.甲 在相同地点/时间键上出现 2 次。')).toBe(
      true,
    );
    expect(diagnostic?.message).toContain('engineFunctionName=SYNTH_12');
    expect(diagnostic?.related).toHaveLength(1);
  });
});

describe('P1-4 Runtime Matcher · 可选 engineFunctionName 收窄候选', () => {
  it('不点名函数名：同条件跨角色 → ambiguous；点名 → selected 且 theaterId 正确', () => {
    const linked = link([SHRINE_NIGHT_12, SHRINE_NIGHT_13]);
    const project = linked.linkedProject;
    const theater12 = project.theaters.find(
      (theater) => theater.engineFunctionName.name === 'SYNTH_12',
    );
    const theater13 = project.theaters.find(
      (theater) => theater.engineFunctionName.name === 'SYNTH_13',
    );
    if (theater12 === undefined || theater13 === undefined) throw new Error('fixture 缺候选');

    const base = {
      linkedProject: project,
      canonicalId: 'synthetic.event.甲',
      location: '神社',
      time: '夜晚',
    } as const;

    const ambiguous = selectRuntimeTheater(base);
    expect(ambiguous.status).toBe('ambiguous');
    expect(ambiguous.selected).toBeNull();
    expect(ambiguous.diagnostics[0]?.code).toBe('runtime/ambiguous');
    expect([...ambiguous.diagnostics[0]?.candidateTheaterIds ?? []].sort()).toEqual(
      [theater12.theaterId, theater13.theaterId].sort(),
    );
    expect(ambiguous.candidates.map((candidate) => candidate.engineFunctionName).sort()).toEqual([
      'SYNTH_12',
      'SYNTH_13',
    ]);

    const selected12 = selectRuntimeTheater({ ...base, engineFunctionName: 'SYNTH_12' });
    expect(selected12.status).toBe('selected');
    expect(selected12.selected?.theaterId).toBe(theater12.theaterId);
    expect(selected12.selected?.engineFunctionName.name).toBe('SYNTH_12');
    expect(selected12.candidates).toHaveLength(1);
    expect(selected12.candidates[0]?.engineFunctionName).toBe('SYNTH_12');

    const selected13 = selectRuntimeTheater({ ...base, engineFunctionName: 'SYNTH_13' });
    expect(selected13.status).toBe('selected');
    expect(selected13.selected?.theaterId).toBe(theater13.theaterId);

    const unknownFunction = selectRuntimeTheater({ ...base, engineFunctionName: 'SYNTH_99' });
    expect(unknownFunction.status).toBe('no-match');
    expect(unknownFunction.selected).toBeNull();
  });
});

describe('P1-4 顺序无关', () => {
  it('打乱输入文件顺序：分组、诊断与运行时选择一致', () => {
    const forward = link([SHRINE_NIGHT_12, SHRINE_NIGHT_13]);
    const backward = link([SHRINE_NIGHT_13, SHRINE_NIGHT_12]);

    const snapshot = (linked: ReturnType<typeof linkProject>) => ({
      groups: linked.linkedProject.groups.map((group) => ({
        canonicalId: group.canonicalId,
        duplicate: group.duplicate,
        theaterIds: group.theaters.map((theater) => theater.theaterId).sort(),
        functionNames: group.theaters.map((theater) => theater.engineFunctionName.name).sort(),
      })),
      diagnosticKinds: linked.linkedProject.diagnostics.map((diagnostic) => diagnostic.kind),
      selection: (['SYNTH_12', 'SYNTH_13'] as const).map((engineFunctionName) => {
        const selection = selectRuntimeTheater({
          linkedProject: linked.linkedProject,
          canonicalId: 'synthetic.event.甲',
          location: '神社',
          time: '夜晚',
          engineFunctionName,
        });
        return { status: selection.status, theaterId: selection.selected?.theaterId ?? null };
      }),
    });

    expect(snapshot(backward)).toEqual(snapshot(forward));
  });
});
