# @kojo/kojo-syntax-tree

`.kojo` 表层 DSL 的 tree-sitter 语法层：生成 CST，供宿主侧高亮 / 折叠 / 缩进 / 语法错误恢复；节点名与 `kojo-sugar` 的 `classifyLine` 逐行对照（见 `src/node-types.ts`）。语言层，零游戏名词。

词形**单一真源**：`grammar.js` 零词形字面量，全部取自 **生成文件** `src/word-forms.json`
（由 `tools/gen-word-forms.mjs` 从 `kojo-sugar` 的 `keywords.ts` / `statement-functions.ts` 构建期投影，
禁手改）。本包 `build` 链 = `gen-word-forms → tree-sitter generate → wasm`；上游登记新词形后重跑 build 即同步，
漂移由 `tests/word-forms-single-source.test.ts` 判红。
