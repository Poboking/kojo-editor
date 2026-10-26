/**
 * eraAV 2.0 适配数据总装（游戏事实 —— 只住本包）。
 *
 * `ERAAV_GAME_ADAPTER` 是 `GameAdapter` 契约的 eraAV 实现：**纯数据、
 * 零 IO、深冻结**。core 只通过契约字段消费它，不认识本文件里的任何游戏名词。
 *
 * 分层位置与 eratohok / eraSQC 同构：core（语法 / AST / 诊断，零游戏名词）→
 * adapter-sdk（`adapter.ts` 契约形状）→ 本目录（八事件 / 三代词 / 属性 /
 * 三存储期 / 程序层）→ 宿主（登记簿与 Monaco 接线）。
 *
 * **这不是 v1 那枚 adapter**：v1 住在 `plugin.ts`（带方法、进 `game.adapter`
 * 槽位）；本枚是 2.0 的纯数据面，由宿主组合根按清单 `kojo2AdapterExport`
 * 懒登记。
 *
 * 事实来源：本目录所有数值都是 2026-10-26 `C:/game/eraAV` 真盘读数
 * （受管 `ERB/` 468 份 `.ERB` + 3 份 `.ERH`、口上域 `ERB/Lines/` 17 份、
 * 120 份 Chara CSV、`CSV/Talent.csv` 简体名表逐条核对），**没有一条从
 * eraTW / eratohok / eraSQC 抄**。本批不建 backend（发射面是下一批的事）。
 */
import type { GameAdapter, GameFingerprint } from '@kojo/kojo-core';
import { freezeAdapter } from '@kojo/kojo-core';

import { ERAAV_PROFILE } from './profile.js';
import { ERAAV_EVENT_CATALOG } from './event-catalog.js';
import { ERAAV_DOMAIN_SYMBOLS } from './domain-symbols.js';
import { ERAAV_PRESENTATION } from './presentation.js';
import { ERAAV_STORAGE_CLASSES } from './storage.js';
import { ERAAV_PROGRAM_FEATURES } from './program.js';
import {
  ERAAV_CAPABILITY,
  ERAAV_CONFORMANCE_SUITE,
  ERAAV_DIAGNOSTIC_NAMESPACE,
  ERAAV_ENCODING_POLICY,
  ERAAV_LAYER_POLICY,
  ERAAV_SOURCE_MAP,
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
 * 四段都是可复算的盘面摘要：引擎 `emuera1824中文版.exe`、CSV 名表（Chara 120 份 /
 * Talent 简体：处女 0 / 爱慕 85；**无 CFLAG 表**）、ERH 3 份 / 5 个唯一声明名、
 * 简体汉化（`GameBase.csv:4` タイトル `Erav优化整合版`；`バージョン` 为空 ⇒
 * 汉化包抹掉了版本行，指纹按标题行分辨）。
 */
export const ERAAV_GAME_FINGERPRINT: GameFingerprint = Object.freeze({
  digest: 'eraav-emuera1824-zh',
  entries: Object.freeze([
    Object.freeze({
      kind: 'engine' as const,
      value: 'Emuera1824 中文版（emuera1824中文版.exe）',
    }),
    Object.freeze({
      kind: 'csv' as const,
      value: 'eraAV CSV 名表（Chara 120 份；Talent 简体 处女0/爱慕85；无 CFLAG 表）',
    }),
    Object.freeze({
      kind: 'erh' as const,
      value: 'eraAV ERH（3 份 / 5 唯一声明名）',
    }),
    Object.freeze({
      kind: 'locale' as const,
      value: 'zh-Hans（Erav优化整合版汉化；GameBase タイトル Erav优化整合版 / バージョン 空）',
    }),
  ]),
});

/** eraAV 的 2.0 adapter（module 装载时深冻结一次；之后查表零构造开销） */
export const ERAAV_GAME_ADAPTER: GameAdapter = freezeAdapter({
  // 与 v1 `ERAAV.gameId` 逐字相等——宿主登记簿按 v1 gameId 建表，写错的
  // 表现是"打开工程后 2.0 面全部零候选"且不报错。
  id: 'eraav',
  version: '2.0.0',
  gameFingerprint: ERAAV_GAME_FINGERPRINT,
  eventCatalog: ERAAV_EVENT_CATALOG,
  domainSymbols: ERAAV_DOMAIN_SYMBOLS,
  profile: ERAAV_PROFILE,
  presentation: ERAAV_PRESENTATION,
  storageClasses: ERAAV_STORAGE_CLASSES,
  programFeatures: ERAAV_PROGRAM_FEATURES,
  /*
   * `@巡` 集合声明：**null = 本 adapter 不支持 `@巡`**。
   * 本作零 2.0 语料（`@巡` 是 2.0 构造），`programFeatures.foreach` 已按无实证
   * 关掉——声明一条没人能发射的规则与功能开关自相矛盾 ⇒ 取 null，
   * 语言层对 `@巡` 直接报 unsupported（fail-visible）。
   */
  foreachCollections: null,
  encodingPolicy: ERAAV_ENCODING_POLICY,
  layerPolicy: ERAAV_LAYER_POLICY,
  diagnosticNamespace: ERAAV_DIAGNOSTIC_NAMESPACE,
  capability: ERAAV_CAPABILITY,
  sourceMap: ERAAV_SOURCE_MAP,
  conformanceSuite: ERAAV_CONFORMANCE_SUITE,
});
