/**
 * 查找引用的**三腿合一**判据（LAU-4 引用腿，2026-10-31）。
 *
 * 这一批把宿主 `monaco/find-references.ts` 里那两条**缓冲区本地腿**（`$` 标签作用域 /
 * `#DIM` 声明名）与"标签 → `#DIM` → 反向索引"的合并优先序整块搬进本包
 * （`src/symbols.ts` 的 `erbReferencesAt`）；宿主那枚 provider 只剩请求与形状翻译。
 *
 * 本文件钉三件事（逐条对拍见 `symbols.ts` 头注；这里只钉可观测结果）：
 * 1. **三腿等价**：非标签入口行上，`erbReferencesAt` ≡ `mergeNavigationLegs([], dims, slot)`
 *    ——标签腿不该在非入口行上凭空多答；
 * 2. **标签入口行**：`$` 标签声明行能答出 `GOTO` 目标；
 * 3. **跨文件原样带出**：反向索引那条腿的 `filePath` 不被改写成请求文件；索引缺席 ⇒ 零跨文件。
 */

import { describe, expect, it } from 'vitest';
import type { ErbIndex } from '@kojo/plugin-api';
import {
  erbDimReferencesAt,
  erbReferencesAt,
  mergeNavigationLegs,
} from '../src/symbols';
import { erbReferenceLocationsAt } from '../src/references';

const PATH = String.raw`c:\proj\erb\refs.erb`;
const OTHER = String.raw`c:\proj\erb\别的.erb`;

/**
 * 行号（1 基）与关键列：
 * 1 `@MAIN`｜2 `  #DIM 好感度`（名字列 8）｜3 `  好感度 = 1`（3）｜4 `  IF 好感度 >= 50`（6）
 * 5 `$NEXT`（2）｜6 `  GOTO NEXT`（8）｜7 `  CALL CALLFOO`（8）｜8 `  PRINTL "好感度"`（字符串内）
 * 9 `  ; 好感度 只在注释里`｜10 `  FLAG:好感度 = 1`（成员访问）｜11 `RETURN`
 */
const TEXT = [
  '@MAIN',
  '  #DIM 好感度',
  '  好感度 = 1',
  '  IF 好感度 >= 50',
  '$NEXT',
  '  GOTO NEXT',
  '  CALL CALLFOO',
  '  PRINTL "好感度"',
  '  ; 好感度 只在注释里',
  '  FLAG:好感度 = 1',
  'RETURN',
].join('\n');

/** 只带反向索引的索引（`erbReferenceLocationsAt` 只读 `references.bySymbol`） */
function indexWith(
  name: string,
  refs: ReadonlyArray<{ filePath: string; line: number; column: number; kind: 'definition' | 'call' | 'mention' }>,
): ErbIndex {
  return {
    references: {
      bySymbol: new Map([
        [
          name.toUpperCase(),
          refs.map((ref) => ({ ...ref, endColumn: ref.column + name.length })),
        ],
      ]),
    },
  } as unknown as ErbIndex;
}

/** 非标签入口行：三腿里只有 `#DIM` 腿与反向索引腿会答 */
const NON_LABEL_CASES: ReadonlyArray<{ line: number; column: number; what: string }> = [
  { line: 2, column: 8, what: '`#DIM` 声明名' },
  { line: 2, column: 2, what: '`#DIM` 关键字' },
  { line: 3, column: 3, what: '正文里的同名变量' },
  { line: 4, column: 6, what: '条件里的同名变量' },
  { line: 7, column: 8, what: '函数调用' },
  { line: 8, column: 11, what: '字符串里的同名' },
  { line: 9, column: 5, what: '注释里的同名' },
  { line: 10, column: 8, what: '`FLAG:` 成员访问' },
];

describe('三腿合一：非标签入口行 ≡ `#DIM` 腿 + 反向索引腿', () => {
  const index = indexWith('CALLFOO', [
    { filePath: PATH, line: 7, column: 8, kind: 'call' },
    { filePath: OTHER, line: 3, column: 4, kind: 'call' },
  ]);

  for (const item of NON_LABEL_CASES) {
    it(`${item.what}（${item.line}:${item.column}）`, () => {
      const merged = mergeNavigationLegs(
        [],
        erbDimReferencesAt(TEXT, item.line, item.column, PATH),
        erbReferenceLocationsAt(index, TEXT, item.line, item.column),
      );
      expect(erbReferencesAt(index, TEXT, PATH, item.line, item.column)).toEqual(merged);
    });
  }
});

describe('标签腿只在 `$` 标签入口行作答', () => {
  it('`$NEXT` 声明行答出 `GOTO` 目标（第 6 行）', () => {
    const out = erbReferencesAt(null, TEXT, PATH, 5, 2);
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((loc) => loc.line === 6)).toBe(true);
    expect(out.every((loc) => loc.filePath === PATH)).toBe(true);
  });

  it('`GOTO NEXT` 行答到标签声明（第 5 行），且都在本文件', () => {
    const out = erbReferencesAt(null, TEXT, PATH, 6, 8);
    expect(out.every((loc) => loc.filePath === PATH)).toBe(true);
    expect(out.some((loc) => loc.line === 5)).toBe(true);
  });
});

describe('跨文件：反向索引的 `filePath` 原样带出', () => {
  const index = indexWith('CALLFOO', [
    { filePath: PATH, line: 7, column: 8, kind: 'call' },
    { filePath: OTHER, line: 3, column: 4, kind: 'call' },
  ]);

  it('索引在场 ⇒ 别的文件那条引用在场', () => {
    const out = erbReferencesAt(index, TEXT, PATH, 7, 8);
    expect(out.some((loc) => loc.filePath === OTHER)).toBe(true);
  });

  it('索引缺席 ⇒ 零跨文件（只看当前缓冲区）', () => {
    const out = erbReferencesAt(null, TEXT, PATH, 7, 8);
    expect(out.every((loc) => loc.filePath === PATH)).toBe(true);
  });
});