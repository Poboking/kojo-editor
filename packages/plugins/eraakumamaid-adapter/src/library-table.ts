/**
 * eraAkumaMaid 基础库函数名表 —— **游戏知识，只住 adapter**。
 *
 * 「函数中文化」在本游戏的落地线：作者用**中文函数名**写基础库助手函数，糖层降糖成
 * **原生 ERB 函数名**（`随机文本("甲/乙")` → `TEXTR("甲/乙")`）。与 `instruction-table.ts`
 * 同形——adapter 建一张**纯数据表**、糖层只查不解释（`kojo-sugar` 侧只认
 * `KojoLibraryTable` 三个查询面）。
 *
 * ## 与 eraTW 的差异（不可平移，本表逐条按本游戏语料重取）
 * eraTW 的表是「中日同源词 + 引擎内建 + 作者私有」三类的中间层；本游戏语料是**日文原版**，
 * 函数命名体系完全不同（`TEXTR` / `COND` / `FIRSTCOM` 一族），eraTW 的 138 条**一条都不能搬**。
 * 因此本表**从零按语料普查重建**，每条都注明调用点次数作为「值不值得收」的证据。
 *
 * ## 收录判据（静态、手工维护、随实测增补）
 * - **收**：`ERB/` 下**非 `EVENT_K/`** 目录里 `@` 定义的高频助手函数——即"游戏基础库"，
 *   且在**口上域**（`ERB/EVENT_K/`）被真实调用；
 * - **不收**：① 引擎内建系统函数（`GETBIT` / `GETNUM` / `STRCOUNT` / `FINDCHARA` …）——
 *   那是**跨游戏语言层**，住 kojo-sugar 的 `SYSTEM_FUNCTION_ALIASES`（系统表优先于本表）；
 *   ② 作者私有 `@函数`（`KOJO_*` / `K{n}_*` / 项目内自定义名）——规范 §7.2 已排除"用户
 *   自定义扩展函数"（投影读侧另有通道）；
 *   ③ **只在本游戏内部按语料取值**、中文名会与作者已用日文术语打架的细化函数（描写类 /
 *   逐指令细化判定）——中文名必须**稳定且无歧义**才敢收，宁可少收也不造一个会误导作者的名。
 *
 * ## 语料普查口径（2026-10-19，`C:/game/eraAkumaMaid`）
 * - 口上域：`ERB/EVENT_K/` **558** 份 `.ERB`；
 * - 基础库：`ERB/` 内 `@` 定义、且**不在** `EVENT_K/` 下的文件 **301** 份 / **1,900** 个
 *   `@名字` 定义（去重后 1,900）；
 * - 口上域真实调用到的基础库函数 **153** 条；本表取其中 **45** 条（高频头部 + 语义可核）。
 *
 * 每条行尾次数 = 该函数在 `ERB/EVENT_K/` 域内的**调用点数**（同一普查口径）。
 * 查不到的名字一律 `undefined`（**绝不猜**，规范 §5.3 精神）；未收录的中文调用形态由糖层
 * **原样保留**并报诊断（fail-visible）。
 */

import type { KojoLibraryTable } from '@kojo/plugin-api';

/**
 * 中文名 → 原生 ERB 函数名（单一真源；手工维护）。
 * 中文名口径：**动宾短语**（`穿着判定` / `首次指令`）而非"函数名的字面翻译"——作者是照
 * 「我想做什么」来找名字的，不是照「函数叫什么」。
 */
export const AM_LIBRARY_FUNCTIONS: ReadonlyMap<string, string> = new Map<string, string>([
  // ---- 条件 / 判定族 ----
  ['条件判定', 'COND'], // FUNCTION.ERB：`COND(条件名, 対象)` → `#FUNCTION`（10376）
  ['状态判定', 'STATE'], // FUNCTION_COM.ERB：`STATE(状态名, 対象)`，ARG 省略取 TARGET (348)
  ['指令条件', 'CHECK_COM'], // FUNCTION_COM.ERB：`CHECK_COM(条件名, 対象)`，体内 `SELECTCASE ARGS` (2642)
  ['选了指令', 'CHOSECOM'], // FUNCTION_COM.ERB：`CHOSECOM(指令号, 対象)` 该指令是否被选 (204)
  ['选过的指令', 'CHOSECOMS'], // FUNCTION_COM.ERB：`CHOSECOMS(条件名, 対象)` 选过的指令集合 (224)
  ['首次指令', 'FIRSTCOM'], // FUNCTION_COM.ERB：`FIRSTCOM(指令号, 対象)`，体内查 `CFLAG:(n):(710+…)` 位 (6066)
  ['首次指令集', 'FIRSTCOMS'], // FUNCTION_COM.ERB：`FIRSTCOMS(条件名, 対象)` 首次指令的集合判定 (274)
  ['首次事件', 'FIRST_EV'], // FUNCTION_COM.ERB：`FIRST_EV(事件名, 対象)`，查 `CSTR:対象:FIRST_EV` (2535)
  ['可移动判定', 'CMOVE'], // FUNCTION_DAILY.ERB：`CMOVE(条件名, 対象)` 日常移动可与否 (59)
  ['可否调教', 'CANTRAIN'], // SIMULATE_TRAIN.ERB：`CANTRAIN(条件名, 対象)` 能否执行该指令 (23)
  ['是目标角色', 'IS_TARGET'], // FUNCTION.ERB：`IS_TARGET(角色号)`，判 `CFLAG:優先順位 == 1` (37)
  ['真实性别', 'TRUE_SEX'], // FUNCTION.ERB：`TRUE_SEX(角色)` → 字符串（含"ふたなり"分支）(105)

  // ---- 事件记录族 ----
  ['事件记录', 'CEVENT'], // FUNCTION_COM.ERB：`CEVENT(事件名, 対象)` 角色个体事件记录查询 (4550)
  ['日常事件记录', 'DEVENT'], // FUNCTION_DAILY.ERB：`DEVENT(事件名, 対象)` 日常事件记录查询 (1643)
  ['事件名列表', 'CEVENTS'], // FUNCTION_COM.ERB：`CEVENTS(条件名, 対象)` → 事件名集合 (159)
  ['日常选择次数', 'CHOSE_DEVENT'], // FUNCTION_DAILY.ERB：`CHOSE_DEVENT(事件名, 対象)` 该时间带的选择回数 (158)
  ['记事件', 'SET_CEVENT'], // FUNCTION_COM.ERB：`SET_CEVENT 事件名, 対象`（过程形，无括号）(101)
  ['删事件', 'DEL_CEVENT'], // FUNCTION_COM.ERB：`DEL_CEVENT 事件名, 対象`（过程形）(28)

  // ---- 名称 / 编号族 ----
  ['角色号', 'CNUM'], // FUNCTION.ERB：`CNUM(角色名)` 名字 → 编号（含 CALLNAME 变异特例）(211)
  ['角色计数', 'CHARA_NUM'], // FUNCTION.ERB：`CHARA_NUM(条件名)` 满足条件的角色数 (530)
  ['按条件找角色', 'FIND_COND'], // FUNCTION.ERB：`FIND_COND(条件…)` → 首个满足条件的编号 (754)
  ['按名找号', 'FIND_NO'], // FUNCTION.ERB：`FIND_NO(名字)` 先按 CALLNAME 找 (46)
  ['搭档编号', 'PARTNER'], // FUNCTION.ERB：`PARTNER()` = `RETURNF TARGET:9` (277)
  ['统计数', 'NUM'], // FUNCTION.ERB：`NUM(统计名, 対象)`，体内 `SELECTCASE ARGS` (32)
  ['调教项编号', 'TNUM'], // FUNCTION_COM.ERB：`TNUM(名称)` = `GETNUM(TRAINNAME, …)` (120)

  // ---- 数值族 ----
  ['获得经验', 'EXP_GAIN'], // FUNCTION_COM.ERB：`EXP_GAIN(经验名, 対象)` 本次增量（对比 `TCVAR:…+200`）(222)
  ['上次经验', 'PREVEX'], // FUNCTION_COM.ERB：`PREVEX(经验名, 対象)`，读 `TCVAR:対象:(GETNUM(EX,…)+900)` (199)
  ['条件随机', 'RANDIF'], // FUNCTION.ERB：`RANDIF(基数, 候选…)` 按基数掷选 (211)

  // ---- 服装族 ----
  ['穿着判定', 'CHECK_CLO'], // CLOTHES.ERB：`CHECK_CLO(服装名, 対象)` 该服装是否穿在身上 (1394)
  ['有上衣', 'CHECK_SHIRT'], // CLO2_SHIRT.ERB：`CHECK_SHIRT(服装名, 対象)`，查 `EQUIP:対象:服` (826)
  ['有下装', 'CHECK_BOTTOM'], // CLO5_BOTTOM.ERB：`CHECK_BOTTOM(服装名, 対象)`，查 `EQUIP:対象:ボトム` (231)
  ['有内裤', 'CHECK_PANTIES'], // CLO0_PANTIES.ERB：`CHECK_PANTIES(服装名, 対象)`，查 `CSTR:対象:パンツ` (99)
  ['有连体衣', 'CHECK_BODYS'], // CLO4_BODYSUIT.ERB：`CHECK_BODYS(服装名, 対象)` (99)
  ['有裙子', 'CHECK_SKIRT'], // CLO3_SKIRT.ERB：`CHECK_SKIRT(服装名, 対象)` (17)
  ['有饰品', 'CHECK_OTHER'], // CLO9_OTHER.ERB：`CHECK_OTHER(服装名, 対象)`，查 `EQUIP:対象:アクセサリ` (19)
  ['服装名', 'CLO'], // CLOTHES.ERB：`CLO(服装名, 対象)` → 名称文本 (11)
  ['服装颜色', 'CLOCOLOR'], // FUNCTION_CLOCOLOR.ERB：`CLOCOLOR(服装名, 色名?)` → 颜色文本 (43)

  // ---- 文本 / 演出族 ----
  ['随机文本', 'TEXTR'], // FUNCTION.ERB：`TEXTR(甲, 乙, …)` 把 `\/` 分隔的候选等概率取一 (9920)
  ['右补空格', 'TEXT_LJ'], // FUNCTION.ERB：`TEXT_LJ(文本, 宽度)` 不足宽度时右侧补空格 (120)
  ['空白串', 'BL'], // FUNCTION.ERB：`BL(个数)` → 指定长度的空格串（缩进/对齐用）(21)
  ['金额文本', 'MONEY_C'], // FUNCTION.ERB：`MONEY_C(数值, 位数?)` 千分位分组文本 (14)
  ['英文断行', 'BREAKENG'], // TRANSLATION/SQN/#Misc.ERB：`BREAKENG(文本, 缩进, 换行符, 行宽)` (12)
  ['窗口行数', 'WINDOWROWS'], // FUNCTION.ERB：`WINDOWROWS` = 客户区高度 / 一行高度（行数）(28)

  // ---- 杂项 ----
  ['颜色值', 'DEF_COLOR'], // FUNCTION.ERB：`DEF_COLOR(色名)` → RGB 整数（`"red"` → `0xFF0000`）(130)
  ['配置项', 'CONFIG'], // CONFIGURE.ERB：`CONFIG(配置名)` → 该配置当前值 (37)
]);

/**
 * 由「中文名 → 原生 ERB 函数名」映射构建 `KojoLibraryTable`（纯数据，无 IO）。
 * `hasTable = 映射非空`；反查（原生名 → 中文名）取**首条**，无则 `undefined`。
 *
 * 与 eratw 同名工厂**逐字同形**（同一契约面、同一取首条口径）；分开写而不是塞进共享层，
 * 是因为两边的"中文名"没有一字重合——共享的只有十行管道，代价大于收益。
 */
export function createErakumamaidLibraryTable(map: ReadonlyMap<string, string>): KojoLibraryTable {
  const byName = new Map(map);
  const byFunction = new Map<string, string>();
  for (const [cn, erb] of byName) {
    if (!byFunction.has(erb)) byFunction.set(erb, cn);
  }
  return {
    hasTable: byName.size > 0,
    lookupByName: (name) => byName.get(name),
    lookupByFunction: (functionName) => byFunction.get(functionName),
    names: () => [...byName.keys()],
  };
}
