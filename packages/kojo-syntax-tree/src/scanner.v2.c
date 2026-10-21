/**
 * Kojo 2.0 语法的外部扫描器：offside 缩进 + `@原生` raw 行。
 *
 * 三个外部记号（顺序必须与 grammar.v2.js 的 externals 一致）：
 *   TOKEN_INDENT       块体开：下一正文行缩进严格深于当前层。**具名**（不是 `_indent`）：
 *                      体缺失时 parser 插入的 MISSING:indent 才能在 CST 里被看见。
 *   TOKEN_DEDENT       块体收：下一正文行缩进回到当前层或更浅。同样具名。
 *   TOKEN_NATIVE_LINE  `@原生` 体内一条 raw 行（含行首空白与 Tab，止于换行之前）。
 *
 * 缩进口径（§4.13）：一级 = 4 空格；Tab **不算**结构缩进（结构区出现 Tab ⇒ 本扫描器
 * 不认那里的缩进记号，内部词法随即在 Tab 上落 ERROR）；全角空格同理不认。
 * 空行不参与缩进计算。
 *
 * 记号边界：`indent` / `dedent` 一律零宽——扫描器为看下一行会向前推进 lexer，但
 * `mark_end` 停在行首（首个换行）之前，于是块节点的行跨度正好落在正文行上，
 * 折叠区间不会多吃缩进行或空行。`native_line` 相反：一整行 raw，止于换行之前。
 *
 * 换行不属于本扫描器：grammar 里 `blank_line` 是换行的唯一认领者（extras 不含换行）。
 */
#include "tree_sitter/parser.h"

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

enum {
  TOKEN_INDENT,
  TOKEN_DEDENT,
  TOKEN_NATIVE_LINE,
};

/** 缩进层栈上限；嵌套 96 层对剧本写作已经是天文数字，溢出时不再压栈（不会崩）。 */
#define MAX_STACK 96

typedef struct {
  unsigned levels[MAX_STACK];
  unsigned size;
} Scanner;

void *tree_sitter_kojo2_external_scanner_create(void) {
  Scanner *s = (Scanner *)malloc(sizeof(Scanner));
  if (s == NULL) return NULL;
  s->size = 1;
  s->levels[0] = 0;
  return s;
}

void tree_sitter_kojo2_external_scanner_destroy(void *payload) { free(payload); }

unsigned tree_sitter_kojo2_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *s = (Scanner *)payload;
  unsigned n = s->size;
  for (unsigned i = 0; i < n; i++) memcpy(buffer + i * 4, &s->levels[i], 4);
  return n * 4;
}

void tree_sitter_kojo2_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
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

/** 空格数 → 层级：每 4 个 1 级，余数进一位（与 v1 / lexer 的 `indentLevel()` 同口径）。 */
static unsigned level_of(unsigned spaces) { return (spaces + 3) / 4; }

/**
 * 扫描器主入口。
 *
 * 一次调用的通用流程：
 *   1) 把记号默认标成零宽（`mark_end` 立刻标在起点）；
 *   2) 向前扫过换行与行首空白，停在下一正文行首（记下空格数）；
 *   3) 按"下一正文行相对当前层的深浅"决定吐 `indent` / `dedent`，或什么都不吐
 *      （让内部的 `blank_line` / 行记号接手）。
 *
 * `@原生` 的 raw 行是唯一需要吃满一行的情形：调用点位于行首（前一枚记号是
 * `blank_line` 或 `indent`），此时扫完行首空白后把整行收到行尾之前。
 */
bool tree_sitter_kojo2_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  Scanner *s = (Scanner *)payload;
  const bool indent_ok = valid_symbols[TOKEN_INDENT];
  const bool dedent_ok = valid_symbols[TOKEN_DEDENT];
  const bool native_ok = valid_symbols[TOKEN_NATIVE_LINE];
  if (!indent_ok && !dedent_ok && !native_ok) return false;
  if (s == NULL) return false;

  /* 记号初值 = 零宽，落在本次扫描起点（通常是上一行行尾、换行之前）。 */
  lexer->mark_end(lexer);

  unsigned spaces = 0;
  unsigned tabs = 0;
  bool saw_newline = false;

  for (;;) {
    if (lexer->eof(lexer)) break;
    const int32_t c = lexer->lookahead;
    if (c == '\n') {
      /* 第一枚换行处定住记号终点：缩进/收盘记号不吃换行、不吃下一行的缩进。 */
      if (!saw_newline) {
        lexer->mark_end(lexer);
        saw_newline = true;
      }
      spaces = 0;
      tabs = 0;
      lexer->advance(lexer, false);
    } else if (c == '\r') {
      lexer->advance(lexer, false);
    } else if (c == ' ') {
      spaces++;
      lexer->advance(lexer, false);
    } else if (c == '\t') {
      if (saw_newline) break; /* 结构缩进里 Tab 非法：不当空白，交给内部词法落 ERROR */
      tabs++;                 /* 行首（blank_line 之后）的 Tab 属于 raw 行内容 */
      lexer->advance(lexer, false);
    } else {
      break; /* 正文首字符 */
    }
  }

  const unsigned current = s->size > 0 ? s->levels[s->size - 1] : 0;
  const unsigned level = tabs + level_of(spaces);

  if (lexer->eof(lexer)) {
    /* 文件尾：把还开着的块体逐层收盘（EOF 收口，不产 ERROR）。 */
    if (dedent_ok && s->size > 1) {
      s->size--;
      lexer->result_symbol = TOKEN_DEDENT;
      return true;
    }
    return false;
  }

  if (!saw_newline) {
    /* 行首（前一枚记号是 blank_line / indent）：只有 `@原生` raw 行需要整行记号。 */
    if (native_ok && !indent_ok) {
      if (level < current) {
        /* raw 行缩进回到围栏头或更浅 ⇒ 围栏收口（零宽，停在行首之前）。 */
        if (dedent_ok && s->size > 1) {
          s->size--;
          lexer->result_symbol = TOKEN_DEDENT;
          return true;
        }
        return false;
      }
      for (;;) {
        if (lexer->eof(lexer)) break;
        const int32_t c = lexer->lookahead;
        if (c == '\n' || c == '\r') break;
        lexer->advance(lexer, false);
      }
      lexer->mark_end(lexer);
      lexer->result_symbol = TOKEN_NATIVE_LINE;
      return true;
    }
    return false;
  }

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
  return false;
}
