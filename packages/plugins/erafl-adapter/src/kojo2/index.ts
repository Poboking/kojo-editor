/**
 * eraFL 2.0 适配数据总装（游戏事实 —— 只住本包）。
 *
 * `ERAFL_GAME_ADAPTER` 是 `GameAdapter` 契约的 eraFL 实现：**纯数据、零 IO、深冻结**。
 * core 侧只通过契约字段消费它，不认识本文件里的任何游戏名词。
 *
 * 分层位置（设计稿 §1.1）：
 *   core（`@kojo/kojo-core`）   ── 语法/AST/诊断，零游戏名词
 *   adapter-sdk（`adapter.ts`） ── 契约形状（本对象实现的类型）
 *   本文件（erafl-adapter）     ── 四事件 / 代词落点 / 五状态线 / 取色等待 / 存储期 / 程序层
 *   宿主                        ── 接线与 Monaco/tree-sitter
 *
 * **这不是 v1 那枚 adapter**（§6.1）：v1 的住在 `plugin.ts`（带方法、进
 * `game.adapter` 槽位）；本枚是 2.0 的（纯数据、由宿主组合根的 getter 注入，
 * 见 `packages/app/src/bootstrap.ts` 的登记簿）。两者**同时存在**，不是替换关系。
 *
 * 事实来源：本目录所有数值都是 2026-10-24 `D:/Game/erafl` 真盘读数（逐文件的
 * 头注有计数与文件:行），**没有一条是从 eraTW 抄的**——两作的编码、代词落点、
 * 事件表、演出面全都不同，照抄必错（交接文档 §2）。入口 B 交付的只是最小面：
 * 发射面（backend / `*-emit`）是入口 D 的事，本目录不建。
 */
import type { GameAdapter, GameFingerprint } from '@kojo/kojo-core';
import { freezeAdapter } from '@kojo/kojo-core';

import { ERAFL_PROFILE } from './profile.js';
import { ERAFL_EVENT_CATALOG } from './event-catalog.js';
import { ERAFL_DOMAIN_SYMBOLS } from './domain-symbols.js';
import { ERAFL_PRESENTATION } from './presentation.js';
import { ERAFL_STORAGE_CLASSES } from './storage.js';
import { ERAFL_PROGRAM_FEATURES } from './program.js';
import {
  ERAFL_CAPABILITY,
  ERAFL_CONFORMANCE_SUITE,
  ERAFL_DIAGNOSTIC_NAMESPACE,
  ERAFL_ENCODING_POLICY,
  ERAFL_LAYER_POLICY,
  ERAFL_SOURCE_MAP,
} from './capabilities.js';

export * from './profile.js';
export * from './event-catalog.js';
export * from './domain-symbols.js';
export * from './presentation.js';
export * from './storage.js';
export * from './program.js';
export * from './capabilities.js';
// 入口 D：落点面（`KojoEmitBackend` + 落点 profile）。纯函数/纯数据，零 IO。
export * from './backend.js';

/**
 * 游戏指纹：引擎 / CSV / ERH / 汉化版本四段。换盘或换汉化包时 digest 必须变化，
 * 否则存档槽位会静默错位（§10.4）。
 *
 * 四段都是可复算的盘面摘要（不是手写字符串）：引擎版号（盘上
 * `EmueraFL_v1.45-preview.exe`）、CSV 名表规模（20 份有条目，CFLAG 127 /
 * TALENT 174 / TCVAR 106 等编号，见 `variable-schema.ts` 清点）、ERH 声明规模
 * （112 份 / 3,507 个唯一声明名，同上）、本地化（汉化包）。
 */
export const ERAFL_GAME_FINGERPRINT: GameFingerprint = Object.freeze({
  digest: 'erafl-1.45-zh',
  entries: Object.freeze([
    Object.freeze({ kind: 'engine' as const, value: 'EmueraFL v1.45-preview' }),
    Object.freeze({
      kind: 'csv' as const,
      value: 'eraFL CSV 名表（20 份有条目：CFLAG 127 / TALENT 174 / TCVAR 106 …）',
    }),
    Object.freeze({ kind: 'erh' as const, value: 'eraFL ERH（112 份 / 3,507 唯一声明名）' }),
    Object.freeze({ kind: 'locale' as const, value: 'zh-Hans（漢化包）' }),
  ]),
});

/** eraFL 的 2.0 adapter 数据（module 装载时深冻结一次；之后查表零构造开销） */
export const ERAFL_GAME_ADAPTER: GameAdapter = freezeAdapter({
  // 与 `ERAFL.gameId`（v1 的工程识别键）一致——宿主登记簿按 v1 gameId 建表，
  // 写错的话表现是"打开项目后 2.0 面全部零候选"且不报错（§6.3）。
  id: 'erafl',
  version: '2.0.0',
  gameFingerprint: ERAFL_GAME_FINGERPRINT,
  eventCatalog: ERAFL_EVENT_CATALOG,
  domainSymbols: ERAFL_DOMAIN_SYMBOLS,
  profile: ERAFL_PROFILE,
  presentation: ERAFL_PRESENTATION,
  storageClasses: ERAFL_STORAGE_CLASSES,
  programFeatures: ERAFL_PROGRAM_FEATURES,
  /*
   * `@巡` 集合声明：**null = 本 adapter 不支持 `@巡`**。
   *
   * 两个选项都评估过（交接文档入口 B 裁决表）：
   * - 只声明作者数组规则（`{ collections: [], arrayRule: … }`）：eraFL 确有数组
   *   声明语料（`#DIMS SAVEDATA CHARADATA CLOTH, CLOTH_PART_NUM` 形），但
   *   `@巡` 是 2.0 构造、eraFL 零 2.0 语料，且 `programFeatures.foreach` 已按
   *   "无实证"关掉——声明一条没人能发射的规则是与功能开关自相矛盾；
   * - null：语言层对 `@巡` 直接报 unsupported（fail-visible）。
   * ⇒ 取 null。入口 D 有真语料时连同 foreach 开关与发射面一起开。
   */
  foreachCollections: null,
  encodingPolicy: ERAFL_ENCODING_POLICY,
  layerPolicy: ERAFL_LAYER_POLICY,
  diagnosticNamespace: ERAFL_DIAGNOSTIC_NAMESPACE,
  capability: ERAFL_CAPABILITY,
  sourceMap: ERAFL_SOURCE_MAP,
  conformanceSuite: ERAFL_CONFORMANCE_SUITE,
});
