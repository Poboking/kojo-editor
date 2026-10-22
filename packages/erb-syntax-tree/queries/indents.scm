; ERB 结构缩进（`@indent.begin` / `@indent.end` / `@indent.enter`）。
;
; ## 契约
;
; worker 侧 `engine.ts::indentRulesFrom` 认三档捕获：
;   · `@indent.increase`（同义写法 `@indent.begin`）⇒ `indentationRules.increaseIndentPattern`
;   · `@indent.decrease`（同义写法 `@indent.end`）   ⇒ `indentationRules.decreaseIndentPattern`
;   · `@indent.enter`                                 ⇒ `onEnterRules` 的 Indent 动作
; 本文件用 begin/end 命名（与 tree-sitter 社区惯例一致），引擎两种写法都认，旧查询不必改。
;
; ## 为什么捕获的是**块字段**而不是整行文本
;
; 本语法的控制流语句是**整行不透明 token**（`IF A AND B` 不拆表达式，见 grammar.js 头注）。
; 引擎默认把捕获节点的首行原文转成"整行精确匹配"的锚定正则——那对 ERB 只会得到
; `^IF A AND B$` 这种一次性规则（下一份文档就失效，且每改一个条件就换一条）。
; 所以 ERB 的 worker 入口给引擎注入了 `indentPattern` 派生器（`erb-indent-patterns.ts`），
; 按节点类型（`if_line`）取**关键字**做行首锚：`^\s*(?:IF)(?![A-Za-z_])`，
; 与 `erb-enter.ts` 从配对表派生的基底规则同一判据、同一稳定形状。
;
; ## 覆盖面
;
; 每个配对类别（`src/structure.json` 的 `controlFlow.pairs`）各出：
;   开块行 → begin；分支行 → begin + end（兄弟同层、正文更深）；收束行 → end；
; 单行形 `SIF`（role = leaf，没有收束词）→ enter（只抬下一行）。
; 新增配对类别而没进这里 ⇒ `tests/projection-single-source.test.ts` 的清单对账会判红。
;
; 本文件只描述**块角色**，不描述"这一行文本匹配什么"——那是引擎 + 宿主派生层的事。

; ── 开块 ────────────────────────────────────────────────────────────────
(list_block open: (datalist_line) @indent.begin)
(do_block open: (do_line) @indent.begin)
(for_block open: (for_line) @indent.begin)
(if_block open: (if_line) @indent.begin)
(noskip_block open: (noskip_line) @indent.begin)
(data_block open: (printdata_line) @indent.begin)
(data_block open: (printdatad_line) @indent.begin)
(data_block open: (printdatadl_line) @indent.begin)
(data_block open: (printdatadw_line) @indent.begin)
(data_block open: (printdatak_line) @indent.begin)
(data_block open: (printdatakl_line) @indent.begin)
(data_block open: (printdatakw_line) @indent.begin)
(data_block open: (printdatal_line) @indent.begin)
(data_block open: (printdataw_line) @indent.begin)
(data_block open: (strdata_line) @indent.begin)
(repeat_block open: (repeat_line) @indent.begin)
(select_block open: (selectcase_line) @indent.begin)
(funclist_block open: (trycalllist_line) @indent.begin)
(funclist_block open: (trygotolist_line) @indent.begin)
(funclist_block open: (tryjumplist_line) @indent.begin)
(try_block open: (tryccall_line) @indent.begin)
(try_block open: (tryccallform_line) @indent.begin)
(try_block open: (trycgoto_line) @indent.begin)
(try_block open: (trycgotoform_line) @indent.begin)
(try_block open: (trycjump_line) @indent.begin)
(try_block open: (trycjumpform_line) @indent.begin)
(while_block open: (while_line) @indent.begin)

; ── 分支（兄弟行回到父层 ⇒ 既 begin 又 end） ────────────────────────────
(branch_block branch: (else_line) @indent.begin)
(branch_block branch: (else_line) @indent.end)
(branch_block branch: (elseif_line) @indent.begin)
(branch_block branch: (elseif_line) @indent.end)
(branch_block branch: (case_line) @indent.begin)
(branch_block branch: (case_line) @indent.end)
(branch_block branch: (caseelse_line) @indent.begin)
(branch_block branch: (caseelse_line) @indent.end)
(branch_block branch: (catch_line) @indent.begin)
(branch_block branch: (catch_line) @indent.end)

; ── 收束 ────────────────────────────────────────────────────────────────
(list_block close: (endlist_line) @indent.end)
(do_block close: (loop_line) @indent.end)
(for_block close: (next_line) @indent.end)
(if_block close: (endif_line) @indent.end)
(noskip_block close: (endnoskip_line) @indent.end)
(data_block close: (enddata_line) @indent.end)
(repeat_block close: (rend_line) @indent.end)
(select_block close: (endselect_line) @indent.end)
(funclist_block close: (endfunc_line) @indent.end)
(try_block close: (endcatch_line) @indent.end)
(while_block close: (wend_line) @indent.end)

; ── 单行形：只抬下一行 ──────────────────────────────────────────────────
(sif_line) @indent.enter
