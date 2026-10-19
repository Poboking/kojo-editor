/**
 * 控制流与预处理行的中文显示形（**任务线 ZH-C**）。
 *
 * 覆盖面（认得出就翻，认不出返回 `null`，**绝不原样返回**）：
 * - 块：`IF` / `ELSEIF` / `ELSE` / `ENDIF` / `SIF`；`SELECTCASE` / `CASE` / `CASEELSE` / `ENDSELECT`；
 * - 循环：`FOR … NEXT` / `WHILE … WEND` / `REPEAT … REND` / `DO … LOOP`
 *   （`LOOP <条件>` 的**尾随条件**也翻：`DO` 一族在盘上只以这一形出现）；
 * - 跳转与出口：`GOTO` / `JUMP` / `$标签` / `BREAK` / `CONTINUE` / `RESTART` / `CATCH`；
 * - **TRY 系九枚**（`TRYC{GOTO,JUMP,CALL}` ±`FORM` 六枚 + `TRY{CALL,GOTO,JUMP}LIST` 三枚）：
 *   糖层**无写形**（写形归工包 F），本层只给**中性显示形** `试探 原形 <记号> <原文>`；
 * - 数据表：`PRINTDATA[…]` / `DATAFORM` / `DATA` / `ENDDATA` / `STRDATA`（开词族同源，`数据表 原形 …`）；
 * - 数据表**分组**记号 `DATALIST` / `ENDLIST`（糖层无写形、批 N 刻意不投影）⇒ 中性显示形
 *   `分组 原形 <记号> [原文]：` / `分组结束 原形 <记号> [原文]`（与 TRY 系、停用区同一档先例）；
 * - 预处理行：`#DIM` / `#DIMS` / `#GLOBAL` / `#LOCALSIZE` / `#LOCALSSIZE` / `#FUNCTION` /
 *   `#FUNCTIONS` / `#SFUNCTION` / `#XFUNCTION` / `#TESTMEMORY` 等。
 *
 * ## 词形从哪来（两条轴，绝不混）
 *
 * 1. **语言层词形零手抄**：`如果 / 否则如果 / 否则 / 当 / 是 / 到 / 则` 与循环/跳转/数据表三族的
 *    全部词形都由 `keywords.ts` 的 `primaryWord()`（中文主形投影）、`blockEndWord()`（收束拼法）与
 *    `operatorTable()`（**反向**投影）给出 ⇒ **写形与显示形同源**，本层改不出第二个叫法。
 *    闭合行是同一套 `<块头词> + 结束`（`如果结束` / `当结束` / `循环结束` / `出错处理结束` / `数据表结束`）。
 *    本表与 `project.ts` 的 `SUGAR_CONTROL`（`如果 X：` / `当 X：` / `是 v：` / `否则：`）同一口径——
 *    预览里同一种块只会有一种中文写法。
 * 2. **本层只有两类显示词形**（`声明…` / `大小` / `预处理 <记号原文>`，以及 TRY 系的 `试探`
 *    与分组记号的 `分组` / `分组结束`）：
 *    前者是**文件级声明**、后者是**糖层无写形的控制流**（TRY 系九枚的写形归工包 F），
 *    登记进 `KEYWORDS` = 承诺"写得回去"⇒ 覆盖率闸会要求作者用一种写不回去的写法，故留在本文件、
 *    **不进词表**（显示形靠本表的记号名单触发，与 `KEYWORDS` 无关）。
 *    逐字钉值见 `tests/control-word-single-source.test.ts`。
 *
 * ## 三条判据（都与契约 `types.ts` 的红线绑在一起）
 *
 * - **表里没有的指令 ⇒ `null`**（宁缺勿猜：猜错中文义项比留兜底更坏）；
 *   认得记号但**不担保义项**的预处理指令（`#SFUNCTION` / `#XFUNCTION` / `#TESTMEMORY`）只翻
 *   「预处理」这一层，记号原样保留——翻的是**类**，不是**义**；
 * - **载荷是数据而不是条件的行 ⇒ 余文逐字带走**（`DATAFORM` / `DATA` 条目正文、`JUMP` 的函数
 *   调用串）：中文化运算符或剥前缀都会改档，这类行的显示形只换**词首那枚记号**；
 * - **`lookup` 缺席 ⇒ 只做语言层**（关键字照翻，整行仍是中文形），绝不因为没名表就返 `null`；
 * - **出口自证**：任何返回都与 `input.content` 逐字不等（装配层还会再拒一次）。
 *
 * 条件表达式里的中文化**只走 `lookup`**（族头别名）与 `keywords.ts` 的反向运算符，
 * 属性名反糖（`CFLAG:TARGET:1088` → `她的好感度`）不在本层——那是 `project.ts` 的 `nameAt` 判据，
 * 这里重抄就成了第二份口径。
 */

import { BLOCK_END_SUFFIX, NOTIN_KEYWORDS, blockEndWord, operatorTable, primaryWord as word } from '../keywords';
import { TRY_CATCH_OPEN, TRY_LIST_OPEN } from '../sugar-ident';
import type { NativeDisplayInput, NativeDisplayLookup } from './types';

/* ------------------------- 词形：全部由既有真源派生 ------------------------- */

/** 派生表（`KeywordId` → 中文主形）；逐字钉值由 `tests/control-word-single-source.test.ts` 对着本表校验 */
const IF_W = word('block.if'); // 如果
const ELIF_W = word('block.elif'); // 否则如果
const ELSE_W = word('block.else'); // 否则
const WHEN_W = word('block.when'); // 当
const IS_W = word('block.is'); // 是
const TO_W = word('inline.to'); // 到
const THEN_W = word('inline.then'); // 则
/** `不在`（只从既有表取；表里缺这项就整条 `不在` 反显不触发，绝不现造一个词） */
const NOTIN_W = NOTIN_KEYWORDS.find((k) => !/^[a-z]+$/i.test(k)) ?? '';

/** 闭合族：`<块头词> + 结束`（词尾与拼法都在 `keywords.ts`，本层不复制） */
const IF_END_W = blockEndWord('block.if');
const WHEN_END_W = blockEndWord('block.when');
const CATCH_END_W = blockEndWord('block.catch');
const LOOP_W = word('block.loop'); // 循环
const LOOP_END_W = blockEndWord('block.loop'); // 循环结束（`NEXT` / `WEND` / `REND` / `LOOP` 四枚同形）
const LOOP_COUNT_W = word('inline.loopCount'); // 计数
const LOOP_TIMES_W = word('inline.loopTimes'); // 次（`REPEAT <次数>` 的尾部量词）
const LOOP_FOREVER_W = word('inline.loopForever'); // 无限（裸 `REPEAT` = 无限循环）
const LOOP_STEP_W = word('inline.loopStep'); // 步进
const PLUS_W = word('inline.plus'); // 加
const MINUS_W = word('inline.minus'); // 减
const FROM_W = word('inline.loopFrom'); // 从
const STRIDE_W = word('inline.loopStride'); // 步长
const JUMP_W = word('inline.jump'); // 跳到（`GOTO`：目标是 `$标签`）
const FUNC_JUMP_W = word('inline.functionJump'); // 函数跳转（`JUMP`：目标是函数调用串）
const LABEL_W = word('inline.label'); // 标签
const BREAK_W = word('inline.breakLoop'); // 跳出循环
const CONTINUE_W = word('inline.continueLoop'); // 跳过本轮
const RESTART_W = word('inline.restartLoop'); // 重跑本轮
const CATCH_W = word('block.catch'); // 出错处理
const DATA_W = word('block.dataTable'); // 数据表
const DATA_END_W = blockEndWord('block.dataTable'); // 数据表结束
const DATA_ENTRY_W = word('inline.dataEntry'); // 条目
const ECHO_W = word('inline.engineEcho'); // 原形（记号回显：义项不担保的那批变体把引擎记号原样带走）

/* ---------------- 本层**独有**的显示词形（无写侧通路，故不进 `KEYWORDS`） ---------------- */

/**
 * 预处理声明的词形（`声明数组 X 大小 10` / `预处理 SFUNCTION …`）——为什么只有这一小撮还住本文件：
 * 登记进 `KEYWORDS` = 承诺"写得回去"（发版覆盖率闸按「样例里真的用过」验收），而 `#DIM` /
 * `#FUNCTION` 系**没有**写形（文件级声明不在时机块内，本批不做）——登记它只会让闸要求作者
 * 用一种写不回去的写法。
 */
const SIZE_W = '大小';
const PRE_W = '预处理';

/**
 * TRY 系九枚的**中性显示形**词头（`试探 原形 TRYCGOTO *先, LABEL:目标`）。
 *
 * 为什么这一枚也**不进 `KEYWORDS`**（同上面预处理那条理由，但更硬）：
 * 糖层对 TRY 系**连写形都还没有**（`keywords.ts:213` 的欠账、写形归工包 F），
 * 而登记 = 承诺写得回去 ⇒ 发版覆盖率闸会去要求作者用一种写不回去的写法。
 * 显示形的触发靠 `TRY_NEUTRAL_OPEN` 那张**记号名单**（`sugar-ident.ts` 的九枚真源），
 * 与 `KEYWORDS` 无耦合——所以工包 F 哪天补上写形时，只需把 `TRY_W` 换成 `word(...)`，
 * 本层零结构改动。
 *
 * 为什么形是 `试探 原形 <记号> <原文>` 而不是 `试探 <原文>`：
 * - `原形` 是本文件既有的**记号回显**装置（`数据表 原形 PRINTDATADL：` / `条目 原形 DATA <原文>`），
 *   义项不担保的那批变体都用它把引擎记号逐字带走 ⇒ 读者一眼看出"后面那串是引擎原文，不是糖写法"；
 * - 九枚分两个配对档（六枚配 `CATCH`，三枚配 `ENDFUNC`，见 `sugar-ident.ts` 的
 *   `TRY_CATCH_OPEN` / `TRY_LIST_OPEN`），**配对档位我不替读者下结论**，但**类**要认得出——
 *   与 `project.ts` 的 `停用 · <原文>` / `函数 · <原文>` 同一口径：已知结构不再喊"没读懂"，
 *   也不冒充糖。
 *
 * 载荷（目标 / 清单实参）是**数据不是条件** ⇒ 逐字带走，不剥 `$`/`*`、不中文化运算符，
 * 判据与 `JUMP` / `DATAFORM` 完全同一套。
 */
const TRY_W = '试探';

/**
 * TRY 系九枚（= 糖层无写形、只给中性显示形的那九枚）。
 *
 * **名单从 `sugar-ident.ts` 派生**，本层不抄第二份：那两集合是识别核里"哪几枚开块、配哪个闭合"的
 * 唯一真源。`statement.ts` 认领的 `TRYCALL` / `TRYCALLFORM` / `TRYJUMP`（单行语句，不在这九枚里）
 * 因此**不受本层影响**——pass 顺序（control 先、statement 后）照旧由这张名单划界。
 */
const TRY_NEUTRAL_OPEN: ReadonlySet<string> = new Set([...TRY_CATCH_OPEN, ...TRY_LIST_OPEN]);

/**
 * 数据表**分组**记号的**中性显示形**词头（`分组 原形 DATALIST：` / `分组结束 原形 ENDLIST`）。
 *
 * 为什么也**不进 `KEYWORDS`**（判据与 `试探` 逐字同一条）：糖层对这三枚没有写形
 * （`DATALIST`/`STRDATA` 在 `CONTROL_SHAPES` 只有 `structural-open`、`ENDLIST` 只有
 * `structural-close`，服务结构栈、不产出糖块）⇒ 登记 = 承诺写得回去。
 * 收束拼法借 `BLOCK_END_SUFFIX`（`分组` + `结束`），与 `keywords.ts` 的闭合族同一词尾、不另造。
 *
 * 名单**逐字内联**而不从 `CONTROL_SHAPES` 现推：那张表里没有"`ENDLIST` 配 `DATALIST`"的
 * 档位字段（`closes` 在结构栈条目上是空的），现推只能靠词形后缀猜配对——正是本层禁的姿势。
 * 名单与 `CONTROL_SHAPES` 的同源由 `tests/native-display-datagrouping.test.ts` 逐枚钉住
 * （角色 + 开块类别对不上立刻显形），语料词形普查（SANYOUSEI 盘，2026-10-20）：
 * `DATALIST` 2,380 行全裸、`ENDLIST` 2,380 行全裸、`STRDATA` 199 行（197 带名 + 2 裸），
 * 无任何数字/字母变体 ⇒ 表外词形**零认领**。
 */
const GROUP_W = '分组';
const GROUP_END_W = `${GROUP_W}${BLOCK_END_SUFFIX}`;
const DATA_GROUPING_NEUTRAL: ReadonlySet<string> = new Set(['DATALIST', 'ENDLIST', 'STRDATA']);

/* --------------------------- 表达式侧（条件形） --------------------------- */

/** ERB 运算符 → 中文运算符（`operatorTable()` 的反向投影，正反对称是构造事实） */
const ERB_TO_WORD: ReadonlyMap<string, string> = new Map(
  operatorTable().map(([cn, erb]) => [erb, cn] as const),
);

/** `等于` = 同一张反向表里 `==` 的中文主形（条件位的裸 `=` 借它显示，本层不另造词） */
const EQ_W = ERB_TO_WORD.get('==') ?? '';

/** 正则转义（`||` 这类记号进 alternation 前必须逃） */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 长式优先（`>=` 先于 `>`、`!=` 先于 `!`），由表本身排序得到，不另抄一份序列 */
const OPERATOR_RE = new RegExp(
  [...ERB_TO_WORD.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|'),
  'g',
);

/** `!(X >= a && X <= b)` → `X 不在 a 到 b`（逐字符对齐写侧 `lowerNotIn` 的产物形） */
const NOTIN_RE = /!\(\s*([^()]+?)\s*>=\s*([^()]+?)\s*&&\s*\1\s*<=\s*([^()]+?)\s*\)/g;

/** 条件位的裸 `=` 就是相等（写侧表只登记 `==` ⇒ 赋值位不折，见 `compareEquals` 入参） */
const COMPARE_EQ_RE = /(?<![=+\-*/<>!&|])=(?!=)/g;

/** `族头:` → 中文别名 + **全角冒号**（与 `project.ts` 的 D2 反糖同一形态；查不到原样保留） */
const FAMILY_HEAD_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*:/g;

/** 双引号字面量整段跳过（条件里的 `"…"` 可能恰好写着运算符字样） */
const STRING_SEG_RE = /("(?:[^"]*)")/g;

function mapCode(text: string, fn: (code: string) => string): string {
  return text
    .split(STRING_SEG_RE)
    .map((seg) => (seg.startsWith('"') ? seg : fn(seg)))
    .join('');
}

/**
 * 条件/表达式 → 显示形。四步各管一件事，顺序即判据：
 * ① `不在` 还原（要看到**原生** `>=`/`&&` 才认，故必须在运算符中文化之前）
 * ② 族头别名（`lookup` 缺席就整步跳过）
 * ③ 比较位 `=` → `等于`（只在条件位）
 * ④ 运算符中文化 + 收掉多余空白（`!` → `非 ` 会留双空格；引号段已在第 ③ 步前被隔离）
 */
function showExpr(raw: string, lookup: NativeDisplayLookup | undefined, compareEquals: boolean): string {
  const text = raw.trim();
  if (text.length === 0) return '';
  return mapCode(text, (code) => {
    let out = code;
    if (NOTIN_W.length > 0) {
      out = out.replace(NOTIN_RE, (whole, x: string, lo: string, hi: string) =>
        lo.length === 0 || hi.length === 0 ? whole : `${x} ${NOTIN_W} ${lo} ${TO_W} ${hi}`,
      );
    }
    if (lookup) {
      out = out.replace(FAMILY_HEAD_RE, (whole, name: string) => {
        const alias = lookup.familyAlias(name.toUpperCase());
        return alias === undefined || alias === name ? whole : `${alias}：`;
      });
    }
    if (compareEquals && EQ_W.length > 0) out = out.replace(COMPARE_EQ_RE, ` ${EQ_W} `);
    // 收掉多余空白（`!` → `非 ` 会留双空格）；**只在代码段内**收——引号字面量的空格属于台词
    return out
      .replace(OPERATOR_RE, (whole) => {
        const cn = ERB_TO_WORD.get(whole);
        if (cn === undefined) return whole;
        return whole === '!' ? `${cn} ` : cn; // 逻辑否定要留出词界（`非A` 读不出）
      })
      .replace(/ {2,}/g, ' ');
  }).trim();
}

/** `CASE 1 TO 5` → `1 到 5`（`到` 与写侧同一个词形；引号段不碰） */
function showCaseValues(raw: string, lookup: NativeDisplayLookup | undefined): string {
  const spaced = mapCode(raw.trim(), (code) => code.replace(/\s+TO\s+/gi, ` ${TO_W} `));
  return showExpr(spaced, lookup, false);
}

/* ----------------------------- 行形状的拆解 ----------------------------- */

/** 块头/语句：`词` + 分隔（空白或 `:`） + 余文 */
const HEAD_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s*:|\s+|$)([\s\S]*)$/;
/** 循环变量引用（`I` / `LOCAL:2`）——与步进一步同一判据，两侧共用本串 */
export const LOOP_VAR_RE = String.raw`[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z0-9_]+)*`;
/** `FOR i = 0 TO 10 STEP 2`（`STEP` 可选；界限体交回 `showExpr`） */
const FOR_RE = new RegExp(`^(${LOOP_VAR_RE})\\s*=\\s*(.+?)\\s+TO\\s+(.+?)(?:\\s+STEP\\s+(.+))?$`, 'i');
/** `FOR LOCAL, 0, 5` / `FOR COUNT, 6, 1, -1`——**语料主流形**（eraTW 实测 3,809 : 1） */
const FOR_TUPLE_RE = new RegExp(`^(${LOOP_VAR_RE})\\s*,\\s*([^,]+?)\\s*,\\s*([^,]+?)(?:\\s*,\\s*(.+))?$`);
/** 循环变量步进：`X + 1` / `X += 1` / `X - 1` / `X -= 1`（右侧只收数与标识符，不收算式 ⇒ 不猜） */
const STEP_RE = new RegExp(
  `^(${LOOP_VAR_RE})\\s*([+-])\\s*=?\\s*(\\d+|${LOOP_VAR_RE})$`,
);
/** `PRINTDATA` 族开词（九枚变体；义项差别不猜 ⇒ 走 `原形` 记号回显） */
const PRINTDATA_TOKEN_RE = /^PRINTDATA[A-Z]*$/;

/** 需要表达式的语句：空表达式 = 形态不完整，不猜（`如果 ：` 比留兜底更误导读者） */
function needExpr(payload: string, make: () => string): string | null {
  return payload.length === 0 ? null : make();
}

/** 行尾 `;` 注释与语句体分离（引号内的 `;` 不算注释起点），注释原样缀回行尾 */
function splitComment(line: string): { body: string; comment: string } {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inString = !inString;
    else if (ch === ';' && !inString) return { body: line.slice(0, i), comment: line.slice(i) };
  }
  return { body: line, comment: '' };
}

/** 跳转目标：剥掉标签记号 `$` / `*`，让名字与 `$标签` 定义行的显示形对齐 */
function showTarget(payload: string): string {
  return payload.replace(/^[$*]\s*/, '').trim();
}

/** `SIF` 冒号形的界标：引号外的第一个「`:` 后跟空白」——`TFLAG:193` 这类段分隔不是冒号形 */
function sifColonSplit(payload: string): { cond: string; cmd: string } | null {
  let inString = false;
  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i];
    if (ch === '"') inString = !inString;
    else if (ch === ':' && !inString && /\s/.test(payload[i + 1] ?? ' ')) {
      const cmd = payload.slice(i + 1).trim();
      return cmd.length === 0 ? null : { cond: payload.slice(0, i), cmd };
    }
  }
  return null;
}

/* ------------------------------- 两张表 ------------------------------- */

type Opener = (payload: string, input: NativeDisplayInput) => string | null;

/** 带表达式/带体的语句 → 中文开块形 */
const OPENERS: ReadonlyMap<string, Opener> = new Map<string, Opener>([
  ['IF', (p, i) => needExpr(p, () => `${IF_W} ${showExpr(p, i.lookup, true)}：`)],
  ['ELSEIF', (p, i) => needExpr(p, () => `${ELIF_W} ${showExpr(p, i.lookup, true)}：`)],
  ['SIF', (p, i) => renderSif(p, i)],
  ['SELECTCASE', (p, i) => needExpr(p, () => `${WHEN_W} ${showExpr(p, i.lookup, true)}：`)],
  ['CASE', (p, i) => needExpr(p, () => `${IS_W} ${showCaseValues(p, i.lookup)}：`)],
  ['WHILE', (p, i) => needExpr(p, () => `${LOOP_W} ${WHEN_W} ${showExpr(p, i.lookup, true)}：`)],
  /**
   * `REPEAT <次数>`：官方Reference的义项 = **按参数指定的次数循环**（参数可以是数式，
   * 语料真形 `REPEAT VARSIZE("TSTR")` / `REPEAT ARG:4` / `REPEAT nDegree-1`）⇒ 显示形
   * `循环 <次数> 次：`；**裸** `REPEAT`（不带参数）才是无限循环 ⇒ `循环 无限：`。
   */
  [
    'REPEAT',
    (p, i) =>
      p.length === 0
        ? `${LOOP_W} ${LOOP_FOREVER_W}：`
        : `${LOOP_W} ${showExpr(p, i.lookup, true)} ${LOOP_TIMES_W}：`,
  ],
  ['FOR', (p, i) => renderFor(p, i)],
  /**
   * `LOOP <条件>`：`DO … LOOP <条件>` 的**带体闭合形**（eraTW 盘上 `DO` 开块 210 处、
   * 闭合 210 处全带条件，裸 `LOOP` 零例——只认无体形就等于让这 210 行落兜底段）。
   *
   * 收束词与条件词形都从 `keywords.ts` 取（`LOOP_END_W` + `WHEN_W`），与写侧
   * (`lexer.ts` 的 `parseLoopEndStatement`) 同一串；空条件按 `needExpr` 判据返 `null` 不猜。
   */
  ['LOOP', (p, i) => needExpr(p, () => `${LOOP_END_W} ${WHEN_W} ${showExpr(p, i.lookup, true)}`)],
  ['GOTO', (p) => needExpr(showTarget(p), () => `${JUMP_W} ${showTarget(p)}`)],
  /**
   * `JUMP <原文>`：引擎这一枚的目标是**函数调用串**（盘上 132 处全是
   * `JUMP GMF_MAP_METHOD(CFLAG:ARG:現在位置, 1, "GETOUT", ARG)` 这一形），与 `GOTO` 的
   * 标签目标义项不同 ⇒ 另给一形 `函数跳转`，余文**逐字**带走（不剥 `$`/`*`、不中文化运算符：
   * 那是数据不是条件，改一个字符就改档）。口径同 `DATAFORM` 正文与 `原形` 记号回显。
   */
  ['JUMP', (p) => needExpr(p, () => `${FUNC_JUMP_W} ${p}`)],
  /** `DATAFORM <原文>`：条目正文**逐字**保留（它是数据不是语句，降糖会把台词改弯） */
  ['DATAFORM', (p) => needExpr(p, () => `${DATA_ENTRY_W} ${p}`)],
  /** `DATA <原文>`：与 `DATAFORM` 义项有别 ⇒ 不折成同一形，用 `原形` 把记号带走 */
  ['DATA', (p) => needExpr(p, () => `${DATA_ENTRY_W} ${ECHO_W} DATA ${p}`)],
]);

/**
 * 无体的独立行 / 收束行：`词` → 中文形（带体的这类行 = 形态不认识 ⇒ `null`）。
 *
 * `LOOP` 一枚**两表都在**，两形各归各的判据：整行只有记号 = 无体闭合行（本表，`循环结束`）；
 * `LOOP <条件>` = 带体闭合行（`OPENERS`，`循环结束 <条件词形> <条件>`）。
 * 归哪张表由 `renderBody` 的「整行是否只有那枚记号」判据决定，不看尾部标点。
 */
const STANDALONE: ReadonlyMap<string, string> = new Map<string, string>([
  ['ELSE', `${ELSE_W}：`],
  ['CASEELSE', `${ELSE_W}：`],
  ['ENDIF', IF_END_W],
  ['ENDSELECT', WHEN_END_W],
  ['NEXT', LOOP_END_W],
  ['WEND', LOOP_END_W],
  ['REND', LOOP_END_W],
  ['LOOP', LOOP_END_W],
  ['DO', `${LOOP_W}：`],
  ['BREAK', BREAK_W],
  ['CONTINUE', CONTINUE_W],
  ['RESTART', RESTART_W],
  ['CATCH', `${CATCH_W}：`],
  ['ENDCATCH', CATCH_END_W],
  ['ENDDATA', DATA_END_W],
]);

/** 预处理指令中有把握给出义项的那批（`sized` = 「名 + 大小」形） */
const PREPROCESSORS: ReadonlyMap<string, { cn: string; sized: boolean }> = new Map<
  string,
  { cn: string; sized: boolean }
>([
  ['DIM', { cn: '声明数组', sized: true }],
  ['DIMS', { cn: '声明字符串数组', sized: true }],
  ['GLOBAL', { cn: '声明全局数组', sized: true }],
  ['LOCALSIZE', { cn: '声明局部数组规模', sized: true }],
  ['LOCALSSIZE', { cn: '声明局部字符串规模', sized: true }],
  ['FUNCTION', { cn: '声明值函数', sized: false }],
  ['FUNCTIONS', { cn: '声明字符串值函数', sized: false }],
]);

/** **认得记号、不担保义项**的预处理指令：只翻「预处理」这一层，记号原样留着（翻类不翻义） */
const PRE_TOKEN_ONLY: ReadonlySet<string> = new Set(['SFUNCTION', 'XFUNCTION', 'TESTMEMORY']);

function renderSif(payload: string, input: NativeDisplayInput): string | null {
  if (payload.length === 0) return null;
  const split = sifColonSplit(payload);
  if (split === null) return `${IF_W} ${showExpr(payload, input.lookup, true)}：`;
  // 冒号形语料 0 例：只在界标清楚（`:` 后跟空白、右侧非空）时才走 `如果 … 则 …`，否则按两行形处理
  return `${IF_W} ${showExpr(split.cond, input.lookup, true)} ${THEN_W} ${showExpr(split.cmd, input.lookup, false)}`;
}

function renderFor(payload: string, input: NativeDisplayInput): string | null {
  const tuple = FOR_TUPLE_RE.exec(payload) ?? FOR_RE.exec(payload);
  if (!tuple) return null;
  const [, name, from, to, step] = tuple;
  if (name === undefined || from === undefined || to === undefined) return null;
  const stride = step === undefined ? '' : ` ${STRIDE_W} ${showExpr(step, input.lookup, false)}`;
  return `${LOOP_W} ${LOOP_COUNT_W} ${name} ${FROM_W} ${showExpr(from, input.lookup, false)} ${TO_W} ${showExpr(to, input.lookup, false)}${stride}：`;
}

/** `PRINTDATA` / `PRINTDATADL`…：裸形只有一枚（`PRINTDATA`），余下八枚变体不猜义项 ⇒ `原形` 带走记号；
 *  `STRDATA` 走同一条回显通路，其**名段**（盘上 197/199 带名）是数据 ⇒ 逐字缀在记号后 */
function renderDataOpen(kind: string, payload = ''): string {
  if (kind === 'PRINTDATA' && payload.length === 0) return `${DATA_W}：`;
  const tail = payload.length === 0 ? '' : ` ${payload}`;
  return `${DATA_W} ${ECHO_W} ${kind}${tail}：`;
}

/**
 * `DATALIST` / `ENDLIST` ⇒ 分组中性显示形（**只读面**，不改编译/转译产物、不新增写形）。
 *
 * 开/闭两形各带自己的档位（开词 `：` 结尾 = 块开词那一档，收束不带 `：` = `数据表结束`
 * 同一档）；裸记号也给中性形而不返 `null`——这**是已知结构**（批 N 只是刻意不投影，
 * 不是读不懂），落 `未识别语句` 就是谎报。载荷（盘上 0 例，防御性保留）逐字带走。
 */
function renderListGroup(kind: string, payload: string): string {
  const tail = payload.length === 0 ? '' : ` ${payload}`;
  return kind === 'ENDLIST'
    ? `${GROUP_END_W} ${ECHO_W} ${kind}${tail}`
    : `${GROUP_W} ${ECHO_W} ${kind}${tail}：`;
}

/**
 * TRY 系九枚 ⇒ 中性显示形（**只读面**，不改编译/转译产物、不新增写形）。
 *
 * 裸记号（无载荷）也给中性形而不返 `null`：那九枚**是已知结构**，落 `未识别语句` 就是在
 * 谎报"工具没读懂"；`needExpr` 那条"空表达式不猜"判据管的是**条件位**（猜错条件比留白更坏），
 * 这里载荷本来就不参与语义，回显记号不猜任何东西。
 */
function renderTry(kind: string, payload: string): string {
  return payload.length === 0 ? `${TRY_W} ${ECHO_W} ${kind}` : `${TRY_W} ${ECHO_W} ${kind} ${payload}`;
}

/** `#DIM A 10` / `#FUNCTION A(x)` / `#SFUNCTION …` */
function renderPreprocessor(body: string): string | null {
  const m = /^#([A-Za-z_][A-Za-z0-9_]*)(?:\s+([\s\S]*))?$/.exec(body);
  if (!m) return null;
  const name = (m[1] ?? '').toUpperCase();
  const payload = (m[2] ?? '').trim();
  const spec = PREPROCESSORS.get(name);
  if (spec !== undefined) {
    if (!spec.sized) return payload.length === 0 ? spec.cn : `${spec.cn} ${payload}`;
    const tokens = payload.split(/\s+/).filter((t) => t.length > 0);
    const declared = tokens[0];
    if (declared === undefined) return spec.cn;
    const rest = tokens.slice(1).join(' ');
    return rest.length === 0 ? `${spec.cn} ${declared}` : `${spec.cn} ${declared} ${SIZE_W} ${rest}`;
  }
  if (PRE_TOKEN_ONLY.has(name)) {
    return payload.length === 0 ? `${PRE_W} ${name}` : `${PRE_W} ${name} ${payload}`;
  }
  return null;
}

/** `$标签` 定义行 */
function renderLabel(body: string): string | null {
  const name = body.slice(1).trim();
  return name.length === 0 ? null : `${LABEL_W} ${name}`;
}

/* ------------------------------- 入口 ------------------------------- */

/** ZH-C 的入口（签名由 lead 钉死，禁止改名或加参） */
export function renderControlLine(input: NativeDisplayInput): string | null {
  const line = input.content.trim();
  if (line.length === 0 || line.startsWith(';') || line.startsWith('@')) return null; // 空行/注释/函数头不归本层
  const { body, comment } = splitComment(line);
  const rendered = renderBody(body.trim(), input);
  if (rendered === null) return null;
  const tail = comment.trim().length > 0 ? ` ${comment.trim()}` : '';
  const out = `${rendered}${tail}`;
  return out === input.content ? null : out; // 红线在出口处的结构性自证
}

function renderBody(body: string, input: NativeDisplayInput): string | null {
  if (body.startsWith('#')) return renderPreprocessor(body);
  if (body.startsWith('$')) return renderLabel(body);
  const m = HEAD_RE.exec(body);
  if (!m) return null;
  const kind = (m[1] ?? '').toUpperCase();
  const payload = (m[2] ?? '').trim();
  if (PRINTDATA_TOKEN_RE.test(kind) && payload.length === 0) return renderDataOpen(kind);
  // 数据表分组记号（`DATALIST` / `ENDLIST`）与 `STRDATA` 开词 ⇒ 中性显示形（名单判据见上）。
  // 位置同样在两张表**之前**：这三枚与 `OPENERS` / `STANDALONE` 零交集，先拦先赢。
  if (DATA_GROUPING_NEUTRAL.has(kind)) {
    return kind === 'STRDATA' ? renderDataOpen(kind, payload) : renderListGroup(kind, payload);
  }
  // TRY 系九枚：糖层无写形 ⇒ 中性显示形（名单在 `sugar-ident`，本层不抄第二份）。
  // 位置在两张表**之前**：这九枚与 `OPENERS` / `STANDALONE` 的记号零交集，先拦先赢，
  // 工包 F 哪天真给了写形，把这条分支删掉就回到 `OPENERS` 的正常轨道。
  if (TRY_NEUTRAL_OPEN.has(kind)) return renderTry(kind, payload);
  // 无体独立行（整行只有那枚记号）先取 `STANDALONE`——`LOOP` 一枚两表都在，
  // 裸形是收束行、带体形是条件尾随形，靠"行里除了记号还有没有别的东西"分诊，不靠尾部标点。
  const standalone = STANDALONE.get(kind);
  if (payload.length === 0 && body.toUpperCase() === kind && standalone !== undefined) return standalone;
  const opener = OPENERS.get(kind);
  if (opener !== undefined) return opener(payload, input);
  if (standalone !== undefined) return payload.length === 0 ? standalone : null;
  const step = STEP_RE.exec(body);
  if (step) {
    const [, name, sign, delta] = step;
    if (name !== undefined && sign !== undefined && delta !== undefined) {
      return `${LOOP_STEP_W} ${name} ${sign === '+' ? PLUS_W : MINUS_W} ${delta}`;
    }
  }
  return null;
}
