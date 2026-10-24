/**
 * `kojo2` 词表**单一真源**守卫（U6）：宿主层不许再抄一份 2.0 词表。
 *
 * 三条判据：
 * - (a) **转发不是重写**：`kojo2-lexicon.ts` 导出的每个数组/常量都与 core（或糖聚合）的
 *   同名真源逐项相等；`KOJO2_RESERVED_WORDS` 的每一项都能在 core 词表里找到出处（无自造词）。
 * - (b) **`@原生` 围栏词由 core 语义反证**：用 core 词法器对 16 枚调度词逐词实测"哪一枚真能
 *   开围栏"，结果必须**恰等于** `KOJO2_NATIVE_FENCE_WORD`（该常量因此能安全地集中一处手写）。
 * - (c) **零抄本**：语言面三个源文件的字符串字面量里，不得出现"整条等于 2.0 词形"的抄本
 *   （唯一例外是 (b) 那一枚围栏词常量，注释里写明理由）。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KOJO_BLANK_LINE,
  KOJO_BLANK_WAIT,
  KOJO_DECL_WORDS,
  KOJO_DISPATCH_WORDS,
  KOJO_DISPATCH_WORD_SET,
  KOJO_DOMAIN_SYMBOL_NAMES,
  KOJO_INDENT_WIDTH,
  KOJO_STORAGE_WORDS,
  KOJO_TABLE_DEFAULT,
  KOJO_TABLE_SUBJECT,
  KOJO_TEMPLATE_SLOT,
  KOJO_TYPE_WORDS,
  KOJO_WAIT_CONTINUE,
  KOJO_WEAVE_MODIFIERS,
  lex,
} from '@kojo/kojo-core';
import { sugarEditorLexicon } from '@kojo/plugin-kojo-sugar';
import {
  KOJO2_DECL_WORDS,
  KOJO2_DISPATCH_WORDS,
  KOJO2_DOMAIN_SYMBOLS,
  KOJO2_INDENT_WIDTH,
  KOJO2_NATIVE_FENCE_WORD,
  KOJO2_OPERATOR_WORDS,
  KOJO2_RESERVED_WORDS,
  KOJO2_TABLE_DEFAULT_WORD,
  KOJO2_TEMPLATE_SLOT,
  KOJO2_WAIT_CONTINUE,
} from '../src/monaco/kojo2-lexicon';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const MONACO_DIR = path.join(ROOT, 'packages', 'app', 'src', 'monaco');
const KOJO2_SOURCES = ['kojo2-language.ts', 'kojo2-lexicon.ts', 'kojo2-enter.ts'];

const read = (rel: string): string => readFileSync(path.join(MONACO_DIR, rel), 'utf8');

/* ============================== (a) 转发不是重写 ============================== */

describe('词表单一真源：kojo2 只转发 core / 糖聚合', () => {
  it('声明词 / 调度词 / 域符号 / 表词 / 插槽 / 续 都是真源本体（同引用）', () => {
    expect(KOJO2_DECL_WORDS).toBe(KOJO_DECL_WORDS);
    expect(KOJO2_DISPATCH_WORDS).toBe(KOJO_DISPATCH_WORDS);
    expect(KOJO2_DOMAIN_SYMBOLS).toBe(KOJO_DOMAIN_SYMBOL_NAMES);
    expect(KOJO2_TABLE_DEFAULT_WORD).toBe(KOJO_TABLE_DEFAULT);
    expect(KOJO2_TEMPLATE_SLOT).toBe(KOJO_TEMPLATE_SLOT);
    expect(KOJO2_WAIT_CONTINUE).toBe(KOJO_WAIT_CONTINUE);
    expect(KOJO2_INDENT_WIDTH).toBe(KOJO_INDENT_WIDTH);
  });

  it('保留词 = core 常量拼出的集合（逐项、无自造词、无重复）', () => {
    const expected = [
      KOJO_TABLE_SUBJECT,
      KOJO_TABLE_DEFAULT,
      KOJO_WAIT_CONTINUE,
      KOJO_BLANK_LINE,
      KOJO_BLANK_WAIT,
      ...KOJO_TYPE_WORDS,
      ...KOJO_STORAGE_WORDS,
      ...KOJO_WEAVE_MODIFIERS,
    ];
    expect([...KOJO2_RESERVED_WORDS]).toEqual(expected);
    expect(new Set(KOJO2_RESERVED_WORDS).size).toBe(KOJO2_RESERVED_WORDS.length);
    for (const word of KOJO2_RESERVED_WORDS) expect(expected).toContain(word);
  });

  it('中文运算符 = 糖聚合的运算符 ∪ `不在`（2.0 规范 §5.1「沿用现有中文表」）', () => {
    const lexicon = sugarEditorLexicon();
    expect([...KOJO2_OPERATOR_WORDS]).toEqual([...lexicon.operators, ...lexicon.notin]);
    expect(KOJO2_OPERATOR_WORDS.length).toBeGreaterThan(5);
    for (const word of KOJO2_OPERATOR_WORDS) {
      expect(lexicon.operators.includes(word) || lexicon.notin.includes(word)).toBe(true);
    }
  });
});

/* ============================== (b) 围栏词由 core 语义反证 ============================== */

describe('`@原生` 围栏词：用 core 词法器反证，不靠数组位置猜', () => {
  it('16 枚调度词里恰有一枚真能开围栏，且等于集中常量', () => {
    const fenceWords = KOJO_DISPATCH_WORDS.filter((word) => {
      const result = lex(`@${word}\n    原生体一行\n`);
      return result.lines[1]?.kind === 'native';
    });
    expect(fenceWords).toEqual([KOJO2_NATIVE_FENCE_WORD]);
    expect(KOJO_DISPATCH_WORD_SET.has(KOJO2_NATIVE_FENCE_WORD)).toBe(true);
  });

  it('围栏词确实来自调度词表（core 加词/换词时这里跟着走或当场红）', () => {
    expect(KOJO2_DISPATCH_WORDS).toContain(KOJO2_NATIVE_FENCE_WORD);
    // 非调度词不能开围栏（反证判据不是"随便一个 @ 词都算"）
    const result = lex(`@不是调度词\n    正文\n`);
    expect(result.lines[1]?.kind).not.toBe('native');
  });
});

/* ============================== (c) 零抄本 ============================== */

/** 2.0 词形全集（零抄本守卫对象）。 */
const WORD_SET: ReadonlySet<string> = new Set<string>([
  ...KOJO_DECL_WORDS,
  ...KOJO_DISPATCH_WORDS,
  ...KOJO2_RESERVED_WORDS,
  ...KOJO_DOMAIN_SYMBOL_NAMES,
  ...KOJO2_OPERATOR_WORDS,
  KOJO2_NATIVE_FENCE_WORD,
  KOJO_TABLE_SUBJECT,
  KOJO_TABLE_DEFAULT,
  KOJO_TEMPLATE_SLOT,
  KOJO_WAIT_CONTINUE,
]);

interface StringLiteral {
  readonly content: string;
  readonly line: number;
}

/**
 * 摘出源码里的字符串字面量（单 / 双引号 + 模板串），跳过注释与正则字面量：
 * 注释里的词形是说明、正则里的词形是**判定**（行首形状判据），都不算"抄词表"。
 */
function stringLiterals(source: string): StringLiteral[] {
  const out: StringLiteral[] = [];
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const regexAllowedAfter = new Set(['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'new', 'delete', 'void', 'yield', 'await', 'instanceof', 'throw', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>']);
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const d = source[i + 1];
    if (c === '/' && d === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < source.length && !(source[j] === '*' && source[j + 1] === '/')) j++;
      i = Math.min(source.length, j + 2);
      continue;
    }
    if (c === '/' && regexAllowedAfter.has(previousMeaningfulChar(source, i))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const ch = source[j]!;
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === '\n') break;
        if (inClass) {
          if (ch === ']') inClass = false;
          j++;
          continue;
        }
        if (ch === '[') {
          inClass = true;
          j++;
          continue;
        }
        if (ch === '/') {
          j++;
          while (j < source.length && /[gimsuyvd]/.test(source[j] ?? '')) j++;
          i = j;
          break;
        }
        j++;
      }
      if (source[i] === '/' && i !== j) continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let closed = false;
      while (j < source.length) {
        const ch = source[j]!;
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if ((c === "'" || c === '"') && ch === '\n') break;
        if (ch === c) {
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (closed) {
        out.push({ content: source.slice(i + 1, j - 1), line: lineOf(i) });
        i = j;
        continue;
      }
    }
    i++;
  }
  return out;
}

function previousMeaningfulChar(source: string, index: number): string {
  for (let i = index - 1; i >= 0; i--) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    return ch;
  }
  return '';
}

describe('零抄本：语言面不许手写 2.0 词形', () => {
  it('三个源文件的字符串字面量里没有整条等于 2.0 词形的抄本（唯一例外：围栏词常量）', () => {
    const hits: string[] = [];
    for (const file of KOJO2_SOURCES) {
      for (const literal of stringLiterals(read(file))) {
        const bare = literal.content.trim();
        if (!WORD_SET.has(bare)) continue;
        // 围栏词是 core 没单独命名导出的那一枚，允许在 lexicon 的常量定义处手写一次；
        // 该字面量本身由上面 (b) 用 core 词法器反证，不是"第二份真源"。
        const allowed =
          file === 'kojo2-lexicon.ts' &&
          bare === KOJO2_NATIVE_FENCE_WORD &&
          read(file).split('\n')[literal.line - 1]?.includes('KOJO2_NATIVE_FENCE_WORD =');
        if (!allowed) hits.push(`kojo2-lexicon 面 ${file}:${literal.line} 「${literal.content}」`);
      }
    }
    expect(hits, `kojo2 语言面出现 2.0 词形手抄字面量（词形只能经 kojo2-lexicon 从 core 来）：\n${hits.join('\n')}`).toEqual([]);
  });

  it('扩展名 `.kojo2` 全仓只有一处字面量（B1 后住在语言面库的零依赖叶子 constants.ts）', () => {
    // B1（2026-10-24）：字面源随 `kojo2-constants` 搬进 `@kojo/kojo-lang`。
    // 判据从"宿主 monaco 目录内唯一"改成"宿主这四枚文件内零处 + 包内唯一"——
    // 不变量（一处可改）没变，只是那一处换了地址。
    const files = ['kojo2-language.ts', 'kojo2-lexicon.ts', 'kojo2-enter.ts'];
    const occurrences: string[] = [];
    for (const file of files) {
      read(file)
        .split('\n')
        .forEach((line, index) => {
          if (/["']\.kojo2["']/.test(line)) occurrences.push(`${file}:${index + 1}`);
        });
    }
    expect(occurrences).toEqual([]);
    // 包内恰好一处，且就在那个零依赖叶子里
    const pkgLeaf = readFileSync(
      path.join(ROOT, 'packages', 'kojo-lang', 'src', 'constants.ts'),
      'utf8',
    );
    expect(pkgLeaf.match(/["']\.kojo2["']/g) ?? []).toHaveLength(1);
    // 不许出现"抢 v1 `.kojo`"的字面量（v1 的扩展名清单只住契约层）
    for (const file of files) expect(read(file)).not.toMatch(/["']\.kojo["']/);
  });
});
