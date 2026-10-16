import { describe, expect, it } from 'vitest';
import {
  countCodePoints,
  selectionCharCount,
  selectionStatusText,
  type SelModelLike,
  type SelRangeLike,
} from '../src/ui/selection-status';

/** 打表用小 model：按行号取预置文本（getLineContent 的形似桩） */
function fakeModel(lines: readonly string[]): SelModelLike {
  return {
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
  };
}

const sel = (
  startLineNumber: number,
  startColumn: number,
  endLineNumber: number,
  endColumn: number,
): SelRangeLike => ({ startLineNumber, startColumn, endLineNumber, endColumn });

describe('countCodePoints · 码点计数口径', () => {
  it('ASCII 与 CJK：一笔一字符（不掰字素、不把代理对数成两个）', () => {
    expect(countCodePoints('')).toBe(0);
    expect(countCodePoints('hello')).toBe(5);
    expect(countCodePoints('你好世界')).toBe(4);
    expect(countCodePoints('a你b')).toBe(3);
  });

  it('代理对（emoji）算 1 个码点——charLength 会数成 2，这里是口径差', () => {
    expect('😀'.length).toBe(2);
    expect(countCodePoints('😀')).toBe(1);
    expect(countCodePoints('😀😀你')).toBe(3);
  });
});

describe('selectionCharCount · 逐行切片、不含换行符', () => {
  it('单行：取 [startColumn, endColumn) 半开区间', () => {
    const m = fakeModel(['abcdef']);
    expect(selectionCharCount(m, sel(1, 1, 1, 4))).toBe(3); // "abc"
    expect(selectionCharCount(m, sel(1, 3, 1, 3))).toBe(0); // 空区间
    expect(selectionCharCount(m, sel(1, 1, 1, 7))).toBe(6); // 整行
  });

  it('多行：首行残段 + 中间整行 + 末行前段；换行不计', () => {
    const m = fakeModel(['abcdef', '中间行内容', 'xyz']);
    expect(selectionCharCount(m, sel(1, 4, 3, 2))).toBe(3 + 5 + 1);
  });

  it('整行 ×2 的经典形态（endColumn=1）：第二行不算字符、但行数是 2', () => {
    const m = fakeModel(['第一行', '第二行']);
    expect(selectionCharCount(m, sel(1, 1, 2, 1))).toBe(3);
  });

  it('CJK 混 emoji：列按 UTF-16 码元（😀 占 2 列），字符按码点（😀 算 1 个）', () => {
    const m = fakeModel(['你😀好']);
    // 整行 = 1 + 2 + 1 = 4 个码元 ⇒ 末列 5；码点计数 3
    expect(selectionCharCount(m, sel(1, 1, 1, 5))).toBe(3); // 你 + 😀 + 好
    expect(selectionCharCount(m, sel(1, 1, 1, 4))).toBe(2); // 你 + 😀（截到码元 3）
  });
});

describe('selectionStatusText · 状态栏文案（打表）', () => {
  const cursor = { line: 12, column: 4 };

  it('无选区（null / 空区间）→ 光标 行:列', () => {
    const m = fakeModel(['abc']);
    expect(selectionStatusText(m, null, cursor)).toBe('12:4');
    expect(selectionStatusText(m, sel(2, 5, 2, 5), { line: 2, column: 5 })).toBe('2:5');
  });

  it('无 model（糖视图/未挂载）→ 同样退回光标读数，绝不抛', () => {
    expect(selectionStatusText(null, sel(1, 1, 1, 3), cursor)).toBe('12:4');
  });

  it('单行选区 → 选中 C字符', () => {
    const m = fakeModel(['你好世界abc']);
    expect(selectionStatusText(m, sel(1, 1, 1, 5), { line: 1, column: 5 })).toBe('选中 4字符');
  });

  it('多行选区 → 选中 L行 × C字符', () => {
    const m = fakeModel(['abcdef', 'gh', 'ijkl']);
    // 首行 cdef(4) + 中间 gh(2) + 末行 ij(2) = 8，跨 3 行
    expect(selectionStatusText(m, sel(1, 3, 3, 3), { line: 3, column: 3 })).toBe('选中 3行 × 8字符');
  });

  it('多行但选区零字符（首行行尾 → 次行行首）：行数照报、字符为 0', () => {
    const m = fakeModel(['abc', 'def']);
    expect(selectionStatusText(m, sel(1, 4, 2, 1), { line: 2, column: 1 })).toBe('选中 2行 × 0字符');
  });
});
