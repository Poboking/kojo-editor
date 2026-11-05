/**
 * 未建模状态写检测（2026-11-05 状态回放可用性批；游戏无关；本插件私有）。
 *
 * ## 解决的问题
 *
 * 回放按**函数入口时刻的存档**求值，不执行函数体——`CFLAG:2 += 10` / `SETBIT` /
 * `INPUT` 之后的 `RESULT` 都不会被算进去，于是"入口值判出来的结论"可能和真实运行
 * **不同形**，而 UI 上看不出这层近似。本模块把**能证明的写点行**交给回放面，
 * 由面板给结论打「近似」标记（契约 `FunctionReplay.unmodeledWrites`）。
 *
 * ## 判据（宁少勿错：只报能证明的）
 *
 * 逐行（只扫 `[startLine, endLine]`，与 `hasLabelAfter` / `loop-range.ts` 的窗口扫描同口径）：
 *
 * 1. 行文本先 `erbCodeBodyOf(trim())` 剥 `;!;` / `;#;` 代码前缀（与 `loop-range.ts`
 *    **同一份判据**，不另抄），再去行内 `;` 注释（引号外的 `;` 起注释）。
 * 2. 跳过：空行 / `;` 注释 / `@` `#` `$` 非体行 / `[SKIPSTART]`…`[SKIPEND]` 区间
 *    （引擎不执行区内的行，写不发生）。
 * 3. **赋值形**：行首（允许 `SIF <条件> ` 前缀，画法与 `loop-range.ts` 的
 *    `SLOT_WRITE_RE` 同源）是 `名字(:下标)?` + 赋值符（`=` 及 `+= -= *= /= %= |= &= ^=
 *    <<= >>=`；`==` / `<=` / `>=` / `!=` **不算**）。带撇目标（`TFLAG' = 1` /
 *    `CFLAG:2' = "x"`——引擎的字符串维度写法，真语料 923 条量级）与不带撇一样按名字
 *    归一后判族。目标族属于**语言局部量族**（`LOCAL/LOCALS/RESULT/RESULTS` ＝
 *    `locals.ts` 的直线数据流；`ARG/ARGS` ＝ E2 起的调用上下文 + 直线赋值）时不报——
 *    那些写**已被建模**，不算"未建模"；带撇的本地量写法（`LOCAL' = "…"`）按同一族规则
 *    一并放过（字符串维不在本层数据流里，但"宁少勿错"：不把它单列成未建模写）。
 * 4. **引擎写指令**：行首（首词）命中下面 `WRITE_INSTRUCTIONS` 短表时也报
 *    （`kind:'instruction'`；赋值形恒为 `kind:'assign'`）。
 * 5. **调用族**（2026-11-05 边界批）：行首动词命中 `CALL_INSTRUCTIONS`（`CALL*` / `TRYCALL*` /
 *    `TRYCCALL*`，名字逐条来自引擎指令表 `erb-parser/src/instructions.ts`，测试用那张表钉住 ⊆）⇒
 *    `kind:'call'`。理由：被调段可能写状态；本层**不展开、不解析实参**（跨函数传播不在
 *    近似回放的射程内，展开会把单函数检测变成整图遍历——性能红线）。
 * 6. **跳转族**（同批；2026-11-06 可达性批收紧）：行首动词命中 `JUMP_INSTRUCTIONS`
 *    （`GOTO` / `GOTOFORM` / `JUMP` / `JUMPFORM` 的平跳形）⇒ **必须问可达性**
 *    （`reachability.ts` 的 `analyzeReachability`）：
 *    - 静态字面量标签的跳转（`resolvedJumps`）⇒ 可达性已建模，**不再报**（以前那枚
 *      "不确定面"是噪音）；
 *    - 动态跳转（`dynamicJumps`：目标算不出来 / 标签不存在）⇒ 该行之后按可达，
 *      且**只有该行之后还有可达写点**时才报 `kind:'jump'`（防刷屏判据不变）。
 * 7. **可达性过滤**（2026-11-06）：可达性一旦参与，**不可达行上的写点一律不报**
 *    （assign / instruction / call / jump 同理——不可达 = 写不发生；静态 `GOTO` 跳过的
 *    死区间不再刷屏）。动态跳转之后一律按可达（目标不可知 ⇒ 不许把真写点藏起来）。
 *
 *    **性能口径**：可达性不是无条件先跑，而是**触发式**——直线扫描顺手记住"有没有跳转 /
 *    有没有中途 `RETURN`"（都是已有动词判定里的两条 `Set.has`，零额外分配）；两者都没有时
 *    直线结果就是真值，直接返回（真语料绝大多数函数走这条）。只有会改变结论的窗口才追加
 *    一次 `analyzeReachability`（一次标签扫描 + 一次 BFS，仍 O(行数)，不重复解析写点）。
 *    这样 602 行 / 390 写点 ×1000 次的读数与改造前同量级（见批次回执）。
 * 8. 同一行只报一次；顺序 = 行序；`text` = 剥前缀 + 去行内注释后的行正文（给作者定位，
 *    不做二次解析）。
 * 9. `kind:'call'` 的条目带 `target`（`extractCallTarget` 抽的静态被调名；动态调用不填）。
 *
 * ## 为什么是"短表 + 行首动词"，而不是"动词白名单/黑名单"
 *
 * 判据只认**引擎语言层**的动词词汇（跨游戏一致）：读类指令（`PRINT` 族 / `GETBIT` /
 * 各种表达式调用）**只读不写**，写进"未建模写"只会制造噪音；写类指令则一定是状态副作用。
 * 表刻意短而明确——宁可漏报（漏报的代价是"少一个近似标记"，误报的代价是"作者不再信任
 * 这个标记"）。
 *
 * ## 不检测（已知边界，如实记录）
 *
 * - 行内 `CALL` / `CALLFORM` 等**间接写**：只报调用行本身（`kind:'call'`，不确定面），
 *   被调函数体内写什么，本层不做跨函数传播（单层传播由引擎填 `calleeWrites`）；
 * - `TRYGOTO*` / `TRYJUMP*`（条件跳转）不改变可达性（两条边都可能），也不报 `jump`；
 * - 循环语义（`BREAK` / `CONTINUE` 之后的可达性、循环体重复执行）不建模：它们仍落下一行；
 * - **条件块内的静态跳转 / RETURN 按直线流处理**（不建 IF/ENDIF 边）——见下方
 *   `analyzeReachability` 的取舍说明；本批只把"无条件的直线控制流"当成可证明的；
 * - 写在函数区间外（被 `CALL` 的上文/下文函数）——不属本函数体；
 * - `DUMPRAND` / `INITRAND`（RANDDATA 状态）与 `SWAPVAR` 一类未列入短表的指令：
 *   宁少勿错，未收；
 * - `#DIM` 用户变量的**声明行**不是写（`#DIM` 行按判据 1 跳过）；
 * - `[SKIPSTART]` 跨函数头（起始于 `startLine` 之前）——本检测只按请求区间起算，
 *   `#FUNCTION` 头不会落在 SKIP 区（抽取侧本就不发布 SKIP 区内的函数）。
 */

import type { FunctionReplay } from '@kojo/plugin-api';
import { erbCodeBodyOf } from '@kojo/plugin-api';
import { LOCAL_FAMILY_SLOTS } from './locals';
import { analyzeReachability, JUMP_INSTRUCTIONS, RETURN_STOP_INSTRUCTIONS } from './reachability';

export { JUMP_INSTRUCTIONS };

/**
 * 契约 `FunctionReplay['unmodeledWrites']`（`ReplayWrite` 未从 `@kojo/plugin-api`
 * 的桶导出——那是 PS-10 字节闸的纪律：契约只放类型、插件侧取型不引值）。
 */
export type ReplayWrites = NonNullable<FunctionReplay['unmodeledWrites']>;

/** 单个写点（与契约 `ReplayWrite` 结构同形：行号 1 基 + 去注释行正文） */
export type ReplayWrite = ReplayWrites[number];

/**
 * 写点类别（契约 `ReplayWrite.kind` 的插件侧取型；面板按类别分桶用）。
 * 契约侧 `kind?` 缺省 = `assign`（旧数据兼容），本插件**总是**写显式类别。
 */
export type ReplayWriteKind = NonNullable<ReplayWrite['kind']>;

/**
 * **已建模**的语言局部量族：这些目标的直线赋值由 `locals.ts` 的数据流（`LOCAL` 族）
 * 与调用上下文 + `ARG` 直写（E2）建模，写进去的值回放看得见 ⇒ 不算"未建模写"。
 *
 * 四族从 `LOCAL_FAMILY_SLOTS` 取（"哪些名字算本地量"在本插件里只许那一份），
 * `ARG/ARGS` 是同一数据流层在 E2 起纳入的族，这里按名字补齐。
 */
const MODELED_LOCAL_FAMILIES = new Set([...LOCAL_FAMILY_SLOTS, 'ARG', 'ARGS']);

/**
 * 赋值形（行首；`SIF` 前缀可选）。与 `loop-range.ts` 的 `SLOT_WRITE_RE` 同画法，
 * 只是目标名不限于本地量族、下标段放宽到任意表达式（动态下标写也是**确定会发生
 * 的写**，落点未知不影响"这是一次未建模写"这个事实）。
 *
 * 名字尾允许**任意个撇号**（`TFLAG' = 1` / `CFLAG:2' = "x"`：引擎把带撇目标当字符串
 * 维度，`condition-extractor/src/extract.ts` 的注释同源；对"这是一次状态写"这个事实
 * 无影响）；判族前把撇号去掉（见 `detectUnmodeledWrites`）。
 *
 * 赋值符全长枚举（长符在前）；`(?!=)` 把 `==` 挡在门外——`<=` / `>=` / `!=`
 * 根本不在枚举里，天然不中。
 */
const ASSIGN_RE =
  /^(?:SIF\s+\S.*?\s)?([A-Z_][A-Z0-9_]*'*)(?::([^=\s]+))?\s*(<<=|>>=|\+=|-=|\*=|\/=|%=|\|=|&=|\^=|=)(?!=)/i;

/** 行首动词（引擎写指令表的取词口；`\b` 保证 `INPUT` 不吞掉 `INPUTS` 一类的长名——两者都在表里） */
const LEADING_VERB_RE = /^([A-Z_][A-Z0-9_]*)\b/i;

/**
/**
 * **引擎状态写指令**短表（引擎语言词汇，零游戏知识；2026-11-05 按真语料 + 仓库自带
 * 指令表 `erb-parser/src/instructions.ts` 校正：上一版三条名字是**猜的假名**，真语料
 * 0 命中；这里每一条都必须在引擎指令表里存在）。逐组说明"为什么算写"：
 *
 * - 位操作：`SETBIT` / `CLEARBIT` / `INVERTBIT` —— 给目标变量置位；
 * - 输入族：`INPUT` / `INPUTS` / `INPUTANY` / `INPUTMOUSEKEY` / `ONEINPUT` /
 *   `BINPUT` / `BINPUTS` / `TINPUT` / `TINPUTS` / `TONEINPUT` / `TONEINPUTS` ——
 *   玩家输入写进 `RESULT` / `RESULT:1…` 与系统输入状态（回放不跑输入循环）；
 * - 角色列表族：`ADDCHARA` / `DELCHARA` / `ADDCOPYCHARA` / `SWAPCHARA` /
 *   `SORTCHARA` / `ADDVOIDCHARA` / `RESETDATA` / `RESETGLOBAL` —— 改角色列表 /
 *   角色槽 / 全部变量（`CHARANUM`、`TARGET` 一类随之而变）；
 * - 时间：`TIMES` —— 推进游戏时间（改 `DAY` / `TIME` 一族）；
 * - 存档 / 全局：`SAVEDATA` / `SAVEGLOBAL` / `LOADDATA` / `LOADGLOBAL` /
 *   `RANDOMIZE` —— 改存档与全局运行时状态（`LOAD*` 之后后面的读全换了一份状态）；
 * - 数组/变量写族（真语料高频：`VARSET` 2,350 行、`EQUIP` 191 行…）：
 *   `VARSET` / `CVARSET` / `VARSIZE` / `ARRAYCOPY` / `ARRAYSHIFT` / `ARRAYREMOVE` /
 *   `ARRAYSORT` / `SWAP` / `EQUIP` / `UNEQUIP` / `DT_CELL_SET` / `DT_ROW_ADD` /
 *   `MAP_SET` / `RESET_STAIN` —— 直接改变量 / 数组 / 装备 / 数据表。
 *
 * **不收录**读类指令（`PRINT` 族 / `PRINTFORM` / `GETBIT` 等）：只读状态或只产生显示，
 * 不构成本模块要报告的"回放没算进去的写"。
 *
 * 校正记录（防回潮）：上一版的 `RESETGLOBALDATA` / `SAVEGLOBALDATA` /
 * `LOADGLOBALDATA` 在 3,818 份真实 ERB 里 **0 命中**，引擎真名分别是
 * `RESETGLOBAL` / `SAVEGLOBAL` / `LOADGLOBAL`；`INPUTSN` 同样不是引擎词
 * （真名 `TINPUT` / `BINPUT` 一族）。测试用 `@kojo/plugin-erb-parser` 的
 * `ERB_INSTRUCTION_NAMES` ∪ `ERB_STATEMENT_DIRECTIVES` 钉住"短表 ⊆ 引擎词表"
 * （`EQUIP` / `MAP_SET` 一族在引擎侧是内建语句，只出现在语句提示表）。
 */
export const WRITE_INSTRUCTIONS: ReadonlySet<string> = new Set([
  // 位操作
  'SETBIT',
  'CLEARBIT',
  'INVERTBIT',
  // 输入族
  'INPUT',
  'INPUTS',
  'INPUTANY',
  'INPUTMOUSEKEY',
  'ONEINPUT',
  'BINPUT',
  'BINPUTS',
  'TINPUT',
  'TINPUTS',
  'TONEINPUT',
  'TONEINPUTS',
  // 角色列表 / 角色槽 / 变量重置
  'ADDCHARA',
  'DELCHARA',
  'ADDCOPYCHARA',
  'SWAPCHARA',
  'SORTCHARA',
  'ADDVOIDCHARA',
  'RESETDATA',
  'RESETGLOBAL',
  // 时间推进
  'TIMES',
  // 存档 / 全局
  'SAVEDATA',
  'SAVEGLOBAL',
  'LOADDATA',
  'LOADGLOBAL',
  'RANDOMIZE',
  // 变量 / 数组 / 装备 / 数据表写
  'VARSET',
  'CVARSET',
  'VARSIZE',
  'ARRAYCOPY',
  'ARRAYSHIFT',
  'ARRAYREMOVE',
  'ARRAYSORT',
  'SWAP',
  'EQUIP',
  'UNEQUIP',
  'DT_CELL_SET',
  'DT_ROW_ADD',
  'MAP_SET',
  'RESET_STAIN',
]);

/**
 * **调用族**（`kind:'call'`；2026-11-05 边界批）。
 *
 * 取词判据是**机械的**：引擎指令表里所有以 `CALL` / `TRYCALL` / `TRYCCALL` 起首的动词
 * （`erb-parser/src/instructions.ts` 的 `ERB_INSTRUCTION_NAMES`，2026-11-05 grep 确认；
 * 引擎表是唯一真源，本表**不许**手写猜测名）。被调段可能写状态，本层不展开、不解析实参。
 *
 * 为什么整族都收：`CALLF` / `TRYCALLF` 一类是同一语义的变体，漏一个就漏一类；
 * 而它们**确实**是调用，标成"不确定面"不是误报（面板按类别分桶呈现）。
 * `CALLL` / `CALLFORML` 只出现在语句提示词表、不在引擎指令全集里（未注册），
 * 故不在本表——`writes-kinds.test.ts` 用引擎表钉住这条等式。
 */
export const CALL_INSTRUCTIONS: ReadonlySet<string> = new Set([
  'CALL',
  'CALLEVENT',
  'CALLF',
  'CALLFORM',
  'CALLFORMF',
  'CALLSHARP',
  'CALLTRAIN',
  'TRYCALL',
  'TRYCALLF',
  'TRYCALLFORM',
  'TRYCALLFORMF',
  'TRYCALLLIST',
  'TRYCCALL',
  'TRYCCALLFORM',
]);

/**
 * **跳转族**（`kind:'jump'`；2026-11-05 边界批落地，2026-11-06 可达性批收紧）。
 *
 * 词表已移到 `reachability.ts`（谁建模跳转、谁持有跳转词表 = 一份）；这里原样再导出，
 * 既有消费方（测试 / 面板）不用改 import 面。`TRYGOTO*` / `TRYJUMP*` 是条件跳转，
 * 不在本表（见 `reachability.ts` 的 `CONDITIONAL_JUMP_INSTRUCTIONS`）。
 */
/**
 * 去掉行内注释（引号外的 `;` 起注释；引号内保留）。
 *
 * 只需要 `"` 一种字符串定界：ERB 的字符串字面量只有双引号（`'''` 是 kojo 风格的
 * 转译写法，不进 ERB 正文）。注释只影响 `text`（给作者定位）与判据尾部，不影响写点判定。
 */
function stripInlineComment(code: string): string {
  let quoted = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === '"') quoted = !quoted;
    else if (ch === ';' && !quoted) return code.slice(0, i);
  }
  return code;
}

/**
 * **静态调用目标**抽取：`CALL NAME(...)` / `CALL NAME` / `TRYCALL NAME, ...` ⇒ `NAME`
 * （大写归一；`$` 前缀与 `()` 尾巴都不进名字）。动态目标一律 `null`：
 *
 * - `CALLFORM*` / `TRYCALLFORM*`（名字是表达式算出来的）；
 * - `CALLF*` / `CALLEVENT` / `CALLSHARP` / `CALLTRAIN` / `TRYCALLLIST` / `TRYCCALL*`
 *   （不是"静名字 + 实参表"的直调形，本层不猜——宁少勿错）；
 * - 目标不是裸名字、或名字后面跟着看不懂的尾巴（`CALL K1_%X%` 一类）。
 *
 * 纯函数、零 IO：只读 `code`（先 `trim`、剥 `;!;` / `;#;` 前缀与行内 `;` 注释）。
 * 引擎用它给 `kind:'call'` 的条目填 `target`，再做一层被调段写点计数（`calleeWrites`）。
 */
export function extractCallTarget(code: string): string | null {
  return callTargetOf(stripInlineComment(erbCodeBodyOf(code.trim())).trim());
}

/**
 * 调用目标抽取的**热路径**形态（`code` 已 trim / 剥前缀 / 去注释）。
 *
 * 只认 `CALL` / `TRYCALL` 两个静名字直调动词：其后必须**至少一个空白**（挡住
 * `CALLFORM` / `CALLF` 这类长名），目标整段是 Unicode 名字（字母/数字/下划线），
 * 末尾只许 `(` / `,` / `;` / 行尾。
 *
 * 实现是**免分配游标**（真语料 18,233 条调用行，正则版本在整档体检里是可见开销）：
 * ASCII 名字走字符扫描，遇到非 ASCII（CJK 名字）才退回 `CALL_TARGET_RE`——语义只有
 * 那一份判据（正则），快路只是它的等价展开。
 */
function callTargetOf(code: string): string | null {
  const c0 = code.charCodeAt(0);
  let i: number;
  if (c0 === 67 || c0 === 99) {
    if (!matchesKeywordAt(code, 'CALL')) return null;
    i = 4;
  } else if (c0 === 84 || c0 === 116) {
    if (!matchesKeywordAt(code, 'TRYCALL')) return null;
    i = 7;
  } else {
    return null;
  }
  if (i >= code.length) return null;
  let c = code.charCodeAt(i);
  if (c !== 32 && c !== 9 && c !== 0x3000) return null; // 动词后必须至少一个空白
  while (i < code.length) {
    c = code.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 0x3000) break;
    i++;
  }
  if (code.charCodeAt(i) === 36) i++; // `$` 前缀不进名字
  const start = i;
  while (i < code.length) {
    c = code.charCodeAt(i);
    if (isAsciiNameCode(c)) {
      i++;
      continue;
    }
    if (c >= 128) return callTargetByRegex(code); // 非 ASCII 名字（CJK 等）：交回唯一判据
    break;
  }
  if (i === start) return null;
  let j = i;
  while (j < code.length) {
    const d = code.charCodeAt(j);
    if (d !== 32 && d !== 9 && d !== 0x3000) break;
    j++;
  }
  // 尾巴只许 `(` / `,` / `;` / 行尾（`CALL FOO BAR` / `CALL K1_%X%` 一律不认）
  if (j < code.length) {
    const d = code.charCodeAt(j);
    if (d !== 40 && d !== 44 && d !== 59) return null;
  }
  return code.slice(start, i).toUpperCase();
}

/** 正则版（非 ASCII 名字的兜底；`CALL_TARGET_RE` 是唯一判据形态） */
function callTargetByRegex(code: string): string | null {
  const m = CALL_TARGET_RE.exec(code);
  return m === null ? null : m[1]!.toUpperCase();
}

/** `code` 从 0 起是否以 ASCII 关键字 `kw`（大写）起首（大小写不敏感；不检查其后边界） */
function matchesKeywordAt(code: string, kw: string): boolean {
  if (code.length < kw.length) return false;
  for (let i = 0; i < kw.length; i++) {
    const c = code.charCodeAt(i);
    const upper = c >= 97 && c <= 122 ? c - 32 : c;
    if (upper !== kw.charCodeAt(i)) return false;
  }
  return true;
}

/** `[A-Za-z0-9_]`（快路的名字字符集；非 ASCII 交给正则兜底） */
function isAsciiNameCode(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
}

/** 静态直调形（`CALL` / `TRYCALL` + 空白 + 裸名字 + 干净尾巴；大小写不敏感） */
const CALL_TARGET_RE =
  /^(?:CALL|TRYCALL)[ \t\u3000]+\$?([\p{L}\p{N}_]+)(?=[ \t\u3000]*(?:\(|,|;|$))/iu;

/**
 * 函数体 `[startLine, endLine]`（1 基、闭区间）内的未建模写点，按行序返回。
 *
 * 纯函数：只读 `lines`，不碰磁盘 / 缓存。`lines` 是整份文件的行数组（0 基取用），
 * 与 `transcript.ts` / `loop-range.ts` 的取行口径一致。
 *
 * **两段式**（2026-11-06 可达性批；性能红线）：
 * 1. 一次直线扫描收写点（与旧实现逐字同一条路），顺手记两枚触发位——"有跳转" /
 *    "有中途 `RETURN`"；
 * 2. 两枚都没置位 ⇒ 直线结果就是真值，直接返回（真语料绝大多数函数走这条，零额外开销）；
 *    否则**追加一次** `analyzeReachability`（一次标签扫描 + 一次 BFS，O(区间行数)），
 *    用它滤掉不可达写点、并决定动态跳转要不要报 `kind:'jump'`。
 *
 * 不重复解析写点：可达性那趟只认标签 / 跳转 / 块结构，不跑赋值与调用判据。
 */
export function detectUnmodeledWrites(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): ReplayWrites {
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine > endLine) return [];
  const first = Math.max(1, startLine);
  const last = Math.min(endLine, lines.length);
  if (last < first) return [];
  /** 直线扫描的写点（可达性过滤前） */
  let out: ReplayWrite[] = [];
  /** 跳转候选（静态/动态都先收着；是否入列由可达性读数的 `dynamicJumps` 决定） */
  const jumps: ReplayWrite[] = [];
  /** 第一条"非末行"的 `RETURN` 族行（触发位：真终止与否交给可达性判，块内返回不终止） */
  let midReturnLine = 0;
  /** SKIP 区状态（区间内起算；区间前开的 SKIP 见文件头"已知边界"） */
  let inSkip = false;
  for (let ln = first; ln <= last; ln++) {
    // 与 loop-range.ts 同口径：先 trim，再剥 `;!;` / `;#;` 代码前缀
    const body = erbCodeBodyOf((lines[ln - 1] ?? '').trim());
    if (inSkip) {
      if (body === '[SKIPEND]') inSkip = false;
      continue;
    }
    if (body === '[SKIPSTART]') {
      inSkip = true;
      continue;
    }
    if (body.length === 0) continue;
    const head = body.charAt(0);
    // 注释 / 函数头 / 指令 / 标签：都不是体行（与 loop-range.ts 的窗口白名单同一族判据）
    if (head === ';' || head === '@' || head === '#' || head === '$') continue;
    const code = stripInlineComment(body).trim();
    if (code.length === 0) continue;

    const assign = ASSIGN_RE.exec(code);
    if (assign) {
      // 同一行只报一次：赋值形已定性，不再看指令表（两者不会同时成立）。
      // 带撇目标（`TFLAG'` / `CFLAG:2'`：引擎的字符串维度）判族前去掉撇号——
      // "写的是哪个变量族"与"值是什么类型"是两条轴，本模块只关心前者。
      const target = assign[1]!.replace(/'/g, '').toUpperCase();
      if (!MODELED_LOCAL_FAMILIES.has(target)) out.push({ line: ln, text: code, kind: 'assign' });
      continue;
    }

    const verb = LEADING_VERB_RE.exec(code);
    if (!verb) continue;
    const upper = verb[1]!.toUpperCase();
    // 调用族：被调段可能写状态（不展开、不解析实参——性能红线）
    if (CALL_INSTRUCTIONS.has(upper)) {
      const callTarget = callTargetOf(code);
      out.push(
        callTarget === null
          ? { line: ln, text: code, kind: 'call' }
          : { line: ln, text: code, kind: 'call', target: callTarget },
      );
      continue;
    }
    // 跳转族：静态/动态先一视同仁收着；静态跳转的"可达性已建模"由读数判
    if (JUMP_INSTRUCTIONS.has(upper)) {
      jumps.push({ line: ln, text: code, kind: 'jump' });
      continue;
    }
    // 触发位：窗口内**不是末行**的 `RETURN` 族才可能让后面的写不可达
    if (ln < last && RETURN_STOP_INSTRUCTIONS.has(upper)) {
      if (midReturnLine === 0) midReturnLine = ln;
      continue;
    }
    // 引擎写指令
    if (WRITE_INSTRUCTIONS.has(upper)) out.push({ line: ln, text: code, kind: 'instruction' });
  }
  // 快路：**没有写点会被可达性改变**时就别跑分析（常见情形：函数末尾 RETURN、
  // 循环尾部的 GOTO —— 它们都在最后一条写点之后，抹不掉任何写、也不会报 jump）。
  let lastWrite = 0;
  for (const w of out) if (w.line > lastWrite) lastWrite = w.line;
  const returnBeforeWrite = midReturnLine !== 0 && midReturnLine < lastWrite;
  const jumpBeforeWrite = jumps.length > 0 && jumps[0]!.line < lastWrite;
  if (!returnBeforeWrite && !jumpBeforeWrite) return out;

  const reach = analyzeReachability(lines, startLine, endLine);
  const reachable = reach.reachable;
  /** 整段可达 ⇒ 逐行 `.has()` 全可以省掉（`size` O(1)，读数集合只含窗口内行） */
  const allReachable = reachable.size === last - first + 1;
  if (!allReachable) out = out.filter((w) => reachable.has(w.line));
  if (jumps.length === 0) return out;

  // `jump` 只留给**动态**跳转、且该行可达、且其后还有可达写点（防刷屏判据不变）
  const dynamicJumps = reach.dynamicJumps.length === 0 ? null : new Set(reach.dynamicJumps);
  if (dynamicJumps !== null) {
    lastWrite = 0;
    for (const w of out) if (w.line > lastWrite) lastWrite = w.line;
    let merged = false;
    for (const jump of jumps) {
      if (!dynamicJumps.has(jump.line)) continue;
      if (!allReachable && !reachable.has(jump.line)) continue;
      if (jump.line >= lastWrite) continue;
      out.push(jump);
      merged = true;
    }
    if (merged) out.sort((a, b) => a.line - b.line);
  }
  return out;
}
