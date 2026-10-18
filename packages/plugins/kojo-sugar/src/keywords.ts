/**
 * 表层语法关键字表（规范 §3 / §4 / 附录 A）——**跨游戏语言层**。
 *
 * 中文关键字本身不是某个游戏的领域知识（契约 `sugar.ts` 头注已定调），
 * 故关键字表住在转译器内；eraTW 特定的旗标命名 / 配色常量 /
 * 时机分野模板来自 adapter。
 *
 * 一律「中文主形 + 英文别名」双收（规范 §4.1）。产物永远是原生 ERB——
 * 别名只影响**输入**，不影响输出。
 */

/** 关键字 → 规范语义 id（内部规范形，与输入语言解耦） */
export type KeywordId =
  /* 头部声明 */
  | 'head.char'
  | 'head.family'
  | 'head.title'
  | 'head.desc'
  | 'head.color'
  | 'head.playerColor'
  | 'head.narrationColor'
  | 'head.switch'
  | 'head.alias'
  /* 文件头选项 `随机形: <值>`（P-4）——**只为高亮/补全纳编**：判定归 `lexer.classifyLine`
     的位置式扫描（`key === '随机形'`），故**不得**进 `HEAD_DECL_KEYS`（口径同 `常量`）。 */
  | 'head.randomShape'
  /** `随机形:` 的取值词形（`直出`）——同样只为词表可见，判定归 parser 的取值比较。 */
  | 'head.randomShapeValue'
  /** `口上: <家族名> 选择器: <n>` 的行尾选择器词形——判定归 parser 的 `head.family` 行尾正则。 */
  | 'head.selector'
  /* 文件级常量（7 号批：`常量 <名> = <整数>` → 编译期展开，产物零声明） */
  | 'head.const'
  /* 头部选项（B4-fp：作者私有用户函数命名前缀） */
  | 'head.functionPrefix'
  /* 块头 */
  | 'block.timing'
  | 'block.if'
  | 'block.elif'
  | 'block.else'
  | 'block.when'
  | 'block.is'
  | 'block.random'
  | 'block.group'
  /** 规则池（条件注解）块头 `分支：` / `branch：`——产物是一条 IF/ELSEIF/ELSE 链（规范 §3.11）。 */
  | 'block.branch'
  | 'block.choice'
  | 'block.menu'
  | 'block.color'
  | 'block.section'
  | 'block.customCommand'
  /* 用户函数（B4 批：公共段 / 自定义函数最小形） */
  | 'block.function'
  /* 初回块（1 号任务：`初回 "key"：` = 引擎 `ONCE(...)`） */
  | 'block.once'
  /* 循环 / 出错处理 / 数据表三族（本批：显示层独有词形降格为**语言层块头**——
     登记进本表即承诺"写得回去"，词形与 `native-display/control.ts` 的显示形同源） */
  | 'block.loop'
  | 'block.loopEnd'
  | 'block.catch'
  | 'block.catchEnd'
  | 'block.dataTable'
  | 'block.dataTableEnd'
  /* 问答块（询问 / 确认）：引擎封装问答函数调用（eraTW ASK_M / ASK_YN） */
  | 'block.askM'
  | 'block.askYN'
  /* 行内 / 时机子句 */
  | 'inline.cont'
  | 'inline.heart'
  | 'inline.blank'
  /* `空行 等待` 的等待标记（规范 §3.3 v1.5）——**只为高亮/补全纳编**：判定归 lexer 的
     `空行` 判定消费 `WAIT_MARKS`，故**不得**进 `HEAD_DECL_KEYS`（口径同 `常量` / `则`）。 */
  | 'inline.wait'
  | 'inline.to'
  | 'inline.call'
  | 'inline.return'
  | 'inline.hideScene'
  | 'inline.hideKojo'
  | 'inline.settle'
  /* 数值增减行（1016 批）：`增减 <族>:<对象>:<槽> ± 增量` → `CALL <族目标函数>(…)`。
     族 → 目标函数 + 参数序是游戏知识（只住 adapter 的增减族表）；糖层只查不解释。 */
  | 'inline.mutator'
  /* 单行条件的 `则` 分隔词（本批）：`如果 <条件> 则 <语句>`；不是独立语句，只是条件与语句的界标 */
  | 'inline.then'
  /* 循环族的**模态词**（`循环 计数 …` / `循环 当 …` / `循环 <次数> 次 …` / `循环 无限 …`）与步进行（`步进 X 加 1`） */
  | 'inline.loopCount'
  /** `循环 <表达式> 次：` 的尾部量词（⇄ 引擎 `REPEAT <表达式>`：按参数指定的次数循环） */
  | 'inline.loopTimes'
  /** `循环 无限：` 的模态词（⇄ 引擎**裸** `REPEAT`：不带次数 = 无限循环） */
  | 'inline.loopForever'
  | 'inline.loopFrom'
  | 'inline.loopStride'
  | 'inline.loopStep'
  | 'inline.plus'
  | 'inline.minus'
  /* 跳转与循环出口（`跳到` / `函数跳转` / `标签` / `跳出循环` / `跳过本轮` / `重跑本轮`） */
  | 'inline.jump'
  /** `函数跳转 <原文>`（⇄ 引擎 `JUMP <原文>`：函数调用串**逐字**带走，不是标签名） */
  | 'inline.functionJump'
  | 'inline.label'
  | 'inline.breakLoop'
  | 'inline.continueLoop'
  | 'inline.restartLoop'
  /* 数据表条目行（`条目 <原文>`）与**记号回显**标记（`原形 <引擎记号>`：翻类不翻义，写法与产物同一 token） */
  | 'inline.dataEntry'
  | 'inline.engineEcho'
  /* 别名右值 */
  | 'alias.char';
/**
 * 关键字表：英文别名一律**小写 ASCII**（规范 §4.1）。
 * 中文主形按 UTF-16 原文精确匹配（不做全角/半角折叠——关键字本身无全半角变体）。
 */
const KEYWORDS: ReadonlyMap<string, KeywordId> = new Map([
  // 头部
  ['角色', 'head.char'],
  ['char', 'head.char'],
  ['口上', 'head.family'],
  ['family', 'head.family'],
  ['显示名', 'head.title'],
  ['title', 'head.title'],
  ['简介', 'head.desc'],
  ['desc', 'head.desc'],
  ['口上色', 'head.color'],
  ['color', 'head.color'],
  ['自机色', 'head.playerColor'],
  ['player-color', 'head.playerColor'],
  ['旁白色', 'head.narrationColor'],
  ['narration-color', 'head.narrationColor'],
  ['开关', 'head.switch'],
  ['switch', 'head.switch'],
  ['别名', 'head.alias'],
  ['alias', 'head.alias'],
  // 文件级常量（7 号批）：`常量 <名> = <整数>` → 编译期展开为字面量，产物零声明。
  // 形态是**词后跟空白 + `名 = 值`**（`常量 X = 5`），不是 `词: 值` ⇒ 与 `别名` 同款的
  // "不靠本表判定"关键字：登记进表只为让编辑器**高亮/补全认得它**（词表单一真源，
  // 同 `则` / `随机形` 的理由），判定归 lexer 的位置式扫描（`lexer.classifyLine`）。
  // **不得**进 `HEAD_DECL_KEYS`——那会让 `常量 X = 5` 被 `词: 值` 通路截半（值变 `=` 前那截）。
  ['常量', 'head.const'],
  ['const', 'head.const'],
  // 头部选项 `函数前缀: <模板>`（B4-fp）——不是块关键字，与 `随机形:` 同属"文件头选项"；
  // 但因是 `词: 值` 形且需编辑器高亮/补全，故仍走 `KEYWORDS` + `HEAD_DECL_KEYS`（见下）。
  ['函数前缀', 'head.functionPrefix'],
  ['function-prefix', 'head.functionPrefix'],
  // 文件头选项 `随机形: <值>`（P-4）与它的取值 `直出`——作者要写的词。
  // 登记进表**只为让编辑器高亮/补全认得它**（词表单一真源，同 `常量` / `则` / `增减` 的理由）；
  // 判定仍归 lexer 的位置式扫描（`lexer.classifyLine` 里 `key === '随机形'` 一支，先于本表查询）。
  // **不得**进 `HEAD_DECL_KEYS`：`随机形:` 走的是自己的 `randomShapeDecl` 通路，挂进头部声明集
  // 只会让它改走 `headDecl`（值语义由 parser 的 `applyHeadDecl` 解释，那边没有这个键）。
  // 英文别名不登记：lexer 只认 `随机形` 一个键形（登记一个不生效的别名 = 词表说谎）。
  ['随机形', 'head.randomShape'],
  ['直出', 'head.randomShapeValue'],
  // `口上: <家族名> 选择器: <n>` 的行尾选择器（A1 批）——不是独立语句、也不单独成行，
  // 由 parser 的 `head.family` 行尾正则消费（`选择器` / `selector` 两词形并列，见 `parser.ts`）。
  // 登记只为词表可见；**不得**进 `HEAD_DECL_KEYS`——否则裸写一行 `选择器: 2` 会被当头部声明，
  // 把"嵌在 `口上:` 行尾"这一唯一形态之外的写法误判成合法槽位。
  ['选择器', 'head.selector'],
  // 块头
  ['时机', 'block.timing'],
  ['timing', 'block.timing'],
  ['如果', 'block.if'],
  ['if', 'block.if'],
  ['否则如果', 'block.elif'],
  ['elif', 'block.elif'],
  ['elseif', 'block.elif'],
  ['否则', 'block.else'],
  ['else', 'block.else'],
  ['当', 'block.when'],
  ['when', 'block.when'],
  ['是', 'block.is'],
  ['is', 'block.is'],
  ['随机', 'block.random'],
  ['random', 'block.random'],
  // 候选组（E18）：把「随机：」的一个候选收成多行；只作**裸块头** `组：`
  ['组', 'block.group'],
  ['group', 'block.group'],
  // 规则池（条件注解）块头（规范 §3.11）：`分支：` / `branch：` 只作**裸块头**；
  // 块体是 `[条件]` 标签行 + 各自更深缩进的正文，产物 = 一条 IF/ELSEIF/ELSE 链。
  // `[` 在 ERB 里是数组下标 / 位名语法，故标签只在**行首整行恰为 `[…]`** 时成立
  // （判定归 lexer 的位置式扫描 `matchRuleTag`，本表登记只为高亮/补全可见）。
  ['分支', 'block.branch'],
  ['branch', 'block.branch'],
  // 段块（E13 批）：库内「多信封分段」的可写形（产物 = `LOCAL = n` + `IF LOCAL && <条件>` 信封）。
  // 与 `如果` 同一降糖管线（段头原文当 ERB 条件），不另造一套条件语法。
  // **唯一词形 = `若`**（P-1R 批；1016 批删去旧形 `段` / 英文 `section`）：段头非纯条件，
  // `非 X` 是**逻辑否定**（走既有中文运算符管线，产物 `IF LOCAL && !X`），与"停用态"不同轴。
  ['若', 'block.section'],
  ['选项', 'block.choice'],
  ['choice', 'block.choice'],
  // 数字输入菜单（B2）：逐条 `PRINTL [n]` + `INPUT` + `SELECTCASE RESULT` + 回跳环。
  // 与按钮形 `选项`（PRINTBUTTON + INPUTS + RESULTS）是**两个独立块头**——读回变量不同。
  ['菜单', 'block.menu'],
  ['menu', 'block.menu'],
  ['着色', 'block.color'],
  // 自定指令块（HK-12）：**块头**上下文（行首 `自定指令 名称：`）。
  // 注意与既有 `类型: 自定指令` 的**命名参数右值**撞词——后者按纯字符串取用、
  // 不查本表（见 `lexer.parseTimingHead`），两上下文互不干扰（测试已钉住）。
  ['自定指令', 'block.customCommand'],
  // 用户函数声明块（B4 批）——`函数 名字(形参,…)：`。**块头**上下文；
  // 与 `返回` / `调用` 同批，三者共同构成"作者自定义函数"这一最小面。
  ['函数', 'block.function'],
  ['function', 'block.function'],
  // 初回块（1 号任务）：`初回 "key"：` → `IF ONCE("key")` … `ENDIF`。引擎 `ONCE(...)`
  // 是**变量式访问器**（`ONCE(名称, 初期値, キャラ番号…)`，可读可写）。只登记中文主形——
  // 英文别名 `once` 不登记（`ONCE` 是引擎函数名、不是作者输入别名，登记会与候选撞词）。
  ['初回', 'block.once'],
  // 循环族（本批）：`循环 计数 X 从 a 到 b [步长 s]：` / `循环 当 X：` / `循环 <表达式> 次：` / `循环 无限：` / `循环：`。
  // 收束一律 `循环结束`——引擎侧 `NEXT` / `WEND` / `REND` / `LOOP` 四枚闭合词由**开块模态**决定，
  // 写法上不区分（区分就是把引擎记号搬回表层）；`次` 与 `无限` 两模态同收 `REND`。
  // 词形登记进本表即承诺可写，
  // 显示侧（`native-display/control.ts`）从同一张表取词，不存在第二份口径。
  ['循环', 'block.loop'],
  ['循环结束', 'block.loopEnd'],
  // 出错处理块（`出错处理：` ⇄ `CATCH` … `ENDCATCH`）——只覆盖 CATCH 本体；
  // TRY 系九枚（`TRYCGOTO` / `TRYCALLLIST` …）**无写形**，仍走 `未识别语句` 兜底。
  ['出错处理', 'block.catch'],
  ['出错处理结束', 'block.catchEnd'],
  // 数据表块（`数据表：` + `条目 <原文>` + `数据表结束` ⇄ `PRINTDATA` 族）。
  // 变体后缀（`PRINTDATADL` 一类）不猜义项：写 `数据表 原形 PRINTDATADL：`，产物就是那枚记号。
  ['数据表', 'block.dataTable'],
  ['数据表结束', 'block.dataTableEnd'],
  // 问答块（作者爱用的引擎封装问答函数）：`询问` 多选（eraTW ASK_M）/ `确认` 二择（eraTW ASK_YN）。
  // 与 `选项`（PRINTBUTTON+INPUTS+RESULTS）/ `菜单`（PRINTL+INPUT+SELECTCASE RESULT）是**另一条
  // 管线**——本组产 `CALL <引擎函数>(...)` + `SELECTCASE`，函数名/参数/读回变量由 adapter 模板声明。
  // 条目头 `「标签」 [逐项显示条件]：`——该槽是**逐项显示条件**（引擎逐条第 2 参：0 = 灰显无效 /
  // 负 = 隐藏 / 非 0 = 有效），**不是**选中返回值（选中项由 `CASE 0..n-1` 位置决定）；槽可选、缺省 `1`。
  ['询问', 'block.askM'],
  ['ask', 'block.askM'],
  ['确认', 'block.askYN'],
  ['confirm', 'block.askYN'],
  // 行内
  ['续', 'inline.cont'],  ['cont', 'inline.cont'],
  ['continue', 'inline.cont'],
  ['心形', 'inline.heart'],
  ['heart', 'inline.heart'],
  // `空行` 是**整行语句**（规范 §3.3；批 P），但它没有独立的语法分组，
  // 归到"行内关键字"一并高亮/补全（与 `心形` 同一处理方式）
  ['空行', 'inline.blank'],
  ['blank', 'inline.blank'],
  // `空行 等待` 的**等待标记**中文主形（取值词形，见下方 `WAIT_MARKS`）——登记只为高亮/补全，
  // 判定归 lexer 的 `空行` 判定（消费 `WAIT_MARKS`）。英文形 `wait` **不**登记本表：它是引擎
  // 指令 `WAIT` 的小写形（ZH-S 线的中文显示面正对着它），进糖词表 = 让高亮/补全把引擎指令名
  // 当糖关键字挂出来；两条面互不干扰的钉法见 `tests/zh-author-words.test.ts`。
  ['等待', 'inline.wait'],
  ['到', 'inline.to'],
  ['to', 'inline.to'],
  // 语句位置的用户函数调用（B4 批）——`调用 名字(实参,…)` 独立成行。
  ['调用', 'inline.call'],
  ['call', 'inline.call'],
  // 函数体返回值（B4 批）——`返回 <值>`（值函数）或裸 `返回`（过程函数）。
  ['返回', 'inline.return'],
  ['return', 'inline.return'],
  ['隐藏情景', 'inline.hideScene'],
  ['skip-scene', 'inline.hideScene'],
  ['隐藏口上', 'inline.hideKojo'],
  ['skip-kojo', 'inline.hideKojo'],
  // 经验结算行（B5）：`结算 <引用> += 1` → `EXP:<引用> += 1`——把 `EXP:` 变量族的一次
  // 经验结算收成一行可读糖。表达式**原文逐字**接到 `EXP:` 前缀后；省略/显式作用域两形态
  // 都由作者原样写在表达式里，转译器**不解释**作用域词、也不硬编码任何具体经验名。
  ['结算', 'inline.settle'],
  ['settle', 'inline.settle'],
  // 数值增减行（1016 批）：`增减 <族>:<对象>:<槽> ± 增量` → 一条 `CALL <族目标函数>(…)`。
  // 表层与 `结算` 同款"词 + 空白 + 余下正文"，故判定同属**位置式扫描**（不走本表）——
  // 登记进表只为让编辑器高亮/补全认得它（词表单一真源，同 `结算` / `则` 的理由）。
  // 族 → 目标函数 + 参数序查 adapter 的增减族表；未登记族 / 变量槽形态不符一律 fail-closed。
  ['增减', 'inline.mutator'],
  ['adjust', 'inline.mutator'],
  // 单行条件的 `则` 分隔词（本批）——`如果 <条件> 则 <语句>` 里条件段与语句段的分界。
  // 登记进表是为了让编辑器高亮/补全认得它（词表单一真源）；**判定不走本表**——
  // 它在 `条件` 里可能与变量名撞词，故由 lexer 的位置式扫描（带空白边界）单独识别。
  ['则', 'inline.then'],
  ['then', 'inline.then'],
  // 循环模态词与步进行（本批）——判定归 lexer 的循环分支，登记进表让高亮/补全认得它。
  // `循环 计数 <变量> 从 <起> 到 <止> [步长 <步>]：` / `循环 <表达式> 次：` / `循环 无限：` /
  // `步进 <变量> 加|减 <增量>`。
  // 英文别名不登记：`FOR` / `STEP` 这类全大写记号已被**原生直通通道**截获（`RAW_INSTR_RE`），
  // 登记一个小写别名只会让词表说谎（写了也不走糖）。
  ['计数', 'inline.loopCount'],
  // `次`：`循环 <表达式> 次：` 的尾部量词 ⇄ 引擎 `REPEAT <表达式>`（官方义项 = **按参数指定的次数循环**，
  // 参数可以是数式；`REPEAT 5` = 重复 5 次）。单字形词形只在本族的「词 + 空白 + 余文」通路里被消费，
  // 台词里夹着「次」字（`一次` / `次数`）不带词边界 ⇒ 不会被抢走（判据见同源闸的散文负例）。
  ['次', 'inline.loopTimes'],
  // `无限`：裸 `REPEAT`（不带参数 = 无限循环，引擎合法但盘上 0 处）的诚实形——次数槽什么都不写。
  ['无限', 'inline.loopForever'],
  ['从', 'inline.loopFrom'],
  ['步长', 'inline.loopStride'],
  ['步进', 'inline.loopStep'],
  ['加', 'inline.plus'],
  ['减', 'inline.minus'],
  // 跳转与循环出口（本批）：`跳到 <名>` / `函数跳转 <原文>` / `标签 <名>` /
  // `跳出循环` / `跳过本轮` / `重跑本轮`。
  // 同样不登记英文别名：`GOTO` / `JUMP` / `BREAK` / `CONTINUE` / `RESTART` 全是全大写
  // 原生记号（`RAW_INSTR_RE` 直通），`continue` 更已与行内 `续` 撞词——登记即说谎。
  ['跳到', 'inline.jump'],
  // `函数跳转` ⇄ 引擎 `JUMP <原文>`：那一枚记号在引擎里是**函数跳转**（目标是函数调用串，
  // 不是 `$标签`），与 `跳到`（`GOTO`）义项不同 ⇒ 两枚各给一形，不撞成同一个中文叫法
  // （撞了就是照预览写回去、产物却换了记号）。余文**逐字**透传、不降糖也不查标签名。
  ['函数跳转', 'inline.functionJump'],
  ['标签', 'inline.label'],
  ['跳出循环', 'inline.breakLoop'],
  ['跳过本轮', 'inline.continueLoop'],
  ['重跑本轮', 'inline.restartLoop'],
  // 数据表条目行 `条目 <原文>` ⇄ `DATAFORM <原文>`；`原形 <引擎记号>` 是**记号回显**标记
  // （`条目 原形 DATA <原文>` ⇄ `DATA <原文>`）——义项有别的变体不猜，原样带走那枚记号。
  ['条目', 'inline.dataEntry'],
  ['原形', 'inline.engineEcho'],
  // 别名的 `角色 N` 右值形态由 `isAliasCharKeyword` 按上下文判定，
  // **不**在此表登记（否则会覆盖 `head.char`——Map 保留最后一次插入）。
]);

/** 保留代词（规范 §3.8）——`别名` 不得与它们同名（诊断 `alias-name-conflict`） */
export const RESERVED_PRONOUNS: readonly string[] = ['她', '你'];

/** `续`（不等待）标记：中文主形 + 隐藏别名（规范 §3.3） */
export const CONT_MARKS: readonly string[] = ['续', '~', '⏎', 'cont', 'continue'];

/**
 * `空行` 的**等待形**标记（规范 §3.3，v1.5）：空行默认**不等待**（裸 `PRINTFORML`，
 * 对齐语料 20,244 : 10），写了本组标记才落 `PRINTFORMDW`。
 * 判定只由 lexer 的 `空行` 位置式扫描消费（`BLANK_LINE_RE` + 本组）；中文主形 `等待`
 * **另**登记进 `KEYWORDS` 只为词表可见（高亮/补全），英文形 `wait` 不进 `KEYWORDS`
 * （它是引擎指令 `WAIT` 的小写形，不属糖关键字面）。
 */
export const WAIT_MARKS: readonly string[] = ['等待', 'wait'];

/** 查询关键字语义 id（大小写敏感的中文 / 小写英文别名） */
export function lookupKeyword(word: string): KeywordId | undefined {
  return KEYWORDS.get(word);
}

/** 头部声明关键字集合（`角色:` / `口上:` …，行首 `词:` 形态；`开关:` 后跟缩进块） */
export const HEAD_DECL_KEYS: readonly KeywordId[] = [
  'head.char',
  'head.family',
  'head.title',
  'head.desc',
  'head.color',
  'head.playerColor',
  'head.narrationColor',
  'head.switch',
  // 头部选项 `函数前缀:`（B4-fp）——与 `角色:` / `口上:` 同走 `headDecl` 通路（`词: 值`）。
  'head.functionPrefix',
];

/**
 * 别名右值的 `角色 N` 形态判定（规范 §3.1 表）。
 * `角色` 既是头部关键字也是别名右值关键字——按**上下文**（右侧是否 `别名 X =`）区分。
 */
export function isAliasCharKeyword(word: string): boolean {
  return word === '角色' || word === 'char';
}

/* ---------------------- 时机块头的命名参数（规范 §3.2） ---------------------- */

/**
 * `参数:` 命名参数的**规范名**（中文主形）。
 *
 * 语义：声明该时机生成的函数**接收哪些实参令牌**（`ARG` / `ARG:<数字>`）。
 * 动机是引擎实测：**未声明形参的函数被带实参调用时，实参被引擎静默丢弃**
 * （沙盒 `CALL INNER(7,8)` → `INNER` 内 `ARG` 读到 0），所以带 ARG 分派的
 * 调用面必须在函数头声明——见规范 §3.2 / §9。
 */
export const TIMING_ARGS_PARAM = '参数';

/**
 * 时机命名参数的**英文别名 → 中文规范名**。
 *
 * 与块关键字同口径（规范 §4.1「中文主形 + 英文别名」双收，别名只影响**输入**）。
 * 命名参数是**语法层**语义（跨游戏语言层），故别名表住在转译器、不住 adapter。
 * 小写 ASCII 键（与 `KEYWORDS` 的英文别名同一约定）；中文主形不进本表（精确匹配）。
 */
const TIMING_PARAM_ALIASES: ReadonlyMap<string, string> = new Map([
  ['args', TIMING_ARGS_PARAM],
]);

/** 命名参数名归一（英文别名 → 中文规范名；未登记的原样返回，如 `成否` / `类型`） */
export function canonicalTimingParamName(name: string): string {
  return TIMING_PARAM_ALIASES.get(name.toLowerCase()) ?? name;
}

/** `成否:` 命名参数的**规范名**（中文主形；规范 §3.2 命名参数表）。 */
export const TIMING_SUCCESS_PARAM = '成否';

/**
 * 时机命名参数**取值**的派生来源（宿主补全据此前向取候选；**不包括解析器职责**）。
 * - `'successFlag'`：adapter 成否位协议的 `values`（`KojoFaceTable.successFlag.values`，
 *   **契约公开面**——公开才给候选，未公开则只给键、不猜值）；
 * - `'segment'`：adapter 分野模板的上下文段 `segments`（段名见 `segmentName`）；
 * - `'args'`：语言层闭集实参令牌（`ARG` / `ARG:<数字>`；见 `TIMING_ARG_TOKENS`）。
 */
export type TimingParamValueSource = 'successFlag' | 'segment' | 'args';

/**
 * 时机命名参数键条目——规范名 + 隐藏英文别名 + 取值来源。
 * 宿主补全**只认本表**（零硬编码中文键名：键形与取值来源都由这里给）。
 */
export interface TimingNamedParamSpec {
  /** 规范名（中文主形；块头 `X:` 的 X） */
  readonly name: string;
  /** 隐藏英文别名（小写 ASCII；只影响**输入**，不进补全列表——规范 §4.1） */
  readonly alias?: string;
  /** 取值派生来源 */
  readonly valueSource: TimingParamValueSource;
  /** `valueSource === 'segment'` 时：adapter 模板里对应的段名（`KojoFaceTemplate.segments` 的键） */
  readonly segmentName?: string;
}

/**
 * 时机命名参数**键表**（规范 §3.2「命名参数」表）——**单一真源**。
 *
 * 收敛此前散落三处的键集合（同一语义只写一份，避免补全与转译发散）：
 * - `成否`：原为 `codegen.ts` 的字面量（`hasSuccessNamed` / `successFlag`）→ `TIMING_SUCCESS_PARAM`；
 * - `类型`：原经 `segmentParamName('com')` 与段名关联 → 本表 `segmentName: 'com'`；
 * - `参数`（英文别名 `args`）：原为 `TIMING_ARGS_PARAM`。
 *
 * 转译器（`codegen.ts` 的 `segmentParamName` / 成否键字面量）与宿主补全共用本表。
 */
export const TIMING_NAMED_PARAMS: readonly TimingNamedParamSpec[] = [
  { name: TIMING_SUCCESS_PARAM, valueSource: 'successFlag' },
  { name: '类型', valueSource: 'segment', segmentName: 'com' },
  { name: TIMING_ARGS_PARAM, alias: 'args', valueSource: 'args' },
];

/**
 * **实参令牌中文主形**（表层写法，v1.6）：`实参` = 数值视图、`实参$` = 字符串视图；
 * 变长索引用 `:n`（**1 基**，从 1 开始）——`实参:1 ≡ 实参`、`实参$:1 ≡ 实参$`。
 *
 * 与引擎记号（`ARG` / `ARG:<数字>` / `ARGS`）的映射是**单一真源**：
 * - 位置 k（**0 基**）→ 数值视图 `ARG:<k>`（k=0 写作裸 `ARG`）/ 字符串视图 `ARGS:<k>`；
 * - 表层 `实参:n` → `ARG:<n-1>`、`实参$:n` → `ARGS:<n-1>`（n 指实参表位置，1 基）；
 * - 老写法 `ARG` / `ARG:<数字>` / 裸 `ARGS` **继续兼容**，但降级为**隐藏兼容别名**
 *   （既有的 CJK-primary 机制自动让它们不进补全面板）。
 */
export const VARIADIC_ARG_NUMERIC = '实参';
/** `实参$`：不定参数的**字符串视图**关键字（`$` 结尾 = 取字符串槽）。 */
export const VARIADIC_ARG_STRING = '实参$';

/**
 * 位置 k（0 基）+ 视图 → 引擎记号。k=0 归一为**裸** `ARG` / `ARGS`（对齐语料
 * `(ARGS,ARG,ARG:1)` 与既有 `argumentToken` 口径，`ARG:0` 等价于 `ARG`）。
 */
export function argPositionToken(stringView: boolean, k: number): string {
  if (stringView) return k === 0 ? 'ARGS' : `ARGS:${k}`;
  return k === 0 ? 'ARG' : `ARG:${k}`;
}

/**
 * `参数:` 取值令牌（中文主形**或**引擎记号）→ 引擎记号（规范化 `ARG`/`ARG:<数字>`/`ARGS`）。
 * 不认（`FOO` / `实参:0` / `实参$:0` / `ARGS:<数字>` / 空令牌）→ `null`。
 *
 * 注：`ARGS:<数字>` 作为**手写原生令牌**仍非法（规范 §3.2 L271），故本函数只收裸 `ARGS`；
 * 字符串视图的**带索引**形态只开放**中文**写法 `实参$:n`（由转译器规范化为 `ARGS:<n-1>`）。
 */
export function argTokenToEngineToken(tok: string): string | null {
  const t = tok.trim();
  if (t.length === 0) return null;
  if (t === 'ARG' || t === 'ARGS') return t;
  if (/^ARG:\d+$/.test(t)) return t;
  if (t === VARIADIC_ARG_NUMERIC) return 'ARG';
  if (t === VARIADIC_ARG_STRING) return 'ARGS';
  const num = /^实参:(\d+)$/.exec(t);
  if (num) {
    const n = Number(num[1]!);
    return n >= 1 ? argPositionToken(false, n - 1) : null;
  }
  const str = /^实参\$:(\d+)$/.exec(t);
  if (str) {
    const n = Number(str[1]!);
    return n >= 1 ? argPositionToken(true, n - 1) : null;
  }
  return null;
}

/** 引擎记号 → 中文主形（补全/悬停**派生**用；编辑器侧禁硬编码中文形态）。 */
export function argTokenCnLabel(tok: string): string {
  if (tok === 'ARG') return VARIADIC_ARG_NUMERIC;
  if (tok === 'ARGS') return VARIADIC_ARG_STRING;
  const m = /^ARG:(\d+)$/.exec(tok);
  if (m) return `${VARIADIC_ARG_NUMERIC}:${Number(m[1]!) + 1}`;
  return tok;
}

/**
 * `参数:` 取值的**引擎记号**闭集候选（单令牌；逗号分隔的**多值拼接不做**——补全不是解析器）。
 * 覆盖规范 §3.2 的三形态：裸 `ARG`、带索引 `ARG:<数字>`、**裸 `ARGS`**（整组实参记号）。
 * 补全面板据 {@link argTokenCnLabel} **派生中文主形**展示（编辑器侧零硬编码）。
 */
export const TIMING_ARG_TOKENS: readonly string[] = ['ARG', 'ARG:1', 'ARGS'];

/* --------------------------- 运算符降糖（规范 §4.3） --------------------------- */

/**
 * 中文运算符 → ERB 运算符。
 *
 * 注意匹配顺序：**长词优先**（`不等于` 先于 `等于`），否则 `不等于` 会被
 * 解析成 `不` + `等于`（错误的 `! =`）。表按长度降序，调用方逐个尝试
 * （`.sort()` 稳定 ⇒ 同长度保持本字面量的书写序，新增词形别插在中间打乱既有相对序）。
 *
 * 逻辑字面量与逻辑词（`真` / `假` / `空` / `异或`）与 `且` / `或` / `非` **同一条通路**：
 * 中文主形在本表降糖，ASCII 引擎记号（`true` / `false` / `null` / `XOR`）走
 * `expression.ts::isErbKeyword` 的**原样放行**通道——这就是"双收"的两侧
 * （别名只影响**输入**，产物恒是引擎记号）。区间词 `到` 不入本表：它是**结构级**词形，
 * 只在 `X 不在 a 到 b`（`expression.ts::lowerNotIn` 位置消费）与 `是 a 到 b`
 * （lexer/parser 的 `parseCaseValues` 拆档）两处由各自通路接住；块档产物落引擎
 * 记号 ` TO `（codegen `renderCaseValues`），与 `不在` 同一口径（都在本表之外）。
 */
const OPERATORS: ReadonlyArray<readonly [string, string]> = (
  [
    ['不等于', '!='],
    ['异或', 'XOR'],
    ['等于', '=='],
    ['超过', '>'],
    ['至少', '>='],
    ['不足', '<'],
    ['至多', '<='],
    ['且', '&&'],
    ['或', '||'],
    ['非', '!'],
    ['真', 'true'],
    ['假', 'false'],
    ['空', 'null'],
  ] as ReadonlyArray<readonly [string, string]>
).slice().sort((a, b) => b[0].length - a[0].length);

/** 中文运算符表（已按长度降序；`不在` 由条件降糖单独处理——见 `notin`） */
export function operatorTable(): ReadonlyArray<readonly [string, string]> {
  return OPERATORS;
}

/** `不在` 关键字（规范 §3.5：`X 不在 a 到 b` → `!(X >= a && X <= b)`） */
export const NOTIN_KEYWORDS: readonly string[] = ['不在', 'notin'];

/** 全角冒号（块头终止符，规范 §5.3） */
export const FULLWIDTH_COLON = '：';

/**
 * 块收束词尾（`循环结束` / `出错处理结束` / `数据表结束` = `<块头词> + 本串`）。
 *
 * 登记进 `KEYWORDS` 的收束词形**必须**等于「开块词 + 本串」——这条恒等式由
 * `tests/control-word-single-source.test.ts` 逐族钉住（显示层与写层各拼一份就必然分叉）。
 */
export const BLOCK_END_SUFFIX = '结束';

/** 半角冒号（头部声明的等价终止符；作者可能写 `角色: 12`） */
export const HALF_COLON = ':';

/** 全角空格（规范 §8：全角标点/空格检测） */
export const FULLWIDTH_SPACE = '\u3000';

/** 判断一行是否以「块头终止符」结尾（全角 `：` 或半角 `:`） */
export function endsWithBlockColon(trimmed: string): boolean {
  return trimmed.endsWith(FULLWIDTH_COLON) || trimmed.endsWith(HALF_COLON);
}

/** 去掉行尾的块头终止符（全角/半角各一个） */
export function stripBlockColon(trimmed: string): string {
  if (trimmed.endsWith(FULLWIDTH_COLON)) return trimmed.slice(0, -1);
  if (trimmed.endsWith(HALF_COLON)) return trimmed.slice(0, -1);
  return trimmed;
}

/* ============================ 编辑器词表（S6 批） ============================ */

/**
 * 词表角色（高亮分组 / 补全分类；对应规范 §4.1 与附录 A 的四个语义组）。
 * 与 `KeywordId` 的 `head.` / `block.` / `inline.` / `alias.` 前缀一一映射。
 */
export type SugarKeywordRole = 'head' | 'block' | 'inline' | 'value';

/** 词表角色 → 面向作者的中文标签（补全 detail 用） */
export const SUGAR_KEYWORD_ROLE_LABEL: Readonly<Record<SugarKeywordRole, string>> = {
  head: '头部声明',
  block: '块关键字',
  inline: '行内关键字',
  value: '别名右值',
};

/** 单个词表条目：词形 + 规范语义 id + 角色 + 是否中文主形 */
export interface SugarLexiconWord {
  readonly word: string;
  readonly id: KeywordId;
  readonly role: SugarKeywordRole;
  /** true = 中文主形（补全默认展示）；false = 英文隐藏别名（输入生效但不展示，规范 §4.1） */
  readonly primary: boolean;
}

function roleOf(id: KeywordId): SugarKeywordRole {
  if (id.startsWith('head.')) return 'head';
  if (id.startsWith('inline.')) return 'inline';
  if (id.startsWith('alias.')) return 'value';
  return 'block';
}

/** 是否含 CJK（中文主形判定；英文别名一律 ASCII 小写，规范 §4.1） */
const CJK = /[\u3040-\u30ff\u4e00-\u9fff\uff66-\uff9f]/;

/**
 * 编辑器词表（**单一真源**）——由转译器自身的 `KEYWORDS` 表派生，故高亮/补全
 * 与词法**永不脱节**（规范 §4.1 的"中英双收"在此天然成立）。
 *
 * 消费者：app 壳的 Monaco Monarch 高亮 + 补全 provider（宿主层，不属任何插件）。
 * 之所以从这里导出而不是各写一份：词表是跨游戏语言层，重复维护必然发散。
 */
export const SUGAR_LEXICON_WORDS: readonly SugarLexiconWord[] = [...KEYWORDS.entries()].map(
  ([word, id]): SugarLexiconWord => ({ word, id, role: roleOf(id), primary: CJK.test(word) }),
);

/** 中文主形（`id` → 词形；显示层与写层共用这一份查询，禁第二张投影表） */
const PRIMARY_BY_ID: ReadonlyMap<KeywordId, string> = new Map(
  SUGAR_LEXICON_WORDS.filter((w) => w.primary).map((w) => [w.id, w.word] as const),
);

/**
 * 取中文主形。缺词形 = 词表缺陷 ⇒ 把 `id` 原样交回调用方显示（fail-visible），
 * 绝不兜一个假词——静默造词正是"写得出来读不回来"那类事故的源头。
 */
export function primaryWord(id: KeywordId): string {
  return PRIMARY_BY_ID.get(id) ?? id;
}

/** 收束词形（`循环` → `循环结束`）；词尾只有 `BLOCK_END_SUFFIX` 一份，两侧同函数派生 */
export function blockEndWord(openId: KeywordId): string {
  return `${primaryWord(openId)}${BLOCK_END_SUFFIX}`;
}

/** 中文运算符词形（规范 §4.3；不含 `不在`——它由条件降糖单独处理） */
export const SUGAR_LEXICON_OPERATORS: readonly string[] = OPERATORS.map(([zh]) => zh);

/** 编辑器词表聚合（一次性便捷入口；纯数据，无副作用） */
export interface SugarEditorLexicon {
  readonly words: readonly SugarLexiconWord[];
  readonly operators: readonly string[];
  readonly contMarks: readonly string[];
  readonly reservedPronouns: readonly string[];
  readonly notin: readonly string[];
}

export function sugarEditorLexicon(): SugarEditorLexicon {
  return {
    words: SUGAR_LEXICON_WORDS,
    operators: SUGAR_LEXICON_OPERATORS,
    contMarks: CONT_MARKS,
    reservedPronouns: RESERVED_PRONOUNS,
    notin: NOTIN_KEYWORDS,
  };
}
