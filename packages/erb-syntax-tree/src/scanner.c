#include "tree_sitter/parser.h"
#include "skip-marker.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

/*
 * ERB 停用区（[SKIPSTART]…[SKIPEND]）的 external scanner。
 *
 * ## 为什么必须 external
 * 区间内可以有**任意文本**——包括 `@` 行、控制词、未闭合引号、散括号。用普通行 token 拼接会把这些
 * 内容重新词法化（真语料里停用区内的 `@`/`IF` 大量存在），"引擎不编译的死代码"会被误认成函数/块。
 * 这里把整个区间体一次吞成 `skip_body`，只在**行首**识别收区标记。
 *
 * ## 为什么开/收标记也走 external（而不是普通 token）
 * tree-sitter 的 lexer 在某些状态（含错误恢复态）会把 external 记号的 `valid_symbols` 放宽到
 * 联合状态 ⇒ 普通规则上一枚"位置无关"的 `_skip_body` 会在 `@函数头` 的位置被错误地调用，
 * 一次吞掉后半个文件（实测：第二个 `@` 头整段落 ERROR，`_skip_body` 吃掉 11 字节到 EOF）。
 * 因此 scanner 自带 `in_skip` 状态：只有真的扫到 `[SKIPSTART]` 之后才允许吐 `_skip_body` /
 * `_skip_end`；状态随 tree-sitter 的 serialize/deserialize 走，增量解析也不会丢。
 *
 * ## 口径
 * - 只有 `trim` 后逐字等于标记的行才认（与真源 `trimmed === '[SKIPEND]'` 同判：
 *   大小写变体、尾注、`[skipend]` 都不认）；
 * - 行首**代码前缀** `;!;` / `;#;` 先剥再比（真源 `parseErbText` 的 `erbCodePrefixLength`
 *   同一顺序：trim → 剥三字节 → 逐字等值）。所以 `;!;[SKIPSTART]` / `;#;[SKIPEND]` 是标记行，
 *   而 `;!; [SKIPSTART]`（前缀后夹空白）不是——真源剥完前缀**不再 trim**。
 *   以 `;` 起手却不是代码前缀的行一定不是标记行（标记以 `[` 起手）。
 *   前缀表本身仍以真源 `ERB_CODE_PREFIXES` 为唯一真源，`tests/parse-structure.test.ts`
 *   的对拍一节直接 import 该常量逐项验（上游加第三种前缀 ⇒ 对拍当场红）；
 * - 体 token 的 mark_end 停在收区行**之前**（含上一行换行）⇒ 收区行归 skip_end，行号不乱；
 * - EOF 无收区标记时体一直吃到 EOF（grammar 的 close 可选），同时把 in_skip 复位，
 *   避免残缺文件影响后续解析；
 * - 体 token 至少含 skip_start 行后的换行（即便区间为空）⇒ 收区标记永远从行首被 skip_end 认领。
 */

enum {
  TOKEN_SKIP_START,
  TOKEN_SKIP_BODY,
  TOKEN_SKIP_END,
};

typedef struct {
  bool in_skip;
} Scanner;

static bool is_hspace(int32_t c) {
  /* 与 JS String.prototype.trim 对齐：ASCII 水平空白 + 全角空格 + BOM。 */
  return c == ' ' || c == '\t' || c == '\r' || c == '\f' || c == 0x3000 || c == 0xFEFF;
}

/**
 * 吃掉行首**代码前缀** `;!;` / `;#;`（与真源 `ERB_CODE_PREFIXES` 同字形：`;` + `!`/`#` + `;`）。
 * 成功返回 true（已前进三字节）；不是前缀返回 false（已前进的字节不 mark_end ⇒ 由 tree-sitter 复位）。
 */
static bool consume_code_prefix(TSLexer *lexer) {
  if (lexer->eof(lexer) || lexer->lookahead != ';') return false;
  lexer->advance(lexer, false);
  if (lexer->eof(lexer)) return false;
  const int32_t mid = lexer->lookahead;
  if (mid != '!' && mid != '#') return false;
  lexer->advance(lexer, false);
  if (lexer->eof(lexer) || lexer->lookahead != ';') return false;
  lexer->advance(lexer, false);
  return true;
}

/**
 * 当前位置是否是一整行标记（[代码前缀] + 标记字符串 + 行尾只剩水平空白）。
 * 会消费水平空白、可选代码前缀与标记本身；调用方负责 mark_end。
 */
static bool line_is_marker(TSLexer *lexer, const char *marker) {
  while (!lexer->eof(lexer) && is_hspace(lexer->lookahead)) {
    lexer->advance(lexer, false);
  }
  if (lexer->eof(lexer)) return false;

  /* 行首代码前缀：真源先剥前缀再比标记。标记以 `[` 起手 ⇒ 以 `;` 起手却不是前缀的行
     一定不是标记行，直接判否（也省得把比较起点停在剥了一半的位置）。 */
  if (lexer->lookahead == ';' && !consume_code_prefix(lexer)) return false;

  const size_t n = strlen(marker);
  for (size_t i = 0; i < n; i++) {
    if (lexer->eof(lexer) || lexer->lookahead != (int32_t)(unsigned char)marker[i]) return false;
    lexer->advance(lexer, false);
  }
  while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
    if (!is_hspace(lexer->lookahead)) return false;
    lexer->advance(lexer, false);
  }
  return true;
}

void *tree_sitter_erb_external_scanner_create(void) {
  Scanner *s = (Scanner *)malloc(sizeof(Scanner));
  if (s) s->in_skip = false;
  return s;
}

void tree_sitter_erb_external_scanner_destroy(void *payload) { free(payload); }

unsigned tree_sitter_erb_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *s = (Scanner *)payload;
  buffer[0] = s->in_skip ? 1 : 0;
  return 1;
}

void tree_sitter_erb_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Scanner *s = (Scanner *)payload;
  s->in_skip = length > 0 && buffer[0] != 0;
}

/** 收区标记行（in_skip 已在 true）→ `skip_end`。 */
static bool scan_skip_end(Scanner *s, TSLexer *lexer) {
  if (!s->in_skip) return false;
  if (!line_is_marker(lexer, ERB_SKIP_END_MARKER)) return false;
  lexer->mark_end(lexer);
  s->in_skip = false;
  lexer->result_symbol = TOKEN_SKIP_END;
  return true;
}

/** 区间体：从 skip_start 行之后扫到收区行之前（含换行）；至少吐一个换行，定位权归收区记号。 */
static bool scan_skip_body(Scanner *s, TSLexer *lexer) {
  if (!s->in_skip) return false;

  bool consumed_any = false;
  bool at_line_start = false;

  for (;;) {
    if (lexer->eof(lexer)) {
      /* 无收区标记到 EOF：体到 EOF 为止，状态复位（grammar 的 close 可选）。 */
      if (!consumed_any) {
        s->in_skip = false;
        return false;
      }
      lexer->mark_end(lexer);
      s->in_skip = false;
      lexer->result_symbol = TOKEN_SKIP_BODY;
      return true;
    }

    if (at_line_start) {
      /* 先尝试收区行；不是就继续把这一行当体（已消费的空白/标记前缀计入体）。 */
      const bool was_marker = line_is_marker(lexer, ERB_SKIP_END_MARKER);
      if (was_marker) {
        if (!consumed_any) return false; /* 只在 skip_start 后同位置，交给 skip_end */
        lexer->result_symbol = TOKEN_SKIP_BODY;
        return true;
      }
      at_line_start = false;
      continue;
    }

    const int32_t c = lexer->lookahead;
    if (c == '\n') {
      lexer->advance(lexer, false);
      consumed_any = true;
      /* mark_end 落在换行之后：区间体含到收区行之前的所有换行。 */
      lexer->mark_end(lexer);
      at_line_start = true;
      continue;
    }
    lexer->advance(lexer, false);
    consumed_any = true;
  }
}

bool tree_sitter_erb_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  Scanner *s = (Scanner *)payload;

  if (valid_symbols[TOKEN_SKIP_END] && s->in_skip) {
    if (scan_skip_end(s, lexer)) return true;
    /* 不是收区行：落回体扫描（同一位置），别把这一行丢了 */
    if (valid_symbols[TOKEN_SKIP_BODY] && scan_skip_body(s, lexer)) return true;
    return false;
  }

  if (valid_symbols[TOKEN_SKIP_START] && !s->in_skip) {
    if (!line_is_marker(lexer, ERB_SKIP_START_MARKER)) return false;
    lexer->mark_end(lexer);
    s->in_skip = true;
    lexer->result_symbol = TOKEN_SKIP_START;
    return true;
  }

  if (valid_symbols[TOKEN_SKIP_BODY] && s->in_skip) {
    return scan_skip_body(s, lexer);
  }

  return false;
}
