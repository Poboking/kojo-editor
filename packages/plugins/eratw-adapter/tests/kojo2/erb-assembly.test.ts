/**
 * M2/M3 收尾：最终 ERB 产物组装 **真实链路**（eraTW adapter / registry / backend + compileProject）。
 *
 * 三组断言：
 * 1. 同角色多地点 + selectors + requireDispatch：dispatchErb 就是最终产物，theaterErb 只做预览；
 * 2. 显式初见 + legacy `# 机` 混合项目：legacy ERB 必须由 Host 用 M1 单文件路径显式传入，
 *    缺失即 incomplete，传入后 complete；
 * 3. 同 canonical 下 K12 duplicate + K13 合法：build failed，plan 只把 K12 挡在 dispatchUnits 外，
 *    K13 仍 ready（多角色重复隔离的可读证据），组装 incomplete。
 */
import { describe, expect, it } from 'vitest';
import {
  assembleProjectErb,
  compileKojoFile,
  compileProject,
  createProjectFileIdentity,
  parseSource,
  planProjectErbAssembly,
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
  gameFingerprint: 'erb-assembly',
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

/** 项目编译 backend（只钉产物结构，表达式端口用恒等替身）。 */
function projectBackend() {
  return createEratwEmitBackend({ compileExpression: (expr) => expr.text });
}

/** M1 单文件路径 backend：legacy `# 机` 的口上函数名需要 charNo。 */
function m1Backend() {
  return createEratwEmitBackend({ compileExpression: (expr) => expr.text, charNo: '12' });
}

function compile(
  files: readonly ProjectCompileFileInput[],
  options: { readonly requireDispatch?: boolean } = {},
): ProjectCompileResult {
  return compileProject({
    projectId: 'erb-assembly',
    provenance: PROVENANCE,
    files,
    registry: ERATW_TARGET_REGISTRY,
    adapter: ERATW_GAME_ADAPTER,
    backend: projectBackend(),
    dispatchSelectors: ERATW_DISPATCH_SELECTORS,
    ...(options.requireDispatch === undefined ? {} : { requireDispatch: options.requireDispatch }),
  });
}

/** Host 侧 M1 单文件路径：`# 机` 的 ERB 必须由这里产出，再显式交给组装接口。 */
function m1ErbOf(input: ProjectCompileFileInput): string {
  if (input.file === null) throw new Error('fixture 文件解析失败');
  const compiled = compileKojoFile(input.file, {
    adapter: ERATW_GAME_ADAPTER,
    backend: m1Backend(),
    sourceText: input.sourceText,
  });
  if (!compiled.ok) {
    throw new Error(
      'M1 单文件路径失败：' + compiled.diagnostics.map((diagnostic) => diagnostic.message).join('; '),
    );
  }
  return compiled.erb;
}

const SHRINE_12 = fileInput('D:/proj/01-shrine.kojo2', theaterSource('【剧场：初见｜神社】', '神社'), '12');
const SCHOOL_12 = fileInput('D:/proj/02-school.kojo2', theaterSource('【剧场：初见｜学校】', '学校'), '12');
const SHRINE_12_DUP = fileInput('D:/proj/03-shrine-dup.kojo2', theaterSource('【剧场：初见｜神社】', '神社'), '12');
const SHRINE_13 = fileInput('D:/proj/04-shrine-13.kojo2', theaterSource('【剧场：初见｜神社】', '魔理沙'), '13');
const LEGACY = fileInput('D:/proj/05-legacy-command.kojo2', '# 机 指令 310\n# 视角 灵梦\n> 旧正文\n', '12');

describe('最终 ERB 组装 · 同角色多地点（dispatchErb 是最终产物）', () => {
  it('plan ready；assemble（无 legacy）complete；units 全是 dispatch、无 theaterErb 内容', () => {
    const result = compile([SHRINE_12, SCHOOL_12], { requireDispatch: true });

    expect(result.build.buildStatus).toBe('succeeded');
    expect(result.theaterErb).toHaveLength(2);
    expect(result.dispatchErb).toHaveLength(1);

    const plan = planProjectErbAssembly(result);
    expect(plan.status).toBe('ready');
    expect(plan.legacyFiles).toEqual([]);
    expect(plan.previewOnlyTheaterCount).toBe(2);
    expect(plan.dispatchUnits).toEqual([
      { canonicalId: 'eratw.event.初见', functionName: 'M_KOJO_ENCOUNTER_K12' },
    ]);

    const assembly = assembleProjectErb({ result });
    expect(assembly.status).toBe('complete');
    expect(assembly.diagnostics).toEqual([]);
    expect(assembly.units).toHaveLength(1);
    expect(assembly.units.every((unit) => unit.kind === 'dispatch')).toBe(true);
    expect(assembly.units[0]?.functionName).toBe('M_KOJO_ENCOUNTER_K12');
    expect(assembly.units[0]?.fileId).toBeNull();

    const erb = assembly.units[0]?.erb ?? '';
    // 合并后的 dispatch 字节：主函数 + 两个 branch 函数。
    expect(erb).toContain('@M_KOJO_ENCOUNTER_K12');
    expect(erb).toContain('== "神社"');
    expect(erb).toContain('== "学校"');
    expect(erb).toContain('@M_KOJO_ENCOUNTER_K12__D1');
    expect(erb).toContain('@M_KOJO_ENCOUNTER_K12__D2');
    // theaterErb 是单 Theater 预览：逐份 != 最终合并产物，且没有被拼进 units。
    for (const preview of result.theaterErb) {
      expect(erb).not.toBe(preview.erb);
    }
    expect(assembly.units.every((unit) => unit.erb.length > 0)).toBe(true);
  });
});

describe('最终 ERB 组装 · 显式初见 + legacy 混合项目', () => {
  it('legacy 期望恰 1 个 fileId；不传 legacyErb ⇒ incomplete + legacy-missing', () => {
    const result = compile([SHRINE_12, LEGACY], { requireDispatch: true });
    expect(result.build.buildStatus).toBe('succeeded');
    expect(result.dispatchErb).toHaveLength(1);

    const plan = planProjectErbAssembly(result);
    expect(plan.status).toBe('ready');
    expect(plan.dispatchUnits).toHaveLength(1);
    expect(plan.legacyFiles).toHaveLength(1);
    expect(plan.legacyFiles[0]?.fileId).toBe(LEGACY.identity.fileId);
    expect(plan.legacyFiles[0]?.path).toBe('D:/proj/05-legacy-command.kojo2');
    expect(plan.legacyFiles[0]?.theaterIds).toHaveLength(1);

    const assembly = assembleProjectErb({ result });
    expect(assembly.status).toBe('incomplete');
    expect(assembly.units).toHaveLength(1); // 只有显式初见的 dispatch unit；legacy 缺失
    expect(assembly.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'assembly/legacy-missing',
    ]);
    expect(assembly.diagnostics[0]?.fileId).toBe(LEGACY.identity.fileId);
  });

  it('未知 legacy fileId ⇒ legacy-unknown（不产出 unit）', () => {
    const result = compile([SHRINE_12, LEGACY], { requireDispatch: true });
    const assembly = assembleProjectErb({
      result,
      legacyErb: [{ fileId: 'file:not-in-project', erb: '@UNKNOWN\n' }],
    });

    expect(assembly.status).toBe('incomplete');
    expect(assembly.units).toHaveLength(1);
    const codes = assembly.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('assembly/legacy-unknown');
    expect(codes).toContain('assembly/legacy-missing');
  });

  it('Host 传入 M1 单文件路径产出的 legacy ERB ⇒ complete，units = 1 dispatch + 1 legacy-m1', () => {
    const result = compile([SHRINE_12, LEGACY], { requireDispatch: true });
    const legacyErb = m1ErbOf(LEGACY);
    // M1 真实产物本身就是 byte 级交给组装层的东西：含 `@` 函数定义。
    expect(legacyErb).toContain('@M_KOJO');

    const assembly = assembleProjectErb({
      result,
      legacyErb: [{ fileId: LEGACY.identity.fileId, erb: legacyErb }],
    });
    expect(assembly.status).toBe('complete');
    expect(assembly.diagnostics).toEqual([]);
    expect(assembly.units).toHaveLength(2);
    expect(assembly.units.map((unit) => unit.kind)).toEqual(['dispatch', 'legacy-m1']);
    const legacyUnit = assembly.units[1];
    expect(legacyUnit?.kind).toBe('legacy-m1');
    expect(legacyUnit?.fileId).toBe(LEGACY.identity.fileId);
    expect(legacyUnit?.canonicalId).toBeNull();
    expect(legacyUnit?.functionName).toBeNull();
    expect(legacyUnit?.erb).toBe(legacyErb);
  });
});

describe('最终 ERB 组装 · K12 duplicate / K13 合法的函数级隔离', () => {
  it('build failed；plan 只挡 K12，dispatchUnits 里 K12 不在、K13 在；assemble incomplete', () => {
    const result = compile([SHRINE_12, SHRINE_12_DUP, SHRINE_13]);

    expect(result.build.buildStatus).toBe('failed');
    expect(result.dispatchErb).toEqual([]);

    const plan = planProjectErbAssembly(result);
    expect(plan.status).toBe('incomplete');
    expect(plan.diagnostics.some((diagnostic) => diagnostic.code === 'assembly/build-failed')).toBe(true);

    const plannedFunctions = plan.dispatchUnits.map((unit) => unit.functionName);
    expect(plannedFunctions).not.toContain('M_KOJO_ENCOUNTER_K12');
    expect(plannedFunctions).toContain('M_KOJO_ENCOUNTER_K13');

    const assembly = assembleProjectErb({ result });
    expect(assembly.status).toBe('incomplete');
    expect(assembly.units).toEqual([]);
  });
});
