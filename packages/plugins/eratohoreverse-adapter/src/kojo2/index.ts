/**
 * eratohoReverse 2.0 适配数据总装（游戏事实 —— 只住本包）。
 *
 * `ERATOHOREVERSE_GAME_ADAPTER` 是 `GameAdapter` 契约的 eratohoReverse 实现：
 * **纯数据、零 IO、深冻结**。core 只通过契约字段消费它，不认识本文件里的任何游戏名词。
 *
 * 分层位置与 eratohok / eraSQC 同构：core（语法 / AST / 诊断，零游戏名词）→
 * adapter-sdk（`adapter.ts` 契约形状）→ 本目录（八事件 / 三代词 / 六属性 /
 * 三存储期 / 程序层）→ 宿主（登记簿与 Monaco 接线）。
 *
 * **这不是 v1 那枚 adapter**：v1 住在 `plugin.ts`（带方法、进 `game.adapter`
 * 槽位）；本枚是 2.0 的纯数据面，由宿主组合根按清单 `kojo2AdapterExport`
 * 懒登记。
 *
 * 事实来源：本目录所有数值都是 2026-10-26 `C:/game/eratohoReverse` 真盘读数
 * （受管 `ERB/` 890 份 `.ERB` + 17 份 `.ERH`、口上域 `ERB/口上/` 633 份、
 * 108 份 Chara CSV、`CSV/Talent.csv` / `CSV/Cflag.csv` 名表逐条核对），**没有一条
 * 从 eraTW / eratohok / eraSQC / eraAV 抄**。本批不建 backend（发射面是下一批的事）。
 */
import type { GameAdapter, GameFingerprint } from '@kojo/kojo-core';
import { freezeAdapter } from '@kojo/kojo-core';

import { ERATOHOREVERSE_PROFILE } from './profile.js';
import { ERATOHOREVERSE_EVENT_CATALOG } from './event-catalog.js';
import { ERATOHOREVERSE_DOMAIN_SYMBOLS } from './domain-symbols.js';
import { ERATOHOREVERSE_PRESENTATION } from './presentation.js';
import { ERATOHOREVERSE_STORAGE_CLASSES } from './storage.js';
import { ERATOHOREVERSE_PROGRAM_FEATURES } from './program.js';
import {
  ERATOHOREVERSE_CAPABILITY,
  ERATOHOREVERSE_CONFORMANCE_SUITE,
  ERATOHOREVERSE_DIAGNOSTIC_NAMESPACE,
  ERATOHOREVERSE_ENCODING_POLICY,
  ERATOHOREVERSE_LAYER_POLICY,
  ERATOHOREVERSE_SOURCE_MAP,
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
 * 四段都是可复算的盘面摘要：引擎 `Emuera1824+v1.exe`、CSV 名表（Chara 108 份 /
 * Talent 处女 0 / Cflag 调教回数 200）、ERH 17 份 / 41 个唯一声明名、
 * **日文原作**（`GameBase.csv:11` タイトル `eratohoЯeverse`——西里尔 Я；
 * `:8` バージョン 1214；无汉化标记，但 108 份 Chara CSV 的 `名前` 行已是中文）。
 */
export const ERATOHOREVERSE_GAME_FINGERPRINT: GameFingerprint = Object.freeze({
  digest: 'eratohoreverse-emuera1824-ja',
  entries: Object.freeze([
    Object.freeze({
      kind: 'engine' as const,
      value: 'Emuera1824+v1（Emuera1824+v1.exe）',
    }),
    Object.freeze({
      kind: 'csv' as const,
      value: 'eratohoReverse CSV 名表（Chara 108 份；Talent 处女0/恋慕78；Cflag 调教回数200）',
    }),
    Object.freeze({
      kind: 'erh' as const,
      value: 'eratohoReverse ERH（17 份 / 41 唯一声明名）',
    }),
    Object.freeze({
      kind: 'locale' as const,
      value: 'ja（原作 eratohoЯeverse 1.2.14；GameBase タイトル eratohoЯeverse / バージョン 1214；Chara 名前行已汉化）',
    }),
  ]),
});

/** eratohoReverse 的 2.0 adapter（module 装载时深冻结一次；之后查表零构造开销） */
export const ERATOHOREVERSE_GAME_ADAPTER: GameAdapter = freezeAdapter({
  // 与 v1 `ERATOHOREVERSE.gameId` 逐字相等——宿主登记簿按 v1 gameId 建表，写错的
  // 表现是"打开工程后 2.0 面全部零候选"且不报错。
  id: 'eratohoreverse',
  version: '2.0.0',
  gameFingerprint: ERATOHOREVERSE_GAME_FINGERPRINT,
  eventCatalog: ERATOHOREVERSE_EVENT_CATALOG,
  domainSymbols: ERATOHOREVERSE_DOMAIN_SYMBOLS,
  profile: ERATOHOREVERSE_PROFILE,
  presentation: ERATOHOREVERSE_PRESENTATION,
  storageClasses: ERATOHOREVERSE_STORAGE_CLASSES,
  programFeatures: ERATOHOREVERSE_PROGRAM_FEATURES,
  /*
   * `@巡` 集合声明：**null = 本 adapter 不支持 `@巡`**。
   * 本作零 2.0 语料（`@巡` 是 2.0 构造），`programFeatures.foreach` 已按无实证
   * 关掉——声明一条没人能发射的规则与功能开关自相矛盾 ⇒ 取 null，
   * 语言层对 `@巡` 直接报 unsupported（fail-visible）。
   */
  foreachCollections: null,
  encodingPolicy: ERATOHOREVERSE_ENCODING_POLICY,
  layerPolicy: ERATOHOREVERSE_LAYER_POLICY,
  diagnosticNamespace: ERATOHOREVERSE_DIAGNOSTIC_NAMESPACE,
  capability: ERATOHOREVERSE_CAPABILITY,
  sourceMap: ERATOHOREVERSE_SOURCE_MAP,
  conformanceSuite: ERATOHOREVERSE_CONFORMANCE_SUITE,
});
