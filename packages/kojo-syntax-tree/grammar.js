/**
 * kojo 表层 DSL 的 tree-sitter 语法（语法层第二真源）。
 *
 * 规则名须与 `src/node-types.ts` 的 KIND_TO_NODE 值逐一对齐——两侧同改。
 * 本文件禁出现游戏名词（审计 A 扫描 src；grammar.js 由纪律 + 对照闸守）。
 *
 * 优先级顺序照抄 `kojo-sugar` 的 `classifyLine`（行首分派：原生直通 → 头部/别名
 * → 块头 → 表达式头 → 赋值 → 文本）。
 */
module.exports = grammar({
  name: 'kojo',

  extras: ($) => [/[\s]/],

  rules: {
    source_file: ($) => repeat($._line),

    _line: ($) =>
      choice(
        $.blank_line,
        $.comment_line,
        $.native_line,
        $.raw_block_start,
        $.text_line,
      ),

    blank_line: () => /\n/,
    comment_line: () => seq(';', /[^\n]*/),
    // 全大写原生指令 / `$标签`（占位：完整词形由 classifier 侧对齐，见 grammar agent）
    native_line: () => /[A-Z][A-Z0-9_]*[^\n]*/,
    raw_block_start: () => seq('@', /[^\n]*/),
    text_line: () => /[^\n]+/,
  },
});
