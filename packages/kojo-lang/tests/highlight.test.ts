/**
 * K2-LSP-HILITE-SELECT · Kojo 2.0 **同符号高亮**的判据闸（B3f 起判据住 `@kojo/kojo-lang`）。
 *
 * 本文件的断言是**整块搬来的**（原 `packages/app/tests/kojo2-highlight-selection.test.ts`
 * ①②③ 三组，一条没减）；只测 Monaco 的那条（三档 → `DocumentHighlightKind`）留在宿主
 * `packages/app/tests/kojo2-highlight-selection.test.ts`——映射表是宿主的活。
 *
 * 覆盖：
 * 1. **档位**：声明 = `write`、代码面 / 插值 = `read`、叙事正文同名文字 = `text`；
 *    字符串字面量 / `@原生` 围栏 / 注释 / 表体数据行**不误报**；光标下没有声明符号 ⇒ `[]`；
 * 2. **边界**：越界 / 非法坐标 / 空文件 / 非字符串 ⇒ `[]`（不抛）；
 * 3. **确定性**：同输入两次逐字相等、CRLF 与 LF 同结果。
 */
import { describe, expect, it } from 'vitest';
import type { Kojo2SymbolPosition, Kojo2SymbolRange } from '../src/symbols';
import {
  kojo2DocumentHighlights,
  type Kojo2DocumentHighlight,
  type Kojo2HighlightKind,
} from '../src/highlight';

/* ============================== 夹具 ============================== */

/**
 * 高亮夹具（每行都可以按内容定位）：
 * - 声明：幕 / 视角 / 机 / 设 / 对照表 / 池 / 函 / 织；
 * - 引用：表 `依据` 表达式、`?` 条件、函数体赋值、`!` 触发行、台词插值；
 * - 误报陷阱：注释、字符串字面量、表体数据行的 `心情`、`@原生` 体内的 `心情`；
 * - `text` 档：`> 心情`（旁白正文）与 `\心情`（转义字面文本）。
 */
const HILITE = [
  '// 心情', // 1 注释
  '# 幕 神社清晨', // 2
  '# 视角 灵梦', // 3
  '# 机 指令 310', // 4
  '# 设 心情 整数 = 0 存档', // 5
  '# 设 引号 字符串 = "心情"', // 6 字符串字面量
  '# 对照表 心情表 依据 心情', // 7
  '    0..99 -> 疏远', // 8
  '    100..499 -> 心情', // 9 表体数据行
  '    否 -> 未知', // 10
  '', // 11
  '# 池 早安问候', // 12
  '    ? 心情 >= 100', // 13
  '        「心情不错。」', // 14（正文连续成词，不该切成 `心情`）
  '    ? 否', // 15
  '        「早安。」', // 16
  '', // 17
  '@函 增加(数值)', // 18
  '    心情 = 心情 + 数值', // 19
  '    ! 早安问候', // 20
  '    ! 增加(心情)', // 21
  '', // 22
  '@织 指令 之后', // 23
  '    > 监听', // 24
  '', // 25
  '> 心情', // 26 text 档
  '灵梦：「{心情}今天。」', // 27 插值 = read
  '\\心情', // 28 转义字面文本 = text 档
  '@原生', // 29
  '    心情 = 1', // 30 原生体（不误报）
].join('\n');

/* ============================== 小工具 ============================== */

function splitLines(source: string): string[] {
  return source.split(/\r\n|\r|\n/);
}

function lineText(source: string, line: number): string {
  return splitLines(source)[line - 1] ?? '';
}

/** 第 `line` 行第 `occurrence` 个 `needle` 的首列（1 基） */
function at(
  source: string,
  line: number,
  needle: string,
  occurrence = 1,
): Kojo2SymbolPosition {
  const text = lineText(source, line);
  let index = -1;
  let from = 0;
  for (let i = 0; i < occurrence; i++) {
    index = text.indexOf(needle, from);
    if (index < 0) throw new Error(`第 ${line} 行没有第 ${i + 1} 个「${needle}」`);
    from = index + 1;
  }
  return { line, column: index + 1 };
}

/** 1 基区间 → `[行, 列, 行, 列]`（比较用） */
function flat(range: Kojo2SymbolRange): [number, number, number, number] {
  return [range.startLine, range.startColumn, range.endLine, range.endColumn];
}

function rangesOf(hits: readonly Kojo2DocumentHighlight[]): Array<[number, number, number, number]> {
  return hits.map((hit) => flat(hit.range));
}

function kindsOf(hits: readonly Kojo2DocumentHighlight[]): Kojo2HighlightKind[] {
  return hits.map((hit) => hit.kind);
}

/* ============================== ① 读 / 写 / 文 ============================== */

describe('高亮：声明 write、代码面 / 插值 read、叙事正文 text', () => {
  const hits = kojo2DocumentHighlights(HILITE, at(HILITE, 5, '心情'));

  it('光标在声明名上：声明处是唯一 write', () => {
    expect(hits.filter((hit) => hit.kind === 'write').map((hit) => flat(hit.range))).toEqual([
      [5, 5, 5, 7],
    ]);
  });

  it('read：表 `依据` 表达式 / 条件 / 函数体 / 触发行实参 / 台词插值', () => {
    const reads = hits.filter((hit) => hit.kind === 'read');
    expect(reads.map((hit) => hit.range.startLine)).toEqual([7, 13, 19, 19, 21, 27]);
    expect(reads.every((hit) => hit.range.startColumn === hit.range.endColumn - 2)).toBe(true);
  });

  it('text：旁白正文与转义字面文本的同名词单独一档', () => {
    expect(hits.filter((hit) => hit.kind === 'text').map((hit) => hit.range.startLine)).toEqual([
      26, 28,
    ]);
  });

  it('总数 = 1 write + 6 read + 2 text，且按源码序', () => {
    expect(hits).toHaveLength(9);
    expect(kindsOf(hits)).toEqual(['write', 'read', 'read', 'read', 'read', 'read', 'text', 'read', 'text']);
    const starts = hits.map((hit) => hit.range.startLine * 1_000 + hit.range.startColumn);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('光标停在声明头（名字之前）也解析到同一条声明', () => {
    expect(kojo2DocumentHighlights(HILITE, at(HILITE, 5, '设'))).toEqual(hits);
  });

  it('字符串字面量里的同名文字不误报（不是引用）', () => {
    expect(hits.some((hit) => hit.range.startLine === 6)).toBe(false);
  });

  it('`@原生` 围栏体不误报', () => {
    expect(hits.some((hit) => hit.range.startLine === 30)).toBe(false);
  });

  it('整行注释不误报', () => {
    expect(hits.some((hit) => hit.range.startLine === 1)).toBe(false);
  });

  it('表体数据行不误报（那里的 `心情` 是单元格值）', () => {
    expect(hits.some((hit) => hit.range.startLine === 9)).toBe(false);
  });

  it('词边界：`心情` 不会误命中声明名 `心情表`，但会命中表头的 `依据 心情`', () => {
    const tableLine = lineText(HILITE, 7);
    const nameColumn = tableLine.indexOf('心情表') + 1;
    expect(hits.some((hit) => hit.range.startLine === 7 && hit.range.startColumn === nameColumn)).toBe(
      false,
    );
    const subject = hits.filter((hit) => hit.range.startLine === 7);
    expect(subject).toHaveLength(1);
    expect(subject[0]!.kind).toBe('read');
    expect(subject[0]!.range.startColumn).toBe(tableLine.indexOf('心情', nameColumn) + 1);
  });

  it('高亮表名 `心情表`：只有它自己的 write（主题表达式是别的名字）', () => {
    const tableHits = kojo2DocumentHighlights(HILITE, at(HILITE, 7, '心情表'));
    expect(tableHits).toHaveLength(1);
    expect(tableHits[0]!.kind).toBe('write');
    expect(flat(tableHits[0]!.range)).toEqual([7, 7, 7, 10]);
  });

  it('`@函`：声明 write + `!` 调用位 read', () => {
    const functionHits = kojo2DocumentHighlights(HILITE, at(HILITE, 18, '增加'));
    expect(functionHits.map((hit) => [hit.range.startLine, hit.kind])).toEqual([
      [18, 'write'],
      [21, 'read'],
    ]);
  });

  it('`# 池`：声明 write + `!` 调用位 read', () => {
    const poolHits = kojo2DocumentHighlights(HILITE, at(HILITE, 12, '早安问候'));
    expect(poolHits.map((hit) => [hit.range.startLine, hit.kind])).toEqual([
      [12, 'write'],
      [20, 'read'],
    ]);
  });

  it('`# 机` 与 `@织` 的事件名互为同名声明（两处都是 write）', () => {
    const eventHits = kojo2DocumentHighlights(HILITE, at(HILITE, 4, '指令'));
    expect(eventHits.map((hit) => [hit.range.startLine, hit.kind])).toEqual([
      [4, 'write'],
      [23, 'write'],
    ]);
  });

  it('`# 视角` 目标只在自己那一行：说话人 / 台词正文不算引用', () => {
    const viewHits = kojo2DocumentHighlights(HILITE, at(HILITE, 3, '灵梦'));
    expect(viewHits.map((hit) => [hit.range.startLine, hit.kind])).toEqual([[3, 'write']]);
  });
});

/* ============================== ② 无符号 / 边界 ============================== */

describe('高亮：光标下没有声明符号 ⇒ []', () => {
  it('叙事正文里的词（不是插值）不产高亮', () => {
    expect(kojo2DocumentHighlights(HILITE, at(HILITE, 26, '心情'))).toEqual([]);
  });

  it('字符串字面量内部 ⇒ []', () => {
    expect(kojo2DocumentHighlights(HILITE, at(HILITE, 6, '心情'))).toEqual([]);
  });

  it('`@原生` 体内 ⇒ []', () => {
    expect(kojo2DocumentHighlights(HILITE, at(HILITE, 30, '心情'))).toEqual([]);
  });

  it('注释行 ⇒ []', () => {
    expect(kojo2DocumentHighlights(HILITE, at(HILITE, 1, '心情'))).toEqual([]);
  });

  it('未声明的外部名 / 数字 / 空白行 ⇒ []', () => {
    expect(kojo2DocumentHighlights(HILITE, at(HILITE, 4, '310'))).toEqual([]);
    expect(kojo2DocumentHighlights(HILITE, at(HILITE, 11, ''))).toEqual([]);
    expect(kojo2DocumentHighlights(HILITE, at(HILITE, 24, '监听'))).toEqual([]);
  });

  it('越界 / 非法坐标 / 空文件 / 非字符串 ⇒ []（不抛）', () => {
    expect(kojo2DocumentHighlights(HILITE, { line: 9_999, column: 1 })).toEqual([]);
    expect(kojo2DocumentHighlights(HILITE, { line: 0, column: 1 })).toEqual([]);
    expect(kojo2DocumentHighlights(HILITE, { line: 1, column: 0 })).toEqual([]);
    expect(kojo2DocumentHighlights(HILITE, { line: Number.NaN, column: 1 })).toEqual([]);
    expect(kojo2DocumentHighlights('', { line: 1, column: 1 })).toEqual([]);
    expect(kojo2DocumentHighlights(null as unknown as string, { line: 1, column: 1 })).toEqual([]);
  });
});

/* ============================== ③ 确定性 ============================== */

describe('高亮：确定性、CRLF', () => {
  it('同输入两次逐字相等', () => {
    expect(kojo2DocumentHighlights(HILITE, at(HILITE, 5, '心情'))).toEqual(
      kojo2DocumentHighlights(HILITE, at(HILITE, 5, '心情')),
    );
  });

  it('CRLF 与 LF 同结果（列口径不受行尾影响）', () => {
    const crlf = HILITE.replace(/\n/g, '\r\n');
    expect(kojo2DocumentHighlights(crlf, at(crlf, 5, '心情'))).toEqual(
      kojo2DocumentHighlights(HILITE, at(HILITE, 5, '心情')),
    );
  });

  it('出现处区间恒是单行（宿主按单行翻 IRange，不会跨行）', () => {
    expect(rangesOf(kojo2DocumentHighlights(HILITE, at(HILITE, 5, '心情'))).every(
      ([startLine, , endLine]) => startLine === endLine,
    )).toBe(true);
  });
});
