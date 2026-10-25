/**
 * eraAkumaMaid 2.0 适配数据总装（游戏事实 —— 只住本包）。
 *
 * `ERAAKUMAMAID_GAME_ADAPTER` 是 `GameAdapter` 契约的 eraAkumaMaid 实现：**纯数据、
 * 零 IO、深冻结**。core 只通过契约字段消费它，不认识本文件里的任何游戏名词。
 *
 * **无真盘 · 证据等级 B**：2026-10-26 实测 `C:/game/eraAkumaMaid` 与
 * `D:/Game/eraAkumaMaid` 均不存在；本目录八文件**不来自任何真盘扫描**，依据 = v1
 * 源码的 `file:line` 与测试夹具。指纹里的数字是 **v1 源码已记录过的读数转引**
 * （`variable-schema.ts:9-10` / `:22-29`），不是本批新测——换盘 / 换魔改时必须复测
 * 并更新 digest，否则槽位静默错位。
 *
 * **这不是 v1 那枚 adapter**：v1 住在 `plugin.ts`（带方法、进 `game.adapter`
 * 槽位）；本枚是 2.0 的纯数据面，由宿主组合根按清单 `kojo2AdapterExport`
 * 懒登记。**本包不建 backend**（发射面是下一批的事）。
 */
import type { GameAdapter, GameFingerprint } from '@kojo/kojo-core';
import { freezeAdapter } from '@kojo/kojo-core';

import { ERAAKUMAMAID_PROFILE } from './profile.js';
import { ERAAKUMAMAID_EVENT_CATALOG } from './event-catalog.js';
import { ERAAKUMAMAID_DOMAIN_SYMBOLS } from './domain-symbols.js';
import { ERAAKUMAMAID_PRESENTATION } from './presentation.js';
import { ERAAKUMAMAID_STORAGE_CLASSES } from './storage.js';
import { ERAAKUMAMAID_PROGRAM_FEATURES } from './program.js';
import {
  ERAAKUMAMAID_CAPABILITY,
  ERAAKUMAMAID_CONFORMANCE_SUITE,
  ERAAKUMAMAID_DIAGNOSTIC_NAMESPACE,
  ERAAKUMAMAID_ENCODING_POLICY,
  ERAAKUMAMAID_LAYER_POLICY,
  ERAAKUMAMAID_SOURCE_MAP,
} from './capabilities.js';

export * from './profile.js';
export * from './event-catalog.js';
export * from './domain-symbols.js';
export * from './presentation.js';
export * from './storage.js';
export * from './program.js';
export * from './capabilities.js';

/**
 * 游戏指纹：引擎 / CSV / ERH / 本地化四段（固定顺序）。
 *
 * 四段值均为 **v1 源码转引读数**（证据等级 B，无本批真盘核对）：
 * 引擎 `Emuera 1824+v18 私家改造版`（`constants.ts:5`）；CSV 名表
 * CFLAG 342 行 / TALENT 191 行（`variable-schema.ts:9-10`）；ERB 域 `.ERH`
 * 9 份 / 96 唯一声明名（`variable-schema.ts:22-29`）；日文原版、口上域
 * `ERB/EVENT_K`（`constants.ts:6` / `:33`）。
 */
export const ERAAKUMAMAID_GAME_FINGERPRINT: GameFingerprint = Object.freeze({
  digest: 'eraakumamaid-emuera1824-v18-ja',
  entries: Object.freeze([
    Object.freeze({
      kind: 'engine' as const,
      value: 'Emuera 1824+v18 私家改造版（日文原版）',
    }),
    Object.freeze({
      kind: 'csv' as const,
      value: 'eraAkumaMaid CSV 名表（CFLAG 342 行 / TALENT 191 行）',
    }),
    Object.freeze({
      kind: 'erh' as const,
      value: 'ERB 域 .ERH 9 份 / 96 唯一声明名',
    }),
    Object.freeze({
      kind: 'locale' as const,
      value: 'ja（日文原版；口上域 ERB/EVENT_K）',
    }),
  ]),
});

/** eraAkumaMaid 的 2.0 adapter（module 装载时深冻结一次；之后查表零构造开销） */
export const ERAAKUMAMAID_GAME_ADAPTER: GameAdapter = freezeAdapter({
  // 与 v1 `ERAAKUMA_MAID.gameId` 逐字相等（`constants.ts:13`）——宿主登记簿按 v1
  // gameId 建表，写错的表现是"打开工程后 2.0 面全部零候选"且不报错。
  id: 'eraakumamaid',
  version: '2.0.0',
  gameFingerprint: ERAAKUMAMAID_GAME_FINGERPRINT,
  eventCatalog: ERAAKUMAMAID_EVENT_CATALOG,
  domainSymbols: ERAAKUMAMAID_DOMAIN_SYMBOLS,
  profile: ERAAKUMAMAID_PROFILE,
  presentation: ERAAKUMAMAID_PRESENTATION,
  storageClasses: ERAAKUMAMAID_STORAGE_CLASSES,
  programFeatures: ERAAKUMAMAID_PROGRAM_FEATURES,
  /*
   * `@巡` 集合声明：**null = 本 adapter 不支持 `@巡`**。
   * 本作零 2.0 语料（`@巡` 是 2.0 构造），`programFeatures.foreach` 已按无实证
   * 关掉——声明一条没人能发射的规则与功能开关自相矛盾 ⇒ 取 null，
   * 语言层对 `@巡` 直接报 unsupported（fail-visible）。
   */
  foreachCollections: null,
  encodingPolicy: ERAAKUMAMAID_ENCODING_POLICY,
  layerPolicy: ERAAKUMAMAID_LAYER_POLICY,
  diagnosticNamespace: ERAAKUMAMAID_DIAGNOSTIC_NAMESPACE,
  capability: ERAAKUMAMAID_CAPABILITY,
  sourceMap: ERAAKUMAMAID_SOURCE_MAP,
  conformanceSuite: ERAAKUMAMAID_CONFORMANCE_SUITE,
});
