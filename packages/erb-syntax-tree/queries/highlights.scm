; ERB 结构语法的**语义着色**查询（宿主 `erb-semantic.ts` 的 token 面唯一来源）。
;
; ## 捕获名 → 档位
;
; 映射表在宿主 `erb-semantic.ts`（`ERB_SEMANTIC_CAPTURE_TIERS`）——查询只说"这段是什么
; 结构"，"该涂哪一档"是表现层决定。两类档位分开：
;
; - **与词法层同名的档**（`comment` / `string` / `label` / `keyword.preprocessor` /
;   `entity.name.function` / `sugar.interp`）：屏上与 Monarch 同色，语义层只是换了判据
;   （从"看形状"换成"看 CST"），A/B 比的是判据不是调色板；
; - **结构层独有的档**（`keyword.erb`）：控制流语句是**整行不透明 token**（grammar.js 头注：
;   `IF A AND B` 不拆表达式），整行能给的语义就是"这一行是引擎控制骨架"。条件里的变量 /
;   串不再单分——这是本语法的建模口径，不是漏色；它默认关着（结构层总开关），
;   开着时 A/B 能看见"整行按结构判定"与"逐词按形状判定"的差。
;
; `statement_line`（兜底语句 / 文本行）**故意不挂捕获**：结构层对它没有比词法层更多的
; 判断，涂一档只会把词法层已经分好的变量 / 数字 / 运算符糊平。
;
; ## 覆盖
;
; 行族：注释、`#` 指令、`#DIM` 族、`$` 标签、`[` 标签行、`@"…"` 串、引号串、FORM 插值
; （`{…}` / `%…%`）、停用区标记与体内原文、全部控制流行、`@` 函数头名字。
; 新增控制词由 `src/structure.json` 投影决定，重跑 grammar 后本文件按同一份清单补行
; （清单对账见 `tests/projection-single-source.test.ts` 的查询覆盖用例）。

(comment_line) @comment
(comment_inline) @comment

(directive_line) @keyword.directive
(dim_directive) @keyword.directive

(label_line) @label
(bracket_line) @tag

; `@NAME` 头：只给名字上函数档（`@` 与形参余文留在词法层）
(function_head (function_name) @function)

; 停用区：标记 = 标签档，体内原文 = 不透明整块（与 `.kojo` 原生围栏同档意图）
(skip_start) @tag
(skip_end) @tag
(skip_body) @raw

; 串与 FORM 两层
(at_string) @string
(string) @string
(form_interpolation) @string.special
(form_substitution) @string.special

; 控制流行（整行不透明；清单与 projection 同步）
(case_line) @keyword.control
(caseelse_line) @keyword.control
(catch_line) @keyword.control
(datalist_line) @keyword.control
(do_line) @keyword.control
(else_line) @keyword.control
(elseif_line) @keyword.control
(endcatch_line) @keyword.control
(enddata_line) @keyword.control
(endfunc_line) @keyword.control
(endif_line) @keyword.control
(endlist_line) @keyword.control
(endnoskip_line) @keyword.control
(endselect_line) @keyword.control
(for_line) @keyword.control
(if_line) @keyword.control
(loop_line) @keyword.control
(next_line) @keyword.control
(noskip_line) @keyword.control
(printdata_line) @keyword.control
(printdatad_line) @keyword.control
(printdatadl_line) @keyword.control
(printdatadw_line) @keyword.control
(printdatak_line) @keyword.control
(printdatakl_line) @keyword.control
(printdatakw_line) @keyword.control
(printdatal_line) @keyword.control
(printdataw_line) @keyword.control
(rend_line) @keyword.control
(repeat_line) @keyword.control
(selectcase_line) @keyword.control
(sif_line) @keyword.control
(strdata_line) @keyword.control
(trycalllist_line) @keyword.control
(tryccall_line) @keyword.control
(tryccallform_line) @keyword.control
(trycgoto_line) @keyword.control
(trycgotoform_line) @keyword.control
(trycjump_line) @keyword.control
(trycjumpform_line) @keyword.control
(trygotolist_line) @keyword.control
(tryjumplist_line) @keyword.control
(wend_line) @keyword.control
(while_line) @keyword.control
