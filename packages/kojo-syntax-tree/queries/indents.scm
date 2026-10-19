; tree-sitter indents for .kojo
;
; 第二波起本语法**有**块容器（`block` / `item_block` + `block_body`，由 `src/scanner.c`
; 的缩进记号按 offside 规则配对），但这一面本批仍**不给捕获**，理由两条：
;
; 1. 回车层级与增加/减少缩进今天已由词表派生一套在跑（`sugarEnterRulePatterns()` 进
;    Monaco 的 `onEnterRules` / `indentationRules`）。结构层要加得是**加法**，而
;    `(block) @indent.increase` 取的是节点首行文本——块头行正文任意（含 `(`/`[`/冒号），
;    宿主把它转成"整行精确匹配"的锚定正则时要么撞上非法正则、要么只能逐字匹配那一行，
;    两条都不是可用的规则。
; 2. 宿主对"查询里没有任何 `@indent.*` 捕获"的处理是**停用这一面并回落既有供给器**
;    （见 worker 的 compileQueries），语义正好是"结构层没话说"，不留半成品规则。
;
; 将来要把这一面交给结构层，形态应当是"块头 kind → 档位"的表（而不是行文本正则），
; 那是缩进线自己的批次，不在本批范围内。
