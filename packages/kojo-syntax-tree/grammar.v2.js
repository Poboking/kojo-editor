/**
 * Kojo 2.0 表层语法的 tree-sitter 真源（第二语言世代，独立于 v1 grammar.js）。
 *
 * 设计口径（按 `docs/KOJO-2.0-LANGUAGE-SPEC.md` §2–§9）：
 *
 * 1. **行式 + offside 缩进**。每行 = 一条**行首分派**：
 *    `#` 声明 / `@` 调度 / `>` 旁白 / `?` 条件 / `!` 触发 / `//` 整行注释 /
 *    `「` 无符号台词（`# 池` 正典）/ 兜底：`角色：` 台词、赋值、裸调用。
 *    行首之外的 `>` `?` `!` 只是普通字符或表达式运算符（§2.4）。
 *
 * 2. **块 = 块头行 + 严格更深一级的体**（§4.13：一级 4 空格；Tab 只许 `@原生` 内）。
 *    缩进由 `src/scanner.v2.c` 的三个外部记号裁：
 *    * `indent` / `dedent`：**具名**外部记号（不是 `_` 隐藏名）——块体缺失时
 *      tree-sitter 插入的 `MISSING` 才能在 CST 里被看见、被定位（隐藏名的 MISSING
 *      在 children 遍历里会静默消失，违反"错误不静默"）。
 *    * `native_line`：`@原生` 缩进围栏里的整行 raw 文本；体内**不解析**任何 2.0 语法
 *      （`;`、`{}`、Tab、`[插槽]` 都是普通字符），空行原样保留。
 *    换行**不在 extras 里**（extras 只有空格与 `\r`）：换行由 `blank_line` 逐条认领，
 *    否则 extras 会把换行吞进后继节点的 span，块节点起点被拖到上一行、折叠区间错位（v1 实测）。
 *
 * 3. **行内结构只给两种叙事文本**（其余行整行一枚原子记号，语义校验留给 core）：
 *    * `speech`：`说话人：` + `「` + （正文 / 插值）* + `」`（+ 行尾提示 / `续`）；
 *    * `narration`：`>` + （正文 / 插值 / 行尾提示 / `续`）*。
 *    插值是**规则**（`{` + 体内 + `}`）而不是原子记号：未闭合时收束记号缺失，
 *    parser 在行末插一枚**具名** `MISSING:interp_close`；台词未闭合同理
 *    `MISSING:speech_close`。这就是"错误局部化在作者那一行"的可定位点（§11.2）。
 *    行内插值不嵌套、不跨行（§4.12），体内任意字符（含三元 `? :`）不解析。
 *
 * 4. **整行原子记号**（声明 / 调度 / 条件 / 触发 / 赋值 / 调用 / 表行）：
 *    语言层只认"这一行是哪一档"，值/类型/参数形状由 core 语义层校验——CST 不做
 *    第二份语义真源。行首字符类互斥 + 词形边界（消费一个空白/行尾）保证不互相吞。
 *
 * 5. **块头分两档**：
 *    * 必需体（`# 表` / `# 池` / `# 模` / `@原生`）：体缺失 ⇒ `MISSING:indent` 可定位；
 *    * 可选体（`@算` `@着色` `@随机` `@组` `@循` `@巡` `@复` `@函` `@织` `?` `? 否` `!`）：
 *      空体落回单行节点，不产 ERROR（`!` 的缩进块 = `# 模` 的 `[插槽]` 内容，本来就可省）。
 *    两档都由 `block` 一个容器承接（`open` / `body` 字段），folds 只认 `block` 一种形状。
 *
 * 6. 文件顶层与块体内共用 `_item`（= block | 行）⇒ 可执行块可互相嵌套，
 *    具体"哪个锚点允许出现在哪些块里"是 §7/§8 的语义约束，不在语法层重复。
 *
 * 标识符字符类（§2.4）：字母 / `_` / 汉字开头，后续可含数字；为兼容既有语料放宽到
 * 假名与全角拉丁（`identifier-chars.ts` 同源面）。**不收**全角数字与全角标点。
 *
 * ⚠ 词法优先级口径（实测，2026-10-21）：tree-sitter 的 token(prec(N, …)) **先比 N 再比长度**
 * ——高优先级短记号会压掉低优先级长记号。行首各档因此一律同档（默认 0），靠首字符互斥 +
 * 最长匹配分派；只有当两条记号**等长命中**需要裁决时才允许抬 N（当前仅 `call_line` vs
 * `assignment` 在 `f(a=1)` 这种行上等长）。`? 否` / 表 `否` 两处不用优先级，改用
 * "`?` 后的条件首字符不收 `否`"、"表端点首字符不收 `否`"的互斥写法——优先级一旦不同档，
 * 就会把更长的合法行（`? 否定的变量 == 1`）误判成短记号。
 */

// ---- 字符类源（以 RegExp 源码形式书写；String.raw 下 `\u3040` 保持为转义序列）----
/** 标识符起始集：ASCII 字母 / `_` / 假名 / 汉字（含扩展 A）/ 全角拉丁。 */
const ID = String.raw`A-Za-z_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uFF21-\uFF3A\uFF41-\uFF5A`;
/** 标识符后续集：起始集 + ASCII 数字。 */
const IDP = `${ID}0-9`;
/** 水平空白（含 Tab 与全角空格）：词与词之间的分隔符，也用于行尾允许的空白。 */
const W = String.raw` \t\u3000`;

/** 正则元字符转义（词形都是 CJK，但保留转义以防词表扩展）。 */
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/** RegExp 源码 → 原子 token（默认词法优先级 0）。 */
const tk = (source) => token(new RegExp(source));
/** RegExp 源码 + 词法优先级 → 原子 token（只用于等长裁决，见头注 ⚠）。 */
const tkPrec = (n, source) => token(prec(n, new RegExp(source)));

/** `# 声明词`：`#` 与词之间**必须有空白**（`#DIM` 因此不认，落 ERROR）；词后必须有
 *  空白或行尾（`# 机关` 不会被当成 `# 机`）。声明值整段收在记号里，语义层再拆。 */
const decl = (word) => tk(String.raw`#[${W}]+${esc(word)}(?:[${W}][^\n]*)?`);

/**
 * `@调度词`。
 * @param {'none'|'optional'|'required'} arg
 *   none：词后只能是行尾/空白（`@算 x` 的 `x` 落 ERROR，绝不静默吞掉）；
 *   optional：可省略实参（`@着色` / `@返` / `@标` …，缺实参由语义层报错）；
 *   required：必须有空白 + 余文（`@函 名(...)` / `@织 事件`）。
 */
const at = (word, arg = 'none') => {
  const head = `@${esc(word)}`;
  const source =
    arg === 'none'
      ? String.raw`${head}[${W}]*`
      : arg === 'required'
        ? String.raw`${head}[${W}]+[^\n]*`
        : String.raw`${head}(?:[${W}][^\n]*)?`;
  return tk(source);
};

/** 旁白正文：不吃 `{`（插值起点）与半角 `(`（行尾提示起点），也不吃行尾 `续`
 *  （留给 continue_mark）；`\x` 转义对整对保留为正文（§2.6）。
 *  末字符类必须同样排掉 `{` / `\`：否则贪婪正文会把插值开括号吞成正文（未闭合插值就静默了）。 */
const NARRATION_TEXT = String.raw`(?:\\[^\n]|[^{\n(])*[^ \t\u3000\r\n续({\\]`;
/** 台词正文：不吃 `{` `}` `」` 与换行；`\x` 转义整对保留。 */
const SPEECH_TEXT = String.raw`(?:\\[^\n]|[^{}」\n])+`;
/** 插值体内：不嵌套、不跨行（§4.12）。 */
const INTERP_BODY = String.raw`[^{}\n]+`;
/** 表端点标识符：与 ID 同面但**首字符不收「否」**——`否 <值>` 是默认分支，不能由端点记号抢走。 */
const ID_ENDPOINT = String.raw`A-Za-z_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u5425\u5427-\u9fff\uFF21-\uFF3A\uFF41-\uFF5A`;
/** 表端点：十进制整数字面量或已声明整数常量名（§6.1；是不是常量由语义层查）。 */
const TABLE_ENDPOINT = String.raw`(?:[${ID_ENDPOINT}][${IDP}]*|[0-9]+)`;
/** 表范围的四种写法（§6.1）：闭区间 / 开上界 / 开下界 / 精确值。 */
const TABLE_RANGE = String.raw`(?:${TABLE_ENDPOINT}\.\.(?:${TABLE_ENDPOINT})?|\.\.${TABLE_ENDPOINT}|${TABLE_ENDPOINT})`;

module.exports = grammar({
  name: 'kojo2',

  // 换行不在 extras（见头注 2）。Tab 也不在：结构区用 Tab 缩进必须落 ERROR（§4.13）。
  extras: () => [new RegExp(`[ \\r]+`)],

  // 顺序必须与 src/scanner.v2.c 的枚举一致。
  externals: ($) => [$.indent, $.dedent, $.native_line],

  rules: {
    /** 文件 = 一串 item；最后一行可以没有换行（blank_line 缺席）。 */
    source_file: ($) => repeat($._item),

    /** item = 块 或 行；缩进记号在"块 vs 单行"的归约冲突里由 `prec.right` 让块先长。 */
    _item: ($) => choice(prec.right($.block), $._line),

    // ============================================================
    // 块：块头 + 严格更深一级的体
    // ============================================================

    block: ($) =>
      prec.right(
        choice(
          // 必需体：声明型块与逃生舱（体缺失 ⇒ MISSING:indent 可定位）
          seq(field('open', $.table_head), field('body', $.table_body)),
          seq(field('open', $.pool_head), field('body', $.block_body)),
          seq(field('open', $.template_head), field('body', $.block_body)),
          seq(field('open', $.native_head), field('body', $.native_body)),
          // 可选体：可执行块 / 条件分支 / 触发（空体落回单行节点，不产 ERROR）
          seq(field('open', $._optional_block_head), field('body', $.block_body)),
        ),
      ),

    /** 块头两档里"体可省"的那一档（同时也是 `_line` 里的单行形）。 */
    _optional_block_head: ($) =>
      choice(
        $.calc_head, // @算
        $.color_head, // @着色
        $.random_head, // @随机
        $.group_head, // @组
        $.while_head, // @循
        $.foreach_head, // @巡
        $.repeat_head, // @复
        $.function_head, // @函
        $.weave_head, // @织
        $.condition_head, // ? 条件
        $.else_head, // ? 否
        $.trigger, // ! 池 / 模 / 函（缩进块 = [插槽] 内容）
      ),

    /** 通用块体：indent + item* + dedent。 */
    block_body: ($) => seq($.indent, repeat($._item), $.dedent),

    /**
     * `# 表` 的体：只收表行 / 整行注释 / 空行。
     * 空行按 §6.1 是"结束表"的语义信号；语法层放它进来只是为了让写坏的那一行
     * 就近报错、而不是把后续行一起卷进 ERROR（语义层据 blank_line 判"表内空行"）。
     */
    table_body: ($) => seq($.indent, repeat(choice($.table_row, $.comment, $.blank_line)), $.dedent),

    /** `@原生` 的体：整行 raw，不解析任何 2.0 语法（含 `;` `{}` Tab `[插槽]`）。 */
    native_body: ($) => seq($.indent, repeat(choice($.native_line, $.blank_line)), $.dedent),

    // ============================================================
    // 行集合：所有不以块体形式出现的行（块头也可以退化成单行，故同列）
    // ============================================================

    _line: ($) =>
      choice(
        // ---- 注释 / 空行 / 模板插槽 ----
        $.comment,
        $.blank_line,
        $.slot_marker,
        // ---- `#` 声明（单行形；块声明见 block）----
        $.scene_decl,
        $.view_decl,
        $.event_decl,
        $.variable_decl,
        $.constant_decl,
        $.dialect_decl,
        // ---- `@` 调度（单行指令）----
        $.face_command,
        $.return_stmt,
        $.break_stmt,
        $.continue_stmt,
        $.label_stmt,
        $.jump_stmt,
        // ---- 叙事区：旁白 / 台词 / 无符号台词（# 池）----
        $.narration,
        $.speech,
        $.bare_speech,
        // ---- 调度区裸写：赋值 / 裸调用 ----
        $.assignment,
        $.call_line,
        // ---- 可省体的块头（单行退化形）----
        $.calc_head,
        $.color_head,
        $.random_head,
        $.group_head,
        $.while_head,
        $.foreach_head,
        $.repeat_head,
        $.function_head,
        $.weave_head,
        $.condition_head,
        $.else_head,
        $.trigger,
      ),

    // ============================================================
    // `#` 声明（§3）
    // ============================================================

    scene_decl: () => decl('幕'),
    view_decl: () => decl('视'),
    event_decl: () => decl('机'),
    variable_decl: () => decl('变量'),
    constant_decl: () => decl('常量'),
    /**
     * `# 方言 <名字>`（LAU §5.3 / spec §3.3）：本方案**唯一新增的词位**，形态与 `# 视`
     * 同构（一个裸名字）。它只是"这份文件自证属于哪个方言"的**断言**，不赋值、不产生
     * 第二真源；名字对文法与 core 都是不透明字符串 ⇒ 词表里**不许**出现任何方言取值，
     * 也不许为某个方言单开规则（D10：方言差异一律不进语法）。
     */
    dialect_decl: () => decl('方言'),

    /** 块声明的块头行（体由 block 挂）：`# 表 <名> 由 <表达式>`（§6.1）。 */
    table_head: () => decl('表'),
    /** `# 池 <名>`：体是一条 `?` 链（§7.1）。 */
    pool_head: () => decl('池'),
    /** `# 模 <名>(参数…)`：体 = 文本 + 最多一个 `[插槽]`（§7.2）。 */
    template_head: () => decl('模'),

    // ============================================================
    // `@` 调度（§8 / §9）
    // ============================================================

    /** `@算`：状态更新块，不接行内内容（§8.1）。 */
    calc_head: () => at('算', 'none'),
    /** `@着色 <颜色>`：演出块，体是正常叙事块（§8.2）。 */
    color_head: () => at('着色', 'optional'),
    /** `@随机`：候选块；多行候选必须包 `@组`（§8.4）。 */
    random_head: () => at('随机', 'none'),
    /** `@组`：`@随机` 内的多行候选（§8.4）。 */
    group_head: () => at('组', 'none'),
    /** `@循 <条件>`：条件循环（§9.3）。 */
    while_head: () => at('循', 'optional'),
    /** `@巡 <集合>`：遍历（§9.3）。 */
    foreach_head: () => at('巡', 'optional'),
    /** `@复 <次数>`：固定次数循环（§9.3）。 */
    repeat_head: () => at('复', 'optional'),
    /** `@函 名(参数…)`：运行期函数（§7.3）。 */
    function_head: () => at('函', 'required'),
    /** `@织 <事件> [之前|之后|接管]`：监听声明（§8.6）。 */
    weave_head: () => at('织', 'required'),
    /** `@原生`：缩进围栏逃生舱，体见 native_body（§8.5）。 */
    native_head: () => at('原生', 'none'),

    /** `@颜绘 参数…`：单行演出指令，不是块头（§8.3）。 */
    face_command: () => at('颜绘', 'optional'),
    /** `@返 [表达式]`（§2.3 / §7.3）。 */
    return_stmt: () => at('返', 'optional'),
    /** `@断`：跳出最近一层循环（§9.3）。 */
    break_stmt: () => at('断', 'none'),
    /** `@续`：跳过本次循环剩余部分（§2.4：与行尾 `续` 是两件东西）。 */
    continue_stmt: () => at('续', 'none'),
    /** `@标 <名>`：单元内标签（§9.4）。 */
    label_stmt: () => at('标', 'optional'),
    /** `@跳 <名>`：单元内跳转（§9.4）。 */
    jump_stmt: () => at('跳', 'optional'),

    // ============================================================
    // `?` 条件链 / `!` 触发
    // ============================================================

    /**
     * `? <整数表达式>`：一条条件分支；`?` 后必须有空白或行尾（§2.4）。
     * 条件首字符不收 `否` ⇒ 与 `? 否` 靠**互斥**分派（不靠优先级：
     * 优先级不同档会把 `? 否定的变量 == 1` 这种更长合法行误判成 else）。
     */
    condition_head: () =>
      tk(String.raw`\?(?:[${W}]+(?:[^否\n][^\n]*|[${W}]*))?`),
    /** `? 否`：条件链的默认分支（§5）。 */
    else_head: () => tk(String.raw`\?[${W}]*否[${W}]*`),
    /** `! 池名` / `! 模名(实参)` / `! 函名(实参)`：触发（§2.1 / §7）。 */
    trigger: () => tk(String.raw`(?:![${W}]+[^\n]*|![${W}]*)`),

    // ============================================================
    // 叙事区（§4）
    // ============================================================

    /**
     * 旁白：`>` + （正文 / 插值 / 行尾提示 / `续`）*。
     * 行尾提示与 `续` 作为**兄弟节点**收在 repeat 里：正文记号用"末字符不得是
     * `(` / `续`"的写法把尾巴切出来，语法位置不额外限制 ⇒ `> 甲(心形) 续`、
     * `> 甲 续` 都能落到正确捕获。
     */
    narration: ($) =>
      seq(
        field('marker', $.narration_marker),
        repeat(choice($.narration_text, $.interpolation, $.presentation_hint, $.continue_mark)),
      ),

    /** `>` 锚点（`>` 后可有空白；"`>` 后必须空白或行尾"的语义校验留给 core）。 */
    narration_marker: () => tk(String.raw`>[${W}]*`),
    /**
     * 旁白正文段。
     * 优先级 2 高于 `continue_mark`(1) 与行首各档(0)：`> 续甲` 必须整段算正文，
     * 不能因为 `续` 是行尾等待记号而被切开（见头注 ⚠：优先级压过长度，所以正文要更高档）。
     */
    narration_text: () => tkPrec(2, NARRATION_TEXT),

    /**
     * 台词：`说话人：` + `「…」` + 行尾提示/`续`（§4.5）。
     * 说话人可以是角色名或域符号 `{我}` / `{你}`（§3.6）。
     */
    speech: ($) =>
      seq(
        field('speaker', $.speaker),
        field('text', $.speech_string),
        repeat(choice($.presentation_hint, $.continue_mark)),
      ),

    /** `# 池` 内的无符号台词：`「…」`（省略说话人，默认 `{我}`，§7.1 / §4.9）。 */
    bare_speech: ($) =>
      seq(field('text', $.speech_string), repeat(choice($.presentation_hint, $.continue_mark))),

    /**
     * 说话人 = 名字 + 全角冒号（**一枚记号**）。
     *
     * 为什么把冒号并进说话人记号：行首只有"带冒号的名字"才可能是台词；不并的话
     * `speaker`（名字）会先吃掉任何裸文本行/坏行的头几个字，parser 接着等冒号，
     * 错误恢复就会跨行卷进下一行（实测裸文本 + 下一行 `#DIM` 连成一个跨行 ERROR）。
     * 并进冒号后，裸文本行起手没有任何记号可命中 ⇒ 词法错误被限制在**本行**。
     */
    speaker: () =>
      tk(String.raw`(?:[${ID}][${IDP}]*|\{[^{}\n]*\})[${W}]*：`),

    /** 引号台词串：`「` + （正文 / 插值）* + `」`。未闭合 ⇒ MISSING:speech_close。 */
    speech_string: ($) =>
      seq($._speech_open, repeat(choice($.speech_text, $.interpolation)), $.speech_close),
    _speech_open: () => tk('「'),
    speech_text: () => tk(SPEECH_TEXT),
    /** 台词收束 `」`：具名，未闭合时的 MISSING 才能被宿主看见（§11.2）。 */
    speech_close: () => tk('」'),

    /**
     * 行内插值 `{…}` / `{条件 ? A : B}`（§4.12）：体内任意字符、不嵌套、不跨行。
     * 收束 `}` 具名 ⇒ 未闭合时 MISSING:interp_close 落在作者那一行。
     */
    interpolation: ($) => seq($._interp_open, optional($.interp_body), $.interp_close),
    /**
     * 插值开括号：优先级 1 高于行首各档(0)——旁白里 `{乙}` 会被 `speaker` 的 `\{…\}` 记号
     * 以更长匹配抢走；开括号必须靠优先级压住它（行首 `{我}：` 的台词不受影响：
     * 那里插值记号根本不是合法起点）。
     */
    _interp_open: () => tkPrec(1, String.raw`\{`),
    interp_body: () => tk(INTERP_BODY),
    interp_close: () => tk(String.raw`\}`),

    /** 行尾表演提示：半角 `(…)`（§4.8；已知/未知提示的分档由 adapter presentation 决定）。 */
    presentation_hint: () => tk(String.raw`\([^()\n]*\)`),
    /**
     * 行尾 `续`：不等待（§4.7）。与行首 `@续` 是两件事（§2.4）。
     * 优先级 1：与"下一行行首记号"（如 speaker 也能吃下 `续` 这个字）等长命中时，
     * 行尾语义优先；旁白正文档(2)仍压它，`> 续甲` 不会被切。
     */
    continue_mark: () => tkPrec(1, String.raw`续[${W}]*`),

    // ============================================================
    // 调度区裸写（§4.3 / §4.4 / §9.6）
    // ============================================================

    /**
     * 赋值 / 增量：`左值 = 表达式`、`+=`/`-=`/`*=`/`/=`。
     * 左值可以是变量、数组元素、`{角色}的<属性>`；行内 `=` 后整段收在记号里。
     * 首字符类排掉 `#@>?!` `「` `[` `/` 与数字 ⇒ 不与行首锚点、台词、表行争抢。
     */
    assignment: () =>
      tk(String.raw`(?:[${ID}]|\{)[^=\n「]*[+\-*/]?=[^\n]*`),

    /** 裸函数调用行（§4.4 第 5 条：允许但建议写 `!`）：`名字(...)` 或 `名字.属性(...)`。 */
    call_line: () => tkPrec(1, String.raw`[${ID}][${IDP}]*(?:\.[${ID}][${IDP}]*)?\([^\n]*`),

    // ============================================================
    // 表行（§6.1）：`<范围> <值>` 两列，空白分隔
    // ============================================================

    table_row: ($) =>
      seq(field('range', choice($.table_range, $.table_else)), field('value', $.table_value)),
    /** 范围：`0..100` / `500..` / `..100` / `5` / `亲近线..`（端点合法性由语义层校验）。 */
    table_range: () => tk(TABLE_RANGE),
    /** `否 <值>`：表默认分支，必须最后（§6.1，语义层校验）。 */
    table_else: () => tk('否'),
    /** 值列：首个非空白起、到行尾（先 trim 首尾空白是语义层的事）。 */
    table_value: () => tk(String.raw`[^ \t\u3000\r\n][^\n]*`),

    // ============================================================
    // 行杂项
    // ============================================================

    /** 整行 `//` 注释（§4.13）；不支持行尾注释。 */
    comment: () => tk(String.raw`//[^\n]*`),
    /**
     * 物理空行：换行的**唯一**认领者（只含 CRLF 的 `\n`；行首空白由 extras 吃掉）。
     *
     * ⚠ 不能再写成 `[ \t\u3000\r]*\n`：只要记号自身以空白起手，tree-sitter 的 lexer
     * 就无法把这段空白当 extras 跳过，token 的 start 会落在**行首列 0**（v1 实测同病），
     * 行节点的起列、高亮/折叠的列号跟着全错。换行记号必须从非空白字符起手。
     */
    blank_line: () => tk(String.raw`\n`),
    /** `# 模` 内的 `[插槽]`（§7.2）：最多一个，位置由语义层校验。 */
    slot_marker: () => tk(String.raw`\[插槽\][${W}]*`),
  },
});
