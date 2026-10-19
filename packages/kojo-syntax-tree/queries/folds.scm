; tree-sitter folds for .kojo —— 折叠区间的**结构层**来源。
;
; 宿主约定（`packages/app/src/monaco/tree-sitter/`）：取 `@fold` 捕获节点的
; `startPosition.row .. endPosition.row`。本语法第二波起有真的块嵌套：
;   · `block`      = 块头行 → 收束行（三族）或体末行（其余族，靠回缩收盘；
;                    `@函数名` 一族靠 `src/scanner.c` 的 `_raw_close` 前瞻收盘，
;                    范围 = 到下一条 `@` 行或文件尾，与转译器 `readRawFunctionBlock` 同判据）
;   · `item_block` = 选项/询问/菜单条目自带的正文块（条目行 → 体末行）
; 两者的行跨度都由 `src/scanner.c` 的缩进记号精确界定：
; `_dedent` 只跨到换行**之前** ⇒ 块节点不会多吃下一行；块起点是块头记号的起点 ⇒ 不会少给块头行。
;
; 空体块头（真实语料 67 处 `时机 …：` 光杆）不产 `block` 节点（它落回单行节点）——
; 没有正文就没有可折的行跨度，这是"折叠区间存在 ⇔ 真的有可隐藏的行"的同一口径。
; 单行 `@` 区（下一条就是 `@` 行、或 `@` 行即文件末行）同理：行跨度为零 ⇒ `@fold` 捕获到了
; 也被下面的 `endRow > startRow` 判据滤掉，不产折叠。
; 无捕获的模式（如裸 `(block)`）在 tree-sitter 查询里不回传节点，故这里一律带 `@fold`。

(block) @fold
(item_block) @fold
