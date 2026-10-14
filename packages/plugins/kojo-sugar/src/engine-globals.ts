/**
 * **裸引擎全局**白名单（E16 批，2026-10-14；方案 §3.0 G2 / P-10①）。
 *
 * 解决什么：`SELECTCOM` / `PREVCOM` 这类**不带族头、不带冒号**的引擎自带标量，
 * 过去在糖条件里一律报 `unknown-identifier`（字典 `resolve` 只认变量族头），
 * 于是 `如果 首次(SELECTCOM)：`、`如果 SELECTCOM == 20：`、`当 SELECTCOM： 是 20：`
 * 这些**真实语料天天在写**的形态整体不可写；退路 `别名 当前指令 = SELECTCOM`
 * 也在声明处报同一码（别名目标自己就要能解析）。
 *
 * 为什么放在**糖这一层**而不是 adapter 字典（方案原建议在 `index.ts` 的 `makeLookup`）：
 * 1. `resolve` 的契约是"**变量字典**查询"（CSV 建出来的族表），本表成员不是字典数据，
 *    是 ERB **语言层**标识符——和 `system-functions.ts` 收 `FIRSTTIME`/`MATCH` 同性质；
 * 2. 字典是**可选注入**的（无工程 / 无 adapter 时 `dictionary` 为 undefined，
 *    `service.ts` 头注已定调），白名单若寄生在字典里，"没打开项目时 `SELECTCOM`
 *    又写不了"就成了第二个墙；
 * 3. 单一消费点：裸标识符解析只有 `expression.ts` 的 `resolveBareIdentifier` 一处，
 *    放在那里 = 条件 / 块头 / `当` 主语 / `是` 值 / 别名右值 / 赋值左值**全线**生效。
 *
 * 入库判据（三条**全部实测**，语料盘 2026-10-14 只读统计，不许凭印象）：
 * ① 引擎内建：名字在 `state-replay/src/var-model.ts` 的 Emuera 引擎变量模型清单里
 *    （该清单依引擎源码 `VariableCode.cs` + 真实存档建立，跨游戏一致）；
 * ② 实测有裸用：在真实语料的**条件/块头**（`IF`/`ELSEIF`/`SIF`/`WHILE`/`SELECTCASE`
 *    及比较运算两侧）以不带冒号、不带括号的形态出现过；口上盘（2,285 份 `.ERB`）与
 *    游戏系统码（3,818 份）各计一次，逐条计数见下；
 * ③ 作者造不出这个名字：单字母草稿数组 `A`–`Z` **不收**（收进来等于给任意拼错名放行）、
 *    `LOCAL`/`LOCALS`/`LOCALSS` **不收**（段块糖 P-1 的信封槽，须由糖自己分配，
 *    白名单收它会把设计抹平——保持今天报错）、变量族头（`CFLAG`/`TALENT`/`NOWEX`/…）
 *    **不收**（走字典 `resolve`）、`#DIM`/`GLOBAL` 侧的项目级全局
 *    （`SCENE`/`ROLE`/`MAIN_MAP`/`CUSTOM_COM`…）**不收**（那是游戏知识，进 adapter 的地盘）。
 *
 * 说明"作者只读"这一口径的实测处理：命令族 / 作用域选择器 / 计数与伪变量在口上盘
 * **写计数为 0**（纯读）；`ARG`/`ARGS`/`RESULT`/`RESULTS`/`TARGET`/`TIME`/`MONEY`
 * 有写计数，但写的都是**引擎协议**（`CALL` 前赋 `ARG`、回传信号 `RESULTS = 1`、
 * 分发器 `TARGET = i`），不是作者自造变量名——放行它们只会让合法 ERB 少报错，
 * 不会掩护拼写错误（名字是引擎固定词）。写计数逐条列出，取舍由读数承担。
 */

/**
 * 白名单成员（**精确大写**匹配——ERB 引擎侧的写法就是全大写；不做大小写折叠，
 * 免得 `no`/`time` 这类词在中文散文里被静默放行）。
 *
 * 每条注释：口上盘裸读（条件头 / 比较两侧）· 口上盘裸写 · 引擎侧证据 `路径:行号`。
 */
export const ENGINE_GLOBAL_IDENTIFIERS: readonly string[] = [
  // —— 指令族（引擎进入信封时写好的当前/上一条指令号；本批三处目标行为全在这一组）——
  'SELECTCOM', // 248 / 761 · 写 24 · コマンド関連・fromEN:98 `SELECTCASE SELECTCOM`
  'PREVCOM', // 486 / 588 · 写 0 · COMMON.ERB:1059 `SELECTCASE PREVCOM`
  'NEXTCOM', // 口上盘 0（系统码 1 / 1 · 写 6）· コマンド関連\COMF\日常系\COMF400 移動.ERB:635 `SIF NEXTCOM == 0`
  // —— 角色作用域选择器（引擎按分发上下文写好；口上只读）——
  'TARGET', // 56 / 631 · 写 380（分发协议）· COMMON.ERB:1057 `SIF TARGET != TFLAG:103`
  'MASTER', // 0 / 510 · 写 0 · BODY_INFO\BODY_INFO.ERB:63 `IF 選択中キャラID == MASTER`
  'PLAYER', // 2 / 3736 · 写 0 · DLC\自室描写.ERB:61 `… == PLAYER`
  'ASSI', // 0 / 277 · 写 0 · コマンド関連\COMF\COMF184 野外プレイ.ERB:197 `IF ASSI >= 0`
  'ASSIPLAY', // 0 / 12（系统码头 39）· 写 0 · fromEN\Custom_Commands\Add_CUSTOM_COM228 脇コキ.ERB:199 `ASSIPLAY == 0`
  // —— 调用协议槽（引擎的入参 / 返回值；口上大量在条件里读）——
  'ARG', // 3525 / 39808 · 写 37（CALL 前赋参）· ANOTHER_TALK.ERB:130 `SELECTCASE ARG`
  'ARGS', // 1442 / 2759 · 写 56 · CASINO\駒草の賭場.ERB:110 `SELECTCASE ARGS`
  'RESULT', // 2404 / 1485 · 写 387 · BATTLE.ERB:49 `SELECTCASE RESULT`
  'RESULTS', // 172 / 106 · 写 1937（`RESULTS = 1` 回传信号）· BATTLE.ERB:245 `SELECTCASE RESULTS`
  // —— 引擎时间 / 循环 / 内建伪变量（口上盘零写，纯读）——
  'DAY', // 112 / 215 · 写 0 · ANOTHER_TALK.ERB:146 `IF DAY > FLAG:開始日`
  'TIME', // 269 / 548 · 写 266（时辰推进）· ANOTHER_TALK.ERB:148 `IF TIME >= …`
  'MONEY', // 46 / 74 · 写 136 · CASINO\駒草の賭場.ERB:352 `SIF MONEY >= 1050`
  'COUNT', // 8 / 29 · 写 0 · CASINO\駒草の賭場.ERB:665 `IF COUNT > 0 …`
  'LINECOUNT', // 30 / 5 · 写 0 · COMMON.ERB:3889 `WHILE LINECOUNT < ARG`
  'CHARANUM', // 6 / 18 · 写 0 · ANOTHER_TALK.ERB:16 `SIF CHARANUM > 人物数量上限`
];

const ENGINE_GLOBAL_SET: ReadonlySet<string> = new Set(ENGINE_GLOBAL_IDENTIFIERS);

/**
 * 裸标识符是否为引擎全局：命中 → **原样返回**（产物里就写 `SELECTCOM`，不加工），
 * 未命中 → `undefined`（交回调用方继续走字典 / 报错，绝不静默放行）。
 */
export function resolveEngineGlobal(ident: string): string | undefined {
  return ENGINE_GLOBAL_SET.has(ident) ? ident : undefined;
}
