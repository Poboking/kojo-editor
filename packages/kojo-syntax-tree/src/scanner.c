#include "tree_sitter/parser.h"
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

enum {
  TOKEN_INDENT,
  TOKEN_DEDENT,
  TOKEN_RAW_CLOSE,
};

#define MAX_STACK 96

typedef struct {
  unsigned levels[MAX_STACK];
  unsigned size;
} Scanner;

void *tree_sitter_kojo_external_scanner_create(void) {
  Scanner *s = (Scanner *)malloc(sizeof(Scanner));
  s->size = 1;
  s->levels[0] = 0;
  return s;
}

void tree_sitter_kojo_external_scanner_destroy(void *payload) { free(payload); }

unsigned tree_sitter_kojo_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *s = (Scanner *)payload;
  unsigned n = s->size;
  for (unsigned i = 0; i < n; i++) memcpy(buffer + i * 4, &s->levels[i], 4);
  return n * 4;
}

void tree_sitter_kojo_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Scanner *s = (Scanner *)payload;
  s->size = 0;
  for (unsigned i = 0; i + 4 <= length && s->size < MAX_STACK; i += 4) {
    memcpy(&s->levels[s->size++], buffer + i, 4);
  }
  if (s->size == 0) {
    s->levels[0] = 0;
    s->size = 1;
  }
}

/**
 * 缩进层级（与词法层 `indentLevel()` 同一口径）：TAB = 1 级；空格每 4 个 1 级（余数进一位）；
 * 全角空格按 2 个空格计。空行不产记号（正文行才算数）。
 */
static unsigned indent_level(unsigned tabs, unsigned spaces) {
  return tabs + (spaces > 0 ? (spaces + 3) / 4 : 0);
}

static bool is_hspace(int32_t c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\f' || c == 0x3000;
}

/**
 * `@函数名` 原生块（raw block）的收盘判据——不是独立一趟扫描，而是插在下面 `scan()` 的
 * 决策序列里（优先级：`_dedent` > `_raw_close` > `_indent`）。
 *
 * 这一族是本语法里**唯一**范围既不由缩进、也不由显式收束词决定的块：范围 = "到下一条 `@` 行或
 * 文件尾"（真源 `kojo-sugar/src/parser.ts::readRawFunctionBlock` 就是这条判据）⇒ 只能靠前瞻。
 * 收盘记号**零宽**、停在本次扫描越过的换行处 ⇒ 块节点的止行 = 区内最后一行，而那条换行仍归外层
 * `blank_line` 认领（换行的唯一认领者不变，见 grammar.js 头注）。
 *
 * 为什么不各走各的扫描：LR 状态合并后，"raw 体内"与"普通块体内"会共用状态
 * （`ts_external_scanner_states` 里那行 indent+dedent+raw_close 全真），若让 raw 收盘分支独占
 * 本次扫描就会饿死 `_dedent`——实测残缺 fixtures 的错误恢复路径因此改变（`broken-unclosed-block`
 * 的 `时机 901` 由"照常解析"退化成整段 ERROR）。故这里**只在原有一条扫描上多问一句**：
 * 缩进记号的口径与判定分毫不动，只有 `_dedent`/`_indent` 都不成立时才认 `@` 行收盘。
 *
 * mark 的两档口径（`raw_only`）：
 *  · 本状态还可能吐出 `_dedent`（合并态）⇒ 只标**第一条**换行，既有块的止行口径一律不变；
 *  · 纯 raw 状态 ⇒ 标到**最后一条**换行 ⇒ 止行含尾随空行，与转译器 `loc.end` 逐行对齐。
 */
#define RAW_AT_LINE_START(lexer) ((lexer)->lookahead == '@')

bool tree_sitter_kojo_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  Scanner *s = (Scanner *)payload;
  const bool indent_ok = valid_symbols[TOKEN_INDENT];
  const bool dedent_ok = valid_symbols[TOKEN_DEDENT];
  const bool raw_close_ok = valid_symbols[TOKEN_RAW_CLOSE];
  if (!indent_ok && !dedent_ok && !raw_close_ok) return false;
  /* 合并态（还可能出 `_dedent`）里不改 mark 口径，保住既有块体的止行分毫不动。 */
  const bool raw_only = raw_close_ok && !dedent_ok;

  unsigned tabs = 0;
  unsigned spaces = 0;
  bool saw_newline = false;
  bool marked = false;

  for (;;) {
    if (lexer->eof(lexer)) break;
    const int32_t c = lexer->lookahead;
    if (c == '\n') {
      /* 记号只跨到换行**之前** ⇒ 块节点的行跨度正好落在正文行上（折叠区间不多吃一行）。 */
      if (!marked || raw_only) {
        lexer->mark_end(lexer);
        marked = true;
      }
      saw_newline = true;
      tabs = 0;
      spaces = 0;
    } else if (saw_newline && is_hspace(c)) {
      if (c == '\t') tabs++;
      else if (c == 0x3000) spaces += 2;
      else spaces++;
    } else if (is_hspace(c)) {
      /* 行内空白：还没越过换行，继续往后找正文行首 */
    } else {
      break;
    }
    lexer->advance(lexer, false);
  }

  if (!marked) {
    lexer->mark_end(lexer);
    marked = true;
  }

  const bool at_eof = lexer->eof(lexer);
  const unsigned current = s->size > 0 ? s->levels[s->size - 1] : 0;

  if (at_eof) {
    /* 文件尾：把还开着的块体逐层收盘（不产 ERROR）。 */
    if (dedent_ok && s->size > 1) {
      s->size--;
      lexer->result_symbol = TOKEN_DEDENT;
      return true;
    }
    /* 开着的 `@` 区到文件尾收盘（真源同样把区读到 EOF，并把尾行算进 loc.end）：
     * 这里把 mark 抬到 EOF ⇒ 止行含文件尾那一条空行，与转译器逐行对齐。
     * 走到这一条分支时上面的 `_dedent` 已经先行返回过，既有块体的口径不受影响。 */
    if (raw_close_ok) {
      lexer->mark_end(lexer);
      lexer->result_symbol = TOKEN_RAW_CLOSE;
      return true;
    }
    return false;
  }

  /* 还没越过换行 ⇒ 当前是行中位置，缩进 / 收盘记号一律不产（行内注释/字符串尾巴由此保住）。 */
  if (!saw_newline) return false;

  const unsigned level = indent_level(tabs, spaces);
  if (level > current && indent_ok) {
    if (s->size < MAX_STACK) s->levels[s->size++] = level;
    lexer->result_symbol = TOKEN_INDENT;
    return true;
  }
  if (level < current && dedent_ok) {
    if (s->size > 1) s->size--;
    lexer->result_symbol = TOKEN_DEDENT;
    return true;
  }
  /* `@` 族收盘放在最后：缩进记号都不成立（同层 / 本状态不需要）时才轮到它，
   * 于是既有各族的止行口径分毫不动。行首 `@` = 真源 readRawFunctionBlock 的收盘判据。 */
  if (raw_close_ok && RAW_AT_LINE_START(lexer)) {
    lexer->result_symbol = TOKEN_RAW_CLOSE;
    return true;
  }
  return false;
}
