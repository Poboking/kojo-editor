/**
 * eraAV 2.0 域符号（游戏事实 —— 只住本包）。
 *
 * 全部数值 = 2026-10-26 `C:/game/eraAV` 真盘读数：
 * - 代词口径 = 口上域 `ERB/Lines/` 17 份 `.ERB` 的 `%CALLNAME:…%` 与裸用计数；
 * - 角色属性编号 = `CSV/Talent.csv` 名表逐条核对（族:编号；本作名表是**简体汉化**，
 *   且**没有 CFLAG.CSV**——CFLAG 引用全树 19,138 处全是数字索引，无名字可锚）；
 * - 说话人主键 = `CSV/Chara/Chara{n}_{名}.csv` 的 `名前` 行（120 份）。
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
 * 口上域实测（2026-10-26，`ERB/Lines/` 全量）：
 *
 * | 落点 | 全树 | 口上域 |
 * | --- | --- | --- |
 * | `TARGET`（裸用） | 9,522 | 4,406 |
 * | `MASTER`（裸用） | 2,397 | 599 |
 * | `%CALLNAME:MASTER%` | 1,341 | 589 |
 * | `%CALLNAME:TARGET%` | 2,072 | 384 |
 *
 * 裸用是 ERB 变量直接参与条件/赋值；2.0 代词的 `engineRef` 要的是**名字打印模板**
 * ⇒ 取 `%CALLNAME:…%` 形（引擎同一名字族，不是自造词）。
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
 * 本作是营业向游戏，eraTW 那套关系属性（恋慕 / 恋人 / 合意 / 親友 / 隷属）在
 * `CSV/Talent.csv` 里**根本没有对应条目**——不借别作的号。收录判据：CSV 名表有名 +
 * 口上域有真实使用，三条全过：
 *
 * | 名字 | 族 | 编号 | 口上域使用 | 依据 |
 * | --- | --- | --- | --- | --- |
 * | 爱慕 | TALENT | 85 | 数字形 673 处；赋值 531 行 | `CSV/Talent.csv:86`；本作口上最高频素质 |
 * | 处女 | TALENT | 0 | 数字形 88 + 名字形 `TALENT:处女` 14；赋值 93 行 | `CSV/Talent.csv:4`（本作处女=0，与 eraTW 的 1 不同） |
 * | 崩坏 | TALENT | 9 | 32 处（全部是赋值形） | `CSV/Talent.csv:7`；营业满足度下降的开关 |
 *
 * **全部可写**（`readonly: false`）：口上域实测三者的赋值行都在（爱慕 531 / 处女 93 /
 * 崩坏 32）——本作口上是"营业养成"写法，作者 routinely 改素质。
 * `好感度` 不收：本作没有 CFLAG.CSV，CFLAG 引用全是数字索引（201 / 306 / …），
 * 没有名表行可锚 ⇒ 无从声明一个可靠的名字→编号对照。
 */
const ATTRIBUTES: readonly AttributeSymbol[] = Object.freeze([
  Object.freeze({
    name: '爱慕',
    family: 'TALENT',
    index: 85,
    valueKind: 'int',
    readonly: false,
    description: '爱慕素质（TALENT:85；口上域使用 673 处 / 赋值 531 行，本作最高频）',
  }),
  Object.freeze({
    name: '处女',
    family: 'TALENT',
    index: 0,
    valueKind: 'int',
    readonly: false,
    description: '处女素质（TALENT:0；口上域数字形 88 + 名字形 14 处。注意本作编号是 0，不是 eraTW 的 1）',
  }),
  Object.freeze({
    name: '崩坏',
    family: 'TALENT',
    index: 9,
    valueKind: 'int',
    readonly: false,
    description: '崩坏素质（TALENT:9；口上域 32 处；作者注释「売却额がかなり低下」）',
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
 * `RESULT` 3,236 / `ARG` 1,109 / `MONEY` 412 / `RESULTS` 322 / `TIME` 70；
 * 口上域对应 7 / 0 / 0 / 0 / 5。五条均为整数槽，`readonly` 省略（= 可写）。
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
 * 说话人是**开放名表**：`CSV/Chara/Chara{n}_{名}.csv`（120 份实测），
 * 主键是 `名前`（同时容忍汉化改键），不是 Emuera 的 `CALLNAME` 列名。
 * `kind: 'project'` 表示名字合法性交给项目级分析，不把角色名抄进契约。
 */
export const ERAAV_DOMAIN_SYMBOLS: DomainSymbols = Object.freeze({
  pronouns: PRONOUNS,
  attributes: ATTRIBUTES,
  nameFunctions: NAME_FUNCTIONS,
  variables: VARIABLES,
  speakers: Object.freeze({ kind: 'project' as const, table: 'CSV/Chara', key: '名前' }),
  unknown: 'error',
});
