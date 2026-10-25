/**
 * eraAkumaMaid 2.0 域符号（游戏事实 —— 只住本包）。
 *
 * **无真盘 · 证据等级 B**：2026-10-26 实测 `C:/game/eraAkumaMaid` 与
 * `D:/Game/eraAkumaMaid` 均不存在，本文件**不含任何真盘计数**；依据 = v1 源码
 * 的 `file:line` 与测试夹具（`name-glossary.ts` 行尾注释里的 CSV 编号）。
 *
 * 两条裁决宁可少声明，也不拿别作事实填空：
 * 1. `variables` **整个字段省略**：无真盘计数，无法按「裸写 > 0」收；证据等级 B 宁缺。
 *    省略 = 本 adapter 没有外部变量面（契约允许，旧行为不变）。
 * 2. `nameFunctions` **空表**：本包 `library-table.ts` 的 45 条是**基础库助手函数**
 *    （判定 / 数值 / 服装 / 文本），不是契约语义的「名字函数（角色文本一类）」；
 *    名字落点已由三个代词表达。硬抄 45 条会与糖层库表双真源，且把数值函数
 *    谎报成 returns string。
 */
import type {
  AttributeSymbol,
  DomainSymbols,
  NameFunctionSymbol,
  PronounSymbol,
} from '@kojo/kojo-core';

/* ------------------------------ 代词 ------------------------------ */

/**
 * 三条代词的 v1 证据（`file:line`，非盘面计数）：
 *
 * - `我` ← `@CNAME_K{n}, ARGS` 每角色呼び名函数（`face-templates.ts:270-271`，
 *   域内 74 处）经引擎 `%CNAME("一人称")%` FORM 调用（`EVENT_K1.ERB:7`）⇒
 *   `engineRef = '%CNAME("一人称")%'`、`family = 'CNAME'`、`viewBound: true`
 *   （口上文件属于该角色时 `{我}` 与 `# 视` 目标重合）。
 * - `你` ← FORM 三连符号 `+` → `CALLNAME:MASTER`（`conventions.ts:176-184`；
 *   `+++` 是作者有意占位、不在替换面）⇒ `%CALLNAME:MASTER%`，不依赖视点。
 * - `她` ← 同处 `$` → `CALLNAME:TARGET`、`*` → `NAME:TARGET`（`conventions.ts:176-184`）
 *   ⇒ `%CALLNAME:TARGET%`，`requiresView: true`（需要 `# 视` 才有目标），
 *   `viewBound: false`（从玩家视角指称同一角色，换视点仍成立）。
 */
const PRONOUNS: readonly PronounSymbol[] = Object.freeze([
  Object.freeze({
    role: 'me',
    pronoun: '我',
    engineRef: '%CNAME("一人称")%',
    requiresView: true,
    viewBound: true,
    family: 'CNAME',
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
 * 八条编号逐条有 v1 `file:line`：
 *
 * | 名字 | 族 | 编号 | 依据 |
 * | --- | --- | --- | --- |
 * | 好感度 | CFLAG | 2 | `variable-schema.ts:9`（`CSV/CFLAG.csv` 首行 `0,キャラ用`、`2,好感度`） |
 * | 恋慕 | TALENT | 150 | `name-glossary.ts:33` |
 * | 処女 | TALENT | 20 | `name-glossary.ts:41` |
 * | 淫紋 | MARK | 8 | `name-glossary.ts:61` |
 * | 恥じらい | TALENT | 84 | `name-glossary.ts:39` |
 * | 避妊の護符 | TALENT | 209 | `name-glossary.ts:45` |
 * | ふたなり | TALENT | 1 | `name-glossary.ts:34` |
 * | マゾっ気 | ABL | 20 | `name-glossary.ts:56` |
 *
 * **全部可写**（`readonly: false`）：`mutator-table.ts:13-17` 是口上域直写实证
 * （CFLAG 622 / ABL 201 / PALAM 42 / BASE 194 / EXP 272 处），`mutator-table.ts:23`
 * TALENT 直写 10 处；v1 没有明示只读的属性 ⇒ 不学别作把 TALENT 一律标只读。
 */
const ATTRIBUTES: readonly AttributeSymbol[] = Object.freeze([
  Object.freeze({
    name: '好感度',
    family: 'CFLAG',
    index: 2,
    valueKind: 'int',
    readonly: false,
    description: '好感度（CFLAG:2；`variable-schema.ts:9` 名表，可写）',
  }),
  Object.freeze({
    name: '恋慕',
    family: 'TALENT',
    index: 150,
    valueKind: 'int',
    readonly: false,
    description: '恋慕素质（TALENT:150；`name-glossary.ts:33`，可写）',
  }),
  Object.freeze({
    name: '処女',
    family: 'TALENT',
    index: 20,
    valueKind: 'int',
    readonly: false,
    description: '処女素质（TALENT:20；`name-glossary.ts:41`，可写）',
  }),
  Object.freeze({
    name: '淫紋',
    family: 'MARK',
    index: 8,
    valueKind: 'int',
    readonly: false,
    description: '淫紋（MARK:8；`name-glossary.ts:61`，可写）',
  }),
  Object.freeze({
    name: '恥じらい',
    family: 'TALENT',
    index: 84,
    valueKind: 'int',
    readonly: false,
    description: '恥じらい素质（TALENT:84；`name-glossary.ts:39`，可写）',
  }),
  Object.freeze({
    name: '避妊の護符',
    family: 'TALENT',
    index: 209,
    valueKind: 'int',
    readonly: false,
    description: '避妊の護符素质（TALENT:209；`name-glossary.ts:45`，可写）',
  }),
  Object.freeze({
    name: 'ふたなり',
    family: 'TALENT',
    index: 1,
    valueKind: 'int',
    readonly: false,
    description: 'ふたなり素质（TALENT:1；`name-glossary.ts:34`，可写）',
  }),
  Object.freeze({
    name: 'マゾっ気',
    family: 'ABL',
    index: 20,
    valueKind: 'int',
    readonly: false,
    description: 'マゾっ気能力（ABL:20；`name-glossary.ts:56`，可写）',
  }),
]);

/* ------------------------------ 名字函数 ------------------------------ */

/**
 * **空表**（有意为之，见文件头注）：`library-table.ts` 的 45 条是基础库助手函数
 * （`TEXTR` / `COND` / `CHECK_CLO` 一类），不是契约语义的「名字函数」；
 * 名字落点由三个代词表达 ⇒ 零条登记 = 语言层零候选，不借别作的名字函数族。
 */
const NAME_FUNCTIONS: readonly NameFunctionSymbol[] = Object.freeze([]);

/* ------------------------------ 汇总 ------------------------------ */

/**
 * 说话人是**开放名表**：`CSV/CHARA/CHARA{no}.csv`（`scaffold.ts:159` 路径口径），
 * 主键是 `名前`（`chara-csv.ts:44` 的 `NAME_KEYS` 含 `名前`，同时容忍汉化改键）。
 * `kind: 'project'` 表示名字合法性交给项目级分析，不把角色名抄进契约。
 */
export const ERAAKUMAMAID_DOMAIN_SYMBOLS: DomainSymbols = Object.freeze({
  pronouns: PRONOUNS,
  attributes: ATTRIBUTES,
  nameFunctions: NAME_FUNCTIONS,
  // `variables` 整体省略：无真盘计数（证据等级 B 宁缺）。
  speakers: Object.freeze({ kind: 'project' as const, table: 'CSV/CHARA', key: '名前' }),
  unknown: 'error',
});
