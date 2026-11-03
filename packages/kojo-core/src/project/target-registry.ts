/**
 * M2 TargetRegistry 契约与纯解析算法（P2/P3）。
 *
 * 本模块只做三件事：
 * 1. 定义 TargetDescriptor / TargetRegistry / TargetResolution 的纯数据形状；
 * 2. 装载期校验（九事件全覆盖、canonical/surface 唯一、supported 描述完整）；
 * 3. 用显式参数规则解析函数名，区分 supported / needs-context / invalid-context /
 *    unsupported / unknown，绝不靠缺省值或 raw 猜参数。
 *
 * 游戏名词与具体模板只住 adapter；本模块不 import 任何 adapter。
 */
import type { EventCatalog } from '../adapter.js';
import type { KojoSpan } from '../ast.js';
import type { ProjectDiagnostic, ProjectLocation } from './ir.js';

export type TargetRegistrationStatus = 'registered' | 'unregistered';
export type TargetCompileSupport = 'supported' | 'unsupported';

export interface FunctionNameTemplate {
  readonly template: string;
  readonly requiredSegments: readonly string[];
}

export type FunctionNameResolutionKind =
  | 'resolved'
  | 'needs-context'
  | 'invalid-context'
  | 'unresolved'
  | 'unsupported';

export type FunctionNameContextKey = 'charNo' | 'familySegment' | 'index';

export interface FunctionNameResolution {
  readonly kind: FunctionNameResolutionKind;
  readonly name: string | null;
  readonly requiredContext: readonly FunctionNameContextKey[];
  readonly reason: string | null;
}

export type FunctionNameParameterSource = 'host-file' | 'adapter-rule' | 'core-derived';
export type FunctionNameParameterToken = 't' | 'n' | 'i' | 'segment';

export interface FunctionNameParameterRule {
  readonly token: FunctionNameParameterToken;
  readonly segmentName: string | null;
  readonly source: FunctionNameParameterSource;
  readonly required: boolean;
  readonly allowExplicitEmpty: boolean;
  readonly adapterMayDeclareDefault: boolean;
  readonly valueKind: 'family-segment' | 'char-no' | 'segment' | 'index';
  readonly valuePattern: string | null;
}

export interface FunctionNameRequest {
  readonly descriptor: TargetDescriptor;
  readonly context: import('./ir.js').FunctionNameContext;
  readonly sourceArgs: import('./ir.js').FunctionNameSourceArgs;
}

export interface CallSignature {
  readonly sourceArgs: readonly import('../adapter.js').EventArgumentSpec[];
  readonly wrapperFormals: readonly string[];
  readonly companionFormals: readonly string[];
  readonly returnProtocol: 'RETURN RESULT' | 'RETURN 1' | 'none';
  readonly localPolicy: 'LOCAL_1_IF_BODY' | 'LOCAL_0_EMPTY' | 'none';
}

export interface RuntimeProtocolDescriptor {
  readonly protocolId: string;
  readonly version: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface TargetDescriptor {
  readonly registrationStatus: 'registered';
  readonly compileSupport: TargetCompileSupport;
  readonly canonicalId: string;
  readonly surface: string;
  readonly aliases: readonly string[];
  readonly eventBinding: string;
  readonly sourceArgs: readonly import('../adapter.js').EventArgumentSpec[];
  readonly unsupportedReason: string | null;
  readonly functionName: FunctionNameTemplate | null;
  readonly callSignature: CallSignature | null;
  readonly runtimeProtocol: RuntimeProtocolDescriptor | null;
  readonly parameterRules: readonly FunctionNameParameterRule[];
  readonly segmentDefaults: Readonly<Record<string, string>>;
}

export interface TargetRegistry {
  readonly registryId: string;
  readonly version: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly targets: readonly TargetDescriptor[];
}

export interface TargetResolution {
  readonly registrationStatus: TargetRegistrationStatus;
  readonly status: 'supported' | 'unsupported' | 'unknown' | 'needs-context' | 'invalid-context';
  readonly rawTarget: string;
  readonly canonicalId: string | null;
  readonly descriptor: TargetDescriptor | null;
  readonly functionName: FunctionNameResolution;
  readonly diagnostics: readonly ProjectDiagnostic[];
}

export interface TargetRegistryValidationIssue {
  readonly code: 'registry-binding';
  readonly message: string;
  readonly canonicalId: string | null;
}

export interface TargetResolutionRequest {
  readonly registry: TargetRegistry;
  readonly rawTarget: string;
  readonly context: import('./ir.js').FunctionNameContext;
  readonly sourceArgs: import('./ir.js').FunctionNameSourceArgs;
  readonly location: ProjectLocation;
}

/* ============================== 小工具 ============================== */

const PARAMETER_ORDER: readonly FunctionNameContextKey[] = ['charNo', 'familySegment', 'index'];
const SIMPLE_TOKENS: readonly ('t' | 'n' | 'i')[] = ['t', 'n', 'i'];

function projectDiagnostic(
  kind: ProjectDiagnostic['kind'],
  code: string,
  message: string,
  primary: ProjectLocation,
): ProjectDiagnostic {
  return { kind, code, severity: 'error', message, primary, related: [] };
}

function tokenPattern(token: 't' | 'n' | 'i'): RegExp {
  return new RegExp(`\\{${token}\\}`, 'g');
}

function segmentNamesOf(template: string): readonly string[] {
  const names: string[] = [];
  const pattern = /\$\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template)) !== null) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

function simpleTokensOf(template: string): readonly ('t' | 'n' | 'i')[] {
  return SIMPLE_TOKENS.filter((token) => new RegExp(`\\{${token}\\}`).test(template));
}

function isRuleFor(rule: FunctionNameParameterRule, token: FunctionNameParameterToken, segmentName: string | null): boolean {
  return rule.token === token && rule.segmentName === segmentName;
}

function missingContextOrder(values: readonly FunctionNameContextKey[]): readonly FunctionNameContextKey[] {
  return PARAMETER_ORDER.filter((key) => values.includes(key));
}

function valueMatches(value: string, pattern: string | null): boolean {
  if (pattern === null) return true;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

function emptyValueAccepted(rule: FunctionNameParameterRule): boolean {
  return rule.allowExplicitEmpty;
}

/** 解析函数名；缺 context 与非法 context 必须可区分，且不回落空串/首键/默认编号。 */
export function resolveFunctionName(request: FunctionNameRequest): FunctionNameResolution {
  const descriptor = request.descriptor;
  if (descriptor.compileSupport === 'unsupported') {
    return { kind: 'unsupported', name: null, requiredContext: [], reason: descriptor.unsupportedReason };
  }
  const template = descriptor.functionName;
  if (template === null) {
    return { kind: 'unresolved', name: null, requiredContext: [], reason: '目标描述缺少函数名模板' };
  }

  const replacements = new Map<string, string>();
  const missing: FunctionNameContextKey[] = [];
  const invalid: string[] = [];

  for (const token of simpleTokensOf(template.template)) {
    const rule = descriptor.parameterRules.find((candidate) => isRuleFor(candidate, token, null));
    if (rule === undefined) {
      return {
        kind: 'unresolved',
        name: null,
        requiredContext: [],
        reason: `函数名模板含 {${token}}，但 TargetDescriptor 没有对应参数规则`,
      };
    }

    let value: string | null | undefined;
    if (token === 't') value = request.context.familySegment;
    else if (token === 'n') value = request.context.charNo;
    else value = request.sourceArgs.index;

    const contextKey: FunctionNameContextKey = token === 't' ? 'familySegment' : token === 'n' ? 'charNo' : 'index';
    if (value === null || value === undefined) {
      missing.push(contextKey);
      continue;
    }
    if (value.length === 0 && !emptyValueAccepted(rule)) {
      invalid.push(`${contextKey} 不能为空`);
      continue;
    }
    if (!valueMatches(value, rule.valuePattern)) {
      invalid.push(`${contextKey} 不匹配 ${rule.valuePattern ?? '声明的形态'}`);
      continue;
    }
    replacements.set(`{${token}}`, value);
  }

  for (const segmentName of segmentNamesOf(template.template)) {
    const rule = descriptor.parameterRules.find((candidate) => isRuleFor(candidate, 'segment', segmentName));
    if (rule === undefined) {
      return {
        kind: 'unresolved',
        name: null,
        requiredContext: [],
        reason: `函数名模板含 \${${segmentName}}，但 TargetDescriptor 没有对应参数规则`,
      };
    }
    const value = descriptor.segmentDefaults[segmentName];
    if (value === undefined) {
      return {
        kind: 'unresolved',
        name: null,
        requiredContext: [],
        reason: `段 ${segmentName} 没有 Adapter 显式默认值（registry-binding）`,
      };
    }
    if (value.length === 0 && !emptyValueAccepted(rule)) {
      invalid.push(`段 ${segmentName} 不能为空`);
      continue;
    }
    if (!valueMatches(value, rule.valuePattern)) {
      invalid.push(`段 ${segmentName} 不匹配 ${rule.valuePattern ?? '声明的形态'}`);
      continue;
    }
    replacements.set(`\${${segmentName}}`, value);
  }

  if (missing.length > 0) {
    const ordered = missingContextOrder(missing);
    return {
      kind: 'needs-context',
      name: null,
      requiredContext: ordered,
      reason: `缺少函数名上下文：${ordered.join(', ')}`,
    };
  }
  if (invalid.length > 0) {
    return {
      kind: 'invalid-context',
      name: null,
      requiredContext: [],
      reason: `函数名上下文非法：${invalid.join('；')}`,
    };
  }

  let name = template.template;
  for (const [placeholder, value] of replacements) name = name.split(placeholder).join(value);
  if (/\{[tni]\}|\$\{[^}]+\}/.test(name)) {
    return { kind: 'unresolved', name: null, requiredContext: [], reason: '函数名模板求值后仍有未声明占位符' };
  }
  return { kind: 'resolved', name, requiredContext: [], reason: null };
}

/* ============================== 注册表校验 ============================== */

function ruleCoversToken(descriptor: TargetDescriptor, token: 't' | 'n' | 'i'): boolean {
  return descriptor.parameterRules.some((rule) => rule.token === token && rule.segmentName === null);
}

function ruleCoversSegment(descriptor: TargetDescriptor, name: string): boolean {
  return descriptor.parameterRules.some((rule) => rule.token === 'segment' && rule.segmentName === name);
}

const SIMPLE_RULE_SOURCE: Readonly<Record<'t' | 'n' | 'i', FunctionNameParameterSource>> = {
  t: 'host-file',
  n: 'host-file',
  i: 'core-derived',
};

const SIMPLE_RULE_VALUE_KIND: Readonly<Record<'t' | 'n' | 'i', FunctionNameParameterRule['valueKind']>> = {
  t: 'family-segment',
  n: 'char-no',
  i: 'index',
};

/** D7/D8：参数来源与默认值权限必须由参数规则本身显式声明。 */
function validateParameterRuleShape(
  canonicalId: string,
  rule: FunctionNameParameterRule,
  push: (canonicalId: string | null, message: string) => void,
): void {
  if (rule.token === 'segment') {
    const label = rule.segmentName === null || rule.segmentName.length === 0 ? '<未命名>' : `\${${rule.segmentName}}`;
    if (rule.segmentName === null || rule.segmentName.length === 0) {
      push(canonicalId, 'segment 参数规则必须给非空 segmentName');
    }
    if (rule.source !== 'adapter-rule') {
      push(canonicalId, `segment 参数规则 ${label} 的 source 必须为 adapter-rule`);
    }
    if (!rule.adapterMayDeclareDefault) {
      push(canonicalId, `segment 参数规则 ${label} 的 adapterMayDeclareDefault 必须为 true`);
    }
    if (rule.valueKind !== 'segment') {
      push(canonicalId, `segment 参数规则 ${label} 的 valueKind 必须为 segment`);
    }
    return;
  }

  const label = `{${rule.token}}`;
  const expectedSource = SIMPLE_RULE_SOURCE[rule.token];
  const expectedValueKind = SIMPLE_RULE_VALUE_KIND[rule.token];
  if (rule.segmentName !== null) {
    push(canonicalId, `参数规则 ${label} 的 segmentName 必须为 null`);
  }
  if (rule.source !== expectedSource) {
    push(canonicalId, `参数规则 ${label} 的 source 必须为 ${expectedSource}`);
  }
  if (rule.adapterMayDeclareDefault) {
    push(canonicalId, `参数规则 ${label} 的 adapterMayDeclareDefault 必须为 false`);
  }
  if (rule.valueKind !== expectedValueKind) {
    push(canonicalId, `参数规则 ${label} 的 valueKind 必须为 ${expectedValueKind}`);
  }
}

function eventArgsMatch(
  actual: readonly import('../adapter.js').EventArgumentSpec[],
  expected: readonly import('../adapter.js').EventArgumentSpec[],
): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((arg, index) => {
    const expectedArg = expected[index];
    return (
      expectedArg !== undefined &&
      arg.name === expectedArg.name &&
      arg.kind === expectedArg.kind &&
      arg.required === expectedArg.required
    );
  });
}

/** 装载期校验；返回问题列表，空数组 = 合法。调用方必须 fail-closed，不能取第一条。 */
export function validateTargetRegistry(
  registry: TargetRegistry,
  eventCatalog: EventCatalog,
): readonly TargetRegistryValidationIssue[] {
  const issues: TargetRegistryValidationIssue[] = [];
  const push = (canonicalId: string | null, message: string): void => {
    issues.push({ code: 'registry-binding', message, canonicalId });
  };

  if (registry.targets.length === 0) push(null, 'TargetRegistry 不能为空');

  const canonicalIds = new Set<string>();
  const surfaces = new Map<string, string | null>();
  const catalogEvents = new Map(eventCatalog.events.map((event) => [event.event, event] as const));

  for (const descriptor of registry.targets) {
    if (descriptor.registrationStatus !== 'registered') {
      push(descriptor.canonicalId, 'TargetDescriptor.registrationStatus 必须是 registered');
    }
    if (descriptor.canonicalId.length === 0) push(descriptor.canonicalId, 'canonicalId 不能为空');
    if (canonicalIds.has(descriptor.canonicalId)) push(descriptor.canonicalId, 'canonicalId 重复');
    canonicalIds.add(descriptor.canonicalId);

    const names = [descriptor.surface, ...descriptor.aliases];
    if (descriptor.surface.length === 0) push(descriptor.canonicalId, 'surface 不能为空');
    for (const name of names) {
      if (name.length === 0) {
        push(descriptor.canonicalId, 'surface/alias 不能为空');
        continue;
      }
      const previous = surfaces.get(name);
      if (previous !== undefined) {
        push(descriptor.canonicalId, `target 名称歧义：${name}`);
      } else {
        surfaces.set(name, descriptor.canonicalId);
      }
    }

    const catalogEvent = catalogEvents.get(descriptor.eventBinding);
    if (catalogEvent === undefined) {
      push(descriptor.canonicalId, `eventBinding 不存在于 eventCatalog：${descriptor.eventBinding}`);
    } else if (descriptor.compileSupport === 'supported' && !eventArgsMatch(descriptor.sourceArgs, catalogEvent.args)) {
      push(
        descriptor.canonicalId,
        `supported target 的 sourceArgs 必须与 eventCatalog 事件「${descriptor.eventBinding}」的 args 一致（name/kind/required）`,
      );
    }

    for (const rule of descriptor.parameterRules) {
      validateParameterRuleShape(descriptor.canonicalId, rule, push);
    }

    if (descriptor.compileSupport === 'unsupported') {
      if (descriptor.unsupportedReason === null || descriptor.unsupportedReason.length === 0) {
        push(descriptor.canonicalId, 'unsupported target 必须给 unsupportedReason');
      }
      if (descriptor.functionName !== null || descriptor.callSignature !== null || descriptor.runtimeProtocol !== null) {
        push(descriptor.canonicalId, 'unsupported target 的 functionName/callSignature/runtimeProtocol 必须为 null');
      }
      continue;
    }

    if (descriptor.unsupportedReason !== null) {
      push(descriptor.canonicalId, 'supported target 的 unsupportedReason 必须为 null');
    }
    if (descriptor.functionName === null) push(descriptor.canonicalId, 'supported target 缺少 functionName');
    if (descriptor.callSignature === null) push(descriptor.canonicalId, 'supported target 缺少 callSignature');
    if (descriptor.runtimeProtocol === null) push(descriptor.canonicalId, 'supported target 缺少 runtimeProtocol');
    if (descriptor.functionName === null) continue;

    const template = descriptor.functionName.template;
    const templateSegments = segmentNamesOf(template);
    for (const token of simpleTokensOf(template)) {
      const rule = descriptor.parameterRules.find((candidate) => isRuleFor(candidate, token, null));
      if (rule === undefined) {
        push(descriptor.canonicalId, `函数名模板含 {${token}}，但缺少参数规则`);
      } else if (!rule.required) {
        push(descriptor.canonicalId, `函数名模板含 {${token}}，参数规则 required 必须为 true`);
      }
    }
    const requiredSegments = new Set(descriptor.functionName.requiredSegments);
    for (const segmentName of templateSegments) {
      if (!requiredSegments.has(segmentName)) {
        push(descriptor.canonicalId, `函数名模板含 \${${segmentName}}，但 requiredSegments 未列出`);
      }
      if (!ruleCoversSegment(descriptor, segmentName)) {
        push(descriptor.canonicalId, `函数名模板含 \${${segmentName}}，但缺少参数规则`);
      }
      if (descriptor.segmentDefaults[segmentName] === undefined) {
        push(descriptor.canonicalId, `段 ${segmentName} 缺少 Adapter 显式默认值（registry-binding）`);
      }
    }
    for (const segmentName of requiredSegments) {
      if (!templateSegments.includes(segmentName)) {
        push(descriptor.canonicalId, `requiredSegments 含未出现在模板中的 \${${segmentName}}`);
      }
    }
    for (const [segmentName, defaultValue] of Object.entries(descriptor.segmentDefaults)) {
      if (!templateSegments.includes(segmentName)) {
        push(descriptor.canonicalId, `segmentDefaults 含模板中不存在的段 ${segmentName}`);
      }
      if (defaultValue.length === 0) {
        push(descriptor.canonicalId, `段 ${segmentName} 的 Adapter 默认值不能为空`);
      }
    }
    for (const rule of descriptor.parameterRules) {
      if (rule.token === 'segment') {
        if (rule.segmentName !== null && rule.segmentName.length > 0 && !templateSegments.includes(rule.segmentName)) {
          push(descriptor.canonicalId, `参数规则 \${${rule.segmentName}} 未出现在函数名模板中`);
        }
        continue;
      }
      if (!ruleCoversToken(descriptor, rule.token) || !simpleTokensOf(template).includes(rule.token)) {
        push(descriptor.canonicalId, `参数规则 ${rule.token} 未出现在函数名模板中`);
      }
    }
  }

  const descriptorsByBinding = new Map<string, readonly TargetDescriptor[]>();
  for (const descriptor of registry.targets) {
    const list = descriptorsByBinding.get(descriptor.eventBinding) ?? [];
    descriptorsByBinding.set(descriptor.eventBinding, [...list, descriptor]);
  }
  for (const event of eventCatalog.events) {
    const matched = descriptorsByBinding.get(event.event) ?? [];
    if (matched.length !== 1) {
      push(null, `eventCatalog 事件 ${event.event} 必须有且只有一个 descriptor（实际 ${matched.length}）`);
    }
  }

  return issues;
}

/** 校验失败时抛错；adapter 装载期使用，绝不静默取第一条/退回缺省。 */
export function assertValidTargetRegistry(registry: TargetRegistry, eventCatalog: EventCatalog): void {
  const issues = validateTargetRegistry(registry, eventCatalog);
  if (issues.length === 0) return;
  throw new Error(
    `[target-registry] ${registry.registryId}@${registry.version} 校验失败：\n` +
      issues.map((issue) => `- ${issue.message}`).join('\n'),
  );
}

/* ============================== Target Resolution ============================== */

/** 按 surface/alias 精确匹配；不做 trim、大小写折叠或别名替换。 */
export function findTargetDescriptor(registry: TargetRegistry, rawTarget: string): TargetDescriptor | null {
  for (const descriptor of registry.targets) {
    if (descriptor.surface === rawTarget || descriptor.aliases.includes(rawTarget)) return descriptor;
  }
  return null;
}

/** 项目级目标解析：只消费 Registry 与 Host/Core 事实，不读盘、不猜参数。 */
export function resolveTarget(request: TargetResolutionRequest): TargetResolution {
  const descriptor = findTargetDescriptor(request.registry, request.rawTarget);
  if (descriptor === null) {
    return {
      registrationStatus: 'unregistered',
      status: 'unknown',
      rawTarget: request.rawTarget,
      canonicalId: null,
      descriptor: null,
      functionName: { kind: 'unresolved', name: null, requiredContext: [], reason: 'target 不在 TargetRegistry' },
      diagnostics: [
        projectDiagnostic(
          'target-unknown',
          'core/target/unknown',
          `未知 Theater 目标「${request.rawTarget}」。可用目标：${request.registry.targets.map((target) => target.surface).join('、')}`,
          request.location,
        ),
      ],
    };
  }

  if (descriptor.compileSupport === 'unsupported') {
    return {
      registrationStatus: 'registered',
      status: 'unsupported',
      rawTarget: request.rawTarget,
      canonicalId: descriptor.canonicalId,
      descriptor,
      functionName: { kind: 'unsupported', name: null, requiredContext: [], reason: descriptor.unsupportedReason },
      diagnostics: [
        projectDiagnostic(
          'target-unsupported',
          'core/target/unsupported',
          `目标「${request.rawTarget}」当前不可编译：${descriptor.unsupportedReason ?? 'Adapter 未给原因'}`,
          request.location,
        ),
      ],
    };
  }

  const functionName = resolveFunctionName({ descriptor, context: request.context, sourceArgs: request.sourceArgs });
  if (functionName.kind === 'resolved') {
    return {
      registrationStatus: 'registered',
      status: 'supported',
      rawTarget: request.rawTarget,
      canonicalId: descriptor.canonicalId,
      descriptor,
      functionName,
      diagnostics: [],
    };
  }
  if (functionName.kind === 'needs-context') {
    return {
      registrationStatus: 'registered',
      status: 'needs-context',
      rawTarget: request.rawTarget,
      canonicalId: descriptor.canonicalId,
      descriptor,
      functionName,
      diagnostics: [
        projectDiagnostic(
          'function-name-context-missing',
          'core/target/function-name-context-missing',
          `目标「${request.rawTarget}」缺少函数名上下文：${functionName.requiredContext.join(', ')}`,
          request.location,
        ),
      ],
    };
  }
  if (functionName.kind === 'invalid-context') {
    return {
      registrationStatus: 'registered',
      status: 'invalid-context',
      rawTarget: request.rawTarget,
      canonicalId: descriptor.canonicalId,
      descriptor,
      functionName,
      diagnostics: [
        projectDiagnostic(
          'function-name-context-invalid',
          'core/target/function-name-context-invalid',
          `目标「${request.rawTarget}」的函数名上下文非法：${functionName.reason ?? '未说明'}`,
          request.location,
        ),
      ],
    };
  }
  return {
    registrationStatus: 'registered',
    status: 'invalid-context',
    rawTarget: request.rawTarget,
    canonicalId: descriptor.canonicalId,
    descriptor,
    functionName,
    diagnostics: [
      projectDiagnostic(
        'registry-binding',
        'core/target/registry-binding',
        `目标「${request.rawTarget}」的 Registry 绑定不完整：${functionName.reason ?? '未说明'}`,
        request.location,
      ),
    ],
  };
}