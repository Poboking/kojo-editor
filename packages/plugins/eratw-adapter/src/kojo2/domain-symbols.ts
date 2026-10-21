/**
 * eraTW 2.0 域符号（游戏事实 —— 只住本包）。
 *
 * 权威依据：设计稿 §3.6（代词表写死、落点由 adapter 决定）+ 附录 B.2。
 * core 不内置任何一条：`{我}` / `{你}` / `{她}`、角色属性、名字函数全部查本表。
 *
 * 落点来源（不抄第二份词表）：
 * - 名字函数**从既有 `ERATW_LIBRARY_FUNCTIONS` 派生**（同一个中文名 → 原生 ERB
 *   函数名的单一真源），只按引擎函数名筛出"名字族"三条，不重写词表；
 * - 代词落点沿用 v1 既有口径（`kojo-sugar/src/expression.ts` 的 PRONOUN_MAP：
 *   `{她}` → `%CALLNAME:TARGET%`、`{你}` → `%CALLNAME:MASTER%`）；
 * - 角色属性的族/编号取自既有状态线口径（`plugin.ts` 的 `stateLinePresets`：
 *   好感度 = `CFLAG:2`、恋慕 = `TALENT:3`、恋人 = `TALENT:7`、爱欲 = `TALENT:184`）。
 */
import type {
  AttributeSymbol,
  DomainSymbols,
  NameFunctionSymbol,
  PronounSymbol,
} from '../../../../kojo-core/src/adapter.js';
import { ERATW_LIBRARY_FUNCTIONS } from '../library-table.js';

/* ------------------------------ 代词 ------------------------------ */

/**
 * 三个代词的落点：
 * - `{我}` = `# 视` 声明的角色；eraTW 口上按角色分发，运行期就是 `TARGET`；
 * - `{你}` = 玩家 `MASTER`；
 * - `{她}` = 当前目标；`# 视 目标` 时与 `{我}` 重合，core 会按 §3.6 报错。
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
 * 作者常写的角色状态。编号属于游戏事实；语料里 `CFLAG:好感度` 与 `CFLAG:2` 同义，
 * 2.0 让作者写名字、adapter 给编号。
 *
 * 只收有既有台账证据的四条（宁缺毋滥）：好感度可写，恋慕/恋人/爱欲是素质位（只读）。
 */
const ATTRIBUTES: readonly AttributeSymbol[] = Object.freeze([
  Object.freeze({
    name: '好感度',
    family: 'CFLAG',
    index: 2,
    valueKind: 'int',
    readonly: false,
    description: '以角色为轴的好感数值（CFLAG:2）',
  }),
  Object.freeze({
    name: '恋慕',
    family: 'TALENT',
    index: 3,
    valueKind: 'int',
    readonly: true,
    description: '恋慕素质（TALENT:3）；爱慕是本地化常用称呼',
  }),
  Object.freeze({
    name: '恋人',
    family: 'TALENT',
    index: 7,
    valueKind: 'int',
    readonly: true,
    description: '恋人素质（TALENT:7）',
  }),
  Object.freeze({
    name: '爱欲',
    family: 'TALENT',
    index: 184,
    valueKind: 'int',
    readonly: true,
    description: '爱欲素质（TALENT:184；本地化有「愛欲 / 爱欲」两种写法）',
  }),
]);

/* ------------------------------ 名字函数 ------------------------------ */

/**
 * 名字族的引擎函数名（筛选口径）。这三个函数负责"把角色/玩家/第三方的名字
 * 变成可打印文本"，是 2.0 里 `{她}` 一类插值的底层落点。
 */
const NAME_FUNCTION_ENGINES: readonly string[] = Object.freeze(['CHARA_TEXT', 'PRINT_MALE_CN', 'HE_SHE_CN']);

/**
 * 从既有库函数表派生名字函数：`ERATW_LIBRARY_FUNCTIONS` 是"中文名 → 引擎函数名"
 * 的单一真源，本表只做筛选，不复制词条。
 */
const NAME_FUNCTIONS: readonly NameFunctionSymbol[] = Object.freeze(
  Array.from(ERATW_LIBRARY_FUNCTIONS.entries())
    .filter(([, engine]) => NAME_FUNCTION_ENGINES.includes(engine))
    .map(([name, engine]) =>
      Object.freeze({ name, engine, args: Object.freeze(['对象'] as const), returns: 'string' as const }),
    ),
);

/* ------------------------------ 汇总 ------------------------------ */

/**
 * eraTW 域符号表。
 *
 * 说话人是**开放名表**（角色 CSV 的 CALLNAME 一列），SDK 层不猜：`speakers.kind =
 * 'project'` 表示"名字合法性交给项目级分析"，避免把上千角色名抄进契约。
 */
export const ERATW_DOMAIN_SYMBOLS: DomainSymbols = Object.freeze({
  pronouns: PRONOUNS,
  attributes: ATTRIBUTES,
  nameFunctions: NAME_FUNCTIONS,
  speakers: Object.freeze({ kind: 'project' as const, table: 'CHARA', key: 'CALLNAME' }),
  unknown: 'error',
});
