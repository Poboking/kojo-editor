/**
 * eraFL 2.0 域符号（游戏事实 —— 只住本包）。
 *
 * 权威依据：设计稿 §3.6（代词表写死、落点由 adapter 决定）。core 不内置任何一条：
 * `{我}` / `{你}`、角色属性、域变量全部查本表。
 *
 * **口径与 eraTW 的根本差异**（交接文档 §2.4 / 入口 B 裁决表）：eraFL 的代词主力
 * 在**口上 XML** 里（`[$MNAME]` 记号族，见 `preview/interpolate.ts`），ERB 壳里
 * 另有一套 `%CALLNAME:…%`。eraTW 那套 `TARGET`/`MASTER` 双选择器模型**不照抄**——
 * eraFL 三轴各有具名落点（本节逐条给语料计数）。
 *
 * 全部数值 = 2026-10-24 `D:/Game/erafl` 真盘读数。
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
 * 三个代词的落点（全部有真盘实证；`engineRef` 写**主力形**，语料计数 =
 * 2026-10-24 口上域 XML 全树 `.xml` 读数）：
 *
 * - `{我}` = 本口上文件自己的角色。eraFL 的口上按角色分发（`KOJO_DEFINE_K{n}` /
 *   `KOJO_XML_INIT_K{n}(KOJO_CHARA_ID)`，说话人就是这份口上所属的角色），自称
 *   主形是 XML 插值 `[$KNAME]`（2,875 处，第一主力）。
 * - `{你}` = 玩家。XML 侧 `[$MNAME]`（6,951 处，绝对主力）；ERB 侧另有
 *   `%CALLNAME:MASTER%`（XML 内 145 处）——同义两形，记号表以 XML 主力为准。
 * - `{她}` = 当前交互的第三方角色。XML 侧 `[$TNAME]`（740 处）——eraFL **有**
 *   这个落点（eraTW 用 `%CALLNAME:TARGET%`，eraFL 用具名记号 `TNAME`，不照抄）。
 *
 * 曾经误判留空、被真盘读数纠正（记在这里防复发）：初版据「壳内 `%CALLNAME:CHARA_ID%`
 * 134 处」判断 `{她}` 无单一选择器。两点错——134 是**全树**数（口上域仅 4 处），
 * 且 `CHARA_ID` 是壳函数**形参名**（`@KOJO_DEFINE_KOJO_INFO_K1000(CHARa_ID)`），
 * 不是引擎变量。第三方引用真形是 `[$TNAME]`（740 处）与
 * `%CALLNAME:NAME_TO_CHARA("UC_…")%` 具名形；「名字像引擎变量」不等于「是引擎变量」。
 */
const PRONOUNS: readonly PronounSymbol[] = Object.freeze([
  Object.freeze({
    role: 'me',
    pronoun: '我',
    engineRef: '[$KNAME]',
    // eraFL 的口上文件本身就是角色文件（目录 `{编号}_{名称}` = 角色身份），
    // `# 视` 声明与该角色重合——与 eraTW 的 viewBound 语义同构。
    requiresView: true,
    viewBound: true,
    // 主力形在 XML 插值记号族（不是 Emuera 的 `%CALLNAME:%` 指令族）。
    family: 'XML-NAME',
  }),
  Object.freeze({
    role: 'you',
    pronoun: '你',
    engineRef: '[$MNAME]',
    requiresView: false,
    viewBound: false,
    family: 'XML-NAME',
  }),
  Object.freeze({
    role: 'her',
    pronoun: '她',
    engineRef: '[$TNAME]',
    // 对象角色轴：口上 XML 的 `<command>` 由 kojoPlace/forMaster 等属性给上下文，
    // `# 视` 目标不同也成立（与 eraTW 的 viewBound=false 同构）。
    requiresView: true,
    viewBound: false,
    family: 'XML-NAME',
  }),
]);

/* ------------------------------ 角色属性 ------------------------------ */

/**
 * 作者常写的角色状态（eraFL 五条剧情线；编号 = `CSV/CFLAG.CSV` 名表实测索引，
 * 2026-10-24 读数）。
 *
 * eraFL 的 CFLAG 是**二维命名槽**：`CFLAG:{角色}:{索引}`，角色轴由说话人上下文
 * 给（壳内三种写法 `CFLAG:CHARA_ID:好感度` / `CFLAG:対象:好感度` /
 * `CFLAG:蒂娅_ID:好感度` 指的是同一个槽，见 `state-lines.ts`）。2.0 让作者写
 * 名字、adapter 给编号——本表给的就是第二轴索引。
 *
 * 五条全部**可写**（不是只读素质位）：语料实测写入次数
 * 好感度（`CFLAG:対象:好感度 += 100` 等）/ 依存度 48 / 従属度 34 / 支配度 29 /
 * 面識 29——eraTW 把同位置标成 TALENT 只读位是 eraTW 的事实，eraFL 不照抄。
 * 面識的引擎语义（CSV 注释原文）：「MASTERと会ったことがあるか」。
 */
const ATTRIBUTES: readonly AttributeSymbol[] = Object.freeze([
  Object.freeze({
    name: '好感度',
    family: 'CFLAG',
    index: 2,
    valueKind: 'int',
    readonly: false,
    description: '对象对主人公的好感数值（CFLAG:好感度 = CFLAG.CSV 编号 2）',
  }),
  Object.freeze({
    name: '依存度',
    family: 'CFLAG',
    index: 3,
    valueKind: 'int',
    readonly: false,
    description: '对象对主人公的依存度（CFLAG:依存度 = 编号 3；语料写入 48 处）',
  }),
  Object.freeze({
    name: '従属度',
    family: 'CFLAG',
    index: 4,
    valueKind: 'int',
    readonly: false,
    description: '对象的従属度（CFLAG:従属度 = 编号 4；语料写入 34 处）',
  }),
  Object.freeze({
    name: '支配度',
    family: 'CFLAG',
    index: 5,
    valueKind: 'int',
    readonly: false,
    description: '对象的支配度（CFLAG:支配度 = 编号 5；语料写入 29 处）',
  }),
  Object.freeze({
    name: '面識',
    family: 'CFLAG',
    index: 17,
    valueKind: 'int',
    readonly: false,
    description: '是否与主人公见过面（CFLAG:面識 = 编号 17；语料写入 29 处）',
  }),
]);

/* ------------------------------ 名字函数 ------------------------------ */

/**
 * **空表**（有意为之）：eraTW 的三条名字函数（`CHARA_TEXT` 等）是从
 * `library-table` 派生的；eraFL 的 `library-table` 是入口 C 的事，现在没有
 * 可派生的源。eraFL 语料里的"取名字"全部走 `%CALLNAME:…%` 落点（已由代词面
 * 表达）与 `NAME_TO_CHARA("…")` 反向查找（名字→角色号，返回 int，不是
 * "取角色文本"的名字函数）⇒ 零条登记：语言层零候选，不猜、不借 eraTW 的词。
 */
const NAME_FUNCTIONS: readonly NameFunctionSymbol[] = Object.freeze([]);

/* ------------------------------ 域符号变量 ------------------------------ */

/**
 * 作者**可写**的引擎全局标量（additive 面 `domainSymbols.variables`）。
 *
 * 台账口径与 `kojo-sugar/src/engine-globals.ts` 同源（跨 Emuera 游戏的语言层
 * 白名单，三条门槛：引擎内建 + 真实语料实测裸用 + 作者造不出这个名字），
 * **eraFL 侧按同规则实测**（2026-10-24 全树 `.ERB` 裸写计数）：
 * - `RESULTS`：按钮输入回传信号（`RESULTS = 1`）；裸写 1,278 ⇒ 可写；
 * - `RESULT`：调用返回值；裸写 395 ⇒ 可写；
 * - `TIME`：时辰；裸写 5 ⇒ 可写（少而真实，时辰推进写在系统侧）；
 * - `MONEY`：所持金；裸写 5 ⇒ 可写；
 * - `ARG`：`CALL` 入参（调用前赋值）；裸写 2 ⇒ 可写。
 *
 * **没收进来的**（有意为之）：角色作用域选择器（`MASTER` / `CHARA_ID` 等）——
 * 2.0 有 `{我}` / `{你}` 代词面，再登记成变量 = 两套入口看同一个东西；
 * `ARGS`（字符串数组）——"裸名 = 第 0 项"的下标语义本 adapter 未在 2.0 侧
 * 落点，暂不登记。要收时按同一台账逐条补，不预埋。
 *
 * 值类型一律 `int`：引擎侧这五个都是整数槽；`readonly` 全部省略（= 可写）。
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
 * eraFL 域符号表。
 *
 * 说话人是**开放名表**（角色 CSV 的 `名前` 行；`chara-csv.ts` 的 `NAME_KEYS`
 * 主键），SDK 层不猜：`speakers.kind = 'project'` 表示"名字合法性交给项目级
 * 分析"，避免把上百个角色名抄进契约。eraTW 用 `CHARA`/`CALLNAME`，eraFL 的
 * 表在 `CSV/Chara/Chara{no}_{名}.csv`、主键是 `名前`（不是 Emuera 的
 * `CALLNAME` 列名）——照抄 eraTW 的键会指向不存在的列。
 */
export const ERAFL_DOMAIN_SYMBOLS: DomainSymbols = Object.freeze({
  pronouns: PRONOUNS,
  attributes: ATTRIBUTES,
  nameFunctions: NAME_FUNCTIONS,
  variables: VARIABLES,
  speakers: Object.freeze({ kind: 'project' as const, table: 'CSV/Chara', key: '名前' }),
  unknown: 'error',
});
