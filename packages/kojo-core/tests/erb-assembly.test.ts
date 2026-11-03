/**
 * M2/M3 收尾：最终 ERB 产物组装（`erb-assembly.ts`）核心单测。
 *
 * 全部用**最小 `ProjectCompileResult` 形状**驱动（`as` 收窄），只钉组装协议本身：
 * - `dispatchErb` 是最终产物，`theaterErb` 只报数量、绝不进 units；
 * - 构建失败 / plan 有 error / dispatch 数量或函数名对不上 ⇒ incomplete；
 * - legacy-machine 必须 Host 显式传入才能 complete；未知 / 缺失 / 重复传入都可见；
 * - dispatch units 按 functionName 查重，同一运行时函数只输出一次。
 *
 * 真 eraTW 链路的端到端断言在 `packages/plugins/eratw-adapter/tests/kojo2/erb-assembly.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import {
  assembleProjectErb,
  planProjectErbAssembly,
  type ProjectCompileResult,
  type ProjectDispatchPlan,
} from '../src/index.js';

/* ============================== 最小结果夹具 ============================== */

interface FakeFile {
  readonly fileId: string;
  readonly path: string;
}

interface FakeTheater {
  readonly fileId: string;
  readonly theaterId: string;
  readonly origin: 'theater' | 'legacy-machine';
}

interface FakeTarget {
  readonly canonicalId: string;
  readonly functionName: string;
  readonly status: 'ready' | 'blocked';
}

interface FakePlanDiagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly canonicalId: string;
  readonly functionName: string | null;
}

interface FakeFacts {
  readonly buildStatus?: 'succeeded' | 'failed';
  readonly files?: readonly FakeFile[];
  readonly theaters?: readonly FakeTheater[];
  readonly targets?: readonly FakeTarget[];
  readonly planStatus?: 'ready' | 'blocked';
  readonly planDiagnostics?: readonly FakePlanDiagnostic[];
  readonly dispatchErb?: readonly { readonly canonicalId: string; readonly functionName: string; readonly erb: string }[];
  readonly theaterErb?: readonly { readonly theaterId: string; readonly erb: string }[];
}

function fakeResult(facts: FakeFacts = {}): ProjectCompileResult {
  const targets = (facts.targets ?? []).map((target) => ({
    dispatchKey: target.canonicalId + '\u0000' + target.functionName,
    canonicalId: target.canonicalId,
    functionName: target.functionName,
    duplicate: false,
    status: target.status,
    branches: [],
  })) as unknown as ProjectDispatchPlan['targets'];
  const dispatchPlan: ProjectDispatchPlan = {
    projectId: 'fake-project',
    status: facts.planStatus ?? 'ready',
    targets,
    diagnostics: (facts.planDiagnostics ?? []) as unknown as ProjectDispatchPlan['diagnostics'],
  };
  return {
    build: {
      projectId: 'fake-project',
      analysisStatus: 'complete',
      buildStatus: facts.buildStatus ?? 'succeeded',
      projectIR: {
        projectId: 'fake-project',
        analysisStatus: 'complete',
        files: (facts.files ?? []).map((file) => ({ fileId: file.fileId, path: file.path })),
        theaters: (facts.theaters ?? []).map((theater) => ({
          fileId: theater.fileId,
          theaterId: theater.theaterId,
          origin: theater.origin,
        })),
        diagnostics: [],
        failedFiles: [],
      },
      linkedProject: null,
      diagnostics: [],
      failedFiles: [],
    },
    theaterErb: facts.theaterErb ?? [],
    backendDiagnostics: [],
    dispatchErb: facts.dispatchErb ?? [],
    dispatchDiagnostics: dispatchPlan.diagnostics,
    dispatchPlan,
    dispatchBackendDiagnostics: [],
    complete: (facts.buildStatus ?? 'succeeded') === 'succeeded',
    dispatchComplete: (facts.planStatus ?? 'ready') === 'ready',
  } as unknown as ProjectCompileResult;
}

const READY_TARGET: FakeTarget = {
  canonicalId: 'eratw.event.初见',
  functionName: 'M_KOJO_ENCOUNTER_K12',
  status: 'ready',
};

/* ============================== 计划 ============================== */

describe('planProjectErbAssembly · 计划以 dispatchPlan + IR 事实为准', () => {
  it('完整成功路径：dispatch unit 来自 ready target，plan ready', () => {
    const result = fakeResult({
      targets: [READY_TARGET],
      dispatchErb: [{ canonicalId: 'eratw.event.初见', functionName: 'M_KOJO_ENCOUNTER_K12', erb: '@M_KOJO_ENCOUNTER_K12\n' }],
    });

    const plan = planProjectErbAssembly(result);
    expect(plan.status).toBe('ready');
    expect(plan.dispatchUnits).toEqual([
      { canonicalId: 'eratw.event.初见', functionName: 'M_KOJO_ENCOUNTER_K12' },
    ]);
    expect(plan.legacyFiles).toEqual([]);
    expect(plan.previewOnlyTheaterCount).toBe(0);
    expect(plan.diagnostics).toEqual([]);
  });

  it('theaterErb 只报数量：previewOnlyTheaterCount 有值，但不是 dispatch unit', () => {
    const result = fakeResult({
      targets: [READY_TARGET],
      dispatchErb: [{ canonicalId: 'eratw.event.初见', functionName: 'M_KOJO_ENCOUNTER_K12', erb: '@M_KOJO_ENCOUNTER_K12\n' }],
      theaterErb: [
        { theaterId: 'theater:1', erb: '@PREVIEW_ONLY_1\n' },
        { theaterId: 'theater:2', erb: '@PREVIEW_ONLY_2\n' },
      ],
    });

    const plan = planProjectErbAssembly(result);
    expect(plan.status).toBe('ready');
    expect(plan.previewOnlyTheaterCount).toBe(2);
    expect(plan.dispatchUnits).toHaveLength(1);
  });

  it('构建失败：build-failed 诊断 + incomplete；ready target 仍作为诊断视图给出', () => {
    const result = fakeResult({
      buildStatus: 'failed',
      targets: [READY_TARGET],
      planStatus: 'blocked',
      planDiagnostics: [
        {
          code: 'dispatch/duplicate-group',
          severity: 'error',
          message: 'k12 重复',
          canonicalId: 'eratw.event.初见',
          functionName: 'M_KOJO_ENCOUNTER_K12',
        },
      ],
    });

    const plan = planProjectErbAssembly(result);
    expect(plan.status).toBe('incomplete');
    expect(plan.dispatchUnits).toEqual([
      { canonicalId: 'eratw.event.初见', functionName: 'M_KOJO_ENCOUNTER_K12' },
    ]);
    expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'assembly/build-failed',
      'assembly/dispatch-incomplete',
    ]);
    expect(plan.diagnostics[1]).toMatchObject({
      canonicalId: 'eratw.event.初见',
      functionName: 'M_KOJO_ENCOUNTER_K12',
    });
  });

  it('plan 有 error（构建成功）：dispatch-incomplete 带 canonical/function 下钻信息', () => {
    const result = fakeResult({
      targets: [READY_TARGET],
      planStatus: 'blocked',
      planDiagnostics: [
        {
          code: 'dispatch/ambiguous-branches',
          severity: 'error',
          message: '同特异性条件重叠',
          canonicalId: 'eratw.event.初见',
          functionName: 'M_KOJO_ENCOUNTER_K12',
        },
      ],
      // 数量对账不制造噪声：产物数量与 ready target 数一致，只有 plan error 一条首因。
      dispatchErb: [{ canonicalId: 'eratw.event.初见', functionName: 'M_KOJO_ENCOUNTER_K12', erb: '@K12\n' }],
    });

    const plan = planProjectErbAssembly(result);
    expect(plan.status).toBe('incomplete');
    expect(plan.diagnostics).toHaveLength(1);
    expect(plan.diagnostics[0]?.code).toBe('assembly/dispatch-incomplete');
    expect(plan.diagnostics[0]?.message).toContain('dispatch/ambiguous-branches');
    expect(plan.diagnostics[0]?.functionName).toBe('M_KOJO_ENCOUNTER_K12');
  });

  it('构建成功但 dispatchErb 数量对不上：dispatch-incomplete（数量对账）', () => {
    const second: FakeTarget = {
      canonicalId: 'eratw.event.初见',
      functionName: 'M_KOJO_ENCOUNTER_K13',
      status: 'ready',
    };
    const result = fakeResult({
      targets: [READY_TARGET, second],
      dispatchErb: [{ canonicalId: 'eratw.event.初见', functionName: 'M_KOJO_ENCOUNTER_K12', erb: '@K12\n' }],
    });

    const plan = planProjectErbAssembly(result);
    expect(plan.status).toBe('incomplete');
    expect(plan.diagnostics).toHaveLength(1);
    expect(plan.diagnostics[0]?.code).toBe('assembly/dispatch-incomplete');
    expect(plan.diagnostics[0]?.message).toContain('1');
    expect(plan.diagnostics[0]?.message).toContain('2');
  });

  it('legacy 期望从 IR 按 fileId 聚合，path 来自 files 且与文件注入顺序无关', () => {
    const result = fakeResult({
      files: [
        { fileId: 'file:b', path: 'D:/proj/b.kojo2' },
        { fileId: 'file:a', path: 'D:/proj/a.kojo2' },
      ],
      theaters: [
        { fileId: 'file:b', theaterId: 'theater:b:0', origin: 'legacy-machine' },
        { fileId: 'file:a', theaterId: 'theater:a:0', origin: 'legacy-machine' },
        { fileId: 'file:a', theaterId: 'theater:a:1', origin: 'legacy-machine' },
        { fileId: 'file:x', theaterId: 'theater:x:0', origin: 'theater' },
      ],
    });

    const plan = planProjectErbAssembly(result);
    expect(plan.status).toBe('ready');
    expect(plan.legacyFiles).toEqual([
      { fileId: 'file:a', path: 'D:/proj/a.kojo2', theaterIds: ['theater:a:0', 'theater:a:1'] },
      { fileId: 'file:b', path: 'D:/proj/b.kojo2', theaterIds: ['theater:b:0'] },
    ]);
  });
});

/* ============================== 组装 ============================== */

describe('assembleProjectErb · 最终 units', () => {
  it('完整路径：dispatch unit 原样透传，status complete', () => {
    const result = fakeResult({
      targets: [READY_TARGET],
      dispatchErb: [{ canonicalId: 'eratw.event.初见', functionName: 'M_KOJO_ENCOUNTER_K12', erb: '@K12\nRETURN 1\n' }],
    });

    const assembly = assembleProjectErb({ result });
    expect(assembly.status).toBe('complete');
    expect(assembly.diagnostics).toEqual([]);
    expect(assembly.units).toEqual([
      {
        kind: 'dispatch',
        canonicalId: 'eratw.event.初见',
        functionName: 'M_KOJO_ENCOUNTER_K12',
        fileId: null,
        erb: '@K12\nRETURN 1\n',
      },
    ]);
  });

  it('theaterErb 绝不进 units（含同名 @函数也不拼）', () => {
    const result = fakeResult({
      targets: [READY_TARGET],
      dispatchErb: [{ canonicalId: 'eratw.event.初见', functionName: 'M_KOJO_ENCOUNTER_K12', erb: '@K12\n' }],
      theaterErb: [
        { theaterId: 'theater:1', erb: '@K12\n' },
        { theaterId: 'theater:2', erb: '@K12\n' },
      ],
    });

    const assembly = assembleProjectErb({ result });
    expect(assembly.status).toBe('complete');
    expect(assembly.units).toHaveLength(1);
    expect(assembly.units[0]?.kind).toBe('dispatch');
    expect(assembly.plan.previewOnlyTheaterCount).toBe(2);
  });

  it('构建失败：incomplete、units 为空（不发布半成品）', () => {
    const result = fakeResult({
      buildStatus: 'failed',
      targets: [READY_TARGET],
      dispatchErb: [],
      planStatus: 'blocked',
      planDiagnostics: [
        {
          code: 'dispatch/duplicate-group',
          severity: 'error',
          message: 'k12 重复',
          canonicalId: 'eratw.event.初见',
          functionName: 'M_KOJO_ENCOUNTER_K12',
        },
      ],
    });

    const assembly = assembleProjectErb({ result });
    expect(assembly.status).toBe('incomplete');
    expect(assembly.units).toEqual([]);
    expect(assembly.diagnostics.some((diagnostic) => diagnostic.code === 'assembly/build-failed')).toBe(true);
  });

  it('构建失败但带诊断用 dispatchErb（emitDiagnosticArtifacts）：仍 incomplete，不可发布', () => {
    const result = fakeResult({
      buildStatus: 'failed',
      targets: [READY_TARGET],
      dispatchErb: [{ canonicalId: 'eratw.event.初见', functionName: 'M_KOJO_ENCOUNTER_K12', erb: '@K12\n' }],
      planStatus: 'blocked',
      planDiagnostics: [
        {
          code: 'dispatch/duplicate-group',
          severity: 'error',
          message: 'k12 重复',
          canonicalId: 'eratw.event.初见',
          functionName: 'M_KOJO_ENCOUNTER_K12',
        },
      ],
    });

    const assembly = assembleProjectErb({ result });
    // 诊断预览可以出现在 units 里（编辑器要看），但 status 必须拦住发布。
    expect(assembly.status).toBe('incomplete');
    expect(assembly.units).toHaveLength(1);
    expect(assembly.diagnostics.some((diagnostic) => diagnostic.code === 'assembly/build-failed')).toBe(true);
  });

  it('dispatch units 按 functionName 查重：重复只输出一份 + duplicate-runtime-function', () => {
    const duplicateTarget: FakeTarget = {
      canonicalId: 'eratw.event.别的',
      functionName: 'M_KOJO_ENCOUNTER_K12',
      status: 'ready',
    };
    const result = fakeResult({
      targets: [READY_TARGET, duplicateTarget],
      dispatchErb: [
        { canonicalId: 'eratw.event.初见', functionName: 'M_KOJO_ENCOUNTER_K12', erb: '@K12 first\n' },
        { canonicalId: 'eratw.event.别的', functionName: 'M_KOJO_ENCOUNTER_K12', erb: '@K12 second\n' },
      ],
    });

    const assembly = assembleProjectErb({ result });
    expect(assembly.status).toBe('incomplete');
    expect(assembly.units).toHaveLength(1);
    expect(assembly.units[0]?.erb).toBe('@K12 first\n');
    expect(assembly.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'assembly/duplicate-runtime-function',
    ]);
    expect(assembly.diagnostics[0]?.functionName).toBe('M_KOJO_ENCOUNTER_K12');
  });

  it('plan ready 时做函数名级对账：缺 target 报 dispatch-incomplete', () => {
    const second: FakeTarget = {
      canonicalId: 'eratw.event.初见',
      functionName: 'M_KOJO_ENCOUNTER_K13',
      status: 'ready',
    };
    // 数量相等（2 个 ready target / 2 份产物），但函数名对不上：plan 的数量对账放行，
    // 组装层的名字对账必须抓住。
    const result = fakeResult({
      targets: [READY_TARGET, second],
      dispatchErb: [
        { canonicalId: 'eratw.event.初见', functionName: 'M_KOJO_ENCOUNTER_K12', erb: '@K12\n' },
        { canonicalId: 'eratw.event.初见', functionName: 'M_KOJO_ENCOUNTER_K99', erb: '@K99\n' },
      ],
    });

    const assembly = assembleProjectErb({ result });
    expect(assembly.plan.status).toBe('ready');
    expect(assembly.status).toBe('incomplete');
    const codes = assembly.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('assembly/dispatch-incomplete');
    expect(codes).toContain('assembly/dispatch-incomplete');
    const serialized = assembly.diagnostics.map((diagnostic) => diagnostic.message).join('\n');
    expect(serialized).toContain('M_KOJO_ENCOUNTER_K13');
    expect(serialized).toContain('M_KOJO_ENCOUNTER_K99');
  });

  it('legacy 缺失：incomplete + legacy-missing（跳过 legacy ≠ 项目完整）', () => {
    const result = fakeResult({
      files: [{ fileId: 'file:legacy', path: 'D:/proj/legacy.kojo2' }],
      theaters: [{ fileId: 'file:legacy', theaterId: 'theater:legacy:0', origin: 'legacy-machine' }],
    });

    const assembly = assembleProjectErb({ result });
    expect(assembly.plan.status).toBe('ready');
    expect(assembly.plan.legacyFiles).toHaveLength(1);
    expect(assembly.status).toBe('incomplete');
    expect(assembly.units).toEqual([]);
    expect(assembly.diagnostics).toHaveLength(1);
    expect(assembly.diagnostics[0]).toMatchObject({
      code: 'assembly/legacy-missing',
      fileId: 'file:legacy',
    });
  });

  it('legacy 未知 fileId：legacy-unknown，不产出 unit', () => {
    const result = fakeResult({
      files: [{ fileId: 'file:legacy', path: 'D:/proj/legacy.kojo2' }],
      theaters: [{ fileId: 'file:legacy', theaterId: 'theater:legacy:0', origin: 'legacy-machine' }],
    });

    const assembly = assembleProjectErb({
      result,
      legacyErb: [{ fileId: 'file:not-in-project', erb: '@UNKNOWN\n' }],
    });
    expect(assembly.status).toBe('incomplete');
    expect(assembly.units).toEqual([]);
    const codes = assembly.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('assembly/legacy-unknown');
    expect(codes).toContain('assembly/legacy-missing');
  });

  it('legacy 显式传入后 complete：dispatch 在前、legacy-m1 在后且字节原样', () => {
    const result = fakeResult({
      files: [{ fileId: 'file:legacy', path: 'D:/proj/legacy.kojo2' }],
      theaters: [{ fileId: 'file:legacy', theaterId: 'theater:legacy:0', origin: 'legacy-machine' }],
      targets: [READY_TARGET],
      dispatchErb: [{ canonicalId: 'eratw.event.初见', functionName: 'M_KOJO_ENCOUNTER_K12', erb: '@K12\n' }],
    });

    const assembly = assembleProjectErb({
      result,
      legacyErb: [{ fileId: 'file:legacy', erb: '@M_KOJO_COMMAND_310\nRETURN 1\n' }],
    });
    expect(assembly.status).toBe('complete');
    expect(assembly.diagnostics).toEqual([]);
    expect(assembly.units.map((unit) => unit.kind)).toEqual(['dispatch', 'legacy-m1']);
    expect(assembly.units[1]).toEqual({
      kind: 'legacy-m1',
      canonicalId: null,
      functionName: null,
      fileId: 'file:legacy',
      erb: '@M_KOJO_COMMAND_310\nRETURN 1\n',
    });
  });

  it('同一 legacy 文件传入多份：duplicate-runtime-function（保留第一份）', () => {
    const result = fakeResult({
      files: [{ fileId: 'file:legacy', path: 'D:/proj/legacy.kojo2' }],
      theaters: [{ fileId: 'file:legacy', theaterId: 'theater:legacy:0', origin: 'legacy-machine' }],
    });

    const assembly = assembleProjectErb({
      result,
      legacyErb: [
        { fileId: 'file:legacy', erb: '@FIRST\n' },
        { fileId: 'file:legacy', erb: '@SECOND\n' },
      ],
    });
    expect(assembly.status).toBe('incomplete');
    expect(assembly.units).toHaveLength(1);
    expect(assembly.units[0]?.erb).toBe('@FIRST\n');
    expect(assembly.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'assembly/duplicate-runtime-function',
    ]);
  });

  it('空项目（无 dispatch / 无 legacy）：plan ready，assemble complete 且 units 为空', () => {
    const assembly = assembleProjectErb({ result: fakeResult() });
    expect(assembly.plan.status).toBe('ready');
    expect(assembly.status).toBe('complete');
    expect(assembly.units).toEqual([]);
  });
});
