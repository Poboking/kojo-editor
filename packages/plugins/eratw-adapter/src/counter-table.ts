/**
 * eraTW「计数器值域」名表 —— **游戏知识，只住 adapter**（1016 批）。
 *
 * `时机 计数器 <中文名>：` 里的中文名 → 计数器编号（引擎把它当 `{i}` = `TCVAR:20`
 * 派发 `M_KOJO…_MESSAGE_COUNTER_K{n}_{i}`）：只有游戏侧知道这张名表。糖层
 * （kojo-sugar）只查本表、不解释——与 `library-table.ts` / `mutator-table.ts` 同形
 * （同一 seam：adapter 建纯数据表、糖层只查）。
 *
 * ## 数据源与取数口径（eraTW 4.980 汉化语料实测）
 * - 主表：`ERB/ステータス計算関連/COUNTER/COUNTER_MESSAGE.ERB` 的
 *   `@EVENT_COUNTER_MESSAGE{n}` 定义集合（n = 计数器编号）；名取定义上方注释行
 *   （`;名` 形态），**原文照录**——不翻译、不润色（`(?)` 之类维护注记一并照录：
 *   作者在语料里看到什么名，这里就能查到什么名）。
 * - 反应表：`…/COUNTER/REACTION/COUNTER_REACTIONMESSAGE.ERB` 里经
 *   `COUNTER_REACTION.ERB` 写进 `TCVAR:ARG:20` 的反应计数器（500–510 / 601 族）。
 *
 * ## 收录判据（宁缺毋滥）
 * - **只收经 `TCVAR:20`（`{i}` 槽）能到达口上函数的编号**——REACTION 文件里只写
 *   `MASTER_COUNTER_RECORD`（引擎内记账，不过 `KOJO_MESSAGE_SEND`）的
 *   5001/5011/5021/5031/5041 一族**不收**（到不了 `M_KOJO…_MESSAGE_COUNTER` 函数）；
 * - `[SKIPSTART]` 段里的 100–113（无注释名）与 41（无名单）、141–145（只有段标签）：
 *   **不收**；
 * - 同名多编号（3/128 搭话、28/78 尻ズリ、50/502 手淫、52/505 素股、53/504 乳交、
 *   55/601 肛门爱抚）：条目按编号升序 ⇒ `lookupByName` 取**首条** = 编号小者；
 * - 号 92 / 9 等注释里带维护注记的名**原文照录**（同"作者看到什么查什么"）。
 *
 * 查不到的编号 / 名一律 `undefined`（**绝不猜**，规范 §5.3 精神）；未登记的**名**
 * 由糖层 fail-closed 报诊断（`timing-counter-unknown`，不产半成品）；纯数字令牌
 * 不查表、逐字节直通（契约 `KojoFaceTemplate.indexKind: 'counter'`）。
 */

import type { KojoCounterTable } from '@kojo/plugin-api';

/** 一条「编号 ↔ 中文名」条目（名原文照录自语料注释行；出处 `文件:行` 可回语料逐字核对） */
export interface EratwCounterEntry {
  /** 计数器编号（= 引擎写进 `TCVAR:20` 的值 = 产物函数名尾段 `{i}`） */
  readonly counter: number;
  /** 中文名（语料注释行原文照录；同名多编号时本表只留编号小者） */
  readonly label: string;
  /** 出处（`文件:行`；行 = 注释名所在行） */
  readonly source: string;
}

/**
 * 计数器名表（单一真源；手工维护，随实测增补）。
 * 按编号**升序**排列（`lookupByName` 取首条 = 编号小者的实现前提；测试钉住）。
 */
export const ERATW_COUNTER_ENTRIES: readonly EratwCounterEntry[] = [
  // ---- 主表：COUNTER_MESSAGE.ERB 的 @EVENT_COUNTER_MESSAGE{n}（行 = 注释名所在行）----
  { counter: 1, label: '距离が近い', source: 'COUNTER_MESSAGE.ERB:29' },
  { counter: 2, label: '偷看', source: 'COUNTER_MESSAGE.ERB:36' },
  { counter: 3, label: '搭话', source: 'COUNTER_MESSAGE.ERB:45' },
  { counter: 4, label: '好闻的味道', source: 'COUNTER_MESSAGE.ERB:52' },
  { counter: 9, label: '中だし后(?)', source: 'COUNTER_MESSAGE.ERB:59' },
  { counter: 11, label: '近寄ってくる', source: 'COUNTER_MESSAGE.ERB:107' },
  { counter: 12, label: '笑颜を浮かべる', source: 'COUNTER_MESSAGE.ERB:131' },
  { counter: 13, label: '构って欲しがる', source: 'COUNTER_MESSAGE.ERB:158' },
  { counter: 14, label: '身をすり寄せる', source: 'COUNTER_MESSAGE.ERB:181' },
  { counter: 15, label: '凝视着', source: 'COUNTER_MESSAGE.ERB:209' },
  { counter: 16, label: '肩上搁下巴', source: 'COUNTER_MESSAGE.ERB:237' },
  { counter: 17, label: '送来点心', source: 'COUNTER_MESSAGE.ERB:244' },
  { counter: 20, label: '色っぽい仕草', source: 'COUNTER_MESSAGE.ERB:253' },
  { counter: 21, label: '见つめる 盯着看', source: 'COUNTER_MESSAGE.ERB:283' },
  { counter: 22, label: '体を摺り寄せる', source: 'COUNTER_MESSAGE.ERB:311' },
  { counter: 23, label: '掀裙子', source: 'COUNTER_MESSAGE.ERB:339' },
  { counter: 24, label: '吹气', source: 'COUNTER_MESSAGE.ERB:373' },
  { counter: 25, label: '抚摸臀部', source: 'COUNTER_MESSAGE.ERB:404' },
  { counter: 26, label: '腕抱き付き', source: 'COUNTER_MESSAGE.ERB:435' },
  { counter: 27, label: '谷间を见せる', source: 'COUNTER_MESSAGE.ERB:466' },
  { counter: 28, label: '尻ズリ', source: 'COUNTER_MESSAGE.ERB:513' },
  { counter: 30, label: '接吻', source: 'COUNTER_MESSAGE.ERB:541' },
  { counter: 31, label: '从后面抱住', source: 'COUNTER_MESSAGE.ERB:635' },
  { counter: 32, label: '从前面抱住', source: 'COUNTER_MESSAGE.ERB:665' },
  { counter: 33, label: '胸を揉ませる', source: 'COUNTER_MESSAGE.ERB:715' },
  { counter: 34, label: '抚摸胯下', source: 'COUNTER_MESSAGE.ERB:746' },
  { counter: 35, label: '裙子の中を见せる', source: 'COUNTER_MESSAGE.ERB:769' },
  { counter: 36, label: '从后面将胸もみもみ', source: 'COUNTER_MESSAGE.ERB:815' },
  { counter: 39, label: '糖强夺', source: 'COUNTER_MESSAGE.ERB:841' },
  { counter: 43, label: '后背位Ｖ插入おねだり', source: 'COUNTER_MESSAGE.ERB:870' },
  { counter: 44, label: '后背位Ａ插入おねだり', source: 'COUNTER_MESSAGE.ERB:899' },
  { counter: 50, label: '手淫', source: 'COUNTER_MESSAGE.ERB:922' },
  { counter: 51, label: '口淫', source: 'COUNTER_MESSAGE.ERB:1025' },
  { counter: 52, label: '素股', source: 'COUNTER_MESSAGE.ERB:1084' },
  { counter: 53, label: '乳交', source: 'COUNTER_MESSAGE.ERB:1146' },
  { counter: 54, label: '足交', source: 'COUNTER_MESSAGE.ERB:1189' },
  { counter: 55, label: '肛门爱抚', source: 'COUNTER_MESSAGE.ERB:1251' },
  { counter: 56, label: '舐肛', source: 'COUNTER_MESSAGE.ERB:1281' },
  { counter: 57, label: '指插入', source: 'COUNTER_MESSAGE.ERB:1310' },
  { counter: 58, label: '胸爱抚', source: 'COUNTER_MESSAGE.ERB:1337' },
  { counter: 59, label: '吸乳头', source: 'COUNTER_MESSAGE.ERB:1404' },
  { counter: 60, label: 'ディープキス', source: 'COUNTER_MESSAGE.ERB:1440' },
  { counter: 61, label: '误爆插入', source: 'COUNTER_MESSAGE.ERB:1468' },
  { counter: 70, label: '强制舐阴', source: 'COUNTER_MESSAGE.ERB:1483' },
  { counter: 71, label: '强制口暴（必须是肉棒，与上一指令对立）', source: 'COUNTER_MESSAGE.ERB:1510' },
  { counter: 72, label: '肛门侍奉', source: 'COUNTER_MESSAGE.ERB:1545' },
  { counter: 73, label: 'ぱふぱふ', source: 'COUNTER_MESSAGE.ERB:1575' },
  { counter: 74, label: '乳合わせ', source: 'COUNTER_MESSAGE.ERB:1673' },
  { counter: 75, label: 'タワシ洗い', source: 'COUNTER_MESSAGE.ERB:1725' },
  { counter: 76, label: '强制アソコ爱抚', source: 'COUNTER_MESSAGE.ERB:1759' },
  { counter: 77, label: '乳を吸わせる', source: 'COUNTER_MESSAGE.ERB:1812' },
  { counter: 78, label: '尻ズリ', source: 'COUNTER_MESSAGE.ERB:1849' },
  { counter: 80, label: '正常位Ｖ插入される', source: 'COUNTER_MESSAGE.ERB:1878' },
  { counter: 83, label: '后背位Ｖ插入される', source: 'COUNTER_MESSAGE.ERB:1969' },
  { counter: 84, label: '摇腰V承受', source: 'COUNTER_MESSAGE.ERB:2051' },
  { counter: 85, label: 'TARGET被插入', source: 'COUNTER_MESSAGE.ERB:2137' },
  { counter: 86, label: '超喜欢所以抱住不放', source: 'COUNTER_MESSAGE.ERB:2197' },
  { counter: 87, label: 'A插入', source: 'COUNTER_MESSAGE.ERB:2249' },
  { counter: 88, label: '摆腰V插入', source: 'COUNTER_MESSAGE.ERB:2281' },
  { counter: 89, label: '腰振りA', source: 'COUNTER_MESSAGE.ERB:2368' },
  { counter: 90, label: '后背位A插入される', source: 'COUNTER_MESSAGE.ERB:2450' },
  { counter: 91, label: '被深喉', source: 'COUNTER_MESSAGE.ERB:2487' },
  {
    counter: 92,
    label: '肛门开发许可を求める（ 现在没有这个C指令 确认时点：2026年1月24日',
    source: 'COUNTER_MESSAGE.ERB:2522',
  },
  { counter: 93, label: '你摆腰被A', source: 'COUNTER_MESSAGE.ERB:2554' },
  { counter: 94, label: '正常位A插入される', source: 'COUNTER_MESSAGE.ERB:2628' },
  { counter: 120, label: '头抚で', source: 'COUNTER_MESSAGE.ERB:2725' },
  { counter: 121, label: '发梳き', source: 'COUNTER_MESSAGE.ERB:2732' },
  { counter: 122, label: '抱きつき', source: 'COUNTER_MESSAGE.ERB:2739' },
  { counter: 123, label: '抱きしめ', source: 'COUNTER_MESSAGE.ERB:2751' },
  { counter: 124, label: '颊抚で', source: 'COUNTER_MESSAGE.ERB:2767' },
  { counter: 125, label: 'くすぐり', source: 'COUNTER_MESSAGE.ERB:2774' },
  { counter: 126, label: '让其枕膝', source: 'COUNTER_MESSAGE.ERB:2783' },
  { counter: 127, label: '闻气味', source: 'COUNTER_MESSAGE.ERB:2790' },
  { counter: 128, label: '搭话', source: 'COUNTER_MESSAGE.ERB:2797' },
  { counter: 129, label: '舔脖颈', source: 'COUNTER_MESSAGE.ERB:2804' },
  // ---- 反应表：REACTION/COUNTER_REACTIONMESSAGE.ERB（经 COUNTER_REACTION.ERB 写 TCVAR:20）----
  { counter: 500, label: '膣性交', source: 'REACTION/COUNTER_REACTIONMESSAGE.ERB:107' },
  { counter: 501, label: '肛门性交', source: 'REACTION/COUNTER_REACTIONMESSAGE.ERB:135' },
  { counter: 502, label: '手淫', source: 'REACTION/COUNTER_REACTIONMESSAGE.ERB:151' },
  { counter: 503, label: '口交', source: 'REACTION/COUNTER_REACTIONMESSAGE.ERB:204' },
  { counter: 504, label: '乳交', source: 'REACTION/COUNTER_REACTIONMESSAGE.ERB:227' },
  { counter: 505, label: '素股', source: 'REACTION/COUNTER_REACTIONMESSAGE.ERB:260' },
  { counter: 506, label: '强行膣性交', source: 'REACTION/COUNTER_REACTIONMESSAGE.ERB:288' },
  { counter: 510, label: '被玩弄乳头', source: 'REACTION/COUNTER_REACTIONMESSAGE.ERB:306' },
  { counter: 601, label: '肛门爱抚', source: 'REACTION/COUNTER_REACTIONMESSAGE.ERB:338' },
];

/**
 * 由条目表构建查询面（纯数据，无 IO）。
 * - 正查 / 反查各取**首条**（条目按编号升序 ⇒ 名重复时首条 = 编号小者）；
 * - `hasTable`：空条目表 = false（糖层对名路径 fail-closed；数字路径不查表、不受影响）。
 */
export function createEratwCounterTable(entries: readonly EratwCounterEntry[]): KojoCounterTable {
  const byNumber = new Map<number, string>();
  const byName = new Map<string, number>();
  for (const e of entries) {
    if (!byNumber.has(e.counter)) byNumber.set(e.counter, e.label);
    if (!byName.has(e.label)) byName.set(e.label, e.counter);
  }
  return {
    hasTable: byNumber.size > 0,
    lookupByNumber: (no) => byNumber.get(no),
    lookupByName: (name) => byName.get(name),
    // IX-1 批：正向枚举（编号槽补全用）。`byName` 的插入序 = 条目原序（编号升序）且已按名去重
    // ⇒ 返回序即表层候选展示序，与 `lookupByName` 取首条同口径（先出现的名先展示）。
    names: () => [...byName.keys()],
  };
}

/** 空表实例（未声明适配器时的缺省形态；`hasTable=false`，查啥都 undefined）。 */
export const EMPTY_COUNTER_TABLE: KojoCounterTable = createEratwCounterTable([]);
