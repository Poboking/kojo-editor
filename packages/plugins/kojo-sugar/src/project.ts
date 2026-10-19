/**
 * 糖**投影**（B 层，2026-10-12 语法糖批）—— 原生 ERB → 糖显示（**只用于看**）。
 *
 * 依据：`docs/archive/LIFT-REMEASURE-2026-10-12.md` §7.1（"逐行局部映射 + 单行降级"）。
 *
 * ## 为什么与 `lift.ts` 分开
 *
 * `lift.ts` 的 `liftSuggest` 是**写盘口径**：它证明"这段 ERB 能安全改写成糖并写回
 * `.kojo`"，判据是整段 round-trip 逐字节一致——用它做纯显示会**过严到让功能失效**
 * （实测行覆盖仅 6.5%，见 §三）。
 *
 * 本模块是**显示口径**：把整份 ERB 投影成糖，判据换成**封闭规则表 + 逐行降级**：
 *
 * | 原生 ERB | 糖显示 |
 * |---|---|
 * | `PRINTFORMW 「台词」` / `PRINTFORMDL 旁白` | 文本行（`L` 后缀 → 行尾 ` 续`） |
 * | `PRINTL 文本` / `PRINTDW 文本` / `PRINTFORM 片段`（其余输出指令） | **文本行**（非 FORM 系**逐字符原样**，见下） |
 * | 裸指令打空行（`PRINTFORML` / `PRINTL` / `PRINTDW␠`…） | `空行`（不等待）/ `空行 等待`（`W` 系） |
 * | `IF X` / `ELSEIF X` / `ELSE` | `如果 X：` / `否则如果 X：` / `否则：` |
 * | `ENDIF` | 缩进收束（**不显示**） |
 * | `SELECTCASE X` / `CASE v` / `CASEELSE` | `当 X：` / `是 v：` / `否则：` |
 * | `ENDSELECT` | 缩进收束（不显示） |
 * | `;注释` / 空行 | **原样透传**（`;` 注释在糖里语法完全一样） |
 * | `[SKIPSTART]` … `[SKIPEND]` | 首尾标签 + 区内 `停用 · <原文>`（**1:1 行数**，不盖兜底前缀） |
 * | `@函数头` / `#声明` | `函数 · @…` / `声明 · #…`（中性陈述，不冒充糖） |
 * | 表外 `PRINT*` 台词变体 | `台词 · <原文体>`（空体 → `空行` / `空行 等待`） |
 * | `%CALLNAME:TARGET%` / `%CALLNAME:MASTER%` | `{她}` / `{你}`（**可读化**，见下） |
 * | `\@条件?A#B\@`（FORM 行内的三元输出） | `{条件 ? "A" : "B"}`（糖三元，规范 §3.4） |
 * | `SIF 条件` + 紧随的那一条语句 | `如果 条件：` + 正文 **+1 层缩进**（规范 §3.5；语料 100% 是这种两行形态） |
 * | 函数体内单独成行的 `RETURN …` / 裸 `RETURN` | **不显示**（机器码骨架；磁盘一字不动） |
 * | 值函数 `RETURNF <值>` / 裸 `RETURNF` | `返回 <值>` / `返回`（`keywords.ts` 的 `inline.return` 词形） |
 * | 其余（循环 / TRY / PRINTDATA / 按钮 …） | **本地化层给的中文形**；认不出 ⇒ `未识别语句 · <原文>` |
 *
 * ## 红线（2026-10-17 全中文化系列，口径住 `native-display/types.ts`）
 *
 * > **屏上不许出现一整行原样 ERB。** 行内残留英文记号（引擎函数名、槽位原名）允许。
 *
 * 两条接线都在本文件：① 认不出的行走 `localizeNativeLine`，兜底形固定为
 * `未识别语句 · <原文>` 并且**必须成段**（段外宿主就取原文，隐身等于透传）；
 * ② `RETURN` 骨架行一律吸收。尺子只有一把：`countVerbatimNativeLines`，命中数必须 0。
 *
 * ## 可读化（本模块与 `lift.ts` 最大的取向差异）
 *
 * 服务对象是**不熟悉 EraBasic 的读者**：他打开别人写的口上，要能像看剧本一样读懂。
 * `%CALLNAME:MASTER%` 这种记号正是"读不懂"的元凶，故在**文本体**内反糖为糖的
 * 标准代词写法 `{你}` / `{她}`（规范 §3.4）。
 *
 * 四条纪律：
 *
 * 1. **只反糖认得的记号**。代词反向表由 `expression.ts` 的 `PRONOUN_MAP` **派生**
 *    （`PRONOUN_REVERSE`），正反对称是构造事实。属性反糖（`{CFLAG:TARGET:1088}` →
 *    `{她的好感度}`）靠字典的**反向**查询（`DictionaryLookup.nameAt`），
 *    **查不到名称一律不动**——猜错会把 `TALENT:TARGET:3` 显示成 `她的3`，
 *    属于"看着像懂了其实被误导"。
 * 2. **只在 FORM 系行反糖**（`PRINTFORM*` 才展开 `%…%` / `{…}` / `\@…\@`）。
 *    非 FORM 输出行（`PRINTL` / `PRINTDW` / `PRINTDL`…）里的这些记号是**被打印的字面字符**，
 *    动它就等于篡改读者看到的文本。真实语料实证：非 FORM 行含 `%…%` 仅 5/62,651 行，
 *    而 `PRINTDL` 含 `\@` 的 518 行**全是 ASCII 图形文字**。
 * 3. **只改文本体，不碰控制流表达式**。`%…%` 是 FORM 串形态，在条件位置本就非法，
 *    不去动它也就不可能把条件改坏。
 * 4. 反糖是**显示**，不改判据：即使文本里出现糖里不认识的写法，也照常显示
 *    （投影不承诺可编译——那是 `lift.ts` 的自证口径）。
 *
 * ## 关键性质
 *
 * 1. **天生不怕嵌套**：每行独立判定，缩进直接查 `scanControlFlow` 的 `depth`；
 *    一行失败只影响那一行（`lift.ts` 的链式 `return null` 不复存在）。
 * 2. **不需要动冻结规范**：本模块不产出 `.ERB`，只产出显示。
 * 3. **误映射风险由 depth/上下文封住**：`PRINTDATA` 数据表体、`[SKIPSTART]` 区内的行
 *    即使形如 `PRINTFORM*` 也不映射（判据来自结构，不只是行首正则）。
 *
 * ## 依赖方向（单向，无环）
 *
 * 只注入 `scanControlFlow`（`erb-parser` 的公开纯函数）；**不调用 `transpile`**
 * （投影不需要自证）。缺席时降级：无结构信息 → 只按行首规则映射台词行，控制流行
 * 一律原样保留，缩进退回原文缩进层。
 */

import type {
  ControlFlowStatement,
  SugarProjectNativeReason,
  SugarProjectRequest,
  SugarProjectResult,
  SugarProjectSegment,
  SugarProjectStats,
} from '@kojo/plugin-api';
import type { LiftDeps } from './lift';
import type { DictionaryLookup } from './types';
import { PRONOUN_REVERSE } from './expression';
import { SYSTEM_FUNCTION_REVERSE } from './system-functions';
import { isIdentPart, isIdentStart } from './identifier-chars';
import { stripInlineComment } from './lexer';
import { buildFaceNameIndex, stripParams } from './faces-reverse';
import type { FaceNameIndex } from './faces-reverse';
// 形态识别**一张表**（W5 LIFT-PROJ-ALIGN）：本文件不再自带 PRINT / 控制流 / 空行 /
// 行内三元 / `SIF` 的判据——那些与 `lift.ts`（写回口径）是同一族知识，抄两份必分叉。
import {
  NON_BODY_LINE_KINDS,
  PRINTDATA_OPEN,
  PRINT_FAMILY_RE,
  PRINT_VARIANTS,
  blankLineSugar,
  bodyIsComment,
  contentOf,
  controlHeadMaker,
  contMark,
  hasCommandColon,
  hasInlineCondition,
  indentLevelOf,
  inlineConditionsToSugar,
  isCloseKind,
  needsExpression,
  pairOf,
  splitSourceLines,
  trimTrailingSpace,
} from './sugar-ident';
import { localizeNativeLine } from './native-display/passes';
import type { NativeDisplayLookup } from './native-display/types';

/* ============================== 规则表（封闭） ============================== */

/**
 * **角色作用域**的数值变量族（属性反糖只认这些）。
 *
 * 为什么必须有这张表：ERB 里 `FLAG:70` 与 `CFLAG:TARGET:70` 长得一样但语义天差地别——
 * `FLAG` 是**全局**族，写成糖的 `她的FLAG` 是错的。故只给"角色作用域"的族发糖；
 * 全局族（`FLAG`/`TFLAG`/`GLOBAL`/`DAY`/`MONEY`…）原样保留。
 *
 * 批 L 之后这张表管的是"**能不能落到角色属性写法**"的族范围：`TARGET`/`MASTER`/`PLAYER`
 * 作用域 → `她的X`/`你的X`，**数字角色号**作用域 → `角色12的X`（规范 §3.8 扩）。
 * 动态角色作用域（`ARG`/`LOCAL`/作者自己的角色号变量）仍然一律不动——糖里没有承诺写法。
 *
 * 表的来源是引擎的变量族划分（`VariableParser.ReduceVariable` 的角色分支），
 * 属**语言/引擎级**知识（与 `PRINT_VARIANTS` 同类），不是某个游戏的知识。
 */
const CHAR_SCOPED_FAMILIES: ReadonlySet<string> = new Set([
  'CFLAG',
  'TALENT',
  'ABL',
  'EXP',
  'MARK',
  'BASE',
  'PALAM',
  'TEQUIP',
  'TCVAR',
]);

/* ============================== 控制流：识别核派生的块头记录 ============================== */

/**
 * 控制流行 → 块头记录（`如果 …：` / `当 …：` / 收束行）。
 *
 * **单一口径**：主循环与 CR-1 的「段折叠回退」（`unfoldSectionEnvelope`）都调这一个函数——
 * 回退一条 `IF LOCAL && 条件` 时若另抄一份判据，两份规则迟早分叉（本项目已多次踩过）。
 *
 * 但**文本本身**不住这里：它来自识别核的 `CONTROL_SHAPES`（`controlHeadMaker`），
 * 与建议侧（`lift.ts` 组装糖片段时）用的是同一张表——历史上这里是 `SUGAR_CONTROL`、
 * 那里是散落在 `buildIfSugar` / `buildWhenSugar` 里的模板串，加一族关键字要改两处。
 *
 * 返回 `undefined` = 该 `kind` 没有糖块头形态（调用方自行决定留原代码）。
 * `SIF` 走**不到**这里：它的显示判据是"管辖恰好一条语句"（`planSif` 专管，判据不满足
 * 就整行不动），所以 `controlHeadMaker` 对 `single-line-head` 一律返回 `undefined`。
 */
function controlHeadRec(
  ln: number,
  st: ControlFlowStatement,
  deps: LiftDeps,
  native: NativeRecFactory,
): LineRec | undefined {
  const mk = controlHeadMaker(st.kind);
  if (mk === undefined) return undefined;
  const expr = st.expression.trim();
  // 需要表达式的块头若表达式为空 → 不猜，交给 native 口径（本地化 / 兜底，绝不原样上屏）
  if (needsExpression(st.kind) && expr.length === 0) return native(ln, 'other');
  const text = mk(reverseExprAttributes(expr, deps));
  return {
    line: ln,
    kind: 'control',
    text: text ?? '',
    indent: st.depth,
    visible: text !== null,
    reason: null,
  };
}

/* ============== P-8：MESSAGECHECK 数字返回协议投影（纯显示） ============== */

/**
 * P-8：MESSAGECHECK 数字返回协议投影（**不做新糖**，只用于看）。
 *
 * 语法层 `隐藏情景:` / `隐藏口上:` 的现行产物是 `SETBIT RESULT, {bit}`
 * （adapter `messageCheck.bits`：`scene`→位 0、`kojo`→位 1）。旧/遗留文件用的是
 * **数字返回**（`M_KOJO_K30_愛撫系コマンド.ERB:816-823` 的 `RETURN 0/1/2/3`），
 * 引擎侧 `KOJO_MESSAGE.ERB:227-229` 以 `GETBIT(RESULT, 0/1)` 读位——两者语义同构
 * （数字即**位掩码**）：
 *
 * - `RETURN 0` → 不置位：情景、口上**都显示**（无对应糖子句）；
 * - `RETURN 1` → 置位 0：**隐藏情景**（description 隐藏）；
 * - `RETURN 2` → 置位 1：**隐藏口上**（KOJO 隐藏）；
 * - `RETURN 3` → 置位 0+1：两者都隐藏。
 *
 * **数字返回给不出条件**（条件在包着它的 `IF` 上，见 K30 的 `IF TFLAG:193`），
 * 故注记是**标记**而非糖块：`隐藏情景（数字返回 1）：`——如实标出来历，绝不伪造条件。
 * 写回仍以 SETBIT 形为准。
 */

/** 正则元字符转义 */
const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 作用域语义名 → 糖子句（语法层口径，与 lexer 的 `隐藏情景/隐藏口上` 同源） */
const MESSAGE_CHECK_CLAUSE: Readonly<Record<string, string>> = {
  scene: '隐藏情景',
  kojo: '隐藏口上',
};

/**
 * 从 adapter 的 MESSAGECHECK 模板抽出**判别字面片段**（占位符以外的定长串）。
 * 只保留长度 ≥ 3 的片段：`_` / `_K` 这类太泛，当判别串会误伤同前缀的普通函数头。
 * `${段}`（如 `${com}`）也属占位符，须连同前导 `$` 一起切掉，否则残留的 `$` 让片段
 * 永远匹配不到真实函数头（`_MESSAGE_MESSAGECHECK_$` ≠ 产物里的 `..._MESSAGECHECK_COM_...`）。
 */
function messageCheckLiteralFragments(template: string): string[] {
  return template
    .split(/\$\{[^}]*\}|\{[^}]*\}/g)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
}

/** 把 adapter 的置位原语模板（`{bit}` 占位）编成行匹配正则（空白宽松、忽略大小写） */
function buildBitLineRegex(template: string): RegExp {
  const [pre = '', post = ''] = template.split('{bit}');
  const norm = (s: string): string =>
    s
      .trim()
      .split(/\s+/)
      .map(reEscape)
      .join('[ \\t]+');
  const before = norm(pre);
  const after = post.trim().length === 0 ? '' : `[ \\t]*${norm(post)}`;
  return new RegExp(`^[ \\t]*${before}[ \\t]*(\\d+)[ \\t]*${after}[ \\t]*$`, 'i');
}

/** `RETURN <数字>` 判别（MESSAGECHECK 数字返回协议；模块级预编译，PS-8） */
const MESSAGE_CHECK_RETURN_RE = /^RETURN\s+(\d+)\s*$/i;

/**
 * PS-8：`bits` 表 → 注记所需的**一次性**派生量（每投影算一遍，不再是每个体内行一遍）：
 * - `sortedBits`：位号去重升序（原 `[...new Set(Object.values(bits))].sort` 每行重建）；
 * - `clauseByBit`：位号 → 糖子句（首见作用域胜出，与原 `clauseOf` 的
 *   `Object.entries` 顺序语义逐字一致——首个声明该位的作用域即胜出，哪怕它的子句没定义）。
 */
interface MessageCheckNotes {
  readonly setBitRe: RegExp;
  readonly sortedBits: readonly number[];
  readonly clauseByBit: ReadonlyMap<number, string | undefined>;
}

function prepareMessageCheckNotes(
  bits: Readonly<Record<string, number>>,
  setBitRe: RegExp,
): MessageCheckNotes {
  const clauseByBit = new Map<number, string | undefined>();
  for (const [scope, declared] of Object.entries(bits)) {
    if (!clauseByBit.has(declared)) clauseByBit.set(declared, MESSAGE_CHECK_CLAUSE[scope]);
  }
  return {
    setBitRe,
    sortedBits: [...new Set(Object.values(bits))].sort((a, b) => a - b),
    clauseByBit,
  };
}

/**
 * P-8：MECHECK 体内一行的注记（`undefined` = 不是协议行 / 还原不出糖子句 → 保持原生）。
 *
 * 只认两种形态（都由 adapter 声明派生，零硬编码游戏名词）：
 * 1. `RETURN n`：n 是**位掩码**（引擎读位），逐位映射到糖子句；
 * 2. adapter `setBit` 模板（缺省 `SETBIT RESULT, {bit}`）：n 是**位号**（与糖产物同形）。
 */
function messageCheckNote(content: string, notes: MessageCheckNotes): string | undefined {
  const ret = MESSAGE_CHECK_RETURN_RE.exec(content);
  if (ret) {
    const value = Number(ret[1]);
    const names: string[] = [];
    for (const bit of notes.sortedBits) {
      if ((value & (1 << bit)) !== 0) {
        const clause = notes.clauseByBit.get(bit);
        if (clause !== undefined) names.push(clause);
      }
    }
    // 不置任何已声明位（如 `RETURN 0` = 两者都显示）→ 无对应糖子句 → 不伪造，保持原生
    return names.length === 0 ? undefined : `${names.join(' · ')}（数字返回 ${value}）：`;
  }

  const sb = notes.setBitRe.exec(content);
  if (sb) {
    const clause = notes.clauseByBit.get(Number(sb[1]));
    return clause === undefined ? undefined : `${clause}：`;
  }
  return undefined;
}

/* ============================== 入口 ============================== */

/** 生成整文件糖投影（同步纯函数；不读盘、不写盘、不发事件） */
export function liftProject(deps: LiftDeps, request: SugarProjectRequest): SugarProjectResult {
  const { source } = request;
  if (typeof source !== 'string') {
    throw new TypeError('.kojo 投影的输入必须是字符串（原生 ERB 文本）');
  }

  const lines = splitSourceLines(source);
  const total = lines.length;
  const statements = deps.scanControlFlow ? safeScan(deps.scanControlFlow, source) : [];
  const ctx = buildContext(lines, statements);
  // 演出：`SETCOLOR …` / `RESETCOLOR` **配对**成「着色 …：」块（规范 §3.9）。
  // 配不上的一律原样保留（真实语料 SETCOLOR 22,487 对 RESETCOLOR 6,312——多数没有配对的
  // 收尾，猜边界会把别人的代码藏起来）。
  const color = planColorBlocks(lines, ctx);
  // 函数骨架（包装三联 + 記入チェック信封）——判据全部"可证明"，配不上就不动。
  const plan0 = planSkeleton(lines, ctx, deps);
  // `SIF 条件` + 下一行单语句 → 「如果 …：」块头 + 正文 +1 层缩进（批 H）
  const sif = planSif(lines, ctx);
  // 数据表（PRINTDATA 系）→ 块头标注 + 条目可读化（批 N；判据不满足的块整块不动）
  const data = planDataBlocks(lines, ctx);
  // 函数头 → 「时机 …：」（批 I）。**分野表缺席 = 一个头都不标**（不猜），与
  // `codegen.resolveFace` 的 `timing-face-unknown` fail-closed 同一条纪律。
  const faceTable = deps.faceTable?.();
  const headIndex = faceTable === undefined ? undefined : buildFaceNameIndex(faceTable);
  // 标了标签的那个头，其函数体 +1 层（规范 §3.2「正文缩进一级」）
  const fnBump = planFunctionBumps(lines, headIndex);
  // P-8：MESSAGECHECK 数字返回协议（纯显示）。协议来自 adapter——缺席 = 一条都不标。
  // 函数名模板**逐面**（`KojoFaceTemplate.messageCheck`）：判别串取全部分野模板的片段并集，
  // 头部命中**任一面**的片段集即视为 MESSAGECHECK 体（各面插入点不同，片段也各不同）。
  const mcProto = faceTable?.messageCheck;
  const mcFragmentSets =
    faceTable === undefined
      ? []
      : Object.values(faceTable.faces)
          .map((f) => f.messageCheck?.template)
          .filter((t): t is string => t !== undefined)
          .map(messageCheckLiteralFragments);
  // PS-8：位号表 / 置位正则**每投影备一次**（改前是每个 MECHECK 体内行重建一遍位表）
  const mcNotes =
    mcProto?.bits !== undefined
      ? prepareMessageCheckNotes(mcProto.bits, buildBitLineRegex(mcProto.setBit ?? 'SETBIT RESULT, {bit}'))
      : null;

  // native 行的显示口径（红线 1）：pass 命中 → 中文形，否则 → `未识别语句 · …` 兜底形。
  // 一份投影一份工厂（绑 `lines` / `ctx` / `deps`），`buildRecs` 里所有 `native()` 落点共用，
  // 不存在第二条"这行怎么显示"的路径。
  const native = makeNativeRec(lines, ctx, deps);
  // 函数骨架 `RETURN`（红线 2）：函数体内单独成行的 `RETURN …` 一律吸收，`RETURNF …` → `返回 …`。
  const returns = planReturnLines(lines);

  const nativeByReason = new Map<SugarProjectNativeReason, number>();
  // E13-1②：家族 fork 改发文件头 `口上: <家族名>`——只发一次；源里已有 `口上:`
  // 声明（作者自己写过）时不重复发。
  const sourceDeclaresFamily = lines.some((l) => /^\s*口上\s*[:：]/.test(l));

  /* ---- 逐行分类管线（CR-1：收成一个以 `SkeletonPlan` 为唯一输入的闭包）----
   *
   * 为什么是闭包而不是就地改写记录：回退一段折叠需要变化的**只有**"这一段不折了"，
   * 其余每一行的分类判据一个字都不许动。就地改写 `recs` 就得在第二处再抄一遍
   * "这一行本来该怎么投"（`LOCAL = n` → 原样、`IF …` → `如果 …：`、`ENDIF` → 收束），
   * 两处口径迟早分叉——本项目反复栽过的同类坑。故回退 = **换一份 plan 重跑同一条管线**。
   * 只有真的需要回退的文件才付第二次遍历的代价（全语料实测见 CR-1 读数）。
   */
  const buildRecs = (plan: SkeletonPlan): LineRec[] => {
    const skeleton = plan;
    const recs: LineRec[] = [];
    let inSkip = false;
    // P-8：当前行是否落在 MESSAGECHECK 函数体内（函数头切换；体内 `RETURN`/`SETBIT` 才有位协议语义）
    let inMessageCheck = false;
    let familyHeaderEmitted = false;
    // E13-1 同源：选择器（`_1`）记在选择器登记函数上（`@M_KOJO_K58_1`），家族名记在带
    // `{t}` 的时机函数上——两者合成文件头一行 `口上: <家族名> 选择器: <n>`。
    let pendingSelector: number | undefined;

    for (let i = 0; i < total; i++) {
      const ln = i + 1;
      const raw = lines[i]!;
      const content = contentOf(raw);

      if (content === '[SKIPSTART]') {
        // 停用区（引擎不执行）是**已知结构**，不是"工具没读懂"：首行给结构标签，
        // 区内每一行仍占一条投影行（宿主按区间行数对齐），但一律不盖兜底前缀。
        inSkip = true;
        recs.push({
          line: ln,
          kind: 'native',
          text: SKIP_REGION_LABEL,
          indent: ctx.indentAt(ln, raw),
          visible: true,
          reason: 'data-or-skip',
        });
        continue;
      }
      if (inSkip) {
        const ended = content === '[SKIPEND]';
        if (ended) inSkip = false;
        // 区内正文保留可读性（作者常把变量自文档写在停用区里），只用中性前缀，
        // 绝不与原行逐字相等；注释按注释原样（红线尺子本就豁免 `;`），空行隐身占位。
        const text = ended
          ? SKIP_REGION_END_LABEL
          : content.length === 0 || content.startsWith(';')
            ? content
            : `${SKIP_REGION_BODY_PREFIX}${content}`;
        recs.push({
          line: ln,
          kind: 'native',
          text,
          indent: ctx.indentAt(ln, raw),
          // 空行也必须 visible：段内行数 1:1 是宿主对齐的硬前提，空串自会渲染成空行。
          visible: true,
          reason: 'data-or-skip',
        });
        continue;
      }
      if (content.length === 0 || content.startsWith(';')) {
        // 注释 / 空行 → 透传（糖表层语法与 ERB 完全一致）
        recs.push({
          line: ln,
          kind: 'passthrough',
          text: content,
          indent: ctx.indentAt(ln, raw),
          visible: true,
          reason: null,
        });
        continue;
      }

      // P-8：函数头切换 MESSAGECHECK 作用域——体内 `RETURN n` / `SETBIT RESULT, n` 才有位协议语义。
      if (content.startsWith('@')) {
        inMessageCheck = mcFragmentSets.some(
          (frags) => frags.length > 0 && frags.every((f) => content.includes(f)),
        );
      }

      // 函数骨架：被合并吸收的行不产出可见行（读者不必看见 `CALL x_1` / `IF LOCAL` 包裹）
      if (skeleton.absorbed.has(ln)) {
        recs.push({
          line: ln,
          kind: 'control',
          text: '',
          indent: 0,
          visible: false,
          reason: null,
        });
        continue;
      }

      // 段信封（E13-2）：`LOCAL = n` + `IF LOCAL && <条件>` + `ENDIF` 折叠成一层
      // `若 <条件>：` 头。头落在原 `IF` 那一行上，段体保持原相对深度（它本来就比 `IF` 深一层）。
      // 值 `0`（停用占位）的信封**不折**——见 `planSkeleton` 的"值 0 一律不折"条款。
      const sectionHead = skeleton.sectionHeadAt.get(ln);
      if (sectionHead !== undefined) {
        recs.push({
          line: ln,
          kind: 'control',
          text: sectionHead,
          indent: ctx.indentAt(ln, raw),
          visible: true,
          reason: null,
        });
        continue;
      }

      // 着色块：配对成功的那行 SETCOLOR → 块头；配对的 RESETCOLOR → 被吸收（不产出可见行）
      const colorOpen = color.openAt.get(ln);
      if (colorOpen !== undefined) {
        recs.push({
          line: ln,
          kind: 'control',
          text: `着色 ${colorOpen}：`,
          indent: ctx.indentAt(ln, raw),
          visible: true,
          reason: null,
        });
        continue;
      }
      if (color.absorbed.has(ln)) {
        recs.push({
          line: ln,
          kind: 'control',
          text: '',
          indent: ctx.indentAt(ln, raw),
          visible: false,
          reason: null,
        });
        continue;
      }

      // 数据表（PRINTDATA 系，批 N）：块头一条结构标注，条目行降成缩进的候选清单。
      // 本标注**不借用糖关键字**、只是读视图；可写的 `数据表：/条目` 形不在这里出——
      // 结构判据没收的数据行由 `makeNativeRec` 强制兜底（混块/游离行投成糖 = 读了写不回）。
      const dataLabel = data.labelAt.get(ln);
      if (dataLabel !== undefined) {
        recs.push({
          line: ln,
          kind: 'control',
          text: dataLabel,
          indent: ctx.indentAt(ln, raw),
          visible: true,
          reason: null,
        });
        continue;
      }
      if (data.absorbed.has(ln)) {
        recs.push({
          line: ln,
          kind: 'control',
          text: '',
          indent: ctx.indentAt(ln, raw),
          visible: false,
          reason: null,
        });
        continue;
      }
      const dataEntry = data.entryAt.get(ln);
      if (dataEntry !== undefined) {
        const body = trimTrailingSpace(dataEntry);
        if (body.length === 0) {
          recs.push(native(ln, 'data-or-skip')); // 空条目：没有可显示的东西
          continue;
        }
        const text = hasInlineCondition(body)
          ? projectInlineConditionsToSugar(body, deps)
          : readableText(body, deps);
        if (text === undefined) {
          recs.push(native(ln, 'inline-condition'));
          continue;
        }
        recs.push({
          line: ln,
          kind: 'speech',
          text,
          indent: data.entryIndentAt.get(ln) ?? ctx.indentAt(ln, raw),
          visible: true,
          reason: null,
        });
        continue;
      }

      // P-8：MESSAGECHECK 数字返回协议（纯显示）——只在 MECHECK 函数体内生效。
      // 判据：`RETURN n`（位掩码）或 adapter 置位原语（位号）；解不出糖子句 → 保持原生。
      if (inMessageCheck && mcNotes !== null) {
        const note = messageCheckNote(content, mcNotes);
        if (note !== undefined) {
          recs.push({
            line: ln,
            kind: 'control',
            text: note,
            indent: ctx.indentAt(ln, raw),
            visible: true,
            reason: null,
          });
          continue;
        }
      }

      // 函数骨架 `RETURN`（红线 2）：函数体内**单独成行**的 `RETURN …` 一律不上屏。
      // 位置在 MESSAGECHECK 数字返回**之后**：那里的 `RETURN 1/2/3` 已被读成糖子句
      // （`隐藏情景（数字返回 1）：`），信息量比"吸收"大，不能被骨架吃掉。
      if (returns.absorbed.has(ln)) {
        recs.push({
          line: ln,
          kind: 'control',
          text: '',
          indent: 0,
          visible: false,
          reason: null,
        });
        continue;
      }
      // `RETURNF <值>` 是作者的返回值、不是机器码 ⇒ 显示成糖的 `返回 …`（可写形同款词）
      const returnForm = returns.displayAt.get(ln);
      if (returnForm !== undefined) {
        recs.push({
          line: ln,
          kind: 'control',
          text: returnForm,
          indent: ctx.indentAt(ln, raw),
          visible: true,
          reason: null,
        });
        continue;
      }

      const st = ctx.stmtAt(ln);
      if (st) {
        // `SIF 条件` → 块头「如果 …：」（批 H；它管辖的那一正文行在缩进补正里 +1 层）
        if (st.kind === 'SIF' && sif.headAt.has(ln)) {
          recs.push({
            line: ln,
            kind: 'control',
            text: `如果 ${reverseExprAttributes(st.expression.trim(), deps)}：`,
            indent: st.depth,
            visible: true,
            reason: null,
          });
          continue;
        }
        const cr = controlHeadRec(ln, st, deps, native);
        if (cr !== undefined) {
          recs.push(cr);
          continue;
        }
        // 其余控制流（循环 / TRY / PRINTDATA / 标签等，以及**判据不满足的 SIF**）→ 原样保留
        recs.push(native(ln, 'unsupported-control-flow'));
        continue;
      }

      const pm = PRINT_FAMILY_RE.exec(content);
      if (pm) {
        const word = pm[1]!;
        const variant = PRINT_VARIANTS.get(word);
        if (!variant) {
          recs.push(native(ln, 'unsupported-print-variant'));
          continue;
        }
        // 结构判据**先于**内容判据：落在 PRINTDATA 数据表体内的行是"数据"而非"显示
        // 语句"，无论它长什么样（哪怕文本体为空）都不该被当成台词投影。
        if (ctx.enclosingAt(ln).includes('data')) {
          recs.push(native(ln, 'data-or-skip'));
          continue;
        }
        const body = trimTrailingSpace(pm[2]!);
        // 指令后紧跟 `;` → 这里是**注释**而不是要打印的字（Emuera 的 `;` 在任意位置起效）。
        // 一行给不出"空行 + 注释"两行糖显示 → 走 native 的已知结构显示形
        // （`空行[ 等待] + 注释原文`），不再盖"未识别语句"。
        if (bodyIsComment(body)) {
          recs.push(native(ln, 'unsupported-print-variant'));
          continue;
        }
        if (body.length === 0) {
          // ---- 「输出一行空行」----
          //
          // 作者用**裸指令**打空行（`PRINTFORMW` / `PRINTFORMDL␠` / `PRINTL` / `PRINTDW␠`）。
          // 真实语料里这不是零星写法：全量 2,285 文件中 `L`/`W` 变体的空体约 **16 万行**
          // （FORM 系）+ **4.6 万行**（非 FORM 系：`PRINTL` 48%、`PRINTW` 97.4%、
          // `PRINTDW` 99.1%、`PRINTDL` 57.1% 为空体），且**形态 100% 是"指令后为空"**。
          //
          // 糖表面 v1.4 补上了"输出空行"的写法（`空行`；§3.10 的空白行是分隔符、不产出），
          // 故投影**回到等价改写**：按"读者在游戏里看到的节奏"投影成能往返回去的那一行。收益有两层：
          //   ① 读者看到的是剧本节奏 / 糖写法，而不是一片 `PRINTFORMDL␠` / `PRINTW` 噪声；
          //   ② 它不再**切断**糖段——实测中它是段数暴涨的头号原因。
          //
          // 判据边界：**只有 `newline` 的变体**才算打空行。无后缀的 `PRINT` / `PRINTFORM`
          // 空体既不输出也不换行（是拼句片段的空段）——结构上不进糖行；显示层仍按已知结构
          // 给 `空行`（不谎称「续/等待」），不再盖"未识别语句"。
          //
          // 批 P 补掉这里记在案的代价（v1.5 对齐语料主流）：空行不再按 `D` 归属分，只按**等待**分——
          // 默认不等待投影为糖里能写出来的 `空行`（裸 `PRINTFORML`），`W` 系投影为 `空行 等待`
          // （`PRINTFORMDW`）。两种节奏（等待 / 不等待）仍可分辨，且都是糖里写得出、能往返的一行。
          if (!variant.newline) {
            recs.push(native(ln, 'unsupported-print-variant'));
            continue;
          }
          recs.push({
            line: ln,
            kind: 'speech',
            text: blankLineSugar(variant.wait),
            indent: ctx.indentAt(ln, raw),
            visible: true,
            reason: null,
          });
          continue;
        }
        // **可读化只对 FORM 行做**（文件头纪律 2）；非 FORM 行逐字符原样。
        // FORM 行的行内条件 `\@cond?A#B\@` 先降为糖三元（批 G）；解析不了 → 整行原样（不猜）。
        let text: string | undefined;
        if (!variant.form) {
          text = body;
        } else {
          text = hasInlineCondition(body)
            ? projectInlineConditionsToSugar(body, deps)
            : readableText(body, deps);
        }
        if (text === undefined) {
          recs.push(native(ln, 'inline-condition'));
          continue;
        }
        recs.push({
          line: ln,
          kind: 'speech',
          text: `${text}${contMark(variant)}`,
          indent: ctx.indentAt(ln, raw),
          visible: true,
          reason: null,
        });
        continue;
      }

      // 演出行：`CALL HPH_PRINT,@"…","L"` → `心形 …… 续`（批 K，规范 §3.9）。
      const heart = heartProjection(content, deps);
      if (heart !== undefined) {
        recs.push({
          line: ln,
          kind: 'speech',
          text: heart,
          indent: ctx.indentAt(ln, raw),
          visible: true,
          reason: null,
        });
        continue;
      }

      // 函数头：反解成糖的「时机 …：」块头（批 I）。解不出 / 歧义 → 原样留原代码
      if (content.startsWith('@') && headIndex !== undefined) {
        const fnName = stripParams(content.slice(1).trim());
        // 选择器登记函数（`@M_KOJO_K58_1`）——先记下选择器，供随后带 `{t}` 的函数头
        // 在文件头合成 `口上: <家族名> 选择器: <n>`。
        const sel = headIndex.selector(fnName);
        if (sel !== undefined) pendingSelector = sel;
        const label = headIndex.label(fnName);
        if (label !== undefined) {
          // E13-1②：家族 fork（`_TOKI`）不再塞进块头（全角括号会让编号段被当成中文
          // 指令名，转译必报错），改为在投影产物里发一行**文件头** `口上: <家族名>`
          // ——那才是可写形的真实声明（`口上:` 的取值规则见规范 §3.1）。只发一次；
          // 源文本里已有 `口上:` 声明时一个都不发（不重复）。选择器（有则）随行带出。
          const family = headIndex.family(fnName);
          const decl =
            family !== undefined && !familyHeaderEmitted && !sourceDeclaresFamily
              ? `口上: ${family}${pendingSelector !== undefined ? ` 选择器: ${pendingSelector}` : ''}`
              : undefined;
          if (decl === undefined) {
            recs.push({
              line: ln,
              kind: 'control',
              text: label,
              indent: ctx.indentAt(ln, raw),
              visible: true,
              reason: null,
            });
            continue;
          }
          familyHeaderEmitted = true;
          // 这条记录**一行源出两行糖**，故必须逐行点名源行（契约 `sourceLines` 的分叉起点就在这）。
          // 两行都回指 `ln`，理由不是"懒得区分"：`口上: <家族名>` 的家族名与选择器是从**这一行**
          // 登记名 `@…` 里解出来的（`headIndex.family` / `headIndex.selector` 只吃 `fnName`），
          // 源文件里那一行确实存在、也确实是被读的那一行——指别的行（0 或邻行）才是撒谎。
          // 于是预览里点这两行中的任意一行都落在同一个 `@` 头，语义正确（块头与其署名同源）。
          recs.push({
            line: ln,
            kind: 'control',
            text: `${decl}\n${label}`,
            lineSources: [ln, ln],
            indent: ctx.indentAt(ln, raw),
            visible: true,
            reason: null,
          });
          continue;
        }
      }

      // 状态变化行：`CFLAG:TARGET:1088 = "热情"` → `她的心情 = "热情"`（批 J）。
      // 反糖**一个字都没改动**就留原代码——半中不日的行既不给读者信息，也不是他能写的。
      const assign = stateAssignment(content);
      if (assign !== undefined) {
        const sugar = reverseExprAttributes(content, deps);
        if (sugar !== content) {
          recs.push({
            line: ln,
            kind: 'speech',
            text: sugar,
            indent: ctx.indentAt(ln, raw),
            visible: true,
            reason: null,
          });
          continue;
        }
      }

      // 其余（赋值 / 调用 / `@` / `#` / `$` / 其他指令）→ 原样保留
      recs.push(native(ln, 'other'));
    }
    return recs;
  };

  /* ---- CR-1：段折叠回退（P-1R 手段 3 —— 触发条件一字未动，**动作**换了）----
   *
   * 触发（原样保留）：函数范围内既折出了 `若` 段头、又会被 native 行切成**两段以上**可映射段。
   * 此时「时机」顶层同时存在段块与普通正文：段块的产物里没有外层 `IF LOCAL` 信封，混排没有
   * 唯一可写回的形状（写侧 `codegen` 报 `section-mixed`）；而 `toSegment` 的缩进基准逐段重置，
   * 段一被切开，拼接后缩进与块结构互不相认（实测报 `section-unclosed` / `indent-mismatch`）。
   *
   * 动作（改掉）：原实现把**整个函数**（连 `@` 头带所有台词行）抹回原生直通。真实语料里这条
   * 判据命中 7,963 个函数、连带抹掉约 30 万行**本来已经投影成功**的台词——台词行覆盖率从
   * 99.2% 跌到 69.7%（CR-1 六把尺子全红的根因）。
   * 但"混排不可折"只否定**折叠**本身，不否定那一段里每一行的投影：`LOCAL = n` 回到原样行、
   * `IF LOCAL && 条件` 走主循环同一条 `如果 …：` 口径、`ENDIF` 照常收束——函数里一个 `若`
   * 都不留，混排自然不成立，读者看到的是一份**逐行等价**的普通糖文（只是没享受到 `若` 的
   * 排版红利）。于是回退单位从"函数"降到"段折叠"：同一文件里的其它函数、同一函数里的
   * 台词/输出/演出/数据条目/函数头标签**一行都不退**。
   */
  const recs0 = buildRecs(plan0);
  const unfold = pickSectionUnfolds(lines, plan0, recs0);
  const skeleton = unfold.size === 0 ? plan0 : unfoldSections(plan0, unfold);
  const recs = unfold.size === 0 ? recs0 : buildRecs(skeleton);

  // ---- 缩进补正（一处口径，漏改不了）：着色块**体内** +1；`SIF` 管辖的那一行 +1；
  //      标了「时机 …：」的函数头其**函数体** +1（规范 §3.2 正文缩进一级）；
  //      記入チェック信封**体内** -1（信封被拆，缩进必须跟着拆）----
  //
  // 放在最后统一做（而不是在每个 push 点手动加）：一处口径，漏改不了。
  // 块头自身不吃 +1（`starts` 从 open+1 起算），被吸收的 RESETCOLOR 不可见故无影响。
  for (const r of recs) {
    const bump =
      color.bumpAt(r.line) + sif.bumpAt(r.line) + fnBump(r.line) - skeleton.dedentAt(r.line);
    if (bump !== 0) r.indent = Math.max(0, r.indent + bump);
  }

  // ---- 统计 ----
  //
  // 口径完整性（不静默）：三类计数之和**恒等于** `totalLines`——每一行都必须落在
  // "被糖覆盖 / 原样透传（注释空行）/ 保留原生"三者之一。故 `control` 行**不区分是否
  // 产出可见行**：`ENDIF` / `ENDSELECT` 这类收束行虽不显示，但它们被缩进语义吸收，
  // 仍属于"被糖覆盖"（否则它们会从三类里凭空消失，读者算不平账）。
  let projectedLines = 0;
  let passthroughLines = 0;
  let nativeLines = 0;
  for (const r of recs) {
    if (r.kind === 'native') {
      nativeLines++;
      nativeByReason.set(r.reason!, (nativeByReason.get(r.reason!) ?? 0) + 1);
    } else if (r.kind === 'passthrough') {
      passthroughLines++;
    } else {
      projectedLines++;
    }
  }
  const stats: SugarProjectStats = {
    totalLines: total,
    projectedLines,
    passthroughLines,
    nativeLines,
    nativeByReason: [...nativeByReason.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
  };

  return { segments: buildSegments(recs), stats };
}

/* ============================== 分段 ============================== */

interface LineRec {
  line: number;
  kind: 'speech' | 'control' | 'passthrough' | 'native';
  /** 糖显示文本（不含缩进基准）；`control` 收束行为空串；`native` 行 = 本地化形或兜底形（必非空） */
  text: string;
  /** 缩进层级（糖显示用） */
  indent: number;
  /** 是否产出可见行 */
  visible: boolean;
  reason: SugarProjectNativeReason | null;
  /**
   * `text` 逐行各自的源行号（1 基；`0` = 该行没有源行可回指）。
   *
   * 只在**一条记录产出多行糖文本**时必须给（当前产线仅一处：E13-1② 的函数头 =
   * 合成 `口上:` 声明 + 块头标签两行）。省略 = 该记录只产出一行，映射即 `line` 自身
   * （段里绝大多数记录走这条）。`toSegment` 据此产契约的 `sourceLines`，
   * 行数尺子与 `lineCount` 共用 `recLineCount`。
   */
  readonly lineSources?: readonly number[];
}

/**
 * 「工具没读懂」的兜底前缀（**唯一形状**，红线契约 `native-display/types.ts` 的落法）。
 *
 * 三条纪律都钉在这里：
 * 1. 输出 = 前缀 + 原文 ⇒ **恒与源行逐字不等**（`isVerbatimNativeLine` 的命中数因此可归零）；
 * 2. 前缀是给作者看的**事实陈述**，不猜语义、不伪装成糖（读不懂就说读不懂）；
 * 3. 词形固定，别按成因开分支——一开分支就有 N 份"没读懂"的说法，读者学不会。
 *
 * 口径边界（2026-10-19）：本前缀只留给**真未知语句**。注释 / 空行（`buildRecs` 的
 * passthrough）、`[SKIPSTART]` 区（首尾标签 + `停用 · 原文`）、`@` 函数头 / `#` 声明、
 * `PRINT[A-Z]*` 台词族与数据表条目（`printFamilyDisplay` / `dataFamilyDisplay`）都是
 * **已知结构**，各自有非兜底显示形——它们不是"工具没读懂"，不该把正常 ERB 标成错误。
 */
const UNRECOGNIZED_PREFIX = '未识别语句 · ';

/**
 * `[SKIPSTART]` 行的显示形（停用区首行）。区内其余行显示空串——每一条源行仍占一条投影行
 * （宿主靠区间行数对齐，1:1 不许破），但一律不盖兜底前缀。
 */
const SKIP_REGION_LABEL = '停用区（引擎不执行）';

/** `[SKIPEND]` 行的结束标签（与首行标签成对，同样不是兜底形） */
const SKIP_REGION_END_LABEL = '停用区（结束）';

/** 停用区正文的中性前缀：保留作者原文，但不与源行逐字相等 */
const SKIP_REGION_BODY_PREFIX = '停用 · ';

/** PRINTDATA 系一族的行首记号（块头 / 条目 / 收束）——`makeNativeRec` 的结构优先判据用 */
const DATA_FAMILY_LINE_RE = /^(?:PRINTDATA[A-Z]*|ENDDATA|DATAFORM(?:\s|$)|DATA(?:\s|$))/;

/** 数据表条目行（`DATAFORM` / `DATA`）——只决定**显示词形**；结构判据在 `DATA_FAMILY_LINE_RE` */
const DATA_ENTRY_LINE_RE = /^(DATAFORM|DATA)(?:[ \t　]+([\s\S]*))?$/;

/**
 * PRINT 台词族的显示形（pass 表没认领的那些变体：`PRINTD` / `PRINTLC` / `PRINTPLAIN…`）。
 *
 * 判据只有"行首 token"一条（`PRINT[A-Z]*`），词形按引擎语义二分：
 * - 空体 → `空行` / `空行 等待`（等待取自 `PRINT_VARIANTS`，表外按 `W` 后缀判）；
 * - 有体 → `台词 · <原文体>`（体逐字保留，含全角标点；**不做** FORM 反糖——非 FORM 行的
 *   `%…%` 是被打印的字面字符）；
 * - 指令后紧跟 `;` 是注释而不是要打印的字（`;` 在任意位置起效）→ 空行形 + 注释原文。
 *
 * 这是**显示词形**，不改结构判断：`DATA_FAMILY_LINE_RE` 仍先于本函数。
 */
function printFamilyDisplay(content: string): string | undefined {
  const pm = PRINT_FAMILY_RE.exec(content);
  if (!pm) return undefined;
  const word = pm[1]!;
  const body = trimTrailingSpace(pm[2] ?? '').trimStart();
  const wait = PRINT_VARIANTS.get(word)?.wait ?? word.endsWith('W');
  if (body.length === 0) return blankLineSugar(wait);
  if (bodyIsComment(body)) return `${blankLineSugar(wait)} ${body}`;
  return `台词 · ${body}`;
}

/**
 * 数据表族行的显示形（结构判据已由 `DATA_FAMILY_LINE_RE` 拍板：仍是 native，不进糖段）。
 * pass 表认领（`PRINTDATA` 系 → `数据表 …：`）就维持；`DATAFORM` / `DATA` 条目行与台词族
 * 同一把尺子（空体 → `空行`，有体 → `台词 · <体>`）；其余（`ENDDATA` 等）交给兜底。
 */
function dataFamilyDisplay(content: string, localized: string | null): string | undefined {
  if (localized !== null) return localized;
  const dm = DATA_ENTRY_LINE_RE.exec(content);
  if (!dm) return undefined;
  const body = trimTrailingSpace(dm[2] ?? '').trimStart();
  if (body.length === 0) return blankLineSugar(false);
  if (bodyIsComment(body)) return `${blankLineSugar(false)} ${body}`;
  return `台词 · ${body}`;
}

/** native 行的记录工厂（一份投影运行绑一份，见 `makeNativeRec`） */
type NativeRecFactory = (line: number, reason: SugarProjectNativeReason) => LineRec;

/**
 * 造 native 行记录工厂：认不出 pass ⇒ **显式兜底显示**，绝不静默透传原文。
 *
 * 这条链路是全中系列红线在本模块的唯一落点（口径住在 `native-display/`，本文件只做接线）：
 *
 * ```
 * native 行 → localizeNativeLine({ content, indent, lookup })
 *   ├─ 认得出            → pass 给的中文显示形（行内可残留英文记号）
 *   ├─ 已知结构          → `PRINT[A-Z]*` 台词族 / 数据表条目 / SKIP 区各自的显示词形
 *   └─ 真未知            → `未识别语句 · <原文>`（兜底，同样是一条**要上屏**的可见行）
 * ```
 *
 * `visible: true` 是**必须**的：宿主（`app/src/ui/sugar-view.ts` 的 `composeSugarDoc`）只渲染
 * 落在糖段区间内的行，段外一律取源文件原文 ⇒ 一条"隐身"的 native 行就是屏上一整行 ERB。
 * `kind` 仍是 `'native'`（成因口径、`stats` 与 CR-1 回退判据一个字都不动）。
 *
 * `content` 取**剥过缩进**的原文（契约 `NativeDisplayInput` 的口径），`indent` 与其余行同一把
 * 尺子（`ctx.indentAt`），兜底行的缩进因此和它周围的糖文对齐。
 */
function makeNativeRec(lines: string[], ctx: ProjContext, deps: LiftDeps): NativeRecFactory {
  const lookup = nativeDisplayLookup(deps);
  return (ln, reason) => {
    const raw = lines[ln - 1] ?? '';
    const content = contentOf(raw);
    const indent = ctx.indentAt(ln, raw);
    const rec = (text: string): LineRec => ({ line: ln, kind: 'native', text, indent, visible: true, reason });
    const localized = localizeNativeLine({ content, indent, lookup });
    // 批 N 的**结构判据优先于**显示层词形判据：能走到这里的 PRINTDATA 系行都是结构没收的
    // （游离条目 / 未配对 / 块内混入别的语句），而糖的 `数据表：` 块体只收条目行——
    // 投上去就是"读了写不回"，故仍走 native（不改结构判断）；但它是**已知结构**，
    // 显示词形不再盖"未识别语句"：pass 有中文形就维持，条目行给 `台词 · <体>`。
    if (DATA_FAMILY_LINE_RE.test(content)) {
      return rec(dataFamilyDisplay(content, localized) ?? `${UNRECOGNIZED_PREFIX}${content}`);
    }
    if (localized !== null) return rec(localized);
    // 空内容行没有"语句"可标——兜底前缀单独一行是纯噪声，还会让宿主把 N 行空行折成
    // N 行"未识别语句"。保持隐身，让宿主照常回显空行（空行在 `isVerbatimNativeLine`
    // 里天生不算红线）。SKIP 区已在上游 1:1 占位，这里是防御性保留。
    if (content.length === 0) {
      return { line: ln, kind: 'native', text: '', indent, visible: false, reason };
    }
    // 函数头 `@NAME(...)` / 预处理声明 `#DIM …` 都是**已知结构**：给中性陈述，
    // 既不冒充糖、也不说"没读懂"。名字与参数逐字保留（作者要核对登记名）。
    if (content.startsWith('@')) return rec(`函数 · ${content}`);
    if (content.startsWith('#')) return rec(`声明 · ${content}`);
    // PRINT 台词族（pass 表外的变体）→ `台词 · <体>` / `空行[ 等待]`；仍是**已知结构**。
    // 真未知语句才落兜底形（前缀 + 原文），一个字节都不改。
    return rec(printFamilyDisplay(content) ?? `${UNRECOGNIZED_PREFIX}${content}`);
  };
}

/**
 * 把 `LiftDeps` 里**已经存在**的名表通道接成 `NativeDisplayLookup`（pass 的可查询器）。
 *
 * - `familyAlias`：与投影别处同一个真源（`dictionary().familyAliasReverse`，表住 adapter），
 *   **不抄第二份族名表**；字典缺席 / 不支持反向 = 整个 lookup 缺席（pass 只做语言层替换）。
 * - `slotCn`：同为**逐字转发**（`dictionary().slotCn` = 契约 `VariableSchema.slotCn`，
 *   汉化词典与编号换算都住 adapter，本包零解释、零缓存）。字典未提供 = 查不到 = 槽位
 *   保持原名，**绝不猜**（与旧装配——通道缺席——行为逐字相同）。
 */
function nativeDisplayLookup(deps: LiftDeps): NativeDisplayLookup | undefined {
  const dict = deps.dictionary?.();
  if (dict?.familyAliasReverse === undefined) return undefined;
  const reverse = dict.familyAliasReverse.bind(dict);
  return {
    familyAlias: (engineFamilyUpper) => reverse(engineFamilyUpper),
    slotCn: (engineFamilyUpper, indexName) => dict.slotCn?.(engineFamilyUpper, indexName),
  };
}

/* ============================== 函数骨架 `RETURN`（红线 2） ============================== */

/** 单独成行的退出语句：`RETURN` / `RETURN 1` / `RETURN RESULT`（`RETURNF` 另有形） */
const RETURN_LINE_RE = /^RETURN(\s.*)?$/;
/** 值函数返回：`RETURNF <值>` / 裸 `RETURNF` */
const RETURNF_LINE_RE = /^RETURNF(?:\s+(.*))?$/;

/** `RETURN` 骨架计划（形状见 `planReturnLines`） */
interface ReturnPlan {
  /** 函数体内单独成行的 `RETURN …`：吸收（只读视图不显示，磁盘一字不动） */
  readonly absorbed: ReadonlySet<number>;
  /** 函数体内的 `RETURNF …` → 糖的 `返回 <值>` / `返回`（词形 = `keywords.ts` 的 `inline.return`） */
  readonly displayAt: ReadonlyMap<number, string>;
}

/**
 * 函数体内的 `RETURN` 扫平（口径**从"两处吸收"扩到"一律"**）。
 *
 * 原实现只在两个地方吃掉 `RETURN`：包装三联的第三行、`ENDIF` 的紧随行——函数体里别处的
 * 早退（`IF … ENDIF` 之间那几条）全部漏网，变成屏上一整行 ERB。本函数把它扩成**闭集**：
 *
 * - **作用域**：只看 `@` 函数体（第 0 列的 `@` 头起、到下一个第 0 列 `@` 头/文件尾）。
 *   函数外的 `RETURN`（文件头区、`#DIM` 段）不是骨架，仍走 native 口径让读者看见；
 * - **单独成行**：`codeAt` 已剥行尾注释，`RETURN 1 ;x` 算单独成行；`SIF A:RETURN` 一类
 *   冒号连写不在本表（那行整体交给本地化层）；
 * - `[SKIPSTART]` 停用区内的 `RETURN` **不吸收**：整片区域本来就走 `data-or-skip` 口径，
 *   在这里偷偷吃掉会连"这段是停用的"一起消失；
 * - `RETURNF <值>` 是**作者写的返回值**（值函数），不是引擎骨架 ⇒ 不吸收，显示成
 *   `返回 <值>`；裸 `RETURNF` → `返回`。值部分**原文照抄**（不猜表达式）。
 *
 * 吸收 = 只读视图里那一行不再出现，**磁盘一份字节都不动**（投影不发事件、不写盘）。
 */
function planReturnLines(lines: string[]): ReturnPlan {
  const absorbed = new Set<number>();
  const displayAt = new Map<number, string>();
  let inFunction = false;
  let inSkip = false;
  for (let ln = 1; ln <= lines.length; ln++) {
    const raw = lines[ln - 1] ?? '';
    const content = contentOf(raw);
    if (content === '[SKIPSTART]') {
      inSkip = true;
      continue;
    }
    if (content === '[SKIPEND]') {
      inSkip = false;
      continue;
    }
    if (inSkip || content.length === 0 || content.startsWith(';')) continue;
    // 函数头只能在第 0 列（与 `planSkeleton` 的 `funcHeadAbove` 同一把尺子）
    if (content.startsWith('@') && indentLevelOf(raw) === 0) {
      inFunction = true;
      continue;
    }
    if (!inFunction) continue;
    const code = stripInlineComment(content);
    if (RETURNF_LINE_RE.test(code)) {
      const value = (RETURNF_LINE_RE.exec(code)?.[1] ?? '').trim();
      displayAt.set(ln, value.length === 0 ? '返回' : `返回 ${value}`);
      continue;
    }
    if (RETURN_LINE_RE.test(code)) absorbed.add(ln);
  }
  return { absorbed, displayAt };
}

/**
 * 把逐行记录切成**连续可映射段** + **native 段**两类区间（两类互不重叠、合起来按行号升序）。
 *
 * - **可映射段**（`speech` / `control` / `passthrough` 的连续区间）：口径一字未动——
 *   纯注释/空行的区间**不成段**（它们保持可见即可，折叠成 ViewZone 反而徒增噪声）。
 * - **native 段**（连续 native 行的区间）：**无条件成段**。
 *
 * 为什么 native 行必须自己成段（红线在这里的唯一落点）：宿主按"落在段区间内 → 用段文本，
 * 否则 → 取源文件那一行"拼装（`app/src/ui/sugar-view.ts` 的 `composeSugarDoc`）。native 行
 * 过去 `text: ''` + 隐身 ⇒ 屏上就是那一整行 ERB。现在它带着本地化形/兜底形**必须**进段区间，
 * 否则那条显示形永远到不了屏幕。native 行**仍然切断**可映射段（`buildRecs` 与 CR-1 的
 * `nativeAt` / R1 回退判据口径不变）。
 */
function buildSegments(recs: LineRec[]): SugarProjectSegment[] {
  const out: SugarProjectSegment[] = [];
  let run: LineRec[] = [];
  let nativeRun: LineRec[] = [];

  const flushMapped = (): void => {
    if (run.length === 0) return;
    if (run.some((r) => r.kind === 'speech' || r.kind === 'control')) out.push(toSegment(run, false));
    run = [];
  };
  const flushNative = (): void => {
    if (nativeRun.length === 0) return;
    // 兜底段只在**至少一行可见**时成段：全空行的 native 段（停用区里的空行）没有
    // "没读懂的语句"可标，成段只会让宿主把 N 行原文折成 0 行 ViewZone——不折，
    // 让这些空行留在段外（宿主照常回显，显示与原文件逐行一致）。
    if (nativeRun.some((r) => r.visible)) out.push(toSegment(nativeRun, true));
    nativeRun = [];
  };

  for (const r of recs) {
    if (r.kind === 'native') {
      flushMapped();
      nativeRun.push(r);
      continue;
    }
    flushNative();
    run.push(r);
  }
  flushMapped();
  flushNative();
  return out;
}

/**
 * 一段记录 → 段（缩进以段内最小层为基准，故至少首行无前导空白）。
 *
 * `nativeOnly`（全中系列 additive 契约，`plugin-api` `SugarProjectSegment/nativeOnly`）：
 * 本段是否全部由 native 行构成。只有 native 段会带 `true`——**必须**写进产物：
 * 契约不变量已改为"相邻段可以无间隔行"，消费方不能再靠"两段之间必有原文行"推断覆盖，
 * 要区分"真糖段"与"工具没读懂的兜底段"只有这个字段（不许按文本猜第二份口径）。
 */
function toSegment(run: LineRec[], nativeOnly: boolean): SugarProjectSegment {
  const visible = run.filter((r) => r.visible);
  const base = visible.reduce((m, r) => Math.min(m, r.indent), Number.POSITIVE_INFINITY);
  const baseIndent = Number.isFinite(base) ? base : 0;
  const text = visible
    .map((r) => '\t'.repeat(Math.max(0, r.indent - baseIndent)) + r.text)
    .join('\n');
  // 糖行 ↔ 源行的逐行对账：与 `text` **同一次遍历**产出，二者行数天生相等
  // （尺子只有一把 = `recLineCount`）。隐身记录（`ENDIF` / 被吸收的信封）在这里
  // 根本不产生条目 ⇒ 段区间里的源行可以比糖行多，但每一行糖都知道自己来自哪一行。
  const sourceLines: number[] = [];
  for (const r of visible) recSourceLines(r).forEach((ln) => sourceLines.push(ln));
  const segment: SugarProjectSegment = {
    fromLine: run[0]!.line,
    toLine: run[run.length - 1]!.line,
    sugarText: text,
    // 行数按**实际产出的行**数（`sugarText` 的行数）：一条记录可能带多行文本
    // （E13-1② 的函数头记录 = `口上: <家族名>` + `时机 …：` 两行），
    // 直接数记录条数会让宿主的 ViewZone 高度少一行。
    lineCount: sourceLines.length,
    sourceLines,
  };
  if (nativeOnly) segment.nativeOnly = true;
  return segment;
}

/** 一条记录产出的糖行数（`lineCount` 与 `sourceLines` **共用的唯一尺子**） */
function recLineCount(r: LineRec): number {
  return r.text.length === 0 ? 1 : r.text.split('\n').length;
}

/**
 * 一条记录 → 它每一行糖文本各自回指的源行号（1 基；`0` = 无源行可回指）。
 *
 * 三种情形，按"宁缺毋造"排序：
 * 1. 记录自带 `lineSources` 且长度对得上 ⇒ 原样用它（产线里唯一的多行记录：E13-1② 函数头）；
 * 2. 单行记录 ⇒ 就是 `r.line`（段里绝大多数记录走这条）；
 * 3. 多行记录**却没给**映射 ⇒ 只承认首行来自 `r.line`，其余记 `0`。长度不合的映射同理截断
 *    /补 `0`。这里绝不拿 `fromLine + k` 之类的区间算术去"猜"一个源行——猜出来的错位在
 *    预览上不可见，正是本字段要消灭的那类 bug。
 */
function recSourceLines(r: LineRec): readonly number[] {
  const n = recLineCount(r);
  const given = r.lineSources;
  if (given !== undefined) {
    if (given.length === n) return given;
    const fixed: number[] = [];
    for (let k = 0; k < n; k++) fixed.push(k < given.length ? given[k]! : 0);
    return fixed;
  }
  if (n <= 1) return [r.line];
  const fixed: number[] = [r.line];
  for (let k = 1; k < n; k++) fixed.push(0);
  return fixed;
}

/* ============================== 函数骨架合并 ============================== */

/** 骨架合并结果（形状见 `planSkeleton`） */
interface SkeletonPlan {
  /** 被合并吸收的行（不产出可见行，但占区间） */
  absorbed: Set<number>;
  /** 该行因"信封被拆掉"而应**减掉**的缩进层数 */
  dedentAt: (line: number) => number;
  /**
   * 该行是**段信封**的头 → 投影成 `若 <条件>：`（E13-2）。
   *
   * 与 `absorbed` 的分工：段头那一行**要产出可见行**（它就是段块头），
   * 信封的另两行（`LOCAL = n` / `ENDIF`）走 `absorbed`。
   */
  sectionHeadAt: Map<number, string>;
  /**
   * 段信封的**完整区间**（键 = 段头行号 = 原 `IF` 行）。
   *
   * CR-1 的「段折叠回退」需要它：只有 `sectionHeadAt` / `absorbed` 的话，`LOCAL = n` 行
   * 与配对 `ENDIF` 行在集合里已被拍平、认不回来，回退就无从下手。
   */
  envelopes: Map<number, SectionEnvelope>;
}

/** 一个**段信封**的三行区间（1 基行号）：`LOCAL = n` / `IF … && 条件` / 配对 `ENDIF` */
interface SectionEnvelope {
  /** `LOCAL = n`（或 `LOCAL:k = n`）赋值行——折叠时被吸收，回退后**恢复成原样行** */
  localLine: number;
  /** 段头行（原 `IF` 行）；`sectionHeadAt` 的键 */
  ifLine: number;
  /** 配对的同缩进 `ENDIF` 行 */
  endLine: number;
}

/**
 * 段条件回显（S5）：原生 `!` → 糖的否定运算符 `非 `（写侧 `非` 走既有中文运算符管线）。
 *
 * 判据只认**前置逻辑否定**（`^!(?!=)`）——`!=` 是不等号，不是否定；其余形态原样。
 *
 * D2：段头（`若 …：`）也必须走**家族头中文化**（`IF LOCAL && NOWEX:噴乳` → `若 现在：噴乳：`）
 * ——与表达式侧同一个 `reverseFamilyAliases`（查 adapter 反向表；未登记原样保留，不猜）。
 */
function projectSectionCondition(condition: string, deps: LiftDeps): string {
  const t = condition.trim();
  const negated = /^!(?!=)/.test(t) ? `非 ${t.slice(1).trim()}` : t;
  return reverseFamilyAliases(negated, deps);
}

/**
 * 函数头拆成 `纯名 + 形参声明段`（`@A(ARG,ARG:1)` → `{name:'A', decl:'(ARG,ARG:1)'}`）。
 * 声明段内不得有空白（糖的 `参数:` 产物口径，见 codegen），否则返回 null 走旧口径。
 */
function splitWrapperHead(content: string): { name: string; decl: string } | null {
  const m = /^@(.+?)(\([^\s)]*\))?$/.exec(content);
  if (!m || !m[1]) return null;
  return { name: m[1].trim(), decl: m[2] ?? '' };
}

/**
 * 口上**函数骨架**合并（用户第 2 条）——把"机器码"收起来，只留读者要看的东西。
 *
 * ## 合并哪两样（都要求**可证明**，一条不满足就整段不动）
 *
 * **① 包装三联**（1,612 处/400 文件实测）：
 * ```
 * @A                  ← 保留（读者靠它知道"这是哪个时机"）
 * CALL A_1            ┐
 * RETURN …            ├ 吸收（`CALL A_1` 证明了它只是转发，读者不需要知道两段拆法）
 * @A_1                ┘
 * ```
 * 判据：四行**连续**、`CALL` 目标恰是 `@A` + `_1`、`@A_1` 与之一致。
 *
 * **② 記入チェック信封**（3,824 处/400 文件实测，**全部可闭合**，99.9% 在函数体最外层）：
 * ```
 * LOCAL = 1           ┐
 * IF LOCAL            │ 吸收（这就是糖表面根本不写的那层包裹——`时机` 块本身即含此义）
 *     …正文…           │ 正文整体**减 1 层缩进**（信封拆了，缩进必须跟着拆）
 * ENDIF               │
 * RETURN 1            ┘（紧随 ENDIF 的退出语句，一并有）
 * ```
 * 判据（全中才合并）：`LOCAL = 0/1` **字面形态**；向下（跳过注释/空行）紧邻 `IF LOCAL`；
 * `IF LOCAL` 在**缩进 0**；能配对到**同缩进** `ENDIF`；且**向上能找到函数头 `@…`**
 * （跳过注释/空行/`#` 指令）——证明这是函数级信封，而不是作者正文里的同名守卫。
 *
 * **③ 段信封**（E13-2，`LOCAL = n` + `IF LOCAL && <条件>`）折叠成一层 `若 <条件>：` 头：
 *
 * ```
 * LOCAL = 1           ┐ 吸收（记入チェック的值由糖的段头表达；值 0 的信封一律不折）
 * IF LOCAL && NOWEX:噴乳  ← 这一行变成 `若 NOWEX:噴乳：`（**要产出可见行**）
 *     …段体…           │ 保持原相对深度（段头落在 `IF` 那一行上，段体本就深一层）
 * ENDIF               ┘ 吸收
 * ```
 *
 * 判据与纯信封**同款从严**，只有"函数头"这一条换成"**本行之前出现过 `@…`**"：
 * 多信封分段是**一个函数里重复 N 次**的形态，第 2 段往上撞见的正是第 1 段的
 * `ENDIF`（`funcHeadAbove` 的"紧邻"口径在这里必然落空）。"上无函数头就不动"这条
 * 硬底线仍然成立（片段级投影不与段信封混淆）。
 *
 * ## 为什么"宁可漏"是这里的硬底线
 *
 * 骨架与正文长得像（都是 `LOCAL = 1` / `IF` / `RETURN`）。判据放宽一点，就会把**作者的
 * 真实逻辑**藏进被吸收的行里——读者看不见却以为看全了，比"少合并"危险得多。所以每条
 * 判据都取"最紧的形态"，并且：**配不上就不动**（原样留原代码）。
 */
function planSkeleton(lines: string[], ctx: ProjContext, deps: LiftDeps): SkeletonPlan {
  const absorbed = new Set<number>();
  /** 逐行 dedent（信封内 -1；嵌套信封会叠加） */
  const dedent = new Array<number>(lines.length + 1).fill(0);
  /** 段信封的头行 → `若 <条件>：`（E13-2 / S5） */
  const sectionHeadAt = new Map<number, string>();
  /** CR-1：段信封区间（段头行 → 三行完整区间），回退折叠时按它把行还原回原生口径 */
  const envelopes = new Map<number, SectionEnvelope>();
  const total = lines.length;
  let inSkip = false;

  const contentAt = (ln: number): string => contentOf(lines[ln - 1] ?? '');
  /**
   * 行尾注释剥离后的内容（`LOCAL = 1 ;custom code` → `LOCAL = 1`）。
   *
   * 魔王改版语料有 26 行在 `LOCAL = n` / `IF LOCAL …` 后挂行尾注释（同一行里再写一段
   * 原生代码），字面比较会把它们全部漏掉。剥离走 `lexer.stripInlineComment`（**引号感知**，
   * 与格式化/词法同一份口径——"注释从哪开始"有两份实现就会分叉）。
   */
  const codeAt = (ln: number): string => stripInlineComment(contentAt(ln));
  const indentAt = (ln: number): number => indentLevelOf(lines[ln - 1] ?? '');

  /**
   * 向上找最近的函数头 `@…`（找到返回该行内容；否则 `undefined`）。
   *
   * 跳过四类行：注释 / 空行 / `#` 指令 / **已被骨架吸收或已是段头的行**
   * （机器码可信），以及**任何缩进非 0 的行**（缩进行一定在某个块体里，而函数头
   * 只能在第 0 列）。后两条是 E13-2 补的：多信封分段是**一个函数里重复 N 次**的
   * 形态，第 2 段往上撞见的正是第 1 段的 `ENDIF` / 段头 / 段体——不跳过它们，
   * "上无函数头就不动"这条底线会把**同函数的其余段**一起挡掉（K101 实测）。
   */
  const funcHeadAbove = (from: number): string | undefined => {
    for (let ln = from - 1; ln >= 1; ln--) {
      const c = contentAt(ln);
      if (c.length === 0 || c.startsWith(';') || c.startsWith('#') || indentAt(ln) !== 0) continue;
      if (absorbed.has(ln) || sectionHeadAt.has(ln)) continue;
      return c.startsWith('@') ? c : undefined;
    }
    return undefined;
  };

  /**
   * 配对同缩进 `ENDIF`（自己数嵌套，不依赖扫描器的配对假设）。
   *
   * `baseIndent` = 信封所在缩进层（函数级信封 = 0；缩进层子段信封 = 子段自己的层）。
   * 只在这一层里数 `IF`/`ENDIF`——更深层的 `IF` 属于子段内部，与本次配对无关。
   */
  const pairEndif = (from: number, baseIndent: number): number => {
    let depth = 0;
    for (let k = from; k <= total; k++) {
      if (indentAt(k) !== baseIndent) continue;
      const c = codeAt(k);
      if (/^IF\s/.test(c)) depth++;
      else if (c === 'ENDIF') {
        if (depth === 0) return k;
        depth--;
      }
    }
    return -1;
  };

  for (let ln = 1; ln <= total; ln++) {
    const content = contentAt(ln);
    if (content === '[SKIPSTART]') {
      inSkip = true;
      continue;
    }
    if (content === '[SKIPEND]') {
      inSkip = false;
      continue;
    }
    if (inSkip) continue;

    /* ---- ① 包装三联 ---- */
    if (content.startsWith('@')) {
      // 头可带 `参数:` 声明段（`@A(ARG,ARG:1)`，规范 §3.2 v1.5）。声明段必须**三行一致**
      // 才允许合并——`CALL` 少转发一份声明就是真实的功能差异（实参被引擎丢弃），
      // 不是可以直接藏起来的排版噪声。
      const wrapper = splitWrapperHead(content);
      const name = wrapper?.name ?? content.slice(1).trim();
      const clause = wrapper?.decl ?? '';
      const call = contentAt(ln + 1);
      if (name.length > 0 && !/[()]/.test(name) && call === `CALL ${name}_1${clause}`) {
        const ret = contentAt(ln + 2);
        const head = contentAt(ln + 3);
        if (/^RETURN(\s.*)?$/.test(ret) && head === `@${name}_1${clause}`) {
          absorbed.add(ln + 1);
          absorbed.add(ln + 2);
          absorbed.add(ln + 3);
          continue;
        }
      }
      continue;
    }

    /* ---- ② 記入チェック信封 / ③ 段信封（P-1R：槽位感知，含缩进层子段） ---- */
    //
    // 形态识别（`LOCAL` 可带命名槽 `:n`；行尾注释已剥离 — 见 `codeAt`）：
    //   函数级纯信封：`LOCAL = n`        + `IF LOCAL`                → 吸收三行 + 正文 -1 缩进
    //   段信封（无槽）：`LOCAL = n`      + `IF LOCAL && <条件>`        → `若 <条件>：`
    //   段信封（带槽）：`LOCAL:n = m`    + `IF LOCAL:n && <条件>`      → `若 <条件>：`
    //   段信封（带槽）：`LOCAL:n = m`    + 裸 `IF <条件>`（槽写在上一行）→ `若 <条件>：`
    //
    // **`n` 不进语法**：写回时由 codegen 自动分配槽位（`若` 段头的产物是 bare `LOCAL`）。
    // **判据仍从严**（"宁可漏"是硬底线）：向上能找到函数头 `@…`、向下紧邻 `IF`、能配对到
    // **同缩进** `ENDIF`；配不上就不动（宁缺勿吞作者逻辑）。
    // P-1R 手段 2：**没有 `LOCAL` 信封的条件链根本不是段**——裸 `IF <条件>` 只有在
    // 上一行是 `LOCAL:n = m`（槽位信封）时才受理；`IF/ELSEIF` 分叉链头因此天然落在门外。
    const assign = /^LOCAL(?::(\d+))?\s*=\s*([01])$/.exec(codeAt(ln));
    if (assign === null) continue;
    const slot = assign[1];
    const value = assign[2]!;
    // 1016 批：**值 `0` 的信封一律不折**（函数级纯信封 `LOCAL = 0` + `IF LOCAL`、段信封
    // `LOCAL:n = 0` + `IF LOCAL:n && <条件>` 都算）。表层已删 `（关）` 停用标记；投影若照折，
    // 作者原文件里 `LOCAL = 0` 的停用段会被折成与启用段一模一样的 `若 <条件>：`，贴回时写侧
    // 恒发 `LOCAL = 1` ⇒ **静默把"停用"改成"启用" = 篡改作者数据**。宁可漏折（宁缺勿吞）。
    if (value === '0') continue;
    // 无槽位（函数级）信封仍限缩进 0；带槽位的子段信封允许缩进层（P-1R 手段 1）
    if (slot === undefined && indentAt(ln) !== 0) continue;
    const baseIndent = indentAt(ln);
    // 向下跳过注释 / 空行，必须紧邻 `IF`（纯信封 / 段信封）
    let ifLn = ln + 1;
    while (ifLn <= total) {
      const c = contentAt(ifLn);
      if (c.length === 0 || c.startsWith(';')) {
        ifLn++;
        continue;
      }
      break;
    }
    if (ifLn > total || indentAt(ifLn) !== baseIndent) continue;
    const ifCode = codeAt(ifLn);
    const isPlainEnvelope = slot === undefined && ifCode === 'IF LOCAL';
    let sectionCondition: string | null = null;
    if (!isPlainEnvelope) {
      const andLocal = /^IF\s+LOCAL(?::(\d+))?\s*&&\s*(.+)$/.exec(ifCode);
      if (andLocal !== null && (andLocal[1] ?? undefined) === slot) {
        sectionCondition = andLocal[2]!.trim();
      } else if (slot !== undefined) {
        // 槽在新一行（`LOCAL:n = m` + 裸 `IF <条件>`）；`IF LOCAL…` 形态已由上支覆盖
        const bareIf = /^IF\s+(?!LOCAL(?::|\s|$))(.+)$/.exec(ifCode);
        if (bareIf !== null) sectionCondition = bareIf[1]!.trim();
      }
    }
    if (!isPlainEnvelope && sectionCondition === null) continue;
    // "上无函数头就不动"：证明这是函数级信封，而不是正文里的同名守卫
    // （`funcHeadAbove` 允许跳过已被骨架吸收的行 / 段头行 / 缩进行，见其注释）
    if (funcHeadAbove(ln) === undefined) continue;
    const endLn = pairEndif(ifLn + 1, baseIndent);
    if (endLn < 0) continue;

    if (!isPlainEnvelope) {
      // **段信封**：`LOCAL = n` 与 `ENDIF` 吸收（段头由糖的 `若` 头表达），
      // 段体**缩进不动**——段头落在原 `IF` 那一行上，段体本来就比它深一层。
      // 值已保证是 `1`（值 `0` 早在上游 `continue`，不折）。
      absorbed.add(ln);
      absorbed.add(endLn);
      const cond = projectSectionCondition(sectionCondition!, deps);
      sectionHeadAt.set(ifLn, `若 ${cond}：`);
      envelopes.set(ifLn, { localLine: ln, ifLine: ifLn, endLine: endLn });
      continue;
    }

    // 全中 → 吸收信封三行（+ 紧随的退出语句）
    absorbed.add(ln);
    absorbed.add(ifLn);
    absorbed.add(endLn);
    const after = codeAt(endLn + 1);
    if (/^RETURN(\s.*)?$/.test(after)) absorbed.add(endLn + 1);
    // 正文整体减 1 层
    for (let k = ifLn + 1; k < endLn; k++) dedent[k] = (dedent[k] ?? 0) + 1;
    continue;
  }

  return {
    absorbed,
    dedentAt: (line) => (line >= 1 && line <= total ? (dedent[line] ?? 0) : 0),
    sectionHeadAt,
    envelopes,
  };
}

/* ============================== CR-1 段折叠回退 ============================== */

/**
 * 哪些**段折叠**要回退（返回段头行号集合）。四条判据取并集，全部是**结构可证**的：
 *
 * - **R1（逐段）**：信封自己的区间 `[LOCAL 行, ENDIF 行]` 里有 native 行 ⇒ 段头与它的正文
 *   被一行原码切开（拼接产物报 `section-unclosed` / `indent-mismatch`）。**只撤这一段的
 *   折叠**，同函数别的干净段照折——这就是"分段粒度"。
 *   （旧版没有这一条：它用"函数范围内 native 把可映射段切成两段以上"这一把**代理尺子**，
 *   命中就抹**整个函数**——真实语料 7,963 个函数、约 30 万行已经投影成功的台词一起陪葬，
 *   台词行覆盖 99.2% → 69.7%。那正是 CR-1。）
 * - **R2（逐段）**：外层信封的区间里还套着另一条段头 ⇒ 折出来就是段内套段
 *   （写侧报 `section-nested`）。撤外层、留内层（外层退回 `如果 …：` 后内层落在普通块里，
 *   不再是"段里套段"）。
 * - **R3（逐段）**：段头那条 `IF` 在**同缩进**上还有 `ELSE` / `ELSEIF` 分叉 ⇒ 折叠等于把
 *   `IF / ELSEIF / ENDIF` 这条链的开头摘走，链的其余部分失去归属（`section-mixed` 的一类）。
 * - **R4（逐函数）**：「时机」**顶层**除了段以外还有别的东西——**已经投影成功的**正文行也算
 *   （`如果 …：` / `当 …：` / 台词行 / 着色块头）。`section-mixed` 的本义就是"段块与普通语句
 *   同顶层"，普通语句能不能投影与它无关；旧版只把"投不了的行"当混排，漏掉这一类
 *   （真实语料实测残留 `section-mixed` 全部来自这里）。判据直接问结构：段信封区间**之外**、
 *   比函数头更深的那一层里还有可见的 `speech` / `control` 或 native 行 ⇒ 这一函数一律不折。
 *
 * 四条都**只撤折叠**、不动逐行投影，所以覆盖率只会比旧口径**高**，不是靠抹内容换数字。
 */
function pickSectionUnfolds(lines: string[], plan: SkeletonPlan, recs: LineRec[]): Set<number> {
  const out = new Set<number>();
  if (plan.envelopes.size === 0) return out;
  /** native 行索引（`buildRecs` 每行恰一条记录，`recs[ln-1]` 即该行；越界或不一致时保守当作非 native） */
  const nativeAt = (ln: number): boolean => {
    const r = recs[ln - 1];
    return r !== undefined && r.line === ln && r.kind === 'native';
  };
  /** 段信封按段头行升序（`planSkeleton` 自上而下扫描，插入序即行号序） */
  const envs = [...plan.envelopes.entries()];
  for (let i = 0; i < envs.length; i++) {
    const [ifLn, env] = envs[i]!;
    // R1：区间里有投不了的行
    for (let k = env.localLine; k <= env.endLine; k++) {
      if (nativeAt(k)) {
        out.add(ifLn);
        break;
      }
    }
    if (out.has(ifLn)) continue;
    // R2：外层区间里还套着另一条段头（内层只会更深，故向后扫到本层结束即可）
    for (let j = i + 1; j < envs.length && envs[j]![1].localLine < env.endLine; j++) {
      out.add(ifLn);
      break;
    }
    if (out.has(ifLn)) continue;
    // R3：同缩进上还有 `ELSE` / `ELSEIF` 分叉——折叠只搬得走 `IF` 那一行，链的其余部分失去归属
    const chain = indentLevelOf(lines[ifLn - 1] ?? '');
    for (let k = ifLn + 1; k < env.endLine; k++) {
      if (indentLevelOf(lines[k - 1] ?? '') !== chain) continue;
      const c = stripInlineComment(contentOf(lines[k - 1] ?? ''));
      if (/^ELSE(\s|$)/.test(c) || /^ELSEIF\s/.test(c)) {
        out.add(ifLn);
        break;
      }
    }
  }
  // R4 只看**活下来的**折叠：被 R1/R2/R3 撤掉的信封，它的 `LOCAL` / 段体 / `ENDIF` 会重新
  // 变成「时机」顶层的普通行——那正是混排的另一半，不能当成"还在段里"放过。
  const insideEnvelope = new Set<number>();
  for (const [ifLn, env] of plan.envelopes) {
    if (out.has(ifLn)) continue;
    for (let k = env.localLine; k <= env.endLine; k++) insideEnvelope.add(k);
  }
  if (insideEnvelope.size === 0) return out;
  for (const [start, end] of functionRanges(lines)) {
    const inRange: number[] = [];
    for (const ifLn of plan.envelopes.keys()) {
      if (ifLn >= start && ifLn <= end && !out.has(ifLn)) inRange.push(ifLn);
    }
    if (inRange.length === 0) continue;
    // 「时机」块的正文 = 比函数头更深的那些行（第 0 列的行——收尾 `RETURN`、下一个 `@`——
    // 落在块外，与段块不同顶层，不构成混排）
    const headIndent = indentLevelOf(lines[start - 1] ?? '');
    let mixed = false;
    for (let ln = start + 1; ln <= end; ln++) {
      const r = recs[ln - 1];
      if (r === undefined || r.line !== ln || r.kind === 'passthrough') continue;
      if (insideEnvelope.has(ln)) continue;
      if (indentLevelOf(lines[ln - 1] ?? '') <= headIndent) continue;
      if (r.kind === 'native' || r.kind === 'speech' || (r.kind === 'control' && r.visible)) {
        mixed = true;
        break;
      }
    }
    if (!mixed) continue;
    for (const ifLn of inRange) out.add(ifLn);
  }
  return out;
}

/**
 * 把选中的段信封**还原成没折过**的样子（不改原对象——`plan0` 还要被第一轮记录解释）。
 *
 * 还原 = 从 `absorbed` 里放掉 `LOCAL = n` 与配对 `ENDIF` 两行、删掉段头文本与区间。
 * 下一轮 `buildRecs` 于是把它们当成普通行走各自的既有口径：`LOCAL = n` 落进"其余 → 原样保留"
 * （native `other`，与全语料所有赋值行同一条路），`IF LOCAL && 条件` 落进 `controlHeadRec`
 * （`如果 LOCAL && 条件：`），`ENDIF` 落进收束行（不可见）。**没有第二条判据。**
 */
function unfoldSections(plan: SkeletonPlan, ifLines: ReadonlySet<number>): SkeletonPlan {
  const absorbed = new Set(plan.absorbed);
  const sectionHeadAt = new Map(plan.sectionHeadAt);
  const envelopes = new Map(plan.envelopes);
  for (const ifLn of ifLines) {
    const env = envelopes.get(ifLn);
    if (env === undefined) continue;
    absorbed.delete(env.localLine);
    absorbed.delete(env.endLine);
    sectionHeadAt.delete(ifLn);
    envelopes.delete(ifLn);
  }
  return { absorbed, dedentAt: plan.dedentAt, sectionHeadAt, envelopes };
}

/* ============================== SIF → 单语句「如果」 ============================== */

/** SIF 投影计划（形状见 `planSif`） */
interface SifPlan {
  /** 可投影为「如果 …：」块头的 SIF 行号 */
  headAt: Set<number>;
  /** 该行因"正被某条 SIF 单语句管辖"而应**加**的缩进层数 */
  bumpAt: (line: number) => number;
}

/**
 * `SIF`（Single IF）→ 糖的「如果 …：」+ **恰好一行**缩进正文（批 H，规范 §3.5 单行/块形式）。
 *
 * ## 真实语料实测（2,885 个口上 ERB / 18,130 行 SIF）
 *
 * - **`SIF 条件:命令` 冒号形态 0 例**——全部是"条件独占一行，被管的语句在下一行"；
 * - 下一行形态：简单语句 13,137｜输出行 4,987｜连写 `SIF` 6｜**开块或闭合行 0**。
 *
 * 冒号形态为什么"有也不做"：ERB 条件里 `:` 是**变量索引**（`SIF TALENT:LOCAL:恋人`），
 * 与"冒号 + 命令"的分界在没有完整表达式解析的前提下**不可证**。语料既然 0 例，
 * 就用一条保守判据把它挡在门外（`hasCommandColon`），而不是去猜边界。
 *
 * ## 判据（一条不满足就整行不动，原样留原代码）
 *
 * 1. 结构扫描把这一行认成 `SIF`，且**表达式非空**；
 * 2. 表达式里**没有**"冒号 + 指令关键字"形态（见上）；
 * 3. 向下第一个非空非注释行**存在**，且是**单条语句**：
 *    不是开块语句（`IF`/`SELECTCASE`/`PRINTDATA` 系/`TRY…LIST`…）、不是闭合或分支行
 *    （`ENDIF`/`ELSE`/`CASE`…——`ELSE` 属于它上面那条链，不是"被条件管的一条语句"）、
 *    不是另一条 `SIF`（连写 = 作用域叠加，一行说不清）、
 *    不是 `@` / `#` / `$` / `[` 开头的结构性行；
 * 4. 不在 `[SKIPSTART]` 停用区内，也不在 `PRINTDATA` 数据表体内（结构判据先于内容判据，
 *    与台词行同口径——表体里的行是"数据"不是语句）。
 *
 * 满足后：SIF 行投影成块头 `如果 <条件反糖>：`，**正文那一行 +1 层缩进**——
 * 块的范围正好等于糖块的自然读法（缩进即块），而 SIF 的语义也正是"管一条语句"。
 */
function planSif(lines: string[], ctx: ProjContext): SifPlan {
  const headAt = new Set<number>();
  const bump = new Array<number>(lines.length + 1).fill(0);
  const total = lines.length;
  let inSkip = false;

  const contentAt = (ln: number): string => contentOf(lines[ln - 1] ?? '');

  for (let ln = 1; ln <= total; ln++) {
    const content = contentAt(ln);
    if (content === '[SKIPSTART]') {
      inSkip = true;
      continue;
    }
    if (content === '[SKIPEND]') {
      inSkip = false;
      continue;
    }
    if (inSkip) continue;

    const st = ctx.stmtAt(ln);
    if (!st || st.kind !== 'SIF') continue;
    // 结构判据先于内容判据（与台词行同口径）：PRINTDATA 数据表体里的行是"数据"不是语句
    if (ctx.enclosingAt(ln).includes('data')) continue;
    const expr = st.expression.trim();
    if (expr.length === 0 || hasCommandColon(expr)) continue;

    // 向下第一个非空非注释行 = 被 SIF 管辖的那一条语句
    let body = ln + 1;
    while (body <= total) {
      const c = contentAt(body);
      if (c.length === 0 || c.startsWith(';')) {
        body++;
        continue;
      }
      break;
    }
    const bodyContent = contentAt(body);
    if (body > total || bodyContent.length === 0) continue;
    if (/^[@#$[]/.test(bodyContent)) continue;
    const bst = ctx.stmtAt(body);
    if (bst && (NON_BODY_LINE_KINDS.has(bst.kind) || pairOf(bst.kind) !== null || isCloseKind(bst.kind))) {
      continue;
    }

    headAt.add(ln);
    bump[body] = (bump[body] ?? 0) + 1;
  }

  return {
    headAt,
    bumpAt: (line) => (line >= 1 && line <= total ? (bump[line] ?? 0) : 0),
  };
}

/* ============================== 函数体缩进（批 I） ============================== */

/**
 * 函数体缩进计划：被标成「时机 …：」的那个头，其**函数体 +1 层**。
 *
 * 规范 §3.2 明文「`时机 <分野> [编号] [命名参数]：` 是块头；**正文缩进一级**」。
 * 投影原本只看控制流深度（`@` 头不开块），于是头与正文平级——读者分不清哪几行属于
 * 这个时机。这里补上这一层。
 *
 * **只给标了标签的头加缩进**：没标签的头（辅助函数 / 表里没有的调用面）自己留原代码，
 * 若把它的正文抬高一层，读者会看到"莫名多出来的缩进"而无从解释。
 *
 * ERB 的函数没有显式结束标记（到下一个 `@` 或文件尾），所以"当前在哪个函数里"
 * 只需记最后一次出现的头。
 */
function planFunctionBumps(lines: string[], headIndex: FaceNameIndex | undefined): (line: number) => number {
  const total = lines.length;
  const bump = new Array<number>(total + 2).fill(0);
  if (headIndex === undefined) return (line) => (line >= 1 && line <= total ? (bump[line] ?? 0) : 0);
  let insideLabeled = false;
  for (let ln = 1; ln <= total; ln++) {
    const content = contentOf(lines[ln - 1] ?? '');
    if (content.startsWith('@')) {
      insideLabeled = headIndex.label(stripParams(content.slice(1).trim())) !== undefined;
      continue; // 头自身不 +1（下面记的是"头之后每一行"的增量）
    }
    if (insideLabeled) bump[ln] = 1;
  }
  return (line) => (line >= 1 && line <= total ? (bump[line] ?? 0) : 0);
}

/* ============================== 着色块配对 ============================== */

/** 着色块配对结果（形状见 `planColorBlocks`） */
interface ColorPlan {
  /** `SETCOLOR` 行号 → 颜色表达式（呈现为「着色 X：」块头） */
  openAt: Map<number, string>;
  /** 被吸收的 `RESETCOLOR` 行号（不产出可见行，但占区间） */
  absorbed: Set<number>;
  /** 该行处于几个着色块**体内**（缩进补正用） */
  bumpAt: (line: number) => number;
}

/**
 * 把 `SETCOLOR …` 与**同嵌套深度**的 `RESETCOLOR` 配成「着色 …：」块。
 *
 * ## 为什么要"配对"而不是"见到 SETCOLOR 就发糖"
 *
 * 糖的 `着色` 是**块**（§3.9：`SETCOLOR` + 块体 + 自动 `RESETCOLOR`），而 `SETCOLOR`
 * 本身没有结尾语义——真实语料里 `SETCOLOR` 22,487 处、`RESETCOLOR` 只有 6,312 处，
 * **绝大多数 SETCOLOR 没有配对的收尾**（颜色靠分发器在函数返回路径上统一复位，见规范
 * §1.5）。若"见到就发糖"，等于替作者猜一个块边界——猜错就是**把别人的代码藏进糖块里**。
 * 故只认**能配对的**：配不上的一律原样保留（fail-visible）。
 *
 * ## 配对判据
 *
 * 同深度 + 最近未配对（栈），且**不跨函数边界 / 不跨停用区**：
 *
 * - **跨函数不配对**：`@` 行起是一个新的函数体。真实语料里"本函数只 SETCOLOR 不收尾"
 *   很常见（颜色交给分发器统一复位），若让它与**下一个函数**里的 `RESETCOLOR` 配上，
 *   整个下一个函数会被缩进进 `着色` 块——那是纯粹的视觉事故。
 * - **跨停用区不配对**：`[SKIPSTART]` 里的内容不是活代码，不该参与块边界推断。
 * - 同深度才配：跨块的收尾往往来自另一层作者的写法，强行配对会把块边界画错。嵌套着色
 *   （块内再来一组）天然支持（栈）。
 */
function planColorBlocks(lines: string[], ctx: ProjContext): ColorPlan {
  const stack: Array<{ line: number; expr: string; depth: number }> = [];
  const openAt = new Map<number, string>();
  const absorbed = new Set<number>();
  /** 块体起点（open+1）→ 计数；块终点（close）→ 出栈计数 */
  const enterAt = new Map<number, number>();
  const leaveAt = new Map<number, number>();
  const total = lines.length;
  let inSkip = false;

  for (let ln = 1; ln <= total; ln++) {
    const content = contentOf(lines[ln - 1] ?? '');
    if (content === '[SKIPSTART]') {
      inSkip = true;
      stack.length = 0; // 停用区打断推断：区前未收尾的 SETCOLOR 不再参与配对
      continue;
    }
    if (content === '[SKIPEND]') {
      inSkip = false;
      continue;
    }
    if (inSkip) continue;
    if (content.startsWith('@')) {
      // 新函数体：上一函数未收尾的 SETCOLOR 就此作废（否则会把下个函数整段缩进进去）
      stack.length = 0;
      continue;
    }
    const open = /^SETCOLOR\s+(.+)$/.exec(content);
    if (open) {
      stack.push({ line: ln, expr: open[1]!.trim(), depth: ctx.enclosingAt(ln).length });
      continue;
    }
    if (content !== 'RESETCOLOR') continue;
    const depth = ctx.enclosingAt(ln).length;
    // 找最近的**同深度**未配对 SETCOLOR
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k]!.depth !== depth) continue;
      const head = stack.splice(k, 1)[0]!;
      openAt.set(head.line, head.expr);
      absorbed.add(ln);
      enterAt.set(head.line + 1, (enterAt.get(head.line + 1) ?? 0) + 1);
      leaveAt.set(ln, (leaveAt.get(ln) ?? 0) + 1);
      break;
    }
  }

  // 逐行累积"处于几个块体内"（O(n)；嵌套着色会正确叠加）
  const bump = new Array<number>(total + 1).fill(0);
  let active = 0;
  for (let ln = 1; ln <= total; ln++) {
    active += enterAt.get(ln) ?? 0;
    bump[ln] = active;
    active -= leaveAt.get(ln) ?? 0;
  }

  return {
    openAt,
    absorbed,
    bumpAt: (line) => (line >= 1 && line <= total ? (bump[line] ?? 0) : 0),
  };
}

/* ============================== 数据表（PRINTDATA 系） ============================== */

/**
 * 数据表条目指令。真实语料实测（2026-10-13，全 2,285 文件）：
 * 3,685 个 `PRINTDATA*` 块里，条目指令**只有这两种**——
 * `DATAFORM` 19,0xx 行｜`DATA` 42x 行；块外出现的 `DATAFORM/DATA` = **0 行**（不存在游离用法）。
 */
const DATA_ENTRY_RE = /^(DATAFORM|DATA)\b[ \t　]*(.*)$/;

interface DataPlan {
  /** 开词行 → 块头标签（可见 control 行） */
  labelAt: Map<number, string>;
  /** 条目行 → 条目正文（原文；可读化交给既有的 FORM 管线，失败即单行降级） */
  entryAt: Map<number, string>;
  /** 条目行的显示缩进 = 块头深度 + 1（不取源文本缩进：源里写几层空格是作者的习惯，不是结构） */
  entryIndentAt: Map<number, number>;
  /** 被吸收的 `ENDDATA`（其信息已在块头标签里，不必再占一行） */
  absorbed: Set<number>;
}

/**
 * 数据表 → 「块头标签 + 缩进的候选清单」（批 N，糖视图 B 层）。
 *
 * **为什么这不是"升糖"**：糖表层没有数据表写法（规范 v1.3 §3.6 的 `随机：` 编译成
 * `LOCAL=RAND` + `SELECTCASE`，产物机制与引擎的 data-print 不同，且表达不了"轮流"那一半）。
 * 所以这里**不借用任何糖关键字**，只给一条**结构标注**——与"裸指令打空行"那处
 * 同属"刻意显示口径"（见本文件空行批注的先例），读者据此知道下面几行是**择一**关系。
 *
 * **标签只陈述核对得上事实**：「择一输出」是这一族从源码形状就能确认的行为（块内是
 * 若干条互斥的同一动作描述）；而 `…L`=轮流、`…W`/`…K`/`…D` 各是什么，**没有引擎侧
 * 权威出处**，所以不替读者下结论——变体词原样回显在标签括号里，需要的人一眼能看到。
 *
 * **判据（全部可证明，配不上就整块不动）**：
 * - 块内只允许 条目行 / 空行 / 注释行 ⇒ 出现任何其它语句（`DATALIST`/`ENDLIST`、
 *   `IF`、嵌套数据表…）整块放弃。实测 3,685 块中 **2,812 块纯条目**，
 *   873 块含 `DATALIST` 分组（2,380 对）——分组的语义未核实 ⇒ 那 873 块原样保留，
 *   它们的条目也**不**投影（否则块头与条目会一处一处地各说各话）。
 * - 必须找到配对的 `ENDDATA`（深度计数，跨嵌套 `IF` 也能对上；找不到 = 结构异常，不动）。
 */
function planDataBlocks(lines: string[], ctx: ProjContext): DataPlan {
  const total = lines.length;
  const labelAt = new Map<number, string>();
  const entryAt = new Map<number, string>();
  const entryIndentAt = new Map<number, number>();
  const absorbed = new Set<number>();

  for (let ln = 1; ln <= total; ln++) {
    const st = ctx.stmtAt(ln);
    if (!st || !PRINTDATA_OPEN.has(st.kind)) continue;

    const entries: number[] = [];
    let depth = 1;
    let ok = true;
    let endLine = -1;
    for (let j = ln + 1; j <= total; j++) {
      const s = ctx.stmtAt(j);
      const c = contentOf(lines[j - 1]!);
      if (s && s.kind === 'ENDDATA') {
        depth--;
        if (depth === 0) {
          endLine = j;
          break;
        }
        continue;
      }
      if (s) continue; // 任何别的语句（含嵌套开词）都算"不纯"，由下面的 ok 判定处理
      const m = DATA_ENTRY_RE.exec(c);
      if (m) entries.push(j);
      else if (c.length > 0 && !c.startsWith(';')) ok = false;
    }
    if (endLine < 0) continue;
    if (entries.length === 0) continue;

    // 纯度判定：块内出现过任何语句行（IF / DATALIST / 嵌套数据表…）就整块放弃
    for (let j = ln + 1; j < endLine; j++) {
      const s = ctx.stmtAt(j);
      if (s && s.kind !== 'ENDDATA') {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const echo = st.kind === 'PRINTDATA' ? '' : `，${st.kind}`;
    labelAt.set(ln, `数据表 · 择一输出（以下 ${entries.length} 条${echo}）：`);
    absorbed.add(endLine);
    for (const j of entries) {
      const m = DATA_ENTRY_RE.exec(contentOf(lines[j - 1]!));
      if (!m) continue;
      entryAt.set(j, m[2]!);
      entryIndentAt.set(j, st.depth + 1);
    }
  }

  return { labelAt, entryAt, entryIndentAt, absorbed };
}

/* ============================== 结构上下文 ============================== */

interface ProjContext {
  /** 该行的控制流语句（无 → undefined） */
  stmtAt: (line: number) => ControlFlowStatement | undefined;
  /** 该行所处块深度（最外层 = 0；取 `scanControlFlow` 的 enclosing 栈长） */
  indentAt: (line: number, raw: string) => number;
  /** 包着该行的块种类栈（如 `['if','data']`）——用于数据表体判据 */
  enclosingAt: (line: number) => string[];
}

function buildContext(lines: string[], statements: ControlFlowStatement[]): ProjContext {
  const stmtByLine = new Map<number, ControlFlowStatement>();
  for (const st of statements) if (!stmtByLine.has(st.line)) stmtByLine.set(st.line, st);

  const total = lines.length;
  const enclosing: string[][] = new Array(total + 1);
  const stack: string[] = [];
  let si = 0;
  for (let ln = 1; ln <= total; ln++) {
    while (si < statements.length && statements[si]!.line === ln) {
      const st = statements[si]!;
      enclosing[ln] = [...stack]; // 开块行自身不算在自己体内
      const pair = pairOf(st.kind);
      if (pair) stack.push(pair);
      else if (isCloseKind(st.kind)) stack.pop();
      si++;
    }
    if (enclosing[ln] === undefined) enclosing[ln] = [...stack];
  }

  return {
    stmtAt: (line) => stmtByLine.get(line),
    enclosingAt: (line) => enclosing[line] ?? [],
    indentAt: (line, raw) => {
      const st = stmtByLine.get(line);
      // 控制流行用语句自身深度（开块行记"开启前"深度，与糖缩进口径一致）
      if (st) return st.depth;
      const env = enclosing[line];
      if (env) return env.length;
      // 无结构信息（scanControlFlow 缺席）→ 退回原文缩进层
      return indentLevelOf(raw);
    },
  };
}
/* ============================== 行工具 ============================== */
/**
 * `@` 函数范围（P-1R 函数级 all-or-nothing 的判定单位；1 基闭区间）。
 *
 * 每个 `@…` 头行起、**下一个 `@…` 头行的前一行**止。文件头（首个 `@` 之前）不属任何
 * 函数——那里的行按常规口径投影，不参与回退。
 */
function functionRanges(lines: string[]): Array<[number, number]> {
  const heads: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (contentOf(lines[i]!).startsWith('@')) heads.push(i + 1);
  }
  const out: Array<[number, number]> = [];
  for (let i = 0; i < heads.length; i++) {
    out.push([heads[i]!, (heads[i + 1] ?? lines.length + 1) - 1]);
  }
  return out;
}

/**
 * 文本体**可读化**：把原生记号反糖成糖的主形。
 *
 * 两步（都是**显示**口径，判据封闭、失败即原样保留）：
 *
 * 1. **代词**：`%CALLNAME:TARGET%` → `{她}`、`%CALLNAME:MASTER%` → `{你}`
 *    （反向表派生自 `expression.ts` 的 `PRONOUN_MAP`，正反对称是构造事实）；
 * 2. **属性**（2026-10-12 用户第 7 条）：`{CFLAG:TARGET:1088}` → `{她的好感度}`、
 *    `%TALENT:TARGET:恋慕%` → `{她的恋慕}`——需要变量字典的**反向**查询
 *    （`DictionaryLookup.nameAt`）；查不到名称**一律不动**（宁可留数字，不编名字）。
 *
 * `%…%` 是**有界记号**（自带首尾 `%`），故纯文本替换不会切到相邻变量引用。
 */
/**
 * 行内三元 → 糖（**显示**通道）：拆段与成对判据在识别核（与建议侧同一把尺子），
 * 这里只喂显示用的词表——体外走 `readableText`（代词 / 属性反糖），条件段走
 * `reverseExprAttributes`（词级反糖 + 函数名中文反显）。**这些反糖只显不写**：
 * 属性反糖会把定界符从 `%…%` 换成 `{…}`、函数名中文反显的产物是英文原文，
 * 写回侧一律不接（判据见 `sugar-ident` 的 `ATTRIBUTE_WRITABLE` / `NAME_ALIAS_WRITABLE`）。
 */
function projectInlineConditionsToSugar(body: string, deps: LiftDeps): string | undefined {
  return inlineConditionsToSugar(body, {
    outer: (t) => readableText(t, deps),
    cond: (c) => reverseExprAttributes(c, deps),
  });
}

function readableText(text: string, deps: LiftDeps): string {
  let out = text;
  for (const [form, pronoun] of PRONOUN_REVERSE) {
    if (out.includes(form)) out = out.split(form).join(`{${pronoun}}`);
  }
  return reverseAttributes(out, deps);
}

/**
 * 家族头**中文别名反糖**（D2）：把已登记的引擎族头 `NOWEX:` 渲染成糖面写法 `现在：`
 * （**全角冒号**，对齐写侧糖面）。词级替换、**双引号字面量内不碰**。
 *
 * 表住 adapter：查 `dictionary().familyAliasReverse`（**单一真源**，本模块零硬编码族名）；
 * 逐个"标识符 + 紧跟半角 `:`"的位置问一次，**未登记 / 查不到一律原样保留**（不猜）。
 *
 * 与 `EXPR_REF_RE`（`nameAt` 的属性反糖：`族:作用域:索引` → `她的X`）**并列、互不相干**：
 * 本条只换族头 **字面**，那条管属性写法；两条各自 fail-visible、可独立关闭。
 */
function reverseFamilyAliases(text: string, deps: LiftDeps): string {
  const reverse = deps.dictionary?.()?.familyAliasReverse;
  if (!reverse) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      // 双引号字面量整段跳过（那里可能恰好写着同样的字样）
      const end = text.indexOf('"', i + 1);
      const stop = end < 0 ? text.length : end + 1;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < text.length && isIdentPart(text[j]!)) j++;
      const name = text.slice(i, j);
      if (text[j] === ':') {
        const alias = reverse(name);
        if (alias !== undefined && alias.length > 0) {
          out += `${alias}：`;
          i = j + 1;
          continue;
        }
      }
      out += name;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 属性反糖：把变量引用换成糖的"代词 + 属性"写法。**两种作用面，判据不同**：
 *
 * - **插值**（`{…}` / `%…%`）：只在"整支恰是一个变量引用"时替换——`{CFLAG:TARGET:1088}`
 *   → `{她的好感度}`，而 `{CFLAG:TARGET:1088 + 1}` **不碰**（硬拆表达式只会给出读不出来的糖）。
 *   替换时**定界符原样保留**（把 `{…}` 变成裸文本会直接改坏台词）。
 * - **表达式**（控制流条件 / 赋值右值）：引用夹在运算符之间（`CFLAG:TARGET:1088 >= 500`），
 *   故做**词级**替换；双引号字符串字面量内不碰（那里可能恰好写着同样的字样）。
 *
 * 定界符内**整支恰是原生引用**、属性反糖查不到名称时，退一步做**族头中文化**（D2：
 * `{NOWEX:噴乳}` → `{现在：噴乳}`）——仍**只动有界记号**，不碰正文里的裸字样（不猜/不误伤台词）。
 */
function reverseAttributes(text: string, deps: LiftDeps): string {
  const dict = deps.dictionary?.();
  if (!dict?.nameAt && !dict?.familyAliasReverse) return text;
  return text
    .replace(/\{([^{}]+)\}/g, (whole, inner: string) => {
      const sugar = sugarForRef(inner, dict);
      if (sugar !== undefined) return `{${sugar}}`;
      const rev = reverseFamilyAliases(inner, deps);
      return rev === inner ? whole : `{${rev}}`;
    })
    .replace(/%([^%]+)%/g, (whole, inner: string) => {
      const sugar = sugarForRef(inner, dict);
      if (sugar !== undefined) return `{${sugar}}`;
      const rev = reverseFamilyAliases(inner, deps);
      return rev === inner ? whole : `{${rev}}`;
    });
}

/**
 * 表达式里的变量引用：族名 + **1～2 段冒号内容**（批 L 起一次吃全，不再只吃第一段）。
 *
 * 为什么必须一次吃全：批 J 之前的正则只吃第一段，于是 `CFLAG:1:好感度`（**角色 1** 的
 * 好感度）被切成 `CFLAG:1` + `:好感度`，把角色号 `1` 当属性编号去查名 → 显示成
 * `她的既成事実:好感度`。那副"看着像糖"的假阳性骗过了全部覆盖率尺子（§5.67）。
 * 现在段数由结构给出，判定交给 `segmentsToSugar`——**该认的认，不该认的一律不动**。
 */
const EXPR_REF_RE =
  /\b(CFLAG|TALENT|ABL|EXP|MARK|BASE|PALAM|TEQUIP|TCVAR|CALLNAME|NAME)(?::[^:\s()[\]{},%+]+){1,2}/g;

/** 原生 ERB 函数名**调用形态**（`名字(`，允许名与括号间空白）——ZH-F2 反显用 */
const FUNCTION_CALL_RE = /\b([A-Za-z_][A-Za-z0-9_]*)([ \t]*\()/g;

/**
 * 英文函数名的**中文反显**（ZH-F2）：把 `GETBIT(` / `HPH_PRINT(` 这类已知函数名的调用形态
 * 换成糖里作者能写下的**中文名**（`获取标记(` / `心形(`）。
 *
 * 名字来源两张**既有真源**，绝不新造：系统函数表反向（`SYSTEM_FUNCTION_REVERSE`，由
 * `SYSTEM_FUNCTION_ALIASES` 派生）+ adapter 基础库表反查（`lookupByFunction`，游戏知识住 adapter）。
 * 二者皆不认 → **原样保留**（`FUNCTION_CALL_RE` 命中但查不到名字的不动，**不猜**）。
 *
 * 与正向降糖 `lowerSystemFunctions` 的判据对称：只认**调用形态**（名字后随 `(`），
 * 裸词 / 变量引用 / 别名的字样一律不碰；`CALL` 之类的裸 ERB 指令名不含 `(` 故不受影响。
 */
function reverseFunctionCalls(text: string, deps: LiftDeps): string {
  const lib = deps.libraryTable?.();
  return text.replace(FUNCTION_CALL_RE, (whole: string, name: string) => {
    const cn = SYSTEM_FUNCTION_REVERSE.get(name) ?? lib?.lookupByFunction?.(name);
    return cn === undefined ? whole : `${cn}${whole.slice(name.length)}`;
  });
}

/**
 * 表达式侧反糖（**词级**）：把条件里的角色属性引用逐个换成糖写法，并把已知函数名的
 * 调用形态换成中文名（ZH-F2）。双引号字面量整段跳过（不识别的写法一律保留，不猜）。
 *
 * 两道替换互不相干（变量引用以族头 `FAMILY:` 起、函数名以 `名字(` 收），**各自 fail-visible**：
 * 字典缺席只是不做属性反糖，函数名反显照常（系统函数表是语言级、恒可用）。
 */
function reverseExprAttributes(text: string, deps: LiftDeps): string {
  const dict = deps.dictionary?.();
  return text
    .split(/("(?:[^"]*)")/g)
    .map((seg) => {
      // 双引号字面量整段跳过（那里可能恰好写着同样的字样）
      if (seg.startsWith('"')) return seg;
      const attrs = dict?.nameAt
        ? seg.replace(EXPR_REF_RE, (whole: string, family: string) => {
            // 段数从匹配文本本身数出来（正则的第二捕获组只给"最后一段"，用它数会错）
            const segs = whole.slice(family.length + 1).split(':');
            return segmentsToSugar(family, segs, dict) ?? whole;
          })
        : seg;
      // ZH-F2 函数名反显 + D2 族头中文化（后者与 `EXPR_REF_RE` 并列、互不相干）
      return reverseFamilyAliases(reverseFunctionCalls(attrs, deps), deps);
    })
    .join('');
}

/** 角色号写法：`CALLNAME:12` → `角色12的名字`；`CFLAG:13:好感度` → `角色13的好感度` */
const ROLE_NO_RE = /^\d{1,4}$/;
/** 引擎里等价的"当前对象/玩家"作用域（`PLAYER` 是 `MASTER` 的别名，见 conventions.ts） */
const SCOPE_ALIAS: ReadonlyMap<string, string> = new Map([
  ['TARGET', '她的'],
  ['MASTER', '你的'],
  ['PLAYER', '你的'],
]);
/** 以**角色号**为索引的族（规范 §3.4 字符串族；没有"名字的索引"） */
const CHAR_NUMBERED_FAMILIES: ReadonlySet<string> = new Set(['CALLNAME', 'NAME']);

/**
 * 变量引用 → 糖写法的**唯一点**（正向 `expression.ts` 的同族规则与此一一对应）。
 *
 * @param family 族名（大写原文）
 * @param segs   冒号后的段（1 段 = `FAMILY:索引` 或 `CALLNAME:角色号`；2 段 = `FAMILY:作用域:索引`）
 * @returns 糖写法（不含定界符）；`undefined` = **不动**
 *
 * 三条硬判据（放宽任何一条都会得到"看着像懂了其实被误导"的产物）：
 * 1. 族必须是**角色作用域**族——全局族（`FLAG`/`TFLAG`）写成 `她的FLAG` 是错的；
 * 2. 作用域必须是 `TARGET`/`MASTER`/`PLAYER` 或**纯数字角色号**；
 *    `ARG`/`LOCAL`/`K69_CNUM` 这类**动态角色变量**糖里没有承诺写法（作者写不出、
 *    读者也认不出是谁），一律不动（实测占三段式引用的 ~1.2%）；
 * 3. 名称必须查得到——**绝不编名字**。
 */
function segmentsToSugar(family: string, segs: string[], dict: DictionaryLookup): string | undefined {
  const f = family.toUpperCase();
  if (CHAR_NUMBERED_FAMILIES.has(f)) {
    if (segs.length !== 1) return undefined;
    const no = segs[0]!;
    if (ROLE_NO_RE.test(no)) {
      // D2 全表闸收口（ZH-N 扩面后新增）：该族查得到中文别名时走别名形 `{真名：5}`，
      // 不再落通用形 `{角色5的名字}`——通用形分不出 NAME 与 CALLNAME（原全是
      // `角色N的名字`，真名/称呼同形），而别名表是本系全中文化的单一真源；
      // 查不到别名的族维持原通用形（不猜）。与 `reverseFamilyAliases` 产物同形
      // （`${alias}：${no}`，全角冒号对齐写侧糖面）。
      const alias = dict.familyAliasReverse?.(f);
      if (typeof alias === 'string' && alias.length > 0) return `${alias}：${no}`;
      return `角色${no}的名字`;
    }
    const possessive = SCOPE_ALIAS.get(no.toUpperCase());
    return possessive === '她的' ? '她' : possessive === '你的' ? '你' : undefined;
  }
  if (!CHAR_SCOPED_FAMILIES.has(f)) return undefined;
  // 一段：引擎语义的"当前角色 1D"，即 TARGET 作用域
  if (segs.length === 1) return possessiveRef(f, '她的', segs[0]!, dict);
  if (segs.length !== 2) return undefined;
  const [scope, index] = [segs[0]!, segs[1]!];
  const possessive = SCOPE_ALIAS.get(scope.toUpperCase());
  if (possessive !== undefined) return possessiveRef(f, possessive, index, dict);
  if (ROLE_NO_RE.test(scope)) {
    const name = dict.nameAt?.(f, index);
    return name === undefined || name.length === 0 ? undefined : `角色${scope}的${name}`;
  }
  return undefined;
}

/** 属性名查得到才发糖（`她的X` / `你的X`）；查不到 → `undefined`，**绝不编名字** */
function possessiveRef(
  family: string,
  possessive: string,
  index: string,
  dict: DictionaryLookup,
): string | undefined {
  const name = dict.nameAt?.(family, index);
  return name === undefined || name.length === 0 ? undefined : `${possessive}${name}`;
}

/**
 * "整支恰是一个变量引用"时的糖写法（不含定界符）；`undefined` = 不该动。
 *
 * 插值通道（`{…}` / `%…%`）与表达式通道**共用 `segmentsToSugar`**——两条通道各写一套
 * 判据迟早分叉（批 J 的假阳性正是表达式通道单独切段造成的）。
 */
function sugarForRef(inner: string, dict: DictionaryLookup): string | undefined {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*):([^\s:]+)(?::([^\s:]+))?\s*$/.exec(inner);
  if (!m) return undefined;
  const segs = [m[2]!, m[3]].filter((x): x is string => x !== undefined);
  return segmentsToSugar(m[1]!, segs, dict);
}

/**
 * 演出行投影（批 J 之后的批 K，规范 §3.9）：`CALL HPH_PRINT(@"文本","模式")` → `心形 文本[ 续]`。
 *
 * ## 为什么这是最大的一根剩余杠杆
 *
 * 口上域实测：`CALL` 行 135,720 条里 **HPH_PRINT 占 67,808（50%）**——演出文本被埋在指令参数里，
 * 读者看见的是一行机器码而不是台词。形态也集中（同域实测）：
 * **96.8% 是 `CALL HPH_PRINT,@"字面量","模式字母"`**（逗号调用式），1.4% 是括号式，
 * 其余 1.8% 参数是变量或没有模式字母。
 *
 * ## 判据（一条不满足就整行不动）
 *
 * - 参数必须是 **`@"…"` 格式串字面量**：`@"…" ` 在引擎里就是"展开 `%…%` 的字符串"，
 *   所以文本走与 `PRINTFORM*` 同一把 `readableText`（语料实证：参数里就是
 *   `%CALLNAME:PLAYER%` 这类记号）。裸变量（`CALL HPH_PRINT,LOCALS,"L"`）**不投影**。
 * - 模式字母必须是 §3.9 表里的四个之一：`w`/`l`/`dw`/`dl`。别的字母（引擎另有扩展）
 *   或缺第二段（走引擎默认）**不投影**——"续/等待"直接影响读者看到的节奏，猜不得。
 * - 字面量里不含 `"`（正则用 `[^"]*` 强制）：嵌套引号的拆分超出"逐行局部映射"的能力。
 *
 * ## 为什么文本里的「」原样保留
 *
 * 正向 codegen 对**台词**会剥掉引号（`心形 「嗯」` → `@"嗯","w"`），而语料里
 * `@"「…」","L"` 的引号**写在字面量内**（引擎就把它打印出来）。投影是显示口径，
 * 第一职责是"读者看见的等于游戏打印出来的"，所以**不加引号也不减引号**——
 * 减了就是在篡改演出文本，加了就是在造游戏里不存在的一对括号。
 */
const HEART_HEAD_RE = /^CALL\s+HPH_PRINT\b[ \t]*([,(])[ \t]*/i;
const HEART_ARGS_RE = /^@"([^"]*)"[ \t]*,[ \t]*"([A-Za-z]+)"$/;
const HEART_MODES: ReadonlyMap<string, { readonly cont: boolean }> = new Map([
  ['w', { cont: false }],
  ['l', { cont: true }],
  ['dw', { cont: false }],
  ['dl', { cont: true }],
]);

function heartProjection(content: string, deps: LiftDeps): string | undefined {
  const head = HEART_HEAD_RE.exec(content);
  if (!head) return undefined;
  let args = content.slice(head[0].length);
  if (head[1] === '(') {
    if (!args.trimEnd().endsWith(')')) return undefined; // 括号式必须闭合整齐
    args = args.trimEnd().slice(0, -1);
  } else if (args.trimEnd().endsWith(')')) {
    return undefined; // 逗号式不带闭括号——形态对不上就不猜
  }
  const m = HEART_ARGS_RE.exec(args.trim());
  if (!m) return undefined;
  const mode = HEART_MODES.get(m[2]!.toLowerCase());
  if (mode === undefined) return undefined;
  return `心形 ${readableText(m[1]!, deps)}${mode.cont ? ' 续' : ''}`;
}

/**
 * 行首是一个**状态赋值**吗（批 J）？`TFLAG:192 =0` / `EXP:自慰経験 += 1`。
 *
 * 判据只有两条，且都以"不猜"为轴：
 * - 左值必须是**无空格的引用串**（`族[:段[:段]]`），操作符紧跟其后——比较运算
 *   （`=` 后面还跟着 `=`/`<`/`>` 的形态如 `A =<> B`、`A = = B`）一律不算赋值；
 *   控制流与指令行到不了这里（前面已按结构信息分流）。
 * - 族必须属于 `CHAR_SCOPED_FAMILIES`：其余族（`FLAG`/`TFLAG`/`RESULT`/`LOCAL`…）
 *   的反糖本就发不出中文（见 `sugarForRefParts` 三条硬判据），走这条路只会白跑一遍，
 *   而且把 `LOCAL` 之类"读者不需要懂的临时量"排除在判据外更清楚。
 *
 * **为什么值不值**：语料实测口上域 122,065 条赋值里 `LOCAL` 占 87,853（72%），
 * 真正的角色状态行约 2.5 万（`CFLAG` 8,165｜`TFLAG` 5,081｜`BASE` 2,801｜`TCVAR` 2,773｜
 * `EXP` 2,435｜`TALENT` 1,435…）。这 2.5 万行是"剧情造成了什么后果"，读口的的人要的正是它。
 */
const STATE_ASSIGN_RE = /^([A-Za-z][A-Za-z0-9_]*)(?::[^:\s]+)*[ \t]*(\+=|-=|\*=|\/=|=)(?![=>])[ \t]*(.*)$/;

function stateAssignment(content: string): string | undefined {
  const m = STATE_ASSIGN_RE.exec(content);
  if (!m) return undefined;
  return CHAR_SCOPED_FAMILIES.has(m[1]!.toUpperCase()) ? content : undefined;
}

/** 结构扫描的防御性包装：扫描器抛错 → 退化为"无结构信息"（不中断投影） */
function safeScan(
  scan: (text: string) => ControlFlowStatement[],
  text: string,
): ControlFlowStatement[] {
  try {
    const out = scan(text);
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}