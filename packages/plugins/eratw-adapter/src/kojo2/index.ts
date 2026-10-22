/**
 * eraTW 2.0 适配数据总装（游戏事实 —— 只住本包）。
 *
 * `ERATW_GAME_ADAPTER` 是 `GameAdapter` 契约的 eraTW 实现：**纯数据、零 IO、深冻结**。
 * core 侧只通过契约字段消费它，不认识本文件里的任何游戏名词。
 *
 * 分层位置（设计稿 §1.1）：
 *   core（`@kojo/kojo-core`）  ── 语法/AST/诊断，零游戏名词
 *   adapter-sdk（`adapter.ts`） ── 契约形状（本对象实现的类型）
 *   本文件（eratw-adapter）    ── 九事件 / 代词落点 / 取色等待 / 演出 / 存储期 / 程序层
 *   宿主                       ── 接线与 Monaco/tree-sitter
 *
 * 注意：数据尽量从既有单一真源派生（`ERATW_LIBRARY_FUNCTIONS` / v1 代词口径 /
 * 状态线口径），本目录里的字面量只剩"2.0 新增契约面"本身，不复制第二份词表。
 */
import type { GameAdapter, GameFingerprint } from '../../../../kojo-core/src/adapter.js';
import { freezeAdapter } from '../../../../kojo-core/src/adapter.js';

import { ERATW_PROFILE } from './profile.js';
import { ERATW_EVENT_CATALOG } from './event-catalog.js';
import { ERATW_DOMAIN_SYMBOLS } from './domain-symbols.js';
import { ERATW_PRESENTATION } from './presentation.js';
import { ERATW_STORAGE_CLASSES } from './storage.js';
import { ERATW_PROGRAM_FEATURES } from './program.js';
import { ERATW_FOREACH_DECLARATIONS } from './collections.js';
import {
  ERATW_CAPABILITY,
  ERATW_CONFORMANCE_SUITE,
  ERATW_DIAGNOSTIC_NAMESPACE,
  ERATW_ENCODING_POLICY,
  ERATW_LAYER_POLICY,
  ERATW_SOURCE_MAP,
} from './capabilities.js';

export * from './profile.js';
export * from './event-catalog.js';
export * from './domain-symbols.js';
export * from './presentation.js';
export * from './storage.js';
export * from './program.js';
export * from './capabilities.js';

/**
 * 游戏指纹：引擎 / CSV / ERH / 汉化版本四段。换盘或换汉化包时 digest 必须变化，
 * 否则存档槽位会静默错位（§10.4）。
 */
export const ERATW_GAME_FINGERPRINT: GameFingerprint = Object.freeze({
  digest: 'eratw-4.980-zh',
  entries: Object.freeze([
    Object.freeze({ kind: 'engine' as const, value: 'Emuera 4.980' }),
    Object.freeze({ kind: 'csv' as const, value: 'eraTW 4.980 CSV' }),
    Object.freeze({ kind: 'erh' as const, value: 'eraTW 4.980 ERH' }),
    Object.freeze({ kind: 'locale' as const, value: 'zh-Hans（漢化包）' }),
  ]),
});

/** eraTW 的 2.0 adapter 数据（module 装载时深冻结一次；之后查表零构造开销） */
export const ERATW_GAME_ADAPTER: GameAdapter = freezeAdapter({
  id: 'eratw',
  version: '2.0.0',
  gameFingerprint: ERATW_GAME_FINGERPRINT,
  eventCatalog: ERATW_EVENT_CATALOG,
  domainSymbols: ERATW_DOMAIN_SYMBOLS,
  profile: ERATW_PROFILE,
  presentation: ERATW_PRESENTATION,
  storageClasses: ERATW_STORAGE_CLASSES,
  programFeatures: ERATW_PROGRAM_FEATURES,
  foreachCollections: ERATW_FOREACH_DECLARATIONS,
  encodingPolicy: ERATW_ENCODING_POLICY,
  layerPolicy: ERATW_LAYER_POLICY,
  diagnosticNamespace: ERATW_DIAGNOSTIC_NAMESPACE,
  capability: ERATW_CAPABILITY,
  sourceMap: ERATW_SOURCE_MAP,
  conformanceSuite: ERATW_CONFORMANCE_SUITE,
});

/* ---------- E4：`KojoEmitBackend` 实现（additive；不改变上面的数据面） ---------- */
export {
  createEratwEmitBackend,
  eratwLoweringProfile,
  type EratwCompileExpression,
  type EratwCompileTarget,
  type EratwEmitDeps,
} from './backend.js';

/* ---------- profile 覆盖（K2-ADAPTER-PROFILE；additive：纯函数 + 写死映射表） ---------- */
export {
  ERATW_ADAPTER_PROFILE_LANDING,
  ERATW_ADAPTER_PROFILE_LANDING_FIELDS,
  ERATW_DEFAULT_LOWERING_PROFILE,
  eratwAdapterProfileOverrides,
  resolveEratwProfile,
  type EratwAdapterProfileLandingField,
  type EratwProfileLayer,
  type EratwProfileOverrides,
} from './profile-resolve.js';

/* ---------- `选项` 落点（纯函数；backend 转调它，测试/一致性套件可直接复用） ---------- */
export {
  emitOptions,
  type EratwOptionsEmitInput,
  type OptionsBranchFact,
  type OptionsButtonFact,
  type OptionsPlanFact,
} from './options-emit.js';

/* ---------- `@巡` 集合声明与索引循环落点（K2-FOREACH） ---------- */
export * from './collections.js';
export { emitEratwForEachLoop, type EratwForeachEmitOptions } from './foreach-emit.js';

/* ---------- `# 表` 等值分派落点（K2-TABLE-SELECTCASE） ---------- */
export { emitTableDispatch, type EratwTableEmitInput, type TableDispatchCaseFact, type TableDispatchPlanFact } from './table-emit.js';
export { ERATW_TABLE_DISPATCH, type TableDispatchPresentation } from './table-data.js';

/* ---------- `# 池` 等值分派落点（K2-POOL-SELECTCASE） ---------- */
export {
  emitPoolDispatch,
  type EratwPoolDispatchEmitInput,
  type PoolDispatchCaseFact,
  type PoolDispatchPlanFact,
} from './pool-emit.js';

