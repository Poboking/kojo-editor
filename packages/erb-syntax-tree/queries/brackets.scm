; ERB 结构括号（块配对 + 表达式括号）。
;
; ## 两种"括号"分清楚
;
; 1. **块配对**（行级）：开块 / 分支 / 收束三类行节点由语法层的配对表决定，本查询按字段
;    捕获它们（`open` / `branch` / `close`），一个配对类别一枚 `*_block`。这是"跳一对"
;    / 折叠 / 缩进共用的结构事实。
; 2. **表达式括号**（行内）：语法层只建模 `{…}`（`form_interpolation`）与 `%…%`
;    （`form_substitution`）两枚 FORM 记号；**ASCII 的 `(` `)` 与散落的 `[` `]` / `{` `}`
;    没有子节点**（`brace_literal` 只表示"一枚散括号"），故这里不假装能配对它们——
;    作者面的敲入配对/着色由 `erb-language.ts` 的语言配置（`brackets` /
;    `colorizedBracketPairs` / `autoClosingPairs`）负责，两处判据别混。
;
; `[SKIPSTART]` / `[SKIPEND]` 与 `[IF_DEBUG]` 一类**条件跳过标签**同为行级结构：前者是
; `skip_start` / `skip_end`（strict 等值判据在 scanner.ts），后者落 `bracket_line`。
; 引擎不按本查询着色（标签着色走 highlights.scm），本文件供结构对照/工具与测试使用。
;
; 覆盖类别与 `src/structure.json` 的 `controlFlow.pairs` 一一对应；新增配对没进这里 ⇒
; `tests/projection-single-source.test.ts` 的清单对账判红。

; ── 块配对 ──────────────────────────────────────────────────────────────
(list_block open: (datalist_line) @bracket.open)
(list_block close: (endlist_line) @bracket.close)
(do_block open: (do_line) @bracket.open)
(do_block close: (loop_line) @bracket.close)
(for_block open: (for_line) @bracket.open)
(for_block close: (next_line) @bracket.close)
(if_block open: (if_line) @bracket.open)
(if_block close: (endif_line) @bracket.close)
(noskip_block open: (noskip_line) @bracket.open)
(noskip_block close: (endnoskip_line) @bracket.close)
(data_block open: (printdata_line) @bracket.open)
(data_block open: (printdatad_line) @bracket.open)
(data_block open: (printdatadl_line) @bracket.open)
(data_block open: (printdatadw_line) @bracket.open)
(data_block open: (printdatak_line) @bracket.open)
(data_block open: (printdatakl_line) @bracket.open)
(data_block open: (printdatakw_line) @bracket.open)
(data_block open: (printdatal_line) @bracket.open)
(data_block open: (printdataw_line) @bracket.open)
(data_block open: (strdata_line) @bracket.open)
(data_block close: (enddata_line) @bracket.close)
(repeat_block open: (repeat_line) @bracket.open)
(repeat_block close: (rend_line) @bracket.close)
(select_block open: (selectcase_line) @bracket.open)
(select_block close: (endselect_line) @bracket.close)
(funclist_block open: (trycalllist_line) @bracket.open)
(funclist_block open: (trygotolist_line) @bracket.open)
(funclist_block open: (tryjumplist_line) @bracket.open)
(funclist_block close: (endfunc_line) @bracket.close)
(try_block open: (tryccall_line) @bracket.open)
(try_block open: (tryccallform_line) @bracket.open)
(try_block open: (trycgoto_line) @bracket.open)
(try_block open: (trycgotoform_line) @bracket.open)
(try_block open: (trycjump_line) @bracket.open)
(try_block open: (trycjumpform_line) @bracket.open)
(try_block close: (endcatch_line) @bracket.close)
(while_block open: (while_line) @bracket.open)
(while_block close: (wend_line) @bracket.close)

; 分支行：既收上一段、又开下一段（跳转目标两侧都算）
(branch_block branch: (else_line) @bracket.branch)
(branch_block branch: (elseif_line) @bracket.branch)
(branch_block branch: (case_line) @bracket.branch)
(branch_block branch: (caseelse_line) @bracket.branch)
(branch_block branch: (catch_line) @bracket.branch)

; ── 表达式括号（FORM 记号） ─────────────────────────────────────────────
(form_interpolation) @bracket.expression
(form_substitution) @bracket.expression

; ── 行级标签 ────────────────────────────────────────────────────────────
(bracket_line) @bracket.tag
(skip_start) @bracket.tag
(skip_end) @bracket.tag
