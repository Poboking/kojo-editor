/**
 * kojo 表层 DSL 的 tree-sitter 语法（语法层第二真源）。
 *
 * 规则名须与 `src/node-types.ts` 的 KIND_TO_NODE 值逐一对齐——两侧同改。
 * 本文件禁出现游戏名词（审计 A 扫描 src；grammar.js 由纪律 + 对照闸守）。
 *
 * 词形**单一真源**：本文件**零词形字面量**——凡能匹配的中英词形一律取自
 * `src/word-forms.json`（`tools/gen-word-forms.mjs` 构建期从 `kojo-sugar` 的
 * `keywords.ts` / `statement-functions.ts` 活词表投影而来；重生成 = 本包 `build` 链第一步，
 * 漂移守卫 = `tests/word-forms-single-source.test.ts`）。规则名与 `node-types.ts` 的
 * KIND_TO_NODE 冻结契约不受影响，数据化只替换"词从哪来"，不替换"结构长什么样"。
 *
 * 优先级顺序照抄 `kojo-sugar` 的 `classifyLine`（行首分派：原生直通 → 头部/别名
 * → 块头 → 表达式头 → 赋值 → 文本）。
 *
 * 设计口径（第二波：块嵌套 + 行内节点）：
 * - kojo 是**缩进 offside 的行式** DSL：块由"正文行缩进层级 > 块头层级"开体、由回缩收盘
 *   （真源 `kojo-sugar/src/parser.ts` 的 BlockParser；层级折算 = TAB 1 级 / 空格每 4 个 1 级，
 *   见 `lexer.ts` 的 `indentLevel()`——`src/scanner.c` 与本文件逐字同口径）。
 *   **只有 `循环` / `出错处理` / `数据表` 三族有显式收束词**（`keywords.ts` 的 KEYWORDS 只登记了
 *   `block.loopEnd` / `block.catchEnd` / `block.dataTableEnd` 三枚；`如果结束` 一类是
 *   `native-display/control.ts` 里 ENDIF 的**显示形**，不是写形）。所以：
 *     · 三族 ⇒ `(block open: … body: … close: …)`，收束词必需（语料实测 7 枚开块 7 枚收束）；
 *     · 其余族 ⇒ `(block open: … body: …)`，收盘由回缩（块节点行跨度 = 块头行 → 体末行）。
 *     · **例外**：`@函数名` 原生块既无收束词也不看缩进，范围 = "到下一条 `@` 行或文件尾"
 *       （真源 `parser.ts::readRawFunctionBlock`）⇒ 由 scanner 的前瞻记号 `_raw_close` 收盘，
 *       体内只收平行（不解析糖、不产嵌套块）。复用 `block`，不新立容器名。
 *   块头后面没有更深正文 ⇒ 合法的空体（真实语料 67 处），此时块头落回**单行节点**、不产 block，
 *   故不产 ERROR；折不动的空块本就没有可折的区间。
 *   "块没收盘"在本语法里是**唯一**可定位的块级语法故障：三族缺收束词 ⇒ tree-sitter 在回缩点 /
 *   EOF 处插一枚 MISSING 收束词（`tests/fixtures/broken-unclosed-block.kojo` 实测 2 枚，
 *   残块之后的 时机 块与台词行全部照常解析 = 错误被限制在自己块内）。
 * - 每行仍是一个**原子前缀 token**（关键字头 + 行内正文）+ 可选 `_line_tail`：
 *   前缀的字符类不收 `"`、`;`、`\n`，于是行内原生串 `(native_string)` 与行内注释
 *   `(comment_inline)` 成为**行节点的子节点**，行自身的 kind 不变（`node-types.ts` 把两者登记为
 *   NON_LINE_NODES，宿主按行反查时取的是外层行节点）。
 *   `comment_inline` 的"引号内分号不算注释"由此口径天然成立：串先被 `native_string` 吃掉。
 * - 换行**不在 extras** 里：由 `blank_line` 记号逐条认领。理由——extras 被吞进后继节点的 span，
 *   会让 `block` 的 start 行指到上一行（第一波实测 `timing_head` 的 span 是 `"\n\n时机 事件 22："`），
 *   折叠区间随之错位。换行有主之后，行节点起始即正文，块跨度精确。
 * - 上下文档（只在所属块体内合法，块外落回 text/string 行——与 classifyLine 的"无上下文只按形状"
 *   分工不同但不对撞）：`(choice_item)` 只在 选项/菜单/询问/确认 体、`(switch_item)` 只在 `开关:` 体、
 *   `(arrow_case)`/`(arrow_else)` 只在 当/表达式当 体。
 * - 行首分派靠 token 的**最长匹配 + 词法优先级**：tree-sitter 的 lexer 在多个 token 等长命中时
 *   只看 `token(prec(N, …))` 里的数字 N（named `precedences()` 数组不参与词法择优先），
 *   故这里用 `P` 数字表控制：`text_line` = 0 最低，越专有的词头 N 越大、越先胜；
 *   行内尾巴记号给到 100+，保证"行还没结束时"尾巴赢过再起一行。
 * - 词形边界用**消费一个分隔符字符**表达（引擎不支持 look-around）：块头关键字后要么紧跟
 *   非标识符字符（空白/冒号/标点），要么整行即该裸词；紧跟标识符的行（`如果X`）落回 text_line。
 * - 唯一"更细"于 classifyLine、能触发 ERROR 的构造：台词串 `「…」` 与插值 `{…}`。
 *   行首 `「` / 行首 `{` **必须**在同一物理行内闭合（或以 `\` 折行收尾），否则落 ERROR。
 *   `text_line` 显式不收行首 `「`/`{`，让未闭合的串落 ERROR 而非静默吞成旁白——本批错误恢复的可定位点。
 *
 * 标识符字符类与 `kojo-sugar/src/identifier-chars.ts` 同源：
 * ASCII 字母 / `_` + CJK（平假名 · 片假名 · 汉字 · 扩展 A）+ 全角拉丁 `Ａ`–`Ｚ` `ａ`–`ｚ`；
 * 后续集另加数字与 `$`。**不收**全角数字 / 全角标点。
 */

// 标识符字符类源（与 identifier-chars.ts 的 IDENT_CHARS 逐字对齐）
const ID = 'A-Za-z_\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uFF21-\\uFF3A\\uFF41-\\uFF5A';
// 后续集：起始集 + 数字 + `$`（`$` 只进后续、不进起始）
const IDP = `${ID}0-9\\$`;
// 水平空白（含全角空格）——关键字与实参的界标，口径同 lexer 的 `[ \t\u3000]`
const W = ' \\t\\u3000';
// 分隔符字符：非标识符、非换行（关键字后的词形边界即由它消费）
const DELIM = `[^${IDP}\\n]`;
/** 行内正文可越过的字符：不换行、不越原生串引号、不越行内注释分号（口径同 lexer 的引号感知）。 */
const C = '[^";\\n]';
/** 块收束行之前允许的空行 / 回缩空白（换行 + 水平空白，含全角空格与 CRLF 残迹）。 */
const NLWS = '[ \\t\\r\\f\\u3000\\n]*';

/**
 * 词形表（**生成文件，禁手改**）：`tools/gen-word-forms.mjs` 对 `kojo-sugar` 词表真源的
 * 构建期投影。本文件从这里取词，不再自留任何中文/英文词形清单——上游登记新中文主形/别名后，
 * 重跑本包 `build` 即同步进 CST（守卫：`tests/word-forms-single-source.test.ts`）。
 */
const WF = require('./src/word-forms.json');

/** 词形升序比较（UTF-16 码元；不用 localeCompare，locale 会破坏字节可复现性）。 */
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 词表里的词形都是正则**字面量**用途（`-` 等元字符不在词形面，但词形可被登记扩展 ⇒ 一律转义）。 */
function esc(w) {
  return w.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/** 词形数组 → 正则择一分支（按码元升序去重；确定性 = 守卫可比对的前提）。 */
function altList(list, ctx) {
  if (!Array.isArray(list) || list.length === 0) throw new Error(`词形表缺内容：${ctx}`);
  return [...new Set(list)].sort(cmpStr).map(esc).join('|');
}

/** 语义 id → 该 id 全部词形（中文主形 + 英文别名）的择一分支；可传多 id 合并。 */
function alt(...ids) {
  const merged = [];
  for (const id of ids) {
    const w = WF.wordsById[id];
    if (!w || w.length === 0) throw new Error(`词形表缺 id：${id}`);
    merged.push(...w);
  }
  return altList(merged, ids.join(','));
}

/** 语义 id → 中文主形单枚（"只认中文写形"的通路用；缺形即抛，绝不静默放行）。 */
function primary(id) {
  const w = WF.primaryById[id];
  if (typeof w !== 'string' || w.length === 0) throw new Error(`词形表缺中文主形：${id}`);
  return esc(w);
}

/** 收束词形（= `blockEndWord(开块 id)`，生成期已对真源恒等式做过校验）。 */
function endWord(openId) {
  const w = WF.endWordOfId[openId];
  if (typeof w !== 'string' || w.length === 0) throw new Error(`词形表缺收束词：${openId}`);
  return esc(w);
}

/** 头部声明关键字（HEAD_DECL_KEYS 各 id 的主形 + 别名全收）：词后紧跟 `:`/`：` 才成头声明。 */
const HEAD_KEYS = WF.headDeclIds.flatMap((id) => WF.wordsById[id] ?? []);

/** 语句形中文函数调用白名单词（`statement-functions.ts` 单一真源的键集投影）。 */
const STATEMENT_WORDS = WF.statementWords;

/**
 * 词法优先级数字表（越大越先胜；等长命中时唯一裁决尺）。次序即 classifyLine 优先级：
 * 兜底 < 赋值 < 原生/台词 < 头部 < 专有关键词 < 块头 < 语句 < 更具体箭头/单行/残缺形。
 * 100+ 一档是"行内尾巴"记号：它们只在行还没结束时合法，必须赢过"就地再起一行"。
 */
const P = {
  text_line: 0,
  assign: 1,
  control_malformed: 2,
  native_line: 4,
  comment_line: 4,
  raw_block_start: 4,
  string: 5,
  interpolation: 5,
  switch_item: 6,
  label_decl: 7,
  head_decl: 8,
  switch_head: 9, // 与 head_decl 等长命中时取胜，节点名由 alias 收回 head_decl
  random_shape_decl: 8,
  alias_decl: 9,
  const_decl: 9,
  message_check: 9,
  blank_line_cmd: 9,
  // 块头族（同层互不撞词头）
  timing_head: 10,
  custom_command_head: 10,
  function_head: 10,
  when_head: 10,
  if_head: 10,
  case_head: 10,
  random_head: 10,
  group_head: 10,
  branch_head: 10,
  section_head: 10,
  once_head: 10,
  choice_head: 10,
  menu_head: 10,
  ask_m_head: 10,
  ask_yn_head: 10,
  color_head: 10,
  heart_head: 10,
  heart_text: 10,
  loop_head: 10,
  catch_head: 10,
  data_head: 10,
  loop_flow: 10,
  rule_tag: 10,
  // 收束词高于其开块词（`循环结束` 胜过 `循环`）；语句族同层不撞。
  loop_end: 11,
  catch_end: 11,
  data_end: 11,
  choice_item: 11,
  data_entry: 11,
  jump_statement: 11,
  function_jump: 11,
  loop_step: 11,
  settle: 11,
  mutator: 11,
  statement_call: 11,
  call_statement: 11,
  return_statement: 11,
  // 更具体：必须胜过其上块头（撞同一词头）
  expr_head: 12,
  arrow_case: 13,
  arrow_else: 13,
  random_inline: 13,
  single_if_head: 14,
  // 行内尾巴（只在"本行还没结束"的位置合法）
  tail_chunk: 100,
  native_string: 101,
  comment_inline: 102,
};

/** 由模板串构造带数字词法优先级的原子 token。 */
function tk(n, source) {
  return token(prec(n, new RegExp(source)));
}

/** 由正则字面量构造带数字词法优先级的原子 token。 */
function tkRE(n, re) {
  return token(prec(n, re));
}

/**
 * 结构化行 = 行首前缀 token + 可选行内尾巴（原生串 / 续正文 / 行内注释）。
 * 前缀不吃 `"`、`;`、`\n` ⇒ 尾巴三记号必有一枚能接手，行内任何内容都不落 ERROR。
 */
function lineRule(n, prefixSource) {
  return ($) => seq(tk(n, prefixSource), optional($._line_tail));
}

/** 整行原子形（不拆尾巴）：台词串 / 插值 / 整行注释 / 空行换行。 */
function atomicLine(n, re) {
  return () => tkRE(n, re);
}

/** 块头词形（词后可跟任意正文）：`(?:词)(?:DELIM…)?`。 */
function headWord(word, n) {
  return lineRule(n, `(?:${word})(?:${DELIM}${C}*)?`);
}

/** 语句词形（词后**必须**跟空白 + 余文）：`(?:词)[WS]+…`。 */
function kwSpace(word, n) {
  return lineRule(n, `(?:${word})[${W}]+${C}*`);
}

module.exports = grammar({
  name: 'kojo',

  // 换行**不在此列**（由 blank_line 记号认领，否则块节点起点会被 extras 拖到上一行）。
  extras: () => [/[ \t\r\f\u3000]+/],

  externals: ($) => [$._indent, $._dedent, $._raw_close],

  // 「块 vs 单行」的归约冲突由 `_item` 里的 `prec.right` 承担（有更深正文 ⇒ 成块；
  // 没有 ⇒ 块头落回单行节点）——本波规则集下生成器判定无需 conflicts 表。

  rules: {
    source_file: ($) => repeat($._item),

    _item: ($) =>
      choice(
        // 有体优先成块（prec.right 解"块 vs 单行"的归约冲突）
        prec.right($.block),
        prec.right($.item_block),
        $._line,
      ),

    // ============================================================
    // 块（缩进 offside；三族另有显式收束词；`@` 族靠前瞻记号收盘）
    // ============================================================

    block: ($) =>
      choice(
        // 有显式收束词的三族：close 必需（真实语料实测 7 枚开块配 7 枚收束）。
        // 收束词自带**前置换行**：换行不在 extras 里，而块体的 `_dedent` 只跨到换行之前
        // （跨过去就让块节点多吃一行、折叠区间错位）。收束行若不自带换行就永远接不上。
        // 孤儿收束词（前面没有同族开块）另有单行形 loop_end/catch_end/data_end 可落，不崩。
        prec.right(seq(field('open', $.loop_head), $.block_body, field('close', $._loop_close))),
        prec.right(seq(field('open', $.catch_head), $.block_body, field('close', $._catch_close))),
        prec.right(seq(field('open', $.data_head), $.block_body, field('close', $._data_close))),
        // 开关条目块：条目只在块体内合法（块外同形状落回 text_line，与 classifyLine 同判）
        prec.right(seq(field('open', $._switch_open), $.switch_body)),
        // 选项 / 菜单 / 询问 / 确认：条目 = choice_item
        prec.right(seq(field('open', $._choice_like_head), $.choice_body)),
        // 当 / 表达式当：分支 = case_head 块 或 箭头形
        prec.right(seq(field('open', $._when_like_head), $.when_body)),
        // `@函数名` 原生块：本族范围既不是缩进、也没有显式收束词（`keywords.ts` 的三枚收束词
        // 不含它），真源判据是"到下一条 `@` 行或文件尾"⇒ 由 `src/scanner.c` 的前瞻记号
        // `_raw_close` 收盘（收盘优先级排在 `_dedent`/`_indent` 之后，既有各族止行口径分毫不动）。
        // 体内**不解析糖**：只平收 `_line`，不产嵌套块（真实语料实测 @ 区内起点块数 0 ⇒
        // 这一条既不多折任何东西，也不改变任何既有行的节点形）。复用 `block` 而非新立容器名：
        // 宿主、`folds.scm`、`index.ts` 的容器表本来都认它 ⇒ 零新词汇，
        // `BLOCK_NODES` / `NON_LINE_NODES` 不必增项（`raw_block_start` 作本族的 `open`）。
        prec.right(seq(field('open', $.raw_block_start), $._raw_body)),
        // 其余族：回缩收盘
        prec.right(seq(field('open', $._plain_head), $.block_body)),
      ),

    block_body: ($) => seq($._indent, repeat($._item), $._dedent),

    /**
     * `@` 族的体：平收到 `_raw_close` 为止（范围由前瞻决定，与缩进无关）。零新节点名
     * （隐藏规则 ⇒ 行节点直接挂在 `block` 下，逐行反查与第一波同口径）。
     */
    _raw_body: ($) => seq(repeat($._line), $._raw_close),

    switch_body: ($) => seq($._indent, repeat(choice($.switch_item, $._line, $.block)), $._dedent),

    choice_body: ($) => seq($._indent, repeat(choice($._line, $.block, $.item_block)), $._dedent),

    when_body: ($) =>
      seq($._indent, repeat(choice($._line, $.block, $.arrow_case, $.arrow_else)), $._dedent),

    /** 选项条目自带的正文块（节点名与 `block` 同族语义，折叠查询一并取）。 */
    item_block: ($) => seq(field('open', $.choice_item), $.block_body),

    // ============================================================
    // 空行 / 文本 / 台词 / 插值 / 行内尾巴
    // ============================================================

    // 空行 / 行尾换行：换行的**唯一**认领者（换行不在 extras 里 ⇒ 每条换行都得有个 blank_line）。
    blank_line: () => token(prec(-100, /\n/)),

    // 兜底文本行：任意非空正文（旁白 / 台词）。显式不收行首 `「`/`{`/`;`/`@`/空白——
    // 那几个各有专路（未闭合的串/插值因此能落 ERROR 而非被静默吞成旁白）。
    text_line: lineRule(P.text_line, `[^ ${W}\\n;「{@]${C}*`),

    // 台词行 `「…」`：行首 `「`，同一物理行内以 `」` 收尾，或以 `\` 折行收尾。
    // `[^\n]*` 保证不跨行——未闭合的 `「` 因此落 ERROR（本批错误恢复的可定位点）。
    string: atomicLine(P.string, /「[^\n]*[」\\]/),

    // 插值整行 `{…}`：行首 `{`，同一物理行内以 `}` 收尾。未闭合即 ERROR。
    interpolation: atomicLine(P.interpolation, /\{[^\n]*\}/),

    // 行内注释：`;` 起至行尾（整行皆注释时 classifyLine 记 comment）。
    comment_line: atomicLine(P.comment_line, /;[^\n]*/),

    // 行内尾巴：原生串 / 续正文 / 行内注释，三者字符类首尾互斥 ⇒ 任何剩余正文都能接手。
    _line_tail: ($) => repeat1(choice($.native_string, $._tail_chunk, $.comment_inline)),
    _tail_chunk: () => token(prec(P.tail_chunk, /[^";\n]+/)),
    // `"…"` 原生串（未闭合也收成一枚节点，绝不因此让整行崩——写形里 `@"…"` 高频）。
    native_string: () => token(prec(P.native_string, /"[^"\n]*"?/)),
    // 结构化行的行尾注释：不夺本行的 kind（本行仍是那个 kind，注释成为它的子节点）。
    comment_inline: () => token(prec(P.comment_inline, /;[^\n]*/)),

    // ============================================================
    // 原生直通 / 块 / 标签
    // ============================================================

    // 行首 `@`：原生函数块起始（rawBlockStart，直到下一个 `@` 行整块透传）。
    raw_block_start: lineRule(P.raw_block_start, `@${C}*`),

    // 全大写原生指令行 / `$标签`（RAW_INSTR_RE 行首 `[A-Z]` 形 + 起始 `$`；皆 rawLine）。
    native_line: lineRule(P.native_line, `(?:[A-Z][A-Z0-9_.]*(?::${C}*)?|\\$)${C}*`),

    // `标签 <名>`（词 + 空白 + 标签名 → labelDecl；区别于 `$LABEL` 的原生直通形）。
    label_decl: kwSpace(alt('inline.label'), P.label_decl),

    // ============================================================
    // 头部声明族（`词: 值`；词与冒号之间无空白）
    // ============================================================

    head_decl: lineRule(P.head_decl, `(?:${altList(HEAD_KEYS, 'headDecl')})[${W}]*[:\\uFF1A]${C}*`),

    // `开关:` 的专形：只为把条目块挂上去，节点名 alias 回 head_decl（kind 不新增）。
    switch_head: lineRule(P.switch_head, `${primary('head.switch')}[${W}]*[:\\uFF1A]${C}*`),
    _switch_open: ($) => alias($.switch_head, $.head_decl),

    // `随机形: 直出`（randomShapeDecl；文件头选项，独立通路）。
    random_shape_decl: lineRule(P.random_shape_decl, `${primary('head.randomShape')}[${W}]*[:\\uFF1A]${C}*`),

    // `别名 X = 目标`（名与关键词间有空白，故不进 headMatch）。
    alias_decl: kwSpace(alt('head.alias'), P.alias_decl),

    // `常量 <名> = <值>`。
    const_decl: kwSpace(alt('head.const'), P.const_decl),

    // `开关:` 块下的 `名: 值` 条目（switchItem）。上下文相关：只在开关体内合法，
    // 块外同形状是旁白（classifyLine 无上下文 ⇒ 判 text，两者由块嵌套各管一段）。
    switch_item: lineRule(
      P.switch_item,
      `[${ID}][${IDP}]*(?::[${IDP}]*)*[${W}]*[:\\uFF1A][${W}]+${C}+`,
    ),

    // ============================================================
    // 块头族
    // ============================================================

    timing_head: headWord(alt('block.timing'), P.timing_head),
    custom_command_head: headWord(alt('block.customCommand'), P.custom_command_head),
    function_head: headWord(alt('block.function'), P.function_head),

    // 单行条件 `如果 <条件> 则 <语句>`——必须先于 if_head（`否则如果 X 则 Y` 亦走此路）。
    single_if_head: lineRule(
      P.single_if_head,
      `(?:${alt('block.if')})[${W}]+${C}*[${W}]+(?:${alt('inline.then')})[${W}]+${C}*`,
    ),

    // `如果 <条件>：` / `否则如果 <条件>：`(elif) / `否则：`(else) 块头——variant 由 classifyLine 侧区分。
    // 英文写形 `if …:` 与中文同路（第一波漏了裸 `if`，本波补上）。
    if_head: headWord(alt('block.if', 'block.elif', 'block.else'), P.if_head),

    // `当 <变量>：`（whenHead / SELECTCASE）。
    when_head: headWord(alt('block.when'), P.when_head),

    // 表达式分支箭头档 `是 … -> 值` / `否则 … -> 值`（arrowCase / arrowElse；必须带 `->` 或 `→`）。
    // 只在 当/表达式当 体内合法。
    arrow_case: lineRule(P.arrow_case, `${primary('block.is')}${DELIM}${C}*(?:->|→)${C}*`),
    arrow_else: lineRule(P.arrow_else, `(?:${alt('block.else')})(?:${DELIM}${C}*)?(?:->|→)${C}*`),

    // `是 <值>：`（caseHead）——不带箭头；英文写形 `is` 同路（第一波漏，本波补）。
    case_head: headWord(alt('block.is'), P.case_head),

    // `随机：` 裸块头（词后跟冒号；无候选逗号）。
    random_head: lineRule(P.random_head, `(?:${alt('block.random')})[${W}]*[:\\uFF1A]${C}*`),
    // `随机 「甲」,「乙」` 行内简写（候选 ≥2、以逗号分隔）——带逗号者胜出（优先级高于裸头）。
    random_inline: lineRule(P.random_inline, `(?:${alt('block.random')})${DELIM}${C}*[,，]${C}*`),

    group_head: headWord(alt('block.group'), P.group_head),
    branch_head: headWord(alt('block.branch'), P.branch_head),

    // `[条件]` 规则标签行（整行恰为方括号；排除首字符即纯大写/数字的原生记号 `[SKIPSTART]`/`[0]`）。
    rule_tag: ($) => seq(tkRE(P.rule_tag, /\[[^A-Z0-9_\]\n][^\]\n]*\]/), optional($._line_tail)),

    section_head: headWord(alt('block.section'), P.section_head),
    once_head: headWord(alt('block.once'), P.once_head),

    choice_head: headWord(alt('block.choice'), P.choice_head),
    menu_head: headWord(alt('block.menu'), P.menu_head),
    ask_m_head: headWord(alt('block.askM'), P.ask_m_head),
    ask_yn_head: headWord(alt('block.askYN'), P.ask_yn_head),

    // `「标签」 [显示条件]：` 问答 / 选项条目头（choiceItem）——只在 选项/菜单/询问/确认 体内合法。
    // 另收**原生双引号标签**形 `"label":`（HK 中英同形：转译器把它当同一个条目，真源 `choiceItem`
    // 也认它）；两支都要求**同行出现冒号**（半角或全角）才成条目，否则落回 text_line + native_string。
    choice_item: lineRule(
      P.choice_item,
      `(?:「[^」";\\n]*」|"[^"\\n]*")[^:：";\\n]*[:\\uFF1A:]`,
    ),

    color_head: headWord(alt('block.color'), P.color_head),

    // `心形：` 连续块头（裸块头，行尾即冒号）。
    heart_head: lineRule(P.heart_head, `(?:${alt('inline.heart')})[${W}]*[:\\uFF1A]${C}*`),
    // 单行 `心形 「…」`（heartText）：词后跟空白 + 内容。
    heart_text: kwSpace(alt('inline.heart'), P.heart_text),

    // 时机内子句 `隐藏情景: …` / `隐藏口上: …`（messageCheck）。
    message_check: lineRule(P.message_check, `(?:${alt('inline.hideScene', 'inline.hideKojo')})${C}*`),

    // 表达式头 `目标 = 如果/当 …：`（exprHead；右侧须以如果/当/if/when 开头且行尾块头冒号）。
    // 条件段的冒号只挡**全角**（`TFLAG:1` 这类半角引用是真写法，第一波因此漏判成 assign）。
    // 首字符类**必须**排掉 `\n`/`\r`：`W` 只含水平空白，漏排时本词形能从**上一行的换行符**起匹配
    // ⇒ 记号 span 多吃一行 ⇒ 块节点起点比真源早一行（实测 release-check:159/163、
    // teaching-full:102/108 各错一行，并连带丢 6 条折叠召回）。换行的唯一认领者是 `blank_line`。
    expr_head: lineRule(
      P.expr_head,
      `[^${W}\\r\\n=]${C}*=[${W}]+(?:${alt('block.if', 'block.when')})${DELIM}[^：\\n]*[:\\uFF1A]`,
    ),

    // ============================================================
    // 循环 / 出错 / 数据表三族
    // ============================================================

    loop_head: headWord(alt('block.loop'), P.loop_head),
    loop_end: headWord(endWord('block.loop'), P.loop_end),
    catch_head: headWord(alt('block.catch'), P.catch_head),
    catch_end: headWord(endWord('block.catch'), P.catch_end),
    data_head: headWord(alt('block.dataTable'), P.data_head),
    data_end: headWord(endWord('block.dataTable'), P.data_end),

    // 块内收束形：自带行首换行 + 回缩空白，节点名 alias 回收束词本名（kind 不新增）。
    _loop_close: ($) =>
      alias(
        seq(tk(P.loop_end, `\\n${NLWS}${endWord('block.loop')}${C}*`), optional($._line_tail)),
        $.loop_end,
      ),
    _catch_close: ($) =>
      alias(
        seq(
          tk(P.catch_end, `\\n${NLWS}${endWord('block.catch')}${C}*`),
          optional($._line_tail),
        ),
        $.catch_end,
      ),
    _data_close: ($) =>
      alias(
        seq(
          tk(P.data_end, `\\n${NLWS}${endWord('block.dataTable')}${C}*`),
          optional($._line_tail),
        ),
        $.data_end,
      ),
    data_entry: kwSpace(alt('inline.dataEntry'), P.data_entry),

    jump_statement: kwSpace(alt('inline.jump'), P.jump_statement),
    function_jump: kwSpace(alt('inline.functionJump'), P.function_jump),
    loop_flow: headWord(alt('inline.breakLoop', 'inline.continueLoop', 'inline.restartLoop'), P.loop_flow),
    loop_step: kwSpace(alt('inline.loopStep'), P.loop_step),

    // ============================================================
    // 语句族
    // ============================================================

    settle: kwSpace(alt('inline.settle'), P.settle),
    mutator: kwSpace(alt('inline.mutator'), P.mutator),
    statement_call: kwSpace(altList(STATEMENT_WORDS, 'statementWords'), P.statement_call),
    call_statement: kwSpace(alt('inline.call'), P.call_statement),
    return_statement: headWord(alt('inline.return'), P.return_statement),

    // `空行` / `空行 等待`（blankLineCmd）。
    blank_line_cmd: lineRule(P.blank_line_cmd, `(?:${alt('inline.blank')})(?:[${W}]+\\S+)?`),

    // 赋值 `目标 = 表达式`（assign；优先级低于所有专有关键词头）。
    assign: lineRule(P.assign, `[^="\\n;]+=[^"\\n;]*`),

    // 三族里认得词形但结构残缺（controlMalformed）：只认**光杆控制词**（其后无正文）。
    // 词表限定为"裸写即非法"的词；合法写法（带冒号/内容）由各专有关键词头以**更长匹配**胜出：
    //   光杆 `跳到` / `函数跳转` / `标签` / `步进` / `条目` / `循环` / `出错处理` / `数据表`。
    // 不含收束词（`循环结束` 等本身合法，归 loop_end/catch_end/data_end）。
    // 词形取自这些 id 的登记面（当前各一枚中文主形；上游若登记别名会自动跟进，由守卫测试钉住）。
    control_malformed: lineRule(
      P.control_malformed,
      `(?:${alt(
        'inline.jump',
        'inline.functionJump',
        'inline.label',
        'inline.loopStep',
        'inline.dataEntry',
        'block.loop',
        'block.catch',
        'block.dataTable',
      )})`,
    ),

    // ============================================================
    // 行集合（块头族也在其中——同一记号既可是单行亦可是块头，由 scanner 的缩进记号裁决）
    // ============================================================

    _line: ($) =>
      choice(
        // ---- 台词 / 插值（原子行 token：要求同行闭合，是错误恢复的可定位点）----
        $.string,
        $.interpolation,
        // ---- 注释 / 原生直通 / 标签 ----
        // `raw_block_start`（行首 `@`）**不在这一张表里**：本族的块总是成得了（`_raw_close` 在空体
        // 时就落到，不像 `时机` 族要等回缩），所以它只作为 `block` 的 `open` 出现一次。留着单行形
        // 会让生成器在 `@ 行 • 任意行记号` 上判 shift/reduce 冲突（`_raw_body` 的首 token 就是任意
        // 行记号）；节点面不变——逐行反查经 `index.ts` 的 `lineNodeOf()` 取 `open` 字段，取到的
        // 仍是同一枚 `raw_block_start`，kind 对照分毫不动。
        $.comment_line,
        $.native_line,
        $.label_decl,
        // ---- 头部声明族 ----
        $.head_decl,
        $.random_shape_decl,
        $.alias_decl,
        $.const_decl,
        // ---- 块头族 ----
        $.timing_head,
        $.custom_command_head,
        $.function_head,
        $.single_if_head,
        $.if_head,
        $.when_head,
        $.case_head,
        $.random_inline,
        $.random_head,
        $.group_head,
        $.branch_head,
        $.rule_tag,
        $.section_head,
        $.once_head,
        $.choice_head,
        $.menu_head,
        $.ask_m_head,
        $.ask_yn_head,
        $.color_head,
        $.heart_head,
        $.heart_text,
        $.message_check,
        $.expr_head,
        // ---- 循环 / 出错 / 数据表三族 ----
        $.loop_head,
        $.loop_end,
        $.catch_head,
        $.catch_end,
        $.data_head,
        $.data_end,
        $.data_entry,
        $.jump_statement,
        $.function_jump,
        $.loop_flow,
        $.loop_step,
        // ---- 语句族 ----
        $.settle,
        $.mutator,
        $.statement_call,
        $.call_statement,
        $.return_statement,
        $.assign,
        $.blank_line_cmd,
        // ---- 残缺控制写法（fail-closed，绝不落文本冒充台词）----
        $.control_malformed,
        // ---- 兜底 ----
        $.blank_line,
        $.text_line,
      ),

    /** 可开"通用块"的块头族（其余族走各自的专体）。 */
    _plain_head: ($) =>
      choice(
        $.timing_head,
        $.custom_command_head,
        $.function_head,
        $.if_head,
        $.case_head,
        $.random_head,
        $.group_head,
        $.branch_head,
        $.rule_tag,
        $.section_head,
        $.once_head,
        $.color_head,
        $.heart_head,
      ),

    /** 条目族块头（体 = choice_item 条目 + 普通行）。 */
    _choice_like_head: ($) => choice($.choice_head, $.menu_head, $.ask_m_head, $.ask_yn_head),

    /** 分支族块头（体 = case_head 块 / 箭头形 + 普通行）。 */
    _when_like_head: ($) => choice($.when_head, $.expr_head),
  },
});
