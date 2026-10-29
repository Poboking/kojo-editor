/**
 * era紅魔館 2.0 域符号（游戏事实 —— 只住本包）。
 *
 * **证据 = 2026-10-26 `D:/Game/eraKoumakan` 真盘读数**（全部数值）：
 * - 代词口径 = 口上域 `ERB/口上` 64 份 `.ERB` 的 `%CALLNAME:…%` 与裸用计数；
 * - 属性编号 = `CSV/CFLAG.csv` / `CSV/Talent.csv` / `CSV/Mark.csv` 名表逐条核对
 *   （CFLAG 329 条 / TALENT 112 条 / MARK 6 条）；
 * - 说话人主键 = `chara-csv.ts` 的 `NAME_KEYS`（`CSV/Chara{no}.csv` 的 `名前` 行，
 *   盘面 18 份角色 CSV）。
 *
 * **本作主人公是 `奴隷`**（不是 `TARGET`）—— 这是与 eraTW / eraTohoK 最根本的
 * 角色轴差异，照抄别人的代词映射会整篇指错人。
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
 * 口上域实测（2026-10-26，`ERB/口上` 64 份 `.ERB`）：
 *
 * | 落点 | 口上域 | 全树 | 角色 |
 * | --- | --- | --- | --- |
 * | `%CALLNAME:奴隷%` | 11,381 | 12,305 | 主人公（本作主人公被称作「奴隷」） |
 * | `%CALLNAME:MASTER%` | 4,316 | 7,108 | 玩家 / 调教者 |
 * | `%CALLNAME:TARGET%` | 353 | 1,742 | 被调教角色（口上文件所属角色） |
 * | `TARGET`（裸用） | 1,683 | — | 同上，直接作为变量参与条件/赋值 |
 * | `MASTER`（裸用） | 6,838 | — | 玩家，同上 |
 *
 * 2.0 代词的 `engineRef` 要的是**名字打印模板** ⇒ 三条都取 `%CALLNAME:…%` 形
 * （引擎同一名字族，不是自造词）。`{我}` 取 `奴隷` 且 `viewBound: true`：口上文件
 * 属于该角色时 `{我}` 与 `# 视角` 目标重合；`{她}` 取 `TARGET`、`viewBound: false`
 * ——从玩家视角指称同一角色，换视点仍成立；`{你}` 取 `MASTER`，不依赖视点。
 */
const PRONOUNS: readonly PronounSymbol[] = Object.freeze([
  Object.freeze({
    role: 'me',
    pronoun: '我',
    engineRef: '%CALLNAME:奴隷%',
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
 * | 名字 | 族 | 编号 | 口上域计数 | 依据 |
 * | --- | --- | --- | --- | --- |
 * | 好感度 | CFLAG | 2 | 111 | `CSV/CFLAG.csv` |
 * | 性欲 | CFLAG | 20 | 0（零引用） | `CSV/CFLAG.csv` |
 * | 屈服度 | CFLAG | 21 | 26 | `CSV/CFLAG.csv` |
 * | 恋慕 | TALENT | 3 | 2,936 | `CSV/Talent.csv` |
 * | 处女 | TALENT | 0 | 1,230 | `CSV/Talent.csv` |
 * | 浮気公認 | TALENT | 159 | 599 | `CSV/Talent.csv` |
 * | 公众便所 | TALENT | 7 | 464 | `CSV/Talent.csv` |
 * | 屈服刻印 | MARK | 2 | 446 | `CSV/Mark.csv` |
 *
 * **全部可写**（`readonly: false`）：口上域实测 `TALENT:` 行首赋值 16 处 /
 * `CFLAG:` 行首赋值 72 处 —— 作者真会改状态，不学 eraTW 把 TALENT 一律标只读。
 */
const ATTRIBUTES: readonly AttributeSymbol[] = Object.freeze([
  Object.freeze({
    name: '好感度',
    family: 'CFLAG',
    index: 2,
    valueKind: 'int',
    readonly: false,
    description: '好感度（CFLAG:2；口上域引用 111 处，可写）',
  }),
  Object.freeze({
    name: '性欲',
    family: 'CFLAG',
    index: 20,
    valueKind: 'int',
    readonly: false,
    description: '性欲（CFLAG:20；口上域零引用，编号按 CSV 名表核对，可写）',
  }),
  Object.freeze({
    name: '屈服度',
    family: 'CFLAG',
    index: 21,
    valueKind: 'int',
    readonly: false,
    description: '屈服度（CFLAG:21；口上域引用 26 处，可写）',
  }),
  Object.freeze({
    name: '恋慕',
    family: 'TALENT',
    index: 3,
    valueKind: 'int',
    readonly: false,
    description: '恋慕素质（TALENT:3；口上域 `TALENT:奴隷:恋慕` 2,936 处，本作最高频状态）',
  }),
  Object.freeze({
    name: '处女',
    family: 'TALENT',
    index: 0,
    valueKind: 'int',
    readonly: false,
    description: '处女素质（TALENT:0；口上域 `TALENT:奴隷:处女` 1,230 处）',
  }),
  Object.freeze({
    name: '浮気公認',
    family: 'TALENT',
    index: 159,
    valueKind: 'int',
    readonly: false,
    description: '浮気公認素质（TALENT:159；口上域 `TALENT:奴隷:浮気公認` 599 处）',
  }),
  Object.freeze({
    name: '公众便所',
    family: 'TALENT',
    index: 7,
    valueKind: 'int',
    readonly: false,
    description: '公众便所素质（TALENT:7；口上域 `TALENT:奴隷:公众便所` 464 处）',
  }),
  Object.freeze({
    name: '屈服刻印',
    family: 'MARK',
    index: 2,
    valueKind: 'int',
    readonly: false,
    description: '屈服刻印（MARK:2；口上域 `MARK:屈服刻印` 446 处）',
  }),
]);

/* ------------------------------ 名字函数 ------------------------------ */

/**
 * **空表**（有意为之）：本包没有 `library-table.ts` 一类的库函数台账。
 * `name-glossary.ts` 是**文件名对照表**（日文名 → 中文名显示备注），不是名字函数
 * ⇒ 派生不出「中文名 → 引擎调用」的单一真源。零条登记 = 语言层零候选，
 * 不借 eraTW 的 `CHARA_TEXT` 一族。
 */
const NAME_FUNCTIONS: readonly NameFunctionSymbol[] = Object.freeze([]);

/* ------------------------------ 域符号变量 ------------------------------ */

/**
 * 作者可写的引擎全局标量。全树裸用计数（2026-10-26；`\b` 词边界）：
 * `ARG` 8,909 / `RESULT` 2,796 / `TIME` 284 / `RESULTS` 141 / `MONEY` 52；
 * 口上域对应 ARG 426 / RESULT 798 / TIME 14（RESULTS、MONEY 在口上域 0 处，
 * 但全树有真语料 ⇒ 五条全声明）。五条均为整数槽，`readonly` 省略（= 可写）。
 *
 * 未收：角色作用域选择器（`TARGET` / `MASTER` / `奴隷`）—— 2.0 已有代词面。
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
 * 说话人是**开放名表**：`CSV/Chara{no}.csv`（18 份实测，直接住在 CSV 根），
 * 主键是 `名前`（`chara-csv.ts` 的 `NAME_KEYS`，同时容忍汉化改键）。
 * `kind: 'project'` 表示名字合法性交给项目级分析，不把角色名抄进契约。
 */
export const ERAKOUMAKAN_DOMAIN_SYMBOLS: DomainSymbols = Object.freeze({
  pronouns: PRONOUNS,
  attributes: ATTRIBUTES,
  nameFunctions: NAME_FUNCTIONS,
  variables: VARIABLES,
  speakers: Object.freeze({ kind: 'project' as const, table: 'CSV/Chara', key: '名前' }),
  unknown: 'error',
});
