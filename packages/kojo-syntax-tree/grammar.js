/**
 * kojo 表层 DSL 的 tree-sitter 语法（语法层第二真源）。
 *
 * 规则名须与 `src/node-types.ts` 的 KIND_TO_NODE 值逐一对齐——两侧同改。
 * 本文件禁出现游戏名词（审计 A 扫描 src；grammar.js 由纪律 + 对照闸守）。
 *
 * 优先级顺序照抄 `kojo-sugar` 的 `classifyLine`（行首分派：原生直通 → 头部/别名
 * → 块头 → 表达式头 → 赋值 → 文本）。
 *
 * 设计口径（本批实现选择）：
 * - kojo 是**行式** DSL：`classifyLine` 逐行分派、不做块配对（块由缩进在 parser 层配对）。
 *   本语法同样按行成节点，块体不在此嵌套——缩进 offside 规则需外部扫描器（scanner.c），
 *   本批不引入。`block` / `block_body` 容器因此不产出（它们在 node-types.ts 属
 *   NON_LINE_NODES，worker 按行反查 kind 不依赖容器）。
 * - 每行是一个**原子 token**（头部关键字 + `[^\n]*` 吞掉行内余文）。原子化保证行内任意内容
 *   （CJK、原生记号、行内 `;`、折行 `\`）都不触发 ERROR——零 ERROR 是本批硬闸。
 *   关键字头只在"行首恰出现该词"时才匹配（tree-sitter 隐式锚定 token 起点，故不写 `^`）。
 * - 行首分派靠 token 的**最长匹配 + 词法优先级**。tree-sitter 的 lexer 在多个 token 等长命中时
 *   只看 `token(prec(N, …))` 里的**数字 N**（named `precedences()` 数组不参与词法择优先），
 *   故这里用 `P` 数字表控制：`text_line` = 0 最低，越专有的词头 N 越大、越先胜。
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

/** 头部声明关键字（HEAD_DECL_KEYS 的中文主形 + 英文别名）：词后紧跟 `:`/`：` 才成头声明。 */
const HEAD_KEYS = [
  '角色', 'char', '口上', 'family', '显示名', 'title', '简介', 'desc',
  '口上色', 'color', '自机色', 'player-color', '旁白色', 'narration-color',
  '开关', 'switch', '函数前缀', 'function-prefix',
];

/** 语句形中文函数调用白名单词（`statement-functions.ts` 单一真源；此处仅取中文词形供行首判定）。 */
const STATEMENT_WORDS = ['设置标记', '清除标记', '翻转标记'];

/**
 * 词法优先级数字表（越大越先胜；等长命中时唯一裁决尺）。次序即 classifyLine 优先级：
 * 兜底 < 赋值 < 原生/台词 < 头部 < 专有关键词 < 块头 < 语句 < 更具体箭头/单行/残缺形。
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
};

/** 由模板串构造带数字词法优先级的原子 token。 */
function tk(n, source) {
  return token(prec(n, new RegExp(source)));
}

/** 由正则字面量构造带数字词法优先级的原子 token。 */
function tkRE(n, re) {
  return token(prec(n, re));
}

/** 块头词形（词后可跟任意正文）：`(?:词)(?:DELIM[^\n]*)?`。 */
function headWord(word, n) {
  return () => tk(n, `(?:${word})(?:${DELIM}[^\\n]*)?`);
}

/** 语句词形（词后**必须**跟空白 + 余文）：`(?:词)[WS]+[^\n]*`。 */
function kwSpace(word, n) {
  return () => tk(n, `(?:${word})[${W}]+[^\\n]*`);
}

module.exports = grammar({
  name: 'kojo',

  // 换行与水平空白都是 extras：行与行之间无需显式分隔符。
  extras: () => [/[ \t\r\n\f\u3000]+/],

  rules: {
    source_file: ($) => repeat($._line),

    _line: ($) =>
      choice(
        // ---- 台词 / 插值（原子行 token：要求同行闭合，是错误恢复的可定位点）----
        $.string,
        $.interpolation,
        // ---- 注释 / 原生直通 / 原生块 / 标签 ----
        $.comment_line,
        $.raw_block_start,
        $.native_line,
        $.label_decl,
        // ---- 头部声明族 ----
        $.head_decl,
        $.random_shape_decl,
        $.alias_decl,
        $.const_decl,
        $.switch_item,
        // ---- 块头族 ----
        $.timing_head,
        $.custom_command_head,
        $.function_head,
        $.single_if_head,
        $.if_head,
        $.when_head,
        $.arrow_case,
        $.case_head,
        $.arrow_else,
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
        $.choice_item,
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

    // ============================================================
    // 空行 / 文本 / 台词 / 插值
    // ============================================================

    // 空行 / 行尾换行：换行是 extras（行分隔），此规则以最低优先级兜底认领剩余换行，
    // 不干扰其余分派、也不与专有关键词头争抢（真实语料每个换行至多归此，绝不产 ERROR）。
    blank_line: () => token(prec(-100, /\n/)),

    // 兜底文本行：任意非空正文（旁白 / 台词）。显式不收行首 `「`/`{`/`;`/`@`/空白——
    // 那几个各有专路（未闭合的串/插值因此能落 ERROR 而非被静默吞成旁白）。
    text_line: () => tkRE(P.text_line, /[^ \t\r\n;「{@\u3000][^\n]*/),

    // 台词行 `「…」`：行首 `「`，同一物理行内以 `」` 收尾，或以 `\` 折行收尾。
    // `[^\n]*` 保证不跨行——未闭合的 `「` 因此落 ERROR（本批错误恢复的可定位点）。
    string: () => tkRE(P.string, /「[^\n]*[」\\]/),

    // 插值整行 `{…}`：行首 `{`，同一物理行内以 `}` 收尾。未闭合即 ERROR。
    interpolation: () => tkRE(P.interpolation, /\{[^\n]*\}/),

    // 行内注释：`;` 起至行尾（整行皆注释时 classifyLine 记 comment）。
    comment_line: () => tkRE(P.comment_line, /;[^\n]*/),

    // ============================================================
    // 原生直通 / 块 / 标签
    // ============================================================

    // 行首 `@`：原生函数块起始（rawBlockStart，直到下一个 `@` 行整块透传）。
    raw_block_start: () => tkRE(P.raw_block_start, /@[^\n]*/),

    // 全大写原生指令行 / `$标签`（RAW_INSTR_RE 行首 `[A-Z]` 形 + 起始 `$`；皆 rawLine）。
    native_line: () => tkRE(P.native_line, /(?:[A-Z][A-Z0-9_.]*(?::[^\n]*)?|\$)[^\n]*/),

    // `标签 <名>`（词 + 空白 + 标签名 → labelDecl；区别于 `$LABEL` 的原生直通形）。
    label_decl: kwSpace('标签', P.label_decl),

    // ============================================================
    // 头部声明族（`词: 值`；词与冒号之间无空白）
    // ============================================================

    head_decl: () => tk(P.head_decl, `(?:${HEAD_KEYS.join('|')})[${W}]*[:\\uFF1A][^\\n]*`),

    // `随机形: 直出`（randomShapeDecl；文件头选项，独立通路）。
    random_shape_decl: () => tkRE(P.random_shape_decl, /随机形[ \t]*[:：][^\n]*/),

    // `别名 X = 目标`（名与关键词间有空白，故不进 headMatch）。
    alias_decl: kwSpace('别名|alias', P.alias_decl),

    // `常量 <名> = <值>`。
    const_decl: kwSpace('常量|const', P.const_decl),

    // `开关:` 块下的 `名: 值` 条目（switchItem）。上下文相关（仅开关块内成立），但形态"标识符: 值"
    // 可无歧义识别——通用冒号条目行（非上述专有关键词、非赋值）。
    switch_item: () =>
      tk(P.switch_item, `[${ID}][${IDP}]*(?::[${IDP}]*)*[${W}]*[:\\uFF1A][${W}]+[^\\n]+`),

    // ============================================================
    // 块头族
    // ============================================================

    timing_head: headWord('时机|timing', P.timing_head),
    custom_command_head: headWord('自定指令', P.custom_command_head),
    function_head: headWord('函数|function', P.function_head),

    // 单行条件 `如果 <条件> 则 <语句>`——必须先于 if_head（`否则如果 X 则 Y` 亦走此路）。
    single_if_head: () =>
      tk(P.single_if_head, `(?:如果|if)[${W}]+[^\\n]*[${W}]+(?:则|then)[${W}]+[^\\n]*`),

    // `如果 <条件>：` / `否则如果 <条件>：`(elif) / `否则：`(else) 块头——variant 由 classifyLine 侧区分。
    if_head: headWord('如果|否则如果|否则|elif|elseif|else', P.if_head),

    // `当 <变量>：`（whenHead / SELECTCASE）。
    when_head: headWord('当|when', P.when_head),

    // 表达式分支箭头档 `是 … -> 值` / `否则 … -> 值`（arrowCase / arrowElse；必须带 `->` 或 `→`）。
    arrow_case: () => tk(P.arrow_case, `是${DELIM}[^\\n]*(?:->|→)[^\\n]*`),
    arrow_else: () => tk(P.arrow_else, `(?:否则|else)(?:${DELIM}[^\\n]*)?(?:->|→)[^\\n]*`),

    // `是 <值>：`（caseHead）——不带箭头。
    case_head: headWord('是', P.case_head),

    // `随机：` 裸块头（词后跟冒号；无候选逗号）。
    random_head: () => tk(P.random_head, `(?:随机|random)[${W}]*[:\\uFF1A][^\\n]*`),
    // `随机 「甲」,「乙」` 行内简写（候选 ≥2、以逗号分隔）——带逗号者胜出（优先级高于裸头）。
    random_inline: () => tk(P.random_inline, `(?:随机|random)${DELIM}[^\\n]*[,，][^\\n]*`),

    group_head: headWord('组|group', P.group_head),
    branch_head: headWord('分支|branch', P.branch_head),

    // `[条件]` 规则标签行（整行恰为方括号；排除首字符即纯大写/数字的原生记号 `[SKIPSTART]`/`[0]`）。
    rule_tag: () => tkRE(P.rule_tag, /\[[^A-Z0-9_\]\n][^\]\n]*\]/),

    section_head: headWord('若', P.section_head),
    once_head: headWord('初回', P.once_head),

    choice_head: headWord('选项|choice', P.choice_head),
    menu_head: headWord('菜单|menu', P.menu_head),
    ask_m_head: headWord('询问|ask', P.ask_m_head),
    ask_yn_head: headWord('确认|confirm', P.ask_yn_head),

    // `「标签」 [显示条件]：` 问答 / 选项条目头（choiceItem）：行首台词串后跟块头冒号（行尾闭合）。
    choice_item: () => tkRE(P.choice_item, /「[^」\n]*」[^\n]*[:：][ \t]*\r?\n/),

    color_head: headWord('着色', P.color_head),

    // `心形：` 连续块头（裸块头，行尾即冒号）。
    heart_head: () => tk(P.heart_head, `(?:心形|heart)[${W}]*[:\\uFF1A][^\\n]*`),
    // 单行 `心形 「…」`（heartText）：词后跟空白 + 内容。
    heart_text: kwSpace('心形|heart', P.heart_text),

    // 时机内子句 `隐藏情景: …` / `隐藏口上: …`（messageCheck）。
    message_check: () =>
      tkRE(P.message_check, /(?:隐藏情景|隐藏口上|skip-scene|skip-kojo)[^\n]*/),

    // 表达式头 `目标 = 如果/当 …：`（exprHead；右侧须以如果/当/if/when 开头且行尾块头冒号）。
    expr_head: () =>
      tk(P.expr_head, `[^${W}=][^\n]*=[${W}]+(?:如果|if|当|when)${DELIM}[^:：\n]*[:：]`),

    // ============================================================
    // 循环 / 出错 / 数据表三族
    // ============================================================

    loop_head: headWord('循环', P.loop_head),
    loop_end: headWord('循环结束', P.loop_end),
    catch_head: headWord('出错处理', P.catch_head),
    catch_end: headWord('出错处理结束', P.catch_end),
    data_head: headWord('数据表', P.data_head),
    data_end: headWord('数据表结束', P.data_end),
    data_entry: kwSpace('条目', P.data_entry),

    jump_statement: kwSpace('跳到', P.jump_statement),
    function_jump: kwSpace('函数跳转', P.function_jump),
    loop_flow: headWord('跳出循环|跳过本轮|重跑本轮', P.loop_flow),
    loop_step: kwSpace('步进', P.loop_step),

    // ============================================================
    // 语句族
    // ============================================================

    settle: kwSpace('结算|settle', P.settle),
    mutator: kwSpace('增减|adjust', P.mutator),
    statement_call: kwSpace(STATEMENT_WORDS.join('|'), P.statement_call),
    call_statement: kwSpace('调用|call', P.call_statement),
    return_statement: () => tk(P.return_statement, `(?:返回|return)(?:${DELIM}[^\\n]*)?`),

    // `空行` / `空行 等待`（blankLineCmd）。
    blank_line_cmd: () => tk(P.blank_line_cmd, `(?:空行|blank)(?:[${W}]+\\S+)?`),

    // 赋值 `目标 = 表达式`（assign；优先级低于所有专有关键词头）。
    assign: () => tkRE(P.assign, /[^=\n]+=[^\n]*/),

    // 三族里认得词形但结构残缺（controlMalformed）：只认**光杆控制词**（其后无正文）。
    // 词表限定为"裸写即非法"的词；合法写法（带冒号/内容）由各专有关键词头以**更长匹配**胜出：
    //   光杆 `跳到` / `函数跳转` / `标签` / `步进` / `条目` / `循环` / `出错处理` / `数据表`。
    // 不含收束词（`循环结束` 等本身合法，归 loop_end/catch_end/data_end）。
    control_malformed: () =>
      tk(P.control_malformed, `(?:跳到|函数跳转|标签|步进|条目|循环|出错处理|数据表)`),
  },
});
