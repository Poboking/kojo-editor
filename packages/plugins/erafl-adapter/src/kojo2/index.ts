/**
 * eraFL 2.0 适配数据总装（游戏事实 —— 只住本包）。
 *
 * `ERAFL_GAME_ADAPTER` 是 `GameAdapter` 契约的 eraFL 实现：**纯数据、零 IO、深冻结**。
 * core 侧只通过契约字段消费它，不认识本文件里的任何游戏名词。
 *
 * 分层位置（设计稿 §1.1）：
 *   core（`@kojo/kojo-core`）  ── 语法/AST/诊断，零游戏名词
 *   adapter-sdk（`adapter.ts`） ── 契约形状（本对象实现的类型）
 *   本目录（erafl-adapter/kojo2） ── 4 个引擎事件 / 代词落点 / 编码策略 / 存储期
 *   宿主                       ── 接线与 Monaco/tree-sitter
 *
 * 与 eraTW 的 `kojo2/`（16 件 / 2,666 行）是**裁剪关系不是照抄关系**：eraFL
 * 口上主形态是 XML、ERB 只剩注册壳（§2.1），九事件里只有 4 个是真定义（§2.4），
 * 编码是 UTF-8 BOM + CRLF 而非 UTF-16LE（§2.3）——每一件文件的头注都写了
 * 该字段的真盘读数与"为什么不能照抄"。
 *
 * 宿主侧接线（入口 A 已落地）：`bootstrap.ts` 的 `KOJO2_ADAPTERS` 表按
 * `project.adapterId`（= v1 `ERAFL.gameId`）解析到本对象，注入六条 2.0 语言腿。
 */
import type { GameAdapter, GameFingerprint } from '@kojo/kojo-core';
import { freezeAdapter } from '@kojo/kojo-core';

import { ERAFL_EVENT_CATALOG } from './event-catalog.js';
import { ERAFL_DOMAIN_SYMBOLS } from './domain-symbols.js';
import { ERAFL_PROFILE } from './profile.js';
import { ERAFL_PRESENTATION } from './presentation.js';
import { ERAFL_STORAGE_CLASSES } from './storage.js';
import { ERAFL_PROGRAM_FEATURES } from './program.js';
import { ERAFL_FOREACH_DECLARATIONS } from './collections.js';
import {
  ERAFL_CAPABILITY,
  ERAFL_CONFORMANCE_SUITE,
  ERAFL_DIAGNOSTIC_NAMESPACE,
  ERAFL_ENCODING_POLICY,
  ERAFL_LAYER_POLICY,
  ERAFL_SOURCE_MAP,
} from './capabilities.js';

export * from './event-catalog.js';
export * from './domain-symbols.js';
export * from './profile.js';
export * from './presentation.js';
export * from './storage.js';
export * from './program.js';
export * from './collections.js';
export * from './capabilities.js';

/**
 * 游戏指纹：引擎 / CSV / ERH / 本地化四段。换盘或换汉化包时 digest 必须变化，
 * 否则存档槽位会静默错位（§10.4）。
 *
 * 真盘读数（2026-10-24，D:/Game/erafl）：
 * - engine：根目录 `EmueraFL_v1.45-preview.exe`（eraFL 的引擎可执行文件名）；
 * - csv：`CSV/` 表组（`Abl.csv` / `Talent.csv` / `CFLAG.CSV` 等，大小写混用）；
 * - erh：`ERB/VARIABLE.ERH` + `ERB/VARIABLE_RELATION.ERH`（引擎变量字典）；
 * - locale：内容语料全日语（ERB / 口上 XML / CSV 的字节序列均为日文），
 *   原版无汉化包——`FLconfig.xml` 是外部服务配置（含简中注释），不充当本地化证据。
 */
export const ERAFL_GAME_FINGERPRINT: GameFingerprint = Object.freeze({
  digest: 'erafl-1.45-ja',
  entries: Object.freeze([
    Object.freeze({ kind: 'engine' as const, value: 'EmueraFL v1.45-preview' }),
    Object.freeze({ kind: 'csv' as const, value: 'eraFL v1.45 CSV 表组' }),
    Object.freeze({ kind: 'erh' as const, value: 'eraFL VARIABLE.ERH' }),
    Object.freeze({ kind: 'locale' as const, value: 'ja-JP（原版日文，无汉化包）' }),
  ]),
});

/** eraFL 的 2.0 adapter 数据（module 装载时深冻结一次；之后查表零构造开销） */
export const ERAFL_GAME_ADAPTER: GameAdapter = freezeAdapter({
  id: 'erafl',
  version: '2.0.0',
  gameFingerprint: ERAFL_GAME_FINGERPRINT,
  eventCatalog: ERAFL_EVENT_CATALOG,
  domainSymbols: ERAFL_DOMAIN_SYMBOLS,
  profile: ERAFL_PROFILE,
  presentation: ERAFL_PRESENTATION,
  storageClasses: ERAFL_STORAGE_CLASSES,
  programFeatures: ERAFL_PROGRAM_FEATURES,
  foreachCollections: ERAFL_FOREACH_DECLARATIONS,
  encodingPolicy: ERAFL_ENCODING_POLICY,
  layerPolicy: ERAFL_LAYER_POLICY,
  diagnosticNamespace: ERAFL_DIAGNOSTIC_NAMESPACE,
  capability: ERAFL_CAPABILITY,
  sourceMap: ERAFL_SOURCE_MAP,
  conformanceSuite: ERAFL_CONFORMANCE_SUITE,
});
