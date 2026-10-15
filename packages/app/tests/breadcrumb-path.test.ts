/**
 * 面包屑链（D1 `breadcrumb-path.ts`）单测——纯逻辑：符号树 → 光标行的链、形状收窄、等值键。
 *
 * 两种树形都盖：ERB 侧是**平铺**函数/声明列表（无 children）、`.kojo` 侧是嵌套树；
 * 边界（起行/止行含）、同层重叠取最小区间、双胞胎同区间取文档序第一枚、断链不猜父级。
 */

import { describe, expect, it } from 'vitest';
import type { EditorDocumentSymbol } from '@kojo/plugin-api';
import { crumbsKey, symbolChainAt, toCrumbs } from '../src/ui/breadcrumb-path';

const sym = (
  name: string,
  startLine: number,
  endLine: number,
  children?: EditorDocumentSymbol[],
): EditorDocumentSymbol => ({ name, kind: 'block', startLine, endLine, ...(children ? { children } : {}) });

describe('symbolChainAt · 平铺树（ERB 形状）', () => {
  const flat = [sym('ALPHA', 2, 9), sym('BETA', 12, 30), sym('FOO', 31, 31)];

  it('块内 = 单元素链；块头/块尾行含边界；块间空档 = 空链（不猜）', () => {
    expect(symbolChainAt(flat, 5).map((s) => s.name)).toEqual(['ALPHA']);
    expect(symbolChainAt(flat, 2).map((s) => s.name)).toEqual(['ALPHA']);
    expect(symbolChainAt(flat, 9).map((s) => s.name)).toEqual(['ALPHA']);
    expect(symbolChainAt(flat, 10)).toEqual([]);
  });

  it('单行声明（start=end）在该行命中', () => {
    expect(symbolChainAt(flat, 31).map((s) => s.name)).toEqual(['FOO']);
  });

  it('空树 / 行号越界 → 空链', () => {
    expect(symbolChainAt([], 1)).toEqual([]);
    expect(symbolChainAt(flat, 9999)).toEqual([]);
    expect(symbolChainAt(flat, 0)).toEqual([]);
  });
});

describe('symbolChainAt · 嵌套树（`.kojo` 形状）', () => {
  const tree = [
    sym('时机 指令 310', 1, 20, [
      sym('如果 教養 > 30', 2, 6, [sym('否则', 4, 6)]),
      sym('当 TFLAG:193', 8, 15, [sym('是 1', 9, 12)]),
    ]),
    sym('函数 工具甲', 21, 40),
  ];

  it('链 = 外 → 内逐层下钻（分支里再含分支）', () => {
    expect(symbolChainAt(tree, 5).map((s) => s.name)).toEqual(['时机 指令 310', '如果 教養 > 30', '否则']);
    expect(symbolChainAt(tree, 10).map((s) => s.name)).toEqual(['时机 指令 310', '当 TFLAG:193', '是 1']);
  });

  it('父在子外：只到父一层即断链（子不含该行**不猜** deeper）', () => {
    expect(symbolChainAt(tree, 2).map((s) => s.name)).toEqual(['时机 指令 310', '如果 教養 > 30']);
    expect(symbolChainAt(tree, 7).map((s) => s.name)).toEqual(['时机 指令 310']);
  });

  it('同层重叠取区间最小者；同区间双胞胎取文档序第一枚（确定性）', () => {
    const overlapping = [
      sym('大框', 1, 10, [sym('小框', 4, 6)]),
      sym('平行', 1, 10),
    ];
    expect(symbolChainAt(overlapping, 5).map((s) => s.name)).toEqual(['大框', '小框']);
    const twins = [sym('先出现的', 1, 4), sym('同区间', 1, 4)];
    expect(symbolChainAt(twins, 2).map((s) => s.name)).toEqual(['先出现的']);
  });
});

describe('toCrumbs / crumbsKey', () => {
  it('收窄为宿主展示形状（名称/类别/块头行）', () => {
    const [item] = toCrumbs([sym('ALPHA', 2, 9)]);
    expect(item).toEqual({ name: 'ALPHA', kind: 'block', startLine: 2 });
  });

  it('等值键：显示名与落点全同则同键（光标在同块内移动不该白刷 React）；名称或块头行不同则异键', () => {
    const a = toCrumbs([sym('A', 1, 4), sym('B', 2, 3)]);
    const b = toCrumbs([sym('A', 1, 4), sym('B', 2, 3)]);
    const c = toCrumbs([sym('A', 1, 4), sym('别的', 2, 3)]);
    const d = toCrumbs([sym('A', 1, 4), sym('B', 9, 12)]);
    expect(crumbsKey(a)).toBe(crumbsKey(b));
    expect(crumbsKey(a)).not.toBe(crumbsKey(c));
    expect(crumbsKey(a)).not.toBe(crumbsKey(d));
    expect(crumbsKey([])).toBe('');
  });
});
