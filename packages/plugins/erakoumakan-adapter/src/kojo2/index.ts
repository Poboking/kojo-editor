/**
 * era紅魔館 2.0 适配数据总装（游戏事实 —— 只住本包）。
 *
 * `ERAKOUMAKAN_GAME_ADAPTER` 是 `GameAdapter` 契约的 era紅魔館 实现：**纯数据、
 * 零 IO、深冻结**。core 只通过契约字段消费它，不认识本文件里的任何游戏名词。
 *
 * 分层位置与 eraFL / eraSQC / eraTohoK 同构：core（语法 / AST / 诊断，零游戏名词）→
 * adapter-sdk（`adapter.ts` 契约形状）→ 本目录（七事件 / 三代词 / 八属性 /
 * 两存储期 / 程序层）→ 宿主（登记簿与 Monaco 接线）。
 *
 * **这不是 v1 那枚 adapter**：v1 住在 `plugin.ts`（带方法、进 `game.adapter`
 * 槽位）；本枚是 2.0 的纯数据面，由宿主组合根按清单 `kojo2AdapterExport`
 * 懒登记。**本包不建 backend**（发射面是下一批的事）。
 *
 * **证据 = 2026-10-26 `D:/Game/eraKoumakan` 真盘读数**（本目录所有数值）：
 * `ERB/` 子树 403 份 `.ERB` + 5 份 `.ERH`、口上域 64 份 `.ERB`、18 份
 * `CSV/Chara{no}.csv`、CSV 名表逐条核对，**没有一条从 eraTW / eraFL /
 * eraTohoK / eraSQC 抄**。换盘或换汉化包时 digest 必须变化，否则槽位静默错位。
 */
import type { GameAdapter, GameFingerprint } from '@kojo/kojo-core';
import { freezeAdapter } from '@kojo/kojo-core';

import { ERAKOUMAKAN_PROFILE } from './profile.js';
import { ERAKOUMAKAN_EVENT_CATALOG } from './event-catalog.js';
import { ERAKOUMAKAN_DOMAIN_SYMBOLS } from './domain-symbols.js';
import { ERAKOUMAKAN_PRESENTATION } from './presentation.js';
import { ERAKOUMAKAN_STORAGE_CLASSES } from './storage.js';
import { ERAKOUMAKAN_PROGRAM_FEATURES } from './program.js';
import {
  ERAKOUMAKAN_CAPABILITY,
  ERAKOUMAKAN_CONFORMANCE_SUITE,
  ERAKOUMAKAN_DIAGNOSTIC_NAMESPACE,
  ERAKOUMAKAN_ENCODING_POLICY,
  ERAKOUMAKAN_LAYER_POLICY,
  ERAKOUMAKAN_SOURCE_MAP,
} from './capabilities.js';

export * from './profile.js';
export * from './event-catalog.js';
export * from './domain-symbols.js';
export * from './presentation.js';
export * from './storage.js';
export * from './program.js';
export * from './capabilities.js';

/**
 * 游戏指纹：引擎 / CSV / ERH / 汉化版本四段（2026-10-26 盘面摘要）。
 *
 * 四段都是可复算的盘面事实：引擎 `Emuera1821 cn v8.exe`、CSV 名表
 * （CFLAG 329 / TALENT 112 / TCVAR 163 条具名行，`CSV/TCVAR.csv` 另有 1 行空名）、
 * ERH 5 份 / 592 个唯一声明名、简体汉化（`GameBase.csv` 的
 * `タイトル,era紅魔館protoNTR` + `バージョン,0038` + `コード,7153`）。
 */
export const ERAKOUMAKAN_GAME_FINGERPRINT: GameFingerprint = Object.freeze({
  digest: 'erakoumakan-emuera1821-zh',
  entries: Object.freeze([
    Object.freeze({
      kind: 'engine' as const,
      value: 'Emuera1821 cn v8.exe',
    }),
    Object.freeze({
      kind: 'csv' as const,
      value: 'eraKoumakan CSV 名表（CFLAG 329 / TALENT 112 / TCVAR 163）',
    }),
    Object.freeze({
      kind: 'erh' as const,
      value: 'eraKoumakan ERH（5 份 / 592 唯一声明名）',
    }),
    Object.freeze({
      kind: 'locale' as const,
      value: 'zh-Hans（era紅魔館protoNTR / バージョン 0038 / コード 7153）',
    }),
  ]),
});

/** era紅魔館 的 2.0 adapter（module 装载时深冻结一次；之后查表零构造开销） */
export const ERAKOUMAKAN_GAME_ADAPTER: GameAdapter = freezeAdapter({
  // 与 v1 `ERAKOUMAKAN.gameId` 逐字相等——宿主登记簿按 v1 gameId 建表，写错的
  // 表现是"打开工程后 2.0 面全部零候选"且不报错。
  id: 'erakoumakan',
  version: '2.0.0',
  gameFingerprint: ERAKOUMAKAN_GAME_FINGERPRINT,
  eventCatalog: ERAKOUMAKAN_EVENT_CATALOG,
  domainSymbols: ERAKOUMAKAN_DOMAIN_SYMBOLS,
  profile: ERAKOUMAKAN_PROFILE,
  presentation: ERAKOUMAKAN_PRESENTATION,
  storageClasses: ERAKOUMAKAN_STORAGE_CLASSES,
  programFeatures: ERAKOUMAKAN_PROGRAM_FEATURES,
  /*
   * `@巡` 集合声明：**null = 本 adapter 不支持 `@巡`**。
   * 本作零 2.0 语料（`@巡` 是 2.0 构造），`programFeatures.foreach` 已按无实证
   * 关掉——声明一条没人能发射的规则与功能开关自相矛盾 ⇒ 取 null，
   * 语言层对 `@巡` 直接报 unsupported（fail-visible）。
   */
  foreachCollections: null,
  encodingPolicy: ERAKOUMAKAN_ENCODING_POLICY,
  layerPolicy: ERAKOUMAKAN_LAYER_POLICY,
  diagnosticNamespace: ERAKOUMAKAN_DIAGNOSTIC_NAMESPACE,
  capability: ERAKOUMAKAN_CAPABILITY,
  sourceMap: ERAKOUMAKAN_SOURCE_MAP,
  conformanceSuite: ERAKOUMAKAN_CONFORMANCE_SUITE,
});
