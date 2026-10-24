/**
 * eraFL 2.0 域符号（游戏事实 —— 只住本包）。
 *
 * core 不内置任何一条：`{我}` / `{你}` / `{她}`、角色属性、说话人全部查本表。
 *
 * 落点来源（不抄第二份词表）：
 * - **代词**：v1 `preview/interpolate.ts` 的记号表（口上台词替换记号的单一真源）——
 *   `%CALLNAME:MASTER%`（角色对主人公的称呼）/ `%CNAME%`（角色名）/
 *   `%CALLNAME:<角色号>`（第三方，参数为数字）。eraFL 的代词**在 XML 文本里**，
 *   不在 ERB 表达式里；ERB 侧只剩注册壳（§2.1），壳函数不写代词。
 * - **角色属性**：真盘 CSV 逐行读数（2026-10-24）——`CSV/CFLAG.CSV:2` = 好感度；
 *   `CSV/Talent.csv:101/103/104` = 恋慕 150 / 親愛 152 / 恋人 153。
 *   **eraTW 的编号（CFLAG:2 / TALENT:3 / 7 / 184）是 eraTW 的槽，照抄必错**：
 *   eraFL  Talent.csv 里没有愛欲（实测 grep 空）——第四条收親愛（恋慕上位），
 *   不收不存在的爱欲。
 * - **说话人**：开放名表（`kind: 'project'`）——eraFL 角色 CSV 在 `CSV/Chara/`，
 *   列头实测为 `番号,` / `名前,` / `呼び名,`（`Chara0 あなた.csv` 字节读数），
 *   取"呼び名"一列（别人怎么称呼她 = 口上里的说话人名）；SDK 层不把上千角色名
 *   抄进契约。
 */
import type {
  AttributeSymbol,
  DomainSymbols,
  NameFunctionSymbol,
  PronounSymbol,
} from '@kojo/kojo-core';

/**
 * 三个代词的落点（eraFL 口径；与 eraTW 的 TARGET 制不同，eraFL 口上按 K 编号分发）：
 * - `{我}` = 说话人（口上角色本人）→ `%CNAME%`；
 * - `{你}` = 听话人（主人公 MASTER）→ `%CALLNAME:MASTER%`（eraTW 同落点）；
 * - `{她}` = 第三方 → `%CALLNAME:<角色号>`（编号为数字；`%ANAME(…)` 一类动态
 *   实参本表算不出，原样落模板）。
 *
 * `requiresView: false`：eraFL 没有 `# 视`（视点角色是 XML 的文件级事实，
 * 不是 ERB 语句级声明）；`viewBound` 同 false。
 * `family`：名字引用的字符串族（eraTW 用 'CALLNAME'；`%CNAME%` 是名字记号，
 * 单独记 'NAME'——打印/求值按族分流，不混）。
 */
const PRONOUNS: readonly PronounSymbol[] = Object.freeze([
  Object.freeze({
    role: 'me',
    pronoun: '我',
    engineRef: '%CNAME%',
    requiresView: false,
    viewBound: false,
    family: 'NAME',
  }),
  Object.freeze({
    role: 'you',
    pronoun: '你',
    engineRef: '%CALLNAME:MASTER%',
    requiresView: false,
    viewBound: false,
    family: 'CALLNAME',
  }),
  Object.freeze({
    role: 'her',
    pronoun: '她',
    engineRef: '%CALLNAME:<角色号>',
    requiresView: false,
    viewBound: false,
    family: 'CALLNAME',
  }),
]);

/**
 * 作者常写的角色状态（编号 = 真盘 CSV 行号，2026-10-24 复测）。
 *
 * 口径同 eraTW：好感度可写；素质位（恋慕 / 親愛 / 恋人）只读。宁缺毋滥——
 * 只收有 CSV 台账证据的四条。
 */
const ATTRIBUTES: readonly AttributeSymbol[] = Object.freeze([
  Object.freeze({
    name: '好感度',
    family: 'CFLAG',
    index: 2,
    valueKind: 'int',
    readonly: false,
    description: '以角色为轴的好感数值（CFLAG.CSV:2 好感度）',
  }),
  Object.freeze({
    name: '恋慕',
    family: 'TALENT',
    index: 150,
    valueKind: 'int',
    readonly: true,
    description: '恋慕素质（Talent.csv:101 150,恋慕）',
  }),
  Object.freeze({
    name: '親愛',
    family: 'TALENT',
    index: 152,
    valueKind: 'int',
    readonly: true,
    description: '恋慕上位素质（Talent.csv:103 152,親愛）',
  }),
  Object.freeze({
    name: '恋人',
    family: 'TALENT',
    index: 153,
    valueKind: 'int',
    readonly: true,
    description: '告白成功状态（Talent.csv:104 153,恋人）',
  }),
]);

/**
 * 名字函数：**暂空**。eraTW 从 `library-table`（中文名 → 引擎函数名单一真源）
 * 派生；eraFL 的 library-table 是入口 C 的活——没有真源就不派生，不预埋空表
 * （空数组是契约合法值：`nameFunctions` 可为空）。
 */
const NAME_FUNCTIONS: readonly NameFunctionSymbol[] = Object.freeze([]);

/**
 * eraFL 域符号表。
 *
 * `variables`（外部引擎全局标量面）**省略**：eraFL 的 2.0 文件面是注册壳 +
 * XML（§2.1），两者都不写 `TIME` / `MONEY` 一类引擎全局（那些在 ERB 系统树的
 * 流程档里，不归 2.0 语言面）⇒ 没有可声明的事实，按契约省略 = 旧行为零变化。
 *
 * `unknown: 'error'`：未声明符号报错（默认）；糖视图无法表达的走 raw 是后续
 * 批次的事，现在不开口子。
 */
export const ERAFL_DOMAIN_SYMBOLS: DomainSymbols = Object.freeze({
  pronouns: PRONOUNS,
  attributes: ATTRIBUTES,
  nameFunctions: NAME_FUNCTIONS,
  speakers: Object.freeze({ kind: 'project' as const, table: 'CSV/Chara', key: '呼び名' }),
  unknown: 'error',
});
