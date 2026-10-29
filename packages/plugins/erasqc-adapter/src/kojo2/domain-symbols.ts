/**
 * eraSQC 2.0 域符号（游戏事实 —— 只住本包）。
 *
 * 全部数值 = 2026-10-26 `D:/Game/eraSQC` 真盘读数：
 * - 代词落点 = 口上域 `ERB/EVENT_K` 111 份 `.ERB` 的 `%CALLNAME:…%` 计数；
 * - 角色属性编号 = `CSV/TALENT.CSV` / `MARK.CSV` / `ABL.CSV` 名表逐条核对；
 * - 说话人主键 = `chara-csv.ts` 的 `NAME_KEYS`（`CSV/Chara{no}.csv` 的 `名前` 行）。
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
 * 口上域实测（2026-10-26，`ERB/EVENT_K` 全量）：
 *
 * | 落点 | 计数 | 角色 |
 * | --- | --- | --- |
 * | `%CALLNAME:TARGET%` | 68,020 | 被调教角色（口上文件所属角色） |
 * | `%CALLNAME:PLAYER%` | 27,028 | 玩家（主人公） |
 * | `%CALLNAME:MASTER%` | 12,227 | 玩家的次形（系统文本更常用；口上域以 PLAYER 为主力） |
 * | `%CALLNAME:ASSI%` | 2,005 | 助手角色——独立的第四角色轴，**不映射** `{她}` |
 *
 * `{她}` 取 `TARGET`（同一角色轴的第三人称），与 `{我}` 同落点、不同
 * `viewBound`：口上文件属于该角色时 `{我}` 与 `# 视角` 目标重合；`{她}` 是
 * 从玩家视角指称同一角色，换视点仍成立。
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
    engineRef: '%CALLNAME:PLAYER%',
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
 * 八条全部来自 `state-lines.ts` 的剧情线读数（真盘条件位计数），编号逐条
 * 核对 CSV 名表：
 *
 * | 名字 | 族 | 编号 | 口上域读 / 全树写 |
 * | --- | --- | --- | --- |
 * | 恋慕 | TALENT | 85 | 23,037 读；TALENT 写 221 |
 * | 反发刻印 | MARK | 3 | 16,739 读；MARK 写 85 |
 * | 屈服刻印 | MARK | 2 | 4,375 读 |
 * | 奉仕精神 | ABL | 6 | 2,478 读；ABL 写 81 |
 * | 处女 | TALENT | 0 | 618 读 |
 * | 淫乱 | TALENT | 76 | 555 读 |
 * | 孕娠 | TALENT | 135 | 386 读 |
 * | 相思相爱 | TALENT | 211 | 297 读 |
 *
 * **全部可写**（`readonly: false`）：口上域实测有 `TALENT:` / `MARK:` / `ABL:`
 * 赋值（221 / 85 / 81 处）。eraTW 把 TALENT 标成只读是 eraTW 的事实，本作不照抄。
 */
const ATTRIBUTES: readonly AttributeSymbol[] = Object.freeze([
  Object.freeze({
    name: '恋慕',
    family: 'TALENT',
    index: 85,
    valueKind: 'int',
    readonly: false,
    description: '恋慕素质（TALENT:85；口上域读 23,037 处，本作最高频状态）',
  }),
  Object.freeze({
    name: '反发刻印',
    family: 'MARK',
    index: 3,
    valueKind: 'int',
    readonly: false,
    description: '反感 / 反抗刻印（MARK:3；口上域读 16,739 处）',
  }),
  Object.freeze({
    name: '屈服刻印',
    family: 'MARK',
    index: 2,
    valueKind: 'int',
    readonly: false,
    description: '屈服刻印（MARK:2；口上域读 4,375 处）',
  }),
  Object.freeze({
    name: '奉仕精神',
    family: 'ABL',
    index: 6,
    valueKind: 'int',
    readonly: false,
    description: '奉仕精神能力（ABL:6；口上域读 2,478 处）',
  }),
  Object.freeze({
    name: '处女',
    family: 'TALENT',
    index: 0,
    valueKind: 'int',
    readonly: false,
    description: '处女素质（TALENT:0；口上域读 618 处）',
  }),
  Object.freeze({
    name: '淫乱',
    family: 'TALENT',
    index: 76,
    valueKind: 'int',
    readonly: false,
    description: '淫乱素质（TALENT:76；口上域读 555 处）',
  }),
  Object.freeze({
    name: '孕娠',
    family: 'TALENT',
    index: 135,
    valueKind: 'int',
    readonly: false,
    description: '孕娠状态（TALENT:135；口上域读 386 处）',
  }),
  Object.freeze({
    name: '相思相爱',
    family: 'TALENT',
    index: 211,
    valueKind: 'int',
    readonly: false,
    description: '相思相爱素质（TALENT:211；口上域读 297 处）',
  }),
]);

/* ------------------------------ 名字函数 ------------------------------ */

/**
 * **空表**（有意为之）：本包没有 `library-table.ts` 一类的既有库函数台账，
 * 没有可派生的"中文名 → 引擎函数"单一真源。名字落点已由三个代词表达；
 * 零条登记 = 语言层零候选，不借 eraTW 的 `CHARA_TEXT` 一族。
 */
const NAME_FUNCTIONS: readonly NameFunctionSymbol[] = Object.freeze([]);

/* ------------------------------ 域符号变量 ------------------------------ */

/**
 * 作者可写的引擎全局标量（additive 面）。按口上域 `ERB/EVENT_K` 裸写计数
 * （2026-10-26）逐条收：`ARG` 1,577 / `RESULT` 932 / `TIME` 103 / `MONEY` 55 /
 * `RESULTS` 1。五条均为整数槽，`readonly` 省略（= 可写）。
 *
 * 未收：角色作用域选择器（`TARGET` / `PLAYER` / `ASSI` 等）——2.0 已有代词面；
 * `ARGS` 字符串数组——本 adapter 未在 2.0 侧落点。
 */
const VARIABLES: readonly DomainVariableSymbol[] = Object.freeze([
  Object.freeze({ name: 'RESULTS', valueKind: 'int' as const }),
  Object.freeze({ name: 'RESULT', valueKind: 'int' as const }),
  Object.freeze({ name: 'TIME', valueKind: 'int' as const }),
  Object.freeze({ name: 'MONEY', valueKind: 'int' as const }),
  Object.freeze({ name: 'ARG', valueKind: 'int' as const }),
]);

/* ------------------------------ 汇总 ------------------------------ */

/**
 * 说话人是**开放名表**：`CSV/Chara{no}.csv`（直接住 CSV 根，63 份实测），
 * 主键是 `名前`（`chara-csv.ts` 的 `NAME_KEYS`），不是 Emuera 的 `CALLNAME`
 * 列名。`kind: 'project'` 表示名字合法性交给项目级分析，不把角色名抄进契约。
 */
export const ERASQC_DOMAIN_SYMBOLS: DomainSymbols = Object.freeze({
  pronouns: PRONOUNS,
  attributes: ATTRIBUTES,
  nameFunctions: NAME_FUNCTIONS,
  variables: VARIABLES,
  speakers: Object.freeze({ kind: 'project' as const, table: 'CSV', key: '名前' }),
  unknown: 'error',
});
