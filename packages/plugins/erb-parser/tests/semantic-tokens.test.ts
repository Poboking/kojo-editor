/**
 * ERB 结构化着色（B6）单测：判据 = `parseErbText`（缓冲区结构）+ `scanFileRefs`（名录）。
 *
 * 钉死四类事：
 * 1. **只画结构判得出的**：定义 vs 引用两类色（`declaration` 修饰只在定义行）；
 * 2. **词法面零触碰**：变量族成员段、字符串、注释里的同名词一条都不产（重画 = 第二真相源）；
 * 3. **列口径**：断言一律用 `cut()` 把 span 切回原文比对——1 基/0 基差一格这种错，
 *    只有对着原文才看得见，写死数字的断言只会跟着实现一起错；
 * 4. **索引缺席的降级**：只交声明，引用一条不画，且**不返回"不认"**。
 */

import { describe, expect, it } from 'vitest';
import type { EditorSemanticTokenSpan, ErbFunction, ErbIndex } from '@kojo/plugin-api';
import { erbSemanticTokens } from '../src/semantic-tokens';

/** 只填着色用得上的字段的最小索引替身 */
function indexWith(names: readonly string[]): ErbIndex {
  const byName = new Map<string, ErbFunction[]>();
  for (const name of names) byName.set(name.toUpperCase(), []);
  return {
    files: new Map(),
    byName,
    fingerprint: null,
    fileMtimes: new Map(),
    fileSizes: new Map(),
  } as unknown as ErbIndex;
}

/** span 盖住的那串原文（列口径的终极判据） */
function cut(text: string, span: EditorSemanticTokenSpan): string {
  return text.split('\n')[span.line - 1]!.slice(span.startColumn - 1, span.endColumn - 1);
}

const declared = (span: EditorSemanticTokenSpan): boolean => span.modifiers?.includes('declaration') === true;

describe('erbSemanticTokens · 声明位', () => {
  it('`@NAME` 定义行：名字落在 `@` 之后，带 `declaration`', () => {
    const text = '@FIRE_A\nRETURN';
    const spans = erbSemanticTokens(text, null);
    expect(spans).toHaveLength(1);
    expect(cut(text, spans[0]!)).toBe('FIRE_A');
    expect(spans[0]).toMatchObject({ line: 1, tokenType: 'function', modifiers: ['declaration'] });
  });

  it('行首空白不移动列（列 = 名字真实起点，1 基）', () => {
    const text = '   @FIRE_A';
    const [only] = erbSemanticTokens(text, null);
    expect(cut(text, only!)).toBe('FIRE_A');
    expect(only!.startColumn).toBe(5); // 三个空格 + `@` ⇒ 名字从第 5 列开始
    expect(only!.endColumn).toBe(5 + 'FIRE_A'.length);
  });

  it('CJK 函数名按 UTF-16 码元计列（真实语料 21% 的定义名含中文）', () => {
    const text = '@無個性_描写';
    const [only] = erbSemanticTokens(text, null);
    expect(cut(text, only!)).toBe('無個性_描写');
  });

  it('形参槽进 `parameter`，默认值段不进（那是字面量，词法的活）', () => {
    const text = '@F(ARGS, ARG:1 = 3, ref LOCALS)\nRETURN';
    const params = erbSemanticTokens(text, null).filter((s) => s.tokenType === 'parameter');
    expect(params.map((p) => cut(text, p))).toEqual(['ARGS', 'ARG:1', 'LOCALS']);
    expect(params.every((p) => p.line === 1)).toBe(true);
  });

  it('形参名是另一段的前缀时按整记号定位（`ARG` 不许命中 `ARGS` 的头）', () => {
    const text = '@F(ARG, ARGS)';
    const params = erbSemanticTokens(text, null).filter((s) => s.tokenType === 'parameter');
    expect(params.map((p) => cut(text, p))).toEqual(['ARG', 'ARGS']);
    expect(params.map((p) => p.startColumn)).toEqual([4, 9]);
  });

  it('`#DIM` / `#DIMS` 声明的名字进 `variable` + `declaration`（维度数字不是名字）', () => {
    const text = '#DIM FLAG_X\n#DIMS ARR, 32, 4\n';
    const dims = erbSemanticTokens(text, null).filter((s) => s.tokenType === 'variable');
    expect(dims.map((d) => [d.line, cut(text, d)])).toEqual([
      [1, 'FLAG_X'],
      [2, 'ARR'],
    ]);
    expect(dims.every(declared)).toBe(true);
  });

  it('注释行、字符串里、`[SKIPSTART]` 区内的 `@` 形态一律不算声明', () => {
    const text = [';@COMMENTED', '@REAL', 'PRINTFORMW "@FAKE"', '[SKIPSTART]', '@SKIPPED', '[SKIPEND]'].join('\n');
    const spans = erbSemanticTokens(text, null);
    expect(spans.map((s) => s.line)).toEqual([2]);
    expect(cut(text, spans[0]!)).toBe('REAL');
  });
});

describe('erbSemanticTokens · 引用点（判据 = 查找引用那把尺子）', () => {
  it('`CALL` 槽位与其它可见记号都进 `function`（无 `declaration`），与定义两类色', () => {
    const text = '@FIRE_A\nCALL FIRE_A\nIF CSTR(FIRE_A)\nENDIF\n';
    const spans = erbSemanticTokens(text, indexWith(['FIRE_A']));
    const refs = spans.filter((s) => !declared(s));
    expect(refs.map((r) => [r.line, cut(text, r), r.tokenType])).toEqual([
      [2, 'FIRE_A', 'function'],
      [3, 'FIRE_A', 'function'],
    ]);
  });

  it('索引里没有的名字不当引用（不猜）；定义照旧有色（缓冲区事实）', () => {
    const text = '@BRAND_NEW\nCALL BRAND_NEW\n';
    const spans = erbSemanticTokens(text, indexWith(['OTHER']));
    expect(spans.map((s) => cut(text, s))).toEqual(['BRAND_NEW']);
    expect(declared(spans[0]!)).toBe(true);
  });

  it('字符串内容与行尾注释里的同名不算引用（与查找引用逐字同判据）', () => {
    const text = '@A\nPRINTFORMW "A 在串里"\nCALL A ;A 在注释里\n';
    const refs = erbSemanticTokens(text, indexWith(['A'])).filter((s) => !declared(s));
    expect(refs.map((r) => [r.line, cut(text, r)])).toEqual([[3, 'A']]);
  });

  it('变量族成员段不抢词法的活：`CFLAG:FIRE_A:1` 整段不算引用（同 references.ts 口径）', () => {
    const text = '@FIRE_A\nIF CFLAG:FIRE_A:1\nENDIF\n';
    const spans = erbSemanticTokens(text, indexWith(['FIRE_A'])).filter((s) => s.line === 2);
    expect(spans).toEqual([]);
  });

  it('$` 标签**定义行**不当函数声明；`JUMP $LABEL` 那一格跟查找引用同判据（本模块不自新增减）', () => {
    const text = '$LABEL\nJUMP $LABEL\nJUMP 100\n';
    const spans = erbSemanticTokens(text, indexWith(['LABEL']));
    const refs = spans.filter((s) => !declared(s));
    // 第 1 行是标签定义，解析器不认它是函数 ⇒ 没有声明色；
    // 第 2 行的 `LABEL` 是不是"引用"，由 `scanFileRefs` 说了算——这里跟着它，不改判据。
    expect(spans.filter(declared)).toEqual([]);
    expect(refs.map((r) => [r.line, cut(text, r)])).toEqual([[2, 'LABEL']]);
  });
});

describe('erbSemanticTokens · 三态与降级', () => {
  it('空文本 → 空数组（"认这个文件但没东西可画"，不是"不认"）', () => {
    expect(erbSemanticTokens('', indexWith(['A']))).toEqual([]);
  });

  it('索引缺席时只交声明；引用一条不画（少画 ≠ 画错）', () => {
    const text = '@A\nCALL A\n';
    const withIndex = erbSemanticTokens(text, indexWith(['A']));
    const withoutIndex = erbSemanticTokens(text, null);
    expect(withIndex.map((s) => s.line)).toEqual([1, 2]);
    expect(withoutIndex.map((s) => s.line)).toEqual([1]);
    expect(declared(withoutIndex[0]!)).toBe(true);
  });

  it('CRLF 与裸 CR 都按同一规则切行（行号与 `parseErbText` / `scanFileRefs` 对齐）', () => {
    expect(erbSemanticTokens('@A\r\nCALL A\r\n', indexWith(['A'])).map((s) => s.line)).toEqual([1, 2]);
    expect(erbSemanticTokens('@A\rCALL A\r', indexWith(['A'])).map((s) => s.line)).toEqual([1, 2]);
  });

  it('多个函数：声明按源顺序、区间互不串台', () => {
    const text = '@A\nRETURN\n@LONGER_B\nRETURN\n';
    const spans = erbSemanticTokens(text, null);
    expect(spans.map((s) => [s.line, cut(text, s)])).toEqual([
      [1, 'A'],
      [3, 'LONGER_B'],
    ]);
  });
});
