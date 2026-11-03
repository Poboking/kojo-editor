/**
 * eraTW 2.0 TargetRegistry（游戏事实 —— 只住本包）。
 *
 * 首版严格按 ADR-0011 D1：
 * - eventCatalog 九个事件全部登记；
 * - 只有「初见」「指令」compileSupport = supported；
 * - 其余七个显式 unsupported，但保留 eventBinding / sourceArgs / unsupportedReason；
 * - supported 目标的函数名模板从既有 face-templates 派生，不手抄第二套命名。
 */
import type {
  EventArgumentSpec,
  EventSpec,
} from '../../../../kojo-core/src/adapter.js';
import type {
  CallSignature,
  FunctionNameParameterRule,
  TargetDescriptor,
  TargetRegistry,
} from '../../../../kojo-core/src/project/target-registry.js';
import { assertValidTargetRegistry } from '../../../../kojo-core/src/project/target-registry.js';
import { createEratwFaceTable } from '../face-templates.js';
import { ERATW_EVENT_CATALOG } from './event-catalog.js';

const FACE_TABLE = createEratwFaceTable();

const HOST_FAMILY_RULE: FunctionNameParameterRule = Object.freeze({
  token: 't' as const,
  segmentName: null,
  source: 'host-file' as const,
  required: true,
  allowExplicitEmpty: true,
  adapterMayDeclareDefault: false,
  valueKind: 'family-segment' as const,
  valuePattern: '^(?:_[^\\s].*)?$',
});

const HOST_CHAR_NO_RULE: FunctionNameParameterRule = Object.freeze({
  token: 'n' as const,
  segmentName: null,
  source: 'host-file' as const,
  required: true,
  allowExplicitEmpty: false,
  adapterMayDeclareDefault: false,
  valueKind: 'char-no' as const,
  valuePattern: '^[0-9]+$',
});

const CORE_INDEX_RULE: FunctionNameParameterRule = Object.freeze({
  token: 'i' as const,
  segmentName: null,
  source: 'core-derived' as const,
  required: true,
  allowExplicitEmpty: false,
  adapterMayDeclareDefault: false,
  valueKind: 'index' as const,
  valuePattern: '^-?[0-9]+$',
});

const COM_RULE: FunctionNameParameterRule = Object.freeze({
  token: 'segment' as const,
  segmentName: 'com',
  source: 'adapter-rule' as const,
  required: true,
  allowExplicitEmpty: false,
  adapterMayDeclareDefault: true,
  valueKind: 'segment' as const,
  valuePattern: '^(?:COM|SCOM|CUSTOM_COM|CUSTOM_SCOM)$',
});

function eventOf(name: string): EventSpec {
  const event = ERATW_EVENT_CATALOG.events.find((candidate) => candidate.event === name);
  if (event === undefined) {
    throw new Error(`eraTW eventCatalog 缺少事件「${name}」：TargetRegistry 无法登记`);
  }
  return event;
}

function sourceArgsOf(name: string): readonly EventArgumentSpec[] {
  return eventOf(name).args;
}

function formalsOf(args: readonly EventArgumentSpec[]): readonly string[] {
  return args.map((_arg, index) => (index === 0 ? 'ARG' : `ARG:${index}`));
}

function callSignatureOf(name: string): CallSignature {
  const args = sourceArgsOf(name);
  const formals = formalsOf(args);
  return Object.freeze({
    sourceArgs: args,
    wrapperFormals: formals,
    companionFormals: formals,
    returnProtocol: 'RETURN RESULT' as const,
    localPolicy: 'LOCAL_1_IF_BODY' as const,
  });
}

function supportedDescriptor(
  name: string,
  functionNameTemplate: string,
  requiredSegments: readonly string[],
  parameterRules: readonly FunctionNameParameterRule[],
  segmentDefaults: Readonly<Record<string, string>>,
): TargetDescriptor {
  const event = eventOf(name);
  return Object.freeze({
    registrationStatus: 'registered' as const,
    compileSupport: 'supported' as const,
    canonicalId: `eratw.event.${name}`,
    surface: name,
    aliases: Object.freeze([]),
    eventBinding: event.event,
    sourceArgs: sourceArgsOf(name),
    unsupportedReason: null,
    functionName: Object.freeze({
      template: functionNameTemplate,
      requiredSegments: Object.freeze([...requiredSegments]),
    }),
    callSignature: callSignatureOf(name),
    runtimeProtocol: Object.freeze({
      protocolId: 'eratw.kojo.machine',
      version: '1',
      metadata: Object.freeze({ event: event.event, engine: event.engine }),
    }),
    parameterRules: Object.freeze([...parameterRules]),
    segmentDefaults: Object.freeze({ ...segmentDefaults }),
  });
}

function unsupportedDescriptor(name: string, reason: string): TargetDescriptor {
  const event = eventOf(name);
  return Object.freeze({
    registrationStatus: 'registered' as const,
    compileSupport: 'unsupported' as const,
    canonicalId: `eratw.event.${name}`,
    surface: name,
    aliases: Object.freeze([]),
    eventBinding: event.event,
    sourceArgs: sourceArgsOf(name),
    unsupportedReason: reason,
    functionName: null,
    callSignature: null,
    runtimeProtocol: null,
    parameterRules: Object.freeze([]),
    segmentDefaults: Object.freeze({}),
  });
}

const ENCOUNTER = FACE_TABLE.faces['初见'];
const COMMAND = FACE_TABLE.faces['指令'];
if (ENCOUNTER === undefined || COMMAND === undefined) {
  throw new Error('eraTW face-templates 缺少「初见」或「指令」：无法构建 TargetRegistry');
}

const UNSUPPORTED_REASON = 'M2 首版只支持「初见」「指令」；该事件尚未接入 TargetRegistry 编译落点。';

const TARGETS: readonly TargetDescriptor[] = Object.freeze([
  supportedDescriptor(
    '初见',
    ENCOUNTER.template,
    [],
    [HOST_FAMILY_RULE, HOST_CHAR_NO_RULE],
    {},
  ),
  unsupportedDescriptor('训练', UNSUPPORTED_REASON),
  unsupportedDescriptor('读档', UNSUPPORTED_REASON),
  unsupportedDescriptor('商店', UNSUPPORTED_REASON),
  unsupportedDescriptor('购买', UNSUPPORTED_REASON),
  supportedDescriptor(
    '指令',
    COMMAND.template,
    ['com'],
    [HOST_FAMILY_RULE, HOST_CHAR_NO_RULE, COM_RULE, CORE_INDEX_RULE],
    { com: 'COM' },
  ),
  unsupportedDescriptor('训练结束', UNSUPPORTED_REASON),
  unsupportedDescriptor('回合末', UNSUPPORTED_REASON),
  unsupportedDescriptor('指令结束', UNSUPPORTED_REASON),
]);

export const ERATW_TARGET_REGISTRY: TargetRegistry = Object.freeze({
  registryId: 'eratw.target-registry',
  version: '1',
  adapterId: 'eratw',
  adapterVersion: '2.0.0',
  targets: TARGETS,
});

assertValidTargetRegistry(ERATW_TARGET_REGISTRY, ERATW_EVENT_CATALOG);