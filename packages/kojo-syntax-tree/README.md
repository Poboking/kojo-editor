# @kojo/kojo-syntax-tree

`.kojo` 表层 DSL 的 tree-sitter 语法层：生成 CST，供宿主侧高亮 / 折叠 / 缩进 / 语法错误恢复；节点名与 `kojo-sugar` 的 `classifyLine` 逐行对照（见 `src/node-types.ts`）。语言层，零游戏名词。
