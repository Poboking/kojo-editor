; tree-sitter indents for .kojo
;
; 同上：行式语法不产出跨行块容器（`block_body` 不存在，缩进 offside 规则需 scanner.c）。
; tree-sitter 的 indent/dedent 查询依赖节点对之间的边界，本批无语义可用的多行节点，
; 故留合法空查询。进入块体缩进一档由宿主编辑器的行首缩进真源（kojo 文件本身的缩进）驱动。
;
; 将来若加入 scanner.c 产出 `block_body`，在此补 `(block_body) @indent.begin`。
