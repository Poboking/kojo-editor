import { describe, expect, it } from 'vitest';
import {
  buildProjectIR,
  buildProjectBuildResult,
  createProjectFileIdentity,
  createSourceMapBuilder,
  linkProject,
  parseSource,
  type KojoTheater,
  type ProjectBuildProvenance,
  type ProjectFileInput,
  type ProjectTheaterLoweringInput,
} from '@kojo/kojo-core';
import { pathKey, stableHash } from '@kojo/plugin-api';
import { ERATW_CAPABILITY, ERATW_SOURCE_MAP } from '../../src/kojo2/capabilities.js';
import { ERATW_TARGET_REGISTRY } from '../../src/kojo2/target-registry.js';

const PROVENANCE: ProjectBuildProvenance = {
  adapterId: 'eratw',
  adapterVersion: '2.0.0',
  adapterFactsVersion: '1',
  gameFingerprint: 'fixture',
  targetRegistryId: ERATW_TARGET_REGISTRY.registryId,
  targetRegistryVersion: ERATW_TARGET_REGISTRY.version,
  backendId: 'fixture',
  backendVersion: '1',
  coreVersion: '0.0.0',
  sourceMapPolicy: ERATW_SOURCE_MAP,
  capability: ERATW_CAPABILITY,
};

function unitsOf(theaters: readonly KojoTheater[]): ProjectTheaterLoweringInput {
  const sourceMap = createSourceMapBuilder().build();
  return {
    status: 'complete',
    units: theaters.map((theater) => ({ theater, body: [], sourceMap, slots: [] })),
  };
}

function fileInput(
  path: string,
  source: string,
  context: { charNo?: string; familySegment?: string },
): ProjectFileInput {
  const file = parseSource(source);
  const theaters = file.theaters ?? [];
  return {
    identity: createProjectFileIdentity(path, pathKey(path), null, stableHash(source)),
    file,
    functionNameContext: context,
    ...(theaters.length === 0 ? {} : { lowering: unitsOf(theaters) }),
  };
}

function build(
  files: readonly ProjectFileInput[],
): { readonly projectIR: ReturnType<typeof buildProjectIR>; readonly linked: ReturnType<typeof linkProject> } {
  const projectIR = buildProjectIR({ projectId: 'p1', provenance: PROVENANCE, files });
  const linked = linkProject(projectIR, ERATW_TARGET_REGISTRY);
  return { projectIR, linked };
}

describe('M2 Project Linker', () => {
  it('支持的初见目标解析、分组并构建成功', () => {
    const { linked } = build([
      fileInput('/p/a.kojo2', '【剧场：初见】\n# 视角 灵梦\n> 你好\n', {
        charNo: '12',
        familySegment: '',
      }),
    ]);

    expect(linked.projectIR.theaters).toHaveLength(1);
    const theater = linked.projectIR.theaters[0];
    expect(theater?.targetResolution?.status).toBe('supported');
    expect(theater?.targetResolution?.functionName.name).toBe('M_KOJO_ENCOUNTER_K12');
    expect(theater?.linkStatus).toBe('grouped');
    expect(linked.linkedProject.groups).toHaveLength(1);
    expect(linked.linkedProject.groups[0]?.duplicate).toBe(false);
    expect(linked.linkedProject.theaters[0]?.engineFunctionName.name).toBe('M_KOJO_ENCOUNTER_K12');

    const result = buildProjectBuildResult(linked.projectIR, linked.linkedProject);
    expect(result.buildStatus).toBe('succeeded');
    expect(result.linkedProject).not.toBeNull();
  });

  it('exact duplicate 使用 target + location/time 五字段，跨文件报 duplicate-theater', () => {
    const { linked } = build([
      fileInput('/p/a.kojo2', '【剧场：初见】\n# 视角 灵梦\n> 甲\n', {
        charNo: '12',
        familySegment: '',
      }),
      fileInput('/p/b.kojo2', '【剧场：初见】\n# 视角 灵梦\n> 乙\n', {
        charNo: '12',
        familySegment: '',
      }),
    ]);

    expect(linked.linkedProject.theaters).toHaveLength(2);
    expect(linked.linkedProject.groups[0]?.duplicate).toBe(true);
    expect(linked.projectIR.theaters.every((theater) => theater.linkStatus === 'duplicate')).toBe(true);
    expect(linked.linkedProject.diagnostics.map((diagnostic) => diagnostic.kind)).toContain('duplicate-theater');
    const duplicate = linked.linkedProject.diagnostics.find((diagnostic) => diagnostic.kind === 'duplicate-theater');
    expect(duplicate?.related).toHaveLength(1);
    expect(buildProjectBuildResult(linked.projectIR, linked.linkedProject).buildStatus).toBe('failed');
  });

  it('同 target 不同 location 不报 exact duplicate', () => {
    const { linked } = build([
      fileInput('/p/a.kojo2', '【剧场：初见｜神社】\n# 视角 灵梦\n> 甲\n', {
        charNo: '12',
        familySegment: '',
      }),
      fileInput('/p/b.kojo2', '【剧场：初见｜学校】\n# 视角 灵梦\n> 乙\n', {
        charNo: '12',
        familySegment: '',
      }),
    ]);

    expect(linked.linkedProject.groups).toHaveLength(1);
    expect(linked.linkedProject.groups[0]?.theaters).toHaveLength(2);
    expect(linked.linkedProject.groups[0]?.duplicate).toBe(false);
    expect(linked.linkedProject.diagnostics).toEqual([]);
  });

  it('legacy-machine 与显式 Theater 同五字段键也参与 duplicate，origin 保留', () => {
    const { linked } = build([
      fileInput('/p/a.kojo2', '# 机 初见\n# 视角 灵梦\n> 甲\n', {
        charNo: '12',
        familySegment: '',
      }),
      fileInput('/p/b.kojo2', '【剧场：初见】\n# 视角 灵梦\n> 乙\n', {
        charNo: '12',
        familySegment: '',
      }),
    ]);

    expect(linked.linkedProject.theaters.map((theater) => theater.origin).sort()).toEqual([
      'legacy-machine',
      'theater',
    ]);
    expect(linked.linkedProject.groups[0]?.duplicate).toBe(true);
    expect(linked.projectIR.theaters.every((theater) => theater.linkStatus === 'duplicate')).toBe(true);
    expect(linked.linkedProject.diagnostics[0]?.kind).toBe('duplicate-theater');
  });

  it('unknown/unsupported 不进 groups，但保留在 theaters 与诊断里', () => {
    const { linked } = build([
      fileInput('/p/a.kojo2', '【剧场：不存在】\n# 视角 灵梦\n> 甲\n', {
        charNo: '12',
        familySegment: '',
      }),
      fileInput('/p/b.kojo2', '【剧场：训练】\n# 视角 灵梦\n> 乙\n', {
        charNo: '12',
        familySegment: '',
      }),
    ]);

    expect(linked.linkedProject.groups).toEqual([]);
    expect(linked.linkedProject.theaters).toHaveLength(2);
    expect(linked.linkedProject.theaters.map((theater) => theater.resolution.status).sort()).toEqual([
      'unknown',
      'unsupported',
    ]);
    expect(buildProjectBuildResult(linked.projectIR, linked.linkedProject).buildStatus).toBe('failed');
  });

  it('显式 Theater 指令缺 i 是 needs-context，不从 raw 猜 310', () => {
    const { linked } = build([
      fileInput('/p/a.kojo2', '【剧场：指令 310】\n# 视角 灵梦\n> 甲\n', {
        charNo: '12',
        familySegment: '',
      }),
    ]);

    const theater = linked.projectIR.theaters[0];
    expect(theater?.theater.target.raw).toBe('指令 310');
    expect(theater?.targetResolution?.status).toBe('unknown');
    expect(theater?.sourceArgs).toEqual({ index: null, indexOrigin: 'none', span: null });
  });

  it('legacy # 机 指令 310 从 parser args 取得 i', () => {
    const { linked } = build([
      fileInput('/p/a.kojo2', '# 机 指令 310\n# 视角 灵梦\n> 甲\n', {
        charNo: '12',
        familySegment: '',
      }),
    ]);

    const theater = linked.projectIR.theaters[0];
    expect(theater?.sourceArgs).toEqual({ index: '310', indexOrigin: 'machine-args', span: expect.anything() });
    expect(theater?.targetResolution?.status).toBe('supported');
    expect(theater?.targetResolution?.functionName.name).toBe('M_KOJO_MESSAGE_COM_K12_310');
  });

  it('Registry 版本不匹配阻断构建，不静默解析', () => {
    const projectIR = buildProjectIR({
      projectId: 'p1',
      provenance: { ...PROVENANCE, targetRegistryVersion: '0' },
      files: [
        fileInput('/p/a.kojo2', '【剧场：初见】\n# 视角 灵梦\n> 甲\n', {
          charNo: '12',
          familySegment: '',
        }),
      ],
    });
    const linked = linkProject(projectIR, ERATW_TARGET_REGISTRY);
    expect(linked.projectIR.theaters[0]?.targetResolution).toBeNull();
    expect(linked.projectIR.theaters[0]?.linkStatus).toBe('version-mismatch');
    expect(linked.linkedProject.theaters).toEqual([]);
    expect(buildProjectBuildResult(linked.projectIR, linked.linkedProject).buildStatus).toBe('failed');
  });
});