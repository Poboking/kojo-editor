/**
 * 侧栏大纲纯逻辑（`outline-model.ts`，批次十 S9）单测。
 *
 * 只测三件事：树的先序扁平化与层级 / 兄弟排序、光标定位（与面包屑同一判据）、
 * 等值键。渲染与订阅不在本文件（组件侧无纯判据）。
 */

import { describe, expect, it } from 'vitest';
import type { EditorDocumentSymbol } from '@kojo/plugin-api';
import { buildOutlineRows, locateOutlineRow, outlineRowsKey } from '../src/ui/outline-model';

const sym = (
  name: string,
  startLine: number,
  endLine: number,
  children?: EditorDocumentSymbol[],
): EditorDocumentSymbol => ({
  name,
  kind: 'block',
  startLine,
  endLine,
  ...(children ? { children } : {}),
});

describe('buildOutlineRows · 先序扁平化与层级', () => {
  it('平铺树（ERB 形状）→ 全部 depth 0，保持文档序', () => {
    const rows = buildOutlineRows([sym('ALPHA', 2, 9), sym('BETA', 12, 30), sym('FOO', 31, 31)]);
    expect(rows.map((r) => [r.name, r.depth])).toEqual([
      ['ALPHA', 0],
      ['BETA', 0],
      ['FOO', 0],
    ]);
  });

  it('嵌套树（`.kojo` 形状）→ 父在子前逐层下钻，depth 即层级', () => {
    const tree = [
      sym('时机 指令 310', 1, 20, [
        sym('如果 教養 > 30', 2, 6, [sym('否则', 4, 6)]),
        sym('当 TFLAG:193', 8, 15),
      ]),
      sym('函数 工具甲', 21, 40),
    ];
    const rows = buildOutlineRows(tree);
    expect(rows.map((r) => `${r.depth}:${r.name}`)).toEqual([
      '0:时机 指令 310',
      '1:如果 教養 > 30',
      '2:否则',
      '1:当 TFLAG:193',
      '0:函数 工具甲',
    ]);
    expect(rows.map((r) => r.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });

  it('兄弟按起始行稳定排序；同起始行保留 provider 的文档序', () => {
    const rows = buildOutlineRows([sym('后', 10, 12), sym('先', 2, 3), sym('同A', 5, 8), sym('同B', 5, 9)]);
    expect(rows.map((r) => r.name)).toEqual(['先', '同A', '同B', '后']);
  });

  it('detail 原样带出（无 detail ⇒ null）', () => {
    const rows = buildOutlineRows([
      { name: '有说明', kind: 'function', startLine: 1, endLine: 2, detail: '教養 > 30' },
      sym('无说明', 3, 4),
    ]);
    expect(rows.map((r) => r.detail)).toEqual(['教養 > 30', null]);
  });

  it('空树 → 空行序（组件据此显示空态）', () => {
    expect(buildOutlineRows([])).toEqual([]);
  });
});

describe('locateOutlineRow · 光标行定位', () => {
  const tree = [
    sym('时机 指令 310', 1, 20, [
      sym('如果 教養 > 30', 2, 6, [sym('否则', 4, 6)]),
      sym('当 TFLAG:193', 8, 15),
    ]),
    sym('函数 工具甲', 21, 40),
  ];
  const rows = buildOutlineRows(tree);

  it('落在最深一层（外→内链尾）', () => {
    expect(rows[locateOutlineRow(rows, tree, 5)]?.name).toBe('否则');
    expect(rows[locateOutlineRow(rows, tree, 10)]?.name).toBe('当 TFLAG:193');
  });

  it('父层边界含端点；同一行上取更深的那层', () => {
    expect(rows[locateOutlineRow(rows, tree, 1)]?.name).toBe('时机 指令 310');
    expect(rows[locateOutlineRow(rows, tree, 2)]?.name).toBe('如果 教養 > 30');
    expect(rows[locateOutlineRow(rows, tree, 3)]?.name).toBe('如果 教養 > 30');
    expect(rows[locateOutlineRow(rows, tree, 6)]?.name).toBe('否则');
    expect(rows[locateOutlineRow(rows, tree, 7)]?.name).toBe('时机 指令 310');
  });

  it('块间空档 / 行号越界 / 空树 ⇒ -1（不猜）', () => {
    const flat = [sym('ALPHA', 2, 9), sym('BETA', 12, 30)];
    const flatRows = buildOutlineRows(flat);
    expect(locateOutlineRow(flatRows, flat, 10)).toBe(-1);
    expect(locateOutlineRow(rows, tree, 9999)).toBe(-1);
    expect(locateOutlineRow([], [], 3)).toBe(-1);
  });

  it('行序与符号树不是同一棵 ⇒ -1（不许按名字/行号硬配）', () => {
    const other = [sym('时机 指令 310', 1, 20)];
    expect(locateOutlineRow(rows, other, 5)).toBe(-1);
  });

  it('与面包屑同一判据：同层重叠取最小区间，双胞胎取文档序第一枚', () => {
    const overlapping = [sym('大框', 1, 10, [sym('小框', 4, 6)]), sym('平行', 1, 10)];
    const rows2 = buildOutlineRows(overlapping);
    expect(rows2[locateOutlineRow(rows2, overlapping, 5)]?.name).toBe('小框');

    const twins = [sym('先出现的', 1, 4), sym('同区间', 1, 4)];
    const rows3 = buildOutlineRows(twins);
    expect(rows3[locateOutlineRow(rows3, twins, 2)]?.name).toBe('先出现的');
  });
});

describe('outlineRowsKey · 等值键', () => {
  it('同形树同键；名称 / 层级 / 行号 / 说明任一变化即不同键', () => {
    const base = buildOutlineRows([sym('A', 1, 3), sym('B', 4, 9, [sym('C', 5, 6)])]);
    const same = buildOutlineRows([sym('A', 1, 3), sym('B', 4, 9, [sym('C', 5, 6)])]);
    expect(outlineRowsKey(base)).toBe(outlineRowsKey(same));

    expect(outlineRowsKey(base)).not.toBe(outlineRowsKey(buildOutlineRows([sym('A2', 1, 3)])));
    expect(outlineRowsKey(base)).not.toBe(outlineRowsKey(buildOutlineRows([sym('A', 1, 3)])));
    expect(outlineRowsKey(base)).not.toBe(outlineRowsKey(buildOutlineRows([sym('A', 2, 3)])));
    expect(outlineRowsKey(base)).not.toBe(
      outlineRowsKey(
        buildOutlineRows([{ name: 'A', kind: 'block', startLine: 1, endLine: 3, detail: '说明' }]),
      ),
    );
  });
});
