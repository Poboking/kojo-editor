/**
 * M2-P1 Project IR 事实层测试（只读生产代码）：
 * - 多文件构造顺序 / Theater 源序 / ordinal / origin / 解析失败局部降级；
 * - Theater sourceArgs：显式 Theater 不猜参，legacy `# 机` 的 args[0] 原样保留；
 * - 文件级函数名上下文：缺席 familySegment 与显式空串严格可区分；
 * - buildStatus 与 analysisStatus 分离：解析失败 / 文件 error / 未跑 lowering 都 fail-closed；
 * - M1 legacy 黄金字节。
 */
import { describe, expect, it } from 'vitest';
import {
  buildProjectBuildResult,
  buildProjectIR,
  compileKojoSource,
  createProjectFileIdentity,
  FIXTURE_ADAPTER,
  FIXTURE_BACKEND,
  parseSource,
  projectTheaterId,
  type KojoDiagnostic,
  type KojoFile,
  type ProjectBuildProvenance,
  type ProjectFileIdentity,
  type ProjectFileInput,
} from '../src/index.js';

const PROVENANCE: ProjectBuildProvenance = {
  adapterId: FIXTURE_ADAPTER.id,
  adapterVersion: FIXTURE_ADAPTER.version,
  adapterFactsVersion: 'fixture-facts-1',
  gameFingerprint: FIXTURE_ADAPTER.gameFingerprint.digest,
  targetRegistryId: 'fixture-registry',
  targetRegistryVersion: '1',
  backendId: FIXTURE_BACKEND.id,
  backendVersion: null,
  coreVersion: 'test',
  sourceMapPolicy: FIXTURE_ADAPTER.sourceMap,
  capability: FIXTURE_ADAPTER.capability,
};

function identityOf(path: string, contentHash = 'hash'): ProjectFileIdentity {
  return createProjectFileIdentity(path, path, null, contentHash);
}

function emptyFile(): KojoFile {
  return { decls: [], scenes: [], diagnostics: [] };
}

describe('Project IR · 多文件事实与局部失败', () => {
  it('保留文件数组顺序、Theater 源序/ordinal/origin，并只丢弃解析失败文件', () => {
    const explicitFile = parseSource(
      ['【剧场：甲】', '> 甲正文', '【剧场：乙】', '> 乙正文', '【剧场：丙】', '> 丙正文', ''].join('\n'),
    );
    const legacyFile = parseSource('# 机 开场 310\n# 视角 灵梦\n> 旧正文\n');
    const explicitIdentity = identityOf('/project/甲.kojo2', 'explicit-hash');
    const legacyIdentity = identityOf('/project/旧.kojo2', 'legacy-hash');
    const failedIdentity = identityOf('/project/坏.kojo2', 'failed-hash');

    const files: readonly ProjectFileInput[] = [
      { identity: explicitIdentity, file: explicitFile },
      { identity: legacyIdentity, file: legacyFile },
      { identity: failedIdentity, file: null },
    ];
    const project = buildProjectIR({ projectId: 'project-1', provenance: PROVENANCE, files });

    expect(project.files.map((file) => file.path)).toEqual([
      '/project/甲.kojo2',
      '/project/旧.kojo2',
      '/project/坏.kojo2',
    ]);
    expect(project.files.map((file) => file.parseStatus)).toEqual(['ok', 'ok', 'failed']);
    expect(project.files[0]?.file).toBe(explicitFile);
    expect(project.files[1]?.file).toBe(legacyFile);
    expect(project.files[2]?.file).toBeNull();

    expect(project.theaters.map((theater) => theater.theater.target.raw)).toEqual([
      '甲',
      '乙',
      '丙',
      '开场',
    ]);
    expect(project.theaters.map((theater) => theater.ordinal)).toEqual([0, 1, 2, 0]);
    expect(project.theaters.map((theater) => theater.origin)).toEqual([
      'theater',
      'theater',
      'theater',
      'legacy-machine',
    ]);
    expect(project.theaters.slice(0, 3).map((theater) => theater.theaterId)).toEqual(
      [0, 1, 2].map((ordinal) => projectTheaterId(explicitIdentity.fileId, ordinal)),
    );
    expect(project.theaters[3]?.theaterId).toBe(projectTheaterId(legacyIdentity.fileId, 0));

    expect(project.analysisStatus).toBe('partial');
    expect(project.failedFiles).toEqual([failedIdentity.fileId]);
    expect(project.diagnostics).toHaveLength(1);
    const diagnostic = project.diagnostics[0];
    expect(diagnostic?.kind).toBe('project-incomplete');
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.code).toBe('core/project/parse-failed');
    expect(diagnostic?.primary.fileId).toBe(failedIdentity.fileId);
    expect(diagnostic?.primary.path).toBe('/project/坏.kojo2');
    expect(diagnostic?.primary.span).toBeNull();
    expect(diagnostic?.primary.role).toBe('declaration');

    // 同样的输入重建，TheaterId 不漂移（ordinal 是稳定的源文件内序号）。
    const rebuilt = buildProjectIR({ projectId: 'project-1', provenance: PROVENANCE, files });
    expect(rebuilt.theaters.map((theater) => theater.theaterId)).toEqual(
      project.theaters.map((theater) => theater.theaterId),
    );
  });

  it('显式 Theater 不猜 sourceArgs；legacy # 机 args[0] 标记 machine-args 并保留 machine span', () => {
    const explicitFile = parseSource('【剧场：初见】\n> 正文\n');
    const legacyFile = parseSource('# 机 开场 310\n> 正文\n');
    const explicitTheater = explicitFile.theaters?.[0];
    const legacyTheater = legacyFile.theaters?.[0];
    if (explicitTheater === undefined || legacyTheater === undefined) {
      throw new Error('fixture 未产出预期的 Theater');
    }
    const machine = legacyTheater.legacyMachine;
    if (machine === null) {
      throw new Error('legacy theater 缺少 legacyMachine');
    }

    const project = buildProjectIR({
      projectId: 'project-args',
      provenance: PROVENANCE,
      files: [
        { identity: identityOf('/project/explicit.kojo2'), file: explicitFile },
        { identity: identityOf('/project/legacy.kojo2'), file: legacyFile },
      ],
    });

    expect(project.theaters[0]?.origin).toBe('theater');
    expect(project.theaters[0]?.sourceArgs).toEqual({
      index: null,
      indexOrigin: 'none',
      span: null,
    });
    expect(project.theaters[1]?.origin).toBe('legacy-machine');
    expect(project.theaters[1]?.sourceArgs).toEqual({
      index: '310',
      indexOrigin: 'machine-args',
      span: machine.span,
    });
  });
});

describe('Project IR · functionNameContext 缺席 ≠ 空串', () => {
  it('缺省 context 没有 familySegment own property；显式空串保留为空串', () => {
    const file = emptyFile();
    const missing = buildProjectIR({
      projectId: 'project-context-missing',
      provenance: PROVENANCE,
      files: [{ identity: identityOf('/project/missing.kojo2'), file }],
    });
    const explicit = buildProjectIR({
      projectId: 'project-context-empty',
      provenance: PROVENANCE,
      files: [
        {
          identity: identityOf('/project/explicit.kojo2'),
          file,
          functionNameContext: { familySegment: '' },
        },
      ],
    });

    const missingContext = missing.files[0]?.functionNameContext;
    const explicitContext = explicit.files[0]?.functionNameContext;
    if (missingContext === undefined || explicitContext === undefined) {
      throw new Error('Project IR 未产出一一对应的文件事实');
    }

    expect(Object.prototype.hasOwnProperty.call(missingContext, 'familySegment')).toBe(false);
    expect(missingContext).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(explicitContext, 'familySegment')).toBe(true);
    expect(explicitContext.familySegment).toBe('');
  });
});

describe('Project IR · buildStatus', () => {
  it('解析失败 → failed', () => {
    const failed = buildProjectIR({
      projectId: 'project-parse-failure',
      provenance: PROVENANCE,
      files: [{ identity: identityOf('/project/broken.kojo2'), file: null }],
    });

    expect(failed.analysisStatus).toBe('partial');
    expect(buildProjectBuildResult(failed).buildStatus).toBe('failed');
  });

  it('文件级 error 诊断 → failed', () => {
    const fileDiagnostic: KojoDiagnostic = {
      code: 'core/decl/unknown-type',
      severity: 'error',
      message: '测试用文件级 error',
      span: null,
    };
    const file: KojoFile = { decls: [], scenes: [], diagnostics: [fileDiagnostic] };
    const project = buildProjectIR({
      projectId: 'project-file-error',
      provenance: PROVENANCE,
      files: [{ identity: identityOf('/project/error.kojo2'), file }],
    });

    expect(project.analysisStatus).toBe('complete');
    expect(project.files[0]?.diagnostics).toEqual([fileDiagnostic]);
    expect(buildProjectBuildResult(project).buildStatus).toBe('failed');
  });

  it('只有解析事实、没有 Theater 且没有 error → succeeded', () => {
    const project = buildProjectIR({
      projectId: 'project-parse-only',
      provenance: PROVENANCE,
      files: [{ identity: identityOf('/project/empty.kojo2'), file: emptyFile() }],
    });

    expect(project.analysisStatus).toBe('complete');
    expect(project.theaters).toEqual([]);
    expect(project.diagnostics).toEqual([]);
    expect(buildProjectBuildResult(project).buildStatus).toBe('succeeded');
  });

  it('Theater 未跑 lowering（not-applicable）→ failed', () => {
    const file = parseSource('【剧场：初见】\n> 正文\n');
    const project = buildProjectIR({
      projectId: 'project-uncompiled-theater',
      provenance: PROVENANCE,
      files: [{ identity: identityOf('/project/theater.kojo2'), file }],
    });

    expect(project.analysisStatus).toBe('complete');
    expect(project.theaters[0]?.unitStatus).toBe('not-applicable');
    expect(buildProjectBuildResult(project).buildStatus).toBe('failed');
  });
});

describe('compileKojoSource · M1 legacy 黄金字节', () => {
  it('`# 机 开场` + `# 视角` + 单行正文产出冻结 ERB', () => {
    const source = '# 机 开场\n# 视角 灵梦\n> 你好\n';
    const result = compileKojoSource({
      source,
      adapter: FIXTURE_ADAPTER,
      backend: FIXTURE_BACKEND,
    });

    expect(result.ok).toBe(true);
    expect(result.erb).toBe('MACHINE 开场\nTELL: 你好 /WAIT\nMACHINE.END\n');
  });
});