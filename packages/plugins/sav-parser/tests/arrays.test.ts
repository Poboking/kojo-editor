import { describe, expect, it } from 'vitest';
import {
  KEEP_ALL_CELLS,
  readIntArray1D,
  readIntArray2D,
  readIntArray3D,
  readStrArray1D,
  readStrArray2D,
  readStrArray3D,
  type CellPolicy,
} from '../src/arrays';
import { ByteReader } from '../src/binary';
import { W } from './helpers/synth';

describe('IntArray1D 游程解码', () => {
  it('基本值 + 0xF0 跳跃（稀疏尾部剪枝后的典型形态）', () => {
    // saveLen=5；非空单元 (0)=1、(3)=3；尾部 (4) 全零被剪
    const bytes = new W().u32(5).u8(1).u8(0xf0).u8(2).u8(3).u8(0xff).bytes();
    const r = new ByteReader(bytes);
    const res = readIntArray1D(r, KEEP_ALL_CELLS);
    expect(res.saveLen).toEqual([5]);
    expect(res.cells).toEqual([
      { index: [0], value: 1 },
      { index: [3], value: 3 },
    ]);
    expect(res.cursor).toEqual([4]);
    expect(res.nonEmpty).toBe(2);
    expect(r.remaining).toBe(0);
  });

  it('显式零值元素（写侧未剪枝）→ 计为非空单元', () => {
    const bytes = new W().u32(3).u8(0).u8(0).u8(0).u8(0xff).bytes();
    const res = readIntArray1D(new ByteReader(bytes), KEEP_ALL_CELLS);
    expect(res.nonEmpty).toBe(3);
    expect(res.cells[0]).toEqual({ index: [0], value: 0 });
  });

  it('扩展编码元素（0xD0 / 0xD1 / 0xD2）', () => {
    const bytes = W.concat(
      new W().u32(3).bytes(),
      new W().int(300).bytes(), // 0xD0
      new W().int(70000).bytes(), // 0xD1
      new W().int(5_174_634_124).bytes(), // 0xD2
      new Uint8Array([0xff]),
    );
    const res = readIntArray1D(new ByteReader(bytes), KEEP_ALL_CELLS);
    expect(res.cells.map((c) => c.value)).toEqual([300, 70000, 5_174_634_124]);
  });
});

describe('IntArray2D 游程解码', () => {
  it('0xE0 换行 + 0xF0 行内跳 + 0xF1 跳全零行', () => {
    // saveLen [3,4]：(0,0)=1、(0,3)=4、(2,0)=7；行 1 全零
    const bytes = new W()
      .u32(3)
      .u32(4)
      .u8(1) // (0,0)；y → 1
      .u8(0xf0)
      .u8(2) // y += 2 → y=3
      .u8(4) // (0,3)
      .u8(0xe0) // x=1, y=0
      .u8(0xf1)
      .u8(1) // x += 1 → x=2
      .u8(7) // (2,0)
      .u8(0xff)
      .bytes();
    const res = readIntArray2D(new ByteReader(bytes), KEEP_ALL_CELLS);
    expect(res.saveLen).toEqual([3, 4]);
    expect(res.cells).toEqual([
      { index: [0, 0], value: 1 },
      { index: [0, 3], value: 4 },
      { index: [2, 0], value: 7 },
    ]);
    expect(res.cursor).toEqual([2, 1]);
  });
});

describe('IntArray3D 游程解码', () => {
  it('0xE1 换面 + 0xF0 列跳', () => {
    // saveLen [2,2,2]：面0 (0,0,0)=1；面1 (1,0,0)=2、(1,1,1)=3
    const bytes = new W()
      .u32(2)
      .u32(2)
      .u32(2)
      .u8(1) // (0,0,0)
      .u8(0xe1) // x=1, y=0, z=0
      .u8(2) // (1,0,0)
      .u8(0xe0) // y=1, z=0
      .u8(0xf0)
      .u8(1) // z += 1 → z=1
      .u8(3) // (1,1,1)
      .u8(0xff)
      .bytes();
    const res = readIntArray3D(new ByteReader(bytes), KEEP_ALL_CELLS);
    expect(res.cells).toEqual([
      { index: [0, 0, 0], value: 1 },
      { index: [1, 0, 0], value: 2 },
      { index: [1, 1, 1], value: 3 },
    ]);
    expect(res.cursor).toEqual([1, 1, 2]);
  });

  it('0xF2 跳全零面', () => {
    const bytes = new W()
      .u32(3)
      .u32(1)
      .u32(1)
      .u8(1) // (0,0,0)
      .u8(0xf2)
      .u8(2) // x += 2 → x=2（跳过面 1）
      .u8(9) // (2,0,0)
      .u8(0xff)
      .bytes();
    const res = readIntArray3D(new ByteReader(bytes), KEEP_ALL_CELLS);
    expect(res.cells).toEqual([
      { index: [0, 0, 0], value: 1 },
      { index: [2, 0, 0], value: 9 },
    ]);
  });
});

describe('字符串数组', () => {
  it('StrArray1D：0xD8 + 字符串元素', () => {
    const bytes = new W().u32(3).u8(0xd8).str('あ').u8(0xf0).u8(1).u8(0xd8).str('').u8(0xff).bytes();
    const res = readStrArray1D(new ByteReader(bytes), KEEP_ALL_CELLS);
    expect(res.cells).toEqual([
      { index: [0], value: 'あ' },
      { index: [2], value: '' },
    ]);
    expect(res.nonEmpty).toBe(2);
  });

  it('StrArray2D：换行 + 字符串', () => {
    const bytes = new W().u32(2).u32(2).u8(0xd8).str('a').u8(0xe0).u8(0xd8).str('b').u8(0xff).bytes();
    const res = readStrArray2D(new ByteReader(bytes), KEEP_ALL_CELLS);
    expect(res.cells).toEqual([
      { index: [0, 0], value: 'a' },
      { index: [1, 0], value: 'b' },
    ]);
  });

  it('StrArray3D：面跳 + 字符串', () => {
    const bytes = new W().u32(2).u32(1).u32(1).u8(0xd8).str('x').u8(0xe1).u8(0xd8).str('y').u8(0xff).bytes();
    const res = readStrArray3D(new ByteReader(bytes), KEEP_ALL_CELLS);
    expect(res.cells).toEqual([
      { index: [0, 0, 0], value: 'x' },
      { index: [1, 0, 0], value: 'y' },
    ]);
  });

  it('字符串数组收到整数元素字节 → 抛错（不猜语义）', () => {
    const bytes = new W().u32(1).u8(0x05).u8(0xff).bytes();
    expect(() => readStrArray1D(new ByteReader(bytes), KEEP_ALL_CELLS)).toThrow(/非法首字节/);
  });
});

describe('cells 保留策略', () => {
  const bytes = new W().u32(3).u8(1).u8(2).u8(3).u8(0xff).bytes();

  it('keep=false：cells 省略但 nonEmpty 准确、游标完整推进', () => {
    const policy: CellPolicy = { keep: false, max: Number.POSITIVE_INFINITY };
    const res = readIntArray1D(new ByteReader(bytes), policy);
    expect(res.cells).toEqual([]);
    expect(res.nonEmpty).toBe(3);
    expect(res.cursor).toEqual([3]);
  });

  it('max=1：截断至 1 个单元，nonEmpty 仍为 3', () => {
    const policy: CellPolicy = { keep: true, max: 1 };
    const res = readIntArray1D(new ByteReader(bytes), policy);
    expect(res.cells).toEqual([{ index: [0], value: 1 }]);
    expect(res.nonEmpty).toBe(3);
  });
});
