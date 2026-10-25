; Kojo 2.0 高亮（queries/v2/highlights.scm）
;
; 捕获名全部走 tree-sitter 官方命名约定（`@keyword.*` / `@string*` / `@comment` /
; `@function*` / `@variable` / `@number` / `@operator` / `@punctuation.*` / `@embedded` /
; `@none`），宿主侧一套色板即可同时吃 tree-sitter 与 Monarch 两路。
;
; 档位设计（"提示分档"落在 `@string.special` 与 `@keyword.operator` 两档）：
;   * 叙事文本 = `@string`；旁白锚点 `>` = `@punctuation.special`；
;   * 插值 `{…}` = `@string.special`（内含三元/表达式不拆，语义层再涂）；
;   * 行尾表演提示 `(…)` = `@string.special`（已知提示 vs 导演批注的分档属于 adapter
;     presentation，不在语言层硬编码任何游戏名词）；行尾 `续` = `@keyword.operator`；
;   * 行首锚点整行上色（与 v1 同口径：语言层只认"这一行是哪一档"）。

; ---- 整行注释 / 空行 ----
(comment) @comment
(blank_line) @none

; ---- `#` 声明：幕 / 视 / 机 / 方言 / 变量 / 常量（单行）与 表 / 池 / 模（块头）----
; 九枚词位一枚不少：`# 方言` 虽只做事后断言、不赋值，但它同样是"整行声明"档，
; 漏一枚的表现就是那一行完全不上色（v2 曾漏 `dialect_decl`，见 tests/v2-queries.test.ts 覆盖闸）。
(scene_decl) @keyword
(view_decl) @keyword
(event_decl) @keyword
(dialect_decl) @keyword
(variable_decl) @keyword
(constant_decl) @keyword
(table_head) @keyword
(pool_head) @keyword
(template_head) @keyword

; ---- `@` 调度 ----
(calc_head) @keyword.control
(color_head) @keyword.control
(random_head) @keyword.control
(group_head) @keyword.control
(while_head) @keyword.control
(foreach_head) @keyword.control
(repeat_head) @keyword.control
(weave_head) @keyword.control
(function_head) @keyword.function
(return_stmt) @keyword.control
(break_stmt) @keyword.control
(continue_stmt) @keyword.control
(label_stmt) @label
(jump_stmt) @keyword.control
(face_command) @keyword
(native_head) @keyword.directive

; ---- `?` 条件链 / `!` 触发 ----
(condition_head) @keyword.control
(else_head) @keyword.control
(trigger) @function.call

; ---- 叙事：旁白 / 台词 / 池内无符号台词 ----
(narration_marker) @punctuation.special
(narration_text) @string
(speaker) @variable
(speech_string) @string
(interpolation) @string.special
(presentation_hint) @string.special
(continue_mark) @keyword.operator

; ---- `# 模` 的插槽标记 ----
(slot_marker) @keyword

; ---- 调度区裸写 ----
(assignment) @operator
(call_line) @function.call

; ---- `# 表` 行：范围 / 默认分支 / 值列 ----
(table_range) @number
(table_else) @keyword
(table_value) @string

; ---- `@原生` raw 行：整行内嵌 ERB，不参与 2.0 高亮分层 ----
(native_line) @embedded
