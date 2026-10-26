/**
 * eratohoReverse 2.0 域符号（游戏事实 —— 只住本包）。
 *
 * 全部数值 = 2026-10-26 `C:/game/eratohoReverse` 真盘读数：
 * - 代词口径 = 口上域 `ERB/口上/` 全量 `.ERB` 的 `%CALLNAME:…%` 与裸用计数；
 * - 角色属性编号 = `CSV/Talent.csv` / `CSV/Cflag.csv` 名表逐条核对（族:编号；
 *   本作名表是机翻简体，**收「口上域有真实使用」的条目，不用零使用的**——
 *   恋慕(TALENT:78) / 隶属(TALENT:79) 虽有名表行，口上域 0 处使用 ⇒ 不收）；
 * - 说话人主键 = `CSV/CHARA/Chara{no}_{名前}.csv` 的 `名前` 行（108 份）。
 */
import type {
  AttributeSymbol,
  DomainSymbols,
  DomainVariableSymbol,
  NameFunctionSymbol,
  PronounSymbol,
} from '@kojo/kojo-core';

/* ------------------------------ 代词 ------------------------------ */

/**
 * 口上域实测（2026-10-26，`ERB/口上` 全量）：
 *
 * | 落点 | 全树 | 口上域 |
 * | --- | --- | --- |
 * | `MASTER`（裸用） | 33,944 | 21,950 |
 * | `TARGET`（裸用） | 12,164 | 9,579 |
 * | `%CALLNAME:MASTER%` | 9,990 | 7,727 |
 * | `%CALLNAME:TARGET%` | 2,989 | 1,926 |
 *
 * 裸用是 ERB 变量直接参与条件/赋值；2.0 代词的 `engineRef` 要的是**名字打印模板**
 * ⇒ 两处都取 `%CALLNAME:…%` 形（引擎同一名字族，不是自造词）。
 *
 * `{我}` 取 `TARGET`（口上文件所属角色），`viewBound: true`：口上文件属于该角色时
 * `{我}` 与 `# 视` 目标重合。`{她}` 同落点但 `viewBound: false`——从玩家视角指称
 * 同一角色，换视点仍成立。`{你}` 取 `MASTER`，不依赖视点。
 */
const PRONOUNS: readonly PronounSymbol[] = Object.freeze([
  Object.freeze({
    role: 'me',
    pronoun: '我',
    engineRef: '%CALLNAME:TARGET%',
    requiresView: true,
    viewBound: true,
    family: 'CALLNAME',
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
    engineRef: '%CALLNAME:TARGET%',
    requiresView: true,
    viewBound: false,
    family: 'CALLNAME',
  }),
]);

/* ------------------------------ 角色属性 ------------------------------ */

/**
 * 六条编号逐条与 CSV 名表核对（2026-10-26），收录判据 = CSV 名表有名 + 口上域有
 * 真实使用，两条全过；**本作编号与 eraTW 全部不同**（处女 0 vs eraTW 1）：
 *
 * | 名字 | 族 | 编号 | 口上域使用 | 依据 |
 * | --- | --- | --- | --- | --- |
 * | 处女 | TALENT | 0 | 名字形 130 处 | `CSV/Talent.csv:12` |
 * | 主人 | TALENT | 131 | 名字形 58 + 数字形 20 | `CSV/Talent.csv`（131,主人）；「主人公素质」 |
 * | 调教回数 | CFLAG | 200 | 名字形 78 处 | `CSV/Cflag.csv:92` |
 * | M好感 | CFLAG | 2 | 名字形 9 处 | `CSV/Cflag.csv:14`（调教者→调教对象的好感） |
 * | 好感 | CFLAG | 9 | 名字形 7 处 | `CSV/Cflag.csv:28`（调教对象→调教者的好感） |
 * | 合意 | CFLAG | 3 | 名字形 5 处 | `CSV/Cflag.csv:16`（本作合意在 CFLAG，不是 TALENT） |
 *
 * **全部可写**（`readonly: false` 省略 = 可写）：口上域 CFLAG 名字形赋值与
 * TALENT 名字形读并存（调教回数 78 处就是作者自记的计数槽）。eraTW 把 TALENT
 * 标成只读是 eraTW 的事实，本作不照抄。
 */
const ATTRIBUTES: readonly AttributeSymbol[] = Object.freeze([
  Object.freeze({
    name: '处女',
    family: 'TALENT',
    index: 0,
    valueKind: 'int',
    readonly: false,
    description: '处女素质（TALENT:处女；口上域名字形 130 处。注意本作编号是 0，不是 eraTW 的 1）',
  }),
  Object.freeze({
    name: '主人',
    family: 'TALENT',
    index: 131,
    valueKind: 'int',
    readonly: false,
    description: '主人素质（TALENT:主人=131；口上域名字形 58 + 数字形 20 处）',
  }),
  Object.freeze({
    name: '调教回数',
    family: 'CFLAG',
    index: 200,
    valueKind: 'int',
    readonly: false,
    description: '调教回数（CFLAG:200；口上域名字形 78 处，作者自记的计数槽）',
  }),
  Object.freeze({
    name: 'M好感',
    family: 'CFLAG',
    index: 2,
    valueKind: 'int',
    readonly: false,
    description: 'M好感（CFLAG:2；调教者→调教对象的好感，口上域名字形 9 处）',
  }),
  Object.freeze({
    name: '好感',
    family: 'CFLAG',
    index: 9,
    valueKind: 'int',
    readonly: false,
    description: '好感（CFLAG:9；调教对象→调教者的好感，口上域名字形 7 处）',
  }),
  Object.freeze({
    name: '合意',
    family: 'CFLAG',
    index: 3,
    valueKind: 'int',
    readonly: false,
    description: '合意（CFLAG:3；口上域名字形 5 处。本作合意在 CFLAG 族，与 eraTW 的 TALENT:160 不同族）',
  }),
]);

/* ------------------------------ 名字函数 ------------------------------ */

/**
 * **空表**（有意为之）：本包没有既有库函数台账，没有可派生的"中文名 → 引擎函数"
 * 单一真源。名字落点已由三个代词表达；零条登记 = 语言层零候选，不借 eraTW 的
 * `CHARA_TEXT` 一族。
 */
const NAME_FUNCTIONS: readonly NameFunctionSymbol[] = Object.freeze([]);

/* ------------------------------ 域符号变量 ------------------------------ */

/**
 * 作者可写的引擎全局标量（additive 面）。全树裸用计数（2026-10-26）：
 * `ARG` 12,468 / `RESULT` 2,874 / `RESULTS` 286 / `TIME` 116 / `MONEY` 5；
 * 口上域对应 4,925 / 1,747 / 141 / 78 / 0。五条均为整数槽，`readonly` 省略（= 可写）。
 *
 * 未收：角色作用域选择器（`TARGET` / `MASTER` 等）——2.0 已有代词面。
 */
const VARIABLES: readonly DomainVariableSymbol[] = Object.freeze([
  Object.freeze({ name: 'ARG', valueKind: 'int' as const }),
  Object.freeze({ name: 'RESULT', valueKind: 'int' as const }),
  Object.freeze({ name: 'TIME', valueKind: 'int' as const }),
  Object.freeze({ name: 'MONEY', valueKind: 'int' as const }),
  Object.freeze({ name: 'RESULTS', valueKind: 'int' as const }),
]);

/* ------------------------------ 汇总 ------------------------------ */

/**
 * 说话人是**开放名表**：`CSV/CHARA/Chara{no}_{名前}.csv`（108 份实测，目录名全大写），
 * 主键是 `名前`（同时容忍汉化改键），不是 Emuera 的 `CALLNAME` 列名。
 * `kind: 'project'` 表示名字合法性交给项目级分析，不把角色名抄进契约。
 */
export const ERATOHOREVERSE_DOMAIN_SYMBOLS: DomainSymbols = Object.freeze({
  pronouns: PRONOUNS,
  attributes: ATTRIBUTES,
  nameFunctions: NAME_FUNCTIONS,
  variables: VARIABLES,
  speakers: Object.freeze({ kind: 'project' as const, table: 'CSV/CHARA', key: '名前' }),
  unknown: 'error',
});
