/**
 * P1-4 收尾：多角色 exact duplicate 隔离（eraTW 真链路）。
 *
 * 同一 canonical target 下：
 * - K12 两份完全相同的定义（真 duplicate → 阻断 K12）；
 * - K13 一份合法定义（必须仍能独立匹配、dispatch plan 为 ready）。
 */
import { describe, expect, it } from 'vitest';
import {
  compileProject,
  createProjectFileIdentity,
  parseSource,
  selectRuntimeTheater,
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
  gameFingerprint: 'duplicate-isolation',
  targetRegistryId: ERATW_TARGET_REGISTRY.registryId,
  targetRegistryVersion: ERATW_TARGET_REGISTRY.version,
  backendId: 'eratw',
  backendVersion: '1',
  coreVersion: '0.0.0',
  sourceMapPolicy: ERATW_SOURCE_MAP,
  capability: ERATW_CAPABILITY,
};

function fileInput(path: string, text: string, charNo: string): ProjectCompileFileInput {
  return {
    identity: createProjectFileIdentity(path, pathKey(path), null, stableHash(text)),
    file: parseSource(text),
    sourceText: text,
    functionNameContext: { charNo, familySegment: '' },
  };
}

function source(header: string): string {
  return header + '\n# 视角 灵梦\n> 正文\n';
}

interface CompileOptions {
  readonly requireDispatch?: boolean;
  readonly emitDiagnosticArtifacts?: boolean;
  readonly selectors?: boolean;
}

function compile(files: readonly ProjectCompileFileInput[], options: CompileOptions = {}): ProjectCompileResult {
  return compileProject({
    projectId: 'duplicate-isolation',
    provenance: PROVENANCE,
    files,
    registry: ERATW_TARGET_REGISTRY,
    adapter: ERATW_GAME_ADAPTER,
    backend: createEratwEmitBackend({ compileExpression: (expr) => expr.text }),
    ...(options.selectors === false ? {} : { dispatchSelectors: ERATW_DISPATCH_SELECTORS }),
    ...(options.requireDispatch === undefined ? {} : { requireDispatch: options.requireDispatch }),
    ...(options.emitDiagnosticArtifacts === undefined
      ? {}
      : { emitDiagnosticArtifacts: options.emitDiagnosticArtifacts }),
  });
}

const K12_A = fileInput('D:/p/12-shrine-a.kojo2', source('【剧场：初见｜神社】'), '12');
const K12_B = fileInput('D:/p/12-shrine-b.kojo2', source('【剧场：初见｜神社】'), '12');
const K13 = fileInput('D:/p/13-shrine.kojo2', source('【剧场：初见｜神社】'), '13');

describe('多角色 duplicate 隔离 · eraTW 真链路', () => {
  it('K12 被诊断/阻断，K13 独立可匹配、plan target ready', () => {
    const result = compile([K12_A, K12_B, K13], { requireDispatch: true });
    // 项目级仍按 M2 契约失败（duplicate 是 error），但诊断视图必须逐函数隔离。
    expect(result.build.buildStatus).toBe('failed');
    expect(result.build.diagnostics.some((diagnostic) => diagnostic.kind === 'duplicate-theater')).toBe(true);

    const linked = result.build.linkedProject;
    if (linked === null) throw new Error('expected LinkedProject');
    const group = linked.groups[0];
    expect(group?.duplicate).toBe(true);
    expect(group?.duplicateFunctionNames).toEqual(['M_KOJO_ENCOUNTER_K12']);
    expect(group?.theaters.map((theater) => ({ name: theater.engineFunctionName.name, duplicate: theater.duplicate }))).toEqual([
      { name: 'M_KOJO_ENCOUNTER_K12', duplicate: true },
      { name: 'M_KOJO_ENCOUNTER_K12', duplicate: true },
      { name: 'M_KOJO_ENCOUNTER_K13', duplicate: false },
    ]);

    // 不点名：K12 重复被过滤，K13 唯一命中（不 ambiguous、不 not-linked）。
    const anyRole = selectRuntimeTheater({
      linkedProject: linked,
      canonicalId: 'eratw.event.初见',
      location: '神社',
      time: null,
    });
    expect(anyRole.status).toBe('selected');
    expect(anyRole.selected?.engineFunctionName.name).toBe('M_KOJO_ENCOUNTER_K13');
    expect(anyRole.candidates.map((candidate) => candidate.engineFunctionName)).toEqual(['M_KOJO_ENCOUNTER_K13']);

    // 点名：K12 单独拒绝，K13 不受波及。
    expect(
      selectRuntimeTheater({
        linkedProject: linked,
        canonicalId: 'eratw.event.初见',
        location: '神社',
        time: null,
        engineFunctionName: 'M_KOJO_ENCOUNTER_K12',
      }).status,
    ).toBe('not-linked');
    expect(
      selectRuntimeTheater({
        linkedProject: linked,
        canonicalId: 'eratw.event.初见',
        location: '神社',
        time: null,
        engineFunctionName: 'M_KOJO_ENCOUNTER_K13',
      }).status,
    ).toBe('selected');

    // Dispatch plan：按函数名隔离——K12 blocked、K13 ready。
    const k12 = result.dispatchPlan.targets.find((target) => target.functionName === 'M_KOJO_ENCOUNTER_K12');
    const k13 = result.dispatchPlan.targets.find((target) => target.functionName === 'M_KOJO_ENCOUNTER_K13');
    expect(k12?.status).toBe('blocked');
    expect(k12?.duplicate).toBe(true);
    expect(k13?.status).toBe('ready');
    expect(result.dispatchPlan.status).toBe('blocked');
    expect(
      result.dispatchDiagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'dispatch/duplicate-group' &&
          diagnostic.functionName === 'M_KOJO_ENCOUNTER_K12',
      ),
    ).toBe(true);

    // 默认不发布任何产物。
    expect(result.theaterErb).toEqual([]);
    expect(result.dispatchErb).toEqual([]);
  });

  it('诊断预览模式：K13 可以独立生成 dispatch ERB（明确不可发布）', () => {
    const result = compile([K12_A, K12_B, K13], {
      requireDispatch: true,
      emitDiagnosticArtifacts: true,
    });
    expect(result.build.buildStatus).toBe('failed');
    expect(result.theaterErb).toEqual([]);
    expect(result.dispatchErb).toHaveLength(1);
    expect(result.dispatchErb[0]?.functionName).toBe('M_KOJO_ENCOUNTER_K13');
    expect(result.dispatchErb[0]?.erb).toContain('@M_KOJO_ENCOUNTER_K13');
    expect(result.dispatchErb[0]?.erb).not.toContain('@M_KOJO_ENCOUNTER_K12');
    expect(result.dispatchComplete).toBe(false);
  });

  it('不同字符互不污染：K13 的 plan 不因 K12 的重复而 duplicate/blocked', () => {
    const result = compile([K12_A, K12_B, K13]);
    const k13 = result.dispatchPlan.targets.find((target) => target.functionName === 'M_KOJO_ENCOUNTER_K13');
    expect(k13?.duplicate).toBe(false);
    expect(k13?.status).toBe('ready');
    expect(k13?.branches.every((branch) => branch.duplicate === false)).toBe(true);
  });
});
