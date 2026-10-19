; tree-sitter highlights for .kojo —— 语法层逐行节点 → 语义档位（供与 Monarch 对照）。
; 词表全部为语言词（零游戏名词）。节点即整行，捕获给整行上色；档位名对齐 tree-sitter 官方
; highlight 命名约定（@keyword.* / @string / @comment / @function / @type / @label / @number …），
; 便于宿主侧一套 token 色板同时吃 tree-sitter 与 Monarch 两路。
;
; **本波刻意不给 `(native_string)` / `(comment_inline)` 加捕获**——两枚节点在 CST 里已经产出
; （真实语料实测 native_string 711 枚 / comment_inline 10 枚，供语法错误诊断与后续着色分层取用），
; 但一旦进高亮就把与 Monarch 的逐格 A/B 打穿（同一 19 文件 / `packages/app/tests/
; kojo-ts-vs-monarch-ab.test.ts` 实测：两支都加 = 96.70%，只加 native_string = 99.34%，
; 两支都不加 = 99.58% = 第一波基线）。掉点的成因是宿主档位表把 `@string` 映到 `sugar.speech`、
; `@comment` 映到 `comment`，于是原生串里的 `@"…"` 与行尾注释在两侧各归各层——那是**档位表**的口径问题，
; 不该由语法层在高亮查询里单方面解决。归口给词表/档位线（TSIT2-B 与其后续）。


; ---- 注释：整行注释 与 结构化行的行尾注释（后者是本行节点的子节点，不夺本行分型）----
(comment_line) @comment

; ---- 台词 / 插值 / 原生字符串 ----
; TSIT5 说明（只加注释，捕获名与顺序一条没动）：`string` 已不是原子记号，行内 `{…}` 现在是真的
; 子节点、节点名仍是 `interpolation` ⇒ 下面这两支捕获**零改动就同时覆盖**"行首整行 `{…}`"与
; "台词行内 `{…}`"两种出处（28 份语料实测行内 27 枚）。宿主侧登记与重叠优先级不归本查询管：
; 父 `string` 的跨度先落位，内层跨度要生效得由宿主让"更窄的那一枚"赢（实测见
; `packages/app/tests/kojo-ts-ab-attribution.test.ts` 的取证用例）。
(string) @string
(interpolation) @string.special

; ---- 原生直通（全大写 ERB 指令行 / `#DIM` 族预处理）、原生函数块、成对停用块标记行 ----
; `skip_start` / `skip_end` 是投影生成的节点名：上游再加等值标记时这里少一行只是少一格着色
; （对照闸会以 kind 点名，不会静默改判）。`@keyword.directive` 在宿主档位表外 = 不涂色，
; 与 `native_line` 同等待遇（见本文件头注）。
(native_line) @keyword.directive
(raw_block_start) @keyword.directive
(skip_start) @keyword.directive
(skip_end) @keyword.directive

; ---- 文件头 / 别名 / 常量 / 开关条目 / 随机形选项 ----
(head_decl) @keyword.head
(alias_decl) @keyword.head
(const_decl) @keyword.head
(random_shape_decl) @keyword.head
(switch_item) @property

; ---- 标签 ----
(label_decl) @label

; ---- 函数 / 时机 / 自定指令（声明性块头）----
(function_head) @function
(timing_head) @type
(custom_command_head) @function

; ---- 控制流块头（条件 / 选择 / 循环 / 数据 / 问答 / 演出）----
(single_if_head) @keyword.control
(if_head) @keyword.control
(when_head) @keyword.control
(case_head) @keyword.control
(arrow_case) @keyword.control
(arrow_else) @keyword.control
(random_head) @keyword.control
(random_inline) @keyword.control
(group_head) @keyword.control
(branch_head) @keyword.control
(rule_tag) @keyword.control
(section_head) @keyword.control
(once_head) @keyword.control
(loop_head) @keyword.control
(loop_end) @keyword.control
(loop_flow) @keyword.control
(loop_step) @keyword.control
(jump_statement) @keyword.control
(function_jump) @keyword.control
(catch_head) @keyword.control
(catch_end) @keyword.control
(choice_head) @keyword.control
(menu_head) @keyword.control
(choice_item) @keyword.control
(ask_m_head) @keyword.control
(ask_yn_head) @keyword.control
(data_head) @keyword.control
(data_end) @keyword.control
(data_entry) @keyword.control
; TRY 系写形（`试探 原形 <记号> <原文>`）：`@keyword.control` 在宿主档位表外 = 不涂色，
; 与同族其余控制行一样只作结构分型（A/B 分母不因此改变，见本文件头注）。
(try_statement) @keyword.control

; ---- 演出 / 着色 / 心形 / 消息检查 ----
(color_head) @keyword
(heart_head) @keyword
(heart_text) @keyword
(message_check) @keyword

; ---- 语句：调用 / 返回 / 结算 / 增减 / 位调用 / 赋值 ----
(call_statement) @function.call
(return_statement) @keyword.control
(settle) @operator
(mutator) @operator
(statement_call) @function.call
(assign) @operator

; ---- 空行语句 / 残缺控制写法 ----
(blank_line_cmd) @keyword
(control_malformed) @error

; ---- 兜底正文（旁白 / 台词裸文本）----
(text_line) @none
(blank_line) @none
