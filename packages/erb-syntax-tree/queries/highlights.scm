; ERB 结构语法的高亮查询——**只供本地调试/对照**，不是 semantic tokens 的来源。
;
; 本包不承诺宿主涂色规则：节点即整行，控制流表达式是整行不透明 token；
; 正式上屏颜色应由宿主（或后续语言注册表）决定。这里只把"结构分型"映到常见捕获名，
; 便于在 tree-sitter 调试器里看出行族，别把这张表当产品契约。

(comment_line) @comment
(comment_inline) @comment
(directive_line) @keyword.directive
(dim_directive) @keyword.directive
(label_line) @label
(bracket_line) @keyword.control
(function_head) @function
(parameter) @variable.parameter
(string) @string
(form_interpolation) @string.special
(form_substitution) @string.special
(statement_line) @none

(if_line) @keyword.control
(elseif_line) @keyword.control
(else_line) @keyword.control
(endif_line) @keyword.control
(selectcase_line) @keyword.control
(case_line) @keyword.control
(caseelse_line) @keyword.control
(endselect_line) @keyword.control
(for_line) @keyword.control
(next_line) @keyword.control
(while_line) @keyword.control
(wend_line) @keyword.control
(repeat_line) @keyword.control
(rend_line) @keyword.control
(do_line) @keyword.control
(loop_line) @keyword.control
(data_block) @keyword.control
(datalist_line) @keyword.control
(endlist_line) @keyword.control
(strdata_line) @keyword.control
(enddata_line) @keyword.control
(noskip_line) @keyword.control
(endnoskip_line) @keyword.control
(catch_line) @keyword.control
(endcatch_line) @keyword.control
(endfunc_line) @keyword.control
(sif_line) @keyword.control
