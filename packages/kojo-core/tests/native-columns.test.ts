/**
 * K2-NATIVE-COLUMNS：`@原生` 的**物理列**契约（parser → ast.lineColumns → source map）。
 *
 * 判据（全部带读数，口径写死）：
 * 1. `lineColumns[i]` = `lines[i]` 第一个码元在**物理源行**里的 1 基列（UTF-16 码元）；
 *    非空行 = 被剥掉的码元数 + 1，纯空白行 = 1（视图文本 = 物理行原文，折回恒等）。
 * 2. 去缩进尺子与 `kojo-sugar/blank-charset.ts::indentLevelOf` 同一套：空格 1 / Tab 4 /
 *    全角空格 U+3000 = 2；Tab 整枚剥、绝不切半个字；全角空格不是词法缩进，剥到基准即停。
 * 3. **字节零丢失**：每一行都等于源物理行按 `lineColumns` 起的切片；纯空白行保留缩进空白
 *    （§8.5「空行原样保留」压过 §C2.10 规则 4「归一空行」，裁定依据见 `parseNativeBlock`）。
 * 4. 诊断列不漂：`core/native/indent` / `core/native/empty` 的 span 仍是**物理**行列。
 *
 * 只读真前端（`parseSource` / `compileKojoSource`），不手搓节点冒充 parser 产物。
 */
import { describe, expect, it } from 'vitest';
import type {
  KojoNativeBlock,
  KojoSandboxBlock,
  KojoWeaveDecl,
} from '../src/ast.js';
import { compileKojoSource } from '../src/compile.js';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '../src/fixture-adapter.js';
import { foldDedentedPosition, nativeLineView } from '../src/lower/column-fold.js';
import { parseSource } from '../src/parser.js';

/* ============================== 工具 ============================== */

const compile = (source: string) =>
  compileKojoSource({ source, adapter: FIXTURE_ADAPTER, backend: FIXTURE_BACKEND });

const errorsOf = (source: string) => compile(source).diagnostics.filter((d) => d.severity === 'error');

const rows = (erb: string): string[] => (erb === '' ? [] : erb.replace(/\n$/, '').split('\n'));

const hex = (text: string): string =>
  [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** 源第 `line` 行（1 基）从 1 基 `column` 起的 `length` 个码元 */
const sliceAt = (source: string, line: number, column: number, length: number): string =>
  source.split(/\r?\n/)[line - 1]!.slice(column - 1, column - 1 + length);

const topNative = (source: string): KojoNativeBlock => {
  const node = parseSource(source).scenes[0]!.items.find((item) => item.kind === 'nativeBlock');
  if (node === undefined) throw new Error('源里没有顶层 @原生 块');
  return node as KojoNativeBlock;
};

const sandboxNative = (source: string): KojoNativeBlock => {
  const sandbox = parseSource(source).scenes[0]!.items.find(
    (item): item is KojoSandboxBlock => item.kind === 'sandboxBlock',
  );
  if (sandbox === undefined) throw new Error('源里没有 @算');
  const node = sandbox.body.find((item): item is KojoNativeBlock => item.kind === 'nativeBlock');
  if (node === undefined) throw new Error('@算 里没有 @原生');
  return node;
};

/* ============================== 探针源 ============================== */

/**
 * 混合缩进探针：块头第 2 行，块体第 3..9 行，基准缩进 4（非空行 `indentWidth` 最小值）。
 * - 行 4 `\tSET B, 1`：Tab 整枚 = 4 宽 ⇒ 剥 1 个码元，起点列 2；
 * - 行 5 `    　C`：4 空格 + 全角空格（不算词法缩进）⇒ 起点列 5，U+3000 作为相对缩进保留；
 * - 行 6 `        D`：8 空格，基准 4 ⇒ 只剥 4（去缩进只吃**基准宽度**），相对缩进 4 保留，列 5；
 * - 行 7 `  　　  `：纯空白行（6 码元）⇒ 原文保留，起点列 1；
 * - 行 8 `    😀甲`：emoji 代理对 2 码元 ⇒ 起点列 5、宽度 3。
 */
const MIXED_LINES = [
  '# 机 开场',
  '@原生',
  '    IF A',
  '\tSET B, 1',
  '    　C',
  '        D',
  '  　　  ',
  '    😀甲',
  '    Z',
  '> 出去',
];
const MIXED = MIXED_LINES.join('\n');
const MIXED_COLUMNS = [5, 2, 5, 5, 1, 5, 5];

/* ============================================================================ */
/* A. `lineColumns` 与源切片逐字节对得上                                          */
/* ============================================================================ */

describe('A. `lineColumns` → 源切片（逐字节）', () => {
  it('长度与 lines 对齐、每个值都是 ≥1 的整数：MIXED = [5,2,5,9,1,5,5]', () => {
    const node = topNative(MIXED);
    expect(node.lineColumns).toHaveLength(node.lines.length);
    expect(node.lineColumns).toEqual(MIXED_COLUMNS);
    for (const column of node.lineColumns!) {
      expect(Number.isInteger(column)).toBe(true);
      expect(column).toBeGreaterThanOrEqual(1);
    }
    expect(errorsOf(MIXED)).toEqual([]);
  });

  it('每一行 = 源物理行从 lineColumns 起的切片（非空行 / 纯空白行都逐字节相等）', () => {
    const node = topNative(MIXED);
    for (let i = 0; i < node.lines.length; i++) {
      const line = 3 + i;
      const column = node.lineColumns![i]!;
      const text = node.lines[i]!;
      expect(sliceAt(MIXED, line, column, text.length), `第 ${i} 行`).toBe(text);
    }
  });

  it('lineColumns 是去缩进视图的起点：视图内首个内容字符 = 列 + 残余相对缩进', () => {
    const node = topNative(MIXED);
    for (let i = 0; i < node.lines.length; i++) {
      const text = node.lines[i]!;
      const content = text.replace(/^[ \t\u3000]+/, '');
      if (content.length === 0) continue; // 纯空白行没有内容字符
      const column = node.lineColumns![i]!;
      const raw = MIXED.split('\n')[2 + i]!;
      const relative = text.length - content.length;
      expect(raw.charAt(column - 1 + relative), `第 ${i} 行首个内容字符`).not.toMatch(/^[ \t\u3000]$/);
      expect(raw.slice(column - 1 + relative, column - 1 + text.length)).toBe(content);
    }
  });

  it('Tab 缩进：整枚 Tab（4 宽）被剥 ⇒ 列 2，span 4:2..4:10', () => {
    const node = topNative(MIXED);
    expect(node.lines[1]).toBe('SET B, 1');
    expect(node.lineColumns![1]).toBe(2);
    expect(compile(MIXED).sourceMap.lineAt(3)?.source).toEqual({
      start: { line: 4, column: 2 },
      end: { line: 4, column: 10 },
    });
  });

  it('全角空格不是词法缩进：剥到基准 4 即停，U+3000 作为相对缩进保留（列 5）', () => {
    const node = topNative(MIXED);
    expect(node.lines[2]).toBe('　C');
    expect(hex(node.lines[2]!)).toBe('e3808043');
    expect(node.lineColumns![2]).toBe(5);
    expect(compile(MIXED).sourceMap.lineAt(4)?.source).toEqual({
      start: { line: 5, column: 5 },
      end: { line: 5, column: 7 },
    });
  });

  it('同形不同列：`        X` 与 `\\t\\tX` 去缩进后同形，列分别是 9 / 3（无法从文本反推）', () => {
    const source = ['# 机 开场', '@原生', '        X', '\t\tX'].join('\n');
    const node = topNative(source);
    expect(node.lines).toEqual(['X', 'X']);
    expect(node.lineColumns).toEqual([9, 3]);
  });

  it('内容 Tab 保留：基准 4 下 `    \\tCALL` 只剥 4 空格，列 5（Tab 是内容不是缩进）', () => {
    const source = ['# 机 开场', '@原生', '    A', '    \tCALL', '> x'].join('\n');
    const node = topNative(source);
    expect(node.lines[1]).toBe('\tCALL');
    expect(node.lineColumns![1]).toBe(5);
    expect(compile(source).sourceMap.lineAt(3)?.source).toEqual({
      start: { line: 4, column: 5 },
      end: { line: 4, column: 10 },
    });
  });

  it('emoji 行：起点 5 + 3 码元（😀 占 2）⇒ span 8:5..8:8', () => {
    const node = topNative(MIXED);
    expect(node.lines[5]).toBe('😀甲');
    expect(node.lineColumns![5]).toBe(5);
    expect(compile(MIXED).sourceMap.lineAt(7)?.source).toEqual({
      start: { line: 8, column: 5 },
      end: { line: 8, column: 8 },
    });
  });
});

/* ============================================================================ */
/* B. 纯空白行：字节零丢失（§8.5 压过 §C2.10 规则 4）                             */
/* ============================================================================ */

describe('B. 纯空白行 = 物理行原文', () => {
  it('半角 + 两个全角 + 半角：10 字节一个不少，列 1，span 覆盖整行 7:1..7:7', () => {
    const node = topNative(MIXED);
    expect(node.lines[4]).toBe('  　　  ');
    expect(hex(node.lines[4]!)).toBe('2020e38080e380802020');
    expect(node.lineColumns![4]).toBe(1);
    expect(compile(MIXED).sourceMap.lineAt(6)?.source).toEqual({
      start: { line: 7, column: 1 },
      end: { line: 7, column: 7 },
    });
  });

  it('纯 Tab 的空白行：Tab 只允许在 `@原生` 体里，原文（`\\t\\t`）保留、列 1', () => {
    const source = ['# 机 开场', '@原生', '    A', '\t\t', '    B', '> x'].join('\n');
    const node = topNative(source);
    expect(node.lines[1]).toBe('\t\t');
    expect(hex(node.lines[1]!)).toBe('0909');
    expect(node.lineColumns![1]).toBe(1);
    expect(errorsOf(source)).toEqual([]);
    expect(rows(compile(source).erb)[2]).toBe('\t\t');
  });

  it('零码元空行：lines = ""、列 1、零宽 span（4:1..4:1，不给假列）', () => {
    const source = ['# 机 开场', '@原生', '    A', '', '    B', '> x'].join('\n');
    const node = topNative(source);
    expect(node.lines[1]).toBe('');
    expect(node.lineColumns![1]).toBe(1);
    expect(compile(source).sourceMap.lineAt(3)?.source).toEqual({
      start: { line: 4, column: 1 },
      end: { line: 4, column: 1 },
    });
  });

  it('CRLF 源：lineColumns / lines / 行级 span 与 LF 逐值相同，产物不留 `\\r`', () => {
    const lf = topNative(MIXED);
    const crlf = topNative(MIXED_LINES.join('\r\n'));
    expect(crlf.lineColumns).toEqual(lf.lineColumns);
    expect(crlf.lines).toEqual(lf.lines);
    expect(crlf.lines.some((line) => line.includes('\r'))).toBe(false);
    const lfResult = compile(MIXED);
    const crlfResult = compile(MIXED_LINES.join('\r\n'));
    expect(crlfResult.erb).toBe(lfResult.erb);
    for (let line = 1; line <= lfResult.sourceMap.lineCount; line++) {
      expect(crlfResult.sourceMap.lineAt(line)?.source, `行 ${line}`).toEqual(
        lfResult.sourceMap.lineAt(line)?.source,
      );
    }
  });
});

/* ============================================================================ */
/* C. 嵌套块：绝对物理行 / 列（不是块内相对坐标）                                 */
/* ============================================================================ */

describe('C. 嵌套块里的 `@原生`', () => {
  it('`@算` 内：`@原生` 体 8 空格缩进 ⇒ 列 9，span 落在物理第 4 行', () => {
    const source = ['# 机 开场', '@算', '    @原生', '        A', '        B', '> 出去'].join('\n');
    const node = sandboxNative(source);
    expect(node.lines).toEqual(['A', 'B']);
    expect(node.lineColumns).toEqual([9, 9]);
    const result = compile(source);
    expect(errorsOf(source)).toEqual([]);
    const product = rows(result.erb);
    const index = product.indexOf('A');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(result.sourceMap.lineAt(index + 1)?.source).toEqual({
      start: { line: 4, column: 9 },
      end: { line: 4, column: 10 },
    });
    expect(result.sourceMap.lineAt(index + 2)?.source).toEqual({
      start: { line: 5, column: 9 },
      end: { line: 5, column: 10 },
    });
  });

  it('`@算` › `@算` 内：`@原生` 体 12 空格缩进 ⇒ 列 13，span 落在物理第 5 行', () => {
    const source = ['# 机 开场', '@算', '    @算', '        @原生', '            A', '> 出去'].join(
      '\n',
    );
    const outer = parseSource(source).scenes[0]!.items.find(
      (item): item is KojoSandboxBlock => item.kind === 'sandboxBlock',
    )!;
    const inner = outer.body.find((item): item is KojoSandboxBlock => item.kind === 'sandboxBlock')!;
    const node = inner.body.find((item): item is KojoNativeBlock => item.kind === 'nativeBlock')!;
    expect(node.lines).toEqual(['A']);
    expect(node.lineColumns).toEqual([13]);
    const result = compile(source);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const index = rows(result.erb).indexOf('A');
    expect(result.sourceMap.lineAt(index + 1)?.source).toEqual({
      start: { line: 5, column: 13 },
      end: { line: 5, column: 14 },
    });
  });

  it('`@织` 体内：`@原生` 体 8 空格缩进 ⇒ 列 9（decl 体同样按物理列记）', () => {
    const source = ['# 机 开场', '> 正文。', '@织 开场', '    @原生', '        A'].join('\n');
    const weave = parseSource(source).decls.find((decl): decl is KojoWeaveDecl => decl.kind === 'weave')!;
    const node = weave.body.find((item): item is KojoNativeBlock => item.kind === 'nativeBlock')!;
    expect(node.lines).toEqual(['A']);
    expect(node.lineColumns).toEqual([9]);
    expect(errorsOf(source)).toEqual([]);
  });

  it('同一文件多个 `@原生`：各自的 lineColumns 互不串台（各自块内行序对齐）', () => {
    const source = [
      '# 机 开场',
      '@原生',
      '    A',
      '> 中间。',
      '@原生',
      '        B',
      '        C',
    ].join('\n');
    const natives = parseSource(source)
      .scenes[0]!.items.filter((item): item is KojoNativeBlock => item.kind === 'nativeBlock');
    expect(natives).toHaveLength(2);
    expect(natives[0]!.lineColumns).toEqual([5]);
    expect(natives[1]!.lineColumns).toEqual([9, 9]);
  });
});

/* ============================================================================ */
/* D. 诊断列不漂（物理行 / 物理列；去缩进不改诊断坐标）                           */
/* ============================================================================ */

describe('D. `@原生` 相关诊断的列仍是物理列', () => {
  it('`core/native/indent`：span 落在违规行整行原文上（CJK 按码元，1..4）', () => {
    const source = ['# 机 开场', '@原生', '  甲'].join('\n');
    const hit = compile(source).diagnostics.find((d) => d.code === 'core/native/indent');
    expect(hit?.span).toEqual({ start: { line: 3, column: 1 }, end: { line: 3, column: 4 } });
    // CRLF 不漂
    const crlf = compile(['# 机 开场', '@原生', '  甲'].join('\r\n')).diagnostics.find(
      (d) => d.code === 'core/native/indent',
    );
    expect(crlf?.span).toEqual(hit?.span);
  });

  it('`core/native/empty`：`@算` 内缩进的块头，span 从内容列起（3:5..3:8）', () => {
    const source = ['# 机 开场', '@算', '    @原生', '    x = 1'].join('\n');
    const hit = compile(source).diagnostics.find((d) => d.code === 'core/native/empty');
    expect(hit?.severity).toBe('error');
    expect(hit?.span).toEqual({ start: { line: 3, column: 5 }, end: { line: 3, column: 8 } });
  });

  it('块内 `#` / `?` / `>` 只是 ERB 原文：不产诊断，列按内容起点（5）而不是块头列', () => {
    const source = ['# 机 开场', '@原生', '    #DIM X, 0', '    ? x', '    > y', '> 尾行'].join('\n');
    const node = topNative(source);
    expect(errorsOf(source)).toEqual([]);
    expect(node.lines).toEqual(['#DIM X, 0', '? x', '> y']);
    expect(node.lineColumns).toEqual([5, 5, 5]);
    const result = compile(source);
    for (let i = 0; i < 3; i++) {
      expect(result.sourceMap.lineAt(2 + i)?.source).toEqual({
        start: { line: 3 + i, column: 5 },
        end: { line: 3 + i, column: 5 + node.lines[i]!.length },
      });
    }
  });
});

/* ============================================================================ */
/* E. 与折回实现同一套口径（column-fold 单一实现）                                */
/* ============================================================================ */

describe('E. `lineColumns` ↔ `foldDedentedPosition` 同一口径', () => {
  it('每行视图的起点折回 = lineColumns 本身，终点 = 起点 + 行宽（含纯空白行）', () => {
    const node = topNative(MIXED);
    const firstBodyLine = node.span.start.line + 1;
    for (let i = 0; i < node.lines.length; i++) {
      const line = firstBodyLine + i;
      const column = node.lineColumns![i]!;
      const text = node.lines[i]!;
      const view = nativeLineView(line, column, text);
      expect(foldDedentedPosition(view, { line, column: 1 })).toEqual({ line, column });
      expect(foldDedentedPosition(view, { line, column: text.length + 1 })).toEqual({
        line,
        column: column + text.length,
      });
    }
  });

  it('source map 逐行自洽：span 不跨行、宽度 = 行文本码元数，起点 = lineColumns', () => {
    const node = topNative(MIXED);
    const result = compile(MIXED);
    for (let i = 0; i < node.lines.length; i++) {
      const mapped = result.sourceMap.lineAt(2 + i)!;
      const source = mapped.source!;
      expect(source.start.line).toBe(3 + i);
      expect(source.end.line).toBe(3 + i);
      expect(source.start.column).toBe(node.lineColumns![i]);
      expect(source.end.column - source.start.column).toBe(node.lines[i]!.length);
    }
  });
});
