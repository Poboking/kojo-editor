/**
 * M2 验收矩阵（Contracts §13）端到端验收：TargetRegistry → Project IR → Linker → Backend。
 *
 * 只走公开导出（`@kojo/kojo-core` 与 adapter 的 `src/kojo2/index.ts` 桶）：不 import core 内部
 * 深路径、不自己造 identity / contentHash、不读盘、不改 AST。每条用例对应 Contracts §13 的一行：
 *
 *  1) 七个 unsupported 事件 → targetResolution.status='unsupported' + target-unsupported error + 不进 groups
 *  2) 未登记目标 → target-unknown error + 不进 groups
 *  3) 缺 charNo → function-name-context-missing + build failed
 *  4) 缺 familySegment → missing；显式空串 → resolved（缺席不补空串，空串也不被当成缺席）
 *  5) charNo 非法（空串 / 非数字）→ invalid-context + function-name-context-invalid
 *  6) 同五字段跨文件 → duplicate-theater（primary/related 指认两份文件）+ group.duplicate=true
 *  7) 同 canonical 不同 location/time → 一个候选 group、duplicate=false
 *  8) 文件输入置换 → 派生事实（groups / theaters / diagnostics / ERB）逐条相同；ProjectIR.files 保留输入序
 *  9) Registry 版本不匹配 → targetResolution=null + linkStatus='version-mismatch' + build failed
 * 10) 任一阻断 → compileProject.theaterErb 为空（不发布部分产物）
 *
 * 刻意不给 backend 注入 charNo / familySegment：项目级函数名必须由 TargetRegistry 的
 * FunctionNameResolution 提供（Contracts D3），backend 的旧渲染路径不得参与。
 */
import { describe, expect, it } from 'vitest';
import {
  compileProject,
  createProjectFileIdentity,
  parseSource,
  type LinkedProject,
  type ProjectBuildProvenance,
  type ProjectCompileFileInput,
  type ProjectCompileResult,
  type ProjectDiagnostic,
  type ProjectDiagnosticKind,
  type ProjectTheaterIR,
  type TargetResolution,
} from '@kojo/kojo-core';
import { pathKey, stableHash } from '@kojo/plugin-api';
import {
  createEratwEmitBackend,
  ERATW_CAPABILITY,
  ERATW_GAME_ADAPTER,
  ERATW_SOURCE_MAP,
  ERATW_TARGET_REGISTRY,
} from '../../src/kojo2/index.js';

/** Host 注入的标准版上下文：charNo 有值，familySegment 用显式空串（不是缺席）。 */
const FULL_CONTEXT = { charNo: '12', familySegment: '' } as const;

/** Contracts D1：首版 eraTW 里明确 unsupported 的七个事件。 */
const UNSUPPORTED_EVENTS = ['训练', '读档', '商店', '购买', '训练结束', '回合末', '指令结束'] as const;

interface ContextOverride {
  readonly charNo?: string;
  readonly familySegment?: string;
}

function provenance(overrides: Partial<ProjectBuildProvenance> = {}): ProjectBuildProvenance {
  return {
    adapterId: 'eratw',
    adapterVersion: '2.0.0',
    adapterFactsVersion: '1',
    gameFingerprint: 'm2-acceptance',
    targetRegistryId: ERATW_TARGET_REGISTRY.registryId,
    targetRegistryVersion: ERATW_TARGET_REGISTRY.version,
    backendId: 'eratw',
    backendVersion: '1',
    coreVersion: '0.0.0',
    sourceMapPolicy: ERATW_SOURCE_MAP,
    capability: ERATW_CAPABILITY,
    ...overrides,
  };
}

function fileInput(
  path: string,
  source: string,
  context: ContextOverride = FULL_CONTEXT,
): ProjectCompileFileInput {
  return {
    identity: createProjectFileIdentity(path, pathKey(path), null, stableHash(source)),
    file: parseSource(source),
    sourceText: source,
    functionNameContext: { ...context },
  };
}

/** 一个 Theater 文件的最小可解析正文（叙事 + 显式视角，不触发无用诊断）。 */
function theaterSource(header: string, line = '甲'): string {
  return header + '\n# 视角 灵梦\n> ' + line + '\n';
}

function compile(
  files: readonly ProjectCompileFileInput[],
  provenanceOverrides: Partial<ProjectBuildProvenance> = {},
): ProjectCompileResult {
  return compileProject({
    projectId: 'm2-acceptance',
    provenance: provenance(provenanceOverrides),
    files,
    registry: ERATW_TARGET_REGISTRY,
    adapter: ERATW_GAME_ADAPTER,
    backend: createEratwEmitBackend({ compileExpression: (expr) => expr.text }),
  });
}

/* ---------- 导航小工具：只做窄化，不用 any / 非空断言 ---------- */

function requireAt<T>(items: readonly T[], index: number, label: string): T {
  const item = items[index];
  if (item === undefined) throw new Error('[m2-acceptance] 缺少 ' + label + '[' + index + ']');
  return item;
}

function requireDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error('[m2-acceptance] 缺少 ' + label);
  return value;
}

function requireLinked(result: ProjectCompileResult): LinkedProject {
  const linked = result.build.linkedProject;
  if (linked === null) throw new Error('[m2-acceptance] 期望 LinkedProject 不为 null');
  return linked;
}

function requireTheater(result: ProjectCompileResult, index = 0): ProjectTheaterIR {
  return requireAt(result.build.projectIR.theaters, index, 'ProjectTheaterIR');
}

function requireResolution(theater: ProjectTheaterIR, label: string): TargetResolution {
  const resolution = theater.targetResolution;
  if (resolution === null) throw new Error('[m2-acceptance] 期望 targetResolution 不为 null：' + label);
  return resolution;
}

function diagnosticsOfKind(
  result: ProjectCompileResult,
  kind: ProjectDiagnosticKind,
): readonly ProjectDiagnostic[] {
  return result.build.diagnostics.filter((diagnostic) => diagnostic.kind === kind);
}

function singleDiagnosticOfKind(
  result: ProjectCompileResult,
  kind: ProjectDiagnosticKind,
): ProjectDiagnostic {
  const found = diagnosticsOfKind(result, kind);
  expect(found.length, '期望恰好一条 ' + kind + ' 诊断').toBe(1);
  return requireAt(found, 0, kind + ' 诊断');
}

describe('M2 验收矩阵（Contracts §13）', () => {
  it('基线：初见 + Host 完整上下文 → resolved / 分组 / 单 Theater ERB', () => {
    const result = compile([fileInput('/p/baseline.kojo2', theaterSource('【剧场：初见】', '你好'))]);

    expect(result.build.buildStatus).toBe('succeeded');
    expect(result.complete).toBe(true);
    expect(result.build.analysisStatus).toBe('complete');
    expect(result.backendDiagnostics).toEqual([]);

    const theater = requireTheater(result);
    const resolution = requireResolution(theater, '初见');
    expect(resolution.status).toBe('supported');
    expect(resolution.registrationStatus).toBe('registered');
    expect(resolution.canonicalId).toBe('eratw.event.初见');
    expect(resolution.functionName).toMatchObject({
      kind: 'resolved',
      name: 'M_KOJO_ENCOUNTER_K12',
      requiredContext: [],
    });
    expect(theater.linkStatus).toBe('grouped');

    const linked = requireLinked(result);
    expect(linked.groups).toHaveLength(1);
    expect(requireAt(linked.groups, 0, 'group').duplicate).toBe(false);
    expect(result.theaterErb).toHaveLength(1);
    expect(requireAt(result.theaterErb, 0, 'theaterErb').erb).toContain('@M_KOJO_ENCOUNTER_K12');
    expect(requireAt(result.theaterErb, 0, 'theaterErb').erb).toContain('CALL M_KOJO_ENCOUNTER_K12_1');
  });

  it('七个 unsupported 事件：unsupported + target-unsupported error + 不进 groups', () => {
    UNSUPPORTED_EVENTS.forEach((event, index) => {
      const descriptor = requireDefined(
        ERATW_TARGET_REGISTRY.targets.find((target) => target.surface === event),
        event + ' descriptor',
      );
      // 前置事实：Registry 里这七个确实是 unsupported（否则本用例测不到目标行为）。
      expect(descriptor.compileSupport, event).toBe('unsupported');

      const result = compile([
        fileInput('/p/unsupported-' + index + '.kojo2', theaterSource('【剧场：' + event + '】')),
      ]);

      const theater = requireTheater(result);
      const resolution = requireResolution(theater, event);
      expect(resolution.status, event).toBe('unsupported');
      expect(resolution.registrationStatus, event).toBe('registered');
      expect(resolution.functionName.kind, event).toBe('unsupported');
      expect(resolution.functionName.name, event).toBeNull();
      expect(resolution.descriptor?.callSignature, event).toBeNull();
      expect(theater.linkStatus, event).toBe('unsupported');

      // unknown/unsupported 一律不进 groups（Contracts §8 不变式 4）。
      expect(requireLinked(result).groups, event).toEqual([]);
      expect(result.build.buildStatus, event).toBe('failed');
      expect(result.theaterErb, event).toEqual([]);

      const diagnostic = singleDiagnosticOfKind(result, 'target-unsupported');
      expect(diagnostic.severity, event).toBe('error');
      expect(diagnostic.code, event).toBe('core/target/unsupported');
      expect(diagnostic.primary.fileId, event).toBe(requireTheater(result).fileId);
      // Contracts §7 不变式 3：message 必须带 unsupportedReason。
      const reason = descriptor.unsupportedReason;
      expect(reason, event).not.toBeNull();
      if (reason !== null) expect(diagnostic.message, event).toContain(reason);
    });
  });

  it('未登记目标：target-unknown error、registrationStatus unregistered、不进 groups', () => {
    const result = compile([fileInput('/p/unknown.kojo2', theaterSource('【剧场：不存在的剧场】'))]);

    const theater = requireTheater(result);
    const resolution = requireResolution(theater, 'unknown');
    expect(resolution.status).toBe('unknown');
    expect(resolution.registrationStatus).toBe('unregistered');
    expect(resolution.canonicalId).toBeNull();
    expect(resolution.descriptor).toBeNull();
    expect(theater.linkStatus).toBe('unknown');
    expect(requireLinked(result).groups).toEqual([]);
    expect(result.build.buildStatus).toBe('failed');
    expect(result.theaterErb).toEqual([]);

    const diagnostic = singleDiagnosticOfKind(result, 'target-unknown');
    expect(diagnostic.severity).toBe('error');
    expect(diagnostic.code).toBe('core/target/unknown');
    // Contracts §7 不变式 3：必须列出可用 target。
    expect(diagnostic.message).toContain('初见');
    expect(diagnostic.message).toContain('指令');
  });

  it('缺 charNo：function-name-context-missing、requiredContext 指明 charNo、build failed', () => {
    const result = compile([
      fileInput('/p/no-charno.kojo2', theaterSource('【剧场：初见】'), { familySegment: '' }),
    ]);

    const theater = requireTheater(result);
    const resolution = requireResolution(theater, '缺 charNo');
    expect(resolution.status).toBe('needs-context');
    expect(resolution.functionName.kind).toBe('needs-context');
    expect(resolution.functionName.name).toBeNull();
    expect(resolution.functionName.requiredContext).toEqual(['charNo']);
    // groups 只收 resolution.status === 'supported'（linker.ts:262），
    // 因此 needs-context 的 linkStatus 保持真实值，不被改写成 'grouped'。
    expect(theater.linkStatus).toBe('needs-context');
    expect(requireLinked(result).groups).toEqual([]);
    // 事实视图不丢：实例仍在 linkedProject.theaters 里，但没有可用函数名。
    const linkedTheaters = requireLinked(result).theaters;
    expect(linkedTheaters).toHaveLength(1);
    expect(requireAt(linkedTheaters, 0, 'linked theater').theaterId).toBe(theater.theaterId);
    expect(requireAt(linkedTheaters, 0, 'linked theater').engineFunctionName.name).toBeNull();
    expect(result.build.buildStatus).toBe('failed');
    expect(result.theaterErb).toEqual([]);

    const diagnostic = singleDiagnosticOfKind(result, 'function-name-context-missing');
    expect(diagnostic.severity).toBe('error');
    expect(diagnostic.code).toBe('core/target/function-name-context-missing');
    expect(diagnostic.message).toContain('charNo');
    // 缺上下文不得把全局 supported 状态降级（Contracts D9）。
    expect(resolution.descriptor?.compileSupport).toBe('supported');
  });

  it('familySegment：缺席是 needs-context（不补空串）；显式空串是 resolved', () => {
    const missing = compile([
      fileInput('/p/no-family.kojo2', theaterSource('【剧场：初见】'), { charNo: '12' }),
    ]);
    const missingResolution = requireResolution(requireTheater(missing), '缺 familySegment');
    expect(missingResolution.status).toBe('needs-context');
    expect(missingResolution.functionName.kind).toBe('needs-context');
    expect(missingResolution.functionName.name).toBeNull();
    expect(missingResolution.functionName.requiredContext).toEqual(['familySegment']);
    expect(missing.build.buildStatus).toBe('failed');
    expect(missing.theaterErb).toEqual([]);
    expect(singleDiagnosticOfKind(missing, 'function-name-context-missing').message).toContain(
      'familySegment',
    );

    const explicit = compile([
      fileInput('/p/empty-family.kojo2', theaterSource('【剧场：初见】'), {
        charNo: '12',
        familySegment: '',
      }),
    ]);
    const resolved = requireResolution(requireTheater(explicit), '显式空 familySegment');
    expect(resolved.status).toBe('supported');
    expect(resolved.functionName).toMatchObject({ kind: 'resolved', name: 'M_KOJO_ENCOUNTER_K12' });
    expect(explicit.build.buildStatus).toBe('succeeded');
    expect(explicit.theaterErb).toHaveLength(1);
    // 空串必须逐字求值成空串：不得冒出 `_` 或任何替代段。
    expect(requireAt(explicit.theaterErb, 0, 'theaterErb').erb).toContain('@M_KOJO_ENCOUNTER_K12');
  });

  it('charNo 非法（空串 / 非数字）：invalid-context、function-name-context-invalid', () => {
    for (const badCharNo of ['', 'ab']) {
      const result = compile([
        fileInput('/p/bad-charno.kojo2', theaterSource('【剧场：初见】'), {
          charNo: badCharNo,
          familySegment: '',
        }),
      ]);

      const resolution = requireResolution(requireTheater(result), 'charNo=' + JSON.stringify(badCharNo));
      expect(resolution.status, JSON.stringify(badCharNo)).toBe('invalid-context');
      expect(resolution.functionName.kind).toBe('invalid-context');
      expect(resolution.functionName.name).toBeNull();
      expect(resolution.functionName.requiredContext).toEqual([]);
      expect(requireTheater(result).linkStatus).toBe('invalid-context');
      expect(requireLinked(result).groups).toEqual([]);
      const linkedTheaters = requireLinked(result).theaters;
      expect(linkedTheaters).toHaveLength(1);
      expect(requireAt(linkedTheaters, 0, 'linked theater').engineFunctionName.kind).toBe(
        'invalid-context',
      );
      expect(result.build.buildStatus).toBe('failed');
      expect(result.theaterErb).toEqual([]);

      const diagnostic = singleDiagnosticOfKind(result, 'function-name-context-invalid');
      expect(diagnostic.severity).toBe('error');
      expect(diagnostic.code).toBe('core/target/function-name-context-invalid');
      expect(diagnostic.message).toContain('charNo');
    }
  });

  it('exact duplicate：同五字段跨文件 → duplicate-theater primary/related + group.duplicate=true', () => {
    const first = fileInput('/p/dup-a.kojo2', theaterSource('【剧场：初见】', '甲'));
    const second = fileInput('/p/dup-b.kojo2', theaterSource('【剧场：初见】', '乙'));
    const result = compile([first, second]);

    expect(result.build.buildStatus).toBe('failed');
    expect(result.theaterErb).toEqual([]);
    expect(result.build.projectIR.theaters).toHaveLength(2);
    expect(result.build.projectIR.theaters.every((theater) => theater.linkStatus === 'duplicate')).toBe(
      true,
    );

    const linked = requireLinked(result);
    expect(linked.theaters).toHaveLength(2);
    const group = requireAt(linked.groups, 0, 'group');
    expect(linked.groups).toHaveLength(1);
    expect(group.canonicalId).toBe('eratw.event.初见');
    expect(group.duplicate).toBe(true);
    expect(group.theaters).toHaveLength(2);

    const diagnostic = singleDiagnosticOfKind(result, 'duplicate-theater');
    expect(diagnostic.severity).toBe('error');
    expect(diagnostic.code).toBe('core/target/duplicate-theater');
    expect(diagnostic.primary.role).toBe('conflict');
    expect(diagnostic.related).toHaveLength(1);
    const related = requireAt(diagnostic.related, 0, 'duplicate related');
    expect(related.role).toBe('conflict');
    // primary 与 related 必须各指一份文件，且正好覆盖两份输入文件。
    expect(diagnostic.primary.fileId).not.toBe(related.fileId);
    expect([diagnostic.primary.fileId, related.fileId].sort()).toEqual(
      [first.identity.fileId, second.identity.fileId].sort(),
    );
  });

  it('同 canonical 不同 location/time：只有一个候选 group，duplicate=false，无 duplicate 诊断', () => {
    const result = compile([
      fileInput('/p/shrine.kojo2', theaterSource('【剧场：初见｜神社｜夜晚】', '甲')),
      fileInput('/p/school.kojo2', theaterSource('【剧场：初见｜学校】', '乙')),
    ]);

    const linked = requireLinked(result);
    expect(linked.groups).toHaveLength(1);
    const group = requireAt(linked.groups, 0, 'group');
    expect(group.canonicalId).toBe('eratw.event.初见');
    expect(group.theaters).toHaveLength(2);
    expect(group.duplicate).toBe(false);
    expect(linked.theaters).toHaveLength(2);
    expect(diagnosticsOfKind(result, 'duplicate-theater')).toEqual([]);
    expect(result.build.buildStatus).toBe('succeeded');
    expect(result.complete).toBe(true);
    expect(result.theaterErb).toHaveLength(2);
  });

  it('文件输入置换：派生事实逐条相同（ProjectIR.files 仍保留输入序）', () => {
    const shrine = fileInput('/p/perm-a.kojo2', theaterSource('【剧场：初见｜神社】', '甲'));
    const school = fileInput('/p/perm-b.kojo2', theaterSource('【剧场：初见｜学校】', '乙'));
    const shrineTwin = fileInput('/p/perm-c.kojo2', theaterSource('【剧场：初见｜神社】', '丙'));

    const permutations: readonly (readonly ProjectCompileFileInput[])[] = [
      [shrine, school, shrineTwin],
      [shrineTwin, shrine, school],
      [school, shrineTwin, shrine],
    ];

    const snapshots = permutations.map((files) => orderingSnapshot(compile(files)));
    const baseline = requireAt(snapshots, 0, 'snapshot');
    for (let index = 1; index < snapshots.length; index++) {
      expect(requireAt(snapshots, index, 'snapshot'), 'permutation ' + index).toEqual(baseline);
    }
    // 同一组事实必须真的覆盖到分组 + 重复诊断 + 两个 canonical 组之外的空 ERB 判定。
    expect(baseline.diagnosticKinds).toEqual(['duplicate-theater']);
    expect(baseline.groups).toEqual(['eratw.event.初见|duplicate=true|3']);
    expect(baseline.theaters).toHaveLength(3);
    expect(baseline.erbTheaterIds).toEqual([]);

    // ProjectIR.files 是源事实序，允许随输入置换变化——正因为如此，上面的派生快照才必须稳定。
    const fileOrderA = compile(permutations[0] ?? []).build.projectIR.files.map((file) => file.fileId);
    const fileOrderB = compile(permutations[1] ?? []).build.projectIR.files.map((file) => file.fileId);
    expect(fileOrderA).not.toEqual(fileOrderB);
    expect(fileOrderA).toHaveLength(3);
    expect(fileOrderB).toHaveLength(3);

    // 无 duplicate 的成功项目里，ERB 顺序同样不得依赖输入顺序。
    const okA = orderingSnapshot(
      compile([
        fileInput('/p/ok-b.kojo2', theaterSource('【剧场：初见｜学校】', '乙')),
        fileInput('/p/ok-a.kojo2', theaterSource('【剧场：初见｜神社】', '甲')),
      ]),
    );
    const okB = orderingSnapshot(
      compile([
        fileInput('/p/ok-a.kojo2', theaterSource('【剧场：初见｜神社】', '甲')),
        fileInput('/p/ok-b.kojo2', theaterSource('【剧场：初见｜学校】', '乙')),
      ]),
    );
    expect(okA).toEqual(okB);
    expect(okA.erbTheaterIds).toHaveLength(2);
  });

  it('Registry 版本不匹配：targetResolution=null、linkStatus=version-mismatch、build failed', () => {
    const result = compile(
      [fileInput('/p/version.kojo2', theaterSource('【剧场：初见】'))],
      { targetRegistryVersion: '0' },
    );

    const theater = requireTheater(result);
    expect(theater.targetResolution).toBeNull();
    expect(theater.linkStatus).toBe('version-mismatch');
    expect(requireLinked(result).theaters).toEqual([]);
    expect(requireLinked(result).groups).toEqual([]);
    expect(result.build.buildStatus).toBe('failed');
    expect(result.theaterErb).toEqual([]);

    const diagnostic = singleDiagnosticOfKind(result, 'version-mismatch');
    expect(diagnostic.severity).toBe('error');
    expect(diagnostic.code).toBe('core/target/version-mismatch');
    expect(diagnostic.primary.role).toBe('project');
    // 不得静默回落：诊断里必须同时出现 IR 与当前 Registry 的版本事实。
    expect(diagnostic.message).toContain('0');
    expect(diagnostic.message).toContain(ERATW_TARGET_REGISTRY.version);
  });

  it('项目失败时不发布部分产物：可编译文件 + unsupported 文件 → theaterErb 为空', () => {
    const compilable = fileInput('/p/mixed-ok.kojo2', theaterSource('【剧场：初见】', '甲'));
    const unsupported = fileInput(
      '/p/mixed-unsupported.kojo2',
      theaterSource('【剧场：训练】', '乙'),
    );
    const result = compile([compilable, unsupported]);

    // 前置事实：单独编译第一份文件是能出 ERB 的（否则"空"没有意义）。
    const alone = compile([compilable]);
    expect(alone.theaterErb).toHaveLength(1);
    expect(alone.build.buildStatus).toBe('succeeded');

    expect(result.build.buildStatus).toBe('failed');
    expect(result.complete).toBe(false);
    expect(result.theaterErb).toEqual([]);
    expect(result.backendDiagnostics).toEqual([]);
    expect(diagnosticsOfKind(result, 'target-unsupported')).toHaveLength(1);
    // 失败时仍保留完整事实视图：两份 Theater 都在 IR 里，一份 grouped、一份 unsupported。
    expect(result.build.projectIR.theaters).toHaveLength(2);
    expect(result.build.projectIR.theaters.map((theater) => theater.linkStatus).sort()).toEqual([
      'grouped',
      'unsupported',
    ]);
  });
});

interface OrderingSnapshot {
  readonly diagnosticKinds: readonly string[];
  readonly diagnosticLocations: readonly string[];
  readonly groups: readonly string[];
  readonly theaters: readonly string[];
  readonly erbTheaterIds: readonly string[];
}

/** 派生事实的确定性快照：不含 ProjectIR.files / 输入枚举顺序。 */
function orderingSnapshot(result: ProjectCompileResult): OrderingSnapshot {
  const linked = requireLinked(result);
  return {
    diagnosticKinds: result.build.diagnostics.map((diagnostic) => diagnostic.kind),
    diagnosticLocations: result.build.diagnostics.map(
      (diagnostic) =>
        diagnostic.kind +
        '@' +
        diagnostic.primary.fileId +
        '<-' +
        diagnostic.related.map((location) => location.fileId).join(','),
    ),
    groups: linked.groups.map(
      (group) =>
        group.canonicalId + '|duplicate=' + String(group.duplicate) + '|' + String(group.theaters.length),
    ),
    theaters: linked.theaters.map((theater) => theater.theaterId),
    erbTheaterIds: result.theaterErb.map((entry) => entry.theaterId),
  };
}