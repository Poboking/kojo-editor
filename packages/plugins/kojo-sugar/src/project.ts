/**
 * 糖**投影**（B 层，2026-10-12 语法糖批）—— 原生 ERB → 糖显示（**只用于看**）。
 *
 * 依据：`docs/LIFT-REMEASURE-2026-10-12.md` §7.1（"逐行局部映射 + 单行降级"）。
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
 * | 裸指令打空行（`PRINTFORMW` / `PRINTL` / `PRINTDW␠`…） | **一行空行**（读者看到的是剧本节奏） |
 * | `IF X` / `ELSEIF X` / `ELSE` | `如果 X：` / `否则如果 X：` / `否则：` |
 * | `ENDIF` | 缩进收束（**不显示**） |
 * | `SELECTCASE X` / `CASE v` / `CASEELSE` | `当 X：` / `是 v：` / `否则：` |
 * | `ENDSELECT` | 缩进收束（不显示） |
 * | `;注释` / 空行 | **原样透传**（`;` 注释在糖里语法完全一样） |
 * | `%CALLNAME:TARGET%` / `%CALLNAME:MASTER%` | `{她}` / `{你}`（**可读化**，见下） |
 * | `\@条件?A#B\@`（FORM 行内的三元输出） | `{条件 ? "A" : "B"}`（糖三元，规范 §3.4） |
 * | `SIF 条件` + 紧随的那一条语句 | `如果 条件：` + 正文 **+1 层缩进**（规范 §3.5；语料 100% 是这种两行形态） |
 * | 其余（循环 / TRY / PRINTDATA / 按钮 …） | **原样保留为 ERB** |
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
import { buildFaceNameIndex, stripParams } from './faces-reverse';
import type { FaceNameIndex } from './faces-reverse';

/* ============================== 规则表（封闭） ============================== */

/**
 * **角色作用域**的数值变量族（属性反糖只认这些）。
 *
 * 为什么必须有这张表：ERB 里 `FLAG:70` 与 `CFLAG:TARGET:70` 长得一样但语义天差地别——
 * `FLAG` 是**全局**族，写成糖的 `她的FLAG` 是错的。故只给"角色作用域"的族发糖；
 * 全局族（`FLAG`/`TFLAG`/`GLOBAL`/`DAY`/`MONEY`…）原样保留。
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

/**
 * PRINT 家族的**显示口径表**（批 F，2026-10-12）。
 *
 * 三个判据都由**指令名本身**决定，一条都不猜：
 *
 * - `form`：是否展开 FORM 记号（只有 `PRINTFORM*` 展开）。**非 FORM 行不做可读化**
 *   ——`%…%` / `{…}` / `\@…\@` 在它们里面是被打印的字面字符。
 * - `newline`：是否产生一行（`L` / `W` 后缀）。只有 `newline` 的行，空体才是"打空行"。
 *   `PRINT` / `PRINTD` / `PRINTFORM` / `PRINTFORMD` 无后缀 = **不换行**（拼句片段），
 *   空体时什么都不输出 → 不投影为空行。
 * - `wait`：`W` 等待玩家 → 糖不加标记；`L` 不等待 → 行尾 `续`（规范 §3.3）。
 *   后缀 `续` 的判据 = `newline && !wait`（无换行的片段不能谎称"续行"）。
 *
 * `D` 后缀（默认色 / 旁白）不单独标注：糖按引号自动判定作者色（规范 §1.3、§3.3）。
 *
 * **表外的 PRINT 变体不投影**（`PRINTBUTTON` / `PRINTLC` / `PRINTS` / `PRINTPLAIN*` /
 * `PRINTV` / `PRINTFORMK*`…）：按钮与排版类指令的输出不是"读者要读的文本"，
 * 投影成台词会误导；真实语料合计 <400 行，收益远低于风险。
 * （`PRINTDATA` 系是**块开词**，由控制流分支先截获，走 `unsupported-control-flow`。）
 */
interface PrintVariant {
  readonly newline: boolean;
  readonly wait: boolean;
  readonly form: boolean;
}
const PRINT_VARIANTS: ReadonlyMap<string, PrintVariant> = new Map<string, PrintVariant>([
  ['PRINTFORMW', { newline: true, wait: true, form: true }],
  ['PRINTFORML', { newline: true, wait: false, form: true }],
  ['PRINTFORMDW', { newline: true, wait: true, form: true }],
  ['PRINTFORMDL', { newline: true, wait: false, form: true }],
  ['PRINTFORM', { newline: false, wait: false, form: true }],
  ['PRINTFORMD', { newline: false, wait: false, form: true }],
  ['PRINTL', { newline: true, wait: false, form: false }],
  ['PRINTW', { newline: true, wait: true, form: false }],
  ['PRINTDL', { newline: true, wait: false, form: false }],
  ['PRINTDW', { newline: true, wait: true, form: false }],
  ['PRINT', { newline: false, wait: false, form: false }],
  ['PRINTD', { newline: false, wait: false, form: false }],
]);

/** 匹配 PRINT 家族行：`(关键字) (文本体)` */
const PRINT_FAMILY_RE = /^(PRINT[A-Z]*)\s?([\s\S]*)$/;

/** 糖覆盖的控制流关键字 → 糖块头（`null` = 缩进收束，不产出可见行） */
type ControlSugarMaker = (expr: string) => string | null;
const SUGAR_CONTROL: ReadonlyMap<string, ControlSugarMaker> = new Map<string, ControlSugarMaker>([
  ['IF', (e) => `如果 ${e}：`],
  ['ELSEIF', (e) => `否则如果 ${e}：`],
  ['ELSE', () => '否则：'],
  ['ENDIF', () => null],
  ['SELECTCASE', (e) => `当 ${e}：`],
  ['CASE', (e) => `是 ${e}：`],
  ['CASEELSE', () => '否则：'],
  ['ENDSELECT', () => null],
]);

/** 开块语句 → 配对类别（与 `erb-parser/scanner.ts` 同口径；用于重建"包着这一行的块种类"） */
const OPEN_PAIR: Readonly<Record<string, string>> = {
  IF: 'if',
  SELECTCASE: 'select',
  FOR: 'for',
  WHILE: 'while',
  REPEAT: 'repeat',
  DO: 'do',
  DATALIST: 'list',
  STRDATA: 'data',
  NOSKIP: 'noskip',
};
const PRINTDATA_OPEN: ReadonlySet<string> = new Set([
  'PRINTDATA',
  'PRINTDATAL',
  'PRINTDATAW',
  'PRINTDATAK',
  'PRINTDATAKL',
  'PRINTDATAKW',
  'PRINTDATAD',
  'PRINTDATADL',
  'PRINTDATADW',
]);
const TRY_CATCH_OPEN: ReadonlySet<string> = new Set([
  'TRYCGOTO',
  'TRYCJUMP',
  'TRYCCALL',
  'TRYCGOTOFORM',
  'TRYCJUMPFORM',
  'TRYCCALLFORM',
]);
const TRY_LIST_OPEN: ReadonlySet<string> = new Set(['TRYCALLLIST', 'TRYGOTOLIST', 'TRYJUMPLIST']);

const CLOSE_KINDS: ReadonlySet<string> = new Set([
  'ENDIF',
  'ENDSELECT',
  'NEXT',
  'WEND',
  'REND',
  'LOOP',
  'ENDDATA',
  'ENDLIST',
  'ENDNOSKIP',
  'ENDCATCH',
  'ENDFUNC',
]);

/**
 * 不能当 `SIF` 正文的行（批 H 判据 3）：连写的另一条 `SIF`，以及**分支续行**
 * （`ELSE` / `CASE` 属于它上面那条链，不是"被条件管的一条语句"）。
 * 开块与闭合行另有判据（`pairOf` / `CLOSE_KINDS`）。
 */
const NON_BODY_LINE_KINDS: ReadonlySet<string> = new Set(['SIF', 'ELSE', 'ELSEIF', 'CASE', 'CASEELSE']);

/* ============================== 入口 ============================== */

/** 生成整文件糖投影（同步纯函数；不读盘、不写盘、不发事件） */
export function liftProject(deps: LiftDeps, request: SugarProjectRequest): SugarProjectResult {
  const { source } = request;
  if (typeof source !== 'string') {
    throw new TypeError('糖投影的输入必须是字符串（原生 ERB 文本）');
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
  const skeleton = planSkeleton(lines, ctx);
  // `SIF 条件` + 下一行单语句 → 「如果 …：」块头 + 正文 +1 层缩进（批 H）
  const sif = planSif(lines, ctx);
  // 函数头 → 「时机 …：」（批 I）。**分野表缺席 = 一个头都不标**（不猜），与
  // `codegen.resolveFace` 的 `timing-face-unknown` fail-closed 同一条纪律。
  const faceTable = deps.faceTable?.();
  const headIndex = faceTable === undefined ? undefined : buildFaceNameIndex(faceTable);
  // 标了标签的那个头，其函数体 +1 层（规范 §3.2「正文缩进一级」）
  const fnBump = planFunctionBumps(lines, headIndex);

  const recs: LineRec[] = [];
  const nativeByReason = new Map<SugarProjectNativeReason, number>();
  let inSkip = false;

  for (let i = 0; i < total; i++) {
    const ln = i + 1;
    const raw = lines[i]!;
    const content = contentOf(raw);

    if (content === '[SKIPSTART]') {
      inSkip = true;
      recs.push(native(ln, 'data-or-skip'));
      continue;
    }
    if (content === '[SKIPEND]') {
      inSkip = false;
      recs.push(native(ln, 'data-or-skip'));
      continue;
    }
    if (inSkip) {
      recs.push(native(ln, 'data-or-skip'));
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
      const mk = SUGAR_CONTROL.get(st.kind);
      if (mk !== undefined) {
        const expr = st.expression.trim();
        // 需要表达式的块头若表达式为空 → 不猜，原样保留
        if (needsExpression(st.kind) && expr.length === 0) {
          recs.push(native(ln, 'other'));
          continue;
        }
        const text = mk(reverseExprAttributes(expr, deps));
        recs.push({
          line: ln,
          kind: 'control',
          text: text ?? '',
          indent: st.depth,
          visible: text !== null,
          reason: null,
        });
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
      const body = pm[2]!.replace(/[ \t\u3000]+$/, '');
      // 指令后紧跟 `;` → 这里是**注释**而不是要打印的字（Emuera 的 `;` 在任意位置起效）。
      // 一行给不出"空行 + 注释"两行显示 → 原样保留（语料 1 行，判据为不误导而设）。
      if (body.startsWith(';')) {
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
        // 糖表面没有"输出空行"的写法（§3.10 的空行是分隔符、不产出），所以这是一处
        // **刻意的显示口径**而非等价改写：投影按"读者在游戏里看到的节奏"处理——
        // 一行空行。收益有两层：
        //   ① 读者看到的是剧本节奏，而不是一片 `PRINTFORMDL␠` / `PRINTW` 噪声；
        //   ② 它不再**切断**糖段——实测中它是段数暴涨的头号原因。
        //
        // 判据边界：**只有 `newline` 的变体**才算打空行。无后缀的 `PRINT` / `PRINTFORM`
        // 空体既不输出也不换行（是拼句片段的空段）——没有可显示的东西，原样保留。
        //
        // 代价（记录在案）：`W`（等待）与 `L`（不等待）的空行在投影里不再可分辨。
        // 若将来要保留，可在行尾加 `续` 区分（届时仍需改这条口径）。
        if (!variant.newline) {
          recs.push(native(ln, 'unsupported-print-variant'));
          continue;
        }
        recs.push({
          line: ln,
          kind: 'speech',
          text: '',
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
          ? inlineConditionsToSugar(body, deps)
          : readableText(body, deps);
      }
      if (text === undefined) {
        recs.push(native(ln, 'inline-condition'));
        continue;
      }
      recs.push({
        line: ln,
        kind: 'speech',
        text: variant.newline && !variant.wait ? `${text} 续` : text,
        indent: ctx.indentAt(ln, raw),
        visible: true,
        reason: null,
      });
      continue;
    }

    // 函数头：反解成糖的「时机 …：」块头（批 I）。解不出 / 歧义 → 原样留原代码
    if (content.startsWith('@') && headIndex !== undefined) {
      const label = headIndex.label(stripParams(content.slice(1).trim()));
      if (label !== undefined) {
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
    }

    // 其余（赋值 / 调用 / `@` / `#` / `$` / 其他指令）→ 原样保留
    recs.push(native(ln, 'other'));
  }

  // ---- 缩进补正（一处口径，漏改不了）：着色块**体内** +1；`SIF` 管辖的那一行 +1；
  //      标了「时机 …：」的函数头其**函数体** +1（规范 §3.2 正文缩进一级）；
  //      記入チェック信封**体内** -1（信封被拆，缩进必须跟着拆）----
  //
  // 放在最后统一做（而不是在每个 push 点手动加）：一处口径，漏改不了。
  // 块头自身不吃 +1（`starts` 从 open+1 起算），被吸收的 RESETCOLOR 不可见故无影响。
  for (const r of recs) {
    const bump = color.bumpAt(r.line) + sif.bumpAt(r.line) + fnBump(r.line) - skeleton.dedentAt(r.line);
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
  /** 糖显示文本（不含缩进基准）；`control` 收束行为空串 */
  text: string;
  /** 缩进层级（糖显示用） */
  indent: number;
  /** 是否产出可见行 */
  visible: boolean;
  reason: SugarProjectNativeReason | null;
}

function native(line: number, reason: SugarProjectNativeReason): LineRec {
  return { line, kind: 'native', text: '', indent: 0, visible: false, reason };
}

/**
 * 把逐行记录切成**连续可映射段**：只有 `native` 行会切断段。
 *
 * 纯注释/空行的段（不含任何 `speech` / `control`）**不成段**——它们保持可见即可，
 * 折叠成 ViewZone 反而徒增噪声。
 */
function buildSegments(recs: LineRec[]): SugarProjectSegment[] {
  const out: SugarProjectSegment[] = [];
  let run: LineRec[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    const hasMapped = run.some((r) => r.kind === 'speech' || r.kind === 'control');
    if (hasMapped) {
      out.push(toSegment(run));
    }
    run = [];
  };

  for (const r of recs) {
    if (r.kind === 'native') flush();
    else run.push(r);
  }
  flush();
  return out;
}

/** 一段记录 → 段（缩进以段内最小层为基准，故至少首行无前导空白） */
function toSegment(run: LineRec[]): SugarProjectSegment {
  const visible = run.filter((r) => r.visible);
  const base = visible.reduce((m, r) => Math.min(m, r.indent), Number.POSITIVE_INFINITY);
  const baseIndent = Number.isFinite(base) ? base : 0;
  const text = visible
    // 空行（"打空行"的输出）不带缩进：行首制表符在编辑器里是一条无内容的彩色横条
    .map((r) => (r.text.length === 0 ? '' : '\t'.repeat(Math.max(0, r.indent - baseIndent)) + r.text))
    .join('\n');
  return {
    fromLine: run[0]!.line,
    toLine: run[run.length - 1]!.line,
    sugarText: text,
    lineCount: visible.length,
  };
}

/* ============================== 函数骨架合并 ============================== */

/** 骨架合并结果（形状见 `planSkeleton`） */
interface SkeletonPlan {
  /** 被合并吸收的行（不产出可见行，但占区间） */
  absorbed: Set<number>;
  /** 该行因"信封被拆掉"而应**减掉**的缩进层数 */
  dedentAt: (line: number) => number;
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
 * ## 为什么"宁可漏"是这里的硬底线
 *
 * 骨架与正文长得像（都是 `LOCAL = 1` / `IF` / `RETURN`）。判据放宽一点，就会把**作者的
 * 真实逻辑**藏进被吸收的行里——读者看不见却以为看全了，比"少合并"危险得多。所以每条
 * 判据都取"最紧的形态"，并且：**配不上就不动**（原样留原代码）。
 */
function planSkeleton(lines: string[], ctx: ProjContext): SkeletonPlan {
  const absorbed = new Set<number>();
  /** 逐行 dedent（信封内 -1；嵌套信封会叠加） */
  const dedent = new Array<number>(lines.length + 1).fill(0);
  const total = lines.length;
  let inSkip = false;

  const contentAt = (ln: number): string => contentOf(lines[ln - 1] ?? '');
  const indentAt = (ln: number): number => indentLevelOf(lines[ln - 1] ?? '');

  /** 向上找最近的函数头 `@…`（跳过注释 / 空行 / `#` 指令）；找到返回行号 */
  const funcHeadAbove = (from: number): string | undefined => {
    for (let ln = from - 1; ln >= 1; ln--) {
      const c = contentAt(ln);
      if (c.length === 0 || c.startsWith(';') || c.startsWith('#')) continue;
      return c.startsWith('@') ? c : undefined;
    }
    return undefined;
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
      const name = content.slice(1).trim();
      const call = contentAt(ln + 1);
      if (name.length > 0 && call === `CALL ${name}_1`) {
        const ret = contentAt(ln + 2);
        const head = contentAt(ln + 3);
        if (/^RETURN(\s.*)?$/.test(ret) && head === `@${name}_1`) {
          absorbed.add(ln + 1);
          absorbed.add(ln + 2);
          absorbed.add(ln + 3);
          continue;
        }
      }
      continue;
    }

    /* ---- ② 記入チェック信封 ---- */
    if (content !== 'LOCAL = 1' && content !== 'LOCAL = 0') continue;
    if (indentAt(ln) !== 0) continue;
    // 向下跳过注释 / 空行，必须紧邻 `IF LOCAL`
    let ifLn = ln + 1;
    while (ifLn <= total) {
      const c = contentAt(ifLn);
      if (c.length === 0 || c.startsWith(';')) {
        ifLn++;
        continue;
      }
      break;
    }
    if (contentAt(ifLn) !== 'IF LOCAL' || indentAt(ifLn) !== 0) continue;
    // 必须能找到函数头（证明这是函数级信封，而不是正文里的同名守卫）
    if (funcHeadAbove(ln) === undefined) continue;
    // 配对同缩进 ENDIF（自己数嵌套，不依赖扫描器的配对假设）
    let depth = 0;
    let endLn = -1;
    for (let k = ifLn + 1; k <= total; k++) {
      const c = contentAt(k);
      if (indentAt(k) !== 0) continue;
      if (c === 'IF LOCAL' || /^IF\s/.test(c)) depth++;
      else if (c === 'ENDIF') {
        if (depth === 0) {
          endLn = k;
          break;
        }
        depth--;
      }
    }
    if (endLn < 0) continue;

    // 全中 → 吸收信封三行（+ 紧随的退出语句）
    absorbed.add(ln);
    absorbed.add(ifLn);
    absorbed.add(endLn);
    const after = contentAt(endLn + 1);
    if (/^RETURN(\s.*)?$/.test(after)) absorbed.add(endLn + 1);
    // 正文整体减 1 层
    for (let k = ifLn + 1; k < endLn; k++) dedent[k] = (dedent[k] ?? 0) + 1;
    continue;
  }

  return {
    absorbed,
    dedentAt: (line) => (line >= 1 && line <= total ? (dedent[line] ?? 0) : 0),
  };
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
    if (bst && (NON_BODY_LINE_KINDS.has(bst.kind) || pairOf(bst.kind) !== null || CLOSE_KINDS.has(bst.kind))) {
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

/**
 * 表达式里出现"冒号 + 指令关键字" = 这是 `SIF 条件:命令` 的冒号形态（语料 0 例）。
 * 与变量索引冒号（`TALENT:LOCAL:恋人`）的区别只在右侧是不是指令——判据取"是就整行不动"，
 * 因为这里没有第三条路可走（要分清就得完整解析表达式）。
 */
function hasCommandColon(expr: string): boolean {
  return /[:：] *(PRINT|CALL|RETURN|GOTO|GOSUB|SETCOLOR|RESETCOLOR|CLEARLINE|FORCEWAIT|WAIT|INPUT|TRY|HIDE|SHOW|REDRAW|BREAK|RESTART|CATCH|IF|ELSE|SELECTCASE|CASE|END|NEXT|WEND|REND|LOOP|DO|WHILE|FOR)\b/.test(
    expr,
  );
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
      else if (CLOSE_KINDS.has(st.kind)) stack.pop();
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

function pairOf(kind: string): string | null {
  if (OPEN_PAIR[kind] !== undefined) return OPEN_PAIR[kind]!;
  if (PRINTDATA_OPEN.has(kind)) return 'data';
  if (TRY_CATCH_OPEN.has(kind)) return 'try';
  if (TRY_LIST_OPEN.has(kind)) return 'funclist';
  return null;
}

/** 需要表达式的块头（表达式缺失时宁可不映射） */
function needsExpression(kind: string): boolean {
  return (
    kind === 'IF' ||
    kind === 'ELSEIF' ||
    kind === 'SELECTCASE' ||
    kind === 'CASE'
  );
}

/* ============================== 行工具 ============================== */

function splitSourceLines(source: string): string[] {
  const src = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = src.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 去行首缩进 + 行尾空白 */
function contentOf(line: string): string {
  return line.replace(/^[ \t\u3000]*/, '').replace(/[ \t\u3000]+$/, '');
}

/** 原文缩进层（TAB 数 + 空格按 4 折算；与 lexer 的 indentLevel 同口径） */
function indentLevelOf(line: string): number {
  const m = /^[ \t\u3000]*/.exec(line);
  const prefix = m ? m[0] : '';
  let tabs = 0;
  let spaces = 0;
  for (const ch of prefix) {
    if (ch === '\t') tabs++;
    else if (ch === '\u3000') spaces += 2;
    else if (ch === ' ') spaces += 1;
  }
  return tabs + (spaces > 0 ? Math.ceil(spaces / 4) : 0);
}

/** 行内条件 `\@…\@` 检测（只对 FORM 行有语义：非 FORM 行里的 `\@` 是字面字符） */
function hasInlineCondition(text: string): boolean {
  return text.includes('\\@') || text.includes('@\\');
}

/**
 * 行内条件 `\@cond?A#B\@` → 糖三元 `{cond ? "A" : "B"}`（批 G，规范 §3.4）。
 *
 * 真实语料实测（2,285 文件、`\@` 出现行 8,582）：**7,997 行恰有两个 `\@`**（一支 span），
 * 且首个 span 几乎全部**同时含 `?` 与 `#`**（三元形态）。判据因此取最紧的形态，
 * 任一条不满足就**整行放弃**（返回 `undefined` → 保留原生）——把条件猜错显示成"读者以为
 * 看懂了"，比留一行原代码危险得多：
 *
 * 1. `\@` 个数为**偶数**（成对；语料里 `\@×3` / `\@×5` 共 18 行是断串，不猜）；
 * 2. span 内**同时**有 `?` 与 `#`（省略假分支的 `{cond ? "A"}` 形态语料里没有）；
 * 3. 条件段非空。
 *
 * 三段各自的处置（都不造读者写不出来的假语法）：
 * - **条件**走表达式反糖（与控制流同一个 `reverseExprAttributes`：词级替换、双引号内不碰）；
 * - **纯字面分支**加双引号（糖的分支字面量写法）；空分支 → `""`；
 * - 分支含 `%` / `"` / `{` / `}` 时**原样照抄**——规范 §3.4 明确"嵌套插值不出现"，
 *   给变量引用套引号是把它当字面量，给它反糖又会产生嵌套 `{…}`，两头都错；
 * - **体外文本**照旧走 `readableText`（代词 / 属性反糖）。
 */
function inlineConditionsToSugar(body: string, deps: LiftDeps): string | undefined {
  const parts = body.split('\\@');
  if ((parts.length - 1) % 2 !== 0) return undefined;
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      out += readableText(parts[i]!, deps);
      continue;
    }
    const sugar = inlineSpanToSugar(parts[i]!, deps);
    if (sugar === undefined) return undefined;
    out += sugar;
  }
  return out;
}

/** 单支 `\@…\@` 之间的内容 → `{cond ? "A" : "B"}`；判据不满足返回 `undefined` */
function inlineSpanToSugar(span: string, deps: LiftDeps): string | undefined {
  const q = span.indexOf('?');
  if (q < 0) return undefined;
  const after = span.slice(q + 1);
  const h = after.indexOf('#');
  if (h < 0) return undefined;
  const cond = span.slice(0, q).trim();
  if (cond.length === 0) return undefined;
  const a = branchText(after.slice(0, h));
  const b = branchText(after.slice(h + 1));
  return `{${reverseExprAttributes(cond, deps)} ? ${a} : ${b}}`;
}

/** 分支呈现：空 → `""`；含 FORM 记号或引号 → 原样；纯字面 → 加引号 */
function branchText(raw: string): string {
  const t = raw.trim();
  if (t.length === 0) return '""';
  return /[%"{}]/.test(t) ? t : `"${t}"`;
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
function readableText(text: string, deps: LiftDeps): string {
  let out = text;
  for (const [form, pronoun] of PRONOUN_REVERSE) {
    if (out.includes(form)) out = out.split(form).join(`{${pronoun}}`);
  }
  return reverseAttributes(out, deps);
}

/**
 * 属性反糖：把变量引用换成糖的"代词 + 属性"写法。**两种作用面，判据不同**：
 *
 * - **插值**（`{…}` / `%…%`）：只在"整支恰是一个变量引用"时替换——`{CFLAG:TARGET:1088}`
 *   → `{她的好感度}`，而 `{CFLAG:TARGET:1088 + 1}` **不碰**（硬拆表达式只会给出读不出来的糖）。
 *   替换时**定界符原样保留**（把 `{…}` 变成裸文本会直接改坏台词）。
 * - **表达式**（控制流条件 / 赋值右值）：引用夹在运算符之间（`CFLAG:TARGET:1088 >= 500`），
 *   故做**词级**替换；双引号字符串字面量内不碰（那里可能恰好写着同样的字样）。
 */
function reverseAttributes(text: string, deps: LiftDeps): string {
  const dict = deps.dictionary?.();
  if (!dict?.nameAt) return text;
  return text
    .replace(/\{([^{}]+)\}/g, (whole, inner: string) => {
      const sugar = sugarForRef(inner, dict);
      return sugar === undefined ? whole : `{${sugar}}`;
    })
    .replace(/%([^%]+)%/g, (whole, inner: string) => {
      const sugar = sugarForRef(inner, dict);
      return sugar === undefined ? whole : `{${sugar}}`;
    });
}

/** 表达式里的变量引用（`FAMILY[:SCOPE]:INDEX`；索引允许中日文名与编号） */
const EXPR_REF_RE =
  /\b(CFLAG|TALENT|ABL|EXP|MARK|BASE|PALAM|TEQUIP|TCVAR):(?:(TARGET|MASTER):)?([^:\s()[\]{},%]+)/g;

/**
 * 表达式侧反糖（**词级**）：把条件里的角色属性引用逐个换成 `她的X`。
 * 双引号字面量整段跳过（不识别的写法一律保留，不猜）。
 */
function reverseExprAttributes(text: string, deps: LiftDeps): string {
  const dict = deps.dictionary?.();
  if (!dict?.nameAt) return text;
  return text
    .split(/("(?:[^"]*)")/g)
    .map((seg) =>
      seg.startsWith('"')
        ? seg
        : seg.replace(EXPR_REF_RE, (whole, family: string, scope: string | undefined, index: string) =>
            sugarForRefParts(family, scope, index, dict) ?? whole,
          ),
    )
    .join('');
}

/**
 * "整支恰是一个变量引用"时的糖写法（不含定界符）；`undefined` = 不该动。
 *
 * 认两种形态：
 * - `FAMILY:TARGET:IDX` / `FAMILY:MASTER:IDX` → `她的IDX名` / `你的IDX名`
 * - `FAMILY:IDX`（省略角色 = 引擎语义的角色 1D，即 TARGET 作用域）→ `她的IDX名`
 */
function sugarForRef(inner: string, dict: DictionaryLookup): string | undefined {
  const m = /^\s*([A-Z]+)(?::([A-Za-z0-9_]+))?(?::(.+?))?\s*$/.exec(inner);
  if (!m) return undefined;
  const family = m[1]!;
  if (m[3] !== undefined) return sugarForRefParts(family, m[2]!, m[3], dict);
  if (m[2] === undefined) return undefined; // 裸族名（`CFLAG`）：语义是"角色 1D 首格"，不发糖
  return sugarForRefParts(family, undefined, m[2], dict);
}

/**
 * 三段逻辑的唯一点：族必须是**角色作用域**、角色必须是 TARGET/MASTER、名称必须查得到。
 *
 * 为什么这三条一条都不能放宽：
 * - 全局族（`FLAG`/`TFLAG`）写成 `她的FLAG` 是**错的**——"不写"好过"写错"；
 * - 其它角色的属性糖里没有对应写法（`{角色12的X}` 只覆盖 CALLNAME）；
 * - 名称查不到就保留原样的数字——**绝不编名字**（那是"看着像懂了其实被误导"）。
 */
function sugarForRefParts(
  family: string,
  scope: string | undefined,
  index: string,
  dict: DictionaryLookup,
): string | undefined {
  if (!CHAR_SCOPED_FAMILIES.has(family)) return undefined;
  const effective = scope ?? 'TARGET';
  const possessive =
    effective === 'TARGET' ? '她的' : effective === 'MASTER' ? '你的' : undefined;
  if (possessive === undefined) return undefined;
  const name = dict.nameAt?.(family, index);
  if (name === undefined) return undefined;
  return `${possessive}${name}`;
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