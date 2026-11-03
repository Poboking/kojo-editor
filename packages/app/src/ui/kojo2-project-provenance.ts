/**
 * Kojo 2.0 项目编译 provenance 的 Host 单一入口（M2 契约 §1.3）。
 *
 * 为什么需要这枚：`compileProject` 在链接之前会用
 * `validateProjectProvenanceVersions` **硬校验**四轴（逐字相等）：
 *
 * - `provenance.adapterId`      ↔ `TargetRegistry.adapterId`
 * - `provenance.adapterVersion` ↔ `TargetRegistry.adapterVersion`
 * - `provenance.backendId`      ↔ `KojoEmitBackend.id`
 * - `provenance.backendVersion` ↔ `KojoEmitBackend.version`（backend 未声明 version 同样阻断）
 *
 * 缺一轴或错一个字符都会让整次项目构建 `buildStatus: 'failed'`，诊断却是
 * `core/project/version-mismatch`——接入处手抄这些字段极易错配，且错误现场离接入点很远。
 * 本模块把「从对象派生 provenance」收成一个入口：**只读对象事实，不 import 任何插件**，
 * 缺必填事实当场 throw（fail-fast），不把配置错误拖到编译期才变成难读诊断。
 *
 * 边界：
 * - adapter 与 registry 的 adapterId/Version 一致性**不在这里抛**：这一步按契约归
 *   `compileProject` 的版本校验（见上），helper 只负责如实派生，不替 core 做判断；
 * - 不猜默认值：只有显式声明的 `adapterFactsVersion` / `coreVersion` 有缺省，
 *   且缺省值写死在本文件（不读 package.json、不读环境变量）。
 */
import type {
  Capability,
  GameAdapter,
  KojoEmitBackend,
  ProjectBuildProvenance,
  SourceMapPolicy,
  TargetRegistry,
} from '@kojo/kojo-core';

export interface Kojo2ProjectProvenanceInput {
  /** adapter 身份与游戏指纹；`gameFingerprint` 取 `digest`（换盘必变的那一枚）。 */
  readonly adapter: Pick<GameAdapter, 'id' | 'version' | 'gameFingerprint'>;
  /** 目标注册表（adapter 身份随表携带，因此这里同时取表自身的 registryId/version）。 */
  readonly registry: Pick<TargetRegistry, 'adapterId' | 'adapterVersion' | 'registryId' | 'version'>;
  /** 发音后端（版本必须显式声明，否则项目路径 fail-closed）。 */
  readonly backend: Pick<KojoEmitBackend, 'id' | 'version'>;
  /** adapter 能力事实（eraTW 用 ERATW_CAPABILITY；由 Host 组合根注入，helper 不 import 插件）。 */
  readonly capability: Capability;
  readonly sourceMapPolicy: SourceMapPolicy;
  /** 缺省 '1'。 */
  readonly adapterFactsVersion?: string;
  /** 缺省 '0.0.0'；当前契约只要求随 provenance 携带，不参与版本校验。 */
  readonly coreVersion?: string;
}

const DEFAULT_ADAPTER_FACTS_VERSION = '1';
const DEFAULT_CORE_VERSION = '0.0.0';

/** 必填字符串事实：缺失 / 空串 / 非字符串一律当场炸，不留给编译期。 */
function required(label: string, value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(
      `createKojo2ProjectProvenance: ${label} 缺失或为空串。provenance 必须从对象派生，空值会让 ` +
        'compileProject 的版本校验失败（M2 契约 §1.3），接入点应就地修复而不是硬编造。',
    );
  }
  return value;
}

/** 可选字符串事实：给了就必须非空；没给才走缺省。 */
function optionalOrDefault(label: string, value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  return required(label, value);
}

/**
 * 从 Host 组合根的真实对象派生 `ProjectBuildProvenance`。
 *
 * 返回值是**冻结的纯数据**，可直接交给 `compileKojo2Project`；不读盘、不猜、不 import 插件。
 */
export function createKojo2ProjectProvenance(
  input: Kojo2ProjectProvenanceInput,
): ProjectBuildProvenance {
  return Object.freeze({
    adapterId: required('adapter.id', input.adapter.id),
    adapterVersion: required('adapter.version', input.adapter.version),
    adapterFactsVersion: optionalOrDefault(
      'adapterFactsVersion',
      input.adapterFactsVersion,
      DEFAULT_ADAPTER_FACTS_VERSION,
    ),
    gameFingerprint: required(
      'adapter.gameFingerprint.digest',
      input.adapter.gameFingerprint?.digest,
    ),
    targetRegistryId: required('registry.registryId', input.registry.registryId),
    targetRegistryVersion: required('registry.version', input.registry.version),
    backendId: required('backend.id', input.backend.id),
    // 契约要求 backendVersion 非空；`KojoEmitBackend.version` 是可选，缺省即 fail-fast。
    backendVersion: required('backend.version', input.backend.version),
    coreVersion: optionalOrDefault('coreVersion', input.coreVersion, DEFAULT_CORE_VERSION),
    sourceMapPolicy: input.sourceMapPolicy,
    capability: input.capability,
  });
}
