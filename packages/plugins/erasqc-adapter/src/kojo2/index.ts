/**
 * eraSQC 2.0 适配数据总装（游戏事实 —— 只住本包）。
 *
 * `ERASQC_GAME_ADAPTER` 是 `GameAdapter` 契约的 eraSQC 实现：**纯数据、零 IO、
 * 深冻结**。core 只通过契约字段消费它，不认识本文件里的任何游戏名词。
 *
 * 分层位置与 eraFL 同构：core（语法 / AST / 诊断，零游戏名词）→ adapter-sdk
 * （`adapter.ts` 契约形状）→ 本目录（九事件 / 三代词 / 八状态 / 三存储期 /
 * 程序层）→ 宿主（登记簿与 Monaco / tree-sitter 接线）。
 *
 * **这不是 v1 那枚 adapter**：v1 住在 `plugin.ts`（带方法、进 `game.adapter` 槽位）；
 * 本枚是 2.0 的纯数据面，由宿主组合根按清单 `kojo2AdapterExport` 懒登记。
 *
 * 事实来源：本目录所有数值都是 2026-10-26 `D:/Game/eraSQC` 真盘读数（351 份 ERB /
 * 63 份 Chara CSV / CSV 名表逐条核对），**没有一条从 eraTW / eraFL 抄**。
 * 本批不建 backend（发射面是下一批的事）。
 */
import type { GameAdapter, GameFingerprint } from '@kojo/kojo-core';
import { freezeAdapter } from '@kojo/kojo-core';

import { ERASQC_PROFILE } from './profile.js';
import { ERASQC_EVENT_CATALOG } from './event-catalog.js';
import { ERASQC_DOMAIN_SYMBOLS } from './domain-symbols.js';
import { ERASQC_PRESENTATION } from './presentation.js';
import { ERASQC_STORAGE_CLASSES } from './storage.js';
import { ERASQC_PROGRAM_FEATURES } from './program.js';
import {
  ERASQC_CAPABILITY,
  ERASQC_CONFORMANCE_SUITE,
  ERASQC_DIAGNOSTIC_NAMESPACE,
  ERASQC_ENCODING_POLICY,
  ERASQC_LAYER_POLICY,
  ERASQC_SOURCE_MAP,
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
 *
 * 四段都是可复算的盘面摘要：引擎 exe `Emuera1824+v18+EMv17+EEv43.exe`、
 * CSV 名表（CFLAG 62 / TALENT 224 / TCVAR 无名表）、ERH 0 份、简体汉化
 * （`GameBase.csv` 标题 `erasqn汉化魔改版_返`）。
 */
export const ERASQC_GAME_FINGERPRINT: GameFingerprint = Object.freeze({
  digest: 'erasqc-emuera1824-eev43-zh',
  entries: Object.freeze([
    Object.freeze({ kind: 'engine' as const, value: 'Emuera1824+v18+EMv17+EEv43' }),
    Object.freeze({
      kind: 'csv' as const,
      value: 'eraSQC CSV 名表（CFLAG 62 / TALENT 224 / TCVAR 无名表）',
    }),
    Object.freeze({ kind: 'erh' as const, value: 'eraSQC ERH（0 份 / 0 唯一声明名）' }),
    Object.freeze({ kind: 'locale' as const, value: 'zh-Hans（erasqn 汉化魔改版_返）' }),
  ]),
});

/** eraSQC 的 2.0 adapter（module 装载时深冻结一次；之后查表零构造开销） */
export const ERASQC_GAME_ADAPTER: GameAdapter = freezeAdapter({
  // 与 v1 `ERASQC.gameId` 逐字相等——宿主登记簿按 v1 gameId 建表，写错的表现是
  // "打开工程后 2.0 面全部零候选"且不报错。
  id: 'erasqc',
  version: '2.0.0',
  gameFingerprint: ERASQC_GAME_FINGERPRINT,
  eventCatalog: ERASQC_EVENT_CATALOG,
  domainSymbols: ERASQC_DOMAIN_SYMBOLS,
  profile: ERASQC_PROFILE,
  presentation: ERASQC_PRESENTATION,
  storageClasses: ERASQC_STORAGE_CLASSES,
  programFeatures: ERASQC_PROGRAM_FEATURES,
  /*
   * `@巡` 集合声明：**null = 本 adapter 不支持 `@巡`**。
   * 本作零 2.0 语料（`@巡` 是 2.0 构造），`programFeatures.foreach` 已按无实证
   * 关掉——声明一条没人能发射的规则与功能开关自相矛盾 ⇒ 取 null，
   * 语言层对 `@巡` 直接报 unsupported（fail-visible）。
   */
  foreachCollections: null,
  encodingPolicy: ERASQC_ENCODING_POLICY,
  layerPolicy: ERASQC_LAYER_POLICY,
  diagnosticNamespace: ERASQC_DIAGNOSTIC_NAMESPACE,
  capability: ERASQC_CAPABILITY,
  sourceMap: ERASQC_SOURCE_MAP,
  conformanceSuite: ERASQC_CONFORMANCE_SUITE,
});
