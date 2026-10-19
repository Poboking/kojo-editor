; tree-sitter highlights for .kojo —— 语法层逐行节点 → 语义档位（供与 Monarch 对照）。
; 词表全部为语言词（零游戏名词）。节点即整行，捕获给整行上色；档位名对齐 tree-sitter 官方
; highlight 命名约定（@keyword.* / @string / @comment / @function / @type / @label / @number …），
; 便于宿主侧一套 token 色板同时吃 tree-sitter 与 Monarch 两路。

; ---- 注释 ----
(comment_line) @comment

; ---- 台词 / 插值 / 原生字符串 ----
(string) @string
(interpolation) @string.special

; ---- 原生直通（全大写 ERB 指令行）与原生函数块 ----
(native_line) @keyword.directive
(raw_block_start) @keyword.directive

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
