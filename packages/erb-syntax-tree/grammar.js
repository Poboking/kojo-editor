/**
 * ERB（EraBasic 脚本）**结构专用** tree-sitter 语法——只建模"行式结构"，不建模引擎内建。
 *
 * ## 词与配对从哪来（零手抄）
 * 本文件**没有**任何手写的控制流关键字、`#DIM` 族名单或 `[SKIPSTART]` 标记字面量：
 * 全部取自 `src/structure.json`（`tools/gen-erb-structure.mjs` 对
 * `packages/plugins/erb-parser/src/scanner.ts` 的构建期投影）。上游增删控制词 / 改配对 /
 * 改等值标记 / 改 `DIM_RE` ⇒ 重跑本包 `build` 即同步；忘了重跑由
 * `tests/projection-single-source.test.ts` 判红。控制流角色与配对类别的**判据**仍是
 * scanner.ts 的 `classifyControlFlow()`，本文件只把它的输出翻译成规则。
 *
 * ## 结构面（故意做窄）
 * - **行**：`comment_line`（`;` 起）、`directive_line`（`#` 起的其余整行）、`dim_directive`（`#DIM` 族，
 *   声明词 / 修饰词 / 名字 / 尾部各自成节点）、`label_line`（`$` 起）、
 *   `bracket_line`（`[` 起的其余整行，含 `[IF_DEBUG]` 一类条件跳过标记）、
 *   `statement_line`（兜底语句/文本行）。
 * - **函数**：`function_block` = `function_head` + 直到下一条 `@` 行（或 EOF）的行。
 *   头支持裸形 `@NAME`、括号形 `@NAME(A, B:1 = 3)`、逗号形 `@NAME, A, B`；
 *   形参已切分为 `parameter` 节点（修饰词 / 名字 / 维度 / 默认值），不解释默认值语义。
 * - **控制流块**：开块 / 分支 / 闭合全部按 scanner 的配对表生成 `(if_block)`、(select_block) 等；
 *   分支段有 `(branch_block)`，折叠查询直接取它。
 * - **[SKIPSTART]…[SKIPEND]**：`skip_block`，区内原文由一个 external scanner 一次吞成
 *   `skip_body`（不解析、不产行节点）——区间内可以有任何字符（含 `@`、控制词、未闭合引号）。
 * - **字符串与 FORM 切分**：行内 `"…"` 成为 `(string)`；串内/串外的 `{…}` 成
 *   `(form_interpolation)`、`%…%` 成 `(form_substitution)`。**只是词法切分**：不求值、不认函数名，
 *   也不保证括号配对（ASCII 画里的散 `{`/`}` 落成 `brace_literal`，绝不因此报错）。
 * - 控制流语句的**表达式**是整行不透明 token（`IF A AND B` 不拆表达式）——表达式语义不在本包范围。
 *
 * ## 换行与坐标
 * 换行是独立记号（不进 extras）：行节点只覆盖正文，块节点靠内部换行自然跨行；折叠止行由
 * `src/index.ts` 的 `foldRanges()` 统一收口（块末若停在下一行行首，回退一行）。
 * extras 只含水平空白 + BOM + CR——CRLF 语料的 `\r` 由 extras 吃掉，`\n` 仍是换行记号。
 *
 * ## 容错口径
 * - 合法文件目标 0 ERROR / 0 MISSING（真语料实测见工具读数）；控制流**必须配平**才能成块，
 *   未配平会落 MISSING（可定位），不静默吞成文本。
 * - 未闭合引号由 `(string)` 的"收尾引号可选"吸收（ERB 的 `@"…"` 续行/ASCII 画里裸引号真实存在）；
 *   它不制造 ERROR，也不冒充已闭合串。
 * - 顶层孤儿闭合 / 分支行有单行形（不产块），避免一行坏掉污染全篇。
 *
 * 本文件禁出现游戏名词：这里是语言层资产，ERB 与 Kojo 同级。
 */

const S = require('./src/structure.json');

/** 投影完整性（fail-closed）：缺格 = 生成脚本没跑/产物被手改，绝不让 grammar 带缺判据去生成 parser。 */
function need(cond, msg) {
  if (!cond) throw new Error(`structure.json 不完整：${msg}——重跑 tools/gen-erb-structure.mjs`);
}
need(S && S.controlFlow && S.controlFlow.pairs, 'controlFlow.pairs');
need(S.markers && S.markers.skipStart && S.markers.skipEnd, 'markers.skipStart/skipEnd');
need(Array.isArray(S.dimDirectives) && S.dimDirectives.length > 0, 'dimDirectives');
need(typeof S.dimFlags === 'string' && S.dimFlags.includes('i'), 'dimFlags 含 i');
need(Array.isArray(S.dimModifiers) && S.dimModifiers.length > 0, 'dimModifiers');
need(typeof S.dimModifierFlags === 'string' && S.dimModifierFlags.includes('i'), 'dimModifierFlags 含 i');

const CF = S.controlFlow;
const PAIRS = CF.pairs;
const PAIR_NAMES = Object.keys(PAIRS).sort();

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 关键字大小写不敏感：tree-sitter 记号正则没有 `/i` ⇒ 逐字母展开成 `[xX]`。 */
function ci(word) {
  return [...word]
    .map((ch) => (/[A-Za-z]/.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch))
    .join('');
}

/** kind（`TRYCCALLFORM`）→ 节点名（`tryccallform_line`）。 */
const lineNode = (word) => `${word.toLowerCase()}_line`;

/** 词法优先级（数字越大越先胜；同场候选中它先于"最长匹配"裁决）。 */
const P = {
  // 兜底语句行首原子必须是**最低**词法优先级：函数头余文的 reduce 路径让它与 `(` `)` `,` 等同场竞争，
  // 唯一负级才能保证结构记号不被长匹配吞掉（详见 `_line_head` 注释）。
  line: -2,
  brace: 1,
  percent: 1,
  bracket: 2,
  comment: 4,
  directive: 4,
  dim_directive: 6,
  label: 4,
  control: 10,
  at_string: 60,
  interpolation: 60,
  substitution: 60,
  comment_inline: 70,
};

const tkSrc = (n, source) => token(prec(n, new RegExp(source)));

/**
 * 控制流整行 token：关键字 + 一个**非标识符字符**作词形边界，其余到行尾。
 *
 * 边界必须由记号自己吃掉（tree-sitter 不支持 look-around）：`IFX` / `IF_DEBUG` 因此不归 `IF`
 * （与 scanner 的 `/^([A-Za-z_]+)/` 同判），而后面的 `;`、引号、表达式一律留在本行 token 内——
 * 控制流表达式不在本包建模范围，整行不透明才不会让表达式里的 `;` 被误当注释。
 */
function controlLine(n, word) {
  // 边界**必须排除换行**：裸关键字（NEXT / DO / REPEAT…）在行尾时，若把 `\n` 当成分隔符，
  // `[^\n]*` 就会把下一行吞进本 token（实测 NEXT⏎CASE / DO⏎PRINTL 全部跨行）。
  // 边界组**不能是可选的**：可选会让短词只匹配前缀（ELSE 吃 ELSEIF、TRYCCALL 吃
  // TRYCCALLFORM、IF 吃 IFDr）。故拆成两支：
  //   · 内容行：词 + 一个非标识符边界 + 到行尾（**不吞换行**，行坐标与增量缝合保持原口径）；
  //   · 裸词行：词 + 可选水平空白 + 换行（文末无换行的裸词由调用方 `parseStructureText` 补一个虚拟换行）。
  const w = ci(word);
  return tkSrc(n, `(?:${w}[^A-Za-z_\\r\\n][^\\r\\n]*|${w}[ \\t\\u3000]*\\r?\\n)`);
}

const CONTROL_LINE_RULES = (() => {
  const out = {};
  for (const word of [...Object.keys(CF.open), ...Object.keys(CF.branch), ...Object.keys(CF.close), ...CF.leaf].sort(cmp)) {
    out[lineNode(word)] = () => controlLine(P.control, word);
  }
  return out;
})();

/** 某一角色的词对应的行规则引用（`$[name]` 形式交给 grammar）。 */
const lineRefs = (words) => words.map((w) => lineNode(w));


/** `#DIM` 族声明词：一级分支逐字母展开大小写；之后必须跟一个水平空白才成声明。 */
const DIM_ALT = [...S.dimDirectives].sort((a, b) => b.length - a.length || cmp(a, b)).map(ci).join('|');
const DIM_KEYWORD = `#(?:${DIM_ALT})[ \\t\\f\\u3000]`;
/** 声明行前置修饰词（投影自 scanner.ts 的 DIM_MODIFIERS；含 REF，故形参修饰词复用同一张表）。 */
const DIM_MODIFIER_ALT = [...S.dimModifiers].sort((a, b) => b.length - a.length || cmp(a, b)).map(ci).join('|');
const DIM_MODIFIER = `(?:${DIM_MODIFIER_ALT})[ \\t\\u3000]+`;

/** 控制流块规则（逐配对类别生成；字面量只来自 structure.json）与分支段规则。 */
const CONTROL_BLOCK_RULES = {};
const CONTROL_BLOCK_NAMES = [];
for (const pair of PAIR_NAMES) {
  const p = PAIRS[pair];
  const opens = lineRefs(p.open);
  const closes = lineRefs(p.close);
  const branches = lineRefs(p.branch);
  need(opens.length > 0, `${pair}.open`);
  need(closes.length > 0, `${pair}.close`);

  if (branches.length === 0) {
    CONTROL_BLOCK_RULES[`${pair}_block`] = ($) =>
      seq(
        field('open', choice(...opens.map((n) => $[n]))),
        repeat($._body_item),
        field('close', choice(...closes.map((n) => $[n]))),
      );
  } else {
    const branchBlock = `_${pair}_branch_block`;
    CONTROL_BLOCK_RULES[branchBlock] = ($) =>
      seq(field('branch', choice(...branches.map((n) => $[n]))), repeat($._body_item));
    CONTROL_BLOCK_RULES[`${pair}_block`] = ($) =>
      seq(
        field('open', choice(...opens.map((n) => $[n]))),
        repeat($._body_item),
        repeat(alias($[branchBlock], $.branch_block)),
        field('close', choice(...closes.map((n) => $[n]))),
      );
  }
  CONTROL_BLOCK_NAMES.push(`${pair}_block`);
}

/** `[` 起的整行兜底（`[IF_DEBUG]` / `[ENDIF]` / `[[…]]` 一类）；在 marker 之后，等长时 marker 胜。 */
const BRACKET_LINE = `\\[[^\\r\\n]*`;

/**
 * `@` 函数头：名字终止符与 scanner `parseFunctionDefinition` 逐字对齐
 * （ASCII 空格 / TAB / `(` / `,` / `;`）。
 *
 * 头行余文切成结构节点：括号形 / 逗号形形参一律落 `parameter_list` / `comma_parameter_list`，
 * 每枚形参再切 `parameter_modifier` / `parameter_name` / `parameter_dimension` / `parameter_default`。
 *
 * 两条硬约束（都来自实测）：
 * 1. 函数体**必须**从 `_newline` 起手（见 `function_block` 注释），否则 `(ARG,…)` 会与
 *    "同位置起一条新语句行"竞争，被 `_line_head` 按最长匹配整段吃掉。
 * 2. 形参修饰词只认投影的修饰词表（含 `REF`），不能写成宽泛 ASCII 标识符——`ARG = 3` 会
 *    把 `ARG ` 误当修饰词，名字就没了。
 */
const FUNCTION_NAME = '[^ \\t(,;"\\r\\n]+';

module.exports = grammar({
  name: 'erb',

  // 水平空白 / CRLF 的 CR / BOM 是 extras；**换行不是**（由 _newline 记号认领，见头注）。
  extras: () => [/[ \t\r\f\u3000\uFEFF]+/],

  externals: ($) => [$._skip_start, $._skip_body, $._skip_end],

  // 行族 token 之间靠"最长匹配 + token(prec) 数字"裁决；块/行两义由规则位置区分，无 conflicts 表。
  rules: {
    source_file: ($) => repeat($._item),

    _item: ($) =>
      choice(
        $.function_block,
        $.skip_block,
        $._control_block,
        $._line,
        $._orphan_control_line,
        $._newline,
      ),

    /** 函数体 / 控制流体内的行集合（不含函数头，不含孤儿收束）。 */
    _body_item: ($) => choice($.skip_block, $._control_block, $._line, $._newline),

    _newline: () => /\n/,

    // ============================================================
    // 函数：@ 头 + 直到下一条 @ 行 / EOF
    // ============================================================
    /**
     * 函数：头行 + 体。体**必须**从换行之后开始（`_function_body` 以 `_newline` 起手）——
     * 否则 head 余下的 `(…)` 会与"同位置起一条新语句行"竞争，词法器按最长匹配把
     * `(ARG,…)` 整段吃成 `_line_head`，形参表就永远接不上（实测）。
     * EOF 处没有换行 ⇒ 空函数，体可选。
     */
    function_block: ($) => prec.right(seq(field('head', $.function_head), optional($._function_body))),
    _function_body: ($) => prec.right(seq($._newline, repeat($._body_item))),

    function_head: ($) => seq('@', field('name', $.function_name), optional($.function_head_tail)),

    function_name: () => tkSrc(5, FUNCTION_NAME),

    /**
     * 头行余文（名字之后）：
     * - 括号形 / 逗号形形参表，可再接行内注释或裸余文；
     * - 裸头后的行内注释（`comment_inline` 独立成支，不能放进 parameter_list：
     *   注释里若含 `)` 会把参数表的收括号吞掉）；
     * - 其余余文（`function_head_trailing` 首字符排除 `(` `,` `;`，
     *   在 `(` 处 parameter_list 胜、在 `,` 处 comma_parameter_list 胜、在 `;` 处注释胜）。
     */
    function_head_tail: ($) =>
      choice(
        seq(
          choice($.parameter_list, $.comma_parameter_list),
          optional(choice($.comment_inline, $.function_head_tail_text)),
        ),
        $.comment_inline,
        $.function_head_trailing,
      ),
    // 余文 token 的**词法优先级低于一切结构记号**（见 `_line_head` 的注释）：
    // tree-sitter 先按词法优先级裁决、再比长度，余文若给高优先级，`)` `,` `:` `=` `"` 与形参名
    // 都会被它按长匹配吞掉（实测 `@F(A)` 只剩空 parameter_list）。
    function_head_trailing: () => tkSrc(-1, '[^(;,\\r\\n][^\\r\\n]*'),
    function_head_tail_text: () => tkSrc(-1, '[^;\\r\\n]+'),

    // ---- 形参（scanner 的 parseParams 口径：按 `=` 切默认值，左侧按空白分段的最后一段是名字）----
    parameter_list: ($) => seq('(', optional($._parameter_items), optional(')')),
    comma_parameter_list: ($) => seq(',', optional($._parameter_items)),
    _parameter_items: ($) => seq($.parameter, repeat(seq(',', optional($.parameter)))),
    parameter: ($) =>
      seq(
        repeat($.parameter_modifier),
        field('name', $.parameter_name),
        optional(field('dimension', $.parameter_dimension)),
        optional(field('default', $.parameter_default)),
      ),
    parameter_modifier: () => tkSrc(9, DIM_MODIFIER),
    parameter_name: () => tkSrc(8, '[^ \\t\\f\\u3000:;=,()\\[\\]\\r\\n]+'),
    parameter_dimension: ($) => seq(':', $.parameter_dimension_value),
    parameter_dimension_value: () => tkSrc(9, '[^ \\t\\f\\u3000;=,()\\r\\n]+'),
    // `=` 之后是可选的默认值：右结合 = 「能 shift 就 shift」，让 `= "VOID"` 的值归默认值，
    // 只有值起不了头（`,` / `)` / 行尾）才收成空默认（消解 tree-sitter 的 reduce/shift 冲突）。
    parameter_default: ($) => prec.right(seq('=', optional($.parameter_default_value))),
    // 值由串 / 裸文 / 括号值拼接：右结合让能续的片段都续进同一个默认值（不劈成多个兄弟）。
    parameter_default_value: ($) => prec.right(repeat1(choice($.string, $.parameter_default_raw, $.parameter_paren_value))),
    parameter_default_raw: () => tkSrc(1, '[^,;()"\\r\\n]+'),
    // 同上：`(` 之后有嵌套括号值时右结合优先（`(FOO(1))` 内层归值，空括号只在 `)` 处收）。
    parameter_paren_value: ($) => prec.right(seq('(', optional($._parameter_default_items), optional(')'))),
    // `(` 内的逗号优先留在括号值里（右结合），外层形参表的逗号只在括号收口后才算。
    _parameter_default_items: ($) =>
      prec.right(seq($.parameter_default_value, repeat(seq(',', optional($.parameter_default_value))))),

    // ============================================================
    // 停用区：原样吞掉，只认投影来的 [SKIPSTART] / [SKIPEND]
    // ============================================================
    /**
     * 停用区：体由 external scanner 一次吞下（含区间内换行），grammar 不再插换行记号——
     * 区间内文本不参与词法化。体可为空（`[SKIPSTART]` 后紧接着收区行）；EOF 无收区标记时
     * close 可选，不让残缺文件把全篇吞成 ERROR。
     */
    skip_block: ($) =>
      seq(
        field('open', $.skip_start),
        optional(field('body', $.skip_body)),
        optional(field('close', $.skip_end)),
      ),

    skip_start: ($) => $._skip_start,
    skip_end: ($) => $._skip_end,
    skip_body: ($) => $._skip_body,

    // ============================================================
    // 行族
    // ============================================================
    _line: ($) =>
      choice(
        $.comment_line,
        $.dim_directive,
        $.directive_line,
        $.label_line,
        $.bracket_line,
        $.at_string_line,
        $.string_line,
        $.statement_line,
        // 单行控制语句（SIF）——投影里 role=leaf 的词，全部进这一支
        ...lineRefs(CF.leaf).map((name) => $[name]),
      ),

    comment_line: () => tkSrc(P.comment, ';[^\\r\\n]*'),
    /** 其余 `#` 行：匿名 `#` + 可选 body（`#DIM ` 的声明词长 5 > 匿名 `#` 长 1 ⇒ 最长匹配先归 dim_directive）。 */
    directive_line: ($) => seq('#', optional($._directive_body)),
    _directive_body: () => tkSrc(P.directive, '[^\\r\\n]+'),
    /**
     * `#DIM` 族：声明词 + 修饰词（真源可叠多个）+ 可选声明 + 行内注释。
     *
     * 声明（名字 / 尾部）必须是**独立规则**且整体可选：若名字与尾部都在同一层可选，
     * 尾部 `[^;\r\n]+` 会按最长匹配把名字整段吞掉（`#DEFINE TEST_CONST 3` 的名字就没了）。
     * 尾部直接吃 `, 10` / `= 3` / ` 3` 三种形态，遇 `;` 让位给行内注释。
     */
    dim_directive: ($) =>
      prec(
        P.dim_directive,
        seq(
          field('directive', $.dim_keyword),
          repeat($.dim_modifier),
          optional($.dim_declaration),
          optional($.comment_inline),
        ),
      ),
    dim_declaration: ($) => seq(field('name', $.dim_name), optional(field('tail', $.dim_tail))),
    dim_keyword: () => tkSrc(P.dim_directive, DIM_KEYWORD),
    dim_modifier: () => tkSrc(9, DIM_MODIFIER),
    dim_name: () => tkSrc(8, '[^ \\t\\f\\u3000,;=()\\[\\]\\r\\n]+'),
    dim_tail: () => tkSrc(5, '[^;\\r\\n]+'),
    label_line: () => tkSrc(P.label, '\\$[^\\r\\n]*'),
    bracket_line: () => tkSrc(P.bracket, BRACKET_LINE),

    /**
     * 兜底语句 / 文本行：首原子不吃 `; @ " # $ [ % { }`（各有专路），
     * 之后的行内块可以含这些字符。引号 / `{…}` / `%…%` 成为子节点。
     */
    statement_line: ($) =>
      prec.right(
        seq(
          choice(
            $._line_head,
            $.form_interpolation,
            $.form_substitution,
            $.percent_literal,
            $.brace_literal,
          ),
          repeat(choice($._line_chunk, $.string, $.form_interpolation, $.form_substitution, $.percent_literal, $.brace_literal)),
          optional($.comment_inline),
        ),
      ),
    // 首字符排除水平空白：否则缩进的 `@` 函数头 / `$` 标签 / `[` 行会被整行吞成语句行
    // （真语料存在 `\t@FUNC`；extras 本该先吞掉缩进，但 token 自己能从空白起手时就不会被跳过）。
    //
    // 词法优先级必须**低于一切结构记号（含匿名 `(` `)` `,` `:` `=` `"`）**：函数头余文的
    // reduce 路径让本记号在 `@F(…)` 的 `(` 处也进词法候选集，tree-sitter 先按优先级裁决，
    // 0 级时本记号会按长匹配把 `(ARG,…)` 整段吃成语句行。给负优先级后，`(` 等结构记号稳胜。
    _line_head: () => tkSrc(P.line, '[^ \\t\\f\\u3000\\uFEFF;@"#$\\[\\r\\n%{}][^\\r\\n;"%{}]*'),
    /**
     * 行内续文（串 / `{…}` / `%…%` 之外的部分）。优先级**高于控制词 token**：一旦语句行已经开始，
     * 行内再出现的 `for` / `if` / `case` 等只是文本（真语料：`DEBUGPRINTFORML … {X} for %NAME% was …`
     * 整行被中途劈成 `for` 块，进而把后续整段吞成 ERROR）。行首仍由控制 token 裁决（本记号不是首原子）。
     */
    _line_chunk: () => tkSrc(11, '[^;"%{}\\r\\n]+'),

    /** 行首 `@"…"`：ERB FORM 的续行/HTML 串常以 `@"` 起行（真语料 121 行），不是函数头。 */
    at_string_line: ($) =>
      prec.right(
        seq(
          $.at_string,
          repeat(choice($._line_chunk, $.string, $.form_interpolation, $.form_substitution, $.percent_literal, $.brace_literal)),
          optional($.comment_inline),
        ),
      ),
    /** `@"…"` 串（`@` 与开引号是同一枚 token，见下方注释）；收尾引号同样可选。 */
    at_string: ($) =>
      prec.right(
        seq(
          $._at_string_open,
          repeat(choice($.form_interpolation, $.form_substitution, $._string_chunk, $.brace_literal, $.percent_literal)),
          optional('"'),
        ),
      ),
    /**
     * `@` + 可选空白 + `"` **合成一枚 token**：不能让 `@` 单独出现在函数体里——
     * 解析器在函数体内看到 `@` 会先 shift 到 at_string_line（shift 优先于 reduce），
     * 下一字符是函数名时整条 `@` 头就进 ERROR（实测两个连续 `@` 头必挂）。
     * 合成后 `@"` 行与 `@NAME` 行在词法层就分开了。
     */
    _at_string_open: () => tkSrc(P.at_string, '@[ \\t\\u3000]*"'),
    string_line: ($) =>
      prec.right(
        seq($.string, repeat(choice($._line_chunk, $.string, $.form_interpolation, $.form_substitution, $.percent_literal, $.brace_literal)), optional($.comment_inline)),
      ),

    /** 行内串：收尾引号**可选**（未闭合串的原样保留，不制造 ERROR）。 */
    string: ($) =>
      prec.right(
        seq(
          '"',
          repeat(choice($.form_interpolation, $.form_substitution, $._string_chunk, $.brace_literal, $.percent_literal)),
          optional('"'),
        ),
      ),
    // 串内续文优先级必须高于 `_line_chunk`：否则解析器可提前收串、把余文当新语句行（实测 `"a;b"` 只剩 `"`）。
    _string_chunk: () => tkSrc(20, '[^"{}%\\r\\n]+'),

    /** FORM 插值 `{…}`：不嵌套、不跨行（与真源 FORM 的基本切分同域；画里的散括号走 brace_literal）。 */
    form_interpolation: () => tkSrc(P.interpolation, '\\{[^{}\\r\\n]*\\}'),
    /** FORM 代换 `%…%`：允许内部含引号（`%TEXTR("…")%` 真语料存在），不跨行。 */
    form_substitution: () => tkSrc(P.substitution, '%[^%\\r\\n]*%'),
    percent_literal: () => tkSrc(P.percent, '%'),
    brace_literal: () => tkSrc(P.brace, '[{}]'),

    comment_inline: () => tkSrc(P.comment_inline, ';[^\\r\\n]*'),

    // ============================================================
    // 控制流块（逐配对类别生成；字面量只来自 structure.json）
    // ============================================================
    _control_block: ($) => choice(...CONTROL_BLOCK_NAMES.map((name) => $[name])),

    ...CONTROL_BLOCK_RULES,

    /** 顶层孤儿收束 / 分支：单行落点（不产块、不污染后续结构）。 */
    _orphan_control_line: ($) =>
      choice(
        ...lineRefs([
          ...Object.keys(CF.close).sort(cmp),
          ...Object.keys(CF.branch).sort(cmp),
        ]).map((name) => $[name]),
      ),

    // 投影派生的行规则（控制词一枚一节点）
    ...CONTROL_LINE_RULES,
  },
});
