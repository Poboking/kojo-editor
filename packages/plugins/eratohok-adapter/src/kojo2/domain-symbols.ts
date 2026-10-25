/**
 * eratohoK 2.0 域符号（游戏事实 —— 只住本包）。
 *
 * 全部数值 = 2026-10-26 `D:/Game/eratohok` 真盘读数：
 * - 代词口径 = 口上域 `ERB/口上` 694 份 `.ERB` 的 `%CALLNAME:…%` 与裸用计数；
 * - 角色属性编号 = `CSV/Talent.csv` / `CSV/CFLAG.CSV` 名表逐条核对（族:编号）；
 * - 说话人主键 = `chara-csv.ts` 的 `NAME_KEYS`（`CSV/Chara/Chara{no} {名前}.csv` 的 `名前` 行）。
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
 * | 落点 | 计数 | 角色 |
 * | --- | --- | --- |
 * | `TARGET`（裸用） | 34,874 | 被调教角色（口上文件所属角色） |
 * | `MASTER`（裸用） | 50,126 | 玩家（主人公） |
 * | `%CALLNAME:MASTER%` | 30 | 玩家的 CALLNAME 打印形 |
 * | `%CALLNAME:TARGET%` | 2 | 被调教角色的 CALLNAME 打印形 |
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
 * 八条编号逐条与 CSV 名表核对（2026-10-26）：
 *
 * | 名字 | 族 | 编号 | 口上域读计数 | 依据 |
 * | --- | --- | --- | --- | --- |
 * | 好感度 | CFLAG | 2 | 262（作用域形 328） | `CSV/CFLAG.CSV` |
 * | 恋慕 | TALENT | 150 | 41,622 | `CSV/Talent.csv` |
 * | 服従 | TALENT | 154 | 40,698 | `CSV/Talent.csv` |
 * | 恋人 | TALENT | 153 | 4,881 | `CSV/Talent.csv` |
 * | 合意 | TALENT | 160 | 4,040 | `CSV/Talent.csv` |
 * | 親友 | TALENT | 151 | 2,866 | `CSV/Talent.csv` |
 * | 隷属 | TALENT | 155 | 867 | `CSV/Talent.csv` |
 * | 処女 | TALENT | 1 | 1,034（作用域形 1,183） | `CSV/Talent.csv` |
 *
 * **全部可写**（`readonly: false`）：口上域实测 `TALENT:` 赋值 351 处 /
 * `CFLAG:` 2,555 处 / `ABL:` 141 处。eraTW 把 TALENT 标成只读是 eraTW 的事实，
 * 本作不照抄。
 */
const ATTRIBUTES: readonly AttributeSymbol[] = Object.freeze([
  Object.freeze({
    name: '好感度',
    family: 'CFLAG',
    index: 2,
    valueKind: 'int',
    readonly: false,
    description: '好感度（CFLAG:2；口上域读 262 处，作用域形 `CFLAG:対象:好感度` 328 处）',
  }),
  Object.freeze({
    name: '恋慕',
    family: 'TALENT',
    index: 150,
    valueKind: 'int',
    readonly: false,
    description: '恋慕素质（TALENT:150；口上域读 41,622 处，本作最高频状态）',
  }),
  Object.freeze({
    name: '服従',
    family: 'TALENT',
    index: 154,
    valueKind: 'int',
    readonly: false,
    description: '服従素质（TALENT:154；口上域读 40,698 处，仅次于恋慕）',
  }),
  Object.freeze({
    name: '恋人',
    family: 'TALENT',
    index: 153,
    valueKind: 'int',
    readonly: false,
    description: '恋人关系（TALENT:153；口上域读 4,881 处）',
  }),
  Object.freeze({
    name: '合意',
    family: 'TALENT',
    index: 160,
    valueKind: 'int',
    readonly: false,
    description: '合意许可位（TALENT:160；口上域读 4,040 处）',
  }),
  Object.freeze({
    name: '親友',
    family: 'TALENT',
    index: 151,
    valueKind: 'int',
    readonly: false,
    description: '親友素质（TALENT:151；口上域读 2,866 处）',
  }),
  Object.freeze({
    name: '隷属',
    family: 'TALENT',
    index: 155,
    valueKind: 'int',
    readonly: false,
    description: '隷属素质（TALENT:155；口上域读 867 处）',
  }),
  Object.freeze({
    name: '処女',
    family: 'TALENT',
    index: 1,
    valueKind: 'int',
    readonly: false,
    description:
      '処女素质（TALENT:1；口上域读 1,034 处，作用域形 `TALENT:MASTER:処女` 另有 1,183 处）',
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
 * 作者可写的引擎全局标量（additive 面）。全树裸用计数（2026-10-26）：
 * `ARG` 30,429 / `RESULT` 5,368 / `RESULTS` 3,167 / `MONEY` 791 / `TIME` 25；
 * 口上域对应 5,065 / 1,112 / 52 / 99 / 0。五条均为整数槽，`readonly` 省略（= 可写）。
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
 * 说话人是**开放名表**：`CSV/Chara/Chara{no} {名前}.csv`（174 份实测），
 * 主键是 `名前`（`chara-csv.ts` 的 `NAME_KEYS`，同时容忍汉化改键），
 * 不是 Emuera 的 `CALLNAME` 列名。`kind: 'project'` 表示名字合法性交给项目级分析，
 * 不把角色名抄进契约。
 */
export const ERATOHOK_DOMAIN_SYMBOLS: DomainSymbols = Object.freeze({
  pronouns: PRONOUNS,
  attributes: ATTRIBUTES,
  nameFunctions: NAME_FUNCTIONS,
  variables: VARIABLES,
  speakers: Object.freeze({ kind: 'project' as const, table: 'CSV/Chara', key: '名前' }),
  unknown: 'error',
});
