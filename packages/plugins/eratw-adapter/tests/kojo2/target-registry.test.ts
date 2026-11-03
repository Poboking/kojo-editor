import { describe, expect, it } from 'vitest';
import {
  ERATW_EVENT_CATALOG,
} from '../../src/kojo2/event-catalog.js';
import {
  ERATW_TARGET_REGISTRY,
} from '../../src/kojo2/target-registry.js';
import {
  resolveFunctionName,
  resolveTarget,
  validateTargetRegistry,
  type TargetDescriptor,
} from '@kojo/kojo-core';
import type { ProjectLocation } from '@kojo/kojo-core';

const LOCATION: ProjectLocation = {
  fileId: 'file:test',
  path: '/p/a.kojo2',
  span: null,
  role: 'definition',
};

function descriptorOf(surface: string): TargetDescriptor {
  const descriptor = ERATW_TARGET_REGISTRY.targets.find((target) => target.surface === surface);
  if (descriptor === undefined) throw new Error(`missing descriptor ${surface}`);
  return descriptor;
}

function validationIssuesFor(descriptor: TargetDescriptor) {
  return validateTargetRegistry(
    {
      ...ERATW_TARGET_REGISTRY,
      targets: ERATW_TARGET_REGISTRY.targets.map((target) =>
        target.canonicalId === descriptor.canonicalId ? descriptor : target,
      ),
    },
    ERATW_EVENT_CATALOG,
  );
}

describe('eraTW TargetRegistry', () => {
  it('九个 eventCatalog 事件全部登记，只有初见/指令 supported', () => {
    expect(validateTargetRegistry(ERATW_TARGET_REGISTRY, ERATW_EVENT_CATALOG)).toEqual([]);
    expect(ERATW_TARGET_REGISTRY.targets).toHaveLength(9);
    expect(ERATW_TARGET_REGISTRY.targets.filter((target) => target.compileSupport === 'supported').map((target) => target.surface)).toEqual([
      '初见',
      '指令',
    ]);
    for (const target of ERATW_TARGET_REGISTRY.targets) {
      if (target.compileSupport === 'unsupported') {
        expect(target.functionName).toBeNull();
        expect(target.callSignature).toBeNull();
        expect(target.runtimeProtocol).toBeNull();
        expect(target.unsupportedReason).not.toBeNull();
      } else {
        expect(target.functionName).not.toBeNull();
        expect(target.callSignature).not.toBeNull();
        expect(target.runtimeProtocol).not.toBeNull();
      }
    }
  });

  it('初见：显式空 familySegment 合法，缺席是 needs-context 而不是自动补空串', () => {
    const descriptor = descriptorOf('初见');
    const resolved = resolveFunctionName({
      descriptor,
      context: { familySegment: '', charNo: '12' },
      sourceArgs: { index: null, indexOrigin: 'none', span: null },
    });
    expect(resolved).toMatchObject({ kind: 'resolved', name: 'M_KOJO_ENCOUNTER_K12', requiredContext: [] });

    const missing = resolveFunctionName({
      descriptor,
      context: { charNo: '12' },
      sourceArgs: { index: null, indexOrigin: 'none', span: null },
    });
    expect(missing.kind).toBe('needs-context');
    expect(missing.requiredContext).toContain('familySegment');
    expect(missing.name).toBeNull();
  });

  it('指令：legacy args[0] 才能补 i；显式 Theater 缺 i 是 needs-context', () => {
    const descriptor = descriptorOf('指令');
    const fromMachine = resolveFunctionName({
      descriptor,
      context: { familySegment: '', charNo: '12' },
      sourceArgs: { index: '310', indexOrigin: 'machine-args', span: null },
    });
    expect(fromMachine).toMatchObject({
      kind: 'resolved',
      name: 'M_KOJO_MESSAGE_COM_K12_310',
    });

    const fromTheater = resolveFunctionName({
      descriptor,
      context: { familySegment: '', charNo: '12' },
      sourceArgs: { index: null, indexOrigin: 'none', span: null },
    });
    expect(fromTheater).toMatchObject({ kind: 'needs-context', name: null });
    expect(fromTheater.requiredContext).toContain('index');
    const resolution = resolveTarget({
      registry: ERATW_TARGET_REGISTRY,
      rawTarget: '指令',
      context: { familySegment: '', charNo: '12' },
      sourceArgs: { index: null, indexOrigin: 'none', span: null },
      location: LOCATION,
    });
    expect(resolution.status).toBe('needs-context');
    expect(resolution.diagnostics[0]?.kind).toBe('function-name-context-missing');
  });

  it('unknown / unsupported 分别产生 target-unknown / target-unsupported', () => {
    const unknown = resolveTarget({
      registry: ERATW_TARGET_REGISTRY,
      rawTarget: '不存在',
      context: { familySegment: '', charNo: '12' },
      sourceArgs: { index: null, indexOrigin: 'none', span: null },
      location: LOCATION,
    });
    expect(unknown.status).toBe('unknown');
    expect(unknown.diagnostics[0]?.kind).toBe('target-unknown');

    const unsupported = resolveTarget({
      registry: ERATW_TARGET_REGISTRY,
      rawTarget: '训练',
      context: { familySegment: '', charNo: '12' },
      sourceArgs: { index: null, indexOrigin: 'none', span: null },
      location: LOCATION,
    });
    expect(unsupported.status).toBe('unsupported');
    expect(unsupported.diagnostics[0]?.kind).toBe('target-unsupported');
    expect(unsupported.diagnostics[0]?.message).toContain('只支持');
  });

  it('charNo 非法是 invalid-context；com 缺显式默认是 registry-binding', () => {
    const encounter = descriptorOf('初见');
    const invalid = resolveFunctionName({
      descriptor: encounter,
      context: { familySegment: '', charNo: '' },
      sourceArgs: { index: null, indexOrigin: 'none', span: null },
    });
    expect(invalid.kind).toBe('invalid-context');
    expect(invalid.name).toBeNull();

    const command = descriptorOf('指令');
    const broken: TargetDescriptor = { ...command, segmentDefaults: {} };
    const unresolved = resolveFunctionName({
      descriptor: broken,
      context: { familySegment: '', charNo: '12' },
      sourceArgs: { index: '310', indexOrigin: 'machine-args', span: null },
    });
    expect(unresolved.kind).toBe('unresolved');
    expect(unresolved.reason).toContain('registry-binding');

    const issues = validationIssuesFor(broken);
    expect(issues.some((issue) => issue.message.includes('com'))).toBe(true);
  });

  it('拒绝违反 D7/D8 的参数规则 source / adapterMayDeclareDefault', () => {
    const command = descriptorOf('指令');

    const badSegmentSource: TargetDescriptor = {
      ...command,
      parameterRules: command.parameterRules.map((rule) =>
        rule.token === 'segment' ? { ...rule, source: 'host-file' as const } : rule,
      ),
    };
    expect(
      validationIssuesFor(badSegmentSource).some(
        (issue) => issue.message.includes('source') && issue.message.includes('adapter-rule'),
      ),
    ).toBe(true);

    const badHostDefault: TargetDescriptor = {
      ...command,
      parameterRules: command.parameterRules.map((rule) =>
        rule.token === 'n' ? { ...rule, adapterMayDeclareDefault: true } : rule,
      ),
    };
    expect(
      validationIssuesFor(badHostDefault).some((issue) =>
        issue.message.includes('adapterMayDeclareDefault'),
      ),
    ).toBe(true);

    for (const [token, source] of [
      ['t', 'adapter-rule'],
      ['i', 'host-file'],
    ] as const) {
      const badSource: TargetDescriptor = {
        ...command,
        parameterRules: command.parameterRules.map((rule) =>
          rule.token === token ? { ...rule, source } : rule,
        ),
      };
      expect(
        validationIssuesFor(badSource).some(
          (issue) => issue.message.includes(`{${token}}`) && issue.message.includes('source'),
        ),
        token,
      ).toBe(true);
    }
  });

  it('拒绝模板外或空值的 segmentDefaults', () => {
    const command = descriptorOf('指令');

    const extraDefault: TargetDescriptor = {
      ...command,
      segmentDefaults: { ...command.segmentDefaults, ghost: 'GHOST' },
    };
    const extraIssues = validationIssuesFor(extraDefault);
    expect(
      extraIssues.some(
        (issue) => issue.message.includes('segmentDefaults') && issue.message.includes('ghost'),
      ),
    ).toBe(true);

    const emptyDefault: TargetDescriptor = {
      ...command,
      segmentDefaults: { ...command.segmentDefaults, com: '' },
    };
    const emptyIssues = validationIssuesFor(emptyDefault);
    expect(
      emptyIssues.some((issue) => issue.message.includes('com') && issue.message.includes('不能为空')),
    ).toBe(true);
  });

  it('拒绝 supported target 的 sourceArgs 与 eventCatalog 不一致', () => {
    const command = descriptorOf('指令');
    const mismatchedName: TargetDescriptor = {
      ...command,
      sourceArgs: [{ name: '其他编号', kind: 'int', required: false }],
    };
    expect(
      validationIssuesFor(mismatchedName).some((issue) => issue.message.includes('sourceArgs')),
    ).toBe(true);

    const mismatchedKind: TargetDescriptor = {
      ...command,
      sourceArgs: [{ name: '编号', kind: 'string', required: false }],
    };
    expect(
      validationIssuesFor(mismatchedKind).some((issue) => issue.message.includes('sourceArgs')),
    ).toBe(true);

    const mismatchedRequired: TargetDescriptor = {
      ...command,
      sourceArgs: [{ name: '编号', kind: 'int', required: true }],
    };
    expect(
      validationIssuesFor(mismatchedRequired).some((issue) => issue.message.includes('sourceArgs')),
    ).toBe(true);

    const mismatchedLength: TargetDescriptor = { ...command, sourceArgs: [] };
    expect(
      validationIssuesFor(mismatchedLength).some((issue) => issue.message.includes('sourceArgs')),
    ).toBe(true);
  });

  it('supported 缺编译描述、unsupported 携带运行时描述都必须拒绝', () => {
    const command = descriptorOf('指令');
    const missingCallSignature: TargetDescriptor = { ...command, callSignature: null };
    expect(
      validationIssuesFor(missingCallSignature).some((issue) =>
        issue.message.includes('缺少 callSignature'),
      ),
    ).toBe(true);

    const unsupported = descriptorOf('训练');
    const unsupportedWithProtocol: TargetDescriptor = {
      ...unsupported,
      runtimeProtocol: command.runtimeProtocol,
    };
    expect(
      validationIssuesFor(unsupportedWithProtocol).some((issue) =>
        issue.message.includes('functionName/callSignature/runtimeProtocol 必须为 null'),
      ),
    ).toBe(true);
  });
});