/**
 * K2-NATIVE-DEDENT：`@原生` 缩进围栏的坐标与字节面。
 *
 * 覆盖四条判据（全部带读数，不做"大致像"）：
 * 1. **逐行 source map**：块体第 i 行 ↔ 物理第 `块头行 + 1 + i` 行（1:1），kind = `native`，
 *    **不再整块挂块首行**；空行、末行、`# 机` 包装后都各自成行。
 * 2. **物理列折回**：`column-fold.ts` 是唯一实现（与 v1 折行面同一枚函数）；
 *    `@原生` 走 `foldDedentedPosition`（单段也折）。parser 恒提供 `lineColumns`（被剥掉的
 *    码元数 + 1）⇒ source map 列即**物理列**；手工构造的节点可缺省，缺省时退化为去缩进
 *    视图坐标（不伪造，见 `native.ts` 契约）。
 * 3. **字节级透传**：块内非空行去基准缩进后逐字节等于源切片（相对缩进 / Tab / 行尾空白 /
 *    行尾 `\` / `;` / CJK / emoji 一个字节不动）；**纯空白行按物理行原文保留（§8.5，
 *    含缩进空白——§C2.10 规则 4 的"归一空行"会让字节静默丢失，本文件按字节零丢失裁定）；
 *    CRLF 源产物不留 `\r`。
 * 4. **块外零变化**：同一份源里块外文本行与无 `@原生` 的基线逐字节相同。
 *
 * 口径写死：1 基行列、列按 **UTF-16 码元**（emoji = 2）；越界夹取见 `column-fold.ts`。
 */
import { describe, expect, it } from 'vitest';
import type { KojoNativeBlock, KojoSpan } from '../src/ast.js';
import { compileKojoSource } from '../src/compile.js';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '../src/fixture-adapter.js';
import { foldPositionToPhysical as foldFromPublicSurface } from '../src/index.js';
import { parseSource } from '../src/parser.js';
import {
  clampLogicalOffset,
  foldDedentedPosition,
  foldPositionToPhysical,
  logicalPosition,
  nativeLineView,
  type SourceLineView,
} from '../src/lower/column-fold.js';
import { lowerNarrative, type NativeLineColumns } from '../src/lower/index.js';
import { createFakeBackend } from './lower-fake-backend.js';

/* ============================== 工具 ============================== */

const compile = (source: string) =>
  compileKojoSource({ source, adapter: FIXTURE_ADAPTER, backend: FIXTURE_BACKEND });

/** 产物按物理行切开（不去缩进、不丢空行——本文件的判据就是字节） */
const rows = (erb: string): string[] => (erb === '' ? [] : erb.replace(/\n$/, '').split('\n'));

const errorsOf = (source: string) => compile(source).diagnostics.filter((d) => d.severity === 'error');

/** 字节级读数（小写十六进制；UTF-8） */
const hex = (text: string): string =>
  [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');

const span = (line: number, column = 1): KojoSpan => ({
  start: { line, column },
  end: { line, column: column + 4 },
});

/** 直接降糖一个 `@原生` 节点（不走 parser；用于 additive `lineColumns` 契约） */
const lowerNative = (node: KojoNativeBlock & NativeLineColumns) =>
  lowerNarrative([node], { backend: createFakeBackend(), estimatedLines: 4 });

const nativeNode = (
  lines: readonly string[],
  line = 10,
  lineColumns?: readonly number[],
): KojoNativeBlock & NativeLineColumns => ({
  kind: 'nativeBlock',
  lines,
  span: span(line),
  ...(lineColumns === undefined ? {} : { lineColumns }),
});

/* ============================================================================ */
/* A. 逐行 source map（e2e：真前端 → 降糖 → `# 机` 包装）                        */
/* ============================================================================ */

/** 探针源：`@原生` 在物理第 2 行，块体第 3..8 行（含块内空行 / `;` / Tab / emoji / 行尾 `\`） */
const PROBE_LINES = [
  '# 机 开场',
  '@原生',
  '    IF A',
  '        PRINT 1 \\',
  '',
  '    ; ERB comment',
  '    \tSET A, "灵梦😀"',
  '    ENDIF',
  '> 出去',
];
const PROBE = PROBE_LINES.join('\n');

/** 产物行号（1 基）：1 = `MACHINE 开场`，2..7 = 块体 6 行，8 = 台词，9 = `MACHINE.END` */
const PROBE_ERB_ROWS = [
  'MACHINE 开场',
  'IF A',
  '    PRINT 1 \\',
  '',
  '; ERB comment',
  '\tSET A, "灵梦😀"',
  'ENDIF',
  'TELL: 出去 /WAIT',
  'MACHINE.END',
];

describe('A. `@原生` 逐行 source map（物理行 1:1）', () => {
  it('块体每一行各登记一次：kind=native，源行 = 块头行 + 1 + i', () => {
    const result = compile(PROBE);
    expect(errorsOf(PROBE)).toEqual([]);
    for (let i = 0; i < 6; i++) {
      const mapped = result.sourceMap.lineAt(2 + i)!;
      expect(mapped.kind).toBe('native');
      expect(mapped.source?.start.line).toBe(3 + i);
    }
  });

  it('首行不挂块首行（回归「整块挂块首行」）：3 ≠ 2，末行 = 8', () => {
    const result = compile(PROBE);
    expect(result.sourceMap.lineAt(2)?.source?.start.line).toBe(3);
    expect(result.sourceMap.lineAt(2)?.source?.start.line).not.toBe(2);
    expect(result.sourceMap.lineAt(7)?.source?.start.line).toBe(8);
  });

  it('块内空行有自己的映射（第 5 物理行），不是被并进上一行', () => {
    const result = compile(PROBE);
    const blankRow = result.sourceMap.lineAt(4)!;
    expect(blankRow.kind).toBe('native');
    expect(blankRow.source).toEqual({ start: { line: 5, column: 1 }, end: { line: 5, column: 1 } });
  });

  it('`# 机` 包装行仍是 source（事件头），native 映射整体后移而源行不变', () => {
    const result = compile(PROBE);
    expect(result.sourceMap.lineAt(1)?.kind).toBe('source');
    expect(result.sourceMap.lineAt(9)?.kind).toBe('source');
    expect(result.sourceMap.lineAt(1)?.source?.start.line).toBe(1);
    expect(rows(result.erb)).toEqual(PROBE_ERB_ROWS);
  });

  it('CRLF 源：行号与 LF 版本逐行相同，产物逐字节相同（不留 `\\r`）', () => {
    const lf = compile(PROBE);
    const crlf = compile(PROBE_LINES.join('\r\n'));
    expect(crlf.erb).toBe(lf.erb);
    expect(crlf.erb.includes('\r')).toBe(false);
    for (let row = 1; row <= 9; row++) {
      expect(crlf.sourceMap.lineAt(row)?.source).toEqual(lf.sourceMap.lineAt(row)?.source ?? null);
    }
  });

  it('物理列口径：`    TAB SET…` 剥 4 空格 ⇒ span 7:5..7:19（宽度 14 码元，emoji 算 2）', () => {
    const result = compile(PROBE);
    const cjkRow = result.sourceMap.lineAt(6)!; // 源第 7 行 `    \tSET A, "灵梦😀"`
    const text = rows(result.erb)[5]!;
    expect(cjkRow.source).toEqual({
      start: { line: 7, column: 5 },
      end: { line: 7, column: 19 },
    });
    expect(cjkRow.source!.end.column - cjkRow.source!.start.column).toBe(text.length);
    // `\t`(1) + `SET A, "`(8) + 灵梦(2) + 😀(2) + `"`(1) = 14 码元（码点口径会给 13）
    expect(text.length).toBe(14);
  });

  it('source map 的列不是「整块块首列」：相邻行各自从自己的物理起点列开始', () => {
    const result = compile(PROBE);
    const read = (row: number) => {
      const mapped = result.sourceMap.lineAt(row)!;
      return {
        start: mapped.source!.start.column,
        width: mapped.source!.end.column - mapped.source!.start.column,
      };
    };
    // 块体 6 行：4/8/空/4/4/4 空格缩进（第 6 行先 4 空格再 Tab）；去缩进只吃基准 4
    expect([2, 3, 4, 5, 6, 7].map(read)).toEqual([
      { start: 5, width: 4 },
      { start: 5, width: 13 },
      { start: 1, width: 0 },
      { start: 5, width: 13 },
      { start: 5, width: 14 },
      { start: 5, width: 5 },
    ]);
  });
});

/* ============================================================================ */
/* B. 物理列折回（additive `lineColumns` 契约；parser 落地前缺省）                 */
/* ============================================================================ */

describe('B. `@原生` 物理列（additive `lineColumns`；手工节点的缺省口径）', () => {
  it('给出每行物理起点列时，span 落在物理列上（9..10 / 5..6）', () => {
    const result = lowerNative(nativeNode(['A', 'B'], 10, [9, 5]));
    expect(result.lines).toEqual(['A', 'B']);
    expect(result.sourceMap.lineAt(1)?.source).toEqual({
      start: { line: 11, column: 9 },
      end: { line: 11, column: 10 },
    });
    expect(result.sourceMap.lineAt(2)?.source).toEqual({
      start: { line: 12, column: 5 },
      end: { line: 12, column: 6 },
    });
  });

  it('缺省（无 `lineColumns`）退化为去缩进视图坐标 1..len+1——不伪造物理列', () => {
    const result = lowerNative(nativeNode(['CALL X']));
    expect(result.sourceMap.lineAt(1)?.source).toEqual({
      start: { line: 11, column: 1 },
      end: { line: 11, column: 7 },
    });
  });

  it('`lineColumns` 长度不齐 ⇒ 整块按缺省口径（不半信半疑）', () => {
    const result = lowerNative(nativeNode(['A', 'B'], 10, [9]));
    expect(result.sourceMap.lineAt(1)?.source?.start.column).toBe(1);
    expect(result.sourceMap.lineAt(2)?.source?.start.column).toBe(1);
  });

  it('非法列（0 / 负数 / 非有限）夹到 1：坐标换算绝不抛错', () => {
    const result = lowerNative(nativeNode(['A', 'B', 'C'], 10, [0, -3, Number.NaN]));
    expect(result.sourceMap.lineAt(1)?.source?.start.column).toBe(1);
    expect(result.sourceMap.lineAt(2)?.source?.start.column).toBe(1);
    expect(result.sourceMap.lineAt(3)?.source?.start.column).toBe(1);
  });

  it('空行 + `lineColumns` ⇒ 该物理列上的零宽 span（不给假列）', () => {
    const result = lowerNative(nativeNode([''], 10, [7]));
    expect(result.sourceMap.lineAt(1)?.source).toEqual({
      start: { line: 11, column: 7 },
      end: { line: 11, column: 7 },
    });
  });

  it('emoji 行：列宽按 UTF-16 码元（起点 5 + 文本 8 码元 ⇒ 终点 13）', () => {
    const text = '灵梦😀';
    expect(text.length).toBe(4);
    const result = lowerNative(nativeNode([text], 10, [5]));
    expect(result.sourceMap.lineAt(1)?.source).toEqual({
      start: { line: 11, column: 5 },
      end: { line: 11, column: 9 },
    });
  });

  it('物理列折回与 `column-fold` 夹取同口径：列越界也只到行尾之后', () => {
    const view = nativeLineView(3, 4, '甲乙');
    expect(foldDedentedPosition(view, { line: 3, column: 99 })).toEqual({ line: 3, column: 6 });
    expect(foldDedentedPosition(view, { line: 3, column: 0 })).toEqual({ line: 3, column: 4 });
  });
});

/* ============================================================================ */
/* C. 字节级透传（`@原生` 逐行；行尾 `\` 是 ERB 文本不是 2.0 折行）               */
/* ============================================================================ */

describe('C. `@原生` 字节级透传', () => {
  it('非空行去基准缩进后逐字节等于源切片（相对缩进保留）', () => {
    const result = compile(PROBE);
    expect(rows(result.erb).slice(1, 7)).toEqual([
      'IF A',
      '    PRINT 1 \\',
      '',
      '; ERB comment',
      '\tSET A, "灵梦😀"',
      'ENDIF',
    ]);
  });

  it('行尾 `\\` 原样保留：不折行、不合并下一行（两行各自成行）', () => {
    const result = compile(PROBE);
    const product = rows(result.erb);
    expect(product[2]).toBe('    PRINT 1 \\');
    expect(product[3]).toBe('');
    // 折行归一（`A = 1 \` + `B = 2` → `A = 1 B = 2`）的产物行不存在
    expect(product).not.toContain('    PRINT 1');
    expect(product.some((line) => line.includes('PRINT 1 \\'))).toBe(true);
  });

  it('`;` 是 ERB 注释原文：不剥注释、不当 2.0 注释报错', () => {
    const result = compile(PROBE);
    expect(errorsOf(PROBE)).toEqual([]);
    expect(rows(result.erb)[4]).toBe('; ERB comment');
  });

  it('块内空行保留为独立空行（行数一个不少）', () => {
    const source = ['# 机 开场', '@原生', '    A', '', '    B'].join('\n');
    const result = compile(source);
    expect(rows(result.erb)).toEqual(['MACHINE 开场', 'A', '', 'B', 'MACHINE.END']);
  });

  it('CRLF 源与 LF 源产物逐字节相同（换行归一在产物侧，块体内容不变）', () => {
    const lf = compile(PROBE).erb;
    const crlf = compile(PROBE_LINES.join('\r\n')).erb;
    expect(hex(crlf)).toBe(hex(lf));
  });

  it('字节级 golden：整段产物 UTF-8 逐字节相等（含 CJK / emoji 代理对 / Tab / 行尾 `\\`）', () => {
    const result = compile(PROBE);
    expect(hex(result.erb)).toBe(
      '4d414348494e4520e5bc80e59cba0a494620410a202020205052494e542031205c0a0a' +
        '3b2045524220636f6d6d656e740a0953455420412c2022e781b5e6a2a6f09f9880220a' +
        '454e4449460a54454c4c3a20e587bae58ebb202f574149540a4d414348494e452e454e440a',
    );
    // emoji（U+1F600）= 4 字节 `f0 9f 98 80`，一个字节都不许被改写
    expect(hex(result.erb)).toContain('f09f9880');
  });

  it('块内 Tab 原样进产物（去缩进只吃基准宽度，不吃内容 Tab）', () => {
    // 基准缩进由 `    A` 定为 4；第二行的 `\t` 是**内容**（相对缩进），必须原样保留
    const source = ['# 机 开场', '@原生', '    A', '    \tCALL 甲', '> x'].join('\n');
    const result = compile(source);
    expect(rows(result.erb)).toEqual(['MACHINE 开场', 'A', '\tCALL 甲', 'TELL: x /WAIT', 'MACHINE.END']);
    expect(errorsOf(source)).toEqual([]);
  });

  it('`[SKIPSTART]` / `#DIM` 在 `@原生` 里只是文本：不当死区/预处理器解释', () => {
    const source = ['# 机 开场', '@原生', '    [SKIPSTART]', '    #DIM X, 0', '    [SKIPEND]'].join('\n');
    const result = compile(source);
    expect(errorsOf(source)).toEqual([]);
    expect(rows(result.erb)).toEqual([
      'MACHINE 开场',
      '[SKIPSTART]',
      '#DIM X, 0',
      '[SKIPEND]',
      'MACHINE.END',
    ]);
  });

  it('块内行尾空白原样保留（透传不是 trim）', () => {
    const source = ['# 机 开场', '@原生', '    A   ', '> x'].join('\n');
    const result = compile(source);
    expect(rows(result.erb)[1]).toBe('A   ');
  });

  it('块体尾部空行是块与下一行的分隔：不进块体（既有口径，钉住）', () => {
    const source = ['# 机 开场', '@原生', '    A', '', '> x'].join('\n');
    const result = compile(source);
    expect(rows(result.erb)).toEqual(['MACHINE 开场', 'A', 'TELL: x /WAIT', 'MACHINE.END']);
  });

  it('纯空白行按 §8.5「空行原样保留」逐字节保留缩进空白（不归一为空行）', () => {
    const source = ['# 机 开场', '@原生', '    A', '       ', '    B', '> x'].join('\n');
    const result = compile(source);
    expect(errorsOf(source)).toEqual([]);
    expect(rows(result.erb)).toEqual(['MACHINE 开场', 'A', '       ', 'B', 'TELL: x /WAIT', 'MACHINE.END']);
    // 7 个半角空格一个不少（旧口径会变成空串，静默丢 7 字节）
    expect(hex(rows(result.erb)[2]!)).toBe('20202020202020');
    // 该产物行折回物理第 4 行整行：1..8（1 基、半开）
    expect(result.sourceMap.lineAt(3)?.source).toEqual({
      start: { line: 4, column: 1 },
      end: { line: 4, column: 8 },
    });
  });
});

/* ============================================================================ */
/* C2. 块边界按物理行缩进判定（`\` 不折行、`@` / `[SKIPSTART]` 不开新块）          */
/* ============================================================================ */

describe('C2. `@原生` 块边界（物理行缩进；围栏内不解释 2.0 锚点）', () => {
  it('块内行尾 `\\` 不把块外行折进块体：缩进回到块头即结束围栏', () => {
    const source = ['# 机 开场', '@原生', '    A \\', '> x'].join('\n');
    const result = compile(source);
    expect(errorsOf(source)).toEqual([]);
    expect(rows(result.erb)).toEqual(['MACHINE 开场', 'A \\', 'TELL: x /WAIT', 'MACHINE.END']);
  });

  it('块内以 `@` 开头的行只是 ERB 文本：不开新块、不产迁移诊断', () => {
    const source = ['# 机 开场', '@原生', '    @M_KOJO_K12_310', '    PRINT X', '> x'].join('\n');
    const result = compile(source);
    expect(errorsOf(source)).toEqual([]);
    expect(rows(result.erb)).toEqual([
      'MACHINE 开场',
      '@M_KOJO_K12_310',
      'PRINT X',
      'TELL: x /WAIT',
      'MACHINE.END',
    ]);
  });

  it('块内再写 `@原生` 不嵌套：整段仍是一块（围栏不递归）', () => {
    const source = ['# 机 开场', '@原生', '    @原生', '    A', '> x'].join('\n');
    const result = compile(source);
    expect(errorsOf(source)).toEqual([]);
    expect(rows(result.erb)).toEqual(['MACHINE 开场', '@原生', 'A', 'TELL: x /WAIT', 'MACHINE.END']);
    // 两行都是同一块的逐行映射（源行 3 / 4）
    expect(result.sourceMap.lineAt(2)?.source?.start.line).toBe(3);
    expect(result.sourceMap.lineAt(3)?.source?.start.line).toBe(4);
  });
});

/* ============================================================================ */
/* D. 块外零变化对照                                                             */
/* ============================================================================ */

describe('D. 块外零变化对照', () => {
  it('`@原生` 前后的普通行顺序与文本不变（块内不改块外）', () => {
    const source = ['# 机 开场', '> 前', '@原生', '    A', '> 后'].join('\n');
    const result = compile(source);
    expect(rows(result.erb)).toEqual(['MACHINE 开场', 'TELL: 前 /WAIT', 'A', 'TELL: 后 /WAIT', 'MACHINE.END']);
  });

  it('无 `@原生` 的基线源逐字节不变（回归对照）', () => {
    const source = ['# 机 开场', '> 甲', '> 乙'].join('\n');
    expect(compile(source).erb).toBe('MACHINE 开场\nTELL: 甲 /WAIT\nTELL: 乙 /WAIT\nMACHINE.END\n');
  });

  it('块外折行语义不受影响：`@原生` 之外的文本行仍按 2.0 规则（无折行概念）', () => {
    const source = ['# 机 开场', '> 甲', '@原生', '    A \\', '    B', '> 乙'].join('\n');
    const result = compile(source);
    expect(rows(result.erb)).toEqual([
      'MACHINE 开场',
      'TELL: 甲 /WAIT',
      'A \\',
      'B',
      'TELL: 乙 /WAIT',
      'MACHINE.END',
    ]);
  });
});

/* ============================================================================ */
/* E. 诊断物理坐标（去缩进不改诊断行）                                            */
/* ============================================================================ */

describe('E. `@原生` 诊断坐标', () => {
  it('空块 `core/native/empty`：span 落在块头物理行；CRLF 下不漂移', () => {
    const lf = compile(['# 机 开场', '@原生', '> x'].join('\n'));
    const empty = lf.diagnostics.find((d) => d.code === 'core/native/empty')!;
    expect(empty.severity).toBe('error');
    expect(empty.span?.start.line).toBe(2);
    expect(lf.erb).toBe('');
    const crlf = compile(['# 机 开场', '@原生', '> x'].join('\r\n'));
    expect(crlf.diagnostics.find((d) => d.code === 'core/native/empty')?.span?.start.line).toBe(2);
  });

  it('禁止位置 `core/native/disallowed-location`：span 落在 `@原生` 块头物理行', () => {
    const source = ['# 机 开场', '@随机', '    @原生', '        X', '    > 甲'].join('\n');
    const result = compile(source);
    const hit = result.diagnostics.find((d) => d.code === 'core/native/disallowed-location');
    expect(hit?.severity).toBe('error');
    expect(hit?.span?.start.line).toBe(3);
  });

  it('块体缩进不足 `core/native/indent`：span 落在**违规行**物理行（不是块头）', () => {
    // 块头在第 2 行；块体第 3 行只有 2 空格（深于块头、不足一级）⇒ 诊断指向第 3 行整行原文
    const source = ['# 机 开场', '@原生', '  X'].join('\n');
    const hit = compile(source).diagnostics.find((d) => d.code === 'core/native/indent');
    expect(hit?.severity).toBe('error');
    expect(hit?.span).toEqual({ start: { line: 3, column: 1 }, end: { line: 3, column: 4 } });
  });

  it('CJK / emoji 不改变诊断行号（列按码元，行按物理行）', () => {
    const source = ['# 机 开场', '@原生', '    😀甲', '> x'].join('\n');
    const result = compile(source);
    expect(errorsOf(source)).toEqual([]);
    expect(rows(result.erb)[1]).toBe('😀甲');
    expect(result.sourceMap.lineAt(2)?.source?.start.line).toBe(3);
  });
});

/* ============================================================================ */
/* G. K2-NATIVE-COLUMNS：parser 的 `lineColumns` 与物理列/字节（口径写死）        */
/* ============================================================================ */

/**
 * 探针：Tab 缩进 / 全角空格 / 纯空白行（半角+全角）/ 行尾全角空白 / emoji / CJK。
 *
 * 块头在第 2 行，块体第 3..9 行；基准缩进 = 4（块内非空行的 `indentWidth` 最小值）。
 * 行 4 `\tB` 的 Tab = 4 宽 = 基准 ⇒ 整枚 Tab 被剥（`removed = 1`，起点列 2）。
 * 行 5 `    　C` 是 4 空格 + 全角空格 + C：全角空格**不是**词法层 `indentWidth` 的一部分，
 * 剥到 4 宽即停 ⇒ U+3000 作为相对缩进保留（起点列 5）。
 */
const COLUMNS_LINES = [
  '# 机 开场',
  '@原生',
  '    IF A',
  '\tB',
  '    　C',
  '  　　  ',
  '    D　E  ',
  '    😀甲',
  '    Z',
  '> 出去',
];
const COLUMNS = COLUMNS_LINES.join('\n');

/** parser 产出的 `@原生` 节点（真前端，不手搓） */
function parsedNative(source: string): KojoNativeBlock {
  const node = parseSource(source).scenes[0]!.items.find((item) => item.kind === 'nativeBlock');
  if (node === undefined) throw new Error('源里没有 @原生 块');
  return node as KojoNativeBlock;
}

/** 源第 `line` 行（1 基）从 `column` 起的 `length` 个码元（逐字节切片的对照） */
function sourceSlice(source: string, line: number, column: number, length: number): string {
  return source.split(/\r?\n/)[line - 1]!.slice(column - 1, column - 1 + length);
}

describe('G. `lineColumns` 口径：被剥码元数 + 1（物理列）', () => {
  it('parser 恒提供 `lineColumns`，长度与 lines 对齐，且 = [5,2,5,1,5,5,5]', () => {
    const node = parsedNative(COLUMNS);
    expect(node.lineColumns).toHaveLength(node.lines.length);
    expect(node.lineColumns).toEqual([5, 2, 5, 1, 5, 5, 5]);
    // Tab 只允许出现在 `@原生` 块体里：块内 Tab 不产 `core/lex/indent`
    expect(errorsOf(COLUMNS)).toEqual([]);
  });

  it('每一行都等于「源物理行按 lineColumns 起的切片」：逐字节相等', () => {
    const node = parsedNative(COLUMNS);
    for (let i = 0; i < node.lines.length; i++) {
      const column = node.lineColumns![i]!;
      const text = node.lines[i]!;
      expect(sourceSlice(COLUMNS, 3 + i, column, text.length), `line ${i}`).toBe(text);
    }
  });

  it('Tab 缩进：整枚 Tab（4 宽）被剥 ⇒ 起点列 2，span 4:2..4:3', () => {
    const node = parsedNative(COLUMNS);
    expect(node.lines[1]).toBe('B');
    expect(node.lineColumns![1]).toBe(2);
    expect(compile(COLUMNS).sourceMap.lineAt(3)?.source).toEqual({
      start: { line: 4, column: 2 },
      end: { line: 4, column: 3 },
    });
  });

  it('全角空格不是词法缩进：剥到基准 4 即停，U+3000 作为相对缩进保留（起点列 5）', () => {
    const node = parsedNative(COLUMNS);
    expect(node.lines[2]).toBe('　C');
    expect(hex(node.lines[2]!)).toBe('e3808043');
    expect(node.lineColumns![2]).toBe(5);
    expect(compile(COLUMNS).sourceMap.lineAt(4)?.source).toEqual({
      start: { line: 5, column: 5 },
      end: { line: 5, column: 7 },
    });
  });

  it('纯空白行：物理行原文（半角 + 两个全角 + 半角），起点列 1，span 覆盖整行', () => {
    const node = parsedNative(COLUMNS);
    expect(node.lines[3]).toBe('  　　  ');
    expect(hex(node.lines[3]!)).toBe('2020e38080e380802020'); // 10 字节，一个不少
    expect(node.lineColumns![3]).toBe(1);
    expect(compile(COLUMNS).sourceMap.lineAt(5)?.source).toEqual({
      start: { line: 6, column: 1 },
      end: { line: 6, column: 7 }, // 6 码元 + 1
    });
  });

  it('只含全角空格的物理行也按纯空白行处理：原文保留、起点列 1', () => {
    const source = ['# 机 开场', '@原生', '    A', '　　', '    B', '> x'].join('\n');
    const node = parsedNative(source);
    expect(node.lines[1]).toBe('　　');
    expect(hex(node.lines[1]!)).toBe('e38080e38080');
    expect(node.lineColumns![1]).toBe(1);
    expect(rows(compile(source).erb)[2]).toBe('　　');
  });

  it('CRLF 源：lineColumns / 行文本 / span 与 LF 逐值相同（EOL 不重算列）', () => {
    const lf = parsedNative(COLUMNS);
    const crlf = parsedNative(COLUMNS_LINES.join('\r\n'));
    expect(crlf.lineColumns).toEqual(lf.lineColumns);
    expect(crlf.lines).toEqual(lf.lines);
    const lfResult = compile(COLUMNS);
    const crlfResult = compile(COLUMNS_LINES.join('\r\n'));
    expect(crlfResult.erb).toBe(lfResult.erb);
    for (let line = 1; line <= lfResult.sourceMap.lineCount; line++) {
      expect(crlfResult.sourceMap.lineAt(line)?.source).toEqual(lfResult.sourceMap.lineAt(line)?.source);
    }
  });

  it('emoji 行：起点列 5 + 文本 3 码元（😀 代理对占 2）⇒ span 8:5..8:8', () => {
    const node = parsedNative(COLUMNS);
    expect(node.lines[5]).toBe('😀甲');
    expect(node.lines[5]!.length).toBe(3);
    expect(node.lineColumns![5]).toBe(5);
    expect(compile(COLUMNS).sourceMap.lineAt(7)?.source).toEqual({
      start: { line: 8, column: 5 },
      end: { line: 8, column: 8 },
    });
  });

  it('同形不同列：`        X`（8 空格）与 `\\t\\tX`（两 Tab）去缩进后同形，但起点列 9 / 3', () => {
    const source = ['# 机 开场', '@原生', '        X', '\t\tX'].join('\n');
    const node = parsedNative(source);
    expect(node.lines).toEqual(['X', 'X']);
    expect(node.lineColumns).toEqual([9, 3]);
    const result = compile(source);
    expect(result.sourceMap.lineAt(2)?.source).toEqual({
      start: { line: 3, column: 9 },
      end: { line: 3, column: 10 },
    });
    expect(result.sourceMap.lineAt(3)?.source).toEqual({
      start: { line: 4, column: 3 },
      end: { line: 4, column: 4 },
    });
  });

  it('混合缩进：基准 8 下，8 空格剥 8（列 9）、两 Tab 剥 2（列 3）、`\\t` 留在内容里', () => {
    const source = ['# 机 开场', '@原生', '        A', '\t\tB', '        \tC', '> x'].join('\n');
    const node = parsedNative(source);
    expect(node.lines).toEqual(['A', 'B', '\tC']);
    expect(node.lineColumns).toEqual([9, 3, 9]);
    expect(rows(compile(source).erb)).toEqual(['MACHINE 开场', 'A', 'B', '\tC', 'TELL: x /WAIT', 'MACHINE.END']);
  });

  it('越界夹取走同一入口：已解析行的视图列 0 / 999 夹到行首 / 行尾之后', () => {
    expect(foldDedentedPosition(nativeLineView(4, 2, 'B'), { line: 4, column: 0 })).toEqual({ line: 4, column: 2 });
    expect(foldDedentedPosition(nativeLineView(4, 2, 'B'), { line: 4, column: 999 })).toEqual({ line: 4, column: 3 });
    expect(foldDedentedPosition(nativeLineView(6, 1, '  　　  '), { line: 6, column: 999 })).toEqual({ line: 6, column: 7 });
  });

  it('幂等（纯函数）：同一源两次 parse / 两次 compile，列与行级 span 逐值相同', () => {
    expect(parsedNative(COLUMNS)).toEqual(parsedNative(COLUMNS));
    const read = (source: string) => {
      const result = compile(source);
      const out: string[] = [];
      for (let line = 1; line <= result.sourceMap.lineCount; line++) {
        out.push(JSON.stringify(result.sourceMap.lineAt(line)?.source ?? null));
      }
      return out;
    };
    expect(read(COLUMNS)).toEqual(read(COLUMNS));
  });

  it('块尾纯空白行仍是块与下一行的分隔：不进块体、不产字节（既有口径）', () => {
    const source = ['# 机 开场', '@原生', '    A', '   ', '> x'].join('\n');
    const node = parsedNative(source);
    expect(node.lines).toEqual(['A']);
    expect(node.lineColumns).toEqual([5]);
    expect(rows(compile(source).erb)).toEqual([
      'MACHINE 开场',
      'A',
      'TELL: x /WAIT',
      'MACHINE.END',
    ]);
  });

  it('产物里块体逐字节少掉的只有基准缩进：全角/emoji/Tab 内容字节零丢失', () => {
    const result = compile(COLUMNS);
    const product = rows(result.erb).slice(1, 8);
    expect(product).toEqual(['IF A', 'B', '　C', '  　　  ', 'D　E  ', '😀甲', 'Z']);
    const productHex = hex(product.join('\n'));
    expect(productHex).toContain('e3808043'); // 全角空格 + C
    expect(productHex).toContain('2020e38080e380802020'); // 纯空白行原文
    expect(productHex).toContain('f09f9880e794b2'); // 😀甲
    expect(productHex).toContain('44e380804520200a'); // `D　E  ` 含行尾两空格
  });
});

/* ============================================================================ */
/* F. `column-fold.ts`：折回唯一实现（含 v1 折行语义）                            */
/* ============================================================================ */

describe('F. `column-fold` 折回语义（v1 折行面同口径）', () => {
  /** 源：`甲 \` + 换行 + `   乙`（逻辑行 = `甲 乙`，第 2 段在第 2 行第 4 列起） */
  const folded: SourceLineView = {
    text: '甲 乙',
    segments: [
      { offset: 0, line: 1, column: 1 },
      { offset: 2, line: 2, column: 4 },
    ],
  };
  const views = new Map<number, SourceLineView>([[1, folded]]);
  const fold = (line: number, column: number) => foldPositionToPhysical(views, { line, column });

  it('段内逐码元平移：首段 / 续接段各自落自己的物理行列', () => {
    expect(fold(1, 1)).toEqual({ line: 1, column: 1 });
    expect(fold(1, 2)).toEqual({ line: 1, column: 2 });
    expect(fold(1, 3)).toEqual({ line: 2, column: 4 });
  });

  it('越界夹取：列越过逻辑全文 ⇒ 末段末尾（不抛错、不回落到首行起点）', () => {
    expect(fold(1, 9999)).toEqual({ line: 2, column: 5 });
  });

  it('越界夹取：列 < 1（0 / 负数）⇒ 行首', () => {
    expect(fold(1, 0)).toEqual({ line: 1, column: 1 });
    expect(fold(1, -5)).toEqual({ line: 1, column: 1 });
  });

  it('未折行 / 不是逻辑行首 ⇒ 原样返回（幂等）', () => {
    const flat = new Map<number, SourceLineView>([[1, { text: '单行', segments: [{ offset: 0, line: 1, column: 1 }] }]]);
    expect(foldPositionToPhysical(flat, { line: 1, column: 7 })).toEqual({ line: 1, column: 7 });
    expect(fold(2, 4)).toEqual({ line: 2, column: 4 }); // 续接物理行没有自己的视图
    const once = fold(1, 3)!;
    expect(foldPositionToPhysical(views, once)).toEqual(once);
  });

  it('CJK / emoji 偏移按 UTF-16 码元（代理对占两格）', () => {
    const emojiView: SourceLineView = {
      text: '😀甲',
      segments: [
        { offset: 0, line: 1, column: 1 },
        { offset: 2, line: 2, column: 3 },
      ],
    };
    const map = new Map<number, SourceLineView>([[1, emojiView]]);
    expect(foldPositionToPhysical(map, { line: 1, column: 2 })).toEqual({ line: 1, column: 2 });
    expect(foldPositionToPhysical(map, { line: 1, column: 3 })).toEqual({ line: 2, column: 3 });
  });

  it('`clampLogicalOffset` 口径写死：0/负 ⇒ 0；超长 ⇒ 文本长度；非有限 ⇒ 0', () => {
    expect(clampLogicalOffset(1, 5)).toBe(0);
    expect(clampLogicalOffset(0, 5)).toBe(0);
    expect(clampLogicalOffset(-5, 5)).toBe(0);
    expect(clampLogicalOffset(6, 5)).toBe(5);
    expect(clampLogicalOffset(9999, 5)).toBe(5);
    expect(clampLogicalOffset(Number.NaN, 5)).toBe(0);
  });

  it('`logicalPosition` 空段表退化不抛错（保守值）', () => {
    expect(logicalPosition([], 3)).toEqual({ line: 1, column: 4 });
  });

  it('去缩进视图：`nativeLineView` 的起点列 + `foldDedentedPosition` 单段也折', () => {
    const view = nativeLineView(7, 5, '灵梦😀');
    expect(foldDedentedPosition(view, { line: 7, column: 1 })).toEqual({ line: 7, column: 5 });
    expect(foldDedentedPosition(view, { line: 7, column: 4 })).toEqual({ line: 7, column: 8 });
    expect(foldDedentedPosition(view, { line: 7, column: 999 })).toEqual({ line: 7, column: 9 });
    expect(foldDedentedPosition(view, { line: 7, column: 0 })).toEqual({ line: 7, column: 5 });
  });

  it('`nativeLineView` 的非法起点列夹到 1（内部契约兜底，不抛错）', () => {
    expect(nativeLineView(1, 0, 'A').segments[0]).toEqual({ offset: 0, line: 1, column: 1 });
    expect(nativeLineView(1, Number.NaN, 'A').segments[0]).toEqual({ offset: 0, line: 1, column: 1 });
  });

  it('core 公共面导出的是同一枚函数（`src/index.ts` ↔ `lower/column-fold.ts`）', () => {
    expect(foldFromPublicSurface).toBe(foldPositionToPhysical);
  });
});
