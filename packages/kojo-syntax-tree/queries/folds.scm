; tree-sitter folds for .kojo
;
; 本语法是**行式**（每行一个原子 token），不产出跨行的块容器节点（`block`/`block_body`
; 需要缩进 offside 的外部扫描器 scanner.c，本批未引入）。因此 tree-sitter 层**没有可折叠的
; 多行节点**——按块折叠由宿主（Monarch / 编辑器 outline）依缩进真源另行提供。
;
; 本文件保留为合法的空查询（仅注释），避免引用不存在的节点导致查询编译失败。
; 若将来加入 scanner.c 产出 `block` 容器，则在此补 `(block) @fold` 即可。
